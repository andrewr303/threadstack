F-7 remaining contract checks are fixed within the two assigned files. N-1 runner wiring was left untouched.

Files edited:

- `scripts/threadkeeper-contracts.test.mjs`: loads the actual extension host parser, fusion reducer/router, UI host, slot registry and plugin manifest through `tsImport`. Exercises Browse, Threads and Session board through the open-view event, slot wire message, shell view, company route and placement acknowledgement, including the unfused guard and null placement. App's placement effect and the slot component's open-view effect are selected by AST and executed with explicit boundary bindings; no mapping regex or copied implementation is used.
- `packages/plugins/plugin-browser-sessions/tests/service.spec.ts`: imports the extension's actual `VERDICT_MARGIN_MS` through `tsImport` and replaces only the duplicated `1_500` subtraction. The TS import avoids adding the extension's source tree to the plugin's TS project. All unrelated assertions remain unchanged.

During execution, PluginPage's inline ThreadkeeperSlot was extracted into `ui/src/components/ThreadkeeperSlot.tsx` by an existing worktree edit. The contract check now follows PluginPage's actual component import. That component, App and every other production file were preserved. The current contract evidence includes the extracted component; the earlier evidence is retained separately.

Validation (repo cwd `/Users/andrew/dev/threadkeeper/paperclip`; Node v26.13.0, pnpm 9.15.4; base HEAD `79589c00e99453352b0aafe1c8b5582af42284ba`; tested working tree hashes in `contracts-f7/current/lead-check.json`):

| Command | Result | Evidence relative to /tmp/tk-fix-all/ |
| --- | --- | --- |
| `node --test scripts/threadkeeper-contracts.test.mjs` before edits | 3/3 pass; missing mapping coverage | `contracts-f7/baseline-contract.log` |
| `node --test scripts/threadkeeper.test.mjs scripts/threadkeeper-contracts.test.mjs` final | exit 0; 17/17 pass (7 contract + 10 runner/guard tests); input hashes stable during execution | `contracts-f7/current/final-threadkeeper.log`, `current/final-check.json` |
| `pnpm --filter @paperclipai/plugin-browser-sessions test` | exit 0; 110 tests across 5 files | `contracts-f7/plugin-first.log` |
| `pnpm --filter @paperclipai/plugin-browser-sessions typecheck` | exit 0; source and test TS projects checked with no emit | `contracts-f7/plugin-typecheck.log` |
| `python3 /tmp/tk-fix-all/contracts-f7/current/run-mutations-fixed.py` | exit 0; all 12 expected outcomes | `contracts-f7/current/mutation-run.log`, `current/mutations/mutation-receipt.json` |
| `git diff --no-index --check <saved-before> <current>` for both edited files | no whitespace diagnostics; exit 1 denotes the expected file differences | `contracts-f7/current/whitespace-check.json` |

Mutation proof uses isolated source copies, with module installations linked read-only for resolution. Each row mutates only one production-source copy; no live source is mutated:

| Mutated seam | Old 3-test contract suite | New 7-test suite | Restored fixture |
| --- | --- | --- | --- |
| extension host: session-board -> threads instead of dashboard | passes; blind spot reproduced | fails on parsed slot view | 7/7 pass |
| fusion route: dashboard -> threads instead of session-board | passes; blind spot reproduced | fails on generated company route | 7/7 pass |
| App placed acknowledgement: dashboard -> threads instead of session-board | passes; blind spot reproduced | fails on acknowledged route | 7/7 pass |
| PluginPage-imported slot component open-view: session-board -> threads instead of dashboard | passes; blind spot reproduced | fails on parsed open-view message | 7/7 pass |

Exact commands, changes, outputs and source-preservation hashes are in `contracts-f7/current/mutations/mutation-receipt.json`; the fixture and all 12 logs are retained beside it. `contracts-f7/current/changes.patch` is the owned-file patch against the saved starting bytes, including these initially untracked files.

Debugging followed `/Users/andrew/dev/Plugins/ult-debugger/skills/ult-debugger/SKILL.md` and its `debug-typescript/SKILL.md`. Doctor reported Node v26.13.0. Initial TAP-formatted failure logs were not recognized by triage; an actual error-stack reporter captured a recognizable V8 AssertionError, and triage returned high confidence (`contracts-f7/mutation-stack.log`, `mutation-stack-triage.json`). No systematic-debugging skill was activated.

Two evidence-harness attempts needed correction: the first whitespace wrapper incorrectly expected exit 0 from `git diff --no-index` (empty diagnostics and exit 1 are normal for differing files); the first refreshed mutation wrapper accidentally added a fifth tuple item and stopped after three completed mutation triplets. Those attempts are not counted as passes. The corrected refreshed wrapper and complete receipt are under `contracts-f7/current/`.

Limits: these are executable cross-package contract checks, with the two real React effect callbacks isolated; they do not mount the full App/PluginPage or establish effect scheduling, UI acceptance or provider behavior. The new slot component's placement-observer behavior belongs to its own UI tests. No browser runner, build, commit, push, PR publication, full-repo verification or CI was run, per this task's scope. Broad PR/complete-gate qualification remains outside this slice. The final bounded integration/scope check is `contracts-f7/current/lead-check.json`.
