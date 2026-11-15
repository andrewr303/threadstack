---
id: REQ-14
title: Model credentials in one place
epic: EPIC-4
spec: SPEC-18
status: in-progress
readiness: 4
effort: med
readiness_gaps: ["implementation drafted against approved snapshot; final acceptance and ordered independent reviews pending"]
blocked_by: [REQ-7]
blocks: []
priority: P2
source: BRIEF-1
change:
stack: Paperclip company secrets and plugin secrets access, extension settings
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-14 — Model credentials in one place

## Overview

The founder enters each model API key once, in Paperclip, and the extension uses those keys for its
embeddings, reranking and analysis instead of keeping its own copies.

## Problem Statement

The extension stores keys for Anthropic, Voyage, MongoDB's model API, Cohere, OpenAI, AWS and its
worker in its settings (`context/platform.md`, Env keys) `[verified: scan]`, and those settings,
"including any API keys you entered", go into helper backups (`docs/mac-helper.md:64-66`)
`[verified]`. Paperclip keeps its own secrets per company. After the merge the founder would manage
the same keys in two places. This is the lowest-priority item in the brief and the founder has not
yet confirmed it is wanted (Q-9).

## Solution

Proposed, not settled: Paperclip's company secrets become the one home for model keys. In the
plugin's settings the founder links each extension key name to a Paperclip secret. The extension
asks for the values over the bridge when it needs them, keeps them only in memory, and stops storing
them in settings and backups. Every decision below marked unresolved must be settled before build.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-4-one-memory.md`; REQ-7 (bridge).
- Context: `context/platform.md` (Env keys; Data model "Settings"; Paperclip `company_secrets`, capability `secrets.read-ref`).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: required before build if Q-9 keeps this REQ.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: Keep this REQ at all | Q-9 | unresolved | all | The brief lists it last; no founder answer yet |
| D-2: Paperclip is the home; the extension reads from it | Paperclip already manages secrets per company with references (`company_secrets`, capability `secrets.read-ref`, `paperclip/packages/shared/src/constants.ts:1352-1456`) `[verified]` | assumed | FR-1, FR-2 | One management screen, kept out of extension backups |
| D-3: A plugin can resolve a secret reference to its value | `secrets.read-ref` exists; the client API (`ctx.secrets`, `packages/plugins/sdk/src/types.ts:2236`) has not been read | unresolved | FR-2 / AC-2 | If a plugin cannot read values, D-2 fails and the direction reverses or the REQ is cancelled |
| D-4: Secret values may be sent from the plugin to the extension over the bridge | Security decision; the bridge is local HTTP on loopback with the board key | unresolved | FR-2 / AC-2, AC-5 | Only the founder can accept this |
| D-5: Behaviour while Paperclip is down | Options: features that need a key pause; or the extension keeps an encrypted copy like its account jars (`docs/architecture.md:53-58`) `[verified]` | unresolved | FR-3 / AC-4 | Pausing is the safe default if no answer |
| D-6: Moving existing keys is a one-time action the founder starts; the extension's copies are deleted only after each linked key has been read back successfully | Planner's design | assumed | FR-4 / AC-3 | No key is lost in the move |
| D-7: Which company's secrets are used | The founder may have several companies; the plugin settings name one company as the key source | assumed | FR-1 / AC-1 | Keys are personal, not per company |

## UI Layout

- Paperclip plugin settings page, section `Model keys`: one row per extension key name with a
  secret picker `Use Paperclip secret…` and a status `Linked`, `Not linked` or `Secret missing`.
  A company picker `Read keys from {company}`.
- Extension Settings, the existing key fields: when linked, each shows `From Paperclip` and is
  read-only; a button `Move my keys to Paperclip` appears when any field holds a stored value.
- Notice when Paperclip is down and a linked key is needed: `Paperclip is not running, so {feature} is paused.`

## Functional Requirements

### FR-1: Link keys to secrets

The founder SHALL be able to link each extension key name to a secret of the chosen company.

- Decision/source: D-2, D-7.

#### Scenario: positive
- GIVEN a Paperclip secret holding the Voyage key
- WHEN the founder links `voyageApiKey` to it
- THEN the row shows `Linked` and the extension field shows `From Paperclip`

#### Scenario: negative
- GIVEN the linked secret is deleted in Paperclip
- WHEN the settings page is opened
- THEN the row shows `Secret missing` and the extension treats the key as absent

#### Scenario: edge
- GIVEN the founder changes the source company
- WHEN the change is saved
- THEN every link is cleared and must be made again

### FR-2: Use linked keys

When a feature needs a linked key, the extension SHALL get its value through the bridge and keep it
only in memory.

- Decision/source: D-3, D-4.

#### Scenario: positive
- GIVEN `voyageApiKey` is linked and the bridge connected
- WHEN a remote embedding runs
- THEN it uses the value from Paperclip and no key value is written to extension storage

#### Scenario: negative
- GIVEN a request for a key comes from a caller other than the paired extension
- WHEN the plugin handles it
- THEN it is refused with `denied` and nothing is returned

#### Scenario: edge
- GIVEN the key's secret is rotated in Paperclip
- WHEN the next feature call needs it
- THEN the new value is used within 60 s

### FR-3: Paperclip down

While Paperclip is not reachable, features that need a linked key SHALL follow D-5.

- Decision/source: D-5.

#### Scenario: positive
- GIVEN D-5 is "pause" and Paperclip is stopped
- WHEN a remote embedding would run
- THEN it does not run and the notice names the feature

#### Scenario: negative
- GIVEN Paperclip is stopped
- WHEN local search runs
- THEN it works as before, because it needs no key

#### Scenario: edge
- GIVEN Paperclip comes back
- WHEN the next feature call runs
- THEN it proceeds without the founder doing anything

### FR-4: Move existing keys

`Move my keys to Paperclip` SHALL create or update one Paperclip secret per stored key, link it, read
it back, and only then delete the extension's stored value.

- Decision/source: D-6.

#### Scenario: positive
- GIVEN three keys stored in the extension
- WHEN the founder moves them
- THEN three secrets exist, three rows show `Linked`, and the extension stores none of the three values

#### Scenario: negative
- GIVEN reading one key back fails
- WHEN the move finishes
- THEN that key stays stored in the extension and is reported as `Not moved`

#### Scenario: edge
- GIVEN a backup is made after the move
- WHEN its settings are inspected
- THEN no moved key value is in it

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Key exposure | 0 key values in extension storage or backups after a move | Keys moved | Inspect IndexedDB settings and a fresh backup file |
| Audit | Every key read by the extension logged in Paperclip's activity without the value | Any read | Activity log read |

## Constraints from platform

- Auth / access / ownership: board user only for linking; the bridge's pairing for reads; capability `secrets.read-ref`.
- API / types: extension settings fields (`extension/src/core/schema.ts`); Paperclip `company_secrets`; `ctx.secrets` (unread).
- Cache: values in memory only, unless D-5 chooses an encrypted copy.
- Files to extend, not reinvent: `extension/src/entrypoints/manager/SettingsDialog.tsx` and the key fields; the plugin settings page from REQ-7; the existing encryption for account jars if D-5 needs it (`extension/src/core/accounts/crypto.ts`).
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: unlinking a key returns the field to normal entry; moved keys are not restored automatically.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| Extension settings key fields listed in `context/platform.md` | — | `extension/src/core/schema.ts` | Names only |

## Out of scope

- Keys used by Paperclip's agent adapters (their CLIs keep their own sign-ins).
- Provider website sign-ins and cookies.
- Syncing keys to another computer.

## Acceptance Criteria

- **AC-1** Given a Paperclip secret holding the Voyage key in the chosen company, When the founder links `voyageApiKey` to it, Then the plugin row shows `Linked` and the extension field shows `From Paperclip` and is read-only.
- **AC-2** Given `voyageApiKey` is linked and the bridge connected, When a remote embedding runs, Then the call succeeds with the linked value and no key value is present in the extension's IndexedDB settings afterwards; and Given a key request from anything other than the paired extension, Then the plugin answers `denied`.
- **AC-3** Given three keys stored in the extension, When the founder presses `Move my keys to Paperclip`, Then three secrets exist, three rows show `Linked`, and the extension stores none of the three values; and Given one key cannot be read back, Then that key is still stored and reported `Not moved`.
- **AC-4** Given Paperclip is stopped and D-5 is "pause", When a feature needs a linked key, Then the feature does not run and the notice `Paperclip is not running, so {feature} is paused.` is shown, while local search still works.
- **AC-5** Given any key read by the extension, When Paperclip's activity log is read, Then it has one entry naming the key and the extension, with no key value.
- **AC-6** Given the linked secret is deleted in Paperclip, When the settings are opened, Then the row shows `Secret missing` and the extension treats the key as absent.

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-2, D-7 | linked / secret deleted / company changed | AC-1, AC-6 | Plugin UI test; extension settings test |
| FR-2 | D-3, D-4 | used / foreign caller / rotated | AC-2, AC-5 | Plugin worker test; extension test with a fake bridge |
| FR-3 | D-5 | paused / local search works / recovers | AC-4 | Extension test |
| FR-4 | D-6 | moved / read-back fails / backup clean | AC-3 | Extension test; backup file inspection |

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
| 2026-11-13 | Keep this lowest-priority feature under the documented plan default, with explicit transfer consent off, memory-only paired reads and pause while unavailable. Migration reads back before local deletion. No real key transmission, deletion, migration or separate founder security answer is claimed. |
