import {
  insightKeyFor,
  type ConversationRecord,
  type ExtensionSummaryOutput,
  type ExtractedItem,
  type JobRecord,
  type MessageRecord,
  type SettingsRecord,
  type ThreadInsight,
} from './schema.js';
import {
  applySummaryEnrichment,
  ensureStarterCollectionsAndSettings,
  saveSettingsPatch,
  UNFILED_PROJECT,
  type ThreadkeeperDB,
} from './db.js';
import {
  LOCAL_ANALYZER_MODEL,
  analyzeThreadLocally,
  resolveInsight,
  sanitizeSummaryForGrounding,
} from './insights.js';
import {
  LOCAL_SPACE,
  buildThreadEmbeddingDocument,
  embedTexts,
  localHashEmbedding,
  putThreadVector,
  remoteSpace,
} from './embeddings.js';
import {
  applyAutoOrganization,
  loadOrganizeContext,
  type OrganizeContext,
} from './auto-organize.js';
import {
  ClaudeCallError,
  analyzeThreadWithClaude,
  hasClaudeKey,
  type ThreadAnalysis,
} from './ai/claude.js';
import { providerLabel } from './providers.js';
import { computeDeterministicHash, normalizeSettings } from './schema.js';
import { currentUtcDateKey } from './cloud-client.js';

/**
 * The automatic organization pipeline.
 *
 *   capture/import ──▶ processThreadLocally   (instant, on-device)
 *                        ├─ local insight + grounded heuristic summary
 *                        ├─ local hashed vector
 *                        ├─ auto-file / status / tags
 *                        └─ enqueue analyze_thread (debounced)
 *   alarm / manager ──▶ runAnalysisJobs        (Claude + remote embeddings)
 *                        ├─ AI insight + grounded summary
 *                        ├─ remote vector
 *                        └─ auto-file again with the stronger signal
 */

const ANALYZE_JOB = 'analyze_thread' as const;
const LEASE_MS = 4 * 60_000;
const MAX_ATTEMPTS = 5;

export function analyzeJobId(threadKey: string): string {
  return `${ANALYZE_JOB}:${threadKey}`;
}

async function sortedMessages(db: ThreadkeeperDB, threadKey: string): Promise<MessageRecord[]> {
  return db.messages.where('threadKey').equals(threadKey).sortBy('ordinal');
}

/** Whether a thread may be sent to third-party AI or embedding APIs. */
export async function isRemoteProcessingAllowed(
  db: ThreadkeeperDB,
  conv: ConversationRecord,
  settings: SettingsRecord
): Promise<boolean> {
  if (conv.cloudExcluded || conv.isSyntheticBenchmark) return false;
  if (settings.cloudExcludedProviders.includes(conv.provider)) return false;
  const collection = await db.collections.get(conv.project);
  return !collection?.cloudExcluded;
}

function needsRemoteWork(
  settings: SettingsRecord,
  conv: ConversationRecord,
  aiInsight: ThreadInsight | undefined,
  hasRemoteVector: boolean
): boolean {
  const wantsAi =
    settings.autoOrganize.aiAnalysis &&
    hasClaudeKey(settings) &&
    conv.messageCount > 0 &&
    (!aiInsight || aiInsight.sourceRevision !== conv.sourceRevision);
  const wantsVector = remoteSpace(settings) !== null && !hasRemoteVector;
  return wantsAi || wantsVector;
}

export async function enqueueAnalysis(
  db: ThreadkeeperDB,
  conv: Pick<ConversationRecord, 'threadKey' | 'sourceRevision'>,
  delaySeconds: number
): Promise<JobRecord> {
  const now = Date.now();
  const jobId = analyzeJobId(conv.threadKey);
  return db.transaction('rw', db.jobs, async () => {
    const existing = await db.jobs.get(jobId);
    const notBefore = new Date(now + delaySeconds * 1000).toISOString();
    const record: JobRecord = {
      jobId,
      jobType: ANALYZE_JOB,
      threadKey: conv.threadKey,
      targetRevision: conv.sourceRevision,
      status: existing?.status === 'running' ? 'running' : 'pending',
      attempts:
        existing && existing.targetRevision === conv.sourceRevision ? existing.attempts : 0,
      maxAttempts: MAX_ATTEMPTS,
      lastError: existing?.lastError ?? null,
      createdAt: existing?.createdAt ?? new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
      // While a chat is still active each capture pushes the job further out.
      notBefore,
      leaseUntil: existing?.status === 'running' ? existing.leaseUntil ?? null : null,
    };
    await db.jobs.put(record);
    return record;
  });
}

export interface LocalProcessResult {
  analyzed: boolean;
  enqueued: boolean;
  projectChanged: boolean;
  createdProject: string | null;
}

/**
 * Instant on-device pass for one thread. Safe to call on every capture: it is
 * a no-op when the local insight already matches the current revision.
 */
export async function processThreadLocally(
  db: ThreadkeeperDB,
  threadKey: string,
  options: {
    settings?: SettingsRecord;
    ctx?: OrganizeContext;
    aiDelaySeconds?: number;
    force?: boolean;
  } = {}
): Promise<LocalProcessResult> {
  const result: LocalProcessResult = { analyzed: false, enqueued: false, projectChanged: false, createdProject: null };
  const settings = options.settings ?? (await ensureStarterCollectionsAndSettings(db));
  const conv = await db.conversations.get(threadKey);
  if (!conv || conv.isSyntheticBenchmark) return result;

  const [prevLocal, aiInsight, messages] = await Promise.all([
    db.insights.get(insightKeyFor('local', threadKey)),
    db.insights.get(insightKeyFor('ai', threadKey)),
    sortedMessages(db, threadKey),
  ]);

  let local = prevLocal;
  const stale =
    !prevLocal ||
    prevLocal.sourceRevision !== conv.sourceRevision ||
    prevLocal.contentHash !== conv.contentHash ||
    prevLocal.model !== LOCAL_ANALYZER_MODEL;

  if (settings.autoOrganize.localAnalysis && (stale || options.force)) {
    const analysis = analyzeThreadLocally(conv, messages);
    local = analysis.insight;
    await db.insights.put(local);
    result.analyzed = true;

    const existingSummary = await db.summaries.get(threadKey);
    const summaryIsLocalOrStale =
      !existingSummary ||
      existingSummary.model === LOCAL_ANALYZER_MODEL ||
      existingSummary.sourceRevision !== conv.sourceRevision;
    if (analysis.summary && summaryIsLocalOrStale) {
      await applySummaryEnrichment(db, {
        threadKey,
        sourceRevision: conv.sourceRevision,
        contentHash: conv.contentHash,
        model: LOCAL_ANALYZER_MODEL,
        summary: analysis.summary,
      });
    }

    const resolved = resolveInsight(conv, local, aiInsight);
    const doc = buildThreadEmbeddingDocument(conv, resolved, messages);
    await putThreadVector(db, {
      space: LOCAL_SPACE,
      threadKey,
      sourceRevision: conv.sourceRevision,
      doc,
      embedding: localHashEmbedding(doc),
    });
  }

  const ctx = options.ctx ?? (await loadOrganizeContext(db, settings));
  const organized = await applyAutoOrganization(
    db,
    threadKey,
    settings,
    ctx,
    resolveInsight(conv, local, aiInsight),
    prevLocal?.topics ?? []
  );
  result.projectChanged = organized.projectChanged;
  result.createdProject = organized.createdProject;

  const space = remoteSpace(settings);
  const remoteVector = space
    ? await db.threadVectors.get(`${space.id}|${threadKey}`)
    : undefined;
  const hasCurrentRemoteVector = Boolean(remoteVector && remoteVector.sourceRevision === conv.sourceRevision);
  if (
    needsRemoteWork(settings, conv, aiInsight, hasCurrentRemoteVector) &&
    (await isRemoteProcessingAllowed(db, conv, settings))
  ) {
    await enqueueAnalysis(db, conv, options.aiDelaySeconds ?? settings.autoOrganize.aiDebounceSeconds);
    result.enqueued = true;
  }
  return result;
}

/** Run the local pass over many threads, sharing one organize context. */
export async function processThreadsLocally(
  db: ThreadkeeperDB,
  threadKeys: string[],
  options: { onProgress?: (done: number, total: number) => void; aiDelaySeconds?: number; force?: boolean } = {}
): Promise<{ analyzed: number; enqueued: number; filed: number; createdProjects: string[] }> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  const ctx = await loadOrganizeContext(db, settings);
  let analyzed = 0;
  let enqueued = 0;
  let filed = 0;
  const createdProjects: string[] = [];
  for (let i = 0; i < threadKeys.length; i++) {
    const r = await processThreadLocally(db, threadKeys[i], {
      settings,
      ctx,
      aiDelaySeconds: options.aiDelaySeconds ?? 0,
      force: options.force,
    });
    if (r.analyzed) analyzed++;
    if (r.enqueued) enqueued++;
    if (r.projectChanged) filed++;
    if (r.createdProject) createdProjects.push(r.createdProject);
    if (i % 10 === 9 || i === threadKeys.length - 1) options.onProgress?.(i + 1, threadKeys.length);
  }
  return { analyzed, enqueued, filed, createdProjects };
}

// ---------------------------------------------------------------------------
// AI analysis
// ---------------------------------------------------------------------------

function toOrdinal(messageNumber: number | null | undefined, messages: MessageRecord[]): number | null {
  if (typeof messageNumber !== 'number' || !Number.isFinite(messageNumber)) return null;
  const ordinal = Math.round(messageNumber) - 1;
  return messages.some((m) => m.ordinal === ordinal) ? ordinal : null;
}

export function analysisToInsight(
  conv: ConversationRecord,
  analysis: ThreadAnalysis,
  messages: MessageRecord[],
  model: string,
  local: ThreadInsight | undefined
): ThreadInsight {
  const clean = (s: string | null | undefined, max: number) =>
    (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const topics = Array.from(
    new Set(
      analysis.topics
        .map((t) => t.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9.+#-]/g, ''))
        .filter((t) => t.length >= 2 && t.length <= 40)
    )
  ).slice(0, 8);
  return {
    insightKey: insightKeyFor('ai', conv.threadKey),
    threadKey: conv.threadKey,
    source: 'ai',
    model,
    sourceRevision: conv.sourceRevision,
    contentHash: conv.contentHash,
    generatedAt: new Date().toISOString(),
    title: clean(analysis.title, 120) || conv.title,
    gist: clean(analysis.gist, 220),
    summary: clean(analysis.summary, 1200),
    userGoal: clean(analysis.userGoal, 400) || null,
    outcome: clean(analysis.outcome, 400) || null,
    kind: analysis.kind,
    topics,
    entities: analysis.entities.map((e) => clean(e, 60)).filter(Boolean).slice(0, 10),
    languages: local?.languages ?? [],
    artifacts: analysis.artifacts.slice(0, 12).map((a) => ({
      label: clean(a.label, 120),
      kind: a.kind,
      messageIndex: toOrdinal(a.messageNumber, messages),
    })),
    lastUserAsk: local?.lastUserAsk ?? null,
    suggestedStatus: analysis.status,
    statusReason: clean(analysis.statusReason, 200) || null,
    suggestedProject: analysis.project
      ? {
          name: clean(analysis.project.name, 80),
          isNew: analysis.project.isNew,
          confidence: Math.max(0, Math.min(1, analysis.project.confidence)),
          reason: clean(analysis.project.reason, 200),
        }
      : null,
    userTurns: messages.filter((m) => m.role === 'user').length,
    hasCode: local?.hasCode ?? messages.some((m) => m.hasCode),
  };
}

export function analysisToSummary(
  analysis: ThreadAnalysis,
  messages: MessageRecord[]
): ExtensionSummaryOutput {
  const lastOrdinal = messages.length ? messages[messages.length - 1].ordinal : 0;
  const toItem = (it: ThreadAnalysis['decisions'][number]): ExtractedItem => {
    const ord = toOrdinal(it.messageNumber, messages) ?? lastOrdinal;
    return {
      text: it.text.trim().slice(0, 300),
      messageIndexes: [ord],
      evidenceQuote: it.quote.trim(),
      provenance: 'explicit',
      speaker: it.by === 'user' ? 'user_committed' : 'assistant_suggested',
    };
  };
  const leftOffOrdinal = toOrdinal(analysis.whereYouLeftOff.messageNumber, messages) ?? lastOrdinal;
  return sanitizeSummaryForGrounding(
    {
      whereYouLeftOff: analysis.whereYouLeftOff.text.trim(),
      whereYouLeftOffMessageIndexes: [leftOffOrdinal],
      currentStatus: analysis.statusReason.trim() || analysis.gist.trim(),
      currentStatusMessageIndexes: [lastOrdinal],
      decisions: analysis.decisions.map(toItem),
      openQuestions: analysis.openQuestions.map(toItem),
      actionItems: analysis.actionItems.map(toItem),
      constraints: [],
      entities: analysis.entities,
      artifactReferences: analysis.artifacts.map((a) => a.label),
      suggestedProject: analysis.project?.name ?? null,
      suggestedTags: analysis.topics,
      confidence: analysis.project?.confidence ?? 0.8,
    },
    messages
  );
}

async function reserveAiSlot(db: ThreadkeeperDB): Promise<boolean> {
  return db.transaction('rw', db.settings, async () => {
    const s = normalizeSettings(await db.settings.get('default'));
    const today = currentUtcDateKey();
    const used = s.aiAnalysesDate === today ? s.aiAnalysesToday : 0;
    const limit = s.autoOrganize.dailyAiAnalysisLimit;
    if (limit > 0 && used >= limit) return false;
    await db.settings.put({ ...s, aiAnalysesDate: today, aiAnalysesToday: used + 1 });
    return true;
  });
}

/** Give back a reserved slot when the Claude call did not produce an analysis. */
async function refundAiSlot(db: ThreadkeeperDB): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const s = normalizeSettings(await db.settings.get('default'));
    if (s.aiAnalysesDate !== currentUtcDateKey() || s.aiAnalysesToday <= 0) return;
    await db.settings.put({ ...s, aiAnalysesToday: s.aiAnalysesToday - 1 });
  });
}

export interface AiThreadResult {
  status: 'analyzed' | 'embedded' | 'skipped';
  reason?: string;
}

/** Claude analysis + remote embedding for one thread, then re-file with the stronger signal. */
export async function analyzeThreadRemotely(
  db: ThreadkeeperDB,
  threadKey: string,
  options: { settings?: SettingsRecord; ctx?: OrganizeContext; fetchImpl?: typeof fetch; ignoreDailyLimit?: boolean } = {}
): Promise<AiThreadResult> {
  const settings = options.settings ?? (await ensureStarterCollectionsAndSettings(db));
  const conv = await db.conversations.get(threadKey);
  if (!conv) return { status: 'skipped', reason: 'Thread no longer exists' };
  if (!(await isRemoteProcessingAllowed(db, conv, settings))) {
    return { status: 'skipped', reason: 'Thread is local-only (excluded from cloud processing)' };
  }
  const messages = await sortedMessages(db, threadKey);
  const local = await db.insights.get(insightKeyFor('local', threadKey));
  let aiInsight = await db.insights.get(insightKeyFor('ai', threadKey));
  let didAnalyze = false;

  const wantsAi =
    settings.autoOrganize.aiAnalysis || options.ignoreDailyLimit
      ? hasClaudeKey(settings) && messages.length > 0 && (!aiInsight || aiInsight.sourceRevision !== conv.sourceRevision)
      : false;

  if (wantsAi) {
    const reserved = !options.ignoreDailyLimit;
    if (reserved && !(await reserveAiSlot(db))) {
      throw new ClaudeCallError('Daily AI analysis limit reached; resumes tomorrow.', true, 'rate_limit');
    }
    const collections = await db.collections.toArray();
    const tagCounts = new Map<string, number>();
    for (const c of await db.conversations.limit(5000).toArray()) {
      for (const t of c.tags) tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
    }
    const knownTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 100)
      .map(([t]) => t);
    let result: Awaited<ReturnType<typeof analyzeThreadWithClaude>>;
    try {
      result = await analyzeThreadWithClaude(
        settings,
        {
          title: conv.manualTitleOverride || conv.title,
          providerLabel: providerLabel(conv.provider),
          providerProjectName: conv.providerProjectName ?? null,
          workspacePath: conv.workspacePath ?? null,
          updatedAt: conv.updatedAt,
          messages: messages.map((m) => ({ ordinal: m.ordinal, role: m.role, content: m.content })),
          projects: collections
            .filter((c) => c.name !== UNFILED_PROJECT)
            .map((c) => ({ name: c.name, description: c.description })),
          knownTags,
        },
        options.fetchImpl
      );
    } catch (err) {
      if (reserved) await refundAiSlot(db);
      throw err;
    }
    const { analysis, model } = result;

    // Stored against the revision that was analysed; a newer revision re-queues the job.
    aiInsight = analysisToInsight(conv, analysis, messages, model, local);
    await db.insights.put(aiInsight);
    await applySummaryEnrichment(db, {
      threadKey,
      sourceRevision: conv.sourceRevision,
      contentHash: conv.contentHash,
      model,
      summary: analysisToSummary(analysis, messages),
    });
    didAnalyze = true;
  }

  const resolved = resolveInsight(conv, local, aiInsight);
  const doc = buildThreadEmbeddingDocument(conv, resolved, messages);
  if (didAnalyze) {
    await putThreadVector(db, {
      space: LOCAL_SPACE,
      threadKey,
      sourceRevision: conv.sourceRevision,
      doc,
      embedding: localHashEmbedding(doc),
    });
  }
  const space = remoteSpace(settings);
  let embedded = false;
  if (space) {
    const existing = await db.threadVectors.get(`${space.id}|${threadKey}`);
    if (!existing || existing.docHash !== computeDeterministicHash(doc)) {
      const [embedding] = await embedTexts(settings, space, [doc], 'document', options.fetchImpl);
      await putThreadVector(db, { space: space.id, threadKey, sourceRevision: conv.sourceRevision, doc, embedding });
      embedded = true;
    }
  }

  const ctx = options.ctx ?? (await loadOrganizeContext(db, settings));
  await applyAutoOrganization(db, threadKey, settings, ctx, resolved, local?.topics ?? []);
  return didAnalyze ? { status: 'analyzed' } : embedded ? { status: 'embedded' } : { status: 'skipped', reason: 'Already up to date' };
}

async function claimNextJob(db: ThreadkeeperDB, nowMs: number): Promise<JobRecord | null> {
  return db.transaction('rw', db.jobs, async () => {
    const nowIso = new Date(nowMs).toISOString();
    const candidates = await db.jobs.where('jobType').equals(ANALYZE_JOB).toArray();
    const due = candidates
      .filter(
        (j) =>
          (j.status === 'pending' && (j.notBefore ?? '') <= nowIso) ||
          (j.status === 'running' && (j.leaseUntil ?? '') < nowIso)
      )
      .sort((a, b) => (a.notBefore ?? '').localeCompare(b.notBefore ?? ''));
    const job = due[0];
    if (!job) return null;
    const claimed: JobRecord = {
      ...job,
      status: 'running',
      attempts: job.attempts + 1,
      leaseUntil: new Date(nowMs + LEASE_MS).toISOString(),
      updatedAt: nowIso,
    };
    await db.jobs.put(claimed);
    return claimed;
  });
}

export interface RunJobsSummary {
  processed: number;
  analyzed: number;
  failed: number;
  stoppedReason: string | null;
  remaining: number;
}

/**
 * Drain due analysis jobs. Stops early on rate limits, auth errors, the daily
 * limit, an abort signal or the time budget.
 */
export async function runAnalysisJobs(
  db: ThreadkeeperDB,
  options: {
    maxJobs?: number;
    timeBudgetMs?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    onProgress?: (summary: RunJobsSummary, current: string | null) => void;
  } = {}
): Promise<RunJobsSummary> {
  const started = Date.now();
  const summary: RunJobsSummary = { processed: 0, analyzed: 0, failed: 0, stoppedReason: null, remaining: 0 };
  const settings = await ensureStarterCollectionsAndSettings(db);
  const ctx = await loadOrganizeContext(db, settings);
  const maxJobs = options.maxJobs ?? 10;

  while (summary.processed < maxJobs) {
    if (options.signal?.aborted) {
      summary.stoppedReason = 'Stopped';
      break;
    }
    if (options.timeBudgetMs && Date.now() - started > options.timeBudgetMs) {
      summary.stoppedReason = 'Time budget reached';
      break;
    }
    const job = await claimNextJob(db, Date.now());
    if (!job) break;
    summary.processed++;
    options.onProgress?.(summary, job.threadKey);
    try {
      const res = await analyzeThreadRemotely(db, job.threadKey, { settings, ctx, fetchImpl: options.fetchImpl });
      if (res.status === 'analyzed') summary.analyzed++;
      const conv = await db.conversations.get(job.threadKey);
      const newer = conv && conv.sourceRevision > job.targetRevision;
      await db.jobs.put({
        ...job,
        status: newer ? 'pending' : 'completed',
        targetRevision: conv?.sourceRevision ?? job.targetRevision,
        attempts: newer ? 0 : job.attempts,
        leaseUntil: null,
        lastError: res.status === 'skipped' ? res.reason ?? null : null,
        updatedAt: new Date().toISOString(),
      });
      if (settings.lastAiError) {
        settings.lastAiError = null;
        await saveSettingsPatch(db, { lastAiError: null, lastAiErrorAt: null });
      }
    } catch (err) {
      const e = err instanceof ClaudeCallError ? err : new ClaudeCallError(err instanceof Error ? err.message : String(err), true, 'server');
      const dailyLimit = e.message.startsWith('Daily AI analysis limit');
      // Auth problems and the daily cap pause the queue without burning retries.
      const noPenalty = e.kind === 'auth' || dailyLimit;
      const terminal = noPenalty ? false : !e.retryable || job.attempts >= job.maxAttempts;
      const backoffMs =
        e.kind === 'auth'
          ? 60 * 60_000
          : dailyLimit
            ? msUntilNextUtcDay()
            : Math.min(60 * 60_000, 30_000 * 2 ** job.attempts);
      await db.jobs.put({
        ...job,
        status: terminal ? 'failed' : 'pending',
        attempts: noPenalty ? Math.max(0, job.attempts - 1) : job.attempts,
        leaseUntil: null,
        lastError: e.message,
        notBefore: new Date(Date.now() + backoffMs).toISOString(),
        updatedAt: new Date().toISOString(),
      });
      await saveSettingsPatch(db, { lastAiError: e.message, lastAiErrorAt: new Date().toISOString() });
      if (terminal) summary.failed++;
      if (e.kind === 'auth' || e.kind === 'rate_limit') {
        summary.stoppedReason = e.message;
        break;
      }
    }
  }
  summary.remaining = await countPendingAnalysis(db);
  options.onProgress?.(summary, null);
  return summary;
}

function msUntilNextUtcDay(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 5);
  return next - now.getTime();
}

export async function countPendingAnalysis(db: ThreadkeeperDB): Promise<number> {
  const jobs = await db.jobs.where('jobType').equals(ANALYZE_JOB).toArray();
  return jobs.filter((j) => j.status === 'pending' || j.status === 'running').length;
}

/** Earliest pending notBefore, so the service worker can schedule an alarm for it. */
export async function nextDueAnalysisAt(db: ThreadkeeperDB): Promise<number | null> {
  const jobs = await db.jobs.where('jobType').equals(ANALYZE_JOB).toArray();
  const times = jobs
    .filter((j) => j.status === 'pending')
    .map((j) => Date.parse(j.notBefore ?? ''))
    .filter((t) => Number.isFinite(t));
  return times.length ? Math.min(...times) : null;
}

/** Queue every analysable thread (used by "Analyze library" in the manager). */
export async function enqueueLibraryAnalysis(
  db: ThreadkeeperDB,
  options: { onlyMissing?: boolean } = {}
): Promise<number> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  const [convs, aiInsights] = await Promise.all([
    db.conversations.toArray(),
    db.insights.where('source').equals('ai').toArray(),
  ]);
  const aiByThread = new Map(aiInsights.map((i) => [i.threadKey, i]));
  let count = 0;
  for (const conv of convs) {
    if (conv.isSyntheticBenchmark || conv.messageCount === 0) continue;
    const ai = aiByThread.get(conv.threadKey);
    if (options.onlyMissing !== false && ai && ai.sourceRevision === conv.sourceRevision) continue;
    if (!(await isRemoteProcessingAllowed(db, conv, settings))) continue;
    await enqueueAnalysis(db, conv, 0);
    count++;
  }
  return count;
}
