---
id: CTX-2
title: Several accounts of one provider inside an extension, what the platform allows
level: project
kind: code
type: website
source: developer.chrome.com, source.chromium.org, learn.microsoft.com, developer.mozilla.org, privacysandbox.google.com, github.com (fetched 2026-11-13)
updated: 2026-11-13
---

# CTX-2 — Several accounts of one provider inside an extension, what the platform allows

**Kind:** code
**Type:** website
**Source:** primary browser documentation and Chromium source, fetched 2026-11-13 by a research agent

**Who this is for.** Mainly the founder's separate multi-profile workstream. This plan uses only
rows 4a and 4b (why a framed site keeps its sign-in inside the extension page) and row 11 (terms and
bot-check risk). Nothing here was tested in a browser; rows marked "needs a spike" say what to test.

## Excerpt

Main finding: no extension API scopes cookies to one frame. declarativeNetRequest's finest scope is
the tab. Inside one extension page every frame with host permission shares the profile's single
normal cookie jar. The only extra jar inside one page is the throwaway jar of a credentialless frame.

| # | Mechanism | Verdict | Key limit | Source |
|---|---|---|---|---|
| 1a | declarativeNetRequest conditions | Partial | No per-frame or per-document condition. `tabIds` works only in session rules; `-1` means "not from a tab". Session rule limit 5000 | https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest |
| 1b | Rule that sets the `Cookie` request header | Works | The network stack attaches jar cookies before the extension header hook runs, so a `set` replaces the jar's cookies for that request | https://source.chromium.org/chromium/chromium/src/+/main:net/url_request/url_request_http_job.cc |
| 1c | Rule on the `Set-Cookie` response header | Works | `append`, `set` and `remove` all work. Removing it means the cookie is never stored | https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/api/declarative_net_request/indexed_rule.cc |
| 1d | Rules on the extension's own requests | Works | Requests from the service worker have tab id -1. `modifyHeaders` needs host permission for the request URL and the initiator. Whether `initiatorDomains: [extensionId]` matches is undocumented: needs a spike | https://source.chromium.org/chromium/chromium/src/+/main:extensions/browser/api/declarative_net_request/ruleset_manager.cc |
| 2 | Non-blocking `webRequest.onHeadersReceived` with `extraHeaders` | Works | Reads `Set-Cookie` and receives the original headers before rules change them. Carries `frameId`, `parentFrameId`, `tabId`, `documentId` | https://developer.chrome.com/docs/extensions/reference/api/webRequest |
| 3 | Isolation per tab (rule with `tabIds` plus page-world overrides) | Partial | Per tab, not per frame. Requests from the site's service worker have tab id -1 and leak. Partitioned cookies are shared | See the list below |
| 4a | Normal cookies for a frame inside an extension page | Works | "Third-party cookies are never blocked even in subframes if the top-level page is a chrome-extension:// page". Requests to sites the extension has host permission for count as same-site. Covers network requests, not `document.cookie` | https://developer.chrome.com/docs/extensions/develop/concepts/storage-and-cookies |
| 4b | Other storage in that frame | Works, one jar only | With an extension top frame that has host permission, the child's storage key is computed as if the child were top-level. localStorage, IndexedDB, Cache and service workers are shared with normal tabs | https://source.chromium.org/chromium/chromium/src/+/main:content/browser/renderer_host/render_frame_host_impl.cc |
| 4c | More than one jar per site in one extension page | Does not work | Only the normal jar plus a credentialless frame's throwaway jar | Same as 4a and 4b |
| 5 | `<iframe credentialless>` | Needs a spike | Chrome and Edge 110 or newer. One nonce per top-level document, shared by every credentialless frame under it. Starts empty, cleared on unload. Popups open as `noopener`, which breaks OAuth popups. `chrome.cookies` cannot read or write it | https://developer.chrome.com/blog/iframe-credentialless |
| 6 | Freezing a hidden frame (`execution-while-not-rendered`) | Does not work | Behind the experimental web platform features flag; not shipped | https://source.chromium.org/chromium/chromium/src/+/main:third_party/blink/renderer/platform/runtime_enabled_features.json5 |
| 7 | `chrome.cookies` | Partial | Can snapshot and restore HttpOnly, Secure and `__Host-` cookies with expiry, SameSite and partition key. Cannot restore priority or creation time | https://developer.chrome.com/docs/extensions/reference/api/cookies |
| 8 | `chrome.debugger` | Partial | Can attach to the extension's own pages and reach out-of-process frames. `Target.createBrowserContext` is refused. The "started debugging" bar shows unless a command-line flag or policy hides it | https://developer.chrome.com/docs/extensions/reference/api/debugger |
| 9a | `<webview>` or Controlled Frame | Does not work for normal users | Chrome Apps no longer run on desktop. Controlled Frame is for managed ChromeOS apps | https://developer.chrome.com/docs/iwa/controlled-frame |
| 9b | Side panel | Works, with an Edge quirk | `open()` needs a user gesture. Edge's sidebar does not reappear on its own when returning to a tab | https://learn.microsoft.com/en-us/microsoft-edge/extensions/developer-guide/sidebar |
| 10a | Desktop shell with session partitions | Works | Outside the browser. Ferdium uses `persist:service-<id>` | https://www.electronjs.org/docs/latest/api/session |
| 10b | Streaming a real browser profile into a page | Partial | Screencast is experimental; latency not sourced | https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/Page.pdl |
| 10c | Rewriting proxy | Does not work reliably | Cloudflare challenge pages cannot be embedded across origins | https://developers.cloudflare.com/cloudflare-challenges/llms-full.txt |
| 11 | Bot checks, terms, device-bound sessions | Risk | Observed 2026-11-13: claude.ai and chatgpt.com send `X-Frame-Options: SAMEORIGIN`; grok.com and gemini send `DENY`. Device Bound Session Credentials shipped in Chrome 145 and are rolling out. Anthropic's consumer terms (effective 2025-10-08) forbid access "through automated or non-human means" and scraping | https://www.anthropic.com/legal/consumer-terms |

Open-source implementations found (statistics from the GitHub API on 2026-11-13):

- `worldof01/MultiAccountContainers`: MV3, no licence, 9 stars. Uses `chrome.debugger` per tab to
  inject a `Cookie` header and capture `Set-Cookie`; a page-world script prefixes localStorage,
  IndexedDB and Cache names, blocks service worker registration and overrides `document.cookie`.
- `saidurrahmanmisket/MultiLogin-Chrome-Extension`: MV3, no licence, 2 stars. Session rules with
  `tabIds` that set `Cookie` and remove `Set-Cookie`, plus `webRequest` capture. No page-world override.
- `Credshields/Chrome-Multi-Account-Containers`: MV3, MIT, 6 stars. Cookie-jar swap on tab activation.
- `mozilla/multi-account-containers`: Firefox only; Chromium has no equivalent API.

## Decisions taken from this source

- The shell stays a top-level extension page and every embedded site is its direct child (rows 4a, 4b).
  This plan's REQ-5 relies on that for the Paperclip frame.
- REQ-11 records the terms and bot-check risk from row 11.

## Not used

- The six candidate designs for running several accounts at once, and the ten spikes the research
  proposed. They belong to the separate workstream. The spikes, in short: whether a rule-set `Cookie`
  header reaches a `credentials: 'omit'` request; whether `initiatorDomains: [extensionId]` matches;
  credentialless frames inside an extension page; partitioned cookies under the extension origin;
  freezing a hidden frame; whether a debugger header override replaces jar cookies; how device-bound
  sessions react to a jar swap; Cloudflare challenges inside an extension frame; streaming latency;
  the OpenAI and xAI terms, which were not read.
