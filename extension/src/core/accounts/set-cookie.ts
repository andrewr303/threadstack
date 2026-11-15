// A profile account's cookie jar kept by Threadkeeper itself: how `Set-Cookie` headers and
// document.cookie assignments change it, which of its cookies a page at some address would be
// sent or could read, and how a cookie is written back out as a `Set-Cookie` header.
//
// Why this exists: an account shown in the workspace's profile slot lives in the workspace page's
// credentialless cookie partition, which chrome.cookies cannot read or write (measured, see
// docs/research/2026-11-13-embedded-profiles). The service worker therefore keeps its own copy,
// updated from what it sees on the network, so the sign-in can be put back after the page reloads.
//
// The rules follow RFC 6265bis as Chromium applies them, and where this is unsure it is strict:
// a cookie the browser might refuse is not stored, because a jar that holds more than the browser
// does would hand a later page a sign-in the site never gave it.
//
// Pure: no chrome API.
import type { StoredCookie } from '../workspace/types.js';
import { cookieSlot } from './cookies.js';
import { defaultCookiePath, planCookieAssignment } from '../embed/cookie-bridge.js';

/** Name and value together may not exceed this many bytes (Chromium's limit). */
export const MAX_COOKIE_PAIR_BYTES = 4096;
/** Chromium caps how far in the future a cookie may expire. */
export const MAX_COOKIE_AGE_SECONDS = 400 * 86_400;
/** Jars are bounded: a site that keeps setting new names cannot grow one without limit. */
export const MAX_JAR_COOKIES = 300;

// RFC 6265 token characters for a name; a value may hold anything but controls and ';'.
const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f]/;

const encoder = new TextEncoder();
const bytes = (text: string): number => encoder.encode(text).length;

function isIpHost(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '[::1]';
}

/** The cookie domain without its leading dot, lower case. */
export function bareDomain(cookie: Pick<StoredCookie, 'domain'>): string {
  return cookie.domain.replace(/^\./, '').toLowerCase();
}

/** Whether a cookie applies to `host`: exactly for a host-only cookie, else the domain and below. */
export function domainMatches(cookie: Pick<StoredCookie, 'domain' | 'hostOnly'>, host: string): boolean {
  const h = host.toLowerCase();
  const d = bareDomain(cookie);
  if (cookie.hostOnly) return h === d;
  return h === d || h.endsWith(`.${d}`);
}

/** RFC 6265 path-match: the cookie path is the request path or a directory prefix of it. */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  const path = requestPath || '/';
  if (path === cookiePath) return true;
  if (!path.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || path.charAt(cookiePath.length) === '/';
}

export function isExpired(cookie: Pick<StoredCookie, 'session' | 'expirationDate'>, nowMs: number): boolean {
  return !cookie.session && typeof cookie.expirationDate === 'number' && cookie.expirationDate * 1000 <= nowMs;
}

export type SetCookieOutcome =
  | { kind: 'set'; cookie: StoredCookie }
  /** An expiry in the past: the cookie in this slot, if any, is removed. */
  | { kind: 'remove'; cookie: Pick<StoredCookie, 'name' | 'domain' | 'path' | 'hostOnly'> }
  | { kind: 'ignore'; reason: string };

/**
 * What one `Set-Cookie` header value does when it arrives on a response from `requestUrl`.
 * Cookies the browser would refuse (a Domain the host does not belong to, a Secure cookie from
 * http, a broken __Host- or __Secure- prefix, SameSite=None without Secure) are ignored.
 */
export function parseSetCookie(header: string, requestUrl: string, nowMs: number): SetCookieOutcome {
  if (typeof header !== 'string' || header.length === 0 || CONTROL_RE.test(header)) return { kind: 'ignore', reason: 'malformed' };
  let url: URL;
  try {
    url = new URL(requestUrl);
  } catch {
    return { kind: 'ignore', reason: 'address' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { kind: 'ignore', reason: 'address' };
  const host = url.hostname.toLowerCase();
  const secureOrigin = url.protocol === 'https:' || isLoopbackHost(host);

  const [pair, ...attributes] = header.split(';');
  const eq = pair.indexOf('=');
  if (eq === -1) return { kind: 'ignore', reason: 'nameless' };
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!NAME_RE.test(name)) return { kind: 'ignore', reason: 'name' };
  if (bytes(name) + bytes(value) > MAX_COOKIE_PAIR_BYTES) return { kind: 'ignore', reason: 'size' };

  let domain: string | null = null;
  let path: string | null = null;
  let maxAge: number | null = null;
  let expires: number | null = null;
  let secure = false;
  let httpOnly = false;
  let partitioned = false;
  let sameSite: StoredCookie['sameSite'] = 'unspecified';
  for (const raw of attributes) {
    const at = raw.indexOf('=');
    const key = (at === -1 ? raw : raw.slice(0, at)).trim().toLowerCase();
    const val = at === -1 ? '' : raw.slice(at + 1).trim();
    switch (key) {
      case 'expires': {
        const t = Date.parse(val);
        if (Number.isFinite(t)) expires = t;
        break;
      }
      case 'max-age':
        if (/^-?\d{1,12}$/.test(val)) maxAge = Number(val);
        break;
      case 'domain': {
        const d = val.replace(/^\./, '').toLowerCase();
        // An empty Domain attribute is ignored, as the browser does.
        if (d) domain = d;
        break;
      }
      case 'path':
        path = val.startsWith('/') ? val : null;
        break;
      case 'secure':
        secure = true;
        break;
      case 'httponly':
        httpOnly = true;
        break;
      case 'partitioned':
        partitioned = true;
        break;
      case 'samesite': {
        const s = val.toLowerCase();
        sameSite = s === 'strict' ? 'strict' : s === 'lax' ? 'lax' : s === 'none' ? 'no_restriction' : 'unspecified';
        break;
      }
      default:
        break;
    }
  }

  let hostOnly = true;
  if (domain !== null) {
    if (isIpHost(host)) {
      if (domain !== host) return { kind: 'ignore', reason: 'domain' };
    } else if (domain !== host && !host.endsWith(`.${domain}`)) {
      return { kind: 'ignore', reason: 'domain' };
    } else if (!domain.includes('.') && domain !== host) {
      // A bare label is a public suffix as far as this can tell.
      return { kind: 'ignore', reason: 'domain' };
    } else {
      hostOnly = false;
    }
  }
  const cookiePath = path ?? defaultCookiePath(url.pathname);

  if (secure && !secureOrigin) return { kind: 'ignore', reason: 'secure' };
  if (sameSite === 'no_restriction' && !secure) return { kind: 'ignore', reason: 'samesite' };
  if (partitioned && !secure) return { kind: 'ignore', reason: 'partitioned' };
  const lower = name.toLowerCase();
  if (lower.startsWith('__secure-') && !(secure && url.protocol === 'https:')) return { kind: 'ignore', reason: 'prefix' };
  if (lower.startsWith('__host-') && !(secure && url.protocol === 'https:' && hostOnly && cookiePath === '/')) {
    return { kind: 'ignore', reason: 'prefix' };
  }

  const storedDomain = hostOnly ? host : `.${domain}`;
  let expirationDate: number | undefined;
  if (maxAge !== null) {
    if (maxAge <= 0) return { kind: 'remove', cookie: { name, domain: storedDomain, path: cookiePath, hostOnly } };
    expirationDate = Math.floor(nowMs / 1000) + Math.min(maxAge, MAX_COOKIE_AGE_SECONDS);
  } else if (expires !== null) {
    if (expires <= nowMs) return { kind: 'remove', cookie: { name, domain: storedDomain, path: cookiePath, hostOnly } };
    expirationDate = Math.min(Math.floor(expires / 1000), Math.floor(nowMs / 1000) + MAX_COOKIE_AGE_SECONDS);
  }

  const cookie: StoredCookie = {
    name,
    value,
    domain: storedDomain,
    hostOnly,
    path: cookiePath,
    secure,
    httpOnly,
    sameSite,
    session: expirationDate === undefined,
  };
  if (expirationDate !== undefined) cookie.expirationDate = expirationDate;
  if (partitioned) cookie.partitioned = true;
  return { kind: 'set', cookie };
}

/** One slot per name, domain and path; where the cookie came from (a partition) does not matter here. */
function jarSlot(cookie: Pick<StoredCookie, 'name' | 'domain' | 'path'>): string {
  return cookieSlot({ name: cookie.name, domain: cookie.domain, path: cookie.path });
}

/** The jar without cookies whose time has passed. Returns the same array when nothing expired. */
export function pruneExpired(jar: readonly StoredCookie[], nowMs: number): StoredCookie[] {
  const kept = jar.filter((c) => !isExpired(c, nowMs));
  return kept.length === jar.length ? (jar as StoredCookie[]) : kept;
}

function put(jar: readonly StoredCookie[], cookie: StoredCookie): StoredCookie[] {
  const slot = jarSlot(cookie);
  const at = jar.findIndex((c) => jarSlot(c) === slot);
  if (at === -1) {
    const next = [...jar, cookie];
    // Oldest first out, as the browser evicts.
    return next.length > MAX_JAR_COOKIES ? next.slice(next.length - MAX_JAR_COOKIES) : next;
  }
  const next = jar.slice();
  next[at] = cookie;
  return next;
}

function drop(jar: readonly StoredCookie[], target: Pick<StoredCookie, 'name' | 'domain' | 'path'>): StoredCookie[] {
  const slot = jarSlot(target);
  const next = jar.filter((c) => jarSlot(c) !== slot);
  return next.length === jar.length ? (jar as StoredCookie[]) : next;
}

function sameStored(a: StoredCookie, b: StoredCookie): boolean {
  return (
    a.value === b.value &&
    a.secure === b.secure &&
    a.httpOnly === b.httpOnly &&
    a.sameSite === b.sameSite &&
    a.session === b.session &&
    a.expirationDate === b.expirationDate &&
    a.hostOnly === b.hostOnly
  );
}

/**
 * The jar after the response headers of one request. Returns the same array when nothing
 * changed, so callers can tell whether there is anything to save.
 */
export function applySetCookies(
  jar: readonly StoredCookie[],
  headers: readonly string[],
  requestUrl: string,
  nowMs: number
): StoredCookie[] {
  let next = jar as StoredCookie[];
  for (const header of headers) {
    const outcome = parseSetCookie(header, requestUrl, nowMs);
    if (outcome.kind === 'ignore') continue;
    if (outcome.kind === 'remove') {
      next = drop(next, outcome.cookie);
      continue;
    }
    const slot = jarSlot(outcome.cookie);
    const existing = next.find((c) => jarSlot(c) === slot);
    if (existing && sameStored(existing, outcome.cookie)) continue;
    next = put(next, outcome.cookie);
  }
  return next;
}

/**
 * The jar after `document.cookie = text` on the page at `frameUrl`, with the rules a browser
 * applies to scripts (never HttpOnly, never over an HttpOnly cookie, Domain and prefixes checked).
 */
export function applyScriptCookie(
  jar: readonly StoredCookie[],
  text: unknown,
  frameUrl: string,
  nowMs: number
): { ok: true; jar: StoredCookie[] } | { ok: false; error: string } {
  const plan = planCookieAssignment({ text, frameUrl, existing: jar as StoredCookie[], nowMs });
  if (!plan.ok) return { ok: false, error: plan.error };
  let host: string;
  try {
    host = new URL(frameUrl).hostname.toLowerCase();
  } catch {
    return { ok: false, error: 'The page address is not valid.' };
  }
  if (plan.action === 'remove') {
    // The plan names the cookies to remove by address and name; match them back to the jar.
    let next = jar as StoredCookie[];
    for (const target of plan.targets) {
      let parsed: URL;
      try {
        parsed = new URL(target.url);
      } catch {
        continue;
      }
      next = next.filter(
        (c) => !(c.name === target.name && !c.httpOnly && bareDomain(c) === parsed.hostname.toLowerCase() && c.path === parsed.pathname)
      );
    }
    return { ok: true, jar: next.length === jar.length ? (jar as StoredCookie[]) : next };
  }
  const d = plan.details;
  const hostOnly = d.domain === undefined;
  const cookie: StoredCookie = {
    name: d.name,
    value: d.value,
    domain: hostOnly ? host : `.${d.domain}`,
    hostOnly,
    path: d.path,
    secure: d.secure,
    httpOnly: false,
    sameSite: d.sameSite ?? 'unspecified',
    session: d.expirationDate === undefined,
  };
  if (d.expirationDate !== undefined) cookie.expirationDate = Math.min(d.expirationDate, Math.floor(nowMs / 1000) + MAX_COOKIE_AGE_SECONDS);
  if (bytes(cookie.name) + bytes(cookie.value) > MAX_COOKIE_PAIR_BYTES) return { ok: false, error: 'The cookie is too large.' };
  const slot = jarSlot(cookie);
  const existing = jar.find((c) => jarSlot(c) === slot);
  if (existing && sameStored(existing, cookie)) return { ok: true, jar: jar as StoredCookie[] };
  return { ok: true, jar: put(jar, cookie) };
}

/**
 * The jar's cookies that apply to a page at `url`, longest path first. With `script`, only the
 * ones a page script may read (no HttpOnly).
 */
export function cookiesForUrl(
  jar: readonly StoredCookie[],
  url: string,
  nowMs: number,
  options: { script?: boolean } = {}
): StoredCookie[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const host = parsed.hostname.toLowerCase();
  const secure = parsed.protocol === 'https:' || isLoopbackHost(host);
  return jar
    .map((cookie, index) => ({ cookie, index }))
    .filter(
      ({ cookie }) =>
        !isExpired(cookie, nowMs) &&
        domainMatches(cookie, host) &&
        pathMatches(parsed.pathname, cookie.path) &&
        (!cookie.secure || secure) &&
        (!options.script || !cookie.httpOnly)
    )
    .sort((a, b) => b.cookie.path.length - a.cookie.path.length || a.index - b.index)
    .map(({ cookie }) => cookie);
}

// eslint-disable-next-line no-control-regex
const UNSAFE_HEADER_RE = /[\u0000-\u001f\u007f;]/;

/**
 * A stored cookie as a `Set-Cookie` header value that puts it back as it was. Null for a cookie
 * that has expired or whose name or value could not travel in a header.
 */
export function serializeSetCookie(cookie: StoredCookie, nowMs: number): string | null {
  if (isExpired(cookie, nowMs)) return null;
  if (!NAME_RE.test(cookie.name) || UNSAFE_HEADER_RE.test(cookie.value)) return null;
  if (!cookie.path.startsWith('/') || UNSAFE_HEADER_RE.test(cookie.path)) return null;
  const domain = bareDomain(cookie);
  if (!/^[a-z0-9.-]+$/.test(domain)) return null;
  const parts = [`${cookie.name}=${cookie.value}`, `Path=${cookie.path}`];
  if (!cookie.hostOnly) parts.push(`Domain=${domain}`);
  if (!cookie.session && typeof cookie.expirationDate === 'number') {
    parts.push(`Expires=${new Date(cookie.expirationDate * 1000).toUTCString()}`);
  }
  if (cookie.secure) parts.push('Secure');
  if (cookie.httpOnly) parts.push('HttpOnly');
  if (cookie.sameSite === 'no_restriction') parts.push('SameSite=None');
  else if (cookie.sameSite === 'lax') parts.push('SameSite=Lax');
  else if (cookie.sameSite === 'strict') parts.push('SameSite=Strict');
  if ((cookie.partitioned || cookie.partitionKey) && cookie.secure) parts.push('Partitioned');
  return parts.join('; ');
}

/** Name and value bytes, which is what the browser counts against a partition's size limit. */
export function cookiePairBytes(cookie: Pick<StoredCookie, 'name' | 'value'>): number {
  return bytes(cookie.name) + bytes(cookie.value);
}

/**
 * Whether the jar holds what looks like a sign-in: a cookie scripts cannot read that is not the
 * network edge's bot-check. Used only to say "signed in" or "needs a sign-in" before the site
 * has named the person; it never decides which account something belongs to.
 */
export function looksSignedIn(jar: readonly StoredCookie[], nowMs: number, isDevice: (cookie: StoredCookie) => boolean): boolean {
  return jar.some((c) => c.httpOnly && !isExpired(c, nowMs) && !isDevice(c));
}
