// Ephemeral, frame-bound observations. Historical IndexedDB state is never evidence of a live page.
import { isAgentState, type AgentState } from '../workspace/types.js';

export const OBSERVATION_FRESHNESS_MS = 30_000;
export const OBSERVATION_SETTLE_MS = 5_000;
export interface SessionObservation { tabId: number; frameId: number; threadKey: string; state: AgentState; at?: number }
export interface SettledSessionChange { threadKey: string; from: AgentState; to: AgentState; at: string; observed: true }
interface FrameObservation { threadKey: string; state: AgentState; at: number; order: number }
interface ThreadObservation { settled: AgentState; pending: null | { from: AgentState; to: AgentState; since: number; observedAt: number } }

export class SessionObservationLedger {
  private readonly frames = new Map<string, FrameObservation>();
  private readonly threads = new Map<string, ThreadObservation>();
  /**
   * Last settled state of sessions no longer on screen (memory only, bounded). Losing every frame must not
   * erase what the session was last seen doing, or the change seen on reload is never reported (REQ-10 F2).
   */
  private readonly baselines = new Map<string, AgentState>();
  private order = 0;
  private readonly now: () => number;
  private readonly freshnessMs: number;
  private readonly settleMs: number;

  constructor(options: { now?: () => number; freshnessMs?: number; settleMs?: number } = {}) {
    this.now = options.now ?? Date.now;
    this.freshnessMs = options.freshnessMs ?? OBSERVATION_FRESHNESS_MS;
    this.settleMs = options.settleMs ?? OBSERVATION_SETTLE_MS;
  }

  /** Call only after the worker resolved a validated frame/account to this exact thread. */
  observe(input: SessionObservation): void {
    this.prune();
    if (!Number.isInteger(input.tabId) || input.tabId < 0 || !Number.isInteger(input.frameId) || input.frameId <= 0 || typeof input.threadKey !== 'string' || !input.threadKey || input.threadKey.length > 600 || !isAgentState(input.state)) return;
    const key = `${input.tabId}:${input.frameId}`;
    const previous = this.frames.get(key);
    const at = input.at ?? this.now();
    // A page's reported time cannot keep an observation alive into the future.
    if (!Number.isFinite(at) || at > this.now() || this.now() - at > this.freshnessMs || (previous && at < previous.at)) return;
    if (previous && previous.threadKey !== input.threadKey) this.forgetFrame(input.tabId, input.frameId);
    if (input.state === 'unknown') { this.forgetFrame(input.tabId, input.frameId); return; }
    this.frames.set(key, { threadKey: input.threadKey, state: input.state, at, order: ++this.order });
    const latest = this.latest(input.threadKey);
    if (!latest) return;
    const thread = this.threads.get(input.threadKey);
    if (!thread) {
      const base = this.baselines.get(input.threadKey);
      this.baselines.delete(input.threadKey);
      // First sight with no history is a baseline, never a change; a known earlier state yields one.
      this.threads.set(input.threadKey, base && base !== latest.state
        ? { settled: base, pending: { from: base, to: latest.state, since: this.now(), observedAt: latest.at } }
        : { settled: latest.state, pending: null });
      return;
    }
    if (latest.state === thread.settled) { thread.pending = null; return; }
    if (!thread.pending || thread.pending.to !== latest.state) thread.pending = { from: thread.settled, to: latest.state, since: this.now(), observedAt: latest.at };
  }

  forgetFrame(tabId: number, frameId: number): void {
    const key = `${tabId}:${frameId}`;
    const record = this.frames.get(key);
    this.frames.delete(key);
    if (record && !this.latest(record.threadKey)) this.dropThread(record.threadKey);
    else if (record) {
      const pending = this.threads.get(record.threadKey)?.pending;
      if (pending && this.latest(record.threadKey)?.state !== pending.to) this.threads.get(record.threadKey)!.pending = null;
    }
  }

  forgetTab(tabId: number): void {
    const prefix = `${tabId}:`;
    for (const key of [...this.frames.keys()]) if (key.startsWith(prefix)) this.forgetFrame(tabId, Number(key.slice(prefix.length)));
  }

  isObserved(threadKey: string): boolean { return this.snapshot(threadKey) !== null; }

  snapshot(threadKey: string): { state: AgentState; at: number } | null {
    this.prune();
    const latest = this.latest(threadKey);
    return latest ? { state: latest.state, at: latest.at } : null;
  }

  /** A five-second stable candidate emits once. Heartbeats refresh freshness, not this deadline. */
  flushSettledChanges(): SettledSessionChange[] {
    this.prune();
    const changes: SettledSessionChange[] = [];
    for (const [threadKey, thread] of this.threads) {
      const pending = thread.pending;
      if (!pending) continue;
      const latest = this.latest(threadKey);
      if (!latest || latest.state !== pending.to) { thread.pending = null; continue; }
      if (this.now() - pending.since < this.settleMs) continue;
      changes.push({ threadKey, from: pending.from, to: pending.to, at: new Date(pending.observedAt).toISOString(), observed: true });
      thread.settled = pending.to;
      thread.pending = null;
    }
    return changes;
  }

  private latest(threadKey: string): FrameObservation | null {
    let latest: FrameObservation | null = null;
    for (const row of this.frames.values()) if (row.threadKey === threadKey && this.now() - row.at <= this.freshnessMs && (!latest || row.at > latest.at || (row.at === latest.at && row.order > latest.order))) latest = row;
    return latest;
  }

  private prune(): void {
    for (const [key, row] of this.frames) if (this.now() - row.at > this.freshnessMs) this.frames.delete(key);
    const live = new Set([...this.frames.values()].map(row => row.threadKey));
    for (const key of [...this.threads.keys()]) if (!live.has(key)) this.dropThread(key);
  }

  private dropThread(threadKey: string): void {
    const thread = this.threads.get(threadKey);
    this.threads.delete(threadKey);
    if (!thread) return;
    this.baselines.delete(threadKey);
    this.baselines.set(threadKey, thread.settled);
    while (this.baselines.size > 5000) this.baselines.delete(this.baselines.keys().next().value as string);
  }
}
