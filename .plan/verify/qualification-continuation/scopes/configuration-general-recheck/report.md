# Configuration fixture ownership repairs

All three assigned files pass: **30 tests, zero failures or skips**. Targeted types pass. Only the three test files changed; production configuration/authentication policy is unchanged.

## Reproduction and cause

The unchanged three-file protected Node 24.22.2 run reproduced the exact four failures: 4 failed / 26 passed. Complete RED output and wrapper provenance are retained here. No signals were received.

- `ai-legacy-compatibility.test.ts`: the reconnect fixture passed `config: {}` to real managed preparation. `assertManagedAiProjectAuth` therefore used the checkout cwd and attempted `/Users/andrew/.claude/settings.json`; the credential-denying sandbox rejected that read with EPERM.
- `agent-configuration-save.test.ts`: its saved-agent fixture omitted cwd. Live validation of the unverified account attempted `/Users/andrew/.codex/config.toml`, producing 500 instead of the fixture's intended rejected-probe 422 response.
- `claude-local-adapter-environment.test.ts`: the two remote-probe fixtures inherited the host shared Claude configuration. `prepareSandboxClaudeProbeRuntime` calls `prepareClaudeConfigSeed(process.env, ...)`, whose fallback source is `os.homedir()/.claude`. Protected materialization failed before the expected permission and unsupported-effort outcomes. The existing managed-seed test already owned this input and passed.

These artifacts convict inherited fixture inputs. They do not establish a production policy defect or credential-cleanup regression. Operator credential contents were not read; the protected paths were denied.

## Test-only change

- Give the legacy managed-preparation input its existing temporary `home` as cwd.
- Give the saved-agent fixture its existing temporary `home` as cwd.
- Own the Claude probe file's shared config and Paperclip seed state in a per-test temporary directory, restore the original environment afterward, and remove the owned directory. The existing local sandbox-runner effort fixture also receives its owned root as the child HOME.

The global HOME is unchanged. Real project-auth checks, managed preparation, save validation and remote configuration materialization still run. Every original expectation line remains unchanged; the receipt records line identities. No assertion, test case, timeout or platform gate was removed or weakened. No real provider command, login, service or model call was introduced.

## Verification

The RED and GREEN commands use the parent's protected runtime wrapper, clean provider environment, Node 24.22.2, one worker and no file parallelism:

```sh
python3 /tmp/tk-continue/runtime/run-qualification.py configuration-general-green pnpm exec vitest run --project @paperclipai/server server/src/__tests__/ai-legacy-compatibility.test.ts server/src/__tests__/claude-local-adapter-environment.test.ts server/src/__tests__/agent-configuration-save.test.ts --maxWorkers 1 --no-file-parallelism
```

- RED: 3 failed files; **4 failed / 26 passed**; exit 1.
- GREEN: 3 passed files; **30 passed**; exit 0; all teardown completed and no received signals.
- Targeted three-file TypeScript program: exit 0 through the repository's `scripts/run-tsc.mjs`, preserving the test compiler rules and existing production-layer declarations. The first task-local config attempt could not resolve the `node` type library from `/tmp`; that failed tooling attempt is retained. Explicitly naming the same repository type roots fixed the task-local config without changing source or compiler strictness.
- Scoped `git diff --check`: exit 0. Final source hashes and unchanged expectation-line identities are in `receipt.json`; `change.patch` retains the complete small diff.
- Required ult-debugger router and TypeScript specialist were used; doctor and RED triage artifacts are retained. The triage parser does not fully classify Vitest assertion formatting, so the complete original error text remains authoritative.

These scoped results replace only the affected failure evidence. They are not a passing broad shard, root suite, production/browser acceptance or hosted CI result. Source HEAD and unrelated work were preserved; no commit, push or deployment was performed by this worker.
