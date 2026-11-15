# Workspace runtime qualification recheck

**180 tests passed**, one file, exit 0, actual duration **99.53 seconds**. No source edits were needed.

The earlier broad run's single failing case, `retries a bind race on the next bounded port and persists the selected URL`, now passes. Foreign-listener, occupied-port/unknown-ownership, scope, startup reconciliation and cleanup cases also pass. This narrowed result does not turn the still-active broader run into a passing result.

Execution used the same clean-environment wrapper and credential-denying SBPL profile under Node 24.22.2, with the parent-provided task-local signed `ps`. Its executable text is identical to the system binary; the system executable is untouched. Neither production process-identity/ownership checks nor test timeouts/assertions were changed or skipped. No tests ran unsandboxed.

The existing fixtures own their temporary worktrees, local bare remotes, Node HTTP/process services, runtime homes, local-only package fixtures, embedded databases and cleanup. Provider adapter names appear as metadata; the suite does not invoke model providers. Ambient Paperclip CLI provisioning is shadowed by fixture shims. No live extension build, helper/service installation, provider or Git publication action was performed.

Evidence:

- `workspace-runtime-signed-ps.json`: exact command, cwd, sandbox, environment-key metadata, start/end timestamps and exit code, copied unchanged from the wrapper receipt.
- `workspace-runtime-signed-ps.log`: complete output.
- `source-before.json`, `source-after.json`: identical hashes for the test, workspace-runtime production module and local service supervisor.
- `guards.json`: fixture review and execution protection provenance.

HEAD remains `48275586efb8641ab8e763d378e6d5e676dc6681`. Final source-hash comparison and scoped whitespace check passed.
