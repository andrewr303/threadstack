// The Table view's data: built-in columns read from each thread, columns the person adds, and the
// value every thread has in them. One rule runs through all of it: a value the person set by hand
// is theirs. Claude may fill empty cells and replace its own earlier values, never a manual one.
import type { ThreadStackDB } from './db.js';
import { providerCategory, providerLabel, type ProviderCategory } from './providers.js';
import { threadRepository } from './repository.js';
import {
  TABLE_COLUMN_TYPES,
  THREAD_KIND_LABELS,
  getDisplayTitle,
  tableCellKey,
  type ConversationRecord,
  type TableCellRecord,
  type TableCellValue,
  type TableColumnRecord,
  type TableColumnType,
  type TableSort,
  type ThreadInsight,
  type WorkflowState,
} from './schema.js';

export { tableCellKey };

// ---------------------------------------------------------------------------------------------
// Built-in columns
// ---------------------------------------------------------------------------------------------

export const BUILTIN_COLUMN_IDS = [
  'title',
  'type',
  'provider',
  'created',
  'updated',
  'status',
  'project',
  'topics',
  'kind',
  'messages',
  'repository',
  'account',
] as const;
export type BuiltinColumnId = (typeof BUILTIN_COLUMN_IDS)[number];

export function isBuiltinColumnId(id: string): id is BuiltinColumnId {
  return (BUILTIN_COLUMN_IDS as readonly string[]).includes(id);
}

export const BUILTIN_COLUMNS: Record<BuiltinColumnId, { label: string; description: string }> = {
  title: { label: 'Title', description: 'The thread’s title (your rename when you made one).' },
  type: { label: 'Type', description: 'What kind of product the thread is from: coding agent, chat, agent and so on.' },
  provider: { label: 'Provider', description: 'Where the thread lives: Claude, ChatGPT, Claude Code, Codex…' },
  created: { label: 'Created', description: 'When the conversation started.' },
  updated: { label: 'Last active', description: 'The newest activity ThreadStack has seen.' },
  status: { label: 'Status', description: 'Active, needs review, waiting, paused, done or archived. Editable.' },
  project: { label: 'Project', description: 'The project the thread is filed in. Editable.' },
  topics: { label: 'Topics', description: 'Topics from the thread’s analysis.' },
  kind: { label: 'Work type', description: 'What the work was: building, debugging, writing, research…' },
  messages: { label: 'Messages', description: 'How many messages the thread has.' },
  repository: { label: 'Repository', description: 'The repository a coding session worked in.' },
  account: { label: 'Account', description: 'The account the thread was captured under.' },
};

/** Singular names for each kind of product, as a table cell shows them. */
export const THREAD_TYPE_LABELS: Record<ProviderCategory, string> = {
  coding_agent: 'Coding agent',
  chat: 'Chat',
  agent: 'Agent',
  builder: 'App builder',
  search: 'Search',
  companion: 'Companion',
};

export const TABLE_WORKFLOW_ORDER: readonly WorkflowState[] = ['active', 'needs_review', 'waiting', 'paused', 'done', 'archived'];

/** One thread as the table sees it. `accountLabel` comes from the workspace's accounts. */
export interface TableRow {
  conv: ConversationRecord;
  insight: ThreadInsight | null;
  accountLabel?: string | null;
}

export function threadTypeLabel(conv: Pick<ConversationRecord, 'provider'>): string {
  return THREAD_TYPE_LABELS[providerCategory(conv.provider)];
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 17, 2026" in the viewer's time zone; '' for a missing or unreadable date. */
export function formatTableDate(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

export function createdAtOf(conv: ConversationRecord): string | null {
  return conv.createdAt ?? conv.updatedAt ?? conv.lastCapturedAt ?? null;
}

export function lastActiveAtOf(conv: ConversationRecord): string | null {
  return conv.updatedAt ?? conv.lastCapturedAt ?? conv.createdAt ?? null;
}

const WORKFLOW_TEXT: Record<WorkflowState, string> = {
  active: 'Active',
  needs_review: 'Needs review',
  waiting: 'Waiting',
  paused: 'Paused',
  done: 'Done',
  archived: 'Archived',
};

/** What a built-in cell shows, as plain text (also what search matches). */
export function builtinCellText(id: BuiltinColumnId, row: TableRow): string {
  const { conv, insight } = row;
  switch (id) {
    case 'title':
      return getDisplayTitle(conv) || insight?.title || 'Untitled';
    case 'type':
      return threadTypeLabel(conv);
    case 'provider':
      return providerLabel(conv.provider);
    case 'created':
      return formatTableDate(createdAtOf(conv));
    case 'updated':
      return formatTableDate(lastActiveAtOf(conv));
    case 'status':
      return WORKFLOW_TEXT[conv.workflowState] ?? conv.workflowState;
    case 'project':
      return conv.project;
    case 'topics':
      return (insight?.topics ?? []).slice(0, 6).join(', ');
    case 'kind':
      return insight ? THREAD_KIND_LABELS[insight.kind] : '';
    case 'messages':
      return String(conv.messageCount ?? 0);
    case 'repository':
      return threadRepository(conv, (provider) => providerCategory(provider) === 'coding_agent') ?? '';
    case 'account':
      return row.accountLabel ?? '';
  }
}

/** Sort key of a built-in cell; null sorts last whichever way the column is ordered. */
function builtinSortValue(id: BuiltinColumnId, row: TableRow): string | number | null {
  const { conv } = row;
  switch (id) {
    case 'created': {
      const t = Date.parse(createdAtOf(conv) ?? '');
      return Number.isFinite(t) ? t : null;
    }
    case 'updated': {
      const t = Date.parse(lastActiveAtOf(conv) ?? '');
      return Number.isFinite(t) ? t : null;
    }
    case 'status': {
      const i = TABLE_WORKFLOW_ORDER.indexOf(conv.workflowState);
      return i < 0 ? null : i;
    }
    case 'messages':
      return conv.messageCount ?? 0;
    default: {
      const text = builtinCellText(id, row).trim().toLowerCase();
      return text ? text : null;
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Stored columns: validation
// ---------------------------------------------------------------------------------------------

export const TABLE_COLUMN_TYPE_LABELS: Record<TableColumnType, string> = {
  text: 'Text',
  number: 'Number',
  checkbox: 'Checkbox',
  select: 'Single choice',
  multi_select: 'Multiple choice',
};

export const MAX_TABLE_COLUMNS = 40;
export const MAX_COLUMN_OPTIONS = 40;
export const MAX_COLUMN_NAME = 60;
export const MAX_OPTION_LENGTH = 60;
export const MAX_INSTRUCTIONS = 600;
export const MAX_TEXT_VALUE = 500;

export function isChoiceType(type: TableColumnType): type is 'select' | 'multi_select' {
  return type === 'select' || type === 'multi_select';
}

/** What a person (or Claude's proposal) supplies to define a column. */
export interface TableColumnDraft {
  name: string;
  type: TableColumnType;
  options?: string[];
  instructions?: string;
}

export class TableColumnError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TableColumnError';
  }
}

const clean = (text: string) => text.replace(/\s+/g, ' ').trim();

/** Trimmed, de-duplicated (ignoring case) options, at most MAX_COLUMN_OPTIONS of them. */
export function normalizeOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    const option = clean(item).slice(0, MAX_OPTION_LENGTH);
    if (!option || seen.has(option.toLowerCase())) continue;
    seen.add(option.toLowerCase());
    out.push(option);
    if (out.length >= MAX_COLUMN_OPTIONS) break;
  }
  return out;
}

/**
 * A draft made safe, or a TableColumnError saying what is wrong. `taken` holds the names already
 * in use (built-in labels are always taken), compared without case.
 */
export function normalizeColumnDraft(draft: unknown, taken: Iterable<string> = []): Required<TableColumnDraft> {
  const d = draft && typeof draft === 'object' ? (draft as Partial<Record<keyof TableColumnDraft, unknown>>) : {};
  const name = typeof d.name === 'string' ? clean(d.name).slice(0, MAX_COLUMN_NAME) : '';
  if (!name) throw new TableColumnError('Give the column a name.');
  const used = new Set([...Object.values(BUILTIN_COLUMNS).map((c) => c.label.toLowerCase()), ...[...taken].map((n) => n.toLowerCase())]);
  if (used.has(name.toLowerCase())) throw new TableColumnError(`There is already a column called “${name}”.`);
  if (!TABLE_COLUMN_TYPES.includes(d.type as TableColumnType)) throw new TableColumnError('Choose what kind of values the column holds.');
  const type = d.type as TableColumnType;
  const options = isChoiceType(type) ? normalizeOptions(d.options) : [];
  const instructions = typeof d.instructions === 'string' ? d.instructions.trim().slice(0, MAX_INSTRUCTIONS) : '';
  return { name, type, options, instructions };
}

export type CoerceResult = { ok: true; value: TableCellValue | null; newOptions: string[] } | { ok: false; reason: string };

/**
 * Check a value against its column. `null`, '' and [] mean "empty". Choices are matched without
 * case and stored as the column spells them. With `allowNewOptions` (a choice column Claude is
 * defining as it goes) an unknown choice is accepted and returned in `newOptions`.
 */
export function coerceCellValue(
  column: Pick<TableColumnRecord, 'type' | 'options'>,
  raw: unknown,
  { allowNewOptions = false }: { allowNewOptions?: boolean } = {}
): CoerceResult {
  if (raw === null || raw === undefined) return { ok: true, value: null, newOptions: [] };
  const known = new Map(column.options.map((o) => [o.toLowerCase(), o]));
  const newOptions: string[] = [];
  const choice = (item: unknown): string | null | false => {
    if (typeof item !== 'string') return false;
    const text = clean(item).slice(0, MAX_OPTION_LENGTH);
    if (!text) return null;
    const found = known.get(text.toLowerCase());
    if (found) return found;
    if (!allowNewOptions || known.size >= MAX_COLUMN_OPTIONS) return false;
    known.set(text.toLowerCase(), text);
    newOptions.push(text);
    return text;
  };
  switch (column.type) {
    case 'text': {
      if (typeof raw !== 'string') return { ok: false, reason: 'Expected text.' };
      const text = raw.trim().slice(0, MAX_TEXT_VALUE);
      return { ok: true, value: text || null, newOptions };
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
      if (typeof raw === 'string' && raw.trim() === '') return { ok: true, value: null, newOptions };
      return Number.isFinite(n) ? { ok: true, value: n, newOptions } : { ok: false, reason: 'Expected a number.' };
    }
    case 'checkbox':
      return typeof raw === 'boolean' ? { ok: true, value: raw, newOptions } : { ok: false, reason: 'Expected yes or no.' };
    case 'select': {
      const picked = choice(raw);
      if (picked === false) return { ok: false, reason: 'Not one of the column’s choices.' };
      return { ok: true, value: picked, newOptions };
    }
    case 'multi_select': {
      if (!Array.isArray(raw)) return { ok: false, reason: 'Expected a list of choices.' };
      const out: string[] = [];
      for (const item of raw) {
        const picked = choice(item);
        if (picked === false) return { ok: false, reason: 'Not one of the column’s choices.' };
        if (picked && !out.includes(picked)) out.push(picked);
      }
      // Keep the column's order so equal sets look alike.
      const order = new Map([...known.values()].map((o, i) => [o, i]));
      out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
      return { ok: true, value: out.length ? out : null, newOptions };
    }
  }
}

/** A stored value as text: choices joined with commas, checkboxes as Yes / No. */
export function cellValueText(value: TableCellValue | null | undefined): string {
  if (value === null || value === undefined) return '';
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

// ---------------------------------------------------------------------------------------------
// Sorting and search
// ---------------------------------------------------------------------------------------------

/** Cells of one row, by column id. */
export type RowCells = ReadonlyMap<string, TableCellRecord>;

function storedSortValue(column: TableColumnRecord, cell: TableCellRecord | undefined): string | number | null {
  if (!cell) return null;
  const v = cell.value;
  switch (column.type) {
    case 'number':
      return typeof v === 'number' ? v : null;
    case 'checkbox':
      return v === true ? 1 : v === false ? 0 : null;
    case 'select': {
      const i = typeof v === 'string' ? column.options.indexOf(v) : -1;
      return i >= 0 ? i : typeof v === 'string' ? v.toLowerCase() : null;
    }
    default: {
      const text = cellValueText(v).toLowerCase();
      return text || null;
    }
  }
}

/**
 * Rows ordered by one column. Empty values go last in both directions; ties keep the most
 * recently active thread first so the order is stable.
 */
export function sortTableRows<T extends TableRow>(
  rows: readonly T[],
  sort: TableSort | null,
  columns: ReadonlyMap<string, TableColumnRecord>,
  cellsOf: (threadKey: string) => RowCells | undefined
): T[] {
  const recent = (row: TableRow) => Date.parse(lastActiveAtOf(row.conv) ?? '') || 0;
  if (!sort) return [...rows].sort((a, b) => recent(b) - recent(a));
  const column = columns.get(sort.column);
  const keyOf = (row: T): string | number | null =>
    isBuiltinColumnId(sort.column)
      ? builtinSortValue(sort.column, row)
      : column
        ? storedSortValue(column, cellsOf(row.conv.threadKey)?.get(column.id))
        : null;
  const keyed = rows.map((row) => ({ row, key: keyOf(row), recent: recent(row) }));
  const dir = sort.direction === 'asc' ? 1 : -1;
  keyed.sort((a, b) => {
    if (a.key === null && b.key === null) return b.recent - a.recent;
    if (a.key === null) return 1;
    if (b.key === null) return -1;
    let c: number;
    if (typeof a.key === 'number' && typeof b.key === 'number') c = a.key - b.key;
    else if (typeof a.key === 'number') c = -1;
    else if (typeof b.key === 'number') c = 1;
    else c = a.key.localeCompare(b.key);
    if (c !== 0) return c * dir;
    // Ties: most recently active first, then by thread key, so equal rows never trade places.
    return b.recent - a.recent || (a.row.conv.threadKey < b.row.conv.threadKey ? -1 : a.row.conv.threadKey > b.row.conv.threadKey ? 1 : 0);
  });
  return keyed.map((k) => k.row);
}

/**
 * The providers the Table's provider switch offers: the ones the library holds, most threads
 * first (ties by name), at most `max`. The switch adds "All" in front; a provider past the cut is
 * still found by typing its name in the table search.
 */
export function tableProviderOptions(
  conversations: ReadonlyArray<Pick<ConversationRecord, 'provider' | 'isSyntheticBenchmark'>>,
  labelOf: (provider: string) => string,
  max = 4
): Array<{ provider: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const c of conversations) {
    if (c.isSyntheticBenchmark) continue;
    counts.set(c.provider, (counts.get(c.provider) ?? 0) + 1);
  }
  return [...counts]
    .map(([provider, count]) => ({ provider, label: labelOf(provider), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, Math.max(0, max));
}

/** Every word of the query appears somewhere in the row: its built-in cells, gist or stored values. */
export function rowMatchesQuery(row: TableRow, query: string, cells: RowCells | undefined): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const parts = BUILTIN_COLUMN_IDS.map((id) => builtinCellText(id, row));
  if (row.insight) parts.push(row.insight.gist, row.insight.topics.join(' '));
  for (const cell of cells?.values() ?? []) parts.push(cellValueText(cell.value));
  const haystack = parts.join(' \u0000 ').toLowerCase();
  return words.every((w) => haystack.includes(w));
}

// ---------------------------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------------------------

function newColumnId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return `col_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

export async function listTableColumns(db: ThreadStackDB): Promise<TableColumnRecord[]> {
  const columns = await db.tableColumns.toArray();
  return columns.sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
}

export async function createTableColumn(
  db: ThreadStackDB,
  draft: TableColumnDraft,
  createdBy: TableColumnRecord['createdBy'] = 'user'
): Promise<TableColumnRecord> {
  return db.transaction('rw', db.tableColumns, async () => {
    const existing = await db.tableColumns.toArray();
    if (existing.length >= MAX_TABLE_COLUMNS) throw new TableColumnError(`A table can have up to ${MAX_TABLE_COLUMNS} columns of your own.`);
    const valid = normalizeColumnDraft(draft, existing.map((c) => c.name));
    const now = new Date().toISOString();
    // Distinct creation times keep the column order stable when several are added at once.
    const last = existing.reduce((max, c) => (c.createdAt > max ? c.createdAt : max), '');
    const createdAt = now > last ? now : new Date(Date.parse(last) + 1).toISOString();
    const column: TableColumnRecord = { id: newColumnId(), ...valid, createdAt, updatedAt: now, createdBy };
    await db.tableColumns.add(column);
    return column;
  });
}

/**
 * Rename a column, change its choices or its instructions (its type never changes). Values that
 * use a removed choice lose it; a cell left with nothing is emptied. Returns how many cells changed.
 */
export async function updateTableColumn(
  db: ThreadStackDB,
  id: string,
  patch: { name?: string; options?: string[]; instructions?: string }
): Promise<{ column: TableColumnRecord; changedCells: number }> {
  return db.transaction('rw', db.tableColumns, db.tableCells, async () => {
    const current = await db.tableColumns.get(id);
    if (!current) throw new TableColumnError('That column no longer exists.');
    const others = (await db.tableColumns.toArray()).filter((c) => c.id !== id).map((c) => c.name);
    const valid = normalizeColumnDraft(
      {
        name: patch.name ?? current.name,
        type: current.type,
        options: patch.options ?? current.options,
        instructions: patch.instructions ?? current.instructions,
      },
      others
    );
    const column: TableColumnRecord = { ...current, ...valid, updatedAt: new Date().toISOString() };
    await db.tableColumns.put(column);
    let changedCells = 0;
    if (isChoiceType(column.type)) {
      const cells = await db.tableCells.where('columnId').equals(id).toArray();
      for (const cell of cells) {
        const next = coerceCellValue(column, cell.value);
        if (next.ok && JSON.stringify(next.value) === JSON.stringify(cell.value)) continue;
        changedCells += 1;
        if (next.ok && next.value !== null) await db.tableCells.put({ ...cell, value: next.value });
        else if (Array.isArray(cell.value)) {
          // Keep the choices that still exist.
          const kept = cell.value.filter((v) => column.options.includes(v));
          if (kept.length) await db.tableCells.put({ ...cell, value: kept });
          else await db.tableCells.delete(cell.cellKey);
        } else await db.tableCells.delete(cell.cellKey);
      }
    }
    return { column, changedCells };
  });
}

export async function deleteTableColumn(db: ThreadStackDB, id: string): Promise<void> {
  await db.transaction('rw', db.tableColumns, db.tableCells, async () => {
    await db.tableCells.where('columnId').equals(id).delete();
    await db.tableColumns.delete(id);
  });
}

export async function listTableCells(db: ThreadStackDB): Promise<TableCellRecord[]> {
  return db.tableCells.toArray();
}

/** Cells grouped by thread, then column. */
export function indexCells(cells: readonly TableCellRecord[]): Map<string, Map<string, TableCellRecord>> {
  const byThread = new Map<string, Map<string, TableCellRecord>>();
  for (const cell of cells) {
    const row = byThread.get(cell.threadKey) ?? new Map<string, TableCellRecord>();
    row.set(cell.columnId, cell);
    byThread.set(cell.threadKey, row);
  }
  return byThread;
}

/**
 * The person sets (or clears) one cell. The value becomes theirs, so Claude will not replace it.
 * Clearing removes the cell, which Claude may fill again on a later run. Returns the stored cell,
 * or null when the cell is now empty.
 */
export async function setManualCell(
  db: ThreadStackDB,
  columnId: string,
  threadKey: string,
  raw: unknown
): Promise<TableCellRecord | null> {
  return db.transaction('rw', [db.tableColumns, db.tableCells, db.conversations], async () => {
    const column = await db.tableColumns.get(columnId);
    if (!column) throw new TableColumnError('That column no longer exists.');
    const conv = await db.conversations.get(threadKey);
    if (!conv) throw new TableColumnError('That thread is no longer in the library.');
    const result = coerceCellValue(column, raw);
    if (!result.ok) throw new TableColumnError(result.reason);
    const cellKey = tableCellKey(columnId, threadKey);
    if (result.value === null) {
      await db.tableCells.delete(cellKey);
      return null;
    }
    const cell: TableCellRecord = {
      cellKey,
      columnId,
      threadKey,
      value: result.value,
      source: 'manual',
      reason: null,
      model: null,
      sourceRevision: conv.sourceRevision,
      updatedAt: new Date().toISOString(),
    };
    await db.tableCells.put(cell);
    return cell;
  });
}

/** Remove every value Claude wrote in a column; the person's own values stay. Returns the count. */
export async function clearAiCells(db: ThreadStackDB, columnId: string): Promise<number> {
  return db.transaction('rw', db.tableCells, async () => {
    const ai = (await db.tableCells.where('columnId').equals(columnId).toArray()).filter((c) => c.source === 'ai');
    await db.tableCells.bulkDelete(ai.map((c) => c.cellKey));
    return ai.length;
  });
}

export interface AiCellWrite {
  threadKey: string;
  value: TableCellValue | null;
  reason: string;
}

/**
 * Write Claude's values for one column. Read fresh inside the transaction: a cell the person set
 * while Claude was working is kept, and so is any thread deleted meanwhile. `null` values leave
 * the cell as it is (Claude found nothing to go on). Choices new to the column are added to it.
 */
export async function applyAiCells(
  db: ThreadStackDB,
  columnId: string,
  writes: readonly AiCellWrite[],
  { model, newOptions = [] }: { model: string; newOptions?: readonly string[] }
): Promise<{ written: number; keptManual: number }> {
  return db.transaction('rw', [db.tableColumns, db.tableCells, db.conversations], async () => {
    let column = await db.tableColumns.get(columnId);
    if (!column) throw new TableColumnError('That column no longer exists.');
    if (newOptions.length && isChoiceType(column.type)) {
      const options = normalizeOptions([...column.options, ...newOptions]);
      if (options.length !== column.options.length) {
        column = { ...column, options, updatedAt: new Date().toISOString() };
        await db.tableColumns.put(column);
      }
    }
    let written = 0;
    let keptManual = 0;
    const now = new Date().toISOString();
    for (const w of writes) {
      if (w.value === null) continue;
      const checked = coerceCellValue(column, w.value);
      if (!checked.ok || checked.value === null) continue;
      const cellKey = tableCellKey(columnId, w.threadKey);
      const existing = await db.tableCells.get(cellKey);
      if (existing?.source === 'manual') {
        keptManual += 1;
        continue;
      }
      const conv = await db.conversations.get(w.threadKey);
      if (!conv) continue;
      await db.tableCells.put({
        cellKey,
        columnId,
        threadKey: w.threadKey,
        value: checked.value,
        source: 'ai',
        reason: w.reason.trim().slice(0, 240) || null,
        model,
        sourceRevision: conv.sourceRevision,
        updatedAt: now,
      });
      written += 1;
    }
    return { written, keptManual };
  });
}
