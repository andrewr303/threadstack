// Job catalog and task prompts for the growth blueprint plugin. Shared by the
// worker and the UI bundle, so it uses Web Crypto rather than node:crypto.

import {
  DEFAULT_MODE,
  MAX_CAP_USD,
  MODE_DEFAULT_CAP_USD,
  formatUsd,
  isBlueprintMode,
  type BlueprintMode,
} from "./contracts.js";

export interface JobField {
  key: string;
  label: string;
  placeholder: string;
  required: boolean;
}

export type JobKind = "blueprint" | "followup";

export interface JobDefinition {
  id: string;
  kind: JobKind;
  /** Card or form title. `{site}` is replaced with the task's website. */
  title: string;
  /** One-line summary shown under the title. */
  line: string;
  fields: JobField[];
}

const WEBSITE_FIELD: JobField = {
  key: "site",
  label: "Website",
  placeholder: "example.com",
  required: true,
};

export const BLUEPRINT_JOB_ID = "growth-blueprint";

export const JOB_CATALOG: readonly JobDefinition[] = [
  {
    id: BLUEPRINT_JOB_ID,
    kind: "blueprint",
    title: "Growth plan for {site}",
    line: "A one-page plan for where the next customers could come from, built only from public evidence.",
    fields: [WEBSITE_FIELD],
  },
  {
    id: "watch-site",
    kind: "followup",
    title: "Log a month of changes on {site}",
    line: "Snapshot pricing, the main headline and launch notes today, then record each change against that snapshot.",
    fields: [WEBSITE_FIELD],
  },
  {
    id: "find-buyers",
    kind: "followup",
    title: "List likely customers for {site}",
    line: "Named companies or people showing a public need for this, each with the source and a one-line reason.",
    fields: [WEBSITE_FIELD],
  },
  {
    id: "compare-rivals",
    kind: "followup",
    title: "Compare {site} with two rivals",
    line: "Side by side on pricing, positioning and channels, ending with the gaps worth closing first.",
    fields: [WEBSITE_FIELD],
  },
];

export const FOLLOWUP_JOBS: readonly JobDefinition[] = JOB_CATALOG.filter((job) => job.kind === "followup");

export function findJob(id: unknown): JobDefinition | null {
  return JOB_CATALOG.find((job) => job.id === id) ?? null;
}

export function jobTitle(job: JobDefinition, site: string): string {
  return job.title.replaceAll("{site}", site);
}

export interface TaskPrompt {
  title: string;
  description: string;
}

export interface PromptOptions {
  mode?: BlueprintMode;
  /** Data cap in US dollars. Ignored for free, which is always 0. */
  capUsd?: number;
}

/** A mode and cap that are safe to print: an unknown mode is the default, a bad cap is the mode's own. */
function resolvePromptOptions(options: PromptOptions): { mode: BlueprintMode; capUsd: number } {
  const mode = isBlueprintMode(options.mode) ? options.mode : DEFAULT_MODE;
  if (mode === "free") return { mode, capUsd: 0 };
  const cap = options.capUsd;
  const capUsd = typeof cap === "number" && Number.isFinite(cap) && cap > 0 && cap <= MAX_CAP_USD ? cap : MODE_DEFAULT_CAP_USD[mode];
  return { mode, capUsd };
}

function modeLines(mode: BlueprintMode, capUsd: number): string[] {
  const cap = mode === "free" ? `${formatUsd(0)} (no data spend)` : formatUsd(capUsd);
  return [`Mode: ${mode}`, `Data cap: ${cap}`];
}

const FREE_MODE_LINES = [
  "Free mode: make no treg calls and spend no data. Do not check for treg, and never report this task as blocked on treg or on the data cap.",
  "Follow the playbook's \"F · Free mode\" step: public free sources only. Every cost_usd is 0.",
  "Do not report spentUsd.",
];

export function buildBlueprintPrompt(site: string, options: PromptOptions = {}): TaskPrompt {
  const { mode, capUsd } = resolvePromptOptions(options);
  return {
    title: `Growth plan for ${site}`,
    description: [
      `Make a growth blueprint for ${site}.`,
      "",
      `Website: ${site}`,
      ...modeLines(mode, capUsd),
      "",
      mode === "free"
        ? "Use the growth-blueprint skill. Work only from public evidence, report each step with report_step, and attach the finished blueprint.html to this task before reporting it as published."
        : `Use the growth-blueprint skill. Work only from public evidence, report each step with report_step, ${mode === "quick" ? "follow the playbook's quick mode, " : ""}stay inside the data cap, and attach the finished blueprint.html to this task before reporting it as published.`,
      ...(mode === "free" ? ["", ...FREE_MODE_LINES] : []),
      "If something stops you, report it as blocked and say here what you need.",
    ].join("\n"),
  };
}

const FOLLOWUP_BRIEFS: Record<string, (site: string) => string[]> = {
  "watch-site": (site) => [
    `Keep a 30-day change log for ${site}.`,
    "",
    "Today, save a baseline of the public pages that matter most: pricing, the home page headline, sign-up, and any changelog or launch notes.",
    "List what you will compare on each later check and how often. If routines are available, suggest one; otherwise say when to wake you next.",
    "Attach the baseline to this task as a file and summarize it in a comment.",
  ],
  "find-buyers": (site) => [
    `List up to ten companies or people with a public need for what ${site} offers.`,
    "",
    "Use public evidence only: posts, job listings, reviews, public directories.",
    "For each one, give the name, where you found the signal, and one sentence on why they fit. Do not contact anyone.",
    "Attach the list to this task as a file.",
  ],
  "compare-rivals": (site) => [
    `Compare ${site} with two close rivals.`,
    "",
    "Pick rivals a buyer would weigh against it and say why you chose them.",
    "Cover pricing, the promise each one leads with, and the channels each seems to rely on.",
    "End with the three gaps most worth closing. Attach the comparison to this task as a file.",
  ],
};

export function buildFollowupPrompt(job: JobDefinition, site: string, options: PromptOptions = {}): TaskPrompt {
  const brief = FOLLOWUP_BRIEFS[job.id]?.(site) ?? [jobTitle(job, site)];
  const { mode, capUsd } = resolvePromptOptions(options);
  return {
    title: jobTitle(job, site),
    description: [
      ...brief,
      "",
      `Website: ${site}`,
      ...modeLines(mode, capUsd),
      ...(mode === "free" ? ["Free mode: make no treg calls and spend no data. Use public free sources only."] : []),
      "Ask on this task before posting, sending or publishing anything outside it.",
    ].join("\n"),
  };
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * `gb-` plus the first 12 hex characters of sha256(kind + mode + site + UTC day).
 * Same for every task of that mode on that site and day, and different between
 * modes. A full blueprint (or one with no mode) keeps the key it had before modes.
 */
export async function siteDayKey(
  site: string,
  date: Date,
  jobDefinitionId: string = BLUEPRINT_JOB_ID,
  mode?: BlueprintMode,
): Promise<string> {
  const prefix = jobDefinitionId === BLUEPRINT_JOB_ID ? "gb" : "gf";
  const modePart = mode && mode !== "full" ? `${mode}:` : "";
  const seed = jobDefinitionId === BLUEPRINT_JOB_ID ? `${modePart}${site}${utcDay(date)}` : `${jobDefinitionId}:${modePart}${site}${utcDay(date)}`;
  return `${prefix}-${(await sha256Hex(seed)).slice(0, 12)}`;
}

function randomHex(bytes: number): string {
  const values = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(values);
  return [...values].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A job id unique to one task: the site-and-day key plus 8 random hex
 * characters. It is also the task's originId and its wakeup idempotency key,
 * so two tasks must never share it.
 */
export async function jobIdFor(site: string, date: Date, jobDefinitionId: string = BLUEPRINT_JOB_ID, mode?: BlueprintMode): Promise<string> {
  return `${await siteDayKey(site, date, jobDefinitionId, mode)}-${randomHex(4)}`;
}
