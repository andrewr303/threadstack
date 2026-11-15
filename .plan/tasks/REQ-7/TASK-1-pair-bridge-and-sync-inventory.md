---
id: TASK-1
req: REQ-7
title: Pair bridge and sync inventory
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-15, AC-16]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-7 / TASK-1 — Pair bridge and sync inventory

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: enabling
- Enabling rationale: Shared baseline/repository/check/transport prerequisite, independently verifiable through its parent criteria.
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-7-bridge-paperclip-knows-the-sessions.md`; original FRs, decisions and criteria below.
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
| `extension/src/core/paperclip/bridge.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/bridge-protocol.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/manager/PaperclipBridgeSettings.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `server/src/routes/plugins.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-7.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given a connected extension and company A ticked, When pairing completes, Then the plugin settings page shows `Connected to Threadkeeper in ` followed by the browser name and the plugin holds rows for company A only.
- **AC-2** Given the extension uses a protocol id other than `paperclip-threadkeeper/1`, When it connects, Then the plugin answers error code `version_mismatch`, both settings screens show `Version mismatch`, and the plugin holds no rows; and Given matching protocol ids and different build commits, Then the connection works and both screens show `Threadkeeper and Paperclip were built from different commits`.
- **AC-3** Given a synthetic library of 2,000 shareable sessions and a new grant, When the first sync runs against a local server, Then the plugin holds 2,000 rows within 60 s, each row has the fields in D-7, and no message was larger than 4 MB.
- **AC-4** Given a synced library, When one session's title changes, Then the stored row has the new title within 10 s; and Given the server restarts, When the extension reconnects, Then the number of rows is unchanged and only changed rows were sent.
- **AC-5** Given a connected extension with its window open, When the plugin sends `threads.list` with limit 20, Then it receives at most 20 rows within 2 s.
- **AC-6** Given no extension has been seen for 40 s, When the plugin sends any request, Then the caller gets error code `browser_offline` in under 1 s.
- **AC-7** Given the browser is running with no extension window open, When the plugin sends `threads.list`, Then the caller gets either rows within 60 s or error code `timeout`.
- **AC-8** Given a session in a local-only project and a session marked excluded, When the inventory syncs, Then neither has a row in the plugin, the shared count excludes both, and a request naming either thread key is answered `not_found`.
- **AC-9** Given company A is granted and company B is not, When a caller in company B asks for sessions, Then it gets error code `denied` and the message `Sessions are not shared with this company.`
- **AC-10** Given a bridge exists for company A, When a second browser tries to pair for company A, Then pairing is refused with the message `Another browser is already connected for {company}. Disconnect it first.`
- **AC-11** Given the founder unticks company A or presses `Disconnect`, When 10 s have passed, Then the plugin holds no row for company A.
- **AC-12** Given the changes of this REQ, When the existing Still protocol tests `tests/unit/dock-*.test.ts` run, Then all pass unchanged.
- **AC-13** Given the library holds threads with provider `paperclip`, When the inventory syncs, Then none of them has a row in the plugin and the shared count excludes them.
- **AC-14** Given a `local_trusted` server, When a request without the header `X-Threadkeeper-Bridge-Token`, or with a revoked token, reaches any bridge route, Then the plugin answers error code `not_paired` and stores and sends nothing.
- **AC-15** Given a request to a bridge route made with an agent API key or run token, When Paperclip handles it, Then it is refused with `denied` and the plugin handler does not run.
- **AC-16** Given REQ-7 is complete, When the Paperclip server restarts, Then Paperclip's plugin list shows `browser-sessions` installed and enabled; and Given the founder disabled it, Then it is still disabled after the restart.

## Verify

Targeted candidate methods (not executed by writing this record):

node ../../../node_modules/vitest/vitest.mjs run (packages/plugins/plugin-browser-sessions/); npx vitest run tests/unit/paperclip-bridge.test.ts (extension/). Actual MV3 long-poll/reconnect/share revocation and plugin install lifecycle need runtime proof.

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
| AC-13 | pending | |
| AC-14 | pending | |
| AC-15 | pending | |
| AC-16 | pending | |

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
