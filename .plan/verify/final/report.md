# Paperclip + Threadkeeper implementation handoff

The implementation is prepared in `/Users/andrew/dev/threadkeeper/paperclip`, on
`merge/threadkeeper-import`. Threadkeeper is an independent React 18 npm package under
`extension/`; Paperclip and the first-party `browser-sessions` plugin use the pnpm workspace.
The original checkout and its live extension were preserved.

This is a source implementation handoff, **not a claim that the full plan's release acceptance
is complete**. The implementation uses the documented view-switching fallback; fused clipping
is not shipped. Native permission consent, real provider delivery, user service registration,
live deployment and library continuity still require their specified interactive or approved actions.
REQ/TASK records stay in progress rather than fabricating completion gates or historical load passes.

## Implemented scope

| REQ | Source behavior and verification boundary |
|---|---|
| 1 | Approved current-snapshot baseline recorded; original `main` was not represented as merged. Current source map and fork-only hook configuration are recorded. |
| 2 | Full committed history imported under `extension/`, approved working files overlaid, plan copied to `.plan/`. The exact 443-file snapshot was reproduced under a nested extension path and passed all 1,713 baseline tests. |
| 3 | Guarded `check:extension`, `check:all` and explicit `deploy:extension`; separate React versions and path-based extension identity. The broad upstream suite remains unqualified, as detailed below. |
| 4 | Visible connection lifecycle, authenticated-key validation, fixed helper registration/commands, start deduplication and explicit first setup. Actual user launchd installation was not performed. |
| 5 | Persistent direct-child Paperclip frame, origin-checked host bridge, route/history restoration, full-document boot retries, header preservation, sign-in, app service worker and same-auth live updates. |
| 6 | Browse, Threads and Session board appear in the actual default Paperclip sidebar and switch the mounted extension views. The fallback is tested; no successful fused-layout spike or fused implementation is claimed. |
| 7 | Separate per-company code pairing and private bridge tokens, explicit sharing, inventory reconciliation, private-session removal, version checks, bounded packets and first-party source provisioning. |
| 8 | Actual normal process-agent checkout/auth/policy/gateway calls list, search and read cited browser data through the paired extension; untrusted-data markers survive. No model generation was used for this proof. |
| 9 | Bidirectional task links, verified ID-only automatic links, permanent automatic-link deletion tombstones, task Sessions tab, attention widget and private/stale handling. |
| 10 | Live-frame observation ledger, five-second settled transitions, quoted identifying comments, deduplication, notification limits and governed wakeup requests. Live provider-driven wakeup was not exercised. |
| 11 | Off-by-default master/provider/trust gates, trusted current-task scope, exact account/frame targeting, persistent idempotency, rate admission, cancellation and uncertain delivery. Stand-in delivery and real PostgreSQL admission checks passed; real provider sends/starts remain held. |
| 12 | Named-task and run-only change hints reuse per-task import without advancing periodic cursors; periodic/backoff sync remains available. Production-library latency was not measured. |
| 13 | Paperclip search and command-palette session results, independent failure handling, bounded pagination and fresh privacy checks. Actual search/private exclusion and result opening are covered by the browser journeys. |
| 14 | Native secret pickers, explicit source/transfer consent, memory-only resolution, offline pause, readback-before-delete migration and backup behavior. Fixture tests passed; no actual user key was read, transmitted or moved. |

Authenticated Chrome and Edge controls showed native WebSockets connecting in an ordinary page
but failing inside the extension frame. The verified hosted app therefore has an HTTP event-stream
fallback using the existing HTTP identity, company access and event privacy/delivery pipeline.
No cookie-policy relaxation, credential extraction, token injection or authentication values in URLs
were introduced. Both browsers subsequently displayed a matching authenticated task event without
reloading the frame.

## Actual validation

| Check | Result | Evidence |
|---|---|---|
| Whole-fork TypeScript/Rust check | Exit 0 using pinned pnpm 9.15.4 and task-local Rust 1.97.1; affected packages were checked again after repairs | [Root check log](artifacts/fork-typecheck.log) |
| Standard production build | **Exit 0**, 36 workspace packages, UI/server/CLI/plugin bundles and optimized macOS arm64 Runner; artifact signature verified, all 16,919 source files unchanged | [Build log](artifacts/production-build.log), [artifacts and hashes](artifacts/production-build.json) |
| Current extension typecheck | Exit 0 | [Log](artifacts/extension-typecheck.log) |
| Current extension unit suite | **102 files, 1,833 tests passed**, plus the safe isolated build | [Final guarded check](artifacts/extension-final-guarded-check.log) |
| Approved-snapshot import portability | **83 files, 1,713 tests passed**, typecheck/build exit 0, no manifest key, all 443 hashes match | [Exact reproduction](../import-parity/20261114T073500Z/report.md) |
| Plugin domain checks | **44 tests passed**, source/test typechecks and build passed | [Log](artifacts/plugin-tests.log) |
| Action admission SQL/Memory matrix | **6/6 passed**, including expired IDs, hourly ordering and late completion; own fixture cleaned | [Receipt](artifacts/rate-sql-receipt.json) |
| Same-auth stream and native delivery | **44 tests passed**; actual disposable HTTP activity event forwarded | [Log](artifacts/sse-tests.log) |
| Real process-agent tool path | Successful normal run, checkout, catalog, four reads, cited message and `untrusted: true`; session revoked and agent terminated | [Report and receipts](../agent-read-runtime/20261114T080043Z/report.md) |
| Provider workspace regression | **32 checks passed** against local stand-ins; inherited evidence and manifest unchanged | `/tmp/threadkeeper-workspace-regression-runtime.json` |
| Independent spec review | Implementation PASS after repairs; exact source snapshot retained | [SPEC-3](../reviews/spec-round-3.md) |
| Independent quality review | Implementation PASS after Q1/Q2 repairs; same production snapshot | [QUALITY-2](../reviews/quality-round-2.md) |
| Chrome UI/host acceptance | **9 passed, 0 failed, 1 blocked** native permission check; sealed and rechecked | [Chrome report](../../../.acceptances/paperclip-merge/round-13/report.md) |
| Edge UI/host acceptance | **9 passed, 0 failed, 1 blocked** native permission check; sealed and rechecked | [Edge report](../../../.acceptances/paperclip-merge/round-14/report.md) |

The browser runs used empty owned profiles and real disposable Paperclip/PostgreSQL instances.
Native host-permission prompts could not be operated by the headless runner, so only the isolated
test manifest temporarily pregranted the declared loopback origins. That fixture was disclosed,
the key remained absent and the original test manifest was restored. The overall Neo verdicts
remain **blocked**, even though all nine executable journeys passed in each browser. Sealing
establishes integrity, not permission to release.

The existing workspace runner verifies stand-in framing, cookies, capture, accounts and new-tab
handback. It injects its test frames directly; it does not prove real-provider behavior or the
FrameStage account toolbar. Baseline and current test counts are different checks, not additive
claims about unique tests. Reviewer-owned focused totals also overlap the implementation checks.

## Full-suite qualification gap

The broad `pnpm test:run` started before the final source and temporary toolchain were ready.
All six chat shards passed, but the general-server phase recorded **51 failed tests across nine
reported file summaries**. The stale run was interrupted with SIGINT, exit 130; it is not a full
passing result and was not relabelled as one. The raw log remains at `/tmp/threadkeeper-fork-tests.log`.

- Four provisioning assertions depended on the host-installed CLI. Their test-only fixture was
  made hermetic without changing assertions; six selected provisioning/guard tests pass.
- Five selected migration cases and two archive cases pass unchanged in focused runs. Their
  original broad-run deadline failures remain recorded.
- The current bundled-plugin suite passes all 52 tests. After the production build, a bounded
  current matrix passed all nine warm-checkpoint cases. Six retained-pack cases fail because
  GNU tar is unavailable; two long-path cases fail with `ENAMETOOLONG` on this Mac. Twenty-one
  setup-readiness rechecks were left unrun because their preparation could inspect ambient
  authentication files; reserved home variables were not changed to force a pass.
- The current CLI-guidance check exposed newly authored literal lifecycle instructions and
  historical captures. The fix keeps the parser fail-closed, allows only two fully literal
  commands with no substitutable input, excludes local runtime captures from Git staging and
  preserves exact rendered status text. All 45 guidance tests pass; sealed captures remain intact.

[Observed summaries and raw-log hash](full-suite-summary.json) and the
[owned-process stop receipt](../full-suite-stop.json) retain this boundary. Further full-suite/CI
qualification is still required; targeted successes are not a substitute for that claim.

## Preservation and remaining actions

The lead check verifies the original 443 source files, original Git head, fork `master`, and live
manifest bytes/mtime. The imported source commit remains an ancestor. The reviewed application
behavior is unchanged. Verification deltas have ordered independent supplements: an optional
read-hold branch in the browser driver and a narrow generated-vendor boundary in the Node checker.
The latter preserves strict workspace engine/type checks and excludes only ignored runtime assets
materialized by the standard build; no vendor files were edited. Driver provenance remains explicitly
retrospective where capture-time hashes were not recorded. The CLI-guidance change represents the
same status text through private static command properties; before/after render checks preserve
wording, buttons and behavior. Prior browser captures remain applicable to those unchanged outcomes
with their original build/source provenance; they are not recaptures of the representation change.
Sealed browser reports were not edited.

- [Lead integration receipt](lead-integration-check-final.json)
- [Driver provenance](driver-supplement/author-provenance/README.md)
- [Driver spec supplement](../reviews/spec-round-3-driver-supplement.md) and [quality supplement](../reviews/quality-round-2-driver-supplement.md)
- [Node-policy spec supplement](../reviews/spec-round-3-node-policy-supplement.md) and [quality supplement](../reviews/quality-round-2-node-policy-supplement.md)
- [Build-assets spec addendum](../reviews/spec-round-3-node-policy-build-supplement.md) and [quality addendum](../reviews/quality-round-2-node-policy-build-supplement.md)
- [Guidance spec supplement](../reviews/spec-round-3-guidance-supplement.md) and [quality supplement](../reviews/quality-round-2-guidance-supplement.md)
- [Original snapshot/import receipt](../baseline.json)
- [Implementation map and transport decision](../../context/implementation.md)

The plan reserves live deployment, helper installation and service registration for a specific
go-ahead. No such action was performed. The prepared deployment targets the existing folder
`/Users/andrew/dev/threadkeeper/.output/chrome-mv3`, preserving its path identity. Model-key transfer
and trusted provider actions remain off until explicitly enabled.

Review the blocked native consent case, the unqualified broad suite and the founder-operated
provider/service/library checks before approving the live transition. The application setup and
safe command documentation are in `doc/threadkeeper.md` and `doc/THREADKEEPER-SERVICE.md` at the fork root.
