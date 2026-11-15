---
id: PLATFORM
title: Platform context
updated: 2026-11-13
commit: 9078b2b
---

# Platform context

Map of the two codebases this plan merges. Code is truth. Never put secrets here, keys only.

**Evidence labels.** `[verified]` means the planner opened the file in this session.
`[verified: scan]` means a read-only scan agent read the file and cited it, and the planner did not
re-open it. `[inferred]` is an interpretation. Nothing here was checked by running the product.

**Baselines.** Threadkeeper `main` at `9078b2b` (2026-11-12). Paperclip `master` at `edb6945ff3`
(2026-11-13), version 0.3.1, remote `https://github.com/paperclipai/paperclip.git`, licence MIT.

**Accepted implementation baseline (2026-11-13).** The founder approved the current uncommitted
working snapshot as an alternative to waiting for the separate merge, and approved pinned dependency
installation in the fork while preserving the original checkout and live extension. Source committed
base remains `9078b2b261d2e12b8bc3230090f217b40e7c9b81`; no multi-profile merge is claimed. The
443-file snapshot and original live-manifest hash/mtime are in `../verify/baseline.json`. Paperclip
base is `edb6945ff3f21f7af19580879b1e77e1605d0996`; history import is
`79589c00e99453352b0aafe1c8b5582af42284ba`, followed by the snapshot overlay. The source-snapshot
Vitest baseline passed 83 files / 1,713 tests on Node 24.22.1 (`../verify/baseline-tests.log`). That
does not establish integrated or browser acceptance. Full numbered-citation refresh remains pending.

**Path mapping after import.** Historical `src/`, `tests/`, `mac-helper/`, `shared/` and extension
scripts below now live under `extension/` in this fork; historical `paperclip/` is the fork root.
The operative plan root is `.plan/`; the original checkout's `docs/plan/` is preserved. Current
integration designs and their runtime gaps are recorded in `../verify/implementation-checkpoint.md`.
Older `[verified]` and `[verified: scan]` labels below describe the planning snapshot only unless
explicitly refreshed; do not promote them to current runtime proof.

**In flux (historical planning observation).** On 2026-11-13 (afternoon) the founder's multi-profile workstream had 66 changed tracked
files and 11 new source and test files in the Threadkeeper working tree. REQ-1 re-verifies every
citation into them before anything is built. Changed: `scripts/build-extension.mjs`;
`src/core/accounts/{contract,service}.ts`; `src/core/embed/{cookie-shim,frame,workspace-tabs}.ts`;
`src/core/schema.ts`; `src/core/workspace/types.ts`; `src/entrypoints/{background,content,embed-bridge,embed-cookie-main}.ts`;
in `src/entrypoints/manager/`: `App.tsx`, `BulkActions.tsx`, `SettingsDialog.tsx`,
`accounts/{AccountMenu,AccountsSettings,AddAccountDialog,HelperPanel}.tsx`, `accounts/sessionControlImport.ts`,
`browse/{NewTabPage,TabStrip,Toolbar}.tsx`, `dashboard/{DashboardView.tsx,shared.ts}`,
`hooks/useThreadSearch.ts`, `shell/{RailAccounts,SessionsNav,icons,primitives}.tsx`,
`styles/{10-shell,30-threads,40-dashboard,50-accounts}.css`, `threads/{ListPane.tsx,grouping.ts}`,
`workspace/{FrameStage.tsx,RestingPage.tsx,client.ts,context.tsx,state.ts,useWorkspace.ts}`; 9 unit
tests and 15 snapshots. New: `src/core/accounts/{profile-jars,set-cookie}.ts`,
`src/core/embed/{profiles,profile-page,profile-seed,profile-slots}.ts`,
`src/entrypoints/manager/accounts/PendingSignInBanner.tsx`, `shell/OrganizeMenu.tsx`,
`workspace/lens.ts`, and tests for set-cookie and lens. The names suggest per-account embedded
profiles and an organise (filter, sort, group) menu `[inferred]`; none of these files was opened.
The working-tree build script describes the Mac helper as "library backups kept on disk" and adds
the `webRequest` permission (`git diff scripts/build-extension.mjs`) `[verified]`, so the helper's
account-window role described under "APIs & integrations" may be gone after the merge.

**Live install** (2026-11-13). The founder's Microsoft Edge loads Threadkeeper unpacked from
`/Users/andrew/dev/threadkeeper/.output/chrome-mv3` with the path-based ID
`bajiblleoodfabmofjmcjeejhbjikfkp`; that folder's `manifest.json` has no `key` and reads
`version_name` `0.5.0 (build 20261113.202409-nogit)` `[verified]`. The running extension reloads
itself within minutes when the build in that folder changes, so a plain `npm run build` or
`npm run check` in the Threadkeeper root is a deploy to the founder's browser and library (the
founder's standing rule, recorded 2026-11-13). Test builds go to `TK_OUT_DIR=/tmp/tk-build` and
end-to-end runs use `TK_E2E_DIST=/tmp/tk-build`. REQ-1 FR-6 refreshes this paragraph.

## Product

- Name: Threadkeeper 0.5.0 (browser extension) and Paperclip 0.3.1 (agent orchestration server and web app).
- What it does:
  - Threadkeeper embeds AI provider sites in one extension page with tabs, captures each
    conversation into a local library, and searches it with embeddings and reranking.
  - Paperclip runs a company of AI agents: tasks, projects, goals, agent runs, approvals, costs, plugins.
- Who uses it: one solo founder, on macOS, in Microsoft Edge and Google Chrome.
- Surfaces:
  - Threadkeeper: full-page manager (`manager.html`), side panel, in-page overlay, service worker,
    content scripts, a Mac helper (native messaging host), an optional Cloudflare worker.
  - Paperclip: web UI, REST API under `/api`, WebSocket live events, the `paperclipai` CLI, agent
    adapters, a plugin runtime.

## Stack

| | Threadkeeper | Paperclip |
|---|---|---|
| Language / runtime | TypeScript 5.8, browser MV3 `[verified]` `package.json` | TypeScript, Node 24.11 or newer `[verified]` `paperclip/package.json` engines |
| UI | React 18.3, hooks only, no router, plain CSS with custom properties `[verified]` `package.json`; `[verified: scan]` `src/entrypoints/manager/App.tsx` | React 19, Vite 8, Tailwind 4, shadcn, TanStack Query 5, react-router-dom 7 `[verified: scan]` `paperclip/ui/package.json:58-107` |
| Build | esbuild through `scripts/build-extension.mjs`, output `.output/chrome-mv3` `[verified: scan]` | pnpm 9.15.4 workspace, `pnpm build` runs every package `[verified]` `paperclip/package.json` |
| Data store | IndexedDB through Dexie 4 `[verified]` `package.json`; `[verified: scan]` `src/core/db.ts:36-140` | Postgres through Drizzle; embedded Postgres when `DATABASE_URL` is unset `[verified: scan]` `paperclip/doc/DATABASE.md` |
| Auth | None of its own; uses the browser's sign-ins on provider sites | `local_trusted` or `authenticated` (better-auth session cookie, board API key, agent key or JWT) `[verified: scan]` `paperclip/server/src/middleware/auth.ts:235-540` |
| Deploy | Unpacked build folder. A build carries the fixed key from `shared/extension-key.json` unless a browser already has the folder loaded under a path-based ID, `TK_OUT_DIR` is set, or `TK_STABLE_ID=0`; `TK_STABLE_ID=1` forces the key (`scripts/build-extension.mjs:95-110`) `[verified]`. The founder's install is path-based (see "Live install") | Local service (launchd), Docker, or `pnpm dev` |
| Test runner | vitest 3.2 with fake-indexeddb and jsdom; Playwright runners for end-to-end `[verified]` `package.json` | vitest through `scripts/run-vitest-stable.mjs`; `pnpm verify` for affected tests `[verified]` `paperclip/package.json` |
| Package manager | npm with `package-lock.json` `[verified]` | pnpm; the workspace overrides `react` and `react-dom` to `^19.2.8` for every member `[verified]` `paperclip/pnpm-workspace.yaml` overrides |

## Architecture

### Threadkeeper

- Entry points `[verified: scan]` `scripts/build-extension.mjs:489-633`: `background.js` (service
  worker), content scripts `content.js`, `grok-x-main.js`, `site-data-main.js`, `embed-bridge.js`,
  `embed-cookie-main.js` (all with `all_frames: true`), pages `manager.html`, `sidepanel.html`, `connect`.
- Layers: `src/core/**` is logic with no UI (about 31.7k lines); `src/entrypoints/manager/**` is the
  React UI (about 22.3k lines); `src/entrypoints/*.ts` are the worker and content scripts `[verified: scan]`.
- Shell `[verified]` `docs/architecture.md:11-17`: `App.tsx` renders a rail (`shell/Rail.tsx`) and
  three always-mounted views, Browse, Threads and Dashboard. `settings.activeView` picks one;
  `WORKSPACE_VIEWS` is `['browse','threads','dashboard']` `[verified]` `src/core/workspace/types.ts:225`,
  `src/core/schema.ts:834`.
- Embedded pages `[verified]` `docs/architecture.md:19-37`:
  - One `<iframe>` per loaded session tab lives in `workspace/FrameStage.tsx` for the life of the
    page and is laid over whichever `<FrameSlot>` a view renders, with `position: fixed`. Views never
    render iframes, so switching views never reloads a page.
  - Hidden frames are `display: none`. `planFrames` in `workspace/state.ts` decides which tabs are
    loaded, up to `maxLiveFrames` (default 6, `src/core/workspace/types.ts:254`).
  - Provider sites refuse framing. The worker installs one session declarativeNetRequest rule per
    workspace tab (`core/embed/rules.ts`): `tabIds: [tab]`, `resourceTypes: ['sub_frame']`, remove
    `x-frame-options`, `content-security-policy` and its report-only twin.
  - Each frame is sandboxed without `allow-top-navigation`.
- A page can be a session tab only if `embedTargetFor(url)` accepts it: `https:` and a known provider
  `[verified]` `src/entrypoints/manager/workspace/state.ts:41-52`.
- Cookies in embedded frames `[verified]` `docs/architecture.md:74-80`: the browser sends the site's
  ordinary cookies on requests, but page scripts see only `SameSite=None` ones through
  `document.cookie`, so `embed-cookie-main.ts` and `embed-bridge.ts` bridge that accessor. The
  `cookieStore` API is not bridged.
- Accounts `[verified]` `docs/architecture.md:49-64`, `src/core/workspace/realms.ts:52-134`: a realm
  is one sign-in (Claude with Claude Code and Duet; ChatGPT with Codex and dots; Grok; X; Cursor;
  Meta). One account per realm is live at a time; switching swaps an encrypted cookie jar. **This is
  the part the multi-profile workstream is replacing. Do not rely on it.**
- Session groups `[verified]` `src/entrypoints/manager/workspace/state.ts:55-79`: `coding`
  (category `coding_agent`), `chats` (`chat`), `bots` (`agent`, `companion`), `more` (`builder`, `search`).
- Agent state `[verified]` `docs/architecture.md:82-89`; `[verified: scan]` `src/core/embed/agent-state.ts:49-91`:
  read from a page's visible controls, only for coding-agent providers, only while the page is loaded.
  Values: running, waiting_permission, waiting_answer, turn_complete, failed, idle, signed_out, unknown.

```
provider page (iframe in manager.html)
  -> content script (capture, agent state)
  -> service worker (capture gate, attribution)
  -> IndexedDB (conversations, messages, threadVectors, insights)
  -> manager views (Browse / Threads / Dashboard)
```

### Paperclip

- Entry points `[verified: scan]`: `server/src/index.ts` (Express 5 app built in `server/src/app.ts:494`),
  routes in `server/src/routes/*.ts` mounted under `/api` from `app.ts:709`, UI in `ui/src/main.tsx`,
  CLI in `cli/src/index.ts`.
- From this source checkout invoke the CLI directly as `node cli/node_modules/tsx/dist/cli.mjs cli/src/index.ts <command>`; `cli/src/index.ts` is the source entry point and the workspace installs its `tsx` runner.
- UI assumptions `[verified]`:
  - API base is the constant `"/api"` (`ui/src/api/client.ts:8`).
  - Routing is `BrowserRouter` (`ui/src/main.tsx:6`, `:129`).
  - WebSocket URLs are built from `window.location` (`ui/src/lib/websocket-url.ts:13-20`).
  - So the UI works only when served from its own origin. Inside an iframe on its own origin all
    three hold.
- The UI registers a service worker at `/sw.js` `[verified: scan]` `ui/src/lib/service-worker-updates.ts:96`.
- The server sends no frame-blocking header on UI routes; the only `frame-ancestors` is on the public
  MCP route `[verified]` `server/src/routes/public-mcp.ts:58` (search of `server/src`).
- Sidebar `[verified]` `ui/src/components/Sidebar.tsx:179-305`: a hand-written list of
  `<SidebarNavItem>` gated by feature flags, then plugin outlets for slot types `sidebar` (inside the
  "Work" section) and `sidebarPanel`.
- Agents `[verified: scan]` `doc/spec/agents-runtime.md`, `server/src/adapters/registry.ts`: agents
  run in bounded heartbeats through adapters (`claude_local`, `codex_local`, `cursor`, `gemini_local`,
  `grok_local`, `opencode_local`, `process`, `http` and others). A run gets `PAPERCLIP_API_URL`,
  `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID` and a run-scoped `PAPERCLIP_API_KEY`
  (`packages/adapter-utils/src/server-utils.ts:3328-3341`).
- Background service `[verified]` `cli/src/commands/service.ts:167-225`,
  `cli/src/services/service-manager.ts:158-170`, `:287`: `service install | uninstall | start | stop |
  restart | status | logs`; on macOS it writes `~/Library/LaunchAgents/<name>.plist` with `RunAtLoad`
  and `KeepAlive`. The service runs a "shim" executable from a managed install store;
  `PAPERCLIP_SHIM_PATH` overrides the path and must point at an existing executable
  (`cli/src/onboard-service.ts:141-156`). Whether a source checkout of the fork can register its own
  shim is not yet confirmed (REQ-4).
- Realtime `[verified: scan]` `server/src/realtime/live-events-ws.ts:108-110`: WebSocket at
  `/api/companies/:companyId/events/ws`, authenticated at upgrade by board session or agent key.

```
browser UI --/api + WebSocket--> Express server --> Postgres
                                   |--> heartbeat scheduler --> adapter --> local agent CLI
                                   |--> plugin workers (tools, jobs, routes, events)
```

## Data model

| Entity | Where defined | Owns | Notes |
|---|---|---|---|
| Conversation (thread, session) | `src/core/schema.ts:98-185` `[verified: scan]` | Provider, account, workspace, title, URL, workflow state, coverage, project, repository, agent state, linked thread keys | Thread key is `provider:accountId:workspaceId:sourceConversationId:branchId` (`schema.ts:70-80`); never renamed |
| Message, chunk | `src/core/schema.ts:187`, `src/core/db.ts:260-290` `[verified: scan]` | Transcript | Chunks are 3 messages, stride 2 |
| Thread vector | `src/core/schema.ts:536` `[verified: scan]` | One vector per thread per embedding space | Brute-force cosine in the browser (`src/core/embeddings.ts:661`) |
| Summary, insight | `src/core/schema.ts:261`, `:489` `[verified: scan]` | Structured summary; local or AI analysis | |
| Account, account jar | `src/core/workspace/types.ts`, `src/core/db.ts` v4 `[verified: scan]` | Sign-ins per realm; encrypted cookies | In flux |
| Settings | `src/core/schema.ts:834-889` `[verified]` | `activeView`, `detailMode`, `surfaces`, `maxLiveFrames`, `paperclip` | API keys are stored here and are included in backups (`docs/mac-helper.md:64-66`) |
| Provider | `src/core/providers.ts:10-62`, `:149` `[verified: scan]`; categories `:72-73` `[verified]` | 53 ids, category, host access, capture mode | `paperclip` and `imported` are never captured from a page |
| Paperclip issue (task) | `paperclip/packages/db/src/schema/issues.ts` `[verified: scan]` | Work item, company-scoped | Everything in Paperclip is company-scoped (`paperclip/AGENTS.md` section 5.1) |
| Paperclip agent, run | `agents`, `heartbeat_runs`, `heartbeat_run_events`, `agent_task_sessions` `[verified: scan]` | Agent config, run log, adapter session state | |
| Tool access | `paperclip/packages/db/src/schema/tool_access.ts` `[verified]` (file exists, header read) | Tool policies, invocations, approvals, audit | Policy decisions: `allow`, `deny`, `require_approval`, `rate_limited`, `defer_runtime` (`packages/shared/src/constants.ts:1180`) |
| Plugin storage | `plugins`, `plugin_state`, `plugin_entities`, `plugin_database`, `external_objects` `[verified: scan]` | Per-plugin state, a plugin-owned database namespace, references to outside things | |

## APIs & integrations

| Surface | Path / client | Auth | Limits | Notes |
|---|---|---|---|---|
| Extension to Paperclip (exists) | `src/core/paperclip/client.ts:419-543` `[verified: scan]`: `/api/health`, `/api/cli-auth/*`, `/api/companies`, `/api/companies/:id/{agents,projects,goals,issues,heartbeat-runs}`, `/api/issues/:id`, `/comments`, `/runs` | None on `local_trusted`; else a board key from the CLI approval flow (`src/core/paperclip/auth.ts`) | Poll every 5 minutes (`sync.ts`) | Read-only: an issue becomes a library thread with provider `paperclip` (`mapper.ts:600-761`) |
| Paperclip health | `GET /api/health` `[verified]` `paperclip/server/src/routes/health.ts:279-327` | Open | | Returns `status`, `version`, `serverVersion`, `deploymentMode`, `authReady`, `bootstrapStatus` |
| Plugin agent tools | Manifest `tools[]`: `name`, `displayName`, `description`, `parametersSchema` `[verified]` `paperclip/packages/shared/src/types/plugin.ts:112-121` | Capability `agent.tools.register` | | Handler receives `ToolRunContext { agentId, runId, companyId, projectId }` and returns `ToolResult { content?, data?, error? }` (`packages/plugins/sdk/src/types.ts:267-293`). How a tool reaches a running `claude_local` or `codex_local` agent goes through `server/src/services/tool-gateway.ts` and is not yet read |
| Plugin API routes | `/api/plugins/:pluginId/api/<path>` `[verified]` `packages/shared/src/types/plugin.ts:641-658` | Declared per route, through the normal auth pipeline | | A route may declare `transport: "websocket"`, but that proxies to an upstream socket chosen by the worker (`server/src/realtime/plugin-api-ws.ts:14-40`); it is not a socket that ends in the worker |
| Plugin events | `ctx.events.on(name, fn)`, `ctx.events.emit(name, companyId, payload)` `[verified]` `packages/plugins/sdk/src/types.ts:549-577` | `events.subscribe`, `events.emit` | | Names include `issue.created`, `issue.updated`, `issue.comment.created`, `issue.document.*`, `agent.run.started`, `agent.run.finished`, `agent.run.failed` (`packages/shared/src/constants.ts:1720-1755`) |
| Plugin worker to UI stream | `ctx.streams.emit(channel, event)`, read with `usePluginStream` `[verified]` `packages/plugins/sdk/src/types.ts:2055-2075` | | | |
| Plugin UI slots | `page`, `sidebar`, `routeSidebar`, `sidebarPanel`, `detailTab`, `dashboardWidget`, `settingsPage` and others `[verified]` `packages/shared/src/constants.ts:1510-1528` | `ui.*.register` | | `routePath` gives a page `/:companyPrefix/<routePath>` (`types/plugin.ts:527`). Reserved segments at `constants.ts:1542-1562`. Plugin UI is fetched and imported from a `blob:` URL (`ui/src/plugins/slots.tsx:378`, `:435`, `:451-454`), which works on Paperclip's own origin and cannot work inside an extension page |
| Still (Sidebar Dock) | Protocol `still-threadkeeper/1` over `chrome.runtime.sendMessage` between extensions `[verified]` `src/core/dock/protocol.ts:8-77` | Pairing with a one-time code | 4 MB per message; transcript budgets at `:13-15` | Requests: `threads.search`, `threads.list`, `threads.get`, `threads.context`, `threads.related`, `facets`, `thread.open`. Handlers in `src/core/dock/query.ts` (`searchThreads :597`, `listThreads :633`, `threadContext :700`, `relatedThreads :738`, `facets :793`) |
| Mac helper | Native messaging host `com.threadkeeper.accounts` `[verified]` `src/core/embed/helper-protocol.ts:6`, `docs/mac-helper.md` | Answers only extension ids it was installed for | | Three request kinds: ping, open an allow-listed https address in a profile, store or return a library backup. It runs no command from a page |
| Model APIs | Anthropic, Bedrock, Voyage, MongoDB Atlas model API, Cohere, OpenAI, Ollama `[verified: scan]` `src/core/embeddings.ts:45-117`, `src/core/rerank.ts`, `src/core/ai/backends.ts` | Keys in extension settings | | Called from the browser. Gated by `isRemoteAllowed` (`src/core/privacy.ts:10`) |

## Conventions

- File layout: Threadkeeper keeps pure logic in `src/core` and UI in `src/entrypoints/manager`;
  tests in `tests/unit/*.test.ts(x)`. Paperclip keeps contracts in sync across `packages/db`,
  `packages/shared`, `server` and `ui` (`paperclip/AGENTS.md` section 5.2) `[verified: scan]`.
- Naming: provider ids are snake case and permanent. Paperclip plugin tool names are namespaced by
  plugin id at runtime `[verified]` `packages/shared/src/types/plugin.ts:113`.
- Errors: the dock protocol's error codes are `not_paired`, `pending_approval`, `denied`,
  `bad_request`, `unsupported`, `version_mismatch`, `too_large`, `busy`, `disabled`, `not_found`,
  `internal`, and client-side `unreachable` `[verified]` `src/core/dock/protocol.ts:20-33`.
- Build identity: `BuildInfo { version, versionName, buildId, builtAt }` is stamped into every bundle
  and compared with the manifest to detect a stale reload `[verified]` `src/core/build-info.ts:8-25`.
  `buildId` is `<UTC stamp>-<git rev-parse --short HEAD of the built folder, or nogit>` and
  `versionName` is `<version> (build <buildId>)` `[verified]` `scripts/build-extension.mjs:26-37`.
  Diagnostics shows it as "Files on disk" (`src/entrypoints/manager/Diagnostics.tsx:185`).
- Build output: everything is built into `<target>.staging` and moved into the target file by file,
  manifest last, so a loaded folder is never half-written `[verified]` `scripts/build-extension.mjs:15-17`, `:39-43`.
  `node scripts/build-extension.mjs --print-id` reports the ID a build would have and builds nothing (`:675-676`).
- Paperclip database changes: edit the schema, run `pnpm db:generate`, typecheck
  (`paperclip/AGENTS.md` section 6) `[verified: scan]`.

## Env keys (names only)

| Key | Purpose |
|---|---|
| `PAPERCLIP_API_URL`, `PAPERCLIP_AGENT_ID`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_API_KEY` | Given to each agent run by the adapter |
| `PAPERCLIP_PUBLIC_URL` | Trusted origin for board mutations |
| `PAPERCLIP_SHIM_PATH` | Overrides the service shim path |
| `PAPERCLIP_INSTANCE_ID` | Selects the Paperclip instance |
| `DATABASE_URL` | External Postgres; unset means embedded |
| `TK_OUT_DIR` | Overrides the extension build output folder; such a build has no key unless `TK_STABLE_ID=1` |
| `TK_STABLE_ID` | `1` forces the fixed manifest key, `0` forces the path-based ID |
| `TK_E2E_DIST` | Points the end-to-end runners at a test build folder |
| `TK_LIVE_DIR` | Planned (REQ-3): the folder the founder's browser loads, used only by the deploy script |
| `PAPERCLIP_THREADKEEPER_EXTENSION_IDS` | Planned (REQ-5): extension IDs allowed to frame Paperclip's interface |
| Extension settings fields `anthropicApiKey`, `awsPlatformApiKey`, `voyageApiKey`, `mongodbApiKey`, `cohereApiKey`, `openaiApiKey`, `ollamaUrl`, `workerEndpointUrl`, `workerBearerToken`, `aws.*`, `paperclip.apiKey` | Model and Paperclip credentials, stored in IndexedDB settings |

## Do not reinvent

- `src/core/dock/{protocol,query,payload}.ts`: a complete external read API over the library
  (search, list, get, context, related, facets, open) with validators, size budgets, secret redaction
  and the privacy filter. The bridge in REQ-7 and the agent tools in REQ-8 reuse it.
- `src/core/privacy.ts` `isRemoteAllowed`: the single rule for what may leave the browser.
- `src/core/paperclip/{client,auth,sync,mapper,live}.ts` and `PaperclipSettings.tsx`: connection,
  pairing and issue-to-thread sync already exist.
- `src/core/host-access.ts`: reference-counted optional host grants, including the Paperclip origin.
- `workspace/FrameStage.tsx` and `<FrameSlot>`: the only way a page is embedded.
- `src/core/build-info.ts` and `src/core/diagnostics.ts`: build identity and stale-build detection.
- `docs/mac-helper.md`, "The extension ID": the checked procedure for moving a library from the
  path-based ID to the fixed-key ID through a helper backup and restore.
- Paperclip's service manager (`cli/src/commands/service.ts`) for keeping the server running.
- Paperclip's tool policy model (`packages/db/src/schema/tool_access.ts`) for who may call a tool.
- Paperclip's plugin SDK (`packages/plugins/sdk`) for agent tools, routes, events, storage and UI slots.

## Constraints

- A frame keeps its sign-in only when the top-level page is the extension's own page and the
  extension has host permission for the framed site (CTX-2 rows 4a and 4b). Provider frames and the
  Paperclip frame must therefore be direct children of `manager.html`. A provider page cannot be
  shown inside the Paperclip page.
- Live build folder: never build into, add a manifest key to, or build with `TK_STABLE_ID=1` the
  folder the founder's browser loads; the ID would change or a half-finished build would reach the
  founder's browser. Deploys are the founder's action (see "Live install").
- MV3 extension pages cannot run code fetched at run time. Paperclip's UI and its plugin UI must run
  on Paperclip's origin, inside a frame.
- The pnpm workspace forces React 19 on every member; the extension uses React 18.
- Paperclip's `docs/` folder is its documentation site (`paperclip/docs/docs.json`) `[verified]`, so
  the plan root cannot live at `docs/plan` inside the fork.
- The Mac helper works on macOS with Node 22 or newer and registers per browser
  (`docs/mac-helper.md:20-34`) `[verified]`.
- Real provider behaviour inside frames (sending, streaming, uploads, sign-in redirects, bot checks)
  has never been verified with a signed-in person (`docs/architecture.md:94-97`) `[verified]`.
- Anthropic's consumer terms forbid access "through automated or non-human means" (CTX-2 row 11).
  REQ-11 automates consumer accounts at the founder's explicit choice.

## Coverage

- Opened by the planner: `package.json`, `docs/architecture.md:1-110`, `docs/mac-helper.md`,
  `src/core/workspace/realms.ts`, `src/entrypoints/manager/workspace/launch.ts`, parts of
  `src/core/providers.ts`, `src/entrypoints/manager/workspace/state.ts:36-80`,
  `src/core/embed/helper-protocol.ts:1-60`, `src/core/dock/protocol.ts:1-77`, export lists of
  `src/core/dock/{query,payload}.ts`, `src/core/build-info.ts`, parts of `src/core/schema.ts` and
  `src/core/workspace/types.ts`; in Paperclip `package.json`, `pnpm-workspace.yaml`,
  `ui/src/api/client.ts:1-30`, `ui/src/lib/websocket-url.ts`, `ui/src/components/Sidebar.tsx:170-315`,
  parts of `packages/shared/src/constants.ts` and `packages/shared/src/types/plugin.ts`,
  parts of `packages/plugins/sdk/src/types.ts`, `server/src/realtime/plugin-api-ws.ts:1-40`,
  `cli/src/commands/service.ts:1-60`, part of `cli/src/onboard-service.ts`.
- Read by scan agents only: the rest of `src/core` and `src/entrypoints/manager`, `scripts/build-extension.mjs`,
  Paperclip's server auth, routes, schema list, plugin runtime, adapters and docs.
- Skipped: `node_modules`, `.output`, `evidence/`, `worker/` internals, Paperclip tests, Paperclip
  adapters' internals, `server/src/services/tool-gateway.ts` (needed by REQ-8 and REQ-11),
  the plugin database namespace API (needed by REQ-7), Paperclip's `Search.tsx` and command palette
  (needed by REQ-13), `Layout.tsx` and the `ui/src/components/ui` primitives (needed by REQ-6).
