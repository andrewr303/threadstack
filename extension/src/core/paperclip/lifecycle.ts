import { isLoopbackServer, normalizeServerUrl, type FetchLike } from './client.js';
import type { PaperclipHelperResult } from '../embed/helper-protocol.js';
export type { PaperclipHelperResult } from '../embed/helper-protocol.js';

export type PaperclipLifecycleState = 'running' | 'starting' | 'stopped' | 'not_installed' | 'needs_sign_in'
  | 'setup_pending' | 'unreachable' | 'start_failed';
export interface PaperclipLifecycleSnapshot {
  state: PaperclipLifecycleState; origin: string; reason?: string;
  /** Explicitly false when no Mac helper can answer, so the UI never offers a Start that cannot work. */
  helperConnected?: boolean;
}
export interface PaperclipLifecycleOptions {
  origin: string;
  apiKey?: string;
  hasAccess(): Promise<boolean>;
  helper?: {
    status(): Promise<PaperclipHelperResult>;
    start(retry?: boolean): Promise<PaperclipHelperResult>;
    install?(): Promise<PaperclipHelperResult>;
  };
  fetch?: FetchLike;
  now?: () => number;
  /** True while the Paperclip view itself is on screen: a running server is then checked every 5 s, not 30 s. */
  activeView?: boolean;
}

const INSTALL_TIMEOUT_MS = 70_000;
const REINSTALL_LINE = 'Run "Install Mac Helper.command" again and choose the Paperclip folder.';
const REASON_TEXT: Record<string, string> = {
  paperclip_start_failed: 'the Mac helper could not start it.',
  unsupported_platform: 'starting it from here needs macOS.',
  helper_unavailable: 'the Mac helper is not available.',
};

/**
 * Instantiate once in the service worker, so simultaneous shell windows share one attempt.
 * The 60 s dedup lives in worker memory only: a worker restart forgets it. That is safe because
 * the helper's start is a no-op while the launchd service is already active, so the worst case
 * is one redundant `start` request, never a second server.
 */
export function createPaperclipStartCoordinator(start: () => Promise<PaperclipHelperResult>, now = Date.now) {
  let pending: Promise<PaperclipHelperResult> | null = null;
  let attemptedAt = -Infinity;
  let last: PaperclipHelperResult | null = null;
  return {
    start(retry = false): Promise<PaperclipHelperResult> {
      if (pending) return pending;
      if (!retry && last && now() - attemptedAt < 60_000) return Promise.resolve(last);
      attemptedAt = now();
      pending = start().catch((): PaperclipHelperResult => ({ ok: false, error: 'paperclip_start_failed' }))
        .then(result => { last = result; return result; }).finally(() => { pending = null; });
      return pending;
    },
  };
}

export function paperclipLifecycleText(snapshot: PaperclipLifecycleSnapshot): string {
  if (snapshot.reason === 'paperclip_not_registered' && (snapshot.state === 'not_installed' || snapshot.state === 'start_failed')) return REINSTALL_LINE;
  switch (snapshot.state) {
    case 'running': return 'Paperclip is running';
    case 'starting': return 'Starting Paperclip…';
    case 'stopped': return 'Paperclip is stopped';
    case 'not_installed': return 'Paperclip is not set up on this Mac';
    case 'needs_sign_in': return 'Paperclip needs you to sign in';
    case 'setup_pending': return 'Finish setting up Paperclip';
    case 'unreachable': return `Can't reach Paperclip at ${snapshot.origin}`;
    case 'start_failed': return `Paperclip did not start: ${REASON_TEXT[snapshot.reason || ''] || snapshot.reason || 'startup timed out'}`;
  }
}

/** Visible shell health polling. Lifecycle requests carry no executable, folder or remote origin. */
export function createPaperclipLifecycle(options: PaperclipLifecycleOptions) {
  const origin = normalizeServerUrl(options.origin) || options.origin;
  const fetchImpl = options.fetch || ((input, init) => fetch(input, init));
  const now = options.now || Date.now;
  let snapshot: PaperclipLifecycleSnapshot = { state: 'starting', origin };
  let visible = false, disposed = false, attempted = false, retryRequested = false, installing = false;
  let helperMissing = false, activeView = options.activeView === true;
  let startDeadline = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let requestAbort: AbortController | null = null;
  let pending: Promise<void> | null = null;
  let generation = 0;
  const listeners = new Set<(snapshot: PaperclipLifecycleSnapshot) => void>();
  const update = (state: PaperclipLifecycleState, reason?: string, helperConnected?: boolean) => {
    if (disposed) return;
    snapshot = { state, origin, ...(reason ? { reason } : {}), ...(helperConnected === undefined ? {} : { helperConnected }) };
    for (const listener of listeners) listener(snapshot);
  };
  const clearTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const schedule = () => {
    clearTimer();
    if (visible && !disposed && !installing) timer = setTimeout(() => { void refresh(); }, snapshot.state === 'running' && !activeView ? 30_000 : 5_000);
  };
  const request = async (path: string, auth = false) => {
    const controller = new AbortController(); requestAbort = controller;
    const timeout = setTimeout(() => controller.abort(), 2_000);
    try {
      const res = await fetchImpl(`${origin}/api${path}`, { signal: controller.signal, credentials: 'omit',
        headers: auth && options.apiKey ? { Authorization: `Bearer ${options.apiKey}` } : {} });
      let body: unknown;
      try { body = await res.json(); } catch (error) {
        // A response from an occupied port proves reachability even when it is HTML or malformed
        // JSON. Only an actual request timeout belongs to the offline/automatic-start path.
        if (controller.signal.aborted) throw error;
        body = null;
      }
      return { status: res.status, ok: res.ok,
        body: body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null };
    } finally { clearTimeout(timeout); if (requestAbort === controller) requestAbort = null; }
  };
  const offline = async (current: number) => {
    if (current !== generation || disposed) return;
    if (startDeadline) {
      if (now() >= startDeadline) update('start_failed', 'startup timed out');
      else update('starting');
      return;
    }
    if (snapshot.state === 'start_failed') return;
    if (!isLoopbackServer(origin) || !options.helper) { update('stopped', undefined, false); return; }
    // A missing helper is remembered for this window's lifetime: no native message is sent again.
    if (helperMissing) { update('stopped', 'helper_unavailable', false); return; }
    let status: PaperclipHelperResult;
    try { status = await options.helper.status(); } catch { status = { ok: false, error: 'helper_unavailable' }; }
    if (current !== generation || disposed) return;
    if (!status.ok) {
      if (status.error === 'helper_unavailable' || status.error === 'unsupported_platform') helperMissing = true;
      const answered = status.error === 'paperclip_not_registered' || status.error === 'paperclip_start_failed';
      update(status.error === 'paperclip_not_registered' ? 'not_installed' : 'stopped', status.error, answered);
      return;
    }
    if (!('paperclip' in status)) { update('stopped', undefined, true); return; }
    if (status.paperclip.service === 'not_installed') { update('not_installed', undefined, true); return; }
    if (attempted) { update('stopped', undefined, true); return; }
    attempted = true;
    startDeadline = now() + 60_000;
    update('starting');
    let result: PaperclipHelperResult;
    try { result = await options.helper.start(retryRequested); } catch { result = { ok: false, error: 'paperclip_start_failed' }; }
    retryRequested = false;
    if (current !== generation || disposed) return;
    if (!result.ok) { startDeadline = 0; update('start_failed', result.error); }
  };
  const poll = async () => {
    const current = generation;
    if (!(await options.hasAccess().catch(() => false))) { update('unreachable', 'permission_required'); return; }
    if (current !== generation || disposed) return;
    let response;
    try { response = await request('/health'); } catch { await offline(current); return; }
    if (current !== generation || disposed) return;
    const body = response.body;
    if (!response.ok || !body || body.status !== 'ok' || !['local_trusted', 'authenticated'].includes(String(body.deploymentMode))) {
      update('unreachable', 'not_paperclip'); return;
    }
    if (body.bootstrapStatus === 'bootstrap_pending') { update('setup_pending'); return; }
    if (body.deploymentMode === 'authenticated') {
      if (!options.apiKey || body.authReady === false) { update('needs_sign_in'); return; }
      try {
        const me = await request('/cli-auth/me', true);
        if (current !== generation || disposed) return;
        // Only a rejected credential or an answer without a user means "sign in". A 5xx, a network
        // error or a timeout says nothing about the credential, so the server is just unreachable.
        if (me.status === 401 || me.status === 403) { update('needs_sign_in'); return; }
        if (!me.ok) { update('unreachable', 'auth_check_failed'); return; }
        if (typeof me.body?.userId !== 'string') { update('needs_sign_in'); return; }
      } catch { if (current === generation) update('unreachable', 'auth_check_failed'); return; }
    }
    startDeadline = 0;
    update('running');
  };
  function refresh(): Promise<void> {
    if (disposed || installing) return Promise.resolve();
    if (pending) return pending;
    clearTimer();
    pending = poll().catch(() => update('unreachable')).finally(() => { pending = null; schedule(); });
    return pending;
  }
  return {
    getSnapshot: () => snapshot,
    subscribe(listener: (snapshot: PaperclipLifecycleSnapshot) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setVisible(next: boolean) {
      if (disposed || visible === next) return;
      visible = next;
      if (next) { void (pending ? pending.then(() => refresh()) : refresh()); }
      else { generation++; clearTimer(); requestAbort?.abort(); }
    },
    refresh,
    /** The hook calls this when the Paperclip view is shown or hidden. */
    setActiveView(next: boolean) {
      if (disposed || activeView === next) return;
      activeView = next;
      if (visible && !pending && !installing && snapshot.state === 'running') schedule();
    },
    retry() { attempted = false; startDeadline = 0; retryRequested = true; update('starting'); return refresh(); },
    async setup() {
      if (disposed || installing || !isLoopbackServer(origin) || !options.helper?.install) return;
      if (!(await options.hasAccess().catch(() => false))) { update('unreachable', 'permission_required'); return; }
      installing = true; clearTimer();
      update('starting');
      let result: PaperclipHelperResult;
      // A host that never answers must not leave polling off forever.
      let giveUp: ReturnType<typeof setTimeout> | undefined;
      const timedOut = new Promise<PaperclipHelperResult>(resolve => {
        giveUp = setTimeout(() => resolve({ ok: false, error: 'paperclip_start_failed' }), INSTALL_TIMEOUT_MS);
      });
      try { result = await Promise.race([options.helper.install(), timedOut]); } catch { result = { ok: false, error: 'paperclip_start_failed' }; }
      clearTimeout(giveUp);
      installing = false;
      if (disposed) return;
      if (!result.ok) { update('start_failed', result.error); schedule(); return; }
      attempted = true; startDeadline = now() + 60_000;
      await refresh();
    },
    dispose() { disposed = true; generation++; visible = false; clearTimer(); requestAbort?.abort(); listeners.clear(); },
  };
}
