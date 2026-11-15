# Rust-dependent beforeAll-hook qualification

**All four unchanged files pass: 113 tests, no skips, exit 0.** The tests executed after their existing Cargo `--locked` beforeAll prerequisites completed.

| File | Passing tests |
| --- | --- |
| `server/src/__tests__/dot-runner.test.ts` | 57 |
| `server/src/services/native-runtime/plugin-runner-probe.test.ts` | 15 |
| `server/src/services/native-runtime/native-codex-runner.integration.test.ts` | 1 |
| `server/src/services/native-runtime/native-usage-delivery.integration.test.ts` | 40 |

The complete four-file run took **121.47 seconds**. Full results, rather than a failed hook followed by skipped bodies, are retained in `rust-four-hooks-recheck-isolated.log` and its exact command/environment/process receipt `.json`.

## Runtime and prerequisites

The parent repaired 287 private Cargo source directories from archives whose checksums matched Cargo.lock (`rust-cache-repair.json`); no global cache or dependency version changed. No source-cache corruption recurred in these builds.

The run used Node 24.22.2, Rust 1.97.1, the private Cargo/Rustup caches, and the unchanged credential-denying SBPL profile. The explicit `/usr/bin/env CARGO_TARGET_DIR=/Users/andrew/dev/threadkeeper/paperclip/packages/paperclip-runner/runner/target` override makes the locked hooks produce binaries at the hardcoded paths the unchanged fixtures actually execute. The opt-in `--ps-compat` runtime is explicitly recorded. Real model providers/logins were not used: provider boundaries are owned fake Rust/Codex executables and generated fixture state, with local PRP/MCP/usage endpoints.

Only required test fixture prerequisites built Cargo binaries/examples; no extension/UI/release-publication action, source edit, Git mutation, provider action or remote workflow operation was performed. `source-before.json` and `source-after.json` are identical for all four tests, Cargo.toml, Cargo.lock and the pinned toolchain file.

## Preserved outputs and cleanup

Before execution, **70 existing executable ignored Cargo outputs, 133,890,032 bytes**, were preserved under `original-executables/`, with original hashes, modes and timestamps in `original-executables.json`. Original release Runner code-signing metadata was also retained.

After execution, all 70 existing executables still matched their original bytes and modes, so **zero restorations were necessary**. The original release `paperclip-runnerd` passes strict code-signature verification (`restored-runnerd-codesign.txt`). `restoration.json` records every verification. Newly generated ignored `fake-codex-app-server` and `recovery-fixture` outputs remain available. `tested-artifacts-before-restoration.json` identifies the exact exercised binary bytes.

## Earlier interruption retained

The first attempt was terminated with SIGTERM/exit 143 after its Vitest header and before any file result. Its original partial receipt/log and audit remain `first-attempt-interrupted.*` and `interruption-audit.json`; no pass is claimed for that attempt and no signal source is asserted.

At the parent's instruction, the retry used a wrapper with a separate child session and recorded PID/group identities. The successful run records wrapper PID/PGID **38742**, child PID/PGID **38885**, `isolatedChildSession: true`, and `receivedSignals: []`. This is evidence of the completed isolated retry, not a retrospective explanation of the older unrelated terminations.

The parent's broader suite and final integration remain separate qualifications.
