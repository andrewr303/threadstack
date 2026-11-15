# Session preparation and adapter accounting fixture repair

**PASS: 41 tests across both complete files; explicit two-file TypeScript no-emit program passes.** Only the two assigned test files changed.

## Evidence and cause

The unchanged failed-case reproduction confirms all five broad-run failures:

- Four OpenCode accounting cases try to create the real operator `~/.claude/skills`, denied by the existing sandbox. Their fixture config had `XDG_CONFIG_HOME` but omitted `HOME`; OpenCode's real `resolveOpenCodeSkillsHome(config)` uses `config.env.HOME`, falling back to the operator home.
- The retry/refusal session-preparation case uses a delegated Codex runtime without a configured `cwd`. Its real managed project-auth preflight consequently starts at the repository cwd and walks through the operator home, hitting the protected `.codex/config.toml`.

The saved RED log contains the concrete stack and policy failure for each. ult-debugger router plus TypeScript specialist guided diagnosis; `triage.json` retains parsed evidence.

## Minimal test changes

The four existing adapter fixtures now set child configuration `env.HOME` to each existing, cleaned-up owned temporary directory, alongside `XDG_CONFIG_HOME`. Shell/process HOME is unchanged. The session refusal fixture now sets adapter `cwd` to its existing, cleaned-up owned realization directory, so the real project-auth preflight checks that fixture before realization.

No production code, policy validator, provider selection, accounting expectation, timeout, retry setting or assertion changed. The test still exercises real managed credential acquisition and storage verification/refusal, fresh workspace binding, null resumed session and exactly-one credential acquisition. Adapter tests retain malformed-counter, truncation, timeout and receipt-failure assertions.

## Verification

- RED unchanged cases: **5 failed**, one matching incremental-accounting case passed, 35 explicitly filtered out.
- GREEN both whole files serial: **41 passed, no skips**, 41.55 seconds.
- Explicit test-program typecheck: **exit 0**, extends repository test compiler options, covers both files and normal imported dependencies without emitting.
- Final lead scope/diff check: exit 0; source HEAD remains `48275586efb8641ab8e763d378e6d5e676dc6681`. Before/final file hashes are in `receipt.json`.

Both runs use Node24.22.2 / Vitest5.0.3 through the unchanged credential-denying wrapper, with its isolated child process session, real owned embedded PostgreSQL where applicable and synthetic test provider data. No actual provider account or operator credential was read. This qualifies these two files locally; the full-suite and CI result belong to the parent report.
