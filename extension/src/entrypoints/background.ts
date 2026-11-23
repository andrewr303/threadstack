import {
  ThreadkeeperDB,
  ensureStarterCollectionsAndSettings,
  upsertThread,
  processResumableJobs,
} from '../core/db.js';
import { buildThreadKey, type SettingsRecord } from '../core/schema.js';
import { HistorySyncOrchestrator } from '../core/sync-orchestrator.js';
import { createChromeSyncEnv, createSyncedConversationStore } from '../core/sync-env.js';
import { clampSyncDays, isSyncProviderId, validateSyncEvent, type SyncState } from '../core/history-sync.js';
import { seedSyntheticWorkbenchLibrary } from '../core/synthetic-fixtures.js';
import {
  DOCK_COMMAND_TYPES,
  captureSenderUrl,
  embeddedFrameUrl,
  validateDockPageSender,
  validateRuntimeMessageSender,
  validateWorkspaceSender,
  type EmbedSenderContext,
} from '../core/messaging.js';
import { DockService } from '../core/dock/external.js';
import { requestThreadEnrichment } from '../core/cloud-client.js';
import {
  PROVIDERS,
  detectProviderFromUrl,
  extractConversationIdFromUrl,
  isCapturePageUrl,
  isCaptureProviderId,
  isProviderAllowedOnUrl,
  isProviderId,
  type CaptureProviderId,
  type ProviderId,
} from '../core/providers.js';
import { EXPLICIT_GRANT_MS, decideCapture, newGrantToken, sanitizeCodingFields, type ExplicitGrant } from '../core/capture-gate.js';
import {
  CONTENT_SCRIPT_FILE,
  chromeCaptureScriptEnv,
  matchCustomSite,
  readCustomSites,
  reconcileCaptureScripts,
  type CustomSitesState,
} from '../core/custom-sites.js';
import { createAccountService } from '../core/accounts/service.js';
import { chromeAccountsEnv } from '../core/accounts/chrome-env.js';
import type { AccountService, CaptureAccount, IdentityOutcome } from '../core/accounts/contract.js';
import { ProfileJars } from '../core/accounts/profile-jars.js';
import { realmForProvider, switchableRealms } from '../core/workspace/realms.js';
import {
  EMBED_FRAME_EVENT_TYPES,
  WORKSPACE_COMMAND_TYPES,
  WORKSPACE_PORT_NAME,
  isAgentState,
  signInAttemptId,
  threadAccountId,
  type AgentState,
  type PendingSignIn,
  type WorkspaceBroadcast,
} from '../core/workspace/types.js';
import {
  WorkspaceTabs,
  decideNewTabAdoption,
  handleWorkspaceCommand,
  isManagerTabUrl,
  sanitizeIdentity,
} from '../core/embed/workspace-tabs.js';
import type { EmbedRule, SessionRulesApi } from '../core/embed/rules.js';
import { seedNonceOf, type SeedRule } from '../core/embed/profile-seed.js';
import { ProfileSlots, type SeedRulesApi } from '../core/embed/profile-slots.js';
import { Profiles, realmOfHost, type FrameAccount } from '../core/embed/profiles.js';
import { bridgeGetCookies, bridgeSetCookie, chromeCookiesApi } from '../core/embed/cookie-bridge.js';
import { chromeHelperEnv, helperOpen, helperPing } from '../core/embed/helper.js';
import {
  nextDueAnalysisAt,
  processThreadLocally,
  runAnalysisJobs,
} from '../core/pipeline.js';
import { loadOrganizeContext, type OrganizeContext } from '../core/auto-organize.js';
import { autoHealStaleManifest, readDiskBuildInfo } from '../core/diagnostics.js';
import { BUILD_INFO } from '../core/build-info.js';
import { backupNow, backupStatus, chromeBackupEnv, maybeAutoBackup, restoreFromHelper } from '../core/backup-helper.js';
import {
  PAPERCLIP_SYNC_ALARM,
  PAPERCLIP_SYNC_PERIOD_MINUTES,
  chromeStateStore as paperclipStateStore,
  runPaperclipSync,
  runPaperclipHintSync,
  type SyncOutcome,
} from '../core/paperclip/sync.js';
import { PaperclipLiveHint } from '../core/paperclip/live.js';
import { normalizeServerUrl } from '../core/paperclip/client.js';
import { BRIDGE_KEEPALIVE_ALARM, createManagerActionExecutor, createPaperclipIntegrationRuntime, focusWorkspaceTab } from '../core/paperclip/integration-runtime.js';
import { BridgeActionError } from '../core/paperclip/actions.js';
import type { AgentAction, ActionOutcome } from '../core/paperclip/bridge-protocol.js';
import { SessionObservationLedger } from '../core/paperclip/observations.js';

const db = new ThreadkeeperDB();
const sessionObservations = new SessionObservationLedger();
const observedFrameUrls = new Map<string, string>();

const ANALYSIS_DUE_ALARM = 'tk-analysis-due';
const ANALYSIS_SWEEP_ALARM = 'tk-analysis-sweep';
// Sidebar Dock (Still) link.
const DOCK_DRAIN_ALARM = 'tk-dock-drain';
const DOCK_RECONCILE_ALARM = 'tk-dock-reconcile';
const DOCK_DAILY_ALARM = 'tk-dock-daily';
const DOCK_PAIR_ALARM = 'tk-dock-pair';

let organizeCtxCache: { ctx: OrganizeContext; at: number } | null = null;
let analysisRun: Promise<unknown> | null = null;

// ---- Accounts --------------------------------------------------------------------------------

let accountService: AccountService | null = null;
let accountServiceWarned = false;

/**
 * The one account service. Created on first use (not at import, so this module still loads
 * under tests and in a browser without the cookies API); null when it cannot start.
 */
function accounts(): AccountService | null {
  if (accountService) return accountService;
  try {
    accountService = createAccountService(db, chromeAccountsEnv());
  } catch {
    if (!accountServiceWarned) console.warn('[threadkeeper] account service unavailable');
    accountServiceWarned = true;
    return null;
  }
  return accountService;
}

/**
 * The account a capture of `provider` is filed under right now: the realm's browser account,
 * which keeps settings.boundAccounts' id while it is the primary one. Providers without a login
 * realm (imports, Paperclip, added sites) and any failure fall back to `bound`.
 */
async function resolveCaptureAccount(provider: ProviderId, bound: { accountId: string; workspaceId: string }): Promise<CaptureAccount> {
  const fallback: CaptureAccount = { accountId: bound.accountId, workspaceId: bound.workspaceId, account: null };
  if (!realmForProvider(provider)) return fallback;
  const svc = accounts();
  if (!svc) return fallback;
  try {
    return await svc.resolveForCapture(provider, bound);
  } catch {
    return fallback;
  }
}

/**
 * The account of the page a message came from. A page in a workspace tab's profile slot belongs
 * to that slot's account and to no other: when the slot has no account ready, the answer is null
 * and nothing may be filed (never the browser account's, which the page is not signed in as).
 * Every other page is the realm's browser account, as before.
 */
async function resolveSenderAccount(
  provider: ProviderId,
  bound: { accountId: string; workspaceId: string },
  sender: chrome.runtime.MessageSender,
  embed: EmbedSenderContext | null
): Promise<CaptureAccount | null> {
  const frameUrl = embed ? embeddedFrameUrl(sender, embed) : null;
  const tabId = sender.tab?.id;
  if (frameUrl && typeof tabId === 'number' && typeof sender.frameId === 'number' && realmForProvider(provider)?.switchable) {
    let owner: FrameAccount;
    try {
      owner = await profiles.accountOfFrame(tabId, sender.frameId, frameUrl);
    } catch {
      return null;
    }
    if (owner.kind === 'profile') {
      if (!owner.account) return null;
      return { accountId: threadAccountId(owner.account, bound.accountId), workspaceId: bound.workspaceId, account: owner.account };
    }
  }
  const pending = await accounts()?.pendingSignIn();
  if (pending && pending.realm === realmForProvider(provider)?.id) return null;
  return resolveCaptureAccount(provider, bound);
}

// A switch interrupted when the worker stopped is finished before anything reads the cookies.
if (typeof chrome !== 'undefined' && typeof chrome.cookies?.getAll === 'function') {
  void Promise.resolve()
    .then(() => accounts()?.recover())
    .then(() => retireBrowserAccountSlots())
    .catch(() => console.warn('[threadkeeper] account switch recovery failed'));
}

/** Tell extension pages (the workspace) about accounts and embedded pages. */
function broadcastWorkspace(message: WorkspaceBroadcast): void {
  try {
    void chrome.runtime.sendMessage(message).catch(() => undefined);
  } catch {
    // no listeners open
  }
}

// ---- Profiles: accounts shown next to the browser's own sign-in ------------------------------

function chromeSeedRules(): SeedRulesApi | null {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateSessionRules) return null;
  return {
    getSessionRules: () => chrome.declarativeNetRequest.getSessionRules(),
    updateSessionRules: (options: { removeRuleIds?: number[]; addRules?: SeedRule[] }) =>
      chrome.declarativeNetRequest.updateSessionRules(options as unknown as chrome.declarativeNetRequest.UpdateRuleOptions),
  };
}

const profileSlots = new ProfileSlots({
  store: typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null,
  rules: chromeSeedRules(),
  now: () => Date.now(),
  observesResponses: () => canObserveResponses(),
  isWorkspaceTab: (tabId) => workspaceTabs.has(tabId),
});

/** Tell the workspace an account's sign-in state changed, without any cookie of the browser moving. */
async function announceAccount(accountId: string): Promise<void> {
  try {
    const account = await accounts()?.account(accountId);
    if (!account) return;
    const [entry] = (await accounts()?.list([account.realm])) ?? [];
    broadcastWorkspace({ type: 'ACCOUNTS_CHANGED', realm: account.realm, activeAccountId: entry?.activeAccountId ?? null, switched: false });
  } catch {
    // the page refreshes its accounts on the next change
  }
}

const profileJars = new ProfileJars({
  read: async (accountId) => (await accounts()?.readJar(accountId)) ?? null,
  write: async (accountId, cookies) => {
    await accounts()?.writeJar(accountId, cookies);
  },
  now: () => Date.now(),
  schedule: (fn, ms) => {
    const timer = setTimeout(fn, ms);
    return () => clearTimeout(timer);
  },
  onSignedInChange: (accountId) => void announceAccount(accountId),
});

const profiles = new Profiles({
  accounts,
  slots: profileSlots,
  jars: profileJars,
  hasHostAccess: async (patterns) => {
    if (patterns.length === 0) return false;
    try {
      return await chrome.permissions.contains({ origins: patterns });
    } catch {
      return false;
    }
  },
  now: () => Date.now(),
  randomHex: (length) => {
    const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, length);
  },
  ownOrigin: typeof chrome !== 'undefined' && chrome.runtime?.id ? `chrome-extension://${chrome.runtime.id}` : undefined,
});

/**
 * An account's saved sign-in was replaced behind the partitions seeded from it: retire its slots
 * and tell every workspace page, before the change itself is announced (ACCOUNTS_CHANGED), so no
 * page puts that account's pages back in a partition holding its old cookies.
 */
async function retireProfileAccount(accountId: string): Promise<void> {
  try {
    await profiles.accountReplaced(accountId);
  } finally {
    broadcastWorkspace({ type: 'PROFILE_RETIRED', accountId });
  }
}

/**
 * After a restart: a switch the worker finished on recovery never reached the code that retires
 * slots. A slot whose account is now its realm's browser account holds cookies the browser owns
 * now, so it is retired like any other replaced sign-in.
 */
async function retireBrowserAccountSlots(): Promise<void> {
  const svc = accounts();
  if (!svc) return;
  await profileSlots.ready();
  for (const entry of await svc.list()) {
    const id = entry.activeAccountId;
    if (id && profileSlots.tabsShowing(id).length > 0) await retireProfileAccount(id);
  }
}

/** Requests to the sites of the realms that have accounts: the only ones a profile's cookies come from. */
const PROFILE_URL_PATTERNS = Array.from(new Set(switchableRealms().flatMap((r) => r.cookieDomains.flatMap((d) => [`https://${d}/*`, `https://*.${d}/*`]))));

function canObserveResponses(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.webRequest?.onHeadersReceived?.addListener === 'function';
}

type ResponseListener = (details: chrome.webRequest.WebResponseHeadersDetails) => void;
const responseListeners = new Map<number, ResponseListener>();

/**
 * See the `Set-Cookie` headers of responses to one workspace tab's requests, so each profile's
 * saved jar follows what its pages are given. One listener per workspace tab, filtered to that
 * tab and to the realms' own hosts: ordinary browsing never reaches it. Nothing is modified
 * (this is the observing kind of webRequest listener; Manifest V3 has no other).
 */
function watchWorkspaceTab(tabId: number): void {
  if (!canObserveResponses() || responseListeners.has(tabId) || PROFILE_URL_PATTERNS.length === 0) return;
  const listener: ResponseListener = (details) => {
    if (details.tabId !== tabId) return;
    const setCookies = (details.responseHeaders ?? [])
      .filter((h) => h.name.toLowerCase() === 'set-cookie' && typeof h.value === 'string')
      .map((h) => h.value as string);
    if (setCookies.length === 0 && !seedNonceOf(details.url)) return;
    void profiles
      .onResponse({ tabId, frameId: details.frameId, parentFrameId: details.parentFrameId, url: details.url, setCookies, initiator: details.initiator, type: details.type })
      .catch(() => undefined);
  };
  try {
    chrome.webRequest.onHeadersReceived.addListener(listener, { urls: PROFILE_URL_PATTERNS, tabId }, ['responseHeaders', 'extraHeaders']);
    responseListeners.set(tabId, listener);
  } catch {
    // An older manifest without the permission: profiles work until the page reloads, unsaved.
  }
}

function unwatchWorkspaceTab(tabId: number): void {
  const listener = responseListeners.get(tabId);
  if (!listener) return;
  responseListeners.delete(tabId);
  try {
    chrome.webRequest.onHeadersReceived.removeListener(listener);
  } catch {
    // already gone
  }
}

// A sign-in borrowed from the browser opens the realm's sign-in page in a tab of its own.
const SIGNIN_TAB_KEY = 'tk_signin_tab';
const openingSignInTabs = new Map<string, Promise<void>>();

function signInTabKey(pending: PendingSignIn): string {
  return pending.attemptId ? `${SIGNIN_TAB_KEY}.${pending.attemptId}` : SIGNIN_TAB_KEY;
}

async function signInTabId(pending: PendingSignIn): Promise<number | undefined> {
  const key = signInTabKey(pending);
  const tabId = (await chrome.storage.session.get(key))[key];
  return typeof tabId === 'number' ? tabId : undefined;
}

async function openSignInTab(url: string, pending: PendingSignIn): Promise<void> {
  const key = signInTabKey(pending);
  const opening = openingSignInTabs.get(key);
  if (opening) return opening;
  const isCurrent = async () => {
    const current = await accounts()?.pendingSignIn();
    return current && signInAttemptId(current) === signInAttemptId(pending);
  };
  const run = (async () => {
    if (!(await isCurrent())) return;
    const saved = await signInTabId(pending);
    const existing = saved === undefined ? null : await chrome.tabs.get(saved).catch(() => null);
    if (existing?.id !== undefined) {
      await chrome.tabs.update(existing.id, { active: true });
      await focusWindow(existing.windowId);
      return;
    }
    await reconcileCaptureSites();
    const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
    if (tab.id === undefined) throw new Error('Browser did not return a sign-in tab ID');
    try {
      await chrome.storage.session.set({ [key]: tab.id });
      if (await isCurrent()) await chrome.tabs.update(tab.id, { url });
      else await closeSignInTab(pending);
    } catch (error) {
      await chrome.tabs.remove(tab.id).catch(() => undefined);
      await chrome.storage.session.remove(key).catch(() => undefined);
      throw error;
    }
  })();
  openingSignInTabs.set(key, run);
  try {
    await run;
  } finally {
    openingSignInTabs.delete(key);
  }
}

async function closeSignInTab(pending: PendingSignIn): Promise<void> {
  const stored = await signInTabId(pending);
  await chrome.storage.session.remove(signInTabKey(pending)).catch(() => undefined);
  if (typeof stored !== 'number') return;
  const tab = await chrome.tabs.get(stored).catch(() => null);
  let host: string | null = null;
  try {
    host = new URL(tab?.url || tab?.pendingUrl || '').hostname.toLowerCase();
  } catch {
    host = null;
  }
  if ((!host || realmOfHost(host)?.id !== pending.realm) && tab?.url !== 'about:blank') return;
  await chrome.tabs.remove(stored).catch(() => undefined);
}

/** How long after the site names the person the sign-in is taken over (its last cookies are still arriving). */
const SIGNIN_SETTLE_MS = 2_000;
let finishingSignIn: string | null = null;

/**
 * A sign-in borrowed from the browser ends by itself once the site has named who signed in: the
 * cookies become that account's saved sign-in and the browser's own sign-in is put back. Sites
 * that do not name the person are finished from the workspace ("I've signed in").
 */
function maybeFinishBrowserSignIn(outcome: IdentityOutcome, pending: PendingSignIn): void {
  const svc = accounts();
  const attemptId = signInAttemptId(pending);
  if (!svc || finishingSignIn === attemptId) return;
  const realmId = outcome.realm;
  // Only a report that named the browser's account now counts: not "nobody signed in", not one
  // set aside right after the switch, and not the account that was set aside. A stored
  // "signed in" is no evidence, since the account may have been signed in before it began.
  const named = outcome.named ?? null;
  if (!named || named !== pending.accountId || pending.realm !== realmId) return;
  finishingSignIn = attemptId;
  setTimeout(() => {
    if (finishingSignIn === attemptId) finishingSignIn = null;
    void (async () => {
      const result = await svc.finishBrowserSignIn(attemptId, true);
      if (!result.ok) return;
      await retireProfileAccount(pending.accountId);
      await retireProfileAccount(pending.returnToAccountId);
      const now = result.realms.find((r) => r.realm.id === realmId);
      broadcastWorkspace({ type: 'ACCOUNTS_CHANGED', realm: realmId, activeAccountId: now?.activeAccountId ?? null, switched: true });
      await closeSignInTab(pending);
    })().catch(() => undefined);
  }, SIGNIN_SETTLE_MS);
}

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

// ---------------------------------------------------------------------------
// Paperclip: issues, comments and agent runs from the user's Paperclip server
// ---------------------------------------------------------------------------

let paperclipRun: Promise<SyncOutcome> | null = null;
let paperclipHint: PaperclipLiveHint | null = null;
let paperclipWork: Promise<unknown> = Promise.resolve();
function serializePaperclipWork<T>(task: () => Promise<T>): Promise<T> {
  const run = paperclipWork.then(task, task);
  paperclipWork = run.catch(() => undefined);
  return run;
}

/** Send once to one manager document. An uncertain provider submission is never replayed. */
const executePaperclipAction = createManagerActionExecutor({
  ready: () => workspaceTabs.ready(),
  tabId: () => workspaceTabs.ids()[0],
  sendExecute: (tabId, action) => chrome.tabs.sendMessage(tabId, { type: 'PAPERCLIP_EXECUTE_ACTION', action }, { frameId: 0, ...(workspaceDocuments.has(tabId) ? { documentId: workspaceDocuments.get(tabId)! } : {}) }),
  // The manager stops and reports why; its verdict is awaited briefly instead of being replaced (NF-2).
  sendCancel: (tabId, requestId, reason) => chrome.tabs.sendMessage(tabId, { type: 'PAPERCLIP_CANCEL_ACTION', requestId, reason }, { frameId: 0, ...(workspaceDocuments.has(tabId) ? { documentId: workspaceDocuments.get(tabId)! } : {}) }),
});

const paperclipIntegration = createPaperclipIntegrationRuntime({
  // The bridge sends only the commit part of buildId and detects Edge/Chrome itself (REQ-7 AC-1, D-11).
  db, extensionVersion: BUILD_INFO.version, extensionCommit: BUILD_INFO.buildId,
  alarms: typeof chrome !== 'undefined' && chrome.alarms ? chrome.alarms : undefined,
  observations: sessionObservations,
  executeAction: executePaperclipAction,
  openThread: async (threadKey) => {
    await workspaceTabs.ready();
    const tabId = workspaceTabs.ids()[0];
    if (tabId !== undefined) {
      const answer = await chrome.tabs.sendMessage(tabId, { type: 'PAPERCLIP_OPEN_THREAD', threadKey }, { frameId: 0 }).catch(() => null);
      if (answer?.ok) { await focusWorkspaceTab(chrome as never, tabId); return; }
    }
    await openManagerTab({ threadKey });
  },
  onHint: async (hint) => {
    await serializePaperclipWork(async () => {
      // The bridge does not await this (REQ-12 F-4); the store lets "Last synced" follow hint fetches.
      const keys = await runPaperclipHintSync(hint, { db, store: paperclipStateStore() });
      if (keys.length) {
        organizeCtxCache = null;
        await dock.markDirty(keys);
        broadcastLibraryChanged();
        await scheduleAnalysisAlarm();
      }
    });
  },
  onChange: () => { void ensureStarterCollectionsAndSettings(db).then(refreshPaperclipHint).catch(() => undefined); },
  log: (message) => logSecurity(message),
});

/** One Paperclip sync at a time per service-worker lifetime; later callers share the running one. */
function kickPaperclipSync(options: { force?: boolean; budgetMs?: number; maxIssues?: number } = {}): Promise<SyncOutcome> {
  if (paperclipRun) return paperclipRun;
  paperclipRun = serializePaperclipWork(async () => {
    try {
      const settings = await ensureStarterCollectionsAndSettings(db);
      const outcome = await runPaperclipSync({
        db,
        settings,
        store: paperclipStateStore(),
        force: options.force,
        budgetMs: options.budgetMs,
        maxIssues: options.maxIssues,
        organize: async (threadKeys, s) => {
          const ctx = await getOrganizeContext(s);
          for (const threadKey of threadKeys) {
            const outcome = await processThreadLocally(db, threadKey, { settings: s, ctx });
            if (outcome.createdProject) organizeCtxCache = null;
          }
          // Still link: synced Paperclip threads are pushed like any other organized thread.
          await dock.markDirty(threadKeys).catch(() => undefined);
        },
      });
      if (outcome.threadKeys.length > 0) {
        organizeCtxCache = null;
        broadcastLibraryChanged();
        await scheduleAnalysisAlarm();
      }
      await refreshPaperclipHint(settings);
      // A sync that stopped at its budget continues soon instead of waiting for the next period.
      if (outcome.status === 'partial' && chrome.alarms) {
        await chrome.alarms.create(`${PAPERCLIP_SYNC_ALARM}-continue`, { when: Date.now() + 30_000 });
      }
      return outcome;
    } finally {
      paperclipRun = null;
    }
  });
  return paperclipRun;
}

/** Live events from a local (local_trusted) server schedule a sync sooner; polling covers the rest. */
async function refreshPaperclipHint(settings: SettingsRecord): Promise<void> {
  const pc = settings.paperclip;
  const wanted = pc.enabled && pc.liveUpdates && pc.deploymentMode === 'local_trusted' && !paperclipIntegration.bridge.isConnected();
  if (!wanted) {
    paperclipHint?.close();
    paperclipHint = null;
    return;
  }
  const state = await paperclipStateStore().load();
  const companyIds = Object.keys(state.companies);
  if (companyIds.length === 0) return;
  if (paperclipHint?.isOpen && paperclipHint.matches(pc.serverUrl, companyIds)) return;
  paperclipHint?.close();
  paperclipHint = new PaperclipLiveHint({
    serverUrl: pc.serverUrl,
    companyIds,
    onChange: () => void kickPaperclipSync(),
  });
  paperclipHint.open();
}

/** Sync every few minutes while Paperclip is set up; nothing at all otherwise. */
async function schedulePaperclipAlarm(settings?: SettingsRecord): Promise<void> {
  if (!chrome.alarms) return;
  const s = settings ?? (await ensureStarterCollectionsAndSettings(db));
  if (!s.paperclip.enabled) {
    await chrome.alarms.clear(PAPERCLIP_SYNC_ALARM);
    paperclipHint?.close();
    paperclipHint = null;
    return;
  }
  const existing = await chrome.alarms.get(PAPERCLIP_SYNC_ALARM);
  if (!existing) {
    await chrome.alarms.create(PAPERCLIP_SYNC_ALARM, { delayInMinutes: 0.5, periodInMinutes: PAPERCLIP_SYNC_PERIOD_MINUTES });
  }
}

/** Store a conversation read by Catch up under the run's account (sync-env.ts). */
const storeSyncedConversation = createSyncedConversationStore({
  db,
  loadSettings: () => ensureStarterCollectionsAndSettings(db),
  resolveAccount: (provider, bound) => resolveCaptureAccount(provider, bound),
  organize: organizeStoredThread,
});

const syncOrchestrator = new HistorySyncOrchestrator(
  createChromeSyncEnv(db, {
    loadSettings: () => ensureStarterCollectionsAndSettings(db),
    storeConversation: storeSyncedConversation,
    resolveAccount: async (provider, bound) => {
      const resolved = await resolveCaptureAccount(provider, bound);
      return {
        accountId: resolved.accountId,
        workspaceId: resolved.workspaceId,
        label: resolved.account?.label ?? null,
        // Who the account record says it is: an import runs only when the site names the same person.
        identityKey: resolved.account?.identity?.key ?? null,
      };
    },
    // The same path as a page's own ACCOUNT_IDENTITY report.
    noteIdentity: async (provider, raw) => {
      const identity = sanitizeIdentity(raw);
      const svc = accounts();
      if (!identity || !svc) return;
      const outcome = await svc.noteIdentity(provider, identity);
      if (outcome && (outcome.reassigned || outcome.updated)) {
        // As for a page's own report: the account the browser turned out to be signed in as has
        // its saved sign-in in the browser now, so a profile slot showing it is out of date.
        if (outcome.reassigned && outcome.activeAccountId) await retireProfileAccount(outcome.activeAccountId);
        broadcastWorkspace({ type: 'ACCOUNTS_CHANGED', realm: outcome.realm, activeAccountId: outcome.activeAccountId, switched: false });
      }
    },
    kickAnalysis: () => void kickAnalysis(),
  })
);

/** The state the library shows: the live run, else what was last saved. A run the worker lost is ended as interrupted. */
async function currentSyncState(): Promise<SyncState> {
  return syncOrchestrator.currentState();
}

// A run whose worker was stopped ends here, as soon as the worker starts again, so no page shows
// its last step forever and the analysis it held back is started.
if (typeof chrome !== 'undefined' && chrome.storage?.local) {
  void syncOrchestrator.recover().catch(() => undefined);
}

async function focusWindow(windowId: number | undefined): Promise<void> {
  if (typeof windowId !== 'number' || !chrome.windows?.update) return;
  try {
    await chrome.windows.update(windowId, { focused: true });
  } catch {
    // window closed meanwhile
  }
}

async function openManagerTab(query?: Record<string, string>): Promise<number | undefined> {
  const hasQuery = Boolean(query && Object.keys(query).length > 0);
  const params = new URLSearchParams({ surface: 'page', ...(query ?? {}) });
  const targetUrl = chrome.runtime.getURL(`manager.html?${params.toString()}`);
  const existingTabs = await chrome.tabs.query({ url: `${chrome.runtime.getURL('manager.html')}*` });
  const existing = existingTabs[0];
  if (existing && existing.id !== undefined) {
    // Changing the address reloads the page and with it every embedded site: only for a query.
    const updated = await chrome.tabs.update(existing.id, { active: true, ...(hasQuery ? { url: targetUrl } : {}) });
    await focusWindow(updated?.windowId ?? existing.windowId);
    return existing.id;
  }
  const created = await chrome.tabs.create({ url: targetUrl });
  await focusWindow(created.windowId);
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
      // Every frame: the registered scripts run in all frames too (allFrames in custom-sites.ts).
      await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, files: [CONTENT_SCRIPT_FILE] }).catch(() => undefined);
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
  // Top frame only: content scripts also run in the page's own iframes.
  const ask = () => chrome.tabs.sendMessage(tabId, { type: 'TK_CAPTURE_NOW', explicitToken: token }, { frameId: 0 });
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

// ---- Workspace: manager tabs that embed provider pages ----------------------------------------

const MANAGER_URL = typeof chrome !== 'undefined' && chrome.runtime?.getURL ? chrome.runtime.getURL('manager.html') : '';

function chromeSessionRules(): SessionRulesApi | null {
  if (typeof chrome === 'undefined' || !chrome.declarativeNetRequest?.updateSessionRules) return null;
  return {
    getSessionRules: () => chrome.declarativeNetRequest.getSessionRules(),
    // The enums in @types/chrome are the same strings EmbedRule spells out.
    updateSessionRules: (options: { removeRuleIds?: number[]; addRules?: EmbedRule[] }) =>
      chrome.declarativeNetRequest.updateSessionRules(options as unknown as chrome.declarativeNetRequest.UpdateRuleOptions),
  };
}

const workspaceTabs = new WorkspaceTabs({
  store: typeof chrome !== 'undefined' && chrome.storage?.session ? chrome.storage.session : null,
  rules: chromeSessionRules(),
  protectedDomains: async () => {
    const settings = await ensureStarterCollectionsAndSettings(db);
    const origin = normalizeServerUrl(settings.paperclip.serverUrl);
    // Domain exclusion deliberately covers every port: an uploaded Paperclip document must
    // retain its sandbox even when the server redirects to another local service port.
    return origin ? [new URL(origin).hostname] : [];
  },
  tabUrl: async (tabId) => {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      // The tab is gone.
      return null;
    }
    // Without the "tabs" permission the address of Threadkeeper's own page is not visible.
    return tab.url ?? undefined;
  },
  managerUrl: MANAGER_URL,
});

// A restarted worker checks that the tabs it remembers are still workspace pages, watches the
// ones that are again, and drops the profile slots and seeding rules of the ones that are not.
if (typeof chrome !== 'undefined' && typeof chrome.tabs?.get === 'function') {
  void workspaceTabs
    .prune()
    .then(async () => {
      for (const tabId of workspaceTabs.ids()) watchWorkspaceTab(tabId);
      await profileSlots.prune((tabId) => workspaceTabs.has(tabId));
    })
    .catch(() => undefined);
}

/**
 * The tab closed or stopped being a workspace page: its header rule goes at once. Its profile
 * slots go with it when the tab is gone (`gone`); a page that only reloads clears them itself
 * with its next hello, and clearing them here could land after that page claimed a slot.
 */
async function forgetWorkspaceTab(tabId: number, options: { gone?: boolean } = {}): Promise<void> {
  sessionObservations.forgetTab(tabId);
  for (const key of observedFrameUrls.keys()) if (key.startsWith(`${tabId}:`)) observedFrameUrls.delete(key);
  unwatchWorkspaceTab(tabId);
  await workspaceTabs.forget(tabId);
  if (options.gone) await profileSlots.resetTab(tabId);
  // What its profile pages were given last is saved now rather than when the timer fires.
  await profileJars.flush().catch(() => undefined);
}

// The workspace page keeps a port open for as long as it is showing. It is how the worker knows a
// tab is still a workspace page (the worker cannot read the address of Threadkeeper's own pages),
// so the header rule leaves with the page: when its last port closes (the tab closed, reloaded
// or went to another address), the tab is forgotten and its rule removed. A reloaded page says
// hello and connects again. Regular messages on the port also keep the worker running under a
// page in use, which matters because the worker follows the cookies of profile pages.
const workspacePorts = new Map<number, number>();
/** The document in each workspace tab that said hello last: a newer page in the same tab wins. */
const workspaceDocuments = new Map<number, string>();

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) {
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== WORKSPACE_PORT_NAME) return;
    const sender = port.sender;
    const tabId = sender?.tab?.id;
    if (!sender || typeof tabId !== 'number' || !validateWorkspaceSender('WORKSPACE_PORT', sender, chrome.runtime.id).allowed) {
      port.disconnect();
      return;
    }
    const documentId = (sender as { documentId?: string }).documentId;
    workspacePorts.set(tabId, (workspacePorts.get(tabId) ?? 0) + 1);
    // A page whose hello was answered by a worker that has since stopped is registered again.
    void workspaceTabs.ready().then(async () => {
      if (!workspaceTabs.has(tabId)) await workspaceTabs.hello(tabId);
      watchWorkspaceTab(tabId);
    });
    port.onMessage.addListener(() => {
      // Receiving the message is the point.
    });
    port.onDisconnect.addListener(() => {
      const left = (workspacePorts.get(tabId) ?? 1) - 1;
      if (left > 0) workspacePorts.set(tabId, left);
      else workspacePorts.delete(tabId);
      // A reloaded page may say hello before the old one's port is reported closed: the tab
      // then belongs to the newer page, whose own port will report when it leaves.
      const current = workspaceDocuments.get(tabId);
      if (documentId && current && current !== documentId) return;
      if (left > 0) return;
      workspaceDocuments.delete(tabId);
      void forgetWorkspaceTab(tabId).catch(() => undefined);
    });
  });
}

/** What the sender checks need to recognise a page embedded in a workspace tab. */
async function embedContext(): Promise<EmbedSenderContext & { sites: CustomSitesState }> {
  await workspaceTabs.ready();
  const sites = await readCustomSites(chrome.storage?.local);
  return {
    extensionId: chrome.runtime.id,
    isWorkspaceTab: (tabId) => workspaceTabs.has(tabId),
    isAddedSiteUrl: (url) => matchCustomSite(sites, url) !== null,
    sites,
  };
}

// New windows opened by an embedded page: a provider page is taken back into the workspace as a
// session tab; sign-in popups and everything else are left alone. The address of a new tab
// arrives after onCreated, so the tab is watched for a few seconds.
const ADOPTION_WAIT_MS = 5_000;
const pendingAdoptions = new Map<number, { workspaceTabId: number; timer: ReturnType<typeof setTimeout> }>();

function dropPendingAdoption(tabId: number): { workspaceTabId: number } | null {
  const pending = pendingAdoptions.get(tabId);
  if (!pending) return null;
  clearTimeout(pending.timer);
  pendingAdoptions.delete(tabId);
  return pending;
}

async function considerAdoption(tabId: number, url: string | undefined): Promise<void> {
  if (!pendingAdoptions.has(tabId)) return;
  // The window type is not known yet; 'normal' only asks whether the address is worth checking.
  if (decideNewTabAdoption({ openerIsWorkspace: true, url, windowType: 'normal' }) === 'wait') return;
  const pending = dropPendingAdoption(tabId);
  if (!pending || !url) return;
  let windowType: string | undefined;
  try {
    const tab = await chrome.tabs.get(tabId);
    windowType = (await chrome.windows.get(tab.windowId)).type;
  } catch {
    return;
  }
  if (decideNewTabAdoption({ openerIsWorkspace: true, url, windowType }) !== 'adopt') return;
  // An opener is no proof an embedded page opened the tab: Chrome also names the active tab as
  // the opener of a tab made with Cmd/Ctrl+T and of every tab chrome.tabs.create opens. Only the
  // workspace page knows whether one of its pages was just clicked, so the tab is closed only
  // when that page says it took the address in (manager/workspace/adoption.ts).
  if (!(await workspaceAdopts(pending.workspaceTabId, url))) return;
  await chrome.tabs.remove(tabId).catch(() => undefined);
  await chrome.tabs.update(pending.workspaceTabId, { active: true }).catch(() => undefined);
}

/** How long the workspace page has to answer before the new tab is left open. */
const ADOPTION_ANSWER_MS = 2_000;

async function workspaceAdopts(workspaceTabId: number, url: string): Promise<boolean> {
  const request: WorkspaceBroadcast = { type: 'EMBED_OPEN_REQUEST', tabId: workspaceTabId, url };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      chrome.runtime.sendMessage(request) as Promise<unknown>,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), ADOPTION_ANSWER_MS);
      }),
    ]);
    return (answer as { adopted?: unknown } | undefined)?.adopted === true;
  } catch {
    // no workspace page listening
    return false;
  } finally {
    clearTimeout(timer);
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onCreated) {
  chrome.tabs.onCreated.addListener((tab) => {
    const opener = tab.openerTabId;
    const tabId = tab.id;
    if (typeof opener !== 'number' || typeof tabId !== 'number') return;
    void (async () => {
      await workspaceTabs.ready();
      if (!workspaceTabs.has(opener)) return;
      const timer = setTimeout(() => pendingAdoptions.delete(tabId), ADOPTION_WAIT_MS);
      pendingAdoptions.set(tabId, { workspaceTabId: opener, timer });
      // The address may have arrived while the remembered tabs were loading.
      const current = await chrome.tabs.get(tabId).catch(() => tab);
      await considerAdoption(tabId, current.url || current.pendingUrl);
    })();
  });
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onUpdated) {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (pendingAdoptions.has(tabId)) void considerAdoption(tabId, tab.url || changeInfo.url);
    if (changeInfo.url === undefined && changeInfo.status !== 'loading') return;
    // A workspace tab that navigated away from manager.html loses its header rule at once.
    void (async () => {
      await workspaceTabs.ready();
      // Chrome reports a frame of the page loading as the tab loading, without the address of
      // Threadkeeper's own page (no "tabs" permission). Only an address seen to be another
      // page's means the tab left; the page's own connection reports the rest (below).
      const url = tab.url ?? changeInfo.url;
      if (workspaceTabs.has(tabId) && typeof url === 'string' && !isManagerTabUrl(url, MANAGER_URL)) await forgetWorkspaceTab(tabId, { gone: true });
    })();
  });
}

// Embedded coding-agent pages report what their controls show. Written at most once per thread
// per AGENT_STATE_MIN_MS and only when it changed; the newest state inside the window is kept
// and written when the window ends.
const AGENT_STATE_MIN_MS = 5_000;
const agentStateWrites = new Map<string, { at: number; pending?: AgentState; timer?: ReturnType<typeof setTimeout> }>();

async function writeAgentState(threadKey: string, state: AgentState): Promise<void> {
  const record = await db.conversations.get(threadKey);
  if (!record || record.agentState === state) return;
  await db.conversations.update(threadKey, { agentState: state, agentStateAt: new Date().toISOString() });
  agentStateWrites.delete(threadKey);
  agentStateWrites.set(threadKey, { at: Date.now() });
  if (agentStateWrites.size > 500) agentStateWrites.delete(agentStateWrites.keys().next().value as string);
  broadcastLibraryChanged(threadKey);
}

async function noteAgentState(frameUrl: string, state: AgentState, sender: chrome.runtime.MessageSender, embed: EmbedSenderContext): Promise<void> {
  const provider = detectProviderFromUrl(frameUrl);
  if (!provider || !isCaptureProviderId(provider) || !isProviderAllowedOnUrl(provider, frameUrl)) return;
  const conversationId = extractConversationIdFromUrl(frameUrl);
  if (!conversationId) return;
  const settings = await ensureStarterCollectionsAndSettings(db);
  const resolved = await resolveSenderAccount(provider, settings.boundAccounts[provider], sender, embed);
  if (!resolved) return;
  const threadKey = buildThreadKey({
    provider,
    accountId: resolved.accountId,
    workspaceId: resolved.workspaceId,
    sourceConversationId: conversationId,
    branchId: 'main',
  });
  if (typeof sender.tab?.id === 'number' && typeof sender.frameId === 'number') {
    sessionObservations.observe({ tabId: sender.tab.id, frameId: sender.frameId, threadKey, state });
    observedFrameUrls.set(`${sender.tab.id}:${sender.frameId}`, frameUrl);
  }
  const last = agentStateWrites.get(threadKey);
  const elapsed = last ? Date.now() - last.at : Infinity;
  if (last && elapsed < AGENT_STATE_MIN_MS) {
    last.pending = state;
    last.timer ??= setTimeout(() => {
      const entry = agentStateWrites.get(threadKey);
      const next = entry?.pending;
      if (entry) entry.timer = undefined;
      if (entry && next) {
        entry.pending = undefined;
        void writeAgentState(threadKey, next).catch(() => undefined);
      }
    }, AGENT_STATE_MIN_MS - elapsed);
    return;
  }
  await writeAgentState(threadKey, state);
}

/** EMBED_FRAME_EVENT_TYPES, after validateRuntimeMessageSender let the sender through. */
async function handleEmbedEvent(
  message: Record<string, unknown> & { type: string },
  sender: chrome.runtime.MessageSender,
  ctx: EmbedSenderContext
): Promise<unknown> {
  // The address always comes from chrome's sender object, never from the message.
  const frameUrl = embeddedFrameUrl(sender, ctx);
  const tabId = sender.tab?.id;
  const frameId = sender.frameId;
  // ACCOUNT_IDENTITY may come from a provider's own tab; it reads no address below.
  if (message.type === 'ACCOUNT_IDENTITY') {
    const identity = sanitizeIdentity(message.identity);
    if (identity === undefined || !isProviderId(message.provider)) return { ok: false, error: 'Identity not recognised.' };
    const svc = accounts();
    if (!svc) return { ok: true };
    try {
      // A page in a profile slot names that slot's account, and only that one. It says nothing
      // about who the browser itself is signed in as.
      if (frameUrl && typeof tabId === 'number' && typeof frameId === 'number') {
        const owner = await profiles.accountOfFrame(tabId, frameId, frameUrl);
        if (owner.kind === 'profile') {
          if (owner.account) {
            const outcome = await svc.noteProfileIdentity(owner.account.id, identity);
            if (outcome?.updated) await announceAccount(owner.account.id);
          }
          return { ok: true };
        }
      }
      const pending = await svc.pendingSignIn();
      const attempt = pending && sender.frameId === 0 && typeof tabId === 'number' && tabId === await signInTabId(pending)
        ? pending
        : undefined;
      const outcome = await svc.noteIdentity(message.provider, identity, attempt);
      if (outcome && (outcome.reassigned || outcome.updated)) {
        // The browser is now signed in as another known account. Its saved jar went into the
        // browser, so the worker's copy of it is stale. Workspace pages re-place their frames by
        // themselves; nothing is reloaded for a sign-in that happened in another tab.
        if (outcome.reassigned && outcome.activeAccountId) await retireProfileAccount(outcome.activeAccountId);
        broadcastWorkspace({ type: 'ACCOUNTS_CHANGED', realm: outcome.realm, activeAccountId: outcome.activeAccountId, switched: false });
      }
      if (outcome && attempt) maybeFinishBrowserSignIn(outcome, attempt);
    } catch {
      // the next report tries again
    }
    // The page learns nothing about accounts from the answer.
    return { ok: true };
  }
  if (!frameUrl || typeof tabId !== 'number' || typeof frameId !== 'number') {
    return { ok: false, error: 'Not a page embedded in Threadkeeper.', code: 'not_allowed' };
  }
  // What kind of frame this is, as its own content script read it: said with the first message
  // of every document, before the page has run.
  const hint = typeof message.profile === 'boolean' ? message.profile : undefined;
  if (hint !== undefined) await profiles.frameSeen(tabId, frameId, hint).catch(() => undefined);
  switch (message.type) {
    case 'EMBED_HELLO':
      sessionObservations.forgetFrame(tabId, frameId);
      observedFrameUrls.set(`${tabId}:${frameId}`, frameUrl);
      return { ok: true, frameId, tabId };
    case 'EMBED_NAV':
      if (observedFrameUrls.get(`${tabId}:${frameId}`) !== frameUrl) sessionObservations.forgetFrame(tabId, frameId);
      observedFrameUrls.set(`${tabId}:${frameId}`, frameUrl);
      // The workspace page receives the same message and reads sender.frameId itself.
      return { ok: true };
    case 'EMBED_AGENT_STATE':
      if (!isAgentState(message.state)) return { ok: false, error: 'Unknown agent state.' };
      await noteAgentState(frameUrl, message.state, sender, ctx).catch(() => undefined);
      return { ok: true };
    case 'EMBED_COOKIES_GET': {
      const owner = await profiles.accountOfFrame(tabId, frameId, frameUrl, hint);
      if (owner.kind === 'plain') return bridgeGetCookies(chromeCookiesApi(), frameUrl);
      // A profile page reads its own account's cookies; the browser's are another person's.
      if (!owner.account) return { ok: true, cookie: '' };
      return { ok: true, cookie: await profileJars.scriptCookieString(owner.account.id, frameUrl) };
    }
    case 'EMBED_COOKIE_SET': {
      const owner = await profiles.accountOfFrame(tabId, frameId, frameUrl, hint);
      if (owner.kind === 'plain') return bridgeSetCookie(chromeCookiesApi(), frameUrl, message.cookie, Date.now());
      if (!owner.account) return { ok: false, error: 'Cookies are not available for this page.' };
      return profileJars.applyScript(owner.account.id, message.cookie, frameUrl);
    }
    default:
      return { ok: false, error: `Unknown ${message.type}`, code: 'not_allowed' };
  }
}

/**
 * What the library needs to offer "Switch account" when a thread belongs to another account of
 * the provider's realm than the one signed in now.
 */
async function accountSwitchInfo(
  provider: ProviderId,
  bound: { accountId: string; workspaceId: string },
  active: CaptureAccount,
  threadAccount: unknown
): Promise<{ realm: string | null; activeAccountId: string | null; switchToAccountId: string | null }> {
  const realm = realmForProvider(provider);
  const svc = accounts();
  const base = { realm: realm?.id ?? null, activeAccountId: active.account?.id ?? null, switchToAccountId: null };
  if (!realm || !svc || typeof threadAccount !== 'string') return base;
  try {
    const [info] = await svc.list([realm.id]);
    const owner = info?.accounts.find((a) => threadAccountId(a, bound.accountId) === threadAccount);
    return { ...base, activeAccountId: info?.activeAccountId ?? base.activeAccountId, switchToAccountId: owner?.id ?? null };
  } catch {
    return base;
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void deleteTabHandshake(tabId);
    explicitGrants.delete(tabId);
    void forgetWorkspaceTab(tabId, { gone: true });
    dropPendingAdoption(tabId);
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
      // Top frame only: content scripts also run in the page's own iframes.
      const resp = (await chrome.tabs.sendMessage(
        tabId,
        { type: 'TOGGLE_THREADKEEPER_OVERLAY', invocationSource, handshakeToken },
        { frameId: 0 }
      )) as { state?: 'opened' | 'closed' } | undefined;
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
        const resp = (await chrome.tabs.sendMessage(
          tabId,
          { type: 'TOGGLE_THREADKEEPER_OVERLAY', invocationSource, handshakeToken },
          { frameId: 0 }
        )) as { state?: 'opened' | 'closed' } | undefined;
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
  await schedulePaperclipAlarm(settings);
  // Starts the bridge and keeps its own alarm while any company is paired (REQ-7 finding 5).
  await paperclipIntegration.keepAlive();
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

// The worker (the only bridge context; reads are served here, not by the manager page) is going away:
// tell Paperclip at once so agents get browser_offline instead of waiting 40 s (REQ-8 AC-13, NF-3).
// Best effort, non-revoking; a plugin without the route answers 404, which is ignored.
if (typeof chrome !== 'undefined' && chrome.runtime?.onSuspend) {
  chrome.runtime.onSuspend.addListener(() => { void paperclipIntegration.bridge.signalOffline(); });
}

if (typeof chrome !== 'undefined' && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'threadkeeper-resumable-jobs') {
      // Library backup to disk through the Mac helper: only when the library changed and the
      // last backup is old enough (backup-helper.ts); a quick no-op otherwise.
      void maybeAutoBackup(db, chromeBackupEnv(BUILD_INFO.version));
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
    } else if (alarm.name === PAPERCLIP_SYNC_ALARM || alarm.name === `${PAPERCLIP_SYNC_ALARM}-continue`) {
      void kickPaperclipSync();
      void paperclipIntegration.keepAlive().catch(() => undefined);
    } else if (alarm.name === BRIDGE_KEEPALIVE_ALARM) {
      // Wakes an evicted worker and restarts the bridge, independent of library sync.
      void paperclipIntegration.keepAlive().catch(() => undefined);
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void (async () => {
      const type = typeof message?.type === 'string' ? message.type : '';
      // Pages embedded in a workspace tab are recognised from the remembered tabs and added sites.
      const embed =
        EMBED_FRAME_EVENT_TYPES.has(type) || type === 'PASSIVE_DOM_CAPTURE' || type === 'GET_CAPTURE_SITE' || type === 'GET_CAPTURE_AUTH_STATE'
          ? await embedContext()
          : null;
      const validation = validateRuntimeMessageSender(
        message,
        sender,
        chrome.runtime.id,
        embed ?? undefined
      );
      if (!validation.allowed) {
        securityRejectionLog.push({
          timestamp: new Date().toISOString(),
          reason: validation.reason ?? 'Rejected runtime message',
        });
        sendResponse({ ok: false, error: validation.reason });
        return;
      }

      // Workspace commands: the sender is Threadkeeper's manager page as a top-level tab.
      if (type === 'PAPERCLIP_INTEGRATION' || type === 'PAPERCLIP_SERVICE_STATUS' || type === 'PAPERCLIP_SERVICE_START' || type === 'PAPERCLIP_SERVICE_INSTALL') {
        if (type === 'PAPERCLIP_INTEGRATION' && message.action === 'frame_gone') {
          const frameId = message.payload?.frameId;
          if (!Number.isSafeInteger(frameId) || frameId <= 0 || typeof sender.tab?.id !== 'number') {
            sendResponse({ ok: false, error: 'Invalid embedded frame' }); return;
          }
          sessionObservations.forgetFrame(sender.tab.id, frameId);
          observedFrameUrls.delete(`${sender.tab.id}:${frameId}`);
          sendResponse({ ok: true, data: { forgotten: true } }); return;
        }
        try { sendResponse(await paperclipIntegration.handle(message)); }
        catch (error) {
          // The code (never a value) lets manager-side model-key callers tell a missing secret from an outage.
          const code = error && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string' ? (error as { code: string }).code.slice(0, 40) : undefined;
          sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Paperclip request failed', ...(code ? { code } : {}) });
        }
        return;
      }
      if (type === 'BACKUP_STATUS' || type === 'BACKUP_NOW' || type === 'BACKUP_RESTORE') {
        const backupEnv = chromeBackupEnv(BUILD_INFO.version);
        try {
          if (type === 'BACKUP_STATUS') sendResponse(await backupStatus(db, backupEnv));
          else if (type === 'BACKUP_NOW') sendResponse(await backupNow(db, backupEnv));
          else sendResponse(await restoreFromHelper(db, backupEnv, message.name));
        } catch {
          sendResponse({ ok: false, error: 'Threadkeeper could not reach its backups. Try again.' });
        }
        return;
      }
      if (WORKSPACE_COMMAND_TYPES.has(type) && typeof sender.tab?.id === 'number') {
        const documentId = (sender as { documentId?: string }).documentId;
        if (type === 'WORKSPACE_HELLO' && documentId) workspaceDocuments.set(sender.tab.id, documentId);
        sendResponse(
          await handleWorkspaceCommand(message, sender.tab.id, {
            accounts: accounts(),
            tabs: workspaceTabs,
            helperPing: () => helperPing(chromeHelperEnv()),
            helperOpen: (account, url) => helperOpen(chromeHelperEnv(), account, url),
            broadcast: broadcastWorkspace,
            profiles: {
              available: canObserveResponses(),
              claim: (tabId, realmId, accountId, move) => {
                watchWorkspaceTab(tabId);
                return profiles.claim(tabId, realmId, accountId, move);
              },
              ready: (tabId, realmId) => profiles.markReady(tabId, realmId),
              reset: async (tabId) => {
                await profileSlots.resetTab(tabId);
                watchWorkspaceTab(tabId);
              },
              accountReplaced: (accountId) => retireProfileAccount(accountId),
              flush: (accountId) => profiles.flush(accountId),
            },
            openSignInTab,
            closeSignInTab,
          })
        );
        return;
      }

      if (EMBED_FRAME_EVENT_TYPES.has(type) && embed) {
        sendResponse(await handleEmbedEvent(message, sender, embed));
        return;
      }

      if (message.type === 'GET_CAPTURE_AUTH_STATE') {
        const settings = await ensureStarterCollectionsAndSettings(db);
        const provider = message.provider as CaptureProviderId;
        const authorized = Boolean(settings.authorizedHosts[provider]);
        const bound = isProviderId(provider) ? ((await resolveSenderAccount(provider, settings.boundAccounts[provider], sender, embed)) ?? undefined) : undefined;
        sendResponse({
          ok: true,
          authorized,
          boundAccount: bound ? { accountId: bound.accountId, workspaceId: bound.workspaceId } : undefined,
        });
        return;
      }

      if (message.type === 'GET_CAPTURE_SITE') {
        // The content script on a page no provider owns asks whether the user added this site.
        const pageUrl = captureSenderUrl(sender, embed);
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
          sites: embed?.sites ?? (await readCustomSites(chrome.storage?.local)),
          grant: typeof tabId === 'number' ? explicitGrants.get(tabId) : null,
          now: Date.now(),
          embed,
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
        // Filed under the account of the page it came from: the profile a workspace page shows,
        // else the account the browser is signed in to for the provider's realm.
        const bound = await resolveSenderAccount(provider, settings.boundAccounts[provider], sender, embed);
        if (!bound) {
          // A profile page whose account is not known: nothing is filed, least of all under
          // the browser's account, which that page is not signed in as.
          settleExplicitWaiter(tabId, message.explicitToken, { ok: false, error: 'Threadkeeper could not tell which account this page belongs to.' });
          sendResponse({ ok: false, skipped: 'no_account' });
          return;
        }
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
        // Repository, pull request, branch and agent state reach the library only once validated.
        const coding = sanitizeCodingFields(message.payload);
        const result = await upsertThread(db, {
          ...message.payload,
          repository: coding.repository,
          pullRequestUrl: coding.pullRequestUrl,
          gitBranch: coding.gitBranch,
          agentState: coding.agentState,
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
        }
        // A tab-by-tab import waits for this capture: tell it which account it was filed under (it
        // stops if that is not the run's) and that a thread the person deleted stays deleted.
        if (!decision.embedded && typeof sender.tab?.id === 'number' && Array.isArray(message.payload.messages)) {
          syncOrchestrator.noteCapture(
            sender.tab.id,
            message.payload.sourceConversationId,
            message.payload.messages.length,
            { accountId: bound.accountId, workspaceId: bound.workspaceId },
            result.status === 'stored' ? 'stored' : 'deleted'
          );
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
        const settings = await ensureStarterCollectionsAndSettings(db);
        await reconcileCaptureSites(settings);
        // Excluded providers may have changed: take back what Still may no longer hold.
        await dock.syncNow({ privacy: true }).catch(() => undefined);
        await schedulePaperclipAlarm(settings);
        await refreshPaperclipHint(settings);
        for (const tabId of workspaceTabs.ids()) await workspaceTabs.hello(tabId);
        void paperclipIntegration.bridge.tick().catch(() => undefined);
        sendResponse({ ok: true });
        return;
      }

      if (message.type === 'PAPERCLIP_SYNC_NOW') {
        // Sync now: ignores the failure backoff and gets a larger budget than the periodic sync.
        const outcome = await kickPaperclipSync({ force: true, budgetMs: 240_000, maxIssues: 1000 });
        sendResponse({ ok: outcome.status !== 'error', outcome });
        return;
      }

      if (message.type === 'HISTORY_SYNC_EVENT') {
        const event = validateSyncEvent(message.event);
        // A false answer tells a reader whose run has ended (or never was) to stop reading.
        const accepted = event ? await syncOrchestrator.handleEvent(event, sender.tab?.id) : false;
        sendResponse({ ok: accepted });
        return;
      }

      if (
        message.type === 'START_HISTORY_SYNC' ||
        message.type === 'CANCEL_HISTORY_SYNC' ||
        message.type === 'GET_HISTORY_SYNC_STATE'
      ) {
        // Catch up opens tabs and reads signed-in sessions: only the library's own pages may start it,
        // never an overlay frame inside a website (nor one inside a page embedded in the workspace).
        if (
          typeof sender.tab?.id === 'number' &&
          (!(sender.tab.url ?? '').startsWith('chrome-extension://') || (typeof sender.frameId === 'number' && sender.frameId !== 0))
        ) {
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
        const started = await syncOrchestrator.start({ providers, days: clampSyncDays(message.days), scope: message.scope === 'all' ? 'all' : 'recent' });
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

      // A manager frame inside a website, or inside a page embedded in a workspace tab (whose tab
      // URL is Threadkeeper's own): either way a page Threadkeeper does not control frames it.
      const isEmbeddedInHostTab =
        typeof sender.tab?.id === 'number' &&
        (!(sender.tab.url ?? '').startsWith('chrome-extension://') || (typeof sender.frameId === 'number' && sender.frameId !== 0));

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
        // Compare the thread's account with the one signed in to the realm now, not the bound one.
        const active = bound && isProviderId(requestedProvider) ? await resolveCaptureAccount(requestedProvider, bound) : undefined;
        if (
          bound &&
          active &&
          isProviderId(requestedProvider) &&
          (active.accountId !== message.expectedAccountId ||
            active.workspaceId !== message.expectedWorkspaceId) &&
          !message.forceOpen
        ) {
          sendResponse({
            ok: false,
            status: 'account_mismatch',
            boundAccount: { accountId: active.accountId, workspaceId: active.workspaceId },
            expectedAccount: {
              accountId: message.expectedAccountId,
              workspaceId: message.expectedWorkspaceId,
            },
            // For "Switch account": the realm, who is signed in, and the account the thread belongs to.
            ...(await accountSwitchInfo(requestedProvider, bound, active, message.expectedAccountId)),
          });
          return;
        }
        // Paperclip usually runs on this computer over plain http; only its own configured origin is allowed.
        const paperclipOrigin =
          message.provider === 'paperclip' ? normalizeServerUrl(settings.paperclip.serverUrl) : null;
        const isPaperclipPage =
          typeof message.canonicalUrl === 'string' &&
          paperclipOrigin !== null &&
          normalizeServerUrl(message.canonicalUrl) === paperclipOrigin &&
          message.canonicalUrl.startsWith(`${paperclipOrigin}/`);
        if (typeof message.canonicalUrl !== 'string' || (!/^https:\/\//i.test(message.canonicalUrl) && !isPaperclipPage)) {
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
          const closeResp = (await chrome.tabs.sendMessage(
            targetTabId,
            { type: 'CLOSE_THREADKEEPER_OVERLAY', handshakeToken: message.handshakeToken },
            { frameId: 0 }
          )) as { ok?: boolean; error?: string } | undefined;
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
