# Decision report: side-by-side accounts, full navigation, start page, organizing sessions

Date: 2026-11-13. Session folder: `docs/research/2026-11-13-embedded-profiles/`.
Sources: `sources/sources.jsonl` (ids `src_...`). Claims: `artifacts/claim_ledger.jsonl` (ids `clm_...`).

## Context

The owner asked for:

- several signed-in accounts per AI provider inside the extension, like several browser profiles in one;
- Claude Code as the default landing page, changeable in Settings, with no provider navigation cut off;
- moving between accounts from the tabs, the session sidebar and the account menu;
- indexing per signed-in profile;
- filter, sort and group for the sidebar, Threads and the Dashboard.

Three research agents looked at (1) MV3 session isolation, (2) why claude.ai hides its sidebar and Chat/Code switch in an iframe, and (3) filter/sort/group patterns in session managers. We then measured the key platform behaviour ourselves in a spike (Chromium 153 and Edge 157) and ran the built extension against local stand-in sites. Nothing was tested on the real provider sites.

Short answer:

- No stable extension API isolates one frame inside a tab (`clm_no-frame-level-dnr`). Prior art isolates per tab (`clm_prior-art-isolates-per-tab`).
- A credentialless frame gets its own cookie partition, shared by all credentialless frames of the page (`clm_credentialless-shared-partition`, `clm_credentialless-isolated-from-jar`).
- Threadkeeper fills that partition by appending `Set-Cookie` to one exact nonce URL with a DNR session rule (`clm_dnr-seed-rule-sets-partition-cookies`). So one extra account per provider per page load runs next to the browser account.

## Feature comparison matrix

SHAs are exactly as recorded in the reports. "not recorded" means the report has no SHA for that item.

| Requirement | Finalist(s) | Evidence | Gap | License decision | Original design choice |
|---|---|---|---|---|---|
| Several accounts of one provider at once inside the extension | `guhunderscore/SessionWoy`, `Misyuk-T/splitsession`, `projectGloria/BrowserContainers`, `anhkiet75/session-shift`, `houtanrocky/chrome-extension-session-switcher`, `worldof01/MultiAccountContainers`, `Manho/Panelize` (`src_sessionwoy` ... `src_panelize`) | `guhunderscore/SessionWoy@e7526c5848be8a0b7d2acd9f3965c7b3cd97cdc2:extension/src/shared/rules.ts#L148-L156`; `Misyuk-T/splitsession@6b0d37eca19ccae8dc43886b11d1f3cd85b1f9a9:src/core/dnr/rule-compiler.ts#L23-L24`; `projectGloria/BrowserContainers@385278d8d147f68996853ce1432b39513674605c:src/background/isolation/compileRules.ts#L141-L150`; `anhkiet75/session-shift@69ce1559076595b5f1fbac8b496b0739ab54655c:src/background/dnr-cookie-rule-builder.ts#L179-L186`; `chromium/chromium@6a4920c49308cae71a11fbb3580aa38f4bf13a89:extensions/common/api/declarative_net_request.webidl#L228-L442` (no frame field). Claims `clm_prior-art-isolates-per-tab`, `clm_no-frame-level-dnr` | All isolate per tab or tab group, none per frame. Panelize shows one account per site only. No repo met 100 stars with a commit in 75 days (widened to 50 stars and 180 days). | SessionWoy, session-switcher, MultiAccountContainers: no licence, reference only. BrowserContainers: README says MIT, no licence file. splitsession, session-shift, Panelize: MIT. No code copied (`clm_licences-isolation-repos`, unresolved). | Credentialless frames as the profile partition, seeded from the saved jar by a DNR session rule on an exact nonce URL in a hidden credentialless frame: `src/core/embed/profile-seed.ts`, `src/core/embed/profile-slots.ts`, `src/core/embed/profiles.ts`, `src/entrypoints/manager/workspace/FrameStage.tsx`. Measured: `clm_dnr-seed-rule-sets-partition-cookies`, `clm_two-accounts-simultaneous`. Limit: one profile account per provider per page load (`clm_credentialless-shared-partition`). |
| Keeping each account's sign-in saved | Same repos (webRequest `Set-Cookie` capture): SessionWoy `.../extension/src/background/index.ts#L688-L713`; splitsession `cookie-capture.ts` (path only, no line recorded) | `guhunderscore/SessionWoy@e7526c5848be8a0b7d2acd9f3965c7b3cd97cdc2:extension/src/background/index.ts#L688-L713`; `chromium/chromium@6a4920c49308cae71a11fbb3580aa38f4bf13a89:extensions/browser/api/web_request/extension_web_request_event_router.cc#L1244-L1246`. Claims `clm_webrequest-sees-removed-set-cookie`, `clm_cookies-api-blind-to-partition` | `chrome.cookies` cannot see the partition (measured), so the jar must be rebuilt from network traffic. Service-worker requests carry tabId -1 (`clm_sw-requests-no-tab`). | Same as above; ideas only. | Non-blocking `webRequest.onHeadersReceived` listener in `src/entrypoints/background.ts` applies `Set-Cookie` of profile-frame responses to the account jar (`src/core/accounts/profile-jars.ts`, `src/core/accounts/set-cookie.ts`), saved encrypted. Service workers and SharedWorker refused in profile frames. Reload test: `clm_saved-signin-reseeded`. |
| Switching accounts from tabs, sidebar and menu | none of the finalists covers this UI; UI report finalists for rows and menus: `siteboon/claudecodeui`, `lobehub/lobehub` | `siteboon/claudecodeui@a3a1d3a:src/modules/sidebar/SessionOptions.tsx#L39-L47` (shared row options); `lobehub/lobehub@cb7aa3e:src/features/AgentSidebar/Topic/useFilterMenu.tsx#L34-L37` | No reviewed project switches accounts of one provider. Our e2e switches through worker messages, not through the three click paths (`clm_ui-switch-from-tabs-sidebar-menu`, unresolved). | claudecodeui AGPL-3.0, LobeHub custom: pattern only, no files. | `src/core/accounts/service.ts` (switch, plus browser-tab sign-in with journal), `src/entrypoints/manager/accounts/AccountMenu.tsx`, `shell/RailAccounts.tsx`, `browse/TabStrip.tsx`. Cookie-level switching and restore: `clm_switch-browser-account`. |
| Claude's full navigation in a frame | `FlorianMartins/HiveyAI-Sidebar`; also `ParkerCai/parallel-ai-extension`, `30bewater/Qshot`, `xiaolai/insidebar-ai`, `taoAIGC/AICompare` | `FlorianMartins/HiveyAI-Sidebar@394d20b9e904be50a9449533b33696cfd8163035:src/content/webchat-top.js#L9-L14` and `webchat-bridge.js#L27-L40`; PR https://github.com/FlorianMartins/HiveyAI-Sidebar/pull/33; `ParkerCai/parallel-ai-extension@944276d8146d11d5719a83cc550de31e4354a1c4:src/content/claude-helper-button.ts#L1-L3`; `30bewater/Qshot@1610d5280d24b9839ec81c9518f685ec6707c1b7:src/iframe/iframe-anti-detect.js#L1-L25`. Claims `clm_claude-uses-self-top-check`, `clm_self-top-fix-in-spike`, `clm_top-level-view-scoped` | Hivey tested only the signed-out page in Firefox. Cause is one third-party reading of claude.ai JS. Not tested on real claude.ai, nor on `/code` (`clm_fix-works-on-real-signed-in-claude`, `clm_claude-code-shares-shell`). | Hivey MIT: idea reimplemented, no code copied. Qshot and AICompare GPL-3.0: not used (`clm_licences-embedding-repos`, unresolved). | `src/core/embed/profile-page.ts` (`presentAsTopLevel`), `src/core/embed/frame.ts` (`TOP_LEVEL_VIEW_HOSTS`, `wantsTopLevelView`), `src/core/embed/cookie-shim.ts`; isolated-world script marks only a frame directly in the workspace; Settings toggle in `src/entrypoints/manager/SettingsDialog.tsx`. Measured on a stand-in: `clm_self-top-fix-in-spike`, `clm_top-level-view-scoped`. |
| Start page | no finalist; UI/embedding repos not relevant | not recorded (no report evidence; design decision) | none from research. | none: idea only, fresh code | `src/core/schema.ts` (`DEFAULT_START_PAGE` = `https://claude.ai/code`, `normalizeStartPage`: https only), `src/entrypoints/manager/App.tsx` (landing once per browser tab), Settings. `clm_start-page-default`. |
| Captures filed per account | none; our own design | not recorded in reports; our e2e `clm_captures-per-account` | Frame kind is known only from the frame's own isolated-world script (`window.credentialless`); unknown frames fail closed. | none: fresh code | `src/core/embed/profiles.ts`, `profile-slots.ts`, `src/entrypoints/background.ts` file captures and "who is signed in" reports under the slot's account. |
| Filter / sort / group | `makeplane/plane`, `lobehub/lobehub`, `LibreChat-AI/LibreChat`, `open-webui/open-webui`, `BloopAI/vibe-kanban`, `siteboon/claudecodeui`, `generalaction/emdash`, `xcv58/Tab-Manager-v2` (anti-pattern) | `makeplane/plane@290383d:packages/constants/src/issue/filter.ts#L116-L127`, `#L156-L165`; `lobehub/lobehub@cb7aa3e:src/features/AgentSidebar/Topic/useFilterMenu.tsx#L34-L37`; `lobehub/lobehub@cb7aa3e:src/hooks/useTopicGroupCollapse.ts#L9-L15`; `LibreChat-AI/LibreChat@fad2c51:client/src/components/Conversations/chatFilters.ts` (lines `#L20`, `#L35-L50`, `#L52-L54`, `#L59-L60`); `open-webui/open-webui@b0e6098:src/lib/utils/index.ts#L1296-L1318`; `xcv58/Tab-Manager-v2@3f00f40:packages/extension/src/js/components/Toolbar/GroupAndSort.tsx#L10`. Claims `clm_ui-per-surface-table`, `clm_ui-filters-not-persisted`, `clm_ui-collapsed-keys-per-mode`, `clm_ui-organize-menu`, `clm_ui-time-buckets`, `clm_ui-grouping-not-destructive` | None combines compact sidebar, list and pinned dashboard, and none is multi-provider multi-account (`clm_ui-combination-unproven`, unresolved). | Plane and claudecodeui AGPL-3.0; LobeHub and Open WebUI custom: patterns only (`clm_licences-ui-repos`, unresolved). MIT/Apache-2.0 repos: no files copied. | `src/entrypoints/manager/workspace/lens.ts` (one pure model) and `src/entrypoints/manager/shell/OrganizeMenu.tsx` (one menu) serve the sidebar (`shell/SessionsNav.tsx`), Threads (`threads/ListPane.tsx`, `threads/grouping.ts`) and Dashboard (`dashboard/DashboardPane.tsx`). Filters live for the page; group and sort are saved per surface (`docs/architecture.md`, `src_architecture-doc`). |

## Decisions and rejected alternatives

Adopted:

1. **Credentialless iframes as the second profile partition, seeded by a DNR session rule.** Reason: nothing else isolates inside one tab (`clm_no-frame-level-dnr`), the partition is real and separate from the browser jar (`clm_credentialless-isolated-from-jar`, Chromium 153 with and without third-party-cookie blocking, and Edge 157), and seeding works (`clm_dnr-seed-rule-sets-partition-cookies`). Cost: one profile account per provider per page load; a third account asks for a reload (`clm_credentialless-shared-partition`).
2. **Rebuild the jar from `Set-Cookie` seen by `webRequest`.** The cookies API cannot read the partition (`clm_cookies-api-blind-to-partition`). The listener still sees headers the DNR rule would remove (`clm_webrequest-sees-removed-set-cookie`).
3. **Refuse service workers and SharedWorker in profile frames.** Their requests have no tab or frame (`clm_sw-requests-no-tab`).
4. **Browser-tab sign-in route** for sign-ins that cannot finish in a frame, with a journal so a stopped worker can finish (`clm_browser-tab-signin-journal`). This is the planned answer for Google, Apple and passkeys, which are untested (`clm_google-apple-passkey-in-frame`).
5. **Page-world `self` override for claude.ai**, only for a frame directly in the workspace (`clm_top-level-view-scoped`), with a Settings toggle.
6. **One lens model for three surfaces; filters not persisted; collapsed keys per mode** (`clm_ui-per-surface-table`, `clm_ui-filters-not-persisted`, `clm_ui-collapsed-keys-per-mode`).

Rejected:

- **Cookie swapping through the browser profile as the way to hold several accounts.** Prior art that isolates by DNR rules never touches the real jar (`clm_prior-art-isolates-per-tab`). Swapping signs the browser out of the other account. We keep swapping only for "make this the browser account" and for the browser-tab sign-in, both tested (`clm_switch-browser-account`, `clm_browser-tab-signin-journal`). Adding an account no longer touches cookies (`clm_two-accounts-simultaneous`).
- **Separate Chrome profile windows through a helper.** Not evaluated by the three research reports; no source or claim is recorded for it. It remains outside this design because the requirement is one workspace; this is a design choice, not a research finding.
- **Firefox-style containers.** The isolation report states Chrome has no containers API, so Firefox Multi-Account Containers is not relevant (isolation report Q1). No separate claim id; it is stated in the report only.
- **Per-frame isolation with DNR, fenced frames, `<webview>`/Controlled Frame, CHIPS partition keys.** DNR has no frame field (`clm_no-frame-level-dnr`); fenced frames cannot load arbitrary sites and Controlled Frame is for Isolated Web Apps only (`clm_controlled-frame-iwa-only`).
- **`chrome.debugger` with the Fetch domain.** It does give a frameId, but a Cookie override, the redirect behaviour and the banner cost were not verified (`clm_debugger-route`, unresolved).
- **Sec-Fetch header spoofing** (Qshot, AICompare). Nobody showed it takes effect, and AICompare's session rule is inert (`clm_sec-fetch-rewrite-unproven`, unresolved).
- **Qshot-style `parent`/`top`/`frameElement` spoof.** By the report's own inference it does not defeat a `self !== top` check (`clm_qshot-spoof-ineffective`, unresolved); we did not measure it.
- **A fallback "open in tab" UI or Cmd/Ctrl+K helper button** (parallel-ai). It does not give the Chat/Code toggle or the sidebar, so it fails "no navigation cut off" (embedding report fix 3; `src_parallel-ai`). No separate claim id.
- **Storage namespacing shims** (prefixing `localStorage` and IndexedDB names, as splitsession and session-switcher do). Not needed for the credentialless slot because its storage is already separate from the ordinary frame's (`clm_credentialless-storage-separate`). The reports and spike say nothing on whether the browser account's storage needs namespacing; not recorded.
- **Persisting filters, destructive grouping** (`clm_ui-filters-not-persisted`, `clm_ui-grouping-not-destructive`).

## Measured results

### Spike (`docs/research/2026-11-13-embedded-profiles/spike/`)

All values are from the JSON files, on a local stand-in mapped from `claude.ai`. Chromium 153 = `HeadlessChrome/153.0.0.0`; Edge 157 = `HeadlessChrome/157.0.0.0 ... Edg/157.0.0.0`.

Partition behaviour (`results-chromium153.json`, `results-chromium153-block3pc.json`, `results-edge157.json`; `clm_credentialless-shared-partition`, `clm_credentialless-isolated-from-jar`, `clm_credentialless-storage-separate`):

- `"04_credentialless_frame_initial_cookies": {}`: the partition starts empty.
- After login inside the credentialless frame: `"05_credentialless_after_login_fetch_cookies": {"sessionKey": "B", "lastActiveOrg": "org-B", "cf_clearance": "device-B"}` while `"06_browser_jar_plain"` stays `{"sessionKey": "A", ...}` and `"06_browser_jar_partitions"` lists `[]` for `https://claude.ai` and the extension origin.
- `"08_second_credentialless_frame_cookies"` shows B: a second credentialless frame shares the first one's cookies. `"15_after_host_reload_credentialless_cookies": {}`: a reload empties the partition.
- `"11_localStorage_seen_by_credentialless": null`, `"11_localStorage_shared_between_credentialless": "cred"`, `"11_localStorage_seen_by_plain_after": "plain"`.
- With third-party cookies blocked (`--block-3pc`), `"01b_control_third_party_frame_cookies": {}` for an ordinary third-party frame (it is `{"cf_clearance": "device-A"}` without the block), and the credentialless results are the same as without it.
- Edge 157 gave the same values as Chromium 153 for the findings quoted here (frame ids differ).

Seeding (finding 16, same files; `clm_dnr-seed-rule-sets-partition-cookies`):

- `"16_seeded_cookies_sent_from_credentialless": {"sessionKey": "C", "lastActiveOrg": "org-C", "domainwide": "1", "__Host-strict": "1"}`.
- `"16_browser_jar_after_seed": {"sessionKey": "A", "lastActiveOrg": "org-A", "cf_clearance": "device-A"}`.
- `"16_seed_response_as_webrequest_saw_it": [{"setCookie": [], "type": "sub_frame"}]`.
- `"20_set_cookie_removed_but_seen_by_webrequest": [["leak=1; Path=/; Secure; SameSite=Lax"]]` (`clm_webrequest-sees-removed-set-cookie`).
- `"19_cookie_header_rule_plain_frame": {"sessionKey": "Z", "lastActiveOrg": "org-Z"}` while requests through the tab service worker still carried A's cookies (`clm_cookie-header-rule-not-needed`).
- `"13_webrequest_for_sw_fetch"`: `tabId -1`, `frameId -1`, Cookie `cf_clearance=device-B; js_none=1` (`clm_sw-requests-no-tab`).

Cookie budget per site (`results-3-chromium.json`, Chromium 153 only; `clm_seed-budget-per-site`):

| Case | Stored count | Stored bytes | Kept |
|---|---|---|---|
| 100 cookies of 20 bytes | 100 | 2698 | c000 to c099 |
| 170 cookies of 20 bytes | 170 | 4588 | c000 to c169 |
| 10 cookies of 1000 bytes | 10 | 10068 | c000 to c009 |
| 40 cookies of 1000 bytes | 10 | 10068 | c030 to c039 |
| 80 cookies of 1000 bytes | 10 | 10068 | c070 to c079 |
| 20 cookies of 3900 bytes | 2 | 7812 | c018 to c019 |

So the partition keeps about 10 KB per site and drops the oldest cookies first. The architecture plan writes at most 9,200 bytes per site (`src_architecture-doc`; that figure is a design value, not a spike result). Spike 2 (`results-2-chromium.json`, `results-2-edge.json`) also shows a large seed rule accepted (`"c_large_seed_rule": {"ok": true, "id": 100}`) and `"c_large_seed_cookies_stored": {"big": 6, "huge": 4000}` in both browsers.

WebSocket handshakes (spike 2, `clm_ws-handshake-samesite`): from an ordinary frame `"seen": {"none": "A"}`, from a credentialless frame `"seen": {"none": "B"}`, from a top-level tab `{"sessionKey": "A", "strict": "A", "none": "A"}`; `fetch` from the frames sees all three. Both browsers identical. This agrees with Panelize's report (`src_panelize`) and disagrees with the Chrome docs reading (`clm_extension-frame-storage-partition`).

`self`/`top` fix (spike 2, section d; `clm_self-top-fix-in-spike`):

- Without it: `"d_plain-app": {"sidebarHidden": true, "probe": "true|set-through-self|object|true|true|parent:false", "module": "true|function"}`.
- With it, in a classic script and a module script: `"d_top-app": {"sidebarHidden": false, "probe": "false|set-through-self|object|true|false|parent:false", "module": "true|function"}`. `d_top-app-meta` and `d_top-cred-app` give the same.
- The probe's first field is `String(framed)`, so the page reads "not framed". Bare `self === window` stays true (fourth field) while `globalThis.self === window` is false, which is the effect of the `let self = window` shadow plus the `window.self` getter.
- Chromium 153 and Edge 157 gave identical values. The page is a stand-in written for the spike.
- `chrome.runtime.getFrameId` is `undefined` in an extension page (`"a_getFrameId_type": "undefined"`), so frame identity comes from the content script's report, not from that API.

### End-to-end runs of the built extension (stand-in sites on the providers' host names)

| Run | Result line | Browser | Claims |
|---|---|---|---|
| `TK_E2E_DIST=/tmp/tk-build node scripts/run-profiles-e2e.mjs` | `[profiles-e2e] security rejections recorded during the run: 0` / `[profiles-e2e] 40 checks passed` | Chromium 153, three consecutive runs; once Edge 157 (same two lines) | `clm_e2e-profiles-40` |
| `TK_E2E_DIST=/tmp/tk-build node scripts/run-workspace-e2e.mjs` | `[workspace-e2e] security rejections recorded during the run: 0` / `[workspace-e2e] 32 checks passed` | Chromium 153 | `clm_e2e-workspace-32` |
| `npx vitest run`, `npx tsc --noEmit` | `Test Files 83 passed (83)` / `Tests 1708 passed (1708)`; tsc clean | Node | `clm_unit-tests-typecheck` |

What the 40 profile checks cover (six scenarios in the script header):

1. Browser signed in as A in an ordinary tab; the workspace lands on Claude Code as A and the framed page shows its own navigation (`clm_start-page-default`, `clm_top-level-view-scoped`).
2. Adding account B signs nothing out and the add dialog promises no sign-out; "Sign in here" loads in a credentialless frame; B is signed in with navigation shown; the browser and ordinary tab stay A; B's sessions are filed under B; the jar is stored encrypted; the browser account's identity is untouched (`clm_two-accounts-simultaneous`, `clm_captures-per-account`).
3. The Dashboard shows A and Work side by side, both live.
4. After a page reload, B returns from its saved sign-in with no seeding rule left; when B's saved sign-in is replaced behind the page, B's pane asks for a reload; making Work the browser account and back puts each sign-in in the browser (`clm_saved-signin-reseeded`, `clm_switch-browser-account`).
5. Account C signs in through an ordinary browser tab: the browser's sign-in is set aside, C's is kept, A is put back once the site names C, the journal clears and the tab closes (`clm_browser-tab-signin-journal`).
6. Controls: a provider page framed by another site still hides its navigation; with the Settings toggle off the workspace leaves it hidden too (`clm_top-level-view-scoped`).

The 32 workspace checks cover capture and identity in a normal tab, the embedded frame loading past `X-Frame-Options: DENY` and CSP `frame-ancestors none`, the cookie bridge, a captured session, adding and switching accounts at the cookie level, a framed-by-another-site page not being captured, and a new-tab link handed to the workspace.

Limits of these runs: stand-in sites only; the browser was headless Chromium and Edge.

## Provenance map

Nothing was copied. Every row is idea only, with fresh code. The "attribution needed" column therefore reads none; MIT and Apache-2.0 licences would require a notice only if code had been copied.

| Requirement | Adopted idea | Evidence (source ids, claims) | Original implementation | Attribution needed |
|---|---|---|---|---|
| Accounts at once | Per-tab DNR session rules with `tabIds`, remove then set cookies, capture `Set-Cookie` with `onHeadersReceived`/`extraHeaders` | `src_sessionwoy`, `src_splitsession`, `src_browsercontainers`, `src_session-shift`, `src_chromium-source`; `clm_prior-art-isolates-per-tab` | Different mechanism: credentialless partition seeded by a nonce-URL DNR rule: `src/core/embed/profile-seed.ts`, `profile-slots.ts`, `profiles.ts`, `src/core/accounts/profile-jars.ts`, `set-cookie.ts`, `src/entrypoints/background.ts`, `FrameStage.tsx` | none: idea only, fresh code (SessionWoy, session-switcher, MultiAccountContainers have no licence; BrowserContainers no licence file) |
| Saved sign-in per account | Cookie jar kept from network `Set-Cookie`; service workers refused | `src_sessionwoy`, `src_splitsession`; `clm_webrequest-sees-removed-set-cookie`, `clm_sw-requests-no-tab` | `src/core/accounts/profile-jars.ts`, `set-cookie.ts`, `src/core/accounts/service.ts` | none: idea only, fresh code |
| Switching accounts | Shared row component and menu so surfaces do not drift | `src_claudecodeui`, `src_lobehub`; `clm_ui-organize-menu` | `AccountMenu.tsx`, `RailAccounts.tsx`, `TabStrip.tsx`, `service.ts` | none: idea only, fresh code (AGPL, custom licences; no files taken) |
| Full navigation in frame | Page-world `window.self` getter returning `window.top`, `let self = window` shadow, gated by an isolated-world mark | `src_hivey-repo`, `src_hivey-pr33`; `clm_self-top-fix-in-spike`, `clm_top-level-view-scoped` | `src/core/embed/profile-page.ts` (`presentAsTopLevel`), `frame.ts` (`TOP_LEVEL_VIEW_HOSTS`, `wantsTopLevelView`), `SettingsDialog.tsx` | none: idea only, fresh code (Hivey is MIT; no code copied) |
| Header strip on sub_frame | Remove frame-blocking headers with a tab-scoped session rule | `src_insidebar-ai`, `src_parallel-ai`, `src_qshot`; `clm_frame-header-strip-prior-art` | `src/core/embed/rules.ts` (rule helpers; not in the original list, named in `profile-seed.ts` imports) | none: idea only, fresh code (Qshot GPL-3.0 not used) |
| Start page | none from research | `clm_start-page-default` | `src/core/schema.ts`, `src/entrypoints/manager/App.tsx` | none: idea only, fresh code |
| Captures per account | none from research | `clm_captures-per-account` | `profiles.ts`, `profile-slots.ts`, `background.ts` | none: fresh code |
| Filter/sort/group | Per-surface capability table; one Organize menu; filters not persisted; collapsed keys per mode; view-only grouping | `src_plane`, `src_lobehub`, `src_librechat`, `src_tab-manager-v2`, `src_open-webui`; `clm_ui-per-surface-table`, `clm_ui-filters-not-persisted`, `clm_ui-collapsed-keys-per-mode`, `clm_ui-organize-menu` | `src/entrypoints/manager/workspace/lens.ts`, `shell/OrganizeMenu.tsx` | none: idea only, fresh code (Plane, claudecodeui AGPL-3.0; LobeHub, Open WebUI custom) |

## Unresolved

Claims left unresolved in the ledger (status `unresolved`):

- `clm_real-sites-behaviour`: behaviour on the real signed-in provider sites. Only stand-ins on 127.0.0.1 were tested.
- `clm_real-cookies-fit-budget`: whether real providers' sign-in cookies fit the 9,200-byte plan (about 9 KB) under the measured cap of 10068 bytes. Cap measured with synthetic cookies.
- `clm_google-apple-passkey-in-frame`: Google, Apple and passkey sign-in inside a credentialless frame. Untested; the browser-tab route is the fallback, tested against a stand-in only.
- `clm_fix-works-on-real-signed-in-claude`: the `self` override on the real signed-in claude.ai in Chrome and Edge (Hivey tested a signed-out page in Firefox ESR only).
- `clm_claude-code-shares-shell`: whether `claude.ai/code` shares the same helper; also whether the Chat/Code/Cowork toggle is gated by it or by feature flags.
- `clm_ui-switch-from-tabs-sidebar-menu`: switching from the tabs, sidebar and account menu is covered by worker-level e2e checks and the aggregate unit run, not by a named UI test.
- `clm_ui-combination-unproven`: no reviewed project proves the three-surface combination; unread items listed in the claim.
- `clm_debugger-route`: `chrome.debugger` Fetch cookie override, redirect carry-over and banner cost.
- `clm_redirect-race`: the 20-of-20 redirect-race figure is the project's own test, not reproduced.
- `clm_qshot-spoof-ineffective`: inference only.
- `clm_sec-fetch-rewrite-unproven`: whether Sec-Fetch rewriting takes effect or claude.ai reads those headers.
- `clm_a-claude-ai-needs-strip`: single commit-message claim about `a.claude.ai`.
- `clm_licences-isolation-repos`, `clm_licences-embedding-repos`, `clm_licences-ui-repos`: licences as reported, with no second check; no code was copied.

Also left open by the reports and not turned into ledger claims:

- Whether the official Claude in Chrome side panel frames claude.ai through a special route (issues 88104 and 90590 could not be fetched).
- Whether Anthropic bot protection, referer or `frame-ancestors` checks break frames independently of the `self` fix.
- Closed-source session-isolation extensions (SessionBox style) could not be inspected.
- Chromium forum thread ZF9-7s5BHSI (SameSite Strict/None cookies from an extension subframe) was a search-result summary only (`src_chromium-thread-zf9`).
- Storage of a service worker the user's ordinary claude.ai tab installed controlling a plain extension-page frame (isolation report Q3e); our spike measured the credentialless case only.
- The architecture doc's "Verified" paragraph still says 35 checks; the current profile run is 40.

## Refuted

None.

## Method and limits

- The research-first-creator bridge's `doctor` reported `repo-hunt-plus` and `insane-research-main` unavailable. The `hunt` discovery and the `verify` gates (`validate_ledger.py`, `verify_report.py`, `eval_report.py`) were therefore NOT run.
- The ledger and sources file were prepared by hand from the three research agents' reports and from our measured results. There is no `outputs/verified_claims.json`.
- No new web research was done for this record. Statuses follow the rules: `verified` only with an execution proof we ran or a primary source the report says it read; `supported` when a report read it and nothing was run; `unresolved` when the report flagged it as inferred or unread. Design guidance taken from another project's code (what to persist, how to group) is `supported`, not `verified`: the source shows what that project does, not what Threadkeeper should do.
- Counter-searches: where a report recorded a contrary search or contrary evidence, the ledger quotes it. For claims proven by our own measurement, no web counter-search was recorded; those claims say so in `notes` and rest on the measurement, which used stand-in sites. Licence claims have no second check recorded, so they are `unresolved`.
- Repository screens the original agents applied:
  - Isolation: no repo met 100 stars and a commit in 75 days; widened to 50 stars and 180 days, which added only Panelize (72 stars). Others have 0 to 15 stars. MultiAccountContainers (9 stars) was kept as an exception with a 192-day-old commit. GitHub search rate limits cut some queries short.
  - Embedding: no repo met 100 stars plus a head commit within 75 days that also helps with this problem; the table is widened or explicitly below the bar (Hivey 1 star, parallel-ai 16, insidebar-ai 251, Qshot 149 at 172 days, AICompare 130). GitHub rate limits cut searches short.
  - UI: every finalist met 100 or more stars and a default-branch commit within 75 days (Tab-Manager-v2 at 222 stars is the thinnest). Small session-manager repos under the bar were not read.
  - Archived or fork status was screened by the embedding report ("none is archived or a fork, except where noted"); the other two reports do not record it ("not recorded").
- Our measurements are from headless Chromium 153 and Edge 157 on macOS against local stand-ins; spike 3 was run only in Chromium 153. Multiple files from one organisation (for example Chromium source files, or several files of one repository) are not counted as independent corroboration.
- Some UI report SHAs were recorded as seven-character short SHAs and are cited that way.
- The ledger has 48 claims, more than the 20 to 35 aimed for, because the e2e scenarios and per-topic licences were split out.
