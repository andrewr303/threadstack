import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Rail, type RailProps } from '../../src/entrypoints/manager/shell/Rail.js';
import { WorkspaceProvider, type ThreadAccount, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import { threadTabId } from '../../src/entrypoints/manager/workspace/state.js';
import type { WorkspaceController } from '../../src/entrypoints/manager/workspace/useWorkspace.js';
import { realmById } from '../../src/core/workspace/realms.js';
import {
  EMPTY_WORKSPACE_STATE,
  type AccountRecord,
  type RealmAccounts,
  type SessionTab,
  type WorkspaceState,
} from '../../src/core/workspace/types.js';
import { DEFAULT_SETTINGS, type ConversationRecord, type SettingsRecord } from '../../src/core/schema.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const claudeRealm = realmById('anthropic')!;

function account(id: string, label: string, over: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id,
    realm: 'anthropic',
    label,
    color: 'teal',
    mode: 'embedded',
    primary: id.startsWith('primary~'),
    identity: null,
    signedIn: 'yes',
    hasJar: false,
    order: 0,
    createdAt: '2026-01-01T00:00:00Z',
    lastActiveAt: null,
    ...over,
  };
}

const WORK = account('primary~anthropic', 'Work');
const PERSONAL = account('acct_personal', 'Personal', { color: 'peach' });

/** A session updated `minutesAgo` minutes before a fixed moment, so order is predictable. */
function conv(key: string, title: string, minutesAgo: number, over: Partial<ConversationRecord> = {}): ConversationRecord {
  const at = new Date(Date.UTC(2026, 10, 10, 12, 0) - minutesAgo * 60_000).toISOString();
  return {
    threadKey: key,
    provider: 'claude_code',
    accountId: WORK.id,
    title,
    manualTitleOverride: null,
    canonicalUrl: `https://claude.ai/code/${key}`,
    pinned: false,
    workflowState: 'active',
    isSyntheticBenchmark: false,
    updatedAt: at,
    lastCapturedAt: at,
    agentState: null,
    agentStateAt: null,
    ...over,
  } as unknown as ConversationRecord;
}

function threadTab(key: string): SessionTab {
  return {
    id: threadTabId(key),
    provider: 'claude_code',
    realm: 'anthropic',
    accountId: WORK.id,
    url: `https://claude.ai/code/${key}`,
    title: key,
    threadKey: key,
    createdAt: 1,
    lastActiveAt: 1,
  };
}

interface MountOptions {
  conversations?: ConversationRecord[];
  state?: Partial<WorkspaceState>;
  live?: string[];
  realms?: RealmAccounts[];
  error?: string | null;
  view?: RailProps['view'];
  selectedThreadKey?: string | null;
  accountOf?: (conv: Pick<ConversationRecord, 'provider' | 'accountId'>) => ThreadAccount;
  rail?: Partial<RailProps>;
  children?: React.ReactNode;
  /** Settings the lens reads its saved group and sort from. */
  settings?: Partial<SettingsRecord>;
  /** The session palette's opener, as App provides it when the palette is on. */
  openPalette?: () => void;
}

let container: HTMLDivElement;
let root: Root;
let dispatch: ReturnType<typeof vi.fn>;
let openSession: ReturnType<typeof vi.fn>;
let setView: ReturnType<typeof vi.fn>;
let showInThreads: ReturnType<typeof vi.fn>;
let patchSettings: ReturnType<typeof vi.fn>;
let requestAddAccount: ReturnType<typeof vi.fn>;
let onViewChange: ReturnType<typeof vi.fn>;
let onToggleCollapsed: ReturnType<typeof vi.fn>;
let onToggleTheme: ReturnType<typeof vi.fn>;
let onOpenSettings: ReturnType<typeof vi.fn>;

const signedInAsWork: RealmAccounts[] = [{ realm: claudeRealm, accounts: [WORK], activeAccountId: WORK.id }];

function mount(options: MountOptions = {}) {
  const conversations = options.conversations ?? [];
  const realms = options.realms ?? signedInAsWork;
  const workspace = {
    enabled: true,
    ready: true,
    embedding: options.error ? false : true,
    error: options.error ?? null,
    realms,
    state: { ...EMPTY_WORKSPACE_STATE, ...options.state },
    plan: { live: options.live ?? [], resting: {} },
    runtime: () => ({ frameId: null, loaded: false, canGoBack: false, canGoForward: false, agentState: null, reloads: 0 }),
    switchingRealm: null,
    dispatch,
  } as unknown as WorkspaceController;
  const accountOfThread =
    options.accountOf ??
    ((c: Pick<ConversationRecord, 'provider' | 'accountId'>): ThreadAccount => {
      const entry = realms.find((r) => r.realm.id === 'anthropic');
      const own = entry?.accounts.find((a) => a.id === c.accountId) ?? null;
      return { realm: claudeRealm, account: own, active: entry?.activeAccountId === c.accountId, switchable: true };
    });
  const view = options.view ?? 'browse';
  const value = {
    surface: 'page',
    workspace,
    settings: options.settings ? { ...DEFAULT_SETTINGS, ...options.settings } : null,
    patchSettings,
    showInThreads,
    view,
    setView,
    detailMode: 'summary',
    setDetailMode: vi.fn(),
    conversations,
    conversationByKey: new Map(conversations.map((c) => [c.threadKey, c])),
    insightsByThread: new Map(),
    summariesByThread: new Map(),
    selectedThreadKey: options.selectedThreadKey ?? null,
    accountOfThread,
    openSession,
    togglePinned: vi.fn(async () => {}),
    openInChromeTab: vi.fn(),
    requestAddAccount,
    openSettings: vi.fn(),
    announce: vi.fn(),
    openPalette: options.openPalette,
    paletteEnabled: Boolean(options.openPalette),
  } as unknown as WorkspaceContextValue;
  const props: RailProps = {
    collapsed: false,
    drawerOpen: false,
    view,
    effectiveTheme: 'dark',
    onViewChange,
    onToggleCollapsed,
    onCloseDrawer: vi.fn(),
    onToggleTheme,
    onOpenSettings,
    ...options.rail,
  };
  act(() =>
    root.render(
      <WorkspaceProvider value={value}>
        <Rail {...props}>{options.children}</Rail>
      </WorkspaceProvider>
    )
  );
}

beforeEach(() => {
  dispatch = vi.fn();
  openSession = vi.fn();
  setView = vi.fn();
  showInThreads = vi.fn();
  patchSettings = vi.fn(async () => undefined);
  requestAddAccount = vi.fn();
  onViewChange = vi.fn();
  onToggleCollapsed = vi.fn();
  onToggleTheme = vi.fn();
  onOpenSettings = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const groupHeads = () => [...container.querySelectorAll<HTMLButtonElement>('button[aria-expanded][aria-controls]')].filter((b) => b.closest('.tk-rail-sessions'));
const groupHead = (label: string) => groupHeads().find((b) => b.textContent?.includes(label)) ?? null;
const rowsIn = (head: HTMLButtonElement) =>
  [...document.getElementById(head.getAttribute('aria-controls')!)!.querySelectorAll<HTMLButtonElement>('li > button')];
const rowTitled = (title: string) => [...container.querySelectorAll<HTMLButtonElement>('li > button')].find((b) => b.title === title) ?? null;
const byName = (name: string) =>
  [...container.querySelectorAll<HTMLButtonElement>('button')].find(
    (b) => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name
  ) ?? null;
const click = (el: Element) => act(() => (el as HTMLElement).click());

const eightCoding = Array.from({ length: 8 }, (_, i) => conv(`code-${i}`, `Coding session ${i}`, i * 10));

describe('Rail: sessions', () => {
  it('groups sessions as coding agents, chats and bots, counting each group and skipping benchmarks and archived threads', () => {
    mount({
      conversations: [
        conv('c1', 'Refactor the importer', 5),
        conv('c2', 'Fix the flaky test', 15),
        conv('chat-1', 'Release notes', 20, { provider: 'claude' }),
        conv('chat-old', 'An archived chat', 30, { provider: 'claude', workflowState: 'archived' }),
        conv('bench', 'Benchmark record', 1, { isSyntheticBenchmark: true }),
      ],
    });
    const heads = groupHeads();
    expect(heads.map((h) => h.textContent)).toEqual(['Coding agents2 sessions', 'Chats1 session']);
    expect(rowTitled('Benchmark record')).toBeNull();
    expect(rowTitled('An archived chat')).toBeNull();
  });

  it('lists the six most recently updated sessions of a group and offers "Show all" for the rest', () => {
    mount({ conversations: [...eightCoding].reverse() });
    const head = groupHead('Coding agents')!;
    expect(head.querySelector('.tk-rail-count')?.textContent).toBe('8 sessions');
    expect(rowsIn(head).map((b) => b.title)).toEqual(eightCoding.slice(0, 6).map((c) => c.title));
    const showAll = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show all')!;
    expect(showAll.getAttribute('aria-label')).toBe('Show all 8 coding agents in Threads');
    click(showAll);
    // Threads, narrowed to the group's type (the app switches the view itself).
    expect(showInThreads).toHaveBeenCalledWith({ by: 'kind', key: 'coding' });
    expect(setView).not.toHaveBeenCalled();
  });

  it('does not offer "Show all" when a group fits', () => {
    mount({ conversations: eightCoding.slice(0, 6) });
    expect([...container.querySelectorAll('button')].some((b) => b.textContent === 'Show all')).toBe(false);
  });

  it('collapses and expands a group through the workspace state', () => {
    mount({ conversations: [conv('c1', 'Refactor the importer', 5), conv('chat-1', 'Release notes', 20, { provider: 'claude' })], state: { collapsedGroups: ['chats'] } });
    const coding = groupHead('Coding agents')!;
    const chats = groupHead('Chats')!;
    expect(coding.getAttribute('aria-expanded')).toBe('true');
    expect(chats.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById(chats.getAttribute('aria-controls')!)!.hidden).toBe(true);
    // Groups are kept by id (`kind:coding`); an entry stored under the old bare spelling is still
    // the same group, and toggling it removes that entry instead of shadowing it.
    click(coding);
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggle_group', group: 'kind:coding' });
    click(chats);
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'toggle_group', group: 'chats' });
  });

  it('opens a session from its row', () => {
    const target = conv('c2', 'Fix the flaky test', 15);
    mount({ conversations: [conv('c1', 'Refactor the importer', 5), target] });
    click(rowTitled('Fix the flaky test')!);
    expect(openSession).toHaveBeenCalledTimes(1);
    expect(openSession.mock.calls[0][0]).toBe(target);
  });

  it('marks the session that is showing, and says which sessions are open in the workspace', () => {
    const a = conv('c1', 'Refactor the importer', 5);
    const b = conv('c2', 'Fix the flaky test', 15);
    mount({
      conversations: [a, b],
      state: { tabs: [threadTab('c1'), threadTab('c2')], activeTabId: threadTabId('c2') },
      live: [threadTabId('c1')],
    });
    expect(rowTitled('Fix the flaky test')!.getAttribute('aria-current')).toBe('true');
    expect(rowTitled('Refactor the importer')!.hasAttribute('aria-current')).toBe(false);
    expect(rowTitled('Refactor the importer')!.textContent).toContain('Open');
    expect(rowTitled('Fix the flaky test')!.textContent).not.toContain('Open');

    // In Threads, the selected thread is the one showing.
    mount({ conversations: [a, b], view: 'threads', selectedThreadKey: 'c1' });
    expect(rowTitled('Refactor the importer')!.getAttribute('aria-current')).toBe('true');
  });

  it('shows the run state the page last showed for coding sessions only', () => {
    mount({
      conversations: [
        conv('c1', 'Refactor the importer', 5, { agentState: 'waiting_permission', agentStateAt: '2026-11-10T11:55:00Z' }),
        conv('c2', 'Unobserved run', 6, { agentState: 'unknown' }),
        conv('chat-1', 'Release notes', 20, { provider: 'claude', agentState: 'running' }),
      ],
    });
    expect(rowTitled('Refactor the importer')!.textContent).toContain('Needs approval');
    expect(rowTitled('Unobserved run')!.querySelector('.tk-run')).toBeNull();
    expect(rowTitled('Release notes')!.querySelector('.tk-run')).toBeNull();
  });

  it('shows an account only when it says something', () => {
    const onWork = conv('c1', 'On the work account', 5);
    const onPersonal = conv('c2', 'On the personal account', 6, { accountId: PERSONAL.id });
    // One account in the sign-in, and the session is on it: nothing to say.
    mount({ conversations: [onWork] });
    expect(rowTitled('On the work account')!.querySelector('.tk-acct')).toBeNull();

    // Two accounts: every row says which one it belongs to; the one not signed in is a hollow ring.
    const both: RealmAccounts[] = [{ realm: claudeRealm, accounts: [WORK, PERSONAL], activeAccountId: WORK.id }];
    mount({ conversations: [onWork, onPersonal], realms: both });
    const work = rowTitled('On the work account')!.querySelector('.tk-acct')!;
    const personal = rowTitled('On the personal account')!.querySelector('.tk-acct')!;
    expect(work.textContent).toContain('Work');
    expect(work.getAttribute('data-active')).toBe('true');
    expect(personal.textContent).toContain('Personal');
    expect(personal.getAttribute('data-active')).toBe('false');

    // A provider with no sign-in ThreadStack knows about never shows one.
    mount({
      conversations: [conv('x1', 'Somewhere else', 5, { provider: 'perplexity' })],
      accountOf: () => ({ realm: null, account: null, active: true, switchable: false }),
    });
    expect(rowTitled('Somewhere else')!.querySelector('.tk-acct')).toBeNull();
  });

  it('says so when there are no sessions yet', () => {
    mount({ conversations: [] });
    expect(container.textContent).toContain('Sessions you open or capture appear here.');
  });
});

describe('Rail: views, tools and the collapsed strip', () => {
  it('switches views from the view switch', () => {
    mount({ view: 'browse' });
    const group = container.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-label')).toBe('View');
    const radios = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
    // Icons only (five names do not fit the rail); each keeps its name for assistive technology.
    expect(radios.map((r) => r.getAttribute('aria-label'))).toEqual(['Browse', 'Threads', 'Table', 'Dashboard', 'Paperclip']);
    expect(radios.map((r) => r.getAttribute('title'))).toEqual(['Browse', 'Threads', 'Table', 'Dashboard', 'Paperclip']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    click(radios[2]);
    expect(onViewChange).toHaveBeenCalledWith('table');
    click(radios[3]);
    expect(onViewChange).toHaveBeenCalledWith('dashboard');
    click(radios[4]);
    expect(onViewChange).toHaveBeenCalledWith('paperclip');
    act(() => {
      radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onViewChange).toHaveBeenLastCalledWith('threads');
  });

  it('keeps the brand, the collapse button and the tools, and renders the Threads navigation it is given', () => {
    mount({ children: <nav className="tk-nav" aria-label="Projects and resurfacing queues" /> });
    const wordmark = container.querySelector<HTMLImageElement>('img.tk-rail-wordmark')!;
    expect(wordmark.getAttribute('alt')).toBe('ThreadStack');
    expect(wordmark.getAttribute('src')).toBe('assets/brand/threadstack-wordmark.png');
    expect(wordmark.getAttribute('height')).toBe('29');
    // The tools sit in the header row, after the brand: theme, add account, Settings, collapse.
    const head = container.querySelector('.tk-rail-head')!;
    expect([...head.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Toggle color theme',
      'Add account',
      'Settings',
      'Collapse navigation',
    ]);
    const toggle = byName('Collapse navigation')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    click(toggle);
    expect(onToggleCollapsed).toHaveBeenCalledTimes(1);
    click(byName('Add account')!);
    expect(requestAddAccount).toHaveBeenCalledTimes(1);
    click(byName('Settings')!);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
    // Named like the library header's button it stands in for; the tooltip says what it will do.
    const theme = byName('Toggle color theme')!;
    expect(theme.getAttribute('title')).toBe('Switch to light theme');
    click(theme);
    expect(onToggleTheme).toHaveBeenCalledTimes(1);
    expect(container.querySelector('nav[aria-label="Projects and resurfacing queues"]')).not.toBeNull();
  });

  it('leaves accounts to Settings and the Browse toolbar, even with several accounts', () => {
    mount({ realms: [{ realm: claudeRealm, accounts: [WORK, PERSONAL], activeAccountId: WORK.id }] });
    expect([...container.querySelectorAll('h2')].some((h) => h.textContent === 'Accounts')).toBe(false);
    expect(container.querySelector('.tk-rail-foot')).toBeNull();
    // "Add account" is still one click away.
    expect(byName('Add account')).not.toBeNull();
  });

  it('offers the session palette from the header only when the palette is on', () => {
    mount();
    expect(byName('Search sessions')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    const openPalette = vi.fn();
    mount({ openPalette });
    const search = byName('Search sessions')!;
    expect(search.getAttribute('aria-keyshortcuts')).toBe('Meta+K Control+K');
    click(search);
    expect(openPalette).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
    root = createRoot(container);
    // Collapsed: the mark, expand and search at the top; add account, Settings, theme at the foot.
    mount({ openPalette, rail: { collapsed: true } });
    expect(container.querySelector<HTMLImageElement>('img.tk-rail-mark')?.getAttribute('alt')).toBe('ThreadStack');
    const top = container.querySelector('.tk-rail-head')!;
    expect([...top.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Expand navigation', 'Search sessions']);
    const foot = container.querySelector('.tk-rail-foot')!;
    expect([...foot.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual(['Toggle color theme', 'Add account', 'Settings']);
  });

  it('keeps an accessible name on every control when collapsed, and leaves the session lists out', () => {
    mount({
      conversations: eightCoding,
      view: 'threads',
      rail: { collapsed: true, effectiveTheme: 'light' },
      children: <nav className="tk-nav" aria-label="Projects and resurfacing queues" />,
    });
    const rail = container.querySelector('aside')!;
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    for (const button of rail.querySelectorAll('button')) {
      const name = button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '';
      expect(name.length, button.outerHTML).toBeGreaterThan(0);
    }
    expect(byName('Expand navigation')!.getAttribute('aria-expanded')).toBe('false');
    expect(byName('Threads')!.getAttribute('aria-current')).toBe('page');
    expect(byName('Browse')!.hasAttribute('aria-current')).toBe(false);
    for (const name of ['Browse', 'Threads', 'Dashboard', 'Add account', 'Settings']) {
      expect(byName(name)?.getAttribute('title'), name).toBe(name);
    }
    expect(byName('Toggle color theme')?.getAttribute('title')).toBe('Switch to dark theme');
    click(byName('Dashboard')!);
    expect(onViewChange).toHaveBeenCalledWith('dashboard');
    expect(container.querySelector('.tk-rail-sessions')).toBeNull();
    expect(container.querySelector('nav[aria-label="Projects and resurfacing queues"]')).toBeNull();
  });

  it('says when embedded pages are unavailable', () => {
    mount({ error: 'ThreadStack could not register this tab.' });
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain('Embedded pages are unavailable');
    expect(notice.textContent).toContain('ThreadStack could not register this tab.');
  });

  it('opens as a drawer in a small window, and Escape closes it', () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('max-width'),
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
    const onCloseDrawer = vi.fn();
    mount({ conversations: eightCoding.slice(0, 2), rail: { onCloseDrawer } });
    const rail = container.querySelector('aside')!;
    // Narrow: an icon strip until it is opened.
    expect(rail.getAttribute('data-collapsed')).toBe('true');
    click(byName('Expand navigation')!);
    expect(rail.getAttribute('data-drawer-open')).toBe('true');
    expect(rail.getAttribute('data-collapsed')).toBe('false');
    expect(rowTitled('Coding session 0')).not.toBeNull();
    expect(onToggleCollapsed).not.toHaveBeenCalled();
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(rail.getAttribute('data-drawer-open')).toBe('false');
    expect(onCloseDrawer).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// The lens: Organize menu, grouping, filters, hand-off to Threads
// ---------------------------------------------------------------------------------------------

describe('Rail: organizing sessions', () => {
  const library = () => [
    conv('code-1', 'Refactor the importer', 5),
    conv('code-2', 'Fix the flaky test', 15, { provider: 'codex', accountId: PERSONAL.id }),
    conv('code-3', 'Trim the bundle', 25),
    conv('chat-1', 'Release notes', 20, { provider: 'claude' }),
    conv('chat-2', 'Pricing page copy', 40, { provider: 'chatgpt' }),
    conv('bot-1', 'Nightly digest', 8, { provider: 'grok_bot' }),
  ];
  const both: RealmAccounts[] = [{ realm: claudeRealm, accounts: [WORK, PERSONAL], activeAccountId: WORK.id }];
  const organize = () =>
    [...container.querySelectorAll<HTMLButtonElement>('button')].find((b) => b.textContent?.includes('Organize')) ?? null;
  const menu = () => document.querySelector<HTMLElement>('[role="menu"][aria-label="Organize sessions"]');
  const menuItem = (name: string) =>
    [...(menu()?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])].find((el) => el.textContent?.startsWith(name)) ?? null;
  const section = (label: string) => {
    const head = [...(menu()?.querySelectorAll<HTMLElement>('.tk-org-head') ?? [])].find((h) => h.textContent === label)!;
    return [...menu()!.querySelectorAll<HTMLElement>(`[role="group"][aria-labelledby="${head.id}"] > [role="menuitemradio"]`)];
  };
  // Group headers only: the Organize button also has aria-expanded and (open) aria-controls.
  const heads = () => [...container.querySelectorAll<HTMLButtonElement>('.tk-rail-group-head')];
  const headTexts = () => heads().map((h) => h.textContent);
  const headNames = () => heads().map((h) => h.querySelector('span')?.textContent);

  it('puts the Organize button beside the Sessions heading, with no count until a filter is on', () => {
    mount({ conversations: library() });
    const button = organize()!;
    expect(button.closest('.tk-rail-heading')?.querySelector('h2')?.textContent).toBe('Sessions');
    expect(button.textContent).toBe('Organize');
    expect(button.querySelector('.tk-org-badge')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
    // Closed, it points at nothing; it must not be mistaken for a group header.
    expect(button.hasAttribute('aria-controls')).toBe(false);
    expect(groupHeads().includes(button)).toBe(false);
    // Nothing to organize: no button.
    mount({ conversations: [] });
    expect(organize()).toBeNull();
  });

  it('opens a menu on the page with Group by, Sort by and Show, and shows what is chosen with a check', () => {
    mount({ conversations: library() });
    click(organize()!);
    const popup = menu()!;
    expect(popup.parentElement).toBe(document.body);
    expect(organize()!.getAttribute('aria-expanded')).toBe('true');
    expect(organize()!.getAttribute('aria-controls')).toBe(popup.id);
    const sections = [...popup.querySelectorAll('[role="group"][aria-labelledby]')].map(
      (g) => document.getElementById(g.getAttribute('aria-labelledby')!)?.textContent
    );
    expect(sections).toEqual(['Group by', 'Sort by', 'Show']);
    // Account is left out: one account only. Type stays: three kinds are in play.
    expect(section('Group by').map((r) => r.textContent)).toEqual(['Type', 'Provider', 'Last active', 'Repository', 'None']);
    expect(section('Group by').map((r) => r.getAttribute('aria-checked'))).toEqual(['true', 'false', 'false', 'false', 'false']);
    expect(section('Sort by').map((r) => r.textContent)).toEqual([
      'Recent activity',
      'Oldest first',
      'Recently created',
      'Title A–Z',
      'Most messages',
    ]);
    expect(section('Sort by')[0].getAttribute('aria-checked')).toBe('true');
    // The check is a drawn mark, not only a colour.
    expect(section('Group by')[0].querySelector('svg')).not.toBeNull();
    expect(section('Group by')[1].querySelector('svg')).toBeNull();
    // Type and Provider with their counts in words; no Account with a single account.
    expect(menuItem('Coding sessions')!.getAttribute('role')).toBe('menuitemcheckbox');
    expect(menuItem('Coding sessions')!.textContent).toContain(', 3 sessions');
    expect(menuItem('Chats')!.textContent).toContain(', 2 sessions');
    expect(menuItem('Claude Code')!.textContent).toContain(', 2 sessions');
    expect(menuItem('Claude · Work')).toBeNull();
    expect(menuItem('Reset')).toBeNull();
    // Focus moved into the menu.
    expect(document.activeElement).toBe(section('Group by')[0]);
  });

  it('closes on Escape and gives focus back to the button; arrow keys move between items', () => {
    mount({ conversations: library() });
    const button = organize()!;
    click(button);
    const first = document.activeElement as HTMLElement;
    act(() => {
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    expect(document.activeElement).not.toBe(first);
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemradio');
    act(() => {
      (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    });
    expect(document.activeElement?.getAttribute('role')).toBe('menuitemcheckbox');
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('regroups by the chosen dimension and remembers it in the settings', () => {
    mount({ conversations: library() });
    click(organize()!);
    click(menuItem('Provider')!);
    expect(patchSettings).toHaveBeenCalledWith({ railLens: { groupBy: 'provider', sortBy: 'recent' } });
    mount({ conversations: library(), settings: { railLens: { groupBy: 'provider', sortBy: 'recent' } } });
    // Biggest group first (Claude Code has two), then by name; a provider group shows the mark.
    expect(headTexts()).toEqual(['CCClaude Code2 sessions', 'GPChatGPT1 session', 'CLClaude1 session', 'CXCodex1 session', 'XBGrok Bot1 session']);
    expect(groupHead('Claude Code')!.querySelector('.tk-mark')).not.toBeNull();
    // The rows themselves are unchanged.
    expect(rowTitled('Refactor the importer')!.querySelector('.tk-rail-row-title')?.textContent).toBe('Refactor the importer');
  });

  it('sorts inside each group by the chosen order and remembers it', () => {
    mount({ conversations: library() });
    click(organize()!);
    click(menuItem('Title A–Z')!);
    expect(patchSettings).toHaveBeenCalledWith({ railLens: { groupBy: 'kind', sortBy: 'title' } });
    mount({ conversations: library(), settings: { railLens: { groupBy: 'kind', sortBy: 'title' } } });
    expect(rowsIn(groupHead('Coding agents')!).map((b) => b.title)).toEqual(['Fix the flaky test', 'Refactor the importer', 'Trim the bundle']);
  });

  it('falls back to the default for a stored grouping the rail does not offer', () => {
    mount({ conversations: library(), settings: { railLens: { groupBy: 'status', sortBy: 'sideways' } as never } });
    expect(headNames()).toEqual(['Coding agents', 'Chats', 'Bots']);
  });

  it('groups by account as "<Sign-in> · <Account>" in sign-in order, once there are two accounts', () => {
    mount({ conversations: library(), realms: both, settings: { railLens: { groupBy: 'account', sortBy: 'recent' } } });
    expect(headTexts()).toEqual(['Claude · Work5 sessions', 'Claude · Personal1 session']);
    expect(groupHead('Claude · Personal')!.querySelector('.tk-acct')!.getAttribute('data-active')).toBe('false');
    click(organize()!);
    expect(menuItem('Account')!.getAttribute('role')).toBe('menuitemradio');
    expect(menuItem('Claude · Work')!.getAttribute('role')).toBe('menuitemcheckbox');
    expect(menuItem('Claude · Personal')!.textContent).toContain(', 1 session');
  });

  it('groups by when it was last active, newest first', () => {
    const old = new Date(2020, 0, 2, 9).toISOString();
    const now = new Date().toISOString();
    const dated = [
      conv('a', 'Older work', 0, { updatedAt: old, lastCapturedAt: old }),
      conv('b', 'Fresh work', 0, { updatedAt: now, lastCapturedAt: now }),
    ];
    mount({ conversations: dated, settings: { railLens: { groupBy: 'date', sortBy: 'recent' } } });
    expect(headNames()).toEqual(['Today', 'Older']);
  });

  it('shows one plain list when not grouped, twelve rows long, with no group headers', () => {
    const twenty = Array.from({ length: 20 }, (_, i) => conv(`s-${i}`, `Session ${i}`, i));
    mount({ conversations: twenty, settings: { railLens: { groupBy: 'none', sortBy: 'recent' } } });
    expect(heads()).toHaveLength(0);
    expect(container.querySelectorAll('.tk-rail-list > li')).toHaveLength(12);
    const showAll = [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show all')!;
    expect(showAll.getAttribute('aria-label')).toBe('Show all 20 sessions in Threads');
    click(showAll);
    expect(showInThreads).toHaveBeenCalledWith({ by: 'none', key: null });
  });

  it('hands a provider, an account or a repository group to Threads', () => {
    const many = Array.from(
      { length: 8 },
      (_, i) => conv(`c-${i}`, `Code ${i}`, i, { repository: 'acme/app' } as Partial<ConversationRecord>)
    );
    const more = () => [...container.querySelectorAll('button')].find((b) => b.textContent === 'Show all')!;
    mount({ conversations: many, settings: { railLens: { groupBy: 'provider', sortBy: 'recent' } } });
    expect(more().getAttribute('aria-label')).toBe('Show all 8 sessions of Claude Code in Threads');
    click(more());
    expect(showInThreads).toHaveBeenLastCalledWith({ by: 'provider', key: 'claude_code' });
    mount({ conversations: many, realms: both, settings: { railLens: { groupBy: 'account', sortBy: 'recent' } } });
    click(more());
    expect(showInThreads).toHaveBeenLastCalledWith({ by: 'account', key: WORK.id });
    mount({ conversations: many, settings: { railLens: { groupBy: 'repository', sortBy: 'recent' } } });
    expect(groupHead('acme/app')!.querySelector('.tk-rail-mono')?.textContent).toBe('acme/app');
    click(more());
    expect(showInThreads).toHaveBeenLastCalledWith({ by: 'repository', key: 'acme/app' });
  });

  it('keeps the names the rail has always used for its type groups, and the filter names in the menu', () => {
    mount({ conversations: library() });
    expect(headNames()).toEqual(['Coding agents', 'Chats', 'Bots']);
    click(organize()!);
    expect(menuItem('Coding sessions')).not.toBeNull();
  });

  it('narrows by a filter, says so in one line, and clears it from the line', () => {
    mount({ conversations: library() });
    click(organize()!);
    click(menuItem('Claude Code')!);
    expect(menuItem('Claude Code')!.getAttribute('aria-checked')).toBe('true');
    expect(organize()!.querySelector('.tk-org-badge')?.textContent).toBe('1');
    expect(organize()!.textContent).toBe('1Organize, 1 filter on');
    const line = container.querySelector('.tk-rail-filters')!;
    expect(line.textContent).toBe('Showing only Claude CodeClear');
    expect(headTexts()).toEqual(['Coding agents2 sessions']);
    // Reset appears now that something differs.
    expect(menuItem('Reset')).not.toBeNull();
    click(byName('Clear session filters')!);
    expect(container.querySelector('.tk-rail-filters')).toBeNull();
    expect(headTexts()).toEqual(['Coding agents3 sessions', 'Chats2 sessions', 'Bots1 session']);
    expect(organize()!.querySelector('.tk-org-badge')).toBeNull();
  });

  it('ORs values of one dimension, ANDs dimensions, and says when nothing is left', () => {
    mount({ conversations: library() });
    click(organize()!);
    click(menuItem('Chats')!);
    click(menuItem('Bots')!);
    expect(container.querySelector('.tk-rail-filters')!.textContent).toBe('Showing only Chats, BotsClear');
    expect(headTexts()).toEqual(['Chats2 sessions', 'Bots1 session']);
    click(menuItem('Codex')!);
    expect(container.querySelector('.tk-rail-filters')!.textContent).toBe('Showing only Chats, Bots, CodexClear');
    expect(container.querySelector('.tk-rail-empty')?.textContent).toBe('No sessions match these filters.');
    expect(headTexts()).toEqual([]);
    expect(byName('Clear session filters')).not.toBeNull();
  });

  it('resets the grouping, the order and the filters together', () => {
    mount({ conversations: library(), settings: { railLens: { groupBy: 'provider', sortBy: 'title' } } });
    click(organize()!);
    click(menuItem('Chats')!);
    click(menuItem('Reset')!);
    expect(patchSettings).toHaveBeenLastCalledWith({ railLens: { groupBy: 'kind', sortBy: 'recent' } });
    expect(container.querySelector('.tk-rail-filters')).toBeNull();
  });

  it('keeps the filters when the rail is shown again, and never saves them', () => {
    mount({ conversations: library() });
    click(organize()!);
    click(menuItem('Bots')!);
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(headTexts()).toEqual(['Bots1 session']);
    // Another view shows (the rail has no sessions for a moment), then the rail comes back.
    mount({ conversations: library(), rail: { collapsed: true } });
    expect(container.querySelector('.tk-rail-sessions')).toBeNull();
    mount({ conversations: library() });
    expect(headTexts()).toEqual(['Bots1 session']);
    expect(patchSettings).not.toHaveBeenCalled();
  });

  it('treats a group collapsed under its old name as the same group', () => {
    mount({ conversations: library(), state: { collapsedGroups: ['coding', 'kind:bots'] } });
    expect(groupHead('Coding agents')!.getAttribute('aria-expanded')).toBe('false');
    expect(groupHead('Bots')!.getAttribute('aria-expanded')).toBe('false');
    expect(groupHead('Chats')!.getAttribute('aria-expanded')).toBe('true');
    // Opening a group stored under the old name removes that entry.
    click(groupHead('Coding agents')!);
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'toggle_group', group: 'coding' });
    click(groupHead('Bots')!);
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'toggle_group', group: 'kind:bots' });
  });

  it('stores a collapsed provider group under its own id', () => {
    mount({ conversations: library(), settings: { railLens: { groupBy: 'provider', sortBy: 'recent' } } });
    click(groupHead('Codex')!);
    expect(dispatch).toHaveBeenLastCalledWith({ type: 'toggle_group', group: 'provider:codex' });
  });
});
