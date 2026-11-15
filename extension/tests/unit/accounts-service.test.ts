import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ThreadkeeperDB } from '../../src/core/db.js';
import type { AccountService, AccountsEnv } from '../../src/core/accounts/contract.js';
import { cookieSlot, sameCookie } from '../../src/core/accounts/cookies.js';
import { SWITCH_SETTLE_MS, createAccountService, type AccountsSwitchResult } from '../../src/core/accounts/service.js';
import { primaryAccountId, switchableRealms } from '../../src/core/workspace/realms.js';
import { KV_KEYS, type AccountsChangeResult, type StoredCookie, type WorkspaceFailure } from '../../src/core/workspace/types.js';

let n = 0;
const freshDb = () => new ThreadkeeperDB(`ThreadkeeperAccounts_${Date.now()}_${++n}`);

const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

/** An in-memory cookie store that behaves like chrome.cookies for the service's purposes. */
class FakeEnv implements AccountsEnv {
  cookies: StoredCookie[] = [];
  refuse = new Set<string>();
  denied = new Set<string>();
  /** Every second remove throws: a worker stopped half way through clearing. */
  crash = false;
  private removes = 0;
  clock = Date.parse('2026-11-10T10:00:00.000Z');
  private hex = 0;

  async getCookies(domain: string): Promise<StoredCookie[]> {
    await tick();
    return this.cookies
      .filter((c) => {
        const d = c.domain.replace(/^\./, '');
        return d === domain || d.endsWith(`.${domain}`);
      })
      .map((c) => structuredClone(c));
  }
  async setCookie(cookie: StoredCookie): Promise<boolean> {
    await tick();
    if (this.refuse.has(cookie.name)) return false;
    this.cookies = this.cookies.filter((c) => !sameCookie(c, cookie));
    this.cookies.push(structuredClone(cookie));
    return true;
  }
  async removeCookie(cookie: StoredCookie): Promise<void> {
    await tick();
    if (this.crash && ++this.removes % 2 === 0) throw new Error('worker stopped');
    this.cookies = this.cookies.filter((c) => !sameCookie(c, cookie));
  }
  async hasHostAccess(patterns: string[]): Promise<boolean> {
    return patterns.every((p) => !this.denied.has(p));
  }
  now(): Date {
    return new Date(this.clock);
  }
  randomHex(length: number): string {
    return (++this.hex).toString(16).padStart(length, '0');
  }
  advance(ms: number): void {
    this.clock += ms;
  }
  /** What a person signing in on claude.ai leaves behind. */
  signIn(tag: string): StoredCookie[] {
    const set: StoredCookie[] = [
      { name: '__Host-sess', value: `SECRET-${tag}-sess`, domain: 'claude.ai', hostOnly: true, path: '/', secure: true, httpOnly: true, sameSite: 'strict', session: true },
      { name: 'sessionKey', value: `SECRET-${tag}-key`, domain: '.claude.ai', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: false, expirationDate: 1794429242 },
      { name: 'csrf', value: `SECRET-${tag}-csrf`, domain: 'claude.ai', hostOnly: true, path: '/api', secure: true, httpOnly: false, sameSite: 'unspecified', session: true },
      {
        name: 'part',
        value: `SECRET-${tag}-part`,
        domain: 'claude.ai',
        hostOnly: true,
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'no_restriction',
        session: true,
        partitionKey: { topLevelSite: 'https://claude.ai', hasCrossSiteAncestor: false },
      },
    ];
    this.cookies = this.cookies.filter((c) => !c.domain.endsWith('claude.ai')).concat(structuredClone(set));
    return set;
  }
  realmCookies(domain = 'claude.ai'): StoredCookie[] {
    return this.cookies.filter((c) => c.domain.replace(/^\./, '').endsWith(domain));
  }
}

const sorted = (cookies: StoredCookie[]) => cookies.slice().sort((a, b) => cookieSlot(a).localeCompare(cookieSlot(b)));

function ok<T extends AccountsChangeResult>(result: T | WorkspaceFailure): T {
  if (!result.ok) throw new Error(`expected ok, got ${result.code}: ${result.error}`);
  return result;
}

const ANTHROPIC = 'anthropic';
const PRIMARY = primaryAccountId(ANTHROPIC);

function setup() {
  const db = freshDb();
  const env = new FakeEnv();
  const service = createAccountService(db, env);
  return { db, env, service };
}

async function addAccount(service: AccountService, label?: string) {
  return ok(await service.add({ realm: ANTHROPIC, mode: 'embedded', label }));
}

/**
 * Add an account and make it the browser's own sign-in at once: the realm is then signed out in
 * the browser, ready for that account's sign-in (how every account used to be added).
 */
async function addAndUse(service: AccountService, label?: string) {
  const added = await addAccount(service, label);
  ok(await service.activate(added.account!.id));
  return added;
}

describe('account service: list', () => {
  it('creates the primary account of every switchable realm on first list', async () => {
    const { db, service } = setup();
    const realms = await service.list();
    expect(realms.map((r) => r.realm.id)).toEqual(switchableRealms().map((r) => r.id));
    for (const entry of realms) {
      expect(entry.accounts).toHaveLength(1);
      const [primary] = entry.accounts;
      expect(primary).toMatchObject({
        id: primaryAccountId(entry.realm.id),
        realm: entry.realm.id,
        primary: true,
        mode: 'embedded',
        label: 'Main account',
        color: 'teal',
        signedIn: 'unknown',
        hasJar: false,
        identity: null,
      });
      expect(entry.activeAccountId).toBe(primary.id);
    }
    expect(realms.some((r) => r.realm.id === 'google')).toBe(false);
    await service.list();
    expect(await db.accounts.count()).toBe(switchableRealms().length);
  });

  it('limits the answer to the realms asked for', async () => {
    const { service } = setup();
    const realms = await service.list([ANTHROPIC, 'google', 'nope']);
    expect(realms.map((r) => r.realm.id)).toEqual([ANTHROPIC]);
  });
});

describe('account service: add and activate', () => {
  it('adding an account touches no cookie and leaves the browser signed in as it was', async () => {
    const { db, env, service } = setup();
    const p = env.signIn('P');
    const result = await addAccount(service);
    expect(result.switched).toBe(false);
    expect(result.account).toMatchObject({ label: 'Account 2', color: 'peach', mode: 'embedded', primary: false, signedIn: 'no', hasJar: false });
    expect(result.account!.id).toMatch(/^acct_[0-9a-f]{10}$/);
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    const anthropic = result.realms.find((r) => r.realm.id === ANTHROPIC)!;
    expect(anthropic.activeAccountId).toBe(PRIMARY);
    expect(anthropic.accounts.map((a) => a.id)).toEqual([PRIMARY, result.account!.id]);
    expect(anthropic.pendingSignIn).toBeNull();
    expect(await db.accountJars.count()).toBe(0);
    expect(await db.kv.get(KV_KEYS.switchJournal)).toBeUndefined();
    expect(await db.kv.get(KV_KEYS.activeAccounts)).toBeUndefined();
  });

  it("making an added account the browser's sign-in saves the outgoing jar, clears cookies and switches", async () => {
    const { db, env, service } = setup();
    env.signIn('P');
    env.cookies.push({ name: 'other', value: 'keep', domain: 'example.test', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true });
    const added = await addAccount(service);
    const result = ok(await service.activate(added.account!.id));
    expect(result.switched).toBe(true);
    expect(result.account).toMatchObject({ id: added.account!.id, signedIn: 'no', hasJar: false });
    expect(env.realmCookies()).toEqual([]);
    expect(env.cookies.map((c) => c.name)).toEqual(['other']);
    const anthropic = result.realms.find((r) => r.realm.id === ANTHROPIC)!;
    expect(anthropic.activeAccountId).toBe(added.account!.id);
    expect(anthropic.accounts[0].hasJar).toBe(true);
    const jar = await db.accountJars.get(PRIMARY);
    expect(jar?.cookieCount).toBe(4);
    expect(await db.kv.get(KV_KEYS.switchJournal)).toBeUndefined();
    expect((await db.kv.get(KV_KEYS.activeAccounts))?.value).toEqual({ [ANTHROPIC]: added.account!.id });
  });

  it('activate restores exactly the saved cookies and removes the restored jar', async () => {
    const { db, env, service } = setup();
    const primaryCookies = env.signIn('P');
    const added = await addAndUse(service);
    const second = env.signIn('B');
    const result = ok(await service.activate(PRIMARY)) as AccountsSwitchResult;
    expect(result.switched).toBe(true);
    expect(result.refusedCookies).toBe(0);
    expect(sorted(env.realmCookies())).toEqual(sorted(primaryCookies));
    expect(await db.accountJars.get(PRIMARY)).toBeUndefined();
    const accounts = result.realms.find((r) => r.realm.id === ANTHROPIC)!.accounts;
    expect(accounts.find((a) => a.id === PRIMARY)).toMatchObject({ hasJar: false });
    expect(accounts.find((a) => a.id === added.account!.id)).toMatchObject({ hasJar: true });
    expect(result.account?.lastActiveAt).toBe(new Date(env.clock).toISOString());
    // Switching back gives the second account its own login again.
    ok(await service.activate(added.account!.id));
    expect(sorted(env.realmCookies())).toEqual(sorted(second));
  });

  it('two accounts ping-pong without losing either login', async () => {
    const { db, env, service } = setup();
    const p = env.signIn('P');
    const b = (await addAndUse(service)).account!.id;
    const bCookies = env.signIn('B');
    for (let round = 0; round < 4; round++) {
      ok(await service.activate(PRIMARY));
      expect(sorted(env.realmCookies())).toEqual(sorted(p));
      ok(await service.activate(b));
      expect(sorted(env.realmCookies())).toEqual(sorted(bCookies));
    }
    expect(await db.accountJars.count()).toBe(1);
    expect((await db.accountJars.get(PRIMARY))?.cookieCount).toBe(4);
  });

  it('activating the active account changes nothing', async () => {
    const { env, service } = setup();
    const p = env.signIn('P');
    const result = ok(await service.activate(PRIMARY));
    expect(result.switched).toBe(false);
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
  });

  it('a cookie the browser refuses is reported but does not stop the switch', async () => {
    const { env, service } = setup();
    const p = env.signIn('P');
    await addAndUse(service);
    env.refuse.add('csrf');
    const result = ok(await service.activate(PRIMARY)) as AccountsSwitchResult;
    expect(result.switched).toBe(true);
    expect(result.refusedCookies).toBe(1);
    expect(sorted(env.realmCookies())).toEqual(sorted(p.filter((c) => c.name !== 'csrf')));
    expect(result.realms.find((r) => r.realm.id === ANTHROPIC)!.activeAccountId).toBe(PRIMARY);
  });

  it('an account whose jar cannot be read is restored signed out', async () => {
    const { db, env, service } = setup();
    env.signIn('P');
    await addAndUse(service);
    const jar = (await db.accountJars.get(PRIMARY))!;
    await db.accountJars.put({ ...jar, data: new Uint8Array(jar.data.byteLength).buffer });
    const result = ok(await service.activate(PRIMARY));
    expect(result.switched).toBe(true);
    expect(env.realmCookies()).toEqual([]);
    expect(result.account).toMatchObject({ signedIn: 'no', hasJar: false });
    expect(await db.accountJars.get(PRIMARY)).toBeUndefined();
  });

  it('concurrent activate calls run one after the other', async () => {
    const { db, env, service } = setup();
    const p = env.signIn('P');
    const b = (await addAndUse(service)).account!.id;
    const bCookies = env.signIn('B');
    const results = await Promise.all([service.activate(PRIMARY), service.activate(b), service.activate(PRIMARY), service.activate(b)]);
    expect(results.every((r) => r.ok && r.switched)).toBe(true);
    expect(sorted(env.realmCookies())).toEqual(sorted(bCookies));
    expect((await service.activeAccount(ANTHROPIC))?.id).toBe(b);
    expect((await db.accountJars.get(PRIMARY))?.cookieCount).toBe(4);
    ok(await service.activate(PRIMARY));
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
  });

  it('an interrupted switch is finished by recover()', async () => {
    const db = freshDb();
    const env = new FakeEnv();
    const service = createAccountService(db, env);
    const p = env.signIn('P');
    const b = (await addAndUse(service)).account!.id;
    const bCookies = env.signIn('B');
    env.crash = true;
    const failed = await service.activate(PRIMARY);
    expect(failed.ok).toBe(false);
    // The worker stopped: the journal is written, B's jar is saved, cookies are half cleared.
    const journal = (await db.kv.get(KV_KEYS.switchJournal))?.value;
    expect(journal).toMatchObject({ realm: ANTHROPIC, fromAccountId: b, toAccountId: PRIMARY, phase: 'saved' });
    expect(env.realmCookies().length).toBeGreaterThan(0);
    expect(env.realmCookies().length).toBeLessThan(4);
    expect(await db.accountJars.get(b)).toBeDefined();

    env.crash = false;
    const restarted = createAccountService(db, env);
    await restarted.recover();
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    expect(await db.kv.get(KV_KEYS.switchJournal)).toBeUndefined();
    expect((await restarted.activeAccount(ANTHROPIC))?.id).toBe(PRIMARY);
    await restarted.recover();
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    // B's login survived the crash.
    ok(await restarted.activate(b));
    expect(sorted(env.realmCookies())).toEqual(sorted(bCookies));
  });

  it('recover() with nothing pending does nothing', async () => {
    const { env, service } = setup();
    const p = env.signIn('P');
    await service.recover();
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
  });
});

describe('account service: refusals', () => {
  it('refuses embedded accounts in realms it does not switch', async () => {
    const { env, service } = setup();
    const result = await service.add({ realm: 'google', mode: 'embedded' });
    expect(result).toMatchObject({ ok: false, code: 'not_switchable' });
    expect(await service.add({ realm: 'site.perplexity', mode: 'embedded' })).toMatchObject({ ok: false, code: 'not_switchable' });
    expect(await service.add({ realm: 'nope', mode: 'embedded' })).toMatchObject({ ok: false });
    expect(await service.noteIdentity('gemini', { key: 'g:1', display: null, source: 'network' })).toBeNull();
    expect(env.cookies).toEqual([]);
  });

  it('needs host access for at least one cookie domain', async () => {
    const { env, service } = setup();
    env.denied.add('https://claude.ai/*');
    expect(await service.add({ realm: ANTHROPIC, mode: 'embedded' })).toMatchObject({ ok: false, code: 'needs_host_access' });
    env.denied.clear();
    for (const d of ['chatgpt.com', 'chat.openai.com']) env.denied.add(`https://${d}/*`);
    // auth.openai.com alone is enough to proceed.
    expect((await service.add({ realm: 'openai', mode: 'embedded' })).ok).toBe(true);
  });

  it('an account asked for as "isolated" is an ordinary account that keeps the profile id it came with', async () => {
    const { db, env, service } = setup();
    const p = env.signIn('P');
    const result = ok(await service.add({ realm: ANTHROPIC, mode: 'isolated', label: 'Work', color: 'gold' }));
    expect(result.switched).toBe(false);
    expect(result.account).toMatchObject({ mode: 'embedded', label: 'Work', color: 'gold', hasJar: false, signedIn: 'no' });
    expect(result.account!.profileId).toBeUndefined();
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    expect((await service.activeAccount(ANTHROPIC))?.id).toBe(PRIMARY);
    const kept = ok(await service.add({ realm: ANTHROPIC, mode: 'isolated', profileId: 'A1B2C3D4-0000-4000-8000-000000000001' }));
    expect(kept.account).toMatchObject({ mode: 'embedded', profileId: 'a1b2c3d4-0000-4000-8000-000000000001' });
    expect(await service.add({ realm: ANTHROPIC, mode: 'isolated', profileId: '../../etc' })).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(await service.add({ realm: ANTHROPIC, mode: 'window' as never })).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(await db.accountJars.count()).toBe(0);
  });

  it('reads an account stored as isolated by an earlier version as an account that needs a sign-in, and rewrites it', async () => {
    const { db, service } = setup();
    await service.list();
    const legacy = {
      id: 'acct_legacy0001',
      realm: ANTHROPIC,
      label: 'Admin',
      color: 'violet' as const,
      mode: 'isolated' as const,
      profileId: 'a1b2c3d4-0000-4000-8000-000000000002',
      primary: false,
      identity: null,
      signedIn: 'yes' as const,
      hasJar: true,
      order: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      lastActiveAt: null,
    };
    await db.accounts.add(legacy);
    const anthropic = (await service.list([ANTHROPIC]))[0];
    const admin = anthropic.accounts.find((a) => a.id === legacy.id)!;
    // It never had cookies in this browser profile, whatever its record said.
    expect(admin).toMatchObject({ mode: 'embedded', hasJar: false, signedIn: 'unknown', profileId: legacy.profileId, label: 'Admin' });
    expect(await db.accounts.get(legacy.id)).toMatchObject({ mode: 'embedded', hasJar: false });
    expect(await service.account(legacy.id)).toMatchObject({ mode: 'embedded' });
    expect(anthropic.activeAccountId).toBe(PRIMARY);
  });

  it('still lists a sign-in it keeps no accounts for when an earlier version stored an account there', async () => {
    const { db, service } = setup();
    await db.accounts.add({
      id: 'acct_legacy0002',
      realm: 'google',
      label: 'Work Google',
      color: 'peach',
      mode: 'isolated',
      primary: false,
      identity: null,
      signedIn: 'unknown',
      hasJar: false,
      order: 1,
      createdAt: '2026-11-01T00:00:00.000Z',
      lastActiveAt: null,
    });
    const google = (await service.list()).find((r) => r.realm.id === 'google')!;
    expect(google.accounts.map((a) => [a.label, a.mode])).toEqual([
      ['Main account', 'embedded'],
      ['Work Google', 'embedded'],
    ]);
    expect(google.activeAccountId).toBe(primaryAccountId('google'));
    expect(await service.add({ realm: 'google', mode: 'isolated', label: 'Another' })).toMatchObject({ ok: false, code: 'not_switchable' });
  });

  it('unknown accounts are reported', async () => {
    const { service } = setup();
    expect(await service.activate('acct_missing')).toMatchObject({ ok: false, code: 'unknown_account' });
    expect(await service.remove('acct_missing')).toMatchObject({ ok: false, code: 'unknown_account' });
    expect(await service.update('acct_missing', { label: 'x' })).toMatchObject({ ok: false, code: 'unknown_account' });
  });
});

describe('account service: update and remove', () => {
  it('renames and recolours an account', async () => {
    const { service } = setup();
    await service.list();
    const result = ok(await service.update(PRIMARY, { label: '  Personal  ', color: 'violet' }));
    expect(result.account).toMatchObject({ label: 'Personal', color: 'violet' });
    expect(await service.update(PRIMARY, { label: '   ' })).toMatchObject({ ok: false, code: 'not_allowed' });
    expect(await service.update(PRIMARY, { color: 'pink' as never })).toMatchObject({ ok: false, code: 'not_allowed' });
  });

  it('refuses to remove the primary account', async () => {
    const { service } = setup();
    await service.list();
    expect(await service.remove(PRIMARY)).toMatchObject({ ok: false, code: 'not_allowed' });
  });

  it('removing the active account falls back to the primary account', async () => {
    const { db, env, service } = setup();
    const p = env.signIn('P');
    const b = (await addAndUse(service)).account!.id;
    env.signIn('B');
    const result = ok(await service.remove(b));
    expect(result.switched).toBe(true);
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    expect(await db.accounts.get(b)).toBeUndefined();
    expect(await db.accountJars.get(b)).toBeUndefined();
    expect(await db.accountJars.count()).toBe(0);
    const anthropic = result.realms.find((r) => r.realm.id === ANTHROPIC)!;
    expect(anthropic.activeAccountId).toBe(PRIMARY);
    expect(anthropic.accounts.map((a) => a.id)).toEqual([PRIMARY]);
  });

  it('removing an inactive account deletes it and its jar only', async () => {
    const { db, env, service } = setup();
    env.signIn('P');
    const b = (await addAndUse(service)).account!.id;
    const bCookies = env.signIn('B');
    ok(await service.activate(PRIMARY));
    expect(await db.accountJars.get(b)).toBeDefined();
    const result = ok(await service.remove(b));
    expect(result.switched).toBe(false);
    expect(await db.accountJars.get(b)).toBeUndefined();
    expect(env.realmCookies().some((c) => bCookies.some((x) => x.value === c.value))).toBe(false);
  });
});

describe('account service: identity', () => {
  const A = { key: 'claude:aaaa', display: 'ada@example.com', source: 'network' as const };
  const B = { key: 'claude:bbbb', display: 'bob@example.com', source: 'network' as const };
  const C = { key: 'claude:cccc', display: 'cy@example.com', source: 'network' as const };

  it('names an account only for a report that names someone and is taken into account', async () => {
    const { env, service } = setup();
    env.signIn('P');
    expect((await service.noteIdentity('claude', A))?.named).toBe(PRIMARY);
    expect((await service.noteIdentity('claude', null))?.named ?? null).toBeNull();
    // Right after a switch, a report about someone else is set aside and names nobody.
    await addAndUse(service);
    expect((await service.noteIdentity('claude', C))?.named ?? null).toBeNull();
  });

  it('records the first identity on the active account and names it', async () => {
    const { service } = setup();
    const outcome = await service.noteIdentity('claude', A);
    expect(outcome).toEqual({ realm: ANTHROPIC, activeAccountId: PRIMARY, reassigned: false, updated: true, named: PRIMARY });
    const primary = (await service.activeAccount(ANTHROPIC))!;
    expect(primary).toMatchObject({ label: 'ada@example.com', signedIn: 'yes' });
    expect(primary.identity).toMatchObject({ key: A.key, display: A.display, source: 'network' });
    expect(Object.keys(primary.identity!).sort()).toEqual(['detail', 'display', 'key', 'observedAt', 'source']);
  });

  it('refreshes the same identity and keeps a name the person chose', async () => {
    const { env, service } = setup();
    await service.list();
    ok(await service.update(PRIMARY, { label: 'Personal' }));
    await service.noteIdentity('claude', A);
    env.advance(1000);
    const outcome = await service.noteIdentity('claude_code', { ...A, detail: 'Max plan' });
    expect(outcome).toMatchObject({ activeAccountId: PRIMARY, reassigned: false, updated: true });
    const primary = (await service.activeAccount(ANTHROPIC))!;
    expect(primary.label).toBe('Personal');
    expect(primary.identity).toMatchObject({ detail: 'Max plan', observedAt: new Date(env.clock).toISOString() });
    expect(await service.noteIdentity('claude', A)).toMatchObject({ updated: false });
  });

  it('only stores identity fields', async () => {
    const { service } = setup();
    await service.noteIdentity('claude', { ...A, token: 'SECRET', email: 'x' } as never);
    const primary = (await service.activeAccount(ANTHROPIC))!;
    expect(JSON.stringify(primary)).not.toContain('SECRET');
    expect(await service.noteIdentity('claude', { key: '', display: null, source: 'network' })).toBeNull();
    expect(await service.noteIdentity('imported', A)).toBeNull();
  });

  it('a key owned by another account makes that account active', async () => {
    const { db, env, service } = setup();
    env.signIn('P');
    await service.noteIdentity('claude', A);
    const b = (await addAndUse(service)).account!.id;
    env.advance(SWITCH_SETTLE_MS + 1);
    // The person signed back in as A in the new, empty account.
    const outcome = await service.noteIdentity('claude', A);
    expect(outcome).toEqual({ realm: ANTHROPIC, activeAccountId: PRIMARY, reassigned: true, updated: true, named: PRIMARY });
    expect(await db.accountJars.get(PRIMARY)).toBeUndefined();
    const accounts = await db.accounts.where('realm').equals(ANTHROPIC).toArray();
    expect(accounts.find((a) => a.id === PRIMARY)).toMatchObject({ hasJar: false, signedIn: 'yes' });
    expect(accounts.find((a) => a.id === b)).toMatchObject({ hasJar: false, signedIn: 'unknown', identity: null });
    // Nothing of the account that was only ever empty was kept as a sign-in.
    expect(await db.accountJars.get(b)).toBeUndefined();
  });

  it('an unknown key while another person is active creates and activates a new account', async () => {
    const { db, service } = setup();
    await service.noteIdentity('claude', A);
    const outcome = (await service.noteIdentity('claude', C))!;
    expect(outcome.reassigned).toBe(true);
    expect(outcome.activeAccountId).not.toBe(PRIMARY);
    const created = (await db.accounts.get(outcome.activeAccountId!))!;
    expect(created).toMatchObject({ label: 'cy@example.com', mode: 'embedded', primary: false, signedIn: 'yes', hasJar: false });
    expect(created.identity?.key).toBe(C.key);
    expect(await db.accounts.get(PRIMARY)).toMatchObject({ signedIn: 'no' });
    expect((await service.activeAccount(ANTHROPIC))?.id).toBe(created.id);
  });

  it('a different known key while someone is active switches to its account and drops its stale jar', async () => {
    const { db, env, service } = setup();
    env.signIn('P');
    await service.noteIdentity('claude', A);
    const b = (await addAndUse(service)).account!.id;
    env.signIn('B');
    env.advance(SWITCH_SETTLE_MS + 1);
    await service.noteIdentity('claude', B);
    ok(await service.activate(PRIMARY));
    expect(await db.accountJars.get(b)).toBeDefined();
    env.advance(SWITCH_SETTLE_MS + 1);
    // In the main account the person signed out of A and into B by hand.
    const outcome = await service.noteIdentity('claude', B);
    expect(outcome).toMatchObject({ activeAccountId: b, reassigned: true });
    expect(await db.accountJars.get(b)).toBeUndefined();
    expect(await db.accounts.get(PRIMARY)).toMatchObject({ signedIn: 'no', hasJar: false });
  });

  it('a late answer from a page loaded before a switch is ignored', async () => {
    const { db, env, service } = setup();
    env.signIn('P');
    await service.noteIdentity('claude', A);
    const b = (await addAndUse(service)).account!.id;
    const outcome = await service.noteIdentity('claude', A);
    expect(outcome).toMatchObject({ activeAccountId: b, reassigned: false, updated: false });
    expect((await db.accounts.get(b))?.identity).toBeNull();
  });

  it('null marks the active account signed out once', async () => {
    const { service } = setup();
    await service.noteIdentity('claude', A);
    expect(await service.noteIdentity('claude', null)).toMatchObject({ updated: true, reassigned: false });
    expect((await service.activeAccount(ANTHROPIC))?.signedIn).toBe('no');
    expect(await service.noteIdentity('claude', null)).toMatchObject({ updated: false });
  });
});

describe('account service: captures', () => {
  const bound = { accountId: 'acct_claude_primary', workspaceId: 'ws_personal' };

  it('keeps the legacy bound id for the primary account and uses the account id otherwise', async () => {
    const { env, service } = setup();
    env.signIn('P');
    const first = await service.resolveForCapture('claude_code', bound);
    expect(first).toMatchObject({ accountId: 'acct_claude_primary', workspaceId: 'ws_personal' });
    expect(first.account?.id).toBe(PRIMARY);
    const b = (await addAndUse(service)).account!.id;
    const second = await service.resolveForCapture('claude', bound);
    expect(second).toMatchObject({ accountId: b, workspaceId: 'ws_personal' });
    expect(second.account?.id).toBe(b);
  });

  it('falls back to the bound id without a realm or on failure', async () => {
    const { db, service } = setup();
    expect(await service.resolveForCapture('imported', bound)).toEqual({ ...bound, account: null });
    expect(await service.resolveForCapture('gemini', bound)).toEqual({ ...bound, account: null });
    db.close();
    expect(await service.resolveForCapture('claude', bound)).toEqual({ ...bound, account: null });
  });
});

describe('account service: credentials stay out of listings', () => {
  it('never puts cookie values in list() output or the accounts table', async () => {
    const { db, env, service } = setup();
    env.signIn('P');
    const b = (await addAndUse(service)).account!.id;
    env.signIn('B');
    ok(await service.activate(PRIMARY));
    ok(await service.activate(b));
    const listed = JSON.stringify(await service.list());
    expect(listed).not.toContain('SECRET');
    expect(listed).not.toMatch(/"iv"|"data"|cookieCount/);
    expect(JSON.stringify(await db.accounts.toArray())).not.toContain('SECRET');
    for (const jar of await db.accountJars.toArray()) {
      expect(new TextDecoder('latin1').decode(new Uint8Array(jar.data))).not.toContain('SECRET');
    }
    const kv = await db.kv.toArray();
    expect(JSON.stringify(kv.map((row) => (row.key === 'accounts.jarKey' ? null : row)))).not.toContain('SECRET');
  });
});

describe('device cookies stay put across switches', () => {
  it('neither saves, clears nor restores the bot-check clearance', async () => {
    const { ThreadkeeperDB } = await import('../../src/core/db.js');
    const { createAccountService } = await import('../../src/core/accounts/service.js');
    const db = new ThreadkeeperDB(`AccountsDevice_${Math.random().toString(36).slice(2)}`);
    const cookie = (name: string, value: string) => ({
      name, value, domain: 'claude.ai', hostOnly: true, path: '/', secure: true, httpOnly: true,
      sameSite: 'lax' as const, session: false, expirationDate: 4102444800,
    });
    let jar = [cookie('sessionKey', 'first'), cookie('cf_clearance', 'device')];
    let n = 0;
    const svc = createAccountService(db, {
      getCookies: async (domain) => (domain === 'claude.ai' ? jar.map((c) => ({ ...c })) : []),
      setCookie: async (c) => { jar = [...jar.filter((x) => x.name !== c.name), { ...c } as typeof jar[number]]; return true; },
      removeCookie: async (c) => { jar = jar.filter((x) => x.name !== c.name); },
      hasHostAccess: async () => true,
      now: () => new Date('2026-11-10T12:00:00Z'),
      randomHex: (len) => (++n).toString(16).padStart(len, '0'),
    });
    await svc.list();
    const added = await svc.add({ realm: 'anthropic', mode: 'embedded' });
    expect(added.ok).toBe(true);
    if (!added.ok || !added.account) throw new Error('account was not added');
    expect((await svc.activate(added.account.id)).ok).toBe(true);
    // Signed out for the new account, but the device clearance is untouched.
    expect(jar.map((c) => `${c.name}=${c.value}`)).toEqual(['cf_clearance=device']);
    jar.push(cookie('sessionKey', 'second'));
    jar = jar.map((c) => (c.name === 'cf_clearance' ? { ...c, value: 'device-renewed' } : c));
    const back = await svc.activate('primary~anthropic');
    expect(back.ok).toBe(true);
    expect(jar.map((c) => `${c.name}=${c.value}`).sort()).toEqual(['cf_clearance=device-renewed', 'sessionKey=first']);
    db.close();
  });
});

describe('account service: profiles keep their own saved sign-in', () => {
  const login = (tag: string): StoredCookie[] => [
    { name: 'sessionKey', value: `SECRET-${tag}`, domain: '.claude.ai', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'lax', session: false, expirationDate: 1894429242 },
    { name: 'lastActiveOrg', value: `org-${tag}`, domain: 'claude.ai', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: true },
  ];
  const device: StoredCookie = { name: 'cf_clearance', value: 'device', domain: '.claude.ai', hostOnly: false, path: '/', secure: true, httpOnly: true, sameSite: 'no_restriction', session: false, expirationDate: 1894429242 };

  it('saves and reads a profile jar without touching the browser, and says whether it holds a sign-in', async () => {
    const { db, env, service } = setup();
    const p = env.signIn('P');
    const b = (await addAccount(service)).account!.id;
    expect(await service.readJar(b)).toBeNull();
    await service.writeJar(b, [...login('B'), device]);
    // The device's bot-check cookie belongs to the browser, never to an account.
    expect((await service.readJar(b))!.map((c) => c.name).sort()).toEqual(['lastActiveOrg', 'sessionKey']);
    expect(await service.account(b)).toMatchObject({ hasJar: true, signedIn: 'unknown' });
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    const stored = (await db.accountJars.get(b))!;
    expect(new TextDecoder('latin1').decode(new Uint8Array(stored.data))).not.toContain('SECRET');
    // Cookies without a sign-in among them are kept, and the account says it is not signed in.
    await service.writeJar(b, [login('B')[1]]);
    expect(await service.account(b)).toMatchObject({ hasJar: true, signedIn: 'no' });
    await service.writeJar(b, login('B'));
    expect(await service.account(b)).toMatchObject({ hasJar: true, signedIn: 'unknown' });
    await service.writeJar(b, []);
    expect(await service.readJar(b)).toBeNull();
    expect(await service.account(b)).toMatchObject({ hasJar: false, signedIn: 'no' });
  });

  it("never writes a jar for the browser's own account, an unknown account or a removed one", async () => {
    const { db, env, service } = setup();
    env.signIn('P');
    await service.list();
    await service.writeJar(PRIMARY, login('X'));
    expect(await db.accountJars.get(PRIMARY)).toBeUndefined();
    await service.writeJar('acct_missing', login('X'));
    const b = (await addAccount(service)).account!.id;
    ok(await service.remove(b));
    await service.writeJar(b, login('B'));
    expect(await db.accountJars.count()).toBe(0);
  });

  it('a profile made the browser account takes its saved sign-in along, and gets a fresh jar when it leaves', async () => {
    const { db, env, service } = setup();
    const p = env.signIn('P');
    const b = (await addAccount(service)).account!.id;
    await service.writeJar(b, login('B'));
    ok(await service.activate(b));
    expect(env.realmCookies().map((c) => c.value).sort()).toEqual(['SECRET-B', 'org-B']);
    expect(await db.accountJars.get(b)).toBeUndefined();
    expect((await db.accountJars.get(PRIMARY))?.cookieCount).toBe(4);
    ok(await service.activate(PRIMARY));
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    expect((await service.readJar(b))!.map((c) => c.value).sort()).toEqual(['SECRET-B', 'org-B']);
  });

  it("answers the browser's bot-check cookies for a realm and nothing else", async () => {
    const { env, service } = setup();
    env.signIn('P');
    env.cookies.push(device);
    expect((await service.deviceCookies(ANTHROPIC)).map((c) => c.name)).toEqual(['cf_clearance']);
    expect(await service.deviceCookies('nope')).toEqual([]);
  });

  it("keeps a copy of the browser account's sign-in, which survives the browser signing in as someone else", async () => {
    const { db, env, service } = setup();
    const A = { key: 'claude:aaaa', display: 'ada@example.com', source: 'network' as const };
    const C = { key: 'claude:cccc', display: 'cy@example.com', source: 'network' as const };
    env.signIn('P');
    await service.noteIdentity('claude', A);
    await service.snapshotBrowserAccount(ANTHROPIC);
    // Kept, but the account still reads as the one whose sign-in is the browser's own cookies.
    expect((await db.accountJars.get(PRIMARY))?.cookieCount).toBe(4);
    expect((await service.account(PRIMARY))?.hasJar).toBe(false);
    // A sign-in popup replaced the browser's cookies with another person's.
    env.signIn('C');
    env.advance(SWITCH_SETTLE_MS + 1);
    const outcome = (await service.noteIdentity('claude', C))!;
    expect(outcome.reassigned).toBe(true);
    expect(await service.account(PRIMARY)).toMatchObject({ hasJar: true });
    expect((await service.readJar(PRIMARY))!.some((c) => c.value === 'SECRET-P-key')).toBe(true);
  });

  it('does not keep a copy of a signed-out browser', async () => {
    const { db, service } = setup();
    await service.list();
    await service.snapshotBrowserAccount(ANTHROPIC);
    expect(await db.accountJars.count()).toBe(0);
    await service.snapshotBrowserAccount('google');
    expect(await db.accountJars.count()).toBe(0);
  });

  it('records who signed in inside a profile on that profile only', async () => {
    const { env, service } = setup();
    const A = { key: 'claude:aaaa', display: 'ada@example.com', source: 'network' as const };
    const B = { key: 'claude:bbbb', display: 'bob@example.com', source: 'network' as const };
    env.signIn('P');
    await service.noteIdentity('claude', A);
    const b = (await addAccount(service)).account!.id;
    expect(await service.noteProfileIdentity(b, B)).toEqual({ realm: ANTHROPIC, activeAccountId: b, reassigned: false, updated: true });
    expect(await service.account(b)).toMatchObject({ label: 'bob@example.com', signedIn: 'yes' });
    expect((await service.account(b))!.identity).toMatchObject({ key: B.key, display: B.display });
    // The browser's own account is still who it was.
    expect((await service.activeAccount(ANTHROPIC))?.id).toBe(PRIMARY);
    expect((await service.account(PRIMARY))!.identity?.key).toBe(A.key);
    expect(await service.noteProfileIdentity(b, B)).toMatchObject({ updated: false });
    // A profile is whoever signed in there, even the person the browser is signed in as.
    expect(await service.noteProfileIdentity(b, A)).toMatchObject({ updated: true, reassigned: false });
    expect((await service.activeAccount(ANTHROPIC))?.id).toBe(PRIMARY);
    expect(await service.noteProfileIdentity(b, null)).toMatchObject({ updated: true });
    expect((await service.account(b))?.signedIn).toBe('no');
    expect(await service.noteProfileIdentity('acct_missing', B)).toBeNull();
    expect(await service.noteProfileIdentity(b, { key: '', display: null, source: 'network' })).toBeNull();
  });

  it('keeps a name the person chose when the site names the profile', async () => {
    const { service } = setup();
    const b = (await addAccount(service, 'Admin')).account!.id;
    await service.noteProfileIdentity(b, { key: 'claude:bbbb', display: 'bob@example.com', source: 'network' });
    expect((await service.account(b))?.label).toBe('Admin');
  });
});

describe('account service: signing a profile in through the browser', () => {
  const B = { key: 'claude:bbbb', display: 'bob@example.com', source: 'network' as const };

  it('sets the browser sign-in aside, keeps what the person signs in to, and puts the browser back', async () => {
    const { db, env, service } = setup();
    const p = env.signIn('P');
    const b = (await addAccount(service, 'Work')).account!.id;
    const begun = ok(await service.beginBrowserSignIn(b));
    expect(begun.switched).toBe(true);
    expect(env.realmCookies()).toEqual([]);
    const during = begun.realms.find((r) => r.realm.id === ANTHROPIC)!;
    expect(during.activeAccountId).toBe(b);
    expect(during.pendingSignIn).toMatchObject({ realm: ANTHROPIC, accountId: b, returnToAccountId: PRIMARY });
    expect(await service.pendingSignIn()).toMatchObject({ accountId: b });
    expect((await db.accountJars.get(PRIMARY))?.cookieCount).toBe(4);

    const bCookies = env.signIn('B');
    env.advance(SWITCH_SETTLE_MS + 1);
    await service.noteIdentity('claude', B);
    const done = ok(await service.finishBrowserSignIn());
    expect(done.switched).toBe(true);
    expect(done.account).toMatchObject({ id: b, hasJar: true, signedIn: 'yes' });
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    const after = done.realms.find((r) => r.realm.id === ANTHROPIC)!;
    expect(after.activeAccountId).toBe(PRIMARY);
    expect(after.pendingSignIn).toBeNull();
    expect(await service.pendingSignIn()).toBeNull();
    expect(sorted((await service.readJar(b))!)).toEqual(sorted(bCookies));
    expect(await db.accountJars.get(PRIMARY)).toBeUndefined();
    expect(await service.finishBrowserSignIn()).toMatchObject({ ok: false, code: 'not_allowed' });
  });

  it('cancelling keeps nothing of what was in the browser meanwhile', async () => {
    const { env, service } = setup();
    const p = env.signIn('P');
    const b = (await addAccount(service)).account!.id;
    ok(await service.beginBrowserSignIn(b));
    env.signIn('B');
    const cancelled = ok(await service.cancelBrowserSignIn());
    expect(cancelled.account).toMatchObject({ id: b, hasJar: false, signedIn: 'no' });
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    expect(await service.readJar(b)).toBeNull();
    expect(await service.pendingSignIn()).toBeNull();
  });

  it('cancelling leaves the sign-in the account had saved as it was', async () => {
    const { env, service } = setup();
    const p = env.signIn('P');
    const b = (await addAccount(service)).account!.id;
    ok(await service.beginBrowserSignIn(b));
    const first = env.signIn('B');
    ok(await service.finishBrowserSignIn());
    // A second sign-in for the same account, given up after signing in as someone else.
    const begun = ok(await service.beginBrowserSignIn(b));
    expect(sorted(env.realmCookies())).toEqual(sorted(first));
    expect(begun.account).toMatchObject({ id: b, hasJar: true });
    env.signIn('X');
    const cancelled = ok(await service.cancelBrowserSignIn());
    expect(cancelled.account).toMatchObject({ id: b, hasJar: true });
    expect(sorted((await service.readJar(b))!)).toEqual(sorted(first));
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    // Finishing a later one replaces it.
    ok(await service.beginBrowserSignIn(b));
    const second = env.signIn('B2');
    ok(await service.finishBrowserSignIn());
    expect(sorted((await service.readJar(b))!)).toEqual(sorted(second));
  });

  it("a copy of the browser's sign-in taken during a sign-in does not replace the account's kept one", async () => {
    const { env, service } = setup();
    env.signIn('P');
    const b = (await addAccount(service)).account!.id;
    ok(await service.beginBrowserSignIn(b));
    const first = env.signIn('B');
    ok(await service.finishBrowserSignIn());
    ok(await service.beginBrowserSignIn(b));
    env.signIn('X');
    await service.snapshotBrowserAccount(ANTHROPIC);
    ok(await service.cancelBrowserSignIn());
    expect(sorted((await service.readJar(b))!)).toEqual(sorted(first));
  });

  it("a worker stopped while a sign-in starts keeps the account's saved sign-in", async () => {
    const db = freshDb();
    const env = new FakeEnv();
    const service = createAccountService(db, env);
    const p = env.signIn('P');
    const b = (await addAccount(service)).account!.id;
    ok(await service.beginBrowserSignIn(b));
    const first = env.signIn('B');
    ok(await service.finishBrowserSignIn());
    env.crash = true;
    expect((await service.beginBrowserSignIn(b)).ok).toBe(false);
    expect((await db.kv.get(KV_KEYS.switchJournal))?.value).toMatchObject({ toAccountId: b, keepTargetJar: true });
    env.crash = false;
    const restarted = createAccountService(db, env);
    await restarted.recover();
    expect(await db.kv.get(KV_KEYS.switchJournal)).toBeUndefined();
    expect(sorted(env.realmCookies())).toEqual(sorted(first));
    expect(await db.accountJars.get(b)).toBeDefined();
    ok(await restarted.cancelBrowserSignIn());
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    expect(sorted((await restarted.readJar(b))!)).toEqual(sorted(first));
  });

  it('finishing without having signed in keeps the account signed out', async () => {
    const { env, service } = setup();
    const p = env.signIn('P');
    const b = (await addAccount(service)).account!.id;
    ok(await service.beginBrowserSignIn(b));
    const done = ok(await service.finishBrowserSignIn());
    expect(done.account).toMatchObject({ id: b, hasJar: false, signedIn: 'no' });
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
  });

  it('allows one sign-in at a time and nothing that would move cookies under it', async () => {
    const { service, env } = setup();
    env.signIn('P');
    const b = (await addAccount(service)).account!.id;
    const c = (await addAccount(service)).account!.id;
    ok(await service.beginBrowserSignIn(b));
    expect(await service.beginBrowserSignIn(c)).toMatchObject({ ok: false, code: 'signin_pending' });
    expect(await service.activate(c)).toMatchObject({ ok: false, code: 'signin_pending' });
    expect(await service.activate(PRIMARY)).toMatchObject({ ok: false, code: 'signin_pending' });
    expect(await service.remove(b)).toMatchObject({ ok: false, code: 'signin_pending' });
    ok(await service.cancelBrowserSignIn());
    expect((await service.activate(c)).ok).toBe(true);
  });

  it("refuses the browser's own account, an unknown account and a sign-in it keeps no accounts for", async () => {
    const { env, service } = setup();
    env.signIn('P');
    await service.list();
    expect(await service.beginBrowserSignIn(PRIMARY)).toMatchObject({ ok: false, code: 'browser_account' });
    expect(await service.beginBrowserSignIn('acct_missing')).toMatchObject({ ok: false, code: 'unknown_account' });
    expect(await service.pendingSignIn()).toBeNull();
    env.denied.add('https://claude.ai/*');
    const b = (await addAccountDenied(service, env)).account!.id;
    expect(await service.beginBrowserSignIn(b)).toMatchObject({ ok: false, code: 'needs_host_access' });
    expect(await service.pendingSignIn()).toBeNull();
  });

  it('a sign-in the worker was stopped in is still pending, and can be ended, after a restart', async () => {
    const db = freshDb();
    const env = new FakeEnv();
    const service = createAccountService(db, env);
    const p = env.signIn('P');
    const b = (await addAccount(service)).account!.id;
    ok(await service.beginBrowserSignIn(b));
    const bCookies = env.signIn('B');
    const restarted = createAccountService(db, env);
    await restarted.recover();
    expect(await restarted.pendingSignIn()).toMatchObject({ accountId: b, returnToAccountId: PRIMARY });
    ok(await restarted.finishBrowserSignIn());
    expect(sorted(env.realmCookies())).toEqual(sorted(p));
    expect(sorted((await restarted.readJar(b))!)).toEqual(sorted(bCookies));
  });

  it('when the person signs in as an account that already exists, that account keeps the sign-in', async () => {
    const { env, service } = setup();
    env.signIn('P');
    const b = (await addAccount(service, 'Work')).account!.id;
    await service.noteProfileIdentity(b, B);
    const c = (await addAccount(service, 'Spare')).account!.id;
    ok(await service.beginBrowserSignIn(c));
    // Signed in as Work's person instead of a new one.
    const bCookies = env.signIn('B');
    env.advance(SWITCH_SETTLE_MS + 1);
    expect(await service.noteIdentity('claude', B)).toMatchObject({ activeAccountId: b, reassigned: true });
    ok(await service.finishBrowserSignIn());
    expect((await service.activeAccount(ANTHROPIC))?.id).toBe(PRIMARY);
    expect(sorted((await service.readJar(b))!)).toEqual(sorted(bCookies));
    expect(await service.account(c)).toMatchObject({ hasJar: false });
  });
});

/** Add an account while host access is denied for claude.ai: lift the denial only for the add. */
async function addAccountDenied(service: AccountService, env: FakeEnv) {
  const denied = new Set(env.denied);
  env.denied.clear();
  const added = await addAccount(service);
  for (const pattern of denied) env.denied.add(pattern);
  return added;
}
