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
import type { ThreadStackDB } from './db.js';
import { awsModelCredentialsReady, credentialPresent, embeddingCredentialKeys, resolveModelSettings } from './paperclip/credentials.js';
import {
  AwsRequestError,
  awsCredentialsReady,
  awsHostOrigins,
  awsPostJson,
  bedrockRuntimeUrl,
  createAwsFetch,
  hasHostAccess,
  isValidAwsRegion,
} from './aws.js';
import {
  COHERE_BASE_URL,
  COHERE_ORIGIN,
  MONGODB_KEY_HINT,
  bedrockEmbeddingDims,
  cohereEffectiveDimensions,
  cohereEmbeddingInfo,
  cohereSupportsDimensions,
  isBedrockCohereEmbedding,
  isBedrockCohereV3,
  mongodbBaseUrl,
  mongodbOrigin,
  voyageBaseUrl,
  voyageOrigin,
} from './model-apis.js';

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
  /** Requested output size, for providers where it is part of the space (Bedrock). */
  dimensions?: number;
}

export function localSpace(): EmbeddingSpace {
  return { id: LOCAL_SPACE, provider: 'local', model: 'hash-v1', relatedThreshold: 0.3 };
}

export function remoteSpace(settings: SettingsRecord): EmbeddingSpace | null {
  switch (settings.embeddingProvider) {
    case 'voyage':
      // Keep existing legacy vectors intact; Atlas uses a distinct space after migration.
      return credentialPresent(settings, 'voyageApiKey')
        ? {
            id: settings.voyageEndpoint === 'mongodb' ? `voyage:mongodb:${settings.voyageModel}` : `voyage:${settings.voyageModel}`,
            provider: 'voyage', model: settings.voyageModel, relatedThreshold: 0.55,
          }
        : null;
    case 'mongodb':
      // Atlas serves the same Voyage models as voyageai.com, but vectors are keyed by their own
      // space: the requested size is part of it, and a different host is a different account.
      return credentialPresent(settings, 'mongodbApiKey')
        ? {
            id: `mongodb:${settings.mongodbEmbeddingModel}:${settings.mongodbEmbeddingDimensions}`,
            provider: 'mongodb',
            model: settings.mongodbEmbeddingModel,
            relatedThreshold: 0.55,
            dimensions: settings.mongodbEmbeddingDimensions,
          }
        : null;
    case 'cohere': {
      if (!credentialPresent(settings, 'cohereApiKey')) return null;
      const info = cohereEmbeddingInfo(settings.cohereEmbeddingModel);
      const dims = cohereEffectiveDimensions(info.id, settings.cohereEmbeddingDimensions);
      // Pro and Fast of one generation share a vector space, so they share an id: index with
      // Pro and query with Fast (or switch) without rebuilding the library.
      return { id: `cohere:${info.family}:${dims}`, provider: 'cohere', model: info.id, relatedThreshold: 0.5, dimensions: dims };
    }
    case 'openai':
      return credentialPresent(settings, 'openaiApiKey')
        ? { id: `openai:${settings.openaiEmbeddingModel}`, provider: 'openai', model: settings.openaiEmbeddingModel, relatedThreshold: 0.5 }
        : null;
    case 'ollama':
      return settings.ollamaUrl.trim() && settings.ollamaEmbeddingModel.trim()
        ? { id: `ollama:${settings.ollamaEmbeddingModel}`, provider: 'ollama', model: settings.ollamaEmbeddingModel, relatedThreshold: 0.6 }
        : null;
    case 'bedrock':
      // The output size is part of the space: 256- and 1024-dim vectors never mix.
      return awsModelCredentialsReady(settings)
        ? {
            id: `bedrock:${settings.bedrockEmbeddingModel}:${bedrockEmbeddingDims(settings)}`,
            provider: 'bedrock',
            model: settings.bedrockEmbeddingModel,
            relatedThreshold: 0.5,
            dimensions: bedrockEmbeddingDims(settings),
          }
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
  const agent = insight?.agentRun ?? null;
  const tail = dialog.length > 5 ? dialog.slice(-2).map((m) => `${m.role}: ${m.content.slice(0, 600)}`) : [];
  const parts = [
    `Title: ${getDisplayTitle(conv)}`,
    insight?.gist ? `About: ${insight.gist}` : '',
    insight?.summary ? `Summary: ${insight.summary}` : '',
    insight?.topics.length ? `Topics: ${insight.topics.join(', ')}` : '',
    insight?.entities.length ? `Entities: ${insight.entities.join(', ')}` : '',
    conv.providerProjectName ? `Project: ${conv.providerProjectName}` : '',
    // Agent runs: where the work happened and what it touched. Adds these lines to the document of
    // coding-agent threads, so their hash changes and they are embedded once more.
    agent?.repository || conv.repository ? `Repository: ${agent?.repository ?? conv.repository}` : '',
    agent?.branch || conv.gitBranch ? `Branch: ${agent?.branch ?? conv.gitBranch}` : '',
    agent?.pullRequests.length ? `Pull request: ${agent.pullRequests.map((p) => p.url).join(', ')}` : '',
    agent?.filesChanged.length ? `Files: ${agent.filesChanged.join(', ')}` : '',
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

/** POST JSON and turn a non-2xx answer into a readable error (reads `error`, `error.message` or Voyage's `detail`). */
export async function postJson(
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
      // OpenAI/Voyage: error or error.message or detail. Cohere: message.
      const data = (await res.json()) as { error?: { message?: string } | string; detail?: string; message?: string };
      detail =
        typeof data.error === 'string' ? data.error : data.error?.message ?? data.detail ?? data.message ?? '';
    } catch {
      // non-JSON error body
    }
    throw new EmbeddingError(`${new URL(url).hostname} returned HTTP ${res.status}${detail ? `: ${detail}` : ''}`, res.status);
  }
  return res.json();
}

function isNumberArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.length > 0 && value.every((n) => typeof n === 'number' && Number.isFinite(n));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Validate every input-to-vector association before any result can enter the index. */
function parseIndexedEmbeddings(body: unknown, count: number, who: string, dimensions?: number): number[][] {
  const data = isRecord(body) ? body.data : undefined;
  if (!Array.isArray(data) || data.length !== count) {
    throw new EmbeddingError(`${who} returned an unexpected number of vectors`);
  }
  const rows = new Array<number[]>(count);
  let dims = dimensions;
  for (const item of data) {
    const index = isRecord(item) ? item.index : undefined;
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= count) {
      throw new EmbeddingError(`${who} returned an out-of-range embedding index`);
    }
    if (rows[index] !== undefined) throw new EmbeddingError(`${who} returned a duplicate embedding index`);
    if (!isRecord(item) || !isNumberArray(item.embedding)) {
      throw new EmbeddingError(`${who} returned an invalid embedding vector`);
    }
    dims ??= item.embedding.length;
    rows[index] = checkDims(item.embedding, dims, who);
  }
  return rows;
}

/**
 * Run `fn` over `items` with at most `limit` calls in flight; results keep
 * input order. After the first failure no new calls start.
 */
async function mapBounded<T, R>(items: T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try {
        out[i] = await fn(items[i], i);
      } catch (err) {
        failed = true;
        throw err;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

/** Titan Text Embeddings V2 takes one text per InvokeModel call. */
const TITAN_CONCURRENCY = 4;
/** Cohere Embed v4 accepts at most 96 texts per call. */
const COHERE_EMBED_BATCH = 96;

/** Origins Bedrock embeddings need (runtime host for the configured region). */
export function embeddingHostOrigins(settings: SettingsRecord): string[] {
  return settings.embeddingProvider === 'bedrock' && isValidAwsRegion(settings.aws.region)
    ? awsHostOrigins(settings.aws.region, ['runtime'])
    : [];
}

/**
 * Origins the configured hosted embedding provider needs the user to grant. Legacy Voyage,
 * OpenAI and Anthropic are granted at install; Atlas, Cohere and AWS are asked for on a click.
 */
export function embeddingApiOrigins(settings: SettingsRecord): string[] {
  switch (settings.embeddingProvider) {
    case 'voyage':
      return [voyageOrigin(settings)];
    case 'mongodb':
      return [mongodbOrigin(settings.mongodbGeography)];
    case 'cohere':
      return [COHERE_ORIGIN];
    case 'bedrock':
      return embeddingHostOrigins(settings);
    default:
      return [];
  }
}

function hostOf(origin: string): string {
  return origin.replace(/^https:\/\//, '').replace(/\/\*$/, '');
}

function checkDims(vector: number[], dims: number, model: string): number[] {
  if (vector.length !== dims) {
    throw new EmbeddingError(`${model} returned ${vector.length}-dimensional vectors, expected ${dims}`);
  }
  return vector;
}

/** Titan: `embedding`, or `embeddingsByType.float` when only typed output is present. */
export function parseTitanEmbedding(body: unknown): number[] | null {
  if (!isRecord(body)) return null;
  if (isNumberArray(body.embedding)) return body.embedding;
  const byType = body.embeddingsByType;
  return isRecord(byType) && isNumberArray(byType.float) ? byType.float : null;
}

/**
 * Cohere Embed on Bedrock answers `embeddings: number[][]` ("embeddings_floats")
 * or `embeddings: { float: number[][] }` ("embeddings_by_type"); AWS examples
 * show both for a float-only request, so accept either shape.
 */
export function parseCohereEmbeddings(body: unknown): number[][] | null {
  if (!isRecord(body)) return null;
  const raw = body.embeddings;
  const rows: unknown = Array.isArray(raw) ? raw : isRecord(raw) ? raw.float : null;
  if (!Array.isArray(rows) || !rows.every(isNumberArray)) return null;
  return rows as number[][];
}

async function embedWithBedrock(
  settings: SettingsRecord,
  space: EmbeddingSpace,
  texts: string[],
  inputType: 'document' | 'query',
  fetchImpl: typeof fetch
): Promise<number[][]> {
  const region = settings.aws.region.trim();
  if (!awsCredentialsReady(settings.aws)) throw new EmbeddingError('Add AWS credentials and a region for Bedrock embeddings.');
  const origins = awsHostOrigins(region, ['runtime']);
  if (!(await hasHostAccess(origins))) {
    throw new EmbeddingError(
      `ThreadStack has no access to bedrock-runtime.${region}.amazonaws.com yet. Allow it in Settings → Search & embeddings.`
    );
  }
  const dims = space.dimensions ?? bedrockEmbeddingDims(settings);
  const url = bedrockRuntimeUrl(region, `/model/${encodeURIComponent(space.model)}/invoke`);
  const awsFetch = createAwsFetch(settings.aws, { service: 'bedrock', baseFetch: fetchImpl });
  const invoke = async (body: unknown): Promise<unknown> => {
    try {
      return await awsPostJson(awsFetch, url, body);
    } catch (err) {
      if (err instanceof AwsRequestError) throw new EmbeddingError(err.message, err.status);
      throw err;
    }
  };

  if (isBedrockCohereEmbedding(space.model as Parameters<typeof isBedrockCohereV3>[0])) {
    // Embed v3 returns a fixed 1024 dimensions and rejects output_dimension; v4 takes it.
    const v3 = isBedrockCohereV3(space.model as Parameters<typeof isBedrockCohereV3>[0]);
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += COHERE_EMBED_BATCH) {
      const batch = texts.slice(i, i + COHERE_EMBED_BATCH);
      const rows = parseCohereEmbeddings(
        await invoke({
          texts: batch,
          input_type: inputType === 'query' ? 'search_query' : 'search_document',
          ...(v3 ? {} : { output_dimension: dims }),
          embedding_types: ['float'],
          truncate: v3 ? 'END' : 'RIGHT',
        })
      );
      if (!rows || rows.length !== batch.length) throw new EmbeddingError('Cohere Embed returned an unexpected number of vectors');
      out.push(...rows.map((r) => checkDims(r, dims, space.model)));
    }
    return out;
  }

  // amazon.titan-embed-text-v2:0
  return mapBounded(texts, TITAN_CONCURRENCY, async (text) => {
    const vector = parseTitanEmbedding(
      await invoke({ inputText: text, dimensions: dims, normalize: true, embeddingTypes: ['float'] })
    );
    if (!vector) throw new EmbeddingError('Titan Embeddings returned no vector');
    return checkDims(vector, dims, space.model);
  });
}

async function requireOrigins(origins: string[], where: string): Promise<void> {
  if (origins.length > 0 && !(await hasHostAccess(origins))) {
    throw new EmbeddingError(
      `ThreadStack has no access to ${hostOf(origins[0])} yet. Allow it in Settings → Search & embeddings (${where}).`
    );
  }
}

/** Atlas answers 401/403 for a key from another geography or from voyageai.com; say so. */
async function withMongoDbHint<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    if (err instanceof EmbeddingError && (err.status === 401 || err.status === 403) && !err.message.includes('Atlas')) {
      throw new EmbeddingError(`${err.message}. ${MONGODB_KEY_HINT}`, err.status);
    }
    throw err;
  }
}

/** Voyage models on MongoDB Atlas: the Voyage request shape on ai.mongodb.com with an Atlas key. */
async function embedWithMongoDb(
  settings: SettingsRecord,
  space: EmbeddingSpace,
  texts: string[],
  inputType: 'document' | 'query',
  fetchImpl: typeof fetch
): Promise<number[][]> {
  await requireOrigins([mongodbOrigin(settings.mongodbGeography)], 'MongoDB Atlas');
  const url = `${mongodbBaseUrl(settings.mongodbGeography)}/embeddings`;
  const dims = space.dimensions ?? settings.mongodbEmbeddingDimensions;
  const out: number[][] = [];
  const batchSize = 48;
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const data = await withMongoDbHint(() =>
      postJson(
        fetchImpl,
        url,
        { Authorization: `Bearer ${settings.mongodbApiKey.trim()}` },
        { input: batch, model: space.model, input_type: inputType, output_dimension: dims, truncation: true }
      )
    );
    out.push(...parseIndexedEmbeddings(data, batch.length, 'MongoDB Atlas', dims));
  }
  return out;
}

/**
 * Cohere v2 /embed: `texts` (at most 96), `input_type`, `embedding_types: ["float"]`, and
 * `output_dimension` for embed-v4.0 and newer. The answer is `embeddings.float`.
 */
async function embedWithCohere(
  settings: SettingsRecord,
  space: EmbeddingSpace,
  texts: string[],
  inputType: 'document' | 'query',
  fetchImpl: typeof fetch
): Promise<number[][]> {
  await requireOrigins([COHERE_ORIGIN], 'Cohere');
  const model = cohereEmbeddingInfo(settings.cohereEmbeddingModel).id;
  const dims = space.dimensions ?? cohereEffectiveDimensions(model, settings.cohereEmbeddingDimensions);
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += COHERE_EMBED_BATCH) {
    const batch = texts.slice(i, i + COHERE_EMBED_BATCH);
    const data = await postJson(
      fetchImpl,
      `${COHERE_BASE_URL}/embed`,
      { Authorization: `Bearer ${settings.cohereApiKey.trim()}` },
      {
        model,
        texts: batch,
        input_type: inputType === 'query' ? 'search_query' : 'search_document',
        embedding_types: ['float'],
        truncate: 'END',
        ...(cohereSupportsDimensions(model) ? { output_dimension: dims } : {}),
      }
    );
    const rows = parseCohereEmbeddings(data);
    if (!rows || rows.length !== batch.length) throw new EmbeddingError('Cohere returned an unexpected number of vectors');
    out.push(...rows.map((r) => checkDims(r, dims, model)));
  }
  return out;
}

export interface EmbeddingOptions {
  /** Cancel an obsolete search before any more batches are sent. */
  signal?: AbortSignal;
  /** Deadline for the complete remote operation, including batches; default 30 s. */
  timeoutMs?: number;
}

/** Embed texts in the given space. Remote providers are batched and cancellable. */
export async function embedTexts(
  settings: SettingsRecord,
  space: EmbeddingSpace,
  texts: string[],
  inputType: 'document' | 'query',
  fetchImpl: typeof fetch = fetch,
  options: EmbeddingOptions = {}
): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (space.provider === 'local') return texts.map((t) => localHashEmbedding(t));
  options.signal?.throwIfAborted();
  settings = await resolveModelSettings(settings, 'embeddings', embeddingCredentialKeys(settings, space.provider));
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', onAbort, { once: true });
  const call: typeof fetch = (input, init) => {
    controller.signal.throwIfAborted();
    return fetchImpl(input, { ...init, signal: controller.signal });
  };
  try {
    const rows = await embedRemoteTexts(settings, space, texts, inputType, call);
    controller.signal.throwIfAborted();
    // Providers without a configured size still must return one stable vector space.
    const dims = space.dimensions ?? rows[0]?.length;
    if (!dims || rows.length !== texts.length || rows.some((row) => !isNumberArray(row))) {
      throw new EmbeddingError(`${space.model} returned invalid embedding vectors`);
    }
    return rows.map((row) => checkDims(row, dims, space.model));
  } catch (err) {
    if (controller.signal.aborted && !options.signal?.aborted) {
      throw new EmbeddingError(`${space.model} did not answer within ${Math.round(timeoutMs / 1000)} s`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', onAbort);
  }
}

async function embedRemoteTexts(
  settings: SettingsRecord,
  space: EmbeddingSpace,
  texts: string[],
  inputType: 'document' | 'query',
  fetchImpl: typeof fetch
): Promise<number[][]> {
  if (space.provider === 'bedrock') return embedWithBedrock(settings, space, texts, inputType, fetchImpl);
  if (space.provider === 'mongodb') return embedWithMongoDb(settings, space, texts, inputType, fetchImpl);
  if (space.provider === 'cohere') return embedWithCohere(settings, space, texts, inputType, fetchImpl);
  if (space.provider === 'voyage') await requireOrigins([voyageOrigin(settings)], 'Voyage');

  const batchSize = 48;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    if (space.provider === 'voyage') {
      const request = () => postJson(
        fetchImpl,
        `${voyageBaseUrl(settings)}/embeddings`,
        { Authorization: `Bearer ${settings.voyageApiKey.trim()}` },
        { input: batch, model: space.model, input_type: inputType, truncation: true }
      );
      const data = settings.voyageEndpoint === 'mongodb' ? await withMongoDbHint(request) : await request();
      out.push(...parseIndexedEmbeddings(data, batch.length, 'Voyage', out[0]?.length));
    } else if (space.provider === 'openai') {
      const data = await postJson(
        fetchImpl,
        'https://api.openai.com/v1/embeddings',
        { Authorization: `Bearer ${settings.openaiApiKey.trim()}` },
        { input: batch, model: space.model }
      );
      out.push(...parseIndexedEmbeddings(data, batch.length, 'OpenAI', out[0]?.length));
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

/**
 * One short query embedding against the configured remote provider, for the
 * Settings "Test" button. Never throws; never sends thread text.
 */
export async function testEmbedding(
  settings: SettingsRecord,
  fetchImpl: typeof fetch = fetch
): Promise<{ ok: boolean; message: string }> {
  const space = remoteSpace(settings);
  if (!space) return { ok: false, message: 'Add the key, URL or AWS credentials first.' };
  try {
    const [v] = await embedTexts(settings, space, ['ThreadStack connection test'], 'query', fetchImpl);
    return { ok: true, message: `Connected: ${space.model} returns ${v.length}-dimensional vectors.` };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export function vectorKeyFor(space: string, threadKey: string): string {
  return `${space}|${threadKey}`;
}

/** Store (or refresh) a thread's vector in one space. */
export async function putThreadVector(
  db: ThreadStackDB,
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
