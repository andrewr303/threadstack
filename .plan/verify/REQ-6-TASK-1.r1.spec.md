# Review: REQ-6/TASK-1 (spec, task scope)

- Stage: spec. Scope: task.
- Task: REQ-6/TASK-1.
- Author: `impl-req6-fused-20261114`, plus the coordinator's one-line edit to `useWorkbenchKeyboard.ts:96`.
- Reviewer: `spec-review-req6-r1-20261114`.
- Round: 1 of the configured cap of 3.
- Evidence destination: `.plan/verify/REQ-6-TASK-1.r1.spec.md`, to be written by the coordinator.
- Reviewed files (read in full or in the relevant parts):
  - `ui/src/lib/threadkeeper-host.ts`, `threadkeeper-host-slot.ts`, `threadkeeper-host-fusion.ts`, `threadkeeper-overlays.ts`, and their tests (host, slot, fusion, overlays)
  - `ui/src/components/ThreadkeeperHostBridge.tsx`, `ToastViewport.tsx`
  - `ui/src/pages/PluginPage.tsx` and its test (first 60 lines only)
  - `ui/src/index.css` (fused block, lines 5757-5794)
  - `extension/src/core/paperclip/host.ts`
  - `extension/src/entrypoints/manager/PaperclipView.tsx`, `PaperclipFusion.ts`, `App.tsx` (fusion parts)
  - `extension/src/entrypoints/manager/shell/Rail.tsx`
  - `extension/src/entrypoints/manager/styles/10-shell.css` (fused block)
  - `extension/src/entrypoints/manager/hooks/useWorkbenchKeyboard.ts`
  - `extension/tests/unit/paperclip-fused.test.tsx`
  - Not read in full: `paperclip-host.test.ts` and `paperclip-view.test.tsx`. I used only the test titles of `paperclip-view.test.tsx` and a few `paperclip-host.test.ts` lines surfaced by grep.
  - Also read for context: `packages/plugins/plugin-browser-sessions/src/ui/index.tsx` and `src/manifest.ts`.

## Contract and evidence

"Inspected" means I read the source and tests; I did not execute them.

| AC / scenario | Expected | Actual (file:line / test) | Verdict |
|---|---|---|---|
| AC-1 / FR-1 positive, negative | Three entries in the "Work" section, linking to `/<co>/browse`, `/threads`, `/session-board` | The manifest has one `sidebar` slot ("Threadkeeper", `manifest.ts:38`). `SessionSidebar` (`index.tsx:80-83`) renders three plain links with no active highlight. There are three `page` slots (`manifest.ts:39-41`). No test. Placement in "Work" is assumed (D-6). | blocked: outside the changed scope and RUNTIME-ONLY. See F-6. |
| AC-2 / FR-1 edge | Heading, text and button copy outside the extension | `index.tsx:89` matches the three strings verbatim when `data-threadkeeper-host` is absent. `PluginPage.test` "keeps the plugin page outside a verified Threadkeeper window" shows the page mounts and no slot is created. | pass (inspected). Visible text is RUNTIME-ONLY. |
| AC-3 / FR-2 positive | Same view nodes, no reload | The `.tk-view-*` sections are never unmounted (`App.tsx:1235-1247`). Test "follows Paperclip pages without remounting views" asserts node identity. | pass in jsdom. Document requests and the sidebar staying visible are RUNTIME-ONLY. Reachability is limited by F-1/F-2. |
| AC-4 / FR-3 positive | Palette visible and typeable, then row click after Escape | Raise via `data-fused-raised` plus z 50 (`10-shell.css:887`). Focus return at `PaperclipFusion.ts:121-134`. Test "raises Paperclip…" covers raise, lower and focus return. | partial. State machine passes; visibility, typing and the click after Escape are RUNTIME-ONLY. |
| FR-3 negative (60 s) | Query after 60 s; restore if Paperclip reports none | `overlayIsStale` and the interval at `PaperclipFusion.ts:54,141-147`. Page answers at `host-fusion.ts:35`. Tests "flags an overlay…" and "asks Paperclip about an overlay open for 60 s…". | pass. If the page still reports open, or never answers, the frame stays raised (F-5). |
| AC-5 / FR-3 edge | Notice and its action clickable, view live beneath | `ToastViewport.tsx:46` marks each toast. `noticeClipPath` cuts holes (`PaperclipFusion.ts:58-71`). Tests "cuts a notice out…" and "finds Paperclip's real toast items…" (`open:false`). | pass in jsdom. Visible and clickable is RUNTIME-ONLY. |
| AC-6 / FR-4 positive | Command+K with focus in the Threads list opens the palette | Handler at `PaperclipFusion.ts:105-118`. The only positive test focuses the search field, not a list row (`paperclip-fused.test.tsx:236`). The coordinator edit (`useWorkbenchKeyboard.ts:96`) has no test. The switching-mode test at `:250-259` uses a row but asserts only an absence, so it would pass without the edit. The comment at `:232-233` is stale. | fail on evidence (F-3). Source looks correct. |
| AC-6 / FR-4 negative | Provider text field keeps the key | A key in a cross-origin iframe never reaches the shell window, so no handler runs. No test is possible in jsdom. | pass by construction. RUNTIME-ONLY. |
| FR-4 edge | Threadkeeper handler wins | `event.defaultPrevented` early return (`PaperclipFusion.ts:108`). No other Command/Control+K handler exists in `extension/src/entrypoints/manager`. | pass in source. The design never lists the conflicts (F-4). |
| AC-7 / FR-5 | One view switch; list, accounts and Settings inside the view | `Rail.tsx:149` draws no switch when `fused`. Test asserts no `radiogroup[aria-label=View]` or `nav[aria-label=Views]`, and finds `.tk-rail-scroll`, Settings and Add account inside `.tk-shell`. `isPage` gating leaves the side panel and overlay surface unchanged. | pass at component level. Whole-window check is RUNTIME-ONLY. |
| AC-8 / FR-6 | Rail returns on stop; fused resumes on ready | `fused = engaged && running` (`App.tsx:338`). The offline effect at `:345` keeps the last rect. A new `ready` resets and re-engages. Test "shows the shell rail with Threads still mounted…". The test replays `ready` and `slot` manually in a loop. | partial. It does not exercise the page's real re-send (F-1). |
| AC-9 / FR-2 edge | Edges within 1 px after a resize | Slot reporter uses ResizeObserver, window resize and the theme observer. Shell translates by the frame box and `clientLeft`. Tests assert exact values. | pass in jsdom. Real resize is RUNTIME-ONLY (C-2, C-3). |
| AC-10 / FR-7 | Stop and ask Q-3 if the spike fails | The design records spike check 3 as "not as written". Q-3 is `[assumed]`. | limitation (F-4) |
| AC-11 / FR-2 negative | Bad rectangle leaves placement unchanged | `host.ts:21-32,63-70`: finite and positive, within the frame viewport plus 1 px, otherwise dropped before dispatch. Page side `host.ts:20-22,149`. Tests "ignores rectangles outside the window…", "ignores a rectangle outside the window and keeps the placement". | pass |
| Origin and source checks | Reject wrong source or origin | Shell: `host.ts:46` requires `event.source === frameWindow` and `origin`. Page: `threadkeeper-host.ts:106,110,120` require the parent window, an allowed origin, `v:1`, and the handshake origin. Test covers `overlay-query` and `command` from a foreign origin or before hello. | pass |
| Fallback when not fused | Shell keeps switching | Reducer ignores `slot` unless `mode==='fused'` and enforces the 2 s deadline. Tests "keeps switching when…". | shell half passes. Page half is broken (F-2). |
| Notice and rail layers | Holes in rail, banners, views and provider frames | `PaperclipFusion.ts:156-157` | pass. Holes go stale if the shell moves with no re-render (Minor, with C-2). |

## Checks and applicability

- **Run by the coordinator (not re-run by me):**
  - extension `npx vitest run`: 1,915 passed, 1 timeout in `backup.test.ts`, which passes alone (7/7).
  - `tsc --noEmit` exit 0 for extension, ui and server.
- **Run by the author (inspected only):**
  - ui: 13 files, 182 passed; extension: 8 files, 151 passed.
  - Author's own full extension run had 3 failures, which passed in isolation.
  - The build to `/tmp/tk-fused-build` succeeded.
- **Inspected by me:** the sources and tests listed above, and the TDD table in the implementation report. It records red-then-green cycles per behaviour, and the E6 provenance gap (App wiring written before its tests) is disclosed honestly.
- **Not run or missing:**
  - No Edge/Chrome run of fused mode.
  - No e2e (no `pc-fused` case).
  - No Paperclip full suite.
  - No load gate.
  - No plugin manifest test.
- **Test for the coordinator's keyboard edit:** missing.
- **Independence:** I did not write this code. Recording the report does not prove who ran which log.

## Findings

| ID | Severity | Where | Expected / actual and impact | Violates | Bounded fix |
|---|---|---|---|---|---|
| F-1 | Major | `threadkeeper-host.ts:137-143` (`announceMode` does not clear `lastSlot`); `ThreadkeeperHostBridge.tsx:99`; `PaperclipFusion.ts:39-40,43`; `PaperclipFusion.ts:10` (SLOT_DEADLINE_MS) | The usual boot order is `hello` first, with `fused` still false because `uiContributions` has not loaded, so the page sends `ready(switching)` and a slot that the shell ignores. Contributions then load and the page re-sends `ready(fused)` only. The shell reducer resets `engaged=false` with a new `readyAt`. The page deduplicates the identical slot, so none follows. Any later slot arrives more than 2 s after `ready` and is dropped. Fused mode then stays off until a reload. The result is order-dependent, found by static trace and not executed. No test covers hello, then mode change, then slot. The host test only checks that `ready` is re-posted; `announceMode` is never checked for slot resend. | AC-3/4/7/9, FR-2, design "Fallback" | In `announceMode`, set `lastSlot = null` and have the bridge call `fusion.refresh()` after a mode change. Add a test (hello with `fusedAvailable` false, flip to true, `announceMode`, expect a new slot post). Consider restarting the 2 s window per `ready`. |
| F-2 | Major | `PluginPage.tsx:132,189`; `index.css:5761-5768`; `index.tsx:88` | `PluginPage` swaps in the transparent slot whenever the host is verified, without knowing whether the shell engaged. When the shell has not engaged (F-1, an older shell, or the 2 s fallback), the content rectangle is blank. `ExtensionView`, the only source of `open-view`, is not rendered, so the sidebar entry does nothing. The design says the shell then keeps view switching (`REQ-6-design.md:42-44`). It also paints a transparent hole before engagement instead of Paperclip's background (UI Layout "Loading"). | Design "Fallback"; FR-6 spirit; UI Layout "Loading" | `ThreadkeeperSlot` should also dispatch `paperclip:threadkeeper-open-view` for its view, so a non-engaged shell switches. Consider setting `data-threadkeeper-slot` (the transparency) only after the shell acknowledges the placement. |
| F-3 | Major | `paperclip-fused.test.tsx:232-257`; `useWorkbenchKeyboard.ts:96` | The literal AC-6 positive, Command+K with focus on a thread row, has no test. The coordinator's edit that makes it work is untested. The row test at `:250-259` passes with or without the edit. | AC-6, FR-4 | Add a fused-mode test: focus `.tk-row-btn`, dispatch Command+K, expect `command: palette` posted and the selection unchanged. Add a case showing plain `j`/`k` still move rows. Fix the stale comment. |
| F-4 | Minor | `REQ-6-design.md:16,46`; REQ changelog | Spike check 3 is "not as written", the design's Q-3 is `[assumed]`, and the REQ changelog does not record the layered decision. AC-10's premise is not literally met. Q-3's recorded default is switching. Proceeding was authorised by the user. It does not hide missing behaviour. | AC-10, FR-7 | The coordinator should record the layered decision and Q-3 status in the REQ changelog and `HANDOFF.md`. The FR-4 key-conflict list ("settled in design") is also absent from the design. |
| F-5 | Minor | `threadkeeper-overlays.ts:35-42,52` | False positives and negatives of the observer. Any non-custom, non-empty body child (for example an extension-injected `div`) counts as blocking. It also counts a tooltip, which raises the frame for its lifetime. The 60 s query re-reads the same state, so it cannot clear these. A hung Paperclip frame cannot answer, so the frame stays raised. Portals inside `#root`, apart from poppers and open dialogs, are missed. `IssueRowDetailsNotice` portals a `role=alert` to the body but is not mounted on Threadkeeper routes. Transparency does not leak, because the attribute is removed on leaving. It is not a requirement miss because the literal FR-3 negative is satisfied. | FR-3 | Optional: the shell lowers the frame after N unanswered queries. Runtime check with real extensions. |
| F-6 | Minor | `manifest.ts:38`; `index.tsx:80-83`; `10-shell.css` and `FrameStage`; C-2, C-3, C-5; UI Layout | Seven items:<br>1. AC-1 has no test, and FR-1 says "three sidebar slots" while one slot with three links ships (not highlighted).<br>2. **C-2 Minor:** `FrameStage` can leave provider frames offset after a pure move of the shell with no size change.<br>3. **C-3 Minor:** a narrow window can give an empty slot, so the last placement is kept; unhandled and stale.<br>4. **C-4:** the 2 s "Threadkeeper is not responding" text is not built. Minor: no AC or FR owns it, and the unembedded fallback is honest.<br>5. **C-5 Minor:** a clip-path hole may change the rail's blur.<br>6. Eager frame loading when `hostEnabled` is an observable startup change. It fits the design but is unrequested.<br>7. C-1 is resolved by the coordinator edit, subject to F-3. | AC-1; UI Layout | Add a manifest test. Runtime-check C-2, C-3 and C-5. Revisit C-4 only if the founder wants the text. |

## Limitations

- The load gate is `ok:false` (REQ-5 not done). This is a limitation, not a spec finding.
- All visual and browser properties are RUNTIME-ONLY: transparency, click-through, wheel scroll, flash, focus in a real iframe, notices and the real resize. No Edge/Chrome run was made.

## Verdict

**FAIL**
- The three Major findings must be fixed first.
  - F-1 and F-2: the fused entry path can silently fail, with the fallback leaving a blank page.
  - F-3: the AC-6 row case has no faithful test.
- Next action: the author fixes F-1 to F-3 with a failing test first. The author's changes then need a fresh spec review, followed by quality review.
