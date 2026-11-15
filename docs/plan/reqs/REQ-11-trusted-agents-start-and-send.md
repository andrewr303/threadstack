---
id: REQ-11
title: Trusted agents start sessions and send messages
epic: EPIC-3
spec: SPEC-14
status: blocked
readiness: 2
effort: high
readiness_gaps: ["blocked by REQ-8 and REQ-9", "how a message is typed and sent on each provider page is not settled", "whether Paperclip tool policies cover plugin tools is not yet read", "which account is live depends on the multi-profile work", "limits and scope await the founder (Q-5 Q-6 Q-7)"]
blocked_by: [REQ-8, REQ-9]
blocks: []
priority: P0
source: BRIEF-1
change:
stack: Paperclip plugin (act tools, trust settings, action log), extension content scripts (per-provider send adapters)
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-11 — Trusted agents start sessions and send messages

## Overview

An agent the founder has marked as trusted can do two things in the founder's browser without asking
each time: send a follow-up message into an existing session, and start a new session with a prompt
on a chosen provider and account. Both are limited in rate and scope, recorded in full, and stopped
by one switch. Agents that are not trusted are refused.

## Problem Statement

Reading sessions (REQ-8) lets an agent understand what happened, but the founder still has to type
every follow-up into every provider site. The founder chose "Trusted agents act alone: agents you
mark as trusted can start sessions and send messages without asking, within rate limits" (CTX-1,
G-3) so that an agent can carry work forward across providers.

## Solution

Two more tools in the `browser-sessions` plugin. Trust is set by the founder per agent and enforced
before a tool runs. The extension delivers a message by operating the provider page's own message
box in the session's embedded frame, and reports success only after the page shows the new message.
Three things must all be on before any action happens: the master switch, the provider's switch, and
the agent's trust mark. All three start off.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-3-agents-work-with-browser-sessions.md`; REQ-7 (bridge); REQ-8 (read tools, error texts); REQ-9 (links).
- Context: `context/platform.md` (Data model "Tool access"; Threadkeeper "Embedded pages", "Accounts", "Agent state"; Constraints); CTX-1 (G-3 and its note); CTX-2 (row 11); CTX-3 (browser bridges).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, sections "Behaviour with no automated test" and "Rules specific to this merge".
- Design: required before build (`/ultimate-sdd:design REQ-11`) for D-2 and D-5.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: Trusted agents start sessions and send messages without approval for each action, within rate limits | CTX-1 G-3 | agreed | FR-1, FR-2, FR-3 | Founder's choice over approval for each action |
| D-2: Trust is expressed with Paperclip's tool policies: the two tools are `deny` for every agent until the founder marks an agent trusted, which sets `allow` for that agent | Decisions `allow`, `deny`, `require_approval`, `rate_limited`, `defer_runtime` (`paperclip/packages/shared/src/constants.ts:1180`); `packages/db/src/schema/tool_access.ts` `[verified]` (existence) | unresolved | FR-3 / AC-5, AC-6 | Reuses Paperclip's own control. Not yet confirmed that these policies apply to plugin tools. Fallback: the plugin keeps its own per-agent list |
| D-3: v1 actions are send and start only | BRIEF-1 Out of Scope | agreed (brief, pending founder's read) | FR-1, FR-2 | Approving another agent's permission prompt, stopping a run, uploads and account pages carry more risk |
| D-4: Limits per agent: 10 sends and 3 starts per rolling hour; per session: 1 send per 60 s; text 1 to 20,000 characters | Q-6 | assumed (Q-6 open) | FR-4 / AC-7 | Low enough to notice misuse early. The founder sets the real numbers |
| D-5: How a message is delivered: the extension operates the provider page's own message box in the session's embedded frame | Today the extension only reads pages (`src/core/dom-capture.ts`); nothing types into one | unresolved | FR-1, FR-2, FR-6 / AC-1 to AC-4, AC-9 | Needs per-provider adapters and a proof on real pages. Alternative, calling a provider's private interface from the page, is closer to what provider terms forbid and is rejected |
| D-6: The action runs under the session's own account | The account model is being replaced by the multi-profile work | unresolved until REQ-1 | FR-1, FR-2 / AC-10 | Whether another account can be live at the same time decides what "not the live account" means |
| D-7: Automating consumer accounts may breach provider terms and can trigger bot checks; the founder chose to proceed | Anthropic's consumer terms forbid access "through automated or non-human means" (CTX-2 row 11); the risk was stated with the option the founder chose (CTX-1) | agreed (risk accepted) | FR-5 / AC-8 | Each provider stays off until the founder turns it on, so the choice is made per provider |
| D-8: A trusted agent may act only on sessions that the founder linked to the task it is working on (link origin `user`), that Threadkeeper linked to it (origin `auto`), or that this agent started with `session_start` for that task. Links made by any agent (origin `agent`) never grant acting scope | Q-5; independent review finding 1 (2026-11-13): agents can create links (REQ-9 FR-2), so counting agent-made links would let an agent widen its own scope | assumed (Q-5 open) | FR-3 / AC-6, AC-14 | Text read from a session is untrusted; a planted instruction must not be able to make an agent link a session and then act on it |
| D-9: First adapters: Claude chat, Claude Code, ChatGPT chat, Codex | Q-7; these are the realms with shared sign-ins already modelled (`src/core/workspace/realms.ts:54-69`) `[verified]` | assumed (Q-7 open) | FR-6 / AC-9 | Start where capture confidence is `high` (`src/core/providers.ts:159-176`) |
| D-10: Success means the page showed the new message within 15 s; every request carries a `clientRequestId` so a retry cannot send twice | Planner's design | assumed | FR-1, FR-7 / AC-1, AC-11 | A click is not proof of delivery |
| D-11: One master switch, off by default, stops every action at once | BRIEF-1 "one switch stops all agent actions" | agreed (brief, pending founder's read) | FR-5 / AC-8 | |
| D-12: The plugin stores every action with its full text; the activity log gets the first 200 characters | Planner's design | assumed | FR-8 / AC-12 | The founder must be able to read exactly what was sent |

## UI Layout

- Paperclip, plugin settings page, section `Agent actions`:
  - Master checkbox `Allow trusted agents to act in my browser` (off by default), with the note
    `Agents will send messages and start sessions as you. Providers may forbid automated use of personal accounts.`
  - Per provider: checkbox `{provider label}` (off by default). Providers with no adapter are greyed with `Not supported yet`.
  - Agent list: checkbox `Trusted` per agent; only a board user can change it.
  - Limits shown as text: `10 messages and 3 new sessions per agent per hour.`
  - `Recent actions`: last 50, each with time, agent, task, provider, account, session title, status, and the full text on expand.
- Extension, Settings → Paperclip: its own master checkbox `Allow trusted agents to act in my browser` and its own provider checkboxes. An action runs only when both sides allow it; turning the master switch off on either side turns it off on both. A read-only `Recent actions`.
- Threadkeeper thread detail: under the links area, one line per action on that thread: `{agent name} sent a message · {time}` or `{agent name} started this session · {time}`.
- Empty state for `Recent actions`: `No agent has acted yet.`

## Functional Requirements

### FR-1: `session_send`

The tool SHALL deliver a text message into an existing session and report success only after the
provider page shows it.

- Decision/source: D-1, D-5, D-6, D-10.
- Exact contract values: input `{ threadKey: string, text: string (1..20000 characters), clientRequestId: string (1..64 characters) }`; success `{ delivered: true, at }`. Errors, exact text:
  - `denied: This agent is not trusted for browser actions.`
  - `denied: The session is not linked to the task you are working on.`
  - `disabled: Agent actions are turned off.`
  - `disabled: {provider label} is not enabled for agent actions.`
  - `unsupported: {provider label} has no send support yet.`
  - `rate_limited: Try again in {n} seconds.`
  - `busy: The session is still running. Wait for it to finish.`
  - `signed_out: The session's account is signed out.`
  - `unknown_delivery: The message may or may not have been sent. Read the session before trying again.`
  - `not_found`, `browser_offline`, `timeout` as in REQ-8.

#### Scenario: positive
- GIVEN a trusted agent, the master and provider switches on, and a session linked to its task in state `Finished`
- WHEN it calls `session_send` with a 200-character text
- THEN the provider page shows that text as a new message from the user within 15 s and the tool returns `delivered: true`

#### Scenario: negative
- GIVEN the same call from an agent that is not trusted
- WHEN the call is made
- THEN it is refused with the first `denied` text and nothing is typed anywhere

#### Scenario: edge
- GIVEN the message was submitted but the page did not show it within 15 s
- WHEN the wait ends
- THEN the tool returns the `unknown_delivery` text, and a second call with the same `clientRequestId` returns the first call's outcome without typing again

### FR-2: `session_start`

The tool SHALL open a new session on a provider and account with a first prompt, and link the new
session to the agent's task.

- Decision/source: D-1, D-5, D-6, D-8.
- Exact contract values: input `{ provider: string, accountId?: string, prompt: string (1..20000 characters), clientRequestId: string }`; success `{ started: true, url, threadKey: string | null }` where `threadKey` is null until the session is captured. When the run has no task: `bad_request: A task is required to start a session.`

#### Scenario: positive
- GIVEN a trusted agent working on task T and ChatGPT enabled
- WHEN it calls `session_start` with `provider: "chatgpt"` and a prompt
- THEN a new ChatGPT session shows the prompt as its first message, and once captured it is linked to T with origin `agent`

#### Scenario: negative
- GIVEN `provider: "gemini"`, for which no adapter exists
- WHEN the tool runs
- THEN it returns `unsupported: Gemini has no send support yet.`

#### Scenario: edge
- GIVEN `accountId` names an account that is signed out
- WHEN the tool runs
- THEN it returns the `signed_out` text and opens nothing

### FR-3: Trust and scope

The two tools SHALL run only for an agent the founder marked trusted, and only on a session linked
to the task the agent's run is working on.

- Decision/source: D-2, D-8.

#### Scenario: positive
- GIVEN the founder ticks `Trusted` for agent A
- WHEN A calls `session_send` on a session linked to its task
- THEN the call proceeds

#### Scenario: negative
- GIVEN trusted agent A and a shared session that is not linked to A's task
- WHEN A calls `session_send` on it
- THEN it is refused with `denied: The session is not linked to the task you are working on.`

#### Scenario: negative — the agent linked the session itself
- GIVEN trusted agent A links shared session S to its own task with `session_link` (origin `agent`)
- WHEN A calls `session_send` on S
- THEN it is refused with `denied: The session is not linked to the task you are working on.`, because agent-made links never grant acting scope

#### Scenario: edge
- GIVEN an agent tries to change its own trust mark through any Paperclip interface
- WHEN the request is made with an agent credential
- THEN it is refused; only a board user can change trust

### FR-4: Limits

The plugin SHALL refuse a call that would exceed 10 sends or 3 starts per agent per rolling hour, or
1 send per session per 60 s.

- Decision/source: D-4.

#### Scenario: positive
- GIVEN an agent has sent 9 messages in the last hour
- WHEN it sends a tenth
- THEN it is delivered

#### Scenario: negative
- GIVEN an agent has sent 10 messages in the last hour
- WHEN it sends another
- THEN it gets `rate_limited: Try again in {n} seconds.` with `n` the time until the oldest of the 10 is an hour old

#### Scenario: edge
- GIVEN a send to session S 20 s ago by any agent
- WHEN another send to S is requested
- THEN it gets `rate_limited: Try again in 40 seconds.`

### FR-5: Switches

No action SHALL happen unless the master switch and the provider's switch are on in the plugin AND
the extension's own master switch and its own copy of the enabled providers allow it. Turning the
master switch off on either side SHALL stop every action within 10 s, including one waiting to be
delivered. When the two sides reconnect, "off" wins for the master switch and for each provider, and
any request created before a switch was turned off is dropped.

- Decision/source: D-7, D-11; independent review finding 5 (2026-11-13): the extension must not rely on the plugin's view alone.

#### Scenario: positive
- GIVEN both switches on
- WHEN a trusted agent acts
- THEN the action proceeds

#### Scenario: negative
- GIVEN the master switch is off (the default)
- WHEN a trusted agent calls either tool
- THEN it gets `disabled: Agent actions are turned off.`

#### Scenario: edge
- GIVEN an action is waiting for its session's page to load
- WHEN the founder turns the master switch off
- THEN the action is cancelled, nothing is typed, and the agent gets the `disabled` text

### FR-6: Delivery on the provider page

For each supported provider the extension SHALL load the session's page in an embedded frame if it
is not loaded, wait until its message box is ready, enter the text, submit, and confirm the new
message appears. It SHALL refuse while the session's agent state is `running`.

- Decision/source: D-5, D-9.
- Exact contract values: page load wait 30 s; confirmation wait 15 s; supported in v1: `claude`, `claude_code`, `chatgpt`, `codex`.

#### Scenario: positive
- GIVEN a Claude Code session that is not loaded
- WHEN a send is requested
- THEN the extension loads it, sends, confirms, and the session remains a normal tab the founder can open

#### Scenario: negative
- GIVEN the page shows a sign-in form, a bot check, or a permission dialog instead of a message box
- WHEN the adapter looks for the message box
- THEN it types nothing and returns `signed_out`, `unsupported: {provider label} is showing a check that needs you.`, or `busy` respectively

#### Scenario: edge
- GIVEN the provider changed its page so the adapter cannot find the message box
- WHEN a send is requested
- THEN it returns `unsupported: {provider label} has no send support yet.`, records the failure in Diagnostics, and types nothing

### FR-7: No double sends

A repeated call with the same `clientRequestId` from the same agent within 24 hours SHALL return the
first call's outcome and SHALL NOT send again.

- Decision/source: D-10.

#### Scenario: positive
- GIVEN a delivered send
- WHEN the agent repeats the call with the same `clientRequestId`
- THEN it gets `delivered: true` with the original time and the page shows one message

#### Scenario: negative
- GIVEN the same `clientRequestId` with a different text
- WHEN the call is made
- THEN it returns `bad_request: clientRequestId was already used with different content.`

#### Scenario: edge
- GIVEN the first call ended in `unknown_delivery`
- WHEN it is repeated
- THEN it returns `unknown_delivery` again and types nothing

### FR-8: Record of actions

Every call to either tool SHALL be stored by the plugin with agent, run, task, tool, thread key,
provider, account label, full text, status and times, and SHALL add an activity entry with the first
200 characters. The founder SHALL see the last 50 in settings and each thread's actions on the thread.

- Decision/source: D-12.

#### Scenario: positive
- GIVEN a delivered send
- WHEN the founder opens `Recent actions`
- THEN the top row shows the agent, task, session, `Delivered`, and the full text on expand

#### Scenario: negative
- GIVEN a refused call (not trusted)
- WHEN `Recent actions` is opened
- THEN the refusal is listed with status `Refused: not trusted` and its text

#### Scenario: edge
- GIVEN the extension is reinstalled
- WHEN the founder opens the plugin settings page
- THEN earlier actions are still listed, because the plugin stores them

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Stop time | 10 s or less from switching off to no further typing | Bridge connected | Manual run with an action waiting on a slow stand-in page |
| Delivery truthfulness | 0 results of `delivered: true` without the message visible in the page | All adapters | End-to-end tests with stand-in pages that drop the message |
| Limits | Exactly as D-4 | Simulated time | Plugin worker tests |
| Real-provider proof | One delivered send and one started session per supported provider, by the founder's own accounts with the founder present | Edge on macOS | Screenshots saved under `verify/` |

## Constraints from platform

- Auth / access / ownership: capability `agent.tools.register`; trust changes by board users only; company grant from REQ-7; links from REQ-9. Workspace-class commands in the extension are accepted only from `manager.html` as a top-level tab (`docs/architecture.md:45-47`), so the action is carried out by the extension itself on a bridge request, never by a page.
- API / types: `ToolRunContext`, `ToolResult` (`packages/plugins/sdk/src/types.ts:267-293`); `AgentState` (`extension/src/core/workspace/types.ts`); provider ids (`extension/src/core/providers.ts`).
- Cache: handled `clientRequestId` values are kept by the plugin for 24 hours.
- Files to extend, not reinvent: the plugin package; `extension/src/entrypoints/content.ts` and `extension/src/core/embed/**` for acting inside an embedded frame; `extension/src/core/dom-capture.ts` for the existing knowledge of each provider's page; `extension/src/core/capture-gate.ts` for the pattern of checking the sender; `planFrames` for loading a session.
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: the master switch off returns the product to read-only. Adapters are per provider and can be removed one at a time.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| Plugin settings `agentActionsEnabled`, `agentActionProviders`, limits | yes | Plugin settings page | All off by default |

## Out of scope

- Approving or denying a permission prompt, stopping a run, uploading files, changing models or settings on a provider — higher risk; revisit after v1.
- Acting on sign-in, billing or account pages — never.
- Providers other than the four in D-9.
- Acting when no browser is running.
- Hiding automation from providers — not attempted.

## Acceptance Criteria

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

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-1, D-5, D-6, D-10 | delivered / not trusted / unconfirmed | AC-1, AC-3, AC-5, AC-10 | Plugin tool tests with a fake bridge; end-to-end with stand-in pages |
| FR-2 | D-1, D-5, D-6, D-8 | started and linked / no adapter / signed out | AC-2, AC-4, AC-9 | Same |
| FR-3 | D-2, D-8 | trusted / unlinked or agent-linked session / self-grant | AC-5, AC-6, AC-14 | Plugin tests; one manual run with a real agent |
| FR-4 | D-4 | under / over hourly / per-session | AC-7 | Plugin worker tests over simulated time |
| FR-5 | D-7, D-11 | on / off by default / cancelled while waiting / sides disagree on reconnect | AC-8, AC-15 | Plugin and extension tests; manual run |
| FR-6 | D-5, D-9 | loads and sends / sign-in or check / page changed | AC-4, AC-9, AC-13 | Adapter unit tests on saved page fixtures; founder-present run |
| FR-7 | D-10 | repeat / different text / unknown repeat | AC-11 | Plugin worker tests |
| FR-8 | D-12 | listed / refusal listed / survives reinstall | AC-12 | Plugin tests; observation |

## Readiness

| Dimension | Pass? | Gap |
|---|---|---|
| Problem & goal | yes | |
| Behavior contract | yes | |
| Acceptance criteria | no | AC-10 cannot be made exact until the account model is known (D-6) |
| Context & constraints | no | Tool policy coverage of plugin tools is unread (D-2); acting inside an embedded frame has no existing code to cite |
| Buildability | no | The delivery mechanism is unproven on real provider pages (D-5) |

**Score: 2/5** — two dimensions pass; build-blockers would cap it at 3 in any case.

- Build-blockers: D-2 (read `server/src/services/tool-gateway.ts` and the tool policy services); D-5 (spike: on a stand-in page and then, with the founder present, on one real provider, enter and submit a message from a content script in an embedded frame, including a frame that is hidden); D-6 (after REQ-1); Q-5, Q-6, Q-7 keep their defaults unless the founder answers.
- Separate load gates: blocked by REQ-8 and REQ-9. Real-account checks need the founder present. The plugin manifest is shared with REQ-6 to REQ-13; do not build two of them at the same time. No TASKs yet.
- Artifact review: independent review round 1 of 3 (2026-11-13) returned needs-work with 5 findings and overflow; the writer applied fixes the same day; an independent recheck is pending. Report and dispositions: `verify/artifacts/plan-review.md`.
- Stale downstream contracts/evidence: none.

## Changelog

| Date | Change |
|---|---|
| 2026-11-13 | Initial specify |
