import 'fake-indexeddb/auto';
import { describe, expect, it, vi } from 'vitest';
import {
  SYNC_PROVIDERS,
  clampSyncDays,
  describeSyncError,
  syncCutoffMs,
  validateSyncEvent,
  type SyncEvent,
  type SyncProviderId,
} from '../../src/core/history-sync.js';
import { runApiSync, type ApiSyncParams } from '../../src/core/site-history.js';
import { loadSidebarConversations, readSidebarConversations } from '../../src/core/sidebar-history.js';
import { HistorySyncOrchestrator, SYNC_IDLE_TIMEOUT_MS, type SyncEnv } from '../../src/core/sync-orchestrator.js';
import { validateSiteConversation, type SiteConversation } from '../../src/core/site-api.js';
import { ThreadStackDB } from '../../src/core/db.js';
import { DEFAULT_SETTINGS, type ConversationRecord } from '../../src/core/schema.js';
import { createChromeSyncEnv } from '../../src/core/sync-env.js';

const DAY = 86_400_000;
const NOW = Date.parse('2026-11-03T12:00:00Z');
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

// ---------------------------------------------------------------------------
// A fake ChatGPT / Claude
// ---------------------------------------------------------------------------

interface FakeSite {
  fetchImpl: typeof fetch;
  calls: string[];
  failWith?: (url: string, n: number) => Response | null;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

function chatGptConversationJson(n: number) {
  return {
    conversation_id: id(n),
    title: `Chat ${n}`,
    create_time: (NOW - 3 * DAY) / 1000,
    update_time: (NOW - n * DAY) / 1000,
    current_node: 'a',
    mapping: {
      r: { id: 'r', parent: null, children: ['u'], message: null },
      u: { id: 'u', parent: 'r', children: ['a'], message: { id: `u${n}`, author: { role: 'user' }, create_time: 1, recipient: 'all', content: { content_type: 'text', parts: [`Question ${n}`] }, metadata: {} } },
      a: { id: 'a', parent: 'u', children: [], message: { id: `a${n}`, author: { role: 'assistant' }, create_time: 2, recipient: 'all', content: { content_type: 'text', parts: [`Answer ${n}`] }, metadata: { model_slug: 'gpt-5' } } },
    },
  };
}

function fakeChatGpt(daysAgoByIndex: number[], opts: { unauthorized?: boolean } = {}): FakeSite {
  const calls: string[] = [];
  const site: FakeSite = {
    calls,
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = String(input);
      calls.push(url);
      const injected = site.failWith?.(url, calls.length);
      if (injected) return injected;
      if (url.endsWith('/api/auth/session')) return opts.unauthorized ? json({}) : json({ accessToken: 'tok' });
      const list = url.match(/\/backend-api\/conversations\?offset=(\d+)&limit=(\d+)/);
      if (list) {
        if (new URL(url).searchParams.get('is_archived') === 'true') return json({ items: [] });
        const offset = Number(list[1]);
        const limit = Number(list[2]);
        const items = daysAgoByIndex.slice(offset, offset + limit).map((d, i) => ({
          id: id(offset + i + 1),
          title: `Chat ${offset + i + 1}`,
          create_time: iso(d + 1),
          update_time: iso(d),
        }));
        return json({ items, total: daysAgoByIndex.length, limit, offset });
      }
      const detail = url.match(/\/backend-api\/conversation\/([0-9a-f-]{36})$/);
      if (detail) return json(chatGptConversationJson(Number(detail[1].slice(-12))));
      return json({}, 404);
    }) as typeof fetch,
  };
  return site;
}

function params(site: FakeSite, patch: Partial<ApiSyncParams> = {}) {
  const events: SyncEvent[] = [];
  const p: ApiSyncParams = {
    provider: 'chatgpt',
    runId: 'run_test_1',
    sinceMs: NOW - 30 * DAY,
    max: 300,
    known: {},
    origin: 'https://chatgpt.com',
    cookies: 'oai-did=device-1; _account=personal',
    fetchImpl: site.fetchImpl,
    emit: (e) => { events.push(e); },
    isCancelled: () => false,
    sleep: async () => undefined,
    random: () => 0,
    ...patch,
  };
  return { p, events };
}

describe('ChatGPT history sync', () => {
  it('waits for a conversation to be stored before reporting completion', async () => {
    const site = fakeChatGpt([1]);
    let release!: () => void;
    const stored = new Promise<void>((resolve) => { release = resolve; });
    let receiptStarted!: () => void;
    const started = new Promise<void>((resolve) => { receiptStarted = resolve; });
    let done = false;
    const { p } = params(site, { emit: async (event) => {
      if (event.kind === 'conversation') { receiptStarted(); await stored; }
      if (event.kind === 'done') done = true;
    } });
    const run = runApiSync(p);
    await started;
    await new Promise((resolve) => setTimeout(resolve, 0));
    try { expect(done).toBe(false); }
    finally { release(); await run; }
    expect(done).toBe(true);
  });
  it('imports more than 500 old chats across every page, including archived chats, and resumes by skipping stored copies', async () => {
    const site = fakeChatGpt(Array.from({ length: 620 }, (_, i) => i + 100));
    site.failWith = (url) => {
      if (url.includes('/conversations?') && url.includes('is_archived=true')) {
        return json({ items: [{ id: id(999), title: 'Archived', update_time: iso(999), is_archived: true }] });
      }
      return null;
    };
    const { p, events } = params(site, { scope: 'all', sinceMs: 0, max: Number.MAX_SAFE_INTEGER, known: { [id(1)]: iso(0) } });
    await runApiSync(p);
    expect(events.filter((e) => e.kind === 'conversation')).toHaveLength(620);
    expect(events.filter((e) => e.kind === 'skipped')).toEqual([expect.objectContaining({ id: id(1), reason: 'up_to_date' })]);
    expect(events.at(-1)).toMatchObject({ kind: 'done', listed: 621 });
    expect(site.calls.some((u) => u.endsWith(`/conversation/${id(620)}`))).toBe(true);
    expect(site.calls.some((u) => u.endsWith(`/conversation/${id(999)}`))).toBe(true);
    expect(site.calls.some((u) => u.endsWith(`/conversation/${id(1)}`))).toBe(false);
  });

  it('reports a repeated full page as incomplete instead of looping or claiming all history was read', async () => {
    const site = fakeChatGpt([]);
    site.failWith = (url) => url.includes('/conversations?') ? json({ items: Array.from({ length: 28 }, (_, i) => ({ id: id(i + 1), update_time: iso(1) })) }) : null;
    const { p, events } = params(site, { scope: 'all', sinceMs: 0, max: Number.MAX_SAFE_INTEGER });
    await runApiSync(p);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'unsupported' });
    expect(site.calls.filter((u) => u.includes('/conversations?'))).toHaveLength(2);
  });
  it('reads every conversation in the window, newest first, and nothing older', async () => {
    // 5 conversations: 1, 2, 10, 29 days old (in the window) and 45 days old (out of it).
    const site = fakeChatGpt([1, 2, 10, 29, 45]);
    const { p, events } = params(site);
    await runApiSync(p);
    const convs = events.filter((e): e is Extract<SyncEvent, { kind: 'conversation' }> => e.kind === 'conversation');
    expect(convs.map((e) => e.conversation.title)).toEqual(['Chat 1', 'Chat 2', 'Chat 3', 'Chat 4']);
    expect(convs[0].conversation.messages.map((m) => m.content)).toEqual(['Question 1', 'Answer 1']);
    expect(events.at(-1)).toMatchObject({ kind: 'done', listed: 4 });
    // The 45-day-old conversation was never fetched.
    expect(site.calls.some((u) => u.endsWith(id(5)))).toBe(false);
  });

  it('only sends GET requests with the session cookie, the bearer token and the device id', async () => {
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const site = fakeChatGpt([1]);
    const inner = site.fetchImpl;
    const { p } = params(site, {
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        seen.push({ url: String(input), init });
        return inner(input, init);
      }) as typeof fetch,
    });
    await runApiSync(p);
    expect(seen.every((s) => s.init?.method === 'GET' && s.init.credentials === 'include')).toBe(true);
    const detail = seen.find((s) => /backend-api\/conversation\//.test(s.url))!;
    expect(detail.init?.headers).toMatchObject({ Authorization: 'Bearer tok', 'oai-device-id': 'device-1' });
    expect((detail.init?.headers as Record<string, string>)['ChatGPT-Account-Id']).toBeUndefined();
  });

  it('selects a workspace account only when the account cookie names one', async () => {
    const seen: Array<Record<string, string>> = [];
    const site = fakeChatGpt([1]);
    const inner = site.fetchImpl;
    const { p } = params(site, {
      cookies: '_account=acct-team-9',
      fetchImpl: ((input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(init?.headers as Record<string, string>);
        return inner(input, init);
      }) as typeof fetch,
    });
    await runApiSync(p);
    expect(seen.at(-1)?.['ChatGPT-Account-Id']).toBe('acct-team-9');
  });

  it('skips conversations already stored in full and unchanged, and reads changed ones', async () => {
    const site = fakeChatGpt([1, 2, 3]);
    const { p, events } = params(site, { known: { [id(1)]: iso(1), [id(2)]: iso(5) } }); // #1 unchanged; #2 updated since; #3 unknown
    await runApiSync(p);
    expect(events.filter((e) => e.kind === 'skipped').map((e) => (e as { id: string }).id)).toEqual([id(1)]);
    expect(events.filter((e) => e.kind === 'conversation')).toHaveLength(2);
    expect(site.calls.some((u) => u.endsWith(`/conversation/${id(1)}`))).toBe(false);
  });

  it('pauses between conversations and never runs them in parallel', async () => {
    const site = fakeChatGpt([1, 2, 3]);
    const sleeps: number[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const inner = site.fetchImpl;
    const { p } = params(site, {
      sleep: async (ms) => void sleeps.push(ms),
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const r = await inner(input, init);
        inFlight -= 1;
        return r;
      }) as typeof fetch,
    });
    await runApiSync(p);
    expect(maxInFlight).toBe(1);
    expect(sleeps.filter((ms) => ms >= 500).length).toBeGreaterThanOrEqual(3);
  });

  it('stops at the cap', async () => {
    const site = fakeChatGpt(Array.from({ length: 60 }, (_, i) => i / 3));
    const { p, events } = params(site, { max: 5 });
    await runApiSync(p);
    expect(events.filter((e) => e.kind === 'conversation')).toHaveLength(5);
  });

  it('stops when cancelled and says so', async () => {
    const site = fakeChatGpt([1, 2, 3, 4]);
    let n = 0;
    const { p, events } = params(site, { isCancelled: () => n++ > 3 });
    await runApiSync(p);
    expect(events.filter((e) => e.kind === 'conversation').length).toBeLessThan(4);
    expect(events.at(-1)).toMatchObject({ kind: 'done', message: 'Cancelled' });
  });

  it('reports a signed-out session instead of failing quietly', async () => {
    const { p, events } = params(fakeChatGpt([1], { unauthorized: true }));
    await runApiSync(p);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'needs_login' });
    expect(events.some((e) => e.kind === 'conversation')).toBe(false);
  });

  it('treats a 403 or a non-JSON answer as a block to resolve by hand, and does not keep asking', async () => {
    const site = fakeChatGpt([1, 2, 3]);
    site.failWith = (url) => (url.includes('/backend-api/conversation/') ? new Response('<html>Just a moment…</html>', { status: 403 }) : null);
    const { p, events } = params(site);
    await runApiSync(p);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'blocked' });
    expect(site.calls.filter((u) => u.includes('/backend-api/conversation/'))).toHaveLength(1);
  });

  it('retries a 429 with the server\'s wait, then gives up with a rate-limit error', async () => {
    const site = fakeChatGpt([1]);
    site.failWith = (url) => (url.includes('/backend-api/conversation/') ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : null);
    const sleeps: number[] = [];
    const { p, events } = params(site, { sleep: async (ms) => void sleeps.push(ms) });
    await runApiSync(p);
    expect(sleeps).toContain(7000);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'rate_limited' });
  });

  it('retries a transient 500 and recovers', async () => {
    const site = fakeChatGpt([1]);
    let failed = false;
    site.failWith = (url) => {
      if (url.includes('/backend-api/conversation/') && !failed) {
        failed = true;
        return new Response('oops', { status: 500 });
      }
      return null;
    };
    const { p, events } = params(site);
    await runApiSync(p);
    expect(events.filter((e) => e.kind === 'conversation')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ kind: 'done' });
  });

  it('survives one malformed conversation but stops after three in a row', async () => {
    const site = fakeChatGpt([1, 2, 3, 4, 5]);
    const inner = site.fetchImpl;
    let bad = 0;
    const { p, events } = params(site, {
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/backend-api/conversation/') && Number(url.slice(-12)) <= 4) {
          bad += 1;
          return json({ nope: true });
        }
        return inner(input, init);
      }) as typeof fetch,
    });
    await runApiSync(p);
    expect(bad).toBe(3);
    expect(events.filter((e) => e.kind === 'failed')).toHaveLength(3);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'unsupported' });
  });

  it('flags an unexpected list format as unsupported', async () => {
    const site = fakeChatGpt([1]);
    site.failWith = (url) => (url.includes('/backend-api/conversations?') ? json({ nothing: [] }) : null);
    const { p, events } = params(site);
    await runApiSync(p);
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'unsupported' });
  });
});

describe('Claude history sync', () => {
  const ORG = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const claudeJson = (n: number) => ({
    uuid: id(n),
    name: `Claude chat ${n}`,
    created_at: iso(n + 1),
    updated_at: iso(n),
    current_leaf_message_uuid: `m${n}b`,
    chat_messages: [
      { uuid: `m${n}a`, sender: 'human', index: 0, parent_message_uuid: '00000000-0000-4000-8000-000000000000', content: [{ type: 'text', text: `Ask ${n}` }] },
      { uuid: `m${n}b`, sender: 'assistant', index: 1, parent_message_uuid: `m${n}a`, content: [{ type: 'text', text: `Reply ${n}` }] },
    ],
  });
  const site = (daysAgo: number[], v2 = true): FakeSite => {
    const calls: string[] = [];
    return {
      calls,
      fetchImpl: (async (input: RequestInfo | URL) => {
        const url = String(input);
        calls.push(url);
        if (url.includes('/chat_conversations_v2?') && !v2) return json({}, 404);
        const list = url.match(/chat_conversations(?:_v2)?\?limit=(\d+)&offset=(\d+)/);
        if (list) {
          const offset = Number(list[2]);
          return json(daysAgo.slice(offset, offset + Number(list[1])).map((d, i) => ({ uuid: id(offset + i + 1), name: `Claude chat ${offset + i + 1}`, created_at: iso(d + 1), updated_at: iso(d) })));
        }
        const detail = url.match(/chat_conversations\/([0-9a-f-]{36})\?/);
        if (detail) return json(claudeJson(Number(detail[1].slice(-12))));
        if (url.endsWith('/api/organizations')) return json([{ uuid: ORG, capabilities: ['chat'] }]);
        return json({}, 404);
      }) as typeof fetch,
    };
  };
  const run = (s: FakeSite, patch: Partial<ApiSyncParams> = {}) => params(s, { provider: 'claude', origin: 'https://claude.ai', cookies: `lastActiveOrg=${ORG}`, ...patch });

  it('reads all old history beyond the recent-run and content-script caps without filtering starred chats', async () => {
    const s = site(Array.from({ length: 550 }, (_, i) => i + 100));
    const { p, events } = run(s, { scope: 'all', sinceMs: 0, max: Number.MAX_SAFE_INTEGER });
    await runApiSync(p);
    expect(events.filter((e) => e.kind === 'conversation')).toHaveLength(550);
    expect(events.at(-1)).toMatchObject({ kind: 'done', listed: 550 });
    expect(s.calls.filter((u) => u.includes('/chat_conversations_v2?')).every((u) => !u.includes('starred=false'))).toBe(true);
  });

  it('uses the active organization, the paged list, and reads the active branch of each chat', async () => {
    const s = site([1, 3, 50]);
    const { p, events } = run(s);
    await runApiSync(p);
    expect(s.calls[0]).toContain(`/api/organizations/${ORG}/chat_conversations_v2?`);
    const convs = events.filter((e): e is Extract<SyncEvent, { kind: 'conversation' }> => e.kind === 'conversation');
    expect(convs.map((e) => e.conversation.title)).toEqual(['Claude chat 1', 'Claude chat 2']);
    expect(convs[0].conversation.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(s.calls.some((u) => u.includes('tree=True') && u.includes('rendering_mode=messages'))).toBe(true);
  });

  it('falls back to the original list endpoint, and finds the organization when there is no cookie', async () => {
    const s = site([1], false);
    const { p, events } = run(s, { cookies: '' });
    await runApiSync(p);
    expect(s.calls.some((u) => u.endsWith('/api/organizations'))).toBe(true);
    expect(s.calls.some((u) => /chat_conversations\?limit=/.test(u))).toBe(true);
    expect(events.filter((e) => e.kind === 'conversation')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('sync helpers', () => {
  it('only skips full authoritative copies in the currently bound account and workspace', async () => {
    const db = new ThreadStackDB('history-resume-account-test');
    const bound = DEFAULT_SETTINGS.boundAccounts.chatgpt;
    try {
      await db.conversations.bulkPut([
        { threadKey: 'mine', provider: 'chatgpt', sourceConversationId: id(1), accountId: bound.accountId, workspaceId: bound.workspaceId, branchId: 'main', coverage: 'full', captureSource: 'history_sync', updatedAt: iso(1) },
        { threadKey: 'other-account', provider: 'chatgpt', sourceConversationId: id(2), accountId: 'other', workspaceId: bound.workspaceId, branchId: 'main', coverage: 'full', captureSource: 'history_sync', updatedAt: iso(1) },
        { threadKey: 'other-workspace', provider: 'chatgpt', sourceConversationId: id(3), accountId: bound.accountId, workspaceId: 'other', branchId: 'main', coverage: 'full', captureSource: 'history_sync', updatedAt: iso(1) },
        { threadKey: 'partial', provider: 'chatgpt', sourceConversationId: id(4), accountId: bound.accountId, workspaceId: bound.workspaceId, branchId: 'main', coverage: 'partial', captureSource: 'history_sync', updatedAt: iso(1) },
      ] as ConversationRecord[]);
      const env = createChromeSyncEnv(db, { loadSettings: async () => DEFAULT_SETTINGS, storeConversation: async () => 'stored' });
      expect(await env.knownUpdatedAt('chatgpt')).toEqual({ [id(1)]: iso(1) });
    } finally {
      await db.delete();
    }
  });
  it('clamps the window to 1 to 31 days and computes the cutoff', () => {
    expect(clampSyncDays(30)).toBe(30);
    expect(clampSyncDays(0)).toBe(1);
    expect(clampSyncDays(400)).toBe(31);
    expect(clampSyncDays('x')).toBe(30);
    expect(syncCutoffMs(30, NOW)).toBe(NOW - 30 * DAY);
  });

  it('rebuilds events from untrusted input and rejects the rest', () => {
    expect(validateSyncEvent({ kind: 'done', runId: 'run_abcd', provider: 'chatgpt', listed: 4 })).toMatchObject({ kind: 'done', listed: 4 });
    expect(validateSyncEvent({ kind: 'done', runId: 'x', provider: 'chatgpt' })).toBeNull(); // run id too short
    expect(validateSyncEvent({ kind: 'done', runId: 'run_abcd', provider: 'imported' })).toBeNull();
    expect(validateSyncEvent({ kind: 'error', runId: 'run_abcd', provider: 'claude', code: 'format_disk', message: 'x' })).toBeNull();
    expect(validateSyncEvent({ kind: 'explode', runId: 'run_abcd', provider: 'claude' })).toBeNull();
    expect(validateSyncEvent('nope')).toBeNull();
    const conv = {
      provider: 'chatgpt',
      sourceConversationId: id(1),
      title: 'T',
      messages: [{ sourceMessageId: 'm1', role: 'user', content: 'hi', createdAt: null }],
    };
    expect(validateSyncEvent({ kind: 'conversation', runId: 'run_abcd', provider: 'chatgpt', conversation: conv })).toMatchObject({ kind: 'conversation' });
    // A conversation of another site than the event claims, or with a forged role, is dropped.
    expect(validateSyncEvent({ kind: 'conversation', runId: 'run_abcd', provider: 'claude', conversation: conv })).toBeNull();
    expect(validateSiteConversation({ ...conv, messages: [{ sourceMessageId: 'm1', role: 'system', content: 'hi' }] })).toBeNull();
    expect(validateSiteConversation({ ...conv, sourceConversationId: '../x' })).toBeNull();
  });

  it('every site has a plain-language failure for every error', () => {
    for (const code of ['needs_login', 'blocked', 'rate_limited', 'unsupported', 'network', 'no_conversations', 'timeout'] as const) {
      expect(describeSyncError(code, 'ChatGPT')).toMatch(/ChatGPT/);
    }
    expect(SYNC_PROVIDERS.filter((p) => p.strategy === 'api').map((p) => p.id)).toEqual(['chatgpt', 'claude']);
  });
});

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

describe('sidebar history', () => {
  const doc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');

  it('finds conversation links of the provider only, newest first, without duplicates or routes', () => {
    const d = doc(`<nav>
      <a href="/app">Home</a>
      <a href="/app/c1111111">First chat</a>
      <a href="https://gemini.google.com/app/c2222222?hl=en"><span>Second</span> chat</a>
      <a href="/app/c1111111">First chat again</a>
      <a href="https://evil.example/app/c3333333">Elsewhere</a>
      <a href="/gem/abc/def456">A gem chat</a>
    </nav>`);
    const items = readSidebarConversations(d, 'https://gemini.google.com/app', 'gemini');
    expect(items.map((i) => [i.id, i.title])).toEqual([
      ['c1111111', 'First chat'],
      ['c2222222', 'Second chat'],
      ['def456', 'A gem chat'],
    ]);
    expect(items[1].url).toBe('https://gemini.google.com/app/c2222222?hl=en');
    expect(readSidebarConversations(d, 'https://gemini.google.com/app', 'gemini', 1)).toHaveLength(1);
  });

  it('scrolls the sidebar container to load more, stops when nothing new arrives, and puts it back', async () => {
    const d = doc(`<div id="scroller" style="overflow-y:auto"><a href="/chat/aaaa1111">A</a></div>`);
    const scroller = d.getElementById('scroller')!;
    const win = { location: { href: 'https://chat.mistral.ai/chat' }, getComputedStyle: () => ({ overflowY: 'auto' }) } as unknown as Window;
    Object.defineProperty(scroller, 'scrollHeight', { value: 1000 });
    Object.defineProperty(scroller, 'clientHeight', { value: 100 });
    let loaded = 1;
    let tops = 0;
    scroller.scrollTop = 0;
    Object.defineProperty(scroller, 'scrollTop', {
      configurable: true,
      get: () => tops,
      set: (v: number) => {
        tops = v;
        if (v > 0 && loaded < 4) {
          loaded += 1;
          scroller.insertAdjacentHTML('beforeend', `<a href="/chat/bbbb${loaded}${loaded}${loaded}${loaded}">B${loaded}</a>`);
        }
      },
    });
    const items = await loadSidebarConversations(d, win, 'mistral', { limit: 30, sleep: async () => undefined });
    expect(items).toHaveLength(4);
    expect(tops).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

function fakeEnv(opts: {
  tabs?: Partial<Record<SyncProviderId, number>>;
  ready?: boolean;
  reader?: boolean;
  enabled?: SyncProviderId[];
  sidebar?: Partial<Record<SyncProviderId, Array<{ id: string; url: string; title: string }>>>;
  recent?: Set<string>;
}) {
  let clock = NOW;
  const log: string[] = [];
  const stored: SiteConversation[] = [];
  const saved: Array<{ running: boolean; providers: Array<{ provider: string; status: string; stored: number }> }> = [];
  let nextTab = 100;
  const sent: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  const handlers: { orch?: HistorySyncOrchestrator; onSend?: (tabId: number, message: Record<string, unknown>) => void } = {};
  const closed: number[] = [];
  const env: SyncEnv = {
    now: () => clock,
    newRunId: () => 'sync_run_0001',
    sleep: async (ms) => void (clock += ms),
    timeout: (ms) => {
      let cancelled = false;
      return { promise: new Promise<void>((resolve) => setTimeout(() => !cancelled && resolve(), Math.min(ms, 20))), cancel: () => void (cancelled = true) };
    },
    findTab: async (info) => opts.tabs?.[info.id] ?? null,
    openTab: async (url) => {
      const tabId = nextTab++;
      log.push(`open ${url}`);
      return tabId;
    },
    closeTab: async (tabId) => void closed.push(tabId),
    waitTabReady: async () => opts.ready ?? true,
    ensureContentScript: async () => opts.reader ?? true,
    sendToTab: async (tabId, message) => {
      const m = message as Record<string, unknown>;
      sent.push({ tabId, message: m });
      handlers.onSend?.(tabId, m);
      if (m.type === 'TK_HISTORY_LIST_SIDEBAR') return { ok: true, items: opts.sidebar?.[m.provider as SyncProviderId] ?? [] };
      return { ok: true };
    },
    enabledProviders: async () => new Set(opts.enabled ?? ['chatgpt', 'claude', 'gemini']),
    knownUpdatedAt: async () => ({}),
    storeConversation: async (c) => {
      stored.push(c);
      return 'stored';
    },
    hasRecentCapture: async (_p, cid) => opts.recent?.has(cid) ?? false,
    saveState: async (state) => void saved.push(JSON.parse(JSON.stringify(state))),
  };
  return { env, log, stored, saved, sent, handlers, closed };
}

const conv = (n: number, provider: 'chatgpt' | 'claude' = 'chatgpt'): SiteConversation => ({
  provider,
  sourceConversationId: id(n),
  canonicalUrl: `https://chatgpt.com/c/${id(n)}`,
  title: `Chat ${n}`,
  createdAt: null,
  updatedAt: iso(1),
  messages: [{ sourceMessageId: `m${n}`, role: 'user', content: `Hello ${n}`, createdAt: null, branchPath: 'main' }],
  modelSlug: null,
  providerProjectId: null,
});

describe('Catch up orchestration', () => {
  it('passes all-history scope and no recent cutoff or cap through to the reader, excluding sidebar-only sites', async () => {
    const f = fakeEnv({ tabs: { chatgpt: 7 } });
    const orch = new HistorySyncOrchestrator(f.env);
    f.handlers.onSend = (tabId, message) => {
      if (message.type === 'TK_HISTORY_SYNC_RUN') void orch.handleEvent({ kind: 'done', runId: message.runId as string, provider: 'chatgpt', listed: 0, message: null }, tabId);
    };
    await orch.start({ providers: ['chatgpt', 'gemini'], days: 30, scope: 'all' });
    await orch.idle();
    expect(f.sent[0].message).toMatchObject({ scope: 'all', sinceMs: 0, max: Number.MAX_SAFE_INTEGER });
    expect(orch.state.scope).toBe('all');
    expect(orch.state.providers.map((p) => p.provider)).toEqual(['chatgpt']);
  });

  it('reports a rejected reader start immediately instead of waiting for the idle timeout', async () => {
    const f = fakeEnv({ tabs: { chatgpt: 7 } });
    f.env.sendToTab = async () => ({ ok: false, error: 'busy' });
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['chatgpt'], days: 30, scope: 'all' });
    await orch.idle();
    expect(orch.state.providers[0].status).toBe('error');
  });
  it('runs the page-side reader in the user\'s open tab, stores what it reports, and ends with a summary', async () => {
    const f = fakeEnv({ tabs: { chatgpt: 7 } });
    const orch = new HistorySyncOrchestrator(f.env);
    // When the reader is started, it reports two conversations, one skip and one failure, then finishes.
    f.handlers.onSend = (tabId, message) => {
      if (message.type !== 'TK_HISTORY_SYNC_RUN') return;
      const base = { runId: message.runId as string, provider: 'chatgpt' as const };
      void (async () => {
        await orch.handleEvent({ kind: 'phase', ...base, phase: 'fetching', total: 4, message: null }, tabId);
        await orch.handleEvent({ kind: 'conversation', ...base, conversation: conv(1) }, tabId);
        await orch.handleEvent({ kind: 'conversation', ...base, conversation: conv(2) }, tabId);
        await orch.handleEvent({ kind: 'skipped', ...base, id: id(3), reason: 'up_to_date' }, tabId);
        await orch.handleEvent({ kind: 'failed', ...base, id: id(4), message: 'x' }, tabId);
        await orch.handleEvent({ kind: 'done', ...base, listed: 4, message: null }, tabId);
      })();
    };
    expect(await orch.start({ providers: ['chatgpt'], days: 30 })).toEqual({ started: true });
    await orch.idle();
    expect(orch.state.running).toBe(false);
    expect(orch.state.providers[0]).toMatchObject({ provider: 'chatgpt', status: 'done', listed: 4, stored: 2, skipped: 1, failed: 1 });
    expect(f.stored.map((c) => c.title)).toEqual(['Chat 1', 'Chat 2']);
    expect(f.log).toEqual([]); // used the open tab, opened none
    expect(f.closed).toEqual([]); // and did not close the user's tab
    expect(f.sent[0].message).toMatchObject({ type: 'TK_HISTORY_SYNC_RUN', provider: 'chatgpt', max: 300 });
    expect(f.saved.at(-1)?.running).toBe(false);
  });

  it('opens a background tab when none is open, and closes it afterwards', async () => {
    const f = fakeEnv({});
    const orch = new HistorySyncOrchestrator(f.env);
    f.handlers.onSend = (tabId, message) => {
      if (message.type === 'TK_HISTORY_SYNC_RUN') void orch.handleEvent({ kind: 'done', runId: message.runId as string, provider: 'chatgpt', listed: 0, message: null }, tabId);
    };
    await orch.start({ providers: ['chatgpt'], days: 7 });
    await orch.idle();
    expect(f.log).toEqual(['open https://chatgpt.com/']);
    expect(f.closed).toEqual([100]);
  });

  it('ignores events from another tab, another run or another site', async () => {
    const f = fakeEnv({ tabs: { chatgpt: 7 } });
    const orch = new HistorySyncOrchestrator(f.env);
    f.handlers.onSend = (tabId, message) => {
      if (message.type !== 'TK_HISTORY_SYNC_RUN') return;
      void (async () => {
        const base = { runId: message.runId as string, provider: 'chatgpt' as const };
        await orch.handleEvent({ kind: 'conversation', ...base, conversation: conv(1) }, 999); // wrong tab
        await orch.handleEvent({ kind: 'conversation', runId: 'other_run_1', provider: 'chatgpt', conversation: conv(2) }, tabId); // wrong run
        await orch.handleEvent({ kind: 'conversation', runId: base.runId, provider: 'claude', conversation: conv(3, 'claude') }, tabId); // wrong site
        await orch.handleEvent({ kind: 'done', ...base, listed: 0, message: null }, tabId);
      })();
    };
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    expect(f.stored).toHaveLength(0);
  });

  it('explains a signed-out site instead of hanging', async () => {
    const f = fakeEnv({ reader: false });
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    expect(orch.state.providers[0].status).toBe('error');
    expect(orch.state.providers[0].message).toMatch(/Sign in to ChatGPT/);
    expect(f.closed).toEqual([100]); // the tab it opened is closed
  });

  it('turns a reader that goes silent into a timeout, keeping what it stored', async () => {
    const f = fakeEnv({ tabs: { claude: 5 }, enabled: ['claude'] });
    const orch = new HistorySyncOrchestrator(f.env);
    f.handlers.onSend = (tabId, message) => {
      if (message.type === 'TK_HISTORY_SYNC_RUN') {
        void orch.handleEvent({ kind: 'conversation', runId: message.runId as string, provider: 'claude', conversation: conv(1, 'claude') }, tabId);
      }
    };
    // Time passes while the reader says nothing.
    const realSleep = f.env.sleep;
    f.env.timeout = (ms) => ({ promise: Promise.resolve().then(() => void realSleep(SYNC_IDLE_TIMEOUT_MS + ms)), cancel: () => undefined });
    await orch.start({ providers: ['claude'], days: 30 });
    await orch.idle();
    expect(orch.state.providers[0].status).toBe('error');
    expect(orch.state.providers[0].message).toMatch(/stopped answering/);
    expect(orch.state.providers[0].stored).toBe(1);
    expect(f.sent.some((s) => s.message.type === 'TK_HISTORY_SYNC_CANCEL')).toBe(true);
  });

  it('refuses a second run, sites whose capture is off, and an empty request', async () => {
    const f = fakeEnv({ tabs: { chatgpt: 1 }, enabled: ['chatgpt'] });
    const orch = new HistorySyncOrchestrator(f.env);
    expect(await orch.start({ providers: ['claude'], days: 30 })).toMatchObject({ started: false });
    expect(await orch.start({ providers: [], days: 30 })).toMatchObject({ started: false });
    await orch.start({ providers: ['chatgpt'], days: 30 });
    expect(await orch.start({ providers: ['chatgpt'], days: 30 })).toMatchObject({ started: false, reason: expect.stringMatching(/already running/) });
    orch.cancel();
    await orch.idle();
  });

  it('opens each sidebar conversation in its own background tab and counts it once capture stores it', async () => {
    const items = [1, 2, 3].map((n) => ({ id: `chat${n}0000`, url: `https://gemini.google.com/app/chat${n}0000`, title: `G${n}` }));
    const f = fakeEnv({ tabs: { gemini: 9 }, sidebar: { gemini: items }, recent: new Set(['chat20000']) });
    const orch = new HistorySyncOrchestrator(f.env);
    // Each opened tab is "captured" by the normal path: here, as soon as a nudge arrives.
    f.handlers.onSend = (tabId, message) => {
      if (message.type === 'TK_CAPTURE_NOW') {
        const item = items.find((i) => f.log.at(-1)?.endsWith(i.url));
        if (item) setTimeout(() => orch.noteCapture(tabId, item.id, 4), 0);
      }
    };
    await orch.start({ providers: ['gemini'], days: 30 });
    await orch.idle();
    expect(orch.state.providers[0]).toMatchObject({ status: 'done', listed: 3, stored: 2, skipped: 1, failed: 0 });
    expect(f.log).toEqual(['open https://gemini.google.com/app/chat10000', 'open https://gemini.google.com/app/chat30000']);
    expect(f.closed).toEqual([100, 101]);
  });

  it('does not count an early capture with no messages as the conversation', async () => {
    const items = [{ id: 'chat10000', url: 'https://gemini.google.com/app/chat10000', title: 'G1' }];
    const f = fakeEnv({ tabs: { gemini: 9 }, sidebar: { gemini: items } });
    const orch = new HistorySyncOrchestrator(f.env);
    f.handlers.onSend = (tabId, message) => {
      if (message.type === 'TK_CAPTURE_NOW') {
        setTimeout(() => orch.noteCapture(tabId, 'chat10000', 0), 0); // page still loading
      }
    };
    await orch.start({ providers: ['gemini'], days: 30 });
    await orch.idle();
    expect(orch.state.providers[0]).toMatchObject({ stored: 0, failed: 1 });
  });

  it('reports an empty sidebar plainly', async () => {
    const f = fakeEnv({ tabs: { gemini: 9 }, sidebar: { gemini: [] } });
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['gemini'], days: 30 });
    await orch.idle();
    expect(orch.state.providers[0]).toMatchObject({ status: 'error' });
    expect(orch.state.providers[0].message).toMatch(/No conversations found/);
  });

  it('runs the complete-history sites before the tab-by-tab ones', async () => {
    const f = fakeEnv({ tabs: { gemini: 1, chatgpt: 2 }, sidebar: { gemini: [] } });
    const orch = new HistorySyncOrchestrator(f.env);
    f.handlers.onSend = (tabId, message) => {
      if (message.type === 'TK_HISTORY_SYNC_RUN') void orch.handleEvent({ kind: 'done', runId: message.runId as string, provider: 'chatgpt', listed: 0, message: null }, tabId);
    };
    await orch.start({ providers: ['gemini', 'chatgpt'], days: 30 });
    expect(orch.state.providers.map((p) => p.provider)).toEqual(['chatgpt', 'gemini']);
    await orch.idle();
  });
});

vi.setConfig({ testTimeout: 15_000 });
