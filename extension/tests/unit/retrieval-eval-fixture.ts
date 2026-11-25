// Offline retrieval evaluation over the synthetic fixtures (no network, no model calls).
// A labelled query set over seedSyntheticWorkbenchLibrary + seedWorkspaceDemoLibrary, the
// library the manager loads for ?seed=2, and the metrics used to compare ranking changes.
import { ThreadStackDB } from '../../src/core/db.js';
import { processThreadsLocally } from '../../src/core/pipeline.js';
import { resolveInsight } from '../../src/core/insights.js';
import { MemorySearchIndex } from '../../src/core/search.js';
import { seedSyntheticWorkbenchLibrary, seedWorkspaceDemoLibrary } from '../../src/core/synthetic-fixtures.js';
import {
  THREAD_KIND_LABELS,
  getDisplayTitle,
  type ConversationRecord,
  type MessageRecord,
  type StructuredSummaryRecord,
  type ThreadInsight,
  type ThreadVectorRecord,
} from '../../src/core/schema.js';

export interface LabelledQuery {
  id: string;
  intent: 'identifier' | 'paraphrase' | 'repository' | 'none';
  query: string;
  /** Display title -> grade (2 = the answer, 1 = also useful). Empty for queries with no good answer. */
  relevant: Record<string, 1 | 2>;
}

const T = {
  payments: 'Make the payments webhook idempotent',
  oddsQueue: 'Move the odds engine onto a job queue',
  walletReview: 'Review the wallet advisory lock change',
  signup: 'Signup page with a magic link',
  backfill: 'Backfill odds snapshots for settled markets',
  logoExport: 'Export the Meridian logo grid as SVG',
  releaseDaydock: 'Draft the release notes for Daydock 0.9',
  settlementLocks: 'Advisory locks around bet settlement',
  partnerGrid: 'Logo grid spacing for the Daydock partner page',
  pricingTeam: 'Pricing check for the team plan',
  releasePlain: 'Plain wording for HypeStake release notes',
  subjectLines: 'Signup email subject lines for the magic link',
  vendorPricing: 'Pricing page comparison of three sportsbook tools',
  oddsBot: 'Odds alert bot: wording for suspended markets',
  recap: 'Weekly recap dot',
  mountains: 'Plan a quiet weekend in the mountains',
  logoGeometry: 'Daydock / Meridian logo geometry & SVG grid',
  logoBranch: 'Daydock / Meridian logo geometry & SVG grid (branch_2)',
  wordmark: 'Daydock logo wordmark kerning & optical lockup',
  homepage: 'Daydock homepage research & pricing tier benchmarks',
  websocket: 'HypeStake odds engine WebSocket delta compression',
  velotic: 'Velotic / FrameConcepts WebGPU frame cache eviction',
  personal: 'Personal Q4 travel & family cabin checklist',
} as const;

export const TITLES = T;

/** 32 queries: exact identifiers, repositories and branches, paraphrases, and four with no good answer. */
export const LABELLED_QUERIES: LabelledQuery[] = [
  // Exact identifiers: file names, pull requests, functions, colours.
  { id: 'id-file-idempotency', intent: 'identifier', query: 'src/payments/idempotency.ts', relevant: { [T.payments]: 2, [T.walletReview]: 1 } },
  { id: 'id-pr-412', intent: 'identifier', query: 'pull request 412', relevant: { [T.payments]: 2, [T.walletReview]: 2 } },
  { id: 'id-pr-418', intent: 'identifier', query: 'PR 418', relevant: { [T.backfill]: 2 } },
  { id: 'id-sprite-script', intent: 'identifier', query: 'build-logo-sprite.mjs', relevant: { [T.logoExport]: 2 } },
  { id: 'id-mark-svg', intent: 'identifier', query: 'daydock-meridian-mark.svg', relevant: { [T.logoGeometry]: 2, [T.logoExport]: 1 } },
  { id: 'id-advisory-fn', intent: 'identifier', query: 'pg_advisory_xact_lock', relevant: { [T.walletReview]: 2 } },
  { id: 'id-settle-test', intent: 'identifier', query: 'settle.test.ts', relevant: { [T.settlementLocks]: 2 } },
  { id: 'id-magic-link-file', intent: 'identifier', query: 'magic-link.ts', relevant: { [T.signup]: 2 } },
  { id: 'id-import-texture', intent: 'identifier', query: 'importExternalTexture', relevant: { [T.velotic]: 2 } },
  { id: 'id-colour', intent: 'identifier', query: '#1F6F6B', relevant: { [T.logoGeometry]: 2 } },
  // Repositories and branches.
  { id: 'repo-branch-webhook', intent: 'repository', query: 'fix/webhook-idempotency', relevant: { [T.payments]: 2, [T.walletReview]: 2 } },
  { id: 'repo-branch-odds-queue', intent: 'repository', query: 'feat/odds-queue', relevant: { [T.oddsQueue]: 2 } },
  { id: 'repo-branch-settlement', intent: 'repository', query: 'settlement-locks branch', relevant: { [T.settlementLocks]: 2 } },
  {
    id: 'repo-hypestake',
    intent: 'repository',
    query: 'hypestake/hypestake',
    relevant: { [T.payments]: 2, [T.oddsQueue]: 2, [T.walletReview]: 2, [T.backfill]: 2, [T.settlementLocks]: 2 },
  },
  { id: 'repo-daydock', intent: 'repository', query: 'meridian/daydock', relevant: { [T.signup]: 2, [T.logoExport]: 2, [T.releaseDaydock]: 2 } },
  // Paraphrases: none of the query words is the thread's main wording.
  { id: 'para-double-credit', intent: 'paraphrase', query: 'stop deposits being credited twice', relevant: { [T.payments]: 2, [T.releasePlain]: 1, [T.walletReview]: 1 } },
  { id: 'para-settle-race', intent: 'paraphrase', query: 'two workers settle the same bet at once', relevant: { [T.settlementLocks]: 2, [T.walletReview]: 1 } },
  { id: 'para-partner-logos', intent: 'paraphrase', query: 'make partner logos look evenly weighted', relevant: { [T.partnerGrid]: 2 } },
  { id: 'para-passwordless', intent: 'paraphrase', query: 'passwordless sign in by email', relevant: { [T.signup]: 2, [T.subjectLines]: 2 } },
  { id: 'para-seat-pricing', intent: 'paraphrase', query: 'per seat or flat price for teams', relevant: { [T.pricingTeam]: 2 } },
  { id: 'para-hidden-prices', intent: 'paraphrase', query: 'vendors that hide prices behind a sales call', relevant: { [T.vendorPricing]: 2 } },
  { id: 'para-paused-market', intent: 'paraphrase', query: 'what the bot says when betting is paused', relevant: { [T.oddsBot]: 2 } },
  { id: 'para-reading-trip', intent: 'paraphrase', query: 'quiet trip to read and walk', relevant: { [T.mountains]: 2 } },
  { id: 'para-odds-bandwidth', intent: 'paraphrase', query: 'reduce bandwidth of live odds updates', relevant: { [T.websocket]: 2 } },
  { id: 'para-gpu-frames', intent: 'paraphrase', query: 'gpu memory budget for decoded video frames', relevant: { [T.velotic]: 2 } },
  { id: 'para-friday-notes', intent: 'paraphrase', query: 'friday summary of my weekly notes', relevant: { [T.recap]: 2 } },
  { id: 'para-wordmark-spacing', intent: 'paraphrase', query: 'letter spacing of the wordmark', relevant: { [T.wordmark]: 2 } },
  { id: 'para-changelog', intent: 'paraphrase', query: 'changelog for version 0.9', relevant: { [T.releaseDaydock]: 2, [T.releasePlain]: 1 } },
  // No good answer anywhere in the library.
  { id: 'none-helm', intent: 'none', query: 'kubernetes helm chart rollout', relevant: {} },
  { id: 'none-sourdough', intent: 'none', query: 'sourdough starter hydration', relevant: {} },
  { id: 'none-tax', intent: 'none', query: 'quarterly tax filing deadline', relevant: {} },
  { id: 'none-graphql', intent: 'none', query: 'graphql schema federation', relevant: {} },
];

export interface EvalLibrary {
  db: ThreadStackDB;
  conversations: ConversationRecord[];
  messages: MessageRecord[];
  messagesByThread: Map<string, MessageRecord[]>;
  summaries: StructuredSummaryRecord[];
  insightsByThread: Map<string, ThreadInsight>;
  vectorRows: ThreadVectorRecord[];
  vectorsByThread: Map<string, Map<string, number[]>>;
  searchIndex: MemorySearchIndex;
  keyByTitle: Map<string, string>;
}

let dbCounter = 0;

/** Seed both fixtures, run the on-device pass, and build what the manager builds (useLibraryData). */
export async function loadEvalLibrary(): Promise<EvalLibrary> {
  const db = new ThreadStackDB(`RetrievalEval_${Date.now()}_${++dbCounter}`);
  await seedSyntheticWorkbenchLibrary(db);
  await seedWorkspaceDemoLibrary(db);
  const keys = (await db.conversations.toCollection().primaryKeys()) as string[];
  await processThreadsLocally(db, keys, { aiDelaySeconds: 0, force: true });

  const [conversations, messages, summaries, insights, vectorRows] = await Promise.all([
    db.conversations.toArray(),
    db.messages.toArray(),
    db.summaries.toArray(),
    db.insights.toArray(),
    db.threadVectors.toArray(),
  ]);
  const messagesByThread = new Map<string, MessageRecord[]>();
  for (const m of messages) {
    const list = messagesByThread.get(m.threadKey) ?? [];
    list.push(m);
    messagesByThread.set(m.threadKey, list);
  }
  for (const list of messagesByThread.values()) list.sort((a, b) => a.ordinal - b.ordinal);
  const local = new Map<string, ThreadInsight>();
  const ai = new Map<string, ThreadInsight>();
  for (const i of insights) (i.source === 'ai' ? ai : local).set(i.threadKey, i);
  const insightsByThread = new Map<string, ThreadInsight>();
  for (const c of conversations) {
    const r = resolveInsight(c, local.get(c.threadKey), ai.get(c.threadKey));
    if (r) insightsByThread.set(c.threadKey, r);
  }
  const vectorsByThread = new Map<string, Map<string, number[]>>();
  for (const v of vectorRows) {
    const m = vectorsByThread.get(v.threadKey) ?? new Map<string, number[]>();
    m.set(v.space, v.embedding);
    vectorsByThread.set(v.threadKey, m);
  }
  const searchIndex = new MemorySearchIndex();
  const extra = new Map<string, string>();
  for (const [k, i] of insightsByThread) {
    extra.set(k, `${i.title} ${i.gist} ${i.summary} ${i.topics.join(' ')} ${i.entities.join(' ')} ${THREAD_KIND_LABELS[i.kind]}`);
  }
  searchIndex.loadSnapshot({ conversations, messages, summaries, extraMetaByThread: extra });
  const keyByTitle = new Map(conversations.map((c) => [getDisplayTitle(c), c.threadKey]));
  return { db, conversations, messages, messagesByThread, summaries, insightsByThread, vectorRows, vectorsByThread, searchIndex, keyByTitle };
}

export interface QueryMetrics {
  recall5: number;
  recall10: number;
  mrr: number;
  ndcg10: number;
}

function dcg(grades: number[]): number {
  return grades.reduce((sum, g, i) => sum + (2 ** g - 1) / Math.log2(i + 2), 0);
}

/** recall@k against every positively graded thread, first-hit reciprocal rank, graded nDCG@10. */
export function scoreRanking(ranking: string[], relevantByKey: Map<string, number>): QueryMetrics {
  const total = relevantByKey.size;
  const hitsAt = (k: number) => ranking.slice(0, k).filter((key) => relevantByKey.has(key)).length;
  const first = ranking.findIndex((key) => relevantByKey.has(key));
  const ideal = [...relevantByKey.values()].sort((a, b) => b - a).slice(0, 10);
  const got = ranking.slice(0, 10).map((key) => relevantByKey.get(key) ?? 0);
  return {
    recall5: hitsAt(5) / total,
    recall10: hitsAt(10) / total,
    mrr: first < 0 ? 0 : 1 / (first + 1),
    ndcg10: dcg(ideal) > 0 ? dcg(got) / dcg(ideal) : 0,
  };
}

export interface RunSummary extends QueryMetrics {
  /** Answerable queries scored. */
  queries: number;
  /** Mean results returned for the no-answer queries (lower is better: less noise). */
  noAnswerResults: number;
  perQuery: Record<string, QueryMetrics & { top: string[] }>;
}

export function evaluate(
  lib: EvalLibrary,
  rank: (query: string) => string[],
  queries: LabelledQuery[] = LABELLED_QUERIES
): RunSummary {
  const titleOf = new Map(lib.conversations.map((c) => [c.threadKey, getDisplayTitle(c)]));
  const answerable = queries.filter((q) => Object.keys(q.relevant).length > 0);
  const none = queries.filter((q) => Object.keys(q.relevant).length === 0);
  const perQuery: RunSummary['perQuery'] = {};
  const sum: QueryMetrics = { recall5: 0, recall10: 0, mrr: 0, ndcg10: 0 };
  for (const q of answerable) {
    const relevant = new Map<string, number>();
    for (const [title, grade] of Object.entries(q.relevant)) {
      const key = lib.keyByTitle.get(title);
      if (!key) throw new Error(`Fixture thread not found: ${title}`);
      relevant.set(key, grade);
    }
    const ranking = rank(q.query);
    const m = scoreRanking(ranking, relevant);
    perQuery[q.id] = { ...m, top: ranking.slice(0, 3).map((k) => titleOf.get(k) ?? k) };
    sum.recall5 += m.recall5;
    sum.recall10 += m.recall10;
    sum.mrr += m.mrr;
    sum.ndcg10 += m.ndcg10;
  }
  const n = answerable.length;
  const round = (x: number) => Math.round((x / n) * 1000) / 1000;
  let noise = 0;
  for (const q of none) {
    const ranking = rank(q.query);
    noise += ranking.length;
    perQuery[q.id] = { recall5: 0, recall10: 0, mrr: 0, ndcg10: 0, top: ranking.slice(0, 3).map((k) => titleOf.get(k) ?? k) };
  }
  return {
    queries: n,
    recall5: round(sum.recall5),
    recall10: round(sum.recall10),
    mrr: round(sum.mrr),
    ndcg10: round(sum.ndcg10),
    noAnswerResults: none.length ? Math.round((noise / none.length) * 100) / 100 : 0,
    perQuery,
  };
}
