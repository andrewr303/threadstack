---
id: EPIC-4
title: One memory
status: framing
spec: SPEC-15
brief: BRIEF-1
prd:
reqs: [REQ-12, REQ-13, REQ-14]
effort: med
created: 2026-11-13
updated: 2026-11-13
---

# EPIC-4 — One memory

## Outcome

The library in the extension is the one memory for both products. Paperclip's tasks, comments and
agent runs appear in it within a minute of changing, Paperclip's own search shows matching sessions
found with the library's embeddings and reranking, and the credentials those models need are entered
in one place.

## Why this slice

It covers the last three key behaviours of BRIEF-1 and the founder's "integrating embedding and
reranking and everything else from threadkeeper into it" (CTX-1) under decision G-2, which keeps the
library in the extension. It comes last because it builds on the bridge (REQ-7) and the read tools
(REQ-8), and because the first three EPICs already deliver a usable merged product.

## Requirements

| # | ID | Title | Status | Ready | Blocked by |
|---|---|---|---|---|---|
| 1 | REQ-12 | Paperclip work stays current in the library | blocked | 4/5 | REQ-7 |
| 2 | REQ-13 | Search the library from inside Paperclip | blocked | 3/5 | REQ-8 |
| 3 | REQ-14 | Model credentials in one place | blocked | 2/5 | REQ-7 |

Sequence so each REQ can ship and be verified before the next starts, unless they are independent.

## Out of scope for this EPIC

- Storing conversations, vectors or summaries in Paperclip's database (G-2).
- New embedding or reranking providers, or changes to ranking quality.
- Search from Paperclip when no browser with the extension is running.
- Changes to the Ask panel, the catch-up brief, auto-organize or backups; they move with the
  extension unchanged in REQ-2.

## Done when

- A comment added to a Paperclip task is findable in the library's search within 60 seconds while
  the bridge is connected.
- Typing in Paperclip's search shows a Sessions section with results from the library.
- All child REQs are `done` with verification records, or REQ-14 is cancelled by the founder (Q-9).
