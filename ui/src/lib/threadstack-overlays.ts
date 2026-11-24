import { MAX_NOTICE_REGIONS, finiteRect, type ThreadStackRect } from "./threadstack-host";

/**
 * One document-level observer for REQ-6 fused mode. Paperclip's overlays come from several
 * primitives (Radix dialog, popover, menu, select, tooltip, cmdk) and from pages that use those
 * primitives directly, so the overlays are found in the DOM rather than reported per component.
 *
 * - Blocking: active content portalled to <body> outside the app root, plus open dialogs and
 *   poppers drawn inside it. Closed Radix content may remain mounted for its exit animation.
 * - Notices: elements marked `data-threadstack-notice` (ToastViewport). They are reported as
 *   rectangles that the shell cuts out of its view, so the view stays usable around them.
 */
export interface ThreadStackOverlayState { open: boolean; regions: ThreadStackRect[] }
type Measure = (element: Element) => ThreadStackRect;

export const NOTICE_ATTRIBUTE = "data-threadstack-notice";
const IGNORE_SELECTOR = '[data-threadstack-overlay="ignore"]';
const INERT_TAGS = new Set(["script", "style", "link", "template", "noscript", "meta"]);
const IN_ROOT_SELECTOR = [
  'dialog[open]',
  '[role="dialog"]:not([data-state="closed"])',
  '[role="alertdialog"]:not([data-state="closed"])',
  '[aria-modal="true"]:not([data-state="closed"])',
  '[data-radix-popper-content-wrapper]',
].join(", ");

const defaultMeasure: Measure = (element) => element.getBoundingClientRect();

function shown(element: Element, view: Window | null): boolean {
  if (element.hasAttribute("hidden") || element.hasAttribute("inert")) return false;
  const style = view?.getComputedStyle(element);
  return !style || (style.display !== "none" && style.visibility !== "hidden");
}

/** Portal/popper wrappers have no state of their own; only ignore them if every branch is closed. */
function closedOverlayTree(element: Element): boolean {
  if (element.matches("dialog[open]")) return false;
  if (element.getAttribute("data-state") === "closed") return true;
  if (element.matches('[data-state="open"], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return false;
  return element.childElementCount > 0 && Array.from(element.childNodes).every((node) => {
    if (node.nodeType === 1) return closedOverlayTree(node as Element);
    return node.nodeType !== 3 || !node.textContent?.trim();
  });
}

function blockingOutsideRoot(element: Element, root: Element | null, view: Window | null): boolean {
  if (element === root || (root && element.contains(root))) return false;
  const tag = element.localName;
  // Custom elements are almost always browser-extension injections, never Paperclip overlays.
  if (INERT_TAGS.has(tag) || tag.includes("-") || element.matches(IGNORE_SELECTOR)) return false;
  if (closedOverlayTree(element)) return false;
  // Radix's backdrop is empty but remains a blocker while it is explicitly open.
  if (element.childElementCount === 0 && !element.textContent?.trim()
    && !element.matches('[data-state="open"], dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')) return false;
  return shown(element, view);
}

export function readThreadStackOverlays(options: { doc: Document; root: Element | null; measure?: Measure }): ThreadStackOverlayState {
  const { doc, root } = options;
  const measure = options.measure ?? defaultMeasure;
  const view = doc.defaultView;
  let open = false;
  for (const child of Array.from(doc.body?.children ?? [])) {
    if (blockingOutsideRoot(child, root, view)) { open = true; break; }
  }
  if (!open && root) {
    open = Array.from(root.querySelectorAll(IN_ROOT_SELECTOR)).some((element) => !closedOverlayTree(element) && shown(element, view));
  }
  const regions: ThreadStackRect[] = [];
  for (const notice of Array.from(doc.querySelectorAll(`[${NOTICE_ATTRIBUTE}]`))) {
    if (regions.length >= MAX_NOTICE_REGIONS) break;
    if (!shown(notice, view)) continue;
    const { x, y, width, height } = measure(notice);
    const region = { x, y, width, height };
    if (finiteRect(region)) regions.push(region);
  }
  return { open, regions };
}

/**
 * Calls back only when the state changed. Bursts of mutations and transitions are coalesced into
 * one scan per animation frame. A semantic close is checked in the mutation batch so restoring
 * input does not wait for another paint; other open overlays still keep the frame raised.
 */
export function observeThreadStackOverlays(options: {
  doc: Document;
  root: Element | null;
  measure?: Measure;
  onChange: (state: ThreadStackOverlayState) => void;
  /** Runs a scan on the next frame (requestAnimationFrame by default). */
  schedule?: (run: () => void) => void;
}) {
  const { doc } = options;
  const view = doc.defaultView;
  const schedule = options.schedule ?? ((run: () => void) => {
    if (view?.requestAnimationFrame) view.requestAnimationFrame(() => run());
    else queueMicrotask(run);
  });
  let last = readThreadStackOverlays(options);
  let key = JSON.stringify(last);
  let pending = false;
  let dirty = false;
  let disposed = false;
  const check = () => {
    const next = readThreadStackOverlays(options);
    const nextKey = JSON.stringify(next);
    last = next;
    if (nextKey === key) return;
    key = nextKey;
    options.onChange(next);
  };
  const request = () => {
    if (disposed) return;
    dirty = true;
    if (pending) return;
    pending = true;
    schedule(() => {
      pending = false;
      if (!disposed && dirty) { dirty = false; check(); }
    });
  };
  const observer = new MutationObserver((mutations) => {
    if (disposed) return;
    const closing = last.open && mutations.some((mutation) => {
      if (mutation.type === "attributes") {
        const element = mutation.target as Element;
        return (mutation.attributeName === "data-state" && element.getAttribute("data-state") === "closed")
          || (mutation.attributeName === "open" && element.matches("dialog:not([open])"));
      }
      // Without an exit animation (including reduced motion), Radix removes the portal outright.
      return Array.from(mutation.removedNodes).some((node) => node.nodeType === 1
        && (mutation.target === doc.body || (node as Element).matches(IN_ROOT_SELECTOR)
          || (node as Element).querySelector(IN_ROOT_SELECTOR)));
    });
    if (closing) {
      dirty = false; // This fresh scan also covers any work already queued for the next frame.
      check();
    } else request();
  });
  if (doc.body) {
    observer.observe(doc.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["open", "hidden", "inert", "data-state", "aria-modal", "style", NOTICE_ATTRIBUTE],
    });
  }
  // Notices slide in and restack with transitions that move them without a DOM mutation.
  doc.addEventListener("transitionend", request, true);
  view?.addEventListener("resize", request);
  return {
    /** A fresh reading, for the shell's overlay query. */
    read(): ThreadStackOverlayState { dirty = false; check(); return last; },
    dispose() {
      disposed = true;
      observer.disconnect();
      doc.removeEventListener("transitionend", request, true);
      view?.removeEventListener("resize", request);
    },
  };
}
