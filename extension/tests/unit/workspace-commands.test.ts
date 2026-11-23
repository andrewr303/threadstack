import 'fake-indexeddb/auto';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AccountService } from '../../src/core/accounts/contract.js';
import { realmById } from '../../src/core/workspace/realms.js';
import type { AccountRecord, AccountsChangeResult, PendingSignIn, RealmAccounts, WorkspaceBroadcast } from '../../src/core/workspace/types.js';
import {
  WorkspaceTabs,
  decideNewTabAdoption,
  handleWorkspaceCommand,
  sanitizeIdentity,
  type ProfileCommands,
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
    account: async (id) => REALMS[0].accounts.find((a) => a.id === id) ?? null,
    readJar: async () => null,
    writeJar: async () => undefined,
    deviceCookies: async () => [],
    snapshotBrowserAccount: async () => undefined,
    noteProfileIdentity: async () => null,
    beginBrowserSignIn: async (...args) => (calls.push(['beginBrowserSignIn', args]), change(PRIMARY, true)),
    finishBrowserSignIn: async (...args) => (calls.push(['finishBrowserSignIn', args]), change(PRIMARY, true)),
    cancelBrowserSignIn: async (...args) => (calls.push(['cancelBrowserSignIn', args]), change(PRIMARY, true)),
    pendingSignIn: async () => null,
    noteIdentity: async () => null,
    recover: async () => undefined,
    ...overrides,
  };
  return Object.assign(svc, { calls });
}

/** Profile commands that record what they were asked. */
function fakeProfiles(): ProfileCommands & { calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  return {
    calls,
    available: true,
    claim: async (...args) => (calls.push(['claim', args]), { ok: true, realm: args[1], accountId: args[2], steps: ['https://chatgpt.com/robots.txt?tk_profile_seed=abcdef0123'], signedIn: true, truncated: false }),
    ready: async (...args) => (calls.push(['ready', args]), { ok: true }),
    reset: async (...args) => void calls.push(['reset', args]),
    accountReplaced: async (...args) => void calls.push(['accountReplaced', args]),
    flush: async (...args) => void calls.push(['flush', args]),
  };
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
    expect(await handleWorkspaceCommand({ type: 'WORKSPACE_HELLO' }, 11, d)).toEqual({ ok: true, tabId: 11, embedding: true, profiles: false, realms: REALMS });
    expect(d.tabs.has(11)).toBe(true);
    expect([...rules.values()][0].condition).toEqual({ tabIds: [11], resourceTypes: ['sub_frame'] });
    // Without an account service the tab still registers.
    const bare = deps(null);
    expect(await handleWorkspaceCommand({ type: 'WORKSPACE_HELLO' }, 12, bare.d)).toEqual({ ok: true, tabId: 12, embedding: true, profiles: false, realms: [] });
  });

  it("a new page in a tab starts with empty profile slots, and says whether profiles' sign-ins are saved", async () => {
    const { d } = deps(fakeAccounts());
    const profiles = fakeProfiles();
    d.profiles = profiles;
    expect(await handleWorkspaceCommand({ type: 'WORKSPACE_HELLO' }, 11, d)).toMatchObject({ ok: true, profiles: true });
    expect(profiles.calls).toEqual([['reset', [11]]]);
    profiles.available = false;
    expect(await handleWorkspaceCommand({ type: 'WORKSPACE_HELLO' }, 11, d)).toMatchObject({ ok: true, profiles: false });
  });

  it('passes profile claims for this tab through with checked fields', async () => {
    const { d } = deps(fakeAccounts());
    const profiles = fakeProfiles();
    d.profiles = profiles;
    expect(await handleWorkspaceCommand({ type: 'PROFILE_CLAIM', realm: 'openai', accountId: PRIMARY.id, tabId: 99 }, 11, d)).toMatchObject({ ok: true, steps: [expect.stringContaining('tk_profile_seed')] });
    expect(await handleWorkspaceCommand({ type: 'PROFILE_READY', realm: 'openai' }, 11, d)).toEqual({ ok: true });
    // The tab is always the sender's own, never one the message names.
    expect(profiles.calls).toEqual([
      ['claim', [11, 'openai', PRIMARY.id, false]],
      ['ready', [11, 'openai']],
    ]);
    for (const bad of [
      { type: 'PROFILE_CLAIM', realm: 42, accountId: PRIMARY.id },
      { type: 'PROFILE_CLAIM', realm: 'openai', accountId: '' },
      { type: 'PROFILE_READY', realm: { id: 'openai' } },
    ]) {
      expect(await handleWorkspaceCommand(bad, 11, d), JSON.stringify(bad)).toMatchObject({ ok: false });
    }
    expect(profiles.calls).toHaveLength(2);
    // Without profile support, or without accounts, nothing is claimed.
    expect(await handleWorkspaceCommand({ type: 'PROFILE_CLAIM', realm: 'openai', accountId: PRIMARY.id }, 11, deps(fakeAccounts()).d)).toMatchObject({ ok: false });
    const noAccounts = deps(null);
    noAccounts.d.profiles = fakeProfiles();
    expect(await handleWorkspaceCommand({ type: 'PROFILE_CLAIM', realm: 'openai', accountId: PRIMARY.id }, 11, noAccounts.d)).toMatchObject({ ok: false });
  });

  it('starts a browser sign-in: opens the sign-in page, drops the stale copy and tells the pages', async () => {
    const pending = { realm: 'openai', accountId: PRIMARY.id, returnToAccountId: SECOND.id, startedAt: '', attemptId: 'attempt' };
    const svc = fakeAccounts({
      beginBrowserSignIn: async (...args) => {
        svc.calls.push(['beginBrowserSignIn', args]);
        return { ok: true, account: PRIMARY, switched: true, realms: REALMS.map((r) => ({ ...r, pendingSignIn: pending })) };
      },
      pendingSignIn: async () => pending,
    });
    const { d, broadcasts } = deps(svc);
    const profiles = fakeProfiles();
    const opened: string[] = [];
    d.profiles = profiles;
    d.openSignInTab = async (url) => void opened.push(url);
    const res = await handleWorkspaceCommand({ type: 'ACCOUNTS_SIGNIN_BEGIN', accountId: PRIMARY.id }, 11, d);
    expect(res).toMatchObject({ ok: true, switched: true });
    expect(svc.calls.find(([n]) => n === 'beginBrowserSignIn')?.[1]).toEqual([PRIMARY.id]);
    expect(opened).toEqual([realmById('openai')!.signInUrl]);
    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_SIGNIN_RESUME', attemptId: 'old' }, 11, d)).toMatchObject({ ok: false });
    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_SIGNIN_RESUME', attemptId: 'attempt' }, 11, d)).toMatchObject({ ok: true });
    expect(opened).toHaveLength(2);
    expect(profiles.calls).toContainEqual(['accountReplaced', [PRIMARY.id]]);
    expect(broadcasts).toEqual([{ type: 'ACCOUNTS_CHANGED', realm: 'openai', activeAccountId: SECOND.id, switched: true }]);
    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_SIGNIN_BEGIN', accountId: 7 }, 11, d)).toMatchObject({ ok: false, code: 'unknown_account' });
  });

  it('a failed sign-in start opens nothing and tells nobody', async () => {
    const svc = fakeAccounts({ beginBrowserSignIn: async () => ({ ok: false, error: 'Another account is still signing in.', code: 'signin_pending' }) });
    const { d, broadcasts } = deps(svc);
    const opened: string[] = [];
    d.openSignInTab = async (url) => void opened.push(url);
    expect(await handleWorkspaceCommand({ type: 'ACCOUNTS_SIGNIN_BEGIN', accountId: PRIMARY.id }, 11, d)).toMatchObject({ ok: false, code: 'signin_pending' });
    expect(opened).toEqual([]);
    expect(broadcasts).toEqual([]);
  });

  it('finishing or cancelling a sign-in closes its tab and drops both stale copies', async () => {
    const pending: PendingSignIn = { realm: 'openai', accountId: PRIMARY.id, returnToAccountId: SECOND.id, startedAt: '' };
    for (const type of ['ACCOUNTS_SIGNIN_FINISH', 'ACCOUNTS_SIGNIN_CANCEL'] as const) {
      const svc = fakeAccounts({ pendingSignIn: async () => pending });
      const { d, broadcasts } = deps(svc);
      const profiles = fakeProfiles();
      let closed = 0;
      d.profiles = profiles;
      d.closeSignInTab = async () => void closed++;
      expect(await handleWorkspaceCommand({ type }, 11, d)).toMatchObject({ ok: true });
      expect(svc.calls.map(([n]) => n)).toContain(type === 'ACCOUNTS_SIGNIN_FINISH' ? 'finishBrowserSignIn' : 'cancelBrowserSignIn');
      expect(closed).toBe(1);
      expect(profiles.calls).toEqual([
        ['accountReplaced', [PRIMARY.id]],
        ['accountReplaced', [SECOND.id]],
      ]);
      expect(broadcasts).toHaveLength(1);
    }
  });

  it('removing an account, or making it the browser account, drops the stale copy of its cookies; renaming does not', async () => {
    const { d } = deps(fakeAccounts());
    const profiles = fakeProfiles();
    d.profiles = profiles;
    await handleWorkspaceCommand({ type: 'ACCOUNTS_UPDATE', accountId: SECOND.id, label: 'Client' }, 11, d);
    expect(profiles.calls).toEqual([]);
    await handleWorkspaceCommand({ type: 'ACCOUNTS_ACTIVATE', accountId: SECOND.id }, 11, d);
    await handleWorkspaceCommand({ type: 'ACCOUNTS_REMOVE', accountId: SECOND.id }, 11, d);
    expect(profiles.calls).toEqual([
      // What its pages changed is saved before its jar goes into the browser.
      ['flush', [SECOND.id]],
      ['accountReplaced', [SECOND.id]],
      ['accountReplaced', [SECOND.id]],
    ]);
  });

  it("removing the browser's own account also retires the account the browser goes to", async () => {
    const afterRemoval: RealmAccounts[] = [{ ...REALMS[0], accounts: [PRIMARY], activeAccountId: PRIMARY.id }];
    const { d } = deps(fakeAccounts({ remove: async () => ({ ok: true, account: null, realms: afterRemoval, switched: true }) }));
    const profiles = fakeProfiles();
    d.profiles = profiles;
    await handleWorkspaceCommand({ type: 'ACCOUNTS_REMOVE', accountId: SECOND.id }, 11, d);
    expect(profiles.calls).toEqual([
      ['accountReplaced', [SECOND.id]],
      ['accountReplaced', [PRIMARY.id]],
    ]);
  });

  it('retires the slots of a replaced account before announcing the change', async () => {
    const { d, broadcasts } = deps(fakeAccounts());
    const order: string[] = [];
    const profiles = fakeProfiles();
    profiles.accountReplaced = async (accountId) => {
      // Still nothing announced while the slots are being retired.
      order.push(`retire ${accountId} after ${broadcasts.length} broadcasts`);
    };
    d.profiles = profiles;
    await handleWorkspaceCommand({ type: 'ACCOUNTS_ACTIVATE', accountId: SECOND.id }, 11, d);
    expect(order).toEqual([`retire ${SECOND.id} after 0 broadcasts`]);
    expect(broadcasts.map((b) => b.type)).toEqual(['ACCOUNTS_CHANGED']);
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
  noteProfileIdentity: vi.fn(),
  list: vi.fn(),
  account: vi.fn(),
  readJar: vi.fn(),
  writeJar: vi.fn(),
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
    account: fake.account,
    readJar: fake.readJar,
    writeJar: fake.writeJar,
    deviceCookies: async () => [],
    snapshotBrowserAccount: async () => undefined,
    noteProfileIdentity: fake.noteProfileIdentity,
    beginBrowserSignIn: async () => ({ ok: false, error: 'x' }),
    finishBrowserSignIn: async () => ({ ok: false, error: 'x' }),
    cancelBrowserSignIn: async () => ({ ok: false, error: 'x' }),
    pendingSignIn: async () => null,
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
  let openRequestAnswer: unknown = undefined;
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
        sendMessage: async (m: unknown) => {
          sent.push(m);
          // The workspace page answers the worker's adoption question.
          return (m as { type?: string })?.type === 'EMBED_OPEN_REQUEST' ? openRequestAnswer : undefined;
        },
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
      permissions: { contains: async () => true, onAdded: event('permissions.onAdded'), onRemoved: event('permissions.onRemoved') },
    });
    await import('../../src/entrypoints/background.js');
  });

  it('registers a workspace tab on hello and refuses the side panel', async () => {
    fake.list.mockResolvedValue(REALMS);
    // This stand-in browser has no webRequest: a profile's sign-in would not be saved, and the page is told.
    expect(await call({ type: 'WORKSPACE_HELLO' }, workspacePage)).toEqual({ ok: true, tabId: 11, embedding: true, profiles: false, realms: REALMS });
    expect([...sessionRules.values()]).toEqual([expect.objectContaining({ condition: { tabIds: [11], resourceTypes: ['sub_frame'], excludedRequestDomains: ['localhost'] } })]);
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
    // The frame's content script says what it is first (an ordinary frame), as every document does.
    expect(await call({ type: 'EMBED_HELLO', pane: 'tab_1', url: 'https://chatgpt.com/c/c2', title: '', profile: false }, embeddedFrame('https://chatgpt.com/c/c2'))).toMatchObject({ ok: true });
    expect(await call({ type: 'PASSIVE_DOM_CAPTURE', payload }, embeddedFrame('https://chatgpt.com/c/c2'))).toMatchObject({ ok: true, status: 'stored' });
    // A frame that never said what it is could be another account's: nothing is filed for it.
    const unknown = { ...embeddedFrame('https://chatgpt.com/c/c2'), frameId: 8 };
    expect(await call({ type: 'PASSIVE_DOM_CAPTURE', payload: { ...payload, sourceConversationId: 'c3', canonicalUrl: 'https://chatgpt.com/c/c3' } }, { ...unknown, url: 'https://chatgpt.com/c/c3' })).toMatchObject({ ok: false, skipped: 'no_account' });
    // The same frame inside an unremembered tab is refused.
    const stray = { ...embeddedFrame('https://chatgpt.com/c/c2'), tab: { id: 77, url: `${MANAGER}?surface=page` } };
    expect(await call({ type: 'PASSIVE_DOM_CAPTURE', payload }, stray)).toMatchObject({ ok: false });
  });

  it('answers embedded frames: hello, cookies from the sender address, agent state, identity', async () => {
    expect(await call({ type: 'EMBED_HELLO', pane: 'tab_1', url: 'https://evil.example/', title: '', profile: false }, embeddedFrame('https://chatgpt.com/c/c1'))).toEqual({ ok: true, frameId: 7, tabId: 11 });
    // The cookie answer is for the frame's own address, without HttpOnly cookies, whatever the message says.
    expect(await call({ type: 'EMBED_COOKIES_GET', url: 'https://claude.ai/', profile: false }, embeddedFrame('https://chatgpt.com/c/c1'))).toEqual({ ok: true, cookie: 'csrf=t0k' });
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
    expect(fake.noteIdentity).toHaveBeenCalledWith('chatgpt', { key: 'h1', display: 'me@example.com', detail: null, source: 'network' }, undefined);
    expect(sent).toContainEqual({ type: 'ACCOUNTS_CHANGED', realm: 'openai', activeAccountId: SECOND.id, switched: false });
    expect(await call({ type: 'ACCOUNT_IDENTITY', provider: 'claude', identity: null }, providerTab('https://chatgpt.com/'))).toMatchObject({ ok: false });
  });

  it("files a profile frame's capture, cookies and identity under the profile's account, never the browser's", async () => {
    fake.list.mockResolvedValue(REALMS);
    fake.account.mockImplementation(async (id: string) => REALMS[0].accounts.find((a) => a.id === id) ?? null);
    const jarCookie = (name: string, value: string, httpOnly: boolean) => ({
      name, value, domain: 'chatgpt.com', hostOnly: true, path: '/', secure: true, httpOnly, sameSite: 'lax' as const, session: false, expirationDate: 4102444800,
    });
    fake.readJar.mockResolvedValue([jarCookie('__Secure-next-auth.session-token', 'PRIMARY-SECRET', true), jarCookie('csrf', 'primary-csrf', false)]);
    fake.writeJar.mockResolvedValue(undefined);
    await call({ type: 'WORKSPACE_HELLO' }, workspacePage);

    // The browser account loads in ordinary frames; only another account can take the slot.
    expect(await call({ type: 'PROFILE_CLAIM', realm: 'openai', accountId: SECOND.id }, workspacePage)).toMatchObject({ ok: false, code: 'browser_account' });
    const claim = await call({ type: 'PROFILE_CLAIM', realm: 'openai', accountId: PRIMARY.id }, workspacePage);
    expect(claim).toMatchObject({ ok: true, realm: 'openai', accountId: PRIMARY.id, signedIn: true, truncated: false });
    const steps = claim.steps as string[];
    expect(steps).toEqual([expect.stringMatching(/^https:\/\/chatgpt\.com\/robots\.txt\?tk_profile_seed=[0-9a-f]{24}$/)]);
    // One rule, for this tab and that one address, adding the account's cookies to its answer.
    const seedRules = [...sessionRules.values()].filter((r) => (r as { id: number }).id >= 2000) as Array<{ condition: Record<string, unknown>; action: { responseHeaders: Array<{ header: string; operation: string; value?: string }> } }>;
    expect(seedRules).toHaveLength(1);
    expect(seedRules[0].condition).toEqual({ tabIds: [11], urlFilter: `|${steps[0]}|`, resourceTypes: ['sub_frame'] });
    expect(seedRules[0].action.responseHeaders.filter((h) => h.header === 'set-cookie').map((h) => h.value)).toEqual([
      'csrf=primary-csrf; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Secure; SameSite=Lax',
      '__Secure-next-auth.session-token=PRIMARY-SECRET; Path=/; Expires=Fri, 01 Jan 2100 00:00:00 GMT; Secure; HttpOnly; SameSite=Lax',
    ]);
    expect(await call({ type: 'PROFILE_READY', realm: 'openai' }, workspacePage)).toEqual({ ok: true });
    expect([...sessionRules.values()].some((r) => (r as { id: number }).id >= 2000)).toBe(false);
    // A page shows one profile per sign-in; another one needs the page reloaded.
    expect(await call({ type: 'PROFILE_CLAIM', realm: 'openai', accountId: ISOLATED.id }, workspacePage)).toMatchObject({ ok: false, code: 'needs_reload' });

    const profileFrame = (url: string) => ({ ...embeddedFrame(url), frameId: 9 });
    expect(await call({ type: 'EMBED_HELLO', pane: 'tab_2', url: '', title: '', profile: true }, profileFrame('https://chatgpt.com/c/p1'))).toMatchObject({ ok: true, frameId: 9 });

    // Script cookies come from the profile's own jar, never the browser's, and never HttpOnly ones.
    expect(await call({ type: 'EMBED_COOKIES_GET', profile: true }, profileFrame('https://chatgpt.com/c/p1'))).toEqual({ ok: true, cookie: 'csrf=primary-csrf' });
    expect(await call({ type: 'EMBED_COOKIE_SET', cookie: 'theme=dark; Path=/', profile: true }, profileFrame('https://chatgpt.com/c/p1'))).toEqual({ ok: true });
    expect(await call({ type: 'EMBED_COOKIES_GET', profile: true }, profileFrame('https://chatgpt.com/c/p1'))).toEqual({ ok: true, cookie: 'csrf=primary-csrf; theme=dark' });

    const before = fake.resolveForCapture.mock.calls.length;
    const payload = {
      provider: 'chatgpt',
      sourceConversationId: 'p1',
      branchId: 'main',
      canonicalUrl: 'https://chatgpt.com/c/p1',
      title: 'Profile chat',
      createdAt: null,
      updatedAt: null,
      coverage: 'partial',
      captureSource: 'dom_observer',
      messages: [{ sourceMessageId: 'm1', role: 'user', content: 'hi', createdAt: null }],
    };
    // The browser is signed in as SECOND; this page is PRIMARY's (which keeps its pre-accounts id).
    expect(await call({ type: 'PASSIVE_DOM_CAPTURE', payload }, profileFrame('https://chatgpt.com/c/p1'))).toMatchObject({
      ok: true,
      status: 'stored',
      threadKey: 'chatgpt:acct_chatgpt_primary:ws_personal:p1:main',
    });
    expect(fake.resolveForCapture.mock.calls.length).toBe(before);

    // Who signed in there is that profile's identity; the browser's own is not touched.
    fake.noteIdentity.mockClear();
    fake.noteProfileIdentity.mockResolvedValue({ realm: 'openai', activeAccountId: PRIMARY.id, reassigned: false, updated: true });
    expect(await call({ type: 'ACCOUNT_IDENTITY', provider: 'chatgpt', identity: { key: 'h2', display: 'p@example.com', source: 'network' } }, profileFrame('https://chatgpt.com/'))).toEqual({ ok: true });
    expect(fake.noteProfileIdentity).toHaveBeenCalledWith(PRIMARY.id, { key: 'h2', display: 'p@example.com', detail: null, source: 'network' });
    expect(fake.noteIdentity).not.toHaveBeenCalled();

    // What the page set is saved to the profile's jar shortly after.
    await new Promise((r) => setTimeout(r, 750));
    const saved = fake.writeJar.mock.calls.find(([id]) => id === PRIMARY.id)?.[1] as Array<{ name: string }> | undefined;
    expect(saved?.map((c) => c.name).sort()).toEqual(['__Secure-next-auth.session-token', 'csrf', 'theme']);

    // A reloaded page starts over: the frame is unknown again and nothing is filed for it.
    await call({ type: 'WORKSPACE_HELLO' }, workspacePage);
    const again = { ...payload, sourceConversationId: 'p2', canonicalUrl: 'https://chatgpt.com/c/p2' };
    expect(await call({ type: 'PASSIVE_DOM_CAPTURE', payload: again }, profileFrame('https://chatgpt.com/c/p2'))).toMatchObject({ ok: false, skipped: 'no_account' });
    expect(await call({ type: 'EMBED_COOKIES_GET', profile: true }, profileFrame('https://chatgpt.com/c/p2'))).toEqual({ ok: true, cookie: '' });
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
    openRequestAnswer = { ok: true, adopted: true };
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
    openRequestAnswer = undefined;
  });

  it('leaves a ChatGPT or Claude tab the user opens next to the full-tab manager open', async () => {
    // Cmd/Ctrl+T while the manager is the active tab: Chrome names it the opener, and the new tab
    // page's address is not visible to the extension, so the tab waits for an address.
    tabsById.set(40, { id: 40, windowId: 1 });
    listeners['tabs.onCreated']({ id: 40, openerTabId: 11, windowId: 1 });
    await new Promise((r) => setTimeout(r, 10));
    tabsById.set(40, { id: 40, url: 'https://chatgpt.com/', windowId: 1 });
    sent.length = 0;
    updatedTabs.length = 0;
    // The workspace page saw no click inside an embedded page and does not take it in.
    openRequestAnswer = { ok: true, adopted: false };
    listeners['tabs.onUpdated'](40, { url: 'https://chatgpt.com/' }, tabsById.get(40));
    await vi.waitFor(() => expect(sent).toContainEqual({ type: 'EMBED_OPEN_REQUEST', tabId: 11, url: 'https://chatgpt.com/' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(removedTabs).not.toContain(40);
    expect(updatedTabs).toEqual([]);

    // A tab Threadkeeper itself opens (Open original, online import) with no workspace page answering.
    openRequestAnswer = undefined;
    tabsById.set(41, { id: 41, url: 'https://claude.ai/chat/abc', windowId: 1 });
    listeners['tabs.onCreated']({ id: 41, openerTabId: 11, url: 'https://claude.ai/chat/abc', windowId: 1 });
    await vi.waitFor(() => expect(sent).toContainEqual({ type: 'EMBED_OPEN_REQUEST', tabId: 11, url: 'https://claude.ai/chat/abc' }));
    await new Promise((r) => setTimeout(r, 20));
    expect(removedTabs).not.toContain(41);
    expect(updatedTabs).toEqual([]);
  });

  it('forgets a workspace tab when it closes', async () => {
    listeners['tabs.onRemoved'](11);
    await vi.waitFor(() => expect(sessionRules.size).toBe(0));
    expect(await call({ type: 'EMBED_HELLO', pane: null, url: '', title: '' }, embeddedFrame('https://chatgpt.com/c/c1'))).toMatchObject({ ok: false });
  });
});
