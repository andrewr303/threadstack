# Review: cumulative quality, round 2 (REQ-3, 4, 6, 7, 8, 10, 11, 12, 14; repairs)

- Stage: quality
- Scope: cumulative
- Tasks: REQ-6/TASK-1, plus the repair round of REQ-3, 4, 7, 8, 10, 11, 12 and 14 (each `/TASK-1`)
- Authors:
  - `impl-req6-fused-20261114`, plus the coordinator's one-line edit at `useWorkbenchKeyboard.ts:96`
  - `impl-plugin-repair-20261114`
  - `impl-extension-bridge-repair-20261114`
  - `impl-lifecycle-checks-repair-20261114`
- Reviewer: `quality-review-r2-20261114`. I am independent of every author above and of both spec reviewers.
- Round: 2 of `max_review_rounds` 3. I took the cap from earlier reports and did not validate it myself.
- Reviewed files: the same scope as `.plan/verify/repairs.r2.cumulative-spec.md`. I read these myself:
  - Plugin: `src/{service,tools,worker}.ts`, `tests/service.spec.ts:525-620`
  - Extension: `core/paperclip/{bridge,actions,integration-runtime,host,credentials}.ts`, `core/embed/session-delivery.ts`, `manager/{PaperclipFusion.ts,PaperclipView.tsx}`, `App.tsx` (fusion parts), `useWorkbenchKeyboard.ts:80-110`, `tests/unit/paperclip-fused.test.tsx:120-230`
  - UI: `ui/src/lib/threadkeeper-{host,host-slot,host-fusion,overlays}.ts`, `ThreadkeeperHostBridge.tsx`, `PluginPage.tsx`, `index.css:5757-5794`
  - Server and scripts: `server/src/routes/plugins.ts` (header allowlist, scoped API route), `scripts/threadkeeper-deploy.mjs`
- Evidence destination: chosen by the coordinator.
- Spec prerequisite: `.plan/verify/repairs.r2.cumulative-spec.md` is round 2 and PASS. **I was not given current per-TASK gate results.** The spec report itself records that the load gates are `ok:false`.

## Contract and evidence

| Rule or check | Verdict | Evidence |
|---|---|---|
| Token handling | pass | Constant-time hash compare (`service.ts:33,78`). The token header is forwarded only to `browser-sessions` (`plugins.ts:579`). The secret audit logs the key name only (`service.ts:399`, test `:526`). |
| postMessage validation | pass | Shell side checks source, origin and envelope, requires finite rectangles inside the frame bounds, caps notice regions at 8, and restricts `scheme` to two values (`host.ts:21-80`). The page side checks the extension-ID origin (`threadkeeper-host.ts:108-122`). |
| `clip-path` and style strings | pass | Built only from numbers that passed `Number.isFinite` (`PaperclipFusion.ts:58-71`, `App.tsx:1222`). There is no string interpolation of untrusted text. |
| Timers and maps in the plugin service | pass, with Minors | Each pending timer is cleared on result, cancel, `uncertain` and `close` (`service.ts:172,183,186,213,416`). `settled` is capped at 1,000 entries and 10 minutes. Hints are capped at 20 per company, and there is one waiter per company. |
| Listeners and observers cleaned up | pass | `ThreadkeeperHostBridge.tsx:87-99`, `threadkeeper-host-slot.ts:96-104`, `threadkeeper-overlays.ts:95-99`, `PaperclipView.tsx:102-103,125`, `PaperclipFusion.ts:117,146` |
| Fake timers | pass | `afterEach` restores real timers (`service.spec.ts:31`). |
| Deploy guard | pass | Resolves real paths, including dangling symlinks; refuses home and its parents, the fork, and `/tmp/tk-build*` (`threadkeeper-deploy.mjs:10-36`). |
| `AGENTS.md` §5.1 (company scope) | pass | Every cancel, poll and lookup is filtered by `companyId`. |
| `AGENTS.md` §5.2 (keep contracts synchronized) | Minor | See F-7. |
| `workflow.md` (gates are not waived) | blocked | Per-TASK gate results were not supplied (see Verdict). |

## Checks and applicability

- **Run by the coordinator** (I inspected the reported results only; I ran nothing):
  - extension `tsc` 0, vitest 1,932 passed
  - plugin 103 passed, `tsc` 0
  - ui `tsc` 0, 93 passed
  - server `tsc` 0, 131 passed
  - `node --test scripts/threadkeeper.test.mjs` 10 passed
- **Not run:**
  - the full server suite
  - any browser or runtime check of fused mode, `onSuspend`, or MV3 suspension
  - real providers and real keys
  - per-TASK complete gates
- **Limitations:**
  - No diffs were available, so I read the current source.
  - Every timing and batching finding below comes from a static trace. None was executed.
  - I did not read `mac-helper/core.cjs`, `lifecycle.ts`, `Rail.tsx`, `10-shell.css` or the lifecycle tests.

## Findings

| ID | Severity | Where | Expected / actual and impact | Violates | Bounded fix / owner |
|---|---|---|---|---|---|
| F-1 (spec M-1) | Minor | `App.tsx:733-737`; `PaperclipFusion.ts:41-44`; test `paperclip-fused.test.tsx:139-144` | M-1 is confirmed, and it has a second trigger. Besides re-`ready`, a slot remount sends `slot null` followed by `slot view` (`threadkeeper-host-slot.ts:21-24,80`). If the two are batched, `slotView` ends unchanged, so the effect never posts `placed`, and the page stays opaque. That matters only while an overlay raises the frame (visual only). The tests flush each message in its own `act()`, so batching is never exercised. The proposed `readyAt` dependency covers re-`ready` only. | REQ-6 FR-3 "placed" contract | Add a `slotSeq` counter, incremented in the reducer's `slot` case, and make it the effect's dependency. Add tests that dispatch `ready`+`slot` and `slot null`+`slot view` inside one `act()`. Owner: `impl-req6-fused`. |
| F-2 (spec M-2) | Minor | `service.ts:186,201,204`; `bridge.ts:338`; `actions.ts:46,97` | Confirmed, with an aggravation. `hasDeliveries` ignores cancelled entries, so a poll that starts after a cancel waits its full 3 s before it returns `cancelledRequestIds`. The loop is roughly 1 s sleep + `syncInventory` + 3 s, against an 8 s window. A cancel that arrives before `byRequest.set` is dropped and never remembered. This is fail-open only for trust removal. The 10 s switch-off path uses the epoch and is unaffected. The proposed fix is right but incomplete. | REQ-11 FR-3 intent | Plugin: count pending cancellations in `hasDeliveries`, and keep listing ids from `settled` until `deadlineAt`. Extension: remember cancelled ids that are not registered yet and apply them at `actions.ts:97`. Owners: `impl-plugin-repair`, `impl-extension-bridge-repair`. |
| F-3 (spec M-3) | Minor (fails closed) | `service.ts:350`; `bridge.ts:264`; `tools.ts:200,203` | Confirmed, and wider than reported. Any unlink, including an agent's own `session_unlink` (`tools.ts:84`), cancels every action in the company, `session.start` included. The extension also aborts every pending action whenever any link disappears (`bridge.ts:264`), with `disabled`. The cancelled actions still count against the 10/hour and 60 s rate limits. The proposed fix (plugin-only `threadKey` match) is right but incomplete. | REQ-11 FR-1 exact texts | Plugin: cancel only `session.send` with a matching `(issueId, threadKey)`, using the FR-1 link text. Extension: abort only actions whose own link vanished. Owners: plugin, extension bridge. |
| F-4 | Minor | `threadkeeper-overlays.ts:79-91`; `ThreadkeeperHostBridge.tsx:62`; `PaperclipFusion.ts:151-166` | **Overlay observer cost.** Expected: overlay checks cost work only in fused mode. Actual: the observer watches `<body>` subtree `style` and `data-state` changes, plus `transitionend` on the whole document. Each batch triggers a full scan: `getComputedStyle` on every body child, plus `querySelectorAll` and `getBoundingClientRect`. It runs whenever the page is framed, even in switching mode and before the handshake. Separately, the notice clip effect has no dependency list, so while a notice shows it reads layout on every App render. Impact: possible jank in the Threadkeeper window (RUNTIME-ONLY). | Design "Performance"; spec F-5 | Coalesce `check` with `requestAnimationFrame`. Start the observer only after a fused `ready`. Give the clip effect `[fused, state.regions, state.overlayOpen]` plus a resize listener. Owner: `impl-req6-fused`. |
| F-5 | Minor | `credentials.ts:121-122` | **Secret cache clear race.** Expected: after `clear()`, no earlier value is cached. Actual: a read that was in flight when `clear()` ran stores its value afterwards. This reopens the 30 s window that REQ-14 AC-6 relies on (settings open → clear). Local consent is still re-checked (`integration-runtime.ts:109`). | REQ-14 AC-6 | Add a generation counter: bump it in `clear()` and store only if the generation is unchanged. Owner: `impl-extension-bridge-repair`. |
| F-6 | Minor | `tools.ts:208,224`; `service.ts:212` | **Worker restart.** After a plugin worker restart, admitted `ActionRecord`s with `completedAt: null` show "Pending" to the founder forever. A late browser verdict is dropped because `results()` consults only the in-memory `settled` map. A retry still gets `unknown_delivery` (safe). | REQ-11 action log | Store `requestId` on the record. Then either let `results()` fall back to the store for incomplete admitted records, or relabel records older than the start budget. Owner: `impl-plugin-repair`. |
| F-7 | Minor | `service.ts:20-22` and `contracts.ts:10,12` vs `bridge-protocol.ts:84` and `integration-runtime.ts:12`; `service.spec.ts:557` hardcodes `1_500` | **Unchecked cross-package invariants.** The deadline chain spans two packages: plugin 5 s margin and 8 s settle vs extension 1.5 s margin and 3 s verdict wait. No test checks them together. The same applies to `MAX_NOTICE_REGIONS` (`host.ts:17`, `threadkeeper-host.ts:15`) and to the `session-board`↔`dashboard` mapping, which appears in four places (`host.ts:19`, `PaperclipFusion.ts:73`, `App.tsx:735`, `PluginPage.tsx:33`). A change on one side passes every suite. | `AGENTS.md` §5.2 | Add a fork-root test (alongside `scripts/threadkeeper.test.mjs`) that imports both packages' constants and asserts that the verdict lands before the plugin's timer and the cancel before the settle ends, and that the limits match. Owners: plugin, extension. |

There are no Blocker or Major findings. Each Minor is a bounded follow-up, and none hides behaviour that an AC requires.

**Not defects (checked):**
- Re-handing an already handed-out request on each poll is deduplicated by `requestTasks` and the action journal.
- `results()` runs outside the per-company lock, but its pending-map mutations are synchronous.
- The late-verdict ordering is covered by NF-9.
- The `Cmd+K` guard at `useWorkbenchKeyboard.ts:96` is correct.

## Verdict

**BLOCKED.** The only reason is one missing required input: the current per-TASK gate results for the in-scope TASKs.
- Cumulative quality scope requires them, and `.plan/workflow.md` says gates are "not waived". The spec report records the load gates as `ok:false`.
- On the code itself, this review found no Blocker or Major. Seven Minors remain (F-1 to F-7), each with an owner.
- **Next action:** attach the current `sdd.py gate --phase complete` result for each in-scope TASK.
  - If the snapshot is unchanged and the gates are `ok`, these findings support PASS, with F-1 to F-7 as follow-ups.
  - Any fix changes the snapshot and needs a fresh spec review before quality review.

Key files:
- `/Users/andrew/dev/threadkeeper/paperclip/packages/plugins/plugin-browser-sessions/src/service.ts`
- `/Users/andrew/dev/threadkeeper/paperclip/extension/src/core/paperclip/bridge.ts`
- `/Users/andrew/dev/threadkeeper/paperclip/extension/src/core/paperclip/actions.ts`
- `/Users/andrew/dev/threadkeeper/paperclip/extension/src/core/paperclip/credentials.ts`
- `/Users/andrew/dev/threadkeeper/paperclip/extension/src/entrypoints/manager/App.tsx`
- `/Users/andrew/dev/threadkeeper/paperclip/extension/src/entrypoints/manager/PaperclipFusion.ts`
- `/Users/andrew/dev/threadkeeper/paperclip/ui/src/lib/threadkeeper-overlays.ts`
