import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  THREAD_KINDS,
  THREAD_KIND_LABELS,
  getDisplayTitle,
  type ChangeLogEntry,
  type CollectionRecord,
  type ConversationRecord,
  type CoverageState,
  type MessageRecord,
  type ProviderId,
  type RelationshipRecord,
  type ResurfaceQueue,
  type SettingsRecord,
  type StructuredSummaryRecord,
  type ThreadInsight,
  type ThreadKind,
  type ThreadVectorRecord,
  type WorkflowState,
} from '../../core/schema.js';
import {
  UNFILED_PROJECT,
  deleteConversationCascade,
  ensureStarterCollectionsAndSettings,
  reconcileLibraryCounts,
  saveSettingsPatch,
  updateManualThreadFields,
  type LibraryReconciledCounts,
} from '../../core/db.js';
import { exportThreadToMarkdown } from '../../core/adapters.js';
import { MemorySearchIndex, type SearchHit } from '../../core/search.js';
import {
  applyOrganizeProposals,
  computeResurfacingQueueItems,
  normalizeTags,
  previewNaturalLanguageOrganize,
  undoChangeLog,
  type OrganizeProposalItem,
} from '../../core/organization.js';
import { seedSyntheticWorkbenchLibrary } from '../../core/synthetic-fixtures.js';
import { requestThreadEnrichment } from '../../core/cloud-client.js';
import { PROVIDER_IDS, detectProviderFromUrl, extractConversationIdFromUrl, providerLabel } from '../../core/providers.js';
import { getSmartTitle, resolveInsight } from '../../core/insights.js';
import { LOCAL_SPACE, cosine, localHashEmbedding, primarySpace } from '../../core/embeddings.js';
import {
  applyRerankOrder,
  bestMatchingExcerpt,
  buildRerankDocument,
  remoteRerankAllowedKeys,
  rerankReady,
  rerankThreads,
} from '../../core/rerank.js';
import { hasClaudeKey } from '../../core/ai/claude.js';
import {
  analyzeThreadRemotely,
  countPendingAnalysis,
  enqueueLibraryAnalysis,
  processThreadsLocally,
  runAnalysisJobs,
} from '../../core/pipeline.js';
import { planLibraryOrganization } from '../../core/library-organize.js';
import {
  CoverageTick,
  KindLabel,
  StatusPill,
  notifyBackground,
  openModal,
  relativeTime,
  sharedDb,
} from './shared.js';
import { SettingsDialog } from './SettingsDialog.js';
import { ImportDialog, describeReport, syncSavedFolders } from './ImportDialog.js';
import { AskPanel } from './AskPanel.js';
import { SemanticNeighbors, ThreadOverview, type RelatedThread } from './ThreadOverview.js';
import { StaleBuildBanner, useDiagnostics } from './Diagnostics.js';
import {
  BulkActions,
  RowCheck,
  THREAD_SORT_LABELS,
  selectRange,
  sortThreadHits,
  type ThreadSortMode,
} from './BulkActions.js';

const RESURFACE_QUEUE_LABELS: Record<ResurfaceQueue, string> = {
  continue_working: 'Continue working',
  needs_review: 'Needs review',
  waiting: 'Waiting',
  recently_changed: 'Recently changed',
  unfiled: 'Unfiled',
  worth_revisiting: 'Worth revisiting',
};

const TRANSCRIPT_PAGE = 80;

const KANBAN_STATES: WorkflowState[] = ['active', 'needs_review', 'waiting', 'paused', 'done'];
/** Threads shown per project card. */
const CARD_ITEMS = 6;

type Surface = 'overlay' | 'page' | 'sidepanel';

interface AnalysisProgress {
  running: boolean;
  processed: number;
  analyzed: number;
  current: string | null;
  note: string | null;
}

function useEffectiveTheme(theme: SettingsRecord['theme'] | undefined): 'light' | 'dark' {
  const query = useMemo(
    () => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null),
    []
  );
  const [systemDark, setSystemDark] = useState(Boolean(query?.matches));
  useEffect(() => {
    if (!query) return;
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, [query]);
  if (theme === 'dark') return 'dark';
  if (theme === 'light') return 'light';
  return systemDark ? 'dark' : 'light';
}

export function App() {
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const isFramed = typeof window !== 'undefined' && window.top !== window.self;
  const requestedSurface =
    urlParams.get('surface') ?? document.documentElement.getAttribute('data-surface');
  const isUnauthenticatedFrame = isFramed && requestedSurface !== 'overlay';
  const surface: Surface =
    isFramed || requestedSurface === 'overlay'
      ? 'overlay'
      : requestedSurface === 'sidepanel'
        ? 'sidepanel'
        : 'page';
  const handshakeToken = useMemo(() => urlParams.get('token') ?? '', [urlParams]);
  const [overlayHandshakeState, setOverlayHandshakeState] = useState<'pending' | 'authorized' | 'rejected'>(
    isUnauthenticatedFrame ? 'rejected' : surface === 'overlay' ? 'pending' : 'authorized'
  );
  const [overlayHandshakeError, setOverlayHandshakeError] = useState<string | null>(
    isUnauthenticatedFrame ? 'Framing manager.html without surface=overlay is forbidden' : null
  );
  const handshakeAuthorizedRef = useRef<boolean>(!isFramed && surface !== 'overlay');

  // ---- Library data ----
  const [settings, setSettings] = useState<SettingsRecord | null>(null);
  const diagnostics = useDiagnostics();
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

  // ---- UI state ----
  const [searchQuery, setSearchQuery] = useState('');
  const [listMode, setListMode] = useState<'search' | 'ask'>('search');
  const [activeArea, setActiveArea] = useState<string>('All threads');
  const [activeQueue, setActiveQueue] = useState<ResurfaceQueue | 'all'>('all');
  const [providerFilter, setProviderFilter] = useState<ProviderId | 'all'>('all');
  const [stateFilter, setStateFilter] = useState<WorkflowState | 'all'>('all');
  const [coverageFilter, setCoverageFilter] = useState<CoverageState | 'all'>('all');
  const [kindFilter, setKindFilter] = useState<ThreadKind | 'all'>('all');
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null);
  const [mobileDetailVisible, setMobileDetailVisible] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisProgress>({ running: false, processed: 0, analyzed: 0, current: null, note: null });
  const [analyzingThread, setAnalyzingThread] = useState<string | null>(null);
  const [newProjectDraft, setNewProjectDraft] = useState<string | null>(null);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [activeTabThreadKey, setActiveTabThreadKey] = useState<string | null>(null);
  // Checked rows for bulk actions; separate from the opened thread (selectedThreadKey).
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  const [sortMode, setSortMode] = useState<ThreadSortMode>('recent');

  const [titleDraft, setTitleDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [tagInputDraft, setTagInputDraft] = useState('');

  const organizeDialogRef = useRef<HTMLDialogElement | null>(null);
  const importDialogRef = useRef<HTMLDialogElement | null>(null);
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null);
  const bulkDeleteDialogRef = useRef<HTMLDialogElement | null>(null);
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const checkAnchorRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const selectedKeyRef = useRef<string | null>(null);
  const initialLoadDoneRef = useRef(false);
  const backfillStartedRef = useRef(false);
  const analysisAbortRef = useRef<AbortController | null>(null);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [organizeInstruction, setOrganizeInstruction] = useState('');
  const [organizeProposals, setOrganizeProposals] = useState<OrganizeProposalItem[]>([]);
  const [organizeNotes, setOrganizeNotes] = useState<string[]>([]);
  const [organizeBusy, setOrganizeBusy] = useState<string | null>(null);
  const [organizeDeselected, setOrganizeDeselected] = useState<Set<string>>(new Set());

  const authorized = () => !(surface === 'overlay' && !handshakeAuthorizedRef.current);

  const reloadAll = useCallback(
    async (preserveSelectionKey?: string | null) => {
      if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
      const loadedSettings = await ensureStarterCollectionsAndSettings(sharedDb);
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

      if (!initialLoadDoneRef.current) {
        initialLoadDoneRef.current = true;
        const urlQuery = urlParams.get('q');
        setSearchQuery(urlQuery !== null ? urlQuery : loadedSettings.lastSearchQuery);
        setActiveArea(loadedSettings.lastActiveArea || 'All threads');
        setActiveQueue(loadedSettings.lastActiveQueue || 'all');
      }

      const targetKey =
        preserveSelectionKey !== undefined
          ? preserveSelectionKey
          : urlParams.get('threadKey') ||
            loadedSettings.lastSelectedThreadKey ||
            convs.find((c) => !c.isSyntheticBenchmark)?.threadKey ||
            null;
      selectedKeyRef.current = targetKey;
      setSelectedThreadKey(targetKey);
    },
    [surface, urlParams]
  );

  const scheduleReload = useCallback(() => {
    if (reloadTimerRef.current) clearTimeout(reloadTimerRef.current);
    reloadTimerRef.current = setTimeout(() => void reloadAll(selectedKeyRef.current), 700);
  }, [reloadAll]);

  // ---- Overlay handshake ----
  useEffect(() => {
    if (isUnauthenticatedFrame) {
      setOverlayHandshakeState('rejected');
      setOverlayHandshakeError('Framing manager.html without surface=overlay is forbidden');
      return;
    }
    if (surface !== 'overlay') {
      handshakeAuthorizedRef.current = true;
      void reloadAll();
      return;
    }
    try {
      const cleanParams = new URLSearchParams(window.location.search);
      cleanParams.delete('token');
      window.history.replaceState(null, '', `${window.location.pathname}?${cleanParams.toString()}`);
    } catch {
      // ignore replaceState failure
    }
    if (!handshakeToken || handshakeToken.length < 16) {
      setOverlayHandshakeState('rejected');
      setOverlayHandshakeError('Missing or invalid overlay handshakeToken');
      return;
    }
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage(
        { type: 'REDEEM_OVERLAY_HANDSHAKE', handshakeToken },
        (resp: { ok?: boolean; error?: string } | undefined) => {
          if (resp?.ok) {
            handshakeAuthorizedRef.current = true;
            setOverlayHandshakeState('authorized');
            void reloadAll();
          } else {
            handshakeAuthorizedRef.current = false;
            setOverlayHandshakeState('rejected');
            setOverlayHandshakeError(resp?.error ?? 'Overlay handshake token rejected');
          }
        }
      );
    } else {
      handshakeAuthorizedRef.current = true;
      setOverlayHandshakeState('authorized');
      void reloadAll();
    }
  }, []);

  // ---- Live updates from the service worker (captures, background analysis) ----
  useEffect(() => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const listener = (message: { type?: string }) => {
      if (message?.type === 'LIBRARY_CHANGED' && handshakeAuthorizedRef.current) scheduleReload();
    };
    chrome.runtime.onMessage.addListener(listener);
    const onFocus = () => handshakeAuthorizedRef.current && scheduleReload();
    window.addEventListener('focus', onFocus);
    return () => {
      chrome.runtime.onMessage.removeListener(listener);
      window.removeEventListener('focus', onFocus);
    };
  }, [scheduleReload]);

  const effectiveTheme = useEffectiveTheme(settings?.theme);
  useEffect(() => {
    if (!settings) return;
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    document.documentElement.setAttribute('data-density', settings.density);
  }, [effectiveTheme, settings?.density]);

  const persistSettingPatch = useCallback(async (patch: Partial<SettingsRecord>) => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    const updated = await saveSettingsPatch(sharedDb, patch);
    setSettings(updated);
    const affectsBackground = [
      'launchSurface',
      'aiBackend',
      'anthropicApiKey',
      'aws',
      'awsPlatformWorkspaceId',
      'awsPlatformApiKey',
      'aiModel',
      'autoOrganize',
      'embeddingProvider',
      'voyageApiKey',
      'openaiApiKey',
      'ollamaUrl',
      'ollamaEmbeddingModel',
      'bedrockEmbeddingModel',
      'bedrockEmbeddingDimensions',
      'authorizedHosts',
    ].some((k) => k in patch);
    if (affectsBackground) notifyBackground({ type: 'SETTINGS_CHANGED' });
  }, [surface]);

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

  // First stage: runs on every keystroke, so it stays local (no network).
  const firstStageResults = useMemo(() => {
    const lexical = searchIndex.searchLocal(searchQuery, scope, 5000);
    const q = searchQuery.trim();
    if (!q || q.length < 3 || vectorRows.length === 0) return lexical;
    // Fuse lexical ranks with on-device semantic ranks (reciprocal rank fusion).
    const scoped = new Map(searchIndex.searchLocal('', scope, 100000).hits.map((h) => [h.conversation.threadKey, h]));
    const qv = localHashEmbedding(q);
    const semantic: Array<[string, number]> = [];
    for (const [threadKey, bySpace] of vectorsByThread) {
      const v = bySpace.get(LOCAL_SPACE);
      if (!v || !scoped.has(threadKey)) continue;
      const sim = cosine(qv, v);
      if (sim >= 0.18) semantic.push([threadKey, sim]);
    }
    semantic.sort((a, b) => b[1] - a[1]);
    const fused = new Map<string, SearchHit>();
    lexical.hits.forEach((h, rank) => fused.set(h.conversation.threadKey, { ...h, score: 1 / (60 + rank + 1) }));
    semantic.slice(0, 40).forEach(([threadKey, sim], rank) => {
      const rrf = 1 / (60 + rank + 1);
      const existing = fused.get(threadKey);
      if (existing) {
        existing.score += rrf;
        existing.vectorScore = sim;
      } else {
        const base = scoped.get(threadKey)!;
        fused.set(threadKey, {
          ...base,
          score: rrf * 0.8,
          lexicalScore: 0,
          vectorScore: sim,
          matchReasons: ['Similar meaning'],
          supportingExcerpt: insightsByThread.get(threadKey)?.gist ?? base.supportingExcerpt,
        });
      }
    });
    return { ...lexical, hits: Array.from(fused.values()).sort((a, b) => b.score - a.score) };
  }, [searchIndex, searchQuery, scope, vectorsByThread, vectorRows.length, insightsByThread]);

  // Second stage: the reranked order from the last explicit submit, applied
  // only while the query and filters are unchanged.
  const searchKey = useMemo(() => JSON.stringify([searchQuery.trim(), scope]), [searchQuery, scope]);
  const [rerankRun, setRerankRun] = useState<{
    key: string;
    order: string[];
    scores: Map<string, number>;
    note: string;
  } | null>(null);
  const rerankAbortRef = useRef<AbortController | null>(null);
  useEffect(() => () => rerankAbortRef.current?.abort(), [searchKey]);

  const searchResults = useMemo(() => {
    if (!rerankRun || rerankRun.key !== searchKey || rerankRun.order.length === 0) return firstStageResults;
    const hits = applyRerankOrder(firstStageResults.hits, (h) => h.conversation.threadKey, rerankRun.order).map((h) => {
      const s = rerankRun.scores.get(h.conversation.threadKey);
      return s === undefined ? h : { ...h, rerankScore: s };
    });
    return { ...firstStageResults, hits };
  }, [firstStageResults, rerankRun, searchKey]);
  const rerankNote = rerankRun && rerankRun.key === searchKey ? rerankRun.note : null;

  const queueItemsMap = useMemo(() => {
    if (activeQueue === 'all') return null;
    const items = computeResurfacingQueueItems(conversations, summariesByThread, activeQueue);
    return new Map(items.map((i) => [i.conversation.threadKey, i]));
  }, [conversations, summariesByThread, activeQueue]);

  const displayedHits: SearchHit[] = useMemo(() => {
    let hits = searchResults.hits;
    if (queueItemsMap) hits = hits.filter((h) => queueItemsMap.has(h.conversation.threadKey));
    if (kindFilter !== 'all') hits = hits.filter((h) => insightsByThread.get(h.conversation.threadKey)?.kind === kindFilter);
    return hits;
  }, [searchResults.hits, queueItemsMap, kindFilter, insightsByThread]);

  // ---- List order and what each view shows ----
  const listHits: SearchHit[] = useMemo(
    () => sortThreadHits(displayedHits, sortMode, (c) => getSmartTitle(c, insightsByThread.get(c.threadKey) ?? null)),
    [displayedHits, sortMode, insightsByThread]
  );

  const kanbanColumns = useMemo(
    () => KANBAN_STATES.map((state) => ({ state, hits: listHits.filter((h) => h.conversation.workflowState === state) })),
    [listHits]
  );

  const cardGroups = useMemo(
    () =>
      Array.from(
        listHits.reduce<Map<string, SearchHit[]>>((map, hit) => {
          const proj = hit.conversation.project || 'Unassigned';
          const list = map.get(proj) ?? [];
          list.push(hit);
          map.set(proj, list);
          return map;
        }, new Map())
      ),
    [listHits]
  );

  /** Threads visible in the current view, in reading order: what "Select all in view" and shift-click use. */
  const viewKeys = useMemo(() => {
    const shown =
      settings?.viewMode === 'kanban'
        ? kanbanColumns.flatMap((col) => col.hits)
        : settings?.viewMode === 'cards'
          ? cardGroups.flatMap(([, hits]) => hits.slice(0, CARD_ITEMS))
          : listHits;
    return shown.map((h) => h.conversation.threadKey);
  }, [settings?.viewMode, kanbanColumns, cardGroups, listHits]);

  // Drop checked threads that no longer exist (deleted here or elsewhere).
  useEffect(() => {
    setCheckedKeys((prev) => {
      if (prev.size === 0) return prev;
      const live = new Set(conversations.map((c) => c.threadKey));
      const next = new Set(Array.from(prev).filter((k) => live.has(k)));
      return next.size === prev.size ? prev : next;
    });
  }, [conversations]);

  const selectedConversation = useMemo(
    () =>
      conversations.find((c) => c.threadKey === selectedThreadKey) ??
      displayedHits[0]?.conversation ??
      null,
    [conversations, selectedThreadKey, displayedHits]
  );

  useEffect(() => {
    if (!selectedConversation) return;
    setTitleDraft(getDisplayTitle(selectedConversation));
    setNotesDraft(selectedConversation.manualNotes);
    setTagInputDraft(selectedConversation.tags.join(', '));
    setActiveEvidenceId(null);
  }, [
    selectedConversation?.threadKey,
    selectedConversation?.manualTitleOverride,
    selectedConversation?.manualNotes,
    selectedConversation?.tags.join(','),
  ]);

  useEffect(() => setShowAllMessages(false), [selectedConversation?.threadKey]);

  const selectedMessages = useMemo(
    () => (selectedConversation ? messagesByThread.get(selectedConversation.threadKey) ?? [] : []),
    [selectedConversation, messagesByThread]
  );
  const selectedSummary = useMemo(
    () => (selectedConversation ? summariesByThread.get(selectedConversation.threadKey) ?? null : null),
    [selectedConversation, summariesByThread]
  );
  const selectedInsight = selectedConversation ? insightsByThread.get(selectedConversation.threadKey) ?? null : null;

  const selectedRelationships = useMemo(() => {
    if (!selectedConversation) return [];
    return relationships.filter(
      (r) =>
        (r.fromThreadKey === selectedConversation.threadKey || r.toThreadKey === selectedConversation.threadKey) &&
        !r.dismissedByUser
    );
  }, [relationships, selectedConversation]);

  const semanticNeighbors: RelatedThread[] = useMemo(() => {
    if (!selectedConversation || !settings) return [];
    const space = primarySpace(settings);
    const own = vectorsByThread.get(selectedConversation.threadKey);
    const spaceId = own?.has(space.id) ? space.id : LOCAL_SPACE;
    const threshold = spaceId === space.id ? space.relatedThreshold : 0.3;
    const qv = own?.get(spaceId);
    if (!qv) return [];
    const byKey = new Map(conversations.map((c) => [c.threadKey, c]));
    const out: RelatedThread[] = [];
    for (const [threadKey, bySpace] of vectorsByThread) {
      if (threadKey === selectedConversation.threadKey) continue;
      const conv = byKey.get(threadKey);
      if (!conv || conv.isSyntheticBenchmark || conv.sourceConversationId === selectedConversation.sourceConversationId) continue;
      const v = bySpace.get(spaceId);
      if (!v) continue;
      const sim = cosine(qv, v);
      if (sim >= threshold) out.push({ conv, similarity: sim });
    }
    return out.sort((a, b) => b.similarity - a.similarity).slice(0, 5);
  }, [selectedConversation, vectorsByThread, conversations, settings]);

  const providerOptions = useMemo(
    () => PROVIDER_IDS.filter((id) => (counts?.providerCounts[id] ?? 0) > 0 || id === providerFilter),
    [counts, providerFilter]
  );

  const aiReady = settings ? hasClaudeKey(settings) : false;

  // ---- One-time background work when the library opens ----
  useEffect(() => {
    if (!settings || backfillStartedRef.current || !handshakeAuthorizedRef.current) return;
    backfillStartedRef.current = true;
    void (async () => {
      // Threads captured before automatic analysis existed (or by an older version) get organized now.
      const localKeys = new Set(insightRows.filter((i) => i.source === 'local').map((i) => i.threadKey));
      const missing = conversations.filter((c) => !c.isSyntheticBenchmark && !localKeys.has(c.threadKey)).map((c) => c.threadKey);
      if (missing.length > 0) {
        setBusy(`Organizing ${missing.length} thread(s)…`);
        const r = await processThreadsLocally(sharedDb, missing, {
          aiDelaySeconds: 5,
          onProgress: (done, total) => setBusy(`Organizing ${done}/${total} threads…`),
        });
        setBusy(null);
        setStatusAnnouncement(`Organized ${r.analyzed} threads (${r.filed} filed automatically).`);
        notifyBackground({ type: 'RUN_ANALYSIS_NOW' });
        await reloadAll(selectedKeyRef.current);
      }
      if (surface !== 'overlay') {
        try {
          const report = await syncSavedFolders(settings, { interactive: false });
          if (report && report.imported > 0) {
            setStatusAnnouncement(describeReport(report));
            await reloadAll(selectedKeyRef.current);
          }
        } catch {
          // folder permission not granted this session; the Import dialog offers "Sync now"
        }
      }
    })();
  }, [settings, conversations, insightRows]);

  // ---- Side panel: follow the conversation open in the active tab ----
  useEffect(() => {
    if (surface === 'overlay' || typeof chrome === 'undefined' || !chrome.tabs?.query) return;
    const update = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        const url = tab?.url ?? '';
        const provider = detectProviderFromUrl(url);
        const convId = extractConversationIdFromUrl(url);
        if (!provider || !convId) {
          setActiveTabThreadKey(null);
          return;
        }
        const match = (await sharedDb.conversations.where('sourceConversationId').equals(convId).toArray()).find(
          (c) => c.provider === provider && c.branchId === 'main'
        );
        setActiveTabThreadKey(match?.threadKey ?? null);
      } catch {
        setActiveTabThreadKey(null);
      }
    };
    void update();
    const onActivated = () => void update();
    const onUpdated = (_id: number, info: { url?: string; status?: string }) => {
      if (info.url || info.status === 'complete') void update();
    };
    chrome.tabs.onActivated?.addListener(onActivated);
    chrome.tabs.onUpdated?.addListener(onUpdated);
    return () => {
      chrome.tabs.onActivated?.removeListener(onActivated);
      chrome.tabs.onUpdated?.removeListener(onUpdated);
    };
  }, [surface, conversations.length]);

  // ---- Handlers ----
  const handleSelectThread = (threadKey: string) => {
    selectedKeyRef.current = threadKey;
    setSelectedThreadKey(threadKey);
    setMobileDetailVisible(true);
    void persistSettingPatch({ lastSelectedThreadKey: threadKey });
  };

  /** Check or uncheck a row; shift extends from the last row checked. Never changes the opened thread. */
  const handleToggleChecked = (threadKey: string, checked: boolean, extendRange: boolean) => {
    const anchor = extendRange ? checkAnchorRef.current : null;
    setCheckedKeys((prev) => selectRange(viewKeys, prev, anchor, threadKey, checked));
    checkAnchorRef.current = threadKey;
  };

  const handleBulkChanged = async (message: string, deletedKeys: readonly string[]) => {
    const deleted = new Set(deletedKeys);
    if (deleted.size > 0) setCheckedKeys((prev) => new Set(Array.from(prev).filter((k) => !deleted.has(k))));
    const opened = selectedKeyRef.current;
    await reloadAll(opened !== null && deleted.has(opened) ? null : opened);
    setStatusAnnouncement(message);
  };

  const handleSearchChange = (val: string) => {
    setSearchQuery(val);
    void persistSettingPatch({ lastSearchQuery: val });
  };

  /** Explicit submit (Enter): rerank the top first-stage results. Never runs per keystroke. */
  const handleSearchSubmit = async () => {
    const q = searchQuery.trim();
    if (!settings || !settings.rerankInSearch || !rerankReady(settings) || q.length < 2) return;
    const key = searchKey;
    const pool = firstStageResults.hits.slice(0, Math.max(2, Math.min(100, settings.rerankCandidates || 40)));
    if (pool.length < 2) return;
    rerankAbortRef.current?.abort();
    const controller = new AbortController();
    rerankAbortRef.current = controller;
    try {
      const keys = pool.map((h) => h.conversation.threadKey);
      const allowed = await remoteRerankAllowedKeys(sharedDb, settings, keys);
      const outcome = await rerankThreads(
        settings,
        q,
        pool.map((h) => {
          const insight = insightsByThread.get(h.conversation.threadKey) ?? null;
          return {
            key: h.conversation.threadKey,
            document: buildRerankDocument({
              title: getSmartTitle(h.conversation, insight),
              gist: insight?.gist,
              excerpt: bestMatchingExcerpt(messagesByThread.get(h.conversation.threadKey) ?? [], q) || h.supportingExcerpt,
            }),
          };
        }),
        allowed,
        fetch,
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      const note =
        outcome.scores.size === 0
          ? 'Not reranked: the top results are local-only.'
          : `Reranked with ${outcome.label}${outcome.withheld ? ` (${outcome.withheld} local-only kept in place)` : ''}`;
      setRerankRun({ key, order: outcome.order, scores: outcome.scores, note });
    } catch (err) {
      if (controller.signal.aborted) return;
      // Non-blocking: keep the first-stage order and say why.
      const reason = err instanceof Error ? err.message : String(err);
      setRerankRun({ key, order: [], scores: new Map(), note: `Showing first-stage order; reranking failed: ${reason}` });
    }
  };

  const handleAreaSelect = (area: string) => {
    setActiveArea(area);
    setActiveQueue('all');
    setMobileDrawerOpen(false);
    void persistSettingPatch({ lastActiveArea: area, lastActiveQueue: 'all' });
  };

  const handleQueueSelect = (queue: ResurfaceQueue) => {
    setActiveQueue(queue);
    setActiveArea('All threads');
    setMobileDrawerOpen(false);
    void persistSettingPatch({ lastActiveQueue: queue, lastActiveArea: 'All threads' });
  };

  const handleSaveManualEdits = async () => {
    if (!authorized() || !selectedConversation) return;
    const parsedTags = normalizeTags(tagInputDraft.split(',').map((s) => s.trim()).filter(Boolean));
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, {
      manualTitleOverride:
        titleDraft.trim() && titleDraft.trim() !== selectedConversation.title ? titleDraft.trim() : null,
      manualNotes: notesDraft,
      manualTags: parsedTags,
    });
    await reloadAll(selectedConversation.threadKey);
    setStatusAnnouncement('Saved manual title, tags, and notes.');
  };

  const handleProjectChange = async (nextProject: string) => {
    if (!authorized() || !selectedConversation) return;
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, { project: nextProject, categoryLocked: true });
    await reloadAll(selectedConversation.threadKey);
    setStatusAnnouncement(`Filed under ${nextProject} (locked).`);
  };

  const handleToggleLock = async (locked: boolean) => {
    if (!authorized() || !selectedConversation) return;
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, { categoryLocked: locked });
    await reloadAll(selectedConversation.threadKey);
  };

  const handleWorkflowStateChange = async (nextState: WorkflowState) => {
    if (!authorized() || !selectedConversation) return;
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, { workflowState: nextState });
    await reloadAll(selectedConversation.threadKey);
    setStatusAnnouncement(`Updated status to ${nextState}.`);
  };

  const handleDeleteSelected = async () => {
    if (!authorized() || !selectedConversation) return;
    const deletedTitle = getDisplayTitle(selectedConversation);
    await deleteConversationCascade(sharedDb, selectedConversation.threadKey);
    await reloadAll(null);
    setStatusAnnouncement(`Deleted "${deletedTitle}" and recorded tombstone.`);
  };

  const handleCreateProject = async (name: string) => {
    const clean = name.trim();
    if (!clean || !authorized()) return;
    if (!(await sharedDb.collections.get(clean))) {
      await sharedDb.collections.put({
        name: clean,
        description: '',
        isStarterArea: false,
        cloudExcluded: false,
        createdAt: new Date().toISOString(),
        keywords: [clean.toLowerCase()],
        origin: 'user',
      });
    }
    setNewProjectDraft(null);
    await reloadAll(selectedKeyRef.current);
    setStatusAnnouncement(`Created project ${clean}. Threads that mention it are filed there automatically.`);
  };

  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    setStatusAnnouncement(`${label} copied to clipboard.`);
  };

  const lastInnerModalCloseAtRef = useRef<number>(0);

  const handleCloseOverlay = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: 'CLOSE_THREADKEEPER_OVERLAY', handshakeToken });
      } catch {
        // ignore if extension context invalidated
      }
    }
  };

  useEffect(() => {
    const getOpenInnerModal = () =>
      [organizeDialogRef.current, importDialogRef.current, settingsDialogRef.current, bulkDeleteDialogRef.current].find(
        (d) => d && (d.open || d.hasAttribute('open'))
      );

    const handleEscapeStep = () => {
      const openModalEl = getOpenInnerModal();
      if (openModalEl) {
        lastInnerModalCloseAtRef.current = Date.now();
        openModalEl.close();
        return;
      }
      if (Date.now() - lastInnerModalCloseAtRef.current < 150) return;
      if (checkedKeys.size > 0) {
        // The bulk bar's controls disappear with the selection; keep focus in the list toolbar.
        if (document.activeElement?.closest('.tk-bulk-bar')) selectAllRef.current?.focus();
        setCheckedKeys(new Set());
        setStatusAnnouncement('Selection cleared.');
        return;
      }
      if (surface === 'overlay') handleCloseOverlay();
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const openModalEl = getOpenInnerModal();
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleEscapeStep();
        return;
      }
      if (openModalEl) return;
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditing = tag === 'input' || tag === 'textarea' || tag === 'select' || Boolean(target?.isContentEditable);
      if (!isEditing && e.key === '/') {
        e.preventDefault();
        setListMode('search');
        searchInputRef.current?.focus();
        return;
      }
      if (!isEditing && (e.key === 'j' || e.key === 'k')) {
        if (listHits.length === 0) return;
        e.preventDefault();
        const curIdx = listHits.findIndex((h) => h.conversation.threadKey === selectedConversation?.threadKey);
        const nextIdx =
          e.key === 'j'
            ? Math.min(listHits.length - 1, Math.max(0, curIdx + 1))
            : Math.max(0, curIdx <= 0 ? 0 : curIdx - 1);
        const nextKey = listHits[nextIdx]?.conversation.threadKey;
        if (nextKey) {
          handleSelectThread(nextKey);
          rowRefs.current.get(nextKey)?.focus();
        }
      }
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data as { source?: string; handshakeToken?: string; action?: string } | null;
      if (
        data &&
        data.source === 'threadkeeper-host-overlay' &&
        data.handshakeToken === handshakeToken &&
        data.action === 'REQUEST_ESCAPE'
      ) {
        handleEscapeStep();
      }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('message', onMessage);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('message', onMessage);
    };
  }, [surface, handshakeToken, listHits, selectedConversation?.threadKey, checkedKeys.size]);

  const handleOpenFullPage = () => {
    const params = new URLSearchParams({ surface: 'page' });
    if (selectedConversation) params.set('threadKey', selectedConversation.threadKey);
    if (searchQuery) params.set('q', searchQuery);
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      chrome.runtime.sendMessage({
        type: 'OPEN_FULL_PAGE_MANAGER',
        threadKey: selectedConversation?.threadKey ?? null,
        query: searchQuery,
        handshakeToken,
      });
    } else {
      window.open(`manager.html?${params.toString()}`, '_blank');
    }
  };

  // ---- Claude analysis runner (in-page, with progress and cancel) ----
  const startAnalysis = async (options: { enqueueAll?: boolean } = {}) => {
    if (!authorized() || analysis.running) return;
    if (!settings || (!aiReady && settings.embeddingProvider === 'local')) {
      openModal(settingsDialogRef);
      return;
    }
    if (options.enqueueAll) await enqueueLibraryAnalysis(sharedDb, { onlyMissing: true });
    const controller = new AbortController();
    analysisAbortRef.current = controller;
    setAnalysis({ running: true, processed: 0, analyzed: 0, current: null, note: null });
    let lastReload = Date.now();
    const summary = await runAnalysisJobs(sharedDb, {
      maxJobs: 2000,
      signal: controller.signal,
      onProgress: (s, current) => {
        setAnalysis({ running: true, processed: s.processed, analyzed: s.analyzed, current, note: null });
        if (Date.now() - lastReload > 4000) {
          lastReload = Date.now();
          void reloadAll(selectedKeyRef.current);
        }
      },
    });
    analysisAbortRef.current = null;
    setAnalysis({
      running: false,
      processed: summary.processed,
      analyzed: summary.analyzed,
      current: null,
      note: summary.stoppedReason,
    });
    setStatusAnnouncement(
      `Claude analyzed ${summary.analyzed} thread(s)${summary.stoppedReason ? ` — ${summary.stoppedReason}` : ''}.`
    );
    await reloadAll(selectedKeyRef.current);
  };

  const handleAnalyzeSelected = async () => {
    if (!selectedConversation || !authorized()) return;
    setAnalyzingThread(selectedConversation.threadKey);
    try {
      const res = await analyzeThreadRemotely(sharedDb, selectedConversation.threadKey, { ignoreDailyLimit: true });
      setStatusAnnouncement(res.status === 'skipped' ? `Skipped: ${res.reason}` : 'Thread analyzed by Claude.');
    } catch (err) {
      setStatusAnnouncement(`Analysis failed: ${err instanceof Error ? err.message : String(err)}`);
      if (settings) await persistSettingPatch({ lastAiError: err instanceof Error ? err.message : String(err), lastAiErrorAt: new Date().toISOString() });
    } finally {
      setAnalyzingThread(null);
      await reloadAll(selectedConversation.threadKey);
    }
  };

  // ---- Organize (natural language + automatic) ----
  const localPreview = (instruction: string) => {
    const extraText = new Map<string, string>();
    for (const [k, i] of insightsByThread) extraText.set(k, `${i.gist} ${i.summary} ${i.topics.join(' ')}`);
    return previewNaturalLanguageOrganize(instruction, conversations, { collections, extraText });
  };

  const openOrganizeModal = () => {
    setOrganizeProposals(organizeInstruction.trim() ? localPreview(organizeInstruction) : []);
    setOrganizeNotes([]);
    setOrganizeDeselected(new Set());
    openModal(organizeDialogRef);
  };

  const planOrganize = async (preferAi: boolean) => {
    setOrganizeBusy(preferAi ? 'Claude is planning…' : 'Planning…');
    try {
      const plan = await planLibraryOrganization(sharedDb, { instruction: organizeInstruction, preferAi });
      setOrganizeProposals(plan.proposals);
      setOrganizeNotes(plan.notes);
      setOrganizeDeselected(new Set());
    } catch (err) {
      setOrganizeNotes([`Planning failed: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setOrganizeBusy(null);
    }
  };

  const handleAutoOrganize = async () => {
    if (!authorized()) return;
    setOrganizeInstruction('');
    setOrganizeProposals([]);
    setOrganizeNotes([]);
    setOrganizeDeselected(new Set());
    openModal(organizeDialogRef);
    setOrganizeBusy('Analyzing every thread on-device…');
    const keys = conversations.filter((c) => !c.isSyntheticBenchmark).map((c) => c.threadKey);
    const local = await processThreadsLocally(sharedDb, keys, {
      aiDelaySeconds: 0,
      onProgress: (done, total) => setOrganizeBusy(`Analyzing ${done}/${total} threads on-device…`),
    });
    await reloadAll(selectedKeyRef.current);
    setOrganizeBusy(aiReady ? 'Claude is planning projects for your library…' : 'Grouping similar threads…');
    try {
      const plan = await planLibraryOrganization(sharedDb, { preferAi: aiReady });
      setOrganizeProposals(plan.proposals);
      setOrganizeNotes([
        `Filed ${local.filed} thread(s) automatically while analyzing${local.createdProjects.length ? `; created ${local.createdProjects.join(', ')}` : ''}.`,
        ...plan.notes,
      ]);
    } catch (err) {
      setOrganizeNotes([`Planning failed: ${err instanceof Error ? err.message : String(err)}`]);
    } finally {
      setOrganizeBusy(null);
    }
    if (aiReady && settings?.autoOrganize.aiAnalysis) void startAnalysis({ enqueueAll: true });
  };

  const handleApplyOrganize = async () => {
    if (!authorized()) return;
    const chosen = organizeProposals.filter((p) => p.excludedByInstruction || !organizeDeselected.has(p.threadKey));
    const entry = await applyOrganizeProposals(
      sharedDb,
      organizeInstruction.trim() || 'Auto-organize library',
      chosen
    );
    organizeDialogRef.current?.close();
    await reloadAll(selectedKeyRef.current);
    setStatusAnnouncement(`Applied organization to ${entry.snapshots.length} conversations.`);
  };

  const handleUndoLastOrganize = async () => {
    if (!authorized()) return;
    const latestActive = changeLogs.find((c) => !c.undone);
    if (!latestActive) return;
    const res = await undoChangeLog(sharedDb, latestActive.changeId);
    await reloadAll(selectedKeyRef.current);
    setStatusAnnouncement(`Undid changes across ${res.restoredCount} threads.`);
  };

  const handleRebuildVectors = () => {
    void (async () => {
      setBusy('Rebuilding vectors…');
      const keys = conversations.filter((c) => !c.isSyntheticBenchmark).map((c) => c.threadKey);
      await processThreadsLocally(sharedDb, keys, { force: true, aiDelaySeconds: 0 });
      const queued = await enqueueLibraryAnalysis(sharedDb, { onlyMissing: false });
      setBusy(null);
      await reloadAll(selectedKeyRef.current);
      setStatusAnnouncement(`Rebuilt on-device vectors; ${queued} thread(s) queued for hosted embeddings / analysis.`);
      if (queued > 0) void startAnalysis();
    })();
  };

  const renderEvidencePassage = (evidenceId: string, messageIndexes: number[]) => {
    if (activeEvidenceId !== evidenceId || !selectedConversation) return null;
    const cited = messageIndexes
      .map((ord) => selectedMessages.find((m) => m.ordinal === ord))
      .filter((m): m is MessageRecord => Boolean(m));
    return (
      <div className="tk-evidence-passage-box" role="region" aria-label="Source passage">
        <div className="tk-tabular" style={{ fontWeight: 600, marginBottom: 4 }}>
          Captured evidence · sourceRevision r{selectedConversation.sourceRevision} · {selectedConversation.coverage}{' '}
          coverage
        </div>
        {cited.length > 0 ? (
          cited.map((m) => (
            <div key={m.messageKey} style={{ marginTop: 4 }}>
              <strong>
                [m{m.ordinal + 1} · {m.role}]
              </strong>
              : “{m.content.length > 1200 ? `${m.content.slice(0, 1200)}…` : m.content}”
            </div>
          ))
        ) : (
          <div>
            Message m{(messageIndexes[0] ?? 0) + 1} captured in thread revision r{selectedConversation.sourceRevision}.
          </div>
        )}
      </div>
    );
  };

  const renderClaims = (
    items: StructuredSummaryRecord['decisions'],
    prefix: string,
    emptyText: string,
    fallback?: { text: string | null; ordinal: number | null; speaker: 'user_committed' | 'assistant_suggested' | null; id: string }
  ) => {
    if (items.length > 0) {
      return items.map((d, idx) => {
        const evId = `${prefix}-${idx}`;
        return (
          <div key={evId}>
            <div className="tk-claim-row">
              <span className="tk-claim-text">{d.text}</span>
              <button
                type="button"
                className="tk-evidence-marker"
                title={d.speaker === 'user_committed' ? 'You committed to this' : 'Assistant suggested this'}
                aria-expanded={activeEvidenceId === evId}
                onClick={() => setActiveEvidenceId((prev) => (prev === evId ? null : evId))}
              >
                <span className="tk-evidence-pip" data-speaker={d.speaker} aria-hidden="true" />
                <span>{d.messageIndexes.map((i) => `m${i + 1}`).join(',')}</span>
              </button>
            </div>
            {renderEvidencePassage(evId, d.messageIndexes)}
          </div>
        );
      });
    }
    if (fallback?.text) {
      return (
        <div>
          <div className="tk-claim-row">
            <span className="tk-claim-text">{fallback.text}</span>
            <button
              type="button"
              className="tk-evidence-marker"
              aria-expanded={activeEvidenceId === fallback.id}
              onClick={() => setActiveEvidenceId((prev) => (prev === fallback.id ? null : fallback.id))}
            >
              <span className="tk-evidence-pip" data-speaker={fallback.speaker ?? 'user_committed'} aria-hidden="true" />
              <span>m{(fallback.ordinal ?? 0) + 1}</span>
            </button>
          </div>
          {renderEvidencePassage(fallback.id, [fallback.ordinal ?? 0])}
        </div>
      );
    }
    return <div className="tk-empty-line">{emptyText}</div>;
  };

  const latestUndoableLog = changeLogs.find((c) => !c.undone);

  if (surface === 'overlay' && overlayHandshakeState !== 'authorized') {
    if (overlayHandshakeState === 'rejected') {
      return (
        <div className="tk-workbench" data-surface="overlay" data-testid="overlay-handshake-rejected" role="alert" style={{ padding: 24 }}>
          <strong>Unauthorized overlay frame rejected</strong>
          <p style={{ marginTop: 8 }}>{overlayHandshakeError}</p>
        </div>
      );
    }
    return (
      <div className="tk-workbench" data-surface="overlay" data-testid="overlay-handshake-pending" aria-busy="true" style={{ padding: 24 }}>
        Verifying overlay handshake…
      </div>
    );
  }

  const isCompact = surface === 'sidepanel';
  const activeTabConversation = activeTabThreadKey
    ? conversations.find((c) => c.threadKey === activeTabThreadKey) ?? null
    : null;

  const analysisChip = (() => {
    if (busy) return <span className="tk-status-chip" data-tone="busy">{busy}</span>;
    if (analysis.running) {
      return (
        <span className="tk-status-chip" data-tone="busy">
          Claude analyzing… {analysis.analyzed} done{pendingAnalysis ? ` · ${pendingAnalysis} queued` : ''}
          <button type="button" className="tk-linklike" onClick={() => analysisAbortRef.current?.abort()}>
            Stop
          </button>
        </span>
      );
    }
    if (settings?.lastAiError && pendingAnalysis > 0) {
      return (
        <button type="button" className="tk-status-chip" data-tone="warn" onClick={() => openModal(settingsDialogRef)} title={settings.lastAiError}>
          AI paused: {settings.lastAiError.slice(0, 60)}
        </button>
      );
    }
    if (pendingAnalysis > 0 && (aiReady || settings?.embeddingProvider !== 'local')) {
      return (
        <button type="button" className="tk-status-chip" onClick={() => void startAnalysis()}>
          {pendingAnalysis} queued for analysis · Run now
        </button>
      );
    }
    if (settings && !aiReady) {
      return (
        <button type="button" className="tk-status-chip" data-tone="quiet" onClick={() => openModal(settingsDialogRef)}>
          On-device analysis · Add Claude for deeper summaries
        </button>
      );
    }
    return null;
  })();

  const secondaryActions = (
    <>
      <button type="button" className="tk-btn" onClick={openOrganizeModal}>
        Organize…
      </button>
      <button type="button" className="tk-btn" onClick={() => openModal(importDialogRef)}>
        Import / Export
      </button>
      <button type="button" className="tk-btn" onClick={() => openModal(settingsDialogRef)}>
        Settings
      </button>
      <button
        type="button"
        className="tk-btn"
        aria-label="Toggle density"
        onClick={() => void persistSettingPatch({ density: settings?.density === 'compact' ? 'comfortable' : 'compact' })}
      >
        {settings?.density === 'compact' ? 'Compact' : 'Comfortable'}
      </button>
      <button
        type="button"
        className="tk-btn"
        aria-label="Toggle color theme"
        onClick={() => void persistSettingPatch({ theme: effectiveTheme === 'dark' ? 'light' : 'dark' })}
      >
        {effectiveTheme === 'dark' ? 'Dark' : 'Light'}
      </button>
    </>
  );

  const renderRow = (hit: SearchHit) => {
    const c = hit.conversation;
    const isSelected = selectedConversation?.threadKey === c.threadKey;
    const queueInfo = queueItemsMap?.get(c.threadKey);
    const insight = insightsByThread.get(c.threadKey) ?? null;
    const isChecked = checkedKeys.has(c.threadKey);
    const secondLine = queueInfo
      ? queueInfo.resurfaceReason
      : searchQuery.trim()
        ? hit.supportingExcerpt
        : summariesByThread.get(c.threadKey)?.whereYouLeftOff ?? hit.supportingExcerpt;
    return (
      <li key={c.threadKey} className="tk-row-item" data-checked={isChecked}>
        <RowCheck
          threadKey={c.threadKey}
          title={getSmartTitle(c, insight)}
          checked={isChecked}
          onToggle={handleToggleChecked}
        />
        <button
          ref={(el) => {
            if (el) rowRefs.current.set(c.threadKey, el);
          }}
          type="button"
          className="tk-row-btn"
          aria-selected={isSelected}
          onClick={() => handleSelectThread(c.threadKey)}
        >
          <div className="tk-row-main">
            <div className="tk-row-title">{getSmartTitle(c, insight)}</div>
            {insight?.gist && insight.gist !== getSmartTitle(c, insight) && <div className="tk-row-gist">{insight.gist}</div>}
            {secondLine && secondLine !== insight?.gist && <div className="tk-row-excerpt">{secondLine}</div>}
            <div className="tk-row-meta">
              {insight && <KindLabel kind={insight.kind} />}
              {insight?.topics.slice(0, 3).map((t) => (
                <span key={t} className="tk-chip tk-chip-small">
                  {t}
                </span>
              ))}
              <span>
                {c.project}
                {c.categoryLocked ? ' (locked)' : ''}
              </span>
              <span>·</span>
              <span>{providerLabel(c.provider)}</span>
              {c.messageCount > 0 && (
                <>
                  <span>·</span>
                  <span className="tk-tabular">{c.messageCount} msgs</span>
                </>
              )}
              {c.branchId !== 'main' && (
                <>
                  <span>·</span>
                  <span>branch: {c.branchId}</span>
                </>
              )}
              {searchQuery.trim() && hit.matchReasons[0] && (
                <>
                  <span>·</span>
                  <span>{hit.matchReasons[0]}</span>
                </>
              )}
            </div>
          </div>
          <div className="tk-row-right">
            <span className="tk-tabular" title={c.updatedAt ?? undefined}>
              {relativeTime(c.updatedAt ?? c.lastCapturedAt)}
            </span>
            <CoverageTick coverage={c.coverage} />
            <StatusPill state={c.workflowState} />
            {insight?.source === 'ai' && (
              <span className="tk-ai-mark" title={`Analyzed by ${insight.model}`}>
                AI
              </span>
            )}
          </div>
        </button>
      </li>
    );
  };

  return (
    <div className="tk-workbench" data-surface={surface}>
      {surface === 'page' && (
        <a href="#tk-main-list" className="tk-skip-link">
          Skip to conversation list
        </a>
      )}

      <div role="status" aria-live="polite" className="tk-visually-hidden">
        {statusAnnouncement}
      </div>

      <header className="tk-header">
        <div className="tk-header-left">
          <button
            type="button"
            className="tk-btn"
            aria-label="Toggle navigation rail"
            onClick={() => {
              if (window.innerWidth <= 760) setMobileDrawerOpen((v) => !v);
              else void persistSettingPatch({ sidebarCollapsed: !settings?.sidebarCollapsed });
            }}
          >
            ☰
          </button>
          <h1 className="tk-h1">Threadkeeper</h1>
          {counts && (
            <details className="tk-counts-details">
              <summary className="tk-counts-summary">
                {counts.totalThreads} threads · {counts.filedCount} filed · {counts.unfiledCount} unfiled
              </summary>
              <div className="tk-counts-popover">
                <strong>How these are counted</strong>
                <p style={{ margin: '6px 0 0' }}>
                  Total ({counts.totalThreads}) equals filed ({counts.filedCount}) + unfiled ({counts.unfiledCount}).{' '}
                  {counts.partialOrTitleOnlyCount} threads have partial or title-only DOM coverage;{' '}
                  {counts.coverageCounts.full} have full export coverage.
                  {counts.syntheticBenchmarkCount > 0
                    ? ` (${counts.syntheticBenchmarkCount} synthetic benchmark records isolated from user totals.)`
                    : ''}
                </p>
              </div>
            </details>
          )}
          {!isCompact && analysisChip}
        </div>

        <div className="tk-header-actions">
          {latestUndoableLog && (
            <button type="button" className="tk-btn" onClick={() => void handleUndoLastOrganize()}>
              Undo organize ({latestUndoableLog.snapshots.length})
            </button>
          )}
          <button type="button" className="tk-btn tk-btn-primary" onClick={() => void handleAutoOrganize()}>
            Auto-organize
          </button>
          {isCompact ? (
            <details className="tk-more-menu">
              <summary className="tk-btn" aria-label="More actions">
                ⋯
              </summary>
              <div className="tk-more-popover">
                {secondaryActions}
                <button type="button" className="tk-btn" onClick={handleOpenFullPage}>
                  Open full page ↗
                </button>
              </div>
            </details>
          ) : (
            secondaryActions
          )}
          {surface === 'overlay' && (
            <>
              <button type="button" className="tk-btn" onClick={handleOpenFullPage}>
                Open full page ↗
              </button>
              <button type="button" className="tk-btn tk-btn-primary" aria-label="Close Threadkeeper overlay" onClick={handleCloseOverlay}>
                Close
              </button>
            </>
          )}
        </div>
        {isCompact && analysisChip && <div className="tk-header-status">{analysisChip}</div>}
      </header>

      <StaleBuildBanner snapshot={diagnostics.snapshot} />

      <div className="tk-columns" data-nav-collapsed={Boolean(settings?.sidebarCollapsed)}>
        <nav className="tk-nav" aria-label="Projects and resurfacing queues" data-drawer-open={mobileDrawerOpen}>
          {!settings?.sidebarCollapsed ? (
            <>
              <div>
                <div className="tk-eyebrow">Projects</div>
                <div className="tk-nav-list">
                  <button
                    type="button"
                    className="tk-nav-item"
                    aria-current={activeQueue === 'all' && activeArea === 'All threads'}
                    onClick={() => handleAreaSelect('All threads')}
                  >
                    <span>All threads</span>
                    <span className="tk-nav-count">{counts?.totalThreads ?? 0}</span>
                  </button>
                  {projectNames.map((area) => {
                    const col = collectionByName.get(area);
                    return (
                      <button
                        key={area}
                        type="button"
                        className="tk-nav-item"
                        aria-current={activeQueue === 'all' && activeArea === area}
                        onClick={() => handleAreaSelect(area)}
                        title={col?.description || area}
                      >
                        <span className="tk-ellipsis">
                          {area}
                          {col && (col.origin === 'auto' || col.origin === 'provider') ? <span className="tk-auto-mark"> auto</span> : null}
                        </span>
                        <span className="tk-nav-count">{counts?.projectCounts[area] ?? 0}</span>
                      </button>
                    );
                  })}
                  {newProjectDraft === null ? (
                    <button type="button" className="tk-nav-item tk-nav-add" onClick={() => setNewProjectDraft('')}>
                      + New project
                    </button>
                  ) : (
                    <form
                      className="tk-nav-new"
                      onSubmit={(e) => {
                        e.preventDefault();
                        void handleCreateProject(newProjectDraft);
                      }}
                    >
                      <input
                        autoFocus
                        className="tk-input"
                        aria-label="New project name"
                        placeholder="Project name"
                        value={newProjectDraft}
                        onChange={(e) => setNewProjectDraft(e.target.value)}
                        onBlur={() => !newProjectDraft.trim() && setNewProjectDraft(null)}
                      />
                    </form>
                  )}
                </div>
              </div>

              <div>
                <div className="tk-eyebrow">Resurfacing</div>
                <div className="tk-nav-list">
                  {(Object.keys(RESURFACE_QUEUE_LABELS) as ResurfaceQueue[]).map((q) => {
                    const qCount = computeResurfacingQueueItems(conversations, summariesByThread, q).length;
                    return (
                      <button
                        key={q}
                        type="button"
                        className="tk-nav-item"
                        aria-current={activeQueue === q}
                        onClick={() => handleQueueSelect(q)}
                      >
                        <span>{RESURFACE_QUEUE_LABELS[q]}</span>
                        <span className="tk-nav-count">{qCount}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          ) : (
            <div className="tk-nav-list">
              <button
                type="button"
                className="tk-nav-item"
                title="All threads"
                aria-current={activeArea === 'All threads'}
                onClick={() => handleAreaSelect('All threads')}
              >
                All
              </button>
            </div>
          )}
        </nav>

        <main id="tk-main-list" className="tk-list-pane" aria-label="Conversation index">
          <div className="tk-search-bar">
            <div className="tk-search-row">
              <div className="tk-segmented" role="tablist" aria-label="Search or ask">
                <button type="button" role="tab" aria-selected={listMode === 'search'} onClick={() => setListMode('search')}>
                  Search
                </button>
                <button type="button" role="tab" aria-selected={listMode === 'ask'} onClick={() => setListMode('ask')}>
                  Ask
                </button>
              </div>
              {listMode === 'search' && (
                <input
                  ref={searchInputRef}
                  type="search"
                  className="tk-input tk-search-input"
                  aria-label="Search conversations, decisions, and messages"
                  placeholder="Search titles, summaries, topics, decisions, messages…"
                  value={searchQuery}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) void handleSearchSubmit();
                  }}
                />
              )}
            </div>
            {listMode === 'search' && rerankNote && (
              <div className="tk-muted" role="status" style={{ fontSize: 12 }}>
                {rerankNote}
              </div>
            )}

            {listMode === 'search' && (
              <div className="tk-filter-row">
                <select
                  className="tk-select"
                  aria-label="Filter by provider"
                  value={providerFilter}
                  onChange={(e) => setProviderFilter(e.target.value as ProviderId | 'all')}
                >
                  <option value="all">All providers</option>
                  {providerOptions.map((id) => (
                    <option key={id} value={id}>
                      {providerLabel(id)}
                    </option>
                  ))}
                </select>
                <select
                  className="tk-select"
                  aria-label="Filter by kind of work"
                  value={kindFilter}
                  onChange={(e) => setKindFilter(e.target.value as ThreadKind | 'all')}
                >
                  <option value="all">All kinds</option>
                  {THREAD_KINDS.map((k) => (
                    <option key={k} value={k}>
                      {THREAD_KIND_LABELS[k]}
                    </option>
                  ))}
                </select>
                <select
                  className="tk-select"
                  aria-label="Filter by workflow state"
                  value={stateFilter}
                  onChange={(e) => setStateFilter(e.target.value as WorkflowState | 'all')}
                >
                  <option value="all">All states</option>
                  <option value="active">Active</option>
                  <option value="needs_review">Needs review</option>
                  <option value="waiting">Waiting</option>
                  <option value="paused">Paused</option>
                  <option value="done">Done</option>
                  <option value="archived">Archived</option>
                </select>
                {!isCompact && (
                  <select
                    className="tk-select"
                    aria-label="Filter by capture coverage"
                    value={coverageFilter}
                    onChange={(e) => setCoverageFilter(e.target.value as CoverageState | 'all')}
                  >
                    <option value="all">All coverage</option>
                    <option value="full">Full export</option>
                    <option value="partial">Partial DOM</option>
                    <option value="title_only">Title only</option>
                  </select>
                )}
                <select
                  className="tk-select"
                  aria-label="View mode"
                  value={settings?.viewMode ?? 'list'}
                  onChange={(e) => void persistSettingPatch({ viewMode: e.target.value as 'list' | 'kanban' | 'cards' })}
                >
                  <option value="list">List index</option>
                  <option value="kanban">Kanban by status</option>
                  <option value="cards">Project cards</option>
                </select>
                <select
                  className="tk-select"
                  aria-label="Sort threads"
                  value={sortMode}
                  onChange={(e) => setSortMode(e.target.value as ThreadSortMode)}
                >
                  {(Object.keys(THREAD_SORT_LABELS) as ThreadSortMode[]).map((mode) => (
                    <option key={mode} value={mode}>
                      {THREAD_SORT_LABELS[mode]}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {listMode === 'ask' ? (
            <AskPanel
              settings={settings}
              conversations={conversations}
              insights={insightsByThread}
              messagesByThread={messagesByThread}
              vectors={vectorsByThread}
              searchIndex={searchIndex}
              onSelectThread={handleSelectThread}
              onOpenSettings={() => openModal(settingsDialogRef)}
            />
          ) : (
            <>
              <BulkActions
                selectedKeys={checkedKeys}
                viewKeys={viewKeys}
                projectNames={projectNames}
                selectAllRef={selectAllRef}
                deleteDialogRef={bulkDeleteDialogRef}
                canEdit={authorized}
                onSelectionChange={setCheckedKeys}
                onChanged={handleBulkChanged}
                onAnnounce={setStatusAnnouncement}
                onDialogClosed={() => {
                  lastInnerModalCloseAtRef.current = Date.now();
                }}
              />
              {activeTabConversation && !searchQuery.trim() && (
                <div className="tk-this-tab">
                  <div className="tk-eyebrow" style={{ padding: 0 }}>
                    Open in this tab
                  </div>
                  <ul className="tk-row-list" style={{ flex: 'none' }}>
                    {renderRow({
                      conversation: activeTabConversation,
                      score: 1,
                      lexicalScore: 0,
                      vectorScore: 0,
                      rerankScore: null,
                      matchReasons: [],
                      supportingExcerpt: '',
                      matchedMessageOrdinal: null,
                    })}
                  </ul>
                </div>
              )}
              {settings?.viewMode === 'kanban' ? (
                <div className="tk-kanban-grid">
                  {kanbanColumns.map(({ state: st, hits: colHits }) => {
                    return (
                      <div key={st} className="tk-kanban-col">
                        <div className="tk-eyebrow">
                          {st.replace('_', ' ')} ({colHits.length})
                        </div>
                        {colHits.map((hit) => {
                          const insight = insightsByThread.get(hit.conversation.threadKey) ?? null;
                          const isChecked = checkedKeys.has(hit.conversation.threadKey);
                          return (
                            <div key={hit.conversation.threadKey} className="tk-card-item" data-checked={isChecked}>
                              <RowCheck
                                threadKey={hit.conversation.threadKey}
                                title={getSmartTitle(hit.conversation, insight)}
                                checked={isChecked}
                                onToggle={handleToggleChecked}
                              />
                              <button
                                type="button"
                                className="tk-row-btn tk-card-btn"
                                aria-selected={selectedConversation?.threadKey === hit.conversation.threadKey}
                                onClick={() => handleSelectThread(hit.conversation.threadKey)}
                              >
                                <div className="tk-row-main">
                                  <div className="tk-row-title">{getSmartTitle(hit.conversation, insight)}</div>
                                  {insight?.gist && <div className="tk-row-gist">{insight.gist}</div>}
                                  <div className="tk-row-meta">
                                    <span>{hit.conversation.project}</span>
                                    <span>·</span>
                                    <span>{providerLabel(hit.conversation.provider)}</span>
                                  </div>
                                </div>
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </div>
              ) : settings?.viewMode === 'cards' ? (
                <div className="tk-cards-grid">
                  {cardGroups.map(([proj, projHits]) => {
                    const activeCount = projHits.filter((h) => h.conversation.workflowState === 'active').length;
                    const reviewCount = projHits.filter((h) => h.conversation.workflowState === 'needs_review').length;
                    const topicCounts = new Map<string, number>();
                    for (const h of projHits) {
                      for (const t of insightsByThread.get(h.conversation.threadKey)?.topics.slice(0, 4) ?? []) {
                        topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
                      }
                    }
                    const topTopics = Array.from(topicCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([t]) => t);
                    return (
                      <div key={proj} className="tk-project-card">
                        <div className="tk-project-card-header">
                          <span className="tk-row-title">{proj}</span>
                          <span className="tk-eyebrow tk-tabular">{projHits.length} threads</span>
                        </div>
                        {collectionByName.get(proj)?.description && (
                          <div className="tk-row-gist">{collectionByName.get(proj)!.description}</div>
                        )}
                        <div className="tk-row-meta">
                          <span>{activeCount} active</span>
                          <span>·</span>
                          <span>{reviewCount} needs review</span>
                        </div>
                        {topTopics.length > 0 && (
                          <div className="tk-chip-row">
                            {topTopics.map((t) => (
                              <span key={t} className="tk-chip tk-chip-small">
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="tk-project-card-items">
                          {projHits.slice(0, CARD_ITEMS).map((hit) => {
                            const title = getSmartTitle(hit.conversation, insightsByThread.get(hit.conversation.threadKey) ?? null);
                            const isChecked = checkedKeys.has(hit.conversation.threadKey);
                            return (
                              <div key={hit.conversation.threadKey} className="tk-card-item" data-checked={isChecked}>
                                <RowCheck
                                  threadKey={hit.conversation.threadKey}
                                  title={title}
                                  checked={isChecked}
                                  onToggle={handleToggleChecked}
                                />
                                <button
                                  type="button"
                                  className="tk-row-btn tk-card-btn"
                                  aria-selected={selectedConversation?.threadKey === hit.conversation.threadKey}
                                  onClick={() => handleSelectThread(hit.conversation.threadKey)}
                                >
                                  <div className="tk-row-main">
                                    <div className="tk-row-title">{title}</div>
                                    <div className="tk-row-meta">
                                      <span>{providerLabel(hit.conversation.provider)}</span>
                                      <span>·</span>
                                      <span>{relativeTime(hit.conversation.updatedAt)}</span>
                                    </div>
                                  </div>
                                </button>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : listHits.length === 0 ? (
                <div className="tk-empty-state">
                  {conversations.length === 0 ? (
                    <>
                      <p>
                        <strong>No threads yet.</strong> Open any conversation on ChatGPT, Claude, Grok, Gemini, Perplexity,
                        DeepSeek, Le Chat or Copilot and it appears here automatically, already summarized and filed.
                      </p>
                      <p>
                        Or bring your history in at once:{' '}
                        <button type="button" className="tk-linklike" onClick={() => openModal(importDialogRef)}>
                          import a ChatGPT / Claude export or your Claude Code and Codex sessions
                        </button>
                        .
                      </p>
                    </>
                  ) : (
                    <p>No conversations match the current filter — clear the search or pick another project.</p>
                  )}
                </div>
              ) : (
                <ul className="tk-row-list">{listHits.map(renderRow)}</ul>
              )}
            </>
          )}
        </main>

        <section
          className="tk-detail-pane"
          aria-label="Conversation context and evidence"
          data-mobile-hidden={!mobileDetailVisible}
        >
          {selectedConversation ? (
            <>
              <div className="tk-detail-header">
                <div className="tk-mobile-back-wrap">
                  <button
                    type="button"
                    className="tk-btn"
                    onClick={() => {
                      setMobileDetailVisible(false);
                      rowRefs.current.get(selectedConversation.threadKey)?.focus();
                    }}
                  >
                    ← Back to list
                  </button>
                </div>

                <h2 className="tk-detail-title">{getSmartTitle(selectedConversation, selectedInsight)}</h2>
                {selectedInsight && getSmartTitle(selectedConversation, selectedInsight) !== getDisplayTitle(selectedConversation) && (
                  <div className="tk-muted" style={{ fontSize: 12 }}>
                    Original title: {getDisplayTitle(selectedConversation)}
                  </div>
                )}

                <div className="tk-detail-meta-strip">
                  <StatusPill state={selectedConversation.workflowState} />
                  <span>·</span>
                  <CoverageTick coverage={selectedConversation.coverage} />
                  <span className="tk-tabular">
                    rev r{selectedConversation.sourceRevision} ({selectedConversation.messageCount} msgs)
                  </span>
                  <span>·</span>
                  <span>
                    {providerLabel(selectedConversation.provider)}
                    {selectedConversation.providerProjectName ? ` / ${selectedConversation.providerProjectName}` : ''}
                  </span>
                  <span>·</span>
                  <span title={`${selectedConversation.accountId} / ${selectedConversation.workspaceId}`}>
                    updated {relativeTime(selectedConversation.updatedAt ?? selectedConversation.lastCapturedAt)}
                  </span>
                </div>

                {selectedConversation.siblingBranchIds.length > 0 && (
                  <div className="tk-filter-row" style={{ marginTop: 4 }}>
                    <span className="tk-eyebrow" style={{ padding: 0 }}>
                      Branch ({selectedConversation.branchId}):
                    </span>
                    {selectedConversation.siblingBranchIds.map((sibId) => {
                      const sibConv = conversations.find(
                        (c) =>
                          c.sourceConversationId === selectedConversation.sourceConversationId &&
                          c.accountId === selectedConversation.accountId &&
                          c.branchId === sibId
                      );
                      if (!sibConv) return null;
                      return (
                        <button key={sibId} type="button" className="tk-btn" onClick={() => handleSelectThread(sibConv.threadKey)}>
                          Switch to {sibId}
                        </button>
                      );
                    })}
                  </div>
                )}

                <div className="tk-filter-row" style={{ marginTop: 6 }}>
                  <select
                    className="tk-select"
                    aria-label="Assign project or area"
                    value={selectedConversation.project}
                    onChange={(e) => void handleProjectChange(e.target.value)}
                  >
                    {projectNames.map((area) => (
                      <option key={area} value={area}>
                        {area}
                      </option>
                    ))}
                  </select>
                  <label className="tk-inline-check">
                    <input
                      type="checkbox"
                      checked={selectedConversation.categoryLocked}
                      onChange={(e) => void handleToggleLock(e.target.checked)}
                    />
                    Lock category
                  </label>
                  <select
                    className="tk-select"
                    aria-label="Change workflow state"
                    value={selectedConversation.workflowState}
                    onChange={(e) => void handleWorkflowStateChange(e.target.value as WorkflowState)}
                  >
                    <option value="active">Active</option>
                    <option value="needs_review">Needs review</option>
                    <option value="waiting">Waiting</option>
                    <option value="paused">Paused</option>
                    <option value="done">Done</option>
                    <option value="archived">Archived</option>
                  </select>
                  {/^https:\/\//.test(selectedConversation.canonicalUrl) ? (
                    <button
                      type="button"
                      className="tk-btn"
                      onClick={() => {
                        if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
                          chrome.runtime.sendMessage({
                            type: 'OPEN_ORIGINAL_THREAD',
                            canonicalUrl: selectedConversation.canonicalUrl,
                            provider: selectedConversation.provider,
                            expectedAccountId: selectedConversation.accountId,
                            expectedWorkspaceId: selectedConversation.workspaceId,
                            handshakeToken,
                          });
                        } else {
                          window.open(selectedConversation.canonicalUrl, '_blank');
                        }
                      }}
                    >
                      Open original ↗
                    </button>
                  ) : selectedConversation.resumeCommand ? (
                    <button
                      type="button"
                      className="tk-btn"
                      onClick={() => copyText(selectedConversation.resumeCommand!, 'Resume command')}
                    >
                      Copy resume command
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="tk-btn"
                    onClick={() =>
                      copyText(exportThreadToMarkdown(selectedConversation, selectedMessages, selectedSummary), 'Markdown handoff')
                    }
                  >
                    Copy handoff
                  </button>
                  <button type="button" className="tk-btn tk-btn-danger" onClick={() => void handleDeleteSelected()}>
                    Delete
                  </button>
                </div>
              </div>

              <ThreadOverview
                conv={selectedConversation}
                insight={selectedInsight}
                canAnalyze={aiReady}
                analyzing={analyzingThread === selectedConversation.threadKey}
                onAnalyze={() => void handleAnalyzeSelected()}
                onCopy={copyText}
              />

              {/* FOCAL ELEMENT: Where you left off (Evidence Location #1) */}
              <div className="tk-focal-left-off" data-evidence-location="where-you-left-off">
                <div className="tk-eyebrow" style={{ padding: 0 }}>
                  Where you left off
                </div>
                <div className="tk-claim-row" style={{ borderBottom: 0, padding: 0 }}>
                  <p className="tk-focal-serif-line">
                    {selectedSummary?.whereYouLeftOff ??
                      selectedConversation.nextStepText ??
                      selectedConversation.latestDecisionText ??
                      selectedMessages[selectedMessages.length - 1]?.content.slice(0, 400) ??
                      'Title-only capture — open the original conversation or import an export file to read message turns.'}
                  </p>
                  {selectedMessages.length > 0 && (
                    <button
                      type="button"
                      className="tk-evidence-marker"
                      aria-expanded={activeEvidenceId === 'focal-left-off'}
                      onClick={() => setActiveEvidenceId((prev) => (prev === 'focal-left-off' ? null : 'focal-left-off'))}
                    >
                      <span className="tk-evidence-pip" data-speaker="user_committed" aria-hidden="true" />
                      <span>
                        {(selectedSummary?.whereYouLeftOffMessageIndexes ?? [Math.max(0, selectedMessages.length - 1)])
                          .map((i) => `m${i + 1}`)
                          .join(',')}
                      </span>
                    </button>
                  )}
                </div>
                {renderEvidencePassage(
                  'focal-left-off',
                  selectedSummary?.whereYouLeftOffMessageIndexes ?? [Math.max(0, selectedMessages.length - 1)]
                )}
              </div>

              <div className="tk-section" data-evidence-location="decisions">
                <h3 className="tk-section-h2">Decisions</h3>
                {renderClaims(
                  selectedSummary?.decisions ?? [],
                  'decision',
                  'No explicit decisions in this thread yet.',
                  {
                    text: selectedConversation.latestDecisionText,
                    ordinal: selectedConversation.latestDecisionMsgIndex,
                    speaker: selectedConversation.latestDecisionSpeaker,
                    id: 'cached-decision',
                  }
                )}
              </div>

              <div className="tk-section" data-evidence-location="action-items">
                <h3 className="tk-section-h2">Action items & next steps</h3>
                {renderClaims(
                  selectedSummary?.actionItems ?? [],
                  'action',
                  'No pending action items recorded for this conversation.',
                  {
                    text: selectedConversation.nextStepText,
                    ordinal: selectedConversation.nextStepMsgIndex,
                    speaker: selectedConversation.nextStepSpeaker,
                    id: 'cached-next-step',
                  }
                )}
              </div>

              <div className="tk-section" data-evidence-location="open-questions">
                <h3 className="tk-section-h2">Open questions</h3>
                {renderClaims(selectedSummary?.openQuestions ?? [], 'question', 'No unresolved questions flagged in this thread.')}
              </div>

              <div className="tk-section" data-evidence-location="related-threads">
                <h3 className="tk-section-h2">Related threads & branches</h3>
                {selectedRelationships.map((rel) => {
                  const otherKey = rel.fromThreadKey === selectedConversation.threadKey ? rel.toThreadKey : rel.fromThreadKey;
                  const otherConv = conversations.find((c) => c.threadKey === otherKey);
                  const evId = `rel-${rel.relationshipKey}`;
                  const localOrdinal =
                    rel.fromThreadKey === selectedConversation.threadKey ? rel.evidenceFromOrdinal : rel.evidenceToOrdinal;
                  return (
                    <div key={rel.relationshipKey}>
                      <div className="tk-claim-row">
                        <div>
                          <button type="button" className="tk-btn" style={{ marginRight: 8 }} onClick={() => handleSelectThread(otherKey)}>
                            {rel.relationType.replace('_', ' ')}: {otherConv ? getDisplayTitle(otherConv) : otherKey}
                          </button>
                          <span className="tk-claim-text">{rel.reason}</span>
                        </div>
                        <button
                          type="button"
                          className="tk-evidence-marker"
                          aria-expanded={activeEvidenceId === evId}
                          onClick={() => setActiveEvidenceId((prev) => (prev === evId ? null : evId))}
                        >
                          <span className="tk-evidence-pip" data-speaker="user_committed" aria-hidden="true" />
                          <span>m{localOrdinal + 1}</span>
                        </button>
                      </div>
                      {renderEvidencePassage(evId, [localOrdinal])}
                    </div>
                  );
                })}
                <SemanticNeighbors related={semanticNeighbors} insights={insightsByThread} onSelect={handleSelectThread} />
                {selectedRelationships.length === 0 && semanticNeighbors.length === 0 && (
                  <div className="tk-empty-line">No related threads found yet.</div>
                )}
              </div>

              <div className="tk-section">
                <h3 className="tk-section-h2">Manual index overrides & notes</h3>
                <div className="tk-notes-box">
                  <label className="tk-field">
                    Title override
                    <input
                      type="text"
                      className="tk-input"
                      aria-label="Manual title override"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                    />
                  </label>
                  <label className="tk-field">
                    Tags (comma-separated; synonyms normalized)
                    <input
                      type="text"
                      className="tk-input"
                      aria-label="Manual tags"
                      value={tagInputDraft}
                      onChange={(e) => setTagInputDraft(e.target.value)}
                    />
                  </label>
                  <label className="tk-field">
                    Workbench notes (preserved across re-imports)
                    <textarea
                      className="tk-input"
                      style={{ minHeight: 68 }}
                      aria-label="Manual workbench notes"
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                    />
                  </label>
                  <div className="tk-notes-actions">
                    <label className="tk-inline-check">
                      <input
                        type="checkbox"
                        checked={selectedConversation.cloudExcluded}
                        onChange={(e) => {
                          void updateManualThreadFields(sharedDb, selectedConversation.threadKey, {
                            cloudExcluded: e.target.checked,
                          }).then(() => reloadAll(selectedConversation.threadKey));
                        }}
                      />
                      Local-only thread (never sent to Claude, embedding APIs or the Worker)
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      {settings?.cloudEnabled && (
                        <button
                          type="button"
                          className="tk-btn"
                          onClick={() => {
                            void requestThreadEnrichment(sharedDb, selectedConversation.threadKey).then((res) => {
                              setStatusAnnouncement(
                                res.status === 'rejected' ? `Cloud enrichment skipped: ${res.reason}` : `Cloud enrichment ${res.status}.`
                              );
                              void reloadAll(selectedConversation.threadKey);
                            });
                          }}
                        >
                          Enrich via Worker
                        </button>
                      )}
                      <button type="button" className="tk-btn tk-btn-primary" onClick={() => void handleSaveManualEdits()}>
                        Save notes & overrides
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              <div className="tk-section">
                <h3 className="tk-section-h2">Captured transcript ({selectedMessages.length} messages)</h3>
                {selectedMessages.length === 0 ? (
                  <div className="tk-empty-line">
                    No message bodies captured ({selectedConversation.coverage} state). Open the original conversation or
                    import an export file to populate message turns.
                  </div>
                ) : (
                  <div className="tk-transcript">
                    {!showAllMessages && selectedMessages.length > TRANSCRIPT_PAGE && (
                      <button type="button" className="tk-btn" onClick={() => setShowAllMessages(true)}>
                        Show all {selectedMessages.length} messages ({selectedMessages.length - TRANSCRIPT_PAGE} earlier hidden)
                      </button>
                    )}
                    {(showAllMessages ? selectedMessages : selectedMessages.slice(-TRANSCRIPT_PAGE)).map((m) => (
                      <article key={m.messageKey} className="tk-message" data-role={m.role}>
                        <div className="tk-message-meta tk-tabular">
                          m{m.ordinal + 1} · {m.role} ·{' '}
                          {m.createdAt ? m.createdAt.slice(0, 19).replace('T', ' ') : 'timestamp unknown'}
                        </div>
                        <div className="tk-message-body">{m.content}</div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="tk-empty-line">Select a conversation to see what it is about and where you left off.</div>
          )}
        </section>
      </div>

      {/* Inner dialog #1: organize (natural language, Claude-planned, or automatic) */}
      <dialog
        ref={organizeDialogRef}
        id="tk-organize-dialog"
        className="tk-modal-dialog tk-modal-wide"
        aria-label="Organize conversations"
        onClose={() => {
          lastInnerModalCloseAtRef.current = Date.now();
        }}
      >
        <h2 className="tk-section-h2" style={{ marginBottom: 8 }}>
          Organize conversations
        </h2>
        <p className="tk-settings-note" style={{ marginTop: 0 }}>
          Describe what you want, or run Auto-organize. Nothing changes until you apply, and every apply can be undone.
        </p>
        <div className="tk-field-row" style={{ marginBottom: 12 }}>
          <input
            type="text"
            className="tk-input tk-grow"
            aria-label="Natural language organization instruction"
            placeholder="e.g. Put my Daydock logo threads in Daydock / Meridian, but keep the homepage research separate"
            value={organizeInstruction}
            onChange={(e) => {
              setOrganizeInstruction(e.target.value);
              setOrganizeProposals(e.target.value.trim() ? localPreview(e.target.value) : []);
              setOrganizeNotes([]);
            }}
          />
          <button
            type="button"
            className="tk-btn"
            disabled={Boolean(organizeBusy)}
            onClick={() => {
              setOrganizeProposals(organizeInstruction.trim() ? localPreview(organizeInstruction) : []);
              setOrganizeNotes(['Keyword preview.']);
            }}
          >
            Preview
          </button>
          {aiReady && (
            <button type="button" className="tk-btn tk-btn-primary" disabled={Boolean(organizeBusy)} onClick={() => void planOrganize(true)}>
              Plan with Claude
            </button>
          )}
        </div>
        {(organizeBusy || organizeNotes.length > 0) && (
          <div className="tk-settings-result" role="status">
            {organizeBusy ?? organizeNotes.join(' ')}
          </div>
        )}

        <div className="tk-proposal-list">
          {organizeProposals.length === 0 ? (
            <div className="tk-empty-line">
              {organizeBusy ? 'Working…' : 'No changes proposed yet.'}
            </div>
          ) : (
            organizeProposals.map((p) => (
              <label key={p.threadKey} className="tk-proposal" data-excluded={p.excludedByInstruction}>
                {!p.excludedByInstruction && (
                  <input
                    type="checkbox"
                    checked={!organizeDeselected.has(p.threadKey)}
                    onChange={(e) =>
                      setOrganizeDeselected((prev) => {
                        const next = new Set(prev);
                        if (e.target.checked) next.delete(p.threadKey);
                        else next.add(p.threadKey);
                        return next;
                      })
                    }
                  />
                )}
                <span>
                  <span className="tk-proposal-title">{p.title}</span>
                  <span className="tk-proposal-detail">
                    {p.excludedByInstruction ? (
                      <>Excluded — {p.reason}</>
                    ) : (
                      <>
                        {p.currentProject} → <strong>{p.proposedProject ?? `${p.currentProject} (unchanged)`}</strong>
                        {p.newProject ? <span className="tk-auto-mark"> new project</span> : null}
                        {p.proposedState ? ` · status: ${p.proposedState}` : ''}
                        {p.proposedTags.length ? ` · tags: ${p.proposedTags.join(', ')}` : ''} ({p.reason})
                      </>
                    )}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="tk-btn" onClick={() => organizeDialogRef.current?.close()}>
            Cancel
          </button>
          <button
            type="button"
            className="tk-btn tk-btn-primary"
            disabled={Boolean(organizeBusy) || organizeProposals.length === 0}
            onClick={() => void handleApplyOrganize()}
          >
            Apply changes
          </button>
        </div>
      </dialog>

      <ImportDialog
        dialogRef={importDialogRef}
        settings={settings}
        onImported={async (message) => {
          setStatusAnnouncement(message);
          notifyBackground({ type: 'RUN_ANALYSIS_NOW' });
          await reloadAll(selectedKeyRef.current);
        }}
        onClosed={() => {
          lastInnerModalCloseAtRef.current = Date.now();
        }}
      />

      <SettingsDialog
        dialogRef={settingsDialogRef}
        settings={settings}
        threadCount={counts?.totalThreads ?? 0}
        collections={collections}
        projectCounts={counts?.projectCounts ?? {}}
        onCollectionsChanged={() => {
          notifyBackground({ type: 'SETTINGS_CHANGED' });
          void reloadAll(selectedKeyRef.current);
        }}
        onPatch={persistSettingPatch}
        onRebuildVectors={handleRebuildVectors}
        onClosed={() => {
          lastInnerModalCloseAtRef.current = Date.now();
          void reloadAll(selectedKeyRef.current);
        }}
      />
    </div>
  );
}
