---
id: TASK-1
req: REQ-1
title: Record snapshot baseline
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-1 / TASK-1 — Record snapshot baseline

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: enabling
- Enabling rationale: Shared baseline/repository/check/transport prerequisite, independently verifiable through its parent criteria.
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-1-start-gate-and-baseline.md`; original FRs, decisions and criteria below.
- Inputs: `.plan/project.md`, `context/CATALOG.md`, `context/platform.md`, `HANDOFF.md`.
- Config: `.plan/config.json` has subagent execution, disjoint ownership, required TDD and three review rounds. A config read/approval is not a successful load gate.
- Workflow/design: `.plan/workflow.md` and `verify/implementation-checkpoint.md`; snapshot approval replaces only the merger-first prerequisite.
- Reuse: existing owning modules; Still keeps its independent identity/consent.
- Do not: alter original checkout/live build, register a real service, push/publish or operate personal provider accounts based on this record.
- Env: key names in parent REQ only; test output `TK_OUT_DIR=/tmp/tk-build`; no stable-ID override.

## File scope and integration

| Owned file / surface | Change | Integration seam / consumer |
|---|---|---|
| `.plan/context/platform.md` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `.plan/verify/baseline.json` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `.plan/HANDOFF.md` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Not applicable: this task only records the approved baseline in plan artifacts; use read-only integrity checks.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-1.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given the founder has named commit `C` and `git merge-base --is-ancestor C HEAD` exits 0 on Threadkeeper `main`, When REQ-1 runs, Then `docs/plan/context/platform.md` has `commit:` equal to the short SHA of HEAD and a Baseline paragraph naming the confirmation date, `C` and `9078b2b`.
- **AC-2** Given the founder has not confirmed, or `git merge-base --is-ancestor C HEAD` exits non-zero, When REQ-1 runs, Then the only change is one dated "gate not met" line in `docs/plan/HANDOFF.md`, `platform.md` still has `commit: 9078b2b`, and no REQ's `status` changed.
- **AC-3** Given the baseline is recorded, When the code map is re-verified, Then every `path:line` citation in `platform.md` into a file listed by `git diff --name-only 9078b2b..HEAD` matches that file at HEAD, and the Coverage section lists each re-read file.
- **AC-4** Given the code map is re-verified, When the affected REQs are re-scored, Then REQ-2, REQ-3, REQ-4, REQ-5, REQ-6, REQ-7, REQ-8, REQ-10 and REQ-11 each have a changelog row dated that day, and `plan.py validate --root docs/plan` prints no `ERROR` line.
- **AC-5** Given the founder says one of the four parts in D-3 is not merged, When REQ-1 runs, Then `HANDOFF.md` lists the four parts each as merged or pending and each REQ that depends on a pending part has a `readiness_gaps` entry naming that part.
- **AC-6** Given AC-1 holds and FR-3 and FR-4 are complete, When REQ-1 completes, Then `docs/plan/config.json` has `"enabled": true` under `hooks` and `sdd.py config --repo . --root docs/plan --json` returns `"ok": true`.
- **AC-7** Given `git status --short` lists any change outside `docs/plan/` and `paperclip/` at the time of the check, When REQ-1 runs, Then the session shows those paths to the founder and continues only after the founder says they are unrelated.
- **AC-8** Given REQ-1 has run to completion, When `git status --short` is compared with its output before REQ-1, Then every new or changed path is under `docs/plan/`.
- **AC-9** Given the gate passed, When FR-6 runs, Then `context/platform.md` has a "Live install" paragraph with the folder the browser loads, the ID its extensions page shows (or the `--print-id` result marked "not confirmed on the extensions page"), and whether that folder's `manifest.json` has a `key`, and the modification time of that `manifest.json` is unchanged.

## Verify

Targeted candidate methods (not executed by writing this record):

Read-only ancestry, snapshot hash and live manifest comparison. No implementation test applies to plan-only recording.

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
