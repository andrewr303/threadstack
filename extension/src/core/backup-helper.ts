// Library backups kept on disk by the Mac helper (mac-helper/core.cjs, `backup-*` requests), and
// when they are made. Runs in the service worker. The format is backup.ts; the helper stores and
// returns bytes and never looks inside them.
//
// Backups are automatic once the helper is connected: the library is written out when it has
// changed and the last backup is old enough. A library with no threads is never backed up, so a
// fresh install cannot fill the folder with empty backups.
import type { ThreadkeeperDB } from './db.js';
import { base64ToBytes, bytesToBase64, libraryFingerprint, restoreBackup, writeBackup, type RestoreResult } from './backup.js';
import { activeAnalysisHold } from './analysis-hold.js';
import { HELPER_HOST } from './embed/helper-protocol.js';
import { helperConnectionReason, helperFailure } from './embed/helper.js';
import type { WorkspaceFailure } from './workspace/types.js';

/** One open connection to the helper. Requests are answered in the order they were sent. */
export interface HelperPort {
  request(message: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}

export interface BackupEnv {
  hasPermission(): Promise<boolean>;
  connect(host: string): HelperPort;
  /** Small values that outlive the worker (chrome.storage.local). */
  load(): Promise<BackupState | null>;
  save(state: BackupState): Promise<void>;
  extensionId: string;
  extensionVersion: string;
  now?: () => number;
}

export interface BackupState {
  /** Library fingerprint of the last backup that succeeded. */
  fingerprint: string;
  at: string;
  name: string;
  threads: number;
  /** Why the last attempt failed, cleared by the next success. */
  error?: string;
  /** When that attempt failed; the next automatic try waits AUTO_BACKUP_MIN_GAP_MS from it. */
  failedAt?: string;
}

export interface BackupListing {
  name: string;
  bytes: number;
  threads: number;
  messages: number;
  createdAt: string;
  extensionVersion: string;
}

export interface BackupStatus {
  ok: true;
  /** Whether the helper answered. When false, `reason` says what to do. */
  helper: boolean;
  reason?: string;
  threads: number;
  backups: BackupListing[];
  last: BackupState | null;
}

export type BackupNowResult = { ok: true; name: string; threads: number; bytes: number } | WorkspaceFailure;
export type BackupRestoreResult = ({ ok: true } & Pick<RestoreResult, 'threadsAdded' | 'kept' | 'settingsRestored'>) | WorkspaceFailure;

/** Raw bytes per `backup-chunk`; base64 makes the message a third larger (helper limit: 1 MB). */
const CHUNK_BYTES = 256 * 1024;
/** Automatic backups, and retries after a failed one, are at least this far apart. */
export const AUTO_BACKUP_MIN_GAP_MS = 60 * 60 * 1000;
/** A backup is made this often even when nothing the fingerprint watches has changed (settings). */
export const AUTO_BACKUP_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** No single helper request takes this long; past it the helper is treated as gone. */
const REQUEST_TIMEOUT_MS = 60_000;

const NO_PERMISSION: WorkspaceFailure = {
  ok: false,
  code: 'helper_unavailable',
  error: 'The Mac helper is not set up. Install it from Settings, Accounts, then choose Check connection.',
};

function fail(error: string): WorkspaceFailure {
  return { ok: false, error };
}

/** The helper's own reasons are short fixed sentences; anything else gets a plain one. */
function helperError(reply: Record<string, unknown>, fallback: string): Error {
  const text = typeof reply.error === 'string' && reply.error.length <= 200 && !/[\\/]/.test(reply.error) ? reply.error : fallback;
  return new Error(text);
}

async function ask(port: HelperPort, message: Record<string, unknown>, fallback: string): Promise<Record<string, unknown>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const reply = await Promise.race([
    port.request(message),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('The Mac helper stopped answering.')), REQUEST_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  if (!reply || reply.ok !== true) throw helperError(reply ?? {}, fallback);
  return reply;
}

function listing(value: unknown): BackupListing[] {
  if (!Array.isArray(value)) return [];
  const out: BackupListing[] = [];
  for (const raw of value.slice(0, 50)) {
    const b = raw as Record<string, unknown> | null;
    if (!b || typeof b.name !== 'string' || !/^library-[\d-]+\.tkbackup$/.test(b.name)) continue;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0);
    const text = (v: unknown) => (typeof v === 'string' ? v.slice(0, 80) : '');
    out.push({ name: b.name, bytes: num(b.bytes), threads: num(b.threads), messages: num(b.messages), createdAt: text(b.createdAt), extensionVersion: text(b.extensionVersion) });
  }
  return out;
}

async function open(env: BackupEnv | null): Promise<HelperPort | WorkspaceFailure> {
  if (!env || !(await env.hasPermission().catch(() => false))) return NO_PERMISSION;
  try {
    return env.connect(HELPER_HOST);
  } catch (err) {
    return helperFailure(err);
  }
}

function isFailure(value: HelperPort | WorkspaceFailure): value is WorkspaceFailure {
  return (value as WorkspaceFailure).ok === false;
}

export async function backupStatus(db: ThreadkeeperDB, env: BackupEnv | null): Promise<BackupStatus> {
  const threads = await db.conversations.count();
  const last = env ? await env.load().catch(() => null) : null;
  const port = await open(env);
  if (isFailure(port)) return { ok: true, helper: false, reason: port.error, threads, backups: [], last };
  try {
    const reply = await ask(port, { type: 'backup-list' }, 'The Mac helper could not list backups.');
    return { ok: true, helper: true, threads, backups: listing(reply.backups), last };
  } catch (err) {
    // A helper from before backups answers with an error: it works, it just cannot keep them.
    const reason =
      helperConnectionReason(err) ?? 'This Mac helper is an older version without backups. Run Install Mac Helper.command again to update it.';
    return { ok: true, helper: false, reason, threads, backups: [], last };
  } finally {
    port.close();
  }
}

/** One backup or restore at a time per worker. */
let running: Promise<unknown> | null = null;

async function exclusive<T>(busy: T, run: () => Promise<T>): Promise<T> {
  if (running) return busy;
  const mine = run();
  running = mine;
  try {
    return await mine;
  } finally {
    running = null;
  }
}

export function backupNow(db: ThreadkeeperDB, env: BackupEnv | null): Promise<BackupNowResult> {
  return exclusive<BackupNowResult>({ ok: false, code: 'busy', error: 'A backup or restore is already running.' }, async () => {
    const before = await libraryFingerprint(db);
    if (before.threads === 0) return fail('There is nothing to back up yet: the library has no threads.');
    // Tables are read one after another, so a backup taken while an online import is writing
    // could hold a thread without its messages. The import's own marker says when one is running.
    if (await activeAnalysisHold(db, env?.now?.() ?? Date.now())) {
      return { ok: false, code: 'busy', error: 'An online import is running. The library is backed up when it finishes.' };
    }
    const port = await open(env);
    if (isFailure(port)) return port;
    const problem = 'The Mac helper could not save the backup.';
    try {
      await ask(port, { type: 'backup-begin' }, problem);
      let held: Uint8Array[] = [];
      let heldBytes = 0;
      let sentBytes = 0;
      const send = async () => {
        if (heldBytes === 0) return;
        const all = new Uint8Array(heldBytes);
        let at = 0;
        for (const part of held) {
          all.set(part, at);
          at += part.length;
        }
        held = [];
        heldBytes = 0;
        for (let i = 0; i < all.length; i += CHUNK_BYTES) {
          await ask(port, { type: 'backup-chunk', data: bytesToBase64(all.subarray(i, i + CHUNK_BYTES)) }, problem);
        }
        sentBytes += all.length;
      };
      const meta = await writeBackup(
        db,
        async (bytes) => {
          held.push(bytes);
          heldBytes += bytes.length;
          if (heldBytes >= CHUNK_BYTES) await send();
        },
        { extensionVersion: env!.extensionVersion, extensionId: env!.extensionId, now: env!.now ? () => new Date(env!.now!()) : undefined }
      );
      await send();
      // The helper keeps the file only if it holds exactly the bytes sent.
      const done = await ask(port, { type: 'backup-commit', meta, bytes: sentBytes }, problem);
      const name = typeof done.name === 'string' ? done.name : '';
      if (!name) throw new Error(problem);
      const state: BackupState = { fingerprint: before.fingerprint, at: meta.createdAt, name, threads: meta.threads };
      await env!.save(state).catch(() => undefined);
      return { ok: true, name, threads: meta.threads, bytes: typeof done.bytes === 'number' ? done.bytes : 0 };
    } catch (err) {
      // Best effort: the helper also drops an unfinished backup when the connection closes.
      await port.request({ type: 'backup-abort' }).catch(() => undefined);
      const error = helperConnectionReason(err) ?? (err instanceof Error && err.message ? err.message : problem);
      const last = await env!.load().catch(() => null);
      const failedAt = new Date(env!.now?.() ?? Date.now()).toISOString();
      await env!.save({ ...(last ?? { fingerprint: '', at: '', name: '', threads: 0 }), error, failedAt }).catch(() => undefined);
      return { ok: false, error };
    } finally {
      port.close();
    }
  });
}

/**
 * Back up when the library changed since the last backup and that backup is old enough.
 * Called from an alarm; never throws and does nothing without the helper.
 */
export async function maybeAutoBackup(db: ThreadkeeperDB, env: BackupEnv | null): Promise<'skipped' | 'done' | 'failed'> {
  try {
    if (!env || !(await env.hasPermission().catch(() => false))) return 'skipped';
    const { threads, fingerprint } = await libraryFingerprint(db);
    if (threads === 0) return 'skipped';
    const last = await env.load().catch(() => null);
    const now = env.now?.() ?? Date.now();
    const age = last?.at ? now - Date.parse(last.at) : Infinity;
    if (last?.error) {
      // A failed attempt (full disk, helper gone) is retried, but not on every alarm.
      if (last.failedAt && now - Date.parse(last.failedAt) < AUTO_BACKUP_MIN_GAP_MS) return 'skipped';
    } else if (last) {
      if (last.fingerprint === fingerprint && age < AUTO_BACKUP_MAX_AGE_MS) return 'skipped';
      if (age < AUTO_BACKUP_MIN_GAP_MS) return 'skipped';
    }
    const result = await backupNow(db, env);
    // Waiting for an import (or another backup) is not a failure worth recording.
    return result.ok ? 'done' : result.code === 'busy' ? 'skipped' : 'failed';
  } catch {
    return 'failed';
  }
}

async function* readBackup(port: HelperPort, name: string): AsyncGenerator<Uint8Array> {
  let offset = 0;
  for (;;) {
    const reply = await ask(port, { type: 'backup-read', name, offset }, 'The Mac helper could not read that backup.');
    const bytes = typeof reply.data === 'string' && reply.data ? base64ToBytes(reply.data) : new Uint8Array(0);
    if (bytes.length) yield bytes;
    offset += bytes.length;
    if (reply.done === true || bytes.length === 0) return;
  }
}

export function restoreFromHelper(db: ThreadkeeperDB, env: BackupEnv | null, name: unknown): Promise<BackupRestoreResult> {
  return exclusive<BackupRestoreResult>({ ok: false, code: 'busy', error: 'A backup or restore is already running.' }, async () => {
    if (typeof name !== 'string' || !/^library-[\d-]+\.tkbackup$/.test(name)) return fail('That backup no longer exists.');
    const port = await open(env);
    if (isFailure(port)) return port;
    try {
      const result = await restoreBackup(db, readBackup(port, name));
      return { ok: true, threadsAdded: result.threadsAdded, kept: result.kept, settingsRestored: result.settingsRestored };
    } catch (err) {
      const reason = helperConnectionReason(err);
      if (reason) return fail(reason);
      return fail(err instanceof Error && err.message && !/[\\/]/.test(err.message) ? err.message : 'That backup could not be restored.');
    } finally {
      port.close();
    }
  });
}

const STATE_KEY = 'tk.backup.state';

/** chrome.runtime.connectNative behind BackupEnv; null outside an extension worker. */
export function chromeBackupEnv(extensionVersion: string): BackupEnv | null {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connectNative || !chrome.permissions?.contains || !chrome.storage?.local) return null;
  return {
    hasPermission: () => chrome.permissions.contains({ permissions: ['nativeMessaging'] }),
    connect: (host) => {
      const port = chrome.runtime.connectNative(host);
      const waiting: Array<{ resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void }> = [];
      let closed: Error | null = null;
      port.onMessage.addListener((message) => waiting.shift()?.resolve((message ?? {}) as Record<string, unknown>));
      port.onDisconnect.addListener(() => {
        closed = new Error(chrome.runtime.lastError?.message || 'The Mac helper closed the connection.');
        for (const w of waiting.splice(0)) w.reject(closed);
      });
      return {
        request: (message) =>
          new Promise((resolve, reject) => {
            if (closed) return reject(closed);
            waiting.push({ resolve, reject });
            try {
              port.postMessage(message);
            } catch (err) {
              waiting.pop();
              reject(err instanceof Error ? err : new Error(String(err)));
            }
          }),
        close: () => {
          try {
            port.disconnect();
          } catch {
            // already closed
          }
        },
      };
    },
    load: async () => ((await chrome.storage.local.get(STATE_KEY))[STATE_KEY] as BackupState | undefined) ?? null,
    save: (state) => chrome.storage.local.set({ [STATE_KEY]: state }),
    extensionId: chrome.runtime.id,
    extensionVersion,
  };
}
