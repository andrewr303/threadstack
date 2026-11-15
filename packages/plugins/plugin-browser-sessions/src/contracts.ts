/** Wire contract shared with extension/src/core/paperclip/bridge.ts. */
export const PLUGIN_ID = "browser-sessions";
export const PROTOCOL = "paperclip-threadkeeper/1";
export const PLUGIN_VERSION = "0.1.0";
export const API_BASE = "/api/plugins/browser-sessions/api";
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
export const OFFLINE_MS = 40_000;
export const REQUEST_TIMEOUT_MS = 30_000;
/** REQ-11 FR-6: 30 s page load + 15 s confirmation, plus the 5 s report margin and the extension's 1.5 s abort lead. */
export const SEND_TIMEOUT_MS = 60_000;
/** A start also opens the provider's new-session page before the same load and confirmation waits. */
export const START_TIMEOUT_MS = 75_000;
/** The browser's own deadline for an action ends this long before the plugin's timer, so its verdict can arrive first. */
export const ACTION_REPORT_MARGIN_MS = 5_000;
/** How long a cancelled or overdue action the browser already holds may still report its verdict (within the 10 s stop time). */
export const ACTION_SETTLE_MS = 8_000;
export const INVENTORY_COUNT_LIMITS = { upserts: 5000, removes: 10_000, automaticLinks: 50, events: 100 } as const;
export const SUPPORTED_PROVIDERS = ["claude", "claude_code", "chatgpt", "codex"] as const;
export const CREDENTIAL_KEYS = ["anthropicApiKey", "awsPlatformApiKey", "voyageApiKey", "mongodbApiKey", "cohereApiKey", "openaiApiKey", "workerBearerToken", "aws.bedrockApiKey", "aws.accessKeyId", "aws.secretAccessKey", "aws.sessionToken"] as const;
export type CredentialKey = typeof CREDENTIAL_KEYS[number];
export interface ActionPolicy { enabled: boolean; providers: string[]; disabledAt: number }
export interface SessionRow {
  threadKey: string;
  fingerprint: string;
  title: string;
  provider: string;
  providerLabel?: string;
  url: string;
  accountId?: string;
  accountLabel?: string;
  sessionGroup?: string;
  agentState?: string;
  agentStateAt?: string;
  repository?: string;
  pullRequestUrl?: string;
  pinned?: boolean;
  observed?: boolean;
  updatedAt?: string | null;
  [key: string]: unknown;
}
export interface SessionLink {
  id: string; companyId: string; issueId: string; threadKey: string;
  origin: "user" | "auto" | "agent"; creator: string; createdAt: string;
  startedByAgentId?: string | null;
  issueTitle?: string; issueIdentifier?: string; issueStatus?: string;
}
export interface ChangedHint { type: "paperclip.changed"; companyId: string; issueIds: string[]; runIds: string[] }
export interface BridgeRequest { requestId: string; type: string; params: Record<string, unknown>; createdAt: number; deadlineAt: number }
export type BridgeResult = { requestId: string; ok: true; data: unknown } | { requestId: string; ok: false; error: { code: string; message: string } };
export interface StateChange { threadKey: string; from: string; to: string; at: string; observed: boolean }
export interface ActionRecord {
  id: string; requestId?: string; companyId: string; agentId: string; runId: string; issueId: string | null;
  tool: "session_send" | "session_start"; threadKey: string | null; provider: string; accountLabel: string;
  text: string; clientRequestId: string; inputHash: string; admitted: boolean;
  status: string; createdAt: string; completedAt: string | null; result?: unknown;
  linked?: boolean;
  /** Set only from a successful browser result; the sole input for linking a started session. */
  delivery?: { threadKey: string | null; url: string | null };
  agentName?: string; sessionTitle?: string;
  /** When the browser's verdict arrived after the agent was told unknown_delivery. */
  reportedLateAt?: string;
}
export class SessionError extends Error {
  constructor(public readonly code: string, message = code) { super(message); this.name = "SessionError"; }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SessionError("bad_request", "Expected an object.");
  return value as Record<string, unknown>;
}
export function requiredString(value: unknown, name: string, max = 600): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new SessionError("bad_request", `${name} is required and must contain at most ${max} characters`);
  return value;
}
export function boundedInteger(value: unknown, name: string, min: number, max: number, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) throw new SessionError("bad_request", `${name} must be between ${min} and ${max}`);
  return Number(value);
}
export function parsePolicy(value: unknown): ActionPolicy {
  const v = record(value);
  return { enabled: v.enabled === true, providers: Array.isArray(v.providers) ? [...new Set(v.providers.filter((p): p is string => typeof p === "string" && SUPPORTED_PROVIDERS.includes(p as typeof SUPPORTED_PROVIDERS[number])))] : [], disabledAt: typeof v.disabledAt === "number" && Number.isFinite(v.disabledAt) && v.disabledAt >= 0 ? v.disabledAt : 0 };
}
export function validateSession(value: unknown): SessionRow {
  const v = record(value);
  requiredString(v.threadKey, "threadKey"); requiredString(v.fingerprint, "fingerprint", 2000);
  requiredString(v.provider, "provider", 64); requiredString(v.title, "title", 4000);
  if (v.provider === "paperclip") throw new SessionError("bad_request", "Paperclip tasks are not browser sessions.");
  if (typeof v.url !== "string" || (v.url && !/^https:\/\//.test(v.url))) throw new SessionError("bad_request", "Session URL must use HTTPS.");
  if (JSON.stringify(v).length > 64_000) throw new SessionError("too_large", "Session metadata is too large.");
  if (["messages", "transcript", "analysis", "content"].some((key) => key in v)) throw new SessionError("bad_request", "Inventory must not contain message text.");
  return v as SessionRow;
}
