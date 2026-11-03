// The Sidebar Dock (Still) link at runtime: the external-message handler (Still → Threadkeeper),
// outbound sends (Threadkeeper → Still), pairing with consent, and the internal operations the
// manager and the consent page reach through background.ts (DOCK_* messages).
//
// Rules (docs/sidebar-dock-integration.md):
// - Authentication is the sender id AND an extension-page origin of that id, never a tab.
// - Check order: sender and pairing → type allowlist → size → fields. An unpaired or unknown
//   sender never causes a storage write, except the single pending pair request.
// - handleExternalMessage never throws; every answer is a flat envelope.

import { ensureStarterCollectionsAndSettings, type ThreadkeeperDB } from '../db.js';
import type { SettingsRecord, SidebarDockSettings } from '../schema.js';
import { localOnlyProjectNames } from '../privacy.js';
import { enqueueAnalysis, isOlderAnalysis } from '../pipeline.js';
import { estimateAnalysisCostUsd, hasClaudeKey } from '../ai/claude.js';
import { buildThreadPayload, cheapDigestOf, isShareable, loadThreadRecords } from './payload.js';
import {
  facets,
  listThreads,
  relatedThreads,
  resolveHashes,
  searchThreads,
  threadContext,
  type QueryEnv,
} from './query.js';
import {
  clearDockLink,
  countInScope,
  drainDock,
  markDockDirty,
  pushDebounceMs,
  queuePrivacyRemovals,
  reconcileDock,
  resetLedger,
  trackThreads,
  type DrainResult,
} from './outbox.js';
import {
  allocateSeq,
  capabilitiesFor,
  codeHashFor,
  getMeta,
  isExpired,
  patchDockSettings,
  prefsHashOf,
  publicPending,
  readPendingState,
  sameHash,
  sessionStore,
  setMeta,
  unpairedPatch,
  writePendingState,
  type KeyValueStore,
  type PendingPair,
} from './state.js';
import {
  BadRequest,
  MAX_MESSAGE_BYTES,
  PAIR_REQUEST_TTL_MS,
  RESPONSE_BUDGET_BYTES,
  UNPAIRED_TYPES,
  READ_TYPES,
  buildEnvelope,
  checkEnvelope,
  errorResponse,
  isExtensionId,
  jsonByteLength,
  okResponse,
  parseAnalyze,
  parseContext,
  parseGet,
  parseHello,
  parseList,
  parsePairRequest,
  parseRelated,
  parseSearch,
  parseSyncConfigure,
  parseSyncResync,
  parseThreadOpen,
  parseUntrack,
  readChatsStatus,
  readCollections,
  readResponse,
  type DockResponse,
  type ErrorBody,
  type OutboundType,
  type SendResult,
  type StillChatStatus,
  type StillCollection,
  type ThreadPayload,
} from './protocol.js';

export interface DockSender {
  id?: string;
  url?: string;
  origin?: string;
  tab?: unknown;
  frameId?: number;
}

/** Sender rule: a valid extension id other than ours, an extension page of that id, never a tab. */
export function validateDockSender(sender: DockSender | null | undefined, ownId: string): { ok: true; id: string } | { ok: false; reason: string } {
  if (!sender || typeof sender !== 'object') return { ok: false, reason: 'No sender' };
  const id = sender.id;
  if (!isExtensionId(id)) return { ok: false, reason: 'Sender has no extension id' };
  if (id === ownId) return { ok: false, reason: 'Own extension on the external channel' };
  if (sender.tab) return { ok: false, reason: `Rejected content-script sender ${id}` };
  const base = `chrome-extension://${id}`;
  const urlOk = typeof sender.url === 'string' && sender.url.startsWith(`${base}/`);
  const originOk = sender.origin === base;
  if (!urlOk && !originOk) return { ok: false, reason: `Rejected sender ${id}: not one of its extension pages` };
  return { ok: true, id };
}

export interface DockDeps {
  db: ThreadkeeperDB;
  /** This extension's id (chrome.runtime.id). */
  ownId: string;
  version: string;
  now?: () => number;
  session?: KeyValueStore;
  /** chrome.runtime.sendMessage(extensionId, message) — resolves with the raw answer, rejects on lastError. */
  sendExternal?: (extensionId: string, message: unknown) => Promise<unknown>;
  openConsentWindow?: () => Promise<void>;
  openThread?: (threadKey: string) => Promise<void>;
  kickAnalysis?: () => void;
  /** Schedule the next drain (one-shot alarm) at this time; null clears it. */
  scheduleDrain?: (atMs: number | null) => void;
  /** Schedule the pair.granted retry alarm (every 30 s) or clear it. */
  schedulePairRetry?: (on: boolean) => void;
  /** Tell open Threadkeeper pages that the link state changed. */
  broadcast?: () => void;
  log?: (reason: string) => void;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export interface DockStateView {
  ownId: string;
  paired: boolean;
  pairedId: string;
  pairedName: string;
  pairedAt: string;
  configured: boolean;
  prefs: SidebarDockSettings['prefs'];
  allowSearch: boolean;
  shareTranscripts: boolean;
  allowRemoteModels: boolean;
  blockedIds: string[];
  capabilities: string[];
  pending: ReturnType<typeof publicPending>;
  queued: number;
  tracked: number;
  sent: number;
  lastPushAt: string;
  lastError: string;
  lastErrorAt: string;
}

const READ_MAX_IN_FLIGHT = 2;
const READ_MAX_PER_MINUTE = 30;
const PAIR_RETRY_MS = 30_000;
const NOT_PAIRED_CONFIRM_MS = 60_000;
const MAX_WRONG_CODES = 5;

export class DockService {
  private readonly db: ThreadkeeperDB;
  private readonly deps: DockDeps;
  private readonly session: KeyValueStore;
  private readonly now: () => number;
  private readsInFlight = 0;
  private readTimes: number[] = [];
  private background = new Set<Promise<unknown>>();

  constructor(deps: DockDeps) {
    this.deps = deps;
    this.db = deps.db;
    this.session = deps.session ?? sessionStore();
    this.now = deps.now ?? Date.now;
  }

  /** Wait for fire-and-forget work started by handlers (tests). */
  async idle(): Promise<void> {
    while (this.background.size) await Promise.allSettled(Array.from(this.background));
  }

  private spawn(task: () => Promise<unknown>): void {
    const p = task().catch((err) => this.deps.log?.(`[dock] ${err instanceof Error ? err.message : String(err)}`));
    this.background.add(p);
    void p.finally(() => this.background.delete(p));
  }

  private async settings(): Promise<SettingsRecord> {
    return ensureStarterCollectionsAndSettings(this.db);
  }

  private queryEnv(settings: SettingsRecord): QueryEnv {
    return { db: this.db, settings, fetchImpl: this.deps.fetchImpl, now: this.now };
  }

  // -------------------------------------------------------------------------
  // Inbound (Still → Threadkeeper)
  // -------------------------------------------------------------------------

  async handleExternalMessage(message: unknown, sender: DockSender): Promise<DockResponse> {
    try {
      return await this.dispatch(message, sender);
    } catch (err) {
      if (err instanceof BadRequest) return errorResponse(err.code, err.message);
      this.deps.log?.(`[dock] handler failed: ${err instanceof Error ? err.message : String(err)}`);
      return errorResponse('internal', 'Threadkeeper could not handle that request');
    }
  }

  private reject(reason: string): void {
    this.deps.log?.(`[dock] ${reason}`);
  }

  private async dispatch(message: unknown, sender: DockSender): Promise<DockResponse> {
    const who = validateDockSender(sender, this.deps.ownId);
    if (!who.ok) {
      this.reject(who.reason);
      return errorResponse('not_paired', 'Only an extension page may talk to Threadkeeper');
    }
    const env = checkEnvelope(message);
    if (!env.ok) {
      this.reject(`Rejected message from ${who.id}: ${env.message}`);
      return errorResponse(env.code, env.message);
    }
    const settings = await this.settings();
    const dock = settings.sidebarDock;
    const paired = dock.pairedId !== '' && dock.pairedId === who.id;
    if (!paired && !UNPAIRED_TYPES.has(env.type)) {
      this.reject(`Rejected ${env.type} from unpaired ${who.id}`);
      return errorResponse('not_paired', 'This extension is not connected to Threadkeeper');
    }
    if (jsonByteLength(message) > MAX_MESSAGE_BYTES) return errorResponse('too_large', 'Message is larger than 4 MB');
    const m = env.message;

    if (READ_TYPES.has(env.type)) {
      const trackGet = env.type === 'threads.get' && m.track === true;
      if (!dock.allowSearch && !trackGet) return errorResponse('disabled', 'Searching Threadkeeper from Still is turned off in Threadkeeper');
      return this.withReadSlot(() => this.handleRead(env.type, m, settings));
    }

    switch (env.type) {
      case 'hello':
        return this.onHello(who.id, parseHello(m).epoch, settings, paired);
      case 'pair.request':
        return this.onPairRequest(who.id, m, settings);
      case 'pair.revoke':
        await this.forgetPairing(settings, 'Still disconnected');
        return okResponse({});
      case 'sync.configure':
        return this.onConfigure(m, settings);
      case 'sync.resync': {
        const { epoch } = parseSyncResync(m);
        await this.adoptEpoch(epoch, settings);
        await resetLedger(this.db);
        const fresh = await this.settings();
        const r = await reconcileDock(this.db, fresh, { force: true, now: this.now });
        this.kickDrain();
        return okResponse({ queued: r.queued });
      }
      case 'sync.status':
        return okResponse({
          queued: await this.db.dockOutbox.count(),
          tracked: await this.db.dockTracked.filter((t) => !t.dismissed).count(),
          lastPushAt: dock.lastPushAt || null,
          lastError: dock.lastError || null,
        });
      case 'threads.untrack':
        return this.onUntrack(m);
      case 'threads.analyze':
        return this.onAnalyze(m, settings);
      case 'thread.open': {
        const { threadKey } = parseThreadOpen(m);
        const records = await loadThreadRecords(this.db, threadKey);
        const localOnly = await localOnlyProjectNames(this.db);
        if (!records || !(await isShareable(this.db, records.conv, settings, localOnly))) return errorResponse('not_found', 'No such thread');
        await this.deps.openThread?.(threadKey);
        return okResponse({});
      }
      default:
        return errorResponse('unsupported', `Unsupported type ${env.type}`);
    }
  }

  private async withReadSlot(fn: () => Promise<DockResponse>): Promise<DockResponse> {
    const t = this.now();
    this.readTimes = this.readTimes.filter((x) => t - x < 60_000);
    if (this.readsInFlight >= READ_MAX_IN_FLIGHT) return errorResponse('busy', 'Threadkeeper is answering other requests', 500);
    if (this.readTimes.length >= READ_MAX_PER_MINUTE) {
      return errorResponse('busy', 'Too many requests; try again shortly', Math.max(500, 60_000 - (t - this.readTimes[0])));
    }
    this.readTimes.push(t);
    this.readsInFlight += 1;
    try {
      return await fn();
    } finally {
      this.readsInFlight -= 1;
    }
  }

  private async handleRead(type: string, m: Record<string, unknown>, settings: SettingsRecord): Promise<DockResponse> {
    const env = this.queryEnv(settings);
    switch (type) {
      case 'threads.search':
        return okResponse({ ...(await searchThreads(env, parseSearch(m))) });
      case 'threads.list':
        return okResponse({ ...(await listThreads(env, parseList(m))) });
      case 'threads.context':
        return okResponse({ ...(await threadContext(env, parseContext(m))) });
      case 'threads.related': {
        const { threadKey, limit } = parseRelated(m);
        const results = await relatedThreads(env, threadKey, limit);
        if (results === null) return errorResponse('not_found', 'No such thread');
        return okResponse({ results });
      }
      case 'facets':
        return okResponse({ ...(await facets(env)) });
      case 'threads.get':
        return this.onGet(m, settings);
      default:
        return errorResponse('unsupported', `Unsupported type ${type}`);
    }
  }

  private async onHello(senderId: string, epoch: string, settings: SettingsRecord, paired: boolean): Promise<DockResponse> {
    const base = { app: 'threadkeeper', version: this.deps.version, paired };
    if (!paired) return okResponse(base);
    // The paired Still is back: retry what was waiting on backoff, and adopt a new epoch.
    if (epoch) await this.adoptEpoch(epoch, settings);
    await this.resetBackoff();
    await setMeta(this.db, 'notPairedAt', 0);
    this.kickDrain();
    return okResponse({ ...base, tk: { version: this.deps.version, capabilities: capabilitiesFor(settings) } });
  }

  private async resetBackoff(): Promise<void> {
    const nowIso = new Date(this.now()).toISOString();
    await this.db.transaction('rw', this.db.dockOutbox, async () => {
      const rows = await this.db.dockOutbox.filter((r) => r.attempts > 0 && r.notBefore > nowIso).toArray();
      if (rows.length) await this.db.dockOutbox.bulkPut(rows.map((r) => ({ ...r, notBefore: nowIso })));
    });
  }

  /** A new epoch means Still's copy may differ from what we believe we sent: discard the ledger. */
  private async adoptEpoch(epoch: string, settings: SettingsRecord): Promise<boolean> {
    if (!epoch || epoch === settings.sidebarDock.peerEpoch) return false;
    await resetLedger(this.db);
    await patchDockSettings(this.db, { peerEpoch: epoch });
    if (settings.sidebarDock.configured) {
      this.spawn(async () => {
        await reconcileDock(this.db, await this.settings(), { force: true, now: this.now });
        this.kickDrain();
      });
    }
    return true;
  }

  private async onPairRequest(senderId: string, m: Record<string, unknown>, settings: SettingsRecord): Promise<DockResponse> {
    const dock = settings.sidebarDock;
    const req = parsePairRequest(m);
    if (dock.pairedId === senderId) {
      if (req.epoch) await this.adoptEpoch(req.epoch, settings);
      return okResponse({ status: 'paired', tk: { version: this.deps.version, capabilities: capabilitiesFor(settings) } });
    }
    if (dock.pairedId) return errorResponse('busy', 'Threadkeeper is connected to another extension. Disconnect it in Threadkeeper first.');
    if (dock.blockedIds.includes(senderId)) return errorResponse('denied', 'This extension was denied in Threadkeeper');
    const nowMs = this.now();
    const state = await readPendingState(this.session, nowMs);
    if (state.pending && state.pending.senderId !== senderId) {
      return errorResponse('busy', 'Another extension is asking Threadkeeper for access right now', Math.max(1000, Date.parse(state.pending.at) + PAIR_REQUEST_TTL_MS - nowMs));
    }
    const codeHash = await codeHashFor(req.requestId, req.code);
    if (state.pending) {
      // A repeat: take the new request id and code (Still shows the new code), but never extend the
      // expiry and never reopen or refocus the window.
      if (state.pending.granted) return okResponse({ status: 'pending' });
      state.pending = { ...state.pending, requestId: req.requestId, codeHash, appName: req.appName, appVersion: req.appVersion, epoch: req.epoch, wrongCodes: 0 };
      await writePendingState(this.session, state);
      this.deps.broadcast?.();
      return okResponse({ status: 'pending' });
    }
    const pending: PendingPair = {
      senderId,
      requestId: req.requestId,
      appName: req.appName,
      appVersion: req.appVersion,
      codeHash,
      epoch: req.epoch,
      at: new Date(nowMs).toISOString(),
      wrongCodes: 0,
      granted: null,
    };
    state.pending = pending;
    const lastWindow = state.windows[senderId];
    const mayOpen = !lastWindow || nowMs - Date.parse(lastWindow) > PAIR_REQUEST_TTL_MS;
    if (mayOpen) state.windows[senderId] = pending.at;
    await writePendingState(this.session, state);
    if (mayOpen) {
      try {
        await this.deps.openConsentWindow?.();
      } catch (err) {
        this.reject(`Could not open the consent window: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    this.deps.broadcast?.();
    return okResponse({ status: 'pending' });
  }

  private async onConfigure(m: Record<string, unknown>, settings: SettingsRecord): Promise<DockResponse> {
    const { prefs, epoch } = parseSyncConfigure(m);
    if (epoch) await this.adoptEpoch(epoch, settings);
    await patchDockSettings(this.db, { prefs, configured: true });
    const fresh = await this.settings();
    const total = await countInScope(this.db, fresh);
    const r = await reconcileDock(this.db, fresh, { force: true, now: this.now });
    // Configuring is one of the moments to look for private threads Still may still hold.
    this.spawn(() => this.statusSweep());
    if (!r.done) this.deps.scheduleDrain?.(this.now() + 30_000);
    this.kickDrain();
    return okResponse({ queued: await this.db.dockOutbox.count(), total });
  }

  private async onUntrack(m: Record<string, unknown>): Promise<DockResponse> {
    const { hashes } = parseUntrack(m);
    const keys = Array.from(new Set((await resolveHashes(this.db, hashes)).values()));
    if (keys.length) {
      await this.db.transaction('rw', [this.db.dockTracked, this.db.dockSent, this.db.dockOutbox], async () => {
        await this.db.dockTracked.bulkDelete(keys);
        await this.db.dockSent.bulkDelete(keys);
        const rows = await this.db.dockOutbox.bulkGet(keys);
        await this.db.dockOutbox.bulkDelete(keys.filter((_, i) => rows[i] && rows[i]!.op === 'upsert' && !rows[i]!.manual));
      });
    }
    return okResponse({ untracked: keys.length });
  }

  private async onAnalyze(m: Record<string, unknown>, settings: SettingsRecord): Promise<DockResponse> {
    const { threadKeys } = parseAnalyze(m);
    const skipped: Array<{ threadKey: string; reason: 'no_ai' | 'local_only' | 'fresh' | 'limit' }> = [];
    if (!hasClaudeKey(settings)) {
      return okResponse({ queued: 0, skipped: threadKeys.map((threadKey) => ({ threadKey, reason: 'no_ai' })), estimateUsd: 0 });
    }
    const localOnly = await localOnlyProjectNames(this.db);
    const limit = settings.autoOrganize.dailyAiAnalysisLimit;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    let budget = limit > 0 ? Math.max(0, limit - (settings.aiAnalysesDate === today ? settings.aiAnalysesToday : 0)) : Number.POSITIVE_INFINITY;
    let queued = 0;
    for (const threadKey of threadKeys) {
      const records = await loadThreadRecords(this.db, threadKey);
      // Missing and private threads look the same from outside.
      if (!records || records.conv.messageCount === 0 || !(await isShareable(this.db, records.conv, settings, localOnly))) {
        skipped.push({ threadKey, reason: 'local_only' });
        continue;
      }
      const ai = records.ai;
      const current = Boolean(ai && ai.sourceRevision === records.conv.sourceRevision);
      if (current && !isOlderAnalysis(ai)) {
        skipped.push({ threadKey, reason: 'fresh' });
        continue;
      }
      if (budget <= 0) {
        skipped.push({ threadKey, reason: 'limit' });
        continue;
      }
      // A requested job runs even when automatic analysis is off and re-analyzes a current AI insight
      // written by an older analysis format (analysis v2 upgrade path, as "Upgrade older summaries").
      await enqueueAnalysis(this.db, records.conv, 0, { requested: true });
      budget -= 1;
      queued += 1;
    }
    if (queued) this.deps.kickAnalysis?.();
    return okResponse({ queued, skipped, estimateUsd: Math.round(estimateAnalysisCostUsd(settings.aiModel, queued) * 100) / 100 });
  }

  private async onGet(m: Record<string, unknown>, settings: SettingsRecord): Promise<DockResponse> {
    const req = parseGet(m);
    const dock = settings.sidebarDock;
    const hashed = await resolveHashes(this.db, req.ids.filter((i) => i.kind !== 'threadKey').map((i) => i.value));
    const localOnly = await localOnlyProjectNames(this.db);
    const threads: ThreadPayload[] = [];
    const missing: string[] = [];
    const deferred: string[] = [];
    const seqStart = await allocateSeq(this.db, req.ids.length);
    let bytes = 0;
    for (const id of req.ids) {
      const threadKey = id.kind === 'threadKey' ? id.value : hashed.get(id.value);
      if (!threadKey) {
        missing.push(id.value);
        continue;
      }
      if (threads.length > 0 && bytes >= RESPONSE_BUDGET_BYTES) {
        deferred.push(id.value);
        continue;
      }
      const payload = await buildThreadPayload(this.db, settings, threadKey, {
        transcript: req.transcript,
        window: req.window,
        seq: seqStart + threads.length,
        localOnly,
        transcriptBudgetChars: threads.length === 0 ? undefined : Math.max(10_000, Math.floor((RESPONSE_BUDGET_BYTES - bytes) / 1.2)),
      });
      if (!payload) {
        missing.push(id.value);
        continue;
      }
      const size = jsonByteLength(payload);
      if (threads.length > 0 && bytes + size > RESPONSE_BUDGET_BYTES) {
        deferred.push(id.value);
        continue;
      }
      let fitted = payload;
      if (threads.length === 0 && size > RESPONSE_BUDGET_BYTES) {
        const smaller = await buildThreadPayload(this.db, settings, threadKey, {
          transcript: req.transcript,
          window: req.window,
          seq: payload.seq,
          localOnly,
          transcriptBudgetChars: Math.floor(((RESPONSE_BUDGET_BYTES / size) * 0.85 * 3 * 1024 * 1024)),
        });
        fitted = smaller && jsonByteLength(smaller) <= RESPONSE_BUDGET_BYTES ? smaller : { ...payload, transcript: { ...payload.transcript, included: false, messages: [], truncated: false } };
      }
      bytes += jsonByteLength(fitted);
      threads.push(fitted);
    }
    if (req.track && threads.length) {
      const keys = threads.map((t) => t.threadKey);
      await trackThreads(this.db, keys, this.now());
      // Still applies these as imports; record them so the next reconcile does not push them again.
      const records = await Promise.all(keys.map((k) => loadThreadRecords(this.db, k)));
      const prev = await this.db.dockSent.bulkGet(keys);
      await this.db.dockSent.bulkPut(
        threads.map((t, i) => ({
          threadKey: t.threadKey,
          peerId: dock.pairedId,
          epoch: dock.peerEpoch,
          fingerprint: t.fingerprint,
          seq: t.seq,
          transcriptRevision: t.transcript.included && req.transcript === 'full' ? t.transcript.revision : prev[i]?.transcriptRevision ?? -1,
          prefsHash: prefsHashOf(dock),
          cheapDigest: records[i] ? cheapDigest(records[i]!) : '',
          itemId: prev[i]?.itemId ?? '',
          sentAt: new Date(this.now()).toISOString(),
        }))
      );
    }
    return okResponse({ threads, missing, deferred });
  }

  // -------------------------------------------------------------------------
  // Outbound (Threadkeeper → Still)
  // -------------------------------------------------------------------------

  /** Send one message to the paired Still (or `to`). Never throws. */
  async sendToDock(type: OutboundType, fields: Record<string, unknown> = {}, options: { timeoutMs?: number; to?: string } = {}): Promise<SendResult<Record<string, unknown>>> {
    const to = options.to ?? (await this.settings()).sidebarDock.pairedId;
    if (!to) return { ok: false, error: { code: 'not_paired', message: 'Not connected to Still' } };
    if (!this.deps.sendExternal) return { ok: false, error: { code: 'unreachable', message: 'Messaging is not available' } };
    const envelope = buildEnvelope(type, fields);
    if (jsonByteLength(envelope) > MAX_MESSAGE_BYTES) return { ok: false, error: { code: 'too_large', message: 'Message is larger than 4 MB' } };
    const timeoutMs = options.timeoutMs ?? 10_000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const raw = await Promise.race([
        this.deps.sendExternal(to, envelope),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('timeout')), timeoutMs);
        }),
      ]);
      return readResponse(raw);
    } catch (err) {
      return { ok: false, error: { code: 'unreachable', message: err instanceof Error ? err.message.slice(0, 200) : 'No answer' } };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  // -------------------------------------------------------------------------
  // Pairing decisions (consent page) and unpairing
  // -------------------------------------------------------------------------

  async getPending() {
    const state = await readPendingState(this.session, this.now());
    return publicPending(state.pending, this.now());
  }

  /**
   * The user's decision in connect.html. Allow needs the code Still shows; Deny always works and
   * blocks the sender until unblocked in Settings.
   */
  async decide(input: { requestId: unknown; allow: unknown; code?: unknown; allowRemoteModels?: unknown }): Promise<
    { ok: true; status: 'paired' | 'granted' | 'denied' } | { ok: false; error: string; status?: 'expired' | 'wrong_code' | 'cancelled' }
  > {
    const nowMs = this.now();
    const state = await readPendingState(this.session, nowMs);
    const pending = state.pending;
    if (!pending || typeof input.requestId !== 'string' || input.requestId !== pending.requestId) {
      return { ok: false, error: 'This request is no longer waiting. Start again from Still.', status: 'expired' };
    }
    if (input.allow !== true) {
      state.pending = null;
      await writePendingState(this.session, state);
      await patchDockSettings(this.db, (cur) => ({ blockedIds: Array.from(new Set([...cur.blockedIds, pending.senderId])) }));
      await this.sendToDock('pair.denied', { requestId: pending.requestId }, { to: pending.senderId, timeoutMs: 5000 });
      this.deps.broadcast?.();
      return { ok: true, status: 'denied' };
    }
    if (pending.granted) return this.deliverGrant();
    const code = typeof input.code === 'string' ? input.code.trim() : '';
    if (!/^\d{6}$/.test(code) || !sameHash(await codeHashFor(pending.requestId, code), pending.codeHash)) {
      pending.wrongCodes += 1;
      if (pending.wrongCodes >= MAX_WRONG_CODES) {
        state.pending = null;
        await writePendingState(this.session, state);
        this.deps.broadcast?.();
        return { ok: false, error: 'Too many wrong codes. The request was cancelled; connect again from Still.', status: 'cancelled' };
      }
      await writePendingState(this.session, state);
      return { ok: false, error: 'That code does not match the one Still shows.', status: 'wrong_code' };
    }
    pending.granted = { at: new Date(nowMs).toISOString(), allowRemoteModels: input.allowRemoteModels === true, attempts: 0, lastAttemptAt: '' };
    await writePendingState(this.session, state);
    return this.deliverGrant();
  }

  /** Deliver pair.granted; pairing completes only when Still acknowledges it (retried every 30 s). */
  async deliverGrant(): Promise<{ ok: true; status: 'paired' | 'granted' } | { ok: false; error: string; status?: 'expired' }> {
    const nowMs = this.now();
    const state = await readPendingState(this.session, nowMs);
    const pending = state.pending;
    if (!pending?.granted) {
      this.deps.schedulePairRetry?.(false);
      return { ok: false, error: 'Nothing to deliver', status: 'expired' };
    }
    const settings = await this.settings();
    const capsSettings: SettingsRecord = { ...settings, sidebarDock: { ...settings.sidebarDock, allowRemoteModels: pending.granted.allowRemoteModels } };
    const res = await this.sendToDock(
      'pair.granted',
      { requestId: pending.requestId, tk: { version: this.deps.version, capabilities: capabilitiesFor(capsSettings) } },
      { to: pending.senderId, timeoutMs: 10_000 }
    );
    if (res.ok) {
      state.pending = null;
      await writePendingState(this.session, state);
      await clearDockLink(this.db);
      await patchDockSettings(this.db, {
        pairedId: pending.senderId,
        pairedName: pending.appName,
        pairedAt: new Date(nowMs).toISOString(),
        configured: false,
        peerEpoch: pending.epoch,
        allowRemoteModels: pending.granted.allowRemoteModels,
        lastError: '',
        lastErrorAt: '',
      });
      this.deps.schedulePairRetry?.(false);
      // After pairing: find private threads Still may hold from an earlier pairing.
      this.spawn(() => this.statusSweep());
      this.deps.broadcast?.();
      return { ok: true, status: 'paired' };
    }
    if (res.error.code === 'unreachable' || res.error.code === 'busy' || res.error.code === 'internal') {
      pending.granted.attempts += 1;
      pending.granted.lastAttemptAt = new Date(nowMs).toISOString();
      await writePendingState(this.session, state);
      this.deps.schedulePairRetry?.(!isExpired(pending, nowMs + PAIR_RETRY_MS));
      return { ok: true, status: 'granted' };
    }
    // Still no longer waits for this request (expired, cancelled or another request).
    state.pending = null;
    await writePendingState(this.session, state);
    this.deps.schedulePairRetry?.(false);
    this.deps.broadcast?.();
    return { ok: false, error: 'Still is no longer waiting for this request. Connect again from Still.', status: 'expired' };
  }

  /** Disconnect from Threadkeeper's side: flush private removals, tell Still, forget everything. */
  async unpair(): Promise<{ ok: true }> {
    const settings = await this.settings();
    if (!settings.sidebarDock.pairedId) return { ok: true };
    try {
      await drainDock(this.db, settings, (t, f, o) => this.sendToDock(t, f, o), { onlyLocalOnly: true, budgetMs: 8000, sleep: this.deps.sleep, now: this.now });
    } catch {
      // best effort
    }
    await this.sendToDock('pair.revoke', {}, { timeoutMs: 5000 });
    await this.forgetPairing(settings, '');
    return { ok: true };
  }

  private async forgetPairing(settings: SettingsRecord, reason: string): Promise<void> {
    if (!settings.sidebarDock.pairedId) return;
    await clearDockLink(this.db);
    await patchDockSettings(this.db, { ...unpairedPatch(), lastError: reason, lastErrorAt: reason ? new Date(this.now()).toISOString() : '' });
    this.deps.scheduleDrain?.(null);
    this.deps.broadcast?.();
  }

  /** Still answered not_paired: drop the pairing only when it says so twice at least 60 s apart. */
  private async onNotPaired(): Promise<boolean> {
    const first = await getMeta<number>(this.db, 'notPairedAt', 0);
    const nowMs = this.now();
    if (!first) {
      await setMeta(this.db, 'notPairedAt', nowMs);
      return false;
    }
    if (nowMs - first < NOT_PAIRED_CONFIRM_MS) return false;
    await this.forgetPairing(await this.settings(), 'Still no longer recognises this connection');
    return true;
  }

  async unblock(extensionId: unknown): Promise<{ ok: boolean }> {
    if (!isExtensionId(extensionId)) return { ok: false };
    await patchDockSettings(this.db, (cur) => ({ blockedIds: cur.blockedIds.filter((id) => id !== extensionId) }));
    this.deps.broadcast?.();
    return { ok: true };
  }

  /** Toggle "Let Still search", "Share full transcripts", "Use my embedding and rerank providers". */
  async setOptions(patch: { allowSearch?: unknown; shareTranscripts?: unknown; allowRemoteModels?: unknown }): Promise<DockStateView> {
    const before = (await this.settings()).sidebarDock;
    const next: Partial<SidebarDockSettings> = {};
    if (typeof patch.allowSearch === 'boolean') next.allowSearch = patch.allowSearch;
    if (typeof patch.shareTranscripts === 'boolean') next.shareTranscripts = patch.shareTranscripts;
    if (typeof patch.allowRemoteModels === 'boolean') next.allowRemoteModels = patch.allowRemoteModels;
    const after = await patchDockSettings(this.db, next);
    if (after.pairedId) {
      // Still refreshes capabilities from hello; transcript sharing changes the ledger's prefs hash.
      this.spawn(async () => {
        await this.sendToDock('hello', {}, { timeoutMs: 5000 });
        if (before.shareTranscripts !== after.shareTranscripts) {
          await reconcileDock(this.db, await this.settings(), { force: true, now: this.now });
          this.kickDrain();
        }
      });
    }
    this.deps.broadcast?.();
    return this.getState();
  }

  // -------------------------------------------------------------------------
  // Manager operations
  // -------------------------------------------------------------------------

  async getState(): Promise<DockStateView> {
    const settings = await this.settings();
    const dock = settings.sidebarDock;
    const state = await readPendingState(this.session, this.now());
    return {
      ownId: this.deps.ownId,
      paired: dock.pairedId !== '',
      pairedId: dock.pairedId,
      pairedName: dock.pairedName,
      pairedAt: dock.pairedAt,
      configured: dock.configured,
      prefs: dock.prefs,
      allowSearch: dock.allowSearch,
      shareTranscripts: dock.shareTranscripts,
      allowRemoteModels: dock.allowRemoteModels,
      blockedIds: dock.blockedIds,
      capabilities: dock.pairedId ? capabilitiesFor(settings) : [],
      pending: publicPending(state.pending, this.now()),
      queued: await this.db.dockOutbox.count(),
      tracked: await this.db.dockTracked.filter((t) => !t.dismissed).count(),
      sent: await this.db.dockSent.count(),
      lastPushAt: dock.lastPushAt,
      lastError: dock.lastError,
      lastErrorAt: dock.lastErrorAt,
    };
  }

  /** Send to Still… (origin manual): works outside Still's scope; private threads are never sent. */
  async sendThreads(threadKeys: unknown, target: unknown): Promise<{ ok: true; queued: number; skipped: Array<{ threadKey: string; reason: string }> } | { ok: false; error: string }> {
    const settings = await this.settings();
    if (!settings.sidebarDock.pairedId) return { ok: false, error: 'Connect Still first (Settings → Sidebar Dock).' };
    if (!Array.isArray(threadKeys)) return { ok: false, error: 'No threads given' };
    const keys = Array.from(new Set(threadKeys.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 600))).slice(0, 500);
    const t = target && typeof target === 'object' ? (target as Record<string, unknown>) : {};
    const cleanTarget =
      typeof t.collectionId === 'string' && /^[\w:.-]{1,200}$/.test(t.collectionId)
        ? { collectionId: t.collectionId }
        : typeof t.collectionName === 'string' && t.collectionName.trim()
          ? { collectionName: t.collectionName.replace(/\s+/g, ' ').trim().slice(0, 120) }
          : null;
    const localOnly = await localOnlyProjectNames(this.db);
    const ok: string[] = [];
    const skipped: Array<{ threadKey: string; reason: string }> = [];
    const convs = await this.db.conversations.bulkGet(keys);
    for (let i = 0; i < keys.length; i++) {
      const conv = convs[i];
      if (!conv) skipped.push({ threadKey: keys[i], reason: 'missing' });
      else if (!(await isShareable(this.db, conv, settings, localOnly))) skipped.push({ threadKey: keys[i], reason: 'local_only' });
      else ok.push(keys[i]);
    }
    if (ok.length) {
      // A manual send is also how the user overrides an earlier "deleted in Still".
      await trackThreads(this.db, ok, this.now());
      await markDockDirty(this.db, ok, { immediate: true, manual: true, target: cleanTarget, now: this.now() });
      this.kickDrain();
    }
    return { ok: true, queued: ok.length, skipped };
  }

  async collections(): Promise<{ ok: true; collections: StillCollection[] } | { ok: false; error: ErrorBody }> {
    const res = await this.sendToDock('collections.list', {}, { timeoutMs: 10_000 });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, collections: readCollections(res.data) };
  }

  async statusFor(threadKeys: unknown): Promise<{ ok: true; chats: Record<string, StillChatStatus> } | { ok: false; error: ErrorBody }> {
    if (!Array.isArray(threadKeys)) return { ok: false, error: { code: 'bad_request', message: 'No threads given' } };
    const keys = Array.from(new Set(threadKeys.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 600))).slice(0, 500);
    const settings = await this.settings();
    // Only ever name threads that may be shared.
    const localOnly = await localOnlyProjectNames(this.db);
    const convs = await this.db.conversations.bulkGet(keys);
    const allowed: string[] = [];
    for (let i = 0; i < keys.length; i++) {
      const c = convs[i];
      if (c && (await isShareable(this.db, c, settings, localOnly))) allowed.push(keys[i]);
    }
    if (allowed.length === 0) return { ok: true, chats: {} };
    const res = await this.sendToDock('chats.status', { threadKeys: allowed }, { timeoutMs: 10_000 });
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, chats: readChatsStatus(res.data, new Set(allowed)) };
  }

  /**
   * After pairing, configuring and daily: ask Still which private threads it holds and remove them.
   * Synthetic threads are never sent and are skipped.
   */
  async statusSweep(): Promise<number> {
    const settings = await this.settings();
    if (!settings.sidebarDock.pairedId) return 0;
    const localOnly = await localOnlyProjectNames(this.db);
    const privateKeys: string[] = [];
    await this.db.conversations.each((conv) => {
      if (conv.isSyntheticBenchmark) return;
      if (conv.cloudExcluded || settings.cloudExcludedProviders.includes(conv.provider) || localOnly.has(conv.project)) privateKeys.push(conv.threadKey);
    });
    let queued = 0;
    for (let i = 0; i < privateKeys.length; i += 500) {
      const chunk = privateKeys.slice(i, i + 500);
      const res = await this.sendToDock('chats.status', { threadKeys: chunk }, { timeoutMs: 10_000 });
      if (!res.ok) break;
      const held = Object.keys(readChatsStatus(res.data, new Set(chunk)));
      if (held.length) queued += await markDockDirty(this.db, held, { immediate: true, remove: 'local_only', now: this.now() });
    }
    await setMeta(this.db, 'statusSweep.lastAt', this.now());
    if (queued) this.kickDrain();
    return queued;
  }

  /**
   * DOCK_SYNC_NOW from a page write: re-evaluate these threads now, and on privacy-changing writes
   * queue removals for every sent thread that may no longer be shared.
   */
  async syncNow(input: { threadKeys?: unknown; privacy?: unknown } = {}): Promise<{ ok: true; queued: number }> {
    const settings = await this.settings();
    if (!settings.sidebarDock.pairedId) return { ok: true, queued: 0 };
    let queued = 0;
    const keys = Array.isArray(input.threadKeys) ? input.threadKeys.filter((k): k is string => typeof k === 'string' && k.length <= 600).slice(0, 2000) : [];
    if (input.privacy === true || keys.length === 0) queued += await queuePrivacyRemovals(this.db, settings, this.now());
    if (keys.length) queued += await markDockDirty(this.db, keys, { debounceMs: pushDebounceMs(settings), now: this.now() });
    if (input.privacy === true && keys.length) queued += await markDockDirty(this.db, keys, { immediate: true, now: this.now() });
    this.kickDrain();
    return { ok: true, queued };
  }

  /** Threadkeeper-side Resync: forget the ledger and re-offer everything in scope. */
  async resync(): Promise<{ ok: true; queued: number }> {
    const settings = await this.settings();
    if (!settings.sidebarDock.pairedId) return { ok: true, queued: 0 };
    await resetLedger(this.db);
    const r = await reconcileDock(this.db, settings, { force: true, now: this.now });
    this.kickDrain();
    return { ok: true, queued: r.queued };
  }

  /** A thread changed in this worker (capture, local organize, analysis): push it once it is quiet. */
  async markDirty(threadKeys: string[]): Promise<void> {
    const settings = await this.settings();
    if (!settings.sidebarDock.pairedId || threadKeys.length === 0) return;
    await markDockDirty(this.db, threadKeys, { debounceMs: pushDebounceMs(settings), now: this.now() });
    await this.scheduleNextDrain();
  }

  // -------------------------------------------------------------------------
  // Drain, reconcile, alarms
  // -------------------------------------------------------------------------

  kickDrain(): void {
    this.spawn(() => this.drain());
  }

  async drain(): Promise<DrainResult | null> {
    const settings = await this.settings();
    if (!settings.sidebarDock.pairedId) return null;
    const result = await drainDock(this.db, settings, (t, f, o) => this.sendToDock(t, f, o), {
      now: this.now,
      sleep: this.deps.sleep,
      onNotPaired: () => this.onNotPaired(),
      onDelivered: async ({ at }) => {
        await setMeta(this.db, 'notPairedAt', 0);
        await setMeta(this.db, 'lastPushAt', at);
      },
      onError: async (message) => {
        await patchDockSettings(this.db, { lastError: message, lastErrorAt: new Date(this.now()).toISOString() });
      },
    });
    if (result.delivered + result.removed > 0) {
      const at = await getMeta<number>(this.db, 'lastPushAt', 0);
      await patchDockSettings(this.db, {
        lastPushAt: at ? new Date(at).toISOString() : new Date(this.now()).toISOString(),
        ...(result.failed === 0 ? { lastError: '', lastErrorAt: '' } : {}),
      });
      this.deps.broadcast?.();
    }
    await this.scheduleNextDrain(result.nextDueAt);
    return result;
  }

  private async scheduleNextDrain(nextDueAt?: number | null): Promise<void> {
    let due = nextDueAt;
    if (due === undefined) {
      const next = await this.db.dockOutbox.orderBy('notBefore').first();
      due = next ? Date.parse(next.notBefore) : null;
    }
    // Chrome alarms fire no sooner than 30 s; the drain itself waits 1 s between pushes.
    this.deps.scheduleDrain?.(due === null || due === undefined ? null : Math.max(due, this.now() + 30_000));
  }

  /** Reconcile (alarm, startup, install); skipped when the last full pass is under 10 minutes old. */
  async reconcile(force = false): Promise<void> {
    const settings = await this.settings();
    if (!settings.sidebarDock.pairedId) return;
    const r = await reconcileDock(this.db, settings, { force, now: this.now });
    if (!r.done) this.deps.scheduleDrain?.(this.now() + 30_000);
    if (r.queued > 0 || !r.done) this.kickDrain();
  }

  /** Daily: private-thread sweep with chats.status, plus a liveness hello. */
  async daily(): Promise<void> {
    const settings = await this.settings();
    if (!settings.sidebarDock.pairedId) return;
    const res = await this.sendToDock('hello', {}, { timeoutMs: 5000 });
    if (res.ok) {
      const epoch = typeof res.data.epoch === 'string' ? res.data.epoch : '';
      if (res.data.paired === false) await this.onNotPaired();
      else if (epoch) await this.adoptEpoch(epoch, settings);
    }
    await this.statusSweep();
    await this.reconcile(false);
  }
}

function cheapDigest(r: NonNullable<Awaited<ReturnType<typeof loadThreadRecords>>>): string {
  // Same inputs reconcile uses, so a tracked import is not pushed straight back.
  return cheapDigestOf(r.conv, r.ai?.generatedAt, r.local?.generatedAt);
}
