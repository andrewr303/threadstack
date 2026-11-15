---
id: CTX-3
title: Open-source projects worth studying
level: project
kind: business
type: website
source: github.com (repositories checked with the GitHub CLI on 2026-11-13)
updated: 2026-11-13
---

# CTX-3 — Open-source projects worth studying

**Kind:** business
**Type:** website
**Source:** GitHub. Each repository's existence, stars, licence and last push were checked on
2026-11-13. The "idea to borrow" lines come from general knowledge of each project; the source was
not opened, so confirm a design in the repository before relying on it. Star counts are approximate.

## Excerpt

### Most relevant to this plan

| Repository | Stars, licence, last push | Idea to borrow | Used by |
|---|---|---|---|
| `BrowserMCP/mcp` | 7.4k, Apache-2.0, 2026-11 | An agent drives the user's own signed-in tabs through an extension over a local connection | REQ-7, REQ-11 |
| `hangwin/mcp-chrome` | 12.5k, MIT, 2026-01 | Extension plus native messaging host exposing tools, with semantic search over page content | REQ-7, REQ-8 |
| `microsoft/playwright-mcp` | 39.6k, Apache-2.0, 2026-11 | Tool results as accessibility snapshots with element references instead of pixels; attach to an existing browser | REQ-11 |
| `AgentDeskAI/browser-tools-mcp` | 7.3k, MIT, 2026-10 | Three parts: extension, local server, tool server | REQ-7 |
| `BloopAI/vibe-kanban` | 28.7k, Apache-2.0, 2026-11 | A board where each card is an agent run with a review step | REQ-9 |
| `slopus/happy` | 24.6k, MIT, 2026-11 | Status and remote control of coding sessions | REQ-10 |
| `kbwo/ccmanager`, `asheshgoplani/agent-deck` | 1.3k each, MIT, 2026-10 and 2026-11 | A status model for sessions: running, waiting for input, idle | REQ-10 |
| `huggingface/transformers.js` | 16.4k, Apache-2.0, 2026-11 | Embedding and reranking inside the browser | Later than v1 |
| `electric-sql/pglite`, `asg017/sqlite-vec` | 16.3k and 8.3k, Apache-2.0 | A local store with vector and full-text search | Later than v1 (server copy of the library) |

### For the separate workstream (accounts, session lists, views)

| Repository | Stars, licence, last push | Idea to borrow |
|---|---|---|
| `ferdium/ferdium-app` | 4.8k, Apache-2.0, 2026-10 | Several instances of one service, each with its own session partition (desktop shell) |
| `mozilla/multi-account-containers` | 3.2k, MPL-2.0, 2026-10 | Container per account as a data model (Firefox only) |
| `makeplane/plane` | 62.4k, AGPL-3.0, 2026-11 | Display options: layout, group by, sub-group by, order by, saved views. Study only |
| `TanStack/table` | 28.6k, MIT, 2026-11 | Headless grouping, filtering and sorting state, with virtualisation |
| `Mail-0/Zero` | 10.9k, MIT, 2026-10 | Sidebar plus list with labels and keyboard triage |
| `mbnuqw/sidebery` | 4.8k, MIT, 2026-10 | Panels and trees for hundreds of tabs (Firefox only) |
| `chathub-dev/chathub` | 10.7k, GPL-3.0, 2026-10 | Several providers side by side in one extension page. Study only |
| `pionxzh/chatgpt-exporter` | 2.9k, MIT, 2026-11 | Capturing conversations through the site's own API with the page session |
| `d-kimuson/claude-code-viewer`, `simonw/claude-code-transcripts` | 1.3k MIT, 1.7k Apache-2.0 | Reading local coding-session transcripts into a browsable viewer |

## Decisions taken from this source

- No open-source extension was found that captures ChatGPT, Claude, Gemini and Grok into one library
  with semantic search. Threadkeeper's library is the part to keep, which supports decision G-2.
- For an agent reaching a signed-in browser, the common shape is extension plus local server plus
  tool server. REQ-7 follows it with the Paperclip server as the local server.

## Not used

- Archived or unlicensed projects: `ai-shifu/ChatALL` (archived), `ramboxapp/community-edition`
  (archived), `mem0ai/mem0-chrome-extension` (archived), `lencx/Noi`, `wavebox/waveboxapp` and
  `WorldBrain/Memex` (no licence detected). Do not reuse their code.
- Projects under AGPL or GPL are for study only: `siteboon/claudecodeui`, `smtg-ai/claude-squad`,
  `winfunc/opcode`, `karakeep-app/karakeep`, `khoj-ai/khoj`, `browseros-ai/BrowserOS`.
