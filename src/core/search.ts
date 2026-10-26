import {
  getDisplayTitle,
  computeDeterministicHash,
  type ConversationRecord,
  type MessageRecord,
  type StructuredSummaryRecord,
  type ChunkRecord,
  type VectorIndexEntry,
  type ProviderId,
  type CoverageState,
  type WorkflowState,
} from './schema.js';
import type { ThreadkeeperDB } from './db.js';

export interface SearchScopeFilter {
  accountId?: string;
  workspaceId?: string;
  provider?: ProviderId | 'all';
  project?: string | 'All threads';
  workflowState?: WorkflowState | 'all';
  coverage?: CoverageState | 'all';
  tag?: string | null;
  hasCode?: boolean;
  hasOpenQuestions?: boolean;
  includeSyntheticBenchmark?: boolean;
}

export interface SearchHit {
  conversation: ConversationRecord;
  score: number;
  lexicalScore: number;
  vectorScore: number;
  rerankScore: number | null;
  matchReasons: string[];
  supportingExcerpt: string;
  matchedMessageOrdinal: number | null;
}

export interface HybridSearchOptions {
  query: string;
  scope?: SearchScopeFilter;
  limit?: number;
  vectorQuery?: {
    indexType: 'standard' | 'contextual';
    model: 'voyage-4' | 'voyage-4-large' | 'voyage-context-4';
    dimensions: 256 | 512 | 1024 | 2048;
    embedding: number[];
  };
  reranker?: (
    query: string,
    documents: string[]
  ) => Promise<Array<{ index: number; relevanceScore: number }>>;
}

export interface HybridSearchResponse {
  hits: SearchHit[];
  totalScopedCandidates: number;
  elapsedMs: number;
  vectorRejectedReason: string | null;
  staleVectorsSkipped: number;
  rerankFallbackUsed: boolean;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_/-]+/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

function computeTrigrams(str: string): Set<string> {
  const clean = `  ${str.toLowerCase().trim()}  `;
  const set = new Set<string>();
  for (let i = 0; i <= clean.length - 3; i++) {
    set.add(clean.slice(i, i + 3));
  }
  return set;
}

export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = computeTrigrams(a);
  const tb = computeTrigrams(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersection = 0;
  for (const t of ta) {
    if (tb.has(t)) intersection += 1;
  }
  return (2 * intersection) / (ta.size + tb.size);
}

export function boundedLevenshtein(a: string, b: string, maxDist = 2): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  if (la === lb) return 0;
  if (Math.abs(la.length - lb.length) > maxDist) return maxDist + 1;
  const prev = new Array(lb.length + 1).fill(0).map((_, i) => i);
  const curr = new Array(lb.length + 1).fill(0);
  for (let i = 1; i <= la.length; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= lb.length; j++) {
      const cost = la[i - 1] === lb[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    for (let j = 0; j <= lb.length; j++) prev[j] = curr[j];
  }
  return prev[lb.length];
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function computeContextGroupHash(chunks: ChunkRecord[]): string {
  const ordered = [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  return computeDeterministicHash(
    ordered.map((c) => `${c.chunkIndex}:${c.contentHash}`).join('|')
  );
}

export function validateVectorCompatibility(params: {
  indexType: 'standard' | 'contextual';
  model: string;
  dimensions: number;
  embeddingLength: number;
}): { valid: boolean; reason?: string } {
  if (params.indexType === 'standard') {
    if (params.model !== 'voyage-4' && params.model !== 'voyage-4-large') {
      return {
        valid: false,
        reason: `Standard vector index requires voyage-4 or voyage-4-large, got ${params.model}`,
      };
    }
  } else if (params.indexType === 'contextual') {
    if (params.model !== 'voyage-context-4') {
      return {
        valid: false,
        reason: `Contextual vector index requires voyage-context-4, got ${params.model}`,
      };
    }
  }
  if (params.embeddingLength !== params.dimensions) {
    return {
      valid: false,
      reason: `Vector dimension mismatch: expected ${params.dimensions}, got ${params.embeddingLength}`,
    };
  }
  return { valid: true };
}

export async function storeVectorEntries(
  db: ThreadkeeperDB,
  params: {
    indexType: 'standard' | 'contextual';
    model: 'voyage-4' | 'voyage-4-large' | 'voyage-context-4';
    dimensions: 256 | 512 | 1024 | 2048;
    threadKey: string;
    embeddingsByChunkKey: Array<{ chunkKey: string; embedding: number[] }>;
  }
): Promise<{ stored: number; rejectedReason?: string }> {
  const conv = await db.conversations.get(params.threadKey);
  if (!conv) {
    return { stored: 0, rejectedReason: 'Thread not found' };
  }
  const chunks = await db.chunks
    .where('threadKey')
    .equals(params.threadKey)
    .sortBy('chunkIndex');
  const contextGroupHash =
    params.indexType === 'contextual' ? computeContextGroupHash(chunks) : null;

  const entries: VectorIndexEntry[] = [];
  const now = new Date().toISOString();

  for (const item of params.embeddingsByChunkKey) {
    const check = validateVectorCompatibility({
      indexType: params.indexType,
      model: params.model,
      dimensions: params.dimensions,
      embeddingLength: item.embedding.length,
    });
    if (!check.valid) {
      return { stored: 0, rejectedReason: check.reason };
    }
    entries.push({
      vectorKey: `${params.indexType}:${params.model}:${params.dimensions}:${item.chunkKey}`,
      indexType: params.indexType,
      model: params.model,
      dimensions: params.dimensions,
      threadKey: params.threadKey,
      chunkKey: item.chunkKey,
      accountId: conv.accountId,
      workspaceId: conv.workspaceId,
      provider: conv.provider,
      sourceRevision: conv.sourceRevision,
      contextGroupHash,
      embedding: item.embedding,
      updatedAt: now,
    });
  }

  await db.vectors.bulkPut(entries);
  return { stored: entries.length };
}

export function matchesScopeFilter(
  conv: ConversationRecord,
  scope: SearchScopeFilter | undefined,
  summary: StructuredSummaryRecord | undefined,
  hasCodeInMessages: boolean
): boolean {
  if (!scope) {
    return !conv.isSyntheticBenchmark;
  }
  if (!scope.includeSyntheticBenchmark && conv.isSyntheticBenchmark) {
    return false;
  }
  if (scope.accountId && conv.accountId !== scope.accountId) {
    return false;
  }
  if (scope.workspaceId && conv.workspaceId !== scope.workspaceId) {
    return false;
  }
  if (scope.provider && scope.provider !== 'all' && conv.provider !== scope.provider) {
    return false;
  }
  if (
    scope.project &&
    scope.project !== 'All threads' &&
    conv.project !== scope.project
  ) {
    return false;
  }
  if (
    scope.workflowState &&
    scope.workflowState !== 'all' &&
    conv.workflowState !== scope.workflowState
  ) {
    return false;
  }
  if (
    scope.coverage &&
    scope.coverage !== 'all' &&
    conv.coverage !== scope.coverage
  ) {
    return false;
  }
  if (scope.tag) {
    const lowerTag = scope.tag.toLowerCase();
    const hasTag = conv.tags.some((t) => t.toLowerCase() === lowerTag);
    if (!hasTag) return false;
  }
  if (scope.hasCode && !hasCodeInMessages) {
    return false;
  }
  if (scope.hasOpenQuestions) {
    const openCount = summary?.openQuestions.length ?? 0;
    if (openCount === 0 && conv.workflowState !== 'needs_review') {
      return false;
    }
  }
  return true;
}

function buildExcerpt(text: string, queryLower: string, maxLen = 160): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  const idx = clean.toLowerCase().indexOf(queryLower);
  if (idx === -1) return `${clean.slice(0, maxLen - 1)}…`;
  const start = Math.max(0, idx - 40);
  const slice = clean.slice(start, start + maxLen);
  return `${start > 0 ? '…' : ''}${slice}${start + maxLen < clean.length ? '…' : ''}`;
}

export class MemorySearchIndex {
  private conversations: ConversationRecord[] = [];
  private messagesByThread = new Map<string, MessageRecord[]>();
  private lowerMessagesByThread = new Map<
    string,
    Array<{ msg: MessageRecord; lower: string }>
  >();
  private lowerThreadTranscriptByThread = new Map<string, string>();
  private summariesByThread = new Map<string, StructuredSummaryRecord>();
  private hasCodeByThread = new Map<string, boolean>();
  private lowerTitleByThread = new Map<string, string>();
  private titleTokensByThread = new Map<string, string[]>();
  private titleTrigramsByThread = new Map<string, Set<string>>();
  private lowerMetaByThread = new Map<string, string>();

  loadSnapshot(params: {
    conversations: ConversationRecord[];
    messages?: MessageRecord[];
    messagesByThread?: Map<string, MessageRecord[]>;
    summaries?: StructuredSummaryRecord[];
  }): void {
    this.conversations = params.conversations;
    this.messagesByThread.clear();
    this.lowerMessagesByThread.clear();
    this.lowerThreadTranscriptByThread.clear();
    this.summariesByThread.clear();
    this.hasCodeByThread.clear();
    this.lowerTitleByThread.clear();
    this.titleTokensByThread.clear();
    this.titleTrigramsByThread.clear();
    this.lowerMetaByThread.clear();

    if (params.messagesByThread) {
      for (const [threadKey, list] of params.messagesByThread.entries()) {
        this.messagesByThread.set(threadKey, list);
        const lowerList: Array<{ msg: MessageRecord; lower: string }> = [];
        const parts: string[] = [];
        for (const m of list) {
          const lower = m.content.toLowerCase();
          lowerList.push({ msg: m, lower });
          parts.push(lower);
          if (m.hasCode) {
            this.hasCodeByThread.set(threadKey, true);
          }
        }
        this.lowerMessagesByThread.set(threadKey, lowerList);
        this.lowerThreadTranscriptByThread.set(threadKey, parts.join('\n'));
      }
    } else if (params.messages) {
      for (const m of params.messages) {
        const list = this.messagesByThread.get(m.threadKey) ?? [];
        list.push(m);
        this.messagesByThread.set(m.threadKey, list);
        if (m.hasCode) {
          this.hasCodeByThread.set(m.threadKey, true);
        }
      }
      for (const [threadKey, list] of this.messagesByThread.entries()) {
        const lowerList: Array<{ msg: MessageRecord; lower: string }> = [];
        const parts: string[] = [];
        for (const m of list) {
          const lower = m.content.toLowerCase();
          lowerList.push({ msg: m, lower });
          parts.push(lower);
        }
        this.lowerMessagesByThread.set(threadKey, lowerList);
        this.lowerThreadTranscriptByThread.set(threadKey, parts.join('\n'));
      }
    }

    if (params.summaries) {
      for (const s of params.summaries) {
        this.summariesByThread.set(s.threadKey, s);
      }
    }

    for (const c of this.conversations) {
      const display = getDisplayTitle(c).toLowerCase();
      this.lowerTitleByThread.set(c.threadKey, display);
      this.titleTokensByThread.set(c.threadKey, tokenize(display));
      this.titleTrigramsByThread.set(c.threadKey, computeTrigrams(display));
      this.lowerMetaByThread.set(
        c.threadKey,
        `${c.project} ${c.tags.join(' ')} ${c.manualNotes} ${c.latestDecisionText ?? ''} ${c.nextStepText ?? ''}`.toLowerCase()
      );
    }
  }

  searchLocal(
    query: string,
    scope?: SearchScopeFilter,
    limit = 50
  ): { hits: SearchHit[]; totalScopedCandidates: number; elapsedMs: number } {
    const start = performance.now();
    const rawQuery = query.trim();
    const cleanQuery = rawQuery.replace(/^"+|"+$/g, '').trim().toLowerCase();
    const queryTokens = tokenize(cleanQuery);
    const queryTrigrams =
      cleanQuery.length >= 5 ? computeTrigrams(cleanQuery) : null;

    const hits: SearchHit[] = [];
    let totalScopedCandidates = 0;

    for (const conv of this.conversations) {
      const summary = this.summariesByThread.get(conv.threadKey);
      const hasCode =
        this.hasCodeByThread.get(conv.threadKey) ??
        conv.tags.includes('code');

      if (!matchesScopeFilter(conv, scope, summary, hasCode)) {
        continue;
      }
      totalScopedCandidates += 1;

      if (!cleanQuery) {
        hits.push({
          conversation: conv,
          score: 1,
          lexicalScore: 1,
          vectorScore: 0,
          rerankScore: null,
          matchReasons: ['Recent thread in scope'],
          supportingExcerpt:
            summary?.whereYouLeftOff ??
            conv.latestDecisionText ??
            conv.nextStepText ??
            getDisplayTitle(conv),
          matchedMessageOrdinal:
            summary?.whereYouLeftOffMessageIndexes[0] ??
            conv.latestDecisionMsgIndex ??
            0,
        });
        continue;
      }

      const displayTitle = getDisplayTitle(conv);
      const titleLower =
        this.lowerTitleByThread.get(conv.threadKey) ??
        displayTitle.toLowerCase();
      const titleTokens =
        this.titleTokensByThread.get(conv.threadKey) ?? tokenize(titleLower);

      let lexicalScore = 0;
      const matchReasons: string[] = [];
      let supportingExcerpt = '';
      let matchedMessageOrdinal: number | null = null;

      // 1. Exact phrase or substring in title
      if (titleLower.includes(cleanQuery)) {
        lexicalScore += 35;
        matchReasons.push('Title match');
        supportingExcerpt = displayTitle;
      } else if (queryTokens.length > 0) {
        // Token overlap or fuzzy token match in title
        let matchedTitleTokens = 0;
        let fuzzyMatched = false;
        for (const qt of queryTokens) {
          if (titleTokens.some((tt) => tt.includes(qt) || qt.includes(tt))) {
            matchedTitleTokens += 1;
          } else if (
            qt.length >= 4 &&
            qt.length <= 18 &&
            titleTokens.some((tt) => boundedLevenshtein(qt, tt, 2) <= 2)
          ) {
            matchedTitleTokens += 1;
            fuzzyMatched = true;
          }
        }
        if (matchedTitleTokens === queryTokens.length) {
          lexicalScore += fuzzyMatched ? 22 : 28;
          matchReasons.push(fuzzyMatched ? 'Fuzzy title match' : 'Title keywords');
          supportingExcerpt = displayTitle;
        } else if (matchedTitleTokens > 0) {
          lexicalScore += matchedTitleTokens * 8;
          matchReasons.push('Title keyword overlap');
          supportingExcerpt = displayTitle;
        } else if (queryTrigrams && queryTrigrams.size > 0) {
          const titleTris = this.titleTrigramsByThread.get(conv.threadKey);
          if (titleTris && titleTris.size > 0) {
            let intersection = 0;
            for (const t of queryTrigrams) {
              if (titleTris.has(t)) intersection += 1;
            }
            const sim = (2 * intersection) / (queryTrigrams.size + titleTris.size);
            if (sim >= 0.42) {
              lexicalScore += Math.round(sim * 25);
              matchReasons.push('Fuzzy title match');
              supportingExcerpt = displayTitle;
            }
          }
        }
      }

      // 2. Tags, project, manual notes, cached decision/next-step
      const metaLower =
        this.lowerMetaByThread.get(conv.threadKey) ??
        `${conv.project} ${conv.tags.join(' ')} ${conv.manualNotes} ${conv.latestDecisionText ?? ''} ${conv.nextStepText ?? ''}`.toLowerCase();
      if (metaLower.includes(cleanQuery)) {
        lexicalScore += 18;
        matchReasons.push('Project, tag, or decision metadata match');
        if (!supportingExcerpt) {
          supportingExcerpt =
            conv.latestDecisionText ||
            conv.nextStepText ||
            conv.manualNotes ||
            displayTitle;
          matchedMessageOrdinal = conv.latestDecisionMsgIndex ?? conv.nextStepMsgIndex ?? null;
        }
      } else if (queryTokens.length > 1) {
        const matchedMetaTokens = queryTokens.filter((t) => metaLower.includes(t));
        if (matchedMetaTokens.length === queryTokens.length) {
          lexicalScore += 12;
          matchReasons.push('Metadata keyword match');
          if (!supportingExcerpt) {
            supportingExcerpt =
              conv.latestDecisionText || conv.nextStepText || displayTitle;
          }
        } else if (matchedMetaTokens.length > 0) {
          lexicalScore += matchedMetaTokens.length * 4;
          matchReasons.push('Metadata keyword overlap');
          if (!supportingExcerpt) {
            supportingExcerpt =
              conv.latestDecisionText || conv.nextStepText || displayTitle;
          }
        }
      }

      // 3. Summary fields
      if (summary) {
        const summaryText = [
          summary.whereYouLeftOff,
          summary.currentStatus,
          ...summary.decisions.map((d) => d.text),
          ...summary.openQuestions.map((q) => q.text),
          ...summary.actionItems.map((a) => a.text),
        ]
          .join(' ')
          .toLowerCase();
        if (summaryText.includes(cleanQuery)) {
          lexicalScore += 20;
          matchReasons.push('Structured summary match');
          if (!supportingExcerpt) {
            supportingExcerpt = summary.whereYouLeftOff;
            matchedMessageOrdinal =
              summary.whereYouLeftOffMessageIndexes[0] ?? 0;
          }
        }
      }

      // 4. Original message transcript search
      const threadTranscript = this.lowerThreadTranscriptByThread.get(
        conv.threadKey
      );
      if (
        threadTranscript &&
        (threadTranscript.includes(cleanQuery) ||
          (queryTokens.length > 1 &&
            queryTokens.some((qt) => threadTranscript.includes(qt))))
      ) {
        const lowerMessages =
          this.lowerMessagesByThread.get(conv.threadKey) ?? [];
        for (const item of lowerMessages) {
          const m = item.msg;
          const contentLower = item.lower;
          if (contentLower.includes(cleanQuery)) {
            lexicalScore += 25;
            matchReasons.push(`Exact match in message m${m.ordinal + 1}`);
            supportingExcerpt = buildExcerpt(m.content, cleanQuery);
            matchedMessageOrdinal = m.ordinal;
            break;
          } else if (queryTokens.length > 1) {
            const matchedMsgTokens = queryTokens.filter((qt) =>
              contentLower.includes(qt)
            );
            if (matchedMsgTokens.length === queryTokens.length) {
              lexicalScore += 14;
              matchReasons.push(`Keywords in message m${m.ordinal + 1}`);
              if (!supportingExcerpt) {
                supportingExcerpt = buildExcerpt(m.content, matchedMsgTokens[0]);
                matchedMessageOrdinal = m.ordinal;
              }
            } else if (matchedMsgTokens.length > 0) {
              lexicalScore += matchedMsgTokens.length * 5;
              matchReasons.push(`Keyword overlap in message m${m.ordinal + 1}`);
              if (!supportingExcerpt) {
                supportingExcerpt = buildExcerpt(m.content, matchedMsgTokens[0]);
                matchedMessageOrdinal = m.ordinal;
              }
            }
          }
        }
      }

      if (lexicalScore > 0) {
        hits.push({
          conversation: conv,
          score: lexicalScore,
          lexicalScore,
          vectorScore: 0,
          rerankScore: null,
          matchReasons,
          supportingExcerpt: supportingExcerpt || displayTitle,
          matchedMessageOrdinal,
        });
      }
    }

    hits.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.conversation.updatedAt ?? '').localeCompare(
        a.conversation.updatedAt ?? ''
      );
    });

    const elapsedMs = performance.now() - start;
    return {
      hits: hits.slice(0, limit),
      totalScopedCandidates,
      elapsedMs,
    };
  }
}

export async function runHybridSearch(
  db: ThreadkeeperDB,
  options: HybridSearchOptions
): Promise<HybridSearchResponse> {
  const start = performance.now();
  const limit = options.limit ?? 50;

  const [conversations, messages, summaries] = await Promise.all([
    db.conversations.toArray(),
    db.messages.toArray(),
    db.summaries.toArray(),
  ]);

  const memIndex = new MemorySearchIndex();
  memIndex.loadSnapshot({ conversations, messages, summaries });

  const localRes = memIndex.searchLocal(options.query, options.scope, 200);
  const convByKey = new Map(conversations.map((c) => [c.threadKey, c]));
  const chunksByThread = new Map<string, ChunkRecord[]>();

  let vectorRejectedReason: string | null = null;
  let staleVectorsSkipped = 0;
  const vectorScoresByThread = new Map<
    string,
    { score: number; chunkText: string; messageOrdinal: number }
  >();

  if (options.vectorQuery) {
    const vq = options.vectorQuery;
    const compat = validateVectorCompatibility({
      indexType: vq.indexType,
      model: vq.model,
      dimensions: vq.dimensions,
      embeddingLength: vq.embedding.length,
    });

    if (!compat.valid) {
      vectorRejectedReason = compat.reason ?? 'Invalid vector query parameters';
    } else {
      const allChunks = await db.chunks.toArray();
      for (const ch of allChunks) {
        const list = chunksByThread.get(ch.threadKey) ?? [];
        list.push(ch);
        chunksByThread.set(ch.threadKey, list);
      }

      const candidateVectors = await db.vectors
        .where('[indexType+model+dimensions]')
        .equals([vq.indexType, vq.model, vq.dimensions])
        .toArray();

      const summaryMap = new Map(summaries.map((s) => [s.threadKey, s]));

      for (const vec of candidateVectors) {
        const conv = convByKey.get(vec.threadKey);
        if (!conv) continue;

        // Enforce scope filtering BEFORE vector scoring
        if (
          !matchesScopeFilter(
            conv,
            options.scope,
            summaryMap.get(conv.threadKey),
            false
          )
        ) {
          continue;
        }

        // Reject stale sourceRevision or mismatched dimension
        if (
          vec.sourceRevision !== conv.sourceRevision ||
          vec.embedding.length !== vq.dimensions
        ) {
          staleVectorsSkipped += 1;
          continue;
        }

        // For contextual index, verify contextGroupHash matches current thread chunks
        if (vq.indexType === 'contextual') {
          const threadChunks = chunksByThread.get(conv.threadKey) ?? [];
          const expectedGroupHash = computeContextGroupHash(threadChunks);
          if (!vec.contextGroupHash || vec.contextGroupHash !== expectedGroupHash) {
            staleVectorsSkipped += 1;
            continue;
          }
        }

        const sim = cosineSimilarity(vq.embedding, vec.embedding);
        if (sim > 0.25) {
          const prev = vectorScoresByThread.get(conv.threadKey);
          if (!prev || sim > prev.score) {
            const matchedChunk = (chunksByThread.get(conv.threadKey) ?? []).find(
              (c) => c.chunkKey === vec.chunkKey
            );
            vectorScoresByThread.set(conv.threadKey, {
              score: sim,
              chunkText: matchedChunk?.text ?? getDisplayTitle(conv),
              messageOrdinal: matchedChunk?.messageStartOrdinal ?? 0,
            });
          }
        }
      }
    }
  }

  // Reciprocal Rank Fusion (RRF) of lexical hits + semantic vector hits
  const rrfK = 60;
  const hitByThread = new Map<string, SearchHit>();

  localRes.hits.forEach((hit, idx) => {
    const rrfLexical = 1 / (rrfK + idx + 1);
    hitByThread.set(hit.conversation.threadKey, {
      ...hit,
      score: rrfLexical,
    });
  });

  const sortedVectorEntries = Array.from(vectorScoresByThread.entries()).sort(
    (a, b) => b[1].score - a[1].score
  );

  sortedVectorEntries.forEach(([threadKey, vecHit], idx) => {
    const rrfVec = 1 / (rrfK + idx + 1);
    const existing = hitByThread.get(threadKey);
    if (existing) {
      existing.score += rrfVec;
      existing.vectorScore = vecHit.score;
      if (!existing.matchReasons.includes('Semantic vector similarity')) {
        existing.matchReasons.push('Semantic vector similarity');
      }
    } else {
      const conv = convByKey.get(threadKey);
      if (conv) {
        hitByThread.set(threadKey, {
          conversation: conv,
          score: rrfVec,
          lexicalScore: 0,
          vectorScore: vecHit.score,
          rerankScore: null,
          matchReasons: ['Semantic vector similarity'],
          supportingExcerpt: buildExcerpt(vecHit.chunkText, options.query),
          matchedMessageOrdinal: vecHit.messageOrdinal,
        });
      }
    }
  });

  let mergedHits = Array.from(hitByThread.values()).sort(
    (a, b) => b.score - a.score
  );

  let rerankFallbackUsed = false;
  if (options.reranker && mergedHits.length > 1 && options.query.trim().length > 0) {
    const shortlist = mergedHits.slice(0, Math.min(20, mergedHits.length));
    try {
      const reranked = await options.reranker(
        options.query,
        shortlist.map(
          (h) => `${getDisplayTitle(h.conversation)}\n${h.supportingExcerpt}`
        )
      );
      if (
        !Array.isArray(reranked) ||
        reranked.length === 0 ||
        reranked.some(
          (r) =>
            typeof r.index !== 'number' ||
            r.index < 0 ||
            r.index >= shortlist.length ||
            !Number.isFinite(r.relevanceScore)
        )
      ) {
        rerankFallbackUsed = true;
      } else {
        for (const r of reranked) {
          const item = shortlist[r.index];
          item.rerankScore = r.relevanceScore;
          item.score = item.score + r.relevanceScore;
        }
        mergedHits = [
          ...shortlist.sort((a, b) => b.score - a.score),
          ...mergedHits.slice(shortlist.length),
        ];
      }
    } catch {
      rerankFallbackUsed = true;
    }
  }

  return {
    hits: mergedHits.slice(0, limit),
    totalScopedCandidates: localRes.totalScopedCandidates,
    elapsedMs: performance.now() - start,
    vectorRejectedReason,
    staleVectorsSkipped,
    rerankFallbackUsed,
  };
}
