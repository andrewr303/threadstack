# SDK source-pin and reviewed-lock refresh

The stale-pin blocker is fixed in metadata commit `258c14f8da4761932a6c2e7d7255e0c09cb1f7d7`.
Only `tests/runner-e2e/report-lock.json` and `tests/runner-e2e/source-sdk-public-inputs.json` changed.
The actual `pnpm-lock.yaml`, original `report-lock.patch`, source-proof code and lock guard code are unchanged.

## Cause and correction

The integration changed three pinned inputs: root `package.json`, `packages/plugins/sdk/src/types.ts`, and the lockfile's browser-sessions importer. The previous pin registry still described their old blobs. The ordinary synchronization command correctly refused because the reviewed-lock policy also retained the old lock hashes.

The parent of integration commit `5731f71118d5f75aaf21b891b257694a3d179dbf` already contained the reviewed **output** lock. Its SHA-256 was `33360fbf59530ddddd735eba7dbcbcdf05797b68b6418799e6470265c875accb`. The integration adds only the plugin importer to that output. Therefore directly applying the correction again would be incorrect.

In task-owned temporary directories, I reverse-applied the original correction to both old and new corrected locks. The recovered old input matches the originally authenticated input hash. The new input differs from that old input by exactly the same importer block. Forward-applying the unchanged original patch to the new input reproduces the committed current lock byte-for-byte.

- New reviewed input: `f9d5d17709d67507ade1fa33b9eadb0bcb6f6cdc3eeb8e22ca55256c55bd9f54`.
- New reviewed output/current committed lock: `2e78848e16d0b2fb93ea0a01b92285cb083b12329884da758fd61e122d014737`.
- Unchanged patch: `7014e80a06ae8ec66d59268c4037262ab7d1f86e494a783bcc9c6d6c0f39ad02`.

The registry refresh uses all 543 source/build-input blobs from committed integration source. Exactly the three expected blob pins changed. Its lock output pin follows the reviewed policy. Compiler, parser, zod and every other runtime pin retain their previous values. No dependency resolution, installation, build, provider access or live lock write was performed.

## Verification

Runtime: Node `v26.13.0`, pnpm `9.15.4`, macOS arm64.

| Check | Result | Evidence |
| --- | --- | --- |
| Official source synchronizer before repair, `--check` at integration commit | Correct refusal, exit 1; committed lock is not reviewed by old policy | `red.log`, `red-command.json` |
| ult-debugger TypeScript triage of actual refusal | V8 Error, high confidence, root `reviewedSdkLockSha256:34` | `red-triage.json` |
| Working-tree drift guard after refresh | No stale inputs | `working-tree-drift-green.json` |
| Official source synchronizer, `--check` at metadata commit | Exit 0; 543 inputs; `changed:false`; `runtimePinsChanged:false` | `official-check-green.log`, `official-check-command.json` |
| `node node_modules/vitest/vitest.mjs run --config tests/runner-e2e/vitest.config.ts tests/runner-e2e/prepare-report-lock.test.ts --maxWorkers=1` | 10 tests passed | `lock-tests.log` |
| Same Vitest runner, `tests/runner-e2e/source-sdk-public-inputs.test.mjs` | 13 tests passed | `source-inputs-vitest-final.log` |
| `node --test scripts/__tests__/local-verify.test.mjs` | Exit 0; 15 tests passed | `local-verify-node-final.log` |
| `pnpm verify --explain` | Exit 2, broad CI required; it progresses past source-pin drift validation | `verify-explain-green.log` |
| Byte and scope integrity | Lock, correction patch and three guard source files unchanged; only two JSON metadata files differ from task baseline | `refresh-receipt.json`, `final-integrity.json` |

The required broad CI lanes reported by the actual verifier are `typecheck_release_registry`, `general_tests`, `docker_context_integrity`, `sandbox_provider_tests`, `verify_paperclip_runner`, `build`, `verify_serialized_server`, `canary_dry_run`, `e2e_shards`, and `verify_runner_e2e_support`. This refresh does not qualify those lanes, browser acceptance or a full Paperclip suite.

An initial mixed `node --test` invocation incorrectly included the source-pin `.test.mjs` file, which uses Vitest. Its 15 local-verifier node cases passed, but the combined command failed on the mismatched runner. That attempt is retained in `node-tests.log`; the corrected source-pin Vitest invocation and clean separate local-verifier node invocation both pass.

No task-owned Git commit or push was performed. The parent committed the two reviewed metadata files before the official committed-policy check. Historical artifacts and unrelated dirty files were preserved.
