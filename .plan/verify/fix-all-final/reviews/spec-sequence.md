# Independent spec supplement — per-gesture sequence repair

Reviewer: `final_spec_review`, independent of the repair authors. Captured 2026-11-15T05:47:58.196776+00:00. Repository HEAD `4619c07b2a8dcd864e1315ef4964ae2bb0c27490` plus the reviewed working bytes below; source comparison base is `a44541df70ec82717922806085a5aad579b75321`.

## Verdict

**PASS for this narrow source repair. No concrete source defect found.**

Replacing the coarse one-shot close-window consumption with sequence admission permits a second physical primary-mouse press during the same original bounded window. It does not renew that deadline or grant any new operation. The consumer still performs only existing, currently hit-tested session-row selection. Fresh build/probe/full-browser outcomes remain pending; this source verdict is not runtime acceptance or full-plan completion.

## Source and contract assessment

- UI `createThreadkeeperHost` owns the counter in its closure. Callers supply only the existing view/x/y input. The implementation serializes explicit fields and replaces any caller sequence with its own number. It increments only after the existing handshake, announced/current fused mode, reported Threads slot and finite in-slot coordinate guards pass.
- Counter values start at1, increase monotonically for that host object's lifetime across hello/mode/disconnect cycles, and cannot wrap. At `Number.MAX_SAFE_INTEGER` the producer refuses further reports. The exhaustion branch is straightforward source-inspected protection; no receipt claims billions of test executions.
- Extension parsing retains exact frame source/configured origin/version checks and finite frame-viewport bounds. It now additionally requires a positive safe integer sequence. Missing, zero, negative, fractional, string and unsafe integer values are refused before the App callback receives them.
- App retains the last accepted sequence. Invalid packets do not poison the barrier. A duplicate or older accepted sequence is refused; a larger valid sequence can select a different currently registered row within the same original close window. The new code updates the sequence only after current point, connected-row, sidebar, key-registration and existing-conversation checks succeed.
- App no longer consumes the close timestamp on the first accepted row. It also does not rewrite that timestamp on activation. All existing native-press producer guards, fresh-all-overlay checks, current fused Threads slot, recent accepted close, negative/expired close-age, coordinates and nondestructive row-target restrictions remain.
- The unchanged bridge still receives the actual captured native primary mouse pointerdown. There is no event-trust normalization, synthetic click, widened pointer class, generic element activation or provider/agent action in this delta.
- The two docs describe host-owned sequences, refusal of duplicate/older accepted packets, distinct presses within the unchanged250ms window, and no deadline renewal. They do not convert diagnostic39 into a full-browser pass or assert it established an unrelated run's exact cause.

## Sequence, nonce and reset boundary

The sequence is an admission/deduplication identifier, not a cryptographic nonce or a replacement for the existing source/origin trust boundary. Producer counter state is host-object scoped. Parent sequence state resets on a new `ready` or offline event together with invalidation of its accepted-close timestamp and fusion state. Thus a sequence reset alone cannot restore a selection window; a fresh valid handshake/placement and observed overlay close are still needed. An existing host continues with larger numbers after re-handshake, while a new document's new host can restart at1.

The replay barrier is therefore connection/handshake scoped, not a durable global history across arbitrary forged replay by the already trusted UI. This is appropriate to the existing ordered postMessage channel and nondestructive view/session-open authority. Natural per-sender FIFO and the unchanged native producer path remain required assumptions; this review does not certify a new hostile-host security boundary or browser delivery order.

## Test fidelity and receipts inspected

- UI tests assert exact host-generated packets and sequences1..4 across re-handshake/disconnect, ignore caller9000, and show invalid coordinates do not consume a sequence. Existing handshake/mode/slot/bounds refusal cases remain.
- Parser tests cover the new integer boundary and retain old viewport/view negatives.
- The real App regression first rejects no close/open overlay and toolbar activation, accepts row1, refuses the same packet against row2, accepts sequence2 for a distinct row2 press, refuses sequence1 replay against row3, and retains deadline, repeated-close nonrenewal and backward-clock refusal checks. Replacing only the old one-shot expectation is required by the reproduced second-press defect; duplicate rejection was preserved rather than weakened.
- The added fork-root contract runs the actual UI host and actual extension parser. It deliberately supplies caller999, then verifies actual wire packets carry host-owned1/2 through both implementations. It is not a copied mapping assertion.
- I inspected author receipts: UI RED2failed/14passed then39passing focused tests and clean UI typecheck; parent/parser RED2failures then38passing tests;22root guard/contract tests passed. These are author executions, not reruns by this reviewer. The UI receipt hashes match current reviewed bytes. The parent RED and GREEN logs retain the failure and repair separately.
- My validation was read-only source/diff/receipt inspection and scoped `git diff --check`, which exited0. I did not edit product/tests, build, run a browser, publish or change Git history.

## Remaining handoff

Complete the owned fresh build and actual strict repeated-press browser journey, retaining unsuccessful attempts and distinct diagnostics. Then obtain independent quality review against this same source identity and combine current aggregate checks. Existing formal/external limits remain: no implied live deployment, helper/service installation, real providers/keys, native consent, MV3 suspension, live-library continuity or full Paperclip qualification.

## Reviewed source/test/document hashes

These nine input hashes identify the actual working snapshot and exclude unrelated capture/harness/metadata changes.

| Path | SHA-256 |
| --- | --- |
| `ui/src/lib/threadkeeper-host.ts` | `2c5c5cec56b7feaf83ee1ed0ae331d9c4cf9755ccdcb636e218a4e2319a67c03` |
| `ui/src/lib/threadkeeper-host.test.ts` | `45eb2c320e7147ae71d01496c9d247acade9b0ae8a1ce57a80e85714c008b142` |
| `extension/src/core/paperclip/host.ts` | `9b6fc5e8d37295dec602d4b063f3632dce63e72ee281017bf019a72b7a1daf5e` |
| `extension/tests/unit/paperclip-host.test.ts` | `7ebb35713737f7e8a090c8512bc7bca6d3f5cdad573154b1a6a5470194ba214a` |
| `extension/src/entrypoints/manager/App.tsx` | `51360a1c801d23ad6d35bacb035410ee12cbf81d8148ae554091db14279cba68` |
| `extension/tests/unit/paperclip-fused.test.tsx` | `6267fb659b10dbf2f4327e00fddd9d665e82b5c2a0ac66e114139c14ed8935fc` |
| `scripts/threadkeeper-contracts.test.mjs` | `7493c8dbc4bf3c6fa08cf28cf58596ae13019a0867cbd417752a367db7109247` |
| `.plan/reqs/REQ-6-design.md` | `2fbd7c81218d81b56aa3215136f8c78e6d236f3cd8a472bfa58a66252c666dea` |
| `.plan/reqs/REQ-6-ui-supplement.md` | `9c9d384bf28414caa614bf5ac33d51fbe9ebf3439037c3aba5ff129e16145fc4` |
