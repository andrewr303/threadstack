# Project Plan — Paperclip + Threadkeeper merge

| Field | Value |
|---|---|
| Status | active |
| Brief | BRIEF-1 |
| PRD | — |
| Platform context | present |
| Context sources | 4 |
| Ready specs | 14 of 14 |
| Active changes | 0 |
| Updated | 2026-11-14 |

## Next

REQ-1/TASK-1 is unblocked and ready to load. → `/ultimate-sdd:load REQ-1/TASK-1`

## Active repair cycle

The founder authorized a new fix-all cycle and a new PR after the earlier three-round improvement
cycle stopped. See `verify/fix-all-cycle.md` for current decisions and unresolved literal-spec
gaps, and `reqs/REQ-6-ui-supplement.md` for the requested compact header, unified Sessions sidebar,
and Ask formatting. New final receipts are pending. The graph-derived Next above and unfinished
REQ/TASK statuses are unchanged; no load or completion gate is claimed.

## Spec tree

```
SPEC-9  EPIC-3 Agents work with browser sessions                    framing · high
  SPEC-10  REQ-7 · Bridge between the extension and Paperclip with a session inventory    ready · high    needs first: REQ-4
  SPEC-11  REQ-8 · Agents list, read and search sessions    ready · med    needs first: REQ-7
  SPEC-12  REQ-9 · Sessions linked to tasks    ready · med    needs first: REQ-5, REQ-7
  SPEC-13  REQ-10 · Session changes reach the task and wake its agent    ready · med    needs first: REQ-9
  SPEC-14  REQ-11 · Trusted agents start sessions and send messages    ready · high    needs first: REQ-8, REQ-9
SPEC-1  EPIC-1 One codebase                    framing · med
  SPEC-2  REQ-1 · Start gate and baseline after the multi-profile work lands    ready · low
  SPEC-3  REQ-2 · Import Threadkeeper into the Paperclip fork    ready · med    needs first: REQ-1
  SPEC-4  REQ-3 · One check for the whole fork and a safe deploy of the extension    ready · low    needs first: REQ-2
SPEC-15  EPIC-4 One memory                    framing · med
  SPEC-16  REQ-12 · Paperclip work stays current in the library    ready · med    needs first: REQ-7
  SPEC-17  REQ-13 · Search the library from inside Paperclip    ready · med    needs first: REQ-8
  SPEC-18  REQ-14 · Model credentials in one place    ready · med    needs first: REQ-7
SPEC-5  EPIC-2 Paperclip inside the extension                    framing · high
  SPEC-6  REQ-4 · Paperclip is running and connected when the extension opens    ready · med    needs first: REQ-3
  SPEC-7  REQ-5 · Paperclip's web app as a view in the extension window    ready · med    needs first: REQ-4
  SPEC-8  REQ-6 · Browse, Threads and the session board in Paperclip's sidebar    ready · high    needs first: REQ-5, REQ-7
```

## Board

### Plan

| ID | Spec | Title | Label | Ready | Effort | Notes |
|---|---|---|---|---|---|---|
| EPIC-3 | SPEC-9 | Agents work with browser sessions | framing | — | high | 5 reqs |
| EPIC-1 | SPEC-1 | One codebase | framing | — | med | 3 reqs |
| EPIC-4 | SPEC-15 | One memory | framing | — | med | 3 reqs |
| EPIC-2 | SPEC-5 | Paperclip inside the extension | framing | — | high | 3 reqs |

### Build

| ID | Title | Tasks | Progress |
|---|---|---|---|
| REQ-7 | Bridge between the extension and Paperclip with a session inventory | 1 | 0/1 |
| REQ-13 | Search the library from inside Paperclip | 1 | 0/1 |
| REQ-2 | Import Threadkeeper into the Paperclip fork | 1 | 0/1 |
| REQ-12 | Paperclip work stays current in the library | 1 | 0/1 |
| REQ-3 | One check for the whole fork and a safe deploy of the extension | 1 | 0/1 |
| REQ-14 | Model credentials in one place | 1 | 0/1 |
| REQ-9 | Sessions linked to tasks | 1 | 0/1 |
| REQ-11 | Trusted agents start sessions and send messages | 1 | 0/1 |
| REQ-6 | Browse, Threads and the session board in Paperclip's sidebar | 1 | 0/1 |
| REQ-5 | Paperclip's web app as a view in the extension window | 1 | 0/1 |
| REQ-1 | Start gate and baseline after the multi-profile work lands | 1 | 0/1 |
| REQ-8 | Agents list, read and search sessions | 1 | 0/1 |
| REQ-10 | Session changes reach the task and wake its agent | 1 | 0/1 |
| REQ-4 | Paperclip is running and connected when the extension opens | 1 | 0/1 |

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
  REQ-7 Bridge between the extension and Paperclip with a session inventory (in-progress · 4/5 · 1 tasks)
  REQ-9 Sessions linked to tasks (in-progress · 4/5 · 1 tasks)
  REQ-11 Trusted agents start sessions and send messages (in-progress · 4/5 · 1 tasks)
  REQ-8 Agents list, read and search sessions (in-progress · 4/5 · 1 tasks)
  REQ-10 Session changes reach the task and wake its agent (in-progress · 4/5 · 1 tasks)
EPIC-1 One codebase
  REQ-2 Import Threadkeeper into the Paperclip fork (in-progress · 4/5 · 1 tasks)
  REQ-3 One check for the whole fork and a safe deploy of the extension (in-progress · 4/5 · 1 tasks)
  REQ-1 Start gate and baseline after the multi-profile work lands (in-progress · 4/5 · 1 tasks)
EPIC-4 One memory
  REQ-13 Search the library from inside Paperclip (in-progress · 4/5 · 1 tasks)
  REQ-12 Paperclip work stays current in the library (in-progress · 4/5 · 1 tasks)
  REQ-14 Model credentials in one place (in-progress · 4/5 · 1 tasks)
EPIC-2 Paperclip inside the extension
  REQ-6 Browse, Threads and the session board in Paperclip's sidebar (in-progress · 4/5 · 1 tasks)
  REQ-5 Paperclip's web app as a view in the extension window (in-progress · 4/5 · 1 tasks)
  REQ-4 Paperclip is running and connected when the extension opens (in-progress · 4/5 · 1 tasks)
```

## Registry

| ID | File | Status |
|---|---|---|
| BRIEF-1 | .plan/briefs/BRIEF-1-one-window.md | aligned |
| CTX-1 | .plan/context/plan/CTX-1-founder-request-and-decisions.md | — |
| CTX-2 | .plan/context/project/CTX-2-accounts-in-one-extension-research.md | — |
| CTX-3 | .plan/context/project/CTX-3-open-source-projects-to-study.md | — |
| CTX-4 | .plan/context/implementation.md | — |
| EPIC-1 | .plan/epics/EPIC-1-one-codebase.md | framing |
| EPIC-2 | .plan/epics/EPIC-2-paperclip-inside-the-extension.md | framing |
| EPIC-3 | .plan/epics/EPIC-3-agents-work-with-browser-sessions.md | framing |
| EPIC-4 | .plan/epics/EPIC-4-one-memory.md | framing |
| PLATFORM | .plan/context/platform.md | — |
| PROJECT | .plan/project.md | active |
| REQ-1 | .plan/reqs/REQ-1-start-gate-and-baseline.md | in-progress |
| REQ-1/TASK-1 | .plan/tasks/REQ-1/TASK-1-record-snapshot-baseline.md | planned |
| REQ-10 | .plan/reqs/REQ-10-session-changes-wake-the-agent.md | in-progress |
| REQ-10/TASK-1 | .plan/tasks/REQ-10/TASK-1-record-states-and-governed-wakeups.md | planned |
| REQ-11 | .plan/reqs/REQ-11-trusted-agents-start-and-send.md | in-progress |
| REQ-11/TASK-1 | .plan/tasks/REQ-11/TASK-1-execute-trusted-exact-account-actions.md | planned |
| REQ-12 | .plan/reqs/REQ-12-paperclip-work-stays-current-in-the-library.md | in-progress |
| REQ-12/TASK-1 | .plan/tasks/REQ-12/TASK-1-refresh-library-from-change-hints.md | planned |
| REQ-13 | .plan/reqs/REQ-13-search-sessions-from-paperclip.md | in-progress |
| REQ-13/TASK-1 | .plan/tasks/REQ-13/TASK-1-search-sessions-in-app-and-palette.md | planned |
| REQ-14 | .plan/reqs/REQ-14-model-credentials-in-one-place.md | in-progress |
| REQ-14/TASK-1 | .plan/tasks/REQ-14/TASK-1-resolve-opt-in-model-credentials.md | planned |
| REQ-2 | .plan/reqs/REQ-2-import-threadkeeper-into-the-fork.md | in-progress |
| REQ-2/TASK-1 | .plan/tasks/REQ-2/TASK-1-import-history-and-current-snapshot.md | planned |
| REQ-3 | .plan/reqs/REQ-3-one-build-and-one-check.md | in-progress |
| REQ-3/TASK-1 | .plan/tasks/REQ-3/TASK-1-guard-combined-checks-and-deploy.md | planned |
| REQ-4 | .plan/reqs/REQ-4-paperclip-running-and-connected.md | in-progress |
| REQ-4/TASK-1 | .plan/tasks/REQ-4/TASK-1-connect-and-start-registered-service.md | planned |
| REQ-5 | .plan/reqs/REQ-5-paperclip-view-in-the-extension-window.md | in-progress |
| REQ-5/TASK-1 | .plan/tasks/REQ-5/TASK-1-embed-application-and-restore-routes.md | planned |
| REQ-6 | .plan/reqs/REQ-6-threadkeeper-entries-in-paperclips-sidebar.md | in-progress |
| REQ-6/TASK-1 | .plan/tasks/REQ-6/TASK-1-expose-navigation-with-safe-switching.md | planned |
| REQ-7 | .plan/reqs/REQ-7-bridge-paperclip-knows-the-sessions.md | in-progress |
| REQ-7/TASK-1 | .plan/tasks/REQ-7/TASK-1-pair-bridge-and-sync-inventory.md | planned |
| REQ-8 | .plan/reqs/REQ-8-agents-list-read-and-search-sessions.md | in-progress |
| REQ-8/TASK-1 | .plan/tasks/REQ-8/TASK-1-read-bounded-untrusted-sessions.md | planned |
| REQ-9 | .plan/reqs/REQ-9-sessions-linked-to-tasks.md | in-progress |
| REQ-9/TASK-1 | .plan/tasks/REQ-9/TASK-1-link-sessions-to-current-tasks.md | planned |

Latest repair delivery: [compact UI and verified source report](verify/fix-all-final/report.md).
Both final browsers pass 16/16; formal completion statuses are unchanged.
