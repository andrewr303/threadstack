# Agent-hire managed connection fixture repair

**85 tests pass, no skips**, including all 84 existing cases and one additional project-auth policy negative check. The whole-file RED reproduced **34 failed / 50 passed** before the test fixture change. The owning generated `test-tree-1` TypeScript program passes, exit 0.

## Proven cause

The existing test created a temporary `PAPERCLIP_HOME` but left its working directory in the operator's repository. The production `assertManagedAiProjectAuth` walks `config.cwd` or `process.cwd()` and its ancestors. Actual RED traces show its line 193 receiving `EPERM` when trying to open the operator's `.claude/settings.json` or `.codex/config.toml`. The credential-denying sandbox blocked those reads; no actual file contents were read. This was a fixture isolation gap, not a managed-admission or credential-writeback policy defect.

## Test-only repair

The fixture now owns a temporary workspace with explicit empty Claude/Codex project configuration files and uses that directory as this worker's cwd. Cleanup restores the original cwd in `finally` before removing the fixture and restores the existing environment stubs. No global HOME override, production file change, skipped case, widened timeout or original assertion change was made.

The added negative case writes a synthetic conflicting Anthropic project setting in the owned fixture and verifies that the real managed-runtime preparation still rejects it with `ai_connection_incompatible`. It restores the empty setting in `finally`. The full original inheritance, authorization, managed credential, health/reconnect and concurrent subscription assertions all pass; provider/environment execution remains under the test's existing fake adapters/fetch responses.

## Evidence

- `agent-hire-fixture-red.json` / `.log`: exact unchanged whole-file failing run and stacks.
- `agent-hire-fixture-green.json` / `.log`: 85 passed, exit 0, 32.00 s.
- `agent-hire-fixture-types.json` / `.log`: owning generated test-tree-1 type program, exit 0. This is a targeted test-program check, not a fresh whole-repository typecheck.
- `source-before.json`, `source-after.json`: changed test and unchanged reviewed production hashes.
- `guards.json`: config/cwd/provider isolation and type-program provenance.

All execution used Node 24, the same credential-denying sandbox, clean environment and isolated child-session wrapper. No real provider/login, service, Git or remote workflow action was performed. A final scoped whitespace/integration check passes. Broader suite qualification remains separate.
