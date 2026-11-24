# ThreadStack workbench redesign and rename

Date: 2026-11-24. Scope: the extension's full-page manager (`extension/src/entrypoints/manager/`),
the ThreadStack brand, and the Threadkeeper → ThreadStack rename across the repository.

Inputs: the design handoff "Threadkeeper workbench" (a high-fidelity HTML prototype with mock
data, its README and implementation prompt) and the ThreadStack brand artwork. The prototype is a
reference only; everything below uses the real library, workspace state and settings.

## Gap table (prototype vs. code before this change)

| View | Prototype | Before | Change | Files |
| --- | --- | --- | --- | --- |
| Brand | Mark + "TS" wordmark (expanded), stacked mark (collapsed) | Text "Threadkeeper" and a "T" tile | Brand images; extension icons from the same artwork | `shell/Rail.tsx`, `styles/10-shell.css`, `extension/assets/brand/`, `scripts/build-extension.mjs` |
| Rail | Header row of tools (theme, add account, Settings, ⌘K, collapse); Ink view switch; no foot | Tools and accounts in a foot; Paperclip status in the rail | Header tools; Ink switch tokens; collapsed strip with foot tools; accounts and Paperclip status moved to Settings | `shell/Rail.tsx`, `styles/10-shell.css`, `styles.css` |
| Rail (Threads) | Wider rail, two-column top with search and Group by | 264px rail, search inside the list | `clamp(264px, 46vw, 644px)`; the list's search row renders at the rail top through a portal; Group by switch (Status / Provider / Account / None) persisted in `threadsGroupBy` | `threads/ListPane.tsx`, `App.tsx` |
| ⌘K palette | Session palette with filters, counts, run-state order | Only Paperclip's palette in fused mode | New palette; `commandBar` setting; fused-mode guard leaves ⌘K to Paperclip | `shell/SessionPalette.tsx`, `shell/palette.ts`, `styles/15-palette.css`, `hooks/useWorkbenchKeyboard.ts`, `core/schema.ts`, `SettingsDialog.tsx` |
| Browse | Pill tabs, ⌘K chip, split toggle | Tabs and toolbar, no split | Chrome pass, ⌘K chip, split view with per-pane tabs and focus | `browse/*`, `workspace/state.ts`, `workspace/useWorkspace.ts`, `core/workspace/types.ts`, `styles/20-browse.css` |
| Status board | Needs you / Running / Idle columns | None | Board from real run state, group chips, Open / Answer | `browse/StatusBoard.tsx`, `styles/22-board.css` |
| Threads | Group by switch; detail Summary / Live / Split | Group by in a menu; detail modes existed | Group by switch (see Rail); detail kept | `threads/ListPane.tsx` |
| Table | Provider switch, "N sessions of TOTAL", ▲/▼ with `aria-sort` | Sorting and `aria-sort` existed; no provider filter; "N threads" | Provider switch, count line, deterministic tie-break, filter field styling | `table/TableView.tsx`, `core/thread-table.ts`, `styles/45-table.css` |
| Dashboard | Slot numbers, spanning 3-pane layout, empty-pane offers, swap on place | All present except swap from the pinned bar (it moved) | Pressing a pinned session swaps panes | `dashboard/DashboardView.tsx` |
| Paperclip | Stopped: centered card with Connect. Running: glass bar with status | Plain status text; rail forced to collapse | Connect card and status bar; rail no longer forced to collapse | `PaperclipView.tsx`, `PaperclipConnection.tsx`, `App.tsx` |
| Settings | Accounts rows open the account menu; Paperclip status with Connect | Full Settings existed | Accounts → **In use** rows; Paperclip → connection row; palette toggle | `accounts/AccountsSettings.tsx`, `PaperclipSettings.tsx`, `SettingsDialog.tsx` |
| Tokens | Ink, copper-teal palette | Matching tokens for most values | Added only missing tokens, with light-theme and solid-surface values | `styles.css` |

## Deliberately not implemented

- **Approve.** The extension has no action that approves a provider's permission prompt
  (`core/paperclip/actions.ts` only refuses to send while a session waits for permission). The
  board and palette show the state and open the session instead. A test asserts there is no
  Approve button. Follow-up: an approval action, if a provider exposes one that can be driven
  safely.
- **Paperclip "Disconnect".** The extension does not own the local server's lifecycle beyond
  starting it, so there is nothing honest to disconnect. The running bar offers **Open in Chrome
  tab** and **Connection** (Settings) instead.
- **Three-state status select** (Active / Parked / Done). The detail keeps the select of all six
  real workflow states, so states such as Needs review and Waiting are never hidden or rewritten.
- **Provider logos.** The prototype draws Claude and ChatGPT glyphs; the codebase deliberately
  uses neutral two-letter marks ("never a logo"), which were kept.

## Where code and prototype disagree

- The prototype's address field opens the palette on click. The code keeps the address field
  editable and opens the palette from its ⌘K chip, so typing an address still works.
- The prototype has no way into the board other than a start option. The code adds a Status
  board toggle beside Split in the Browse bar.
- The prototype's Settings dialog has only Accounts and Paperclip. The code keeps the full
  Settings and puts the prototype's rows at the top of those two sections.

## Rename

The product name, code identifiers, file names, scripts, CI workflow and docs use ThreadStack.
Identifiers that are stored or shared with separately deployed parts keep the old name; the
complete list and the reasons are in [doc/threadstack.md](../threadstack.md#naming-and-compatibility).

## Verification

- Extension: `npx tsc --noEmit` clean; `npx vitest run`: everything passes except five installer
  tests in `mac-helper.test.ts` and `paperclip-helper.test.ts` that require Node.js 24.11. They
  fail the same way before this change on the Node 22 runtime used here and were not run on 24.
  New tests cover the palette (filters, counts, order, keyboard, address entry, fused-mode guard),
  split-view reducer rules, the board, Table provider filter, count and tie-break, Dashboard swap,
  and the rail's brand and tools.
- Repository (rename): `scripts/threadstack*.test.mjs`, the renamed UI and server tests, the
  browser-sessions plugin tests and the UI typecheck pass.
