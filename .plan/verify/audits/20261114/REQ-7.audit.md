# AC audit — REQ-7 (auditor model: opus)

> Verbatim final report of an independent read-only auditor (ultimate-sdd:verifier), persisted by the coordinator on 2026-11-14.
> Purpose: improvement backlog. Not a completion certification; no checks were executed by the auditor.

# REQ-7/TASK-1 audit: bridge between the extension and Paperclip with a session inventory

**Result: FAIL.** This is an improvement backlog, not a completion certificate. AC-2 and AC-10 have defects you can see in the source, and the bridge token can be issued to an attacker.

- **Selector:** REQ-7/TASK-1, contracts read from disk (`.plan/reqs/REQ-7-…md`, `.plan/tasks/REQ-7/TASK-1-…md`).
- **Author:** the implementation pipeline, identity not recorded. **Reviewer:** this read-only auditor; I did not write the code.
- **Reviews:** no spec or quality review is recorded in the ledger, so reviews are `PENDING_INDEPENDENT_REVIEW`. The complete gate is known to fail; as you asked, I did not examine it further.
- **Checks run:** none. My tools are read-only, so every verdict below comes from reading source and tests. I did not trust the prior reports.

## 1. Per-AC verdicts

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | PARTIAL | The status label is at `plugin…/src/ui/index.tsx:17`, and rows are company-scoped (`store.ts:19-39`). But the browser name is always "Chromium": `bridge.ts:158` defaults to it and `background.ts:513-539` never passes `browser`, so the founder's Edge shows as Chromium. Tested only at service level ("isolates companies…"). The UI needs a runtime check. |
| AC-2 | FAIL | The plugin answers `version_mismatch` (`service.ts:61,97`; test "rejects expired pairing and protocol mismatch…"). Gaps: (a) existing rows are not purged on a mismatch (`:97`), and `status()` still counts them; (b) a never-paired mismatched extension is refused at `startPair:61` without saving state, so the plugin page shows "Not connected"; (c) the extension screen has no commit warning at all and shows mismatch only as the raw `lastError` "version_mismatch: …" (`PaperclipBridgeSettings.tsx:85`); (d) the commit comparison is always unequal (finding 3). |
| AC-3 | RUNTIME-ONLY | The D-7 fields are built at `bridge-query.ts:51-56`. The 4 MB and count packetizer is tested ("keeps UTF-8 rows… four-megabyte budget", "splits short upserts…"). Proof needs a timed 2,000-row run against a local server. Risk: see finding 6. |
| AC-4 | PASS-TESTED (logic) / RUNTIME (10 s) | Only fingerprint-changed rows are sent ("sends only changed fingerprints and removes newly private sessions"). Fingerprints come back from the plugin on connect (`service.ts:102-103`). The store upsert prevents duplicates (`store.ts:24`). |
| AC-5 | RUNTIME-ONLY | Request/answer matching is tested ("correlates one browser response…"). The 2 s round trip needs a run. |
| AC-6 | PASS-TESTED | `service.ts:124`; the same test fakes 41 s of silence and gets `browser_offline`. |
| AC-7 | RUNTIME-ONLY, at risk | After the MV3 service worker restarts, the bridge only starts again on `onStartup`/`onInstalled` or on a 5-minute alarm that only exists when `paperclip.enabled` (`background.ts:605-617,1462,1530-1534`). In that gap callers get `browser_offline`, which is neither rows nor `timeout`. |
| AC-8 | PASS-TESTED (extension) / RUNTIME (10 s removal) | Private sessions are filtered per packet (`bridge.ts:251,275-276`) and requests are checked again before answering (`bridge-query.ts:220,239-241`). Tests: "excludes private sessions and Paperclip tasks…", "drops content and counts if privacy changes…". |
| AC-9 | PASS-TESTED (service) | `service.ts:53`; test "returns calm unshared…" checks via the `sessions_list` tool. There is no route-level test with a company-B board user. |
| AC-10 | FAIL | `service.ts:63` returns code `busy` with "Disconnect the paired browser before pairing another." The required text `Another browser is already connected for {company}. Disconnect it first.` appears nowhere in source. No test. |
| AC-11 | PASS-TESTED | Unshare deletes rows at `service.ts:192`, disconnect at `:200`. Tests: "…purges revoked inventory", "prevents a racing heartbeat…", and the extension test "revokes sharing locally while offline…". |
| AC-12 | Not run | I could not run `tests/unit/dock-*.test.ts` or diff them. No evidence either way. |
| AC-13 | PASS-TESTED | Paperclip tasks are dropped on both sides (`bridge-query.ts:39`, `bridge.ts:276`, `contracts.ts:74`). Test: "excludes private sessions and Paperclip tasks…". |
| AC-14 | PARTIAL | Every bridge route calls `authenticate` (`worker.ts:40-47`), and wrong and revoked tokens are tested (service tests at lines 44 and 144). Gaps: no route-level test for a missing header; `/bridge/inventory` checks the body before the token (`service.ts:156-163`), so an unpaired caller gets `bad_request`/`too_large`, not `not_paired`; and finding 1. |
| AC-15 | PARTIAL | Agents are refused before the handler runs (`plugins.ts:1941`, `assertBoard`), tested as a bare 403 ("…refuses agent credentials before dispatch"). But the response body is `{error:"<message>"}` (`plugins.ts:2015-2017`) with no `denied` code, and the run-token variant is untested. |
| AC-16 | PARTIAL + RUNTIME + FOUNDER-ONLY | The provisioner runs in production code (`app.ts:681-689,1395`), and a disabled plugin stays disabled (`bundled-plugins.ts:436-455`). But the catalog root defaults to `/app/packages/plugins` (`:39`). Only the mac-helper shim sets `PAPERCLIP_BUNDLED_PLUGIN_ROOT` (`extension/mac-helper/install.cjs:68`); a plain source start silently skips the install. Proof needs a restart and the plugin list. |

## 2. Scenarios with no implementation or no test

- **FR-2 edge:** the extension screen never shows the different-commits warning.
- **FR-7:** "Last seen 5 minutes ago" is not relative. The plugin shows an absolute `toLocaleString` (`ui/index.tsx:32`). The extension shows no last-seen time, no Connected/Not connected (only "Paired/Not paired", `PaperclipBridgeSettings.tsx:78`), no `{n} sessions shared`, and no empty-state text.
- **Wrong expiry text:** the extension says "It expires in five minutes" (`PaperclipBridgeSettings.tsx:80`); the contract and the server (`service.ts:66`) use 10 minutes.
- **FR-9 negative:** a disabled or failed plugin returns 404 `{error:"Plugin not found"}` (`plugins.ts:1896`). The extension turns that into the generic "internal: Paperclip bridge request failed." (`bridge.ts:150-152`), not the plugin's error from the plugin list.
- **FR-1 negative and FR-8:** no route-level test where a missing header returns `not_paired` and nothing is stored or sent.
- **FR-5 edge** (two granted companies both updated): the code loops over companies (`bridge.ts:346`), but no test asserts both rows update.

## 3. Findings (most severe first)

1. **Major (security) — FR-8/D-12: any local process can mint itself a bridge token on `local_trusted`.** `pair-confirm`, `disconnect` and `sharing` are exposed as board HTTP routes with no token check (`manifest.ts:30-32`, `worker.ts:48` → `dispatch:63-65`).
   - **Exploit:** a non-agent local process (treated as the board):
     1. `POST …/api/disconnect {companyId}` revokes the real extension, which then silently clears its token on its next `not_paired` (`bridge.ts:318`).
     2. `POST /pair/start` returns a code and poll token.
     3. `POST /pair/confirm {code, shared:true}` confirms it.
     4. `POST /pair/poll` returns a fresh `bridgeToken`.
   - **Impact:** the attacker can feed fake sessions, receive agent requests, and call `/bridge/secret` (`service.ts:275-285`), which returns resolved secret values when `allowSecretTransfer` is on. That is exactly what D-12 says the token prevents.
   - **Bounded fix:** in `manifest.ts` and `worker.ts`, drop `pair-confirm`, `disconnect` and `sharing` from `apiRoutes` (keep them as UI actions), and require the current token to revoke while a bridge is live.
   - **Spec issue:** on `local_trusted`, the UI action endpoint is also reachable by local processes. D-12's boundary needs a decision through Specify: accept the risk explicitly, or require an authenticated mode before secret transfer.
   - **Test:** a route test where a `local_implicit` caller cannot complete start → confirm → poll without going through the UI action path.

2. **Major — AC-10: wrong error.** `service.ts:63` returns `busy` with the wrong text.
   - **Fix:** look up the company name via `companies.read` and throw `Another browser is already connected for {company}. Disconnect it first.`
   - **Test:** a second `startPair` after pairing asserts the exact message.

3. **Major — AC-2/D-11: the commit warning is always shown.** The extension sends the full `BUILD_INFO.buildId` (`background.ts:514`), which is `${stamp}-${sha}` (`extension/scripts/build-extension.mjs:35`). The plugin stores a bare short sha (`scripts/build-ui.mjs:8`). The comparison at `service.ts:108` therefore never matches.
   - **Fix:** pass the sha part of `buildId` (D-11 says the commit part) in `background.ts`, or split it in `bridge.ts:158`.
   - **Test:** matching commits produce `warning: null`.

4. **Major — AC-2: rows survive a version mismatch.** `connect` sets `versionMismatch` but keeps the stored rows (`service.ts:97`).
   - **Fix:** `store.remove("session", companyId)` on mismatch, and return a count of 0 while mismatched.
   - **Test:** the mismatch test also asserts `sessionCount: 0`.

5. **Major — AC-7/MV3: no restart after the service worker is evicted.** The bridge only restarts at the points listed under AC-7 (`background.ts:1462,1533`). If Paperclip sync is disabled, it never restarts until the browser restarts.
   - **Fix:** create a dedicated bridge alarm (for example every 0.5 min) whenever any company is paired, independent of `paperclip.enabled`.
   - **Test:** an integration-runtime test that the alarm restarts the bridge.

6. **Minor — FR-3: rejected rows are resent forever.** Rows the plugin rejects (for example a non-https URL, `contracts.ts:75`) never get a fingerprint (`bridge.ts:285`). Every tick, roughly every 4 s, resends them and writes a Diagnostics entry, and the row count falls short of 2,000.
   - **Fix:** remember rejected fingerprints until the row changes.

7. **Minor — robustness: a malformed result hangs the caller.** In `results()`, a result with `ok:false` and no `error` deletes the pending request, then throws (`service.ts:149-151`). The caller's promise never settles.
   - **Fix:** validate each result first and reject with `bad_request`.

8. **Minor — replay: a poll token can re-mint the bridge token.** `pollPair` issues a new token on a repeat poll until the first connect (`service.ts:86`). Concurrent UI polls (`PaperclipBridgeSettings.tsx:50`) can leave the extension holding the superseded token.
   - **Fix:** refuse a claimed pair regardless of `lastSeenAt`.

9. **Minor — AC-14 ordering.** `/bridge/inventory` validates the body before the token (`service.ts:156-163`).
   - **Fix:** authenticate first.

10. **Minor — wrong timeout text.** The message always says "30 seconds" whatever the deadline (`service.ts:128`).

11. **Minor — contract conflict (send to Specify).** Rows include `gist`, a summary of up to 300 characters (`dock/payload.ts:178`), plus `workspacePath`, both stored in Paperclip. D-7 allows this, but it conflicts with the REQ overview ("no message text") and the out-of-scope line on summaries (G-2). Also, `validateSession` accepts any extra key (`contracts.ts:70-79`) rather than an allowlist.

### Risks checked and found handled
- **Bridge token:** CSPRNG, 32 bytes, base64url; stored as SHA-256 on the server; compared with `timingSafeEqual` (`service.ts:21,48,87-88`).
- **Pairing code:** 40 bits with no bias (`byte & 31` over a 32-character alphabet), single use, 10-minute expiry on the server. An attempt limit is not needed, because guessing a code only helps the holder of the poll token.
- **Company isolation:** every SQL statement filters on `company_id` in the WHERE clause (`store.ts:19-39`). Pending results, polls and hints check the company. `getData` overrides `params.companyId` with the access-checked company (`worker-rpc-host.ts:2080`).
- **Token forwarding:** the token header is forwarded only to `browser-sessions` (`plugins.ts:578`, tested); it grants no board identity elsewhere.
- **Logging:** bridge and pair URLs, bodies and errors are redacted (`logger.ts:71,117-121,207-215`; `http-log-redaction.ts:4`). Audit entries record the pair ID, never the code. Worker errors become a generic `internal`.
- **Extension token handling:** the token stays out of UI state, is dropped when the server origin changes, and is sent with `redirect:'error'` and `credentials:'omit'` (`bridge.ts:122,134-145`).
- **Count limits and duplicates:** count limits match on both sides; packets are idempotent and ticks are serialized per company. Shared→private produces removals on the next tick.
- **Requests interrupted by a worker suspension mid-poll:** they are redelivered, not lost (`service.ts:141`).
- **Provisioning:** done by production code, not a test fixture.

## 4. Top 3 improvements
1. Close the self-pairing and revoke path (finding 1) and settle D-12's `local_trusted` boundary through Specify.
2. Fix the AC-2/AC-10 defects (commit comparison, purge on mismatch, exact AC-10 message) and finish the extension status screen.
3. Add a dedicated bridge keep-alive alarm for MV3, then collect the runtime proof for AC-3/5/7/16.
