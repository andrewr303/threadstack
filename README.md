# Threadkeeper — Quiet AI Conversation Archive & Workbench

Threadkeeper is a local-first Chrome and Chromium Manifest V3 browser extension and opt-in authenticated Cloudflare Worker for capturing, organizing, searching, and resuming AI conversations across **ChatGPT** and **Claude** without polluting host chat pages.

---

## Core Design Principles & Capabilities

1. **Zero-Presence Closed State (`QUIET-01`)**
   - When closed, Threadkeeper injects **0 visible DOM elements**, floating action buttons, sidebars, composer toolbars, badges, title/favicon mutations, or layout shifts onto ChatGPT (`chatgpt.com`, `chat.openai.com`) or Claude (`claude.ai`).
   - Host screenshots with Threadkeeper installed and closed are byte-identical (`Buffer.compare === 0`) to a clean browser profile across SPA navigation and streaming responses.

2. **Deliberate Invocation, Framing Protection & Clean Restoration (`OPEN-02`, `LIFE-09`)**
   - Opens only via deliberate user action: toolbar click (`chrome.action.onClicked`), keyboard command (`Ctrl+Shift+K` / `Command+Shift+K`), or controls inside an already-open manager surface.
   - Never auto-opens on install, browser startup, tab navigation, background capture, or error.
   - **Per-Tab One-Time Handshake & Framing Guard**: Any framed load of `manager.html` (`window.top !== window.self`) is forced into overlay mode and blocks all IndexedDB reads/writes and privileged background commands until a cryptographically random one-time handshake token (`REDEEM_OVERLAY_HANDSHAKE`, persisted in `chrome.storage.session` across MV3 service-worker evictions) is redeemed from the matching tab.
   - **Layered `Escape` Dismissal**: Pressing `Escape` inside an open modal (`#tk-organize-dialog`, `#tk-import-export-dialog`, `#tk-settings-dialog`) closes only the inner modal first; pressing `Escape` again dismisses `<dialog id="threadkeeper-overlay-root">` and restores host scroll position, composer focus, and unsent draft text.

3. **5-Location Evidence Margin & Archival Workbench (`PARITY-03`)**
   - **Archival Index & Margin Notes Aesthetic**: Warm Paper Light (`#F6F4EF` / `#161513` / `#1F6F6B`) and Archival Slate Dark (`#111315` / `#ECE9E1` / `#4DB6AC`) themes using a zero-webfont system editorial stack (`Iowan Old Style`, `Palatino Linotype`, `Book Antiqua`, `Georgia`, `serif`).
   - **5-Location Evidence Margin**: Every AI-extracted or heuristic claim renders a clickable turn citation badge (`m1`, `m2`) with speaker attribution (`user_committed` solid ink pip vs. `assistant_suggested` hollow ring pip):
     1. `where-you-left-off` — Focal editorial serif resumption banner with goal vs. latest development
     2. `decisions` — Committed vs. suggested architectural and product decisions
     3. `action-items` — Concrete next steps with turn citations
     4. `open-questions` — Unresolved questions flagged in the thread
     5. `related-threads` — Cross-thread continuation, supersede, and contradiction links
   - **Responsive Multi-View Workbench**: Shared state across the in-page overlay and full-page manager (`manager.html?surface=page`) with List, Status Board (Kanban), and Project Cards views, keyboard navigation (`/` search focus, `j`/`k` row traversal), and zero horizontal overflow at `1440×900`, `1280×800`, and `700×800`.

4. **Account-Safe Capture, 5-Part Composite Identity & Lossless Import/Export (`CAPTURE-04`, `IMPORT-05`, `ISOLATE-06`)**
   - Every conversation is keyed by `provider:accountId:workspaceId:sourceConversationId:branchId`, preventing collisions across personal/team accounts, workspaces, or sibling conversation branches.
   - **Coverage Monotonicity**: Visited DOM captures are labeled `partial` (never overclaiming `full` history) and never overwrite or downgrade higher-coverage export records (`full`) unless a newer revision has strictly more messages.
   - **652+ Conversation Import without Truncation**: Imports full ChatGPT (`conversations.json` DAG branch extraction), Claude, and Threadkeeper Portable JSON/Markdown bundles without any 500-thread cap, preserving manual overrides (`manualTitleOverride`, `project`, `categoryLocked`, `manualTags`, `workflowState`, `manualNotes`, `pinned`) across re-imports.
   - **Atomic Tombstones & Cascade Delete**: Deleting a thread records a tombstone (`db.tombstones`) and cascades across conversations, messages, chunks, vectors, summaries, relationships, and pending jobs in a single Dexie transaction so stale background jobs or re-imports never resurrect deleted threads.

5. **Fast Local Search & Opt-In Authenticated Cloud Enrichment (`AI-07`, `SEARCH-08`, `PERF-10`)**
   - **Local Hybrid Retrieval**: Sub-15ms local keyword, phrase, and fuzzy search over message bodies and metadata, fused via Reciprocal Rank Fusion (RRF, $k = 60$) with compatible local vector indexes (`model`, `dimensions`, `inputType`, `preprocessingVersion`, `indexKind`).
   - **Authenticated Cloudflare Worker (`worker/`)**:
     - Constant-time SHA-256 Bearer token hash authentication (`AUTH_TOKEN_HASHES_JSON`) and fail-closed daily per-user request/token quota enforcement via Cloudflare KV (`QUOTA_KV`).
     - Structured extraction via Cloudflare Workers AI `@cf/deepseek-ai/deepseek-v4.1-flash-1017` (`/ai/v1/chat/completions`) with strict `messageId`, `wireOrdinal`, and $\ge 12$-character normalized quote grounding verification on both Worker and client.
     - Optional `@cf/cloudflare/clef` decision/classification evaluation endpoint (`/v1/evaluate-clef`).
     - Server-held proxy for MongoDB Atlas Embedding & Reranking API (`voyage-4`, `voyage-4-large`, `voyage-context-4`, `rerank-3-lite`, `rerank-3`) with regional host selection (`ai.mongodb.com`, `us.ai.mongodb.com`, `eu.ai.mongodb.com`).

---

## Repository Structure

```text
threadkeeper/
├── src/
│   ├── adapters/          # ChatGPT & Claude DOM capture and export archive parsers (DAG branch reconstruction)
│   ├── core/              # Dexie IndexedDB schema, 5-part identity, RRF search, NL organizer + Undo, cloud client
│   └── entrypoints/       # MV3 background service worker, zero-DOM content script, and React 18 manager/overlay UI
├── shared/
│   └── cloud.ts           # Shared Zod wire schemas & quote/ordinal grounding verifier for Worker and extension
├── worker/
│   ├── src/               # Cloudflare Worker (index.ts, deepseek.ts, clef.ts, voyage.ts)
│   ├── tests/             # Vitest contract & security suite for Worker endpoints and quota enforcement
│   └── wrangler.toml      # Cloudflare Worker configuration (Workers AI + QUOTA_KV bindings)
├── scripts/
│   ├── build-extension.mjs # Unpacked MV3 builder (.output/chrome-mv3)
│   ├── bench-10k.mjs       # 10,000-thread (60,000-message) warm-open & body-only search latency benchmark
│   ├── run-benchmark.mjs   # Synthetic 10k benchmark runner
│   └── run-acceptance.mjs  # End-to-end Playwright packaged-extension acceptance suite (QUIET-01..PERF-10)
├── tests/
│   └── unit/core.test.ts  # 17-test unit & integration suite for DB, imports, grounding, RRF, and tombstones
├── docs/                  # Architecture, design direction, acceptance plan, and reference evidence
└── evidence/              # Acceptance ledger, 10k benchmark results, and real-browser Chromium screenshots
```

---

## Getting Started

### Prerequisites

- **Node.js** `>= 20` and **npm** `>= 10`
- **Chromium / Google Chrome** (for loading the unpacked MV3 extension or running Playwright acceptance checks)

### 1. Install Dependencies & Build Unpacked Extension

```powershell
npm install
npm run build
```

The unpacked Manifest V3 extension is emitted to `.output/chrome-mv3`.

### 2. Load Unpacked in Chrome / Chromium

1. Open `chrome://extensions` in Chrome or Chromium.
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `.output/chrome-mv3` directory.
4. Visit `https://chatgpt.com` or `https://claude.ai` and press `Ctrl+Shift+K` (`Command+Shift+K` on macOS) or click the Threadkeeper toolbar icon to open the overlay.

### 3. Verification & Benchmark Commands

```powershell
# Typecheck, build MV3 bundle (.output/chrome-mv3), and run Vitest unit tests (17/17 passing)
npm run check

# Typecheck, run Worker unit tests (7/7 passing), and verify Wrangler dry-run bundle
npm --prefix worker run check

# Run the 10,000-thread (60,000-message) warm-open and local search latency benchmark
node scripts/bench-10k.mjs

# Run the full packaged-extension headless Chromium acceptance suite (QUIET-01 .. PERF-10)
npm run test:acceptance
```

---

## Optional Cloudflare Worker Setup (`worker/`)

Threadkeeper works 100% locally out of the box. To enable opt-in cloud summarization, embeddings, or reranking through your own Cloudflare Worker:

1. Configure your KV namespace in `worker/wrangler.toml` (`QUOTA_KV`) and set Worker secrets via Wrangler:
   ```powershell
   cd worker
   npx wrangler secret put AUTH_TOKEN_HASHES_JSON
   npx wrangler secret put MONGODB_ATLAS_MODEL_API_KEY
   ```
   - `AUTH_TOKEN_HASHES_JSON`: JSON map of lowercase SHA-256 hex digests of client Bearer tokens to user IDs, e.g. `{"<sha256-hex>":"user_primary"}`.
   - `MONGODB_ATLAS_MODEL_API_KEY`: MongoDB Atlas Model API key for Voyage embeddings (`voyage-4`, `voyage-4-large`, `voyage-context-4`) and rerankers (`rerank-3-lite`, `rerank-3`).
2. Deploy the Worker when authorized:
   ```powershell
   npx wrangler deploy
   ```
3. In Threadkeeper **Settings → Cloud & Privacy**, enable **Opt-In Cloud Enrichment**, enter your Worker URL and Bearer token, and set a non-zero daily request budget.

---

## Acceptance Gates & Measured Benchmarks (`QUIET-01` .. `PERF-10`)

All 10 acceptance gates pass in packaged-extension headless Chromium ([`evidence/acceptance/acceptance-ledger.json`](evidence/acceptance/acceptance-ledger.json) and [`evidence/acceptance/acceptance-report.md`](evidence/acceptance/acceptance-report.md)):

| Gate | Requirement | Status | Measured Result / Evidence |
| :--- | :--- | :--- | :--- |
| **`QUIET-01`** | Zero-Presence Closed State | **PASS** | `0` injected nodes on ChatGPT & Claude; exact PNG byte equality (`Buffer.compare === 0`) vs. clean browser across streaming & SPA navigation; `0` leaked secrets in bundle |
| **`OPEN-02`** | Deliberate Invocation & Clean Restoration | **PASS** | Opens only on user command; layered `Escape` closes inner modal first, then outer `<dialog>`, restoring `scrollY=320`, `#prompt-textarea` focus, and unsent draft text |
| **`PARITY-03`** | Overlay & Full-Page Parity + Evidence Margin | **PASS** | Reconciled counts, all 5 Evidence Margin locations with clickable `m1`/`m2` turn citations, List/Kanban/Project Cards views, zero horizontal overflow at `1440×900`, `1280×800`, and `700×800` |
| **`CAPTURE-04`** | Authorized Passive Capture & Monotonicity | **PASS** | Live DOM capture stored in IndexedDB (`coverage=partial`, monotonic `sourceRevision`), higher coverage (`full`) never downgraded by partial DOM visits |
| **`IMPORT-05`** | Lossless Import/Export & 652-Thread Fixture | **PASS** | `652/652` ChatGPT conversations imported with DAG branch splitting, Claude export import, and Portable JSON/Markdown round-trip preserving manual overrides |
| **`ISOLATE-06`** | Multi-Account, Workspace & Branch Isolation | **PASS** | 5-part key `provider:accountId:workspaceId:sourceConversationId:branchId` isolates accounts and branches; `OPEN_ORIGINAL_THREAD` enforces `account_mismatch` guard |
| **`AI-07`** | Grounded Enrichment, Worker Auth & NL Organize | **PASS** | Constant-time SHA-256 Bearer auth, fail-closed `QUOTA_KV` quota reservation, strict `messageId` + `wireOrdinal` + $\ge 12$-char quote grounding, `422` `title_only` guard, NL organize negative-clause exclusion + 1-click Undo |
| **`SEARCH-08`** | Hybrid Local + Vector Search & Provenance | **PASS** | Real-browser search with match reasons & quotes, RRF lexical+vector fusion, model/dimension compatibility checks, rerank fallback, and default `isSyntheticBenchmark` exclusion |
| **`LIFE-09`** | Lifecycle Hygiene, Framing Guard & Tombstones | **PASS** | Minimal MV3 permissions (`storage`, `unlimitedStorage`, `alarms`), `hostFramedPageSurfaceBlocked=true`, `serviceWorkerEvictionHandshakeSurvived=true`, atomic tombstone & cascade delete |
| **`PERF-10`** | 10,000-Thread Warm-Open & Search Latency | **PASS** | **Chromium IndexedDB (10k threads / 60k turns)**: Warm-open `p50=56ms`, `p95=74.3ms` ($\le 500\text{ms}$); Local body search `p50=2.4ms`, `p95=3.6ms` ($\le 150\text{ms}$). **Node (10k threads)**: Warm-open `p95=2.455ms`; Search `p95=20.359ms` |
