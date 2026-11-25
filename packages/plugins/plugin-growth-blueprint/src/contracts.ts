// Shared contract for the growth blueprint plugin. Imported by the worker and
// the UI bundle, so it must stay free of Node-only modules.

export const PLUGIN_ID = "growth-blueprint";
export const PLUGIN_VERSION = "0.1.0";

export const GROWTH_AGENT_KEY = "growth";
export const GROWTH_PROJECT_KEY = "growth-blueprints";
export const GROWTH_SKILL_KEY = "growth-blueprint";
export const REPORT_STEP_TOOL = "report_step";
export const PROGRESS_STREAM_CHANNEL = "blueprint-progress";
export const STATE_NAMESPACE = "growth-blueprint";
export const JOB_STATE_KEY = "job";
export const JOB_INDEX_STATE_KEY = "jobs";
export const JOB_SCHEMA = "growth-blueprint/job@1" as const;

/** Treg spend cap of a full blueprint task, in US dollars. Enforced by the skill. */
export const DEFAULT_CAP_USD = 3;

/** How much data a blueprint run may use. Free makes no Treg calls at all. */
export const BLUEPRINT_MODES = ["free", "quick", "full"] as const;
export type BlueprintMode = (typeof BLUEPRINT_MODES)[number];
/** The mode a new task starts in when the start form does not say. */
export const DEFAULT_MODE: BlueprintMode = "free";
/** A stored job with no mode predates modes and ran as a full blueprint. */
export const LEGACY_MODE: BlueprintMode = "full";
/** The data cap each mode starts with, in US dollars. Free is always 0. */
export const MODE_DEFAULT_CAP_USD: Record<BlueprintMode, number> = { free: 0, quick: 0.6, full: DEFAULT_CAP_USD };
/** The most a person can set as a data cap for a quick or full task. */
export const MAX_CAP_USD = 10;
/** A second start for the same site inside this window returns the active task. */
export const DEDUPE_WINDOW_MS = 30 * 60 * 1000;
/** A running task with no update for this long is shown as stalled. */
export const STALL_AFTER_MS = 15 * 60 * 1000;
export const DETAIL_MAX_CHARS = 140;
export const RUN_STARTED_DETAIL = "Growth started working";
export const JOB_INDEX_LIMIT = 50;

export const BLUEPRINT_STEPS = ["computer", "reading", "signals", "building", "published"] as const;
export type BlueprintStep = (typeof BLUEPRINT_STEPS)[number];

/** `computer` is never agent-reported: it covers queueing and workspace start. */
export const AGENT_REPORTED_STEPS = ["reading", "signals", "building", "published"] as const;
export type AgentReportedStep = (typeof AGENT_REPORTED_STEPS)[number];

export const BLOCK_REASONS = ["treg_missing", "budget", "site_unreachable"] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];

export type BlueprintOutcome = "running" | "asked" | "blocked" | "stalled" | "failed" | "unpublished" | "ready";

/** How the agent's latest run ended without a published blueprint. Enums and ids only. */
export const RUN_END_STATUSES = ["failed", "cancelled", "succeeded_unpublished"] as const;
export type RunEndStatus = (typeof RUN_END_STATUSES)[number];

export interface BlueprintRunEnded {
  status: RunEndStatus;
  at: string;
  errorCode?: string;
}
export type StepStatus = "pending" | "active" | "done";
export type StepRowState = "done" | "active" | "pending" | "blocked" | "stalled" | "failed";

export function isBlueprintMode(value: unknown): value is BlueprintMode {
  return typeof value === "string" && (BLUEPRINT_MODES as readonly string[]).includes(value);
}

export interface ReportStepParams {
  step: AgentReportedStep;
  /** Normalized host. Must equal the task's site or the call is rejected. */
  site: string;
  /** Plain text, at most 140 characters, shown under the step. */
  detail?: string;
  /** Treg spend so far in US dollars. Shown against the data cap. A free task spends nothing, so a free task rejects a value above 0. */
  spentUsd?: number;
  blocked?: BlockReason;
  /** Required when `step` is `published`. */
  attachmentId?: string;
  /**
   * The run's mode. Only the first report of a task the page did not start (a
   * chat) can set it, because that report creates the job. On a task that
   * already has a job it must match the stored mode.
   */
  mode?: BlueprintMode;
}

export interface BlueprintStepState {
  status: StepStatus;
  at?: string;
  detail?: string;
}

export interface BlueprintArtifact {
  attachmentId: string;
  filename: string;
  contentType: "text/html";
  byteSize: number;
}

/** Plugin state, scope `issue` (the task), namespace `growth-blueprint`, key `job`. */
export interface BlueprintJob {
  schema: typeof JOB_SCHEMA;
  jobId: string;
  companyId: string;
  issueId: string;
  agentId: string;
  site: string;
  /** Absent on tasks started before modes existed: read it with `jobMode`, which treats those as full. */
  mode?: BlueprintMode;
  startedAt: string;
  updatedAt: string;
  steps: Record<BlueprintStep, BlueprintStepState>;
  outcome: BlueprintOutcome;
  blocked?: BlockReason;
  /** Data cap in US dollars. 0 for a free task. */
  capUsd: number;
  spentUsd?: number;
  artifact?: BlueprintArtifact;
  /** Latest host run id seen for this task (from run lifecycle events). */
  lastRunId?: string;
  /** Set when the latest run ended without a published blueprint; cleared when a run starts. */
  runEnded?: BlueprintRunEnded;
  /** Follow-up tasks started from the "While you wait" column, keyed by follow-up id. */
  followups?: Record<string, { issueId: string; startedAt: string }>;
  /** Bumped on every save. A write is refused when the stored revision moved since the read. */
  revision?: number;
}

/** Event on the company-scoped `blueprint-progress` stream. */
export interface BlueprintProgressEvent {
  type: "job.updated";
  job: BlueprintJob;
}

/** The mode a job runs in. Jobs saved before modes existed ran as full. */
export function jobMode(job: Pick<BlueprintJob, "mode">): BlueprintMode {
  return isBlueprintMode(job.mode) ? job.mode : LEGACY_MODE;
}

export const STEP_LABELS: Record<BlueprintStep, (site: string, mode?: BlueprintMode) => string> = {
  computer: () => "Preparing a workspace",
  reading: (site) => `Scanning the public pages of ${site}`,
  signals: (_site, mode) => (mode === "free" ? "Pulling free public sources" : "Collecting traffic and channel data"),
  building: () => "Writing the plan",
  published: () => "Ready to view",
};

export const BLOCK_REASON_TEXT: Record<BlockReason, string> = {
  treg_missing: "Treg is not connected. Connect it in Apps, then reply on the task.",
  // The stored cap does not change when someone replies, so a higher cap means a new task.
  budget: "The data cap for this task is used up. Reply on the task to ask Growth to finish with what it has, or start a new task with a higher data cap.",
  site_unreachable: "The website could not be reached. Check the address and start again.",
};

export const FREE_MODE_NO_TREG_TEXT = "This is a free task: it makes no Treg calls, so it can never be blocked on Treg or on a data cap.";

/** A paid task whose reported spend passed its stored data cap. A free task never counts. */
export function isOverCap(job: Pick<BlueprintJob, "mode" | "capUsd" | "spentUsd">): boolean {
  return jobMode(job) !== "free" && (job.spentUsd ?? 0) > job.capUsd;
}

export function stepIndex(step: BlueprintStep): number {
  return BLUEPRINT_STEPS.indexOf(step);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Site normalization
// ---------------------------------------------------------------------------

const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const TLD_RE = /^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/;

/**
 * Reduce user input such as `https://www.Example.com/pricing?x=1` to a bare
 * public host (`example.com`). Returns null for anything that is not a
 * public domain name: IP addresses, localhost, single labels, credentials.
 */
export function normalizeSite(input: unknown): string | null {
  if (typeof input !== "string") return null;
  let value = input.trim().toLowerCase();
  if (!value || value.length > 2048 || /\s/.test(value)) return null;
  value = value.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  value = value.replace(/^\/\//, "");
  const cut = value.search(/[/?#]/);
  if (cut >= 0) value = value.slice(0, cut);
  if (value.includes("@")) return null;
  if (value.startsWith("[")) return null;
  value = value.replace(/:\d{1,5}$/, "");
  value = value.replace(/\.$/, "");
  if (value.startsWith("www.")) value = value.slice(4);
  if (!value || value.length > 253) return null;
  const labels = value.split(".");
  if (labels.length < 2) return null;
  if (!labels.every((label) => LABEL_RE.test(label))) return null;
  const tld = labels[labels.length - 1]!;
  if (!TLD_RE.test(tld)) return null;
  return value;
}

// ---------------------------------------------------------------------------
// Start options: mode and data cap
// ---------------------------------------------------------------------------

export interface StartOptions {
  mode: BlueprintMode;
  capUsd: number;
}

export type StartOptionsResult =
  | { ok: true; value: StartOptions }
  | { ok: false; reason: "invalid_mode" | "invalid_cap"; message: string };

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "");
}

/**
 * Validate the mode and data cap from the start form. A missing mode is free.
 * A missing cap is the mode's default. Free is always 0 whatever the cap says.
 * Quick and full need a number above 0 and at most MAX_CAP_USD.
 */
export function validateStartOptions(rawMode: unknown, rawCap: unknown): StartOptionsResult {
  let mode: BlueprintMode = DEFAULT_MODE;
  if (!isBlank(rawMode)) {
    const text = typeof rawMode === "string" ? rawMode.trim() : null;
    if (!isBlueprintMode(text)) {
      return { ok: false, reason: "invalid_mode", message: "Choose Free, Quick or Full." };
    }
    mode = text;
  }
  if (mode === "free") return { ok: true, value: { mode, capUsd: 0 } };
  if (isBlank(rawCap)) return { ok: true, value: { mode, capUsd: MODE_DEFAULT_CAP_USD[mode] } };
  const cap = typeof rawCap === "number" ? rawCap : Number.NaN;
  if (!Number.isFinite(cap) || cap <= 0 || cap > MAX_CAP_USD) {
    return { ok: false, reason: "invalid_cap", message: `Enter a data cap above $0 and up to ${formatUsd(MAX_CAP_USD)}.` };
  }
  const rounded = Math.round(cap * 100) / 100;
  if (rounded <= 0) {
    return { ok: false, reason: "invalid_cap", message: `Enter a data cap above $0 and up to ${formatUsd(MAX_CAP_USD)}.` };
  }
  return { ok: true, value: { mode, capUsd: rounded } };
}

// ---------------------------------------------------------------------------
// report_step parameter validation
// ---------------------------------------------------------------------------

export type ValidationResult<T> = { ok: true; value: T } | { ok: false; error: string };

function cleanDetail(value: string): string {
  // Plain text only: drop control characters and collapse whitespace.
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * Validate agent-supplied `report_step` arguments. Task, agent and company
 * identity never come from here: the worker reads them from the run context.
 */
export function validateReportStepParams(raw: unknown): ValidationResult<ReportStepParams> {
  if (!isRecord(raw)) return { ok: false, error: "report_step expects an object of arguments." };
  const step = raw.step;
  if (typeof step !== "string" || !(AGENT_REPORTED_STEPS as readonly string[]).includes(step)) {
    return { ok: false, error: `step must be one of: ${AGENT_REPORTED_STEPS.join(", ")}.` };
  }
  const site = normalizeSite(raw.site);
  if (!site) return { ok: false, error: "site must be the task's website, for example example.com." };
  const value: ReportStepParams = { step: step as AgentReportedStep, site };

  if (raw.detail !== undefined && raw.detail !== null) {
    if (typeof raw.detail !== "string") return { ok: false, error: "detail must be plain text." };
    const detail = cleanDetail(raw.detail);
    if (detail.length > DETAIL_MAX_CHARS) {
      return { ok: false, error: `detail must be at most ${DETAIL_MAX_CHARS} characters.` };
    }
    if (detail) value.detail = detail;
  }

  if (raw.spentUsd !== undefined && raw.spentUsd !== null) {
    if (typeof raw.spentUsd !== "number" || !Number.isFinite(raw.spentUsd) || raw.spentUsd < 0 || raw.spentUsd > 10_000) {
      return { ok: false, error: "spentUsd must be a number of dollars between 0 and 10000." };
    }
    value.spentUsd = Math.round(raw.spentUsd * 100) / 100;
  }

  if (raw.blocked !== undefined && raw.blocked !== null) {
    if (typeof raw.blocked !== "string" || !(BLOCK_REASONS as readonly string[]).includes(raw.blocked)) {
      return { ok: false, error: `blocked must be one of: ${BLOCK_REASONS.join(", ")}.` };
    }
    value.blocked = raw.blocked as BlockReason;
  }

  if (raw.mode !== undefined && raw.mode !== null) {
    if (!isBlueprintMode(raw.mode)) {
      return { ok: false, error: `mode must be one of: ${BLUEPRINT_MODES.join(", ")}.` };
    }
    value.mode = raw.mode;
  }

  if (raw.attachmentId !== undefined && raw.attachmentId !== null) {
    if (typeof raw.attachmentId !== "string" || !raw.attachmentId.trim() || raw.attachmentId.length > 200) {
      return { ok: false, error: "attachmentId must be the id returned by the attachment upload." };
    }
    value.attachmentId = raw.attachmentId.trim();
  }

  if (value.step === "published") {
    if (!value.attachmentId) {
      return { ok: false, error: "published needs attachmentId: attach blueprint.html to the task first." };
    }
    if (value.blocked) return { ok: false, error: "published cannot also be blocked." };
  }
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Job state machine
// ---------------------------------------------------------------------------

export function createJob(input: {
  jobId: string;
  companyId: string;
  issueId: string;
  agentId: string;
  site: string;
  now: string;
  /** Leave out for a job with no mode (it is read as full). */
  mode?: BlueprintMode;
  capUsd?: number;
}): BlueprintJob {
  const capUsd = input.mode === "free" ? 0 : input.capUsd ?? (input.mode ? MODE_DEFAULT_CAP_USD[input.mode] : DEFAULT_CAP_USD);
  return {
    schema: JOB_SCHEMA,
    jobId: input.jobId,
    companyId: input.companyId,
    issueId: input.issueId,
    agentId: input.agentId,
    site: input.site,
    ...(input.mode ? { mode: input.mode } : {}),
    startedAt: input.now,
    updatedAt: input.now,
    steps: {
      computer: { status: "active", at: input.now },
      reading: { status: "pending" },
      signals: { status: "pending" },
      building: { status: "pending" },
      published: { status: "pending" },
    },
    outcome: "running",
    capUsd,
    revision: 0,
  };
}

export function currentStep(job: BlueprintJob): BlueprintStep {
  let latest: BlueprintStep = "computer";
  for (const step of BLUEPRINT_STEPS) {
    if (job.steps[step].status !== "pending") latest = step;
  }
  return latest;
}

export type AdvanceResult =
  | { ok: true; job: BlueprintJob; changed: boolean }
  | { ok: false; error: string };

/**
 * Apply one validated report to a job. Steps only move forward; a repeated
 * step updates its detail; a later step marks every earlier step done.
 * `published` must carry the artifact the worker verified on the task.
 */
export function advanceJob(
  job: BlueprintJob,
  report: ReportStepParams,
  now: string,
  artifact?: BlueprintArtifact,
): AdvanceResult {
  if (report.site !== job.site) {
    return { ok: false, error: `This task is for ${job.site}, not ${report.site}.` };
  }
  if (job.outcome === "ready") {
    if (report.step === "published" && report.attachmentId === job.artifact?.attachmentId) {
      return { ok: true, job, changed: false };
    }
    return { ok: false, error: "This blueprint is already published. Start a new task to make another." };
  }
  const current = currentStep(job);
  const target = report.step;
  if (stepIndex(target) < stepIndex(current)) {
    return { ok: false, error: `Steps only move forward: this task is already at ${current}.` };
  }
  if (target === "published" && !artifact) {
    return { ok: false, error: "published needs a verified HTML attachment on this task." };
  }
  const free = jobMode(job) === "free";
  if (free && (report.blocked === "treg_missing" || report.blocked === "budget")) {
    return { ok: false, error: `${FREE_MODE_NO_TREG_TEXT} Do not report blocked ${report.blocked}: follow the playbook's free mode and keep going.` };
  }
  // A reported spend on a free task is evidence that paid data was used, so it
  // is refused out loud instead of dropped.
  if (free && report.spentUsd !== undefined && report.spentUsd > 0) {
    return { ok: false, error: `${FREE_MODE_NO_TREG_TEXT} Do not report spentUsd on this task, and stop any Treg calls: follow the playbook's free mode.` };
  }

  const next: BlueprintJob = {
    ...job,
    steps: Object.fromEntries(BLUEPRINT_STEPS.map((step) => [step, { ...job.steps[step] }])) as BlueprintJob["steps"],
  };

  if (stepIndex(target) > stepIndex(current)) {
    for (const step of BLUEPRINT_STEPS) {
      const index = stepIndex(step);
      if (index < stepIndex(target) && next.steps[step].status !== "done") {
        next.steps[step] = { ...next.steps[step], status: "done", at: next.steps[step].at ?? now };
      }
    }
    next.steps[target] = { status: target === "published" ? "done" : "active", at: now };
  }
  if (report.detail !== undefined) next.steps[target] = { ...next.steps[target], detail: report.detail };

  // A free task has no spend to record (a spend above 0 was refused above).
  // A paid task keeps the reported spend even when it passes the cap: `isOverCap` shows it.
  if (report.spentUsd !== undefined && !free) next.spentUsd = Math.max(job.spentUsd ?? 0, report.spentUsd);

  if (target === "published" && artifact) {
    next.artifact = artifact;
    next.outcome = "ready";
    delete next.blocked;
  } else if (report.blocked) {
    next.outcome = "blocked";
    next.blocked = report.blocked;
  } else {
    next.outcome = "running";
    delete next.blocked;
  }

  const changed = JSON.stringify({ ...next, updatedAt: "" }) !== JSON.stringify({ ...job, updatedAt: "" });
  if (changed) next.updatedAt = now;
  return { ok: true, job: changed ? next : job, changed };
}

// ---------------------------------------------------------------------------
// Derived outcome and row states (used by the data handlers and the UI)
// ---------------------------------------------------------------------------

export interface OutcomeSignals {
  now: number;
  /** The task's status, when known. */
  issueStatus?: string | null;
  /** The assigned agent's latest comment ends in a question. */
  agentAskedQuestion?: boolean;
}

export function deriveOutcome(job: BlueprintJob, signals: OutcomeSignals): BlueprintOutcome {
  if (job.outcome === "ready") return "ready";
  if (signals.issueStatus === "done" || signals.issueStatus === "cancelled") return "failed";
  if (job.runEnded && job.runEnded.status !== "succeeded_unpublished") return "failed";
  if (job.outcome === "blocked") return "blocked";
  if (signals.issueStatus === "in_review" || signals.issueStatus === "blocked" || signals.agentAskedQuestion) return "asked";
  if (job.runEnded) return "unpublished";
  const updated = Date.parse(job.updatedAt);
  if (Number.isFinite(updated) && signals.now - updated > STALL_AFTER_MS) return "stalled";
  return "running";
}

export function stepRowStates(job: BlueprintJob, outcome: BlueprintOutcome): Record<BlueprintStep, StepRowState> {
  const rows = {} as Record<BlueprintStep, StepRowState>;
  for (const step of BLUEPRINT_STEPS) {
    const status = job.steps[step].status;
    if (status !== "active") {
      rows[step] = status;
      continue;
    }
    rows[step] = outcome === "blocked" ? "blocked"
      : outcome === "stalled" ? "stalled"
      : outcome === "failed" || outcome === "unpublished" ? "failed"
      : "active";
  }
  return rows;
}

export type RunLifecycleEventType = "agent.run.started" | "agent.run.finished" | "agent.run.failed" | "agent.run.cancelled";

export type RunLifecycleResult = { job: BlueprintJob; changed: boolean };

/**
 * Apply a host run lifecycle event to a job. `started` moves a job that has
 * no report yet from `computer` to `reading` and clears any earlier run end;
 * an end event records how the run ended unless the blueprint is published or
 * the event belongs to an older run than the one already seen.
 */
export function applyRunLifecycle(
  job: BlueprintJob,
  event: { type: RunLifecycleEventType; runId: string | null; errorCode?: string | null },
  now: string,
): RunLifecycleResult {
  if (job.outcome === "ready" || job.steps.published.status === "done") return { job, changed: false };
  if (event.type === "agent.run.started") {
    const next: BlueprintJob = { ...job, steps: { ...job.steps } };
    if (event.runId) next.lastRunId = event.runId;
    delete next.runEnded;
    if (currentStep(job) === "computer") {
      next.steps.computer = { ...job.steps.computer, status: "done", at: job.steps.computer.at ?? now };
      next.steps.reading = { status: "active", at: now, detail: RUN_STARTED_DETAIL };
    }
    const changed = JSON.stringify({ ...next, updatedAt: "" }) !== JSON.stringify({ ...job, updatedAt: "" });
    if (!changed) return { job, changed: false };
    next.updatedAt = now;
    return { job: next, changed: true };
  }
  if (event.runId && job.lastRunId && event.runId !== job.lastRunId) return { job, changed: false };
  const status: RunEndStatus = event.type === "agent.run.finished" ? "succeeded_unpublished"
    : event.type === "agent.run.cancelled" ? "cancelled"
    : "failed";
  const runEnded: BlueprintRunEnded = { status, at: now };
  if (event.errorCode && /^[A-Za-z0-9_.-]{1,64}$/.test(event.errorCode)) runEnded.errorCode = event.errorCode;
  const prev = job.runEnded;
  if (prev && prev.status === runEnded.status && prev.errorCode === runEnded.errorCode) return { job, changed: false };
  return { job: { ...job, ...(event.runId ? { lastRunId: event.runId } : {}), runEnded, updatedAt: now }, changed: true };
}

export function textEndsInQuestion(body: string | null | undefined): boolean {
  if (!body) return false;
  return /\?\s*$/.test(body.replace(/[`*_~>\s]+$/g, ""));
}

export function isBlueprintJob(value: unknown): value is BlueprintJob {
  if (!isRecord(value) || value.schema !== JOB_SCHEMA) return false;
  if (typeof value.issueId !== "string" || typeof value.site !== "string" || typeof value.jobId !== "string") return false;
  if (!isRecord(value.steps)) return false;
  const steps = value.steps;
  return BLUEPRINT_STEPS.every((step) => isRecord(steps[step]));
}

/** Whole-dollar-and-cents display, e.g. `$0.42`. */
export function formatUsd(value: number | undefined): string {
  return `$${(value ?? 0).toFixed(2)}`;
}
