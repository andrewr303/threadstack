# Approved-snapshot import portability — reproduced verification

The approved 443-file snapshot typechecks, passes all 1,713 tests and builds successfully from a
temporary nested `extension/` prefix. This run was performed on 2026-11-14; it is **reproduced current
verification**, not a reconstructed historical pre-implementation run and not a completion gate.

## Source and dependency identity

- Source: `/Users/andrew/dev/threadkeeper`, branch `main`, committed base
  `9078b2b261d2e12b8bc3230090f217b40e7c9b81` plus the approved working snapshot.
- All 443 source-file SHA-256 values matched `.plan/verify/baseline.json` before copying. Only those
  listed files were copied; every copied file matched its recorded hash before checks and afterwards.
- Temporary working directory for every command:
  `/var/folders/z3/_ntjy7xn1bx50p4g4jlfc31w0000gn/T/threadkeeper-import-parity-v1cy8rl3/extension`.
- Node `v24.22.1`; React `18.3.1`. `node_modules` is a symlink to the installed fork extension
  dependency tree. Its npm lockfile hash matches the approved snapshot. No installation was run.

## Actual commands and results

| Command | Environment additions | Exit | Observation / original log |
|---|---|---|---|
| `node node_modules/typescript/bin/tsc --noEmit` | none | 0 | No compiler output; `typecheck.log` |
| `node node_modules/vitest/vitest.mjs run` | none | 0 | 83 test files, 1,713 tests passed; `tests.log` |
| `node scripts/build-extension.mjs` | `TK_OUT_DIR=/var/folders/z3/_ntjy7xn1bx50p4g4jlfc31w0000gn/T/threadkeeper-import-parity-v1cy8rl3/parity-build`, `TK_STABLE_ID=0` | 0 | Isolated build succeeded; `build.log` |

The retained manifest has no `key` property and reports
`0.5.0 (build 20261114.073516-nogit)`. `nogit` is expected: this temporary copy deliberately has
no Git repository. Its path-derived extension ID is separate from the live browser's ID. The build
log's generic reload instructions were not performed.

## Preservation checks

After all commands, every original source-file hash and every temporary copy hash still matches
the baseline (443 each). Source branch/head are unchanged. The live manifest remains unchanged:

- SHA-256: `7490fdc8f0ec3993c73ac591f7a884c26c16cf5c57de5834d62e917a32b7745a`.
- Modification time, nanoseconds: `1794618008409849077`.

No command wrote to the live `.output/` folder or `/tmp/tk-build`. No application source was edited,
and no Git branch, commit, worktree, installation, browser/provider action or service was created.

## Evidence and limits

`setup.json` records the pre-check identity. `receipt.json` records exact argv/cwd/environment,
exit codes, test counts, before/after preservation checks and hashes of the original logs,
`manifest.json` and `build-info.json`. The temporary source and build are retained at the paths above.

This specifically proves nested-prefix portability of the accepted snapshot using the installed
matching dependency tree. It does not prove a fresh dependency installation, historical import
commit tree parity, integrated feature behavior, live browser acceptance, provider delivery,
service persistence or any plan/pipeline/load-gate completion status.
