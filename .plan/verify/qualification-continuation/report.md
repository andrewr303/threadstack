# Continuation qualification draft

**All owned local qualification jobs have finished. A passing full `pnpm test:run` and hosted CI are still not claimed.** This prepublication report was captured at `2026-11-15T10:22:21.631431+00:00`. It separates failed broad attempts, scoped replacement evidence, unchanged-source rechecks and unresolved coverage. Repeated or overlapping counts are not added together.

Source HEAD remains `48275586efb8641ab8e763d378e6d5e676dc6681` while qualification uses reviewed working changes. The parent's last published [PR #11](https://github.com/AVRCORP/threadkeeper/pull/11) snapshot is `aba793728056fd80dc0057f5220af0accde9836c`. Local delivery is `d29108f16304eaed1d21a9366a78484ff6ff046e`; its additional commit has not yet been pushed at this capture. All **36 current authorized source/test/driver inputs match the delivery working bytes**. The Git-load test and prepared evidence still await the parent's final publication commit/push/readback. Three unrelated binary metadata files are excluded. See `source-delivery-scope.json` and `remote-status-at-capture.json`.

## Original broad attempts retained

| Scope | Original result | Current interpretation |
| --- | --- | --- |
| Root `pnpm test:run` | Six chat shards passed 1963 expanded cases; stopped during serial general phase; wrapper exit 1 | Interrupted/unqualified root run, not green. |
| UI/CLI workspace A |12 failed, 13036 passed, 1 skipped across 1050 files, plus six unhandled CodeMirror Range errors | Affected file results have scoped replacements below; original command still failed. |
| Workspace B |34 failed, 5889 passed, 45 skipped | Seven adapter fixtures repaired/rechecked; no claim of a fresh all-B pass. |
| DB workspace C |2 failed, 457 passed, 1 skipped | Two unchanged process-drain cases rechecked under the declared ps compatibility runtime. |
| Serialized server |29 failed, 4162 passed across 174 suites | Affected route/runtime/credential files rechecked below; no fresh complete serialized pass claimed. |
| General shard 0 |4 failed files;1 assertion failure, 12132 passed, 163 skipped | Includes Rust hook failures; scoped follow-ups do not make the shard green. |
| General shard 1 |6 failed files;4 assertion failures, 8960 passed, 132 skipped | Includes auth/archive assertions and Rust hook failures. |
| General shards 2/3 |Interrupted, orchestrator exit-15 for each; no final suite summary | Unqualified. The four-shard plan covered 1891 unique source files with no duplicates, but a complete plan is not completed execution. Individual JSON still says running; the completed orchestrator receipt records interruption. |

Later isolated remainder commands completed normally with no received signals: remainder 2 records 5 failed files/6 failed assertions, 5864 passed/93 skipped across 441 files; remainder 3 records 7 failed files/63 failed assertions, 6296 passed/99 skipped across 439 files. These remain failed commands. `general-final-observed-inventory.json` now confirms **1891 expected/1891 observed unique files, zero missing or extra**, assembled from the original/interrupted/remainder attempts. This is complete observed file inventory, **not one frozen-revision run and not a passing result**.

## Scoped current evidence

Each row retains its own runtime and inputs. Counts overlap earlier attempts and must not be summed into a repository total.

| Scope | Qualified scoped outcome | Boundary |
| --- | --- | --- |
| Stable runner / planner / plugin |46 runner, 30 planner/selection, 110 plugin tests pass | One missing project entry repaired; actual default/general/workspace-B dispatch checked. These targeted author checks used Node 26.13.0. |
| Shared credential fixtures |102 tests and test-program types pass;805 audited operations with no unexpected boundary denial | Exact 21 historical failures reproduced using an owned linked synthetic home. No operator credential access. |
| Archive/migration |329 unchanged tests pass | Current-setup author run used Node 26.13.0; earlier failures remain retained. |
| Retained provider pack |34 unchanged tests pass | Requires checksum-verified task-local GNU tar 1.35_1; earlier 28 pass/6 fail missing-prerequisite run remains failed. |
| UI fixture |AgentAdvanced 8 tests and types pass | Only its file-local real-Range geometry shim changed; original seven behavioral tests retained. No rendered-geometry claim. |
| CLI |65 relevant cases pass:63 unchanged worktree, doctor 1, company portability 1 | Test-only install/provider fixtures; no actual provider command invocation. |
| Serialized routes/runtime |165 scoped tests pass; OpenAPI 51 pass separately | Maintenance and queued-comments sources unchanged. Confirm-stop uses an owned Node successor. OpenAPI catalog gains the actual SSE source prefix. |
| Credential policy fixtures |38 selected serialized cases pass;2084 general/native cases pass with 7 existing Linux skips | Owned cwd preserves real policy; explicit conflicting project-auth controls reject. Whole-router and selected-heartbeat scopes stay separate. |
| Adapters |148 tests pass, 1 existing Linux-only skip; types pass | Per-test owned homes/config/state; Git config inputs explicit. Concurrent deadline attempt remains failed; accepted run was serial. |
| Workspace runtime / DB drains |180 unchanged runtime tests pass; two unchanged DB process-drain cases pass | Signed task-local ps and opt-in absolute-ps compatibility are declared prerequisites, not stock-system execution. |
| Bundled package fixture |15 tests pass | Real browser-sessions manifest/UI fixture added; production resolver/manifest unchanged. Parent completed the small-diff lead check. |
| Darwin auth compatibility |36 direct tests pass, 12 existing Linux skips; all seven server typecheck layers pass | Netstat fast path retained; exact bounded lsof fallback only for unsupported inspection. Existing unsupported policy remains explicit. |
| Damaged authority epoch |One targeted real-runnerd/fake-provider case passes | Test reads the already-retired archive; exact damaged bytes/pending input assertions retained and active retired epochs forbidden.70 other cases unselected. |

Further closed scoped results (not additive to the rows above):

| Scope | Qualified scoped outcome | Boundary |
| --- | --- | --- |
| Rust prerequisites |113 tests pass across all four unchanged Cargo-hook files |287 private cache directories restored against Cargo.lock. No dependency/global-cache change; earlier interruption retained. |
| Voice/projection |188 unchanged whole-file cases pass |Earlier three deadline observations retained; cause not proven by the recheck. |
| Agent hire / plugin writeback |85 and 25 whole-file cases pass; types pass |Owned project fixtures plus real policy refusal controls; original assertions retained. |
| Preparation/accounting |41 whole-file cases and types pass |Child HOME/cwd inputs are fixture-owned; no production policy change. |
| Configuration fixtures |30 cases and targeted types pass |Three test-only cwd/config repairs; all original expectations retained. |
| Bootstrap / workspace cleanup |14 cases and types pass |Owned copied Node artifact on macOS; canonical path assertion preserved. |
| Heartbeat execution configuration |41 whole-file cases and types pass |Owned project cwd; repository case also passes unchanged. Hook files remain separate. |
| Git HTTP-load fixture |4 whole-file cases and types pass |Event-driven 64-request admission batches still hold all 500 requests concurrently;498 joins/two scans, original deadlines. Parent lead check passed; delivery pending. |

Final unmodified teardown qualification (separate scopes, not added to earlier observations):

| Scope | Qualified outcome | Boundary |
| --- | --- | --- |
| Native/Git cleanup hooks |166 tests across both complete files pass; original hooks pass |No source/instrumentation/deadline change; exit 0; no received signals. |
| Queue/completion hooks |259 tests across both complete files and both teardown hooks pass |137.83 seconds, original config/setup/source/30-second hook limits; exit 0; no signals. Final recorded process groups are gone. |

Node 24.22.2 continuation checks use the credential-denying MAC sandbox and cleaned provider environment. The task-local signed unprivileged ps copy has the same executable text as the untouched system binary. No real HOME override, global tool installation, provider login/generation, helper/service registration or live extension deployment is qualified by these results.

## Standard server build

The standard server build and runtime bundle both completed with exit 0 under the protected Node 24 runtime. The runtime bundle records **3189 inputs and 166 chunks**. These are server build results, not a fresh full-workspace/UI/extension build or hosted CI pass. The emitted commit stamp remains 482 because source HEAD was deliberately held stable; working input hashes, not that stamp alone, identify the built source.

## Browser evidence and source transition

| Evidence | Result | Applicability |
| --- | --- | --- |
| Immutable original rounds 43/44 |16 Chrome +16 Edge journeys passed | Reuse only unchanged UI/layout/sidebar/Ask/gesture outcomes, preserving original capture/browser/build provenance.2022 production UI/extension hashes still match. |
| Fresh auth fallback chrome-1/edge-1 |Three affected ingress/pairing/search/private-control outcomes pass in each browser | Middleware SHA-256 `19a1e50c9f6e892455aeb8e75372c54ae678494c4181b4871c64651e1c2e9b01` remained fixed; served assets matched the existing build. These six affected checks supplement server ingress changes, not a claim of 38 unique new journeys. |

The browser verifier inspected original media. Exact fresh-browser copies and auth reviews/ingress receipts are now retained under delivery `.plan/verify/qualification-continuation/`, including `browser/chrome-1` and `browser/edge-1`. `browser-copy-integrity.json` verifies every local sealed copy against its original. Those byte-identical prepared copies are not yet committed or published at this capture; the parent will publish them after this final artifact review. This report checked result/seal metadata and sealed-file digests without rewriting originals; `browser-integrity.json` records the check. Real-agent denial is separate direct HTTP/actor evidence. No fresh authenticated-browser/provider/native-consent claim is made from the local-trusted fixture.

The source transition matters: most continuation repairs were test-only and preserved product inputs. The Darwin process-owner fallback then changed production server ingress. Its independent spec/quality reviews, actual IPv4/IPv6 operator/agent controls and six fresh browser outcomes qualify that affected slice; they do not retroactively qualify interrupted general lanes or a whole current root run.

## Remaining platform, CI and manual limits

- **No local qualification jobs remain active.** Final quiet Native/Git qualification passes 166 cases; compact queue/completion passes 259 cases and both hooks. All original source/config/setup hashes and deadlines are retained. Diagnostic Native 70/14.55-second cleanup and instrumented 259-state observations are preserved only as diagnostics, not substituted for these final unmodified passes. No shared-helper defect or exact cause for the earlier loaded 30-second failures was established.
- **Observed general inventory is complete, not a passing run:** 1891 expected/1891 observed unique files, zero missing/extra, assembled across failed/interrupted/remainder attempts and working revisions. Scoped fixes and complete-file rechecks close the convicted local failures without retrospectively changing any failed broad exit or claiming one frozen-revision green root command.
- **Exactly three unchanged macOS platform cases remain held:** two 1185/1199-byte skill paths exceed this host's 1024-byte PATH_MAX; the Runner API artifact file has 2 passes/1 failure because its real installer intentionally requires Linux/proc/self/fd. No guard, source assertion or skip was weakened. Linux qualification remains required; no Linux VM tooling was installed.
- **Hosted CI remains blocked/unqualified:** the parent's published-aba PR run 43700467312 reports startup_failure with zero jobs. Cause is unknown. No billing/code cause, settings change or passing latest-head CI is claimed. Local d291 and prepared publication changes are not described as already remote; the parent will verify the final push and PR readback separately.
- Real providers/model keys, native permission consent, helper/launchd, MV3 suspension and live-library deployment continuity retain their manual/formal evidence gaps. The continuation did not authorize or claim those live operations.

## Receipt retention

`receipt-catalog.json` identifies original local receipts/logs/reports and browser records by size and SHA-256 instead of copying hundreds of megabytes of logs. Large raw command logs remain at their recorded local locations. Fresh browser originals have exact prepared copies in the local delivery working tree; they are not yet committed or published. Only settled/historical originals receive final catalogue digests. No mutable active jobs remain. `pending-status.json` records zero owned pending jobs, the three platform cases and external/manual limits. Frozen legacy JSON that still says running is explicitly catalogued as a historical unqualified original, never as a pass. Digests prove identity, not successful execution. The catalogue, current source/delivery pins and immutable seal check are supporting artifacts, not new test runs.
