# Adapter test fixture repair

2026-11-15. Repository: `/Users/andrew/dev/threadkeeper/paperclip`.

Only the seven assigned test files changed. Production adapters, execution policy,
provider commands, security assertions and timeouts are unchanged.

## Cause and repair

- Gemini ACP tests used a fake runtime but real skill preparation. Two tests
  tried to create the operator's `.gemini/skills`. Each test now owns a temporary
  `HOME`; the real skill-preparation path remains exercised.
- OpenCode tests isolated `XDG_CONFIG_HOME`, while Claude-compatible skill
  installation still used ambient `HOME`. Both execution test fixtures now
  supply an owned temporary home as well.
- Claude ACP and environment-probe tests used real settings-seeding code before
  reaching their mocked runtime/probe. They read ambient `.claude/settings.json`
  and wrote managed state outside their fixture. Each test now supplies an empty
  owned Claude config directory, an owned home and an owned Paperclip state root.
  Tests that deliberately seed settings continue to supply their own fixture.
- The local GitHub launcher test implicitly assumed `GIT_CONFIG_GLOBAL` was
  absent. The qualification wrapper deliberately supplies `/dev/null`. The test
  now controls this input and covers both absent configuration and an explicit
  owned global-config file. Both cases retain the real credential-helper lookup
  and isolation assertions.

All environment substitutions are test-local `vi.stubEnv` calls restored during
cleanup. The agent shell's `HOME` was not changed. Real credential directories
remained denied by the qualification MAC sandbox.

## Evidence

- `red.log`, `red-command.json`: seven files, **34 failed, 113 passed, 1 skipped**.
  The original credential-directory EPERMs and probe-result mismatches reproduced.
- `green-attempt-1.log`, `green-attempt-1-command.json`: all original failures
  resolved, but two staging cases hit their unchanged five-second test deadline
  while files ran concurrently. This failed run is preserved and is not a pass.
- `green.log`, `green-command.json`: same source and MAC sandbox, serialized file
  execution, **7 files passed; 148 tests passed, 1 skipped; exit 0**. The one extra
  test is the explicit Git-config case. The sole skipped test is the pre-existing
  Linux-only launcher-runtime case (`it.runIf(process.platform === "linux")`).
- `typechecks.log`, `typechecks-command.json`: adapter-utils, Claude, Gemini and
  OpenCode package typechecks passed, **exit 0**.
- `before.json` and `after.json`: SHA-256 hashes of all seven files; the final
  record also retains the unchanged MAC sandbox profile hash.
- `triage.json`: ult-debugger's trace parser did not recognize Vitest's formatted
  stack syntax. Root call sites and errors were inspected from the retained
  actual Vitest stderr. No synthetic trace or diagnosis was substituted.
- `git diff --check` passed on the seven changed paths.

The exact argv, cwd, environment key names, timestamps and exits are retained in
the command JSON receipts. The successful test command was:

```sh
python3 /tmp/tk-continue/runtime/run-qualification.py adapters-green-serial pnpm exec vitest run packages/adapters/gemini-local/src/server/acp.test.ts packages/adapters/opencode-local/src/server/execute.test.ts packages/adapters/opencode-local/src/server/execute.timeout.test.ts packages/adapters/claude-local/src/server/acp.test.ts packages/adapters/claude-local/src/server/test.probe.test.ts packages/adapters/claude-local/src/server/test.remote.test.ts packages/adapter-utils/src/github-launcher-environment.test.ts --maxWorkers=1 --no-file-parallelism

python3 /tmp/tk-continue/runtime/run-qualification.py adapters-typechecks pnpm -r --workspace-concurrency=1 --filter @paperclipai/adapter-utils --filter @paperclipai/adapter-claude-local --filter @paperclipai/adapter-gemini-local --filter @paperclipai/adapter-opencode-local typecheck
```

The wrapper pins Node 24 through its PATH and retains the existing protected
credential directories, task-local GNU tar and signed process-list helper.

## Scope limits

No full-suite run, build, Git mutation, workflow action, live extension operation,
real provider execution or operator credential read was performed. These focused
test results do not qualify the entire workspace suite. The concurrent staging
deadline failures remain visible in the failed intermediate receipt.
