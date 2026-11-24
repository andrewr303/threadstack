// Characterization of the manager workbench (src/entrypoints/manager/App.tsx): the real <App /> in
// jsdom over the synthetic library, with the rendered DOM recorded per state and the keyboard and
// click behaviour asserted. These snapshots record the integrated workspace and the side panel;
// a markup, class, id, attribute, text, focus or persistence change fails here.
import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../src/entrypoints/manager/App.js';
import { sharedDb } from '../../src/entrypoints/manager/shared.js';
import { BUILD_INFO } from '../../src/core/build-info.js';
import { ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { processThreadsLocally } from '../../src/core/pipeline.js';
import { seedSyntheticWorkbenchLibrary } from '../../src/core/synthetic-fixtures.js';
import { realmById } from '../../src/core/workspace/realms.js';
import type { AccountRecord, RealmAccounts } from '../../src/core/workspace/types.js';
import type { SettingsRecord } from '../../src/core/schema.js';
import { DEFAULT_PAPERCLIP_SETTINGS } from '../../src/core/schema.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const SNAP = (name: string) => `./__snapshots__/manager-app/${name}.html`;
const EXTENSION_ID = 'tkextensionidtkextensionidtkexte';
const CHATGPT_TAB_URL = 'https://chatgpt.com/c/conv_daydock_logo_grid';

// ---- chrome stub ---------------------------------------------------------------------------------

interface ChromeStub {
  sent: Array<Record<string, unknown>>;
  tabUrl: string;
  helloRealms: RealmAccounts[];
}

function stubChrome(): ChromeStub {
  const stub: ChromeStub = { sent: [], tabUrl: '', helloRealms: [] };
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  const area = () => ({
    get: async () => ({}),
    set: async () => undefined,
    remove: async () => undefined,
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: EXTENSION_ID,
      getURL: (path: string) => `chrome-extension://${EXTENSION_ID}/${path}`,
      getManifest: () => ({ manifest_version: 3, name: 'ThreadStack', version: '0.0.0', version_name: BUILD_INFO.versionName }),
      sendMessage: async (message: Record<string, unknown>) => {
        stub.sent.push(message);
        if (message.type === 'WORKSPACE_HELLO') return { ok: true, tabId: 1, embedding: true, realms: stub.helloRealms };
        if (message.type === 'PAPERCLIP_INTEGRATION' && message.action === 'status') return { ok: true, data: { serverUrl: 'http://localhost:3100', companies: {}, policy: { enabled: false, providers: [], disabledAt: 0 }, allowRemoteModels: false, shareTranscripts: false } };
        if (message.type === 'PAPERCLIP_SERVICE_STATUS') return { ok: false, error: 'helper_not_installed' };
        return message.type === 'GET_DIAGNOSTICS' ? { ok: true, recentEvents: [] } : { ok: false };
      },
      onMessage: event(),
    },
    storage: { local: area(), session: area(), onChanged: event() },
    tabs: {
      query: async () => (stub.tabUrl ? [{ id: 1, url: stub.tabUrl, active: true }] : []),
      create: async () => undefined,
      onUpdated: event(),
      onActivated: event(),
    },
    permissions: {
      request: async () => true,
      contains: async () => true,
      remove: async () => true,
      onAdded: event(),
      onRemoved: event(),
    },
  });
  return stub;
}

// jsdom has no <dialog> methods; this is the browser contract the app relies on: showModal and
// close flip the `open` attribute, and close fires a `close` event.
function polyfillDialog(): () => void {
  const proto = HTMLDialogElement.prototype as unknown as Record<string, unknown>;
  const saved = { showModal: proto.showModal, close: proto.close };
  proto.showModal = function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close = function (this: HTMLDialogElement) {
    if (!this.hasAttribute('open')) return;
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
  return () => {
    proto.showModal = saved.showModal;
    proto.close = saved.close;
  };
}

// ---- DOM recording -------------------------------------------------------------------------------

const MONTHS = 'Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec';

/** Times, dates and build identity change per run; everything else must match exactly. */
function normalizeText(text: string): string {
  return text
    .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<iso-time>')
    .replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/g, '<date-time>')
    .replace(new RegExp(`\\b(?:just now|yesterday|\\d+[mhd] ago|(?:${MONTHS}) \\d{1,2}(?:, \\d{4})?)(?![\\w])`, 'g'), '<relative-time>')
    .split(BUILD_INFO.buildId).join('<build-id>')
    .split(BUILD_INFO.builtAt).join('<built-at>')
    .split(EXTENSION_ID).join('<extension-id>');
}

function attrs(el: Element): string {
  return Array.from(el.attributes)
    .map((a) => ` ${a.name}="${normalizeText(a.value)}"`)
    .join('');
}

/** React sets these as properties, so they are not in the markup; record them too. */
function liveState(el: Element): string {
  if (el instanceof HTMLInputElement) {
    return el.type === 'checkbox' || el.type === 'radio' ? ` {checked=${el.checked}}` : ` {value=${JSON.stringify(normalizeText(el.value))}}`;
  }
  if (el instanceof HTMLSelectElement) return ` {value=${JSON.stringify(el.value)}}`;
  if (el instanceof HTMLTextAreaElement) return ` {value=${JSON.stringify(normalizeText(el.value))}}`;
  if (el instanceof HTMLDetailsElement) return ` {open=${el.open}}`;
  return '';
}

function dump(node: Node, depth: number, out: string[]): void {
  const pad = '  '.repeat(depth);
  if (node.nodeType === Node.TEXT_NODE) {
    const text = normalizeText((node.textContent ?? '').replace(/\s+/g, ' ').trim());
    if (text) out.push(`${pad}${JSON.stringify(text)}`);
    return;
  }
  if (!(node instanceof Element)) return;
  const tag = node.tagName.toLowerCase();
  out.push(`${pad}<${tag}${attrs(node)}>${liveState(node)}`);
  for (const child of Array.from(node.childNodes)) dump(child, depth + 1, out);
}

function snapshotOf(root: ParentNode): string {
  const target = root.querySelector('.tk-workbench');
  if (!target) throw new Error('.tk-workbench not rendered');
  const out: string[] = [];
  dump(target, 0, out);
  return `${out.join('\n')}\n`;
}

// ---- Harness -------------------------------------------------------------------------------------

let host: HTMLDivElement;
let root: Root;
let chromeStub: ChromeStub;
let restoreDialog: () => void;

async function tick(ms = 0) {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

async function waitFor(check: () => boolean, label: string, ms = 4000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
    await tick(10);
  }
}

/** Wait until the DOM has stopped changing (async loads and persisted-setting round trips). */
async function settle() {
  let previous = '';
  for (let i = 0; i < 60; i++) {
    await tick(15);
    const now = host.innerHTML;
    if (now === previous) {
      await tick(15);
      if (host.innerHTML === now) return;
    }
    previous = now;
  }
  throw new Error('DOM did not settle');
}

function q<T extends Element = HTMLElement>(selector: string): T {
  const el = host.querySelector<T>(selector);
  if (!el) throw new Error(`no element for ${selector}`);
  return el;
}

function qa<T extends Element = HTMLElement>(selector: string): T[] {
  return Array.from(host.querySelectorAll<T>(selector));
}

/** A button by its visible text, or by its accessible name when it shows only an icon. */
function button(text: string | RegExp, within: ParentNode = host): HTMLButtonElement {
  const names = (b: HTMLButtonElement) => [(b.textContent ?? '').trim(), b.getAttribute('aria-label') ?? ''];
  const found = Array.from(within.querySelectorAll('button')).find((b) =>
    names(b).some((name) => (typeof text === 'string' ? name === text : text.test(name)))
  );
  if (!found) throw new Error(`no button ${String(text)}`);
  return found;
}

async function click(el: Element) {
  await act(async () => {
    (el as HTMLElement).click();
  });
  await settle();
}

async function setValue(el: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const proto =
      el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value')!.set!.call(el, value);
    el.dispatchEvent(new Event(el instanceof HTMLSelectElement ? 'change' : 'input', { bubbles: true }));
  });
  await settle();
}

async function press(key: string, target: Element = document.body) {
  await act(async () => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  });
  await settle();
}

const rowTitles = () => qa('.tk-row-item .tk-row-title').map((el) => el.textContent);
const selectedRowTitle = () => q('.tk-row-btn[aria-selected="true"] .tk-row-title').textContent;
const openDialogs = () => qa<HTMLDialogElement>('dialog').filter((d) => d.hasAttribute('open')).map((d) => d.id || d.getAttribute('aria-label') || d.className);
const settingsRow = () => sharedDb.settings.get('default');

/** sessionStorage key: this browser tab has already landed on the start page (App.tsx). */
const LANDED_KEY = 'threadkeeper.landed';

/**
 * Fresh library, fresh DOM: every scenario starts from the same seeded state. The page surface
 * lands on the start page once per browser tab; scenarios about a view say the tab has already
 * landed (the default) so they record that view, and `land: true` lets the landing happen.
 */
async function mountApp(options: { surface?: 'sidepanel'; tabUrl?: string; land?: boolean; settings?: Partial<SettingsRecord> } = {}) {
  await Promise.all(sharedDb.tables.map((t) => t.clear()));
  await ensureStarterCollectionsAndSettings(sharedDb);
  if (options.settings) await sharedDb.settings.update('default', options.settings);
  window.sessionStorage.clear();
  if (!options.land) window.sessionStorage.setItem(LANDED_KEY, '1');
  await seedSyntheticWorkbenchLibrary(sharedDb);
  // Analysis the app would otherwise run itself right after opening; done up front so the DOM is
  // not changing under the recording.
  const keys = (await sharedDb.conversations.toArray()).filter((c) => !c.isSyntheticBenchmark).map((c) => c.threadKey);
  await processThreadsLocally(sharedDb, keys, { aiDelaySeconds: 0 });
  chromeStub.sent.length = 0;
  chromeStub.tabUrl = options.tabUrl ?? '';
  if (options.surface) document.documentElement.dataset.surface = options.surface;
  await act(async () => root.render(<App />));
  await waitFor(() => qa('.tk-row-item').length > 0, 'library rows');
  await settle();
}

beforeEach(() => {
  // Only Date is frozen: queue membership ("worth revisiting", "recently changed") and every
  // relative time depend on the clock, and timers must keep running for the async loads.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-10T12:00:00.000Z'));
  chromeStub = stubChrome();
  // The host's real local Paperclip service must not decide these fixtures' connection state.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Paperclip is stopped in this fixture.'); }));
  restoreDialog = polyfillDialog();
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  window.sessionStorage.clear();
  window.history.replaceState(null, '', '/');
  host.remove();
  delete document.documentElement.dataset.surface;
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-density');
  restoreDialog();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---- (a) and (b): rendered DOM per state ---------------------------------------------------------

describe('manager workbench DOM', () => {
  it('page surface, library just opened', async () => {
    await mountApp();
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-initial'));
  });

  it('page surface, another row selected', async () => {
    await mountApp();
    const before = selectedRowTitle();
    await click(qa('.tk-row-item .tk-row-btn')[2]);
    expect(selectedRowTitle()).not.toBe(before);
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-row-selected'));
  });

  it('page surface, evidence passage opened in the detail pane', async () => {
    await mountApp();
    await click(q('.tk-focal-left-off .tk-evidence-marker'));
    expect(q('.tk-focal-left-off .tk-evidence-passage-box').getAttribute('role')).toBe('region');
    const decisionMarker = host.querySelector<HTMLElement>('[data-evidence-location="decisions"] .tk-evidence-marker');
    if (decisionMarker) await click(decisionMarker);
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-evidence-open'));
  });

  it('page surface, kanban view', async () => {
    await mountApp();
    await setValue(q<HTMLSelectElement>('select[aria-label="View mode"]'), 'kanban');
    expect(qa('.tk-kanban-col').length).toBeGreaterThan(0);
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-kanban'));
  });

  it('page surface, cards view', async () => {
    await mountApp();
    await setValue(q<HTMLSelectElement>('select[aria-label="View mode"]'), 'cards');
    expect(qa('.tk-project-card').length).toBeGreaterThan(0);
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-cards'));
  });

  it('page surface, Settings dialog open', async () => {
    await mountApp();
    await click(button('Settings', q('.tk-header')));
    expect(openDialogs().length).toBe(1);
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-settings-open'));
  });

  it('page surface, Organize dialog open', async () => {
    await mountApp();
    await click(button('Organize…'));
    expect(openDialogs()).toEqual(['tk-organize-dialog']);
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-organize-open'));
  });

  it('page surface, Organize dialog with a typed instruction and its keyword preview', async () => {
    await mountApp();
    await click(button('Organize…'));
    await setValue(q<HTMLInputElement>('input[aria-label="Natural language organization instruction"]'), 'put logo threads in Brand work');
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-organize-instruction'));
  });

  it('page surface, nav rail collapsed', async () => {
    await mountApp();
    await click(q('button[aria-label="Collapse navigation"]'));
    expect(q('.tk-shell').getAttribute('data-rail-collapsed')).toBe('true');
    expect(q('.tk-rail').getAttribute('data-collapsed')).toBe('true');
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-nav-collapsed'));
  });

  it('page surface, resurfacing queue chosen', async () => {
    await mountApp();
    await click(button(/^Needs review/, q('.tk-nav')));
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-queue-needs-review'));
  });

  it('page surface, Ask mode', async () => {
    await mountApp();
    await click(button('Ask', q('.tk-segmented')));
    expect(host.querySelector('input[type="search"]')).toBeNull();
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-ask'));
  });

  it('page surface, a row checked shows the bulk bar', async () => {
    await mountApp();
    await click(qa<HTMLInputElement>('.tk-row-check input')[1]);
    expect(host.querySelector('.tk-bulk-bar')).not.toBeNull();
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-row-checked'));
  });

  it('page surface, search narrows the list', async () => {
    await mountApp();
    await setValue(q<HTMLInputElement>('input[type="search"]'), 'meridian');
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('page-search-meridian'));
  });

  it('side panel surface', async () => {
    await mountApp({ surface: 'sidepanel' });
    expect(q('.tk-workbench').getAttribute('data-surface')).toBe('sidepanel');
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('sidepanel-initial'));
  });

  it('side panel surface, conversation open in the active tab', async () => {
    await mountApp({ surface: 'sidepanel', tabUrl: CHATGPT_TAB_URL });
    await waitFor(() => host.querySelector('.tk-this-tab') !== null, 'the active-tab row');
    await settle();
    await expect(snapshotOf(host)).toMatchFileSnapshot(SNAP('sidepanel-active-tab'));
  });
});

// ---- (c): interactions ---------------------------------------------------------------------------

describe('manager workbench interactions', () => {
  it('preserves a deep link while settings hydrate and clears it only for a later server change', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => new Response(JSON.stringify(String(input).endsWith('/api/health')
      ? { status: 'ok', deploymentMode: 'local_trusted' }
      : []), { status: 200 })));
    window.history.replaceState(null, '', '/manager.html?surface=page&view=paperclip&pc=%2FACME%2Fissues');
    const paperclip = { ...DEFAULT_PAPERCLIP_SETTINGS, serverUrl: 'http://localhost:3217', deploymentMode: 'local_trusted' as const };
    await mountApp({ settings: { paperclip } });
    await waitFor(() => Boolean(host.querySelector('iframe.tk-paperclip-frame')), 'Paperclip frame');
    await settle();
    expect(q<HTMLIFrameElement>('iframe.tk-paperclip-frame').src).toBe('http://localhost:3217/ACME/issues');
    expect(new URL(window.location.href).searchParams.get('pc')).toBe('/ACME/issues');
    const first = q<HTMLIFrameElement>('iframe.tk-paperclip-frame');
    await sharedDb.settings.update('default', { paperclip: { ...paperclip, serverUrl: 'http://localhost:3333' } });
    window.dispatchEvent(new Event('focus'));
    await waitFor(() => host.querySelector<HTMLIFrameElement>('iframe.tk-paperclip-frame')?.src === 'http://localhost:3333/', 'new Paperclip origin');
    await settle();
    expect(q('iframe.tk-paperclip-frame')).not.toBe(first);
    expect(new URL(window.location.href).searchParams.get('pc')).toBe('/');
  });
  it('uses the existing sidebar as the only Threads index and opens it for the search shortcut', async () => {
    await mountApp({ settings: { sidebarCollapsed: true } });
    expect(qa('.tk-list-pane')).toHaveLength(1);
    expect(q('.tk-list-pane').closest('.tk-rail')).not.toBeNull();
    expect(host.querySelector('.tk-main .tk-columns > .tk-list-pane')).toBeNull();
    await press('/');
    expect(q('.tk-rail').getAttribute('data-collapsed')).toBe('false');
    expect(document.activeElement).toBe(q('.tk-search-input'));
    expect((await settingsRow())!.sidebarCollapsed).toBe(false);
  });

  it('opens the narrow navigation drawer and focuses search with one slash press', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 899px)', media: query,
      addEventListener() {}, removeEventListener() {},
    }));
    await mountApp();
    expect(q('.tk-rail').getAttribute('data-collapsed')).toBe('true');
    await press('/');
    expect(q('.tk-rail').getAttribute('data-drawer-open')).toBe('true');
    expect(document.activeElement).toBe(q('.tk-search-input'));
    await click(q('.tk-list-sidebar .tk-row-btn'));
    expect(q('.tk-rail').getAttribute('data-drawer-open')).toBe('false');
  });

  it('search reopens navigation after the person collapses it during the same visit', async () => {
    await mountApp();
    await click(q('button[aria-label="Collapse navigation"]'));
    expect(q('.tk-rail').getAttribute('data-collapsed')).toBe('true');
    await press('/');
    expect(q('.tk-rail').getAttribute('data-collapsed')).toBe('false');
    expect(document.activeElement).toBe(q('.tk-search-input'));
  });

  it('opens Paperclip in a dedicated frame and preserves it while switching views', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: unknown) => new Response(JSON.stringify(String(input).endsWith('/api/health')
      ? { status: 'ok', deploymentMode: 'local_trusted' }
      : []), { status: 200 })));
    await mountApp();
    await click(button('Paperclip', q('[role="radiogroup"][aria-label="View"]')));
    const frame = q<HTMLIFrameElement>('iframe.tk-paperclip-frame');
    expect(frame.src).toBe('http://localhost:3100/');
    expect(q('.tk-shell').getAttribute('data-view')).toBe('paperclip');
    // The rail stays as the person left it beside Paperclip (the design keeps it expanded).
    expect(q('.tk-rail').getAttribute('data-collapsed')).toBe('false');
    expect(frame.hasAttribute('data-tab')).toBe(false);
    await click(q('button[aria-label="Browse"]'));
    expect(q('iframe.tk-paperclip-frame')).toBe(frame);
    await click(button('Paperclip', q('[role="radiogroup"][aria-label="View"]')));
    expect(q('iframe.tk-paperclip-frame')).toBe(frame);
  });
  it('Escape dismisses a menu in the drawer before the narrow workspace drawer', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 899px)', media: query,
      addEventListener() {}, removeEventListener() {},
    }));
    const accounts: AccountRecord[] = ['work', 'personal'].map((id, order) => ({
      id, realm: 'anthropic', label: id, color: 'teal', mode: 'embedded', primary: order === 0,
      identity: null, signedIn: 'unknown', hasJar: false, order,
      createdAt: '2026-11-01T00:00:00.000Z', lastActiveAt: null,
    }));
    chromeStub.helloRealms = [{ realm: realmById('anthropic')!, accounts, activeAccountId: 'work' }];
    await mountApp({ settings: { activeView: 'browse' } });
    await click(q('button[aria-label="Expand navigation"]'));
    // Accounts moved to Settings; the Sessions list's Organize menu is the drawer's menu now.
    await click(q('.tk-rail .tk-rail-heading button'));
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    expect(menu).not.toBeNull();
    await press('Escape', menu);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(q('.tk-rail').getAttribute('data-drawer-open')).toBe('true');
    await press('Escape');
    expect(q('.tk-rail').getAttribute('data-drawer-open')).toBe('false');
  });

  it('Escape closes a dialog, then the narrow workspace drawer, then the checked rows', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(max-width: 899px)', media: query,
      addEventListener() {}, removeEventListener() {},
    }));
    await mountApp();
    await click(qa<HTMLInputElement>('.tk-row-check input')[0]);
    await click(q('button[aria-label="Expand navigation"]'));
    const rail = q('.tk-rail');
    expect(rail.getAttribute('data-drawer-open')).toBe('true');
    await click(button('Threads', q('[role="radiogroup"][aria-label="View"]')));
    expect(rail.getAttribute('data-drawer-open')).toBe('true');
    // A native inner dialog may open while navigation is showing. Its Escape belongs to it.
    const dialog = q<HTMLDialogElement>('#tk-organize-dialog');
    await act(async () => dialog.showModal());
    await press('Escape');
    expect(dialog.open).toBe(false);
    expect(rail.getAttribute('data-drawer-open')).toBe('true');
    expect(qa<HTMLInputElement>('.tk-row-check input')[0].checked).toBe(true);
    await press('Escape');
    expect(rail.getAttribute('data-drawer-open')).toBe('false');
    expect(qa<HTMLInputElement>('.tk-row-check input')[0].checked).toBe(true);
    vi.setSystemTime(new Date(Date.now() + 200));
    await press('Escape');
    expect(qa<HTMLInputElement>('.tk-row-check input').every((input) => !input.checked)).toBe(true);
  });

  it('"/" focuses the search box', async () => {
    await mountApp();
    expect(document.activeElement).not.toBe(q('input[type="search"]'));
    await press('/');
    expect(document.activeElement).toBe(q('input[type="search"]'));
  });

  it('"/" in Ask mode switches back to search and focuses the box on the first press', async () => {
    await mountApp();
    await click(button('Ask', q('.tk-segmented')));
    expect(host.querySelector('input[type="search"]')).toBeNull();
    await press('/');
    expect(button('Search', q('.tk-segmented')).getAttribute('aria-selected')).toBe('true');
    // Focus follows the mode change after the search input is mounted.
    expect(document.activeElement).toBe(q('input[type="search"]'));
  });

  it('"/" is left alone while typing in a field', async () => {
    await mountApp();
    const input = q<HTMLInputElement>('input[type="search"]');
    input.focus();
    const event = new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
  });

  it('"j" and "k" move the opened thread and focus its row', async () => {
    await mountApp();
    const titles = rowTitles();
    expect(titles.length).toBeGreaterThan(2);
    await click(qa('.tk-row-item .tk-row-btn')[0]);
    expect(selectedRowTitle()).toBe(titles[0]);
    await press('j');
    expect(selectedRowTitle()).toBe(titles[1]);
    expect(document.activeElement).toBe(qa('.tk-row-item .tk-row-btn')[1]);
    await press('j');
    expect(selectedRowTitle()).toBe(titles[2]);
    await press('k');
    expect(selectedRowTitle()).toBe(titles[1]);
    await press('k');
    await press('k');
    expect(selectedRowTitle()).toBe(titles[0]);
    const persisted = (await settingsRow())?.lastSelectedThreadKey;
    expect(typeof persisted).toBe('string');
    await press('j');
    expect((await settingsRow())?.lastSelectedThreadKey).not.toBe(persisted);
  });

  it('Escape closes the innermost dialog first, then the next', async () => {
    await mountApp();
    await click(button('Settings', q('.tk-header')));
    await click(button('Organize…'));
    expect(openDialogs().sort()).toEqual(expect.arrayContaining(['tk-organize-dialog']));
    expect(openDialogs().length).toBe(2);
    await press('Escape');
    expect(openDialogs().length).toBe(1);
    expect(openDialogs()).not.toContain('tk-organize-dialog');
    await press('Escape');
    expect(openDialogs()).toEqual([]);
  });

  it('Escape clears checked rows once no dialog is open', async () => {
    await mountApp();
    await click(qa<HTMLInputElement>('.tk-row-check input')[0]);
    expect(qa<HTMLInputElement>('.tk-row-check input')[0].checked).toBe(true);
    await press('Escape');
    expect(qa<HTMLInputElement>('.tk-row-check input').every((i) => !i.checked)).toBe(true);
    expect(q('[role="status"].tk-visually-hidden').textContent).toBe('Selection cleared.');
  });

  it('typing in search filters the rows and persists the query', async () => {
    await mountApp();
    const all = rowTitles();
    await setValue(q<HTMLInputElement>('input[type="search"]'), 'meridian');
    const filtered = rowTitles();
    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.length).toBeLessThan(all.length);
    expect((await settingsRow())?.lastSearchQuery).toBe('meridian');
    await setValue(q<HTMLInputElement>('input[type="search"]'), 'zzzz-no-such-thread');
    expect(host.querySelector('.tk-empty-state')?.textContent).toContain('No conversations match the current filter');
  });

  it('the row checkbox selects a row without opening it, and select-all reaches the whole view', async () => {
    await mountApp();
    const opened = selectedRowTitle();
    const checks = qa<HTMLInputElement>('.tk-row-check input');
    await click(checks[1]);
    expect(qa<HTMLInputElement>('.tk-row-check input')[1].checked).toBe(true);
    expect(selectedRowTitle()).toBe(opened);
    expect(q('.tk-bulk-bar')).toBeTruthy();
    expect(qa('.tk-row-item').filter((li) => li.getAttribute('data-checked') === 'true').length).toBe(1);
  });

  it.each(['page', 'sidepanel'] as const)('the %s theme toggle persists the new theme and flips the document theme', async (surface) => {
    await mountApp(surface === 'sidepanel' ? { surface } : {});
    expect((await settingsRow())?.theme).toBe('system');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    await click(q('button[aria-label="Toggle color theme"]'));
    expect((await settingsRow())?.theme).toBe('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    const toggle = q('button[aria-label="Toggle color theme"]');
    if (surface === 'page') expect(toggle.getAttribute('title')).toBe('Switch to light theme');
    else expect(toggle.textContent).toBe('Dark');
    if (surface === 'page') {
      await click(q('.tk-rail-head button[aria-label="Settings"]'));
      const density = qa('label').find((label) => label.textContent?.trim().startsWith('Density'))!.querySelector('select')!;
      await setValue(density, 'compact');
    } else await click(q('button[aria-label="Toggle density"]'));
    expect((await settingsRow())?.density).toBe('compact');
    expect(document.documentElement.getAttribute('data-density')).toBe('compact');
  });

  it('collapsing the nav rail persists, and the view mode select persists', async () => {
    await mountApp();
    await click(q('button[aria-label="Collapse navigation"]'));
    expect((await settingsRow())?.sidebarCollapsed).toBe(true);
    await setValue(q<HTMLSelectElement>('select[aria-label="View mode"]'), 'cards');
    expect((await settingsRow())?.viewMode).toBe('cards');
  });

  it('choosing a project filters the list and remembers the area', async () => {
    await mountApp();
    const all = rowTitles().length;
    const projectButton = qa<HTMLButtonElement>('.tk-nav .tk-nav-item').find((b) => !/All threads|New project/.test(b.textContent ?? '') && !/^0$/.test(b.querySelector('.tk-nav-count')?.textContent ?? ''));
    expect(projectButton).toBeTruthy();
    const name = projectButton!.querySelector('.tk-ellipsis')?.textContent?.replace(/ auto$/, '') ?? '';
    await click(projectButton!);
    expect(rowTitles().length).toBeLessThanOrEqual(all);
    expect((await settingsRow())?.lastActiveArea).toBe(name);
    expect(q('.tk-nav [aria-current="true"]')).toBeTruthy();
  });

  it('a new project is created from the nav rail', async () => {
    await mountApp();
    await click(button('+ New project'));
    const input = q<HTMLInputElement>('input[aria-label="New project name"]');
    await setValue(input, 'Characterization Project');
    await act(async () => {
      q('form.tk-nav-new').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await settle();
    expect(await sharedDb.collections.get('Characterization Project')).toMatchObject({ origin: 'user', isStarterArea: false });
    expect(qa('.tk-nav .tk-nav-item').some((b) => (b.textContent ?? '').includes('Characterization Project'))).toBe(true);
    expect(q('[role="status"].tk-visually-hidden').textContent).toContain('Created project Characterization Project.');
  });

  it('manual edits, status and project change are written through to the library', async () => {
    await mountApp();
    const selectedTitle = q('.tk-detail-title').textContent;
    expect(selectedTitle).toBeTruthy();
    await setValue(q<HTMLInputElement>('input[aria-label="Manual title override"]'), 'Characterized title');
    await setValue(q<HTMLTextAreaElement>('textarea[aria-label="Manual workbench notes"]'), 'Characterized notes');
    await setValue(q<HTMLInputElement>('input[aria-label="Manual tags"]'), 'alpha, beta');
    await click(button('Save notes & overrides'));
    const edited = (await sharedDb.conversations.toArray()).find((c) => c.manualTitleOverride === 'Characterized title');
    expect(edited).toBeTruthy();
    expect(edited!.manualNotes).toBe('Characterized notes');
    expect(edited!.tags).toEqual(expect.arrayContaining(['alpha', 'beta']));
    expect(q('.tk-detail-title').textContent).toBe('Characterized title');
    expect(q('[role="status"].tk-visually-hidden').textContent).toBe('Saved manual title, tags, and notes.');

    await setValue(q<HTMLSelectElement>('select[aria-label="Change workflow state"]'), 'done');
    expect((await sharedDb.conversations.get(edited!.threadKey))?.workflowState).toBe('done');
    expect(q('[role="status"].tk-visually-hidden').textContent).toBe('Updated status to done.');

    const projectSelect = q<HTMLSelectElement>('select[aria-label="Assign project or area"]');
    const other = Array.from(projectSelect.options).map((o) => o.value).find((v) => v !== projectSelect.value)!;
    await setValue(projectSelect, other);
    const moved = await sharedDb.conversations.get(edited!.threadKey);
    expect(moved?.project).toBe(other);
    expect(moved?.categoryLocked).toBe(true);
    expect(q('[role="status"].tk-visually-hidden').textContent).toBe(`Filed under ${other} (locked).`);
  });

  it('Delete removes the opened thread and announces it', async () => {
    await mountApp();
    const before = (await sharedDb.conversations.count());
    await click(button('Delete', q('.tk-detail-header')));
    expect(await sharedDb.conversations.count()).toBe(before - 1);
    // The announcement follows the tombstone write; on a busy machine it can land a moment later.
    await waitFor(() => (q('[role="status"].tk-visually-hidden').textContent ?? '') !== '', 'delete announcement');
    expect(q('[role="status"].tk-visually-hidden').textContent).toMatch(/^Deleted ".+" and recorded tombstone\.$/);
  });

  it.each(['page', 'sidepanel'] as const)('the %s registers only when needed and keeps local preferences local', async (surface) => {
    await mountApp(surface === 'sidepanel' ? { surface } : {});
    await click(button('Settings', q('.tk-header')));
    await press('Escape');
    await click(q('button[aria-label="Toggle color theme"]'));
    const types = chromeStub.sent.map((m) => m.type);
    // Opening Settings does not change background-relevant settings; closing it reloads the library only.
    expect(types.filter((t) => t === 'SETTINGS_CHANGED')).toEqual([]);
    expect(types.every((t) => typeof t === 'string')).toBe(true);
    // Workspace registration is independent of the library loads and belongs only to a full tab.
    expect(types.filter((type) => type === 'WORKSPACE_HELLO')).toHaveLength(surface === 'page' ? 1 : 0);
    expect(types.filter((type) => !['WORKSPACE_HELLO', 'PAPERCLIP_INTEGRATION', 'PAPERCLIP_SERVICE_STATUS'].includes(String(type)))).toEqual([
      'GET_HISTORY_SYNC_STATE', 'DOCK_GET_STATE', 'GET_DIAGNOSTICS', 'GET_DIAGNOSTICS',
    ]);
    expect(types.filter((type) => type === 'PAPERCLIP_SERVICE_STATUS')).toHaveLength(surface === 'page' ? 1 : 0);
    expect(chromeStub.sent.filter((message) => message.type === 'PAPERCLIP_INTEGRATION').every(message => message.action === 'status')).toBe(true);
  });

  it('remembers the Threads order across a reload', async () => {
    await mountApp();
    const sort = () => q<HTMLSelectElement>('select[aria-label="Sort threads"]');
    expect(sort().value).toBe('recent');
    await setValue(sort(), 'created');
    expect((await settingsRow())?.threadsSort).toBe('created');
    // A reload: same database, a fresh page.
    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () => root.render(<App />));
    await waitFor(() => qa('.tk-row-item').length > 0, 'library rows');
    await settle();
    expect(sort().value).toBe('created');
  });

  it('"Show all" in the side navigation opens Threads narrowed to that type, with a chip to remove it', async () => {
    await mountApp({ settings: { activeView: 'browse' } });
    const chatsHead = qa<HTMLButtonElement>('.tk-rail-group-head').find((b) => b.textContent?.includes('Chats'))!;
    expect(chatsHead).toBeTruthy();
    const showAll = qa<HTMLButtonElement>('.tk-rail-more').find((b) => /chats/i.test(b.getAttribute('aria-label') ?? ''))!;
    expect(showAll).toBeTruthy();
    const total = rowTitles().length;
    await click(showAll);
    expect(q<HTMLSelectElement>('select[aria-label="Filter by type"]').value).toBe('chats');
    expect(q('.tk-thr-chips')!.textContent).toContain('Type: Chats');
    // The test library holds only chats, so narrowing to Chats keeps every row (the narrowing
    // itself is covered in threads-view.test.tsx).
    expect(rowTitles().length).toBe(total);
    await click(button('Clear filters'));
    expect(q<HTMLSelectElement>('select[aria-label="Filter by type"]').value).toBe('all');
    expect(rowTitles().length).toBe(total);
  });

  it('the sidebar Organize menu regroups the rail and the choice is saved', async () => {
    await mountApp({ settings: { activeView: 'browse' } });
    const organize = qa<HTMLButtonElement>('.tk-rail-heading button').find((b) => b.textContent?.includes('Organize'))!;
    await click(organize);
    const provider = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find((el) => el.textContent === 'Provider')!;
    await click(provider);
    expect((await settingsRow())?.railLens).toEqual({ groupBy: 'provider', sortBy: 'recent' });
    expect(qa('.tk-rail-group-head').some((b) => b.textContent?.includes('ChatGPT'))).toBe(true);
  });
});

// ---- Landing on the start page --------------------------------------------------------------------

describe('manager workbench landing', () => {
  const view = () => host.querySelector('.tk-workbench')!.getAttribute('data-view');
  /** Browse's session tabs (the Threads list has a Search / Ask tab pair of its own). */
  const sessionTabs = () => qa('.tk-browse-tabs [role="tab"]');
  /** Date is frozen in this file, so a wait is counted in ticks, not in time. */
  async function until(check: () => boolean | Promise<boolean>, label: string, ticks = 300) {
    for (let i = 0; i < ticks; i++) {
      if (await check()) return;
      await tick(10);
    }
    throw new Error(`timed out waiting for ${label}`);
  }
  const storedTabs = async () => {
    const row = await sharedDb.kv.get('workspace.state');
    return ((row?.value as { tabs?: Array<{ url: string }> } | undefined)?.tabs ?? []).map((t) => t.url);
  };

  it('opens Claude Code in Browse the first time the page opens in a browser tab', async () => {
    await mountApp({ land: true });
    await until(() => view() === 'browse', 'the Browse view');
    expect((await settingsRow())?.activeView).toBe('browse');
    await until(() => sessionTabs().length === 1, 'one session tab');
    expect(sessionTabs()[0].getAttribute('aria-label')).toContain('Claude Code');
    // The tab is kept, so a reload of the page comes back to it.
    await until(async () => (await storedTabs()).length > 0, 'the stored tab');
    expect(await storedTabs()).toEqual(['https://claude.ai/code']);
    expect(window.sessionStorage.getItem(LANDED_KEY)).toBe('1');
  });

  it('lands on the start page chosen in Settings', async () => {
    await mountApp({ land: true, settings: { startPage: 'https://chatgpt.com/codex' } });
    await until(() => sessionTabs().length === 1, 'one session tab');
    expect(sessionTabs()[0].getAttribute('aria-label')).toContain('Codex');
    expect(view()).toBe('browse');
  });

  it('stays where the person left off when they chose that, or once the tab has already landed', async () => {
    await mountApp({ land: true, settings: { startPage: '' } });
    expect(view()).toBe('threads');
    expect(sessionTabs()).toHaveLength(0);
    await act(async () => root.unmount());
    root = createRoot(host);
    // A reload of the page (which is how the workspace changes accounts) does not land again.
    await mountApp({ land: false });
    expect(view()).toBe('threads');
    expect(sessionTabs()).toHaveLength(0);
  });

  it('follows a link that names a thread instead of landing', async () => {
    window.history.replaceState(null, '', '/manager.html?threadKey=chatgpt%3Aacct_chatgpt_primary%3Aws_personal%3Anot-there%3Amain');
    await mountApp({ land: true });
    expect(view()).toBe('threads');
    expect(sessionTabs()).toHaveLength(0);
  });

  it('never lands on the side panel', async () => {
    await mountApp({ surface: 'sidepanel', land: true });
    expect(sessionTabs()).toHaveLength(0);
    expect((await settingsRow())?.activeView).not.toBe('browse');
  });
});
