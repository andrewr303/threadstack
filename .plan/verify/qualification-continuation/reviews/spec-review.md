# Independent spec review — test-runner and credential-fixture continuation

Reviewer: `final_spec_review`, independent of both implementation authors. Captured 2026-11-15T07:43:17.729021+00:00. Repository HEAD `48275586efb8641ab8e763d378e6d5e676dc6681` plus the five reviewed working inputs below. Source hashes match both authors' final receipts. No owned source hash drift occurred during final review.

## Verdict

**PASS for the tooling/test source scope. No concrete blocking or nonblocking spec defect found.**

The root runner now includes browser-sessions in actual default/general/workspace-B dispatch. Shared server tests unconditionally use an owned synthetic Codex home, while deliberately selected credential fixtures remain explicit. Readiness checks retain their production-policy assertions and real synthetic file behavior. No authentication skip, reduced security assertion, provider action or production credential/execution change was introduced.

The parent's protected full Node24 run and hosted CI qualification remain independent pending evidence. This review does not turn the earlier interrupted run, CI startup with zero jobs, or any platform/provider gap into a pass. The product browser/UI code is unchanged by these five files; this review does not claim new browser execution or re-seal the existing32 cases.

## Stable-runner inclusion

The production runner diff is exactly one added name, `@paperclipai/plugin-browser-sessions`, in `nonServerProjects`. It matches the existing registered root Vitest project. Workspace-B membership already derives from this registry after removing its separate DB/UI/CLI lanes; the new project is therefore included by the existing dispatch model.

No worker, concurrency, timeout, shard, retry, shared-database, group-order or exit/failure handling code was altered. The existing default-launcher test helper retains its old default arguments and gains an optional argv input. Three regression cases execute the real production runner with a controlled pnpm executable and inspect actual begin receipts. They require exactly one plugin invocation for default/all, ungrouped general and explicit workspace-B, and preserve the unsharded workspace-B contract. These are real runner-dispatch proofs, not claims that every fixture-represented workspace suite ran. The separate actual110-test plugin receipt supplies that package's targeted execution evidence.

## Credential-home isolation and owned cleanup

`setup-supertest.ts` always calls the existing `createIsolatedTestHome`, writes only the same synthetic `sk-vitest` auth fixture in owner-only mode, sets the test worker's CODEX_HOME, and registers its cleanup at process exit. It no longer inherits an operator-selected home. It does not change the parent agent/user environment or install/login a provider.

I inspected the reused helper. Cleanup checks the exact generated root's directory type and captured device/inode, refuses a replaced root, opens directories without following symlinks, and recursively removes only that owned root. Exit timing preserves the existing rule that async suite teardown drains before root deletion.

The new subprocess canary imports the actual shared setup for both empty and preexisting synthetic selections. Its pre-I/O synchronous filesystem guard covers the setup/helper operations, and the assertions require a different generated home, the expected synthetic auth, mode0600, no canary accesses, disappearance of the generated home after worker exit, and unchanged canary bytes/mode/mtime/inode. It is not a read of real operator credentials. The canary root is itself created and removed by this test.

## Readiness coverage and security assertions

The new test-local gates register the generated shared synthetic home plus mkdtemp fixtures, including canonical macOS aliases. Sensitive filesystem operations reject paths outside those roots before delegation. Semantic wrappers also gate the real credential-reader and auth-copyback entry points, including opaque store filenames. They delegate to the original implementations for allowed fixtures rather than substituting pass/fail policy results. Native probes, SSH execution/runner, remote preparation/launcher, PRP registration and ingress remain the existing mocks; no real provider execution was added.

Four source-precedence cases retain their source-selection and environment-leak assertions but relocate their fake global paths into an owned temp root. The real tests for ownership/mode/size, selected sources, symlinks, secret redaction, cleanup, account identity, refresh/copyback and local/remote behavior remain. No skip/todo was introduced: the readiness source has zero before and after. Expect calls increase from187 to195; this count is only a consistency check, not proof of assertion quality. Direct diff reading establishes that the old security checks were retained. The two new guard self-tests require denial before filesystem/provider-copyback work; expected denial accounting prevents an unexpected fixture-gate failure from silently satisfying other cases.

The guards are scoped test protection, not a new general-purpose filesystem sandbox. The optional audit uses the caller's explicit test artifact path and records test/operation names, credential basenames and allowed/blocked status, never auth bytes. The full root run still needs the parent's independent protective environment/sandbox.

I directly compared all five production paths in `production-preservation.json` with HEAD: setup-readiness, local credential reader, confined file reader, runtime context materializer and Codex copyback code are unchanged.

## Receipts inspected and limitations

- Runner author: new dispatch RED failures, same-source GREEN,46runner tests,30planner/selection tests,110actual plugin tests, syntax and whitespace checks. These apply to Node26.13.0/macOS and do not certify Windows or the full root run.
- Readiness author: two shared-setup RED failures and GREEN; a controlled linked synthetic operator fixture reproduces the exact21historical failing names; the accepted two-file run passes102tests (original98, two guard checks, two canary cases). The805-operation audit across100readiness cases has exactly the three intended self-test denials and no unexpected denials.
- `typecheck.log` and `typecheck-corrected.log` are failed attempts, not passes. The final receipt explicitly records `typecheck-accepted.log` exit0 with the test program's proper Node and Express ambient contexts. I inspected the accepted empty diagnostic log, its configuration, final receipt and matching source hashes.
- These were author executions, not independent suite reruns by this reviewer. I ran only read-only source/receipt/identity comparisons, a mechanical no-skip/expect consistency check, and scoped whitespace checking; no source, build, browser, provider, Git history or workflow setting mutation occurred.

## Next input

Proceed to independent quality review of these same five source hashes. Combine it with the protected full-run outcome and actual hosted CI status; retain failures/gaps separately if either remains incomplete. No acceptance, security or assertion gate is waived by this tooling repair.

## Reviewed final input hashes

| Path | SHA-256 |
| --- | --- |
| `scripts/run-vitest-stable.mjs` | `44f1745005f8c7296f46fca2f6a53afd743eea31bb85280d0a9b766d9da27d9e` |
| `scripts/__tests__/run-vitest-stable-shard.test.mjs` | `904679f9800d1f52148d227cc494188ce92c4771d6834986a237b9ad0ee2eb5c` |
| `server/src/__tests__/setup-supertest.ts` | `13361bf71771f0ade4b41f1c025b8604607b614d151d2019cfaa71eb0a15b417` |
| `server/src/__tests__/setup-codex-home-isolation.test.ts` | `2040333823fc917be71266259262651c9a226922d044e0ed18a9fc5b3d188ebb` |
| `server/src/services/native-runtime/setup-readiness.test.ts` | `80a2ff45d15d0820d13c051f1e3208f875e3d3a29870ef0962224b963375c319` |
