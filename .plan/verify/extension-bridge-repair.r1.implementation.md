# Extension bridge repair, round 1: implementation evidence

- **Status:** READY_FOR_REVIEW (bounded repair; not TASK `done`). One coordinator follow-up (4) is not implementable from the extension; see below.
- **Author (actual session identity):** `impl-extension-bridge-repair-20261114`
- **Date:** 2026-11-14
- **Plugin:** `/Users/andrew/dev/Plugins/ultimate-sdd` (read `references/execution.md`, `skills/plan-tdd/SKILL.md`, `references/tdd.md`)
- **Repo:** `/Users/andrew/dev/threadkeeper/paperclip`, plan root `.plan`

## Gate status (honest)

Load gates for REQ-7..REQ-14 return `ok:false`, because predecessor REQs are waiting on founder-only checks. The user explicitly authorised bounded repair of existing in-progress work ("improve implementation significantly using the plan"). **No gate pass is claimed.** No status, INDEX, review ledger or `.plan/config.json` was changed. No independent review is claimed. Fresh spec review comes first, then quality review, then the coordinator's complete gate.

## Inputs read

Audits `.plan/verify/audits/20261114/{REQ-12-14,REQ-8-13,REQ-7,REQ-9-10,REQ-11}.audit.md` (each finding was verified against source before fixing); contracts `.plan/reqs/REQ-{7,8,10,11,12,14}-*.md`; `.plan/workflow.md`. Read-only plugin sources were inspected to confirm wire behaviour: `packages/plugins/plugin-browser-sessions/src/{service,worker,tools}.ts` and `server/src/services/plugin-secrets-handler.ts:195`.

## Files changed (all within allowed scope)

Source (`extension/`):
- `src/core/paperclip/client.ts` — `secretTransportAllowed`, `SECRET_TRANSPORT_REFUSED`
- `src/core/paperclip/credentials.ts` — transport check; link clears the stored value; `commitLinkedKey`; `credentials.clear`; previous-company clear; `CredentialFailure` reasons; `createSecretReadCache`; `featureRead` parameter
- `src/core/paperclip/bridge.ts` — secret transport check; hint dispatched without await; `commitOfBuildId` re-export; `detectBrowserName`; rejected-row memory; plugin error surfaced; 403-bad-token mapped to `not_paired`; action failure log hook
- `src/core/paperclip/bridge-protocol.ts` — `commitOfBuildId`
- `src/core/paperclip/bridge-query.ts` — `newestPage`, `cutToFit`, `CUT_MARKER`, `TRANSCRIPT_PAGE_CHARS`, `boundedResult` (marks cuts, trims oldest first), `degraded` from the search outcome, `OBSERVED_REFRESH_MS` fingerprint bucket; removed unused imports
- `src/core/paperclip/sync.ts` — hint sync skips `not_found`/`forbidden` per issue/run; writes `lastSyncAt` only
- `src/core/paperclip/observations.ts` — `baselines` and `dropThread`
- `src/core/paperclip/actions.ts` — `onFailure` hook, `VERDICT_MARGIN_MS`
- `src/core/paperclip/integration-runtime.ts` — coded errors, worker secret cache, `keepAlive`, `BRIDGE_KEEPALIVE_ALARM`, `focusWorkspaceTab`
- `src/core/cloud-client.ts` — `credentialPresent` in `reserveClientBudgetSlot`
- `src/core/embed/session-delivery.ts` — count-based delivery confirmation
- `src/entrypoints/background.ts` — error `code` in PAPERCLIP_INTEGRATION responses; hint store; `alarms` option; keep-alive on startup and alarms; `focusWorkspaceTab`
- `src/entrypoints/manager/PaperclipBridgeSettings.tsx` — status copy
- `src/entrypoints/manager/PaperclipCredentials.tsx` — deselect sends `credentials.clear`
- `src/entrypoints/manager/paperclip-actions.ts` — F-7 limits, F-8 check

Tests (`extension/tests/unit/`): `paperclip-credentials.test.ts`, `paperclip-credentials-ui.test.tsx`, `paperclip-bridge-client.test.ts`, `paperclip-bridge.test.ts`, `paperclip-hints.test.ts`, `paperclip-integration-runtime.test.ts`, `paperclip-integration-ui.test.tsx`, `paperclip-observations.test.ts`, `paperclip-actions.test.ts`, `paperclip-manager-actions.test.ts`, `paperclip-delivery.test.ts`.

This report: `.plan/verify/extension-bridge-repair.r1.implementation.md`. No new source files; no deleted files.

Not touched: `dock/payload.ts` (avoidable), `tests/unit/dock-*.test.ts`, `host.ts`, `lifecycle.ts`, `PaperclipView.tsx`, `PaperclipConnection.tsx`, `App.tsx`, `shell/**`, `styles/**`, `mac-helper/**`, plugin package, `ui/**`, `server/**`, `scripts/**`.

**Scope note:** many of these files already had uncommitted edits by other contributors before this round (see `git status`). My edits are additive. Reviewers should diff the hunks named above rather than whole-file `git diff`.

## Finding → result

| Finding | Result | Test (file › name) | Actual |
|---|---|---|---|
| REQ-14 F-1 transport | Fixed. `saveSecret` and `bridge.resolveSecret` refuse anything that is not loopback (localhost, 127/8, ::1) or `https:`, before fetching | credentials › "refuses to send a secret value to a plain-http server…"; bridge-client › "refuses secret reads over plain http…" | pass |
| REQ-14 F-2 link leak | Fixed. After a successful readback, link clears the stored value in one transaction | credentials › "clears the stored value once a link is read back…" (IndexedDB plus `writeBackup` output); "keeps the stored value when … cannot be read back" (characterization) | pass |
| REQ-14 F-6 source switch | Fixed. A switch clears the previous company and the new one. Deselect is a new `credentials.clear`: local first, then the previous company | credentials › "switching … clears the PREVIOUS company A config"; "deselecting … clears local consent first…"; credentials-ui › "deselecting the source asks the worker…" | pass |
| REQ-14 F-8 worker token | Fixed (`credentialPresent`) | credentials › "cloud calls accept a linked worker token with an empty local value" | pass |
| REQ-14 F-11 notice | Fixed. Reasons `missing`, `disabled`, `not_paired` and `unavailable`; the `unavailable` text is the contract notice. Codes are carried across worker and manager messaging | credentials › "tells a missing secret and turned-off transfer apart…" | pass |
| REQ-14 F-9 throttle | Fixed. Shown necessary: one `embedTexts` per thread (`pipeline.ts:661`) × each linked key vs 30 reads/min (`plugin-secrets-handler.ts:195`); RED shows 40 reads. The 30 s memory-only cache lives in the worker, behind the DB consent re-check and token check. Cleared on any credential or pairing command. Link/move readbacks bypass it | integration-runtime › "worker reuses a linked key briefly…" (40 embeds ≤30 reads; switch-off wins at once; rotation within 60 s) | pass |
| REQ-8 #1 cut marker | Fixed in `bridge-query.ts`. Every cut ends `[…cut]` and sets `truncated`. Redaction happens before cutting | bridge › "cuts a 200,000-character message with […cut]…" | pass |
| REQ-8 #2 paging | Fixed. The window is loaded whole; the page is built from the newest end within 48,000 JSON chars; `before` is the oldest index returned. An oversized message gets its own page | bridge › "pages 300 messages of 3,000 characters newest first…" (exhaustive, no gaps) | pass |
| REQ-8 #8 degraded | Fixed. `degraded` comes from the actual `semantic`/`reranked` outcome | bridge › "reports degraded local_only … fails at runtime" | pass |
| REQ-8 #10 context limit 20 | Already correct (characterization, no code change) | bridge › "accepts sessions_context limit 20…" | pass (no RED) |
| REQ-12 F-3 | Fixed. A failing hint is logged and does not disconnect; `not_found`/`forbidden` are skipped per issue/run | bridge-client › "keeps the bridge connected when a hint sync fails"; hints › "skips a missing task…" | pass |
| REQ-12 F-4 | Fixed. `onHint` is dispatched without await | bridge-client › "does not hold the bridge tick on a slow hint sync…" | pass |
| REQ-12 UI "Last synced" | Fixed. A hint sync writes `lastSyncAt` only; cursors and marks are unchanged; background passes the store | hints › "updates \"Last synced\" after a hint-driven fetch…" | pass |
| REQ-7 #5 keep-alive | Fixed. `tk-paperclip-bridge` alarm every 0.5 min while any company is paired, independent of `paperclip.enabled`; also on startup and the sync alarm | integration-runtime › "keeps a dedicated bridge alarm…" | pass |
| REQ-7 #3 commit | Fixed (`commitOfBuildId`) | bridge-client › "sends only the commit part … names Edge or Chrome" | pass |
| REQ-7 AC-1 browser | Fixed (`detectBrowserName`: UA-CH brands, then the `Edg/` UA) | same | pass |
| REQ-7 #6 resend | Fixed. Rejected fingerprints are kept in memory until the row changes; logged once | bridge-client › "does not resend a row Paperclip rejected…" | pass |
| REQ-7 status screen | Fixed. Connected / Not connected / Version mismatch; `Last seen N minutes ago`; `{n} sessions shared`; commit warning; "10 minutes"; empty state. A plugin `{error}` is surfaced as `unsupported: Paperclip plugin "browser-sessions": …` without clearing the pairing | integration-ui › 4 "browser-session status copy" tests; bridge-client › "surfaces a disabled or failed plugin error…" | pass |
| REQ-10 F2 | Fixed. The last settled state survives frame loss (memory, ≤5,000), so a reload in a new state yields one event | observations › "…reports a changed state once the session is seen again"; "emits nothing when … seen again in the state it was last known in" | pass |
| REQ-10 F15 | Fixed. The fingerprint uses `agentStateAt` in 30 s buckets (the row keeps the exact time), so a row resends about every 30 s, not every 10 s heartbeat, and stays under the plugin's 120 s freshness | bridge › "does not change a session fingerprint on every heartbeat…" | pass |
| REQ-11 F-5 | Fixed. `BrowserActionGuard.onFailure` → bridge `log` (Diagnostics `recentEvents`) for unsupported, denied, unknown_delivery, signed_out and timeout; message text is never included | actions › "records adapter and page-changed failures…" | pass |
| REQ-11 F-7 | Fixed. 30 s page-load limit; frame deadline is 2 s ready + 15 s confirmation + 0.5 s | manager-actions › "limits page loading to 30 s…" | pass |
| REQ-11 F-8 | Fixed. The browser's own account with `signedIn:'no'` is refused before any tab opens | manager-actions › "refuses a signed-out browser account…" | pass |
| REQ-11 F-13 | Fixed. Delivery is confirmed when the count of matching messages increases | delivery › "does not count a re-rendered earlier message…"; "confirms a repeated message…" (characterization) | pass |
| REQ-11 epoch | Verified by inspection, no change. `checkPolicy` (`actions.ts`) refuses `createdAt <= disabledAt`. `adopt` merges the plugin policy (max `disabledAt`, off wins) and calls `cancelPending()`. `cancelledRequestIds` is **not** read (ignored as an unknown field) | existing "off wins…" tests | inspected |
| REQ-13 #7 | Fixed (`focusWorkspaceTab`: tab active, then its window focused) | integration-runtime › "brings the window of an existing workspace tab forward…" | pass |
| Coordinator follow-up 3 (verdict before deadline) | Fixed. The guard aborts 1.5 s before `deadlineAt` | actions › "reports a held action's verdict before its deadline…" | pass |
| Coordinator follow-up 5 (403 bad token) | Fixed. 403 `denied` with "Only the paired extension…" → `not_paired`; consent-off stays `denied` | bridge-client › "treats a 403 bad-token answer…"; credentials F-11 test | pass |
| Coordinator follow-up 6 (refresh ≤60 s) | Done via the F15 30 s bucket | F15 test (35 s heartbeat changes the fingerprint) | pass |
| Coordinator follow-up 4 (offline signal) | **Not done.** The only route, `bridge-disconnect`, **revokes the pairing** (`service.ts:256`); sending it on suspend would unpair the founder. MV3 offers no reliable suspend hook | — | not run |

## Existing tests changed transparently

1. `paperclip-observations.test.ts`: "expires observations … re-baselines after a stale gap" asserted **no** event after a stale gap. That contradicts REQ-10 FR-5 edge. It is re-baselined, with a comment in the file, to expect exactly one event after 5 s.
2. `paperclip-hints.test.ts`: "rejects hints … cross-company issue substitution" asserted that a foreign issue **throws**. REQ-12 F-3 requires per-issue skipping. It now expects `[]`. Still asserted: zero conversations stored, and no comment fetch for the foreign issue.
3. The new AC-10 test was revised before GREEN: it follows `before` to "the page containing it", because oversized messages are deferred to their own page. The revision was made after the first RED and is recorded below.

## TDD (cwd `/Users/andrew/dev/threadkeeper/paperclip/extension`, Node v24.22.1, `npx vitest run tests/unit/<file> [-t <name>]`)

| Behaviour | RED (exit 1, actual) | GREEN (exit 0) | Refactor |
|---|---|---|---|
| F-1 | credentials: "got 'Paperclip did not confirm the secret.'"; bridge: "promise resolved 'memory-only-secret'" | 23/23 | none |
| F-2 | "expected 'stale-stored-voyage' to be ''" | 15/15 | extracted `commitLinkedKey` (shared with move); rerun 15/15 |
| F-6 | 3 failures: missing `credentials.clear`; `['company-b']` lacks `company-a`; "Choose a Paperclip company first." | 18/18 | none |
| F-8 (14) | "'Worker endpoint or bearer token not c…' not to contain 'not configured'" | 33/33 (with core.test.ts) | none |
| F-11 | "expected undefined to be 'missing'" | 22/22 | none |
| F-9 | first RED: "expected 40 to be less than or equal to 30" (resolver-level). The cache was then moved behind the worker's DB re-check; the relocated runtime test RED was observed by temporarily bypassing the cache: "expected 40 …≤ 30"; file restored and verified | 20/20 | cache moved to worker (safety) |
| REQ-8 #1/#2 | "Cannot read properties of undefined (reading 'content')"; "expected 275 to be 299"; after the test revision: "expected 'first question' to be 'after the long answer'" | 10/10 | none |
| REQ-8 #8 | "expected undefined to be 'local_only'" (#10 passed: characterization) | 138/138 bridge and dock (dock unchanged) | removed unused imports |
| REQ-12 F-3/F-4 bridge | "expected 'held' to be 'done'"; "expected false to be true" | 14/14 | none |
| REQ-12 sync | "PaperclipError: Issue not found"; "expected '…00:00…' to be '…12:00…'"; then the existing cross-company test failed as predicted and was changed (see above) | 23/23 (hints + sync) | none |
| REQ-7 #3/AC-1 | "commitOfBuildId is not a function" | 15/15 | moved `commitOfBuildId` to bridge-protocol (lighter manager import); 40/40 |
| REQ-7 #6 | "expected 3 to be 1" | 16/16 | none |
| REQ-7 #5 | "runtime.keepAlive is not a function" | 4/4 | none |
| REQ-7 UI and FR-9 | 5 failures ("…to contain 'Connected'", "'internal: Paperclip bridge request fa…' to contain 'Plugin not found'", …) | 40/40 after remounting the test helper (test-harness fix) | none |
| REQ-10 F2/F15 | "expected [] to deeply equal [ {…} ]"; "expected '856121…' to be 'd5bce1…'" | 26/26, 39/39 | none |
| F15 to 30 s (follow-up 6) | "expected '6bd0…' not to be '6bd0…'" | 30/30 | none |
| REQ-11 F-5 | "expected [] to deeply equal [ { code: 'unsupported' … ]" | 5/5 | none |
| REQ-11 F-8 | "promise resolved { delivered: true … } instead of rejecting" | 9/9 | none |
| REQ-11 F-7 | rejected at the 60 s action deadline, not 30 s | 10/10 | named constants |
| REQ-11 F-13 | "promise resolved { delivered: true … }" (repeated-copy test passed: characterization) | 13/13 | none |
| REQ-13 #7 | "focusWorkspaceTab is not a function" | 5/5 | none |
| Follow-up 5 | "{ code: 'denied' } to match { code: 'not_paired' }"; "expected 'unavailable' to be 'not_paired'" | 40/40 | none |
| Follow-up 3 | "expected -2 to be greater than or equal to 1000" | 16/16 | none |

## Checks

| Check | argv / cwd | Exit | Result |
|---|---|---|---|
| Baseline, paperclip and dock (before edits) | `npx vitest run tests/unit/paperclip- tests/unit/dock-` / `extension/` | 0 | 32 files, 297 tests |
| Full suite (run) | `npx vitest run` / `extension/` | 0 | **104 files, 1,916 tests passed** (brief baseline: 1,833) |
| Type check (run) | `npx tsc --noEmit` / `extension/` | 0 (final) | An intermediate run failed in `tests/unit/paperclip-fused.test.tsx` (missing `PaperclipFusion.js`: another author's concurrent work, resolved by them). Another failed in my new test typing, which I fixed; `paperclip-actions.test.ts` was rerun, 6/6 |
| `npm run build`, `npm run check`, `/tmp/tk-build`, live folder | — | — | not run (forbidden) |
| Plugin and server tests | — | — | not run (outside scope) |
| Real browser, provider pages, real keys | — | — | not run |

Logs: transient, under `/tmp/ebr/` (not preserved in the repo; the key output is quoted above).

## Plugin follow-ups needed

1. A non-revoking, token-authenticated offline route (for example `bridge-offline`, setting `lastSeenAt=0`) is needed before the extension can signal suspend or close (follow-up 4). Never reuse `bridge-disconnect` for this.
2. `bridge/secret`: map a `host.secrets.resolve` failure for a deleted or missing secret to `not_found` (it is likely `internal` today). Until then it shows as "not running", not "missing".
3. `bridge/secret` bad-token detection relies on the message text "Only the paired extension…". A distinct code (or 401) would be sturdier.
4. Optional: `cancelledRequestIds` in poll responses. The extension does not read it yet; trust removal works through a bumped `disabledAt`, which is honoured.
5. REQ-14 F-7 (activity entry), F-5 (hints gated on pairing, not sharing) and F-10 are plugin side. The plugin repair reportedly addressed some of them; not verified here.

## Concerns

- **Major (open):** follow-up 4 (an offline signal in under 1 s) is unmet; it needs plugin follow-up 1.
- **Minor:** the F2 baseline and the rejected-row memory are lost on a worker restart, which is accepted. After a restart a rejected row is offered once more and a reload re-baselines.
- **Minor:** the 30 s worker secret cache means a secret deleted in Paperclip may still be used for up to 30 s, unless a credential command clears the cache. Rotation is visible within 30 s (contract: 60 s).
- **Minor:** detecting a 403 bad token by its message text is brittle (plugin follow-up 3).
- **Runtime-only, not proven:** MV3 alarm wake-up, real Edge brand detection, real provider remount behaviour, window focus.
- **Next action:** a fresh independent spec review on the file scope above, then quality review; the coordinator owns lifecycle and gates.

---

## Round 2: spec-review findings (`.plan/verify/repairs.r1.cumulative-spec.md`) and plugin round 2 contracts

Author: `impl-extension-bridge-repair-20261114`. Same scope and rules. Status: **READY_FOR_REVIEW** (no gate, status or ledger changes; no independent review claimed).

### Files changed in round 2

Source: `src/core/paperclip/{bridge,bridge-protocol,bridge-query,actions,credentials,integration-runtime}.ts`, `src/core/embed/session-delivery.ts`, `src/entrypoints/background.ts`, `src/entrypoints/manager/paperclip-actions.ts`.
Tests: `tests/unit/{paperclip-bridge,paperclip-bridge-client,paperclip-integration-runtime,paperclip-actions,paperclip-manager-actions,paperclip-delivery}.test.ts`.
No new or deleted files. Not touched: `App.tsx`, `PaperclipFusion.ts`, `paperclip-fused.test.tsx`, `host.ts`, `lifecycle.ts`, `PaperclipConnection.tsx`, `mac-helper/**`, `dock/payload.ts`, `dock-*` tests.

### Finding → result

| Item | Result | Test (file › name) | Actual |
|---|---|---|---|
| NF-2 (REQ-11 AC-8, FR-1 texts) | Fixed. The guard aborts with a reason: `'disabled'` (switch-off), `'timeout'` (deadline) or `'denied'` (listed request). The worker executor (`createManagerActionExecutor`, moved out of `background.ts` into `integration-runtime.ts`) forwards the reason and waits **≤3 s** for the manager's own verdict. The manager and frame report `disabled: Agent actions are turned off.`, `timeout: The browser did not answer in 30 seconds.` or `denied: This agent is not trusted for browser actions.` when nothing was typed. The contract `unknown_delivery: The message may or may not have been sent. Read the session before trying again.` is used only after submission or when no verdict arrives | runtime › "on a switch-off abort, waits for the manager and returns its disabled verdict"; "answers the contract unknown_delivery text only when the manager gives no verdict in time"; manager-actions › "reports the contract text for why it stopped before typing…"; actions › "tells the executor why it was aborted…"; delivery › "reports a deadline abort before submission as timeout…" | pass |
| NF-3 offline signal | Fixed. `PaperclipBridge.signalOffline()` POSTs `/bridge/offline` with `{companyId}`, the bridge token header and `keepalive: true` for each paired, non-revoked company. It never throws; 404 and network errors are ignored; the pairing is kept. Wired to `chrome.runtime.onSuspend` in `background.ts`. The worker is the only bridge context (reads are served there), so closing the manager page does **not** signal offline; doing so would break reads that still work | bridge-client › "signals offline to every paired company with keepalive, ignoring 404 and network errors" | pass |
| NF-3b deadlines | Fixed. Page load is bounded by `min(now + 30 s, deadlineAt − 1.5 s verdict − 2 s Send-ready − 15 s confirmation − 0.5 s)`. An already loaded page is never refused. The frame deadline and manager timer end by `deadlineAt − 1.5 s`. Plugin round 2 budgets (send 55 s, start 70 s) cover 30 s + 15 s: total need is about 49 s | manager-actions › "fits page load and delivery inside the action deadline…"; F-7 test still passes | pass |
| NF-7 `truncated` | Fixed. True only for a real cut or loss; older messages are reached through `before` | bridge › "sets truncated only for a real cut…" | pass |
| NF-8 cache | Fixed. A new `onDisconnect` bridge dependency drops the worker secret cache whenever any company's poll or connect fails (also on revocation). A failed read stores nothing; credential and pairing commands already cleared it. Remaining bounded staleness (≤30 s while the bridge stays healthy and only the Paperclip side changes) is documented on `createSecretReadCache` | runtime › "drops a cached model key as soon as bridge/poll fails" | pass |
| Plugin round 2 (a) offline route | Matches: body `{companyId}`, token header; a `not_paired` answer is ignored; the next connect or poll brings the browser back | NF-3 test | pass |
| Plugin round 2 (b) 55 s / 70 s | Fits (see NF-3b) | NF-3b, F-7 tests | pass |
| Plugin round 2 (c) cancel-requests | Fixed. Connect sends `capabilities: ["cancel-requests"]`. Only `cancelledRequestIds` from poll responses are aborted (reason `denied`), and a listed request in the same poll is not started | bridge-client › "announces cancel-requests on connect and cancels only the requests Paperclip lists"; actions › "cancels only the listed request, telling its executor it was denied" | pass |
| Plugin round 2 (d) own verdict | Fixed (see NF-2): `disabled:`, `timeout:` and `denied:` come from the extension | NF-2 tests | pass |

### TDD (cwd `extension/`, Node v24.22.1, `npx vitest run tests/unit/<file> -t <name>`)

| Behaviour | RED (exit 1) | GREEN | Refactor / notes |
|---|---|---|---|
| NF-7 | "expected true to be false" | 14/14 | none |
| NF-8 | "expected 1 to be 2" | 24/24 | doc comment on bounded staleness |
| NF-3 | "bridge.signalOffline is not a function" | 19/19 | onSuspend wiring (no unit harness for `background.ts`; inspected) |
| NF-3b | "expected 30000 to be less than or equal to 21100" | first GREEN attempt failed: "The session page did not load…" for an already-loaded page under a tight deadline. Fixed by checking the frame before the bound; 17/17 | `VERDICT_MARGIN_MS` moved to `bridge-protocol.ts` (shared by guard and manager); page-load timeout text uses the REQ-8 text |
| NF-2 | 5 failures: "createManagerActionExecutor is not a function"; frame and manager "expected … to match { code: 'timeout' }"; guard "expected [ …(2) ] to deeply equal [ 'disabled', 'timeout' ]" | after a test-timing fix (abort after the action reached the manager; assertions unchanged), 41/41 | executor extracted from `background.ts` |
| Round 2 (c) | "h.guard.cancelRequests is not a function"; "expected undefined to deeply equal [ 'cancel-requests' ]" | 62/62 (five affected files) | `parseAbortReason` shared |

### Checks

| Check | argv / cwd | Exit | Result |
|---|---|---|---|
| Type check | `npx tsc --noEmit` / `extension/` | 0 | clean |
| Full suite, first run | `npx vitest run` / `extension/` | 1 | 1,929/1,930. `backup.test.ts` "restores a whole library…" timed out at 5 s under load. I did not touch it or `backup.ts`; alone it passes 7/7 (`npx vitest run tests/unit/backup.test.ts`, exit 0) |
| Full suite, second run | same | 1 | 1,929/1,930. `paperclip-fused.test.tsx` "still moves through rows with plain j and k in fused mode" failed: another author's file, with `App.tsx` and `PaperclipFusion` changing concurrently. Not mine; not touched |
| Full suite, final (after round 2 c) | same | **0** | **104 files, 1,932 tests passed** |
| Build, live folder, real browser, provider pages, plugin and server tests | — | — | not run |

### Remaining concerns and follow-ups

- **Minor:** after an abort the verdict can arrive up to 3 s after the guard's early stop (1.5 s before `deadlineAt`), so it can be up to about 1.5 s past `deadlineAt`. The plugin's 8 s late-verdict window covers this.
- **Minor:** detecting a 403 bad token on `bridge/secret` still relies on message text (plugin follow-up 3 from round 1).
- **Runtime-only:** whether `chrome.runtime.onSuspend` fires and `keepalive` delivers before eviction in Edge and Chrome is not proven by unit tests.
- Plugin follow-up still open from round 1: map a deleted or missing secret to `not_found`.

---

## Round 3: quality-review Minors (`.plan/verify/repairs.r2.cumulative-quality.md`)

Author: `impl-extension-bridge-repair-20261114`. Same scope and rules; last round the review budget allows. Status: **READY_FOR_REVIEW** (no gate, status or ledger changes; no independent review claimed).

### Files changed in round 3

- Source: `extension/src/core/paperclip/{actions,bridge,bridge-protocol,credentials}.ts`, `extension/src/entrypoints/manager/paperclip-actions.ts`
- Tests: `extension/tests/unit/{paperclip-actions,paperclip-bridge-client,paperclip-credentials}.test.ts`
- **New:** `scripts/threadkeeper-contracts.test.mjs` (the one authorised file outside `extension/`)
- Not touched: plugin, `ui/**`, `host.ts`, `App.tsx`, `PaperclipFusion.ts`, `paperclip-fused.test.tsx`, `dock/**`

### Finding → result

| Item | Result | Test | Actual |
|---|---|---|---|
| F-2 early cancels | Fixed. `cancelRequests` remembers ids not yet registered (memory only, ≤2,000, 10 min expiry) and aborts the request with `denied` when it registers. Repeated ids are harmless | actions › "remembers a cancel that arrives before its request is registered, and tolerates repeated ids" | pass |
| F-3 link changes | Fixed. A new `BrowserActionGuard.revalidateLinks(companyId, links)` aborts only `session.send` actions that no current link authorizes. It uses the same rule as the pre-execution check, a new reason `unlinked` (code `denied`) and the FR-1 text `The session is not linked to the task you are working on.`. Starts and other sends continue. `bridge.adopt` calls it instead of `cancelPending()` | actions › "when links change, aborts only actions whose own link vanished…"; bridge-client › "revalidates pending actions against the new links instead of cancelling every action" | pass |
| F-5 cache race | Fixed. A generation counter: `clear()` bumps it, and an in-flight read stores its value only if the generation is unchanged | credentials › "a read in flight when the cache is cleared does not store its value afterwards" | pass |
| F-7 cross-package invariants | Added `scripts/threadkeeper-contracts.test.mjs` (node:test). It parses `export const` numeric literals, because TypeScript is not importable from plain node. The plugin's exports `SEND_TIMEOUT_MS` (60 s), `START_TIMEOUT_MS` (75 s), `ACTION_REPORT_MARGIN_MS` (5 s) and `ACTION_SETTLE_MS` (8 s) **were present** and are read from `contracts.ts`. Asserted: (1) verdict lateness after `deadlineAt` (`MANAGER_VERDICT_WAIT_MS − VERDICT_MARGIN_MS` = 1.5 s) + 1 s headroom ≤ the plugin report margin (5 s); (2) cancel verdict (`BRIDGE_LOOP_MS` + `BRIDGE_POLL_WAIT_MS` + verdict wait = 7 s) + 0.5 s ≤ settle (8 s); (3) 30 s page load + 2 s + 15 s + 0.5 s + 1.5 s fits send and start budgets minus the margin; (4) `MAX_NOTICE_REGIONS` equal in `extension/src/core/paperclip/host.ts` and `ui/src/lib/threadkeeper-host.ts` (8 = 8). A self-check test proves the checker flags one-sided changes | `node --test scripts/threadkeeper-contracts.test.mjs` | 3/3 pass |
| Refactor for F-7 | `bridge.ts` literals `3000` (poll wait) and `1000` (loop) became exported `BRIDGE_POLL_WAIT_MS` and `BRIDGE_LOOP_MS` in `bridge-protocol.ts`; behaviour unchanged | full suite | pass |

The session-board ↔ dashboard mapping named in F-7 spans files owned by others (`host.ts`, `PaperclipFusion.ts`, `App.tsx`, `PluginPage.tsx`) and is **not** covered here.

### TDD

| Behaviour | RED (exit 1, actual) | GREEN | Notes |
|---|---|---|---|
| F-5 | "expected 'stale-before-clear' to be 'fresh'" | 26/26 (credentials + runtime) | none |
| F-2 | "expected { requestId: 'req-early', …(2) } to match object { ok: false … }" | 9/9 | none |
| F-3 | "h.guard.revalidateLinks is not a function"; "expected [] to deeply equal [ [] ]" | 65/65 (five affected files) | `abortCode()` shared by guard, manager and frame |
| F-7 | Characterization: the packages agree today. A real RED was observed by temporarily setting `MANAGER_VERDICT_WAIT_MS = 9_000`: exit 1, "verdict lands 7500 ms after deadlineAt; plugin timer is 5000 ms after it…" and "a cancel's verdict can take 13000 ms; plugin settle window is 8000 ms…". The file was restored from backup and the value verified as `3_000` | 3/3 | constants extracted from `bridge.ts` |

### Checks

| Check | argv / cwd | Exit | Result |
|---|---|---|---|
| Type check | `npx tsc --noEmit` / `extension/` | 0 | clean |
| Full suite | `npx vitest run` / `extension/` | 0 | **104 files, 1,938 tests passed** |
| Contract test | `node --test scripts/threadkeeper-contracts.test.mjs` / repo root | 0 | 3 pass, 0 fail |
| Build, real browser, plugin and server suites | — | — | not run |

### Remaining concerns

- Minor: the contract test parses source text. Renaming a constant, or making it non-literal, fails the test loudly ("not a numeric export const") rather than passing silently, which is the intended direction.
- Minor: `service.spec.ts:557` (plugin) still hardcodes `1_500`. Owner: plugin.
- Not covered: the session-board ↔ dashboard mapping (other owners' files).
- Runtime-only items from rounds 1–2 are unchanged (`onSuspend` with `keepalive`, MV3 alarm wake-up, provider re-render behaviour).
