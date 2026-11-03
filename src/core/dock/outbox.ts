// Durable delivery to Still: a coalescing outbox (one row per thread), a sent ledger per peer and
// epoch, tracked threads, a reconcile pass that catches every write path, and the drain that
// pushes batches one at a time. Never uses the `jobs` table (processResumableJobs would swallow it).

import type { ThreadkeeperDB } from '../db.js';
import { insightKeyFor, type ConversationRecord, type SettingsRecord, type SidebarDockSettings } from '../schema.js';
import { isRemoteAllowed, localOnlyProjectNames } from '../privacy.js';
import { buildThreadPayload, cheapDigestOf, isShareable, loadThreadRecords } from './payload.js';
import { allocateSeq, getMeta, prefsHashOf, setMeta, transcriptsShared } from './state.js';
import {
  RESPONSE_BUDGET_BYTES,
  TRANSCRIPT_MAX_TOTAL_CHARS,
  jsonByteLength,
  readRemoveResults,
  readUpsertResults,
  type OutboundType,
  type SendResult,
  type SyncPrefs,
  type ThreadPayload,
} from './protocol.js';
import type { DockOutboxRecord, DockSentRecord, DockTrackedRecord } from './records.js';

export type DockSend = (
  type: OutboundType,
  fields: Record<string, unknown>,
  options?: { timeoutMs?: number }
) => Promise<SendResult<Record<string, unknown>>>;

export type RemoveReason = 'deleted' | 'local_only' | 'out_of_scope';

const BACKOFF_MINUTES = [1, 5, 30, 120];
const LOCAL_ONLY_RETRY_MS = 60_000;
const LEASE_MS = 2 * 60_000;
const MAX_PUSH_THREADS = 20;
const MAX_REMOVE_THREADS = 200;
const RECONCILE_MIN_INTERVAL_MS = 10 * 60_000;
const RECONCILE_PAGE = 200;

const REMOVE_RANK: Record<RemoveReason, number> = { out_of_scope: 1, deleted: 2, local_only: 3 };

const isoAt = (ms: number) => new Date(ms).toISOString();

/** Seconds a thread must be quiet before its push (protocol pacing: max(60 s, AI debounce)). */
export function pushDebounceMs(settings: SettingsRecord): number {
  return Math.max(60, settings.autoOrganize?.aiDebounceSeconds ?? 90) * 1000;
}

export function inScope(conv: Pick<ConversationRecord, 'provider' | 'project'>, prefs: SyncPrefs): boolean {
  if (prefs.providers.length > 0 && !prefs.providers.includes(conv.provider)) return false;
  if (prefs.scope === 'all') return true;
  if (prefs.scope === 'projects') {
    const project = conv.project.trim().toLowerCase();
    return prefs.projects.some((p) => p.trim().toLowerCase() === project);
  }
  return false;
}

/** The ledger row, if it belongs to the current peer and epoch. */
export function ledgerFor(row: DockSentRecord | undefined, dock: SidebarDockSettings): DockSentRecord | undefined {
  return row && row.peerId === dock.pairedId && row.epoch === dock.peerEpoch ? row : undefined;
}

export interface MarkOptions {
  now?: number;
  /** Send as soon as possible (manual sends, reconcile catch-up, privacy removals). */
  immediate?: boolean;
  /** Debounce in ms when not immediate. */
  debounceMs?: number;
  remove?: RemoveReason;
  manual?: boolean;
  target?: DockOutboxRecord['target'];
}

/**
 * Mark threads for (re)evaluation. Coalesces into one row per thread and bumps its dirtySeq without
 * touching a lease. A remove is never downgraded to an upsert; a stronger remove reason wins.
 */
export async function markDockDirty(db: ThreadkeeperDB, threadKeys: readonly string[], options: MarkOptions = {}): Promise<number> {
  const keys = Array.from(new Set(threadKeys.filter((k) => typeof k === 'string' && k)));
  if (keys.length === 0) return 0;
  const now = options.now ?? Date.now();
  const due = options.immediate ? now : now + (options.debounceMs ?? 90_000);
  await db.transaction('rw', db.dockOutbox, async () => {
    const existing = await db.dockOutbox.bulkGet(keys);
    const rows: DockOutboxRecord[] = keys.map((threadKey, i) => {
      const prev = existing[i];
      let op: DockOutboxRecord['op'] = prev?.op ?? 'upsert';
      let reason = prev?.reason;
      if (options.remove) {
        if (op !== 'remove' || !reason || REMOVE_RANK[options.remove] >= REMOVE_RANK[reason]) reason = options.remove;
        op = 'remove';
      }
      const backoffUntil = prev && prev.attempts > 0 ? Date.parse(prev.notBefore) : 0;
      const prevDue = prev ? Date.parse(prev.notBefore) : Number.POSITIVE_INFINITY;
      let notBefore = options.immediate ? Math.min(due, Number.isFinite(prevDue) ? prevDue : due) : Math.max(due, backoffUntil || 0);
      // A debounced mark never delays a row that is already due sooner because it is manual or a removal.
      if (!options.immediate && prev && (prev.manual || prev.op === 'remove') && Number.isFinite(prevDue)) notBefore = Math.min(notBefore, prevDue);
      if (options.immediate && op === 'remove' && reason === 'local_only') notBefore = now;
      return {
        threadKey,
        op,
        ...(reason && op === 'remove' ? { reason } : {}),
        manual: Boolean(prev?.manual || options.manual),
        target: options.manual ? options.target ?? null : prev?.target ?? null,
        wantTranscript: prev?.wantTranscript ?? false,
        noTranscript: prev?.noTranscript ?? false,
        notBefore: isoAt(notBefore),
        attempts: options.immediate ? 0 : prev?.attempts ?? 0,
        lastError: prev?.lastError ?? '',
        leaseUntil: prev?.leaseUntil ?? '',
        dirtySeq: (prev?.dirtySeq ?? 0) + 1,
        updatedAt: isoAt(now),
      };
    });
    await db.dockOutbox.bulkPut(rows);
  });
  return keys.length;
}

/** Forget everything sent to a peer: outbox, ledger and tracked threads (unpair). */
export async function clearDockLink(db: ThreadkeeperDB): Promise<void> {
  await db.transaction('rw', [db.dockOutbox, db.dockSent, db.dockTracked, db.dockMeta], async () => {
    await db.dockOutbox.clear();
    await db.dockSent.clear();
    await db.dockTracked.clear();
    await db.dockMeta.bulkDelete(['reconcile.cursor', 'reconcile.lastAt', 'notPairedAt']);
  });
}

/** A new epoch: Still's copy may differ from the ledger, so the ledger is discarded. */
export async function resetLedger(db: ThreadkeeperDB): Promise<void> {
  await db.transaction('rw', [db.dockSent, db.dockMeta], async () => {
    await db.dockSent.clear();
    await db.dockMeta.bulkDelete(['reconcile.cursor', 'reconcile.lastAt']);
  });
}

export async function trackThreads(db: ThreadkeeperDB, threadKeys: readonly string[], now = Date.now()): Promise<void> {
  if (threadKeys.length === 0) return;
  await db.dockTracked.bulkPut(threadKeys.map((threadKey) => ({ threadKey, trackedAt: isoAt(now), dismissed: false })));
}

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

export interface ReconcileResult {
  ran: boolean;
  done: boolean;
  queued: number;
}

/**
 * Compare every conversation with the ledger and queue what differs: new or changed in-scope and
 * tracked threads, removals for threads that became private, were deleted or left the scope.
 * Runs in pages with a persisted cursor and a time budget; skipped when the last full pass ended
 * less than 10 minutes ago unless forced.
 */
export async function reconcileDock(
  db: ThreadkeeperDB,
  settings: SettingsRecord,
  options: { force?: boolean; now?: () => number; budgetMs?: number } = {}
): Promise<ReconcileResult> {
  const now = options.now ?? Date.now;
  const dock = settings.sidebarDock;
  if (!dock.pairedId || !dock.configured) return { ran: false, done: true, queued: 0 };
  const lastAt = await getMeta<number>(db, 'reconcile.lastAt', 0);
  let cursor = await getMeta<string>(db, 'reconcile.cursor', '');
  if (!options.force && !cursor && now() - lastAt < RECONCILE_MIN_INTERVAL_MS) return { ran: false, done: true, queued: 0 };
  if (options.force) cursor = '';
  const started = now();
  const budget = options.budgetMs ?? 2000;
  const localOnly = await localOnlyProjectNames(db);
  const tombstoned = new Set((await db.tombstones.toCollection().primaryKeys()) as string[]);
  const prefsHash = prefsHashOf(dock);
  let queued = 0;

  for (;;) {
    const page = cursor
      ? await db.conversations.where('threadKey').above(cursor).limit(RECONCILE_PAGE).toArray()
      : await db.conversations.orderBy('threadKey').limit(RECONCILE_PAGE).toArray();
    if (page.length === 0) break;
    const keys = page.map((c) => c.threadKey);
    const [ai, local, ledgerRows, tracked] = await Promise.all([
      db.insights.bulkGet(keys.map((k) => insightKeyFor('ai', k))),
      db.insights.bulkGet(keys.map((k) => insightKeyFor('local', k))),
      db.dockSent.bulkGet(keys),
      db.dockTracked.bulkGet(keys),
    ]);
    const dirty: string[] = [];
    const removals: Record<RemoveReason, string[]> = { local_only: [], deleted: [], out_of_scope: [] };
    for (let i = 0; i < page.length; i++) {
      const conv = page[i];
      const ledger = ledgerFor(ledgerRows[i], dock);
      const t = tracked[i];
      if (conv.isSyntheticBenchmark) continue;
      // Cheap check here (direct tombstones only); the drain re-checks fully at send time.
      const shareable = isRemoteAllowed(conv, settings, localOnly) && !tombstoned.has(conv.threadKey);
      if (!shareable) {
        if (ledger) removals.local_only.push(conv.threadKey);
        continue;
      }
      const wanted = inScope(conv, dock.prefs) ? !(t?.dismissed ?? false) : Boolean(t && !t.dismissed);
      if (!wanted) {
        if (ledger) removals.out_of_scope.push(conv.threadKey);
        continue;
      }
      const digest = cheapDigestOf(conv, ai[i]?.generatedAt, local[i]?.generatedAt);
      if (!ledger || ledger.cheapDigest !== digest || ledger.prefsHash !== prefsHash) dirty.push(conv.threadKey);
    }
    if (dirty.length) queued += await markDockDirty(db, dirty, { immediate: true, now: now() });
    for (const reason of ['local_only', 'deleted', 'out_of_scope'] as const) {
      if (removals[reason].length) queued += await markDockDirty(db, removals[reason], { immediate: true, remove: reason, now: now() });
    }
    cursor = keys[keys.length - 1];
    if (now() - started > budget) {
      await setMeta(db, 'reconcile.cursor', cursor);
      return { ran: true, done: false, queued };
    }
  }

  // Ledger entries whose thread no longer exists: deleted in Threadkeeper.
  const sentKeys = (await db.dockSent.toCollection().primaryKeys()) as string[];
  for (let i = 0; i < sentKeys.length; i += 500) {
    const chunk = sentKeys.slice(i, i + 500);
    const convs = await db.conversations.bulkGet(chunk);
    const gone = chunk.filter((_, j) => !convs[j]);
    if (gone.length) queued += await markDockDirty(db, gone, { immediate: true, remove: 'deleted', now: now() });
  }
  await setMeta(db, 'reconcile.cursor', '');
  await setMeta(db, 'reconcile.lastAt', now());
  return { ran: true, done: true, queued };
}

/**
 * Privacy fast path (no full reconcile): every thread in the ledger that may no longer be shared
 * gets an immediate `local_only` removal.
 */
export async function queuePrivacyRemovals(db: ThreadkeeperDB, settings: SettingsRecord, now = Date.now()): Promise<number> {
  const dock = settings.sidebarDock;
  if (!dock.pairedId) return 0;
  const localOnly = await localOnlyProjectNames(db);
  const ledger = await db.dockSent.toArray();
  const removals: string[] = [];
  const deleted: string[] = [];
  for (let i = 0; i < ledger.length; i += 500) {
    const chunk = ledger.slice(i, i + 500);
    const convs = await db.conversations.bulkGet(chunk.map((r) => r.threadKey));
    for (let j = 0; j < chunk.length; j++) {
      const conv = convs[j];
      if (!conv) deleted.push(chunk[j].threadKey);
      else if (!(await isShareable(db, conv, settings, localOnly))) removals.push(conv.threadKey);
    }
  }
  let queued = 0;
  if (removals.length) queued += await markDockDirty(db, removals, { immediate: true, remove: 'local_only', now });
  if (deleted.length) queued += await markDockDirty(db, deleted, { immediate: true, remove: 'deleted', now });
  return queued;
}

/** Threads Still should hold under the current prefs (for sync.configure's `total`). */
export async function countInScope(db: ThreadkeeperDB, settings: SettingsRecord): Promise<number> {
  const dock = settings.sidebarDock;
  const localOnly = await localOnlyProjectNames(db);
  let total = 0;
  await db.conversations.each((conv) => {
    if (conv.isSyntheticBenchmark || conv.cloudExcluded) return;
    if (settings.cloudExcludedProviders.includes(conv.provider) || localOnly.has(conv.project)) return;
    if (inScope(conv, dock.prefs)) total += 1;
  });
  return total;
}

// ---------------------------------------------------------------------------
// Drain
// ---------------------------------------------------------------------------

type Decision =
  | { action: 'drop'; digest?: string }
  | { action: 'remove'; reason: RemoveReason }
  | { action: 'upsert'; origin: 'sync' | 'manual'; target: DockOutboxRecord['target']; payload: ThreadPayload; digest: string };

export interface DrainResult {
  pushes: number;
  delivered: number;
  removed: number;
  dropped: number;
  failed: number;
  stoppedReason: string | null;
  /** Earliest notBefore of what is left (ms), or null when the outbox is empty. */
  nextDueAt: number | null;
}

export interface DrainOptions {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  budgetMs?: number;
  /** Only send local_only removals (flush before unpairing). */
  onlyLocalOnly?: boolean;
  /** Called with `not_paired` answers; returns true when the pairing was dropped. */
  onNotPaired?: () => Promise<boolean>;
  onDelivered?: (info: { at: number }) => Promise<void> | void;
  onError?: (message: string) => Promise<void> | void;
}

const draining = new WeakMap<ThreadkeeperDB, Promise<DrainResult>>();

/** One drain at a time per database and service-worker lifetime (in-memory mutex). */
export function drainDock(db: ThreadkeeperDB, settings: SettingsRecord, send: DockSend, options: DrainOptions = {}): Promise<DrainResult> {
  const running = draining.get(db);
  if (running) return running;
  const run = runDrain(db, settings, send, options).finally(() => {
    draining.delete(db);
  });
  draining.set(db, run);
  return run;
}

export function isDraining(db: ThreadkeeperDB): boolean {
  return draining.has(db);
}

function backoffMs(row: DockOutboxRecord, attempts: number): number {
  if (row.op === 'remove' && row.reason === 'local_only') return LOCAL_ONLY_RETRY_MS;
  return BACKOFF_MINUTES[Math.min(BACKOFF_MINUTES.length - 1, Math.max(0, attempts - 1))] * 60_000;
}

async function claimRows(db: ThreadkeeperDB, nowMs: number, onlyLocalOnly: boolean): Promise<DockOutboxRecord[]> {
  return db.transaction('rw', db.dockOutbox, async () => {
    const nowIso = isoAt(nowMs);
    const due = await db.dockOutbox.where('notBefore').belowOrEqual(nowIso).limit(400).toArray();
    const free = due.filter((r) => !r.leaseUntil || r.leaseUntil < nowIso).filter((r) => !onlyLocalOnly || (r.op === 'remove' && r.reason === 'local_only'));
    // Privacy first, then manual sends, then removals, then sync pushes (oldest first).
    const rank = (r: DockOutboxRecord) => (r.op === 'remove' && r.reason === 'local_only' ? 0 : r.manual ? 1 : r.op === 'remove' ? 2 : 3);
    free.sort((a, b) => rank(a) - rank(b) || a.notBefore.localeCompare(b.notBefore));
    const claimed = free.slice(0, 100).map((r) => ({ ...r, leaseUntil: isoAt(nowMs + LEASE_MS) }));
    await db.dockOutbox.bulkPut(claimed);
    return claimed;
  });
}

/**
 * Settle a row after Still answered. Without a patch the row is deleted, unless it was marked dirty
 * again meanwhile (then it is released for re-evaluation). With a patch it is kept and re-queued.
 */
async function ackRow(db: ThreadkeeperDB, row: DockOutboxRecord, patch: Partial<DockOutboxRecord> = {}): Promise<void> {
  await db.transaction('rw', db.dockOutbox, async () => {
    const current = await db.dockOutbox.get(row.threadKey);
    if (!current) return;
    const requeue = Object.keys(patch).length > 0;
    if (!requeue && current.dirtySeq === row.dirtySeq) {
      await db.dockOutbox.delete(row.threadKey);
      return;
    }
    await db.dockOutbox.put({
      ...current,
      // What was just delivered is done: a delivered manual send does not stay manual.
      manual: row.manual ? false : current.manual,
      target: row.manual ? null : current.target,
      attempts: 0,
      lastError: '',
      leaseUntil: '',
      ...patch,
    });
  });
}

async function failRows(db: ThreadkeeperDB, rows: DockOutboxRecord[], nowMs: number, message: string, options: { retryAfterMs?: number; penalty: boolean }): Promise<void> {
  await db.transaction('rw', db.dockOutbox, async () => {
    for (const row of rows) {
      const current = await db.dockOutbox.get(row.threadKey);
      if (!current) continue;
      const attempts = options.penalty ? current.attempts + 1 : current.attempts;
      const wait = options.retryAfterMs ?? backoffMs(current, attempts);
      await db.dockOutbox.put({ ...current, attempts, lastError: message.slice(0, 300), leaseUntil: '', notBefore: isoAt(nowMs + Math.max(1000, wait)) });
    }
  });
}

async function decide(
  db: ThreadkeeperDB,
  settings: SettingsRecord,
  row: DockOutboxRecord,
  ledger: DockSentRecord | undefined,
  tracked: DockTrackedRecord | undefined,
  localOnly: ReadonlySet<string>
): Promise<Decision> {
  const dock = settings.sidebarDock;
  if (row.op === 'remove' && (row.reason === 'local_only' || row.reason === 'deleted')) {
    return { action: 'remove', reason: row.reason };
  }
  const records = await loadThreadRecords(db, row.threadKey);
  if (!records) return ledger ? { action: 'remove', reason: 'deleted' } : { action: 'drop' };
  const { conv } = records;
  if (!(await isShareable(db, conv, settings, localOnly))) {
    // Never sent: nothing to take back. Sent before: Still must forget it.
    return ledger ? { action: 'remove', reason: 'local_only' } : { action: 'drop' };
  }
  const digest = cheapDigestOf(conv, records.ai?.generatedAt, records.local?.generatedAt);
  const manual = Boolean(row.manual);
  if (!manual) {
    if (!dock.configured) return { action: 'drop' };
    const wanted = inScope(conv, dock.prefs) ? !(tracked?.dismissed ?? false) : Boolean(tracked && !tracked.dismissed);
    if (!wanted) return ledger ? { action: 'remove', reason: 'out_of_scope' } : { action: 'drop' };
  }
  const shareTranscripts = transcriptsShared(dock) && !row.noTranscript;
  const needTranscript = shareTranscripts && (row.wantTranscript || !ledger || ledger.transcriptRevision !== conv.sourceRevision);
  const probe = await buildThreadPayload(db, settings, row.threadKey, { transcript: 'none', seq: 0, records, localOnly });
  if (!probe) return { action: 'drop' };
  if (!manual && ledger) {
    const samePrefs = ledger.prefsHash === prefsHashOf(dock);
    if (ledger.fingerprint === probe.fingerprint && !needTranscript && samePrefs) return { action: 'drop', digest };
    if (ledger.fingerprint !== probe.fingerprint && !dock.prefs.autoUpdate && !row.wantTranscript && samePrefs) return { action: 'drop', digest };
  }
  const payload = needTranscript
    ? await buildThreadPayload(db, settings, row.threadKey, { transcript: 'full', seq: 0, records, localOnly })
    : probe;
  if (!payload) return { action: 'drop' };
  return { action: 'upsert', origin: manual ? 'manual' : 'sync', target: manual ? row.target ?? null : null, payload, digest };
}

/** Shrink an oversized payload's transcript to fit one message, or drop the transcript. */
async function fitPayload(db: ThreadkeeperDB, settings: SettingsRecord, payload: ThreadPayload, localOnly: ReadonlySet<string>): Promise<ThreadPayload> {
  let bytes = jsonByteLength(payload);
  if (bytes <= RESPONSE_BUDGET_BYTES || !payload.transcript.included) return payload;
  const ratio = (RESPONSE_BUDGET_BYTES / bytes) * 0.85;
  const smaller = await buildThreadPayload(db, settings, payload.threadKey, {
    transcript: 'full',
    seq: payload.seq,
    localOnly,
    transcriptBudgetChars: Math.floor(TRANSCRIPT_MAX_TOTAL_CHARS * ratio),
  });
  if (smaller) {
    bytes = jsonByteLength(smaller);
    if (bytes <= RESPONSE_BUDGET_BYTES) return smaller;
  }
  const bare = await buildThreadPayload(db, settings, payload.threadKey, { transcript: 'none', seq: payload.seq, localOnly });
  return bare ?? payload;
}

async function runDrain(db: ThreadkeeperDB, settings: SettingsRecord, send: DockSend, options: DrainOptions): Promise<DrainResult> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const started = now();
  const budget = options.budgetMs ?? 25_000;
  const result: DrainResult = { pushes: 0, delivered: 0, removed: 0, dropped: 0, failed: 0, stoppedReason: null, nextDueAt: null };
  const dock = settings.sidebarDock;
  if (!dock.pairedId) {
    result.stoppedReason = 'Not paired';
    return finish();
  }
  const localOnly = await localOnlyProjectNames(db);
  let maxBatch = MAX_PUSH_THREADS;

  async function finish(): Promise<DrainResult> {
    const next = await db.dockOutbox.orderBy('notBefore').first();
    result.nextDueAt = next ? Date.parse(next.notBefore) : null;
    return result;
  }

  outer: while (now() - started < budget) {
    const rows = await claimRows(db, now(), Boolean(options.onlyLocalOnly));
    if (rows.length === 0) break;
    const ledgerRows = await db.dockSent.bulkGet(rows.map((r) => r.threadKey));
    const trackedRows = await db.dockTracked.bulkGet(rows.map((r) => r.threadKey));

    const removes: Record<RemoveReason, DockOutboxRecord[]> = { local_only: [], deleted: [], out_of_scope: [] };
    const upserts: Array<{ row: DockOutboxRecord; decision: Extract<Decision, { action: 'upsert' }> }> = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let decision: Decision;
      try {
        decision = await decide(db, settings, row, ledgerFor(ledgerRows[i], dock), trackedRows[i], localOnly);
      } catch (err) {
        await failRows(db, [row], now(), err instanceof Error ? err.message : String(err), { penalty: true });
        result.failed += 1;
        continue;
      }
      if (decision.action === 'drop') {
        const ledger = ledgerFor(ledgerRows[i], dock);
        if (decision.digest && ledger && ledger.cheapDigest !== decision.digest) {
          await db.dockSent.put({ ...ledger, cheapDigest: decision.digest });
        }
        await ackRow(db, row);
        result.dropped += 1;
      } else if (decision.action === 'remove') {
        removes[decision.reason].push(row);
      } else {
        upserts.push({ row, decision });
      }
    }

    // Removals: local_only first.
    for (const reason of ['local_only', 'deleted', 'out_of_scope'] as const) {
      const list = removes[reason];
      for (let i = 0; i < list.length; i += MAX_REMOVE_THREADS) {
        const chunk = list.slice(i, i + MAX_REMOVE_THREADS);
        const keys = chunk.map((r) => r.threadKey);
        const res = await send('threads.remove', { threadKeys: keys, reason });
        result.pushes += 1;
        if (!res.ok) {
          if (await handleSendError(res.error, chunk)) break outer;
          continue;
        }
        const answered = new Map(readRemoveResults(res.data, new Set(keys)).map((r) => [r.threadKey, r.status]));
        for (const row of chunk) {
          if (!answered.has(row.threadKey)) {
            await failRows(db, [row], now(), 'Still did not answer for this thread', { penalty: true });
            result.failed += 1;
            continue;
          }
          await db.dockSent.delete(row.threadKey);
          await ackRow(db, row);
          result.removed += 1;
        }
        await options.onDelivered?.({ at: now() });
        await sleep(1000);
      }
    }

    // Upserts, grouped by origin and target, in batches of ≤ 20 threads and ≤ ~3.9 MB.
    const groups = new Map<string, typeof upserts>();
    for (const u of upserts) {
      const key = JSON.stringify([u.decision.origin, u.decision.target ?? null]);
      groups.set(key, [...(groups.get(key) ?? []), u]);
    }
    for (const group of groups.values()) {
      let queue = group;
      while (queue.length) {
        if (now() - started > budget) {
          // Out of time: release the leases so the next drain picks them up at once.
          await failRows(db, queue.map((u) => u.row), now(), '', { penalty: false, retryAfterMs: 1000 });
          break outer;
        }
        const batch: typeof upserts = [];
        let bytes = 0;
        const seqStart = await allocateSeq(db, Math.min(maxBatch, queue.length));
        for (const u of queue.slice(0, maxBatch)) {
          u.decision.payload = await fitPayload(db, settings, { ...u.decision.payload, seq: seqStart + batch.length }, localOnly);
          const size = jsonByteLength(u.decision.payload);
          if (batch.length > 0 && bytes + size > RESPONSE_BUDGET_BYTES) break;
          bytes += size;
          batch.push(u);
        }
        queue = queue.slice(batch.length);
        const first = batch[0].decision;
        const fields: Record<string, unknown> = { threads: batch.map((u) => u.decision.payload), origin: first.origin };
        if (first.target && (first.target.collectionId || first.target.collectionName)) fields.target = first.target;
        const res = await send('threads.upsert', fields, { timeoutMs: batch.some((u) => u.decision.payload.transcript.included) ? 30_000 : 10_000 });
        result.pushes += 1;
        if (!res.ok) {
          if (res.error.code === 'too_large' && batch.length > 1) {
            maxBatch = 1;
            queue = [...batch, ...queue];
            continue;
          }
          if (res.error.code === 'too_large') {
            const u = batch[0];
            if (u.decision.payload.transcript.included) {
              await ackRow(db, u.row, { noTranscript: true, wantTranscript: false, notBefore: isoAt(now()) });
            } else {
              await recordDelivered(u, { status: 'skipped', fingerprint: '', seq: null, itemId: '' });
              await ackRow(db, u.row);
            }
            continue;
          }
          if (await handleSendError(res.error, batch.map((u) => u.row))) break outer;
          continue;
        }
        const sentKeys = new Set(batch.map((u) => u.row.threadKey));
        const answers = new Map(readUpsertResults(res.data, sentKeys).map((r) => [r.threadKey, r]));
        for (const u of batch) {
          const a = answers.get(u.row.threadKey);
          if (!a) {
            await failRows(db, [u.row], now(), 'Still did not answer for this thread', { penalty: true });
            result.failed += 1;
            continue;
          }
          if (a.status === 'skipped' && a.reason === 'dismissed') {
            await db.dockTracked.put({ threadKey: u.row.threadKey, trackedAt: isoAt(now()), dismissed: true });
            await db.dockSent.delete(u.row.threadKey);
            await ackRow(db, u.row);
            result.delivered += 1;
            continue;
          }
          if (a.status === 'skipped' && a.reason === 'too_large') {
            if (u.decision.payload.transcript.included) {
              await ackRow(db, u.row, { noTranscript: true, wantTranscript: false, notBefore: isoAt(now()) });
              continue;
            }
          }
          await recordDelivered(u, a);
          if (u.decision.origin === 'manual') await trackThreads(db, [u.row.threadKey], now());
          const wantsTranscript = a.needsTranscript && transcriptsShared(dock) && !u.decision.payload.transcript.included && !u.row.noTranscript;
          if (wantsTranscript) await ackRow(db, u.row, { wantTranscript: true, manual: false, notBefore: isoAt(now()) });
          else await ackRow(db, u.row);
          result.delivered += 1;
        }
        await options.onDelivered?.({ at: now() });
        // At least 1 s between the ack of one push and the next.
        await sleep(1000);
      }
    }
  }
  return finish();

  async function recordDelivered(
    u: { row: DockOutboxRecord; decision: Extract<Decision, { action: 'upsert' }> },
    a: { status: string; fingerprint: string; seq: number | null; itemId: string }
  ): Promise<void> {
    const prev = ledgerFor(await db.dockSent.get(u.row.threadKey), dock);
    const p = u.decision.payload;
    await db.dockSent.put({
      threadKey: u.row.threadKey,
      peerId: dock.pairedId,
      epoch: dock.peerEpoch,
      fingerprint: a.fingerprint || p.fingerprint,
      seq: a.seq ?? p.seq,
      transcriptRevision: p.transcript.included ? p.transcript.revision : prev?.transcriptRevision ?? -1,
      prefsHash: prefsHashOf(dock),
      cheapDigest: u.decision.digest,
      itemId: a.itemId || prev?.itemId || '',
      sentAt: isoAt(now()),
    });
  }

  /** Returns true when the drain should stop. */
  async function handleSendError(error: { code: string; message: string; retryAfterMs?: number }, rows: DockOutboxRecord[]): Promise<boolean> {
    if (error.code === 'busy') {
      await failRows(db, rows, now(), 'Still is busy', { penalty: false, retryAfterMs: error.retryAfterMs ?? 5000 });
      result.stoppedReason = 'Still is busy';
      return true;
    }
    if (error.code === 'not_paired') {
      await failRows(db, rows, now(), 'Still does not recognise this pairing', { penalty: false, retryAfterMs: 60_000 });
      result.stoppedReason = 'Still answered not_paired';
      await options.onNotPaired?.();
      return true;
    }
    const message = error.code === 'unreachable' ? 'Still is not reachable' : `Still answered ${error.code}: ${error.message}`;
    await failRows(db, rows, now(), message, { penalty: true });
    result.failed += rows.length;
    result.stoppedReason = message;
    await options.onError?.(message);
    return true;
  }
}
