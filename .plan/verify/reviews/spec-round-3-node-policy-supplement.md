# SPEC-3 final integration supplement — generated Node-policy assets

Reviewer: `/root/spec_review`. **Verification-tool-only specification verdict: PASS.** The current
implementation pass remains in force. This reconciles one three-line checker change; it does not
reopen product scope, add a review cycle, or certify cumulative acceptance/full-suite completion.
The different quality reviewer must assess the same narrow delta after this supplement.

## Exact source boundary

`scripts/check-node-version-policy.mjs` now skips only the `provider-assets` entry whose parent
is exactly `<repo>/packages/paperclip-runner`. Root `.gitignore` explicitly excludes that generated
runtime directory. The new condition does not skip directories merely because they share that
name elsewhere, and it is separate from the existing independent-extension/npm exemption.

| Source | SHA-256 |
| --- | --- |
| Current checker | `fd78472832b38a3ca57ea601ab9d947f50aba5cba612178f61147cc7be9f43f3` |
| Checker reconstructed **in memory** by removing only the three added lines | `8f4337c5da04cb2096d0ca9f741ff7e3262b9641faba000eecf5fa5e6eb72ae8` |

The reconstructed value independently matches this file's entry in both SPEC-3 and QUALITY-2.
All workspace manifest engine/type checks, workflow/Docker checks and required source-fragment
checks are byte-identical to the reviewed checker. The change does not edit vendor assets or
application code.

After applying the separately reviewed driver-only supplement, all **183 other reviewed files**
match their current expected hashes in both source inventories. The driver's hash remains
`408bff8a995af3b3248fe0b637b092d3501f829d36ad8b9cfa1107554d0a7039`.
The accompanying JSON rolls forward the complete 184-file inventory without modifying any old
review, source inventory, report or seal.

## Actual validation

The reviewer observed the current root policy command pass and `node --check` exit 0. The original
author RED log identifies the generated Copilot distribution's missing repository engine field;
the GREEN log passes with the scoped exemption. These author originals are hashed and remain
unchanged.

The reviewer also independently reran four black-box cases in a new temporary copy of the author's
minimal source fixture, using the actual current checker. No repository or parent-fixture source
was changed, and the owned temporary copy was removed afterwards.

| Fixture case | Observed result |
| --- | --- |
| Canonical generated vendor assets with no source engine declaration | Exit 0 |
| Invalid owned engine under `packages/owned-source/provider-assets` | Exit 1, naming the owned manifest and required `>=24.11.0` floor |
| Same owned package with the correct engine and Node types | Exit 0 |
| Same owned package with invalid `@types/node` | Exit 1, naming the owned manifest and required `^24.0.0` types |

All four expected results matched. This demonstrates that the exception is the exact generated
boundary rather than a blanket same-name/source exemption.

Machine receipt and refreshed hashes: `spec-round-3-node-policy-supplement.json`. Independent raw
fixture stdout/stderr: `spec-round-3-node-policy-supplement-fixture.json`.

## Ordered next step and limits

Proceed to the independent quality supplement of these same three lines, followed by the lead's
final source/integration reconciliation. This pass concerns the verification boundary only. It
does not turn earlier root test failures or pending browser/provider/service/deployment criteria
into passes, and it does not alter the historical capture-provenance limits recorded in the
separate driver supplement.
