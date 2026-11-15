---
id: TASK-1
req: REQ-4
title: Connect and start registered service
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-4 / TASK-1 — Connect and start registered service

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: vertical
- Enabling rationale: N/A
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-4-paperclip-running-and-connected.md`; original FRs, decisions and criteria below.
- Inputs: `.plan/project.md`, `context/CATALOG.md`, `context/platform.md`, `HANDOFF.md`.
- Config: `.plan/config.json` has subagent execution, disjoint ownership, required TDD and three review rounds. A config read/approval is not a successful load gate.
- Workflow/design: `.plan/workflow.md` and `verify/implementation-checkpoint.md`; snapshot approval replaces only the merger-first prerequisite.
- Reuse: existing owning modules; Still keeps its independent identity/consent.
- Do not: alter original checkout/live build, register a real service, push/publish or operate personal provider accounts based on this record.
- Env: key names in parent REQ only; test output `TK_OUT_DIR=/tmp/tk-build`; no stable-ID override.

## File scope and integration

| Owned file / surface | Change | Integration seam / consumer |
|---|---|---|
| `extension/mac-helper/**` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/embed/helper-protocol.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/embed/helper.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/lifecycle.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/client.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/manager/PaperclipConnection.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/background.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-4.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

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

## Verify

Targeted candidate methods (not executed by writing this record):

npx vitest run tests/unit/paperclip-helper.test.ts tests/unit/paperclip-lifecycle.test.ts tests/unit/paperclip-client.test.ts (extension/). Actual launchd persistence needs separately authorized registration and runtime evidence.

For each AC preserve its parent Coverage method and required runtime/media proof. Unit/type/build checks cannot certify visible UI, actual provider delivery or service persistence. Config test commands stay empty until the lead records actual successful commands.

## Evidence

No load gate, final AC pass, independent review or completion is claimed here. Baseline observations are separately labeled in the checkpoint.

| Owned AC | Actual result | Proof |
|---|---|---|
| AC-1 | pending | |
| AC-2 | pending | |
| AC-3 | pending | |
| AC-4 | pending | |
| AC-5 | pending | |
| AC-6 | pending | |
| AC-7 | pending | |
| AC-8 | pending | |
| AC-9 | pending | |
| AC-10 | pending | |
| AC-11 | pending | |

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
