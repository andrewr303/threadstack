# Project Plan — Paperclip + Threadkeeper merge

| Field | Value |
|---|---|
| Status | active |
| Brief | — |
| PRD | — |
| Platform context | present |
| Context sources | 3 |
| Ready specs | 4 of 14 |
| Active changes | 0 |
| Updated | 2026-11-13 |

## Next

No aligned brief and no PRD. → `/ultimate-sdd:frame`

## Spec tree

```
SPEC-9  EPIC-3 Agents work with browser sessions                    framing · high
  SPEC-10  REQ-7 · Bridge between the extension and Paperclip with a session inventory    shaping · high    needs first: REQ-4
  SPEC-11  REQ-8 · Agents list, read and search sessions    shaping · med    needs first: REQ-7
  SPEC-12  REQ-9 · Sessions linked to tasks    shaping · med    needs first: REQ-5, REQ-7
  SPEC-13  REQ-10 · Session changes reach the task and wake its agent    shaping · med    needs first: REQ-9
  SPEC-14  REQ-11 · Trusted agents start sessions and send messages    rough · high    needs first: REQ-8, REQ-9
SPEC-1  EPIC-1 One codebase                    framing · med
  SPEC-2  REQ-1 · Start gate and baseline after the multi-profile work lands    shaping · low
  SPEC-3  REQ-2 · Import Threadkeeper into the Paperclip fork    ready · med    needs first: REQ-1
  SPEC-4  REQ-3 · One check for the whole fork and a safe deploy of the extension    ready · low    needs first: REQ-2
SPEC-15  EPIC-4 One memory                    framing · med
  SPEC-16  REQ-12 · Paperclip work stays current in the library    ready · med    needs first: REQ-7
  SPEC-17  REQ-13 · Search the library from inside Paperclip    shaping · med    needs first: REQ-8
  SPEC-18  REQ-14 · Model credentials in one place    rough · med    needs first: REQ-7
SPEC-5  EPIC-2 Paperclip inside the extension                    framing · high
  SPEC-6  REQ-4 · Paperclip is running and connected when the extension opens    shaping · med    needs first: REQ-3
  SPEC-7  REQ-5 · Paperclip's web app as a view in the extension window    ready · med    needs first: REQ-4
  SPEC-8  REQ-6 · Browse, Threads and the session board in Paperclip's sidebar    shaping · high    needs first: REQ-5, REQ-7
```

## Board

### Plan

| ID | Spec | Title | Label | Ready | Effort | Notes |
|---|---|---|---|---|---|---|
| EPIC-3 | SPEC-9 | Agents work with browser sessions | framing | — | high | 5 reqs |
| EPIC-1 | SPEC-1 | One codebase | framing | — | med | 3 reqs |
| EPIC-4 | SPEC-15 | One memory | framing | — | med | 3 reqs |
| EPIC-2 | SPEC-5 | Paperclip inside the extension | framing | — | high | 3 reqs |
| REQ-7 | SPEC-10 | Bridge between the extension and Paperclip with a session inventory | shaping | 3/5 | high | blocked |
| REQ-13 | SPEC-17 | Search the library from inside Paperclip | shaping | 3/5 | med | blocked |
| REQ-2 | SPEC-3 | Import Threadkeeper into the Paperclip fork | ready | 4/5 | med | blocked |
| REQ-12 | SPEC-16 | Paperclip work stays current in the library | ready | 4/5 | med | blocked |
| REQ-3 | SPEC-4 | One check for the whole fork and a safe deploy of the extension | ready | 4/5 | low | blocked |
| REQ-14 | SPEC-18 | Model credentials in one place | rough | 2/5 | med | blocked |
| REQ-9 | SPEC-12 | Sessions linked to tasks | shaping | 3/5 | med | blocked |
| REQ-11 | SPEC-14 | Trusted agents start sessions and send messages | rough | 2/5 | high | blocked |
| REQ-6 | SPEC-8 | Browse, Threads and the session board in Paperclip's sidebar | shaping | 3/5 | high | blocked |
| REQ-5 | SPEC-7 | Paperclip's web app as a view in the extension window | ready | 4/5 | med | blocked |
| REQ-1 | SPEC-2 | Start gate and baseline after the multi-profile work lands | shaping | 3/5 | low | specified |
| REQ-8 | SPEC-11 | Agents list, read and search sessions | shaping | 3/5 | med | blocked |
| REQ-10 | SPEC-13 | Session changes reach the task and wake its agent | shaping | 3/5 | med | blocked |
| REQ-4 | SPEC-6 | Paperclip is running and connected when the extension opens | shaping | 3/5 | med | blocked |

### Build

| ID | Title | Tasks | Progress |
|---|---|---|---|
| — | — | — | — |

### Changes

| ID | Slug | Status | Deltas | REQs |
|---|---|---|---|---|
| — | — | — | — | — |

### Published

| ID | Title | Verified | Evidence |
|---|---|---|---|
| — | — | — | — |

## Graph

```
EPIC-3 Agents work with browser sessions
  REQ-7 Bridge between the extension and Paperclip with a session inventory (blocked · 3/5 · 0 tasks)
  REQ-9 Sessions linked to tasks (blocked · 3/5 · 0 tasks)
  REQ-11 Trusted agents start sessions and send messages (blocked · 2/5 · 0 tasks)
  REQ-8 Agents list, read and search sessions (blocked · 3/5 · 0 tasks)
  REQ-10 Session changes reach the task and wake its agent (blocked · 3/5 · 0 tasks)
EPIC-1 One codebase
  REQ-2 Import Threadkeeper into the Paperclip fork (blocked · 4/5 · 0 tasks)
  REQ-3 One check for the whole fork and a safe deploy of the extension (blocked · 4/5 · 0 tasks)
  REQ-1 Start gate and baseline after the multi-profile work lands (specified · 3/5 · 0 tasks)
EPIC-4 One memory
  REQ-13 Search the library from inside Paperclip (blocked · 3/5 · 0 tasks)
  REQ-12 Paperclip work stays current in the library (blocked · 4/5 · 0 tasks)
  REQ-14 Model credentials in one place (blocked · 2/5 · 0 tasks)
EPIC-2 Paperclip inside the extension
  REQ-6 Browse, Threads and the session board in Paperclip's sidebar (blocked · 3/5 · 0 tasks)
  REQ-5 Paperclip's web app as a view in the extension window (blocked · 4/5 · 0 tasks)
  REQ-4 Paperclip is running and connected when the extension opens (blocked · 3/5 · 0 tasks)
```

## Registry

| ID | File | Status |
|---|---|---|
| BRIEF-1 | docs/plan/briefs/BRIEF-1-one-window.md | draft |
| CTX-1 | docs/plan/context/plan/CTX-1-founder-request-and-decisions.md | — |
| CTX-2 | docs/plan/context/project/CTX-2-accounts-in-one-extension-research.md | — |
| CTX-3 | docs/plan/context/project/CTX-3-open-source-projects-to-study.md | — |
| EPIC-1 | docs/plan/epics/EPIC-1-one-codebase.md | framing |
| EPIC-2 | docs/plan/epics/EPIC-2-paperclip-inside-the-extension.md | framing |
| EPIC-3 | docs/plan/epics/EPIC-3-agents-work-with-browser-sessions.md | framing |
| EPIC-4 | docs/plan/epics/EPIC-4-one-memory.md | framing |
| PLATFORM | docs/plan/context/platform.md | — |
| PROJECT | docs/plan/project.md | active |
| REQ-1 | docs/plan/reqs/REQ-1-start-gate-and-baseline.md | specified |
| REQ-10 | docs/plan/reqs/REQ-10-session-changes-wake-the-agent.md | blocked |
| REQ-11 | docs/plan/reqs/REQ-11-trusted-agents-start-and-send.md | blocked |
| REQ-12 | docs/plan/reqs/REQ-12-paperclip-work-stays-current-in-the-library.md | blocked |
| REQ-13 | docs/plan/reqs/REQ-13-search-sessions-from-paperclip.md | blocked |
| REQ-14 | docs/plan/reqs/REQ-14-model-credentials-in-one-place.md | blocked |
| REQ-2 | docs/plan/reqs/REQ-2-import-threadkeeper-into-the-fork.md | blocked |
| REQ-3 | docs/plan/reqs/REQ-3-one-build-and-one-check.md | blocked |
| REQ-4 | docs/plan/reqs/REQ-4-paperclip-running-and-connected.md | blocked |
| REQ-5 | docs/plan/reqs/REQ-5-paperclip-view-in-the-extension-window.md | blocked |
| REQ-6 | docs/plan/reqs/REQ-6-threadkeeper-entries-in-paperclips-sidebar.md | blocked |
| REQ-7 | docs/plan/reqs/REQ-7-bridge-paperclip-knows-the-sessions.md | blocked |
| REQ-8 | docs/plan/reqs/REQ-8-agents-list-read-and-search-sessions.md | blocked |
| REQ-9 | docs/plan/reqs/REQ-9-sessions-linked-to-tasks.md | blocked |
