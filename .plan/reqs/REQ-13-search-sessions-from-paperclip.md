---
id: REQ-13
title: Search the library from inside Paperclip
epic: EPIC-4
spec: SPEC-17
status: in-progress
readiness: 4
effort: med
readiness_gaps: ["implementation drafted against approved snapshot; final acceptance and ordered independent reviews pending"]
blocked_by: [REQ-8]
blocks: []
priority: P1
source: BRIEF-1
change:
stack: Paperclip UI core (search page, command palette), Paperclip plugin route, extension library search
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-13 — Search the library from inside Paperclip

## Overview

Paperclip's search page and its command palette gain a Sessions section. Typing searches the
founder's library in the extension with the same search the founder uses in Threads; submitting
the search uses the remote embedding and reranking the founder configured. Choosing a result opens
that session in the extension window.

## Problem Statement

Paperclip's search covers only Paperclip's own records in Postgres (`paperclip/doc/SEARCH.md:23`)
`[verified: scan]`. The founder asked for "embedding and reranking and everything else from
threadkeeper" in Paperclip (CTX-1), and chose to keep the library in the extension (G-2), so
Paperclip's search has to ask the extension.

## Solution

Edit Paperclip's search page and command palette (core edits are allowed, G-4) to call a
board-authenticated route of the `browser-sessions` plugin, which sends `threads.search` over the
bridge (REQ-7) with the same validation, caps, redaction and privacy filter as the agent tool
`sessions_search` (REQ-8). Paperclip's own results load as before and never wait for sessions.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-4-one-memory.md`; REQ-7 (bridge, grants); REQ-8 (search handler, error texts, caps).
- Context: `context/platform.md` (Paperclip "UI assumptions"; APIs "Plugin API routes", "Still (Sidebar Dock)"); CTX-1 (G-2, G-4).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: not required once the gap in Readiness is closed.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: Paperclip's search page and command palette are edited in core | No plugin slot for search results (`paperclip/packages/shared/src/constants.ts:1510-1528`) `[verified]`; CTX-1 G-4 | agreed (hard fork) | FR-1, FR-2 | The only place the founder already searches |
| D-2: The page calls a plugin route with board authentication; the route reuses REQ-8's search handler | `PluginApiRouteDeclaration` (`packages/shared/src/types/plugin.ts:641-658`) `[verified]` | assumed | FR-1 / AC-1 | One handler for agents and the founder |
| D-3: Typing uses quality `fast` after 250 ms without a keystroke and 2 or more characters; submitting uses `best` | Mirrors the extension's own search (`useThreadSearch.ts`) `[verified: scan]` | assumed | FR-1 / AC-1, AC-2 | Quick while typing, best on intent |
| D-4: Threads with provider `paperclip` are left out of the Sessions section | Paperclip already lists its own tasks | assumed | FR-1 / AC-3 | No duplicates |
| D-5: The Sessions section loads independently and never delays Paperclip's own results | Planner's choice | assumed | FR-4 / AC-6 | The browser may be closed |
| D-6: Opening a result sends `thread.open` over the bridge; the extension shows the session in Browse and brings its window forward | `thread.open` (`src/core/dock/protocol.ts:54`) `[verified]` | assumed | FR-3 / AC-4 | Works from the extension window and from an ordinary tab |

## UI Layout

- Search page: a section `Sessions` below Paperclip's own result groups. Each row: title, provider
  label, account label, state label, relative updated time, one excerpt line. Up to 8 rows, then
  `Show more` loads 8 more.
- Command palette: a group `Sessions` with up to 5 rows.
- While loading: `Searching sessions…`.
- Empty: `No sessions match.`
- Not shared: `Sessions are not shared with this company.` with a link `Share sessions` to the plugin settings page.
- Browser not connected: `Sessions can be searched while Threadkeeper is running.`
- Error or timeout: `Session search did not answer. Try again.`
- When quality `best` fell back to local search: a small note `Local results only`.

## Functional Requirements

### FR-1: Sessions on the search page

The search page SHALL show matching shared sessions from the library, excluding threads with
provider `paperclip`.

- Decision/source: D-1, D-2, D-3, D-4.
- Exact contract values: route `GET /api/plugins/browser-sessions/api/search?companyId=&q=&quality=fast|best&cursor=`; `q` 2 to 2000 characters; 8 rows per page.

#### Scenario: positive
- GIVEN a shared session about "Stripe webhook retries"
- WHEN the founder types `webhook retries` and pauses
- THEN within 1.5 s the Sessions section lists it with an excerpt

#### Scenario: negative
- GIVEN a one-character query
- WHEN the founder types it
- THEN no session request is sent and the section is not shown

#### Scenario: edge
- GIVEN a Paperclip task thread in the library matches the query
- WHEN results show
- THEN it appears only in Paperclip's own results, not under Sessions

### FR-2: Sessions in the command palette

The command palette SHALL show up to 5 `fast` session results in a `Sessions` group.

- Decision/source: D-1, D-3.

#### Scenario: positive
- GIVEN the palette is open
- WHEN the founder types `migration order`
- THEN a `Sessions` group lists matching sessions

#### Scenario: negative
- GIVEN the browser is not connected
- WHEN the palette searches
- THEN the `Sessions` group is omitted and the palette's own results are unchanged

#### Scenario: edge
- GIVEN the founder keeps typing
- WHEN a newer query is sent
- THEN results of an older query that arrive later are discarded

### FR-3: Open a result

Choosing a result SHALL open that session in Browse in the extension window and bring the window
forward.

- Decision/source: D-6.

#### Scenario: positive
- GIVEN Paperclip is open in the extension window
- WHEN the founder chooses a session result
- THEN Browse shows that session as a tab

#### Scenario: negative
- GIVEN the session became private after the search
- WHEN the founder chooses it
- THEN a notice `This session is no longer available.` appears and nothing opens

#### Scenario: edge
- GIVEN Paperclip is open in an ordinary browser tab
- WHEN the founder chooses a result
- THEN the extension window comes forward showing the session

### FR-4: Never in the way

The Sessions section SHALL load independently; Paperclip's own results SHALL render as soon as they
arrive, whatever the state of the session search.

- Decision/source: D-5.

#### Scenario: positive
- GIVEN the session search takes 20 s
- WHEN the founder searches
- THEN Paperclip's own results appear as fast as before and the Sessions section shows `Searching sessions…`

#### Scenario: negative
- GIVEN the bridge answers `browser_offline`
- WHEN the founder searches
- THEN the Sessions section shows `Sessions can be searched while Threadkeeper is running.`

#### Scenario: edge
- GIVEN the company has no grant
- WHEN the founder searches
- THEN the Sessions section shows `Sessions are not shared with this company.` with the `Share sessions` link

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Typing latency | First session rows within 1.5 s median of the pause | Bridge connected, extension window open, 2,000 sessions | 20 timed searches |
| No regression | Paperclip's own result time unchanged within 10% | Same queries with the bridge off and on | Timed comparison |
| Privacy | 0 private sessions shown | Library with private sessions | Component test with fixtures |

## Constraints from platform

- Auth / access / ownership: the route is board-authenticated and company-checked; grants from REQ-7.
- API / types: REQ-8's `sessions_search` input and output; `thread.open` (`extension/src/core/dock/protocol.ts:54`).
- Cache: none beyond the extension's own query cache.
- Files to extend, not reinvent: Paperclip `ui/src/pages/Search.tsx` and the command palette component (not yet read); the plugin package; REQ-8's handler.
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: with the plugin disabled the section is not rendered.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| none | | | |

## Out of scope

- Session results mixed into Paperclip's own ranking.
- Searching when no browser is running.
- Search filters on the Sessions section — the separate workstream owns filters in Threadkeeper; this section has none in v1.

## Acceptance Criteria

- **AC-1** Given a shared session whose transcript is about Stripe webhook retries and a connected bridge, When the founder types `webhook retries` on Paperclip's search page and pauses, Then within 1.5 s the `Sessions` section lists that session with its provider label, account label, state label and an excerpt.
- **AC-2** Given the founder submits the search, When the results update, Then the request used quality `best`; and Given no remote embedding or reranking is configured, Then the section shows `Local results only`.
- **AC-3** Given a library thread with provider `paperclip` matches the query, When results show, Then it is not under `Sessions`; and Given a one-character query, Then no session request is sent.
- **AC-4** Given Paperclip is open in the extension window, When the founder chooses a session result, Then Browse shows that session as a tab; and Given Paperclip is open in an ordinary tab, Then the extension window comes forward showing it.
- **AC-5** Given the command palette is open and the bridge connected, When the founder types `migration order`, Then a `Sessions` group lists up to 5 matching sessions; and Given the browser is not connected, Then the group is omitted.
- **AC-6** Given the session search takes 20 s, When the founder searches, Then Paperclip's own results appear in the same time as with the plugin disabled, and the section shows `Searching sessions…`.
- **AC-7** Given the bridge answers `browser_offline`, no grant exists, or the request times out, When the founder searches, Then the section shows respectively `Sessions can be searched while Threadkeeper is running.`, `Sessions are not shared with this company.` with `Share sessions`, or `Session search did not answer. Try again.`
- **AC-8** Given a result whose session became private after the search, When the founder chooses it, Then `This session is no longer available.` appears and nothing opens.

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-1 to D-4 | found / short query / Paperclip thread | AC-1, AC-2, AC-3 | Component tests with a fake route; timed manual run |
| FR-2 | D-1, D-3 | palette group / offline / stale answers | AC-5 | Component tests |
| FR-3 | D-6 | opens in Browse / became private / ordinary tab | AC-4, AC-8 | End-to-end run with the bridge |
| FR-4 | D-5 | slow / offline / no grant | AC-6, AC-7 | Component tests with delayed and failing fakes |

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
| 2026-11-13 | Search/palette implementation uses the plugin with stale-query/company cancellation and native-results preservation. Browser-visible search/open/offline/keyboard outcomes remain unverified. |
