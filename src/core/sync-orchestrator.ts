import {
  EMPTY_SYNC_STATE,
  SYNC_MAX_API,
  clampSyncDays,
  describeSyncError,
  initialSyncState,
  isFinishedStatus,
  sidebarLimit,
  syncCutoffMs,
  syncProviderInfo,
  updateProvider,
  type SyncErrorCode,
  type SyncEvent,
  type SyncProviderId,
  type SyncProviderInfo,
  type SyncProviderState,
  type SyncRequest,
  type SyncState,
  type SyncStepErrorCode,
} from './history-sync.js';
import type { SiteConversation } from './site-api.js';
import type { SidebarConversation } from './sidebar-history.js';
import type { AccountIdentity } from './workspace/types.js';

/**
 * Runs Catch up from the service worker: for each site, find or open a tab, start the page-side
 * reader, store what it reports, and keep a progress state the library can show.
 *
 * Everything that touches the browser or the database goes through SyncEnv, so a whole run can be
 * driven by a test with fakes.
 *
 * Every wait is bounded. A step that does not finish in time fails that site with a reason naming
 * the step, and the run moves on to the next site; a cancel ends whatever is being waited on at
 * once. The state is saved at every step change, so a page never shows a step the worker has left.
 */

/** The account a site's threads are filed under for a whole run. */
export interface SyncAccount {
  accountId: string;
  workspaceId: string;
  /** The account's label, shown next to the site's progress; null when there is none. */
  label: string | null;
}

/** What the page-side identity check found (see site-history.ts readSignedInIdentity). */
export type SyncIdentityReply =
  | { status: 'signed_in'; identity: Omit<AccountIdentity, 'observedAt'> }
  | { status: 'signed_out' }
  | { status: 'unknown' };

export interface SyncTabInfo {
  url: string | null;
  title: string | null;
}

export interface SyncEnv {
  now(): number;
  newRunId(): string;
  sleep(ms: number): Promise<void>;
  /** A timer the orchestrator can cancel; resolves after `ms`. */
  timeout(ms: number): { promise: Promise<void>; cancel(): void };
  findTab(info: SyncProviderInfo): Promise<number | null>;
  /** Opens a tab in the background (never steals focus) and returns its id. */
  openTab(url: string): Promise<number>;
  closeTab(tabId: number): Promise<void>;
  waitTabReady(tabId: number, timeoutMs: number): Promise<boolean>;
  /** True when the page-side reader answers, injecting it if the tab predates the extension. */
  ensureContentScript(tabId: number): Promise<boolean>;
  sendToTab(tabId: number, message: unknown): Promise<unknown>;
  /** Providers whose capture the user has not switched off. */
  enabledProviders(): Promise<ReadonlySet<string>>;
  /** Conversations of this provider already stored in full, in this account: site id → site updatedAt. */
  knownUpdatedAt(provider: SyncProviderId, account?: SyncAccount | null): Promise<Record<string, string>>;
  /** Store a conversation under `account` (the run's account); without one, the realm's active account. */
  storeConversation(conversation: SiteConversation, account?: SyncAccount | null): Promise<'stored' | 'skipped'>;
  /** Captured within the last few hours, in this account; the tab-by-tab way skips these. */
  hasRecentCapture(provider: SyncProviderId, sourceConversationId: string, account?: SyncAccount | null): Promise<boolean>;
  saveState(state: SyncState): Promise<void>;

  // Optional: a test may leave these out; the service worker provides them all.
  /** The tab's address and title, or null when it is gone (or cannot be read). */
  tabInfo?(tabId: number): Promise<SyncTabInfo | null>;
  /** Whether the extension may read the site at all (optional host permissions). */
  hasHostAccess?(info: SyncProviderInfo): Promise<boolean>;
  /** Pass on who the site says is signed in, so the accounts service files under that person. */
  noteIdentity?(provider: SyncProviderId, identity: Omit<AccountIdentity, 'observedAt'>): Promise<void>;
  /** The account captures of this provider are filed under right now. */
  resolveAccount?(provider: SyncProviderId): Promise<SyncAccount>;
  /** The last saved state, for a worker that has just started. */
  loadState?(): Promise<SyncState | null>;
  /** Hold hosted analysis while a run is active (see analysis-hold.ts). */
  holdAnalysis?(runId: string): Promise<void>;
  touchAnalysisHold?(runId: string): Promise<void>;
  /** End the hold and start the analysis that waited for it; returns how many threads that is. */
  releaseAnalysis?(runId: string | null): Promise<number>;
}

/** A page that has sent nothing for this long has stalled. */
export const SYNC_IDLE_TIMEOUT_MS = 120_000;
/** How often a run that waits for the page checks that its tab still exists. */
export const SYNC_TAB_CHECK_MS = 15_000;
export const TAB_READY_TIMEOUT_MS = 30_000;
/** Ceilings for each kind of step; a step that takes longer is abandoned with a plain reason. */
export const STEP_TIMEOUTS = {
  /** Browser calls that answer at once unless something is wrong (tabs, permissions, storage). */
  browser: 10_000,
  /** Database reads and writes. */
  database: 30_000,
  /** Injecting the reader and hearing it answer. */
  reader: 15_000,
  /** The site's own "who is signed in" request, made by the page. */
  identity: 20_000,
  /** Reading the list of a tab-by-tab site, which scrolls it to load more. */
  sidebarList: 30_000,
  sidebarListAll: 180_000,
} as const;
const SIDEBAR_CAPTURE_TIMEOUT_MS = 25_000;
const SIDEBAR_PAUSE_MS = 900;
/** Conversations in a row that open but never get captured: the site is not showing them. */
const SIDEBAR_MAX_CONSECUTIVE_FAILURES = 3;
const SAVE_INTERVAL_MS = 400;
const HOLD_TOUCH_MS = 30_000;

/** Pages a signed-out visitor is sent to, and the titles of bot checks shown instead of the app. */
const LOGIN_PATH = /\/(?:auth\/)?(?:login|log-in|signin|sign-in|logout)(?:[/?#]|$)/i;
const CHALLENGE_TITLE = /just a moment|attention required|verify you are human|access denied|checking your browser/i;

/** Whether `hostname` is one of the site's own hosts (its match patterns, `*.` wildcards included). */
function onSiteHost(info: SyncProviderInfo, hostname: string): boolean {
  const host = hostname.toLowerCase();
  return info.hostPatterns.some((pattern) => {
    const m = pattern.match(/^[a-z*]+:\/\/([^/]+)\//i);
    if (!m) return false;
    const want = m[1].toLowerCase();
    if (want === '*') return true;
    if (want.startsWith('*.')) return host === want.slice(2) || host.endsWith(want.slice(1));
    return host === want;
  });
}

class StepFailure extends Error {
  constructor(readonly code: SyncErrorCode | SyncStepErrorCode) {
    super(code);
  }
}

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

interface ActiveRun {
  runId: string;
  provider: SyncProviderId;
  tabId: number;
  lastEventAt: number;
  account: SyncAccount | null;
  finish: (outcome: 'done' | 'error') => void;
}

const sameAccount = (a: SyncAccount | null, b: SyncAccount | null) =>
  a === null || b === null || (a.accountId === b.accountId && a.workspaceId === b.workspaceId);

export class HistorySyncOrchestrator {
  state: SyncState = EMPTY_SYNC_STATE;
  private cancelled = false;
  private cancelWaiters = new Set<() => void>();
  private active: ActiveRun | null = null;
  private running: Promise<void> | null = null;
  private lastSavedAt = 0;
  private lastHoldTouchAt = 0;
  private captureWaiters = new Map<number, { conversationId: string; resolve: (ok: boolean) => void }>();

  constructor(private readonly env: SyncEnv) {}

  isRunning(): boolean {
    return this.running !== null;
  }

  /** Resolves when the current run has finished (tests, and callers that want to wait). */
  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  /** Begin a run in the background. Returns at once; progress is in `state`. */
  async start(request: SyncRequest): Promise<{ started: boolean; reason?: string }> {
    if (this.running) return { started: false, reason: 'Catch up is already running.' };
    const enabled = await this.env.enabledProviders();
    const scope = request.scope === 'all' ? 'all' : 'recent';
    const providers = request.providers.filter((id, i, all) => all.indexOf(id) === i && syncProviderInfo(id) && enabled.has(id)
      && (scope !== 'all' || syncProviderInfo(id)?.allHistory === true));
    if (providers.length === 0) return { started: false, reason: 'No site to catch up on is switched on for capture.' };
    // Sites with a complete history first: they finish fastest and cost the site least.
    providers.sort((a, b) => Number(syncProviderInfo(a)?.strategy !== 'api') - Number(syncProviderInfo(b)?.strategy !== 'api'));

    this.cancelled = false;
    const days = clampSyncDays(request.days);
    this.state = initialSyncState(this.env.newRunId(), { providers, days, scope }, new Date(this.env.now()).toISOString());
    const runId = this.state.runId ?? '';
    // Hosted analysis waits for the whole run: it would compete with the import for the worker
    // and bill threads that are still arriving.
    await this.env.holdAnalysis?.(runId).catch(() => undefined);
    this.lastHoldTouchAt = this.env.now();
    await this.save(true);
    this.running = this.runAll(providers, days).finally(() => {
      this.running = null;
    });
    return { started: true };
  }

  cancel(): void {
    this.cancelled = true;
    if (this.active) {
      void this.env.sendToTab(this.active.tabId, { type: 'TK_HISTORY_SYNC_CANCEL' }).catch(() => undefined);
      this.active.finish('done');
    }
    for (const w of this.captureWaiters.values()) w.resolve(false);
    for (const wake of this.cancelWaiters) wake();
    this.cancelWaiters.clear();
  }

  /**
   * An event from the page-side reader. Anything not from the tab and run in progress is ignored,
   * and the answer is false so a reader whose run has ended (a worker restart) stops reading.
   */
  async handleEvent(event: SyncEvent, senderTabId: number | undefined): Promise<boolean> {
    const run = this.active;
    if (!run || event.runId !== run.runId || event.provider !== run.provider || senderTabId !== run.tabId) return false;
    run.lastEventAt = this.env.now();
    switch (event.kind) {
      case 'phase':
        this.patch(run.provider, (p) => ({
          status: event.phase,
          stepAt: p.status === event.phase ? p.stepAt : this.nowIso(),
          listed: event.total ?? p.listed,
          message: event.message ?? p.message,
        }));
        break;
      case 'conversation': {
        // The browser's sign-in can change under a run (a switch in another tab); what the page
        // reads after that is another person's, so the site stops instead of mixing accounts.
        if (!(await this.accountUnchanged(run.provider, run.account))) {
          this.stopForAccountChange(run);
          return false;
        }
        const result = await this.bounded(this.env.storeConversation(event.conversation, run.account), STEP_TIMEOUTS.database, 'step_timeout').catch(() => null);
        this.patch(run.provider, (p) =>
          result === 'stored' ? { stored: p.stored + 1 } : result === 'skipped' ? { skipped: p.skipped + 1 } : { failed: p.failed + 1 }
        );
        break;
      }
      case 'skipped':
        this.patch(run.provider, (p) => ({ skipped: p.skipped + 1 }));
        break;
      case 'failed':
        this.patch(run.provider, (p) => ({ failed: p.failed + 1 }));
        break;
      case 'done':
        this.patch(run.provider, (p) => ({ status: 'done', listed: event.listed || p.listed, message: event.message }));
        run.finish('done');
        break;
      case 'error':
        this.patch(run.provider, { status: 'error', message: event.message });
        run.finish('error');
        break;
    }
    await this.save(event.kind === 'phase' || event.kind === 'done' || event.kind === 'error');
    return true;
  }

  /**
   * Called when a capture from a tab has been stored. Resolves the tab-by-tab wait for that
   * conversation, but only once the capture holds messages: an early capture of a page still
   * loading is not the conversation.
   */
  noteCapture(tabId: number, sourceConversationId: string, messageCount: number): void {
    const w = this.captureWaiters.get(tabId);
    if (w && messageCount > 0 && w.conversationId.toLowerCase() === sourceConversationId.toLowerCase()) w.resolve(true);
  }

  /**
   * The state the library shows. A worker that has just started has no run in memory, so a saved
   * state that still says "running" belongs to a worker that was stopped: it is ended as
   * interrupted (the unfinished sites can be continued), and the analysis it held back is started.
   */
  async currentState(): Promise<SyncState> {
    if (this.running || this.state.runId) return this.state;
    return this.recover();
  }

  /** End a run a stopped worker left behind. Safe to call at every worker start. */
  async recover(): Promise<SyncState> {
    if (this.running) return this.state;
    let stored: SyncState | null = null;
    try {
      stored = (await this.env.loadState?.()) ?? null;
    } catch {
      stored = null;
    }
    if (!stored || typeof stored !== 'object' || !Array.isArray(stored.providers)) return this.state.runId ? this.state : EMPTY_SYNC_STATE;
    if (!stored.running) return stored;
    const at = this.nowIso();
    let fixed: SyncState = {
      ...stored,
      running: false,
      interrupted: true,
      finishedAt: at,
      providers: stored.providers.map((p) =>
        isFinishedStatus(p.status) ? p : { ...p, status: 'error' as const, message: describeSyncError('interrupted', p.label), stepAt: at }
      ),
    };
    const queued = await this.releaseHold(stored.runId);
    fixed = { ...fixed, analysis: { queued, at } };
    await this.env.saveState(fixed).catch(() => undefined);
    return fixed;
  }

  // ---- run ----------------------------------------------------------------

  private nowIso(): string {
    return new Date(this.env.now()).toISOString();
  }

  private patch(provider: SyncProviderId, change: Partial<SyncProviderState> | ((p: SyncProviderState) => Partial<SyncProviderState>)): void {
    this.state = updateProvider(this.state, provider, change);
  }

  /** Move a site to a new step and save at once, so no page is left showing the old step. */
  private async step(provider: SyncProviderId, status: SyncProviderState['status'], extra: Partial<SyncProviderState> = {}): Promise<void> {
    this.patch(provider, { status, stepAt: this.nowIso(), ...extra });
    await this.save(true);
  }

  private async save(force: boolean): Promise<void> {
    const now = this.env.now();
    if (!force && now - this.lastSavedAt < SAVE_INTERVAL_MS) return;
    this.lastSavedAt = now;
    this.state = { ...this.state, heartbeatAt: new Date(now).toISOString() };
    // Saving is never cut short by a cancel: the cancelled state is what most needs saving.
    await this.bounded(this.env.saveState(this.state), STEP_TIMEOUTS.browser, 'step_timeout', false).catch(() => undefined);
    if (this.state.running && this.state.runId && now - this.lastHoldTouchAt >= HOLD_TOUCH_MS) {
      this.lastHoldTouchAt = now;
      await this.bounded(this.env.touchAnalysisHold?.(this.state.runId) ?? Promise.resolve(), STEP_TIMEOUTS.database, 'step_timeout', false).catch(() => undefined);
    }
  }

  private async releaseHold(runId: string | null): Promise<number> {
    if (!this.env.releaseAnalysis) return 0;
    try {
      return await this.bounded(this.env.releaseAnalysis(runId), STEP_TIMEOUTS.database, 'step_timeout', false);
    } catch {
      return 0;
    }
  }

  /**
   * Wait for `work`, but no longer than `ms`, and not past a cancel. Whatever `work` does later is
   * ignored. A timeout throws a StepFailure with `code`; a cancel throws Cancelled.
   */
  private bounded<T>(work: Promise<T>, ms: number, code: SyncErrorCode | SyncStepErrorCode, cancellable = true): Promise<T> {
    if (cancellable && this.cancelled) {
      work.catch(() => undefined);
      return Promise.reject(new Cancelled());
    }
    const timer = this.env.timeout(ms);
    let wake: () => void = () => undefined;
    const cancelled = new Promise<never>((_, reject) => {
      wake = () => reject(new Cancelled());
    });
    cancelled.catch(() => undefined);
    if (cancellable) this.cancelWaiters.add(wake);
    return Promise.race([
      work,
      timer.promise.then(() => {
        throw new StepFailure(code);
      }),
      cancelled,
    ]).finally(() => {
      timer.cancel();
      this.cancelWaiters.delete(wake);
    });
  }

  private async runAll(providers: SyncProviderId[], days: number): Promise<void> {
    const sinceMs = this.state.scope === 'all' ? 0 : syncCutoffMs(days, this.env.now());
    try {
      for (const id of providers) {
        if (this.cancelled) {
          this.patch(id, { status: 'cancelled', message: 'Cancelled' });
          continue;
        }
        const info = syncProviderInfo(id);
        if (!info) continue;
        try {
          await this.runProvider(info, sinceMs);
        } catch (err) {
          if (err instanceof Cancelled || this.cancelled) {
            this.patch(id, (p) => (isFinishedStatus(p.status) ? {} : { status: 'cancelled', message: 'Cancelled' }));
          } else {
            const code = err instanceof StepFailure ? err.code : 'network';
            this.patch(id, (p) => (p.status === 'done' ? {} : { status: 'error', message: describeSyncError(code, info.label) }));
          }
        }
        // A site that ended without saying how (it never should) is not left looking busy.
        this.patch(id, (p) => (isFinishedStatus(p.status) ? {} : { status: 'error', message: describeSyncError('step_timeout', info.label) }));
        await this.save(true);
      }
    } finally {
      const at = this.nowIso();
      this.state = { ...this.state, running: false, finishedAt: at };
      await this.save(true);
      // The analysis that waited for the run starts now, whether the run finished, was cancelled
      // or failed part-way; the import is reported finished before it.
      const queued = await this.releaseHold(this.state.runId);
      this.state = { ...this.state, analysis: { queued, at: this.nowIso() } };
      await this.save(true);
    }
  }

  private fail(info: SyncProviderInfo, code: SyncErrorCode | SyncStepErrorCode): void {
    this.patch(info.id, { status: 'error', message: describeSyncError(code, info.label) });
  }

  /** What a tab that loaded is actually showing: the app, a sign-in page, or a bot check. */
  private async pageProblem(info: SyncProviderInfo, tabId: number): Promise<SyncErrorCode | SyncStepErrorCode | null> {
    if (!this.env.tabInfo) return null;
    const tab = await this.bounded(this.env.tabInfo(tabId), STEP_TIMEOUTS.browser, 'step_timeout');
    if (!tab) return 'tab_closed';
    if (tab.title && CHALLENGE_TITLE.test(tab.title)) return 'blocked';
    if (tab.url) {
      let parsed: URL | null = null;
      try {
        parsed = new URL(tab.url);
      } catch {
        parsed = null;
      }
      // Sent to another host (an identity provider) or to a sign-in path: nobody is signed in.
      if (parsed && (!onSiteHost(info, parsed.hostname) || LOGIN_PATH.test(parsed.pathname))) return 'needs_login';
    }
    return null;
  }

  private async openOwnTab(info: SyncProviderInfo): Promise<number> {
    return this.bounded(this.env.openTab(info.homeUrl), STEP_TIMEOUTS.browser, 'step_timeout');
  }

  /** Wait for the tab to load and the reader to answer; the problem when either does not happen. */
  private async prepareTab(info: SyncProviderInfo, tabId: number): Promise<SyncErrorCode | SyncStepErrorCode | null> {
    const ready = await this.bounded(this.env.waitTabReady(tabId, TAB_READY_TIMEOUT_MS), TAB_READY_TIMEOUT_MS + 5_000, 'page_timeout').catch((err) => {
      if (err instanceof Cancelled) throw err;
      return false;
    });
    const problem = await this.pageProblem(info, tabId);
    if (problem) return problem;
    if (!ready) return 'page_timeout';
    const reader = await this.bounded(this.env.ensureContentScript(tabId), STEP_TIMEOUTS.reader, 'no_reader').catch((err) => {
      if (err instanceof Cancelled) throw err;
      return false;
    });
    if (reader) return null;
    // Without the address, a page the reader cannot run on is most often a sign-in redirect.
    return this.env.tabInfo ? 'no_reader' : 'needs_login';
  }

  private async runProvider(info: SyncProviderInfo, sinceMs: number): Promise<void> {
    await this.step(info.id, 'opening', { message: null });
    if (this.env.hasHostAccess) {
      const allowed = await this.bounded(this.env.hasHostAccess(info), STEP_TIMEOUTS.browser, 'step_timeout');
      if (!allowed) return this.fail(info, 'no_access');
    }
    let tabId: number | null = info.ownListTab ? null : await this.bounded(this.env.findTab(info), STEP_TIMEOUTS.browser, 'step_timeout');
    let created = false;
    if (tabId === null) {
      tabId = await this.openOwnTab(info);
      created = true;
    }
    try {
      let problem = await this.prepareTab(info, tabId);
      // A tab of the person's that does not answer (frozen in the background, or open since
      // before the extension was updated) is left alone; a fresh tab of our own is tried once.
      if (problem && !created && problem !== 'needs_login' && problem !== 'blocked') {
        tabId = await this.openOwnTab(info);
        created = true;
        problem = await this.prepareTab(info, tabId);
      }
      if (problem) return this.fail(info, problem);
      if (this.cancelled) return this.patch(info.id, { status: 'cancelled', message: 'Cancelled' });

      const account = await this.pinAccount(info, tabId);
      if (account === 'signed_out') return this.fail(info, 'needs_login');
      if (info.strategy === 'api') await this.runApi(info, tabId, sinceMs, account);
      else await this.runSidebar(info, tabId, account);
    } finally {
      if (created) await this.bounded(this.env.closeTab(tabId), STEP_TIMEOUTS.browser, 'step_timeout', false).catch(() => undefined);
    }
  }

  /**
   * Settle which account this site's threads are filed under, for the whole run. The page asks
   * the site who is signed in (its own request); the answer goes to the accounts service, which
   * makes that person's account the active one or creates it, exactly as for a page the person
   * opens. A second account of the same site therefore gets its own threads, never the first's.
   */
  private async pinAccount(info: SyncProviderInfo, tabId: number): Promise<SyncAccount | null | 'signed_out'> {
    if (!this.env.resolveAccount) return null;
    await this.step(info.id, 'account');
    if (info.identityHost) {
      const reply = (await this.bounded(this.env.sendToTab(tabId, { type: 'TK_HISTORY_IDENTITY' }), STEP_TIMEOUTS.identity, 'step_timeout').catch((err) => {
        if (err instanceof Cancelled) throw err;
        return null;
      })) as (SyncIdentityReply & { ok?: boolean }) | null;
      if (reply?.status === 'signed_out') return 'signed_out';
      if (reply?.status === 'signed_in' && reply.identity && this.env.noteIdentity) {
        await this.bounded(this.env.noteIdentity(info.id, reply.identity), STEP_TIMEOUTS.database, 'step_timeout').catch((err) => {
          if (err instanceof Cancelled) throw err;
        });
      }
    }
    const account = await this.bounded(this.env.resolveAccount(info.id), STEP_TIMEOUTS.database, 'step_timeout');
    this.patch(info.id, { account: account.label });
    return account;
  }

  private async accountUnchanged(provider: SyncProviderId, pinned: SyncAccount | null): Promise<boolean> {
    if (!pinned || !this.env.resolveAccount) return true;
    try {
      return sameAccount(pinned, await this.bounded(this.env.resolveAccount(provider), STEP_TIMEOUTS.database, 'step_timeout'));
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      return true;
    }
  }

  private stopForAccountChange(run: ActiveRun): void {
    const info = syncProviderInfo(run.provider);
    void this.env.sendToTab(run.tabId, { type: 'TK_HISTORY_SYNC_CANCEL' }).catch(() => undefined);
    if (info) this.fail(info, 'account_changed');
    run.finish('error');
  }

  private async runApi(info: SyncProviderInfo, tabId: number, sinceMs: number, account: SyncAccount | null): Promise<void> {
    const runId = this.state.runId ?? '';
    // Cancelled while the tab was opening: never start the reader.
    if (this.cancelled) return this.patch(info.id, { status: 'cancelled', message: 'Cancelled' });
    const known = await this.bounded(this.env.knownUpdatedAt(info.id, account), STEP_TIMEOUTS.database, 'step_timeout');
    let finish: (outcome: 'done' | 'error') => void = () => undefined;
    const outcome = new Promise<'done' | 'error'>((resolve) => {
      finish = resolve;
    });
    const run: ActiveRun = { runId, provider: info.id, tabId, lastEventAt: this.env.now(), account, finish };
    this.active = run;
    try {
      await this.step(info.id, 'listing');
      const reply = (await this.bounded(
        this.env.sendToTab(tabId, {
          type: 'TK_HISTORY_SYNC_RUN', runId, provider: info.id, sinceMs,
          max: this.state.scope === 'all' ? Number.MAX_SAFE_INTEGER : SYNC_MAX_API,
          scope: this.state.scope, known,
        }),
        STEP_TIMEOUTS.reader,
        'no_reader'
      )) as { ok?: boolean } | undefined;
      if (!reply?.ok) return this.fail(info, 'unsupported');
      // Wait for "done" or "error", but not forever: a stalled page ends the run, and a closed tab
      // is noticed within a few seconds instead of after the whole idle timeout.
      for (;;) {
        if (this.cancelled) break;
        const timer = this.env.timeout(Math.min(SYNC_TAB_CHECK_MS, SYNC_IDLE_TIMEOUT_MS));
        const result = await Promise.race([outcome, timer.promise.then(() => 'tick' as const)]);
        timer.cancel();
        if (result !== 'tick') break;
        if (this.env.now() - run.lastEventAt >= SYNC_IDLE_TIMEOUT_MS) {
          void this.env.sendToTab(tabId, { type: 'TK_HISTORY_SYNC_CANCEL' }).catch(() => undefined);
          this.fail(info, 'timeout');
          break;
        }
        if (this.env.tabInfo && (await this.bounded(this.env.tabInfo(tabId), STEP_TIMEOUTS.browser, 'step_timeout').catch(() => undefined)) === null) {
          this.fail(info, 'tab_closed');
          break;
        }
      }
      if (this.cancelled) this.patch(info.id, (p) => (isFinishedStatus(p.status) ? {} : { status: 'cancelled', message: 'Cancelled' }));
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      this.fail(info, err instanceof StepFailure ? err.code : 'unsupported');
    } finally {
      this.active = null;
    }
  }

  private async runSidebar(info: SyncProviderInfo, tabId: number, account: SyncAccount | null): Promise<void> {
    if (this.cancelled) return this.patch(info.id, { status: 'cancelled', message: 'Cancelled' });
    const scope = this.state.scope === 'all' ? 'all' : 'recent';
    const limit = sidebarLimit(info, scope);
    await this.step(info.id, 'listing');
    let items: SidebarConversation[] = [];
    try {
      const reply = (await this.bounded(
        this.env.sendToTab(tabId, {
          type: 'TK_HISTORY_LIST_SIDEBAR',
          provider: info.id,
          limit,
          // Reading a whole list scrolls it many more times than the recent part.
          maxScrolls: scope === 'all' ? Math.ceil(limit / 4) : undefined,
        }),
        scope === 'all' ? STEP_TIMEOUTS.sidebarListAll : STEP_TIMEOUTS.sidebarList,
        'step_timeout'
      )) as { ok?: boolean; items?: unknown } | undefined;
      items = Array.isArray(reply?.items)
        ? reply.items.filter(
            (i): i is SidebarConversation =>
              typeof i === 'object' &&
              i !== null &&
              typeof (i as SidebarConversation).id === 'string' &&
              typeof (i as SidebarConversation).url === 'string' &&
              /^https:\/\//.test((i as SidebarConversation).url)
          )
        : [];
    } catch (err) {
      if (err instanceof Cancelled) throw err;
      return this.fail(info, err instanceof StepFailure ? err.code : 'unsupported');
    }
    items = items.slice(0, limit);
    if (items.length === 0) return this.fail(info, 'no_conversations');
    await this.step(info.id, 'fetching', { listed: items.length });

    let failuresInRow = 0;
    for (const item of items) {
      if (this.cancelled) break;
      if (!(await this.accountUnchanged(info.id, account))) return this.fail(info, 'account_changed');
      const recent = await this.bounded(this.env.hasRecentCapture(info.id, item.id, account), STEP_TIMEOUTS.database, 'step_timeout').catch((err) => {
        if (err instanceof Cancelled) throw err;
        return false;
      });
      if (recent) {
        this.patch(info.id, (p) => ({ skipped: p.skipped + 1 }));
        await this.save(false);
        continue;
      }
      const captured = await this.captureInTab(item);
      this.patch(info.id, (p) => (captured ? { stored: p.stored + 1 } : { failed: p.failed + 1 }));
      await this.save(false);
      failuresInRow = captured ? 0 : failuresInRow + 1;
      // Several in a row that never show their conversation: signed out, a bot check, or a
      // changed page. Each would cost the full wait, so the site stops with a plain reason.
      if (failuresInRow >= SIDEBAR_MAX_CONSECUTIVE_FAILURES && !this.cancelled) return this.fail(info, 'capture_failed');
      await this.env.sleep(SIDEBAR_PAUSE_MS);
    }
    this.patch(info.id, (p) => (this.cancelled ? { status: 'cancelled', message: 'Cancelled' } : { status: 'done', message: p.message }));
  }

  /** Open one conversation in a background tab and wait until normal capture has stored it. */
  private async captureInTab(item: SidebarConversation): Promise<boolean> {
    let tabId: number | null = null;
    try {
      tabId = await this.bounded(this.env.openTab(item.url), STEP_TIMEOUTS.browser, 'step_timeout');
      let resolveWait: (ok: boolean) => void = () => undefined;
      const stored = new Promise<boolean>((resolve) => {
        resolveWait = resolve;
      });
      this.captureWaiters.set(tabId, { conversationId: item.id, resolve: resolveWait });
      const timer = this.env.timeout(SIDEBAR_CAPTURE_TIMEOUT_MS);
      try {
        const ready = await Promise.race([
          this.bounded(this.env.waitTabReady(tabId, TAB_READY_TIMEOUT_MS), TAB_READY_TIMEOUT_MS + 5_000, 'page_timeout'),
          stored.then(() => true),
        ]);
        if (!ready) return false;
        // The page captures itself once it settles; this asks for one more in case it already did.
        const asked = tabId;
        void this.bounded(this.env.ensureContentScript(asked), STEP_TIMEOUTS.reader, 'no_reader')
          .then((ok) => (ok ? this.env.sendToTab(asked, { type: 'TK_CAPTURE_NOW' }) : undefined))
          .catch(() => undefined);
        return await Promise.race([stored, timer.promise.then(() => false)]);
      } finally {
        timer.cancel();
      }
    } catch {
      return false;
    } finally {
      if (tabId !== null) {
        this.captureWaiters.delete(tabId);
        await this.bounded(this.env.closeTab(tabId), STEP_TIMEOUTS.browser, 'step_timeout', false).catch(() => undefined);
      }
    }
  }
}
