# QUALITY-2 generated-assets build addendum

Reviewer: `/root/quality_review`, after the ordered SPEC build supplement.

**Two-line verification-tool quality verdict: PASS.** Only the explanatory comment and the
exact-parent generated-directory predicate changed. The checker now exempts the `provider-assets`
entry directly under either the repository's `packages/paperclip-runner` or `server` directory.
Both roots already appear in `.gitignore`. This is not a name-wide, recursive-prefix or arbitrary
workspace exemption; owned source manifests remain subject to the same policy.

| Checker source | SHA-256 |
| --- | --- |
| Current both-roots checker | `ae129fd200fbfe72890f04124973bfe0287a961a4725801049a116864e22aa9b` |
| Prior runner-only checker reconstructed in memory by reversing exactly the two lines | `fd78472832b38a3ca57ea601ab9d947f50aba5cba612178f61147cc7be9f43f3` |

The reconstructed hash matches the prior quality guidance composition. Every other checker byte,
including engine/type requirements, workflow/Docker checks, required source fragments and the
separate extension boundary, remains unchanged. All **185 other reviewed files** match the prior
composition; the current **186-file** inventory matches the ordered SPEC supplement with no
unexplained drift.

## Independently executed checks

The actual current checker was copied into a fresh owned temporary fixture. Both canonical vendor
roots contained manifests lacking the source-engine field. Four black-box cases passed:

| Case | Observed result |
| --- | --- |
| Both canonical generated vendor roots present | Exit 0 |
| Invalid engine in unrelated owned source with the same directory basename | Exit 1, naming that owned manifest and required engine floor |
| That owned source with correct engine and Node types | Exit 0 |
| That owned source with incorrect Node types | Exit 1, naming that owned manifest and required types |

The actual root checker and its syntax check also exited 0. The owned fixture copy was removed;
no application source, vendor asset or author fixture was edited. Raw independent output and
current hashes are retained in `quality-round-2-node-policy-build-supplement.json`.

The original author RED log identifies the generated server distribution's missing source-package
engine; its GREEN log passes. Those originals were inspected and hashed, not rewritten or
relabeled as reviewer executions. Previously protected capture/seal hashes remain unchanged.

The implementation quality pass and prior evidence/provenance limits stand. This addendum is a
bounded verification-tool correction, not a new product review cycle or a full-suite, hosted-CI,
browser, provider, service, deployment or completion pass. Proceed to the lead's final integrity
reconciliation and handoff without converting earlier failures or interruptions into successes.
