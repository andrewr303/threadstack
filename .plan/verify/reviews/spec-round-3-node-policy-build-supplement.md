# SPEC-3 final integration addendum — both generated vendor roots

Reviewer: `/root/spec_review`. **Verification-tool-only specification verdict: PASS.** This is a
two-line correction to the previously reviewed generated-assets boundary, not a new product
scope or review cycle. No application, vendor, old report or sealed evidence file was changed by
this reviewer.

## Exact correction and hashes

The checker now recognizes the two generated directory entries whose parents are exactly
`<repo>/packages/paperclip-runner` or `<repo>/server`, and whose name is exactly `provider-assets`.
Both complete root paths are explicitly ignored by the existing root Git-ignore rules. This adds
the second distribution location materialized by the production build; it is not a name-wide,
recursive-prefix or arbitrary workspace exemption.

Only the explanatory comment and that exact-parent predicate changed. Replacing those two lines
with their prior values **in memory** reconstructs the complete previously reviewed checker:

| Checker source | SHA-256 |
| --- | --- |
| Current both-roots checker | `ae129fd200fbfe72890f04124973bfe0287a961a4725801049a116864e22aa9b` |
| Reconstructed prior runner-only checker | `fd78472832b38a3ca57ea601ab9d947f50aba5cba612178f61147cc7be9f43f3` |

The reconstructed hash matches the prior composed guidance-review inventory. All **185 other
reviewed files** independently match that inventory. The accompanying JSON rolls forward the
same complete **186-file** scope by updating only this checker hash. Engine/type checks,
workflow/Docker checks, required source fragments and the existing independent-extension
boundary remain byte-identical to the prior checker.

## Independent validation

The reviewer observed the actual root checker pass after the production build materialized both
vendor roots, and `node --check` exited 0. The original author RED/GREEN logs are retained and
hashed: the RED log names the generated server distribution's missing source-package engine.

The reviewer independently reran the supplied cases in a new temporary copy of the minimal
fixture using the actual current checker. Both canonical vendor manifests were present with
missing/different source engine declarations. No repository or parent-fixture files were edited;
the owned temporary copy was removed after execution.

| Fixture case | Actual result |
| --- | --- |
| Both canonical generated vendor roots | Exit 0 |
| Invalid engine in unrelated `packages/owned-source/provider-assets` | Exit 1, naming the owned manifest and required engine floor |
| That owned package with correct engine and Node types | Exit 0 |
| That owned package with incorrect Node types | Exit 1, naming the owned manifest and required types |

All four expected results matched. The source package checks remain active outside the two exact
generated roots, including a directory with the same basename elsewhere.

Machine receipt/current hashes: `spec-round-3-node-policy-build-supplement.json`. Independent
fixture stdout/stderr: `spec-round-3-node-policy-build-supplement-fixture.json`.

Proceed to the ordered independent quality addendum for these same two lines, then the lead's
final reconciliation. Prior reports and seals remain unchanged. Earlier unrelated full-suite,
environment, acceptance, provider, service and deployment gaps are not repaired or waived here.
