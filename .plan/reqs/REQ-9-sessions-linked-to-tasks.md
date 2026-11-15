---
id: REQ-9
title: Sessions linked to tasks
epic: EPIC-3
spec: SPEC-12
status: in-progress
readiness: 4
effort: med
readiness_gaps: ["implementation drafted against approved snapshot; final acceptance and ordered independent reviews pending"]
blocked_by: [REQ-5, REQ-7]
blocks: [REQ-10, REQ-11]
priority: P1
source: BRIEF-1
change:
stack: Paperclip plugin (database namespace, tools, task tab, dashboard widget), extension library
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-9 — Sessions linked to tasks

## Overview

A session can be linked to one or more Paperclip tasks. The task page gains a Sessions tab that
lists its linked sessions with their current state and an Open button. The session, in Threadkeeper,
lists its tasks. Paperclip's dashboard gains a "Sessions needing you" list. The founder links by
hand; agents link with a tool.

## Problem Statement

The founder gets "very scattered with all of the tasks" (CTX-1) because nothing says which browser
session belongs to which piece of work. Paperclip has tasks; Threadkeeper has sessions; the only
connection today is a set of automatic cross-links Threadkeeper derives for Paperclip tasks and
coding sessions (`linkedThreadKeys`, `src/entrypoints/manager/PaperclipLinks.tsx`) that Paperclip
never sees.

## Solution

Store links on the Paperclip side, in the plugin's database namespace, because they are company work
data and should survive an extension reinstall. The extension mirrors them into the existing
`linkedThreadKeys` so Threadkeeper's own views keep working. The plugin contributes a task tab and a
dashboard widget; both read the inventory from REQ-7.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-3-agents-work-with-browser-sessions.md`; REQ-7 (inventory, company boundary, the `thread.open` request); REQ-5 (a linked task opens in the Paperclip view, FR-4). REQ-6 is not needed.
- Context: `context/platform.md` (APIs "Plugin UI slots"; Data model "Conversation", "Plugin storage"; Threadkeeper "Agent state"); CTX-1.
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: not required once the two gaps in Readiness are closed.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: Links are stored by the plugin, keyed by company, task and thread key | Plugin database namespace (`ctx.db`, `packages/plugins/sdk/src/types.ts:2230`) `[verified]` | assumed | FR-1 / AC-1, AC-2 | Company work data; survives extension reinstall |
| D-2: The extension mirrors a task's links into `linkedThreadKeys` of that task's library thread | Field exists and is shown by `PaperclipLinks.tsx` `[verified: scan]` | assumed | FR-4 / AC-6 | Reuses the existing display |
| D-3: Links Threadkeeper derives automatically are written as links with origin `auto`; the founder can remove them and they are not re-created for that pair | Existing derivation in `src/core/paperclip/mapper.ts` `[verified: scan]` | assumed | FR-1 / AC-3 | Keeps today's behaviour visible in Paperclip |
| D-4: The founder links from either product; agents link with `session_link` and `session_unlink`, open to the same agents as the read tools, and only to the task their own run is working on. Links made by agents (origin `agent`) never let any agent act on the session (REQ-11 D-8) | REQ-8 D-4; independent review finding 1 (2026-11-13) | assumed | FR-2 / AC-4, AC-10, AC-11 | Linking reveals nothing new and is easy to undo; keeping agent links out of acting scope stops an agent from widening its own reach |
| D-5: A session may be linked to several tasks and a task to several sessions, in one company; at most 50 sessions per task | Planner's choice | assumed | FR-1 / AC-2 | Bounds the task tab |
| D-6: The task tab is a plugin `detailTab` for tasks; the dashboard list is a plugin `dashboardWidget` | Slot types exist (`packages/shared/src/constants.ts:1510-1528`) `[verified]` | assumed | FR-3, FR-5 / AC-5, AC-7 | Existing extension points |
| D-7: "Needs you" means agent state `waiting_permission`, `waiting_answer`, `failed` or `signed_out` | Agent state values (`src/core/embed/agent-state.ts:82-91`) `[verified: scan]` | assumed | FR-5 / AC-7 | The states where only the founder can unblock |
| D-8: Opening a session from Paperclip uses the existing `thread.open` request | Request type exists (`src/core/dock/protocol.ts:54`) `[verified]` | assumed | FR-3 / AC-5 | No new mechanism |

## UI Layout

- Task page, new tab `Sessions`:
  - One row per linked session: provider label, account label, title, state label, "last seen" time, buttons `Open` and `Unlink`.
  - State labels are Threadkeeper's: `Running`, `Needs approval`, `Needs your answer`, `Finished`, `Failed`, `Idle`, `Signed out`, `Not observed`.
  - Button `Link a session` opens a picker with search over the shared sessions.
  - Empty: `No sessions linked to this task.`
  - Browser not connected: rows show their last known state with `Last seen {relative time}`, and `Open` is disabled with the hint `Open the browser to use this.`
- Paperclip dashboard, widget `Sessions needing you`: up to 10 rows (title, provider, state, linked task if any), newest state change first; footer `View all` leads to Threads. Empty: `Nothing needs you.`
- Threadkeeper thread detail: the existing links area lists linked tasks with their Paperclip status; `Link to a task` opens a task picker.

## Functional Requirements

### FR-1: Create, list and remove links

The plugin SHALL store a link as company, task, thread key, origin (`user`, `agent` or `auto`),
creator and time, and SHALL list and remove links.

- Decision/source: D-1, D-3, D-5.

#### Scenario: positive
- GIVEN a task and a shared session in the same company
- WHEN the founder links them
- THEN the link exists once, with origin `user`

#### Scenario: negative
- GIVEN a thread key that is not in that company's inventory
- WHEN a link is requested
- THEN it is refused with `not_found` and nothing is stored

#### Scenario: edge
- GIVEN the same pair is linked twice, or a task already has 50 links
- WHEN a link is requested
- THEN the first case leaves one link, and the second is refused with `too_many_links: a task can have at most 50 sessions`

### FR-2: Agent tools

The plugin SHALL offer `session_link` and `session_unlink`, acting only on the task the agent's run
is working on.

- Decision/source: D-4.
- Exact contract values: input `{ threadKey: string, issueId?: string }`. The task is the one the agent's run is working on. An `issueId` naming any other task returns `error: "denied: Agents can link sessions only to the task they are working on."`. A run with no task returns `error: "bad_request: A task is required to link a session."`. Links made through these tools have origin `agent`.

#### Scenario: positive
- GIVEN an agent working on task T finds a relevant session with `sessions_search`
- WHEN it calls `session_link` with that thread key
- THEN T's Sessions tab lists the session with origin `agent`

#### Scenario: negative
- GIVEN `issueId` of a task other than the one the agent's run is working on, in this company or another
- WHEN the agent calls `session_link`
- THEN it gets `error: "denied: Agents can link sessions only to the task they are working on."` and nothing is stored

#### Scenario: edge
- GIVEN the link was created by the founder
- WHEN an agent calls `session_unlink`
- THEN the link is removed and the activity entry names the agent

### FR-3: Task tab

The task page SHALL show a `Sessions` tab listing linked sessions with state and actions.

- Decision/source: D-6, D-8.

#### Scenario: positive
- GIVEN a task with two linked sessions, one `Running`
- WHEN the founder opens the tab in the extension window and presses `Open` on it
- THEN the session opens in Browse

#### Scenario: negative
- GIVEN the browser is not connected
- WHEN the tab is opened
- THEN rows show the last known state and time, and `Open` is disabled with `Open the browser to use this.`

#### Scenario: edge
- GIVEN a linked session was deleted from the library or became private
- WHEN the tab is opened
- THEN its row reads `Session no longer available` with only `Unlink`

### FR-4: The session shows its tasks

The extension SHALL show, on a thread, the tasks it is linked to, and SHALL let the founder link the
thread to a task.

- Decision/source: D-2.

#### Scenario: positive
- GIVEN a session linked to task T in Paperclip
- WHEN the founder opens the thread in Threads
- THEN T is listed with its Paperclip status and opens in the Paperclip view when clicked

#### Scenario: negative
- GIVEN Paperclip is not `running`
- WHEN the founder presses `Link to a task`
- THEN the picker shows `Paperclip is not running.` and nothing is stored

#### Scenario: edge
- GIVEN a link is removed in Paperclip
- WHEN the bridge next syncs
- THEN the thread no longer lists that task within 10 s

### FR-5: Sessions needing you

Paperclip's dashboard SHALL list shared sessions whose agent state is one of D-7.

- Decision/source: D-6, D-7.

#### Scenario: positive
- GIVEN three shared sessions in `Needs your answer` and one `Running`
- WHEN the founder opens Paperclip's dashboard
- THEN the widget lists the three, newest change first

#### Scenario: negative
- GIVEN the company has no grant
- WHEN the dashboard renders
- THEN the widget shows `Sessions are not shared with this company.`

#### Scenario: edge
- GIVEN 25 sessions need the founder
- WHEN the widget renders
- THEN it shows 10 and `View all (25)`

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Link propagation | 10 s or less from a link change in one product to the other showing it | Bridge connected | Timed manual run |
| Task tab load | 1 s or less for a task with 50 links | Local server | Timed with seeded data |

## Constraints from platform

- Auth / access / ownership: links are company-scoped; a link may only join a task and a session row of the same company (REQ-7 FR-5). Capabilities: `issues.read`, `database.namespace.read`, `database.namespace.write`, `agent.tools.register`, `ui.detailTab.register`, `ui.dashboardWidget.register`, `activity.log.write`.
- API / types: `PluginUiSlotDeclaration.entityTypes` for the task tab (`packages/shared/src/types/plugin.ts:491-535`); `ToolRunContext` has `agentId`, `runId`, `companyId`, `projectId` and no task id (`packages/plugins/sdk/src/types.ts:267-279`) `[verified]`, so FR-2's default task must be looked up from the run.
- Cache: N/A.
- Files to extend, not reinvent: the plugin package; `extension/src/entrypoints/manager/PaperclipLinks.tsx`; `extension/src/core/paperclip/mapper.ts`; the bridge from REQ-7.
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: existing `linkedThreadKeys` values are kept and sent once as `auto` links when this REQ ships.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| none | | | |

## Out of scope

- Comments or wake-ups when a session changes state — REQ-10.
- Linking sessions to projects or goals.
- Filter and sort controls in the widget.

## Acceptance Criteria

- **AC-1** Given a task and a shared session in the same company, When the founder links them from the task's `Sessions` tab, Then the tab lists the session with its provider label, account label, title and state label, and the plugin stores one link with origin `user`.
- **AC-2** Given the same pair is linked a second time, When the request is handled, Then one link exists; and Given a task with 50 links, When a 51st is requested, Then it is refused with `too_many_links: a task can have at most 50 sessions`.
- **AC-3** Given Threadkeeper already cross-links a Paperclip task and a coding session, When this REQ first syncs, Then the plugin holds that link with origin `auto`; and Given the founder removes it, When the next sync runs, Then it is not created again.
- **AC-4** Given an agent working on task T, When it calls `session_link` with a shared session's thread key and no `issueId`, Then T's `Sessions` tab lists that session with origin `agent` and Paperclip's activity log has one entry naming the agent.
- **AC-5** Given a task with a linked session and the extension window open, When the founder presses `Open` on its row, Then the session is shown in Browse; and Given the browser is not connected, Then `Open` is disabled and the row shows `Last seen ` followed by a relative time.
- **AC-6** Given a session linked to task T, When the founder opens that thread in Threads, Then T is listed with its Paperclip status; and Given the link is removed in Paperclip, Then the thread no longer lists T within 10 s.
- **AC-7** Given three shared sessions in state `Needs your answer` and one `Running`, When the founder opens Paperclip's dashboard, Then `Sessions needing you` lists exactly the three, newest state change first; and Given 25 such sessions, Then it lists 10 and shows `View all (25)`.
- **AC-8** Given a thread key that is not in the company's inventory, When a link is requested by the founder or an agent, Then it is refused with `not_found` and nothing is stored.
- **AC-9** Given a linked session that was deleted or became private, When the task's `Sessions` tab is opened, Then its row reads `Session no longer available` and offers only `Unlink`.
- **AC-10** Given an agent whose run has no task, When it calls `session_link`, Then it gets `error: "bad_request: A task is required to link a session."` and nothing is stored.
- **AC-11** Given an agent working on task T, When it calls `session_link` with the `issueId` of another task, Then it gets `error: "denied: Agents can link sessions only to the task they are working on."` and nothing is stored.

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-1, D-3, D-5 | linked / not in inventory / duplicate and limit | AC-1, AC-2, AC-3, AC-8 | Plugin worker tests |
| FR-2 | D-4 | agent links / other task / agent unlinks | AC-4, AC-8, AC-10, AC-11 | Plugin tool tests; one manual run with a real agent |
| FR-3 | D-6, D-8 | open / browser offline / session gone | AC-5, AC-9 | Plugin UI test; observation in the extension window |
| FR-4 | D-2 | tasks listed / Paperclip down / link removed | AC-6 | Extension tests beside `tests/unit/paperclip-mapper.test.ts`; timed manual run |
| FR-5 | D-6, D-7 | listed / no grant / more than ten | AC-7 | Plugin UI test with seeded rows |

## Readiness

| Dimension | Current assessment |
|---|---|
| Problem and goal | yes: the full implementation request adopts the plan defaults; the current-snapshot alternative is explicitly approved |
| Behavior contract | yes: the original FRs and ACs remain authoritative, with the recorded snapshot and switching-fallback decisions |
| Acceptance criteria | yes: TASK-1 owns the original AC IDs and text; missing runtime evidence remains visible |
| Context and constraints | partial: the current integration is mapped in `context/implementation.md`; historical pre-merge line citations remain reference material |
| Buildability | yes: source, package dependencies, interfaces and targeted regression checks exist |

**Score: 4/5.** This is implementation readiness, not completion or an acceptance pass.
The requirement and TASK are in progress. Dependency outcomes, current all-AC evidence,
ordered independent reviews and completion gates remain necessary before `done`.
No historical load-gate success is inferred from the existence of drafted code.

The founder approved using the current working snapshot and installing pinned dependencies.
The original checkout, live extension folder and user instance remain outside deployment scope.
Fused-layout acceptance is conditional on its spike; this implementation uses the documented
view-switching fallback. Real provider delivery and real launchd registration are not claimed.
See `verify/implementation-checkpoint.md`, the final validation report and independent review
reports for concrete source and evidence. Historical authored-plan review remains at
`verify/artifacts/plan-review.md`.

## Changelog

| Date | Change |
|---|---|
| 2026-11-13 | Initial specify |
| 2026-11-13 | Task identity is derived by the gateway and passed to plugin tool context; agents cannot grant action authority by adding links. Final link/task/thread/dashboard and automatic-link removal proof remains pending. |
