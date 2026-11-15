# Heartbeat general-lane recheck

Current status: completed. The repository case, all 41 repaired execution-configuration tests, targeted types, and the final unmodified serial queue/completion run (259 tests plus both hooks) pass. Historical failures, diagnostic observations, and exit-143 attempts remain separately retained. Only the authorized execution-configuration test fixture changed; no production code or test deadlines changed.

## Original interrupted qualification

- `general-shard-2-node24.log:591804`: `heartbeat-project-repositories.test.ts` — `prepares an authorized configured sibling independently of private task filesystem history (absolute_path)` failed after 20,793 ms. The summary reports 46 passing / 1 failing case. The assertion/error section was not emitted before interruption.
- `general-shard-3-node24.log:310502-310503`: `heartbeat-execution-configuration.test.ts` — `delivers the selected credential in an isolated home and removes it after completion` (1,416 ms) and `cleans acquired credentials and redacts diagnostics when later skill preparation fails` (1,098 ms) failed. The summary reports 39 passing / 2 failing cases. No precise assertion/error section was emitted before interruption.
- `general-shard-2-node24.log:463271`: `queue.test.ts` has a failing suite indicator and 102 listed tests; its displayed case rows pass. The hook failure's exception text is absent from the interrupted log.
- `general-shard-3-node24.log:306353`: `run-completion.test.ts` has a failing suite indicator and 157 listed tests; its displayed case rows pass. The hook failure's exception text is absent from the interrupted log.

Exact retained excerpts: `original-findings.txt`. Source revision and four test-file hashes: `source.json`.

## Recheck environment and scope

Both attempts used `/tmp/tk-continue/runtime/run-qualification.py`, Node 24.22.2, the existing macOS protection profile, stripped provider environment, isolated Git config and host-port leases. Existing test and hook timeouts were preserved.

1. `heartbeat-config-repos-recheck`: two files filtered to the three named failing cases, `--maxWorkers=1`.
2. `heartbeat-queue-completion-recheck`: both complete hook-affected files, `--maxWorkers=1`.

Both owned exec handles returned exit 143 before a final Vitest summary. The wrapper processes also ended before writing their completion receipt; their original JSON files still say `running`. `interrupted-attempts.json` records the actual tool-observed exit codes without rewriting those receipts. The process tree no longer contained either owned command when inspected. External termination is suspected; its cause is not established.

## Next

This historical next step was superseded by the lead-approved isolated successors below. The termination cause remains unknown; interrupted attempts are not passes.

## Isolated successor attempts (in progress)

The lead approved one retry per unchanged scope after adding isolated child sessions and PID/PGID/signal receipts to the protected wrapper. No termination cause is claimed.

- `heartbeat-config-repos-isolated`: exec handle 82001, wrapper PID/PGID 37007/37007, child PID/PGID 37140/37140; receipt `/tmp/tk-continue/runtime/heartbeat-config-repos-isolated.json`, raw log `/tmp/tk-continue/runtime/heartbeat-config-repos-isolated.log`.

- `heartbeat-queue-completion-isolated`: exec handle 25331, wrapper PID/PGID 37144/37144, child PID/PGID 37278/37278; receipt `/tmp/tk-continue/runtime/heartbeat-queue-completion-isolated.json`, raw log `/tmp/tk-continue/runtime/heartbeat-queue-completion-isolated.log`.

## Isolated findings and authorized fixture repair

`heartbeat-config-repos-isolated.json` completed with exit 1 and no received signals: the absolute-path repository case passed in 2,754 ms; both managed-credential cases failed reproducibly. The exact setup failure was `EPERM: operation not permitted, open '/Users/andrew/.codex/config.toml'`. It caused the first run to finish `failed` instead of `succeeded` (test line 761), and the second to fail before acquiring its managed home (test line 809).

The read owner is `assertManagedAiProjectAuth` in `server/src/services/ai-connection-runtime.ts`: it checks `.codex/config.toml` from `config.cwd` (or `process.cwd()`) through every ancestor. `CODEX_HOME` is not the project's configuration-check root. These fixtures omitted `adapterConfig.cwd`, so the checkout's ancestry reached the operator's home. The protected runtime correctly refused that read. This is a test fixture dependency, not proof of a credential-cleanup product defect.

The lead authorized a minimal fixture-only repair. `seed()` in `server/src/__tests__/heartbeat-execution-configuration.test.ts` now creates `<owned temporary home>/projects/<company>/.codex/config.toml` and passes that project's directory as `adapterConfig.cwd`. The real project-authentication check, managed-credential admission, isolated runtime home, secret redaction, and cleanup assertions remain active. No HOME override, production policy change, exception suppression, deadline change, or assertion weakening was introduced. Existing teardown removes the owned temporary root.

| Verification | Scope | Outcome | Receipt |
| --- | --- | --- | --- |
| Isolated reproduction | Three previously failing cases | Repository case passes; two credential cases reproduce | `/tmp/tk-continue/runtime/heartbeat-config-repos-isolated.{json,log}` |
| Fixture repair | Whole execution-configuration file | 41 tests passed; exit 0; no received signals | `/tmp/tk-continue/runtime/heartbeat-execution-config-fixture-green.{json,log}` |
| Targeted types | Changed test and imported test helpers, using existing generated production declaration references | Exit 0 | `/tmp/tk-continue/runtime/heartbeat-config-fixture-types.{json,log}` |
| Queue/completion | Both complete files, including unchanged hooks | 259 assertions pass; two afterAll hooks time out at 30,000 ms; exit 1; no received signals | `/tmp/tk-continue/runtime/heartbeat-queue-completion-isolated.{json,log}` |

The targeted type configuration is `tsconfig.heartbeat-execution.json`. It reuses the repository's existing below/cycle/above declaration layers and does not requalify all production TypeScript. `source-after-fixture.json` records the post-repair hashes beside the original hashes in `source.json`.

## Hook diagnosis after the full recheck

The full two-file isolated run reproduced both exact hook failures: `queue.test.ts:136` and `run-completion.test.ts:170` timed out in `afterAll` after 30,000 ms, while every one of their 259 assertions passed. The run completed normally with exit 1 and no received signals. This is separate from the earlier external terminations.

A temporary, minimal first-case probe logged entry and resolution around each suite's initial `db.$client.end()` call. Both selected cases and both hooks passed (2 passed, 257 skipped; exit 0; no received signals). Its raw receipt is `/tmp/tk-continue/runtime/heartbeat-client-end-diagnostic.{json,log}`. This proves only that the minimal first-case state closes cleanly. It does **not** locate the full-suite hang or establish that an unbounded client close, a process-inspection capability, or shared database cleanup is responsible. The diagnostic markers were removed and both queue/completion files again match Git exactly.

The lead authorized one full-state diagnostic, coordinated with the shared-helper investigator. No client-close bound, hook deadline increase, production change, or cleanup exception suppression has been made.

## Approved whole-state diagnostic

`heartbeat-full-state-stage-probe.{json,log}` completed with exit 0, no received signals, and all 259 tests plus hooks passing in 139.76 seconds. The source tests and database implementation were unchanged. A runtime-only Vite pre-transform config logged the original client-end and database cleanup calls through to their real implementations; no cleanup result, timing budget, or assertion was replaced.

| Whole file | Initial client close | Registered clients | PostgreSQL owner stop | Directory removal | Shared cleanup total |
| --- | ---: | ---: | ---: | ---: | ---: |
| run-completion (157 tests) | 3 ms | 1 ms | 5,006 ms | 17,169 ms | 22,176 ms |
| queue (102 tests) | 3 ms | 0 ms | 5,009 ms | 8,611 ms | 13,620 ms |

Machine-readable trace timings: `full-state-stage-timings.json`. Runtime config: `instrumented-server.config.ts`, SHA256 `6f20418e8348592855691bf13649ef02206e755cb5420c849cd0c24fdc5b6f94`.

The observed full state closes its first database client in 3 ms. A persistent client-close hang is therefore refuted for this run. Directory removal is the largest measured cleanup stage. These timings do not establish the cause of the earlier 30-second hook failures. No helper or test timeout repair is justified by this diagnostic alone.

Per lead instruction, the final uninstrumented whole-file qualification will wait for the broader I/O-heavy runs to finish. No immediate repeat has been started.

## Final unmodified serial qualification

After the lead confirmed that both broad runs had ended and the other Native/Git database-heavy files had finished, one unmodified queue/completion run executed through the protected Node 24.22.2 wrapper. It used the original root/server Vitest configuration, original test source, `--maxWorkers=1`, and the unchanged 30-second hook deadline. There was no runtime probe, process-inspection compatibility option, timeout increase, performance environment override, or helper modification.

- Raw receipt/log: `/tmp/tk-continue/runtime/heartbeat-quiet-final-node24.{json,log}`.
- Result: **2 files passed, 259 tests passed, both teardown hooks passed; exit 0; no received signals**.
- Vitest duration: 137.83 seconds. Wrapper start/end: 2026-11-15 10:14:40.277793 through 10:16:58.389938 UTC.
- The source, server configuration, and setup hashes remained unchanged during the final run; see `quiet-final-source.json` and `final-integrity.json`.
- The wrapper/child process groups had no remaining members at final inspection. No process was stopped by this worker.

The earlier full-run hook failures are preserved as failures. Passing quiet-host qualification does not prove their exact cause, establish a cleanup product defect, or turn either interrupted broad run into a pass. This report qualifies only the explicitly listed recheck scopes.

## Delivery

The only repository edit is the authorized temporary-project/config ownership fixture in `server/src/__tests__/heartbeat-execution-configuration.test.ts`. Its current SHA256 is `260e8ed68f6d5d8a1d82cbf16b41f026a0a22cbd7c020bec0887d7cf5b9ec010`. All original assertions, deadlines, real managed-home lifecycle checks, and production policy remain intact. The other three assigned test files are unchanged. No build, browser action, commit, or push was performed by this worker.
