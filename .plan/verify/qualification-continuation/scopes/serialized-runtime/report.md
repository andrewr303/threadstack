# Protected server route qualification

All three scoped suites pass under Node 24.22.2, the unchanged credential-denying SBPL sandbox, the clean environment wrapper, and the task-local signed `ps` executable. No test ran outside the sandbox. No production route/authentication/process-identity check was edited or mocked, no timeout was widened, and no assertion/test was skipped.

## Results

| Suite | Result | Actual duration | Source change |
| --- | --- | --- | --- |
| `maintenance-server-routes.test.ts` | **17 passed** | 262.27 s | None |
| `issue-queued-comments-routes.test.ts` | **139 passed** | 142.36 s | None |
| `issue-confirm-run-stopped-routes.test.ts` | **9 passed** | 19.40 s | Only provider-execution isolation in the existing agent fixture |

Maintenance includes both **90 real-second** observations and their qualified hourly windows. Its ordinary held-task retry executes a real owned Node process; the simulated provider cases remain loopback-only. The declared fixture prerequisite hook prepared plugin SDK dependencies and Runner TypeScript artifacts; no unrelated or live-extension/UI/release build was performed.

The queued-comment suite also completed its original `afterAll` database cleanup. Its old 30-second teardown failure was **not reproduced** in this narrowed run, so neither its timeout nor teardown source was changed. This result does not establish the precise cause of the older broad-run teardown failure.

The confirm-stop suite now passes the successful attestation, refusal while an owned runner remains live, metadata/host/environment refusal cases, deduplication and board-access controls. The success case can resume its `codex_local` successor, so its adapter command is explicitly the current Node executable instead of resolving an operator's Codex binary. The test still asserts that the successor is created and reaches a terminal state; it does not require an actual provider reply.

## Failure classification

The prior maintenance Board-access failures and confirm-stop `runner_still_running` refusal disappear with functioning local `ps` process inspection. The earlier SUID `/bin/ps` restriction was already reproduced separately using only the current process PID; the production identity/confinement algorithms remain intact. The signed task-local copy has the same executable text section and succeeds under the same sandbox while credential-denial canaries remain blocked. Its detailed provenance is referenced in `guards.json`.

No production defect was established in this scoped follow-up. No real operator credential, provider account or helper/service installation was accessed.

## Evidence

- `commands.json`: exact commands, sandbox/cwd/environment-key metadata, start/end timestamps and exit codes, copied unchanged from the runtime wrapper receipts.
- `serialized-*-signed-ps.log` and `.json`: complete execution logs and raw receipts.
- `source-before.json` and `source-after.json`: source hashes. Maintenance, queued comments, the maintenance build helper and the reviewed production process-boundary modules are unchanged.
- `guards.json`: isolation review and process-runtime provenance.

A final scoped `git diff --check` passes. Broader qualification and final integration remain the parent's work; these 165 cases are not a full-suite claim.
