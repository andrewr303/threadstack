import { buildThreadKey } from './schema.js';
import type { UpsertThreadInput } from './db.js';

/**
 * Parsers for local coding-agent transcripts:
 *   - Claude Code: ~/.claude/projects/<project-slug>/<session-id>.jsonl
 *   - Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl and
 *                  ~/.codex/archived_sessions/rollout-*.jsonl, either one
 *                  zstd-compressed to .jsonl.zst once it is a week old
 * Both are JSON Lines files; unknown record types are ignored so newer CLI
 * versions degrade gracefully instead of failing the import.
 */

type Msg = UpsertThreadInput['messages'][number];

const TOOL_RESULT_LIMIT = 700;
const TOOL_CALL_LIMIT = 240;

function parseJsonLines(text: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const v = JSON.parse(trimmed);
      if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Record<string, unknown>);
    } catch {
      // tolerate a truncated final line while the CLI is still writing
    }
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function truncate(text: string, limit: number): string {
  const clean = text.trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1)}…` : clean;
}

export function basenameOfPath(p: string | null | undefined): string | null {
  if (!p) return null;
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : null;
}

function repoNameFromUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = url.match(/[/:]([^/:]+?)(?:\.git)?\/?$/);
  return m ? m[1] : null;
}

function shellQuote(p: string): string {
  return /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, `'\\''`)}'`;
}

/**
 * Claude Code keeps side files beside each transcript: subagent and workflow
 * transcripts, spilled tool results, MCP task logs, auto memory, and set-aside
 * copies of a session. They carry the parent's sessionId, so importing one as a
 * thread would overwrite the parent; only <project>/<session>.jsonl is a thread.
 */
const CLAUDE_CODE_SIDE_DIRS = new Set(['subagents', 'tool-results', 'mcp-tasks', 'memory', 'workflows']);

/** True for a path (relative to the picked folder) that names a Claude Code side directory or side file. */
export function isClaudeCodeSideFile(path: string): boolean {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  const base = parts.pop() ?? '';
  if (parts.some((p) => CLAUDE_CODE_SIDE_DIRS.has(p))) return true;
  return (
    /^agent-.*\.jsonl$/i.test(base) || // legacy flat subagent transcript
    /\.orphaned-.*\.jsonl$/i.test(base) ||
    /\.jsonl\.superseded-/i.test(base)
  );
}

/** True for a directory name a folder walk should not descend into. */
export function isClaudeCodeSideDirectory(name: string): boolean {
  return CLAUDE_CODE_SIDE_DIRS.has(name);
}

/** "/name args" for a slash-command envelope; null for housekeeping commands or other text. */
function slashCommandText(raw: string): string | null {
  const command = raw.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (!command) return null;
  const args = (raw.match(/<command-args>([\s\S]*?)<\/command-args>/) ?? [])[1] ?? '';
  const name = command[1].trim();
  if (!name || /^\/(clear|exit|cost|help|config|status|model|login|logout)\b/.test(name)) return null;
  return `${name}${args.trim() ? ` ${args.trim()}` : ''}`;
}

/** Strip harness wrapper tags Claude Code injects into user turns. */
function cleanClaudeCodeUserText(raw: string): string | null {
  let text = raw;
  if (/<command-name>/.test(text)) return slashCommandText(text);
  if (/^\s*<local-command-(stdout|stderr)>/.test(text)) return null;
  text = text
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<command-message>[\s\S]*?<\/command-message>/g, '')
    .trim();
  if (!text || /^Caveat: The messages below were generated/i.test(text)) return null;
  return text;
}

function summarizeToolInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return name;
  const obj = input as Record<string, unknown>;
  const primary =
    str(obj.command) ||
    str(obj.file_path) ||
    str(obj.path) ||
    str(obj.pattern) ||
    str(obj.url) ||
    str(obj.query) ||
    str(obj.description) ||
    str(obj.prompt);
  return primary ? `${name}: ${truncate(primary, TOOL_CALL_LIMIT)}` : name;
}

function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' ? str((c as Record<string, unknown>).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Append, merging consecutive tool records so long agent loops stay readable. */
function pushMessage(messages: Msg[], next: Msg): void {
  const prev = messages[messages.length - 1];
  if (prev && next.role === 'tool' && prev.role === 'tool') {
    prev.content = truncate(`${prev.content}\n${next.content}`, 2400);
    return;
  }
  messages.push(next);
}

export interface CliParseOptions {
  accountId: string;
  workspaceId: string;
  fileName?: string;
}

export function looksLikeClaudeCodeSession(records: Array<Record<string, unknown>>): boolean {
  return records.some(
    (r) =>
      typeof r.sessionId === 'string' &&
      (r.type === 'user' || r.type === 'assistant') &&
      r.message !== undefined
  );
}

export function looksLikeCodexSession(records: Array<Record<string, unknown>>): boolean {
  const modern = records.some(
    (r) => r.type === 'session_meta' || r.type === 'response_item' || r.type === 'turn_context'
  );
  // Legacy rollouts: a header {id, timestamp, instructions} followed by bare Responses API items.
  const legacyHeader =
    typeof records[0]?.id === 'string' && 'instructions' in (records[0] ?? {});
  const legacyItems = records.some(
    (r) =>
      r.type === 'message' &&
      Array.isArray(r.content) &&
      (r.content as Array<Record<string, unknown>>).some(
        (c) => c?.type === 'input_text' || c?.type === 'output_text'
      )
  );
  return modern || (legacyHeader && legacyItems);
}

/** Title records, strongest first; a later record of one type replaces an earlier one. */
const CLAUDE_CODE_TITLE_TYPES = ['custom-title', 'agent-name', 'ai-title'] as const;
type ClaudeCodeTitleType = (typeof CLAUDE_CODE_TITLE_TYPES)[number];

function isClaudeCodeTitleType(v: unknown): v is ClaudeCodeTitleType {
  return CLAUDE_CODE_TITLE_TYPES.some((t) => t === v);
}

/** The field name differs between record types and CLI versions. */
function titleRecordText(r: Record<string, unknown>): string {
  for (const key of ['customTitle', 'agentName', 'aiTitle', 'title', 'name']) {
    const text = str(r[key]).replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return '';
}

export function parseClaudeCodeSession(
  text: string,
  options: CliParseOptions
): UpsertThreadInput | null {
  const records = parseJsonLines(text);
  if (!looksLikeClaudeCodeSession(records)) return null;

  const mainRecords = records.filter((r) => r.isSidechain !== true);
  if (mainRecords.every((r) => r.type !== 'user' && r.type !== 'assistant')) return null;

  let sessionId = '';
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let model: string | null = null;
  let summaryTitle: string | null = null;
  const recordTitles: Partial<Record<ClaudeCodeTitleType, string>> = {};
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  const messages: Msg[] = [];
  let lastAssistantId: string | null = null;

  for (const r of mainRecords) {
    const ts = str(r.timestamp) || null;
    if (r.type === 'summary' && typeof r.summary === 'string') {
      summaryTitle = r.summary.trim() || summaryTitle;
      continue;
    }
    if (isClaudeCodeTitleType(r.type)) {
      recordTitles[r.type] = titleRecordText(r) || recordTitles[r.type];
      continue;
    }
    if (r.type === 'system') {
      // Newer CLIs log slash commands as system records; their output and other subtypes are noise.
      if (r.subtype !== 'local_command') continue;
      const message = r.message && typeof r.message === 'object' ? (r.message as Record<string, unknown>) : {};
      const command = slashCommandText(str(r.content) || str(message.content));
      if (!command) continue;
      if (ts) {
        firstTs = firstTs ?? ts;
        lastTs = ts;
      }
      lastAssistantId = null;
      pushMessage(messages, {
        sourceMessageId: str(r.uuid) || `${messages.length}`,
        role: 'user',
        content: command,
        createdAt: ts,
        branchPath: 'main',
      });
      continue;
    }
    if (r.type !== 'user' && r.type !== 'assistant') continue;
    if (typeof r.sessionId === 'string' && !sessionId) sessionId = r.sessionId;
    if (typeof r.cwd === 'string' && r.cwd) cwd = r.cwd;
    if (typeof r.gitBranch === 'string' && r.gitBranch) gitBranch = r.gitBranch;
    if (ts) {
      firstTs = firstTs ?? ts;
      lastTs = ts;
    }
    if (r.isMeta === true || r.isCompactSummary === true) continue;

    const message = (r.message ?? {}) as Record<string, unknown>;
    const content = message.content;
    const uuid = str(r.uuid) || `${messages.length}`;

    if (r.type === 'user') {
      lastAssistantId = null;
      if (typeof content === 'string') {
        const cleaned = cleanClaudeCodeUserText(content);
        if (cleaned) {
          pushMessage(messages, { sourceMessageId: uuid, role: 'user', content: cleaned, createdAt: ts, branchPath: 'main' });
        }
        continue;
      }
      if (Array.isArray(content)) {
        for (const block of content as Array<Record<string, unknown>>) {
          if (block?.type === 'text') {
            const cleaned = cleanClaudeCodeUserText(str(block.text));
            if (cleaned) {
              pushMessage(messages, { sourceMessageId: `${uuid}:t`, role: 'user', content: cleaned, createdAt: ts, branchPath: 'main' });
            }
          } else if (block?.type === 'tool_result') {
            const out = toolResultText(block.content);
            if (out.trim()) {
              pushMessage(messages, {
                sourceMessageId: `${uuid}:r`,
                role: 'tool',
                content: `${block.is_error ? '[tool error] ' : '[tool result] '}${truncate(out, TOOL_RESULT_LIMIT)}`,
                createdAt: ts,
                branchPath: 'main',
              });
            }
          }
        }
      }
      continue;
    }

    // assistant
    if (typeof message.model === 'string' && message.model !== '<synthetic>') model = message.model;
    const apiMessageId = str(message.id) || uuid;
    const parts: string[] = [];
    const toolCalls: string[] = [];
    if (typeof content === 'string') parts.push(content);
    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (block?.type === 'text' && str(block.text).trim()) parts.push(str(block.text));
        else if (block?.type === 'tool_use') {
          toolCalls.push(`[tool] ${summarizeToolInput(str(block.name) || 'tool', block.input)}`);
        }
      }
    }
    const textPart = parts.join('\n\n').trim();
    const prev = messages[messages.length - 1];
    if (textPart) {
      if (prev && prev.role === 'assistant' && lastAssistantId === apiMessageId) {
        prev.content = `${prev.content}\n\n${textPart}`;
      } else {
        pushMessage(messages, { sourceMessageId: apiMessageId, role: 'assistant', content: textPart, createdAt: ts, branchPath: 'main' });
      }
      lastAssistantId = apiMessageId;
    }
    for (const call of toolCalls) {
      pushMessage(messages, { sourceMessageId: `${uuid}:call`, role: 'tool', content: call, createdAt: ts, branchPath: 'main' });
    }
  }

  if (!sessionId) {
    sessionId = (options.fileName ?? '').replace(/\.jsonl$/i, '') || `claude_code_${Date.now()}`;
  }
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  const title = (
    recordTitles['custom-title'] ||
    recordTitles['agent-name'] ||
    recordTitles['ai-title'] ||
    summaryTitle ||
    firstUser.replace(/\s+/g, ' ').slice(0, 90) ||
    'Claude Code session'
  ).trim();
  const project = basenameOfPath(cwd);

  return {
    threadKey: buildThreadKey({
      provider: 'claude_code',
      accountId: options.accountId,
      workspaceId: options.workspaceId,
      sourceConversationId: sessionId,
      branchId: 'main',
    }),
    provider: 'claude_code',
    accountId: options.accountId,
    workspaceId: options.workspaceId,
    sourceConversationId: sessionId,
    branchId: 'main',
    parentBranchId: null,
    siblingBranchIds: [],
    canonicalUrl: '',
    title,
    createdAt: firstTs,
    updatedAt: lastTs,
    coverage: messages.length > 0 ? 'full' : 'title_only',
    captureSource: 'export_import',
    messages: dedupeIds(messages),
    providerProjectName: project,
    workspacePath: cwd,
    gitBranch,
    modelSlug: model,
    resumeCommand: cwd
      ? `cd ${shellQuote(cwd)} && claude --resume ${sessionId}`
      : `claude --resume ${sessionId}`,
  };
}

function codexContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((c) => (c && typeof c === 'object' ? str((c as Record<string, unknown>).text) : ''))
    .filter(Boolean)
    .join('\n');
}

function isCodexHarnessText(text: string): boolean {
  return /^\s*<(environment_context|user_instructions|user_action|turn_aborted)>/.test(text) ||
    /^\s*# AGENTS\.md instructions/i.test(text);
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/**
 * Spawned sub-agents, reviews, guardian checks and memory consolidation run in
 * rollouts of their own. They are working state of another thread, often seeded
 * with its history, so they never become threads themselves.
 */
function isAuxiliaryCodexSession(meta: Record<string, unknown>): boolean {
  if (['agent_role', 'agent_type', 'agent_nickname', 'agent_path'].some((k) => str(meta[k]))) return true;
  const source = asRecord(meta.source);
  if ('subagent' in source || 'internal' in source) return true;
  return ['subagent', 'guardian_review', 'memory_consolidation'].includes(str(meta.thread_source));
}

function codexTitle(messages: Msg[]): string {
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  return (firstUser.replace(/\s+/g, ' ').slice(0, 90) || 'Codex session').trim();
}

export interface CodexRollout {
  /** The thread as this file alone describes it, including any history a fork replayed from its parent. */
  thread: UpsertThreadInput;
  /** Codex thread id from the file's first session_meta; a revert keeps it for the new rollout file. */
  threadId: string;
  /** Thread this one was forked from (forked_from_id, else parent_thread_id). */
  forkedFromId: string | null;
  /** Sub-agent or other internal rollout (see isAuxiliaryCodexSession). */
  auxiliary: boolean;
  /** Rollout file name without .zst; orders rollouts of one thread when their timestamps tie. */
  fileName: string;
}

/** Parse one Codex rollout file and keep the metadata needed to fold it with its siblings. */
export function parseCodexRollout(text: string, options: CliParseOptions): CodexRollout | null {
  const records = parseJsonLines(text);
  if (records.length === 0 || !looksLikeCodexSession(records)) return null;

  let sessionId = '';
  let meta: Record<string, unknown> | null = null;
  let cwd: string | null = null;
  let gitBranch: string | null = null;
  let repoUrl: string | null = null;
  let model: string | null = null;
  let firstTs: string | null = null;
  let lastTs: string | null = null;
  const messages: Msg[] = [];

  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    const ts = str(r.timestamp) || null;
    if (ts) {
      firstTs = firstTs ?? ts;
      lastTs = ts;
    }
    // Legacy header line: {"id": "...", "timestamp": "...", "instructions": ...}
    if (i === 0 && typeof r.id === 'string' && r.type === undefined) {
      sessionId = r.id;
      continue;
    }
    if (r.type === 'session_meta') {
      // The first session_meta is this rollout's own; a fork copies its parent's after it.
      if (meta) continue;
      meta = asRecord(r.payload);
      sessionId = str(meta.id) || sessionId;
      cwd = str(meta.cwd) || cwd;
      const git = asRecord(meta.git);
      gitBranch = str(git.branch) || gitBranch;
      repoUrl = str(git.repository_url) || repoUrl;
      continue;
    }
    if (r.type === 'turn_context') {
      const p = (r.payload ?? {}) as Record<string, unknown>;
      model = str(p.model) || model;
      cwd = str(p.cwd) || cwd;
      continue;
    }
    const item = (r.type === 'response_item' ? r.payload : r) as Record<string, unknown> | undefined;
    if (!item || typeof item !== 'object') continue;
    const id = `${sessionId || 'codex'}_${i}`;

    if (item.type === 'message') {
      const role = str(item.role);
      const body = codexContentText(item.content).trim();
      if (!body) continue;
      if (role === 'user') {
        if (isCodexHarnessText(body)) continue;
        pushMessage(messages, { sourceMessageId: id, role: 'user', content: body, createdAt: ts, branchPath: 'main' });
      } else if (role === 'assistant') {
        pushMessage(messages, { sourceMessageId: id, role: 'assistant', content: body, createdAt: ts, branchPath: 'main' });
      }
    } else if (item.type === 'function_call' || item.type === 'local_shell_call' || item.type === 'custom_tool_call') {
      let detail = str(item.arguments) || str(item.input);
      try {
        const parsed = JSON.parse(detail);
        const cmd = Array.isArray(parsed?.command) ? parsed.command.join(' ') : str(parsed?.command);
        detail = cmd || detail;
      } catch {
        // arguments are free text for custom tools
      }
      const action = (item.action ?? {}) as Record<string, unknown>;
      if (!detail && Array.isArray(action.command)) detail = (action.command as string[]).join(' ');
      pushMessage(messages, {
        sourceMessageId: id,
        role: 'tool',
        content: `[tool] ${str(item.name) || 'shell'}: ${truncate(detail.replace(/^bash -lc /, ''), TOOL_CALL_LIMIT)}`,
        createdAt: ts,
        branchPath: 'main',
      });
    } else if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
      let out = str(item.output);
      try {
        const parsed = JSON.parse(out);
        out = str(parsed?.output) || out;
      } catch {
        // plain text output
      }
      if (out.trim()) {
        pushMessage(messages, {
          sourceMessageId: id,
          role: 'tool',
          content: `[tool result] ${truncate(out, TOOL_RESULT_LIMIT)}`,
          createdAt: ts,
          branchPath: 'main',
        });
      }
    }
  }

  const fileName = (options.fileName ?? '').replace(/\.zst$/i, '');
  if (!sessionId) {
    const m = fileName.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    sessionId = m ? m[1] : fileName.replace(/\.jsonl$/i, '') || `codex_${Date.now()}`;
  }
  if (!messages.some((m) => m.role === 'user' || m.role === 'assistant')) return null;

  const project = repoNameFromUrl(repoUrl) ?? basenameOfPath(cwd);
  const forkedFromId = (meta && (str(meta.forked_from_id) || str(meta.parent_thread_id))) || null;
  const isFork = forkedFromId !== null && forkedFromId !== sessionId;
  // A fork is stored as a branch of its root thread, the shape ChatGPT branches
  // already use (shared sourceConversationId, own branchId, parentBranchId), so
  // the library links it to its parent with no schema change and its own id
  // stays the branch id. session_id names the root thread on current CLIs.
  const rootSession = meta ? str(meta.session_id) : '';
  const conversationId = isFork ? (rootSession && rootSession !== sessionId ? rootSession : forkedFromId) : sessionId;
  const branchId = isFork ? sessionId : 'main';
  const parentBranchId = isFork ? (forkedFromId === conversationId ? 'main' : forkedFromId) : null;

  return {
    thread: {
      threadKey: buildThreadKey({
        provider: 'codex',
        accountId: options.accountId,
        workspaceId: options.workspaceId,
        sourceConversationId: conversationId,
        branchId,
      }),
      provider: 'codex',
      accountId: options.accountId,
      workspaceId: options.workspaceId,
      sourceConversationId: conversationId,
      branchId,
      parentBranchId,
      // Left unset on a root thread so links to forks from earlier imports are kept.
      siblingBranchIds: parentBranchId ? Array.from(new Set(['main', parentBranchId])) : undefined,
      canonicalUrl: '',
      title: codexTitle(messages),
      createdAt: firstTs,
      updatedAt: lastTs,
      coverage: 'full',
      captureSource: 'export_import',
      messages: dedupeIds(isFork ? messages.map((m) => ({ ...m, branchPath: branchId })) : messages),
      providerProjectName: project,
      workspacePath: cwd,
      gitBranch,
      modelSlug: model,
      resumeCommand: cwd ? `cd ${shellQuote(cwd)} && codex resume ${sessionId}` : `codex resume ${sessionId}`,
    },
    threadId: sessionId,
    forkedFromId: isFork ? forkedFromId : null,
    auxiliary: meta ? isAuxiliaryCodexSession(meta) : false,
    fileName,
  };
}

/** One Codex rollout file as a thread; null for unrecognized files and sub-agent rollouts. */
export function parseCodexSession(
  text: string,
  options: CliParseOptions
): UpsertThreadInput | null {
  const rollout = parseCodexRollout(text, options);
  return rollout && !rollout.auxiliary ? rollout.thread : null;
}

function rolloutTime(r: CodexRollout): number {
  const t = Date.parse(r.thread.updatedAt ?? '');
  return Number.isNaN(t) ? -Infinity : t;
}

/** Newest content wins: latest record timestamp, then the later file name, then the longer transcript. */
function isNewerRollout(a: CodexRollout, b: CodexRollout): boolean {
  const ta = rolloutTime(a);
  const tb = rolloutTime(b);
  if (ta !== tb) return ta > tb;
  if (a.fileName !== b.fileName) return a.fileName > b.fileName;
  return a.thread.messages.length > b.thread.messages.length;
}

export type StoredMessage = Pick<Msg, 'role' | 'content'>;

/**
 * How many leading fork messages repeat the parent: the longest shared run,
 * minus a final user turn when the fork goes on differently after it (that
 * turn is the fork re-asking where it split off, not replayed history).
 */
function replayedPrefixLength(parent: StoredMessage[], fork: Msg[]): number {
  let n = 0;
  while (
    n < parent.length &&
    n < fork.length &&
    parent[n].role === fork[n].role &&
    parent[n].content.trim() === fork[n].content.trim()
  ) {
    n++;
  }
  if (n > 0 && n < fork.length && fork[n - 1].role === 'user') n--;
  return n;
}

/**
 * The fork without the history it replayed, which stays on the parent thread
 * (so the fork alone is partial coverage); null when it has nothing of its own yet.
 */
function dropReplayedHistory(rollout: CodexRollout, parent: StoredMessage[]): UpsertThreadInput | null {
  const { thread } = rollout;
  const n = replayedPrefixLength(parent, thread.messages);
  if (n === 0) return { ...thread };
  const own = thread.messages.slice(n);
  if (!own.some((m) => m.role === 'user' || m.role === 'assistant')) return null;
  const marker: Msg = {
    sourceMessageId: `${rollout.threadId}_forked`,
    role: 'system',
    content: `Forked from Codex thread ${rollout.forkedFromId}; the ${n === 1 ? 'earlier message is' : `${n} earlier messages are`} on that thread.`,
    createdAt: thread.createdAt,
    branchPath: thread.branchId,
  };
  return { ...thread, title: codexTitle(own), coverage: 'partial', messages: [marker, ...own] };
}

/**
 * Fold the Codex rollouts of one import into threads:
 *   - rollouts sharing a thread id (a revert writes rollout-<ts>-<id>_<rolloutId>.jsonl
 *     beside the original) are one thread, and the newest content wins;
 *   - sub-agent and other internal rollouts are dropped;
 *   - a fork drops the leading messages it replayed from its parent, compared with
 *     the parent's rollout in this import, else with the parent thread already stored;
 *   - a parent in this import lists its forks as sibling branches.
 */
export async function resolveCodexRollouts(
  rollouts: CodexRollout[],
  loadStoredMessages: (threadKey: string) => Promise<StoredMessage[]> = async () => []
): Promise<UpsertThreadInput[]> {
  const newest = new Map<string, CodexRollout>();
  for (const r of rollouts) {
    const prev = newest.get(r.threadId);
    if (!prev || isNewerRollout(r, prev)) newest.set(r.threadId, r);
  }

  const threads: UpsertThreadInput[] = [];
  for (const r of newest.values()) {
    if (r.auxiliary) continue;
    if (!r.forkedFromId) {
      threads.push({ ...r.thread });
      continue;
    }
    const parentRollout = newest.get(r.forkedFromId);
    const parentMessages = parentRollout
      ? parentRollout.thread.messages
      : await loadStoredMessages(
          buildThreadKey({
            provider: 'codex',
            accountId: r.thread.accountId,
            workspaceId: r.thread.workspaceId,
            sourceConversationId: r.thread.sourceConversationId,
            branchId: r.thread.parentBranchId ?? 'main',
          })
        );
    const fork = dropReplayedHistory(r, parentMessages);
    if (fork) threads.push(fork);
  }

  for (const fork of threads) {
    if (!fork.parentBranchId) continue;
    const parent = threads.find(
      (t) => t.sourceConversationId === fork.sourceConversationId && t.branchId === fork.parentBranchId
    );
    if (parent) parent.siblingBranchIds = Array.from(new Set([...(parent.siblingBranchIds ?? []), fork.branchId]));
  }
  return threads;
}

/** Merged records can reuse a source id; message keys must stay unique. */
function dedupeIds(messages: Msg[]): Msg[] {
  const seen = new Map<string, number>();
  return messages.map((m) => {
    const n = seen.get(m.sourceMessageId) ?? 0;
    seen.set(m.sourceMessageId, n + 1);
    return n === 0 ? m : { ...m, sourceMessageId: `${m.sourceMessageId}#${n}` };
  });
}

export { parseJsonLines };
