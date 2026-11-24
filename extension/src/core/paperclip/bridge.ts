import type { ThreadStackDB } from '../db.js';
import { ensureStarterCollectionsAndSettings } from '../db.js';
import { computeDeterministicHash, type SettingsRecord } from '../schema.js';
import { jsonByteLength, MAX_MESSAGE_BYTES, isObject } from '../dock/protocol.js';
import { remoteAllowedKeys } from '../privacy.js';
import { PaperclipClient, normalizeServerUrl, secretTransportAllowed, SECRET_TRANSPORT_REFUSED } from './client.js';
import { BrowserActionGuard, BridgeActionError, chromeActionJournal, type ActionJournal } from './actions.js';
import { buildAutomaticSessionLinks, buildSessionInventory, handleBridgeRequest, revalidateBridgeResult, type SessionRow } from './bridge-query.js';
import {
  BRIDGE_API_PATH, BRIDGE_LOOP_MS, BRIDGE_POLL_MS, BRIDGE_POLL_WAIT_MS, BRIDGE_PROTOCOL, BRIDGE_STORAGE_KEY, commitOfBuildId,
  DEFAULT_ACTION_POLICY, bridgeFailure, mergeActionPolicy, normalizeActionPolicy, parseBridgeRequest,
  type ActionOutcome, type ActionPolicy, type AgentAction, type AutomaticSessionLink, type BridgeErrorCode, type BridgeResult, type ChangedHint, type SessionLink, type SessionObservations, type SessionStateChange,
} from './bridge-protocol.js';

export interface BridgeCompanyState {
  token: string; shared: boolean; revoked: boolean; pending: null | { pairId: string; code: string; pollToken: string; expiresAt: number };
  lastSeenAt: number; lastError: string; pluginVersion: string; pluginCommit: string;
  fingerprints: Record<string, string>; links: SessionLink[];
}
export interface BridgeState {
  serverUrl: string; companies: Record<string, BridgeCompanyState>;
  policy: ActionPolicy; allowRemoteModels: boolean; shareTranscripts: boolean;
}
export interface BridgeStorage { read(): Promise<unknown>; write(state: BridgeState): Promise<void> }
export interface PublicBridgeCompany extends Omit<BridgeCompanyState, 'token' | 'fingerprints' | 'pending' | 'revoked'> {
  paired: boolean; connected: boolean; sessionCount: number; pendingDisconnect: boolean; pending: null | { code: string; expiresAt: number };
}
export interface PublicBridgeState extends Omit<BridgeState, 'companies'> { companies: Record<string, PublicBridgeCompany> }
export type InventoryPacket = { companyId: string; upserts: SessionRow[]; removes: string[]; events: SessionStateChange[]; automaticLinks: AutomaticSessionLink[] };

/** Count UTF-8 bytes incrementally; every collection, including removals, shares the wire budget. */
export function buildInventoryPackets(companyId: string, upserts: SessionRow[], removes: string[], events: SessionStateChange[], automaticLinks: AutomaticSessionLink[]): InventoryPacket[] {
  const empty = (): InventoryPacket => ({ companyId, upserts: [], removes: [], events: [], automaticLinks: [] });
  const packets: InventoryPacket[] = []; let packet = empty(); let bytes = jsonByteLength(packet);
  const add = (field: 'upserts' | 'removes' | 'events' | 'automaticLinks', value: unknown) => {
    const cost = jsonByteLength(value) + 1;
    if (cost + jsonByteLength(empty()) > MAX_MESSAGE_BYTES - 1024) throw new BridgeActionError('too_large', 'One inventory item exceeds the bridge budget.');
    const countLimit = { upserts: 5000, removes: 10_000, automaticLinks: 50, events: 100 }[field];
    if (bytes + cost > MAX_MESSAGE_BYTES - 1024 || packet[field].length >= countLimit) { packets.push(packet); packet = empty(); bytes = jsonByteLength(packet); }
    (packet[field] as unknown[]).push(value); bytes += cost;
  };
  for (const value of upserts) add('upserts', value);
  for (const value of removes) add('removes', value);
  for (const value of events) add('events', value);
  for (const value of automaticLinks) add('automaticLinks', value);
  if (packet.upserts.length || packet.removes.length || packet.events.length || packet.automaticLinks.length) packets.push(packet);
  return packets;
}

export { commitOfBuildId };
/** AC-1: the plugin names the founder's browser, so Edge must not show as "Chromium". */
export function detectBrowserName(nav: { userAgent?: string; userAgentData?: { brands?: Array<{ brand: string }> } } | undefined = typeof navigator === 'undefined' ? undefined : navigator as never): string {
  const brands = (nav?.userAgentData?.brands ?? []).map(b => b.brand);
  const ua = nav?.userAgent ?? '';
  if (brands.includes('Microsoft Edge') || / Edg\//.test(ua)) return 'Microsoft Edge';
  if (brands.includes('Google Chrome')) return 'Google Chrome';
  if (/ Chrome\//.test(ua) && !/ (OPR|Brave|Vivaldi)\//.test(ua) && !brands.length) return 'Google Chrome';
  return 'Chromium';
}

function emptyCompany(): BridgeCompanyState { return { token: '', shared: false, revoked: false, pending: null, lastSeenAt: 0, lastError: '', pluginVersion: '', pluginCommit: '', fingerprints: {}, links: [] }; }
export function normalizeBridgeState(raw: unknown): BridgeState {
  const data = isObject(raw) ? raw : {};
  const companies: Record<string, BridgeCompanyState> = {};
  if (isObject(data.companies)) for (const [id, value] of Object.entries(data.companies)) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id) || !isObject(value)) continue;
    const c = emptyCompany();
    if (typeof value.token === 'string' && /^[A-Za-z0-9_-]{32,128}$/.test(value.token)) c.token = value.token;
    c.revoked = value.revoked === true; c.shared = !c.revoked && value.shared === true; c.lastSeenAt = typeof value.lastSeenAt === 'number' ? value.lastSeenAt : 0;
    for (const field of ['lastError', 'pluginVersion', 'pluginCommit'] as const) if (typeof value[field] === 'string') c[field] = value[field].slice(0, 500);
    if (isObject(value.fingerprints)) for (const [key, fingerprint] of Object.entries(value.fingerprints)) if (key.length <= 600 && typeof fingerprint === 'string' && fingerprint.length <= 128) c.fingerprints[key] = fingerprint;
    if (Array.isArray(value.links)) c.links = value.links.filter((v): v is SessionLink => isObject(v) && v.companyId === id && typeof v.threadKey === 'string' && typeof v.issueId === 'string' && ['user', 'auto', 'agent'].includes(String(v.origin))).slice(0, 10_000);
    const p = value.pending;
    if (isObject(p) && typeof p.pairId === 'string' && typeof p.code === 'string' && typeof p.pollToken === 'string' && typeof p.expiresAt === 'number') c.pending = { pairId: p.pairId, code: p.code, pollToken: p.pollToken, expiresAt: p.expiresAt };
    companies[id] = c;
  }
  return { serverUrl: typeof data.serverUrl === 'string' ? normalizeServerUrl(data.serverUrl) ?? '' : '', companies, policy: normalizeActionPolicy(data.policy), allowRemoteModels: data.allowRemoteModels === true, shareTranscripts: data.shareTranscripts !== false };
}

export function memoryBridgeStorage(initial?: Partial<BridgeState>): BridgeStorage {
  let data: unknown = initial ?? {};
  return { read: async () => structuredClone(data), write: async state => { data = structuredClone(state); } };
}
export function chromeBridgeStorage(): BridgeStorage {
  return { async read() { return (await chrome.storage.local.get(BRIDGE_STORAGE_KEY))[BRIDGE_STORAGE_KEY]; }, async write(state) { await chrome.storage.local.set({ [BRIDGE_STORAGE_KEY]: state }); } };
}

export interface PaperclipBridgeDeps {
  db: ThreadStackDB; storage?: BridgeStorage; actionJournal?: ActionJournal;
  settings?: () => Promise<SettingsRecord>; fetch?: typeof fetch; now?: () => number;
  extensionVersion: string; extensionCommit: string; browser?: string;
  executeAction?: (action: AgentAction, signal: AbortSignal) => Promise<ActionOutcome>;
  openThread?: (threadKey: string) => Promise<void>;
  openView?: (view: 'browse' | 'threads' | 'dashboard') => Promise<void>;
  onHint?: (hint: ChangedHint) => Promise<void> | void;
  onChange?: (state: PublicBridgeState) => void;
  /** A company's bridge failed (poll, connect, revocation); cached secrets must not outlive it. */
  onDisconnect?: (companyId: string) => void;
  observations?: SessionObservations;
  log?: (message: string) => void;
}

/** One worker owns the durable pairing and live poll, independent from the manager lifetime. */
export class PaperclipBridge {
  private state: BridgeState | null = null;
  private readonly storage: BridgeStorage;
  private mutations: Promise<unknown> = Promise.resolve();
  private running = false;
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private pollAbort = new Set<AbortController>();
  private ticks = new Map<string, Promise<void>>();
  private requestTasks = new Map<string, Promise<void>>();
  private connected = new Set<string>();
  private pendingEvents = new Map<string, Map<string, SessionStateChange>>();
  private automaticLinkDigests = new Map<string, string>();
  /** Memory only: after a worker restart a rejected row is offered once more. */
  private rejectedFingerprints = new Map<string, Map<string, string>>();
  private legacyIssueChecks = new Map<string, { at: number; promise: Promise<string | null> }>();
  private readonly actions: BrowserActionGuard;
  constructor(private readonly deps: PaperclipBridgeDeps) {
    this.storage = deps.storage ?? chromeBridgeStorage();
    this.actions = new BrowserActionGuard({ db: deps.db, journal: deps.actionJournal ?? chromeActionJournal(), now: deps.now,
      policy: async () => (await this.load()).policy,
      links: async id => (await this.load()).companies[id]?.links ?? [],
      execute: deps.executeAction ?? (async () => { throw new BridgeActionError('browser_offline', 'Open the ThreadStack window to act in browser sessions.'); }),
      // Provider pages change; an adapter or page failure is recorded in Diagnostics (REQ-11 FR-6, F-5).
      onFailure: (action, error) => deps.log?.(`Paperclip agent ${action.type === 'session.send' ? 'send' : 'start'} on ${action.provider} failed: ${error.code}: ${error.message.slice(0, 200)}`),
    });
  }
  private now(): number { return (this.deps.now ?? Date.now)(); }
  private settings(): Promise<SettingsRecord> { return this.deps.settings?.() ?? ensureStarterCollectionsAndSettings(this.deps.db); }
  private async load(): Promise<BridgeState> { if (!this.state) this.state = normalizeBridgeState(await this.storage.read()); return this.state; }
  private async mutate(fn: (state: BridgeState) => void): Promise<void> {
    const run = this.mutations.then(async () => { const state = await this.load(); fn(state); await this.storage.write(state); this.deps.onChange?.(this.publicState(state)); });
    this.mutations = run.catch(() => undefined); await run;
  }
  private publicState(state: BridgeState): PublicBridgeState {
    return { ...state, policy: { ...state.policy, providers: [...state.policy.providers] }, companies: Object.fromEntries(Object.entries(state.companies).map(([id, c]) => {
      const { token, fingerprints, pending, revoked, ...rest } = c;
      return [id, { ...rest, paired: Boolean(token) && !revoked, connected: Boolean(token) && !revoked && this.now() - c.lastSeenAt < 40_000, pendingDisconnect: revoked, sessionCount: Object.keys(fingerprints).length, pending: pending ? { code: pending.code, expiresAt: pending.expiresAt } : null }];
    })) };
  }
  async status(): Promise<PublicBridgeState> { return this.publicState(await this.load()); }
  async getToken(companyId: string): Promise<string | null> { const company = (await this.load()).companies[companyId]; return company && !company.revoked ? company.token || null : null; }
  isConnected(): boolean { return Boolean(this.state && Object.values(this.state.companies).some(c => c.token && !c.revoked && this.now() - c.lastSeenAt < 40_000)); }

  private async call(path: string, body: Record<string, unknown>, token = '', timeoutMs = 10_000): Promise<Record<string, unknown>> {
    const settings = await this.settings(); const origin = normalizeServerUrl(settings.paperclip.serverUrl);
    if (!origin) throw new BridgeActionError('bad_request', 'Paperclip server address is invalid.');
    const state = await this.load();
    if (state.serverUrl && state.serverUrl !== origin) {
      this.actions.cancelPending(); this.connected.clear();
      await this.mutate(s => { s.companies = {}; s.serverUrl = origin; s.policy = { ...DEFAULT_ACTION_POLICY, providers: [], disabledAt: this.now() }; });
      if (token) throw new BridgeActionError('not_paired', 'Pair with this Paperclip server first.');
    } else if (!state.serverUrl) await this.mutate(s => { s.serverUrl = origin; });
    const controller = new AbortController(); this.pollAbort.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/json' };
    if (settings.paperclip.auth === 'board_key' && settings.paperclip.apiKey) headers.Authorization = `Bearer ${settings.paperclip.apiKey}`;
    if (token) headers['X-Threadkeeper-Bridge-Token'] = token;
    try {
      const response = await (this.deps.fetch ?? fetch)(`${origin}${BRIDGE_API_PATH}/${path}`, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', redirect: 'error', body: JSON.stringify(body), signal: controller.signal });
      const text = await response.text();
      if (new TextEncoder().encode(text).byteLength > MAX_MESSAGE_BYTES) throw new BridgeActionError('too_large', 'Paperclip bridge response is too large.');
      const data: unknown = JSON.parse(text);
      if (!isObject(data)) throw new BridgeActionError('bad_request', 'Paperclip bridge returned an invalid response.');
      // A disabled, missing or failed plugin answers with Paperclip's own `{ error: "<message>" }` (FR-9).
      if (!response.ok && typeof data.error === 'string' && response.status !== 401) throw new BridgeActionError('unsupported', `Paperclip plugin "browser-sessions": ${data.error.slice(0, 300)}`);
      if (!response.ok || data.ok === false || isObject(data.error)) {
        const error = isObject(data.error) ? data.error : {};
        throw new BridgeActionError((typeof error.code === 'string' ? error.code : response.status === 401 ? 'not_paired' : 'internal') as BridgeErrorCode, typeof error.message === 'string' ? error.message : 'Paperclip bridge request failed.');
      }
      return data;
    } finally { clearTimeout(timer); this.pollAbort.delete(controller); }
  }

  private handshake(companyId: string): Record<string, unknown> { return { companyId, protocol: BRIDGE_PROTOCOL, extensionVersion: this.deps.extensionVersion, extensionCommit: commitOfBuildId(this.deps.extensionCommit), browser: this.deps.browser ?? detectBrowserName() }; }
  async pair(companyId: string): Promise<PublicBridgeState> {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(companyId)) throw new BridgeActionError('bad_request', 'companyId is required.');
    const response = await this.call('pair/start', this.handshake(companyId));
    const expiresAt = typeof response.expiresAt === 'number' ? response.expiresAt : Date.parse(String(response.expiresAt));
    if (typeof response.pairId !== 'string' || typeof response.code !== 'string' || !/^[A-Za-z0-9]{8}$/.test(response.code) || typeof response.pollToken !== 'string' || !Number.isFinite(expiresAt)) throw new BridgeActionError('bad_request', 'Paperclip returned invalid pairing details.');
    await this.mutate(s => { s.companies[companyId] = { ...emptyCompany(), pending: { pairId: response.pairId as string, code: response.code as string, pollToken: response.pollToken as string, expiresAt } }; });
    return this.status();
  }
  async pollPair(companyId: string): Promise<PublicBridgeState> {
    const pending = (await this.load()).companies[companyId]?.pending;
    if (!pending) return this.status();
    if (pending.expiresAt <= this.now()) { await this.mutate(s => { s.companies[companyId].pending = null; s.companies[companyId].lastError = 'Pairing code expired. Pair again.'; }); return this.status(); }
    const response = await this.call('pair/poll', { companyId, pairId: pending.pairId, pollToken: pending.pollToken });
    if (response.status === 'paired') {
      if (typeof response.bridgeToken !== 'string' || !/^[A-Za-z0-9_-]{32,128}$/.test(response.bridgeToken)) throw new BridgeActionError('bad_request', 'Paperclip returned an invalid bridge token.');
      await this.mutate(s => { const c = s.companies[companyId]; c.token = response.bridgeToken as string; c.shared = response.shared === true; c.pending = null; });
      this.connected.delete(companyId);
    }
    return this.status();
  }
  async share(companyId: string, shared: boolean): Promise<PublicBridgeState> {
    const token = await this.getToken(companyId); if (!token) throw new BridgeActionError('not_paired', 'Pair with Paperclip first.');
    await this.mutate(s => { const c = s.companies[companyId]; c.shared = shared; if (!shared) { c.fingerprints = {}; c.links = []; } });
    if (!shared) { this.actions.cancelPending(); this.connected.delete(companyId); }
    await this.call('bridge/share', { companyId, shared }, token);
    return this.status();
  }
  async disconnect(companyId?: string): Promise<PublicBridgeState> {
    const state = await this.load(); const ids = companyId ? [companyId] : Object.keys(state.companies);
    this.actions.cancelPending();
    // Persist a revocation before I/O. Its token remains private solely to retry revocation.
    await this.mutate(s => { for (const id of ids) { const c = s.companies[id]; if (c) { c.revoked = true; c.shared = false; c.pending = null; c.links = []; c.fingerprints = {}; c.lastSeenAt = 0; } } });
    for (const id of ids) {
      const token = state.companies[id]?.token; this.connected.delete(id);
      try { if (token) await this.call('bridge/disconnect', { companyId: id }, token); await this.mutate(s => { delete s.companies[id]; }); }
      catch { await this.mutate(s => { if (s.companies[id]) s.companies[id].lastError = 'Disconnected here. Paperclip will forget this bridge when it is reachable again.'; }); }
    }
    return this.status();
  }
  async setPolicy(input: unknown): Promise<PublicBridgeState> {
    const policy = normalizeActionPolicy(input); const before = (await this.load()).policy;
    if ((!policy.enabled && before.enabled) || before.providers.some(p => !policy.providers.includes(p))) policy.disabledAt = Math.max(this.now(), before.disabledAt + 1);
    else policy.disabledAt = Math.max(policy.disabledAt, before.disabledAt);
    await this.mutate(s => { s.policy = policy; });
    this.actions.cancelPending();
    for (const [companyId, c] of Object.entries((await this.load()).companies)) if (c.token) await this.call('bridge/policy', { companyId, policy }, c.token);
    return this.status();
  }
  async options(input: { allowRemoteModels?: boolean; shareTranscripts?: boolean }): Promise<PublicBridgeState> {
    await this.mutate(s => { if (typeof input.allowRemoteModels === 'boolean') s.allowRemoteModels = input.allowRemoteModels; if (typeof input.shareTranscripts === 'boolean') s.shareTranscripts = input.shareTranscripts; }); return this.status();
  }
  async resolveSecret(companyId: string, keyName: string): Promise<string> {
    const token = await this.getToken(companyId); if (!token) throw new BridgeActionError('not_paired', 'Pair with Paperclip first.');
    // A secret value must never cross a LAN or remote network in cleartext.
    if (!secretTransportAllowed((await this.settings()).paperclip.serverUrl)) throw new BridgeActionError('denied', SECRET_TRANSPORT_REFUSED);
    // The plugin answers a bad token here with 403 `denied` (REQ-14 FR-2); that, like 401, means not paired.
    const response = await this.call('bridge/secret', { companyId, keyName }, token).catch((err: unknown) => {
      if (err instanceof BridgeActionError && err.code === 'denied' && /only the paired extension/i.test(err.message)) throw new BridgeActionError('not_paired', 'Pair with Paperclip again to use its model keys.');
      throw err;
    });
    if (typeof response.value !== 'string') throw new BridgeActionError('not_found', 'The linked secret is missing.');
    return response.value;
  }

  async handleCommand(action: string, payload: unknown = {}): Promise<PublicBridgeState> {
    const p = isObject(payload) ? payload : {};
    const companyId = typeof p.companyId === 'string' ? p.companyId : '';
    switch (action) {
      case 'status': return this.status(); case 'pair': return this.pair(companyId); case 'pair_poll': return this.pollPair(companyId);
      case 'share': return this.share(companyId, p.shared === true); case 'disconnect': return this.disconnect(companyId || undefined);
      case 'policy': return this.setPolicy(p.policy ?? p); case 'options': return this.options(p);
      default: throw new BridgeActionError('unsupported', 'Unsupported Paperclip integration action.');
    }
  }

  private async adopt(companyId: string, data: Record<string, unknown>, handshake = false): Promise<void> {
    if (handshake && data.protocol !== BRIDGE_PROTOCOL) throw new BridgeActionError('version_mismatch', 'Paperclip and ThreadStack use different bridge protocols.');
    await this.mutate(s => {
      const c = s.companies[companyId]; if (!c) return;
      c.lastSeenAt = this.now(); c.lastError = '';
      if (typeof data.shared === 'boolean') { if (c.shared && !data.shared) this.actions.cancelPending(); c.shared = c.shared && data.shared; if (!c.shared) c.fingerprints = {}; }
      if (typeof data.pluginVersion === 'string') c.pluginVersion = data.pluginVersion;
      if (typeof data.pluginCommit === 'string') c.pluginCommit = data.pluginCommit;
      if (isObject(data.fingerprints)) c.fingerprints = Object.fromEntries(Object.entries(data.fingerprints).filter(([key, v]) => key.length <= 600 && typeof v === 'string')) as Record<string, string>;
      if (Array.isArray(data.links)) {
        const links = data.links.filter((l): l is SessionLink => isObject(l) && l.companyId === companyId && typeof l.threadKey === 'string' && typeof l.issueId === 'string' && ['user', 'auto', 'agent'].includes(String(l.origin)));
        // Only sends whose own link vanished stop; other pending actions continue (F-3).
        if (c.links.some(old => !links.some(next => next.id === old.id && next.origin === old.origin && next.startedByAgentId === old.startedByAgentId))) this.actions.revalidateLinks(companyId, links);
        c.links = links;
      }
      if (isObject(data.policy)) { const next = mergeActionPolicy(s.policy, normalizeActionPolicy(data.policy)); if (JSON.stringify(next) !== JSON.stringify(s.policy)) this.actions.cancelPending(); s.policy = next; }
    });
  }

  private async syncInventory(companyId: string, token: string): Promise<void> {
    const state = await this.load(); const company = state.companies[companyId]; if (!company?.shared) return;
    const settings = await this.settings();
    let rows = await buildSessionInventory(this.deps.db, settings, { observations: this.deps.observations });
    // A privacy or grant change while collecting must be respected before posting any rows.
    const latest = new Set((await buildSessionInventory(this.deps.db, undefined, { observations: this.deps.observations })).map(row => row.threadKey)); rows = rows.filter(row => latest.has(row.threadKey));
    if (!(await this.load()).companies[companyId]?.shared) return;
    const current = new Map(rows.map(r => [r.threadKey, r]));
    // A row Paperclip rejected is not resent (nor logged again) until its fingerprint changes.
    const rejected = this.rejectedFingerprints.get(companyId) ?? new Map<string, string>();
    this.rejectedFingerprints.set(companyId, rejected);
    for (const key of [...rejected.keys()]) if (current.get(key)?.fingerprint !== rejected.get(key)) rejected.delete(key);
    const upserts = rows.filter(r => company.fingerprints[r.threadKey] !== r.fingerprint && rejected.get(r.threadKey) !== r.fingerprint);
    const removes = Object.keys(company.fingerprints).filter(key => !current.has(key));
    const pending = this.pendingEvents.get(companyId);
    const events = [...(pending?.values() ?? [])].filter(event => { const row = current.get(event.threadKey); return row?.observed && row.agentState === event.to; });
    if (pending) for (const [key, event] of pending) if (!events.includes(event)) pending.delete(key);
    const automaticLinks = await buildAutomaticSessionLinks(this.deps.db, companyId, {
      settings, canVerifyIssue: id => { const last = this.legacyIssueChecks.get(id); return !last || this.now() - last.at > 60_000; },
      verifyIssueCompany: id => {
        const previous = this.legacyIssueChecks.get(id); if (previous && this.now() - previous.at <= 60_000) return previous.promise;
        const client = new PaperclipClient({ serverUrl: settings.paperclip.serverUrl, apiKey: settings.paperclip.auth === 'board_key' ? settings.paperclip.apiKey : '', timeoutMs: 2000, maxRateLimitRetries: 0, fetch: this.deps.fetch });
        const promise = client.getIssue(id).then(issue => issue.id === id && typeof issue.companyId === 'string' ? issue.companyId : null).catch(() => null);
        this.legacyIssueChecks.set(id, { at: this.now(), promise }); return promise;
      },
    });
    const autoDigest = computeDeterministicHash(JSON.stringify(automaticLinks));
    const projected = this.automaticLinkDigests.get(companyId) === autoDigest ? [] : automaticLinks;
    const packets = buildInventoryPackets(companyId, upserts, removes, events, projected);
    let allAutomaticAccepted = true;
    for (const packet of packets) {
      if (!(await this.load()).companies[companyId]?.shared) return;
      const freshSettings = await ensureStarterCollectionsAndSettings(this.deps.db);
      const allowed = await remoteAllowedKeys(this.deps.db, freshSettings, [...packet.upserts.map(row => row.threadKey), ...packet.events.map(event => event.threadKey), ...packet.automaticLinks.map(link => link.threadKey)]);
      packet.upserts = packet.upserts.filter(row => row.provider !== 'paperclip' && allowed.has(row.threadKey));
      packet.events = packet.events.filter(event => allowed.has(event.threadKey) && this.deps.observations?.snapshot(event.threadKey)?.state === event.to);
      if (packet.automaticLinks.length) {
        const freshCandidates = new Set((await buildAutomaticSessionLinks(this.deps.db, companyId)).map(link => `${link.issueId}\0${link.threadKey}`));
        packet.automaticLinks = packet.automaticLinks.filter(link => allowed.has(link.threadKey) && freshCandidates.has(`${link.issueId}\0${link.threadKey}`));
      }
      if (!packet.upserts.length && !packet.removes.length && !packet.events.length && !packet.automaticLinks.length) continue;
      const response = await this.call('bridge/inventory', packet, token);
      const accepted = new Set(Array.isArray(response.accepted) ? response.accepted.filter((v): v is string => typeof v === 'string') : []);
      await this.mutate(s => { const c = s.companies[companyId]; if (!c) return; for (const key of packet.removes) delete c.fingerprints[key]; for (const row of packet.upserts) if (accepted.has(row.threadKey)) c.fingerprints[row.threadKey] = row.fingerprint; });
      for (const event of packet.events) pending?.delete(`${event.threadKey}:${event.at}:${event.to}`);
      // An intentionally unlinked automatic candidate is acknowledged without recreating it.
      if (packet.automaticLinks.length && (!Array.isArray(response.automaticLinksRejected) || response.automaticLinksRejected.length > 0)) allAutomaticAccepted = false;
      const sentFingerprints = new Map(packet.upserts.map(row => [row.threadKey, row.fingerprint]));
      if (Array.isArray(response.rejected)) for (const item of response.rejected) if (isObject(item) && typeof item.threadKey === 'string' && sentFingerprints.has(item.threadKey)) rejected.set(item.threadKey, sentFingerprints.get(item.threadKey)!);
      if (Array.isArray(response.rejected)) for (const item of response.rejected) if (isObject(item)) this.deps.log?.(`Paperclip rejected session ${String(item.threadKey).slice(0, 600)}: ${String(item.code).slice(0, 80)}`);
    }
    if (allAutomaticAccepted) this.automaticLinkDigests.set(companyId, autoDigest);
  }

  private async tickCompany(companyId: string): Promise<void> {
    const c = (await this.load()).companies[companyId]; if (!c?.token) return;
    try {
      if (c.revoked) { await this.call('bridge/disconnect', { companyId }, c.token); await this.mutate(s => { delete s.companies[companyId]; }); return; }
      if (!this.connected.has(companyId)) {
        this.automaticLinkDigests.delete(companyId);
        // `cancel-requests`: Paperclip cancels single requests by id instead of bumping the global switch-off time.
        const response = await this.call('bridge/connect', { ...this.handshake(companyId), policy: (await this.load()).policy, capabilities: ['cancel-requests'] }, c.token);
        if (!c.shared && response.shared === true) { await this.call('bridge/share', { companyId, shared: false }, c.token); response.shared = false; }
        await this.adopt(companyId, response, true); this.connected.add(companyId);
      }
      await this.syncInventory(companyId, c.token);
      // Inventory reconciliation also catches privacy changes; never hold it behind a 20s poll.
      const data = await this.call('bridge/poll', { companyId, waitMs: this.running ? BRIDGE_POLL_WAIT_MS : 0 }, c.token, BRIDGE_POLL_MS + 5000);
      await this.adopt(companyId, data);
      const cancelled = Array.isArray(data.cancelledRequestIds) ? data.cancelledRequestIds.filter((id): id is string => typeof id === 'string' && id.length <= 200).slice(0, 500) : [];
      if (cancelled.length) this.actions.cancelRequests(cancelled);
      if (Array.isArray(data.requests)) for (const raw of data.requests.slice(0, 50)) {
        if (!isObject(raw) || typeof raw.requestId !== 'string' || cancelled.includes(raw.requestId)) continue;
        const taskKey = `${companyId}:${raw.requestId}`;
        if (this.requestTasks.has(taskKey)) continue;
        const task = this.answerRequest(companyId, c.token, raw).catch(() => this.deps.log?.('Paperclip bridge could not deliver a request result.')).finally(() => this.requestTasks.delete(taskKey));
        this.requestTasks.set(taskKey, task);
      }
      // Hint syncs run beside the poll loop: a slow or failing fetch must neither hold this tick past the
      // plugin's offline deadline nor mark the bridge disconnected (REQ-12 F-3, F-4).
      if (Array.isArray(data.hints)) for (const hint of data.hints) if (isObject(hint) && hint.type === 'paperclip.changed' && hint.companyId === companyId && Array.isArray(hint.issueIds) && Array.isArray(hint.runIds)) this.dispatchHint(hint as unknown as ChangedHint);
    } catch (err) {
      this.connected.delete(companyId);
      try { this.deps.onDisconnect?.(companyId); } catch { /* never mask the failure */ }
      await this.mutate(s => { const company = s.companies[companyId]; if (company) { company.lastSeenAt = 0; company.lastError = err instanceof BridgeActionError ? `${err.code}: ${err.message}` : 'Paperclip bridge is not connected.'; if (err instanceof BridgeActionError && err.code === 'not_paired') { company.token = ''; company.shared = false; company.links = []; company.fingerprints = {}; } } });
      this.deps.log?.(`Paperclip bridge for ${companyId} disconnected.`);
    }
  }
  /**
   * Best effort, never throws: tell each paired company the browser is going away so agents get
   * `browser_offline` at once (REQ-8 AC-13, NF-3). Non-revoking: the pairing is kept. `keepalive` lets
   * the request outlive a suspending worker. A 404 from a plugin without the route is ignored.
   */
  async signalOffline(): Promise<void> {
    try {
      const state = this.state ?? await this.load();
      const origin = normalizeServerUrl((await this.settings()).paperclip.serverUrl);
      if (!origin || (state.serverUrl && state.serverUrl !== origin)) return;
      const settings = await this.settings();
      await Promise.allSettled(Object.entries(state.companies).filter(([, c]) => c.token && !c.revoked).map(([companyId, c]) => {
        const headers: Record<string, string> = { 'Content-Type': 'application/json', 'X-Threadkeeper-Bridge-Token': c.token };
        if (settings.paperclip.auth === 'board_key' && settings.paperclip.apiKey) headers.Authorization = `Bearer ${settings.paperclip.apiKey}`;
        return (this.deps.fetch ?? fetch)(`${origin}${BRIDGE_API_PATH}/bridge/offline`, { method: 'POST', headers, credentials: 'omit', cache: 'no-store', redirect: 'error', keepalive: true, body: JSON.stringify({ companyId }) });
      }));
    } catch { /* best effort */ }
  }
  private dispatchHint(hint: ChangedHint): void {
    if (!this.deps.onHint) return;
    void Promise.resolve().then(() => this.deps.onHint!(hint)).catch(() => this.deps.log?.(`Paperclip change hint for ${hint.companyId} could not be applied; the timer sync will catch up.`));
  }
  private async answerRequest(companyId: string, token: string, raw: Record<string, unknown>): Promise<void> {
    let result: BridgeResult;
    try {
      const request = parseBridgeRequest(raw, this.now());
      if (!(await this.load()).companies[companyId]?.shared) result = bridgeFailure(request.requestId, 'denied', 'Sessions are not shared with this company.');
      else result = request.type.startsWith('session.') ? await this.actions.run(companyId, request) : await handleBridgeRequest({ db: this.deps.db, companyId, isGranted: async id => (await this.load()).companies[id]?.shared === true, allowRemoteModels: (await this.load()).allowRemoteModels, shareTranscripts: (await this.load()).shareTranscripts, fetch: this.deps.fetch, now: this.deps.now, openThread: this.deps.openThread, openView: this.deps.openView, observations: this.deps.observations }, request);
    } catch { result = bridgeFailure(String(raw.requestId), 'bad_request', 'Invalid or expired bridge request.'); }
    // Reads and provider waits never block polling, so remote revocation remains observable.
    if (await this.getToken(companyId) !== token) return;
    if (!(await this.load()).companies[companyId]?.shared) result = bridgeFailure(result.requestId, 'denied', 'Sessions are not shared with this company.');
    else if (!String(raw.type).startsWith('session.')) result = await revalidateBridgeResult(this.deps.db, result);
    await this.call('bridge/results', { companyId, results: [result] }, token);
  }
  /** Supporting tests and controlled shutdowns may wait for owned request handlers. */
  async idle(): Promise<void> { while (this.requestTasks.size) await Promise.allSettled([...this.requestTasks.values()]); }
  async tick(): Promise<void> {
    const state = await this.load();
    const changes = this.deps.observations?.flushSettledChanges() ?? [];
    for (const [companyId, company] of Object.entries(state.companies)) {
      if (!company.shared || !company.token || company.revoked) { this.pendingEvents.delete(companyId); continue; }
      let pending = this.pendingEvents.get(companyId); if (!pending) { pending = new Map(); this.pendingEvents.set(companyId, pending); }
      for (const event of changes) pending.set(`${event.threadKey}:${event.at}:${event.to}`, event);
      while (pending.size > 500) pending.delete(pending.keys().next().value as string);
    }
    await Promise.all(Object.keys(state.companies).map(id => { const pending = this.ticks.get(id); if (pending) return pending; const task = this.tickCompany(id).finally(() => this.ticks.delete(id)); this.ticks.set(id, task); return task; }));
  }
  start(): void {
    if (this.running) return; this.running = true;
    const step = async () => { await this.tick(); if (this.running && Object.values((await this.load()).companies).some(c => c.token)) this.loopTimer = setTimeout(() => void step().catch(() => undefined), BRIDGE_LOOP_MS); else this.running = false; };
    void step().catch(() => { if (this.running) this.loopTimer = setTimeout(() => { this.running = false; this.start(); }, 5000); });
  }
  stop(): void { this.running = false; if (this.loopTimer) clearTimeout(this.loopTimer); this.loopTimer = null; for (const controller of this.pollAbort) controller.abort(); this.actions.cancelPending(); }
}
