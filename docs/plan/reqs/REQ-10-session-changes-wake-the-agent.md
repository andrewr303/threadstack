---
id: REQ-10
title: Session changes reach the task and wake its agent
epic: EPIC-3
spec: SPEC-13
status: blocked
readiness: 3
effort: med
readiness_gaps: ["blocked by REQ-9", "plugin calls for adding a comment and requesting a wake-up not yet read", "agent state detection may change with the multi-profile work"]
blocked_by: [REQ-9]
blocks: []
priority: P1
source: BRIEF-1
change:
stack: extension agent-state reporting, Paperclip plugin (events, task comments, wake-ups)
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-10 — Session changes reach the task and wake its agent

## Overview

When a session linked to a task finishes, fails, or waits for the founder, the task gets one comment
saying so and the agent assigned to the task is woken, so it can read the session and continue. The
founder sees the same change in Paperclip without checking each session.

## Problem Statement

Coding sessions on provider sites finish or stall while the founder is elsewhere. Threadkeeper can
see a loaded session's state (`src/core/embed/agent-state.ts`), but Paperclip and its agents learn
nothing from it, so tasks wait until the founder notices.

## Solution

The extension already detects state from a page's visible controls. On each settled change of a
shared session it sends an event over the bridge. The plugin, for each task linked to that session,
adds one comment and requests a wake-up for the assigned agent, with limits so a flapping page
cannot flood a task or spend the agent's budget.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-3-agents-work-with-browser-sessions.md`; REQ-7 (bridge); REQ-9 (links).
- Context: `context/platform.md` (Threadkeeper "Agent state"; APIs "Plugin events"; Paperclip "Agents"); CTX-3 (status models).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: not required once the gap in Readiness is closed.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: States come only from what a loaded page shows; a session that is not loaded produces no event | "never a claim about work on the provider's servers" (`docs/architecture.md:83-85`) `[verified]`; detection runs for coding-agent providers only (`src/entrypoints/content.ts:451-453`) `[verified: scan]` | agreed (existing behaviour) | FR-1, FR-5 / AC-1, AC-8 | No false claims |
| D-2: An event is sent when the state has been the same for 5 s and differs from the last one sent | Planner's choice | assumed | FR-1 / AC-1, AC-2 | Pages flicker between states while loading |
| D-3: Changes that produce a task comment: to `turn_complete`, `failed`, `waiting_permission`, `waiting_answer`, `signed_out` | State values (`src/core/embed/agent-state.ts:82-91`) `[verified: scan]` | assumed | FR-2 / AC-3 | A change to `running` or `idle` needs nobody |
| D-4: Changes that wake the assigned agent: to `turn_complete` and `failed` | Planner's choice | assumed | FR-3 / AC-4 | In the two waiting states only the founder can act (acting agents are REQ-11) |
| D-5: Limits: at most 6 comments per session per task per hour, and at most 1 wake-up per task per 10 minutes from session events | Planner's choice; Paperclip coalesces wake-ups for a running agent (`paperclip/doc/spec/agents-runtime.md`) `[verified: scan]` | assumed | FR-4 / AC-5, AC-6 | Protects the task thread and the agent's budget |
| D-6: Each company has a setting "Session changes update tasks and wake agents", on by default, applying to linked sessions only | Planner's choice | assumed | FR-6 / AC-9 | The founder can turn it off without unlinking |
| D-7: Event names the plugin emits: `plugin.browser-sessions.session_state` | `ctx.events.emit(name, companyId, payload)` and the `plugin.` prefix (`packages/plugins/sdk/src/types.ts:549-577`) `[verified]` | assumed | FR-1 / AC-1 | Lets other plugins or routines react |

## UI Layout

- Task comment text, exactly: `Session "{title}" ({provider label}, {account label}) is now: {state label}.` followed by a link `Open session`.
- When comments were held back by the limit, the next allowed comment ends with ` ({n} earlier changes not shown.)`.
- Plugin settings page, per company: checkbox `Session changes update tasks and wake agents`.
- Task `Sessions` tab (REQ-9): a session that is not loaded shows `Not observed` and `Last seen {relative time}`.
- No other screens.

## Functional Requirements

### FR-1: Report settled state changes

For each shared session loaded in the extension, when its agent state has held for 5 s and differs
from the last state sent, the extension SHALL send `{ threadKey, from, to, at }` over the bridge,
and the plugin SHALL update the session's row and emit `plugin.browser-sessions.session_state`.

- Decision/source: D-1, D-2, D-7.

#### Scenario: positive
- GIVEN a loaded coding session goes from `running` to `turn_complete` and stays there for 5 s
- WHEN the 5 s have passed
- THEN one event is sent and the row's state is `turn_complete` within 10 s

#### Scenario: negative
- GIVEN a session flips `running`, `unknown`, `running` within 3 s
- WHEN 5 s have passed
- THEN no event is sent

#### Scenario: edge
- GIVEN the bridge is down when a change settles
- WHEN it reconnects within 10 minutes
- THEN the latest state of each changed session is sent once; changes older than 10 minutes are sent as a row update without an event

### FR-2: One comment per change on each linked task

For a change to one of the states in D-3, the plugin SHALL add one comment, with the text in UI
Layout, to each task linked to the session.

- Decision/source: D-3.
- Exact contract values: the session title in the comment is cut to 120 characters, has line breaks replaced by spaces, and is wrapped in double quotes; no other session text goes into the comment (the title comes from the provider page and is untrusted).

#### Scenario: positive
- GIVEN a session linked to tasks T1 and T2 becomes `Failed`
- WHEN the event arrives
- THEN T1 and T2 each get one comment ending `is now: Failed.`

#### Scenario: negative
- GIVEN the same event is delivered twice
- WHEN the plugin handles the second
- THEN no second comment is added (the pair of thread key and `at` was already handled)

#### Scenario: edge
- GIVEN a session with no linked task changes state
- WHEN the event arrives
- THEN no comment is added and the row is updated

### FR-3: Wake the assigned agent

For a change to `turn_complete` or `failed`, the plugin SHALL request a wake-up for each linked
task's assigned agent with reason `browser_session_state`.

- Decision/source: D-4.

#### Scenario: positive
- GIVEN task T is assigned to agent A and its linked session becomes `Finished`
- WHEN the event arrives
- THEN A has one wake-up request for T with reason `browser_session_state`

#### Scenario: negative
- GIVEN task T has no assigned agent
- WHEN the event arrives
- THEN the comment is added and no wake-up is requested

#### Scenario: edge
- GIVEN the change is to `Needs approval`
- WHEN the event arrives
- THEN the comment is added and no wake-up is requested

### FR-4: Limits

The plugin SHALL add at most 6 comments per session per task per hour and request at most 1 wake-up
per task per 10 minutes from session events.

- Decision/source: D-5.

#### Scenario: positive
- GIVEN 2 changes in an hour
- WHEN they arrive
- THEN 2 comments are added

#### Scenario: negative
- GIVEN 9 changes on one session in an hour
- WHEN they arrive
- THEN 6 comments are added and the first comment after the hour ends with ` (3 earlier changes not shown.)`

#### Scenario: edge
- GIVEN two linked sessions of task T both finish within 10 minutes
- WHEN the events arrive
- THEN T gets two comments and one wake-up

### FR-5: No stale claims

A session that is not loaded SHALL be shown as `Not observed` with the time it was last seen, and
SHALL produce no event.

- Decision/source: D-1.

#### Scenario: positive
- GIVEN a linked session whose tab was closed an hour ago in state `Running`
- WHEN the task's `Sessions` tab is opened
- THEN it shows `Not observed` and `Last seen 1 hour ago`

#### Scenario: negative
- GIVEN that session
- WHEN it finishes on the provider's side without being loaded
- THEN no comment and no wake-up occur until it is loaded again

#### Scenario: edge
- GIVEN the session is loaded again and shows `Finished`
- WHEN the state has held for 5 s
- THEN one event is sent as for any change

### FR-6: Off switch

When the company setting is off, the plugin SHALL update rows and SHALL add no comment and request
no wake-up.

- Decision/source: D-6.

#### Scenario: positive
- GIVEN the setting is on (the default)
- WHEN a linked session fails
- THEN the comment and wake-up occur

#### Scenario: negative
- GIVEN the setting is off
- WHEN a linked session fails
- THEN the row shows `Failed` and the task has no new comment and no wake-up

#### Scenario: edge
- N/A — one boolean per company.

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Delay | Comment present 20 s or less after the page shows the new state | Bridge connected; includes the 5 s settle time | Timed manual run with a stand-in page |
| Duplicates | 0 duplicate comments for one change | Event delivered twice | Plugin worker test |
| Cost guard | At most 6 wake-ups per task per hour from session events | Flapping stand-in page | Plugin worker test over simulated time |

## Constraints from platform

- Auth / access / ownership: capabilities `issue.comments.create`, `issues.wakeup`, `issues.read`, `events.emit`, `plugin.state.read`, `plugin.state.write` (`packages/shared/src/constants.ts:1352-1456`) `[verified]`. Comments are attributed to the plugin, not to the founder.
- API / types: `AgentState` and its labels (`extension/src/core/workspace/types.ts`); `ctx.issues`, `ctx.events` (`packages/plugins/sdk/src/types.ts:2221`, `:2263`). The exact method names for adding a comment and requesting a wake-up have not been read.
- Cache: the last sent state per session is kept by the extension; the handled pairs of thread key and time are kept by the plugin for 24 hours.
- Files to extend, not reinvent: `extension/src/core/embed/agent-state.ts` (read, not changed); `extension/src/entrypoints/content.ts` where state is reported; the bridge and plugin from REQ-7.
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: turning the company setting off stops all effects.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| Plugin setting `sessionChangesUpdateTasks` | no | Plugin settings page | Per company, default on |

## Out of scope

- Detecting state for sessions that are not loaded, or by polling provider servers.
- State detection for chat providers; it exists for coding-agent providers only.
- Agents answering a waiting session — REQ-11 covers starting and sending only.
- Browser or system notifications.

## Acceptance Criteria

- **AC-1** Given a loaded shared coding session whose page goes from `running` to `turn_complete` and stays there, When 5 s have passed, Then one event `{ threadKey, from: "running", to: "turn_complete", at }` is sent and the plugin's row shows `turn_complete` within 10 s.
- **AC-2** Given a session whose state changes `running`, `unknown`, `running` within 3 s, When 5 s have passed, Then no event was sent.
- **AC-3** Given a session linked to tasks T1 and T2 becomes `failed`, When the event arrives, Then T1 and T2 each have exactly one new comment reading `Session "{title}" ({provider label}, {account label}) is now: Failed.` with the link `Open session`.
- **AC-4** Given task T assigned to agent A and its linked session becomes `turn_complete`, When the event arrives, Then A has exactly one wake-up request for T with reason `browser_session_state`; and Given the change is to `waiting_permission`, Then T has the comment and A has no new wake-up request.
- **AC-5** Given 9 state changes on one linked session within an hour, When they arrive, Then the task has 6 new comments, and the first comment after the hour ends with ` (3 earlier changes not shown.)`.
- **AC-6** Given two sessions linked to task T both become `turn_complete` within 10 minutes, When the events arrive, Then T has two comments and its agent has one wake-up request.
- **AC-7** Given the same event is delivered twice, When the plugin handles both, Then the task has one comment and the agent one wake-up request.
- **AC-8** Given a linked session whose tab was closed an hour ago, When the task's `Sessions` tab is opened, Then the row shows `Not observed` and `Last seen 1 hour ago`, and no comment or wake-up occurs until the session is loaded again.
- **AC-9** Given the company setting `Session changes update tasks and wake agents` is off, When a linked session becomes `failed`, Then the row shows `Failed` and the task has no new comment and its agent no new wake-up request.
- **AC-10** Given a task with no assigned agent and a linked session that becomes `turn_complete`, When the event arrives, Then the comment is added and no wake-up is requested.
- **AC-11** Given the bridge is down while a session's state settles and reconnects 5 minutes later, When it reconnects, Then exactly one event for that session's latest state is sent.
- **AC-12** Given a session title of 300 characters containing line breaks, When its comment is written, Then the quoted title in the comment is at most 120 characters, contains no line break, and no other session text is in the comment.

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-1, D-2, D-7 | settled change / flicker / bridge down | AC-1, AC-2, AC-11 | Extension unit tests beside `tests/unit/agent-state.test.ts` with a fake clock |
| FR-2 | D-3 | two tasks / duplicate delivery / no linked task | AC-3, AC-7, AC-12 | Plugin worker tests |
| FR-3 | D-4 | woken / no assignee / waiting state | AC-4, AC-10 | Plugin worker tests |
| FR-4 | D-5 | under limit / over limit / two sessions | AC-5, AC-6 | Plugin worker tests over simulated time |
| FR-5 | D-1 | not observed / finishes unseen / loaded again | AC-8 | Observation with a stand-in page |
| FR-6 | D-6 | on / off / N/A one boolean | AC-9 | Plugin worker test |

## Readiness

| Dimension | Pass? | Gap |
|---|---|---|
| Problem & goal | yes | |
| Behavior contract | yes | |
| Acceptance criteria | yes | |
| Context & constraints | no | The plugin SDK methods for a task comment and a wake-up request have not been read; agent-state reporting must be re-read after REQ-1 |
| Buildability | yes | The limits and times are planner's defaults with stated purpose |

**Score: 3/5** — four dimensions pass; capped at 3 by a build-blocker.

- Build-blockers: the wake-up and comment calls are unread. Source: `packages/plugins/sdk/src/types.ts` (`PluginIssuesClient`). Impact: FR-2 and FR-3. Resolution: read that interface and add the method names and any required fields here.
- Separate load gates: blocked by REQ-9. No TASKs yet.
- Artifact review: independent review round 1 of 3 (2026-11-13) returned needs-work with 5 findings and overflow; the writer applied fixes the same day; an independent recheck is pending. Report and dispositions: `verify/artifacts/plan-review.md`.
- Stale downstream contracts/evidence: none.

## Changelog

| Date | Change |
|---|---|
| 2026-11-13 | Initial specify |
