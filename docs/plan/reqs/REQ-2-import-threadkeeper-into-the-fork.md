---
id: REQ-2
title: Import Threadkeeper into the Paperclip fork
epic: EPIC-1
spec: SPEC-3
status: blocked
readiness: 4
effort: med
readiness_gaps: ["blocked by REQ-1", "baseline commit and test counts unknown until REQ-1", "fork push destination not chosen (does not block local work)"]
blocked_by: [REQ-1]
blocks: [REQ-3]
priority: P0
source: BRIEF-1
change:
stack: git, npm, TypeScript, vitest, esbuild
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-2 — Import Threadkeeper into the Paperclip fork

## Overview

Turn the existing Paperclip clone into the hard fork and bring the whole Threadkeeper repository
into it under `extension/`, with its git history. Afterwards one repository holds both codebases and
the extension typechecks, passes its unit tests and builds from `extension/`. Nothing in this REQ
touches the build folder the founder's browser has loaded.

## Problem Statement

Threadkeeper lives in `/Users/andrew/dev/threadkeeper` (remote `AVRCORP/threadkeeper`). Paperclip is
a plain clone of upstream at `/Users/andrew/dev/threadkeeper/paperclip`, nested inside it and
untracked. The founder asked to "completely merge this app into paperclip" and chose a hard fork
(CTX-1, G-4). Every later REQ adds code that touches both, so they need one repository first.

## Solution

Work on a new branch in the existing clone. Add Threadkeeper's baseline commit under the prefix
`extension/` with `git subtree add` and no squash, so the original commits stay reachable with their
original ids. Change no file content. Prove parity with the type checker and unit tests, and with a
test build written to `/tmp/tk-build`. Then move the plan root to `.plan/` at the fork root, because
Paperclip's `docs/` is its documentation site. Nothing is pushed, and the founder's browser keeps
running the build it has until the founder deploys (REQ-3).

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-1-one-codebase.md`.
- Context: `context/platform.md` (Baselines, Stack "Deploy", Conventions "Build identity", Constraints "Live build folder"); CTX-1 (G-4).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, sections "Declared commands" and "Rules specific to this merge".
- Design: none needed; the choices are in the decision table.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: Hard fork; upstream is not followed after the copy | CTX-1 G-4 | agreed | FR-1 / AC-1 | Founder's choice |
| D-2: The fork base is the clone's `master` HEAD when this REQ starts (`edb6945ff3` on 2026-11-13); this REQ does not fetch or pull | `git -C paperclip log -1` on 2026-11-13 `[verified]` | assumed | FR-1 / AC-1 | "Copy Paperclip once". Boundary: if the founder updated the clone, the HEAD at that time is the base and is recorded |
| D-3: Threadkeeper's repository root becomes `extension/`, with no file moved inside it | The build script and tests use paths relative to the package root (`scripts/build-extension.mjs:11-14`) `[verified]` | assumed | FR-2 / AC-2, AC-3 | A prefix move changes no file content. Boundary: a later REQ may split out packages |
| D-4: History is kept with `git subtree add --prefix=extension <threadkeeper path> <baseline>` and no `--squash` | Built into git; needs no new tool | assumed | FR-2 / AC-4 | Original commit ids stay ancestors of the fork. Alternative `git filter-repo` gives cleaner per-path logs but needs a tool whose presence is not confirmed |
| D-5: No build during REQ-2 writes to the folder the founder's browser loads; checks are `npx tsc --noEmit` and `npx vitest run`, and the test build goes to `/tmp/tk-build` | The founder's Edge loads `/Users/andrew/dev/threadkeeper/.output/chrome-mv3` and reloads itself when that folder's build changes; a plain `npm run build` or `npm run check` is therefore a deploy (`scripts/build-extension.mjs:12-17` `[verified]`; the founder's standing rule recorded on 2026-11-13) | agreed | FR-3 / AC-5, AC-6 | Deploys need the founder's go-ahead. The deploy path is REQ-3 FR-5 |
| D-6: The plan root moves to `.plan/` at the fork root | `paperclip/docs/docs.json` shows `docs/` is a documentation site `[verified]`; the planning plugin accepts `.plan/` | assumed | FR-4 / AC-7 | Keeps planning files out of the published docs tree |
| D-7: Nothing is pushed and no remote is created | Outward-facing action; Q-1 is open | unresolved (does not block) | FR-5 / AC-8 | The founder creates the destination and authorises the push separately |
| D-8: Paperclip's `LICENSE` (MIT) stays at the fork root unchanged | `paperclip/LICENSE` `[verified: scan]` | agreed (licence requirement) | FR-5 / AC-8 | MIT requires keeping the notice |

## UI Layout

Infrastructure-only — no UI screens. Architecture assessment: repository layout only; settled by D-3, D-4 and D-6.

## Functional Requirements

### FR-1: Fork branch

The work SHALL happen on a new branch `merge/threadkeeper-import` created from the clone's `master`
HEAD. `master` SHALL stay at its base commit.

- Decision/source: D-1, D-2.
- Exact contract values: clone path `/Users/andrew/dev/threadkeeper/paperclip`; branch name `merge/threadkeeper-import`.

#### Scenario: positive — branch created
- GIVEN the clone's working tree is clean and `extension/` does not exist in it
- WHEN the REQ starts
- THEN `merge/threadkeeper-import` exists at the base commit and the base commit id is recorded in the evidence file

#### Scenario: negative — clone not clean
- GIVEN `git -C paperclip status --porcelain` prints anything
- WHEN the REQ starts
- THEN it stops before creating the branch and reports the paths

#### Scenario: edge — `extension/` already exists
- GIVEN a path named `extension` exists at the fork root
- WHEN the REQ starts
- THEN it stops and imports nothing

### FR-2: Import with history, content unchanged

The fork SHALL contain every file tracked in Threadkeeper at the REQ-1 baseline commit `B`, under
`extension/`, byte for byte, and `B` SHALL be an ancestor of the fork branch.

- Decision/source: D-3, D-4.
- Exact contract values: prefix `extension`; no `--squash`.

#### Scenario: positive — identical tree
- GIVEN the import commit `I` exists on the fork branch
- WHEN `git diff --quiet B I:extension` runs in the fork
- THEN it exits 0

#### Scenario: negative — uncommitted Threadkeeper work
- GIVEN Threadkeeper's working tree has uncommitted or untracked files other than `paperclip/` and `docs/plan/`
- WHEN the import is about to run
- THEN the session lists them, explains they will not be imported, and continues only if the founder says so

#### Scenario: edge — files the fork's ignore rules would hide
- GIVEN Paperclip's root `.gitignore` matches a path that Threadkeeper tracks
- WHEN the import completes
- THEN the path is still tracked under `extension/` (the count of `git ls-files extension` equals the count of `git ls-tree -r --name-only B`)

### FR-3: The extension checks pass from its new place without touching the live browser

From `extension/`, after `npm ci`, `npx tsc --noEmit` SHALL exit 0, `npx vitest run` SHALL pass with
the same number of passing tests as the same command at `B` in the old location, and
`TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs` SHALL exit 0. No command in this REQ
SHALL write to `/Users/andrew/dev/threadkeeper/.output/`.

- Decision/source: D-5.
- Exact contract values: test build folder `/tmp/tk-build`; live folder `/Users/andrew/dev/threadkeeper/.output/chrome-mv3` (or the folder REQ-1 recorded).

#### Scenario: positive — parity
- GIVEN the import commit and `npm ci` done in `extension/`
- WHEN the three commands run in `extension/`
- THEN all exit 0 and the passing-test count equals the baseline count

#### Scenario: negative — a test fails only in the new place
- GIVEN a test passes at `B` in the old location and fails under `extension/`
- WHEN the check runs
- THEN the REQ is not complete; the failure and the path assumption that broke are recorded, and the fix changes build or test configuration only

#### Scenario: edge — the live build is untouched
- GIVEN the modification time of the live folder's `manifest.json` before REQ-2
- WHEN REQ-2 is complete
- THEN that time is unchanged and the baseline count at `B` was taken with `npx vitest run`, not with `npm run check`

### FR-4: Plan root at `.plan/`

The fork SHALL contain the plan at `.plan/` with every file `docs/plan/` held in Threadkeeper at that
time, and SHALL NOT contain a second copy under `extension/docs/plan`.

- Decision/source: D-6.

#### Scenario: positive — plan moved
- GIVEN `docs/plan/` in Threadkeeper holds N files
- WHEN FR-4 completes
- THEN `.plan/` in the fork holds the same N files and `plan.py validate --root .plan` prints no `ERROR`

#### Scenario: negative — plan was committed in the baseline
- GIVEN `docs/plan/` was tracked in `B` and so arrived at `extension/docs/plan`
- WHEN FR-4 completes
- THEN that folder is removed in the same commit that adds `.plan/`

#### Scenario: edge — plan files reference old paths
- GIVEN plan files cite `src/...` and `paperclip/...` paths
- WHEN FR-4 completes
- THEN `.plan/context/platform.md` states the mapping once (`src/` is now `extension/src/`; `paperclip/` is now the repository root) and the citations themselves are updated by each REQ when it is next refined

### FR-5: No outward or core change

This REQ SHALL NOT push, create a remote, edit any Paperclip file, or change the Threadkeeper
repository.

- Decision/source: D-7, D-8.

#### Scenario: positive
- GIVEN the REQ is complete
- WHEN `git -C <fork> diff --stat <base> HEAD -- . ':!extension' ':!.plan'` runs
- THEN it prints nothing

#### Scenario: negative
- GIVEN a step would need a push or a new remote
- WHEN the session reaches it
- THEN it stops and asks the founder

#### Scenario: edge
- N/A — the rule has no boundary case.

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Content integrity | 0 differing bytes between `B` and `I:extension` | At the import commit | `git diff --quiet B I:extension` |
| History | `B` is an ancestor of the fork branch | After import | `git merge-base --is-ancestor B HEAD` exits 0 |
| Live browser safety | 0 writes to the live build folder | Whole REQ | Modification time of the live `manifest.json` before and after |
| Performance | N/A — one-off repository operation | | |

## Constraints from platform

- Auth / access / ownership: local git only. The clone's `origin` is upstream Paperclip and must not be pushed to.
- API / types: none.
- Cache: N/A.
- Files to extend, not reinvent: none edited. `extension/.gitignore` (was Threadkeeper's root `.gitignore`) keeps ignoring `node_modules/`, `.output/` and secrets, relative to `extension/`.
- Dependencies: none added. `npm ci` installs what `extension/package-lock.json` already lists, needs network access, and needs the founder's go-ahead.
- Compatibility / migration / rollout / rollback: rollback is deleting the branch `merge/threadkeeper-import`. The old Threadkeeper repository stays as it is and remains the source of the founder's running build.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| `TK_OUT_DIR` | yes, for every build in this REQ | `extension/scripts/build-extension.mjs:12-14` | Set to `/tmp/tk-build`; a build with it set has no manifest key and cannot open the real library |
| `TK_STABLE_ID` | no | `extension/scripts/build-extension.mjs:95-110` | Leave unset |

## Out of scope

- Root scripts, deploy script, workspace guard — REQ-3.
- Switching the founder's browser to the fork's build — REQ-3 FR-5, run by the founder.
- Pushing, creating a GitHub repository, archiving `AVRCORP/threadkeeper` — the founder's actions (Q-1).
- Moving the fork folder out of the Threadkeeper folder — Q-10.
- Removing Paperclip's workflows, docs or branding — not needed for the merge.

## Acceptance Criteria

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

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-1, D-2 | branch created / clone not clean / `extension` exists | AC-1, AC-9 | git commands in the criteria |
| FR-2 | D-3, D-4 | identical tree / uncommitted work / ignored paths | AC-2, AC-3, AC-4, AC-10 | git commands in the criteria |
| FR-3 | D-5 | parity / fails only in new place / live build untouched | AC-5, AC-6 | `npx tsc --noEmit`, `npx vitest run`, test build; file modification time |
| FR-4 | D-6 | plan moved / plan was committed / old paths | AC-7 | file counts; `plan.py validate` |
| FR-5 | D-7, D-8 | no outward change / needs a push / N/A no boundary | AC-8 | git commands in the criteria |

## Readiness

| Dimension | Pass? | Gap |
|---|---|---|
| Problem & goal | yes | |
| Behavior contract | yes | |
| Acceptance criteria | yes | |
| Context & constraints | no | The baseline commit `B`, its file list and its passing-test count are unknown until REQ-1 records them; `scripts/build-extension.mjs` is being changed by the founder's workstream |
| Buildability | yes | The push destination (Q-1) is open but no step here needs it. D-3, D-4 and D-6 are the planner's defaults with stated boundaries |

**Score: 4/5** — four dimensions pass; no build-blocker inside this REQ.

- Build-blockers: none of its own.
- Separate load gates: blocked by REQ-1. Installing dependencies with `npm ci` needs the founder's go-ahead. No TASKs yet.
- Artifact review: independent review round 1 of 3 (2026-11-13) returned needs-work with 5 findings and overflow; the writer applied fixes the same day; an independent recheck is pending. Report and dispositions: `verify/artifacts/plan-review.md`.
- Stale downstream contracts/evidence: none.

## Changelog

| Date | Change |
|---|---|
| 2026-11-13 | Initial specify; the same day, build checks were changed to never write the live build folder |
