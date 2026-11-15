import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  ConversationRecord,
  CoverageState,
  MessageRecord,
  ProviderId,
  ResurfaceQueue,
  SettingsRecord,
  StructuredSummaryRecord,
  ThreadInsight,
  ThreadKind,
  ThreadVectorRecord,
  WorkflowState,
} from '../../../core/schema.js';
import { fuseThreadVectors, type MemorySearchIndex, type SearchHit } from '../../../core/search.js';
import { computeResurfacingQueueItems } from '../../../core/organization.js';
import { getSmartTitle } from '../../../core/insights.js';
import { LOCAL_SPACE, embedTexts, localHashEmbedding, remoteSpace } from '../../../core/embeddings.js';
import {
  applyRerankOrder,
  bestMatchingExcerpt,
  buildRerankDocument,
  remoteRerankAllowedKeys,
  rerankReady,
  rerankThreads,
} from '../../../core/rerank.js';
import { sortThreadHits, type ThreadSortMode } from '../BulkActions.js';
import { sharedDb } from '../shared.js';
import { matchesRunFilter, type RunFilter } from '../threads/filters.js';
import {
  buildRepositoryIndex,
  groupThreadHits,
  matchesRepository,
  useThreadGrouping,
} from '../threads/grouping.js';
import { CARD_ITEMS, KANBAN_STATES } from '../threads/ListPane.js';
import { sessionGroupOf, type SessionGroup as SessionKind } from '../workspace/state.js';

export interface ThreadSearchInput {
  settings: SettingsRecord | null;
  conversations: ConversationRecord[];
  searchIndex: MemorySearchIndex;
  summariesByThread: Map<string, StructuredSummaryRecord>;
  messagesByThread: Map<string, MessageRecord[]>;
  insightsByThread: Map<string, ThreadInsight>;
  vectorsByThread: Map<string, Map<string, number[]>>;
  vectorRows: ThreadVectorRecord[];
  searchQuery: string;
  providerFilter: ProviderId | 'all';
  /** A project name, or "All threads". */
  activeArea: string;
  stateFilter: WorkflowState | 'all';
  coverageFilter: CoverageState | 'all';
  kindFilter: ThreadKind | 'all';
  activeQueue: ResurfaceQueue | 'all';
  sortMode: ThreadSortMode;
  /** Normalized repository ("owner/name") to keep, or null for every repository. */
  repositoryFilter?: string | null;
  /** Workspace account id to keep (see accountOfThread), or null for every account. */
  accountFilter?: string | null;
  runFilter?: RunFilter;
  /** Type of session (coding, chats, bots, other) to keep, or 'all'. */
  typeFilter?: SessionKind | 'all';
  /** The workspace account id a thread belongs to; needed for `accountFilter`. */
  accountIdOf?: (conv: ConversationRecord) => string | null;
  /** Account ids in sign-in order then account order; orders account groups. */
  accountOrder?: readonly string[];
}

/** The threads a query, the filters and the chosen queue leave, in list order, plus the explicit-submit rerank. */
export function useThreadSearch({
  settings,
  conversations,
  searchIndex,
  summariesByThread,
  messagesByThread,
  insightsByThread,
  vectorsByThread,
  vectorRows,
  searchQuery,
  providerFilter,
  activeArea,
  stateFilter,
  coverageFilter,
  kindFilter,
  activeQueue,
  sortMode,
  repositoryFilter = null,
  accountFilter = null,
  runFilter = 'all',
  typeFilter = 'all',
  accountIdOf,
  accountOrder,
}: ThreadSearchInput) {
  const scope = useMemo(
    () => ({
      provider: providerFilter,
      project: activeArea,
      workflowState: stateFilter,
      coverage: coverageFilter,
      includeSyntheticBenchmark: false,
    }),
    [providerFilter, activeArea, stateFilter, coverageFilter]
  );

  const queueItemsMap = useMemo(() => {
    if (activeQueue === 'all') return null;
    const items = computeResurfacingQueueItems(conversations, summariesByThread, activeQueue);
    return new Map(items.map((i) => [i.conversation.threadKey, i]));
  }, [conversations, summariesByThread, activeQueue]);
  const repositoryIndex = useMemo(() => buildRepositoryIndex(conversations), [conversations]);
  const scopedHits = useMemo(() => searchIndex.searchLocal('', scope, 100000).hits.filter((h) => {
    const c = h.conversation;
    return (!queueItemsMap || queueItemsMap.has(c.threadKey)) &&
      (kindFilter === 'all' || insightsByThread.get(c.threadKey)?.kind === kindFilter) &&
      (!repositoryFilter || matchesRepository(repositoryIndex.get(c.threadKey), repositoryFilter)) &&
      (!accountFilter || !accountIdOf || accountIdOf(c) === accountFilter) &&
      (runFilter === 'all' || matchesRunFilter(c.agentState, runFilter)) &&
      (typeFilter === 'all' || sessionGroupOf(c.provider) === typeFilter);
  }), [searchIndex, scope, queueItemsMap, kindFilter, insightsByThread, repositoryFilter, repositoryIndex, accountFilter, accountIdOf, runFilter, typeFilter]);
  const scopedKeys = useMemo(() => new Set(scopedHits.map((h) => h.conversation.threadKey)), [scopedHits]);
  const gists = useMemo(() => new Map([...insightsByThread].map(([key, i]) => [key, i.gist])), [insightsByThread]);

  const configuredSpace = settings ? remoteSpace(settings) : null;
  const searchKey = JSON.stringify([searchQuery.trim(), scope, kindFilter, activeQueue, repositoryFilter,
    accountFilter, runFilter, typeFilter, configuredSpace?.id, settings?.voyageEndpoint, settings?.mongodbGeography,
    settings?.cloudExcludedProviders, settings?.rerankProvider, settings?.rerankInSearch, settings?.rerankModel,
    settings?.mongodbRerankModel, settings?.cohereRerankModel, settings?.bedrockRerankModel, settings?.rerankCandidates]);
  const currentKeyRef = useRef(searchKey);
  currentKeyRef.current = searchKey;
  const [semanticRun, setSemanticRun] = useState<{ key: string; space: string; embedding: number[]; allowed: ReadonlySet<string> } | null>(null);
  const [rerankRun, setRerankRun] = useState<{
    key: string;
    order: string[];
    scores: Map<string, number>;
    note: string;
  } | null>(null);
  const rerankAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => rerankAbortRef.current?.abort(), [searchKey, settings]);

  // Typing uses current on-device vectors only. Hosted query embeddings run on Enter.
  const localFirstStageResults = useMemo(() => {
    const lexical = searchIndex.searchLocal(searchQuery, scope, 5000);
    const hits = lexical.hits.filter((h) => scopedKeys.has(h.conversation.threadKey));
    const q = searchQuery.trim();
    return { ...lexical, hits: q.length < 3 ? hits : fuseThreadVectors({ lexical: hits, scoped: scopedHits,
      vectors: vectorRows, space: LOCAL_SPACE, queryEmbedding: localHashEmbedding(q), gists }) };
  }, [searchIndex, searchQuery, scope, scopedKeys, scopedHits, vectorRows, gists]);
  const firstStageResults = useMemo(() => {
    if (!semanticRun || semanticRun.key !== searchKey) return localFirstStageResults;
    return { ...localFirstStageResults, hits: fuseThreadVectors({ lexical: localFirstStageResults.hits,
      scoped: scopedHits.filter((h) => semanticRun.allowed.has(h.conversation.threadKey) && !h.conversation.cloudExcluded),
      vectors: vectorRows, space: semanticRun.space, queryEmbedding: semanticRun.embedding,
      threshold: 0.25, gists }) };
  }, [localFirstStageResults, semanticRun, searchKey, scopedHits, vectorRows, gists]);

  const searchResults = useMemo(() => {
    if (!rerankRun || rerankRun.key !== searchKey || rerankRun.order.length === 0) return firstStageResults;
    const hits = applyRerankOrder(firstStageResults.hits, (h) => h.conversation.threadKey, rerankRun.order).map((h) => {
      const s = rerankRun.scores.get(h.conversation.threadKey);
      return s === undefined ? h : { ...h, rerankScore: s };
    });
    return { ...firstStageResults, hits };
  }, [firstStageResults, rerankRun, searchKey]);
  const rerankNote = rerankRun && rerankRun.key === searchKey ? rerankRun.note : null;

  const displayedHits = searchResults.hits;

  // ---- List order and what each view shows ----
  const sortedHits: SearchHit[] = useMemo(
    () => sortThreadHits(displayedHits, sortMode, (c) => getSmartTitle(c, insightsByThread.get(c.threadKey) ?? null)),
    [displayedHits, sortMode, insightsByThread]
  );

  // Grouped list (full page, list view only): rows are listed group by group, so selection ranges,
  // select-all and j / k follow the order the rows are drawn in. Collapsed groups draw no rows, so
  // they have no keys in `viewKeys`.
  const { pageList, collapsed } = useThreadGrouping();
  const groupBy = settings?.threadsGroupBy ?? 'none';
  const groups = useMemo(() => {
    if (!pageList || groupBy === 'none' || settings?.viewMode === 'kanban' || settings?.viewMode === 'cards') return null;
    return groupThreadHits(sortedHits, groupBy, {
      repository: (c) => repositoryIndex.get(c.threadKey) ?? null,
      account: (c) => accountIdOf?.(c) ?? null,
      accountOrder,
    });
  }, [pageList, groupBy, settings?.viewMode, sortedHits, repositoryIndex, accountIdOf, accountOrder]);

  const listHits: SearchHit[] = useMemo(() => (groups ? groups.flatMap((g) => g.hits) : sortedHits), [groups, sortedHits]);

  const kanbanColumns = useMemo(
    () => KANBAN_STATES.map((state) => ({ state, hits: sortedHits.filter((h) => h.conversation.workflowState === state) })),
    [sortedHits]
  );

  const cardGroups = useMemo(
    () =>
      Array.from(
        sortedHits.reduce<Map<string, SearchHit[]>>((map, hit) => {
          const proj = hit.conversation.project || 'Unassigned';
          const list = map.get(proj) ?? [];
          list.push(hit);
          map.set(proj, list);
          return map;
        }, new Map())
      ),
    [sortedHits]
  );

  /** Threads visible in the current view, in reading order: what "Select all in view" and shift-click use. */
  const viewKeys = useMemo(() => {
    const shown =
      settings?.viewMode === 'kanban'
        ? kanbanColumns.flatMap((col) => col.hits)
        : settings?.viewMode === 'cards'
          ? cardGroups.flatMap(([, hits]) => hits.slice(0, CARD_ITEMS))
          : groups
            ? groups.filter((g) => !collapsed.has(g.id)).flatMap((g) => g.hits)
            : listHits;
    return shown.map((h) => h.conversation.threadKey);
  }, [settings?.viewMode, kanbanColumns, cardGroups, listHits, groups, collapsed]);

  /** Enter adds hosted semantic retrieval, then reranks the visible candidate pool. */
  const submitSearch = async () => {
    const q = searchQuery.trim();
    if (!settings || q.length < 2) return;
    const key = searchKey;
    rerankAbortRef.current?.abort();
    const controller = new AbortController();
    rerankAbortRef.current = controller;
    const superseded = () => controller.signal.aborted || currentKeyRef.current !== key;
    const notes: string[] = [];
    let hits = localFirstStageResults.hits;
    if (configuredSpace && vectorRows.some((v) => v.space === configuredSpace.id && scopedKeys.has(v.threadKey))) {
      try {
        const allowed = await remoteRerankAllowedKeys(sharedDb, settings, [...scopedKeys]);
        const eligible = scopedHits.filter((h) => allowed.has(h.conversation.threadKey));
        const currentRevisions = new Map(eligible.map((h) => [h.conversation.threadKey, h.conversation.sourceRevision]));
        if (superseded()) return;
        if (vectorRows.some((v) => v.space === configuredSpace.id && currentRevisions.get(v.threadKey) === v.sourceRevision)) {
          const [embedding] = await embedTexts(settings, configuredSpace, [q], 'query', fetch, { signal: controller.signal });
          if (superseded()) return;
          // Privacy can change while the network request is in flight.
          const currentAllowed = await remoteRerankAllowedKeys(sharedDb, settings, [...scopedKeys]);
          if (superseded()) return;
          hits = fuseThreadVectors({ lexical: hits, scoped: scopedHits.filter((h) => currentAllowed.has(h.conversation.threadKey)), vectors: vectorRows,
            space: configuredSpace.id, queryEmbedding: embedding, threshold: 0.25, gists });
          setSemanticRun({ key, space: configuredSpace.id, embedding, allowed: currentAllowed });
          notes.push(`Semantic search with ${configuredSpace.model}`);
        }
      } catch (err) {
        if (superseded()) return;
        setSemanticRun(null);
        notes.push(`Showing local search; semantic search failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const pool = hits.slice(0, Math.max(2, Math.min(100, settings.rerankCandidates || 40)));
    if (!settings.rerankInSearch || !rerankReady(settings) || pool.length < 2) {
      if (!superseded()) setRerankRun({ key, order: [], scores: new Map(), note: notes.join('. ') });
      return;
    }
    try {
      const allowed = await remoteRerankAllowedKeys(sharedDb, settings, pool.map((h) => h.conversation.threadKey));
      if (superseded()) return;
      const outcome = await rerankThreads(settings, q, pool.map((h) => {
        const insight = insightsByThread.get(h.conversation.threadKey) ?? null;
        return { key: h.conversation.threadKey, document: buildRerankDocument({
          title: getSmartTitle(h.conversation, insight), gist: insight?.gist,
          excerpt: bestMatchingExcerpt(messagesByThread.get(h.conversation.threadKey) ?? [], q) || h.supportingExcerpt,
        }) };
      }), allowed, fetch, { signal: controller.signal });
      if (superseded()) return;
      notes.push(outcome.scores.size === 0 ? 'Not reranked: the top results are local-only.' :
        `Reranked with ${outcome.label}${outcome.withheld ? ` (${outcome.withheld} local-only kept in place)` : ''}`);
      setRerankRun({ key, order: outcome.order, scores: outcome.scores, note: notes.join('. ') });
    } catch (err) {
      if (superseded()) return;
      notes.push(`Showing first-stage order; reranking failed: ${err instanceof Error ? err.message : String(err)}`);
      setRerankRun({ key, order: [], scores: new Map(), note: notes.join('. ') });
    }
  };

  return { rerankNote, queueItemsMap, displayedHits, listHits, kanbanColumns, cardGroups, viewKeys, submitSearch };
}
