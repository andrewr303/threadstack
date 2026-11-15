# REQ-6 design — fused sidebar after the spike (2026-11-14)

Sidecar to `REQ-6-threadkeeper-entries-in-paperclips-sidebar.md`. It adds no requirement. It resolves D-3.

## Spike result

Harness and raw results: `verify/req6-spike/v2/` (`results/*.json`, screenshots). Throwaway pages only.
Browsers: Microsoft Edge 157.0.4341.46 and Chrome for Testing 153.0.8010.12 with a throwaway extension page as host;
Google Chrome 157.0.8103.51 with a cross-site web host (branded Chrome no longer loads unpacked extensions from a flag).
The framed document was out-of-process in every run.

| Check | Technique in D-3 (hole clipped in the frame) | Layered variant |
|---|---|---|
| 1 Transparent cross-origin frame shows the element beneath | pass, when the iframe's `color-scheme` matches the framed document's; a mismatch paints an opaque canvas | same |
| 2 Click inside reaches beneath, outside reaches the frame | pass for click, hover, nested frame, edges | pass (plain z-order) |
| 3 Overlays reportable from one place per component | not as written: `pages/Agents.tsx`, `ImageGalleryModal.tsx`, `LinkPreview.tsx` use primitives directly and there is no `context-menu.tsx`; one document-level observer covers all of them | same |
| 4 No flash longer than one frame | pass: 0 violating frames over every presented frame; negative control detected | pass, same method |
| 5 Focus moves to the dialog and back | pass | pass |
| Extra: wheel and trackpad scrolling of the view | **fail in all three browsers**: the event reaches the view but nothing scrolls | pass |

The D-3 technique is therefore not built: the founder could not scroll Threads or the session board.

## Decision

Layered variant, same observable behaviour as FR-2 to FR-6:

- The Paperclip frame stays full-size. On a Threadkeeper route its content rectangle is transparent.
- The Threadkeeper view is placed over the reported rectangle, above the frame by z-order.
- While a blocking overlay is open in Paperclip the frame is raised above the view; the view stays visible through the transparent rectangle.
- Notices do not raise the frame. Their rectangles are cut out of the view so they show and take clicks while the rest of the view stays live.
- The shell sets the iframe's `color-scheme` to the scheme Paperclip reports.
- Input follows a raise or lower within 4 to 16 ms.

## Contract additions (additive to FR-2 and FR-3)

- `ready` gains `mode: "fused" | "switching"`.
- `slot` gains `scheme: "light" | "dark"`.
- `overlay` gains `regions: { x, y, width, height }[]` (at most 8) for notices. `open` covers blocking overlays only.
- Shell to page: `{ type: "overlay-query" }`; the page answers with a fresh `overlay` (FR-3 negative, 60 s check).
- Overlay detection is one observer on `document.body` in Paperclip's UI, not one hook per component.

## Fallback

If the page reports `mode: "switching"`, or no `slot` arrives within 2 s, the shell keeps REQ-5 view switching.

`[assumed]` The founder has not answered Q-3. This choice follows the request to improve the implementation; switching remains available.

## Current fix-all cycle, 2026-11-14

The founder's later `Fix all and then open new PR` instruction authorizes repairs to this existing
layered implementation and a new verification cycle. This continuation is the implementation
direction; it is not a separate explicit Q-3 answer. REQ-6's original AC-10 is preserved and the
formal difference remains visible in `../verify/fix-all-cycle.md`.

The configured frame loads eagerly once Paperclip is running and its host grant exists. This
allows the fused window to engage from Threads without first opening Paperclip's view. The boot
handshake must preserve the requested Threads entry through initial home-route/empty-slot reports.
The eager frame differs from REQ-5's original first-shown wording; it does not bypass the allowlist,
origin/source validation, host permission, or plugin-page availability checks.

The founder also requested the compact title/actions and unified Sessions sidebar described in
`REQ-6-ui-supplement.md`. Those layout changes apply inside the same content rectangle and retain
the layered variant's one view switch, mounted provider frames, and overlay behavior. Fresh browser
evidence is required after the change; the earlier spike and rounds are historical evidence only.

### First-click handoff after an overlay

Rounds 24 and 25 captured a native click arriving in the closed Paperclip slot even after the
parent's DOM had lowered the frame. This is Chromium's cross-process hit-test propagation delay;
waiting in the test would conceal it. The accepted-close handlers now commit synchronously, and
a controlled split-gesture probe (round 35) also showed mouse-down in the old frame and mouse-up in the shell, with no click generated in either document. This probe delayed a captured close packet; it does not establish the cause of the earlier intermittent Edge miss. The following additive message preserves an existing session-selection intent:

`{ source: "paperclip-ui", v: 1, type: "slot-activate", view: "threads", x, y }`

Coordinates use the Paperclip frame's viewport. The page requires the verified fused host, a
trusted exclusive primary-mouse pointer-down on its current empty acknowledged Threads slot, a fresh
scan showing no blocking overlay, and an observed close within 250 ms. Pointer type must be mouse, the pointer must be primary, and button/buttons must be 0/1. Modifier keys, prevented events, keyboard activation, touch and pen are excluded from this recovery path. The listener runs before outside-pointer dismissal, so a still-open overlay consumes its own dismissing gesture. The shell repeats its
origin/source, fused-view, recent-close and coordinate checks, then resolves only a connected
registered session-row button under that point. It selects that existing conversation and
consumes the close window. It never dispatches an arbitrary click or activates a toolbar,
credential, destructive, provider or agent control. Both packages export the same 250 ms limit;
the routine cross-package contract test checks it.
