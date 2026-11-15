---
id: REQ-12
title: Paperclip work stays current in the library
epic: EPIC-4
spec: SPEC-16
status: in-progress
readiness: 4
effort: med
readiness_gaps: ["implementation drafted against approved snapshot; final acceptance and ordered independent reviews pending"]
blocked_by: [REQ-7]
blocks: []
priority: P1
source: BRIEF-1
change:
stack: Paperclip plugin (event subscriptions), extension Paperclip sync
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-12 — Paperclip work stays current in the library

## Overview

When a Paperclip task, comment, document or agent run changes, the library in the extension holds
the change within a minute while the bridge is connected, on local and signed-in Paperclip servers
alike. One search in the library then covers sessions and current Paperclip work.

## Problem Statement

The extension already copies Paperclip tasks into the library (one thread per task, with comments
and run transcripts), but it relies on a 5-minute timer. A live socket shortens that only on servers
without sign-in, and only while the extension's service worker happens to be running
(`src/core/paperclip/live.ts:1-9`, `sync.ts:1-20`) `[verified]`. The founder chose that Paperclip work
"keep[s] flowing into the same library so one search covers both" (CTX-1, G-2).

## Solution

The `browser-sessions` plugin subscribes to Paperclip's own events and sends a short change hint over
the bridge (REQ-7). The extension fetches just the named tasks with the per-task fetch it already
has. The 5-minute timer stays the source of truth and catches anything missed while disconnected.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-4-one-memory.md`; REQ-7 (bridge and its request channel).
- Context: `context/platform.md` (APIs "Plugin events", "Extension to Paperclip"); CTX-1 (G-2).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: not required.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: Change hints travel over the bridge, not the live socket | Board keys are refused on the live socket (`src/core/paperclip/live.ts:4-6`) `[verified]`; the bridge works on both server modes (REQ-7) | assumed | FR-1, FR-4 / AC-1, AC-5 | One path for both modes |
| D-2: Events that produce a hint: `issue.created`, `issue.updated`, `issue.comment.created`, `issue.document.created`, `issue.document.updated`, `issue.document.deleted`, `agent.run.started`, `agent.run.finished`, `agent.run.failed`, `agent.run.cancelled` | `PLUGIN_EVENT_TYPES` (`paperclip/packages/shared/src/constants.ts:1720-1755`) `[verified]` | assumed | FR-1 / AC-1, AC-2 | These change what a task's thread holds |
| D-3: A hint is `{ type: "paperclip.changed", companyId, issueIds: string[], runIds: string[] }`; hints for one company within 5 s are merged; at most 50 issue ids per hint | Planner's design | assumed | FR-1 / AC-3 | Bursts during an agent run become one fetch |
| D-4: The extension fetches the named tasks with the existing per-task fetch and stores them under the same thread keys | `sync.ts:12-15` (each changed issue is fetched in full and stored as one thread) `[verified]` | agreed (existing behaviour) | FR-2 / AC-1, AC-4 | No second mapping |
| D-5: A run event without an issue id falls back to the existing run step for that company (newest 100 runs mark issues dirty) | `sync.ts:5-7` `[verified]`; run event payload fields not read | assumed | FR-2 / AC-2 | Safe whatever the payload holds |
| D-6: The 5-minute timer and its back-off stay as they are | `sync.ts:17-19`, `live.ts:6-8` `[verified]` | agreed (existing behaviour) | FR-3 / AC-6 | Hints are hints |
| D-7: While the bridge is connected the live socket is not opened; when the bridge is down the existing socket behaviour applies | Planner's choice | assumed | FR-4 / AC-5 | Avoids two triggers for one change |
| D-8: Threads with provider `paperclip` are never sent back to Paperclip as sessions | REQ-7 FR-3 | assumed | — | Paperclip already shows its own tasks |

## UI Layout

Infrastructure-only — no new screens. Settings → Paperclip in the extension already shows sync
state; its "Last synced" line updates after each hint-driven fetch. Architecture assessment: an
event subscription in the plugin and a new trigger for an existing sync step.

## Functional Requirements

### FR-1: Hints from Paperclip events

The plugin SHALL subscribe to the events in D-2 and send one hint per company per 5 s window to the
paired extension.

- Decision/source: D-1, D-2, D-3.

#### Scenario: positive
- GIVEN the bridge is connected
- WHEN a comment is added to task T
- THEN within 10 s the extension receives a hint naming T

#### Scenario: negative
- GIVEN no extension is paired for the company
- WHEN events occur
- THEN no hint is queued and nothing grows unbounded

#### Scenario: edge
- GIVEN an agent run produces 40 events on one task in 5 s
- WHEN the window closes
- THEN one hint naming that task is sent

### FR-2: Fetch the named tasks

On a hint the extension SHALL fetch each named task with the existing per-task fetch within 10 s,
store it under its existing thread key, and run the existing local processing so it is searchable.

- Decision/source: D-4, D-5.

#### Scenario: positive
- GIVEN a hint naming task T
- WHEN it arrives
- THEN T's thread holds the new comment and a local search for a word in it finds T

#### Scenario: negative
- GIVEN a hint names a task the extension's sync settings exclude (a company not chosen)
- WHEN it arrives
- THEN it is ignored

#### Scenario: edge
- GIVEN a hint carries only run ids
- WHEN it arrives
- THEN the existing run step runs for that company and marks the affected tasks for fetch

### FR-3: The timer stays the source of truth

The 5-minute sync SHALL keep running with its existing cursor and back-off, and SHALL pick up every
change made while the bridge was down.

- Decision/source: D-6.

#### Scenario: positive
- GIVEN the bridge was down for 20 minutes while tasks changed
- WHEN the next timer sync runs
- THEN all those changes are in the library

#### Scenario: negative
- GIVEN the server answers with errors
- WHEN syncs fail repeatedly
- THEN the existing back-off of 5 to 60 minutes applies, and hints during the back-off still trigger a single per-task fetch each

#### Scenario: edge
- GIVEN a hint-driven fetch and a timer sync overlap for the same task
- WHEN both finish
- THEN the task has one thread and no duplicate messages

### FR-4: One trigger at a time

While the bridge is connected the extension SHALL NOT open the live socket, and SHALL open it as
before when the bridge is down on a local server.

- Decision/source: D-7.

#### Scenario: positive
- GIVEN a connected bridge
- WHEN the extension starts
- THEN no connection to `/api/companies/:id/events/ws` is opened

#### Scenario: negative
- GIVEN the bridge drops on a server without sign-in
- WHEN 10 s pass
- THEN the existing live socket behaviour resumes

#### Scenario: edge
- GIVEN a server with sign-in and no bridge
- WHEN the extension starts
- THEN the timer is the only trigger, as today

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Freshness | 60 s or less from a Paperclip change to a local library search finding it | Bridge connected, extension running | Timed manual run; unit test with a fake clock for the 5 s merge and 10 s fetch |
| Load | At most one per-task fetch per task per 5 s window | Agent run producing events | Plugin worker test |

## Constraints from platform

- Auth / access / ownership: capability `events.subscribe` (`paperclip/packages/shared/src/constants.ts:1352-1456`); hints carry ids only, never content.
- API / types: `ctx.events.on(name, fn)` (`packages/plugins/sdk/src/types.ts:549-559`); extension sync in `extension/src/core/paperclip/{sync,live,client,mapper}.ts`.
- Cache: the extension's sync cursor and run marks in `chrome.storage.local` are unchanged (`sync.ts:16-17`).
- Files to extend, not reinvent: `extension/src/core/paperclip/sync.ts` (add a trigger, not a second sync), `live.ts`; the plugin package from REQ-7.
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: disabling hints leaves the existing timer and socket behaviour.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| none | | | |

## Out of scope

- Writing anything from the library back to Paperclip.
- New task fields in the library thread.
- Goals and projects as their own threads.

## Acceptance Criteria

- **AC-1** Given the bridge is connected and the extension is running, When a comment containing a unique word is added to task T, Then within 60 s a library search for that word returns T's thread, and T's thread has exactly one copy of the comment.
- **AC-2** Given the bridge is connected, When an agent run on task T finishes, Then within 60 s T's thread holds that run's transcript; and Given a run event that names no task, Then the existing run step runs for that company and the affected task is updated within 60 s.
- **AC-3** Given 40 events for one task within 5 s, When the window closes, Then the extension receives one hint and makes one fetch for that task.
- **AC-4** Given a hint for a company the extension's sync settings do not include, When it arrives, Then no request is made for it.
- **AC-5** Given a connected bridge, When the extension starts, Then no live socket to `/api/companies/:id/events/ws` is opened; and Given the bridge drops on a server without sign-in, Then the socket is opened within 10 s.
- **AC-6** Given the bridge was down for 20 minutes while three tasks changed, When the next timer sync completes, Then all three changes are in the library and no thread is duplicated.

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-1, D-2, D-3 | hint sent / no extension paired / burst merged | AC-1, AC-3 | Plugin worker tests with simulated events |
| FR-2 | D-4, D-5 | task fetched / company excluded / run ids only | AC-1, AC-2, AC-4 | Extension tests beside `tests/unit/paperclip-sync.test.ts` with the fake server |
| FR-3 | D-6 | catches up / errors back off / overlap | AC-6 | Same |
| FR-4 | D-7 | no socket / bridge drops / signed-in server | AC-5 | Extension tests beside `paperclip-sync.test.ts` |

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
| 2026-11-13 | Bounded company-scoped change hints refresh named tasks without advancing periodic cursors; periodic fallback remains. Actual event-to-library latency, run payload and reconnect/fallback evidence remains pending. |
