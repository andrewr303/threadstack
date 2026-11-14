import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_AWS_SETTINGS } from '../../src/core/aws.js';
import { DEFAULT_SETTINGS, buildThreadKey, type SettingsRecord } from '../../src/core/schema.js';
import {
  EmbeddingError,
  embedTexts,
  embeddingHostOrigins,
  parseCohereEmbeddings,
  parseTitanEmbedding,
  remoteSpace,
  testEmbedding,
} from '../../src/core/embeddings.js';
import { ThreadkeeperDB, ensureStarterCollectionsAndSettings, saveSettingsPatch, upsertThread } from '../../src/core/db.js';
import { analyzeThreadRemotely } from '../../src/core/pipeline.js';

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

type Responder = (call: Call, n: number) => unknown | Promise<unknown>;

function recordingFetch(respond: Responder, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    const payload = await respond(call, calls.length);
    return new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

function vector(dims: number, seed: number): number[] {
  return Array.from({ length: dims }, (_, i) => ((i + seed) % 7) / 7);
}

function bedrockSettings(patch: Partial<SettingsRecord> = {}): SettingsRecord {
  return {
    ...DEFAULT_SETTINGS,
    embeddingProvider: 'bedrock',
    aws: { ...DEFAULT_AWS_SETTINGS, region: 'us-east-1', bedrockApiKey: 'bedrock-api-key-test' },
    ...patch,
  };
}

describe('Bedrock embedding spaces', () => {
  it('names the space after model and dimensions, and needs AWS credentials', () => {
    expect(remoteSpace(bedrockSettings())?.id).toBe('bedrock:amazon.titan-embed-text-v2:0:1024');
    expect(remoteSpace(bedrockSettings({ bedrockEmbeddingDimensions: 256 }))?.id).toBe(
      'bedrock:amazon.titan-embed-text-v2:0:256'
    );
    expect(remoteSpace(bedrockSettings({ bedrockEmbeddingModel: 'cohere.embed-v4:0', bedrockEmbeddingDimensions: 512 }))).toMatchObject({
      id: 'bedrock:cohere.embed-v4:0:512',
      provider: 'bedrock',
      model: 'cohere.embed-v4:0',
      dimensions: 512,
    });
    expect(remoteSpace(bedrockSettings({ aws: { ...DEFAULT_AWS_SETTINGS } }))).toBeNull();
  });

  it('asks for the runtime host of the configured region only', () => {
    expect(embeddingHostOrigins(bedrockSettings())).toEqual(['https://bedrock-runtime.us-east-1.amazonaws.com/*']);
    expect(embeddingHostOrigins(bedrockSettings({ aws: { ...DEFAULT_AWS_SETTINGS, region: 'bad region' } }))).toEqual([]);
    expect(embeddingHostOrigins({ ...DEFAULT_SETTINGS, embeddingProvider: 'voyage' })).toEqual([]);
  });
});

describe('Titan Text Embeddings V2', () => {
  it('makes one InvokeModel call per text with the documented body, bounded concurrency and input order kept', async () => {
    const settings = bedrockSettings({ bedrockEmbeddingDimensions: 512 });
    let inFlight = 0;
    let maxInFlight = 0;
    const { calls, fetchImpl } = recordingFetch(async (call) => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const n = Number(String(call.body.inputText).replace('text-', ''));
      // Later texts answer first, so order must come from the input, not arrival.
      await new Promise((r) => setTimeout(r, 12 - n));
      inFlight--;
      return { embedding: vector(512, n), inputTextTokenCount: 3 };
    });
    const texts = Array.from({ length: 10 }, (_, i) => `text-${i}`);
    const out = await embedTexts(settings, remoteSpace(settings)!, texts, 'document', fetchImpl);

    expect(calls).toHaveLength(10);
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(calls[0].url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/amazon.titan-embed-text-v2%3A0/invoke');
    expect(calls[0].headers.get('authorization')).toBe('Bearer bedrock-api-key-test');
    expect(calls[0].body).toEqual({ inputText: 'text-0', dimensions: 512, normalize: true, embeddingTypes: ['float'] });
    expect(out.map((v) => v.length)).toEqual(new Array(10).fill(512));
    out.forEach((v, i) => expect(v).toEqual(vector(512, i)));
  });

  it('accepts embeddingsByType.float and rejects a vector of the wrong size', async () => {
    expect(parseTitanEmbedding({ embeddingsByType: { float: [0.1, 0.2] } })).toEqual([0.1, 0.2]);
    expect(parseTitanEmbedding({ embeddingsByType: { binary: [1, 0] } })).toBeNull();
    expect(parseTitanEmbedding('nope')).toBeNull();

    const settings = bedrockSettings({ bedrockEmbeddingDimensions: 256 });
    const { fetchImpl } = recordingFetch(() => ({ embedding: vector(1024, 1) }));
    await expect(embedTexts(settings, remoteSpace(settings)!, ['a'], 'query', fetchImpl)).rejects.toThrow(
      /1024-dimensional vectors, expected 256/
    );
  });

  it('signs with SigV4 as service "bedrock" when IAM keys are configured', async () => {
    const settings = bedrockSettings({
      aws: { ...DEFAULT_AWS_SETTINGS, region: 'eu-central-1', auth: 'iam', accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' },
    });
    const { calls, fetchImpl } = recordingFetch(() => ({ embedding: vector(1024, 0) }));
    await embedTexts(settings, remoteSpace(settings)!, ['hello'], 'query', fetchImpl);
    expect(calls[0].url).toContain('https://bedrock-runtime.eu-central-1.amazonaws.com/model/');
    expect(calls[0].headers.get('authorization')).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/eu-central-1\/bedrock\/aws4_request/
    );
  });

  it('turns AWS failures into a readable EmbeddingError with the status', async () => {
    const settings = bedrockSettings();
    const { fetchImpl } = recordingFetch(() => ({ message: 'The security token included in the request is expired' }), 403);
    const err = await embedTexts(settings, remoteSpace(settings)!, ['a'], 'document', fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EmbeddingError);
    expect((err as EmbeddingError).status).toBe(403);
    expect((err as EmbeddingError).message).toMatch(/rejected the credentials.*expired/);
  });
});

describe('Cohere Embed v4', () => {
  it('batches at most 96 texts per call with the documented body and accepts both response shapes', async () => {
    const settings = bedrockSettings({ bedrockEmbeddingModel: 'cohere.embed-v4:0', bedrockEmbeddingDimensions: 256 });
    const { calls, fetchImpl } = recordingFetch((call, n) => {
      const texts = call.body.texts as string[];
      const rows = texts.map((_, i) => vector(256, i));
      // First batch: "embeddings_floats" (plain array); later: "embeddings_by_type".
      return n === 1
        ? { id: 'a', embeddings: rows, response_type: 'embeddings_floats', texts }
        : { id: 'b', embeddings: { float: rows }, response_type: 'embeddings_by_type', texts };
    });
    const texts = Array.from({ length: 200 }, (_, i) => `doc ${i}`);
    const out = await embedTexts(settings, remoteSpace(settings)!, texts, 'document', fetchImpl);

    expect(calls.map((c) => (c.body.texts as string[]).length)).toEqual([96, 96, 8]);
    expect(calls[0].url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/cohere.embed-v4%3A0/invoke');
    expect(calls[0].body).toMatchObject({
      input_type: 'search_document',
      output_dimension: 256,
      embedding_types: ['float'],
      truncate: 'RIGHT',
    });
    expect((calls[1].body.texts as string[])[0]).toBe('doc 96');
    expect(out).toHaveLength(200);
    expect(out[96]).toEqual(vector(256, 0));

    await embedTexts(settings, remoteSpace(settings)!, ['find the webhook fix'], 'query', fetchImpl);
    expect(calls[3].body.input_type).toBe('search_query');
  });

  it('rejects a response with the wrong number of vectors or no float output', async () => {
    expect(parseCohereEmbeddings({ embeddings: { int8: [[1, 2]] } })).toBeNull();
    expect(parseCohereEmbeddings({ embeddings: [[0.1], 'x'] })).toBeNull();
    const settings = bedrockSettings({ bedrockEmbeddingModel: 'cohere.embed-v4:0', bedrockEmbeddingDimensions: 256 });
    const { fetchImpl } = recordingFetch(() => ({ embeddings: [vector(256, 0)] }));
    await expect(embedTexts(settings, remoteSpace(settings)!, ['a', 'b'], 'document', fetchImpl)).rejects.toThrow(
      /unexpected number of vectors/
    );
  });
});

describe('testEmbedding', () => {
  it('reports the model and size, or the problem', async () => {
    const settings = bedrockSettings();
    const ok = await testEmbedding(settings, recordingFetch(() => ({ embedding: vector(1024, 2) })).fetchImpl);
    expect(ok).toEqual({ ok: true, message: 'Connected: amazon.titan-embed-text-v2:0 returns 1024-dimensional vectors.' });
    const missing = await testEmbedding(bedrockSettings({ aws: { ...DEFAULT_AWS_SETTINGS } }));
    expect(missing.ok).toBe(false);
  });
});

describe('Bedrock embeddings and local-only threads', () => {
  it('never sends a local-only thread, or one filed in a local-only project, to Bedrock', async () => {
    const db = new ThreadkeeperDB(`BedrockEmbedDB_${Date.now()}`);
    await ensureStarterCollectionsAndSettings(db);
    const settings = await saveSettingsPatch(db, {
      embeddingProvider: 'bedrock',
      aws: { ...DEFAULT_AWS_SETTINGS, region: 'us-west-2', bedrockApiKey: 'k' },
      autoOrganize: { ...DEFAULT_SETTINGS.autoOrganize, aiAnalysis: false },
    });
    const make = async (id: string, secret: string, extra: { cloudExcluded?: boolean; project?: string } = {}) => {
      const threadKey = buildThreadKey({ provider: 'chatgpt', accountId: 'a', workspaceId: 'w', sourceConversationId: id, branchId: 'main' });
      await upsertThread(db, {
        threadKey,
        provider: 'chatgpt',
        accountId: 'a',
        workspaceId: 'w',
        sourceConversationId: id,
        branchId: 'main',
        canonicalUrl: `https://chatgpt.com/c/${id}`,
        title: `Thread ${id}`,
        createdAt: null,
        updatedAt: new Date().toISOString(),
        coverage: 'partial',
        captureSource: 'dom_observer',
        messages: [{ sourceMessageId: `${id}_0`, role: 'user', content: secret, createdAt: null }],
        ...extra,
      });
      return threadKey;
    };
    const privateKey = await make('private', 'SECRET-LOCAL-ONLY', { cloudExcluded: true });
    const personalKey = await make('personal', 'SECRET-PERSONAL-PROJECT', { project: 'Personal' });
    const openKey = await make('open', 'shareable webhook notes');

    const { calls, fetchImpl } = recordingFetch(() => ({ embedding: vector(1024, 0) }));
    expect((await analyzeThreadRemotely(db, privateKey, { settings, fetchImpl })).status).toBe('skipped');
    expect((await analyzeThreadRemotely(db, personalKey, { settings, fetchImpl })).status).toBe('skipped');
    expect(calls).toHaveLength(0);

    expect((await analyzeThreadRemotely(db, openKey, { settings, fetchImpl })).status).toBe('embedded');
    expect(calls).toHaveLength(1);
    expect(String(calls[0].body.inputText)).toContain('shareable webhook notes');
    expect(await db.threadVectors.get(`bedrock:amazon.titan-embed-text-v2:0:1024|${openKey}`)).toBeTruthy();
    db.close();
  });
});
