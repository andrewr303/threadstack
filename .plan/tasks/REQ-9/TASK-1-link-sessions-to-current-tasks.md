---
id: TASK-1
req: REQ-9
title: Link sessions to current tasks
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-9 / TASK-1 — Link sessions to current tasks

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: vertical
- Enabling rationale: N/A
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-9-sessions-linked-to-tasks.md`; original FRs, decisions and criteria below.
- Inputs: `.plan/project.md`, `context/CATALOG.md`, `context/platform.md`, `HANDOFF.md`.
- Config: `.plan/config.json` has subagent execution, disjoint ownership, required TDD and three review rounds. A config read/approval is not a successful load gate.
- Workflow/design: `.plan/workflow.md` and `verify/implementation-checkpoint.md`; snapshot approval replaces only the merger-first prerequisite.
- Reuse: existing owning modules; Still keeps its independent identity/consent.
- Do not: alter original checkout/live build, register a real service, push/publish or operate personal provider accounts based on this record.
- Env: key names in parent REQ only; test output `TK_OUT_DIR=/tmp/tk-build`; no stable-ID override.

## File scope and integration

| Owned file / surface | Change | Integration seam / consumer |
|---|---|---|
| `packages/plugins/plugin-browser-sessions/**` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `packages/plugins/sdk/src/types.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `server/src/services/tool-gateway.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/manager/PaperclipLinks.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/bridge.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-9.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

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

## Verify

Targeted candidate methods (not executed by writing this record):

node ../../../node_modules/vitest/vitest.mjs run (packages/plugins/plugin-browser-sessions/); npx vitest run tests/unit/paperclip-bridge.test.ts (extension/). Inspect task tab/thread detail/dashboard links and unlink persistence in isolated browser.

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
