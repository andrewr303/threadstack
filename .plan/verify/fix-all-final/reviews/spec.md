# Independent spec supplement — fix-all cycle, review 2

Reviewer: `final_spec_review`, independent of the implementation authors. Captured 2026-11-15T04:51:18.743541+00:00. HEAD `258c14f8da4761932a6c2e7d7255e0c09cb1f7d7` plus the working source hashes below. This supplements `/tmp/tk-fix-all/final-spec-review.md`; it does not rewrite that earlier snapshot or any failed browser round.

## Verdict

**PASS for the new source deltas.** No concrete Blocker, Major, or Minor source defect was found in the task-link dialog, keyboard boundary, mobile host sizing, synchronous accepted closes, or narrowly scoped session-row handoff.

**Real-browser acceptance remains a separate pending input.** Chrome round 25's 0/4 immediate-click result demonstrated that accepted native close and parent DOM lowering alone do not prove compositor hit testing. The new handoff is a source-level repair for that remaining runtime seam; classifier/unit success is not evidence that a browser-native event actually reaches it. The owned fresh browser run must prove that and retain every attempt. Earlier failing rounds remain applicable historical failures, not passes.

**Full-plan completion is still incomplete.** The external/formal gate limits in the first report and `.plan/verify/fix-all-cycle.md` remain unchanged. This source supplement neither waives them nor certifies deployment, provider, helper/service or broad-suite behavior.

## Deltas assessed

| Delta | Assessment |
| --- | --- |
| Task links in the controls row | Full-page DetailPane now renders `PaperclipLinks compact` within the existing nowrap toolbar, preserving one row. The picker uses a native `dialog` portalled to `document.body`, outside the live-page header and overflow row. Existing imported references, founder link/unlink, task search and task navigation remain present. The dialog closes on thread/view navigation, imported-reference/task navigation and explicit Close/cancel; ordinary dismissal restores trigger focus. Sidepanel keeps the inline path. Tests exercise actual link/unlink commands and task paths as well as close/focus/navigation behavior. |
| Feature-owned dialog keyboard boundary | `useWorkbenchKeyboard` keeps the existing supplied innermost-first dialog order, then recognizes a focused/remaining native open dialog. Row/search shortcuts do not run behind it; Escape is spent on the dialog before selection/drawer/overlay handling. Existing popover priority is retained. Targeted tests use independently owned dialogs and separately prove registered ordering. This change does not inspect provider-frame documents or send provider input. |
| Mobile host height collapse | The CSS scopes a bounded flex chain to the mobile app shell that actually contains `.threadkeeper-slot`. It bounds the root to the dynamic viewport, allows rows/column to shrink, preserves the breadcrumb, and gives the existing absolute slot its actual main-content area. It does not invent a fallback slot size. The new CSS test explicitly describes itself as structural; actual reported geometry and desktop/mobile transitions require browser evidence. |
| Command palette accepted close | `CommandPalette` calls `flushSync` only after Radix accepts a close through `onOpenChange(false)`. It does not synthesize Escape or bypass its preventDefault refusal. The new native-listener tests deliberately dispatch outside act/flushSync to expose a deferred React close, and retain a refused-Escape negative control. The change is about commit timing, not compositor qualification. |
| Shell accepted overlay close | App commits the origin/source-validated open-to-closed overlay message in the same native task, records that transition time, and resets it on open/new ready/offline. Its direct native-message regression avoids wrapping the dispatch in act, which would hide the earlier deferred-commit failure. New close reports alone do not renew an old window. |
| `slot-activate` producer | The live bridge passes its actual MouseEvent to fusion. Classification requires trusted primary pointer input with positive click detail, no modifiers/prevention, current connected empty Threads slot as the exact target, matching validated placement, finite current bounds, fresh absence of every blocking overlay, and a recorded open-to-close transition no older than the shared 250 ms window for that same slot. Fresh reads may observe close before the mutation callback. It remeasures/reports the slot immediately before emitting. A new overlay, handshake/mode change, other/unplaced/detached/replaced/nonempty slot, backward/expired/missing time or invalid input is rejected. |
| Host and wire guards | UI host requires the allowed-parent handshake and both announced/current fused availability, tracks a valid reported Threads slot, and bounds coordinates to it. The extension parser retains its existing exact frame source, configured origin and protocol checks before recognizing the new message; it bounds finite coordinates to the current frame viewport and accepts only `view: threads`. No arbitrary selector, target id, key, callback or generic input command crosses the boundary. |
| Parent activation consumer | App requires current fused Threads with the current Threads slot, no open blocking overlay and its own recent open-to-close window. It translates frame coordinates into the shell, checks current slot bounds, resolves the current hit-tested element to a connected registered `.tk-row-btn` in `.tk-list-sidebar`, and confirms its key is an existing conversation. It consumes the window once, calls the existing `handleSelectThread`, and focuses that row. It never calls an element's click handler or activates toolbar/destructive controls. Invalid points do not select a thread; duplicate/expired packets cannot select a later row. |
| Capability assessment | The producer requests only an existing session selection. The trusted Paperclip host already has view/session-open channels; the new path does not grant a provider action, secret read, arbitrary DOM activation or greater account authority. Its point-based target must be resolved independently from the current parent list rather than accepted as a child-supplied thread id. This is an appropriately bounded recovery seam, subject to real-browser proof. |
| Cross-package contract | Both sides export the same 250 ms activation window and the fork-root contract checks equality. Existing route/timing checks remain present. |

## Test fidelity and snapshot consistency

- Positive unit tests pass an explicit classifier input with `isTrusted: true`; the tests and report correctly state that this does not manufacture a browser-trusted event. Real trust/dispatch qualification belongs to the browser run.
- Producer negatives cover programmatic/keyboard/secondary/modified/prevented clicks, invalid coordinates and every slot/window/overlay/handshake boundary. Host tests independently cover handshake, mode, availability and reported rectangle.
- Extension tests run the real App message consumer. The only hit-testing substitute is `document.elementFromPoint`, explicitly mapped to actual registered rows. They reject no close/open overlay, refuse a Delete control without invoking its listener, select a real target once, refuse a duplicate selecting another row, expire the window and refuse repeated-close renewal. Generic parser tests still cover wrong source/origin/version before new message parsing.
- The native palette tests exercise the repository's actual Radix close path. They preserve accepted/refused behavior and avoid the helper that concealed the earlier scheduling issue.
- I inspected the reported producer/palette command receipts; those are author executions, not independent reruns by this reviewer. Current hash checks:
- `ui-slot-activation-receipt.json`: current source/test hashes match every recorded input.
- `palette-native-close-receipt.json`: current source/test hashes match every recorded input.

I ran only scoped `git diff --check` for the reviewed implementation locations; it exited 0. No product mutation, test mutation, build, browser action or publication was performed. The prior review remains the source assessment for unchanged inputs; the SHA-256 table below identifies this supplement's actual reviewed bytes. A later source repair requires review of that changed delta before final source coverage can be claimed.

## Remaining handoff

Proceed to independent quality review on this snapshot. Combine its source verdict with the fresh strict browser results and current aggregate tests. Keep failures, the explicit reconstructed RED receipt, synthetic fixture limitations and unresolved external gates visible. No full-plan completion or compositor success is inferred from this report.

## Reviewed source identity

| Path | SHA-256 |
| --- | --- |
| `extension/src/entrypoints/manager/PaperclipLinks.tsx` | `9e4af4e19d1a69a0961277826a36d8ac1bdf7ff5582a124ee3b928bd36512e88` |
| `extension/src/entrypoints/manager/PaperclipTaskLinks.tsx` | `5f45282bb5b7463b651f5ebf878123b007733f359a3982de9abab5c6327ac5b5` |
| `extension/src/entrypoints/manager/threads/DetailPane.tsx` | `da41ab51486b716fc693c15b429d7742745f7de99526d8fb38331c35d84b19bf` |
| `extension/src/entrypoints/manager/styles/30-threads.css` | `ec117279a1ba1c34c671bad115ae8c56c977e49e400bd86a17bc5f7f065cbda4` |
| `extension/src/entrypoints/manager/hooks/useWorkbenchKeyboard.ts` | `f2792f0a37f849066fb256997f6bbf5628f56fc84b49eb22d1dd3fe0ad502bc1` |
| `extension/tests/unit/paperclip-integration-ui.test.tsx` | `1dc883c824f5520459614c1a43126039fa67c6a71f8099d571400c2cf391ec0a` |
| `extension/tests/unit/workbench-keyboard-dialog.test.tsx` | `0c4d31f5b8885146a4746d6ad5f407d2575492344ee27d7f24122761db8dc875` |
| `extension/tests/unit/threads-view.test.tsx` | `fdde759002ef4b1cc45cf785dca6bcf7c6d73674ecc25187dd9de566bc987299` |
| `ui/src/index.css` | `e355782cbae51350e926f82702e50a23710231442e54bd1e3e3c6c436aac058c` |
| `ui/src/lib/threadkeeper-host-layout.test.ts` | `33b3c1855c677181a43580a34adbc5739505a76451cef2f091147609560340b4` |
| `ui/src/components/Layout.tsx` | `7fb36975d24af8bbb02a7b8790916d05bddb61e555c6450fd011d6388fcded78` |
| `ui/src/components/CommandPalette.tsx` | `0cfc561a9257dcd557083863169ff6aaf5c99001921c8848a5bbc9bfea87f9b8` |
| `ui/src/components/CommandPalette.test.tsx` | `7df6b0f9da57d4c7ae6770705ed6cdeccd617f6ea4a5cab89643f296e922e64c` |
| `ui/src/lib/threadkeeper-host.ts` | `72653fecb830f046394d5cd585a6891ee39ad82ca7850c6084c33926ae95ef75` |
| `ui/src/lib/threadkeeper-host-fusion.ts` | `d7222a758b717987be965ea37e07449a61da9f8147d0185b8be44ad7ed08a4b5` |
| `ui/src/components/ThreadkeeperHostBridge.tsx` | `19bfd0360938d906fa41ea2caa378c7f29b4cc0016817f294f8f9b4c5eaf32de` |
| `ui/src/lib/threadkeeper-host.test.ts` | `b9742643aa547b5701ba073802a10018c00f9ce3993f1cbf1fea6922771ed376` |
| `ui/src/lib/threadkeeper-host-fusion.test.ts` | `4afcb8233f45eae62edfae8983673d065db08329185032970df48b7ebe4e7e7e` |
| `extension/src/core/paperclip/host.ts` | `9187229c355fb67dbcfd1d1d095c3f0355b602d9c0b10ae301b40b3d184329f0` |
| `extension/src/entrypoints/manager/App.tsx` | `ab802b4cb296c5e9fe9a6e89e4d6c1c46910d808191398218c896ed0bd22933e` |
| `extension/src/entrypoints/manager/PaperclipView.tsx` | `36e4303ddc74083467b43d404c4a30aa69ae4a6afc0ffd874e13a7c568871e2c` |
| `extension/tests/unit/paperclip-host.test.ts` | `f14bea5a943847db9b5f1e13e212efef0f486eaec8cc2e0fb9615ce375aa59e2` |
| `extension/tests/unit/paperclip-fused.test.tsx` | `efd913e5dad991a60e0d089e3d67b9e32f319be9c56bab8fdf0b5de4f7386b01` |
| `scripts/threadkeeper-contracts.test.mjs` | `4aff6251fedd6a30a44b52b0811f16d19ae1f263d154db8a22ab9db641070d26` |
