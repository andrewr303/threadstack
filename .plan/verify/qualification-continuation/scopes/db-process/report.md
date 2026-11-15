# Database process-drain qualification

**Both remaining tests pass** under the explicit absolute-`ps` compatibility runtime:

- SIGTERM: 11.332 s.
- SIGINT: 11.582 s.
- File total: 2 passed, 0 failed, 25.63 s including startup/transform.

The assertions establish that the command's descendants stop before PostgreSQL shuts down, PostgreSQL remains available during child cleanup, command-owned PostgreSQL directories are removed, and descendant PIDs are absent or zombies. No assertion, source, timeout or skip policy was changed.

## Runtime boundary

This is **not stock-system execution**. The ordinary earlier database run remains **457 passed, 2 failed, 1 existing skipped** and its raw receipt/log are preserved unchanged as `workspace-db-node24.*`. The original failure was absolute `/bin/ps` execution under the credential-denying macOS sandbox, bypassing the task PATH.

The opt-in `--ps-compat` wrapper injects `NODE_OPTIONS=--require=/tmp/tk-continue/runtime/ps-compat.cjs`. That qualification-only preload redirects exactly `child_process.execFile('/bin/ps', ...)`, including its custom promisify implementation, to the parent's signed unprivileged task-local `ps`. It delegates to the original implementation and fabricates no process data or command results. Other command paths are unchanged. The signed copy has identical executable text to the untouched system binary.

The own-PID compatibility control reports the actual start time, while the credential canary remains denied (`absolute-ps-control.log`). Tests retain the same clean environment and credential-denying SBPL profile. No test ran unsandboxed; no provider, live application, credential or remote workflow action was performed.

## Cleanup and integrity

`cleanup-audit.json` records an exact-fixture-signature PID check after the passing tests. It found no surviving root/grandchild fixture processes. The prior failed attempt's known `paperclip-command-cancel-XRU8uu` directory is absent. No process needed signaling, and no other jobs/services were touched.

`integrity-before.json` and `integrity-after.json` match for all reviewed repository test/helper/fixture files and runtime compatibility inputs. There were **no source edits** or builds.

Exact command, cwd, environment-key metadata, sandbox, opt-in runtime flag, timestamps and exit code are preserved in `db-command-ps-compatible.json`; full output is in its `.log`. The parent's broader qualification remains separate.
