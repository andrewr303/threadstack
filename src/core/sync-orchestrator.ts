import {
  EMPTY_SYNC_STATE,
  SYNC_MAX_API,
  SYNC_MAX_SIDEBAR,
  clampSyncDays,
  describeSyncError,
  initialSyncState,
  syncCutoffMs,
  syncProviderInfo,
  updateProvider,
  type SyncErrorCode,
  type SyncEvent,
  type SyncProviderId,
  type SyncProviderInfo,
  type SyncRequest,
  type SyncState,
} from './history-sync.js';
import type { SiteConversation } from './site-api.js';
import type { SidebarConversation } from './sidebar-history.js';

/**
 * Runs Catch up from the service worker: for each site, find or open a tab, start the page-side
 * reader, store what it reports, and keep a progress state the library can show.
 *
 * Everything that touches the browser or the database goes through SyncEnv, so a whole run can be
 * driven by a test with fakes.
 */

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
  /** Conversations of this provider already stored in full: site id → site updatedAt. */
  knownUpdatedAt(provider: SyncProviderId): Promise<Record<string, string>>;
  storeConversation(conversation: SiteConversation): Promise<'stored' | 'skipped'>;
  /** Captured within the last few hours; the tab-by-tab way skips these. */
  hasRecentCapture(provider: SyncProviderId, sourceConversationId: string): Promise<boolean>;
  saveState(state: SyncState): Promise<void>;
}

/** A page that has sent nothing for this long has stalled. */
export const SYNC_IDLE_TIMEOUT_MS = 120_000;
const TAB_READY_TIMEOUT_MS = 30_000;
const SIDEBAR_CAPTURE_TIMEOUT_MS = 25_000;
const SIDEBAR_PAUSE_MS = 900;
const SAVE_INTERVAL_MS = 400;

interface ActiveRun {
  runId: string;
  provider: SyncProviderId;
  tabId: number;
  lastEventAt: number;
  finish: (outcome: 'done' | 'error') => void;
}

export class HistorySyncOrchestrator {
  state: SyncState = EMPTY_SYNC_STATE;
  private cancelled = false;
  private active: ActiveRun | null = null;
  private running: Promise<void> | null = null;
  private lastSavedAt = 0;
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
    const providers = request.providers.filter((id, i, all) => all.indexOf(id) === i && syncProviderInfo(id) && enabled.has(id));
    if (providers.length === 0) return { started: false, reason: 'No site to catch up on is switched on for capture.' };
    // Sites with a complete history first: they finish fastest and cost the site least.
    providers.sort((a, b) => Number(syncProviderInfo(a)?.strategy !== 'api') - Number(syncProviderInfo(b)?.strategy !== 'api'));

    this.cancelled = false;
    const days = clampSyncDays(request.days);
    this.state = initialSyncState(this.env.newRunId(), { providers, days }, new Date(this.env.now()).toISOString());
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
  }

  /** An event from the page-side reader. Anything not from the tab and run in progress is ignored. */
  async handleEvent(event: SyncEvent, senderTabId: number | undefined): Promise<void> {
    const run = this.active;
    if (!run || event.runId !== run.runId || event.provider !== run.provider || senderTabId !== run.tabId) return;
    run.lastEventAt = this.env.now();
    switch (event.kind) {
      case 'phase':
        this.patch(run.provider, (p) => ({
          status: event.phase,
          listed: event.total ?? p.listed,
          message: event.message ?? p.message,
        }));
        break;
      case 'conversation': {
        const result = await this.env.storeConversation(event.conversation).catch(() => null);
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
    await this.save(false);
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

  // ---- run ----------------------------------------------------------------

  private patch(provider: SyncProviderId, change: Parameters<typeof updateProvider>[2]): void {
    this.state = updateProvider(this.state, provider, change);
  }

  private async save(force: boolean): Promise<void> {
    const now = this.env.now();
    if (!force && now - this.lastSavedAt < SAVE_INTERVAL_MS) return;
    this.lastSavedAt = now;
    await this.env.saveState(this.state).catch(() => undefined);
  }

  private async runAll(providers: SyncProviderId[], days: number): Promise<void> {
    const sinceMs = syncCutoffMs(days, this.env.now());
    for (const id of providers) {
      if (this.cancelled) {
        this.patch(id, { status: 'cancelled', message: 'Cancelled' });
        continue;
      }
      const info = syncProviderInfo(id);
      if (!info) continue;
      try {
        await this.runProvider(info, sinceMs);
      } catch {
        this.patch(id, (p) => (p.status === 'done' ? {} : { status: 'error', message: describeSyncError('network', info.label) }));
      }
      await this.save(true);
    }
    this.state = { ...this.state, running: false, finishedAt: new Date(this.env.now()).toISOString() };
    await this.save(true);
  }

  private fail(info: SyncProviderInfo, code: SyncErrorCode): void {
    this.patch(info.id, { status: 'error', message: describeSyncError(code, info.label) });
  }

  private async runProvider(info: SyncProviderInfo, sinceMs: number): Promise<void> {
    this.patch(info.id, { status: 'opening', message: null });
    await this.save(true);
    let tabId = await this.env.findTab(info);
    let created = false;
    if (tabId === null) {
      tabId = await this.env.openTab(info.homeUrl);
      created = true;
    }
    try {
      if (!(await this.env.waitTabReady(tabId, TAB_READY_TIMEOUT_MS))) return this.fail(info, 'timeout');
      // A site that sends a signed-out visitor to a login page never reaches the reader.
      if (!(await this.env.ensureContentScript(tabId))) return this.fail(info, 'needs_login');
      if (info.strategy === 'api') await this.runApi(info, tabId, sinceMs);
      else await this.runSidebar(info, tabId);
    } finally {
      if (created) await this.env.closeTab(tabId).catch(() => undefined);
    }
  }

  private async runApi(info: SyncProviderInfo, tabId: number, sinceMs: number): Promise<void> {
    const runId = this.state.runId ?? '';
    // Cancelled while the tab was opening: never start the reader.
    if (this.cancelled) return this.patch(info.id, { status: 'cancelled', message: 'Cancelled' });
    const known = await this.env.knownUpdatedAt(info.id);
    let finish: (outcome: 'done' | 'error') => void = () => undefined;
    const outcome = new Promise<'done' | 'error'>((resolve) => {
      finish = resolve;
    });
    const run: ActiveRun = { runId, provider: info.id, tabId, lastEventAt: this.env.now(), finish };
    this.active = run;
    try {
      this.patch(info.id, { status: 'listing' });
      await this.env.sendToTab(tabId, { type: 'TK_HISTORY_SYNC_RUN', runId, provider: info.id, sinceMs, max: SYNC_MAX_API, known });
      // Wait for "done" or "error", but not forever: a stalled page ends the run.
      for (;;) {
        if (this.cancelled) break;
        const timer = this.env.timeout(SYNC_IDLE_TIMEOUT_MS);
        const result = await Promise.race([outcome, timer.promise.then(() => 'tick' as const)]);
        timer.cancel();
        if (result !== 'tick') break;
        if (this.env.now() - run.lastEventAt >= SYNC_IDLE_TIMEOUT_MS) {
          void this.env.sendToTab(tabId, { type: 'TK_HISTORY_SYNC_CANCEL' }).catch(() => undefined);
          this.fail(info, 'timeout');
          break;
        }
      }
      if (this.cancelled) this.patch(info.id, (p) => (p.status === 'done' || p.status === 'error' ? {} : { status: 'cancelled', message: 'Cancelled' }));
    } catch {
      this.fail(info, 'unsupported');
    } finally {
      this.active = null;
    }
  }

  private async runSidebar(info: SyncProviderInfo, tabId: number): Promise<void> {
    if (this.cancelled) return this.patch(info.id, { status: 'cancelled', message: 'Cancelled' });
    this.patch(info.id, { status: 'listing' });
    let items: SidebarConversation[] = [];
    try {
      const reply = (await this.env.sendToTab(tabId, { type: 'TK_HISTORY_LIST_SIDEBAR', provider: info.id, limit: SYNC_MAX_SIDEBAR })) as
        | { ok?: boolean; items?: unknown }
        | undefined;
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
    } catch {
      return this.fail(info, 'unsupported');
    }
    items = items.slice(0, SYNC_MAX_SIDEBAR);
    if (items.length === 0) return this.fail(info, 'no_conversations');
    this.patch(info.id, { status: 'fetching', listed: items.length });

    for (const item of items) {
      if (this.cancelled) break;
      if (await this.env.hasRecentCapture(info.id, item.id)) {
        this.patch(info.id, (p) => ({ skipped: p.skipped + 1 }));
        continue;
      }
      const captured = await this.captureInTab(item);
      this.patch(info.id, (p) => (captured ? { stored: p.stored + 1 } : { failed: p.failed + 1 }));
      await this.save(false);
      await this.env.sleep(SIDEBAR_PAUSE_MS);
    }
    this.patch(info.id, (p) => (this.cancelled ? { status: 'cancelled', message: 'Cancelled' } : { status: 'done', message: p.message }));
  }

  /** Open one conversation in a background tab and wait until normal capture has stored it. */
  private async captureInTab(item: SidebarConversation): Promise<boolean> {
    let tabId: number | null = null;
    try {
      tabId = await this.env.openTab(item.url);
      let resolveWait: (ok: boolean) => void = () => undefined;
      const stored = new Promise<boolean>((resolve) => {
        resolveWait = resolve;
      });
      this.captureWaiters.set(tabId, { conversationId: item.id, resolve: resolveWait });
      const timer = this.env.timeout(SIDEBAR_CAPTURE_TIMEOUT_MS);
      const ready = await this.env.waitTabReady(tabId, TAB_READY_TIMEOUT_MS);
      if (!ready) return false;
      // The page captures itself once it settles; this asks for one more in case it already did.
      void this.env.ensureContentScript(tabId).then((ok) => (ok && tabId !== null ? this.env.sendToTab(tabId, { type: 'TK_CAPTURE_NOW' }) : undefined)).catch(() => undefined);
      const ok = await Promise.race([stored, timer.promise.then(() => false)]);
      timer.cancel();
      return ok;
    } catch {
      return false;
    } finally {
      if (tabId !== null) {
        this.captureWaiters.delete(tabId);
        await this.env.closeTab(tabId).catch(() => undefined);
      }
    }
  }
}
