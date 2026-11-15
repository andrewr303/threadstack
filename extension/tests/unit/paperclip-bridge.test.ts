import 'fake-indexeddb/auto';
import { describe, expect, it, afterEach } from 'vitest';
import { ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { freshDb, seed, thread } from './dock-helpers.js';
import { handleBridgeRequest, buildSessionInventory } from '../../src/core/paperclip/bridge-query.js';
import { BRIDGE_PROTOCOL, mergeActionPolicy, parseBridgeRequest } from '../../src/core/paperclip/bridge-protocol.js';

const databases: ReturnType<typeof freshDb>[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });
const request = (type: string, params: Record<string, unknown> = {}) => ({ requestId: 'req-1', type, params, createdAt: Date.now(), deadlineAt: Date.now() + 30_000 });

describe('Paperclip bridge contract and privacy', () => {
  it('uses a separate protocol and rejects oversized/expired requests', () => {
    expect(BRIDGE_PROTOCOL).toBe('paperclip-threadkeeper/1');
    expect(() => parseBridgeRequest(request('threads.list'), Date.now())).not.toThrow();
    expect(() => parseBridgeRequest({ ...request('threads.list'), deadlineAt: 1 }, Date.now())).toThrow('expired');
    expect(() => parseBridgeRequest(request('threads.search', { query: 'x'.repeat(4 * 1024 * 1024) }), Date.now())).toThrow('large');
  });

  it('off wins independently for master and provider switches', () => {
    expect(mergeActionPolicy({ enabled: true, providers: ['claude', 'chatgpt'], disabledAt: 10 }, { enabled: true, providers: ['chatgpt'], disabledAt: 20 })).toEqual({ enabled: true, providers: ['chatgpt'], disabledAt: 20 });
    expect(mergeActionPolicy({ enabled: false, providers: ['chatgpt'], disabledAt: 30 }, { enabled: true, providers: ['chatgpt'], disabledAt: 20 }).enabled).toBe(false);
  });

  it('excludes private sessions and Paperclip tasks from counts, search and inventory', async () => {
    const db = freshDb(); databases.push(db);
    await ensureStarterCollectionsAndSettings(db);
    const publicKey = await seed(db, thread('public', 'Unique public webhook', [['user', 'webhook retries']]));
    const privateKey = await seed(db, thread('private', 'Private webhook', [['user', 'secret webhook']]));
    await db.conversations.update(privateKey, { cloudExcluded: true });
    await seed(db, thread('task', 'Paperclip webhook', [['user', 'paperclip']], { provider: 'paperclip' }));
    const deps = { db, companyId: 'company-a', isGranted: () => true };
    const result = await handleBridgeRequest(deps, request('threads.list', { limit: 20 }));
    expect(result.ok).toBe(true);
    if (result.ok) expect((result.data.results as Array<{ threadKey: string }>).map(r => r.threadKey)).toEqual([publicKey]);
    const facets = await handleBridgeRequest(deps, request('facets'));
    expect(facets.ok && facets.data.total).toBe(1);
    const inventory = await buildSessionInventory(db);
    expect(inventory.map(r => r.threadKey)).toEqual([publicKey]);
    expect((await handleBridgeRequest(deps, request('threads.get', { threadKeys: [privateKey] }))).ok).toBe(false);
  });

  it('does not reuse Still transcript permissions and redacts user text before returning it', async () => {
    const db = freshDb(); databases.push(db);
    await ensureStarterCollectionsAndSettings(db);
    const key = await seed(db, thread('read', 'Read', [['user', 'key sk-ant-api03-abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890'], ['assistant', 'answer']]));
    const result = await handleBridgeRequest({ db, companyId: 'a', isGranted: () => true, shareTranscripts: true }, request('threads.get', { threadKeys: [key], transcript: 'window', window: { from: 0, count: 40 } }));
    expect(result.ok).toBe(true);
    expect(JSON.stringify(result)).not.toContain('sk-ant-api03-abcdefghijklmnopqrstuvwxyz');
    expect(JSON.stringify(result)).toContain('answer');
    expect(JSON.stringify(result)).toContain('untrusted');
  });

  it('refuses every read once its company grant is revoked', async () => {
    const db = freshDb(); databases.push(db);
    await ensureStarterCollectionsAndSettings(db);
    const result = await handleBridgeRequest({ db, companyId: 'a', isGranted: () => false }, request('threads.list'));
    expect(result).toMatchObject({ ok: false, error: { code: 'denied' } });
  });

  it('reads newest pages with the plugin cursor contract and honors transcript opt-out', async () => {
    const db = freshDb(); databases.push(db); await ensureStarterCollectionsAndSettings(db);
    const key = await seed(db, thread('pages', 'Pages', Array.from({ length: 60 }, (_, i) => ['user', `message ${i}`] as ['user', string])));
    const deps = { db, companyId: 'a', isGranted: () => true };
    const latest = await handleBridgeRequest(deps, request('threads.get', { threadKey: key, includeTranscript: true, maxMessages: 40 }));
    expect(latest.ok).toBe(true);
    if (latest.ok) { expect(latest.data.before).toBe('20'); expect((latest.data.messages as Array<{ index: number }>)[0].index).toBe(20); }
    const earlier = await handleBridgeRequest(deps, request('threads.get', { threadKey: key, includeTranscript: true, maxMessages: 40, before: '20' }));
    expect(earlier.ok && (earlier.data.messages as unknown[]).length).toBe(20);
    const denied = await handleBridgeRequest({ ...deps, shareTranscripts: false }, request('threads.get', { threadKey: key, includeTranscript: true }));
    expect(denied.ok && (denied.data.messages as unknown[]).length).toBe(0);
  });

  it('cuts a 200,000-character message with […cut] and truncated:true inside the 60,000-character bound (REQ-8 AC-10, finding 1)', async () => {
    const db = freshDb(); databases.push(db); await ensureStarterCollectionsAndSettings(db);
    const turns: Array<['user' | 'assistant', string]> = [['user', 'first question'], ['assistant', 'x'.repeat(200_000)], ['user', 'after the long answer']];
    const key = await seed(db, thread('huge', 'Huge', turns));
    const deps = { db, companyId: 'a', isGranted: () => true };
    const first = await handleBridgeRequest(deps, request('threads.get', { threadKey: key, includeTranscript: true }));
    expect(first.ok).toBe(true); if (!first.ok) return;
    expect((first.data.messages as Array<{ content: string }>).at(-1)?.content).toBe('after the long answer');
    // Follow `before` to the page that contains the long message.
    let page: Awaited<ReturnType<typeof handleBridgeRequest>> = first; let hops = 0;
    while (page.ok && !(page.data.messages as Array<{ index: number }>).some(m => m.index === 1) && page.data.before && hops++ < 3) {
      page = await handleBridgeRequest(deps, request('threads.get', { threadKey: key, includeTranscript: true, before: page.data.before }));
    }
    expect(page.ok).toBe(true); if (!page.ok) return;
    expect(JSON.stringify(page.data).length).toBeLessThanOrEqual(60_000);
    expect(page.data.truncated).toBe(true);
    const cut = (page.data.messages as Array<{ index: number; content: string }>).find(m => m.index === 1)!;
    expect(cut.content.endsWith('[…cut]')).toBe(true);
    expect(cut.content.length).toBeGreaterThan(12_000);
    expect(JSON.stringify(page.data)).not.toContain('[… truncated]');
    expect(page.data.before).toBe('1');
  });

  it('pages 300 messages of 3,000 characters newest first, and before reaches every older message with no gaps (REQ-8 AC-5, finding 2)', async () => {
    const db = freshDb(); databases.push(db); await ensureStarterCollectionsAndSettings(db);
    const turns = Array.from({ length: 300 }, (_, i) => ['user', `m${String(i).padStart(3, '0')}:${'y'.repeat(2995)}`] as ['user', string]);
    const key = await seed(db, thread('long', 'Long', turns));
    const deps = { db, companyId: 'a', isGranted: () => true };
    const seen: number[] = []; let before: string | null | undefined; let pages = 0;
    do {
      const page = await handleBridgeRequest(deps, request('threads.get', { threadKey: key, includeTranscript: true, ...(before ? { before } : {}) }));
      expect(page.ok).toBe(true); if (!page.ok) return;
      expect(JSON.stringify(page.data).length).toBeLessThanOrEqual(60_000);
      const indexes = (page.data.messages as Array<{ index: number }>).map(m => m.index);
      expect(indexes.length).toBeGreaterThan(0);
      expect(indexes).toEqual([...indexes].sort((a, b) => a - b));
      if (pages === 0) expect(indexes.at(-1)).toBe(299);
      seen.unshift(...indexes);
      before = page.data.before as string | null;
      if (before !== null) expect(Number(before)).toBe(indexes[0]);
      pages++;
    } while (before && pages < 100);
    expect(seen).toEqual(Array.from({ length: 300 }, (_, i) => i));
  });

  it('reports degraded local_only for best quality when a configured remote embedding fails at runtime (REQ-8 finding 8)', async () => {
    const db = freshDb(); databases.push(db);
    const settings = await ensureStarterCollectionsAndSettings(db);
    await db.settings.put({ ...settings, embeddingProvider: 'voyage', voyageApiKey: 'fixture-voyage-key', rerankProvider: 'none' });
    await seed(db, thread('mig', 'Database migration order', [['user', 'we decided the migration order']]));
    const failing = (async () => { throw new TypeError('network down'); }) as unknown as typeof fetch;
    const deps = { db, companyId: 'a', isGranted: () => true, allowRemoteModels: true, fetch: failing };
    const best = await handleBridgeRequest(deps, request('threads.search', { query: 'migration order', quality: 'best' }));
    expect(best.ok).toBe(true);
    if (best.ok) { expect(best.data.semantic).toBe(false); expect(best.data.degraded).toBe('local_only'); }
    const noRemote = await handleBridgeRequest({ ...deps, allowRemoteModels: false }, request('threads.search', { query: 'migration order', quality: 'best' }));
    expect(noRemote.ok && noRemote.data.degraded).toBe('local_only');
    const fast = await handleBridgeRequest(deps, request('threads.search', { query: 'migration order', quality: 'fast' }));
    expect(fast.ok && fast.data.degraded).toBeUndefined();
  });

  it('accepts sessions_context limit 20 and keeps passages within the requested text budget (REQ-8 finding 10)', async () => {
    const db = freshDb(); databases.push(db); await ensureStarterCollectionsAndSettings(db);
    for (let i = 0; i < 25; i++) await seed(db, thread(`ctx-${i}`, `Migration plan ${i}`, [['user', `migration order decision ${i} ${'detail '.repeat(200)}`], ['assistant', `we run migration ${i} first`]]));
    const result = await handleBridgeRequest({ db, companyId: 'a', isGranted: () => true }, request('threads.context', { question: 'migration order decision', limit: 20, budgetChars: 12_000 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const passages = result.data.passages as Array<{ threadKey: string; text: string }>;
    expect(new Set(passages.map(p => p.threadKey)).size).toBeLessThanOrEqual(20);
    expect(new Set(passages.map(p => p.threadKey)).size).toBeGreaterThan(8);
    expect(passages.every(p => typeof p.threadKey === 'string')).toBe(true);
    expect(passages.reduce((n, p) => n + p.text.length, 0)).toBeLessThanOrEqual(12_000);
    expect((await handleBridgeRequest({ db, companyId: 'a', isGranted: () => true }, request('threads.context', { question: 'q', limit: 21 }))).ok).toBe(false);
  });

  it('does not change a session fingerprint on every heartbeat, only when the state changes or its 30 s refresh bucket passes (REQ-10 F15)', async () => {
    const db = freshDb(); databases.push(db); await ensureStarterCollectionsAndSettings(db);
    const key = await seed(db, thread('beat', 'Heartbeat', [['user', 'coding']], { provider: 'claude_code' }));
    let snap = { state: 'running', at: Date.parse('2026-11-14T10:00:05.000Z') };
    const observations = { snapshot: () => snap } as never;
    const first = (await buildSessionInventory(db, undefined, { observations })).find(r => r.threadKey === key)!;
    snap = { state: 'running', at: Date.parse('2026-11-14T10:00:15.000Z') };
    const heartbeat = (await buildSessionInventory(db, undefined, { observations })).find(r => r.threadKey === key)!;
    expect(heartbeat.fingerprint).toBe(first.fingerprint);
    expect(heartbeat.agentStateAt).toBe('2026-11-14T10:00:15.000Z');
    snap = { state: 'turn_complete', at: Date.parse('2026-11-14T10:00:25.000Z') };
    expect((await buildSessionInventory(db, undefined, { observations })).find(r => r.threadKey === key)!.fingerprint).not.toBe(first.fingerprint);
    snap = { state: 'running', at: Date.parse('2026-11-14T10:01:10.000Z') };
    expect((await buildSessionInventory(db, undefined, { observations })).find(r => r.threadKey === key)!.fingerprint).not.toBe(first.fingerprint);
    // Plugin follow-up (2026-11-14): observations older than 120 s count as unobserved, so a live row must be
    // re-sent well within 60 s; a heartbeat 30 s on changes the fingerprint.
    snap = { state: 'running', at: Date.parse('2026-11-14T10:00:35.000Z') };
    expect((await buildSessionInventory(db, undefined, { observations })).find(r => r.threadKey === key)!.fingerprint).not.toBe(first.fingerprint);
  });

  it('sets truncated only for a real cut, not merely because older messages exist (REQ-8 FR-4, NF-7)', async () => {
    const db = freshDb(); databases.push(db); await ensureStarterCollectionsAndSettings(db);
    const key = await seed(db, thread('flag', 'Flag', Array.from({ length: 60 }, (_, i) => ['user', `message ${i}`] as ['user', string])));
    const page = await handleBridgeRequest({ db, companyId: 'a', isGranted: () => true }, request('threads.get', { threadKey: key, includeTranscript: true }));
    expect(page.ok).toBe(true); if (!page.ok) return;
    expect(page.data.before).toBe('20');
    expect(page.data.truncated).toBe(false);
  });

  it('drops content and counts if privacy changes while a read is being prepared', async () => {
    const db = freshDb(); databases.push(db); await ensureStarterCollectionsAndSettings(db);
    const key = await seed(db, thread('privacy-race', 'Private later', [['user', 'must not leave']]));
    let checks = 0;
    const result = await handleBridgeRequest({ db, companyId: 'a', isGranted: async () => { checks++; if (checks === 2) await db.conversations.update(key, { cloudExcluded: true }); return true; } }, request('threads.get', { threadKey: key, includeTranscript: true }));
    expect(result).toMatchObject({ ok: false, error: { code: 'not_found' } });
    expect(JSON.stringify(result)).not.toContain('must not leave');
  });
  it('never calls persisted agent-state timestamps a live observation', async () => {
    const db = freshDb(); databases.push(db); await ensureStarterCollectionsAndSettings(db);
    const key = await seed(db, thread('historic', 'Historic', [['user', 'saved']], { agentState: 'running' }));
    const [historic] = await buildSessionInventory(db);
    expect(historic.observed).toBe(false);
    const [live] = await buildSessionInventory(db, undefined, { observations: { snapshot: candidate => candidate === key ? { state: 'waiting_permission', at: Date.now() } : null } });
    expect(live).toMatchObject({ observed: true, agentState: 'waiting_permission' });
  });
});
