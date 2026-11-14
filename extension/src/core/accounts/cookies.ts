// Mapping between chrome.cookies.Cookie and the StoredCookie kept in a saved jar, and back to
// the details chrome.cookies.set / remove expect. Pure: no chrome API, so it can be tested.
//
// The mapping is the one measured in the real-Chromium spike, where 40 cookies (HttpOnly,
// Secure, every SameSite value, session and persistent, host-only and domain, __Host- and
// __Secure- names, one partitioned) round-tripped with zero differences:
// - a host-only cookie is set WITHOUT `domain` (passing one makes it a domain cookie, and
//   Chrome refuses a __Host- cookie that has a domain);
// - a session cookie is set WITHOUT `expirationDate` (passing one makes it persistent);
// - sameSite 'unspecified' is omitted (Chrome then stores it unspecified, as it was);
// - the partition key is passed through unchanged.
import type { StoredCookie } from '../workspace/types.js';

/** The fields of chrome.cookies.Cookie this module reads. */
export interface ChromeCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: string;
  session: boolean;
  expirationDate?: number;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
}

export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  domain?: string;
  expirationDate?: number;
  sameSite?: 'no_restriction' | 'lax' | 'strict';
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
}

export interface CookieRemoveDetails {
  url: string;
  name: string;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
}

const SAME_SITE = new Set<StoredCookie['sameSite']>(['no_restriction', 'lax', 'strict', 'unspecified']);

function copyPartitionKey(key: ChromeCookie['partitionKey']): StoredCookie['partitionKey'] | undefined {
  if (!key || typeof key !== 'object') return undefined;
  const out: NonNullable<StoredCookie['partitionKey']> = {};
  if (typeof key.topLevelSite === 'string') out.topLevelSite = key.topLevelSite;
  if (typeof key.hasCrossSiteAncestor === 'boolean') out.hasCrossSiteAncestor = key.hasCrossSiteAncestor;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Only the fields needed to put the cookie back; storeId is dropped (always the default store). */
export function toStoredCookie(cookie: ChromeCookie): StoredCookie {
  const sameSite = SAME_SITE.has(cookie.sameSite as StoredCookie['sameSite'])
    ? (cookie.sameSite as StoredCookie['sameSite'])
    : 'unspecified';
  const stored: StoredCookie = {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    hostOnly: cookie.hostOnly,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite,
    session: cookie.session,
  };
  if (!cookie.session && typeof cookie.expirationDate === 'number' && Number.isFinite(cookie.expirationDate)) {
    stored.expirationDate = cookie.expirationDate;
  }
  const partitionKey = copyPartitionKey(cookie.partitionKey);
  if (partitionKey) stored.partitionKey = partitionKey;
  return stored;
}

/** The address chrome.cookies needs to reach the cookie: scheme from `secure`, host without the leading dot. */
export function cookieUrl(cookie: Pick<StoredCookie, 'secure' | 'domain' | 'path'>): string {
  const path = cookie.path.startsWith('/') ? cookie.path : `/${cookie.path}`;
  return `http${cookie.secure ? 's' : ''}://${cookie.domain.replace(/^\./, '')}${path}`;
}

export function toSetDetails(cookie: StoredCookie): CookieSetDetails {
  const details: CookieSetDetails = {
    url: cookieUrl(cookie),
    name: cookie.name,
    value: cookie.value,
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
  };
  if (!cookie.hostOnly) details.domain = cookie.domain;
  if (!cookie.session && cookie.expirationDate !== undefined) details.expirationDate = cookie.expirationDate;
  if (cookie.sameSite !== 'unspecified') details.sameSite = cookie.sameSite;
  if (cookie.partitionKey) details.partitionKey = { ...cookie.partitionKey };
  return details;
}

export function removeDetails(cookie: StoredCookie): CookieRemoveDetails {
  const details: CookieRemoveDetails = { url: cookieUrl(cookie), name: cookie.name };
  if (cookie.partitionKey) details.partitionKey = { ...cookie.partitionKey };
  return details;
}

/** One string per cookie slot in the browser: name, domain, path and partition. */
export function cookieSlot(cookie: Pick<StoredCookie, 'name' | 'domain' | 'path' | 'partitionKey'>): string {
  const partition = cookie.partitionKey
    ? `${cookie.partitionKey.topLevelSite ?? ''}|${cookie.partitionKey.hasCrossSiteAncestor === true ? '1' : '0'}`
    : '';
  return JSON.stringify([cookie.name, cookie.domain, cookie.path, partition]);
}

/** Whether two cookies occupy the same slot, so setting one replaces the other. */
export function sameCookie(
  a: Pick<StoredCookie, 'name' | 'domain' | 'path' | 'partitionKey'>,
  b: Pick<StoredCookie, 'name' | 'domain' | 'path' | 'partitionKey'>
): boolean {
  return cookieSlot(a) === cookieSlot(b);
}

/**
 * Cookies that belong to the browser rather than to a login: the bot-check clearance a site's
 * network edge (Cloudflare) gives this device. They stay where they are when accounts are
 * switched. Saving and clearing them with the login would make the site challenge the browser
 * again on every switch, and restoring an old one would present a clearance that has expired.
 */
const DEVICE_COOKIE = /^(?:cf_clearance|__cf_bm|_cfuvid|__cflb|__cfruid|cf_chl_[\w-]+)$/;

export function isDeviceCookie(cookie: Pick<StoredCookie, 'name'>): boolean {
  return DEVICE_COOKIE.test(cookie.name);
}
