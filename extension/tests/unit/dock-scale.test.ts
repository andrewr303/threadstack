import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { buildThreadKey, type ConversationRecord, type MessageRecord } from '../../src/core/schema.js';
import { reconcileDock } from '../../src/core/dock/outbox.js';
import { clearDockQueryCache } from '../../src/core/dock/query.js';
import { harness, msg, pairDirect, stillSender } from './dock-helpers.js';

// A library-scale fixture: reconcile pages with a cursor inside its time budget, and search/facets
// stay responsive over thousands of threads (fake-indexeddb is far slower than Chrome's IndexedDB).
const N = 4000;

function conv(i: number): ConversationRecord {
  const threadKey = buildThreadKey({ provider: i % 3 === 0 ? 'claude_code' : 'chatgpt', accountId: 'a', workspaceId: 'w', sourceConversationId: `c${i}`, branchId: 'main' });
  return {
    threadKey,
    provider: i % 3 === 0 ? 'claude_code' : 'chatgpt',
    accountId: 'a',
    workspaceId: 'w',
    sourceConversationId: `c${i}`,
    branchId: 'main',
    parentBranchId: null,
    siblingBranchIds: [],
    canonicalUrl: '',
    title: `Thread ${i} about ${i % 7 === 0 ? 'kubernetes autoscaling' : 'cooking pasta'}`,
    manualTitleOverride: null,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: new Date(Date.parse('2026-10-01T00:00:00.000Z') + i * 60_000).toISOString(),
    lastCapturedAt: '2026-10-30T00:00:00.000Z',
    sourceRevision: 1,
    contentHash: `h${i}`,
    coverage: 'full',
    captureSource: 'export_import',
    messageCount: 2,
    project: i % 10 === 0 ? 'Personal' : 'General research',
    categoryLocked: false,
    tags: [],
    manualTags: [],
    workflowState: 'active',
    manualNotes: '',
    pinned: false,
    snoozedUntil: null,
    dismissedQueues: [],
    cloudExcluded: false,
    cloudTaskStatus: 'unsupported',
    isSyntheticBenchmark: false,
    latestDecisionText: null,
    latestDecisionMsgIndex: null,
    latestDecisionSpeaker: null,
    nextStepText: null,
    nextStepMsgIndex: null,
    nextStepSpeaker: null,
  };
}

function messages(c: ConversationRecord, i: number): MessageRecord[] {
  return [0, 1].map((ordinal) => ({
    messageKey: `${c.threadKey}:m:${ordinal}`,
    threadKey: c.threadKey,
    ordinal,
    sourceMessageId: `${i}-${ordinal}`,
    role: ordinal === 0 ? 'user' : 'assistant',
    content: ordinal === 0 ? `Question ${i}: how do I tune the horizontal pod autoscaler?` : `Answer ${i}: set target CPU utilization and stabilization windows.`,
    createdAt: null,
    contentHash: '',
    hasCode: false,
    hasArtifact: false,
    branchPath: '',
  }));
}

describe('library scale', () => {
  it(`reconciles, searches and counts ${N} threads within budget`, async () => {
    clearDockQueryCache();
    const h = await harness();
    const convs = Array.from({ length: N }, (_, i) => conv(i));
    await h.db.conversations.bulkPut(convs);
    await h.db.messages.bulkPut(convs.flatMap((c, i) => messages(c, i)));
    await pairDirect(h);
    const settings = await ensureStarterCollectionsAndSettings(h.db);

    let passes = 0;
    let queued = 0;
    const started = performance.now();
    for (;;) {
      passes += 1;
      const r = await reconcileDock(h.db, settings, { force: passes === 1, budgetMs: 300 });
      queued += r.queued;
      if (r.done) break;
      expect(passes).toBeLessThan(200);
    }
    const reconcileMs = performance.now() - started;
    // Personal (every 10th) is local-only: never queued.
    expect(queued).toBe(N - N / 10);
    expect(await h.db.dockOutbox.count()).toBe(N - N / 10);
    expect(reconcileMs).toBeLessThan(30_000);

    const t0 = performance.now();
    const cold = (await h.dock.handleExternalMessage(msg('threads.search', { query: 'autoscaler stabilization', limit: 20 }), stillSender())) as Record<string, unknown>;
    const coldMs = performance.now() - t0;
    expect(cold.ok).toBe(true);
    expect((cold.results as unknown[]).length).toBe(20);
    expect(cold.total).toBe(N - N / 10);

    const t1 = performance.now();
    const warm = (await h.dock.handleExternalMessage(msg('threads.search', { query: 'kubernetes', limit: 50 }), stillSender())) as Record<string, unknown>;
    const warmMs = performance.now() - t1;
    expect(warm.ok).toBe(true);
    expect(warmMs).toBeLessThan(coldMs + 1000);

    const facets = (await h.dock.handleExternalMessage(msg('facets'), stillSender())) as Record<string, unknown>;
    expect(facets.total).toBe(N - N / 10);
    expect(JSON.stringify(facets)).not.toContain('Personal');
    expect(coldMs).toBeLessThan(20_000);
  }, 120_000);
});
