// Still ⇄ ThreadStack protocol v1 (docs/sidebar-dock-integration.md): constants, ids, shapes and
// hand-written validators for everything Still sends (messages and responses). Pure: no chrome, no Dexie.

import type { DockSyncPrefs } from '../schema.js';
import { PROVIDER_CATEGORIES, type ProviderCategory } from '../providers.js';

export const PROTO = 'still-threadkeeper/1';
/** Any message or response is at most 4 MB of JSON. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Budget for the threads of one push or one threads.get response (leaves room for the envelope). */
export const RESPONSE_BUDGET_BYTES = Math.floor(3.9 * 1024 * 1024);
/** Transcript budget per thread in one payload. */
export const TRANSCRIPT_MAX_MESSAGES = 4000;
export const TRANSCRIPT_MAX_MESSAGE_CHARS = 120_000;
export const TRANSCRIPT_MAX_TOTAL_CHARS = 3 * 1024 * 1024;
export const TRANSCRIPT_HEAD_MESSAGES = 20;
/** Pending pair requests and Still's pending state expire after 10 minutes. */
export const PAIR_REQUEST_TTL_MS = 10 * 60_000;

export type DockErrorCode =
  | 'not_paired'
  | 'pending_approval'
  | 'denied'
  | 'bad_request'
  | 'unsupported'
  | 'version_mismatch'
  | 'too_large'
  | 'busy'
  | 'disabled'
  | 'not_found'
  | 'internal'
  /** Client-side only (never on the wire): no answer, extension missing or timed out. */
  | 'unreachable';

export const CAPABILITIES = ['sync', 'search', 'context', 'transcripts', 'open', 'remote_models', 'analyze'] as const;
export type DockCapability = (typeof CAPABILITIES)[number];

/** Message types Still may send to ThreadStack. */
export const INBOUND_TYPES = [
  'hello',
  'pair.request',
  'pair.revoke',
  'sync.configure',
  'sync.resync',
  'sync.status',
  'threads.search',
  'threads.list',
  'threads.get',
  'threads.context',
  'threads.related',
  'threads.untrack',
  'threads.analyze',
  'facets',
  'thread.open',
] as const;
export type InboundType = (typeof INBOUND_TYPES)[number];

/** Allowed from a sender that is not the paired Still. */
export const UNPAIRED_TYPES: ReadonlySet<string> = new Set(['hello', 'pair.request']);
/** Read requests: answer `disabled` when "Let Still search my threads" is off (threads.get with track excepted). */
export const READ_TYPES: ReadonlySet<string> = new Set([
  'threads.search',
  'threads.list',
  'threads.get',
  'threads.context',
  'threads.related',
  'facets',
]);

/** Message types ThreadStack sends to Still. */
export type OutboundType =
  | 'hello'
  | 'pair.granted'
  | 'pair.denied'
  | 'pair.revoke'
  | 'threads.upsert'
  | 'threads.remove'
  | 'collections.list'
  | 'chats.status';

export type SyncPrefs = DockSyncPrefs;

export const WORKFLOW_STATES = ['active', 'needs_review', 'waiting', 'paused', 'done', 'archived'] as const;

export interface ThreadExcerpt {
  text: string;
  messageIndex: number | null;
  role: string;
}

export interface ThreadSummary {
  threadKey: string;
  hash: string;
  title: string;
  gist: string;
  provider: string;
  providerLabel: string;
  category: ProviderCategory;
  agentLabel: string;
  kind: string;
  kindLabel: string;
  project: string;
  workflowState: (typeof WORKFLOW_STATES)[number];
  createdAt: string | null;
  updatedAt: string | null;
  messageCount: number;
  url: string;
  model: string;
  workspacePath: string;
  branchId: string;
  siblingThreadKeys: string[];
  analysisVersion: number;
  score?: number;
  match?: 'strong' | 'weak';
  matchReasons?: string[];
  excerpt?: ThreadExcerpt | null;
}

export interface EvidenceOut {
  text: string;
  rationale: string;
  speaker: 'user_committed' | 'assistant_suggested';
  refs: number[];
  quote: string;
}

export interface ThreadAnalysisOut {
  source: 'ai' | 'local';
  model: string;
  modelLabel: string;
  generatedAt: string;
  stale: boolean;
  analysisVersion: number;
  gist: string;
  overview: string[];
  summary: string;
  userGoal: string;
  outcome: string;
  statusReason: string;
  kind: string;
  kindLabel: string;
  topics: string[];
  entities: string[];
  languages: string[];
  keyPoints: Array<{ text: string; refs: number[] }>;
  artifacts: Array<{ label: string; kind: string; description: string; ref: number | null }>;
  whereYouLeftOff: null | { text: string; refs: number[] };
  nextStep: string;
  decisions: EvidenceOut[];
  actionItems: EvidenceOut[];
  openQuestions: EvidenceOut[];
  constraints: EvidenceOut[];
}

export interface TranscriptMessageOut {
  index: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string | null;
}

export interface TranscriptOut {
  included: boolean;
  revision: number;
  truncated: boolean;
  totalMessages: number;
  from: number;
  messages: TranscriptMessageOut[];
}

export interface ThreadPayload extends Omit<ThreadSummary, 'score' | 'match' | 'matchReasons' | 'excerpt'> {
  seq: number;
  revision: number;
  contentHash: string;
  fingerprint: string;
  coverage: string;
  projectSource: string;
  tags: string[];
  pinned: boolean;
  gitBranch: string;
  resumeCommand: string;
  analysis: ThreadAnalysisOut | null;
  transcript: TranscriptOut;
}

export interface DockFilters {
  providers?: string[];
  categories?: string[];
  kinds?: string[];
  projects?: string[];
  states?: string[];
  since?: string;
  until?: string;
  threadKeys?: string[];
  hashes?: string[];
}

export interface ErrorBody {
  code: DockErrorCode;
  message: string;
  retryAfterMs?: number;
}

export type DockResponse = ({ ok: true; proto: typeof PROTO } & Record<string, unknown>) | { ok: false; proto: typeof PROTO; error: ErrorBody };

// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;
const utf8 = new TextEncoder();

function fnv1a64Hex(text: string): string {
  let h = FNV_OFFSET;
  for (const byte of utf8.encode(text)) {
    h ^= BigInt(byte);
    h = (h * FNV_PRIME) & MASK_64;
  }
  return h.toString(16).padStart(16, '0');
}

/** 32 lowercase hex: FNV-1a 64 of the key and of 'still:' + key. Same algorithm as Still. */
export function threadHash(threadKey: string): string {
  return fnv1a64Hex(threadKey) + fnv1a64Hex(`still:${threadKey}`);
}

/** Still's library id for a chat. */
export function chatItemId(threadKey: string): string {
  return `chat_tk_${threadHash(threadKey)}`;
}

/** Citation id for a thread that is not in Still. */
export function threadCiteId(threadKey: string): string {
  return `tk:${threadHash(threadKey).slice(0, 16)}`;
}

export function isExtensionId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-p]{32}$/.test(value);
}

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
}

// ---------------------------------------------------------------------------
// Envelopes
// ---------------------------------------------------------------------------

/**
 * A flat outbound envelope. `pair.granted` / `pair.denied` carry the `requestId` of Still's
 * `pair.request` as their own envelope requestId (the protocol's field and the envelope's id are the
 * same key), so a requestId given in `fields` is kept; every other message gets a fresh one.
 */
export function buildEnvelope(type: OutboundType, fields: Record<string, unknown> = {}): Record<string, unknown> {
  const given = typeof fields.requestId === 'string' && fields.requestId ? fields.requestId : '';
  return { ...fields, proto: PROTO, from: 'threadkeeper', type, requestId: given || newRequestId() };
}

export function okResponse(data: Record<string, unknown> = {}): DockResponse {
  return { ...data, ok: true, proto: PROTO } as DockResponse;
}

export function errorResponse(code: DockErrorCode, message: string, retryAfterMs?: number): DockResponse {
  const error: ErrorBody = { code, message: message.slice(0, 300) };
  if (typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs)) error.retryAfterMs = Math.max(0, Math.round(retryAfterMs));
  return { ok: false, proto: PROTO, error };
}

/** UTF-8 size of the JSON form of a value (Infinity when it cannot be serialized). */
export function jsonByteLength(value: unknown): number {
  try {
    const text = JSON.stringify(value);
    return text === undefined ? 0 : utf8.encode(text).length;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export class BadRequest extends Error {
  readonly code: DockErrorCode;
  constructor(message: string, code: DockErrorCode = 'bad_request') {
    super(message);
    this.code = code;
  }
}

type Obj = Record<string, unknown>;

export function isObject(v: unknown): v is Obj {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

// Control characters (C0, DEL, C1) and bidi overrides/isolates.
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩؜]/g;

/** One line, control and bidi characters removed, collapsed spaces, at most `max` characters. */
export function oneLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

/** The self-declared app name shown in the consent window. */
export function sanitizeAppName(value: unknown): string {
  return oneLine(value, 40);
}

function optString(o: Obj, key: string, max: number): string | undefined {
  const v = o[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new BadRequest(`${key} must be a string`);
  if (v.length > max) throw new BadRequest(`${key} is too long`);
  return v;
}

function reqString(o: Obj, key: string, max: number, min = 1): string {
  const v = optString(o, key, max);
  if (v === undefined || v.trim().length < min) throw new BadRequest(`${key} is required`);
  return v;
}

function optInt(o: Obj, key: string, min: number, max: number, fallback: number): number {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new BadRequest(`${key} must be a number`);
  return Math.min(max, Math.max(min, Math.floor(v)));
}

function optBool(o: Obj, key: string, fallback: boolean): boolean {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'boolean') throw new BadRequest(`${key} must be true or false`);
  return v;
}

function optEnum<T extends string>(o: Obj, key: string, allowed: readonly T[], fallback: T): T {
  const v = o[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== 'string' || !(allowed as readonly string[]).includes(v)) throw new BadRequest(`${key} is not one of ${allowed.join(', ')}`);
  return v as T;
}

function stringList(v: unknown, key: string, maxItems: number, maxLen: number): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new BadRequest(`${key} must be a list`);
  if (v.length > maxItems) throw new BadRequest(`${key} has more than ${maxItems} entries`);
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string') throw new BadRequest(`${key} must hold strings`);
    if (item.length > maxLen) throw new BadRequest(`${key} has an entry that is too long`);
    if (item.trim() && !out.includes(item)) out.push(item);
  }
  return out;
}

function isoOrUndefined(v: unknown, key: string): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v !== 'string' || v.length > 40 || !Number.isFinite(Date.parse(v))) throw new BadRequest(`${key} must be an ISO date`);
  return new Date(Date.parse(v)).toISOString();
}

const HASH_RE = /^[0-9a-f]{32}$/;
const CITE_RE = /^tk:[0-9a-f]{16}$/;
const MAX_THREAD_KEY = 600;

export function parseFilters(raw: unknown): DockFilters {
  if (raw === undefined || raw === null) return {};
  if (!isObject(raw)) throw new BadRequest('filters must be an object');
  const f: DockFilters = {};
  const providers = stringList(raw.providers, 'filters.providers', 100, 40);
  if (providers.length) f.providers = providers;
  const categories = stringList(raw.categories, 'filters.categories', 10, 40);
  if (categories.some((c) => !(PROVIDER_CATEGORIES as readonly string[]).includes(c))) throw new BadRequest('filters.categories has an unknown category');
  if (categories.length) f.categories = categories;
  const kinds = stringList(raw.kinds, 'filters.kinds', 30, 40);
  if (kinds.length) f.kinds = kinds;
  const projects = stringList(raw.projects, 'filters.projects', 200, 200);
  if (projects.length) f.projects = projects;
  const states = stringList(raw.states, 'filters.states', 10, 40);
  if (states.some((s) => !(WORKFLOW_STATES as readonly string[]).includes(s))) throw new BadRequest('filters.states has an unknown state');
  if (states.length) f.states = states;
  const since = isoOrUndefined(raw.since, 'filters.since');
  if (since) f.since = since;
  const until = isoOrUndefined(raw.until, 'filters.until');
  if (until) f.until = until;
  const threadKeys = stringList(raw.threadKeys, 'filters.threadKeys', 500, MAX_THREAD_KEY);
  if (threadKeys.length) f.threadKeys = threadKeys;
  const hashes = stringList(raw.hashes, 'filters.hashes', 500, 32);
  if (hashes.some((h) => !HASH_RE.test(h))) throw new BadRequest('filters.hashes must be 32 hex characters');
  if (hashes.length) f.hashes = hashes;
  return f;
}

export function parseSyncPrefs(raw: unknown): SyncPrefs {
  if (!isObject(raw)) throw new BadRequest('prefs must be an object');
  const scope = raw.scope;
  if (scope !== 'all' && scope !== 'projects' && scope !== 'manual') throw new BadRequest('prefs.scope must be all, projects or manual');
  return {
    scope,
    projects: stringList(raw.projects, 'prefs.projects', 200, 200),
    providers: stringList(raw.providers, 'prefs.providers', 100, 40),
    transcripts: optBool(raw, 'transcripts', true),
    autoUpdate: optBool(raw, 'autoUpdate', true),
  };
}

function parseEpoch(o: Obj, required: boolean): string {
  const v = o.epoch;
  if (v === undefined || v === null || v === '') {
    if (required) throw new BadRequest('epoch is required');
    return '';
  }
  if (typeof v !== 'string' || !/^[\w-]{1,100}$/.test(v)) throw new BadRequest('epoch is not valid');
  return v;
}

// ---------------------------------------------------------------------------
// Inbound messages
// ---------------------------------------------------------------------------

export type EnvelopeCheck =
  | { ok: true; type: InboundType; message: Obj }
  | { ok: false; code: DockErrorCode; message: string };

/** Envelope and type allowlist (fields are validated by the per-type parsers). */
export function checkEnvelope(raw: unknown): EnvelopeCheck {
  if (!isObject(raw)) return { ok: false, code: 'bad_request', message: 'Message must be an object' };
  if (raw.proto !== PROTO) return { ok: false, code: 'version_mismatch', message: `Expected ${PROTO}` };
  if (raw.from !== 'still') return { ok: false, code: 'bad_request', message: 'from must be "still"' };
  if (typeof raw.type !== 'string' || !(INBOUND_TYPES as readonly string[]).includes(raw.type)) {
    return { ok: false, code: 'unsupported', message: `Unsupported type ${typeof raw.type === 'string' ? raw.type.slice(0, 40) : ''}`.trim() };
  }
  if (raw.requestId !== undefined && (typeof raw.requestId !== 'string' || raw.requestId.length > 100)) {
    return { ok: false, code: 'bad_request', message: 'requestId must be a short string' };
  }
  return { ok: true, type: raw.type as InboundType, message: raw };
}

export function parseHello(m: Obj): { epoch: string } {
  return { epoch: parseEpoch(m, false) };
}

export interface PairRequestFields {
  appName: string;
  appVersion: string;
  code: string;
  epoch: string;
  requestId: string;
}

export function parsePairRequest(m: Obj): PairRequestFields {
  const code = m.code;
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw new BadRequest('code must be 6 digits');
  const requestId = m.requestId;
  if (typeof requestId !== 'string' || !/^[\w.:-]{8,100}$/.test(requestId)) throw new BadRequest('requestId is required');
  if (m.appName !== undefined && typeof m.appName !== 'string') throw new BadRequest('appName must be a string');
  if (m.appVersion !== undefined && typeof m.appVersion !== 'string') throw new BadRequest('appVersion must be a string');
  return {
    appName: sanitizeAppName(m.appName) || 'Unnamed extension',
    appVersion: oneLine(m.appVersion, 40),
    code,
    epoch: parseEpoch(m, false),
    requestId,
  };
}

export function parseSyncConfigure(m: Obj): { prefs: SyncPrefs; epoch: string } {
  return { prefs: parseSyncPrefs(m.prefs), epoch: parseEpoch(m, false) };
}

export function parseSyncResync(m: Obj): { epoch: string } {
  return { epoch: parseEpoch(m, false) };
}

export type SemanticMode = 'local' | 'auto';
export type RerankMode = 'auto' | 'on' | 'off';

export interface SearchRequest {
  query: string;
  filters: DockFilters;
  limit: number;
  cursor: string | null;
  semantic: SemanticMode;
  rerank: RerankMode;
  excerpts: boolean;
  deadlineMs: number;
}

export function parseSearch(m: Obj): SearchRequest {
  return {
    query: (optString(m, 'query', 2000) ?? '').trim(),
    filters: parseFilters(m.filters),
    limit: optInt(m, 'limit', 1, 50, 20),
    cursor: optString(m, 'cursor', 200) ?? null,
    semantic: optEnum(m, 'semantic', ['local', 'auto'] as const, 'local'),
    rerank: optEnum(m, 'rerank', ['auto', 'on', 'off'] as const, 'auto'),
    excerpts: optBool(m, 'excerpts', true),
    deadlineMs: optInt(m, 'deadlineMs', 200, 12_000, 12_000),
  };
}

export interface ListRequest {
  filters: DockFilters;
  sort: 'recent' | 'oldest' | 'title';
  cursor: string | null;
  limit: number;
}

export function parseList(m: Obj): ListRequest {
  return {
    filters: parseFilters(m.filters),
    sort: optEnum(m, 'sort', ['recent', 'oldest', 'title'] as const, 'recent'),
    cursor: optString(m, 'cursor', 200) ?? null,
    limit: optInt(m, 'limit', 1, 100, 50),
  };
}

export interface GetRequest {
  /** Identifiers as Still sent them, with how to resolve each. */
  ids: Array<{ kind: 'threadKey' | 'citeId' | 'hash'; value: string }>;
  transcript: 'none' | 'full' | 'window';
  window: { from: number; count: number } | null;
  track: boolean;
}

export function parseGet(m: Obj): GetRequest {
  const threadKeys = stringList(m.threadKeys, 'threadKeys', 20, MAX_THREAD_KEY);
  const citeIds = stringList(m.citeIds, 'citeIds', 20, 19);
  const hashes = stringList(m.hashes, 'hashes', 20, 32);
  if (citeIds.some((c) => !CITE_RE.test(c))) throw new BadRequest('citeIds must look like tk:<16 hex>');
  if (hashes.some((h) => !HASH_RE.test(h))) throw new BadRequest('hashes must be 32 hex characters');
  const ids = [
    ...threadKeys.map((value) => ({ kind: 'threadKey' as const, value })),
    ...citeIds.map((value) => ({ kind: 'citeId' as const, value })),
    ...hashes.map((value) => ({ kind: 'hash' as const, value })),
  ];
  if (ids.length === 0) throw new BadRequest('threadKeys, citeIds or hashes is required');
  if (ids.length > 20) throw new BadRequest('At most 20 threads per request');
  const transcript = optEnum(m, 'transcript', ['none', 'full', 'window'] as const, 'none');
  let window: GetRequest['window'] = null;
  if (transcript === 'window') {
    if (!isObject(m.window)) throw new BadRequest('window is required for transcript "window"');
    const from = optInt(m.window, 'from', 0, 1_000_000, 0);
    const count = optInt(m.window, 'count', 1, 500, 200);
    window = { from, count };
  }
  return { ids, transcript, window, track: optBool(m, 'track', false) };
}

export interface ContextRequest {
  question: string;
  filters: DockFilters;
  limit: number;
  budgetChars: number;
  semantic: SemanticMode;
  rerank: RerankMode;
  deadlineMs: number;
}

export function parseContext(m: Obj): ContextRequest {
  return {
    question: reqString(m, 'question', 4000).trim(),
    filters: parseFilters(m.filters),
    limit: optInt(m, 'limit', 1, 8, 5),
    budgetChars: optInt(m, 'budgetChars', 500, 24_000, 12_000),
    semantic: optEnum(m, 'semantic', ['local', 'auto'] as const, 'local'),
    rerank: optEnum(m, 'rerank', ['auto', 'on', 'off'] as const, 'off'),
    deadlineMs: optInt(m, 'deadlineMs', 200, 9000, 2500),
  };
}

export function parseRelated(m: Obj): { threadKey: string; limit: number } {
  return { threadKey: reqString(m, 'threadKey', MAX_THREAD_KEY), limit: optInt(m, 'limit', 1, 20, 8) };
}

export function parseUntrack(m: Obj): { hashes: string[] } {
  const hashes = stringList(m.hashes, 'hashes', 500, 32);
  if (hashes.some((h) => !HASH_RE.test(h))) throw new BadRequest('hashes must be 32 hex characters');
  return { hashes };
}

export function parseAnalyze(m: Obj): { threadKeys: string[] } {
  const threadKeys = stringList(m.threadKeys, 'threadKeys', 50, MAX_THREAD_KEY);
  if (threadKeys.length === 0) throw new BadRequest('threadKeys is required');
  return { threadKeys };
}

export function parseThreadOpen(m: Obj): { threadKey: string } {
  return { threadKey: reqString(m, 'threadKey', MAX_THREAD_KEY) };
}

// ---------------------------------------------------------------------------
// Still's responses (validated and capped too)
// ---------------------------------------------------------------------------

export type SendResult<T> = { ok: true; data: T } | { ok: false; error: ErrorBody };

const ERROR_CODES: ReadonlySet<string> = new Set([
  'not_paired',
  'pending_approval',
  'denied',
  'bad_request',
  'unsupported',
  'version_mismatch',
  'too_large',
  'busy',
  'disabled',
  'not_found',
  'internal',
]);

/** Turn whatever Still answered into ok data or a typed error; anything malformed is `internal`. */
export function readResponse(raw: unknown): SendResult<Obj> {
  if (!isObject(raw)) return { ok: false, error: { code: 'internal', message: 'Still sent no answer' } };
  if (raw.ok === true) {
    if (raw.proto !== undefined && raw.proto !== PROTO) return { ok: false, error: { code: 'version_mismatch', message: 'Still speaks another protocol version' } };
    return { ok: true, data: raw };
  }
  const err = isObject(raw.error) ? raw.error : {};
  const code = typeof err.code === 'string' && ERROR_CODES.has(err.code) ? (err.code as DockErrorCode) : 'internal';
  const body: ErrorBody = { code, message: oneLine(err.message, 300) || code };
  if (typeof err.retryAfterMs === 'number' && Number.isFinite(err.retryAfterMs)) {
    body.retryAfterMs = Math.min(10 * 60_000, Math.max(0, Math.round(err.retryAfterMs)));
  }
  return { ok: false, error: body };
}

export type UpsertStatus = 'created' | 'updated' | 'unchanged' | 'skipped';
export interface UpsertResultIn {
  threadKey: string;
  status: UpsertStatus;
  reason: string;
  itemId: string;
  fingerprint: string;
  seq: number | null;
  needsTranscript: boolean;
}

export function readUpsertResults(data: Obj, sentKeys: ReadonlySet<string>): UpsertResultIn[] {
  const list = Array.isArray(data.results) ? data.results.slice(0, 200) : [];
  const out: UpsertResultIn[] = [];
  for (const r of list) {
    if (!isObject(r) || typeof r.threadKey !== 'string' || !sentKeys.has(r.threadKey)) continue;
    const status = r.status;
    if (status !== 'created' && status !== 'updated' && status !== 'unchanged' && status !== 'skipped') continue;
    out.push({
      threadKey: r.threadKey,
      status,
      reason: oneLine(r.reason, 40),
      itemId: typeof r.itemId === 'string' && /^[\w:.-]{1,200}$/.test(r.itemId) ? r.itemId : '',
      fingerprint: typeof r.fingerprint === 'string' ? r.fingerprint.slice(0, 128) : '',
      seq: typeof r.seq === 'number' && Number.isFinite(r.seq) ? r.seq : null,
      needsTranscript: r.needsTranscript === true,
    });
  }
  return out;
}

export function readRemoveResults(data: Obj, sentKeys: ReadonlySet<string>): Array<{ threadKey: string; status: 'removed' | 'kept' | 'missing' }> {
  const list = Array.isArray(data.results) ? data.results.slice(0, 500) : [];
  const out: Array<{ threadKey: string; status: 'removed' | 'kept' | 'missing' }> = [];
  for (const r of list) {
    if (!isObject(r) || typeof r.threadKey !== 'string' || !sentKeys.has(r.threadKey)) continue;
    if (r.status === 'removed' || r.status === 'kept' || r.status === 'missing') out.push({ threadKey: r.threadKey, status: r.status });
  }
  return out;
}

export interface StillCollection {
  id: string;
  name: string;
  parentId: string;
  path: string;
  icon: string;
  color: string;
}

export function readCollections(data: Obj): StillCollection[] {
  const list = Array.isArray(data.collections) ? data.collections.slice(0, 2000) : [];
  const out: StillCollection[] = [];
  for (const c of list) {
    if (!isObject(c) || typeof c.id !== 'string' || !/^[\w:.-]{1,200}$/.test(c.id)) continue;
    const name = oneLine(c.name, 200);
    if (!name) continue;
    out.push({
      id: c.id,
      name,
      parentId: typeof c.parentId === 'string' && /^[\w:.-]{1,200}$/.test(c.parentId) ? c.parentId : '',
      path: oneLine(c.path, 600) || name,
      icon: oneLine(c.icon, 40),
      color: oneLine(c.color, 40),
    });
  }
  return out;
}

export interface StillChatStatus {
  itemId: string;
  collectionId: string;
  collectionName: string;
  trashed: boolean;
  hasTranscript: boolean;
  transcriptRevision: number;
}

export function readChatsStatus(data: Obj, askedKeys: ReadonlySet<string>): Record<string, StillChatStatus> {
  const out: Record<string, StillChatStatus> = {};
  if (!isObject(data.chats)) return out;
  for (const [key, v] of Object.entries(data.chats)) {
    if (!askedKeys.has(key) || !isObject(v)) continue;
    out[key] = {
      itemId: typeof v.itemId === 'string' && /^[\w:.-]{1,200}$/.test(v.itemId) ? v.itemId : '',
      collectionId: typeof v.collectionId === 'string' && /^[\w:.-]{0,200}$/.test(v.collectionId) ? v.collectionId : '',
      collectionName: oneLine(v.collectionName, 200),
      trashed: v.trashed === true,
      hasTranscript: v.hasTranscript === true,
      transcriptRevision: typeof v.transcriptRevision === 'number' && Number.isFinite(v.transcriptRevision) ? v.transcriptRevision : -1,
    };
  }
  return out;
}

export function readStillHello(data: Obj): { app: string; version: string; paired: boolean; epoch: string } {
  return {
    app: oneLine(data.app, 40),
    version: oneLine(data.version, 40),
    paired: data.paired === true,
    epoch: typeof data.epoch === 'string' && /^[\w-]{1,100}$/.test(data.epoch) ? data.epoch : '',
  };
}
