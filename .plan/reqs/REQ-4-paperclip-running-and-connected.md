---
id: REQ-4
title: Paperclip is running and connected when the extension opens
epic: EPIC-2
spec: SPEC-6
status: in-progress
readiness: 4
effort: med
readiness_gaps: ["implementation drafted against approved snapshot; final acceptance and ordered independent reviews pending"]
blocked_by: [REQ-3]
blocks: [REQ-5, REQ-7]
priority: P0
source: BRIEF-1
change:
stack: extension service worker and manager UI, Mac helper (Node), Paperclip CLI service manager
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-4 — Paperclip is running and connected when the extension opens

## Overview

When the founder opens the extension window on their Mac, the fork's Paperclip server is up and the
extension is connected to it. If the server was not running, the Mac helper starts it without the
founder running a command. A status line always says which state Paperclip is in and, when something
is wrong, what to do.

## Problem Statement

Today the founder starts Paperclip by hand and the extension only reads from it if it happens to be
up (`src/core/paperclip/sync.ts` polls every 5 minutes). The founder chose a design in which
Paperclip is "served by a Paperclip server on this Mac that the helper starts automatically"
(CTX-1, G-1). REQ-5 (showing Paperclip) and REQ-7 (the bridge) both need a server that is reliably there.

## Solution

Reuse what exists on both sides. The extension already has a Paperclip client, pairing and settings.
Paperclip already has a background-service manager that installs a launchd service with `RunAtLoad`
and `KeepAlive`. The helper gains two parameterless requests, status and start, that call that
service manager with a command fixed at helper-install time. The extension polls `/api/health`,
asks the helper to start the service when it is down, and shows the state.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-2-paperclip-inside-the-extension.md`.
- Context: `context/platform.md` (Paperclip "Background service", APIs "Paperclip health", "Mac helper", "Extension to Paperclip"); CTX-1 (G-1).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: needed for D-2 before build (`/ultimate-sdd:design REQ-4`).

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: The server is started automatically by the helper | CTX-1 G-1 | agreed | FR-2 / AC-2, AC-3 | Founder's choice |
| D-2: The helper does not launch the server process itself; it asks Paperclip's service manager to start the installed background service | Service manager exists (`cli/src/commands/service.ts:167-225`; launchd plist with `RunAtLoad`, `KeepAlive` at `cli/src/services/service-manager.ts:158-170`) `[verified]`; the helper's rule is that it runs no command from a page (`docs/mac-helper.md:55-57`) `[verified]` | unresolved | FR-2, FR-6 / AC-2, AC-7 | The service runs a shim from a managed install store; `PAPERCLIP_SHIM_PATH` can point elsewhere but must be an existing executable (`cli/src/onboard-service.ts:141-156`) `[verified]`. Whether the fork's source checkout can register its own shim is not confirmed. Fallback to assess in design: the helper starts a fixed command itself |
| D-3: v1 manages only a server on this Mac at a loopback address; a remote server can still be connected by URL but is never started or stopped | Planner's choice | assumed | FR-1, FR-2 / AC-1 | The helper is macOS-local. Boundary: remote lifecycle is out of scope |
| D-4: No new auth. `local_trusted` needs none; `authenticated` uses the board key from the existing approval flow | `src/core/paperclip/auth.ts:1-60` `[verified: scan]` | assumed | FR-4 / AC-5 | Already built and tested |
| D-5: Installing the background service the first time needs one explicit click; starting an installed service is automatic | Planner's choice | assumed | FR-2, FR-3 / AC-2, AC-4 | Registering a login service is a system change the founder should see once |
| D-6: Closing the extension window never stops the server | Agents keep working without a browser; the service is `KeepAlive` | assumed | FR-7 / AC-8 | Boundary: a Stop control may be added later |
| D-7: Poll intervals 5 s while not running and 30 s while running, only while the window is visible; request timeout 2 s; start timeout 60 s | 2 s and 60 s mirror the CLI's own probe and wait (`cli/src/commands/service.ts` `probeHealth`, `waitForHealth`) `[verified]`; 5 s and 30 s are the planner's | assumed | FR-1, FR-2 / AC-1, AC-3 | Keeps the status current without constant requests |

## UI Layout

A status line for Paperclip, shown in the shell near the Settings entry and repeated at the top of
Settings → Paperclip. Its exact place in the rail is decided after REQ-1, because the rail is being
changed by the multi-profile work. Exact copy per state:

| State | Text | Action shown |
|---|---|---|
| running | `Paperclip is running` | none |
| starting | `Starting Paperclip…` | none |
| stopped | `Paperclip is stopped` | `Start` (when the helper is connected); otherwise the line Run "`pnpm paperclipai service start`" in the Paperclip folder, or install the Mac helper to start it automatically. |
| not_installed | `Paperclip is not set up on this Mac` | `Set up Paperclip` (installs the background service through the helper) |
| needs_sign_in | `Paperclip needs you to sign in` | `Sign in` (opens the existing approval flow) |
| setup_pending | `Finish setting up Paperclip` | `Open Paperclip` |
| unreachable | `Can't reach Paperclip at {origin}` | `Retry` |
| start_failed | `Paperclip did not start: {reason}` | `Retry`, and the line See "`pnpm paperclipai service logs`" for details. |

Loading state: `starting`. Empty state: `not_installed`.

## Functional Requirements

### FR-1: Status from the health endpoint

While a shell window is visible, the extension SHALL request `GET {origin}/api/health` with a 2 s
timeout every 5 s while the state is not `running` and every 30 s while it is, and derive the state:
`running` when the response has `status: "ok"`, and for `deploymentMode: "authenticated"` the
extension holds valid credentials and `bootstrapStatus` is `ready`.

- Decision/source: D-3, D-4, D-7.
- Exact contract values: fields `status`, `deploymentMode`, `authReady`, `bootstrapStatus`, `serverVersion` (`paperclip/server/src/routes/health.ts:279-327`); default origin `http://127.0.0.1:3100`.

#### Scenario: positive — healthy local server
- GIVEN the server answers `{status:"ok", deploymentMode:"local_trusted"}`
- WHEN the shell opens
- THEN the state is `running` within 2 s of the window becoming visible

#### Scenario: negative — something else answers on the port
- GIVEN port 3100 answers but the body has no `status: "ok"`
- WHEN the extension polls
- THEN the state is `unreachable` and no start is requested

#### Scenario: edge — window hidden
- GIVEN the shell tab is in the background
- WHEN 60 s pass
- THEN no health request is sent, and one is sent within 1 s of the tab becoming visible again

### FR-2: Automatic start

When the state is `stopped` on shell open and the helper is connected, the extension SHALL send one
start request to the helper, show `starting`, and wait up to 60 s for `running`.

- Decision/source: D-1, D-2, D-5, D-7.
- Exact contract values: helper request `{ "type": "paperclip.start" }`; responses `{ "ok": true, "started": true }` or `{ "ok": false, "error": "<code>" }` with codes `paperclip_not_registered`, `paperclip_start_failed`, `unsupported_platform`. Names are `[assumed]` and follow `src/core/embed/helper-protocol.ts`.

#### Scenario: positive — service installed but stopped
- GIVEN the background service is installed and not running
- WHEN the founder opens the extension window
- THEN the state goes `stopped`, `starting`, `running` without any click, within 60 s

#### Scenario: negative — start fails
- GIVEN the helper answers `{ok:false, error:"paperclip_start_failed"}` or 60 s pass without health
- WHEN the wait ends
- THEN the state is `start_failed` with the reason, and no further automatic start is sent until the founder presses `Retry` or reopens the window

#### Scenario: edge — two windows open at once
- GIVEN two shell windows open within the same second
- WHEN both see `stopped`
- THEN exactly one start request reaches the helper

### FR-3: First-time setup

When the helper reports that no background service is registered, the state SHALL be
`not_installed`, and the service SHALL be installed only after the founder presses `Set up Paperclip`.

- Decision/source: D-5.
- Exact contract values: helper request `{ "type": "paperclip.status" }`; response `{ "ok": true, "paperclip": { "service": "running" | "stopped" | "not_installed" } }`.

#### Scenario: positive
- GIVEN no service is registered and the helper knows the fork folder
- WHEN the founder presses `Set up Paperclip`
- THEN the service is installed and started and the state reaches `running`

#### Scenario: negative — helper has no fork folder registered
- GIVEN the helper was installed without a Paperclip folder
- WHEN the founder presses `Set up Paperclip`
- THEN the helper answers `paperclip_not_registered` and the status line says `Run "Install Mac Helper.command" again and choose the Paperclip folder.`

#### Scenario: edge — helper missing
- GIVEN the helper is not installed for this browser
- WHEN the shell opens with the server down
- THEN the state is `stopped` with the manual command line and no start is attempted

### FR-4: Connection and sign-in

When the server is healthy, the extension SHALL be connected with the existing client: immediately on
`local_trusted`, and through the existing board-key approval flow on `authenticated`.

- Decision/source: D-4.

#### Scenario: positive
- GIVEN a healthy `local_trusted` server
- WHEN the state becomes `running`
- THEN the existing company list request succeeds with no credentials

#### Scenario: negative
- GIVEN an `authenticated` server and no stored key, or a key the server rejects with 401
- WHEN the extension polls
- THEN the state is `needs_sign_in`

#### Scenario: edge
- GIVEN `bootstrapStatus` is `bootstrap_pending`
- WHEN the extension polls
- THEN the state is `setup_pending`

### FR-5: Host permission

The extension SHALL obtain the optional host permission for the Paperclip origin through the
existing reference-counted grants before the first request, and SHALL not request any broader pattern.

- Decision/source: existing behaviour (`src/core/host-access.ts`) `[verified: scan]`.

#### Scenario: positive
- GIVEN the permission is not yet granted
- WHEN the founder first connects
- THEN the browser prompt names only the Paperclip origin

#### Scenario: negative
- GIVEN the founder dismisses the prompt
- WHEN the extension would poll
- THEN no request is sent and the state is `unreachable` with the action `Allow access`

#### Scenario: edge
- N/A — one origin.

### FR-6: The helper runs only the registered command

The helper SHALL start Paperclip only with the command recorded when the helper was installed, SHALL
take no path, command or argument from a message, and SHALL refuse both new requests when nothing is registered.

- Decision/source: D-2.

#### Scenario: positive
- GIVEN a registered fork folder
- WHEN `paperclip.start` arrives
- THEN the helper runs the registered command and nothing else

#### Scenario: negative
- GIVEN a message `{type:"paperclip.start", "path":"/tmp/x"}`
- WHEN the helper receives it
- THEN the extra field is ignored and the registered command runs; if nothing is registered the answer is `paperclip_not_registered`

#### Scenario: edge
- GIVEN the registered folder no longer exists
- WHEN `paperclip.start` arrives
- THEN the answer is `paperclip_start_failed`

### FR-7: The server outlives the window

Closing every extension window SHALL NOT stop the server.

- Decision/source: D-6.

#### Scenario: positive
- GIVEN the state is `running`
- WHEN every shell window is closed
- THEN `GET /api/health` still answers 60 s later

#### Scenario: negative
- N/A — there is no stop path to misfire.

#### Scenario: edge
- N/A — same reason.

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Time to `running` when already up | 2 s or less after the window is visible | Local server healthy | Timestamped Diagnostics log lines |
| Time to `running` from stopped | 60 s or less, else `start_failed` | Service installed | Stop the service, open the window, time it |
| Security of the helper | 0 parameters accepted for the two new requests | All messages | Unit test with extra fields, beside `tests/unit/mac-helper.test.ts` |

## Constraints from platform

- Auth / access / ownership: the helper answers only extension ids it was installed for (`docs/mac-helper.md:30-34`). Health is unauthenticated. Workspace-class commands are accepted only from `manager.html` as a top-level tab (`docs/architecture.md:45-47`); the two helper requests belong to that class.
- API / types: `HelperRequest`, `HelperResponse` in `extension/src/core/embed/helper-protocol.ts`; `HOST` in `extension/mac-helper/core.cjs`; the health fields above; `settings.paperclip` (`extension/src/core/schema.ts:889`).
- Cache: N/A.
- Files to extend, not reinvent: `extension/src/core/paperclip/{client,auth}.ts`; `extension/src/entrypoints/manager/PaperclipSettings.tsx`; `extension/src/core/host-access.ts`; `extension/src/core/embed/{helper,helper-protocol}.ts`; `extension/mac-helper/{core,host,install}.cjs`; Paperclip `cli/src/commands/service.ts`.
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: an older helper answers the new request types with an error; the extension treats that as "helper missing" (FR-3 edge) and asks for the installer to be run again.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| `PAPERCLIP_SHIM_PATH` | depends on D-2 | `cli/src/onboard-service.ts` | Key name only; whether the fork sets it is the open design point |
| `PAPERCLIP_INSTANCE_ID` | no | `cli/src/config/home.ts` | Default instance |

## Out of scope

- Showing Paperclip's interface — REQ-5.
- A Stop or Restart control, log viewer, or update flow.
- Starting or stopping a remote server.
- Windows and Linux.

## Acceptance Criteria

- **AC-1** Given the local server answers `/api/health` with `status: "ok"` and `deploymentMode: "local_trusted"`, When the shell window becomes visible, Then the status line reads `Paperclip is running` within 2 s.
- **AC-2** Given the background service is installed and stopped and the helper is connected, When the founder opens the extension window, Then the status line reads `Starting Paperclip…` and then `Paperclip is running` within 60 s, with no click.
- **AC-3** Given the helper answers `{ "ok": false, "error": "paperclip_start_failed" }`, or 60 s pass without a healthy response, When the wait ends, Then the status line reads `Paperclip did not start: ` followed by the reason, and no second start request is sent until `Retry` is pressed or the window is reopened.
- **AC-4** Given no background service is registered, When the shell opens, Then the status line reads `Paperclip is not set up on this Mac` and nothing is installed until `Set up Paperclip` is pressed.
- **AC-5** Given an `authenticated` server and no valid board key, When the extension polls, Then the status line reads `Paperclip needs you to sign in`; and Given `bootstrapStatus` is `bootstrap_pending`, Then it reads `Finish setting up Paperclip`.
- **AC-6** Given port 3100 answers without `status: "ok"`, When the extension polls, Then the status line reads `Can't reach Paperclip at http://127.0.0.1:3100` and no start request is sent.
- **AC-7** Given a helper message `{ "type": "paperclip.start", "path": "/tmp/x" }`, When the helper handles it, Then it runs only the command recorded at install time, and Given nothing is recorded, Then it answers `{ "ok": false, "error": "paperclip_not_registered" }`.
- **AC-8** Given the state is `running`, When every extension window is closed, Then `GET /api/health` still returns `status: "ok"` 60 s later.
- **AC-9** Given the shell tab is hidden for 60 s, When network requests are inspected, Then no health request was sent in that time, and one is sent within 1 s of the tab becoming visible.
- **AC-10** Given two shell windows open within one second while the server is stopped, When the helper's log is read, Then it received exactly one `paperclip.start`.
- **AC-11** Given the helper is not installed for this browser and the server is down, When the shell opens, Then the status line reads `Paperclip is stopped` with the manual command line, and no native message is sent.

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-3, D-4, D-7 | healthy / foreign service on port / hidden window | AC-1, AC-6, AC-9 | Unit tests of the state function with a fake fetch; observation |
| FR-2 | D-1, D-2, D-5, D-7 | auto start / start fails / two windows | AC-2, AC-3, AC-10 | Unit tests with a fake helper; manual run with the service stopped |
| FR-3 | D-5 | set up / nothing registered / helper missing | AC-4, AC-11 | Unit tests; manual run |
| FR-4 | D-4 | trusted / needs sign-in / setup pending | AC-5 | Existing `tests/unit/paperclip-*.test.ts` pattern with the fake server |
| FR-5 | existing behaviour | prompt names one origin / dismissed / N/A one origin | AC-6 | Observation of the browser prompt |
| FR-6 | D-2 | registered command / extra fields / folder gone | AC-7 | Helper unit test |
| FR-7 | D-6 | survives / N/A / N/A | AC-8 | Manual run |

## Readiness

Current implementation limit: when the local server is down, helper discovery makes one native
status probe and remembers a missing helper for the window lifetime. This differs from AC-11's
literal zero-message criterion, which remains unchanged and unmet. See `verify/fix-all-cycle.md`;
no real helper/service or completion pass is inferred from source inspection.

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
The layered fused implementation and switching fallback are recorded in `REQ-6-design.md`.
Current source/spec differences remain explicit in `verify/fix-all-cycle.md`. Real provider
delivery and real launchd registration are not claimed.
See `verify/implementation-checkpoint.md`, the final validation report and independent review
reports for concrete source and evidence. Historical authored-plan review remains at
`verify/artifacts/plan-review.md`.

## Changelog

| Date | Change |
|---|---|
| 2026-11-13 | Initial specify |
| 2026-11-13 | Source-service design uses an install-time fixed executable shim and parameterless helper lifecycle messages, with one worker start coordinator and visible-page health polling. Real launchd registration/startup/persistence remains unverified. |
