---
id: REQ-5
title: Paperclip's web app as a view in the extension window
epic: EPIC-2
spec: SPEC-7
status: in-progress
readiness: 4
effort: med
readiness_gaps: ["implementation drafted against approved snapshot; final acceptance and ordered independent reviews pending"]
blocked_by: [REQ-4]
blocks: [REQ-6, REQ-9]
priority: P0
source: BRIEF-1
change:
stack: extension manager UI (React 18), Paperclip UI (React 19, one small core edit)
linear:
created: 2026-11-13
updated: 2026-11-13
---

# REQ-5 — Paperclip's web app as a view in the extension window

## Overview

The extension window gains a fourth view, Paperclip, beside Browse, Threads and Dashboard. It shows
Paperclip's own web app from the local server, filling the content area, signed in, with Paperclip's
own sidebar and every page working. The founder can reload the window or use Back and Forward and
stay where they were.

## Problem Statement

Paperclip and Threadkeeper live in different tabs. The founder asked for "paperclip turned into the
chrome extension" (CTX-1) and chose to embed the real Paperclip app in the extension window (G-1).
Paperclip's interface cannot be compiled into the extension page: its plugin screens are loaded at
run time from a `blob:` URL (`paperclip/ui/src/plugins/slots.tsx:451-454`), which extension pages
cannot run, and it assumes it is served from its own origin (`ui/src/api/client.ts:8`,
`ui/src/main.tsx:129`, `ui/src/lib/websocket-url.ts:13-20`).

## Solution

Show Paperclip in a frame on its own origin, as a direct child of `manager.html`, using the same
frame layer that embeds provider sites (`workspace/FrameStage.tsx`). Under an extension top-level
page with host permission for the framed origin, the browser treats the frame's cookies and storage
as first-party (CTX-2 rows 4a, 4b), so sign-in, live updates and the service worker behave as in a
normal tab. Add one small module to Paperclip's interface that reports route changes to the shell
and accepts navigation from it, so the shell can restore the place after a reload.

## Planning inputs

- Upstream: `project.md`; `briefs/BRIEF-1-one-window.md` (draft); `epics/EPIC-2-paperclip-inside-the-extension.md`.
- Context: `context/platform.md` (Threadkeeper "Embedded pages", "Shell"; Paperclip "UI assumptions"; Constraints); CTX-1 (G-1, G-4); CTX-2 (rows 4a, 4b).
- Config: `docs/plan/config.json`, validated 2026-11-13 (`ok: true`): `execution_mode: subagent`, `parallelism: disjoint`, `tdd: required`, `max_review_rounds: 3`, `test_commands: []`, `hooks.enabled: false`.
- Workflow: `docs/plan/workflow.md`, section "This project".
- Design: not required; the first task is a proof with the real server (see Readiness).

## Source and decision trace

| Decision | Source / evidence | Status | Affected FR / AC | Rationale / safe default and boundary |
|---|---|---|---|---|
| D-1: Embed the real Paperclip app in a frame | CTX-1 G-1 | agreed | all | Founder's choice |
| D-2: The Paperclip frame belongs to the shell, one per window. It is not a session tab: not counted in `maxLiveFrames`, never put to sleep, no capture, no account menu, not in any session list | Planner's choice; `planFrames` and `maxLiveFrames` in `workspace/state.ts`, default 6 (`src/core/workspace/types.ts:254`) `[verified]` | assumed | FR-2, FR-7 / AC-2, AC-8 | It is the application, not a provider session. Boundary: the account model after REQ-1 may rename these concepts |
| D-3: Route sync uses a small host-bridge module added to Paperclip's interface, with origin checks both ways | Core edits are allowed (CTX-1 G-4) | assumed | FR-4 / AC-4, AC-5, AC-9 | The shell cannot read a cross-origin frame's address. Alternative: a content script in the frame; rejected because the fork can do it in the open |
| D-4: Deep link form `manager.html?surface=page&view=paperclip&pc=<encoded path>` | Existing params `surface`, `threadKey`, `token` (`src/entrypoints/manager/App.tsx:75-96`) `[verified: scan]` | assumed | FR-4 / AC-4 | Adds two params and keeps the existing ones |
| D-5: Back and Forward are the browser's own; the shell only replaces the current history entry | A route change inside a frame adds an entry to the tab's joint history | assumed | FR-4 / AC-5 | Pushing entries from the shell too would double them |
| D-6: The frame uses the same sandbox and permission lists as provider frames | `src/entrypoints/manager/workspace/useWorkspace.ts:543-548` `[verified: scan]`; no `allow-top-navigation` (`docs/architecture.md:34-35`) `[verified]` | assumed | FR-2 / AC-2 | Keeps one rule for embedded pages; popups, downloads, clipboard are already allowed |
| D-7: While the Paperclip view is active the shell's rail is in its collapsed strip form | The rail already collapses to a 64 px strip (`styles/10-shell.css:507`) `[verified: scan]` | assumed | FR-1 / AC-1 | Paperclip's sidebar is then the only wide sidebar. Superseded in fused mode by REQ-6 |
| D-8: The extension injects no style or script that changes Paperclip's layout | BRIEF-1 "no part of its navigation cut off" | agreed | FR-5 / AC-6 | |
| D-10: Responses from the Paperclip origin keep their own security headers inside the workspace tab; the rule that removes frame-blocking headers applies only to provider sites | The rule removes `x-frame-options`, `content-security-policy` and its report-only twin from every `sub_frame` response in the workspace tab (`docs/architecture.md:28-33`) `[verified]`; Paperclip serves uploaded assets with `Content-Security-Policy: sandbox; default-src 'none'` (`paperclip/server/src/routes/assets.ts:364`) `[verified]` | assumed (independent review, 2026-11-13) | FR-9 / AC-13 | Stripping that header would let an uploaded file run script inside Paperclip's frame |
| D-9: The allowed extension ID is a run-time server setting, not a build-time constant | The founder's extension ID is path-based today and changes if the founder later moves to the fixed-key ID (`context/platform.md`, "Live install"; `docs/mac-helper.md`, "The extension ID") `[verified]`; the server already rewrites `index.html` at run time (`paperclip/server/src/static-index-html.ts`) `[verified: scan]` | assumed | FR-4 / AC-9 | Changing the ID must not need a rebuild of Paperclip's interface |

## UI Layout

- View switch: a fourth entry `Paperclip` after `Dashboard`.
- Paperclip view: the rail in strip form on the left, then the Paperclip frame filling the rest of the window. No tab strip, address bar or account menu.
- When the server is not `running` (REQ-4 states): in place of the frame, a centred panel with the REQ-4 status text and its action button.
- Loading: the panel shows `Opening Paperclip…` until the frame's first `ready` message or 10 s, whichever is first; after 10 s without `ready` the frame is shown anyway.
- Deliberately absent: any wrapper chrome around Paperclip, and any copy of Paperclip's navigation in the shell.

## Functional Requirements

### FR-1: A Paperclip view

`WORKSPACE_VIEWS` SHALL include `paperclip`, and choosing it SHALL show the Paperclip frame filling
the content area with the rail in strip form.

- Decision/source: D-1, D-7.
- Exact contract values: view id `paperclip`; label `Paperclip`; `settings.activeView` accepts it and an unknown stored value still falls back to the default (`src/core/schema.ts:1075-1077`).

#### Scenario: positive
- GIVEN the server is `running`
- WHEN the founder chooses `Paperclip`
- THEN Paperclip's interface fills the content area and its own sidebar is visible

#### Scenario: negative
- GIVEN the server is `stopped`
- WHEN the founder chooses `Paperclip`
- THEN the REQ-4 status panel is shown in place of the frame

#### Scenario: edge
- GIVEN the side panel or the in-page overlay surface
- WHEN the view list is read
- THEN `Paperclip` is not offered there (nothing is embedded outside the full page, `docs/architecture.md:15-16`)

### FR-2: One frame per window, loaded once

The shell SHALL create one frame for the configured Paperclip origin when the view is first shown,
keep it for the life of the page, hide it with `display: none` when another view is active, and
never unload it to free a slot.

- Decision/source: D-2, D-6.

#### Scenario: positive
- GIVEN the Paperclip view was opened once
- WHEN the founder switches to Browse and back
- THEN Paperclip is exactly as it was, with no reload

#### Scenario: negative
- GIVEN the frame's document fails to load
- WHEN the shell's next health check finds the server is not `running`
- THEN the status panel replaces the frame within 5 s

#### Scenario: edge
- GIVEN 6 session tabs are already loaded
- WHEN the Paperclip view is opened
- THEN the Paperclip frame loads and none of the 6 session frames is put to sleep because of it

### FR-3: Recovery

When the server returns to `running` after being down, the shell SHALL reload the frame at the last
reported path.

- Decision/source: D-3.

#### Scenario: positive
- GIVEN the founder was on `/ACME/issues` when the server stopped
- WHEN the server is `running` again
- THEN the frame shows `/ACME/issues`

#### Scenario: negative
- GIVEN the origin setting is changed to another address
- WHEN the change is saved
- THEN the frame is recreated at the new origin's `/` and the stored path is cleared

#### Scenario: edge
- GIVEN the server came back but answers 404 for the stored path
- WHEN the frame loads
- THEN Paperclip's own not-found page shows; the shell does nothing further

### FR-4: Route sync and deep links

Paperclip's interface SHALL report each route change to its parent when it is framed by the
extension, and SHALL navigate when the parent asks. The shell SHALL keep the current path in the
page address and restore it on load.

- Decision/source: D-3, D-4, D-5.
- Exact contract values:
  - Page to shell: `{ source: "paperclip-ui", v: 1, type: "ready" }` and `{ source: "paperclip-ui", v: 1, type: "route", path, title }`.
  - Shell to page: `{ source: "threadkeeper-shell", v: 1, type: "hello" }` and `{ source: "threadkeeper-shell", v: 1, type: "navigate", path }`.
  - The page accepts messages only when `event.origin` equals `chrome-extension://` plus one of the extension IDs in the server setting `PAPERCLIP_THREADKEEPER_EXTENSION_IDS`, which the server hands to the interface at run time; when the list is empty the module does nothing.
  - The shell accepts messages only from the frame's own window with `event.origin` equal to the configured Paperclip origin.
  - `path` starts with one `/`, is at most 2000 characters, and is sent as `pc` in the page address, URL-encoded.

#### Scenario: positive
- GIVEN the founder is on `/ACME/issues/ACME-12` in the Paperclip view
- WHEN they reload the window
- THEN the address still has `view=paperclip&pc=%2FACME%2Fissues%2FACME-12` and that page shows

#### Scenario: negative
- GIVEN a message arrives at the shell from another origin, or with `path` equal to `//evil.example`
- WHEN the shell handles it
- THEN it is ignored and the address does not change

#### Scenario: edge
- GIVEN the founder pressed three links inside Paperclip
- WHEN they press the browser's Back twice
- THEN Paperclip is on the first of those pages and the shell is still on the Paperclip view

### FR-5: Nothing altered, nothing cut off

The extension SHALL NOT inject styles or scripts that change Paperclip's layout, and at a window
width of 1280 px Paperclip's sidebar and page header SHALL be visible without horizontal scrolling.

- Decision/source: D-8.

#### Scenario: positive
- GIVEN a 1280 px wide window
- WHEN the Paperclip view is open
- THEN Paperclip's sidebar, header and content are all visible and the frame has no horizontal scrollbar

#### Scenario: negative
- GIVEN the frame's document
- WHEN its style sheets and scripts are listed
- THEN none comes from the extension except the cookie accessor bridge when FR-8 requires it

#### Scenario: edge
- GIVEN a window narrower than 900 px
- WHEN the Paperclip view is open
- THEN Paperclip shows its own narrow layout; the shell adds no second drawer on top of it

### FR-6: Links out of Paperclip

A link in Paperclip to an address the extension can embed SHALL open as a session tab in Browse.
Any other external link SHALL open in an ordinary browser tab.

- Decision/source: `embedTargetFor` (`src/entrypoints/manager/workspace/state.ts:41-52`) `[verified]`; hand-back of new tabs exists (`docs/architecture.md:93-94`) `[verified]`.

#### Scenario: positive
- GIVEN a task comment containing `https://claude.ai/code/session_abc`
- WHEN the founder clicks it
- THEN the shell switches to Browse with that session as a tab

#### Scenario: negative
- GIVEN a link to `https://example.com/doc`
- WHEN the founder clicks it
- THEN it opens in an ordinary browser tab and the shell does not change view

#### Scenario: edge
- GIVEN a link to another Paperclip page with `target="_blank"`
- WHEN the founder clicks it
- THEN it opens in an ordinary browser tab on the Paperclip origin

### FR-7: Kept apart from sessions

The Paperclip frame SHALL NOT be captured, read for agent state, listed as a session, or allowed to
send workspace commands.

- Decision/source: D-2; workspace commands only from `manager.html` as a top-level tab (`docs/architecture.md:45-47`) `[verified]`.

#### Scenario: positive
- GIVEN the Paperclip view has been used for an hour
- WHEN the library is inspected
- THEN no thread was created from the Paperclip frame

#### Scenario: negative
- GIVEN a script in the Paperclip frame sends a workspace command message
- WHEN the worker receives it
- THEN it is refused, as for any frame

#### Scenario: edge
- GIVEN Paperclip tasks synced as threads with provider `paperclip`
- WHEN the founder opens one from Threads
- THEN it opens in the Paperclip view at that task's path, not as a session tab

### FR-8: Sign-in works inside the frame

On an `authenticated` server, Paperclip's own sign-in page SHALL work inside the frame and the
session SHALL survive a window reload.

- Decision/source: CTX-2 rows 4a, 4b; page scripts see only `SameSite=None` cookies unless bridged (`docs/architecture.md:74-80`) `[verified]`.

#### Scenario: positive
- GIVEN an `authenticated` server
- WHEN the founder signs in inside the frame and reloads the window
- THEN Paperclip is still signed in

#### Scenario: negative
- GIVEN Paperclip's interface reads a cookie through `document.cookie` that is not `SameSite=None`
- WHEN sign-in is tested in the frame
- THEN the Paperclip origin is added to the existing cookie accessor bridge's patterns and the test is repeated

#### Scenario: edge
- GIVEN the session expires while the frame is open
- WHEN Paperclip redirects to its sign-in page
- THEN the redirect stays inside the frame

### FR-9: Paperclip keeps its own security headers

The workspace tab's header-removal rule SHALL NOT apply to responses from the configured Paperclip
origin, including frames nested inside the Paperclip frame.

- Decision/source: D-10.

#### Scenario: positive
- GIVEN an uploaded asset that Paperclip serves with `Content-Security-Policy: sandbox; default-src 'none'`
- WHEN it is shown inside the Paperclip frame in the workspace tab
- THEN the response still carries that header

#### Scenario: negative
- GIVEN a provider page in a session tab
- WHEN it loads
- THEN its `x-frame-options` and `content-security-policy` headers are still removed, as today

#### Scenario: edge
- GIVEN the Paperclip origin setting changes
- WHEN the change is saved
- THEN the exclusion follows the new origin and the old one is no longer excluded

## Non-functional requirements

| Concern | Measure / threshold | Conditions | Verification method / source |
|---|---|---|---|
| Switch back to Paperclip | No network request for the document; visible within 100 ms | Frame already loaded | Network panel shows no document request; observation |
| Recovery | Status panel within 5 s of the server stopping | REQ-4 polling at 5 s | Stop the service and time it |
| Message safety | 100% of messages with a wrong origin or malformed path are ignored | Both directions | Unit tests of both handlers |

## Constraints from platform

- Auth / access / ownership: host permission for the Paperclip origin (REQ-4 FR-5). The session rule that removes frame-blocking headers applies to every `sub_frame` in the workspace tab (`core/embed/rules.ts`); Paperclip's UI routes send none (`platform.md`).
- API / types: `WORKSPACE_VIEWS` and `WorkspaceView` (`extension/src/core/workspace/types.ts:225`); `settings.activeView` (`extension/src/core/schema.ts:834`, `:1075-1077`); `FrameStage`, `FrameSlot`; `embedTargetFor`.
- Cache: N/A.
- Files to extend, not reinvent: `extension/src/entrypoints/manager/App.tsx`, `shell/Rail.tsx`, `workspace/{FrameStage.tsx,state.ts,useWorkspace.ts}`; Paperclip `ui/src/main.tsx` plus one new module under `ui/src/lib/`. **All extension paths here are being changed by the multi-profile work and must be re-read after REQ-1.**
- Dependencies: none added.
- Compatibility / migration / rollout / rollback: `activeView: "paperclip"` stored by this version is read by an older version as unknown and falls back to the default view. Paperclip opened in an ordinary tab is unaffected: the bridge module does nothing unless framed by the extension.

## Env & config

| Key | Required | Where documented | Notes |
|---|---|---|---|
| `PAPERCLIP_THREADKEEPER_EXTENSION_IDS` | yes for route sync | Paperclip server environment | Comma-separated extension IDs allowed to frame Paperclip; the founder's is recorded in `context/platform.md` "Live install" (`bajiblleoodfabmofjmcjeejhbjikfkp` on 2026-11-13). Empty disables the bridge module. End-to-end runs with a test build in `/tmp/tk-build` must add that build's own path-based ID (`TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs --print-id`) |

## Out of scope

- Threadkeeper entries in Paperclip's sidebar and in-place content — REQ-6.
- Any restyling of Paperclip or of Threadkeeper's views.
- Showing Paperclip in the side panel or the overlay.
- Paperclip's mobile layout tuning.

## Acceptance Criteria

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

## Coverage

| FR | Decision / source | Scenario kinds (positive / negative / edge or justified N/A) | AC IDs | Verification method / source |
|---|---|---|---|---|
| FR-1 | D-1, D-7 | view shown / server stopped / other surfaces | AC-1, AC-3, AC-12 | Component test beside `tests/unit/manager-app.test.tsx`; observation |
| FR-2 | D-2, D-6 | no reload / load failure / frame budget | AC-2, AC-3 | `planFrames` unit test; network panel |
| FR-3 | D-3 | restores path / origin changed / 404 | AC-11 | End-to-end run with a stand-in page in the workspace harness (`npm run test:workspace`) |
| FR-4 | D-3, D-4, D-5 | reload keeps place / bad message / Back | AC-4, AC-5, AC-9 | Unit tests of both message handlers; end-to-end with the stand-in page |
| FR-5 | D-8 | all visible / nothing injected / narrow window | AC-6 | Observation at 1280 px with a screenshot |
| FR-6 | `embedTargetFor` | embeddable link / other link / new-tab link | AC-7 | Unit test of the link decision; observation |
| FR-7 | D-2 | no capture / command refused / task opens in view | AC-8 | Existing capture-gate tests extended; observation |
| FR-8 | CTX-2 4a, 4b | stays signed in / cookie read by script / expiry | AC-10 | Manual run against an `authenticated` server |
| FR-9 | D-10 | header kept / provider unchanged / origin changed | AC-13 | Unit test of the rule builder; end-to-end check of response headers with a stand-in Paperclip page |

## Readiness

Current implementation supplement: `verify/fix-all-cycle.md` records eager frame loading after a
running-server/host-grant check, in contrast to the original FR-2 first-shown wording. REQ-6 uses
the layered variant in `REQ-6-design.md` with switching fallback. Original FR/AC text is preserved;
no fresh runtime or completion pass is implied by this source reconciliation.

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
The layered fused implementation and its switching fallback are recorded in `REQ-6-design.md`;
the earlier clipping technique did not pass practical scrolling. Current eager-loading and formal
spec differences remain explicit in `verify/fix-all-cycle.md`. Real provider delivery and real
launchd registration are not claimed.
See `verify/implementation-checkpoint.md`, the final validation report and independent review
reports for concrete source and evidence. Historical authored-plan review remains at
`verify/artifacts/plan-review.md`.

## Changelog

| Date | Change |
|---|---|
| 2026-11-13 | Initial specify |
| 2026-11-13 | Persistent direct-child application frame, runtime extension-ID allowlist, validated route messages and security-header exclusions are prepared. Actual authenticated frame, navigation, websocket/service-worker and layout proof remains pending. |
