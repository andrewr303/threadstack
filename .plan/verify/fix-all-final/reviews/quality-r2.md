# Independent quality supplement — fix-all cycle, review 2

Reviewer: `final_quality_review`, independent of the implementation authors. This read-only supplement follows the independent spec PASS in `/tmp/tk-fix-all/final-spec-review-r2.md`. It supplements the first quality report rather than rewriting its earlier snapshot or failed browser observations.

## Technical verdict

**PASS for the final repair delta and the narrow fork-CI boundary.** No concrete blocker, major or minor code-quality defect was found in the inspected scope. The cross-frame recovery is confined to selecting an existing session row. It introduces no provider action, credential access, generic DOM click or arbitrary input facility.

This is a source-quality verdict. Browser/compositor results, current aggregate test results and the formal external gates remain separate evidence. The lead reports a targeted Chrome round with four successful zero-delay clicks and cold narrow layout, while complete Chrome/Edge rounds remain active; I did not execute or independently inspect those browser outcomes.

## Inspection

- **Producer eligibility and lifetime:** fusion classifies the actual MouseEvent passed by the live document listener. It requires trusted primary pointer input with positive click detail, no modifiers/default prevention, exact current empty connected Threads slot target, matching validated placement, finite freshly measured bounds, a real remembered open-to-close transition for that same element, and a nonnegative age no greater than the shared 250 ms budget. A fresh complete overlay read rejects any remaining blocker. Refresh clears the close context and withdraws placement; mode changes, disposal, nonempty/replaced/detached slots, unplaced state and expired/backward time are rejected. A read that discovers a close before the observer callback still uses the existing transition logic.
- **Host and wire seam:** host emission requires the allowed-parent handshake, both announced and current fused availability, the current reported Threads rectangle and in-bounds finite coordinates. New hello, mode announcement and disconnect clear reported state. The extension parser retains exact frame source/configured origin/protocol checks before parsing the new narrow payload, restricts it to Threads and bounds it to the frame viewport. No caller-controlled selector, callback, key or thread identifier is accepted by this recovery channel.
- **Parent resolution:** App requires current fused Threads, a current Threads slot, no open blocking overlay and its own recent accepted close. The timestamp is set only on a true open-to-close transition and reset on new open, ready and offline; repeated closed reports do not renew it. Coordinates are translated from the actual frame to the current shell slot. The point must resolve to a connected registered `.tk-row-btn` inside `.tk-list-sidebar`, and its mapped key must still exist in the current conversation map. Successful consumption clears the window before the existing selection callback and focus; duplicates cannot select another row. Toolbar/destructive controls are not eligible and no DOM click handler is invoked. Existing trusted host session-opening capability already permits session navigation; this path does not increase that authority.
- **Accepted-close synchronization:** CommandPalette uses flushSync only after Radix calls the accepted `onOpenChange(false)` path. It leaves prevented Escape closes intact. App similarly synchronizes only a validated overlay open-to-close transition. Neither path invents an Escape event or overrides the primitive's dismissal decision. Their native-listener tests avoid act/flush helpers around the action that would conceal the earlier deferred commit.
- **Task-link UI:** compact links use the existing toolbar action to open a native dialog portalled outside the overflow/header. Founder links, imported references, offline state, task search/link/unlink and task navigation remain intact. Navigation and ordinary dismissal close the dialog; explicit dismissal restores trigger focus. The generic keyboard hook retains registered innermost-first dialog order, then recognizes a focused/remaining feature-owned open native dialog, suppressing list shortcuts behind it and spending Escape on one dialog before drawer/selection handling.
- **Narrow geometry:** the new CSS bounds only the mobile app shell that contains the verified Threadkeeper slot and its named flex ancestors. It preserves the breadcrumb, shrinking content and the actual absolute slot measurement. It does not fake a rectangle or change unrelated mobile pages. The CSS unit test states its structural limit; rendered sizing requires the owned browser evidence.
- **Tests and contracts:** classifier tests explicitly pass a trust flag as input and do not claim to create native trusted events. Positive and negative cases cover pointer type/modifiers/prevention, slot identity/content/connection, placement, time and competing overlays. Parent App tests substitute only hit testing against real registered rows and prove no-close/open-overlay/toolbar refusal, single use, expiry and no repeated-close renewal. The shared activation-window equality is included with existing root contracts. These are source/protocol checks, not compositor proof.
- **Fork CI:** the caller routes canonical and AVRCORP jobs separately. The local reusable workflow runs only on hosted Ubuntu runners with read-only contents permission, no inherited secrets/OIDC write, pinned actions and disabled checkout credential persistence. Root pnpm uses its pinned version and frozen lock; the React 18 extension installs separately with npm ci. Builds use the guarded isolated output with no stable ID/live path. Scoped extension/plugin/UI/server tests and their stated qualification boundary remain visible. The static test file checks routing, admission, permissions, installations and intended commands; its presence is not hosted-CI success. No upstream trusted workflow was re-audited here.

## Validation and boundaries

I inspected actual source and regression tests for this delta and ran scoped `git diff --check`, which exited 0. I made no source/test edits, builds, browser actions, Git mutations or publication calls. The parent owns aggregate runs, source-pin refresh validation, full browser rounds and PR delivery.

Formal plan limits remain as recorded: unresolved original AC/product-decision wording, the literal zero-native-message criterion, full Paperclip qualification, native consent, real providers/model keys, helper/launchd, MV3 suspension and live-library continuity. This technical PASS does not waive those gates or certify deployment. A later production change requires review of that changed scope before current source coverage is claimed.

## Reviewed source identity

Captured 2026-11-15T04:54:13.171493+00:00; HEAD `da486db17d229b62726e76c2085bf9db10039eee` plus actual working bytes below.

All 24 product-delta hashes match the preceding spec supplement. Three CI/tooling files are additional narrow quality scope.

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
| `.github/workflows/pr.yml` | `ef08050f5631a51c73f0eba0990abbf7e0623981cf93a733db074436ba9459c8` |
| `.github/workflows/threadkeeper-pr.yml` | `9b9507c34c3729f73b6efbd39756d95d25ed2bd185aec2b93b5eace63b2b1b0e` |
| `scripts/threadkeeper-ci.test.mjs` | `b02d3b39f78cdc96897f90541328c5e10b3ff4ae4c2f7480862fa368425c4fb6` |
