# Independent final continuation spec batch — test fixtures

Reviewer: `final_spec_review`, independent of every implementation author. Captured 2026-11-15T08:53:51.784245+00:00. HEAD `48275586efb8641ab8e763d378e6d5e676dc6681` plus the14reviewed working test inputs below.

## Verdict

**PASS for this new test-only batch. No concrete source defect found.**

The repairs make test-owned runtime/configuration inputs explicit while preserving the test subjects, assertions, real authentication/process policy and failure behavior. No production module, security skip, timeout limit, provider login/generation or live extension was changed by this batch. The prior five-file continuation review and AgentAdvanced fixture supplement remain valid: their six recorded source hashes still match current bytes.

Protected broad-run aggregation and hosted CI remain separate required inputs. None of the targeted counts below is a full-suite claim, and passing an isolated recheck does not establish the exact cause of an older intermittent/teardown failure. Existing32sealed product-browser cases are not new executions by this reviewer; this test-only batch does not modify their product inputs.

## Reviewed changes

| Area | Assessment |
| --- | --- |
| CLI doctor | Managed install paths are derived from a new owned temp root, then supplied by a scoped spy. External service detection is a declared unsupported fixture; update traffic is disabled and fetch is trapped plus asserted unused. Original repair-success, zero-failure/zero-warning and JWT assertions remain. Environment, spies/globals and only the generated root are restored/removed. This tests repair results without inspecting an operator install or service. |
| Company portability | The same stored `claude_local` adapter and complete company/agent/project/task/ZIP round trip remain. Explicit legacy mode permits an owned refusing executable rather than an operator CLI; timer/demand wakeups are disabled and teardown asserts zero invocation-marker creation. All original portability assertions are unchanged. This is a portability fixture, not a claim of native-provider execution coverage. |
| Confirm stopped run | The seeded successor command is the current owned Node executable. The test still exercises the real route, attestation/accounting, successor admission/terminal state, live-process refusal, metadata/remote-host refusal, deduplication and board access. It does not substitute or mock the production process identity check, and never required an actual provider reply. |
| OpenAPI catalog | The one new source-prefix entry is `/api`, matching the actual mounted company live-event stream router. Discovery/coverage comparisons now include the real route rather than excluding it. No route/spec/auth assertion or production transport was altered. |
| Managed router credentials | Only the three direct preparation inputs and repaired agent gain an existing owned cwd. The real project-auth policy still runs. Two new Anthropic/OpenAI conflict fixtures require the real422/ai_connection_incompatible refusal and remove only their generated child directories. No policy-pass mock is used. |
| Heartbeat recovery variants | The six cases gain per-case owned cwd and cleanup, preserving their expected recovery/error-reporting, no-provider-work, issue-blocking, board-owned recovery-action and failed-wakeup assertions. The seed's old adapterConfig was empty, so setting cwd does not discard another required fixture command or option. |
| General AI-connections | Only this isolated suite fork changes process cwd to its existing canonical temp home after database setup. afterAll restores the original cwd in finally before removing the fixture, even if database cleanup throws. Explicit cwd cases retain their own meaning. The new default-policy control calls the real policy for Anthropic/OpenAI. Existing security/concurrency/refresh/cleanup assertions remain. |
| Gemini/OpenCode | Real skill preparation continues, now inside generated HOME paths rather than operator provider directories. The existing XDG roots/runtime mocks and all output/timeout assertions remain. Owned roots are tracked for removal and vi.stubEnv substitutions are restored. |
| Claude ACP/probes | Each fixture explicitly owns HOME, Claude config and Paperclip state. Tests that intentionally seed settings still override with their own fixtures. Real settings preparation is retained before the existing fake ACP/probe boundary; credentials are not globally bypassed. Existing per-case/temp-root cleanup and environment restoration remain, with no timeout adjustment. |
| GitHub launcher environment | The former implicit absent-global-config case is now explicit and still requires undefined output for that branch. A second branch supplies an owned global config file and requires its exact preservation. Both retain real Git credential-helper lookup and worktree metadata assertions. No launcher security assertion is relaxed. |

## Validation receipts and proof limits

These are inspected author-run receipts under the unchanged protected Node24.22.2 runtime, not independent broad reruns by this reviewer. Keep them separate; no duplicate aggregate total is inferred.

| Report | Relevant current result |
| --- | --- |
| `cli/report.md` |65cases across three files have relevant passing evidence:63unchanged worktree,1doctor,1final company portability. Intermediate unusable-ps/temporary422 attempts remain failures. |
| `serialized-runtime/report.md` |17maintenance +139queued-comment +9confirm-stop =165passed. Maintenance retains both90real-second observations. The queued teardown timeout was not reproduced; no timeout source changed. |
| `openapi/report.md` |50passed/1failed RED, then51passed GREEN for the exact catalog repair. |
| `serialized-credentials/report.md` |32complete router cases plus6affected heartbeat variants =38passed.453unselected heartbeat cases are not claimed by that receipt. The authoritative RED reproduces four credential-denied cases. |
| `general-credentials/report.md` |162AI-connections plus1922unchanged native/explicit cases =2084passed,7preexisting Linux-only skips. The20-case attempted reproduction was already green, despite its red filename; no false failing claim is made. |
| `adapters/report.md` |Seven files:148passed,1preexisting Linux-only skip. The concurrent unchanged-five-second deadline attempt remains a failure; accepted evidence ran files serially. Package typechecks pass. |

The task-local signed ps helper and protected-canary provenance are execution-environment receipts, not production process-policy edits. I inspected those classifications and source diffs; I did not rerun process controls or read operator credential files. Fixture-local settings merely provide declared inputs to unchanged real policies. The root-run owner must retain the protective environment/canary and exact source coverage when combining results.

## Scope and identity checks

I read all14diffs, the affected fixture lifecycle/behavior around them, and the six reports. I directly compared current bytes with every report's final source-hash maps: all match, including unchanged files referenced by the recheck receipts. Prior five continuation inputs and AgentAdvanced also match their reviewed hashes. Scoped and complete working diff whitespace checking exited0. No source/build/browser/workflow/Git history mutation or broad suite execution was performed by this review.

No original assertion or timeout is removed by this new batch. The only changed expectation broadens the Git-config test into two explicit branches and preserves the original undefined branch. Existing Linux/platform guards are unchanged and remain skips, not passes. The new policy refusal controls strengthen protection against accidentally masking project-auth validation.

## Handoff

Proceed to independent quality review on these exact inputs, then combine that source verdict with the ongoing root/DB outcomes and actual CI status. Reuse unchanged evidence only with its original scope. Keep unrun, failed and platform-only cases explicit; this review does not waive formal completion/provider/native-service gates.

## Final reviewed test hashes

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
