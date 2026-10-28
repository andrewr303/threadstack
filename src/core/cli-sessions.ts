import { buildThreadKey } from './schema.js';
import type { UpsertThreadInput } from './db.js';

/**
 * Parsers for local coding-agent transcripts:
 *   - Claude Code: ~/.claude/projects/<project-slug>/<session-id>.jsonl
 *   - Codex CLI:   ~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<id>.jsonl
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

/** Strip harness wrapper tags Claude Code injects into user turns. */
function cleanClaudeCodeUserText(raw: string): string | null {
  let text = raw;
  const command = text.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (command) {
    const args = (text.match(/<command-args>([\s\S]*?)<\/command-args>/) ?? [])[1] ?? '';
    const name = command[1].trim();
    if (/^\/(clear|exit|cost|help|config|status|model|login|logout)\b/.test(name)) return null;
    return `${name}${args.trim() ? ` ${args.trim()}` : ''}`;
  }
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
  const title = (summaryTitle || firstUser.replace(/\s+/g, ' ').slice(0, 90) || 'Claude Code session').trim();
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

export function parseCodexSession(
  text: string,
  options: CliParseOptions
): UpsertThreadInput | null {
  const records = parseJsonLines(text);
  if (records.length === 0 || !looksLikeCodexSession(records)) return null;

  let sessionId = '';
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
      const p = (r.payload ?? {}) as Record<string, unknown>;
      sessionId = str(p.id) || sessionId;
      cwd = str(p.cwd) || cwd;
      const git = (p.git ?? {}) as Record<string, unknown>;
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

  if (!sessionId) {
    const m = (options.fileName ?? '').match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
    sessionId = m ? m[1] : (options.fileName ?? '').replace(/\.jsonl$/i, '') || `codex_${Date.now()}`;
  }
  if (!messages.some((m) => m.role === 'user' || m.role === 'assistant')) return null;

  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  const title = (firstUser.replace(/\s+/g, ' ').slice(0, 90) || 'Codex session').trim();
  const project = repoNameFromUrl(repoUrl) ?? basenameOfPath(cwd);

  return {
    threadKey: buildThreadKey({
      provider: 'codex',
      accountId: options.accountId,
      workspaceId: options.workspaceId,
      sourceConversationId: sessionId,
      branchId: 'main',
    }),
    provider: 'codex',
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
    coverage: 'full',
    captureSource: 'export_import',
    messages: dedupeIds(messages),
    providerProjectName: project,
    workspacePath: cwd,
    gitBranch,
    modelSlug: model,
    resumeCommand: cwd ? `cd ${shellQuote(cwd)} && codex resume ${sessionId}` : `codex resume ${sessionId}`,
  };
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
