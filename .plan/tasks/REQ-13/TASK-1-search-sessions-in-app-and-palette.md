---
id: TASK-1
req: REQ-13
title: Search sessions in app and palette
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-13 / TASK-1 — Search sessions in app and palette

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: vertical
- Enabling rationale: N/A
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-13-search-sessions-from-paperclip.md`; original FRs, decisions and criteria below.
- Inputs: `.plan/project.md`, `context/CATALOG.md`, `context/platform.md`, `HANDOFF.md`.
- Config: `.plan/config.json` has subagent execution, disjoint ownership, required TDD and three review rounds. A config read/approval is not a successful load gate.
- Workflow/design: `.plan/workflow.md` and `verify/implementation-checkpoint.md`; snapshot approval replaces only the merger-first prerequisite.
- Reuse: existing owning modules; Still keeps its independent identity/consent.
- Do not: alter original checkout/live build, register a real service, push/publish or operate personal provider accounts based on this record.
- Env: key names in parent REQ only; test output `TK_OUT_DIR=/tmp/tk-build`; no stable-ID override.

## File scope and integration

| Owned file / surface | Change | Integration seam / consumer |
|---|---|---|
| `ui/src/api/browser-sessions.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `ui/src/api/browser-sessions.test.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `ui/src/pages/Search.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `ui/src/components/CommandPalette.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `packages/plugins/plugin-browser-sessions/src/service.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-13.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given a shared session whose transcript is about Stripe webhook retries and a connected bridge, When the founder types `webhook retries` on Paperclip's search page and pauses, Then within 1.5 s the `Sessions` section lists that session with its provider label, account label, state label and an excerpt.
- **AC-2** Given the founder submits the search, When the results update, Then the request used quality `best`; and Given no remote embedding or reranking is configured, Then the section shows `Local results only`.
- **AC-3** Given a library thread with provider `paperclip` matches the query, When results show, Then it is not under `Sessions`; and Given a one-character query, Then no session request is sent.
- **AC-4** Given Paperclip is open in the extension window, When the founder chooses a session result, Then Browse shows that session as a tab; and Given Paperclip is open in an ordinary tab, Then the extension window comes forward showing it.
- **AC-5** Given the command palette is open and the bridge connected, When the founder types `migration order`, Then a `Sessions` group lists up to 5 matching sessions; and Given the browser is not connected, Then the group is omitted.
- **AC-6** Given the session search takes 20 s, When the founder searches, Then Paperclip's own results appear in the same time as with the plugin disabled, and the section shows `Searching sessions…`.
- **AC-7** Given the bridge answers `browser_offline`, no grant exists, or the request times out, When the founder searches, Then the section shows respectively `Sessions can be searched while Threadkeeper is running.`, `Sessions are not shared with this company.` with `Share sessions`, or `Session search did not answer. Try again.`
- **AC-8** Given a result whose session became private after the search, When the founder chooses it, Then `This session is no longer available.` appears and nothing opens.

## Verify

Targeted candidate methods (not executed by writing this record):

npx vitest run src/api/browser-sessions.test.ts src/pages/Search.test.tsx src/components/CommandPalette.test.tsx (ui/); node ../../../node_modules/vitest/vitest.mjs run (packages/plugins/plugin-browser-sessions/). Browser results/open/debounce/stale-company/offline observations remain required.

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

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
