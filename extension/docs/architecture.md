# Threadkeeper architecture

The implementation follows the supplied `online-thread-organizer-build-prompt.md`. The reference extension trees are read-only research inputs, not application code or build inputs. All new application code is in `threadkeeper/`.

## Table view: every thread as a row, with columns the person and Claude fill (2026-11-17)

**Where it lives.** `table` is a fifth workspace view (`WORKSPACE_VIEWS`), full page only, rendered by
`manager/table/TableView.tsx`. A table needs the page's width, which Threads gives to its list and
detail. The expanded rail's view switch is now icon-only because five names do not fit its 48px slots
(each keeps its name as the accessible name and tooltip). The view stays mounted like the others but
computes and renders nothing while hidden, so a large library costs nothing on other views. Paperclip's
fused mode has no slot for it: Paperclip's sidebar decides the view there, and the shell never routes
Paperclip to a Table page (`App.tsx` skips `fusedRoute` for `table`).

**Data** (`core/thread-table.ts`, Dexie v5). Built-in columns (title, type from the provider's
category, provider, created, last active, status, project, topics, work type, messages, repository,
account) are read from the conversation and its resolved insight and never stored. Columns the person
adds are `tableColumns` rows (`text`, `number`, `checkbox`, `select`, `multi_select`, with choices and
instructions); each value is a `tableCells` row keyed `columnId|threadKey` with `source: 'manual' | 'ai'`.
An empty cell has no row. Every write goes through `coerceCellValue`, which checks the type, matches
choices without case and stores them as the column spells them. Removing a choice removes it from the
values that used it. Deleting a thread deletes its cells (`deleteConversationCascade`); backups carry
both tables, with cells restored only alongside their thread (`THREAD_CHILD_TABLES`). Hidden columns
and the sort are `settings.threadsTable`, normalized by `normalizeTableLayout`.

**The ownership rule.** A manual value is the person's. `applyAiCells` reads each cell inside its
transaction and skips any that became manual while Claude was working; planning leaves manual cells out
of the request; the cell editor saves nothing when a value is opened and left unchanged, so looking at
an AI value does not take it over. "Clear Claude's values" deletes only `ai` rows, which is the undo for
a fill.

**Claude** (`core/table-fill.ts`, `ai/claude.ts`). `planColumnFill` splits the requested rows into
those to send, manual cells kept, cells already filled (mode `empty`) and threads that may not leave the
browser (`remoteAllowedKeys`), and estimates the cost. `runColumnFill` sends 20 threads per request,
re-checks privacy before each batch, and describes each thread by its facts, gist, summary (clipped to
700 characters), topics, outcome and last ask, falling back to the opening message only when there is no summary.
The output schema is built per column: a select or multi_select with choices is a `z.enum`, so Claude
cannot invent a choice; one with no choices lets Claude name them, and the new choices are added to the
column. Up to 12 of the person's own values (from shareable threads) go along as examples. Text values
and reasons that match `containsPromptInjectionAttempt` are dropped. A failed request ends the run with
its message and keeps every value already written; an `AbortSignal` stops it between requests
and cancels an Anthropic request in flight. `suggestTableColumns` reads the 60 most recent shareable threads (title, type, provider, gist, topics)
and returns proposals that pass `normalizeColumnDraft` against the existing names. Neither counts
against `dailyAiAnalysisLimit`: both run only when the person starts them, after a dialog showing what
will be sent and roughly what it costs.

**Verified** with unit tests (`tests/unit/thread-table.test.ts`, `tests/unit/table-view.test.tsx`,
the v2 → v5 migration in `dock-payload.test.ts`) and, in Chromium against the built extension with the
Anthropic endpoint stubbed, the whole flow: columns from Claude, a hand-set value, the fill dialog, the
fill, and the hand-set value kept and used as an example rather than sent for filling. **Not verified:**
real Claude output quality for column fills, Bedrock and OpenAI-on-Bedrock request shapes for the new
calls (they reuse the same paths as library organization), and the view inside Paperclip's fused mode.

## Side-by-side accounts, start page, full navigation, organizing sessions (2026-11-13)

**Two accounts of one sign-in at once, inside the workspace** (`core/embed/profiles.ts`,
`profile-slots.ts`, `profile-seed.ts`, `core/accounts/profile-jars.ts`, `set-cookie.ts`). Each realm now
has two places an account can load in the workspace page. The *browser account* (the realm's active
account) loads in ordinary frames with the browser's own cookies, as before. One more account per realm
per page load, the *profile* account, loads in `credentialless` frames. Chromium gives every credentialless
frame of a page one shared, throwaway cookie partition per site, gone when the page closes or reloads.
That is why there is one profile account per realm per page load: showing a third account of the realm
asks to reload the page ("Switch to …"), and nothing is signed out. Adding an account no longer touches
any cookie (`add()` always stores `mode: 'embedded'`; accounts saved as `isolated` by earlier versions
are read as embedded and open in the workspace like the rest).

*Seeding.* Nothing can write cookies into that partition from outside (the cookies API cannot see it).
So when the page claims a profile slot (`PROFILE_CLAIM`), the worker turns the account's saved jar into
one declarativeNetRequest session rule per host (ids 2000–2999, priority 3): `tabIds: [the workspace
tab]`, `resourceTypes: ['sub_frame']`, an exact `urlFilter` for
`https://<host>/robots.txt?tk_profile_seed=<random nonce>`, and `append set-cookie` headers plus the usual
removal of the framing headers. The page loads that address in a hidden credentialless frame; the
browser stores the cookies in the partition; the rules are removed once every address has answered
(`PROFILE_READY`). Measured: the partition keeps about 10 KB of cookies per site. The plan writes at
most 9,200 bytes per site, leaves out analytics cookies first, and writes the sign-in cookies last. The
browser's own Cloudflare clearance is carried over for the bot check, and an account's own cookie wins
over it.

*Keeping the jar current.* A non-blocking `webRequest.onHeadersReceived` listener (`responseHeaders`,
`extraHeaders`; new `webRequest` permission) runs per workspace tab, for the realms' hosts only.
Set-Cookie headers of responses in profile frames are applied to that account's live jar. Changes are
saved 600 ms later through `service.writeJar`, encrypted like the other jars, and never for the
browser account or during a switch of the realm. `document.cookie` writes in a profile frame are made
`SameSite=None; Secure`, so the partition keeps them, and the original is sent on to the jar. Service
workers and `SharedWorker` are refused in profile frames: their requests have no frame to attribute
them to.

*Which account a frame is.* Only a frame's own isolated-world content script can say what it is (it
reads `window.credentialless`, which page scripts cannot change for it); a frame inside a known frame
inherits its parent's kind. Responses of a frame not yet known are held for up to 20 seconds, then
filed or dropped. Unknown frames have no account (they fail closed). A profile frame's captures and
"who is signed in" reports are filed under its slot's account, and refused while the slot is not
ready. They never change which account is the browser's.

*Keeping one saved sign-in consistent* (from the security review of 2026-11-13). When an account's
saved sign-in is replaced behind a page (it becomes the browser account or stops being it, finishes a
browser sign-in, or is removed), the worker retires every slot showing it and sends `PROFILE_RETIRED`
before `ACCOUNTS_CHANGED`. A retired slot files nothing, and its tabs say "<name>’s sign-in changed"
and offer a reload. After a restart, slots whose account is now the browser's are retired too, since
the switch recovery finished never reached that code. One account is shown in one workspace tab at a
time (`profile_in_use`); a slot left by a page that went away is retired instead of blocking. Set-Cookie
from a request that a page of another site started inside a profile frame is kept only when it is
`SameSite=None`, as the browser does. Navigations of the frame itself, and requests between the hosts
of one sign-in (chatgpt.com and auth.openai.com, grok.com and accounts.x.ai), are kept whole. A
browser sign-in keeps the account's earlier saved sign-in until it finishes, so cancelling loses
nothing, and it finishes by itself only when the site names someone after it began.

*Signing an added account in.* "Sign in here" opens the site's sign-in page in the profile slot. For
sign-ins that cannot finish in a frame (Google, Apple, passkeys, pop-ups), "Sign in with a browser tab"
(`ACCOUNTS_SIGNIN_BEGIN` / `FINISH` / `CANCEL`) saves the browser's own cookies for the realm, clears
them, and opens a tab. Two seconds after the site names who signed in, or when the person says so, it
copies the new cookies into the added account's jar and puts the browser's cookies back. A journal
(`accounts.signIn`) lets a worker that stopped halfway finish the job. Switching the realm's browser
account, or removing the account that is signing in, is refused until the sign-in ends.

*Workspace tab lifetime.* The extension cannot see its own page's address without the `tabs`
permission, and tab events report frame loads in the workspace as the tab loading. So the page keeps a
`tk-workspace` port open, with a beat every 20 seconds. The worker tracks the tab by that port and by
the document that said hello. It forgets the tab's rules and slots only when the tab closes or shows
another address, never on a frame load, a second workspace tab, or a worker restart.

**Start page.** `settings.startPage` (default `https://claude.ai/code`, any https address, or "" for
"where I left off") is opened once per browser tab of the workspace (sessionStorage
`threadkeeper.landed`). It is skipped when the address asks for a thread, a view or a search.

**Full navigation in frames.** claude.ai hides its sidebar and its chat/code switch when
`window.self !== window.top`. For hosts in `TOP_LEVEL_VIEW_HOSTS` (`core/embed/frame.ts`), the
isolated-world script marks a frame that sits directly in the workspace. A page-world script at
`document_start` consumes the mark, declares a global `let self = window` (which shadows the window
property for the page's own scripts), and makes `window.self` return `window.top`. If the inline script
is blocked, nothing is changed. Settings → "Show each site’s full navigation" turns it off; the frame's
name then carries the `n` option.

**Organizing sessions** (`workspace/lens.ts`, `shell/OrganizeMenu.tsx`). One model of filter (type,
provider, account), sort (recent, oldest, created, title, messages) and group serves the side
navigation, Threads and the Dashboard's pinned bar. Group by type, provider, account, last active or
repository; Threads also groups by project and status. Filters live for the page; the grouping and
order are saved per surface (`railLens`, `dashboardLens`, `threadsGroupBy`, `threadsSort`).

**Verified** with the built extension against stand-in sites (`scripts/run-profiles-e2e.mjs`, 40 checks,
in Chromium 153 and Edge 157, no security rejections): landing on Claude Code with its navigation;
adding a second account without signing anyone out; "Sign in here" in a credentialless frame while the
browser stays signed in as the first; the jar saved encrypted; identity and a capture filed under each
account; both accounts side by side in the Dashboard; the second account restored from its jar after a
reload; a replaced sign-in retiring the slot and the reload it asks for; the browser-tab sign-in round
trip. The spike in
`docs/research/2026-11-13-embedded-profiles/spike` measured the partition, the seed rule and the
navigation fix. **Not verified:** the real providers signed in (their sign-in flows, bot checks and
cookie sizes inside a credentialless frame), and online history import for added accounts. Live
capture of pages opened in a profile frame is filed per account; "Catch up" still reads only the
browser account.

## Workspace: embedded sessions and accounts (2026-11-10)

Session Control (the separate extension that kept a hand-made list of Claude Code session links per
account) is merged into Threadkeeper. The full-page manager is now a workspace with three views over
the same sessions, and sessions are saved by capture; there is no "save a session" form.

**Views** (`src/entrypoints/manager`). `App.tsx` stays the composition root. On the full page it renders
the rail (`shell/Rail.tsx`) and three always-mounted views: Browse (`browse/`: tab strip, back, forward,
reload, address, account switcher, a summary panel), Threads (the library, plus grouping by repository
or account and a Summary / Live / Split switch in the detail pane) and Dashboard (`dashboard/`: pinned
sessions in 1 to 4 panes). The side panel and the in-page overlay keep the library layout; nothing is
embedded there. `settings.activeView`, `threadsGroupBy`, `detailMode`, `surfaces` and `maxLiveFrames`
are plain settings fields.

**One iframe per session, never remounted.** `workspace/FrameStage.tsx` keeps every loaded session tab's
`<iframe>` in one layer for the life of the page and lays it over whichever `<FrameSlot>` a view renders
for that tab (position: fixed, measured with ResizeObserver). An iframe reloads when its element is moved
or recreated, so views never render iframes; switching tabs or views only moves boxes. Frames no view is
showing are `display: none` (measured: rendering stops and timers drop to 1 Hz; `visibility: hidden` and
zero size do neither). `workspace/state.ts` holds the rules as pure functions: the tab reducer, and
`planFrames`, which decides which tabs are loaded (the visible ones first, then the most recently used
up to `maxLiveFrames`) and why the others are not (`account`, `isolated`, `asleep`).

**Why pages load at all.** Every provider refuses framing (X-Frame-Options, CSP frame-ancestors). When the
manager page starts it sends `WORKSPACE_HELLO`; the worker remembers the tab and installs one *session*
declarativeNetRequest rule for it (`core/embed/rules.ts`): `tabIds: [that tab]`, `resourceTypes:
['sub_frame']`, remove `x-frame-options`, `content-security-policy` and its report-only twin. The rule is
removed when the tab closes or leaves `manager.html`. Accepted cost: declarativeNetRequest can only drop a
whole header, so documents embedded in the workspace tab lose their Content-Security-Policy; ordinary tabs
are never touched. Each iframe is sandboxed without `allow-top-navigation` (measured: without it an
embedded page can navigate the workspace away). Permissions added: `cookies` and
`declarativeNetRequestWithHostAccess` (neither adds an install warning); `nativeMessaging` is optional.
The install-time host list is unchanged.

**Capture inside embedded pages.** Content scripts now run in all frames and decide at the top whether to
act (`core/embed/frame.ts`): the top frame, or a frame whose single ancestor is this extension's own page.
Any other frame returns at once. In the worker the capture gate still refuses frames, except an embedded
one: `embeddedFrameUrl` (`core/messaging.ts`) requires this extension's content script, a remembered
workspace tab whose top document is `manager.html`, a frame id other than 0, an https address (http only
on loopback or an added site) and a matching origin; the provider is still checked against the frame's
own address. Workspace commands (accounts, the helper) are a separate class accepted only from
`manager.html` as a top-level tab: never the side panel, the overlay, a frame or a website, and no overlay
handshake token changes that.

**Accounts** (`core/accounts`, `core/workspace/realms.ts`). A *realm* is one sign-in: Claude and Claude
Code share one, ChatGPT, Codex and dots another. A Chrome profile has one set of cookies per site, and no
extension API gives a frame its own persistent cookie jar (checked: declarativeNetRequest cannot target a
frame; credentialless iframes share one throwaway jar the cookies API cannot see). So one account per
realm is signed in at a time, in Threadkeeper and in every other tab. Switching (`service.ts`) saves the
outgoing account's cookies as an AES-GCM jar in IndexedDB (`accountJars`; the non-extractable key is a
separate row), writes a journal, clears the realm's cookies, restores the incoming jar, then deletes that
jar; a worker stopped mid-switch finishes it on the next start. The jar keeps saved sign-ins out of
exports and casual reads of the database; it is not protection against code running as this extension or
a copy of the whole profile. Device cookies (Cloudflare's bot-check clearance) are left in place. Cookies
are read from the ordinary jar and two named partitions; `partitionKey: {}` is deliberately not used (it
crashed Chromium 153 when a credentialless frame held cookies). Realms that share their sign-in with a
whole ecosystem (Google, GitHub, Microsoft) are never switched. Only cookies are swapped: other site data
is shared between accounts. An account can instead live in its own Chrome profile window through the Mac
helper (`mac-helper/`, native messaging host `com.threadkeeper.accounts`), which is the only way to have
two accounts of one realm signed in at the same moment. *(Superseded on 2026-11-13: a second account of a
realm now loads beside the browser's own inside the workspace; see above. Switching the browser account
works as described here.)*

**Attribution.** A capture is filed under the realm's active account (`resolveForCapture`). The account
that was signed in before accounts existed is the *primary* account and keeps the thread-key account id
those threads already have, so no key changes. When the site reports who is signed in (the page-world
observer passes on the page's own account request; `accounts/identity.ts` accepts only bodies that name a
user) the account records it; an identity that belongs to another account makes that account the active
one, and an unknown one gets a new account, so a thread is not filed under the wrong person. Identity
reports are ignored for four seconds after a switch (a page loaded before it may still be reporting).

**Cookie bridge.** Inside an embedded frame the browser sends the site's ordinary cookies on requests, but
page scripts can read and write only `SameSite=None` ones through `document.cookie` (measured). Sites that
read a token from a cookie would break, so in frames embedded in an extension page a page-world script
(`embed-cookie-main.ts`) replaces the accessor with a local jar fed by the isolated script
(`embed-bridge.ts`), which asks the worker for the script-visible cookies of the frame's own address and
forwards assignments (`core/embed/cookie-bridge.ts`: never HttpOnly, prefix and domain rules enforced, the
address always taken from the sender). The `cookieStore` API is not bridged.

**Coding sessions.** `ConversationRecord` gains `repository` (normalized `owner/name`,
`core/repository.ts`), `pullRequestUrl`, and `agentState` with `agentStateAt`: what the page's visible
controls showed when it was last read (`core/embed/agent-state.ts`), never a claim about work on the
provider's servers. `ThreadInsight.agentRun` holds what a run did (files, commands with outcome, tests,
pull requests, what it waits on), filled on-device from tool messages and by Claude through a nullable
`agentRun` object in the analysis schema; `ANALYSIS_VERSION` is unchanged and existing analyses are not
re-billed. Related threads (`core/related.ts`) put the same session under another account, the same pull
request, branch or repository before similarity.

**Verified** in headless Chrome for Testing 153 with the built extension and local stand-ins served on the
providers' host names (`npm run test:workspace`): framing through the header rule, the cookie bridge,
capture and attribution from embedded pages, adding an account, switching both ways, the saved jar, no
capture from a provider page framed by another site, and hand-back of a new tab. **Not verified** (needs a
signed-in person): each real provider working fully inside a frame (sending, streaming, uploads, sign-in
steps that redirect to another host), bot challenges inside frames, the identity response shapes of the
real sites, and whether a provider keeps account state outside cookies.

## Online import: bounded steps, accounts, coding sessions, analysis afterwards (2026-11-12)

"Import from online accounts" (Catch up, `sync-orchestrator.ts`) bounds every wait: each browser,
database and page step has a ceiling (`STEP_TIMEOUTS`), page requests abort after 30 s
(`site-history.ts`), and a cancel ends whatever is pending. A stuck site fails with the step it was on
(no host access, page did not load, sign-in page or bot check, reader did not answer, tab closed,
three tab-by-tab conversations in a row not captured) and the run moves to the next site. The state is
saved at every step change with a heartbeat; while a run is going the library asks the worker every
5 s, and a worker that starts with a saved running state (it was stopped) ends that run as
interrupted, which the library offers to continue. A page reader whose run the worker no longer
knows is told to stop.

Before listing, the page asks its own site who is signed in (`/api/auth/session`; for Claude
`/api/account`, then `/api/bootstrap`; parsed by `accounts/identity.ts`). The answer goes through
`noteIdentity` like a page's own report, and the site is imported only if the account Threadkeeper
will file under is recorded as that same person; no answer, an unparsed one or a service that did not
take it stops the site ("could not confirm which account"), never a fallback to whichever account was
active. Conversations the page reads are held in batches of five and stored only after the site
confirms again that the same person is signed in; a different person (or a change of the active
account) drops the batch and stops the site. Tab-by-tab captures report the account they were filed
under, which must be the run's. A second account's run adds its own threads (the account is in the
thread key).

Claude Code (claude.ai/code) and Codex (chatgpt.com/codex) are tab-by-tab sites: their session list is
read from the page's links in a tab of their own and each session is opened and captured like one the
person opens (repository, pull request and run state come from the page, as for any capture). No
endpoint is used for them because none is established. An all-history run lists up to 1000 entries,
opens up to 300 not already in the library, and says when the site has more; running it again skips
what is stored and continues. A last-N-days ChatGPT or Claude run reads at most 300 conversations
needing a read (the list itself is not capped), says so, and the next run continues past them.

Hosted analysis waits for the run: the run holds a database row (`analysis-hold.ts`) that stops job
leasing in `runAnalysisJobs` (worker and pages alike) and alarm scheduling; on-device organizing still
runs per thread. When the run ends (finished, cancelled, failed, or found dead after a restart) the
hold is released, the jobs queued during it are made due at once and the queue is kicked. A hold not
renewed for 10 minutes stops counting.

## Retrieval continuation (2026-11-10)

The manager searches its extension-owned IndexedDB corpus; it does not query an Atlas database.
Typing uses lexical search and the on-device `local:hash-v1:384` vectors. Explicit Enter submission
may embed the query with the configured hosted provider, fuse compatible current thread vectors by
reciprocal rank, then rerank the filtered shortlist. Repository, account and run filters apply before
that shortlist is built. Superseded queries abort their requests and cannot publish late results.
Privacy eligibility is checked from the database before remote work and again before publishing hosted
semantic candidates. Local-only results remain available through local search.

| Stage | Contract |
| --- | --- |
| Corpus | Captured/imported conversations, grounded summaries and messages in this browser profile; provider/account/project/workflow/coverage/kind/repository/run filters narrow candidates |
| Document recipe | `buildThreadEmbeddingDocument`: title, gist, summary, topics, entities, project/repository/branch/PR/files and bounded opening/latest turns |
| Index identity | `threadVectors`, keyed by space and thread; current `sourceRevision`, finite nonzero vector and matching dimensions required |
| Hosted identity | Voyage legacy `voyage:<model>`; Voyage Atlas alias `voyage:mongodb:<model>`; explicit Atlas `mongodb:<model>:<dimensions>` |
| Candidates | Local lexical and vector rank fusion; hosted vectors on Enter only; reranker candidates bounded by settings (default 40) |
| Rerank/context | Only remote-allowed titles, gists and excerpts; unique complete indexed scores validated before caching; malformed/failed replies preserve first-stage order; Ask retains source references |

Voyage's endpoint selector is shared by embedding and reranking. Existing persisted Voyage keys that
lack an endpoint retain the legacy host. Atlas keys are selected explicitly; the separate Atlas provider
supports global/US/EU geography and requested output dimensions. No credential is retried on another
host. Provider responses are untrusted: embedding rows require unique complete indexes, finite numeric
vectors and consistent dimensions, and rerank responses require unique complete indexes and finite
scores. Remote embeddings have a 30-second default deadline and accept cancellation.

Sources verified against the [MongoDB API overview](https://www.mongodb.com/docs/voyageai/api-reference/overview/),
[embedding API](https://www.mongodb.com/docs/api/doc/atlas-embedding-and-reranking-api/operation/operation-createtextembeddings),
and [rerank API](https://www.mongodb.com/docs/api/doc/atlas-embedding-and-reranking-api/operation/operation-rerankdocuments).
The retrieval plugin's offline contract validator was exercised on an illustrative local fixture; its
Atlas index planner is not used because no database/index deployment is part of this extension.

Rollout: select the endpoint matching the key, grant its host with Test, then rebuild the selected
vector space. Rollback: select On-device only and turn the reranker Off; captured conversations and
existing vectors stay local. Switching models/endpoints selects another space, without deleting the
old one. Paid model quality and signed-in account behavior remain separate live checks.

## v0.5 changes (2026-11-03)

v0.5 joins four workstreams; each has its own section below (Still link, opt-in AI products and any AI site,
Paperclip sync, analysis v2). What holds them together:

1. **One provider registry.** `providers.ts` is the single API for every provider: `category` is required
   (`chat`, `coding_agent`, `agent`, `builder`, `search`, `companion`, the values of Still's protocol), plus
   `hostAccess`, `captureMode`, `defaultEnabled`, `idParams` and `selectorConfidence`. `providerCategory` /
   `isProviderCategory` serve the manager filters, the Settings → Capture groups and the Still payloads, facets and
   `filters.categories`. `paperclip` (category `agent`) and `imported` have `hostAccess: 'none'`; they are the
   `NON_CAPTURE_PROVIDER_IDS`, so `CaptureProviderId` / `isCaptureProviderId` exclude them, the capture gate rejects
   them and the DOM reader never runs for them. A registry test keeps the two lists in step.
2. **Defaults for every id.** `DEFAULT_ACCOUNT_IDS` is a `Record<ProviderId, …>` (a new id does not compile
   without one); `normalizeSettings` fills `boundAccounts` for every provider and `authorizedHosts` for every capture
   provider (registry defaults), and normalizes the nested `sidebarDock` and `paperclip` settings.
3. **Service worker.** One `onMessage` handler (privileged types: `CAPTURE_TAB_NOW`, `CAPTURE_SITES_CHANGED`,
   `PAPERCLIP_SYNC_NOW`, `DOCK_*`) and a separate `onMessageExternal` listener for Still. Startup creates the analysis,
   dock (`tk-dock-reconcile`, `tk-dock-daily`) and Paperclip alarms, registers runtime content scripts, reconciles the
   Still ledger and kicks the drain. `SETTINGS_CHANGED` re-registers capture scripts, runs the Still privacy pass and
   reschedules Paperclip. Threads stored by capture (`organizeStoredThread`), finished analysis jobs and Paperclip syncs
   all mark their threads dirty for Still.
4. **Still payloads read the real records.** `dock/payload.ts` and `dock/query.ts` use the typed analysis v2 fields
   (`ThreadInsight.overview`, `produced`, `analysisVersion`; `ExtensionSummaryOutput.keyPoints`, `nextStep`;
   `ExtractedItem.rationale`) and `ConversationRecord.agentLabel`. `analysisVersion` is 0 without an AI insight and
   1 for an AI insight written before v2.
5. **Upgrading summaries from Still.** `threads.analyze` queues `requested` analysis jobs (`enqueueAnalysis(…,
   { requested: true })`), the same path as Settings → "Upgrade older summaries": they run even when automatic analysis
   is off and re-analyze a current AI insight whose `analysisVersion` is older than `ANALYSIS_VERSION`. Threads whose
   analysis is current and v2 are reported `fresh`.
6. **Manifest.** `host_permissions` stays the v0.4 list. `optional_host_permissions` holds the opt-in products' hosts,
   `https://*/*` and `http://*/*` (added sites) and `http://localhost/*`, `http://127.0.0.1/*` (Paperclip on this
   computer). `connect.html` (Still consent) is built but not web-accessible.
7. **Settings.** Sections: General, Capture (`CaptureSettings.tsx`), Paperclip (`PaperclipSettings.tsx`), AI models
   (with "Upgrade older summaries"), Amazon Web Services, Search & embeddings, Organization, Privacy & limits, Sidebar
   Dock (`SidebarDock.tsx`), Diagnostics.

## Still (Sidebar Dock) link (2026-11-03)

Threadkeeper talks to the separate Still extension over `chrome.runtime.onMessageExternal` / `sendMessage(id)`
(protocol `still-threadkeeper/1`, `docs/sidebar-dock-integration.md`). All of it lives in `src/core/dock/`:

- `protocol.ts` — constants, `threadHash` (two FNV-1a 64 over UTF-8; shared test vectors), shapes, hand validators
  for every message and every response from Still.
- `state.ts` — pairing in `settings.sidebarDock` (written only through `patchDockSettings`, a transactional nested
  merge, so the worker and the manager never overwrite each other); the single pending pair request in
  `chrome.storage.session` (`tk.dock.pending.v1`); counters (`seq`) and cursors in the `dockMeta` table.
- `payload.ts` — `ThreadSummary` / `ThreadPayload` from the conversation, the resolved insight and the structured
  summary (analysis v2 fields read when present), transcript budget (4000 messages, 120k chars each, ~3 MB, first 20 +
  newest), secret redaction for tool/system messages, validated single-quoted resume commands, the fingerprint (only
  the protocol's inputs, never a clock).
- `outbox.ts` — Dexie v3 tables `dockOutbox` (one coalescing row per thread, `dirtySeq`, lease, backoff 1/5/30/120 min,
  `local_only` removals every minute), `dockSent` (ledger per peer and epoch: fingerprint, seq, transcript revision,
  prefs hash, cheap digest), `dockTracked`. `reconcileDock` compares a cheap row digest with the ledger in pages with a
  persisted cursor (~2 s per tick, skipped within 10 min unless forced); `drainDock` decides each row at send time
  (privacy re-checked; a `local_only`/`deleted` removal is never downgraded), pushes ≤ 20 threads / ~3.9 MB with one
  push in flight and 1 s between pushes, honours `busy`, splits on `too_large`, and drops the pairing only after two
  `not_paired` answers ≥ 60 s apart. Metadata first: a transcript is sent only for a revision Still has not acknowledged
  or when it answers `needsTranscript`.
- `query.ts` — search / list / context / related / facets for Still over shareable threads only (filters apply before
  ranking): lexical + local hashed vectors, the remote query embedding and reranker only when the user allowed
  `remote_models` and the deadline allows. Transcript text and vectors are cached per thread and `sourceRevision`.
- `external.ts` — `DockService`: the external handler (sender id + extension-page origin, never a tab; check order
  sender/pairing → type → size → fields; reads at most 2 in flight and 30 per minute), pairing with a one-time code,
  `pair.granted` retried every 30 s until Still acknowledges, and the operations behind the internal `DOCK_*` messages.

Hooks: `organizeStoredThread` and each finished analysis job mark the thread dirty (debounced by
`max(60 s, aiDebounceSeconds)`); `SETTINGS_CHANGED` and `DOCK_SYNC_NOW` (sent by pages after their own writes) run the
privacy fast path; alarms `tk-dock-drain` (one-shot), `tk-dock-reconcile` (15 min), `tk-dock-daily` (hello, private
thread sweep with `chats.status`) and `tk-dock-pair` (30 s, only while a grant waits for Still). The consent page
`connect.html` is not web-accessible; `DOCK_DECIDE` is accepted only from it as a top-level page, and `DOCK_UNPAIR`,
`DOCK_SET_OPTIONS`, `DOCK_UNBLOCK` never from a frame inside a website.

Manager UI (`src/entrypoints/manager/dock.ts`, `SidebarDock.tsx`): a page client for the `DOCK_*` messages (never
throws; the overlay adds its handshake token for `DOCK_SEND`), `useDockState` (refreshed on `DOCK_CHANGED`), the
Settings → Sidebar Dock panel, the Send to Still target picker (`DOCK_COLLECTIONS`, else Still's default placement, or a
new collection name) used by the detail row, the bulk bar, search results and Ask, and the "In Still" badge
(`DOCK_STATUS_FOR`, cached two minutes per thread, invalidated on `DOCK_CHANGED` and after a send). Page writes send
`DOCK_SYNC_NOW` with the changed thread keys; writes that can make a thread private or delete it (local-only, project
moves, deletes, organize, undo) set `privacy: true` so the worker takes copies back from Still at once.

## Opt-in AI products and any AI site (capture workstream)

1. **Registry fields.** Every provider in `providers.ts` now has a `category` (`chat`, `coding_agent`, `agent`, `builder`, `search`, `companion`; shared with Sidebar Dock), a `hostAccess` (`required` = install-time host permission and static content script, the v0.4 set, unchanged; `optional` = asked for from the Settings toggle; `custom` = only on sites the user adds; `none` = imports), a `captureMode` (`passive` or `explicit`), `defaultEnabled`, `idParams` (query parameters kept in canonical URLs) and a `selectorConfidence`. Path routing still lives in `providerForPage` (chatgpt.com/dots → `chatgpt_dots`, claude.ai/duet → `claude_duet`, x.com/i/chat → `grok_bot`, huggingface.co/chat, github.com/copilot and pull-request agent sessions, cursor.com/agents, lovable.dev/projects, replit.com/@user/app) and per-provider id rules in `extractConversationIdFromUrl` (which also fixes copilot.com/chat/conversation and HuggingChat ids the generic `/chat/` rule misread).
2. **Host permissions do not grow at install.** `host_permissions` is exactly the v0.4 list (an update that adds hosts disables the extension until the user re-approves). New hosts, `www.kimi.ai`, and `https://*/*` / `http://*/*` are `optional_host_permissions`. Turning a product on requests its origins inside the click; `custom-sites.ts` then registers `content.js` for it with `chrome.scripting.registerContentScripts` (`persistAcrossSessions`, top frame, `document_idle`). The service worker reconciles registrations against settings, added sites and `chrome.permissions.contains` on install, startup, `permissions.onAdded/onRemoved`, `SETTINGS_CHANGED` and `CAPTURE_SITES_CHANGED`, and injects into tabs already open on a newly granted site. The overlay stays limited to install-time hosts (only they are web accessible); elsewhere the toolbar opens the side panel or the full library.
3. **Any AI site.** Added origins live in `chrome.storage.local` (`tk.captureSites.v1`, ≤ 50, exact origin with port; http only for loopback and private-network hosts; known providers are refused with a pointer to their toggle). The content script on a page no provider owns asks the worker `GET_CAPTURE_SITE`; only a yes (decided from `sender.url`, never from the page) enables reading. The page is then read as Open WebUI, LibreChat, LobeChat or AnythingLLM when their markup is present, else as `custom_web` with the generic and heuristic readers. Conversation ids are namespaced by host and port (`localhost-3000~<id>`); a page with no id in its address is named by a hash of its opening message. `data-tk-*` attributes and the `tk_provider` hint are ignored there.
4. **Capture gate.** `capture-gate.ts` decides every `PASSIVE_DOM_CAPTURE`: the sender must be a top frame http(s) page whose `origin` agrees with its URL (`messaging.ts captureSenderUrl`); a provider capture must come from that provider's own pages (`isProviderAllowedOnUrl`), and an added-site capture from that exact origin with its own id prefix; a canonical URL pointing elsewhere is replaced by the sender page. A content script's `explicitInvoke` no longer bypasses a turned-off provider: only a token the worker handed to that tab within 60 s does (`overlay` when Threadkeeper is opened on the page, `capture` for Settings → Capture → Capture this tab).
5. **Explicit-only Grok Bot.** X Chat carries human DMs, so `grok_bot` (off by default) is read only when it is on **and** the capture carries a `capture` token. The content script never observes X Chat; it reads the chat's open shadow root only for that request. Roles are inferred from alignment classes (low confidence).
6. **Settling.** Pages without a dependable streaming signal (generic or heuristic readers, added sites, adapters marked `stabilize`) are sent only when two reads in a row see the same text; adapters with a page-wide stop button (`docStreaming`) skip the newest reply while it is shown. Character.AI's newest-first list is reversed and keyed by content hashes.
7. **Not built:** network readers (MAIN world) and Catch up for the new products, Pi export import, and live verification. Every new adapter is tested against synthetic fixtures modelled on public exporters and the sites' own code (`tests/unit/providers-*.test.ts`); the README table lists each product's selector confidence.

## Paperclip sync (2026-11-03)

`src/core/paperclip/`. Paperclip (github.com/paperclipai/paperclip, read at commit `4d31588`, server 0.3.1) is a self-hosted server that runs companies of AI agents. Threadkeeper reads it over its REST API from the service worker (Paperclip sends no CORS headers, so content scripts cannot), with host access requested from the Settings click (`http://localhost/*` and `http://127.0.0.1/*` are optional host permissions; other hosts need a broader optional grant).

- **Model:** one thread per issue (`provider: 'paperclip'`, category `agent`, `sourceConversationId = issue.id`, the bound `paperclip` account). Messages: the description (`issue:<id>:description`, role user), comments (`comment:<id>`; user → user, agent → assistant, system/system notices → system, deleted skipped), and per run a block: a system header whose id `run:<runId>:h:<status>:<logBytes>[:s:<sessionId>]` records what makes the stored transcript reusable and the CLI session it resumed, then `run:<runId>:<n>` messages. Transcripts come from the run log (stdout JSON lines of Claude Code stream-json, `codex exec --json`, OpenCode, Grok Build, Gemini/Cursor) or, for native runs, from `/events?view=conversation` (`paperclip.prp.event.v1` items). Thinking, progress and stderr are dropped; tool calls are condensed like `cli-sessions.ts`. Bounds: 30 runs with transcripts per issue, 4 MiB of log per run, 400 messages per run, 4000 per thread.
- **New optional fields:** `ConversationRecord.agentLabel` ("Engineer · Claude Code") and `linkedThreadKeys` (Claude Code / Codex threads whose session id equals a run's `sessionIdAfter`; the expected key is stored before that session is imported). `upsertThread` keeps them across re-imports. The manager shows the agent in the meta strip and a "Linked session" / "Run by Paperclip" row.
- **Sync** (`sync.ts`, background alarm `tk-paperclip-sync` every 5 min while enabled, `PAPERCLIP_SYNC_NOW` from Settings): per company, the newest 100 runs mark changed runs' issues dirty (runs do not always bump their issue), then `issues?updatedSince=<cursor − 2 s>&sortField=updated&sortDir=asc` is paged; issues already stored at the cursor are skipped. Each changed issue is fetched in full; a finished run with an unchanged log size reuses its stored messages. State (cursors, run marks, last result/error, backoff) lives in `chrome.storage.local` `tk.paperclip.sync.v1`. Budgets: 50 s / 150 issues per alarm (a partial sync re-arms itself in 30 s), 240 s / 1000 issues for Sync now. 429 is retried in place up to 30 s, else the sync stops with backoff; failures back off 5 → 60 min. Stored threads go through `processThreadLocally` (analysis, filing by `providerProjectName` = project → goal → company, AI queue), then the issue status is applied unless the user set the status by hand.
- **Auth** (`auth.ts`): none for `local_trusted`; otherwise the CLI approval flow (`POST /api/cli-auth/challenges`, open `approvalUrl`, poll, verify with `/api/cli-auth/me`) or a pasted `pcp_board_…` key, kept in `settings.paperclip.apiKey` like other keys. Requests never send cookies.
- **Live hint** (`live.ts`): on a `local_trusted` server the worker opens `/api/companies/:id/events/ws` and schedules a sync 8 s after an issue or run event. Board keys are refused by that socket, so authenticated servers are polled only.
- **Read-only:** the only non-GET calls are the sign-in challenge and revoking Threadkeeper's own key on sign-out.

Not verified against a live Paperclip server (none was run): the shapes follow the server source and are exercised against an in-memory fake (`tests/unit/paperclip-fake-server.ts`).

## v0.4 changes (2026-11-03)

1. **Complete capture on ChatGPT and Claude.** A MAIN-world script (`site-data-main.ts`, `document_start`) clones the response to each site's own conversation request (ChatGPT `GET /backend-api/conversation/<id>`, Claude `GET /api/organizations/<org>/chat_conversations/<id>`) and posts it to the isolated content script, like the Grok on X hook. It never alters a request or response and makes no request of its own. The content script validates the sender, parses the JSON (`site-api.ts`: active branch from `current_node` / `current_leaf_message_uuid`, hidden memory turns, reasoning and tool turns, and citation widgets dropped) and sends a `network_observer` capture with coverage `full` for the conversation that is open. The background accepts only `dom_observer` or `network_observer` from a content script and never lets a DOM capture claim `full`.
2. **Messages merge by identity, not by length.** `upsertThread` used to merge a DOM capture only when it was shorter than the stored copy; a longer window that had scrolled (or a regenerated reply) replaced the stored messages, which dropped everything outside the new window. `merge.ts` aligns stored and incoming messages by site id, then by role and text between anchors, keeps what the window did not show, and replaces only the tail a new reply contradicts. A snapshot of the whole conversation (`export_import`, `network_observer`, `history_sync`) keeps its text over a DOM re-rendering and replaces the stored copy when it arrives. A title derived from the first message never replaces a title the site gave.
3. **DOM capture fixes.** Every message of a multi-message ChatGPT turn is captured (a preamble, a tool step and the final answer used to collapse to the first one), the speaker is read from the turn wrapper when the message has not rendered, all markdown blocks of one message are read, a capture can be postponed at most 4 s by a page that never goes quiet (a ticking "Thinking" timer), and after a single-page navigation the previous conversation's messages are never filed under the new URL.
4. **Check capture.** Settings → Diagnostics asks the reader in the last-used AI tab what a capture would see and returns a verdict and a counts-only report (no titles, no message text).
5. **Catch up.** `history-sync.ts`, `site-history.ts`, `sidebar-history.ts`, `sync-orchestrator.ts` and `sync-env.ts`. The service worker, started only from the library's own pages, finds or opens a tab for each chosen site and starts a reader there. ChatGPT and Claude use the page's signed-in session (same-origin GET: list, then each conversation, 0.5 to 1 s apart, one at a time, backoff on 429/5xx, stop on 401/403/non-JSON, three consecutive failures end the run, conversations already stored in full and not updated since are skipped). Other sites list the sidebar's conversation links with the provider registry's URL rules and open each in a background tab until normal capture stores it. Events from the page are validated and accepted only from the tab and run in progress; stored threads go through the normal organize and Claude-analysis queue, deleted threads stay deleted (tombstones), and a site whose capture is switched off is skipped.
6. **Catch-up brief.** `catch-up.ts`: on-device from stored summaries, or written by Claude from titles, gists, summaries, decisions, next steps and open questions only. Message text is never sent, local-only threads (thread, project or provider) never leave the device, and a thread number Claude invents is dropped.
7. **MongoDB Atlas Voyage and Cohere.** `model-apis.ts`. Atlas serves the Voyage models at `ai.mongodb.com/v1` (and `us.`, `eu.`) with its own key, so it is a separate provider and vector space from direct Voyage. Cohere is called directly on `api.cohere.com/v2` (Embed v5.0 Pro and Fast, v4.0, v3; Rerank v5.0, v4.0, v3.5). Pro and Fast of one embedding generation share a space id. Bedrock gains Cohere Embed English and Multilingual v3. The new hosts are optional host permissions requested from Settings.

### Decision: Catch up reads the sites' own undocumented endpoints

0.3 rejected private web APIs for capture and stayed DOM-first. That cannot deliver what was asked for here, a month of history without exporting, because a page only renders what the user has opened. Catch up therefore reverses that decision for ChatGPT and Claude, under these limits: it runs only when the user starts it, reads only (GET), uses the user's own signed-in session in their own browser, holds no credentials, is paced and cancellable, and stops at the first block. The passive observer reads responses the page already requested and adds no traffic. Accepted risks: the endpoints are undocumented and can change (the parsers validate every field and the run ends with an "unsupported" message instead of guessing; exports and page reading still work), and the providers' terms may restrict automated access. Every other site keeps the DOM-first rule and is read tab by tab.

Not verified against the live sites from this environment: the ChatGPT and Claude endpoint shapes and headers (`/backend-api/conversations`, `/backend-api/conversation/<id>`, `/api/auth/session`, `chat_conversations_v2`, `ChatGPT-Account-Id` for workspace accounts) follow the providers' own data exports and open-source exporters and are exercised against a mock (`npm run test:catchup`). The sidebar reader uses no per-site selectors, so it is only as good as each site's links.

## v0.3 changes (2026-11-03)

1. **Stale-manifest self-heal.** The 0.2 Edge fix only takes effect after the unpacked extension is reloaded, because Edge reads `manifest.json` on load. Every build now writes a build id into `version_name`, into the bundles and into `build-info.json`. The service worker keeps running its cached script after a rebuild (verified in Chrome for Testing 153 and Edge 155), so it compares the running manifest with a no-store fetch of `build-info.json` from disk each time it starts, and reloads once per build id (recorded first, so it cannot loop). The analysis alarms wake it every few minutes. Pages, which always load fresh code, show a Reload banner meanwhile; Settings → Diagnostics explains the state. `npm run test:edge` covers both the stale-manifest block and a rebuild while the extension runs, in real Edge.
2. **Claude backends.** `src/core/ai/backends.ts` builds one official Anthropic SDK client for the Anthropic API, Claude in Amazon Bedrock (`bedrock-mantle.{region}.api.aws/anthropic`, `anthropic.`-prefixed model ids) or Claude Platform on AWS (workspace header). The AWS-flavoured SDK packages import Node built-ins and do not bundle for a browser, so Bedrock API keys use the standard client's `apiKey` and IAM keys are SigV4-signed by a custom `fetch` (`src/core/aws.ts`, aws4fetch). Bedrock gets the client-side refusal fallback, dropped automatically if Bedrock rejects its beta header.
3. **AWS host access is optional.** `optional_host_permissions` covers `*.api.aws` and `*.amazonaws.com`; Settings requests only the endpoints of the configured region, from a click.
4. **Embeddings and reranking.** Bedrock Titan Text v2 and Cohere Embed v4 join the hosted spaces. A second-stage reranker (Voyage `rerank-3`/`rerank-3-lite`, or Bedrock Cohere Rerank 3.5 / Amazon Rerank 1.0) re-scores fused candidates on explicit search submit and in Ask, blended with first-stage rank. Bedrock API keys are rejected by the Rerank API, so key-based Bedrock reranking calls Cohere Rerank 3.5 through InvokeModel (third-party documented, marked experimental). Local-only threads are never sent and keep their first-stage position.
5. **Capture.** Grok on X is a provider (`grok_x`) captured by passively reading the `GrokConversationItemsByRestId` responses X's page already requests (MAIN-world script, never alters requests or responses); other X pages are never captured. Google AI Studio and Kimi are new providers; Copilot gains `copilot.com`. Messages are keyed by the site's own ids where present (with a one-time merge for older positional ids); streaming and thinking turns are skipped.
6. **CLI imports.** Claude Code side files (subagents, workflows, orphaned and superseded transcripts) are not threads. Codex `.jsonl.zst` rollouts are decompressed with fzstd; archived sessions are included; reverted rollouts collapse to one thread; forks are stored as branches of their root thread without the replayed history.
7. **Bulk management.** Selection across list, kanban and cards; bulk move, status, tag, pin, local-only, export and delete. Bulk edits go through `updateManualThreadFields` and are one undoable change-log entry.
8. **Research provenance.** `docs/research/2026-11-03-v0.3/` holds the source and claim ledgers and the decision report (research-first-creator, manual mode).

## v0.2 changes (2026-10-28)

1. **Edge fix — no `use_dynamic_url`.** `manager.html` was web-accessible only through a per-session dynamic ID. Chrome 153 returns that dynamic URL from `chrome.runtime.getURL()` in content scripts, but Microsoft Edge returns the static extension ID, and a static URL for a dynamic-URL resource is refused with `ERR_BLOCKED_BY_CLIENT` ("`<id>` is blocked"). The flag is gone; framing safety rests on the one-time handshake (unauthenticated frames still render only the rejection notice). Accepted cost: any website can now detect that the extension is installed by probing `chrome-extension://<id>/manager.html` (the dynamic URL used to hide this); it learns nothing else. A content-script watchdog replaces an overlay whose frame never redeems its handshake with the full-page library.
2. **Side panel is the default surface.** The toolbar button opens the browser side panel (`sidePanel.setPanelBehavior`), which needs no page frame at all; the overlay (`Alt+Shift+K`) and full page (`Alt+Shift+M`) remain. Chosen in Settings.
3. **Capture is on by default for every supported provider** (ChatGPT, Claude, Claude Code web, Codex web, Grok, Gemini, Perplexity, DeepSeek, Le Chat, Copilot). v1 shipped opt-in with every host off, so nothing was captured or organized automatically; the v2 Dexie migration turns capture on. Per-provider toggles remain in Settings.
4. **Provider registry.** `src/core/providers.ts` defines hosts, URL identity and labels; the manifest's host permissions and content-script matches are generated from it.
5. **Two analysis tiers.** An on-device analyzer runs synchronously after every capture (gist, kind, topics, entities, artifacts, grounded decisions / next steps / open questions, status). With the user's Anthropic key, a debounced job queue (alarm-driven in the service worker, leased so the manager page can also drain it) sends the thread to Claude through the official SDK with structured outputs and the server-side refusal fallback; ungrounded items are dropped rather than failing the summary.
6. **Automatic filing precedence:** manual/locked > provider project or repository > Claude > keyword routing > k-NN over confidently filed threads. A weaker signal never overrides or relabels a stronger one; every automatic assignment records its source and reason.
7. **Embeddings per space.** One vector per thread per embedding space (`threadVectors`). A local hashed space is always maintained; Voyage, OpenAI or Ollama add a hosted space. Vectors are compared only within one space.
8. **Privacy model unchanged in spirit:** local-only threads, and threads already in a local-only project, are never sent to Claude, embedding APIs or the Worker (eligibility is checked when a thread is analyzed, so an unfiled new conversation can be sent before Claude files it into a local-only project); keys live in extension IndexedDB; a daily analysis limit caps spend. No localhost or wildcard host permissions.

## Decisions (v1)

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

## Adapter capability matrix

`Y` = implemented, `P` = partial by design, `N` = not supported and must be shown as unsupported in the UI.

| Capability | Web DOM capture (ChatGPT, Claude, Claude Code web, Codex web, Grok, Gemini, Perplexity, DeepSeek, Le Chat, Copilot) | ChatGPT / Claude export | Claude Code / Codex CLI sessions | Threadkeeper portable |
|---|---|---|---|---|
| Account identification | P — user-bound label only | P — user declares the archive's account | P — bound per provider | Y — carried in the file |
| Thread discovery | P — only threads the user opens | Y — every conversation in the file | Y — every session file in the picked folder | Y |
| Content capture | P — rendered messages only | Y | Y — user, assistant, condensed tool calls/results | Y |
| History backfill | N — no undocumented endpoints | Y | Y | Y |
| Branch handling | P — one observed path | Y (ChatGPT) / P (Claude) | P — main chain; sidechains (subagents) skipped | Y |
| Provider project | P — ChatGPT/Claude Projects, repository link on coding-agent pages | N | Y — working directory / repository | Y |
| Source navigation | Y | Y — canonical URL | P — copyable resume command | Y |
| Observed task status | N | N | N | N |

Since 0.4, "history backfill" is also available without an export: Catch up reads ChatGPT and Claude through the user's signed-in session (`Y`, with dates) and other web sites tab by tab (`P`, newest conversations only, no dates). Web capture of ChatGPT and Claude also reads the site's own conversation data when the page loads it, which is stored as a `network_observer` snapshot with coverage `full`.

Consequences the UI must honour: a DOM-captured thread never shows `full` coverage; "history backfill" is claimed only for exports and Catch up; a missing sidebar item or a failed open is never treated as deletion; and no adapter ever displays a cloud-task execution state, because none is observed.

## Non-goals and authority boundaries

No terminal/CLI session control (sessions are imported read-only; resuming is the user's own command), public sharing links, private competitor APIs beyond the user-started, read-only Catch up described above, source bulk deletion, arbitrary website permissions, graph launch feature, telemetry, payment/upsell code, or competitor assets. Provider account switching was a non-goal until 2026-11-10; it is now built, within the limits in "Workspace: embedded sessions and accounts": cookies of dedicated AI sign-ins only, never a password, never an ecosystem sign-in (Google, GitHub, Microsoft), and never without the person choosing it. Additional chat and cloud-task products require separate adapters and capability evidence. A cloud agent claiming completion is not proof of completed work. Browsing history disappearing does not authorize deleting captured records.

## Analysis v2: in-depth summaries (2026-11)

`ANALYSIS_VERSION = 2` (`schema.ts`). The Claude schema (`ai/claude.ts`) asks for a gist (≤ 22 words, subject + result), a 2–4 paragraph `overview`, `keyPoints`, `produced` (label, kind, one-line description), decisions with a `rationale`, and `whereYouLeftOff` split into a past-tense `text` and an imperative `nextStep`. The legacy `summary` and `artifacts` fields are no longer requested; `analysisToInsight` derives them (`summary = overview` joined and clamped, `artifacts` from `produced`) so search, embeddings, Ask and Catch up keep reading them unchanged. The prompt tells Claude to write about the work rather than the conversation, ignore process turns ("continue", permission requests) and never start with "The user"/"The assistant". Requests run at `max(aiEffort, medium)`, with a 160k-character transcript budget (first up to 6 messages, capped at a third of the budget, plus the newest that fit; the gap is marked with its message range) and `max_tokens` 24k.

Storage needs no Dexie migration: `ThreadInsight` gains optional `overview`, `produced` and `analysisVersion`; `ExtensionSummaryOutput` gains optional `keyPoints` (grounded and verified like decisions) and `nextStep` (checked for instruction-like text); `ExtractedItem` gains an optional `rationale` (not evidence; dropped by the sanitizer if it reads like an instruction). Readers treat missing fields as older records. The on-device analyzer writes a one-paragraph `overview`.

Older AI analyses are never upgraded automatically (that would bill every thread on its next capture). `needsRemoteWork` is unchanged; an explicit request upgrades them: `analyzeThreadRemotely(…, { ignoreDailyLimit })` from the detail view ("Improve summary"), or `queueAnalysis` / `queueOlderAnalysisUpgrades` (`pipeline.ts`), which enqueue jobs flagged `requested`. Requested jobs run even when automatic analysis is off, count against the daily limit, and re-analyze a current insight whose `analysisVersion < 2`. `queueAnalysis` reports skipped threads as `fresh`, `local_only`, `no_ai` or `missing` with a list-price estimate, for Settings and for Still's `threads.analyze`.

`summary-markdown.ts` builds a thread's summary as Markdown from stored records (never from DOM text): "Copy summary", the body of the Markdown handoff (`exportThreadToMarkdown`), and any other consumer. It emits only headings, paragraphs, lists, task items, bold labels and inline code, escapes untrusted text (`mdInline`), and renders message references as `(m3)`. In the manager, overview paragraphs, key points, decisions (with rationale), produced items and topic chips are real lists, and every evidence marker and reference carries visually hidden separators, so copied text and screen readers read "Decision text (source m3)" instead of run-together fragments.
