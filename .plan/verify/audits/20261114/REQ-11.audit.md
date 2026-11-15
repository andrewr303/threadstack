# AC audit — REQ-11 (auditor model: opus)

> Verbatim final report of an independent read-only auditor (ultimate-sdd:verifier), persisted by the coordinator on 2026-11-14.
> Purpose: improvement backlog. Not a completion certification; no checks were executed by the auditor.

# REQ-11/TASK-1 audit: trusted agents start sessions and send messages

**Result: FAIL.** One Blocker lets an agent grant itself acting scope. The rest is a backlog of defects, not a completion certificate.

- **What I checked:** REQ-11/TASK-1 in `/Users/andrew/dev/threadkeeper/paperclip`, against the REQ and TASK files. I read the source and tests directly. I did not run any test, build or browser check (my tools are read-only), and I did not rely on prior reports.
- **Who:** I did not write this code. This is not the ordered spec or quality review. There is no recorded review ledger, so independent review status is `PENDING_INDEPENDENT_REVIEW`. The complete gate is known to fail, as you said, so I spent no time on it.

## 1. Per-AC verdicts

| AC | Verdict | Evidence |
|---|---|---|
| AC-1 | RUNTIME-ONLY | `tools.ts:149-213`, `session-delivery.ts:29-123`. The only stand-in is ChatGPT's textarea (test "reports delivered only after a new user message appears"). The Claude and Claude Code adapters type by setting `textContent` (`session-delivery.ts:77`) and have no test. |
| AC-2 | RUNTIME-ONLY (linking PASS-TESTED) | `tools.ts:206`, `service.ts:260-270`; spec "links an agent-started session after its capture…". The link only forms if the URL matches exactly (`service.ts:264`). |
| AC-3 | PASS-TESTED (stand-in) | `session-delivery.ts:103,108-122`, `paperclip-manager-actions.ts:113`; tests "does not mistake existing text…" and "reports ambiguous delivery as unknown…". Timeouts on the plugin side break this (F-2). |
| AC-4 | PASS-TESTED (stand-in) | Sign-in check `session-delivery.ts:59`; busy checks `tools.ts:188`, `actions.ts:75`, `paperclip-actions.ts:47,88`. Plugin-side busy has no test. |
| AC-5 | PASS-UNTESTED | `tools.ts:176`. The spec test only checks that the error contains `"denied"`. `session_start` by an untrusted agent is never tested. |
| AC-6 | PARTIAL | Link scope: `tools.ts:185-186`, `service.ts:119-120`, `actions.ts:74,98`. Agent credentials refused: `worker.ts:14,33`, no test. The F-1 bypass breaks scope. |
| AC-7 | PASS-TESTED | `tools.ts:192-195`; specs "enforces rolling send and per-session limits…", "…expired request ID", "…despite more than 500 older rows". The atomicity caveat is F-9. |
| AC-8 | PARTIAL | Fresh-install and provider-off texts are correct (`tools.ts:180,191`) but untested. Turning the switch off in Paperclip returns the wrong text (F-4). |
| AC-9 | PARTIAL | `unsupported` is returned (`tools.ts:190`, `session-delivery.ts:66,96`). Nothing records the failure in Diagnostics. No Gemini test. |
| AC-10 | PARTIAL / RUNTIME-ONLY | Slot and frame checks at `paperclip-actions.ts:46,66-72,82-86,102`; tests "refuses a profile slot occupied…" and "refuses stale account identity…". Nothing checks which account the page itself shows (F-12). |
| AC-11 | PASS-TESTED (unit) | `tools.ts:156-163`, `actions.ts:66-67`; specs "deduplicates concurrent actions…" and "deduplicates concurrent and later sends…". "Page shows the message once" needs a browser run. |
| AC-12 | PARTIAL | `tools.ts:208-211`, `ui/index.tsx:48`, `PaperclipTaskLinks.tsx:115`. Fields and status labels are missing (F-6). |
| AC-13 | FOUNDER-ONLY | No evidence. |
| AC-14 | PARTIAL | The literal scenarios are refused (`tools.ts:186`; spec "does not let agent-created links grant acting scope"). D-8 can be bypassed (F-1). The "different agent links S" case has no test. |
| AC-15 | PASS-UNTESTED (guard tested) | `service.ts:99-101`, `actions.ts:114`, `bridge.ts:242`; test "off wins and stale requests are dropped after reconnect" covers the extension guard only. The plugin's reconnect merge has no test, and the two settings screens need a browser run. |

## 2. Scenarios with no implementation or no test

- **FR-2:** the negative case (`gemini`) has no test. In the signed-out edge case, the browser's own active account is never checked for sign-in, so a tab opens (`paperclip-actions.ts:68-72`).
- **FR-3 edge:** no test that an agent credential cannot change trust.
- **FR-5 edge:** switching off in Paperclip while an action waits has no test and returns the wrong text.
- **FR-6:**
  - Loading a Claude Code page and then sending has no test.
  - The bot-check and permission-dialog cases have no test.
  - "Page changed → Diagnostics" is not implemented.
- **FR-7 edge:** the plugin replaying a cached `unknown_delivery` has no test.
- **FR-8:**
  - A refusal shows as `Refused: denied`, not `Refused: not trusted`.
  - "Survives reinstall" has no test.

## 3. Findings

**F-1. Blocker: an agent can grant itself acting scope through `session_start` (properties 2 and D-8).**
- **Where:** `tools.ts:169` sets `threadKey` from agent input for both tools. `tools.ts:203` forwards all agent parameters (`...p`). `service.ts:262-267` links any admitted start whose `action.threadKey` equals an upserted row, without checking that the start succeeded, and gives that link `startedByAgentId`.
- **How to exploit:**
  1. Trusted agent A calls `session_start({provider:"claude", accountId:"bogus", prompt:"x", clientRequestId:"r", threadKey:"<S>"})`, where S is an unlinked shared Claude session.
  2. The plugin admits the call. The extension refuses with `signed_out` and opens nothing.
  3. The action record keeps `threadKey=S`.
  4. The next time S is upserted (the founder uses S, within 24 h), `linkStartedSession` creates the link T↔S with origin `agent` and `startedByAgentId=A`.
  5. A's `session_send` on S now passes `tools.ts:186`, `service.ts:120` and `actions.ts:74,98`.
- **Fix:**
  - In `tools.ts:169`, take `threadKey` only for `session_send`.
  - At `tools.ts:203`, send an explicit whitelist of parameters instead of `...p`.
  - At `service.ts:262`, require `action.status === "Started"` and match only on the successful result's `threadKey` or `url`.
- **Test (service.spec):** do a start with a forged `threadKey` and a failed or null-`threadKey` result, then upsert S. Expect no link, and expect `session_send` to return `denied`.

**F-2. Major: in-flight outcomes are reported falsely, which invites double sends (properties 5 and 9; AC-3, AC-8).**
- **Where:** `cancelRequests` at `service.ts:206`, called from `:214,225,247`, and the timer at `:128`. These reject a request the extension has already picked up with a definite `disabled`, `denied` or `timeout`. A late result is then discarded (`:149`). The test "cancels a queued action… ignores its late success" (`service.spec.ts:161-169`) asserts this behaviour: the extension delivered, but the record says `Failed: disabled`.
- **Effects:**
  - The agent caches a definite failure and retries under a new `clientRequestId`, so the message is sent twice.
  - The audit record is wrong.
  - The timeout message says "30 seconds" when the actual timeout is 50 or 60 s.
- **Fix:** in `service.ts`, mark requests as handed out in `poll()`. For those, cancellation or timeout should wait a bounded time (≤10 s) for the extension's verdict, otherwise return `unknown_delivery`. Set the extension's `deadlineAt` a few seconds before the plugin's timer. Accept late results into the action record.
- **Test:** change the expectation at spec:161 and add a timeout case.

**F-3. Major: unticking Trusted does not stop an action the extension already holds (property 1).**
- **Where:** `service.ts:222-225` only rejects the plugin-side promise. The extension never receives trust data or a per-request cancel (`bridge.ts:228-243`, `actions.ts:112-117`).
- **What happens:** founder unticks A while A's send waits for its page to load → the extension still types and submits it.
- **Fix:** when `trustedAgentIds` shrinks in `updateSettings`, bump `state.policy.disabledAt = now`. The existing epoch mechanism then aborts the action and refuses it at `actions.ts:93`. Optionally, also add `cancelledRequestIds` to the poll response.
- **Test (spec):** trust removal changes the effective `disabledAt`.

**F-4. Major: wrong text when the switch is turned off in Paperclip (AC-8).**
- **Where:** `service.ts:225` returns `disabled: Browser action permissions changed.` The AC requires `disabled: Agent actions are turned off.`
- **Fix:** choose the message from what changed: master off, provider removed (provider text), or trust removed (`denied` text).
- **Test:** call `updateSettings({policy:{enabled:false}})` while a request is pending and assert the exact text.

**F-5. Major: Diagnostics never records adapter failures (AC-9).** No code path logs `unsupported` from `session-delivery.ts:66,96`. Fix: report the failure to the background's diagnostics events from `paperclip-actions.ts:120` or `background.ts:501`, and add a test.

**F-6. Major: the action record and UI are missing contract fields (AC-12, FR-8).**
- `ActionRecord` has no session title, and the UI shows agent IDs instead of names (`ui/index.tsx:48`, `PaperclipTaskLinks.tsx:115`).
- A refusal is labelled `Refused: denied` (`tools.ts:208`) instead of `Refused: not trusted`.
- Text differs from the contract: the master label, the note, the empty state `No agent has acted yet.`, and unsupported providers are not greyed out (`ui/index.tsx:40,48`).
- Fix in `tools.ts`, `contracts.ts`, `ui/index.tsx` and `PaperclipTaskLinks.tsx`; add a UI spec.

**F-7. Minor: the confirmation window is under 15 s, and there is no separate 30 s page-load limit (AC-3, FR-6).** `paperclip-actions.ts:112` passes the frame a deadline of now + 15 s, and the frame spends up to 2 s of that waiting for the Send button. Page loading is limited only by the overall 50 s deadline (`:79-92`).

**F-8. Minor: a signed-out browser account still opens a tab (FR-2 edge).** `paperclip-actions.ts:68-72` checks `needsSignIn` only when the target is not the active account.

**F-9. Minor: rate limits and idempotency are not atomic in the database (property 4).** Atomicity relies on the in-process lock at `service.ts:32-36`, with check-then-put at `tools.ts:192-200` and `store.ts` using no transaction. This is correct only with a single plugin worker. Fix: a Postgres advisory lock, or a conditional insert in `store.ts`.

**F-10. Minor: some calls are never recorded (property 9).**
- Replays and duplicate rejections (`tools.ts:158-163`) and early validation failures (`:150-151`) create no action record.
- Reusing an expired key overwrites the earlier record, because records are keyed by `[agentId, clientRequestId]` (`:199,210`).
- Fix: key records by `action.id` and keep a separate idempotency index.

**F-11. Minor: a board user can act as a trusted agent on any task.** The non-agent path in `server/src/routes/plugins.ts:1095,1133-1145` passes a caller-supplied `runContext.issueId` to the plugin, and `validateToolRunContextScope` (`:846-880`) never checks it. The audit then attributes the action to the agent. Fix: resolve `issueId` from the heartbeat run for every actor.

**F-12. Minor, runtime risk: no check of the account shown in the page before typing (AC-10).** `session-delivery.ts:41-62` checks only URL, document and provider; the account rests on the extension's own records of which account owns each profile slot.

**F-13. Minor: a false "delivered" is possible.** `session-delivery.ts:70,109` tracks old messages by element identity. If React remounts an earlier user message with identical text, it counts as new. Fix: compare how many matching messages there are before and after.

**F-14. Minor: the founder cannot cancel one pending action.** Only the switches, unlinking or trust changes cancel, and they cancel everything (property 9).

**Properties that hold:**
1. **Default-off:** all switches start off (`service.ts:38`, `bridge-protocol.ts:12`). They are checked at admission (`tools.ts:176-191`), when the request is queued (`service.ts:113-122`), and in the extension before executing (`actions.ts:81,93`). The exception is trust at execution time (F-3).
2. **Task ID comes from the gateway:** `tool-gateway.ts:13371-13384,13505` and `tools.ts:144-147`. A link deleted mid-flight is caught by `actions.ts:98` and `bridge.ts:239`.
3. **Switch-off epoch, "off wins":** `actions.ts:114`, `service.ts:99-101,115`, `bridge-protocol.ts:56-58`.
4. **Rate counting:** failed, uncertain and cancelled admissions all count, per company and agent (`tools.ts:192-195`). Changing request IDs, tasks or sessions does not reset the window.
5. **Journal and no resubmission:** `actions.ts:82-88`, `session-delivery.ts:98-103`.
6. **Targeting:** URL, document root and frame checks at `session-delivery.ts:24-55,94-97,110-119`; frame and slot checks at `paperclip-actions.ts:82-86,102`.
7. **Privacy:** `actions.ts:72,97`, `paperclip-actions.ts:96`, `service.ts:51-53`, `bridge.ts:326,331`.
8. **Size bounds and untrusted output:** `tools.ts:151,207`, `actions.ts:65`, `session-delivery.ts:33`.
10. **Providers:** the four planned adapters exist (`session-delivery.ts:15-20`, `contracts.ts:10`), composers are found by selectors, and unsupported providers are refused (`tools.ts:190`).

## 4. Top three improvements

1. Fix F-1: drop agent-supplied `threadKey` on starts, whitelist bridge parameters, and link only successful starts.
2. Fix F-2: report `unknown_delivery`, never a definite failure, once the extension has picked up a request; and accept late results.
3. Fix F-3 and F-4: make trust removal and Paperclip-side switch-off bump the epoch, and return the exact contract texts.
