import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DashboardView } from '../../src/entrypoints/manager/dashboard/DashboardView.js';
import { WorkspaceProvider, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import { FrameStage } from '../../src/entrypoints/manager/workspace/FrameStage.js';
import { threadTabId } from '../../src/entrypoints/manager/workspace/state.js';
import type { WorkspaceController, FrameRuntime } from '../../src/entrypoints/manager/workspace/useWorkspace.js';
import { EMPTY_WORKSPACE_STATE, type SessionTab, type WorkspaceState } from '../../src/core/workspace/types.js';
import { DEFAULT_SETTINGS, type ConversationRecord, type SettingsRecord } from '../../src/core/schema.js';
import { realmById } from '../../src/core/workspace/realms.js';
import type { AccountRecord, RealmAccounts } from '../../src/core/workspace/types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtime: FrameRuntime = { frameId: null, loaded: false, canGoBack: false, canGoForward: false, agentState: null, reloads: 0 };

function conv(key: string, title: string, over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    threadKey: key,
    provider: 'claude_code',
    accountId: 'primary~anthropic',
    title,
    manualTitleOverride: null,
    canonicalUrl: `https://claude.ai/code/${key}`,
    pinned: true,
    workflowState: 'active',
    isSyntheticBenchmark: false,
    updatedAt: '2026-01-01T00:00:00Z',
    lastCapturedAt: '2026-01-01T00:00:00Z',
    agentState: null,
    agentStateAt: null,
    ...over,
  } as unknown as ConversationRecord;
}

function tabFor(key: string): SessionTab {
  return { id: threadTabId(key), provider: 'claude_code', realm: 'anthropic', accountId: 'primary~anthropic', url: `https://claude.ai/code/${key}`, title: key, threadKey: key, createdAt: 1, lastActiveAt: 1 };
}

let container: HTMLDivElement;
let root: Root;
let dispatch: ReturnType<typeof vi.fn>;
let openThread: ReturnType<typeof vi.fn>;
let openSession: ReturnType<typeof vi.fn>;
let togglePinned: ReturnType<typeof vi.fn>;
let setView: ReturnType<typeof vi.fn>;
let patchSettings: ReturnType<typeof vi.fn>;

interface MountExtras {
  settings?: Partial<SettingsRecord>;
  realms?: RealmAccounts[];
  accountOf?: WorkspaceContextValue['accountOfThread'];
}

function mount(convs: ConversationRecord[], dashboard: Partial<WorkspaceState['dashboard']> = {}, tabs: SessionTab[] = [], view: 'dashboard' | 'browse' = 'dashboard', extras: MountExtras = {}) {
  const state: WorkspaceState = {
    ...EMPTY_WORKSPACE_STATE,
    tabs,
    dashboard: { ...EMPTY_WORKSPACE_STATE.dashboard, ...dashboard },
  };
  const workspace = {
    ready: true,
    embedding: true,
    error: null,
    realms: extras.realms ?? [],
    state,
    plan: { live: [], resting: {} },
    runtime: () => runtime,
    dispatch,
    openThread,
    noteFrameLoaded: vi.fn(),
  } as unknown as WorkspaceController;
  const value = {
    surface: 'page',
    workspace,
    settings: extras.settings ? { ...DEFAULT_SETTINGS, ...extras.settings } : null,
    patchSettings,
    view,
    setView,
    detailMode: 'summary',
    setDetailMode: vi.fn(),
    conversations: convs,
    conversationByKey: new Map(convs.map((c) => [c.threadKey, c])),
    insightsByThread: new Map(),
    summariesByThread: new Map(),
    selectedThreadKey: null,
    accountOfThread:
      extras.accountOf ?? (() => ({ realm: null, account: { label: 'Work', color: 'teal', mode: 'embedded' }, active: true, switchable: true })),
    openSession,
    togglePinned,
    openInChromeTab: vi.fn(),
    requestAddAccount: vi.fn(),
    openSettings: vi.fn(),
    announce: vi.fn(),
  } as unknown as WorkspaceContextValue;
  act(() =>
    root.render(
      <WorkspaceProvider value={value}>
        <FrameStage workspace={workspace}>
          <DashboardView />
        </FrameStage>
      </WorkspaceProvider>
    )
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  dispatch = vi.fn();
  openThread = vi.fn(() => ({ ok: true, tabId: 'x' }));
  openSession = vi.fn();
  togglePinned = vi.fn(async () => {});
  setView = vi.fn();
  patchSettings = vi.fn(async () => undefined);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const pins = () => [...container.querySelectorAll<HTMLButtonElement>('.tk-dash-pin')];

describe('DashboardView', () => {
  const a = conv('a', 'Alpha', { updatedAt: '2026-01-01T00:00:00Z' });
  const b = conv('b', 'Beta', { updatedAt: '2026-03-01T00:00:00Z' });
  const c = conv('c', 'Gamma', { updatedAt: '2026-02-01T00:00:00Z' });

  it('lists pinned sessions most recently updated first, without archived or unpinned ones', () => {
    mount([a, b, c, conv('d', 'Archived', { workflowState: 'archived' }), conv('e', 'Loose', { pinned: false })]);
    expect(pins().map((p) => p.querySelector('.tk-dash-pin-label')?.textContent)).toEqual(['Beta', 'Gamma', 'Alpha']);
  });

  it('opens a pressed session without activating Browse and places it in the focused pane', () => {
    mount([a, b], { layout: 2, panes: [null, null], focusedPane: 1 });
    act(() => pins()[0].click());
    expect(openThread).toHaveBeenCalledWith(b, { activate: false });
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_pane', index: 1, threadKey: 'b' });
  });

  it('changes the number of panes through the layout control', () => {
    mount([a]);
    const group = container.querySelector('[role="radiogroup"]')!;
    const four = group.querySelector<HTMLButtonElement>('[aria-label="4 panes"]')!;
    act(() => four.click());
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_layout', layout: 4 });
  });

  it('gives each pane a slot for its thread tab and a name', () => {
    mount([a, b], { layout: 2, panes: ['a', 'b'], focusedPane: 0 }, [tabFor('a'), tabFor('b')]);
    expect(container.querySelector(`[data-tab="${threadTabId('a')}"]`)).not.toBeNull();
    const first = container.querySelector('section[aria-label="Pane 1: Alpha"]')!;
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(container.querySelector('section[aria-label="Pane 2: Beta"]')!.getAttribute('aria-current')).toBeNull();
  });

  it('opens the tab of a pane that has none, without activating Browse', () => {
    mount([a], { layout: 1, panes: ['a'], focusedPane: 0 }, []);
    expect(openThread).toHaveBeenCalledWith(a, { activate: false });
  });

  it('focuses a pane from its header', () => {
    mount([a, b], { layout: 2, panes: ['a', 'b'], focusedPane: 0 }, [tabFor('a'), tabFor('b')]);
    const second = container.querySelector<HTMLButtonElement>('[data-pane-focus="1"]')!;
    act(() => second.click());
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_focus', index: 1 });
  });

  it('unpins and opens in Browse from the pane header', () => {
    mount([a], { layout: 1, panes: ['a'], focusedPane: 0 }, [tabFor('a')]);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Unpin Alpha from dashboard"]')!.click());
    expect(togglePinned).toHaveBeenCalledWith(a);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Open Alpha in Browse"]')!.click());
    expect(openSession).toHaveBeenCalledWith(a, 'browse');
  });

  it('swaps a session from the menu and closes it with Escape, returning focus', () => {
    mount([a, b], { layout: 2, panes: ['a', null], focusedPane: 0 }, [tabFor('a')]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Swap session in pane 1"]')!;
    act(() => trigger.click());
    const items = container.querySelectorAll('[role="menuitem"]');
    expect(items).toHaveLength(1);
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    act(() => (container.querySelector('[role="menuitem"]') as HTMLButtonElement).click());
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_pane', index: 0, threadKey: 'b' });
  });

  it('clears a pane whose thread is no longer pinned', () => {
    mount([conv('a', 'Alpha', { pinned: false }), b], { layout: 2, panes: ['a', null], focusedPane: 0 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_pane', index: 0, threadKey: null });
    expect(container.querySelector('section[aria-label="Pane 1: Alpha"]')).toBeNull();
  });

  it('offers unplaced pinned sessions in an empty pane, or says all are placed', () => {
    mount([a, b], { layout: 2, panes: ['a', null], focusedPane: 1 }, [tabFor('a')]);
    const empty = container.querySelector('section[aria-label="Pane 2: empty"]')!;
    expect(empty.textContent).toContain('Nothing in this pane');
    act(() => empty.querySelector<HTMLButtonElement>('.tk-btn')!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_pane', index: 1, threadKey: 'b' });
    mount([a], { layout: 2, panes: ['a', null], focusedPane: 1 }, [tabFor('a')]);
    expect(container.querySelector('section[aria-label="Pane 2: empty"]')!.textContent).toContain('already in a pane');
  });

  it('shows one notice with a way to Threads when nothing is pinned', () => {
    mount([conv('a', 'Alpha', { pinned: false })]);
    expect(container.textContent).toContain('No pinned sessions yet');
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === 'Go to Threads')!.click());
    expect(setView).toHaveBeenCalledWith('threads');
  });

  it('sends a session with no web page to Threads and says why', () => {
    const doc = conv('n', 'Notes', { canonicalUrl: 'file:///notes.md' });
    mount([doc]);
    expect(pins()[0].title).toContain('no web page');
    act(() => pins()[0].click());
    expect(openSession).toHaveBeenCalledWith(doc, 'threads');
    expect(openThread).not.toHaveBeenCalled();
  });

  it('focuses a pane with Alt+number only while the dashboard is showing', () => {
    mount([a, b], { layout: 2, panes: ['a', 'b'], focusedPane: 0 }, [tabFor('a'), tabFor('b')]);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true })));
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_focus', index: 1 });
    dispatch.mockClear();
    mount([a, b], { layout: 2, panes: ['a', 'b'], focusedPane: 0 }, [tabFor('a'), tabFor('b')], 'browse');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true })));
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'dashboard_focus', index: 1 });
  });
});

describe('DashboardView: organizing the pinned bar', () => {
  const claudeRealm = realmById('anthropic')!;
  const acct = (id: string, label: string, color: AccountRecord['color'], primary = false): AccountRecord => ({
    id,
    realm: 'anthropic',
    label,
    color,
    mode: 'embedded',
    primary,
    identity: null,
    signedIn: 'yes',
    hasJar: false,
    order: 0,
    createdAt: '2026-01-01T00:00:00Z',
    lastActiveAt: null,
  });
  const WORK = acct('primary~anthropic', 'Work', 'teal', true);
  const PERSONAL = acct('acct_personal', 'Personal', 'peach');
  const twoAccounts: RealmAccounts[] = [{ realm: claudeRealm, accounts: [WORK, PERSONAL], activeAccountId: WORK.id }];
  const accountOf: WorkspaceContextValue['accountOfThread'] = (c) => {
    const own = [WORK, PERSONAL].find((a) => a.id === c.accountId) ?? null;
    return { realm: claudeRealm, account: own, active: own?.id === WORK.id, switchable: true };
  };

  const code1 = conv('code1', 'Alpha importer', { updatedAt: '2026-03-01T00:00:00Z', messageCount: 5 } as Partial<ConversationRecord>);
  const code2 = conv('code2', 'Beta bundle', { updatedAt: '2026-02-01T00:00:00Z', provider: 'codex', accountId: 'acct_personal', messageCount: 50 } as Partial<ConversationRecord>);
  const chat = conv('chat1', 'Gamma notes', { updatedAt: '2026-01-15T00:00:00Z', provider: 'claude', canonicalUrl: 'https://claude.ai/chat/chat1' });
  const bot = conv('bot1', 'Delta digest', { updatedAt: '2026-01-05T00:00:00Z', provider: 'grok_bot', canonicalUrl: '' });
  const library = [code1, code2, chat, bot];

  const organize = () => [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Organize')) ?? null;
  const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Organize sessions"]');
  const menuItem = (name: string) =>
    [...(menu()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])].find((el) => el.textContent?.startsWith(name)) ?? null;
  const labels = () => pins().map((p) => p.querySelector('.tk-dash-pin-label')?.textContent);
  const clusters = () => [...container.querySelectorAll<HTMLElement>('.tk-dash-cluster')];
  const click = (el: Element | null | undefined) => act(() => (el as HTMLElement).click());

  it('puts the Organize button in the bar, before the pins', () => {
    mount(library);
    const button = organize()!;
    expect(button.closest('.tk-dash-bar')).not.toBeNull();
    expect(button.compareDocumentPosition(container.querySelector('.tk-dash-pins')!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(button.querySelector('.tk-org-badge')).toBeNull();
    // Not grouped by default: the pins are one flat row, as before.
    expect(clusters()).toHaveLength(0);
    expect(labels()).toEqual(['Alpha importer', 'Beta bundle', 'Gamma notes', 'Delta digest']);
  });

  it('offers None, Type and Provider (no Account with one account) and the five orders', () => {
    mount(library);
    click(organize());
    const radios = [...menu()!.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].map((r) => r.textContent);
    expect(radios).toEqual(['None', 'Type', 'Provider', 'Recent activity', 'Oldest first', 'Recently created', 'Title A–Z', 'Most messages']);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(organize());
  });

  it('adds Account once a sign-in has two accounts', () => {
    mount(library, {}, [], 'dashboard', { realms: twoAccounts, accountOf });
    click(organize());
    expect(menuItem('Account')!.getAttribute('role')).toBe('menuitemradio');
    expect(menuItem('Claude · Personal')!.textContent).toContain(', 1 session');
  });

  it('saves the chosen grouping and order in the settings', () => {
    mount(library);
    click(organize());
    click(menuItem('Provider'));
    expect(patchSettings).toHaveBeenCalledWith({ dashboardLens: { groupBy: 'provider', sortBy: 'recent' } });
    click(menuItem('Title A–Z'));
    expect(patchSettings).toHaveBeenLastCalledWith({ dashboardLens: { groupBy: 'none', sortBy: 'title' } });
  });

  it('orders the pins by the saved order', () => {
    mount(library, {}, [], 'dashboard', { settings: { dashboardLens: { groupBy: 'none', sortBy: 'title' } } });
    expect(labels()).toEqual(['Alpha importer', 'Beta bundle', 'Delta digest', 'Gamma notes']);
    mount(library, {}, [], 'dashboard', { settings: { dashboardLens: { groupBy: 'none', sortBy: 'messages' } } });
    expect(labels()[0]).toBe('Beta bundle');
    mount(library, {}, [], 'dashboard', { settings: { dashboardLens: { groupBy: 'none', sortBy: 'oldest' } } });
    expect(labels()).toEqual(['Delta digest', 'Gamma notes', 'Beta bundle', 'Alpha importer']);
  });

  it('puts the pins in labelled clusters by type, provider or account', () => {
    mount(library, {}, [], 'dashboard', { settings: { dashboardLens: { groupBy: 'kind', sortBy: 'recent' } } });
    expect(clusters().map((c) => c.getAttribute('aria-label'))).toEqual(['Coding sessions, 2 sessions', 'Chats, 1 session', 'Bots, 1 session']);
    expect(clusters().map((c) => c.querySelector('.tk-dash-cluster-label')?.textContent)).toEqual(['Coding sessions2', 'Chats1', 'Bots1']);
    expect([...clusters()[0].querySelectorAll('.tk-dash-pin-label')].map((n) => n.textContent)).toEqual(['Alpha importer', 'Beta bundle']);

    mount(library, {}, [], 'dashboard', { settings: { dashboardLens: { groupBy: 'provider', sortBy: 'recent' } } });
    // One each, so by name.
    expect(clusters().map((c) => c.getAttribute('aria-label'))).toEqual(['Claude, 1 session', 'Claude Code, 1 session', 'Codex, 1 session', 'Grok Bot, 1 session']);
    expect(clusters()[0].querySelector('.tk-mark')).not.toBeNull();

    mount(library, {}, [], 'dashboard', {
      realms: twoAccounts,
      accountOf,
      settings: { dashboardLens: { groupBy: 'account', sortBy: 'recent' } },
    });
    // Sign-in order (Work, then Personal), each named "<Sign-in> · <Account>".
    expect(clusters().map((c) => c.getAttribute('aria-label'))).toEqual(['Claude · Work, 3 sessions', 'Claude · Personal, 1 session']);
    expect(clusters()[1].querySelector('.tk-acct')!.getAttribute('data-active')).toBe('false');
  });

  it('narrows the pins by a filter, counts it on the button and clears it', () => {
    mount(library);
    click(organize());
    click(menuItem('Chats'));
    expect(labels()).toEqual(['Gamma notes']);
    expect(organize()!.querySelector('.tk-org-badge')?.textContent).toBe('1');
    expect(menuItem('Reset')).not.toBeNull();
    click(menuItem('Bots'));
    expect(labels()).toEqual(['Gamma notes', 'Delta digest']);
    click(menuItem('Reset'));
    expect(labels()).toHaveLength(4);
    expect(organize()!.querySelector('.tk-org-badge')).toBeNull();
  });

  it('says so, with a way back, when the filters hide every pinned session', () => {
    mount(library);
    click(organize());
    click(menuItem('Chats'));
    click(menuItem('Codex'));
    expect(labels()).toEqual([]);
    const note = container.querySelector('.tk-dash-nomatch')!;
    expect(note.textContent).toBe('No pinned sessions match Chats, Codex.Clear');
    expect(container.querySelector('.tk-dash-pins')!.querySelector('.tk-dash-pin')).toBeNull();
    click(note.querySelector('button'));
    expect(container.querySelector('.tk-dash-nomatch')).toBeNull();
    expect(labels()).toHaveLength(4);
  });

  it('keeps a session that is already in a pane in its pane when the filter hides its chip', () => {
    mount(library, { layout: 2, panes: ['code1', null], focusedPane: 0 }, [tabFor('code1')]);
    click(organize());
    click(menuItem('Chats'));
    expect(labels()).toEqual(['Gamma notes']);
    // Alpha's chip is gone, but it is still showing in pane 1 and can still be swapped.
    expect(container.querySelector('section[aria-label="Pane 1: Alpha importer"]')).not.toBeNull();
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'dashboard_pane', index: 0, threadKey: null });
    click(container.querySelector('[aria-label="Swap session in pane 1"]'));
    const swapItems = [...container.querySelectorAll('[role="menuitem"]')].map((el) => el.textContent ?? '');
    expect(swapItems.some((t) => t.includes('Gamma notes'))).toBe(true);
    expect(swapItems.some((t) => t.includes('Delta digest'))).toBe(false);
  });

  it('tells an empty pane that the filters hide the other pinned sessions, with a way back', () => {
    mount(library, { layout: 2, panes: ['code1', null], focusedPane: 1 }, [tabFor('code1')]);
    click(organize());
    click(menuItem('Bots'));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    // Only the bot is offered and it has no web page; Beta and Gamma are hidden by the filter.
    const empty = () => container.querySelector<HTMLElement>('section[aria-label="Pane 2: empty"]')!;
    expect(empty().textContent).toContain('2 more pinned sessions are hidden by the Dashboard filters.');
    expect(empty().textContent).not.toContain('already in a pane');
    const clear = [...empty().querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent === 'Clear filters');
    click(clear);
    expect(labels()).toHaveLength(4);
    const offered = [...empty().querySelectorAll<HTMLButtonElement>('.tk-btn')].map((b) => b.querySelector('.tk-ellipsis')?.textContent);
    expect(offered).toEqual(['Beta bundle', 'Gamma notes']);
  });

  it('keeps the filters when the dashboard is shown again, and never saves them', () => {
    mount(library);
    click(organize());
    click(menuItem('Bots'));
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(labels()).toEqual(['Delta digest']);
    mount(library, {}, [], 'browse');
    mount(library);
    expect(labels()).toEqual(['Delta digest']);
    expect(patchSettings).not.toHaveBeenCalled();
  });
});
