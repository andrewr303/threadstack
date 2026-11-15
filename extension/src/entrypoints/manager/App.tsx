import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  DETAIL_MODES,
  getDisplayTitle,
  type ConversationRecord,
  type CoverageState,
  type DetailMode,
  type ProviderId,
  type ResurfaceQueue,
  type SettingsRecord,
  type ThreadKind,
  type WorkflowState,
} from '../../core/schema.js';
import { saveSettingsPatch, updateManualThreadFields } from '../../core/db.js';
import { PROVIDER_IDS, detectProviderFromUrl, extractConversationIdFromUrl } from '../../core/providers.js';
import { LOCAL_SPACE, primarySpace } from '../../core/embeddings.js';
import { providerCategory } from '../../core/providers.js';
import { findRelatedThreads } from '../../core/related.js';
import { hasClaudeKey } from '../../core/ai/claude.js';
import { enqueueLibraryAnalysis, processThreadsLocally } from '../../core/pipeline.js';
import { notifyBackground, openModal, sharedDb } from './shared.js';
import { SettingsDialog } from './SettingsDialog.js';
import { ImportDialog, describeReport, syncSavedFolders } from './ImportDialog.js';
import type { RelatedThread } from './ThreadOverview.js';
import { StaleBuildBanner, useDiagnostics } from './Diagnostics.js';
import { RestoreOfferBanner } from './accounts/RestoreOfferBanner.js';
import { SendToStillDialog, type SendRequest } from './SidebarDock.js';
import { configureDockClient, dockSyncNow, useDockState } from './dock.js';
import { isRemoteAllowed, localOnlyProjectNames } from '../../core/privacy.js';
import type { SectionId } from './SettingsDialog.js';
import { selectRange, type ThreadSortMode } from './BulkActions.js';
import { SESSION_KINDS, sanitizeSort, type SessionKind, type ShowInThreadsRequest } from './workspace/lens.js';
import { useAnalysisRunner } from './hooks/useAnalysisRunner.js';
import { useLibraryData } from './hooks/useLibraryData.js';
import { useOrganize } from './hooks/useOrganize.js';
import { useThreadActions } from './hooks/useThreadActions.js';
import { useThreadSearch } from './hooks/useThreadSearch.js';
import { useWorkbenchKeyboard } from './hooks/useWorkbenchKeyboard.js';
import { HeaderBar } from './shell/HeaderBar.js';
import { DetailPane } from './threads/DetailPane.js';
import { ListPane } from './threads/ListPane.js';
import { NavRail } from './threads/NavRail.js';
import { OrganizeDialog } from './threads/OrganizeDialog.js';
import type { EvidenceView } from './threads/claims.js';
import type { RunFilter } from './threads/filters.js';
import { WORKSPACE_VIEWS, type WorkspaceView } from '../../core/workspace/types.js';
import { AddAccountDialog } from './accounts/AddAccountDialog.js';
import { PendingSignInBanner } from './accounts/PendingSignInBanner.js';
import { BrowseView } from './browse/BrowseView.js';
import { DashboardView } from './dashboard/DashboardView.js';
import { Rail } from './shell/Rail.js';
import { FrameStage } from './workspace/FrameStage.js';
import { WorkspaceProvider, type ThreadAccount, type WorkspaceContextValue } from './workspace/context.js';
import { accountForThread, embedTargetFor, needsSignIn, threadTabId } from './workspace/state.js';
import { useWorkspace } from './workspace/useWorkspace.js';
import { PaperclipView, type PaperclipFrameControl, type PaperclipNavigation } from './PaperclipView.js';
import { INITIAL_FUSION, fusedRoute, fusionReducer, usePaperclipFusionDom, type FusionAction } from './PaperclipFusion.js';
import { PaperclipConnectionContext, usePaperclipConnection } from './PaperclipConnection.js';
import { normalizeServerUrl } from '../../core/paperclip/client.js';
import { SLOT_ACTIVATION_WINDOW_MS, paperclipPageAddress, paperclipPath, paperclipPathForUrl, type PaperclipHostMessage } from '../../core/paperclip/host.js';
import { usePaperclipManagerActions } from './paperclip-actions.js';

type Surface = 'overlay' | 'page' | 'sidepanel';

/** sessionStorage: this browser tab has already landed on the start page once. */
const LANDED_KEY = 'threadkeeper.landed';

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
  // The overlay proves its handshake on DOCK_SEND, like the other privileged overlay messages.
  useMemo(() => configureDockClient({ handshakeToken: surface === 'overlay' ? handshakeToken : '' }), [surface, handshakeToken]);
  const dock = useDockState(overlayHandshakeState === 'authorized');
  const stillPaired = Boolean(dock.state?.paired);

  const diagnostics = useDiagnostics();

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
  const [newProjectDraft, setNewProjectDraft] = useState<string | null>(null);
  const [showAllMessages, setShowAllMessages] = useState(false);
  const [activeTabThreadKey, setActiveTabThreadKey] = useState<string | null>(null);
  // Checked rows for bulk actions; separate from the opened thread (selectedThreadKey).
  const [checkedKeys, setCheckedKeys] = useState<Set<string>>(new Set());
  // Workspace filters of the Threads list (full page).
  const [repositoryFilter, setRepositoryFilter] = useState<string | null>(null);
  const [accountFilter, setAccountFilter] = useState<string | null>(null);
  const [runFilter, setRunFilter] = useState<RunFilter>('all');
  const [typeFilter, setTypeFilter] = useState<SessionKind | 'all'>('all');

  const [titleDraft, setTitleDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [tagInputDraft, setTagInputDraft] = useState('');

  const organizeDialogRef = useRef<HTMLDialogElement | null>(null);
  const importDialogRef = useRef<HTMLDialogElement | null>(null);
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null);
  const bulkDeleteDialogRef = useRef<HTMLDialogElement | null>(null);
  const sendStillDialogRef = useRef<HTMLDialogElement | null>(null);
  const addAccountDialogRef = useRef<HTMLDialogElement | null>(null);
  const [addAccountRealm, setAddAccountRealm] = useState<string | null>(null);
  const [sendStillRequest, setSendStillRequest] = useState<SendRequest | null>(null);
  const [settingsSection, setSettingsSection] = useState<SectionId | null>(null);
  const [paperclipNavigation, setPaperclipNavigation] = useState<PaperclipNavigation>({ path: paperclipPath(urlParams.get('pc')) ?? '/', request: 0 });
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const checkAnchorRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const selectedKeyRef = useRef<string | null>(null);
  const backfillStartedRef = useRef(false);
  const reloadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const authorized = () => !(surface === 'overlay' && !handshakeAuthorizedRef.current);

  const {
    settings,
    setSettings,
    conversations,
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
  } = useLibraryData({
    surface,
    urlParams,
    handshakeAuthorizedRef,
    onLoaded: ({ settings: loadedSettings, conversations: convs, firstLoad, preserveSelectionKey }) => {
      if (firstLoad) {
        const urlQuery = urlParams.get('q');
        setSearchQuery(urlQuery !== null ? urlQuery : loadedSettings.lastSearchQuery);
        setActiveArea(loadedSettings.lastActiveArea || 'All threads');
        setActiveQueue(loadedSettings.lastActiveQueue || 'all');
        // A link can name the view to open on (manager.html?view=browse).
        const urlView = urlParams.get('view') as WorkspaceView | null;
        if (urlView && WORKSPACE_VIEWS.includes(urlView) && urlView !== loadedSettings.activeView) {
          void persistSettingPatch({ activeView: urlView });
        }
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
  });

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
    // "solid" turns every translucent surface opaque (Settings; also follows the system's
    // reduced-transparency and more-contrast preferences in CSS).
    document.documentElement.setAttribute('data-surfaces', settings.surfaces);
  }, [effectiveTheme, settings?.density, settings?.surfaces]);

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
      'voyageEndpoint',
      'openaiApiKey',
      'ollamaUrl',
      'ollamaEmbeddingModel',
      'bedrockEmbeddingModel',
      'bedrockEmbeddingDimensions',
      'mongodbApiKey',
      'mongodbGeography',
      'mongodbEmbeddingModel',
      'mongodbEmbeddingDimensions',
      'cohereApiKey',
      'cohereEmbeddingModel',
      'cohereEmbeddingDimensions',
      'authorizedHosts',
      'cloudExcludedProviders',
      'sidebarDock',
      'paperclip',
      'paperclipCredentials',
    ].some((k) => k in patch);
    if (affectsBackground) notifyBackground({ type: 'SETTINGS_CHANGED' });
  }, [surface]);

  // ---- Workspace (the full page only): views, embedded session tabs, accounts ----
  const isPage = surface === 'page';
  const view: WorkspaceView = isPage ? settings?.activeView ?? 'threads' : 'threads';
  const paperclipOrigin = normalizeServerUrl(settings?.paperclip.serverUrl ?? '') ?? 'http://127.0.0.1:3100';
  // REQ-6 fused mode: Paperclip's frame lays out the window and the views sit over its content
  // rectangle. The state lives in a ref too, so back-to-back messages see each other's effect.
  const fusionRef = useRef(INITIAL_FUSION);
  const [fusion, setFusion] = useState(INITIAL_FUSION);
  const fuse = useCallback((action: FusionAction) => {
    fusionRef.current = fusionReducer(fusionRef.current, action);
    setFusion(fusionRef.current);
    return fusionRef.current;
  }, []);
  const paperclipConnection = usePaperclipConnection(settings?.paperclip, isPage && settings !== null, view === 'paperclip' || fusion.engaged);
  const paperclipRunning = paperclipConnection.snapshot.state === 'running';
  const fused = isPage && fusion.engaged && paperclipRunning;
  const paperclipControl = useRef<PaperclipFrameControl | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const paperclipRouteRef = useRef(paperclipPath(urlParams.get('pc')) ?? '/');
  /** The view Paperclip's page last asked for, or the one the shell already sent it to. */
  const fusedViewRef = useRef<WorkspaceView | null>(null);
  // Eager loading starts on Paperclip's home route. Keep the shell's requested entry until
  // its matching slot arrives; old home-page slots may still be queued during navigation.
  const fusedEntryRef = useRef<Exclude<WorkspaceView, 'paperclip'> | null>(null);
  const fusedOverlayClosedAt = useRef(Number.NEGATIVE_INFINITY);
  // Without the server the shell shows its own rail and view switch (FR-6); a new `ready` resumes.
  useEffect(() => {
    if (!paperclipRunning) {
      fusedOverlayClosedAt.current = Number.NEGATIVE_INFINITY;
      fuse({ type: 'offline' });
    }
  }, [paperclipRunning, fuse]);
  usePaperclipFusionDom({
    fused,
    state: fusion,
    shellRef,
    control: paperclipControl,
    onStaleOverlay: () => {
      paperclipControl.current?.post({ type: 'overlay-query' });
      fuse({ type: 'queried', at: Date.now() });
    },
  });
  useEffect(() => {
    // Hosting Paperclip (its view or the fused window) keeps its host grant when sync is off.
    if (isPage && (view === 'paperclip' || fused) && settings && !settings.paperclip.hostEnabled) {
      void persistSettingPatch({ paperclip: { ...settings.paperclip, hostEnabled: true } });
    }
  }, [isPage, view, fused, settings?.paperclip.hostEnabled, persistSettingPatch]);
  const originalPaperclipOrigin = useRef<string | null>(null);
  if (settings && !originalPaperclipOrigin.current) originalPaperclipOrigin.current = paperclipOrigin;
  const lastPaperclipOrigin = useRef<string | null>(null);
  useEffect(() => {
    if (!settings) return;
    if (lastPaperclipOrigin.current === null) {
      // Hydrating the configured server is the initial baseline, not a founder change.
      lastPaperclipOrigin.current = paperclipOrigin;
      return;
    }
    if (lastPaperclipOrigin.current === paperclipOrigin) return;
    lastPaperclipOrigin.current = paperclipOrigin;
    fuse({ type: 'offline' });
    fusedEntryRef.current = null;
    paperclipRouteRef.current = '/';
    setPaperclipNavigation((previous) => ({ path: '/', request: previous.request + 1 }));
    if (view === 'paperclip') window.history.replaceState(null, '', paperclipPageAddress(window.location.href, '/'));
    else {
      const address = new URL(window.location.href);
      address.searchParams.delete('pc');
      window.history.replaceState(null, '', address.href);
    }
  }, [paperclipOrigin, Boolean(settings)]);
  const detailMode: DetailMode = isPage ? settings?.detailMode ?? 'summary' : 'summary';
  // Set after the selection is known (the selection depends on the search below).
  const [liveThreadKey, setLiveThreadKey] = useState<string | null>(null);
  const workspace = useWorkspace({ db: sharedDb, enabled: isPage, view, settings, conversations, liveThreadKey });

  const accountOfThread = useCallback(
    (conv: Pick<ConversationRecord, 'provider' | 'accountId'>): ThreadAccount => {
      const owner = accountForThread(conv, workspace.realms, settings?.boundAccounts[conv.provider]?.accountId);
      if (!owner) return { realm: null, account: null, active: true, switchable: false };
      const entry = workspace.realms.find((r) => r.realm.id === owner.realm.id);
      // Until the accounts are known, and for sign-ins Threadkeeper keeps no accounts for, the
      // browser's own login is the only one there is. Otherwise an account is signed in when it
      // is the browser's own, or an added one with a saved sign-in.
      const active =
        !entry || !owner.realm.switchable || !entry.activeAccountId || entry.activeAccountId === owner.accountId || !needsSignIn(owner.account);
      return { realm: owner.realm, account: owner.account, active, switchable: owner.realm.switchable };
    },
    [workspace.realms, settings?.boundAccounts]
  );

  const accountIdOf = useCallback((conv: ConversationRecord) => accountOfThread(conv).account?.id ?? null, [accountOfThread]);
  const accountOrder = useMemo(() => workspace.realms.flatMap((r) => r.accounts.map((a) => a.id)), [workspace.realms]);

  // The Threads order is remembered across reloads (the filters are not).
  const sortMode: ThreadSortMode = sanitizeSort(settings?.threadsSort);
  const setSortMode = useCallback((mode: ThreadSortMode) => void persistSettingPatch({ threadsSort: mode }), [persistSettingPatch]);

  const {
    rerankNote,
    queueItemsMap,
    displayedHits,
    listHits,
    kanbanColumns,
    cardGroups,
    viewKeys,
    submitSearch: handleSearchSubmit,
  } = useThreadSearch({
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
    repositoryFilter,
    accountFilter,
    runFilter,
    typeFilter,
    accountIdOf,
    accountOrder,
  });

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

  // Related threads: the same session under another account, the same pull request, branch or
  // repository first, then threads that are similar in meaning (core/related.ts).
  const semanticNeighbors: RelatedThread[] = useMemo(() => {
    if (!selectedConversation || !settings) return [];
    const space = primarySpace(settings);
    const own = vectorsByThread.get(selectedConversation.threadKey);
    const spaceId = own?.has(space.id) ? space.id : LOCAL_SPACE;
    const byKey = new Map(conversations.map((c) => [c.threadKey, c]));
    return findRelatedThreads({
      selected: selectedConversation,
      conversations,
      vectorOf: (threadKey) => vectorsByThread.get(threadKey)?.get(spaceId),
      threshold: spaceId === space.id ? space.relatedThreshold : 0.3,
      limit: 8,
      isCodingProvider: (provider) => providerCategory(provider) === 'coding_agent',
    }).flatMap((r) => {
      const conv = byKey.get(r.threadKey);
      return conv ? [{ conv, similarity: r.similarity ?? 0, reason: r.reason }] : [];
    });
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
        dockSyncNow(missing);
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

  const actions = useThreadActions({
    authorized,
    selectedConversation,
    titleDraft,
    notesDraft,
    tagInputDraft,
    handshakeToken,
    selectedKeyRef,
    reloadAll,
    onAnnounce: setStatusAnnouncement,
    onProjectCreated: () => setNewProjectDraft(null),
  });

  // ---- Still (Sidebar Dock) ----
  const localOnlyProjects = useMemo(() => new Set(collections.filter((c) => c.cloudExcluded).map((c) => c.name)), [collections]);
  const mayShare = (conv: ConversationRecord) => (settings ? isRemoteAllowed(conv, settings, localOnlyProjects) : false);

  const openSettingsAt = (section: SectionId) => {
    setSettingsSection(section);
    openModal(settingsDialogRef);
  };

  /** Every "Send to Still…" except the bulk bar: a picker dialog for these threads. */
  const openSendToStill = (threadKeys: string[], label: string) => {
    if (!authorized()) return;
    if (!stillPaired) {
      openSettingsAt('sidebarDock');
      return;
    }
    const keys = Array.from(new Set(threadKeys)).slice(0, 500);
    if (keys.length === 0) return;
    setSendStillRequest({ threadKeys: keys, label });
    openModal(sendStillDialogRef);
  };

  const copyText = (text: string, label: string) => {
    void navigator.clipboard?.writeText(text);
    setStatusAnnouncement(`${label} copied to clipboard.`);
  };

  const lastInnerModalCloseAtRef = useRef<number>(0);

  // The thread whose real page the detail pane shows (Live or Split), when it has one.
  const liveConversation =
    isPage && view === 'threads' && detailMode !== 'summary' && selectedConversation && embedTargetFor(selectedConversation.canonicalUrl)
      ? selectedConversation
      : null;
  const openThreadTab = workspace.openThread;
  useEffect(() => {
    // Showing a thread live needs its session tab; opening it here never changes the Browse tab.
    if (liveConversation) openThreadTab(liveConversation, { activate: false });
    setLiveThreadKey(liveConversation?.threadKey ?? null);
  }, [liveConversation?.threadKey, openThreadTab]);

  const conversationByKey = useMemo(() => new Map(conversations.map((c) => [c.threadKey, c])), [conversations]);

  // ---- Landing: the start page, once per browser tab ----
  // Opening Threadkeeper lands on the person's start page (Claude Code unless changed in
  // Settings; "where I left off" skips this). A link that names a thread, a view or a search is
  // followed instead, and a reload of the page (which the workspace does to change accounts)
  // stays where it was.
  const landed = useRef(false);
  const openStartPage = workspace.openStartPage;
  useEffect(() => {
    if (!isPage || landed.current || !settings || !workspace.ready || !workspace.embedding) return;
    landed.current = true;
    let seenBefore = false;
    try {
      seenBefore = window.sessionStorage.getItem(LANDED_KEY) === '1';
      window.sessionStorage.setItem(LANDED_KEY, '1');
    } catch {
      // storage blocked: land every time
    }
    const linked = urlParams.has('threadKey') || urlParams.has('view') || urlParams.has('q');
    if (seenBefore || linked || !settings.startPage) return;
    if (openStartPage(settings.startPage).ok) void persistSettingPatch({ activeView: 'browse' });
  }, [isPage, settings, workspace.ready, workspace.embedding, openStartPage, urlParams, persistSettingPatch]);

  const setView = useCallback(
    (next: WorkspaceView) => {
      setMobileDrawerOpen(false);
      void persistSettingPatch({ activeView: next });
      const address = new URL(window.location.href);
      address.searchParams.set('view', next);
      window.history.replaceState(null, '', address.href);
    },
    [persistSettingPatch]
  );
  // Fused: a view the shell chose itself (opening a session, a link, a Paperclip open-view)
  // takes Paperclip to that page, so its content rectangle and the shown view stay one place.
  useEffect(() => {
    if (!fused || view === 'paperclip' || fusedViewRef.current === view) return;
    const path = fusedRoute(view, paperclipRouteRef.current);
    if (!path) return;
    fusedViewRef.current = view;
    setPaperclipNavigation((previous) => ({ path, request: previous.request + 1 }));
  }, [fused, view]);
  // After the view is laid over the rectangle, tell the page; only then does it turn transparent
  // there. Until this acknowledgement it keeps its own background (REQ-6 UI Layout "Loading").
  useEffect(() => {
    if (!fused) return;
    const placedView = fusion.slotView === 'dashboard' ? 'session-board' : fusion.slotView;
    paperclipControl.current?.post({ type: 'placed', view: placedView });
  }, [fused, fusion.slotSeq]); // slotSeq: batched ready+slot or slot null+slot view keep slotView equal
  // "Show all" in the side navigation: Threads, narrowed to the group it was pressed on.
  const showInThreads = useCallback(
    (request: ShowInThreadsRequest) => {
      setTypeFilter('all');
      setProviderFilter('all');
      setAccountFilter(null);
      setRepositoryFilter(null);
      setRunFilter('all');
      const { by, key } = request;
      if (key) {
        if (by === 'kind' && (SESSION_KINDS as readonly string[]).includes(key)) setTypeFilter(key as SessionKind);
        else if (by === 'provider' && (PROVIDER_IDS as readonly string[]).includes(key)) setProviderFilter(key as ProviderId);
        else if (by === 'account') setAccountFilter(key);
        else if (by === 'repository') setRepositoryFilter(key);
      }
      setView('threads');
    },
    [setView]
  );
  const setDetailMode = useCallback(
    (mode: DetailMode) => {
      if (DETAIL_MODES.includes(mode)) void persistSettingPatch({ detailMode: mode });
    },
    [persistSettingPatch]
  );

  const openInChromeTab = useCallback((url: string) => {
    if (!/^https?:\/\//i.test(url)) return;
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) void chrome.tabs.create({ url }).catch(() => undefined);
    else window.open(url, '_blank', 'noopener');
  }, []);

  const openSession = (conv: ConversationRecord, where?: WorkspaceView) => {
    if (isPage && conv.provider === 'paperclip') {
      const path = paperclipPathForUrl(conv.canonicalUrl, paperclipOrigin);
      if (path) {
        setPaperclipNavigation((previous) => ({ path, request: previous.request + 1 }));
        window.history.replaceState(null, '', paperclipPageAddress(window.location.href, path));
        setView('paperclip');
      } else openInChromeTab(conv.canonicalUrl);
      return;
    }
    const target = where ?? view;
    if (where && where !== view) setView(where);
    if (target === 'threads') {
      handleSelectThread(conv.threadKey);
      return;
    }
    const opened = workspace.openThread(conv, { activate: target === 'browse' });
    if (!opened.ok) {
      // No web page to show (a terminal session, an import): its summary is in Threads.
      setStatusAnnouncement(opened.message);
      handleSelectThread(conv.threadKey);
      setView('threads');
      return;
    }
    if (target === 'dashboard') {
      workspace.dispatch({ type: 'dashboard_pane', index: workspace.state.dashboard.focusedPane, threadKey: conv.threadKey });
    }
  };

  const togglePinned = async (conv: ConversationRecord) => {
    if (!authorized()) return;
    await updateManualThreadFields(sharedDb, conv.threadKey, { pinned: !conv.pinned });
    if (conv.pinned) workspace.dispatch({ type: 'dashboard_unpin', threadKey: conv.threadKey });
    dockSyncNow([conv.threadKey]);
    await reloadAll(selectedKeyRef.current);
    setStatusAnnouncement(conv.pinned ? 'Unpinned from the dashboard.' : 'Pinned to the dashboard.');
  };

  usePaperclipManagerActions({
    enabled: isPage,
    workspace: () => workspace,
    settings: () => settings,
    readThread: (threadKey) => sharedDb.conversations.get(threadKey),
    mayShare: async (conv) => {
      const currentSettings = await sharedDb.settings.get('default');
      return currentSettings ? isRemoteAllowed(conv, currentSettings, await localOnlyProjectNames(sharedDb)) : false;
    },
    showBrowse: () => setView('browse'),
    openThread: async (threadKey) => {
      const conv = await sharedDb.conversations.get(threadKey);
      if (!conv || conv.provider === 'paperclip') return false;
      const result = workspace.openThread(conv, { activate: true });
      if (!result.ok) return false;
      setView('browse');
      return true;
    },
  });

  const workspaceContext: WorkspaceContextValue = {
    surface,
    workspace,
    settings,
    patchSettings: persistSettingPatch,
    view,
    setView,
    detailMode,
    setDetailMode,
    conversations,
    conversationByKey,
    insightsByThread,
    summariesByThread,
    selectedThreadKey: selectedConversation?.threadKey ?? null,
    accountOfThread,
    openSession,
    openPaperclip: (path) => {
      const safe = paperclipPath(path);
      if (!safe || !isPage) return;
      setPaperclipNavigation((previous) => ({ path: safe, request: previous.request + 1 }));
      window.history.replaceState(null, '', paperclipPageAddress(window.location.href, safe));
      setView('paperclip');
    },
    showInThreads,
    togglePinned,
    openInChromeTab,
    requestAddAccount: (realmId) => {
      setAddAccountRealm(realmId ?? null);
      openModal(addAccountDialogRef);
    },
    openSettings: (section) => {
      if (section) openSettingsAt(section);
      else openModal(settingsDialogRef);
    },
    announce: setStatusAnnouncement,
  };

  const handleCloseOverlay = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({ type: 'CLOSE_THREADKEEPER_OVERLAY', handshakeToken });
      } catch {
        // ignore if extension context invalidated
      }
    }
  };

  const searchFocusPending = useRef(false);
  const [searchFocusRequest, setSearchFocusRequest] = useState(0);
  const focusThreadSearch = () => {
    setListMode('search');
    if (isPage && view !== 'threads') setView('threads');
    searchFocusPending.current = true;
    setSearchFocusRequest((request) => request + 1);
    if (!isPage) return;
    const narrow = typeof window.matchMedia === 'function'
      ? window.matchMedia('(max-width: 899px)').matches : window.innerWidth < 900;
    if (narrow) setMobileDrawerOpen(true);
    else if (settings?.sidebarCollapsed) void persistSettingPatch({ sidebarCollapsed: false });
  };
  useEffect(() => {
    if (!searchFocusPending.current) return;
    // The search box is now in navigation. Wait for its drawer/expanded rail to be visible
    // before focusing it; the shortcut's immediate focus may still target the hidden box.
    if (isPage && (view !== 'threads' || document.querySelector('.tk-rail')?.getAttribute('data-collapsed') === 'true')) return;
    if (!searchInputRef.current) return;
    searchInputRef.current.focus();
    searchFocusPending.current = false;
  }, [searchFocusRequest, listMode, settings?.sidebarCollapsed, mobileDrawerOpen, isPage, view]);

  useWorkbenchKeyboard({
    surface,
    handshakeToken,
    dialogRefs: [addAccountDialogRef, organizeDialogRef, importDialogRef, settingsDialogRef, bulkDeleteDialogRef, sendStillDialogRef],
    lastInnerModalCloseAtRef,
    listHits,
    selectedThreadKey: selectedConversation?.threadKey,
    checkedCount: checkedKeys.size,
    searchInputRef,
    selectAllRef,
    rowRefs,
    onFocusSearch: focusThreadSearch,
    onSelectThread: handleSelectThread,
    onClearChecked: () => {
      setCheckedKeys(new Set());
      setStatusAnnouncement('Selection cleared.');
    },
    onCloseOverlay: handleCloseOverlay,
    listShortcuts: view === 'threads',
  });

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

  const { analysis, analyzingThread, startAnalysis, analyzeSelected, stopAnalysis } = useAnalysisRunner({
    authorized,
    settings,
    aiReady,
    selectedConversation,
    selectedKeyRef,
    reloadAll,
    persistSettingPatch,
    onAnnounce: setStatusAnnouncement,
    onOpenSettings: () => openModal(settingsDialogRef),
  });

  const organize = useOrganize({
    dialogRef: organizeDialogRef,
    authorized,
    settings,
    conversations,
    collections,
    insightsByThread,
    changeLogs,
    aiReady,
    selectedKeyRef,
    reloadAll,
    startAnalysis,
    onAnnounce: setStatusAnnouncement,
  });

  const handleRebuildVectors = () => {
    void (async () => {
      setBusy('Rebuilding vectors…');
      const keys = conversations.filter((c) => !c.isSyntheticBenchmark).map((c) => c.threadKey);
      await processThreadsLocally(sharedDb, keys, { force: true, aiDelaySeconds: 0 });
      dockSyncNow(keys, { privacy: true });
      const queued = await enqueueLibraryAnalysis(sharedDb, { onlyMissing: false });
      setBusy(null);
      await reloadAll(selectedKeyRef.current);
      setStatusAnnouncement(`Rebuilt on-device vectors; ${queued} thread(s) queued for hosted embeddings / analysis.`);
      if (queued > 0) void startAnalysis();
    })();
  };

  const evidenceView: EvidenceView = {
    activeEvidenceId,
    conversation: selectedConversation,
    messages: selectedMessages,
    onToggle: (evidenceId) => setActiveEvidenceId((prev) => (prev === evidenceId ? null : evidenceId)),
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

  const headerBar = (
    <HeaderBar
      surface={surface}
      isCompact={isCompact}
      settings={settings}
      effectiveTheme={effectiveTheme}
      counts={counts}
      busy={busy}
      analysis={analysis}
      pendingAnalysis={pendingAnalysis}
      aiReady={aiReady}
      undoable={latestUndoableLog}
      onToggleNav={() => {
        if (window.innerWidth <= 760) setMobileDrawerOpen((v) => !v);
        else void persistSettingPatch({ sidebarCollapsed: !settings?.sidebarCollapsed });
      }}
      onUndo={organize.undoLast}
      onAutoOrganize={organize.autoOrganize}
      onOpenOrganize={organize.openOrganize}
      onOpenImport={() => openModal(importDialogRef)}
      onOpenSettings={() => openModal(settingsDialogRef)}
      onPatchSettings={persistSettingPatch}
      onOpenFullPage={handleOpenFullPage}
      onCloseOverlay={handleCloseOverlay}
      onRunAnalysis={() => startAnalysis()}
      onStopAnalysis={stopAnalysis}
    />
  );

  const navRail = (
    <NavRail
      // On the full page the workspace rail holds this navigation and collapses as a whole.
      collapsed={!isPage && Boolean(settings?.sidebarCollapsed)}
      drawerOpen={!isPage && mobileDrawerOpen}
      activeArea={activeArea}
      activeQueue={activeQueue}
      counts={counts}
      projectNames={projectNames}
      collectionByName={collectionByName}
      conversations={conversations}
      summariesByThread={summariesByThread}
      newProjectDraft={newProjectDraft}
      onNewProjectDraftChange={setNewProjectDraft}
      onCreateProject={actions.createProject}
      onAreaSelect={handleAreaSelect}
      onQueueSelect={handleQueueSelect}
      repositoryFilter={repositoryFilter}
      onRepositorySelect={isPage ? setRepositoryFilter : undefined}
    />
  );

  const listPane = (
    <ListPane
      placement={isPage ? 'sidebar' : 'main'}
      repositoryFilter={repositoryFilter}
      accountFilter={accountFilter}
      runFilter={runFilter}
      typeFilter={typeFilter}
      onTypeFilterChange={setTypeFilter}
      onRepositoryFilterChange={setRepositoryFilter}
      onAccountFilterChange={setAccountFilter}
      onRunFilterChange={setRunFilter}
      settings={settings}
      conversations={conversations}
      insightsByThread={insightsByThread}
      summariesByThread={summariesByThread}
      messagesByThread={messagesByThread}
      vectorsByThread={vectorsByThread}
      searchIndex={searchIndex}
      collectionByName={collectionByName}
      projectNames={projectNames}
      providerOptions={providerOptions}
      listHits={listHits}
      kanbanColumns={kanbanColumns}
      cardGroups={cardGroups}
      viewKeys={viewKeys}
      queueItemsMap={queueItemsMap}
      selectedThreadKey={selectedConversation?.threadKey ?? null}
      activeTabConversation={activeTabConversation}
      listMode={listMode}
      searchQuery={searchQuery}
      rerankNote={rerankNote}
      providerFilter={providerFilter}
      kindFilter={kindFilter}
      stateFilter={stateFilter}
      coverageFilter={coverageFilter}
      sortMode={sortMode}
      checkedKeys={checkedKeys}
      isCompact={isCompact}
      stillPaired={stillPaired}
      searchInputRef={searchInputRef}
      selectAllRef={selectAllRef}
      bulkDeleteDialogRef={bulkDeleteDialogRef}
      onListModeChange={setListMode}
      onSearchChange={handleSearchChange}
      onSearchSubmit={handleSearchSubmit}
      onProviderFilterChange={setProviderFilter}
      onKindFilterChange={setKindFilter}
      onStateFilterChange={setStateFilter}
      onCoverageFilterChange={setCoverageFilter}
      onSortModeChange={setSortMode}
      onPatchSettings={persistSettingPatch}
      onSelectThread={handleSelectThread}
      onToggleChecked={handleToggleChecked}
      onSelectionChange={setCheckedKeys}
      onBulkChanged={handleBulkChanged}
      onBulkDialogClosed={() => {
        lastInnerModalCloseAtRef.current = Date.now();
      }}
      onAnnounce={setStatusAnnouncement}
      onSendToStill={openSendToStill}
      onOpenSettings={() => openModal(settingsDialogRef)}
      onOpenImport={() => openModal(importDialogRef)}
      canEdit={authorized}
      registerRow={(threadKey, el) => {
        rowRefs.current.set(threadKey, el);
      }}
    />
  );

  const detailPane = (
    <DetailPane
      conversation={selectedConversation}
      insight={selectedInsight}
      summary={selectedSummary}
      messages={selectedMessages}
      relationships={selectedRelationships}
      semanticNeighbors={semanticNeighbors}
      conversations={conversations}
      insightsByThread={insightsByThread}
      projectNames={projectNames}
      evidence={evidenceView}
      aiReady={aiReady}
      analyzing={selectedConversation !== null && analyzingThread === selectedConversation.threadKey}
      cloudEnabled={Boolean(settings?.cloudEnabled)}
      stillPaired={stillPaired}
      stillLastPushAt={dock.state?.lastPushAt}
      mayShare={mayShare}
      mobileDetailVisible={mobileDetailVisible}
      titleDraft={titleDraft}
      tagInputDraft={tagInputDraft}
      notesDraft={notesDraft}
      showAllMessages={showAllMessages}
      onTitleDraftChange={setTitleDraft}
      onTagInputDraftChange={setTagInputDraft}
      onNotesDraftChange={setNotesDraft}
      onShowAllMessages={() => setShowAllMessages(true)}
      onBackToList={() => {
        setMobileDetailVisible(false);
        if (selectedConversation) rowRefs.current.get(selectedConversation.threadKey)?.focus();
      }}
      onSelectThread={(threadKey) => {
        const target = conversationByKey.get(threadKey);
        if (isPage && target?.provider === 'paperclip') openSession(target, 'paperclip');
        else handleSelectThread(threadKey);
      }}
      onProjectChange={actions.changeProject}
      onToggleLock={actions.toggleLock}
      onWorkflowStateChange={actions.changeWorkflowState}
      onOpenOriginal={() => {
        if (isPage && selectedConversation?.provider === 'paperclip') openSession(selectedConversation, 'paperclip');
        else actions.openOriginal();
      }}
      onCopy={copyText}
      onSendToStill={openSendToStill}
      onDelete={actions.deleteSelected}
      onAnalyze={analyzeSelected}
      onSetCloudExcluded={actions.setCloudExcluded}
      onEnrich={actions.enrich}
      onSaveManualEdits={actions.saveManualEdits}
    />
  );

  const onPaperclipMessage = (message: PaperclipHostMessage) => {
    if (message.type === 'route') {
      paperclipRouteRef.current = message.path;
      const entry = fusedEntryRef.current;
      const path = entry && fusedRoute(entry, message.path);
      if (path && fusedViewRef.current !== entry) {
        fusedViewRef.current = entry;
        setPaperclipNavigation((previous) => ({ path, request: previous.request + 1 }));
      }
      if (fused) {
        // Fused: the shell view follows the page, so only the Paperclip route is remembered.
        const address = new URL(window.location.href);
        address.searchParams.set('pc', message.path);
        window.history.replaceState(null, '', address.href);
      } else if (view === 'paperclip') window.history.replaceState(null, '', paperclipPageAddress(window.location.href, message.path));
    } else if (message.type === 'ready') {
      fusedOverlayClosedAt.current = Number.NEGATIVE_INFINITY;
      fuse({ type: 'ready', mode: message.mode, at: Date.now() });
    }
    else if (message.type === 'slot') {
      const firstSlot = !fusionRef.current.engaged;
      const state = fuse({ type: 'slot', view: message.view, rect: message.rect, at: Date.now() });
      if (state.engaged) {
        if (firstSlot && view !== 'paperclip' && message.view !== view) {
          fusedEntryRef.current = view;
          // The fused-view effect sends navigation once a company prefix is known. If
          // the first route was '/', the route handler sends it when that prefix arrives.
          fusedViewRef.current = null;
        }
        if (fusedEntryRef.current && message.view !== fusedEntryRef.current) return;
        fusedEntryRef.current = null;
        // The route usually arrives before the first slot engages fused mode; remember it now.
        const address = new URL(window.location.href);
        address.searchParams.set('pc', paperclipRouteRef.current);
        window.history.replaceState(null, '', address.href);
        const target: WorkspaceView = message.view ?? 'paperclip';
        fusedViewRef.current = target;
        if (target !== view) setView(target);
      }
    } else if (message.type === 'overlay') {
      const action = { type: 'overlay', open: message.open, regions: message.regions, at: Date.now() } as const;
      if (message.open) fusedOverlayClosedAt.current = Number.NEGATIVE_INFINITY;
      else if (fusionRef.current.overlayOpen) fusedOverlayClosedAt.current = action.at;
      // This message has passed the frame's origin/source checks. Commit an accepted close
      // in this native task, before the next pointer event can hit the raised frame.
      if (!message.open && fusionRef.current.overlayOpen) flushSync(() => { fuse(action); });
      else fuse(action);
    } else if (message.type === 'slot-activate') {
      // Chromium may deliver the first post-Escape click to the old OOPIF hit-test surface.
      // Recover only an existing session-row selection, never a generic toolbar/DOM action.
      const state = fusionRef.current;
      if (!fused || view !== 'threads' || state.slotView !== 'threads' || state.overlayOpen
        || Date.now() - fusedOverlayClosedAt.current > SLOT_ACTIVATION_WINDOW_MS) return;
      const frame = paperclipControl.current?.frame();
      const box = frame?.getBoundingClientRect();
      const slot = state.rect;
      if (!frame || !box || !slot) return;
      const x = box.left + frame.clientLeft + message.x, y = box.top + frame.clientTop + message.y;
      if (x < slot.x || y < slot.y || x >= slot.x + slot.width || y >= slot.y + slot.height) return;
      const row = document.elementFromPoint(x, y)?.closest('button.tk-row-btn');
      if (!(row instanceof HTMLButtonElement) || !row.isConnected || !row.closest('.tk-list-sidebar')) return;
      const key = [...rowRefs.current].find(([, element]) => element === row)?.[0];
      if (!key || !conversationByKey.has(key)) return;
      fusedOverlayClosedAt.current = Number.NEGATIVE_INFINITY;
      handleSelectThread(key);
      row.focus();
    } else if (message.type === 'open-view') setView(message.view);
    else if (message.type === 'open-session') {
      const thread = conversationByKey.get(message.threadKey);
      if (thread) openSession(thread, 'browse');
      else setStatusAnnouncement('That session is no longer in this library.');
    } else if (message.type === 'open-link') {
      if (embedTargetFor(message.url)) {
        const result = workspace.openUrl(message.url, { activate: true });
        if (result.ok) setView('browse');
        else setStatusAnnouncement(result.message);
      } else openInChromeTab(message.url);
    }
  };

  return (
    <PaperclipConnectionContext.Provider value={paperclipConnection}>
    <WorkspaceProvider value={workspaceContext}>
      <div
        className="tk-workbench"
        data-surface={surface}
        data-view={isPage ? view : undefined}
        data-fused={fused ? 'true' : undefined}
        data-fused-raised={fused && fusion.overlayOpen ? 'true' : undefined}
      >
        {surface === 'page' && (
          <a href="#tk-main-list" className="tk-skip-link" onClick={(event) => {
            event.preventDefault();
            focusThreadSearch();
          }}>
            Skip to conversation list
          </a>
        )}

        <div role="status" aria-live="polite" className="tk-visually-hidden">
          {statusAnnouncement}
        </div>

        {isPage ? (
          // The full page is the workspace: a rail and three views over the same sessions. Every
          // view stays mounted so its state survives a switch, and the embedded pages live in
          // the stage, outside the views, so no switch ever reloads one.
          <FrameStage workspace={workspace} fullNavigation={settings?.embedFullNavigation !== false}>
            <div
              ref={shellRef}
              className="tk-shell"
              data-rail-collapsed={(!fused && view === 'paperclip') || Boolean(settings?.sidebarCollapsed)}
              data-view={view}
              // Fused: the shell is the Threadkeeper view, placed over Paperclip's content rectangle.
              style={fused && fusion.rect ? { left: fusion.rect.x, top: fusion.rect.y, width: fusion.rect.width, height: fusion.rect.height } : undefined}
            >
              <Rail
                fused={fused}
                collapsed={(!fused && view === 'paperclip') || Boolean(settings?.sidebarCollapsed)}
                drawerOpen={mobileDrawerOpen}
                view={view}
                effectiveTheme={effectiveTheme}
                onViewChange={setView}
                onToggleCollapsed={() => void persistSettingPatch({ sidebarCollapsed: !settings?.sidebarCollapsed })}
                onCloseDrawer={() => setMobileDrawerOpen(false)}
                onToggleTheme={() => void persistSettingPatch({ theme: effectiveTheme === 'dark' ? 'light' : 'dark' })}
                onOpenSettings={workspaceContext.openSettings}
                sessions={listPane}
              >
                {navRail}
              </Rail>
              <div className="tk-main">
                <StaleBuildBanner snapshot={diagnostics.snapshot} />
                <RestoreOfferBanner threads={counts ? counts.totalThreads : null} />
                <PendingSignInBanner />
                <section className="tk-view tk-view-browse" aria-label="Browse" hidden={view !== 'browse'}>
                  <BrowseView />
                </section>
                <section className="tk-view tk-view-threads" aria-label="Threads" hidden={view !== 'threads'}>
                  {headerBar}
                  <div className="tk-columns" data-detail-mode={detailMode}>
                    {detailPane}
                  </div>
                </section>
                <section className="tk-view tk-view-dashboard" aria-label="Dashboard" hidden={view !== 'dashboard'}>
                  <DashboardView />
                </section>
                <PaperclipView
                  key={paperclipOrigin}
                  origin={paperclipOrigin}
                  initialPath={originalPaperclipOrigin.current === paperclipOrigin ? paperclipPath(urlParams.get('pc')) ?? '/' : '/'}
                  active={view === 'paperclip' || fused}
                  // REQ-6 FR-6: whenever the configured Paperclip runs (which already requires its
                  // host permission), its frame loads so its sidebar becomes the window's sidebar.
                  eager
                  controlRef={paperclipControl}
                  connection={paperclipConnection}
                  navigation={paperclipNavigation}
                  onMessage={onPaperclipMessage}
                  onConfigure={() => {
                    if (paperclipConnection.snapshot.state === 'setup_pending') {
                      openInChromeTab(paperclipOrigin);
                      return;
                    }
                    setSettingsSection('paperclip');
                    openModal(settingsDialogRef);
                  }}
                />
              </div>
            </div>
          </FrameStage>
        ) : (
          <>
            {headerBar}

            <StaleBuildBanner snapshot={diagnostics.snapshot} />

            <div className="tk-columns" data-nav-collapsed={Boolean(settings?.sidebarCollapsed)}>
              {navRail}
              {listPane}
              {detailPane}
            </div>
          </>
        )}

        <OrganizeDialog
          dialogRef={organizeDialogRef}
          instruction={organize.instruction}
          proposals={organize.proposals}
          notes={organize.notes}
          busy={organize.busy}
          deselected={organize.deselected}
          aiReady={aiReady}
          onInstructionChange={organize.changeInstruction}
          onPreview={organize.previewKeywords}
          onPlanWithClaude={() => organize.planOrganize(true)}
          onToggleProposal={organize.toggleProposal}
          onApply={organize.applyProposals}
          onClosed={() => {
            lastInnerModalCloseAtRef.current = Date.now();
          }}
        />

        <ImportDialog
          dialogRef={importDialogRef}
          settings={settings}
          onImported={async (message) => {
            setStatusAnnouncement(message);
            notifyBackground({ type: 'RUN_ANALYSIS_NOW' });
            const before = new Set(conversations.map((c) => c.threadKey));
            const after = (await sharedDb.conversations.toCollection().primaryKeys()) as string[];
            dockSyncNow(after.filter((k) => !before.has(k)));
            await reloadAll(selectedKeyRef.current);
          }}
          onOpenThread={(threadKey) => {
            importDialogRef.current?.close();
            handleSelectThread(threadKey);
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
          dock={dock}
          initialSection={settingsSection}
          onClosed={() => {
            lastInnerModalCloseAtRef.current = Date.now();
            setSettingsSection(null);
            void reloadAll(selectedKeyRef.current);
          }}
        />

        <SendToStillDialog
          dialogRef={sendStillDialogRef}
          request={sendStillRequest}
          onDone={setStatusAnnouncement}
          onClosed={() => {
            lastInnerModalCloseAtRef.current = Date.now();
            setSendStillRequest(null);
            void dock.refresh();
          }}
        />

        {isPage && (
          <AddAccountDialog
            dialogRef={addAccountDialogRef}
            realmId={addAccountRealm}
            onClosed={() => {
              lastInnerModalCloseAtRef.current = Date.now();
              setAddAccountRealm(null);
            }}
          />
        )}
      </div>
    </WorkspaceProvider>
    </PaperclipConnectionContext.Provider>
  );
}
