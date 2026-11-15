import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PAPERCLIP_SETTINGS } from '../../src/core/schema.js';
import { usePaperclipConnection, type PaperclipConnection } from '../../src/entrypoints/manager/PaperclipConnection.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root; let host: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount()); host.remove(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks();
});

describe('Paperclip connection refresh', () => {
  it('checks immediately on a real transport hint, retains the healthy cadence, and stays quiet while hidden', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', deploymentMode: 'local_trusted' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    let connection!: PaperclipConnection;
    function Probe() { connection = usePaperclipConnection(DEFAULT_PAPERCLIP_SETTINGS, true); return <p>{connection.snapshot.state}</p>; }
    await act(async () => root.render(<Probe />));
    expect(connection.snapshot.state).toBe('running');
    const initialCalls = fetcher.mock.calls.length;
    await act(async () => connection.refresh?.());
    expect(fetcher.mock.calls.length).toBeGreaterThan(initialCalls);
    const afterHint = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(fetcher).toHaveBeenCalledTimes(afterHint);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetcher).toHaveBeenCalledTimes(afterHint + 1);
    visibility.mockReturnValue('hidden');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    const beforeHidden = fetcher.mock.calls.length;
    await act(async () => connection.refresh?.());
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(fetcher).toHaveBeenCalledTimes(beforeHidden);
    visibility.mockReturnValue('visible');
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(fetcher).toHaveBeenCalledTimes(beforeHidden + 1);
  });
  it('polls a running server every five seconds while the Paperclip view is active (REQ-5 F1)', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({ status: 'ok', deploymentMode: 'local_trusted' }), { status: 200 }));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    function Probe({ active }: { active: boolean }) { const c = usePaperclipConnection(DEFAULT_PAPERCLIP_SETTINGS, true, active); return <p>{c.snapshot.state}</p>; }
    await act(async () => root.render(<Probe active />));
    const first = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(4_999));
    expect(fetcher).toHaveBeenCalledTimes(first);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetcher).toHaveBeenCalledTimes(first + 1);
    await act(async () => root.render(<Probe active={false} />));
    const afterSwitch = fetcher.mock.calls.length;
    await act(async () => vi.advanceTimersByTimeAsync(29_999));
    expect(fetcher).toHaveBeenCalledTimes(afterSwitch);
    await act(async () => vi.advanceTimersByTimeAsync(1));
    expect(fetcher).toHaveBeenCalledTimes(afterSwitch + 1);
  });
});
