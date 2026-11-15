---
id: CTX-1
title: Founder request, scope change and decisions (2026-11-13)
level: plan
kind: business
type: transcript
source: planning session of 2026-11-13
updated: 2026-11-13
---

# CTX-1 — Founder request, scope change and decisions (2026-11-13)

**Kind:** business
**Type:** transcript
**Source:** the founder's messages and answers in the planning session of 2026-11-13

## Excerpt

The request, in the founder's words:

- "Completely merge this app into paperclip /Users/andrew/dev/threadkeeper/paperclip and merge functionality."
- "a big goal is to essentially connect paperclip to browser sessions, mainly through the chrome extension."
- "I also want paperclip turned into the chrome extension and merged with threadkeeper, with threadkeeper being new sidebar tabs."
- "As well as integrating embedding and reranking and everything else from threadkeeper into it."
- "I use a ton of different providers both coding and chat sessions and I get very scattered with all
  of the tasks as a solo founder so I need a way to both manually manage everything easily without
  using multiple browsers as well as having an AI agent help me."

Scope change, sent while planning was under way:

- "And actually don't worry about this part, I'm going to do this separately first while I plan the
  big part out." The part removed: several accounts of one provider embedded in the extension instead
  of an external Chrome window; the Claude Code display that cuts off Claude's sidebar and its
  code/chat toggle, with Claude treated as one platform and Claude Code as the default landing page;
  moving between accounts from the tabs, the sidebar and the account menu; indexing for every
  signed-in profile (coding sessions, cowork and chat sessions, Grok bot, dot and Muse sessions);
  filter, sort and group controls for the sidebar, Threads and Dashboard; the scan of GitHub
  repositories for inspiration.

Working rule, sent later:

- "don't make any changes directly, you are creating handoff with full specs for a new session to use.
  I'm currently making the changes I mentioned earlier that allow for using multiple profiles within
  the same extension and can't have colliding changes, plus I don't want any of this to be done until
  those fixes are made."

## Decisions taken from this source

| ID | Decision | The founder's answer | Status |
|---|---|---|---|
| G-1 | How Paperclip lives in the extension | "Embed real Paperclip": the extension is the one window; Paperclip's own web app runs inside it unmodified, served by a Paperclip server on this Mac that the helper starts automatically; Browse, Threads and Dashboard are added to Paperclip's sidebar through a first-party Paperclip plugin | agreed |
| G-2 | Where the library lives in the first version | "Keep it in the extension": no data migration; conversations stay in the browser; agents list, search and read them through the extension while the browser is running; Paperclip tasks keep flowing into the same library; a server copy can come later | agreed |
| G-3 | What agents may do | "Trusted agents act alone": agents marked as trusted can start sessions and send messages without asking, within rate limits | agreed |
| G-4 | Shape of the merged codebase | "Hard fork": copy Paperclip once, edit its core freely and stop following upstream | agreed |
| G-5 | Scope | The multi-profile workstream listed above is separate and comes first | agreed |
| G-6 | Timing | No part of this plan starts until that workstream's fixes are made; this session writes a handoff with full specs and changes no application code | agreed |

Notes on how the answers fit together:

- G-1 chose the plugin route for the sidebar entries; G-4 allows editing Paperclip's core. The plan
  uses the plugin where Paperclip's plugin SDK already does the job (agent tools, routes, events,
  storage, sidebar entries, pages) and edits core only where the plugin surface cannot (host mode in
  the layout, search page, service shim). Each core edit is named in its REQ.
- G-3 was chosen over "read freely, act with approval". The risk stated with that option was that
  automated use of consumer accounts can trip provider bot checks or terms. The plan keeps act tools
  off for every agent and every provider until the founder turns them on.

## Not used

- The two screenshots attached to the request show the Claude Code display problem and the account
  menu. They belong to the separate workstream.
- The sentence "Scan github repos to find inspiration including repos" ended without naming the
  repositories. A scan was already done before the scope change and is kept as CTX-3.
