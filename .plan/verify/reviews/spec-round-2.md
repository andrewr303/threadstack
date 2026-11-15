# Independent specification review — round 2

Reviewer: `/root/spec_review`, independent of the lead and all implementation/repair workers.

**Current implementation verdict: PASS.** The bounded recheck closes S1–S9 and the additional
packet-count integration finding S10. No implementation blocker remains in the reviewed product
scope at the snapshot recorded in `spec-round-2.scope.json`.

**Acceptance/completion verdict: INCOMPLETE.** This pass does not assert that every original AC,
task gate, browser/provider journey, live service operation or cumulative test command passed.
It permits the next, different independent quality reviewer to assess the current implementation.

## Scope and freshness

Re-read the repaired product paths from round 1, their regression tests and the new runtime seams:
company-safe automatic-link projection; frame observation/settlement and detach wiring;
run-only hints; live provider URL/document checks; both-side action revocation and durable
idempotency; native websocket loss to host health refresh; real plugin stream-bus plumbing;
default Coordinator sidebar and task-chat plugin-tab outlets; authenticated invite query guards;
and first-party source-plugin autobuild/provisioning. Reconciled these changes against all fourteen
REQ/TASK acceptance contracts and retained the approved snapshot/fallback decisions.

The accompanying scope manifest records **172** current source/test/documentation/driver files
and SHA-256 hashes, relative to the approved extension snapshot or the fork import HEAD. It also
hashes the eleven retained execution artifacts. Inherited profile work unchanged from the approved
snapshot remains outside defect attribution. Browser-driver assertions were still being refined;
their report-time hash is recorded, but this review did not run that driver or use its eventual
results to certify product acceptance.

The product was frozen for this recheck except the narrow S10 packet guard repair, which was
independently checked after its final source freeze. The report does not silently reuse the
round-1 pass state: round 1 was needs-work and remains unchanged.

Two test-only changes landed while the report was being completed. The browser driver scopes
native sidebar targets and waits for the actual route before hostile-message assertions; its
syntax check passes, but its runtime result is not claimed here. The workspace-runtime fixture
now shadows an ambient host-installed `paperclipai` only in four config-writer tests and restores
PATH/temporary files in `finally`. Its original assertions and application source are unchanged;
the full diff was inspected. The author reports six selected repair/guard tests and the owning
typecheck passing. Both final files are included in the refreshed scope hashes; neither change
is presented as unchanged from the initial snapshot or as a reviewer-executed full-suite pass.

## Findings reconciled

| ID | Result | Current implementation and verification |
| --- | --- | --- |
| S1 | Closed | `pairingCode` uses eight cryptographic bytes and a fixed 32-character alphanumeric alphabet. The byte-domain regression checks compatibility with the extension validator. Plugin domain checks pass. |
| S2 | Closed | Delivery reads the live URL/document, checks before typing, while waiting, immediately before click and during confirmation. The original probe now refuses with `denied`; the independent explicit proof returns `refused:true`, `clicks:0` after navigation. All eleven delivery tests pass. |
| S3 | Closed | Existing coding links are projected only from server-verified same-company task provenance and current privacy-allowed sessions. Legacy company verification is bounded and stored. Server links use `auto`; persistent unlink tombstones survive restart and explicit board links can reauthorize. Projection and plugin regressions pass. |
| S4 | Closed | Live frame observations replace historical timestamps as proof of observation. Ten-second known-state heartbeats, five-second settlement, transient unknown-state handling, freshness expiry and immediate frame/tab detach are wired through validated worker/manager channels. Inventory and settled-event dispatch use this ledger; pending events are revalidated. Observation and bridge regressions pass. |
| S5 | Closed | A run-only hint performs the named company's run step and resolves affected task IDs, including scoped detail fallback, before targeted sync. Company selection and existing sync cursor ownership remain intact. Hint and existing sync tests pass. |
| S6 | Closed | State comments include bounded quoted title, provider/account labels and a company-relative `Open session` link. They retain deduplication and governed wakeups. Plugin regressions also prevent stale replay from rewinding newer observations. |
| S7 | Closed | Every normalized read envelope is marked `untrusted:true`; instruction warning/fenced content remains. Parameterized plugin tests cover all six read tools and role preservation. The direct marker probe also passes. |
| S8 | Closed | A reachable HTML/non-object responder becomes `unreachable/not_paperclip` and does not trigger helper startup. The direct injected probe returns zero start requests, and lifecycle regressions pass. |
| S9 | Closed | The native company websocket reports connection loss through the allowlisted host channel; the visible extension triggers immediate bounded health refresh while retaining normal 30-second healthy cadence and hidden-page silence. Connection/host checks pass. The lead reports a real 52 ms outage observation; that browser receipt is acceptance work outside this review's own execution claims. |

### S10 — additional repaired integration finding: receiver array limits

During the bounded recheck, the revised inventory packet builder honored the four-MiB byte budget
but could place more than 10,000 short removal keys in one packet. The receiver silently sliced
removals at 10,000, while the client deleted every packet key from its sent ledger. Such a packet
could leave ignored private rows permanently stored server-side.

This is now closed on both sides. The sender splits at 5,000 upserts, 10,000 removals, 50 automatic
links and 100 events, while retaining the shared UTF-8 budget. The receiver prevalidates **all**
collection types/counts before any write and rejects a malformed/oversized collection atomically;
it no longer silently slices an accepted packet. Independent checks passed eleven producer tests
and eight zero-side-effect receiver regressions, including the 20,001-removal and 6,001-upsert cases.

## Reviewer-executed validation

Raw logs/receipts are under `spec-round-2-assets/`; hashes are in the scope manifest.

| Execution | Actual result |
| --- | --- |
| Extension focused repair suite: automatic links, observations, delivery, lifecycle, connection, hints, existing sync, bridge client and integration runtime | 9 files / 66 tests passed |
| Plugin domain and UI tests, before the final narrow receiver guard | 2 files / 28 tests passed |
| Final sender packet-count/transport suite | 1 file / 11 tests passed; overlaps the earlier bridge-client checks |
| Final receiver oversized/malformed collection regressions | 8 passed, 28 unrelated tests skipped |
| Actual child-worker SSE plus scoped bridge-token/agent-denial and four-MiB boundary tests | 3 passed, 15 unrelated tests skipped |
| Native UI tab/sidebar outlets, host protocol and authenticated invite landing tests | 4 files / 52 tests passed |
| Original navigation reproduction | Exit 1 because the repaired adapter now refuses at its live-session check with `BridgeActionError: denied`; no longer reaches the old success assertion |
| Explicit zero-click navigation proof | Exit 0: `refused:true`, `clicks:0`, URL changed to `/chat/two` |
| HTML-responder and untrusted-marker probe | Exit 0: `unreachable/not_paperclip`, zero helper starts, `untrusted:true` |

One initial server test command used the nonexistent project filter `server` and selected no
projects. That startup failure is retained in `failed-project-selection.log` and is **not** a pass.
The corrected invocation ran from the server package and produced the three passing targeted tests.
No full suite, dependency installation, real service registration, user-key transfer or provider
action was performed by this reviewer.

## Requirement and acceptance boundary

The current code provides the planned repository/check/service/frame/bridge/tool/link/event/action/
hint/search/credential behavior, including the repaired integration seams. User approval of the
working snapshot is recorded as an explicit alternative to the original merge prerequisite; this
review does not claim that Threadkeeper main was merged or that historical load gates passed.

The deliberate view-switching fallback remains the delivered mode. Fused-sidebar ACs remain
unproven and must not be marked accepted. The lead's Chromium, authenticated and Edge runs are
separate original evidence and must retain their actual outcomes. Founder-present real-provider
send/start checks, live deployment/library preservation and actual launchd registration/persistence
remain separate prerequisites where not evidenced. The still-running root full test job must not
be reported as passed by reference to this review. Initial/native/type checks reported by authors
are not transformed into reviewer-executed full qualification here.

Proceed to one fresh independent quality review of the recorded source. The lead must reconcile
the final source/evidence hashes, actual test and acceptance results, and required task completion
gates before changing any remaining lifecycle status to done.
