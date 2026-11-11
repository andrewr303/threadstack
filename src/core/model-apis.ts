import type {
  BedrockEmbeddingModel,
  CohereEmbeddingModel,
  CohereRerankModel,
  MongoDbEmbeddingModel,
  MongoDbGeography,
  MongoDbRerankModel,
  SettingsRecord,
} from './schema.js';

/**
 * Hosted embedding and rerank APIs that are not Bedrock: MongoDB Atlas (Voyage
 * models) and Cohere. Endpoints, model catalogs and the rules that decide a
 * vector space live here so settings, embeddings and reranking agree.
 *
 * Sources (MongoDB checked 2026-11-10; Cohere checked 2026-11-03):
 * - Atlas model API: worker/contracts/mongodb-model-openapi.json (servers, models, request bodies).
 * - https://www.mongodb.com/docs/voyageai/api-reference/overview/ (geography, keys, input_type).
 * - https://www.mongodb.com/docs/voyageai/models/lifecycle/ (supported models by endpoint).
 * - Cohere: https://docs.cohere.com/docs/models, /reference/embed and /reference/rerank (v2 API).
 */

// ---------------------------------------------------------------------------
// MongoDB Atlas (Voyage)
// ---------------------------------------------------------------------------

/** New settings select Atlas explicitly; unresolved old records retain their Voyage host. */
export function voyageBaseUrl(settings: Pick<SettingsRecord, 'voyageEndpoint'>): string {
  return settings.voyageEndpoint === 'mongodb' ? 'https://ai.mongodb.com/v1' : 'https://api.voyageai.com/v1';
}

export function voyageOrigin(settings: Pick<SettingsRecord, 'voyageEndpoint'>): string {
  return `${new URL(voyageBaseUrl(settings)).origin}/*`;
}

/** One host per geography. A model API key is only valid on the geography it was created for. */
export const MONGODB_AI_BASE_URLS: Record<MongoDbGeography, string> = {
  global: 'https://ai.mongodb.com/v1',
  us: 'https://us.ai.mongodb.com/v1',
  eu: 'https://eu.ai.mongodb.com/v1',
};

export const MONGODB_GEOGRAPHY_LABELS: Record<MongoDbGeography, string> = {
  global: 'Global (ai.mongodb.com)',
  us: 'United States (us.ai.mongodb.com)',
  eu: 'European Union (eu.ai.mongodb.com)',
};

export function mongodbBaseUrl(geography: MongoDbGeography): string {
  return MONGODB_AI_BASE_URLS[geography] ?? MONGODB_AI_BASE_URLS.global;
}

/** Permission pattern for the geography's host. */
export function mongodbOrigin(geography: MongoDbGeography): string {
  return `${new URL(mongodbBaseUrl(geography)).origin}/*`;
}

export const MONGODB_EMBEDDING_MODELS: Array<{ id: MongoDbEmbeddingModel; label: string }> = [
  { id: 'voyage-4-lite', label: 'voyage-4-lite (fast, cheap)' },
  { id: 'voyage-4', label: 'voyage-4' },
  { id: 'voyage-4-large', label: 'voyage-4-large (best)' },
  { id: 'voyage-code-4', label: 'voyage-code-4 (code-heavy libraries)' },
];

export const MONGODB_EMBEDDING_DIMENSIONS = [256, 512, 1024, 2048] as const;

export const MONGODB_RERANK_MODELS: Array<{ id: MongoDbRerankModel; label: string }> = [
  { id: 'rerank-3-lite', label: 'rerank-3-lite (fast, cheap)' },
  { id: 'rerank-3', label: 'rerank-3 (most accurate)' },
  { id: 'rerank-2.5-lite', label: 'rerank-2.5-lite' },
  { id: 'rerank-2.5', label: 'rerank-2.5' },
];

/** Hint appended to an authorization failure: the usual cause is a key from the wrong place. */
export const MONGODB_KEY_HINT =
  'Use a model API key created in MongoDB Atlas for this geography; keys from voyageai.com only work on api.voyageai.com.';

// ---------------------------------------------------------------------------
// Cohere
// ---------------------------------------------------------------------------

export const COHERE_BASE_URL = 'https://api.cohere.com/v2';
export const COHERE_ORIGIN = 'https://api.cohere.com/*';

export interface CohereEmbeddingModelInfo {
  id: CohereEmbeddingModel;
  label: string;
  /** Sizes the model can return; one entry means the size is fixed. */
  dimensions: readonly number[];
  /** Models that share one vector space, so an index built with one can be queried with the other. */
  family: string;
}

export const COHERE_EMBEDDING_MODELS: CohereEmbeddingModelInfo[] = [
  {
    id: 'embed-v5.0-fast',
    label: 'Embed v5.0 Fast (latest, low latency)',
    dimensions: [256, 512, 768, 1024, 1536, 2048],
    family: 'embed-v5.0',
  },
  {
    id: 'embed-v5.0-pro',
    label: 'Embed v5.0 Pro (latest, best quality)',
    dimensions: [256, 512, 768, 1024, 1536, 2048],
    family: 'embed-v5.0',
  },
  { id: 'embed-v4.0', label: 'Embed v4.0', dimensions: [256, 512, 1024, 1536], family: 'embed-v4.0' },
  {
    id: 'embed-multilingual-v3.0',
    label: 'Embed Multilingual v3.0 (1024, 512-token limit)',
    dimensions: [1024],
    family: 'embed-multilingual-v3.0',
  },
  {
    id: 'embed-english-v3.0',
    label: 'Embed English v3.0 (1024, 512-token limit)',
    dimensions: [1024],
    family: 'embed-english-v3.0',
  },
];

export const COHERE_RERANK_MODELS: Array<{ id: CohereRerankModel; label: string }> = [
  { id: 'rerank-v5.0-fast', label: 'Rerank v5.0 Fast (latest, low latency)' },
  { id: 'rerank-v5.0-pro', label: 'Rerank v5.0 Pro (latest, best quality)' },
  { id: 'rerank-v4.0-fast', label: 'Rerank v4.0 Fast' },
  { id: 'rerank-v4.0-pro', label: 'Rerank v4.0 Pro' },
  { id: 'rerank-v3.5', label: 'Rerank v3.5 (4k context)' },
];

export function cohereEmbeddingInfo(model: CohereEmbeddingModel): CohereEmbeddingModelInfo {
  return COHERE_EMBEDDING_MODELS.find((m) => m.id === model) ?? COHERE_EMBEDDING_MODELS[0];
}

/** True when the request may carry output_dimension (embed-v4.0 and newer). */
export function cohereSupportsDimensions(model: CohereEmbeddingModel): boolean {
  return cohereEmbeddingInfo(model).dimensions.length > 1;
}

/**
 * The vector size actually requested: the configured size when the model allows
 * it, else the model's nearest allowed size (switching from v5 at 2048 to v4.0
 * must not request an unsupported 2048).
 */
export function cohereEffectiveDimensions(model: CohereEmbeddingModel, wanted: number): number {
  const allowed = cohereEmbeddingInfo(model).dimensions;
  if (allowed.includes(wanted)) return wanted;
  return allowed.reduce((best, d) => (Math.abs(d - wanted) < Math.abs(best - wanted) ? d : best), allowed[0]);
}

// ---------------------------------------------------------------------------
// Bedrock Cohere embeddings
// ---------------------------------------------------------------------------

/** Cohere Embed v3 on Bedrock returns a fixed 1024-dimensional vector and takes no output_dimension. */
export const BEDROCK_COHERE_V3_MODELS: readonly BedrockEmbeddingModel[] = [
  'cohere.embed-english-v3',
  'cohere.embed-multilingual-v3',
];

export function isBedrockCohereV3(model: BedrockEmbeddingModel): boolean {
  return BEDROCK_COHERE_V3_MODELS.includes(model);
}

export function isBedrockCohereEmbedding(model: BedrockEmbeddingModel): boolean {
  return model === 'cohere.embed-v4:0' || isBedrockCohereV3(model);
}

/** Size of the vectors a Bedrock embedding model returns for the configured setting. */
export function bedrockEmbeddingDims(settings: Pick<SettingsRecord, 'bedrockEmbeddingModel' | 'bedrockEmbeddingDimensions'>): number {
  return isBedrockCohereV3(settings.bedrockEmbeddingModel) ? 1024 : settings.bedrockEmbeddingDimensions;
}
