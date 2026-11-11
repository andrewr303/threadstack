import type { ThreadkeeperDB } from './db.js';
import { isAuthoritativeSource } from './db.js';
import { buildThreadKey, type SettingsRecord } from './schema.js';
import type { SyncState, SyncProviderId } from './history-sync.js';
import type { SyncEnv } from './sync-orchestrator.js';
import type { SiteConversation } from './site-api.js';
import type { ProviderId } from './providers.js';

/** The account a capture of `provider` is filed under right now (accounts.resolveForCapture). */
export type CaptureAccountResolver = (
  provider: ProviderId,
  bound: { accountId: string; workspaceId: string }
) => Promise<{ accountId: string; workspaceId: string }>;

/** Where the progress of the latest run is kept, for the library to show (chrome.storage.local). */
export const HISTORY_SYNC_STATE_KEY = 'tk_history_sync';

const RECENT_CAPTURE_MS = 6 * 3_600_000;

/** The orchestrator's view of the browser and the database, for the service worker. */
export function createChromeSyncEnv(
  db: ThreadkeeperDB,
  deps: {
    loadSettings: () => Promise<SettingsRecord>;
    /** Store a conversation and organize it like any captured thread. */
    storeConversation: (conversation: SiteConversation) => Promise<'stored' | 'skipped'>;
    /**
     * Which account the signed-in session of a provider is. History is read with the browser's
     * current cookies, so it belongs to the realm's active account, not always the bound one.
     */
    resolveAccount?: CaptureAccountResolver;
  }
): SyncEnv {
  const resolveBound = async (settings: SettingsRecord, provider: SyncProviderId) => {
    const bound = settings.boundAccounts[provider];
    if (!deps.resolveAccount) return bound;
    try {
      return await deps.resolveAccount(provider, bound);
    } catch {
      return bound;
    }
  };
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
    async knownUpdatedAt(provider: SyncProviderId) {
      const known: Record<string, string> = {};
      const settings = await deps.loadSettings();
      const bound = await resolveBound(settings, provider);
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
    async hasRecentCapture(provider, sourceConversationId) {
      const settings = await deps.loadSettings();
      const bound = await resolveBound(settings, provider);
      const key = buildThreadKey({ provider, accountId: bound.accountId, workspaceId: bound.workspaceId, sourceConversationId, branchId: 'main' });
      const c = await db.conversations.get(key);
      return Boolean(c && c.messageCount > 0 && Date.now() - Date.parse(c.lastCapturedAt) < RECENT_CAPTURE_MS);
    },
    async saveState(state: SyncState) {
      await chrome.storage.local.set({ [HISTORY_SYNC_STATE_KEY]: state });
    },
  };
}
