import { z } from 'zod';
import {
  ContextualEmbeddingRequest,
  MONGODB_AI_HOSTS,
  MongoDbAiGeography,
  RerankRequest,
  StandardEmbeddingRequest,
  VOYAGE_CONTEXT_MODELS,
  VOYAGE_RERANK_MODELS,
  VOYAGE_STANDARD_MODELS,
} from '../../shared/cloud';
import type { Env } from '../worker-configuration';

export function resolveMongoDbAiBaseUrl(geography?: string): string {
  const geo = (geography ?? 'unscoped') as MongoDbAiGeography;
  if (geo in MONGODB_AI_HOSTS) {
    return MONGODB_AI_HOSTS[geo];
  }
  throw new Error(`Unsupported MongoDB AI geography "${String(geography)}". Expected unscoped, us, or eu.`);
}

const StandardEmbeddingsOpenApiResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(
    z.object({
      object: z.literal('embedding'),
      embedding: z.array(z.number()),
      index: z.number().int().nonnegative(),
    })
  ),
  model: z.string(),
  usage: z.object({
    total_tokens: z.number().int().nonnegative(),
  }),
});

const ContextualEmbeddingsOpenApiResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(
    z.object({
      object: z.literal('list'),
      data: z.array(
        z.object({
          object: z.literal('embedding'),
          embedding: z.array(z.number()),
          index: z.number().int().nonnegative(),
        })
      ),
      index: z.number().int().nonnegative(),
    })
  ),
  model: z.string(),
  usage: z.object({
    total_tokens: z.number().int().nonnegative(),
  }),
});

const RerankOpenApiResponseSchema = z.object({
  object: z.literal('list'),
  data: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      relevance_score: z.number(),
      document: z.string().optional(),
    })
  ),
  model: z.string(),
  usage: z.object({
    total_tokens: z.number().int().nonnegative(),
  }),
});

export interface StandardEmbeddingResult {
  model: string;
  dimensions: number;
  inputType: 'query' | 'document';
  preprocessingVersion: string;
  indexVersion: string;
  embeddings: number[][];
  usage: { totalTokens: number };
}

export async function createStandardEmbeddings(
  env: Env,
  req: StandardEmbeddingRequest,
  fetchImpl: typeof fetch = fetch
): Promise<StandardEmbeddingResult> {
  if (!env.MONGODB_MODEL_API_KEY) {
    throw new Error('MongoDB Model API key (MONGODB_MODEL_API_KEY) is not configured.');
  }
  if (!VOYAGE_STANDARD_MODELS.includes(req.model)) {
    throw new Error(`Disallowed standard embedding model "${String(req.model)}".`);
  }

  const baseUrl = resolveMongoDbAiBaseUrl(env.MONGODB_AI_GEOGRAPHY);
  const res = await fetchImpl(`${baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MONGODB_MODEL_API_KEY}`,
    },
    body: JSON.stringify({
      input: req.input,
      model: req.model,
      input_type: req.inputType,
      output_dimension: req.outputDimension,
      truncation: req.truncation,
      output_dtype: 'float',
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`MongoDB /embeddings failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const parsed = StandardEmbeddingsOpenApiResponseSchema.parse(await res.json());
  const ordered = [...parsed.data].sort((a, b) => a.index - b.index);

  for (const item of ordered) {
    if (item.embedding.length !== req.outputDimension) {
      throw new Error(
        `Embedding dimension mismatch: expected ${req.outputDimension}, received ${item.embedding.length}.`
      );
    }
  }

  return {
    model: parsed.model,
    dimensions: req.outputDimension,
    inputType: req.inputType,
    preprocessingVersion: req.preprocessingVersion,
    indexVersion: req.indexVersion,
    embeddings: ordered.map((d) => d.embedding),
    usage: { totalTokens: parsed.usage.total_tokens },
  };
}

export interface ContextualEmbeddingResult {
  model: string;
  dimensions: number;
  inputType: 'query' | 'document';
  preprocessingVersion: string;
  indexVersion: string;
  groups: number[][][];
  usage: { totalTokens: number };
}

export async function createContextualEmbeddings(
  env: Env,
  req: ContextualEmbeddingRequest,
  fetchImpl: typeof fetch = fetch
): Promise<ContextualEmbeddingResult> {
  if (!env.MONGODB_MODEL_API_KEY) {
    throw new Error('MongoDB Model API key (MONGODB_MODEL_API_KEY) is not configured.');
  }
  if (!VOYAGE_CONTEXT_MODELS.includes(req.model)) {
    throw new Error(`Disallowed contextual embedding model "${String(req.model)}".`);
  }
  if (req.inputType === 'query') {
    for (const group of req.inputs) {
      if (group.length !== 1) {
        throw new Error('Contextual query inputs must have exactly 1 query string per inner list.');
      }
    }
  }

  const baseUrl = resolveMongoDbAiBaseUrl(env.MONGODB_AI_GEOGRAPHY);
  const res = await fetchImpl(`${baseUrl}/contextualizedembeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MONGODB_MODEL_API_KEY}`,
    },
    body: JSON.stringify({
      inputs: req.inputs,
      model: req.model,
      input_type: req.inputType,
      output_dimension: req.outputDimension,
      output_dtype: 'float',
      enable_auto_chunking: false,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`MongoDB /contextualizedembeddings failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const parsed = ContextualEmbeddingsOpenApiResponseSchema.parse(await res.json());
  const orderedGroups = [...parsed.data].sort((a, b) => a.index - b.index);

  const groups: number[][][] = orderedGroups.map((grp, grpIdx) => {
    const orderedChunks = [...grp.data].sort((a, b) => a.index - b.index);
    const expectedCount = req.inputs[grpIdx]?.length ?? 0;
    if (orderedChunks.length !== expectedCount) {
      throw new Error(
        `Contextual chunk count mismatch in group ${grpIdx}: expected ${expectedCount}, received ${orderedChunks.length}.`
      );
    }
    for (const chunk of orderedChunks) {
      if (chunk.embedding.length !== req.outputDimension) {
        throw new Error(
          `Contextual embedding dimension mismatch: expected ${req.outputDimension}, received ${chunk.embedding.length}.`
        );
      }
    }
    return orderedChunks.map((c) => c.embedding);
  });

  return {
    model: parsed.model,
    dimensions: req.outputDimension,
    inputType: req.inputType,
    preprocessingVersion: req.preprocessingVersion,
    indexVersion: req.indexVersion,
    groups,
    usage: { totalTokens: parsed.usage.total_tokens },
  };
}

export interface RerankResult {
  model: string;
  results: Array<{
    index: number;
    relevanceScore: number;
  }>;
  usage: { totalTokens: number };
}

export async function rerankDocuments(
  env: Env,
  req: RerankRequest,
  fetchImpl: typeof fetch = fetch
): Promise<RerankResult> {
  if (!env.MONGODB_MODEL_API_KEY) {
    throw new Error('MongoDB Model API key (MONGODB_MODEL_API_KEY) is not configured.');
  }
  if (!VOYAGE_RERANK_MODELS.includes(req.model)) {
    throw new Error(`Disallowed rerank model "${String(req.model)}". Never substitute legacy 2.5 models.`);
  }

  const baseUrl = resolveMongoDbAiBaseUrl(env.MONGODB_AI_GEOGRAPHY);
  const res = await fetchImpl(`${baseUrl}/rerank`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${env.MONGODB_MODEL_API_KEY}`,
    },
    body: JSON.stringify({
      query: req.query,
      documents: req.documents,
      model: req.model,
      top_k: req.topK ?? req.documents.length,
      return_documents: false,
      truncation: req.truncation,
    }),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`MongoDB /rerank failed (${res.status}): ${detail.slice(0, 300)}`);
  }

  const parsed = RerankOpenApiResponseSchema.parse(await res.json());
  for (const item of parsed.data) {
    if (item.index < 0 || item.index >= req.documents.length) {
      throw new Error(`Invalid rerank document index ${item.index} (out of bounds for ${req.documents.length} docs).`);
    }
  }

  return {
    model: parsed.model,
    results: parsed.data.map((item) => ({
      index: item.index,
      relevanceScore: item.relevance_score,
    })),
    usage: { totalTokens: parsed.usage.total_tokens },
  };
}
