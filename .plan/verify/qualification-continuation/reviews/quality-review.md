# Independent quality review — runner and credential-fixture continuation

Reviewer: `final_quality_review`, independent of both implementation authors. Read-only review following `/tmp/tk-continue/spec-review.md`. Scope is exactly the five working files identified below, with HEAD and byte hashes recorded at capture. The only authored file is this review.

## Technical verdict

**PASS. No concrete blocker, major or minor code-quality defect found in this tooling/test scope.** All five hashes match the preceding spec review. The relevant production credential/readiness/execution files remain unchanged from HEAD.

This verdict does not qualify the parent's active protected full Node24 run or hosted CI. It does not reopen product UI/browser acceptance or convert a previous interrupted/failed run into a pass.

## Assessment

**Runner inclusion is cohesive and complete within the existing dispatch model.** The only runner change adds `@paperclipai/plugin-browser-sessions` to the existing non-server project registry. Workspace-B/default/all/general membership already derives from that registry, so the repair does not add a parallel execution path. Worker limits, shard selection, retries, failure propagation and shared-database handling are unchanged. The regression fixture retains its original default argv and adds explicit argv selection. Its three new tests execute the real runner through the established controlled pnpm mechanism, inspect actual begin receipts and require exactly one plugin invocation without a workspace-B shard. That is dispatch proof rather than a claim that the represented workspace suites executed. The separate real110-test plugin result supplies that targeted execution evidence.

**Shared setup no longer inherits operator Codex credentials.** It always allocates a separate owned temporary home with the existing synthetic sk-vitest account and mode0600, then sets only the test worker's CODEX_HOME. Tests deliberately selecting another source still opt in explicitly with stubbed environment. The parent shell, user credentials, login state and production runtime are not changed. Cleanup is registered at worker exit to retain the existing asynchronous-teardown ordering.

**Cleanup is confined to the generated home.** I inspected the reused `createIsolatedTestHome`: it captures the generated directory's device/inode, refuses a replaced or non-directory root, opens directories with O_DIRECTORY/O_NOFOLLOW, makes owned directories writable and removes only that root. The new setup does not introduce a cleanup path derived from inherited CODEX_HOME. The canary test creates and finally removes its own temp root and checks that the generated child home disappears after process exit.

**The subprocess canary checks the actual setup boundary.** It dynamically imports the real shared setup after installing pre-I/O synchronous filesystem guards over the operations that setup/helper actually use. Both empty and preexisting synthetic selections must lead to a different generated home, expected synthetic auth bytes, owner-only auth mode and zero canary access attempts. The parent's synthetic sentinel must retain bytes, mode, mtime and inode. It does not inspect real operator credentials. The child guard is specific evidence about this synchronous setup path, not a general-purpose filesystem sandbox.

**Readiness assertions remain real policy checks.** New test-local wrappers allow the known generated shared home and every mkdtemp fixture, including canonical macOS aliases. Sensitive low-level calls and semantic credential-read/copyback entry points reject unowned sources before delegation. For accepted fixtures they call the real implementations, including mode/owner/size, symlink, selected-source, account, redaction, refresh/copyback and cleanup behavior. Opaque stores are covered at semantic boundaries. Native provider probes, SSH execution/runner, remote preparation/launcher, registration and ingress remain the original mocks; the changes do not launch a provider. Four source-precedence cases move fake absolute sources under a temp fixture and preserve the same precedence and environment-leak assertions. Their expectations were not replaced by generic success stubs.

**The guards do not hide failures.** Every test checks that denials equal its explicitly declared self-test count. The two new guard checks require refusal before reader/copyback work. The optional audit records only caller-selected artifact output, test/operation names, credential basenames and allowed/blocked status; it does not log auth bytes or full credential paths. These guards are scoped test protection and do not replace the parent's independent sanitized/protected full-run environment. No skip, timeout relaxation, production credential bypass or reduced security assertion appears in this diff.

## Evidence inspected and actual reviewer validation

I inspected both author reports, final receipts, the805-operation audit summary, controlled21-failure-name comparison, accepted test-program configuration and actual source diffs. Author receipts report46runner,30planner/selection,110plugin and102readiness/setup tests, plus the accepted no-emit test-program typecheck. Those are author executions, not independent reruns by this reviewer. Failed typecheck attempts, a cold-import timeout and the controlled synthetic failure reproduction remain separately retained and are not counted as passes.

I ran scoped `git diff --check`, checked whitespace in the new untracked canary file, compared the five source hashes with SPEC, and independently compared the five credential-production preservation paths against both their receipt hashes and HEAD. All checks passed. I did not run full tests, build, use a browser/provider, mutate source or Git, or change workflow settings.

Current full-suite/CI results remain separate inputs. Hosted CI's reported zero-job startup remains unqualified; this code verdict neither attributes nor resolves it. Real providers/model keys, native consent, helper/service, MV3 suspension, live-library continuity and any still-open formal plan gates remain outside this tooling review.

## Reviewed input identity

Captured 2026-11-15T07:46:10.783363+00:00; HEAD `48275586efb8641ab8e763d378e6d5e676dc6681` plus these current working bytes. All five match the preceding spec review.

| Path | SHA-256 |
| --- | --- |
| `scripts/run-vitest-stable.mjs` | `44f1745005f8c7296f46fca2f6a53afd743eea31bb85280d0a9b766d9da27d9e` |
| `scripts/__tests__/run-vitest-stable-shard.test.mjs` | `904679f9800d1f52148d227cc494188ce92c4771d6834986a237b9ad0ee2eb5c` |
| `server/src/__tests__/setup-supertest.ts` | `13361bf71771f0ade4b41f1c025b8604607b614d151d2019cfaa71eb0a15b417` |
| `server/src/__tests__/setup-codex-home-isolation.test.ts` | `2040333823fc917be71266259262651c9a226922d044e0ed18a9fc5b3d188ebb` |
| `server/src/services/native-runtime/setup-readiness.test.ts` | `80a2ff45d15d0820d13c051f1e3208f875e3d3a29870ef0962224b963375c319` |
