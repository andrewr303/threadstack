import { beforeEach, describe, expect, it } from 'vitest';
import { embedTexts, localSpace, remoteSpace } from '../../src/core/embeddings.js';
import { clearRerankCache, rerankDocuments } from '../../src/core/rerank.js';
import { DEFAULT_SETTINGS, type SettingsRecord } from '../../src/core/schema.js';

const voyage: SettingsRecord = {
  ...DEFAULT_SETTINGS,
  embeddingProvider: 'voyage',
  rerankProvider: 'voyage',
  voyageEndpoint: 'mongodb',
  voyageApiKey: 'fixture-key',
};
const atlas: SettingsRecord = {
  ...voyage,
  embeddingProvider: 'mongodb',
  rerankProvider: 'mongodb',
  mongodbApiKey: 'fixture-key',
  mongodbEmbeddingDimensions: 256,
};

function jsonFetch(body: unknown): typeof fetch {
  // Keep NaN/Infinity intact to test untrusted values before any vector is stored.
  return (async () => {
    const response = new Response('{}');
    response.json = async () => body;
    return response;
  }) as typeof fetch;
}

beforeEach(clearRerankCache);

describe.each([voyage, atlas])('$embeddingProvider embedding response validation', (settings) => {
  const vector = Array(256).fill(0.1) as number[];

  it.each([
    ['duplicate indexes', { data: [{ index: 0, embedding: vector }, { index: 0, embedding: vector }] }],
    ['out-of-range indexes', { data: [{ index: 0, embedding: vector }, { index: 2, embedding: vector }] }],
    ['missing indexes', { data: [{ embedding: vector }, { index: 1, embedding: vector }] }],
    ['missing vectors', { data: [{ index: 0, embedding: vector }, { index: 1 }] }],
    ['nonfinite values', { data: [{ index: 0, embedding: vector }, { index: 1, embedding: Array(256).fill(NaN) }] }],
    ['mixed dimensions', { data: [{ index: 0, embedding: vector }, { index: 1, embedding: vector.slice(1) }] }],
    ['non-list data', { data: {} }],
    ['null body', null],
  ])('rejects %s', async (_name, body) => {
    await expect(embedTexts(settings, remoteSpace(settings)!, ['a', 'b'], 'document', jsonFetch(body))).rejects.toThrow();
  });

  it('validates dimensions across batch boundaries', async () => {
    let call = 0;
    const fetchImpl = (async (_input, init) => {
      const texts = (JSON.parse(String(init?.body)) as { input: string[] }).input;
      const embedding = Array(call++ === 0 ? 256 : 512).fill(0.1);
      return new Response(JSON.stringify({ data: texts.map((_, index) => ({ index, embedding })) }));
    }) as typeof fetch;
    await expect(embedTexts(settings, remoteSpace(settings)!, Array(49).fill('a'), 'document', fetchImpl)).rejects.toThrow(/dimension/i);
  });
});

describe.each([voyage, atlas])('$rerankProvider rerank response validation', (settings) => {
  it.each([
    ['duplicates', [{ index: 0, relevance_score: 0.9 }, { index: 0, relevance_score: 0.2 }]],
    ['partial response', [{ index: 0, relevance_score: 0.9 }]],
    ['empty response', []],
    ['nonfinite score', [{ index: 0, relevance_score: Infinity }, { index: 1, relevance_score: 0.2 }]],
  ])('rejects %s and leaves the cache empty', async (_name, data) => {
    await expect(rerankDocuments(settings, 'q', ['a', 'b'], 2, jsonFetch({ data }))).rejects.toThrow();
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      return new Response(JSON.stringify({ data: [{ index: 0, relevance_score: 0.9 }, { index: 1, relevance_score: 0.2 }] }));
    }) as typeof fetch;
    expect(await rerankDocuments(settings, 'q', ['a', 'b'], 2, fetchImpl)).toHaveLength(2);
    expect(requests).toBe(1);
  });
});

describe('embedding cancellation', () => {
  it('does not start a request for an already cancelled search', async () => {
    const controller = new AbortController();
    controller.abort();
    let requests = 0;
    const fetchImpl = (async () => { requests++; return new Response('{}'); }) as typeof fetch;
    await expect(embedTexts(voyage, remoteSpace(voyage)!, ['q'], 'query', fetchImpl, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toBe(0);
  });

  it('aborts a slow provider and starts no later batches', async () => {
    let requests = 0;
    const fetchImpl = (async (_input, init) => {
      requests++;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      });
    }) as typeof fetch;
    await expect(embedTexts(voyage, remoteSpace(voyage)!, Array(49).fill('q'), 'document', fetchImpl, { timeoutMs: 10 })).rejects.toThrow(/did not answer within/);
    expect(requests).toBe(1);
  });

  it('passes user cancellation to an in-flight request', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = (async (_input, init) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        requestSignal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
        controller.abort();
      });
    }) as typeof fetch;
    await expect(embedTexts(voyage, remoteSpace(voyage)!, ['q'], 'query', fetchImpl, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(requestSignal?.aborted).toBe(true);
  });

  it('keeps local search independent of network deadlines', async () => {
    expect(await embedTexts(DEFAULT_SETTINGS, localSpace(), ['offline'], 'query')).toHaveLength(1);
  });
});
