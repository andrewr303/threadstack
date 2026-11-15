# REQ-6 spike: switching fallback

This throwaway page pair isolates cross-origin transparency, clip hit testing and
focus restoration. Start it with `node .plan/verify/req6-spike/server.mjs`; it prints
two owned loopback origins. Open the host URL in separate test profiles of Edge
and Chrome. The frame's **Clip content rectangle** button reveals the underlying
view; clicks inside its content rectangle should reach the underlying button and
clicks in the sidebar should remain in the frame. Open/close the dialog and inspect
focus restoration with the underlying editor focused first.

No browser result is recorded here. These fixture controls are stand-ins, so even
a successful run cannot establish reporting from Paperclip's real dialog, popover,
dropdown, tooltip, select, context menu and notice components, or the required
one-frame visual transition. Those checks still need actual app captures in both
browsers. In this revision the product uses the plan's switching fallback; it does
not ship clipping, content rectangles, overlay instrumentation or fused layout.

Source inspection found there is no shared `ui/src/components/ui/context-menu.tsx`
in this checkout. The assumption that all seven overlay kinds have one wrapper
in that directory must be resolved before enabling fused mode.
