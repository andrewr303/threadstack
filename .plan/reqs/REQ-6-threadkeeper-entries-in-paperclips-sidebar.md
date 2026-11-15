---
id: REQ-6
title: Browse, Threads and the session board in Paperclip's sidebar
epic: EPIC-2
spec: SPEC-8
status: in-progress
readiness: 4
effort: high
readiness_gaps: ["implementation drafted against approved snapshot; final acceptance and ordered independent reviews pending"]
blocked_by: [REQ-5, REQ-7]
blocks: []
priority: P0
source: BRIEF-1
change:
stack: Paperclip plugin (UI slots), Paperclip UI core (layout host mode), extension manager UI
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-6 — Browse, Threads and the session board in Paperclip's sidebar

## Overview

Paperclip's sidebar becomes the one sidebar of the merged product. It lists Browse, Threads and the
session board next to Paperclip's own pages. Choosing one shows that Threadkeeper view in the
content area while Paperclip's sidebar stays where it is. Choosing a Paperclip page shows Paperclip.

## Problem Statement

After REQ-5 the window has two navigation systems that swap: the shell's rail for Threadkeeper views
and Paperclip's sidebar for Paperclip. The founder asked for "threadkeeper being new sidebar tabs"
in Paperclip (CTX-1) and chose to add them "to Paperclip's sidebar through a first-party Paperclip
plugin" (G-1). The hard part is that a Threadkeeper view cannot be drawn inside the Paperclip page:
its embedded provider pages keep their sign-ins only as direct children of the extension's own page
(`context/platform.md`, Constraints).

## Solution

Two parts. First, a first-party Paperclip plugin registers three sidebar entries and three pages.
Second, a host mode lets the two documents share the window: the Paperclip frame stays full-size on
top, the Threadkeeper view is drawn beneath it by the shell, and the frame is clipped away over the
page's content rectangle so the view beneath shows and receives pointer input. When Paperclip opens
a dialog, menu or notice, the clip is lifted until it closes. This technique is unproven; a spike
decides whether it is built or whether the entries fall back to switching views (Q-3).

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-2-paperclip-inside-the-extension.md`; REQ-5 (message channel between shell and Paperclip).
- Context: `context/platform.md` (Paperclip "Sidebar", APIs "Plugin UI slots", Constraints; Threadkeeper "Shell", "Embedded pages"); CTX-1 (G-1, G-4).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: required before build (`/ultimate-sdd:design REQ-6`), after the spike.

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: The entries come from a first-party Paperclip plugin | CTX-1 G-1 | agreed | FR-1 / AC-1 | Founder's choice. Slot types `sidebar` and `page` with `routePath` exist (`paperclip/packages/shared/src/constants.ts:1510-1528`, `types/plugin.ts:527`) `[verified]` |
| D-2: Paperclip's layout and interface components may be edited for host mode | CTX-1 G-4 | agreed | FR-2, FR-3 / AC-3, AC-4 | Hard fork |
| D-3: In-place technique is "clip the frame over the content rectangle" | Planner's design; not found in either codebase | unresolved | FR-2, FR-3, FR-4, FR-7 / AC-3 to AC-6, AC-9 | Must pass the spike in "Spike" below. If it fails, the founder decides (Q-3) |
| D-4: Route segments `browse`, `threads`, `session-board` | None is in the reserved list (`constants.ts:1542-1562`) `[verified]` | assumed | FR-1 / AC-1 | Boundary: check Paperclip's own routes in `ui/src/App.tsx` for a clash at build |
| D-5: Labels `Browse`, `Threads`, `Session board` | Paperclip already has `Dashboard` (`ui/src/components/Sidebar.tsx:180`) `[verified]` | assumed (Q-2 open) | FR-1 / AC-1 | Two entries called Dashboard would be confusing |
| D-6: The plugin's `sidebar` slot is used as it is, so the entries appear in the "Work" section after Paperclip's own items | `Sidebar.tsx:255-267` `[verified]` | assumed | FR-1 / AC-1 | No core edit for placement in v1 |
| D-7: In fused mode the shell does not draw its own view switch; the session list, account controls and settings entry move into the Threadkeeper view as its left column | Planner's design | assumed | FR-5 / AC-7 | Depends on the rail as it is after REQ-1 |
| D-8: If Paperclip is not `running`, the shell shows its own rail and view switch exactly as in REQ-5 | Threadkeeper must stay usable without Paperclip | assumed | FR-6 / AC-8 | The library and Browse do not need the server |
| D-9: The plugin package is `packages/plugins/plugin-browser-sessions`, plugin id `browser-sessions`, created and installed by REQ-7; this REQ adds its sidebar entries and pages | REQ-7 D-13 | assumed | FR-1 | One owner for the scaffold; REQ-6 therefore waits for REQ-7 |

## UI Layout

- Paperclip's sidebar, "Work" section, after Paperclip's own entries: `Browse`, `Threads`, `Session board`. The entry for the current view is highlighted the same way Paperclip highlights its own.
- Content area on those three routes: the Threadkeeper view, filling the rectangle Paperclip gives the page. Its left column holds the session list, account controls and Settings entry that the shell's rail holds today.
- Paperclip's header above the content area stays as Paperclip draws it.
- Outside the extension (Paperclip opened in an ordinary tab), each of the three pages shows:
  heading `Open this in Threadkeeper`, text `Browse, Threads and the session board run inside the Threadkeeper window.`, button `Open Threadkeeper`.
- Loading: until the shell has positioned the view, the content rectangle shows Paperclip's page background, with no spinner.
- Error: if the shell does not answer within 2 s inside the extension, the page shows `Threadkeeper is not responding. Reload the window.`

## Spike (before design and build)

Build a throwaway page pair, not product code, and record results under `verify/`. Pass means all hold in Edge and Chrome on macOS:

1. A cross-origin frame whose page background is transparent shows the element beneath it.
2. With `clip-path` removing a rectangle from the frame, a click inside the rectangle reaches the element beneath, and a click outside reaches the frame.
3. Open and close of Paperclip's dialog, popover, dropdown menu, tooltip, select, context menu and notice components can each be reported from one place per component in `ui/src/components/ui/`.
4. Lifting and restoring the clip causes no visible flash for longer than one frame at 60 Hz.
5. Keyboard focus moves from the view beneath to a Paperclip dialog when it opens and back when it closes.

## Functional Requirements

### FR-1: Three entries and three pages

The plugin SHALL register three `sidebar` slots and three `page` slots with route paths `browse`,
`threads` and `session-board`, labelled `Browse`, `Threads` and `Session board`.

- Decision/source: D-1, D-4, D-5, D-6, D-9.

#### Scenario: positive
- GIVEN the plugin is installed and enabled
- WHEN the founder opens Paperclip in the extension window
- THEN the three entries are in the "Work" section and each leads to `/<company>/browse`, `/<company>/threads` or `/<company>/session-board`

#### Scenario: negative
- GIVEN the plugin is disabled in Paperclip
- WHEN the sidebar renders
- THEN the three entries are absent and the shell behaves as in REQ-5

#### Scenario: edge
- GIVEN Paperclip is opened in an ordinary browser tab
- WHEN the founder chooses `Threads`
- THEN the page shows `Open this in Threadkeeper` with the `Open Threadkeeper` button and no error

### FR-2: The view opens in place

Inside the extension window, choosing one of the three entries SHALL show the matching Threadkeeper
view in the page's content rectangle while Paperclip's sidebar and header remain visible and usable.
The view SHALL be the same mounted view as before, with its state intact.

- Decision/source: D-2, D-3.
- Exact contract values: added to the REQ-5 message channel, page to shell: `{ source: "paperclip-ui", v: 1, type: "slot", view: "browse" | "threads" | "session-board" | null, rect: { x, y, width, height } | null }`, sent on route change and whenever the rectangle changes.

#### Scenario: positive
- GIVEN the founder has three session tabs open in Browse
- WHEN they go to a Paperclip page and back to `Browse` through the sidebar
- THEN the same three tabs are there and no embedded page reloaded

#### Scenario: negative
- GIVEN a `slot` message whose rectangle lies outside the window or has a negative size
- WHEN the shell handles it
- THEN the message is ignored and the previous placement stays

#### Scenario: edge
- GIVEN the founder resizes the window or the Paperclip sidebar
- WHEN the size change ends
- THEN the view's edges match the content rectangle within 1 CSS pixel

### FR-3: Paperclip's overlays stay usable

While a Threadkeeper view is showing, a Paperclip dialog, command palette, menu, tooltip or notice
SHALL be fully visible and clickable, and closing it SHALL return input to the view.

- Decision/source: D-2, D-3.
- Exact contract values: page to shell `{ source: "paperclip-ui", v: 1, type: "overlay", open: boolean }`; the count of open overlays is kept on the Paperclip side and `open` is `true` while it is above zero.

#### Scenario: positive
- GIVEN the Threads view is showing
- WHEN the founder opens Paperclip's command palette from its sidebar
- THEN the palette is fully visible over the view, accepts typing, and after Escape the view accepts clicks again

#### Scenario: negative
- GIVEN an `overlay` message with `open: true` is never followed by `open: false` within 60 s and Paperclip reports no open overlay when asked
- WHEN the shell's check runs
- THEN the clip is restored so the view is usable

#### Scenario: edge
- GIVEN a Paperclip notice appears in a corner over the view
- WHEN it is showing
- THEN it is visible and its action button is clickable, and the view stays visible beneath it

### FR-4: Keyboard

With focus in a Threadkeeper view, Command+K (macOS) SHALL open Paperclip's command palette.

- Decision/source: D-3. Shell to page message `{ source: "threadkeeper-shell", v: 1, type: "command", name: "palette" }`.

#### Scenario: positive
- GIVEN focus is in the Threads list
- WHEN the founder presses Command+K
- THEN Paperclip's command palette opens

#### Scenario: negative
- GIVEN focus is in a text field of an embedded provider page
- WHEN the founder presses Command+K
- THEN the provider page receives the key and the palette does not open

#### Scenario: edge
- GIVEN Threadkeeper has its own handler for the same key in that view
- WHEN the key is pressed
- THEN Threadkeeper's handler wins; the conflict list is settled in design

### FR-5: One sidebar

In fused mode the shell SHALL NOT draw its own view switch. The session list, account controls and
Settings entry SHALL be reachable inside the Threadkeeper view.

- Decision/source: D-7.

#### Scenario: positive
- GIVEN fused mode
- WHEN the Browse view shows
- THEN there is one primary sidebar (Paperclip's) and the session list is the view's left column

#### Scenario: negative
- GIVEN fused mode
- WHEN the window is inspected
- THEN no element offers a second Browse, Threads, Dashboard switch

#### Scenario: edge
- GIVEN the side panel or overlay surface
- WHEN it renders
- THEN it keeps its existing layout; fused mode applies to the full page only

### FR-6: Works without Paperclip

When Paperclip is not `running`, the shell SHALL show its own rail and view switch as in REQ-5, and
SHALL return to fused mode when Paperclip is `running` again.

- Decision/source: D-8.

#### Scenario: positive
- GIVEN the server is stopped
- WHEN the founder opens the window
- THEN Browse, Threads and Dashboard are reachable from the shell's rail

#### Scenario: negative
- GIVEN the server stops while fused mode is showing Threads
- WHEN the shell's health check sees it
- THEN the Threads view stays on screen, the shell's rail appears, and no state is lost

#### Scenario: edge
- GIVEN the server comes back
- WHEN the Paperclip frame reports `ready`
- THEN the shell returns to fused mode on the same view

### FR-7: Fallback if the spike fails

If the spike does not pass, this REQ SHALL stop before build and return to the founder with the
results and the two options in Q-3.

- Decision/source: D-3.

#### Scenario: positive
- GIVEN the spike passes all five checks
- WHEN design is written
- THEN the build proceeds on FR-1 to FR-6

#### Scenario: negative
- GIVEN any spike check fails
- WHEN the result is recorded
- THEN no product code for FR-2 to FR-5 is written until the founder answers Q-3

#### Scenario: edge
- GIVEN the founder accepts view switching
- WHEN the REQ is re-specified
- THEN FR-2 to FR-5 are replaced by "the entry switches the shell to that view" and the changelog records it

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Placement accuracy | View edges within 1 CSS pixel of the content rectangle after a size change ends | Window and sidebar resize | Measured with `getBoundingClientRect` on both sides in an end-to-end run |
| Overlay switch | No frame in which neither the overlay nor the view is visible | Opening and closing a dialog | Screen recording at 60 Hz reviewed frame by frame during the spike |
| State kept | 0 embedded page reloads when moving between Paperclip pages and Threadkeeper views | 3 session tabs loaded | Network panel shows no document requests |

## Constraints from platform

- Auth / access / ownership: plugin UI is trusted code that runs in Paperclip's page (`paperclip/doc/plugins/PLUGIN_SPEC.md:15-16`) `[verified: scan]`; messages follow the origin checks of REQ-5 FR-4.
- API / types: plugin manifest UI slot declarations (`packages/shared/src/types/plugin.ts:491-535`); capabilities `ui.sidebar.register`, `ui.page.register`.
- Cache: N/A.
- Files to extend, not reinvent: Paperclip `ui/src/components/Layout.tsx`, `ui/src/components/ui/*` (dialog, popover, dropdown menu, tooltip, select, context menu, notices), the REQ-5 bridge module; extension `src/entrypoints/manager/App.tsx`, `shell/Rail.tsx`, `workspace/FrameStage.tsx`. None of `Layout.tsx` or `ui/src/components/ui` has been read yet.
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: disabling the plugin returns the product to REQ-5 behaviour.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| `PAPERCLIP_THREADKEEPER_EXTENSION_IDS` | yes | Paperclip server environment | Same setting as REQ-5 |

## Out of scope

- Restyling Threadkeeper's views to Paperclip's design tokens.
- Moving the entries out of the "Work" section.
- Drawing Threadkeeper views inside the Paperclip page — not possible with embedded provider pages (see Problem Statement).
- Filter, sort and group controls of the session list — separate workstream.

## Acceptance Criteria

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

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-1, D-4, D-5, D-6, D-9 | entries shown / plugin disabled / ordinary tab | AC-1, AC-2 | Plugin manifest test; observation |
| FR-2 | D-2, D-3 | in place / bad rectangle / resize | AC-3, AC-9, AC-11 | Unit test of the message handler; end-to-end run |
| FR-3 | D-2, D-3 | palette usable / stuck open flag / notice | AC-4, AC-5 | End-to-end run in Edge and Chrome with a recording |
| FR-4 | D-3 | palette opens / provider field / key conflict | AC-6 | End-to-end run |
| FR-5 | D-7 | one sidebar / no second switch / other surfaces | AC-7 | Component test; observation |
| FR-6 | D-8 | offline rail / stops mid-use / returns | AC-8 | End-to-end run with the service stopped |
| FR-7 | D-3 | spike passes / fails / founder accepts switching | AC-10 | Spike record under `verify/` |

## Readiness

| Dimension | Current assessment |
|---|---|
| Problem and goal | yes: the full implementation request adopts the plan defaults; the current-snapshot alternative is explicitly approved |
| Behavior contract | yes: original FRs and ACs are preserved; `REQ-6-design.md` records the layered implementation and `REQ-6-ui-supplement.md` the founder's current compact-interface request; unresolved literal-spec gaps remain explicit |
| Acceptance criteria | yes: TASK-1 owns the original AC IDs and text; missing runtime evidence remains visible |
| Context and constraints | partial: the current integration is mapped in `context/implementation.md`; historical pre-merge line citations remain reference material |
| Buildability | yes: source, package dependencies, interfaces and targeted regression checks exist |

**Score: 4/5.** This is implementation readiness, not completion or an acceptance pass.
The requirement and TASK are in progress. Dependency outcomes, current all-AC evidence,
ordered independent reviews and completion gates remain necessary before `done`.
No historical load-gate success is inferred from the existence of drafted code.

The founder approved using the current working snapshot and installing pinned dependencies.
The original checkout, live extension folder and user instance remain outside deployment scope.
The current implementation uses the layered fused design in `REQ-6-design.md`; switching remains
the fallback. The original clipping technique's failed scrolling behavior is retained in its spike
record. The founder's fix-all continuation directs repairs to the existing implementation, but is
not recorded as a separate explicit Q-3 answer. Original AC-10 is unchanged and remains a formal
reconciliation gap. See `verify/fix-all-cycle.md` for current eager loading, timing, and gate limits.
Real provider delivery and real launchd registration are not claimed.
See `verify/implementation-checkpoint.md`, the final validation report and independent review
reports for concrete source and evidence. Historical authored-plan review remains at
`verify/artifacts/plan-review.md`.

## Changelog

| Date | Change |
|---|---|
| 2026-11-13 | Initial specify |
| 2026-11-13 | The documented view-switching fallback is prepared while the required five-check Edge/Chrome fused-sidebar spike is NOT RUN. No failed spike, product clipping or fused-mode acceptance pass is claimed. |
| 2026-11-14 | Spike run in Edge 157, Chrome 157 and Chrome for Testing 153 (`verify/req6-spike/v2/`). The D-3 technique passes its checks but wheel and trackpad scrolling of the view fails in all three; spike check 3 does not hold as written. D-3 resolved in `REQ-6-design.md` as the layered variant (view above a transparent frame; frame raised for blocking overlays; notices through holes in the view). Additive contract fields: `ready.mode`, `slot.scheme`, `overlay.regions`, shell `overlay-query` and `placed`. Q-3 is still unanswered by the founder `[assumed]`; AC-10's premise is therefore not literally met and needs the founder's word. |
| 2026-11-14 | Fused mode built (FR-1 to FR-6) after three bounded repair rounds; independent spec review round 3 PASS (`verify/repairs.r3.cumulative-spec.md`), quality review round 2 with no Blocker or Major (`verify/repairs.r2.cumulative-quality.md`). Real browsers (`.acceptances/paperclip-merge/round-19` Chrome for Testing, `round-20` Edge): 11 of 12 cases pass in each. Open defects: (1) opening the window on Threads with Paperclip running lands on Paperclip's own page instead of fused Threads and stays raised; (2) a click within about 100 ms of closing the palette can be swallowed. The frame now loads whenever the configured server runs (differs from REQ-5 FR-2 wording; needs a decision). The 2 s "Threadkeeper is not responding" text is not built. Review budget of 3 rounds is used: REVIEW_LIMIT_REACHED. Status stays in-progress; no gate is claimed. |
| 2026-11-14 | The founder subsequently instructed `Fix all and then open new PR`, authorizing a new repair cycle beyond the stopped historical cycle. Added `REQ-6-ui-supplement.md` for title/mode alignment, one compact controls row, one Sessions/results sidebar, and usable Ask formatting. Current source/spec reconciliation is in `verify/fix-all-cycle.md`; successor runtime and ordered review receipts remain pending. Original ACs and unfinished statuses are preserved. |
