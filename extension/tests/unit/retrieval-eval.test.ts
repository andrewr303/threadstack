import 'fake-indexeddb/auto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { LOCAL_SPACE, cosine, localHashEmbedding } from '../../src/core/embeddings.js';
import { fuseThreadVectors, type SearchHit } from '../../src/core/search.js';
import { DEFAULT_SETTINGS } from '../../src/core/schema.js';
import { clearDockQueryCache, searchThreads } from '../../src/core/dock/query.js';
import { evaluate, loadEvalLibrary, type EvalLibrary, type RunSummary } from './retrieval-eval-fixture.js';

/**
 * The manager's first stage as it was before the 2026-11-10 retrieval update (useThreadSearch),
 * frozen here so every run compares the same baseline against the shipped code.
 */
function baselineManagerFirstStage(lib: EvalLibrary, query: string): string[] {
  const scope = { provider: 'all' as const, project: 'All threads', workflowState: 'all' as const, coverage: 'all' as const, includeSyntheticBenchmark: false };
  const lexical = lib.searchIndex.searchLocal(query, scope, 5000);
  const q = query.trim();
  if (!q || q.length < 3 || lib.vectorRows.length === 0) return lexical.hits.map((h) => h.conversation.threadKey);
  const scoped = new Map(lib.searchIndex.searchLocal('', scope, 100000).hits.map((h) => [h.conversation.threadKey, h]));
  const qv = localHashEmbedding(q);
  const semantic: Array<[string, number]> = [];
  for (const [threadKey, bySpace] of lib.vectorsByThread) {
    const v = bySpace.get(LOCAL_SPACE);
    if (!v || !scoped.has(threadKey)) continue;
    const sim = cosine(qv, v);
    if (sim >= 0.18) semantic.push([threadKey, sim]);
  }
  semantic.sort((a, b) => b[1] - a[1]);
  const fused = new Map<string, SearchHit>();
  lexical.hits.forEach((h, rank) => fused.set(h.conversation.threadKey, { ...h, score: 1 / (60 + rank + 1) }));
  semantic.slice(0, 40).forEach(([threadKey, sim], rank) => {
    const rrf = 1 / (60 + rank + 1);
    const existing = fused.get(threadKey);
    if (existing) {
      existing.score += rrf;
      existing.vectorScore = sim;
    } else {
      fused.set(threadKey, { ...scoped.get(threadKey)!, score: rrf * 0.8 });
    }
  });
  return Array.from(fused.values()).sort((a, b) => b.score - a.score).map((h) => h.conversation.threadKey);
}

function table(rows: Record<string, RunSummary>): string {
  const lines = ['variant | recall@5 | recall@10 | MRR | nDCG@10 | no-answer results'];
  for (const [name, r] of Object.entries(rows)) {
    lines.push(`${name} | ${r.recall5} | ${r.recall10} | ${r.mrr} | ${r.ndcg10} | ${r.noAnswerResults}`);
  }
  return lines.join('\n');
}

describe('offline retrieval evaluation (synthetic fixtures, on-device path)', () => {
  let lib: EvalLibrary;
  beforeAll(async () => {
    lib = await loadEvalLibrary();
  }, 60_000);

  it('reports the labelled query set before and after', async () => {
    const results: Record<string, RunSummary> = {};
    results['manager first stage, baseline'] = evaluate(lib, (q) => baselineManagerFirstStage(lib, q));
    results['manager lexical only'] = evaluate(lib, (q) =>
      lib.searchIndex.searchLocal(q, { includeSyntheticBenchmark: false }, 5000).hits.map((h) => h.conversation.threadKey)
    );
    const scoped = lib.searchIndex.searchLocal('', { includeSyntheticBenchmark: false }, 100000).hits;
    results['manager first stage, current'] = evaluate(lib, (q) => fuseThreadVectors({
      lexical: lib.searchIndex.searchLocal(q, { includeSyntheticBenchmark: false }, 5000).hits,
      scoped, vectors: lib.vectorRows, space: LOCAL_SPACE, queryEmbedding: localHashEmbedding(q),
    }).map((h) => h.conversation.threadKey));

    clearDockQueryCache();
    const env = { db: lib.db, settings: { ...DEFAULT_SETTINGS } };
    const dockRank = async (q: string) =>
      (
        await searchThreads(env, {
          query: q,
          filters: {},
          limit: 50,
          cursor: null,
          semantic: 'local',
          rerank: 'off',
          excerpts: false,
          deadlineMs: 5000,
        } as Parameters<typeof searchThreads>[1])
      ).results.map((r) => r.threadKey);
    const dockRankings = new Map<string, string[]>();
    const { LABELLED_QUERIES } = await import('./retrieval-eval-fixture.js');
    for (const q of LABELLED_QUERIES) dockRankings.set(q.query, await dockRank(q.query));
    results['Still search (dock), current'] = evaluate(lib, (q) => dockRankings.get(q) ?? []);

    const out = path.join(os.tmpdir(), 'threadstack-retrieval-eval.json');
    fs.writeFileSync(out, JSON.stringify(results, null, 2));
    console.log(`${table(results)}\n(per-query detail: ${out})`);
    expect(results['manager first stage, baseline'].queries).toBeGreaterThanOrEqual(25);
  }, 60_000);
});
