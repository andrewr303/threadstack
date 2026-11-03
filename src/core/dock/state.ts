// Pairing state of the Sidebar Dock (Still) link.
// - Durable pairing and toggles: settings.sidebarDock, written only through patchDockSettings.
// - The single pending pair request and the consent-window log: chrome.storage.session key
//   `tk.dock.pending.v1` (in-memory fallback), so a browser restart drops unanswered requests.
// - Counters and cursors: the dockMeta table.

import { ensureStarterCollectionsAndSettings, type ThreadkeeperDB } from '../db.js';
import {
  DEFAULT_DOCK_PREFS,
  normalizeSettings,
  normalizeSidebarDock,
  type SettingsRecord,
  type SidebarDockSettings,
} from '../schema.js';
import { hasClaudeKey } from '../ai/claude.js';
import { remoteSpace } from '../embeddings.js';
import { rerankReady } from '../rerank.js';
import { PAIR_REQUEST_TTL_MS, type DockCapability, type SyncPrefs } from './protocol.js';

export const PENDING_KEY = 'tk.dock.pending.v1';

/** A key-value store with chrome.storage's promise shape (session storage or a test double). */
export interface KeyValueStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export function memoryStore(): KeyValueStore {
  const data = new Map<string, unknown>();
  return {
    async get(key) {
      return data.has(key) ? { [key]: structuredClone(data.get(key)) } : {};
    },
    async set(items) {
      for (const [k, v] of Object.entries(items)) data.set(k, structuredClone(v));
    },
  };
}

/** chrome.storage.session when available (MV3 service worker and extension pages), else memory. */
export function sessionStore(): KeyValueStore {
  const session = typeof chrome !== 'undefined' ? chrome.storage?.session : undefined;
  if (!session) return memoryStore();
  const fallback = memoryStore();
  return {
    async get(key) {
      try {
        return (await session.get(key)) as Record<string, unknown>;
      } catch {
        return fallback.get(key);
      }
    },
    async set(items) {
      try {
        await session.set(items);
      } catch {
        await fallback.set(items);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export async function readDockSettings(db: ThreadkeeperDB): Promise<{ settings: SettingsRecord; dock: SidebarDockSettings }> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  return { settings, dock: settings.sidebarDock };
}

/**
 * Merge a patch into settings.sidebarDock inside one transaction (prefs merge too), so the
 * worker's pairing writes and the manager's toggles never overwrite each other.
 */
export async function patchDockSettings(
  db: ThreadkeeperDB,
  patch: Partial<SidebarDockSettings> | ((current: SidebarDockSettings) => Partial<SidebarDockSettings>)
): Promise<SidebarDockSettings> {
  return db.transaction('rw', db.settings, async () => {
    const current = normalizeSettings(await db.settings.get('default'));
    const delta = typeof patch === 'function' ? patch(current.sidebarDock) : patch;
    const next = normalizeSidebarDock({
      ...current.sidebarDock,
      ...delta,
      prefs: { ...current.sidebarDock.prefs, ...(delta.prefs ?? {}) },
    });
    await db.settings.put({ ...current, sidebarDock: next });
    return next;
  });
}

/** Forget the pairing (keeps the user's toggles and the blocked list). */
export function unpairedPatch(): Partial<SidebarDockSettings> {
  return {
    pairedId: '',
    pairedName: '',
    pairedAt: '',
    configured: false,
    prefs: { ...DEFAULT_DOCK_PREFS },
    peerEpoch: '',
  };
}

export function isPaired(dock: SidebarDockSettings): boolean {
  return dock.pairedId !== '';
}

/** Capabilities this Threadkeeper offers the paired Still right now. */
export function capabilitiesFor(settings: SettingsRecord): DockCapability[] {
  const dock = settings.sidebarDock;
  const caps: DockCapability[] = ['sync', 'open'];
  if (dock.allowSearch) caps.push('search', 'context');
  if (dock.shareTranscripts) caps.push('transcripts');
  if (dock.allowSearch && dock.allowRemoteModels && (remoteSpace(settings) !== null || rerankReady(settings))) caps.push('remote_models');
  if (hasClaudeKey(settings)) caps.push('analyze');
  return caps;
}

/** Whether Still's searches may reach the embedding / rerank providers. */
export function remoteModelsAllowed(settings: SettingsRecord): boolean {
  return capabilitiesFor(settings).includes('remote_models');
}

/** Whether transcripts go to Still: both Still's pref and Threadkeeper's "Share full transcripts". */
export function transcriptsShared(dock: SidebarDockSettings): boolean {
  return dock.shareTranscripts && dock.prefs.transcripts;
}

/** Changes whenever the transcript-sharing settings change, so the affected threads are re-offered. */
export function prefsHashOf(dock: SidebarDockSettings): string {
  return transcriptsShared(dock) ? 't1' : 't0';
}

export function samePrefs(a: SyncPrefs, b: SyncPrefs): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Pending pair request (session storage)
// ---------------------------------------------------------------------------

export interface PendingPair {
  senderId: string;
  requestId: string;
  appName: string;
  appVersion: string;
  /** SHA-256 hex of `${requestId}:${code}`; the code itself is never stored. */
  codeHash: string;
  epoch: string;
  /** When the request was first recorded; repeats never extend it. */
  at: string;
  wrongCodes: number;
  /** Set once the user pressed Allow; pairing completes when Still acknowledges pair.granted. */
  granted: null | {
    at: string;
    allowRemoteModels: boolean;
    attempts: number;
    lastAttemptAt: string;
  };
}

export interface PendingState {
  pending: PendingPair | null;
  /** When a consent window was last opened per sender (at most one per sender per 10 minutes). */
  windows: Record<string, string>;
}

function normalizePendingState(raw: unknown): PendingState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<PendingState>;
  const windows: Record<string, string> = {};
  if (r.windows && typeof r.windows === 'object') {
    for (const [k, v] of Object.entries(r.windows)) if (typeof v === 'string') windows[k] = v;
  }
  const p = r.pending as PendingPair | null | undefined;
  const pending =
    p && typeof p === 'object' && typeof p.senderId === 'string' && typeof p.requestId === 'string' && typeof p.codeHash === 'string'
      ? { ...p, wrongCodes: Number(p.wrongCodes) || 0, granted: p.granted ?? null }
      : null;
  return { pending, windows };
}

export async function readPendingState(store: KeyValueStore, nowMs: number): Promise<PendingState> {
  const raw = (await store.get(PENDING_KEY))[PENDING_KEY];
  const state = normalizePendingState(raw);
  if (state.pending && isExpired(state.pending, nowMs)) state.pending = null;
  for (const [id, at] of Object.entries(state.windows)) {
    if (nowMs - Date.parse(at) > PAIR_REQUEST_TTL_MS) delete state.windows[id];
  }
  return state;
}

export async function writePendingState(store: KeyValueStore, state: PendingState): Promise<void> {
  await store.set({ [PENDING_KEY]: state });
}

export function isExpired(pending: PendingPair, nowMs: number): boolean {
  const at = Date.parse(pending.at);
  return !Number.isFinite(at) || nowMs - at > PAIR_REQUEST_TTL_MS;
}

/** What the consent page may see of the pending request. */
export function publicPending(pending: PendingPair | null, nowMs: number) {
  if (!pending) return null;
  return {
    senderId: pending.senderId,
    requestId: pending.requestId,
    appName: pending.appName,
    appVersion: pending.appVersion,
    codeHash: pending.codeHash,
    at: pending.at,
    expiresAt: new Date(Date.parse(pending.at) + PAIR_REQUEST_TTL_MS).toISOString(),
    expiresInMs: Math.max(0, Date.parse(pending.at) + PAIR_REQUEST_TTL_MS - nowMs),
    granted: Boolean(pending.granted),
  };
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export function codeHashFor(requestId: string, code: string): Promise<string> {
  return sha256Hex(`${requestId}:${code}`);
}

/** Constant-time comparison of two hex strings. */
export function sameHash(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// ---------------------------------------------------------------------------
// dockMeta: counters, cursors, timestamps
// ---------------------------------------------------------------------------

export async function getMeta<T>(db: ThreadkeeperDB, key: string, fallback: T): Promise<T> {
  const row = await db.dockMeta.get(key);
  return row === undefined ? fallback : (row.value as T);
}

export async function setMeta(db: ThreadkeeperDB, key: string, value: unknown): Promise<void> {
  await db.dockMeta.put({ key, value });
}

/** Reserve `count` consecutive values of the persisted, Threadkeeper-wide monotonic `seq`. */
export async function allocateSeq(db: ThreadkeeperDB, count: number): Promise<number> {
  return db.transaction('rw', db.dockMeta, async () => {
    const row = await db.dockMeta.get('seq');
    const current = typeof row?.value === 'number' && Number.isFinite(row.value) ? row.value : 0;
    // Wall-clock floor: a lost dockMeta row (reset database) still never goes backwards in practice.
    const start = Math.max(current + 1, Date.now() * 1000 - 1_700_000_000_000_000);
    await db.dockMeta.put({ key: 'seq', value: start + Math.max(1, count) - 1 });
    return start;
  });
}
