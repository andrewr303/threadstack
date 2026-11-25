import {
  usePluginAction,
  usePluginData,
  usePluginStream,
  useHostNavigation,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent, type ReactNode, type RefObject } from "react";
import {
  BLOCK_REASON_TEXT,
  BLUEPRINT_MODES,
  BLUEPRINT_STEPS,
  DEFAULT_MODE,
  MAX_CAP_USD,
  MODE_DEFAULT_CAP_USD,
  PROGRESS_STREAM_CHANNEL,
  STEP_LABELS,
  currentStep,
  deriveOutcome,
  formatUsd,
  isOverCap,
  jobMode,
  normalizeSite,
  stepRowStates,
  type BlueprintJob,
  type BlueprintMode,
  type BlueprintOutcome,
  type BlueprintProgressEvent,
  type BlueprintStep,
  type StepRowState,
} from "../contracts.js";
import { FOLLOWUP_JOBS, jobTitle, type JobDefinition } from "../jobs.js";
import type { JobView, RecentTask, StartResult } from "../worker.js";

// Styling uses the host's semantic Tailwind utilities and status tokens only.
// The focus ring matches the host Button and Input.
const focusRing = "outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-(length:--rad-3)";
const primaryButton = `inline-flex items-center justify-center rounded-md bg-primary px-3 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 ${focusRing}`;
const secondaryButton = `inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50 ${focusRing}`;
const quietButton = `inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-50 ${focusRing}`;
const textLink = `rounded-sm underline hover:text-foreground ${focusRing}`;
const inputClass = `w-full rounded-md border border-input bg-background px-3 py-2 text-base text-foreground md:text-sm aria-invalid:border-destructive ${focusRing}`;

const STATUS_COLOR: Record<StepRowState, CSSProperties> = {
  done: { color: "var(--status-task-icon-done)" },
  active: { color: "var(--status-task-icon-in_progress)" },
  pending: {},
  blocked: { color: "var(--status-task-icon-blocked)" },
  stalled: { color: "var(--status-task-icon-todo)" },
  failed: { color: "var(--status-task-icon-blocked)" },
};

const OUTCOME_LABEL: Record<BlueprintOutcome, string> = {
  running: "In progress",
  asked: "Needs your answer",
  blocked: "Blocked",
  stalled: "Stalled",
  failed: "Stopped",
  unpublished: "No blueprint",
  ready: "Ready",
};

const OUTCOME_TONE: Record<BlueprintOutcome, StepRowState> = {
  running: "active",
  asked: "stalled",
  blocked: "blocked",
  stalled: "stalled",
  failed: "failed",
  unpublished: "failed",
  ready: "done",
};

function errorText(error: unknown): string {
  if (error && typeof error === "object" && "message" in error) return String((error as { message: unknown }).message);
  return String(error);
}

function taskPath(task: { identifier: string | null; id: string }): string {
  return `/issues/${encodeURIComponent(task.identifier ?? task.id)}`;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const ss = String(seconds).padStart(2, "0");
  return hours > 0 ? `${hours}:${String(minutes).padStart(2, "0")}:${ss}` : `${minutes}:${ss}`;
}

function formatStarted(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

const MODE_LABEL: Record<BlueprintMode, string> = { free: "Free", quick: "Quick", full: "Full" };

/** The mode and cost line on a job panel: no spend for a free task, else data used against the cap. */
export function costLine(job: BlueprintJob): ReactNode {
  if (jobMode(job) === "free") return <span>Free: no data spend</span>;
  return (
    <span>
      Data used <span className="font-mono tabular-nums text-foreground">{formatUsd(job.spentUsd)}</span> of{" "}
      <span className="font-mono tabular-nums text-foreground">{formatUsd(job.capUsd)}</span>
      {isOverCap(job) && <span className="font-medium" style={STATUS_COLOR.blocked}> · Over the data cap</span>}
    </span>
  );
}

/** Re-render on an interval while `enabled`. */
function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

function newerJob(a: BlueprintJob | null | undefined, b: BlueprintJob | null | undefined): BlueprintJob | null {
  if (!a) return b ?? null;
  if (!b) return a;
  // Copies are ordered by revision: a copy wins only with a higher one. The
  // clock only breaks a tie between copies of the same revision, where it
  // cannot pick a different save.
  const revisionA = a.revision ?? 0;
  const revisionB = b.revision ?? 0;
  if (revisionB !== revisionA) return revisionB > revisionA ? b : a;
  return Date.parse(b.updatedAt) > Date.parse(a.updatedAt) ? b : a;
}

// ---------------------------------------------------------------------------
// Icons (inline, currentColor)
// ---------------------------------------------------------------------------

function Icon({ children, label }: { children: ReactNode; label?: string }) {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" className="size-4" role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true}>
      {children}
    </svg>
  );
}

function StepMarker({ state }: { state: StepRowState }) {
  const label = { done: "Done", active: "In progress", pending: "Not started", blocked: "Blocked", stalled: "Stalled", failed: "Stopped" }[state];
  return (
    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground" style={STATUS_COLOR[state]}>
      {state === "done" && <Icon label={label}><path d="M3.5 8.5l3 3 6-7" /></Icon>}
      {state === "active" && <Icon label={label}><circle cx="8" cy="8" r="3" fill="currentColor" className="motion-safe:animate-pulse" /><circle cx="8" cy="8" r="6.25" /></Icon>}
      {state === "pending" && <Icon label={label}><circle cx="8" cy="8" r="6.25" /></Icon>}
      {state === "blocked" && <Icon label={label}><circle cx="8" cy="8" r="6.25" /><path d="M8 4.75v3.75M8 11.25v.01" /></Icon>}
      {state === "stalled" && <Icon label={label}><circle cx="8" cy="8" r="6.25" /><path d="M8 4.75V8l2 1.5" /></Icon>}
      {state === "failed" && <Icon label={label}><circle cx="8" cy="8" r="6.25" /><path d="M5.75 5.75l4.5 4.5M10.25 5.75l-4.5 4.5" /></Icon>}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Sidebar
// ---------------------------------------------------------------------------

export function GrowthSidebarLink(_props: PluginSidebarProps) {
  const navigation = useHostNavigation();
  return (
    <a {...navigation.linkProps("/growth")} className="flex items-center gap-2.5 px-3 py-2 text-sm font-medium text-foreground/80 no-underline transition-colors hover:bg-accent/50 hover:text-foreground">
      <span aria-hidden="true" className="shrink-0">
        <Icon><path d="M2.5 12.5l4-4 2.5 2.5 4.5-5" /><path d="M10 6h3.5v3.5" /></Icon>
      </span>
      <span className="flex-1 truncate">Growth</span>
    </a>
  );
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

function rowNote(step: BlueprintStep, state: StepRowState, job: BlueprintJob, outcome: BlueprintOutcome): string | null {
  const detail = job.steps[step].detail ?? null;
  if (state === "blocked" && job.blocked) return BLOCK_REASON_TEXT[job.blocked];
  if (state === "stalled") return "No update for 15 minutes.";
  if (state === "failed" && outcome === "unpublished") return "Growth finished without attaching a blueprint.";
  if (state === "failed" && job.runEnded && job.runEnded.status !== "succeeded_unpublished") return "The Growth run stopped before this step finished.";
  if (state === "failed") return "The task closed before this step finished.";
  if (state === "active" && outcome === "asked") return "Waiting for your answer on the task.";
  if (state === "active" && step === "computer" && !detail) return "The task is queued for Growth.";
  return detail;
}

export function BlueprintSteps({ job, outcome, now }: { job: BlueprintJob; outcome: BlueprintOutcome; now: number }) {
  const rows = stepRowStates(job, outcome);
  return (
    <ol className="space-y-3" aria-label="Blueprint progress">
      {BLUEPRINT_STEPS.map((step) => {
        const state = rows[step];
        const note = rowNote(step, state, job, outcome);
        const startedAt = job.steps[step].at ? Date.parse(job.steps[step].at!) : Number.NaN;
        const showElapsed = state === "active" && outcome === "running" && Number.isFinite(startedAt);
        return (
          <li key={step} className="flex items-start gap-3" data-step={step} data-state={state}>
            <StepMarker state={state} />
            <div className="min-w-0 flex-1 space-y-1">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className={state === "pending" ? "text-sm text-muted-foreground" : "text-sm font-medium text-foreground"}>
                  {STEP_LABELS[step](job.site, jobMode(job))}
                </span>
                {showElapsed && (
                  <span role="timer" className="font-mono text-xs tabular-nums text-muted-foreground" aria-label="Time on this step">
                    {formatElapsed(now - startedAt)}
                  </span>
                )}
              </div>
              {note && <p className="break-words text-xs text-muted-foreground">{note}</p>}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

// ---------------------------------------------------------------------------
// While you wait: follow-up tasks
// ---------------------------------------------------------------------------

function MeanwhileCard({ definition, job, companyId }: { definition: JobDefinition; job: BlueprintJob; companyId: string }) {
  const navigation = useHostNavigation();
  const startFollowup = usePluginAction("start-followup");
  const recorded = job.followups?.[definition.id];
  const [started, setStarted] = useState<{ issueId: string; identifier: string | null } | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const linked = started ?? (recorded ? { issueId: recorded.issueId, identifier: null } : null);

  async function start() {
    setPending(true);
    setFailure(null);
    try {
      const result = await startFollowup({ companyId, followupId: definition.id, site: job.site, parentIssueId: job.issueId }) as StartResult;
      if (result.ok) setStarted({ issueId: result.issueId, identifier: result.identifier });
      else setFailure(result.message);
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="space-y-2 rounded-lg border border-border p-3">
      <p className="text-sm font-medium text-foreground">{jobTitle(definition, job.site)}</p>
      <p className="text-xs text-muted-foreground">{definition.line}</p>
      {failure && <p role="alert" className="text-xs text-destructive">{failure}</p>}
      <div className="flex justify-end">
        {linked ? (
          <a className={secondaryButton} {...navigation.linkProps(taskPath({ id: linked.issueId, identifier: linked.identifier }))}>Open task</a>
        ) : (
          <button type="button" className={secondaryButton} disabled={pending} onClick={() => void start()}>
            {pending ? "Starting…" : "Start task"}
          </button>
        )}
      </div>
    </li>
  );
}

function MeanwhileCards({ job, companyId }: { job: BlueprintJob; companyId: string }) {
  return (
    <section className="space-y-3" aria-labelledby="growth-next-tasks">
      <div className="space-y-1">
        <h3 id="growth-next-tasks" className="text-sm font-semibold text-foreground">While you wait</h3>
        <p className="text-xs text-muted-foreground">Related research you can start now. Each one runs as its own task.</p>
      </div>
      <ul className="space-y-3">
        {FOLLOWUP_JOBS.map((definition) => (
          <MeanwhileCard key={definition.id} definition={definition} job={job} companyId={companyId} />
        ))}
      </ul>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Selected task panel
// ---------------------------------------------------------------------------

export function outcomeNoteText(outcome: BlueprintOutcome, job: BlueprintJob): string | null {
  return outcome === "asked" ? "Growth asked a question on the task. Answer there to continue."
    : outcome === "blocked" && job.blocked ? BLOCK_REASON_TEXT[job.blocked]
    : outcome === "stalled" ? "No update for 15 minutes. Open the task to check the run."
    : outcome === "unpublished" ? "Growth finished without attaching a blueprint. Open the task to see what it said."
    : outcome === "failed" && job.runEnded && job.runEnded.status !== "succeeded_unpublished" ? "The Growth run stopped before the blueprint was published. Open the task and ask Growth to try again."
    : outcome === "failed" ? "The task closed before the blueprint was published. Open the task and ask Growth to try again."
    : null;
}

/** What the live region says: the outcome, the current step, and its note. No timer. */
export function progressAnnouncement(job: BlueprintJob, outcome: BlueprintOutcome): string {
  const step = currentStep(job);
  const note = outcomeNoteText(outcome, job) ?? job.steps[step].detail ?? null;
  return [`${OUTCOME_LABEL[outcome]}: ${STEP_LABELS[step](job.site, jobMode(job))}`, note].filter(Boolean).join(". ");
}

/**
 * One polite live region per panel. It changes only when the current step or
 * the outcome changes, so detail edits and the elapsed timer stay quiet.
 */
function ProgressAnnouncer({ job, outcome }: { job: BlueprintJob; outcome: BlueprintOutcome }) {
  const key = `${job.issueId}|${currentStep(job)}|${outcome}`;
  const [spoken, setSpoken] = useState(() => ({ key, text: progressAnnouncement(job, outcome) }));
  useEffect(() => {
    if (spoken.key !== key) setSpoken({ key, text: progressAnnouncement(job, outcome) });
  }, [key, spoken.key, job, outcome]);
  return <p role="status" aria-live="polite" className="sr-only">{spoken.text}</p>;
}

function OutcomeNote({ outcome, job }: { outcome: BlueprintOutcome; job: BlueprintJob }) {
  const text = outcomeNoteText(outcome, job);
  if (!text) return null;
  // Announced by ProgressAnnouncer; this is the visible copy.
  return <p className="text-sm text-muted-foreground">{text}</p>;
}

export function BlueprintPanel({ view, liveJob, companyId }: { view: JobView; liveJob: BlueprintJob | null; companyId: string }) {
  const navigation = useHostNavigation();
  const job = newerJob(view.job, liveJob)!;
  const live = job !== view.job;
  const ticking = job.outcome === "running" && job.steps.published.status !== "done";
  const now = useNow(1000, ticking);
  const outcome = live || view.outcome === "running" || view.outcome === "stalled"
    ? deriveOutcome(job, { now, issueStatus: view.task?.status, agentAskedQuestion: view.agentAskedQuestion })
    : view.outcome;
  const task = view.task ?? { id: job.issueId, identifier: null, title: "", status: "" };
  // Opens the task with this attachment selected. The host opens the file
  // directly in the default workspace; in the classic workspace it lands on
  // the task, where blueprint.html is listed under attachments.
  const blueprintHref = job.artifact
    ? `${taskPath(task)}?attachmentId=${encodeURIComponent(job.artifact.attachmentId)}`
    : null;
  // A free task never uses Treg, so it never offers Connect Treg.
  const connectTreg = outcome === "blocked" && job.blocked === "treg_missing" && jobMode(job) !== "free";
  const openTaskIsPrimary = outcome === "asked" || outcome === "stalled" || outcome === "failed" || outcome === "unpublished"
    || (outcome === "blocked" && !connectTreg);

  return (
    <section className="space-y-4 rounded-lg border border-border p-4" aria-labelledby="growth-current">
      <ProgressAnnouncer job={job} outcome={outcome} />
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="growth-current" className="text-base font-semibold text-foreground">Blueprint for {job.site}</h2>
        <span className="text-xs font-medium" style={STATUS_COLOR[OUTCOME_TONE[outcome]]}>{OUTCOME_LABEL[outcome]}</span>
      </div>
      <OutcomeNote outcome={outcome} job={job} />
      <div className="grid gap-6 md:grid-cols-3">
        <div className="md:col-span-2">
          <BlueprintSteps job={job} outcome={outcome} now={now} />
        </div>
        <MeanwhileCards job={job} companyId={companyId} />
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {costLine(job)}
          {!openTaskIsPrimary && <a className={textLink} {...navigation.linkProps(taskPath(task))}>Open task</a>}
        </div>
        {outcome === "ready" && blueprintHref ? (
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span id="growth-view-help" className="text-xs text-muted-foreground">If the file does not open, it is in the task's attachments.</span>
            <a className={primaryButton} aria-describedby="growth-view-help" {...navigation.linkProps(blueprintHref)}>View blueprint</a>
          </div>
        ) : connectTreg ? (
          <a className={primaryButton} {...navigation.linkProps("/apps")}>Connect Treg</a>
        ) : openTaskIsPrimary ? (
          <a className={primaryButton} {...navigation.linkProps(taskPath(task))}>Open task</a>
        ) : (
          <div className="flex flex-wrap items-center justify-end gap-3">
            <span id="growth-view-pending" className="text-xs text-muted-foreground">The blueprint opens here when it is ready.</span>
            <button type="button" className={primaryButton} disabled aria-describedby="growth-view-pending">View blueprint</button>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Start form
// ---------------------------------------------------------------------------

const MODE_COPY: Record<BlueprintMode, string> = {
  free: "Public sources only. No data spend.",
  quick: "A lighter pass over search, ads and the product itself.",
  full: "The whole picture, with traffic history, peers, social and links.",
};

function modeCostText(mode: BlueprintMode): string {
  return mode === "free" ? "" : mode === "quick" ? `About ${formatUsd(MODE_DEFAULT_CAP_USD.quick)} of data` : `Up to ${formatUsd(MODE_DEFAULT_CAP_USD.full)} of data`;
}

/** The typed cap as a number, or null when it is not a number above 0 and at most the maximum. Blank is the mode's default. */
function parseCap(text: string, mode: BlueprintMode): { ok: true; capUsd: number | undefined } | { ok: false } {
  if (mode === "free" || !text.trim()) return { ok: true, capUsd: undefined };
  const value = Number(text.trim());
  if (!Number.isFinite(value) || value <= 0 || value > MAX_CAP_USD) return { ok: false };
  return { ok: true, capUsd: value };
}

/** The mode radio group and, for quick and full, the data cap input. */
export function StartModeFields({ mode, capText, capInvalid, capRef, onMode, onCap }: {
  mode: BlueprintMode;
  capText: string;
  capInvalid: boolean;
  /** Lets the form move focus to the cap input when its value is rejected. */
  capRef?: RefObject<HTMLInputElement | null>;
  onMode: (mode: BlueprintMode) => void;
  onCap: (text: string) => void;
}) {
  const defaultCap = formatUsd(MODE_DEFAULT_CAP_USD[mode]);
  const maxCap = formatUsd(MAX_CAP_USD);
  return (
    <>
      <div className="space-y-2">
        <p id="growth-mode-label" className="text-sm font-medium text-foreground">Data to use</p>
        <div role="radiogroup" aria-labelledby="growth-mode-label" aria-describedby="growth-mode-help" className="grid gap-2 md:grid-cols-3">
          {BLUEPRINT_MODES.map((option) => {
            const cost = modeCostText(option);
            return (
              <label key={option} htmlFor={`growth-mode-${option}`} className="flex cursor-pointer items-start gap-2 rounded-md border border-border p-3 has-checked:border-ring has-checked:bg-accent">
                <input
                  id={`growth-mode-${option}`}
                  type="radio"
                  name="growth-mode"
                  value={option}
                  checked={mode === option}
                  onChange={() => onMode(option)}
                  className={`mt-0.5 size-4 shrink-0 accent-primary ${focusRing}`}
                />
                <span className="min-w-0 space-y-1">
                  <span className="block text-sm font-medium text-foreground">{MODE_LABEL[option]}{cost ? <span className="font-normal text-muted-foreground"> · {cost}</span> : null}</span>
                  <span className="block text-xs text-muted-foreground">{MODE_COPY[option]}</span>
                </span>
              </label>
            );
          })}
        </div>
      </div>
      <p id="growth-mode-help" className="text-xs text-muted-foreground">
        {mode === "free"
          ? "Free runs read public pages and free public sources. They make no Treg calls and never need Treg."
          : "Paid data comes from Treg. Growth stops before it passes the cap."}
      </p>
      {mode !== "free" && (
        <div className="space-y-2">
          <label className="block space-y-2" htmlFor="growth-cap">
            <span className="text-sm font-medium text-foreground">Data cap (US dollars)</span>
            <input
              id="growth-cap"
              ref={capRef}
              className={`${inputClass} md:max-w-48`}
              value={capText}
              onChange={(event) => onCap(event.target.value)}
              placeholder={MODE_DEFAULT_CAP_USD[mode].toFixed(2)}
              inputMode="decimal"
              autoComplete="off"
              spellCheck={false}
              maxLength={8}
              aria-invalid={capInvalid ? true : undefined}
              aria-describedby={capInvalid ? "growth-cap-help growth-cap-error" : "growth-cap-help"}
            />
          </label>
          <p id="growth-cap-help" className="text-xs text-muted-foreground">
            Leave blank to use <span className="font-mono tabular-nums">{defaultCap}</span>. The most you can set is <span className="font-mono tabular-nums">{maxCap}</span>.
          </p>
        </div>
      )}
    </>
  );
}

/** Which input an error belongs to. `form` is an error that no single input caused. */
type FailureField = "site" | "cap" | "form";
interface StartFailure {
  message: string;
  field: FailureField;
  agentId?: string | null;
}

function failureField(reason: Extract<StartResult, { ok: false }>["reason"]): FailureField {
  return reason === "invalid_site" ? "site" : reason === "invalid_cap" ? "cap" : "form";
}

/** What to tell a person whose start returned an existing task. Says when that task's data cap is not the one they typed. */
export function dedupedNotice(input: { mode: BlueprintMode; site: string; requestedCapUsd: number; existingCapUsd?: number }): string {
  const base = `A ${MODE_LABEL[input.mode].toLowerCase()} blueprint for ${input.site} started in the last 30 minutes. Showing that task.`;
  if (input.mode === "free" || input.existingCapUsd === undefined || input.existingCapUsd === input.requestedCapUsd) return base;
  return `${base} That task's data cap is ${formatUsd(input.existingCapUsd)}; your ${formatUsd(input.requestedCapUsd)} cap was not applied.`;
}

function StartForm({ companyId, onStarted }: { companyId: string; onStarted: (issueId: string) => void }) {
  const navigation = useHostNavigation();
  const start = usePluginAction("start");
  const [site, setSite] = useState("");
  const [mode, setMode] = useState<BlueprintMode>(DEFAULT_MODE);
  const [capText, setCapText] = useState("");
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<StartFailure | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const siteRef = useRef<HTMLInputElement>(null);
  const capRef = useRef<HTMLInputElement>(null);
  const normalized = normalizeSite(site);
  const defaultCap = formatUsd(MODE_DEFAULT_CAP_USD[mode]);
  const maxCap = formatUsd(MAX_CAP_USD);
  const siteInvalid = failure?.field === "site";
  const capInvalid = failure?.field === "cap";

  // Each new error on an input moves focus to it once the input shows as invalid.
  useEffect(() => {
    if (failure?.field === "site") siteRef.current?.focus();
    else if (failure?.field === "cap") capRef.current?.focus();
  }, [failure]);

  function chooseMode(next: BlueprintMode) {
    setMode(next);
    // Each mode starts from its own default cap.
    setCapText("");
    setFailure(null);
  }

  function editSite(text: string) {
    setSite(text);
    setFailure((current) => (current?.field === "site" ? null : current));
  }

  function editCap(text: string) {
    setCapText(text);
    setFailure((current) => (current?.field === "cap" ? null : current));
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!normalized) {
      setFailure({ field: "site", message: "Enter a public website, for example example.com." });
      return;
    }
    const cap = parseCap(capText, mode);
    if (!cap.ok) {
      setFailure({ field: "cap", message: `Enter a data cap above $0 and up to ${maxCap}, or leave it blank for ${defaultCap}.` });
      return;
    }
    setPending(true);
    setFailure(null);
    setNotice(null);
    try {
      const requestedCapUsd = cap.capUsd ?? MODE_DEFAULT_CAP_USD[mode];
      const result = await start({ companyId, site: normalized, mode, ...(cap.capUsd !== undefined ? { capUsd: cap.capUsd } : {}) }) as StartResult;
      if (!result.ok) {
        setFailure({ field: failureField(result.reason), message: result.message, agentId: result.agentId });
        return;
      }
      setNotice(result.deduped ? dedupedNotice({ mode, site: normalized, requestedCapUsd, existingCapUsd: result.job?.capUsd }) : null);
      setSite("");
      onStarted(result.issueId);
    } catch (error) {
      setFailure({ field: "form", message: errorText(error) });
    } finally {
      setPending(false);
    }
  }

  const describedBy = [
    "growth-site-help",
    siteInvalid ? "growth-site-error" : null,
  ].filter(Boolean).join(" ");

  return (
    <form className="space-y-3 rounded-lg border border-border p-4" onSubmit={(event) => void submit(event)} aria-labelledby="growth-start">
      <div className="space-y-1">
        <h2 id="growth-start" className="text-base font-semibold text-foreground">Start a blueprint</h2>
        <p className="text-sm text-muted-foreground">Growth studies the site from public pages and data, then attaches a one-page blueprint to a new task.</p>
      </div>
      <label className="block space-y-2" htmlFor="growth-site">
        <span className="text-sm font-medium text-foreground">Website</span>
        <input
          id="growth-site"
          ref={siteRef}
          className={inputClass}
          value={site}
          onChange={(event) => editSite(event.target.value)}
          placeholder="example.com"
          inputMode="url"
          autoComplete="url"
          autoCapitalize="none"
          spellCheck={false}
          maxLength={2048}
          aria-invalid={siteInvalid ? true : undefined}
          aria-describedby={describedBy}
        />
      </label>
      <p id="growth-site-help" className="text-xs text-muted-foreground">Your own site or a competitor's.</p>
      <StartModeFields mode={mode} capText={capText} capInvalid={capInvalid} capRef={capRef} onMode={chooseMode} onCap={editCap} />
      {failure && (
        <p id={`growth-${failure.field}-error`} role="alert" className="text-sm text-destructive">
          {failure.message}{" "}
          {failure.agentId && <a className={textLink} {...navigation.linkProps(`/agents/${encodeURIComponent(failure.agentId)}`)}>Open Growth</a>}
        </p>
      )}
      {notice && <p role="status" className="text-sm text-muted-foreground">{notice}</p>}
      <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
        <button type="button" className={quietButton} disabled={pending || !site} onClick={() => { setSite(""); setCapText(""); setFailure(null); }}>Clear</button>
        <button type="submit" className={primaryButton} disabled={pending || !site.trim()}>{pending ? "Starting…" : "Start blueprint"}</button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Recent tasks
// ---------------------------------------------------------------------------

function RecentTasks({ tasks, selectedIssueId, onSelect }: { tasks: RecentTask[]; selectedIssueId: string | null; onSelect: (issueId: string) => void }) {
  const navigation = useHostNavigation();
  return (
    <section className="space-y-3" aria-labelledby="growth-recent">
      <h2 id="growth-recent" className="text-base font-semibold text-foreground">Recent tasks</h2>
      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No Growth tasks yet. Enter a website above to start the first one.</p>
      ) : (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {tasks.map((task) => {
            const tone = task.outcome ? OUTCOME_TONE[task.outcome] : null;
            const selected = task.issueId === selectedIssueId;
            return (
              <li key={task.issueId} className="flex flex-wrap items-center justify-between gap-3 px-3 py-2">
                <div className="min-w-0 flex-1">
                  {task.kind === "blueprint" ? (
                    <button type="button" className={`block max-w-full truncate rounded-sm text-left text-sm font-medium text-foreground hover:underline ${focusRing}`} aria-pressed={selected} onClick={() => onSelect(task.issueId)}>
                      {task.title}
                    </button>
                  ) : (
                    <a className={`block max-w-full truncate rounded-sm text-sm font-medium text-foreground hover:underline ${focusRing}`} {...navigation.linkProps(taskPath({ id: task.issueId, identifier: task.identifier }))}>{task.title}</a>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {task.identifier && <span className="font-mono">{task.identifier}</span>}{task.identifier ? " · " : ""}{task.mode ? `${MODE_LABEL[task.mode]} · ` : ""}{formatStarted(task.startedAt)}
                  </p>
                </div>
                {task.outcome && tone && <span className="text-xs font-medium" style={STATUS_COLOR[tone]}>{OUTCOME_LABEL[task.outcome]}</span>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function GrowthPage({ context }: PluginPageProps) {
  const companyId = context.companyId;
  if (!companyId) {
    return <main className="p-4 text-sm text-muted-foreground md:p-6">Choose a company to use Growth.</main>;
  }
  return <GrowthPageBody companyId={companyId} />;
}

function GrowthPageBody({ companyId }: { companyId: string }) {
  const jobs = usePluginData<{ tasks: RecentTask[] }>("jobs", { companyId, limit: 10 });
  const [selectedIssueId, setSelectedIssueId] = useState<string | null>(null);
  const tasks = useMemo(() => jobs.data?.tasks ?? [], [jobs.data]);
  const activeIssueId = selectedIssueId ?? tasks.find((task) => task.kind === "blueprint")?.issueId ?? null;
  const view = usePluginData<JobView | null>("job", { companyId, issueId: activeIssueId });
  const stream = usePluginStream<BlueprintProgressEvent>(PROGRESS_STREAM_CHANNEL, { companyId });
  const [liveJobs, setLiveJobs] = useState<Record<string, BlueprintJob>>({});

  const lastEvent = stream.lastEvent;
  useEffect(() => {
    if (!lastEvent || lastEvent.type !== "job.updated" || lastEvent.job.companyId !== companyId) return;
    const incoming = lastEvent.job;
    setLiveJobs((current) => ({ ...current, [incoming.issueId]: newerJob(current[incoming.issueId], incoming)! }));
    jobs.refresh();
    if (incoming.issueId === activeIssueId) view.refresh();
    // Refresh handles are stable per key; react only to new events.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastEvent]);

  return (
    <main className="mx-auto w-full max-w-5xl space-y-6 p-4 md:p-6">
      <header className="space-y-1">
        <h1 className="text-xl font-semibold text-foreground">Growth</h1>
        <p className="text-sm text-muted-foreground">Blueprints for where the next customers could come from, built from public evidence and attached to a task.</p>
      </header>
      <StartForm companyId={companyId} onStarted={(issueId) => { setSelectedIssueId(issueId); jobs.refresh(); }} />
      {jobs.error && <p role="alert" className="text-sm text-destructive">Could not load Growth tasks: {jobs.error.message}</p>}
      {view.error && <p role="alert" className="text-sm text-destructive">Could not load this task: {view.error.message}</p>}
      {view.data ? (
        <BlueprintPanel view={view.data} liveJob={liveJobs[view.data.job.issueId] ?? null} companyId={companyId} />
      ) : activeIssueId && view.loading ? (
        <p className="text-sm text-muted-foreground">Loading the selected task…</p>
      ) : null}
      {jobs.loading && !jobs.data ? (
        <p className="text-sm text-muted-foreground">Loading tasks…</p>
      ) : (
        <RecentTasks tasks={tasks} selectedIssueId={activeIssueId} onSelect={setSelectedIssueId} />
      )}
    </main>
  );
}
