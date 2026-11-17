// Claude fills a Table column, or drafts new columns. Claude reads each thread's analysis (title,
// gist, summary, topics), never the whole transcript, so a run over hundreds of threads costs
// cents rather than dollars. The privacy rule of core/privacy.ts holds here as everywhere: a
// local-only thread, or one in a local-only project, never leaves the browser, and neither does
// a value the person set on one.
import { containsPromptInjectionAttempt } from '../../shared/cloud.js';
import { ensureStarterCollectionsAndSettings, type ThreadkeeperDB } from './db.js';
import {
  MODEL_OPTIONS,
  fillColumnWithClaude,
  hasClaudeKey,
  suggestColumnsWithClaude,
  toClaudeCallError,
  type ColumnFillExample,
} from './ai/claude.js';
import { resolveInsight } from './insights.js';
import { remoteAllowedKeys } from './privacy.js';
import { providerLabel } from './providers.js';
import {
  THREAD_KIND_LABELS,
  getDisplayTitle,
  type AiModelId,
  type ConversationRecord,
  type TableColumnRecord,
  type ThreadInsight,
} from './schema.js';
import {
  BUILTIN_COLUMNS,
  TableColumnError,
  applyAiCells,
  cellValueText,
  coerceCellValue,
  isChoiceType,
  lastActiveAtOf,
  listTableColumns,
  normalizeColumnDraft,
  threadTypeLabel,
  type AiCellWrite,
  type TableColumnDraft,
} from './thread-table.js';

/** Threads per request. Small enough that one failed request loses little. */
export const FILL_BATCH_SIZE = 20;
const MAX_EXAMPLES = 12;
const SUMMARY_CLIP = 700;
const OPENING_CLIP = 500;

/** `empty`: only cells with no value. `refresh`: also replace Claude's earlier values. */
export type FillMode = 'empty' | 'refresh';

export interface FillPlan {
  column: TableColumnRecord;
  mode: FillMode;
  /** Threads Claude would read, in the order given. */
  threadKeys: string[];
  /** Left out because they are local-only (or in a local-only project, or from an excluded provider). */
  skippedLocalOnly: number;
  /** Left out because the person set their value by hand. */
  keptManual: number;
  /** Left out because Claude already filled them (mode `empty`). */
  alreadyFilled: number;
  requests: number;
  estimatedUsd: number;
}

export interface FillOutcome {
  written: number;
  /** Values Claude proposed for cells the person set while the run was going. */
  keptManual: number;
  threadsRead: number;
  /** Choices Claude added to the column. */
  newOptions: string[];
  stopped: boolean;
  error: string | null;
}

/** Rough cost of filling one column for `threads` threads (stated as an estimate in the UI). */
export function estimateFillCostUsd(model: AiModelId, threads: number): number {
  if (threads <= 0) return 0;
  const opt = MODEL_OPTIONS.find((m) => m.id === model) ?? MODEL_OPTIONS[0];
  const requests = Math.ceil(threads / FILL_BATCH_SIZE);
  const input = threads * 380 + requests * 700;
  const output = threads * 70 + requests * 400;
  return (input / 1e6) * opt.inputPerMTok + (output / 1e6) * opt.outputPerMTok;
}

/** Which of `threadKeys` a run would send, and why the others are left out. Reads nothing remote. */
export async function planColumnFill(
  db: ThreadkeeperDB,
  columnId: string,
  threadKeys: readonly string[],
  mode: FillMode
): Promise<FillPlan> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  const column = await db.tableColumns.get(columnId);
  if (!column) throw new TableColumnError('That column no longer exists.');
  const unique = Array.from(new Set(threadKeys));
  const allowed = await remoteAllowedKeys(db, settings, unique);
  const cells = new Map((await db.tableCells.where('columnId').equals(columnId).toArray()).map((c) => [c.threadKey, c]));
  const chosen: string[] = [];
  let skippedLocalOnly = 0;
  let keptManual = 0;
  let alreadyFilled = 0;
  for (const key of unique) {
    const cell = cells.get(key);
    if (cell?.source === 'manual') keptManual += 1;
    else if (cell && mode === 'empty') alreadyFilled += 1;
    else if (!allowed.has(key)) skippedLocalOnly += 1;
    else chosen.push(key);
  }
  return {
    column,
    mode,
    threadKeys: chosen,
    skippedLocalOnly,
    keptManual,
    alreadyFilled,
    requests: Math.ceil(chosen.length / FILL_BATCH_SIZE),
    estimatedUsd: estimateFillCostUsd(settings.aiModel, chosen.length),
  };
}

const clip = (text: string, max: number) => {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};

/** One thread as Claude reads it for a column: its facts and analysis, with the opening ask as a fallback. */
export function describeThreadForColumn(conv: ConversationRecord, insight: ThreadInsight | null, opening: string | null): string {
  const facts = [
    `${threadTypeLabel(conv)} · ${providerLabel(conv.provider)}`,
    `project: ${conv.project}`,
    `status: ${conv.workflowState}`,
    `last active: ${(lastActiveAtOf(conv) ?? 'unknown').slice(0, 10)}`,
    `${conv.messageCount} messages`,
    conv.repository ? `repository: ${conv.repository}` : '',
    conv.agentLabel ? `agent: ${conv.agentLabel}` : '',
  ].filter(Boolean);
  const lines = [`${getDisplayTitle(conv) || insight?.title || 'Untitled'}`, facts.join(' · ')];
  if (insight) {
    lines.push(`Work type: ${THREAD_KIND_LABELS[insight.kind]}${insight.topics.length ? ` · Topics: ${insight.topics.slice(0, 8).join(', ')}` : ''}`);
    if (insight.gist) lines.push(`About: ${clip(insight.gist, 240)}`);
    const summary = insight.overview?.length ? insight.overview.join(' ') : insight.summary;
    if (summary) lines.push(`Summary: ${clip(summary, SUMMARY_CLIP)}`);
    if (insight.outcome) lines.push(`Outcome: ${clip(insight.outcome, 200)}`);
    if (insight.lastUserAsk) lines.push(`Last ask: ${clip(insight.lastUserAsk, 200)}`);
  }
  if (opening && (!insight || !(insight.overview?.length || insight.summary))) lines.push(`Opening message: ${clip(opening, OPENING_CLIP)}`);
  return lines.join('\n');
}

async function loadThreadContext(db: ThreadkeeperDB, keys: readonly string[]) {
  const [convs, insightRows] = await Promise.all([
    db.conversations.bulkGet([...keys]),
    db.insights.where('threadKey').anyOf([...keys]).toArray(),
  ]);
  const local = new Map<string, ThreadInsight>();
  const ai = new Map<string, ThreadInsight>();
  for (const i of insightRows) (i.source === 'ai' ? ai : local).set(i.threadKey, i);
  const out: Array<{ conv: ConversationRecord; insight: ThreadInsight | null; opening: string | null }> = [];
  for (const conv of convs) {
    if (!conv) continue;
    const insight = resolveInsight(conv, local.get(conv.threadKey), ai.get(conv.threadKey));
    let opening: string | null = null;
    if (!insight || !(insight.overview?.length || insight.summary)) {
      const messages = await db.messages.where('threadKey').equals(conv.threadKey).sortBy('ordinal');
      opening = messages.find((m) => m.role === 'user')?.content ?? null;
    }
    out.push({ conv, insight, opening });
  }
  return out;
}

/** The person's own values in this column, from threads that may be sent, as examples. */
async function loadExamples(db: ThreadkeeperDB, column: TableColumnRecord, allowedOf: (keys: string[]) => Promise<Set<string>>): Promise<ColumnFillExample[]> {
  const manual = (await db.tableCells.where('columnId').equals(column.id).toArray())
    .filter((c) => c.source === 'manual')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (manual.length === 0) return [];
  const allowed = await allowedOf(manual.map((c) => c.threadKey));
  const picked = manual.filter((c) => allowed.has(c.threadKey)).slice(0, MAX_EXAMPLES);
  const context = await loadThreadContext(db, picked.map((c) => c.threadKey));
  const byKey = new Map(context.map((c) => [c.conv.threadKey, c]));
  return picked.flatMap((cell) => {
    const ctx = byKey.get(cell.threadKey);
    if (!ctx) return [];
    return [{ title: getDisplayTitle(ctx.conv), gist: ctx.insight?.gist ?? '', value: cellValueText(cell.value) || '(empty)' }];
  });
}

const unsafe = (text: string) => containsPromptInjectionAttempt(text);

/**
 * Fill a column for the threads of a plan, one batch at a time. Privacy is checked again for each
 * batch, so a thread made local-only during the run is not sent. Values are written after each
 * batch; a stop or an error keeps what was written. Never throws for a failed request: the outcome
 * carries the message.
 */
export async function runColumnFill(
  db: ThreadkeeperDB,
  plan: Pick<FillPlan, 'column' | 'threadKeys' | 'mode'>,
  options: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void; fetchImpl?: typeof fetch } = {}
): Promise<FillOutcome> {
  const outcome: FillOutcome = { written: 0, keptManual: 0, threadsRead: 0, newOptions: [], stopped: false, error: null };
  const settings = await ensureStarterCollectionsAndSettings(db);
  if (!hasClaudeKey(settings)) {
    outcome.error = 'Add a Claude key in Settings → AI models to fill columns with Claude.';
    return outcome;
  }
  const start = await db.tableColumns.get(plan.column.id);
  if (!start) {
    outcome.error = 'That column no longer exists.';
    return outcome;
  }
  // A choice column with no choices yet is one Claude defines as it goes.
  const openChoices = isChoiceType(start.type) && start.options.length === 0;
  const allowedOf = (keys: string[]) => remoteAllowedKeys(db, settings, keys);
  const examples = await loadExamples(db, start, allowedOf);
  const total = plan.threadKeys.length;
  options.onProgress?.(0, total);

  for (let at = 0; at < total; at += FILL_BATCH_SIZE) {
    if (options.signal?.aborted) {
      outcome.stopped = true;
      break;
    }
    const column = await db.tableColumns.get(start.id);
    if (!column) {
      outcome.error = 'The column was deleted while Claude was filling it.';
      break;
    }
    const batchKeys = plan.threadKeys.slice(at, at + FILL_BATCH_SIZE);
    const allowed = await allowedOf(batchKeys);
    const context = await loadThreadContext(db, batchKeys.filter((k) => allowed.has(k)));
    // A cell the person set since the plan was made is theirs; do not ask about it.
    const manual = new Set(
      (await db.tableCells.where('columnId').equals(column.id).toArray()).filter((c) => c.source === 'manual').map((c) => c.threadKey)
    );
    const batch = context.filter((c) => !manual.has(c.conv.threadKey));
    if (batch.length === 0) {
      options.onProgress?.(Math.min(at + FILL_BATCH_SIZE, total), total);
      continue;
    }
    let response: Awaited<ReturnType<typeof fillColumnWithClaude>>;
    try {
      response = await fillColumnWithClaude(
        settings,
        {
          name: column.name,
          type: column.type,
          options: column.options,
          openChoices,
          instructions: column.instructions,
        },
        batch.map((c) => describeThreadForColumn(c.conv, c.insight, c.opening)),
        examples,
        { fetchImpl: options.fetchImpl, signal: options.signal }
      );
    } catch (err) {
      if (options.signal?.aborted) {
        outcome.stopped = true;
        break;
      }
      outcome.error = toClaudeCallError(err, settings).message;
      break;
    }
    outcome.threadsRead += batch.length;

    const writes: AiCellWrite[] = [];
    const batchNew: string[] = [];
    const working = { type: column.type, options: [...column.options] };
    for (const item of response.result.values) {
      const target = batch[Math.round(item.thread) - 1];
      if (!target) continue;
      const reason = typeof item.reason === 'string' ? item.reason : '';
      if (unsafe(reason)) continue;
      const checked = coerceCellValue(working, item.value, { allowNewOptions: openChoices });
      if (!checked.ok || checked.value === null) continue;
      if (typeof checked.value === 'string' && unsafe(checked.value)) continue;
      if (Array.isArray(checked.value) && checked.value.some(unsafe)) continue;
      for (const option of checked.newOptions) {
        working.options.push(option);
        batchNew.push(option);
      }
      writes.push({ threadKey: target.conv.threadKey, value: checked.value, reason });
    }
    try {
      const applied = await applyAiCells(db, column.id, writes, { model: response.model, newOptions: batchNew });
      outcome.written += applied.written;
      outcome.keptManual += applied.keptManual;
      outcome.newOptions.push(...batchNew);
    } catch (err) {
      outcome.error = err instanceof Error ? err.message : String(err);
      break;
    }
    options.onProgress?.(Math.min(at + FILL_BATCH_SIZE, total), total);
  }
  return outcome;
}

/** A column Claude proposes, made valid; the person adds it or not. */
export interface ColumnProposal extends Required<TableColumnDraft> {
  why: string;
}

const SUGGEST_SAMPLE = 60;

/**
 * Ask Claude for columns. With `request` ("which ones shipped code") it designs that column;
 * without, it proposes a few that fit the library. It reads the most recent threads that may be
 * sent (titles, gists, topics). Proposals that clash with existing columns are dropped.
 */
export async function suggestTableColumns(
  db: ThreadkeeperDB,
  { request = '', threadKeys, fetchImpl }: { request?: string; threadKeys?: readonly string[]; fetchImpl?: typeof fetch } = {}
): Promise<{ proposals: ColumnProposal[]; threadsRead: number }> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  if (!hasClaudeKey(settings)) throw new TableColumnError('Add a Claude key in Settings → AI models to have Claude suggest columns.');
  const pool = threadKeys ? (await db.conversations.bulkGet([...threadKeys])).filter((c): c is ConversationRecord => Boolean(c)) : await db.conversations.toArray();
  const allowed = await remoteAllowedKeys(db, settings, pool.map((c) => c.threadKey));
  const sample = pool
    .filter((c) => allowed.has(c.threadKey))
    .sort((a, b) => (lastActiveAtOf(b) ?? '').localeCompare(lastActiveAtOf(a) ?? ''))
    .slice(0, SUGGEST_SAMPLE);
  if (sample.length === 0) throw new TableColumnError('No threads can be sent to Claude (they are all local-only).');
  const context = await loadThreadContext(db, sample.map((c) => c.threadKey));
  const rows = context.map(({ conv, insight }) =>
    clip(
      `${getDisplayTitle(conv)} | ${threadTypeLabel(conv)} · ${providerLabel(conv.provider)} | ${insight?.gist ?? ''} | topics: ${insight?.topics.slice(0, 5).join(', ') ?? ''}`,
      400
    )
  );
  const existing = await listTableColumns(db);
  const taken = existing.map((c) => c.name);
  const { suggestions } = await suggestColumnsWithClaude(
    settings,
    { request, existing: [...Object.values(BUILTIN_COLUMNS).map((c) => c.label), ...taken], threads: rows },
    fetchImpl
  );
  const proposals: ColumnProposal[] = [];
  for (const s of suggestions.columns) {
    if ([s.name, s.instructions, s.why, ...s.options].some(unsafe)) continue;
    try {
      const valid = normalizeColumnDraft(s, [...taken, ...proposals.map((p) => p.name)]);
      proposals.push({ ...valid, why: clip(s.why, 200) });
    } catch {
      // A clash with an existing column, or no usable name: leave it out.
    }
    if (proposals.length >= 6) break;
  }
  return { proposals, threadsRead: sample.length };
}
