import {
  ThreadkeeperDB,
  ensureStarterCollectionsAndSettings,
  upsertThread,
  processResumableJobs,
} from '../core/db.js';
import { buildThreadKey, type SettingsRecord } from '../core/schema.js';
import { seedSyntheticWorkbenchLibrary } from '../core/synthetic-fixtures.js';
import { validateRuntimeMessageSender } from '../core/messaging.js';
import { requestThreadEnrichment } from '../core/cloud-client.js';
import { isProviderId, type CaptureProviderId } from '../core/providers.js';
import {
  nextDueAnalysisAt,
  processThreadLocally,
  runAnalysisJobs,
} from '../core/pipeline.js';
import { loadOrganizeContext, type OrganizeContext } from '../core/auto-organize.js';

const db = new ThreadkeeperDB();

const ANALYSIS_DUE_ALARM = 'tk-analysis-due';
const ANALYSIS_SWEEP_ALARM = 'tk-analysis-sweep';
const AI_PAGE_RE =
  /^https:\/\/(chatgpt\.com|chat\.openai\.com|claude\.ai|grok\.com|gemini\.google\.com|(www\.)?perplexity\.ai|chat\.deepseek\.com|chat\.mistral\.ai|copilot\.microsoft\.com)\//i;

let organizeCtxCache: { ctx: OrganizeContext; at: number } | null = null;
let analysisRun: Promise<unknown> | null = null;

async function getOrganizeContext(settings: SettingsRecord): Promise<OrganizeContext> {
  if (organizeCtxCache && Date.now() - organizeCtxCache.at < 60_000) return organizeCtxCache.ctx;
  const ctx = await loadOrganizeContext(db, settings);
  organizeCtxCache = { ctx, at: Date.now() };
  return ctx;
}

/** Tell open manager / side panel pages that the library changed. */
function broadcastLibraryChanged(threadKey?: string): void {
  try {
    void chrome.runtime.sendMessage({ type: 'LIBRARY_CHANGED', threadKey }).catch(() => undefined);
  } catch {
    // no listeners open
  }
}

/** Toolbar button: side panel by default; overlay or tab when chosen in Settings. */
async function applyLaunchBehavior(settings?: SettingsRecord): Promise<void> {
  const s = settings ?? (await ensureStarterCollectionsAndSettings(db));
  if (chrome.sidePanel?.setPanelBehavior) {
    try {
      await chrome.sidePanel.setPanelBehavior({
        openPanelOnActionClick: s.launchSurface === 'side_panel',
      });
    } catch {
      // side panel unsupported in this browser build; action.onClicked handles it
    }
  }
}

async function scheduleAnalysisAlarm(): Promise<void> {
  if (!chrome.alarms) return;
  const due = await nextDueAnalysisAt(db);
  if (due === null) return;
  await chrome.alarms.create(ANALYSIS_DUE_ALARM, { when: Math.max(due, Date.now() + 1000) });
}

/** Drain due AI analysis jobs; one run at a time per service-worker lifetime. */
function kickAnalysis(): Promise<unknown> {
  if (analysisRun) return analysisRun;
  analysisRun = (async () => {
    try {
      const summary = await runAnalysisJobs(db, { maxJobs: 8, timeBudgetMs: 240_000 });
      if (summary.processed > 0) {
        organizeCtxCache = null;
        broadcastLibraryChanged();
      }
      return summary;
    } finally {
      analysisRun = null;
      await scheduleAnalysisAlarm();
    }
  })();
  return analysisRun;
}

async function openManagerTab(query?: Record<string, string>): Promise<number | undefined> {
  const params = new URLSearchParams({ surface: 'page', ...(query ?? {}) });
  const targetUrl = chrome.runtime.getURL(`manager.html?${params.toString()}`);
  const existingTabs = await chrome.tabs.query({ url: `${chrome.runtime.getURL('manager.html')}*` });
  if (existingTabs.length > 0 && existingTabs[0].id !== undefined) {
    await chrome.tabs.update(existingTabs[0].id, { active: true, ...(query ? { url: targetUrl } : {}) });
    return existingTabs[0].id;
  }
  const created = await chrome.tabs.create({ url: targetUrl });
  return created.id;
}
const securityRejectionLog: Array<{ timestamp: string; reason: string }> = [];
type HandshakeEntry = { token: string; redeemed: boolean };
const tabHandshakeTokens = new Map<number, HandshakeEntry>();
const SESSION_HANDSHAKE_KEY = 'tk_tab_handshakes';

async function readSessionHandshakeMap(): Promise<Record<string, HandshakeEntry>> {
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    try {
      const res = await chrome.storage.session.get(SESSION_HANDSHAKE_KEY);
      const raw = res?.[SESSION_HANDSHAKE_KEY];
      if (raw && typeof raw === 'object') {
        return { ...(raw as Record<string, HandshakeEntry>) };
      }
    } catch {
      // ignore session storage failures in restricted contexts
    }
  }
  return {};
}

async function writeSessionHandshakeMap(
  map: Record<string, HandshakeEntry>
): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    try {
      await chrome.storage.session.set({ [SESSION_HANDSHAKE_KEY]: map });
    } catch {
      // ignore session storage failures
    }
  }
}

async function getTabHandshake(
  tabId: number
): Promise<HandshakeEntry | undefined> {
  const mem = tabHandshakeTokens.get(tabId);
  if (mem) return mem;
  const sessionMap = await readSessionHandshakeMap();
  const persisted = sessionMap[String(tabId)];
  if (
    persisted &&
    typeof persisted.token === 'string' &&
    typeof persisted.redeemed === 'boolean'
  ) {
    tabHandshakeTokens.set(tabId, persisted);
    return persisted;
  }
  return undefined;
}

async function setTabHandshake(
  tabId: number,
  entry: HandshakeEntry
): Promise<void> {
  tabHandshakeTokens.set(tabId, entry);
  const sessionMap = await readSessionHandshakeMap();
  sessionMap[String(tabId)] = entry;
  await writeSessionHandshakeMap(sessionMap);
}

async function deleteTabHandshake(tabId: number): Promise<void> {
  tabHandshakeTokens.delete(tabId);
  const sessionMap = await readSessionHandshakeMap();
  if (Object.prototype.hasOwnProperty.call(sessionMap, String(tabId))) {
    delete sessionMap[String(tabId)];
    await writeSessionHandshakeMap(sessionMap);
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void deleteTabHandshake(tabId);
  });
}

function generateHandshakeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function invokeOverlayOnTab(
  tabId: number | undefined,
  tabUrl: string | undefined,
  invocationSource: 'toolbar_action' | 'keyboard_command' | 'test_harness'
): Promise<{ mode: 'overlay' | 'full_page_tab'; tabId?: number }> {
  await ensureStarterCollectionsAndSettings(db);
  if (invocationSource === 'test_harness') {
    await seedSyntheticWorkbenchLibrary(db);
  }

  const canInjectOverlay =
    typeof tabId === 'number' && typeof tabUrl === 'string' && AI_PAGE_RE.test(tabUrl);

  if (canInjectOverlay && tabId !== undefined) {
    const handshakeToken = generateHandshakeToken();
    await setTabHandshake(tabId, { token: handshakeToken, redeemed: false });
    try {
      const resp = (await chrome.tabs.sendMessage(tabId, {
        type: 'TOGGLE_THREADKEEPER_OVERLAY',
        invocationSource,
        handshakeToken,
      })) as { state?: 'opened' | 'closed' } | undefined;
      if (resp?.state === 'closed') {
        await deleteTabHandshake(tabId);
      }
      return { mode: 'overlay', tabId };
    } catch {
      // If content script was not yet injected on this page, inject on demand upon deliberate user click
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content-scripts/content.js'],
        });
        const resp = (await chrome.tabs.sendMessage(tabId, {
          type: 'TOGGLE_THREADKEEPER_OVERLAY',
          invocationSource,
          handshakeToken,
        })) as { state?: 'opened' | 'closed' } | undefined;
        if (resp?.state === 'closed') {
          await deleteTabHandshake(tabId);
        }
        return { mode: 'overlay', tabId };
      } catch {
        await deleteTabHandshake(tabId);
        // Fall through to full-page manager tab
      }
    }
  }

  const tabIdOpened = await openManagerTab();
  return { mode: 'full_page_tab', tabId: tabIdOpened };
}

// Deliberate user invocation ONLY: toolbar click or keyboard command.
// In side-panel mode Chrome opens the panel itself and onClicked does not fire.
if (typeof chrome !== 'undefined' && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    void (async () => {
      const settings = await ensureStarterCollectionsAndSettings(db);
      if (settings.launchSurface === 'tab') {
        await openManagerTab();
      } else {
        await invokeOverlayOnTab(tab.id, tab.url, 'toolbar_action');
      }
    })();
  });
}

if (typeof chrome !== 'undefined' && chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command, tab) => {
    if (command === 'open-side-panel') {
      const windowId = tab?.windowId;
      if (chrome.sidePanel?.open && typeof windowId === 'number') {
        try {
          await chrome.sidePanel.open({ windowId });
          return;
        } catch {
          // fall through to the full-page manager
        }
      }
      await openManagerTab();
      return;
    }
    if (command === 'toggle-threadkeeper' || command === 'toggle-overlay') {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      await invokeOverlayOnTab(
        activeTab?.id,
        activeTab?.url,
        'keyboard_command'
      );
    } else if (command === 'open-manager') {
      await invokeOverlayOnTab(undefined, undefined, 'keyboard_command');
    }
  });
}

// Install & Startup: initialize IndexedDB starter areas and alarms silently — NEVER open UI or seed synthetic demo data
async function initializeBackground(): Promise<void> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  await applyLaunchBehavior(settings);
  if (chrome.alarms) {
    await chrome.alarms.create('threadkeeper-resumable-jobs', { periodInMinutes: 5 });
    await chrome.alarms.create(ANALYSIS_SWEEP_ALARM, { periodInMinutes: 3 });
  }
  await scheduleAnalysisAlarm();
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void initializeBackground();
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    void initializeBackground();
  });
}

if (typeof chrome !== 'undefined' && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'threadkeeper-resumable-jobs') {
      void processResumableJobs(db, async (job) => {
        if (job.jobType === 'enrich_thread') {
          await requestThreadEnrichment(db, job.threadKey);
        }
      });
    } else if (alarm.name === ANALYSIS_DUE_ALARM || alarm.name === ANALYSIS_SWEEP_ALARM) {
      void kickAnalysis();
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void (async () => {
      const validation = validateRuntimeMessageSender(
        message,
        sender,
        chrome.runtime.id
      );
      if (!validation.allowed) {
        securityRejectionLog.push({
          timestamp: new Date().toISOString(),
          reason: validation.reason ?? 'Rejected runtime message',
        });
        sendResponse({ ok: false, error: validation.reason });
        return;
      }

      if (message.type === 'GET_CAPTURE_AUTH_STATE') {
        const settings = await ensureStarterCollectionsAndSettings(db);
        const provider = message.provider as CaptureProviderId;
        const authorized = Boolean(settings.authorizedHosts[provider]);
        sendResponse({
          ok: true,
          authorized,
          boundAccount: settings.boundAccounts[provider],
        });
        return;
      }

      if (message.type === 'PASSIVE_DOM_CAPTURE') {
        const settings = await ensureStarterCollectionsAndSettings(db);
        const rawProvider = message.payload?.provider;
        if (!isProviderId(rawProvider) || rawProvider === 'imported') {
          sendResponse({ ok: false, error: 'Unknown capture provider' });
          return;
        }
        const provider: CaptureProviderId = rawProvider;
        if (!settings.authorizedHosts[provider] && !message.explicitInvoke) {
          sendResponse({
            ok: false,
            skipped: 'provider_not_authorized',
          });
          return;
        }
        const bound = settings.boundAccounts[provider];
        const threadKey = buildThreadKey({
          provider,
          accountId: bound.accountId,
          workspaceId: bound.workspaceId,
          sourceConversationId: message.payload.sourceConversationId,
          branchId: message.payload.branchId,
        });
        const result = await upsertThread(db, {
          ...message.payload,
          provider,
          threadKey,
          accountId: bound.accountId,
          workspaceId: bound.workspaceId,
        });
        sendResponse({
          ok: true,
          status: result.status,
          threadKey,
          coverage: result.record?.coverage,
        });
        if (result.status === 'stored') {
          // Organize immediately on-device; Claude analysis is debounced until the chat goes quiet.
          try {
            const outcome = await processThreadLocally(db, threadKey, {
              settings,
              ctx: await getOrganizeContext(settings),
            });
            if (outcome.createdProject) organizeCtxCache = null;
            if (outcome.enqueued) await scheduleAnalysisAlarm();
          } catch (err) {
            console.warn('[threadkeeper] local organize failed', err);
          }
          broadcastLibraryChanged(threadKey);
        }
        return;
      }

      if (message.type === 'OVERLAY_FRAME_STATUS') {
        const tabId = sender.tab?.id;
        const entry = typeof tabId === 'number' ? await getTabHandshake(tabId) : undefined;
        sendResponse({ ok: true, redeemed: Boolean(entry?.redeemed) });
        return;
      }

      if (message.type === 'OPEN_MANAGER_FALLBACK') {
        // The in-page overlay could not load (blocked by the browser or the page); open the full library instead.
        securityRejectionLog.push({
          timestamp: new Date().toISOString(),
          reason: `Overlay frame did not load on tab ${sender.tab?.id ?? '?'}; opened full-page manager`,
        });
        if (typeof sender.tab?.id === 'number') await deleteTabHandshake(sender.tab.id);
        const openedTab = await openManagerTab();
        sendResponse({ ok: true, tabId: openedTab });
        return;
      }

      if (message.type === 'SETTINGS_CHANGED') {
        organizeCtxCache = null;
        await applyLaunchBehavior();
        await scheduleAnalysisAlarm();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'RUN_ANALYSIS_NOW') {
        organizeCtxCache = null;
        void kickAnalysis();
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'REDEEM_OVERLAY_HANDSHAKE') {
        const tabId = sender.tab?.id;
        if (typeof tabId !== 'number') {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: 'Rejected REDEEM_OVERLAY_HANDSHAKE without tabId',
          });
          sendResponse({
            ok: false,
            error: 'Missing tabId for overlay handshake',
          });
          return;
        }
        const entry = await getTabHandshake(tabId);
        if (!entry || entry.token !== message.handshakeToken) {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: `Rejected REDEEM_OVERLAY_HANDSHAKE with invalid token on tab ${tabId}`,
          });
          sendResponse({
            ok: false,
            error: 'Invalid overlay handshake token',
          });
          return;
        }
        if (entry.redeemed) {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: `Rejected second-use REDEEM_OVERLAY_HANDSHAKE replay on tab ${tabId}`,
          });
          sendResponse({
            ok: false,
            error: 'Overlay handshake token already redeemed for this tab',
          });
          return;
        }
        await setTabHandshake(tabId, {
          token: entry.token,
          redeemed: true,
        });
        sendResponse({ ok: true, redeemed: true });
        return;
      }

      const isEmbeddedInHostTab =
        typeof sender.tab?.id === 'number' &&
        !(sender.tab.url ?? '').startsWith('chrome-extension://');

      const privilegedOverlayTypes = new Set([
        'OPEN_FULL_PAGE_MANAGER',
        'OPEN_ORIGINAL_THREAD',
        'DELETE_THREAD',
        'EXPORT_BUNDLE',
        'UPDATE_SETTINGS',
        'RUN_RESUMABLE_JOBS',
      ]);

      if (isEmbeddedInHostTab && privilegedOverlayTypes.has(message.type)) {
        const activeEntry = await getTabHandshake(sender.tab!.id!);
        if (
          !activeEntry ||
          !activeEntry.redeemed ||
          activeEntry.token !== message.handshakeToken
        ) {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: `Rejected ${message.type} from unauthenticated overlay frame on tab ${sender.tab!.id}`,
          });
          sendResponse({
            ok: false,
            error: 'Unauthorized overlay iframe sender',
          });
          return;
        }
      }

      if (message.type === 'OPEN_FULL_PAGE_MANAGER') {
        const query: Record<string, string> = {};
        if (message.threadKey) query.threadKey = message.threadKey;
        if (message.query) query.q = message.query;
        const existingTabs = await chrome.tabs.query({
          url: `${chrome.runtime.getURL('manager.html')}*`,
        });
        const openedTab = await openManagerTab(query);
        sendResponse({ ok: true, tabId: openedTab, reused: existingTabs.length > 0 });
        return;
      }

      if (message.type === 'OPEN_ORIGINAL_THREAD') {
        const settings = await ensureStarterCollectionsAndSettings(db);
        const requestedProvider: unknown = message.provider;
        const bound = isProviderId(requestedProvider)
          ? settings.boundAccounts[requestedProvider]
          : undefined;
        if (
          bound &&
          (bound.accountId !== message.expectedAccountId ||
            bound.workspaceId !== message.expectedWorkspaceId) &&
          !message.forceOpen
        ) {
          sendResponse({
            ok: false,
            status: 'account_mismatch',
            boundAccount: bound,
            expectedAccount: {
              accountId: message.expectedAccountId,
              workspaceId: message.expectedWorkspaceId,
            },
          });
          return;
        }
        if (typeof message.canonicalUrl !== 'string' || !/^https:\/\//i.test(message.canonicalUrl)) {
          sendResponse({ ok: false, status: 'no_web_url' });
          return;
        }
        const allTabs = await chrome.tabs.query({});
        const match = allTabs.find((t) => t.url === message.canonicalUrl);
        if (match && match.id !== undefined) {
          await chrome.tabs.update(match.id, { active: true });
          sendResponse({ ok: true, status: 'reused_tab', tabId: match.id });
        } else {
          const created = await chrome.tabs.create({ url: message.canonicalUrl });
          sendResponse({ ok: true, status: 'opened_new_tab', tabId: created.id });
        }
        return;
      }

      if (message.type === 'CLOSE_THREADKEEPER_OVERLAY') {
        let targetTabId = sender.tab?.id;
        if (
          typeof targetTabId !== 'number' ||
          (sender.tab?.url ?? '').startsWith('chrome-extension://')
        ) {
          const [activeTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          targetTabId = activeTab?.id;
        }
        if (typeof targetTabId !== 'number') {
          sendResponse({
            ok: false,
            error: 'No target tab for CLOSE_THREADKEEPER_OVERLAY',
          });
          return;
        }
        const activeEntry = await getTabHandshake(targetTabId);
        if (
          !activeEntry ||
          !activeEntry.redeemed ||
          activeEntry.token !== message.handshakeToken
        ) {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: `Rejected CLOSE_THREADKEEPER_OVERLAY with invalid or unredeemed handshakeToken on tab ${targetTabId}`,
          });
          sendResponse({
            ok: false,
            error: 'Invalid or unredeemed handshakeToken',
          });
          return;
        }
        try {
          const closeResp = (await chrome.tabs.sendMessage(targetTabId, {
            type: 'CLOSE_THREADKEEPER_OVERLAY',
            handshakeToken: message.handshakeToken,
          })) as { ok?: boolean; error?: string } | undefined;
          if (!closeResp?.ok) {
            sendResponse({
              ok: false,
              error: closeResp?.error ?? 'Content script rejected close',
            });
            return;
          }
          await deleteTabHandshake(targetTabId);
        } catch {
          await deleteTabHandshake(targetTabId);
        }
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: true });
    })();
    return true;
  });
}

// Expose test-harness entrypoints on ServiceWorker globalThis for packaged-extension acceptance testing
(globalThis as unknown as Record<string, unknown>).__threadkeeperInvokeAction =
  invokeOverlayOnTab;
(globalThis as unknown as Record<string, unknown>).__threadkeeperGetSecurityRejections =
  () => [...securityRejectionLog];
(globalThis as unknown as Record<string, unknown>).__threadkeeperRunAnalysis = () => kickAnalysis();
(globalThis as unknown as Record<string, unknown>).__threadkeeperDb = db;
(globalThis as unknown as Record<string, unknown>).__threadkeeperClearInMemoryHandshakes =
  () => {
    tabHandshakeTokens.clear();
    return tabHandshakeTokens.size;
  };
