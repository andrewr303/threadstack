import {
  parseChatGptConversation,
  parseClaudeConversation,
  toIso,
  type SiteConversation,
  type SiteProvider,
} from './site-api.js';
import type { SyncErrorCode, SyncEvent } from './history-sync.js';
import { describeSyncError } from './history-sync.js';

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
  /** Site conversation id → updatedAt already stored in full; those not updated since are skipped. */
  known: Record<string, string>;
  origin: string;
  cookies: string;
  fetchImpl: typeof fetch;
  emit: (event: SyncEvent) => void;
  isCancelled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  random?: () => number;
}

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

/** Pause between conversation reads: about three quarters of a second, never a burst. */
const PAUSE_MIN_MS = 500;
const PAUSE_SPREAD_MS = 500;
const MAX_ATTEMPTS = 3;
const MAX_CONSECUTIVE_FAILURES = 3;
const CHATGPT_PAGE = 28;
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

/** GET JSON with retry on 429 and 5xx; maps auth and challenge answers to a stop. */
async function getJson(p: ApiSyncParams, url: string, headers: Record<string, string>): Promise<unknown> {
  let wait = 4000;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await p.fetchImpl(url, { method: 'GET', credentials: 'include', headers: { Accept: 'application/json', ...headers } });
    } catch {
      throw new SyncFailure('network', 'network');
    }
    if (res.ok) {
      try {
        return await res.json();
      } catch {
        // A 200 that is a challenge page or a changed format, not JSON.
        throw new SyncFailure('blocked', 'not json');
      }
    }
    if (res.status === 401) throw new SyncFailure('needs_login', 'unauthorized');
    if (res.status === 403) throw new SyncFailure('blocked', 'forbidden');
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_ATTEMPTS) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await p.sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1000 : wait);
      wait *= 2;
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
    if (item.is_archived === true) continue;
    out.push({
      id: item.id.toLowerCase(),
      title: typeof item.title === 'string' ? item.title : '',
      updatedAt: toIso(item.update_time),
      createdAt: toIso(item.create_time),
    });
  }
  return out;
}

async function listChatGpt(p: ApiSyncParams, headers: Record<string, string>): Promise<ListedConversation[]> {
  const found: ListedConversation[] = [];
  let stale = 0;
  for (let offset = 0; found.length < p.max && stale < 2; offset += CHATGPT_PAGE) {
    if (p.isCancelled()) break;
    const page = parseChatGptList(
      await getJson(p, `${p.origin}/backend-api/conversations?offset=${offset}&limit=${CHATGPT_PAGE}&order=updated&is_archived=false`, headers)
    );
    if (page === null) throw new SyncFailure('unsupported', 'list shape');
    if (page.length === 0) break;
    const recent = page.filter((c) => (c.updatedAt ? Date.parse(c.updatedAt) >= p.sinceMs : true));
    found.push(...recent);
    // Newest first: a page with nothing recent means everything after it is older too.
    stale = recent.length === 0 ? stale + 1 : 0;
    if (page.length < CHATGPT_PAGE) break;
    await p.sleep(PAUSE_MIN_MS);
  }
  return found.slice(0, p.max);
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
  return out;
}

async function listClaude(p: ApiSyncParams, org: string): Promise<ListedConversation[]> {
  const found: ListedConversation[] = [];
  const seen = new Set<string>();
  let stale = 0;
  // The paged list is the current one; fall back to the original if the site does not know it.
  let base = `${p.origin}/api/organizations/${org}/chat_conversations_v2`;
  let query = (offset: number) => `limit=${CLAUDE_PAGE}&offset=${offset}&starred=false&consistency=eventual`;
  for (let offset = 0; found.length < p.max && stale < 2; offset += CLAUDE_PAGE) {
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
    fresh.forEach((c) => seen.add(c.id));
    const recent = fresh.filter((c) => (c.updatedAt ? Date.parse(c.updatedAt) >= p.sinceMs : true));
    found.push(...recent);
    stale = recent.length === 0 ? stale + 1 : 0;
    if (page.length < CLAUDE_PAGE) break;
    await p.sleep(PAUSE_MIN_MS);
  }
  found.sort((a, b) => Date.parse(b.updatedAt ?? '') - Date.parse(a.updatedAt ?? ''));
  return found.slice(0, p.max);
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
    p.emit({ kind: 'phase', ...base, phase: 'listing', total: null, message: 'Listing recent conversations' });
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
      p.emit({ kind: 'done', ...base, listed: listed.length, message: 'Cancelled' });
      return;
    }
    p.emit({ kind: 'phase', ...base, phase: 'fetching', total: listed.length, message: null });

    let failures = 0;
    for (const item of listed) {
      if (p.isCancelled()) break;
      if (isUpToDate(item, p.known)) {
        p.emit({ kind: 'skipped', ...base, id: item.id, reason: 'up_to_date' });
        continue;
      }
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
          p.emit({ kind: 'skipped', ...base, id: item.id, reason: 'empty' });
        } else {
          // The list's title and time are the site's current ones; the document may omit them.
          p.emit({
            kind: 'conversation',
            ...base,
            conversation: { ...conv, title: conv.title || item.title, updatedAt: conv.updatedAt ?? item.updatedAt, createdAt: conv.createdAt ?? item.createdAt },
          });
        }
        failures = 0;
      } catch (err) {
        // Auth, challenge and rate-limit answers end the run; one bad conversation does not.
        if (err instanceof SyncFailure && (err.code === 'needs_login' || err.code === 'blocked' || err.code === 'rate_limited')) throw err;
        failures += 1;
        p.emit({ kind: 'failed', ...base, id: item.id, message: err instanceof SyncFailure ? err.message : 'Unexpected error' });
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          throw err instanceof SyncFailure ? err : new SyncFailure('unsupported', 'repeated failures');
        }
      }
      await p.sleep(PAUSE_MIN_MS + random() * PAUSE_SPREAD_MS);
    }
    p.emit({ kind: 'done', ...base, listed: listed.length, message: p.isCancelled() ? 'Cancelled' : null });
  } catch (err) {
    const code: SyncErrorCode = err instanceof SyncFailure ? err.code : 'network';
    p.emit({ kind: 'error', ...base, code, message: describeSyncError(code, label) });
  }
}
