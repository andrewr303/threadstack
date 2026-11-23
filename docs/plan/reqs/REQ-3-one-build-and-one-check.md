---
id: REQ-3
title: One check for the whole fork and a safe deploy of the extension
epic: EPIC-1
spec: SPEC-4
status: blocked
readiness: 4
effort: low
readiness_gaps: ["blocked by REQ-2", "Threadkeeper toolchain on Node 24 not yet tried", "which folder the browser loads after the merge (Q-11) has a default but no answer"]
blocked_by: [REQ-2]
blocks: [REQ-4]
priority: P0
source: BRIEF-1
change:
stack: pnpm, npm, TypeScript, vitest, esbuild, Node 24
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-3 — One check for the whole fork and a safe deploy of the extension

## Overview

From the fork root, one command typechecks and tests Paperclip and the extension and makes a test
build of the extension that cannot reach the founder's browser. A second command, run by the
founder, deploys the fork's extension into the folder the founder's browser already loads, so the
extension ID and the library stay the same.

## Problem Statement

After REQ-2 the fork has two toolchains side by side: Paperclip uses pnpm, Node 24.11 or newer and
React 19; the extension uses npm, esbuild and React 18. Nothing ties them together, so a change that
breaks one side can go unnoticed. And the extension's own `npm run build` and `npm run check` write
into whichever folder a browser loads, which for the founder is a deploy to the running browser
(`scripts/build-extension.mjs:12-17`). The fork needs a check that is safe to run at any time and a
deploy that keeps the founder's library.

## Solution

Keep the extension as its own npm package. Add three root scripts: `check:extension` (type check,
unit tests, test build to `/tmp/tk-build`), `check:all` (Paperclip's checks plus `check:extension`)
and `deploy:extension` (build into the folder named by `TK_LIVE_DIR`). Do not add the extension to
the pnpm workspace: the workspace overrides `react` and `react-dom` to `^19.2.8` for every member
(`paperclip/pnpm-workspace.yaml`). The build stamp needs no change: it already records the git
commit of the folder it is built from (`scripts/build-extension.mjs:30-37`).

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-1-one-codebase.md`; REQ-2 (baseline test counts).
- Context: `context/platform.md` (Stack "Deploy", Conventions "Build identity", Constraints "Live build folder"); CTX-1 (G-4).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, sections "Declared commands" and "Rules specific to this merge".
- Design: none needed.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: `extension/` is not a pnpm workspace member in v1 and keeps npm and its lockfile | Workspace override `react: ^19.2.8` (`paperclip/pnpm-workspace.yaml`) against the extension's `react: ^18.3.1` (`package.json`) `[verified]` | assumed | FR-3 / AC-4, AC-6 | Avoids a React upgrade of UI the founder is changing. Boundary: revisit when the extension moves to React 19 |
| D-2: Root script names `check:extension`, `check:all`, `deploy:extension`; existing root scripts are unchanged | Existing names `build`, `typecheck`, `test:run`, `verify` (`paperclip/package.json`) `[verified]` | assumed | FR-1, FR-5 / AC-1, AC-8 | New names collide with none |
| D-3: Both toolchains run on one Node version, 24.11 or newer | Paperclip `engines.node` `>=24.11.0` `[verified]` | assumed | FR-1 / AC-2 | One Node on the machine. Boundary: the Mac helper's own floor stays Node 22 (`docs/mac-helper.md:20`) |
| D-4: The build stamp already names the commit: `buildId` is `<UTC stamp>-<git rev-parse --short HEAD>` of the folder built, or `nogit` | `scripts/build-extension.mjs:26-37` `[verified]`; the live build reads `0.5.0 (build 20261113.202409-nogit)` `[verified]` | agreed (existing behaviour) | FR-4 / AC-5 | Inside the fork, `extension/` is in the fork's repository, so the commit is the fork's. No code change |
| D-5: Checks never write to a folder a browser loads: `check:extension` builds only to `/tmp/tk-build` and never runs `npm run build` or `npm run check` | The founder's standing rule recorded on 2026-11-13; `scripts/build-extension.mjs:12-17` `[verified]` | agreed | FR-2 / AC-3 | A plain build is a deploy |
| D-6: `deploy:extension` builds with `TK_OUT_DIR` set to `TK_LIVE_DIR` | A build with `TK_OUT_DIR` set has no manifest key and the ID derived from the target folder's path (`scripts/build-extension.mjs:105-110`) `[verified]`; the founder's browser identifies Threadkeeper today by that path-based ID: the live `manifest.json` has no `key` `[verified]` | assumed (Q-11 open) | FR-5 / AC-7, AC-8 | Same folder, same ID, same library. Alternative: move the library to the fixed-key ID by backup and restore (`docs/mac-helper.md`, "The extension ID") |
| D-7: Only the founder runs `deploy:extension`, or an agent with the founder's go-ahead for that one run | The founder's global rule: deploys need authorisation for that specific action | agreed | FR-5 / AC-8 | |
| D-8: `test_commands` in the plan config are set here | `workflow.md` says REQ-3 records the final arrays | agreed (plan convention) | FR-6 / AC-9 | Paths are final after REQ-2 |

## UI Layout

Infrastructure-only — no UI screens. The commit already appears in the extension's Diagnostics panel
under "Files on disk" (`src/entrypoints/manager/Diagnostics.tsx:185`); nothing is added.

## Functional Requirements

### FR-1: Check everything with one command

The fork root `package.json` SHALL define `check:extension` as
`cd extension && npx tsc --noEmit && npx vitest run && TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs`
and `check:all` as `pnpm typecheck && pnpm test:run && pnpm run check:extension`.

- Decision/source: D-2, D-3, D-5.

#### Scenario: positive — all pass
- GIVEN Node 24.11 or newer, `pnpm install` at the root and `npm ci` in `extension/`
- WHEN `pnpm run check:all` runs
- THEN it exits 0 and the extension's passing-test count equals the count recorded in REQ-2's evidence

#### Scenario: negative — one extension test fails
- GIVEN an extension unit test that fails
- WHEN `pnpm run check:all` runs
- THEN it exits non-zero and the failing test's name is in the output

#### Scenario: edge — Node 24 breaks the extension's tooling
- GIVEN the extension's checks passed on the Node version used before and fail on Node 24.11 or newer
- WHEN this REQ is built
- THEN the fix is limited to build and test configuration and dev dependencies already in `extension/package.json`; if a new or replaced dependency is needed, the session stops and asks the founder

### FR-2: Checks never reach the browser

No root script except `deploy:extension` SHALL write outside `/tmp/tk-build` for the extension build.

- Decision/source: D-5.

#### Scenario: positive
- GIVEN the founder's browser loads a folder with a build in it
- WHEN `pnpm run check:all` runs
- THEN that folder's `manifest.json` modification time is unchanged

#### Scenario: negative
- GIVEN someone changes `check:extension` to call `npm run check` or `npm run build`
- WHEN `pnpm run check:all` runs
- THEN a check fails with the message `check:extension must build to /tmp/tk-build only`

#### Scenario: edge
- GIVEN `/tmp/tk-build` holds a previous test build
- WHEN `check:extension` runs
- THEN the folder is replaced by the new test build and the run succeeds

### FR-3: The extension keeps its own React

Installing at the fork root SHALL NOT change which React the extension uses.

- Decision/source: D-1.

#### Scenario: positive
- GIVEN `pnpm install` at the root and `npm ci` in `extension/`
- WHEN `extension/node_modules/react/package.json` is read
- THEN its `version` starts with `18.`

#### Scenario: negative
- GIVEN someone adds `extension` to `pnpm-workspace.yaml`
- WHEN `check:all` runs
- THEN a check fails with the message `extension must not be a pnpm workspace member (React 18)`

#### Scenario: edge
- GIVEN `pnpm install` runs at the root
- WHEN `pnpm-lock.yaml` is inspected
- THEN it has no importer entry for `extension`

### FR-4: The build stamp names the fork commit

A build of `extension/` SHALL carry the fork's short commit in `version_name`, as the build script
already does.

- Decision/source: D-4.

#### Scenario: positive
- GIVEN a clean fork at commit `X`
- WHEN `TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs` runs in `extension/`
- THEN `/tmp/tk-build/manifest.json` has a `version_name` ending in `-` plus the short form of `X` and `)`

#### Scenario: negative
- GIVEN `git` cannot run
- WHEN the build runs
- THEN it succeeds and `version_name` ends in `-nogit)`

#### Scenario: edge
- N/A — existing behaviour, verified only.

### FR-5: Deploy keeps the founder's ID

`pnpm run deploy:extension` SHALL exit 1 with the message
`Set TK_LIVE_DIR to the folder your browser loads Threadkeeper from.` when `TK_LIVE_DIR` is unset,
and otherwise SHALL build the extension with `TK_OUT_DIR` set to `TK_LIVE_DIR`.

- Decision/source: D-6, D-7.

#### Scenario: positive
- GIVEN `TK_LIVE_DIR=/Users/andrew/dev/threadkeeper/.output/chrome-mv3`
- WHEN `TK_OUT_DIR=$TK_LIVE_DIR node extension/scripts/build-extension.mjs --print-id` runs
- THEN it prints the same ID the founder's browser shows for Threadkeeper, and builds nothing

#### Scenario: negative
- GIVEN `TK_LIVE_DIR` is unset
- WHEN `pnpm run deploy:extension` runs
- THEN it exits 1 with the message above and writes nothing

#### Scenario: edge — the founder deploys
- GIVEN the founder runs `pnpm run deploy:extension` with `TK_LIVE_DIR` set to the folder their browser loads
- WHEN the browser reloads the extension
- THEN the extensions page shows the same ID and the Threads view shows the same thread count as before

### FR-6: Plan config lists the commands

After FR-1 passes, `.plan/config.json` SHALL have `test_commands` equal to
`[["pnpm","typecheck"],["pnpm","test:run"],["pnpm","run","check:extension"]]`.

- Decision/source: D-8.

#### Scenario: positive
- GIVEN the three commands passed during this REQ
- WHEN the config is written
- THEN `sdd.py config --repo . --root .plan --json` returns `"ok": true` and lists the three arrays

#### Scenario: negative
- GIVEN one of the three commands could not be made to pass
- WHEN the REQ ends
- THEN that array is left out and the reason is in `workflow.md`

#### Scenario: edge
- N/A — a fixed list.

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Isolation of toolchains | 0 files created or changed under `extension/` by `pnpm install` at the root | Fresh clone | `git status --short extension` and absence of `extension/node_modules` after `pnpm install` |
| Live browser safety | 0 writes to any folder a browser loads during `check:all` | Every run | Modification time of the live `manifest.json` |
| Run time | N/A — no budget set | | |

## Constraints from platform

- Auth / access / ownership: local only. Deploy is the founder's action (D-7).
- API / types: `BuildInfo` (`extension/src/core/build-info.ts:8-25`); `decideManifestKey` and `--print-id` in `extension/scripts/build-extension.mjs:95-110`, `:675-676`. Both are being changed by the founder's workstream; re-read after REQ-1.
- Cache: N/A.
- Files to extend, not reinvent: fork root `package.json` (scripts only); one small guard script at the fork root for FR-2 and FR-3 messages; `extension/` files unchanged.
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: removing the three scripts restores the fork root to REQ-2 state. Moving the library to the fixed-key ID instead (Q-11) follows `docs/mac-helper.md` "The extension ID" and is the founder's choice.
- Two writers: after the founder's first deploy from the fork, a plain `npm run build` in the old checkout would put pre-merge code back into the live folder. From then on the old checkout is not built; the running build's commit is visible in Diagnostics ("Files on disk"), so a rollback shows. HANDOFF section 2 states the rule.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| `TK_LIVE_DIR` | yes, for `deploy:extension` only | fork root `package.json` | The folder the founder's browser loads Threadkeeper from; today `/Users/andrew/dev/threadkeeper/.output/chrome-mv3` |
| `TK_OUT_DIR` | set by the scripts | `extension/scripts/build-extension.mjs:12-14` | Never set by hand to the live folder except through `deploy:extension` |
| `test_commands` | yes | `.plan/config.json` | Three argv arrays, FR-6 |

## Out of scope

- Moving the extension to React 19, Vite or the pnpm workspace — would change UI the founder is editing.
- Paperclip's continuous-integration workflows — not needed for a single-user fork.
- Moving the library to the fixed-key ID — the founder's choice under Q-11.
- Packaging or publishing the extension.

## Acceptance Criteria

- **AC-1** Given Node 24.11 or newer, `pnpm install` at the fork root and `npm ci` in `extension/`, When `pnpm run check:all` runs, Then it exits 0 and the extension's passing-test count equals the count in REQ-2's evidence file.
- **AC-2** Given one extension unit test is made to fail on a scratch branch, When `pnpm run check:all` runs, Then it exits non-zero and prints that test's name.
- **AC-3** Given the modification time of the live folder's `manifest.json`, When `pnpm run check:all` runs, Then that time is unchanged and `/tmp/tk-build/manifest.json` exists with no `key` field; and Given `check:extension` is changed to call `npm run check`, Then `check:all` fails with `check:extension must build to /tmp/tk-build only`.
- **AC-4** Given a fresh clone of the fork, When `pnpm install` runs at the root, Then `extension/node_modules` does not exist, `git status --short extension` prints nothing, and `pnpm-lock.yaml` has no importer entry for `extension`.
- **AC-5** Given a clean fork at commit `X`, When `TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs` runs in `extension/`, Then `/tmp/tk-build/manifest.json` has a `version_name` ending in `-` plus the short form of `X` and `)`.
- **AC-6** Given `npm ci` has run in `extension/`, When `extension/node_modules/react/package.json` is read, Then `version` starts with `18.`; and Given `extension` is added to `pnpm-workspace.yaml`, When `pnpm run check:all` runs, Then it fails with `extension must not be a pnpm workspace member (React 18)`.
- **AC-7** Given `TK_LIVE_DIR` is set to the folder the founder's browser loads, When `TK_OUT_DIR=$TK_LIVE_DIR node extension/scripts/build-extension.mjs --print-id` runs, Then it prints the ID the browser's extensions page shows for Threadkeeper and writes nothing.
- **AC-8** Given `TK_LIVE_DIR` is unset, When `pnpm run deploy:extension` runs, Then it exits 1 with `Set TK_LIVE_DIR to the folder your browser loads Threadkeeper from.` and writes nothing; and Given the founder runs it with `TK_LIVE_DIR` set, When the browser reloads the extension, Then the extensions page shows the same ID and Threads shows the same thread count as before.
- **AC-9** Given the commands in FR-1 passed, When `.plan/config.json` is read, Then `test_commands` equals `[["pnpm","typecheck"],["pnpm","test:run"],["pnpm","run","check:extension"]]` and `sdd.py config --repo . --root .plan --json` returns `"ok": true`.

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-2, D-3, D-5 | all pass / one test fails / Node 24 | AC-1, AC-2 | Run the script on Node 24.11 or newer |
| FR-2 | D-5 | untouched / plain build added / old test build | AC-3 | File modification time; guard check |
| FR-3 | D-1 | React 18 kept / added to workspace / no importer | AC-4, AC-6 | Read `node_modules/react/package.json`; guard check |
| FR-4 | D-4 | commit in stamp / no git / N/A existing | AC-5 | Read the test build's manifest |
| FR-5 | D-6, D-7 | same ID printed / unset variable / founder deploys | AC-7, AC-8 | `--print-id`; founder-present observation |
| FR-6 | D-8 | config written / a command not passing / N/A fixed list | AC-9 | `sdd.py config` |

## Readiness

| Dimension | Pass? | Gap |
|---|---|---|
| Problem & goal | yes | |
| Behavior contract | yes | |
| Acceptance criteria | yes | |
| Context & constraints | yes | |
| Buildability | no | Whether the extension's tooling passes on Node 24 is unknown until tried; FR-1's edge scenario bounds the response |

**Score: 4/5** — four dimensions pass; no build-blocker. Q-11 has a safe default (D-6).

- Build-blockers: none of its own.
- Separate load gates: blocked by REQ-2. The founder-present part of AC-8 needs the founder. No TASKs yet.
- Artifact review: independent review round 1 of 3 (2026-11-13) returned needs-work with 5 findings and overflow; the writer applied fixes the same day; an independent recheck is pending. Report and dispositions: `verify/artifacts/plan-review.md`.
- Stale downstream contracts/evidence: none.

## Changelog

| Date | Change |
|---|---|
| 2026-11-13 | Initial specify; the same day, replaced the build and stamp design after reading how the live build folder and IDs work |
