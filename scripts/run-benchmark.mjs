import { build } from 'esbuild';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const evidenceDir = path.join(rootDir, 'evidence', 'acceptance');

function percentile(sortedValues, p) {
  if (sortedValues.length === 0) return 0;
  const idx = Math.min(
    sortedValues.length - 1,
    Math.max(0, Math.ceil((p / 100) * sortedValues.length) - 1)
  );
  return Number(sortedValues[idx].toFixed(3));
}

async function main() {
  await fs.mkdir(evidenceDir, { recursive: true });
  const tempBundlePath = path.join(rootDir, '.output', 'bench-bundle.mjs');
  await fs.mkdir(path.dirname(tempBundlePath), { recursive: true });

  await build({
    stdin: {
      contents: `
        export {
          generate10kSyntheticMetadataRecords,
          generate10kSyntheticMessagesByThread
        } from './src/core/synthetic-fixtures.ts';
        export { MemorySearchIndex } from './src/core/search.ts';
      `,
      resolveDir: rootDir,
      sourcefile: 'bench-entry.ts',
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
    outfile: tempBundlePath,
    logLevel: 'silent'
  });

  const {
    generate10kSyntheticMetadataRecords,
    generate10kSyntheticMessagesByThread,
    MemorySearchIndex
  } = await import(pathToFileURL(tempBundlePath).href);

  const generateStart = performance.now();
  const conversations = generate10kSyntheticMetadataRecords(10000);
  const messagesByThread = generate10kSyntheticMessagesByThread(conversations, 20);
  const messageCount = conversations.length * 20;
  const generateMs = Number((performance.now() - generateStart).toFixed(3));

  const index = new MemorySearchIndex();
  const coldIndexStart = performance.now();
  index.loadSnapshot({ conversations, messagesByThread });
  const coldIndexBuildMs = Number((performance.now() - coldIndexStart).toFixed(3));

  const benchmarkScope = { includeSyntheticBenchmark: true };

  // Measure 20 warm-open snapshot loads (top 100 sorted threads + reconciled counts)
  const warmOpenSamplesMs = [];
  for (let i = 0; i < 20; i++) {
    const start = performance.now();
    const openView = index.searchLocal('', benchmarkScope, 100);
    const elapsed = Number((performance.now() - start).toFixed(3));
    if (openView.hits.length !== 100 || openView.totalScopedCandidates !== 10000) {
      throw new Error(
        `Expected 100 warm-open rows over 10000 candidates, got ${openView.hits.length} / ${openView.totalScopedCandidates}`
      );
    }
    warmOpenSamplesMs.push(elapsed);
  }

  // 50 body-only search queries matching strictly message.content across 200,000 messages and 0 metadata fields
  const queries = [];
  for (let s = 0; s < 50; s += 1) {
    const idx = (s * 197 + 42) % 10000;
    const bodyOnlyTokens = [
      'meridian-quartz-calibrator-4242',
      `body_token_alpha_${idx}`,
      `meridian-body-calibrator-${idx}`,
      `scrubber_frame_budget_${idx % 200}`,
      `msgpack_delta_window_${idx % 200}`
    ];
    queries.push(bodyOnlyTokens[s % bodyOnlyTokens.length]);
  }

  const querySamples = [];
  for (const q of queries) {
    const start = performance.now();
    const res = index.searchLocal(q, benchmarkScope, 50);
    const elapsedMs = Number((performance.now() - start).toFixed(3));
    querySamples.push({
      query: q,
      elapsedMs,
      hitCount: res.hits.length,
      candidateSetSize: res.totalScopedCandidates,
      totalScopedCandidates: res.totalScopedCandidates
    });
  }

  const sortedWarmOpen = [...warmOpenSamplesMs].sort((a, b) => a - b);
  const sortedSearch = querySamples.map((s) => s.elapsedMs).sort((a, b) => a - b);

  const warmOpenP50Ms = percentile(sortedWarmOpen, 50);
  const warmOpenP95Ms = percentile(sortedWarmOpen, 95);
  const warmOpenMaxMs = sortedWarmOpen[sortedWarmOpen.length - 1];

  const searchMinMs = sortedSearch[0];
  const searchP50Ms = percentile(sortedSearch, 50);
  const searchP95Ms = percentile(sortedSearch, 95);
  const searchMaxMs = sortedSearch[sortedSearch.length - 1];
  const searchMeanMs = Number(
    (sortedSearch.reduce((acc, v) => acc + v, 0) / sortedSearch.length).toFixed(3)
  );

  const searchGoalMisses = querySamples.filter((s) => s.elapsedMs > 150);
  const warmOpenGoalMisses = warmOpenSamplesMs.filter((ms) => ms > 500);

  const report = {
    id: 'PERF-10',
    label: 'SYNTHETIC 10,000-THREAD + 200,000-MESSAGE BENCHMARK (Clearly labeled synthetic dataset)',
    timestamp: new Date().toISOString(),
    environment: {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      cpuModel: os.cpus()[0]?.model ?? 'unknown',
      cpuCores: os.cpus().length,
      totalMemoryGb: Number((os.totalmem() / 1024 ** 3).toFixed(2))
    },
    dataset: {
      synthetic: true,
      threadCount: conversations.length,
      messageCount,
      messagesPerThread: 20,
      generationMs: generateMs,
      coldIndexBuildMs
    },
    warmOpenMetadataLibrary: {
      goalMs: 500,
      sampleCount: warmOpenSamplesMs.length,
      samplesMs: warmOpenSamplesMs,
      p50Ms: warmOpenP50Ms,
      p95Ms: warmOpenP95Ms,
      maxMs: warmOpenMaxMs,
      missesOver500ms: warmOpenGoalMisses.length,
      passesGoal: warmOpenP95Ms <= 500 && warmOpenGoalMisses.length === 0
    },
    repeatedLocalSearch: {
      goalMs: 150,
      sampleCount: querySamples.length,
      queryCount: querySamples.length,
      minMs: searchMinMs,
      p50Ms: searchP50Ms,
      p95Ms: searchP95Ms,
      maxMs: searchMaxMs,
      meanMs: searchMeanMs,
      missesOver150ms: searchGoalMisses,
      passesGoal: searchP95Ms <= 150 && searchGoalMisses.length === 0,
      samples: querySamples
    }
  };

  const outPath = path.join(evidenceDir, 'perf-10-benchmark.json');
  await fs.writeFile(outPath, JSON.stringify(report, null, 2), 'utf8');
  await fs.rm(tempBundlePath, { force: true });

  console.log(
    `PERF-10 synthetic 10k benchmark complete: warmOpen p50=${warmOpenP50Ms}ms p95=${warmOpenP95Ms}ms (goal <=500ms); localSearch p50=${searchP50Ms}ms p95=${searchP95Ms}ms max=${searchMaxMs}ms (goal <=150ms)`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
