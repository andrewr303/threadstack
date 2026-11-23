import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk/testing";
import type { PluginContext, ToolResult, ToolRunContext } from "@paperclipai/plugin-sdk";
import {
  GROWTH_AGENT_KEY,
  JOB_STATE_KEY,
  PROGRESS_STREAM_CHANNEL,
  STATE_NAMESPACE,
  type BlueprintJob,
  type BlueprintProgressEvent,
} from "../src/contracts.js";
import manifest from "../src/manifest.js";
import plugin, { type JobView, type StartResult } from "../src/worker.js";

const COMPANY_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_COMPANY_ID = "99999999-9999-4999-8999-999999999999";

type IssueAttachment = Awaited<ReturnType<PluginContext["issues"]["listAttachments"]>>[number];
type ToolHandler = (params: unknown, runCtx: ToolRunContext) => Promise<ToolResult>;

interface Setup {
  harness: TestHarness;
  agentId: string;
  /** Calls report_step with a full host run context, including the bound task. */
  report(params: unknown, runCtx: Partial<ToolRunContext>): Promise<ToolResult>;
  emitted: Array<{ channel: string; event: BlueprintProgressEvent; companyId: string | null }>;
}

async function setup(options: { agentStatus?: "idle" | "paused" } = {}): Promise<Setup> {
  const harness = createTestHarness({ manifest });
  // The harness's executeTool drops `issueId` from the run context, so keep the
  // registered handler and call it with the full host-shaped context.
  const handlers = new Map<string, ToolHandler>();
  const register = harness.ctx.tools.register.bind(harness.ctx.tools);
  harness.ctx.tools.register = (name, declaration, fn) => {
    handlers.set(name, fn);
    register(name, declaration, fn);
  };
  // The harness stream client is a no-op; record what the worker sends.
  const emitted: Setup["emitted"] = [];
  let openCompany: string | null = null;
  harness.ctx.streams.open = (_channel, companyId) => { openCompany = companyId; };
  harness.ctx.streams.emit = (channel, event) => {
    emitted.push({ channel, event: event as BlueprintProgressEvent, companyId: openCompany });
  };

  const created = await harness.ctx.agents.managed.reconcile(GROWTH_AGENT_KEY, COMPANY_ID);
  harness.seed({ agents: [{ ...created.agent!, status: options.agentStatus ?? "idle" }] });
  await plugin.definition.setup(harness.ctx);

  return {
    harness,
    agentId: created.agent!.id,
    emitted,
    report(params, runCtx) {
      const handler = handlers.get("report_step");
      if (!handler) throw new Error("report_step not registered");
      return handler(params, {
        agentId: created.agent!.id,
        runId: randomUUID(),
        companyId: COMPANY_ID,
        projectId: "",
        ...runCtx,
      });
    },
  };
}

// Most tests exercise the paid path, so the helper starts a full task unless told otherwise.
async function start(
  s: Setup,
  site = "https://www.Example.com/pricing",
  options: { mode?: unknown; capUsd?: unknown } = { mode: "full" },
): Promise<Extract<StartResult, { ok: true }>> {
  const result = await s.harness.performAction<StartResult>("start", { site, ...options }, { companyId: COMPANY_ID });
  if (!result.ok) throw new Error(result.message);
  return result;
}

function stateOf(s: Setup, issueId: string): BlueprintJob {
  return s.harness.getState({ scopeKind: "issue", scopeId: issueId, namespace: STATE_NAMESPACE, stateKey: JOB_STATE_KEY }) as BlueprintJob;
}

function attachment(issueId: string, overrides: Partial<IssueAttachment> = {}): IssueAttachment {
  const now = new Date();
  return {
    id: randomUUID(),
    companyId: COMPANY_ID,
    issueId,
    issueCommentId: null,
    assetId: randomUUID(),
    provider: "local",
    objectKey: "blueprint.html",
    contentType: "text/html",
    byteSize: 2048,
    sha256: "0".repeat(64),
    originalFilename: "blueprint.html",
    createdByAgentId: null,
    createdByUserId: null,
    createdAt: now,
    updatedAt: now,
    contentPath: "/api/attachments/x/content",
    ...overrides,
  };
}

describe("start action", () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });

  it("creates a task for the Growth agent, writes the job, logs and streams it", async () => {
    const result = await start(s);
    expect(result.deduped).toBe(false);
    const issue = await s.harness.ctx.issues.get(result.issueId, COMPANY_ID);
    expect(issue).toMatchObject({ assigneeAgentId: s.agentId, title: "Growth plan for example.com", status: "todo" });
    expect(issue?.description).toContain("Website: example.com");

    const job = stateOf(s, result.issueId);
    expect(job).toMatchObject({ site: "example.com", issueId: result.issueId, agentId: s.agentId, companyId: COMPANY_ID, outcome: "running" });
    expect(job.jobId).toMatch(/^gb-[0-9a-f]{12}-[0-9a-f]{8}$/);
    expect(job.steps.computer.status).toBe("active");

    expect(s.harness.activity).toHaveLength(1);
    expect(s.harness.activity[0]).toMatchObject({ entityType: "issue", entityId: result.issueId });
    expect(JSON.stringify(s.harness.activity[0])).not.toContain("example.com");

    expect(s.emitted).toHaveLength(1);
    expect(s.emitted[0]).toMatchObject({ channel: PROGRESS_STREAM_CHANNEL, companyId: COMPANY_ID, event: { type: "job.updated" } });
    expect(s.emitted[0]!.event.job.issueId).toBe(result.issueId);
  });

  it("returns the active task for the same site inside 30 minutes", async () => {
    const first = await start(s, "example.com");
    const second = await start(s, "https://example.com/about");
    expect(second).toMatchObject({ deduped: true, issueId: first.issueId });
    const other = await start(s, "another.com");
    expect(other.deduped).toBe(false);
    expect(other.issueId).not.toBe(first.issueId);
  });

  it("starts a new task once the earlier one is closed", async () => {
    const first = await start(s, "example.com");
    s.harness.seed({ issues: [{ ...(await s.harness.ctx.issues.get(first.issueId, COMPANY_ID))!, status: "cancelled" }] });
    const second = await start(s, "example.com");
    expect(second.deduped).toBe(false);
    expect(second.issueId).not.toBe(first.issueId);
  });

  it("rejects an invalid site without creating a task", async () => {
    const result = await s.harness.performAction<StartResult>("start", { site: "localhost" }, { companyId: COMPANY_ID });
    expect(result).toMatchObject({ ok: false, reason: "invalid_site" });
    expect(s.emitted).toHaveLength(0);
  });

  it("starts in free mode with no data cap when the form sends no mode", async () => {
    const result = await start(s, "example.com", {});
    const job = stateOf(s, result.issueId);
    expect(job).toMatchObject({ mode: "free", capUsd: 0 });
    const issue = await s.harness.ctx.issues.get(result.issueId, COMPANY_ID);
    expect(issue?.description).toContain("Mode: free");
    expect(issue?.description).toContain("Data cap: $0.00 (no data spend)");
  });

  it("refuses while the Growth agent is paused", async () => {
    const paused = await setup({ agentStatus: "paused" });
    const result = await paused.harness.performAction<StartResult>("start", { site: "example.com" }, { companyId: COMPANY_ID });
    expect(result).toMatchObject({ ok: false, reason: "agent_paused", agentId: paused.agentId });
  });
});

describe("start modes", () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });

  async function rejected(options: { mode?: unknown; capUsd?: unknown }): Promise<StartResult> {
    return s.harness.performAction<StartResult>("start", { site: "example.com", ...options }, { companyId: COMPANY_ID });
  }

  it("records each mode with its cap and states both in the task text", async () => {
    const quick = await start(s, "quick.com", { mode: "quick" });
    expect(stateOf(s, quick.issueId)).toMatchObject({ mode: "quick", capUsd: 0.6 });
    const quickText = (await s.harness.ctx.issues.get(quick.issueId, COMPANY_ID))!.description!;
    expect(quickText).toContain("Mode: quick");
    expect(quickText).toContain("Data cap: $0.60");
    expect(quickText).toContain("quick mode");
    expect(quickText).not.toContain("make no treg calls");

    const full = await start(s, "full.com", { mode: "full", capUsd: 2.5 });
    expect(stateOf(s, full.issueId)).toMatchObject({ mode: "full", capUsd: 2.5 });
    const fullText = (await s.harness.ctx.issues.get(full.issueId, COMPANY_ID))!.description!;
    expect(fullText).toContain("Mode: full");
    expect(fullText).toContain("Data cap: $2.50");

    const defaulted = await start(s, "default.com", { mode: "full" });
    expect(stateOf(s, defaulted.issueId).capUsd).toBe(3);
  });

  it("free says make no treg calls, follows the free mode step and forces the cap to 0", async () => {
    const free = await start(s, "free.com", { mode: "free", capUsd: 7 });
    expect(stateOf(s, free.issueId)).toMatchObject({ mode: "free", capUsd: 0 });
    const text = (await s.harness.ctx.issues.get(free.issueId, COMPANY_ID))!.description!;
    expect(text).toContain("Mode: free");
    expect(text).toContain("Data cap: $0.00 (no data spend)");
    expect(text).toContain("make no treg calls");
    expect(text).toContain("F · Free mode");
    expect(text).toContain("cost_usd is 0");
    expect(text).toContain("never report this task as blocked on treg");
  });

  it("rejects an unknown mode and an out-of-range cap without creating a task", async () => {
    expect(await rejected({ mode: "turbo" })).toMatchObject({ ok: false, reason: "invalid_mode" });
    expect(await rejected({ mode: 3 })).toMatchObject({ ok: false, reason: "invalid_mode" });
    for (const capUsd of [0, -1, 10.01, 1000, Number.NaN, "abc", "5", true]) {
      expect(await rejected({ mode: "quick", capUsd }), `cap ${String(capUsd)}`).toMatchObject({ ok: false, reason: "invalid_cap" });
    }
    expect(await rejected({ mode: "full", capUsd: 10 })).toMatchObject({ ok: true });
    expect(s.emitted).toHaveLength(1);
  });

  it("dedupes by site and mode: a free and a full task for one site are different tasks", async () => {
    const free = await start(s, "example.com", { mode: "free" });
    const full = await start(s, "example.com", { mode: "full" });
    expect(full.deduped).toBe(false);
    expect(full.issueId).not.toBe(free.issueId);
    expect(stateOf(s, free.issueId).jobId).not.toBe(stateOf(s, full.issueId).jobId);
    expect(await start(s, "example.com", { mode: "free" })).toMatchObject({ deduped: true, issueId: free.issueId });
    expect(await start(s, "example.com", { mode: "full", capUsd: 1 })).toMatchObject({ deduped: true, issueId: full.issueId });
    const quick = await start(s, "example.com", { mode: "quick" });
    expect(quick.deduped).toBe(false);
  });

  it("treats a task saved before modes as a full task", async () => {
    const legacy = await start(s, "example.com", { mode: "full" });
    const { mode: _mode, ...withoutMode } = stateOf(s, legacy.issueId);
    await s.harness.ctx.state.set({ scopeKind: "issue", scopeId: legacy.issueId, namespace: STATE_NAMESPACE, stateKey: JOB_STATE_KEY }, withoutMode);
    const index = (await s.harness.ctx.state.get({ scopeKind: "company", scopeId: COMPANY_ID, namespace: STATE_NAMESPACE, stateKey: "jobs" })) as Array<Record<string, unknown>>;
    await s.harness.ctx.state.set(
      { scopeKind: "company", scopeId: COMPANY_ID, namespace: STATE_NAMESPACE, stateKey: "jobs" },
      index.map(({ mode: _m, ...entry }) => entry),
    );
    // A full start dedupes to it; a free start does not.
    expect(await start(s, "example.com", { mode: "full" })).toMatchObject({ deduped: true, issueId: legacy.issueId });
    expect((await start(s, "example.com", { mode: "free" })).deduped).toBe(false);
    // The legacy job can still report Treg problems.
    const result = await s.report({ step: "reading", site: "example.com", blocked: "treg_missing" }, { issueId: legacy.issueId });
    expect(result.error).toBeUndefined();
    const recent = await s.harness.getData<{ tasks: Array<{ issueId: string; mode: string | null }> }>("jobs", { companyId: COMPANY_ID });
    expect(recent.tasks.find((task) => task.issueId === legacy.issueId)?.mode).toBe("full");
  });

  it("a free task never becomes blocked on Treg or budget through report_step", async () => {
    const { issueId } = await start(s, "example.com", { mode: "free" });
    s.emitted.length = 0;
    const treg = await s.report({ step: "reading", site: "example.com", blocked: "treg_missing", detail: "Treg is not connected" }, { issueId });
    expect(treg.error).toMatch(/free task/);
    expect(treg.error).toMatch(/treg_missing/);
    const budget = await s.report({ step: "signals", site: "example.com", blocked: "budget" }, { issueId });
    expect(budget.error).toMatch(/free task/);
    expect(stateOf(s, issueId)).toMatchObject({ outcome: "running" });
    expect(stateOf(s, issueId).blocked).toBeUndefined();
    expect(s.emitted).toHaveLength(0);

    // Reading, signals (free-source pulls), building and publishing all still work.
    expect((await s.report({ step: "reading", site: "example.com", detail: "Reading the pricing page" }, { issueId })).error).toBeUndefined();
    // A reported spend on a free task is refused, not dropped.
    const spent = await s.report({ step: "signals", site: "example.com", detail: "Starting the free source pulls", spentUsd: 4 }, { issueId });
    expect(spent.error).toMatch(/free task/);
    expect(spent.error).toMatch(/spentUsd/);
    expect(stateOf(s, issueId).steps.signals.status).toBe("pending");
    expect((await s.report({ step: "signals", site: "example.com", detail: "Starting the free source pulls", spentUsd: 0 }, { issueId })).error).toBeUndefined();
    const job = stateOf(s, issueId);
    expect(job.steps.reading.status).toBe("done");
    expect(job.steps.signals).toMatchObject({ status: "active", detail: "Starting the free source pulls" });
    expect(job.spentUsd).toBeUndefined();
    expect((await s.report({ step: "signals", site: "example.com", blocked: "site_unreachable" }, { issueId })).error).toBeUndefined();
    expect(stateOf(s, issueId)).toMatchObject({ outcome: "blocked", blocked: "site_unreachable" });
  });

  it("quick and full tasks can still report treg_missing and budget", async () => {
    const quick = await start(s, "quick.com", { mode: "quick" });
    expect((await s.report({ step: "reading", site: "quick.com", blocked: "treg_missing" }, { issueId: quick.issueId })).error).toBeUndefined();
    const full = await start(s, "full.com", { mode: "full" });
    expect((await s.report({ step: "signals", site: "full.com", blocked: "budget", spentUsd: 3 }, { issueId: full.issueId })).error).toBeUndefined();
    expect(stateOf(s, full.issueId).spentUsd).toBe(3);
  });

  it("a follow-up inherits its blueprint's mode, and a free blueprint's follow-up makes no treg calls", async () => {
    const free = await start(s, "example.com", { mode: "free" });
    const followup = await s.harness.performAction<StartResult>("start-followup", { followupId: "find-buyers", site: "example.com", parentIssueId: free.issueId }, { companyId: COMPANY_ID });
    if (!followup.ok) throw new Error(followup.message);
    const text = (await s.harness.ctx.issues.get(followup.issueId, COMPANY_ID))!.description!;
    expect(text).toContain("Mode: free");
    expect(text).toContain("make no treg calls");
    const paid = await start(s, "paid.com", { mode: "full", capUsd: 4 });
    const paidFollowup = await s.harness.performAction<StartResult>("start-followup", { followupId: "find-buyers", site: "paid.com", parentIssueId: paid.issueId }, { companyId: COMPANY_ID });
    if (!paidFollowup.ok) throw new Error(paidFollowup.message);
    expect((await s.harness.ctx.issues.get(paidFollowup.issueId, COMPANY_ID))!.description).toContain("Data cap: $4.00");
  });
});

describe("follow-up dedupe across modes", () => {
  async function followup(s: Setup, parentIssueId: string, site = "example.com") {
    const result = await s.harness.performAction<StartResult>("start-followup", { followupId: "find-buyers", site, parentIssueId }, { companyId: COMPANY_ID });
    if (!result.ok) throw new Error(result.message);
    return result;
  }

  it("a free and a full blueprint on one site each get a follow-up in their own mode, linked to their own blueprint", async () => {
    const s = await setup();
    const free = await start(s, "example.com", { mode: "free" });
    const full = await start(s, "example.com", { mode: "full", capUsd: 8 });
    const fromFree = await followup(s, free.issueId);
    const fromFull = await followup(s, full.issueId);
    expect(fromFull.deduped).toBe(false);
    expect(fromFull.issueId).not.toBe(fromFree.issueId);
    expect((await s.harness.ctx.issues.get(fromFree.issueId, COMPANY_ID))!.description).toContain("Mode: free");
    const paidText = (await s.harness.ctx.issues.get(fromFull.issueId, COMPANY_ID))!.description!;
    expect(paidText).toContain("Mode: full");
    expect(paidText).toContain("Data cap: $8.00");
    expect(stateOf(s, free.issueId).followups?.["find-buyers"]?.issueId).toBe(fromFree.issueId);
    expect(stateOf(s, full.issueId).followups?.["find-buyers"]?.issueId).toBe(fromFull.issueId);
  });

  it("the reverse order keeps the modes apart too", async () => {
    const s = await setup();
    const full = await start(s, "example.com", { mode: "full" });
    const free = await start(s, "example.com", { mode: "free" });
    const fromFull = await followup(s, full.issueId);
    const fromFree = await followup(s, free.issueId);
    expect(fromFree.deduped).toBe(false);
    expect((await s.harness.ctx.issues.get(fromFree.issueId, COMPANY_ID))!.description).toContain("Mode: free");
    expect((await s.harness.ctx.issues.get(fromFull.issueId, COMPANY_ID))!.description).toContain("Mode: full");
  });

  it("a deduped follow-up is linked to the blueprint that asked again, without replacing an existing link", async () => {
    const s = await setup();
    const first = await start(s, "example.com", { mode: "full" });
    const other = await s.harness.ctx.issues.create({ companyId: COMPANY_ID, title: "Another full blueprint", assigneeAgentId: s.agentId });
    // A second full blueprint on the same site, created through the chat path.
    await s.report({ step: "reading", site: "example.com", mode: "full" }, { issueId: other.id });
    const created = await followup(s, first.issueId);
    expect(stateOf(s, other.id).followups).toBeUndefined();
    const again = await followup(s, other.id);
    expect(again).toMatchObject({ deduped: true, issueId: created.issueId });
    expect(stateOf(s, other.id).followups?.["find-buyers"]?.issueId).toBe(created.issueId);
    expect(stateOf(s, first.issueId).followups?.["find-buyers"]?.issueId).toBe(created.issueId);
  });
});

describe("chat tasks, mode and spend", () => {
  let s: Setup;
  beforeEach(async () => { s = await setup(); });

  async function chatTask() {
    return s.harness.ctx.issues.create({ companyId: COMPANY_ID, title: "Chat with Growth", assigneeAgentId: s.agentId });
  }

  it("the first report of a chat task can state a free mode, and the task is stored as free", async () => {
    const task = await chatTask();
    const result = await s.report({ step: "reading", site: "gamma.app", mode: "free" }, { issueId: task.id });
    expect(result.error).toBeUndefined();
    expect(stateOf(s, task.id)).toMatchObject({ mode: "free", capUsd: 0 });
    expect(result.data).toMatchObject({ mode: "free", capUsd: 0 });
    const recent = await s.harness.getData<{ tasks: Array<{ issueId: string; mode: string | null }> }>("jobs", { companyId: COMPANY_ID });
    expect(recent.tasks.find((t) => t.issueId === task.id)?.mode).toBe("free");
    // It is a free task for dedupe: a free start for the site returns it.
    const dup = await start(s, "gamma.app", { mode: "free" });
    expect(dup).toMatchObject({ deduped: true, issueId: task.id });
    // And it refuses Treg blocks like any free task.
    expect((await s.report({ step: "reading", site: "gamma.app", blocked: "treg_missing" }, { issueId: task.id })).error).toMatch(/free task/);
  });

  it("a chat task with no stated mode is stored as it was before: full with the default cap", async () => {
    const task = await chatTask();
    const result = await s.report({ step: "reading", site: "gamma.app" }, { issueId: task.id });
    expect(result.error).toBeUndefined();
    expect(stateOf(s, task.id).mode).toBeUndefined();
    expect(result.data).toMatchObject({ mode: "full", capUsd: 3 });
  });

  it("a chat task can state quick, which stores the quick default cap", async () => {
    const task = await chatTask();
    await s.report({ step: "reading", site: "gamma.app", mode: "quick" }, { issueId: task.id });
    expect(stateOf(s, task.id)).toMatchObject({ mode: "quick", capUsd: 0.6 });
  });

  it("a later report cannot change the mode or the cap", async () => {
    const { issueId } = await start(s, "example.com", { mode: "free" });
    const change = await s.report({ step: "reading", site: "example.com", mode: "full", capUsd: 10 }, { issueId });
    expect(change.error).toMatch(/free mode/);
    expect(stateOf(s, issueId)).toMatchObject({ mode: "free", capUsd: 0 });
    // capUsd is not a report_step argument: it is dropped and nothing changes.
    const capOnly = await s.report({ step: "reading", site: "example.com", capUsd: 10 }, { issueId });
    expect(capOnly.error).toBeUndefined();
    expect(stateOf(s, issueId)).toMatchObject({ mode: "free", capUsd: 0 });
    // Restating the stored mode is fine.
    expect((await s.report({ step: "signals", site: "example.com", mode: "free" }, { issueId })).error).toBeUndefined();

    const paid = await start(s, "paid.com", { mode: "quick", capUsd: 2 });
    expect((await s.report({ step: "reading", site: "paid.com", mode: "free" }, { issueId: paid.issueId })).error).toMatch(/quick mode/);
    expect(stateOf(s, paid.issueId)).toMatchObject({ mode: "quick", capUsd: 2 });
  });

  it("rejects an unknown mode", async () => {
    const task = await chatTask();
    expect((await s.report({ step: "reading", site: "gamma.app", mode: "huge" }, { issueId: task.id })).error).toMatch(/mode must be one of/);
    expect(s.harness.getState({ scopeKind: "issue", scopeId: task.id, namespace: STATE_NAMESPACE, stateKey: JOB_STATE_KEY })).toBeFalsy();
  });

  it("returns the stored mode and cap, and flags a spend over the cap without hiding it", async () => {
    const { issueId } = await start(s, "example.com", { mode: "quick", capUsd: 1 });
    const within = await s.report({ step: "signals", site: "example.com", spentUsd: 0.5 }, { issueId });
    expect(within.data).toMatchObject({ mode: "quick", capUsd: 1, overCap: false });
    expect(within.content).toContain("Stored mode: quick, data cap $1.00.");
    const over = await s.report({ step: "signals", site: "example.com", spentUsd: 1.4 }, { issueId });
    expect(over.error).toBeUndefined();
    expect(over.data).toMatchObject({ overCap: true });
    expect(over.content).toMatch(/over the data cap/);
    expect(stateOf(s, issueId).spentUsd).toBe(1.4);
  });
});

describe("report_step tool", () => {
  let s: Setup;
  let issueId: string;
  beforeEach(async () => {
    s = await setup();
    issueId = (await start(s, "example.com")).issueId;
    s.emitted.length = 0;
    s.harness.activity.length = 0;
  });

  it("takes the task from the run context, not from arguments", async () => {
    const decoy = await start(s, "decoy.com");
    s.emitted.length = 0;
    const result = await s.report({ step: "reading", site: "example.com", issueId: decoy.issueId }, { issueId });
    expect(result.error).toBeUndefined();
    expect(stateOf(s, issueId).steps.reading.status).toBe("active");
    expect(stateOf(s, decoy.issueId).steps.reading.status).toBe("pending");
  });

  it("rejects a call with no bound task even when arguments name one", async () => {
    const result = await s.report({ step: "reading", site: "example.com", issueId }, { issueId: null });
    expect(result.error).toMatch(/bound to a task/);
    expect(stateOf(s, issueId).steps.reading.status).toBe("pending");
    expect(s.emitted).toHaveLength(0);
  });

  it("rejects a site that does not match the task", async () => {
    const result = await s.report({ step: "reading", site: "other.com" }, { issueId });
    expect(result.error).toMatch(/example\.com/);
    expect(s.emitted).toHaveLength(0);
  });

  it("rejects a run from another agent or company", async () => {
    expect((await s.report({ step: "reading", site: "example.com" }, { issueId, agentId: randomUUID() })).error).toBeDefined();
    expect((await s.report({ step: "reading", site: "example.com" }, { issueId, companyId: OTHER_COMPANY_ID })).error).toBeDefined();
    expect(s.emitted).toHaveLength(0);
  });

  it("only moves forward", async () => {
    await s.report({ step: "building", site: "example.com" }, { issueId });
    const back = await s.report({ step: "reading", site: "example.com" }, { issueId });
    expect(back.error).toMatch(/forward/);
    const job = stateOf(s, issueId);
    expect(job.steps.building.status).toBe("active");
    expect(["computer", "reading", "signals"].every((step) => job.steps[step as "reading"].status === "done")).toBe(true);
  });

  it("rejects published without a matching HTML attachment on the task", async () => {
    const missing = await s.report({ step: "published", site: "example.com", attachmentId: randomUUID() }, { issueId });
    expect(missing.error).toMatch(/No attachment/);

    const pdf = attachment(issueId, { contentType: "application/pdf", originalFilename: "blueprint.pdf" });
    const otherTask = (await start(s, "elsewhere.com")).issueId;
    const elsewhere = attachment(otherTask);
    s.harness.seed({ issueAttachments: [pdf, elsewhere] });
    expect((await s.report({ step: "published", site: "example.com", attachmentId: pdf.id }, { issueId })).error).toMatch(/text\/html/);
    expect((await s.report({ step: "published", site: "example.com", attachmentId: elsewhere.id }, { issueId })).error).toMatch(/No attachment/);
    expect(stateOf(s, issueId).outcome).toBe("running");
  });

  it("publishes once the HTML attachment is on the task", async () => {
    const html = attachment(issueId, { contentType: "text/html; charset=utf-8", createdByAgentId: s.agentId });
    s.harness.seed({ issueAttachments: [html] });
    const result = await s.report({ step: "published", site: "example.com", attachmentId: html.id, spentUsd: 1.25 }, { issueId });
    expect(result.error).toBeUndefined();
    const job = stateOf(s, issueId);
    expect(job.outcome).toBe("ready");
    expect(job.spentUsd).toBe(1.25);
    expect(job.artifact).toEqual({ attachmentId: html.id, filename: "blueprint.html", contentType: "text/html", byteSize: 2048 });

    const view = await s.harness.getData<JobView>("job", { companyId: COMPANY_ID, issueId });
    expect(view.outcome).toBe("ready");
  });

  it("records blocked with its reason and shows it in the view", async () => {
    const result = await s.report({ step: "reading", site: "example.com", blocked: "treg_missing", detail: "Treg is not connected" }, { issueId });
    expect(result.error).toBeUndefined();
    const job = stateOf(s, issueId);
    expect(job).toMatchObject({ outcome: "blocked", blocked: "treg_missing" });
    expect(job.steps.reading).toMatchObject({ status: "active", detail: "Treg is not connected" });
    const view = await s.harness.getData<JobView>("job", { companyId: COMPANY_ID, issueId });
    expect(view.outcome).toBe("blocked");
    expect(s.harness.activity.at(-1)?.message).toBe("Growth blueprint blocked");
  });

  it("streams and logs once per change and stays quiet on no-ops", async () => {
    await s.report({ step: "reading", site: "example.com", detail: "Home page" }, { issueId });
    await s.report({ step: "reading", site: "example.com", detail: "Home page" }, { issueId });
    await s.report({ step: "reading", site: "example.com", detail: "Pricing page" }, { issueId });
    await s.report({ step: "signals", site: "example.com", spentUsd: 0.3 }, { issueId });
    expect(s.emitted).toHaveLength(3);
    expect(s.harness.activity).toHaveLength(3);
    expect(s.emitted.every((entry) => entry.channel === PROGRESS_STREAM_CHANNEL && entry.companyId === COMPANY_ID)).toBe(true);
    expect(s.emitted.map((entry) => entry.event.job.steps.reading.detail)).toEqual(["Home page", "Pricing page", "Pricing page"]);
    expect(s.emitted.at(-1)!.event.job.steps.signals.status).toBe("active");
  });

  it("adopts a chat task on the Growth agent's first report", async () => {
    const chatTask = await s.harness.ctx.issues.create({ companyId: COMPANY_ID, title: "Chat with Growth", assigneeAgentId: s.agentId });
    s.emitted.length = 0;
    const result = await s.report({ step: "reading", site: "gamma.app" }, { issueId: chatTask.id });
    expect(result.error).toBeUndefined();
    expect(stateOf(s, chatTask.id)).toMatchObject({ site: "gamma.app", agentId: s.agentId });
    expect(s.emitted).toHaveLength(1);
    const recent = await s.harness.getData<{ tasks: Array<{ issueId: string }> }>("jobs", { companyId: COMPANY_ID });
    expect(recent.tasks.map((task) => task.issueId)).toContain(chatTask.id);

    const stranger = await s.harness.ctx.issues.create({ companyId: COMPANY_ID, title: "Unrelated" });
    expect((await s.report({ step: "reading", site: "gamma.app" }, { issueId: stranger.id, agentId: randomUUID() })).error).toMatch(/Growth agent/);
  });
});

describe("follow-up tasks and asked detection", () => {
  it("refuses to adopt a follow-up task as a blueprint", async () => {
    const s = await setup();
    const parent = await start(s, "example.com");
    const followup = await s.harness.performAction<StartResult>("start-followup", { followupId: "compare-rivals", site: "example.com", parentIssueId: parent.issueId }, { companyId: COMPANY_ID });
    if (!followup.ok) throw new Error(followup.message);
    const result = await s.report({ step: "reading", site: "example.com" }, { issueId: followup.issueId });
    expect(result.error).toMatch(/follow-up/);
    expect(s.harness.getState({ scopeKind: "issue", scopeId: followup.issueId, namespace: STATE_NAMESPACE, stateKey: JOB_STATE_KEY })).toBeFalsy();
  });

  it("refuses a task whose origin is a follow-up even when the index has no entry", async () => {
    const s = await setup();
    const task = await s.harness.ctx.issues.create({
      companyId: COMPANY_ID,
      title: "Compare rivals",
      assigneeAgentId: s.agentId,
      originKind: `plugin:${manifest.id}:followup`,
    });
    expect((await s.report({ step: "reading", site: "example.com" }, { issueId: task.id })).error).toMatch(/follow-up/);
  });

  it("reads the newest comment when the host lists newest first", async () => {
    const s = await setup();
    const { issueId } = await start(s, "example.com");
    const job = stateOf(s, issueId);
    const base = Date.now() - 10 * 60_000;
    const comment = (id: string, body: string, minutes: number) => ({
      id, companyId: COMPANY_ID, issueId, authorType: "agent" as const, authorAgentId: job.agentId, authorUserId: null,
      body, presentation: null, metadata: null, createdAt: new Date(base + minutes * 60_000), updatedAt: new Date(base + minutes * 60_000),
    });
    // Newest first: the agent asked, then answered nothing newer. The oldest comment is a statement.
    s.harness.seed({ issueComments: [comment("c3", "Which plan do you want?", 3), comment("c2", "Working on it.", 2), comment("c1", "Started.", 1)] as never });
    const asked = await s.harness.getData<JobView>("job", { companyId: COMPANY_ID, issueId });
    expect(asked.outcome).toBe("asked");

    const s2 = await setup();
    const { issueId: issue2 } = await start(s2, "example.com");
    const job2 = stateOf(s2, issue2);
    const c = (id: string, body: string, minutes: number) => ({ ...comment(id, body, minutes), issueId: issue2, authorAgentId: job2.agentId });
    // Newest first: the newest is a statement, the older one a question.
    s2.harness.seed({ issueComments: [c("d2", "Done, thanks.", 2), c("d1", "Which plan do you want?", 1)] as never });
    const answered = await s2.harness.getData<JobView>("job", { companyId: COMPANY_ID, issueId: issue2 });
    expect(answered.outcome).toBe("running");
  });
});

describe("follow-ups and data", () => {
  it("starts a follow-up task, links it to the blueprint and dedupes it", async () => {
    const s = await setup();
    const parent = await start(s, "example.com");
    s.emitted.length = 0;
    const first = await s.harness.performAction<StartResult>("start-followup", { followupId: "compare-rivals", site: "example.com", parentIssueId: parent.issueId }, { companyId: COMPANY_ID });
    if (!first.ok) throw new Error(first.message);
    const issue = await s.harness.ctx.issues.get(first.issueId, COMPANY_ID);
    expect(issue?.title).toBe("Compare example.com with two rivals");
    expect(stateOf(s, parent.issueId).followups?.["compare-rivals"]?.issueId).toBe(first.issueId);
    expect(s.emitted).toHaveLength(1);

    const again = await s.harness.performAction<StartResult>("start-followup", { followupId: "compare-rivals", site: "example.com", parentIssueId: parent.issueId }, { companyId: COMPANY_ID });
    expect(again).toMatchObject({ ok: true, deduped: true, issueId: first.issueId });
    // A follow-up with no blueprint behind it is free, so it is not the full blueprint's follow-up.
    const bare = await s.harness.performAction<StartResult>("start-followup", { followupId: "compare-rivals", site: "example.com" }, { companyId: COMPANY_ID });
    expect(bare).toMatchObject({ ok: true, deduped: false });
    const unknown = await s.harness.performAction<StartResult>("start-followup", { followupId: "nope", site: "example.com" }, { companyId: COMPANY_ID });
    expect(unknown).toMatchObject({ ok: false, reason: "unknown_followup" });
  });

  it("scopes job reads to the company", async () => {
    const s = await setup();
    const { issueId } = await start(s, "example.com");
    expect(await s.harness.getData("job", { companyId: OTHER_COMPANY_ID, issueId })).toBeNull();
    expect(await s.harness.getData("jobs", { companyId: OTHER_COMPANY_ID })).toEqual({ tasks: [] });
  });
});

describe("concurrency and provenance (review repros)", () => {
  function delayStateSet(s: Setup, match: (key: { scopeKind: string }, value: unknown) => boolean, ms: number) {
    const original = s.harness.ctx.state.set.bind(s.harness.ctx.state);
    s.harness.ctx.state.set = async (key, value) => {
      if (match(key, value)) await new Promise((resolve) => setTimeout(resolve, ms));
      return original(key, value);
    };
  }

  it("a late step report cannot undo a concurrent publish", async () => {
    const s = await setup();
    const { issueId } = await start(s, "example.com");
    await s.report({ step: "building", site: "example.com" }, { issueId });
    const html = attachment(issueId, { createdByAgentId: s.agentId });
    s.harness.seed({ issueAttachments: [html] });
    delayStateSet(s, (key, value) => key.scopeKind === "issue" && (value as BlueprintJob | null)?.steps?.building?.detail === "late", 30);
    await Promise.all([
      s.report({ step: "published", site: "example.com", attachmentId: html.id }, { issueId }),
      s.report({ step: "building", site: "example.com", detail: "late" }, { issueId }),
    ]);
    const job = stateOf(s, issueId);
    expect(job.outcome).toBe("ready");
    expect(job.steps.published.status).toBe("done");
    expect(job.artifact?.attachmentId).toBe(html.id);
  });

  it("two concurrent starts for one site create one task", async () => {
    const s = await setup();
    const [a, b] = await Promise.all([start(s, "gamma.com"), start(s, "gamma.com")]);
    expect(a.issueId).toBe(b.issueId);
    expect([a.deduped, b.deduped].sort()).toEqual([false, true]);
  });

  it("gives every task its own job id", async () => {
    const s = await setup();
    const first = await start(s, "gamma.com");
    s.harness.seed({ issues: [{ ...(await s.harness.ctx.issues.get(first.issueId, COMPANY_ID))!, status: "cancelled" }] });
    const second = await start(s, "gamma.com");
    expect(second.issueId).not.toBe(first.issueId);
    expect(stateOf(s, second.issueId).jobId).not.toBe(stateOf(s, first.issueId).jobId);
  });

  it("concurrent starts for different sites keep both index entries", async () => {
    const s = await setup();
    delayStateSet(s, (key) => key.scopeKind === "company", 20);
    await Promise.all([start(s, "alpha.com"), start(s, "beta.com")]);
    const recent = await s.harness.getData<{ tasks: Array<{ site: string }> }>("jobs", { companyId: COMPANY_ID });
    expect(recent.tasks.map((task) => task.site).sort()).toEqual(["alpha.com", "beta.com"]);
  });

  it("links a follow-up only to a blueprint for the same site, with an activity entry", async () => {
    const s = await setup();
    const parent = await start(s, "example.com");
    const mismatch = await s.harness.performAction<StartResult>("start-followup", { followupId: "compare-rivals", site: "other.com", parentIssueId: parent.issueId }, { companyId: COMPANY_ID });
    expect(mismatch).toMatchObject({ ok: false, reason: "invalid_parent" });
    expect(stateOf(s, parent.issueId).followups).toBeUndefined();

    s.harness.activity.length = 0;
    const linked = await s.harness.performAction<StartResult>("start-followup", { followupId: "compare-rivals", site: "example.com", parentIssueId: parent.issueId }, { companyId: COMPANY_ID });
    if (!linked.ok) throw new Error(linked.message);
    expect(stateOf(s, parent.issueId).followups?.["compare-rivals"]?.issueId).toBe(linked.issueId);
    expect(s.harness.activity.some((entry) => entry.entityId === parent.issueId)).toBe(true);
  });

  it("publishes only an attachment the Growth agent uploaded during this task", async () => {
    const s = await setup();
    const { issueId } = await start(s, "example.com");
    const byUser = attachment(issueId, { createdByAgentId: null, createdByUserId: randomUUID() });
    const stale = attachment(issueId, { createdByAgentId: s.agentId, createdAt: new Date(Date.parse(stateOf(s, issueId).startedAt) - 60_000) });
    s.harness.seed({ issueAttachments: [byUser, stale] });
    expect((await s.report({ step: "published", site: "example.com", attachmentId: byUser.id }, { issueId })).error).toMatch(/Growth/);
    expect((await s.report({ step: "published", site: "example.com", attachmentId: stale.id }, { issueId })).error).toMatch(/before this task/);
    expect(stateOf(s, issueId).outcome).toBe("running");
  });
});

describe("run lifecycle events", () => {
  let s: Setup;
  let issueId: string;
  beforeEach(async () => {
    s = await setup();
    issueId = (await start(s, "example.com")).issueId;
    s.emitted.length = 0;
    s.harness.activity.length = 0;
  });

  function runEvent(type: "agent.run.started" | "agent.run.finished" | "agent.run.failed" | "agent.run.cancelled", overrides: Record<string, unknown> = {}, companyId = COMPANY_ID) {
    const runId = (overrides.runId as string | undefined) ?? randomUUID();
    return s.harness.emit(type, {
      runId,
      agentId: s.agentId,
      status: type === "agent.run.started" ? "running" : "failed",
      error: "secret error text",
      errorCode: null,
      issueId,
      startedAt: null,
      finishedAt: null,
      ...overrides,
    }, { companyId, entityId: runId });
  }

  const outcomeOf = async () => (await s.harness.getData<JobView>("job", { companyId: COMPANY_ID, issueId }))!.outcome;

  it("started advances computer to reading, records the run, one emit and one log", async () => {
    await runEvent("agent.run.started", { runId: "run-1" });
    const job = stateOf(s, issueId);
    expect(job.steps.computer.status).toBe("done");
    expect(job.steps.reading).toMatchObject({ status: "active", detail: "Growth started working" });
    expect(job.lastRunId).toBe("run-1");
    expect(s.emitted).toHaveLength(1);
    expect(s.harness.activity).toHaveLength(1);
    // Repeating the same event is a no-op.
    await runEvent("agent.run.started", { runId: "run-1" });
    expect(s.emitted).toHaveLength(1);
    expect(s.harness.activity).toHaveLength(1);
  });

  it("started after a later reported step does not move backward", async () => {
    await s.report({ step: "building", site: "example.com" }, { issueId });
    s.emitted.length = 0;
    s.harness.activity.length = 0;
    await runEvent("agent.run.started", { runId: "run-1" });
    const job = stateOf(s, issueId);
    expect(job.steps.building.status).toBe("active");
    expect(job.steps.reading.status).toBe("done");
    expect(job.steps.reading.detail).toBeUndefined();
  });

  it("failed gives a failed outcome without storing error text; a new start clears it", async () => {
    await runEvent("agent.run.started", { runId: "run-1" });
    s.emitted.length = 0;
    s.harness.activity.length = 0;
    await runEvent("agent.run.failed", { runId: "run-1", errorCode: "adapter_failed" });
    expect(stateOf(s, issueId).runEnded).toMatchObject({ status: "failed", errorCode: "adapter_failed" });
    expect(await outcomeOf()).toBe("failed");
    expect(s.emitted).toHaveLength(1);
    expect(s.harness.activity).toHaveLength(1);
    expect(JSON.stringify([stateOf(s, issueId), s.harness.activity])).not.toContain("secret error text");

    await runEvent("agent.run.started", { runId: "run-2" });
    expect(stateOf(s, issueId).runEnded).toBeUndefined();
    expect(await outcomeOf()).toBe("running");
  });

  it("cancelled gives a failed outcome", async () => {
    await runEvent("agent.run.cancelled", { status: "cancelled" });
    expect(stateOf(s, issueId).runEnded?.status).toBe("cancelled");
    expect(await outcomeOf()).toBe("failed");
  });

  it("finished without a published step is unpublished; finished after publishing changes nothing", async () => {
    await runEvent("agent.run.finished", { status: "succeeded" });
    expect(stateOf(s, issueId).runEnded?.status).toBe("succeeded_unpublished");
    expect(await outcomeOf()).toBe("unpublished");

    const issue2 = (await start(s, "done.com")).issueId;
    const file = attachment(issue2, { createdByAgentId: s.agentId });
    s.harness.seed({ issueAttachments: [file] });
    await s.report({ step: "published", site: "done.com", attachmentId: file.id }, { issueId: issue2 });
    s.emitted.length = 0;
    await s.harness.emit("agent.run.finished", { runId: randomUUID(), agentId: s.agentId, status: "succeeded", issueId: issue2 }, { companyId: COMPANY_ID });
    await s.harness.emit("agent.run.failed", { runId: randomUUID(), agentId: s.agentId, status: "failed", issueId: issue2 }, { companyId: COMPANY_ID });
    expect(stateOf(s, issue2).runEnded).toBeUndefined();
    expect(stateOf(s, issue2).outcome).toBe("ready");
    expect(s.emitted).toHaveLength(0);
  });

  it("an end event from an older run is ignored once a newer run started", async () => {
    await runEvent("agent.run.started", { runId: "run-2" });
    s.emitted.length = 0;
    await runEvent("agent.run.failed", { runId: "run-1" });
    expect(stateOf(s, issueId).runEnded).toBeUndefined();
    expect(s.emitted).toHaveLength(0);
  });

  it("ignores other agents, other companies, follow-up tasks and unknown tasks", async () => {
    await runEvent("agent.run.started", { agentId: randomUUID() });
    await runEvent("agent.run.started", {}, OTHER_COMPANY_ID);
    await runEvent("agent.run.started", { issueId: randomUUID() });
    await runEvent("agent.run.started", { issueId: null });
    const followup = await s.harness.performAction<StartResult>("start-followup", { followupId: "compare-rivals", site: "example.com" }, { companyId: COMPANY_ID });
    if (!followup.ok) throw new Error(followup.message);
    s.emitted.length = 0;
    s.harness.activity.length = 0;
    await runEvent("agent.run.started", { issueId: followup.issueId });
    await runEvent("agent.run.failed", { issueId: followup.issueId });
    expect(stateOf(s, issueId).steps.computer.status).toBe("active");
    expect(stateOf(s, issueId).lastRunId).toBeUndefined();
    expect(s.emitted).toHaveLength(0);
    expect(s.harness.activity).toHaveLength(0);
  });
});
