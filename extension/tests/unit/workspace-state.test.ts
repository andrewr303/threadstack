import { describe, expect, it } from 'vitest';
import {
  accountForThread,
  embedTargetFor,
  normalizeWorkspaceState,
  planFrames,
  sessionGroupOf,
  threadKeyForUrl,
  threadTabId,
  workspaceReducer,
  type WorkspaceAction,
} from '../../src/entrypoints/manager/workspace/state.js';
import { primaryAccountId, realmById, realmForProvider } from '../../src/core/workspace/realms.js';
import {
  EMPTY_WORKSPACE_STATE,
  type AccountRecord,
  type RealmAccounts,
  type SessionTab,
  type WorkspaceState,
} from '../../src/core/workspace/types.js';

function account(id: string, realm: string, extra: Partial<AccountRecord> = {}): AccountRecord {
  return {
    id,
    realm,
    label: id,
    color: 'teal',
    mode: 'embedded',
    primary: id === primaryAccountId(realm),
    identity: null,
    signedIn: 'unknown',
    hasJar: false,
    order: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastActiveAt: null,
    ...extra,
  };
}

const anthropic = realmById('anthropic')!;
const openai = realmById('openai')!;
const google = realmById('google')!;

function realms(activeClaude = primaryAccountId('anthropic')): RealmAccounts[] {
  return [
    {
      realm: anthropic,
      accounts: [account(primaryAccountId('anthropic'), 'anthropic'), account('acct_work000001', 'anthropic')],
      activeAccountId: activeClaude,
    },
    { realm: openai, accounts: [account(primaryAccountId('openai'), 'openai')], activeAccountId: primaryAccountId('openai') },
  ];
}

function open(id: string, url: string, accountId: string, now: number, extra: Partial<WorkspaceAction & { type: 'open' }> = {}): WorkspaceAction {
  const target = embedTargetFor(url)!;
  return { type: 'open', id, url, provider: target.provider, realm: target.realm.id, accountId, title: id, threadKey: null, now, ...extra };
}

function build(actions: WorkspaceAction[], start: WorkspaceState = EMPTY_WORKSPACE_STATE): WorkspaceState {
  return actions.reduce(workspaceReducer, start);
}

describe('embedTargetFor', () => {
  it('accepts https pages of known providers and names their realm', () => {
    expect(embedTargetFor('https://claude.ai/code/session_abc123')).toMatchObject({ provider: 'claude_code', realm: { id: 'anthropic' } });
    expect(embedTargetFor('https://chatgpt.com/codex/tasks/task_1')).toMatchObject({ provider: 'codex', realm: { id: 'openai' } });
    expect(embedTargetFor('https://x.com/i/chat/123')).toMatchObject({ provider: 'grok_bot', realm: { id: 'x' } });
    expect(embedTargetFor('https://cursor.com/agents')).toMatchObject({ provider: 'cursor_agents', realm: { id: 'cursor' } });
  });

  it('refuses other sites, http, credentials and non-AI pages of a shared host', () => {
    expect(embedTargetFor('https://example.com/')).toBeNull();
    expect(embedTargetFor('http://claude.ai/code')).toBeNull();
    expect(embedTargetFor('https://user:pw@claude.ai/code')).toBeNull();
    expect(embedTargetFor('https://x.com/home')).toBeNull();
    expect(embedTargetFor('not a url')).toBeNull();
  });
});

describe('session groups', () => {
  it('puts coding agents, chats and bots in their own groups', () => {
    expect(sessionGroupOf('claude_code')).toBe('coding');
    expect(sessionGroupOf('codex')).toBe('coding');
    expect(sessionGroupOf('cursor_agents')).toBe('coding');
    expect(sessionGroupOf('chatgpt')).toBe('chats');
    expect(sessionGroupOf('grok')).toBe('chats');
    expect(sessionGroupOf('grok_bot')).toBe('bots');
    expect(sessionGroupOf('chatgpt_dots')).toBe('bots');
    expect(sessionGroupOf('muse')).toBe('bots');
  });
});

describe('workspaceReducer', () => {
  it('opens tabs, activates the newest and re-focuses an existing thread tab instead of duplicating it', () => {
    const key = 'claude_code:acct_claude_code_primary:ws_personal:session_abc123:main';
    const s = build([
      open('tab_a', 'https://chatgpt.com/', primaryAccountId('openai'), 1),
      open(threadTabId(key), 'https://claude.ai/code/session_abc123', primaryAccountId('anthropic'), 2, { threadKey: key }),
      open('tab_b', 'https://grok.com/', 'primary~xai', 3),
      open(threadTabId(key), 'https://claude.ai/code/session_abc123', primaryAccountId('anthropic'), 4, { threadKey: key }),
    ]);
    expect(s.tabs.map((t) => t.id)).toEqual(['tab_a', threadTabId(key), 'tab_b']);
    expect(s.activeTabId).toBe(threadTabId(key));
    expect(s.tabs[1].lastActiveAt).toBe(4);
  });

  it('keeps the page a thread tab navigated to when the thread is opened again', () => {
    const key = 'claude_code:acct_claude_code_primary:ws_personal:session_abc123:main';
    const id = threadTabId(key);
    const s = build([
      open(id, 'https://claude.ai/code/session_abc123', primaryAccountId('anthropic'), 1, { threadKey: key }),
      { type: 'navigated', id, url: 'https://claude.ai/code/session_abc123?tab=diff', title: 'Diff' },
      open(id, 'https://claude.ai/code/session_abc123', primaryAccountId('anthropic'), 2, { threadKey: key }),
    ]);
    expect(s.tabs[0].url).toBe('https://claude.ai/code/session_abc123?tab=diff');
  });

  it('closing the active tab selects the neighbour to the right, else the left', () => {
    const base = build([
      open('a', 'https://chatgpt.com/', primaryAccountId('openai'), 1),
      open('b', 'https://chatgpt.com/', primaryAccountId('openai'), 2),
      open('c', 'https://chatgpt.com/', primaryAccountId('openai'), 3),
    ]);
    const middle = workspaceReducer(workspaceReducer(base, { type: 'activate', id: 'b', now: 4 }), { type: 'close', id: 'b' });
    expect(middle.activeTabId).toBe('c');
    const last = workspaceReducer(base, { type: 'close', id: 'c' });
    expect(last.activeTabId).toBe('b');
    const only = build([{ type: 'close', id: 'a' }, { type: 'close', id: 'b' }, { type: 'close', id: 'c' }], base);
    expect(only.activeTabId).toBeNull();
    expect(workspaceReducer(base, { type: 'close', id: 'missing' })).toBe(base);
  });

  it('records navigation, follows a move between products of one realm and ignores no-op updates', () => {
    const s = build([open('a', 'https://claude.ai/new', primaryAccountId('anthropic'), 1)]);
    const moved = workspaceReducer(s, { type: 'navigated', id: 'a', url: 'https://claude.ai/code/session_zz9', title: 'Fix build' });
    expect(moved.tabs[0]).toMatchObject({ url: 'https://claude.ai/code/session_zz9', title: 'Fix build', provider: 'claude_code' });
    expect(workspaceReducer(moved, { type: 'navigated', id: 'a', url: 'https://claude.ai/code/session_zz9', title: 'Fix build' })).toBe(moved);
    const kept = workspaceReducer(moved, { type: 'navigated', id: 'a', url: 'https://claude.ai/code/session_zz9', title: '' });
    expect(kept.tabs[0].title).toBe('Fix build');
  });

  it('never keeps more than 40 tabs and drops the least recently used one that is not showing', () => {
    let s = EMPTY_WORKSPACE_STATE;
    for (let i = 0; i < 41; i++) s = workspaceReducer(s, open(`t${i}`, 'https://chatgpt.com/', primaryAccountId('openai'), i + 1));
    expect(s.tabs).toHaveLength(40);
    expect(s.tabs.some((t) => t.id === 't0')).toBe(false);
    expect(s.activeTabId).toBe('t40');
  });

  it('dashboard: layout resizes the panes, a thread sits in one pane only, unpin clears it', () => {
    let s = workspaceReducer(EMPTY_WORKSPACE_STATE, { type: 'dashboard_layout', layout: 3 });
    expect(s.dashboard.panes).toEqual([null, null, null]);
    s = workspaceReducer(s, { type: 'dashboard_pane', index: 0, threadKey: 'k1' });
    s = workspaceReducer(s, { type: 'dashboard_pane', index: 2, threadKey: 'k2' });
    s = workspaceReducer(s, { type: 'dashboard_pane', index: 1, threadKey: 'k1' });
    expect(s.dashboard.panes).toEqual([null, 'k1', 'k2']);
    expect(s.dashboard.focusedPane).toBe(1);
    s = workspaceReducer(s, { type: 'dashboard_layout', layout: 1 });
    expect(s.dashboard).toEqual({ layout: 1, panes: [null], focusedPane: 0 });
    s = workspaceReducer(workspaceReducer(s, { type: 'dashboard_pane', index: 0, threadKey: 'k9' }), { type: 'dashboard_unpin', threadKey: 'k9' });
    expect(s.dashboard.panes).toEqual([null]);
    expect(workspaceReducer(s, { type: 'dashboard_pane', index: 5, threadKey: 'x' })).toBe(s);
  });

  it('moves the tabs of a removed account to the fallback account', () => {
    const s = build([
      open('a', 'https://claude.ai/new', 'acct_work000001', 1),
      { type: 'account_removed', accountId: 'acct_work000001', fallbackAccountId: primaryAccountId('anthropic') },
    ]);
    expect(s.tabs[0].accountId).toBe(primaryAccountId('anthropic'));
  });
});

describe('normalizeWorkspaceState', () => {
  it('drops malformed or unembeddable tabs, duplicate ids and a dangling active tab', () => {
    const tab: SessionTab = { id: 'a', provider: 'claude', realm: 'anthropic', accountId: 'p', url: 'https://claude.ai/new', title: 't', threadKey: null, createdAt: 1, lastActiveAt: 1 };
    const s = normalizeWorkspaceState({
      tabs: [tab, { ...tab }, { ...tab, id: 'b', url: 'https://evil.example/' }, { id: 5 }, null],
      activeTabId: 'gone',
      dashboard: { layout: 9, panes: ['k1', 'k1', 7], focusedPane: 4 },
      collapsedGroups: ['coding', 3],
    });
    expect(s.tabs.map((t) => t.id)).toEqual(['a']);
    expect(s.activeTabId).toBe('a');
    expect(s.dashboard).toEqual({ layout: 2, panes: ['k1', null], focusedPane: 0 });
    expect(s.collapsedGroups).toEqual(['coding']);
    expect(normalizeWorkspaceState(null)).toEqual(EMPTY_WORKSPACE_STATE);
  });
});

describe('planFrames', () => {
  const tabs: SessionTab[] = [
    { id: 'claude-main', provider: 'claude_code', realm: 'anthropic', accountId: primaryAccountId('anthropic'), url: 'https://claude.ai/code/a', title: '', threadKey: null, createdAt: 1, lastActiveAt: 5 },
    { id: 'claude-work', provider: 'claude_code', realm: 'anthropic', accountId: 'acct_work000001', url: 'https://claude.ai/code/b', title: '', threadKey: null, createdAt: 1, lastActiveAt: 9 },
    { id: 'codex', provider: 'codex', realm: 'openai', accountId: primaryAccountId('openai'), url: 'https://chatgpt.com/codex', title: '', threadKey: null, createdAt: 1, lastActiveAt: 3 },
    { id: 'gemini', provider: 'gemini', realm: 'google', accountId: primaryAccountId('google'), url: 'https://gemini.google.com/app', title: '', threadKey: null, createdAt: 1, lastActiveAt: 2 },
  ];

  it('loads only tabs of the signed-in account of a realm and pauses the other account', () => {
    const plan = planFrames({ tabs, visible: ['claude-work'], warmed: new Set(['claude-main', 'codex']), realms: realms(), maxLive: 6 });
    expect(plan.resting['claude-work']).toBe('account');
    expect(plan.live).toEqual(['claude-main', 'codex']);
    expect(plan.resting.gemini).toBe('asleep');
  });

  it('after switching accounts the other account loads and the first one pauses', () => {
    const plan = planFrames({ tabs, visible: ['claude-work'], warmed: new Set(['claude-main']), realms: realms('acct_work000001'), maxLive: 6 });
    expect(plan.live).toEqual(['claude-work']);
    expect(plan.resting['claude-main']).toBe('account');
  });

  it('different providers stay loaded side by side, and a realm that is not switched always loads', () => {
    const withGoogle: RealmAccounts[] = [...realms(), { realm: google, accounts: [], activeAccountId: null }];
    const plan = planFrames({ tabs, visible: ['codex', 'gemini', 'claude-main'], warmed: new Set(), realms: withGoogle, maxLive: 6 });
    expect(plan.live).toEqual(['codex', 'gemini', 'claude-main']);
  });

  it('keeps shown tabs first and unloads the least recently used beyond the limit', () => {
    const many: SessionTab[] = [1, 2, 3, 4].map((n) => ({ ...tabs[2], id: `c${n}`, lastActiveAt: n }));
    const plan = planFrames({ tabs: many, visible: ['c1'], warmed: new Set(['c1', 'c2', 'c3', 'c4']), realms: realms(), maxLive: 3 });
    expect(plan.live).toEqual(['c1', 'c4', 'c3']);
    expect(plan.resting.c2).toBe('asleep');
  });

  it('never embeds a tab of an account that lives in its own Chrome window', () => {
    const iso: RealmAccounts[] = [
      { realm: anthropic, accounts: [account(primaryAccountId('anthropic'), 'anthropic'), account('acct_iso0000001', 'anthropic', { mode: 'isolated', profileId: '11111111-1111-4111-8111-111111111111' })], activeAccountId: primaryAccountId('anthropic') },
    ];
    const plan = planFrames({ tabs: [{ ...tabs[1], accountId: 'acct_iso0000001' }], visible: ['claude-work'], warmed: new Set(), realms: iso, maxLive: 6 });
    expect(plan.live).toEqual([]);
    expect(plan.resting['claude-work']).toBe('isolated');
  });
});

describe('threads and accounts', () => {
  const bound = { accountId: 'acct_claude_code_primary', workspaceId: 'ws_personal' };

  it('maps a thread stored before accounts existed to the primary account', () => {
    const found = accountForThread({ provider: 'claude_code', accountId: 'acct_claude_code_primary' }, realms(), bound.accountId);
    expect(found?.account?.id).toBe(primaryAccountId('anthropic'));
    expect(found?.realm.id).toBe(realmForProvider('claude_code')!.id);
  });

  it('maps a thread captured under a second account to that account, and a removed account to none', () => {
    expect(accountForThread({ provider: 'claude_code', accountId: 'acct_work000001' }, realms(), bound.accountId)?.account?.id).toBe('acct_work000001');
    const gone = accountForThread({ provider: 'claude_code', accountId: 'acct_removed0001' }, realms(), bound.accountId);
    expect(gone?.account).toBeNull();
    expect(gone?.accountId).toBe('acct_removed0001');
    expect(accountForThread({ provider: 'imported', accountId: 'x' }, realms(), undefined)).toBeNull();
  });

  it('builds the thread key a capture of this page would use under each account', () => {
    const url = 'https://claude.ai/code/session_abc123';
    expect(threadKeyForUrl(url, account(primaryAccountId('anthropic'), 'anthropic'), bound)).toBe('claude_code:acct_claude_code_primary:ws_personal:session_abc123:main');
    expect(threadKeyForUrl(url, account('acct_work000001', 'anthropic'), bound)).toBe('claude_code:acct_work000001:ws_personal:session_abc123:main');
    expect(threadKeyForUrl('https://claude.ai/code', account('acct_work000001', 'anthropic'), bound)).toBeNull();
  });
});
