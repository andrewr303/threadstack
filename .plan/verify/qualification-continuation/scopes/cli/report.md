# CLI qualification repair and environment classification

Production source is unchanged. All tests below ran with Node 24.22.2, the same credential-denying SBPL profile, and the clean-environment wrapper. No tests ran unsandboxed, no actual provider generation or helper/service installation was performed, and no ambient credentials were read.

## Classification

- Ten worktree failures were an execution-environment restriction: macOS `/bin/ps` is setuid (`04755`), and `spawnSync ps` returned `EPERM` inside SBPL when inspecting only the current PID. The same own-PID operation succeeded outside the sandbox. The original production process identity algorithm remains unchanged.
- A byte-identical ordinary-owned copy was initially unusable (`SIGKILL`, even outside SBPL); those failed attempts are retained. The parent provided a task-owned `0755` ad-hoc-signed copy with an identical executable `__TEXT,__text` section. Its own-PID control succeeds inside the unchanged sandbox while the credential canary remains denied. See `guards.json` and the referenced parent runtime receipts.
- The company import/export HTTP 403 came from the same fail-closed local process boundary. With a functioning `ps`, the fixture reached the next API operation. An added safety guard initially encountered a 422 because native Runner correctly rejects a custom command; explicitly choosing `legacy` preserves the fixture's existing `claude_local` adapter coverage, allows the owned refusing executable, and round-trips successfully. This temporary 422 was introduced during fixture hardening, not a production regression.
- Doctor's original failure was `summary.warned` expected 0, actual 1: the test had inspected the operator's managed CLI installation and warned that its shim directory was missing from the intentionally cleaned PATH. It was not an exit-code failure.

## Test-only changes

`doctor.test.ts` now owns its managed-install store/shim fixture, stubs external service detection, disables update-notice network traffic, traps and asserts zero fetches, and cleans its temporary config/runtime directory. Existing repair-success, zero-warning and JWT assertions remain intact.

`company-import-export-e2e.test.ts` retains all original company/agent/project/task/ZIP round-trip assertions. Its `claude_local` fixture explicitly chooses the legacy runner, disables timer and demand wakeups, and points at an owned refusing executable. Cleanup asserts that executable was never invoked. It continues to use owned application/shell homes, context/auth stores, local storage/key paths, loopback-only server and temporary PostgreSQL databases.

No worktree test, production lock/process boundary, or authentication policy was weakened or skipped.

## Actual validation

| Check | Result | Receipt |
| --- | --- | --- |
| Doctor in original credential sandbox | 1 passed | `cli-doctor-guarded.json`, `.log` |
| Three-file attempt with unusable byte-identical ps copy | 54 passed, 11 failed | `cli-three-guarded-owned-ps.json`, `.log` |
| Signed-owned-ps run: unchanged worktree suite plus doctor | 63 worktree + 1 doctor passed; company fixture had temporary 422 | `cli-three-guarded-signed-ps.json`, `.log` |
| Final company import/export fixture | 1 passed, including ZIP/new/existing company paths and no provider command invocation | `cli-company-guarded-signed-ps.json`, `.log` |
| Final CLI TypeScript | exit 0 | `cli-typecheck-guarded.json`, `.log` |
| Scoped whitespace check | exit 0 | `git diff --check -- cli/src/__tests__/doctor.test.ts cli/src/__tests__/company-import-export-e2e.test.ts` |

Thus all 65 cases in the three requested files have passing relevant evidence. Worktree and doctor evidence remains applicable after the final edit, which only adds the explicit legacy runner to the separate company fixture. The entire UI/CLI run was not repeated; the parent owns broader qualification.

Exact commands/environment metadata are copied unchanged into `commands.json`. Source hashes are in `source-before.json` and `source-after.json`; `worktree.test.ts` and `worktree-port-registry.ts` match their before hashes. Guard provenance is in `guards.json`. Parent runtime/process source was not changed by this worker.
