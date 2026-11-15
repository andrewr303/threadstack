# Independent quality review — round 2

Reviewer: `/root/quality_review`, independent of all implementation/repair authors and the
specification reviewer. This bounded recheck began after the current SPEC-3 implementation pass.

**Current implementation quality verdict: PASS.** Q1 and Q2 are closed. No additional material
defect was reproduced in the repaired read/action boundaries or the new live transport/boot scope.
The final 184 source hashes match the SPEC-3 snapshot with **zero drift**.

**Acceptance/completion verdict: INCOMPLETE.** This source-quality pass does not certify the full
fork test run, every original AC, browser/provider acceptance, launchd persistence or deployment.
The lead must retain their actual results and remaining gates separately.

## Scope and independence

The prior bounded quality pass remains unchanged at `quality-round-1.md`. This round revisited
its two reproduced defects and the additional source introduced since that review: shared
company live-event delivery, authenticated HTTP SSE, application/shutdown mounting, the verified
host's frontend channel selection, early host boot messages and per-document hello retries.
The QA-only workspace-runner output redirect and API documentation were also checked.

The scope was reconciled against the current SPEC-3 manifest and the earlier quality snapshot.
Unchanged areas already reviewed in round 1 were not subjected to a new broad defect hunt.
No application source, Git state, dependencies, actual services, user settings, provider page,
authentication cookie or model key was changed by this reviewer. All reviewer tests were focused
on the repairs and transport; no whole-repository suite or browser journey was duplicated.

## Q1 — nested private read data: closed

The read normalizer no longer merges arbitrary browser result objects into tool data. Context
returns allowlisted scalar flags and inventory-validated passage leaves. List/search/related/get
use explicit summary, excerpt and analysis schemas; sibling/linked references are individually
revalidated. Unknown nested containers do not cross the boundary. Final normalization is serialized
with that company's inventory mutations.

The original quality probe was executed unchanged: a session removed before its pending result
normalizes now produces `topLevelPassages: []` and `leakedPrivate: false`, exit 0. The five actual
execution-race regressions also pass and preserve the intended public citations/schema fields and
untrusted-data warning. The original failing probe/log remains in the round-1 assets.

## Q2 — expired client-ID admission order: closed

The implementation deletes an expired duplicate only inside successful serialized admission,
after trust, task, provider, policy and rate checks and immediately before writing its new durable
reservation. This gives the new admission a new creation position in both store implementations.
Ordinary completion and delayed linking continue preserving admission order; the repair does not
sort by completion time or `updated_at`.

The original quality probe now exits 0: the first send is delivered, then a second send one second
later returns `rate_limited: Try again in 59 seconds.` Focused minute, hourly-history-after-501-rows
and delayed-completion regressions pass. Existing within-window idempotency remains distinct from
a new admission after the window expires.

The inspected production-store receipt reports the same three cases against MemoryStore and the
actual DatabaseStore/PostgreSQL host boundary: 6/6 passed, synthetic fixture cleaned up. Its original
copy and hash are retained as **author-owned evidence**. This reviewer did not rerun those database
mutations and does not present them as reviewer-executed PostgreSQL verification.

## Same-auth live transport and lifecycle

- The HTTP stream is mounted inside the existing authenticated API and calls the normal company
  access guard. Full agent API keys are restricted to their own company; restricted keys and run
  JWTs are refused. There are no new auth cookies, URL bearer credentials or connection tickets.
- SSE and WebSocket share `createCompanyLiveDelivery`. The extraction retains the existing viewer
  checks for task/run/case/project/skill data, revocation reads, transcript redaction, toast
  projection and bounded delivery/backpressure. The new route does not maintain a second,
  permissive viewer implementation.
- The active HTTP connection owns a network-only keepalive, subscription and cleanup. Close/error
  releases the listener and delivery; application and ordered server shutdown close streams.
  Passive connections release HTTP idle-admission work, and event authorization remains covered
  by the existing tracked delivery lifecycle. No idle database scan was introduced.
- Ordinary browser clients keep WebSockets. Only the exact origin/window/allowlist-verified
  extension handshake permits replacement of a failed hosted socket with one credentialed,
  same-origin EventSource. Replacement disposes the prior channel, ignores stale callbacks,
  closes on verification withdrawal and enters the existing message/recovery pipeline.
- Early hello/navigation buffering authenticates the sender before retaining a bounded latest
  message. Each new iframe document obtains its own bounded hello-retry window, covering slow
  boot/login/full navigation without forcing document reload merely to establish the handshake.

The HTTP stream deliberately provides default authorized company delivery. It does not claim
bidirectional transcript-interest negotiation, and the frontend does not pretend an EventSource
can send WebSocket control messages.

## Reviewer-executed checks

Raw originals, original probes and hashes are retained in `quality-round-2-assets/` and
`quality-round-2.scope.json`.

| Execution | Actual result |
| --- | --- |
| Q1/Q2 plugin execution-race and admission-order regressions | 1 file / 8 passed, 33 unrelated skipped |
| HTTP SSE, native WebSocket and shared viewer/delivery/backpressure tests | 4 files / 44 passed |
| Hosted transport, early boot, host protocol and existing live-update recovery tests | 4 files / 59 passed |
| Persistent iframe/document handshake regressions | 1 file / 6 passed |
| Original Q1 private-context probe | Exit 0; private marker absent |
| Original Q2 expired-ID rate probe | Exit 0; second send refused after one second |
| Workspace QA runner syntax | `node --check` exited 0; optional `TK_E2E_OUT` leaves its default destination unchanged |
| Final source reconciliation | All 184 source hashes match current SPEC-3; zero changed/missing files |

These are **117 focused passing tests**, with scope and skips preserved. They are not an additional
full plugin/server/UI/root suite. Route tests use real loopback HTTP with controlled actor/database
fixtures; they do not themselves prove the real browser's login state. The two original probes use
synthetic in-memory service state and make no provider submissions.

## Remaining proof boundary and handoff

The lead's Chromium/Edge rounds, screenshots, recordings and native browser observations remain
separate original acceptance evidence. This reviewer did not execute those journeys or convert
author-reported browser results into independent browser passes. The ongoing root full test job
must retain its earlier failures and actual final result; focused repairs and this review do not
make that execution green retrospectively.

Founder-operated real provider send/start checks, actual launchd registration/persistence, live
deployment/library preservation and withheld fused-layout behavior remain separate where not
explicitly evidenced. Neither this report nor SPEC-3 waives original ACs or task completion gates.

The current implementation may proceed to the lead's final source/evidence reconciliation and
lightweight integration check. Keep lifecycle status and any external-action request tied to the
actual validation and authorization, not to this quality pass alone.
