import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import { growthAgentInstructionFiles, growthSkillFiles, growthSkillMarkdown } from "./assets.js";
import {
  AGENT_REPORTED_STEPS,
  BLOCK_REASONS,
  BLUEPRINT_MODES,
  DETAIL_MAX_CHARS,
  GROWTH_AGENT_KEY,
  GROWTH_PROJECT_KEY,
  GROWTH_SKILL_KEY,
  PLUGIN_ID,
  PLUGIN_VERSION,
  REPORT_STEP_TOOL,
} from "./contracts.js";

export { GROWTH_AGENT_KEY, GROWTH_PROJECT_KEY, GROWTH_SKILL_KEY, PLUGIN_ID, REPORT_STEP_TOOL };

/** Monthly model budget for the managed Growth agent, in cents. Treg spend is capped per task by the skill. */
export const GROWTH_AGENT_BUDGET_MONTHLY_CENTS = 2000;

/** Canonical company-skill key the host assigns to the managed skill. */
export const GROWTH_SKILL_CANONICAL_KEY = `plugin/${PLUGIN_ID}/${GROWTH_SKILL_KEY}`;

const agentInstructionFiles = growthAgentInstructionFiles();

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Growth",
  description: "A managed Growth agent studies a website from public evidence and attaches a one-page growth blueprint to the task, with live step progress.",
  author: "Paperclip + Threadkeeper",
  categories: ["automation", "ui"],
  capabilities: [
    "skills.managed",
    "agents.managed",
    "projects.managed",
    "issues.read",
    "issues.create",
    "issues.wakeup",
    "issue.comments.read",
    "issue.attachments.read",
    "agent.tools.register",
    "plugin.state.read",
    "plugin.state.write",
    "events.subscribe",
    "activity.log.write",
    "ui.page.register",
    "ui.sidebar.register",
  ],
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  agents: [
    {
      agentKey: GROWTH_AGENT_KEY,
      displayName: "Growth",
      role: "researcher",
      title: "Growth researcher",
      icon: "telescope",
      capabilities: "Studies a website from public evidence and attaches a one-page growth blueprint to the task.",
      adapterType: "claude_local",
      adapterPreference: ["claude_local"],
      adapterConfig: {
        dangerouslySkipPermissions: false,
        dangerouslyBypassApprovalsAndSandbox: false,
        sandbox: true,
        paperclipSkillSync: {
          desiredSkills: [GROWTH_SKILL_CANONICAL_KEY],
        },
      },
      // Growth reads untrusted web pages, so it must not be able to hire
      // agents or author skills. Without these explicit denials the host's
      // create-time defaults grant both.
      permissions: {
        canCreateAgents: false,
        canCreateSkills: false,
      },
      status: "paused",
      budgetMonthlyCents: GROWTH_AGENT_BUDGET_MONTHLY_CENTS,
      instructions: {
        entryFile: "AGENTS.md",
        content: agentInstructionFiles["AGENTS.md"] ?? "",
        files: agentInstructionFiles,
        assetPath: "agents/growth",
      },
    },
  ],
  projects: [
    {
      projectKey: GROWTH_PROJECT_KEY,
      displayName: "Growth blueprints",
      description: "Tasks for the Growth agent: one task per website blueprint, plus follow-up research tasks.",
      status: "in_progress",
    },
  ],
  skills: [
    {
      skillKey: GROWTH_SKILL_KEY,
      displayName: "Growth blueprint",
      slug: GROWTH_SKILL_KEY,
      description: "Build a growth blueprint for one website from public evidence, report each step, and attach the HTML page to the task.",
      markdown: growthSkillMarkdown(),
      files: growthSkillFiles(),
    },
  ],
  tools: [
    {
      name: REPORT_STEP_TOOL,
      displayName: "Report blueprint step",
      description: "Report progress on the growth blueprint for the task bound to this run. The task, agent and company come from the run, never from arguments. The result returns the stored mode and data cap: follow those over the task text. Steps only move forward. Report published only after blueprint.html is attached to this task, and pass its attachmentId.",
      parametersSchema: {
        type: "object",
        properties: {
          step: { type: "string", enum: [...AGENT_REPORTED_STEPS] },
          site: { type: "string", minLength: 3, maxLength: 253, description: "The task's website as a bare host, for example example.com." },
          detail: { type: "string", maxLength: DETAIL_MAX_CHARS, description: "Short plain-text note shown under the step." },
          spentUsd: { type: "number", minimum: 0, description: "Treg spend on this task so far, in US dollars. Leave out on a free task: a free task rejects a value above 0." },
          mode: { type: "string", enum: [...BLUEPRINT_MODES], description: "The run's mode. Pass it only on the first report of a task started in a chat, so the task is stored in that mode. It cannot change later." },
          blocked: { type: "string", enum: [...BLOCK_REASONS] },
          attachmentId: { type: "string", description: "Required for published: the id of the HTML attachment on this task." },
        },
        required: ["step", "site"],
      },
    },
  ],
  ui: {
    slots: [
      {
        type: "sidebar",
        id: "growth-sidebar",
        displayName: "Growth",
        exportName: "GrowthSidebarLink",
        order: 36,
      },
      {
        type: "page",
        id: "growth-page",
        displayName: "Growth",
        exportName: "GrowthPage",
        routePath: "growth",
      },
    ],
  },
};

export default manifest;
