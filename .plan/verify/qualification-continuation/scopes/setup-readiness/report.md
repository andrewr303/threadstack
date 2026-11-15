# Hermetic Codex setup-readiness qualification

The previously held readiness cases are now qualified locally:102tests pass (the original98, two added credential-boundary checks, and two shared-setup regressions). The test-only TypeScript program passes. No production credential/runtime code was changed. Source hashes, actual results and scope are in `receipt.json`; `production-preservation.json` compares the relevant production call path with HEAD.

## Safety decision before execution

The old shared server setup only created synthetic Codex auth when CODEX_HOME was unset. A provider session with an existing home therefore carried its real selection into setup-readiness. `testNativeRunnerAuthentication` resolves that inherited home, then inspects auth.json with lstat/realpath/stat before reaching the already-mocked native provider probe. Linked unmanaged auth fails at that preflight; managed fixture sources can read config/auth and later invoke copyback. Running the original file against unknown ambient credential files was inappropriate. No readiness suite was run until the shared isolation fix and test-local read gates were installed.

All native provider probes, selected runner resolution, SSH execution/runner, remote artifact preparation/launcher, PRP registration and ingress callbacks remain mocks. Existing security assertions still exercise real temporary-file mode/owner/size checks, symlink policy, source precedence, redaction, cleanup, account identity and refresh copyback. Local copyback policy may run its repository Python merge predicate, but only after a semantic path gate confines its target to owned synthetic fixtures. No provider login or generation occurred.

## Changes

- `server/src/__tests__/setup-supertest.ts` now always claims an owned synthetic Codex home with the same existing sk-vitest account fixture. It uses the existing identity-checked isolated-home cleanup at worker exit. Tests that deliberately choose another source still do so explicitly. This changes a Vitest worker's test environment; it does not change the agent shell/user HOME or CODEX_HOME.
- `setup-codex-home-isolation.test.ts` spawns the actual shared setup with either an empty or preexisting synthetic canary selection. A pre-I/O filesystem guard rejects any attempt to touch that canary. It proves a different generated account, owner-only auth mode, zero canary accesses, unchanged sentinel and removal of the generated home after exit.
- `setup-readiness.test.ts` registers every mkdtemp root and the shared synthetic account, including canonical macOS path aliases. Sensitive filesystem operations and the semantic credential-reader/copyback entry points reject unowned paths before delegation. The semantic gate also covers opaque source-store filenames and the copyback subprocess boundary. Linux internal descriptor traversal stays with the real confined reader after its canonical input has been authorized. The four source-precedence cases retain their assertions but use owned temporary paths instead of global /host-home-style paths.
- An opt-in audit records only test names, operation names, credential basenames and allowed/blocked status, never credential bytes or full host paths.

## Evidence and commands

Runtime: Node26.13.0, pnpm9.15.4, Vitest5.0.3 on macOS. Commands run from the server directory.

| Phase | Command/scope | Result | Retained evidence |
|---|---|---|---|
| Shared setup RED | pnpm exec vitest run src/__tests__/setup-codex-home-isolation.test.ts |2failed: inherited home retained; generated fallback home not cleaned|shared-setup-red.log|
| Shared setup GREEN |same command after shared repair|2passed|shared-setup-green.log|
| Controlled historical reproduction |pnpm exec vitest run --config /tmp/tk-continue/setup-readiness/controlled-linked.config.ts src/services/native-runtime/setup-readiness.test.ts|21failed/79passed with an entirely synthetic linked operator home|controlled-linked-red.log; controlled-linked-operator-setup.ts; controlled-linked.config.ts|
| Final accepted functional check |PAPERCLIP_TEST_CREDENTIAL_IO_AUDIT=/tmp/tk-continue/setup-readiness/credential-io-accepted-audit.ndjson pnpm exec vitest run src/services/native-runtime/setup-readiness.test.ts src/__tests__/setup-codex-home-isolation.test.ts|102passed, exit0|readiness-accepted-green.log|
| Explicit test-program types |pnpm exec tsc --noEmit --pretty false -p /tmp/tk-continue/setup-readiness/tsconfig.json|exit0|typecheck-accepted.log; tsconfig.json|
| Scoped whitespace |git diff --check for tracked owned files plus direct check of new regression file|clean|receipt/source check|

`historical-failure-comparison.json` proves that the controlled fixture reproduces exactly the same21 failing names reported in the original interrupted suite, with no missing/new names. That reproduction is deliberately labelled synthetic fault injection against current guarded tests; it is not a claim that real ambient credentials were inspected.

`credential-io-accepted-audit.ndjson` covers100readiness cases and805credential operations. There are zero unexpected denials. Three denials belong to the two explicit guard self-tests and happen before read/copyback delegation. The remaining original security behavior runs against real synthetic fixture files. `safety-audit-summary.json` retains counts and redaction checks.

## Intermediate failures and limits

The first added guard self-test incorrectly used a promise-rejection assertion around a deliberately synchronous pre-I/O refusal; that assertion was corrected. One later run timed out in the first test during its cold dynamic executor import. Its focused recheck and the final full102case run passed; the timed-out attempt remains unqualified and retained. No timeout limit or security assertion was weakened.

The first temporary external typecheck configuration lacked Node typeRoots and inherited packaging declarations; the next omitted the server's Express augmentation. The accepted test-only configuration supplies both normal ambient contexts and checks with no emit/declarations. Failed attempts remain in typecheck.log and typecheck-corrected.log; only typecheck-accepted.log is a pass.

The baseline shared-setup RED left one synthetic fallback home because missing cleanup was itself the reproduced defect. Its exact recorded device/inode was matched and that owned fixture alone was removed; shared-red-cleanup.json records this. No other temporary homes or credentials were searched by content or deleted.

The required ult-debugger router and TypeScript specialist were followed; RED triage outputs are retained. No commit, push, build, live extension access, real provider login or generation was performed. These focused checks do not replace the parent's broader final-suite and CI qualification.
