import { describe, expect, it } from 'vitest';
import {
  MAX_COOKIE_AGE_SECONDS,
  MAX_JAR_COOKIES,
  applyScriptCookie,
  applySetCookies,
  cookiePairBytes,
  cookiesForUrl,
  looksSignedIn,
  parseSetCookie,
  pruneExpired,
  serializeSetCookie,
} from '../../src/core/accounts/set-cookie.js';
import { isDeviceCookie } from '../../src/core/accounts/cookies.js';
import type { StoredCookie } from '../../src/core/workspace/types.js';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const URL_HOME = 'https://claude.ai/code';

function set(header: string, url = URL_HOME) {
  const outcome = parseSetCookie(header, url, NOW);
  if (outcome.kind !== 'set') throw new Error(`expected a cookie, got ${outcome.kind}`);
  return outcome.cookie;
}

describe('parseSetCookie', () => {
  it('reads a host-only session cookie with the default path', () => {
    expect(set('a=1', 'https://claude.ai/api/account')).toEqual({
      name: 'a',
      value: '1',
      domain: 'claude.ai',
      hostOnly: true,
      path: '/api',
      secure: false,
      httpOnly: false,
      sameSite: 'unspecified',
      session: true,
    });
  });

  it('reads every attribute of a sign-in cookie', () => {
    const cookie = set('sessionKey=sk-1; Domain=.claude.ai; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Lax');
    expect(cookie).toMatchObject({
      name: 'sessionKey',
      value: 'sk-1',
      domain: '.claude.ai',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: false,
      expirationDate: Math.floor(NOW / 1000) + 3600,
    });
  });

  it('prefers Max-Age over Expires and caps how long a cookie may live', () => {
    const cookie = set('a=1; Expires=Wed, 01 Jan 2020 00:00:00 GMT; Max-Age=999999999');
    expect(cookie.expirationDate).toBe(Math.floor(NOW / 1000) + MAX_COOKIE_AGE_SECONDS);
    expect(set('b=1; Expires=Fri, 13 Nov 2026 13:00:00 GMT').expirationDate).toBe(Math.floor(NOW / 1000) + 3600);
  });

  it('turns an expiry in the past into a removal of that slot', () => {
    expect(parseSetCookie('a=; Max-Age=0; Path=/', URL_HOME, NOW)).toEqual({
      kind: 'remove',
      cookie: { name: 'a', domain: 'claude.ai', path: '/', hostOnly: true },
    });
    expect(parseSetCookie('a=gone; Domain=claude.ai; Path=/x; Expires=Thu, 01 Jan 1970 00:00:00 GMT', URL_HOME, NOW)).toEqual({
      kind: 'remove',
      cookie: { name: 'a', domain: '.claude.ai', path: '/x', hostOnly: false },
    });
  });

  it('keeps the Partitioned attribute and SameSite=None only with Secure', () => {
    expect(set('p=1; Secure; SameSite=None; Partitioned')).toMatchObject({ sameSite: 'no_restriction', partitioned: true });
    expect(parseSetCookie('p=1; SameSite=None', URL_HOME, NOW).kind).toBe('ignore');
    expect(parseSetCookie('p=1; Partitioned', URL_HOME, NOW).kind).toBe('ignore');
  });

  it.each([
    ['a Domain the host does not belong to', 'a=1; Domain=example.com'],
    ['a Domain that is a bare label', 'a=1; Domain=ai'],
    ['a __Host- cookie with a Domain', '__Host-a=1; Secure; Path=/; Domain=claude.ai'],
    ['a __Host- cookie off the root path', '__Host-a=1; Secure; Path=/code'],
    ['a __Secure- cookie without Secure', '__Secure-a=1; Path=/'],
    ['a cookie without a name', 'justavalue'],
    ['a name with a space', 'bad name=1'],
    ['a value over the size limit', `a=${'x'.repeat(4100)}`],
    ['a header with a line break', 'a=1\r\nSet-Cookie: b=2'],
  ])('ignores %s', (_label, header) => {
    expect(parseSetCookie(header, URL_HOME, NOW).kind).toBe('ignore');
  });

  it('ignores a Secure cookie from a plain http page, except on this computer', () => {
    expect(parseSetCookie('a=1; Secure', 'http://example.com/', NOW).kind).toBe('ignore');
    expect(parseSetCookie('a=1; Secure', 'http://localhost:3000/', NOW).kind).toBe('set');
  });

  it('accepts a Domain that is the host itself or a parent of it', () => {
    expect(set('a=1; Domain=claude.ai', 'https://a.claude.ai/x').domain).toBe('.claude.ai');
    expect(set('a=1; Domain=a.claude.ai', 'https://a.claude.ai/x')).toMatchObject({ domain: '.a.claude.ai', hostOnly: false });
  });

  it('ignores anything that is not an http or https address', () => {
    expect(parseSetCookie('a=1', 'chrome-extension://abc/page.html', NOW).kind).toBe('ignore');
    expect(parseSetCookie('a=1', 'not a url', NOW).kind).toBe('ignore');
  });
});

describe('applySetCookies', () => {
  it('adds, replaces and removes by name, domain and path', () => {
    let jar: StoredCookie[] = [];
    jar = applySetCookies(jar, ['sessionKey=one; Path=/; Secure; HttpOnly', 'org=a; Path=/; Secure'], URL_HOME, NOW);
    expect(jar.map((c) => `${c.name}=${c.value}`)).toEqual(['sessionKey=one', 'org=a']);
    jar = applySetCookies(jar, ['sessionKey=two; Path=/; Secure; HttpOnly'], URL_HOME, NOW);
    expect(jar.map((c) => `${c.name}=${c.value}`)).toEqual(['sessionKey=two', 'org=a']);
    jar = applySetCookies(jar, ['org=; Path=/; Max-Age=0'], URL_HOME, NOW);
    expect(jar.map((c) => c.name)).toEqual(['sessionKey']);
  });

  it('keeps a host-only cookie and a domain cookie of the same name apart', () => {
    const jar = applySetCookies([], ['a=host; Path=/', 'a=wide; Path=/; Domain=claude.ai'], URL_HOME, NOW);
    expect(jar.map((c) => [c.domain, c.value])).toEqual([
      ['claude.ai', 'host'],
      ['.claude.ai', 'wide'],
    ]);
    const after = applySetCookies(jar, ['a=; Path=/; Max-Age=0'], URL_HOME, NOW);
    expect(after.map((c) => c.value)).toEqual(['wide']);
  });

  it('returns the same array when nothing changed, so nothing is saved for nothing', () => {
    const jar = applySetCookies([], ['a=1; Path=/'], URL_HOME, NOW);
    expect(applySetCookies(jar, ['a=1; Path=/'], URL_HOME, NOW)).toBe(jar);
    expect(applySetCookies(jar, ['broken'], URL_HOME, NOW)).toBe(jar);
    expect(applySetCookies(jar, ['missing=; Path=/; Max-Age=0'], URL_HOME, NOW)).toBe(jar);
  });

  it('bounds the jar, dropping the oldest cookies first', () => {
    const headers = Array.from({ length: MAX_JAR_COOKIES + 5 }, (_, i) => `c${i}=1; Path=/`);
    const jar = applySetCookies([], headers, URL_HOME, NOW);
    expect(jar).toHaveLength(MAX_JAR_COOKIES);
    expect(jar[0].name).toBe('c5');
  });
});

describe('applyScriptCookie', () => {
  const base = applySetCookies([], ['sessionKey=secret; Path=/; Secure; HttpOnly', 'org=a; Path=/; Secure'], URL_HOME, NOW);

  it('stores what a page script assigns, never as HttpOnly', () => {
    const result = applyScriptCookie(base, 'theme=dark; Path=/; Max-Age=60', URL_HOME, NOW);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.jar.find((c) => c.name === 'theme')).toMatchObject({ value: 'dark', httpOnly: false, domain: 'claude.ai', hostOnly: true });
  });

  it('refuses to replace or delete a cookie scripts cannot read', () => {
    expect(applyScriptCookie(base, 'sessionKey=stolen; Path=/', URL_HOME, NOW)).toEqual({ ok: false, error: 'The page cannot replace that cookie.' });
    expect(applyScriptCookie(base, 'sessionKey=; Path=/; Max-Age=0', URL_HOME, NOW).ok).toBe(false);
  });

  it('deletes a script-visible cookie through an expiry in the past', () => {
    const result = applyScriptCookie(base, 'org=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', URL_HOME, NOW);
    expect(result.ok && result.jar.map((c) => c.name)).toEqual(['sessionKey']);
  });

  it('refuses a Domain the page does not belong to', () => {
    expect(applyScriptCookie(base, 'a=1; Domain=example.com', URL_HOME, NOW).ok).toBe(false);
  });

  it('returns the same jar when the assignment changes nothing', () => {
    const result = applyScriptCookie(base, 'org=a; Path=/; Secure', URL_HOME, NOW);
    expect(result.ok && result.jar).toBe(base);
  });
});

describe('cookiesForUrl', () => {
  const jar = applySetCookies(
    [],
    [
      'root=1; Path=/',
      'api=1; Path=/api; HttpOnly',
      'wide=1; Path=/; Domain=claude.ai',
      'secure=1; Path=/; Secure',
      'old=1; Path=/; Max-Age=10',
    ],
    'https://claude.ai/',
    NOW
  );

  it('matches by host, path and scheme, longest path first', () => {
    expect(cookiesForUrl(jar, 'https://claude.ai/api/account', NOW).map((c) => c.name)).toEqual(['api', 'root', 'wide', 'secure', 'old']);
    expect(cookiesForUrl(jar, 'https://claude.ai/apix', NOW).map((c) => c.name)).not.toContain('api');
  });

  it('gives a subdomain only the cookies with a Domain', () => {
    expect(cookiesForUrl(jar, 'https://a.claude.ai/', NOW).map((c) => c.name)).toEqual(['wide']);
  });

  it('leaves out expired cookies and, for scripts, HttpOnly ones', () => {
    expect(cookiesForUrl(jar, 'https://claude.ai/api/x', NOW + 11_000).map((c) => c.name)).not.toContain('old');
    expect(cookiesForUrl(jar, 'https://claude.ai/api/x', NOW, { script: true }).map((c) => c.name)).not.toContain('api');
  });

  it('answers nothing for an address it cannot read', () => {
    expect(cookiesForUrl(jar, 'nonsense', NOW)).toEqual([]);
  });

  it('pruneExpired drops what has run out and keeps the array otherwise', () => {
    expect(pruneExpired(jar, NOW)).toBe(jar);
    expect(pruneExpired(jar, NOW + 11_000).map((c) => c.name)).not.toContain('old');
  });
});

describe('serializeSetCookie', () => {
  it('writes a cookie back so that reading it again gives the same cookie', () => {
    const headers = [
      'sessionKey=sk-1; Path=/; Domain=claude.ai; Max-Age=3600; Secure; HttpOnly; SameSite=Lax',
      '__Host-csrf=abc; Path=/; Secure; HttpOnly; SameSite=Strict',
      'pref=1; Path=/settings',
      'none=1; Path=/; Secure; SameSite=None; Partitioned',
    ];
    const jar = applySetCookies([], headers, URL_HOME, NOW);
    const written = jar.map((c) => serializeSetCookie(c, NOW));
    expect(written.every((w) => typeof w === 'string')).toBe(true);
    const again = applySetCookies([], written as string[], URL_HOME, NOW);
    expect(again).toEqual(jar);
  });

  it('writes a cookie read from the browser with its partition as Partitioned', () => {
    const cookie: StoredCookie = {
      name: 'cf',
      value: 'x',
      domain: '.claude.ai',
      hostOnly: false,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'no_restriction',
      session: true,
      partitionKey: { topLevelSite: 'https://claude.ai' },
    };
    expect(serializeSetCookie(cookie, NOW)).toBe('cf=x; Path=/; Domain=claude.ai; Secure; HttpOnly; SameSite=None; Partitioned');
  });

  it('refuses an expired cookie and one that could not travel in a header', () => {
    const base: StoredCookie = { name: 'a', value: '1', domain: 'claude.ai', hostOnly: true, path: '/', secure: true, httpOnly: false, sameSite: 'lax', session: false, expirationDate: 1 };
    expect(serializeSetCookie(base, NOW)).toBeNull();
    expect(serializeSetCookie({ ...base, session: true, expirationDate: undefined, value: 'a;b' }, NOW)).toBeNull();
    expect(serializeSetCookie({ ...base, session: true, expirationDate: undefined, name: 'bad name' }, NOW)).toBeNull();
    expect(serializeSetCookie({ ...base, session: true, expirationDate: undefined, path: 'nopath' }, NOW)).toBeNull();
  });
});

describe('sizes and sign-in', () => {
  it('counts name and value bytes', () => {
    expect(cookiePairBytes({ name: 'ab', value: 'cdé' })).toBe(6);
  });

  it('calls a jar signed in only when it holds a live HttpOnly cookie that is not a bot check', () => {
    const device = applySetCookies([], ['cf_clearance=x; Path=/; Secure; HttpOnly; SameSite=None'], URL_HOME, NOW);
    expect(looksSignedIn(device, NOW, isDeviceCookie)).toBe(false);
    const login = applySetCookies(device, ['sessionKey=sk; Path=/; Secure; HttpOnly; Max-Age=60'], URL_HOME, NOW);
    expect(looksSignedIn(login, NOW, isDeviceCookie)).toBe(true);
    expect(looksSignedIn(login, NOW + 61_000, isDeviceCookie)).toBe(false);
    expect(looksSignedIn(applySetCookies([], ['pref=1; Path=/'], URL_HOME, NOW), NOW, isDeviceCookie)).toBe(false);
  });
});
