---
id: REQ-1
title: Start gate and baseline after the multi-profile work lands
epic: EPIC-1
spec: SPEC-2
status: in-progress
readiness: 4
effort: low
readiness_gaps: ["implementation drafted against approved snapshot; final acceptance and ordered independent reviews pending"]
blocked_by: []
blocks: [REQ-2]
priority: P0
source: BRIEF-1
change:
stack: planning artifacts and read-only git
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-1 — Start gate and baseline after the multi-profile work lands

## Authorized current-snapshot alternative (2026-11-13)

The founder requested full implementation and answered `yes` when asked to use the current working
snapshot in the Paperclip fork and install its pinned dependencies, preserving the original checkout
and live extension. This later instruction supersedes the original merger-only prerequisite in
FR-1/D-1/D-2 and the corresponding preconditions of AC-1, AC-2, AC-5 and AC-7 for this implementation.
The original criteria below are retained verbatim for traceability; they must not be reported as
having passed through a merge that did not happen. The accepted baseline is committed source
`9078b2b261d2e12b8bc3230090f217b40e7c9b81` plus the 443-file working snapshot recorded in
`verify/baseline.json`. All four multi-profile workstream parts remain **not proven merged**;
their snapshot contents are preserved, and their quality is outside this gate's claim.

The alternative passes only when the approval, baseline hashes, preserved original source/live
manifest, refreshed code map and affected constraint decisions are evidenced. No TASK load gate,
readiness check, hook activation, independent review or completion gate is inferred from approval.
Hooks remain off at this checkpoint; AC-6 remains pending. The lead retains the final baseline
and integration audit. No application files in the original checkout are to be edited.

## Overview

Before any merge work, confirm that the founder's separate multi-profile workstream is merged into
Threadkeeper `main`, record that commit as this plan's baseline, re-verify the plan's code map
against it, and re-score the REQs that build on the changed files. This REQ changes planning
artifacts only. It changes no application code in either codebase.

## Problem Statement

This plan was written on 2026-11-13 against Threadkeeper `9078b2b` while the founder was changing
the same areas later REQs build on: accounts and cookies, the embedded workspace, the rail and
session list, Threads and Dashboard. On that day `git status` showed uncommitted changes in 18
source files and a new `src/core/accounts/set-cookie.ts` (`context/platform.md`, "In flux"). The
founder said: "can't have colliding changes, plus I don't want any of this to be done until those
fixes are made" (CTX-1, G-6). Starting early would collide with that work, and specs that cite old
file contents would mislead whoever builds them.

## Solution

Make the wait an explicit first requirement. The next session asks the founder for the merge commit,
proves with read-only git that it is in `main`, writes it into `context/platform.md`, re-reads every
cited file that changed since `9078b2b`, and adds a dated row to each affected REQ. Only then are the
session hooks turned on and REQ-2 allowed to proceed.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-1-one-codebase.md`.
- Context: `context/platform.md` (all sections, especially "In flux" and "Coverage");
  `context/plan/CTX-1-founder-request-and-decisions.md` (G-5, G-6).
- Config: `docs/plan/config.json`, validated with `sdd.py config` on 2026-11-13 (`ok: true`):
  `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`,
  `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: none needed; no architecture is decided here.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: Nothing in this plan starts until the multi-profile workstream is merged | Founder's message, CTX-1 G-6 | agreed | FR-1 / AC-1, AC-2 | The founder is editing the same files |
| D-2: "Merged" is proven by the founder naming the commit and git showing it is an ancestor of `main`'s HEAD | Planner's choice `[assumed]` | assumed | FR-1 / AC-1, AC-2 | A statement alone could refer to a branch. Boundary: if the founder merges by squash, the named commit is the squash commit on `main` |
| D-3: The four parts of the workstream are tracked separately (accounts in one extension; Claude display and landing page; indexing for every signed-in profile; filter, sort and group controls) | CTX-1, scope change | agreed | FR-1 / AC-5 | The founder may merge them at different times |
| D-4: Session hooks stay off until the gate passes | `config.json` `hooks.enabled: false`, set on 2026-11-13 | agreed (follows G-6) | FR-5 / AC-6 | With hooks on, this plan's state would load into the founder's other sessions in this repository |
| D-5: The REQs that must be re-scored are REQ-2, REQ-3, REQ-4, REQ-5, REQ-6, REQ-7, REQ-8, REQ-10 and REQ-11 at minimum | They cite the build script, the workspace, accounts, embed scripts, content script, rail or session list, all changed by the workstream on 2026-11-13 (`context/platform.md`, "In flux") | assumed | FR-4 / AC-4 | Any other REQ whose cited files changed is added to the list |
| D-6: Record how the founder's browser loads Threadkeeper at the time of the gate | The live folder, its path-based ID and the absence of a manifest key decide REQ-2 and REQ-3 (`scripts/build-extension.mjs:95-110` `[verified]`, live `manifest.json` `[verified]`) | assumed | FR-6 / AC-9 | The workstream changes `scripts/build-extension.mjs`, so the facts may change |

## UI Layout

Infrastructure-only — no UI screens. Architecture assessment: none required; this REQ reads git
history and edits Markdown under the plan root.

## Functional Requirements

### FR-1: Hold until the founder confirms the merge

The session SHALL NOT scope, load or build any REQ of this plan until the founder has named the
commit (or commits) on Threadkeeper `main` that contain the multi-profile workstream and
`git merge-base --is-ancestor <commit> HEAD` exits 0 on `main`.

- Decision/source: D-1, D-2, D-3.
- Exact contract values: the check runs in `/Users/andrew/dev/threadkeeper` on branch `main`.
  Uncommitted work is checked across the whole working tree except `docs/plan/` and `paperclip/`
  (the workstream also changed `scripts/build-extension.mjs`, `src/core/schema.ts` and
  `src/entrypoints/*.ts`, `context/platform.md` "In flux").

#### Scenario: positive — merged and confirmed
- GIVEN the founder says the workstream is merged and names commit `C`
- WHEN the session runs `git merge-base --is-ancestor C HEAD` on `main` and it exits 0
- THEN the gate passes and FR-2 to FR-5 proceed

#### Scenario: negative — not confirmed, or not in main
- GIVEN the founder has not confirmed, or `C` is not an ancestor of `main`'s HEAD
- WHEN the session starts on this plan
- THEN it stops, changes no artifact except one dated line "gate not met" in `HANDOFF.md`, and no REQ changes status

#### Scenario: edge — uncommitted work remains in the affected directories
- GIVEN `C` is an ancestor of HEAD but `git status --short` lists changes outside `docs/plan/` and `paperclip/`
- WHEN the session checks the gate
- THEN it lists those paths to the founder and proceeds only if the founder answers that the listed changes are unrelated

#### Scenario: edge — only part of the workstream is merged
- GIVEN the founder says some of the four parts in D-3 are not merged yet
- WHEN the session records the gate
- THEN `HANDOFF.md` lists each part as merged or pending, and every REQ that depends on a pending part keeps a `readiness_gaps` entry naming it

### FR-2: Record the baseline

The session SHALL write the baseline into `context/platform.md`: frontmatter `commit:` set to the
short SHA of `main`'s HEAD at the time, and a "Baseline" paragraph naming the confirmation date, the
commit or commits the founder named, and the previous baseline `9078b2b`.

- Decision/source: D-2.

#### Scenario: positive — baseline written
- GIVEN the gate passed at HEAD `H`
- WHEN FR-2 runs
- THEN `platform.md` has `commit: <short H>` and the Baseline paragraph

#### Scenario: negative — gate not passed
- GIVEN the gate did not pass
- WHEN the session ends
- THEN `platform.md` still has `commit: 9078b2b`

#### Scenario: edge
- N/A — the write is a single replacement of one frontmatter value and one paragraph.

### FR-3: Re-verify the code map

For every file listed by `git diff --name-only 9078b2b..HEAD`, the session SHALL re-read each
`path:line` citation `platform.md` makes into that file and correct or remove it, and SHALL add any
new module the workstream introduced that later REQs depend on (accounts, cookies, frames, rail,
session lists). The "In flux" paragraph is replaced by a statement of what changed.

- Decision/source: D-5.

#### Scenario: positive — citations corrected
- GIVEN `src/entrypoints/manager/workspace/state.ts` changed since `9078b2b`
- WHEN FR-3 runs
- THEN each citation into that file in `platform.md` matches the file at HEAD and the Coverage section lists the file as re-read

#### Scenario: negative — a cited file was deleted or renamed
- GIVEN a cited file no longer exists at HEAD
- WHEN FR-3 runs
- THEN the citation is replaced by the new location, or the statement is removed and listed under Coverage as "no longer true"

#### Scenario: edge — nothing changed in a cited file
- GIVEN a cited file is not in the diff
- WHEN FR-3 runs
- THEN its citations are left as they are and the file is not re-read

### FR-4: Re-score the affected REQs

The session SHALL add a changelog row dated that day to REQ-2, REQ-3, REQ-4, REQ-5, REQ-6, REQ-7,
REQ-8, REQ-10 and REQ-11, and to any other REQ whose "Constraints from platform" cites a changed file. The row says either
"constraints unchanged at <short H>" or names the constraint edits made. `readiness` and
`readiness_gaps` are recomputed with `references/readiness.md`.

- Decision/source: D-5.

#### Scenario: positive — REQ updated
- GIVEN REQ-11 cites the account model and the account model changed
- WHEN FR-4 runs
- THEN REQ-11's constraints describe the merged account model, its decision D-6 is updated, and a changelog row records it

#### Scenario: negative — a re-score would need a founder decision
- GIVEN the merged code makes a REQ's approach impossible
- WHEN FR-4 runs
- THEN the REQ's readiness is set to at most 3, the reason is added to `readiness_gaps`, and the question is added to `HANDOFF.md`; the REQ's requirements are not weakened to fit

#### Scenario: edge — a REQ cites no changed file
- GIVEN REQ-12 cites only files outside the diff
- WHEN FR-4 runs
- THEN REQ-12 gets no changelog row

### FR-5: Turn the session hooks on

After FR-1 to FR-4, the session SHALL set `hooks.enabled` to `true` in the plan's `config.json` and
confirm `sdd.py config` reports `ok: true`.

- Decision/source: D-4.

#### Scenario: positive
- GIVEN the gate passed and the artifacts are updated
- WHEN FR-5 runs
- THEN `config.json` has `"enabled": true` and config validation passes

#### Scenario: negative
- GIVEN the gate did not pass
- WHEN the session ends
- THEN `config.json` still has `"enabled": false`

#### Scenario: edge
- N/A — one boolean.

### FR-6: Record the live install

The session SHALL add a "Live install" paragraph to `context/platform.md` naming the folder the
founder's browser loads Threadkeeper from, the extension ID the browser's extensions page shows,
whether that folder's `manifest.json` has a `key` field, and the ID that
`node scripts/build-extension.mjs --print-id` reports for it. It SHALL NOT build into that folder.

- Decision/source: D-6.
- Exact contract values: folder on 2026-11-13 `/Users/andrew/dev/threadkeeper/.output/chrome-mv3`; ID on 2026-11-13 `bajiblleoodfabmofjmcjeejhbjikfkp`; `key` absent.

#### Scenario: positive — facts unchanged
- GIVEN the browser still loads the same folder with the same ID and no key
- WHEN FR-6 runs
- THEN the paragraph repeats those facts with the new date

#### Scenario: negative — the founder moved to the fixed-key ID
- GIVEN the live `manifest.json` now has a `key`, or the ID differs
- WHEN FR-6 runs
- THEN the paragraph records the new facts and REQ-3's D-6 and Q-11 are re-scored in FR-4

#### Scenario: edge — the founder cannot confirm the ID right now
- GIVEN the founder is not available to read the extensions page
- WHEN FR-6 runs
- THEN the paragraph records the ID from `--print-id` and marks it "not confirmed on the extensions page"

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Safety of the gate | Zero files changed outside `docs/plan/` | Whole REQ | `git status --short` before and after shows changes only under `docs/plan/` |
| Performance, reliability | N/A — planning-only work with no runtime | | |

## Constraints from platform

- Auth / access / ownership: read-only git in `/Users/andrew/dev/threadkeeper`. No push, commit, merge, checkout or stash.
- API / types: none.
- Cache: N/A.
- Files to extend, not reinvent: `docs/plan/context/platform.md`, `docs/plan/HANDOFF.md`, the REQ files, `docs/plan/config.json`.
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: rollback is restoring the previous contents of the edited plan files.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| `hooks.enabled` | yes | `docs/plan/config.json` | `false` until AC-1 holds |

## Out of scope

- Any edit to application code, tests, build scripts or git state — this REQ only reads them.
- Judging the quality of the multi-profile work.
- Scoping or building REQ-2 — a separate step after this REQ is done.

## Acceptance Criteria

- **AC-1** Given the founder has named commit `C` and `git merge-base --is-ancestor C HEAD` exits 0 on Threadkeeper `main`, When REQ-1 runs, Then `docs/plan/context/platform.md` has `commit:` equal to the short SHA of HEAD and a Baseline paragraph naming the confirmation date, `C` and `9078b2b`.
- **AC-2** Given the founder has not confirmed, or `git merge-base --is-ancestor C HEAD` exits non-zero, When REQ-1 runs, Then the only change is one dated "gate not met" line in `docs/plan/HANDOFF.md`, `platform.md` still has `commit: 9078b2b`, and no REQ's `status` changed.
- **AC-3** Given the baseline is recorded, When the code map is re-verified, Then every `path:line` citation in `platform.md` into a file listed by `git diff --name-only 9078b2b..HEAD` matches that file at HEAD, and the Coverage section lists each re-read file.
- **AC-4** Given the code map is re-verified, When the affected REQs are re-scored, Then REQ-2, REQ-3, REQ-4, REQ-5, REQ-6, REQ-7, REQ-8, REQ-10 and REQ-11 each have a changelog row dated that day, and `plan.py validate --root docs/plan` prints no `ERROR` line.
- **AC-5** Given the founder says one of the four parts in D-3 is not merged, When REQ-1 runs, Then `HANDOFF.md` lists the four parts each as merged or pending and each REQ that depends on a pending part has a `readiness_gaps` entry naming that part.
- **AC-6** Given AC-1 holds and FR-3 and FR-4 are complete, When REQ-1 completes, Then `docs/plan/config.json` has `"enabled": true` under `hooks` and `sdd.py config --repo . --root docs/plan --json` returns `"ok": true`.
- **AC-7** Given `git status --short` lists any change outside `docs/plan/` and `paperclip/` at the time of the check, When REQ-1 runs, Then the session shows those paths to the founder and continues only after the founder says they are unrelated.
- **AC-8** Given REQ-1 has run to completion, When `git status --short` is compared with its output before REQ-1, Then every new or changed path is under `docs/plan/`.
- **AC-9** Given the gate passed, When FR-6 runs, Then `context/platform.md` has a "Live install" paragraph with the folder the browser loads, the ID its extensions page shows (or the `--print-id` result marked "not confirmed on the extensions page"), and whether that folder's `manifest.json` has a `key`, and the modification time of that `manifest.json` is unchanged.

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-1, D-2, D-3 / CTX-1 G-6 | merged and confirmed / not confirmed / uncommitted work, part merged | AC-1, AC-2, AC-5, AC-7 | Read-only git commands named in the criteria; the founder's answer quoted in `HANDOFF.md` |
| FR-2 | D-2 | baseline written / gate not passed / N/A single replacement | AC-1, AC-2 | Read `platform.md` frontmatter |
| FR-3 | D-5 | citations corrected / file deleted or renamed / unchanged file | AC-3 | Compare each citation with the file at HEAD |
| FR-4 | D-5 | REQ updated / needs a decision / cites no changed file | AC-4 | Read the changelog rows; `plan.py validate` |
| FR-5 | D-4 | hooks on / gate not passed / N/A one boolean | AC-6, AC-2 | `sdd.py config` |
| FR-6 | D-6 | facts unchanged / fixed-key move / founder unavailable | AC-9 | Read the live manifest; `--print-id`; the founder reads the extensions page |
| NFR safety | D-1 | — | AC-8 | `git status --short` before and after |

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
| 2026-11-13 | Recorded explicit founder approval of the current-snapshot alternative; no multi-profile merge or original merge-only AC pass is claimed. Full code-map refresh and completion evidence remain pending. |
