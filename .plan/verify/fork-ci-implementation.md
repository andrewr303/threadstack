# Scoped CI for the Threadkeeper hard fork

The PR caller now routes the canonical `paperclipai/paperclip` repository to its existing trusted reusable workflow and routes `AVRCORP/threadkeeper` to a separate local integration workflow. Other repositories receive neither route. The opened, synchronize, reopened and supported-label behavior is preserved.

This fork route addresses a bootstrap mismatch rather than changing upstream policy: Threadkeeper's pre-migration `main` has no protected lockfile-writer policy, and the upstream workflow's legacy fallback rejects the newly imported root lockfile on an ordinary human PR. Upstream runner admission and lockfile-writer checks remain unchanged. No AWS configuration or upstream bot credential is used.

## Scope and authority

Both fork jobs use `ubuntu-latest`, a read-only contents token and a credential-free checkout. The reusable workflow receives no inherited secrets and has no deployment or provider actions. Its concurrency group cancels only earlier fork integration runs for the same PR. Node 24 and pnpm 9.15.4 match repository requirements; installations remain frozen. The extension keeps its separate npm/React 18 installation.

The extension/plugin job runs the fork CI contract, committed SDK source-pin check, actual extension safety guard, 17 existing guard/cross-package checks, extension typecheck, all extension tests with two workers, and a fresh isolated build at `/tmp/tk-build`. It verifies the built manifest's age and absence of a stable key. This is the same coverage as `check:extension`, expanded into steps to bound worker concurrency. It also typechecks, tests and builds the browser-sessions plugin explicitly, because that plugin is absent from the upstream test wrapper's fixed project list.

The UI/server job performs the SDK/shared build preparation, committed source-pin check, low-memory UI and existing layered server typechecks, the 18 affected UI test files and 12 affected server test files, then the UI production build. Exact file selections and commands are in `.github/workflows/threadkeeper-pr.yml`. The jobs have 30- and 45-minute timeouts and retain failures as failures.

## Static verification

- `node --test scripts/threadkeeper-ci.test.mjs` before implementation: exit 1, three failures for missing fork admission/workflow.
- `node --test scripts/threadkeeper-ci.test.mjs .github/scripts/tests/ci-routing.test.mjs` after implementation: exit 0, **147 tests passed**. The new cases exercise canonical/fork/unrelated repository admission and label behavior, read-only hosted execution, separate frozen installations, isolated build safety, and explicit integration coverage. The existing upstream routing suite remains unchanged and passes.
- Both workflow files parse as YAML with duplicate-key checks enabled.
- All 15 embedded shell blocks pass `bash -n`.
- The new test module passes `node --check`; scoped whitespace checks pass.
- SDK working-tree pins remain current. CI file changes do not alter the package/source inputs in that registry.

Raw local receipts are retained at `/tmp/tk-fix-all/fork-ci-red.log`, `fork-ci-green.log`, and `fork-ci-static-validation.json`. Static validation ran on Node v26.13.0 on macOS arm64. It does not establish that a Node 24 hosted run, installation or build passed.

## Qualification boundary

No workflow was triggered, no remote permission was changed, and no hosted result is claimed. GitHub's read-only API reported repository Actions enabled and all action sources allowed; hosted-minute/billing availability remains unverified. The local reusable workflow is called from the normal PR workflow at the same tested revision; it does not need to execute PR source in a privileged base-branch workflow.

Passing these scoped jobs does not qualify the full Paperclip test suite, all native Runner packages, Docker/release flows, real provider/model keys, browser consent, macOS helper/launchd, service-worker suspension or live-library continuity. Those remain explicit gaps in the main verification report. The canonical upstream CI and its policy are not weakened to manufacture a full-suite pass.
