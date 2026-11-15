---
id: TASK-1
req: REQ-14
title: Resolve opt-in model credentials
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-14 / TASK-1 — Resolve opt-in model credentials

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: vertical
- Enabling rationale: N/A
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-14-model-credentials-in-one-place.md`; original FRs, decisions and criteria below.
- Inputs: `.plan/project.md`, `context/CATALOG.md`, `context/platform.md`, `HANDOFF.md`.
- Config: `.plan/config.json` has subagent execution, disjoint ownership, required TDD and three review rounds. A config read/approval is not a successful load gate.
- Workflow/design: `.plan/workflow.md` and `verify/implementation-checkpoint.md`; snapshot approval replaces only the merger-first prerequisite.
- Reuse: existing owning modules; Still keeps its independent identity/consent.
- Do not: alter original checkout/live build, register a real service, push/publish or operate personal provider accounts based on this record.
- Env: key names in parent REQ only; test output `TK_OUT_DIR=/tmp/tk-build`; no stable-ID override.

## File scope and integration

| Owned file / surface | Change | Integration seam / consumer |
|---|---|---|
| `extension/src/core/paperclip/credentials.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/schema.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/embeddings.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/rerank.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/ai.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/ask.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/manager/SettingsDialog.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/background.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `packages/plugins/plugin-browser-sessions/src/service.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-14.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given a Paperclip secret holding the Voyage key in the chosen company, When the founder links `voyageApiKey` to it, Then the plugin row shows `Linked` and the extension field shows `From Paperclip` and is read-only.
- **AC-2** Given `voyageApiKey` is linked and the bridge connected, When a remote embedding runs, Then the call succeeds with the linked value and no key value is present in the extension's IndexedDB settings afterwards; and Given a key request from anything other than the paired extension, Then the plugin answers `denied`.
- **AC-3** Given three keys stored in the extension, When the founder presses `Move my keys to Paperclip`, Then three secrets exist, three rows show `Linked`, and the extension stores none of the three values; and Given one key cannot be read back, Then that key is still stored and reported `Not moved`.
- **AC-4** Given Paperclip is stopped and D-5 is "pause", When a feature needs a linked key, Then the feature does not run and the notice `Paperclip is not running, so {feature} is paused.` is shown, while local search still works.
- **AC-5** Given any key read by the extension, When Paperclip's activity log is read, Then it has one entry naming the key and the extension, with no key value.
- **AC-6** Given the linked secret is deleted in Paperclip, When the settings are opened, Then the row shows `Secret missing` and the extension treats the key as absent.

## Verify

Targeted candidate methods (not executed by writing this record):

npx vitest run tests/unit/paperclip-credentials.test.ts (extension/); node ../../../node_modules/vitest/vitest.mjs run (packages/plugins/plugin-browser-sessions/). Fixture readback/rotation/offline/partial migration and backup inspection; real values stay untouched, transfer off by default.

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

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
