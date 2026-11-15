# Review: cumulative spec review of repair round 1 (REQ-3, 4, 5 F1, 7–14)

- **Stage:** spec
- **Scope:** cumulative
- **Tasks:** REQ-3/TASK-1, REQ-4/TASK-1, REQ-7/TASK-1, REQ-8/TASK-1, REQ-9/TASK-1, REQ-10/TASK-1, REQ-11/TASK-1, REQ-12/TASK-1, REQ-13/TASK-1, REQ-14/TASK-1. REQ-5 is covered for finding F1 only.
- **Authors:**
  - `impl-plugin-repair-20261114`: the plugin and the server files.
  - `impl-extension-bridge-repair-20261114`: the extension bridge, credentials and actions files.
  - `impl-lifecycle-checks-repair-20261114`: lifecycle, the Mac helper and the check scripts.
- **Reviewer:** `spec-review-repairs-r1-20261114`. I wrote none of this code.
- **Round:** repair round 1. The per-TASK cap is `max_review_rounds: 3`, taken from the REQ planning inputs; I did not validate it myself.
- **Reviewed files:** all paths are relative to `/Users/andrew/dev/threadkeeper/paperclip`.
  - **Read in full or at the cited ranges:**
    - Plugin source: `packages/plugins/plugin-browser-sessions/src/{service,tools,state-changes,worker,manifest}.ts`
    - Plugin tests: `packages/plugins/plugin-browser-sessions/tests/{service.spec.ts (1–60, 200–360), worker.spec.ts, ui.spec.ts (30–76)}`
    - Server: `server/src/routes/plugins.ts` (840–880, 1080–1160, 1725–1764) and `server/src/__tests__/tool-gateway.test.ts` (6569–6599)
    - Extension source: `extension/src/core/paperclip/{bridge,actions,integration-runtime,observations,lifecycle}.ts`, `credentials.ts` (60–350), `client.ts` (50–96), `bridge-query.ts` (40–278), `sync.ts` (685–729)
    - Extension entry points: `extension/src/entrypoints/manager/{paperclip-actions.ts,PaperclipConnection.tsx}` and `extension/src/entrypoints/background.ts` (470–620)
    - Extension tests: `extension/tests/unit/paperclip-bridge.test.ts` (74–118), `paperclip-observations.test.ts` (29–52)
    - Scripts and docs: `scripts/threadkeeper-{check,deploy}.mjs`, `scripts/threadkeeper.test.mjs`, `doc/THREADKEEPER-SERVICE.md` (25–38)
  - **Checked only with grep:** `bridge-protocol.ts`, `cloud-client.ts`, `ui/index.tsx`, the test-name inventory of the other extension tests, and `extension/src/entrypoints/manager/App.tsx:336`.
  - **Not read:** `session-delivery.ts`, `PaperclipBridgeSettings.tsx`, `PaperclipCredentials.tsx`, `contracts.ts`, `mac-helper/core.cjs`, `plugin-scoped-api-routes.test.ts`, `package.json`, and the remaining listed extension tests.
- **Evidence destination:** chosen by the coordinator.

## Audit finding → status

| Finding | Status | Source / test |
|---|---|---|
| REQ-11 F-1 (Blocker) | **FIXED** | `tools.ts:174,212-214` set `threadKey` for sends only and pass a fixed list of parameters. `service.ts:343-345` links a session only after a confirmed start, matching the `delivery` the browser reported. Tests `service.spec.ts:328,339,348` would fail on the old code. |
| REQ-11 F-2 | **FIXED (plugin side)** | `service.ts:155-171,181-182,195`: a request is marked as handed out; after that, an 8 s settle period, then `unknown_delivery`, and a late result is still recorded. Tests `:241,251,262`. |
| REQ-11 F-3 | **FIXED** | `service.ts:288` moves the switch-off epoch when trust is removed. The extension refuses at `actions.ts:122`. Test `:235`. |
| REQ-11 F-4 | **PARTIAL** | Queued actions get the exact texts (`service.ts:290-293`; test `:217-226`). An action already held by the browser, which is the AC-8 "waiting for a page to load" case, still ends with the wrong text. See NF-2. |
| REQ-7 #1 | **PARTIAL** | The routes were removed from the manifest (`manifest.ts:30-32`) and refused on the HTTP path (`worker.ts:49`). Self-pairing is still possible through the UI action endpoint. See D-12 below. |
| REQ-7 #2 (AC-10) | **FIXED** | `service.ts:78-81`; test `:173` asserts the exact text. |
| REQ-7 #3 | **FIXED** | Plugin: `service.ts:31-32,117`. Extension: `bridge-protocol.ts:78-81`, `bridge.ts:175`. |
| REQ-7 #4 | **FIXED** | `service.ts:116,127`; test `:150`. |
| REQ-7 #5 | **FIXED** (MV3 wake-up is runtime-only) | `integration-runtime.ts:20-39`, `background.ts:1465,1535-1538`. |
| REQ-8 #1 | **FIXED** | Extension: `bridge-query.ts:140,185,270`. Plugin: `tools.ts:123-125,148`. Tests `paperclip-bridge.test.ts:74`, `service.spec.ts:493`. |
| REQ-8 #2 | **FIXED** | `bridge-query.ts:164-174,190-194`. The paging test at `:97` checks all 300 messages are reached with no gaps. |
| REQ-8 #3 | **FIXED** (test only; the behaviour already existed) | `tool-gateway.test.ts:6569-6599`; the handler spy is never called. |
| REQ-8 #4 | **OPEN** | No offline signal exists, so a browser closed within the last 40 s is not reported in under 1 s. Both authors disclosed this. |
| REQ-10 F1, F3, F4, F5 | **FIXED** | `state-changes.ts:33-40,57-58,9-13,60`; `service.ts:322-326`. Tests `:393,474,433,423`. |
| REQ-10 F2 | **FIXED** (in memory only) | `observations.ts:18,46-51,111-118`. |
| REQ-10 F6 | **FIXED** | UI tests `ui.spec.ts:55,71`. |
| REQ-12 F-3, F-4 | **FIXED** | `bridge.ts:346,353-356`; `sync.ts:702,713,719-720`. |
| REQ-12 F-5 | **FIXED** | `service.ts:372` (hints follow pairing); test `:513`. |
| REQ-4 #1 (AC-11) | **PARTIAL** | `lifecycle.ts:122,127` remembers a missing helper, but one native message is still sent per window. AC-11 says "no native message is sent". |
| REQ-4 #2, #4 | **FIXED** | `lifecycle.ts:28,58`; `PaperclipConnection.tsx:100,102,106`. |
| REQ-4 #3 | **FIXED** | `lifecycle.ts:29-33,67`. |
| REQ-3 #1 | **FIXED** | `threadkeeper-check.mjs:66`; test `:63`. |
| REQ-3 #3 | **FIXED** | `threadkeeper-check.mjs:43-49,85`; test `:96`. |
| REQ-3 #5 | **REGRESSED** | See NF-1. |
| REQ-5 F1 | **FIXED** (wiring outside the reviewed scope) | `lifecycle.ts:93,189-193`. The hook is wired at `App.tsx:336`, a file no listed author owns. |
| REQ-14 F-1 | **FIXED** | `client.ts:88-95`, `credentials.ts:185`, `bridge.ts:230`. |
| REQ-14 F-2 | **FIXED** | `credentials.ts:326-327` |
| REQ-14 F-6 | **FIXED** | `credentials.ts:283-306` |
| REQ-14 F-7 | **FIXED** | `service.ts:367` |
| REQ-14 F-8 | **FIXED** | `cloud-client.ts:118` |

## Seam verdicts

1. **8 s held-action wait vs the extension's verdict 1.5 s before the deadline: FAIL.**
   - The timing is consistent: the plugin timer fires at T+50 s, `deadlineAt` is T+45 s, and the extension aborts at T+43.5 s.
   - The problem is what the extension sends. On any abort, `background.ts:494-497` immediately answers `unknown_delivery: The session action was interrupted…` and throws away the manager's own verdict (NF-2).
   - The total budget is also too small for FR-6's 30 s page load plus 17.5 s delivery window (NF-3).
2. **Trust removal epoch vs the extension guard: PASS, with collateral damage.** The extension refuses or aborts every other trusted agent's pending action too (NF-6).
3. **`truncated` end to end: PASS.** The extension sets it, the plugin reads `value.truncated` (`tools.ts:123`), and old markers are normalized. NF-7 notes the flag is now overloaded.
4. **120 s "observed" freshness vs the extension's re-send: PASS.** Rows re-send in 30 s buckets (`bridge-query.ts:61`), so they stay well inside 120 s.
5. **Commit comparison: PASS.** A `nogit` build sends an empty commit, so no warning is shown.
6. **403 `denied` vs `not_paired` on `bridge/secret`: PASS, but brittle.** The extension tells them apart by matching the message text (`bridge.ts:233` against `service.ts:358`). Consent-off keeps `denied` and maps to `disabled`.
7. **Hints gated on pairing vs the socket suppression rule: PASS.** The plugin's `poll` returns hints whether or not sessions are shared, and the socket condition (`background.ts:588`) ignores sharing, so paired-but-unshared still gets hints.

## D-12: what can still be reached on `local_trusted`

Any local non-agent process counts as the board. It can do this:

1. Call the action `disconnect` (`POST /api/plugins/:id/actions/disconnect`; `worker.ts:25`). This revokes the real extension.
2. Call the HTTP route `pair/start`.
3. Call the action `pair-confirm`.
4. Call the HTTP route `pair/poll`, which returns a fresh bridge token.

`worker.spec.ts:39-45` demonstrates the start → confirm → poll part of this chain, with the board as actor.

With that token, the process can:
- read `bridge/secret` values when transfer is allowed;
- receive agent action requests, including their full text;
- inject inventory and `automaticLinks`. These create `auto` links, which grant acting scope under REQ-11 D-8.

The HTTP routes `policy-save` (`/policy`) and `link` are also open to it. That means it can mark agents trusted, enable actions in Paperclip and create `user` links. The extension's own switch still gates any actual typing.

No AC is literally violated:
- AC-14 holds for the token-protected `bridge-*` routes.
- AC-10 holds, but only until a disconnect.
- AC-15 concerns agent credentials.

But D-12's stated purpose ("Without it any local process could pose as the extension…") is defeated. D-12 is `assumed`, so this needs a Specify decision: accept the risk explicitly, or require `authenticated` mode or an origin check on the action route before secrets and actions are allowed.

## Checks and applicability

- **Run by the coordinator or authors** (I inspected the reports; I ran nothing):
  - extension `npx vitest run`: 1,915 passed, plus 1 `backup.test.ts` timeout that passes when run alone;
  - plugin `npx vitest run`: 89 passed, as reported by its author;
  - `tsc --noEmit` for extension, ui and server: exit 0;
  - `node --test scripts/threadkeeper.test.mjs`: 9 passed.
- **Not run:** full server suite, full `tool-gateway.test.ts`, `check:all`, any build, any browser, MV3 or launchd run, real providers, real keys.
- **TDD:** RED/GREEN tables are recorded in all three reports. I checked that the regression tests listed above would fail on the old code. The plugin's REQ-8 finding-5 test has a disclosed provenance gap.
- **The three changed tests:**
  - `service.spec.ts:204-216`: justified by REQ-11 FR-7, AC-3 and the delivery-truthfulness requirement.
  - `paperclip-observations.test.ts:29-37`: required by REQ-10 FR-5 edge.
  - `paperclip-hints.test.ts`: consistent with REQ-12 FR-2 negative ("ignored"). Its safety assertions are kept.
- **Limitations:**
  - Load gates return `ok:false`; the work went ahead on the user's explicit instruction. This is a limitation, not a finding.
  - `App.tsx` is outside the declared scope.
  - Several files were inspected only in part.

## Findings

| ID | Severity | Where | Expected vs actual | Violates | Bounded fix (owner) |
|---|---|---|---|---|---|
| NF-1 | Blocker | `scripts/threadkeeper-deploy.mjs:27-28`; the test at `threadkeeper.test.mjs:117-118,126-127` enforces this; `doc/THREADKEEPER-SERVICE.md:32-35` contradicts it | **Expected:** deploy builds into `TK_LIVE_DIR`, and the documented live folder is `/Users/andrew/dev/threadkeeper/.output/chrome-mv3`. **Actual:** `within(real, home)` refuses every folder under `$HOME`, so the founder's live folder is always rejected. | REQ-3 FR-5, AC-7, AC-8 (second clause) | Refuse `home` and its ancestors only, not folders inside it. Add a positive test using an injected `home` with a `<home>/dev/threadkeeper/.output/chrome-mv3` target. Owner: lifecycle-checks. |
| NF-2 | Major | `background.ts:494-497`, `paperclip-manager actions` `paperclip-actions.ts:34` | **Expected:** when the switch goes off while the page is loading, nothing is typed and the agent gets `disabled: Agent actions are turned off.` within 10 s; `unknown_delivery` uses the FR-1 exact text. **Actual:** the abort immediately reports `unknown_delivery: The session action was interrupted…` and discards the manager's verdict, so the plugin's 8 s wait forwards that text. | REQ-11 AC-8 (third clause), FR-1 exact texts, AC-3 near the deadline | On abort, wait a bounded time (≤3 s) for the manager's answer. The manager should report `disabled` for a switch-off and `timeout` for a deadline abort before anything is typed, and the contract text otherwise. Add a test. Owner: extension-bridge. |
| NF-3 | Major (open, carried) | `service.ts:145`, `OFFLINE_MS` | Closing the browser gives `browser_offline` only after 40 s. | REQ-8 AC-13 (first clause) | Add a token-authenticated, non-revoking offline route in the plugin, signalled by the extension. Owners: plugin and extension. |
| NF-4 | Major (decision) | `worker.ts:25`, `manifest.ts:33,35` | The D-12 residual above. | D-12 rationale; affects REQ-11 and REQ-14 | Specify decision, then the plugin change. |
| NF-5 | Major (open) | `lifecycle.ts:123-124` | One native message is still sent per window when the helper is missing. | REQ-4 AC-11 (literal) | Founder decision, or check permission and helper presence without messaging. Owner: lifecycle-checks. |
| NF-3b | Minor | `tools.ts:215`, `service.ts:148`, `actions.ts:97`, `paperclip-actions.ts:22-24` | A send has 43.5 s, less than the 30 s + 17.5 s FR-6 needs; a start has 53.5 s, less than about 62 s. | REQ-11 FR-6 waits | Raise the plugin timeouts, or bound page load to fit. Owners: plugin and extension. |
| NF-6 | Minor | `service.ts:288`, `bridge.ts:265` | Untrusting agent A cancels or refuses agent B's actions with "turned off" or `unknown_delivery`. | Text accuracy | Add per-agent cancellation (`cancelledRequestIds`). |
| NF-7 | Minor | `bridge-query.ts:270` | `truncated` is true whenever older messages exist (`oldest > 0`). | REQ-8 FR-4 meaning of the flag | Set it only for real cuts. |
| NF-8 | Minor | `credentials.ts:108-118`, `integration-runtime.ts:45-58` | The 30 s cache keeps a key in use for up to 30 s after Paperclip stops, after consent is turned off in Paperclip, or after the secret is deleted. | REQ-14 AC-4, AC-6 (literal, bounded) | Accept and document, or drop the cache when a read fails or `bridge/poll` fails. |
| NF-9 | Minor | `service.ts:205` | A late verdict that arrives before the final record is written is dropped. | REQ-11 FR-8 accuracy | Queue it and apply it after the write. |
| NF-10 | Minor | `service.ts:364` | A deleted secret shows as `internal`, which the extension reports as "not running". | REQ-14 FR-1 negative | Map that failure to `not_found`. |
| NF-11 | Minor | `App.tsx:336` | The REQ-5 F1 wiring was done by an unlisted contributor. | Scope and evidence | Add the file to a reviewed scope. |

## Verdict

**FAIL.**
- **NF-1 (Blocker):** a repair made the founder's deploy impossible.
- **NF-2 (Major):** a seam between authors means REQ-11 AC-8's third clause still does not return the `disabled` text, and `unknown_delivery` does not use the contract text.
- **Still open:** NF-3, NF-4 and NF-5 are open Majors.

Most of the priority findings are fixed with tests that would fail on the old code. Next step: fix NF-1 and NF-2, settle D-12 and AC-11 through Specify, then run a fresh spec review.
