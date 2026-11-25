import {
  parseChatGptConversation,
  parseClaudeConversation,
  toIso,
  type SiteConversation,
  type SiteProvider,
} from './site-api.js';
import type { SyncErrorCode, SyncEvent } from './history-sync.js';
import { describeSyncError } from './history-sync.js';
import { parseIdentity } from './accounts/identity.js';
import type { AccountIdentity } from './workspace/types.js';

/**
 * Reads recent conversations from ChatGPT and Claude through the page's own signed-in session.
 *
 * Runs in the content script, so every request is same-origin and carries the user's cookies,
 * exactly like the page's own requests. It only reads (GET), one conversation at a time with a
 * pause between them, backs off when the site asks it to slow down, and stops at the first sign
 * that the session is not signed in or is being challenged.
 *
 * The endpoints are the sites' own and undocumented; see site-api.ts. The list and detail shapes
 * are checked at runtime, and an unexpected one ends the run with an "unsupported" error rather
 * than a guess.
 */

export interface ApiSyncParams {
  provider: SiteProvider;
  runId: string;
  /** Conversations updated before this are not wanted. */
  sinceMs: number;
  /** Most conversations to read in one run. */
  max: number;
  scope?: 'recent' | 'all';
  /** Site conversation id → updatedAt already stored in full; those not updated since are skipped. */
  known: Record<string, string>;
  origin: string;
  cookies: string;
  fetchImpl: typeof fetch;
  emit: (event: SyncEvent) => void | Promise<void>;
  isCancelled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
  /** A request (headers and body) that takes longer than this is abandoned and counts as a failure. */
  requestTimeoutMs?: number;
}

/** A site that holds a request open never ends a run: each one is abandoned after this long. */
export const REQUEST_TIMEOUT_MS = 30_000;

interface ListedConversation {
  id: string;
  title: string;
  updatedAt: string | null;
  createdAt: string | null;
}

class SyncFailure extends Error {
  constructor(
    readonly code: SyncErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** Conversations come back without a single message ThreadStack can read: ends the run. */
const FORMAT_CHANGED = new SyncFailure('unsupported', 'conversations hold no messages');

/** Pause between conversation reads: about three quarters of a second, never a burst. */
const PAUSE_MIN_MS = 500;
const PAUSE_SPREAD_MS = 500;
const MAX_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const CHATGPT_PAGE = 28;
/**
 * Listing is cheap (one request per page) and is not what `max` limits: `max` counts the
 * conversations actually read. A run that reaches it says so, and the next run skips what is
 * already stored and up to date, so it continues past them instead of re-reading the same ones.
 */
const LIST_LIMIT = 20_000;
/** The first conversations read all holding no usable message: the conversation shape changed. */
const EMPTY_PROBE = 5;
const CLAUDE_PAGE = 50;

function cookie(cookies: string, name: string): string | null {
  for (const part of cookies.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

type FetchParams = Pick<ApiSyncParams, 'fetchImpl' | 'requestTimeoutMs'>;

/**
 * One GET with a deadline covering the headers and the body. The abort reaches the body too, so a
 * response that starts and then never finishes is abandoned as well. A timeout is a 'network'
 * failure: retried like one, and never mistaken for a challenge page.
 */
async function timedGet(
  p: FetchParams,
  url: string,
  headers: Record<string, string>
): Promise<{ res: Response; read: () => Promise<unknown>; done: () => void } | null> {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const ms = p.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
      reject(new SyncFailure('network', 'timed out'));
    }, ms);
  });
  deadline.catch(() => undefined);
  const done = () => clearTimeout(timer);
  try {
    const res = await Promise.race([
      p.fetchImpl(url, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json', ...headers }, signal: controller?.signal }),
      deadline,
    ]);
    const read = async () => {
      try {
        return await Promise.race([res.json(), deadline]);
      } catch (err) {
        if (timedOut) throw new SyncFailure('network', 'timed out');
        // A 200 that is a challenge page or a changed format, not JSON.
        throw err instanceof SyncFailure ? err : new SyncFailure('blocked', 'not json');
      } finally {
        done();
      }
    };
    return { res, read, done };
  } catch {
    done();
    return null;
  }
}

/**
 * Tell the worker the page is still at work. One request can legitimately take minutes (three
 * attempts of up to 30 s plus the site's own Retry-After), longer than the worker waits for news.
 */
async function heartbeat(p: ApiSyncParams): Promise<void> {
  await p.emit({ kind: 'heartbeat', runId: p.runId, provider: p.provider });
}

/** GET JSON with retry on 429, 5xx and timeouts; maps auth and challenge answers to a stop. */
async function getJson(p: ApiSyncParams, url: string, headers: Record<string, string>): Promise<unknown> {
  let wait = 4000;
  const retry = async (ms: number) => {
    await heartbeat(p);
    await p.sleep(ms);
    wait *= 2;
    await heartbeat(p);
  };
  for (let attempt = 1; ; attempt++) {
    const canRetry = attempt < MAX_ATTEMPTS && !p.isCancelled();
    const got = await timedGet(p, url, headers);
    if (!got) {
      if (canRetry) {
        await retry(wait);
        continue;
      }
      throw new SyncFailure('network', 'network');
    }
    const res = got.res;
    if (res.ok) {
      try {
        return await got.read();
      } catch (err) {
        // A body that stopped arriving is retried like a request that never answered.
        if (err instanceof SyncFailure && err.message === 'timed out' && canRetry) {
          await retry(wait);
          continue;
        }
        throw err;
      }
    }
    got.done();
    if (res.status === 401) throw new SyncFailure('needs_login', 'unauthorized');
    if (res.status === 403) throw new SyncFailure('blocked', 'forbidden');
    if ((res.status === 429 || res.status >= 500) && canRetry) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await retry(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : wait);
      continue;
    }
    throw new SyncFailure(res.status === 429 ? 'rate_limited' : 'network', `HTTP ${res.status}`);
  }
}

// ---------------------------------------------------------------------------
// ChatGPT
// ---------------------------------------------------------------------------

async function chatGptHeaders(p: ApiSyncParams): Promise<Record<string, string>> {
  const session = rec(await getJson(p, `${p.origin}/api/auth/session`, {}));
  const token = typeof session?.accessToken === 'string' ? session.accessToken : null;
  if (!token) throw new SyncFailure('needs_login', 'no access token');
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const device = cookie(p.cookies, 'oai-did');
  if (device) headers['oai-device-id'] = device;
  // Team and Enterprise workspaces select the account with a header; personal accounts send none.
  const account = cookie(p.cookies, '_account');
  if (account && account !== 'personal') headers['ChatGPT-Account-Id'] = account;
  return headers;
}

function parseChatGptList(json: unknown): ListedConversation[] | null {
  const items = rec(json)?.items;
  if (!Array.isArray(items)) return null;
  const out: ListedConversation[] = [];
  for (const raw of items) {
    const item = rec(raw);
    if (!item || typeof item.id !== 'string') continue;
    out.push({
      id: item.id.toLowerCase(),
      title: typeof item.title === 'string' ? item.title : '',
      updatedAt: toIso(item.update_time),
      createdAt: toIso(item.create_time),
    });
  }
  // Entries none of which has an id: the list changed shape, not an empty history.
  return items.length > 0 && out.length === 0 ? null : out;
}

async function listChatGpt(p: ApiSyncParams, headers: Record<string, string>): Promise<ListedConversation[]> {
  const found: ListedConversation[] = [];
  const seen = new Set<string>();
  for (const archived of p.scope === 'all' ? [false, true] : [false]) {
    let stale = 0;
    for (let offset = 0; found.length < LIST_LIMIT && stale < 2; offset += CHATGPT_PAGE) {
      if (p.isCancelled()) break;
      const page = parseChatGptList(
        await getJson(p, `${p.origin}/backend-api/conversations?offset=${offset}&limit=${CHATGPT_PAGE}&order=updated&is_archived=${archived}`, headers)
      );
      if (page === null) throw new SyncFailure('unsupported', 'list shape');
      if (page.length === 0) break;
      const fresh = page.filter((c) => !seen.has(c.id));
      if (fresh.length === 0) throw new SyncFailure('unsupported', 'repeated history page');
      fresh.forEach((c) => seen.add(c.id));
      const recent = fresh.filter((c) => p.scope === 'all' || !c.updatedAt || Date.parse(c.updatedAt) >= p.sinceMs);
      found.push(...recent);
      await p.emit({ kind: 'phase', runId: p.runId, provider: p.provider, phase: 'listing', total: found.length, message: `Found ${found.length} conversations` });
      // Newest first: a page with nothing recent means everything after it is older too.
      stale = recent.length === 0 ? stale + 1 : 0;
      if (page.length < CHATGPT_PAGE) break;
      await p.sleep(PAUSE_MIN_MS);
    }
  }
  return found.slice(0, LIST_LIMIT);
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

async function claudeOrganization(p: ApiSyncParams): Promise<string> {
  const fromCookie = cookie(p.cookies, 'lastActiveOrg');
  if (fromCookie && /^[0-9a-f-]{36}$/i.test(fromCookie)) return fromCookie.toLowerCase();
  const orgs = await getJson(p, `${p.origin}/api/organizations`, {});
  if (!Array.isArray(orgs)) throw new SyncFailure('unsupported', 'organizations shape');
  const rows = orgs.map(rec).filter((o): o is Record<string, unknown> => o !== null && typeof o.uuid === 'string');
  const chat = rows.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes('chat'));
  const uuid = (chat ?? rows[0])?.uuid;
  if (typeof uuid !== 'string') throw new SyncFailure('needs_login', 'no organization');
  return uuid.toLowerCase();
}

function parseClaudeList(json: unknown): ListedConversation[] | null {
  if (!Array.isArray(json)) return null;
  const out: ListedConversation[] = [];
  for (const raw of json) {
    const item = rec(raw);
    if (!item || typeof item.uuid !== 'string') continue;
    out.push({
      id: item.uuid.toLowerCase(),
      title: typeof item.name === 'string' ? item.name : '',
      updatedAt: toIso(item.updated_at),
      createdAt: toIso(item.created_at),
    });
  }
  // Entries none of which has an id: the list changed shape, not an empty history.
  return json.length > 0 && out.length === 0 ? null : out;
}

async function listClaude(p: ApiSyncParams, org: string): Promise<ListedConversation[]> {
  const found: ListedConversation[] = [];
  const seen = new Set<string>();
  let stale = 0;
  // The paged list is the current one; fall back to the original if the site does not know it.
  let base = `${p.origin}/api/organizations/${org}/chat_conversations_v2`;
  let query = (offset: number) => `limit=${CLAUDE_PAGE}&offset=${offset}${p.scope === 'all' ? '' : '&starred=false'}&consistency=eventual`;
  for (let offset = 0; found.length < LIST_LIMIT && stale < 2; offset += CLAUDE_PAGE) {
    if (p.isCancelled()) break;
    let json: unknown;
    try {
      json = await getJson(p, `${base}?${query(offset)}`, {});
    } catch (err) {
      if (offset === 0 && err instanceof SyncFailure && err.code === 'network' && base.endsWith('_v2')) {
        base = `${p.origin}/api/organizations/${org}/chat_conversations`;
        query = (o) => `limit=${CLAUDE_PAGE}&offset=${o}`;
        offset -= CLAUDE_PAGE;
        continue;
      }
      throw err;
    }
    const page = parseClaudeList(rec(json)?.data ?? json);
    if (page === null) throw new SyncFailure('unsupported', 'list shape');
    if (page.length === 0) break;
    const fresh = page.filter((c) => !seen.has(c.id));
    if (fresh.length === 0) throw new SyncFailure('unsupported', 'repeated history page');
    fresh.forEach((c) => seen.add(c.id));
    const recent = fresh.filter((c) => p.scope === 'all' || !c.updatedAt || Date.parse(c.updatedAt) >= p.sinceMs);
    found.push(...recent);
    await p.emit({ kind: 'phase', runId: p.runId, provider: p.provider, phase: 'listing', total: found.length, message: `Found ${found.length} conversations` });
    stale = recent.length === 0 ? stale + 1 : 0;
    if (page.length < CLAUDE_PAGE) break;
    await p.sleep(PAUSE_MIN_MS);
  }
  found.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
  return found.slice(0, LIST_LIMIT);
}

// ---------------------------------------------------------------------------
// Who is signed in
// ---------------------------------------------------------------------------

export type SignedInResult =
  | { status: 'signed_in'; identity: Omit<AccountIdentity, 'observedAt'> }
  | { status: 'signed_out' }
  | { status: 'unknown' };

/**
 * Ask the site who is signed in, with the same requests its own pages make for that
 * (core/accounts/identity.ts lists them and parses the answers strictly). An import files every
 * thread under the account this names, so it is read before anything is listed. Anything the
 * parser does not accept is 'unknown', never a guess, and an import does not run on 'unknown'.
 */
export async function readSignedInIdentity(p: FetchParams & { site: 'chatgpt' | 'claude'; origin: string }): Promise<SignedInResult> {
  if (p.site === 'chatgpt') return readIdentityFrom(p, `${p.origin}/api/auth/session`, 'chatgpt_session');
  // Claude's pages read the account from either request (identity.ts accepts both); the second is
  // asked only when the first does not name a person.
  const first = await readIdentityFrom(p, `${p.origin}/api/account`, 'claude_account');
  return first.status === 'unknown' ? readIdentityFrom(p, `${p.origin}/api/bootstrap`, 'claude_account') : first;
}

async function readIdentityFrom(p: FetchParams & { site: 'chatgpt' | 'claude' }, url: string, source: 'chatgpt_session' | 'claude_account'): Promise<SignedInResult> {
  const got = await timedGet(p, url, {});
  if (!got) return { status: 'unknown' };
  if (got.res.status === 401) {
    got.done();
    return { status: 'signed_out' };
  }
  if (!got.res.ok) {
    got.done();
    return { status: 'unknown' };
  }
  let json: unknown;
  try {
    json = await got.read();
  } catch {
    return { status: 'unknown' };
  }
  const identity = parseIdentity(source, json);
  if (identity) return { status: 'signed_in', identity };
  // ChatGPT answers a signed-out visitor with an empty session object.
  const body = rec(json);
  if (p.site === 'chatgpt' && body && Object.keys(body).length === 0) return { status: 'signed_out' };
  return { status: 'unknown' };
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

function isUpToDate(listed: ListedConversation, known: Record<string, string>): boolean {
  const stored = known[listed.id];
  return Boolean(stored && listed.updatedAt && Date.parse(stored) >= Date.parse(listed.updatedAt));
}

/**
 * List the recent conversations and read each one, reporting through `emit`. Never throws:
 * every outcome is an event, ending in "done" or "error".
 */
export async function runApiSync(p: ApiSyncParams): Promise<void> {
  const base = { runId: p.runId, provider: p.provider } as const;
  const label = p.provider === 'chatgpt' ? 'ChatGPT' : 'Claude';
  const random = p.random ?? Math.random;
  try {
    await p.emit({ kind: 'phase', ...base, phase: 'listing', total: null, message: p.scope === 'all' ? 'Listing all conversations' : 'Listing recent conversations' });
    let listed: ListedConversation[];
    let headers: Record<string, string> = {};
    let org = '';
    if (p.provider === 'chatgpt') {
      headers = await chatGptHeaders(p);
      listed = await listChatGpt(p, headers);
    } else {
      org = await claudeOrganization(p);
      listed = await listClaude(p, org);
    }
    if (p.isCancelled()) {
      await p.emit({ kind: 'done', ...base, listed: listed.length, message: 'Cancelled' });
      return;
    }
    await p.emit({ kind: 'phase', ...base, phase: 'fetching', total: listed.length, message: null });

    let failures = 0;
    let read = 0;
    let empty = 0;
    let truncated = false;
    for (const item of listed) {
      if (p.isCancelled()) break;
      if (isUpToDate(item, p.known)) {
        await p.emit({ kind: 'skipped', ...base, id: item.id, reason: 'up_to_date' });
        continue;
      }
      if (read >= p.max) {
        truncated = true;
        break;
      }
      read += 1;
      try {
        const json =
          p.provider === 'chatgpt'
            ? await getJson(p, `${p.origin}/backend-api/conversation/${item.id}`, headers)
            : await getJson(
                p,
                `${p.origin}/api/organizations/${org}/chat_conversations/${item.id}?tree=True&rendering_mode=messages&render_all_tools=true`,
                {}
              );
        const conv: SiteConversation | null =
          p.provider === 'chatgpt' ? parseChatGptConversation(json, item.id) : parseClaudeConversation(json, item.id);
        if (!conv) throw new SyncFailure('unsupported', 'conversation shape');
        if (conv.messages.length === 0) {
          empty += 1;
          await p.emit({ kind: 'skipped', ...base, id: item.id, reason: 'empty' });
          // Every one of the first few read came back with nothing usable: the format changed,
          // and carrying on would report the whole history as read while storing none of it.
          if (read === EMPTY_PROBE && empty === EMPTY_PROBE) throw FORMAT_CHANGED;
        } else {
          // The list's title and time are the site's current ones; the document may omit them.
          await p.emit({
            kind: 'conversation',
            ...base,
            conversation: { ...conv, title: conv.title || item.title, updatedAt: conv.updatedAt ?? item.updatedAt, createdAt: conv.createdAt ?? item.createdAt },
          });
        }
        failures = 0;
      } catch (err) {
        // Auth, challenge and rate-limit answers end the run; one bad conversation does not.
        if (err instanceof SyncFailure && (err.code === 'needs_login' || err.code === 'blocked' || err.code === 'rate_limited' || err === FORMAT_CHANGED)) throw err;
        failures += 1;
        await p.emit({ kind: 'failed', ...base, id: item.id, message: err instanceof SyncFailure ? err.message : 'Unexpected error' });
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          throw err instanceof SyncFailure ? err : new SyncFailure('unsupported', 'repeated failures');
        }
      }
      await p.sleep(PAUSE_MIN_MS + random() * PAUSE_SPREAD_MS);
    }
    await p.emit({
      kind: 'done',
      ...base,
      listed: listed.length,
      message: p.isCancelled() ? 'Cancelled' : null,
      ...(truncated && !p.isCancelled() ? { truncated: true } : {}),
    });
  } catch (err) {
    const code: SyncErrorCode = err instanceof SyncFailure ? err.code : 'network';
    await p.emit({ kind: 'error', ...base, code, message: describeSyncError(code, label) });
  }
}
