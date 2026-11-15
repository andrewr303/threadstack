# General runtime failure repair and qualification

The frozen production file is `server/src/middleware/local-agent-process-boundary.ts`; its exact hash and all changed test hashes are in `final-snapshot.json` and `source-after.json`.

## Actual results

| Check | Result | Raw receipt / log |
| --- | --- | --- |
| Direct process-boundary suite, Node 24 + credential-denying sandbox + signed task-local ps, explicit compatibility preload | **36 passed, 12 existing Linux-only skipped**, exit 0 | `general-boundary-fallback-final.json`, `.log` |
| Server layered TypeScript | **All seven layers pass**, exit 0 | `general-boundary-server-types.json`, `.log` |
| Damaged prior epoch, targeted real runnerd/fake-provider recovery | **1 passed**; 70 tests not selected by the filter | `general-damaged-epoch-fixed.json`, `.log` |
| Recycled live-PID refusal, targeted owned process | **1 passed unchanged**; combined initial targeted run also retained the epoch failure | `general-native-ps-compatible.json`, `.log` |
| Ordinary clean environment, stock system ps/lsof, no sandbox/preload | **6/6 owned real HTTP probes pass** | `owned-http-ordinary.json`, `.log` |
| Protected clean environment, signed ps + compatibility preload | **6/6 same owned real HTTP probes pass** | `general-owned-http-protected.json`, `.log` |

The seven typecheck layers are below, cycle, above, tests, and test-tree-0 through test-tree-2. The existing typecheck script prepared only its declared Runner TypeScript/plugin SDK inputs. No extension/UI/release build was performed.

The final source formatting change only corrected indentation inside `findDarwinPeerPids`; `formatting-integrity.json` verifies byte-identical emitted JavaScript before/after that formatting. The production file is now frozen for the parent's independent review and browser acceptance.

## Production cause and bounded repair

On this macOS host, `netstat -anv -p tcp` exits successfully with no TCP snapshot. Even unfiltered `netstat -anv` exposes no TCP rows. This occurs both outside and inside the credential-denying sandbox. The real existing negative HTTP tests therefore receive the inspector's established `unsupported` classification and implicit local board access.

An owned live loopback TCP fixture proves that lsof can identify the exact socket/PID even when netstat cannot. Raw controls retain only snapshot sizes/headers and the owned tuple/PID; no unrelated user socket details are stored. An independent owned-child ancestry probe proves the unchanged ps-based classifier recognizes a synthetic agent marker without inspecting operator ancestors.

The repair preserves netstat as the fast path. Only unsupported snapshots use one asynchronous direct lsof query, restricted to validated numeric server ports, established TCP sockets and process/file/name fields. The query has a 5-second timeout and 1 MiB output cap and uses no shell. The parser requires an exact normalized client-to-server tuple and a unique, live PID. Duplicate file descriptors from one PID are accepted; distinct matching PIDs, missing ownership and malformed records are refused. Existing ps ancestry, marker classification and authorization policy are unchanged.

A successful empty lsof selection, including its exit-1/no-stdout/no-stderr convention, means missing ownership and is refused. Executable/capability errors, timeout and output-limit failure remain `unsupported`. The existing unsupported-platform policy still permits implicit local-trusted access with a warning; this repair does **not** change that policy to blanket denial or a broader grant.

New tests cover IPv4, IPv6, mapped IPv4, exact direction/ports, duplicate/ambiguous owners, missing/malformed ownership, invalid ports, command bounds and capability failure. The real HTTP matrix proves operator acceptance, agent refusal and refusal after an agent tool clears its environment over IPv4 and IPv6. Existing mixed-batch/unknown-owner/connection-burst checks remain intact.

## Other two failures

The damaged-epoch test expected retired `authority-epochs` in the active session root. The production root-entry contract explicitly moves those epochs into the continuity archive to prevent retired authority from being revived. The test now reads `continuity-breaks/<archive>/authority-epochs/<epoch>/runner-state.json`, retains the exact damaged-byte digest and pending semantic input checks, and additionally asserts no retired authority-epochs remain active. No native recovery production code changed; real daemon retirement, fake-provider completion, result/event and task identity assertions all pass.

The recycled-PID test passes unchanged in the narrowed run. The broad failure was `ps -o lstart= -p <owned sentinel>`; the narrowed outcome replaces only that case, not the broader shard result. No timeout or process-identity check was widened or relaxed.

## Red/green, scope and remaining work

Original real HTTP REDs and native archive failure are retained in the initial targeted receipts. The first new capability-test attempt encountered a Vitest ESM built-in spy restriction; those failed attempts are preserved. The final tests use an explicit command-executor seam only for dependency-error/empty-output probes, never fabricated live identities. All live acceptance/refusal observations use actual owned processes and socket metadata.

Only the inspector module, its direct tests and the justified damaged-epoch test changed. `source-before.json`/`source-after.json` confirm the other reviewed production/native files and recycled-PID test are unchanged. No actual provider/login, ambient credential, user service, Git publication or workflow operation was performed. The ordinary supplemental probe imported only the pure inspector/logger module, created owned localhost servers/Node children with synthetic markers, inspected no operator process environments, and closed all owned resources.

Independent security/spec review and browser acceptance for the changed local-trusted ingress remain the parent's work. This report is not a full-suite or browser pass.
