---
id: TASK-1
req: REQ-6
title: Expose navigation with safe switching
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-6 / TASK-1 — Expose navigation with safe switching

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: vertical
- Enabling rationale: N/A
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-6-threadkeeper-entries-in-paperclips-sidebar.md`; original FRs, decisions and criteria below.
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
| `ui/src/lib/threadkeeper-host.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `ui/src/App.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/host.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/manager/App.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-6.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given the plugin is enabled, When Paperclip is open in the extension window, Then its sidebar "Work" section lists `Browse`, `Threads` and `Session board`, leading to `/<company>/browse`, `/<company>/threads` and `/<company>/session-board`.
- **AC-2** Given Paperclip is opened in an ordinary browser tab, When the founder chooses `Threads`, Then the page shows the heading `Open this in Threadkeeper`, the text `Browse, Threads and the session board run inside the Threadkeeper window.` and the button `Open Threadkeeper`.
- **AC-3** Given three session tabs are open in Browse, When the founder opens a Paperclip page and returns to `Browse` through Paperclip's sidebar, Then Paperclip's sidebar stayed visible throughout, the same three tabs are shown, and no embedded page made a new document request.
- **AC-4** Given the Threads view is showing in fused mode, When the founder opens Paperclip's command palette, Then it is fully visible over the view and accepts typing, and after Escape a click on a thread row selects that row.
- **AC-5** Given the Threads view is showing, When a Paperclip notice appears over it, Then the notice and its action button are visible and clickable.
- **AC-6** Given focus is in the Threads list, When the founder presses Command+K, Then Paperclip's command palette opens; and Given focus is in a text field of an embedded provider page, Then it does not.
- **AC-7** Given fused mode, When the window is inspected, Then exactly one element offers Browse, Threads and Session board (Paperclip's sidebar), and the session list, account controls and Settings entry are inside the Threadkeeper view.
- **AC-8** Given the server stops while Threads is showing in fused mode, When the shell's next health check runs, Then the Threads view is still on screen with the shell's own rail and view switch; and Given the server returns, Then fused mode resumes on Threads.
- **AC-9** Given the window or Paperclip's sidebar is resized, When the size change ends, Then each edge of the Threadkeeper view is within 1 CSS pixel of the content rectangle Paperclip reported.
- **AC-10** Given the spike in this REQ fails any of its five checks, When the result is recorded, Then no product code for FR-2 to FR-5 exists and `HANDOFF.md` carries the result and question Q-3 for the founder.
- **AC-11** Given a `slot` message with a rectangle outside the window or with a negative size, When the shell handles it, Then the placement is unchanged.

## Verify

Targeted candidate methods (not executed by writing this record):

npx vitest run tests/unit/paperclip-host.test.ts tests/unit/paperclip-view.test.tsx (extension/); npx vitest run src/lib/threadkeeper-host.test.ts (ui/). Five-check fused Edge/Chrome spike NOT RUN; documented switching fallback prepared, fused AC remain pending.

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

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
