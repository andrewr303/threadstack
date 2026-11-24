// REQ-6 fused mode in the shell: the pure state machine and geometry first, then the real <App />.
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/entrypoints/manager/App.js';
import { sharedDb } from '../../src/entrypoints/manager/shared.js';
import { BUILD_INFO } from '../../src/core/build-info.js';
import { ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { seedSyntheticWorkbenchLibrary } from '../../src/core/synthetic-fixtures.js';
import { DEFAULT_PAPERCLIP_SETTINGS, type SettingsRecord } from '../../src/core/schema.js';
import {
  INITIAL_FUSION,
  fusedRoute,
  fusionReducer,
  noticeClipPath,
  overlayIsStale,
  type FusionState,
} from '../../src/entrypoints/manager/PaperclipFusion.js';

const rect = { x: 240, y: 48, width: 1200, height: 852 };
const run = (...actions: Parameters<typeof fusionReducer>[1][]): FusionState => actions.reduce(fusionReducer, INITIAL_FUSION);

describe('fusion state', () => {
  it('engages on the first slot after a fused ready and follows later slots', () => {
    const state = run({ type: 'ready', mode: 'fused', at: 1_000 }, { type: 'slot', view: 'threads', rect, at: 1_200 });
    expect(state).toMatchObject({ engaged: true, slotView: 'threads', rect });
    const left = fusionReducer(state, { type: 'slot', view: null, rect: null, at: 5_000 });
    expect(left).toMatchObject({ engaged: true, slotView: null, rect });
  });

  it('keeps switching when the page reports switching or no slot arrives within 2 s', () => {
    expect(run({ type: 'ready', mode: 'switching', at: 0 }, { type: 'slot', view: 'threads', rect, at: 10 }).engaged).toBe(false);
    expect(run({ type: 'ready', mode: 'fused', at: 0 }, { type: 'slot', view: 'threads', rect, at: 2_001 }).engaged).toBe(false);
    expect(run({ type: 'ready', mode: 'fused', at: 0 }, { type: 'slot', view: 'threads', rect, at: 2_000 }).engaged).toBe(true);
  });

  it('counts each new placement (engagement or view change), not a resize of the same one', () => {
    const once = run({ type: 'ready', mode: 'fused', at: 0 }, { type: 'slot', view: 'threads', rect, at: 1 });
    expect(once.slotSeq).toBe(1);
    expect(fusionReducer(once, { type: 'slot', view: 'threads', rect: { ...rect, width: 1100 }, at: 2 }).slotSeq).toBe(1);
    const through = [{ type: 'slot', view: null, rect: null, at: 3 } as const, { type: 'slot', view: 'threads', rect, at: 4 } as const].reduce(fusionReducer, once);
    expect(through.slotSeq).toBe(3);
    const again = [{ type: 'ready', mode: 'fused', at: 10 } as const, { type: 'slot', view: 'threads', rect, at: 11 } as const].reduce(fusionReducer, once);
    expect(again.slotSeq).toBe(2);
    expect(fusionReducer(run({ type: 'ready', mode: 'switching', at: 0 }), { type: 'slot', view: 'threads', rect, at: 1 }).slotSeq).toBe(0);
  });

  it('restarts the 2 s window on every ready: switching first, fused once the plugin pages load (F-1 order)', () => {
    const state = run(
      { type: 'ready', mode: 'switching', at: 0 },
      { type: 'slot', view: 'threads', rect, at: 10 },
      { type: 'ready', mode: 'fused', at: 5_000 },
      { type: 'slot', view: 'threads', rect, at: 5_020 },
    );
    expect(state).toMatchObject({ mode: 'fused', engaged: true, slotView: 'threads' });
  });

  it('disengages when Paperclip goes away, keeps the last placement, and re-engages after a new ready', () => {
    const fused = run({ type: 'ready', mode: 'fused', at: 0 }, { type: 'slot', view: 'threads', rect, at: 5 }, { type: 'overlay', open: true, regions: [], at: 6 });
    const offline = fusionReducer(fused, { type: 'offline' });
    expect(offline).toMatchObject({ engaged: false, overlayOpen: false, rect });
    expect(fusionReducer(offline, { type: 'slot', view: 'threads', rect, at: 50 }).engaged).toBe(false);
    const again = [{ type: 'ready', mode: 'fused', at: 100 } as const, { type: 'slot', view: 'threads', rect, at: 150 } as const].reduce(fusionReducer, offline);
    expect(again).toMatchObject({ engaged: true, slotView: 'threads' });
  });

  it('flags an overlay that stayed open for 60 s and waits another 60 s after asking', () => {
    const open = run({ type: 'ready', mode: 'fused', at: 0 }, { type: 'slot', view: 'threads', rect, at: 1 }, { type: 'overlay', open: true, regions: [], at: 1_000 });
    expect(overlayIsStale(open, 60_999)).toBe(false);
    expect(overlayIsStale(open, 61_000)).toBe(true);
    const asked = fusionReducer(open, { type: 'queried', at: 61_000 });
    expect(overlayIsStale(asked, 61_500)).toBe(false);
    expect(fusionReducer(asked, { type: 'overlay', open: false, regions: [], at: 61_010 }).overlayOpen).toBe(false);
  });
});

describe('notice holes', () => {
  it('cuts each notice out of an element in its own coordinates and ignores notices elsewhere', () => {
    const box = { x: 240, y: 48, width: 1200, height: 852 };
    expect(noticeClipPath(box, [])).toBe('');
    expect(noticeClipPath(box, [{ x: 1500, y: 0, width: 10, height: 10 }])).toBe('');
    expect(noticeClipPath(box, [{ x: 12, y: 820, width: 380, height: 52 }])).toBe(
      'polygon(evenodd, 0px 0px, 100% 0px, 100% 100%, 0px 100%, 0px 0px, 0px 772px, 152px 772px, 152px 824px, 0px 824px, 0px 772px, 0px 0px)'
    );
  });
});

describe('fused routes', () => {
  it('opens the matching Paperclip page for the company in the last route', () => {
    expect(fusedRoute('dashboard', '/ACME/issues/ACME-12')).toBe('/ACME/session-board');
    expect(fusedRoute('browse', '/ACME')).toBe('/ACME/browse');
    expect(fusedRoute('threads', '/instance/settings/adapters')).toBeNull();
    expect(fusedRoute('threads', '/')).toBeNull();
  });
});

// ---- The real <App /> in jsdom; Paperclip's document is played by messages from its frame. ----

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const EXTENSION_ID = 'tkextensionidtkextensionidtkexte';
const ORIGIN = 'http://localhost:3100';
let host: HTMLDivElement;
let root: Root;
let healthy = true;

function stubChrome() {
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  const area = () => ({ get: async () => ({}), set: async () => undefined, remove: async () => undefined });
  vi.stubGlobal('chrome', {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      getManifest: () => ({ manifest_version: 3, name: 'ThreadStack', version: '0.0.0', version_name: BUILD_INFO.versionName }),
      sendMessage: async (message: Record<string, unknown>) => {
        if (message.type === 'WORKSPACE_HELLO') return { ok: true, tabId: 1, embedding: true, realms: [] };
        if (message.type === 'PAPERCLIP_SERVICE_STATUS') return { ok: false, error: 'helper_not_installed' };
        return message.type === 'GET_DIAGNOSTICS' ? { ok: true, recentEvents: [] } : { ok: false };
      },
      onMessage: event(),
    },
    storage: { local: area(), session: area(), onChanged: event() },
    tabs: { query: async () => [], create: async () => undefined, onUpdated: event(), onActivated: event() },
    permissions: { request: async () => true, contains: async () => true, remove: async () => true, onAdded: event(), onRemoved: event() },
  });
}

async function tick(ms = 0) { await act(async () => { await new Promise((r) => setTimeout(r, ms)); }); }
async function waitFor(check: () => boolean, label: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await tick(10);
  }
}
async function settle() {
  let previous = '';
  for (let i = 0; i < 60; i++) {
    await tick(15);
    if (host.innerHTML === previous) return;
    previous = host.innerHTML;
  }
}
const q = <T extends Element = HTMLElement>(selector: string): T => {
  const element = host.querySelector<T>(selector);
  if (!element) throw new Error(`no element for ${selector}`);
  return element;
};
const frame = () => q<HTMLIFrameElement>('iframe.tk-paperclip-frame');
async function fromPaperclip(data: Record<string, unknown>) {
  await act(async () => {
    window.dispatchEvent(new MessageEvent('message', { origin: ORIGIN, source: frame().contentWindow, data: { source: 'paperclip-ui', v: 1, ...data } }));
  });
  await settle();
}
const sentToPaperclip = (spy: ReturnType<typeof vi.spyOn>) => spy.mock.calls.map((call) => call[0] as Record<string, unknown>);

async function mountFused(options: { hostEnabled?: boolean; address?: string; bootRoute?: string } = {}) {
  window.history.replaceState(null, '', options.address ?? '/manager.html?surface=page&view=threads&pc=%2FACME%2Fissues');
  await Promise.all(sharedDb.tables.map((t) => t.clear()));
  await ensureStarterCollectionsAndSettings(sharedDb);
  const paperclip = { ...DEFAULT_PAPERCLIP_SETTINGS, serverUrl: ORIGIN, deploymentMode: 'local_trusted' as const, hostEnabled: options.hostEnabled ?? true };
  await sharedDb.settings.update('default', { activeView: 'threads', paperclip } as Partial<SettingsRecord>);
  window.sessionStorage.setItem('threadkeeper.landed', '1');
  await seedSyntheticWorkbenchLibrary(sharedDb);
  await act(async () => root.render(<App />));
  await waitFor(() => host.querySelectorAll('.tk-row-item').length > 0, 'library rows');
  // hostEnabled: the frame loads while the server runs, before Paperclip was ever shown.
  await waitFor(() => Boolean(host.querySelector('iframe.tk-paperclip-frame')), 'eager Paperclip frame');
  await settle();
  const send = vi.spyOn(frame().contentWindow!, 'postMessage');
  const threads = q('.tk-view-threads');
  expect(host.querySelector('.tk-workbench')!.hasAttribute('data-fused')).toBe(false);
  await fromPaperclip({ type: 'ready', mode: 'fused' });
  if (options.bootRoute) {
    await fromPaperclip({ type: 'route', path: options.bootRoute, title: 'Paperclip' });
    await fromPaperclip({ type: 'slot', view: null, rect: null, scheme: 'dark' });
    return { send, threads };
  }
  await fromPaperclip({ type: 'route', path: '/ACME/threads', title: 'Threads' });
  await fromPaperclip({ type: 'slot', view: 'threads', rect: pageRect, scheme: 'dark' });
  return { send, threads };
}

// The content rectangle Paperclip reports inside jsdom's 1024x768 window.
const pageRect = { x: 200, y: 40, width: 800, height: 700 };

beforeEach(() => {
  healthy = true;
  stubChrome();
  vi.stubGlobal('fetch', vi.fn(async (input: unknown) => {
    if (!healthy) throw new TypeError('Paperclip is stopped in this fixture.');
    return new Response(JSON.stringify(String(input).endsWith('/api/health') ? { status: 'ok', deploymentMode: 'local_trusted' } : []), { status: 200 });
  }));
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  host.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fused window (real App)', () => {
  it('lays the same mounted Threads view over the reported rectangle with no second view switch (AC-3, AC-7, AC-9)', async () => {
    const { threads } = await mountFused();
    const workbench = q('.tk-workbench');
    expect(workbench.getAttribute('data-fused')).toBe('true');
    const shell = q('.tk-shell');
    expect([shell.style.left, shell.style.top, shell.style.width, shell.style.height]).toEqual(['200px', '40px', '800px', '700px']);
    expect(q('.tk-view-threads')).toBe(threads);
    expect(threads.hidden).toBe(false);
    expect(frame().style.colorScheme).toBe('dark');
    expect(q('.tk-view-paperclip').hidden).toBe(false);
    // One view switch in the window: Paperclip's sidebar. The rail is the view's left column.
    expect(host.querySelector('[role="radiogroup"][aria-label="View"]')).toBeNull();
    expect(host.querySelector('nav[aria-label="Views"]')).toBeNull();
    expect(shell.querySelector('.tk-rail .tk-rail-scroll')).not.toBeNull();
    const railButtons = Array.from(shell.querySelectorAll('.tk-rail button')).map((b) => b.getAttribute('aria-label') ?? b.textContent?.trim());
    expect(railButtons).toContain('Settings');
    expect(railButtons).toContain('Add account');
    expect(new URL(window.location.href).searchParams.get('pc')).toBe('/ACME/threads');
  });

  it('acknowledges each placement so the page turns transparent only under a placed view (F-2)', async () => {
    const { send } = await mountFused();
    const placed = () => sentToPaperclip(send).filter((m) => m.type === 'placed');
    expect(placed()).toEqual([{ source: 'threadkeeper-shell', v: 1, type: 'placed', view: 'threads' }]);
    await fromPaperclip({ type: 'route', path: '/ACME/issues', title: 'Tasks' });
    await fromPaperclip({ type: 'slot', view: null, rect: null, scheme: 'dark' });
    expect(placed().at(-1)).toEqual({ source: 'threadkeeper-shell', v: 1, type: 'placed', view: null });
    await fromPaperclip({ type: 'route', path: '/ACME/session-board', title: 'Session board' });
    await fromPaperclip({ type: 'slot', view: 'session-board', rect: pageRect, scheme: 'dark' });
    expect(placed().at(-1)).toEqual({ source: 'threadkeeper-shell', v: 1, type: 'placed', view: 'session-board' });
  });

  it('re-sends placed when ready+slot or slot null+slot view arrive in one batch (quality F-1)', async () => {
    const { send } = await mountFused();
    const placed = () => sentToPaperclip(send).filter((m) => m.type === 'placed').length;
    const batch = async (...messages: Record<string, unknown>[]) => {
      await act(async () => {
        for (const data of messages) window.dispatchEvent(new MessageEvent('message', { origin: ORIGIN, source: frame().contentWindow, data: { source: 'paperclip-ui', v: 1, ...data } }));
      });
      await settle();
    };
    const before = placed();
    await batch({ type: 'ready', mode: 'fused' }, { type: 'slot', view: 'threads', rect: pageRect, scheme: 'dark' });
    expect(placed()).toBe(before + 1);
    await batch({ type: 'slot', view: null, rect: null, scheme: 'dark' }, { type: 'slot', view: 'threads', rect: pageRect, scheme: 'dark' });
    expect(placed()).toBe(before + 2);
    expect(sentToPaperclip(send).filter((m) => m.type === 'placed').at(-1)).toEqual({ source: 'threadkeeper-shell', v: 1, type: 'placed', view: 'threads' });
  });

  it('switches views without engaging when the page is not fused (F-2 fallback)', async () => {
    const { send } = await mountFused();
    await fromPaperclip({ type: 'ready', mode: 'switching' });
    send.mockClear();
    await fromPaperclip({ type: 'slot', view: 'browse', rect: pageRect, scheme: 'dark' });
    await fromPaperclip({ type: 'open-view', view: 'browse' });
    expect(q('.tk-workbench').hasAttribute('data-fused')).toBe(false);
    expect(q('.tk-shell').getAttribute('data-view')).toBe('browse');
    expect(sentToPaperclip(send).filter((m) => m.type === 'placed')).toEqual([]);
  });

  it('fuses from a plain Threads entry once Paperclip is connected and running, and keeps its host grant (FR-6, round-3 observation)', async () => {
    // Settings "Connect" stores only the server; hostEnabled stays false until the window is hosted.
    await mountFused({ hostEnabled: false, address: '/manager.html?surface=page&view=threads' });
    expect(q('.tk-workbench').getAttribute('data-fused')).toBe('true');
    expect(q('.tk-shell').getAttribute('data-view')).toBe('threads');
    let stored: SettingsRecord | undefined;
    for (let i = 0; i < 50 && !stored?.paperclip.hostEnabled; i++) { await tick(20); stored = await sharedDb.settings.get('default'); }
    expect(stored?.paperclip.hostEnabled).toBe(true);
  });

  it('keeps a direct Threads entry while the real frame first reports its home page and stale empty slots', async () => {
    const { send, threads } = await mountFused({ address: '/manager.html?surface=page&view=threads', bootRoute: '/ACME/dashboard' });
    expect(q('.tk-shell').getAttribute('data-view')).toBe('threads');
    expect(threads.hidden).toBe(false);
    expect((await sharedDb.settings.get('default'))?.activeView).toBe('threads');
    expect(sentToPaperclip(send)).toContainEqual({ source: 'threadkeeper-shell', v: 1, type: 'navigate', path: '/ACME/threads' });
    await fromPaperclip({ type: 'slot', view: null, rect: null, scheme: 'dark' });
    expect(q('.tk-shell').getAttribute('data-view')).toBe('threads');
    await fromPaperclip({ type: 'route', path: '/ACME/threads', title: 'Threads' });
    await fromPaperclip({ type: 'slot', view: 'threads', rect: pageRect, scheme: 'dark' });
    expect(q('.tk-view-threads')).toBe(threads);
    expect(new URL(window.location.href).searchParams.get('pc')).toBe('/ACME/threads');
    // Once the requested view has arrived, normal sidebar navigation belongs to Paperclip.
    await fromPaperclip({ type: 'route', path: '/ACME/issues', title: 'Tasks' });
    await fromPaperclip({ type: 'slot', view: null, rect: null, scheme: 'dark' });
    expect(q('.tk-shell').getAttribute('data-view')).toBe('paperclip');
  });

  it('waits for the company route before navigating a direct entry, without losing the requested view', async () => {
    const { send } = await mountFused({ address: '/manager.html?surface=page&view=threads', bootRoute: '/' });
    expect(q('.tk-shell').getAttribute('data-view')).toBe('threads');
    // The frame may replay its initial '/', but there is no company destination yet.
    expect(sentToPaperclip(send).filter(m => m.type === 'navigate').every(m => m.path === '/')).toBe(true);
    await fromPaperclip({ type: 'route', path: '/ACME/dashboard', title: 'Dashboard' });
    expect(sentToPaperclip(send)).toContainEqual({ source: 'threadkeeper-shell', v: 1, type: 'navigate', path: '/ACME/threads' });
    expect(q('.tk-shell').getAttribute('data-view')).toBe('threads');
  });

  it('keeps an explicit Paperclip entry on its own page', async () => {
    const { send } = await mountFused({ address: '/manager.html?surface=page&view=paperclip', bootRoute: '/ACME/dashboard' });
    expect(q('.tk-shell').getAttribute('data-view')).toBe('paperclip');
    expect(sentToPaperclip(send).some(m => m.type === 'navigate' && m.path === '/ACME/threads')).toBe(false);
  });

  it('ignores a rectangle outside the window and keeps the placement (AC-11)', async () => {
    await mountFused();
    await fromPaperclip({ type: 'slot', view: 'threads', rect: { ...pageRect, width: 5000 }, scheme: 'dark' });
    await fromPaperclip({ type: 'slot', view: 'threads', rect: { ...pageRect, height: -1 }, scheme: 'dark' });
    const shell = q('.tk-shell');
    expect([shell.style.left, shell.style.width, shell.style.height]).toEqual(['200px', '800px', '700px']);
  });

  it('follows Paperclip pages without remounting views, and sends Paperclip to the page of a view the shell opens (AC-3)', async () => {
    const { send, threads } = await mountFused();
    const browse = q('.tk-view-browse');
    await fromPaperclip({ type: 'route', path: '/ACME/issues', title: 'Tasks' });
    await fromPaperclip({ type: 'slot', view: null, rect: null, scheme: 'dark' });
    expect(q('.tk-shell').getAttribute('data-view')).toBe('paperclip');
    expect(threads.hidden).toBe(true);
    expect(q('.tk-workbench').getAttribute('data-fused')).toBe('true');
    await fromPaperclip({ type: 'route', path: '/ACME/browse', title: 'Browse' });
    await fromPaperclip({ type: 'slot', view: 'browse', rect: { ...pageRect, x: 64, width: 936 }, scheme: 'dark' });
    expect(q('.tk-view-browse')).toBe(browse);
    expect(browse.hidden).toBe(false);
    expect(q('.tk-view-threads')).toBe(threads);
    expect(q('.tk-shell').style.left).toBe('64px');
    // Paperclip asks the shell to open a view itself (open-view): Paperclip goes to that page.
    send.mockClear();
    await fromPaperclip({ type: 'open-view', view: 'dashboard' });
    expect(sentToPaperclip(send)).toContainEqual({ source: 'threadkeeper-shell', v: 1, type: 'navigate', path: '/ACME/session-board' });
  });

  // Command+K from the view's search field; the thread-row case is the next test.
  it('raises Paperclip for a blocking overlay, opens its palette with Command+K from the view and returns focus (AC-4, AC-6)', async () => {
    const { send } = await mountFused();
    const row = q<HTMLInputElement>('.tk-rail input[type="search"]');
    row.focus();
    expect(document.activeElement).toBe(row);
    send.mockClear();
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })); });
    expect(sentToPaperclip(send)).toContainEqual({ source: 'threadkeeper-shell', v: 1, type: 'command', name: 'palette' });
    expect(document.activeElement).toBe(frame());
    await fromPaperclip({ type: 'overlay', open: true, regions: [] });
    expect(q('.tk-workbench').getAttribute('data-fused-raised')).toBe('true');
    await fromPaperclip({ type: 'overlay', open: false, regions: [] });
    expect(q('.tk-workbench').hasAttribute('data-fused-raised')).toBe(false);
    expect(document.activeElement).toBe(row);
  });

  it('opens the palette with Command+K on a thread row without moving the selection (AC-6, F-3)', async () => {
    const { send } = await mountFused();
    const selected = () => q('.tk-row-btn[aria-selected="true"] .tk-row-title').textContent;
    const row = q<HTMLButtonElement>('.tk-row-btn[aria-selected="true"]');
    const before = selected();
    row.focus();
    expect(document.activeElement).toBe(row);
    send.mockClear();
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(sentToPaperclip(send)).toContainEqual({ source: 'threadkeeper-shell', v: 1, type: 'command', name: 'palette' });
    expect(document.activeElement).toBe(frame());
    expect(selected()).toBe(before);
    // Control+K (other platforms) behaves the same.
    row.focus();
    send.mockClear();
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); });
    await settle();
    expect(sentToPaperclip(send)).toContainEqual({ source: 'threadkeeper-shell', v: 1, type: 'command', name: 'palette' });
    expect(selected()).toBe(before);
  });

  it('lowers the frame before the validated native close-message handler returns', async () => {
    await mountFused();
    await fromPaperclip({ type: 'overlay', open: true, regions: [] });
    expect(q('.tk-workbench').getAttribute('data-fused-raised')).toBe('true');
    // A browser message and the following pointer event are separate native tasks. Wrapping
    // this dispatch in act would hide the deferred React commit reproduced in round 24.
    const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    const previous = environment.IS_REACT_ACT_ENVIRONMENT;
    environment.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      window.dispatchEvent(new MessageEvent('message', { origin: ORIGIN, source: frame().contentWindow, data: { source: 'paperclip-ui', v: 1, type: 'overlay', open: false, regions: [] } }));
      expect(q('.tk-workbench').hasAttribute('data-fused-raised')).toBe(false);
    } finally {
      environment.IS_REACT_ACT_ENVIRONMENT = previous;
    }
    await settle();
  });

  it('recovers distinct existing Threads row presses after a close, with duplicate and expired packets refused', async () => {
    await mountFused();
    const rows = [...host.querySelectorAll<HTMLButtonElement>('.tk-row-btn')];
    const target = rows[3]!;
    const next = rows[4]!;
    const later = rows[5]!;
    const point = vi.fn((): Element => target);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const previous = Object.getOwnPropertyDescriptor(document, 'elementFromPoint');
    Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: point });
    const activate = (sequence = 1) => fromPaperclip({ type: 'slot-activate', view: 'threads', x: 250, y: 100, sequence });
    try {
      await activate(); // No overlay closed: no selection capability.
      expect(target.getAttribute('aria-selected')).toBe('false');
      await fromPaperclip({ type: 'overlay', open: true, regions: [] });
      await activate();
      expect(target.getAttribute('aria-selected')).toBe('false');
      await fromPaperclip({ type: 'overlay', open: false, regions: [] });
      // Even in the close window this channel cannot activate arbitrary toolbar controls.
      const control = q('button[aria-label="Delete"]');
      const clicked = vi.fn();
      control.addEventListener('click', clicked);
      point.mockReturnValue(control);
      await activate();
      expect(clicked).not.toHaveBeenCalled();
      point.mockReturnValue(target);
      await activate();
      expect(target.getAttribute('aria-selected')).toBe('true');
      expect(document.activeElement).toBe(target);
      point.mockReturnValue(next);
      await activate(); // A duplicate packet cannot select a second row.
      expect(next.getAttribute('aria-selected')).toBe('false');
      await activate(2); // A second physical press is still valid while Chromium catches up.
      expect(next.getAttribute('aria-selected')).toBe('true');
      point.mockReturnValue(later);
      await activate(1); // An old gesture cannot be replayed after a newer one.
      expect(later.getAttribute('aria-selected')).toBe('false');
      await fromPaperclip({ type: 'overlay', open: true, regions: [] });
      await fromPaperclip({ type: 'overlay', open: false, regions: [] });
      clock.mockReturnValue(now + 251);
      await activate(3);
      expect(later.getAttribute('aria-selected')).toBe('false');
      await fromPaperclip({ type: 'overlay', open: false, regions: [] });
      await activate(3); // Repeated closed reports cannot renew an expired close window.
      expect(later.getAttribute('aria-selected')).toBe('false');
      clock.mockReturnValue(now - 1);
      await activate(3); // A backward wall-clock adjustment cannot reopen the window either.
      expect(later.getAttribute('aria-selected')).toBe('false');
    } finally {
      clock.mockRestore();
      if (previous) Object.defineProperty(document, 'elementFromPoint', previous);
      else Reflect.deleteProperty(document, 'elementFromPoint');
    }
  });

  it('still moves through rows with plain j and k in fused mode', async () => {
    const { send } = await mountFused();
    const selected = () => q('.tk-row-btn[aria-selected="true"] .tk-row-title').textContent;
    const start = selected();
    q<HTMLButtonElement>('.tk-row-btn[aria-selected="true"]').focus();
    send.mockClear();
    await act(async () => { document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', bubbles: true, cancelable: true })); });
    await settle();
    const next = selected();
    expect(next).not.toBe(start);
    await act(async () => { (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, cancelable: true })); });
    await settle();
    expect(selected()).toBe(start);
    expect(sentToPaperclip(send)).not.toContainEqual(expect.objectContaining({ type: 'command' }));
  });

  it('leaves Command+K to the shell when it is outside fused mode', async () => {
    const { send } = await mountFused();
    await fromPaperclip({ type: 'ready', mode: 'switching' });
    expect(q('.tk-workbench').hasAttribute('data-fused')).toBe(false);
    const row = q<HTMLButtonElement>('.tk-row-item .tk-row-btn');
    row.focus();
    send.mockClear();
    await act(async () => { row.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true })); });
    expect(sentToPaperclip(send)).not.toContainEqual(expect.objectContaining({ type: 'command' }));
  });

  it('cuts a notice out of the view instead of raising Paperclip (AC-5)', async () => {
    await mountFused();
    const rail = q('.tk-shell > .tk-rail');
    rail.getBoundingClientRect = () => ({ x: 200, y: 40, left: 200, top: 40, width: 240, height: 700, right: 440, bottom: 740, toJSON() {} }) as DOMRect;
    await fromPaperclip({ type: 'overlay', open: false, regions: [{ x: 12, y: 680, width: 380, height: 52 }] });
    expect(q('.tk-workbench').hasAttribute('data-fused-raised')).toBe(false);
    expect(rail.style.clipPath).toBe('polygon(evenodd, 0px 0px, 100% 0px, 100% 100%, 0px 100%, 0px 0px, 0px 640px, 192px 640px, 192px 692px, 0px 692px, 0px 640px, 0px 0px)');
    await fromPaperclip({ type: 'overlay', open: false, regions: [] });
    expect(rail.style.clipPath).toBe('');
  });

  it('moves the notice holes when the window is resized, without waiting for a render (quality F-4)', async () => {
    await mountFused();
    const rail = q('.tk-shell > .tk-rail');
    let left = 200;
    rail.getBoundingClientRect = () => ({ x: left, y: 40, left, top: 40, width: 240, height: 700, right: left + 240, bottom: 740, toJSON() {} }) as DOMRect;
    await fromPaperclip({ type: 'overlay', open: false, regions: [{ x: 12, y: 680, width: 380, height: 52 }] });
    expect(rail.style.clipPath).toContain('192px 640px');
    left = 100;
    await act(async () => { window.dispatchEvent(new Event('resize')); });
    expect(rail.style.clipPath).toContain('240px 640px');
  });

  it('asks Paperclip about an overlay open for 60 s and restores the view when it reports none (FR-3 negative)', async () => {
    const { send } = await mountFused();
    const now = Date.now();
    await fromPaperclip({ type: 'overlay', open: true, regions: [] });
    send.mockClear();
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000);
    await tick(1_100);
    expect(sentToPaperclip(send)).toContainEqual({ source: 'threadkeeper-shell', v: 1, type: 'overlay-query' });
    await fromPaperclip({ type: 'overlay', open: false, regions: [] });
    expect(q('.tk-workbench').hasAttribute('data-fused-raised')).toBe(false);
  });

  it('shows the shell rail with Threads still mounted when the server stops, and fuses again on ready (AC-8)', async () => {
    const { threads } = await mountFused();
    healthy = false;
    await fromPaperclip({ type: 'disconnected' });
    await waitFor(() => !q('.tk-workbench').hasAttribute('data-fused'), 'switching layout');
    expect(q('.tk-view-threads')).toBe(threads);
    expect(threads.hidden).toBe(false);
    expect(host.querySelector('[role="radiogroup"][aria-label="View"]')).not.toBeNull();
    expect([q('.tk-shell').style.left, q('.tk-shell').style.width]).toEqual(['', '']);
    healthy = true;
    // The next health check (5 s while stopped) sees the server; the reloaded page then says ready
    // again, as Paperclip's hello retry does, until the shell is running and fused.
    const end = Date.now() + 8_000;
    while (q('.tk-workbench').getAttribute('data-fused') !== 'true') {
      if (Date.now() > end) throw new Error('fused mode did not resume');
      await fromPaperclip({ type: 'ready', mode: 'fused' });
      await fromPaperclip({ type: 'slot', view: 'threads', rect: pageRect, scheme: 'dark' });
      await tick(250);
    }
    expect(q('.tk-view-threads')).toBe(threads);
    expect(q('.tk-shell').getAttribute('data-view')).toBe('threads');
  }, 20_000);
});
