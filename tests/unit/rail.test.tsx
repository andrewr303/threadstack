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
import type { ConversationRecord } from '../../src/core/schema.js';

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
}

let container: HTMLDivElement;
let root: Root;
let dispatch: ReturnType<typeof vi.fn>;
let openSession: ReturnType<typeof vi.fn>;
let setView: ReturnType<typeof vi.fn>;
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
    settings: null,
    patchSettings: vi.fn(),
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
    expect(setView).toHaveBeenCalledWith('threads');
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
    click(coding);
    expect(dispatch).toHaveBeenCalledWith({ type: 'toggle_group', group: 'coding' });
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

    // A provider with no sign-in Threadkeeper knows about never shows one.
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
    expect(radios.map((r) => r.textContent)).toEqual(['Browse', 'Threads', 'Dashboard']);
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    click(radios[2]);
    expect(onViewChange).toHaveBeenCalledWith('dashboard');
    act(() => {
      radios[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    expect(onViewChange).toHaveBeenLastCalledWith('threads');
  });

  it('keeps the brand, the collapse button and the tools, and renders the Threads navigation it is given', () => {
    mount({ children: <nav className="tk-nav" aria-label="Projects and resurfacing queues" /> });
    expect(container.querySelector('.tk-rail-wordmark')?.textContent).toBe('Threadkeeper');
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

  it('lists a sign-in only when it has more than one account to choose between', () => {
    // One account: nothing to choose, so no row and no heading; "Add account" is still there.
    mount();
    expect(container.textContent).not.toContain('Signed in');
    expect(container.querySelectorAll('.tk-rail-realms > li')).toHaveLength(0);
    expect(byName('Add account')).not.toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    mount({ realms: [{ realm: claudeRealm, accounts: [WORK, PERSONAL], activeAccountId: WORK.id }] });
    expect(container.textContent).toContain('Signed in');
    expect(container.querySelectorAll('.tk-rail-realms > li')).toHaveLength(1);
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
    mount({ error: 'Threadkeeper could not register this tab.' });
    const notice = container.querySelector('[role="status"]')!;
    expect(notice.textContent).toContain('Embedded pages are unavailable');
    expect(notice.textContent).toContain('Threadkeeper could not register this tab.');
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
