import { describe, expect, it } from 'vitest';
import {
  cookieUrl,
  removeDetails,
  sameCookie,
  toSetDetails,
  toStoredCookie,
  type ChromeCookie,
} from '../../src/core/accounts/cookies.js';
import type { StoredCookie } from '../../src/core/workspace/types.js';

/** Shapes as chrome.cookies.getAll returned them in the spike (logs/e3.json), plus storeId. */
const chromeCookie = (patch: Partial<ChromeCookie> & { storeId?: string }): ChromeCookie & { storeId: string } => ({
  name: 'acct',
  value: 'v1',
  domain: 'app.example.test',
  hostOnly: true,
  path: '/',
  secure: true,
  httpOnly: true,
  sameSite: 'lax',
  session: true,
  storeId: '0',
  ...patch,
});

describe('toStoredCookie', () => {
  it('keeps the fields needed to restore and drops storeId', () => {
    const stored = toStoredCookie(chromeCookie({}));
    expect(stored).toEqual({
      name: 'acct',
      value: 'v1',
      domain: 'app.example.test',
      hostOnly: true,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      session: true,
    });
    expect('storeId' in stored).toBe(false);
  });

  it('keeps expirationDate only for persistent cookies', () => {
    expect(toStoredCookie(chromeCookie({ session: false, expirationDate: 1794429242 })).expirationDate).toBe(1794429242);
    expect('expirationDate' in toStoredCookie(chromeCookie({ session: true, expirationDate: 1794429242 }))).toBe(false);
  });

  it('copies the partition key and maps an unknown sameSite to unspecified', () => {
    const stored = toStoredCookie(
      chromeCookie({ name: 'part_c', partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false }, sameSite: 'weird' })
    );
    expect(stored.partitionKey).toEqual({ topLevelSite: 'https://example.test', hasCrossSiteAncestor: false });
    expect(stored.sameSite).toBe('unspecified');
  });
});

describe('cookieUrl', () => {
  it('uses https for secure cookies and http otherwise, without the leading dot', () => {
    expect(cookieUrl({ secure: true, domain: '.example.test', path: '/' })).toBe('https://example.test/');
    expect(cookieUrl({ secure: false, domain: 'app.example.test', path: '/api' })).toBe('http://app.example.test/api');
  });
});

describe('toSetDetails', () => {
  const base: StoredCookie = toStoredCookie(chromeCookie({}));

  it('omits domain for host-only cookies, so __Host- cookies are accepted', () => {
    const details = toSetDetails({ ...base, name: '__Host-sess', sameSite: 'strict' });
    expect(details).toEqual({
      url: 'https://app.example.test/',
      name: '__Host-sess',
      value: 'v1',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
    });
    expect('domain' in details).toBe(false);
  });

  it('passes the domain for domain cookies', () => {
    const details = toSetDetails({ ...base, name: '__Secure-tok', domain: '.example.test', hostOnly: false, sameSite: 'no_restriction' });
    expect(details.domain).toBe('.example.test');
    expect(details.url).toBe('https://example.test/');
    expect(details.sameSite).toBe('no_restriction');
  });

  it('omits expirationDate for session cookies and keeps it for persistent ones', () => {
    expect('expirationDate' in toSetDetails({ ...base, session: true, expirationDate: 1794429242 })).toBe(false);
    expect(toSetDetails({ ...base, session: false, expirationDate: 1794429242 }).expirationDate).toBe(1794429242);
  });

  it("omits sameSite when it is 'unspecified'", () => {
    expect('sameSite' in toSetDetails({ ...base, sameSite: 'unspecified' })).toBe(false);
  });

  it('passes the partition key through', () => {
    const partitionKey = { topLevelSite: 'chrome-extension://abc', hasCrossSiteAncestor: true };
    expect(toSetDetails({ ...base, partitionKey }).partitionKey).toEqual(partitionKey);
  });

  it('uses an http address for a cookie that is not secure', () => {
    const details = toSetDetails({ ...base, secure: false, path: '/api' });
    expect(details.url).toBe('http://app.example.test/api');
    expect(details.secure).toBe(false);
  });
});

describe('removeDetails', () => {
  it('names the cookie by address, name and partition', () => {
    const base = toStoredCookie(chromeCookie({ domain: '.example.test', hostOnly: false }));
    expect(removeDetails(base)).toEqual({ url: 'https://example.test/', name: 'acct' });
    const partitionKey = { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false };
    expect(removeDetails({ ...base, partitionKey })).toEqual({ url: 'https://example.test/', name: 'acct', partitionKey });
  });
});

describe('sameCookie', () => {
  const a = toStoredCookie(chromeCookie({}));

  it('compares name, domain, path and partition, not the value', () => {
    const sameSlot: StoredCookie = { ...a, value: 'other' };
    expect(sameCookie(a, sameSlot)).toBe(true);
    expect(sameCookie(a, { ...a, name: 'other' })).toBe(false);
    expect(sameCookie(a, { ...a, domain: '.app.example.test' })).toBe(false);
    expect(sameCookie(a, { ...a, path: '/api' })).toBe(false);
    expect(sameCookie(a, { ...a, partitionKey: { topLevelSite: 'https://example.test' } })).toBe(false);
    expect(
      sameCookie(
        { ...a, partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false } },
        { ...a, partitionKey: { topLevelSite: 'https://example.test' } }
      )
    ).toBe(true);
    expect(
      sameCookie(
        { ...a, partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: true } },
        { ...a, partitionKey: { topLevelSite: 'https://example.test', hasCrossSiteAncestor: false } }
      )
    ).toBe(false);
  });
});

describe('cookies that are not part of a login', () => {
  it('recognises the device bot-check cookies and nothing else', async () => {
    const { isDeviceCookie } = await import('../../src/core/accounts/cookies.js');
    for (const name of ['cf_clearance', '__cf_bm', '_cfuvid', '__cflb', '__cfruid', 'cf_chl_rc_ni']) {
      expect(isDeviceCookie({ name })).toBe(true);
    }
    for (const name of ['sessionKey', '__Secure-next-auth.session-token', 'auth_token', 'ct0', 'cf_clearance2', 'my__cf_bm']) {
      expect(isDeviceCookie({ name })).toBe(false);
    }
  });

  it('names the two partitions a realm domain writes to, never every partition', async () => {
    const { partitionSites } = await import('../../src/core/accounts/chrome-env.js');
    expect(partitionSites('claude.ai', 'chrome-extension://abcdefghijklmnop/')).toEqual(['https://claude.ai', 'chrome-extension://abcdefghijklmnop']);
    expect(partitionSites('auth.openai.com', 'chrome-extension://abcdefghijklmnop/')).toEqual(['https://openai.com', 'chrome-extension://abcdefghijklmnop']);
    expect(partitionSites('authenticator.cursor.sh', '')).toEqual(['https://cursor.sh']);
  });
});
