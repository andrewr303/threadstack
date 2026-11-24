// Page-side client for the Still (Sidebar Dock) link. Every call goes to the service worker as an
// internal DOCK_* message (src/entrypoints/background.ts → DockService); pages never talk to Still
// directly. Calls never throw: failures come back as { ok: false, error } with plain wording.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { DockStateView } from '../../core/dock/external.js';
import type { StillChatStatus, StillCollection } from '../../core/dock/protocol.js';
import type { DockSyncPrefs } from '../../core/schema.js';
import { PROVIDERS } from '../../core/providers.js';

export type { DockStateView, StillChatStatus, StillCollection };

/** Where "Send to Still" puts the threads: Still's own placement, an existing collection, or a new one. */
export type StillTarget = { collectionId: string } | { collectionName: string } | null;

export type DockFailure = { ok: false; error: string; code?: string };

type SendFn = (message: Record<string, unknown>) => Promise<unknown>;

let overlayToken = '';
let sendOverride: SendFn | null = null;
/** Last pairing state this page saw; null until known. Lets page writes skip the worker when unpaired. */
let knownPaired: boolean | null = null;

/**
 * The overlay (manager framed in an AI site) must prove its handshake for DOCK_SEND; tests inject
 * their own transport.
 */
export function configureDockClient(options: { handshakeToken?: string; send?: SendFn | null }): void {
  if (options.handshakeToken !== undefined) overlayToken = options.handshakeToken;
  if (options.send !== undefined) sendOverride = options.send;
}

/** Test hook: forget what this page learned. */
export function resetDockClient(): void {
  overlayToken = '';
  sendOverride = null;
  knownPaired = null;
  statusCache.clear();
  statusInFlight.clear();
}

function transport(): SendFn | null {
  if (sendOverride) return sendOverride;
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return null;
  return (message) => chrome.runtime.sendMessage(message) as Promise<unknown>;
}

/** Plain wording for the error shapes DockService returns (a string, or a protocol ErrorBody). */
export function dockErrorText(error: unknown): { text: string; code?: string } {
  if (typeof error === 'string' && error.trim()) return { text: error.trim() };
  if (error && typeof error === 'object') {
    const e = error as { code?: unknown; message?: unknown };
    const code = typeof e.code === 'string' ? e.code : undefined;
    switch (code) {
      case 'unreachable':
        return { code, text: 'Still is not responding. Check that it is installed and turned on.' };
      case 'not_paired':
        return { code, text: 'Still no longer recognises this connection. Connect again from Still.' };
      case 'busy':
        return { code, text: 'Still is busy. Try again in a moment.' };
      case 'unauthorized':
        return { code, text: 'Still refused the request.' };
      default:
        if (typeof e.message === 'string' && e.message.trim()) return { code, text: e.message.trim() };
    }
  }
  return { text: 'That did not work.' };
}

async function call<T extends { ok: true }>(message: Record<string, unknown>): Promise<T | DockFailure> {
  const send = transport();
  if (!send) return { ok: false, error: 'ThreadStack is not running as an extension here.' };
  try {
    const res = (await send(overlayToken ? { ...message, handshakeToken: overlayToken } : message)) as
      | (Record<string, unknown> & { ok?: unknown; error?: unknown })
      | undefined;
    if (res && res.ok === true) return res as unknown as T;
    const { text, code } = dockErrorText(res?.error);
    return { ok: false, error: text, code };
  } catch (err) {
    return { ok: false, error: `ThreadStack's background did not answer (${err instanceof Error ? err.message : String(err)}).` };
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export async function getDockState(): Promise<DockStateView | null> {
  const res = await call<{ ok: true; state: DockStateView }>({ type: 'DOCK_GET_STATE' });
  if (!res.ok) return null;
  knownPaired = res.state.paired;
  return res.state;
}

/**
 * Tell the worker that this page changed threads (DOCK_SYNC_NOW). `privacy` marks writes that can
 * make a thread private or delete it (local-only, project moves, deletes, undo): the worker then
 * takes back from Still at once whatever may no longer be shared. Fire and forget; a no-op when the
 * page knows ThreadStack is not paired.
 */
export function dockSyncNow(threadKeys: readonly string[] = [], options: { privacy?: boolean } = {}): void {
  if (knownPaired === false) return;
  const keys = Array.from(new Set(threadKeys.filter((k) => typeof k === 'string' && k)));
  const privacy = options.privacy === true;
  if (keys.length === 0 && !privacy) return;
  const batches = keys.length ? chunk(keys, 2000) : [[]];
  for (const batch of batches) void call({ type: 'DOCK_SYNC_NOW', threadKeys: batch, privacy });
  if (keys.length) invalidateStillStatus(keys);
}

export function setDockOptions(patch: { allowSearch?: boolean; shareTranscripts?: boolean; allowRemoteModels?: boolean }) {
  return call<{ ok: true; state: DockStateView }>({ type: 'DOCK_SET_OPTIONS', ...patch });
}

export function unpairDock() {
  return call<{ ok: true }>({ type: 'DOCK_UNPAIR' });
}

export function resyncDock() {
  return call<{ ok: true; queued: number }>({ type: 'DOCK_RESYNC' });
}

export function unblockDock(extensionId: string) {
  return call<{ ok: true }>({ type: 'DOCK_UNBLOCK', extensionId });
}

export function openDockConsent() {
  return call<{ ok: true }>({ type: 'DOCK_OPEN_CONSENT' });
}

export async function fetchStillCollections(): Promise<{ ok: true; collections: StillCollection[] } | DockFailure> {
  const res = await call<{ ok: true; collections: StillCollection[] }>({ type: 'DOCK_COLLECTIONS' });
  if (!res.ok) return res;
  return { ok: true, collections: sortCollections(Array.isArray(res.collections) ? res.collections : []) };
}

export interface SendOutcome {
  ok: true;
  queued: number;
  skipped: Array<{ threadKey: string; reason: string }>;
}

/** Send to Still… (origin manual). The worker accepts 500 keys per call. */
export async function sendThreadsToStill(threadKeys: readonly string[], target: StillTarget): Promise<SendOutcome | DockFailure> {
  const keys = Array.from(new Set(threadKeys));
  if (keys.length === 0) return { ok: false, error: 'No threads to send.' };
  let queued = 0;
  const skipped: SendOutcome['skipped'] = [];
  for (const batch of chunk(keys, 500)) {
    const res = await call<SendOutcome>({ type: 'DOCK_SEND', threadKeys: batch, ...(target ? { target } : {}) });
    if (!res.ok) {
      if (queued === 0) return res;
      // Part went through: report it with the rest counted as not sent.
      for (const k of keys.slice(keys.indexOf(batch[0]))) skipped.push({ threadKey: k, reason: 'failed' });
      break;
    }
    queued += res.queued;
    skipped.push(...(Array.isArray(res.skipped) ? res.skipped : []));
  }
  invalidateStillStatus(keys);
  return { ok: true, queued, skipped };
}

// ---------------------------------------------------------------------------
// "In Still" status (DOCK_STATUS_FOR), cached per thread
// ---------------------------------------------------------------------------

const STATUS_TTL_MS = 2 * 60_000;
const statusCache = new Map<string, { status: StillChatStatus | null; at: number }>();
const statusInFlight = new Map<string, Promise<StillChatStatus | null | undefined>>();

export function invalidateStillStatus(threadKeys?: readonly string[]): void {
  if (!threadKeys) statusCache.clear();
  else for (const k of threadKeys) statusCache.delete(k);
}

/**
 * Where Still keeps this thread: a status, null when Still does not hold it (or it may not be
 * shared), undefined when Still could not be asked.
 */
export function getStillStatus(threadKey: string, now = Date.now()): Promise<StillChatStatus | null | undefined> {
  const hit = statusCache.get(threadKey);
  if (hit && now - hit.at < STATUS_TTL_MS) return Promise.resolve(hit.status);
  const running = statusInFlight.get(threadKey);
  if (running) return running;
  const p = (async () => {
    const res = await call<{ ok: true; chats: Record<string, StillChatStatus> }>({ type: 'DOCK_STATUS_FOR', threadKeys: [threadKey] });
    if (!res.ok) return undefined;
    const status = res.chats && typeof res.chats === 'object' ? res.chats[threadKey] ?? null : null;
    statusCache.set(threadKey, { status, at: Date.now() });
    return status;
  })().finally(() => statusInFlight.delete(threadKey));
  statusInFlight.set(threadKey, p);
  return p;
}

// ---------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------

export function sortCollections(collections: readonly StillCollection[]): StillCollection[] {
  return [...collections].sort((a, b) => (a.path || a.name).localeCompare(b.path || b.name, undefined, { sensitivity: 'base', numeric: true }));
}

export const NEW_COLLECTION = '__new__';

/** The picker's value ('' = Still's default placement, an id, or NEW_COLLECTION) → DOCK_SEND target. */
export function stillTargetFromChoice(choice: string, newName: string): { ok: true; target: StillTarget } | { ok: false; error: string } {
  if (!choice) return { ok: true, target: null };
  if (choice === NEW_COLLECTION) {
    const name = newName.replace(/\s+/g, ' ').trim().slice(0, 120);
    if (!name) return { ok: false, error: 'Name the new collection.' };
    return { ok: true, target: { collectionName: name } };
  }
  if (!/^[\w:.-]{1,200}$/.test(choice)) return { ok: false, error: 'Pick a collection.' };
  return { ok: true, target: { collectionId: choice } };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** One line for the result of a send. */
export function describeSendOutcome(outcome: SendOutcome | DockFailure, targetLabel: string): { text: string; ok: boolean } {
  if (!outcome.ok) return { text: outcome.error, ok: false };
  const privateCount = outcome.skipped.filter((s) => s.reason === 'local_only').length;
  const missing = outcome.skipped.filter((s) => s.reason === 'missing').length;
  const failed = outcome.skipped.filter((s) => s.reason === 'failed').length;
  const parts: string[] = [];
  if (outcome.queued > 0) parts.push(`Sending ${plural(outcome.queued, 'thread')} to ${targetLabel}. They appear in Still in a moment.`);
  else parts.push('Nothing was sent.');
  if (privateCount) parts.push(`${plural(privateCount, 'local-only thread')} stayed here: private threads are never shared.`);
  if (missing) parts.push(`${plural(missing, 'thread')} no longer ${missing === 1 ? 'exists' : 'exist'}.`);
  if (failed) parts.push(`${plural(failed, 'thread')} could not be sent; try again.`);
  return { text: parts.join(' '), ok: outcome.queued > 0 };
}

export function targetLabel(choice: string, newName: string, collections: readonly StillCollection[]): string {
  if (!choice) return 'Still';
  if (choice === NEW_COLLECTION) return `the new collection “${newName.replace(/\s+/g, ' ').trim()}” in Still`;
  const c = collections.find((x) => x.id === choice);
  return c ? `“${c.path || c.name}” in Still` : 'Still';
}

export function stillBadgeText(status: StillChatStatus): string {
  if (status.trashed) return 'In Still · Trash';
  return `In Still · ${status.collectionName || 'Inbox'}`;
}

/** Short status for the Settings nav and the panel heading. */
export function dockStatusSummary(state: DockStateView | null): { short: string; long: string; tone?: 'danger' } {
  if (!state) return { short: 'Off', long: 'Not connected' };
  if (state.pending && !state.pending.granted) {
    return { short: 'Request', long: `“${state.pending.appName}” is asking to connect`, tone: 'danger' };
  }
  if (state.pending?.granted) return { short: 'Connecting', long: `Allowed; waiting for “${state.pending.appName}” to confirm` };
  if (!state.paired) return { short: 'Off', long: 'Not connected' };
  const name = state.pairedName || 'Still';
  if (!state.configured) return { short: 'Connected', long: `Connected to ${name}; it has not chosen what to sync yet` };
  return { short: 'Connected', long: `Connected to ${name}` };
}

function listWithMore(items: readonly string[], max = 5): string {
  if (items.length <= max) return items.join(', ');
  return `${items.slice(0, max).join(', ')} and ${items.length - max} more`;
}

function providerName(id: string): string {
  return (PROVIDERS as Record<string, { label?: string } | undefined>)[id]?.label ?? id;
}

/** Read-only readout of what Still asked to sync (protocol SyncPrefs as last received). */
export function describeSyncPrefs(prefs: DockSyncPrefs, configured: boolean, shareTranscripts: boolean): Array<{ label: string; value: string }> {
  if (!configured) return [{ label: 'What syncs', value: 'Nothing yet. Still chooses this when you press Start syncing there.' }];
  const scope =
    prefs.scope === 'all'
      ? 'Every thread'
      : prefs.scope === 'projects'
        ? prefs.projects.length
          ? `Threads in ${plural(prefs.projects.length, 'project')}: ${listWithMore(prefs.projects)}`
          : 'Threads in chosen projects (none chosen yet)'
        : 'Only threads you send or Still adds';
  const providers = prefs.providers.length ? listWithMore(prefs.providers.map(providerName)) : 'All providers';
  const transcripts = !prefs.transcripts
    ? 'Summaries only'
    : shareTranscripts
      ? 'Summaries and full transcripts'
      : 'Summaries only (transcript sharing is off here)';
  return [
    { label: 'What syncs', value: scope },
    { label: 'Providers', value: providers },
    { label: 'Content', value: transcripts },
    { label: 'Updates', value: prefs.autoUpdate ? 'Changes are pushed as threads change' : 'Only when a thread is sent again' },
  ];
}

/** Whether a page write may need the worker; exported so callers can skip work when unpaired. */
export function dockMaybePaired(): boolean {
  return knownPaired !== false;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** Live link state: loaded on mount, refreshed on DOCK_CHANGED, focus and (while a request waits) every 20 s. */
export function useDockState(enabled: boolean): { state: DockStateView | null; loaded: boolean; refresh: () => Promise<void> } {
  const [state, setState] = useState<DockStateView | null>(null);
  const [loaded, setLoaded] = useState(false);
  const alive = useRef(true);
  const refresh = useCallback(async () => {
    const next = await getDockState();
    if (!alive.current) return;
    setState(next);
    setLoaded(true);
  }, []);
  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    void refresh();
    const onMessage = (msg: { type?: string }) => {
      if (msg?.type === 'DOCK_CHANGED') {
        invalidateStillStatus();
        void refresh();
      }
    };
    const hasRuntime = typeof chrome !== 'undefined' && Boolean(chrome.runtime?.onMessage);
    if (hasRuntime) chrome.runtime.onMessage.addListener(onMessage);
    const onFocus = () => void refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      alive.current = false;
      if (hasRuntime) chrome.runtime.onMessage.removeListener(onMessage);
      window.removeEventListener('focus', onFocus);
    };
  }, [enabled, refresh]);
  const waiting = Boolean(state?.pending);
  useEffect(() => {
    if (!enabled || !waiting) return;
    const timer = setInterval(() => void refresh(), 20_000);
    return () => clearInterval(timer);
  }, [enabled, waiting, refresh]);
  return { state, loaded, refresh };
}

export type CollectionsState =
  | { status: 'idle' | 'loading'; collections: StillCollection[] }
  | { status: 'ready'; collections: StillCollection[] }
  | { status: 'error'; collections: StillCollection[]; error: string };

/** Still's collections for the target picker, fetched when `active` turns on. */
export function useStillCollections(active: boolean): CollectionsState {
  const [state, setState] = useState<CollectionsState>({ status: 'idle', collections: [] });
  useEffect(() => {
    if (!active) return;
    let live = true;
    setState((s) => ({ status: 'loading', collections: s.collections }));
    void fetchStillCollections().then((res) => {
      if (!live) return;
      setState(res.ok ? { status: 'ready', collections: res.collections } : { status: 'error', collections: [], error: res.error });
    });
    return () => {
      live = false;
    };
  }, [active]);
  return state;
}

/** "In Still · <collection>" for one thread; undefined while unknown or unreachable. */
export function useStillStatus(threadKey: string | null, enabled: boolean, revision: unknown): StillChatStatus | null | undefined {
  const [status, setStatus] = useState<StillChatStatus | null | undefined>(undefined);
  useEffect(() => {
    setStatus(undefined);
    if (!enabled || !threadKey) return;
    let live = true;
    void getStillStatus(threadKey).then((s) => {
      if (live) setStatus(s);
    });
    return () => {
      live = false;
    };
  }, [threadKey, enabled, revision]);
  return status;
}

/**
 * The threads an Ask answer cites ([T1], [T3] …), in citation order; all sources when the answer
 * cites none (or there is no answer, as in "Find threads" without an API key).
 */
export function citedSourceKeys(answer: string, sourceKeys: readonly string[]): string[] {
  const out: string[] = [];
  const re = /\[T(\d+)\]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(answer))) {
    const key = sourceKeys[Number(m[1]) - 1];
    if (key && !out.includes(key)) out.push(key);
  }
  return out.length ? out : [...sourceKeys];
}
