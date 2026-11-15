# Stable runner browser-sessions inclusion

Completed the scoped local fix on repository HEAD `48275586efb8641ab8e763d378e6d5e676dc6681` with two uncommitted owned files. PR 11 was not changed. CI startup and broad qualification remain open; this task did not access or trigger remote Actions.

## Change and cause

Root `vitest.config.ts` registers `packages/plugins/plugin-browser-sessions`, whose project name is `@paperclipai/plugin-browser-sessions`. `scripts/run-vitest-stable.mjs` explicitly enumerates non-server projects and omitted this name. Workspace B derives its membership from that registry, removing only the UI/CLI lane and DB lane. The default/all and ungrouped general paths dispatch all those groups. `pnpm test:run` invokes this runner and `check:all` invokes `test:run`.

Added exactly one entry to `nonServerProjects` at `scripts/run-vitest-stable.mjs:44`. No package manifest, dependency, SDK pin, workflow setting, or contract changes were needed. Existing lane/shard/retry/worker-limit and failure handling code is unchanged.

The regression extends the existing `defaultLauncher` fixture with an optional argv parameter, preserving its existing default. Three cases inspect real child invocation receipts from the production runner through a fixture pnpm executable: no flags (all mode), ungrouped general mode, and explicit workspace B. They require exactly one browser-sessions Vitest run and retain the unsharded workspace-B contract. This exercises dispatch rather than inspecting the source registry. It does not claim all actual workspace tests ran.

## Red / green proof

- `baseline-coverage.log`: existing root-config versus lane coverage check failed because browser-sessions was absent.
- `red-browser-dispatch.log`: all three new invocation tests failed with `0 !== 1` before changing the runner.
- `green-browser-dispatch.log`: the same three tests plus the existing coverage check passed after the one-line inclusion. The regression source hash was identical between red and green.
- Baseline and red failure artifacts were routed through `/Users/andrew/dev/Plugins/ult-debugger/skills/ult-debugger/SKILL.md`, with `debug-typescript` and `debug-infra`; triage classified the assertions as JavaScript/V8 failures with high confidence.

The falsifiable diagnosis was that the root config was correct but the runner registry omitted the project. If the real default and workspace-B child receipts had already contained the project, that diagnosis would have been refuted. They contained zero plugin starts before the fix and exactly one afterward.

## Final verification

Environment: `macOS-27.2.1-arm64-arm-64bit-Mach-O`, Node `v26.13.0`, pnpm `9.15.4`, installed Vitest `5.0.3`. These results apply to the final working-tree source hashes in `sourcehashes.json`, not a new committed revision.

| Check | Result | Evidence |
| --- | --- | --- |
| Complete runner regression file | 46 passed, 0 failed, 0 skipped | `runner-suite.log` |
| CI planner and selection integration/workflow tests, five files | 30 passed, 0 failed, 0 skipped | `plan-selection.log` |
| Actual browser-sessions Vitest project | 5 files, 110 tests passed | `plugin-tests.log` |
| Syntax checks, both owned JavaScript files | Passed | `runner-syntax.log`, `regression-syntax.log` |
| Owned-file diff whitespace check | Passed | `diff-check.log` |
| Workspace B dry-run inventory | Plugin included exactly once, no workspace shard | `workspace-b-plan.log` |
| Final lead integration check | Passed; exact one-line production addition; passing evidence matches current source hashes | `final-review.json`, `final-review.log` |

Exact commands, cwd, UTC start time, duration, exit status and owned-file hashes are recorded in `commands.jsonl`; `commands.txt` is the readable command list. Full output is retained for each command. The planner log's deliberate invalid-revision message is from its fail-closed fixture; that check passed. Vitest emitted an existing config-loader warning without failing. No guards were weakened to obtain these results.

## Scope and gaps

- Only `scripts/run-vitest-stable.mjs` and `scripts/__tests__/run-vitest-stable-shard.test.mjs` were edited. `changes.patch` contains the reviewable diff; `*.before` and `before.json` preserve the initial owned source and status.
- The three initially dirty extension files retain their original SHA-256 hashes, and repository HEAD is unchanged. The live extension was not built, deployed or controlled. There were no repository commits or pushes, provider logins/generation, dependency installation, credential reads, workflow setting changes, or remote Actions requests.
- Full `pnpm test:run`, `pnpm check:all`, repository typecheck/build, browser acceptance and hosted CI were not run. Broad qualification and the previously reported CI startup with zero jobs remain unresolved by this scoped change. Passing targeted checks do not establish those outcomes.
- The executable pnpm fixture uses the existing POSIX fixture mechanism and its Windows exclusion; this macOS execution skipped zero tests. Windows execution is unverified.

## Final source hashes

- `scripts/run-vitest-stable.mjs`: `44f1745005f8c7296f46fca2f6a53afd743eea31bb85280d0a9b766d9da27d9e`
- `scripts/__tests__/run-vitest-stable-shard.test.mjs`: `904679f9800d1f52148d227cc494188ce92c4771d6834986a237b9ad0ee2eb5c`

All report, command, patch, failure/pass output and source-hash artifacts are under `/tmp/tk-continue/stable-runner-inclusion/`.
