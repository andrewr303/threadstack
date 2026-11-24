import { unzipSync, strFromU8 } from 'fflate';
import { decompress as zstdDecompress } from 'fzstd';
import { buildThreadKey, type MessageRecord, type SettingsRecord } from './schema.js';
import { upsertThread, type ThreadStackDB, type UpsertThreadInput } from './db.js';
import {
  importPortableBundle,
  parseChatGPTExport,
  parseClaudeExport,
  type ChatGPTExportConversation,
  type ClaudeExportConversation,
  type PortableBundle,
} from './adapters.js';
import {
  isClaudeCodeSideDirectory,
  isClaudeCodeSideFile,
  looksLikeClaudeCodeSession,
  looksLikeCodexSession,
  parseClaudeCodeSession,
  parseCodexRollout,
  parseJsonLines,
  resolveCodexRollouts,
  type CodexRollout,
} from './cli-sessions.js';
import { processThreadsLocally } from './pipeline.js';

export type ImportKind = 'chatgpt' | 'claude' | 'portable' | 'claude_code' | 'codex' | 'unknown';

export interface ImportFileInput {
  name: string;
  text?: string;
  bytes?: Uint8Array;
}

export interface ImportReport {
  byKind: Partial<Record<ImportKind, number>>;
  imported: number;
  skippedDeleted: number;
  unrecognized: string[];
  errors: string[];
  threadKeys: string[];
}

/** Codex compresses rollouts older than a week to .jsonl.zst. */
const JSONL_NAME = /\.jsonl(\.zst)?$/i;

/** Guess the format of one JSON / JSONL document. */
export function detectImportKind(name: string, text: string): ImportKind {
  const trimmed = text.trimStart();
  if (JSONL_NAME.test(name) || (!trimmed.startsWith('[') && trimmed.includes('\n{'))) {
    const records = parseJsonLines(text.slice(0, 400_000));
    if (looksLikeClaudeCodeSession(records)) return 'claude_code';
    if (looksLikeCodexSession(records)) return 'codex';
  }
  try {
    const data = JSON.parse(text);
    if (data && !Array.isArray(data) && data.format === 'threadkeeper-portable-v1') return 'portable';
    const arr = Array.isArray(data) ? data : [data];
    const sample = arr.find((x) => x && typeof x === 'object') as Record<string, unknown> | undefined;
    if (!sample) return 'unknown';
    if ('mapping' in sample || 'current_node' in sample) return 'chatgpt';
    if ('chat_messages' in sample) return 'claude';
  } catch {
    // not a single JSON document
  }
  return 'unknown';
}

function decodeFiles(files: ImportFileInput[], errors: string[]): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  const addBytes = (name: string, bytes: Uint8Array) => {
    try {
      out.push({ name, text: strFromU8(/\.zst$/i.test(name) ? zstdDecompress(bytes) : bytes) });
    } catch (err) {
      // a truncated or still-being-written .zst must not abort the rest of the import
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.zip') && f.bytes) {
      const entries = unzipSync(f.bytes, {
        filter: (file) => /(^|\/)conversations\.json$|\.jsonl(\.zst)?$/i.test(file.name),
      });
      for (const [entryName, data] of Object.entries(entries)) addBytes(entryName, data);
    } else if (f.text !== undefined) {
      out.push({ name: f.name, text: f.text });
    } else if (f.bytes) {
      addBytes(f.name, f.bytes);
    }
  }
  return out;
}

/**
 * Rollouts of one Codex thread can reach a later sync out of order (the
 * pre-revert file is re-read once Codex compresses it), so older content never
 * replaces a newer stored thread; fork links stored by earlier imports are kept.
 */
async function mergeStoredCodexThread(db: ThreadStackDB, thread: UpsertThreadInput): Promise<UpsertThreadInput | null> {
  const existing = await db.conversations.get(thread.threadKey);
  if (!existing) return thread;
  if (Date.parse(thread.updatedAt ?? '') < Date.parse(existing.updatedAt ?? '')) return null;
  if (!thread.siblingBranchIds) return thread;
  return { ...thread, siblingBranchIds: Array.from(new Set([...existing.siblingBranchIds, ...thread.siblingBranchIds])) };
}

/**
 * Import any mix of supported files, then run the on-device organizer over
 * everything imported and queue Claude analysis for it.
 */
export async function importFiles(
  db: ThreadStackDB,
  settings: SettingsRecord,
  files: ImportFileInput[],
  onProgress?: (message: string) => void
): Promise<ImportReport> {
  const report: ImportReport = { byKind: {}, imported: 0, skippedDeleted: 0, unrecognized: [], errors: [], threadKeys: [] };
  const docs = decodeFiles(files, report.errors);
  const bump = (kind: ImportKind, n = 1) => {
    report.byKind[kind] = (report.byKind[kind] ?? 0) + n;
  };

  const upsertAll = async (kind: ImportKind, items: UpsertThreadInput[]) => {
    for (let i = 0; i < items.length; i++) {
      const res = await upsertThread(db, items[i]);
      if (res.status === 'skipped_tombstone') report.skippedDeleted++;
      else {
        report.imported++;
        report.threadKeys.push(items[i].threadKey);
        bump(kind);
      }
      if (i % 25 === 24) onProgress?.(`Imported ${report.imported} threads…`);
    }
  };

  // Codex rollouts are folded together (reverts, forks, sub-agents) once all are parsed.
  const codexRollouts: CodexRollout[] = [];

  for (const doc of docs) {
    // Subagent transcripts and other Claude Code side files reuse the parent's sessionId.
    if (/\.jsonl/i.test(doc.name) && isClaudeCodeSideFile(doc.name)) continue;
    const kind = detectImportKind(doc.name, doc.text);
    try {
      if (kind === 'chatgpt') {
        const data = JSON.parse(doc.text);
        const items = parseChatGPTExport(
          (Array.isArray(data) ? data : [data]) as ChatGPTExportConversation[],
          settings.boundAccounts.chatgpt
        );
        await upsertAll(kind, items);
      } else if (kind === 'claude') {
        const data = JSON.parse(doc.text);
        const items = parseClaudeExport(
          (Array.isArray(data) ? data : [data]) as ClaudeExportConversation[],
          settings.boundAccounts.claude
        );
        await upsertAll(kind, items);
      } else if (kind === 'portable') {
        const res = await importPortableBundle(db, JSON.parse(doc.text) as PortableBundle);
        report.imported += res.importedCount;
        report.skippedDeleted += res.skippedTombstones;
        bump(kind, res.importedCount);
      } else if (kind === 'claude_code') {
        const item = parseClaudeCodeSession(doc.text, { ...settings.boundAccounts.claude_code, fileName: doc.name.split('/').pop() });
        if (item) await upsertAll(kind, [item]);
      } else if (kind === 'codex') {
        const rollout = parseCodexRollout(doc.text, { ...settings.boundAccounts.codex, fileName: doc.name.split('/').pop() });
        if (rollout) codexRollouts.push(rollout);
      } else {
        report.unrecognized.push(doc.name);
      }
    } catch (err) {
      report.errors.push(`${doc.name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (codexRollouts.length > 0) {
    try {
      const threads = await resolveCodexRollouts(codexRollouts, (threadKey) => storedCodexHistory(db, threadKey));
      const items: UpsertThreadInput[] = [];
      for (const thread of threads) {
        const item = await mergeStoredCodexThread(db, thread);
        if (item) items.push(item);
      }
      await upsertAll('codex', items);
    } catch (err) {
      report.errors.push(`Codex sessions: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  if (report.threadKeys.length > 0) {
    onProgress?.(`Organizing ${report.threadKeys.length} imported threads…`);
    await processThreadsLocally(db, report.threadKeys, {
      onProgress: (done, total) => onProgress?.(`Organizing ${done}/${total}…`),
      aiDelaySeconds: 0,
    });
  }
  return report;
}

/**
 * A stored Codex thread's full history. A stored fork keeps only its own turns
 * after a "Forked from…" marker, so its parent's history is prepended (one
 * level at a time) for a later fork of that fork to recognise what it replays.
 */
async function storedCodexHistory(db: ThreadStackDB, threadKey: string, depth = 0): Promise<MessageRecord[]> {
  const messages = await db.messages.where('threadKey').equals(threadKey).sortBy('ordinal');
  if (depth >= 8 || !messages[0]?.sourceMessageId.endsWith('_forked')) return messages;
  const conv = await db.conversations.get(threadKey);
  if (!conv?.parentBranchId) return messages;
  const parentKey = buildThreadKey({
    provider: conv.provider,
    accountId: conv.accountId,
    workspaceId: conv.workspaceId,
    sourceConversationId: conv.sourceConversationId,
    branchId: conv.parentBranchId,
  });
  return [...(await storedCodexHistory(db, parentKey, depth + 1)), ...messages.slice(1)];
}

/** Minimal shape of the File System Access API we rely on (extension pages only). */
export interface DirectoryHandleLike {
  name: string;
  kind: 'directory';
  values(): AsyncIterable<{ kind: 'file' | 'directory'; name: string } & Record<string, unknown>>;
  queryPermission?(opts: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(opts: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
}

/** In a picked config folder (~/.codex, ~/.claude) only these subfolders hold transcripts. */
const SESSION_ROOTS = new Set(['sessions', 'archived_sessions', 'projects']);

/**
 * Read every session transcript (.jsonl, or Codex's .jsonl.zst) under a picked
 * folder (e.g. ~/.claude/projects, ~/.codex/sessions or ~/.codex), skipping
 * Claude Code side files and files unchanged since `since`.
 */
export async function readJsonlTree(
  dir: DirectoryHandleLike,
  options: { since?: number; maxFiles?: number; prefix?: string } = {}
): Promise<ImportFileInput[]> {
  const out: ImportFileInput[] = [];
  const maxFiles = options.maxFiles ?? 5000;
  const walk = async (handle: DirectoryHandleLike, prefix: string, depth: number) => {
    if (depth > 6) return;
    const entries: Array<{ kind: 'file' | 'directory'; name: string }> = [];
    for await (const entry of handle.values()) entries.push(entry);
    const names = new Set(entries.map((e) => e.name));
    const roots = depth === 0 ? entries.filter((e) => e.kind === 'directory' && SESSION_ROOTS.has(e.name)) : [];
    for (const entry of roots.length > 0 ? roots : entries) {
      if (out.length >= maxFiles) return;
      // hidden folders, and the temp files Codex writes while compressing a rollout
      if (entry.name.startsWith('.')) continue;
      const path = `${prefix}${entry.name}`;
      if (entry.kind === 'directory') {
        if (entry.name === 'node_modules' || isClaudeCodeSideDirectory(entry.name)) continue;
        await walk(entry as unknown as DirectoryHandleLike, `${path}/`, depth + 1);
        continue;
      }
      if (!JSONL_NAME.test(entry.name) || isClaudeCodeSideFile(path)) continue;
      const compressed = /\.zst$/i.test(entry.name);
      // Codex reads a plain rollout in preference to its compressed sibling.
      if (compressed && names.has(entry.name.slice(0, -'.zst'.length))) continue;
      const file = await (entry as unknown as { getFile(): Promise<File> }).getFile();
      if (options.since && file.lastModified <= options.since) continue;
      out.push(
        compressed
          ? { name: path, bytes: new Uint8Array(await file.arrayBuffer()) }
          : { name: path, text: await file.text() }
      );
    }
  };
  await walk(dir, options.prefix ?? '', 0);
  return out;
}
