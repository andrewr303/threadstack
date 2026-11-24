import type { ThreadStackDB } from '../db.js';
import { ensureStarterCollectionsAndSettings } from '../db.js';
import { isRemoteAllowed, localOnlyProjectNames } from '../privacy.js';
import { providerLabel } from '../providers.js';
import { computeDeterministicHash } from '../schema.js';
import { BRIDGE_SUPPORTED_PROVIDERS, BridgeActionError, VERDICT_MARGIN_MS, abortedBeforeTyping, bridgeFailure, type ActionOutcome, type ActionPolicy, type AgentAction, type BridgeRequest, type BridgeResult, type SessionLink } from './bridge-protocol.js';
export { BridgeActionError } from './bridge-protocol.js';

export interface ActionJournalEntry { key: string; digest: string; at: number; outcome: BridgeResult }
export interface ActionJournal { read(): Promise<ActionJournalEntry[]>; write(entries: ActionJournalEntry[]): Promise<void> }
export function memoryActionJournal(): ActionJournal {
  let rows: ActionJournalEntry[] = [];
  return { read: async () => structuredClone(rows), write: async next => { rows = structuredClone(next); } };
}
export function chromeActionJournal(): ActionJournal {
  const key = 'tk.paperclip.actions.v1';
  return {
    async read() { const raw = (await chrome.storage.local.get(key))[key]; return Array.isArray(raw) ? raw as ActionJournalEntry[] : []; },
    async write(entries) { await chrome.storage.local.set({ [key]: entries }); },
  };
}

export interface BrowserActionDeps {
  db: ThreadStackDB; journal: ActionJournal;
  policy: () => ActionPolicy | Promise<ActionPolicy>;
  links: (companyId: string) => SessionLink[] | Promise<SessionLink[]>;
  execute: (action: AgentAction, signal: AbortSignal) => Promise<ActionOutcome>;
  now?: () => number;
  /** Diagnostics for adapter, page-changed and uncertain outcomes (REQ-11 F-5). Never given message text. */
  onFailure?: (action: AgentAction, error: BridgeActionError) => void;
}
export { VERDICT_MARGIN_MS };
const EARLY_CANCEL_TTL_MS = 10 * 60_000;
function linkAuthorizes(l: SessionLink, companyId: string, action: AgentAction & { type: 'session.send' }): boolean {
  return l.companyId === companyId && l.issueId === action.issueId && l.threadKey === action.threadKey && (l.origin === 'user' || l.origin === 'auto' || l.startedByAgentId === action.agentId);
}
const DIAGNOSED_FAILURES = new Set(['unsupported', 'denied', 'unknown_delivery', 'signed_out', 'timeout']);

/** Defense in depth: server trust/rate checks never replace browser consent, scope or dedupe. */
export class BrowserActionGuard {
  private queue: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, { digest: string; promise: Promise<BridgeResult> }>();
  private controllers = new Set<AbortController>();
  private byRequest = new Map<string, AbortController>();
  /** Cancels that arrived before their request was registered (F-2). Memory only, bounded, expire. */
  private earlyCancels = new Map<string, number>();
  /** Running actions with their company, for link revalidation (F-3). */
  private active = new Map<string, { companyId: string; action: AgentAction; controller: AbortController }>();
  constructor(private readonly deps: BrowserActionDeps) {}

  /** Switch-off, unlink, unshare or trust change: executors report `disabled` if nothing was typed (NF-2). */
  cancelPending(): void { for (const controller of this.controllers) controller.abort('disabled'); }
  /** Paperclip's `cancelledRequestIds`: stop only these; executors report `denied` if nothing was typed. */
  cancelRequests(requestIds: readonly string[]): void {
    const now = (this.deps.now ?? Date.now)();
    for (const [id, expiresAt] of this.earlyCancels) if (expiresAt <= now) this.earlyCancels.delete(id);
    for (const id of requestIds) {
      const controller = this.byRequest.get(id);
      // The plugin keeps listing an id until a verdict or its deadline; repeats are harmless.
      if (controller) controller.abort('denied');
      else {
        this.earlyCancels.delete(id); this.earlyCancels.set(id, now + EARLY_CANCEL_TTL_MS);
        while (this.earlyCancels.size > 2000) this.earlyCancels.delete(this.earlyCancels.keys().next().value as string);
      }
    }
  }

  /**
   * Links changed: abort only sends no longer authorized by any current link of their company
   * (same rule as before execution), reporting the FR-1 link text. Starts and other sends continue (F-3).
   */
  revalidateLinks(companyId: string, links: readonly SessionLink[]): void {
    for (const { companyId: owner, action, controller } of this.active.values()) {
      if (owner !== companyId || action.type !== 'session.send') continue;
      if (!links.some(l => linkAuthorizes(l, companyId, action))) controller.abort('unlinked');
    }
  }

  run(companyId: string, request: BridgeRequest): Promise<BridgeResult> {
    const p = request.params;
    const key = `${companyId}:${p.agentId}:${p.clientRequestId}`;
    const digest = computeDeterministicHash(JSON.stringify([request.type, p.issueId, p.threadKey, p.provider, p.accountId, p.text, p.prompt]));
    const pending = this.pending.get(key);
    if (pending) return pending.digest === digest ? pending.promise.then(outcome => ({ ...outcome, requestId: request.requestId })) : Promise.resolve(bridgeFailure(request.requestId, 'bad_request', 'clientRequestId was already used with different content.'));
    // Journal reservations are serialized, while actual provider waits run independently.
    const promise = this.prepare(companyId, request, key, digest);
    this.pending.set(key, { digest, promise });
    void promise.finally(() => this.pending.delete(key));
    return promise;
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn); this.queue = result.catch(() => undefined); return result;
  }

  private async prepare(companyId: string, request: BridgeRequest, key: string, digest: string): Promise<BridgeResult> {
    const now = this.deps.now ?? Date.now;
    try {
      const p = request.params;
      const text = request.type === 'session.send' ? p.text : p.prompt;
      for (const [name, value, max] of [['agentId', p.agentId, 128], ['issueId', p.issueId, 128], ['clientRequestId', p.clientRequestId, 64]] as const) {
        if (typeof value !== 'string' || !value.length || value.length > max) throw new BridgeActionError('bad_request', `${name} is required.`);
      }
      if (typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new BridgeActionError('bad_request', 'Message must contain 1 to 20000 characters.');
      const previous = await this.serial(async () => (await this.deps.journal.read()).find(r => r.key === key && now() - r.at < 86_400_000));
      if (previous) return previous.digest === digest ? { ...previous.outcome, requestId: request.requestId } : bridgeFailure(request.requestId, 'bad_request', 'clientRequestId was already used with different content.');
      let action: AgentAction;
      if (request.type === 'session.send') {
        if (typeof p.threadKey !== 'string' || p.threadKey.length > 600) throw new BridgeActionError('bad_request', 'threadKey is required.');
        const [conv, settings, localOnly] = await Promise.all([this.deps.db.conversations.get(p.threadKey), ensureStarterCollectionsAndSettings(this.deps.db), localOnlyProjectNames(this.deps.db)]);
        if (!conv || conv.provider === 'paperclip' || !isRemoteAllowed(conv, settings, localOnly)) throw new BridgeActionError('not_found', 'not_found');
        const links = await this.deps.links(companyId);
        if (!links.some(l => l.companyId === companyId && l.issueId === p.issueId && l.threadKey === conv.threadKey && (l.origin === 'user' || l.origin === 'auto' || l.startedByAgentId === p.agentId))) throw new BridgeActionError('denied', 'The session is not linked to the task you are working on.');
        if (conv.agentState === 'running' || conv.agentState === 'waiting_permission') throw new BridgeActionError('busy', 'The session is still running. Wait for it to finish.');
        action = { type: 'session.send', companyId, agentId: p.agentId as string, issueId: p.issueId as string, clientRequestId: p.clientRequestId as string, requestId: request.requestId, createdAt: request.createdAt, deadlineAt: request.deadlineAt, policyDisabledAt: Number(p.policyDisabledAt), threadKey: conv.threadKey, text, provider: conv.provider, accountId: conv.accountId, url: conv.canonicalUrl };
      } else if (request.type === 'session.start') {
        if (typeof p.provider !== 'string' || (p.accountId !== undefined && typeof p.accountId !== 'string')) throw new BridgeActionError('bad_request', 'provider is required.');
        action = { type: 'session.start', companyId, agentId: p.agentId as string, issueId: p.issueId as string, clientRequestId: p.clientRequestId as string, requestId: request.requestId, createdAt: request.createdAt, deadlineAt: request.deadlineAt, policyDisabledAt: Number(p.policyDisabledAt), provider: p.provider, accountId: p.accountId as string | undefined, prompt: text };
      } else throw new BridgeActionError('unsupported', 'Unsupported browser action.');
      await this.checkPolicy(action);
      const provisional = bridgeFailure(request.requestId, 'unknown_delivery', 'The message may or may not have been sent. Read the session before trying again.');
      await this.serial(async () => {
        const entries = (await this.deps.journal.read()).filter(r => now() - r.at < 86_400_000);
        if (entries.length >= 5000) throw new BridgeActionError('busy', 'Browser action history is full. Try later.');
        entries.push({ key, digest, at: now(), outcome: provisional });
        await this.deps.journal.write(entries);
      });
      const controller = new AbortController(); this.controllers.add(controller); this.byRequest.set(request.requestId, controller);
      if (this.earlyCancels.delete(request.requestId)) controller.abort('denied');
      this.active.set(request.requestId, { companyId, action, controller });
      // Stop early enough that the verdict (usually `unknown_delivery`) reaches Paperclip before deadlineAt;
      // the plugin answers on its own at the deadline and only then waits for a late verdict.
      const timeout = setTimeout(() => controller.abort('timeout'), Math.max(0, request.deadlineAt - now() - VERDICT_MARGIN_MS));
      let result: BridgeResult;
      try {
        await this.checkPolicy(action);
        if (controller.signal.aborted) throw abortedBeforeTyping(controller.signal);
        if (action.type === 'session.send') {
          const [conv, settings, privateProjects, links] = await Promise.all([this.deps.db.conversations.get(action.threadKey), ensureStarterCollectionsAndSettings(this.deps.db), localOnlyProjectNames(this.deps.db), this.deps.links(companyId)]);
          if (!conv || !isRemoteAllowed(conv, settings, privateProjects)) throw new BridgeActionError('not_found', 'not_found');
          if (!links.some(l => l.companyId === companyId && l.issueId === action.issueId && l.threadKey === action.threadKey && (l.origin === 'user' || l.origin === 'auto' || l.startedByAgentId === action.agentId))) throw new BridgeActionError('denied', 'The session is not linked to the task you are working on.');
        }
        const outcome = await this.deps.execute(action, controller.signal);
        result = { requestId: request.requestId, ok: true, data: outcome as unknown as Record<string, unknown> };
      } catch (err) {
        result = err instanceof BridgeActionError ? bridgeFailure(request.requestId, err.code, err.message) : provisional;
        if (err instanceof BridgeActionError && DIAGNOSED_FAILURES.has(err.code)) { try { this.deps.onFailure?.(action, err); } catch { /* diagnostics never change the outcome */ } }
      } finally { clearTimeout(timeout); this.controllers.delete(controller); if (this.byRequest.get(request.requestId) === controller) this.byRequest.delete(request.requestId); if (this.active.get(request.requestId)?.controller === controller) this.active.delete(request.requestId); }
      await this.serial(async () => { const entries = await this.deps.journal.read(); await this.deps.journal.write(entries.map(r => r.key === key ? { ...r, outcome: result } : r)); });
      return result;
    } catch (err) {
      return err instanceof BridgeActionError ? bridgeFailure(request.requestId, err.code, err.message) : bridgeFailure(request.requestId, 'internal', 'The browser action could not be prepared.');
    }
  }

  private async checkPolicy(action: AgentAction): Promise<void> {
    const policy = await this.deps.policy();
    if (!policy.enabled || action.createdAt <= policy.disabledAt || action.policyDisabledAt !== policy.disabledAt) throw new BridgeActionError('disabled', 'Agent actions are turned off.');
    if (!BRIDGE_SUPPORTED_PROVIDERS.includes(action.provider as typeof BRIDGE_SUPPORTED_PROVIDERS[number])) throw new BridgeActionError('unsupported', `${providerLabel(action.provider)} has no send support yet.`);
    if (!policy.providers.includes(action.provider)) throw new BridgeActionError('disabled', `${providerLabel(action.provider)} is not enabled for agent actions.`);
  }
}
