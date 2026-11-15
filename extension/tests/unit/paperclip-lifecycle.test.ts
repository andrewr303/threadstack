import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPaperclipLifecycle, createPaperclipStartCoordinator, paperclipLifecycleText } from '../../src/core/paperclip/lifecycle.js';

const healthy = () => new Response(JSON.stringify({ status: 'ok', deploymentMode: 'local_trusted' }));
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
afterEach(() => vi.useRealTimers());

describe('Paperclip lifecycle', () => {
  it('deduplicates starts across windows and requires explicit retry after failure', async () => {
    let resolve!: (value: { ok: false; error: string }) => void;
    const start = vi.fn(() => new Promise<{ ok: false; error: string }>(r => { resolve = r; }));
    const coordinator = createPaperclipStartCoordinator(start);
    const first = coordinator.start();
    const second = coordinator.start();
    resolve({ ok: false, error: 'paperclip_start_failed' });
    await Promise.all([first, second]);
    await coordinator.start();
    expect(start).toHaveBeenCalledTimes(1);
    const retry = coordinator.start(true);
    resolve({ ok: false, error: 'paperclip_start_failed' });
    await retry;
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('polls only visible windows and refreshes immediately when shown', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => healthy());
    const controller = createPaperclipLifecycle({ origin: 'http://127.0.0.1:3100', hasAccess: async () => true, fetch });
    controller.setVisible(true); await flush();
    expect(controller.getSnapshot().state).toBe('running');
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.setVisible(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    controller.setVisible(true); await flush();
    expect(fetch).toHaveBeenCalledTimes(2);
    controller.dispose();
  });

  it('does not start a foreign service, remote server or denied origin', async () => {
    const start = vi.fn(async () => ({ ok: true as const, started: true as const }));
    const status = vi.fn(async () => ({ ok: true as const, paperclip: { service: 'stopped' as const } }));
    const fetch = vi.fn(async () => new Response('{"hello":"other service"}'));
    const controller = createPaperclipLifecycle({ origin: 'http://127.0.0.1:3100', hasAccess: async () => true, helper: { status, start }, fetch });
    await controller.refresh();
    expect(controller.getSnapshot().state).toBe('unreachable');
    expect(status).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    const denied = createPaperclipLifecycle({ origin: 'http://127.0.0.1:3100', hasAccess: async () => false, fetch });
    await denied.refresh();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(denied.getSnapshot().reason).toBe('permission_required');
    const remote = createPaperclipLifecycle({ origin: 'https://remote.test', hasAccess: async () => true, helper: { status, start }, fetch: async () => { throw Error('offline'); } });
    await remote.refresh();
    expect(start).not.toHaveBeenCalled();
    controller.dispose(); denied.dispose(); remote.dispose();
  });

  it.each([200, 404, 503])('never starts the helper when a reachable port returns HTML (HTTP %s)', async (statusCode) => {
    const start = vi.fn(async () => ({ ok: true as const, started: true as const }));
    const status = vi.fn(async () => ({ ok: true as const, paperclip: { service: 'stopped' as const } }));
    const controller = createPaperclipLifecycle({ origin: 'http://127.0.0.1:3100', hasAccess: async () => true,
      helper: { status, start }, fetch: async () => new Response('<html>Another local service</html>', { status: statusCode, headers: { 'Content-Type': 'text/html' } }) });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ state: 'unreachable', reason: 'not_paperclip' });
    expect(status).not.toHaveBeenCalled();
    expect(start).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('starts once, fails after sixty seconds and leaves setup behind a click', async () => {
    vi.useFakeTimers();
    const start = vi.fn(async () => ({ ok: true as const, started: true as const }));
    const install = vi.fn(async () => ({ ok: true as const, started: true as const }));
    const status = vi.fn(async () => ({ ok: true as const, paperclip: { service: 'stopped' as const } }));
    const controller = createPaperclipLifecycle({ origin: 'http://localhost:3100', hasAccess: async () => true,
      helper: { status, start, install }, fetch: async () => { throw Error('offline'); } });
    controller.setVisible(true); await flush();
    expect(controller.getSnapshot().state).toBe('starting');
    await vi.advanceTimersByTimeAsync(60_001);
    expect(controller.getSnapshot().state).toBe('start_failed');
    expect(start).toHaveBeenCalledTimes(1);
    expect(install).not.toHaveBeenCalled();
    controller.dispose();
  });

  it('maps bootstrap and rejected board credentials without losing setup state', async () => {
    const controller = createPaperclipLifecycle({ origin: 'http://localhost:3100', hasAccess: async () => true,
      fetch: async () => new Response('{"status":"ok","deploymentMode":"authenticated","bootstrapStatus":"bootstrap_pending"}') });
    await controller.refresh(); expect(controller.getSnapshot().state).toBe('setup_pending');
    const rejected = createPaperclipLifecycle({ origin: 'http://localhost:3100', apiKey: 'test-key', hasAccess: async () => true,
      fetch: async input => String(input).endsWith('/health') ? new Response('{"status":"ok","deploymentMode":"authenticated","bootstrapStatus":"ready","authReady":true}') : new Response('{}', { status: 401 }) });
    await rejected.refresh(); expect(rejected.getSnapshot().state).toBe('needs_sign_in');
    controller.dispose(); rejected.dispose();
  });

  it('installs only on setup and recovers after server starts', async () => {
    let online = false;
    const install = vi.fn(async () => { online = true; return { ok: true as const, started: true as const }; });
    const start = vi.fn(async () => ({ ok: true as const, started: true as const }));
    const controller = createPaperclipLifecycle({ origin: 'http://localhost:3100', hasAccess: async () => true,
      fetch: async () => { if (!online) throw Error('offline'); return healthy(); },
      helper: { status: async () => ({ ok: true, paperclip: { service: 'not_installed' } }), start, install } });
    await controller.refresh();
    expect(controller.getSnapshot().state).toBe('not_installed');
    expect(install).not.toHaveBeenCalled(); expect(start).not.toHaveBeenCalled();
    await controller.setup();
    expect(controller.getSnapshot().state).toBe('running');
    expect(install).toHaveBeenCalledTimes(1);
    controller.dispose();
  });

  it('aborts a hung health request at two seconds and never retries failed starts automatically', async () => {
    vi.useFakeTimers();
    const start = vi.fn(async () => ({ ok: false as const, error: 'paperclip_start_failed' }));
    const controller = createPaperclipLifecycle({ origin: 'http://localhost:3100', hasAccess: async () => true,
      helper: { status: async () => ({ ok: true, paperclip: { service: 'stopped' } }), start },
      fetch: async (_input, init) => new Promise((_resolve, reject) => { init?.signal?.addEventListener('abort', () => reject(Error('timeout'))); }) });
    controller.setVisible(true); await flush();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(controller.getSnapshot().state).toBe('start_failed');
    await vi.advanceTimersByTimeAsync(70_000);
    expect(start).toHaveBeenCalledTimes(1);
    controller.dispose();
  });
  it('remembers an unavailable helper for the window lifetime and never messages it again (AC-11)', async () => {
    const status = vi.fn(async () => ({ ok: false as const, error: 'helper_unavailable' }));
    const start = vi.fn(async () => ({ ok: true as const, started: true as const }));
    const controller = createPaperclipLifecycle({ origin: 'http://localhost:3100', hasAccess: async () => true,
      helper: { status, start }, fetch: async () => { throw Error('offline'); } });
    for (let i = 0; i < 3; i++) await controller.refresh();
    expect(status.mock.calls.length).toBeLessThanOrEqual(1);
    expect(start).not.toHaveBeenCalled();
    expect(controller.getSnapshot()).toMatchObject({ state: 'stopped', helperConnected: false });
    expect(paperclipLifecycleText(controller.getSnapshot())).toBe('Paperclip is stopped');
    const throwing = vi.fn(async (): Promise<never> => { throw Error('no host'); });
    const second = createPaperclipLifecycle({ origin: 'http://localhost:3100', hasAccess: async () => true,
      helper: { status: throwing, start }, fetch: async () => { throw Error('offline'); } });
    for (let i = 0; i < 3; i++) await second.refresh();
    expect(throwing).toHaveBeenCalledTimes(1);
    controller.dispose(); second.dispose();
  });

  it('shows the exact reinstall line when nothing is registered, from status and from setup', async () => {
    const line = 'Run "Install Mac Helper.command" again and choose the Paperclip folder.';
    const install = vi.fn(async () => ({ ok: false as const, error: 'paperclip_not_registered' }));
    const controller = createPaperclipLifecycle({ origin: 'http://localhost:3100', hasAccess: async () => true,
      helper: { status: async () => ({ ok: false, error: 'paperclip_not_registered' }), start: vi.fn(), install },
      fetch: async () => { throw Error('offline'); } });
    await controller.refresh();
    expect(controller.getSnapshot()).toMatchObject({ state: 'not_installed', reason: 'paperclip_not_registered' });
    expect(paperclipLifecycleText(controller.getSnapshot())).toBe(line);
    await controller.setup();
    expect(paperclipLifecycleText(controller.getSnapshot())).toBe(line);
    expect(paperclipLifecycleText(controller.getSnapshot())).not.toContain('paperclip_not_registered');
    controller.dispose();
  });

  it.each([
    ['paperclip_start_failed', 'Paperclip did not start: the Mac helper could not start it.'],
    ['unsupported_platform', 'Paperclip did not start: starting it from here needs macOS.'],
    ['helper_unavailable', 'Paperclip did not start: the Mac helper is not available.'],
    ['startup timed out', 'Paperclip did not start: startup timed out'],
    ['custom reason', 'Paperclip did not start: custom reason'],
  ])('maps reason %s to a human sentence with no raw code (AC-3)', (reason, expected) => {
    expect(paperclipLifecycleText({ state: 'start_failed', origin: 'http://localhost:3100', reason })).toBe(expected);
  });

  it('reports a failing auth check as unreachable, not as a missing sign-in', async () => {
    const make = (me: () => Response | Promise<Response>) => createPaperclipLifecycle({ origin: 'http://localhost:3100', apiKey: 'test-key', hasAccess: async () => true,
      fetch: async input => String(input).endsWith('/health') ? new Response('{"status":"ok","deploymentMode":"authenticated","bootstrapStatus":"ready","authReady":true}') : me() });
    const cases: Array<[() => Response | Promise<Response>, string]> = [
      [() => new Response('{}', { status: 500 }), 'unreachable'],
      [() => new Response('{}', { status: 503 }), 'unreachable'],
      [() => { throw Error('network'); }, 'unreachable'],
      [() => new Response('{}', { status: 401 }), 'needs_sign_in'],
      [() => new Response('{"userId":7}'), 'needs_sign_in'],
      [() => new Response('{"userId":"u1"}'), 'running'],
    ];
    for (const [me, state] of cases) { const c = make(me); await c.refresh(); expect(c.getSnapshot().state).toBe(state); c.dispose(); }
  });

  it('gives up on an install that never answers after seventy seconds and resumes polling', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => { throw Error('offline'); });
    const install = vi.fn(() => new Promise<never>(() => undefined));
    const controller = createPaperclipLifecycle({ origin: 'http://localhost:3100', hasAccess: async () => true, fetch,
      helper: { status: async () => ({ ok: true, paperclip: { service: 'not_installed' } }), start: vi.fn(), install } });
    controller.setVisible(true); await flush();
    void controller.setup(); await flush();
    expect(controller.getSnapshot().state).toBe('starting');
    await vi.advanceTimersByTimeAsync(69_999);
    expect(controller.getSnapshot().state).toBe('starting');
    await vi.advanceTimersByTimeAsync(2);
    expect(controller.getSnapshot()).toMatchObject({ state: 'start_failed' });
    const before = fetch.mock.calls.length;
    await vi.advanceTimersByTimeAsync(5_001);
    expect(fetch.mock.calls.length).toBeGreaterThan(before);
    controller.dispose();
  });

  it('polls a running server every five seconds only while the Paperclip view is active', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => healthy());
    const controller = createPaperclipLifecycle({ origin: 'http://localhost:3100', hasAccess: async () => true, fetch, activeView: true });
    controller.setVisible(true); await flush();
    expect(controller.getSnapshot().state).toBe('running');
    await vi.advanceTimersByTimeAsync(4_999); expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(2);
    controller.setActiveView(false);
    await vi.advanceTimersByTimeAsync(29_999); expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(fetch).toHaveBeenCalledTimes(3);
    controller.setActiveView(true);
    await vi.advanceTimersByTimeAsync(5_000); expect(fetch).toHaveBeenCalledTimes(4);
    controller.dispose();
  });
});
