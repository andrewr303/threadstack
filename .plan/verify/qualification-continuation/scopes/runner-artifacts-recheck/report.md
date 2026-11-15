# Runner API artifact integration: Linux qualification required

The unchanged complete file reproduces **two passing cases and one failing case** on macOS. No source, assertion, timeout, platform guard or skip was changed. This is not a passing file result.

The failed case saves an authorized API response, verifies its exact stored bytes and then calls `download_artifact` to install those bytes in a local helper workspace. It fails at the production tool-availability guard with `Artifact installation is unavailable to this run or provider`.

The guard is intentional and matches the installer implementation:

- `paperclip-runner-tool-authority.ts` advertises local `DOWNLOAD_ARTIFACT_DEFINITION` only when `process.platform === "linux"`. Remote execution instead requires an explicitly supplied remote artifact installer.
- `artifact-transfer.ts` uses a Linux descriptor-confined transaction with `/proc/self/fd`, `O_NOFOLLOW`, held directory descriptors and no-overwrite publication. The executable installer explicitly rejects non-Linux platforms with `artifact_install_unsupported_platform`.

Changing storage injection cannot repair this: the shared API fixture already includes real storage. Pretending the local execution is remote, replacing the real installer with a simple write, or bypassing the platform guard would fail to prove the current integration contract. No such workaround was made.

The two empty HTTP 200/204 cases pass without asset or quota reservations. The third case still requires a Linux runtime to qualify exact download/helper-input bytes and its subsequent forged-identity, traversal, foreign-company and read-only rejection assertions. Those assertions remain intact and unqualified on this host; partial progress before the platform refusal is not counted as complete coverage.

## Evidence

`runner-artifacts-red.json` and `.log` retain the exact full-file command, protected Node 24.22.2 runtime, macOS credential-denying sandbox, process isolation and final result. The run exited 1 with two passes, one failure, zero skips and no received signals. `receipt.json` and before/after hashes prove the test and both production guards match source HEAD `48275586efb8641ab8e763d378e6d5e676dc6681`.

Debugging used the required ult-debugger router and TypeScript specialist. No typecheck was repeated because no source changed. No provider account, real key, browser, live extension, global configuration, delivery branch or GitHub state was touched.
