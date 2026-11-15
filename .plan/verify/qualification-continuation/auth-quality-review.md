# Independent quality/security review — Darwin socket-owner fallback

Reviewer: `final_quality_review`, independent of the implementation author. Read-only review following `/tmp/tk-continue/auth-spec-review.md`. Scope: the frozen process-boundary module and its two test deltas, identified below. I also checked the immediate unchanged authentication/classification and authority-retirement context needed to assess these changes.

## Technical verdict

**PASS for this bounded compatibility repair. No concrete blocker, major or minor source defect found.** Current hashes match SPEC, source-after/final snapshot identity and the reviewed frozen bytes. This is a quality/security source verdict, not fresh browser ingress or broad/hosted qualification.

## Process ownership and parser

Netstat remains first and its supported PID or missing-owner result is retained. Only per-socket unsupported observations are candidates for lsof, so a supported missing/agent refusal is not replaced by a second inspector. Both socket ports must be integer1..65535. Fallback arguments consist only of fixed flags and deduplicated validated numeric server ports; addresses and request strings never become executable options or shell input. The direct asynchronous execFile call has no shell, a5second timeout and1MiB output cap. The optional executor parameter is an internal test seam, not a request-controlled command selector.

The lsof parser follows process/file/name records. PID records require positive safe integers and reset descriptor context; descriptor records require numeric file markers. Endpoint parsing requires numeric IPs and valid ports. Matching requires both normalized client-local and server-remote address/port pairs in the correct direction, excluding reverse/server descriptors and nearby connections. Duplicate matching descriptors from the same PID deduplicate; distinct matching PIDs are ambiguous and yield no owner. Missing/malformed ownership cannot establish a valid match; unrelated fields are ignored rather than claiming whole-output syntactic attestation. Malformed PID records cannot carry the previous PID into a later descriptor.

Before using a fallback PID, signal0 checks current liveness. ESRCH and other nonpermission failures return no owner; EPERM is treated only as liveness without signal permission. The unchanged ps ancestry/environment/runner-marker classifier must still classify that PID. Finding a socket owner is not itself board authentication or operator status. The existing socket-object cache, serialized batching and per-socket output order remain; no cross-socket PID/authorization cache or fallback actor bypass was added.

## Failure and policy boundary

A successful empty/malformed/no-unique-owner fallback returns missing ownership and is refused by the existing classifier. lsof's exit1 is accepted as empty selection only when both stdout and stderr are exactly empty. Failed/timeout/truncated output is not parsed as successful ownership. A capability failure retains unsupported only for sockets whose netstat inspection was already unsupported, without discarding known neighboring results.

The existing local-trusted policy permits unsupported inspection with a warning. This repair does not change that policy to fail-closed, eliminate its assumptions, or cryptographically attest PIDs. It narrows previously unsupported observations where the OS supplies exact ownership, rather than adding a new grant. Explicit credential handling and actor middleware are unchanged. A socket snapshot plus liveness also retains the existing per-connection/PID lifecycle assumptions; this review does not claim a new mutually-untrusted-local-user security boundary.

## Tests and archive evidence

The real IPv4 actorMiddleware cases retain ordinary-operator board access and refusal for an owned synthetic agent and a tool that clears its own environment. New Darwin IPv6 cases exercise the same real HTTP/process boundary. The executor fixture is used only for capability/empty-output/argument-bound probes, not to fabricate live owner identity in those HTTP observations. Pure parser tests cover direction, IPv4/IPv6/mapped forms, duplicates/ambiguity, malformed records and invalid ports. Existing unknown-owner, mixed-batch, marker/ancestry and connection responsiveness controls remain. No security assertion, timeout or existing Linux-only platform guard is weakened.

The damaged-epoch test now follows the unchanged authoritative root-entry/retirement contract: authority-epochs retire with the prior session into continuity-breaks. It still requires exact damaged runner-state SHA256 preservation, unchanged pending semantic input, replacement/provider/task results and termination of owned daemons. It additionally requires that no retired authority-epochs remain active. This repairs the expected evidence location and strengthens retirement refusal; no production archive/recovery path changed.

## Validation and runtime claim limits

I inspected the actual source/diffs, final snapshot, author report and final direct-suite/typecheck/formatting receipts. Those author results are36passed with12existing Linux-only skips, seven server type layers passing, and one selected damaged-epoch case with70unselected cases outside that receipt. Supplemental ordinary/protected six-case owned HTTP matrices are process-classification evidence, not browser UI proof. The recycled-PID narrowed pass does not identify the exact cause of its earlier broad failure. The retained formatting receipt establishes identical emitted JavaScript for the final indentation-only delta; its current source hash matches this review.

My checks were scoped git diff whitespace (exit0), current/SPEC/final-snapshot hash comparisons and direct HEAD preservation checks for auth.ts, native-session-executor.ts, native-session-root-entries.ts and hot-restart.ts. All pass. I did not invoke lsof/ps, inspect operator credentials/process environments, operate a browser/provider, build, run broad tests or mutate source/Git/publication state.

Combine this source verdict with fresh ingress acceptance and actual broad/CI status. Unsupported-policy/platform limits, prior failed attempts and filtered-test scope remain explicit. No formal/provider/native-service gate is waived.

## Reviewed changed identity

Captured 2026-11-15T09:39:47.149357+00:00; HEAD `48275586efb8641ab8e763d378e6d5e676dc6681` plus current working bytes. All3match SPEC and final snapshot. The4unchanged policy/retirement context files match HEAD.

| Path | SHA-256 |
| --- | --- |
| `server/src/middleware/local-agent-process-boundary.ts` | `19a1e50c9f6e892455aeb8e75372c54ae678494c4181b4871c64651e1c2e9b01` |
| `server/src/__tests__/local-agent-process-boundary.test.ts` | `266a52c98c3972af17846e5aa094889061a2be4bc2b05cba6e4f0029c726e6dd` |
| `server/src/services/native-runtime/native-session-resume.test.ts` | `a41e97469f095f089ffd3f05797d0f61bbb3bf990c1e7421abae2d497fb97c27` |
