import type { ColorScheme, ThreadStackRect, ThreadStackSlot, ThreadStackSlotView } from "./threadstack-host";

/**
 * The content rectangle of a ThreadStack page in fused mode (REQ-6). `PluginPage` registers its
 * transparent slot element here; the host bridge reports the element's rectangle to the shell,
 * which lays the matching ThreadStack view over it. The document is marked so the app shell paints
 * its background everywhere except that rectangle (see `index.css`).
 */
interface Registration { view: ThreadStackSlotView; element: HTMLElement; token: symbol }
let current: Registration | null = null;
const observers = new Set<() => void>();
const notify = () => { for (const observer of observers) observer(); };

export const currentThreadStackSlot = (): { view: ThreadStackSlotView; element: HTMLElement } | null =>
  current ? { view: current.view, element: current.element } : null;

export function registerThreadStackSlot(view: ThreadStackSlotView, element: HTMLElement): () => void {
  const token = Symbol("threadstack-slot");
  current = { view, element, token };
  notify();
  return () => {
    if (current?.token !== token) return;
    current = null;
    notify();
  };
}

export function subscribeThreadStackSlot(observer: () => void): () => void {
  observers.add(observer);
  return () => { observers.delete(observer); };
}

export const SLOT_ATTRIBUTE = "data-threadstack-slot";
const SLOT_VARS = ["--tk-slot-x", "--tk-slot-y", "--tk-slot-w", "--tk-slot-h"] as const;

export function documentColorScheme(doc: Document): ColorScheme {
  return doc.documentElement.classList.contains("dark") ? "dark" : "light";
}

export function createThreadStackSlotReporter(options: {
  doc: Document;
  report: (slot: ThreadStackSlot | null, scheme: ColorScheme) => void;
  measure?: (element: HTMLElement) => ThreadStackRect;
  ResizeObserver?: typeof ResizeObserver;
}) {
  const { doc } = options;
  const root = doc.documentElement;
  const view = doc.defaultView;
  const measure = options.measure ?? ((element: HTMLElement) => element.getBoundingClientRect());
  const ResizeObserverImpl = options.ResizeObserver ?? (typeof ResizeObserver === "undefined" ? null : ResizeObserver);
  let observed: HTMLElement | null = null;
  /** The view the shell says it laid over the rectangle; only then is the page made transparent. */
  let placed: ThreadStackSlotView | null = null;

  const update = () => {
    const scheme = documentColorScheme(doc);
    const slot = current;
    if (!slot || !slot.element.isConnected) {
      root.removeAttribute(SLOT_ATTRIBUTE);
      for (const name of SLOT_VARS) root.style.removeProperty(name);
      options.report(null, scheme);
      return;
    }
    const { x, y, width, height } = measure(slot.element);
    const rect = { x, y, width, height };
    if (placed === slot.view) root.setAttribute(SLOT_ATTRIBUTE, slot.view);
    else root.removeAttribute(SLOT_ATTRIBUTE);
    [x, y, width, height].forEach((value, index) => root.style.setProperty(SLOT_VARS[index]!, `${value}px`));
    options.report({ view: slot.view, rect, scheme }, scheme);
  };

  const resizeObserver = ResizeObserverImpl ? new ResizeObserverImpl(() => update()) : null;
  const follow = () => {
    const element = current?.element ?? null;
    if (element !== observed) {
      if (observed) resizeObserver?.unobserve(observed);
      if (element) resizeObserver?.observe(element);
      observed = element;
      // A new page waits for its own acknowledgement.
      placed = null;
    }
    update();
  };
  // Theme switches flip the `dark` class on <html>; the shell must match the frame's color-scheme.
  const theme = new MutationObserver(update);
  theme.observe(root, { attributes: true, attributeFilter: ["class"] });
  const stopRegistry = subscribeThreadStackSlot(follow);
  view?.addEventListener("resize", update);
  follow();
  return {
    update,
    acknowledge(view: ThreadStackSlotView | null) {
      placed = view;
      update();
    },
    dispose() {
      stopRegistry();
      theme.disconnect();
      resizeObserver?.disconnect();
      observed = null;
      view?.removeEventListener("resize", update);
      root.removeAttribute(SLOT_ATTRIBUTE);
      for (const name of SLOT_VARS) root.style.removeProperty(name);
    },
  };
}
