import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountService } from '../../src/core/accounts/contract.js';
import { realmById } from '../../src/core/workspace/realms.js';
import type { AccountRecord, AccountsChangeResult, RealmAccounts, WorkspaceBroadcast } from '../../src/core/workspace/types.js';
import {
  WorkspaceTabs,
  decideNewTabAdoption,
  handleWorkspaceCommand,
  sanitizeIdentity,
  type WorkspaceCommandDeps,
} from '../../src/core/embed/workspace-tabs.js';
import { helperOpen, helperPing, type HelperEnv } from '../../src/core/embed/helper.js';
import type { EmbedRule } from '../../src/core/embed/rules.js';

const EXT = 'aaaabbbbccccddddaaaabbbbccccdddd';
const MANAGER = `chrome-extension://${EXT}/manager.html`;

function account(fields: Partial<AccountRecord> & { id: string; realm: string }): AccountRecord {
  return {
    label: 'Account',
    color: 'teal',
    mode: 'embedded',
    primary: false,
    identity: null,
    signedIn: 'unknown',
    hasJar: false,
    order: 0,
    createdAt: '2026-11-10T00:00:00.000Z',
    lastActiveAt: null,
    ...fields,
  };
}

const PRIMARY = account({ id: 'primary~openai', realm: 'openai', primary: true, label: 'Personal' });
const SECOND = account({ id: 'acct_5e00d0', realm: 'openai', label: 'Work', color: 'violet' });
const ISOLATED = account({ id: 'acct_150', realm: 'openai', mode: 'isolated', profileId: '0b6c3f8e-2f4a-4c1e-9a55-6f2d1c0e7b11' });
const REALMS: RealmAccounts[] = [{ realm: realmById('openai')!, accounts: [PRIMARY, SECOND, ISOLATED], activeAccountId: SECOND.id }];

/** An AccountService that records calls and answers from fixtures. */
function fakeAccounts(overrides: Partial<AccountService> = {}): AccountService & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const change = (acct: AccountRecord | null, switched: boolean): AccountsChangeResult => ({ ok: true, account: acct, realms: REALMS, switched });
  const svc: AccountService = {
    list: async (...args) => (calls.push(['list', args]), REALMS),
    activeAccount: async () => SECOND,
    resolveForCapture: async (_p, bound) => ({ ...bound, account: null }),
    add: async (...args) => (calls.push(['add', args]), change(account({ id: 'acct_new', realm: 'openai' }), true)),
    activate: async (...args) => (calls.push(['activate', args]), change(SECOND, true)),
    update: async (...args) => (calls.push(['update', args]), change(SECOND, false)),
    remove: async (...args) => (calls.push(['remove', args]), change(null, false)),
    noteIdentity: async () => null,
    recover: async () => undefined,
    ...overrides,
  };
  return Object.assign(svc, { calls });
}

function deps(accounts: AccountService | null) {
  const broadcasts: WorkspaceBroadcast[] = [];
  const rules = new Map<number, EmbedRule>();
  const tabs = new WorkspaceTabs({
    store: null,
    rules: {
      getSessionRules: async () => [...rules.values()],
      updateSessionRules: async (o) => {
        for (const id of o.removeRuleIds ?? []) rules.delete(id);
        for (const r of o.addRules ?? []) rules.set(r.id, r);
      },
    },
    tabUrl: async () => MANAGER,
    managerUrl: MANAGER,
  });
  const helperOpenSpy = vi.fn(async () => ({ ok: true as const }));
  const d: WorkspaceCommandDeps = {
    accounts,
    tabs,
    helperPing: async () => ({ ok: true, version: '1', platform: 'macOS' }),
    helperOpen: helperOpenSpy,
    broadcast: (m) => broadcasts.push(m),
  };
  return { d, broadcasts, rules, helperOpenSpy };
}

describe('workspace commands', () => {
  it('WORKSPACE_HELLO registers the tab, installs its rule and lists realms', async () => {
    const svc = fakeAccounts();
    const { d, rules } = deps(svc);
    expect(await handleWorkspaceCommand({ type: 'WORKSPACE_HELLO' }, 11, d)).toEqual({ ok: true, tabId: 11, embedding: true, realms: REALMS });
    expect(d.tabs.has(11)).toBe(true);
    expect([...rules.values()][0].condition).toEqual({ tabIds: [11], resourceTypes: ['sub_frame'] });
    // Without an account service the tab still registers.
    const bare = deps(null);
    expect(await handleWorkspaceCommand({ type: 'WORKSPACE_HELLO' }, 12, bare.d)).toEqual({ ok: true, tabId: 12, embedding: true, realms: [] });
  });

  it('delegates account changes with checked fields and broadcasts the realm afterwards', async () => {
    const svc = fakeAccounts();
    const { d, broadcasts } = deps(svc);
    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_LIST' }, 11, d)).toEqual({ ok: true, realms: REALMS });

    const added = await handleWorkspaceCommand({ type: 'ACCOUNTS_ADD', realm: 'openai', mode: 'embedded', label: '  Side project ', color: 'gold', extra: 'x' }, 11, d);
    expect(added).toMatchObject({ ok: true, switched: true });
    expect(svc.calls.find(([n]) => n === 'add')?.[1]).toEqual([{ realm: 'openai', mode: 'embedded', label: 'Side project', color: 'gold', profileId: undefined }]);

    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_ACTIVATE', accountId: SECOND.id }, 11, d)).toMatchObject({ ok: true, switched: true });
    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_UPDATE', accountId: SECOND.id, label: 'Client', color: 'blue' }, 11, d)).toMatchObject({ ok: true });
    expect(svc.calls.find(([n]) => n === 'update')?.[1]).toEqual([SECOND.id, { label: 'Client', color: 'blue' }]);
    // Remove answers account: null; the realm comes from the account as it was.
    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_REMOVE', accountId: SECOND.id }, 11, d)).toMatchObject({ ok: true, account: null });

    expect(broadcasts).toEqual([
      { type: 'ACCOUNTS_CHANGED', realm: 'openai', activeAccountId: SECOND.id, switched: true },
      { type: 'ACCOUNTS_CHANGED', realm: 'openai', activeAccountId: SECOND.id, switched: true },
      { type: 'ACCOUNTS_CHANGED', realm: 'openai', activeAccountId: SECOND.id, switched: false },
      { type: 'ACCOUNTS_CHANGED', realm: 'openai', activeAccountId: SECOND.id, switched: false },
    ]);
  });

  it('refuses malformed requests before they reach the service', async () => {
    const svc = fakeAccounts();
    const { d, broadcasts } = deps(svc);
    const bad = [
      { type: 'ACCOUNTS_ADD', realm: 'openai', mode: 'shared' },
      { type: 'ACCOUNTS_ADD', realm: 42, mode: 'embedded' },
      { type: 'ACCOUNTS_ADD', realm: 'openai', mode: 'embedded', color: 'red' },
      { type: 'ACCOUNTS_ADD', realm: 'openai', mode: 'embedded', label: 'x'.repeat(81) },
      { type: 'ACCOUNTS_ADD', realm: 'openai', mode: 'embedded', profileId: '0b6c3f8e-2f4a-4c1e-9a55-6f2d1c0e7b11' },
      { type: 'ACCOUNTS_ADD', realm: 'openai', mode: 'isolated', profileId: '../../etc' },
      { type: 'ACCOUNTS_ACTIVATE', accountId: { id: 1 } },
      { type: 'ACCOUNTS_UPDATE', accountId: SECOND.id, color: 'red' },
    ];
    for (const message of bad) expect(await handleWorkspaceCommand(message, 11, d), JSON.stringify(message)).toMatchObject({ ok: false });
    expect(svc.calls.filter(([n]) => n !== 'list')).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('passes service failures through without broadcasting, and hides thrown errors', async () => {
    const failing = fakeAccounts({ activate: async () => ({ ok: false, error: 'Busy', code: 'busy' }) });
    const { d, broadcasts } = deps(failing);
    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_ACTIVATE', accountId: SECOND.id }, 11, d)).toEqual({ ok: false, error: 'Busy', code: 'busy' });
    expect(broadcasts).toEqual([]);
    const throwing = fakeAccounts({ remove: async () => Promise.reject(new Error('cookie sid=secret')) });
    const res = await handleWorkspaceCommand({ type: 'ACCOUNTS_REMOVE', accountId: SECOND.id }, 11, deps(throwing).d);
    expect(res).toMatchObject({ ok: false });
    expect(JSON.stringify(res)).not.toContain('secret');
    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_LIST' }, 11, deps(null).d)).toMatchObject({ ok: false });
  });

  it('opens an isolated account through the helper with the stored account, not one from the message', async () => {
    const { d, helperOpenSpy } = deps(fakeAccounts());
    await handleWorkspaceCommand({ type: 'HELPER_OPEN', accountId: ISOLATED.id, url: 'https://chatgpt.com/', profileId: 'forged' }, 11, d);
    expect(helperOpenSpy).toHaveBeenCalledWith(ISOLATED, 'https://chatgpt.com/');
    await handleWorkspaceCommand({ type: 'HELPER_OPEN', accountId: 'acct_missing', url: 'https://chatgpt.com/' }, 11, d);
    expect(helperOpenSpy).toHaveBeenLastCalledWith(null, 'https://chatgpt.com/');
    expect(await handleWorkspaceCommand({ type: 'HELPER_PING' }, 11, d)).toEqual({ ok: true, version: '1', platform: 'macOS' });
  });
});

describe('Mac helper calls', () => {
  const env = (reply: unknown, permission = true): HelperEnv & { sent: unknown[] } => {
    const sent: unknown[] = [];
    return { sent, hasPermission: async () => permission, send: async (_h, m) => (sent.push(m), reply) };
  };

  it('answers helper_unavailable without the permission or the host', async () => {
    expect(await helperPing(null)).toMatchObject({ ok: false, code: 'helper_unavailable' });
    expect(await helperPing(env({ ok: true, version: '1', platform: 'macOS' }, false))).toMatchObject({ ok: false, code: 'helper_unavailable' });
    const broken: HelperEnv = { hasPermission: async () => true, send: async () => Promise.reject(new Error('Specified native messaging host not found.')) };
    expect(await helperPing(broken)).toMatchObject({ ok: false, code: 'helper_unavailable' });
    expect(await helperPing(env({ ok: true, version: '0.1.0', platform: 'macOS' }))).toEqual({ ok: true, version: '0.1.0', platform: 'macOS' });
  });

  it('sends only valid open requests, built from the stored account', async () => {
    const e = env({ ok: true, opened: true });
    expect(await helperOpen(e, ISOLATED, 'https://chatgpt.com/c/1')).toEqual({ ok: true });
    expect(e.sent).toEqual([{ type: 'open', profileId: ISOLATED.profileId, url: 'https://chatgpt.com/c/1' }]);
    expect(await helperOpen(e, SECOND, 'https://chatgpt.com/')).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(await helperOpen(e, ISOLATED, 'https://evil.example/')).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(await helperOpen(e, null, 'https://chatgpt.com/')).toMatchObject({ ok: false, code: 'unknown_account' });
    expect(e.sent).toHaveLength(1);
    const pathy = env({ ok: false, error: "EACCES: permission denied, mkdir '/Users/someone/Library'" });
    expect(await helperOpen(pathy, ISOLATED, 'https://chatgpt.com/')).toEqual({ ok: false, code: 'helper_unavailable', error: 'The Mac helper could not open that window.' });
  });
});

describe('identity reports', () => {
  it('rebuilds the identity from bounded fields only', () => {
    expect(sanitizeIdentity({ key: 'k1', display: 'a@b.c', source: 'network', extra: 'x' })).toEqual({ key: 'k1', display: 'a@b.c', detail: null, source: 'network' });
    expect(sanitizeIdentity({ key: 'k1', display: null, detail: 'Pro', source: 'dom' })).toEqual({ key: 'k1', display: null, detail: 'Pro', source: 'dom' });
    expect(sanitizeIdentity(null)).toBeNull();
    for (const bad of [undefined, 'x', { key: '', source: 'dom' }, { key: 'k', source: 'cookie' }, { key: 'k'.repeat(201), source: 'dom' }, { key: 'k', display: 5, source: 'dom' }, { key: 'k', detail: 'x'.repeat(201), source: 'dom' }]) {
      expect(sanitizeIdentity(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('new windows opened from the workspace', () => {
  it('adopts provider pages in normal windows only', () => {
    const d = (url: string | undefined, windowType = 'normal', openerIsWorkspace = true) => decideNewTabAdoption({ openerIsWorkspace, url, windowType });
    expect(d('https://chatgpt.com/c/1')).toBe('adopt');
    expect(d('https://claude.ai/code/session_abc')).toBe('adopt');
    expect(d('https://chatgpt.com/c/1', 'popup')).toBe('leave');
    expect(d('https://chatgpt.com/c/1', 'normal', false)).toBe('leave');
    expect(d('')).toBe('wait');
    expect(d(undefined)).toBe('wait');
    expect(d('about:blank')).toBe('wait');
    expect(d('https://auth.openai.com/authorize')).toBe('leave');
    expect(d('https://github.com/acme/app/pull/3')).toBe('leave');
    expect(d('http://chatgpt.com/')).toBe('leave');
    expect(d('https://evil.example/?tk_provider=chatgpt')).toBe('leave');
    expect(d('not a url')).toBe('leave');
  });
});

// ---- The real service worker, with a fake account service ------------------------------------

const fake = vi.hoisted(() => ({
  resolveForCapture: vi.fn(),
  noteIdentity: vi.fn(),
  list: vi.fn(),
}));

vi.mock('../../src/core/accounts/service.js', () => ({
  createAccountService: () => ({
    list: fake.list,
    activeAccount: async () => null,
    resolveForCapture: fake.resolveForCapture,
    add: async () => ({ ok: false, error: 'x' }),
    activate: async () => ({ ok: false, error: 'x' }),
    update: async () => ({ ok: false, error: 'x' }),
    remove: async () => ({ ok: false, error: 'x' }),
    noteIdentity: fake.noteIdentity,
    recover: async () => undefined,
  }),
}));
vi.mock('../../src/core/accounts/chrome-env.js', () => ({ chromeAccountsEnv: () => ({}) }));

describe('service worker wiring', () => {
  type Listener = (...args: unknown[]) => unknown;
  const listeners: Record<string, Listener> = {};
  const sent: unknown[] = [];
  const sessionRules = new Map<number, unknown>();
  const removedTabs: number[] = [];
  const updatedTabs: Array<[number, unknown]> = [];
  const tabsById = new Map<number, { id: number; url?: string; windowId: number }>();
  const windowTypes = new Map<number, string>([[1, 'normal'], [2, 'popup']]);
  const cookieJar = [
    { name: 'csrf', value: 't0k', domain: 'chatgpt.com', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true },
    { name: '__Secure-next-auth.session-token', value: 'secret', domain: '.chatgpt.com', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: false },
  ];

  const workspacePage = { id: EXT, url: `${MANAGER}?surface=page`, origin: `chrome-extension://${EXT}`, frameId: 0, tab: { id: 11, url: `${MANAGER}?surface=page` } };
  const sidePanel = { id: EXT, url: `chrome-extension://${EXT}/sidepanel.html` };
  const embeddedFrame = (url: string) => ({ id: EXT, url, origin: new URL(url).origin, frameId: 7, tab: { id: 11, url: `${MANAGER}?surface=page` } });
  const providerTab = (url: string) => ({ id: EXT, url, origin: new URL(url).origin, frameId: 0, tab: { id: 20, url } });

  function call(message: unknown, sender: unknown): Promise<Record<string, unknown>> {
    return new Promise((resolve) => {
      const keep = listeners.onMessage(message, sender, (r: unknown) => resolve(r as Record<string, unknown>));
      expect(keep).toBe(true);
    });
  }

  beforeAll(async () => {
    const session = new Map<string, unknown>();
    const event = (name: string) => ({ addListener: (fn: Listener) => void (listeners[name] = fn), removeListener: () => undefined });
    tabsById.set(11, { id: 11, url: `${MANAGER}?surface=page`, windowId: 1 });
    vi.stubGlobal('chrome', {
      runtime: {
        id: EXT,
        getURL: (p: string) => `chrome-extension://${EXT}/${p}`,
        getManifest: () => ({ version: '0.5.0' }),
        sendMessage: async (m: unknown) => void sent.push(m),
        onMessage: event('onMessage'),
        onMessageExternal: event('onMessageExternal'),
        onInstalled: event('onInstalled'),
        onStartup: event('onStartup'),
      },
      storage: {
        session: {
          get: async (k: string) => (session.has(k) ? { [k]: session.get(k) } : {}),
          set: async (items: Record<string, unknown>) => {
            for (const [k, v] of Object.entries(items)) session.set(k, JSON.parse(JSON.stringify(v)));
          },
        },
      },
      alarms: { create: async () => undefined, clear: async () => true, get: async () => undefined, onAlarm: event('onAlarm') },
      tabs: {
        onRemoved: event('tabs.onRemoved'),
        onCreated: event('tabs.onCreated'),
        onUpdated: event('tabs.onUpdated'),
        query: async () => [],
        create: async () => ({ id: 9, windowId: 1 }),
        update: async (id: number, props: unknown) => (updatedTabs.push([id, props]), { id, windowId: 1 }),
        get: async (id: number) => {
          const t = tabsById.get(id);
          if (!t) throw new Error('No tab');
          return t;
        },
        remove: async (id: number) => void removedTabs.push(id),
      },
      windows: { get: async (id: number) => ({ id, type: windowTypes.get(id) }), update: async () => ({}), create: async () => ({ id: 5 }) },
      declarativeNetRequest: {
        getSessionRules: async () => [...sessionRules.values()],
        updateSessionRules: async (o: { removeRuleIds?: number[]; addRules?: Array<{ id: number }> }) => {
          for (const id of o.removeRuleIds ?? []) sessionRules.delete(id);
          for (const r of o.addRules ?? []) sessionRules.set(r.id, r);
        },
      },
      cookies: {
        getAll: async (details: { url?: string }) => (details.url?.startsWith('https://chatgpt.com/') ? cookieJar : []),
        set: async () => null,
        remove: async () => ({}),
      },
    });
    await import('../../src/entrypoints/background.js');
  });

  it('registers a workspace tab on hello and refuses the side panel', async () => {
    fake.list.mockResolvedValue(REALMS);
    expect(await call({ type: 'WORKSPACE_HELLO' }, workspacePage)).toEqual({ ok: true, tabId: 11, embedding: true, realms: REALMS });
    expect([...sessionRules.values()]).toEqual([expect.objectContaining({ condition: { tabIds: [11], resourceTypes: ['sub_frame'] } })]);
    expect(await call({ type: 'WORKSPACE_HELLO' }, sidePanel)).toMatchObject({ ok: false });
    expect(await call({ type: 'HELPER_PING' }, workspacePage)).toMatchObject({ ok: false, code: 'helper_unavailable' });
  });

  it('files a capture under the account the resolver names, and validates coding fields', async () => {
    fake.resolveForCapture.mockImplementation(async (provider: string, bound: { accountId: string; workspaceId: string }) =>
      provider === 'chatgpt' ? { accountId: SECOND.id, workspaceId: bound.workspaceId, account: SECOND } : { ...bound, account: null }
    );
    const payload = {
      provider: 'chatgpt',
      sourceConversationId: 'c1',
      branchId: 'main',
      canonicalUrl: 'https://chatgpt.com/c/c1',
      title: 'Release plan',
      createdAt: null,
      updatedAt: null,
      coverage: 'partial',
      captureSource: 'dom_observer',
      messages: [{ sourceMessageId: 'm1', role: 'user', content: 'hello', createdAt: null }],
      repository: 'https://github.com/Acme/App',
      agentState: 'not-a-state',
      gitBranch: 'bad branch',
    };
    const res = await call({ type: 'PASSIVE_DOM_CAPTURE', payload }, providerTab('https://chatgpt.com/c/c1'));
    expect(res).toMatchObject({ ok: true, status: 'stored', threadKey: `chatgpt:${SECOND.id}:ws_personal:c1:main` });
    expect(fake.resolveForCapture).toHaveBeenCalledWith('chatgpt', { accountId: 'acct_chatgpt_primary', workspaceId: 'ws_personal' });
    const db = (globalThis as unknown as { __threadkeeperDb: { conversations: { get(k: string): Promise<Record<string, unknown> | undefined> } } }).__threadkeeperDb;
    const record = await db.conversations.get(`chatgpt:${SECOND.id}:ws_personal:c1:main`);
    expect(record).toMatchObject({ accountId: SECOND.id, repository: 'acme/app' });
    expect(record?.agentState ?? null).toBeNull();
    expect(record?.gitBranch ?? null).toBeNull();

    const auth = await call({ type: 'GET_CAPTURE_AUTH_STATE', provider: 'chatgpt' }, providerTab('https://chatgpt.com/c/c1'));
    expect(auth).toMatchObject({ ok: true, boundAccount: { accountId: SECOND.id, workspaceId: 'ws_personal' } });
  });

  it('accepts a capture from a page embedded in the workspace tab', async () => {
    const payload = {
      provider: 'chatgpt',
      sourceConversationId: 'c2',
      branchId: 'main',
      canonicalUrl: 'https://chatgpt.com/c/c2',
      title: 'Embedded',
      createdAt: null,
      updatedAt: null,
      coverage: 'partial',
      captureSource: 'dom_observer',
      messages: [{ sourceMessageId: 'm1', role: 'user', content: 'hi', createdAt: null }],
    };
    expect(await call({ type: 'PASSIVE_DOM_CAPTURE', payload }, embeddedFrame('https://chatgpt.com/c/c2'))).toMatchObject({ ok: true, status: 'stored' });
    // The same frame inside an unremembered tab is refused.
    const stray = { ...embeddedFrame('https://chatgpt.com/c/c2'), tab: { id: 77, url: `${MANAGER}?surface=page` } };
    expect(await call({ type: 'PASSIVE_DOM_CAPTURE', payload }, stray)).toMatchObject({ ok: false });
  });

  it('answers embedded frames: hello, cookies from the sender address, agent state, identity', async () => {
    expect(await call({ type: 'EMBED_HELLO', pane: 'tab_1', url: 'https://evil.example/', title: '' }, embeddedFrame('https://chatgpt.com/c/c1'))).toEqual({ ok: true, frameId: 7, tabId: 11 });
    // The cookie answer is for the frame's own address, without HttpOnly cookies, whatever the message says.
    expect(await call({ type: 'EMBED_COOKIES_GET', url: 'https://claude.ai/' }, embeddedFrame('https://chatgpt.com/c/c1'))).toEqual({ ok: true, cookie: 'csrf=t0k' });
    expect(await call({ type: 'EMBED_COOKIES_GET' }, providerTab('https://chatgpt.com/c/c1'))).toMatchObject({ ok: false });

    sent.length = 0;
    expect(await call({ type: 'EMBED_AGENT_STATE', pane: null, url: '', state: 'running' }, embeddedFrame('https://chatgpt.com/c/c1'))).toEqual({ ok: true });
    const db = (globalThis as unknown as { __threadkeeperDb: { conversations: { get(k: string): Promise<Record<string, unknown> | undefined> } } }).__threadkeeperDb;
    const key = `chatgpt:${SECOND.id}:ws_personal:c1:main`;
    expect(await db.conversations.get(key)).toMatchObject({ agentState: 'running', agentStateAt: expect.any(String) });
    expect(sent).toContainEqual({ type: 'LIBRARY_CHANGED', threadKey: key });
    // A second change inside five seconds waits for the window to end.
    await call({ type: 'EMBED_AGENT_STATE', pane: null, url: '', state: 'turn_complete' }, embeddedFrame('https://chatgpt.com/c/c1'));
    expect(await db.conversations.get(key)).toMatchObject({ agentState: 'running' });
    expect(await call({ type: 'EMBED_AGENT_STATE', pane: null, url: '', state: 'bogus' }, embeddedFrame('https://chatgpt.com/c/c1'))).toMatchObject({ ok: false });

    fake.noteIdentity.mockResolvedValue({ realm: 'openai', activeAccountId: SECOND.id, reassigned: true, updated: true });
    sent.length = 0;
    const id = await call(
      { type: 'ACCOUNT_IDENTITY', provider: 'chatgpt', identity: { key: 'h1', display: 'me@example.com', source: 'network', smuggled: 'x' } },
      providerTab('https://chatgpt.com/')
    );
    expect(id).toEqual({ ok: true });
    expect(fake.noteIdentity).toHaveBeenCalledWith('chatgpt', { key: 'h1', display: 'me@example.com', detail: null, source: 'network' });
    expect(sent).toContainEqual({ type: 'ACCOUNTS_CHANGED', realm: 'openai', activeAccountId: SECOND.id, switched: false });
    expect(await call({ type: 'ACCOUNT_IDENTITY', provider: 'claude', identity: null }, providerTab('https://chatgpt.com/'))).toMatchObject({ ok: false });
  });

  it('offers the ids for "Switch account" when a thread belongs to another account', async () => {
    const res = await call(
      { type: 'OPEN_ORIGINAL_THREAD', provider: 'chatgpt', canonicalUrl: 'https://chatgpt.com/c/old', expectedAccountId: 'acct_chatgpt_primary', expectedWorkspaceId: 'ws_personal' },
      workspacePage
    );
    expect(res).toEqual({
      ok: false,
      status: 'account_mismatch',
      boundAccount: { accountId: SECOND.id, workspaceId: 'ws_personal' },
      expectedAccount: { accountId: 'acct_chatgpt_primary', workspaceId: 'ws_personal' },
      realm: 'openai',
      activeAccountId: SECOND.id,
      switchToAccountId: PRIMARY.id,
    });
  });

  it('takes provider pages opened in a new normal window back into the workspace', async () => {
    tabsById.set(30, { id: 30, url: '', windowId: 1 });
    listeners['tabs.onCreated']({ id: 30, openerTabId: 11, url: '', windowId: 1 });
    await new Promise((r) => setTimeout(r, 10));
    tabsById.set(30, { id: 30, url: 'https://chatgpt.com/c/new', windowId: 1 });
    sent.length = 0;
    listeners['tabs.onUpdated'](30, { url: 'https://chatgpt.com/c/new' }, tabsById.get(30));
    await vi.waitFor(() => expect(removedTabs).toContain(30));
    expect(updatedTabs).toContainEqual([11, { active: true }]);
    await vi.waitFor(() => expect(sent).toContainEqual({ type: 'EMBED_OPEN_REQUEST', tabId: 11, url: 'https://chatgpt.com/c/new' }));

    // A sign-in popup window, and tabs opened by other tabs, are left alone.
    tabsById.set(31, { id: 31, url: 'https://chatgpt.com/auth', windowId: 2 });
    listeners['tabs.onCreated']({ id: 31, openerTabId: 11, url: '', windowId: 2 });
    tabsById.set(32, { id: 32, url: 'https://chatgpt.com/c/x', windowId: 1 });
    listeners['tabs.onCreated']({ id: 32, openerTabId: 20, url: '', windowId: 1 });
    await new Promise((r) => setTimeout(r, 20));
    expect(removedTabs).not.toContain(31);
    expect(removedTabs).not.toContain(32);
  });

  it('forgets a workspace tab when it closes', async () => {
    listeners['tabs.onRemoved'](11);
    await vi.waitFor(() => expect(sessionRules.size).toBe(0));
    expect(await call({ type: 'EMBED_HELLO', pane: null, url: '', title: '' }, embeddedFrame('https://chatgpt.com/c/c1'))).toMatchObject({ ok: false });
  });
});
