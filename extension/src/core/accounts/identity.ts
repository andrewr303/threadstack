// Who a site says is signed in, read from responses the page itself requested.
// Pure (no chrome API): imported by the page-world observer, the content script and tests.
//
// UNVERIFIED: the endpoints and response shapes below come from how these sites are commonly
// described, not from the spike logs or a live capture. The parsers are therefore strict: a
// body is an identity only when it carries a stable user id AND is plainly the account object
// itself. Any other shape yields null, because a wrong identity would switch the active account
// and file captures under the wrong person, while a missed one only delays the label.
//
// Only a hash of the site's user id leaves this module (never the id itself), plus the email or
// name the site shows and a plan name. Tokens and everything else in the body are dropped.
import type { ProviderId } from '../providers.js';
import { computeDeterministicHash } from '../hash.js';
import type { AccountIdentity } from '../workspace/types.js';

/** A request whose response names the signed-in person. */
export type IdentitySource = 'chatgpt_session' | 'claude_account' | 'cursor_me';

/** Bodies larger than this are not read: identity responses are small, and parsing is on the page. */
export const IDENTITY_BODY_LIMIT_BYTES = 64 * 1024;

const MAX_TEXT = 200;

function pathIs(pathname: string, base: string): boolean {
  return pathname === base || pathname.startsWith(`${base}/`);
}

/** Which identity response, if any, a GET to `url` on `hostname` is. */
export function matchIdentityRequest(hostname: string, url: string): IdentitySource | null {
  let parsed: URL;
  try {
    parsed = new URL(url, `https://${hostname}`);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  const host = parsed.hostname.toLowerCase();
  if (host !== hostname.toLowerCase()) return null;
  const path = parsed.pathname;
  if ((host === 'chatgpt.com' || host === 'chat.openai.com') && path === '/api/auth/session') return 'chatgpt_session';
  if (host === 'claude.ai' && (pathIs(path, '/api/account') || pathIs(path, '/api/bootstrap'))) return 'claude_account';
  if ((host === 'cursor.com' || host === 'www.cursor.com') && path === '/api/auth/me') return 'cursor_me';
  return null;
}

/** The provider whose login realm an identity source belongs to. */
export function providerForIdentitySource(source: IdentitySource): ProviderId {
  return source === 'chatgpt_session' ? 'chatgpt' : source === 'claude_account' ? 'claude' : 'cursor_agents';
}

const SOURCE_FAMILY: Record<IdentitySource, string> = {
  chatgpt_session: 'chatgpt',
  claude_account: 'claude',
  cursor_me: 'cursor',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A stable id: a non-empty string or a whole number. */
function stableId(value: unknown): string | null {
  if (typeof value === 'string') {
    const id = value.trim();
    return id.length > 0 && id.length <= MAX_TEXT ? id : null;
  }
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  return null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const t = value.trim();
  return t.length > 0 ? t.slice(0, MAX_TEXT) : null;
}

/** Only an address that looks like one, so a random string is never shown as the account. */
function email(value: unknown): string | null {
  const t = text(value);
  return t && /^[^\s@]+@[^\s@]+$/.test(t) ? t : null;
}

function identity(
  source: IdentitySource,
  id: string,
  display: string | null,
  detail: string | null
): Omit<AccountIdentity, 'observedAt'> {
  return {
    key: `${SOURCE_FAMILY[source]}:${computeDeterministicHash(id)}`,
    display,
    detail,
    source: 'network',
  };
}

/** ChatGPT `/api/auth/session`: `{ user: { id, email?, name? }, account?: { planType? } }`. Signed out is `{}`. */
function parseChatgpt(json: unknown): Omit<AccountIdentity, 'observedAt'> | null {
  if (!isRecord(json) || !isRecord(json.user)) return null;
  const id = stableId(json.user.id);
  if (!id) return null;
  const display = email(json.user.email) ?? text(json.user.name);
  const plan = isRecord(json.account) ? text(json.account.planType) : null;
  return identity('chatgpt_session', id, display, plan);
}

/**
 * Claude `/api/account` (the account object) or `/api/bootstrap` (`{ account: {...} }`). The
 * account must carry an email: an organization also has a uuid and a name but no email, and a
 * list of organizations alone is not a person.
 */
function parseClaude(json: unknown): Omit<AccountIdentity, 'observedAt'> | null {
  if (!isRecord(json)) return null;
  const account = isRecord(json.account) ? json.account : json;
  const id = stableId(account.uuid) ?? stableId(account.id);
  if (!id) return null;
  const address = email(account.email_address) ?? email(account.email);
  if (!address) return null;
  return identity('claude_account', id, address, null);
}

/** Cursor `/api/auth/me`: `{ sub or id, email, name? }`. */
function parseCursor(json: unknown): Omit<AccountIdentity, 'observedAt'> | null {
  if (!isRecord(json)) return null;
  const id = stableId(json.sub) ?? stableId(json.id);
  if (!id) return null;
  const address = email(json.email);
  if (!address) return null;
  return identity('cursor_me', id, address, null);
}

/** Identity carried by a response body, or null when the body does not name one with certainty. */
export function parseIdentity(source: IdentitySource, json: unknown): Omit<AccountIdentity, 'observedAt'> | null {
  try {
    if (source === 'chatgpt_session') return parseChatgpt(json);
    if (source === 'claude_account') return parseClaude(json);
    if (source === 'cursor_me') return parseCursor(json);
    return null;
  } catch {
    return null;
  }
}

/** Whether a response body is small enough to read for an identity (UTF-8 bytes). */
export function withinIdentityBodyLimit(body: string): boolean {
  // Every UTF-16 unit is at least one UTF-8 byte and at most three.
  if (body.length > IDENTITY_BODY_LIMIT_BYTES) return false;
  if (body.length * 3 <= IDENTITY_BODY_LIMIT_BYTES) return true;
  return new TextEncoder().encode(body).byteLength <= IDENTITY_BODY_LIMIT_BYTES;
}

/** Size guard, JSON parse and `parseIdentity` in one step; null for anything unusable. */
export function parseIdentityBody(source: IdentitySource, body: string): Omit<AccountIdentity, 'observedAt'> | null {
  if (!withinIdentityBodyLimit(body)) return null;
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    return null;
  }
  return parseIdentity(source, json);
}
