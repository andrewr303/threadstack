---
id: TASK-1
req: REQ-11
title: Execute trusted exact-account actions
status: planned
blocked_by: []
blocks: []
ac: [AC-1, AC-2, AC-3, AC-4, AC-5, AC-6, AC-7, AC-8, AC-9, AC-10, AC-11, AC-12, AC-13, AC-14, AC-15]
created: 2026-11-13
updated: 2026-11-13
---

# REQ-11 / TASK-1 — Execute trusted exact-account actions

## Goal

Deliver the parent REQ outcome with actual owned-AC evidence, ordered independent reviews and a current complete gate. Source files or this record alone do not establish completion.

## Slice

- Kind: vertical
- Enabling rationale: N/A
- Consumer: parent REQ graph; its blockers remain authoritative.

## Context

- Parent: `reqs/REQ-11-trusted-agents-start-and-send.md`; original FRs, decisions and criteria below.
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
| `extension/src/core/paperclip/actions.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/bridge.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/core/paperclip/bridge-protocol.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/content.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/manager/paperclip-actions.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |
| `extension/src/entrypoints/background.ts` | Parent REQ behavior/contract | Existing owner and parent FRs |

- Sequencing: retain parent dependency graph; implementation drafts across agreed interfaces do not make prerequisite outcomes complete.
- Parallelism: disjoint owners in the checkpoint; one owner serializes the shared plugin package. Parent integrates common schema/background contracts.

## Steps

1. Re-read parent contract/current files and actual prerequisite evidence. Run and retain a real load-gate result before claiming this TASK loaded; do not fabricate retroactive eligibility.
2. Plan and exercise the stated checks. TDD: Required for changed behavior: capture the real red failure, green result and any refactor regression. A baseline pass is not red/green evidence.
3. Implement only owned behavior and synchronize company, policy, privacy, task/account, audit and consent contracts with their owners.
4. Update `.plan/verify/REQ-11.md` and relevant behavior docs with actual observations, producing tools/source identity, failures and material gaps; no credential values or personal transcripts.
5. Obtain fresh independent spec review, then a different independent quality review for the same final scope. Record real reports with the runtime and pass the complete gate before done.

## Acceptance criteria owned

Copied verbatim from the parent. REQ-1's approved snapshot alternative does not establish that its original merger-only preconditions happened; preserve that distinction.

- **AC-1** Given a trusted agent, the master switch and the provider's switch on, and a session linked to the agent's task in state `turn_complete`, When the agent calls `session_send` with a 200-character text, Then the provider page shows that text as a new message from the user within 15 s and the tool returns `delivered: true`.
- **AC-2** Given a trusted agent working on task T with ChatGPT enabled, When it calls `session_start` with `provider: "chatgpt"` and a prompt, Then a new ChatGPT session shows the prompt as its first message, and after capture the session is linked to T with origin `agent`.
- **AC-3** Given the page did not show the submitted message within 15 s, When the wait ends, Then the tool returns `unknown_delivery: The message may or may not have been sent. Read the session before trying again.`
- **AC-4** Given the session's page shows a sign-in form, When a send is requested, Then nothing is typed and the tool returns `signed_out: The session's account is signed out.`; and Given the session's agent state is `running`, Then it returns `busy: The session is still running. Wait for it to finish.`
- **AC-5** Given an agent that is not marked trusted, When it calls `session_send` or `session_start`, Then it gets `denied: This agent is not trusted for browser actions.` and nothing is typed or opened.
- **AC-6** Given a trusted agent and a shared session not linked to its task, When it calls `session_send` on that session, Then it gets `denied: The session is not linked to the task you are working on.`; and Given a request made with an agent credential to change a trust mark, Then it is refused.
- **AC-7** Given an agent that has sent 10 messages in the last hour, When it sends another, Then it gets `rate_limited: Try again in {n} seconds.`; and Given a send to a session 20 s ago, When another send to it is requested, Then it gets `rate_limited: Try again in 40 seconds.`; and Given an agent that has started 3 sessions in the last hour, When it starts a fourth, Then it gets the `rate_limited` text.
- **AC-8** Given a fresh install, When a trusted agent calls either tool, Then it gets `disabled: Agent actions are turned off.`; and Given the master switch on and the provider's switch off, Then it gets `disabled: {provider label} is not enabled for agent actions.`; and Given an action waiting for a page to load, When the founder turns the master switch off, Then nothing is typed and the agent gets the first `disabled` text within 10 s.
- **AC-9** Given a provider with no adapter, or a supported provider whose message box cannot be found, When a send is requested, Then nothing is typed, the tool returns `unsupported: {provider label} has no send support yet.`, and Diagnostics records the failure.
- **AC-10** Given a session that belongs to an account other than the one currently live for its provider, When a send is requested, Then the outcome follows the rule recorded in D-6 after REQ-1, and in no case is the message sent under a different account than the session's own.
- **AC-11** Given a delivered send, When the agent repeats the call with the same `clientRequestId`, Then it gets `delivered: true` with the original time and the page shows the message once; and Given the same `clientRequestId` with a different text, Then it gets `bad_request: clientRequestId was already used with different content.`
- **AC-12** Given any call to either tool, delivered or refused, When the founder opens `Recent actions`, Then the call is listed with time, agent, task, provider, account, session title, status and its full text, Paperclip's activity log has one entry with the first 200 characters, and the thread's detail in Threadkeeper lists the action.
- **AC-13** Given the four providers in D-9, When the founder, present and using their own accounts in Edge, runs one `session_send` and one `session_start` per provider, Then each is delivered and a screenshot of each is saved under `verify/`.
- **AC-14** Given trusted agent A links shared session S to its own task with `session_link`, When A calls `session_send` on S, Then it gets `denied: The session is not linked to the task you are working on.`; and Given a different agent links S to A's task, Then A's `session_send` on S is refused the same way.
- **AC-15** Given the founder turns the extension's master switch off while the bridge is down and the plugin still shows it on, When the bridge reconnects and a `session_send` created before the switch-off arrives, Then nothing is typed, the request is refused with `disabled: Agent actions are turned off.`, and both settings screens show the switch off.

## Verify

Targeted candidate methods (not executed by writing this record):

npx vitest run tests/unit/paperclip-actions.test.ts tests/unit/paperclip-bridge.test.ts (extension/); node ../../../node_modules/vitest/vitest.mjs run (packages/plugins/plugin-browser-sessions/). Stand-in delivery/cancel/idempotency tests do not prove AC-13 real founder-present Edge provider starts/sends; that remains pending.

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
| AC-14 | pending | |
| AC-15 | pending | |

## Send-back

**Blocker:** cumulative checks, required runtime proof, ordered independent reviews and complete-gate evidence remain pending. Preserve parent readiness/dependency gaps until actually resolved.
