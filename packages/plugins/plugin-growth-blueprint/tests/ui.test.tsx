import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { advanceJob, createJob, type BlueprintArtifact, type BlueprintJob, type BlueprintOutcome } from "../src/contracts.js";
import type { JobView } from "../src/worker.js";

// The host bridge is not available in tests; stub the hooks the panel uses.
vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  useHostNavigation: () => ({ linkProps: (href: string) => ({ href }) }),
  usePluginAction: () => async () => ({ ok: true }),
  usePluginData: () => ({ data: null, loading: false, error: null, refresh: () => undefined }),
  usePluginStream: () => ({ lastEvent: null }),
}));

const { BlueprintPanel, StartModeFields, GrowthPage, progressAnnouncement } = await import("../src/ui/index.js");

const COMPANY_ID = "c1";
const T0 = new Date(Date.now() - 60_000).toISOString();
const ARTIFACT: BlueprintArtifact = { attachmentId: "att-1", filename: "blueprint.html", contentType: "text/html", byteSize: 1024 };

function baseJob(): BlueprintJob {
  return createJob({ jobId: "gb-abc", companyId: COMPANY_ID, issueId: "i1", agentId: "a1", site: "example.com", now: T0 });
}

function advanced(job: BlueprintJob, step: "reading" | "signals" | "building" | "published", extra: Record<string, unknown> = {}): BlueprintJob {
  const result = advanceJob(job, { step, site: job.site, ...extra }, new Date().toISOString(), step === "published" ? ARTIFACT : undefined);
  if (!result.ok) throw new Error(result.error);
  return result.job;
}

function render(job: BlueprintJob, outcome: BlueprintOutcome, status = "in_progress"): string {
  const view: JobView = { job, outcome, task: { id: job.issueId, identifier: "GRO-1", title: "Growth plan for example.com", status } };
  return renderToStaticMarkup(<BlueprintPanel view={view} liveJob={null} companyId={COMPANY_ID} />);
}

function liveRegion(html: string): string {
  const match = html.match(/<p role="status" aria-live="polite" class="sr-only">([^<]*)<\/p>/);
  return match?.[1] ?? "";
}

function renderLive(view: JobView, liveJob: BlueprintJob | null): string {
  return renderToStaticMarkup(<BlueprintPanel view={view} liveJob={liveJob} companyId={COMPANY_ID} />);
}

describe("BlueprintPanel live copies", () => {
  const task = { id: "i1", identifier: "GRO-1", title: "Growth plan for example.com", status: "in_progress" };

  it("a live copy with a lower revision does not replace the server copy, even with a later clock", () => {
    const server = { ...advanced(advanced(baseJob(), "reading"), "signals", { detail: "Server copy" }), revision: 5 };
    const stale = { ...advanced(baseJob(), "reading", { detail: "Stale live copy" }), revision: 2, updatedAt: new Date(Date.now() + 60_000).toISOString() };
    const html = renderLive({ job: server, outcome: "running", task }, stale);
    expect(html).toContain("Server copy");
    expect(html).not.toContain("Stale live copy");
  });

  it("a live copy with a higher revision wins", () => {
    const server = { ...advanced(baseJob(), "reading", { detail: "Server copy" }), revision: 2 };
    const live = { ...advanced(advanced(baseJob(), "reading"), "signals", { detail: "Live copy" }), revision: 3 };
    const html = renderLive({ job: server, outcome: "running", task }, live);
    expect(html).toContain("Live copy");
  });

  it("keeps the server's asked signal when it recomputes the outcome from a live copy", () => {
    const server = { ...advanced(baseJob(), "reading"), revision: 1 };
    const live = { ...advanced(advanced(baseJob(), "reading"), "signals"), revision: 2 };
    const html = renderLive({ job: server, outcome: "asked", agentAskedQuestion: true, task }, live);
    expect(html).toContain("Growth asked a question on the task.");
    const without = renderLive({ job: server, outcome: "running", agentAskedQuestion: false, task }, live);
    expect(without).not.toContain("Growth asked a question on the task.");
  });
});

describe("BlueprintPanel states", () => {
  it("running: announces the current step, shows a timer and a pending View blueprint", () => {
    const html = render(advanced(baseJob(), "signals", { detail: "Checking traffic" }), "running");
    expect(liveRegion(html)).toBe("In progress: Collecting traffic and channel data. Checking traffic");
    expect(html).toContain('role="timer"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="growth-view-pending"[^>]*>View blueprint<\/button>/);
    expect(html).toContain("The blueprint opens here when it is ready.");
    expect(html).not.toContain("title=");
  });

  it("asked: says to answer on the task and makes Open task the primary action", () => {
    const html = render(advanced(baseJob(), "reading"), "asked", "blocked");
    expect(liveRegion(html)).toContain("Needs your answer");
    expect(html).toContain("Growth asked a question on the task.");
    expect(html).toMatch(/class="inline-flex[^"]*bg-primary[^"]*" href="\/issues\/GRO-1">Open task<\/a>/);
    expect(html).not.toContain(">View blueprint<");
  });

  it("blocked on Treg: offers Connect Treg", () => {
    const html = render(advanced(baseJob(), "reading", { blocked: "treg_missing" }), "blocked");
    expect(liveRegion(html)).toContain("Treg is not connected");
    expect(html).toContain('href="/apps">Connect Treg</a>');
  });

  it("blocked on budget: tells the person how to continue and opens the task", () => {
    const html = render(advanced(baseJob(), "signals", { blocked: "budget" }), "blocked");
    expect(html).toContain("start a new task with a higher data cap");
    expect(html).not.toContain("Raise the cap");
    expect(html).toMatch(/bg-primary[^"]*" href="\/issues\/GRO-1">Open task<\/a>/);
  });

  it("stalled: explains the stall and opens the task", () => {
    const quiet = { ...advanced(baseJob(), "building"), updatedAt: new Date(Date.now() - 20 * 60_000).toISOString() };
    const html = render(quiet, "stalled");
    expect(liveRegion(html)).toContain("Stalled: Writing the plan");
    expect(html).toMatch(/bg-primary[^"]*" href="\/issues\/GRO-1">Open task<\/a>/);
  });

  it("failed: says what to do next", () => {
    const html = render(advanced(baseJob(), "building"), "failed", "done");
    expect(html).toContain("Open the task and ask Growth to try again.");
    expect(html).toMatch(/bg-primary[^"]*" href="\/issues\/GRO-1">Open task<\/a>/);
  });

  it("unpublished: says Growth finished without a blueprint and points to the task", () => {
    const job = { ...advanced(baseJob(), "building"), runEnded: { status: "succeeded_unpublished" as const, at: "2026-01-01T00:00:00.000Z" } };
    const html = render(job, "unpublished");
    expect(html).toContain("Growth finished without attaching a blueprint. Open the task to see what it said.");
    expect(html).toMatch(/bg-primary[^"]*" href="\/issues\/GRO-1">Open task<\/a>/);
  });

  it("ready: links to the attachment and explains where it opens", () => {
    const html = render(advanced(advanced(baseJob(), "building"), "published", { attachmentId: ARTIFACT.attachmentId }), "ready", "done");
    expect(liveRegion(html)).toBe("Ready: Ready to view");
    expect(html).toContain('href="/issues/GRO-1?attachmentId=att-1">View blueprint</a>');
    expect(html).toContain("it is in the task&#x27;s attachments");
    expect(html).not.toContain('role="timer"');
  });

  it("uses the reworded section title", () => {
    const html = render(baseJob(), "running");
    expect(html).toContain(">While you wait</h3>");
    expect(html).not.toMatch(/Meanwhile/);
  });

  it("keeps the timer out of the announcement", () => {
    expect(progressAnnouncement(baseJob(), "running")).toBe("In progress: Preparing a workspace");
  });
});

describe("start form mode choice", () => {
  const noop = () => undefined;
  const fields = (mode: "free" | "quick" | "full", capText = "", capInvalid = false) =>
    renderToStaticMarkup(<StartModeFields mode={mode} capText={capText} capInvalid={capInvalid} onMode={noop} onCap={noop} />);

  it("renders an accessible radio group with three labelled options", () => {
    const html = fields("free");
    expect(html).toContain('role="radiogroup" aria-labelledby="growth-mode-label"');
    expect(html).toContain('id="growth-mode-label"');
    expect(html.match(/type="radio"/g)).toHaveLength(3);
    for (const mode of ["free", "quick", "full"]) {
      expect(html).toContain(`id="growth-mode-${mode}"`);
      expect(html).toContain(`for="growth-mode-${mode}"`);
    }
    expect(html).toContain("Public sources only. No data spend.");
    expect(html).toContain("About $0.60 of data");
    expect(html).toContain("Up to $3.00 of data");
  });

  it("checks the chosen mode only", () => {
    for (const mode of ["free", "quick", "full"] as const) {
      const html = fields(mode);
      expect(html.match(/checked=""/g)).toHaveLength(1);
      expect(html).toMatch(new RegExp(`<input id="growth-mode-${mode}"[^>]*checked=""`));
    }
  });

  it("hides the cap for free and shows a labelled cap with the mode's default for quick and full", () => {
    expect(fields("free")).not.toContain("growth-cap");
    const quick = fields("quick");
    expect(quick).toContain('for="growth-cap"');
    expect(quick).toContain("Data cap (US dollars)");
    expect(quick).toContain('placeholder="0.60"');
    expect(quick).toContain("Leave blank to use");
    expect(fields("full")).toContain('placeholder="3.00"');
    expect(fields("full", "12", true)).toContain('aria-invalid="true"');
    expect(fields("full", "2", false)).not.toContain("aria-invalid=");
  });

  it("opens on Free with the footer unchanged", () => {
    const html = renderToStaticMarkup(<GrowthPage context={{ companyId: COMPANY_ID } as never} />);
    expect(html).toMatch(/<input id="growth-mode-free"[^>]*checked=""/);
    expect(html).not.toContain('id="growth-cap"');
    expect(html).toMatch(/>Clear<\/button><button type="submit"[^>]*>Start blueprint<\/button>/);
  });
});

describe("BlueprintPanel mode and cost line", () => {
  const freeJob = () => createJob({ jobId: "gb-f", companyId: COMPANY_ID, issueId: "i1", agentId: "a1", site: "example.com", now: T0, mode: "free" });

  it("free: says there is no data spend and shows no Data used line", () => {
    const html = render(advanced(freeJob(), "signals"), "running");
    expect(html).toContain("Free: no data spend");
    expect(html).not.toContain("Data used");
    expect(liveRegion(html)).toContain("Pulling free public sources");
  });

  it("quick and full: show data used against the cap", () => {
    const quick = createJob({ jobId: "gb-q", companyId: COMPANY_ID, issueId: "i1", agentId: "a1", site: "example.com", now: T0, mode: "quick" });
    const quickHtml = render(advanced(quick, "signals", { spentUsd: 0.3 }), "running");
    expect(quickHtml).toMatch(/Data used <span[^>]*>\$0\.30<\/span> of(?: |<!-- --> )<span[^>]*>\$0\.60<\/span>/);
    expect(quickHtml).not.toContain("Free: no data spend");
    // A job with no mode is a full job.
    expect(render(advanced(baseJob(), "signals", { spentUsd: 1.5 }), "running")).toMatch(/\$1\.50<\/span> of(?: |<!-- --> )<span[^>]*>\$3\.00/);
  });

  it("never offers Connect Treg on a free job, even one stored as blocked on Treg", () => {
    const stored: BlueprintJob = { ...advanced(freeJob(), "reading"), outcome: "blocked", blocked: "treg_missing" };
    const html = render(stored, "blocked");
    expect(html).not.toContain("Connect Treg");
    expect(html).toMatch(/bg-primary[^"]*" href="\/issues\/GRO-1">Open task<\/a>/);
    // The same stored job with no mode still offers it.
    const legacy: BlueprintJob = { ...advanced(baseJob(), "reading"), outcome: "blocked", blocked: "treg_missing" };
    expect(render(legacy, "blocked")).toContain('href="/apps">Connect Treg</a>');
  });
});

describe("BlueprintPanel data cost", () => {
  const quick = (spentUsd: number) => advanced(createJob({ jobId: "gb-q", companyId: COMPANY_ID, issueId: "i1", agentId: "a1", site: "example.com", now: T0, mode: "quick", capUsd: 1 }), "signals", { spentUsd });

  it("shows a spend over the data cap instead of hiding it", () => {
    const html = render(quick(1.4), "running");
    expect(html).toContain("$1.40");
    expect(html).toContain("Over the data cap");
    expect(render(quick(0.4), "running")).not.toContain("Over the data cap");
  });
});
