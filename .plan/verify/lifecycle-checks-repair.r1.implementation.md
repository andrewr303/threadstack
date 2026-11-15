# Implementation report: lifecycle / helper / check-script repair (r1)

Author: `impl-lifecycle-checks-repair-20261114`. Plan root `.plan`. Source: `.plan/verify/audits/20261114/{REQ-4,REQ-5 (F1),REQ-1-2-3}.audit.md`.

Gate status: load gates for REQ-3/4/5 return `ok:false` (predecessors wait on founder-only checks). This is bounded repair of in-progress work on the user's instruction. No gate pass is claimed. No statuses, INDEX, review ledgers or `.plan/config.json` were touched. Independent spec and quality review: `PENDING_INDEPENDENT_REVIEW`.

Node: `export PATH="$HOME/.nvm/versions/node/v24.22.1/bin:$PATH"`.

## Files changed (all existing files except one new test)
- `extension/src/core/paperclip/lifecycle.ts`
- `extension/src/entrypoints/manager/PaperclipConnection.tsx`
- `extension/mac-helper/core.cjs`
- `extension/tests/unit/paperclip-lifecycle.test.ts`, `paperclip-helper.test.ts`, `paperclip-connection.test.tsx`
- NEW `extension/tests/unit/paperclip-connection-status.test.tsx`
- `scripts/threadkeeper-check.mjs`, `scripts/threadkeeper-deploy.mjs`, `scripts/threadkeeper.test.mjs`
- `package.json` (scripts block: added `test:threadkeeper` only)
- `doc/THREADKEEPER-SERVICE.md`
- this report
No scope discrepancy.

## Finding table
| Finding | Status | Test | Result |
|---|---|---|---|
| REQ-4 1 (helper missing re-messaged, AC-11) | fixed: `helperMissing` remembered for the lifecycle's life (also `unsupported_platform`) | lifecycle "remembers an unavailable helper..." | green, <=1 call over 3 polls, also for a throwing host |
| REQ-4 2, 4 (not-registered dead end) | fixed: exact line from `paperclipLifecycleText`; Set up / Retry / logs note hidden for that reason | lifecycle "shows the exact reinstall line..."; status tests | green |
| REQ-4 3 (raw codes, AC-3) | fixed: `REASON_TEXT` map, unknown reasons pass through | lifecycle `it.each` x5; status tests assert no `paperclip_*` text | green |
| REQ-4 5 (Start only if helper connected) | fixed: snapshot `helperConnected`; Start hidden when `=== false` (undefined keeps legacy so the existing `paperclip-view.test.tsx` fixture still passes) | status tests | green |
| REQ-4 7 (non-401 auth failure) | fixed: 5xx / network / timeout -> `unreachable` (`auth_check_failed`); 401 and 403 and missing userId -> `needs_sign_in` | lifecycle "reports a failing auth check..." | green |
| REQ-4 8 (no serviceName) | fixed in `core.cjs` | helper "treats an installed status without a serviceName..." | green |
| REQ-4 9 (install timeout) | fixed: 70 s race, then `start_failed` and polling resumes | lifecycle "gives up on an install..." | green |
| REQ-4 6 (dedup across restarts) | documented, not persisted (persisting needs `integration-runtime.ts`, out of scope; start is a no-op when active) | none (comment + doc) | n/a |
| REQ-4 10 (render tests) | fixed: 12 state rows + click wiring | `paperclip-connection-status.test.tsx` | green |
| REQ-5 F1 (5 s while view active) | lifecycle part fixed: `activeView` option + `setActiveView()`; hook takes 3rd arg `viewActive` | lifecycle "polls a running server every five seconds..."; connection "...five seconds while the Paperclip view is active" | green |
| REQ-3 1 (wire guard tests) | fixed: `test:threadkeeper` script; `node --test` command in both `check` modes | "guard tests are wired..." | green |
| REQ-3 3 (no `key`) | fixed: `assertBuiltManifest` after the build (exists, written this run, no `key`) | "the built manifest must exist, be fresh..." | green |
| REQ-3 missing guard tests | fixed: stale output, symlink output, lock importer, React 18 | 3 tests | green (importer test passed before the change: characterization) |
| REQ-3 5 (deploy guard) | fixed: realpath, refuses fork, home, `/tmp/tk-build(.staging)` and their parents | "deployment refuses relative, unsafe and aliased targets" | green |
| REQ-3 6 (entry point) | covered: spawn with unset, empty, `.`, `foo/`, `..`: exit 1, temp dir empty | "the deploy entry point exits 1..." | green (passed before the change: characterization) |
| REQ-3 2 (`test_commands`), 4 (hooks), 7, 8 | not fixed: config / out of scope | | see follow-ups |

Existing assertions edited (not weakened): `threadkeeper.test.mjs` command-plan test now accounts for the inserted guard-test command. `paperclip-helper.test.ts` source-shim fixture now returns a `serviceName` and a launchd definition naming the shim, as a real status does; assertions unchanged.

## TDD (RED observed before code)
| Behavior | RED argv / cwd | RED result | GREEN |
|---|---|---|---|
| lifecycle + helper + status + connection tests | `npx vitest run tests/unit/paperclip-lifecycle.test.ts tests/unit/paperclip-helper.test.ts tests/unit/paperclip-connection-status.test.tsx tests/unit/paperclip-connection.test.tsx`, cwd `extension/` | 14 failed / 27 passed; all missing behavior (raw codes, 30 s cadence, repeated status, needs_sign_in on 500, install never times out, ...) | same argv + `paperclip-view.test.tsx`: all pass; then helper fixture update, 6/6 |
| scripts | `node --test scripts/threadkeeper.test.mjs`, cwd fork root | first run: import error for missing `assertBuiltManifest`; after a throwing stub: 5 failed, 4 passed | 9/9 pass |
Refactor assessment: no change, the edits are minimal.

## Checks
Run: `npx tsc --noEmit` (cwd `extension/`) exit 0. `npx vitest run` over lifecycle, helper, connection-status, connection, view, integration-runtime, manager-app test files: 7 files, 95 tests pass. `npx vitest run tests/unit/paperclip-` (24 files): 211 pass, 1 fail in `paperclip-credentials.test.ts`; that file passes alone (16/16), file untouched by me, so likely a concurrent edit by another agent or timing. `node --test scripts/threadkeeper.test.mjs`: 9 pass.
Not run (by instruction): `check:all`, `check:extension`, `deploy:extension`, build, browser, launchd, native host. The post-build manifest assertion in `main()` is unit-tested only, never run end to end.

## Follow-ups for others
1. App.tsx owner: pass `view === 'paperclip'` as the third argument at `App.tsx:326`: `usePaperclipConnection(settings?.paperclip, isPage && settings !== null, view === 'paperclip')`. Until then the 5 s cadence is inactive in the app (REQ-5 F1 not met end to end).
2. Coordinator: `.plan/config.json` `test_commands` lacks `["pnpm","test:run"]` (REQ-3 AC-9 finding 2), and `hooks.enabled: true` conflicts with the REQ-1 alternative (finding 4). `["pnpm","run","test:threadkeeper"]` can now be added.
3. Dedup persistence (REQ-4 finding 6) is documented only; persisting needs `integration-runtime.ts`.

## Concerns
- Minor: 403 on the auth check is treated as `needs_sign_in` (audit said 401 only); judged a rejected credential.
- Minor: `deploymentEnv` returns the lexical `TK_OUT_DIR`, so a symlink swapped after the check is not re-checked; the build's non-Threadkeeper-folder refusal remains the backstop.
- Minor: the guard also refuses ancestors of the fork, home and `/tmp/tk-build`; a founder-chosen live folder equal to such an ancestor is now rejected.

## Round 2: deploy guard NF-1 (Blocker from the cumulative spec review)
Defect: the guard refused everything under the home directory, so the documented live folder `<home>/dev/threadkeeper/.output/chrome-mv3` could never be a target (REQ-3 FR-5, AC-7, AC-8).
- RED: test rewritten first (injected temp `home` and `fork`; negative cases for home, its parent, fork, inside fork, `/tmp/tk-build` and inside, symlink aliases; new positive test for a `<home>/dev/threadkeeper/.output/chrome-mv3`-shaped temp target, a symlink to it, and `<home>/Documents/tk`). `node --test scripts/threadkeeper.test.mjs`, cwd fork root: 8 pass, 2 fail (the positive test and the rewritten refusal test, which no longer asserts the wrong "ancestor of fork / inside home" rule).
- GREEN: `scripts/threadkeeper-deploy.mjs` now refuses only: root, home and its ancestors, the fork and anything inside, `/tmp/tk-build(.staging)` and anything inside. Same command: 10 of 10 pass. Temp dirs only; no deploy performed.
- Removed wrong rules: refusing ancestors of the fork and of `/tmp/tk-build`, and refusing everything inside home. The build's refusal of a non-empty non-Threadkeeper folder remains the backstop for those.
- Docs: `doc/THREADKEEPER-SERVICE.md` updated to match. Refactor: no change.
- Note: the first GREEN run had one failure from my own test bug (alias name collided with the injected home dir); aliases renamed, then 10 of 10 pass.
- Found while greening: a dangling symlink to a path inside the fork was not resolved (guard hole). `realResolve` now follows dangling links; covered by the `fork-alias` case. First GREEN attempts also hit a test bug (alias name collided with the injected home dir), fixed by renaming. Final: `node --test scripts/threadkeeper.test.mjs` 10 of 10 pass.
