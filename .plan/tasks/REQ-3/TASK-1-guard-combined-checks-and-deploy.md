---
id: TASK-1
req: REQ-3
title: Guard combined checks and deploy
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-3 / TASK-1 — Guard combined checks and deploy

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: enabling
- Enabling rationale: Shared baseline/repository/check/transport prerequisite, independently verifiable through its parent criteria.
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-3-one-build-and-one-check.md`; original FRs, decisions and criteria below.
- Inputs: `.plan/project.md`, `context/CATALOG.md`, `context/platform.md`, `HANDOFF.md`.
- Config: `.plan/config.json` has subagent execution, disjoint ownership, required TDD and three review rounds. A config read/approval is not a successful load gate.
- Workflow/design: `.plan/workflow.md` and `verify/implementation-checkpoint.md`; snapshot approval replaces only the merger-first prerequisite.
- Reuse: existing owning modules; Still keeps its independent identity/consent.
- Do not: alter original checkout/live build, register a real service, push/publish or operate personal provider accounts based on this record.
- Env: key names in parent REQ only; test output `TK_OUT_DIR=/tmp/tk-build`; no stable-ID override.

## File scope and integration

| Owned file / surface | Change | Integration seam / consumer |
|---|---|---|
| `package.json` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `scripts/threadkeeper-check.mjs` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `scripts/threadkeeper-deploy.mjs` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `scripts/threadkeeper.test.mjs` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `scripts/check-node-version-policy.mjs` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-3.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given Node 24.11 or newer, `pnpm install` at the fork root and `npm ci` in `extension/`, When `pnpm run check:all` runs, Then it exits 0 and the extension's passing-test count equals the count in REQ-2's evidence file.
- **AC-2** Given one extension unit test is made to fail on a scratch branch, When `pnpm run check:all` runs, Then it exits non-zero and prints that test's name.
- **AC-3** Given the modification time of the live folder's `manifest.json`, When `pnpm run check:all` runs, Then that time is unchanged and `/tmp/tk-build/manifest.json` exists with no `key` field; and Given `check:extension` is changed to call `npm run check`, Then `check:all` fails with `check:extension must build to /tmp/tk-build only`.
- **AC-4** Given a fresh clone of the fork, When `pnpm install` runs at the root, Then `extension/node_modules` does not exist, `git status --short extension` prints nothing, and `pnpm-lock.yaml` has no importer entry for `extension`.
- **AC-5** Given a clean fork at commit `X`, When `TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs` runs in `extension/`, Then `/tmp/tk-build/manifest.json` has a `version_name` ending in `-` plus the short form of `X` and `)`.
- **AC-6** Given `npm ci` has run in `extension/`, When `extension/node_modules/react/package.json` is read, Then `version` starts with `18.`; and Given `extension` is added to `pnpm-workspace.yaml`, When `pnpm run check:all` runs, Then it fails with `extension must not be a pnpm workspace member (React 18)`.
- **AC-7** Given `TK_LIVE_DIR` is set to the folder the founder's browser loads, When `TK_OUT_DIR=$TK_LIVE_DIR node extension/scripts/build-extension.mjs --print-id` runs, Then it prints the ID the browser's extensions page shows for Threadkeeper and writes nothing.
- **AC-8** Given `TK_LIVE_DIR` is unset, When `pnpm run deploy:extension` runs, Then it exits 1 with `Set TK_LIVE_DIR to the folder your browser loads Threadkeeper from.` and writes nothing; and Given the founder runs it with `TK_LIVE_DIR` set, When the browser reloads the extension, Then the extensions page shows the same ID and Threads shows the same thread count as before.
- **AC-9** Given the commands in FR-1 passed, When `.plan/config.json` is read, Then `test_commands` equals `[["pnpm","typecheck"],["pnpm","test:run"],["pnpm","run","check:extension"]]` and `sdd.py config --repo . --root .plan --json` returns `"ok": true`.

## Verify

Targeted candidate methods (not executed by writing this record):

node --test scripts/threadkeeper.test.mjs (fork root); pnpm run check:all using pinned pnpm9.15.4. Compare live manifest before/after; no live deploy authorized.

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

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
