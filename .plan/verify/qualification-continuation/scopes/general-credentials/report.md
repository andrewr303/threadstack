# General-lane credential fixture qualification

All three requested files have current protected Node24 qualification:2084tests pass, with seven unchanged Linux-only cases unavailable on macOS. Only ai-connections.test.ts needed a source repair. Native-session-executor and explicit-native-continuation retain their exact task-baseline bytes.

## Findings and repair

The entire AI-connections file reproduced the original48failures and four unhandled EPERM rejections while the macOS wrapper blocked operator .claude/.codex files. Managed project-auth validation defaults to process.cwd and walks its ancestors; these default-cwd fixtures therefore depended on the developer checkout and personal project settings.

The suite now changes only its isolated Vitest fork's default project cwd to its existing owned temporary home after database setup, then restores the original cwd in afterAll's finally before removing that fixture. Explicit project cwd inputs retain their normal meaning. No HOME or shared setup change, no authentication-policy mock and no source-policy relaxation was introduced. A new local Anthropic/OpenAI check verifies that the default project policy runs inside the owned fixture. All162cases then passed, including existing security/concurrency/refresh/cleanup assertions. The noEmit test-program typecheck also passed under the same protected Node24 wrapper.

The targeted native/explicit attempt to reproduce the17earlier failures was already GREEN (20passed including adjacent variants). Both entire files were then rechecked unchanged:1922passed,7existing Linux /proc-dependent skips. Thus no source defect is claimed or speculative edit made for these two files. The earlier broad run's exact cause is not established by this result; the current signed-ps/protected runtime now qualifies their unchanged source.

## Actual validation

- general-ai-connections-red.log:48failed/113passed,4unhandled rejections, exit1.
- general-ai-connections-green.log:162passed, exit0.
- general-ai-connections-types.log:exit0 using the retained noEmit test configuration.
- general-native-red.log:attempted reproduction20passed, exit0; its red filename does not label a failure.
- general-native-full-recheck.log:1922passed/7preexisting skipped out of1929declared tests, exit0.
- Scoped whitespace check:clean. Native/explicit baseline hashes:unchanged.

Exact command arrays, environment-key-only receipts and timestamps are copied beside each log. Runtime:Node24.22.2, pnpm9.15.4, Vitest5.0.3. The parent's same credential-denying sandbox and signed task-local ps were used. Current wrapper/profile hashes match the prior verified protected-canary execution; operator files remained denied and no actual contents were read. Provider refresh/probe/transport activity stays on the files' existing synthetic mocks/fixtures; no real provider login or generation was performed.

The seven existing skips are the remote-runner stale-state-holder describe guarded by /proc/self/cmdline availability. Their source was not changed and they are not counted as passes. Broader root aggregation and CI remain the parent's responsibility. The required ult-debugger router/TypeScript evidence workflow was followed; production policy preservation and source hashes are retained. No build, Git mutation or live-folder operation was performed.
