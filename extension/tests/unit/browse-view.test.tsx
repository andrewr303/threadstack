import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, useReducer } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrowseView } from '../../src/entrypoints/manager/browse/BrowseView.js';
import { resolveAddress } from '../../src/entrypoints/manager/browse/address.js';
import { WorkspaceProvider, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import { FrameStage } from '../../src/entrypoints/manager/workspace/FrameStage.js';
import { workspaceReducer } from '../../src/entrypoints/manager/workspace/state.js';
import type { FrameRuntime, WorkspaceController } from '../../src/entrypoints/manager/workspace/useWorkspace.js';
import { DEFAULT_SETTINGS, type ConversationRecord, type StructuredSummaryRecord, type ThreadInsight } from '../../src/core/schema.js';
import { realmById } from '../../src/core/workspace/realms.js';
import {
  EMPTY_WORKSPACE_STATE,
  type AccountRecord,
  type RealmAccounts,
  type SessionTab,
  type WorkspaceState,
} from '../../src/core/workspace/types.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const IDLE: FrameRuntime = { frameId: null, loaded: true, canGoBack: false, canGoForward: false, agentState: null, reloads: 0 };

function account(id: string, realm: string, label: string, color: AccountRecord['color'], extra: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id, realm, label, color, mode: 'embedded', primary: id.startsWith('primary~'), identity: null,
    signedIn: 'yes', hasJar: true, order: 0, createdAt: '2026-01-01T00:00:00.000Z', lastActiveAt: null, ...extra,
  };
}

const WORK = account('primary~anthropic', 'anthropic', 'Work', 'teal');
const PERSONAL = account('acct_personal', 'anthropic', 'Personal', 'peach', { primary: false });
const REALMS: RealmAccounts[] = [
  { realm: realmById('anthropic')!, accounts: [WORK, PERSONAL], activeAccountId: WORK.id },
  { realm: realmById('openai')!, accounts: [account('primary~openai', 'openai', 'Main', 'blue')], activeAccountId: 'primary~openai' },
];

function tab(id: string, title: string, over: Partial<SessionTab> = {}): SessionTab {
  return {
    id, provider: 'claude_code', realm: 'anthropic', accountId: WORK.id, url: `https://claude.ai/code/${id}`,
    title, threadKey: null, createdAt: 1, lastActiveAt: 1, ...over,
  };
}

function conversation(over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    threadKey: 'claude_code:primary:ws:s1:main', provider: 'claude_code', accountId: WORK.id,
    canonicalUrl: 'https://claude.ai/code/s1', title: 'Retry Stripe webhooks', manualTitleOverride: null,
    lastCapturedAt: new Date(Date.now() - 4 * 60_000).toISOString(), pinned: false, nextStepText: 'Allow the staging migration.',
    repository: 'hypestake/hypestake', gitBranch: 'tk/webhook-retries', pullRequestUrl: 'https://github.com/hypestake/hypestake/pull/482',
    agentState: 'waiting_permission', agentStateAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    ...over,
  } as unknown as ConversationRecord;
}

interface Spies {
  closeTab: ReturnType<typeof vi.fn>;
  activateTab: ReturnType<typeof vi.fn>;
  switchAccount: ReturnType<typeof vi.fn>;
  back: ReturnType<typeof vi.fn>;
  forward: ReturnType<typeof vi.fn>;
  reload: ReturnType<typeof vi.fn>;
  navigate: ReturnType<typeof vi.fn>;
  openUrl: ReturnType<typeof vi.fn>;
  openInChromeTab: ReturnType<typeof vi.fn>;
  openSession: ReturnType<typeof vi.fn>;
  togglePinned: ReturnType<typeof vi.fn>;
  announce: ReturnType<typeof vi.fn>;
}

interface Setup {
  tabs: SessionTab[];
  active?: string | null;
  runtimes?: Record<string, Partial<FrameRuntime>>;
  resting?: Record<string, 'account' | 'isolated' | 'asleep'>;
  conversations?: ConversationRecord[];
  insights?: ThreadInsight[];
  summaries?: StructuredSummaryRecord[];
  signedIn?: string;
}

let container: HTMLDivElement;
let root: Root;
let spies: Spies;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

function Harness({ setup }: { setup: Setup }) {
  // The real reducer, so closing and activating behave as they do in the app.
  const [state, dispatch] = useReducer(workspaceReducer, {
    ...EMPTY_WORKSPACE_STATE,
    tabs: setup.tabs,
    activeTabId: setup.active === undefined ? (setup.tabs[0]?.id ?? null) : setup.active,
  } as WorkspaceState);
  const realms = setup.signedIn
    ? REALMS.map((r) => (r.realm.id === 'anthropic' ? { ...r, activeAccountId: setup.signedIn! } : r))
    : REALMS;
  const live = state.tabs.filter((t) => setup.resting?.[t.id] === undefined).map((t) => t.id);
  const workspace = {
    enabled: true, ready: true, embedding: true, error: null, tabId: 1, realms, state,
    plan: { live, resting: setup.resting ?? {} },
    runtime: (id: string) => ({ ...IDLE, ...(setup.runtimes?.[id] ?? {}) }),
    switchingRealm: null,
    dispatch,
    openUrl: spies.openUrl,
    closeTab: (id: string) => { spies.closeTab(id); dispatch({ type: 'close', id }); },
    activateTab: (id: string) => { spies.activateTab(id); dispatch({ type: 'activate', id, now: 5 }); },
    switchAccount: spies.switchAccount,
    back: spies.back, forward: spies.forward, reload: spies.reload, navigate: spies.navigate,
    noteFrameLoaded: vi.fn(),
    accountOf: (t: SessionTab) => realms.flatMap((r) => r.accounts).find((a) => a.id === t.accountId) ?? null,
  } as unknown as WorkspaceController;
  const conversations = setup.conversations ?? [];
  const value: WorkspaceContextValue = {
    surface: 'page', workspace, settings: DEFAULT_SETTINGS, patchSettings: async () => {},
    view: 'browse', setView: () => {}, detailMode: 'summary', setDetailMode: () => {},
    conversations,
    conversationByKey: new Map(conversations.map((c) => [c.threadKey, c])),
    insightsByThread: new Map((setup.insights ?? []).map((i) => [i.threadKey, i])),
    summariesByThread: new Map((setup.summaries ?? []).map((s) => [s.threadKey, s])),
    selectedThreadKey: null,
    accountOfThread: (conv) => {
      const found = realms.flatMap((r) => r.accounts).find((a) => a.id === conv.accountId) ?? null;
      return { realm: realmById('anthropic'), account: found, active: found?.id === realms[0].activeAccountId, switchable: true };
    },
    openSession: spies.openSession, togglePinned: spies.togglePinned, openInChromeTab: spies.openInChromeTab,
    requestAddAccount: vi.fn(), openSettings: vi.fn(), announce: spies.announce,
  };
  return (
    <WorkspaceProvider value={value}>
      <FrameStage workspace={workspace}>
        <BrowseView />
      </FrameStage>
    </WorkspaceProvider>
  );
}

async function mount(setup: Setup) {
  spies = {
    closeTab: vi.fn(), activateTab: vi.fn(), switchAccount: vi.fn(), back: vi.fn(), forward: vi.fn(), reload: vi.fn(),
    navigate: vi.fn(() => ({ ok: true, tabId: 'x' })), openUrl: vi.fn(() => ({ ok: true, tabId: 'y' })),
    openInChromeTab: vi.fn(), openSession: vi.fn(), togglePinned: vi.fn(async () => {}), announce: vi.fn(),
  };
  await act(async () => { root.render(<Harness setup={setup} />); });
}

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
const byName = (name: string | RegExp, role = 'button') =>
  [...container.querySelectorAll<HTMLElement>(role === 'button' ? 'button' : `[role="${role}"]`)].find((el) => {
    const n = el.getAttribute('aria-label') ?? el.textContent ?? '';
    return typeof name === 'string' ? n === name : name.test(n);
  }) ?? null;
const key = (el: Element, k: string) =>
  act(() => { el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })); });
const click = (el: Element | null) => act(() => { (el as HTMLElement).click(); });
const flush = () => act(async () => { await Promise.resolve(); });
const typeInto = (input: HTMLInputElement, value: string) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => { set.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
};

describe('Browse tab strip', () => {
  it('renders one tab per session with roles, names and the selected state', async () => {
    await mount({ tabs: [tab('a', 'Retry Stripe webhooks'), tab('b', 'Settlement flake', { provider: 'claude', url: 'https://claude.ai/new' })], active: 'a' });
    expect(container.querySelector('[role="tablist"]')?.getAttribute('aria-label')).toBe('Open sessions');
    expect(tabs()).toHaveLength(2);
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(tabs()[1].getAttribute('aria-selected')).toBe('false');
    expect(tabs()[0].getAttribute('aria-label')).toBe('Retry Stripe webhooks, Claude Code, Work');
    expect(tabs()[0].getAttribute('title')).toBe('Retry Stripe webhooks');
    // Roving tabindex: only the selected tab is in the tab order.
    expect(tabs().map((t) => t.tabIndex)).toEqual([0, -1]);
    expect(q('[role="tabpanel"]')?.getAttribute('aria-labelledby')).toBe(tabs()[0].id);
    // The tab's page slot is in the stage.
    expect(q('[data-tab="a"]')).not.toBeNull();
  });

  it('shows whether the tab\'s account is the one signed in, by dot state and not by name', async () => {
    await mount({ tabs: [tab('a', 'One')] });
    const chip = tabs()[0].querySelector('.tk-acct');
    expect(chip?.getAttribute('data-active')).toBe('true');
    expect(tabs()[0].querySelector('.tk-acct-name')).toBeNull();
  });

  it('moves focus with the arrow keys, Home and End, wrapping at the ends', async () => {
    await mount({ tabs: [tab('a', 'One'), tab('b', 'Two'), tab('c', 'Three')], active: 'a' });
    act(() => tabs()[0].focus());
    key(tabs()[0], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[1]);
    expect(tabs().map((t) => t.tabIndex)).toEqual([-1, 0, -1]);
    key(tabs()[1], 'End');
    expect(document.activeElement).toBe(tabs()[2]);
    key(tabs()[2], 'ArrowRight');
    expect(document.activeElement).toBe(tabs()[0]);
    key(tabs()[0], 'ArrowLeft');
    expect(document.activeElement).toBe(tabs()[2]);
    key(tabs()[2], 'Home');
    expect(document.activeElement).toBe(tabs()[0]);
    // Moving focus does not load or select anything.
    expect(spies.activateTab).not.toHaveBeenCalled();
    click(tabs()[1]);
    expect(spies.activateTab).toHaveBeenCalledWith('b');
  });

  it('closes a tab from its button, with Delete and with a middle click, and focuses the tab that takes its place', async () => {
    await mount({ tabs: [tab('a', 'One'), tab('b', 'Two'), tab('c', 'Three')], active: 'b' });
    click(byName('Close Two'));
    expect(spies.closeTab).toHaveBeenCalledWith('b');
    expect(tabs().map((t) => t.getAttribute('aria-label'))).toEqual(['One, Claude Code, Work', 'Three, Claude Code, Work']);
    // The neighbour to the right took its place, as the reducer activated it.
    expect(document.activeElement).toBe(tabs()[1]);
    expect(tabs()[1].getAttribute('aria-selected')).toBe('true');

    key(tabs()[1], 'Delete');
    expect(spies.closeTab).toHaveBeenLastCalledWith('c');
    expect(document.activeElement).toBe(tabs()[0]);

    act(() => { tabs()[0].dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true })); });
    expect(spies.closeTab).toHaveBeenLastCalledWith('a');
    // Nothing left: focus lands on the new tab button and the new tab page is shown.
    expect(tabs()).toHaveLength(0);
    expect(document.activeElement).toBe(byName('Open new tab'));
    expect(q('[aria-label="New tab"]')).not.toBeNull();
  });

  it('names a paused tab as paused and never switches accounts when it is activated', async () => {
    await mount({
      tabs: [tab('a', 'Work session'), tab('p', 'Personal session', { accountId: PERSONAL.id })],
      active: 'a',
      resting: { p: 'account' },
    });
    const paused = tabs()[1];
    expect(paused.getAttribute('aria-label')).toBe('Personal session, Claude Code, Personal, paused, signed in as Work');
    expect(paused.closest('.tk-browse-tab')?.getAttribute('data-paused')).toBe('true');
    click(paused);
    expect(spies.activateTab).toHaveBeenCalledWith('p');
    expect(spies.switchAccount).not.toHaveBeenCalled();
    expect(paused.getAttribute('aria-selected')).toBe('true');
    // Its page is not loaded: the toolbar cannot drive it.
    expect((byName('Reload') as HTMLButtonElement).disabled).toBe(true);
  });

  it('says that a tab of a separate-window account opens in its own window', async () => {
    await mount({ tabs: [tab('i', 'Isolated')], resting: { i: 'isolated' } });
    expect(tabs()[0].getAttribute('aria-label')).toContain('opens in its own window');
  });

  it('shows the run state of a coding session as observed, and not for chats', async () => {
    await mount({
      tabs: [tab('a', 'Agent', { threadKey: 'claude_code:primary:ws:s1:main' }), tab('c', 'Chat', { provider: 'claude', url: 'https://claude.ai/new' })],
      conversations: [conversation()],
      runtimes: { c: { agentState: 'running' } },
    });
    expect(tabs()[0].querySelector('.tk-run')?.getAttribute('data-state')).toBe('waiting_permission');
    expect(tabs()[1].querySelector('.tk-run')).toBeNull();
  });
});

describe('Browse toolbar', () => {
  it('disables back and forward until the page reports it can go there', async () => {
    await mount({ tabs: [tab('a', 'One')] });
    const back = () => byName('Back') as HTMLButtonElement;
    const forward = () => byName('Forward') as HTMLButtonElement;
    expect(back().disabled).toBe(true);
    expect(forward().disabled).toBe(true);
    click(back());
    expect(spies.back).not.toHaveBeenCalled();

    await mount({ tabs: [tab('a', 'One')], runtimes: { a: { canGoBack: true, canGoForward: true } } });
    expect(back().disabled).toBe(false);
    expect(forward().disabled).toBe(false);
    click(back());
    click(forward());
    click(byName('Reload'));
    expect(spies.back).toHaveBeenCalledWith('a');
    expect(spies.forward).toHaveBeenCalledWith('a');
    expect(spies.reload).toHaveBeenCalledWith('a');
  });

  it('shows the address with the host emphasised, and opens the address in a Chrome tab', async () => {
    await mount({ tabs: [tab('a', 'One')] });
    expect(q('.tk-browse-addr-host')?.textContent).toBe('claude.ai');
    expect(q('.tk-browse-addr-path')?.textContent).toBe('/code/a');
    expect(q<HTMLInputElement>('input[aria-label="Address"]')?.value).toBe('https://claude.ai/code/a');
    click(byName('Open in Chrome tab'));
    expect(spies.openInChromeTab).toHaveBeenCalledWith('https://claude.ai/code/a');
  });

  it('navigates the tab for an address of the same sign-in', async () => {
    await mount({ tabs: [tab('a', 'One')] });
    const input = q<HTMLInputElement>('input[aria-label="Address"]')!;
    act(() => input.focus());
    typeInto(input, 'claude.ai/new');
    act(() => { q('form.tk-browse-addr')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(spies.navigate).toHaveBeenCalledWith('a', 'https://claude.ai/new');
    expect(spies.openUrl).not.toHaveBeenCalled();
    expect(q('.tk-browse-notice')).toBeNull();
  });

  it('opens another known provider as a new tab', async () => {
    await mount({ tabs: [tab('a', 'One')] });
    const input = q<HTMLInputElement>('input[aria-label="Address"]')!;
    act(() => input.focus());
    typeInto(input, 'https://chatgpt.com/codex');
    act(() => { q('form.tk-browse-addr')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(spies.openUrl).toHaveBeenCalledWith('https://chatgpt.com/codex');
    expect(spies.navigate).not.toHaveBeenCalled();
  });

  it('refuses another site and offers to open it in a Chrome tab', async () => {
    await mount({ tabs: [tab('a', 'One')] });
    const input = q<HTMLInputElement>('input[aria-label="Address"]')!;
    act(() => input.focus());
    typeInto(input, 'https://example.com/docs');
    act(() => { q('form.tk-browse-addr')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
    expect(spies.navigate).not.toHaveBeenCalled();
    expect(spies.openUrl).not.toHaveBeenCalled();
    const notice = q('.tk-browse-notice')!;
    expect(notice.textContent).toContain('example.com');
    click(notice.querySelector('button.tk-btn'));
    expect(spies.openInChromeTab).toHaveBeenCalledWith('https://example.com/docs');
    expect(spies.announce).toHaveBeenCalled();
  });

  it('restores the current address on Escape', async () => {
    await mount({ tabs: [tab('a', 'One')] });
    const input = q<HTMLInputElement>('input[aria-label="Address"]')!;
    act(() => input.focus());
    typeInto(input, 'something else');
    expect(input.value).toBe('something else');
    key(input, 'Escape');
    expect(input.value).toBe('https://claude.ai/code/a');
  });

  it('resolves typed addresses without touching the workspace', async () => {
    const t = { realm: 'anthropic', url: 'https://claude.ai/code/a' };
    expect(resolveAddress('', t).kind).toBe('none');
    expect(resolveAddress('claude.ai/new', t)).toEqual({ kind: 'navigate', url: 'https://claude.ai/new' });
    expect(resolveAddress('https://chatgpt.com/', t)).toEqual({ kind: 'open', url: 'https://chatgpt.com/' });
    expect(resolveAddress('http://claude.ai/new', t)).toMatchObject({ kind: 'refuse', chromeUrl: 'http://claude.ai/new' });
    expect(resolveAddress('what is a webhook', t)).toMatchObject({ kind: 'refuse', chromeUrl: null });
    expect(resolveAddress('javascript:alert(1)', t)).toMatchObject({ kind: 'refuse', chromeUrl: null });
  });
});

describe('Browse new tab page', () => {
  it('is shown when there are no tabs, with providers in three groups and the recent sessions', async () => {
    const recent = [conversation(), conversation({ threadKey: 'x:y', title: 'Not embeddable', canonicalUrl: 'https://example.com/a' })];
    await mount({ tabs: [], conversations: recent });
    expect(container.textContent).toContain('No open sessions');
    const groups = [...container.querySelectorAll('.tk-browse-launch-group')].map((g) => g.getAttribute('aria-label'));
    expect(groups).toEqual(['Coding agents', 'Chats', 'Bots']);
    const rows = [...container.querySelectorAll('.tk-browse-recent-row')];
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Retry Stripe webhooks');
    click(rows[0]);
    expect(spies.openSession).toHaveBeenCalledWith(recent[0], 'browse');
  });

  it('opens the chosen provider under the chosen account', async () => {
    await mount({ tabs: [] });
    const card = (name: string) => [...container.querySelectorAll('[role="group"]')].find((g) => g.querySelector('.tk-browse-prov-name')?.textContent === name)!;
    // Two accounts in the realm: one button per account.
    const claudeCode = card('Claude Code');
    const buttons = [...claudeCode.querySelectorAll('button')];
    expect(buttons.map((b) => b.textContent)).toEqual(['Open as Worksigned in', 'Open as Personal']);
    click(buttons[1]);
    expect(spies.openUrl).toHaveBeenCalledWith('https://claude.ai/code', { accountId: PERSONAL.id });
    // A realm with one account: a single Open button.
    const chatgpt = card('ChatGPT');
    const only = [...chatgpt.querySelectorAll('button')];
    expect(only.map((b) => b.textContent)).toEqual(['Open']);
    click(only[0]);
    expect(spies.openUrl).toHaveBeenLastCalledWith('https://chatgpt.com/', { accountId: 'primary~openai' });
  });

  it('opens over an existing tab with the new tab button, and Escape leaves it', async () => {
    await mount({ tabs: [tab('a', 'One')] });
    expect(q('[aria-label="New tab"]')).toBeNull();
    click(byName('Open new tab'));
    expect(q('[aria-label="New tab"]')).not.toBeNull();
    // The strip shows no selected tab, and the page controls rest.
    expect(tabs()[0].getAttribute('aria-selected')).toBe('false');
    expect((byName('Back') as HTMLButtonElement).disabled).toBe(true);
    key(q('[aria-label="New tab"]')!, 'Escape');
    expect(q('[aria-label="New tab"]')).toBeNull();
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true');
    expect(document.activeElement).toBe(byName('Open new tab'));
    await flush();
  });

  it('leaves the new tab page when a tab is chosen, and when a provider is opened', async () => {
    await mount({ tabs: [tab('a', 'One'), tab('b', 'Two')], active: 'a' });
    click(byName('Open new tab'));
    click(tabs()[1]);
    expect(q('[aria-label="New tab"]')).toBeNull();
    click(byName('Open new tab'));
    const claude = [...container.querySelectorAll('[role="group"]')].find((g) => g.querySelector('.tk-browse-prov-name')?.textContent === 'Claude')!;
    click(claude.querySelector('button'));
    expect(spies.openUrl).toHaveBeenCalled();
    expect(q('[aria-label="New tab"]')).toBeNull();
    await flush();
  });

  it('keeps the page open and says why when a provider cannot be opened', async () => {
    await mount({ tabs: [] });
    spies.openUrl.mockReturnValueOnce({ ok: false, reason: 'no_account', message: 'No account is set up for this sign-in.' });
    click(container.querySelector('.tk-browse-prov button'));
    expect(q('.tk-browse-notice')?.textContent).toContain('No account is set up for this sign-in.');
    expect(q('[aria-label="New tab"]')).not.toBeNull();
  });
});

describe('Browse summary panel', () => {
  const insight = (over: Partial<ThreadInsight> = {}): ThreadInsight =>
    ({
      threadKey: 'claude_code:primary:ws:s1:main', gist: 'Make Stripe webhook handling safe to retry.',
      agentRun: {
        repository: 'hypestake/hypestake', branch: 'tk/webhook-retries', pullRequests: [],
        filesChanged: ['src/payments/webhooks.ts', 'db/migrations/0042_webhook_events.sql'],
        commandsRun: [{ command: 'pnpm test payments', outcome: 'ok' }, { command: 'pnpm db:migrate --env staging', outcome: 'failed' }],
        tests: { status: 'passing', detail: 'One test skipped.' }, blockedOn: 'permission', runState: 'awaiting_user',
      },
      ...over,
    }) as unknown as ThreadInsight;
  const summary = (): StructuredSummaryRecord =>
    ({
      threadKey: 'claude_code:primary:ws:s1:main',
      whereYouLeftOff: 'The handler now writes every event first.', currentStatus: 'Waiting for approval.', nextStep: 'Allow the migration, then replay the events.',
    }) as unknown as StructuredSummaryRecord;

  it('toggles from the Summary button and shows nothing while closed', async () => {
    await mount({ tabs: [tab('a', 'One')] });
    const toggle = byName('Summary') as HTMLButtonElement;
    expect(toggle.getAttribute('aria-pressed')).toBe('false');
    expect(q('[aria-label="Session summary"]')).toBeNull();
    click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    const panel = q('aside[aria-label="Session summary"]')!;
    expect(panel).not.toBeNull();
    expect(toggle.getAttribute('aria-controls')).toBe(panel.id);
    // The page slot stays mounted through the change.
    expect(q('[data-tab="a"]')).not.toBeNull();
    // Escape inside the panel closes it and returns focus to the button.
    key(byName('Close summary')!, 'Escape');
    expect(q('[aria-label="Session summary"]')).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('says Threadkeeper saves the session by itself when the tab has no thread yet', async () => {
    await mount({ tabs: [tab('a', 'Brand new session')] });
    click(byName('Summary'));
    const panel = q('[aria-label="Session summary"]')!;
    expect(panel.textContent).toContain('Not saved yet');
    expect(panel.textContent).toContain('saves this session by itself');
    expect(panel.textContent).toContain('Nothing needs to be saved by hand');
    expect(byName('Open in Threads')).toBeNull();
  });

  it('shows the thread facts: meta line, gist, where you left off, next step and the agent run', async () => {
    const conv = conversation();
    await mount({
      tabs: [tab('a', 'One', { threadKey: conv.threadKey })],
      conversations: [conv], insights: [insight()], summaries: [summary()],
    });
    click(byName('Summary'));
    const panel = q('[aria-label="Session summary"]')!;
    const text = panel.textContent ?? '';
    expect(text).toContain('Retry Stripe webhooks');
    expect(text).toContain('Claude Code');
    expect(text).toContain('hypestake/hypestake');
    expect(text).toContain('tk/webhook-retries');
    expect(panel.querySelector('a[href="https://github.com/hypestake/hypestake/pull/482"]')?.textContent).toContain('#482');
    expect(text).toContain('Needs approval');
    expect(text).toContain('Observed 2 min ago');
    expect(text).toContain('Make Stripe webhook handling safe to retry.');
    expect(text).toContain('Where you left off');
    expect(text).toContain('The handler now writes every event first.');
    expect(text).toContain('Allow the migration, then replay the events.');
    expect(text).toContain('src/payments/webhooks.ts');
    expect(text).toContain('pnpm test payments');
    expect(text).toContain('Succeeded');
    expect(text).toContain('Failed');
    expect(text).toContain('One test skipped.');
    expect(text).toContain('Your approval');
  });

  it('falls back to the conversation\'s next step and opens the thread or pins it', async () => {
    const conv = conversation();
    await mount({ tabs: [tab('a', 'One', { threadKey: conv.threadKey })], conversations: [conv] });
    click(byName('Summary'));
    const panel = q('[aria-label="Session summary"]')!;
    expect(panel.textContent).toContain('Allow the staging migration.');
    expect(panel.textContent).not.toContain('Agent run');
    click(byName('Open in Threads'));
    expect(spies.openSession).toHaveBeenCalledWith(conv, 'threads');
    await act(async () => { byName('Pin to dashboard')!.click(); });
    expect(spies.togglePinned).toHaveBeenCalledWith(conv);
    expect(spies.announce).toHaveBeenCalledWith('Pinned to the dashboard');
  });

  it('offers to unpin a pinned session', async () => {
    const conv = conversation({ pinned: true });
    await mount({ tabs: [tab('a', 'One', { threadKey: conv.threadKey })], conversations: [conv] });
    click(byName('Summary'));
    expect(byName('Unpin from dashboard')).not.toBeNull();
  });
});
