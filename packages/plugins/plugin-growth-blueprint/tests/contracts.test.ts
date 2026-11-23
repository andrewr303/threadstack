import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BLUEPRINT_STEPS,
  STALL_AFTER_MS,
  STEP_LABELS,
  advanceJob,
  createJob,
  currentStep,
  deriveOutcome,
  isOverCap,
  jobMode,
  normalizeSite,
  stepRowStates,
  textEndsInQuestion,
  validateReportStepParams,
  validateStartOptions,
  type BlueprintArtifact,
  type BlueprintJob,
  type ReportStepParams,
} from "../src/contracts.js";
import { FOLLOWUP_JOBS, JOB_CATALOG, buildBlueprintPrompt, jobIdFor, siteDayKey } from "../src/jobs.js";
import manifest, { GROWTH_SKILL_CANONICAL_KEY } from "../src/manifest.js";
import { MAX_SKILL_FILES, MAX_SKILL_FILE_CHARS, growthSkillFiles } from "../src/assets.js";

const T0 = "2026-11-18T10:00:00.000Z";
const T1 = "2026-11-18T10:01:00.000Z";
const T2 = "2026-11-18T10:02:00.000Z";
const ARTIFACT: BlueprintArtifact = { attachmentId: "att-1", filename: "blueprint.html", contentType: "text/html", byteSize: 1024 };

function job(): BlueprintJob {
  return createJob({ jobId: "gb-abc", companyId: "c1", issueId: "i1", agentId: "a1", site: "example.com", now: T0 });
}

function report(partial: Partial<ReportStepParams> & Pick<ReportStepParams, "step">): ReportStepParams {
  return { site: "example.com", ...partial };
}

describe("normalizeSite", () => {
  it.each([
    ["example.com", "example.com"],
    ["  https://www.Example.com/pricing?x=1#top ", "example.com"],
    ["http://shop.example.co.uk:8080/", "shop.example.co.uk"],
    ["//example.io", "example.io"],
    ["example.com.", "example.com"],
    ["xn--bcher-kva.example", "xn--bcher-kva.example"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeSite(input)).toBe(expected);
  });

  it.each([
    "", "localhost", "127.0.0.1", "http://[::1]/", "user:pass@example.com", "exa mple.com",
    "-bad.com", "example", "example.c0m", 42, null,
  ])("rejects %s", (input) => {
    expect(normalizeSite(input)).toBeNull();
  });
});

describe("validateReportStepParams", () => {
  it("accepts a minimal report and normalizes the site", () => {
    expect(validateReportStepParams({ step: "reading", site: "https://www.example.com/" })).toEqual({
      ok: true,
      value: { step: "reading", site: "example.com" },
    });
  });

  it("never lets the agent report the computer step", () => {
    expect(validateReportStepParams({ step: "computer", site: "example.com" }).ok).toBe(false);
  });

  it("requires attachmentId for published", () => {
    const result = validateReportStepParams({ step: "published", site: "example.com" });
    expect(result.ok).toBe(false);
  });

  it("keeps detail plain and bounded", () => {
    const ok = validateReportStepParams({ step: "reading", site: "example.com", detail: " Reading\n\tpricing  " });
    expect(ok.ok && ok.value.detail).toBe("Reading pricing");
    expect(validateReportStepParams({ step: "reading", site: "example.com", detail: "x".repeat(141) }).ok).toBe(false);
  });

  it("rejects bad spend and unknown block reasons", () => {
    expect(validateReportStepParams({ step: "signals", site: "example.com", spentUsd: -1 }).ok).toBe(false);
    expect(validateReportStepParams({ step: "signals", site: "example.com", spentUsd: Number.NaN }).ok).toBe(false);
    expect(validateReportStepParams({ step: "reading", site: "example.com", blocked: "tired" }).ok).toBe(false);
  });

  it("does not carry task identity from arguments", () => {
    const result = validateReportStepParams({ step: "reading", site: "example.com", issueId: "other", companyId: "x", agentId: "y" });
    expect(result.ok && Object.keys(result.value)).toEqual(["step", "site"]);
  });
});

describe("advanceJob", () => {
  it("starts with the workspace step active", () => {
    const fresh = job();
    expect(currentStep(fresh)).toBe("computer");
    expect(fresh.steps.computer.status).toBe("active");
    expect(fresh.outcome).toBe("running");
  });

  it("marks earlier steps done when a later step arrives", () => {
    const result = advanceJob(job(), report({ step: "signals", spentUsd: 0.2 }), T1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.changed).toBe(true);
    expect(result.job.steps.computer.status).toBe("done");
    expect(result.job.steps.reading.status).toBe("done");
    expect(result.job.steps.signals).toMatchObject({ status: "active", at: T1 });
    expect(result.job.spentUsd).toBe(0.2);
    expect(result.job.updatedAt).toBe(T1);
  });

  it("rejects moving backwards", () => {
    const at = advanceJob(job(), report({ step: "building" }), T1);
    if (!at.ok) throw new Error(at.error);
    const back = advanceJob(at.job, report({ step: "reading" }), T2);
    expect(back.ok).toBe(false);
  });

  it("updates only the detail on a repeated step", () => {
    const first = advanceJob(job(), report({ step: "reading", detail: "Home page" }), T1);
    if (!first.ok) throw new Error(first.error);
    const again = advanceJob(first.job, report({ step: "reading", detail: "Pricing page" }), T2);
    if (!again.ok) throw new Error(again.error);
    expect(again.job.steps.reading).toEqual({ status: "active", at: T1, detail: "Pricing page" });
    const same = advanceJob(again.job, report({ step: "reading", detail: "Pricing page" }), T2);
    expect(same.ok && same.changed).toBe(false);
  });

  it("rejects a different site", () => {
    expect(advanceJob(job(), { step: "reading", site: "other.com" }, T1).ok).toBe(false);
  });

  it("needs a verified artifact to publish, then becomes ready", () => {
    expect(advanceJob(job(), report({ step: "published", attachmentId: "att-1" }), T1).ok).toBe(false);
    const done = advanceJob(job(), report({ step: "published", attachmentId: "att-1" }), T1, ARTIFACT);
    if (!done.ok) throw new Error(done.error);
    expect(done.job.outcome).toBe("ready");
    expect(BLUEPRINT_STEPS.every((step) => done.job.steps[step].status === "done")).toBe(true);
    expect(done.job.artifact).toEqual(ARTIFACT);
    expect(advanceJob(done.job, report({ step: "published", attachmentId: "att-1" }), T2)).toMatchObject({ ok: true, changed: false });
    expect(advanceJob(done.job, report({ step: "published", attachmentId: "att-2" }), T2).ok).toBe(false);
  });

  it("holds the step when blocked and clears the block on the next normal report", () => {
    const blocked = advanceJob(job(), report({ step: "reading", blocked: "treg_missing" }), T1);
    if (!blocked.ok) throw new Error(blocked.error);
    expect(blocked.job.outcome).toBe("blocked");
    expect(blocked.job.blocked).toBe("treg_missing");
    expect(currentStep(blocked.job)).toBe("reading");
    expect(blocked.job.steps.reading.status).toBe("active");
    const resumed = advanceJob(blocked.job, report({ step: "signals" }), T2);
    if (!resumed.ok) throw new Error(resumed.error);
    expect(resumed.job.outcome).toBe("running");
    expect(resumed.job.blocked).toBeUndefined();
  });

  it("never lowers reported spend", () => {
    const a = advanceJob(job(), report({ step: "signals", spentUsd: 1.5 }), T1);
    if (!a.ok) throw new Error(a.error);
    const b = advanceJob(a.job, report({ step: "signals", spentUsd: 1.2 }), T2);
    expect(b.ok && b.job.spentUsd).toBe(1.5);
  });
});

describe("deriveOutcome and row states", () => {
  const now = Date.parse(T0);

  it("derives stalled, asked and failed", () => {
    const fresh = job();
    expect(deriveOutcome(fresh, { now })).toBe("running");
    expect(deriveOutcome(fresh, { now: now + STALL_AFTER_MS + 1 })).toBe("stalled");
    expect(deriveOutcome(fresh, { now, issueStatus: "in_review" })).toBe("asked");
    expect(deriveOutcome(fresh, { now, agentAskedQuestion: true })).toBe("asked");
    expect(deriveOutcome(fresh, { now, issueStatus: "done" })).toBe("failed");
    expect(deriveOutcome(fresh, { now, issueStatus: "cancelled" })).toBe("failed");
  });

  it("maps the active row to the outcome", () => {
    const at = advanceJob(job(), report({ step: "signals" }), T1);
    if (!at.ok) throw new Error(at.error);
    expect(stepRowStates(at.job, "running")).toEqual({
      computer: "done", reading: "done", signals: "active", building: "pending", published: "pending",
    });
    expect(stepRowStates(at.job, "stalled").signals).toBe("stalled");
    expect(stepRowStates(at.job, "failed").signals).toBe("failed");
    expect(stepRowStates(at.job, "blocked").signals).toBe("blocked");
  });

  it("detects a trailing question", () => {
    expect(textEndsInQuestion("Should I raise the cap?")).toBe(true);
    expect(textEndsInQuestion("Should I raise the cap?**  ")).toBe(true);
    expect(textEndsInQuestion("Done.")).toBe(false);
  });

  it("labels the five rows", () => {
    expect(BLUEPRINT_STEPS.map((step) => STEP_LABELS[step]("example.com"))).toEqual([
      "Preparing a workspace",
      "Scanning the public pages of example.com",
      "Collecting traffic and channel data",
      "Writing the plan",
      "Ready to view",
    ]);
  });
});

describe("validateStartOptions", () => {
  it("defaults to free with a cap of 0", () => {
    expect(validateStartOptions(undefined, undefined)).toEqual({ ok: true, value: { mode: "free", capUsd: 0 } });
    expect(validateStartOptions("", null)).toEqual({ ok: true, value: { mode: "free", capUsd: 0 } });
  });

  it("forces free to 0 whatever the cap says", () => {
    expect(validateStartOptions("free", 5)).toEqual({ ok: true, value: { mode: "free", capUsd: 0 } });
  });

  it("gives quick and full their own default caps", () => {
    expect(validateStartOptions("quick", undefined)).toEqual({ ok: true, value: { mode: "quick", capUsd: 0.6 } });
    expect(validateStartOptions("full", "")).toEqual({ ok: true, value: { mode: "full", capUsd: 3 } });
  });

  it("accepts a cap above 0 and up to 10, rounded to cents", () => {
    expect(validateStartOptions("full", 10)).toMatchObject({ ok: true, value: { capUsd: 10 } });
    expect(validateStartOptions("quick", 0.01)).toMatchObject({ ok: true, value: { capUsd: 0.01 } });
    expect(validateStartOptions("quick", 1.239)).toMatchObject({ ok: true, value: { capUsd: 1.24 } });
  });

  it("rejects an unknown mode and a cap outside 0 to 10", () => {
    expect(validateStartOptions("paid", 1)).toMatchObject({ ok: false, reason: "invalid_mode" });
    expect(validateStartOptions({}, 1)).toMatchObject({ ok: false, reason: "invalid_mode" });
    for (const cap of [0, 0.004, -2, 10.01, Number.POSITIVE_INFINITY, Number.NaN, "3", {}]) {
      expect(validateStartOptions("full", cap), String(cap)).toMatchObject({ ok: false, reason: "invalid_cap" });
    }
  });
});

describe("modes on a job", () => {
  const free = () => createJob({ jobId: "gb-f", companyId: "c1", issueId: "i1", agentId: "a1", site: "example.com", now: T0, mode: "free", capUsd: 3 });

  it("creates free jobs with a cap of 0 and reads a job with no mode as full", () => {
    expect(free()).toMatchObject({ mode: "free", capUsd: 0 });
    expect(createJob({ jobId: "x", companyId: "c", issueId: "i", agentId: "a", site: "example.com", now: T0, mode: "quick" }).capUsd).toBe(0.6);
    expect(job().mode).toBeUndefined();
    expect(job().capUsd).toBe(3);
    expect(jobMode(job())).toBe("full");
  });

  it("rejects treg_missing and budget blocks on a free job and refuses a spend above 0", () => {
    for (const blocked of ["treg_missing", "budget"] as const) {
      const result = advanceJob(free(), report({ step: "reading", blocked }), T1);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain(blocked);
    }
    const spent = advanceJob(free(), report({ step: "signals", spentUsd: 2, blocked: "site_unreachable" }), T1);
    expect(spent.ok).toBe(false);
    if (!spent.ok) expect(spent.error).toMatch(/spentUsd/);
    const ok = advanceJob(free(), report({ step: "signals", spentUsd: 0, blocked: "site_unreachable" }), T1);
    expect(ok.ok && ok.job.blocked).toBe("site_unreachable");
    expect(ok.ok && ok.job.spentUsd).toBeUndefined();
    expect(advanceJob(job(), report({ step: "reading", blocked: "treg_missing" }), T1).ok).toBe(true);
  });

  it("walks reading, signals, building, published in free mode and labels signals as free-source pulls", () => {
    let current = free();
    for (const step of ["reading", "signals", "building"] as const) {
      const result = advanceJob(current, report({ step }), T1);
      if (!result.ok) throw new Error(result.error);
      current = result.job;
      expect(currentStep(current)).toBe(step);
    }
    const published = advanceJob(current, report({ step: "published", attachmentId: "att-1" }), T2, ARTIFACT);
    expect(published.ok && published.job.outcome).toBe("ready");
    expect(STEP_LABELS.signals("example.com", "free")).toBe("Pulling free public sources");
    expect(STEP_LABELS.signals("example.com", "quick")).toBe("Collecting traffic and channel data");
    expect(STEP_LABELS.signals("example.com")).toBe("Collecting traffic and channel data");
  });
});

describe("jobs", () => {
  it("states the mode and cap in each prompt", () => {
    const free = buildBlueprintPrompt("example.com", { mode: "free", capUsd: 9 }).description;
    expect(free).toContain("Mode: free");
    expect(free).toContain("Data cap: $0.00 (no data spend)");
    expect(free).toContain("make no treg calls");
    expect(free).toContain("F · Free mode");
    expect(free).toContain("cost_usd is 0");
    const quick = buildBlueprintPrompt("example.com", { mode: "quick" }).description;
    expect(quick).toContain("Mode: quick");
    expect(quick).toContain("Data cap: $0.60");
    expect(quick).not.toContain("make no treg calls");
    const full = buildBlueprintPrompt("example.com", { mode: "full", capUsd: 4.5 }).description;
    expect(full).toContain("Mode: full");
    expect(full).toContain("Data cap: $4.50");
    // Unsafe values fall back to the mode's own default.
    const odd = buildBlueprintPrompt("example.com", { mode: "full", capUsd: Number.NaN }).description;
    expect(odd).toContain("Data cap: $3.00");
    expect(buildBlueprintPrompt("example.com", { mode: "bogus" as never }).description).toContain("Mode: free");
  });

  it("keeps the old site-and-day key for full and gives each other mode its own", async () => {
    const date = new Date(T0);
    const full = await siteDayKey("example.com", date, "growth-blueprint", "full");
    expect(full).toBe(await siteDayKey("example.com", date));
    const free = await siteDayKey("example.com", date, "growth-blueprint", "free");
    const quick = await siteDayKey("example.com", date, "growth-blueprint", "quick");
    expect(new Set([full, free, quick]).size).toBe(3);
  });

  it("builds a stable site-and-day key and a unique job id per task", async () => {
    const a = await siteDayKey("example.com", new Date(T0));
    const b = await siteDayKey("example.com", new Date(T2));
    const c = await siteDayKey("example.com", new Date("2026-11-19T10:00:00.000Z"));
    expect(a).toMatch(/^gb-[0-9a-f]{12}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(await siteDayKey("example.com", new Date(T0), "watch-site")).toMatch(/^gf-[0-9a-f]{12}$/);
    const first = await jobIdFor("example.com", new Date(T0));
    const second = await jobIdFor("example.com", new Date(T0));
    expect(first).toMatch(new RegExp(`^${a}-[0-9a-f]{8}$`));
    expect(first).not.toBe(second);
  });

  it("ships one blueprint job and two or three follow-ups", () => {
    expect(JOB_CATALOG.filter((entry) => entry.kind === "blueprint")).toHaveLength(1);
    expect(FOLLOWUP_JOBS.length).toBeGreaterThanOrEqual(2);
    expect(FOLLOWUP_JOBS.length).toBeLessThanOrEqual(3);
    expect(buildBlueprintPrompt("example.com").description).toContain("Website: example.com");
  });
});

describe("manifest", () => {
  it("declares a paused Growth agent with an explicit budget and only this skill", () => {
    const agent = manifest.agents?.[0];
    expect(agent?.displayName).toBe("Growth");
    expect(agent?.status).toBe("paused");
    expect(agent?.budgetMonthlyCents).toBeGreaterThan(0);
    expect(agent?.adapterConfig?.paperclipSkillSync).toEqual({ desiredSkills: [GROWTH_SKILL_CANONICAL_KEY] });
    expect(agent?.permissions).toEqual({ canCreateAgents: false, canCreateSkills: false });
    expect(agent?.instructions?.content).toContain("Publish only by attaching to the task");
  });

  it("declares exactly the capabilities the worker uses", () => {
    expect([...manifest.capabilities].sort()).toEqual([
      "activity.log.write",
      "agent.tools.register",
      "agents.managed",
      "events.subscribe",
      "issue.attachments.read",
      "issue.comments.read",
      "issues.create",
      "issues.read",
      "issues.wakeup",
      "plugin.state.read",
      "plugin.state.write",
      "projects.managed",
      "skills.managed",
      "ui.page.register",
      "ui.sidebar.register",
    ]);
  });

  it("declares the project, skill, tool and UI slots", () => {
    expect(manifest.projects?.map((project) => project.displayName)).toEqual(["Growth blueprints"]);
    expect(manifest.tools?.map((tool) => tool.name)).toEqual(["report_step"]);
    expect(manifest.ui?.slots?.find((slot) => slot.type === "page")?.routePath).toBe("growth");
    expect(manifest.ui?.slots?.some((slot) => slot.type === "sidebar")).toBe(true);
    const skill = manifest.skills?.[0];
    expect(skill?.markdown).toMatch(/^---\nname: growth-blueprint\n/);
    expect(skill?.markdown).toContain('render ./blueprint.json -o ./blueprint.html --inline-images');
    expect(skill?.markdown).toContain('PLAYBOOK_DIR="$SKILL_DIR/rea-growth"');
    expect(skill?.markdown).toContain('BP="$PLAYBOOK_DIR/scripts/blueprint.py"');
    expect(skill?.markdown).toContain("--moves ./moves-vs-growth.csv");
    expect(skill?.markdown).toContain("--costs ./costs.json");
    expect(skill?.markdown).toContain("python3 -B");
    expect(skill?.markdown).toContain(".attachment.id");
  });

  it("ships the vendored rea-growth playbook, scripts, template and references", () => {
    const paths = growthSkillFiles().map((file) => file.path);
    expect(paths).toEqual(expect.arrayContaining([
      "rea-growth/SKILL.md",
      "rea-growth/scripts/blueprint.py",
      "rea-growth/scripts/analyze.py",
      "rea-growth/scripts/rea_math.py",
      "rea-growth/assets/blueprint.template.html",
      "rea-growth/references/blueprint.md",
      "rea-growth/references/channels.md",
      "rea-growth/references/endpoints.md",
      "rea-growth/references/methods.md",
    ]));
    expect(paths.some((path) => /(^|\/)(tests|examples|__pycache__)\//.test(path))).toBe(false);
    expect(manifest.skills?.[0]?.files?.map((file) => file.path)).toEqual(paths);
  });

  it("ships a template whose only remote loads are web fonts that --offline strips", () => {
    const files = growthSkillFiles();
    const template = files.find((file) => file.path === "rea-growth/assets/blueprint.template.html")?.content ?? "";
    expect(template).toContain('<script id="blueprint-data" type="application/json"></script>');
    expect(template).not.toMatch(/<(script|img|iframe)[^>]+src="(https?:)?\/\//);
    const remoteLinks = template.match(/<link\b[^>]*href="(https?:)?\/\/[^"]*"[^>]*>/g) ?? [];
    for (const link of remoteLinks) {
      expect(link).toMatch(/href="https:\/\/fonts\.(googleapis|gstatic)\.com/);
    }
    const renderer = files.find((file) => file.path === "rea-growth/scripts/blueprint.py")?.content ?? "";
    expect(renderer).toContain('"--offline"');
  });

  it("tells the agent to read the mode, skip Treg in free mode and keep step reporting", () => {
    // Collapse line wraps so a phrase can span two lines.
    const wrapper = readFileSync(new URL("../skills/growth-blueprint/SKILL.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(wrapper).toContain("`Mode:` line");
    expect(wrapper).toContain("Free mode: skip this step entirely.");
    expect(wrapper).toContain('never report `blocked: "treg_missing"`');
    expect(wrapper).toContain("never pass `spentUsd`");
    expect(wrapper).toContain("Starting the free source pulls");
    expect(wrapper).toContain("reading, signals, building, published");
    expect(wrapper).toContain("Make no Treg calls");
  });

  it("renders the blueprint offline so the task viewer's CSP blocks nothing", () => {
    const wrapper = readFileSync(new URL("../skills/growth-blueprint/SKILL.md", import.meta.url), "utf8");
    expect(wrapper).toMatch(/render \.\/blueprint\.json -o \.\/blueprint\.html --inline-images --offline/);
  });

  it("keeps skill files inside host limits", () => {
    const files = manifest.skills?.[0]?.files ?? [];
    expect(files.length).toBeLessThanOrEqual(MAX_SKILL_FILES);
    for (const file of files) {
      expect(file.path.toLowerCase()).not.toBe("skill.md");
      expect(file.content.length).toBeLessThanOrEqual(MAX_SKILL_FILE_CHARS);
    }
  });

  it("ships no absolute home paths", () => {
    const root = new URL("../", import.meta.url);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(new URL(dir, root))) {
        if (entry === "node_modules" || entry === "dist") continue;
        const path = `${dir}${entry}`;
        if (statSync(new URL(path, root)).isDirectory()) walk(`${path}/`);
        else if (/(^|[^\w])(\/Users\/|\/home\/)[a-z]/i.test(readFileSync(new URL(path, root), "utf8")) && !path.endsWith(".test.ts")) offenders.push(path);
      }
    };
    walk("./");
    expect(offenders).toEqual([]);
  });

  it("ships the vendored rea-growth files exactly as VENDOR.json records them", () => {
    const root = new URL("../skills/growth-blueprint/rea-growth/", import.meta.url);
    const vendor = JSON.parse(readFileSync(new URL("VENDOR.json", root), "utf8")) as { files: Record<string, string> };
    const recorded = Object.keys(vendor.files).sort();
    expect(recorded.length).toBeGreaterThan(8);
    for (const rel of recorded) {
      const actual = createHash("sha256").update(readFileSync(new URL(rel, root))).digest("hex");
      expect(actual, `${rel} differs from VENDOR.json; re-run scripts/sync-rea-growth.mjs`).toBe(vendor.files[rel]);
    }
    const shipped = growthSkillFiles().map((file) => file.path)
      .filter((path) => path.startsWith("rea-growth/") && path !== "rea-growth/VENDOR.json")
      .map((path) => path.slice("rea-growth/".length)).sort();
    expect(shipped).toEqual(recorded);
  });
});

describe("run-ended outcomes", () => {
  const job = (): BlueprintJob => createJob({ jobId: "j", companyId: "c", issueId: "i", agentId: "a", site: "example.com", now: "2026-01-01T00:00:00.000Z" });
  it("derives failed and unpublished, with asked and blocked outranking unpublished", () => {
    const now = Date.parse("2026-01-01T00:01:00.000Z");
    const failed = { ...job(), runEnded: { status: "failed" as const, at: "x" } };
    expect(deriveOutcome(failed, { now })).toBe("failed");
    const unpub = { ...job(), runEnded: { status: "succeeded_unpublished" as const, at: "x" } };
    expect(deriveOutcome(unpub, { now: now + 60 * 60 * 1000 })).toBe("unpublished");
    expect(deriveOutcome(unpub, { now, issueStatus: "in_review" })).toBe("asked");
    expect(deriveOutcome({ ...unpub, outcome: "blocked" }, { now })).toBe("blocked");
    expect(stepRowStates(unpub, "unpublished").computer).toBe("failed");
  });
});

describe("spend against the data cap", () => {
  const paid = (mode: "quick" | "full", capUsd: number) => createJob({ jobId: "gb-abc", companyId: "c1", issueId: "i1", agentId: "a1", site: "example.com", now: T0, mode, capUsd });

  it("records a spend over the cap and flags it", () => {
    const under = advanceJob(paid("quick", 1), report({ step: "signals", spentUsd: 0.9 }), T1);
    expect(under.ok && isOverCap(under.job)).toBe(false);
    const over = advanceJob(paid("quick", 1), report({ step: "signals", spentUsd: 1.5 }), T1);
    expect(over.ok && over.job.spentUsd).toBe(1.5);
    expect(over.ok && isOverCap(over.job)).toBe(true);
  });

  it("a spend equal to the cap is not over it, and a free job is never over", () => {
    const equal = advanceJob(paid("full", 3), report({ step: "signals", spentUsd: 3 }), T1);
    expect(equal.ok && isOverCap(equal.job)).toBe(false);
    expect(isOverCap({ mode: "free", capUsd: 0, spentUsd: 5 })).toBe(false);
    expect(isOverCap({ capUsd: 3, spentUsd: 3.5 })).toBe(true);
  });
});

describe("report_step mode argument", () => {
  it("accepts a known mode and rejects an unknown one", () => {
    expect(validateReportStepParams({ step: "reading", site: "example.com", mode: "free" })).toMatchObject({ ok: true, value: { mode: "free" } });
    expect(validateReportStepParams({ step: "reading", site: "example.com", mode: "huge" })).toMatchObject({ ok: false });
    expect(validateReportStepParams({ step: "reading", site: "example.com", capUsd: 9 })).toEqual({ ok: true, value: { step: "reading", site: "example.com" } });
  });

  it("the manifest schema lists the mode argument", () => {
    const tool = manifest.tools?.find((item) => item.name === "report_step");
    expect(JSON.stringify(tool?.parametersSchema)).toContain('"mode"');
  });
});
