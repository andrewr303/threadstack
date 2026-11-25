import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Profiles, keepsAllCookies, realmOfHost, sameSiteRequest, setsSameSiteNone, type ProfilesDeps } from '../../src/core/embed/profiles.js';
import { ProfileSlots, type SeedRulesApi } from '../../src/core/embed/profile-slots.js';
import { ProfileJars } from '../../src/core/accounts/profile-jars.js';
import type { AccountService } from '../../src/core/accounts/contract.js';
import type { AccountRecord, StoredCookie } from '../../src/core/workspace/types.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const HOME = 'https://claude.ai/';
const SIGN_IN = 'sessionKey=sk-1; Path=/; Secure; HttpOnly';

function cookie(over: Partial<StoredCookie>): StoredCookie {
  return {
    name: 'c', value: '1', domain: 'claude.ai', hostOnly: true, path: '/', secure: true,
    httpOnly: false, sameSite: 'unspecified', session: true, ...over,
  };
}

function acct(id: string, realm = 'anthropic'): AccountRecord {
  return { id, realm, label: id, primary: false } as unknown as AccountRecord;
}

let accounts: Record<string, AccountRecord>;
let browserAccountId: string | null;
let savedJars: Record<string, StoredCookie[]>;
let deviceCookies: StoredCookie[];
let hostAccess: (patterns: string[]) => boolean;
let snapshots: string[];
let accountsAvailable: boolean;
let sessionRules: Set<number>;

let slots: ProfileSlots;
let jars: ProfileJars;
let profiles: Profiles;

const ruleApi: SeedRulesApi = {
  getSessionRules: async () => [...sessionRules].map((id) => ({ id })),
  updateSessionRules: async ({ removeRuleIds = [], addRules = [] }) => {
    removeRuleIds.forEach((id) => sessionRules.delete(id));
    addRules.forEach((r) => sessionRules.add(r.id));
  },
};

beforeEach(() => {
  accounts = { acct_a: acct('acct_a'), acct_b: acct('acct_b'), acct_gpt: acct('acct_gpt', 'openai'), primary: acct('primary~anthropic') };
  browserAccountId = 'primary~anthropic';
  savedJars = {};
  deviceCookies = [];
  hostAccess = () => true;
  snapshots = [];
  accountsAvailable = true;
  sessionRules = new Set();

  const service = {
    account: async (id: string) => accounts[id] ?? null,
    list: async (realmIds: string[]) => [{ realm: { id: realmIds[0] }, accounts: [], activeAccountId: browserAccountId }],
    snapshotBrowserAccount: async (realm: string) => void snapshots.push(realm),
    deviceCookies: async () => deviceCookies,
  } as unknown as AccountService;

  slots = new ProfileSlots({ store: null, rules: ruleApi, now: () => NOW, observesResponses: () => true });
  jars = new ProfileJars({
    read: async (id) => savedJars[id] ?? null,
    write: async (id, cookies) => void (savedJars[id] = cookies),
    now: () => NOW,
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
  });
  const deps: ProfilesDeps = {
    accounts: () => (accountsAvailable ? service : null),
    slots,
    jars,
    hasHostAccess: async (patterns) => hostAccess(patterns),
    now: () => NOW,
    randomHex: (n) => 'f'.repeat(n),
  };
  profiles = new Profiles(deps);
});

/** A tab with `accountId` ready in the anthropic slot. */
async function readyTab(tabId: number, accountId: string, realm = 'anthropic') {
  const claimed = await profiles.claim(tabId, realm, accountId);
  if (!claimed.ok) throw new Error(`claim failed: ${claimed.error}`);
  for (const url of claimed.steps) await profiles.onResponse({ tabId, frameId: 0, url, setCookies: [] });
  const ready = await profiles.markReady(tabId, realm);
  if (!ready.ok) throw new Error(ready.error);
}

const jarNames = async (id: string) => (await jars.cookies(id)).map((c) => c.name).sort();

describe('realmOfHost', () => {
  it('finds the switchable realm that owns a host or one of its subdomains', () => {
    expect(realmOfHost('claude.ai')?.id).toBe('anthropic');
    expect(realmOfHost('api.claude.ai')?.id).toBe('anthropic');
    expect(realmOfHost('chatgpt.com')?.id).toBe('openai');
    expect(realmOfHost('auth.openai.com')?.id).toBe('openai');
  });

  it('finds nothing for lookalikes, other sites, or no host', () => {
    expect(realmOfHost('notclaude.ai')).toBeNull();
    expect(realmOfHost('claude.ai.evil.com')).toBeNull();
    expect(realmOfHost('example.com')).toBeNull();
    expect(realmOfHost(null)).toBeNull();
    expect(realmOfHost('')).toBeNull();
  });
});

describe('claim', () => {
  it('shows an account that is not the browser\'s, without seeding when it has nothing saved', async () => {
    const result = await profiles.claim(5, 'anthropic', 'acct_a');
    expect(result).toEqual({ ok: true, realm: 'anthropic', accountId: 'acct_a', steps: [], signedIn: false, truncated: false });
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_a');
    expect(snapshots).toEqual(['anthropic']);
  });

  it('seeds a saved sign-in and reports it', async () => {
    savedJars.acct_a = [cookie({ name: 'sessionKey', httpOnly: true })];
    const result = await profiles.claim(5, 'anthropic', 'acct_a');
    expect(result).toMatchObject({ ok: true, signedIn: true, truncated: false });
    expect((result as { steps: string[] }).steps).toEqual([`https://claude.ai/robots.txt?tk_profile_seed=${'f'.repeat(24)}`]);
    expect(slots.accountFor(5, 'anthropic')).toBeNull(); // not ready until the page says so
  });

  it('carries the browser\'s device bot-check over when there is a saved jar', async () => {
    savedJars.acct_a = [cookie({ name: 'sessionKey', httpOnly: true })];
    deviceCookies = [cookie({ name: 'cf_clearance', httpOnly: true })];
    await profiles.claim(5, 'anthropic', 'acct_a');
    const [rule] = [...sessionRules];
    expect(rule).toBeDefined();
    expect(slots.slot(5, 'anthropic')?.pending).toHaveLength(1);
  });

  it('does not seed hosts ThreadStack has no access to', async () => {
    savedJars.acct_a = [cookie({ name: 'sessionKey', httpOnly: true })];
    hostAccess = () => false;
    expect(await profiles.claim(5, 'anthropic', 'acct_a')).toMatchObject({ ok: false, code: 'needs_host_access' });
    expect(slots.slot(5, 'anthropic')).toBeNull();
  });

  it('skips cookies of hosts the realm does not own', async () => {
    savedJars.acct_a = [cookie({ name: 'sessionKey', httpOnly: true }), cookie({ name: 'evil', domain: 'evil.com', httpOnly: true })];
    const result = (await profiles.claim(5, 'anthropic', 'acct_a')) as { steps: string[] };
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toContain('claude.ai');
  });

  it('refuses when accounts are not available', async () => {
    accountsAvailable = false;
    expect(await profiles.claim(5, 'anthropic', 'acct_a')).toMatchObject({ ok: false });
  });

  it('refuses realms that are unknown or not switchable', async () => {
    expect(await profiles.claim(5, 'nope', 'acct_a')).toMatchObject({ ok: false, code: 'not_switchable' });
    expect(await profiles.claim(5, 'google', 'acct_a')).toMatchObject({ ok: false, code: 'not_switchable' });
  });

  it('refuses an account that does not exist or belongs to another realm', async () => {
    expect(await profiles.claim(5, 'anthropic', 'acct_missing')).toMatchObject({ ok: false, code: 'unknown_account' });
    expect(await profiles.claim(5, 'anthropic', 'acct_gpt')).toMatchObject({ ok: false, code: 'unknown_account' });
    expect(slots.slot(5, 'anthropic')).toBeNull();
  });

  it('refuses the browser\'s own account, which lives in ordinary frames', async () => {
    browserAccountId = 'acct_a';
    expect(await profiles.claim(5, 'anthropic', 'acct_a')).toMatchObject({ ok: false, code: 'browser_account' });
    expect(slots.slot(5, 'anthropic')).toBeNull();
  });

  it('asks for a reload when the tab already shows another account of the realm', async () => {
    await profiles.claim(5, 'anthropic', 'acct_a');
    expect(await profiles.claim(5, 'anthropic', 'acct_b')).toMatchObject({ ok: false, code: 'needs_reload' });
  });
});

describe('markReady', () => {
  it('fails for a slot nobody claimed', async () => {
    expect(await profiles.markReady(5, 'anthropic')).toMatchObject({ ok: false, code: 'not_allowed' });
  });
});

describe('responses in profile and plain frames', () => {
  it('files a profile frame\'s Set-Cookie under that slot\'s account only', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, true);
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/api/login', setCookies: [SIGN_IN] });
    expect(await jarNames('acct_a')).toEqual(['sessionKey']);
    expect(await jarNames('acct_b')).toEqual([]);
    expect(await jarNames('primary~anthropic')).toEqual([]);
  });

  it('never files a plain frame\'s response in any profile jar', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 2, false);
    await profiles.onResponse({ tabId: 5, frameId: 2, url: 'https://claude.ai/api/login', setCookies: [SIGN_IN] });
    expect(await jarNames('acct_a')).toEqual([]);
  });

  it('files each tab\'s responses under that tab\'s account', async () => {
    await readyTab(5, 'acct_a');
    await readyTab(6, 'acct_b');
    await profiles.frameSeen(5, 3, true);
    await profiles.frameSeen(6, 3, true);
    await profiles.onResponse({ tabId: 6, frameId: 3, url: 'https://claude.ai/x', setCookies: ['b=1; Path=/'] });
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['a=1; Path=/'] });
    expect(await jarNames('acct_a')).toEqual(['a']);
    expect(await jarNames('acct_b')).toEqual(['b']);
  });

  it('files nothing for a profile frame whose slot is not ready or does not exist', async () => {
    savedJars.acct_a = [cookie({ name: 'sessionKey', httpOnly: true })];
    await profiles.claim(5, 'anthropic', 'acct_a'); // seeding
    await profiles.frameSeen(5, 3, true);
    await profiles.frameSeen(7, 3, true); // tab without any slot
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['a=1; Path=/'] });
    await profiles.onResponse({ tabId: 7, frameId: 3, url: 'https://claude.ai/x', setCookies: ['a=1; Path=/'] });
    expect(await jarNames('acct_a')).toEqual(['sessionKey']); // only what was saved; nothing filed
  });

  it('files nothing when the response host belongs to a realm the tab has no slot for', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, true);
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://chatgpt.com/x', setCookies: ['g=1; Path=/'] });
    expect(await jarNames('acct_a')).toEqual([]);
    expect(await jarNames('acct_gpt')).toEqual([]);
  });

  it('ignores hosts of no realm, the top frame, and responses without cookies', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, true);
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://example.com/x', setCookies: ['a=1'] });
    await profiles.onResponse({ tabId: 5, frameId: 0, url: 'https://claude.ai/x', setCookies: ['a=1; Path=/'] });
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: [] });
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'not a url', setCookies: ['a=1'] });
    expect(await jarNames('acct_a')).toEqual([]);
  });

  it('does not file a seeding address response as a page response', async () => {
    savedJars.acct_a = [cookie({ name: 'sessionKey', httpOnly: true })];
    const claimed = (await profiles.claim(5, 'anthropic', 'acct_a')) as { steps: string[] };
    await profiles.frameSeen(5, 3, true);
    await profiles.onResponse({ tabId: 5, frameId: 3, url: claimed.steps[0], setCookies: ['leak=1; Path=/'] });
    expect(slots.slot(5, 'anthropic')?.pending).toEqual([]);
    expect(await profiles.markReady(5, 'anthropic')).toEqual({ ok: true });
    expect(await jarNames('acct_a')).toEqual(['sessionKey']);
  });

  it('treats a frame inside a known profile frame as a profile frame, and inside a plain one as plain', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, true);
    await profiles.frameSeen(5, 2, false);
    await profiles.onResponse({ tabId: 5, frameId: 9, parentFrameId: 3, url: 'https://claude.ai/x', setCookies: ['child=1; Path=/'] });
    await profiles.onResponse({ tabId: 5, frameId: 10, parentFrameId: 2, url: 'https://claude.ai/x', setCookies: ['plainchild=1; Path=/'] });
    expect(await jarNames('acct_a')).toEqual(['child']);
  });

  describe('frames of unknown kind', () => {
    it('hold a response, file it when the frame turns out to be a profile frame', async () => {
      await readyTab(5, 'acct_a');
      await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['late=1; Path=/'] });
      expect(await jarNames('acct_a')).toEqual([]);
      await profiles.frameSeen(5, 3, true);
      expect(await jarNames('acct_a')).toEqual(['late']);
    });

    it('drop a held response when the frame turns out to be ordinary', async () => {
      await readyTab(5, 'acct_a');
      await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['late=1; Path=/'] });
      await profiles.frameSeen(5, 3, false);
      await profiles.frameSeen(5, 3, true);
      expect(await jarNames('acct_a')).toEqual([]);
    });

    it('do not release another tab\'s held response', async () => {
      await readyTab(5, 'acct_a');
      await readyTab(6, 'acct_b');
      await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['five=1; Path=/'] });
      await profiles.frameSeen(6, 3, true);
      expect(await jarNames('acct_a')).toEqual([]);
      expect(await jarNames('acct_b')).toEqual([]);
    });
  });
});

describe('accountOfFrame', () => {
  it('gives a frame nobody described no account, rather than any account', async () => {
    await readyTab(5, 'acct_a');
    expect(await profiles.accountOfFrame(5, 3, HOME)).toEqual({ kind: 'profile', account: null });
  });

  it('treats a frame known to be ordinary as the browser\'s', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, false);
    expect(await profiles.accountOfFrame(5, 3, HOME)).toEqual({ kind: 'plain' });
    expect(await profiles.accountOfFrame(5, 4, HOME, false)).toEqual({ kind: 'plain' });
  });

  it('gives a profile frame its slot\'s account once the slot is ready', async () => {
    await readyTab(5, 'acct_a');
    expect(await profiles.accountOfFrame(5, 3, HOME, true)).toEqual({ kind: 'profile', account: accounts.acct_a });
    // remembered: no hint needed afterwards
    expect(await profiles.accountOfFrame(5, 3, 'https://api.claude.ai/')).toEqual({ kind: 'profile', account: accounts.acct_a });
  });

  it('gives a profile frame no account while its slot is only seeding', async () => {
    savedJars.acct_a = [cookie({ name: 'sessionKey', httpOnly: true })];
    await profiles.claim(5, 'anthropic', 'acct_a');
    expect(await profiles.accountOfFrame(5, 3, HOME, true)).toEqual({ kind: 'profile', account: null });
  });

  it('gives a profile frame no account for a host of a realm it holds no slot for', async () => {
    await readyTab(5, 'acct_a');
    expect(await profiles.accountOfFrame(5, 3, 'https://chatgpt.com/', true)).toEqual({ kind: 'profile', account: null });
    expect(await profiles.accountOfFrame(5, 3, 'https://example.com/')).toEqual({ kind: 'profile', account: null });
    expect(await profiles.accountOfFrame(5, 3, 'garbage')).toEqual({ kind: 'profile', account: null });
  });

  it('gives a profile frame in a tab without a slot no account', async () => {
    expect(await profiles.accountOfFrame(8, 3, HOME, true)).toEqual({ kind: 'profile', account: null });
  });

  it('gives a profile frame no account when the account service is gone or forgot the account', async () => {
    await readyTab(5, 'acct_a');
    delete accounts.acct_a;
    expect(await profiles.accountOfFrame(5, 3, HOME, true)).toEqual({ kind: 'profile', account: null });
    accountsAvailable = false;
    expect(await profiles.accountOfFrame(5, 4, HOME, true)).toEqual({ kind: 'profile', account: null });
  });

  it('does not let a later hint change what a frame is known to be', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, false);
    expect(await profiles.accountOfFrame(5, 3, HOME, true)).toEqual({ kind: 'plain' });
    await profiles.frameSeen(5, 4, true);
    expect(await profiles.accountOfFrame(5, 4, HOME, false)).toMatchObject({ kind: 'profile' });
  });

  it('files held responses when a hint is what first tells the kind', async () => {
    await readyTab(5, 'acct_a');
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['held=1; Path=/'] });
    await profiles.accountOfFrame(5, 3, HOME, true);
    expect(await jarNames('acct_a')).toEqual(['held']);
  });
});

describe('accountReplaced', () => {
  it('drops the live jar so the next read comes from what was saved', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, true);
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['stale=1; Path=/'] });
    const flush = vi.spyOn(jars, 'forget');
    await profiles.accountReplaced('acct_a');
    expect(flush).toHaveBeenCalledWith('acct_a');
    savedJars.acct_a = [cookie({ name: 'fresh' })];
    expect(await jarNames('acct_a')).toEqual(['fresh']);
  });

  it('retires every slot showing the account: its old partition files nothing and the page must reload', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, true);
    expect(await profiles.accountReplaced('acct_a')).toEqual([{ tabId: 5, realmId: 'anthropic' }]);
    savedJars.acct_a = [cookie({ name: 'fresh' })];
    // The page still holding the old cookies keeps answering with them: none of it is kept.
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['old=1; Path=/; Secure'] });
    expect(savedJars.acct_a.map((c) => c.name)).toEqual(['fresh']);
    expect(await jarNames('acct_a')).toEqual(['fresh']);
    expect(await profiles.accountOfFrame(5, 3, 'https://claude.ai/chat/1')).toEqual({ kind: 'profile', account: null });
    expect(await profiles.claim(5, 'anthropic', 'acct_a')).toMatchObject({ ok: false, code: 'needs_reload' });
    expect(await profiles.markReady(5, 'anthropic')).toMatchObject({ ok: false, code: 'needs_reload' });
    // A reloaded page starts a new partition, seeded from the new saved sign-in.
    await slots.resetTab(5);
    expect((await profiles.claim(5, 'anthropic', 'acct_a')).ok).toBe(true);
  });

  it('leaves slots of other accounts alone and reports nothing for an account no page shows', async () => {
    await readyTab(5, 'acct_a');
    expect(await profiles.accountReplaced('acct_b')).toEqual([]);
    expect(slots.accountFor(5, 'anthropic')).toBe('acct_a');
  });
});

describe('one account in two workspace tabs', () => {
  it('moves the account on request and stops filing responses from the previous tab', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, true);
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['latest=1; Path=/; Secure'] });
    expect(await profiles.claim(6, 'anthropic', 'acct_a', true)).toMatchObject({ ok: true, movedFrom: [5] });
    expect(slots.slot(5, 'anthropic')?.status).toBe('stale');
    expect(await profiles.accountOfFrame(5, 3, 'https://claude.ai/x')).toEqual({ kind: 'profile', account: null });
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/x', setCookies: ['latest=old; Path=/; Secure'] });
    expect((await jars.cookies('acct_a')).find((c) => c.name === 'latest')?.value).toBe('1');
    expect(slots.slot(6, 'anthropic')?.accountId).toBe('acct_a');
  });

  it('is refused: two partitions would each change the one saved sign-in', async () => {
    await readyTab(5, 'acct_a');
    expect(await profiles.claim(6, 'anthropic', 'acct_a')).toMatchObject({ ok: false, code: 'profile_in_use' });
    expect(slots.slot(6, 'anthropic')).toBeNull();
    // Another account, or the same one once the first tab let go of it, is fine.
    expect((await profiles.claim(6, 'anthropic', 'acct_b')).ok).toBe(true);
    await slots.resetTab(6);
    await slots.resetTab(5);
    expect((await profiles.claim(6, 'anthropic', 'acct_a')).ok).toBe(true);
  });

  it('does not let a slot left behind by a page that went away block the account, and retires it', async () => {
    const live = new Set([6]);
    const own = new ProfileSlots({ store: null, rules: ruleApi, now: () => NOW, observesResponses: () => true, isWorkspaceTab: (t) => live.has(t) });
    const plan = { steps: [], skipped: 0, dropped: 0, truncated: false };
    expect((await own.claim(5, 'anthropic', 'acct_a', plan)).ok).toBe(true);
    // Tab 5 went to another address; tab 6 is a workspace page.
    expect((await own.claim(6, 'anthropic', 'acct_a', plan)).ok).toBe(true);
    expect(own.slot(5, 'anthropic')?.status).toBe('stale');
    expect(own.accountFor(5, 'anthropic')).toBeNull();
    expect(own.accountFor(6, 'anthropic')).toBe('acct_a');
    // While tab 6 is still a workspace page, tab 7 may not show the same account.
    live.add(7);
    expect(await own.claim(7, 'anthropic', 'acct_a', plan)).toMatchObject({ ok: false, code: 'profile_in_use' });
  });

  it('does not count a retired slot as showing the account', async () => {
    await readyTab(5, 'acct_a');
    await profiles.accountReplaced('acct_a');
    expect((await profiles.claim(6, 'anthropic', 'acct_a')).ok).toBe(true);
  });
});

describe('responses to requests another site started', () => {
  const LAX = 'sessionKey=attacker; Path=/; Secure; HttpOnly; SameSite=Lax';
  const UNSPECIFIED = 'sessionKey=attacker; Path=/; Secure; HttpOnly';
  const NONE = 'tracker=1; Path=/; Secure; SameSite=None';

  it('tells same-site requests from cross-site ones, scheme included', () => {
    const url = 'https://claude.ai/api/auth';
    expect(sameSiteRequest({ url })).toBe(true);
    expect(sameSiteRequest({ url, initiator: 'https://claude.ai' })).toBe(true);
    expect(sameSiteRequest({ url, initiator: 'https://www.claude.ai' })).toBe(true);
    expect(sameSiteRequest({ url, initiator: 'chrome-extension://own' }, 'chrome-extension://own')).toBe(true);
    expect(sameSiteRequest({ url, initiator: 'chrome-extension://other' }, 'chrome-extension://own')).toBe(false);
    expect(sameSiteRequest({ url, initiator: 'https://evil.example' })).toBe(false);
    expect(sameSiteRequest({ url, initiator: 'https://claude.ai.evil.example' })).toBe(false);
    expect(sameSiteRequest({ url, initiator: 'http://claude.ai' })).toBe(false);
    expect(sameSiteRequest({ url, initiator: 'null' })).toBe(false);
  });

  it('reads SameSite=None from the attributes only', () => {
    expect(setsSameSiteNone(NONE)).toBe(true);
    expect(setsSameSiteNone('a=1; samesite = none ; Secure')).toBe(true);
    expect(setsSameSiteNone(LAX)).toBe(false);
    expect(setsSameSiteNone(UNSPECIFIED)).toBe(false);
    expect(setsSameSiteNone('SameSite=None')).toBe(false);
  });

  it('keeps only SameSite=None cookies of a response to a request a page of another site made', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, true);
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/api/auth', setCookies: [LAX, UNSPECIFIED, NONE], initiator: 'https://evil.example' });
    expect(await jarNames('acct_a')).toEqual(['tracker']);
  });

  it('keeps every cookie of a request the page itself, the browser or this extension started', async () => {
    const own = new Profiles({
      accounts: () => null,
      slots,
      jars,
      hasHostAccess: async () => true,
      now: () => NOW,
      randomHex: (n) => 'f'.repeat(n),
      ownOrigin: 'chrome-extension://own',
    });
    await readyTab(5, 'acct_a');
    await own.frameSeen(5, 3, true);
    await own.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/a', setCookies: ['a=1; Path=/; Secure; SameSite=Lax'], initiator: 'https://claude.ai' });
    await own.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/b', setCookies: ['b=1; Path=/; Secure'] });
    await own.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/c', setCookies: ['c=1; Path=/; Secure; SameSite=Strict'], initiator: 'chrome-extension://own' });
    expect(await jarNames('acct_a')).toEqual(['a', 'b', 'c']);
  });

  it('keeps a sign-in that passes through the provider\'s other site', () => {
    // auth.openai.com sends the frame back to chatgpt.com: a navigation of the frame itself.
    expect(keepsAllCookies({ url: 'https://chatgpt.com/api/auth/callback/openai', initiator: 'https://auth.openai.com', type: 'sub_frame' })).toBe(true);
    // A chatgpt.com page asking auth.openai.com, and accounts.x.ai asking grok.com: one sign-in.
    expect(keepsAllCookies({ url: 'https://auth.openai.com/api/session', initiator: 'https://chatgpt.com', type: 'xmlhttprequest' })).toBe(true);
    expect(keepsAllCookies({ url: 'https://grok.com/rest/auth', initiator: 'https://accounts.x.ai', type: 'xmlhttprequest' })).toBe(true);
    // Another site, or the same sign-in's site over plain http, is not.
    expect(keepsAllCookies({ url: 'https://chatgpt.com/api/auth/session', initiator: 'https://evil.example', type: 'xmlhttprequest' })).toBe(false);
    expect(keepsAllCookies({ url: 'https://chatgpt.com/api/auth/session', initiator: 'http://auth.openai.com', type: 'xmlhttprequest' })).toBe(false);
    expect(keepsAllCookies({ url: 'https://claude.ai/api/auth', initiator: 'https://chatgpt.com', type: 'xmlhttprequest' })).toBe(false);
  });

  it('files the whole response of a navigation of a profile frame, whoever started it', async () => {
    await readyTab(5, 'acct_a');
    await profiles.frameSeen(5, 3, true);
    await profiles.onResponse({ tabId: 5, frameId: 3, url: 'https://claude.ai/login/callback', setCookies: [SIGN_IN], initiator: 'https://accounts.google.com', type: 'sub_frame' });
    expect(await jarNames('acct_a')).toEqual(['sessionKey']);
  });

  it('holds only the cookies the browser would keep for a frame not known yet', async () => {
    await readyTab(5, 'acct_a');
    await profiles.onResponse({ tabId: 5, frameId: 4, url: 'https://claude.ai/api/auth', setCookies: [LAX, NONE], initiator: 'https://evil.example' });
    await profiles.frameSeen(5, 4, true);
    expect(await jarNames('acct_a')).toEqual(['tracker']);
  });
});
