# Bootstrap retry and workspace cleanup fixture qualification

Both assigned files pass: **14 tests, zero failures or skips**, with the original assertions and deadlines retained. Only two test fixtures changed. The production native-provider and canonical workspace-cleanup guards are unchanged and match source HEAD `48275586efb8641ab8e763d378e6d5e676dc6681`.

## Evidence and repair

The complete unchanged-file RED run reproduced both broad-run failures: 12 passed and two failed.

- `native-ingress-bootstrap-retry.integration.test.ts`: the OpenCode case passed the controller's `process.execPath` as its remote provider Node artifact on macOS. The real admission guard refused it with `runner_remote_provider_artifact_incompatible: provider Node path belongs to the controller host`, before the intended first HTTP 502. The existing fixture already copied Node into its owned runtime directory on Linux. It now does the same for OpenCode on every platform, retaining the exact artifact digest and read/execute-only permissions. Both Codex and OpenCode still exercise real Runner bootstrap failure/reacquisition, one provider invocation, sealed state, one durable result, and exactly-once accounting through owned fake providers and loopback HTTPS.
- `workspace-instance-cleanup.test.ts`: the injected stopper expected the noncanonical macOS `/var/...` spelling while the production guard correctly supplied `/private/var/...`. Its expected database path now uses `fs.realpath`, preserving exact identity rather than bypassing comparison. The instance must still exist when stopped, and the recorded order remains exactly `stop`, then `remove`. All other ownership, containment, symlink and ESRCH assertions are unchanged.

## Verification

Runtime: Node 24.22.2, Vitest 5.0.3, the parent's credential-denying macOS sandbox, cleaned provider environment, task-local pinned Rust and owned fake-provider fixtures. No real provider account, key or command was used. No `HOME` override, production policy edit, timeout increase, assertion removal, skip or process-inspection compatibility shim was added.

The RED and GREEN commands run the same two complete files through `run-qualification.py`, with `--project @paperclipai/server --maxWorkers 1 --no-file-parallelism`. Their exact commands, runtime policy, process groups and results are in the adjacent JSON/log pairs.

| Receipt | Result |
| --- | --- |
| `bootstrap-cleanup-red` | Exit 1; 12 passed, two failed; both exact causes captured |
| `bootstrap-cleanup-green` | Exit 0; both files and all 14 cases passed; no received signals |
| `bootstrap-cleanup-types` | Exit 0; both edited files checked with the repository's normal `run-tsc.mjs` and existing declaration references |
| Scoped `git diff --check` | Exit 0 |

The generated narrow typecheck config lives only in the ignored task cache, with a retained copy here. `receipt.json`, `source-before.json`, `source-after.json`, `production-preservation.json` and `change.patch` pin the exact scope. Debugging followed the required ult-debugger router and TypeScript specialist; the retained triage output does not substitute for the complete assertion stacks.

This qualifies these two files only. It does not qualify the remaining general lanes, platform-specific long-path tests, hosted CI, browser UI, or real providers. Source HEAD and delivery state were not changed.
