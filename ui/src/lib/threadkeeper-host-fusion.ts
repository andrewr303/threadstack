import type { ColorScheme, ThreadkeeperRect, ThreadkeeperSlot, ThreadkeeperSlotView } from "./threadkeeper-host";
import { createThreadkeeperSlotReporter } from "./threadkeeper-host-slot";
import { observeThreadkeeperOverlays, readThreadkeeperOverlays, type ThreadkeeperOverlayState } from "./threadkeeper-overlays";

/** Opens the command palette the same way Paperclip's own search button does (`Layout.openSearch`). */
export function openPaperclipPalette(doc: Document): void {
  doc.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
}

/** REQ-6 fused mode on the Paperclip side: placement, overlays and the palette command. */
export function connectThreadkeeperFusion(options: {
  doc: Document;
  root: Element | null;
  host: {
    reportSlot: (slot: ThreadkeeperSlot | null, scheme: ColorScheme) => boolean;
    reportOverlay: (state: ThreadkeeperOverlayState) => boolean;
    announceMode?: () => boolean;
    /** The mode last announced in `ready`; overlays are watched only while it is fused. */
    mode?: () => "fused" | "switching" | null;
  };
  measure?: (element: HTMLElement) => ThreadkeeperRect;
  ResizeObserver?: typeof ResizeObserver;
  schedule?: (run: () => void) => void;
}) {
  const { doc, root, host } = options;
  const slots = createThreadkeeperSlotReporter({
    doc,
    report: (slot, scheme) => { host.reportSlot(slot, scheme); },
    measure: options.measure,
    ResizeObserver: options.ResizeObserver,
  });
  // The body observer costs a scan per frame of DOM activity; it runs only after a fused `ready`.
  let overlays: ReturnType<typeof observeThreadkeeperOverlays> | null = null;
  const watchOverlays = (on: boolean) => {
    if (on && !overlays) overlays = observeThreadkeeperOverlays({ doc, root, schedule: options.schedule, onChange: (state) => { host.reportOverlay(state); } });
    if (!on && overlays) { overlays.dispose(); overlays = null; }
  };
  const freshOverlays = () => overlays?.read() ?? readThreadkeeperOverlays({ doc, root });
  return {
    /** After a (re)handshake the shell needs the current placement and overlay state. */
    refresh() {
      // A new `ready` restarts the shell's engagement; stay opaque until it places its view again.
      slots.acknowledge(null);
      const fused = host.mode?.() === "fused";
      watchOverlays(fused);
      if (fused) host.reportOverlay(freshOverlays());
    },
    /** Fused availability changed: re-send `ready`, then the state the shell's new window needs. */
    announceMode(): boolean {
      if (!host.announceMode?.()) return false;
      this.refresh();
      return true;
    },
    /** The shell's `placed` acknowledgement. */
    placed(view: ThreadkeeperSlotView | null) { slots.acknowledge(view); },
    answerOverlayQuery() { host.reportOverlay(freshOverlays()); },
    openPalette() { openPaperclipPalette(doc); },
    dispose() {
      slots.dispose();
      watchOverlays(false);
    },
  };
}
