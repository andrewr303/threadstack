import type { ThreadStackDB } from './db.js';
import { UNFILED_PROJECT } from './db.js';
import { getDisplayTitle, type ConversationRecord, type SettingsRecord, type ThreadInsight } from './schema.js';
import { remoteAllowedKeys } from './privacy.js';
import { providerLabel } from './providers.js';
import { accountLabelForThread } from './pipeline.js';
import { catchUpBriefWithClaude, hasClaudeKey, toClaudeCallError, type CatchUpRow } from './ai/claude.js';

/**
 * A brief of where things stand across the conversations imported or updated in the last N days.
 * The on-device brief needs no key and uses only text the analyzers already derived (gist,
 * summary, decisions, next steps, open questions, status). With Claude configured it is rewritten
 * from the same notes. Message text is never sent, and local-only threads never leave the device.
 */

export interface CatchUpThread {
  threadKey: string;
  title: string;
  provider: string;
  project: string;
  updatedAt: string | null;
  gist: string;
  summary: string;
  decisions: string[];
  nextSteps: string[];
  openQuestions: string[];
  status: string;
  remoteAllowed: boolean;
  /** Run facts for coding-agent sessions; labels and states only, never message text. */
  accountLabel?: string | null;
  repository?: string | null;
  branch?: string | null;
  pullRequestUrl?: string | null;
  runState?: string | null;
  testsStatus?: string | null;
  blockedOn?: string | null;
}

export interface CatchUpBrief {
  generatedAt: string;
  sinceIso: string;
  days: number;
  source: 'local' | 'claude';
  model: string | null;
  headline: string;
  workstreams: Array<{ name: string; where: string; threadKeys: string[]; openLoops: string[]; nextSteps: string[] }>;
  looseEnds: Array<{ text: string; threadKey: string }>;
  threadCount: number;
  withheld: number;
  note: string | null;
}

const DEFAULT_LIMIT = 80;
const MAX_ITEMS_PER_WORKSTREAM = 5;

function activityMs(conv: ConversationRecord): number {
  const raw = conv.updatedAt ?? conv.createdAt ?? conv.lastCapturedAt;
  const ms = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

function texts(items: Array<{ text: string }> | undefined): string[] {
  return (items ?? []).map((i) => i.text.trim()).filter(Boolean);
}

function dedupe(items: string[], cap = Infinity): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const key = item.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= cap) break;
  }
  return out;
}

/** Recent threads, newest first, with the notes the analyzers derived for each. */
export async function collectCatchUpThreads(
  db: ThreadStackDB,
  settings: SettingsRecord,
  opts: { sinceMs: number; limit?: number }
): Promise<CatchUpThread[]> {
  const all = await db.conversations.toArray();
  const recent = all
    .filter((c) => !c.isSyntheticBenchmark && activityMs(c) >= opts.sinceMs)
    .sort((a, b) => activityMs(b) - activityMs(a));

  const live: ConversationRecord[] = [];
  for (const conv of recent) {
    if (live.length >= (opts.limit ?? DEFAULT_LIMIT)) break;
    if (await db.tombstones.get(conv.threadKey)) continue;
    live.push(conv);
  }
  if (live.length === 0) return [];

  const keys = live.map((c) => c.threadKey);
  const [summaries, insightRows, allowed] = await Promise.all([
    db.summaries.bulkGet(keys),
    db.insights.where('threadKey').anyOf(keys).toArray(),
    remoteAllowedKeys(db, settings, keys),
  ]);
  // Claude's analysis outranks the on-device one when both exist.
  const insightByThread = new Map<string, ThreadInsight>();
  for (const insight of insightRows) {
    const prev = insightByThread.get(insight.threadKey);
    if (!prev || (prev.source === 'local' && insight.source === 'ai')) insightByThread.set(insight.threadKey, insight);
  }

  // The AI's reading of a run wins; the on-device one fills in.
  const agentRunByThread = new Map<string, NonNullable<ThreadInsight['agentRun']>>();
  for (const insight of insightRows) {
    if (!insight.agentRun) continue;
    if (insight.source === 'ai' || !agentRunByThread.has(insight.threadKey)) agentRunByThread.set(insight.threadKey, insight.agentRun);
  }
  const accountLabels = await Promise.all(live.map((conv) => accountLabelForThread(db, conv, settings)));

  return live.map((conv, i) => {
    const insight = insightByThread.get(conv.threadKey);
    const summary = summaries[i];
    const run = agentRunByThread.get(conv.threadKey);
    const pullRequestUrl = conv.pullRequestUrl ?? run?.pullRequests[0]?.url ?? null;
    return {
      threadKey: conv.threadKey,
      title: getDisplayTitle(conv),
      provider: providerLabel(conv.provider),
      project: conv.project,
      updatedAt: conv.updatedAt ?? conv.createdAt ?? conv.lastCapturedAt ?? null,
      gist: insight?.gist ?? '',
      summary: insight?.summary ?? summary?.currentStatus ?? '',
      decisions: dedupe([...texts(summary?.decisions), ...(conv.latestDecisionText ? [conv.latestDecisionText] : [])]),
      nextSteps: dedupe([...texts(summary?.actionItems), ...(conv.nextStepText ? [conv.nextStepText] : [])]),
      openQuestions: dedupe(texts(summary?.openQuestions)),
      status: conv.workflowState,
      remoteAllowed: allowed.has(conv.threadKey),
      accountLabel: accountLabels[i],
      repository: conv.repository ?? run?.repository ?? null,
      branch: conv.gitBranch ?? run?.branch ?? null,
      pullRequestUrl,
      runState: run && run.runState !== 'unknown' ? run.runState : conv.agentState && conv.agentState !== 'unknown' ? conv.agentState : null,
      testsStatus: run ? run.tests.status : null,
      blockedOn: run && run.blockedOn !== 'none' ? run.blockedOn : conv.agentState === 'waiting_permission' ? 'permission' : conv.agentState === 'waiting_answer' ? 'input' : (run?.blockedOn ?? null),
    };
  });
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** The brief built only from what is already stored. Deterministic. */
export function buildLocalBrief(
  threads: CatchUpThread[],
  opts: { sinceMs: number; days: number; now?: number }
): CatchUpBrief {
  const byProject = new Map<string, CatchUpThread[]>();
  for (const t of threads) {
    const list = byProject.get(t.project) ?? [];
    list.push(t);
    byProject.set(t.project, list);
  }
  const newest = (list: CatchUpThread[]) => Math.max(...list.map((t) => (t.updatedAt ? Date.parse(t.updatedAt) || 0 : 0)));

  const workstreams = Array.from(byProject, ([name, list]) => {
    const sorted = [...list].sort((a, b) => (Date.parse(b.updatedAt ?? '') || 0) - (Date.parse(a.updatedAt ?? '') || 0));
    const lead = sorted[0];
    const waiting = sorted
      .filter((t) => t.status === 'needs_review' || t.status === 'waiting')
      .map((t) => `${t.title}: ${t.status === 'waiting' ? 'waiting' : 'needs review'}`);
    return {
      name,
      where: lead.gist || lead.summary || lead.title,
      threadKeys: sorted.map((t) => t.threadKey),
      openLoops: dedupe([...sorted.flatMap((t) => t.openQuestions), ...waiting], MAX_ITEMS_PER_WORKSTREAM),
      nextSteps: dedupe(sorted.flatMap((t) => t.nextSteps), MAX_ITEMS_PER_WORKSTREAM),
      newest: newest(sorted),
    };
  })
    .sort((a, b) => b.newest - a.newest)
    .map(({ newest: _newest, ...rest }) => rest);

  const looseEnds = threads.flatMap((t) => {
    const unfiled = t.project === UNFILED_PROJECT;
    const unsummarized = !t.gist.trim();
    if (!unfiled && !unsummarized) return [];
    const why = unfiled && unsummarized ? 'is not filed in a project and has no summary yet' : unfiled ? 'is not filed in a project yet' : 'has no summary yet';
    return [{ text: `${t.title} ${why}`, threadKey: t.threadKey }];
  });

  const now = opts.now ?? Date.now();
  return {
    generatedAt: new Date(now).toISOString(),
    sinceIso: new Date(opts.sinceMs).toISOString(),
    days: opts.days,
    source: 'local',
    model: null,
    headline:
      threads.length === 0
        ? `No conversations in the last ${plural(opts.days, 'day', 'days')}.`
        : `${plural(threads.length, 'conversation', 'conversations')} across ${plural(workstreams.length, 'project', 'projects')} in the last ${plural(opts.days, 'day', 'days')}.`,
    workstreams,
    looseEnds,
    threadCount: threads.length,
    withheld: threads.filter((t) => !t.remoteAllowed).length,
    note: null,
  };
}

function toRow(t: CatchUpThread): CatchUpRow {
  return {
    title: t.title,
    provider: t.provider,
    project: t.project,
    updatedAt: t.updatedAt,
    gist: t.gist,
    summary: t.summary.slice(0, 600),
    decisions: t.decisions.slice(0, 4),
    nextSteps: t.nextSteps.slice(0, 4),
    openQuestions: t.openQuestions.slice(0, 4),
    status: t.status,
    accountLabel: t.accountLabel ?? null,
    repository: t.repository ?? null,
    branch: t.branch ?? null,
    pullRequestUrl: t.pullRequestUrl ?? null,
    runState: t.runState ?? null,
    testsStatus: t.testsStatus ?? null,
    blockedOn: t.blockedOn ?? null,
  };
}

/** Merge workstreams that share a name, keeping each thread once. */
function mergeWorkstreams(a: CatchUpBrief['workstreams'], b: CatchUpBrief['workstreams']): CatchUpBrief['workstreams'] {
  const out = a.map((w) => ({ ...w }));
  for (const extra of b) {
    const hit = out.find((w) => w.name.toLowerCase() === extra.name.toLowerCase());
    if (!hit) {
      out.push({ ...extra });
      continue;
    }
    hit.threadKeys = Array.from(new Set([...hit.threadKeys, ...extra.threadKeys]));
    hit.openLoops = dedupe([...hit.openLoops, ...extra.openLoops], MAX_ITEMS_PER_WORKSTREAM);
    hit.nextSteps = dedupe([...hit.nextSteps, ...extra.nextSteps], MAX_ITEMS_PER_WORKSTREAM);
  }
  return out;
}

export async function generateCatchUpBrief(
  db: ThreadStackDB,
  settings: SettingsRecord,
  opts: { days: number; now?: number; fetchImpl?: typeof fetch }
): Promise<CatchUpBrief> {
  const now = opts.now ?? Date.now();
  const sinceMs = now - opts.days * 86_400_000;
  const threads = await collectCatchUpThreads(db, settings, { sinceMs });
  const local = buildLocalBrief(threads, { sinceMs, days: opts.days, now });
  if (!hasClaudeKey(settings) || threads.length === 0) return local;

  const sendable = threads.filter((t) => t.remoteAllowed);
  const withheld = threads.length - sendable.length;
  const withheldNote =
    withheld > 0 ? `${plural(withheld, 'local-only conversation was', 'local-only conversations were')} summarized on this device and not sent to Claude.` : null;
  if (sendable.length === 0) return { ...local, note: withheldNote };

  try {
    const { brief, model } = await catchUpBriefWithClaude(settings, sendable.map(toRow), { days: opts.days }, opts.fetchImpl);
    const keyOf = (n: number): string | null => (Number.isInteger(n) && n >= 1 && n <= sendable.length ? sendable[n - 1].threadKey : null);

    const placed = new Set<string>();
    const workstreams: CatchUpBrief['workstreams'] = [];
    for (const w of brief.workstreams) {
      const threadKeys = Array.from(new Set(w.threads.map(keyOf).filter((k): k is string => k !== null)));
      if (threadKeys.length === 0) continue; // a workstream with no real thread behind it
      threadKeys.forEach((k) => placed.add(k));
      workstreams.push({
        name: w.name.trim() || 'Other',
        where: w.where.trim(),
        threadKeys,
        openLoops: dedupe(w.openLoops, MAX_ITEMS_PER_WORKSTREAM),
        nextSteps: dedupe(w.nextSteps, MAX_ITEMS_PER_WORKSTREAM),
      });
    }

    // Threads Claude did not place, and local-only threads, keep their on-device grouping.
    const leftovers = threads.filter((t) => !placed.has(t.threadKey));
    const leftoverBrief = buildLocalBrief(leftovers, { sinceMs, days: opts.days, now });
    const looseEnds = brief.looseEnds.flatMap((l) => {
      const threadKey = keyOf(l.thread);
      return threadKey && l.text.trim() ? [{ text: l.text.trim(), threadKey }] : [];
    });

    return {
      generatedAt: local.generatedAt,
      sinceIso: local.sinceIso,
      days: opts.days,
      source: 'claude',
      model,
      headline: brief.headline.trim() || local.headline,
      workstreams: mergeWorkstreams(workstreams, leftoverBrief.workstreams),
      looseEnds: [...looseEnds, ...leftoverBrief.looseEnds.filter((e) => !looseEnds.some((l) => l.threadKey === e.threadKey))],
      threadCount: threads.length,
      withheld,
      note: withheldNote,
    };
  } catch (err) {
    const message = toClaudeCallError(err, settings).message;
    return { ...local, note: `Claude could not write the brief, so this one was built on this device. ${message}` };
  }
}

// ---------------------------------------------------------------------------
// Persistence of the last brief
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'tk_last_catch_up';

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string');
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Validate a stored brief; anything off shape is rejected rather than rendered. */
export function parseStoredBrief(value: unknown): CatchUpBrief | null {
  if (!isRecord(value)) return null;
  const v = value;
  if (
    typeof v.generatedAt !== 'string' ||
    typeof v.sinceIso !== 'string' ||
    typeof v.days !== 'number' ||
    (v.source !== 'local' && v.source !== 'claude') ||
    (v.model !== null && typeof v.model !== 'string') ||
    typeof v.headline !== 'string' ||
    typeof v.threadCount !== 'number' ||
    typeof v.withheld !== 'number' ||
    (v.note !== null && typeof v.note !== 'string') ||
    !Array.isArray(v.workstreams) ||
    !Array.isArray(v.looseEnds)
  ) {
    return null;
  }
  const workstreams: CatchUpBrief['workstreams'] = [];
  for (const w of v.workstreams) {
    if (!isRecord(w) || typeof w.name !== 'string' || typeof w.where !== 'string' || !isStringArray(w.threadKeys) || !isStringArray(w.openLoops) || !isStringArray(w.nextSteps)) {
      return null;
    }
    workstreams.push({ name: w.name, where: w.where, threadKeys: w.threadKeys, openLoops: w.openLoops, nextSteps: w.nextSteps });
  }
  const looseEnds: CatchUpBrief['looseEnds'] = [];
  for (const l of v.looseEnds) {
    if (!isRecord(l) || typeof l.text !== 'string' || typeof l.threadKey !== 'string') return null;
    looseEnds.push({ text: l.text, threadKey: l.threadKey });
  }
  return {
    generatedAt: v.generatedAt,
    sinceIso: v.sinceIso,
    days: v.days,
    source: v.source,
    model: v.model,
    headline: v.headline,
    workstreams,
    looseEnds,
    threadCount: v.threadCount,
    withheld: v.withheld,
    note: v.note,
  };
}

export async function saveLastBrief(brief: CatchUpBrief): Promise<void> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      await chrome.storage.local.set({ [STORAGE_KEY]: brief });
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(brief));
  } catch {
    // storage unavailable or full; the brief stays on screen for this session
  }
}

export async function loadLastBrief(): Promise<CatchUpBrief | null> {
  try {
    if (typeof chrome !== 'undefined' && chrome.storage?.local) {
      const stored = await chrome.storage.local.get(STORAGE_KEY);
      return parseStoredBrief(stored?.[STORAGE_KEY]);
    }
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? parseStoredBrief(JSON.parse(raw) as unknown) : null;
  } catch {
    return null;
  }
}
