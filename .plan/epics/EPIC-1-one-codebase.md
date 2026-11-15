---
id: EPIC-1
title: One codebase
status: framing
spec: SPEC-1
brief: BRIEF-1
prd:
reqs: [REQ-1, REQ-2, REQ-3]
effort: med
created: 2026-11-13
updated: 2026-11-13
---

# EPIC-1 — One codebase

## Outcome

One repository, a hard fork of Paperclip at `edb6945ff3`, holds Paperclip and the Threadkeeper
extension. The extension sits under `extension/` with its git history and its checks pass there. One
command checks everything without touching the founder's running browser, and one command, run by
the founder, deploys the fork's extension so that the extension ID and the library stay the same.
The plan was re-verified against the code as it stood after the founder's multi-profile work merged.

## Why this slice

It covers the first key behaviour of BRIEF-1 (one repository, library still opens) and decision G-4.
It comes first because every later REQ adds code to the fork, and because REQ-1 is the gate the
founder asked for: nothing starts until the multi-profile work is merged (G-5, G-6).

## Requirements

| # | ID | Title | Status | Ready | Blocked by |
|---|---|---|---|---|---|
| 1 | REQ-1 | Start gate: baseline after the multi-profile work lands | specified | 3/5 | — (held by the founder) |
| 2 | REQ-2 | Import Threadkeeper into the Paperclip fork | blocked | 4/5 | REQ-1 |
| 3 | REQ-3 | One check for the whole fork and a safe deploy of the extension | blocked | 4/5 | REQ-2 |

Sequence so each REQ can ship and be verified before the next starts, unless they are independent.

## Out of scope for this EPIC

- Creating a GitHub repository, pushing, or archiving the old Threadkeeper repository. These are the
  founder's actions (Q-1).
- Moving the extension to React 19 or into the pnpm workspace.
- Removing or rewriting Paperclip's continuous-integration workflows.
- Any behaviour change in the extension or in Paperclip.
- Moving the library to the extension's fixed-key ID (a founder choice under Q-11).

## Done when

- The founder has confirmed the multi-profile work is merged and the plan's code map names that commit.
- `extension/` in the fork holds Threadkeeper byte for byte at that commit, with history reachable.
- One command runs both sets of checks and never writes to a folder a browser loads.
- After the founder runs the deploy command, the browser shows the same extension ID and the same library.
- All child REQs are `done` with verification records
