---
id: TASK-1
req: REQ-10
title: Record states and governed wakeups
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-10 / TASK-1 — Record states and governed wakeups

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: vertical
- Enabling rationale: N/A
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-10-session-changes-wake-the-agent.md`; original FRs, decisions and criteria below.
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
| `extension/src/core/paperclip/bridge.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/bridge-query.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-10.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

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

## Verify

Targeted candidate methods (not executed by writing this record):

node ../../../node_modules/vitest/vitest.mjs run (packages/plugins/plugin-browser-sessions/); npx vitest run tests/unit/paperclip-bridge.test.ts (extension/). Correlate event/comment/wakeup and rejection audit; preserve comments when governed wakeup is refused.

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
| AC-12 | pending | |

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
