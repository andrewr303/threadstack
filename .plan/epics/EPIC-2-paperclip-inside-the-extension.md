---
id: EPIC-2
title: Paperclip inside the extension
status: framing
spec: SPEC-5
brief: BRIEF-1
prd:
reqs: [REQ-4, REQ-5, REQ-6]
effort: high
created: 2026-11-13
updated: 2026-11-13
---

# EPIC-2 — Paperclip inside the extension

## Outcome

The founder opens the extension window and Paperclip is there: its server is running on this Mac
(started on its own if needed), its real web app fills the window, and its sidebar lists Browse,
Threads and the session board next to Paperclip's own pages. Choosing a Threadkeeper entry shows
that view while Paperclip's sidebar stays in place.

## Why this slice

It covers the second, third and fourth key behaviours of BRIEF-1 and decision G-1: "Paperclip turned
into the chrome extension … with threadkeeper being new sidebar tabs" (CTX-1). It follows EPIC-1
because the server it starts is the fork's own build. REQ-6 is last because its technique is
unproven and REQ-5 already gives a usable single window if REQ-6 has to fall back. REQ-6 also waits
for REQ-7 (EPIC-3), which creates and installs the Paperclip plugin it adds entries to.

## Requirements

| # | ID | Title | Status | Ready | Blocked by |
|---|---|---|---|---|---|
| 1 | REQ-4 | Paperclip is running and connected when the extension opens | blocked | 3/5 | REQ-3 |
| 2 | REQ-5 | Paperclip's web app as a view in the extension window | blocked | 4/5 | REQ-4 |
| 3 | REQ-6 | Browse, Threads and the session board in Paperclip's sidebar | blocked | 3/5 | REQ-5, REQ-7 |

Sequence so each REQ can ship and be verified before the next starts, unless they are independent.

## Out of scope for this EPIC

- Compiling Paperclip's interface into the extension page (rejected in G-1).
- Restyling Threadkeeper's views to Paperclip's design tokens.
- Remote or cloud Paperclip servers being started or stopped from the extension.
- Anything about accounts, profiles or the session list controls (separate workstream).

## Done when

- With the server stopped, opening the extension window leads to a working Paperclip page within 60
  seconds without the founder running a command.
- Every Paperclip page reachable from its sidebar works inside the window, including sign-in.
- Paperclip's sidebar shows the three Threadkeeper entries and they open in place, or the founder has
  accepted view switching after a failed spike (Q-3).
- All child REQs are `done` with verification records
