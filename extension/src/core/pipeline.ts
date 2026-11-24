import { isRemoteAllowed } from './privacy.js';
import { ANALYSIS_HELD_REASON, activeAnalysisHold } from './analysis-hold.js';
import {
  ANALYSIS_VERSION,
  insightKeyFor,
  type AgentRunFacts,
  type ConversationRecord,
  type ExtensionSummaryOutput,
  type ExtractedItem,
  type JobRecord,
  type MessageRecord,
  type ProducedItem,
  type SettingsRecord,
  type ThreadInsight,
} from './schema.js';
import {
  applySummaryEnrichment,
  ensureStarterCollectionsAndSettings,
  saveSettingsPatch,
  UNFILED_PROJECT,
  type ThreadStackDB,
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
  estimateAnalysisCostUsd,
  hasClaudeKey,
  type ThreadAnalysis,
} from './ai/claude.js';
import { providerCategory, providerLabel } from './providers.js';
import { normalizePullRequestUrl, normalizeRepository } from './repository.js';
import { realmForProvider } from './workspace/realms.js';
import { AGENT_STATE_LABELS } from './workspace/types.js';
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

async function sortedMessages(db: ThreadStackDB, threadKey: string): Promise<MessageRecord[]> {
  return db.messages.where('threadKey').equals(threadKey).sortBy('ordinal');
}

/** Whether a thread may be sent to third-party AI or embedding APIs. */
export async function isRemoteProcessingAllowed(
  db: ThreadStackDB,
  conv: ConversationRecord,
  settings: SettingsRecord
): Promise<boolean> {
  if (conv.cloudExcluded || conv.isSyntheticBenchmark) return false;
  if (settings.cloudExcludedProviders.includes(conv.provider)) return false;
  const collection = await db.collections.get(conv.project);
  return !collection?.cloudExcluded;
}

/** Whether an AI insight was written by an older analysis format (see ANALYSIS_VERSION). */
export function isOlderAnalysis(insight: Pick<ThreadInsight, 'source' | 'analysisVersion'> | null | undefined): boolean {
  return Boolean(insight && insight.source === 'ai' && (insight.analysisVersion ?? 1) < ANALYSIS_VERSION);
}

/**
 * A coding-agent thread whose current AI analysis predates the agent facts (agentRun is absent, not
 * null: null means Claude read it and found no agent run). Only an explicit request upgrades it.
 */
export function needsAgentRunUpgrade(
  conv: Pick<ConversationRecord, 'provider'>,
  insight: Pick<ThreadInsight, 'source' | 'agentRun'> | null | undefined
): boolean {
  return Boolean(insight && insight.source === 'ai' && insight.agentRun === undefined && providerCategory(conv.provider) === 'coding_agent');
}

/**
 * The label of the account a thread was captured under, for the analysis header. Label only: never the
 * account id, the signed-in identity, an email or a cookie. Null when there is no such account.
 */
export async function accountLabelForThread(
  db: ThreadStackDB,
  conv: Pick<ConversationRecord, 'provider' | 'accountId'>,
  settings: Pick<SettingsRecord, 'boundAccounts'>
): Promise<string | null> {
  try {
    let account = await db.accounts.get(conv.accountId);
    // Threads captured before accounts existed carry the legacy bound id; it stands for the primary account.
    if (!account && settings.boundAccounts?.[conv.provider]?.accountId === conv.accountId) {
      const realm = realmForProvider(conv.provider);
      if (realm) account = (await db.accounts.where('realm').equals(realm.id).toArray()).find((a) => a.primary);
    }
    if (!account) return null;
    const label = cleanLine(account.label, 60);
    // A default label is replaced by the signed-in identity (usually an email address), and that must
    // not leave the device: send a label only when the user's own wording carries no identity.
    const identity = account.identity?.display?.trim().toLowerCase();
    if (!label || (identity && label.toLowerCase() === identity) || /[^\s@]+@[^\s@]+\.[^\s@]+/.test(label)) return null;
    return label;
  } catch {
    return null;
  }
}

/**
 * Automatic work only: a new or changed thread. Older-format analyses are deliberately not upgraded here
 * (that would bill every existing thread on its next capture); the user upgrades them on demand
 * (queueAnalysis, "Upgrade older summaries", or "Improve summary" on one thread).
 */
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
  db: ThreadStackDB,
  conv: Pick<ConversationRecord, 'threadKey' | 'sourceRevision'>,
  delaySeconds: number,
  options: { requested?: boolean } = {}
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
      // An open request survives re-queues (e.g. a capture while it waits); a finished job's flag does not.
      requested:
        Boolean(options.requested) ||
        (Boolean(existing?.requested) && (existing?.status === 'pending' || existing?.status === 'running')),
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
  db: ThreadStackDB,
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
  db: ThreadStackDB,
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

const ARTIFACT_KINDS = new Set<ProducedItem['kind']>(['code', 'document', 'design', 'data', 'link', 'other']);

/** Collapse whitespace inside one line of model text and clamp it. */
function cleanLine(s: string | null | undefined, max: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
}

/**
 * Overview paragraphs: each array entry is a paragraph, and a model that packed several paragraphs into
 * one string (blank lines) gets them split. Whitespace inside a paragraph collapses; at most 4 paragraphs.
 */
export function cleanOverview(paragraphs: string[] | null | undefined, gist = ''): string[] {
  const gistNorm = gist.replace(/\s+/g, ' ').trim().toLowerCase();
  return (paragraphs ?? [])
    .flatMap((p) => (typeof p === 'string' ? p.split(/\n\s*\n/) : []))
    .map((p) => cleanLine(p, 900))
    .filter((p) => p.length > 0 && p.toLowerCase() !== gistNorm)
    .slice(0, 4);
}

const PR_STATES = new Set<AgentRunFacts['pullRequests'][number]['state']>(['open', 'merged', 'closed', 'unknown']);
const BLOCKED_ON = new Set<AgentRunFacts['blockedOn']>(['none', 'permission', 'input', 'ci', 'external']);
const RUN_STATES = new Set<AgentRunFacts['runState']>(['running', 'finished', 'errored', 'awaiting_user', 'unknown']);

/**
 * Claude's reading of an agent run, clamped, with the facts the capture recorded filling the fields
 * Claude left empty (they do not depend on the transcript being complete). Null stays null: Claude
 * judged the thread not to be an agent run.
 */
function toAgentRunFacts(conv: ConversationRecord, run: ThreadAnalysis['agentRun']): AgentRunFacts | null {
  if (!run) return null;
  const pullRequests: AgentRunFacts['pullRequests'] = [];
  const addPullRequest = (raw: string | null | undefined, state: AgentRunFacts['pullRequests'][number]['state']) => {
    const url = normalizePullRequestUrl((raw ?? '').replace('/-/merge_requests/', '/merge_requests/'));
    if (!url || pullRequests.length >= 5) return;
    const seen = pullRequests.find((p) => p.url === url);
    if (seen) {
      if (seen.state === 'unknown') seen.state = state;
      return;
    }
    pullRequests.push({ url, state });
  };
  for (const p of run.pullRequests ?? []) addPullRequest(p.url, PR_STATES.has(p.state) ? p.state : 'unknown');
  addPullRequest(conv.pullRequestUrl, 'unknown');

  const files = Array.from(new Set((run.filesChanged ?? []).map((f) => cleanLine(f, 200)).filter(Boolean))).slice(0, 15);
  const commands = (run.commandsRun ?? [])
    .map((c) => ({ command: cleanLine(c.command, 160), outcome: c.outcome }))
    .filter((c) => c.command)
    .slice(-8);
  const testsStatus = ['passing', 'failing', 'not_run', 'unknown'].includes(run.tests?.status) ? run.tests.status : 'unknown';
  const observed = conv.agentState;
  const observedRunState: AgentRunFacts['runState'] | null =
    observed === 'running'
      ? 'running'
      : observed === 'waiting_permission' || observed === 'waiting_answer'
        ? 'awaiting_user'
        : observed === 'failed'
          ? 'errored'
          : observed === 'turn_complete'
            ? 'finished'
            : null;
  const claudeRunState = RUN_STATES.has(run.runState) ? run.runState : 'unknown';
  return {
    repository: normalizeRepository(conv.repository ?? null) ?? normalizeRepository(run.repository),
    branch: cleanLine(conv.gitBranch, 120) || cleanLine(run.branch, 120) || null,
    pullRequests,
    filesChanged: files,
    commandsRun: commands,
    tests: { status: testsStatus, detail: cleanLine(run.tests?.detail, 160) || null },
    blockedOn: BLOCKED_ON.has(run.blockedOn) ? run.blockedOn : 'none',
    runState: claudeRunState === 'unknown' && observedRunState ? observedRunState : claudeRunState,
  };
}

export function analysisToInsight(
  conv: ConversationRecord,
  analysis: ThreadAnalysis,
  messages: MessageRecord[],
  model: string,
  local: ThreadInsight | undefined
): ThreadInsight {
  const clean = cleanLine;
  const topics = Array.from(
    new Set(
      analysis.topics
        .map((t) => t.toLowerCase().trim().replace(/\s+/g, '-').replace(/[^a-z0-9.+#-]/g, ''))
        .filter((t) => t.length >= 2 && t.length <= 40)
    )
  ).slice(0, 8);
  const gist = clean(analysis.gist, 220);
  const overview = cleanOverview(analysis.overview, gist);
  const seenProduced = new Set<string>();
  const produced: ProducedItem[] = [];
  for (const p of analysis.produced ?? []) {
    const label = clean(p.label, 120);
    const key = label.toLowerCase();
    if (!label || seenProduced.has(key)) continue;
    seenProduced.add(key);
    produced.push({
      label,
      kind: ARTIFACT_KINDS.has(p.kind) ? p.kind : 'other',
      description: clean(p.description, 240),
      messageIndex: toOrdinal(p.messageNumber, messages),
    });
    if (produced.length >= 12) break;
  }
  return {
    insightKey: insightKeyFor('ai', conv.threadKey),
    threadKey: conv.threadKey,
    source: 'ai',
    model,
    sourceRevision: conv.sourceRevision,
    contentHash: conv.contentHash,
    generatedAt: new Date().toISOString(),
    title: clean(analysis.title, 120) || conv.title,
    gist,
    // Legacy readers (search, embeddings, catch-up, ask) read one paragraph.
    summary: clean(overview.join(' '), 1200) || gist,
    overview,
    userGoal: clean(analysis.userGoal, 400) || null,
    outcome: clean(analysis.outcome, 400) || null,
    kind: analysis.kind,
    topics,
    entities: Array.from(new Set(analysis.entities.map((e) => clean(e, 60)).filter(Boolean))).slice(0, 10),
    languages: local?.languages ?? [],
    artifacts: produced.map(({ label, kind, messageIndex }) => ({ label, kind, messageIndex })),
    produced,
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
    analysisVersion: ANALYSIS_VERSION,
    agentRun: toAgentRunFacts(conv, analysis.agentRun),
  };
}

export function analysisToSummary(
  analysis: ThreadAnalysis,
  messages: MessageRecord[]
): ExtensionSummaryOutput {
  const lastOrdinal = messages.length ? messages[messages.length - 1].ordinal : 0;
  const toItem = (it: ThreadAnalysis['decisions'][number], withRationale = false): ExtractedItem => {
    const ord = toOrdinal(it.messageNumber, messages) ?? lastOrdinal;
    const rationale = withRationale ? cleanLine(it.rationale, 240) : '';
    return {
      text: cleanLine(it.text, 300),
      messageIndexes: [ord],
      evidenceQuote: it.quote.trim(),
      provenance: 'explicit',
      speaker: it.by === 'user' ? 'user_committed' : 'assistant_suggested',
      ...(withRationale ? { rationale: rationale || null } : {}),
    };
  };
  const decision = (it: ThreadAnalysis['decisions'][number]) => toItem(it, true);
  const plain = (it: ThreadAnalysis['decisions'][number]) => toItem(it);
  const leftOffOrdinal = toOrdinal(analysis.whereYouLeftOff.messageNumber, messages) ?? lastOrdinal;
  const nextStep = cleanLine(analysis.whereYouLeftOff.nextStep, 300);
  return sanitizeSummaryForGrounding(
    {
      whereYouLeftOff: cleanLine(analysis.whereYouLeftOff.text, 600),
      whereYouLeftOffMessageIndexes: [leftOffOrdinal],
      currentStatus: analysis.statusReason.trim() || analysis.gist.trim(),
      currentStatusMessageIndexes: [lastOrdinal],
      decisions: analysis.decisions.slice(0, 10).map(decision),
      openQuestions: analysis.openQuestions.slice(0, 10).map(plain),
      actionItems: analysis.actionItems.slice(0, 10).map(plain),
      constraints: [],
      keyPoints: analysis.keyPoints.slice(0, 8).map(plain),
      nextStep: nextStep || null,
      entities: analysis.entities,
      artifactReferences: (analysis.produced ?? []).map((a) => a.label),
      suggestedProject: analysis.project?.name ?? null,
      suggestedTags: analysis.topics,
      confidence: analysis.project?.confidence ?? 0.8,
    },
    messages
  );
}

async function reserveAiSlot(db: ThreadStackDB): Promise<boolean> {
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
async function refundAiSlot(db: ThreadStackDB): Promise<void> {
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
  db: ThreadStackDB,
  threadKey: string,
  options: {
    settings?: SettingsRecord;
    ctx?: OrganizeContext;
    fetchImpl?: typeof fetch;
    /** An explicit request for this one thread (manager "Analyze"/"Improve summary"); also upgrades older formats. */
    ignoreDailyLimit?: boolean;
    /**
     * The user asked for this analysis (queued with queueAnalysis): run even when automatic analysis is
     * off, and re-analyze an up-to-date AI insight written by an older analysis format.
     */
    requested?: boolean;
  } = {}
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

  const explicit = Boolean(options.requested || options.ignoreDailyLimit);
  const upgrade = explicit && (isOlderAnalysis(aiInsight) || needsAgentRunUpgrade(conv, aiInsight));
  const wantsAi =
    settings.autoOrganize.aiAnalysis || explicit
      ? hasClaudeKey(settings) &&
        messages.length > 0 &&
        (!aiInsight || aiInsight.sourceRevision !== conv.sourceRevision || upgrade)
      : false;

  if (wantsAi) {
    const reserved = !options.ignoreDailyLimit;
    if (reserved && !(await reserveAiSlot(db))) {
      throw new ClaudeCallError('Daily AI analysis limit reached; resumes tomorrow.', true, 'rate_limit');
    }
    const collections = await db.collections.toArray();
    // Tags come from message text, so only threads that may leave the browser contribute.
    const localOnly = new Set(collections.filter((c) => c.cloudExcluded).map((c) => c.name));
    const tagCounts = new Map<string, number>();
    for (const c of await db.conversations.limit(5000).toArray()) {
      if (!isRemoteAllowed(c, settings, localOnly)) continue;
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
          repository: normalizeRepository(conv.repository ?? null) ?? local?.agentRun?.repository ?? null,
          branch: conv.gitBranch ?? null,
          pullRequestUrl: normalizePullRequestUrl(conv.pullRequestUrl ?? null),
          accountLabel: await accountLabelForThread(db, conv, settings),
          model: conv.modelSlug ?? null,
          agentLabel: conv.agentLabel ?? null,
          observedRunState:
            conv.agentState && conv.agentState !== 'unknown' ? AGENT_STATE_LABELS[conv.agentState] : null,
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

async function claimNextJob(db: ThreadStackDB, nowMs: number): Promise<JobRecord | null> {
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
  db: ThreadStackDB,
  options: {
    maxJobs?: number;
    timeBudgetMs?: number;
    signal?: AbortSignal;
    fetchImpl?: typeof fetch;
    onProgress?: (summary: RunJobsSummary, current: string | null) => void;
    /** Called after each job that finished (analyzed, embedded or skipped) — the Still link's dirty hook. */
    onJobDone?: (threadKey: string, status: AiThreadResult['status']) => void;
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
    // An online import is running: no hosted analysis starts until it ends (analysis-hold.ts).
    if (await activeAnalysisHold(db, Date.now())) {
      summary.stoppedReason = ANALYSIS_HELD_REASON;
      break;
    }
    const job = await claimNextJob(db, Date.now());
    if (!job) break;
    summary.processed++;
    options.onProgress?.(summary, job.threadKey);
    try {
      const res = await analyzeThreadRemotely(db, job.threadKey, {
        settings,
        ctx,
        fetchImpl: options.fetchImpl,
        requested: Boolean(job.requested),
      });
      if (res.status === 'analyzed') summary.analyzed++;
      const conv = await db.conversations.get(job.threadKey);
      const newer = conv && conv.sourceRevision > job.targetRevision;
      await db.jobs.put({
        ...job,
        status: newer ? 'pending' : 'completed',
        targetRevision: conv?.sourceRevision ?? job.targetRevision,
        requested: newer ? job.requested : false,
        attempts: newer ? 0 : job.attempts,
        leaseUntil: null,
        lastError: res.status === 'skipped' ? res.reason ?? null : null,
        updatedAt: new Date().toISOString(),
      });
      try {
        options.onJobDone?.(job.threadKey, res.status);
      } catch {
        // a hook must never stop the queue
      }
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

export async function countPendingAnalysis(db: ThreadStackDB): Promise<number> {
  const jobs = await db.jobs.where('jobType').equals(ANALYZE_JOB).toArray();
  return jobs.filter((j) => j.status === 'pending' || j.status === 'running').length;
}

/** Earliest pending notBefore, so the service worker can schedule an alarm for it. */
export async function nextDueAnalysisAt(db: ThreadStackDB): Promise<number | null> {
  // Nothing is due while an import holds analysis; ending the hold starts the queue itself.
  if (await activeAnalysisHold(db, Date.now())) return null;
  const jobs = await db.jobs.where('jobType').equals(ANALYZE_JOB).toArray();
  const times = jobs
    .filter((j) => j.status === 'pending')
    .map((j) => Date.parse(j.notBefore ?? ''))
    .filter((t) => Number.isFinite(t));
  return times.length ? Math.min(...times) : null;
}

/** Queue every analysable thread (used by "Analyze library" in the manager). */
export async function enqueueLibraryAnalysis(
  db: ThreadStackDB,
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

// ---------------------------------------------------------------------------
// On-demand analysis (Settings → "Upgrade older summaries", Still's threads.analyze)
// ---------------------------------------------------------------------------

export type AnalysisSkipReason = 'no_ai' | 'local_only' | 'fresh' | 'missing';

export interface QueueAnalysisResult {
  queued: number;
  /** Threads queued only to bring an older AI analysis up to the current format. */
  upgrades: number;
  skipped: Array<{ threadKey: string; reason: AnalysisSkipReason }>;
  /** List-price estimate for the queued analyses with the selected model. */
  estimateUsd: number;
}

/**
 * Queue Claude analysis the user asked for: threads without a current AI analysis, and (with `upgrade`,
 * the default) threads whose AI analysis is in an older format. Jobs run at the next drain (manager
 * runner or the service worker's RUN_ANALYSIS_NOW), also when automatic analysis is off, and count
 * against the daily limit.
 */
export async function queueAnalysis(
  db: ThreadStackDB,
  threadKeys: string[],
  options: { settings?: SettingsRecord; upgrade?: boolean } = {}
): Promise<QueueAnalysisResult> {
  const settings = options.settings ?? (await ensureStarterCollectionsAndSettings(db));
  const upgradeOlder = options.upgrade !== false;
  const result: QueueAnalysisResult = { queued: 0, upgrades: 0, skipped: [], estimateUsd: 0 };
  const keys = Array.from(new Set(threadKeys));
  const ready = hasClaudeKey(settings);
  for (const threadKey of keys) {
    const conv = await db.conversations.get(threadKey);
    if (!conv || conv.isSyntheticBenchmark || conv.messageCount === 0) {
      result.skipped.push({ threadKey, reason: 'missing' });
      continue;
    }
    if (!(await isRemoteProcessingAllowed(db, conv, settings))) {
      result.skipped.push({ threadKey, reason: 'local_only' });
      continue;
    }
    if (!ready) {
      result.skipped.push({ threadKey, reason: 'no_ai' });
      continue;
    }
    const ai = await db.insights.get(insightKeyFor('ai', threadKey));
    const current = ai && ai.sourceRevision === conv.sourceRevision;
    // An explicit request also fills in the agent facts a coding-agent analysis predates.
    const older = isOlderAnalysis(ai) || needsAgentRunUpgrade(conv, ai);
    if (current && !(older && upgradeOlder)) {
      result.skipped.push({ threadKey, reason: 'fresh' });
      continue;
    }
    await enqueueAnalysis(db, conv, 0, { requested: true });
    result.queued++;
    if (current && older) result.upgrades++;
  }
  result.estimateUsd = estimateAnalysisCostUsd(settings.aiModel, result.queued);
  return result;
}

/** Threads whose current AI analysis predates ANALYSIS_VERSION and may be sent to Claude. */
export async function listOlderAnalyses(db: ThreadStackDB, settings?: SettingsRecord): Promise<string[]> {
  const s = settings ?? (await ensureStarterCollectionsAndSettings(db));
  const aiInsights = await db.insights.where('source').equals('ai').toArray();
  const keys: string[] = [];
  for (const insight of aiInsights) {
    if (!isOlderAnalysis(insight)) continue;
    const conv = await db.conversations.get(insight.threadKey);
    if (!conv || conv.isSyntheticBenchmark || conv.messageCount === 0) continue;
    if (!(await isRemoteProcessingAllowed(db, conv, s))) continue;
    keys.push(insight.threadKey);
  }
  return keys;
}

/** Queue every older-format AI analysis for an upgrade ("Upgrade older summaries"). */
export async function queueOlderAnalysisUpgrades(db: ThreadStackDB): Promise<QueueAnalysisResult> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  return queueAnalysis(db, await listOlderAnalyses(db, settings), { settings, upgrade: true });
}
