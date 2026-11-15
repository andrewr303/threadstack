# AC audit — REQ-4 (auditor model: sonnet)

> Verbatim final report of an independent read-only auditor (ultimate-sdd:verifier), persisted by the coordinator on 2026-11-14.
> Purpose: improvement backlog. Not a completion certification; no checks were executed by the auditor.

# REQ-4 / TASK-1 source audit (improvement backlog)

I read the code and unit tests only. I ran no checks and did not drive a browser. No review records exist, and the failing complete gate is noted but not used for any verdict. File references are under `/Users/andrew/dev/threadkeeper/paperclip/extension/`.

## 1. Per-AC verdicts

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | PASS-TESTED (2 s live render is RUNTIME-ONLY) | `src/core/paperclip/lifecycle.ts:127-141` derives `running`, and copy is at `:40`. Tests: lifecycle "polls only visible windows…" and connection.test "checks immediately…". |
| AC-2 | PARTIAL, RUNTIME-ONLY | Flow is at `lifecycle.ts:91-118`. Test "starts once, fails after sixty seconds…" covers the `starting` state and the single start. No test goes `stopped`, `starting`, `running` after the server comes up. The real launchd round trip is FOUNDER-ONLY. |
| AC-3 | PARTIAL | `lifecycle.ts:117` and `:94` produce `start_failed`, and the no-second-start behaviour is tested in "starts once, fails after sixty seconds…" and "aborts a hung health request…". The reason is shown as the raw code, e.g. `Paperclip did not start: paperclip_start_failed` (`:47`). The 60 s timeout path shows "startup timed out". No test covers the `ok:false` path through the UI or the `Retry` button. |
| AC-4 | PASS-TESTED (lifecycle level) | `lifecycle.ts:104-108` and `:95`. Test "installs only on setup…". No `PaperclipStatus` render test checks the string or the button. |
| AC-5 | PASS-TESTED | `lifecycle.ts:130-137`. Test "maps bootstrap and rejected board credentials…". The no-key case is untested. |
| AC-6 | PASS-TESTED | `lifecycle.ts:127-129`. Tests "does not start a foreign service…" and the HTML 200/404/503 `it.each`. |
| AC-7 | PASS-TESTED | `mac-helper/core.cjs:204` and `:222-263`. `paperclip-helper.test.ts` "records a source shim…" covers extra `path`, `command` and `args` fields being ignored, and the unregistered case. The shim path, root and instance id come from `config.json`. The shim is called with fixed argv. |
| AC-8 | FOUNDER-ONLY / RUNTIME-ONLY | No stop path exists in source. The server runs as a launchd service, so it is not tied to the browser. Nothing tests it. |
| AC-9 | PASS-TESTED | `lifecycle.ts:152-157` and `:70-72`. Both lifecycle and connection tests cover hidden for 60 s and one request on becoming visible. The "within 1 s" timing is not asserted. |
| AC-10 | PARTIAL | Dedup is in `lifecycle.ts:22-36`, wired at `integration-runtime.ts:11` and `:28`. The test calls only the bare coordinator. Nothing goes through `handle()` or two lifecycles. The dedup is in worker memory for 60 s. The helper does no dedup of its own. |
| AC-11 | FAIL against literal text | The lifecycle always calls `helper.status()` when the server is down (`lifecycle.ts:100`). That sends a native message whenever the `nativeMessaging` permission is held. `helper_unavailable` maps to `stopped` (`:104`), but no test covers that mapping. |

## 2. FR scenario gaps

- **FR-2 positive:** the full `stopped` → `starting` → `running` run has no test.
- **FR-3 negative:** the copy `Run "Install Mac Helper.command" again and choose the Paperclip folder.` appears nowhere in `src` (grep for `again and choose` and `not_registered` found only `lifecycle.ts:104`). There is no test either.
- **FR-3 edge:** helper missing gives `stopped` plus the manual line, but with the nativeMessaging permission held the helper is still messaged (see AC-11). There is no test for `status` returning `helper_unavailable`.
- **FR-5 negative:** the `Allow access` button exists (`PaperclipConnection.tsx:98`), but there is no render test. No test checks that `chrome.permissions.request` names only the Paperclip origin.
- **FR-6 edge:** a registered folder that no longer exists should answer `paperclip_start_failed`. The code does this (`core.cjs:228`) but no test covers it.
- **FR-4 positive:** no test checks the company-list request after `running`.
- **Older helper (compatibility):** an older helper answers the new request types with an error. The extension treats that as helper missing in `helper.ts:68-83`, but no test covers it.

## 3. Findings

1. **Major | AC-11 / FR-3 edge | `lifecycle.ts:99-107`.**
   - Expected: no native message when the helper is not installed.
   - Actual: every 5 s poll while the server is down sends `paperclip.status` to the helper. That spawns a Node host process each time, and fails each time if the helper is missing.
   - Fix: in `lifecycle.ts`, remember `helper_unavailable` for the window's lifetime, or probe once with a ping. Stop calling `status()` once `attempted` is true or the state is `stopped` or `not_installed`. The `AC-11` text may also need a founder decision, because it cannot be met literally without some native probe.
   - Test: helper `status` returning `helper_unavailable` over 3 polls, expecting at most 1 helper call.

2. **Major | FR-3 negative | `lifecycle.ts:104`, `:169`, `PaperclipConnection.tsx:95`.**
   - Expected: `paperclip_not_registered` shows the "Install Mac Helper.command again…" line.
   - Actual: the state is `not_installed` with a `Set up Paperclip` button. Pressing it gives `Paperclip did not start: paperclip_not_registered`, with no instruction.
   - Fix: add a reason-to-copy map in `lifecycle.ts` (`paperclipLifecycleText`) and render the exact string in `PaperclipConnection.tsx`.
   - Test: a render test with `status` returning `not_registered`, then setup returning `not_registered`.

3. **Major | AC-3 | `lifecycle.ts:47`.**
   - Expected: a human reason.
   - Actual: raw codes such as `paperclip_start_failed`, `helper_unavailable` and `unsupported_platform` appear in the status line.
   - Fix: map codes to sentences in `lifecycle.ts`.
   - Test: a copy snapshot for each code.

4. **Major | FR-3 / FR-6 | `lifecycle.ts:104`.**
   - Actual: `status` without a registration returns `paperclip_not_registered`, which becomes `not_installed` with a Set up button that cannot succeed. This is the same dead end as finding 2.
   - Fix: covered by the fix for finding 2.

5. **Minor | UI contract | `PaperclipConnection.tsx:96`.**
   - Expected: `Start` only when the helper is connected.
   - Actual: `Start` shows whenever the state is `stopped`, including helper missing, and pressing it only repeats `status`.
   - Fix: track `helperConnected` in the snapshot and show the button only when true.
   - Test: a render test for `stopped` with `helper_unavailable`.

6. **Minor | AC-10 | `integration-runtime.ts:11` and `lifecycle.ts:29`.**
   - Actual: the dedup state lives in the service worker and is lost on restart. A second window opened more than 60 s after the first gets a fresh start. A worker restart mid-start can send a second `start`. This is mitigated because the helper start is a no-op when the service is already active.
   - Fix: persist the start timestamp in `chrome.storage.session`, or accept the current behaviour and document it.
   - Test: a runtime test with two `handle({type:'PAPERCLIP_SERVICE_START'})` calls, expecting one helper send.

7. **Minor | FR-4 | `lifecycle.ts:133-137`.**
   - Actual: a 5xx, a network error or a timeout on `/cli-auth/me` all show `needs_sign_in`. Only a 401 or a missing `userId` should.
   - Fix: map non-401 failures to `unreachable`.
   - Test: `/cli-auth/me` returning 500.

8. **Minor | FR-6 | `core.cjs:246`.**
   - Actual: the foreign-service check on the launchd plist runs only when `status.serviceName` is a string. If the CLI omitted it, an upstream service with the same label would be started.
   - Fix: when `installed` is true and `serviceName` is missing, treat the status as not registered.
   - Test: a helper test with `{installed:true,active:false}` and a foreign plist.

9. **Minor | robustness | `lifecycle.ts:160` and `:166`.**
   - Actual: `setup()` has no client-side timeout, and polling is paused while `installing`. A native host that never answers (the host handles messages serially, so a long backup can delay it) leaves the line on `starting` with polling off. `retry()` returns the in-flight pending poll without re-polling.
   - Fix: wrap `helper.install` in a 70 s timeout.
   - Test: an install promise that never settles, with fake timers.

10. **Minor | test coverage.** No test renders `PaperclipStatus` to check the exact copy or the action buttons. `paperclip-connection.test.tsx` has one happy-path test.

## 4. Top 3 improvements

(1) Fix the helper-missing and unregistered paths (findings 1 to 4), so the exact FR-3 copy shows and polling does not spawn helper processes. (2) Add `PaperclipStatus` render tests for the exact copy and actions, and a `handle()`-level dedup test through `integration-runtime.ts`. (3) Harden the edges: a 70 s install timeout, 5xx handling on `/cli-auth/me`, and requiring `serviceName` in the helper's foreign-service check.
