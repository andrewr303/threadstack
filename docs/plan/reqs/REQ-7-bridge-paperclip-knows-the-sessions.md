---
id: REQ-7
title: Bridge between the extension and Paperclip with a session inventory
epic: EPIC-3
spec: SPEC-10
status: blocked
readiness: 3
effort: high
readiness_gaps: ["blocked by REQ-4", "transport for server to extension requests not settled", "plugin database client not yet read", "account fields depend on the multi-profile work"]
blocked_by: [REQ-4]
blocks: [REQ-6, REQ-8, REQ-9, REQ-12, REQ-14]
priority: P0
source: BRIEF-1
change:
stack: Paperclip plugin (worker, routes, database namespace, settings page), extension service worker and manager page
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-7 — Bridge between the extension and Paperclip with a session inventory

## Overview

A first-party Paperclip plugin and the extension keep an authenticated connection, the bridge.
Through it Paperclip holds a current list of the founder's sessions (title, provider, account,
state, last activity; no message text) for the companies the founder shares them with, and Paperclip
can send requests to the extension and get answers. REQ-8 to REQ-14 are built on it.

## Problem Statement

Paperclip's agents cannot see any browser session. The extension only reads from Paperclip, every 5
minutes, and Paperclip knows nothing about the extension (`src/core/paperclip/sync.ts`,
`client.ts:9-10`). The founder's "big goal" is to "connect paperclip to browser sessions, mainly
through the chrome extension" (CTX-1), with the library staying in the extension (G-2). That needs a
channel in both directions and a list of sessions on the Paperclip side.

## Solution

Add a plugin, `browser-sessions`, to the fork. The extension pairs with it, the founder chooses which
companies may see sessions, and the extension then sends changed session rows and answers requests.
The message shapes, validators, size limits, secret redaction and privacy filter are the ones the
extension already has for the Still integration (`src/core/dock/{protocol,query,payload}.ts`), under
a new protocol id so Still is untouched.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-3-agents-work-with-browser-sessions.md`; REQ-4 (connection, credentials).
- Context: `context/platform.md` (APIs "Plugin API routes", "Plugin events", "Plugin worker to UI stream", "Still (Sidebar Dock)"; "Do not reinvent"); CTX-1 (G-2); CTX-3 (bridge designs).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: required before build (`/ultimate-sdd:design REQ-7`) for D-3.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: The library stays in the extension; Paperclip gets a list of sessions and on-demand access | CTX-1 G-2 | agreed | all | Founder's choice |
| D-2: The Paperclip side is a first-party plugin, folder `packages/plugins/plugin-browser-sessions`, id `browser-sessions` | Plugin SDK offers tools, routes, events, storage (`context/platform.md`) | assumed | all | Uses what Paperclip already provides. Boundary: a core change is allowed (G-4) where the SDK cannot do the job |
| D-3: How Paperclip delivers a request to the extension | Verified limits: plugin routes are request and response; `transport: "websocket"` proxies to an upstream socket and does not end in the worker (`server/src/realtime/plugin-api-ws.ts:14-40`); worker-to-UI streams exist (`packages/plugins/sdk/src/types.ts:2055-2075`) | unresolved | FR-4 / AC-5, AC-6, AC-7 | Candidates: (A) the extension long-polls a plugin route and posts results; (B) a WebSocket endpoint added to Paperclip's server core; (C) relay through the plugin UI in the Paperclip frame. Default to assess first: A. It needs a check of how long an MV3 service worker may hold a pending request |
| D-4: Messages reuse the Still protocol's shapes, validators, limits and privacy filter, under protocol id `paperclip-threadkeeper/1` | `src/core/dock/protocol.ts:8-77`, `query.ts`, `payload.ts` `[verified]` | assumed | FR-3, FR-4, FR-6 / AC-3, AC-8 | One external read API instead of two |
| D-5: The founder grants session visibility per company; nothing is shared until a company is chosen | Everything in Paperclip is company-scoped (`paperclip/AGENTS.md` section 5.1) `[verified: scan]`; sessions belong to the person | assumed | FR-1, FR-5 / AC-1, AC-9 | Safe default: no company sees sessions until chosen |
| D-6: A session that fails the extension's existing sharing rule is never listed, counted or returned | `isRemoteAllowed` (`src/core/privacy.ts:10`), `isShareable` (`src/core/dock/payload.ts:389`) `[verified]` | agreed (BRIEF-1) | FR-6 / AC-8 | Agents send what they read to model providers |
| D-7: A session row is the Still protocol's `ThreadSummary` plus `accountLabel`, `sessionGroup`, `agentState`, `agentStateAt`, `repository`, `pullRequestUrl`, `pinned` | `ThreadSummary` (`src/core/dock/protocol.ts:91-117`) `[verified]`; the extra fields exist on the conversation record (`src/core/schema.ts:98-185`) `[verified: scan]` | assumed | FR-3 / AC-3 | `ThreadSummary` has no account or agent state. Boundary: account fields are re-read after REQ-1 |
| D-8: Changes reach Paperclip within 10 s while connected; the first sync and every reconnect send only rows whose fingerprint changed | `fingerprintOf`, `cheapDigestOf` (`src/core/dock/payload.ts:257`, `:278`) `[verified]` | assumed | FR-3 / AC-3, AC-4 | The numbers are the planner's |
| D-9: Paperclip's normal authentication still applies to the bridge (none on `local_trusted`, the board key otherwise, `src/core/paperclip/auth.ts` `[verified: scan]`); the bridge token of D-12 is required on top of it | `src/core/paperclip/auth.ts` `[verified: scan]` | assumed | FR-1, FR-8 / AC-1, AC-14 | No second sign-in for the founder |
| D-12: Bridge identity. Pairing shows an 8-character code in the extension that a board user confirms on the plugin's settings page within 10 minutes; the plugin then issues a random 32-byte bridge token that the extension stores. Every bridge route declares `auth: "board"` and also requires the header `X-Threadkeeper-Bridge-Token`. Agent credentials are refused | On `local_trusted` every local non-agent caller is treated as the board and the board mutation guard skips its origin check for that actor (`paperclip/server/src/middleware/auth.ts`, `board-mutation-guard.ts:87-97`) `[verified: review]`; Paperclip classifies local peers as operator or agent run (`server/src/middleware/local-agent-process-boundary.ts`) `[verified]`; route auth modes `board`, `agent`, `board-or-agent`, `webhook` (`packages/shared/src/constants.ts:1494`) `[verified]`; Still's pairing uses a one-time code with a 10-minute expiry (`src/core/dock/protocol.ts:18`) `[verified]` | assumed | FR-8 / AC-14, AC-15 | Without it any local process could pose as the extension, feed agents false sessions, receive action requests (REQ-11) or key values (REQ-14). Boundary: the token protects against other local processes, not against code running as the founder that can read the extension's storage |
| D-13: REQ-7 creates the plugin package, installs it in the founder's instance and keeps it enabled across restarts; later REQs only add to it | Paperclip installs plugins through its CLI (`paperclip/doc/plugins/PLUGIN_SPEC.md` section 8.2) `[verified: scan]`; a bundled-plugin mechanism exists for managed-cloud instances (`server/src/services/bundled-plugins.ts`) `[verified]` | assumed | FR-9 / AC-16 | One owner for the scaffold. Installing needs the founder's go-ahead; the mechanism is chosen in design |
| D-10: One bridge per company at a time; a second browser pairing for the same company is refused until the first is revoked | Planner's choice | assumed | FR-1 / AC-10 | Avoids two libraries answering for one company |
| D-11: The handshake carries the fork commit each side was built from: the extension's is the commit part of its `buildId`, the plugin's is recorded when the plugin is built | `scripts/build-extension.mjs:26-37` `[verified]`; REQ-3 FR-4 | assumed | FR-2 / AC-2 | A mismatch is shown as a warning, not an error |

## UI Layout

- Paperclip, plugin settings page "Browser sessions":
  - Status line: `Connected to Threadkeeper in {browser}` / `Not connected` / `Last seen {relative time}` / `Version mismatch`.
  - Companies list with a checkbox each: `Share sessions with {company}`.
  - Counts: `{n} sessions shared`.
  - Button `Disconnect`.
  - Warning when commits differ: `Threadkeeper and Paperclip were built from different commits ({a} and {b}).`
- Extension, Settings → Paperclip: the same status and company list, a `Pair` button when not paired (it shows an 8-character code to confirm within 10 minutes in the field `Confirm pairing code` on the plugin settings page), and `Disconnect`.
- Empty state on both sides: `No company can see your sessions yet. Choose one to share with.`

## Functional Requirements

### FR-1: Pair, grant and revoke

The extension SHALL pair with the plugin using its existing Paperclip credentials, and the founder
SHALL choose which companies may see sessions. Until a company is chosen, the plugin SHALL hold no
session row. Disconnecting SHALL delete every row for the affected companies.

- Decision/source: D-5, D-9, D-10.

#### Scenario: positive
- GIVEN a connected extension and one company ticked
- WHEN pairing completes
- THEN the plugin shows `Connected` and holds rows for that company only

#### Scenario: negative
- GIVEN a request to the bridge from a client that has not paired
- WHEN the plugin handles it
- THEN it answers with error code `not_paired` and stores nothing

#### Scenario: edge
- GIVEN the founder unticks a company
- WHEN the change is saved
- THEN every session row for that company is deleted within 10 s

### FR-2: Handshake and versions

Each connection SHALL start with a handshake that exchanges protocol id, extension version, plugin
version, the build commit of each side and capability names.

- Decision/source: D-4, D-11.
- Exact contract values: protocol id `paperclip-threadkeeper/1`; a different protocol id gives error code `version_mismatch`.

#### Scenario: positive
- GIVEN both sides speak `paperclip-threadkeeper/1`
- WHEN they connect
- THEN the status is `Connected`

#### Scenario: negative
- GIVEN the extension speaks a different protocol id
- WHEN it connects
- THEN the plugin answers `version_mismatch`, both settings screens show `Version mismatch`, and no rows are exchanged

#### Scenario: edge
- GIVEN the protocol ids match and the two build commits differ
- WHEN they connect
- THEN the connection works and both settings screens show the different-commits warning

### FR-3: Session inventory

The extension SHALL send a row for every shareable session to each granted company: all rows whose
fingerprint differs on connect, and each later change within 10 s. The plugin SHALL store the rows
in its own database namespace keyed by company and thread key.

- Decision/source: D-7, D-8.
- Exact contract values: row fields as in D-7; each message at most 4 MB (`MAX_MESSAGE_BYTES`, `src/core/dock/protocol.ts:9`); removals sent as a list of thread keys; threads whose provider is `paperclip` are never sent (they are Paperclip's own tasks, copied into the library by the existing sync).

#### Scenario: positive
- GIVEN a library of 2,000 shareable sessions and a new grant
- WHEN the first sync runs
- THEN the plugin holds 2,000 rows within 60 s and no message exceeded 4 MB

#### Scenario: negative
- GIVEN a row that fails validation on the plugin side
- WHEN it arrives
- THEN that row is rejected with `bad_request`, the others in the message are stored, and the extension logs the thread key in Diagnostics

#### Scenario: edge
- GIVEN the Paperclip server restarts
- WHEN the extension reconnects
- THEN only rows whose fingerprint changed are sent and no duplicate row exists

### FR-4: Requests from Paperclip to the extension

The plugin SHALL be able to send a typed request to the paired extension and receive one answer,
with a deadline. With no answer by the deadline the caller SHALL get error code `timeout`; with no
extension seen for 40 s the caller SHALL get `browser_offline` at once.

- Decision/source: D-3, D-4.
- Exact contract values: request types are the Still protocol's `threads.list`, `threads.search`, `threads.get`, `threads.context`, `threads.related`, `facets`, `thread.open` (`src/core/dock/protocol.ts:39-55`); default deadline 30 s; error codes from `DockErrorCode` (`:20-33`) plus `browser_offline` and `timeout`.

#### Scenario: positive
- GIVEN a connected extension with the extension window open
- WHEN the plugin sends `threads.list` with limit 20
- THEN it receives up to 20 rows within 2 s

#### Scenario: negative
- GIVEN no extension has been seen for 40 s
- WHEN the plugin sends any request
- THEN the caller gets `browser_offline` without waiting for the deadline

#### Scenario: edge
- GIVEN the browser is running with no extension window open
- WHEN the plugin sends a request
- THEN it is answered within 60 s or the caller gets `timeout`

### FR-5: Company boundary

Every stored row and every request SHALL carry a company, and the plugin SHALL refuse any read for a
company without a grant.

- Decision/source: D-5.

#### Scenario: positive
- GIVEN company A is granted and company B is not
- WHEN a caller in company A lists sessions
- THEN it gets A's rows

#### Scenario: negative
- GIVEN the same grants
- WHEN a caller in company B lists sessions
- THEN it gets error code `denied` with the message `Sessions are not shared with this company.`

#### Scenario: edge
- GIVEN two companies are granted
- WHEN one session changes
- THEN the row is updated for both companies

### FR-6: Private sessions never leave

A session that fails the extension's sharing rule SHALL NOT be sent, counted or returned, and a
session that becomes private SHALL be removed from every company within 10 s.

- Decision/source: D-6.

#### Scenario: positive
- GIVEN a session in a local-only project
- WHEN the inventory syncs
- THEN no row for it exists in the plugin and the shared count excludes it

#### Scenario: negative
- GIVEN a request names a private session's thread key
- WHEN the extension handles it
- THEN it answers `not_found`

#### Scenario: edge
- GIVEN a shared session is marked private
- WHEN 10 s have passed
- THEN its row is gone from every company

### FR-7: Status on both sides

Both settings screens SHALL show the connection state and the last time the extension was seen.

- Decision/source: UI Layout.

#### Scenario: positive
- GIVEN a working connection
- WHEN either settings screen is opened
- THEN it shows `Connected`

#### Scenario: negative
- GIVEN the browser has been closed for 5 minutes
- WHEN the plugin settings page is opened
- THEN it shows `Not connected` and `Last seen 5 minutes ago`

#### Scenario: edge
- GIVEN the founder presses `Disconnect` on either side
- WHEN the other side is opened
- THEN it shows `Not connected` and no company is ticked

### FR-8: Bridge identity

The plugin SHALL accept a bridge call only when it carries a valid bridge token issued at pairing,
and SHALL refuse bridge calls made with an agent credential.

- Decision/source: D-9, D-12.
- Exact contract values: header `X-Threadkeeper-Bridge-Token`; token 32 random bytes, base64url; pairing code 8 characters, valid 10 minutes; every bridge route declares `auth: "board"`; `Disconnect` on either side revokes the token at once.

#### Scenario: positive
- GIVEN the founder starts pairing in the extension and confirms the 8-character code on the plugin's settings page within 10 minutes
- WHEN the extension calls a bridge route with the issued token
- THEN the call proceeds

#### Scenario: negative — local caller without the token
- GIVEN a `local_trusted` server and a local process that calls a bridge route without the token, or with a revoked one
- WHEN the plugin handles it
- THEN it answers error code `not_paired` and stores and sends nothing

#### Scenario: edge — agent credential
- GIVEN a call to a bridge route made with an agent API key or run token
- WHEN Paperclip handles it
- THEN it is refused with `denied` before the plugin handler runs

### FR-9: The plugin is installed and stays enabled

REQ-7 SHALL create the `browser-sessions` plugin package, install it in the founder's Paperclip
instance with the founder's go-ahead, and keep it enabled across server restarts unless the founder
disables it.

- Decision/source: D-13.

#### Scenario: positive
- GIVEN REQ-7 is complete
- WHEN the Paperclip server restarts
- THEN Paperclip's plugin list shows `browser-sessions` installed and enabled

#### Scenario: negative
- GIVEN the plugin fails to load
- WHEN the server starts
- THEN Paperclip still starts and the extension's status shows `Not connected` with the plugin's error from the plugin list

#### Scenario: edge
- GIVEN the founder disabled the plugin in Paperclip
- WHEN the server restarts
- THEN it stays disabled

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Change latency | 10 s or less from a session change to the stored row | Connected, extension window open | Timestamp in the extension log against the row's update time |
| First sync | 60 s or less for 2,000 sessions | Local server | Synthetic library (`src/core/synthetic-fixtures.ts`) and a timer |
| Request round trip | Median 2 s or less with the extension window open | `threads.list`, limit 20, local server | 20 timed calls |
| Message size | 4 MB or less per message | All messages | Validator unit test |
| Privacy | 0 private sessions in the plugin's storage | Library with private sessions | Query the plugin's table after sync |

## Constraints from platform

- Auth / access / ownership: plugin routes run through Paperclip's normal auth and company pipeline (`paperclip/packages/shared/src/types/plugin.ts:641-658`); the extension authenticates as the board user (none on `local_trusted`, board key otherwise), every bridge route declares `auth: "board"`, and every bridge call also carries the bridge token (D-12). Capabilities to declare: `api.routes.register`, `database.namespace.migrate`, `database.namespace.read`, `database.namespace.write`, `plugin.state.read`, `plugin.state.write`, `companies.read`, `activity.log.write`, `ui.page.register`, `instance.settings.register` (`packages/shared/src/constants.ts:1352-1456`).
- API / types: `PluginContext` members `db`, `state`, `activity`, `companies` (`packages/plugins/sdk/src/types.ts:2212-2269`); `PluginApiRouteDeclaration`; Still protocol types in `extension/src/core/dock/protocol.ts`.
- Cache: the plugin's rows are a cache of the extension's library, scoped by company; invalidated by fingerprint on every connect and by removal messages. Never shared across companies.
- Files to extend, not reinvent: `extension/src/core/dock/{protocol,query,payload}.ts` (extract what both protocols share; do not fork the code); `extension/src/core/paperclip/{client,auth}.ts`; `extension/src/entrypoints/manager/PaperclipSettings.tsx`; `extension/src/entrypoints/background.ts`.
- Dependencies: the plugin depends on the fork's plugin SDK only. No new third-party library without the founder's go-ahead.
- Compatibility / migration / rollout / rollback: the Still protocol `still-threadkeeper/1` must keep passing its existing tests (`tests/unit/dock-*.test.ts`). Rollback is disabling the plugin; its database namespace can be dropped.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| `settings.paperclip` | yes | `extension/src/core/schema.ts:889` | Gains the bridge id and the granted company ids |

## Out of scope

- Agent tools — REQ-8, REQ-9, REQ-11.
- Events about session state — REQ-10.
- Message text, summaries or vectors stored on the Paperclip side — G-2.
- More than one browser paired to one company at a time.

## Acceptance Criteria

- **AC-1** Given a connected extension and company A ticked, When pairing completes, Then the plugin settings page shows `Connected to Threadkeeper in ` followed by the browser name and the plugin holds rows for company A only.
- **AC-2** Given the extension uses a protocol id other than `paperclip-threadkeeper/1`, When it connects, Then the plugin answers error code `version_mismatch`, both settings screens show `Version mismatch`, and the plugin holds no rows; and Given matching protocol ids and different build commits, Then the connection works and both screens show `Threadkeeper and Paperclip were built from different commits`.
- **AC-3** Given a synthetic library of 2,000 shareable sessions and a new grant, When the first sync runs against a local server, Then the plugin holds 2,000 rows within 60 s, each row has the fields in D-7, and no message was larger than 4 MB.
- **AC-4** Given a synced library, When one session's title changes, Then the stored row has the new title within 10 s; and Given the server restarts, When the extension reconnects, Then the number of rows is unchanged and only changed rows were sent.
- **AC-5** Given a connected extension with its window open, When the plugin sends `threads.list` with limit 20, Then it receives at most 20 rows within 2 s.
- **AC-6** Given no extension has been seen for 40 s, When the plugin sends any request, Then the caller gets error code `browser_offline` in under 1 s.
- **AC-7** Given the browser is running with no extension window open, When the plugin sends `threads.list`, Then the caller gets either rows within 60 s or error code `timeout`.
- **AC-8** Given a session in a local-only project and a session marked excluded, When the inventory syncs, Then neither has a row in the plugin, the shared count excludes both, and a request naming either thread key is answered `not_found`.
- **AC-9** Given company A is granted and company B is not, When a caller in company B asks for sessions, Then it gets error code `denied` and the message `Sessions are not shared with this company.`
- **AC-10** Given a bridge exists for company A, When a second browser tries to pair for company A, Then pairing is refused with the message `Another browser is already connected for {company}. Disconnect it first.`
- **AC-11** Given the founder unticks company A or presses `Disconnect`, When 10 s have passed, Then the plugin holds no row for company A.
- **AC-12** Given the changes of this REQ, When the existing Still protocol tests `tests/unit/dock-*.test.ts` run, Then all pass unchanged.
- **AC-13** Given the library holds threads with provider `paperclip`, When the inventory syncs, Then none of them has a row in the plugin and the shared count excludes them.
- **AC-14** Given a `local_trusted` server, When a request without the header `X-Threadkeeper-Bridge-Token`, or with a revoked token, reaches any bridge route, Then the plugin answers error code `not_paired` and stores and sends nothing.
- **AC-15** Given a request to a bridge route made with an agent API key or run token, When Paperclip handles it, Then it is refused with `denied` and the plugin handler does not run.
- **AC-16** Given REQ-7 is complete, When the Paperclip server restarts, Then Paperclip's plugin list shows `browser-sessions` installed and enabled; and Given the founder disabled it, Then it is still disabled after the restart.

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-5, D-9, D-10 | paired / not paired / grant removed | AC-1, AC-10, AC-11 | Plugin worker tests with the SDK test harness; extension unit tests with the fake Paperclip server (`tests/unit/paperclip-fake-server.ts`) |
| FR-2 | D-4, D-11 | connected / protocol mismatch / commit mismatch | AC-2 | Unit tests on both sides |
| FR-3 | D-7, D-8 | 2,000 rows / bad row / restart | AC-3, AC-4, AC-13 | Synthetic library run; plugin table query |
| FR-4 | D-3, D-4 | round trip / offline / no window | AC-5, AC-6, AC-7 | Timed calls against a local server |
| FR-5 | D-5 | granted / not granted / two companies | AC-9 | Plugin worker tests |
| FR-6 | D-6 | excluded / asked by key / becomes private | AC-8, AC-11 | Extension unit tests beside `tests/unit/dock-payload.test.ts` |
| FR-7 | UI Layout | connected / browser closed / disconnect | AC-1, AC-11 | Observation of both screens |
| FR-8 | D-9, D-12 | token accepted / no token / agent credential | AC-14, AC-15 | Plugin route tests against a `local_trusted` test server |
| FR-9 | D-13 | enabled after restart / load failure / founder disabled | AC-16 | Restart the local server and read the plugin list |
| Compatibility | Constraints | — | AC-12 | Existing test files |

## Readiness

| Dimension | Pass? | Gap |
|---|---|---|
| Problem & goal | yes | |
| Behavior contract | yes | |
| Acceptance criteria | yes | |
| Context & constraints | no | `PluginDatabaseClient`, the settings-page slot and the plugin test harness have not been read; account fields wait for REQ-1 |
| Buildability | no | D-3 is unresolved |

**Score: 3/5** — three dimensions pass; also capped at 3 by a build-blocker.

- Build-blockers: D-3. Source: `server/src/realtime/plugin-api-ws.ts:14-40` and browser limits on service workers. Impact: FR-4 and everything built on it. Resolution: a short spike measuring a long-held request from an MV3 service worker and from the manager page against a plugin route, then `/ultimate-sdd:design REQ-7`.
- Separate load gates: blocked by REQ-4. The plugin manifest is shared with REQ-6 and REQ-8 to REQ-13; do not build two of them at the same time. No TASKs yet.
- Artifact review: independent review round 1 of 3 (2026-11-13) returned needs-work with 5 findings and overflow; the writer applied fixes the same day; an independent recheck is pending. Report and dispositions: `verify/artifacts/plan-review.md`.
- Stale downstream contracts/evidence: none.

## Changelog

| Date | Change |
|---|---|
| 2026-11-13 | Initial specify |
