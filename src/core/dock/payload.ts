// Build the ThreadSummary / ThreadPayload shapes Still receives (protocol "Data shapes").
// Every builder here assumes the caller already decided the thread may be shared, and
// re-checks it anyway: a thread that is not remote-allowed never becomes a payload.

import { ensureStarterCollectionsAndSettings, findMatchingTombstone, type ThreadkeeperDB } from '../db.js';
import {
  THREAD_KIND_LABELS,
  buildThreadKey,
  computeDeterministicHash,
  insightKeyFor,
  type ConversationRecord,
  type ExtractedItem,
  type MessageRecord,
  type SettingsRecord,
  type StructuredSummaryRecord,
  type ThreadInsight,
  type ThreadKind,
} from '../schema.js';
import { getSmartTitle, LOCAL_ANALYZER_MODEL, resolveInsight } from '../insights.js';
import { providerCategory, providerLabel } from '../providers.js';
import { MODEL_OPTIONS } from '../ai/claude.js';
import { isRemoteAllowed, localOnlyProjectNames } from '../privacy.js';
import {
  TRANSCRIPT_HEAD_MESSAGES,
  TRANSCRIPT_MAX_MESSAGE_CHARS,
  TRANSCRIPT_MAX_MESSAGES,
  TRANSCRIPT_MAX_TOTAL_CHARS,
  WORKFLOW_STATES,
  threadHash,
  type EvidenceOut,
  type ThreadAnalysisOut,
  type ThreadPayload,
  type ThreadSummary,
  type TranscriptMessageOut,
  type TranscriptOut,
} from './protocol.js';

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const strList = (v: unknown, maxItems: number, maxLen: number): string[] =>
  Array.isArray(v)
    ? Array.from(new Set(v.filter((x): x is string => typeof x === 'string' && x.trim() !== '').map((x) => x.trim().slice(0, maxLen)))).slice(0, maxItems)
    : [];
const refs = (v: unknown, limit = 20): number[] =>
  Array.isArray(v)
    ? Array.from(new Set(v.filter((n): n is number => Number.isInteger(n) && n >= 0))).slice(0, limit)
    : [];
const refOf = (n: number | null | undefined): number | null => (typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : null);
const iso = (v: string | null | undefined): string | null => (v && Number.isFinite(Date.parse(v)) ? new Date(Date.parse(v)).toISOString() : null);

// ---------------------------------------------------------------------------
// Secrets and resume commands
// ---------------------------------------------------------------------------

const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-(?:ant-|proj-|live-|test-)?[A-Za-z0-9_-]{16,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
];

// NAME=value / NAME: value lines whose name mentions a key, token, secret or password.
const SECRET_ASSIGNMENT = /\b([A-Za-z0-9_.-]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD)[A-Za-z0-9_.-]*)(\s*[=:]\s*)("[^"\n]*"|'[^'\n]*'|[^\s"'\n]+)/gi;

/** Replace common secret patterns with [redacted] (used for tool and system messages). */
export function redactSecrets(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (match, bearer?: string) => (typeof bearer === 'string' && /^bearer$/i.test(bearer) ? `${bearer} [redacted]` : '[redacted]'));
  }
  out = out.replace(SECRET_ASSIGNMENT, (_m, name: string, sep: string, value: string) =>
    value === '[redacted]' || value.length === 0 ? `${name}${sep}${value}` : `${name}${sep}[redacted]`
  );
  return out;
}

const SESSION_ID_RE = /^[\w-]{1,128}$/;

function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Undo POSIX single/double quoting of one shell word (enough for the commands Threadkeeper writes). */
function unquoteWord(word: string): string {
  const w = word.trim();
  let out = '';
  for (let i = 0; i < w.length; ) {
    const ch = w[i];
    if (ch === "'") {
      const end = w.indexOf("'", i + 1);
      if (end < 0) return w;
      out += w.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '\\' && i + 1 < w.length) {
      out += w[i + 1];
      i += 2;
    } else if (ch === '"') {
      const end = w.indexOf('"', i + 1);
      if (end < 0) return w;
      out += w.slice(i + 1, end);
      i = end + 1;
    } else {
      out += ch;
      i += 1;
    }
  }
  return out;
}

/**
 * The resume command Still may show: only `claude --resume '<id>'` / `codex resume '<id>'`,
 * optionally prefixed with `cd '<path>' &&`, rebuilt from validated parts. Anything else → ''.
 */
export function safeResumeCommand(conv: Pick<ConversationRecord, 'provider' | 'resumeCommand' | 'workspacePath'>): string {
  const raw = (conv.resumeCommand ?? '').trim();
  if (!raw || raw.length > 2000 || /[\n\r\0]/.test(raw)) return '';
  const m = raw.match(/^(?:cd\s+(.+?)\s+&&\s+)?(claude\s+--resume|codex\s+resume)\s+(\S+)$/);
  if (!m) return '';
  const program = m[2].startsWith('claude') ? 'claude' : 'codex';
  if ((program === 'claude' && conv.provider !== 'claude_code') || (program === 'codex' && conv.provider !== 'codex')) return '';
  const id = unquoteWord(m[3]);
  if (!SESSION_ID_RE.test(id)) return '';
  const base = program === 'claude' ? `claude --resume ${singleQuote(id)}` : `codex resume ${singleQuote(id)}`;
  if (!m[1]) return base;
  const path = (conv.workspacePath ?? '').trim() || unquoteWord(m[1]);
  if (!path || path.length > 1000 || /[\n\r\0]/.test(path)) return base;
  return `cd ${singleQuote(path)} && ${base}`;
}

// ---------------------------------------------------------------------------
// Summary and payload
// ---------------------------------------------------------------------------

export function siblingThreadKeys(conv: ConversationRecord): string[] {
  const ids = Array.isArray(conv.siblingBranchIds) ? conv.siblingBranchIds : [];
  return ids
    .filter((b) => typeof b === 'string' && b && b !== conv.branchId)
    .slice(0, 50)
    .map((branchId) =>
      buildThreadKey({
        provider: conv.provider,
        accountId: conv.accountId,
        workspaceId: conv.workspaceId,
        sourceConversationId: conv.sourceConversationId,
        branchId,
      })
    );
}

/**
 * The analysis format of a thread's insight as the protocol reports it: 0 for on-device or none,
 * else the AI insight's `analysisVersion` (absent = 1; see ANALYSIS_VERSION in schema.ts).
 */
export function analysisVersionOf(insight: Pick<ThreadInsight, 'source' | 'analysisVersion'> | null | undefined): number {
  if (!insight || insight.source !== 'ai') return 0;
  const v = insight.analysisVersion;
  return typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.floor(v) : 1;
}

function kindLabel(kind: string): string {
  return (THREAD_KIND_LABELS as Record<string, string>)[kind] ?? '';
}

export function httpsUrl(url: string | null | undefined): string {
  const u = (url ?? '').trim();
  return /^https:\/\/[^\s]+$/i.test(u) && u.length <= 2000 ? u : '';
}

export function buildThreadSummary(conv: ConversationRecord, insight: ThreadInsight | null): ThreadSummary {
  const kind = insight?.kind ?? '';
  const state = (WORKFLOW_STATES as readonly string[]).includes(conv.workflowState) ? conv.workflowState : 'active';
  return {
    threadKey: conv.threadKey,
    hash: threadHash(conv.threadKey),
    title: str(getSmartTitle(conv, insight), 300) || 'Untitled thread',
    gist: str(insight?.gist, 300),
    provider: conv.provider,
    providerLabel: providerLabel(conv.provider),
    category: providerCategory(conv.provider),
    agentLabel: str(conv.agentLabel, 120),
    kind,
    kindLabel: kindLabel(kind),
    project: str(conv.project, 200),
    workflowState: state,
    createdAt: iso(conv.createdAt),
    updatedAt: iso(conv.updatedAt) ?? iso(conv.lastCapturedAt),
    messageCount: Math.max(0, conv.messageCount | 0),
    url: httpsUrl(conv.canonicalUrl),
    model: str(conv.modelSlug, 120),
    workspacePath: str(conv.workspacePath, 400),
    branchId: str(conv.branchId, 60),
    siblingThreadKeys: siblingThreadKeys(conv),
    analysisVersion: analysisVersionOf(insight),
  };
}

function modelLabel(insight: ThreadInsight): string {
  if (insight.source === 'local' || insight.model === LOCAL_ANALYZER_MODEL) return 'On-device analysis';
  return MODEL_OPTIONS.find((m) => m.id === insight.model)?.label ?? str(insight.model, 80);
}

function evidence(items: ExtractedItem[] | undefined): EvidenceOut[] {
  if (!Array.isArray(items)) return [];
  return items.slice(0, 30).map((item): EvidenceOut => {
    return {
      text: str(item.text, 600),
      rationale: str(item.rationale, 400),
      speaker: item.speaker === 'user_committed' ? 'user_committed' : 'assistant_suggested',
      refs: refs(item.messageIndexes),
      quote: str(item.evidenceQuote, 400),
    };
  }).filter((e) => e.text);
}

export function buildAnalysis(conv: ConversationRecord, insight: ThreadInsight | null, summary: StructuredSummaryRecord | null): ThreadAnalysisOut | null {
  if (!insight) return null;
  const s = summary;
  const kind: ThreadKind = insight.kind;
  const produced = Array.isArray(insight.produced) && insight.produced.length
    ? insight.produced.map((p) => ({ label: str(p.label, 200), kind: str(p.kind, 20) || 'other', description: str(p.description, 300), ref: refOf(p.messageIndex) }))
    : (insight.artifacts ?? []).map((a) => ({ label: str(a.label, 200), kind: str(a.kind, 20) || 'other', description: '', ref: refOf(a.messageIndex) }));
  const whereText = str(s?.whereYouLeftOff, 1200);
  return {
    source: insight.source,
    model: str(insight.model, 120),
    modelLabel: modelLabel(insight),
    generatedAt: iso(insight.generatedAt) ?? '',
    stale: insight.sourceRevision !== conv.sourceRevision,
    analysisVersion: analysisVersionOf(insight),
    gist: str(insight.gist, 400),
    overview: strList(insight.overview, 4, 2000),
    summary: str(insight.summary, 3000),
    userGoal: str(insight.userGoal, 600),
    outcome: str(insight.outcome, 600),
    statusReason: str(insight.statusReason, 400),
    kind,
    kindLabel: kindLabel(kind),
    topics: strList(insight.topics, 12, 60),
    entities: strList(insight.entities, 20, 120),
    languages: strList(insight.languages, 10, 40),
    keyPoints: (s?.keyPoints ?? []).slice(0, 12).map((k) => ({ text: str(k.text, 600), refs: refs(k.messageIndexes) })).filter((k) => k.text),
    artifacts: produced.filter((p) => p.label).slice(0, 20),
    whereYouLeftOff: whereText ? { text: whereText, refs: refs(s?.whereYouLeftOffMessageIndexes) } : null,
    nextStep: str(s?.nextStep ?? conv.nextStepText ?? '', 600),
    decisions: evidence(s?.decisions),
    actionItems: evidence(s?.actionItems),
    openQuestions: evidence(s?.openQuestions),
    constraints: evidence(s?.constraints),
  };
}

/** Hash of exactly the protocol's fingerprint inputs (never a clock value). */
export function fingerprintOf(p: Pick<ThreadPayload, 'revision' | 'contentHash' | 'title' | 'gist' | 'project' | 'workflowState' | 'tags' | 'pinned' | 'url' | 'coverage' | 'siblingThreadKeys' | 'analysis'>): string {
  const a = p.analysis;
  const parts = [
    p.revision,
    p.contentHash,
    p.title,
    p.gist,
    p.project,
    p.workflowState,
    [...p.tags].sort(),
    p.pinned,
    p.url,
    p.coverage,
    a ? [a.source, a.model, a.generatedAt, a.analysisVersion] : null,
    [...p.siblingThreadKeys].sort(),
  ];
  const text = JSON.stringify(parts);
  return `f1-${computeDeterministicHash(text)}${computeDeterministicHash(`fp:${text}`)}`;
}

/** Digest of the conversation row plus the AI insight time: what reconcile compares with the ledger. */
export function cheapDigestOf(conv: ConversationRecord, aiGeneratedAt: string | null | undefined, localGeneratedAt?: string | null): string {
  return computeDeterministicHash(
    JSON.stringify([
      conv.sourceRevision,
      conv.contentHash,
      conv.title,
      conv.manualTitleOverride,
      conv.project,
      [...conv.tags].sort(),
      conv.workflowState,
      conv.pinned,
      conv.canonicalUrl,
      conv.coverage,
      conv.siblingBranchIds,
      aiGeneratedAt ?? '',
      localGeneratedAt ?? '',
      conv.agentLabel ?? '',
    ])
  );
}

export interface TranscriptOptions {
  mode: 'none' | 'full' | 'window';
  window?: { from: number; count: number } | null;
  /** Total character budget for the messages (default ~3 MB). */
  budgetChars?: number;
}

function messageOut(m: MessageRecord): TranscriptMessageOut {
  let content = typeof m.content === 'string' ? m.content : '';
  if (m.role === 'tool' || m.role === 'system') content = redactSecrets(content);
  if (content.length > TRANSCRIPT_MAX_MESSAGE_CHARS) {
    const cut = content.length - TRANSCRIPT_MAX_MESSAGE_CHARS;
    content = `${content.slice(0, TRANSCRIPT_MAX_MESSAGE_CHARS)}\n\n[… cut: ${cut} more characters]`;
  }
  return { index: m.ordinal, role: m.role, content, createdAt: iso(m.createdAt) };
}

const MESSAGE_OVERHEAD = 90;
const costOf = (m: TranscriptMessageOut) => m.content.length + MESSAGE_OVERHEAD;

/** The transcript part of a payload within the protocol budget (first 20 + newest when over). */
export function buildTranscriptOut(messages: MessageRecord[], revision: number, options: TranscriptOptions): TranscriptOut {
  const sorted = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  const total = sorted.length;
  if (options.mode === 'none') {
    return { included: false, revision, truncated: false, totalMessages: total, from: 0, messages: [] };
  }
  const budget = Math.max(10_000, options.budgetChars ?? TRANSCRIPT_MAX_TOTAL_CHARS);
  if (options.mode === 'window') {
    const from = Math.max(0, options.window?.from ?? 0);
    const count = Math.min(500, Math.max(1, options.window?.count ?? 200));
    const slice = sorted.filter((m) => m.ordinal >= from && m.ordinal < from + count);
    const out: TranscriptMessageOut[] = [];
    let used = 0;
    let truncated = false;
    for (const m of slice) {
      const o = messageOut(m);
      if (out.length > 0 && used + costOf(o) > budget) {
        truncated = true;
        break;
      }
      used += costOf(o);
      out.push(o);
    }
    return { included: true, revision, truncated, totalMessages: total, from, messages: out };
  }
  const all = sorted.map(messageOut);
  const totalCost = all.reduce((n, m) => n + costOf(m), 0);
  if (all.length <= TRANSCRIPT_MAX_MESSAGES && totalCost <= budget) {
    return { included: true, revision, truncated: false, totalMessages: total, from: 0, messages: all };
  }
  // Over budget: keep the opening messages and the newest that fit.
  const head = all.slice(0, Math.min(TRANSCRIPT_HEAD_MESSAGES, all.length));
  let used = head.reduce((n, m) => n + costOf(m), 0);
  const tail: TranscriptMessageOut[] = [];
  for (let i = all.length - 1; i >= head.length; i--) {
    const m = all[i];
    if (head.length + tail.length >= TRANSCRIPT_MAX_MESSAGES || used + costOf(m) > budget) break;
    used += costOf(m);
    tail.push(m);
  }
  tail.reverse();
  // A single huge head can exceed the budget on its own; trim the head from its end then.
  while (head.length > 1 && used > budget) {
    const dropped = head.pop()!;
    used -= costOf(dropped);
  }
  return { included: true, revision, truncated: true, totalMessages: total, from: 0, messages: [...head, ...tail] };
}

export interface ThreadRecords {
  conv: ConversationRecord;
  local: ThreadInsight | undefined;
  ai: ThreadInsight | undefined;
  insight: ThreadInsight | null;
  summary: StructuredSummaryRecord | null;
}

export async function loadThreadRecords(db: ThreadkeeperDB, threadKey: string): Promise<ThreadRecords | null> {
  const conv = await db.conversations.get(threadKey);
  if (!conv) return null;
  const [local, ai, summary] = await Promise.all([
    db.insights.get(insightKeyFor('local', threadKey)),
    db.insights.get(insightKeyFor('ai', threadKey)),
    db.summaries.get(threadKey),
  ]);
  return { conv, local, ai, insight: resolveInsight(conv, local, ai), summary: summary ?? null };
}

/** Whether a thread may ever go to Still (privacy rule plus tombstones; synthetic threads never). */
export async function isShareable(
  db: ThreadkeeperDB,
  conv: ConversationRecord,
  settings: SettingsRecord,
  localOnly: ReadonlySet<string>
): Promise<boolean> {
  if (conv.isSyntheticBenchmark || !isRemoteAllowed(conv, settings, localOnly)) return false;
  return !(await findMatchingTombstone(db, conv));
}

export interface BuildPayloadOptions {
  transcript: 'none' | 'full' | 'window';
  window?: { from: number; count: number } | null;
  seq: number;
  /** Transcript character budget for this payload (to stay inside a 4 MB message). */
  transcriptBudgetChars?: number;
  /** Pre-loaded, to avoid re-reading inside batches. */
  localOnly?: ReadonlySet<string>;
  records?: ThreadRecords | null;
}

/**
 * The full payload for one thread, or null when it is missing, deleted, synthetic or not
 * remote-allowed. Transcripts are included only when the caller asks and Threadkeeper shares them.
 */
export async function buildThreadPayload(
  db: ThreadkeeperDB,
  settings: SettingsRecord | null,
  threadKey: string,
  options: BuildPayloadOptions
): Promise<ThreadPayload | null> {
  const s = settings ?? (await ensureStarterCollectionsAndSettings(db));
  const records = options.records ?? (await loadThreadRecords(db, threadKey));
  if (!records) return null;
  const localOnly = options.localOnly ?? (await localOnlyProjectNames(db));
  if (!(await isShareable(db, records.conv, s, localOnly))) return null;
  const { conv, insight, summary } = records;
  const base = buildThreadSummary(conv, insight);
  const analysis = buildAnalysis(conv, insight, summary);
  const mode = s.sidebarDock.shareTranscripts ? options.transcript : 'none';
  const messages = mode === 'none' ? [] : await db.messages.where('threadKey').equals(threadKey).sortBy('ordinal');
  const transcript =
    mode === 'none'
      ? { included: false, revision: conv.sourceRevision, truncated: false, totalMessages: conv.messageCount, from: 0, messages: [] }
      : buildTranscriptOut(messages, conv.sourceRevision, { mode, window: options.window, budgetChars: options.transcriptBudgetChars });
  const partial = {
    ...base,
    seq: options.seq,
    revision: conv.sourceRevision,
    contentHash: str(conv.contentHash, 128),
    coverage: conv.coverage,
    projectSource: str(conv.projectSource ?? 'default', 40),
    tags: strList(conv.tags, 30, 60),
    pinned: Boolean(conv.pinned),
    gitBranch: str(conv.gitBranch, 160),
    resumeCommand: safeResumeCommand(conv),
    analysis,
    transcript,
  };
  return { ...partial, fingerprint: fingerprintOf(partial) };
}
