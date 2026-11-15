# Review: cumulative spec re-review, round 2 (REQ-3, 4, 6, 7, 8, 10, 11, 12, 14)

- Stage: spec
- Scope: cumulative
- Tasks: REQ-6/TASK-1, plus the repair round covering REQ-3, 4, 7, 8, 10, 11, 12 and 14 (each `/TASK-1`)
- Authors:
  - `impl-req6-fused-20261114`, plus the coordinator's one-line edit to `useWorkbenchKeyboard.ts:96`
  - `impl-plugin-repair-20261114`
  - `impl-extension-bridge-repair-20261114`
  - `impl-lifecycle-checks-repair-20261114`
- Reviewer: `spec-review-r2-20261114`. I wrote none of this code and did not take part in round 1.
- Round: 2 of `max_review_rounds` 3. I took the cap from the round-1 reports and did not validate it myself.
- Reviewed files (all repo-relative to `paperclip/`):
  - UI: `ui/src/lib/threadkeeper-host{,-slot,-fusion}.ts` and their tests; `ui/src/components/ThreadkeeperHostBridge.tsx`; `ui/src/pages/PluginPage.tsx`; `ui/src/index.css` (lines 5757–5794)
  - Extension, REQ-6: `extension/src/entrypoints/manager/{App.tsx (fusion parts), PaperclipFusion.ts, PaperclipView.tsx, hooks/useWorkbenchKeyboard.ts}`; `extension/src/core/paperclip/host.ts`; `extension/tests/unit/paperclip-fused.test.tsx`
  - Extension, bridge: `extension/src/core/paperclip/{bridge,bridge-protocol,bridge-query,actions,credentials,integration-runtime}.ts`; `extension/src/entrypoints/manager/paperclip-actions.ts`; `extension/src/entrypoints/background.ts` (lines 485–490 and 1495)
  - Plugin: `packages/plugins/plugin-browser-sessions/src/{service,contracts,tools,manifest,worker}.ts`; `tests/service.spec.ts` (lines 255–276 and 530–620)
  - Scripts and docs: `scripts/threadkeeper-deploy.mjs`, `scripts/threadkeeper.test.mjs`, `doc/THREADKEEPER-SERVICE.md`
  - Checked by test name only: the other extension round-2 tests, `worker.spec.ts`, `manifest.spec.ts`, `PluginPage.test.tsx`
- Evidence destination: chosen by the coordinator.

## Contract and evidence: round-1 Blockers and Majors

| Finding | Verdict | Source / test | Would the test fail on the pre-repair code? |
|---|---|---|---|
| F-1 (slot dropped after a mode change) | **FIXED** | `threadkeeper-host.ts:150` clears `lastSlot`. `threadkeeper-host-fusion.ts:38-42` sends ready, then slot, then overlay. Bridge wiring at `ThreadkeeperHostBridge.tsx:103`. | Yes. host test `:98` (dedupe) and fusion test `:54` (`announceMode` not a function). |
| F-2 (blank transparent slot) | **FIXED**, residual Minor M-1 | Transparency is gated on the acknowledgement (`threadkeeper-host-slot.ts:66-67`) and resets on a new element (`:80`). `refresh()` drops it (`fusion.ts:34`). The slot sends `open-view` (`PluginPage.tsx:33`). The shell posts `placed` (`App.tsx:733-737`). | Yes. slot test `:39-51`, fusion `:73`, fused `:214`, PluginPage open-view. One slot-test expectation was changed to the new contract. That is justified by UI Layout "Loading", not a weakening. |
| F-3 (no Command+K test on a row) | **FIXED** | `paperclip-fused.test.tsx:282-318` covers Cmd+K and Ctrl+K on `.tk-row-btn` with the selection unchanged, plus plain j/k. Guard at `useWorkbenchKeyboard.ts:96`. | Yes, by reasoning. Without the guard, either the workbench handler calls `preventDefault` first (no palette is posted) or the selection moves; both assertions catch it. The author's mutation log is inspected only. |
| NF-1 (deploy guard refused the live folder) | **FIXED** | `threadkeeper-deploy.mjs:36` refuses home and its parents, the fork and anything inside it, and `/tmp/tk-build*`. Doc at `:33-35` matches. | Yes. Positive test `threadkeeper.test.mjs:137-150`. |
| NF-2 (wrong abort text) | **FIXED** | Guard abort reasons (`actions.ts:44-46,100`). Executor waits ≤3 s for the manager's verdict (`integration-runtime.ts:38-44`). Manager `check()` (`paperclip-actions.ts:37`). Plugin `actionVerdict` (`service.ts:222-229`). | Yes. Plugin `R2 NF-2` (6 cases) and runtime tests `:126`, `:138`. |
| NF-3 (no fast offline signal) | **FIXED in mechanism**; the trigger is RUNTIME-ONLY | Plugin `service.ts:68-75`; route at `manifest.ts:32` and `worker.ts:44`. Extension `bridge.ts:364-376`, wired to `onSuspend` (`background.ts:1496`). | Yes. `service.spec.ts:533` (under 1 s, pairing kept, wrong token gets `not_paired`, recovers on poll and on connect). |
| NF-3b (timing budget too short) | **FIXED** | Budgets 60 s / 75 s (`contracts.ts:10,12`; `tools.ts:215`). Page-load bound at `paperclip-actions.ts:91-92`. | Yes. `service.spec.ts:552` (old 43.5 s fails). The F-2 test literal changed from 50 s to `SEND_TIMEOUT_MS`; justified. |

## Seam verdicts

1. **`placed` acknowledgement and transparency: PASS with one Minor (M-1).**
   - **Transparent with no view placed:** I found no reachable path.
     - Acknowledgements are posted only while `fused` is true.
     - A new page `ready` drops the acknowledgement (hello and mode changes).
     - A new slot element or a different view drops it too.
     - With the server stopped, the frame is hidden (`PaperclipView.tsx:136`), and it reloads to a fresh, opaque document when the server returns (`:61-65`).
     - In the switching fallback and past the 2 s window, no acknowledgement is sent. `open-view` switches the shell to its own layout, and the frame is hidden.
   - **Opaque over a placed view:** reachable. After an in-frame document reload on the same route, the shell stays fused with the same `slotView`. See M-1.
2. **`bridge/offline`: PASS.**
   - The extension calls the route the plugin registers: `/api/plugins/browser-sessions/api/bridge/offline`, with the token header and `{companyId}`.
   - The route requires the token, and `offline()` sets only a flag (`service.ts:70`), so it cannot be used to unpair.
   - The next poll or connect clears the flag (`:132`, `:189`).
3. **Action deadlines: PASS.**
   - Send: `deadlineAt` T+55 s; guard abort at T+53.5 s; manager verdict wait ≤3 s, so the answer arrives by T+56.5 s, before the plugin's 60 s timer. Page load gets min(30 s, `deadlineAt` − 19 s), so 30 s plus 2 s plus 15 s fits.
   - Start: `deadlineAt` T+70 s; worst case about 62.5 s.
   - Cancellation: the poll is woken at once, the extension aborts, and the 3 s verdict wait ends well inside the plugin's 8 s settle, so AC-8's 10 s is met.
4. **`cancel-requests` capability: PASS with Minor M-2.**
   - Untrusting agent A lists only A's requests (`service.ts:201,323`), and B's action proceeds (test `:602`).
   - A request can be both cancelled and delivered if text was already submitted. The plugin then truthfully resolves it as `delivered`, or records "Delivered (reported late)" after the settle. That is acceptable.
   - However, the stop signal is now transient (M-2).
5. **Abort reasons vs FR-1 and AC-8 texts: PASS for `disabled`, `denied` and `unknown_delivery`.**
   - `actionVerdict` returns the plugin's withdrawal reason ahead of the browser's reason.
   - Two gaps remain: the `timeout` text (M-4) and the unlink cancellation text (M-3).
6. **`truncated`: PASS.** It is now `page.cut || transcript.truncated` (`bridge-query.ts:271`).
7. **Secret cache vs REQ-14 AC-4 and AC-6: PASS.**
   - Any poll or connect failure drops the cache (`bridge.ts:354` → `integration-runtime.ts:78`), so AC-4 pauses within seconds of Paperclip stopping.
   - Opening settings issues a credential command, which clears the cache (`integration-runtime.ts:127`). With NF-10's mapping to `not_found`, AC-6 then shows `Secret missing`.
   - Remaining exposure: a feature can keep using the key for up to 30 s after it is deleted while the bridge stays healthy. This is documented at `credentials.ts:108-111`, but the "accepted" in that comment is the author's own word.

## Checks and applicability

- **Run by the coordinator** (inspected only, not run by me):
  - extension `tsc` exit 0 and `npx vitest run` 1,932 passed
  - plugin 103 passed, `tsc` exit 0
  - ui `tsc` exit 0 and 93 passed
  - server `tsc` exit 0 and 131 passed
  - `node --test scripts/threadkeeper.test.mjs` 10 passed
- **Not run:**
  - the full server suite and the full Paperclip suite
  - any browser run of fused mode, the bridge, `onSuspend`/`keepalive`, or MV3 suspension
  - real providers and real keys
- **TDD:** each repair has a recorded RED/GREEN table. Disclosed exceptions:
  - F-3 has no fresh RED; the author substituted a mutation check.
  - The extra NF-10 assertions were added after the first GREEN.
  - NF-9 is a characterization test plus a mutation check.
- **Weakened assertions:** none found. All three changed expectations follow contract or budget changes.
- **Limitations:**
  - Load gates are `ok:false`; the work went ahead on the user's instruction.
  - All visual properties of fused mode are RUNTIME-ONLY.
  - The diffs were not available, so I read the current source.

## Findings

| ID | Severity | Where | Expected / actual | Violates | Bounded fix / owner |
|---|---|---|---|---|---|
| M-1 | Minor | `App.tsx:733-737` | **Expected:** "a new ready … the shell has to place its view again" (`fusion.test.ts:81`). **Actual:** the effect depends only on `[fused, slotView]`. After an in-frame reload on the same route, `ready` and `slot` arrive back-to-back. If React batches them, `fused` never renders false and the view is unchanged, so `placed` is never sent and the page stays opaque. That is invisible until an overlay raises the frame, when Paperclip's background hides the view. Found by static trace, not executed. | REQ-6 FR-3; design "placed" contract | Add `fusion.readyAt` to the effect's dependencies, or post `placed` on each engaging `slot`. Add a test with a re-`ready` while fused. Owner: `impl-req6-fused`. |
| M-2 | Minor | `service.ts:186,201`; `actions.ts:46,97` | **Expected:** untrusting A reliably stops A's held action, as the round-1 epoch bump did. **Actual:** with the capability, the cancel id is listed only during the 8 s settle window. A poll gap longer than 8 s (for example a slow `syncInventory`), or a cancel arriving before the guard creates its controller, lets A's action type after the trust was removed. | REQ-11 FR-3 intent (round-1 F-3) | List cancelled ids until a verdict arrives or `deadlineAt` passes, even after `uncertain`. Owners: plugin; extension to tolerate repeats. |
| M-3 | Minor | `service.ts:350`, now reaching held actions through `:224` | Unlinking cancels every action in the company with `denied: Browser action scope changed.`. That is not an FR-1 text, and it hits sessions that are still linked. | REQ-11 FR-1 exact texts | Match on the unlinked thread key and use the FR-1 link text. Owner: plugin. |
| M-4 | Minor (needs a Specify decision) | `service.ts:180,227`; test `:566` | REQ-8 FR-9's exact text, imported by REQ-11 FR-1, is `timeout: The browser did not answer in 30 seconds.`. Actions now return 60 or 75 seconds. That is truthful, but it is not the literal text. | REQ-8 FR-9 / REQ-11 FR-1 | Specify should choose either `{n}` or the 30 s literal for actions. |
| M-5 | Minor (RUNTIME-ONLY) | `background.ts:1496` | `onSuspend` is not guaranteed to fire when the browser quits, so AC-13 "browser closed" is unproven end to end. A routine worker suspension also marks the browser offline until the next alarm (≤30 s). | REQ-8 AC-13 | Runtime check in Edge and Chrome. Owner: extension. |

There are no Blocker or Major findings.

**Open items that need a founder or Specify decision** (classified, not failed):
- **NF-4:** unchanged. On `local_trusted`, any local process can still:
  - disconnect the extension, then run `pair-start`, `pair-confirm` and `pair-poll` to get a token;
  - with that token, read secrets (when transfer is allowed), receive action texts, inject `auto` links, and call `/bridge/offline` (a denial of service, not an unpairing);
  - call `policy-save` and `link`.
- **NF-5:** `lifecycle.ts` is unchanged; one native message is still sent per window when the helper is missing (REQ-4 AC-11 literal).
- **F-4:** the changelog of `REQ-6-threadkeeper-entries-in-paperclips-sidebar.md` (`:331`) and its Readiness section (`:320`) still say the switching fallback is implemented. Q-3 is unanswered, and AC-10 literally says no FR-2–FR-5 product code may exist. The coordinator must record the layered decision, or the founder must answer Q-3.
- **F-5:** the overlay observer's false positives are unchanged (`threadkeeper-overlays.ts`).
- **"Threadkeeper is not responding. Reload the window."** (REQ-6 UI Layout `:77`): not built. No AC owns it, and the `open-view` fallback makes it largely unreachable.

## Verdict

**PASS.**
- Every round-1 Blocker and Major (F-1, F-2, F-3, NF-1, NF-2, NF-3, NF-3b) is fixed, with tests that would fail on the old code. NF-3's browser-side trigger is RUNTIME-ONLY.
- The cross-author seams hold. Round 2 introduced no Blocker or Major and weakened no assertion.
- M-1 to M-5 are Minor. None hides required behaviour; each has a bounded fix or a decision owner.
- Next steps:
  1. Cumulative quality review.
  2. Fix M-1 to M-3 opportunistically.
  3. Specify and founder decisions on M-4, NF-4, NF-5 and F-4/Q-3.
  4. Runtime checks of fused mode and of the offline signal before the complete gates.

The REQ-6 contract has a gap that doesn't block this review but must be closed before REQ-6 can be marked done: `.plan/reqs/REQ-6-threadkeeper-entries-in-paperclips-sidebar.md` still says the switching fallback is implemented, and its AC-10 forbids the fused code that now exists.
