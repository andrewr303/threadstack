import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperclipView, type PaperclipFrameControl } from '../../src/entrypoints/manager/PaperclipView.js';
import { PaperclipStatus } from '../../src/entrypoints/manager/PaperclipConnection.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => { container = document.createElement('div'); document.body.append(container); root = createRoot(container); });
afterEach(() => { act(() => root.unmount()); container.remove(); vi.useRealTimers(); });

describe('PaperclipStatus literal lifecycle guidance', () => {
  it.each([
    { state: 'stopped', status: 'Paperclip is stopped', button: 'Start', copy: 'Run "pnpm paperclipai service start" in the Paperclip folder, or install the Mac helper to start it automatically.' },
    { state: 'start_failed', status: 'Paperclip did not start: fixture start failed', button: 'Retry', copy: 'See "pnpm paperclipai service logs" for details.' },
  ] as const)('preserves exact visible status and guidance for $state', ({ state, status, button, copy }) => {
    const connection = { snapshot: { state, origin: 'http://localhost:3100', reason: 'fixture start failed' }, retry: vi.fn(), setup: vi.fn(), allowAccess: vi.fn() };
    act(() => root.render(<PaperclipStatus connection={connection} />));
    expect(container.querySelector('.tk-settings-note')?.textContent).toBe(copy);
    expect(container.textContent).toBe(status + button + copy);
    expect(Array.from(container.querySelectorAll('button')).map(element => element.textContent)).toEqual([button]);
  });
});

describe('PaperclipView', () => {
  const options = { origin: 'http://localhost:3100', initialPath: '/ACME/issues/ACME-12', onMessage: vi.fn(), onConfigure: vi.fn() };
  const connection = { snapshot: { state: 'running', origin: options.origin }, retry: vi.fn(), setup: vi.fn(), allowAccess: vi.fn() } as const;
  it('creates one frame on first visit and preserves it through switches', () => {
    const render = (active: boolean) => act(() => root.render(<PaperclipView {...options} connection={connection} active={active} />));
    render(false);
    expect(container.querySelector('iframe')).toBeNull();
    render(true);
    const frame = container.querySelector('iframe')!;
    expect(frame.src).toBe('http://localhost:3100/ACME/issues/ACME-12');
    expect(frame.sandbox?.contains('allow-top-navigation') ?? frame.getAttribute('sandbox')!.includes('allow-top-navigation')).toBe(false);
    render(false);
    render(true);
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame.hasAttribute('data-tab')).toBe(false);
  });

  it('ignores other frame messages and accepts route messages from its own document', () => {
    const onMessage = vi.fn();
    act(() => root.render(<PaperclipView {...options} onMessage={onMessage} connection={connection} active />));
    const frame = container.querySelector('iframe')!;
    const data = { source: 'paperclip-ui', v: 1, type: 'route', path: '/ACME/issues' };
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: options.origin, source: window, data })));
    expect(onMessage).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: options.origin, source: frame.contentWindow, data })));
    expect(onMessage).toHaveBeenCalledWith({ type: 'route', path: '/ACME/issues', title: '' });
  });

  it('refreshes health immediately only for a disconnect signal from the real Paperclip frame', () => {
    const refresh = vi.fn();
    act(() => root.render(<PaperclipView {...options} connection={{ ...connection, refresh }} active />));
    const frame = container.querySelector('iframe')!;
    const data = { source: 'paperclip-ui', v: 1, type: 'disconnected' };
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: options.origin, source: window, data })));
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: 'https://evil.example', source: frame.contentWindow, data })));
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: options.origin, source: frame.contentWindow, data: { ...data, v: 2 } })));
    expect(refresh).not.toHaveBeenCalled();
    act(() => window.dispatchEvent(new MessageEvent('message', { origin: options.origin, source: frame.contentWindow, data })));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('restarts bounded hello retries for a new document after an earlier handshake stopped the timer', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    act(() => root.render(<PaperclipView {...options} connection={{ ...connection, refresh }} active />));
    const frame = container.querySelector('iframe')!;
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    const acknowledge = () => act(() => window.dispatchEvent(new MessageEvent('message', {
      origin: options.origin, source: frame.contentWindow, data: { source: 'paperclip-ui', v: 1, type: 'ready' },
    })));
    acknowledge();
    act(() => vi.advanceTimersByTime(1_000)); // the first document's acknowledged loop stops
    send.mockClear();
    act(() => frame.dispatchEvent(new Event('load')));
    expect(send).toHaveBeenCalledTimes(1);
    act(() => vi.advanceTimersByTime(1_000));
    expect(send).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain('Opening Paperclip…');
    expect(send).toHaveBeenLastCalledWith({ source: 'threadkeeper-shell', v: 1, type: 'hello' }, options.origin);
    acknowledge();
    const sentAfterAcknowledgement = send.mock.calls.length;
    act(() => vi.advanceTimersByTime(60_000));
    expect(send).toHaveBeenCalledTimes(sentAfterAcknowledgement);
    expect(container.querySelector('iframe')).toBe(frame);
    expect(frame.src).toBe(`${options.origin}${options.initialPath}`);
    expect(refresh).not.toHaveBeenCalled();
    // A document that never acknowledges still gets only its own bounded retry window.
    act(() => frame.dispatchEvent(new Event('load')));
    act(() => vi.advanceTimersByTime(60_000));
    const sentAtDeadline = send.mock.calls.length;
    act(() => vi.advanceTimersByTime(60_000));
    expect(send).toHaveBeenCalledTimes(sentAtDeadline);
  });

  it('shows the connection problem when the server stops without deleting the frame', () => {
    act(() => root.render(<PaperclipView {...options} connection={connection} active />));
    const frame = container.querySelector('iframe');
    const stopped = { ...connection, snapshot: { state: 'stopped' as const, origin: options.origin } };
    act(() => root.render(<PaperclipView {...options} connection={stopped} active />));
    expect(container.textContent).toContain('Paperclip is stopped');
    expect(container.querySelector('iframe')).toBe(frame);
    expect((frame as HTMLIFrameElement).style.display).toBe('none');
  });
  it('forwards a valid slot in shell coordinates, matches the frame color-scheme and drops a bad one (REQ-6)', () => {
    const onMessage = vi.fn();
    act(() => root.render(<PaperclipView {...options} onMessage={onMessage} connection={connection} active />));
    const frame = container.querySelector('iframe')!;
    Object.defineProperty(frame, 'clientWidth', { value: 1440, configurable: true });
    Object.defineProperty(frame, 'clientHeight', { value: 900, configurable: true });
    frame.getBoundingClientRect = () => ({ left: 8, top: 4, x: 8, y: 4, width: 1440, height: 900, right: 1448, bottom: 904, toJSON() {} }) as DOMRect;
    const send = (data: object) => act(() => window.dispatchEvent(new MessageEvent('message', { origin: options.origin, source: frame.contentWindow, data: { source: 'paperclip-ui', v: 1, ...data } })));
    send({ type: 'slot', view: 'threads', rect: { x: 240, y: 48, width: 1200, height: 852 }, scheme: 'dark' });
    expect(onMessage).toHaveBeenLastCalledWith({ type: 'slot', view: 'threads', rect: { x: 248, y: 52, width: 1200, height: 852 }, scheme: 'dark' });
    expect(frame.style.colorScheme).toBe('dark');
    onMessage.mockClear();
    send({ type: 'slot', view: 'threads', rect: { x: 240, y: 48, width: 1300, height: 852 }, scheme: 'light' });
    expect(onMessage).not.toHaveBeenCalled();
    expect(frame.style.colorScheme).toBe('dark');
  });

  it('gives the shell a control that posts to and focuses only its own frame', () => {
    const control = React.createRef<PaperclipFrameControl | null>() as React.MutableRefObject<PaperclipFrameControl | null>;
    act(() => root.render(<PaperclipView {...options} connection={connection} active controlRef={control} />));
    const frame = container.querySelector('iframe')!;
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    control.current!.post({ type: 'command', name: 'palette' });
    expect(send).toHaveBeenCalledWith({ source: 'threadkeeper-shell', v: 1, type: 'command', name: 'palette' }, options.origin);
    control.current!.focus();
    expect(document.activeElement).toBe(frame);
    expect(control.current!.frame()).toBe(frame);
  });

  it('loads eagerly while running when the window is laid out by Paperclip', () => {
    act(() => root.render(<PaperclipView {...options} connection={connection} active={false} eager />));
    expect(container.querySelector('iframe')).not.toBeNull();
    const stopped = { ...connection, snapshot: { state: 'stopped' as const, origin: options.origin } };
    act(() => { root.unmount(); root = createRoot(container); });
    act(() => root.render(<PaperclipView {...options} connection={stopped} active={false} eager />));
    expect(container.querySelector('iframe')).toBeNull();
  });

  it('recovers at the last observed route without replaying an earlier navigation request', () => {
    const navigation = { path: '/ACME/issues/first', request: 1 };
    act(() => root.render(<PaperclipView {...options} navigation={navigation} connection={connection} active />));
    const frame = container.querySelector('iframe')!;
    const message = (data: object) => act(() => window.dispatchEvent(new MessageEvent('message', { origin: options.origin, source: frame.contentWindow, data: { source: 'paperclip-ui', v: 1, ...data } })));
    message({ type: 'ready' });
    message({ type: 'route', path: '/ACME/issues/latest' });
    act(() => root.render(<PaperclipView {...options} navigation={navigation} connection={{ ...connection, snapshot: { state: 'stopped', origin: options.origin } }} active />));
    act(() => root.render(<PaperclipView {...options} navigation={navigation} connection={connection} active />));
    expect(frame.src).toBe(`${options.origin}/ACME/issues/latest`);
    const send = vi.spyOn(frame.contentWindow!, 'postMessage');
    act(() => frame.dispatchEvent(new Event('load')));
    message({ type: 'ready' });
    expect(send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'navigate', path: '/ACME/issues/first' }), options.origin);
  });
});
