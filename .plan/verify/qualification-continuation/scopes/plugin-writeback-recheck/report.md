# Plugin task credential-writeback fixture isolation

**25 tests pass, no skips**, including all 24 existing credential-handoff cases and one new project-auth policy negative check. Whole-file RED was **20 failed / 4 passed**. The owning generated `test-tree-0` TypeScript program passes, exit 0. Final scoped whitespace check passes.

## Cause and repair

The actual RED traces show `assertManagedAiProjectAuth` at `ai-connection-runtime.ts:193` receiving `EPERM` when the shared fixture implicitly starts its project-auth scan from the operator's repository cwd and reaches `/Users/andrew/.codex/config.toml`. The credential-denying sandbox blocked the read; no actual operator credential contents were read. The Grok cases, which do not use that Codex project-auth scan, already passed.

Only this test file changed. Its existing temporary fixture home now contains an owned workspace and empty `.codex/config.toml`; the managed-runtime preparation receives that explicit workspace as `config.cwd`. **Neither process cwd nor global HOME is changed.** Production authentication, managed admission, account/lease identity and credential-writeback policy remain unchanged.

The added negative case writes a synthetic conflicting `model_provider` setting in the owned config and verifies the real fixture preparation rejects it with `ai_connection_incompatible`, then restores the empty config in `finally`. This proves the production check remains active rather than mocked or bypassed.

All original assertions remain intact: durable handoff after invocation files disappear, Codex/Grok refreshes, malformed snapshots, authority changes while export yields, PRP refresh replay, stop/export/complete ordering, reconnect and physical task replacement fences, database-save failure recovery, concurrent cleanup, and rejection of late submission after task retirement.

## Evidence and scope

- `plugin-writeback-fixture-red.json` / `.log`: exact unchanged whole-file failure and stacks.
- `plugin-writeback-fixture-green.json` / `.log`: **25 passed**, exit 0, 20.98 s.
- `plugin-writeback-fixture-types.json` / `.log`: owning generated test-tree-0 type program, exit 0; not a new repository-wide typecheck.
- `source-before.json`, `source-after.json`: changed test and unchanged production file hashes.
- `guards.json`: workspace/config/provider and compiler-program provenance.

Runs used the protected Node 24 clean-environment, isolated-session wrapper and unchanged credential-denying sandbox. Existing synthetic subscription refresh and fake plugin APIs remain the only provider boundaries. No real provider/login, service, Git, workflow or live extension operation occurred. No timeout, skip policy or existing assertion was weakened. Broader suite qualification remains the parent's work.
