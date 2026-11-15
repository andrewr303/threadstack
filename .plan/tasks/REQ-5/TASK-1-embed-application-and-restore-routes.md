---
id: TASK-1
req: REQ-5
title: Embed application and restore routes
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-5 / TASK-1 — Embed application and restore routes

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: vertical
- Enabling rationale: N/A
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-5-paperclip-view-in-the-extension-window.md`; original FRs, decisions and criteria below.
- Inputs: `.plan/project.md`, `context/CATALOG.md`, `context/platform.md`, `HANDOFF.md`.
- Config: `.plan/config.json` has subagent execution, disjoint ownership, required TDD and three review rounds. A config read/approval is not a successful load gate.
- Workflow/design: `.plan/workflow.md` and `verify/implementation-checkpoint.md`; snapshot approval replaces only the merger-first prerequisite.
- Reuse: existing owning modules; Still keeps its independent identity/consent.
- Do not: alter original checkout/live build, register a real service, push/publish or operate personal provider accounts based on this record.
- Env: key names in parent REQ only; test output `TK_OUT_DIR=/tmp/tk-build`; no stable-ID override.

## File scope and integration

| Owned file / surface | Change | Integration seam / consumer |
|---|---|---|
| `extension/src/core/paperclip/host.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/embed/rules.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/embed/workspace-tabs.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/workspace/types.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/schema.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/manager/App.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/manager/PaperclipView.tsx` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `ui/src/lib/threadkeeper-host.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `server/src/static-index-html.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `server/src/app.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-5.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given the server is `running`, When the founder chooses `Paperclip` in the view switch, Then Paperclip's interface fills the content area, its own sidebar is visible, and the shell's rail is in strip form.
- **AC-2** Given the Paperclip view was opened once and 6 session tabs are loaded, When the founder switches to Browse and back to Paperclip, Then no document request for the Paperclip origin is made and all 6 session frames are still loaded.
- **AC-3** Given the server is not `running`, When the founder chooses `Paperclip`, Then the REQ-4 status text and action are shown in place of the frame; and Given the server stops while the view is open, Then the panel replaces the frame within 5 s.
- **AC-4** Given the founder is on `/ACME/issues/ACME-12` in the Paperclip view, When they reload the window, Then the page address contains `view=paperclip` and `pc=%2FACME%2Fissues%2FACME-12` and Paperclip shows that page.
- **AC-5** Given the founder followed three links inside Paperclip, When they press the browser's Back twice, Then Paperclip shows the first of those pages and the shell is still on the Paperclip view.
- **AC-6** Given a 1280 px wide window with the Paperclip view open, When the layout is inspected, Then Paperclip's sidebar and header are fully visible, the frame has no horizontal scrollbar, and no style sheet or script in the frame's document comes from the extension other than the cookie accessor bridge.
- **AC-7** Given a link to `https://claude.ai/code/session_abc` in a task comment, When the founder clicks it, Then the shell switches to Browse with that address as a session tab; and Given a link to `https://example.com/doc`, Then it opens in an ordinary browser tab.
- **AC-8** Given the Paperclip view has been open and used, When the library and the session lists are inspected, Then no thread and no session entry was created from the Paperclip frame, and a workspace command sent from that frame was refused.
- **AC-9** Given a `route` message from an origin other than the configured Paperclip origin, or with `path` equal to `//evil.example` or longer than 2000 characters, When the shell handles it, Then the page address is unchanged; and Given a `navigate` message from an origin other than `chrome-extension://<the extension ID>`, When Paperclip handles it, Then no navigation happens.
- **AC-10** Given an `authenticated` server, When the founder signs in inside the frame and reloads the window, Then Paperclip is still signed in.
- **AC-11** Given the server was down and is `running` again, When the frame reloads, Then it shows the last path reported before the outage.
- **AC-12** Given the side panel surface, When its view list is read, Then `Paperclip` is not in it.
- **AC-13** Given an uploaded asset that Paperclip serves with `Content-Security-Policy: sandbox; default-src 'none'`, When it loads inside the Paperclip frame in the workspace tab, Then the response the frame receives still carries that header; and Given a provider page in a session tab, Then its `x-frame-options` and `content-security-policy` headers are still removed.

## Verify

Targeted candidate methods (not executed by writing this record):

npx vitest run tests/unit/paperclip-host.test.ts tests/unit/paperclip-view.test.tsx tests/unit/paperclip-integration-contract.test.ts tests/unit/embed-rules.test.ts (extension/); npx vitest run src/lib/threadkeeper-host.test.ts (ui/). Actual authenticated iframe/live updates/SW/navigation need browser proof.

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
| AC-12 | pending | |
| AC-13 | pending | |

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
