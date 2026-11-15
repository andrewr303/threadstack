# Fix-all cycle reconciliation — 2026-11-14

## Authority and scope

The founder followed the stopped three-round improvement cycle with `Fix all` and then
`Fix all and then open new PR`. That authorizes a new bounded repair and verification cycle.
It does not rewrite the previous round limit or claim that a failed gate passed. The follow-up
screenshots add the compact Threads contract in `../reqs/REQ-6-ui-supplement.md`.

Original acceptance text, historical implementation records, reviews, and sealed browser rounds
remain unchanged. REQ and TASK statuses retain their existing unfinished values. The original
checkout and live extension remain outside deployment scope. A requested PR does not authorize
live extension deployment, helper installation, or service registration.

## Current implementation and spec differences

| Finding / decision | Current implementation or direction | Qualification boundary |
|---|---|---|
| Q-3 / REQ-6 D-3 and AC-10 | The original clipping technique failed practical wheel/trackpad scrolling. The layered variant places the view above the transparent frame, raises the frame for blocking overlays, and exposes notices through holes. See `../reqs/REQ-6-design.md` and retained spike evidence `req6-spike/v2/`. The fix-all instruction continues repairs to that implementation. | This implementation direction is inferred from continuation. The founder has not separately answered Q-3, and original AC-10 is preserved. A successful layered-variant check does not turn the original technique into a pass. |
| N-3 / REQ-5 FR-2 | Once the configured server is running and its optional host permission is granted, the frame loads eagerly so Paperclip can announce fused mode even when the initial view is Threads. Fused mode still requires verified host messages and available plugin pages. | This differs from the original "when the view is first shown" wording. No control currently keeps Paperclip connected while explicitly declining fusion. Disabling the plugin returns switching behavior, but does not prevent the hidden eager frame from loading. |
| N-2 | A direct Threads entry must retain its requested view while Paperclip first reports its home route, then navigate to the company Threads slot. | Original browser rounds 19/20 failed this outcome. Fresh repair and browser receipts are required. |
| Palette close | The click immediately following Escape must select the intended thread without an added settle delay. | Round-20's case summary passed after waiting for frame lowering; its raw 0 ms probe succeeded only 1/4. Preserve both observations and assert the actual immediate-click outcome in the successor run. |
| M-4 / REQ-8 FR-9 inherited by REQ-11 | Read requests retain a 30-second budget. Send actions have a 60-second budget; start actions have a 75-second budget. Timeout messages use the actual request budget. | `contracts.ts` exports `REQUEST_TIMEOUT_MS`, `SEND_TIMEOUT_MS`, and `START_TIMEOUT_MS`; `service.ts` formats the actual budget. The action text differs from the old inherited literal 30-second wording. Reporting 30 seconds for these actions would be inaccurate; this is an explicit spec reconciliation, not evidence that every action completed on a real provider. |
| NF-5 / REQ-4 AC-11 | With a loopback server down, lifecycle discovery makes one native helper-status probe. A missing helper is remembered for that window, so later health polls do not repeat the native message or attempt a start. | Original AC-11 literally requires no native message. That literal criterion remains unmet; documenting the one-probe behavior does not waive it. Real helper/service installation and startup remain separate checks. |
| NF-4 / REQ-7 D-12 | `local_trusted` trusts local processes. Pairing/token guards do not authenticate one local process against another local process that can use trusted board routes. | Removing tokenless bridge routes does not remove this local trust assumption. Use the authenticated deployment mode when a distinct authenticated operator boundary is required. Do not claim the local-trusted instance protects against an untrusted process running as the same local user. |
| Config | `hooks.enabled` is restored to false to match the approved snapshot alternative and `project.md`. The known full-suite command `pnpm test:run` is recorded alongside typecheck and extension checks. | Command registration does not mean a passing run. The interrupted broad-suite record remains unqualified; no hook-activation or completion pass is claimed. |

Paths above are relative to `.plan/` unless otherwise stated. Source observations were refreshed
from `extension/src/core/paperclip/lifecycle.ts`, `extension/src/entrypoints/manager/{App,PaperclipView}.tsx`,
and `packages/plugins/plugin-browser-sessions/src/{contracts,service}.ts`. They establish source
behavior, not fresh runtime acceptance.

## New evidence and handoff

Final evidence is pending while the repair authors and browser worker complete their work.
The lead is collecting command receipts in `/tmp/tk-fix-all/`. Copy or reference the final
receipts with their actual source scope, command, result, and retained artifact provenance before
claiming a final check. Allocate successor browser rounds after round-20; preserve failures and
sealed artifacts. The new independent spec review must precede quality review on the same final
source scope.

Unchanged required gaps include broad Paperclip qualification, native host-permission consent,
founder-operated real-provider sends/starts, real model-key use, helper/launchd behavior, MV3
suspension, and live-library continuity. Resolve the applicable gate inputs or report them
explicitly; this reconciliation does not certify completion.
