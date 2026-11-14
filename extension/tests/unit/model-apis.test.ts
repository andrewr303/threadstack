import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AWS_SETTINGS } from '../../src/core/aws.js';
import { DEFAULT_SETTINGS, normalizeSettings, type SettingsRecord } from '../../src/core/schema.js';
import {
  EmbeddingError,
  embedTexts,
  embeddingApiOrigins,
  remoteSpace,
  testEmbedding,
} from '../../src/core/embeddings.js';
import {
  clearRerankCache,
  rerankDocuments,
  rerankHostOrigins,
  rerankModelLabel,
  rerankProblem,
  testReranker,
} from '../../src/core/rerank.js';
import {
  cohereEffectiveDimensions,
  cohereSupportsDimensions,
  mongodbBaseUrl,
  mongodbOrigin,
} from '../../src/core/model-apis.js';

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function recordingFetch(respond: (call: Call, n: number) => unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    return new Response(JSON.stringify(respond(call, calls.length)), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

const vec = (dims: number, seed = 1) => Array.from({ length: dims }, (_, i) => ((i + seed) % 5) / 5);

const atlas = (patch: Partial<SettingsRecord> = {}): SettingsRecord => ({
  ...DEFAULT_SETTINGS,
  embeddingProvider: 'mongodb',
  mongodbApiKey: 'atlas-key',
  ...patch,
});

const cohere = (patch: Partial<SettingsRecord> = {}): SettingsRecord => ({
  ...DEFAULT_SETTINGS,
  embeddingProvider: 'cohere',
  cohereApiKey: 'co-key',
  ...patch,
});

describe('settings migration', () => {
  it('keeps existing Voyage keys on their original host without losing the key or model', () => {
    const s = normalizeSettings({ voyageApiKey: 'old-voyage-key', voyageModel: 'voyage-4', rerankProvider: 'voyage' });
    expect(s.voyageEndpoint).toBe('legacy');
    expect(s.voyageApiKey).toBe('old-voyage-key');
    expect(s.voyageModel).toBe('voyage-4');
    expect(normalizeSettings({ ...s, voyageEndpoint: 'legacy' }).voyageEndpoint).toBe('legacy');
    expect(normalizeSettings({ ...s, voyageEndpoint: 'mongodb' }).voyageEndpoint).toBe('mongodb');
    expect(normalizeSettings({ ...s, voyageEndpoint: 'invalid' as SettingsRecord['voyageEndpoint'] }).voyageEndpoint).toBe('legacy');
    expect(normalizeSettings({}).voyageEndpoint).toBe('mongodb');
  });
  it('fills the new provider fields for a record saved before they existed', () => {
    const old = { ...DEFAULT_SETTINGS } as Partial<SettingsRecord>;
    for (const k of ['mongodbApiKey', 'cohereApiKey', 'cohereEmbeddingModel', 'mongodbGeography'] as const) delete old[k];
    const s = normalizeSettings(old);
    expect(s.mongodbGeography).toBe('global');
    expect(s.cohereEmbeddingModel).toBe('embed-v5.0-fast');
    expect(s.mongodbApiKey).toBe('');
  });
});

describe('Voyage endpoint routing', () => {
  const settings: SettingsRecord = {
    ...DEFAULT_SETTINGS, embeddingProvider: 'voyage', rerankProvider: 'voyage', voyageApiKey: '  atlas-key  ',
  };

  it.each(['mongodb', 'legacy'] as const)('uses the selected %s host for documents, queries, reranking and permissions', async (voyageEndpoint) => {
    const s = { ...settings, voyageEndpoint };
    const host = voyageEndpoint === 'legacy' ? 'https://api.voyageai.com' : 'https://ai.mongodb.com';
    const { calls, fetchImpl } = recordingFetch((call) => call.url.endsWith('/embeddings')
      ? { data: (call.body.input as string[]).map((_, index) => ({ index, embedding: [0.1, 0.2] })).reverse() }
      : { data: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }] });
    const space = remoteSpace(s)!;
    expect(await embedTexts(s, space, ['a', 'b'], 'document', fetchImpl)).toHaveLength(2);
    expect(await embedTexts(s, space, ['q'], 'query', fetchImpl)).toHaveLength(1);
    expect(await rerankDocuments(s, 'q', ['a', 'b'], 1, fetchImpl, { bypassCache: true })).toEqual([{ index: 1, score: 0.9 }]);
    expect(calls.map((c) => c.url)).toEqual([`${host}/v1/embeddings`, `${host}/v1/embeddings`, `${host}/v1/rerank`]);
    expect(calls.map((c) => c.headers.get('authorization'))).toEqual(Array(3).fill('Bearer atlas-key'));
    expect(calls.slice(0, 2).map((c) => c.body.input_type)).toEqual(['document', 'query']);
    expect(embeddingApiOrigins(s)).toEqual([`${host}/*`]);
    expect(rerankHostOrigins(s)).toEqual([`${host}/*`]);
  });

  it('keeps vectors and rerank scores separate when switching endpoints', async () => {
    clearRerankCache();
    const legacy = { ...settings, voyageEndpoint: 'legacy' as const };
    expect(remoteSpace(legacy)?.id).toBe('voyage:voyage-4-lite');
    expect(remoteSpace(settings)?.id).not.toBe(remoteSpace(legacy)?.id);
    const { calls, fetchImpl } = recordingFetch(() => ({ data: [{ index: 0, relevance_score: 0.8 }] }));
    await rerankDocuments(settings, 'endpoint-cache-probe', ['a'], 1, fetchImpl);
    await rerankDocuments(legacy, 'endpoint-cache-probe', ['a'], 1, fetchImpl);
    expect(calls).toHaveLength(2);
  });

  it('reports an Atlas authorization failure without retrying the key on another host', async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ detail: 'This API key cannot access this endpoint.' }), 403);
    expect(await testEmbedding(settings, fetchImpl)).toMatchObject({ ok: false, message: expect.stringContaining('ai.mongodb.com returned HTTP 403') });
    expect(await testReranker(settings, fetchImpl)).toMatchObject({ ok: false, message: expect.stringContaining('ai.mongodb.com returned HTTP 403') });
    expect(calls).toHaveLength(2);
    expect(calls.every((c) => c.url.startsWith('https://ai.mongodb.com/v1/'))).toBe(true);
  });
});

describe('MongoDB Atlas (Voyage) embeddings', () => {
  it('uses the geography host and puts the size in the space id', () => {
    expect(mongodbBaseUrl('global')).toBe('https://ai.mongodb.com/v1');
    expect(mongodbBaseUrl('us')).toBe('https://us.ai.mongodb.com/v1');
    expect(mongodbBaseUrl('eu')).toBe('https://eu.ai.mongodb.com/v1');
    expect(mongodbOrigin('eu')).toBe('https://eu.ai.mongodb.com/*');
    expect(remoteSpace(atlas())).toMatchObject({ id: 'mongodb:voyage-4-lite:1024', provider: 'mongodb', dimensions: 1024 });
    expect(remoteSpace(atlas({ mongodbEmbeddingDimensions: 256 }))?.id).toBe('mongodb:voyage-4-lite:256');
    expect(remoteSpace(atlas({ mongodbApiKey: '  ' }))).toBeNull();
  });

  it('is never the same space as direct Voyage, so vectors from the two hosts do not mix', () => {
    const direct = remoteSpace({ ...DEFAULT_SETTINGS, embeddingProvider: 'voyage', voyageApiKey: 'k', voyageModel: 'voyage-4-lite' });
    expect(direct?.id).not.toBe(remoteSpace(atlas())?.id);
  });

  it('asks only for the configured geography host', () => {
    expect(embeddingApiOrigins(atlas({ mongodbGeography: 'us' }))).toEqual(['https://us.ai.mongodb.com/*']);
  });

  it('posts the Voyage body to the Atlas host with the Atlas key and keeps input order', async () => {
    const { calls, fetchImpl } = recordingFetch((call) => ({
      object: 'list',
      model: call.body.model,
      // out of order on purpose
      data: (call.body.input as string[]).map((_, index) => ({ object: 'embedding', index, embedding: vec(512, index) })).reverse(),
      usage: { total_tokens: 3 },
    }));
    const s = atlas({ mongodbGeography: 'eu', mongodbEmbeddingModel: 'voyage-4', mongodbEmbeddingDimensions: 512 });
    const space = remoteSpace(s)!;
    const out = await embedTexts(s, space, ['a', 'b', 'c'], 'document', fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://eu.ai.mongodb.com/v1/embeddings');
    expect(calls[0].headers.get('authorization')).toBe('Bearer atlas-key');
    expect(calls[0].body).toMatchObject({ input: ['a', 'b', 'c'], model: 'voyage-4', input_type: 'document', output_dimension: 512 });
    expect(out.map((v) => v[0])).toEqual([vec(512, 0)[0], vec(512, 1)[0], vec(512, 2)[0]]);
  });

  it('batches 48 texts per call', async () => {
    const { calls, fetchImpl } = recordingFetch((call) => ({
      data: (call.body.input as string[]).map((_, index) => ({ index, embedding: vec(1024) })),
    }));
    const s = atlas();
    await embedTexts(s, remoteSpace(s)!, Array.from({ length: 100 }, (_, i) => `t${i}`), 'document', fetchImpl);
    expect(calls.map((c) => (c.body.input as string[]).length)).toEqual([48, 48, 4]);
  });

  it('rejects a vector of the wrong size instead of storing it', async () => {
    const { fetchImpl } = recordingFetch((call) => ({
      data: (call.body.input as string[]).map((_, index) => ({ index, embedding: vec(256) })),
    }));
    const s = atlas();
    await expect(embedTexts(s, remoteSpace(s)!, ['a'], 'query', fetchImpl)).rejects.toThrow(/expected 1024/);
  });

  it('explains a 401 with the key-origin hint', async () => {
    const { fetchImpl } = recordingFetch(() => ({ detail: 'Provided API key is invalid.' }), 401);
    const s = atlas();
    const err = await embedTexts(s, remoteSpace(s)!, ['a'], 'query', fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as Error).message).toMatch(/invalid/);
    expect((err as Error).message).toMatch(/created in MongoDB Atlas/);
  });

  it('the Settings test reports the model and size', async () => {
    const { fetchImpl } = recordingFetch(() => ({ data: [{ index: 0, embedding: vec(1024) }] }));
    const r = await testEmbedding(atlas(), fetchImpl);
    expect(r).toEqual({ ok: true, message: 'Connected: voyage-4-lite returns 1024-dimensional vectors.' });
  });
});

describe('Cohere embeddings', () => {
  it('shares one space between Pro and Fast of a generation, and keeps sizes apart', () => {
    const fast = remoteSpace(cohere({ cohereEmbeddingModel: 'embed-v5.0-fast' }))!;
    const pro = remoteSpace(cohere({ cohereEmbeddingModel: 'embed-v5.0-pro' }))!;
    expect(fast.id).toBe('cohere:embed-v5.0:1024');
    expect(pro.id).toBe(fast.id);
    expect(remoteSpace(cohere({ cohereEmbeddingDimensions: 2048 }))?.id).toBe('cohere:embed-v5.0:2048');
    expect(remoteSpace(cohere({ cohereEmbeddingModel: 'embed-v4.0' }))?.id).toBe('cohere:embed-v4.0:1024');
    expect(remoteSpace(cohere({ cohereApiKey: '' }))).toBeNull();
  });

  it('never requests a size the model does not offer', () => {
    // v4.0 tops out at 1536; a library set to 2048 under v5 must not send 2048 to v4.
    expect(cohereEffectiveDimensions('embed-v4.0', 2048)).toBe(1536);
    expect(cohereEffectiveDimensions('embed-v5.0-fast', 768)).toBe(768);
    expect(cohereEffectiveDimensions('embed-english-v3.0', 2048)).toBe(1024);
    expect(remoteSpace(cohere({ cohereEmbeddingModel: 'embed-v4.0', cohereEmbeddingDimensions: 2048 }))?.id).toBe('cohere:embed-v4.0:1536');
    expect(cohereSupportsDimensions('embed-multilingual-v3.0')).toBe(false);
  });

  it('calls /v2/embed with search_document, float output and output_dimension', async () => {
    const { calls, fetchImpl } = recordingFetch((call) => ({
      id: 'x',
      embeddings: { float: (call.body.texts as string[]).map((_, i) => vec(1024, i)) },
    }));
    const s = cohere();
    const out = await embedTexts(s, remoteSpace(s)!, ['one', 'two'], 'document', fetchImpl);
    expect(calls[0].url).toBe('https://api.cohere.com/v2/embed');
    expect(calls[0].headers.get('authorization')).toBe('Bearer co-key');
    expect(calls[0].body).toEqual({
      model: 'embed-v5.0-fast',
      texts: ['one', 'two'],
      input_type: 'search_document',
      embedding_types: ['float'],
      truncate: 'END',
      output_dimension: 1024,
    });
    expect(out).toHaveLength(2);
  });

  it('uses search_query for queries, omits output_dimension for v3 models, and batches 96', async () => {
    const { calls, fetchImpl } = recordingFetch((call) => ({
      embeddings: { float: (call.body.texts as string[]).map(() => vec(1024)) },
    }));
    const s = cohere({ cohereEmbeddingModel: 'embed-multilingual-v3.0' });
    await embedTexts(s, remoteSpace(s)!, ['q'], 'query', fetchImpl);
    expect(calls[0].body.input_type).toBe('search_query');
    expect('output_dimension' in calls[0].body).toBe(false);
    await embedTexts(s, remoteSpace(s)!, Array.from({ length: 200 }, (_, i) => `t${i}`), 'document', fetchImpl);
    expect(calls.slice(1).map((c) => (c.body.texts as string[]).length)).toEqual([96, 96, 8]);
  });

  it('reads the message field of a Cohere error', async () => {
    const { fetchImpl } = recordingFetch(() => ({ message: 'invalid api token' }), 401);
    const s = cohere();
    await expect(embedTexts(s, remoteSpace(s)!, ['a'], 'query', fetchImpl)).rejects.toThrow(/api\.cohere\.com returned HTTP 401: invalid api token/);
  });
});

describe('Bedrock Cohere Embed v3', () => {
  const bedrock = (model: SettingsRecord['bedrockEmbeddingModel']): SettingsRecord => ({
    ...DEFAULT_SETTINGS,
    embeddingProvider: 'bedrock',
    bedrockEmbeddingModel: model,
    bedrockEmbeddingDimensions: 256,
    aws: { ...DEFAULT_AWS_SETTINGS, region: 'us-east-1', bedrockApiKey: 'bedrock-api-key-test' },
  });

  it('is a fixed 1024-dimensional space whatever the size setting says', () => {
    expect(remoteSpace(bedrock('cohere.embed-multilingual-v3'))).toMatchObject({
      id: 'bedrock:cohere.embed-multilingual-v3:1024',
      dimensions: 1024,
    });
    expect(remoteSpace(bedrock('cohere.embed-v4:0'))?.id).toBe('bedrock:cohere.embed-v4:0:256');
  });

  it('sends no output_dimension and parses either response shape', async () => {
    const { calls, fetchImpl } = recordingFetch((call) => ({
      embeddings: (call.body.texts as string[]).map(() => vec(1024)),
      response_type: 'embeddings_floats',
    }));
    const s = bedrock('cohere.embed-english-v3');
    const out = await embedTexts(s, remoteSpace(s)!, ['a', 'b'], 'document', fetchImpl);
    expect(out).toHaveLength(2);
    expect(calls[0].url).toContain('/model/cohere.embed-english-v3/invoke');
    expect(calls[0].body).toMatchObject({ input_type: 'search_document', embedding_types: ['float'] });
    expect('output_dimension' in calls[0].body).toBe(false);
  });
});

describe('Atlas and Cohere reranking', () => {
  beforeEach(() => clearRerankCache());
  const docs = ['sourdough proofing', 'idempotent webhook handler: store each event id', 'weather in Lisbon'];

  it('Atlas: Voyage body on the geography host, scores from data[]', async () => {
    const { calls, fetchImpl } = recordingFetch((call) => ({
      object: 'list',
      model: call.body.model,
      data: [
        { index: 1, relevance_score: 0.93 },
        { index: 0, relevance_score: 0.2 },
        { index: 2, relevance_score: 0.05 },
      ],
      usage: { total_tokens: 10 },
    }));
    const s: SettingsRecord = {
      ...DEFAULT_SETTINGS,
      rerankProvider: 'mongodb',
      mongodbApiKey: 'atlas-key',
      mongodbGeography: 'us',
      mongodbRerankModel: 'rerank-3',
    };
    expect(rerankHostOrigins(s)).toEqual(['https://us.ai.mongodb.com/*']);
    const out = await rerankDocuments(s, 'idempotent webhook', docs, 3, fetchImpl);
    expect(calls[0].url).toBe('https://us.ai.mongodb.com/v1/rerank');
    expect(calls[0].headers.get('authorization')).toBe('Bearer atlas-key');
    expect(calls[0].body).toMatchObject({ model: 'rerank-3', top_k: 3, truncation: true });
    expect(out[0]).toEqual({ index: 1, score: 0.93 });
  });

  it('Atlas: a 403 names the Atlas key requirement', async () => {
    const { fetchImpl } = recordingFetch(() => ({ detail: 'forbidden' }), 403);
    const s: SettingsRecord = { ...DEFAULT_SETTINGS, rerankProvider: 'mongodb', mongodbApiKey: 'k' };
    await expect(rerankDocuments(s, 'q', docs, 3, fetchImpl)).rejects.toThrow(/created in MongoDB Atlas/);
  });

  it('Cohere: /v2/rerank with top_n, scores from results[]', async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({
      id: 'r',
      results: [
        { index: 1, relevance_score: 0.88 },
        { index: 0, relevance_score: 0.1 },
        { index: 2, relevance_score: 0.02 },
      ],
    }));
    const s: SettingsRecord = { ...DEFAULT_SETTINGS, rerankProvider: 'cohere', cohereApiKey: 'co-key', cohereRerankModel: 'rerank-v5.0-pro' };
    const out = await rerankDocuments(s, 'idempotent webhook', docs, 2, fetchImpl);
    expect(calls[0].url).toBe('https://api.cohere.com/v2/rerank');
    expect(calls[0].headers.get('authorization')).toBe('Bearer co-key');
    expect(calls[0].body).toEqual({
      model: 'rerank-v5.0-pro',
      query: 'idempotent webhook',
      documents: docs,
      top_n: 3,
    });
    expect(out).toEqual([
      { index: 1, score: 0.88 },
      { index: 0, score: 0.1 },
    ]);
    expect(rerankModelLabel(s)).toBe('Cohere rerank-v5.0-pro');
  });

  it('Cohere: rejects an out-of-range index from the service', async () => {
    const { fetchImpl } = recordingFetch(() => ({ results: [{ index: 9, relevance_score: 0.5 }] }));
    const s: SettingsRecord = { ...DEFAULT_SETTINGS, rerankProvider: 'cohere', cohereApiKey: 'k' };
    await expect(rerankDocuments(s, 'q', docs, 3, fetchImpl)).rejects.toThrow(/out-of-range/);
  });

  it('does not reuse a cached score across models or hosts', async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({ results: [{ index: 0, relevance_score: 0.7 }, { index: 1, relevance_score: 0.2 }] }));
    const base: SettingsRecord = { ...DEFAULT_SETTINGS, rerankProvider: 'cohere', cohereApiKey: 'k', cohereRerankModel: 'rerank-v5.0-fast' };
    await rerankDocuments(base, 'q', ['a doc', 'b doc'], 2, fetchImpl);
    await rerankDocuments(base, 'q', ['a doc', 'b doc'], 2, fetchImpl); // cached
    expect(calls).toHaveLength(1);
    await rerankDocuments({ ...base, cohereRerankModel: 'rerank-v3.5' }, 'q', ['a doc', 'b doc'], 2, fetchImpl);
    expect(calls).toHaveLength(2);
  });

  it('says what is missing when a key is absent, and tests end to end', async () => {
    expect(rerankProblem({ ...DEFAULT_SETTINGS, rerankProvider: 'mongodb' })).toMatch(/Atlas/);
    expect(rerankProblem({ ...DEFAULT_SETTINGS, rerankProvider: 'cohere' })).toMatch(/Cohere/);
    const { fetchImpl } = recordingFetch(() => ({ results: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.1 }] }));
    const r = await testReranker({ ...DEFAULT_SETTINGS, rerankProvider: 'cohere', cohereApiKey: 'k' }, fetchImpl);
    expect(r.ok).toBe(true);
  });
});
