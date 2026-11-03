import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_AWS_SETTINGS } from '../../src/core/aws.js';
import {
  DEFAULT_SETTINGS,
  buildThreadKey,
  type ConversationRecord,
  type MessageRecord,
  type SettingsRecord,
} from '../../src/core/schema.js';
import {
  RERANK_MAX_DOCUMENTS,
  RERANK_MAX_DOC_CHARS,
  RerankError,
  applyRerankOrder,
  bestMatchingExcerpt,
  buildRerankDocument,
  clearRerankCache,
  firstStageHeadStart,
  fuseRerankScores,
  remoteRerankAllowed,
  remoteRerankAllowedKeys,
  rerankDocuments,
  rerankHostOrigins,
  rerankProblem,
  rerankThreads,
  rerankerHook,
  testReranker,
} from '../../src/core/rerank.js';
import { ThreadkeeperDB, ensureStarterCollectionsAndSettings, upsertThread, type UpsertThreadInput } from '../../src/core/db.js';
import { runHybridSearch } from '../../src/core/search.js';

interface Call {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

function recordingFetch(respond: (call: Call) => unknown, status = 200) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    calls.push(call);
    return new Response(JSON.stringify(respond(call)), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

/** Voyage answer: score = 1 / (1 + position of the word "best" … or 0.1). */
function voyageScores(call: Call): unknown {
  const docs = call.body.documents as string[];
  const data = docs
    .map((d, index) => ({ index, relevance_score: d.includes('best') ? 0.9 : d.includes('good') ? 0.6 : 0.1 }))
    .sort((a, b) => b.relevance_score - a.relevance_score);
  return { object: 'list', data, model: call.body.model, usage: { total_tokens: 42 } };
}

const voyage: SettingsRecord = { ...DEFAULT_SETTINGS, rerankProvider: 'voyage', voyageApiKey: 'pa-key', rerankModel: 'rerank-3' };

function bedrock(aws: Partial<SettingsRecord['aws']>, model: SettingsRecord['bedrockRerankModel'] = 'cohere.rerank-v3-5:0'): SettingsRecord {
  return {
    ...DEFAULT_SETTINGS,
    rerankProvider: 'bedrock',
    bedrockRerankModel: model,
    aws: { ...DEFAULT_AWS_SETTINGS, ...aws },
  };
}

const IAM = { auth: 'iam' as const, accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'secret' };

beforeEach(() => clearRerankCache());

describe('Voyage rerank', () => {
  it('sends the documented request and returns scores sorted by relevance, cut to topK', async () => {
    const { calls, fetchImpl } = recordingFetch(voyageScores);
    const out = await rerankDocuments(voyage, 'webhook fix', ['plain', 'the best one', 'a good one'], 2, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.voyageai.com/v1/rerank');
    expect(calls[0].headers.get('authorization')).toBe('Bearer pa-key');
    expect(calls[0].body).toEqual({
      query: 'webhook fix',
      documents: ['plain', 'the best one', 'a good one'],
      model: 'rerank-3',
      top_k: 3,
      truncation: true,
    });
    expect(out).toEqual([
      { index: 1, score: 0.9 },
      { index: 2, score: 0.6 },
    ]);
  });

  it('surfaces the {detail} error body', async () => {
    const { fetchImpl } = recordingFetch(() => ({ detail: 'Unauthorized' }), 401);
    const err = await rerankDocuments(voyage, 'q', ['a', 'b'], 2, fetchImpl).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RerankError);
    expect((err as RerankError).message).toContain('Unauthorized');
    expect((err as RerankError).status).toBe(401);
  });

  it('rejects out-of-range indexes and non-numeric scores', async () => {
    const bad = recordingFetch(() => ({ data: [{ index: 7, relevance_score: 0.5 }] }));
    await expect(rerankDocuments(voyage, 'q', ['a', 'b'], 2, bad.fetchImpl)).rejects.toThrow(/out-of-range/);
    clearRerankCache();
    const nan = recordingFetch(() => ({ data: [{ index: 0, relevance_score: 'high' }] }));
    await expect(rerankDocuments(voyage, 'q', ['a', 'b'], 2, nan.fetchImpl)).rejects.toThrow(/non-numeric/);
  });

  it('caps documents at 1000 and each document at the length limit, and skips empty ones', async () => {
    const { calls, fetchImpl } = recordingFetch(voyageScores);
    const docs = Array.from({ length: 1200 }, (_, i) => (i === 0 ? 'x'.repeat(5000) : i === 1 ? '   ' : `doc ${i}`));
    const out = await rerankDocuments(voyage, 'q', docs, 2000, fetchImpl);
    const sent = calls[0].body.documents as string[];
    expect(sent).toHaveLength(RERANK_MAX_DOCUMENTS - 1);
    expect(sent[0]).toHaveLength(RERANK_MAX_DOC_CHARS);
    expect(out.some((r) => r.index === 1 || r.index >= RERANK_MAX_DOCUMENTS)).toBe(false);
    expect(out).toHaveLength(RERANK_MAX_DOCUMENTS - 1);
  });

  it('gives up after the timeout with a readable error', async () => {
    const hanging = ((_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      })) as typeof fetch;
    await expect(rerankDocuments(voyage, 'q', ['a', 'b'], 2, hanging, { timeoutMs: 20 })).rejects.toThrow(
      /rerank-3 did not answer within/
    );
  });
});

describe('Bedrock rerank', () => {
  it('uses the Rerank API with the exact documented body, signed as service "bedrock", for IAM keys', async () => {
    const settings = bedrock({ ...IAM, region: 'us-west-2' });
    const { calls, fetchImpl } = recordingFetch(() => ({
      results: [
        { index: 1, relevanceScore: 0.8 },
        { index: 0, relevanceScore: 0.3 },
      ],
    }));
    const out = await rerankDocuments(settings, 'stripe webhook', ['doc a', 'doc b'], 2, fetchImpl);
    expect(calls[0].url).toBe('https://bedrock-agent-runtime.us-west-2.amazonaws.com/rerank');
    expect(calls[0].headers.get('authorization')).toMatch(/Credential=AKIDEXAMPLE\/\d{8}\/us-west-2\/bedrock\/aws4_request/);
    expect(calls[0].body).toEqual({
      queries: [{ type: 'TEXT', textQuery: { text: 'stripe webhook' } }],
      sources: [
        { type: 'INLINE', inlineDocumentSource: { type: 'TEXT', textDocument: { text: 'doc a' } } },
        { type: 'INLINE', inlineDocumentSource: { type: 'TEXT', textDocument: { text: 'doc b' } } },
      ],
      rerankingConfiguration: {
        type: 'BEDROCK_RERANKING_MODEL',
        bedrockRerankingConfiguration: {
          modelConfiguration: { modelArn: 'arn:aws:bedrock:us-west-2::foundation-model/cohere.rerank-v3-5:0' },
          numberOfResults: 2,
        },
      },
    });
    expect(out).toEqual([
      { index: 1, score: 0.8 },
      { index: 0, score: 0.3 },
    ]);
  });

  it('uses InvokeModel on bedrock-runtime with a Bedrock API key (Cohere Rerank 3.5)', async () => {
    const settings = bedrock({ region: 'us-east-1', bedrockApiKey: 'bedrock-api-key-x' });
    const { calls, fetchImpl } = recordingFetch(() => ({
      results: [
        { index: 2, relevance_score: 0.71 },
        { index: 0, relevance_score: 0.32 },
        { index: 1, relevance_score: 0.05 },
      ],
    }));
    const out = await rerankDocuments(settings, 'capital', ['a', 'b', 'c'], 3, fetchImpl);
    expect(calls[0].url).toBe('https://bedrock-runtime.us-east-1.amazonaws.com/model/cohere.rerank-v3-5%3A0/invoke');
    expect(calls[0].headers.get('authorization')).toBe('Bearer bedrock-api-key-x');
    expect(calls[0].body).toEqual({ query: 'capital', documents: ['a', 'b', 'c'], top_n: 3, api_version: 2 });
    expect(out.map((r) => r.index)).toEqual([2, 0, 1]);
  });

  it('asks for IAM keys when Amazon Rerank 1.0 is used with an API key, without calling AWS', async () => {
    const settings = bedrock({ region: 'us-west-2', bedrockApiKey: 'k' }, 'amazon.rerank-v1:0');
    const { calls, fetchImpl } = recordingFetch(() => ({}));
    await expect(rerankDocuments(settings, 'q', ['a', 'b'], 2, fetchImpl)).rejects.toThrow(/needs IAM access keys/);
    expect(calls).toHaveLength(0);
    // With IAM keys the same model goes to the Rerank API.
    const iam = recordingFetch(() => ({ results: [{ index: 0, relevanceScore: 0.5 }] }));
    await rerankDocuments(bedrock({ ...IAM, region: 'us-west-2' }, 'amazon.rerank-v1:0'), 'q', ['a', 'b'], 2, iam.fetchImpl);
    expect((iam.calls[0].body.rerankingConfiguration as { bedrockRerankingConfiguration: { modelConfiguration: { modelArn: string } } })
      .bedrockRerankingConfiguration.modelConfiguration.modelArn).toBe('arn:aws:bedrock:us-west-2::foundation-model/amazon.rerank-v1:0');
  });

  it('refuses regions where the model is not offered, naming the ones that work', async () => {
    const { calls, fetchImpl } = recordingFetch(() => ({}));
    const cohereEu = bedrock({ ...IAM, region: 'eu-west-1' });
    expect(rerankProblem(cohereEu)).toBe(
      'Cohere Rerank 3.5 is not available in eu-west-1. Use one of: us-east-1, us-west-2, ca-central-1, eu-central-1, ap-northeast-1.'
    );
    await expect(rerankDocuments(cohereEu, 'q', ['a', 'b'], 2, fetchImpl)).rejects.toThrow(/not available in eu-west-1/);
    const amazonUsEast = bedrock({ ...IAM, region: 'us-east-1' }, 'amazon.rerank-v1:0');
    await expect(rerankDocuments(amazonUsEast, 'q', ['a', 'b'], 2, fetchImpl)).rejects.toThrow(
      /Amazon Rerank 1.0 is not available in us-east-1/
    );
    expect(rerankProblem(bedrock({ ...IAM, region: 'ap-northeast-1' }, 'amazon.rerank-v1:0'))).toBeNull();
    expect(rerankProblem(bedrock({ region: 'nowhere' }))).toMatch(/AWS region/);
    expect(calls).toHaveLength(0);
  });

  it('names the host each credential kind needs', () => {
    expect(rerankHostOrigins(voyage)).toEqual(['https://api.voyageai.com/*']);
    expect(rerankHostOrigins(bedrock({ ...IAM, region: 'us-west-2' }))).toEqual([
      'https://bedrock-agent-runtime.us-west-2.amazonaws.com/*',
    ]);
    expect(rerankHostOrigins(bedrock({ region: 'us-east-1', bedrockApiKey: 'k' }))).toEqual([
      'https://bedrock-runtime.us-east-1.amazonaws.com/*',
    ]);
    expect(rerankHostOrigins(DEFAULT_SETTINGS)).toEqual([]);
  });
});

describe('Rerank cache', () => {
  it('serves repeated (query, document) pairs from memory and sends only new documents', async () => {
    const { calls, fetchImpl } = recordingFetch(voyageScores);
    const first = await rerankDocuments(voyage, 'webhook', ['the best one', 'plain'], 2, fetchImpl);
    const again = await rerankDocuments(voyage, 'webhook', ['plain', 'the best one'], 2, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(again).toEqual([
      { index: 1, score: first[0].score },
      { index: 0, score: first[1].score },
    ]);

    await rerankDocuments(voyage, 'webhook', ['plain', 'a good one', 'the best one'], 3, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(calls[1].body.documents).toEqual(['a good one']);

    await rerankDocuments(voyage, 'another query', ['plain', 'the best one'], 2, fetchImpl);
    await rerankDocuments({ ...voyage, rerankModel: 'rerank-3-lite' }, 'webhook', ['plain', 'the best one'], 2, fetchImpl);
    expect(calls).toHaveLength(4);
  });
});

describe('First-stage / reranker fusion', () => {
  const identity = (n: number) => Array.from({ length: n }, (_, i) => i);
  const allScored = (n: number, score: (i: number) => number) => new Map(identity(n).map((i) => [i, score(i)]));

  it('keeps the first-stage order when the reranker scores everything the same', () => {
    for (const s of [0, 0.37, 0.5, 1]) {
      expect(fuseRerankScores(40, allScored(40, () => s))).toEqual(identity(40));
    }
  });

  it('keeps first-stage #1 on top even when the reranker rates it lowest', () => {
    const order = fuseRerankScores(40, allScored(40, (i) => (i === 0 ? 0 : 1)));
    expect(order[0]).toBe(0);
  });

  it('lets #2 be passed only by #3, and only on a large score gap', () => {
    expect(fuseRerankScores(10, allScored(10, (i) => (i === 1 ? 0 : 1))).slice(0, 4)).toEqual([0, 2, 1, 3]);
    expect(fuseRerankScores(10, allScored(10, (i) => (i === 1 ? 0.6 : i === 2 ? 1 : 0.5))).slice(0, 3)).toEqual([0, 1, 2]);
  });

  it('lets a strongly relevant tail result rise above weak mid-ranked ones, but not above the top 3', () => {
    const order = fuseRerankScores(40, allScored(40, (i) => (i === 19 ? 0.95 : 0.1)));
    expect(order.slice(0, 4)).toEqual([0, 1, 2, 19]);
  });

  it('lets the reranker reorder mid-ranked results it clearly prefers', () => {
    const order = fuseRerankScores(12, allScored(12, (i) => (i === 3 ? 0.1 : i === 9 ? 0.9 : 0.5)));
    expect(order.indexOf(9)).toBeLessThan(order.indexOf(3));
  });

  it('keeps unscored (local-only) candidates in their exact first-stage slots', () => {
    const scores = allScored(8, (i) => i / 8);
    scores.delete(1);
    scores.delete(5);
    const order = fuseRerankScores(8, scores);
    expect(order[1]).toBe(1);
    expect(order[5]).toBe(5);
    expect([...order].sort((a, b) => a - b)).toEqual(identity(8));
  });

  it('shrinks the head start with rank, in tiers', () => {
    expect(firstStageHeadStart(1)).toBe(3);
    expect(firstStageHeadStart(2)).toBe(1.5);
    for (let r = 1; r < 100; r++) expect(firstStageHeadStart(r)).toBeGreaterThan(firstStageHeadStart(r + 1));
    expect(firstStageHeadStart(11) - firstStageHeadStart(100)).toBeLessThan(0.06);
  });

  it('applies a reranked order to a refreshed list without moving other items', () => {
    const items = ['x', 'a', 'b', 'new', 'c'];
    expect(applyRerankOrder(items, (s) => s, ['c', 'a', 'b'])).toEqual(['x', 'c', 'a', 'new', 'b']);
  });
});

describe('Rerank documents', () => {
  const msg = (ordinal: number, role: MessageRecord['role'], content: string) =>
    ({ messageKey: `m${ordinal}`, threadKey: 't', ordinal, role, content }) as MessageRecord;

  it('picks the passage that matches the most query terms and keeps documents short', () => {
    const messages = [
      msg(0, 'user', 'Tell me about the weather.'),
      msg(1, 'assistant', `${'filler '.repeat(200)}The stripe webhook retries are handled with an idempotency key.`),
      msg(2, 'tool', 'stripe webhook idempotency in a tool result'),
    ];
    const excerpt = bestMatchingExcerpt(messages, 'stripe webhook idempotency');
    expect(excerpt).toContain('stripe webhook retries');
    expect(excerpt.length).toBeLessThanOrEqual(601);
    expect(bestMatchingExcerpt(messages, 'xy')).toBe('');

    const doc = buildRerankDocument({ title: 'Payments', gist: 'Webhook retries', excerpt: 'x'.repeat(5000) });
    expect(doc.startsWith('Payments\nWebhook retries\n')).toBe(true);
    expect(doc.length).toBe(RERANK_MAX_DOC_CHARS);
    expect(buildRerankDocument({ title: 'Same', excerpt: 'Same' })).toBe('Same');
  });
});

function conv(key: string, patch: Partial<ConversationRecord> = {}): ConversationRecord {
  return { threadKey: key, provider: 'chatgpt', project: 'Work', cloudExcluded: false, isSyntheticBenchmark: false, ...patch } as ConversationRecord;
}

describe('Local-only threads and reranking', () => {
  it('mirrors the remote-processing rules', () => {
    const localOnly = new Set(['Personal']);
    expect(remoteRerankAllowed(conv('a'), DEFAULT_SETTINGS, localOnly)).toBe(true);
    expect(remoteRerankAllowed(conv('a', { cloudExcluded: true }), DEFAULT_SETTINGS, localOnly)).toBe(false);
    expect(remoteRerankAllowed(conv('a', { project: 'Personal' }), DEFAULT_SETTINGS, localOnly)).toBe(false);
    expect(remoteRerankAllowed(conv('a', { isSyntheticBenchmark: true }), DEFAULT_SETTINGS, localOnly)).toBe(false);
    expect(remoteRerankAllowed(conv('a'), { ...DEFAULT_SETTINGS, cloudExcludedProviders: ['chatgpt'] }, localOnly)).toBe(false);
  });

  it('never sends local-only text and keeps those threads in their first-stage slot', async () => {
    const { calls, fetchImpl } = recordingFetch(voyageScores);
    const outcome = await rerankThreads(
      voyage,
      'webhook',
      [
        { key: 'a', document: 'plain A' },
        { key: 'secret', document: 'SECRET local-only best' },
        { key: 'c', document: 'the best C' },
        { key: 'd', document: 'a good D' },
      ],
      new Set(['a', 'c', 'd']),
      fetchImpl
    );
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(calls[0].body)).not.toContain('SECRET');
    expect(outcome.order[1]).toBe('secret');
    expect(outcome.scores.has('secret')).toBe(false);
    expect(outcome.withheld).toBe(1);
    expect(outcome.label).toBe('rerank-3');

    const none = recordingFetch(voyageScores);
    const skipped = await rerankThreads(voyage, 'webhook', [{ key: 'secret', document: 'SECRET' }, { key: 'a', document: 'A' }], new Set(['a']), none.fetchImpl);
    expect(none.calls).toHaveLength(0);
    expect(skipped.order).toEqual(['secret', 'a']);
  });

  it('reads local-only state fresh from the database', async () => {
    const db = new ThreadkeeperDB(`RerankAllowedDB_${Date.now()}`);
    await ensureStarterCollectionsAndSettings(db);
    const keys = await seedThreads(db);
    const allowed = await remoteRerankAllowedKeys(db, DEFAULT_SETTINGS, Object.values(keys));
    expect(allowed.has(keys.retries)).toBe(true);
    expect(allowed.has(keys.idempotency)).toBe(true);
    expect(allowed.has(keys.privateNotes)).toBe(false);
    expect(allowed.has(keys.personal)).toBe(false);
    db.close();
  });
});

async function seedThreads(db: ThreadkeeperDB) {
  const make = async (id: string, title: string, content: string, extra: Partial<UpsertThreadInput> = {}) => {
    const threadKey = buildThreadKey({ provider: 'chatgpt', accountId: 'a', workspaceId: 'w', sourceConversationId: id, branchId: 'main' });
    await upsertThread(db, {
      threadKey,
      provider: 'chatgpt',
      accountId: 'a',
      workspaceId: 'w',
      sourceConversationId: id,
      branchId: 'main',
      canonicalUrl: `https://chatgpt.com/c/${id}`,
      title,
      createdAt: null,
      updatedAt: '2026-11-01T10:00:00.000Z',
      coverage: 'partial',
      captureSource: 'dom_observer',
      project: 'Work',
      messages: [{ sourceMessageId: `${id}_0`, role: 'user', content, createdAt: null }],
      ...extra,
    });
    return threadKey;
  };
  return {
    retries: await make('retries', 'Stripe webhook retries', 'webhook retries with backoff'),
    privateNotes: await make('private', 'Webhook signing secret', 'SECRET-LOCAL webhook signing key', { cloudExcluded: true }),
    idempotency: await make('idem', 'Webhook idempotency', 'webhook idempotency key, the best approach'),
    personal: await make('personal', 'Webhook for my bank', 'SECRET-PERSONAL webhook', { project: 'Personal' }),
  };
}

describe('runHybridSearch reranker hook', () => {
  it('reranks only allowed candidates with short documents and blends with first-stage rank', async () => {
    const db = new ThreadkeeperDB(`RerankHybridDB_${Date.now()}`);
    await ensureStarterCollectionsAndSettings(db);
    const keys = await seedThreads(db);
    const baseline = await runHybridSearch(db, { query: 'webhook' });
    const baseOrder = baseline.hits.map((h) => h.conversation.threadKey);
    expect(baseOrder).toHaveLength(4);

    const { calls, fetchImpl } = recordingFetch(voyageScores);
    const res = await runHybridSearch(db, { query: 'webhook', reranker: rerankerHook(voyage, fetchImpl) });
    expect(res.rerankFallbackUsed).toBe(false);
    const sent = calls[0].body.documents as string[];
    expect(sent).toHaveLength(2);
    expect(sent.join('\n')).not.toMatch(/SECRET/);
    expect(sent.some((d) => d.startsWith('Webhook idempotency\n'))).toBe(true);

    const order = res.hits.map((h) => h.conversation.threadKey);
    // Local-only threads keep their first-stage slots.
    expect(order.indexOf(keys.privateNotes)).toBe(baseOrder.indexOf(keys.privateNotes));
    expect(order.indexOf(keys.personal)).toBe(baseOrder.indexOf(keys.personal));
    expect(res.hits.find((h) => h.conversation.threadKey === keys.idempotency)?.rerankScore).toBe(0.9);
    expect(res.hits.find((h) => h.conversation.threadKey === keys.privateNotes)?.rerankScore).toBeNull();

    // Same query and documents would be served from the score cache.
    clearRerankCache();
    const failing = await runHybridSearch(db, {
      query: 'webhook',
      reranker: rerankerHook(voyage, recordingFetch(() => ({ detail: 'down' }), 503).fetchImpl),
    });
    expect(failing.rerankFallbackUsed).toBe(true);
    expect(failing.hits.map((h) => h.conversation.threadKey)).toEqual(baseOrder);
    db.close();
  });
});

describe('testReranker', () => {
  it('reports a working reranker and explains a missing one', async () => {
    const ok = await testReranker(voyage, recordingFetch((c) => ({
      data: (c.body.documents as string[]).map((_, index) => ({ index, relevance_score: index === 0 ? 0.8 : 0.1 })),
    })).fetchImpl);
    expect(ok).toEqual({ ok: true, message: 'Connected: rerank-3 ranked the test documents correctly.' });
    expect(await testReranker(DEFAULT_SETTINGS)).toEqual({ ok: false, message: 'No reranker is selected.' });
  });

  it('always reaches the provider, so a revoked key fails even after a passing test', async () => {
    const good = recordingFetch((c) => ({
      data: (c.body.documents as string[]).map((_, index) => ({ index, relevance_score: index === 0 ? 0.8 : 0.1 })),
    }));
    expect((await testReranker(voyage, good.fetchImpl)).ok).toBe(true);
    const revoked = recordingFetch(() => ({ detail: 'Unauthorized' }), 401);
    const second = await testReranker({ ...voyage, voyageApiKey: 'pa-revoked' }, revoked.fetchImpl);
    expect(revoked.calls).toHaveLength(1);
    expect(second.ok).toBe(false);
  });
});
