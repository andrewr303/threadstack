# Plugin repair, round 1: implementation report

- **Status:** READY_FOR_REVIEW (implementation and the approved focused checks only; this is not TASK/REQ `done`).
- **Author / session:** `impl-plugin-repair-20261114`.
- **Date:** 2026-11-14.
- **Repo:** `/Users/andrew/dev/threadkeeper/paperclip`, plan root `.plan`.
- **Gate status (honest):** `sdd.py gate --phase load` for REQ-7 to REQ-14 returns `ok:false`, because predecessor REQs wait on founder-only checks. The user explicitly authorized this work as bounded repair of in-progress code ("improve implementation significantly using the plan"). No gate pass is claimed. No status, INDEX, review ledger or `.plan/config.json` was changed.
- **Inputs read:**
  - `references/execution.md`, `skills/plan-tdd/SKILL.md` and `references/tdd.md` from `/Users/andrew/dev/Plugins/ultimate-sdd`.
  - The five audits under `.plan/verify/audits/20261114/`.
  - The REQ-7, REQ-8, REQ-9, REQ-10, REQ-11, REQ-12 and REQ-14 contracts.
  - `.plan/workflow.md`.
- **Audit findings were treated as leads.** Each one was checked against the source before it was fixed.
- **Independent review:** none has happened. This report is the author's self-check, not a review.

## Changed files (complete inventory)

| Path | Change |
|---|---|
| `packages/plugins/plugin-browser-sessions/src/service.ts` | REQ-11 F-1 linking, F-2, F-3, F-4; REQ-7 findings 2, 3, 4, 7, 8, 9, 10; REQ-10 F3; REQ-9 F12 and widget linked tasks; REQ-8 finding 5; REQ-12 F-5; REQ-14 F-7, F-10 |
| `packages/plugins/plugin-browser-sessions/src/tools.ts` | REQ-11 F-1 (threadKey, parameter whitelist, start delivery), F-6 (refusal label, agent name, session title); serialized final action write; REQ-8 findings 1, 6, 11; agent unlink flag |
| `packages/plugins/plugin-browser-sessions/src/state-changes.ts` | REQ-10 F1, F4, F5, F9, F10, F11, F13 |
| `packages/plugins/plugin-browser-sessions/src/contracts.ts` | `ActionRecord` gains `delivery`, `reportedLateAt`, `agentName`, `sessionTitle` |
| `packages/plugins/plugin-browser-sessions/src/manifest.ts` | REQ-7 finding 1: removed `pair-confirm`, `sharing` and `disconnect` from `apiRoutes`. `ui.slots` is unchanged |
| `packages/plugins/plugin-browser-sessions/src/worker.ts` | REQ-7 finding 1: the HTTP path refuses those three keys |
| `packages/plugins/plugin-browser-sessions/src/ui/index.tsx` | `SettingsPage`, `RecentActions`, `TaskSessionsTab`, `SessionsNeedingYou` and `StateLabel`; new export `relativeTime`. `SessionSidebar`, `ExtensionView`, `BrowsePage`, `ThreadsPage` and `BoardPage` were not edited |
| `packages/plugins/plugin-browser-sessions/tests/service.spec.ts` | New tests, plus one existing test changed transparently (see TDD) |
| `packages/plugins/plugin-browser-sessions/tests/ui.spec.ts` | New UI render tests |
| `packages/plugins/plugin-browser-sessions/tests/worker.spec.ts` | **New file** |
| `server/src/routes/plugins.ts` | Direct `/plugins/tools/execute` route: `issueId` comes from the verified run (`boundRunIssueIdSql`), never from the request; `validateToolRunContextScope` returns the bound issue |
| `server/src/__tests__/plugin-scoped-api-routes.test.ts` | `createApp` accepts `toolDeps`; new F14 test |
| `server/src/__tests__/tool-gateway.test.ts` | New block-policy test |
| `.plan/verify/plugin-repair.r1.implementation.md` | This report |

**Scope note:**
- The whole plugin directory is untracked in git, so `git diff` cannot isolate my edits there. The rows above are the exact files I touched.
- The three server files already showed `M` before this round; my edits are only the hunks described above.
- Nothing outside the allowed paths was written.
- Scratch logs are in `/tmp/plugin-repair-r1/`, which is outside the repository and temporary. The relevant output is quoted below.

## Findings → result

| Finding | Result | Test(s) | Actual |
|---|---|---|---|
| REQ-11 F-1 (Blocker) | Fixed. `threadKey` is taken for `session_send` only. Bridge parameters are an explicit whitelist. Linking needs `status` `Started…` plus `action.delivery`, which is set only from a successful browser result, and matches only that result's `threadKey`, or its `url` when the key is null | `REQ-11 F-1: …forged threadKey…`, `…links only the session its own result names`, `…forwards only whitelisted parameters` | pass |
| REQ-11 F-2 | Fixed. `poll()` marks requests as handed out. Cancelling a handed-out action withdraws it from later polls and waits `ACTION_SETTLE_MS` (8 s) for the browser's own verdict, then returns `unknown_delivery`. A timeout of a handed-out action returns `unknown_delivery`. The extension's `deadlineAt` is 5 s before the plugin timer. A late result is written to the action record (`Delivered (reported late)` and similar), while the agent's cached result stays `unknown_delivery`, as FR-7's edge case requires. The timeout text uses the real wait | `cancels a queued action that the browser has not received…`, three `REQ-11 F-2` tests | pass |
| REQ-11 F-3 | Fixed. Removing trust moves `policy.disabledAt` to now | `REQ-11 F-3: removing trust moves the switch-off epoch…` | pass |
| REQ-11 F-4 | Fixed. Master off returns `disabled: Agent actions are turned off.`. Removing a provider returns `disabled: {label} is not enabled for agent actions.` for that provider only. Removing trust returns `denied: This agent is not trusted…` for that agent only. Unrelated changes cancel nothing | `REQ-11 F-4` (3 cases plus "unrelated settings changes…") | pass |
| REQ-11 F-6 | Fixed. Status is `Refused: not trusted`; `agentName` and `sessionTitle` are recorded. The UI shows `No agent has acted yet.`, the master label, the note, the limits text, `Trusted` per agent, and Gemini greyed out with `Not supported yet` | `REQ-11 F-6: records a refusal…`, UI `REQ-11 F-6` ×2 | pass |
| REQ-7 1 | Fixed as far as the plugin can. The three routes were removed from the manifest and are refused on the HTTP path. The UI keeps working because `usePluginAction` goes through `POST /plugins/:id/actions/:key` to the worker's `performAction` handler (`ctx.actions.register`), not through `apiRoutes`. Nothing in `extension/src` or `ui/src` calls these routes (checked with `rg`). **Residual risk:** see Concerns | `worker.spec.ts` ×3 | pass |
| REQ-7 2 (AC-10) | Fixed: `Another browser is already connected for {company}. Disconnect it first.`, with the name from `companies.get` and the fallback `this company` | `REQ-7 AC-10…` | pass |
| REQ-7 3 | Fixed on the plugin side: `commitPart()` splits `{stamp}-{sha}`; prefix-equal SHAs of at least 7 characters match | `REQ-7 finding 3…` | pass |
| REQ-7 4 | Fixed: a mismatch removes the session rows, and `sessionCount` is 0 while mismatched | `REQ-7 finding 4…` | pass |
| REQ-7 7 | Fixed: a malformed result rejects the waiting caller with `bad_request: The browser sent a malformed result.` | `REQ-7 finding 7…` | pass |
| REQ-7 8 | Fixed: a claimed pair is always refused | `REQ-7 finding 8…` | pass |
| REQ-7 9 | Fixed: inventory authenticates before validating the body | `REQ-7 finding 9…` | pass |
| REQ-7 10 | Fixed (see F-2): `…did not answer in {n} seconds.` | in the F-2 timeout test | pass |
| REQ-10 F1 | Fixed: events are ordered against a separate `last-event:{threadKey}` record. An older event still counts when the row shows the same state | `REQ-10 F1…` (the existing no-rewind test still passes) | pass |
| REQ-10 F3 | Fixed: rows are reported unobserved when the bridge is offline or `agentStateAt` is older than `OBSERVATION_STALE_MS` (120 s) | `REQ-10 F3…` | pass |
| REQ-10 F4 | Fixed: the wake-up is evaluated independently of comment suppression | `REQ-10 F4…` | pass |
| REQ-10 F5 | Fixed: `escapedCut` escapes first, then cuts to 120 characters without splitting a pair | `REQ-10 F5 / AC-12…` | pass |
| REQ-10 F9 | Fixed: `queued:false` and thrown refusals are audited with a `reason`; only a queued wake-up starts the throttle | `REQ-10 F9…` | pass |
| REQ-10 F10 | Fixed: a future-dated event is dropped before any write | `REQ-10 F10…` | pass |
| REQ-10 F11 | Fixed: states are allowlisted and checked with `Object.hasOwn`; the emitted payload is `{threadKey, from, to, at}` | `REQ-10 F11…` | pass |
| REQ-9 F12 | Fixed: a tombstone is written only when a board removal deletes an existing link; agent unlinks never write one | `REQ-9 F12…` | pass |
| REQ-10 F13 | Fixed: receipts carry `handledAt` and are pruned after 24 h, at most hourly per company | `REQ-10 F13…` | pass |
| Item 5, UI copy | Fixed: `Last seen {relative}` on non-live rows; a visible `Open the browser to use this.`; `Nothing needs you.`; widget rows show the provider and `linkedTasks`; `View all` links to `/threads`; the setting reads `Session changes update tasks and wake agents`; a relative last-seen time in settings | UI tests ×5; `REQ-9 AC-7: needs-attention rows carry their linked tasks` | pass |
| REQ-8 1 | Fixed on the plugin side: the extension markers `[… truncated]` and `[… cut: N more characters]` are normalized to `[…cut]`, and `truncated:true` is set | `REQ-8 finding 1…` | pass |
| REQ-8 4 (offline in under 1 s) | **Not fixed; change proposed only.** The smallest safe change: the extension posts `bridge/disconnect`-like `offline:true` on `beforeunload`/`chrome.runtime.onSuspend`, and the plugin then sets `lastSeenAt=0`. A simpler alternative, lowering `OFFLINE_MS` under the 20 s long-poll, risks flapping. Both need the extension and a live run | — | not run |
| REQ-8 5 | Fixed: the heartbeat cancel and `close()` use the exact FR-9 `browser_offline` text. Provenance: the code changed during F-2, before this test was written | `REQ-8 finding 5…` | pass |
| REQ-8 6 | Fixed: `bad_request: query is required` | `REQ-8 finding 6…` | pass |
| REQ-8 11 | Fixed: the plugin cursor limit is 200, matching the extension | `REQ-8 finding 11…` | pass |
| REQ-12 F-5 | Fixed: hints are gated on pairing, not on sharing | `REQ-12 F-5…` | pass |
| REQ-14 F-7 | Fixed: one `browser_sessions.secret_read` entry with `keyName`, `reader`, `extensionVersion` and `browser`, and never the value | `REQ-14 F-7…` | pass |
| REQ-14 F-10 | Fixed: `secret()` maps an unpaired or forged caller to `denied` | `REQ-14 F-10…` | pass |
| REQ-9 F14 / REQ-11 F-11 (server) | Fixed: the direct route drops the request `issueId` and uses the run's bound task | `plugin-scoped-api-routes.test.ts` › `REQ-9 F14 / REQ-11 F-11…` | pass |
| REQ-8 3 (server) | Test added; the behaviour already existed (characterization) | `tool-gateway.test.ts` › `REQ-8 FR-7 / AC-9: a block policy refuses…` | pass on its first run |

## TDD evidence (red → green → refactor), in order

All plugin runs use `npx vitest run [-t <pattern>]` with cwd `packages/plugins/plugin-browser-sessions` and PATH set to Node 24.22.1. "Full" means the whole plugin suite. The RED exit is 1 in every row; the GREEN exit is 0.

| # | Behaviour | RED: actual failure | GREEN | Refactor |
|---|---|---|---|---|
| 0 | Baseline | — | 44/44 passed; both `tsc` runs exit 0 | — |
| 1 | F-1: forged threadKey, success-only linking, whitelist | Action kept `threadKey` ("expected {…} to match { threadKey: null }"); "expected [ {…link} ] to deeply equal []"; send params had 8 keys, 7 expected | full 47/47 (after a test-only fix: poll until both requests are queued) | none needed |
| 2 | F-2: settle, unknown_delivery, late result, timeout text | Held cancel returned `error` instead of `delivered`; `Browser action permissions changed` instead of `unknown_delivery`; `deadlineAt` equalled the plugin timer. The not-handed-out case passed (characterization) | 50/50 (after two test-only heartbeat fixes so the 40 s offline timer could not mask the timeout) | none needed |
| 3 | F-3/F-4 | All three cases received `disabled: Browser action permissions changed.`; the unrelated change cancelled the queued request; the epoch stayed `+0` | 55/55 | none needed |
| 4 | F-6 service | `status: "Refused: denied"`; no `agentName` or `sessionTitle` | 56/56 | none needed |
| 5 | F-6 UI | The page lacked `Allow trusted agents to act in my browser` and `Fix the build` | 58/58 | none needed |
| 6 | REQ-7 #1 | The manifest included `pair-confirm`; the HTTP confirm returned `{ confirmed: true }` | 61/61 | none needed |
| 7 | REQ-7 AC-10 | Old message text | 62/62 | none needed |
| 8 | REQ-7 #3/#4 | `warning` was not null; the rows survived | 64/64 | none needed |
| 9 | REQ-7 #7/#8/#9 | `TypeError … reading 'code'`; the replay resolved `paired`; got `bad_request` instead of `not_paired` | 67/67 | none needed |
| 10 | REQ-10 F1 | `createComment` called 0 times | 68/68 | none needed |
| 11 | F10 | The row took the future state | 69/69 | none needed |
| 12 | F11 | `constructor` was stored as a state | 70/70 | none needed |
| 13 | F5 | "expected 240 to be ≤ 120" | 71/71 | none needed |
| 14 | F4 | `requestWakeup` called 0 times | 72/72 | **Refactored:** a nested function lost type narrowing (`tsc` TS18047), so it was replaced with an `if/else`; reran 72/72 and `tsc` exit 0 |
| 15 | F9 | No `wakeup_not_admitted` entry with a reason | 73/73 | none needed |
| 16 | F12 | A tombstone was written for an unlink with no link | 74/74 | none needed |
| 17 | F13 | Two receipts left, one expected | 75/75 | none needed |
| 18 | F3 | `['claude:one','claude:stale']`, expected `['claude:one']` | 76/76 | none needed |
| 19 | Item 5 UI plus linkedTasks | `relativeTime is not a function`; missing `Last seen 1 hour ago`, `Nothing needs you.`, provider/task text and the setting label | 82/82 | none needed |
| 20 | Item 6 (7 tests) | Markers not normalized; `bad_request` text mismatch; cursor 201 accepted (test hung 5 s); hints `[]`; no `secret_read`; `not_paired` instead of `denied`. The finding-5 RED was a test design flaw (the 30 s timeout fired before the 40 s offline timer); the test was corrected, and the code fix predates it (provenance gap disclosed) | 89/89 | none needed |
| 21 | Server F14 | `-"issueId": "5555…"` / `+"issueId": "6666…"`: the forged id was forwarded (cwd `server`, `npx vitest run src/__tests__/plugin-scoped-api-routes.test.ts -t F14`, exit 1) | 19/19 in that file; with `plugin-routes-authz.test.ts`, 61/61 | none needed |
| 22 | Server gateway block | No RED: the behaviour already existed. Characterization test | 3 passed, 114 skipped (`-t "plugin tool\|block policy"`, exit 0) | n/a |

**Transparent test change.** The old test "cancels a queued action when either switch is turned off and ignores its late success" asserted `Failed: disabled` after the browser had picked up the request. That contradicts REQ-11 property 5 and AC-3, because it is a false definite failure that invites a double send (audit F-2). It was replaced by:
- the same scenario for a request the browser has not received (still `disabled`);
- separate tests for a held request (the browser's verdict, otherwise `unknown_delivery` with the late result recorded).

No assertion was weakened and no test was skipped.

## Final checks

All were run with Node 24.22.1.

| Check | Argv (cwd) | Exit | Result |
|---|---|---|---|
| Plugin suite | `npx vitest run` (plugin dir) | 0 | 3 files, **89 passed** |
| Plugin typecheck | `npx tsc --noEmit -p tsconfig.json` (plugin dir) | 0 | — |
| Plugin typecheck (tests) | `npx tsc --noEmit -p tsconfig.test.json` (plugin dir) | 0 | — |
| Server route tests | `npx vitest run src/__tests__/plugin-scoped-api-routes.test.ts` (`server`) | 0 | 19 passed |
| Server authz regression | `npx vitest run src/__tests__/plugin-scoped-api-routes.test.ts src/__tests__/plugin-routes-authz.test.ts` (`server`) | 0 | 61 passed |
| Gateway tests | `npx vitest run src/__tests__/tool-gateway.test.ts -t "plugin tool\|block policy"` (`server`) | 0 | 3 passed, 114 skipped |
| Server typecheck | `npx tsc --noEmit` (`server`) | 0 | — |

**Not run:**
- the full `tool-gateway.test.ts`;
- the full server suite;
- root `pnpm typecheck`;
- any extension test or build;
- any browser or runtime check.

## Extension follow-ups (owned by another agent)

1. `background.ts:514` should send the commit part of `buildId`. The plugin already tolerates the full id.
2. In `bridge-query.ts`, `boundedResult` should set `truncated:true` and use `[…cut]` itself. The plugin normalizes this today; newest-first paging (REQ-8 finding 2) is extension-only.
3. Honour the earlier `deadlineAt` for actions. The extension already aborts at `deadlineAt`; confirm it reports a verdict before the plugin timer.
4. Offline signal for REQ-8 finding 4: post a disconnect or offline notice on suspend.
5. `bridge/secret` now answers `denied` (403), not `not_paired` (401), for a bad token. The extension still learns `not_paired` from `bridge/poll`.
6. The extension `PaperclipBridgeSettings` never called `pair/confirm`, `sharing` or `disconnect`, so no change is needed there.
7. REQ-10 F15: if `agentStateAt` is ever excluded from the fingerprint, the plugin's 120 s staleness rule will mark live rows unobserved. Keep refreshing observed rows at least every 60 s.

## Concerns

- **Major, residual on `local_trusted` (REQ-7 finding 1).**
  - **What changed:** the token-less HTTP routes are gone.
  - **What remains:** on `local_trusted`, any local process counts as the board, and the board's UI action endpoint (`POST /api/plugins/:id/actions/pair-confirm`) is still reachable by such a process. That process can call `pair/start`, confirm through the action endpoint, then `pair/poll` to obtain a token. The same applies to the `disconnect` and `sharing` actions.
  - **Why not fixed here:** the plugin cannot tell the founder's UI from a local process on that endpoint.
  - **Decision needed through Specify (D-12):** accept this risk explicitly, or require an authenticated deployment mode (or an origin/CSRF check on the action route) before secret transfer or actions.
- **Minor.** Removing trust moves the epoch, so the extension refuses *other* trusted agents' queued or loading actions with `disabled: Agent actions are turned off.` (no double-send risk; slightly inaccurate text). This is the audit's chosen mechanism.
- **Minor.** A late result is accepted only while the plugin process lives; the `settled` map holds 1000 entries for 10 minutes.
- **Minor.** The busy check in `tools.ts` uses the stored row, so a stale `running` row still refuses a send. This is conservative.
- **Not done (out of the listed items or needing other owners):**
  - REQ-8 finding 4: change proposed only.
  - REQ-11 F-5, F-7, F-8, F-12 and F-13: extension.
  - REQ-11 F-9, F-10 and F-14.
  - REQ-7 findings 5, 6 and 11.
  - REQ-10 F2, F8 and F15.
  - REQ-12 F-1 to F-4 and F-6; REQ-14 F-1 to F-6, F-8, F-9, F-11 and F-12.
- **Next action:** a fresh independent spec review against REQ-7, REQ-8, REQ-9, REQ-10, REQ-11, REQ-12 and REQ-14 using this inventory, then the quality review. Lifecycle bookkeeping stays with the coordinator.

---

## Round 2 — spec review follow-ups (2026-11-14, same author `impl-plugin-repair-20261114`)

- **Source:** the coordinator's list from `.plan/verify/repairs.r1.cumulative-spec.md`, findings NF-2, NF-3, NF-3b, NF-6, NF-9 and NF-10.
- **Unchanged:** pairing and `local_trusted` behaviour (NF-4 is a founder decision) and the other author's `tests/manifest.spec.ts`, which stays green.
- **Gates and lifecycle:** the load gate is still `ok:false`; no status or ledger was changed.
- **Server files:** none were changed in round 2.

### Files changed in round 2
- `packages/plugins/plugin-browser-sessions/src/service.ts`
- `packages/plugins/plugin-browser-sessions/src/contracts.ts` (new `SEND_TIMEOUT_MS`, `START_TIMEOUT_MS`)
- `packages/plugins/plugin-browser-sessions/src/tools.ts`
- `packages/plugins/plugin-browser-sessions/src/manifest.ts` (`apiRoutes` gains `bridge-offline` only; `ui.slots` unchanged)
- `packages/plugins/plugin-browser-sessions/src/worker.ts`
- `packages/plugins/plugin-browser-sessions/tests/service.spec.ts`
- `packages/plugins/plugin-browser-sessions/tests/worker.spec.ts`
- this report

### Findings → result

| Finding | Result | Test(s) | Actual |
|---|---|---|---|
| NF-3 (REQ-8 AC-13) | Fixed. New route `bridge-offline` (`POST /bridge/offline`, body `{companyId}`, `auth: "board"`) plus the bridge token. It calls `service.offline()`, which sets `state.offline`. Pairing and sharing are kept. Pending requests not held by the browser reject at once with the exact FR-9 `browser_offline` text; held actions follow the settle rule. New calls answer `browser_offline` immediately. Rows show as not observed, and hints pause. The next `bridge/connect` or `bridge/poll` clears the flag. A wrong token gets `not_paired`/401 | `R2 NF-3 / REQ-8 AC-13…`; worker `R2 NF-3: bridge-offline route…` | pass (rejection measured under 1 s) |
| NF-3b (REQ-11 FR-6) | Fixed. `SEND_TIMEOUT_MS` is 60 s, so the browser's window is 60 − 5 − 1.5 = 53.5 s, which covers 30 + 15 + margin. `START_TIMEOUT_MS` is 75 s, a 68.5 s window. The timeout text uses the real budget | `R2 NF-3b…`; the F-2 timeout test was updated transparently (it asserted the old literal 50 s budget) | pass |
| NF-2 (plugin side) | Fixed. `actionVerdict()` turns a held action's browser verdict into the FR-1 contract text. `unknown_delivery` always gets the exact contract text. A definite refusal of an action the plugin had withdrawn reports the plugin's reason: master off gives `disabled: Agent actions are turned off.`, trust removed gives `denied: This agent is not trusted…`. Otherwise `disabled` keeps the provider text or becomes the master text, `denied` becomes the trust or link text, and `timeout` becomes `The browser did not answer in {n} seconds.` | `R2 NF-2…` (6 cases) | pass. The provider-text case passed before the change (characterization) |
| NF-9 | Already fixed in round 1: the final action write and the late-verdict handler share the company lock. A regression test was added. **Mutation check:** with the round-1 serialization removed from `tools.ts`, the test failed (`expected {…} to match object {…}`); with the code restored, it passed. Backup and logs are under `/tmp/plugin-repair-r1/` | `R2 NF-9…` | pass |
| NF-10 (REQ-14 FR-1) | Fixed. A host failure matching `not found`, `not bound`, `deleted`, `missing` or `does not exist` (the host texts are `Secret not found`, `Secret version not found` and `Secret is not bound to plugin…`) answers `not_found: Secret missing` and writes no `secret_read` entry. Other failures, such as the rate limit, stay errors | `R2 NF-10…` | pass |
| NF-6 | Fixed, tolerant of older extensions. `bridge/poll` returns `cancelledRequestIds`: requests the plugin withdrew while the browser held them. If the extension announces `capabilities: ["cancel-requests"]` at `bridge/connect`, untrusting an agent no longer moves the shared epoch, so other agents' actions continue. Without that capability, the round-1 epoch bump stays, so F-3's safety is kept for current extensions | `R2 NF-6…`; the existing `REQ-11 F-3…` still passes | pass |

### TDD rows

All runs use `npx vitest run -t <pattern>` with cwd `packages/plugins/plugin-browser-sessions` and Node 24.22.1. RED runs exit 1; GREEN runs are the full suite and exit 0.

| # | Behaviour | RED (actual) | GREEN (full suite) | Refactor |
|---|---|---|---|---|
| R2-1 | NF-3 | `TypeError: service.offline is not a function`; the route was missing from the manifest | 93/93 | none needed |
| R2-2 | NF-3b | `expected 43500 to be greater than or equal to 47500` | 94/94 | none needed |
| R2-3 | NF-2 | 5 of 6 failed: actual `disabled: The session action expired or was disabled.`, `disabled: Agent actions are turned off.` (for the trust case), `timeout: The browser action timed out.`, `unknown_delivery: The session action was interrupted…`, `denied` | 100/100 | none needed |
| R2-4 | NF-9 | No RED on the current code (already fixed). The mutant RED is recorded above | 101/101 | none needed |
| R2-5 | NF-10 | `expected Error: Secret not found: deleted to match object { code: 'not_found' }` | 102/102 | Extended the match to cover `not bound` and asserted that the rate limit stays an error. **Disclosure:** those two assertions were added after the first GREEN, not red-first |
| R2-6 | NF-6 | `expected 1794699617325 to be +0` (the epoch moved) | 103/103 | none needed |

### Round-2 final checks

| Check | Argv (cwd) | Exit | Result |
|---|---|---|---|
| Plugin suite | `npx vitest run` (plugin dir) | 0 | 4 files, **103 passed** (includes `manifest.spec.ts`) |
| Plugin typecheck | `npx tsc --noEmit -p tsconfig.json` (plugin dir) | 0 | — |
| Plugin typecheck (tests) | `npx tsc --noEmit -p tsconfig.test.json` (plugin dir) | 0 | — |

Server checks were not rerun, because round 2 changed no server file.

### Extension follow-ups added by round 2
1. Call `POST /api/plugins/browser-sessions/api/bridge/offline` with `{companyId}` and the bridge-token header on suspend or close. Any later `bridge/connect` or `bridge/poll` brings the browser back online.
2. Send `capabilities: ["cancel-requests"]` in `bridge/connect`, and abort any request listed in `cancelledRequestIds` in the `bridge/poll` response.
3. NF-2 extension side: on abort, report the manager's own verdict (`disabled`, `timeout`) instead of an immediate `unknown_delivery`. The plugin now maps whatever arrives to contract text, but a withdrawn action reports the founder's reason only when the browser gives a definite refusal.
4. The budgets are now 60 s for a send and 75 s for a start, with `deadlineAt` 5 s earlier. The extension's page-load bound must fit 30 s + 15 s inside `deadlineAt − 1.5 s`.

### Round-2 concerns
- **Minor.** NF-10 depends on the host's error message text: the RPC error carries no stable code to the worker. A new host wording for a deleted secret would fall back to `internal`.
- **Minor.** Until the extension announces `cancel-requests`, NF-6's collateral (other agents being refused) remains by design.
- **Unchanged:** NF-4 (D-12 on `local_trusted`) is still open, waiting on a founder or Specify decision.
- **Next action:** a fresh independent spec review of round 2, then the quality review.

---

## Round 3 — last review round (2026-11-14, same author `impl-plugin-repair-20261114`)

- **Source:** the plugin-side Minors from `.plan/verify/repairs.r2.cumulative-quality.md` (F-2, F-3, F-6, F-7) and `.plan/verify/repairs.r2.cumulative-spec.md` (M-2, M-3).
- **Unchanged:** pairing and `local_trusted` behaviour (NF-4); `manifest.ts`; the UI.
- **Gates and lifecycle:** the load gate is still `ok:false`; no status, ledger or config was changed.
- **Server files:** none were changed in round 3.

### Files changed in round 3
- `packages/plugins/plugin-browser-sessions/src/contracts.ts`
- `packages/plugins/plugin-browser-sessions/src/service.ts`
- `packages/plugins/plugin-browser-sessions/src/tools.ts`
- `packages/plugins/plugin-browser-sessions/tests/service.spec.ts`
- `packages/plugins/plugin-browser-sessions/tests/timing.spec.ts` (**new**)
- this report

### Findings → result

| Finding | Result | Test(s) | Actual |
|---|---|---|---|
| F-7 (plugin half) | Fixed. `contracts.ts` now exports `REQUEST_TIMEOUT_MS`, `SEND_TIMEOUT_MS`, `START_TIMEOUT_MS`, `ACTION_REPORT_MARGIN_MS` and `ACTION_SETTLE_MS`. `service.ts` re-exports the last two, so existing imports keep working. The chain invariants are asserted in one place for a fork-root test to reuse | `tests/timing.spec.ts` › `R3 F-7…` | pass |
| F-3 / M-3 | Fixed. An unlink cancels only `session.send` requests with the same `(issueId, threadKey)`, using `denied: The session is not linked to the task you are working on.`. Starts and sends on other links continue | `R3 F-3 / M-3…` | pass |
| F-2 / M-2 | Fixed. A new `cancelledIds` map records each withdrawn held action with its `deadlineAt`. Every poll lists the id until the browser's verdict arrives (any `results()` entry for it) or `deadlineAt` passes, including after the 8 s settle has turned the agent's answer into `unknown_delivery`. `cancel()` wakes waiting polls, and `hasDeliveries` counts cancellations not yet delivered, so a poll that starts after a cancel returns at once. The extension must tolerate seeing the same id repeated | `R3 F-2 / M-2…` ×3 (poll returns at once; listed until deadline even after settle; a verdict clears it) | pass |
| F-6 | Fixed both ways the review allowed. (a) `ActionRecord.requestId` is written at admission and used as the bridge request id. When `results()` finds neither a live nor a settled request, it looks up an admitted, incomplete record by `requestId` and completes it as `… (reported after restart)`. The agent's cached result stays empty, so a retry answers `unknown_delivery` and never resends. (b) `actions()` shows an admitted, incomplete record older than `START_TIMEOUT_MS + ACTION_SETTLE_MS` with no live request as `Failed: unknown_delivery`. This is display only; the stored record is unchanged | `R3 F-6…` ×2 | pass |

### TDD rows

All runs use `npx vitest run [-t <pattern>]` with cwd `packages/plugins/plugin-browser-sessions` and Node 24.22.1. RED runs exit 1; GREEN runs are the full suite and exit 0.

| # | Behaviour | RED (actual) | GREEN (full suite) | Refactor |
|---|---|---|---|---|
| R3-1 | F-7 | `expected false to be true`: the constants were not exported from contracts | 104/104 | The test's type cast was fixed for `tsc` (test-only) |
| R3-2 | F-3 / M-3 | `- denied: The session is not linked…` / `+ denied: Browser action scope changed.` | 105/105 | none needed |
| R3-3 | F-2 / M-2 | `expected 3001 to be less than 1000` (the poll waited the full 3 s); `expected [] to deeply equal [id]` (the id disappeared after settle). The "verdict clears" case passed before the change (characterization). **Disclosure:** my first draft of the wake test was mis-built. A held, uncancelled request already makes a poll return at once, so that draft did not test the reviewer's scenario. I replaced it with the reviewer's scenario (a poll starting after the cancel) before implementing | 108/108 | none needed |
| R3-4 | F-6 | Record lacked `requestId` and status (`expected {…17} to match {…2}`); `{ orphan: 'Pending' }` | 110/110 | Behaviour-preserving: `acceptLateResult` now uses the shared `lateStatus()` helper. Reran 110/110 |

### Round-3 final checks

| Check | Argv (cwd) | Exit | Result |
|---|---|---|---|
| Plugin suite | `npx vitest run` (plugin dir) | 0 | 5 files, **110 passed** (includes `manifest.spec.ts` and `timing.spec.ts`) |
| Plugin typecheck | `npx tsc --noEmit -p tsconfig.json` (plugin dir) | 0 | — |
| Plugin typecheck (tests) | `npx tsc --noEmit -p tsconfig.test.json` (plugin dir) | 0 | — |

Server checks were not rerun, because round 3 changed no server file.

### Extension follow-ups from round 3
1. Treat `cancelledRequestIds` as idempotent: an id may repeat across polls until the verdict is posted or `deadlineAt` passes. Remember an id that arrives before the request's controller exists, and abort when it does.
2. Stop aborting every pending action whenever any link disappears (quality F-3, extension half). The plugin now cancels only the matching send.
3. For F-7, a fork-root test can import the plugin constants from `packages/plugins/plugin-browser-sessions/src/contracts.ts` and compare them with `bridge-protocol.ts` and `integration-runtime.ts`.

### Round-3 concerns
- **Minor.** The `Failed: unknown_delivery` relabel in `actions()` is display-only and depends on the plugin clock. A record completed later by a restart fallback replaces it.
- **Minor.** The restart fallback adds one store query per verdict that arrives for an unknown request id. Results are capped at 100 per call.
- **Still open:** NF-4 (D-12 on `local_trusted`) awaits a founder or Specify decision.
- **Budget:** this was the last allowed round. The next step is a fresh independent spec review, then a quality review, then the coordinator's gates.
