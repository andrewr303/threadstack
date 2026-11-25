import {
  definePlugin,
  runWorker,
  type Issue,
  type PluginContext,
  type ScopeKey,
  type ToolResult,
  type ToolRunContext,
} from "@paperclipai/plugin-sdk";
import {
  BLUEPRINT_STEPS,
  DEDUPE_WINDOW_MS,
  GROWTH_AGENT_KEY,
  GROWTH_PROJECT_KEY,
  JOB_INDEX_LIMIT,
  JOB_INDEX_STATE_KEY,
  JOB_STATE_KEY,
  PLUGIN_ID,
  PROGRESS_STREAM_CHANNEL,
  REPORT_STEP_TOOL,
  STATE_NAMESPACE,
  advanceJob,
  applyRunLifecycle,
  createJob,
  currentStep,
  deriveOutcome,
  formatUsd,
  isBlueprintJob,
  isOverCap,
  jobMode,
  normalizeSite,
  textEndsInQuestion,
  validateReportStepParams,
  validateStartOptions,
  type BlueprintArtifact,
  type BlueprintJob,
  type BlueprintMode,
  type BlueprintOutcome,
  type BlueprintProgressEvent,
  type ReportStepParams,
  type RunLifecycleEventType,
} from "./contracts.js";
import {
  BLUEPRINT_JOB_ID,
  buildBlueprintPrompt,
  buildFollowupPrompt,
  findJob,
  jobIdFor,
} from "./jobs.js";
import manifest from "./manifest.js";

// ---------------------------------------------------------------------------
// State layout
// ---------------------------------------------------------------------------

/** One entry per task the plugin started, newest first, in company-scoped state. */
export interface JobIndexEntry {
  issueId: string;
  jobId: string;
  site: string;
  kind: "blueprint" | "followup";
  followupId?: string;
  /** The mode the task runs in: a blueprint's own, or the one a follow-up inherited from its blueprint. Absent on entries from before modes: those ran as full. */
  mode?: BlueprintMode;
  startedAt: string;
}

/** What the data handlers return to the UI for one task. */
export interface JobView {
  job: BlueprintJob;
  outcome: BlueprintOutcome;
  /** The assigned agent's newest comment ends in a question (needs the comment list, so only the job view sets it). */
  agentAskedQuestion?: boolean;
  task: { id: string; identifier: string | null; title: string; status: string } | null;
}

export type StartResult =
  | { ok: true; deduped: boolean; issueId: string; identifier: string | null; job: BlueprintJob | null }
  | { ok: false; reason: "invalid_site" | "invalid_mode" | "invalid_cap" | "agent_unavailable" | "agent_paused" | "project_unavailable" | "unknown_followup" | "invalid_parent"; message: string; agentId?: string | null };

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<void>>();

/**
 * Run `fn` after every earlier holder of `key` has finished. Plugin state has
 * no compare-and-swap, so every read-modify-write of one record (a task's job,
 * a company's index) and every check-then-create (dedupe) runs under a lock.
 * The worker is one process per plugin; `saveJob` also checks the revision as a
 * second guard.
 */
export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const tail = previous.then(() => held);
  locks.set(key, tail);
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
}

const jobLockKey = (issueId: string) => `job:${issueId}`;
const indexLockKey = (companyId: string) => `index:${companyId}`;

/** The stored job moved on since it was read; the caller must re-read and retry. */
export class StaleJobError extends Error {
  constructor(issueId: string) {
    super(`The blueprint job for task ${issueId} changed while it was being saved.`);
    this.name = "StaleJobError";
  }
}

function jobKey(issueId: string): ScopeKey {
  return { scopeKind: "issue", scopeId: issueId, namespace: STATE_NAMESPACE, stateKey: JOB_STATE_KEY };
}

function indexKey(companyId: string): ScopeKey {
  return { scopeKind: "company", scopeId: companyId, namespace: STATE_NAMESPACE, stateKey: JOB_INDEX_STATE_KEY };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isIndexEntry(value: unknown): value is JobIndexEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.issueId === "string" && typeof entry.site === "string" && typeof entry.startedAt === "string";
}

async function readJob(ctx: PluginContext, issueId: string): Promise<BlueprintJob | null> {
  const value = await ctx.state.get(jobKey(issueId));
  return isBlueprintJob(value) ? value : null;
}

async function readIndex(ctx: PluginContext, companyId: string): Promise<JobIndexEntry[]> {
  const value = await ctx.state.get(indexKey(companyId));
  return Array.isArray(value) ? value.filter(isIndexEntry) : [];
}

async function addToIndex(ctx: PluginContext, companyId: string, entry: JobIndexEntry): Promise<void> {
  await withLock(indexLockKey(companyId), async () => {
    const current = await readIndex(ctx, companyId);
    const next = [entry, ...current.filter((item) => item.issueId !== entry.issueId)].slice(0, JOB_INDEX_LIMIT);
    await ctx.state.set(indexKey(companyId), next);
  });
}

function emitJob(ctx: PluginContext, job: BlueprintJob): void {
  const event: BlueprintProgressEvent = { type: "job.updated", job };
  // `open` binds the channel to this company before the event goes out.
  ctx.streams.open(PROGRESS_STREAM_CHANNEL, job.companyId);
  ctx.streams.emit(PROGRESS_STREAM_CHANNEL, event);
}

async function logChange(ctx: PluginContext, job: BlueprintJob, message: string): Promise<void> {
  // Ids and enums only: no site text, details or other payload text.
  await ctx.activity.log({
    companyId: job.companyId,
    message,
    entityType: "issue",
    entityId: job.issueId,
    metadata: { jobId: job.jobId, step: currentStep(job), outcome: job.outcome },
  });
}

function revisionOf(job: BlueprintJob | null): number | null {
  return job ? job.revision ?? 0 : null;
}

/**
 * Persist, log and stream one job change. Every state change goes through
 * here, inside the task's job lock. `expectedRevision` is the revision the
 * caller read (null when the job is new); the write is refused if the stored
 * job has moved since.
 */
async function saveJob(ctx: PluginContext, job: BlueprintJob, message: string, expectedRevision: number | null): Promise<BlueprintJob> {
  const stored = revisionOf(await readJob(ctx, job.issueId));
  if (stored !== expectedRevision) throw new StaleJobError(job.issueId);
  const next: BlueprintJob = { ...job, revision: expectedRevision === null ? 0 : expectedRevision + 1 };
  await ctx.state.set(jobKey(job.issueId), next);
  await logChange(ctx, next, message);
  emitJob(ctx, next);
  return next;
}

function isOpenIssue(issue: Issue | null): issue is Issue {
  return Boolean(issue && issue.status !== "done" && issue.status !== "cancelled");
}

// ---------------------------------------------------------------------------
// Managed resources
// ---------------------------------------------------------------------------

async function resolveGrowthAgent(ctx: PluginContext, companyId: string) {
  const resolution = await ctx.agents.managed.reconcile(GROWTH_AGENT_KEY, companyId);
  return resolution.agent;
}

async function resolveGrowthProject(ctx: PluginContext, companyId: string) {
  const resolution = await ctx.projects.managed.reconcile(GROWTH_PROJECT_KEY, companyId);
  return resolution.projectId;
}

function companyFrom(params: Record<string, unknown>, contextCompanyId: string | null | undefined): string {
  const companyId = stringField(contextCompanyId) ?? stringField(params.companyId);
  if (!companyId) throw new Error("companyId is required");
  return companyId;
}

// ---------------------------------------------------------------------------
// start / start-followup
// ---------------------------------------------------------------------------

async function findActiveDuplicate(
  ctx: PluginContext,
  companyId: string,
  match: (entry: JobIndexEntry) => boolean,
  nowMs: number,
): Promise<{ entry: JobIndexEntry; issue: Issue } | null> {
  for (const entry of await readIndex(ctx, companyId)) {
    if (!match(entry)) continue;
    const startedMs = Date.parse(entry.startedAt);
    if (!Number.isFinite(startedMs) || nowMs - startedMs >= DEDUPE_WINDOW_MS) continue;
    const issue = await ctx.issues.get(entry.issueId, companyId);
    if (!isOpenIssue(issue)) continue;
    if (entry.kind === "blueprint") {
      const job = await readJob(ctx, entry.issueId);
      if (!job || job.outcome === "ready") continue;
    }
    return { entry, issue };
  }
  return null;
}

async function prepareAgentAndProject(ctx: PluginContext, companyId: string) {
  const agent = await resolveGrowthAgent(ctx, companyId);
  if (!agent) {
    return { error: { ok: false as const, reason: "agent_unavailable" as const, message: "The Growth agent is not set up yet. It may be waiting for board approval.", agentId: null } };
  }
  if (agent.status === "paused" || agent.status === "terminated" || agent.status === "pending_approval") {
    return { error: { ok: false as const, reason: "agent_paused" as const, message: "Growth is paused. Resume the Growth agent, then start again.", agentId: agent.id } };
  }
  const projectId = await resolveGrowthProject(ctx, companyId);
  if (!projectId) {
    return { error: { ok: false as const, reason: "project_unavailable" as const, message: "The Growth blueprints project could not be created." } };
  }
  return { agent, projectId };
}

async function wake(ctx: PluginContext, issueId: string, companyId: string, idempotencyKey: string): Promise<void> {
  try {
    await ctx.issues.requestWakeup(issueId, companyId, {
      reason: "growth_blueprint_started",
      contextSource: PLUGIN_ID,
      idempotencyKey,
    });
  } catch (error) {
    ctx.logger.warn("Growth task created but the wakeup was not queued", {
      issueId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startBlueprint(
  ctx: PluginContext,
  input: { companyId: string; site: unknown; mode?: unknown; capUsd?: unknown; now?: Date },
): Promise<StartResult> {
  const site = normalizeSite(input.site);
  if (!site) return { ok: false, reason: "invalid_site", message: "Enter a public website, for example example.com." };
  const options = validateStartOptions(input.mode, input.capUsd);
  if (!options.ok) return { ok: false, reason: options.reason, message: options.message };
  const { mode, capUsd } = options.value;
  const now = input.now ?? new Date();
  const { companyId } = input;

  // The duplicate check and the create are one step: a second start for the
  // same site and mode waits here and then finds the first task. A free and a
  // full task for one site are different tasks. An entry with no mode ran as full.
  return withLock(`start:${companyId}:blueprint:${mode}:${site}`, async (): Promise<StartResult> => {
    const duplicate = await findActiveDuplicate(
      ctx,
      companyId,
      (entry) => entry.kind === "blueprint" && entry.site === site && (entry.mode ?? "full") === mode,
      now.getTime(),
    );
    if (duplicate) {
      return {
        ok: true,
        deduped: true,
        issueId: duplicate.issue.id,
        identifier: duplicate.issue.identifier ?? null,
        job: await readJob(ctx, duplicate.issue.id),
      };
    }

    const prepared = await prepareAgentAndProject(ctx, companyId);
    if ("error" in prepared) return prepared.error!;

    const jobId = await jobIdFor(site, now, BLUEPRINT_JOB_ID, mode);
    const prompt = buildBlueprintPrompt(site, { mode, capUsd });
    const issue = await ctx.issues.create({
      companyId,
      projectId: prepared.projectId,
      title: prompt.title,
      description: prompt.description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: prepared.agent.id,
      originKind: `plugin:${PLUGIN_ID}:blueprint`,
      originId: jobId,
      billingCode: `plugin-${PLUGIN_ID}`,
    });

    const created = createJob({
      jobId,
      companyId,
      issueId: issue.id,
      agentId: prepared.agent.id,
      site,
      mode,
      now: now.toISOString(),
      capUsd,
    });
    await addToIndex(ctx, companyId, { issueId: issue.id, jobId, site, kind: "blueprint", mode, startedAt: created.startedAt });
    const job = await withLock(jobLockKey(issue.id), () => saveJob(ctx, created, "Started a growth blueprint task", null));
    await wake(ctx, issue.id, companyId, jobId);
    return { ok: true, deduped: false, issueId: issue.id, identifier: issue.identifier ?? null, job };
  });
}

/**
 * The blueprint a follow-up is linked to: same company, same site, and not
 * closed without a published blueprint. Returns null when it does not qualify.
 */
async function linkableParent(ctx: PluginContext, companyId: string, parentIssueId: string, site: string, nowMs: number): Promise<BlueprintJob | null> {
  const parentIssue = await ctx.issues.get(parentIssueId, companyId);
  if (!parentIssue) return null;
  const parent = await readJob(ctx, parentIssueId);
  if (!parent || parent.companyId !== companyId || parent.site !== site) return null;
  if (deriveOutcome(parent, { now: nowMs, issueStatus: parentIssue.status }) === "failed") return null;
  return parent;
}

async function linkFollowup(
  ctx: PluginContext,
  input: { companyId: string; parentIssueId: string; site: string; followupId: string; issueId: string; startedAt: string; onlyIfAbsent?: boolean },
): Promise<void> {
  try {
    await withLock(jobLockKey(input.parentIssueId), async () => {
      const parent = await linkableParent(ctx, input.companyId, input.parentIssueId, input.site, Date.parse(input.startedAt));
      if (!parent) return;
      if (input.onlyIfAbsent && parent.followups?.[input.followupId]) return;
      const updated: BlueprintJob = {
        ...parent,
        followups: { ...(parent.followups ?? {}), [input.followupId]: { issueId: input.issueId, startedAt: input.startedAt } },
        // Linking a follow-up is not progress on the blueprint: keep the stall clock.
        updatedAt: parent.updatedAt,
      };
      await saveJob(ctx, updated, "Linked a growth follow-up task", revisionOf(parent));
    });
  } catch (error) {
    ctx.logger.warn("Growth follow-up task created but not linked to its blueprint", {
      issueId: input.issueId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export async function startFollowup(
  ctx: PluginContext,
  input: { companyId: string; followupId: unknown; site: unknown; parentIssueId?: unknown; now?: Date },
): Promise<StartResult> {
  const definition = findJob(input.followupId);
  if (!definition || definition.kind !== "followup") {
    return { ok: false, reason: "unknown_followup", message: "That follow-up task is not available." };
  }
  const site = normalizeSite(input.site);
  if (!site) return { ok: false, reason: "invalid_site", message: "Enter a public website, for example example.com." };
  const now = input.now ?? new Date();
  const { companyId } = input;

  const parentIssueId = stringField(input.parentIssueId);
  const parent = parentIssueId ? await linkableParent(ctx, companyId, parentIssueId, site, now.getTime()) : null;
  if (parentIssueId && !parent) {
    return {
      ok: false,
      reason: "invalid_parent",
      message: "That blueprint task is for another website or has closed. Start the follow-up from an open blueprint for the same site.",
    };
  }

  // A follow-up uses the mode of the blueprint it came from, and one with no
  // blueprint behind it is free. A free and a paid follow-up for one site are
  // different tasks, so the mode is part of the dedupe key. An entry with no
  // mode ran as full.
  const followupMode: BlueprintMode = parent ? jobMode(parent) : "free";

  return withLock(`start:${companyId}:followup:${definition.id}:${followupMode}:${site}`, async (): Promise<StartResult> => {
    const duplicate = await findActiveDuplicate(
      ctx,
      companyId,
      (entry) => entry.kind === "followup" && entry.followupId === definition.id && entry.site === site && (entry.mode ?? "full") === followupMode,
      now.getTime(),
    );
    if (duplicate) {
      // Link the follow-up to the blueprint that asked for it too, so that
      // blueprint shows the task instead of offering it again.
      if (parentIssueId) {
        await linkFollowup(ctx, {
          companyId,
          parentIssueId,
          site,
          followupId: definition.id,
          issueId: duplicate.issue.id,
          startedAt: duplicate.entry.startedAt,
          onlyIfAbsent: true,
        });
      }
      return { ok: true, deduped: true, issueId: duplicate.issue.id, identifier: duplicate.issue.identifier ?? null, job: null };
    }

    const prepared = await prepareAgentAndProject(ctx, companyId);
    if ("error" in prepared) return prepared.error!;

    const jobId = await jobIdFor(site, now, definition.id);
    // A follow-up uses the data its blueprint was allowed. One with no
    // blueprint behind it spends nothing.
    const prompt = parent
      ? buildFollowupPrompt(definition, site, { mode: followupMode, capUsd: parent.capUsd })
      : buildFollowupPrompt(definition, site, { mode: followupMode });
    const issue = await ctx.issues.create({
      companyId,
      projectId: prepared.projectId,
      title: prompt.title,
      description: prompt.description,
      status: "todo",
      priority: "medium",
      assigneeAgentId: prepared.agent.id,
      originKind: `plugin:${PLUGIN_ID}:followup`,
      originId: jobId,
      billingCode: `plugin-${PLUGIN_ID}`,
    });
    await addToIndex(ctx, companyId, {
      issueId: issue.id,
      jobId,
      site,
      kind: "followup",
      followupId: definition.id,
      mode: followupMode,
      startedAt: now.toISOString(),
    });
    await ctx.activity.log({
      companyId,
      message: "Started a growth follow-up task",
      entityType: "issue",
      entityId: issue.id,
      metadata: { jobId, followupId: definition.id },
    });

    // Record the follow-up on the blueprint it came from.
    if (parentIssueId) {
      await linkFollowup(ctx, { companyId, parentIssueId, site, followupId: definition.id, issueId: issue.id, startedAt: now.toISOString() });
    }

    await wake(ctx, issue.id, companyId, jobId);
    return { ok: true, deduped: false, issueId: issue.id, identifier: issue.identifier ?? null, job: null };
  });
}

// ---------------------------------------------------------------------------
// report_step
// ---------------------------------------------------------------------------

function isHtmlContentType(contentType: string | null | undefined): boolean {
  return (contentType ?? "").split(";")[0]!.trim().toLowerCase() === "text/html";
}

/** Allowed clock difference between the host's attachment time and the worker's job start. */
const ATTACHMENT_CLOCK_SKEW_MS = 5_000;

function timeOf(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  return typeof value === "string" ? Date.parse(value) : Number.NaN;
}

/**
 * The attachment must be on this task, declared text/html, uploaded by the
 * task's Growth agent, and uploaded after the task started. A file a person
 * attached, or one from before the run, does not count as the blueprint.
 */
async function verifyHtmlAttachment(
  ctx: PluginContext,
  job: BlueprintJob,
  attachmentId: string,
): Promise<BlueprintArtifact | string> {
  const { issueId, companyId } = job;
  const attachments = await ctx.issues.listAttachments(issueId, companyId);
  const attachment = attachments.find((item) => item.id === attachmentId);
  if (!attachment || attachment.issueId !== issueId || attachment.companyId !== companyId) {
    return `No attachment ${attachmentId} on this task. Attach blueprint.html to this task, then report published with the id you got back.`;
  }
  if (!isHtmlContentType(attachment.contentType)) {
    return `Attachment ${attachmentId} is ${attachment.contentType}, not text/html. Attach the rendered blueprint.html.`;
  }
  if (attachment.createdByAgentId !== job.agentId) {
    return `Attachment ${attachmentId} was not uploaded by Growth on this task. Upload the blueprint.html you rendered in this run and report that id.`;
  }
  const uploadedMs = timeOf(attachment.createdAt);
  const startedMs = Date.parse(job.startedAt);
  if (!Number.isFinite(uploadedMs) || uploadedMs + ATTACHMENT_CLOCK_SKEW_MS < startedMs) {
    return `Attachment ${attachmentId} was uploaded before this task started. Upload the blueprint.html you rendered for this task and report that id.`;
  }
  return {
    attachmentId: attachment.id,
    filename: attachment.originalFilename ?? "blueprint.html",
    contentType: "text/html",
    byteSize: attachment.byteSize,
  };
}

function toolError(error: string): ToolResult {
  return { error };
}

export async function handleReportStep(ctx: PluginContext, rawParams: unknown, runCtx: ToolRunContext, now: Date = new Date()): Promise<ToolResult> {
  // Identity comes only from the host-verified run context.
  const issueId = stringField(runCtx.issueId);
  const companyId = stringField(runCtx.companyId);
  const agentId = stringField(runCtx.agentId);
  if (!issueId || !companyId || !agentId) {
    return toolError("report_step only works inside a run that is bound to a task.");
  }

  const validation = validateReportStepParams(rawParams);
  if (!validation.ok) return toolError(validation.error);
  const report = validation.value;

  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return toolError("The task bound to this run was not found.");

  // One report at a time per task: read, check and write the job inside the lock.
  try {
    return await withLock(jobLockKey(issueId), () => applyReport(ctx, { issueId, companyId, agentId }, report, now));
  } catch (error) {
    if (error instanceof StaleJobError) {
      return toolError("This task's progress changed while the step was being saved. Call report_step again.");
    }
    throw error;
  }
}

async function isFollowupTask(ctx: PluginContext, companyId: string, issueId: string): Promise<boolean> {
  if ((await readIndex(ctx, companyId)).some((entry) => entry.issueId === issueId && entry.kind === "followup")) return true;
  const issue = await ctx.issues.get(issueId, companyId);
  return typeof issue?.originKind === "string" && issue.originKind === `plugin:${PLUGIN_ID}:followup`;
}

async function applyReport(
  ctx: PluginContext,
  run: { issueId: string; companyId: string; agentId: string },
  report: ReportStepParams,
  now: Date,
): Promise<ToolResult> {
  const { issueId, companyId, agentId } = run;
  const stored = await readJob(ctx, issueId);
  let job = stored;
  if (job && job.companyId !== companyId) return toolError("The task bound to this run belongs to another company.");
  if (job && job.agentId !== agentId) {
    return toolError("Only the agent assigned to this blueprint task can report its steps.");
  }
  if (!job) {
    // A chat with Growth can start a blueprint without the page: adopt the
    // task on the first report, but only for the managed Growth agent.
    // A follow-up task is not a blueprint and is never adopted as one.
    if (await isFollowupTask(ctx, companyId, issueId)) {
      return toolError("This task is a follow-up, not a growth blueprint. Do not call report_step on it; say what you found in a comment on the task.");
    }
    const growth = await ctx.agents.managed.get(GROWTH_AGENT_KEY, companyId);
    if (!growth.agentId || growth.agentId !== agentId) {
      return toolError("report_step is reserved for the Growth agent.");
    }
    job = createJob({
      jobId: await jobIdFor(report.site, now),
      companyId,
      issueId,
      agentId,
      site: report.site,
      now: now.toISOString(),
      // A task adopted from a chat has no mode line from the page, so the first
      // report may state the run's mode. With none, the task is full as before modes.
      ...(report.mode ? { mode: report.mode } : {}),
    });
  }
  const created = stored === null;

  // The mode is fixed when the job is created: a later report cannot change it.
  if (report.mode && report.mode !== jobMode(job)) {
    return toolError(`This task runs in ${jobMode(job)} mode and its mode cannot change. Follow ${jobMode(job)} mode, or leave mode out of report_step.`);
  }

  if (report.site !== job.site) {
    return toolError(`This task is for ${job.site}, not ${report.site}. Report the task's own website.`);
  }

  let artifact: BlueprintArtifact | undefined;
  if (report.step === "published" && job.outcome !== "ready") {
    const verified = await verifyHtmlAttachment(ctx, job, report.attachmentId!);
    if (typeof verified === "string") return toolError(verified);
    artifact = verified;
  }

  const result = advanceJob(job, report, now.toISOString(), artifact);
  if (!result.ok) return toolError(result.error);

  let saved = result.job;
  if (result.changed || created) {
    const message = result.job.outcome === "ready"
      ? "Growth blueprint published"
      : result.job.outcome === "blocked"
        ? "Growth blueprint blocked"
        : "Growth blueprint step updated";
    saved = await saveJob(ctx, result.job, message, revisionOf(stored));
  }
  if (created) {
    await addToIndex(ctx, companyId, {
      issueId,
      jobId: saved.jobId,
      site: saved.site,
      kind: "blueprint",
      ...(saved.mode ? { mode: saved.mode } : {}),
      startedAt: saved.startedAt,
    });
  }

  const step = currentStep(saved);
  const mode = jobMode(saved);
  const overCap = isOverCap(saved);
  const recorded = saved.outcome === "ready"
    ? `Published. The blueprint for ${saved.site} is ready to view on this task.`
    : saved.outcome === "blocked"
      ? `Recorded as blocked at ${step}. Say on the task what you need, then continue when it is fixed.`
      : `Recorded ${step} for ${saved.site}.`;
  const settings = mode === "free"
    ? "Stored mode: free, no data spend."
    : `Stored mode: ${mode}, data cap ${formatUsd(saved.capUsd)}.`;
  const warning = overCap
    ? ` Spend ${formatUsd(saved.spentUsd)} is over the data cap. Make no more billed calls and finish with the data you have.`
    : "";
  return {
    content: `${recorded} ${settings}${warning}`,
    data: { jobId: saved.jobId, step, outcome: saved.outcome, changed: result.changed || created, mode, capUsd: saved.capUsd, overCap },
  };
}

// ---------------------------------------------------------------------------
// Run lifecycle events
// ---------------------------------------------------------------------------

const RUN_EVENT_TYPES: readonly RunLifecycleEventType[] = [
  "agent.run.started",
  "agent.run.finished",
  "agent.run.failed",
  "agent.run.cancelled",
];

/**
 * Fold a host run lifecycle event into the job of the task it ran on, so
 * progress does not depend on the agent calling report_step. Events for other
 * companies, other agents, follow-up tasks and unknown tasks change nothing.
 */
export async function handleRunEvent(
  ctx: PluginContext,
  type: RunLifecycleEventType,
  event: { companyId: string; entityId?: string | null; payload?: unknown },
  now: Date = new Date(),
): Promise<void> {
  const payload = (event.payload && typeof event.payload === "object" ? event.payload : {}) as Record<string, unknown>;
  const issueId = stringField(payload.issueId);
  const agentId = stringField(payload.agentId);
  const companyId = stringField(event.companyId);
  if (!issueId || !agentId || !companyId) return;
  const runId = stringField(payload.runId) ?? stringField(event.entityId);
  const errorCode = stringField(payload.errorCode);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await withLock(jobLockKey(issueId), async () => {
        const job = await readJob(ctx, issueId);
        if (!job || job.companyId !== companyId || job.agentId !== agentId) return;
        const entry = (await readIndex(ctx, companyId)).find((item) => item.issueId === issueId);
        if (!entry || entry.kind !== "blueprint") return;
        const result = applyRunLifecycle(job, { type, runId, errorCode }, now.toISOString());
        if (!result.changed) return;
        const message = type === "agent.run.started" ? "Growth run started"
          : type === "agent.run.finished" ? "Growth run finished without a blueprint"
          : type === "agent.run.cancelled" ? "Growth run cancelled"
          : "Growth run failed";
        await saveJob(ctx, result.job, message, revisionOf(job));
      });
      return;
    } catch (error) {
      if (error instanceof StaleJobError && attempt < 2) continue;
      ctx.logger.warn("Growth run event was not applied", { issueId, type, error: error instanceof Error ? error.name : "error" });
      return;
    }
  }
}

// ---------------------------------------------------------------------------
// Data views
// ---------------------------------------------------------------------------

/**
 * The newest comment by `createdAt`, whichever order the host lists them in
 * (it returns newest first). Comments without a readable time lose to ones
 * with a time; on a tie the earlier entry in the list wins.
 */
export function newestComment<T extends { createdAt?: unknown }>(comments: readonly T[]): T | null {
  let best: T | null = null;
  let bestTime = Number.NEGATIVE_INFINITY;
  for (const comment of comments) {
    const time = timeOf(comment.createdAt);
    const value = Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
    if (best === null || value > bestTime) {
      best = comment;
      bestTime = value;
    }
  }
  return best;
}

async function viewFor(ctx: PluginContext, companyId: string, issueId: string, withComments: boolean): Promise<JobView | null> {
  const issue = await ctx.issues.get(issueId, companyId);
  if (!issue) return null;
  const job = await readJob(ctx, issueId);
  if (!job || job.companyId !== companyId) return null;
  let agentAskedQuestion = false;
  if (withComments) {
    const comments = await ctx.issues.listComments(issueId, companyId);
    const latest = newestComment(comments);
    agentAskedQuestion = Boolean(latest && latest.authorAgentId === job.agentId && textEndsInQuestion(latest.body));
  }
  return {
    job,
    outcome: deriveOutcome(job, { now: Date.now(), issueStatus: issue.status, agentAskedQuestion }),
    agentAskedQuestion,
    task: { id: issue.id, identifier: issue.identifier ?? null, title: issue.title, status: issue.status },
  };
}

export interface RecentTask {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  site: string;
  kind: "blueprint" | "followup";
  /** Blueprint tasks only. */
  mode: BlueprintMode | null;
  startedAt: string;
  outcome: BlueprintOutcome | null;
}

async function listRecent(ctx: PluginContext, companyId: string, limit: number): Promise<RecentTask[]> {
  const out: RecentTask[] = [];
  for (const entry of (await readIndex(ctx, companyId)).slice(0, limit)) {
    const issue = await ctx.issues.get(entry.issueId, companyId);
    if (!issue) continue;
    const job = entry.kind === "blueprint" ? await readJob(ctx, entry.issueId) : null;
    out.push({
      issueId: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
      status: issue.status,
      site: entry.site,
      kind: entry.kind,
      mode: job ? jobMode(job) : null,
      startedAt: entry.startedAt,
      outcome: job ? deriveOutcome(job, { now: Date.now(), issueStatus: issue.status }) : null,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin = definePlugin({
  async setup(ctx) {
    const toolDeclaration = manifest.tools?.find((tool) => tool.name === REPORT_STEP_TOOL);
    ctx.tools.register(
      REPORT_STEP_TOOL,
      {
        displayName: toolDeclaration?.displayName ?? "Report blueprint step",
        description: toolDeclaration?.description ?? "Report growth blueprint progress for the task bound to this run.",
        parametersSchema: toolDeclaration?.parametersSchema ?? { type: "object" },
      },
      async (params, runCtx) => handleReportStep(ctx, params, runCtx),
    );

    ctx.actions.register("start", async (params, context) => {
      const companyId = companyFrom(params, context.companyId);
      return startBlueprint(ctx, { companyId, site: params.site, mode: params.mode, capUsd: params.capUsd });
    });

    ctx.actions.register("start-followup", async (params, context) => {
      const companyId = companyFrom(params, context.companyId);
      return startFollowup(ctx, {
        companyId,
        followupId: params.followupId,
        site: params.site,
        parentIssueId: params.parentIssueId,
      });
    });

    ctx.data.register("job", async (params) => {
      const companyId = stringField(params.companyId);
      const issueId = stringField(params.issueId);
      if (!companyId || !issueId) return null;
      return viewFor(ctx, companyId, issueId, true);
    });

    ctx.data.register("jobs", async (params) => {
      const companyId = stringField(params.companyId);
      if (!companyId) return { tasks: [] };
      const limit = typeof params.limit === "number" && params.limit > 0 ? Math.min(params.limit, JOB_INDEX_LIMIT) : 10;
      return { tasks: await listRecent(ctx, companyId, limit) };
    });

    for (const type of RUN_EVENT_TYPES) {
      ctx.events.on(type, async (event) => handleRunEvent(ctx, type, event));
    }

    // Task status changes (closed, waiting on a person) change the derived
    // outcome; re-send the job so open pages refresh without polling.
    ctx.events.on("issue.updated", async (event) => {
      const issueId = event.entityId ?? stringField((event.payload as Record<string, unknown> | null)?.id);
      if (!issueId) return;
      const job = await readJob(ctx, issueId);
      if (!job || job.companyId !== event.companyId) return;
      emitJob(ctx, job);
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Growth blueprint worker is running",
      details: { steps: [...BLUEPRINT_STEPS], blueprintJob: BLUEPRINT_JOB_ID },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
