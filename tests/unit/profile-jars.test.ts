import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JAR_SAVE_DELAY_MS, ProfileJars, type ProfileJarsDeps } from '../../src/core/accounts/profile-jars.js';
import type { StoredCookie } from '../../src/core/workspace/types.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const HOME = 'https://claude.ai/';
const SIGN_IN = 'sessionKey=sk-1; Path=/; Secure; HttpOnly';

function cookie(over: Partial<StoredCookie>): StoredCookie {
  return {
    name: 'c',
    value: '1',
    domain: 'claude.ai',
    hostOnly: true,
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'unspecified',
    session: true,
    ...over,
  };
}

let saved: Record<string, StoredCookie[]>;
let writes: Array<{ accountId: string; cookies: StoredCookie[] }>;
let reads: string[];
let signedInChanges: Array<[string, boolean]>;
let failWrites: boolean;

function make(extra: Partial<ProfileJarsDeps> = {}) {
  const deps: ProfileJarsDeps = {
    read: async (id) => {
      reads.push(id);
      return saved[id] ?? null;
    },
    write: async (id, cookies) => {
      if (failWrites) throw new Error('disk');
      writes.push({ accountId: id, cookies });
      saved[id] = cookies;
    },
    now: () => NOW,
    schedule: (fn, ms) => {
      const t = setTimeout(fn, ms);
      return () => clearTimeout(t);
    },
    onSignedInChange: (id, signedIn) => void signedInChanges.push([id, signedIn]),
    ...extra,
  };
  return new ProfileJars(deps);
}

const names = (cookies: StoredCookie[]) => cookies.map((c) => c.name).sort();

beforeEach(() => {
  vi.useFakeTimers();
  saved = {};
  writes = [];
  reads = [];
  signedInChanges = [];
  failWrites = false;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('loading a jar', () => {
  it('starts from the saved cookies, without expired ones and without the device bot-check', async () => {
    saved.a = [
      cookie({ name: 'keep', value: 'k' }),
      cookie({ name: 'old', session: false, expirationDate: NOW / 1000 - 10 }),
      cookie({ name: 'cf_clearance', httpOnly: true }),
    ];
    const jars = make();
    expect(names(await jars.cookies('a'))).toEqual(['keep']);
  });

  it('is empty for an account with nothing saved or whose read fails', async () => {
    const jars = make({ read: async () => Promise.reject(new Error('locked')) });
    expect(await jars.cookies('a')).toEqual([]);
  });

  it('reads the saved jar once and answers copies', async () => {
    saved.a = [cookie({ name: 'keep' })];
    const jars = make();
    const first = await jars.cookies('a');
    first.length = 0;
    expect(names(await jars.cookies('a'))).toEqual(['keep']);
    expect(reads).toEqual(['a']);
  });
});

describe('following responses', () => {
  it('adds cookies from a response and reports a change', async () => {
    const jars = make();
    expect(await jars.applyResponse('a', [SIGN_IN], HOME)).toBe(true);
    expect(names(await jars.cookies('a'))).toEqual(['sessionKey']);
  });

  it('reports no change for a response that sets nothing usable', async () => {
    const jars = make();
    expect(await jars.applyResponse('a', ['=nonsense'], HOME)).toBe(false);
    expect(await jars.applyResponse('a', [], HOME)).toBe(false);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS * 2);
    expect(writes).toEqual([]);
  });

  it('keeps accounts apart', async () => {
    const jars = make();
    await jars.applyResponse('a', [SIGN_IN], HOME);
    expect(await jars.cookies('b')).toEqual([]);
    await jars.applyResponse('b', ['other=2; Path=/'], HOME);
    expect(names(await jars.cookies('a'))).toEqual(['sessionKey']);
    expect(names(await jars.cookies('b'))).toEqual(['other']);
  });

  it('never keeps the device bot-check in an account\'s jar or saves it', async () => {
    const jars = make();
    await jars.applyResponse('a', ['cf_clearance=zzz; Path=/; HttpOnly', 'plain=1; Path=/'], HOME);
    expect(names(await jars.cookies('a'))).toEqual(['plain']);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(names(writes[0].cookies)).toEqual(['plain']);
  });
});

describe('document.cookie in a profile page', () => {
  it('shows script-written cookies back to scripts of the same address', async () => {
    const jars = make();
    expect(await jars.applyScript('a', 'theme=dark; path=/', HOME)).toEqual({ ok: true });
    expect(await jars.scriptCookieString('a', 'https://claude.ai/chat')).toBe('theme=dark');
    expect(await jars.scriptCookieString('b', 'https://claude.ai/chat')).toBe('');
  });

  it('hides HttpOnly cookies from scripts', async () => {
    const jars = make();
    await jars.applyResponse('a', [SIGN_IN, 'seen=1; Path=/'], HOME);
    expect(await jars.scriptCookieString('a', HOME)).toBe('seen=1');
  });

  it('rejects an assignment a page may not make', async () => {
    const jars = make();
    const result = await jars.applyScript('a', 'x=1; domain=evil.com', HOME);
    expect(result.ok).toBe(false);
    expect(await jars.cookies('a')).toEqual([]);
  });
});

describe('saving', () => {
  it('waits JAR_SAVE_DELAY_MS and saves several changes in the window once', async () => {
    const jars = make();
    await jars.applyResponse('a', ['one=1; Path=/'], HOME);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS - 1);
    expect(writes).toEqual([]);
    await jars.applyResponse('a', ['two=2; Path=/'], HOME);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].accountId).toBe('a');
    expect(names(writes[0].cookies)).toEqual(['one', 'two']);
  });

  it('saves each account on its own', async () => {
    const jars = make();
    await jars.applyResponse('a', ['one=1; Path=/'], HOME);
    await jars.applyResponse('b', ['two=2; Path=/'], HOME);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(writes.map((w) => w.accountId).sort()).toEqual(['a', 'b']);
    expect(names(saved.a)).toEqual(['one']);
    expect(names(saved.b)).toEqual(['two']);
  });

  it('does not save cookies that expired before the save', async () => {
    let clock = NOW;
    const jars = make({ now: () => clock });
    await jars.applyResponse('a', ['gone=1; Path=/; Max-Age=1', 'stay=1; Path=/'], HOME);
    clock += 5_000;
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(names(writes[0].cookies)).toEqual(['stay']);
  });

  it('flush saves what is waiting now and cancels the timer', async () => {
    const jars = make();
    await jars.applyResponse('a', ['one=1; Path=/'], HOME);
    await jars.flush('a');
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS * 2);
    expect(writes).toHaveLength(1);
  });

  it('flush without an account saves all waiting accounts, and does nothing when nothing waits', async () => {
    const jars = make();
    await jars.flush();
    expect(writes).toEqual([]);
    await jars.applyResponse('a', ['one=1; Path=/'], HOME);
    await jars.applyResponse('b', ['two=2; Path=/'], HOME);
    await jars.flush();
    expect(writes.map((w) => w.accountId).sort()).toEqual(['a', 'b']);
    await jars.flush();
    expect(writes).toHaveLength(2);
  });

  it('survives a failed write and saves again on the next change', async () => {
    const jars = make();
    failWrites = true;
    await jars.applyResponse('a', ['one=1; Path=/'], HOME);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(writes).toEqual([]);
    failWrites = false;
    await jars.applyResponse('a', ['two=2; Path=/'], HOME);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(names(writes[0].cookies)).toEqual(['one', 'two']);
  });
});

describe('noticing a sign-in', () => {
  it('tells when the saved jar starts to look signed in, once', async () => {
    const jars = make();
    await jars.applyResponse('a', [SIGN_IN], HOME);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(signedInChanges).toEqual([['a', true]]);
    await jars.applyResponse('a', ['more=1; Path=/'], HOME);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(signedInChanges).toEqual([['a', true]]);
  });

  it('tells when the sign-in is gone', async () => {
    saved.a = [cookie({ name: 'sessionKey', httpOnly: true })];
    const jars = make();
    await jars.applyResponse('a', ['sessionKey=; Path=/; Max-Age=0'], HOME);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(signedInChanges).toEqual([['a', false]]);
  });

  it('says nothing when a jar that already looked signed in stays so', async () => {
    saved.a = [cookie({ name: 'sessionKey', httpOnly: true })];
    const jars = make();
    await jars.applyResponse('a', ['x=1; Path=/'], HOME);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(signedInChanges).toEqual([]);
  });

  it('does not count the device bot-check as a sign-in', async () => {
    const jars = make();
    await jars.applyResponse('a', ['cf_clearance=1; Path=/; HttpOnly'], HOME);
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(signedInChanges).toEqual([]);
  });
});

describe('forgetting', () => {
  it('drops the live copy and its pending save without writing', async () => {
    const jars = make();
    await jars.applyResponse('a', [SIGN_IN], HOME);
    jars.forget('a');
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS * 2);
    expect(writes).toEqual([]);
    expect(signedInChanges).toEqual([]);
  });

  it('reads the replaced saved jar the next time', async () => {
    const jars = make();
    await jars.applyResponse('a', ['stale=1; Path=/'], HOME);
    jars.forget('a');
    saved.a = [cookie({ name: 'fresh' })];
    expect(names(await jars.cookies('a'))).toEqual(['fresh']);
  });

  it('leaves other accounts alone', async () => {
    const jars = make();
    await jars.applyResponse('a', ['one=1; Path=/'], HOME);
    await jars.applyResponse('b', ['two=2; Path=/'], HOME);
    jars.forget('a');
    await vi.advanceTimersByTimeAsync(JAR_SAVE_DELAY_MS);
    expect(writes.map((w) => w.accountId)).toEqual(['b']);
    expect(names(await jars.cookies('b'))).toEqual(['two']);
  });

  it('is harmless for an account never opened', () => {
    expect(() => make().forget('nobody')).not.toThrow();
  });
});
