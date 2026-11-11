import { useCallback, useMemo, useRef, useState, type MutableRefObject } from 'react';
import {
  THREAD_KIND_LABELS,
  type ChangeLogEntry,
  type CollectionRecord,
  type ConversationRecord,
  type MessageRecord,
  type RelationshipRecord,
  type SettingsRecord,
  type StructuredSummaryRecord,
  type ThreadInsight,
  type ThreadVectorRecord,
} from '../../../core/schema.js';
import {
  UNFILED_PROJECT,
  ensureStarterCollectionsAndSettings,
  reconcileLibraryCounts,
  type LibraryReconciledCounts,
} from '../../../core/db.js';
import { MemorySearchIndex } from '../../../core/search.js';
import { seedSyntheticWorkbenchLibrary, seedWorkspaceDemoLibrary } from '../../../core/synthetic-fixtures.js';
import { resolveInsight } from '../../../core/insights.js';
import { LOCAL_SPACE, primarySpace } from '../../../core/embeddings.js';
import { countPendingAnalysis } from '../../../core/pipeline.js';
import { sharedDb } from '../shared.js';

/** What one load produced, handed to the owner of the view state so it can pick the open thread. */
export interface LibraryLoad {
  settings: SettingsRecord;
  conversations: ConversationRecord[];
  /** True for the first load of this page: the saved search, area and queue are restored then. */
  firstLoad: boolean;
  /** The thread to keep open; undefined means "pick one", null means "none". */
  preserveSelectionKey: string | null | undefined;
}

export interface LibraryDataOptions {
  surface: 'overlay' | 'page' | 'sidepanel';
  urlParams: URLSearchParams;
  /** The overlay loads nothing until its handshake is redeemed. */
  handshakeAuthorizedRef: MutableRefObject<boolean>;
  onLoaded: (load: LibraryLoad) => void;
}

/** The library tables as React state, one `reloadAll` to refresh them, and the maps views derive from them. */
export function useLibraryData({ surface, urlParams, handshakeAuthorizedRef, onLoaded }: LibraryDataOptions) {
  const [settings, setSettings] = useState<SettingsRecord | null>(null);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [allMessages, setAllMessages] = useState<MessageRecord[]>([]);
  const [summaries, setSummaries] = useState<StructuredSummaryRecord[]>([]);
  const [relationships, setRelationships] = useState<RelationshipRecord[]>([]);
  const [changeLogs, setChangeLogs] = useState<ChangeLogEntry[]>([]);
  const [counts, setCounts] = useState<LibraryReconciledCounts | null>(null);
  const [insightRows, setInsightRows] = useState<ThreadInsight[]>([]);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [vectorRows, setVectorRows] = useState<ThreadVectorRecord[]>([]);
  const [pendingAnalysis, setPendingAnalysis] = useState(0);

  const initialLoadDoneRef = useRef(false);
  // reloadAll keeps its identity (surface, urlParams) while the callback follows the latest render.
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  const reloadAll = useCallback(
    async (preserveSelectionKey?: string | null) => {
      if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
      const loadedSettings = await ensureStarterCollectionsAndSettings(sharedDb);
      // ?seed=2 adds the workspace demo (coding sessions across accounts and repositories) for
      // screenshots and the preview server; it is never loaded into a library on its own.
      if (urlParams.get('seed') === '2' && !initialLoadDoneRef.current) {
        await seedSyntheticWorkbenchLibrary(sharedDb);
        await seedWorkspaceDemoLibrary(sharedDb);
      }
      if (urlParams.get('seed') === '1' && !initialLoadDoneRef.current) {
        await seedSyntheticWorkbenchLibrary(sharedDb);
      }
      const space = primarySpace(loadedSettings);
      const [convs, msgs, sums, rels, logs, reconciled, insights, cols, vecs, pending] = await Promise.all([
        sharedDb.conversations.toArray(),
        sharedDb.messages.toArray(),
        sharedDb.summaries.toArray(),
        sharedDb.relationships.toArray(),
        sharedDb.changeLogs.orderBy('createdAt').reverse().toArray(),
        reconcileLibraryCounts(sharedDb),
        sharedDb.insights.toArray(),
        sharedDb.collections.toArray(),
        sharedDb.threadVectors.where('space').anyOf(Array.from(new Set([LOCAL_SPACE, space.id]))).toArray(),
        countPendingAnalysis(sharedDb),
      ]);

      setSettings(loadedSettings);
      setConversations(convs);
      setAllMessages(msgs);
      setSummaries(sums);
      setRelationships(rels);
      setChangeLogs(logs);
      setCounts(reconciled);
      setInsightRows(insights);
      setCollections(cols);
      setVectorRows(vecs);
      setPendingAnalysis(pending);

      const firstLoad = !initialLoadDoneRef.current;
      if (firstLoad) initialLoadDoneRef.current = true;
      onLoadedRef.current({ settings: loadedSettings, conversations: convs, firstLoad, preserveSelectionKey });
    },
    [surface, urlParams]
  );

  // ---- Derived data ----
  const summariesByThread = useMemo(() => new Map(summaries.map((s) => [s.threadKey, s])), [summaries]);

  const messagesByThread = useMemo(() => {
    const map = new Map<string, MessageRecord[]>();
    for (const m of allMessages) {
      const list = map.get(m.threadKey) ?? [];
      list.push(m);
      map.set(m.threadKey, list);
    }
    for (const list of map.values()) list.sort((a, b) => a.ordinal - b.ordinal);
    return map;
  }, [allMessages]);

  const insightsByThread = useMemo(() => {
    const local = new Map<string, ThreadInsight>();
    const ai = new Map<string, ThreadInsight>();
    for (const i of insightRows) (i.source === 'ai' ? ai : local).set(i.threadKey, i);
    const resolved = new Map<string, ThreadInsight>();
    for (const c of conversations) {
      const r = resolveInsight(c, local.get(c.threadKey), ai.get(c.threadKey));
      if (r) resolved.set(c.threadKey, r);
    }
    return resolved;
  }, [insightRows, conversations]);

  const vectorsByThread = useMemo(() => {
    const map = new Map<string, Map<string, number[]>>();
    for (const v of vectorRows) {
      const m = map.get(v.threadKey) ?? new Map<string, number[]>();
      m.set(v.space, v.embedding);
      map.set(v.threadKey, m);
    }
    return map;
  }, [vectorRows]);

  const projectNames = useMemo(() => {
    const names = new Set<string>(collections.map((c) => c.name));
    for (const c of conversations) if (c.project) names.add(c.project);
    const countOf = (n: string) => counts?.projectCounts[n] ?? 0;
    return Array.from(names)
      .filter((n) => n !== UNFILED_PROJECT)
      .sort((a, b) => countOf(b) - countOf(a) || a.localeCompare(b))
      .concat(UNFILED_PROJECT);
  }, [collections, conversations, counts]);

  const collectionByName = useMemo(() => new Map(collections.map((c) => [c.name, c])), [collections]);

  const searchIndex = useMemo(() => {
    const idx = new MemorySearchIndex();
    const extra = new Map<string, string>();
    for (const [k, i] of insightsByThread) {
      extra.set(k, `${i.title} ${i.gist} ${i.summary} ${i.topics.join(' ')} ${i.entities.join(' ')} ${THREAD_KIND_LABELS[i.kind]}`);
    }
    idx.loadSnapshot({ conversations, messages: allMessages, summaries, extraMetaByThread: extra });
    return idx;
  }, [conversations, allMessages, summaries, insightsByThread]);

  return {
    settings,
    setSettings,
    conversations,
    allMessages,
    summaries,
    relationships,
    changeLogs,
    counts,
    insightRows,
    collections,
    vectorRows,
    pendingAnalysis,
    reloadAll,
    summariesByThread,
    messagesByThread,
    insightsByThread,
    vectorsByThread,
    projectNames,
    collectionByName,
    searchIndex,
  };
}
