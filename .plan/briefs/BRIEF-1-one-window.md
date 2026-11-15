---
id: BRIEF-1
title: One window for Paperclip and every AI session
status: aligned
created: 2026-11-13
updated: 2026-11-13
---

# One window for Paperclip and every AI session

**One-liner:** A solo founder opens one extension window and finds Paperclip and every AI session
they have, across providers and accounts, in the same place, with Paperclip's agents able to find,
read, link and (when trusted) act on those sessions.

**Value Proposition:** Today the founder's work is split between Paperclip in one tab, Threadkeeper
in another and provider sites in several more, and Paperclip's agents cannot see any browser session.
After the merge a task in Paperclip shows the sessions that belong to it, a session shows its task,
one search covers both, and an agent can pick up where a session stopped.

**Who it's for:** One solo founder who runs many coding and chat sessions across several AI
providers and accounts, on macOS in Edge and Chrome. Secondary: none. Teams, other operating systems
and public distribution are served poorly on purpose.

**Job to be done:** When I have dozens of AI sessions and agent tasks in flight, I want one window
that shows all of them and an agent that can see them, so I can decide what needs me next without
hunting through browsers.

## Key Functionality

- One repository holds Paperclip and the extension, and the founder's existing library still opens
  after the move. — G-4 `[agreed]`
- Opening the extension window shows Paperclip running on this Mac. If it was not running it is
  started without the founder doing anything, and a status line says which state it is in. — G-1 `[agreed]`
- Paperclip's complete web app is usable inside the extension window: every page, its sign-in and
  its own sidebar, with no part of its navigation cut off. — G-1 `[agreed]`
- Browse, Threads and the session board are entries in Paperclip's sidebar. Choosing one shows that
  view while Paperclip's sidebar stays in place. — G-1 `[agreed]`; the technique is unproven (REQ-6)
- Paperclip knows which sessions the founder has (title, provider, account, state, last activity)
  for the companies the founder shares them with. A session marked private never appears. — G-2
  `[agreed]`; sharing per company is `[assumed]`
- Agents can list sessions, read one and search the whole library with the same search and
  reranking the founder uses. — G-2 `[agreed]`
- A session can be linked to a task. The task shows its sessions and their current state; the
  session shows its tasks. — `[assumed]`, follows from "connect Paperclip to browser sessions"
- When a linked session finishes, fails or waits for the founder, the task records it and the agent
  assigned to the task is woken. — `[assumed]`
- Agents the founder marks as trusted can start a session and send a message without asking, within
  limits. Every action is recorded and one switch stops all agent actions. — G-3 `[agreed]`; limits
  and scope are `[assumed]`
- Paperclip tasks and agent runs appear in the library within a minute of changing, so one search
  covers sessions and Paperclip work. — G-2 `[agreed]`; the one-minute figure is `[assumed]`
- Paperclip's own search shows matching sessions. — `[assumed]`
- Model credentials for search and analysis are entered once. — `[assumed]`, lowest priority

Keep implementation modules, endpoints, and technical filter parameters on the REQ, not in this behavior-only brief.

## Out of Scope (not v1)

- Several accounts of one provider signed in inside the extension; the Claude display and landing
  page; moving between accounts from tabs, sidebar and account menu; indexing for every signed-in
  profile; filter, sort and group controls for the sidebar, Threads and Dashboard. — The founder is
  building these separately and first (G-5).
- Moving the library, embeddings or search into Paperclip's database, or keeping a server copy. —
  G-2; can come later.
- Compiling Paperclip's interface into the extension, or rebuilding Threadkeeper's screens as
  Paperclip plugin pages. — Rejected in G-1.
- Following upstream Paperclip after the copy. — G-4.
- Agents approving or denying another coding agent's permission prompt, stopping a run, uploading
  files, or acting on sign-in, billing or account pages. — Higher risk than starting and sending.
- A new product name, store listing, or installer for the public. — The founder is the only user.
- Windows and Linux. — The helper is macOS only.
- Changes to the Still (Sidebar Dock) integration or the Cloudflare worker. — They keep working as they are.

## Decisions already made

- G-1 Embed real Paperclip in the extension window; sidebar entries through a first-party Paperclip
  plugin. — Founder's answer, 2026-11-13. Paperclip's server cannot run in an extension and its
  plugin screens cannot load inside an extension page. `agreed`. The option chosen said "unmodified";
  the plan makes a few small interface edits allowed by G-4, which the founder has not yet confirmed (Q-12).
- G-2 The library stays in the extension. — Founder's answer, 2026-11-13. No migration, and it
  avoids colliding with the indexing work under way. `agreed`
- G-3 Trusted agents act alone, within rate limits. — Founder's answer, 2026-11-13, chosen over
  approval for each action. `agreed`
- G-4 Hard fork of Paperclip. — Founder's answer, 2026-11-13. Core may be edited; upstream is not followed. `agreed`
- G-5 and G-6 The multi-profile workstream is separate and first; nothing here starts before it is
  merged. — Founder's messages, 2026-11-13. `agreed`
- The extension remains the top-level window and every embedded site, Paperclip included, is its
  direct child. — Required by how browsers keep a framed site signed in (CTX-2 rows 4a, 4b). `agreed` by G-1
- Sessions the founder marked as not allowed to leave the browser are never shown to Paperclip or
  agents. — Existing rule in the extension, reused. `assumed`

## Open questions

| ID | Question | Default if skipped |
|---|---|---|
| Q-1 | Where is the fork pushed (organisation, name, visibility)? | Local branch only; nothing is pushed |
| Q-2 | What is Threadkeeper's Dashboard called in Paperclip's sidebar, given Paperclip already has "Dashboard"? | "Session board" |
| Q-3 | If the fused sidebar cannot be made to work, accept view switching or try another technique? | Accept view switching |
| Q-4 | May every agent in a shared company read sessions, or only named agents? | Every agent in a shared company |
| Q-5 | Which sessions may a trusted agent act on? | Only sessions linked to its current task |
| Q-6 | What are the rate limits for trusted agents? | 10 sends and 3 starts per agent per hour; 1 send per session per 60 seconds |
| Q-7 | Which providers are open to agent actions? | Each off until the founder turns it on; Claude, Claude Code, ChatGPT and Codex supported first |
| Q-8 | Is the product or the extension renamed? | No rename in v1 |
| Q-9 | Keep "credentials in one place" (REQ-14)? | Keep, last, P2 |
| Q-10 | Where does the fork's working folder live? | Stay where it is until the fork is pushed |
| Q-11 | Which folder does the browser load Threadkeeper from after the merge? | The same folder as today, so the library stays where it is |
| Q-12 | Your Paperclip choice said its app runs "unmodified"; the plan makes a few small edits to Paperclip's screens (remembering your place on reload, fitting Threadkeeper's views beside its sidebar, a Sessions section in its search). Is that acceptable? | Yes, because the hard fork removed the reason for "unmodified" (clean upstream updates) |

## Alignment

Does this brief match what you meant?

- **Create Project Plan** — brief is aligned; explode into EPICs + REQs
- **Adjust** — say what is wrong
- **Draft anyway** — mark remaining gaps `[assumed]`

Historical planning state on 2026-11-13: the four decisions G-1 to G-4 and the scope and timing
rules G-5 and G-6 were the founder's own; this brief was initially a draft handoff.

Implementation alignment on 2026-11-13: the founder requested full implementation of the written
plan and then approved using the current working snapshot in the Paperclip fork and installing its
pinned dependencies, while preserving the original checkout and live extension. The lead records
this as alignment for implementation with the documented defaults. No individual answers to Q-1
through Q-12 are fabricated; unanswered defaults remain assumptions. G-5/G-6's original merge-first
timing is superseded by that explicit current-snapshot authorization. Live deployment, service
registration and transfer of existing secret values are not recorded as performed or approved.
