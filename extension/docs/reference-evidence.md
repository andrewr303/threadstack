# Reference evidence and capability comparison

Inspected 2026-10-25. Supplied files are listed in `evidence/references/inventory.json` (8 files, 7 unique SHA-256 contents; the two MindMarks PDFs are byte-identical). Page renders and extracted text are under `evidence/references/pdf/`.

| Supplied input | What it actually is | Status |
|---|---|---|
| `online-thread-organizer-build-prompt.md` | Requirement document | Read in full |
| `screencapture-tidychats-features…(1).pdf` (3 pages) | TidyChats marketing feature page | Rendered + text; **documentation claims** |
| `screencapture-mindmarks-io…(1).pdf` (6 pages) | MindMarks marketing page | Rendered + text; page 4 contains the list/Kanban/map claims |
| `screencapture-mindmarks-io…(2).pdf` | Byte-identical duplicate of `(1)` | Deduplicated |
| `Screenshot_…12226_chatgpt.com.jpeg` | MindMarks **Chat Manager open** (652 chats, "Showing 500 of 652") | Visual reference |
| `Screenshot_…121628_chatgpt.com.jpeg` | MindMarks onboarding modal | Not a manager reference |
| `Screenshot_…121711_tidychats.com.jpeg` | TidyChats feature grid | Documentation claims |
| `Screenshot_…121652_threadback.dev.jpeg` | Threadback feature grid | Documentation claims |
| Three extracted extension trees under the repo root | MindMarks 2.3.6, MindMarks Beta 3.0.13, Threadback 1.0.4 | Static analysis only; never executed or installed |

No source maps, no standalone LICENSE files, and no `sourceMappingURL` exist in any of the three packages. Bundled third-party notices exist (Lucide ISC in MindMarks icons; Vue MIT in Threadback overlay and chunks). Those notices do not license the extensions themselves. No competitor code, assets, branding, telemetry or payment logic is reused.

REA static Evidence (partial coverage; selected sources only): MindMarks `ev_a9ad4d1d7e55a897448d541a7fdb071d6dccb3aabc916898e776fd2eb32793f3`, MindMarks Beta `ev_b262cecb7896ecb6ba1446d025aa291d716dd39dcde317143b8c78d9916842bf`, Threadback `ev_8e28262daa0b6cabc6cb3508e023cfc12d28d9d6307d6272d544cea0c0c3e037`.

## Comparison

| Area | Evidence | Useful behaviour | Limitation | Our improvement | Verification |
|---|---|---|---|---|---|
| Closed-state behaviour | MindMarks `assets/cs-manager-host.js:2-14` builds a permanent `mm-fab-rail` with launcher, images, minimap and settings buttons injected into every matched page; `:44` mounts the host root unconditionally; `:44` restores `drawerOpen` from `chrome.storage.local` on load | One-click access | Permanent injected controls, and the overlay reopens itself if it was open before | Nothing is injected until invocation; a single `<dialog>` exists only while open; no persisted visibility | Source evidence; **not runtime-verified** |
| Overlay | Threadback `overlay.js:291` appends a host with a closed shadow root, mounts Vue, unmounts and removes on close; Escape closes; falls back to `search.html` | Clean teardown, graceful fallback | Host-origin UI; no explicit focus/scroll/draft contract observed | Extension-origin iframe reader; native `<dialog>` focus trap; explicit scroll/focus restore; unsupported pages go to the full-page manager | Source evidence |
| Provider access | MindMarks `assets/cs-content.js:71,78` calls undocumented `/backend-api/conversations?offset=&limit=&order=updated` with `LIST_FETCH_LIMIT: 100`; Threadback `content-scripts/chatgpt.js` wraps `fetch`/XHR in the MAIN world | Real history pagination beyond the sidebar | Undocumented, unversioned provider endpoints; brittle; requires MAIN-world interception | v1 uses user exports and consented visible-DOM capture only. No undocumented endpoints, no MAIN-world hooks | Source evidence; our approach is a deliberate scope reduction |
| Branch handling | MindMarks parses `parentId`/`childrenIds` then flattens messages with `Object.values(...)` before storing; Threadback follows `current_node`/`current_leaf_message_uuid` and keeps only that path | Coherent active path | Neither demonstrates durable sibling-branch storage | Store the selected path as a branch identity and keep siblings as separate branch records; never concatenate alternatives | Source evidence + design |
| Search | MindMarks `assets/db.js:1` `SEARCH` is `title.toLowerCase().includes(q)`, rejecting <2 chars; Threadback `chunks/keyword-BpBtwCgS.js:11` indexes `title`+`content` with `boost:{title:3,content:1}`, optional fuzzy, and a worker snapshot protocol | Fast local search with a real index | MindMarks search is title-only; Threadback is a solid baseline | Inverted index over original messages *and* manual metadata, phrase/fuzzy, scope filters before retrieval, excerpt + why-retrieved | Source evidence; our implementation tested separately |
| Storage | MindMarks `ChatGPTSync` DB v4/v5: `conversations` keyed by `id`, `messages` keyed by `conversation_id`, `sync_state`; Threadback Dexie `threadback` v6 with `conversations`/`messages`/`messageEmbeddings`/`indexCache` | Proven extension-origin IndexedDB pattern | MindMarks message store is one blob per conversation; identity is `platform:platformId` with no account/workspace dimension | Normalised stores with explicit provider/account/workspace/conversation/branch keys, revisions, coverage and provenance | Source evidence |
| Classification | MindMarks keeps `mindmark.classification.v2` in `chrome.storage.local`, partitioned per provider, with folder/tag pools and manual folder moves | Persisted manual organisation | Classification state lives beside transcripts in `chrome.storage`, and manual vs generated provenance is not clearly separated | Manual fields are separate columns with locks; AI proposals are previewed and never auto-applied without policy | Source evidence |
| Import/export | MindMarks exports JSON/Markdown; Beta `EXPORT_BACKUP` `format:"mindmarks-backup"` covers diaries/tasks/categories only, not conversations. Threadback export begins with `version`/`exportedAt`/`items` and validates composite IDs before transactional replace | Versioned import with validation | Neither is a portable conversation archive with account provenance | Portable JSON + Markdown with schema version, explicit account binding, dedupe, and manual-edit preservation | Source evidence |
| Counts | `Screenshot_…12226` shows "Showing 500 of 652", 44 organised, 622 Uncategorized | — | Silent display cap; unreconcilable counts | No display cap; documented count definitions; a 652-thread fixture test | Visual evidence + test |
| Message times | TidyChats PDF p1 claims per-message times from the site's own data, none when unknown | Honest unknown timestamps | Documentation claim only | Same rule: unknown stays unknown | Documentation claim |
| Outline/context tools | TidyChats PDF p1 documents a message outline, in-chat find, and `@@` mentions; the supplied TidyChats screenshot shows always-visible composer/context shortcuts | Useful navigation | Documented as injected, always-visible page UI — the negative reference | All such tools live inside the invoked manager; no page-side rails or composer buttons | Documentation claim |

## What remains unverified

No competitor extension was loaded into the browser. No provider endpoint was called. No cloud-task adapter was verified. Claims above marked "documentation claim" or "source evidence" are not runtime proofs. The MindMarks PDF page 4 text extraction is noisy; only the rendered page was used for the list/Kanban/map claim.
