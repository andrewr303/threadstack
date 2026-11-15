# Compact Threads interface — founder follow-up, 2026-11-14

This supplement records the founder's screenshots and follow-up instructions in the new fix-all
cycle. It adds the requested interface scope without renumbering REQ-6's original FRs or ACs.
It applies to the full-page Threads view both with and without Paperclip's fused window; the
side-panel surface keeps its existing single-column navigation behavior.

## Requested outcome

The selected conversation should occupy substantially more of the window. Its controls should
not consume several tall rows, and the Sessions sidebar and Threads results should not form two
parallel lists of the same library.

## Interface contract

| Area | Required behavior |
|---|---|
| Thread title | Place the Summary / Live / Split switch beside the thread title in the same header row. Keep the title readable and the selected mode apparent. |
| Thread controls | Put category, category lock, workflow status, Open original, Copy handoff, Pin to dashboard, Open in Browse, and Delete in one compact row. Icons or shortened visible labels may save width; complete accessible names and tooltips must identify each action. |
| Task links | Keep Task links in that same controls row. A native dialog contains the existing task picker and imported references; link, unlink, navigation, Escape and focus return remain available. |
| Narrow detail pane | Keep the controls in one row with every control reachable by keyboard and pointer, including the final action. Horizontal scrolling or compact labels may adapt that row; clipped and unreachable controls do not satisfy the request. |
| Sessions navigation | Merge the Threads list's search, Ask, filters, sorting, grouping, and selection functionality into the existing Sessions sidebar. Full-page Threads has one session/results list and the selected conversation in the main pane. |
| Sidebar results | Preserve title, account/provider context, current selection, live/run state, and grouping. Search, queue/project filtering, bulk selection and actions, and keyboard row navigation remain available. Less-used controls may use an explicit disclosure. |
| Ask layout | Give the question field usable full width in the narrow sidebar. Place its action so it does not squeeze the textarea into a short clipped box. Preserve loading, disabled, error, result, and citation navigation behavior. |
| Small windows | The existing drawer/collapse affordance exposes the unified list. The main pane remains usable when a thread is selected and shows a clear empty state when none is selected. |
| Fused mode | Paperclip retains its single Browse / Threads / Session board navigation. The unified Sessions list lives inside the Threadkeeper content area and does not restore a second view switch. |

## Verification to retain

Run targeted component/interaction tests and typechecking for the changed modules. These checks
support the change but do not establish the visible outcome. The browser run must inspect and
capture the actual rendered interface at wide and narrow sizes, including:

- The title and mode switch in one row, and all thread controls on one horizontal row.
- The chat viewport and single Sessions/results column, with no redundant third column.
- Search and a filtered/selected result; grouping and a bulk-selection action remain reachable.
- The Ask question field and action, with multiline text visible and no sideways squeeze.
- Keyboard access to the last control at narrow width, sidebar drawer access, and live/summary
  switching without reloading the embedded provider document.

Use synthetic conversations and documented local fixtures where real accounts are unavailable.
Label those fixtures and keep real-provider delivery and native-consent gaps separate. New
receipts for this cycle are pending; historical browser rounds do not prove this layout.

## Browser repairs discovered during this cycle

The mobile Paperclip layout must give the absolute slot a bounded parent height through its flex
ancestors before placement is acknowledged. A zero-height measurement remains invalid; the shell
does not substitute a fabricated rectangle.

Chromium can send the first post-Escape click to the closed frame's old compositor hit-test
surface. Accepted palette closes and validated overlay closes commit synchronously. A narrow
`slot-activate` message additionally recovers session-row selection for a trusted exclusive primary-mouse press
in the empty, placed Threads slot within 250 ms of an observed blocking-overlay
close. Both sides require fused mode and bounded coordinates; the shell accepts only a connected,
registered row from its current library. A host-owned gesture sequence rejects duplicate or older packets while allowing distinct physical presses inside the original close window. This channel never invokes arbitrary DOM controls
or agent/provider actions. Open overlays, untrusted or modified events, stale windows, different
views and duplicate accepted packets are refused. See `REQ-6-design.md` for the message boundary.
