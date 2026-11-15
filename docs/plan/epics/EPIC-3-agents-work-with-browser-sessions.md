---
id: EPIC-3
title: Agents work with browser sessions
status: framing
spec: SPEC-9
brief: BRIEF-1
prd:
reqs: [REQ-7, REQ-8, REQ-9, REQ-10, REQ-11]
effort: high
created: 2026-11-13
updated: 2026-11-13
---

# EPIC-3 — Agents work with browser sessions

## Outcome

Paperclip is connected to the founder's browser sessions through the extension. Paperclip holds a
current list of sessions for the companies the founder shares them with. An agent can list, read and
search them, link a session to its task, and is woken when a linked session finishes, fails or waits.
An agent the founder marked as trusted can start a session and send a message, within limits, with
every action recorded.

## Why this slice

It covers the fifth to ninth key behaviours of BRIEF-1, the founder's "big goal … connect paperclip
to browser sessions" and "having an AI agent help me" (CTX-1), and decisions G-2 and G-3. It needs
the connection from REQ-4; only REQ-9 also needs the Paperclip view (REQ-5), and nothing here needs
the fused sidebar (REQ-6), so REQ-7 and REQ-8 can proceed while REQ-5 and REQ-6 are built. REQ-7
creates and installs the plugin that REQ-6 and REQ-8 to REQ-13 extend. Acting (REQ-11) comes after reading (REQ-8) and linking
(REQ-9) because it carries the most risk and only acts on linked sessions.

## Requirements

| # | ID | Title | Status | Ready | Blocked by |
|---|---|---|---|---|---|
| 1 | REQ-7 | Bridge: Paperclip knows the browser's sessions | blocked | 3/5 | REQ-4 |
| 2 | REQ-8 | Agents list, read and search sessions | blocked | 3/5 | REQ-7 |
| 3 | REQ-9 | Sessions linked to tasks | blocked | 3/5 | REQ-5, REQ-7 |
| 4 | REQ-10 | Session changes reach the task and wake its agent | blocked | 3/5 | REQ-9 |
| 5 | REQ-11 | Trusted agents start sessions and send messages | blocked | 2/5 | REQ-8, REQ-9 |

Sequence so each REQ can ship and be verified before the next starts, unless they are independent.

## Out of scope for this EPIC

- A copy of the library on the Paperclip server (G-2).
- Agents approving or denying permission prompts, stopping runs, uploading files, or acting on
  sign-in, billing or account pages.
- Agents reading sessions the founder marked private, or any chat on X that the founder did not
  capture on purpose.
- Access from Paperclip when no browser with the extension is running.

## Done when

- An agent run in a shared company gets a list of sessions and a search result from the library
  through a tool call, and the call is in Paperclip's activity log.
- A task page lists its linked sessions with their state, and opening one shows the session.
- A linked coding session that finishes while loaded adds one comment to the task and one wake-up
  for the assigned agent.
- A trusted agent's message appears in the provider page of a linked session, and an agent that is
  not trusted is refused.
- All child REQs are `done` with verification records
