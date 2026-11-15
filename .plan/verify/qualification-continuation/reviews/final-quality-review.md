# Independent final continuation quality batch — fixture isolation

Reviewer: `final_quality_review`, independent of the implementation authors. Read-only review following `/tmp/tk-continue/final-spec-review.md`. Scope is exactly its14new test files. The prior five-file continuation and AgentAdvanced assessments remain unchanged; all six of those hashes still match current bytes.

## Technical verdict

**PASS. No concrete blocker, major or minor code-quality defect found in this test-only batch.** All14current hashes match the preceding spec review. These changes make test-owned inputs explicit without replacing the production policies or assertions under test.

This verdict is separate from protected root-run aggregation, the pending DB signal recheck, hosted CI and product/provider/native acceptance. I do not infer a broad root or hosted pass from targeted receipts and do not add together overlapping counts.

## Source review

| Slice | Quality assessment |
| --- | --- |
| CLI doctor | The fixture allocates its own configuration/runtime/install metadata root before use, derives managed-install paths through the real resolver and then scopes the resolver spy to those paths. External service detection is an explicit unsupported fixture. Update checks are disabled, fetch is trapped and asserted unused, and the original successful repair/zero-failure/zero-warning/JWT assertions remain. afterEach restores spies, globals and the captured test environment, then removes only the generated root. No operator install/service/network behavior is claimed. |
| Company import/export | The round trip keeps the stored claude_local adapter and all company/agent/project/task/archive assertions. Explicit legacy mode makes an owned executable usable instead of resolving an operator provider. That executable records any invocation and refuses it; timer/demand wakeups are disabled and teardown requires that its marker was never created. The existing owned shell/application homes, loopback server and database lifecycle remain. This qualifies portability, not live-provider/native execution. |
| Confirm stopped run | Only the seeded successor command changes to the current owned Node executable. The real process-identity, attestation/accounting, route and board-access controls remain. The test still requires successor admission and eventual terminal state, while live/metadata/remote-host refusal and deduplication assertions are untouched. It never required a provider reply, and no production process-auth check is mocked or weakened. |
| OpenAPI catalog | The exact company-live-events-stream.ts source entry is mounted under /api. I checked the actual unprefixed api.use(router) registration and the router's /companies/... path. The one literal catalog addition makes existing route/spec comparison cover that endpoint; it does not exclude a route or alter authentication/transport. |
| Managed connection routing | Direct runtime-preparation inputs and the affected agent gain the existing owned home as cwd. Their other runtime configuration and routing/auth identity assertions remain. Two new synthetic Anthropic/OpenAI project conflicts run the real project-auth validator and require422/ai_connection_incompatible, then remove only the owned child fixture. No blanket policy-pass mock is introduced. |
| Heartbeat configuration recovery | Six existing variants gain a generated per-case project-auth cwd and cleanup. The seed had an empty adapterConfig, so assigning this fixture cwd does not discard a required command or option. Their real recovery/error classification, no-provider-work, blocked issue, board-owned action and failed-wakeup expectations remain. |
| General AI-connections | The file's isolated Vitest fork changes its default cwd to its canonical generated home only after DB/seed setup. afterAll uses finally to restore the captured original cwd and environments before removing the home, including when DB cleanup fails. Explicit project-cwd cases remain explicit. The new default-policy check invokes the real Anthropic/OpenAI policy. Production policy and source selection are unchanged. |
| Gemini and OpenCode | Real skill preparation now resolves inside each test's owned HOME rather than an operator provider directory. OpenCode retains its XDG fixture and nests HOME under the same cleanup root. Gemini's new root enters the existing tracked-root cleanup. Existing fake execution boundaries, output/timeout/security assertions and environment restoration remain. |
| Claude ACP and probes | Each fixture owns HOME, Claude settings and Paperclip state before real settings preparation reaches the existing mocked runtime/probe. Deliberate settings cases keep their explicit overrides. The ACP roots use the existing tracked cleanup; probe/remote fixtures remove their generated root after restoring environment substitutions. No global auth skip, changed timeout or provider account access is added. |
| GitHub launcher environment | The old absent-global-config condition is now explicit and still requires undefined output for that branch. The added present branch creates an owned global-config file and requires exact propagation. Both retain real Git helper lookup and worktree metadata assertions, with HOME/GIT_CONFIG_GLOBAL restored and the tracked temp root removed. This broadens coverage rather than weakening the old expectation. |

## Fixture fidelity, evidence and limits

I read all14diffs and the affected setup/teardown and behavior around them, plus the six author reports under cli, serialized-runtime, openapi, serialized-credentials, general-credentials and adapters. The reports distinguish real controlled failures, failed intermediate environments, unselected cases, unchanged rechecks and platform skips. In particular, the native/explicit attempted reproduction was already green; no source cause is claimed for that earlier intermittent failure. The queued teardown recheck similarly does not identify its older failure's exact cause. Serial adapter acceptance preserves the earlier concurrent timeout failure and leaves the timeout itself unchanged.

No production module, original security assertion, timeout or test exclusion was removed. The Git-config expected value changes only to express both absent and present branches; its absent branch retains the original result. A mechanical comparison confirmed all existing skip/todo/platform-guard lines in these14files match HEAD. Linux-only skips remain skips. New controls exercise real policy refusal rather than feeding a passing policy result.

Task-local process-list tooling and MAC credential-denial provenance are execution-environment receipts, not edits to production process policy. I did not operate those tools or inspect operator credentials. The credential-protected full-run owner remains responsible for that environment and for combining nonoverlapping coverage. Current targeted test/typecheck receipts are author executions, not independent suite reruns by this reviewer.

Reviewer checks were actual source/diff/report inspection, the14SPEC hash comparisons, preservation of all six previously reviewed input hashes, platform-marker comparison and complete working diff whitespace checking (exit0). No source, build, browser/provider, runtime, workflow-setting, Git or PR mutation was performed. These fixture changes do not alter the already sealed product/browser inputs; no new browser execution or sealing is claimed.

## Reviewed current input identity

Captured 2026-11-15T09:02:57.774676+00:00; HEAD `48275586efb8641ab8e763d378e6d5e676dc6681` plus current working bytes. All14match SPEC. Prior six source hashes remain unchanged.

| Path | SHA-256 |
| --- | --- |
| `cli/src/__tests__/doctor.test.ts` | `101006573dd5ea239f40730587ec3103baa14e2e1b667255da3246b2d8a9fda9` |
| `cli/src/__tests__/company-import-export-e2e.test.ts` | `05c785be3434c9080bf954e632fbe125480ecca71b0ce8a471d22b814f733c1d` |
| `server/src/__tests__/issue-confirm-run-stopped-routes.test.ts` | `278b896ad2c53e8eba4bb343e7fcb6a3e0a7b0f8ff86f2e33fedc6583dcb8f32` |
| `server/src/__tests__/openapi-routes.test.ts` | `9271984c45b86c03ccedb5b6ba76fc8c10f1230017ed40793a3e96d5028a3f56` |
| `server/src/__tests__/ai-connection-router.test.ts` | `d186966830cf8c9096049a1badcb627a0da0c72f5872a629fd05b45f2cf886a4` |
| `server/src/__tests__/heartbeat-process-recovery.test.ts` | `5a0927b060fd8f8f87281e0220a6602b029b74b7669c78f3e9dc8d573c0e589b` |
| `server/src/__tests__/ai-connections.test.ts` | `0b7f9ae80027ad1381ca4af9b6f1c5d7c3d45e39e570ecbefd310ef3d715cb99` |
| `packages/adapters/gemini-local/src/server/acp.test.ts` | `2130d042878bd59fec3cce443dd9c40ebc24fea544426e1b155e16770f364953` |
| `packages/adapters/opencode-local/src/server/execute.test.ts` | `2e550d2118ca0117a9946f6049089a15706c09f23b02050f032999b393ec4614` |
| `packages/adapters/opencode-local/src/server/execute.timeout.test.ts` | `ddb90c2c1250155644a5b2ed5e922812014b9d9a74a5b1fd3ca18122b5977e85` |
| `packages/adapters/claude-local/src/server/acp.test.ts` | `85f2c65c7867a1daa846309b7808b77f5eef752aa02469570de847b860ac97a8` |
| `packages/adapters/claude-local/src/server/test.probe.test.ts` | `39dabdbd874ee569926f4b0b902b3b4c445e35fd6b25f25808f6bbf8a78a76cf` |
| `packages/adapters/claude-local/src/server/test.remote.test.ts` | `ec159ac9be820e98d8c2713811ab7240873b0e8a8c7a562104a9d30b30a75496` |
| `packages/adapter-utils/src/github-launcher-environment.test.ts` | `e1fba02cc40f239efc7f6117f040d01b58db1fd59a2e1f46cb65b67a489353d3` |
