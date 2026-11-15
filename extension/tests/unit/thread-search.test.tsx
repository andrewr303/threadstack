import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { embedTexts, remoteSpace } from '../../src/core/embeddings.js';
import { rerankThreads } from '../../src/core/rerank.js';
import { ensureStarterCollectionsAndSettings, upsertThread } from '../../src/core/db.js';
import { DEFAULT_SETTINGS, type SettingsRecord, type ThreadVectorRecord } from '../../src/core/schema.js';
import { MemorySearchIndex } from '../../src/core/search.js';
import { sharedDb } from '../../src/entrypoints/manager/shared.js';
import { useThreadSearch, type ThreadSearchInput } from '../../src/entrypoints/manager/hooks/useThreadSearch.js';

vi.mock('../../src/core/embeddings.js', async (original) => ({ ...await original<typeof import('../../src/core/embeddings.js')>(), embedTexts: vi.fn() }));
vi.mock('../../src/core/rerank.js', async (original) => ({ ...await original<typeof import('../../src/core/rerank.js')>(), rerankThreads: vi.fn() }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let container: HTMLDivElement;
let result: ReturnType<typeof useThreadSearch>;
let input: ThreadSearchInput;
const settings: SettingsRecord = { ...DEFAULT_SETTINGS, embeddingProvider: 'voyage', voyageEndpoint: 'legacy', voyageApiKey: 'test-key', rerankProvider: 'none' };
function Harness({ value }: { value: ThreadSearchInput }) { result = useThreadSearch(value); return null; }
async function render(patch: Partial<ThreadSearchInput> = {}) {
  input = { ...input, ...patch };
  await act(async () => { root.render(<Harness value={input} />); });
}
beforeEach(async () => {
  vi.clearAllMocks();
  vi.mocked(embedTexts).mockResolvedValue([[1, 0]]);
  vi.mocked(rerankThreads).mockImplementation(async (_s, _q, candidates) => ({ order: candidates.map((c) => c.key), scores: new Map(candidates.map((c) => [c.key, 0.5])), label: 'mock rerank', withheld: 0 }));
  await sharedDb.delete();
  await sharedDb.open();
  await ensureStarterCollectionsAndSettings(sharedDb);
  for (const [id, accountId, title] of [['literal', 'work', 'Deduplication retry'], ['semantic', 'work', 'Delivery reliability retry'], ['other', 'personal', 'Deduplication private retry']]) {
    await upsertThread(sharedDb, { threadKey: id, provider: 'chatgpt', accountId, workspaceId: 'w', sourceConversationId: id,
      branchId: 'main', canonicalUrl: `https://chatgpt.com/c/${id}`, title, createdAt: null, updatedAt: '2026-11-01T00:00:00Z',
      coverage: 'full', captureSource: 'export_import', project: 'Work', messages: [{ sourceMessageId: id, role: 'user', content: title, createdAt: null }] });
  }
  const conversations = await sharedDb.conversations.toArray();
  const searchIndex = new MemorySearchIndex();
  searchIndex.loadSnapshot({ conversations });
  const vectorRows: ThreadVectorRecord[] = conversations.map((c) => ({ vectorKey: c.threadKey, threadKey: c.threadKey,
    sourceRevision: c.sourceRevision, space: remoteSpace(settings)!.id, embedding: c.threadKey === 'literal' ? [-1, 0] : [1, 0], docHash: 'hash', updatedAt: '' }));
  input = { settings, conversations, searchIndex, summariesByThread: new Map(), messagesByThread: new Map(), insightsByThread: new Map(),
    vectorsByThread: new Map(), vectorRows, searchQuery: 'deduplication', providerFilter: 'all', activeArea: 'All threads',
    stateFilter: 'all', coverageFilter: 'all', kindFilter: 'all', activeQueue: 'all', sortMode: 'recent',
    accountFilter: 'work', accountIdOf: (c) => c.accountId };
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); await sharedDb.delete(); });

describe('explicit-submit manager retrieval', () => {
  it('keeps typing local, then discovers semantic-only threads in the active account on Enter', async () => {
    await render();
    expect(embedTexts).not.toHaveBeenCalled();
    expect(result.displayedHits.map((h) => h.conversation.threadKey)).toEqual(['literal']);
    await act(async () => { await result.submitSearch(); });
    expect(embedTexts).toHaveBeenCalledTimes(1);
    expect(vi.mocked(embedTexts).mock.calls[0].slice(2, 4)).toEqual([['deduplication'], 'query']);
    expect(result.displayedHits.map((h) => h.conversation.threadKey)).toEqual(['literal', 'semantic']);
    expect(result.rerankNote).toContain('Semantic search with voyage-4-lite');
    expect(rerankThreads).not.toHaveBeenCalled();
  });

  it('skips the hosted query call when scoped vectors are stale or every scoped thread is local-only', async () => {
    await render({ vectorRows: input.vectorRows.map((v) => ({ ...v, sourceRevision: -1 })) });
    await act(async () => { await result.submitSearch(); });
    expect(embedTexts).not.toHaveBeenCalled();
    await sharedDb.conversations.toCollection().modify({ cloudExcluded: true });
    await render({ vectorRows: input.vectorRows.map((v) => ({ ...v, sourceRevision: input.conversations.find((c) => c.threadKey === v.threadKey)!.sourceRevision })) });
    await act(async () => { await result.submitSearch(); });
    expect(embedTexts).not.toHaveBeenCalled();
  });

  it('retains local results and reports hosted embedding failure', async () => {
    vi.mocked(embedTexts).mockRejectedValue(new Error('temporary outage'));
    await render();
    await act(async () => { await result.submitSearch(); });
    expect(result.displayedHits.map((h) => h.conversation.threadKey)).toEqual(['literal']);
    expect(result.rerankNote).toContain('semantic search failed: temporary outage');
  });

  it('rechecks privacy when embedding returns and withholds newly local-only semantic candidates', async () => {
    vi.mocked(embedTexts).mockImplementation(async () => {
      await sharedDb.conversations.update('semantic', { cloudExcluded: true });
      return [[1, 0]];
    });
    await render();
    await act(async () => { await result.submitSearch(); });
    expect(result.displayedHits.map((h) => h.conversation.threadKey)).toEqual(['literal']);
  });

  it('ignores a completed hosted query after the query or account filter changes', async () => {
    let finish!: (value: number[][]) => void;
    vi.mocked(embedTexts).mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    await render();
    let pending!: Promise<void>;
    await act(async () => { pending = result.submitSearch(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(embedTexts).toHaveBeenCalledTimes(1);
    await render({ searchQuery: 'private', accountFilter: 'personal' });
    await act(async () => { finish([[1, 0]]); await pending; });
    expect(result.rerankNote).toBeNull();
    expect(result.displayedHits.map((h) => h.conversation.threadKey)).toEqual(['other']);
  });

  it('sends only the candidate pool left by the workspace filters to reranking', async () => {
    await render({ searchQuery: 'retry', vectorRows: [], settings: { ...settings, rerankProvider: 'voyage' } });
    await act(async () => { await result.submitSearch(); });
    expect(rerankThreads).toHaveBeenCalledTimes(1);
    const candidates = vi.mocked(rerankThreads).mock.calls[0][2];
    expect(candidates.map((c) => c.key).sort()).toEqual(['literal', 'semantic']);
    expect(candidates.every((c) => !c.document.includes('private'))).toBe(true);
  });
});
