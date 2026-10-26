# Threadkeeper architecture

The implementation follows the supplied `online-thread-organizer-build-prompt.md`. The reference extension trees are read-only research inputs, not application code or build inputs. All new application code is in `threadkeeper/`.

## Decisions

1. **A quiet MV3 extension, not a toolbar popup.** The action and configurable command invoke a generous overlay on supported ChatGPT/Claude pages. Other pages open an extension-owned manager tab. Installation, startup, capture and job events never open UI or show page controls. Persist view state, never visibility.
2. **Extension-origin reader.** A lazily created extension iframe renders captured messages. Website DOM contains only the temporary dialog/frame, never transcripts from other providers. A host can remove or obscure that frame; this is not a defense against a malicious website impersonating UI. The privileged operation boundary is extension runtime sender validation, not CSS isolation. No generic page-to-extension bridge is exposed. Embedding is admitted only after an invocation-specific authorization, not merely because the frame URL is web-accessible.
3. **Local-first storage.** Dexie/IndexedDB is owned by extension contexts; content scripts submit narrow capture DTOs to the service worker. Website IndexedDB/localStorage is never a transcript store. `chrome.storage` holds only small preferences and permission/account bindings. Private backend access credentials must stay in trusted extension contexts, not content-script-readable storage or exports.
4. **Explicit identity, conservative coverage.** Source identity includes provider, account, workspace, conversation and branch. Imports ask which account the archive represents. DOM identity is explicitly bound by the user; where account identity cannot be established, capture does not pretend to know it. Visited DOM capture is partial, even when it appears to show all messages. Export imports may be complete within the supplied selected branch. No undocumented history API is used in the first release.
5. **Evidence before generated context.** Source messages, source revision and quote references support extraction. User commitments differ from assistant suggestions. Workflow state, execution state and capture freshness are separate. No title-only generated summaries. Local excerpts remain usable without AI.
6. **Manual edits survive.** Alias, project, notes, tags, favorites, workflow state and category locks are distinct from captured/generated metadata. Imports update source content transactionally. Tombstones and revision checks prevent stale jobs from recreating deleted data or overwriting newer context. Bulk operations have preview and undo logs.
7. **Fast local retrieval first.** Original messages and manual metadata are searchable. Filters are applied before lexical/vector retrieval and before provider requests. Compatible vectors require exact model/dimension/preprocessing/index identity. Contextual vectors are a separate index, keyed by the entire context-group revision. Ranked lists fuse by rank, not incompatible vector distance.
8. **Opt-in inference, not cloud storage.** The Worker is a bounded authenticated inference service. It does not store transcripts or act as a generic proxy. Durable usage accounting is per authenticated user. No Atlas database is required. Budgets default to zero; missing configuration leaves local features working. Remote query execution is explicit, never paid calls on each keystroke.
9. **Server-held provider credentials.** Cloudflare account/token and MongoDB-issued model API key are server secrets. Client access credentials identify an authorized organizer user and are revocable. Authentication, request validation, model allowlists, payload limits and quotas are enforced independently of CORS.
10. **Reproducible verification.** Unit and contract fixtures are distinguished from packaged-extension browser checks and live provider smoke tests. Synthetic data is clearly labeled and never auto-imported into a personal library. No live paid calls or production deployment is authorized.

## Visual working brief

The human is returning to unfinished project work and needs to recognize the right conversation before resuming it. The focal element is the **where-I-left-off preview with supporting passages**, not a provider badge or activity chart.

Domain: threads, branches, checkpoints, handoffs, source passages, workstreams, reading/review. Color world: archive-paper white, graphite ink, pencil gray, teal page marker, amber uncertainty. Signature: every useful extracted claim leads back to its captured passage and revision. Rejecting metric dashboards in favor of a reading workbench; rainbow folders in favor of work-first navigation; hover-only previews in favor of persistent keyboard-accessible detail.

Use neutral layered surfaces with a restrained teal accent, 4px spacing rhythm, readable 14–16px controls and body, modest 20–28px headings, comfortable/compact density, and native semantic controls. Default laptop composition: collapsible navigation, flexible conversation list and optional reader; collapse regions rather than add horizontal scroll. Light/dark themes share semantic tokens. No decorative animation; honor reduced motion. Nested dialogs own Escape before the manager; dismissal restores the host's scroll/focus without touching its draft.

## Documented external contracts checked on 2026-10-25

- [Cloudflare Chat Completions](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/): `https://api.cloudflare.com/client/v4/accounts/{id}/ai/v1/chat/completions`. Responses is restricted to GPT-OSS and is not a substitute.
- [DeepSeek schema and paid-access notice](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/index.md): exact model `@cf/deepseek-ai/deepseek-v4.1-flash-1017`; supports `max_completion_tokens`, `reasoning_effort`, `response_format`. Runtime structured-output success is not verified until a separately authorized live smoke test.
- [Clef](https://developers.cloudflare.com/workers-ai/models/clef/index.md): separate `/ai/run/@cf/cloudflare/clef`, `model: clef`, state plus typed questions. Choice answer includes `type`, `choice`, `probabilities`, `confidence`; not Chat Completions. Optional, no automatic classification until evaluated.
- [MongoDB model API](https://www.mongodb.com/docs/voyageai/api-and-clients/): `https://ai.mongodb.com/v1`, `https://us.ai.mongodb.com/v1`, `https://eu.ai.mongodb.com/v1`, matching key geography. These are model API credentials, not a database password or a separately issued Voyage key.
- [Standard embeddings](https://docs.voyageai.com/reference/embeddings-api): `input`, `model`, `input_type`, `output_dimension`, `truncation`.
- [Contextual embeddings](https://docs.voyageai.com/reference/contextualized-embeddings-api): `inputs` is a list of ordered chunk groups, not a flat list. Query groups contain a single query.
- [MongoDB rerank models](https://www.mongodb.com/docs/voyageai/models/rerankers/): requested `rerank-3` and `rerank-3-lite`. The upstream Voyage reference still describes older 2.5 models; do not silently substitute them. [Rerank contract](https://docs.voyageai.com/reference/reranker-api): query/documents/model/top_k, response indexes and relevance scores.
- [Chrome storage](https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies): content-script web storage belongs to the host, not the extension. Extension iframes share their extension-origin storage partition.
- [Chrome service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle): persist work, register listeners synchronously, use alarms; no keepalive tricks.

## Adapter capability matrix (v1)

`Y` = implemented, `P` = partial by design, `N` = not supported and must be shown as unsupported in the UI.

| Capability | ChatGPT web (DOM) | Claude web (DOM) | ChatGPT export | Claude export | Threadkeeper portable | Gemini / Grok / cloud coding tasks |
|---|---|---|---|---|---|---|
| Account identification | P — user-bound label only | P — user-bound label only | P — user declares the archive's account | P — user declares | Y — carried in the file | N |
| Thread discovery | P — only threads the user opens | P — only opened threads | Y — every conversation in the file | Y | Y | N |
| Content capture | P — rendered messages only | P — rendered messages only | Y | Y | Y | N |
| History backfill | N — no undocumented endpoints | N | Y — complete within the file | Y | Y | N |
| Branch handling | P — one observed path, no sibling discovery | P — one observed path | Y — current path plus materially different sibling subtrees as separate records | P — follows the current leaf; siblings not reconstructed | Y — as exported | N |
| Attachments | P — names/kinds visible in the DOM only | P — names/kinds only | P — metadata only, contents never fetched | P — metadata only | Y — as exported | N |
| Observed task status | N | N | N | N | N | N |
| Source navigation | Y | Y | Y — canonical URL only; may not resolve if the thread is gone | Y | Y | N |

Consequences the UI must honour: a DOM-captured thread never shows `full` coverage; "history backfill" is only claimed for exports; a missing sidebar item or a failed open is never treated as deletion; and no adapter ever displays a cloud-task execution state, because none is observed.

## Non-goals and authority boundaries

No terminal/CLI session management, public sharing links, private competitor APIs, source bulk deletion, provider account switching, arbitrary website permissions, graph launch feature, telemetry, payment/upsell code, or competitor assets. Additional chat and cloud-task products require separate adapters and capability evidence. A cloud agent claiming completion is not proof of completed work. Browsing history disappearing does not authorize deleting captured records.
