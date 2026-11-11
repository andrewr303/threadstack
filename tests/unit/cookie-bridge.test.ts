import { describe, expect, it, vi } from 'vitest';
import {
  MAX_COOKIE_ASSIGNMENT_BYTES,
  bridgeGetCookies,
  bridgeSetCookie,
  defaultCookiePath,
  documentCookieString,
  parseCookieAssignment,
  planCookieAssignment,
  type BridgeCookie,
  type CookiesApi,
} from '../../src/core/embed/cookie-bridge.js';

const NOW = Date.parse('2026-11-10T12:00:00Z');
const FRAME = 'https://app.example.com/workspace/chat/1';

function cookie(fields: Partial<BridgeCookie> & { name: string }): BridgeCookie {
  return {
    value: 'v',
    domain: 'app.example.com',
    hostOnly: true,
    path: '/',
    secure: true,
    httpOnly: false,
    sameSite: 'lax',
    session: true,
    ...fields,
  };
}

const plan = (text: unknown, existing: BridgeCookie[] = [], frameUrl = FRAME) => planCookieAssignment({ text, frameUrl, existing, nowMs: NOW });

describe('reading cookies for document.cookie', () => {
  it('lists script-visible cookies, longest path first, without HttpOnly ones', () => {
    const list = [
      cookie({ name: 'a', value: '1', path: '/' }),
      cookie({ name: 'session', value: 'secret', httpOnly: true }),
      cookie({ name: 'b', value: '2', path: '/workspace' }),
      cookie({ name: 'c', value: '3', path: '/' }),
      cookie({ name: 'strict', value: '4', sameSite: 'strict' }),
    ];
    expect(documentCookieString(list)).toBe('b=2; a=1; c=3; strict=4');
    expect(documentCookieString([])).toBe('');
  });

  it('answers through chrome.cookies with the frame address', async () => {
    const getAll = vi.fn(async () => [cookie({ name: 'csrf', value: 't0k' }), cookie({ name: 'sid', value: 'x', httpOnly: true })]);
    const api = { getAll, set: vi.fn(), remove: vi.fn() } as unknown as CookiesApi;
    expect(await bridgeGetCookies(api, FRAME)).toEqual({ ok: true, cookie: 'csrf=t0k' });
    expect(getAll).toHaveBeenCalledWith({ url: FRAME });
    expect(await bridgeGetCookies(null, FRAME)).toMatchObject({ ok: false });
  });
});

describe('parsing one document.cookie assignment', () => {
  it('reads the attributes a script may set', () => {
    expect(parseCookieAssignment('theme=dark; Path=/a; Domain=.Example.com; Max-Age=60; Secure; SameSite=Strict; HttpOnly')).toEqual({
      name: 'theme',
      value: 'dark',
      domain: 'example.com',
      path: '/a',
      maxAge: 60,
      expires: null,
      secure: true,
      sameSite: 'strict',
    });
    expect(parseCookieAssignment('x=1; expires=Wed, 11 Nov 2026 12:00:00 GMT; samesite=none')).toMatchObject({ expires: Date.parse('2026-11-11T12:00:00Z'), sameSite: 'no_restriction' });
    expect(parseCookieAssignment('x=1; Path=relative; Max-Age=soon; SameSite=bogus')).toMatchObject({ path: null, maxAge: null, sameSite: 'unspecified' });
    expect(parseCookieAssignment(' x = a=b ')).toMatchObject({ name: 'x', value: 'a=b' });
  });

  it('refuses nameless and malformed cookies', () => {
    expect(parseCookieAssignment('justavalue')).toHaveProperty('error');
    expect(parseCookieAssignment('=v')).toHaveProperty('error');
    expect(parseCookieAssignment('bad name=v')).toHaveProperty('error');
    expect(parseCookieAssignment('x=a\u0001b')).toHaveProperty('error');
  });

  it('computes the default path like a browser', () => {
    expect(defaultCookiePath('/workspace/chat/1')).toBe('/workspace/chat');
    expect(defaultCookiePath('/chat')).toBe('/');
    expect(defaultCookiePath('/')).toBe('/');
    expect(defaultCookiePath('')).toBe('/');
  });
});

describe('deciding an assignment', () => {
  it('sets a host-only session cookie on the frame host with the default path', () => {
    expect(plan('csrf=abc')).toEqual({
      ok: true,
      action: 'set',
      details: { url: 'https://app.example.com/workspace/chat', name: 'csrf', value: 'abc', path: '/workspace/chat', secure: false, httpOnly: false },
    });
  });

  it('sets a domain cookie with expiry and SameSite', () => {
    expect(plan('pref=1; Domain=example.com; Path=/; Max-Age=3600; Secure; SameSite=Lax')).toEqual({
      ok: true,
      action: 'set',
      details: {
        url: 'https://app.example.com/',
        name: 'pref',
        value: '1',
        path: '/',
        secure: true,
        httpOnly: false,
        domain: 'example.com',
        sameSite: 'lax',
        expirationDate: Math.floor(NOW / 1000) + 3600,
      },
    });
    expect(plan('pref=1; Path=/; Expires=Wed, 11 Nov 2026 12:00:00 GMT')).toMatchObject({ ok: true, details: { expirationDate: Date.parse('2026-11-11T12:00:00Z') / 1000 } });
  });

  it('refuses an assignment over 4096 bytes', () => {
    expect(plan(`big=${'x'.repeat(MAX_COOKIE_ASSIGNMENT_BYTES)}`)).toEqual({ ok: false, error: 'The cookie is too large.' });
    // Bytes, not characters.
    expect(plan(`big=${'é'.repeat(2047)}`)).toMatchObject({ ok: false });
    expect(plan('')).toMatchObject({ ok: false });
    expect(plan(42)).toMatchObject({ ok: false });
  });

  it('refuses a Domain that is not the frame host or a parent of it', () => {
    expect(plan('x=1; Domain=evil.com')).toMatchObject({ ok: false, error: expect.stringMatching(/domain/) });
    expect(plan('x=1; Domain=other.example.com')).toMatchObject({ ok: false });
    expect(plan('x=1; Domain=ample.com')).toMatchObject({ ok: false });
    expect(plan('x=1; Domain=com')).toMatchObject({ ok: false });
    expect(plan('x=1; Domain=app.example.com')).toMatchObject({ ok: true, details: { domain: 'app.example.com' } });
    // Address hosts take only their own address, which means host-only.
    expect(plan('x=1; Domain=127.0.0.1', [], 'http://127.0.0.1:3000/')).toMatchObject({ ok: true, details: { url: 'http://127.0.0.1:3000/' } });
    expect((plan('x=1; Domain=127.0.0.1', [], 'http://127.0.0.1:3000/') as { details: object }).details).not.toHaveProperty('domain');
    expect(plan('x=1; Domain=0.0.1', [], 'http://127.0.0.1:3000/')).toMatchObject({ ok: false });
  });

  it('enforces the __Secure- and __Host- prefixes', () => {
    expect(plan('__Secure-a=1; Secure')).toMatchObject({ ok: true });
    expect(plan('__Secure-a=1')).toMatchObject({ ok: false });
    expect(plan('__secure-a=1')).toMatchObject({ ok: false });
    expect(plan('__Secure-a=1; Secure', [], 'http://localhost:3000/')).toMatchObject({ ok: false });
    expect(plan('__Host-a=1; Secure; Path=/')).toMatchObject({ ok: true });
    expect(plan('__Host-a=1; Secure')).toMatchObject({ ok: false }); // default path is not "/"
    expect(plan('__Host-a=1; Secure; Path=/; Domain=app.example.com')).toMatchObject({ ok: false });
    expect(plan('__HOST-a=1; Path=/')).toMatchObject({ ok: false });
  });

  it('refuses Secure from an insecure page and SameSite=None without Secure', () => {
    expect(plan('x=1; Secure', [], 'http://chat.lan:3000/')).toMatchObject({ ok: false });
    expect(plan('x=1; Secure', [], 'http://localhost:3000/')).toMatchObject({ ok: true });
    expect(plan('x=1; SameSite=None')).toMatchObject({ ok: false });
    expect(plan('x=1; SameSite=None; Secure')).toMatchObject({ ok: true, details: { sameSite: 'no_restriction' } });
  });

  it('never overwrites or removes an HttpOnly cookie with the same name, domain and path', () => {
    const sid = cookie({ name: 'sid', httpOnly: true, path: '/' });
    expect(plan('sid=forged; Path=/', [sid])).toMatchObject({ ok: false });
    expect(plan('sid=; Path=/; Max-Age=0', [sid])).toMatchObject({ ok: false });
    // Host-only and domain forms of the same host count as the same cookie here.
    expect(plan('sid=forged; Path=/; Domain=app.example.com', [sid])).toMatchObject({ ok: false });
    const domainSid = cookie({ name: 'sid', httpOnly: true, path: '/', domain: '.example.com', hostOnly: false });
    expect(plan('sid=forged; Path=/; Domain=example.com', [domainSid])).toMatchObject({ ok: false });
    // A different path is a different cookie, as in a browser.
    expect(plan('sid=other; Path=/workspace', [sid])).toMatchObject({ ok: true });
  });

  it('turns Max-Age <= 0 or a past Expires into removal of the matching cookie', () => {
    const csrf = cookie({ name: 'csrf', path: '/', storeId: '0' });
    const elsewhere = cookie({ name: 'csrf', path: '/other' });
    expect(plan('csrf=; Path=/; Max-Age=0', [csrf, elsewhere])).toEqual({
      ok: true,
      action: 'remove',
      targets: [{ url: 'https://app.example.com/', name: 'csrf', storeId: '0' }],
    });
    expect(plan('csrf=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT', [csrf])).toMatchObject({ ok: true, action: 'remove', targets: [{ name: 'csrf' }] });
    expect(plan('csrf=; Path=/; Max-Age=-5', [])).toEqual({ ok: true, action: 'remove', targets: [] });
    // Max-Age wins over Expires.
    expect(plan('csrf=1; Path=/; Max-Age=60; Expires=Thu, 01 Jan 1970 00:00:00 GMT', [csrf])).toMatchObject({ ok: true, action: 'set' });
  });
});

describe('the chrome wrapper', () => {
  function api(existing: BridgeCookie[] = []) {
    return {
      getAll: vi.fn(async () => existing),
      set: vi.fn(async (d: unknown) => d),
      remove: vi.fn(async () => ({})),
    };
  }

  it('looks up same-name cookies around the target domain, then sets', async () => {
    const a = api();
    expect(await bridgeSetCookie(a, FRAME, 'csrf=abc; Path=/', NOW)).toEqual({ ok: true });
    expect(a.getAll).toHaveBeenCalledWith({ name: 'csrf', domain: 'app.example.com' });
    expect(a.set).toHaveBeenCalledWith(expect.objectContaining({ name: 'csrf', value: 'abc', path: '/', httpOnly: false }));
    const b = api();
    await bridgeSetCookie(b, FRAME, 'pref=1; Domain=example.com; Path=/', NOW);
    expect(b.getAll).toHaveBeenCalledWith({ name: 'pref', domain: 'example.com' });
  });

  it('removes on expiry and refuses without touching the store when the assignment is invalid', async () => {
    const a = api([cookie({ name: 'csrf' })]);
    expect(await bridgeSetCookie(a, FRAME, 'csrf=; Path=/; Max-Age=0', NOW)).toEqual({ ok: true });
    expect(a.remove).toHaveBeenCalledWith({ url: 'https://app.example.com/', name: 'csrf' });
    expect(a.set).not.toHaveBeenCalled();
    const b = api();
    expect(await bridgeSetCookie(b, FRAME, 'x=1; Domain=evil.com', NOW)).toMatchObject({ ok: false });
    expect(b.getAll).not.toHaveBeenCalled();
    expect(await bridgeSetCookie(null, FRAME, 'x=1', NOW)).toMatchObject({ ok: false });
  });

  it('reports a browser refusal without detail', async () => {
    const a = { ...api(), set: vi.fn(async () => null) };
    expect(await bridgeSetCookie(a, FRAME, 'x=1', NOW)).toEqual({ ok: false, error: 'The browser did not store that cookie.' });
    const b = { ...api(), set: vi.fn(async () => Promise.reject(new Error('Failed to parse or set cookie named "x=secret"'))) };
    expect(await bridgeSetCookie(b, FRAME, 'x=secret', NOW)).toEqual({ ok: false, error: 'The browser did not store that cookie.' });
  });
});
