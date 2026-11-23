import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { PluginContext, PluginEvent, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import { ACTION_REPORT_MARGIN_MS, ACTION_SETTLE_MS, START_TIMEOUT_MS, CREDENTIAL_KEYS, INVENTORY_COUNT_LIMITS, MAX_MESSAGE_BYTES, OFFLINE_MS, PLUGIN_VERSION, PROTOCOL, REQUEST_TIMEOUT_MS, SessionError, parsePolicy, record, requiredString, validateSession, type ActionPolicy, type ActionRecord, type BridgeRequest, type BridgeResult, type ChangedHint, type SessionLink, type SessionRow, type StateChange } from "./contracts.js";
import type { Store } from "./store.js";
import { executeSessionTool } from "./tools.js";
import { processStateChange } from "./state-changes.js";

export type SessionHost = Pick<PluginContext, "config" | "issues" | "agents" | "secrets" | "activity" | "events"> & Partial<Pick<PluginContext, "streams" | "companies">>;
export interface BridgeState {
  tokenHash: string | null; shared: boolean; lastSeenAt: number; extensionVersion: string; extensionCommit: string; browser: string;
  policy: ActionPolicy; extensionPolicy: ActionPolicy; trustedAgentIds: string[]; eventsEnabled: boolean; versionMismatch: boolean;
  /** Set by the extension's offline signal; cleared by its next connect or poll. Never revokes pairing or sharing. */
  offline?: boolean;
  /** Announced at connect. `cancel-requests`: the extension aborts requests listed in `cancelledRequestIds`. */
  extensionCapabilities?: string[];
}
interface Pair { pairId: string; code: string; pollHash: string; expiresAt: number; confirmed: boolean; shared: boolean; claimed: boolean }
interface Pending { companyId: string; request: BridgeRequest; timeoutMs: number; provider?: string; handedOut: boolean; cancelled?: Error; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
export { ACTION_REPORT_MARGIN_MS, ACTION_SETTLE_MS } from "./contracts.js";
export const OFFLINE_MESSAGE = "The founder's browser is not connected. Continue without session data or ask the board to open the browser.";
export const UNKNOWN_DELIVERY_MESSAGE = "The message may or may not have been sent. Read the session before trying again.";
const isAction = (type: string) => type.startsWith("session.");
export function digest(value: string): string { return createHash("sha256").update(value).digest("hex"); }
export function pairingCode(bytes: Uint8Array = randomBytes(8)): string {
  if (bytes.length !== 8) throw new Error("Pairing codes require eight random bytes");
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return Array.from(bytes, (byte) => alphabet[byte & 31]).join("");
}
function validError(error: unknown): error is { code: string; message: string } { return !!error && typeof error === "object" && typeof (error as { code?: unknown }).code === "string" && typeof (error as { message?: unknown }).message === "string"; }
function equalHash(a: string, b: string) { const left = Buffer.from(a); const right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right); }
/** D-11: the extension's buildId is `{stamp}-{sha}`; only the commit part is compared. */
export function commitPart(buildId: string): string { const value = buildId.trim().slice(0, 100); return value.includes("-") ? value.slice(value.lastIndexOf("-") + 1) : value; }
function sameCommit(a: string, b: string) { return a === b || Math.min(a.length, b.length) >= 7 && (a.startsWith(b) || b.startsWith(a)); }
/** An observation older than this is no longer a claim about the page (the extension refreshes observed rows about every 10 s). */
export const OBSERVATION_STALE_MS = 120_000;
export function providerLabel(provider: string) { return ({ claude: "Claude", claude_code: "Claude Code", chatgpt: "ChatGPT", codex: "Codex", gemini: "Gemini" } as Record<string, string>)[provider] ?? provider; }
export class BrowserSessionsService {
  readonly store: Store; readonly host: SessionHost; readonly commit: string; readonly now: () => number;
  private readonly pending = new Map<string, Pending>();
  /** Actions the browser held when the plugin stopped waiting; a late verdict is still recorded. */
  private readonly settled = new Map<string, { companyId: string; request: BridgeRequest; at: number }>();
  /** Held actions the plugin withdrew. Listed in every poll until the browser's verdict arrives or `deadlineAt` passes. */
  private readonly cancelledIds = new Map<string, { companyId: string; deadlineAt: number; notified: boolean }>();
  private readonly waiters = new Map<string, () => void>();
  private readonly hintBuffers = new Map<string, { issueIds: Set<string>; runIds: Set<string>; timer: ReturnType<typeof setTimeout> }>();
  private readonly hints = new Map<string, ChangedHint[]>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly expiryDeadlines = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(options: { store: Store; host: SessionHost; commit?: string; now?: () => number }) { this.store = options.store; this.host = options.host; this.commit = options.commit ?? "unknown"; this.now = options.now ?? (() => Date.now()); }
  async serial<T>(companyId: string, work: () => Promise<T>): Promise<T> {
    const predecessor = this.locks.get(companyId) ?? Promise.resolve();
    const current = predecessor.catch(() => {}).then(work); this.locks.set(companyId, current);
    try { return await current; } finally { if (this.locks.get(companyId) === current) this.locks.delete(companyId); }
  }
  async state(companyId: string): Promise<BridgeState> {
    return await this.store.get<BridgeState>("bridge", companyId, "current") ?? { tokenHash: null, shared: false, lastSeenAt: 0, extensionVersion: "", extensionCommit: "", browser: "", policy: { enabled: false, providers: [], disabledAt: 0 }, extensionPolicy: { enabled: false, providers: [], disabledAt: 0 }, trustedAgentIds: [], eventsEnabled: true, versionMismatch: false };
  }
  async saveState(companyId: string, state: BridgeState) { await this.store.put("bridge", companyId, "current", state); }
  changed(companyId: string) { const channel = `sessions:${companyId}`; this.host.streams?.open(channel, companyId); this.host.streams?.emit(channel, { type: "changed", at: this.now() }); }
  private heartbeatDeadline(companyId: string) {
    const old = this.expiryDeadlines.get(companyId); if (old) clearTimeout(old);
    this.expiryDeadlines.set(companyId, setTimeout(() => { this.expiryDeadlines.delete(companyId); this.changed(companyId); this.cancelRequests(companyId, new SessionError("browser_offline", OFFLINE_MESSAGE)); }, OFFLINE_MS + 1));
  }
  /** Seen within OFFLINE_MS and not signed off by the extension. */
  online(state: BridgeState): boolean { return !state.offline && state.lastSeenAt > 0 && this.now() - state.lastSeenAt <= OFFLINE_MS; }
  /** REQ-8 AC-13: the extension says it is going away, so callers get browser_offline at once, not after 40 s. */
  async offline(companyId: string, token: string) {
    return this.serial(companyId, async () => {
      const state = await this.authenticate(companyId, token); state.offline = true; await this.saveState(companyId, state);
      const deadline = this.expiryDeadlines.get(companyId); if (deadline) clearTimeout(deadline); this.expiryDeadlines.delete(companyId);
      this.cancelRequests(companyId, new SessionError("browser_offline", OFFLINE_MESSAGE)); this.wake(companyId); this.changed(companyId);
      return { offline: true };
    });
  }
  async authenticate(companyId: string, token: string): Promise<BridgeState> {
    const state = await this.state(companyId);
    if (!state.tokenHash || !token || !equalHash(state.tokenHash, digest(token))) throw new SessionError("not_paired", "The browser is not paired.");
    return state;
  }
  async requireShared(companyId: string): Promise<BridgeState> {
    const state = await this.state(companyId);
    if (!state.tokenHash || !state.shared) throw new SessionError("denied", "Sessions are not shared with this company.");
    if (state.versionMismatch) throw new SessionError("version_mismatch", "Version mismatch");
    return state;
  }
  effectivePolicy(state: BridgeState): ActionPolicy {
    return { enabled: state.policy.enabled && state.extensionPolicy.enabled, providers: state.policy.providers.filter((p) => state.extensionPolicy.providers.includes(p)), disabledAt: Math.max(state.policy.disabledAt, state.extensionPolicy.disabledAt) };
  }
  async startPair(companyId: string, input: Record<string, unknown>) {
    if (input.protocol !== PROTOCOL) throw new SessionError("version_mismatch", "Version mismatch");
    return this.serial(companyId, async () => {
      if ((await this.state(companyId)).tokenHash) {
        const company = await this.host.companies?.get(companyId).catch(() => null);
        throw new SessionError("busy", `Another browser is already connected for ${company?.name || "this company"}. Disconnect it first.`);
      }
      await this.store.remove("pair", companyId);
      const pollToken = randomBytes(32).toString("base64url");
      const pair: Pair = { pairId: randomUUID(), code: pairingCode(), pollHash: digest(pollToken), expiresAt: this.now() + 600_000, confirmed: false, shared: false, claimed: false };
      await this.store.put("pair", companyId, pair.pairId, pair);
      await this.audit(companyId, "browser_sessions.pair_requested", { pairId: pair.pairId });
      return { pairId: pair.pairId, code: pair.code, pollToken, expiresAt: new Date(pair.expiresAt).toISOString() };
    });
  }
  async confirmPair(companyId: string, code: string, shared: boolean, actor: string) {
    return this.serial(companyId, async () => {
      const pair = (await this.store.list<Pair>("pair", companyId)).find((p) => p.code === code.trim().toUpperCase() && p.expiresAt > this.now() && !p.claimed);
      if (!pair) throw new SessionError("not_found", "Pairing code was not found or expired.");
      pair.confirmed = true; pair.shared = shared; await this.store.put("pair", companyId, pair.pairId, pair);
      await this.audit(companyId, "browser_sessions.pair_confirmed", { actor, pairId: pair.pairId, shared }); return { confirmed: true };
    });
  }
  async pollPair(companyId: string, pairId: string, pollToken: string): Promise<Record<string, unknown>> {
    return this.serial(companyId, async () => {
      const pair = await this.store.get<Pair>("pair", companyId, pairId);
      if (!pair || pair.expiresAt <= this.now() || !equalHash(pair.pollHash, digest(pollToken))) throw new SessionError("not_paired", "Pairing request expired.");
      if (!pair.confirmed) return { status: "pending" };
      const state = await this.state(companyId);
      // A poll token mints exactly one bridge token; a replay never supersedes the extension's token.
      if (pair.claimed) throw new SessionError("not_paired", "Pairing request was already claimed.");
      const bridgeToken = randomBytes(32).toString("base64url");
      state.tokenHash = digest(bridgeToken); state.shared = pair.shared; state.lastSeenAt = 0;
      await this.saveState(companyId, state); pair.claimed = true; await this.store.put("pair", companyId, pairId, pair);
      await this.audit(companyId, "browser_sessions.sharing_changed", { shared: state.shared, actor: "pairing" });
      return { status: "paired", bridgeToken, shared: state.shared };
    });
  }
  async connect(companyId: string, token: string, input: Record<string, unknown>) {
    return this.serial(companyId, async () => {
    const state = await this.authenticate(companyId, token);
    if (input.protocol !== PROTOCOL) { state.versionMismatch = true; await this.saveState(companyId, state); await this.store.remove("session", companyId); this.changed(companyId); throw new SessionError("version_mismatch", "Version mismatch"); }
    state.versionMismatch = false; state.offline = false; state.lastSeenAt = this.now();
    state.extensionCapabilities = Array.isArray(input.capabilities) ? input.capabilities.filter((c): c is string => c === "cancel-requests") : []; state.extensionVersion = String(input.extensionVersion ?? "").slice(0, 100); state.extensionCommit = commitPart(String(input.extensionCommit ?? "")); state.browser = String(input.browser ?? "").slice(0, 100);
    const extensionPolicy = parsePolicy(input.policy ?? {}); extensionPolicy.disabledAt = Math.max(extensionPolicy.disabledAt, state.extensionPolicy.disabledAt); state.extensionPolicy = extensionPolicy;
    // Reconnecting can only narrow permission. A board action is required to turn it on again.
    state.policy = this.effectivePolicy(state); await this.saveState(companyId, state); this.heartbeatDeadline(companyId); this.changed(companyId);
    const rows = state.shared ? await this.store.list<SessionRow>("session", companyId) : [];
    return { protocol: PROTOCOL, pluginVersion: PLUGIN_VERSION, pluginCommit: this.commit, shared: state.shared, fingerprints: Object.fromEntries(rows.map((r) => [r.threadKey, r.fingerprint])), policy: this.effectivePolicy(state), links: state.shared ? await this.links(companyId) : [] };
    });
  }
  async status(companyId: string) {
    const state = await this.state(companyId);
    return { connected: !!state.tokenHash && !state.versionMismatch && this.online(state), shared: !!state.tokenHash && state.shared, lastSeenAt: state.lastSeenAt ? new Date(state.lastSeenAt).toISOString() : null, protocol: PROTOCOL, pluginVersion: PLUGIN_VERSION, pluginCommit: this.commit, extensionCommit: state.extensionCommit, browser: state.browser, sessionCount: state.shared && !state.versionMismatch ? (await this.store.list<SessionRow>("session", companyId)).length : 0, versionMismatch: state.versionMismatch, warning: state.extensionCommit && !sameCommit(state.extensionCommit, commitPart(this.commit)) ? `Threadkeeper and Paperclip were built from different commits (${state.extensionCommit} and ${this.commit}).` : null, policy: state.policy, effectivePolicy: this.effectivePolicy(state) };
  }
  private wake(companyId: string) { const wake = this.waiters.get(companyId); if (wake) { this.waiters.delete(companyId); wake(); } }
  async request(companyId: string, type: string, params: Record<string, unknown>, timeoutMs = REQUEST_TIMEOUT_MS, requestId: string = randomUUID()): Promise<unknown> {
    const state = await this.requireShared(companyId); let provider: string | undefined;
    if (isAction(type)) {
      const policy = this.effectivePolicy(state);
      if (!policy.enabled || params.policyDisabledAt !== policy.disabledAt) throw new SessionError("disabled", "Agent actions are turned off.");
      if (!state.trustedAgentIds.includes(String(params.agentId))) throw new SessionError("denied", "This agent is not trusted for browser actions.");
      if (type === "session.send") {
        const threadKey = String(params.threadKey); const row = await this.store.get<SessionRow>("session", companyId, threadKey);
        const links = await this.store.list<SessionLink>("link", companyId, { where: { threadKey, issueId: String(params.issueId) } });
        if (!row || !links.some((link) => link.origin === "user" || link.origin === "auto" || link.startedByAgentId === params.agentId)) throw new SessionError("denied", "The session is not linked to the task you are working on.");
        if (!policy.providers.includes(row.provider)) throw new SessionError("disabled", `${providerLabel(row.provider)} is not enabled for agent actions.`);
        provider = row.provider;
      } else if (!policy.providers.includes(String(params.provider))) throw new SessionError("disabled", `${providerLabel(String(params.provider))} is not enabled for agent actions.`);
      else provider = String(params.provider);
    }
    if (!this.online(state)) throw new SessionError("browser_offline", OFFLINE_MESSAGE);
    if ([...this.pending.values()].filter((p) => p.companyId === companyId).length >= 100) throw new SessionError("busy", "The browser request queue is full.");
    const createdAt = this.now();
    const request: BridgeRequest = { requestId, type, params, createdAt, deadlineAt: createdAt + timeoutMs - (isAction(type) ? Math.min(ACTION_REPORT_MARGIN_MS, timeoutMs / 2) : 0) };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.expire(request.requestId), timeoutMs);
      this.pending.set(request.requestId, { companyId, request, timeoutMs, provider, handedOut: false, resolve, reject, timer }); this.wake(companyId);
    });
  }
  /** Once the browser holds an action, only its own verdict is definite; otherwise the outcome is unknown. */
  private uncertain(id: string, pending: Pending) {
    this.pending.delete(id); clearTimeout(pending.timer);
    for (const [key, old] of this.settled) if (this.settled.size >= 1000 || this.now() - old.at > 600_000) this.settled.delete(key); else break;
    this.settled.set(id, { companyId: pending.companyId, request: pending.request, at: this.now() });
    pending.reject(new SessionError("unknown_delivery", UNKNOWN_DELIVERY_MESSAGE));
  }
  private expire(id: string) {
    const pending = this.pending.get(id); if (!pending) return;
    if (pending.handedOut && isAction(pending.request.type)) return this.uncertain(id, pending);
    this.pending.delete(id); pending.reject(new SessionError("timeout", `The browser did not answer in ${Math.round(pending.timeoutMs / 1000)} seconds.`));
  }
  private cancel(id: string, pending: Pending, error: Error) {
    if (!pending.handedOut || !isAction(pending.request.type)) { clearTimeout(pending.timer); this.pending.delete(id); pending.reject(error); return; }
    if (pending.cancelled) return;
    // Withdrawn from later polls, but the browser may already be typing: wait briefly for its verdict.
    pending.cancelled = error; clearTimeout(pending.timer); pending.timer = setTimeout(() => this.uncertain(id, pending), ACTION_SETTLE_MS);
    this.cancelledIds.set(id, { companyId: pending.companyId, deadlineAt: pending.request.deadlineAt, notified: false }); this.wake(pending.companyId);
  }
  async poll(companyId: string, token: string, waitMs = 20_000) {
    await this.serial(companyId, async () => { const state = await this.authenticate(companyId, token); state.lastSeenAt = this.now(); state.offline = false; await this.saveState(companyId, state); this.heartbeatDeadline(companyId); });
    if (!this.hasDeliveries(companyId) && waitMs > 0) await new Promise<void>((resolve) => {
      // The timer belongs to this active HTTP request, never to an idle SQL scan.
      this.wake(companyId); const finish = () => { clearTimeout(timer); if (this.waiters.get(companyId) === finish) this.waiters.delete(companyId); resolve(); };
      const timer = setTimeout(finish, Math.min(20_000, waitMs)); this.waiters.set(companyId, finish);
      if (this.hasDeliveries(companyId)) finish();
    });
    const fresh = await this.authenticate(companyId, token);
    const handed = fresh.shared ? [...this.pending.values()].filter((p) => p.companyId === companyId && !p.cancelled) : [];
    for (const p of handed) p.handedOut = true;
    const requests = handed.map((p) => p.request);
    const hints = this.hints.get(companyId) ?? []; this.hints.delete(companyId);
    const cancelledRequestIds: string[] = [];
    for (const [id, entry] of this.cancelledIds) { if (this.now() > entry.deadlineAt) { this.cancelledIds.delete(id); continue; } if (entry.companyId === companyId) { entry.notified = true; cancelledRequestIds.push(id); } }
    return { requests, hints, cancelledRequestIds, policy: this.effectivePolicy(fresh), links: fresh.shared ? await this.links(companyId) : [] };
  }
  private hasDeliveries(companyId: string) { return [...this.pending.values()].some((p) => p.companyId === companyId && !p.cancelled) || [...this.cancelledIds.values()].some((c) => c.companyId === companyId && !c.notified) || !!this.hints.get(companyId)?.length; }
  async results(companyId: string, token: string, results: BridgeResult[]) {
    await this.authenticate(companyId, token);
    for (const value of results.slice(0, 100)) {
      if (!value || typeof value !== "object" || typeof (value as BridgeResult).requestId !== "string") continue;
      if (this.cancelledIds.get(value.requestId)?.companyId === companyId) this.cancelledIds.delete(value.requestId);
      const malformed = (value as { ok?: unknown }).ok !== true && !((value as { ok?: unknown }).ok === false && validError((value as { error?: unknown }).error));
      const result: BridgeResult = malformed ? { requestId: value.requestId, ok: false, error: { code: "bad_request", message: "The browser sent a malformed result." } } : value;
      const pending = this.pending.get(result.requestId);
      if (!pending || pending.companyId !== companyId) { const late = this.settled.get(result.requestId); if (late?.companyId === companyId) { this.settled.delete(result.requestId); await this.acceptLateResult(companyId, late.request, result); } else await this.acceptOrphanResult(companyId, result); continue; }
      this.pending.delete(result.requestId); clearTimeout(pending.timer);
      if (result.ok) pending.resolve(result.data); else pending.reject(isAction(pending.request.type) ? this.actionVerdict(pending, result.error.code, result.error.message) : new SessionError(result.error.code, result.error.message));
    }
    return { received: true };
  }
  /**
   * REQ-11 FR-1 exact texts for a browser verdict. A definite refusal of an action the plugin had
   * withdrawn reports the plugin's reason (the founder's switch or trust change); nothing was typed.
   */
  private actionVerdict(pending: Pending, code: string, message: string): SessionError {
    if (code === "unknown_delivery") return new SessionError("unknown_delivery", UNKNOWN_DELIVERY_MESSAGE);
    if (pending.cancelled instanceof SessionError) return pending.cancelled;
    if (code === "disabled") return new SessionError("disabled", /^.+ is not enabled for agent actions\.$/.test(message) ? message : "Agent actions are turned off.");
    if (code === "denied") return new SessionError("denied", message === "This agent is not trusted for browser actions." ? message : "The session is not linked to the task you are working on.");
    if (code === "timeout") return new SessionError("timeout", `The browser did not answer in ${Math.round(pending.timeoutMs / 1000)} seconds.`);
    return new SessionError(code, message);
  }
  /** Status the founder sees for a browser verdict that arrived after the agent's call ended. */
  private lateStatus(action: ActionRecord, result: BridgeResult, suffix: string) {
    const data = result.ok && result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : {};
    if (action.tool === "session_start" && data.started === true) action.delivery = { threadKey: typeof data.threadKey === "string" ? data.threadKey : null, url: typeof data.url === "string" && data.url ? data.url : null };
    return result.ok ? data.delivered === true ? `Delivered ${suffix}` : data.started === true ? `Started ${suffix}` : action.status : `Failed: ${result.error.code} ${suffix}`;
  }
  /**
   * R3 F-6: a worker restart loses the in-memory request. An admitted record that never completed is
   * found by its stored request id; the founder's record gets the verdict, the agent's cached result
   * stays empty (a retry answers unknown_delivery and never resends).
   */
  private async acceptOrphanResult(companyId: string, result: BridgeResult) {
    await this.serial(companyId, async () => {
      const action = (await this.store.list<ActionRecord>("action", companyId, { where: { requestId: result.requestId }, limit: 1 }))[0];
      if (!action || !action.admitted || action.completedAt) return;
      action.status = this.lateStatus(action, result, "(reported after restart)"); action.completedAt = action.reportedLateAt = new Date(this.now()).toISOString();
      await this.store.put("action", companyId, JSON.stringify([action.agentId, action.clientRequestId]), action);
      await this.audit(companyId, "browser_sessions.action_late_result", { agentId: action.agentId, issueId: action.issueId, tool: action.tool, status: action.status });
    });
  }
  /** The agent keeps its cached unknown_delivery (no resend); the founder's record shows what the browser later reported. */
  private async acceptLateResult(companyId: string, request: BridgeRequest, result: BridgeResult) {
    const key = JSON.stringify([String(request.params.agentId), String(request.params.clientRequestId)]);
    await this.serial(companyId, async () => {
      const action = await this.store.get<ActionRecord>("action", companyId, key); if (!action || !action.completedAt) return;
      action.status = this.lateStatus(action, result, "(reported late)");
      action.reportedLateAt = new Date(this.now()).toISOString();
      await this.store.put("action", companyId, key, action);
      await this.audit(companyId, "browser_sessions.action_late_result", { agentId: action.agentId, issueId: action.issueId, tool: action.tool, status: action.status });
    });
  }
  async inventory(companyId: string, token: string, input: Record<string, unknown>) {
    await this.authenticate(companyId, token);
    const collections = {} as Record<keyof typeof INVENTORY_COUNT_LIMITS, unknown[]>;
    for (const field of Object.keys(INVENTORY_COUNT_LIMITS) as Array<keyof typeof INVENTORY_COUNT_LIMITS>) {
      const value = input[field];
      if (value !== undefined && !Array.isArray(value)) throw new SessionError("bad_request", `${field} must be an array.`);
      if (Array.isArray(value) && value.length > INVENTORY_COUNT_LIMITS[field]) throw new SessionError("too_large", `${field} exceeds the ${INVENTORY_COUNT_LIMITS[field]} item limit.`);
      collections[field] = value ?? [];
    }
    if (Buffer.byteLength(JSON.stringify(input)) > MAX_MESSAGE_BYTES) throw new SessionError("too_large", "Bridge message exceeds 4 MB.");
    return this.serial(companyId, async () => {
      await this.authenticate(companyId, token); await this.requireShared(companyId);
      const accepted: string[] = []; const rejected: { threadKey: string; code: string }[] = [];
      const starts = await this.store.list<ActionRecord>("action", companyId, { where: { tool: "session_start", admitted: true }, limit: 1000 });
      for (const value of collections.upserts) {
        try { const row = validateSession(value); await this.store.put("session", companyId, row.threadKey, row); accepted.push(row.threadKey); if (starts.length) await this.linkStartedSession(companyId, row, starts); }
        catch (error) { rejected.push({ threadKey: String((value as SessionRow)?.threadKey ?? ""), code: error instanceof SessionError ? error.code : "bad_request" }); }
      }
      for (const key of collections.removes) if (typeof key === "string") await this.store.remove("session", companyId, key);
      const automaticLinksAccepted: { issueId: string; threadKey: string }[] = [];
      const automaticLinksRejected: { issueId: string; threadKey: string; code: string }[] = [];
      for (const value of collections.automaticLinks) {
        let issueId = ""; let threadKey = "";
        try {
          const candidate = record(value); issueId = requiredString(candidate.issueId, "issueId"); threadKey = requiredString(candidate.threadKey, "threadKey");
          const tombstone = await this.store.get("notification", companyId, `auto-unlinked:${JSON.stringify([issueId, threadKey])}`);
          if (tombstone) continue;
          await this.link(companyId, issueId, threadKey, "auto", "threadkeeper"); automaticLinksAccepted.push({ issueId, threadKey });
        } catch (error) { automaticLinksRejected.push({ issueId, threadKey, code: error instanceof SessionError ? error.code : "internal" }); }
      }
      for (const event of collections.events) await processStateChange(this, companyId, event as StateChange);
      if (accepted.length || (Array.isArray(input.removes) && input.removes.length) || (Array.isArray(input.events) && input.events.length)) this.changed(companyId);
      return { accepted, rejected, automaticLinksAccepted, automaticLinksRejected };
    });
  }
  async setShared(companyId: string, shared: boolean, actor: string) {
    return this.serial(companyId, async () => {
    const state = await this.state(companyId); state.shared = shared && !!state.tokenHash;
    if (!state.shared) { await this.store.remove("session", companyId); this.cancelRequests(companyId, new SessionError("denied", "Sessions are not shared with this company.")); }
    await this.saveState(companyId, state); await this.audit(companyId, "browser_sessions.sharing_changed", { actor, shared: state.shared }); this.wake(companyId); this.changed(companyId); return this.status(companyId);
    });
  }
  async disconnect(companyId: string, actor: string, token?: string) {
    return this.serial(companyId, async () => {
    if (token !== undefined) await this.authenticate(companyId, token);
    const state = await this.state(companyId); state.tokenHash = null; state.shared = false; state.policy.enabled = false; state.extensionPolicy.enabled = false; state.policy.disabledAt = this.now();
    await this.saveState(companyId, state); await this.store.remove("session", companyId); await this.store.remove("pair", companyId);
    const deadline = this.expiryDeadlines.get(companyId); if (deadline) clearTimeout(deadline); this.expiryDeadlines.delete(companyId); this.changed(companyId);
    this.cancelRequests(companyId, new SessionError("not_paired", "The browser was disconnected.")); this.wake(companyId);
    await this.audit(companyId, "browser_sessions.disconnected", { actor }); return { disconnected: true };
    });
  }
  private cancelRequests(companyId: string, error: Error, actionsOnly = false, matches: (pending: Pending) => boolean = () => true) { for (const [id, pending] of [...this.pending]) if (pending.companyId === companyId && (!actionsOnly || isAction(pending.request.type)) && matches(pending)) this.cancel(id, pending, error); }
  async bridgePolicy(companyId: string, token: string, input: unknown) {
    return this.serial(companyId, async () => {
    const state = await this.authenticate(companyId, token); const next = parsePolicy(input);
    next.disabledAt = Math.max(next.disabledAt, state.extensionPolicy.disabledAt);
    const narrowed = !next.enabled || state.extensionPolicy.providers.some((p) => !next.providers.includes(p));
    if (narrowed) next.disabledAt = Math.max(next.disabledAt, this.now());
    state.extensionPolicy = next; await this.saveState(companyId, state);
    if (narrowed || !this.effectivePolicy(state).enabled) this.cancelRequests(companyId, new SessionError("disabled", "Agent actions are turned off."), true);
    this.wake(companyId); this.changed(companyId); return { policy: this.effectivePolicy(state) };
    });
  }
  async updateSettings(companyId: string, input: Record<string, unknown>, actor: string) {
    return this.serial(companyId, async () => {
      const state = await this.state(companyId);
      const previousProviders = [...state.policy.providers]; const previousTrusted = [...state.trustedAgentIds];
      if (input.policy !== undefined) { const next = parsePolicy(input.policy); next.disabledAt = Math.max(next.disabledAt, state.policy.disabledAt); if (!next.enabled || state.policy.providers.some((p) => !next.providers.includes(p))) next.disabledAt = Math.max(next.disabledAt, this.now()); state.policy = next; }
      if (input.trustedAgentIds !== undefined) { if (!Array.isArray(input.trustedAgentIds) || input.trustedAgentIds.length > 1000) throw new SessionError("bad_request", "trustedAgentIds must be an array"); const ids = input.trustedAgentIds.filter((id): id is string => typeof id === "string"); for (const id of ids) if (!await this.host.agents.get(id, companyId)) throw new SessionError("not_found", "Agent not found."); state.trustedAgentIds = [...new Set(ids)]; }
      if (input.eventsEnabled !== undefined) state.eventsEnabled = input.eventsEnabled === true;
      const untrusted = previousTrusted.filter((id) => !state.trustedAgentIds.includes(id));
      const removedProviders = previousProviders.filter((p) => !state.policy.providers.includes(p));
      // The extension never sees trust. One that honours per-request cancellation gets the untrusted agent's
      // requests listed in `cancelledRequestIds`; an older one needs the epoch moved, which also stops other agents.
      if (untrusted.length && !state.extensionCapabilities?.includes("cancel-requests")) state.policy.disabledAt = Math.max(state.policy.disabledAt, this.now());
      await this.saveState(companyId, state);
      if (!state.policy.enabled) this.cancelRequests(companyId, new SessionError("disabled", "Agent actions are turned off."), true);
      else {
        for (const provider of removedProviders) this.cancelRequests(companyId, new SessionError("disabled", `${providerLabel(provider)} is not enabled for agent actions.`), true, (p) => p.provider === provider);
        if (untrusted.length) this.cancelRequests(companyId, new SessionError("denied", "This agent is not trusted for browser actions."), true, (p) => untrusted.includes(String(p.request.params.agentId)));
      }
      this.wake(companyId);
      this.changed(companyId); await this.audit(companyId, "browser_sessions.settings_changed", { actor, policy: state.policy, trustedAgentIds: state.trustedAgentIds, eventsEnabled: state.eventsEnabled }); return this.settings(companyId);
    });
  }
  async settings(companyId: string) { const state = await this.state(companyId); return { ...await this.status(companyId), paired: !!state.tokenHash, trustedAgentIds: state.trustedAgentIds, eventsEnabled: state.eventsEnabled, agents: (await this.host.agents.list({ companyId, limit: 1000 })).map(({ id, name, status }) => ({ id, name, status })), credentials: await this.credentials(companyId), actions: await this.actions(companyId) }; }
  async links(companyId: string, threadKey?: string, issueId?: string): Promise<SessionLink[]> {
    const state = await this.state(companyId); if (!state.shared) return [];
    const links = await this.store.list<SessionLink>("link", companyId, { where: { ...(threadKey ? { threadKey } : {}), ...(issueId ? { issueId } : {}) } });
    return Promise.all(links.map(async (link) => { const issue = await this.host.issues.get(link.issueId, companyId); return { ...link, issueTitle: issue?.title, issueIdentifier: issue?.identifier ?? undefined, issueStatus: issue?.status }; }));
  }
  async link(companyId: string, issueId: string, threadKey: string, origin: SessionLink["origin"], creator: string, startedByAgentId?: string) {
    await this.requireShared(companyId);
    if (!await this.store.get("session", companyId, threadKey)) throw new SessionError("not_found", "Session or task not found.");
    const key = JSON.stringify([issueId, threadKey]); const existing = await this.store.get<SessionLink>("link", companyId, key);
    if (existing && !(origin === "user" && existing.origin === "agent")) return existing;
    const issue = await this.host.issues.get(issueId, companyId); if (!issue) throw new SessionError("not_found", "Session or task not found.");
    if (origin === "user") await this.store.remove("notification", companyId, `auto-unlinked:${key}`);
    if (existing) { existing.origin = "user"; existing.creator = creator; await this.store.put("link", companyId, key, existing); await this.audit(companyId, "browser_sessions.link_authorized", { issueId, threadKey, creator }); this.changed(companyId); this.wake(companyId); return existing; }
    if ((await this.store.list("link", companyId, { where: { issueId } })).length >= 50) throw new SessionError("too_many_links", "a task can have at most 50 sessions");
    const link: SessionLink = { id: randomUUID(), companyId, issueId, threadKey, origin, creator, createdAt: new Date(this.now()).toISOString(), issueTitle: issue.title, issueIdentifier: issue.identifier ?? undefined, issueStatus: issue.status, ...(startedByAgentId ? { startedByAgentId } : {}) };
    await this.store.put("link", companyId, key, link, true); await this.audit(companyId, "browser_sessions.linked", { issueId, threadKey, origin, creator }); this.wake(companyId); this.changed(companyId); return link;
  }
  async unlink(companyId: string, issueId: string, threadKey: string, actor: string, byAgent = false) { return this.serial(companyId, async () => { const key = JSON.stringify([issueId, threadKey]);
    // D-3: a founder's removal of an existing link keeps it from being re-created; an agent's removal never does.
    if (!byAgent && await this.store.get("link", companyId, key)) await this.store.put("notification", companyId, `auto-unlinked:${key}`, { issueId, threadKey, actor, at: new Date(this.now()).toISOString() });
    await this.store.remove("link", companyId, key); this.cancelRequests(companyId, new SessionError("denied", "The session is not linked to the task you are working on."), true, (p) => p.request.type === "session.send" && p.request.params.issueId === issueId && p.request.params.threadKey === threadKey); await this.audit(companyId, "browser_sessions.unlinked", { issueId, threadKey, actor }); this.wake(companyId); this.changed(companyId); return { removed: true }; }); }
  /** FR-5: no stale claims. Offline or stale rows are shown as `Not observed` with their last-seen time. */
  private current(row: SessionRow | null, connected: boolean): SessionRow | null {
    if (!row || !row.observed) return row;
    const at = Date.parse(row.agentStateAt ?? "");
    return connected && Number.isFinite(at) && this.now() - at <= OBSERVATION_STALE_MS ? row : { ...row, observed: false };
  }
  async taskSessions(companyId: string, issueId: string) {
    if (!await this.host.issues.get(issueId, companyId)) throw new SessionError("not_found", "Task not found.");
    const status = await this.status(companyId); if (!status.shared) return { ...status, sessions: [], message: "Sessions are not shared with this company." };
    return { ...status, sessions: await Promise.all((await this.links(companyId, undefined, issueId)).map(async (link) => ({ link, session: this.current(await this.store.get<SessionRow>("session", companyId, link.threadKey), status.connected) }))) };
  }
  async needsAttention(companyId: string) {
    const status = await this.status(companyId);
    if (!status.shared) return { ...status, sessions: [], total: 0, message: "Sessions are not shared with this company." };
    const rows = (await this.store.list<SessionRow>("session", companyId)).map((s) => this.current(s, status.connected)!).filter((s) => s.observed && ["waiting_answer", "waiting_permission", "signed_out", "needs_user_answer", "needs_approval", "failed", "needs_answer"].includes(String(s.agentState))).sort((a, b) => String(b.agentStateAt).localeCompare(String(a.agentStateAt)));
    const sessions = await Promise.all(rows.slice(0, 10).map(async (session) => ({ ...session, linkedTasks: (await this.links(companyId, session.threadKey)).map((link) => ({ issueId: link.issueId, identifier: link.issueIdentifier ?? null, title: link.issueTitle ?? null })) })));
    return { ...await this.status(companyId), sessions, total: rows.length };
  }
  async actions(companyId: string, threadKey?: string) {
    const actions = await this.store.list<ActionRecord>("action", companyId, { where: threadKey ? { threadKey } : {}, limit: 50 });
    // R3 F-6: no live request can outlast the start budget plus the settle window; such a record lost its worker.
    const live = new Set([...this.pending.keys()]);
    return actions.map((action) => action.admitted && !action.completedAt && !(action.requestId && live.has(action.requestId)) && this.now() - Date.parse(action.createdAt) > START_TIMEOUT_MS + ACTION_SETTLE_MS ? { ...action, status: "Failed: unknown_delivery" } : action);
  }
  private async linkStartedSession(companyId: string, row: SessionRow, actions: ActionRecord[]) {
    for (const action of actions) {
      // Only a start the browser confirmed may link, and only to the session its own result names.
      if (action.linked || !action.issueId || !action.status.startsWith("Started") || !action.delivery || action.provider !== row.provider || this.now() - Date.parse(action.createdAt) > 86_400_000) continue;
      const { threadKey, url } = action.delivery;
      if (threadKey ? threadKey === row.threadKey : !!url && url === row.url) {
        if (await this.store.get("notification", companyId, `auto-unlinked:${JSON.stringify([action.issueId, row.threadKey])}`)) continue;
        await this.link(companyId, action.issueId, row.threadKey, "agent", action.agentId, action.agentId);
        action.threadKey = row.threadKey; action.sessionTitle = row.title; action.linked = true; await this.store.put("action", companyId, JSON.stringify([action.agentId, action.clientRequestId]), action);
      }
    }
  }
  async credentials(companyId: string) {
    const config = await this.host.config.get(companyId); const links = config.credentialLinks && typeof config.credentialLinks === "object" ? config.credentialLinks as Record<string, unknown> : {};
    return { companyId, linkedKeys: CREDENTIAL_KEYS.filter((key) => !!links[key]), allowSecretTransfer: config.allowSecretTransfer === true };
  }
  async secret(companyId: string, token: string, keyName: string) {
    // REQ-14 FR-2: anything other than the paired extension is refused as `denied`.
    const state = await this.authenticate(companyId, token).catch((error: unknown) => { throw error instanceof SessionError && error.code === "not_paired" ? new SessionError("denied", "Only the paired extension can read model keys.") : error; });
    if (!(CREDENTIAL_KEYS as readonly string[]).includes(keyName)) throw new SessionError("bad_request", "Unknown credential key.");
    const config = await this.host.config.get(companyId);
    if (config.allowSecretTransfer !== true) throw new SessionError("denied", "Secret transfer to the paired extension is turned off.");
    const ref = record(config.credentialLinks ?? {})[keyName];
    if (!ref || typeof ref !== "object") throw new SessionError("not_found", "Secret missing");
    // REQ-14 FR-1: a deleted or missing linked secret counts as absent; other failures (for example throttling) stay errors.
    const value = await this.host.secrets.resolve(ref as never, { companyId, configPath: `credentialLinks.${keyName}` })
      .catch((error: unknown) => { throw error instanceof Error && /not found|not bound|deleted|missing|does not exist/i.test(error.message) ? new SessionError("not_found", "Secret missing") : error; });
    await this.authenticate(companyId, token);
    if ((await this.host.config.get(companyId)).allowSecretTransfer !== true) throw new SessionError("denied", "Secret transfer to the paired extension is turned off.");
    await this.audit(companyId, "browser_sessions.secret_read", { keyName, reader: "threadkeeper-extension", extensionVersion: state.extensionVersion, browser: state.browser });
    return { value };
  }
  async domainEvent(event: PluginEvent) {
    // REQ-12: hints follow pairing, not session sharing; they carry ids only.
    const state = await this.state(event.companyId); if (!state.tokenHash || !this.online(state)) return;
    const payload = event.payload && typeof event.payload === "object" ? event.payload as Record<string, unknown> : {};
    let buffer = this.hintBuffers.get(event.companyId);
    if (!buffer) { const timer = setTimeout(() => { const current = this.hintBuffers.get(event.companyId); if (!current) return; this.hintBuffers.delete(event.companyId); const issues = [...current.issueIds]; const runs = [...current.runIds]; const hints: ChangedHint[] = []; for (let at = 0; at < Math.max(issues.length, 1); at += 50) hints.push({ type: "paperclip.changed", companyId: event.companyId, issueIds: issues.slice(at, at + 50), runIds: at === 0 ? runs.slice(0, 100) : [] }); this.hints.set(event.companyId, [...(this.hints.get(event.companyId) ?? []), ...hints].slice(-20)); this.wake(event.companyId); }, 5000); buffer = { issueIds: new Set(), runIds: new Set(), timer }; this.hintBuffers.set(event.companyId, buffer); }
    const issueId = typeof payload.issueId === "string" ? payload.issueId : event.entityType === "issue" ? event.entityId : undefined;
    if (issueId && buffer.issueIds.size < 1000) buffer.issueIds.add(issueId);
    const runId = typeof payload.runId === "string" ? payload.runId : event.entityType === "heartbeat_run" ? event.entityId : undefined;
    if (runId && buffer.runIds.size < 100) buffer.runIds.add(runId);
  }
  async executeTool(name: string, params: unknown, run: ToolRunContext): Promise<ToolResult> { return executeSessionTool(this, name, params, run); }
  async audit(companyId: string, message: string, metadata: Record<string, unknown>) { await this.host.activity.log({ companyId, message, metadata }); }
  hasPendingWork() { return this.pending.size > 0 || this.waiters.size > 0 || this.hintBuffers.size > 0 || this.expiryDeadlines.size > 0; }
  close() { for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(p.handedOut && isAction(p.request.type) ? new SessionError("unknown_delivery", UNKNOWN_DELIVERY_MESSAGE) : new SessionError("browser_offline", OFFLINE_MESSAGE)); } this.pending.clear(); this.settled.clear(); this.cancelledIds.clear(); for (const h of this.hintBuffers.values()) clearTimeout(h.timer); this.hintBuffers.clear(); for (const deadline of this.expiryDeadlines.values()) clearTimeout(deadline); this.expiryDeadlines.clear(); for (const wake of this.waiters.values()) wake(); this.waiters.clear(); }
}
