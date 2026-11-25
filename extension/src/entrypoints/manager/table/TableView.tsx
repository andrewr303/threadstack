// The Table view: every thread as a row of a database. Built-in columns (type, provider, dates,
// status, project…) come from the thread itself; columns the person adds hold values they type or
// that Claude fills from each thread's summary. A value the person sets is never replaced by Claude.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { MODEL_OPTIONS } from '../../../core/ai/claude.js';
import { updateManualThreadFields } from '../../../core/db.js';
import {
  normalizeTableLayout,
  type ConversationRecord,
  type TableCellRecord,
  type TableColumnRecord,
  type TableSort,
  type ThreadsTableLayout,
  type WorkflowState,
} from '../../../core/schema.js';
import {
  BUILTIN_COLUMNS,
  BUILTIN_COLUMN_IDS,
  TABLE_COLUMN_TYPE_LABELS,
  TABLE_WORKFLOW_ORDER,
  builtinCellText,
  cellValueText,
  clearAiCells,
  createTableColumn,
  createdAtOf,
  deleteTableColumn,
  indexCells,
  isBuiltinColumnId,
  lastActiveAtOf,
  listTableCells,
  listTableColumns,
  rowMatchesQuery,
  setManualCell,
  sortTableRows,
  tableProviderOptions,
  updateTableColumn,
  type BuiltinColumnId,
  type TableColumnDraft,
  type TableRow,
} from '../../../core/thread-table.js';
import { planColumnFill, runColumnFill, suggestTableColumns, type ColumnProposal, type FillMode, type FillPlan } from '../../../core/table-fill.js';
import { WORKFLOW_LABELS, openModal, sharedDb } from '../shared.js';
import { Icon } from '../shell/icons.js';
import { Notice, ProviderMark, Segmented, providerName } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { ColumnDialog, FillConfirmDialog, SuggestColumnsDialog, type ColumnDialogSeed } from './TableDialogs.js';
import { TableMenu } from './TableMenu.js';

const PAGE_ROWS = 150;

export interface TableViewProps {
  projectNames: readonly string[];
  /** Claude credentials are set (Settings → AI models). */
  aiReady: boolean;
  /** A thread's status or project changed here: refresh the library and tell Still. */
  onThreadsEdited: (threadKeys: string[], options: { privacy: boolean }) => Promise<void>;
}

/** A column as the table draws it: a built-in one, or one the person added. */
type ViewColumn = { kind: 'builtin'; id: BuiltinColumnId; label: string; description: string } | { kind: 'stored'; id: string; label: string; description: string; column: TableColumnRecord };

interface FillRun {
  columnId: string;
  name: string;
  done: number;
  total: number;
  controller: AbortController;
}

export function TableView({ projectNames, aiReady, onThreadsEdited }: TableViewProps) {
  const ctx = useWorkspaceContext();
  const { conversations, insightsByThread, settings, view, accountOfThread, patchSettings } = ctx;
  const [columns, setColumns] = useState<TableColumnRecord[]>([]);
  const [cells, setCells] = useState<TableCellRecord[]>([]);
  const [query, setQuery] = useState('');
  const [limit, setLimit] = useState(PAGE_ROWS);
  const [editing, setEditing] = useState<{ threadKey: string; columnId: string } | null>(null);
  const [fill, setFill] = useState<FillRun | null>(null);
  const [fillPlan, setFillPlan] = useState<FillPlan | null>(null);
  const [columnSeed, setColumnSeed] = useState<ColumnDialogSeed | null>(null);
  const [suggest, setSuggest] = useState<{ busy: boolean; error: string | null; proposals: ColumnProposal[]; added: Set<string>; threadsRead: number }>({
    busy: false,
    error: null,
    proposals: [],
    added: new Set(),
    threadsRead: 0,
  });
  const [notice, setNotice] = useState<string | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const columnDialogRef = useRef<HTMLDialogElement | null>(null);
  const suggestDialogRef = useRef<HTMLDialogElement | null>(null);
  const fillDialogRef = useRef<HTMLDialogElement | null>(null);

  const layout: ThreadsTableLayout = useMemo(() => normalizeTableLayout(settings?.threadsTable), [settings?.threadsTable]);
  const saveLayout = useCallback((next: ThreadsTableLayout) => void patchSettings({ threadsTable: next }), [patchSettings]);

  const reloadTable = useCallback(async () => {
    const [cols, all] = await Promise.all([listTableColumns(sharedDb), listTableCells(sharedDb)]);
    setColumns(cols);
    setCells(all);
  }, []);
  // Load on first show, and again whenever the view comes back (another surface may have changed it).
  useEffect(() => {
    if (view === 'table') void reloadTable();
  }, [view, reloadTable]);

  // "/" searches the table while it is showing (the Threads list keeps its own "/").
  useEffect(() => {
    if (view !== 'table') return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || target?.isContentEditable) return;
      if (document.querySelector('dialog[open]')) return;
      event.preventDefault();
      searchRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view]);

  const cellIndex = useMemo(() => indexCells(cells), [cells]);
  const columnById = useMemo(() => new Map(columns.map((c) => [c.id, c])), [columns]);

  const allColumns: ViewColumn[] = useMemo(
    () => [
      ...BUILTIN_COLUMN_IDS.map((id) => ({ kind: 'builtin' as const, id, label: BUILTIN_COLUMNS[id].label, description: BUILTIN_COLUMNS[id].description })),
      ...columns.map((column) => ({
        kind: 'stored' as const,
        id: column.id,
        label: column.name,
        description: column.instructions || TABLE_COLUMN_TYPE_LABELS[column.type],
        column,
      })),
    ],
    [columns]
  );
  const hidden = useMemo(() => new Set(layout.hidden), [layout.hidden]);
  const shown = allColumns.filter((c) => c.id === 'title' || !hidden.has(c.id));

  // The view stays mounted (its search and scroll survive a switch) but computes nothing while hidden.
  const active = view === 'table';
  const rows: TableRow[] = useMemo(
    () =>
      active
        ? conversations.map((conv) => ({
            conv,
            insight: insightsByThread.get(conv.threadKey) ?? null,
            accountLabel: accountOfThread(conv).account?.label ?? null,
          }))
        : [],
    [active, conversations, insightsByThread, accountOfThread]
  );
  // Provider switch: All plus the providers the library holds most of. Not stored, like the search.
  const [providerFilter, setProviderFilter] = useState<string>('all');
  const providerOptions = useMemo(() => (active ? tableProviderOptions(conversations, providerName) : []), [active, conversations]);
  useEffect(() => {
    if (providerFilter !== 'all' && active && !providerOptions.some((o) => o.provider === providerFilter)) setProviderFilter('all');
  }, [providerFilter, providerOptions, active]);
  const matching = useMemo(
    () =>
      rows.filter(
        (row) =>
          (providerFilter === 'all' || row.conv.provider === providerFilter) &&
          rowMatchesQuery(row, query, cellIndex.get(row.conv.threadKey))
      ),
    [rows, query, cellIndex, providerFilter]
  );
  const sorted = useMemo(
    () => sortTableRows(matching, layout.sort, columnById, (key) => cellIndex.get(key)),
    [matching, layout.sort, columnById, cellIndex]
  );
  const visible = sorted.slice(0, limit);
  useEffect(() => setLimit(PAGE_ROWS), [query, providerFilter]);

  // ---- Sorting and columns ----
  const sortBy = (id: string) => {
    const current = layout.sort;
    const next: TableSort =
      current?.column === id
        ? { column: id, direction: current.direction === 'asc' ? 'desc' : 'asc' }
        : { column: id, direction: id === 'created' || id === 'updated' || id === 'messages' ? 'desc' : 'asc' };
    saveLayout({ ...layout, sort: next });
  };
  const toggleColumn = (id: string) => {
    const next = hidden.has(id) ? layout.hidden.filter((h) => h !== id) : [...layout.hidden, id];
    saveLayout({ ...layout, hidden: next });
  };

  const openNewColumn = (draft?: TableColumnDraft) => {
    setColumnSeed({ mode: 'create', draft });
    openModal(columnDialogRef);
  };
  const openEditColumn = (column: TableColumnRecord) => {
    setColumnSeed({ mode: 'edit', column });
    openModal(columnDialogRef);
  };
  const saveColumn = async (draft: TableColumnDraft, seed: ColumnDialogSeed) => {
    if (seed.mode === 'edit') {
      const { column, changedCells } = await updateTableColumn(sharedDb, seed.column.id, draft);
      ctx.announce(`Saved “${column.name}”${changedCells ? `; ${changedCells} ${changedCells === 1 ? 'value' : 'values'} lost a removed choice` : ''}.`);
    } else {
      const fromClaude = seed.draft && suggest.proposals.some((p) => p.name === seed.draft?.name);
      const column = await createTableColumn(sharedDb, draft, fromClaude ? 'ai' : 'user');
      if (fromClaude && seed.draft) setSuggest((s) => ({ ...s, added: new Set(s.added).add(seed.draft!.name) }));
      ctx.announce(`Added the column “${column.name}”.`);
    }
    await reloadTable();
  };
  const removeColumn = async (column: TableColumnRecord) => {
    if (!window.confirm(`Delete the column “${column.name}” and every value in it? This cannot be undone.`)) return;
    await deleteTableColumn(sharedDb, column.id);
    if (layout.sort?.column === column.id) saveLayout({ ...layout, sort: null });
    await reloadTable();
    ctx.announce(`Deleted the column “${column.name}”.`);
  };
  const clearClaudeValues = async (column: TableColumnRecord) => {
    const n = await clearAiCells(sharedDb, column.id);
    await reloadTable();
    ctx.announce(`Cleared ${n} ${n === 1 ? 'value' : 'values'} Claude wrote in “${column.name}”. Your own values stay.`);
  };

  // ---- Claude ----
  const askToFill = async (column: TableColumnRecord, mode: FillMode) => {
    if (!aiReady) {
      ctx.announce('Add a Claude key in Settings → AI models to fill columns with Claude.');
      ctx.openSettings('ai');
      return;
    }
    const plan = await planColumnFill(sharedDb, column.id, sorted.map((r) => r.conv.threadKey), mode);
    if (plan.threadKeys.length === 0) {
      ctx.announce(`Nothing to fill in “${column.name}”${query ? ' among the rows shown' : ''}.`);
      return;
    }
    setFillPlan(plan);
    openModal(fillDialogRef);
  };
  const startFill = async (plan: FillPlan) => {
    const controller = new AbortController();
    setFill({ columnId: plan.column.id, name: plan.column.name, done: 0, total: plan.threadKeys.length, controller });
    const outcome = await runColumnFill(sharedDb, plan, {
      signal: controller.signal,
      onProgress: (done, total) => {
        setFill((f) => (f && f.controller === controller ? { ...f, done, total } : f));
        if (done > 0) void reloadTable();
      },
    });
    setFill(null);
    await reloadTable();
    const parts = [`Claude filled ${outcome.written} ${outcome.written === 1 ? 'cell' : 'cells'} in “${plan.column.name}”`];
    if (outcome.newOptions.length) parts.push(`added the choices ${outcome.newOptions.join(', ')}`);
    if (outcome.keptManual) parts.push(`kept ${outcome.keptManual} you set meanwhile`);
    const sentence = `${parts.join('; ')}.${outcome.stopped ? ' Stopped.' : ''}${outcome.error ? ` It stopped early: ${outcome.error}` : ''}`;
    ctx.announce(sentence);
    setNotice(sentence);
  };

  const requestSuggestions = async (request: string) => {
    setSuggest((s) => ({ ...s, busy: true, error: null }));
    try {
      const { proposals, threadsRead } = await suggestTableColumns(sharedDb, { request });
      setSuggest((s) => ({ ...s, busy: false, proposals, threadsRead, error: proposals.length ? null : 'Claude had no new column to suggest.' }));
    } catch (err) {
      setSuggest((s) => ({ ...s, busy: false, error: err instanceof Error ? err.message : String(err) }));
    }
  };
  const addProposal = async (proposal: ColumnProposal) => {
    try {
      const column = await createTableColumn(sharedDb, proposal, 'ai');
      setSuggest((s) => ({ ...s, added: new Set(s.added).add(proposal.name) }));
      await reloadTable();
      ctx.announce(`Added the column “${column.name}”.`);
    } catch (err) {
      setSuggest((s) => ({ ...s, error: err instanceof Error ? err.message : String(err) }));
    }
  };

  // ---- Editing ----
  const saveCell = async (column: TableColumnRecord, conv: ConversationRecord, value: unknown) => {
    setEditing(null);
    try {
      await setManualCell(sharedDb, column.id, conv.threadKey, value);
      await reloadTable();
    } catch (err) {
      ctx.announce(err instanceof Error ? err.message : String(err));
    }
  };
  const changeStatus = async (conv: ConversationRecord, state: WorkflowState) => {
    await updateManualThreadFields(sharedDb, conv.threadKey, { workflowState: state });
    await onThreadsEdited([conv.threadKey], { privacy: false });
    ctx.announce(`Status set to ${WORKFLOW_LABELS[state]}.`);
  };
  const changeProject = async (conv: ConversationRecord, project: string) => {
    await updateManualThreadFields(sharedDb, conv.threadKey, { project, categoryLocked: true });
    // A local-only project takes the thread back from Still.
    await onThreadsEdited([conv.threadKey], { privacy: true });
    ctx.announce(`Moved to ${project}.`);
  };

  const modelLabel = MODEL_OPTIONS.find((m) => m.id === settings?.aiModel)?.label ?? 'Claude';

  if (!active) return null;
  if (conversations.length === 0) {
    return (
      <div className="tk-table-view tk-table-none">
        <Notice icon="threads" title="No threads yet">
          <p>Threads appear here as ThreadStack captures or imports them, one row each.</p>
        </Notice>
      </div>
    );
  }

  const renderBuiltin = (id: BuiltinColumnId, row: TableRow) => {
    const { conv } = row;
    const title = builtinCellText('title', row);
    switch (id) {
      case 'title':
        return (
          <div className="tk-table-titlecell">
            <button type="button" className="tk-table-title" onClick={() => ctx.openSession(conv, 'threads')} title="Open in Threads">
              <span className="tk-ellipsis">{title}</span>
            </button>
            {row.insight?.gist && <span className="tk-table-gist tk-ellipsis">{row.insight.gist}</span>}
          </div>
        );
      case 'provider':
        return (
          <span className="tk-table-provider">
            <ProviderMark provider={conv.provider} size="sm" />
            <span>{builtinCellText('provider', row)}</span>
          </span>
        );
      case 'created':
      case 'updated': {
        const iso = id === 'created' ? createdAtOf(conv) : lastActiveAtOf(conv);
        return iso ? <time dateTime={iso}>{builtinCellText(id, row)}</time> : <span className="tk-table-empty">—</span>;
      }
      case 'status':
        return (
          <select
            className="tk-table-select"
            aria-label={`Status of ${title}`}
            value={conv.workflowState}
            onChange={(e) => void changeStatus(conv, e.target.value as WorkflowState)}
          >
            {TABLE_WORKFLOW_ORDER.map((s) => (
              <option key={s} value={s}>
                {WORKFLOW_LABELS[s]}
              </option>
            ))}
          </select>
        );
      case 'project':
        return (
          <select className="tk-table-select" aria-label={`Project of ${title}`} value={conv.project} onChange={(e) => void changeProject(conv, e.target.value)}>
            {(projectNames.includes(conv.project) ? projectNames : [conv.project, ...projectNames]).map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        );
      case 'topics': {
        const topics = row.insight?.topics.slice(0, 4) ?? [];
        return topics.length ? (
          <span className="tk-table-chips">
            {topics.map((t) => (
              <span key={t} className="tk-table-chip">
                {t}
              </span>
            ))}
          </span>
        ) : (
          <span className="tk-table-empty">—</span>
        );
      }
      default: {
        const text = builtinCellText(id, row);
        return text ? <span className={id === 'messages' ? 'tk-tabular' : undefined}>{text}</span> : <span className="tk-table-empty">—</span>;
      }
    }
  };

  const renderStored = (column: TableColumnRecord, row: TableRow) => {
    const { conv } = row;
    const cell = cellIndex.get(conv.threadKey)?.get(column.id);
    const title = builtinCellText('title', row);
    const isEditing = editing?.threadKey === conv.threadKey && editing.columnId === column.id;
    const name = `${column.name} of ${title}`;
    if (column.type === 'checkbox') {
      return (
        <span className="tk-table-check">
          <input
            type="checkbox"
            aria-label={name}
            checked={cell?.value === true}
            onChange={(e) => void saveCell(column, conv, e.target.checked)}
          />
          {cell?.source === 'ai' && <AiMark reason={cell.reason} />}
        </span>
      );
    }
    if (isEditing) {
      return <CellEditor column={column} label={name} value={cell?.value ?? null} onSave={(v) => void saveCell(column, conv, v)} onCancel={() => setEditing(null)} />;
    }
    const text = cellValueText(cell?.value);
    return (
      <button
        type="button"
        className="tk-table-cellbtn"
        aria-label={`${name}: ${text || 'empty'}${cell?.source === 'ai' ? ', filled by Claude' : ''}. Edit`}
        onClick={() => setEditing({ threadKey: conv.threadKey, columnId: column.id })}
      >
        {text ? (
          Array.isArray(cell?.value) || column.type === 'select' ? (
            <span className="tk-table-chips">
              {(Array.isArray(cell?.value) ? cell!.value : [text]).map((v) => (
                <span key={String(v)} className="tk-table-chip">
                  {String(v)}
                </span>
              ))}
            </span>
          ) : (
            <span className={column.type === 'number' ? 'tk-tabular' : 'tk-table-text'}>{text}</span>
          )
        ) : (
          <span className="tk-table-empty">—</span>
        )}
        {cell?.source === 'ai' && <AiMark reason={cell.reason} />}
      </button>
    );
  };

  const sortState = (id: string): 'ascending' | 'descending' | 'none' =>
    layout.sort?.column === id ? (layout.sort.direction === 'asc' ? 'ascending' : 'descending') : 'none';

  return (
    <div className="tk-table-view">
      <header className="tk-table-bar tk-glass" aria-label="Table tools">
        <span className="tk-dash-label">Table</span>
        <label className="tk-table-search">
          <Icon name="search" />
          <input
            ref={searchRef}
            className="tk-input"
            type="text"
            role="searchbox"
            enterKeyHint="search"
            aria-label="Search the table"
            placeholder="Search titles, summaries and values"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {providerOptions.length > 1 && (
          <Segmented
            label="Provider"
            className="tk-table-providers"
            value={providerFilter}
            options={[{ value: 'all', label: 'All' }, ...providerOptions.map((o) => ({ value: o.provider, label: o.label }))]}
            onChange={setProviderFilter}
          />
        )}
        <span className="tk-table-count tk-tabular" role="status">
          {tableCountText(sorted.length, conversations.length)}
        </span>
        {fill && (
          <span className="tk-table-progress" role="status">
            <span>
              Filling “{fill.name}” <span className="tk-tabular">{fill.done}/{fill.total}</span>
            </span>
            <progress max={fill.total} value={fill.done} aria-label={`Filling ${fill.name}`} />
            <button type="button" className="tk-btn tk-btn-quiet" onClick={() => fill.controller.abort()}>
              Stop
            </button>
          </span>
        )}
        <TableMenu
          label="Columns"
          align="right"
          buttonClassName="tk-btn"
          buttonContent={
            <>
              <Icon name="table" />
              <span>Columns</span>
            </>
          }
        >
          {(close) => (
            <>
              <button type="button" role="menuitem" className="tk-pop-item" onClick={() => { close(); openNewColumn(); }}>
                <Icon name="plus" />
                <span>New column…</span>
                <span />
              </button>
              <button
                type="button"
                role="menuitem"
                className="tk-pop-item"
                onClick={() => {
                  close();
                  if (!aiReady) {
                    ctx.announce('Add a Claude key in Settings → AI models to have Claude suggest columns.');
                    ctx.openSettings('ai');
                    return;
                  }
                  openModal(suggestDialogRef);
                }}
              >
                <Icon name="summary" />
                <span>Columns from Claude…</span>
                <span />
              </button>
              <div className="tk-pop-sep" role="separator" />
              <div className="tk-pop-head">Show</div>
              {allColumns.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={c.id === 'title' || !hidden.has(c.id)}
                  disabled={c.id === 'title'}
                  className="tk-pop-item"
                  onClick={() => toggleColumn(c.id)}
                >
                  <span>{(c.id === 'title' || !hidden.has(c.id)) && <Icon name="check" size={14} />}</span>
                  <span className="tk-ellipsis">{c.label}</span>
                  <span className="tk-table-hint">{c.kind === 'stored' ? TABLE_COLUMN_TYPE_LABELS[c.column.type] : ''}</span>
                </button>
              ))}
            </>
          )}
        </TableMenu>
      </header>

      {notice && (
        <p className="tk-table-notice" role="status">
          <span>{notice}</span>
          <button type="button" className="tk-icon-btn" aria-label="Dismiss" onClick={() => setNotice(null)}>
            <Icon name="close" />
          </button>
        </p>
      )}

      <div className="tk-table-scroll">
        <table className="tk-table">
          <thead>
            <tr>
              {shown.map((c) => (
                <th key={c.id} scope="col" aria-sort={sortState(c.id)} data-col={c.kind === 'builtin' ? c.id : 'stored'}>
                  <div className="tk-table-th">
                    <button type="button" className="tk-table-sort" title={c.description} onClick={() => sortBy(c.id)}>
                      <span className="tk-ellipsis">{c.label}</span>
                      {c.kind === 'stored' && c.column.createdBy === 'ai' && <span className="tk-visually-hidden"> (drafted by Claude)</span>}
                      <span className="tk-table-sortmark" aria-hidden="true">
                        {sortState(c.id) === 'ascending' ? '▲' : sortState(c.id) === 'descending' ? '▼' : ''}
                      </span>
                    </button>
                    {c.kind === 'stored' && (
                      <TableMenu
                        label={`${c.label} column`}
                        buttonClassName="tk-icon-btn tk-table-colmenu"
                        title={`${c.label} column`}
                        buttonContent={
                          <>
                            <Icon name="more" />
                            <span className="tk-visually-hidden">{c.label} column options</span>
                          </>
                        }
                      >
                        {(close) => (
                          <>
                            <div className="tk-pop-head">
                              <strong>{c.label}</strong>
                              {TABLE_COLUMN_TYPE_LABELS[c.column.type]}
                            </div>
                            <button type="button" role="menuitem" className="tk-pop-item" disabled={Boolean(fill)} onClick={() => { close(); void askToFill(c.column, 'empty'); }}>
                              <Icon name="summary" />
                              <span>Fill empty cells with Claude</span>
                              <span />
                            </button>
                            <button type="button" role="menuitem" className="tk-pop-item" disabled={Boolean(fill)} onClick={() => { close(); void askToFill(c.column, 'refresh'); }}>
                              <Icon name="reload" />
                              <span>Refill Claude’s values</span>
                              <span />
                            </button>
                            <button type="button" role="menuitem" className="tk-pop-item" disabled={Boolean(fill)} onClick={() => { close(); void clearClaudeValues(c.column); }}>
                              <Icon name="close" />
                              <span>Clear Claude’s values</span>
                              <span />
                            </button>
                            <div className="tk-pop-sep" role="separator" />
                            <button type="button" role="menuitem" className="tk-pop-item" onClick={() => { close(); openEditColumn(c.column); }}>
                              <Icon name="settings" />
                              <span>Edit column…</span>
                              <span />
                            </button>
                            <button type="button" role="menuitem" className="tk-pop-item" onClick={() => { close(); toggleColumn(c.id); }}>
                              <Icon name="unpin" />
                              <span>Hide column</span>
                              <span />
                            </button>
                            <button type="button" role="menuitem" className="tk-pop-item tk-table-danger" disabled={fill?.columnId === c.id} onClick={() => { close(); void removeColumn(c.column); }}>
                              <Icon name="trash" />
                              <span>Delete column</span>
                              <span />
                            </button>
                          </>
                        )}
                      </TableMenu>
                    )}
                  </div>
                </th>
              ))}
              <th scope="col" className="tk-table-addcol">
                <button type="button" className="tk-icon-btn" title="New column" onClick={() => openNewColumn()}>
                  <Icon name="plus" />
                  <span className="tk-visually-hidden">New column</span>
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {visible.map((row) => (
              <tr key={row.conv.threadKey}>
                {shown.map((c) =>
                  c.kind === 'builtin' && c.id === 'title' ? (
                    <th key={c.id} scope="row" data-col="title">
                      {renderBuiltin('title', row)}
                    </th>
                  ) : (
                    <td key={c.id} data-col={c.kind === 'builtin' ? c.id : 'stored'}>
                      {c.kind === 'builtin' ? renderBuiltin(c.id, row) : renderStored(c.column, row)}
                    </td>
                  )
                )}
                <td aria-hidden="true" />
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && <p className="tk-table-nomatch">No threads match “{query}”.</p>}
        {sorted.length > visible.length && (
          <div className="tk-table-more">
            <span className="tk-table-hint">
              Showing {visible.length} of {sorted.length}
            </span>
            <button type="button" className="tk-btn" onClick={() => setLimit((n) => n + PAGE_ROWS)}>
              Show {Math.min(PAGE_ROWS, sorted.length - visible.length)} more
            </button>
          </div>
        )}
      </div>

      <ColumnDialog dialogRef={columnDialogRef} seed={columnSeed} onSave={saveColumn} onClosed={() => setColumnSeed(null)} />
      <SuggestColumnsDialog
        dialogRef={suggestDialogRef}
        busy={suggest.busy}
        error={suggest.error}
        proposals={suggest.proposals}
        added={suggest.added}
        threadsRead={suggest.threadsRead}
        onSuggest={(request) => void requestSuggestions(request)}
        onAdd={(p) => void addProposal(p)}
        onEdit={(p) => {
          suggestDialogRef.current?.close();
          openNewColumn(p);
        }}
        onClosed={() => undefined}
      />
      <FillConfirmDialog dialogRef={fillDialogRef} plan={fillPlan} modelLabel={modelLabel} onConfirm={(plan) => void startFill(plan)} onClosed={() => setFillPlan(null)} />
    </div>
  );
}

/** Marks a value Claude wrote; its reason is the tooltip. */
function AiMark({ reason }: { reason: string | null }) {
  return (
    <span className="tk-table-ai" title={reason ? `Filled by Claude: ${reason}` : 'Filled by Claude'}>
      AI
    </span>
  );
}

/** Edits one cell in place. Enter or leaving the field saves; Escape cancels. */
function CellEditor({
  column,
  label,
  value,
  onSave,
  onCancel,
}: {
  column: TableColumnRecord;
  label: string;
  value: TableCellRecord['value'] | null;
  onSave: (value: unknown) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<string>(Array.isArray(value) ? '' : value === null ? '' : String(value));
  const [picked, setPicked] = useState<string[]>(Array.isArray(value) ? value : []);
  const done = useRef(false);
  // Opening a cell and leaving it as it was must not make Claude's value the person's.
  const unchanged = (next: unknown) =>
    Array.isArray(value) || Array.isArray(next)
      ? JSON.stringify([...(Array.isArray(value) ? value : [])].sort()) === JSON.stringify([...(Array.isArray(next) ? next : [])].sort())
      : (value === null ? '' : String(value)) === (next === null || next === undefined ? '' : String(next).trim());
  const finish = (save: boolean, next?: unknown) => {
    if (done.current) return;
    done.current = true;
    if (save && !unchanged(next)) onSave(next);
    else onCancel();
  };
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      finish(false);
    }
  };

  if (column.type === 'select') {
    return (
      <select
        className="tk-table-select"
        aria-label={label}
        autoFocus
        value={draft}
        onKeyDown={onKeyDown}
        onChange={(e) => finish(true, e.target.value || null)}
        onBlur={() => finish(false)}
      >
        <option value="">(empty)</option>
        {column.options.map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  }
  if (column.type === 'multi_select') {
    return (
      <fieldset
        className="tk-table-multi"
        onKeyDown={onKeyDown}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) finish(true, picked);
        }}
      >
        <legend className="tk-visually-hidden">{label}</legend>
        {column.options.length === 0 && <span className="tk-table-hint">No choices yet. Edit the column to add some.</span>}
        {column.options.map((o, i) => (
          <label key={o}>
            <input
              type="checkbox"
              autoFocus={i === 0}
              checked={picked.includes(o)}
              onChange={(e) => setPicked((p) => (e.target.checked ? [...p, o] : p.filter((x) => x !== o)))}
            />
            <span>{o}</span>
          </label>
        ))}
        <button type="button" className="tk-btn tk-btn-quiet" onClick={() => finish(true, picked)}>
          Done
        </button>
      </fieldset>
    );
  }
  return (
    <input
      className="tk-input tk-table-input"
      aria-label={label}
      autoFocus
      type={column.type === 'number' ? 'number' : 'text'}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          finish(true, draft);
        } else onKeyDown(e);
      }}
      onBlur={() => finish(true, draft)}
    />
  );
}

/** "9 sessions of 1,214", or "7 sessions" when nothing is filtered out. */
export function tableCountText(shown: number, total: number): string {
  const noun = (n: number) => (n === 1 ? 'session' : 'sessions');
  return shown === total
    ? `${total.toLocaleString('en-US')} ${noun(total)}`
    : `${shown.toLocaleString('en-US')} ${noun(shown)} of ${total.toLocaleString('en-US')}`;
}
