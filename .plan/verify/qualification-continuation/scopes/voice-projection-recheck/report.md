# Voice and native projection qualification

**PASS: both unchanged files, 188 tests, zero failures or skips.** No repository source was edited.

The interrupted general-shard-3 run recorded these failures, all reaching approximately the existing 15-second test deadline:

- Voice: `retains both spoken sides once on the public call task and preserves quarantine` (15,006 ms).
- Voice: `reconciles a provider hangup even without a browser end request` (15,002 ms).
- Projection: `promotes the comment exactly once after the recovered run is projected terminal` (15,185 ms).

That interrupted log has no final failure stack/summary, so the exact cause is not established. Its original outcomes are retained in `original-outcomes.txt`. Routed through the installed ult-debugger TypeScript specialist; saved triage was used only to locate original evidence, not to treat expected negative-test provider errors as defects.

## Verification

1. The exact three cases passed unchanged: **3 passed**, 185 excluded by the explicit name filter (not qualified by that run). Durations 2,434 / 1,325 / 3,735 ms.
2. Because voice reconciliation uses a suite-shared database with earlier fixtures and projection uses coordinator recovery, both complete files were then run serially: **188 passed, zero skipped**, 53.60 seconds. Voice's earlier failed cases passed in 882 / 438 ms.

Both runs used `/tmp/tk-continue/runtime/run-qualification.py`, selecting Node 24.22.2, real owned embedded PostgreSQL, synthetic test credentials and the existing credential-denying sandbox. No `--ps-compat` was injected. Voice transport remains the existing mocked Speko provider, not a real account. Deadlines, assertions, retry settings and test selection were not weakened. Source hashes before and after match exactly in `receipt.json`.

This closes these two files' local qualification gap. It does not convert the interrupted broad run into a pass or establish its environmental cause. Runtime receipts and complete raw logs are copied beside this report.
