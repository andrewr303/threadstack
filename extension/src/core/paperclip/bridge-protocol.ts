// The browser bridge has its own identity and consent; Still's pairing is never reused.
import { BadRequest, isObject, jsonByteLength, MAX_MESSAGE_BYTES } from '../dock/protocol.js';

export const BRIDGE_PROTOCOL = 'paperclip-threadkeeper/1' as const;
export const BRIDGE_API_PATH = '/api/plugins/browser-sessions/api';
export const BRIDGE_STORAGE_KEY = 'tk.paperclip.bridge.v1';
export const BRIDGE_POLL_MS = 20_000;
export const BRIDGE_RESULT_CHARS = 60_000;
export const BRIDGE_SUPPORTED_PROVIDERS = ['claude', 'claude_code', 'chatgpt', 'codex'] as const;

export interface ActionPolicy { enabled: boolean; providers: string[]; disabledAt: number }
export const DEFAULT_ACTION_POLICY: ActionPolicy = { enabled: false, providers: [], disabledAt: 0 };

export interface SessionLink {
  id: string; companyId: string; issueId: string; threadKey: string;
  origin: 'user' | 'auto' | 'agent'; creator: string; createdAt: string;
  issueTitle?: string; issueIdentifier?: string; issueStatus?: string; startedByAgentId?: string | null;
}

export interface ChangedHint { type: 'paperclip.changed'; companyId: string; issueIds: string[]; runIds: string[] }
/** Only IDs cross the bridge; the plugin independently verifies the issue's company. */
export interface AutomaticSessionLink { issueId: string; threadKey: string }
export interface SessionStateChange { threadKey: string; from: string; to: string; at: string; observed: true }
export interface SessionObservations {
  snapshot(threadKey: string): { state: string; at: number } | null;
  flushSettledChanges(): SessionStateChange[];
}

export interface BridgeRequest {
  requestId: string; type: string; params: Record<string, unknown>; createdAt: number; deadlineAt: number;
}
export type BridgeErrorCode = 'not_paired' | 'pending_approval' | 'denied' | 'bad_request' | 'unsupported' | 'version_mismatch' | 'too_large' | 'busy' | 'disabled' | 'not_found' | 'internal' | 'browser_offline' | 'timeout' | 'signed_out' | 'unknown_delivery' | 'rate_limited';
export type BridgeResult = { requestId: string; ok: true; data: Record<string, unknown> } | { requestId: string; ok: false; error: { code: BridgeErrorCode; message: string } };
export class BridgeActionError extends Error {
  constructor(readonly code: BridgeErrorCode, message: string) { super(message); this.name = 'BridgeActionError'; }
}

interface AgentActionBase {
  companyId: string; agentId: string; issueId: string; clientRequestId: string;
  requestId: string; createdAt: number; deadlineAt: number; policyDisabledAt: number;
}
export type AgentAction = (AgentActionBase & { type: 'session.send'; threadKey: string; text: string; provider: string; accountId: string; url: string })
  | (AgentActionBase & { type: 'session.start'; provider: string; accountId?: string; prompt: string });
export type ActionOutcome = { delivered: true; at: string } | { started: true; url: string; threadKey: string | null };

export function normalizeActionPolicy(raw: unknown): ActionPolicy {
  if (!isObject(raw)) return { ...DEFAULT_ACTION_POLICY, providers: [] };
  return {
    enabled: raw.enabled === true,
    providers: Array.isArray(raw.providers) ? [...new Set(raw.providers.filter((p): p is string => typeof p === 'string' && BRIDGE_SUPPORTED_PROVIDERS.includes(p as typeof BRIDGE_SUPPORTED_PROVIDERS[number])))].sort() : [],
    disabledAt: typeof raw.disabledAt === 'number' && Number.isSafeInteger(raw.disabledAt) && raw.disabledAt >= 0 ? raw.disabledAt : 0,
  };
}

/** A remote switch can revoke consent, never widen the extension's local consent. */
export function mergeActionPolicy(local: ActionPolicy, remote: ActionPolicy): ActionPolicy {
  return { enabled: local.enabled && remote.enabled, providers: local.providers.filter(p => remote.providers.includes(p)).sort(), disabledAt: Math.max(local.disabledAt, remote.disabledAt) };
}

const REQUEST_TYPES = new Set(['threads.list', 'threads.search', 'threads.get', 'threads.context', 'threads.related', 'facets', 'thread.open', 'view.open', 'session.send', 'session.start']);

export function parseBridgeRequest(raw: unknown, now = Date.now()): BridgeRequest {
  if (!isObject(raw) || jsonByteLength(raw) > MAX_MESSAGE_BYTES) throw new BadRequest('Bridge request is too large or malformed', 'too_large');
  if (typeof raw.requestId !== 'string' || raw.requestId.length < 1 || raw.requestId.length > 128) throw new BadRequest('requestId is required');
  if (typeof raw.type !== 'string' || !REQUEST_TYPES.has(raw.type)) throw new BadRequest('Unsupported bridge request', 'unsupported');
  if (!isObject(raw.params)) throw new BadRequest('params must be an object');
  if (typeof raw.createdAt !== 'number' || !Number.isSafeInteger(raw.createdAt) || raw.createdAt < 0 || raw.createdAt > now + 30_000) throw new BadRequest('Invalid request creation time');
  if (typeof raw.deadlineAt !== 'number' || !Number.isSafeInteger(raw.deadlineAt) || raw.deadlineAt <= now) throw new BadRequest('Bridge request expired', 'bad_request');
  if (raw.deadlineAt - raw.createdAt > 120_000) throw new BadRequest('Bridge deadline is too far away');
  return raw as unknown as BridgeRequest;
}

export function bridgeFailure(requestId: string, code: BridgeErrorCode, message: string): BridgeResult {
  return { requestId, ok: false, error: { code, message } };
}

/** D-11: the build id is `${stamp}-${sha}`; Paperclip compares commits, so only the sha is sent. */
export function commitOfBuildId(buildId: string): string {
  const part = String(buildId ?? '').split('-').at(-1)?.trim() ?? '';
  return /^[0-9a-f]{7,40}$/i.test(part) ? part.toLowerCase() : '';
}

/** Time reserved before an action's `deadlineAt` to post its verdict to Paperclip. */
export const VERDICT_MARGIN_MS = 1_500;

/** REQ-11 FR-1 exact texts (timeout as in REQ-8 FR-9). */
export const ACTION_TEXT = {
  disabled: 'Agent actions are turned off.',
  denied: 'This agent is not trusted for browser actions.',
  unlinked: 'The session is not linked to the task you are working on.',
  timeout: 'The browser did not answer in 30 seconds.',
  unknown: 'The message may or may not have been sent. Read the session before trying again.',
} as const;
export type ActionAbortReason = 'disabled' | 'timeout' | 'denied' | 'unlinked';
/**
 * Why an action was aborted: 'timeout' at its deadline, 'denied' when Paperclip cancels that one request
 * (`cancelledRequestIds`, e.g. trust removed), 'disabled' on any switch-off.
 */
export function actionAbortReason(signal: AbortSignal | undefined): ActionAbortReason {
  return parseAbortReason(signal?.reason);
}
export function parseAbortReason(value: unknown): ActionAbortReason {
  return value === 'timeout' || value === 'denied' || value === 'unlinked' ? value : 'disabled';
}
/** Wire code for an abort reason: both trust removal and a vanished link are `denied` (FR-1). */
export function abortCode(reason: ActionAbortReason): BridgeErrorCode { return reason === 'unlinked' ? 'denied' : reason; }
/** The error for an action stopped before anything was typed. */
export function abortedBeforeTyping(signal: AbortSignal | undefined): BridgeActionError {
  const reason = actionAbortReason(signal);
  return new BridgeActionError(abortCode(reason), ACTION_TEXT[reason]);
}

/** Pause between bridge ticks while running. */
export const BRIDGE_LOOP_MS = 1_000;
/** Long-poll wait the extension asks for; with BRIDGE_LOOP_MS it bounds how fast a cancel is seen. */
export const BRIDGE_POLL_WAIT_MS = 3_000;
