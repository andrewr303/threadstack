# SPEC-3 final integration supplement — literal lifecycle guidance

Reviewer: `/root/spec_review`. **Bounded specification verdict: PASS.** The final current-guidance
scan also passes. This related static-check repair preserves product behavior. It is not a new product
review cycle, browser capture or cumulative completion pass. A different quality reviewer must
assess the same delta after this supplement.

## Exact reviewed change

The supplied six-file patch was independently reversed **in memory** against current files. Every
after-range matched, and all six reconstructed before hashes/current after hashes matched the
author's declared values. The two new verification-file preimages also match Git HEAD; all four
application/verification preimages match the original production-build-before source inventory.

- The existing exact allowlist adds only `pnpm paperclipai service start` and
  `pnpm paperclipai service logs`. Both are complete literal lifecycle commands with no argument,
  path, identifier, placeholder or interpolation. The parser/scanner portion is byte-identical
  to its original source. Two positive and three suffix-negative regressions were added.
- Root `.gitignore` adds only the root `.acceptances` directory exclusion. Historical local
  capture artifacts remain on disk; no evidence was deleted or rewritten. The unchanged guard
  still includes tracked files even when an ignore rule matches, as its existing regression tests
  verify. This is not a general source-directory exemption.
- `PaperclipConnection.tsx` places the same two strings in private literal `command` properties
  and substitutes them into its existing JSX text. This uses the guard's already supported
  complete-literal representation; it adds no command execution or argument-bearing string.
  Buttons, handlers, lifecycle effects and network paths are unchanged.
- The view test adds exact visible-copy/button checks for the two affected status states.
- REQ-4 changes only inline-code formatting in its UI-copy table. All **11 acceptance-criterion
  lines remain byte-identical**. The platform context's active generic CLI reference now uses the
  direct source-exec form. Its before-image is explicitly reconstructed from that single line;
  this review does not invent an original capture for the planning file.

## Independent behavioral and guard checks

The reviewer executed the current guidance suite: **45 tests passed**, including the full current
offender scan, both newly allowed literals, all three new forbidden suffix cases, and the existing
parser/scanner adversarial cases. The current view suite also passed: **eight tests**.

A later final scan, after new unrelated analysis records appeared, returned 44 passes and one
failure. The offenders were copied historical DOM/guard examples in two unsealed classification
artifacts under the final evidence directory. Their owner moved only those task-owned copies
into ignored supporting acceptance evidence. The reviewer independently verified that both moved
copies match their original temporary-file bytes, all 11 protected capture/seal hashes remain
unchanged, and no source policy/parser change was made. The failed scan is retained. The subsequent
reviewer-executed full guidance scan passes **45/45, zero current offenders**. This preserves the
failure-to-resolution history without relaxing the scanner or rewriting sealed captures.

Separately, the reviewer compiled the preserved old component and the current component in memory
with the installed bundler, then server-rendered both through the same installed React renderer.
The rendered HTML is **exactly equal** for both `stopped` and `start_failed`, including status text,
button labels and complete manual guidance. No browser, helper, service or network action was
performed by this comparison. The retained probe records the independently checked old/current
component hashes:

| Component source | SHA-256 |
| --- | --- |
| Preserved before source | `41ca3e1123dd4b96fdd160ac3c5b64a1387ed45e5cf4ca9c621086d95e75f891` |
| Current representation | `982956d519009febb6e627aef3637812634467edf5a3382c35cb392baa36563f` |

The exact patch plus this rendering comparison supports retaining existing captures for unchanged
product flows while declaring the representation change. It does not relabel any original capture
as a new execution of the current source.

## Current source composition and evidence preservation

The prior composed 184-file scope is retained with the component and its test updated, and the two
new verification paths added, producing **186 current source/test/documentation hashes**. All
other **182 prior files** match their previously composed hashes, including the separately
reviewed driver and generated-assets checker. The two planning-file hashes are recorded separately
as context changes. No original review manifest was rewritten.

The reviewer independently compared all eight affected historical DOM captures and three seal
files with the retained before-preservation inventory: **11 checked, all hashes unchanged**.
Ignoring the local artifact directory is not evidence editing. Historical capture-time driver-hash
limitations from the earlier supplement remain explicit and unchanged.

Machine receipt and current composed hashes: `spec-round-3-guidance-supplement.json`. Reviewer logs
and old/new rendering output: `spec-round-3-guidance-supplement-assets/`. The rendering probe is
`spec-round-3-guidance-render.probe.mjs`.

Proceed to the ordered independent quality supplement of this same six-file delta, then the
lead's final source/integration reconciliation. Earlier unrelated environment, full-suite,
provider, service, deployment and acceptance gaps are neither repaired nor waived by this pass.
