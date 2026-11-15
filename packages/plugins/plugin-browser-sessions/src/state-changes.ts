import { digest, providerLabel, type BrowserSessionsService } from "./service.js";
import { type SessionRow, type StateChange } from "./contracts.js";

const LABELS: Record<string, string> = { waiting_answer: "Needs your answer", waiting_permission: "Needs approval", signed_out: "Signed out", needs_user_answer: "Needs your answer", needs_answer: "Needs your answer", needs_approval: "Needs approval", turn_complete: "Finished", failed: "Failed" };
/** Agent states the extension reports (extension/src/core/workspace/types.ts AGENT_STATES) plus legacy aliases. */
const STATES = new Set(["running", "waiting_permission", "waiting_answer", "turn_complete", "failed", "idle", "signed_out", "unknown", ...Object.keys(LABELS)]);
const label = (state: string) => Object.hasOwn(LABELS, state) ? LABELS[state] : undefined;
/** Escapes Markdown-active characters first, then cuts to `max` characters without splitting an escape pair. */
export function escapedCut(text: string, max: number, active: RegExp): string {
  let out = "";
  for (const char of text.replace(/[\r\n]+/g, " ")) { const unit = active.test(char) ? `\\${char}` : char; if (out.length + unit.length > max) break; out += unit; }
  return out;
}
interface EventReceipt { completedIssues: string[]; processed: boolean; threadKey?: string; at?: string; handledAt?: number }
const RECEIPT_TTL_MS = 86_400_000;
const lastPrune = new WeakMap<BrowserSessionsService, Map<string, number>>();
/** Handled pairs of thread key and time are kept for 24 hours (REQ-10 cache rule); pruned at most hourly per company. */
async function pruneReceipts(service: BrowserSessionsService, companyId: string) {
  let byCompany = lastPrune.get(service); if (!byCompany) { byCompany = new Map(); lastPrune.set(service, byCompany); }
  if (service.now() - (byCompany.get(companyId) ?? 0) < 3_600_000) return; byCompany.set(companyId, service.now());
  for (const receipt of await service.store.list<EventReceipt>("event", companyId)) {
    if (typeof receipt.handledAt === "number" && service.now() - receipt.handledAt < RECEIPT_TTL_MS) continue;
    if (typeof receipt.threadKey === "string" && typeof receipt.at === "string") await service.store.remove("event", companyId, digest(JSON.stringify([receipt.threadKey, receipt.at])));
  }
}
interface RateState { commentsAt: number[]; suppressed: number; lastWakeAt?: number }
export async function processStateChange(service: BrowserSessionsService, companyId: string, event: StateChange) {
  if (!event || typeof event.threadKey !== "string" || typeof event.to !== "string" || !STATES.has(event.to) || typeof event.at !== "string" || !event.observed) return;
  const at = Date.parse(event.at); if (!Number.isFinite(at) || at > service.now() + 10_000) return;
  const row = await service.store.get<SessionRow>("session", companyId, event.threadKey); if (!row || !row.observed) return;
  // Inventory rows carry the latest observation (heartbeat) time, so events are ordered against the
  // last accepted event, not the row. An older event still counts when the row shows the same state.
  const lastKey = `last-event:${event.threadKey}`;
  const last = await service.store.get<{ at: number }>("notification", companyId, lastKey);
  if (last && at < last.at) return;
  const observedAt = Date.parse(row.agentStateAt ?? "");
  const newer = !Number.isFinite(observedAt) || at >= observedAt;
  if (!newer && row.agentState !== event.to) return;
  if (newer) { row.agentState = event.to; row.agentStateAt = event.at; await service.store.put("session", companyId, row.threadKey, row); }
  await service.store.put("notification", companyId, lastKey, { at });
  // Replayed older observations update metadata but never produce fresh claims.
  if (service.now() - at > 600_000) return;
  const key = digest(JSON.stringify([event.threadKey, event.at]));
  await pruneReceipts(service, companyId);
  const receipt = await service.store.get<EventReceipt>("event", companyId, key) ?? { completedIssues: [], processed: false, threadKey: event.threadKey, at: event.at, handledAt: service.now() };
  if (receipt.processed) return;
  const state = await service.state(companyId);
  await service.host.events.emit("session_state", companyId, { threadKey: event.threadKey, from: typeof event.from === "string" && STATES.has(event.from) ? event.from : "unknown", to: event.to, at: event.at });
  if (!state.eventsEnabled || !label(event.to)) { receipt.processed = true; await service.store.put("event", companyId, key, receipt); return; }
  const links = await service.links(companyId, event.threadKey);
  for (const link of links) {
    if (receipt.completedIssues.includes(link.issueId)) continue;
    const issue = await service.host.issues.get(link.issueId, companyId); if (!issue) continue;
    const rateKey = JSON.stringify([event.threadKey, issue.id]);
    const rate = await service.store.get<RateState>("notification", companyId, rateKey) ?? { commentsAt: [], suppressed: 0 };
    rate.commentsAt = rate.commentsAt.filter((time) => service.now() - time < 3_600_000);
    // The comment limit and the wake-up limit are independent (D-5): a held-back comment never holds back a wake-up.
    if (rate.commentsAt.length >= 6) { rate.suppressed++; await service.store.put("notification", companyId, rateKey, rate); }
    else {
    const title = escapedCut(row.title, 120, /[\\"`\[\]<>*_]/);
    const safeLabel = (value: string) => escapedCut(value, 120, /[\\"`\[\]<>*_()]/);
    const companyPrefix = issue.identifier?.replace(/-\d+$/, "");
    const url = companyPrefix ? `/${encodeURIComponent(companyPrefix)}/threads?threadKey=${encodeURIComponent(row.threadKey)}&open=1` : row.url.replaceAll("(", "%28").replaceAll(")", "%29");
    const marker = `<!-- browser-session-event:${key} -->`;
    const priorComments = await service.host.issues.listComments(issue.id, companyId);
    const existing = priorComments.some((comment) => comment.body.includes(marker));
    if (!existing) {
      await service.host.issues.createComment(issue.id, `Session "${title}" (${safeLabel(row.providerLabel ?? providerLabel(row.provider))}, ${safeLabel(row.accountLabel ?? "Default account")}) is now: ${label(event.to)}.\n[Open session](${url})${rate.suppressed ? ` (${rate.suppressed} earlier changes not shown.)` : ""}\n${marker}`, companyId);
      rate.commentsAt.push(service.now()); rate.suppressed = 0; await service.store.put("notification", companyId, rateKey, rate);
    }
    }
    if (["turn_complete", "failed"].includes(event.to) && issue.assigneeAgentId) {
      const wakeKey = `wake:${issue.id}`; const wake = await service.store.get<{ at: number }>("notification", companyId, wakeKey);
      if (!wake || service.now() - wake.at >= 600_000) {
        // Only a queued wake-up starts the 10-minute throttle; every refusal is audited with its reason.
        let refusal: string | null = null;
        try { const outcome = await service.host.issues.requestWakeup(issue.id, companyId, { reason: "browser_session_state", contextSource: "browser-sessions", idempotencyKey: `browser-session:${key}:${issue.id}` }); if (outcome && outcome.queued === false) refusal = "not_queued"; else await service.store.put("notification", companyId, wakeKey, { at: service.now() }); }
        catch (error) { refusal = error instanceof Error ? error.message.slice(0, 200) : "refused"; }
        if (refusal) await service.audit(companyId, "browser_sessions.wakeup_not_admitted", { issueId: issue.id, threadKey: event.threadKey, reason: refusal });
      }
    }
    receipt.completedIssues.push(issue.id); await service.store.put("event", companyId, key, receipt);
  }
  receipt.processed = true; await service.store.put("event", companyId, key, receipt);
}
