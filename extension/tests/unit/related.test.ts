import { describe, expect, it } from 'vitest';
import { findRelatedThreads } from '../../src/core/related.js';
import { providerCategory } from '../../src/core/providers.js';
import type { ConversationRecord } from '../../src/core/schema.js';

const coding = (provider: string) => providerCategory(provider) === 'coding_agent';

let n = 0;
function conv(extra: Partial<ConversationRecord> & { id?: string }): ConversationRecord {
  const id = extra.id ?? `c${++n}`;
  return {
    threadKey: `k_${id}`,
    provider: 'codex',
    accountId: 'a1',
    sourceConversationId: id,
    branchId: 'main',
    updatedAt: '2026-10-01T00:00:00.000Z',
    lastCapturedAt: '2026-10-01T00:00:00.000Z',
    isSyntheticBenchmark: false,
    providerProjectName: null,
    workspacePath: null,
    ...extra,
  } as ConversationRecord;
}

const run = (selected: ConversationRecord, conversations: ConversationRecord[], vectors: Record<string, number[]> = {}, limit?: number) =>
  findRelatedThreads({
    selected,
    conversations: [selected, ...conversations],
    vectorOf: (key) => vectors[key],
    threshold: 0.5,
    limit,
    isCodingProvider: coding,
  });

describe('findRelatedThreads', () => {
  it('ranks same session, pull request, branch, repository, then similar meaning', () => {
    const sel = conv({ id: 's', repository: 'acme/app', gitBranch: 'fix', pullRequestUrl: 'https://github.com/acme/app/pull/1' });
    const similar = conv({ id: 'sim', provider: 'chatgpt' });
    const repo = conv({ id: 'repo', repository: 'acme/app' });
    const branch = conv({ id: 'br', repository: 'acme/app', gitBranch: 'fix' });
    const pr = conv({ id: 'pr', repository: 'acme/other', pullRequestUrl: 'https://github.com/Acme/App/pull/1?x=1' });
    const same = conv({ id: 's', accountId: 'a2', threadKey: 'k_s_a2' });
    const out = run(sel, [similar, repo, branch, pr, same], {
      [sel.threadKey]: [1, 0],
      [similar.threadKey]: [0.9, 0.1],
    });
    expect(out.map((r) => [r.threadKey, r.reason])).toEqual([
      [same.threadKey, 'same_conversation'],
      [pr.threadKey, 'same_pull_request'],
      [branch.threadKey, 'same_branch'],
      [repo.threadKey, 'same_repository'],
      [similar.threadKey, 'similar'],
    ]);
    expect(out[4].similarity).toBeGreaterThan(0.9);
    expect(out[0].similarity).toBeNull();
  });

  it('never returns the thread itself, its own branches or synthetic threads', () => {
    const sel = conv({ id: 's', repository: 'acme/app' });
    const branch = conv({ id: 's', branchId: 'b2', threadKey: 'k_s_b2', repository: 'acme/app' });
    const synthetic = conv({ id: 'x', repository: 'acme/app', isSyntheticBenchmark: true });
    expect(run(sel, [branch, synthetic])).toEqual([]);
  });

  it('matches a bare folder name to its owner/name group, but not when two owners share it', () => {
    const sel = conv({ id: 's', repository: 'acme/app' });
    const bare = conv({ id: 'b', workspacePath: '/code/app' });
    expect(run(sel, [bare]).map((r) => r.reason)).toEqual(['same_repository']);
    const rival = conv({ id: 'r', repository: 'other/app' });
    expect(run(sel, [bare, rival]).map((r) => r.threadKey)).toEqual([]);
  });

  it('does not match chat threads by folder name', () => {
    const sel = conv({ id: 's', repository: 'acme/app' });
    expect(run(sel, [conv({ id: 'c', provider: 'chatgpt', workspacePath: '/code/app' })])).toEqual([]);
  });

  it('applies the threshold and ignores mismatched or missing vectors', () => {
    const sel = conv({ id: 's' });
    const near = conv({ id: 'n' });
    const far = conv({ id: 'f' });
    const none = conv({ id: 'm' });
    const odd = conv({ id: 'o' });
    const out = run(sel, [near, far, none, odd], {
      [sel.threadKey]: [1, 0],
      [near.threadKey]: [1, 0.1],
      [far.threadKey]: [0, 1],
      [odd.threadKey]: [1, 0, 0],
    });
    expect(out.map((r) => r.threadKey)).toEqual([near.threadKey]);
    expect(run(sel, [near], {})).toEqual([]);
  });

  it('breaks ties by recency and caps at the limit, structural first', () => {
    const sel = conv({ id: 's', repository: 'acme/app' });
    const old = conv({ id: 'o', repository: 'acme/app', updatedAt: '2026-01-01T00:00:00.000Z' });
    const fresh = conv({ id: 'f', repository: 'acme/app', updatedAt: '2026-10-09T00:00:00.000Z' });
    const sim = conv({ id: 'x', provider: 'chatgpt' });
    const vectors = { [sel.threadKey]: [1, 0], [sim.threadKey]: [1, 0] };
    expect(run(sel, [old, fresh, sim], vectors).map((r) => r.threadKey)).toEqual([fresh.threadKey, old.threadKey, sim.threadKey]);
    expect(run(sel, [old, fresh, sim], vectors, 2).map((r) => r.threadKey)).toEqual([fresh.threadKey, old.threadKey]);
    const many = Array.from({ length: 12 }, (_, i) => conv({ id: `m${i}`, repository: 'acme/app' }));
    expect(run(sel, many)).toHaveLength(8);
  });
});
