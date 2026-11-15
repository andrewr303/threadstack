---
id: TASK-1
req: REQ-2
title: Import history and current snapshot
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-2 / TASK-1 — Import history and current snapshot

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: enabling
- Enabling rationale: Shared baseline/repository/check/transport prerequisite, independently verifiable through its parent criteria.
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-2-import-threadkeeper-into-the-fork.md`; original FRs, decisions and criteria below.
- Inputs: `.plan/project.md`, `context/CATALOG.md`, `context/platform.md`, `HANDOFF.md`.
- Config: `.plan/config.json` has subagent execution, disjoint ownership, required TDD and three review rounds. A config read/approval is not a successful load gate.
- Workflow/design: `.plan/workflow.md` and `verify/implementation-checkpoint.md`; snapshot approval replaces only the merger-first prerequisite.
- Reuse: existing owning modules; Still keeps its independent identity/consent.
- Do not: alter original checkout/live build, register a real service, push/publish or operate personal provider accounts based on this record.
- Env: key names in parent REQ only; test output `TK_OUT_DIR=/tmp/tk-build`; no stable-ID override.

## File scope and integration

| Owned file / surface | Change | Integration seam / consumer |
|---|---|---|
| `extension/**` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `.plan/**` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Unchanged history/file import is checked by ancestry and byte/hash parity plus the regression suite; do not invent a red test for copying files. Later changed code still requires TDD.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-2.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given the clone at `/Users/andrew/dev/threadkeeper/paperclip` is clean and has no `extension` path, When REQ-2 starts, Then branch `merge/threadkeeper-import` exists at the clone's `master` HEAD and that commit id is written to the evidence file.
- **AC-2** Given the import commit `I` and the REQ-1 baseline `B`, When `git diff --quiet B I:extension` runs in the fork, Then it exits 0.
- **AC-3** Given the import commit, When `git ls-files extension | wc -l` and `git ls-tree -r --name-only B | wc -l` run, Then the two numbers are equal.
- **AC-4** Given the import commit, When `git merge-base --is-ancestor B HEAD` runs on the fork branch, Then it exits 0.
- **AC-5** Given `npm ci` has run in `extension/`, When `npx tsc --noEmit`, `npx vitest run` and `TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs` run in `extension/`, Then all three exit 0 and the number of passing tests equals the number reported by `npx vitest run` at `B` in `/Users/andrew/dev/threadkeeper`.
- **AC-6** Given the modification time of `/Users/andrew/dev/threadkeeper/.output/chrome-mv3/manifest.json` recorded before REQ-2 starts, When REQ-2 is complete, Then that time is unchanged, and `/tmp/tk-build/manifest.json` has no `key` field.
- **AC-7** Given `docs/plan/` in Threadkeeper holds N files, When FR-4 completes, Then `.plan/` in the fork holds the same N files, `extension/docs/plan` does not exist, and `plan.py validate --root .plan` prints no `ERROR` line.
- **AC-8** Given REQ-2 is complete, When `git diff --stat <base> HEAD -- . ':!extension' ':!.plan'` runs in the fork, Then it prints nothing, `git remote -v` lists no remote that was not there before, and `git -C /Users/andrew/dev/threadkeeper log -1 --format=%H` is unchanged.
- **AC-9** Given the clone is not clean, or a path named `extension` already exists in it, When REQ-2 starts, Then nothing is created and the reason is reported.
- **AC-10** Given Threadkeeper has uncommitted or untracked files other than `paperclip/` and `docs/plan/`, When the import is about to run, Then the session lists them and imports only after the founder says to continue.

## Verify

Targeted candidate methods (not executed by writing this record):

npx tsc --noEmit; npx vitest run; TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs (extension/). Compare import tree/ancestry and overlay hashes separately.

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

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
