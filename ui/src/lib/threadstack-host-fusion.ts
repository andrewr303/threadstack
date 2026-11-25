import { finiteRect, SLOT_ACTIVATION_WINDOW_MS, type ColorScheme, type ThreadStackRect, type ThreadStackSlot, type ThreadStackSlotActivation, type ThreadStackSlotView } from "./threadstack-host";
import { createThreadStackSlotReporter, currentThreadStackSlot, SLOT_ATTRIBUTE } from "./threadstack-host-slot";
import { observeThreadStackOverlays, readThreadStackOverlays, type ThreadStackOverlayState } from "./threadstack-overlays";

/** Opens the command palette the same way Paperclip's own search button does (`Layout.openSearch`). */
export function openPaperclipPalette(doc: Document): void {
  doc.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true, cancelable: true }));
}

type SlotPointerDown = Pick<PointerEvent, "type" | "pointerType" | "isPrimary" | "isTrusted" | "button" | "buttons" | "defaultPrevented" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey" | "target" | "clientX" | "clientY">;

/** Classifies native slot input, never an instruction to activate arbitrary DOM controls. */
export function classifyThreadStackSlotActivation(event: SlotPointerDown, context: {
  slot: ReturnType<typeof currentThreadStackSlot>;
  closedSlot: HTMLElement | null;
  placed: boolean;
  bounds: ThreadStackRect | null;
  overlayOpen: boolean;
  closedAt: number | null;
  now: number;
}): ThreadStackSlotActivation | null {
  const { slot, bounds, closedAt, now } = context;
  if (event.type !== "pointerdown" || event.pointerType !== "mouse" || !event.isPrimary
    || !event.isTrusted || event.button !== 0 || event.buttons !== 1 || event.defaultPrevented
    || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    || context.overlayOpen || !context.placed || closedAt === null || now < closedAt
    || now - closedAt > SLOT_ACTIVATION_WINDOW_MS || slot?.view !== "threads"
    || context.closedSlot !== slot.element || !slot.element.isConnected || event.target !== slot.element
    || slot.element.childElementCount !== 0 || slot.element.textContent?.trim()
    || !finiteRect(bounds) || !Number.isFinite(event.clientX) || !Number.isFinite(event.clientY)
    || event.clientX < Math.max(0, bounds.x) || event.clientY < Math.max(0, bounds.y)
    || event.clientX >= bounds.x + bounds.width || event.clientY >= bounds.y + bounds.height) return null;
  return { view: "threads", x: event.clientX, y: event.clientY };
}

/** REQ-6 fused mode on the Paperclip side: placement, overlays and the palette command. */
export function connectThreadStackFusion(options: {
  doc: Document;
  root: Element | null;
  host: {
    reportSlot: (slot: ThreadStackSlot | null, scheme: ColorScheme) => boolean;
    reportOverlay: (state: ThreadStackOverlayState) => boolean;
    reportSlotActivation?: (activation: ThreadStackSlotActivation) => boolean;
    announceMode?: () => boolean;
    /** The mode last announced in `ready`; overlays are watched only while it is fused. */
    mode?: () => "fused" | "switching" | null;
  };
  measure?: (element: HTMLElement) => ThreadStackRect;
  ResizeObserver?: typeof ResizeObserver;
  schedule?: (run: () => void) => void;
}) {
  const { doc, root, host } = options;
  let disposed = false;
  let lastOverlayOpen = false;
  let closedAt: number | null = null;
  let closedSlot: HTMLElement | null = null;
  const rememberOverlay = (state: ThreadStackOverlayState) => {
    if (state.open) { closedAt = null; closedSlot = null; }
    else if (lastOverlayOpen) { closedAt = Date.now(); closedSlot = currentThreadStackSlot()?.element ?? null; }
    lastOverlayOpen = state.open;
    return state;
  };
  const slots = createThreadStackSlotReporter({
    doc,
    report: (slot, scheme) => { host.reportSlot(slot, scheme); },
    measure: options.measure,
    ResizeObserver: options.ResizeObserver,
  });
  // The body observer costs a scan per frame of DOM activity; it runs only after a fused `ready`.
  let overlays: ReturnType<typeof observeThreadStackOverlays> | null = null;
  const watchOverlays = (on: boolean) => {
    if (on && !overlays) overlays = observeThreadStackOverlays({ doc, root, schedule: options.schedule, onChange: (state) => { host.reportOverlay(rememberOverlay(state)); } });
    if (!on && overlays) { overlays.dispose(); overlays = null; }
  };
  const freshOverlays = () => rememberOverlay(overlays?.read() ?? readThreadStackOverlays({ doc, root }));
  return {
    /** After a (re)handshake the shell needs the current placement and overlay state. */
    refresh() {
      closedAt = null;
      closedSlot = null;
      lastOverlayOpen = false;
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
    placed(view: ThreadStackSlotView | null) { slots.acknowledge(view); },
    /** Recover a primary mouse press before down/up can land in different documents and lose click. */
    activateSlot(event: SlotPointerDown): boolean {
      if (disposed || host.mode?.() !== "fused") return false;
      const state = freshOverlays(); // may observe the semantic close before its mutation callback
      const slot = currentThreadStackSlot();
      const activation = classifyThreadStackSlotActivation(event, {
        slot, closedSlot, closedAt, now: Date.now(), overlayOpen: state.open,
        placed: doc.documentElement.getAttribute(SLOT_ATTRIBUTE) === "threads",
        bounds: slot ? (options.measure?.(slot.element) ?? slot.element.getBoundingClientRect()) : null,
      });
      if (!activation) return false;
      slots.update(); // the host validates against the current measured slot, not a stale rectangle
      return host.reportSlotActivation?.(activation) ?? false;
    },
    answerOverlayQuery() { host.reportOverlay(freshOverlays()); },
    openPalette() { openPaperclipPalette(doc); },
    dispose() {
      disposed = true;
      slots.dispose();
      watchOverlays(false);
    },
  };
}
