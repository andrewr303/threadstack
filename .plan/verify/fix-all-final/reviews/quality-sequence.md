# Independent quality supplement — per-gesture sequence repair

Reviewer: `final_quality_review`, independent of every implementation author. This read-only review follows the spec PASS in `/tmp/tk-fix-all/final-sequence-spec.md`. Scope is exactly the nine committed changes from `a44541df70ec82717922806085a5aad579b75321` to `4619c07b2a8dcd864e1315ef4964ae2bb0c27490`; prior unchanged source retains the earlier quality assessments.

## Technical verdict

**PASS. No concrete blocker, major or minor code-quality defect found in this narrow repair.** All nine working hashes match the spec report and reviewed commit. This is a source/protocol verdict, separate from the final Chrome/Edge outcomes and external/formal qualification gates.

## Assessment

- The UI host owns activationSequence in its closure. It serializes explicit view/x/y fields and its own incremented sequence, ignoring a caller-supplied sequence. Existing handshake, announced/current fused mode, current reported Threads slot, finite coordinates and in-slot bounds all run before increment. Rejected input does not spend a number. The counter survives that host object's hello/mode/disconnect cycles and refuses at MAX_SAFE_INTEGER rather than wrapping. The exhaustion branch is source-inspected protection, not a claimed exhaustive runtime test.
- The extension parser still performs the exact frame source, configured origin and protocol checks, then the existing view/finite viewport-coordinate checks. It now requires a positive safe-integer sequence; missing, string, zero, negative, fractional and unsafe values are rejected before App receives them.
- Parent admission rejects a duplicate or older accepted sequence while allowing a larger sequence for another real press in the same original close window. The barrier advances only after every existing current-fused-Threads, no-open-overlay, nonnegative/unexpired close-age, actual frame/slot point, connected sidebar row, registration and current-library-key check succeeds. Invalid input does not poison the barrier. The consumer still calls only existing session selection and row focus; it neither dispatches a DOM click nor activates toolbar/destructive/provider/agent actions.
- Activations no longer erase the whole close timestamp, but also never update or renew it. Repeated closed reports still do not renew it, and new overlays invalidate it. The unchanged producer requires an actual trusted exclusive primary-mouse pointerdown in the current empty placed slot, same-slot observed close, a fresh all-blocker scan and the same250ms window. No mouse flags are normalized or synthesized, no pointer type is widened and no forced close packet is added.
- Reset behavior is appropriately bounded: the host counter persists for its object lifetime; a new document can create a new counter. The parent's accepted-sequence state resets on ready/offline together with invalidation of its close window/fusion state. A reset alone therefore supplies no selection opportunity; fresh valid placement and a subsequent accepted close remain necessary. This is connection/handshake-scoped admission on the existing ordered trusted-frame channel, not a cryptographic nonce or durable hostile-host replay boundary. The UI already has session/view opening authority; the delta adds no generic UI privilege.
- Regression tests retain toolbar/no-close/open-overlay refusal, duplicate rejection, stale/expired/repeated-close and backward-clock checks while adding a distinct sequence2 press and sequence1 replay refusal. The old one-shot expectation is replaced because it was the reproduced defect, rather than deleting deduplication coverage. Producer tests assert host-generated1..4 despite caller9000, refusal without a current slot after hello/disconnect, and no sequence consumption on invalid coordinates. The root contract executes the actual UI host and extension parser for host-owned1/2 despite caller999. The two documentation sidecars accurately describe the unchanged deadline and accepted-sequence scope.

## Validation boundary

I inspected the actual nine-file diff and the modified producer/parser/consumer paths, compared working/spec/commit hashes, and ran `git diff --check` for the exact commit range; it exited0. I made no source/test edits, builds, browser actions, Git mutations or publication calls.

The lead reports diagnostic39 reproduced the second-press loss and qualifying probe41 exercised two trusted child presses with ordered overlay→activation1→activation2 selection and an outside-dismiss negative. I did not independently operate or certify those browser runs. Keep those diagnostics, prior unsuccessful rounds and the unexplained individual earlier miss separate from the fresh full Chrome42/Edge43 qualification. Current aggregate passes and native consent, real providers/model keys, helper/service, MV3 suspension, live-library continuity and broad Paperclip/formal gates remain separately reported evidence. This technical PASS does not waive them or certify a live deployment.

## Reviewed identity

Captured 2026-11-15T05:50:13.660153+00:00; reviewed commit `4619c07b2a8dcd864e1315ef4964ae2bb0c27490`. All nine hashes match preceding SPEC and committed/current bytes.

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
