# Independent spec/security review — Darwin peer-process compatibility

Reviewer: `final_spec_review`, independent of the repair author. Captured 2026-11-15T09:35:14.316083+00:00. HEAD `48275586efb8641ab8e763d378e6d5e676dc6681` plus the three reviewed working inputs below. Their bytes match `general-runtime/source-after.json` and `final-snapshot.json`; no reviewed source drift remains.

## Verdict

**PASS for this bounded production compatibility repair and its two test deltas. No concrete source defect found.**

The fallback supplies an additional exact socket-owner observation where the existing netstat inspector was unsupported. It does not replace actor authentication, ps ancestry/environment classification, or the existing unsupported-platform policy. A successful fallback with missing, malformed or ambiguous matching ownership does not grant board access. The damaged-epoch change repairs a stale test location and strengthens the active-root refusal assertion; it is not a production archive-layout change.

Fresh browser-ingress results and final broad/CI qualification remain separate inputs. This review does not claim operator browser acceptance, full-suite completion or new provider/native-service evidence.

## Fallback ownership and command boundary

- Netstat stays first. Supported netstat owner or missing-owner results are retained without a second command. Only per-socket unsupported results are replaced by fallback observations. Thus this repair cannot convert a supported netstat refusal into a fallback grant.
- Server/peer ports must be integers1..65535. The lsof argument vector is constructed from deduplicated validated server ports, with fixed -nP, established-TCP and machine-field options. No address, executable option or shell text comes from a request. Execution uses direct execFile, no shell, an asynchronous5second timeout and1MiB output cap. The preexisting netstat/ps command bounds remain unchanged.
- The parser treats lsof as PID/file/name records. A new PID or descriptor resets its ownership context. Endpoints must parse as numeric IP addresses and valid ports; both client-local and server-remote address/port pairs must match in that direction. It retains the existing loopback/mapped-address normalization rather than matching only a port or the server's reverse descriptor.
- Matching repeated descriptors from one PID deduplicate. Two distinct matching PIDs are ambiguous and return no owner. Missing/malformed records do not preserve a stale PID context. Returned PIDs are positive safe integers, and the production path checks liveness with signal0; ESRCH/other nonpermission failures refuse ownership. EPERM means a live process whose signal permission is unavailable, not a new operator classification. The unchanged ancestry policy still decides whether that PID is an agent.
- The command is limited to established TCP sockets on the relevant server ports; arbitrary filenames/process names are not interpreted as socket records. Batching and its per-socket result order are retained. The existing socket-object WeakMap and serialized scan queue are unchanged; no cross-socket PID cache or new authorization cache was introduced.

## Failure distinctions and authorization

| Observation | Result and unchanged policy consequence |
| --- | --- |
| Successful exact unique live fallback owner | The existing ps ancestry/environment/runner-marker classifier determines operator versus agent. Finding a PID alone never grants operator status. |
| Successful empty fallback, including lsof exit1 with exactly empty stdout/stderr | No owner; existing classifier refuses implicit board access. |
| No valid matching owner, or multiple distinct valid matching owners | Missing/malformed ownership records cannot establish the required unique match, so this result is refused. Unrelated records are ignored; the parser does not claim whole-output syntactic validation. Partial output after a command failure is not parsed as successful ownership. |
| Missing executable/capability error, timeout or output-cap failure | Retains unsupported for the sockets whose netstat inspection was already unsupported. Existing local-trusted unsupported handling permits implicit access with a warning. This policy was not changed or claimed to become fail-closed. |
| Mixed batch | Known per-socket results are retained; an unsupported neighbor does not replace an identified agent refusal. |

The real server environment and actor middleware are unchanged. Explicit credential handling is unchanged. The fallback narrows previously unsupported observations when the OS can identify them; it introduces no broader grant than the old unsupported case. This is not a claim that local-trusted mode authenticates mutually untrusted local users, cryptographically attests a PID, or eliminates the existing per-connection snapshot/unsupported-policy assumptions.

## Direct test fidelity

The actual actorMiddleware HTTP cases still require board/local_implicit for ordinary owned processes and none for synthetic agent processes, including a tool that clears its own environment. New real IPv6 cases exercise the same acceptance/refusal behavior using owned Node children. These observations use real socket and process metadata, not fabricated live IDs.

Pure tests independently cover exact direction, IPv4/IPv6/mapped forms, duplicate versus ambiguous owners, missing/malformed records, invalid ports, bounded no-shell arguments and unavailable/empty command results. The command-executor injection is confined to capability/empty-output probes; it does not replace production identities in the real HTTP tests. Existing connection-burst responsiveness, mixed-batch, environment/ancestry and unknown-owner assertions remain.

No timeout or security assertion was weakened. The12Linux-only skips in this macOS result are existing guards and are not passes; the new IPv6 real-process cases are correctly Darwin-specific.

## Damaged-epoch test

I inspected the unchanged root-entry contract and continuity retirement path. Authority epochs belong to the retired session and move into continuity-breaks with the other authoritative state. The repaired test reads that archive, still compares the exact damaged runner-state SHA-256, still checks pending semantic input equality and replacement/provider/task outcomes, and now also asserts the active root has no retired authority-epochs. It retains owned-daemon termination assertions. Production native-session execution/archive code is byte-identical to HEAD.

## Receipts inspected

These are author-run executions, not reruns by this reviewer:

- `general-boundary-fallback-final.json/.log`: Node24protected direct actor-boundary suite,36passed and12existing Linux-only skipped, exit0.
- `general-boundary-server-types.json/.log`: all seven server typecheck layers complete, exit0. The command prepared its declared Runner TypeScript/SDK dependencies; this is not a UI/extension/release build claim.
- `general-damaged-epoch-fixed.json/.log`: one selected real-runnerd/fake-provider recovery case passed;70unselected cases are not qualified by that filtered receipt.
- `owned-http-ordinary` and `general-owned-http-protected`: each six owned HTTP classification probes passes the IPv4/IPv6 operator/agent/cleared-environment matrix. Those supplemental probes return the boundary's classification directly; the separate direct suite supplies actual actorMiddleware acceptance/refusal proof. Neither is browser UI evidence.
- The owned socket probe records netstat's unsupported result for its held socket, and the separate ancestry control isolates the existing synthetic marker classification. Neither claim depends on reading actual operator credential contents.
- Final helper indentation is the only change after the passing code runs. `formatting-integrity.json` records identical emitted JavaScript, and direct source-diff review shows no statement/interface/literal change in that final formatting delta.

I ran only read-only source/diff/receipt identity comparisons and scoped whitespace checking, which exited0. I did not execute lsof/ps, a browser, a build, a provider, a broad suite or a publication action. Final author hash maps match current bytes. I also compared auth.ts, native-session-executor.ts, native-session-root-entries.ts and hot-restart.ts directly with HEAD; they are unchanged by this repair.

## Handoff

Proceed to independent quality/security review against this exact scope, then combine its verdict with the fresh Chrome/Edge ingress evidence and actual broad-run/CI status. Preserve unsupported-policy and platform limits, prior failures and filtered-test scope. No formal/provider/native-service gate is waived by this source verdict.

## Reviewed changed input hashes

| Path | SHA-256 |
| --- | --- |
| `server/src/middleware/local-agent-process-boundary.ts` | `19a1e50c9f6e892455aeb8e75372c54ae678494c4181b4871c64651e1c2e9b01` |
| `server/src/__tests__/local-agent-process-boundary.test.ts` | `266a52c98c3972af17846e5aa094889061a2be4bc2b05cba6e4f0029c726e6dd` |
| `server/src/services/native-runtime/native-session-resume.test.ts` | `a41e97469f095f089ffd3f05797d0f61bbb3bf990c1e7421abae2d497fb97c27` |

Unchanged policy/retirement context also checked:

| Path | SHA-256 |
| --- | --- |
| `server/src/middleware/auth.ts` | `fe62980283e67662d0c2ecf5905bd54288737cd4faf7a9f3ad21480783839083` |
| `server/src/services/native-runtime/native-session-executor.ts` | `f515bcfa3644c9ce3ae762176c100d6da0ef262e4207c76886b6d3a40fbf844c` |
| `server/src/services/native-runtime/native-session-root-entries.ts` | `fdd06b6513b7e03774320d62431bb69488ef13f34b95a0155bf0d6a93403112a` |
| `server/src/services/hot-restart.ts` | `ce34639157481d3cfba6652e068cf37568d95567066ad182382a1b2ccf2653be` |
