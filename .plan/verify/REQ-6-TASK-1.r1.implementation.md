# REQ-6 / TASK-1 — implementation report, round 1 (fused mode, layered variant)

- Author (implementer session): `impl-req6-fused-20261114`
- Date: 2026-11-14
- Status: **BLOCKED** (one owned scenario needs a file outside the allowed scope; see Concerns C-1). Everything else is implemented and its automated checks pass. Browser-only acceptance has not been run.
- Contract: `.plan/reqs/REQ-6-threadkeeper-entries-in-paperclips-sidebar.md` (FR/AC), `.plan/reqs/REQ-6-design.md` (layered variant, contract additions), spike reference `.plan/verify/req6-spike/v2/ext/host.js` and `pages/frame.js` (layer=1, notices=regions).
- Plugin references read: `references/execution.md`, `skills/plan-tdd/SKILL.md`, `references/tdd.md` (ultimate-sdd).

## Load gate (honest record)

`sdd.py gate --task REQ-6/TASK-1 --phase load` returned `ok:false` ("blocker REQ-5 is not done"), as the coordinator reported. This session did not re-run it and **does not claim a load-gate pass**. The work went ahead under the user's explicit instruction ("improve implementation significantly using the plan"), as repair and extension of an existing in-progress implementation. No status, INDEX, review ledger or `.plan/config.json` was changed.

## Files changed (complete inventory for this session)

Paperclip UI (`ui/`):

| File | Change |
|---|---|
| `ui/src/lib/threadkeeper-host.ts` | `ready.mode` (fused/switching from `fusedAvailable`), `announceMode()`, `reportSlot()` (validated and de-duplicated), `reportOverlay()` (regions validated, max 8), inbound `overlay-query` and `command:palette`, `fusedPagesAvailable()`, `threadkeeperSlotView()` |
| `ui/src/lib/threadkeeper-host.test.ts` | +6 tests (describe "Threadkeeper fused mode (REQ-6)") |
| `ui/src/lib/threadkeeper-host-slot.ts` | **new**: slot registry, reporter (ResizeObserver, window resize, `dark`-class observer), `data-threadkeeper-slot` and `--tk-slot-*` on `<html>` |
| `ui/src/lib/threadkeeper-host-slot.test.ts` | **new**, 3 tests |
| `ui/src/lib/threadkeeper-host-fusion.ts` | **new**: wires reporter and overlay observer to the host; `openPaperclipPalette` (the same synthetic Cmd+K that `Layout.openSearch` dispatches) |
| `ui/src/lib/threadkeeper-host-fusion.test.ts` | **new**, 3 tests |
| `ui/src/lib/threadkeeper-overlays.ts` | **new**: one MutationObserver on `document.body`; blocking = anything portalled outside `#root` (hidden, inert, empty, script and custom elements ignored) plus open dialog/alertdialog/aria-modal/Radix popper inside the root; notices = `[data-threadkeeper-notice]` rects, max 8 |
| `ui/src/lib/threadkeeper-overlays.test.ts` | **new**, 7 tests (includes the real `ToastViewport`) |
| `ui/src/components/ThreadkeeperHostBridge.tsx` | contributions query (fused only when browser-sessions provides all three pages), fusion wiring, refresh after handshake, re-announce on availability change |
| `ui/src/components/ToastViewport.tsx` | `data-threadkeeper-notice` on each toast item |
| `ui/src/pages/PluginPage.tsx` | verified host + browser-sessions route → transparent `ThreadkeeperSlot` instead of the plugin page body; breadcrumb = page name |
| `ui/src/pages/PluginPage.test.tsx` | +3 tests (describe "Threadkeeper fused slot (REQ-6)") |
| `ui/src/index.css` | fused-mode CSS: transparent `html`/`body`/app shell; app-shell `::before` repaints `--background` with an evenodd hole at `--tk-slot-*`; `#main-content:has(.threadkeeper-slot)` padding 0 / overflow hidden; `.threadkeeper-slot` absolute inset 0 |

Shell (`extension/`):

| File | Change |
|---|---|
| `extension/src/core/paperclip/host.ts` | parse `ready.mode`, `slot` (finite, positive, inside bounds with 1 px tolerance, else `null` = ignored; `session-board`→`dashboard`; scheme), `overlay` (boolean `open`, valid regions, max 8) |
| `extension/src/entrypoints/manager/PaperclipView.tsx` | validates slots against the frame's own viewport, translates them to shell coordinates, sets iframe `style.colorScheme`; `controlRef` (post/focus/frame); `eager` |
| `extension/src/entrypoints/manager/PaperclipFusion.ts` | **new**: `fusionReducer` (2 s slot deadline, offline, queried), `overlayIsStale` (60 s), `noticeClipPath`, `fusedRoute`, `usePaperclipFusionDom` (Cmd/Ctrl+K, focus return, stale-overlay query, notice holes on rail, banners, visible views and `iframe.tk-frame`) |
| `extension/src/entrypoints/manager/App.tsx` | fusion state, slot→view sync, shell view→Paperclip navigation, `pc` tracking, `data-fused` / `data-fused-raised`, `.tk-shell` placed at the rect, `Rail fused`, `PaperclipView active/eager/controlRef`; **coordinator addition**: `usePaperclipConnection(..., view === 'paperclip' \|\| fusion.engaged)` (App.tsx:336) |
| `extension/src/entrypoints/manager/shell/Rail.tsx` | `fused` prop: no view switch (segmented control or icon list); sessions, Threads nav, Paperclip status, accounts and Settings stay |
| `extension/src/entrypoints/manager/styles/10-shell.css` | fused layers: frame fixed inset 0 at z 1 (raised 50), views/banners z 2, shell absolute, rail hidden on Paperclip pages |
| `extension/tests/unit/paperclip-host.test.ts` | ready expectation now `{type:'ready', mode:'switching'}` (additive contract), +6 tests |
| `extension/tests/unit/paperclip-view.test.tsx` | +3 tests |
| `extension/tests/unit/paperclip-fused.test.tsx` | **new**, 14 tests (6 pure + 8 on the real `<App />`) |

Report: `.plan/verify/REQ-6-TASK-1.r1.implementation.md` (this file).

Not changed (allowed, not needed): `ui/src/components/Layout.tsx`, `ui/src/lib/threadkeeper-host-state.ts`, `extension/scripts/run-paperclip-e2e.mjs`. No file outside the allowed list was edited. The plugin package, `extension/src/core/paperclip/*` other than `host.ts`, `background.ts`, `lifecycle.ts` and `PaperclipConnection.tsx` were read only.

## AC evidence

RUNTIME-ONLY means a visible or browser-level property that jsdom cannot certify. It is **not** a pass.

| AC | Code | Test / check | Actual result |
|---|---|---|---|
| AC-1 | plugin manifest `packages/plugins/plugin-browser-sessions/src/manifest.ts:37-40` (other owner, **inspected only**) | none in this session | not verified here; RUNTIME-ONLY (sidebar entries in the window) |
| AC-2 | `ui/src/pages/PluginPage.tsx:132,189` (slot only for the verified host); copy lives in the plugin's `ExtensionView` (inspected, unchanged) | `PluginPage.test.tsx` "keeps the plugin page outside a verified Threadkeeper window" | pass (plugin page mounts, no slot). The exact visible text is RUNTIME-ONLY |
| AC-3 | `App.tsx:1215` (shell placed; sections never remount); `PaperclipFusion.ts` | `paperclip-fused.test.tsx` "lays the same mounted Threads view…", "follows Paperclip pages without remounting views…" | pass: same `.tk-view-threads` / `.tk-view-browse` nodes across Paperclip pages. "No embedded document request" is RUNTIME-ONLY (network panel) |
| AC-4 | `App.tsx:1191-1192` (`data-fused-raised`), `10-shell.css` z 50, `usePaperclipFusionDom` focus return | "raises Paperclip for a blocking overlay…"; ui overlay tests | pass (raise on open, lower on close, focus returned). Palette fully visible, accepts typing, row click after Escape: RUNTIME-ONLY |
| AC-5 | `ToastViewport.tsx:46`, `threadkeeper-overlays.ts`, `PaperclipFusion.ts:58` (`noticeClipPath`) | "cuts a notice out of the view…"; overlays "finds Paperclip's real toast items as notices" | pass (hole polygon applied and cleared, frame not raised). Visible and clickable: RUNTIME-ONLY |
| AC-6 | `PaperclipFusion.ts:108` (handler; defers when `defaultPrevented`); ui `onPalette` → `openPaperclipPalette` | "…opens its palette with Command+K from the view…" (focus in the Threads search field); fusion-test "opens the existing command palette…" | partial pass. **Focus on a Threads list row: BLOCKED** (C-1). Provider text field negative: by construction (keys inside a provider iframe never reach the shell); RUNTIME-ONLY |
| AC-7 | `Rail.tsx:149`, `App.tsx:1218` | "lays the same mounted Threads view…" asserts no `radiogroup[aria-label=View]`, no `nav[aria-label=Views]`, and that `.tk-rail-scroll`, `Settings` and `Add account` are inside `.tk-shell` | pass (component level). Whole-window inspection: RUNTIME-ONLY |
| AC-8 | `App.tsx` (`fused = engaged && running`; offline effect), `fusionReducer` `offline`/`ready` | "shows the shell rail with Threads still mounted when the server stops, and fuses again on ready" (health fetch stubbed down then up; real 5 s lifecycle poll) | pass in jsdom; real server stop and restart: RUNTIME-ONLY |
| AC-9 | `App.tsx:1215`, `PaperclipView.tsx` translation, ui `threadkeeper-host-slot.ts` (RO + resize) | App test asserts left/top/width/height = reported rect; slot-reporter "reports again when the rectangle, the window or the color scheme changes" | pass (exact in jsdom). Real resize within 1 CSS px: RUNTIME-ONLY |
| AC-10 | none (premise) | inspected `REQ-6-design.md` | not applicable as written: the design records all five spike checks passing for the layered variant (the D-3 clip technique failed the extra scroll check). Q-3 is still `[assumed]` (C-4) |
| AC-11 | `host.ts:30,68` | host "ignores rectangles outside the window…", "allows one CSS pixel…"; App "ignores a rectangle outside the window and keeps the placement (AC-11)"; view "drops a bad one" | pass |

## TDD (actual runs)

Argv prefix: `export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"`. ui cwd `/Users/andrew/dev/threadkeeper/paperclip/ui`; extension cwd `/Users/andrew/dev/threadkeeper/paperclip/extension`. Logs are in `/tmp/req6-tdd/*.log`, outside the repo and ephemeral; the relevant output is quoted here.

| # | Behaviour | RED (argv → exit, observed) | GREEN (exit, observed) | Refactor |
|---|---|---|---|---|
| U1 | ready mode + re-announce | `npx vitest run src/lib/threadkeeper-host.test.ts` → 1; `host.announceMode is not a function`, `fusedPagesAvailable is not a function` | 0; 8 passed | no change, small and local |
| U2 | slot report, de-dup, clear | same → 1; `host.reportSlot is not a function` | 0; 9 passed | none |
| U3 | overlay-query / palette from verified parent only | same → 1; `expected false to be true` | 0; 10 passed | none |
| U4 | overlay report, regions ≤ 8 | same → 1; `host.reportOverlay is not a function` | 0; 11 passed | none |
| U5 | body overlay observer | `npx vitest run src/lib/threadkeeper-overlays.test.ts` → 1; module did not resolve (new module) | 0; 6 passed | none |
| U6 | toasts are notices | same → 1; `expected to have a length of 1 but got +0` | 0 (+ToastViewport.test); 9 passed | none |
| U7 | slot registry and reporter | `npx vitest run src/lib/threadkeeper-host-slot.test.ts` → 1; module did not resolve | first green run: 1 failure from a test-fixture defect (second element never attached); fixture fixed, assertion unchanged → 0; 3 passed | none |
| U8 | PluginPage slot | `npx vitest run src/pages/PluginPage.test.tsx` → 1; `expected undefined to be 'session-board'` (the 2 guard tests passed: characterization) | first run 1: `currentThreadkeeperSlot()` leaked its internal token (real defect, fixed in production code) → 0; 9 passed | none |
| U9 | fusion wiring | `npx vitest run src/lib/threadkeeper-host-fusion.test.ts` → 1; module did not resolve | 0; 3 passed | none |
| E1 | ready.mode parse | `npx vitest run tests/unit/paperclip-host.test.ts` → 1; `expected { type: 'ready' } to deeply equal {…mode…}` | 0; 13 passed (with view tests) | none |
| E2 | slot parse + bounds (AC-11) | same → 1; `expected null to deeply equal { type: 'slot'…}` (the "ignores" cases passed trivially before the parser existed and still pass after) | 0; 8 passed | none |
| E3 | overlay parse | same → 1; `expected null to match object { type: 'overlay'…}` | 0; 9 passed | none |
| E4 | PaperclipView slot translation, scheme, control, eager | `npx vitest run tests/unit/paperclip-view.test.tsx` → 1; 3 failed as expected | 0; 20 passed (with host) | none |
| E5 | fusion reducer, holes, routes | `npx vitest run tests/unit/paperclip-fused.test.tsx` → 1; module did not resolve. One meaningless line in my new test (a state passed in as an action) was replaced before GREEN with the intended assertion | 0; 6 passed | none |
| E6 | App integration (Rail `fused`, App wiring, CSS) | **Provenance gap:** Rail/App/CSS wiring was written before its App-level tests. First run: 7 failures, all from my test-fixture errors (name clash, shorthand rename, spread of the wrong rect), plus 1 **real defect**: `pc` not updated for the route that arrives before engagement (`expected '/ACME/issues' to be '/ACME/threads'`), fixed at App.tsx:1163 | 0; 14 passed | none |

Test adjustments were transparent and none weakened an AC. Rail Settings is matched by aria-label or visible text (expanded rail shows text). The AC-8 style check asserts `left`/`width` are empty (React leaves an empty `style` attribute). The Cmd+K positive test focuses the view's search field because of C-1. That limitation is recorded, not hidden.

## Checks

Run:

| Argv (cwd) | Exit | Result |
|---|---|---|
| `npx tsc --noEmit` (ui) | 0 | clean |
| `npx vitest run` with 13 related ui files (threadkeeper-host, -boot-channel, -host-slot, -host-fusion, overlays, PluginPage, CompanySettingsPluginPage, ToastViewport, CommandPalette, Layout, App.activity-routing, AttentionQueueRow, LiveUpdatesProvider.recovery) (ui) | 0 | 13 files, 182 tests passed |
| `npx tsc --noEmit` (extension) | 0 | clean |
| `npx vitest run tests/unit/manager-app.test.tsx tests/unit/rail.test.tsx tests/unit/threads-view.test.tsx tests/unit/paperclip-*.tsx …` (extension) | 0 | 8 files, 151 passed; the switching-mode DOM snapshots are unchanged |
| `npx vitest run` full suite (extension) | **1** | 104 files: 101 passed, 3 failed (`backup.test.ts` 5 s timeout, `paperclip-sync.test.ts` 5 s timeout, `paperclip-bridge.test.ts` fingerprint REQ-10 F15) |
| `npx vitest run tests/unit/backup.test.ts tests/unit/paperclip-bridge.test.ts tests/unit/paperclip-sync.test.ts` (extension) | 0 | 38 passed in isolation. None imports a file changed here; likely load-sensitive. The full run is still recorded as failed |
| `TK_OUT_DIR=/tmp/tk-fused-build node scripts/build-extension.mjs` (extension) | 0 | built to `/tmp/tk-fused-build`; `manager.css` contains the fused rules |

Not run: the full Paperclip suite (`pnpm test:run`), the root `pnpm typecheck`, any e2e, and any Edge or Chrome observation. `run-paperclip-e2e.mjs` was **not** extended: a `pc-fused` case needs a running Paperclip server and browser profile, which this brief does not let me start.

## Concerns

- **C-1 (Major, blocks AC-6 row case):** `extension/src/entrypoints/manager/hooks/useWorkbenchKeyboard.ts:95` handles `j`/`k` in window capture without checking modifiers. With focus on a Threads row it calls `preventDefault` on Cmd+K, so the fused handler correctly defers (FR-4 edge) and the palette does not open. Proposed one-line fix, outside the allowed scope: `if (!isEditing && !e.metaKey && !e.ctrlKey && (e.key === 'j' || e.key === 'k'))`. Next action: the coordinator authorizes that file, or settles the key-conflict list in design.
- **C-2 (Minor):** `FrameStage` re-measures on resize, scroll and transitions. A pure move of the placed shell with no size change would leave provider iframes offset until the next measure. Most rect changes also change size. Runtime check needed.
- **C-3 (Minor):** Paperclip's mobile layout (narrow window) gives `#main-content` no definite height, so the slot can measure as empty and the last placement is kept. Not handled.
- **C-4 (Decision):** the layered variant follows `REQ-6-design.md`, where Q-3 is still `[assumed]` (no founder answer). The `UI Layout` items "Loading: page background until positioned" and "not responding after 2 s" are not implemented in fused mode.
- **C-5 (Minor):** while a notice hole is present, clip-path on the glass rail may change its blur. Runtime visual check needed.
- `hostEnabled` now loads the Paperclip frame eagerly while the server runs, which is how fused mode becomes the window. This is an observable startup change; review it.
- Required next steps: run the runtime ACs in a separate Edge/Chrome profile on `/tmp/tk-fused-build`, then fresh independent spec review, then quality review, then the complete gate. None is claimed here.

---

## Round 2 — repair after spec review r1 (`.plan/verify/REQ-6-TASK-1.r1.spec.md`, FAIL: F-1, F-2, F-3 Major)

- Author: `impl-req6-fused-20261114`.
- Scope additions granted by the coordinator:
  - `extension/src/entrypoints/manager/hooks/useWorkbenchKeyboard.ts`. The coordinator authored its line-96 modifier guard. I did not change it; it was only mutated temporarily and restored byte-identical (see F-3).
  - One manifest test under `packages/plugins/plugin-browser-sessions/tests/`.
- Round-2 status: **READY_FOR_REVIEW**. C-1 is resolved by the coordinator's edit, now covered by tests. All three Majors are repaired, each with a failing test first or explicit alternative proof. Browser-only properties remain RUNTIME-ONLY. No load-gate pass is claimed.

### Contract addition (shell → page)

`{ source: "threadkeeper-shell", v: 1, type: "placed", view: "browse" | "threads" | "session-board" | null }`
- The shell sends it after it has laid a view over the reported rectangle, or `null` on a Paperclip page.
- The page sets `data-threadkeeper-slot` (and so its transparency) only for the acknowledged view. Until then the content rectangle shows Paperclip's page background (REQ UI Layout "Loading").
- The acknowledgement resets on every page `ready` (hello or mode change) and on every new slot element.

### Files changed in round 2

- `ui/src/lib/threadkeeper-host.ts`: `announceMode` clears `lastSlot`; inbound `placed` → `onPlaced`.
- `ui/src/lib/threadkeeper-host-slot.ts`: `acknowledge(view)`; transparency only when it matches; reset on a new slot element.
- `ui/src/lib/threadkeeper-host-fusion.ts`: `announceMode()` (ready, then slot, then overlay); `placed()`; `refresh()` drops the acknowledgement.
- `ui/src/components/ThreadkeeperHostBridge.tsx`: mode change goes through `fusion.announceMode()`; `onPlaced` wired.
- `ui/src/pages/PluginPage.tsx`: the slot dispatches `paperclip:threadkeeper-open-view` (`session-board` → `dashboard`) after registering.
- `extension/src/entrypoints/manager/App.tsx`: posts `placed` after each engaged placement.
- Tests:
  - `ui/src/lib/threadkeeper-host.test.ts` (+2)
  - `ui/src/lib/threadkeeper-host-slot.test.ts` (1 expectation updated to the new acknowledgement contract, +1)
  - `ui/src/lib/threadkeeper-host-fusion.test.ts` (+2)
  - `ui/src/pages/PluginPage.test.tsx` (open-view assertion added)
  - `extension/tests/unit/paperclip-fused.test.tsx` (+5, stale comment fixed)
  - `packages/plugins/plugin-browser-sessions/tests/manifest.spec.ts` (**new**)
- Report: this section appended. Nothing else in `.plan` was touched.

### TDD (round 2)

Logs are in `/tmp/req6-r2/*.log`, outside the repo and ephemeral.

| Finding / behaviour | RED (argv → exit, observed) | GREEN | Refactor |
|---|---|---|---|
| F-1a: same slot re-sent after a mode change | `npx vitest run src/lib/threadkeeper-host.test.ts` (ui) → 1; `expected false to be true` (slot deduplicated) | 0; 12 passed | none |
| F-1b: bridge path re-sends ready, then slot, then overlay | `npx vitest run src/lib/threadkeeper-host-fusion.test.ts` → 1; `fusion.announceMode is not a function` | 0; 4 passed | none |
| F-1c: shell restarts the 2 s window on each ready (switching → fused order) | characterization: the reducer already did this (`npx vitest run tests/unit/paperclip-fused.test.tsx -t "restarts the 2 s window"` → 0, 1 passed); no code change | — | — |
| F-2a: page accepts `placed` from the verified parent only | host test → 1; `expected false to be true` | 0; 13 passed | none |
| F-2b: transparency only after the acknowledgement | `npx vitest run src/lib/threadkeeper-host-slot.test.ts` → 1; `expected true to be false`, `reporter.acknowledge is not a function` | 0; 4 passed | none |
| F-2c: fusion routes `placed`; a new ready drops it | fusion test → 1; `fusion.placed is not a function` | 0; 9 passed (with slot) | none |
| F-2d: the slot requests its view (a non-engaged shell switches) | `npx vitest run src/pages/PluginPage.test.tsx` → 1; `expected [] to deeply equal [ { view: 'dashboard' } ]` | 0; 6 passed | none |
| F-2e: shell posts `placed` per placement (`threads`, `null`, `session-board`) | `npx vitest run tests/unit/paperclip-fused.test.tsx` (extension) → 1; `expected [] to deeply equal [ { …(4) } ]`. The companion "switches views without engaging…" fallback test passed: characterization of existing shell behaviour | 0; 17 passed | none |
| F-3: Cmd+K and Ctrl+K on a `.tk-row-btn` post the palette and keep the selection; plain j/k still move rows | The fix was already applied by the coordinator, so no fresh RED was possible without reverting another author's work. **Alternative proof:** (1) the round-1 run before the fix failed this scenario with focus on a row: `expected [] to deep equally contain { … 'palette' }` (`/tmp/req6-r2/f3-prior-red.log`, a copy of `/tmp/req6-tdd/e6-first.log`); (2) mutation check: temporarily removed `!e.metaKey && !e.ctrlKey && !e.altKey` → `-t "thread row\|plain j and k"` exit 1, the row test failed with the same message and the j/k test passed; the file was restored and `cmp` reported it identical | 0; 19 passed | stale comment fixed |
| AC-1 manifest (minor) | characterization (existing manifest): `npx vitest run tests/manifest.spec.ts` (plugin) → 0, 2 passed | — | — |

### Checks (round 2, all run after the final edit)

| Argv (cwd) | Exit | Result |
|---|---|---|
| `npx tsc --noEmit` (ui) | 0 | clean |
| `npx tsc --noEmit` (extension) | 0 | clean |
| `npx tsc --noEmit -p tsconfig.test.json` (plugin-browser-sessions) | 0 | clean |
| `npx vitest run` full suite (extension) | 0 | **104 files, 1,921 tests passed** (this run had none of the load-sensitive failures seen in round 1) |
| `npx vitest run` with the 13 related ui files (same list as round 1) (ui) | 0 | 13 files, 187 passed |
| `npx vitest run` (plugin-browser-sessions) | 0 | 4 files, 91 passed |
| `TK_OUT_DIR=/tmp/tk-fused-build node scripts/build-extension.mjs` (extension) | 0 | build `20261114.204732-79589c00e9`; `placed` present in `manager.js` |

Not run: full Paperclip suite, root `pnpm typecheck`, e2e (`run-paperclip-e2e.mjs` unchanged), Edge/Chrome.

### AC deltas from round 1

- **AC-1:** manifest test passes (routes `browse`, `threads`, `session-board`; labels; `SessionSidebar` slot; capabilities). Placement in the "Work" section and the active highlight are RUNTIME-ONLY. The spec reviewer's F-6 note stands: one sidebar slot renders three links, not three sidebar slots.
- **AC-3, AC-7, AC-9:** fused mode now engages under the reviewed boot order (F-1). The blank-slot fallback is gone (F-2).
- **AC-6:** the positive case with focus on a Threads row passes (Cmd+K and Ctrl+K; selection unchanged). j/k row navigation is preserved. The provider-field negative is RUNTIME-ONLY.

### Remaining concerns

- Minor findings from the spec review that are not addressed in this round:
  - F-4: the REQ changelog / HANDOFF record of the layered decision and Q-3 (coordinator).
  - F-5: overlay observer false positives; frame stays raised if Paperclip never answers.
  - F-6 items C-2, C-3, C-5: runtime checks; the "not responding" text is not built.
- The ack-gated transparency means a brief opaque content rectangle until the shell posts `placed`. The shell's view sits above the frame, so this should not be visible once placed. RUNTIME-ONLY.
- Next action: fresh independent spec review of round 2, then quality review, then runtime ACs in a separate browser profile on `/tmp/tk-fused-build`, then the complete gate.

---

## Round 3 — repair after the real-browser run (rounds 17/18) and cumulative quality r2

- Author: `impl-req6-fused-20261114`.
- Inputs:
  - Coordinator's round-3 brief.
  - Real-browser evidence `.acceptances/paperclip-merge/round-17`, `round-18`: 7 case groups passed, 2 failed, one root cause.
  - Runner `extension/scripts/run-paperclip-fused-e2e.mjs`: read only, not edited, not run by me.
  - `.plan/verify/repairs.r2.cumulative-quality.md`: F-1, F-4.
- Round-3 status: **READY_FOR_REVIEW**. All four items are fixed, each starting from a failing test. Browser-only properties remain RUNTIME-ONLY until the coordinator re-runs the e2e. No load-gate pass is claimed.

### Fixes

1. **Boot channel dropped `placed`, `command:palette` and `overlay-query`** (`ui/src/lib/threadkeeper-host.ts`, `createThreadkeeperBootChannel`).
   - Once an authenticated `hello` has been seen, every other `threadkeeper-shell` v1 message from that same origin and parent is forwarded to the attached consumer. The host still validates each type and payload.
   - Unchanged: the origin and source checks, buffering of `hello`, and buffering of the latest valid `navigate` only. Nothing else is buffered before the bridge attaches.
   - My earlier unit tests called `host.handleMessage` directly, which is why they missed this.
2. **Quality F-1: `placed` not re-sent under batching** (`PaperclipFusion.ts`, `App.tsx`).
   - New `slotSeq` in the reducer, bumped for each new placement (engagement or view change, including through `null`). It is kept across `ready` and `offline`.
   - A resize of the same placement does not bump it, so `placed` is not re-posted every frame.
   - The `placed` effect depends on `[fused, fusion.slotSeq]`.
3. **Quality F-4: overlay cost.**
   - `threadkeeper-overlays.ts`: mutations, `transitionend` and `resize` are coalesced to one scan per animation frame (injectable `schedule`, `requestAnimationFrame` by default). `read()` stays a synchronous fresh reading.
   - `threadkeeper-host-fusion.ts`: the body observer starts only when the last announced `ready` was `fused` (host `mode()`), and stops on a switch back or on dispose. `overlay-query` is still answered with a fresh one-off reading.
   - `PaperclipFusion.ts`: the notice clip effect now depends on `[fused, regions, overlayOpen, rect, slotView]` and re-applies on window `resize` while notices exist.
4. **Observation (plain `?view=threads` never fused): confirmed defect against REQ-6 FR-6.**
   - Cause: Settings "Connect" stores only `serverUrl`. The frame loaded eagerly only when `paperclip.hostEnabled` was true, and that is set only by visiting the Paperclip view. Yet `running` already requires the origin's host permission (`lifecycle.ts:146`).
   - Fix (`App.tsx`): `PaperclipView` is always `eager` on the page surface, so it loads whenever the configured Paperclip is `running`. `hostEnabled` is also persisted while fused (not only on the Paperclip view), so the host grant is kept as the `PaperclipSettings.hostEnabled` doc comment describes.
   - Behaviour change to review: once Paperclip is connected and running, opening the manager on any view hands the window to Paperclip's sidebar. That is FR-6's intent.

### Files changed in round 3

- `ui/src/lib/threadkeeper-host.ts`: boot-channel forwarding; host `mode()`.
- `ui/src/lib/threadkeeper-overlays.ts`: rAF coalescing, `schedule` option, disposal guard.
- `ui/src/lib/threadkeeper-host-fusion.ts`: lazy observer, `schedule` pass-through, `freshOverlays`.
- `extension/src/entrypoints/manager/PaperclipFusion.ts`: `slotSeq`; clip effect dependencies plus resize listener.
- `extension/src/entrypoints/manager/App.tsx`: `placed` effect on `slotSeq`; `eager`; `hostEnabled` persisted while fused.
- Tests:
  - `ui/src/lib/threadkeeper-host-bridge.test.ts` — **new**: the real `ThreadkeeperHostBridge` under `MemoryRouter` + `QueryClientProvider`, framed by a fake parent, messages dispatched on `window`.
  - `ui/src/lib/threadkeeper-overlays.test.ts`: +1; the existing change-detection test now passes a synchronous `schedule`.
  - `ui/src/lib/threadkeeper-host-fusion.test.ts`: +1; setup gains `mode` and synchronous `schedule`; the forwarding test calls `refresh()` (the fused ready) first, per the new lazy-start contract.
  - `extension/tests/unit/paperclip-fused.test.tsx`: +4; `mountFused` accepts `hostEnabled` and an address.
- Report: this section appended. Nothing else in `.plan` was touched.

### TDD (round 3)

Logs are in `/tmp/req6-r3/*.log`, outside the repo and ephemeral.

| Item | RED (argv → exit, observed) | GREEN | Refactor |
|---|---|---|---|
| 1. bridge + boot channel deliver placed, palette, overlay-query | `npx vitest run src/lib/threadkeeper-host-bridge.test.ts` (ui) → 1; `expected null to be 'threads'` (`ready` reached the shell; `placed` was dropped, the same symptom as the browser run). The companion refusal test (wrong origin, wrong source, before hello) passed: the checks were already right | with the boot-channel and host tests → 0; 19 passed | none |
| 2. batched ready+slot / slot null+slot view | `npx vitest run tests/unit/paperclip-fused.test.tsx` (extension) → 1; App: `expected 1 to be 2` (no second `placed`); reducer: `slotSeq` undefined | 0; 21 passed. My own just-written reducer test was narrowed before GREEN to "count placements, not resizes", to avoid per-frame `placed` | the `placed` comment moved onto the effect line |
| 3a. one scan per frame | `npx vitest run src/lib/threadkeeper-overlays.test.ts` → 1; `onChange` called before the frame | 0; 8 passed | none |
| 3b. observer only after a fused ready | `npx vitest run src/lib/threadkeeper-host-fusion.test.ts` → 1; reported while unannounced / switching | 0; 29 passed (fusion + bridge + host + overlays) | none |
| 3c. holes follow a window resize | `… paperclip-fused.test.tsx -t "notice holes when the window"` → 1; clip path still at the old offset | 0; 22 passed | none |
| 4. plain `?view=threads` fuses when running; grant persisted | `… -t "plain Threads entry"` → 1; `timed out waiting for eager Paperclip frame` (the observation reproduced) | with `manager-app` and `paperclip-view` → 0; 78 passed (switching-mode DOM snapshots unchanged) | none |

### Checks (all run after the final edit)

| Argv (cwd) | Exit | Result |
|---|---|---|
| `npx tsc --noEmit` (ui) | 0 | clean |
| `npx tsc --noEmit` (extension) | 0 | clean |
| `npx vitest run` full suite (extension) | 0 | **104 files, 1,940 tests passed** |
| `npx vitest run` with the 14 related ui files (round-2 list + `threadkeeper-host-bridge.test.ts`) (ui) | 0 | 14 files, 191 passed |
| `TK_OUT_DIR=/tmp/tk-fused-build node scripts/build-extension.mjs` (extension) | 0 | build `20261115.002026-79589c00e9` |

Not run:
- The plugin suite: unchanged since round 2, when it was 4 files, 91 passed.
- The full Paperclip suite and the root `pnpm typecheck`.
- **The real-browser e2e.** Its round-17/18 failures must be re-checked by the coordinator. The Paperclip UI changes (boot channel, overlays, fusion) reach the browser only after the Paperclip server's UI is rebuilt or restarted; the extension build above does not include them.

### Remaining

- Cumulative-quality Minors F-2, F-3, F-5, F-6 and F-7 belong to other owners.
- Spec-review Minors F-4 to F-6 (decision records; runtime C-2, C-3, C-5) are unchanged.
- Next: the coordinator re-runs the fused e2e on the rebuilt extension and Paperclip UI, then fresh reviews and the complete gate.
