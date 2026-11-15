import React, { useState, useCallback, useLayoutEffect, useMemo } from 'react';
import { RUN_FILTER_LABELS, type RunFilter } from './filters.js';
import {
  THREAD_KINDS,
  THREAD_KIND_LABELS,
  type CollectionRecord,
  type ConversationRecord,
  type CoverageState,
  type MessageRecord,
  type ProviderId,
  type SettingsRecord,
  type StructuredSummaryRecord,
  type ThreadInsight,
  type ThreadKind,
  type ThreadsGroupBy,
  type WorkflowState,
} from '../../../core/schema.js';
import type { MemorySearchIndex, SearchHit } from '../../../core/search.js';
import { getSmartTitle } from '../../../core/insights.js';
import { providerLabel } from '../../../core/providers.js';
import { RowCheck, BulkActions, THREAD_SORT_LABELS, type ThreadSortMode } from '../BulkActions.js';
import { AskPanel } from '../AskPanel.js';
import { relativeTime } from '../shared.js';
import { Icon } from '../shell/icons.js';
import { useOptionalWorkspaceContext } from '../workspace/context.js';
import { sessionGroupOf } from '../workspace/state.js';
import {
  LENS_GROUP_BY_LABELS,
  SESSION_KINDS,
  SESSION_KIND_LABELS,
  availableGroupBy,
  lensGroupLabel,
  type SessionKind,
} from '../workspace/lens.js';
import { ThreadRow } from './ThreadRow.js';
import {
  buildRepositoryIndex,
  groupThreadHits,
  setPageList,
  toggleGroupCollapsed,
  useThreadGrouping,
  type ThreadGroup,
} from './grouping.js';

export const KANBAN_STATES: WorkflowState[] = ['active', 'needs_review', 'waiting', 'paused', 'done'];
/** Threads shown per project card. */
export const CARD_ITEMS = 6;

export interface KanbanColumn {
  state: WorkflowState;
  hits: SearchHit[];
}

/** One project card: the project name and its threads in list order. */
export type CardGroup = [project: string, hits: SearchHit[]];

export interface ListPaneProps {
  /** Full-page Threads uses the existing navigation column instead of a second list column. */
  placement?: 'main' | 'sidebar';
  /** Workspace filters (full page only): repository, account and observed run state. */
  repositoryFilter?: string | null;
  accountFilter?: string | null;
  runFilter?: RunFilter;
  /** Type of session (coding, chats, bots, other) to keep, or 'all'. */
  typeFilter?: SessionKind | 'all';
  onTypeFilterChange?: (type: SessionKind | 'all') => void;
  onRepositoryFilterChange?: (repository: string | null) => void;
  onAccountFilterChange?: (accountId: string | null) => void;
  onRunFilterChange?: (filter: RunFilter) => void;
  settings: SettingsRecord | null;
  conversations: ConversationRecord[];
  insightsByThread: Map<string, ThreadInsight>;
  summariesByThread: Map<string, StructuredSummaryRecord>;
  messagesByThread: Map<string, MessageRecord[]>;
  vectorsByThread: Map<string, Map<string, number[]>>;
  searchIndex: MemorySearchIndex;
  collectionByName: Map<string, CollectionRecord>;
  projectNames: string[];
  providerOptions: ProviderId[];

  /** Threads in list order, and the same threads as kanban columns and project cards. */
  listHits: SearchHit[];
  kanbanColumns: KanbanColumn[];
  cardGroups: CardGroup[];
  /** Threads in the current view in reading order: what "Select all in view" covers. */
  viewKeys: string[];
  queueItemsMap: Map<string, { resurfaceReason: string }> | null;
  /** The thread open in the detail pane. */
  selectedThreadKey: string | null;
  /** Side panel: the conversation open in the active tab, listed above the index. */
  activeTabConversation: ConversationRecord | null;

  listMode: 'search' | 'ask';
  searchQuery: string;
  rerankNote: string | null;
  providerFilter: ProviderId | 'all';
  kindFilter: ThreadKind | 'all';
  stateFilter: WorkflowState | 'all';
  coverageFilter: CoverageState | 'all';
  sortMode: ThreadSortMode;
  checkedKeys: Set<string>;
  isCompact: boolean;
  stillPaired: boolean;

  searchInputRef: React.MutableRefObject<HTMLInputElement | null>;
  selectAllRef: React.MutableRefObject<HTMLInputElement | null>;
  bulkDeleteDialogRef: React.MutableRefObject<HTMLDialogElement | null>;

  onListModeChange: (mode: 'search' | 'ask') => void;
  onSearchChange: (value: string) => void;
  onSearchSubmit: () => void | Promise<void>;
  onProviderFilterChange: (value: ProviderId | 'all') => void;
  onKindFilterChange: (value: ThreadKind | 'all') => void;
  onStateFilterChange: (value: WorkflowState | 'all') => void;
  onCoverageFilterChange: (value: CoverageState | 'all') => void;
  onSortModeChange: (value: ThreadSortMode) => void;
  onPatchSettings: (patch: Partial<SettingsRecord>) => Promise<void>;
  onSelectThread: (threadKey: string) => void;
  onToggleChecked: (threadKey: string, checked: boolean, extendRange: boolean) => void;
  onSelectionChange: (keys: Set<string>) => void;
  onBulkChanged: (message: string, deletedKeys: readonly string[]) => Promise<void>;
  onBulkDialogClosed: () => void;
  onAnnounce: (message: string) => void;
  /** Opens the picker, or Settings when Still is not paired. */
  onSendToStill: (threadKeys: string[], label: string) => void;
  onOpenSettings: () => void;
  onOpenImport: () => void;
  /** False while an overlay's handshake is not redeemed. */
  canEdit: () => boolean;
  /** Lets the owner focus a row from the keyboard. */
  registerRow: (threadKey: string, el: HTMLButtonElement) => void;
}

/** Search bar, filters, bulk bar and the thread index as list, kanban or project cards. */
export function ListPane({
  placement = 'main',
  repositoryFilter = null,
  accountFilter = null,
  runFilter = 'all',
  typeFilter = 'all',
  onTypeFilterChange,
  onRepositoryFilterChange,
  onAccountFilterChange,
  onRunFilterChange,
  settings,
  conversations,
  insightsByThread,
  summariesByThread,
  messagesByThread,
  vectorsByThread,
  searchIndex,
  collectionByName,
  projectNames,
  providerOptions,
  listHits,
  kanbanColumns,
  cardGroups,
  viewKeys,
  queueItemsMap,
  selectedThreadKey,
  activeTabConversation,
  listMode,
  searchQuery,
  rerankNote,
  providerFilter,
  kindFilter,
  stateFilter,
  coverageFilter,
  sortMode,
  checkedKeys,
  isCompact,
  stillPaired,
  searchInputRef,
  selectAllRef,
  bulkDeleteDialogRef,
  onListModeChange,
  onSearchChange,
  onSearchSubmit,
  onProviderFilterChange,
  onKindFilterChange,
  onStateFilterChange,
  onCoverageFilterChange,
  onSortModeChange,
  onPatchSettings,
  onSelectThread,
  onToggleChecked,
  onSelectionChange,
  onBulkChanged,
  onBulkDialogClosed,
  onAnnounce,
  onSendToStill,
  onOpenSettings,
  onOpenImport,
  canEdit,
  registerRow,
}: ListPaneProps) {
  const ws = useOptionalWorkspaceContext();
  const sidebar = placement === 'sidebar';
  const Pane = sidebar ? 'section' : 'main';
  // The workspace toolbar and grouped list are for the full page. Without a workspace around the
  // list (a test of the list alone) the filter props being present is what asks for them.
  const isPage = ws
    ? ws.surface === 'page'
    : Boolean(onRepositoryFilterChange || onAccountFilterChange || onRunFilterChange || onTypeFilterChange);
  const isListView = settings?.viewMode !== 'kanban' && settings?.viewMode !== 'cards';
  // Full page: the occasional filters sit behind one button so the list starts higher. The
  // button says how many are narrowing the list even while the controls are collapsed.
  const activeFilters =
    Number(providerFilter !== 'all') +
    Number(kindFilter !== 'all') +
    Number(stateFilter !== 'all') +
    Number(coverageFilter !== 'all') +
    Number((runFilter ?? 'all') !== 'all') +
    Number(Boolean(accountFilter)) +
    Number(typeFilter !== 'all');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filtersShown = filtersOpen;
  const groupBy: ThreadsGroupBy = settings?.threadsGroupBy ?? 'none';
  const { collapsed } = useThreadGrouping();
  useLayoutEffect(() => {
    if (!isPage) return;
    setPageList(true);
    return () => setPageList(false);
  }, [isPage]);

  const repositoryIndex = useMemo(
    () => (isPage ? buildRepositoryIndex(conversations) : null),
    [isPage, conversations]
  );
  const accountIdOf = useCallback(
    (conv: ConversationRecord) => ws?.accountOfThread(conv).account?.id ?? null,
    [ws]
  );
  const realms = ws?.workspace.realms ?? [];
  const accountOrder = useMemo(() => realms.flatMap((r) => r.accounts.map((a) => a.id)), [realms]);
  const groups: ThreadGroup[] | null = useMemo(
    () =>
      isPage && isListView && groupBy !== 'none' && repositoryIndex
        ? groupThreadHits(listHits, groupBy, {
            repository: (c) => repositoryIndex.get(c.threadKey) ?? null,
            account: accountIdOf,
            accountOrder,
          })
        : null,
    [isPage, isListView, groupBy, listHits, repositoryIndex, accountIdOf, accountOrder]
  );
  const someRealmHasManyAccounts = realms.some((r) => r.accounts.length > 1);
  const workspaceFilterActive = Boolean(repositoryFilter || accountFilter || runFilter !== 'all' || typeFilter !== 'all');
  // What "Group by" offers: no Account without a second account, no Type or Provider when every
  // thread has the same one. Whatever is in force stays in the list.
  const groupOptions = useMemo(() => {
    if (!isPage) return [];
    const kinds = new Set<string>();
    const providers = new Set<string>();
    for (const c of conversations) {
      if (c.isSyntheticBenchmark) continue;
      providers.add(c.provider);
      kinds.add(sessionGroupOf(c.provider));
    }
    return availableGroupBy(
      'threads',
      { multiAccount: someRealmHasManyAccounts, kindCount: kinds.size, providerCount: providers.size },
      groupBy
    );
  }, [isPage, conversations, someRealmHasManyAccounts, groupBy]);
  const clearWorkspaceFilters = () => {
    onTypeFilterChange?.('all');
    onProviderFilterChange('all');
    onRepositoryFilterChange?.(null);
    onAccountFilterChange?.(null);
    onRunFilterChange?.('all');
  };
  const accountLabel = (accountId: string): string => {
    for (const r of realms) {
      const account = r.accounts.find((a) => a.id === accountId);
      if (account) return `${r.realm.label} · ${account.label}`;
    }
    return 'Removed account';
  };

  const activeChips: Array<{ id: string; name: string; value: string; mono?: boolean; removeLabel: string; remove: () => void }> = [];
  if (typeFilter !== 'all') {
    activeChips.push({
      id: 'type',
      name: 'Type',
      value: SESSION_KIND_LABELS[typeFilter],
      removeLabel: `Remove type filter ${SESSION_KIND_LABELS[typeFilter]}`,
      remove: () => onTypeFilterChange?.('all'),
    });
  }
  if (providerFilter !== 'all') {
    activeChips.push({
      id: 'provider',
      name: 'Provider',
      value: providerLabel(providerFilter),
      removeLabel: `Remove provider filter ${providerLabel(providerFilter)}`,
      remove: () => onProviderFilterChange('all'),
    });
  }
  if (accountFilter) {
    activeChips.push({
      id: 'account',
      name: 'Account',
      value: accountLabel(accountFilter),
      removeLabel: `Remove account filter ${accountLabel(accountFilter)}`,
      remove: () => onAccountFilterChange?.(null),
    });
  }
  if (repositoryFilter) {
    activeChips.push({
      id: 'repository',
      name: 'Repository',
      value: repositoryFilter,
      mono: true,
      removeLabel: `Remove repository filter ${repositoryFilter}`,
      remove: () => onRepositoryFilterChange?.(null),
    });
  }
  if (runFilter !== 'all') {
    activeChips.push({
      id: 'run',
      name: 'Run state',
      value: RUN_FILTER_LABELS[runFilter],
      removeLabel: `Remove run state filter ${RUN_FILTER_LABELS[runFilter]}`,
      remove: () => onRunFilterChange?.('all'),
    });
  }

  const renderRow = (hit: SearchHit) => {
    const c = hit.conversation;
    return (
      <ThreadRow
        compact={sidebar}
        key={c.threadKey}
        hit={hit}
        selected={selectedThreadKey === c.threadKey}
        checked={checkedKeys.has(c.threadKey)}
        insight={insightsByThread.get(c.threadKey) ?? null}
        queueInfo={queueItemsMap?.get(c.threadKey)}
        searching={Boolean(searchQuery.trim())}
        whereYouLeftOff={summariesByThread.get(c.threadKey)?.whereYouLeftOff}
        onToggleChecked={onToggleChecked}
        onSelect={onSelectThread}
        registerRow={registerRow}
        repository={repositoryIndex?.get(c.threadKey) ?? undefined}
      />
    );
  };

  /** "<Sign-in> · <Account>" for an account group; the repository, project, type, provider, date or status name otherwise. */
  const groupHeading = (group: ThreadGroup) => {
    if (groupBy === 'repository') {
      return group.key ? <span className="tk-thr-mono">{group.key}</span> : <span>No repository</span>;
    }
    if (groupBy === 'account') {
      const owner = ws?.accountOfThread(group.hits[0].conversation);
      if (!owner?.account) return <span>No account</span>;
      return (
        <>
          <span className="tk-acct" data-color={owner.account.color} data-active={owner.active ? 'true' : 'false'}>
            <span className="tk-acct-dot" aria-hidden="true" />
          </span>
          <span>
            {owner.realm ? `${owner.realm.label} · ` : ''}
            {owner.account.label}
          </span>
        </>
      );
    }
    if (groupBy === 'project') return <span>{group.key}</span>;
    return <span>{lensGroupLabel(groupBy, group.key)}</span>;
  };
  const groupName = (group: ThreadGroup): string => {
    if (groupBy === 'repository') return group.key ?? 'No repository';
    if (groupBy === 'account') {
      const owner = ws?.accountOfThread(group.hits[0].conversation);
      return owner?.account ? `${owner.realm ? `${owner.realm.label} · ` : ''}${owner.account.label}` : 'No account';
    }
    return groupBy === 'project' ? group.key ?? 'Unassigned' : lensGroupLabel(groupBy, group.key);
  };

  const renderGroups = (list: ThreadGroup[]) => (
    <div className="tk-thr-groups">
      {list.map((group) => {
        const open = !collapsed.has(group.id);
        const listId = `tk-thr-group-${group.id.replace(/[^A-Za-z0-9_-]/g, '_')}`;
        return (
          <div key={group.id} className="tk-thr-group" data-group={group.id}>
            <button
              type="button"
              className="tk-thr-group-head"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              onClick={() => {
                toggleGroupCollapsed(group.id);
                onAnnounce(
                  open
                    ? `${groupName(group)} collapsed, ${group.hits.length} ${group.hits.length === 1 ? 'thread' : 'threads'} hidden.`
                    : `${groupName(group)} expanded.`
                );
              }}
            >
              <Icon name="chevronDown" size={14} className="tk-thr-group-chevron" />
              <span className="tk-thr-group-name">{groupHeading(group)}</span>
              <span className="tk-thr-group-count tk-tabular">{group.hits.length}</span>
            </button>
            {open && (
              <ul id={listId} className="tk-row-list">
                {group.hits.map(renderRow)}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );

  return (
    <Pane id="tk-main-list" className={`tk-list-pane${sidebar ? ' tk-list-sidebar' : ''}`} aria-label={sidebar ? 'Sessions' : 'Conversation index'}>
      <div className="tk-search-bar" data-filters-open={isPage ? (filtersShown ? 'true' : 'false') : undefined}>
        <div className="tk-search-row">
          <div className="tk-segmented" role="tablist" aria-label="Search or ask">
            <button type="button" role="tab" aria-selected={listMode === 'search'} onClick={() => onListModeChange('search')}>
              Search
            </button>
            <button type="button" role="tab" aria-selected={listMode === 'ask'} onClick={() => onListModeChange('ask')}>
              Ask
            </button>
          </div>
          {sidebar && listMode === 'search' && (
            <button type="button" className="tk-icon-btn tk-thr-filters-toggle" aria-label={activeFilters > 0 ? `Filters · ${activeFilters}` : 'Filters'}
              title="Sort, group and filter sessions" aria-expanded={filtersShown} onClick={() => setFiltersOpen((open) => !open)}>
              <Icon name="organize" size={16} />
              {activeFilters > 0 && <span className="tk-tabular">{activeFilters}</span>}
            </button>
          )}
          {listMode === 'search' && (
            <input
              ref={searchInputRef}
              type="search"
              className="tk-input tk-search-input"
              aria-label="Search conversations, decisions, and messages"
              placeholder={
                settings && settings.rerankProvider !== 'none' && settings.rerankInSearch
                  ? 'Search titles, summaries, messages… (Enter reranks)'
                  : 'Search titles, summaries, topics, decisions, messages…'
              }
              value={searchQuery}
              onChange={(e) => onSearchChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void onSearchSubmit();
              }}
            />
          )}
        </div>
        {listMode === 'search' && rerankNote && (
          <div className="tk-muted" role="status" style={{ fontSize: 12 }}>
            {rerankNote}
          </div>
        )}
        {listMode === 'search' && stillPaired && searchQuery.trim() && listHits.length > 0 && (
          <div className="tk-send-results">
            <button
              type="button"
              className="tk-linklike"
              onClick={() => {
                const keys = listHits.slice(0, 200).map((h) => h.conversation.threadKey);
                onSendToStill(keys, keys.length === 1 ? 'this search result' : `${keys.length} search results`);
              }}
            >
              Send {listHits.length > 200 ? 'the top 200 results' : listHits.length === 1 ? 'this result' : `these ${listHits.length} results`} to Still…
            </button>
          </div>
        )}

        {listMode === 'search' && (
          <div className="tk-filter-row">
            <select
              className="tk-select"
              aria-label="View mode"
              value={settings?.viewMode ?? 'list'}
              onChange={(e) => void onPatchSettings({ viewMode: e.target.value as 'list' | 'kanban' | 'cards' })}
            >
              <option value="list">List index</option>
              <option value="kanban">Kanban by status</option>
              <option value="cards">Project cards</option>
            </select>
            <select
              className="tk-select"
              aria-label="Sort threads"
              value={sortMode}
              onChange={(e) => onSortModeChange(e.target.value as ThreadSortMode)}
            >
              {(Object.keys(THREAD_SORT_LABELS) as ThreadSortMode[]).map((mode) => (
                <option key={mode} value={mode}>
                  {THREAD_SORT_LABELS[mode]}
                </option>
              ))}
            </select>
            {isPage && !sidebar && (
              <button
                type="button"
                className="tk-btn tk-thr-filters-toggle"
                aria-expanded={filtersShown}
                onClick={() => setFiltersOpen((open) => !open)}
              >
                {activeFilters > 0 ? `Filters · ${activeFilters}` : 'Filters'}
              </button>
            )}
            <select
              className="tk-select"
              aria-label="Filter by provider"
              value={providerFilter}
              onChange={(e) => onProviderFilterChange(e.target.value as ProviderId | 'all')}
            >
              <option value="all">All providers</option>
              {providerOptions.map((id) => (
                <option key={id} value={id}>
                  {providerLabel(id)}
                </option>
              ))}
            </select>
            {isPage && (
              <select
                className="tk-select"
                aria-label="Filter by type"
                value={typeFilter}
                onChange={(e) => onTypeFilterChange?.(e.target.value as SessionKind | 'all')}
              >
                <option value="all">All types</option>
                {SESSION_KINDS.map((kind) => (
                  <option key={kind} value={kind}>
                    {SESSION_KIND_LABELS[kind]}
                  </option>
                ))}
              </select>
            )}
            <select
              className="tk-select"
              aria-label="Filter by kind of work"
              value={kindFilter}
              onChange={(e) => onKindFilterChange(e.target.value as ThreadKind | 'all')}
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
              onChange={(e) => onStateFilterChange(e.target.value as WorkflowState | 'all')}
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
                onChange={(e) => onCoverageFilterChange(e.target.value as CoverageState | 'all')}
              >
                <option value="all">All coverage</option>
                <option value="full">Full export</option>
                <option value="partial">Partial DOM</option>
                <option value="title_only">Title only</option>
              </select>
            )}
          </div>
        )}

        {isPage && listMode === 'search' && (
          <div className="tk-thr-toolbar">
            {isListView && (
              <div className="tk-thr-groupby">
                <span className="tk-thr-label" aria-hidden="true">
                  Group by
                </span>
                <select
                  className="tk-select"
                  aria-label="Group by"
                  value={groupBy}
                  onChange={(e) => void onPatchSettings({ threadsGroupBy: e.target.value as ThreadsGroupBy })}
                >
                  {groupOptions.map((value) => (
                    <option key={value} value={value}>
                      {LENS_GROUP_BY_LABELS[value]}
                    </option>
                  ))}
                </select>
              </div>
            )}
            <select
              className="tk-select"
              aria-label="Filter by run state"
              value={runFilter}
              onChange={(e) => onRunFilterChange?.(e.target.value as RunFilter)}
            >
              {(Object.keys(RUN_FILTER_LABELS) as RunFilter[]).map((value) => (
                <option key={value} value={value}>
                  {RUN_FILTER_LABELS[value]}
                </option>
              ))}
            </select>
            {someRealmHasManyAccounts && (
              <select
                className="tk-select"
                aria-label="Filter by account"
                value={accountFilter ?? ''}
                onChange={(e) => onAccountFilterChange?.(e.target.value || null)}
              >
                <option value="">Any account</option>
                {realms
                  .filter((r) => r.accounts.length > 0)
                  .map((r) => (
                    <optgroup key={r.realm.id} label={r.realm.label}>
                      {r.accounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.label}
                        </option>
                      ))}
                    </optgroup>
                  ))}
              </select>
            )}
          </div>
        )}
        {isPage && listMode === 'search' && activeChips.length > 0 && (
          <div className="tk-thr-chips" role="group" aria-label="Active filters">
            {activeChips.map((chip) => (
              <span className="tk-thr-filter-chip" key={chip.id}>
                <span>
                  {chip.name}: {chip.mono ? <span className="tk-thr-mono">{chip.value}</span> : chip.value}
                </span>
                <button type="button" className="tk-icon-btn" aria-label={chip.removeLabel} onClick={chip.remove}>
                  <Icon name="close" size={14} />
                </button>
              </span>
            ))}
            <button type="button" className="tk-btn tk-btn-quiet tk-thr-clear" onClick={clearWorkspaceFilters}>
              Clear filters
            </button>
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
          onSelectThread={onSelectThread}
          onOpenSettings={onOpenSettings}
          onSendToStill={
            stillPaired
              ? (keys) => onSendToStill(keys, keys.length === 1 ? 'this thread' : `these ${keys.length} threads`)
              : undefined
          }
        />
      ) : (
        <>
          <BulkActions
            selectedKeys={checkedKeys}
            viewKeys={viewKeys}
            projectNames={projectNames}
            selectAllRef={selectAllRef}
            deleteDialogRef={bulkDeleteDialogRef}
            canEdit={canEdit}
            onSelectionChange={onSelectionChange}
            onChanged={onBulkChanged}
            onAnnounce={onAnnounce}
            stillPaired={stillPaired}
            onDialogClosed={onBulkDialogClosed}
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
                            onToggle={onToggleChecked}
                          />
                          <button
                            type="button"
                            className="tk-row-btn tk-card-btn"
                            aria-selected={selectedThreadKey === hit.conversation.threadKey}
                            onClick={() => onSelectThread(hit.conversation.threadKey)}
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
                              onToggle={onToggleChecked}
                            />
                            <button
                              type="button"
                              className="tk-row-btn tk-card-btn"
                              aria-selected={selectedThreadKey === hit.conversation.threadKey}
                              onClick={() => onSelectThread(hit.conversation.threadKey)}
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
                    <button type="button" className="tk-linklike" onClick={onOpenImport}>
                      import a ChatGPT / Claude export or your Claude Code and Codex sessions
                    </button>
                    .
                  </p>
                </>
              ) : (
                <>
                  <p>No conversations match the current filter — clear the search or pick another project.</p>
                  {isPage && workspaceFilterActive && (
                    <p>
                      <button
                        type="button"
                        className="tk-btn"
                        onClick={() => {
                          onTypeFilterChange?.('all');
                          onRepositoryFilterChange?.(null);
                          onAccountFilterChange?.(null);
                          onRunFilterChange?.('all');
                        }}
                      >
                        Clear type, repository, account and run filters
                      </button>
                    </p>
                  )}
                </>
              )}
            </div>
          ) : groups ? (
            renderGroups(groups)
          ) : (
            <ul className="tk-row-list">{listHits.map(renderRow)}</ul>
          )}
        </>
      )}
    </Pane>
  );
}
