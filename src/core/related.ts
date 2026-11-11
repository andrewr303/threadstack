// Related threads for one selected thread: the same session seen from another account, the
// same pull request, the same branch or repository, then meaning (vector neighbours).
// One pure helper so the manager's detail pane and Still's `threads.related` agree.
import { cosine } from './embeddings.js';
import type { ConversationRecord } from './schema.js';
import { groupByRepository, normalizePullRequestUrl, threadRepository } from './repository.js';

export type RelatedReason = 'same_conversation' | 'same_pull_request' | 'same_branch' | 'same_repository' | 'similar';

export interface RelatedThread {
  threadKey: string;
  reason: RelatedReason;
  /** Structural reasons score 2 to 5, so they always sort above similar threads (0 to 1). */
  score: number;
  /** Cosine similarity for `similar`; null for structural reasons. */
  similarity: number | null;
}

export interface FindRelatedInput {
  selected: ConversationRecord;
  conversations: ConversationRecord[];
  vectorOf: (threadKey: string) => number[] | Float32Array | null | undefined;
  threshold: number;
  limit?: number;
  isCodingProvider: (provider: string) => boolean;
}

export const DEFAULT_RELATED_LIMIT = 8;

const STRUCTURAL_SCORE: Record<Exclude<RelatedReason, 'similar'>, number> = {
  same_conversation: 5,
  same_pull_request: 4,
  same_branch: 3,
  same_repository: 2,
};

function recency(conv: ConversationRecord): number {
  const t = Date.parse(conv.updatedAt ?? conv.lastCapturedAt ?? conv.createdAt ?? '');
  return Number.isNaN(t) ? 0 : t;
}

export function findRelatedThreads(input: FindRelatedInput): RelatedThread[] {
  const { selected, vectorOf, threshold, isCodingProvider } = input;
  const limit = input.limit ?? DEFAULT_RELATED_LIMIT;
  if (limit <= 0) return [];

  const candidates = input.conversations.filter(
    (c) =>
      c.threadKey !== selected.threadKey &&
      !c.isSyntheticBenchmark &&
      // Branches of one conversation are not related threads, they are the same thread.
      !(c.accountId === selected.accountId && c.sourceConversationId === selected.sourceConversationId)
  );

  // Bare repository names fold into their owner/name group, the same way the library groups them.
  const pool = [selected, ...candidates];
  const { groups } = groupByRepository(pool, (c) => threadRepository(c, isCodingProvider));
  const repoGroup = groups.find((g) => g.items.includes(selected));
  const sameRepo = new Set(repoGroup ? repoGroup.items.map((c) => c.threadKey) : []);

  const selectedPr = normalizePullRequestUrl(selected.pullRequestUrl ?? null);
  const selectedVec = vectorOf(selected.threadKey);
  const found: Array<RelatedThread & { at: number }> = [];

  for (const c of candidates) {
    let reason: Exclude<RelatedReason, 'similar'> | null = null;
    if (c.provider === selected.provider && c.sourceConversationId === selected.sourceConversationId) {
      reason = 'same_conversation';
    } else if (selectedPr && normalizePullRequestUrl(c.pullRequestUrl ?? null) === selectedPr) {
      reason = 'same_pull_request';
    } else if (sameRepo.has(c.threadKey)) {
      reason = selected.gitBranch && c.gitBranch === selected.gitBranch ? 'same_branch' : 'same_repository';
    }
    if (reason) {
      found.push({ threadKey: c.threadKey, reason, score: STRUCTURAL_SCORE[reason], similarity: null, at: recency(c) });
      continue;
    }
    if (!selectedVec) continue;
    const vec = vectorOf(c.threadKey);
    if (!vec || vec.length !== selectedVec.length) continue;
    const sim = cosine(selectedVec, vec);
    if (sim >= threshold) found.push({ threadKey: c.threadKey, reason: 'similar', score: sim, similarity: sim, at: recency(c) });
  }

  found.sort((a, b) => b.score - a.score || b.at - a.at);
  return found.slice(0, limit).map(({ at: _at, ...rest }) => rest);
}
