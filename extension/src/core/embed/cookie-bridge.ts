// Cookie bridge for pages embedded in the workspace.
//
// Measured in a real-Chromium spike: a frame embedded in an extension page sends the site's
// ordinary cookies on requests, but its scripts run in a cross-site context, so document.cookie
// sees only SameSite=None cookies and drops writes of every other kind. Sites that read a cookie
// from script (a CSRF token, a consent flag) then break. The frame's content script asks the
// worker instead: EMBED_COOKIES_GET answers what document.cookie would return in an ordinary tab
// for the frame's address, and EMBED_COOKIE_SET applies one document.cookie assignment with the
// rules a browser applies to scripts. The address always comes from the sender, never the message.
//
// Known differences from a browser, all on the strict side: a nameless cookie ("=v" or "v") is
// refused; the Partitioned attribute is ignored (the cookie is stored for the site itself, which
// is what that page sees as a top-level tab); public-suffix checks are left to chrome.cookies.set,
// which applies the browser's own list.
//
// The parsing and decisions are pure and unit-tested; the chrome glue is at the bottom.
import type { EmbedCookiesResult, StoredCookie, WorkspaceFailure } from '../workspace/types.js';

export const MAX_COOKIE_ASSIGNMENT_BYTES = 4096;

export type BridgeCookie = StoredCookie & { storeId?: string };

/** What document.cookie returns: script-visible cookies as "name=value; ...", longest path first. */
export function documentCookieString(cookies: Array<Pick<StoredCookie, 'name' | 'value' | 'path' | 'httpOnly'>>): string {
  return cookies
    .filter((c) => !c.httpOnly)
    .map((c, index) => ({ c, index }))
    .sort((a, b) => b.c.path.length - a.c.path.length || a.index - b.index)
    .map(({ c }) => (c.name === '' ? c.value : `${c.name}=${c.value}`))
    .join('; ');
}

export interface CookieAssignment {
  name: string;
  value: string;
  /** Lowercase, without a leading dot; null when the assignment named no Domain. */
  domain: string | null;
  /** null when the assignment named no usable Path. */
  path: string | null;
  /** Seconds; null when absent or malformed. */
  maxAge: number | null;
  /** Milliseconds since the epoch; null when absent or unparseable. */
  expires: number | null;
  secure: boolean;
  sameSite: StoredCookie['sameSite'];
}

// RFC 6265 token characters for the name; the value may hold anything but controls and ';'.
const NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
// eslint-disable-next-line no-control-regex
const BAD_VALUE_RE = /[\u0000-\u001f\u007f;]/;

export function parseCookieAssignment(text: string): CookieAssignment | { error: string } {
  const [pair, ...attributes] = text.split(';');
  const eq = pair.indexOf('=');
  if (eq === -1) return { error: 'A cookie without a name is not accepted.' };
  const name = pair.slice(0, eq).trim();
  const value = pair.slice(eq + 1).trim();
  if (!NAME_RE.test(name)) return { error: 'The cookie name is not valid.' };
  if (BAD_VALUE_RE.test(value)) return { error: 'The cookie value is not valid.' };
  const out: CookieAssignment = { name, value, domain: null, path: null, maxAge: null, expires: null, secure: false, sameSite: 'unspecified' };
  for (const raw of attributes) {
    const at = raw.indexOf('=');
    const key = (at === -1 ? raw : raw.slice(0, at)).trim().toLowerCase();
    const val = at === -1 ? '' : raw.slice(at + 1).trim();
    switch (key) {
      case 'expires': {
        const t = Date.parse(val);
        if (Number.isFinite(t)) out.expires = t;
        break;
      }
      case 'max-age':
        if (/^-?\d{1,12}$/.test(val)) out.maxAge = Number(val);
        break;
      case 'domain': {
        const d = val.replace(/^\./, '').toLowerCase();
        if (d) out.domain = d;
        break;
      }
      case 'path':
        out.path = val.startsWith('/') ? val : null;
        break;
      case 'secure':
        out.secure = true;
        break;
      case 'samesite': {
        const s = val.toLowerCase();
        out.sameSite = s === 'strict' ? 'strict' : s === 'lax' ? 'lax' : s === 'none' ? 'no_restriction' : 'unspecified';
        break;
      }
      default:
        // HttpOnly (scripts cannot set it), Partitioned, Priority and unknown attributes.
        break;
    }
  }
  return out;
}

/** RFC 6265 default-path: the directory of the request path. */
export function defaultCookiePath(pathname: string): string {
  if (!pathname.startsWith('/')) return '/';
  const last = pathname.lastIndexOf('/');
  return last <= 0 ? '/' : pathname.slice(0, last);
}

function isIpHost(host: string): boolean {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.startsWith('[');
}

function isLoopbackHost(host: string): boolean {
  return host === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '[::1]';
}

/** URL chrome.cookies needs to address a stored cookie exactly (domain and path). */
export function cookieUrl(c: Pick<StoredCookie, 'domain' | 'path' | 'secure'>): string {
  return `http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path}`;
}

export interface CookieSetDetails {
  url: string;
  name: string;
  value: string;
  path: string;
  secure: boolean;
  httpOnly: false;
  domain?: string;
  sameSite?: 'no_restriction' | 'lax' | 'strict';
  expirationDate?: number;
}

export interface CookieRemoveDetails {
  url: string;
  name: string;
  storeId?: string;
  partitionKey?: StoredCookie['partitionKey'];
}

export type CookieSetPlan =
  | { ok: true; action: 'set'; details: CookieSetDetails }
  | { ok: true; action: 'remove'; targets: CookieRemoveDetails[] }
  | { ok: false; error: string };

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

/**
 * Decide one document.cookie assignment made by the page at `frameUrl`. `existing` holds the
 * stored cookies with the same name around the target domain (any path), used to find the
 * cookie the assignment would replace.
 */
export function planCookieAssignment(input: { text: unknown; frameUrl: string; existing: BridgeCookie[]; nowMs: number }): CookieSetPlan {
  if (typeof input.text !== 'string' || input.text.length === 0) return { ok: false, error: 'The cookie is empty.' };
  if (byteLength(input.text) > MAX_COOKIE_ASSIGNMENT_BYTES) return { ok: false, error: 'The cookie is too large.' };
  let url: URL;
  try {
    url = new URL(input.frameUrl);
  } catch {
    return { ok: false, error: 'The page address is not valid.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'The page address is not valid.' };
  const parsed = parseCookieAssignment(input.text);
  if ('error' in parsed) return { ok: false, error: parsed.error };
  const host = url.hostname.toLowerCase();
  const secureOrigin = url.protocol === 'https:' || isLoopbackHost(host);

  let domain = parsed.domain;
  if (domain !== null) {
    if (isIpHost(host)) {
      // An address host takes no Domain attribute other than itself, which means host-only.
      if (domain !== host) return { ok: false, error: 'The cookie domain does not belong to this page.' };
      domain = null;
    } else if (domain !== host && !host.endsWith(`.${domain}`)) {
      return { ok: false, error: 'The cookie domain does not belong to this page.' };
    } else if (domain !== host && !domain.includes('.')) {
      return { ok: false, error: 'The cookie domain does not belong to this page.' };
    }
  }
  const path = parsed.path ?? defaultCookiePath(url.pathname);

  if (parsed.secure && !secureOrigin) return { ok: false, error: 'A secure cookie needs an https page.' };
  if (parsed.sameSite === 'no_restriction' && !parsed.secure) return { ok: false, error: 'A SameSite=None cookie must be secure.' };
  const lower = parsed.name.toLowerCase();
  if (lower.startsWith('__secure-') && !(parsed.secure && url.protocol === 'https:')) {
    return { ok: false, error: 'A __Secure- cookie must be secure and set from an https page.' };
  }
  if (lower.startsWith('__host-') && !(parsed.secure && url.protocol === 'https:' && parsed.domain === null && path === '/')) {
    return { ok: false, error: 'A __Host- cookie must be secure, set from an https page, without Domain and with Path=/.' };
  }

  // The cookie this assignment replaces: same name, domain and path. Host-only and domain
  // cookies of one host are both counted, so a script can never shadow an HttpOnly cookie.
  const targetDomain = domain ?? host;
  const equivalent = input.existing.filter(
    (c) => c.name === parsed.name && c.path === path && c.domain.replace(/^\./, '').toLowerCase() === targetDomain
  );
  if (equivalent.some((c) => c.httpOnly)) return { ok: false, error: 'The page cannot replace that cookie.' };

  let expirationDate: number | undefined;
  let remove = false;
  if (parsed.maxAge !== null) {
    if (parsed.maxAge <= 0) remove = true;
    else expirationDate = Math.floor(input.nowMs / 1000) + parsed.maxAge;
  } else if (parsed.expires !== null) {
    if (parsed.expires <= input.nowMs) remove = true;
    else expirationDate = Math.floor(parsed.expires / 1000);
  }
  if (remove) {
    return {
      ok: true,
      action: 'remove',
      targets: equivalent.map((c) => ({
        url: cookieUrl(c),
        name: c.name,
        ...(c.storeId ? { storeId: c.storeId } : {}),
        ...(c.partitionKey ? { partitionKey: c.partitionKey } : {}),
      })),
    };
  }
  const details: CookieSetDetails = {
    url: `${url.protocol}//${url.host}${path}`,
    name: parsed.name,
    value: parsed.value,
    path,
    secure: parsed.secure,
    httpOnly: false,
  };
  if (domain !== null) details.domain = domain;
  if (parsed.sameSite !== 'unspecified') details.sameSite = parsed.sameSite;
  if (expirationDate !== undefined) details.expirationDate = expirationDate;
  return { ok: true, action: 'set', details };
}

// ---- Chrome glue -------------------------------------------------------------------------

export interface CookiesApi {
  getAll(details: { url?: string; name?: string; domain?: string }): Promise<BridgeCookie[]>;
  set(details: CookieSetDetails): Promise<unknown>;
  remove(details: CookieRemoveDetails): Promise<unknown>;
}

const BRIDGE_FAILED: WorkspaceFailure = { ok: false, error: 'Cookies are not available for this page.' };

export async function bridgeGetCookies(api: CookiesApi | null, frameUrl: string): Promise<EmbedCookiesResult> {
  if (!api) return BRIDGE_FAILED;
  try {
    return { ok: true, cookie: documentCookieString(await api.getAll({ url: frameUrl })) };
  } catch {
    return BRIDGE_FAILED;
  }
}

export async function bridgeSetCookie(api: CookiesApi | null, frameUrl: string, text: unknown, nowMs: number): Promise<{ ok: true } | WorkspaceFailure> {
  if (!api) return BRIDGE_FAILED;
  try {
    // Parse first so a malformed assignment never triggers a cookie read.
    const probe = planCookieAssignment({ text, frameUrl, existing: [], nowMs });
    if (!probe.ok) return { ok: false, error: probe.error };
    const parsed = parseCookieAssignment(text as string);
    if ('error' in parsed) return { ok: false, error: parsed.error };
    const host = new URL(frameUrl).hostname.toLowerCase();
    const lookupDomain = parsed.domain && !isIpHost(host) ? parsed.domain : host;
    const existing = await api.getAll({ name: parsed.name, domain: lookupDomain });
    const plan = planCookieAssignment({ text, frameUrl, existing, nowMs });
    if (!plan.ok) return { ok: false, error: plan.error };
    if (plan.action === 'remove') {
      for (const target of plan.targets) await api.remove(target);
      return { ok: true };
    }
    const stored = await api.set(plan.details);
    return stored ? { ok: true } : { ok: false, error: 'The browser did not store that cookie.' };
  } catch {
    return { ok: false, error: 'The browser did not store that cookie.' };
  }
}

/** chrome.cookies behind CookiesApi; null when the permission is missing (an old manifest). */
export function chromeCookiesApi(): CookiesApi | null {
  if (typeof chrome === 'undefined' || !chrome.cookies?.getAll) return null;
  return {
    getAll: (details) => chrome.cookies.getAll(details) as Promise<BridgeCookie[]>,
    set: (details) => chrome.cookies.set(details),
    remove: (details) => chrome.cookies.remove(details as chrome.cookies.CookieDetails),
  };
}
