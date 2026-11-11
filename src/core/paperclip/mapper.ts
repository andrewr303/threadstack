/**
 * Pure mapping from Paperclip records to Threadkeeper threads.
 *
 * One Paperclip issue is one thread: the issue description, its comment thread, and the
 * transcripts of the agent runs that worked on it, in time order. Run transcripts come from the
 * run log (each adapter's CLI prints JSON lines on stdout: Claude Code stream-json, `codex exec
 * --json`, OpenCode, Gemini, Grok…) or, for Paperclip's native runner (Grok Bot, OpenAI Dots,
 * Muse), from the run's conversation events. Tool calls are condensed the way local Claude Code
 * and Codex sessions are (see cli-sessions.ts): one short `[tool] …` line per call and a clipped
 * result, so long agent loops stay readable and analysis stays cheap.
 */
import { buildThreadKey, type WorkflowState } from '../schema.js';
import type { UpsertThreadInput } from '../db.js';
import { normalizeRepository } from '../repository.js';
import type { PcAgent, PcComment, PcCompany, PcIssue, PcIssueRun, PcRun, PcRunEvent } from './client.js';

export type Msg = UpsertThreadInput['messages'][number];

const TOOL_CALL_LIMIT = 240;
const TOOL_RESULT_LIMIT = 700;
const TOOL_MERGE_LIMIT = 2400;
const ASSISTANT_LIMIT = 20_000;
const USER_LIMIT = 8_000;
const DESCRIPTION_LIMIT = 60_000;
const COMMENT_LIMIT = 30_000;
/** Messages kept per run; a longer run keeps its opening and its most recent steps. */
export const RUN_MESSAGE_LIMIT = 400;
const RUN_HEAD_KEEP = 40;
/** Messages kept per thread across description, comments and runs. */
export const THREAD_MESSAGE_LIMIT = 4000;

export const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted']);

export function isTerminalRun(status: string | null | undefined): boolean {
  return TERMINAL_RUN_STATUSES.has(String(status ?? ''));
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function rec(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function clip(text: string, limit: number): string {
  const clean = text.trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// Agents and runners
// ---------------------------------------------------------------------------

const ADAPTER_LABELS: Record<string, string> = {
  claude_local: 'Claude Code',
  codex_local: 'Codex',
  cursor: 'Cursor',
  cursor_cloud: 'Cursor',
  gemini_local: 'Gemini CLI',
  grok_local: 'Grok Build',
  hermes_local: 'Hermes',
  hermes_gateway: 'Hermes',
  kimi_local: 'Kimi',
  opencode_local: 'OpenCode',
  pi_local: 'Pi',
  openclaw_gateway: 'OpenClaw',
  process: 'Process',
  http: 'HTTP bot',
};

const NATIVE_PROVIDER_LABELS: Record<string, string> = {
  grok_bot: 'Grok Bot',
  openai_dot: 'OpenAI Dot',
  muse: 'Muse',
};

const ROLE_LABELS: Record<string, string> = {
  ceo: 'CEO',
  cto: 'CTO',
  cmo: 'CMO',
  cfo: 'CFO',
  pm: 'PM',
  qa: 'QA',
  devops: 'DevOps',
};

function titleCase(value: string): string {
  return value
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** The runner an agent uses, e.g. "Claude Code", "Grok Bot", "Muse". */
export function runnerLabel(adapterType: string | null | undefined, adapterConfig?: Record<string, unknown> | null): string {
  const type = str(adapterType);
  if (type === 'paperclip_runner') {
    const provider = str(adapterConfig?.provider);
    if (NATIVE_PROVIDER_LABELS[provider]) return NATIVE_PROVIDER_LABELS[provider];
    const acpx = str(adapterConfig?.acpxAgent);
    if (provider === 'acpx' && acpx) return acpx === 'grok' ? 'Grok Build' : titleCase(acpx);
    return provider ? titleCase(provider) : 'Paperclip runner';
  }
  return ADAPTER_LABELS[type] ?? (type ? titleCase(type.replace(/_local$|_gateway$/, '')) : '');
}

/** "CEO · Grok Bot", "Engineer · Claude Code", or just "Muse" when the agent is named after its runner. */
export function agentLabel(agent: PcAgent | null | undefined, adapterType?: string | null): string {
  if (!agent && !adapterType) return '';
  const runner = runnerLabel(agent?.adapterType ?? adapterType, agent?.adapterConfig);
  const role = str(agent?.role);
  const name = str(agent?.name).trim() || (role ? ROLE_LABELS[role] ?? titleCase(role) : '');
  if (!name) return runner;
  if (!runner || name.toLowerCase() === runner.toLowerCase()) return name;
  return `${name} · ${runner}`.slice(0, 120);
}

/** Paperclip issue status → Threadkeeper workflow state. */
export function workflowStateForIssue(status: string | null | undefined): WorkflowState {
  switch (status) {
    case 'in_progress':
      return 'active';
    case 'in_review':
      return 'needs_review';
    case 'todo':
    case 'backlog':
      return 'waiting';
    case 'blocked':
      return 'paused';
    case 'done':
      return 'done';
    case 'cancelled':
      return 'archived';
    default:
      return 'active';
  }
}

/** Deep link into the Paperclip UI (`/:companyPrefix/issues/:identifier`). */
export function issueUrl(serverUrl: string, company: Pick<PcCompany, 'issuePrefix'> | null, issue: Pick<PcIssue, 'id' | 'identifier'>): string {
  const origin = serverUrl.replace(/\/+$/, '');
  const ref = encodeURIComponent(issue.identifier || issue.id);
  const prefix = str(company?.issuePrefix).trim();
  return prefix ? `${origin}/${encodeURIComponent(prefix)}/issues/${ref}` : `${origin}/issues/${ref}`;
}

// ---------------------------------------------------------------------------
// Run transcripts
// ---------------------------------------------------------------------------

export type TranscriptEntry =
  | { kind: 'assistant'; ts: string | null; text: string; delta?: boolean; itemId?: string }
  | { kind: 'user'; ts: string | null; text: string }
  | { kind: 'tool_call'; ts: string | null; name: string; input: unknown }
  | { kind: 'tool_result'; ts: string | null; text: string; isError: boolean }
  | { kind: 'init'; ts: string | null; model: string; sessionId: string }
  | { kind: 'result'; ts: string | null; isError: boolean; errors: string[] }
  | { kind: 'error'; ts: string | null; text: string };

/**
 * Split a run log (NDJSON records `{ts, stream, chunk}`) into stdout lines. Chunks can end
 * mid-line, so stdout is reassembled before splitting; each line keeps the time of the chunk it
 * started in. stderr and Paperclip's own system lines are not part of the conversation.
 */
export function stdoutLinesFromLog(content: string): Array<{ text: string; ts: string | null }> {
  const out: Array<{ text: string; ts: string | null }> = [];
  let buffer = '';
  let bufferTs: string | null = null;
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    let record: Record<string, unknown> | null = null;
    try {
      record = rec(JSON.parse(line));
    } catch {
      continue;
    }
    if (!record || record.stream !== 'stdout' || typeof record.chunk !== 'string') continue;
    const ts: string | null = str(record.ts) || null;
    const firstTs: string | null = buffer ? bufferTs : ts;
    const parts = (buffer + record.chunk).split('\n');
    const rest = parts.pop() ?? '';
    parts.forEach((line, i) => {
      if (line.trim()) out.push({ text: line, ts: i === 0 ? firstTs : ts });
    });
    buffer = rest;
    bufferTs = parts.length > 0 ? (rest ? ts : null) : firstTs;
  }
  if (buffer.trim()) out.push({ text: buffer, ts: bufferTs });
  return out;
}

function blockText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => {
      const r = rec(c);
      return r ? str(r.text) : '';
    })
    .filter(Boolean)
    .join('\n');
}

function errorText(value: unknown): string {
  if (typeof value === 'string') return value;
  const r = rec(value);
  return r ? str(r.message) || str(r.error) || str(r.code) : '';
}

/** Claude Code stream-json and the CLIs that copy it (Cursor, Gemini, Kimi). */
function parseMessageLine(parsed: Record<string, unknown>, type: string, ts: string | null): TranscriptEntry[] {
  const message = rec(parsed.message) ?? {};
  const content = Array.isArray(message.content) ? message.content : null;
  const entries: TranscriptEntry[] = [];
  if (!content) {
    const text = str(message.content) || str(parsed.text) || str(parsed.content);
    if (text.trim()) entries.push(type === 'user' ? { kind: 'user', ts, text } : { kind: 'assistant', ts, text });
    return entries;
  }
  for (const raw of content) {
    const block = rec(raw);
    if (!block) continue;
    const blockType = str(block.type);
    if (blockType === 'text' || blockType === 'output_text') {
      const text = str(block.text);
      if (text.trim()) entries.push(type === 'user' ? { kind: 'user', ts, text } : { kind: 'assistant', ts, text });
    } else if (blockType === 'tool_use' || blockType === 'tool_call') {
      entries.push({ kind: 'tool_call', ts, name: str(block.name) || 'tool', input: block.input ?? block.arguments ?? {} });
    } else if (blockType === 'tool_result' || blockType === 'tool_response') {
      entries.push({ kind: 'tool_result', ts, text: blockText(block.content ?? block.output), isError: block.is_error === true });
    }
    // thinking blocks are not part of the conversation
  }
  return entries;
}

/** `codex exec --json` items. */
function parseCodexItem(item: Record<string, unknown>, ts: string | null, phase: 'started' | 'completed'): TranscriptEntry[] {
  const type = str(item.type);
  if (type === 'agent_message') {
    const text = str(item.text);
    return phase === 'completed' && text.trim() ? [{ kind: 'assistant', ts, text }] : [];
  }
  if (type === 'command_execution') {
    if (phase === 'started') return [{ kind: 'tool_call', ts, name: 'shell', input: { command: str(item.command) } }];
    const exit = typeof item.exit_code === 'number' ? item.exit_code : null;
    const status = str(item.status);
    const output = str(item.aggregated_output).trim() || (status ? `status: ${status}` : 'command completed');
    return [{ kind: 'tool_result', ts, text: output, isError: (exit !== null && exit !== 0) || /fail|error|cancel/.test(status) }];
  }
  if (type === 'file_change' && phase === 'completed') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    const list = changes
      .map((c) => rec(c))
      .filter((c): c is Record<string, unknown> => Boolean(c))
      .map((c) => `${str(c.kind) || 'update'} ${str(c.path) || 'file'}`);
    return [{ kind: 'tool_call', ts, name: 'edit', input: { description: list.join(', ') || 'files changed' } }];
  }
  if ((type === 'tool_use' || type === 'mcp_tool_call') && phase === 'started') {
    return [{ kind: 'tool_call', ts, name: str(item.name) || str(item.tool) || 'tool', input: item.input ?? item.arguments ?? {} }];
  }
  if ((type === 'tool_result' || type === 'tool_use' || type === 'mcp_tool_call') && phase === 'completed') {
    const text = str(item.content) || str(item.output) || str(item.result) || errorText(item.error);
    return text.trim() ? [{ kind: 'tool_result', ts, text, isError: item.is_error === true || str(item.status) === 'error' }] : [];
  }
  if (type === 'error' && phase === 'completed') {
    return [{ kind: 'error', ts, text: errorText(item.message ?? item.error) || 'error' }];
  }
  return [];
}

/**
 * One stdout line of an agent CLI, whichever CLI printed it. Lines that are not JSON, and event
 * types that carry no conversation (progress, reasoning, step markers), give nothing.
 */
export function parseStdoutLine(line: string, ts: string | null = null): TranscriptEntry[] {
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = rec(JSON.parse(line));
  } catch {
    return [];
  }
  if (!parsed) return [];
  const type = str(parsed.type);
  switch (type) {
    case 'system': {
      if (parsed.subtype === 'init') {
        return [{ kind: 'init', ts, model: str(parsed.model), sessionId: str(parsed.session_id) || str(parsed.sessionId) }];
      }
      if (parsed.subtype === 'error') return [{ kind: 'error', ts, text: errorText(parsed.error ?? parsed.message) || 'error' }];
      return [];
    }
    case 'assistant':
    case 'user':
      return parseMessageLine(parsed, type, ts);
    case 'result': {
      const errors = Array.isArray(parsed.errors) ? parsed.errors.map(errorText).filter(Boolean) : [];
      return [{ kind: 'result', ts, isError: parsed.is_error === true, errors }];
    }
    case 'thread.started':
      return [{ kind: 'init', ts, model: str(parsed.model), sessionId: str(parsed.thread_id) }];
    case 'item.started':
    case 'item.completed': {
      const item = rec(parsed.item);
      return item ? parseCodexItem(item, ts, type === 'item.started' ? 'started' : 'completed') : [];
    }
    case 'turn.failed':
      return [{ kind: 'result', ts, isError: true, errors: [errorText(parsed.error ?? parsed.message)].filter(Boolean) }];
    case 'text': {
      // OpenCode: { part: { text } }; Grok Build: streamed deltas in `data`.
      const part = rec(parsed.part);
      if (part) {
        const text = str(part.text);
        return text.trim() ? [{ kind: 'assistant', ts, text }] : [];
      }
      const data = str(parsed.data);
      return data ? [{ kind: 'assistant', ts, text: data, delta: true }] : [];
    }
    case 'tool_use': {
      // OpenCode: { part: { tool, state: { input, output, status } } }
      const part = rec(parsed.part) ?? parsed;
      const state = rec(part.state) ?? {};
      const entries: TranscriptEntry[] = [
        { kind: 'tool_call', ts, name: str(part.tool) || str(part.name) || 'tool', input: state.input ?? part.input ?? {} },
      ];
      const output = str(state.output) || errorText(state.error);
      if (output.trim()) entries.push({ kind: 'tool_result', ts, text: output, isError: str(state.status) === 'error' });
      return entries;
    }
    case 'error':
      return [{ kind: 'error', ts, text: errorText(parsed.message ?? parsed.error ?? parsed.data) || 'error' }];
    default:
      return [];
  }
}

export function entriesFromLog(content: string): TranscriptEntry[] {
  return stdoutLinesFromLog(content).flatMap((l) => parseStdoutLine(l.text, l.ts));
}

/** Item kinds are spelled agent_message / agentMessage / AgentMessage across runner versions. */
function nativeKind(payload: Record<string, unknown>): string {
  const item = rec(payload.item) ?? payload;
  return (str(payload.kind) || str(item.kind) || str(item.type)).replace(/_/g, '').toLowerCase();
}

/**
 * Native-runner runs (paperclip_runner: Grok Bot, OpenAI Dots, Muse, ACPX) report their
 * conversation as `paperclip.prp.event.v1` envelopes in the run's events. Completed assistant
 * items win over their streamed deltas; tool items become condensed tool lines.
 */
export function entriesFromNativeEvents(events: PcRunEvent[]): TranscriptEntry[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const completed = new Set<string>();
  for (const event of ordered) {
    const envelope = rec(event.payload?.prpEvent);
    const payload = rec(envelope?.payload);
    if (!envelope || !payload || event.eventType !== 'item.completed') continue;
    const item = rec(payload.item) ?? payload;
    const id = str(envelope.itemId) || str(payload.itemId) || str(item.id);
    const kind = nativeKind(payload);
    if (id && (kind === 'agentmessage' || kind === 'assistantmessage')) completed.add(id);
  }
  const entries: TranscriptEntry[] = [];
  for (const event of ordered) {
    const envelope = rec(event.payload?.prpEvent);
    const payload = rec(envelope?.payload);
    if (!envelope || !payload) continue;
    const ts = str(envelope.ts) || str(event.createdAt) || null;
    const item = rec(payload.item) ?? payload;
    const id = str(envelope.itemId) || str(payload.itemId) || str(item.id);
    const kind = nativeKind(payload);
    const text = str(payload.text) || str(item.text);
    if (kind === 'agentmessage' || kind === 'assistantmessage') {
      if (event.eventType === 'item.completed' && text.trim()) entries.push({ kind: 'assistant', ts, text, ...(id ? { itemId: id } : {}) });
      else if (event.eventType === 'item.delta' && text && !(id && completed.has(id))) {
        entries.push({ kind: 'assistant', ts, text, delta: true, ...(id ? { itemId: id } : {}) });
      }
      continue;
    }
    if (kind === 'usermessage' && event.eventType === 'item.completed' && text.trim()) {
      entries.push({ kind: 'user', ts, text });
      continue;
    }
    if ((kind === 'toolcall' || kind === 'tooluse' || kind === 'commandexecution') && event.eventType === 'item.started') {
      entries.push({ kind: 'tool_call', ts, name: str(item.name) || str(item.tool) || (kind === 'commandexecution' ? 'shell' : 'tool'), input: item.input ?? item.arguments ?? { command: str(item.command) } });
      continue;
    }
    if ((kind === 'toolresult' || kind === 'toolcall' || kind === 'tooluse' || kind === 'commandexecution') && event.eventType === 'item.completed') {
      const out = str(item.output) || str(item.result) || str(item.aggregated_output) || blockText(item.content);
      if (out.trim()) entries.push({ kind: 'tool_result', ts, text: out, isError: item.is_error === true || item.isError === true });
      continue;
    }
    if (/^(turn|run)\.failed$/.test(event.eventType)) {
      entries.push({ kind: 'error', ts, text: errorText(payload.error ?? payload.message) || 'failed' });
    }
  }
  return entries;
}

function summarizeToolInput(name: string, input: unknown): string {
  const obj = rec(input);
  if (!obj) return typeof input === 'string' && input.trim() ? `${name}: ${clip(input, TOOL_CALL_LIMIT)}` : name;
  let primary =
    str(obj.command) ||
    str(obj.cmd) ||
    str(obj.file_path) ||
    str(obj.filePath) ||
    str(obj.path) ||
    str(obj.pattern) ||
    str(obj.url) ||
    str(obj.query) ||
    str(obj.description) ||
    str(obj.prompt);
  if (!primary && Array.isArray(obj.command)) primary = (obj.command as unknown[]).map(String).join(' ');
  primary = primary.replace(/^bash -lc /, '');
  return primary ? `${name}: ${clip(primary, TOOL_CALL_LIMIT)}` : name;
}

export interface RunTranscript {
  messages: Msg[];
  model: string | null;
  sessionId: string | null;
  errors: string[];
}

/**
 * Condense a run's transcript entries into thread messages with ids `run:<runId>:<n>`:
 * consecutive assistant text becomes one message, tool calls and results become short merged
 * `tool` lines, and a very long run keeps its opening and its latest steps.
 */
export function runEntriesToMessages(runId: string, entries: TranscriptEntry[], fallbackTs: string | null): RunTranscript {
  const messages: Msg[] = [];
  let model: string | null = null;
  let sessionId: string | null = null;
  const errors: string[] = [];
  let lastAssistantItem: string | null | undefined;
  const push = (role: Msg['role'], content: string, ts: string | null) => {
    const prev = messages[messages.length - 1];
    if (prev && role === 'tool' && prev.role === 'tool') {
      prev.content = clip(`${prev.content}\n${content}`, TOOL_MERGE_LIMIT);
      return;
    }
    messages.push({ sourceMessageId: '', role, content, createdAt: ts ?? fallbackTs, branchPath: 'main' });
  };

  for (const entry of entries) {
    switch (entry.kind) {
      case 'assistant': {
        const prev = messages[messages.length - 1];
        if (prev && prev.role === 'assistant') {
          const sameStream = entry.delta && (entry.itemId === undefined || entry.itemId === lastAssistantItem);
          prev.content = clip(`${prev.content}${sameStream ? '' : '\n\n'}${entry.text}`, ASSISTANT_LIMIT);
        } else if (entry.text.trim()) {
          push('assistant', clip(entry.text, ASSISTANT_LIMIT), entry.ts);
        }
        lastAssistantItem = entry.itemId;
        break;
      }
      case 'user':
        if (entry.text.trim()) push('user', clip(entry.text, USER_LIMIT), entry.ts);
        lastAssistantItem = undefined;
        break;
      case 'tool_call':
        push('tool', `[tool] ${summarizeToolInput(entry.name, entry.input)}`, entry.ts);
        lastAssistantItem = undefined;
        break;
      case 'tool_result':
        if (entry.text.trim()) {
          push('tool', `${entry.isError ? '[tool error] ' : '[tool result] '}${clip(entry.text, TOOL_RESULT_LIMIT)}`, entry.ts);
        }
        lastAssistantItem = undefined;
        break;
      case 'init':
        if (entry.model && entry.model !== 'unknown') model = entry.model;
        if (entry.sessionId) sessionId = entry.sessionId;
        break;
      case 'result':
        if (entry.isError) errors.push(...entry.errors);
        break;
      case 'error':
        errors.push(entry.text);
        break;
    }
  }

  // Trim whitespace-only assistant streams and keep long runs bounded.
  let kept = messages.filter((m) => m.content.trim());
  if (kept.length > RUN_MESSAGE_LIMIT) {
    const head = kept.slice(0, RUN_HEAD_KEEP);
    const tail = kept.slice(kept.length - (RUN_MESSAGE_LIMIT - RUN_HEAD_KEEP - 1));
    const skipped = kept.length - head.length - tail.length;
    kept = [
      ...head,
      {
        sourceMessageId: '',
        role: 'system',
        content: `… ${skipped} earlier steps of this run are not shown …`,
        createdAt: tail[0]?.createdAt ?? fallbackTs,
        branchPath: 'main',
      },
      ...tail,
    ];
  }
  kept.forEach((m, i) => {
    m.sourceMessageId = `run:${runId}:${i}`;
  });
  return { messages: kept, model, sessionId, errors: Array.from(new Set(errors.map((e) => clip(e, 300)))).slice(0, 3) };
}

/**
 * Header id of a run block. It encodes what makes a stored transcript reusable (a finished run
 * whose log size is unchanged needs no new download) and the CLI session the run resumed, which
 * links the issue to the matching Claude Code or Codex thread.
 */
export function runHeaderId(run: Pick<PcIssueRun, 'runId' | 'status' | 'logBytes'>, sessionId?: string | null): string {
  const base = `run:${run.runId}:h:${run.status}:${Math.max(0, Math.trunc(Number(run.logBytes ?? 0)) || 0)}`;
  return sessionId && SAFE_SESSION_ID.test(sessionId) ? `${base}:s:${sessionId}` : base;
}

/** Parse a header id back into its run id, status, log size and session. */
export function parseRunHeaderId(
  id: string
): { runId: string; status: string; logBytes: number; sessionId: string | null } | null {
  const m = id.match(/^run:([^:]+):h:([a-z_]+):(\d+)(?::s:([A-Za-z0-9_-]{1,128}))?$/);
  return m ? { runId: m[1], status: m[2], logBytes: Number(m[3]), sessionId: m[4] ?? null } : null;
}

function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n);
}

const RUN_STATUS_LABELS: Record<string, string> = {
  queued: 'queued',
  scheduled_retry: 'waiting to retry',
  running: 'running',
  succeeded: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
  timed_out: 'timed out',
  interrupted: 'interrupted',
};

/** The one-line system message that opens a run block. */
export function runHeaderText(
  run: PcIssueRun,
  options: { agent: string; detail?: Pick<PcRun, 'error'> | null; errors?: string[]; omitted?: boolean }
): string {
  const parts: string[] = [];
  parts.push(`Paperclip run${options.agent ? ` by ${options.agent}` : ''}`);
  const status = RUN_STATUS_LABELS[run.status] ?? run.status;
  const duration =
    run.startedAt && run.finishedAt ? formatDuration(Date.parse(run.finishedAt) - Date.parse(run.startedAt)) : '';
  parts.push(duration ? `${status} in ${duration}` : status);
  const usage = rec(run.usageJson) ?? {};
  const tokens = Number(usage.inputTokens ?? usage.input_tokens ?? 0) + Number(usage.outputTokens ?? usage.output_tokens ?? 0);
  if (Number.isFinite(tokens) && tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  const result = rec(run.resultJson) ?? {};
  const cost = Number(result.costUsd ?? result.total_cost_usd ?? result.cost_usd ?? usage.costUsd ?? NaN);
  if (Number.isFinite(cost) && cost > 0) parts.push(`$${cost.toFixed(2)}`);
  let text = parts.join(' · ');
  const failure = (options.errors ?? []).concat(run.status === 'failed' ? [str(options.detail?.error) || str(run.error)] : []).filter(Boolean);
  if (failure.length > 0) text += `\nError: ${clip(failure[0], 300)}`;
  if (options.omitted) text += '\n(Transcript of this older run not imported.)';
  return text;
}

// ---------------------------------------------------------------------------
// Issue → thread
// ---------------------------------------------------------------------------

export interface RunBlock {
  run: PcIssueRun;
  /** Header + transcript messages, ids already assigned (`run:<runId>:…`). */
  messages: Msg[];
  model: string | null;
  sessionId: string | null;
  cwd: string | null;
}

export interface IssueThreadInput {
  serverUrl: string;
  company: PcCompany;
  issue: PcIssue;
  comments: PcComment[];
  runs: RunBlock[];
  agents: Map<string, PcAgent>;
  projectName?: string | null;
  goalTitle?: string | null;
  account: { accountId: string; workspaceId: string };
  linkedThreadKeys?: string[];
}

export function paperclipThreadKey(account: { accountId: string; workspaceId: string }, issueId: string): string {
  return buildThreadKey({
    provider: 'paperclip',
    accountId: account.accountId,
    workspaceId: account.workspaceId,
    sourceConversationId: issueId,
    branchId: 'main',
  });
}

function latest(...values: Array<string | null | undefined>): string | null {
  let best: string | null = null;
  let bestT = -Infinity;
  for (const v of values) {
    const t = v ? Date.parse(v) : NaN;
    if (Number.isFinite(t) && t > bestT) {
      bestT = t;
      best = new Date(t).toISOString();
    }
  }
  return best;
}

/** `cd <cwd> && claude --resume <id>` / Codex in Paperclip's managed CODEX_HOME; null when not resumable. */
export function resumeCommandFor(block: RunBlock | undefined, companyId: string): string | null {
  if (!block?.sessionId || !SAFE_SESSION_ID.test(block.sessionId)) return null;
  const type = block.run.adapterType;
  const cd = block.cwd ? `cd ${shellQuote(block.cwd)} && ` : '';
  if (type === 'claude_local') return `${cd}claude --resume ${block.sessionId}`;
  if (type === 'codex_local' && /^[A-Za-z0-9-]{1,64}$/.test(companyId)) {
    return `${cd}CODEX_HOME="$HOME/.paperclip/instances/default/companies/${companyId}/codex-home" codex resume ${block.sessionId}`;
  }
  return null;
}

/** The thread Threadkeeper stores for one Paperclip issue. */
export function buildIssueThread(input: IssueThreadInput): UpsertThreadInput {
  const { issue, company, agents } = input;
  const identifier = str(issue.identifier).trim();
  const title = `${identifier ? `${identifier} ` : ''}${str(issue.title).trim() || 'Untitled issue'}`.slice(0, 300);

  // Name agents in comments only when more than one agent speaks in the thread.
  const commentAgents = new Set(
    input.comments.filter((c) => c.authorType === 'agent' && c.authorAgentId).map((c) => c.authorAgentId as string)
  );
  const nameAgents = commentAgents.size > 1;

  type Segment = { t: number; order: number; messages: Msg[] };
  const segments: Segment[] = [];
  const time = (v: string | null | undefined) => {
    const t = v ? Date.parse(v) : NaN;
    return Number.isFinite(t) ? t : 0;
  };

  const creator = issue.createdByAgentId ? agents.get(issue.createdByAgentId) : undefined;
  const description = clip(str(issue.description), DESCRIPTION_LIMIT);
  segments.push({
    t: time(issue.createdAt),
    order: 0,
    messages: [
      {
        sourceMessageId: `issue:${issue.id}:description`,
        role: 'user',
        content: `${creator ? `Task from ${agentLabel(creator)}\n\n` : ''}${description || str(issue.title).trim() || title}`,
        createdAt: issue.createdAt ?? null,
        branchPath: 'main',
      },
    ],
  });

  input.comments.forEach((c, i) => {
    if (c.deletedAt) return;
    const body = clip(str(c.body), COMMENT_LIMIT);
    if (!body) return;
    const system = c.authorType === 'system' || c.presentation?.kind === 'system_notice';
    const role: Msg['role'] = system ? 'system' : c.authorType === 'agent' ? 'assistant' : 'user';
    const author = c.authorAgentId ? agents.get(c.authorAgentId) : undefined;
    const content = role === 'assistant' && nameAgents && author ? `**${author.name}:** ${body}` : body;
    segments.push({
      t: time(c.createdAt),
      order: 1 + i,
      messages: [{ sourceMessageId: `comment:${c.id}`, role, content, createdAt: c.createdAt ?? null, branchPath: 'main' }],
    });
  });

  input.runs.forEach((block, i) => {
    if (block.messages.length === 0) return;
    segments.push({ t: time(block.run.startedAt ?? block.run.createdAt), order: 100_000 + i, messages: block.messages });
  });

  segments.sort((a, b) => a.t - b.t || a.order - b.order);
  let messages = segments.flatMap((s) => s.messages);
  if (messages.length > THREAD_MESSAGE_LIMIT) {
    // Keep the task itself and the most recent work.
    messages = [messages[0], ...messages.slice(messages.length - (THREAD_MESSAGE_LIMIT - 1))];
  }

  const runsNewestFirst = [...input.runs].sort(
    (a, b) => time(b.run.startedAt ?? b.run.createdAt) - time(a.run.startedAt ?? a.run.createdAt)
  );
  const assignee = issue.assigneeAgentId ? agents.get(issue.assigneeAgentId) : undefined;
  const lastRunAgent = runsNewestFirst[0]?.run.agentId ? agents.get(runsNewestFirst[0].run.agentId as string) : undefined;
  const workingAgent = assignee ?? lastRunAgent ?? creator;
  const label = workingAgent ? agentLabel(workingAgent) : runsNewestFirst[0] ? runnerLabel(runsNewestFirst[0].run.adapterType) : '';

  const lastComment = input.comments.filter((c) => !c.deletedAt).at(-1);
  const updatedAt =
    latest(
      issue.updatedAt,
      issue.lastActivityAt,
      lastComment?.createdAt,
      ...input.runs.map((b) => b.run.finishedAt ?? b.run.startedAt)
    ) ?? issue.createdAt ?? null;

  const workspace = issue.currentExecutionWorkspace ?? null;
  const resumable = runsNewestFirst.find((b) => b.sessionId && (b.run.adapterType === 'claude_local' || b.run.adapterType === 'codex_local'));
  const model =
    runsNewestFirst.find((b) => b.model)?.model ??
    (workingAgent ? str(rec(workingAgent.adapterConfig)?.model) || null : null);
  const project =
    str(input.projectName).trim() || str(issue.project?.name).trim() || str(input.goalTitle).trim() || str(issue.goal?.title).trim() || str(company.name).trim();

  return {
    threadKey: paperclipThreadKey(input.account, issue.id),
    provider: 'paperclip',
    accountId: input.account.accountId,
    workspaceId: input.account.workspaceId,
    sourceConversationId: issue.id,
    branchId: 'main',
    parentBranchId: null,
    siblingBranchIds: [],
    canonicalUrl: issueUrl(input.serverUrl, company, issue),
    title,
    createdAt: issue.createdAt ?? null,
    updatedAt,
    coverage: 'full',
    captureSource: 'export_import',
    messages,
    providerProjectName: project || null,
    workspacePath: str(workspace?.cwd) || resumable?.cwd || null,
    gitBranch: str(workspace?.branchName) || null,
    // Only a remote the issue's workspace names; the project name is not a repository.
    ...(normalizeRepository(str(workspace?.repoUrl)) ? { repository: normalizeRepository(str(workspace?.repoUrl)) } : {}),
    modelSlug: model,
    // Claude Code finds a session by its working directory, so the command starts there.
    resumeCommand: resumeCommandFor(resumable && { ...resumable, cwd: resumable.cwd ?? (str(workspace?.cwd) || null) }, company.id),
    agentLabel: label || null,
    linkedThreadKeys: input.linkedThreadKeys ?? [],
  };
}
