# Still ⇄ Threadkeeper integration protocol (v1)

Status: the contract shared by both repositories. `sidebar-dock/docs/threadkeeper-integration.md` and
`threadkeeper/docs/sidebar-dock-integration.md` carry this same text. Change it in both places or not at all.

## Roles and principles

- **Threadkeeper (TK)** owns AI threads: capture, analysis, embeddings, reranking, search. It pushes threads to Still
  and answers Still's read requests.
- **Still (Sidebar Dock)** owns the library. It stores its **own copy** of every chat it receives (compact metadata in
  the library, summary/analysis and transcript in IndexedDB), so chats keep working when Threadkeeper is disabled,
  crashed, updating or uninstalled. Still never needs Threadkeeper to render, search, back up or ask about a chat it
  already has.
- Two separate extensions. They talk only through `chrome.runtime.sendMessage(otherExtensionId, message)` and
  `chrome.runtime.onMessageExternal`. Neither declares `externally_connectable` (the default lets extensions, never
  web pages, connect). There is no shared storage.
- **Consent on both sides.** The user turns the integration on in Still's settings (Settings → Integrations → AI chat
  threads) and chooses what to sync there. Threadkeeper additionally confirms, in its own top-level window, that this
  extension may read its threads, with a one-time code that only Still shows (see Pairing).
- **Authentication is the sender id and origin.** Chrome sets `sender.id` for external messages; another extension
  cannot forge it. Each side accepts a message only when `sender.id` is the expected id **and** the sender is an
  extension page of that id: `sender.url` starts with `chrome-extension://<id>/` or `sender.origin ===
  'chrome-extension://<id>'`, and `sender.tab` is not set. Content scripts run with their extension's id but carry a
  web page URL and a tab (Threadkeeper's capture scripts, Still's page picker); they are rejected, so a compromised web
  page cannot speak through the partner's content script.
- **Untrusted input, always.** Every message and every response is validated (types, lengths, counts, total size).
  Handlers never throw out of the listener; a malformed or hostile message never crashes the worker or blocks Still.
  Thread text is untrusted data: it never becomes instructions, never renders as HTML, and remote images in it are not
  loaded automatically.
- **Privacy.** Still's assistant sends context to remote AI providers, so Still counts as a remote destination. A thread
  that Threadkeeper may not send to remote services (`isRemoteAllowed` in `src/core/privacy.ts` is false: marked
  local-only, filed in a local-only project, from a provider excluded from cloud processing, or synthetic) is **never**
  sent to Still, never returned, listed, counted or named in any response (filters are applied before ranking), and is
  removed from Still (`threads.remove`, reason `local_only`) as soon as it stops being allowed after having been shared.
  Threadkeeper re-checks this at send time, not only when queuing. Removal of `local_only` threads is a priority lane.
- **Remote models.** Still's search text reaches Threadkeeper's embedding and rerank providers only for explicit
  searches (assistant tool calls, the Add chats picker) and only while Threadkeeper's capability `remote_models` is on.
  Automatic per-question context always uses `semantic: 'local'` and `rerank: 'off'`.

## Envelope

Every message, in both directions:

```js
{ proto: 'still-threadkeeper/1', from: 'still' | 'threadkeeper', type: '<type>', requestId: '<uuid>', ...fields }
```

Every response is a flat envelope (never wrapped in another `{ ok, result }`):

```js
{ ok: true, proto: 'still-threadkeeper/1', ...data }
{ ok: false, proto: 'still-threadkeeper/1', error: { code, message, retryAfterMs? } }
```

- A message whose `proto` is not `still-threadkeeper/1` gets `version_mismatch`. Unknown `type` → `unsupported`.
- Error codes: `not_paired`, `pending_approval`, `denied`, `bad_request`, `unsupported`, `version_mismatch`,
  `too_large`, `busy` (with `retryAfterMs`), `disabled`, `not_found`, `internal`.
- Check order on receipt: sender id/origin and pairing → `type` allowlist → size → fields. An unpaired or unknown
  sender never causes a storage write on the receiving side.
- Senders wrap every call in a timeout (default 10 s; `threads.search` 15 s; `threads.context` = its `deadlineMs` +
  1 s; `threads.get` with transcripts 30 s) and treat `chrome.runtime.lastError` ("Receiving end does not exist",
  extension disabled or missing) and timeouts as `{ ok: false, error: { code: 'unreachable' } }` (client-side code,
  never sent on the wire). A timed-out push may still be applied late; that is harmless because pushes are idempotent.
- Size: any message or response is at most **4 MB** of JSON. Receivers reject larger messages with `too_large`;
  senders split their work instead of exceeding it.
- All timestamps are ISO 8601 strings or `null`. All message indexes are **0-based ordinals** into the thread's message
  list; UIs show them as `m{index + 1}`.
- Rate limits. Threadkeeper → Still pushes: at most one in flight, and at least 1 s between the ack of one push and the
  next; Still may answer `busy` with `retryAfterMs`, which Threadkeeper honours without counting it as a failure.
  Still → Threadkeeper reads: at most 2 in flight and 30 per minute; Threadkeeper answers `busy` beyond that.

## Discovery and pairing

Extension ids of unpacked builds depend on the folder path, so neither side can hardcode the other's id.

1. **Find Threadkeeper (Still).** Settings → Integrations → AI chat threads → **Find Threadkeeper** requests the
   optional `management` permission from the click, lists installed extensions with `chrome.management.getAll()`,
   shows every enabled extension named like `Threadkeeper` (name, id, version, install type) and removes the permission
   again (`chrome.permissions.remove`). The user picks one and presses **Connect**; Still never connects on its own.
   Threadkeeper shows its own id (with Copy) under Settings → Sidebar Dock, and Still accepts a pasted id instead.
2. **`hello`** (either side, allowed unpaired, never writes state for an unpaired sender). Still sends `{ epoch }`
   when paired. Responses: Threadkeeper `{ app: 'threadkeeper', version, paired, tk: { version, capabilities } }`
   (capabilities only to the paired id); Still `{ app: 'still', version, paired, epoch }` (epoch only to the paired id).
   Used to verify an id before asking for consent, as a liveness probe, and to refresh capabilities. Threadkeeper sends
   `hello` to the paired Still whenever one of its integration toggles changes, and an inbound `hello` from the paired
   peer resets the sender's retry backoff.
3. **`pair.request`** (Still → TK, allowed unpaired): `{ appName, appVersion, code, epoch }`. `code` is 6 random digits
   that Still displays while waiting; `appName` is shown sanitized (one line, ≤ 40 chars, control/bidi characters
   removed).
   - Already paired with this sender (same id) → `{ status: 'paired', tk: { version, capabilities } }`.
   - Paired with another id → `busy` (no window opens; the user must disconnect in Threadkeeper first).
   - Otherwise Threadkeeper records the single pending request `{ senderId, requestId, appName, appVersion, codeHash,
     epoch, at }` (expires after 10 minutes) and opens its consent window (`connect.html`, a top-level popup) → `{
     status: 'pending' }`. A second sender while one request is pending → `busy`. A repeat from the same sender never
     refocuses the window and never extends the expiry; at most one window per sender per 10 minutes. A sender the user
     denied is refused (`denied`) until the user unblocks it in Threadkeeper's settings.
   - The consent window shows the self-declared name ("An extension that calls itself “Still”"), its id, what it will
     be able to do (receive the threads Still asks to sync, search and read threads, use Threadkeeper's embedding and
     rerank providers for explicit searches when allowed; never local-only threads), "Only continue if you just clicked
     Connect in Still", and a field for **the code Still is showing**. **Allow** is enabled only when the typed code
     matches; **Deny** always works. Decisions are accepted only from that top-level window (never from a framed
     Threadkeeper page).
4. **`pair.granted`** (TK → Still) `{ requestId, tk: { version, capabilities } }` after Allow; **`pair.denied`**
   `{ requestId }` after Deny. `requestId` here is the envelope `requestId` of Still's `pair.request` (the envelope key
   and the field are the same key): Still sends its pending request id as that envelope's `requestId`, and Threadkeeper
   reuses it as the `requestId` of `pair.granted` / `pair.denied`. A repeated `pair.request` from the same sender
   replaces the pending request's `requestId` and code but keeps the original expiry. Still accepts them only from the
   id it sent the pending request to, with the matching `requestId`, while that request is pending (Still's pending
   request also expires after 10 minutes). Threadkeeper counts itself paired only once Still acknowledges
   `pair.granted` with `ok: true`, and retries delivery every 30 s until the request expires. After `pair.granted` Still is `paired` but **not configured**: nothing syncs until the
   user chooses what to sync and presses **Start syncing**, which sends `sync.configure`.
5. **`pair.revoke`** (either side, paired only) `{}`: both sides forget the pairing. Threadkeeper clears its outbox, sent
   ledger, tracked list and stored prefs for that peer (after first flushing pending `local_only` removals, best
   effort). Still keeps every chat it already has (they stop updating) unless the user chose "Also remove the synced
   chats". Threadkeeper also drops the pairing after receiving `not_paired` from Still twice at least 60 s apart; Still
   sets its status to `revoked` when Threadkeeper answers `not_paired`.
6. **Epoch.** Still's `epoch` is a random id regenerated whenever its copy of the chats may no longer match what
   Threadkeeper believes it sent: new pairing, disconnect, snapshot restore, backup import, or loss of its chat store.
   Still sends the current epoch in `pair.request`, `hello` and `sync.configure`. When Threadkeeper sees a new epoch it
   discards its sent ledger for that peer, so the next reconcile re-offers every in-scope and tracked thread (Still
   answers `unchanged` cheaply for chats it still holds).
7. Capabilities in v1: `sync`, `search`, `context`, `transcripts`, `open`, `remote_models`, `analyze`. Threadkeeper
   omits `search`/`context` when its user turned off "Let Still search my threads", `transcripts` when its user turned
   off sharing transcripts, `remote_models` when its user turned off "Let Still's searches use my embedding and rerank
   providers", and `analyze` when no Claude analysis is configured.

## Data shapes

### ThreadSummary (lists, search results)

```js
{
  threadKey: string,              // Threadkeeper's stable 5-part key; Still's foreign key for a chat
  hash: string,                   // threadHash(threadKey): 32 hex (see Ids)
  title: string,                  // display title (manual override > AI title > captured)
  gist: string,                   // one line: what it is about and how it ended ('' if not analyzed)
  provider: string,               // provider id, e.g. 'chatgpt', 'claude_code', 'paperclip', 'custom_web'
  providerLabel: string,          // 'ChatGPT', 'Claude Code', ...
  category: 'chat' | 'coding_agent' | 'agent' | 'builder' | 'search' | 'companion',   // from the provider registry
  agentLabel: string,             // e.g. Paperclip agent and runner ('CEO · Grok Bot'), '' otherwise
  kind: string, kindLabel: string,           // 'coding' / 'Building', 'debugging' / 'Debugging', ...
  project: string,                // Threadkeeper project name
  workflowState: 'active' | 'needs_review' | 'waiting' | 'paused' | 'done' | 'archived',
  createdAt: string | null, updatedAt: string | null,
  messageCount: number,
  url: string,                    // https URL of the original conversation, or ''
  model: string,                  // model slug when known, else ''
  workspacePath: string,          // CLI working directory, else ''
  branchId: string, siblingThreadKeys: string[],   // conversation branches are separate threads
  analysisVersion: number,        // 0 = none, 1 = older analysis, 2 = current
  score?: number,                 // 0..1 relevance (search only)
  match?: 'strong' | 'weak',      // strong = lexical/title/summary hit or rerank score ≥ 0.5 (search only)
  matchReasons?: string[],        // deduped, ≤ 5
  excerpt?: { text: string, messageIndex: number | null, role: string } | null,
}
```

### ThreadPayload (push and `threads.get`)

```js
{
  ...ThreadSummary (without score/match/matchReasons/excerpt),
  seq: number,                    // Threadkeeper-wide monotonic counter, assigned when the payload is built
  revision: number,               // Threadkeeper sourceRevision
  contentHash: string,
  fingerprint: string,            // see Fingerprint
  coverage: 'full' | 'partial' | 'title_only' | 'metadata_only' | 'stale',
  projectSource: string,          // 'manual' | 'provider' | 'ai' | 'rules' | 'similar' | ...
  tags: string[],
  pinned: boolean,
  gitBranch: string,
  resumeCommand: string,          // only a validated, quoted command (see below), else ''
  analysis: null | {
    source: 'ai' | 'local', model: string, modelLabel: string, generatedAt: string, stale: boolean,
    analysisVersion: number,
    gist: string,
    overview: string[],           // 1-4 short paragraphs, in depth ([] from older analyses)
    summary: string,              // legacy one-paragraph summary
    userGoal: string, outcome: string, statusReason: string,
    kind: string, kindLabel: string,
    topics: string[], entities: string[], languages: string[],
    keyPoints: Array<{ text: string, refs: number[] }>,
    artifacts: Array<{ label: string, kind: string, description: string, ref: number | null }>,
    whereYouLeftOff: null | { text: string, refs: number[] },
    nextStep: string,             // the single most useful next action for the user, '' if none
    decisions:     Array<{ text: string, rationale: string, speaker: 'user_committed' | 'assistant_suggested', refs: number[], quote: string }>,
    actionItems:   Array<same>,
    openQuestions: Array<same>,
    constraints:   Array<same>,
  },
  transcript: {
    included: boolean,            // false when not needed, not requested, or transcripts are off on either side
    revision: number,             // the revision these messages belong to
    truncated: boolean,           // true when messages were cut to fit the budget
    totalMessages: number,
    from: number,                 // index of the first message included (windows)
    messages: Array<{ index: number, role: 'user' | 'assistant' | 'system' | 'tool', content: string,
                      createdAt: string | null }>,
  },
}
```

- **Transcript budget per thread** in one payload: at most 4,000 messages, 120,000 characters per message (longer ones
  are cut with `\n\n[… cut: N more characters]`), ~3 MB in total. When over budget Threadkeeper keeps the first 20
  and the newest messages that fit and sets `truncated: true`; Still fetches the missing ranges later with
  `threads.get` (`transcript: 'window'`) and merges them into its stored copy of the same revision.
- **Secrets.** Threadkeeper redacts common secret patterns in `tool` and `system` messages before sending (API keys
  like `sk-…`, `AKIA…`, `ghp_…`/`github_pat_…`, `xox…`, `Bearer …` tokens, PEM private key blocks, `KEY=value`
  lines whose name contains KEY/TOKEN/SECRET/PASSWORD) as `[redacted]`.
- **Resume command.** Only `claude --resume '<id>'` / `codex resume '<id>'`, optionally prefixed with `cd '<path>' &&`,
  where the id matches `/^[\w-]{1,128}$/` and paths are single-quoted with embedded quotes escaped; anything else is
  sent as ''. Still rebuilds and re-validates it from parts before showing or copying it.
- **Fingerprint** = a hash of exactly: `revision`, `contentHash`, title, gist, project, `workflowState`, tags,
  pinned, url, coverage, `analysis.{source, model, generatedAt, analysisVersion}`, `siblingThreadKeys`. Never
  `lastCapturedAt` or any clock value. Transcript sharing settings are tracked separately (see Delivery).

### Ids

- `threadHash(threadKey)` = two 64-bit FNV-1a hashes (offset `0xcbf29ce484222325`, prime `0x100000001b3`, over the
  UTF-8 bytes, masked to 64 bits, 16 zero-padded lowercase hex each) of `threadKey` and of `'still:' + threadKey`,
  concatenated (32 hex). Test vectors both repositories assert:
  `threadHash('chatgpt:acct_chatgpt_primary:ws_personal:abc:main') === 'a8165e07c2949d16a9c49f5c0e061c8a'`,
  `threadHash('claude_code:acct_claude_code_primary:ws_personal:5f0c-ü/x y:main') === 'ec30122ef1e1608ee0a26be36b1ad12a'`.
- Still's library id for a chat: `'chat_tk_' + threadHash(threadKey)`. Citation id for a thread that is not in Still:
  `'tk:' + threadHash(threadKey).slice(0, 16)` (a "cite id"). Threadkeeper resolves cite ids and full hashes back to
  thread keys (`threads.get` with `citeIds` / `hashes`).

### SyncPrefs (owned by Still, sent with `sync.configure`)

```js
{
  scope: 'all' | 'projects' | 'manual',   // every eligible thread / threads in chosen projects / only threads Still asked for
  projects: string[],                     // Threadkeeper project names, for scope 'projects'
  providers: string[],                    // [] = every provider
  transcripts: boolean,                   // include transcripts
  autoUpdate: boolean,                    // keep already-synced chats up to date
}
```

Threadkeeper persists the latest prefs it received per peer and applies them to every push. Still also enforces its
own prefs on receipt (it stores no transcripts when `transcripts` is off and ignores `origin: 'sync'` threads outside
its scope it does not already hold). Threads Still asked for explicitly (`threads.get` with `track: true`, or sent from
Threadkeeper with **Send to Still**) are "tracked" and kept up to date under every scope while `autoUpdate` is on, until
Still sends `threads.untrack`.

## Messages: Still → Threadkeeper

| type | fields | response data |
| --- | --- | --- |
| `hello` | `epoch?` | `{ app, version, paired, tk? }` |
| `pair.request` | `appName, appVersion, code, epoch` | `{ status: 'pending' \| 'paired', tk? }` |
| `pair.revoke` | – | `{}` |
| `sync.configure` | `prefs: SyncPrefs, epoch` | `{ queued: number, total: number }` (`total` = in-scope threads) |
| `sync.resync` | `epoch` | `{ queued: number }` |
| `sync.status` | – | `{ queued, tracked, lastPushAt, lastError }` |
| `threads.search` | `query, filters?, limit? (≤50, default 20), cursor?, semantic? ('local' \| 'auto'), rerank? ('auto' \| 'on' \| 'off'), excerpts? (bool), deadlineMs? (≤ 12000)` | `{ results: ThreadSummary[], total, nextCursor: string \| null, semantic: bool, reranked: bool }` |
| `threads.list` | `filters?, sort? ('recent' \| 'oldest' \| 'title'), cursor?, limit? (≤100)` | `{ results: ThreadSummary[], total, nextCursor: string \| null }` |
| `threads.get` | `threadKeys? (≤20) \| citeIds? (≤20) \| hashes? (≤20), transcript? ('none' \| 'full' \| 'window'), window? { from, count ≤ 500 }, track? (default false)` | `{ threads: ThreadPayload[], missing: string[], deferred: string[] }` |
| `threads.context` | `question, filters?, limit? (≤8, default 5), budgetChars? (≤24000, default 12000), semantic? ('local' \| 'auto'), rerank? ('auto' \| 'on' \| 'off'), deadlineMs? (≤ 9000, default 2500)` | `{ threads: [{ thread: ThreadSummary, passages: [{ messageIndex, role, text }] }], semantic, reranked }` |
| `threads.related` | `threadKey, limit? (≤20)` | `{ results: ThreadSummary[] }` |
| `threads.untrack` | `hashes (≤500)` | `{ untracked: number }` |
| `threads.analyze` | `threadKeys (≤50)` | `{ queued: number, skipped: [{ threadKey, reason: 'no_ai' \| 'local_only' \| 'fresh' \| 'limit' }], estimateUsd: number }` |
| `facets` | – | `{ total, providers: [{ id, label, category, count }], projects: [{ name, count }], kinds: [{ id, label, count }], states: [{ id, count }] }` |
| `thread.open` | `threadKey` | `{}` (Threadkeeper opens its library at that thread) |

`filters` (all optional, combined with AND; arrays are OR within the field):

```js
{ providers?: string[], categories?: string[], kinds?: string[], projects?: string[], states?: string[],
  since?: string, until?: string /* ISO, on updatedAt */, threadKeys?: string[], hashes?: string[] }
```

- `threads.search` runs Threadkeeper's own hybrid search: lexical (titles, gists, summaries, topics, entities,
  decisions, full message text) fused with vectors (its local hashed space always; its configured remote embedding
  space when `semantic: 'auto'` and `remote_models` is on), then optionally its reranker (`rerank: 'on'`, or `'auto'`
  when one is configured, `remote_models` is on and the deadline allows). An empty `query` with filters lists matching
  threads, most recent first. `match` lets callers keep only strong matches for "all threads about X" requests;
  `nextCursor` pages through the rest.
- `threads.context` is Ask-style retrieval: the best threads for the question and, inside each, the passages (user and
  assistant messages only, ordinals kept) that best answer it, within `budgetChars` in total. Threadkeeper honours
  `deadlineMs` by skipping or aborting remote calls, returning what it has.
- `threads.get` returns threads in request order and stops before exceeding the response size limit (always at least
  one thread); unsent requested keys come back in `deferred` (ask again), unknown or private ones in `missing`.
- Read requests answer `disabled` when the Threadkeeper user turned off "Let Still search my threads" (except
  `threads.get` with `track: true`, used for imports and sync). Transcripts are omitted when transcript sharing is off.
- `facets` never mentions private threads or local-only projects, not even with a zero count.

## Messages: Threadkeeper → Still

| type | fields | response data |
| --- | --- | --- |
| `hello` | – | `{ app: 'still', version, paired, epoch? }` |
| `pair.granted` | `requestId, tk: { version, capabilities }` | `{}` |
| `pair.denied` | `requestId` | `{}` |
| `pair.revoke` | – | `{}` |
| `threads.upsert` | `threads: ThreadPayload[] (≤50; ≤ 4 MB), origin: 'sync' \| 'manual', target?: { collectionId?: string, collectionName?: string }` | `{ results: [{ threadKey, status, reason?, itemId?, fingerprint?, seq?, needsTranscript? }] }` |
| `threads.remove` | `threadKeys (≤200), reason: 'deleted' \| 'local_only' \| 'out_of_scope'` | `{ results: [{ threadKey, status: 'removed' \| 'kept' \| 'missing' }] }` |
| `collections.list` | – | `{ collections: [{ id, name, parentId, path, icon, color }] }` |
| `chats.status` | `threadKeys (≤500)` | `{ chats: { [threadKey]: { itemId, collectionId, collectionName, trashed, hasTranscript, transcriptRevision } } }` |

- `threads.upsert` statuses: `created`, `updated`, `unchanged`, `skipped` (reasons `dismissed`, `trashed`, `invalid`,
  `stale`, `out_of_scope`, `too_large`). Every status except `skipped/too_large` counts as delivered. On `too_large`
  Threadkeeper retries once without the transcript, then counts it as delivered. On `dismissed` Threadkeeper stops
  tracking that thread for this peer until a manual send. Results carry the `fingerprint` and `seq` Still now holds,
  and `needsTranscript: true` when Still lacks the transcript for that revision (and transcripts are on), so
  Threadkeeper queues a transcript-bearing push.
- Sync pushes are **metadata first**: Threadkeeper includes a transcript only when its ledger says Still needs it
  (never acknowledged that revision, or `needsTranscript`). A payload whose `seq` is older than the one Still holds is
  `skipped/stale`.
- `origin: 'manual'` (Threadkeeper's **Send to Still**) creates chats even outside Still's sync scope, restores a chat
  from Still's Trash, and recreates one the user had deleted forever. `target` chooses the collection (an existing id,
  or a name Still finds or creates at the top level); otherwise Still's normal placement applies.
- `threads.remove`: reason `local_only` always deletes Still's stored summary and transcript for that chat; a chat the
  user never touched (no notes, subpages, tags, favorite, rename or move) is deleted outright; a touched chat keeps the
  user's notes and subpages but loses every field that came from the thread (title becomes "Private thread" unless the
  user renamed it) and is hidden from the assistant and the bridge. Reasons `deleted` and `out_of_scope` follow Still's
  "When a thread leaves Threadkeeper" preference (keep, the default, or move untouched chats to Trash); touched chats
  are always kept (`kept`).
- `chats.status` lets Threadkeeper show "In Still · <collection>" and find which private threads Still still holds.

## Delivery guarantees

- Threadkeeper keeps a durable outbox and a per-peer ledger of what Still acknowledged (fingerprint, seq, transcript
  revision, prefs hash). A push is done only when Still answers `ok: true` and the result counts as delivered. Failures
  retry with backoff (1, 5, 30, 120 minutes; `local_only` removals every minute) and a reconcile pass (after Threadkeeper
  starts, after `sync.configure` / `sync.resync`, on a new epoch, and every 15 minutes, skipped when the last one ran
  less than 10 minutes ago) re-queues anything whose state differs from the ledger. After pairing, configuring and
  daily, Threadkeeper asks `chats.status` for every thread it may no longer share and removes the ones Still holds.
  Delivery is therefore at-least-once and eventually consistent.
- Still's `threads.upsert` is idempotent: it finds the chat by its deterministic id, and a payload whose `fingerprint`
  equals the stored one is `unchanged`. Still coalesces incoming pushes into at most one library write every ~2 s
  (≤ 100 chats per write).
- A change to the transcript-sharing settings (Still's `transcripts` pref or Threadkeeper's "Share full transcripts")
  changes the ledger's prefs hash and re-offers the affected threads.

## Testing

Both repositories test their own side against a fake partner (Still: `tests/threadkeeper-*.test.mjs`; Threadkeeper:
`tests/unit/dock-*.test.ts`). The two real extensions are tested together in Chromium by Still's
`scripts/e2e-threadkeeper.mjs` (Playwright, which the repositories do not install):

```sh
(cd threadkeeper && npm run build)
TK_EXTENSION_DIR=$PWD/threadkeeper/.output/chrome-mv3 node sidebar-dock/scripts/e2e-threadkeeper.mjs --out /tmp/still-tk-e2e
```

It loads both unpacked extensions in a fresh profile, seeds Threadkeeper (its Import dialog plus its service worker
database: a ChatGPT chat, a long Claude Code session, a Paperclip agent thread, a thread in the local-only "Personal"
project and an analysis v2), pairs through Still's settings card and Threadkeeper's consent window with the code, starts
syncing, checks the chat pages (Summary, Transcript, `#msg-N`, find in chat, dark mode, side panel), updates, local-only
removal, the assistant's thread tools, **Send to Still**, and Still with Threadkeeper gone. Screenshots and
`report.json` go to `--out`; any failed check or console error in a page or worker exits with 1. `--until <step>` stops
after a step, `--bail` at the first failing one, `--headed` shows the browser.
