# Review: cumulative spec, round 3 (REQ-6, 7, 8, 11, 14 repairs)

- **Stage:** spec. **Scope:** cumulative.
- **Tasks:** REQ-6/TASK-1, plus the round-3 repairs to REQ-7, 8, 11 and 14 (each `/TASK-1`).
- **Authors:**
  - `impl-req6-fused-20261114`: `ui/src/lib/threadkeeper-{host,overlays,host-fusion}.ts` and their tests; new `ui/src/lib/threadkeeper-host-bridge.test.ts`; `extension/src/entrypoints/manager/{PaperclipFusion.ts,App.tsx}`; `extension/tests/unit/paperclip-fused.test.tsx`
  - `impl-plugin-repair-20261114`: `packages/plugins/plugin-browser-sessions/src/{contracts,service,tools}.ts`; `tests/service.spec.ts`; new `tests/timing.spec.ts`
  - `impl-extension-bridge-repair-20261114`: `extension/src/core/paperclip/{actions,bridge,bridge-protocol,credentials}.ts`; `extension/src/entrypoints/manager/paperclip-actions.ts`; `extension/tests/unit/paperclip-{actions,bridge-client,credentials}.test.ts`; new `scripts/threadkeeper-contracts.test.mjs`
- **Reviewer:** `spec-review-r3-20261114`. I wrote none of this code and took no part in earlier rounds. I did not read `.plan/verify/reviews/spec-round-3.md`.
- **Round:** 3 of 3. I took the cap from the brief and did not validate it myself.
- **Also read for context:** `ThreadkeeperHostBridge.tsx`, `threadkeeper-host-slot.ts`, `threadkeeper-boot-channel.test.ts`, `PaperclipView.tsx`, `PaperclipConnection.tsx`, `lifecycle.ts`, `host-access.ts`, `custom-sites.ts:235-285`, `schema.ts:750-797`, `build-extension.mjs:524-539`, `package.json`, `scripts/threadkeeper-check.mjs`.
- **Evidence destination:** chosen by the coordinator.

## 1. The browser defect (boot channel)

**Verdict: the fix is correct and complete.**

- **Forwarding:** `threadkeeper-host.ts:59-63` now forwards every `threadkeeper-shell` v1 message other than `navigate` to the attached host, once a hello from the same origin has been seen. The host then validates each type and payload (`:126-144`).
- **Origin and source checks:** still applied first (`:51`). A message before hello is never forwarded (`:57,59`), and the host itself also refuses it (`parentOrigin` is null, `:102,126`).
- **Buffering:** only hello and the latest valid `navigate` are buffered. A `placed` message can only follow a `ready`, and `ready` is posted only after the host attaches, so not buffering it loses nothing. After a remount, the replayed hello produces a fresh `ready`, which bumps `slotSeq`, so `placed` is sent again.
- **The new bridge test uses the real wiring.**
  - It calls `vi.resetModules()` after stubbing `window.parent`, so the boot channel is created at module load (`ThreadkeeperHostBridge.tsx:12-15`), as in the browser.
  - It mounts the real bridge, host, fusion and slot registry, and dispatches messages on `window`.
  - Its recorded RED (`placed` dropped) matches the symptom from the browser run.
  - Weakness: see N-4.

## 2. Round-2 findings

| Finding | Verdict | Evidence |
|---|---|---|
| M-1 / F-1 (`placed` not re-sent when messages are batched) | **FIXED** | `slotSeq` is bumped on each engagement or view change (`PaperclipFusion.ts:51`) and kept across `ready` and `offline` (`:42,58`). The effect depends on `[fused, fusion.slotSeq]` (`App.tsx:738`). Tests: batched `ready`+`slot` and `slot null`+`slot view` (`paperclip-fused.test.tsx:237-252`); reducer test `:38-47`. |
| M-2 / F-2 (cancel signal was transient) | **FIXED on both sides** | Plugin: ids are listed until a verdict or `deadlineAt` (`service.ts:186,202,210`), and `hasDeliveries` counts cancellations not yet delivered (`:205`); tests `service.spec.ts:642-665`. Extension: early cancels are remembered (at most 2,000, 10-minute expiry) and repeats are harmless (`actions.ts:54-66,129`); test `paperclip-actions.test.ts:98`. |
| M-3 / F-3 (unlink cancelled too much, with the wrong text) | **FIXED on both sides** | Plugin cancels only `session.send` with the matching `(issueId, threadKey)`, using the FR-1 link text (`service.ts:370`); test `:621`. Extension `revalidateLinks` uses the same text (`actions.ts:72-77`; `bridge-protocol.ts:90,106`). It runs before `cancelRequests` in a tick (`bridge.ts:340-342`). |
| F-4 (overlay observer cost) | **FIXED** | One scan per animation frame (`threadkeeper-overlays.ts:96-103`). The observer runs only after a fused `ready` (`threadkeeper-host-fusion.ts:34-46`). The notice clip effect has dependencies plus a resize listener (`PaperclipFusion.ts:160-181`). Tests: overlays `:147`, fusion `:91`, fused `:380`. |
| F-5 (secret cache clear race) | **FIXED** | Generation counter (`credentials.ts:117-128`). |
| F-6 (actions stuck "Pending" after a worker restart) | **FIXED** | `requestId` is stored at admission (`tools.ts:175,216`). A verdict for an unknown request completes the stored record (`service.ts:243-251`). Old incomplete records are relabelled in the display only (`:389-393`). Tests `:666,676`. |
| F-7 (unchecked cross-package invariants) | **PARTIAL** | The timing chain and `MAX_NOTICE_REGIONS` are now asserted in `scripts/threadkeeper-contracts.test.mjs`, with a self-check. Three gaps remain: the test is not wired into any runner (N-1); the `session-board`↔`dashboard` mapping is not checked; `service.spec.ts:557` still hardcodes `1_500`. |

## 3. Behaviour change: the frame loads whenever Paperclip runs (`eager`, `App.tsx:1263`)

- **REQ-6 FR-6 (works without Paperclip): pass.**
  - The frame loads only when `running` (`PaperclipView.tsx:43`), and `running` requires the optional loopback grant (`lifecycle.ts:146`).
  - The fused window requires `fused` from the page, which needs the plugin's three pages and the extension ID in Paperclip's allow-list.
  - When Paperclip stops, the `offline` action drops the fused window.
- **REQ-6 FR-5 (one sidebar): unchanged** (`paperclip-fused.test.tsx:205-223`).
- **REQ-5 frame budget, no reload, capture:**
  - `PaperclipView` sits outside the session frame plan, and no capture path changed.
  - REQ-5 FR-2 says the frame is created "when the view is first shown". Loading it eagerly is a wording deviation; see N-3.
- **REQ-4 (no extra helper traffic): pass.** Native messages are sent only from `offline()` (`lifecycle.ts:112-143`), which round 3 did not change. Loading the frame adds Paperclip HTTP traffic only.
- **Hosting disabled or permission revoked:**
  - Revoking the grant leads to `permission_required`, then not running, then the shell's own rail; no fused window.
  - There is no UI to set `hostEnabled` to false. Round 3 sets it to true automatically while fused (`App.tsx:356-361`), but only when a grant already exists.
- **Can a founder who does not want Paperclip be forced into it?**
  - Without a grant: no.
  - With Paperclip connected, the only ways out are:
    - disabling the plugin, which, per D-9, also disables the bridge that REQ-7, 8 and 11 rely on;
    - revoking site access;
    - stopping the server.
  - Edge case: if two local custom capture sites happen to grant the same port-free patterns (`custom-sites.ts:279`, `host-access.ts:12`), a Paperclip server on the default `localhost:3100` would fuse without the founder ever pressing Connect.
  - REQ-6 FR-6 makes the fused window the default, so none of this is a contract violation. It is a product decision (N-3).

## 4. Seams and new issues

- **Cancel ids are repeatable and remembered: PASS.** A repeated id after the extension has finished goes to `earlyCancels`. That is harmless, because the plugin never hands a cancelled request out again (`service.ts:197`).
- **Unlink: PASS.**
  - The extension rule (no current link authorizes the send) matches the plugin rule (that link removed).
  - The text is identical on both sides.
  - `actionVerdict` puts the plugin's own reason first (`service.ts:226`).
- **Timing: PASS.** The cancel stays listed until its deadline, so a slow `syncInventory` no longer lets typing proceed.
- **Weakened assertions: none found.** Three expectations changed, each following a contract change:
  - The fusion forwarding test now calls `refresh()` first, because overlays are watched only after a fused `ready`.
  - The overlay tests pass a synchronous scheduler, because scans are now batched per frame.
  - One reducer test was narrowed before its first GREEN, by its own author.

## Findings

| ID | Severity | Where | Expected / actual | Violates | Bounded fix / owner |
|---|---|---|---|---|---|
| N-1 | Minor | `package.json:9`; `scripts/threadkeeper-check.mjs:66` | **Expected:** a one-sided change fails a routine check. **Actual:** `threadkeeper-contracts.test.mjs` is run by neither `test:threadkeeper` nor the check runner, so it passes only when someone runs it by hand. | Quality F-7; `AGENTS.md` §5.2 | Add it to both places and to the assertion at `threadkeeper.test.mjs:65`. Owner: coordinator or `impl-extension-bridge-repair` (outside their file scope). |
| N-2 | Minor (RUNTIME-ONLY) | `App.tsx:1259,1173-1175,725-731`; test `paperclip-fused.test.tsx:265-273` | **Expected (round-3 claim; by analogy with FR-6 "on the same view"):** opening the manager on `?view=threads` fuses on Threads. **Actual:** the test injects `/ACME/threads` and a `threads` slot by hand, but a real frame without `pc` loads `/`. Paperclip then lands on a page with no Threadkeeper slot and sends `slot null`, so the shell calls `setView('paperclip')`. That choice is persisted, and it races the navigation effect while `persistSettingPatch` is still pending. Without a company prefix, the window stays on Paperclip. Found by static trace, not executed. | Round-3 behaviour claim; FR-6 intent | Have the in-progress browser run check this case. Add a test that sends `route /ACME/dashboard` + `slot null` first and expects Threads. Keep the founder's view when the first engagement has a null slot. Owner: `impl-req6-fused`. |
| N-3 | Minor (needs a decision) | `App.tsx:1263,356-361` | **Expected:** REQ-5 FR-2 says the frame is created "when the view is first shown", and REQ-6's rollback says disabling the plugin returns REQ-5 behaviour. **Actual:** the frame loads hidden whenever Paperclip runs, even with the plugin disabled. There is no control to keep Paperclip connected while declining the fused window. | REQ-5 FR-2 wording; REQ-6 rollback note | Specify should record eager loading and decide whether to add an opt-out. Owner: founder / Specify. |
| N-4 | Minor | `threadkeeper-host-bridge.test.ts:92-101` | **Expected:** the refusal test isolates the boot-channel guard. **Actual:** `placed` never posts anything, and the host rejects these messages on its own, so the test would pass without the boot-channel check. | Test fidelity | Assert that `data-threadkeeper-slot` is absent. Add boot-channel unit cases for forwarding and refusing `placed` and `command`. Owner: `impl-req6-fused`. |

No Blocker or Major findings.

**Carried forward for a founder or Specify decision** (classified, not failed):
- **NF-4:** unchanged; `local_trusted` still allows any local process to pair itself.
- **NF-5:** the window remembers a missing helper (`lifecycle.ts:121-127`), so one native probe per window remains, against REQ-4 AC-11's literal text.
- **M-4:** actions still report "did not answer in 60/75 seconds" (`service.ts:179,229`), which is truthful but not the 30 s literal.
- **F-4 / Q-3:** the REQ-6 changelog (`:331`) and Readiness section (`:320`) still describe the switching fallback. AC-10 is unreconciled with the layered design.
- **"Threadkeeper is not responding. Reload the window.":** still not built; no file in `ui/src` contains it.

## Checks and applicability

- **Run by the coordinator** (inspected only, not run by me):
  - extension `tsc` 0; vitest 104 files, 1,940 passed
  - plugin 110 passed; `tsc` 0
  - ui `tsc` 0; 13 related files, 97 passed. The author's report says 14 files and 191 passed, which does not match. I note the difference without resolving it.
  - server `tsc` 0; 131 passed
  - `node --test scripts/threadkeeper.test.mjs scripts/threadkeeper-contracts.test.mjs`: 13 passed
- **Not run:** the real-browser re-run (in progress), the full Paperclip and server suites, and real providers.
- **TDD:** each item has a RED/GREEN row. The F-7 RED was produced by temporarily mutating a constant, which the author disclosed. The logs are in `/tmp`, so they are ephemeral and I did not inspect them.
- **Limitations:**
  - Load gates are `ok:false`; the work went ahead on the user's instruction.
  - Every fused-window property is RUNTIME-ONLY.
  - I did not verify whether `content.js` would capture a Paperclip frame on `localhost` that shares a port-free custom-site pattern. That behaviour existed before round 3, but eager loading exposes the frame more often.

## Verdict

**PASS.**
- The boot-channel defect is fixed, and the security checks are intact.
- M-1 to M-3 and quality F-1 to F-6 are fixed with tests that would have failed on the old code. F-7 is partial.
- The cross-author seams hold, and round 3 weakened no assertion.
- N-1 to N-4 are Minor. None of them hides behaviour that an AC requires.
- **Next steps:**
  1. Have the in-progress browser run cover N-2 (opening the manager on `?view=threads` with no `pc`).
  2. Wire in the contract test (N-1).
  3. Take the N-3 decision and the carried items to Specify or the founder.
  4. Cumulative quality review, then the complete gates.

Key files:
- /Users/andrew/dev/threadkeeper/paperclip/ui/src/lib/threadkeeper-host.ts
- /Users/andrew/dev/threadkeeper/paperclip/ui/src/lib/threadkeeper-host-bridge.test.ts
- /Users/andrew/dev/threadkeeper/paperclip/extension/src/entrypoints/manager/App.tsx
- /Users/andrew/dev/threadkeeper/paperclip/extension/tests/unit/paperclip-fused.test.tsx
- /Users/andrew/dev/threadkeeper/paperclip/scripts/threadkeeper-contracts.test.mjs
- /Users/andrew/dev/threadkeeper/paperclip/packages/plugins/plugin-browser-sessions/src/service.ts
