import {
  computeDeterministicHash,
  getDisplayTitle,
  type ConversationRecord,
  type EmbeddingProviderId,
  type MessageRecord,
  type SettingsRecord,
  type ThreadInsight,
  type ThreadVectorRecord,
} from './schema.js';
import type { ThreadkeeperDB } from './db.js';

/**
 * Embedding spaces. Vectors are only ever compared within one space id, so
 * switching provider or model never mixes incompatible vectors.
 *
 * The local space is always maintained (free, offline, instant) so related
 * threads and auto-filing work before — or without — a remote provider.
 */
export const LOCAL_SPACE = 'local:hash-v1:384';
const LOCAL_DIMS = 384;

export interface EmbeddingSpace {
  id: string;
  provider: EmbeddingProviderId;
  model: string;
  /** Cosine similarity above which two threads count as related in this space. */
  relatedThreshold: number;
}

export function localSpace(): EmbeddingSpace {
  return { id: LOCAL_SPACE, provider: 'local', model: 'hash-v1', relatedThreshold: 0.3 };
}

export function remoteSpace(settings: SettingsRecord): EmbeddingSpace | null {
  switch (settings.embeddingProvider) {
    case 'voyage':
      return settings.voyageApiKey.trim()
        ? { id: `voyage:${settings.voyageModel}`, provider: 'voyage', model: settings.voyageModel, relatedThreshold: 0.55 }
        : null;
    case 'openai':
      return settings.openaiApiKey.trim()
        ? { id: `openai:${settings.openaiEmbeddingModel}`, provider: 'openai', model: settings.openaiEmbeddingModel, relatedThreshold: 0.5 }
        : null;
    case 'ollama':
      return settings.ollamaUrl.trim() && settings.ollamaEmbeddingModel.trim()
        ? { id: `ollama:${settings.ollamaEmbeddingModel}`, provider: 'ollama', model: settings.ollamaEmbeddingModel, relatedThreshold: 0.6 }
        : null;
    default:
      return null;
  }
}

/** The best space available for semantic features right now. */
export function primarySpace(settings: SettingsRecord): EmbeddingSpace {
  return remoteSpace(settings) ?? localSpace();
}

const EMBED_STOP = new Set(
  'the a an and or but if then of to in on for with at by from is are was were be been it this that these those i you we they he she me my your our their not no yes do does did have has had can could would should will just so as also about into than too very'.split(
    ' '
  )
);

function stem(token: string): string {
  return token
    .replace(/(?:ing|ings|edly|ed|ies|es|s|ly|ment|ments|ation|ations)$/, '')
    .slice(0, 14);
}

function fnv1a(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Signed feature hashing of stemmed unigrams and bigrams with sublinear term
 * frequency, L2-normalised. Lexical rather than truly semantic, but stable,
 * private and good enough to cluster and relate threads that share vocabulary.
 */
export function localHashEmbedding(text: string, dims = LOCAL_DIMS): number[] {
  const vec = new Float64Array(dims);
  const tokens = text
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[^a-z0-9+#]+/g, ' ')
    .split(' ')
    .filter((t) => t.length >= 2 && !EMBED_STOP.has(t))
    .map(stem)
    .filter((t) => t.length >= 2);
  const tf = new Map<string, number>();
  for (let i = 0; i < tokens.length; i++) {
    tf.set(tokens[i], (tf.get(tokens[i]) ?? 0) + 1);
    if (i + 1 < tokens.length) {
      const bg = `${tokens[i]}_${tokens[i + 1]}`;
      tf.set(bg, (tf.get(bg) ?? 0) + 0.7);
    }
  }
  for (const [term, count] of tf) {
    const h = fnv1a(term);
    const idx = h % dims;
    const sign = (h >>> 31) & 1 ? -1 : 1;
    vec[idx] += sign * (1 + Math.log(count));
  }
  let norm = 0;
  for (let i = 0; i < dims; i++) norm += vec[i] * vec[i];
  norm = Math.sqrt(norm) || 1;
  return Array.from(vec, (v) => Math.round((v / norm) * 1e5) / 1e5);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/**
 * The text that represents a thread in vector space: what it is about
 * (title, gist, summary, topics) plus the opening and latest turns.
 */
export function buildThreadEmbeddingDocument(
  conv: ConversationRecord,
  insight: ThreadInsight | null,
  messages: MessageRecord[],
  maxChars = 6000
): string {
  const dialog = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .sort((a, b) => a.ordinal - b.ordinal);
  const head = dialog.slice(0, 3).map((m) => `${m.role}: ${m.content.slice(0, 900)}`);
  const tail = dialog.length > 5 ? dialog.slice(-2).map((m) => `${m.role}: ${m.content.slice(0, 600)}`) : [];
  const parts = [
    `Title: ${getDisplayTitle(conv)}`,
    insight?.gist ? `About: ${insight.gist}` : '',
    insight?.summary ? `Summary: ${insight.summary}` : '',
    insight?.topics.length ? `Topics: ${insight.topics.join(', ')}` : '',
    insight?.entities.length ? `Entities: ${insight.entities.join(', ')}` : '',
    conv.providerProjectName ? `Project: ${conv.providerProjectName}` : '',
    ...head,
    ...tail,
  ].filter(Boolean);
  const doc = parts.join('\n');
  return doc.length > maxChars ? doc.slice(0, maxChars) : doc;
}

export class EmbeddingError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  headers: Record<string, string>,
  body: unknown
): Promise<unknown> {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    let detail = '';
    try {
      const data = (await res.json()) as { error?: { message?: string } | string; detail?: string };
      detail =
        typeof data.error === 'string' ? data.error : data.error?.message ?? data.detail ?? '';
    } catch {
      // non-JSON error body
    }
    throw new EmbeddingError(`${new URL(url).hostname} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }
  return res.json();
}

/** Embed texts in the given space. Remote providers are batched. */
export async function embedTexts(
  settings: SettingsRecord,
  space: EmbeddingSpace,
  texts: string[],
  inputType: 'document' | 'query',
  fetchImpl: typeof fetch = fetch
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (space.provider === 'local') return texts.map((t) => localHashEmbedding(t));

  const batchSize = 48;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    if (space.provider === 'voyage') {
      const data = (await postJson(
        fetchImpl,
        'https://api.voyageai.com/v1/embeddings',
        { Authorization: `Bearer ${settings.voyageApiKey.trim()}` },
        { input: batch, model: space.model, input_type: inputType, truncation: true }
      )) as { data?: Array<{ embedding: number[]; index: number }> };
      const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
      if (rows.length !== batch.length) throw new EmbeddingError('Voyage returned an unexpected number of vectors');
      out.push(...rows.map((r) => r.embedding));
    } else if (space.provider === 'openai') {
      const data = (await postJson(
        fetchImpl,
        'https://api.openai.com/v1/embeddings',
        { Authorization: `Bearer ${settings.openaiApiKey.trim()}` },
        { input: batch, model: space.model }
      )) as { data?: Array<{ embedding: number[]; index: number }> };
      const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index);
      if (rows.length !== batch.length) throw new EmbeddingError('OpenAI returned an unexpected number of vectors');
      out.push(...rows.map((r) => r.embedding));
    } else if (space.provider === 'ollama') {
      const base = settings.ollamaUrl.replace(/\/+$/, '');
      const data = (await postJson(fetchImpl, `${base}/api/embed`, {}, {
        model: space.model,
        input: batch,
      })) as { embeddings?: number[][] };
      if (!data.embeddings || data.embeddings.length !== batch.length) {
        throw new EmbeddingError('Ollama returned an unexpected number of vectors');
      }
      out.push(...data.embeddings);
    }
  }
  return out;
}

export function vectorKeyFor(space: string, threadKey: string): string {
  return `${space}|${threadKey}`;
}

/** Store (or refresh) a thread's vector in one space. */
export async function putThreadVector(
  db: ThreadkeeperDB,
  params: { space: string; threadKey: string; sourceRevision: number; doc: string; embedding: number[] }
): Promise<void> {
  const record: ThreadVectorRecord = {
    vectorKey: vectorKeyFor(params.space, params.threadKey),
    space: params.space,
    threadKey: params.threadKey,
    sourceRevision: params.sourceRevision,
    docHash: computeDeterministicHash(params.doc),
    embedding: params.embedding,
    updatedAt: new Date().toISOString(),
  };
  await db.threadVectors.put(record);
}

export interface Neighbor {
  threadKey: string;
  similarity: number;
}

/** Brute-force cosine k-NN; fast enough for tens of thousands of threads. */
export function nearestNeighbors(
  query: ArrayLike<number>,
  candidates: Array<Pick<ThreadVectorRecord, 'threadKey' | 'embedding'>>,
  k: number,
  options: { exclude?: Set<string>; minSimilarity?: number } = {}
): Neighbor[] {
  const out: Neighbor[] = [];
  for (const c of candidates) {
    if (options.exclude?.has(c.threadKey)) continue;
    const sim = cosine(query, c.embedding);
    if (sim < (options.minSimilarity ?? -1)) continue;
    out.push({ threadKey: c.threadKey, similarity: sim });
  }
  out.sort((a, b) => b.similarity - a.similarity);
  return out.slice(0, k);
}
