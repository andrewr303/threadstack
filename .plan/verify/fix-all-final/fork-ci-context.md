# Fork CI compatibility: AVRCORP/threadkeeper

Read-only inspection. No workflows were edited or triggered, no runner configuration changed, and no AWS/provider tools or secrets were used.

## What works and what blocks

The upstream reusable workflow is callable from this repository, subject to GitHub service availability. Live repository API inspection returned Actions enabled, `allowed_actions: all`, and default workflow-token permissions `read`. Hosted-minute quota/billing and an actual run were not verified.

The AWS assumption needs correction: `.github/workflows/ci-routing.yml:24` already falls back to `ubuntu-latest` unless the repository is exactly `paperclipai/paperclip` **and** ID `1170821064`, alongside the AWS admission settings. Its route step repeats those identity checks at lines 82–86. AVRCORP will not select that upstream runner fleet. No AWS setup is required for the proposed fork checks.

However the current `.github/workflows/pr.yml:19` delegates to mutable upstream `pr-trusted.yml@master`, whose gate itself delegates upstream. Upstream planning fetches the PR merge commit from the canonical repository. The fork's commit is not a canonical upstream commit, so that optimization falls back to an empty plan and full upstream CI. This is an expensive fallback, not the blocking permission fault.

The concrete migration blocker is `.github/workflows/pr-trusted.yml:174–191`: it loads lockfile policy from the target/base tree; when that file is absent, its legacy fallback rejects a changed `pnpm-lock.yaml` for ordinary human branches. Current Threadkeeper `main` has no `.github/scripts/lockfile-trust.mjs`, while this migration imports a root lockfile. Thus this PR's `fix/...` branch fails that policy regardless of whether its dependency installation succeeds. The source-pin refresh does not and should not bypass this independent policy. See `fork-ci-static-receipt.json`.

Coverage gaps also exist. The extension is deliberately excluded from pnpm workspaces, so upstream PR jobs never run its npm tests/build. The browser-sessions plugin appears in root Vitest configuration but is absent from `scripts/run-vitest-stable.mjs:25–46`'s explicit `nonServerProjects`, so that wrapper does not cover the new plugin either. Dedicated fork checks must invoke both explicitly.

## Minimal safe change to propose

Retain the canonical upstream call and add an explicit canonical-repository condition to its existing `if` expression. Add one separately named **Fork integration checks** job or a small local reusable workflow selected only for `AVRCORP/threadkeeper`. Keep the normal opened/synchronize/reopened PR event, the existing label behavior, `contents: read`, checkout with `persist-credentials: false`, no inherited secrets, and `runs-on: ubuntu-latest`. Do not use `pull_request_target` to run PR source and do not modify the trusted upstream lockfile guard.

Use the already pinned action SHAs from the existing workflow. Set Node 24 (at least 24.11), pnpm 9.15.4, and explicit timeouts. A fresh hosted checkout can use these sequential steps:

1. `pnpm install --frozen-lockfile` at the root. Fail on drift; do not use the upstream setup action's inline lock-resolution fallback for this exact-lock fork check.
2. `npm ci --prefix extension`. This is a separate React 18 installation; never add it to the pnpm workspace.
3. `pnpm run preflight:workspace-links` and `pnpm --filter @paperclipai/plugin-sdk ensure-build-deps`. The latter builds the actual shared/SDK artifacts needed by plugin imports.
4. `node tests/runner-e2e/source-sdk-public-inputs.mjs "$(git rev-parse HEAD)" --check` and `pnpm run test:threadkeeper`.
5. `pnpm run check:extension` for extension typecheck, all extension tests, guards/contracts, and the isolated `/tmp/tk-build` build. This does not deploy; no `TK_LIVE_DIR`, stable manifest key or real profile should be supplied.
6. `pnpm --filter @paperclipai/plugin-browser-sessions typecheck`, `pnpm --filter @paperclipai/plugin-browser-sessions test`, and `pnpm --filter @paperclipai/plugin-browser-sessions build`.
7. `PAPERCLIP_TYPECHECK_LOW_MEMORY=1 pnpm --filter @paperclipai/ui typecheck` and `PAPERCLIP_TYPECHECK_LOW_MEMORY=1 pnpm --filter @paperclipai/server typecheck`. The server's package script is the existing layered check; direct `tsc -p server/tsconfig.json` can exceed an ordinary runner's memory and is not the recommended lane. Its existing prerequisites build Runner TypeScript and shared/SDK dependencies; it does not request a live provider or Rust binary build.
8. Run the affected UI and server test files explicitly with their own Vitest configs, and build `pnpm --filter @paperclipai/ui build`. Prefer the exact existing integration test files, rather than claiming the whole upstream suite ran. The plugin bundle is already built in step 6.

For parallelism, split extension+plugin and UI+server into two jobs with their own fresh installations. A single sequential job is the smaller initial workflow and avoids simultaneous high-memory checks on a small private hosted runner. Upload test/build receipts with `if: always()` and useful explicit names. The checks must keep failures visible; no `continue-on-error` on required validation.

The applicable changed UI tests are the 18 files under `ui/src` returned by `git diff --name-only 79589c00e99453352b0aafe1c8b5582af42284ba HEAD -- ui`, including the host/boot/slot/overlay suites, browser session API/search/credential suites, live-update recovery, command palette/sidebar, InviteLanding and PluginPage. The changed server tests are the 12 files under `server/src/__tests__` from the corresponding server diff: bundled-plugins, cli-invocation-safety, company-live-events-stream, http-log-policy, logger-browser-session-redaction, plugin-install-autobuild, plugin-scoped-api-routes, redact-sensitive, static-index-html, tool-access-policy-service, tool-gateway and workspace-runtime. Select them explicitly or use a checked-in exact test list; do not rely on shell globs expanded in the wrong working directory.

## Boundaries to retain in the PR

Name these checks as fork/integration coverage, not full Paperclip qualification. A successful scoped job does not discharge the local verifier's ten broad CI lanes, all upstream runtime packages, Docker/native Runner qualification, real provider/model-key behavior, macOS helper/launchd, browser-native consent or MV3 suspension. A full `pnpm build` also builds the pinned Rust Runner and additional packages; it needs the declared Rust 1.97.1 toolchain, and is outside the minimum UI/plugin/extension build lane.

Do not rename a human branch to `chore/refresh-lockfile` or imitate Dependabot to satisfy upstream policy. Do not change the policy to accept arbitrary PR lock writes. Make the fork route explicit and leave canonical semantics intact.

There are other imported PR workflows. Most use GitHub-hosted runners and can run their own independent path-scoped checks; this review does not certify them. In particular, `commitperclip-review.yml` is a privileged base-context workflow with `ref: master` and a required `COMMITPERCLIP_KEY`; this repository uses `main` and that setup was not established. It should stay canonical-repository-only rather than ask for or synthesize an upstream bot credential. The current base tree has no such workflow, so the newly introduced `pull_request_target` definition is not a way to run this migration's tests.

This is a recommendation only. Actual hosted checks and their final revision/run URLs remain pending until a reviewed fork workflow is committed and the PR is opened.
