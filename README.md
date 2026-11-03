# Threadkeeper — automatic organizer for all your AI threads

Threadkeeper is a Chrome / Edge (Manifest V3) extension that captures your conversations with **ChatGPT, Claude, Claude Code, Codex, Grok, Gemini, Perplexity, DeepSeek, Le Chat and Microsoft Copilot**, works out what each one is about, and files it automatically — so you can find any thread by what it *was*, not just by its title, and pick it up where you left off.

Everything is stored locally in your browser. AI analysis is optional and uses your own Anthropic API key.

---

## What it does

### 1. Captures automatically
- Open a conversation on any supported site and it lands in the library — no clicks. Capture is read-only, zero-footprint (no injected buttons, badges or layout changes) and never captures the composer or an in-progress streaming reply.
- **Provider-native organization is kept:** ChatGPT Projects, Claude Projects, the GitHub repository of a Claude Code / Codex web session, and the model a ChatGPT reply used.
- **Coding agents on your computer:** import Claude Code sessions (`~/.claude/projects`) and Codex CLI sessions (`~/.codex/sessions`). Pick the folder once; new sessions sync every time the library opens. Each session keeps its working directory, git branch, model and a ready-to-copy `claude --resume …` / `codex resume …` command.
- **Exports:** drop in a ChatGPT or Claude data export (`.zip` or `conversations.json`), a Threadkeeper Portable bundle, or `.jsonl` session files — the format is detected automatically.

### 2. Understands every thread (beyond the title)
Each thread gets a **gist** (one line: what it is about and how it ended), a summary, the user's goal and outcome, the **kind of work** (building, debugging, writing, research, planning, design, data, business, learning, personal…), topic tags, named entities and artifacts (files, links), plus **where you left off**, **decisions** (yours vs. the assistant's suggestions), **next steps** and **open questions** — each linked to the exact message it came from.

- **On-device analysis** runs instantly on every capture, with no network and no key.
- **Claude analysis** (optional): Claude (default **Claude Opus 5.5**, selectable Sonnet 5.5 / Haiku 5.5 / Fable 5.1) re-reads each new or changed thread once the chat has gone quiet and writes a descriptive title, gist, summary, decisions, next steps and project. Every extracted item must quote its source message verbatim; anything Claude cannot ground is dropped. Claude can run through any of three providers, chosen in **Settings → AI models**:

  | Provider | Credentials | Notes |
  |---|---|---|
  | Anthropic API | API key from console.anthropic.com | Server-side refusal fallback on Opus 5.5, Sonnet 5.5 and Fable 5.1 |
  | Amazon Bedrock | Bedrock API key, or IAM access keys (optional session token) | Claude in Amazon Bedrock at `bedrock-mantle.{region}.api.aws`, model IDs such as `anthropic.claude-opus-5-5`. Enable model access in the Bedrock console first |
  | Claude Platform on AWS | Workspace ID (`wrkspc_…`) plus a short-term API key, or IAM access keys | Anthropic-operated, billed through AWS Marketplace |

  AWS credentials live under **Settings → Amazon Web Services** and are shared by Bedrock Claude, embeddings and reranking. Prefer short-term Bedrock API keys (12 hours at most) or temporary IAM credentials; AWS recommends long-term keys only for exploration. IAM keys are signed in the browser with SigV4.

### 3. Organizes automatically
New threads are filed into projects the moment they are captured, using the strongest signal available:

1. **Your choice** — a project you set or locked is never changed.
2. **The provider's own project** — ChatGPT/Claude Project or the coding session's repository (creating the project if needed).
3. **Claude's judgement** — matched to an existing project, or a new project for a clear new workstream.
4. **Keyword routing** — each project's keywords (seeded for your starter areas, editable).
5. **Similar threads** — nearest neighbours among confidently filed threads in vector space.

Status is set automatically too (*active*, *needs review* when the assistant is waiting on you, *done* when you wrapped up, *paused* after 30 days of silence) unless you set it yourself. **Auto-organize** reviews the whole library — with Claude when a key is set, otherwise by clustering similar unfiled threads into proposed projects — and shows every change for approval; every apply is undoable.

### 4. Finds and answers
- **Search** fuses keyword, phrase, fuzzy and semantic (vector) matches across titles, gists, summaries, topics, decisions and full message text.
- **Ask** your library a question ("What did I decide about the Stripe webhook retries?") and Claude answers from your own threads with clickable `[T1]` citations.
- **Related threads** for every conversation, by semantic similarity.

### 5. Lives next to your chats
- **Side panel** (default for the toolbar button): the library beside any page, with the conversation open in the current tab pinned at the top.
- **Overlay** on AI pages (`Alt+Shift+K`) and a **full-page library** (`Alt+Shift+M`). Side panel shortcut: `Alt+Shift+L`.

---

## Privacy

- Transcripts live in extension IndexedDB in your browser profile. Websites and content scripts cannot read it.
- API keys and AWS credentials (Anthropic, Voyage, OpenAI, Bedrock, Claude Platform on AWS) are stored the same way and only sent to their own API.
- The extension holds no AWS host permission at install. **Settings → Amazon Web Services → Allow access** asks the browser for exactly the endpoints of the configured region (for example `bedrock-mantle.us-east-1.api.aws`).
- **Settings → Privacy & limits** lists every host that captured text can reach with the current settings.
- Nothing is sent anywhere unless you add a key. Threads marked **local-only**, and threads already filed in a local-only project (the starter *Personal* area), are never sent to Claude, embedding APIs or the Worker. The check happens when a thread is analyzed, so a brand-new conversation that nothing has filed yet *is* sent before Claude can recognize it as personal — mark such conversations local-only, or switch off automatic Claude analysis.
- Because the library frame must load from the extension's fixed ID (required for Edge, see Troubleshooting), a website can detect that Threadkeeper is installed by probing that URL. It cannot read anything: unauthenticated frames are rejected and the database is extension-only.
- A daily limit (default 150 analyses) caps Claude usage; Settings shows a cost estimate for your library and model.

## Embeddings

On-device vectors (feature-hashed, 384 dims) are always maintained and need no key. For true semantic search and better auto-filing choose a hosted model in **Settings → Embeddings**:

| Provider | Models | Notes |
|---|---|---|
| Voyage AI (recommended by Anthropic) | `voyage-4-lite`, `voyage-4`, `voyage-4-large`, `voyage-code-4` | API key from voyageai.com |
| OpenAI | `text-embedding-3-small`, `text-embedding-3-large` | API key from platform.openai.com |
| Ollama (local) | any embedding model, e.g. `nomic-embed-text` | start Ollama with `OLLAMA_ORIGINS=chrome-extension://*` |

Vectors are only compared within one model space, so switching provider never mixes incompatible vectors.

---

## Getting started

Prerequisites: Node.js ≥ 20, npm ≥ 10, Chrome or Microsoft Edge.

```bash
npm install
```

```bash
npm run build
```

The unpacked extension is written to `.output/chrome-mv3`.

1. Open `chrome://extensions` (or `edge://extensions`), enable **Developer mode**, click **Load unpacked** and choose `.output/chrome-mv3`. After every later `npm run build`, click **Reload** on that page; the browser keeps the previous manifest until you do.
2. Click the Threadkeeper toolbar icon to open the side panel, then open any conversation on a supported site — it appears in the library, already summarized and filed.
3. Optional: **Settings → AI models** → choose the Anthropic API, Amazon Bedrock or Claude Platform on AWS, add the key → **Test connection**. Then press **Auto-organize** to analyze and file your whole library.
4. Optional: **Import / Export** → import your ChatGPT/Claude export and your Claude Code / Codex session folders.

### Commands

```bash
# Typecheck, build and run the unit tests
npm run check
```

```bash
# Packaged-extension acceptance suite (QUIET-01 .. PERF-10) in headless Chromium
npm run test:acceptance
```

```bash
# End-to-end organizer check: Edge static-URL overlay, multi-provider capture, auto-filing,
# Claude analysis / Ask against a mocked Anthropic API, side panel layout
npm run test:e2e
```

```bash
# Real Microsoft Edge: overlay, full page, side panel, and stale-manifest recovery
# (set EDGE_EXECUTABLE_PATH if Edge is not in a standard location)
npm run test:edge
```

```bash
# 10,000-thread warm-open and local search benchmark
npm run bench
```

Set `CHROME_EXECUTABLE_PATH` to use a specific Chromium build for the browser suites.

---

## Repository structure

```text
src/
  core/
    providers.ts         Provider registry (hosts, URL ids, labels) — the manifest is derived from it
    dom-capture.ts       Per-provider DOM adapters + generic fallback, structure-aware text extraction
    cli-sessions.ts      Claude Code and Codex CLI JSONL parsers
    importers.ts         Format detection, zip/JSON/JSONL import, folder sync
    adapters.ts          ChatGPT/Claude export parsers, Portable bundle, Markdown handoff
    insights.ts          On-device analyzer (gist, kind, topics, decisions, next steps, status)
    ai/claude.ts         Claude analysis, library planning and Ask via the official Anthropic SDK
    embeddings.ts        Local hashed vectors + Voyage / OpenAI / Ollama
    auto-organize.ts     Project filing precedence, k-NN, clustering
    pipeline.ts          Capture → analyze → embed → file; debounced, leased Claude job queue
    library-organize.ts  Library-wide plans (Claude or local) for Auto-organize / Organize…
    db.ts, schema.ts     Dexie schema (v2), identity, tombstones, settings normalization
    search.ts            Hybrid lexical + vector retrieval
  entrypoints/
    background.ts        Service worker: capture, alarms, analysis queue, side panel / overlay routing
    content.ts           Zero-footprint capture observer, overlay host with load watchdog
    manager/             React UI shared by side panel, overlay and full page
shared/cloud.ts          Wire schemas for the optional Cloudflare Worker
worker/                  Optional Cloudflare Worker (DeepSeek + MongoDB Voyage)
scripts/                 Build, acceptance, e2e and benchmark runners
tests/unit/              Vitest suites (core + organizer)
evidence/                Acceptance ledger, benchmark report and screenshots
```

---

## Optional Cloudflare Worker (`worker/`)

Not needed when Claude analysis is configured. To use your own Worker for enrichment and embeddings instead:

1. Configure `QUOTA_KV` in `worker/wrangler.toml` and set secrets:
   ```bash
   cd worker
   npx wrangler secret put AUTH_TOKEN_HASHES_JSON
   npx wrangler secret put MONGODB_ATLAS_MODEL_API_KEY
   ```
   - `AUTH_TOKEN_HASHES_JSON`: JSON map of lowercase SHA-256 hex digests of client Bearer tokens to user IDs.
   - `MONGODB_ATLAS_MODEL_API_KEY`: MongoDB Atlas Model API key for Voyage embeddings and rerankers.
2. Deploy with `npx wrangler deploy`.
3. In **Settings → Cloudflare Worker enrichment (advanced)**, enable it, enter the Worker URL and Bearer token, and set a non-zero daily budget.

---

## Acceptance gates

All gates pass in packaged-extension headless Chromium (see [`evidence/acceptance/acceptance-report.md`](evidence/acceptance/acceptance-report.md) and the [ledger](evidence/acceptance/acceptance-ledger.json)); the organizer e2e writes screenshots to [`evidence/organizer/`](evidence/organizer).

| Gate | Requirement | Result |
| :--- | :--- | :--- |
| `QUIET-01` | Zero-presence closed state | 0 injected nodes, byte-identical host screenshots, no stray network; the manager loads from the static-ID URL Edge uses |
| `OPEN-02` | Deliberate invocation & restoration | Layered `Escape`, scroll, focus and unsent draft restored |
| `PARITY-03` | Overlay / full-page parity | Reconciled counts, 5 evidence locations, list / kanban / project cards, no horizontal overflow at 1440, 1280, 700 px |
| `CAPTURE-04` | Passive capture & monotonic coverage | Partial DOM capture never downgrades full exports |
| `IMPORT-05` | Lossless import / export | 652-thread ChatGPT fixture, Claude export, Portable JSON + Markdown round-trip |
| `ISOLATE-06` | Account / workspace / branch isolation | 5-part identity key, `account_mismatch` guard |
| `AI-07` | Grounded enrichment & NL organize | Quote-grounded claims, exclusion clauses, one-click undo |
| `SEARCH-08` | Hybrid search | Match reasons, RRF lexical + vector fusion, compatibility checks |
| `LIFE-09` | Lifecycle hygiene | Handshake framing guard, tombstones, cascade delete, no localhost origins |
| `PERF-10` | 10k threads | Chromium IndexedDB warm-open p95 221 ms (≤ 500 ms); local search p95 5.6 ms (≤ 150 ms) |

---

## Troubleshooting

- **"`<extension id>` is blocked · This page has been blocked by Microsoft Edge · ERR_BLOCKED_BY_CLIENT":** Edge is still running an old manifest. Builds before 0.2.0 made the library pages reachable only through a dynamic URL (`use_dynamic_url`), and Edge blocks the static URL it hands out, including the full-page library. Edge reads `manifest.json` only when an unpacked extension is loaded or reloaded, so running `npm run build` without pressing **Reload** keeps the broken manifest live. Fix: open `edge://extensions`, click **Reload** under Threadkeeper, and check that the version shown matches the `Built Threadkeeper … (build …)` line printed by `npm run build`. From 0.3.0 the extension detects this itself: the service worker reloads once per build to pick up the new manifest, and any open library page shows a **Reload extension** banner. **Settings → Diagnostics** compares the running manifest with the files on disk and copies a report. `npm run test:edge` reproduces the block in real Edge and checks every surface.
- **A site changed its markup and capture stopped:** the generic role heuristics usually keep working; otherwise use the provider's data export via **Import / Export**.
- **Claude analysis paused:** the status chip in the header shows the last error (invalid key, rate limit, daily limit). Fix it in Settings; queued threads resume automatically.
