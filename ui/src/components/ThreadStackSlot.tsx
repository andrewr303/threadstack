import { useEffect, useRef, useState } from "react";
import type { ThreadStackSlotView } from "@/lib/threadstack-host";
import { registerThreadStackSlot, SLOT_ATTRIBUTE } from "@/lib/threadstack-host-slot";

/** The host bridge keeps this content rectangle opaque until the shell acknowledges placement. */
export function ThreadStackSlot({ view, label }: { view: ThreadStackSlotView; label: string }) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [unresponsive, setUnresponsive] = useState(false);
  useEffect(() => {
    if (!ref.current) return;
    const release = registerThreadStackSlot(view, ref.current);
    const documentRoot = ref.current.ownerDocument.documentElement;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let awaitingPlacement = false;
    const updatePlacement = () => {
      // Only the existing origin-validated host bridge acknowledges placement. This component
      // observes its result; it never enables transparency or accepts window messages itself.
      if (documentRoot.getAttribute(SLOT_ATTRIBUTE) === view) {
        clearTimeout(timer);
        timer = undefined;
        awaitingPlacement = false;
        setUnresponsive(false);
      } else if (!awaitingPlacement) {
        awaitingPlacement = true;
        setUnresponsive(false);
        timer = setTimeout(() => {
          timer = undefined;
          setUnresponsive(true);
        }, 2_000);
      }
    };
    const observer = new MutationObserver(updatePlacement);
    observer.observe(documentRoot, { attributes: true, attributeFilter: [SLOT_ATTRIBUTE] });
    updatePlacement();
    // After the slot report: a shell that is not fused (older, or past its 2 s window) still
    // switches to this view; a fused shell is already showing it.
    window.dispatchEvent(new CustomEvent("paperclip:threadstack-open-view", { detail: { view: view === "session-board" ? "dashboard" : view } }));
    return () => {
      observer.disconnect();
      clearTimeout(timer);
      release();
    };
  }, [view]);
  return (
    <div ref={ref} className="threadstack-slot" data-threadstack-slot-view={view} role="region" aria-label={label}>
      {unresponsive && <p role="status" className="text-sm text-muted-foreground">ThreadStack is not responding. Reload the window.</p>}
    </div>
  );
}
