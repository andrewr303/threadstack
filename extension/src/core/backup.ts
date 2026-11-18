// Whole-library backups: every table that makes up the library, written as one gzip stream of
// JSON lines, and read back into a database.
//
// Why this exists: a browser keeps an extension's data under the extension's ID. An unpacked
// extension's ID comes from its folder, so loading Threadkeeper from another folder, removing and
// adding it again, or moving to another browser starts with an empty library, and nothing in the
// old profile can be opened by the new ID. A backup file outside the browser is the one thing
// that survives all of those. The Mac helper stores these files (backup-helper.ts).
//
// What is never in a backup: saved sign-ins (accountJars and their key, which cannot leave this
// browser profile anyway), folder handles (they cannot be written to a file) and the queue of
// pending jobs.
import { Gunzip, Gzip, strToU8 } from 'fflate';
import type { Table } from 'dexie';
import type { ThreadkeeperDB } from './db.js';

export const BACKUP_FORMAT = 'threadkeeper-backup-v1';

/**
 * Merged into any library, a whole thread at a time: a thread the library already has (or has
 * deleted) is left exactly as it is, with none of the backup's rows for it; a thread it lacks is
 * added with everything that belongs to it. Rows are never mixed inside one thread, because
 * message and chunk keys are positions and two captures of one thread number them differently.
 */
const LIBRARY_TABLES = [
  'conversations',
  'messages',
  'chunks',
  'vectors',
  'summaries',
  'relationships',
  'collections',
  'tags',
  'changeLogs',
  'tombstones',
  'insights',
  'threadVectors',
  'accounts',
  'tableColumns',
  'tableCells',
] as const;

/**
 * Settings and bookkeeping that only make sense together with the library they came from.
 * Restored only into an empty library, where they replace the fresh defaults.
 */
const STATE_TABLES = ['settings', 'kv', 'dockOutbox', 'dockSent', 'dockTracked', 'dockMeta'] as const;

export const BACKUP_TABLES: readonly string[] = [...LIBRARY_TABLES, ...STATE_TABLES];

/** kv rows that must stay in the profile they were made in, or that describe work in progress. */
const KV_NEVER = new Set(['accounts.jarKey', 'accounts.switchJournal', 'analysis.importHold']);

const ROWS_PER_LINE = 200;
/** A line is cut early once it holds about this much text, so no single line grows huge. */
const LINE_SOFT_CHARS = 512 * 1024;
const PAGE_ROWS = 500;

export interface BackupMeta {
  format: typeof BACKUP_FORMAT;
  createdAt: string;
  extensionVersion: string;
  extensionId: string;
  threads: number;
  messages: number;
}

/** Tables whose rows belong to one thread (`threadKey`), restored only with their thread. */
const THREAD_CHILD_TABLES = new Set(['messages', 'chunks', 'vectors', 'summaries', 'insights', 'threadVectors', 'tableCells']);

export interface RestoreResult {
  /** Rows added, per table. */
  added: Record<string, number>;
  /** Rows left out because the library already had them, or had their thread. */
  kept: number;
  threadsAdded: number;
  /** True when settings were restored too (the library was empty). */
  settingsRestored: boolean;
  meta: BackupMeta | null;
}

export class BackupFormatError extends Error {}

// ---- Values JSON cannot carry ---------------------------------------------------------------

const TYPED: Record<string, { new (buffer: ArrayBuffer): ArrayBufferView }> = {
  Uint8Array,
  Int8Array,
  Uint8ClampedArray,
  Uint16Array,
  Int16Array,
  Uint32Array,
  Int32Array,
  Float32Array,
  Float64Array,
};

function toBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 0x8000) out += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(out);
}

function fromBase64(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

export { toBase64 as bytesToBase64, fromBase64 as base64ToBytes };

/** JSON with dates and binary values kept as tagged objects; anything else unstorable is dropped. */
export function encodeRow(row: unknown): string {
  return JSON.stringify(row, function (this: Record<string, unknown>, key, value) {
    // JSON.stringify has already turned a Date into a string here; the holder has the original.
    const original = this[key];
    if (original instanceof Date) return { $tk: 'date', v: original.toISOString() };
    if (original instanceof ArrayBuffer) return { $tk: 'ArrayBuffer', v: toBase64(new Uint8Array(original)) };
    if (ArrayBuffer.isView(original)) {
      const name = Object.prototype.toString.call(original).slice(8, -1);
      if (TYPED[name]) {
        const view = original as ArrayBufferView;
        return { $tk: name, v: toBase64(new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength))) };
      }
      return undefined;
    }
    if (typeof value === 'object' && value !== null) {
      const tag = Object.prototype.toString.call(value);
      // Keys, blobs, file handles: not representable, and nothing in a backed-up table needs them.
      if (tag !== '[object Object]' && tag !== '[object Array]') return undefined;
    }
    return value;
  });
}

export function decodeRows(line: string): unknown {
  return JSON.parse(line, (_key, value) => {
    if (value && typeof value === 'object' && typeof value.$tk === 'string' && typeof value.v === 'string') {
      if (value.$tk === 'date') return new Date(value.v);
      const bytes = fromBase64(value.v);
      const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      if (value.$tk === 'ArrayBuffer') return buffer;
      const Typed = TYPED[value.$tk];
      if (Typed) return new Typed(buffer);
    }
    return value;
  });
}

// ---- Writing --------------------------------------------------------------------------------

function keyOf(table: Table, row: unknown): unknown {
  const keyPath = table.schema.primKey.keyPath;
  return typeof keyPath === 'string' ? (row as Record<string, unknown>)[keyPath] : undefined;
}

/** A table's rows in primary-key order, a page at a time, without holding the table in memory. */
async function* pages(table: Table): AsyncGenerator<unknown[]> {
  let last: unknown;
  let first = true;
  for (;;) {
    const page: unknown[] = first
      ? await table.orderBy(':id').limit(PAGE_ROWS).toArray()
      : await table.where(':id').above(last).limit(PAGE_ROWS).toArray();
    first = false;
    if (page.length === 0) return;
    yield page;
    last = keyOf(table, page[page.length - 1]);
    if (page.length < PAGE_ROWS || last === undefined) return;
  }
}

/**
 * Write the whole library to `sink` as gzip bytes. Resolves with what the backup holds.
 * `sink` is awaited, so a slow destination holds the reading back instead of filling memory.
 */
export async function writeBackup(
  db: ThreadkeeperDB,
  sink: (bytes: Uint8Array) => Promise<void> | void,
  info: { extensionVersion: string; extensionId: string; now?: () => Date }
): Promise<BackupMeta> {
  const meta: BackupMeta = {
    format: BACKUP_FORMAT,
    createdAt: (info.now?.() ?? new Date()).toISOString(),
    extensionVersion: info.extensionVersion,
    extensionId: info.extensionId,
    threads: await db.conversations.count(),
    messages: await db.messages.count(),
  };
  let ready: Uint8Array[] = [];
  const gzip = new Gzip({ level: 6 }, (chunk) => {
    ready.push(chunk);
  });
  const flush = async () => {
    const out = ready;
    ready = [];
    for (const chunk of out) await sink(chunk);
  };
  const line = (text: string, final = false) => gzip.push(strToU8(text + '\n'), final);

  line(JSON.stringify(meta));
  const counts: Record<string, number> = {};
  for (const name of BACKUP_TABLES) {
    const table = db.table(name);
    counts[name] = 0;
    let parts: string[] = [];
    let chars = 0;
    const emit = async () => {
      if (parts.length === 0) return;
      line(`{"t":${JSON.stringify(name)},"r":[${parts.join(',')}]}`);
      counts[name] += parts.length;
      parts = [];
      chars = 0;
      await flush();
    };
    for await (const page of pages(table)) {
      for (const row of page) {
        if (name === 'kv' && KV_NEVER.has(String((row as { key?: unknown }).key))) continue;
        const text = encodeRow(row);
        parts.push(text);
        chars += text.length;
        if (parts.length >= ROWS_PER_LINE || chars >= LINE_SOFT_CHARS) await emit();
      }
    }
    await emit();
  }
  // The last line proves the file is whole: a backup cut short has no `end`.
  line(JSON.stringify({ end: true, counts }), true);
  await flush();
  return meta;
}

// ---- Reading --------------------------------------------------------------------------------

interface RestoreState {
  /** Threads of the backup that are not restored: the library has them, or deleted them. */
  skipThreads: Set<string>;
  /** Threads deleted in this library before the restore began. */
  deletedHere: Set<string>;
  meta: BackupMeta | null;
  ended: boolean;
  emptyLibrary: boolean;
  result: RestoreResult;
}

async function applyLine(db: ThreadkeeperDB, text: string, state: RestoreState): Promise<void> {
  let parsed: unknown;
  try {
    parsed = decodeRows(text);
  } catch {
    throw new BackupFormatError('That file is not a Threadkeeper backup, or it is damaged.');
  }
  const obj = parsed as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object') throw new BackupFormatError('That file is not a Threadkeeper backup, or it is damaged.');
  if (!state.meta) {
    if (obj.format !== BACKUP_FORMAT) throw new BackupFormatError('That file is not a Threadkeeper backup.');
    state.meta = obj as unknown as BackupMeta;
    state.result.meta = state.meta;
    return;
  }
  if (obj.end === true) {
    state.ended = true;
    return;
  }
  const name = obj.t;
  const rows = obj.r;
  // A table this version does not know (a newer backup) is skipped, not an error.
  if (typeof name !== 'string' || !Array.isArray(rows) || !BACKUP_TABLES.includes(name)) return;
  const isState = (STATE_TABLES as readonly string[]).includes(name);
  if (isState && !state.emptyLibrary) return;
  const table = db.table(name);
  const keyed = rows.filter((row) => {
    const key = keyOf(table, row);
    if (typeof key !== 'string' || key.length === 0) return false;
    return !(name === 'kv' && KV_NEVER.has(key));
  }) as Record<string, unknown>[];
  let usable = keyed;
  if (name === 'conversations') {
    // A thread deleted here stays deleted.
    usable = keyed.filter((row) => {
      if (!state.deletedHere.has(String(row.threadKey))) return true;
      state.skipThreads.add(String(row.threadKey));
      return false;
    });
  } else if (THREAD_CHILD_TABLES.has(name)) {
    usable = keyed.filter((row) => !state.skipThreads.has(String(row.threadKey)));
  } else if (name === 'tombstones') {
    // A deletion recorded in the backup does not apply to a thread that is in the library now.
    const live = await db.conversations.bulkGet(keyed.map((row) => String(row.threadKey)));
    usable = keyed.filter((_row, i) => live[i] === undefined);
  }
  state.result.kept += keyed.length - usable.length;
  if (usable.length === 0) return;
  if (name === 'accounts') {
    // Saved sign-ins are not in a backup, so no restored account has one.
    for (const row of usable) row.hasJar = false;
  }
  if (isState) {
    await table.bulkPut(usable);
    state.result.added[name] = (state.result.added[name] ?? 0) + usable.length;
    if (name === 'settings') state.result.settingsRestored = true;
    return;
  }
  await db.transaction('rw', table, async () => {
    const existing = await table.bulkGet(usable.map((row) => keyOf(table, row) as string));
    const missing = usable.filter((_row, i) => existing[i] === undefined);
    state.result.kept += usable.length - missing.length;
    if (name === 'conversations') {
      usable.forEach((row, i) => {
        if (existing[i] !== undefined) state.skipThreads.add(String(row.threadKey));
      });
    }
    if (missing.length === 0) return;
    await table.bulkAdd(missing);
    state.result.added[name] = (state.result.added[name] ?? 0) + missing.length;
    if (name === 'conversations') state.result.threadsAdded += missing.length;
  });
}

/**
 * Read a backup into `db`. Nothing already in the library is changed or removed: threads the
 * library has (or deleted) are left alone, threads it lacks are added whole. Settings come back
 * only when the library was empty. A file that ends early still restores what came before the
 * cut, then throws.
 */
export async function restoreBackup(db: ThreadkeeperDB, source: AsyncIterable<Uint8Array>): Promise<RestoreResult> {
  const state: RestoreState = {
    skipThreads: new Set(),
    deletedHere: new Set((await db.tombstones.toCollection().primaryKeys()) as string[]),
    meta: null,
    ended: false,
    emptyLibrary: (await db.conversations.count()) === 0,
    result: { added: {}, kept: 0, threadsAdded: 0, settingsRestored: false, meta: null },
  };
  let pending: Uint8Array[] = [];
  const gunzip = new Gunzip((chunk) => {
    pending.push(chunk);
  });
  let carry = '';
  const decoder = new TextDecoder();
  const drain = async (final: boolean) => {
    const chunks = pending;
    pending = [];
    for (const chunk of chunks) carry += decoder.decode(chunk, { stream: true });
    if (final) carry += decoder.decode();
    let at: number;
    while ((at = carry.indexOf('\n')) >= 0) {
      const text = carry.slice(0, at);
      carry = carry.slice(at + 1);
      if (text) await applyLine(db, text, state);
    }
  };
  // Only the decompressor's own errors (not gzip, cut short) mean a bad file. An error from the
  // source (the helper went away) is passed on as it is.
  const inflate = (bytes: Uint8Array, final: boolean) => {
    try {
      gunzip.push(bytes, final);
    } catch {
      throw new BackupFormatError(
        state.meta ? 'That backup is incomplete. What could be read was restored.' : 'That file is not a Threadkeeper backup, or it is damaged.'
      );
    }
  };
  let any = false;
  for await (const bytes of source) {
    if (bytes.length === 0) continue;
    any = true;
    inflate(bytes, false);
    await drain(false);
  }
  if (any) inflate(new Uint8Array(0), true);
  await drain(true);
  if (!state.meta) throw new BackupFormatError('That file is not a Threadkeeper backup.');
  if (!state.ended) throw new BackupFormatError('That backup is incomplete. What could be read was restored.');
  return state.result;
}

/** A cheap value that changes when the library does; used to skip backups of an unchanged library. */
export async function libraryFingerprint(db: ThreadkeeperDB): Promise<{ threads: number; fingerprint: string }> {
  // Counts of what capture and organizing add to: threads, messages, summaries, insights, the
  // change log (every manual or automatic filing, tag and rename) and deletions.
  const [threads, messages, newest, summaries, insights, changes, deleted] = await Promise.all([
    db.conversations.count(),
    db.messages.count(),
    db.conversations.orderBy('updatedAt').last(),
    db.summaries.count(),
    db.insights.count(),
    db.changeLogs.count(),
    db.tombstones.count(),
  ]);
  return { threads, fingerprint: `${threads}:${messages}:${String(newest?.updatedAt ?? '')}:${summaries}:${insights}:${changes}:${deleted}` };
}
