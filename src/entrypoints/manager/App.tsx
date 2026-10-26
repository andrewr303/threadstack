import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  STARTER_AREAS,
  getDisplayTitle,
  type ConversationRecord,
  type MessageRecord,
  type StructuredSummaryRecord,
  type RelationshipRecord,
  type SettingsRecord,
  type ChangeLogEntry,
  type ResurfaceQueue,
  type WorkflowState,
  type ProviderId,
  type CoverageState,
} from '../../core/schema.js';
import {
  ThreadkeeperDB,
  ensureStarterCollectionsAndSettings,
  updateManualThreadFields,
  deleteConversationCascade,
  reconcileLibraryCounts,
  type LibraryReconciledCounts,
} from '../../core/db.js';
import {
  CAPABILITY_MATRIX,
  parseChatGPTExport,
  parseClaudeExport,
  exportPortableBundle,
  importPortableBundle,
  exportThreadToMarkdown,
  type ChatGPTExportConversation,
  type ClaudeExportConversation,
  type PortableBundle,
} from '../../core/adapters.js';
import { MemorySearchIndex, type SearchHit } from '../../core/search.js';
import {
  computeResurfacingQueueItems,
  previewNaturalLanguageOrganize,
  applyOrganizeProposals,
  undoChangeLog,
  normalizeTags,
  type OrganizeProposalItem,
} from '../../core/organization.js';
import {
  seedSyntheticWorkbenchLibrary,
  generate652ChatGPTExportFixture,
} from '../../core/synthetic-fixtures.js';
import { requestThreadEnrichment } from '../../core/cloud-client.js';

const sharedDb = new ThreadkeeperDB();

const RESURFACE_QUEUE_LABELS: Record<ResurfaceQueue, string> = {
  continue_working: 'Continue working',
  needs_review: 'Needs review',
  waiting: 'Waiting',
  recently_changed: 'Recently changed',
  unfiled: 'Unfiled',
  worth_revisiting: 'Worth revisiting',
};

function CoverageTick({ coverage }: { coverage: CoverageState }) {
  const filledCount =
    coverage === 'full' ? 3 : coverage === 'partial' ? 2 : 1;
  return (
    <span
      className="tk-coverage-tick"
      title={`Capture coverage: ${coverage} (${filledCount}/3)`}
    >
      <span className="tk-coverage-bars" aria-hidden="true">
        <span className="tk-coverage-bar" data-filled={filledCount >= 1} />
        <span className="tk-coverage-bar" data-filled={filledCount >= 2} />
        <span className="tk-coverage-bar" data-filled={filledCount >= 3} />
      </span>
      <span>{coverage}</span>
    </span>
  );
}

function StatusPill({ state }: { state: WorkflowState }) {
  const labels: Record<WorkflowState, string> = {
    active: 'Active',
    needs_review: 'Needs review',
    waiting: 'Waiting',
    paused: 'Paused',
    done: 'Done',
    archived: 'Archived',
  };
  return (
    <span className="tk-status-pill">
      <span className="tk-status-dot" data-state={state} aria-hidden="true" />
      <span>{labels[state]}</span>
    </span>
  );
}

export function App() {
  const urlParams = useMemo(
    () => new URLSearchParams(window.location.search),
    []
  );
  const isFramed = typeof window !== 'undefined' && window.top !== window.self;
  const requestedSurface = urlParams.get('surface');
  const isUnauthenticatedFrame = isFramed && requestedSurface !== 'overlay';
  const surface: 'overlay' | 'page' =
    isFramed || requestedSurface === 'overlay' ? 'overlay' : 'page';
  const handshakeToken = useMemo(() => urlParams.get('token') ?? '', [urlParams]);
  const [overlayHandshakeState, setOverlayHandshakeState] = useState<
    'pending' | 'authorized' | 'rejected'
  >(
    isUnauthenticatedFrame
      ? 'rejected'
      : surface === 'overlay'
        ? 'pending'
        : 'authorized'
  );
  const [overlayHandshakeError, setOverlayHandshakeError] = useState<string | null>(
    isUnauthenticatedFrame
      ? 'Framing manager.html without surface=overlay is forbidden'
      : null
  );
  const handshakeAuthorizedRef = useRef<boolean>(
    !isFramed && surface === 'page'
  );

  const [settings, setSettings] = useState<SettingsRecord | null>(null);
  const [conversations, setConversations] = useState<ConversationRecord[]>([]);
  const [allMessages, setAllMessages] = useState<MessageRecord[]>([]);
  const [summaries, setSummaries] = useState<StructuredSummaryRecord[]>([]);
  const [relationships, setRelationships] = useState<RelationshipRecord[]>([]);
  const [changeLogs, setChangeLogs] = useState<ChangeLogEntry[]>([]);
  const [counts, setCounts] = useState<LibraryReconciledCounts | null>(null);

  const [searchQuery, setSearchQuery] = useState('');
  const [activeArea, setActiveArea] = useState<string>('All threads');
  const [activeQueue, setActiveQueue] = useState<ResurfaceQueue | 'all'>('all');
  const [providerFilter, setProviderFilter] = useState<ProviderId | 'all'>('all');
  const [stateFilter, setStateFilter] = useState<WorkflowState | 'all'>('all');
  const [coverageFilter, setCoverageFilter] = useState<CoverageState | 'all'>('all');
  const [selectedThreadKey, setSelectedThreadKey] = useState<string | null>(null);
  const [mobileDetailVisible, setMobileDetailVisible] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

  const [activeEvidenceId, setActiveEvidenceId] = useState<string | null>(null);
  const [statusAnnouncement, setStatusAnnouncement] = useState('');

  // Editable fields for selected thread
  const [titleDraft, setTitleDraft] = useState('');
  const [notesDraft, setNotesDraft] = useState('');
  const [tagInputDraft, setTagInputDraft] = useState('');

  // Native <dialog> refs
  const organizeDialogRef = useRef<HTMLDialogElement | null>(null);
  const importDialogRef = useRef<HTMLDialogElement | null>(null);
  const settingsDialogRef = useRef<HTMLDialogElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const rowRefs = useRef<Map<string, HTMLButtonElement>>(new Map());

  // Organize dialog state
  const [organizeInstruction, setOrganizeInstruction] = useState(
    'Group my Daydock logo conversations, but keep the homepage research separate'
  );
  const [organizeProposals, setOrganizeProposals] = useState<
    OrganizeProposalItem[]
  >([]);

  // Import/Export state
  const [importJsonText, setImportJsonText] = useState('');
  const [importFormat, setImportFormat] = useState<
    'chatgpt' | 'claude' | 'portable'
  >('chatgpt');
  const [exportedPreviewText, setExportedPreviewText] = useState('');

  const reloadAll = async (preserveSelectionKey?: string | null) => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) {
      return;
    }
    const loadedSettings = await ensureStarterCollectionsAndSettings(sharedDb);
    if (urlParams.get('seed') === '1') {
      await seedSyntheticWorkbenchLibrary(sharedDb);
    }
    const [convs, msgs, sums, rels, logs, reconciled] = await Promise.all([
      sharedDb.conversations.toArray(),
      sharedDb.messages.toArray(),
      sharedDb.summaries.toArray(),
      sharedDb.relationships.toArray(),
      sharedDb.changeLogs.orderBy('createdAt').reverse().toArray(),
      reconcileLibraryCounts(sharedDb),
    ]);

    setSettings(loadedSettings);
    setConversations(convs);
    setAllMessages(msgs);
    setSummaries(sums);
    setRelationships(rels);
    setChangeLogs(logs);
    setCounts(reconciled);

    const urlQuery = urlParams.get('q');
    const urlThreadKey = urlParams.get('threadKey');

    const initialQuery =
      urlQuery !== null ? urlQuery : loadedSettings.lastSearchQuery;
    setSearchQuery(initialQuery);
    setActiveArea(loadedSettings.lastActiveArea || 'All threads');
    setActiveQueue(loadedSettings.lastActiveQueue || 'all');

    const targetKey =
      preserveSelectionKey !== undefined
        ? preserveSelectionKey
        : urlThreadKey ||
          loadedSettings.lastSelectedThreadKey ||
          convs.find((c) => !c.isSyntheticBenchmark)?.threadKey ||
          null;

    setSelectedThreadKey(targetKey);
  };

  useEffect(() => {
    if (isUnauthenticatedFrame) {
      setOverlayHandshakeState('rejected');
      setOverlayHandshakeError(
        'Framing manager.html without surface=overlay is forbidden'
      );
      return;
    }

    if (surface !== 'overlay') {
      handshakeAuthorizedRef.current = true;
      void reloadAll();
      return;
    }

    // Immediately scrub token query param from URL inside the overlay frame
    try {
      const cleanParams = new URLSearchParams(window.location.search);
      cleanParams.delete('token');
      const nextUrl = `${window.location.pathname}?${cleanParams.toString()}`;
      window.history.replaceState(null, '', nextUrl);
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
        {
          type: 'REDEEM_OVERLAY_HANDSHAKE',
          handshakeToken,
        },
        (resp: { ok?: boolean; error?: string } | undefined) => {
          if (resp?.ok) {
            handshakeAuthorizedRef.current = true;
            setOverlayHandshakeState('authorized');
            void reloadAll();
          } else {
            handshakeAuthorizedRef.current = false;
            setOverlayHandshakeState('rejected');
            setOverlayHandshakeError(
              resp?.error ?? 'Overlay handshake token rejected'
            );
          }
        }
      );
    } else {
      handshakeAuthorizedRef.current = true;
      setOverlayHandshakeState('authorized');
      void reloadAll();
    }
  }, []);

  // Apply theme & density to documentElement
  useEffect(() => {
    if (!settings) return;
    const effectiveTheme =
      settings.theme === 'dark' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', effectiveTheme);
    document.documentElement.setAttribute('data-density', settings.density);
  }, [settings?.theme, settings?.density]);

  const persistSettingPatch = async (patch: Partial<SettingsRecord>) => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    const current = await ensureStarterCollectionsAndSettings(sharedDb);
    const updated: SettingsRecord = { ...current, ...patch };
    await sharedDb.settings.put(updated);
    setSettings(updated);
  };

  const summariesByThread = useMemo(
    () => new Map(summaries.map((s) => [s.threadKey, s])),
    [summaries]
  );

  const messagesByThread = useMemo(() => {
    const map = new Map<string, MessageRecord[]>();
    for (const m of allMessages) {
      const list = map.get(m.threadKey) ?? [];
      list.push(m);
      map.set(m.threadKey, list);
    }
    for (const list of map.values()) {
      list.sort((a, b) => a.ordinal - b.ordinal);
    }
    return map;
  }, [allMessages]);

  const searchIndex = useMemo(() => {
    const idx = new MemorySearchIndex();
    idx.loadSnapshot({
      conversations,
      messages: allMessages,
      summaries,
    });
    return idx;
  }, [conversations, allMessages, summaries]);

  const searchResults = useMemo(() => {
    return searchIndex.searchLocal(
      searchQuery,
      {
        provider: providerFilter,
        project: activeArea,
        workflowState: stateFilter,
        coverage: coverageFilter,
        includeSyntheticBenchmark: false,
      },
      700
    );
  }, [
    searchIndex,
    searchQuery,
    providerFilter,
    activeArea,
    stateFilter,
    coverageFilter,
  ]);

  const queueItemsMap = useMemo(() => {
    if (activeQueue === 'all') return null;
    const items = computeResurfacingQueueItems(
      conversations,
      summariesByThread,
      activeQueue
    );
    return new Map(items.map((i) => [i.conversation.threadKey, i]));
  }, [conversations, summariesByThread, activeQueue]);

  const displayedHits: SearchHit[] = useMemo(() => {
    if (!queueItemsMap) return searchResults.hits;
    return searchResults.hits.filter((h) =>
      queueItemsMap.has(h.conversation.threadKey)
    );
  }, [searchResults.hits, queueItemsMap]);

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
  }, [selectedConversation?.threadKey, selectedConversation?.manualTitleOverride, selectedConversation?.manualNotes, selectedConversation?.tags.join(',')]);

  const selectedMessages = useMemo(
    () =>
      selectedConversation
        ? messagesByThread.get(selectedConversation.threadKey) ?? []
        : [],
    [selectedConversation, messagesByThread]
  );

  const selectedSummary = useMemo(
    () =>
      selectedConversation
        ? summariesByThread.get(selectedConversation.threadKey) ?? null
        : null,
    [selectedConversation, summariesByThread]
  );

  const selectedRelationships = useMemo(() => {
    if (!selectedConversation) return [];
    return relationships.filter(
      (r) =>
        (r.fromThreadKey === selectedConversation.threadKey ||
          r.toThreadKey === selectedConversation.threadKey) &&
        !r.dismissedByUser
    );
  }, [relationships, selectedConversation]);

  const handleSelectThread = (threadKey: string) => {
    setSelectedThreadKey(threadKey);
    setMobileDetailVisible(true);
    void persistSettingPatch({ lastSelectedThreadKey: threadKey });
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
    void persistSettingPatch({
      lastActiveQueue: queue,
      lastActiveArea: 'All threads',
    });
  };

  const handleSaveManualEdits = async () => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    if (!selectedConversation) return;
    const parsedTags = normalizeTags(
      tagInputDraft
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    );
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, {
      manualTitleOverride:
        titleDraft.trim() && titleDraft.trim() !== selectedConversation.title
          ? titleDraft.trim()
          : null,
      manualNotes: notesDraft,
      manualTags: parsedTags,
    });
    await reloadAll(selectedConversation.threadKey);
    setStatusAnnouncement('Saved manual title, tags, and notes.');
  };

  const handleProjectChange = async (nextProject: string) => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    if (!selectedConversation) return;
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, {
      project: nextProject,
      categoryLocked: true,
    });
    await reloadAll(selectedConversation.threadKey);
    setStatusAnnouncement(`Filed under ${nextProject} (locked).`);
  };

  const handleToggleLock = async (locked: boolean) => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    if (!selectedConversation) return;
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, {
      categoryLocked: locked,
    });
    await reloadAll(selectedConversation.threadKey);
  };

  const handleWorkflowStateChange = async (nextState: WorkflowState) => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    if (!selectedConversation) return;
    await updateManualThreadFields(sharedDb, selectedConversation.threadKey, {
      workflowState: nextState,
    });
    await reloadAll(selectedConversation.threadKey);
    setStatusAnnouncement(`Updated status to ${nextState}.`);
  };

  const handleDeleteSelected = async () => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    if (!selectedConversation) return;
    const deletedTitle = getDisplayTitle(selectedConversation);
    await deleteConversationCascade(sharedDb, selectedConversation.threadKey);
    await reloadAll(null);
    setStatusAnnouncement(`Deleted "${deletedTitle}" and recorded tombstone.`);
  };

  const lastInnerModalCloseAtRef = useRef<number>(0);

  const handleCloseOverlay = () => {
    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage({
          type: 'CLOSE_THREADKEEPER_OVERLAY',
          handshakeToken,
        });
      } catch {
        // ignore if extension context invalidated
      }
    }
  };

  useEffect(() => {
    const getOpenInnerModal = () =>
      [
        organizeDialogRef.current,
        importDialogRef.current,
        settingsDialogRef.current,
      ].find((d) => d && (d.open || d.hasAttribute('open')));

    const handleEscapeStep = () => {
      const openModal = getOpenInnerModal();
      if (openModal) {
        lastInnerModalCloseAtRef.current = Date.now();
        openModal.close();
        return;
      }
      if (Date.now() - lastInnerModalCloseAtRef.current < 150) {
        return;
      }
      if (surface === 'overlay') {
        handleCloseOverlay();
      }
    };

    const onKeyDown = (e: KeyboardEvent) => {
      const openModal = getOpenInnerModal();

      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleEscapeStep();
        return;
      }

      if (openModal) return;

      const target = e.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      const isEditing =
        tag === 'input' ||
        tag === 'textarea' ||
        tag === 'select' ||
        Boolean(target?.isContentEditable);

      if (!isEditing && e.key === '/') {
        e.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (!isEditing && (e.key === 'j' || e.key === 'k')) {
        if (displayedHits.length === 0) return;
        e.preventDefault();
        const curIdx = displayedHits.findIndex(
          (h) => h.conversation.threadKey === selectedConversation?.threadKey
        );
        const nextIdx =
          e.key === 'j'
            ? Math.min(displayedHits.length - 1, Math.max(0, curIdx + 1))
            : Math.max(0, curIdx <= 0 ? 0 : curIdx - 1);
        const nextKey = displayedHits[nextIdx]?.conversation.threadKey;
        if (nextKey) {
          handleSelectThread(nextKey);
          rowRefs.current.get(nextKey)?.focus();
        }
      }
    };

    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        source?: string;
        handshakeToken?: string;
        action?: string;
      } | null;
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
  }, [
    surface,
    handshakeToken,
    displayedHits,
    selectedConversation?.threadKey,
  ]);

  const handleOpenFullPage = () => {
    const params = new URLSearchParams({ surface: 'page' });
    if (selectedConversation) {
      params.set('threadKey', selectedConversation.threadKey);
    }
    if (searchQuery) {
      params.set('q', searchQuery);
    }
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

  const openOrganizeModal = () => {
    const proposals = previewNaturalLanguageOrganize(
      organizeInstruction,
      conversations
    );
    setOrganizeProposals(proposals);
    if (organizeDialogRef.current) {
      if (typeof organizeDialogRef.current.showModal === 'function') {
        organizeDialogRef.current.showModal();
      } else {
        organizeDialogRef.current.setAttribute('open', 'true');
      }
    }
  };

  const handleApplyOrganize = async () => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    const entry = await applyOrganizeProposals(
      sharedDb,
      organizeInstruction,
      organizeProposals
    );
    organizeDialogRef.current?.close();
    await reloadAll(selectedConversation?.threadKey);
    setStatusAnnouncement(
      `Applied organization to ${entry.snapshots.length} conversations.`
    );
  };

  const handleUndoLastOrganize = async () => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    const latestActive = changeLogs.find((c) => !c.undone);
    if (!latestActive) return;
    const res = await undoChangeLog(sharedDb, latestActive.changeId);
    await reloadAll(selectedConversation?.threadKey);
    setStatusAnnouncement(`Undid changes across ${res.restoredCount} threads.`);
  };

  const handleLoad652Fixture = async () => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    const raw652 = generate652ChatGPTExportFixture();
    const bound = settings?.boundAccounts.chatgpt ?? {
      accountId: 'acct_chatgpt_primary',
      workspaceId: 'ws_personal',
    };
    const parsed = parseChatGPTExport(raw652, bound);
    for (const item of parsed) {
      await sharedDb.conversations.get(item.threadKey);
    }
    // Bulk upsert via upsertThread
    const { upsertThread } = await import('../../core/db.js');
    for (const item of parsed) {
      await upsertThread(sharedDb, item);
    }
    importDialogRef.current?.close();
    await reloadAll(selectedConversation?.threadKey);
    setStatusAnnouncement('Imported 652 ChatGPT fixture conversations.');
  };

  const handleImportJsonSubmit = async () => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    if (!importJsonText.trim()) return;
    try {
      const data = JSON.parse(importJsonText);
      const { upsertThread } = await import('../../core/db.js');
      if (importFormat === 'chatgpt') {
        const arr = (Array.isArray(data) ? data : [data]) as ChatGPTExportConversation[];
        const bound = settings?.boundAccounts.chatgpt ?? {
          accountId: 'acct_chatgpt_primary',
          workspaceId: 'ws_personal',
        };
        const parsed = parseChatGPTExport(arr, bound);
        for (const item of parsed) {
          await upsertThread(sharedDb, item);
        }
        setStatusAnnouncement(`Imported ${parsed.length} ChatGPT records.`);
      } else if (importFormat === 'claude') {
        const arr = (Array.isArray(data) ? data : [data]) as ClaudeExportConversation[];
        const bound = settings?.boundAccounts.claude ?? {
          accountId: 'acct_claude_primary',
          workspaceId: 'ws_personal',
        };
        const parsed = parseClaudeExport(arr, bound);
        for (const item of parsed) {
          await upsertThread(sharedDb, item);
        }
        setStatusAnnouncement(`Imported ${parsed.length} Claude records.`);
      } else {
        const res = await importPortableBundle(sharedDb, data as PortableBundle);
        setStatusAnnouncement(
          `Imported ${res.importedCount} portable records (${res.skippedTombstones} deleted skipped).`
        );
      }
      await reloadAll(selectedConversation?.threadKey);
    } catch (err) {
      setStatusAnnouncement(
        `Import error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  };

  const handleExportPortable = async () => {
    if (surface === 'overlay' && !handshakeAuthorizedRef.current) return;
    const bundle = await exportPortableBundle(sharedDb);
    setExportedPreviewText(JSON.stringify(bundle, null, 2));
  };

  const renderEvidencePassage = (
    evidenceId: string,
    messageIndexes: number[]
  ) => {
    if (activeEvidenceId !== evidenceId || !selectedConversation) return null;
    const cited = messageIndexes
      .map((ord) => selectedMessages.find((m) => m.ordinal === ord))
      .filter((m): m is MessageRecord => Boolean(m));

    return (
      <div className="tk-evidence-passage-box" role="region" aria-label="Source passage">
        <div className="tk-tabular" style={{ fontWeight: 600, marginBottom: 4 }}>
          Captured evidence · sourceRevision r{selectedConversation.sourceRevision} ·{' '}
          {selectedConversation.coverage} coverage
        </div>
        {cited.length > 0 ? (
          cited.map((m) => (
            <div key={m.messageKey} style={{ marginTop: 4 }}>
              <strong>
                [m{m.ordinal + 1} · {m.role}]
              </strong>
              : “{m.content}”
            </div>
          ))
        ) : (
          <div>
            Message m{(messageIndexes[0] ?? 0) + 1} captured in thread revision r
            {selectedConversation.sourceRevision}.
          </div>
        )}
      </div>
    );
  };

  const latestUndoableLog = changeLogs.find((c) => !c.undone);

  if (surface === 'overlay' && overlayHandshakeState !== 'authorized') {
    if (overlayHandshakeState === 'rejected') {
      return (
        <div
          className="tk-workbench"
          data-surface="overlay"
          data-testid="overlay-handshake-rejected"
          role="alert"
          style={{ padding: 24 }}
        >
          <strong>Unauthorized overlay frame rejected</strong>
          <p style={{ marginTop: 8 }}>{overlayHandshakeError}</p>
        </div>
      );
    }
    return (
      <div
        className="tk-workbench"
        data-surface="overlay"
        data-testid="overlay-handshake-pending"
        aria-busy="true"
        style={{ padding: 24 }}
      >
        Verifying overlay handshake…
      </div>
    );
  }

  return (
    <div className="tk-workbench" data-surface={surface}>
      {surface === 'page' && (
        <a href="#tk-main-list" className="tk-skip-link">
          Skip to conversation list
        </a>
      )}

      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
        }}
      >
        {statusAnnouncement}
      </div>

      {/* Header */}
      <header className="tk-header">
        <div className="tk-header-left">
          <button
            type="button"
            className="tk-btn"
            aria-label="Toggle navigation rail"
            onClick={() => {
              if (window.innerWidth <= 760) {
                setMobileDrawerOpen((v) => !v);
              } else {
                void persistSettingPatch({
                  sidebarCollapsed: !settings?.sidebarCollapsed,
                });
              }
            }}
          >
            ☰
          </button>
          <h1 className="tk-h1">Threadkeeper</h1>

          {counts && (
            <details className="tk-counts-details">
              <summary className="tk-counts-summary">
                {counts.totalThreads} threads · {counts.filedCount} filed ·{' '}
                {counts.unfiledCount} unfiled
              </summary>
              <div className="tk-counts-popover">
                <strong>How these are counted</strong>
                <p style={{ margin: '6px 0 0' }}>
                  Total ({counts.totalThreads}) equals filed ({counts.filedCount}) +
                  unfiled ({counts.unfiledCount}). {counts.partialOrTitleOnlyCount}{' '}
                  threads have partial or title-only DOM coverage;{' '}
                  {counts.coverageCounts.full} have full export coverage.
                  {counts.syntheticBenchmarkCount > 0
                    ? ` (${counts.syntheticBenchmarkCount} synthetic benchmark records isolated from user totals.)`
                    : ''}
                </p>
              </div>
            </details>
          )}
        </div>

        <div className="tk-header-actions">
          {latestUndoableLog && (
            <button
              type="button"
              className="tk-btn"
              onClick={() => void handleUndoLastOrganize()}
            >
              Undo organize ({latestUndoableLog.snapshots.length})
            </button>
          )}
          <button
            type="button"
            className="tk-btn"
            onClick={openOrganizeModal}
          >
            Organize…
          </button>
          <button
            type="button"
            className="tk-btn"
            onClick={() => {
              if (importDialogRef.current) {
                if (typeof importDialogRef.current.showModal === 'function') {
                  importDialogRef.current.showModal();
                } else {
                  importDialogRef.current.setAttribute('open', 'true');
                }
              }
            }}
          >
            Import / Export
          </button>
          <button
            type="button"
            className="tk-btn"
            onClick={() => {
              if (settingsDialogRef.current) {
                if (typeof settingsDialogRef.current.showModal === 'function') {
                  settingsDialogRef.current.showModal();
                } else {
                  settingsDialogRef.current.setAttribute('open', 'true');
                }
              }
            }}
          >
            Settings
          </button>
          <button
            type="button"
            className="tk-btn"
            aria-label="Toggle density"
            onClick={() =>
              void persistSettingPatch({
                density:
                  settings?.density === 'compact' ? 'comfortable' : 'compact',
              })
            }
          >
            {settings?.density === 'compact' ? 'Compact' : 'Comfortable'}
          </button>
          <button
            type="button"
            className="tk-btn"
            aria-label="Toggle color theme"
            onClick={() =>
              void persistSettingPatch({
                theme: settings?.theme === 'dark' ? 'light' : 'dark',
              })
            }
          >
            {settings?.theme === 'dark' ? 'Dark' : 'Light'}
          </button>
          {surface === 'overlay' && (
            <>
              <button
                type="button"
                className="tk-btn"
                onClick={handleOpenFullPage}
              >
                Open full page ↗
              </button>
              <button
                type="button"
                className="tk-btn tk-btn-primary"
                aria-label="Close Threadkeeper overlay"
                onClick={handleCloseOverlay}
              >
                Close
              </button>
            </>
          )}
        </div>
      </header>

      {/* Main 3-column layout */}
      <div
        className="tk-columns"
        data-nav-collapsed={Boolean(settings?.sidebarCollapsed)}
      >
        {/* Left Navigation Rail */}
        <nav
          className="tk-nav"
          aria-label="Projects and resurfacing queues"
          data-drawer-open={mobileDrawerOpen}
        >
          {!settings?.sidebarCollapsed ? (
            <>
              <div>
                <div className="tk-eyebrow">Workstreams</div>
                <div className="tk-nav-list">
                  <button
                    type="button"
                    className="tk-nav-item"
                    aria-current={
                      activeQueue === 'all' && activeArea === 'All threads'
                    }
                    onClick={() => handleAreaSelect('All threads')}
                  >
                    <span>All threads</span>
                    <span className="tk-nav-count">
                      {counts?.totalThreads ?? 0}
                    </span>
                  </button>
                  {STARTER_AREAS.map((area) => (
                    <button
                      key={area}
                      type="button"
                      className="tk-nav-item"
                      aria-current={
                        activeQueue === 'all' && activeArea === area
                      }
                      onClick={() => handleAreaSelect(area)}
                    >
                      <span
                        style={{
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {area}
                      </span>
                      <span className="tk-nav-count">
                        {counts?.projectCounts[area] ?? 0}
                      </span>
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <div className="tk-eyebrow">Resurfacing</div>
                <div className="tk-nav-list">
                  {(Object.keys(RESURFACE_QUEUE_LABELS) as ResurfaceQueue[]).map(
                    (q) => {
                      const qCount = computeResurfacingQueueItems(
                        conversations,
                        summariesByThread,
                        q
                      ).length;
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
                    }
                  )}
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

        {/* Middle List Pane */}
        <main
          id="tk-main-list"
          className="tk-list-pane"
          aria-label="Conversation index"
        >
          <div className="tk-search-bar">
            <div className="tk-search-row">
              <input
                ref={searchInputRef}
                type="search"
                className="tk-input tk-search-input"
                aria-label="Search conversations, decisions, and messages"
                placeholder="Search phrases, fuzzy titles, decisions, or messages…"
                value={searchQuery}
                onChange={(e) => handleSearchChange(e.target.value)}
              />
            </div>

            <div className="tk-filter-row">
              <select
                className="tk-select"
                aria-label="Filter by provider"
                value={providerFilter}
                onChange={(e) =>
                  setProviderFilter(e.target.value as ProviderId | 'all')
                }
              >
                <option value="all">All providers</option>
                <option value="chatgpt">ChatGPT</option>
                <option value="claude">Claude</option>
                <option value="imported">Imported</option>
              </select>

              <select
                className="tk-select"
                aria-label="Filter by workflow state"
                value={stateFilter}
                onChange={(e) =>
                  setStateFilter(e.target.value as WorkflowState | 'all')
                }
              >
                <option value="all">All states</option>
                <option value="active">Active</option>
                <option value="needs_review">Needs review</option>
                <option value="waiting">Waiting</option>
                <option value="paused">Paused</option>
                <option value="done">Done</option>
                <option value="archived">Archived</option>
              </select>

              <select
                className="tk-select"
                aria-label="Filter by capture coverage"
                value={coverageFilter}
                onChange={(e) =>
                  setCoverageFilter(e.target.value as CoverageState | 'all')
                }
              >
                <option value="all">All coverage</option>
                <option value="full">Full export</option>
                <option value="partial">Partial DOM</option>
                <option value="title_only">Title only</option>
              </select>

              <select
                className="tk-select"
                aria-label="View mode"
                value={settings?.viewMode ?? 'list'}
                onChange={(e) =>
                  void persistSettingPatch({
                    viewMode: e.target.value as 'list' | 'kanban' | 'cards',
                  })
                }
              >
                <option value="list">List index</option>
                <option value="kanban">Kanban by status</option>
                <option value="cards">Project cards</option>
              </select>
            </div>
          </div>

          {settings?.viewMode === 'kanban' ? (
            <div className="tk-kanban-grid">
              {(['active', 'needs_review', 'waiting', 'paused', 'done'] as WorkflowState[]).map(
                (st) => {
                  const colHits = displayedHits.filter(
                    (h) => h.conversation.workflowState === st
                  );
                  return (
                    <div key={st} className="tk-kanban-col">
                      <div className="tk-eyebrow">
                        {st.replace('_', ' ')} ({colHits.length})
                      </div>
                      {colHits.map((hit) => (
                        <button
                          key={hit.conversation.threadKey}
                          type="button"
                          className="tk-row-btn"
                          style={{ borderRadius: 6, border: '1px solid var(--rule)' }}
                          aria-selected={
                            selectedConversation?.threadKey ===
                            hit.conversation.threadKey
                          }
                          onClick={() =>
                            handleSelectThread(hit.conversation.threadKey)
                          }
                        >
                          <div className="tk-row-main">
                            <div className="tk-row-title">
                              {getDisplayTitle(hit.conversation)}
                            </div>
                            <div className="tk-row-meta">
                              <span>{hit.conversation.project}</span>
                              <span>·</span>
                              <span>{hit.conversation.provider}</span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  );
                }
              )}
            </div>
          ) : settings?.viewMode === 'cards' ? (
            <div className="tk-cards-grid">
              {Array.from(
                displayedHits.reduce<Map<string, SearchHit[]>>((map, hit) => {
                  const proj = hit.conversation.project || 'Unassigned';
                  const list = map.get(proj) ?? [];
                  list.push(hit);
                  map.set(proj, list);
                  return map;
                }, new Map())
              ).map(([proj, projHits]) => {
                const activeCount = projHits.filter(
                  (h) => h.conversation.workflowState === 'active'
                ).length;
                const reviewCount = projHits.filter(
                  (h) => h.conversation.workflowState === 'needs_review'
                ).length;
                return (
                  <div key={proj} className="tk-project-card">
                    <div className="tk-project-card-header">
                      <span className="tk-row-title">{proj}</span>
                      <span className="tk-eyebrow tk-tabular">
                        {projHits.length} threads
                      </span>
                    </div>
                    <div className="tk-row-meta">
                      <span>{activeCount} active</span>
                      <span>·</span>
                      <span>{reviewCount} needs review</span>
                    </div>
                    <div className="tk-project-card-items">
                      {projHits.slice(0, 6).map((hit) => (
                        <button
                          key={hit.conversation.threadKey}
                          type="button"
                          className="tk-row-btn"
                          style={{
                            borderRadius: 6,
                            border: '1px solid var(--rule)',
                            padding: '6px 8px',
                          }}
                          aria-selected={
                            selectedConversation?.threadKey ===
                            hit.conversation.threadKey
                          }
                          onClick={() =>
                            handleSelectThread(hit.conversation.threadKey)
                          }
                        >
                          <div className="tk-row-main">
                            <div className="tk-row-title">
                              {getDisplayTitle(hit.conversation)}
                            </div>
                            <div className="tk-row-meta">
                              <span>{hit.conversation.provider}</span>
                              <span>·</span>
                              <span>{hit.conversation.coverage}</span>
                            </div>
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          ) : displayedHits.length === 0 ? (
            <div style={{ padding: 24, color: 'var(--ink-2)' }}>
              No conversations match the current filter — clear the search query or
              import a ChatGPT/Claude export bundle to populate this view.
            </div>
          ) : (
            <ul className="tk-row-list">
              {displayedHits.map((hit) => {
                const c = hit.conversation;
                const isSelected =
                  selectedConversation?.threadKey === c.threadKey;
                const queueInfo = queueItemsMap?.get(c.threadKey);
                const dateLabel = c.updatedAt
                  ? c.updatedAt.slice(0, 10)
                  : 'Unknown date';

                return (
                  <li key={c.threadKey} className="tk-row-item">
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
                        <div className="tk-row-title">{getDisplayTitle(c)}</div>
                        <div className="tk-row-excerpt">
                          {queueInfo
                            ? queueInfo.resurfaceReason
                            : hit.supportingExcerpt}
                        </div>
                        <div className="tk-row-meta">
                          <span>
                            {c.project}
                            {c.categoryLocked ? ' (locked)' : ''}
                          </span>
                          <span>·</span>
                          <span>
                            {c.provider} / {c.accountId}
                          </span>
                          {c.branchId !== 'main' && (
                            <>
                              <span>·</span>
                              <span>branch: {c.branchId}</span>
                            </>
                          )}
                          {searchQuery.trim() && (
                            <>
                              <span>·</span>
                              <span>{hit.matchReasons[0]}</span>
                            </>
                          )}
                        </div>
                      </div>

                      <div className="tk-row-right">
                        <span className="tk-tabular">{dateLabel}</span>
                        <CoverageTick coverage={c.coverage} />
                        <StatusPill state={c.workflowState} />
                      </div>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </main>

        {/* Right Detail Reader Pane */}
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
                      const btn = rowRefs.current.get(
                        selectedConversation.threadKey
                      );
                      btn?.focus();
                    }}
                  >
                    ← Back to list
                  </button>
                </div>

                <h2 className="tk-detail-title">
                  {getDisplayTitle(selectedConversation)}
                </h2>

                <div className="tk-detail-meta-strip">
                  <StatusPill state={selectedConversation.workflowState} />
                  <span>·</span>
                  <CoverageTick coverage={selectedConversation.coverage} />
                  <span className="tk-tabular">
                    rev r{selectedConversation.sourceRevision} (
                    {selectedConversation.messageCount} msgs)
                  </span>
                  <span>·</span>
                  <span>
                    {selectedConversation.provider} ({selectedConversation.accountId}{' '}
                    / {selectedConversation.workspaceId})
                  </span>
                  <span>·</span>
                  <span>
                    Cloud task status: {selectedConversation.cloudTaskStatus} (N)
                  </span>
                </div>

                {/* Sibling branch switcher if present */}
                {selectedConversation.siblingBranchIds.length > 0 && (
                  <div className="tk-filter-row" style={{ marginTop: 4 }}>
                    <span className="tk-eyebrow" style={{ padding: 0 }}>
                      Branch ({selectedConversation.branchId}):
                    </span>
                    {selectedConversation.siblingBranchIds.map((sibId) => {
                      const sibConv = conversations.find(
                        (c) =>
                          c.sourceConversationId ===
                            selectedConversation.sourceConversationId &&
                          c.accountId === selectedConversation.accountId &&
                          c.branchId === sibId
                      );
                      if (!sibConv) return null;
                      return (
                        <button
                          key={sibId}
                          type="button"
                          className="tk-btn"
                          onClick={() => handleSelectThread(sibConv.threadKey)}
                        >
                          Switch to {sibId}
                        </button>
                      );
                    })}
                  </div>
                )}

                {/* Action strip */}
                <div className="tk-filter-row" style={{ marginTop: 6 }}>
                  <select
                    className="tk-select"
                    aria-label="Assign project or area"
                    value={selectedConversation.project}
                    onChange={(e) => void handleProjectChange(e.target.value)}
                  >
                    {STARTER_AREAS.map((area) => (
                      <option key={area} value={area}>
                        {area}
                      </option>
                    ))}
                  </select>

                  <label
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      gap: 4,
                      fontSize: 12,
                      color: 'var(--ink-2)',
                    }}
                  >
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
                    onChange={(e) =>
                      void handleWorkflowStateChange(
                        e.target.value as WorkflowState
                      )
                    }
                  >
                    <option value="active">Active</option>
                    <option value="needs_review">Needs review</option>
                    <option value="waiting">Waiting</option>
                    <option value="paused">Paused</option>
                    <option value="done">Done</option>
                    <option value="archived">Archived</option>
                  </select>

                  <button
                    type="button"
                    className="tk-btn"
                    onClick={() => {
                      if (
                        typeof chrome !== 'undefined' &&
                        chrome.runtime?.sendMessage
                      ) {
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

                  <button
                    type="button"
                    className="tk-btn"
                    onClick={() => {
                      const md = exportThreadToMarkdown(
                        selectedConversation,
                        selectedMessages,
                        selectedSummary
                      );
                      void navigator.clipboard?.writeText(md);
                      setStatusAnnouncement('Copied Markdown handoff to clipboard.');
                    }}
                  >
                    Copy handoff
                  </button>

                  <button
                    type="button"
                    className="tk-btn tk-btn-danger"
                    onClick={() => void handleDeleteSelected()}
                  >
                    Delete
                  </button>
                </div>
              </div>

              {/* FOCAL ELEMENT: Where you left off strip (Evidence Location #1) */}
              <div
                className="tk-focal-left-off"
                data-evidence-location="where-you-left-off"
              >
                <div className="tk-eyebrow" style={{ padding: 0 }}>
                  Where you left off
                </div>
                <div className="tk-claim-row" style={{ borderBottom: 0, padding: 0 }}>
                  <p className="tk-focal-serif-line">
                    {selectedSummary?.whereYouLeftOff ??
                      selectedConversation.nextStepText ??
                      selectedConversation.latestDecisionText ??
                      selectedMessages[selectedMessages.length - 1]?.content ??
                      'Title-only capture — open the original conversation or import an export file to read message turns.'}
                  </p>
                  {selectedMessages.length > 0 && (
                    <button
                      type="button"
                      className="tk-evidence-marker"
                      aria-expanded={activeEvidenceId === 'focal-left-off'}
                      onClick={() =>
                        setActiveEvidenceId((prev) =>
                          prev === 'focal-left-off' ? null : 'focal-left-off'
                        )
                      }
                    >
                      <span
                        className="tk-evidence-pip"
                        data-speaker="user_committed"
                        aria-hidden="true"
                      />
                      <span>
                        {(
                          selectedSummary?.whereYouLeftOffMessageIndexes ?? [
                            Math.max(0, selectedMessages.length - 1),
                          ]
                        )
                          .map((i) => `m${i + 1}`)
                          .join(',')}
                      </span>
                    </button>
                  )}
                </div>
                {renderEvidencePassage(
                  'focal-left-off',
                  selectedSummary?.whereYouLeftOffMessageIndexes ?? [
                    Math.max(0, selectedMessages.length - 1),
                  ]
                )}
              </div>

              {/* Evidence Location #2: Decisions */}
              <div
                className="tk-section"
                data-evidence-location="decisions"
              >
                <h3 className="tk-section-h2">Decisions</h3>
                {selectedSummary && selectedSummary.decisions.length > 0 ? (
                  selectedSummary.decisions.map((d, idx) => {
                    const evId = `decision-${idx}`;
                    return (
                      <div key={evId}>
                        <div className="tk-claim-row">
                          <span className="tk-claim-text">{d.text}</span>
                          <button
                            type="button"
                            className="tk-evidence-marker"
                            title={
                              d.speaker === 'user_committed'
                                ? 'User committed decision'
                                : 'Assistant suggested decision'
                            }
                            aria-expanded={activeEvidenceId === evId}
                            onClick={() =>
                              setActiveEvidenceId((prev) =>
                                prev === evId ? null : evId
                              )
                            }
                          >
                            <span
                              className="tk-evidence-pip"
                              data-speaker={d.speaker}
                              aria-hidden="true"
                            />
                            <span>
                              {d.messageIndexes.map((i) => `m${i + 1}`).join(',')}
                            </span>
                          </button>
                        </div>
                        {renderEvidencePassage(evId, d.messageIndexes)}
                      </div>
                    );
                  })
                ) : selectedConversation.latestDecisionText ? (
                  <div>
                    <div className="tk-claim-row">
                      <span className="tk-claim-text">
                        {selectedConversation.latestDecisionText}
                      </span>
                      <button
                        type="button"
                        className="tk-evidence-marker"
                        aria-expanded={activeEvidenceId === 'cached-decision'}
                        onClick={() =>
                          setActiveEvidenceId((prev) =>
                            prev === 'cached-decision' ? null : 'cached-decision'
                          )
                        }
                      >
                        <span
                          className="tk-evidence-pip"
                          data-speaker={
                            selectedConversation.latestDecisionSpeaker ??
                            'user_committed'
                          }
                          aria-hidden="true"
                        />
                        <span>
                          m{(selectedConversation.latestDecisionMsgIndex ?? 0) + 1}
                        </span>
                      </button>
                    </div>
                    {renderEvidencePassage('cached-decision', [
                      selectedConversation.latestDecisionMsgIndex ?? 0,
                    ])}
                  </div>
                ) : (
                  <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                    No explicit decisions extracted yet — run opt-in enrichment or
                    record a manual decision note below.
                  </div>
                )}
              </div>

              {/* Evidence Location #3: Action items & Next step */}
              <div
                className="tk-section"
                data-evidence-location="action-items"
              >
                <h3 className="tk-section-h2">Action items & next steps</h3>
                {selectedSummary && selectedSummary.actionItems.length > 0 ? (
                  selectedSummary.actionItems.map((a, idx) => {
                    const evId = `action-${idx}`;
                    return (
                      <div key={evId}>
                        <div className="tk-claim-row">
                          <span className="tk-claim-text">{a.text}</span>
                          <button
                            type="button"
                            className="tk-evidence-marker"
                            aria-expanded={activeEvidenceId === evId}
                            onClick={() =>
                              setActiveEvidenceId((prev) =>
                                prev === evId ? null : evId
                              )
                            }
                          >
                            <span
                              className="tk-evidence-pip"
                              data-speaker={a.speaker}
                              aria-hidden="true"
                            />
                            <span>
                              {a.messageIndexes.map((i) => `m${i + 1}`).join(',')}
                            </span>
                          </button>
                        </div>
                        {renderEvidencePassage(evId, a.messageIndexes)}
                      </div>
                    );
                  })
                ) : selectedConversation.nextStepText ? (
                  <div>
                    <div className="tk-claim-row">
                      <span className="tk-claim-text">
                        {selectedConversation.nextStepText}
                      </span>
                      <button
                        type="button"
                        className="tk-evidence-marker"
                        aria-expanded={activeEvidenceId === 'cached-next-step'}
                        onClick={() =>
                          setActiveEvidenceId((prev) =>
                            prev === 'cached-next-step' ? null : 'cached-next-step'
                          )
                        }
                      >
                        <span
                          className="tk-evidence-pip"
                          data-speaker={
                            selectedConversation.nextStepSpeaker ??
                            'user_committed'
                          }
                          aria-hidden="true"
                        />
                        <span>
                          m{(selectedConversation.nextStepMsgIndex ?? 0) + 1}
                        </span>
                      </button>
                    </div>
                    {renderEvidencePassage('cached-next-step', [
                      selectedConversation.nextStepMsgIndex ?? 0,
                    ])}
                  </div>
                ) : (
                  <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                    No pending action items recorded for this conversation.
                  </div>
                )}
              </div>

              {/* Evidence Location #4: Open questions */}
              <div
                className="tk-section"
                data-evidence-location="open-questions"
              >
                <h3 className="tk-section-h2">Open questions</h3>
                {selectedSummary && selectedSummary.openQuestions.length > 0 ? (
                  selectedSummary.openQuestions.map((q, idx) => {
                    const evId = `question-${idx}`;
                    return (
                      <div key={evId}>
                        <div className="tk-claim-row">
                          <span className="tk-claim-text">{q.text}</span>
                          <button
                            type="button"
                            className="tk-evidence-marker"
                            aria-expanded={activeEvidenceId === evId}
                            onClick={() =>
                              setActiveEvidenceId((prev) =>
                                prev === evId ? null : evId
                              )
                            }
                          >
                            <span
                              className="tk-evidence-pip"
                              data-speaker={q.speaker}
                              aria-hidden="true"
                            />
                            <span>
                              {q.messageIndexes.map((i) => `m${i + 1}`).join(',')}
                            </span>
                          </button>
                        </div>
                        {renderEvidencePassage(evId, q.messageIndexes)}
                      </div>
                    );
                  })
                ) : (
                  <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                    No unresolved questions flagged in this thread.
                  </div>
                )}
              </div>

              {/* Evidence Location #5: Related threads & cross-references */}
              <div
                className="tk-section"
                data-evidence-location="related-threads"
              >
                <h3 className="tk-section-h2">Related threads & branches</h3>
                {selectedRelationships.length > 0 ? (
                  selectedRelationships.map((rel) => {
                    const otherKey =
                      rel.fromThreadKey === selectedConversation.threadKey
                        ? rel.toThreadKey
                        : rel.fromThreadKey;
                    const otherConv = conversations.find(
                      (c) => c.threadKey === otherKey
                    );
                    const evId = `rel-${rel.relationshipKey}`;
                    const localOrdinal =
                      rel.fromThreadKey === selectedConversation.threadKey
                        ? rel.evidenceFromOrdinal
                        : rel.evidenceToOrdinal;
                    return (
                      <div key={rel.relationshipKey}>
                        <div className="tk-claim-row">
                          <div>
                            <button
                              type="button"
                              className="tk-btn"
                              style={{ marginRight: 8 }}
                              onClick={() => handleSelectThread(otherKey)}
                            >
                              {rel.relationType.replace('_', ' ')}:{' '}
                              {otherConv
                                ? getDisplayTitle(otherConv)
                                : otherKey}
                            </button>
                            <span className="tk-claim-text">{rel.reason}</span>
                          </div>
                          <button
                            type="button"
                            className="tk-evidence-marker"
                            aria-expanded={activeEvidenceId === evId}
                            onClick={() =>
                              setActiveEvidenceId((prev) =>
                                prev === evId ? null : evId
                              )
                            }
                          >
                            <span
                              className="tk-evidence-pip"
                              data-speaker="user_committed"
                              aria-hidden="true"
                            />
                            <span>m{localOrdinal + 1}</span>
                          </button>
                        </div>
                        {renderEvidencePassage(evId, [localOrdinal])}
                      </div>
                    );
                  })
                ) : (
                  <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                    No cross-thread continuation or contradiction links recorded yet.
                  </div>
                )}
              </div>

              {/* Manual overrides & notes editor */}
              <div className="tk-section">
                <h3 className="tk-section-h2">Manual index overrides & notes</h3>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 8,
                    background: 'var(--paper-2)',
                    padding: 12,
                    borderRadius: 6,
                    border: '1px solid var(--rule)',
                  }}
                >
                  <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                    Title override
                    <input
                      type="text"
                      className="tk-input"
                      style={{ width: '100%', marginTop: 4 }}
                      aria-label="Manual title override"
                      value={titleDraft}
                      onChange={(e) => setTitleDraft(e.target.value)}
                    />
                  </label>
                  <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                    Tags (comma-separated; synonyms normalized)
                    <input
                      type="text"
                      className="tk-input"
                      style={{ width: '100%', marginTop: 4 }}
                      aria-label="Manual tags"
                      value={tagInputDraft}
                      onChange={(e) => setTagInputDraft(e.target.value)}
                    />
                  </label>
                  <label style={{ fontSize: 12, color: 'var(--ink-2)' }}>
                    Workbench notes (preserved across re-imports)
                    <textarea
                      className="tk-input"
                      style={{ width: '100%', minHeight: 68, marginTop: 4 }}
                      aria-label="Manual workbench notes"
                      value={notesDraft}
                      onChange={(e) => setNotesDraft(e.target.value)}
                    />
                  </label>
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: 8,
                    }}
                  >
                    <label
                      style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: 6,
                        fontSize: 12,
                        color: 'var(--ink-2)',
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={selectedConversation.cloudExcluded}
                        onChange={(e) => {
                          void updateManualThreadFields(
                            sharedDb,
                            selectedConversation.threadKey,
                            { cloudExcluded: e.target.checked }
                          ).then(() => reloadAll(selectedConversation.threadKey));
                        }}
                      />
                      Local-only thread (never send to cloud Worker)
                    </label>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        type="button"
                        className="tk-btn"
                        onClick={() => {
                          void requestThreadEnrichment(
                            sharedDb,
                            selectedConversation.threadKey
                          ).then((res) => {
                            setStatusAnnouncement(
                              res.status === 'rejected'
                                ? `Cloud enrichment skipped: ${res.reason}`
                                : `Cloud enrichment ${res.status}.`
                            );
                            void reloadAll(selectedConversation.threadKey);
                          });
                        }}
                      >
                        Enrich via Worker
                      </button>
                      <button
                        type="button"
                        className="tk-btn tk-btn-primary"
                        onClick={() => void handleSaveManualEdits()}
                      >
                        Save notes & overrides
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Captured Message Transcript */}
              <div className="tk-section">
                <h3 className="tk-section-h2">
                  Captured transcript ({selectedMessages.length} messages)
                </h3>
                {selectedMessages.length === 0 ? (
                  <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>
                    No message bodies captured ({selectedConversation.coverage}{' '}
                    state). Open the original conversation or import an export file
                    to populate message turns.
                  </div>
                ) : (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    {selectedMessages.map((m) => (
                      <article
                        key={m.messageKey}
                        style={{
                          padding: '10px 12px',
                          background: 'var(--paper-2)',
                          border: '1px solid var(--rule)',
                          borderRadius: 6,
                        }}
                      >
                        <div
                          className="tk-tabular"
                          style={{
                            fontSize: 11,
                            color: 'var(--ink-3)',
                            marginBottom: 4,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                          }}
                        >
                          m{m.ordinal + 1} · {m.role} ·{' '}
                          {m.createdAt ? m.createdAt.slice(0, 19).replace('T', ' ') : 'timestamp unknown'}
                        </div>
                        <div style={{ whiteSpace: 'pre-wrap', fontSize: 13 }}>
                          {m.content}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div style={{ color: 'var(--ink-2)' }}>
              Select a conversation from the index to read its context and evidence
              margin.
            </div>
          )}
        </section>
      </div>

      {/* Inner Native Dialog #1: Natural-Language Organize Preview */}
      <dialog
        ref={organizeDialogRef}
        id="tk-organize-dialog"
        className="tk-modal-dialog"
        aria-label="Organize conversations with natural language"
        onClose={() => {
          lastInnerModalCloseAtRef.current = Date.now();
        }}
      >
        <h2 className="tk-section-h2" style={{ marginBottom: 8 }}>
          Organize conversations (Preview & Undoable Apply)
        </h2>
        <p style={{ fontSize: 13, color: 'var(--ink-2)', marginTop: 0 }}>
          Nothing is modified silently. Review every proposed project, tag, and
          exclusion rule below before applying.
        </p>
        <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            className="tk-input"
            style={{ flex: 1 }}
            aria-label="Natural language organization instruction"
            value={organizeInstruction}
            onChange={(e) => {
              setOrganizeInstruction(e.target.value);
              setOrganizeProposals(
                previewNaturalLanguageOrganize(e.target.value, conversations)
              );
            }}
          />
          <button
            type="button"
            className="tk-btn"
            onClick={() =>
              setOrganizeProposals(
                previewNaturalLanguageOrganize(organizeInstruction, conversations)
              )
            }
          >
            Preview
          </button>
        </div>

        <div
          style={{
            maxHeight: 280,
            overflowY: 'auto',
            border: '1px solid var(--rule)',
            borderRadius: 6,
            padding: 8,
            marginBottom: 14,
          }}
        >
          {organizeProposals.length === 0 ? (
            <div style={{ fontSize: 13, color: 'var(--ink-3)' }}>
              No matching conversations for this instruction.
            </div>
          ) : (
            organizeProposals.map((p) => (
              <div
                key={p.threadKey}
                style={{
                  padding: '8px 6px',
                  borderBottom: '1px solid var(--rule)',
                  fontSize: 13,
                }}
              >
                <div style={{ fontWeight: 600 }}>{p.title}</div>
                <div style={{ color: 'var(--ink-2)', fontSize: 12 }}>
                  {p.excludedByInstruction ? (
                    <span>Excluded — {p.reason}</span>
                  ) : (
                    <span>
                      {p.currentProject} →{' '}
                      <strong>
                        {p.proposedProject ?? `${p.currentProject} (unchanged)`}
                      </strong>{' '}
                      · tags: {p.proposedTags.join(', ')} ({p.reason})
                    </span>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            className="tk-btn"
            onClick={() => organizeDialogRef.current?.close()}
          >
            Cancel
          </button>
          <button
            type="button"
            className="tk-btn tk-btn-primary"
            onClick={() => void handleApplyOrganize()}
          >
            Apply changes
          </button>
        </div>
      </dialog>

      {/* Inner Native Dialog #2: Import / Export */}
      <dialog
        ref={importDialogRef}
        id="tk-import-export-dialog"
        className="tk-modal-dialog"
        aria-label="Import and export conversations"
        onClose={() => {
          lastInnerModalCloseAtRef.current = Date.now();
        }}
      >
        <h2 className="tk-section-h2" style={{ marginBottom: 8 }}>
          Import & Export Library
        </h2>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 }}>
          <select
            className="tk-select"
            aria-label="Import format"
            value={importFormat}
            onChange={(e) =>
              setImportFormat(
                e.target.value as 'chatgpt' | 'claude' | 'portable'
              )
            }
          >
            <option value="chatgpt">ChatGPT conversations.json</option>
            <option value="claude">Claude conversations.json</option>
            <option value="portable">Threadkeeper Portable JSON</option>
          </select>
          <button
            type="button"
            className="tk-btn"
            onClick={() => void handleLoad652Fixture()}
          >
            Load 652-thread ChatGPT fixture
          </button>
          <button
            type="button"
            className="tk-btn"
            onClick={() =>
              void (async () => {
                await seedSyntheticWorkbenchLibrary(sharedDb, { force: true });
                await reloadAll(selectedThreadKey);
              })()
            }
          >
            Load starter demo threads
          </button>
          <button
            type="button"
            className="tk-btn"
            onClick={() => void handleExportPortable()}
          >
            Generate Portable JSON Export
          </button>
        </div>

        <textarea
          className="tk-input"
          style={{ width: '100%', minHeight: 140, marginBottom: 12 }}
          aria-label="Paste JSON payload to import"
          placeholder="Paste ChatGPT conversations.json, Claude export JSON, or Portable bundle here…"
          value={importJsonText}
          onChange={(e) => setImportJsonText(e.target.value)}
        />

        {exportedPreviewText && (
          <textarea
            readOnly
            className="tk-input"
            style={{ width: '100%', minHeight: 110, marginBottom: 12 }}
            aria-label="Exported Portable JSON bundle"
            value={exportedPreviewText}
          />
        )}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button
            type="button"
            className="tk-btn"
            onClick={() => importDialogRef.current?.close()}
          >
            Close
          </button>
          <button
            type="button"
            className="tk-btn tk-btn-primary"
            onClick={() => void handleImportJsonSubmit()}
          >
            Import JSON
          </button>
        </div>
      </dialog>

      {/* Inner Native Dialog #3: Settings, Privacy & Capability Matrix */}
      <dialog
        ref={settingsDialogRef}
        id="tk-settings-dialog"
        className="tk-modal-dialog"
        aria-label="Settings, privacy, and platform capability matrix"
        onClose={() => {
          lastInnerModalCloseAtRef.current = Date.now();
        }}
      >
        <h2 className="tk-section-h2" style={{ marginBottom: 8 }}>
          Settings, Privacy & Platform Capabilities
        </h2>
        {settings && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div
              style={{
                padding: 12,
                background: 'var(--paper-2)',
                borderRadius: 6,
                border: '1px solid var(--rule)',
              }}
            >
              <strong>Host Capture Authorization (Opt-in per platform)</strong>
              <div style={{ marginTop: 8, display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={settings.authorizedHosts.chatgpt}
                    onChange={(e) =>
                      void persistSettingPatch({
                        authorizedHosts: {
                          ...settings.authorizedHosts,
                          chatgpt: e.target.checked,
                        },
                      })
                    }
                  />
                  Authorize ChatGPT visible-DOM capture
                </label>
                <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  <input
                    type="checkbox"
                    checked={settings.authorizedHosts.claude}
                    onChange={(e) =>
                      void persistSettingPatch({
                        authorizedHosts: {
                          ...settings.authorizedHosts,
                          claude: e.target.checked,
                        },
                      })
                    }
                  />
                  Authorize Claude visible-DOM capture
                </label>
              </div>
            </div>

            <div
              style={{
                padding: 12,
                background: 'var(--paper-2)',
                borderRadius: 6,
                border: '1px solid var(--rule)',
              }}
            >
              <strong>Opt-in Cloud Worker & Daily Budget</strong>
              <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '4px 0 8px' }}>
                Local-first by default. When enabled, only non-excluded threads with
                partial or full coverage send message turns to your authenticated
                Cloudflare Worker (`@cf/deepseek-ai/deepseek-v4.1-flash-1017` and
                MongoDB Atlas Voyage models).
              </p>
              <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <input
                  type="checkbox"
                  checked={settings.cloudEnabled}
                  onChange={(e) =>
                    void persistSettingPatch({ cloudEnabled: e.target.checked })
                  }
                />
                Enable opt-in cloud enrichment & semantic vectors
              </label>
              <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
                <input
                  type="url"
                  className="tk-input"
                  placeholder="https://threadkeeper-worker.example.workers.dev"
                  aria-label="Worker Endpoint URL"
                  value={settings.workerEndpointUrl}
                  onChange={(e) =>
                    void persistSettingPatch({ workerEndpointUrl: e.target.value })
                  }
                />
                <input
                  type="password"
                  className="tk-input"
                  placeholder="Worker Bearer Token"
                  aria-label="Worker Bearer Token"
                  value={settings.workerBearerToken}
                  onChange={(e) =>
                    void persistSettingPatch({ workerBearerToken: e.target.value })
                  }
                />
                <input
                  type="number"
                  className="tk-input"
                  aria-label="Daily cloud request budget"
                  value={settings.dailyCloudRequestBudget}
                  onChange={(e) =>
                    void persistSettingPatch({
                      dailyCloudRequestBudget: Math.max(
                        0,
                        Number.parseInt(e.target.value || '0', 10)
                      ),
                    })
                  }
                />
              </div>
            </div>

            <div>
              <strong>Platform Capability Matrix (Y / P / N)</strong>
              <table
                style={{
                  width: '100%',
                  borderCollapse: 'collapse',
                  fontSize: 12,
                  marginTop: 6,
                }}
              >
                <thead>
                  <tr style={{ borderBottom: '1px solid var(--rule-strong)' }}>
                    <th style={{ textAlign: 'left', padding: 4 }}>Adapter</th>
                    <th style={{ padding: 4 }}>DOM</th>
                    <th style={{ padding: 4 }}>Export</th>
                    <th style={{ padding: 4 }}>Branches</th>
                    <th style={{ padding: 4 }}>Time</th>
                    <th style={{ padding: 4 }}>Cloud Task</th>
                  </tr>
                </thead>
                <tbody>
                  {CAPABILITY_MATRIX.map((row) => (
                    <tr
                      key={row.adapterId}
                      style={{ borderBottom: '1px solid var(--rule)' }}
                    >
                      <td style={{ padding: 4 }}>{row.label}</td>
                      <td style={{ textAlign: 'center', padding: 4 }}>
                        {row.visibleDom}
                      </td>
                      <td style={{ textAlign: 'center', padding: 4 }}>
                        {row.fullExport}
                      </td>
                      <td style={{ textAlign: 'center', padding: 4 }}>
                        {row.branchHistory}
                      </td>
                      <td style={{ textAlign: 'center', padding: 4 }}>
                        {row.timestamps}
                      </td>
                      <td style={{ textAlign: 'center', padding: 4 }}>
                        {row.cloudTaskStatus}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            marginTop: 14,
          }}
        >
          <button
            type="button"
            className="tk-btn tk-btn-primary"
            onClick={() => settingsDialogRef.current?.close()}
          >
            Done
          </button>
        </div>
      </dialog>
    </div>
  );
}
