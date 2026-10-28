# Threadkeeper Acceptance & Verification Report

Generated: `2026-10-28T07:09:05.301Z`
Extension Build: `/home/user/threadkeeper/.output/chrome-mv3`

## Summary of 10 Acceptance Gates

| ID | Gate | Real-Browser / Local Contract Status | Gated Live External Smoke Status | Key Metric / Proof |
|---|---|---|---|---|
| `QUIET-01` | Zero-Presence Closed State | **PASS** | `NOT_VERIFIED` (gated per §14) | 0 injected nodes on ChatGPT & Claude; exact PNG byte equality (`Buffer.compare === 0`) vs clean no-extension browser across streaming & SPA navigation; 0 leaked secrets in bundle |
| `OPEN-02` | Deliberate Invocation, Escape & Restoration | **PASS** | `NOT_VERIFIED` (gated per §14) | Single `#threadkeeper-overlay-root`, inner modal closes on first `Escape`, outer overlay closes on second `Escape`, restoring `scrollY=320`, `#prompt-textarea` focus, and unsent draft text |
| `PARITY-03` | Overlay & Full-Page Parity + Evidence Margin | **PASS** | N/A (local extension surface) | Reconciled counts (`9 threads · 9 filed · 0 unfiled`), all 5 Evidence Margin locations present, clickable `m2` citation drawer, List/Kanban/Project Cards views, `/` + `j`/`k` shortcuts, `1440×900` (light/dark), `1280×800`, `700×800` zero horizontal overflow |
| `CAPTURE-04` | Authorized Passive Capture & Monotonicity | **PASS** | `NOT_VERIFIED` (gated per §14) | Live DOM capture verified in IndexedDB (`chatgpt:acct_chatgpt_primary:ws_personal:conv_daydock_live_host:main`, `coverage=partial`, `messages=3`), monotonic `sourceRevision` increments, higher coverage never downgraded |
| `IMPORT-05` | Lossless Import/Export & 652-Thread Fixture | **PASS** | N/A (local file import/export) | ChatGPT 652-thread branching `conversations.json` fixture + Claude export + Portable JSON & Markdown handoff preserving manual title overrides & notes (`manualOverridePreserved=true`) |
| `ISOLATE-06` | Multi-Account, Workspace & Branch Isolation | **PASS** | N/A (local composite key & guard) | 5-part composite key `provider:accountId:workspaceId:sourceConversationId:branchId` separating branches and accounts in live IndexedDB + `OPEN_ORIGINAL_THREAD` `account_mismatch` guard |
| `AI-07` | Grounded Enrichment, Worker Auth & NL Organize | **PASS** | `NOT_VERIFIED` (gated per §14) | SHA-256 Bearer token hash auth (`AUTH_TOKEN_HASHES_JSON`) + `UsageQuotaDO` unconditional fail-closed quota enforcement, `/v1/enrich-thread` client-worker parity, `422` `title_only` guard, negative exclusion clause (`negativeClauseExcludedInUi=true`) + 1-click Undo |
| `SEARCH-08` | Hybrid Local + Vector Search & Provenance | **PASS** | `NOT_VERIFIED` (gated per §14) | Real-browser search (`hits=5`) with match reasons & supporting quotes, RRF lexical+vector fusion, dimension/model validation, rerank index fallback, and default `isSyntheticBenchmark` exclusion |
| `LIFE-09` | Lifecycle Hygiene, Cascade Delete & Tombstones | **PASS** | N/A (local extension lifecycle) | MV3 permissions (`storage`, `unlimitedStorage`, `alarms`, `scripting`, `sidePanel`; no localhost origins), atomic tombstone transaction in `applySummaryEnrichment`, cascade delete across 6 stores, zero auto-open on fresh tab |
| `PERF-10` | 10,000-Record Warm-Open & Local Search Latency | **PASS** | N/A (local 10k benchmark) | Packaged-extension Chromium IndexedDB 10k: Warm-open `p50=114.5ms`, `p95=218.9ms` (<= 500ms); Local search `p50=3.9ms`, `p95=5.6ms` (<= 150ms) |

## Evidence Artifacts

- `evidence/acceptance/acceptance-ledger.json`
- `evidence/acceptance/perf-10-benchmark.json`
- `evidence/acceptance/quiet-01-chatgpt-baseline.png` & `evidence/acceptance/quiet-01-chatgpt-closed.png`
- `evidence/acceptance/quiet-01-claude-baseline.png` & `evidence/acceptance/quiet-01-claude-closed.png`
- `evidence/acceptance/open-02-overlay.png` & `evidence/acceptance/open-02-restored.png`
- `evidence/acceptance/parity-03-manager-1440-light.png` & `evidence/acceptance/parity-03-manager-1440-dark.png`
- `evidence/acceptance/parity-03-manager-1280.png` & `evidence/acceptance/parity-03-manager-700-narrow.png`
- `evidence/acceptance/parity-03-organize-modal.png`
- `evidence/acceptance/life-09-restart-closed.png`
