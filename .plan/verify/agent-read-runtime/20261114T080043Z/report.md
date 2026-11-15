# Actual process-agent browser-session reads

Result: **passed**, 2026-11-14 08:00:43 UTC, against the disposable source server
at `http://127.0.0.1:3217` and a separately owned, real UI-paired test extension.

The normal `process` adapter launched the synthetic Node worker through an
actual heartbeat. The product supplied its run-scoped API credential in the
normal process environment. The worker used the task checkout and HTTP tool
gateway APIs with the real budget, ownership, authorization and tool policy
checks. No credential values were captured or extracted from a browser.

Observed path:

1. Normal task checkout and run-bound gateway session.
2. Actual registered tool catalog discovery.
3. `sessions_list`, local-only `sessions_search`, `session_get`, and a bounded
   one-message `session_read` through the gateway and paired extension worker.
4. A source URL, thread key and message index accompanied the read, with
   `untrusted: true` preserved. The content was synthetic acceptance data.
5. Gateway session revoked, owned task deleted, and owned agent terminated.
   The normal permanent-delete guard retained its cost/audit history. No guard
   or database row was bypassed to force deletion.

Run: `feff9b3f-c4d3-4909-a647-7a4af8009328`.

The JSON receipts contain invocation IDs and the cited result. The `.mjs`
files are the corrected, task-specific probe scripts, not application changes.
The earlier failed attempt is retained separately: its temporary probe parser
missed the dispatcher's nested result wrapper after successful discovery and
list execution. Correcting that harness required no product source change.

This proves the real run-auth → gateway → plugin → extension read path. It does
not claim model generation, provider message delivery, or a production deploy.
