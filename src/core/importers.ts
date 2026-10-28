import { unzipSync, strFromU8 } from 'fflate';
import type { SettingsRecord } from './schema.js';
import { upsertThread, type ThreadkeeperDB, type UpsertThreadInput } from './db.js';
import {
  importPortableBundle,
  parseChatGPTExport,
  parseClaudeExport,
  type ChatGPTExportConversation,
  type ClaudeExportConversation,
  type PortableBundle,
} from './adapters.js';
import {
  looksLikeClaudeCodeSession,
  looksLikeCodexSession,
  parseClaudeCodeSession,
  parseCodexSession,
  parseJsonLines,
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

/** Guess the format of one JSON / JSONL document. */
export function detectImportKind(name: string, text: string): ImportKind {
  const trimmed = text.trimStart();
  if (name.toLowerCase().endsWith('.jsonl') || (!trimmed.startsWith('[') && trimmed.includes('\n{'))) {
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

function decodeFiles(files: ImportFileInput[]): Array<{ name: string; text: string }> {
  const out: Array<{ name: string; text: string }> = [];
  for (const f of files) {
    if (f.name.toLowerCase().endsWith('.zip') && f.bytes) {
      const entries = unzipSync(f.bytes, {
        filter: (file) => /(^|\/)conversations\.json$|\.jsonl$/i.test(file.name),
      });
      for (const [entryName, data] of Object.entries(entries)) {
        out.push({ name: entryName, text: strFromU8(data) });
      }
    } else if (f.text !== undefined) {
      out.push({ name: f.name, text: f.text });
    } else if (f.bytes) {
      out.push({ name: f.name, text: strFromU8(f.bytes) });
    }
  }
  return out;
}

/**
 * Import any mix of supported files, then run the on-device organizer over
 * everything imported and queue Claude analysis for it.
 */
export async function importFiles(
  db: ThreadkeeperDB,
  settings: SettingsRecord,
  files: ImportFileInput[],
  onProgress?: (message: string) => void
): Promise<ImportReport> {
  const report: ImportReport = { byKind: {}, imported: 0, skippedDeleted: 0, unrecognized: [], errors: [], threadKeys: [] };
  const docs = decodeFiles(files);
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

  for (const doc of docs) {
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
        const item = parseCodexSession(doc.text, { ...settings.boundAccounts.codex, fileName: doc.name.split('/').pop() });
        if (item) await upsertAll(kind, [item]);
      } else {
        report.unrecognized.push(doc.name);
      }
    } catch (err) {
      report.errors.push(`${doc.name}: ${err instanceof Error ? err.message : String(err)}`);
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

/** Minimal shape of the File System Access API we rely on (extension pages only). */
export interface DirectoryHandleLike {
  name: string;
  kind: 'directory';
  values(): AsyncIterable<{ kind: 'file' | 'directory'; name: string } & Record<string, unknown>>;
  queryPermission?(opts: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
  requestPermission?(opts: { mode: 'read' }): Promise<'granted' | 'denied' | 'prompt'>;
}

/**
 * Read every .jsonl under a picked folder (e.g. ~/.claude/projects or
 * ~/.codex/sessions), skipping files unchanged since `since`.
 */
export async function readJsonlTree(
  dir: DirectoryHandleLike,
  options: { since?: number; maxFiles?: number; prefix?: string } = {}
): Promise<ImportFileInput[]> {
  const out: ImportFileInput[] = [];
  const maxFiles = options.maxFiles ?? 5000;
  const walk = async (handle: DirectoryHandleLike, prefix: string, depth: number) => {
    if (depth > 6) return;
    for await (const entry of handle.values()) {
      if (out.length >= maxFiles) return;
      if (entry.kind === 'directory') {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(entry as unknown as DirectoryHandleLike, `${prefix}${entry.name}/`, depth + 1);
      } else if (entry.name.endsWith('.jsonl')) {
        const file = await (entry as unknown as { getFile(): Promise<File> }).getFile();
        if (options.since && file.lastModified <= options.since) continue;
        out.push({ name: `${prefix}${entry.name}`, text: await file.text() });
      }
    }
  };
  await walk(dir, options.prefix ?? '', 0);
  return out;
}
