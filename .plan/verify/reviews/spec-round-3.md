# Independent specification review — round 3

Reviewer: `/root/spec_review`, independent of the lead and implementation/repair workers.

**Current implementation verdict: PASS.** The bounded final recheck closes the specification
impact of QUALITY-1 Q1/Q2 and includes the new same-auth SSE transport and document-boot handshake.
No new material implementation defect was reproduced in this scope. The prior S1–S10 dispositions
remain closed; unchanged paths were not subjected to another broad review.

**Acceptance/completion verdict: INCOMPLETE.** This report does not certify every original AC,
task completion gate, full fork suite, browser/provider journey or deployment. It permits the next
ordered, different independent quality recheck of this exact current source.

## Scope and freshness

`spec-round-3.scope.json` records **184** current source/test/documentation/driver files and their
SHA-256 hashes, reconciled against the approved extension snapshot and import HEAD. It identifies
the **22** changed files since the final SPEC-2 inventory and hashes the seven retained execution
artifacts. The review was limited to those changes and their existing contract/boot dependencies:

- Plugin read-result projection, privacy races and serialized inventory normalization.
- Expired request-ID admission ordering, minute/hour history and delayed completion semantics.
- Shared company live-event viewer filtering, ordinary authenticated HTTP SSE route, bounded
  delivery/keepalive cleanup, application mounting and ordered shutdown.
- Verified-host-only frontend transport replacement, the existing live-event pipeline, early
  authenticated host-message buffering and a fresh hello retry window per iframe document.
- API documentation and the QA-only `TK_E2E_OUT` workspace-runner redirect, which leaves its
  default destination unchanged and allows the lead to preserve inherited baseline images.

The production scope was frozen for this review. Browser-driver assertions/evidence are inventoried
at report time but were not used to manufacture a browser acceptance pass. Inherited profile work
unchanged from the approved snapshot remains outside defect attribution. No application source,
Git state, dependency, live service, user account, model key or provider page was changed by this
reviewer.

## Reconciled repairs

### Q1 — private nested data in read results: closed

All six reads now pass through explicit scalar/leaf schema projections. Context output includes
only approved flags and public passages whose thread keys remain in the company's inventory;
unknown nested `threads`, analysis containers and arbitrary result fields are not copied. Session
metadata/search excerpts/get analysis retain their known public schemas; sibling/linked references
are individually revalidated. Final normalization is serialized with that company's inventory
mutations, so a remove-before-result race cannot interleave inside the final projection.

The original independent quality probe was executed unchanged against current source and exits 0:
`topLevelPassages: []`, `leakedPrivate: false`. The plugin suite includes five execution-race
regressions covering context, list, search, related and get, with retained public citations/schema
fields and no private marker. All 44 current plugin tests pass.

### Q2 — expired request-ID rate-history ordering: closed

An expired duplicate row is removed **inside successful serialized admission**, immediately before
its fresh reservation is inserted. Permission, trust, task scope, provider and rate checks precede
that removal. Ordinary completion/link updates still preserve the original admission order; the
repair does not reorder history by completion time or `updated_at`.

The original independent quality probe now exits 0: its first send is delivered and its second
send one second later is refused with `rate_limited: Try again in 59 seconds.` Current plugin
regressions cover minute ordering, the hourly window beyond 500 historical rows, and a late
completion that must not outrank a newer admission.

The lead's separate production-store receipt records the same three cases against MemoryStore
and actual DatabaseStore/PostgreSQL through the host SQL boundary: 6/6 passed, fixture cleaned up.
An original copy and hash are retained here as an **author-owned inspected receipt**. This reviewer
did not rerun those database mutations and does not label that matrix reviewer-executed.

## Same-auth live transport and boot dependency

The new HTTP endpoint is mounted within the existing authenticated API. It calls the normal
company access guard, permits full agent keys only for their own company, and rejects restricted
keys/run JWTs. It introduces no authentication cookie changes, bearer URL credentials or tickets.
The SSE adapter and native WebSocket both call `createCompanyLiveDelivery`, which owns the same
task/run/case/project/skill checks, revocation reads, transcript redaction, bounded queue and toast
projection. Extracting that viewer function did not create a second permissive implementation.

The SSE response tracks its network buffer, subscribes only to the chosen company, removes its
listener/disposes delivery on close, and clears its connected-only keepalive. Application and
ordered server shutdown close owned streams. Its keepalive performs no idle SQL scans. This
unidirectional transport deliberately uses default company delivery and does not claim native
bidirectional transcript-interest negotiation.

The frontend retains ordinary WebSockets. Only an exact origin/window/allowlist-verified extension
handshake can select one credentialed same-origin EventSource after the hosted socket fails.
Replacing a channel disposes the old one; stale callbacks are ignored, and withdrawing host
verification closes the SSE channel. SSE messages enter the existing live-event processing path.
The normal reconnect/visibility lifecycle remains the owner of connection recovery.

Early valid hello/navigation messages are bounded and authenticated before buffering. Effect
remounts replay the hello without stale navigation. Each later full iframe document starts a new
bounded hello-retry window, covering login/full-document boot without reloading merely to acquire
the handshake. The corresponding UI and extension regressions pass.

## Reviewer-executed validation

Raw originals are retained in `spec-round-3-assets/`; their hashes and provenance are in the scope
manifest. Commands used the already installed runtimes from the respective package directories.

| Execution | Actual result |
| --- | --- |
| Current browser-sessions plugin domain/UI suite | 2 files / 44 tests passed |
| HTTP SSE, existing native WebSocket, viewer/privacy delivery and delivery-cost tests | 4 files / 44 tests passed |
| Hosted transport, early boot channel, host protocol and live-update recovery tests | 4 files / 59 tests passed |
| Extension persistent-frame/document hello tests | 1 file / 6 tests passed |
| Original QUALITY-1 context privacy reproduction | Exit 0; private marker absent |
| Original QUALITY-1 expired-ID rate reproduction | Exit 0; second send rate-limited after 1 second |

The HTTP route tests use actual loopback HTTP servers with controlled actor/database fixtures;
they prove route admission, shared viewer projection, company isolation, revocation, cleanup and
idle behavior under those fixtures. They do not themselves prove the real browser's login cookie
state. The original quality probes use synthetic in-memory service data and perform no provider
submission. No full suite or browser driver was duplicated by this review.

## Remaining evidence and ordered next step

The lead reports current Chromium acceptance covering the authenticated framed HTTP stream,
matching live updates without document reload and an active service worker. Edge and remaining
browser evidence were still being finalized. Those original rounds, screenshots, recordings and
capture provenance remain separate acceptance evidence; this code review does not turn a reported
or pending run into a passed case.

The root full test process still carried its earlier failures at this report's review point.
Focused fixes/rechecks and cumulative typechecks must retain their actual scope and outcomes;
neither SPEC-2 nor this pass means that full process passed. Founder-present real-provider
send/start, actual launchd registration/persistence, live deployment/library preservation and
withheld fused-sidebar behavior remain separate unproven criteria where not explicitly evidenced.
No original AC or required completion gate is waived by this report.

Proceed to the fresh ordered QUALITY-2 bounded recheck of Q1/Q2 and this transport/boot scope.
The lead remains responsible for final source/evidence reconciliation, the lightweight integration
check, accurate requirement status and any explicitly authorized external action.
