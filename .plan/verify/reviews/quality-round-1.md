# Independent quality review — round 1

Reviewer: `/root/quality_review`, independent of all implementation and spec-review authors.

**Round verdict: NEEDS WORK.** Two material defects were reproduced in the reviewed starting
implementation. Q1 received a narrow repair during this review and its original reproduction now
passes. Q2 remains a required repair at this report's decision point. No current implementation
quality pass or all-AC completion is certified here.

**Acceptance and cumulative qualification: INCOMPLETE.** Browser journeys, the full fork test
process, real provider delivery, launchd persistence and live deployment remain separate evidence.

## Scope and review method

The review followed the passing specification round 2 and its 172-file manifest. It examined the
changed company/actor/token boundaries, the gateway's trusted task identity, read-policy
provisioning, browser and server action admission/idempotency, privacy revalidation and output
normalization, credential consent/readback and feature-call memory boundaries, fixed helper
commands, guarded builds/deploys, host messages, observations, and native UI integration changes.
This was a bounded quality pass, not an exhaustive audit of unchanged upstream Paperclip or of the
founder's inherited multi-profile snapshot.

Direct reads included the plugin service/worker/store/tools, route and SDK company-scope delivery,
the new policy identity/service and policy/gateway diffs, extension bridge/action/credential/runtime
modules, delivery and manager action boundaries, host/observation protocols, safe check scripts,
and relevant UI integration diffs. The report-time hash inventory is retained separately; it does
not assert that every line or every possible branch in that inventory was executed.

No application source, Git state, dependency installation, real account or running lead-owned
process was modified by this reviewer. Reproductions used synthetic values and an in-memory
company-scoped store. The store ordering used by Q2 matches the production SQL's original-row
creation ordering, but the reproduction itself did not execute against PostgreSQL.

## Q1 — Major: removed private session survives in nested context data

**Finding source:** `packages/plugins/plugin-browser-sessions/src/tools.ts`, specification-round-2
hash `24503e1f08957fcd0eeea6c8a87dc4a3d45bf93e85a68a7dd8a0795ecc6f7932`.

At the reviewed starting source, `normalizeRead()` filtered only the root `passages` array for
`sessions_context`, then returned `{ ...value, passages: allowed }`. The browser's actual context
shape also contains `threads[].thread` and nested `threads[].passages`. Removing a newly private
session from the company inventory before result normalization removed its root passage but left
its private title and transcript in that nested representation.

The retained synthetic probe invokes the real `BrowserSessionsService.executeTool()`, removes the
session while its browser response is in flight, and returns both real context representations.
It printed `topLevelPassages: []` and `leakedPrivate: true`; the explicit privacy assertion failed.
This contradicts the privacy boundary even though the extension also performs an earlier privacy
check: the server must not reintroduce a source it already knows has been removed.

**Repair observed during this review:** the author replaced raw result spreading with explicit
leaf/schema projections, removed unknown nested containers, revalidated sibling/linked keys, and
serialized final normalization with company inventory mutations. The original reviewer probe now
exits 0 with `topLevelPassages: []` and `leakedPrivate: false`. The reviewer also executed the five
new private-removal/normalization regressions: all five passed, with 36 unrelated tests skipped.

This narrow repair is independently observed, but it changed the prior spec snapshot. A fresh
spec review must precede a final quality pass. The original failing artifact remains retained.

## Q2 — Major: expired client-ID reuse bypasses rate-history ordering

**Finding source:** `packages/plugins/plugin-browser-sessions/src/tools.ts` action admission and
per-session history lookup; `src/store.ts` `put()` and `list()`.

The action API permits an expired client request ID to be reused after its 24-hour idempotency
window. `Store.put()` overwrites that record's JSON `createdAt`, but both store implementations
preserve the original row/order creation value. The production SQL uses `ON CONFLICT ... DO
UPDATE` without replacing `created_at`, and `list()` orders by that original `created_at`.

The per-session minute check asks for only the first admitted record in that order. After an
expired, older client-ID record is reused, this query can select a different older action instead
of the just-admitted send. A second send one second later is therefore allowed. The agent-hour
history's bounded query uses the same ordering and needs the same logical admission semantics.

The retained probe seeds two expired admitted actions in the real service's `MemoryStore`, reuses
the older ID, advances its injected clock by one second, and sends with a new ID. Both results were
`Message delivered.`; the assertion requiring `rate_limited` failed. The browser guard supplies
idempotency/policy defenses but has no independent minute/hour rate counter to restore this limit.

**Required repair:** give a newly admitted reuse a new logical history position, or order bounded
history by the authoritative logical admission timestamp. One narrow option is deleting an
expired duplicate inside serialized admission immediately before writing its new reservation,
so a fresh insert receives fresh creation order. Do not simply order by `updated_at` or refresh
creation order on every update: delayed completion/link updates of older actions would then hide
newer sends in the same way. Add the exact expired-ID reuse regression and preserve pending and
within-24-hour duplicate behavior. Qualify production store semantics as appropriate.

## Other reviewed boundaries

No additional material defect was reproduced in this bounded pass. In particular:

- The scoped plugin API retains board/actor checks and authoritative company resolution; its
  private bridge header is forwarded only to this plugin. SDK `getData` overwrites caller params
  with the authorized host company, and action context checks the board's resolved company.
- Read grants contain only the six browser read tools and yield to explicit blocks, approval
  requirements and restrictive profiles. Action tools retain gateway policy plus plugin/browser
  consent, task-link authority and exact account/frame delivery checks.
- Helper lifecycle messages select fixed registered operations, not page-provided paths/argv.
  Safe extension checks force the isolated output and path ID; deliberate deployment requires an
  explicit target. No real helper install or deployment was performed by this reviewer.
- Linked model-key values are resolved into a feature-call copy; persistent settings retain
  reference/consent metadata. Source/consent are rechecked after reads, successful exact readback
  precedes local deletion, and local revocations survive unavailable remote configuration.
- Host messages validate the exact sender window, origin and protocol/path. Current observation
  freshness and frame detach feed an ephemeral ledger rather than treating stored history as live.

These observations are scoped source review, not additional runtime acceptance or an assertion
that every path in the modules passed a new test run.

## Reviewer-executed evidence

Original copies and hashes are in `quality-round-1-assets/` and `quality-round-1.scope.json`.

| Execution | Observed result |
| --- | --- |
| Context remove-before-normalize probe against starting source | Exit 1; root passages empty but private nested title/transcript retained |
| Same original context probe after author's repair | Exit 0; private marker absent |
| Focused new context/normalization regressions | 5 passed, 36 unrelated skipped |
| Expired-ID rate-history probe | Exit 1; two delivered sends one second apart instead of minute-limit refusal |
| `ult-debugger` triage of the two Node assertion logs | No recognized crash format; complete assertion logs were inspected directly and retained; no parser success is claimed |

## Freshness, unreviewed work and next step

The browser driver changed during the review, and Q1's product/test repair changed `tools.ts` and
its domain tests. These drifts are explicit in the report-time manifest. The parent has separately
authorized a same-auth HTTP SSE fallback for a verified embedded host after actual ordinary-tab
versus iframe websocket observations. That new transport is **not reviewed or accepted in this
round**; it must join the next source scope.

Finish Q2 and the new transport, run affected checks, obtain the fresh ordered spec review, then
request the bounded quality recheck of those repairs and final scope. Do not use this report or
the earlier spec pass to mark every TASK, the root full suite or browser acceptance complete.
