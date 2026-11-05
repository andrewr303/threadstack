import {
  computeDeterministicHash,
  type BedrockRerankModel,
  type ConversationRecord,
  type MessageRecord,
  type SettingsRecord,
} from './schema.js';
import type { ThreadkeeperDB } from './db.js';
import {
  AwsRequestError,
  awsCredentialsReady,
  awsHostOrigins,
  awsPostJson,
  bedrockAgentRuntimeUrl,
  bedrockRuntimeUrl,
  createAwsFetch,
  hasHostAccess,
  isValidAwsRegion,
} from './aws.js';
import { EmbeddingError, postJson } from './embeddings.js';
import { COHERE_BASE_URL, COHERE_ORIGIN, MONGODB_KEY_HINT, mongodbBaseUrl, mongodbOrigin, voyageBaseUrl, voyageOrigin } from './model-apis.js';

/**
 * Second-stage reranking for search and Ask.
 *
 * A cross-encoder (Voyage rerank-3 / rerank-3-lite directly or through
 * MongoDB Atlas, Cohere Rerank v5 / v4 / v3.5 directly, or Cohere Rerank 3.5 /
 * Amazon Rerank 1.0 on Amazon Bedrock) re-reads the best first-stage
 * candidates against the query. Only short per-thread documents are sent
 * (title, gist, one excerpt), only on an explicit submit, and never for
 * local-only threads; those keep their first-stage position.
 */

export interface RerankResult {
  /** Position in the `documents` array passed in. */
  index: number;
  /** Relevance score from the reranker, 0–1. */
  score: number;
}

export class RerankError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'RerankError';
  }
}

/** Voyage and the Bedrock Rerank API both accept at most 1000 documents per request. */
export const RERANK_MAX_DOCUMENTS = 1000;
/** Per-document cap. Documents are title + gist + one excerpt, far below every model's context. */
export const RERANK_MAX_DOC_CHARS = 1500;
const RERANK_MAX_QUERY_CHARS = 2000;
const RERANK_TIMEOUT_MS = 8000;

/** In-region availability of the Bedrock rerankers (no geo or global inference profiles). */
export const BEDROCK_RERANK_REGIONS: Record<BedrockRerankModel, readonly string[]> = {
  'cohere.rerank-v3-5:0': ['us-east-1', 'us-west-2', 'ca-central-1', 'eu-central-1', 'ap-northeast-1'],
  'amazon.rerank-v1:0': ['us-west-2', 'ca-central-1', 'eu-central-1', 'ap-northeast-1'],
};

const BEDROCK_RERANK_LABELS: Record<BedrockRerankModel, string> = {
  'cohere.rerank-v3-5:0': 'Cohere Rerank 3.5',
  'amazon.rerank-v1:0': 'Amazon Rerank 1.0',
};

const AMAZON_RERANK_NEEDS_IAM =
  'Amazon Rerank 1.0 needs IAM access keys: Bedrock API keys are not accepted by the Bedrock Rerank API. Switch the AWS credentials to IAM access keys, or choose Cohere Rerank 3.5.';

/** Human-readable name of the configured reranker, e.g. "rerank-3-lite" or "Cohere Rerank 3.5". */
export function rerankModelLabel(settings: SettingsRecord): string {
  switch (settings.rerankProvider) {
    case 'voyage':
      return settings.rerankModel;
    case 'mongodb':
      return `${settings.mongodbRerankModel} (Atlas)`;
    case 'cohere':
      return `Cohere ${settings.cohereRerankModel}`;
    case 'bedrock':
      return BEDROCK_RERANK_LABELS[settings.bedrockRerankModel] ?? settings.bedrockRerankModel;
    default:
      return 'none';
  }
}

/** Why the configured reranker cannot run, in words Settings can show. Null when ready. */
export function rerankProblem(settings: SettingsRecord): string | null {
  switch (settings.rerankProvider) {
    case 'voyage':
      return settings.voyageApiKey.trim() ? null : 'Add a Voyage API key to rerank with Voyage.';
    case 'mongodb':
      return settings.mongodbApiKey.trim() ? null : 'Add a MongoDB Atlas model API key to rerank with Atlas.';
    case 'cohere':
      return settings.cohereApiKey.trim() ? null : 'Add a Cohere API key to rerank with Cohere.';
    case 'bedrock': {
      const { aws } = settings;
      const region = aws.region.trim();
      if (!isValidAwsRegion(region)) return 'Enter an AWS region such as us-west-2.';
      if (!awsCredentialsReady(aws)) {
        return aws.auth === 'api_key' ? 'Add a Bedrock API key.' : 'Add an AWS access key ID and secret access key.';
      }
      const model = settings.bedrockRerankModel;
      if (model === 'amazon.rerank-v1:0' && aws.auth === 'api_key') return AMAZON_RERANK_NEEDS_IAM;
      const regions = BEDROCK_RERANK_REGIONS[model];
      if (!regions) return `Unknown Bedrock reranker ${model}.`;
      if (!regions.includes(region)) {
        return `${BEDROCK_RERANK_LABELS[model]} is not available in ${region}. Use one of: ${regions.join(', ')}.`;
      }
      return null;
    }
    default:
      return 'No reranker is selected.';
  }
}

/** The configured provider's model id, used in cache keys so scores never cross models. */
function rerankModelId(settings: SettingsRecord): string {
  switch (settings.rerankProvider) {
    case 'voyage':
      return `${settings.rerankModel}@${voyageBaseUrl(settings)}`;
    case 'mongodb':
      // Same model name on a different account/host is a different scoring service.
      return `${settings.mongodbRerankModel}@${settings.mongodbGeography}`;
    case 'cohere':
      return settings.cohereRerankModel;
    default:
      return settings.bedrockRerankModel;
  }
}

export function rerankReady(settings: SettingsRecord): boolean {
  return rerankProblem(settings) === null;
}

/**
 * Host access the configured reranker needs. IAM keys use the Rerank API on
 * bedrock-agent-runtime; Bedrock API keys are not accepted there, so key-based
 * reranking goes through InvokeModel on bedrock-runtime.
 */
export function rerankHostOrigins(settings: SettingsRecord): string[] {
  switch (settings.rerankProvider) {
    case 'voyage':
      return [voyageOrigin(settings)];
    case 'mongodb':
      return [mongodbOrigin(settings.mongodbGeography)];
    case 'cohere':
      return [COHERE_ORIGIN];
    case 'bedrock':
      return isValidAwsRegion(settings.aws.region)
        ? awsHostOrigins(settings.aws.region, [settings.aws.auth === 'iam' ? 'agent' : 'runtime'])
        : [];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// Score cache
// ---------------------------------------------------------------------------

/**
 * Small in-memory LRU of relevance scores, keyed by provider, model, query
 * and document hash. Scores of a cross-encoder depend only on the (query,
 * document) pair, so a cached score stays valid in any candidate set, and an
 * edited thread produces a new document hash and misses naturally.
 */
const CACHE_LIMIT = 2000;
const scoreCache = new Map<string, number>();

function cacheKey(provider: string, model: string, queryHash: string, doc: string): string {
  return `${provider}|${model}|${queryHash}|${computeDeterministicHash(doc)}`;
}

function cacheGet(key: string): number | undefined {
  const v = scoreCache.get(key);
  if (v === undefined) return undefined;
  scoreCache.delete(key);
  scoreCache.set(key, v);
  return v;
}

function cacheSet(key: string, score: number): void {
  scoreCache.delete(key);
  scoreCache.set(key, score);
  while (scoreCache.size > CACHE_LIMIT) {
    const oldest = scoreCache.keys().next().value;
    if (oldest === undefined) break;
    scoreCache.delete(oldest);
  }
}

export function clearRerankCache(): void {
  scoreCache.clear();
}

// ---------------------------------------------------------------------------
// Provider calls
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read `[{index, <scoreField>}]` from an untrusted response and check every index. */
function parseScoredList(list: unknown, scoreField: string, count: number, who: string): RerankResult[] {
  if (!Array.isArray(list)) throw new RerankError(`${who} returned no results`);
  return list.map((item) => {
    const index = isRecord(item) ? item.index : undefined;
    const score = isRecord(item) ? item[scoreField] : undefined;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new RerankError(`${who} returned an out-of-range document index`);
    }
    if (typeof score !== 'number' || !Number.isFinite(score)) {
      throw new RerankError(`${who} returned a non-numeric relevance score`);
    }
    return { index, score };
  });
}

function asRerankError(err: unknown): unknown {
  if (err instanceof AwsRequestError || err instanceof EmbeddingError) return new RerankError(err.message, err.status);
  return err;
}

async function rerankWithVoyage(
  settings: SettingsRecord,
  query: string,
  documents: string[],
  fetchImpl: typeof fetch
): Promise<RerankResult[]> {
  // top_k = all documents: Voyage bills every document either way, and full
  // scores let the cache serve any later subset.
  const body = await postJson(
    fetchImpl,
    `${voyageBaseUrl(settings)}/rerank`,
    { Authorization: `Bearer ${settings.voyageApiKey.trim()}` },
    { query, documents, model: settings.rerankModel, top_k: documents.length, truncation: true }
  );
  return parseScoredList(isRecord(body) ? body.data : undefined, 'relevance_score', documents.length, 'Voyage');
}

/** Voyage rerank models on MongoDB Atlas: the Voyage request shape on ai.mongodb.com with an Atlas key. */
async function rerankWithMongoDb(
  settings: SettingsRecord,
  query: string,
  documents: string[],
  fetchImpl: typeof fetch
): Promise<RerankResult[]> {
  try {
    const body = await postJson(
      fetchImpl,
      `${mongodbBaseUrl(settings.mongodbGeography)}/rerank`,
      { Authorization: `Bearer ${settings.mongodbApiKey.trim()}` },
      { query, documents, model: settings.mongodbRerankModel, top_k: documents.length, truncation: true }
    );
    return parseScoredList(isRecord(body) ? body.data : undefined, 'relevance_score', documents.length, 'MongoDB Atlas');
  } catch (err) {
    if (err instanceof EmbeddingError && (err.status === 401 || err.status === 403)) {
      throw new EmbeddingError(`${err.message}. ${MONGODB_KEY_HINT}`, err.status);
    }
    throw err;
  }
}

/** Cohere v2 /rerank: `results` sorted best first, each `{index, relevance_score}` in [0, 1]. */
async function rerankWithCohere(
  settings: SettingsRecord,
  query: string,
  documents: string[],
  fetchImpl: typeof fetch
): Promise<RerankResult[]> {
  const body = await postJson(
    fetchImpl,
    `${COHERE_BASE_URL}/rerank`,
    { Authorization: `Bearer ${settings.cohereApiKey.trim()}` },
    { model: settings.cohereRerankModel, query, documents, top_n: documents.length }
  );
  return parseScoredList(isRecord(body) ? body.results : undefined, 'relevance_score', documents.length, 'Cohere');
}

/** Rerank API (Agents for Amazon Bedrock Runtime). SigV4 only, signed as service "bedrock". */
async function rerankWithBedrockRerankApi(
  settings: SettingsRecord,
  query: string,
  documents: string[],
  fetchImpl: typeof fetch
): Promise<RerankResult[]> {
  const region = settings.aws.region.trim();
  const model = settings.bedrockRerankModel;
  const awsFetch = createAwsFetch(settings.aws, { service: 'bedrock', baseFetch: fetchImpl });
  const body = await awsPostJson(awsFetch, bedrockAgentRuntimeUrl(region, '/rerank'), {
    queries: [{ type: 'TEXT', textQuery: { text: query } }],
    sources: documents.map((text) => ({
      type: 'INLINE',
      inlineDocumentSource: { type: 'TEXT', textDocument: { text } },
    })),
    rerankingConfiguration: {
      type: 'BEDROCK_RERANKING_MODEL',
      bedrockRerankingConfiguration: {
        modelConfiguration: { modelArn: `arn:aws:bedrock:${region}::foundation-model/${model}` },
        numberOfResults: documents.length,
      },
    },
  });
  return parseScoredList(isRecord(body) ? body.results : undefined, 'relevanceScore', documents.length, 'Bedrock Rerank');
}

/**
 * InvokeModel on bedrock-runtime, the only reranking route that accepts a
 * Bedrock API key. EXPERIMENTAL: AWS does not document this request body; it
 * follows third-party documentation (OpenSearch's Bedrock connector, the
 * Continue extension): {query, documents, top_n, api_version: 2} →
 * results[].{index, relevance_score}. Cohere Rerank 3.5 only.
 */
async function rerankWithBedrockInvokeModel(
  settings: SettingsRecord,
  query: string,
  documents: string[],
  fetchImpl: typeof fetch
): Promise<RerankResult[]> {
  const region = settings.aws.region.trim();
  const model = settings.bedrockRerankModel;
  const awsFetch = createAwsFetch(settings.aws, { service: 'bedrock', baseFetch: fetchImpl });
  const body = await awsPostJson(awsFetch, bedrockRuntimeUrl(region, `/model/${encodeURIComponent(model)}/invoke`), {
    query,
    documents,
    top_n: documents.length,
    api_version: 2,
  });
  return parseScoredList(isRecord(body) ? body.results : undefined, 'relevance_score', documents.length, 'Cohere Rerank');
}

function withSignal(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal });
}

export interface RerankOptions {
  /** Cancels the request (e.g. a newer search replaced this one). */
  signal?: AbortSignal;
  /** Give up after this long; default 8 s. */
  timeoutMs?: number;
  /** Ask the provider even for cached documents (connection tests must reach it). */
  bypassCache?: boolean;
}

/**
 * Score `documents` against `query` with the configured reranker and return
 * the best `topK`, highest score first. Cached scores are reused; only
 * uncached documents are sent. Empty documents and anything beyond the first
 * 1000 are not scored. Throws RerankError when the reranker is not usable or
 * the provider fails, so callers can fall back to first-stage order.
 */
export async function rerankDocuments(
  settings: SettingsRecord,
  query: string,
  documents: string[],
  topK: number,
  fetchImpl: typeof fetch = fetch,
  options: RerankOptions = {}
): Promise<RerankResult[]> {
  const problem = rerankProblem(settings);
  if (problem) throw new RerankError(problem);
  const q = query.trim().slice(0, RERANK_MAX_QUERY_CHARS);
  if (!q || documents.length === 0 || topK <= 0) return [];

  const provider = settings.rerankProvider;
  const model = rerankModelId(settings);
  const queryHash = computeDeterministicHash(q);
  const capped = documents.slice(0, RERANK_MAX_DOCUMENTS).map((d) => d.trim().slice(0, RERANK_MAX_DOC_CHARS));

  const scores = new Map<number, number>();
  const pending: Array<{ index: number; text: string; key: string }> = [];
  capped.forEach((text, index) => {
    if (!text) return;
    const key = cacheKey(provider, model, queryHash, text);
    const cached = options.bypassCache ? undefined : cacheGet(key);
    if (cached !== undefined) scores.set(index, cached);
    else pending.push({ index, text, key });
  });

  if (pending.length > 0) {
    const origins = rerankHostOrigins(settings);
    if (origins.length && !(await hasHostAccess(origins))) {
      const host = origins[0].replace(/^https:\/\//, '').replace(/\/\*$/, '');
      throw new RerankError(`Threadkeeper has no access to ${host} yet. Allow it in Settings → Search & embeddings.`);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? RERANK_TIMEOUT_MS);
    const onAbort = () => controller.abort();
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) controller.abort();
    const call = withSignal(fetchImpl, controller.signal);
    const texts = pending.map((p) => p.text);
    try {
      const results =
        provider === 'voyage'
          ? await rerankWithVoyage(settings, q, texts, call)
          : provider === 'mongodb'
            ? await rerankWithMongoDb(settings, q, texts, call)
            : provider === 'cohere'
              ? await rerankWithCohere(settings, q, texts, call)
              : settings.aws.auth === 'iam'
                ? await rerankWithBedrockRerankApi(settings, q, texts, call)
                : await rerankWithBedrockInvokeModel(settings, q, texts, call);
      for (const r of results) {
        const p = pending[r.index];
        scores.set(p.index, r.score);
        cacheSet(p.key, r.score);
      }
    } catch (err) {
      if (controller.signal.aborted && !options.signal?.aborted) {
        throw new RerankError(`${rerankModelLabel(settings)} did not answer within ${Math.round((options.timeoutMs ?? RERANK_TIMEOUT_MS) / 1000)} s`);
      }
      throw asRerankError(err);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
    }
  }

  return Array.from(scores.entries())
    .map(([index, score]) => ({ index, score }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, topK);
}

/** The configured reranker in the shape runHybridSearch's `reranker` option expects. */
export function rerankerHook(
  settings: SettingsRecord,
  fetchImpl: typeof fetch = fetch,
  options: RerankOptions = {}
): (query: string, documents: string[]) => Promise<Array<{ index: number; relevanceScore: number }>> {
  return async (query, documents) =>
    (await rerankDocuments(settings, query, documents, documents.length, fetchImpl, options)).map((r) => ({
      index: r.index,
      relevanceScore: r.score,
    }));
}

/** One tiny rerank for the Settings "Test" button. Never throws; sends no thread text. */
export async function testReranker(
  settings: SettingsRecord,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; message: string }> {
  try {
    const results = await rerankDocuments(
      settings,
      'How do I make a webhook handler idempotent?',
      ['Store each event id and skip events you have already processed.', 'Sourdough needs a long, cool proof.'],
      2,
      fetchImpl,
      { bypassCache: true }
    );
    if (results.length !== 2) return { ok: false, message: `${rerankModelLabel(settings)} returned ${results.length} of 2 scores.` };
    const sensible = results[0].index === 0;
    return {
      ok: true,
      message: `Connected: ${rerankModelLabel(settings)} ranked the test documents${sensible ? ' correctly' : ' (in an unexpected order)'}.`,
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------------------
// Privacy
// ---------------------------------------------------------------------------

/** The shared local-only rule (src/core/privacy.ts), under the names the search code uses. */
export { isRemoteAllowed as remoteRerankAllowed, remoteAllowedKeys as remoteRerankAllowedKeys } from './privacy.js';

// ---------------------------------------------------------------------------
// Documents and fusion
// ---------------------------------------------------------------------------

/**
 * The best-matching passage of a thread for `query`: the user/assistant
 * message containing the most query terms, cut around the first hit.
 * Empty when no message mentions any term.
 */
export function bestMatchingExcerpt(messages: MessageRecord[], query: string, maxChars = 600): string {
  const terms = Array.from(new Set(query.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3)));
  if (terms.length === 0) return '';
  let best: { content: string; score: number; at: number } | null = null;
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    const lower = m.content.toLowerCase();
    let score = 0;
    let at = -1;
    for (const t of terms) {
      const i = lower.indexOf(t);
      if (i >= 0) {
        score += 1;
        if (at < 0 || i < at) at = i;
      }
    }
    if (score > 0 && (!best || score > best.score)) best = { content: m.content, score, at };
  }
  if (!best) return '';
  const start = Math.max(0, best.at - Math.floor(maxChars / 4));
  const text = best.content.slice(start, start + maxChars).replace(/\s+/g, ' ').trim();
  return `${start > 0 ? '…' : ''}${text}`;
}

/** Short reranker document for one thread: title, gist and one excerpt, never the transcript. */
export function buildRerankDocument(parts: { title: string; gist?: string | null; excerpt?: string | null }): string {
  const lines = [parts.title.trim(), parts.gist?.trim() ?? '', parts.excerpt?.trim() ?? ''].filter(Boolean);
  // Drop an excerpt that only repeats the title (lexical title hits use the title as excerpt).
  const unique = lines.filter((line, i) => lines.indexOf(line) === i);
  return unique.join('\n').slice(0, RERANK_MAX_DOC_CHARS);
}

/**
 * First-stage head start for a candidate at 1-based `rank`. The final score is
 * reranker score (0–1) + head start, so a later candidate passes an earlier
 * one only when the reranker prefers it by more than the head-start gap.
 *
 * The head start is the position-aware weight expressed as odds,
 * w / (1 − w), times 1/rank, with w = 0.75 for ranks 1–3, 0.6 for 4–10 and
 * 0.4 after. Because the reranker term has the same weight at every rank,
 * equal reranker scores always keep the first-stage order, and (scores 0–1):
 * - first-stage #1 stays first (its lead over #2 is 1.5, more than any score gap);
 * - #2 can be passed only by #3, and only when #3 scores over 0.5 higher;
 * - #3 can be passed only by a candidate scoring over 0.62 higher;
 * - below rank 10 head starts differ by at most 0.06, so the reranker decides.
 */
export function firstStageHeadStart(rank: number): number {
  const w = rank <= 3 ? 0.75 : rank <= 10 ? 0.6 : 0.4;
  return (w / (1 - w)) / rank;
}

/**
 * Reorder `count` first-stage candidates (index 0 = best) using reranker
 * scores by candidate index. Candidates without a score (local-only threads,
 * empty documents) keep their exact first-stage slot; scored candidates are
 * blended with their first-stage rank and fill the remaining slots.
 * Returns candidate indexes in the new order.
 */
export function fuseRerankScores(count: number, scores: ReadonlyMap<number, number>): number[] {
  const order = Array.from({ length: count }, (_, i) => i);
  const slots = order.filter((i) => {
    const s = scores.get(i);
    return s !== undefined && Number.isFinite(s);
  });
  const blended = (i: number) => Math.min(1, Math.max(0, scores.get(i) ?? 0)) + firstStageHeadStart(i + 1);
  const ranked = [...slots].sort((a, b) => blended(b) - blended(a) || a - b);
  slots.forEach((slot, k) => {
    order[slot] = ranked[k];
  });
  return order;
}

export interface RerankCandidate {
  key: string;
  /** Short document from buildRerankDocument. */
  document: string;
}

export interface RerankOutcome {
  /** Candidate keys in their final order. */
  order: string[];
  /** Reranker score per key that was scored. */
  scores: Map<string, number>;
  /** Reranker name for a "Reranked with …" note. */
  label: string;
  /** Candidates kept in place because they are local-only. */
  withheld: number;
}

/**
 * Rerank first-stage candidates (best first). Only keys in `allowedKeys` are
 * sent; the others keep their slot. Throws on provider errors so the caller
 * can keep the first-stage order and show a notice.
 */
export async function rerankThreads(
  settings: SettingsRecord,
  query: string,
  candidates: RerankCandidate[],
  allowedKeys: ReadonlySet<string>,
  fetchImpl: typeof fetch = fetch,
  options: RerankOptions = {}
): Promise<RerankOutcome> {
  const sendable = candidates.map((c, i) => ({ c, i })).filter(({ c }) => allowedKeys.has(c.key));
  const results =
    sendable.length >= 2
      ? await rerankDocuments(settings, query, sendable.map(({ c }) => c.document), sendable.length, fetchImpl, options)
      : [];
  const byCandidate = new Map<number, number>();
  const scores = new Map<string, number>();
  for (const r of results) {
    const { c, i } = sendable[r.index];
    byCandidate.set(i, r.score);
    scores.set(c.key, r.score);
  }
  return {
    order: fuseRerankScores(candidates.length, byCandidate).map((i) => candidates[i].key),
    scores,
    label: rerankModelLabel(settings),
    withheld: candidates.length - sendable.length,
  };
}

/**
 * Apply a reranked key order to a (possibly since refreshed) list: items
 * named in `order` are rearranged among the slots they occupy now; every
 * other item stays where it is.
 */
export function applyRerankOrder<T>(items: T[], keyOf: (item: T) => string, order: string[]): T[] {
  const rank = new Map(order.map((k, i) => [k, i]));
  const slots: number[] = [];
  items.forEach((item, i) => {
    if (rank.has(keyOf(item))) slots.push(i);
  });
  const moved = slots.map((i) => items[i]).sort((a, b) => (rank.get(keyOf(a)) ?? 0) - (rank.get(keyOf(b)) ?? 0));
  const out = [...items];
  slots.forEach((slot, k) => {
    out[slot] = moved[k];
  });
  return out;
}
