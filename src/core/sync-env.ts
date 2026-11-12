import type { ThreadkeeperDB, UpsertThreadInput } from './db.js';
import { isAuthoritativeSource } from './db.js';
import { buildThreadKey, type SettingsRecord } from './schema.js';
import type { SyncState, SyncProviderId } from './history-sync.js';
import type { SyncAccount, SyncEnv } from './sync-orchestrator.js';
import { siteConversationTitle, type SiteConversation } from './site-api.js';
import type { ProviderId } from './providers.js';
import type { AccountIdentity } from './workspace/types.js';
import { activeAnalysisHold, holdAnalysis, releaseAnalysisHold, touchAnalysisHold } from './analysis-hold.js';

/** The account a capture of `provider` is filed under right now (accounts.resolveForCapture). */
export type CaptureAccountResolver = (
  provider: ProviderId,
  bound: { accountId: string; workspaceId: string }
) => Promise<{ accountId: string; workspaceId: string; label?: string | null }>;

/**
 * The thread a conversation read by the import becomes, filed under the run's account. The
 * account is part of the thread key, so the same conversation id read under a second account of
 * the site is a separate thread and never replaces or merges into the first account's.
 */
export function syncedThreadInput(conv: SiteConversation, account: { accountId: string; workspaceId: string }, nowIso: string): UpsertThreadInput {
  const threadKey = buildThreadKey({
    provider: conv.provider,
    accountId: account.accountId,
    workspaceId: account.workspaceId,
    sourceConversationId: conv.sourceConversationId,
    branchId: 'main',
  });
  return {
    threadKey,
    provider: conv.provider,
    accountId: account.accountId,
    workspaceId: account.workspaceId,
    sourceConversationId: conv.sourceConversationId,
    branchId: 'main',
    canonicalUrl: conv.canonicalUrl,
    title: siteConversationTitle(conv),
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt ?? nowIso,
    coverage: conv.messages.length > 0 ? 'full' : 'title_only',
    captureSource: 'history_sync',
    modelSlug: conv.modelSlug,
    messages: conv.messages,
  };
}

/** Where the progress of the latest run is kept, for the library to show (chrome.storage.local). */
export const HISTORY_SYNC_STATE_KEY = 'tk_history_sync';

const RECENT_CAPTURE_MS = 6 * 3_600_000;

/** The orchestrator's view of the browser and the database, for the service worker. */
export function createChromeSyncEnv(
  db: ThreadkeeperDB,
  deps: {
    loadSettings: () => Promise<SettingsRecord>;
    /** Store a conversation under the run's account and organize it like any captured thread. */
    storeConversation: (conversation: SiteConversation, account?: SyncAccount | null) => Promise<'stored' | 'skipped'>;
    /**
     * Which account the signed-in session of a provider is. History is read with the browser's
     * current cookies, so it belongs to the realm's active account, not always the bound one.
     */
    resolveAccount?: CaptureAccountResolver;
    /** Hand who the site says is signed in to the accounts service (ACCOUNT_IDENTITY's path). */
    noteIdentity?: (provider: ProviderId, identity: Omit<AccountIdentity, 'observedAt'>) => Promise<void>;
    /** Start draining the analysis queue (after an import's hold ends). */
    kickAnalysis?: () => void;
  }
): SyncEnv {
  const resolveBound = async (settings: SettingsRecord, provider: SyncProviderId): Promise<SyncAccount> => {
    const bound = settings.boundAccounts[provider];
    if (!deps.resolveAccount) return { ...bound, label: null };
    try {
      const resolved = await deps.resolveAccount(provider, bound);
      return { accountId: resolved.accountId, workspaceId: resolved.workspaceId, label: resolved.label ?? null };
    } catch {
      return { ...bound, label: null };
    }
  };
  /** The run's account when it has one, else the account captures go to now. */
  const accountFor = async (provider: SyncProviderId, account?: SyncAccount | null): Promise<SyncAccount> =>
    account ?? resolveBound(await deps.loadSettings(), provider);
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const ping = async (tabId: number): Promise<boolean> => {
    try {
      // Top frame only: content scripts also run in a provider page's own iframes.
      const reply = (await chrome.tabs.sendMessage(tabId, { type: 'TK_PING' }, { frameId: 0 })) as { ok?: boolean } | undefined;
      return reply?.ok === true;
    } catch {
      return false;
    }
  };

  return {
    now: () => Date.now(),
    newRunId: () => `sync_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    sleep,
    timeout(ms) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const promise = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, ms);
      });
      return { promise, cancel: () => clearTimeout(timer) };
    },
    async findTab(info) {
      if (info.ownListTab) return null;
      const tabs = await chrome.tabs.query({ url: info.hostPatterns });
      const usable = tabs.filter((t) => typeof t.id === 'number' && !t.discarded && t.status === 'complete');
      return usable[0]?.id ?? null;
    },
    async openTab(url) {
      const tab = await chrome.tabs.create({ url, active: false });
      if (typeof tab.id !== 'number') throw new Error('Could not open a tab');
      return tab.id;
    },
    async closeTab(tabId) {
      await chrome.tabs.remove(tabId);
    },
    async waitTabReady(tabId, timeoutMs) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        try {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete') return true;
        } catch {
          return false;
        }
        await sleep(400);
      }
      return false;
    },
    async ensureContentScript(tabId) {
      if (await ping(tabId)) return true;
      try {
        // A tab opened before the extension was installed or reloaded has no reader yet.
        await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] });
      } catch {
        return false;
      }
      await sleep(300);
      return ping(tabId);
    },
    async sendToTab(tabId, message) {
      return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
    },
    async enabledProviders() {
      const settings = await deps.loadSettings();
      return new Set(Object.entries(settings.authorizedHosts).filter(([, on]) => on).map(([id]) => id));
    },
    async knownUpdatedAt(provider: SyncProviderId, account) {
      const known: Record<string, string> = {};
      // Only this account's copies: another account's thread with the same id is not this one.
      const bound = await accountFor(provider, account);
      const rows = await db.conversations.where('provider').equals(provider).toArray();
      for (const c of rows) {
        // Only a complete copy from the site itself can stand in for a fresh read.
        if (c.accountId === bound.accountId && c.workspaceId === bound.workspaceId
          && c.branchId === 'main' && c.coverage === 'full' && isAuthoritativeSource(c.captureSource) && c.updatedAt) {
          known[c.sourceConversationId.toLowerCase()] = c.updatedAt;
        }
      }
      return known;
    },
    storeConversation: deps.storeConversation,
    async hasRecentCapture(provider, sourceConversationId, account) {
      const bound = await accountFor(provider, account);
      const key = buildThreadKey({ provider, accountId: bound.accountId, workspaceId: bound.workspaceId, sourceConversationId, branchId: 'main' });
      const c = await db.conversations.get(key);
      return Boolean(c && c.messageCount > 0 && Date.now() - Date.parse(c.lastCapturedAt) < RECENT_CAPTURE_MS);
    },
    async saveState(state: SyncState) {
      await chrome.storage.local.set({ [HISTORY_SYNC_STATE_KEY]: state });
    },
    async loadState() {
      const stored = (await chrome.storage.local.get(HISTORY_SYNC_STATE_KEY))[HISTORY_SYNC_STATE_KEY] as SyncState | undefined;
      return stored && typeof stored === 'object' ? stored : null;
    },
    async tabInfo(tabId) {
      try {
        const tab = await chrome.tabs.get(tabId);
        // The address is only readable on hosts the extension may access; elsewhere it is unknown.
        return { url: tab.url ?? tab.pendingUrl ?? null, title: tab.title ?? null };
      } catch {
        return null;
      }
    },
    async hasHostAccess(info) {
      try {
        return await chrome.permissions.contains({ origins: info.hostPatterns });
      } catch {
        return true;
      }
    },
    async noteIdentity(provider, identity) {
      await deps.noteIdentity?.(provider, identity);
    },
    async resolveAccount(provider) {
      return resolveBound(await deps.loadSettings(), provider);
    },
    async holdAnalysis(runId) {
      await holdAnalysis(db, runId, Date.now());
    },
    async touchAnalysisHold(runId) {
      await touchAnalysisHold(db, runId, Date.now());
    },
    async releaseAnalysis(runId) {
      const held = await activeAnalysisHold(db, Date.now());
      const queued = await releaseAnalysisHold(db, runId, Date.now());
      // Stale or not, a hold that ended may have kept jobs waiting: start the queue either way.
      if (held || queued > 0) deps.kickAnalysis?.();
      return queued;
    },
  };
}
