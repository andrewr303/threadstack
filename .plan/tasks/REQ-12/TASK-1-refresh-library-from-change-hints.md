---
id: TASK-1
req: REQ-12
title: Refresh library from change hints
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-12 / TASK-1 — Refresh library from change hints

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: vertical
- Enabling rationale: N/A
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-12-paperclip-work-stays-current-in-the-library.md`; original FRs, decisions and criteria below.
- Inputs: `.plan/project.md`, `context/CATALOG.md`, `context/platform.md`, `HANDOFF.md`.
- Config: `.plan/config.json` has subagent execution, disjoint ownership, required TDD and three review rounds. A config read/approval is not a successful load gate.
- Workflow/design: `.plan/workflow.md` and `verify/implementation-checkpoint.md`; snapshot approval replaces only the merger-first prerequisite.
- Reuse: existing owning modules; Still keeps its independent identity/consent.
- Do not: alter original checkout/live build, register a real service, push/publish or operate personal provider accounts based on this record.
- Env: key names in parent REQ only; test output `TK_OUT_DIR=/tmp/tk-build`; no stable-ID override.

## File scope and integration

| Owned file / surface | Change | Integration seam / consumer |
|---|---|---|
| `packages/plugins/plugin-browser-sessions/src/service.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `packages/plugins/plugin-browser-sessions/src/worker.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/sync.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/bridge.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/background.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-12.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given the bridge is connected and the extension is running, When a comment containing a unique word is added to task T, Then within 60 s a library search for that word returns T's thread, and T's thread has exactly one copy of the comment.
- **AC-2** Given the bridge is connected, When an agent run on task T finishes, Then within 60 s T's thread holds that run's transcript; and Given a run event that names no task, Then the existing run step runs for that company and the affected task is updated within 60 s.
- **AC-3** Given 40 events for one task within 5 s, When the window closes, Then the extension receives one hint and makes one fetch for that task.
- **AC-4** Given a hint for a company the extension's sync settings do not include, When it arrives, Then no request is made for it.
- **AC-5** Given a connected bridge, When the extension starts, Then no live socket to `/api/companies/:id/events/ws` is opened; and Given the bridge drops on a server without sign-in, Then the socket is opened within 10 s.
- **AC-6** Given the bridge was down for 20 minutes while three tasks changed, When the next timer sync completes, Then all three changes are in the library and no thread is duplicated.

## Verify

Targeted candidate methods (not executed by writing this record):

npx vitest run tests/unit/paperclip-hints.test.ts tests/unit/paperclip-sync.test.ts (extension/); node ../../../node_modules/vitest/vitest.mjs run (packages/plugins/plugin-browser-sessions/). Inspect actual change-to-library latency/reconnect/fallback without advancing unrelated cursors.

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

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
