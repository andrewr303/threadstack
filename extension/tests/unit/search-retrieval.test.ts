import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadkeeperDB, ensureStarterCollectionsAndSettings, upsertThread } from '../../src/core/db.js';
import { DEFAULT_SETTINGS, type ThreadVectorRecord } from '../../src/core/schema.js';
import { MemorySearchIndex, fuseThreadVectors, runHybridSearch, storeVectorEntries } from '../../src/core/search.js';

let seq = 0;
const databases: ThreadkeeperDB[] = [];
afterEach(() => databases.splice(0).forEach((db) => db.close()));
async function fixture() {
  const db = new ThreadkeeperDB(`SearchRetrieval_${Date.now()}_${++seq}`);
  databases.push(db);
  await ensureStarterCollectionsAndSettings(db);
  await db.settings.put({ ...DEFAULT_SETTINGS, cloudExcludedProviders: [] });
  for (const [id, accountId, content] of [
    ['code', 'work', 'Implementation of a webhook handler\n```ts\nconst handle = () => true;\n```'],
    ['plain', 'work', 'A webhook discussion without code'],
    ['other', 'personal', 'A webhook in another account'],
  ]) {
    await upsertThread(db, { threadKey: id, provider: 'chatgpt', accountId, workspaceId: 'w', sourceConversationId: id,
      branchId: 'main', canonicalUrl: `https://chatgpt.com/c/${id}`, title: `Webhook ${id}`, createdAt: null,
      updatedAt: '2026-11-01T00:00:00Z', coverage: 'full', captureSource: 'export_import', project: 'Work',
      messages: [{ sourceMessageId: id, role: 'user', content, createdAt: null }] });
  }
  return db;
}
const vector = () => [1, ...new Array(255).fill(0)];
const query = () => ({ indexType: 'standard' as const, model: 'voyage-4' as const, dimensions: 256 as const, embedding: vector() });
async function store(db: ThreadkeeperDB, threadKey: string) {
  const chunks = await db.chunks.where('threadKey').equals(threadKey).toArray();
  return storeVectorEntries(db, { ...query(), threadKey, embeddingsByChunkKey: chunks.map((c) => ({ chunkKey: c.chunkKey, embedding: vector() })) });
}

describe('hybrid retrieval boundaries', () => {
  it('retrieves code from vectors using the same account and hasCode scope as lexical search', async () => {
    const db = await fixture();
    await Promise.all(['code', 'plain', 'other'].map((key) => store(db, key)));
    const result = await runHybridSearch(db, { query: 'unmatched semantic paraphrase', scope: { accountId: 'work', hasCode: true }, vectorQuery: query() });
    expect(result.hits.map((h) => h.conversation.threadKey)).toEqual(['code']);
    expect(result.totalScopedCandidates).toBe(1);
  });

  it('rejects foreign chunk writes atomically and skips orphan, stale and nonfinite stored vectors', async () => {
    const db = await fixture();
    const foreign = (await db.chunks.where('threadKey').equals('other').first())!;
    expect(await storeVectorEntries(db, { ...query(), threadKey: 'code', embeddingsByChunkKey: [{ chunkKey: foreign.chunkKey, embedding: vector() }] })).toMatchObject({ stored: 0 });
    expect(await db.vectors.count()).toBe(0);
    await Promise.all(['code', 'plain', 'other'].map((key) => store(db, key)));
    const rows = await db.vectors.toArray();
    await db.vectors.update(rows.find((v) => v.threadKey === 'code')!.vectorKey, { chunkKey: 'deleted' });
    await db.vectors.update(rows.find((v) => v.threadKey === 'plain')!.vectorKey, { sourceRevision: -1 });
    await db.vectors.update(rows.find((v) => v.threadKey === 'other')!.vectorKey, { embedding: [NaN, ...vector().slice(1)] });
    const result = await runHybridSearch(db, { query: 'absent-query', vectorQuery: query() });
    expect(result.hits).toEqual([]);
    expect(result.staleVectorsSkipped).toBe(rows.length);
  });

  it('falls back to lexical results for nonfinite or zero query vectors', async () => {
    const db = await fixture();
    for (const embedding of [new Array(256).fill(0), [Infinity, ...vector().slice(1)]]) {
      const result = await runHybridSearch(db, { query: 'webhook', vectorQuery: { ...query(), embedding } });
      expect(result.vectorRejectedReason).toMatch(/Invalid query embedding/);
      expect(result.hits).toHaveLength(3);
    }
  });

  it('falls back without mutating scores for duplicate, incomplete or nonfinite rerank responses', async () => {
    const db = await fixture();
    const baseline = await runHybridSearch(db, { query: 'webhook' });
    const order = baseline.hits.map((h) => h.conversation.threadKey);
    const malformed = [
      [{ index: 0, relevanceScore: 0.8 }, { index: 0, relevanceScore: 0.3 }, { index: 2, relevanceScore: 0.2 }],
      [{ index: 0, relevanceScore: 0.8 }],
      [{ index: 0, relevanceScore: NaN }, { index: 1, relevanceScore: 1 }, { index: 2, relevanceScore: 0.5 }],
    ];
    for (const response of malformed) {
      const result = await runHybridSearch(db, { query: 'webhook', reranker: async () => response });
      expect(result.rerankFallbackUsed).toBe(true);
      expect(result.hits.map((h) => h.conversation.threadKey)).toEqual(order);
      expect(result.hits.every((h) => h.rerankScore === null)).toBe(true);
    }
  });

  it('fuses only current scoped vectors from the selected space with lexical candidates', async () => {
    const db = await fixture();
    const conversations = await db.conversations.toArray();
    const index = new MemorySearchIndex();
    index.loadSnapshot({ conversations });
    const scoped = index.searchLocal('', { accountId: 'work' }).hits;
    const rows: ThreadVectorRecord[] = conversations.map((c) => ({ vectorKey: c.threadKey, threadKey: c.threadKey,
      sourceRevision: c.sourceRevision, space: 'mongo:test', embedding: [1, 0], docHash: 'doc', updatedAt: '' }));
    rows.find((v) => v.threadKey === 'plain')!.sourceRevision = -1;
    const hits = fuseThreadVectors({ lexical: [], scoped, vectors: rows, space: 'mongo:test', queryEmbedding: [1, 0] });
    expect(hits.map((h) => h.conversation.threadKey)).toEqual(['code']);
    expect(fuseThreadVectors({ lexical: [], scoped, vectors: rows, space: 'legacy:test', queryEmbedding: [1, 0] })).toEqual([]);
    expect(fuseThreadVectors({ lexical: [], scoped, vectors: rows, space: 'mongo:test', queryEmbedding: [1, 0, 0] })).toEqual([]);
  });
});
