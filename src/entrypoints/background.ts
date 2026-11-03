import {
  ThreadkeeperDB,
  ensureStarterCollectionsAndSettings,
  upsertThread,
  processResumableJobs,
} from '../core/db.js';
import { buildThreadKey, type SettingsRecord } from '../core/schema.js';
import { HistorySyncOrchestrator } from '../core/sync-orchestrator.js';
import { HISTORY_SYNC_STATE_KEY, createChromeSyncEnv } from '../core/sync-env.js';
import { EMPTY_SYNC_STATE, clampSyncDays, isSyncProviderId, validateSyncEvent, type SyncState } from '../core/history-sync.js';
import { siteConversationTitle, type SiteConversation } from '../core/site-api.js';
import { seedSyntheticWorkbenchLibrary } from '../core/synthetic-fixtures.js';
import { DOCK_COMMAND_TYPES, captureSenderUrl, validateDockPageSender, validateRuntimeMessageSender } from '../core/messaging.js';
import { DockService } from '../core/dock/external.js';
import { requestThreadEnrichment } from '../core/cloud-client.js';
import {
  PROVIDERS,
  detectProviderFromUrl,
  isCapturePageUrl,
  isProviderAllowedOnUrl,
  isProviderId,
  type CaptureProviderId,
} from '../core/providers.js';
import { EXPLICIT_GRANT_MS, decideCapture, newGrantToken, type ExplicitGrant } from '../core/capture-gate.js';
import {
  CONTENT_SCRIPT_FILE,
  chromeCaptureScriptEnv,
  matchCustomSite,
  readCustomSites,
  reconcileCaptureScripts,
} from '../core/custom-sites.js';
import {
  nextDueAnalysisAt,
  processThreadLocally,
  runAnalysisJobs,
} from '../core/pipeline.js';
import { loadOrganizeContext, type OrganizeContext } from '../core/auto-organize.js';
import { autoHealStaleManifest, readDiskBuildInfo } from '../core/diagnostics.js';
import { BUILD_INFO } from '../core/build-info.js';

const db = new ThreadkeeperDB();

const ANALYSIS_DUE_ALARM = 'tk-analysis-due';
const ANALYSIS_SWEEP_ALARM = 'tk-analysis-sweep';
// Sidebar Dock (Still) link.
const DOCK_DRAIN_ALARM = 'tk-dock-drain';
const DOCK_RECONCILE_ALARM = 'tk-dock-reconcile';
const DOCK_DAILY_ALARM = 'tk-dock-daily';
const DOCK_PAIR_ALARM = 'tk-dock-pair';

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
      const finished: string[] = [];
      const summary = await runAnalysisJobs(db, {
        maxJobs: 8,
        timeBudgetMs: 240_000,
        onJobDone: (threadKey, status) => {
          if (status !== 'skipped') finished.push(threadKey);
        },
      });
      if (finished.length) await dock.markDirty(finished).catch(() => undefined);
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

/** Organize a stored thread on-device right away and queue Claude analysis for when it goes quiet. */
async function organizeStoredThread(threadKey: string, settings: SettingsRecord): Promise<void> {
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
  await dock.markDirty([threadKey]).catch((err) => console.warn('[threadkeeper] Still sync mark failed', err));
  broadcastLibraryChanged(threadKey);
}

/** Store a conversation read by Catch up. Deleted threads stay deleted (tombstones), and a site whose capture is off is skipped. */
async function storeSyncedConversation(conv: SiteConversation): Promise<'stored' | 'skipped'> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  if (!settings.authorizedHosts[conv.provider]) return 'skipped';
  const bound = settings.boundAccounts[conv.provider];
  const threadKey = buildThreadKey({
    provider: conv.provider,
    accountId: bound.accountId,
    workspaceId: bound.workspaceId,
    sourceConversationId: conv.sourceConversationId,
    branchId: 'main',
  });
  const result = await upsertThread(db, {
    threadKey,
    provider: conv.provider,
    accountId: bound.accountId,
    workspaceId: bound.workspaceId,
    sourceConversationId: conv.sourceConversationId,
    branchId: 'main',
    canonicalUrl: conv.canonicalUrl,
    title: siteConversationTitle(conv),
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt ?? new Date().toISOString(),
    coverage: conv.messages.length > 0 ? 'full' : 'title_only',
    captureSource: 'history_sync',
    modelSlug: conv.modelSlug,
    messages: conv.messages,
  });
  if (result.status !== 'stored') return 'skipped';
  await organizeStoredThread(threadKey, settings);
  return 'stored';
}

const syncOrchestrator = new HistorySyncOrchestrator(
  createChromeSyncEnv(db, {
    loadSettings: () => ensureStarterCollectionsAndSettings(db),
    storeConversation: storeSyncedConversation,
  })
);

/** The state the library shows: the live run, else what was last saved. A run the worker lost is marked interrupted. */
async function currentSyncState(): Promise<SyncState> {
  if (syncOrchestrator.state.runId) return syncOrchestrator.state;
  try {
    const stored = (await chrome.storage.local.get(HISTORY_SYNC_STATE_KEY))[HISTORY_SYNC_STATE_KEY] as SyncState | undefined;
    if (stored && typeof stored === 'object' && Array.isArray(stored.providers)) {
      if (stored.running) {
        const fixed: SyncState = {
          ...stored,
          running: false,
          providers: stored.providers.map((p) =>
            p.status === 'done' || p.status === 'error' || p.status === 'cancelled'
              ? p
              : { ...p, status: 'error' as const, message: 'Stopped when the browser restarted the extension. Run Catch up again; what was imported is kept.' }
          ),
        };
        await chrome.storage.local.set({ [HISTORY_SYNC_STATE_KEY]: fixed });
        return fixed;
      }
      return stored;
    }
  } catch {
    // storage unavailable
  }
  return EMPTY_SYNC_STATE;
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

function logSecurity(reason: string): void {
  securityRejectionLog.push({ timestamp: new Date().toISOString(), reason });
  if (securityRejectionLog.length > 200) securityRejectionLog.splice(0, securityRejectionLog.length - 200);
}

/** Consent window for a Still pair request: a top-level popup (connect.html is not web-accessible). */
async function openDockConsentWindow(): Promise<void> {
  const url = chrome.runtime.getURL('connect.html');
  try {
    if (chrome.windows?.create) {
      await chrome.windows.create({ url, type: 'popup', width: 480, height: 640, focused: true });
      return;
    }
  } catch {
    // fall back to a tab
  }
  await chrome.tabs.create({ url });
}

const dock = new DockService({
  db,
  ownId: typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : '',
  version:
    typeof chrome !== 'undefined' && chrome.runtime?.getManifest ? chrome.runtime.getManifest().version : BUILD_INFO.version,
  sendExternal: (extensionId, message) => chrome.runtime.sendMessage(extensionId, message),
  openConsentWindow: openDockConsentWindow,
  openThread: async (threadKey) => {
    await openManagerTab({ threadKey });
  },
  kickAnalysis: () => {
    organizeCtxCache = null;
    void kickAnalysis();
  },
  scheduleDrain: (atMs) => {
    if (!chrome.alarms) return;
    if (atMs === null) void chrome.alarms.clear(DOCK_DRAIN_ALARM);
    else void chrome.alarms.create(DOCK_DRAIN_ALARM, { when: Math.max(atMs, Date.now() + 30_000) });
  },
  schedulePairRetry: (on) => {
    if (!chrome.alarms) return;
    if (on) void chrome.alarms.create(DOCK_PAIR_ALARM, { periodInMinutes: 0.5 });
    else void chrome.alarms.clear(DOCK_PAIR_ALARM);
  },
  broadcast: () => {
    try {
      void chrome.runtime.sendMessage({ type: 'DOCK_CHANGED' }).catch(() => undefined);
    } catch {
      // no listeners open
    }
  },
  log: logSecurity,
});

// Still (Sidebar Dock) talks to Threadkeeper only on the external channel, with its own validator;
// external messages never reach the internal handler. Registered synchronously at top level.
if (typeof chrome !== 'undefined' && chrome.runtime?.onMessageExternal) {
  chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
    void dock.handleExternalMessage(message, sender).then(sendResponse, () =>
      sendResponse({ ok: false, proto: 'still-threadkeeper/1', error: { code: 'internal', message: 'Threadkeeper failed' } })
    );
    return true;
  });
}

// ---- Capture on runtime-granted sites (optional providers, sites added in Settings) ----------

/** Per-tab proof that the user asked for that tab (overlay opened, or "Capture this tab"). */
const explicitGrants = new Map<number, ExplicitGrant>();
/** "Capture this tab" waits for the capture its token produces. */
const explicitWaiters = new Map<number, { token: string; resolve: (result: CaptureTabResult) => void }>();

interface CaptureTabResult {
  ok: boolean;
  status?: string;
  error?: string;
  title?: string;
  messages?: number;
  provider?: string;
}

function grantExplicitCapture(tabId: number, kind: ExplicitGrant['kind'], token = newGrantToken()): string {
  explicitGrants.set(tabId, { token, kind, expiresAt: Date.now() + EXPLICIT_GRANT_MS });
  return token;
}

let captureSitesQueue: Promise<void> = Promise.resolve();

/**
 * Register / unregister the runtime content scripts so they match settings, added sites and
 * granted access. Runs one at a time: a settings change, a permission event and the page's own
 * notice often arrive together, and overlapping runs would register the same id twice.
 */
function reconcileCaptureSites(settings?: SettingsRecord): Promise<void> {
  captureSitesQueue = captureSitesQueue.then(() => reconcileCaptureSitesNow(settings)).catch(() => undefined);
  return captureSitesQueue;
}

async function reconcileCaptureSitesNow(settings?: SettingsRecord): Promise<void> {
  const env = chromeCaptureScriptEnv();
  if (!env) return;
  const s = settings ?? (await ensureStarterCollectionsAndSettings(db));
  const sites = await readCustomSites(chrome.storage?.local);
  const result = await reconcileCaptureScripts(env, { authorizedHosts: s.authorizedHosts, sites: sites.sites });
  if (result.error) {
    securityRejectionLog.push({ timestamp: new Date().toISOString(), reason: `Could not update capture scripts: ${result.error}` });
  }
}

/** Load the reader into tabs already open on newly granted pages (registration only affects new loads). */
async function injectIntoOpenTabs(patterns: string[]): Promise<void> {
  if (patterns.length === 0 || !chrome.tabs?.query || !chrome.scripting?.executeScript) return;
  try {
    const tabs = await chrome.tabs.query({ url: patterns });
    for (const tab of tabs) {
      if (typeof tab.id !== 'number') continue;
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: [CONTENT_SCRIPT_FILE] }).catch(() => undefined);
    }
  } catch {
    // no access to those tabs yet
  }
}

/** Whether Threadkeeper may read this page at all: a provider page it has access to, or an added site. */
async function capturablePage(url: string): Promise<{ ok: true; label: string } | { ok: false; error: string }> {
  const provider = detectProviderFromUrl(url);
  if (provider && PROVIDERS[provider].hostAccess !== 'custom' && isProviderAllowedOnUrl(provider, url)) {
    return { ok: true, label: PROVIDERS[provider].label };
  }
  const site = matchCustomSite(await readCustomSites(chrome.storage?.local), url);
  if (site) return { ok: true, label: site.label };
  return { ok: false, error: 'This tab is not an AI page Threadkeeper reads. Add the site under "Any AI site" first.' };
}

/** Settings → Capture → "Capture this tab": save the conversation open in the given (or active) tab. */
async function captureTabNow(requestedTabId?: number): Promise<CaptureTabResult> {
  let tab: chrome.tabs.Tab | undefined;
  try {
    tab =
      typeof requestedTabId === 'number'
        ? await chrome.tabs.get(requestedTabId)
        : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  } catch {
    tab = undefined;
  }
  if (!tab || typeof tab.id !== 'number') return { ok: false, error: 'There is no tab to capture.' };
  const url = tab.url ?? '';
  if (url.startsWith('chrome-extension://') || url.startsWith('edge://') || url.startsWith('chrome://')) {
    return { ok: false, error: 'Switch to the tab with the chat, then use Capture this tab from the side panel.' };
  }
  if (!url) return { ok: false, error: 'Threadkeeper has no access to this tab. Turn its site on (or add it) under Capture first.' };
  const page = await capturablePage(url);
  if (!page.ok) return { ok: false, error: page.error };
  const tabId = tab.id;
  const token = grantExplicitCapture(tabId, 'capture');
  const result = new Promise<CaptureTabResult>((resolve) => {
    explicitWaiters.get(tabId)?.resolve({ ok: false, error: 'Replaced by a newer request.' });
    explicitWaiters.set(tabId, { token, resolve });
    setTimeout(() => {
      if (explicitWaiters.get(tabId)?.token !== token) return;
      explicitWaiters.delete(tabId);
      resolve({ ok: false, error: 'No conversation was found on this tab. Open the chat itself, wait for the reply to finish, then try again.' });
    }, 10_000);
  });
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'TK_CAPTURE_NOW', explicitToken: token });
  try {
    await ask();
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT_FILE] });
      await ask();
    } catch {
      explicitWaiters.delete(tabId);
      return { ok: false, error: `Threadkeeper could not read this ${page.label} tab. Reload the tab and try again.` };
    }
  }
  return result;
}

function settleExplicitWaiter(tabId: number | undefined, token: unknown, result: CaptureTabResult): void {
  if (typeof tabId !== 'number' || typeof token !== 'string') return;
  const waiter = explicitWaiters.get(tabId);
  if (!waiter || waiter.token !== token) return;
  explicitWaiters.delete(tabId);
  waiter.resolve(result);
}
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
    explicitGrants.delete(tabId);
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

  // AI pages come from the provider registry (x.com counts only on /i/grok).
  const canInjectOverlay =
    typeof tabId === 'number' && typeof tabUrl === 'string' && isCapturePageUrl(tabUrl);

  if (canInjectOverlay && tabId !== undefined) {
    const handshakeToken = generateHandshakeToken();
    await setTabHandshake(tabId, { token: handshakeToken, redeemed: false });
    // Opening Threadkeeper on a page counts as asking for it (except where capture is explicit-only).
    grantExplicitCapture(tabId, 'overlay', handshakeToken);
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
    await chrome.alarms.create(DOCK_RECONCILE_ALARM, { periodInMinutes: 15 });
    await chrome.alarms.create(DOCK_DAILY_ALARM, { periodInMinutes: 24 * 60 });
  }
  await scheduleAnalysisAlarm();
  // Still link: catch up with anything changed while the browser was closed (no-op when unpaired;
  // skipped when the last full pass is under 10 minutes old), then push what is due.
  await dock.reconcile(false).catch((err) => console.warn('[threadkeeper] Still reconcile failed', err));
  await reconcileCaptureSites(settings);
  dock.kickDrain();
}

// Host access granted or withdrawn (in Settings, or on the browser's extension page): keep the
// runtime content scripts in line.
if (typeof chrome !== 'undefined' && chrome.permissions?.onAdded) {
  chrome.permissions.onAdded.addListener(() => void reconcileCaptureSites());
  chrome.permissions.onRemoved.addListener(() => void reconcileCaptureSites());
}

// A rebuilt-but-not-reloaded unpacked extension keeps the previous manifest
// (e.g. one with use_dynamic_url, which Edge blocks) and this worker keeps its
// cached script, so compare the build on disk with the running manifest and
// reload once per build. The analysis alarms wake the worker every few minutes.
if (typeof chrome !== 'undefined' && chrome.runtime?.getManifest && chrome.storage?.local) {
  void readDiskBuildInfo(chrome.runtime.getURL('build-info.json'))
    .then((disk) =>
      autoHealStaleManifest({
        manifest: chrome.runtime.getManifest(),
        storage: chrome.storage.local,
        reload: () => chrome.runtime.reload(),
        build: disk ?? BUILD_INFO,
      })
    )
    .then((outcome) => {
      if (outcome !== 'ok') {
        securityRejectionLog.push({
          timestamp: new Date().toISOString(),
          reason: `Running manifest does not match this build (${outcome})`,
        });
      }
    })
    .catch((err) => console.warn('[threadkeeper] manifest self-check failed', err));
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
    } else if (alarm.name === DOCK_DRAIN_ALARM) {
      void dock.drain();
    } else if (alarm.name === DOCK_RECONCILE_ALARM) {
      void dock.reconcile(false);
    } else if (alarm.name === DOCK_DAILY_ALARM) {
      void dock.daily();
    } else if (alarm.name === DOCK_PAIR_ALARM) {
      void dock.deliverGrant();
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

      if (message.type === 'GET_CAPTURE_SITE') {
        // The content script on a page no provider owns asks whether the user added this site.
        const pageUrl = captureSenderUrl(sender);
        const site = pageUrl ? matchCustomSite(await readCustomSites(chrome.storage?.local), pageUrl) : null;
        sendResponse(site ? { ok: true, site: { origin: site.origin } } : { ok: false });
        return;
      }

      if (message.type === 'PASSIVE_DOM_CAPTURE') {
        const settings = await ensureStarterCollectionsAndSettings(db);
        const tabId = sender.tab?.id;
        const decision = decideCapture({
          payload: message.payload,
          explicitToken: message.explicitToken,
          sender,
          authorizedHosts: settings.authorizedHosts,
          sites: await readCustomSites(chrome.storage?.local),
          grant: typeof tabId === 'number' ? explicitGrants.get(tabId) : null,
          now: Date.now(),
        });
        if (!decision.ok) {
          if (decision.error) {
            securityRejectionLog.push({ timestamp: new Date().toISOString(), reason: `Rejected capture: ${decision.error}` });
          }
          const label = isProviderId(message.payload?.provider) ? PROVIDERS[message.payload.provider as CaptureProviderId].label : 'this site';
          settleExplicitWaiter(tabId, message.explicitToken, {
            ok: false,
            error:
              decision.error ??
              (decision.skipped === 'provider_not_authorized'
                ? `Capture is off for ${label}. Turn it on under AI products, then try again.`
                : 'Threadkeeper did not save this tab.'),
          });
          sendResponse(decision.error ? { ok: false, error: decision.error } : { ok: false, skipped: decision.skipped });
          return;
        }
        const provider = decision.provider;
        const bound = settings.boundAccounts[provider];
        const threadKey = buildThreadKey({
          provider,
          accountId: bound.accountId,
          workspaceId: bound.workspaceId,
          sourceConversationId: decision.sourceConversationId,
          branchId: message.payload.branchId,
        });
        // A content script may only claim the two passive sources; "full" is the site's own
        // conversation data, and a DOM capture is never more than partial.
        const passiveSource = message.payload.captureSource === 'network_observer' ? 'network_observer' : 'dom_observer';
        const result = await upsertThread(db, {
          ...message.payload,
          sourceConversationId: decision.sourceConversationId,
          canonicalUrl: decision.canonicalUrl,
          captureSource: passiveSource,
          coverage:
            passiveSource === 'network_observer' && message.payload.coverage === 'full'
              ? 'full'
              : message.payload.coverage === 'title_only'
                ? 'title_only'
                : 'partial',
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
        settleExplicitWaiter(tabId, message.explicitToken, {
          ok: true,
          status: result.status,
          provider,
          title: typeof message.payload.title === 'string' ? message.payload.title : undefined,
          messages: Array.isArray(message.payload.messages) ? message.payload.messages.length : 0,
        });
        if (result.status === 'stored') {
          // Organize immediately on-device; Claude analysis is debounced until the chat goes quiet.
          await organizeStoredThread(threadKey, settings);
          if (typeof sender.tab?.id === 'number' && Array.isArray(message.payload.messages)) {
            syncOrchestrator.noteCapture(sender.tab.id, message.payload.sourceConversationId, message.payload.messages.length);
          }
        }
        return;
      }

      if (message.type === 'CAPTURE_TAB_NOW') {
        sendResponse(await captureTabNow(typeof message.tabId === 'number' ? message.tabId : undefined));
        return;
      }

      if (message.type === 'CAPTURE_SITES_CHANGED') {
        await reconcileCaptureSites();
        const patterns = Array.isArray(message.patterns) ? message.patterns.filter((p: unknown): p is string => typeof p === 'string') : [];
        await injectIntoOpenTabs(patterns);
        sendResponse({ ok: true });
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

      if (message.type === 'GET_DIAGNOSTICS') {
        sendResponse({ ok: true, recentEvents: securityRejectionLog.slice(-20) });
        return;
      }

      if (message.type === 'SETTINGS_CHANGED') {
        organizeCtxCache = null;
        await applyLaunchBehavior();
        await scheduleAnalysisAlarm();
        await reconcileCaptureSites();
        // Excluded providers may have changed: take back what Still may no longer hold.
        await dock.syncNow({ privacy: true }).catch(() => undefined);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'HISTORY_SYNC_EVENT') {
        const event = validateSyncEvent(message.event);
        if (event) await syncOrchestrator.handleEvent(event, sender.tab?.id);
        sendResponse({ ok: Boolean(event) });
        return;
      }

      if (
        message.type === 'START_HISTORY_SYNC' ||
        message.type === 'CANCEL_HISTORY_SYNC' ||
        message.type === 'GET_HISTORY_SYNC_STATE'
      ) {
        // Catch up opens tabs and reads signed-in sessions: only the library's own pages may start it,
        // never an overlay frame inside a website.
        if (typeof sender.tab?.id === 'number' && !(sender.tab.url ?? '').startsWith('chrome-extension://')) {
          sendResponse({ ok: false, error: 'Open the side panel or the full library to run Catch up.' });
          return;
        }
        if (message.type === 'GET_HISTORY_SYNC_STATE') {
          sendResponse({ ok: true, state: await currentSyncState() });
          return;
        }
        if (message.type === 'CANCEL_HISTORY_SYNC') {
          syncOrchestrator.cancel();
          sendResponse({ ok: true });
          return;
        }
        const providers = Array.isArray(message.providers) ? message.providers.filter(isSyncProviderId) : [];
        const started = await syncOrchestrator.start({ providers, days: clampSyncDays(message.days) });
        sendResponse({ ok: started.started, error: started.reason });
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
        'DOCK_SEND',
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

      if (DOCK_COMMAND_TYPES.has(message.type)) {
        sendResponse(await handleDockCommand(message, sender));
        return;
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

/** Internal DOCK_* messages from Threadkeeper's own pages (sender already validated as privileged). */
async function handleDockCommand(
  message: Record<string, unknown> & { type: string },
  sender: chrome.runtime.MessageSender
): Promise<Record<string, unknown>> {
  const topLevelOnly = new Set(['DOCK_DECIDE', 'DOCK_UNPAIR', 'DOCK_SET_OPTIONS', 'DOCK_UNBLOCK', 'DOCK_OPEN_CONSENT']);
  if (topLevelOnly.has(message.type)) {
    const check = validateDockPageSender(message.type, sender, chrome.runtime.id);
    if (!check.allowed) {
      logSecurity(check.reason ?? `Rejected ${message.type}`);
      return { ok: false, error: 'Open Threadkeeper in its own window to do this.' };
    }
  }
  switch (message.type) {
    case 'DOCK_SYNC_NOW':
      return dock.syncNow({ threadKeys: message.threadKeys, privacy: message.privacy });
    case 'DOCK_GET_STATE':
      return { ok: true, state: await dock.getState() };
    case 'DOCK_PENDING':
      return { ok: true, pending: await dock.getPending() };
    case 'DOCK_DECIDE':
      return dock.decide({
        requestId: message.requestId,
        allow: message.allow,
        code: message.code,
        allowRemoteModels: message.allowRemoteModels,
      });
    case 'DOCK_UNPAIR':
      return dock.unpair();
    case 'DOCK_SEND':
      return dock.sendThreads(message.threadKeys, message.target);
    case 'DOCK_COLLECTIONS':
      return dock.collections();
    case 'DOCK_STATUS_FOR':
      return dock.statusFor(message.threadKeys);
    case 'DOCK_SET_OPTIONS':
      return {
        ok: true,
        state: await dock.setOptions({
          allowSearch: message.allowSearch,
          shareTranscripts: message.shareTranscripts,
          allowRemoteModels: message.allowRemoteModels,
        }),
      };
    case 'DOCK_UNBLOCK':
      return dock.unblock(message.extensionId);
    case 'DOCK_RESYNC':
      return dock.resync();
    case 'DOCK_OPEN_CONSENT':
      if (!(await dock.getPending())) return { ok: false, error: 'No request is waiting.' };
      await openDockConsentWindow();
      return { ok: true };
    default:
      return { ok: false, error: `Unknown ${message.type}` };
  }
}

// Expose test-harness entrypoints on ServiceWorker globalThis for packaged-extension acceptance testing
(globalThis as unknown as Record<string, unknown>).__threadkeeperInvokeAction =
  invokeOverlayOnTab;
(globalThis as unknown as Record<string, unknown>).__threadkeeperGetSecurityRejections =
  () => [...securityRejectionLog];
(globalThis as unknown as Record<string, unknown>).__threadkeeperDb = db;
(globalThis as unknown as Record<string, unknown>).__threadkeeperDock = dock;
(globalThis as unknown as Record<string, unknown>).__threadkeeperClearInMemoryHandshakes =
  () => {
    tabHandshakeTokens.clear();
    return tabHandshakeTokens.size;
  };
