import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { PROTO, threadCiteId, threadHash, type ThreadSummary } from '../../src/core/dock/protocol.js';
import { ensureStarterCollectionsAndSettings, saveSettingsPatch } from '../../src/core/db.js';
import { processThreadLocally } from '../../src/core/pipeline.js';
import { clearDockQueryCache, selectPassages, makeCursor, readCursor } from '../../src/core/dock/query.js';
import { patchDockSettings } from '../../src/core/dock/state.js';
import { buildThreadKey } from '../../src/core/schema.js';
import { harness, msg, pairDirect, putInsight, seed, stillSender, thread, type Harness } from './dock-helpers.js';

type Res = Record<string, unknown> & { ok: boolean };
const ask = async (h: Harness, type: string, fields: Record<string, unknown> = {}) => (await h.dock.handleExternalMessage(msg(type, fields), stillSender())) as Res;

describe('read requests', () => {
  let h: Harness;
  let refactor: string;
  let billing: string;
  let privateKey: string;
  let personal: string;

  beforeEach(async () => {
    clearDockQueryCache();
    h = await harness();
    refactor = await seed(
      h.db,
      thread(
        'cc1',
        'Parser cleanup',
        [
          ['user', 'Please refactor the tokenizer module into smaller functions.'],
          ['assistant', 'I split the tokenizer into scan, classify and emit steps.'],
          ['tool', '[tool] Edit: src/tokenizer.ts'],
          ['user', 'Great, now add tests for the refactoring.'],
        ],
        { provider: 'claude_code', project: 'General research', categoryLocked: true, workspacePath: '/repo' }
      )
    );
    billing = await seed(
      h.db,
      thread('b1', 'Stripe billing webhooks', [
        ['user', 'How should webhook retries be handled for invoices?'],
        ['assistant', 'Use idempotency keys and store processed event ids.'],
      ], { project: 'HypeStake', categoryLocked: true, updatedAt: '2026-10-31T10:00:00.000Z' })
    );
    privateKey = await seed(h.db, thread('p1', 'Tokenizer secrets', [['user', 'refactor the tokenizer privately']], { cloudExcluded: true }));
    personal = await seed(h.db, thread('p2', 'Diary tokenizer', [['user', 'tokenizer diary']], { project: 'Personal', categoryLocked: true }));
    await seed(h.db, thread('syn', 'Synthetic tokenizer', [['user', 'tokenizer']], { isSyntheticBenchmark: true }));
    await putInsight(h.db, billing, { kind: 'business', gist: 'Idempotent invoice webhook handling', topics: ['stripe', 'webhooks'] });
    await pairDirect(h);
  });

  it('searches titles, metadata and full message text, never private threads', async () => {
    const res = await ask(h, 'threads.search', { query: 'tokenizer', limit: 10 });
    expect(res).toMatchObject({ ok: true, proto: PROTO, semantic: false, reranked: false });
    const results = res.results as ThreadSummary[];
    expect(results.map((r) => r.threadKey)).toEqual([refactor]);
    expect(results[0]).toMatchObject({ category: 'coding_agent', providerLabel: 'Claude Code', match: 'strong', hash: threadHash(refactor) });
    expect(results[0].excerpt).toMatchObject({ messageIndex: 0, role: 'user' });
    expect(results[0].score).toBe(1);
    const json = JSON.stringify(res);
    expect(json).not.toContain(privateKey);
    expect(json).not.toContain(personal);
    expect(json).not.toContain('Diary');
    const meta = await ask(h, 'threads.search', { query: 'webhooks' });
    expect((meta.results as ThreadSummary[])[0].threadKey).toBe(billing);
  });

  it('filters by category, provider, kind, project, state and dates; empty query lists recent', async () => {
    const coding = await ask(h, 'threads.search', { query: '', filters: { categories: ['coding_agent'] } });
    expect((coding.results as ThreadSummary[]).map((r) => r.threadKey)).toEqual([refactor]);
    const kind = await ask(h, 'threads.search', { query: 'webhook', filters: { kinds: ['business'] } });
    expect((kind.results as ThreadSummary[]).map((r) => r.threadKey)).toEqual([billing]);
    const none = await ask(h, 'threads.search', { query: 'webhook', filters: { projects: ['General research'] } });
    expect(none.results).toEqual([]);
    const dated = await ask(h, 'threads.list', { filters: { since: '2026-10-31T00:00:00.000Z' } });
    expect((dated.results as ThreadSummary[]).map((r) => r.threadKey)).toEqual([billing]);
    const byHash = await ask(h, 'threads.list', { filters: { hashes: [threadHash(refactor), threadHash(privateKey)] } });
    expect((byHash.results as ThreadSummary[]).map((r) => r.threadKey)).toEqual([refactor]);
  });

  it('filters by the categories of the v0.5 providers (Paperclip agents, builders, added sites)', async () => {
    const pc = await seed(h.db, thread('pc1', 'PAP-12 Fix the CTA', [['user', 'Fix the CTA button']], { provider: 'paperclip', agentLabel: 'Engineer · Claude Code' }));
    const lov = await seed(h.db, thread('lv1', 'Landing page', [['user', 'Build a landing page']], { provider: 'lovable' }));
    const web = await seed(h.db, thread('cw1', 'Self-hosted chat', [['user', 'hello there']], { provider: 'custom_web' }));
    const agents = await ask(h, 'threads.list', { filters: { categories: ['agent'] } });
    expect((agents.results as ThreadSummary[]).map((r) => r.threadKey)).toEqual([pc]);
    expect((agents.results as ThreadSummary[])[0]).toMatchObject({ category: 'agent', agentLabel: 'Engineer · Claude Code', providerLabel: 'Paperclip' });
    const builders = await ask(h, 'threads.list', { filters: { categories: ['builder'] } });
    expect((builders.results as ThreadSummary[]).map((r) => r.threadKey)).toEqual([lov]);
    const chats = await ask(h, 'threads.list', { filters: { categories: ['chat'] }, limit: 50 });
    expect((chats.results as ThreadSummary[]).map((r) => r.threadKey)).toContain(web);
    expect((chats.results as ThreadSummary[]).map((r) => r.threadKey)).not.toContain(pc);
    const facets = await ask(h, 'facets', {});
    const providers = facets.providers as Array<{ id: string; category: string }>;
    expect(providers.find((p) => p.id === 'paperclip')).toMatchObject({ category: 'agent' });
    expect(providers.find((p) => p.id === 'lovable')).toMatchObject({ category: 'builder' });
  });

  it('lists with sort and an opaque cursor', async () => {
    const page1 = await ask(h, 'threads.list', { sort: 'title', limit: 1 });
    expect(page1.total).toBe(2);
    expect((page1.results as ThreadSummary[])[0].title).toBe('Parser cleanup');
    expect(page1.nextCursor).toMatch(/^c1\./);
    const page2 = await ask(h, 'threads.list', { sort: 'title', limit: 1, cursor: page1.nextCursor });
    expect((page2.results as ThreadSummary[])[0].title).toBe('Stripe billing webhooks');
    expect(page2.nextCursor).toBeNull();
    // A cursor from another request starts over.
    expect(readCursor(makeCursor(5, 'a'), 'b')).toBe(0);
  });

  it('context returns passages with ordinals, user and assistant only, within budget', async () => {
    const res = await ask(h, 'threads.context', { question: 'How was the tokenizer refactor split?', budgetChars: 600 });
    const threads = res.threads as Array<{ thread: ThreadSummary; passages: Array<{ messageIndex: number; role: string; text: string }> }>;
    expect(threads[0].thread.threadKey).toBe(refactor);
    const passages = threads.flatMap((t) => t.passages);
    expect(passages.length).toBeGreaterThan(0);
    for (const p of passages) expect(['user', 'assistant']).toContain(p.role);
    expect(passages.some((p) => p.messageIndex === 1)).toBe(true);
    expect(passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(600 + 2 * threads.length);
    expect(JSON.stringify(res)).not.toContain('privately');
  });

  it('selectPassages falls back to the last dialog turns and keeps ordinals', () => {
    const msgs = [
      { ordinal: 0, role: 'user', text: 'hello' },
      { ordinal: 1, role: 'tool', text: 'secret tool output' },
      { ordinal: 2, role: 'assistant', text: 'hi' },
    ];
    expect(selectPassages(msgs, 'unrelated words', 1000)).toEqual([
      { messageIndex: 0, role: 'user', text: 'hello' },
      { messageIndex: 2, role: 'assistant', text: 'hi' },
    ]);
  });

  it('facets count shareable threads only and never name local-only projects', async () => {
    const res = await ask(h, 'facets');
    expect(res.total).toBe(2);
    expect(res.projects).toEqual(expect.arrayContaining([{ name: 'HypeStake', count: 1 }, { name: 'General research', count: 1 }]));
    expect(JSON.stringify(res)).not.toContain('Personal');
    expect(res.providers).toEqual(expect.arrayContaining([{ id: 'claude_code', label: 'Claude Code', category: 'coding_agent', count: 1 }]));
  });

  it('threads.get resolves keys, cite ids and hashes; private and unknown ones are missing', async () => {
    const res = await ask(h, 'threads.get', {
      threadKeys: [refactor, privateKey, 'chatgpt:x:y:z:main'],
      citeIds: [threadCiteId(billing)],
      hashes: [threadHash(personal)],
      transcript: 'full',
    });
    const threads = res.threads as Array<{ threadKey: string; transcript: { included: boolean; messages: Array<{ role: string; content: string }> } }>;
    expect(threads.map((t) => t.threadKey)).toEqual([refactor, billing]);
    expect(res.missing).toEqual([privateKey, 'chatgpt:x:y:z:main', threadHash(personal)]);
    expect(res.deferred).toEqual([]);
    expect(threads[0].transcript.included).toBe(true);
    expect(threads[0].transcript.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    // Reads do not track.
    expect(await h.db.dockTracked.count()).toBe(0);
  });

  it('threads.get with track records tracked threads and the ledger; untrack forgets them', async () => {
    await ask(h, 'threads.get', { threadKeys: [billing], transcript: 'full', track: true });
    expect((await h.db.dockTracked.get(billing))?.dismissed).toBe(false);
    expect((await h.db.dockSent.get(billing))?.transcriptRevision).toBe(1);
    const res = await ask(h, 'threads.untrack', { hashes: [threadHash(billing)] });
    expect(res).toMatchObject({ ok: true, untracked: 1 });
    expect(await h.db.dockTracked.count()).toBe(0);
    expect(await h.db.dockSent.count()).toBe(0);
  });

  it('answers disabled when Threadkeeper turned off search (tracked gets still work)', async () => {
    await patchDockSettings(h.db, { allowSearch: false });
    expect(await ask(h, 'threads.search', { query: 'x' })).toMatchObject({ ok: false, error: { code: 'disabled' } });
    expect(await ask(h, 'facets')).toMatchObject({ ok: false, error: { code: 'disabled' } });
    expect(await ask(h, 'threads.get', { threadKeys: [billing] })).toMatchObject({ ok: false, error: { code: 'disabled' } });
    expect(await ask(h, 'threads.get', { threadKeys: [billing], track: true })).toMatchObject({ ok: true });
    const hello = (await ask(h, 'hello')) as unknown as { tk: { capabilities: string[] } };
    expect(hello.tk.capabilities).not.toContain('search');
  });

  it('limits reads to 30 per minute', async () => {
    for (let i = 0; i < 30; i++) expect((await ask(h, 'threads.list', { limit: 1 })).ok).toBe(true);
    const busy = await ask(h, 'threads.list', { limit: 1 });
    expect(busy).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect((busy.error as { retryAfterMs: number }).retryAfterMs).toBeGreaterThan(0);
    h.clock.t += 61_000;
    expect((await ask(h, 'threads.list', { limit: 1 })).ok).toBe(true);
  });

  it('related threads use stored vectors and skip private ones', async () => {
    const settings = await ensureStarterCollectionsAndSettings(h.db);
    const twin = await seed(h.db, thread('cc2', 'Tokenizer tests', [['user', 'Please refactor the tokenizer module into smaller functions and add tests.']], { provider: 'claude_code' }));
    for (const k of [refactor, twin, privateKey]) await processThreadLocally(h.db, k, { settings });
    const res = await ask(h, 'threads.related', { threadKey: refactor });
    const keys = (res.results as ThreadSummary[]).map((r) => r.threadKey);
    expect(keys).toContain(twin);
    expect(keys).not.toContain(privateKey);
    expect(await ask(h, 'threads.related', { threadKey: privateKey })).toMatchObject({ ok: false, error: { code: 'not_found' } });
  });

  it('related threads put structural matches first and name why, without needing vectors', async () => {
    const acct = (id: string, title: string, extra: Record<string, unknown>) => {
      const t = thread(id, title, [['user', `zzz ${title}`]], { provider: 'claude_code', accountId: 'acct_two', ...extra });
      return { ...t, threadKey: buildThreadKey({ provider: 'claude_code', accountId: 'acct_two', workspaceId: 'ws_test', sourceConversationId: id, branchId: 'main' }) };
    };
    const a = await seed(h.db, thread('rs1', 'Seed session', [['user', 'qqq seed']], { provider: 'claude_code', repository: 'acme/shop', gitBranch: 'fix-1', pullRequestUrl: 'https://github.com/acme/shop/pull/9' }));
    const other = await seed(h.db, acct('rs1', 'Seed session again', {}));
    const pr = await seed(h.db, thread('rs2', 'Same pr', [['user', 'www pr']], { provider: 'codex', repository: 'acme/other', pullRequestUrl: 'https://github.com/acme/shop/pull/9' }));
    const branch = await seed(h.db, thread('rs3', 'Same branch', [['user', 'eee branch']], { provider: 'codex', repository: 'acme/shop', gitBranch: 'fix-1' }));
    const repo = await seed(h.db, thread('rs4', 'Same repo', [['user', 'rrr repo']], { provider: 'cursor_agents', repository: 'acme/shop' }));
    const res = await ask(h, 'threads.related', { threadKey: a });
    const results = res.results as ThreadSummary[];
    expect(results.slice(0, 4).map((r) => [r.threadKey, r.matchReasons])).toEqual([
      [other, ['Same session, other account']],
      [pr, ['Same pull request']],
      [branch, ['Same branch']],
      [repo, ['Same repository']],
    ]);
    expect(results.map((r) => r.threadKey)).not.toContain(privateKey);
  });

  it('thread.open opens shareable threads only', async () => {
    const opened: string[] = [];
    const h2 = await harness({ deps: { openThread: async (k) => void opened.push(k) } });
    const k = await seed(h2.db, thread('o', 'Open me', [['user', 'x']]));
    const p = await seed(h2.db, thread('op', 'Private', [['user', 'x']], { cloudExcluded: true }));
    await pairDirect(h2);
    expect(await ask(h2, 'thread.open', { threadKey: k })).toMatchObject({ ok: true });
    expect(await ask(h2, 'thread.open', { threadKey: p })).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(opened).toEqual([k]);
  });

  it('threads.analyze reports no_ai without a Claude key, and queues otherwise', async () => {
    const none = await ask(h, 'threads.analyze', { threadKeys: [billing] });
    expect(none).toMatchObject({ ok: true, queued: 0, skipped: [{ threadKey: billing, reason: 'no_ai' }] });
    await saveSettingsPatch(h.db, { anthropicApiKey: 'sk-ant-test' });
    let kicked = 0;
    const h2 = await harness({ deps: { kickAnalysis: () => void (kicked += 1) } });
    await saveSettingsPatch(h2.db, { anthropicApiKey: 'sk-ant-test' });
    const k = await seed(h2.db, thread('z', 'Z', [['user', 'x']]));
    const p = await seed(h2.db, thread('zp', 'ZP', [['user', 'x']], { cloudExcluded: true }));
    const fresh = await seed(h2.db, thread('zf', 'ZF', [['user', 'x']]));
    await putInsight(h2.db, fresh, { analysisVersion: 2 });
    await pairDirect(h2);
    const res = await ask(h2, 'threads.analyze', { threadKeys: [k, p, fresh] });
    expect(res).toMatchObject({ ok: true, queued: 1 });
    expect(res.skipped).toEqual([{ threadKey: p, reason: 'local_only' }, { threadKey: fresh, reason: 'fresh' }]);
    expect(kicked).toBe(1);
    expect(await h2.db.jobs.count()).toBe(1);
  });

  it('threads.analyze upgrades a current v1 analysis through a requested job', async () => {
    const h2 = await harness();
    await saveSettingsPatch(h2.db, { anthropicApiKey: 'sk-ant-test', autoOrganize: { ...(await ensureStarterCollectionsAndSettings(h2.db)).autoOrganize, aiAnalysis: false } });
    const older = await seed(h2.db, thread('zv1', 'ZV1', [['user', 'x']]));
    await putInsight(h2.db, older, {}); // no analysisVersion: an analysis v1 record of the current revision
    await pairDirect(h2);
    const res = await ask(h2, 'threads.analyze', { threadKeys: [older] });
    expect(res).toMatchObject({ ok: true, queued: 1, skipped: [] });
    const jobs = await h2.db.jobs.toArray();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ threadKey: older, requested: true, status: 'pending' });
    expect('upgradeAnalysis' in jobs[0]).toBe(false);
  });
});
