/** The extension is an optional host. It acquires no access through framing alone. */
const EXTENSION_ID = /^[a-p]{32}$/;
export type ThreadStackView = "browse" | "threads" | "dashboard";
/** Route segments of the browser-sessions plugin pages that the shell can draw in place (REQ-6). */
export type ThreadStackSlotView = "browse" | "threads" | "session-board";
export const THREADSTACK_PLUGIN_KEY = "browser-sessions";
/** Sender tag on the extension's shell messages. Wire id kept from the Threadkeeper name for compatibility. */
export const SHELL_MESSAGE_SOURCE = "threadkeeper-shell";
export const THREADSTACK_SLOT_VIEWS: readonly ThreadStackSlotView[] = ["browse", "threads", "session-board"];

export function threadStackSlotView(pluginKey: string | null | undefined, routePath: string | null | undefined): ThreadStackSlotView | null {
  if (pluginKey !== THREADSTACK_PLUGIN_KEY) return null;
  const view = routePath?.toLowerCase();
  return (THREADSTACK_SLOT_VIEWS as readonly string[]).includes(view ?? "") ? view as ThreadStackSlotView : null;
}

export const MAX_NOTICE_REGIONS = 8;
export const SLOT_ACTIVATION_WINDOW_MS = 250;
export type ColorScheme = "light" | "dark";
export interface ThreadStackRect { x: number; y: number; width: number; height: number }
export interface ThreadStackSlot { view: ThreadStackSlotView; rect: ThreadStackRect; scheme: ColorScheme }
/** Native input that Chromium delivered to the empty slot just after its overlay closed. */
export interface ThreadStackSlotActivation { view: "threads"; x: number; y: number }

export function finiteRect(rect: ThreadStackRect | null | undefined): rect is ThreadStackRect {
  return Boolean(rect) && [rect!.x, rect!.y, rect!.width, rect!.height].every(Number.isFinite) && rect!.width > 0 && rect!.height > 0;
}

/** Fused mode needs all three pages; without them the shell keeps its own view switch. */
export function fusedPagesAvailable(contributions: ReadonlyArray<{ pluginKey: string; slots: ReadonlyArray<{ type: string; routePath?: string }> }> | null | undefined): boolean {
  const plugin = contributions?.find((contribution) => contribution.pluginKey === THREADSTACK_PLUGIN_KEY);
  if (!plugin) return false;
  const routes = new Set(plugin.slots.filter((slot) => slot.type === "page").map((slot) => slot.routePath));
  return THREADSTACK_SLOT_VIEWS.every((view) => routes.has(view));
}

export function readThreadStackExtensionIds(doc: Document = document): string[] {
  const value = doc.querySelector<HTMLMetaElement>('meta[name="paperclip-threadstack-extension-ids"]')?.content ?? "";
  return [...new Set(value.split(/[\s,]+/).filter((id) => EXTENSION_ID.test(id)))];
}

export function isThreadStackPath(value: unknown): value is string {
  return typeof value === "string" && value.length <= 2000 && value.startsWith("/")
    && !value.startsWith("//") && !/[\\\u0000-\u0020\u007f]/.test(value);
}

/** Register before React mounts so iframe load messages survive lazy boot and effect remounts. */
export function createThreadStackBootChannel(options: { eventTarget: EventTarget; parent: Window; extensionIds: readonly string[] }) {
  const origins = new Set(options.extensionIds.filter(id => EXTENSION_ID.test(id)).map(id => `chrome-extension://${id}`));
  let hello: MessageEvent | null = null;
  let navigation: MessageEvent | null = null;
  let consumer: ((event: MessageEvent) => void) | null = null;
  let disposed = false;
  const receive = (raw: Event) => {
    const event = raw as MessageEvent;
    if (disposed || event.source !== options.parent || !origins.has(event.origin) || !event.data || typeof event.data !== "object") return;
    const data = event.data as Record<string, unknown>;
    if (data.source !== SHELL_MESSAGE_SOURCE || data.v !== 1) return;
    if (data.type === "hello") {
      hello = event;
      if (consumer) consumer(event);
    } else if (data.type === "navigate" && hello?.origin === event.origin && isThreadStackPath(data.path)) {
      if (consumer) consumer(event); else navigation = event;
    } else if (data.type !== "navigate" && hello?.origin === event.origin && consumer) {
      // Every other shell message (placed, command, overlay-query, …) goes to the host, which
      // validates its type and payload. Only hello and the latest navigation are buffered.
      consumer(event);
    }
  };
  options.eventTarget.addEventListener("message", receive);
  return {
    attach(next: (event: MessageEvent) => void): () => void {
      if (disposed) return () => {};
      consumer = next;
      if (hello) next(hello);
      if (navigation) { const pending = navigation; navigation = null; next(pending); }
      return () => { if (consumer === next) consumer = null; };
    },
    dispose() { disposed = true; consumer = null; hello = null; navigation = null; options.eventTarget.removeEventListener("message", receive); },
  };
}

interface HostOptions {
  extensionIds: readonly string[];
  parent: Window;
  navigate: (path: string) => void;
  currentPath: () => string;
  currentTitle: () => string;
  onConnection?: (connected: boolean) => void;
  /** Whether the shell may lay its views over this page (REQ-6 fused mode). */
  fusedAvailable?: () => boolean;
  /** The shell asks again whether an overlay is still open (its 60 s check). */
  onOverlayQuery?: () => void;
  /** Command+K pressed in a ThreadStack view. */
  onPalette?: () => void;
  /** The shell has laid this view over the content rectangle (or, with null, laid none). */
  onPlaced?: (view: ThreadStackSlotView | null) => void;
}

export function createThreadStackHost(options: HostOptions) {
  const origins = new Set(options.extensionIds.filter((id) => EXTENSION_ID.test(id)).map((id) => `chrome-extension://${id}`));
  let parentOrigin: string | null = null;
  let announcedMode: "fused" | "switching" | null = null;
  let lastSlot: string | null = null;
  let reportedSlot: ThreadStackSlot | null = null;
  // Owned by this host, never supplied by the input caller; retained across re-handshakes.
  let activationSequence = 0;
  const currentMode = () => (options.fusedAvailable?.() ? "fused" : "switching");
  const post = (body: Record<string, unknown>): boolean => {
    if (!parentOrigin) return false;
    options.parent.postMessage({ source: "paperclip-ui", v: 1, ...body }, parentOrigin);
    return true;
  };
  const reportRoute = () => {
    const path = options.currentPath();
    if (isThreadStackPath(path)) post({ type: "route", path, title: options.currentTitle().slice(0, 500) });
  };
  return {
    handleMessage(event: MessageEvent): boolean {
      if (event.source !== options.parent || !origins.has(event.origin)) return false;
      const data: unknown = event.data;
      if (!data || typeof data !== "object") return false;
      const message = data as Record<string, unknown>;
      if (message.source !== SHELL_MESSAGE_SOURCE || message.v !== 1) return false;
      if (message.type === "hello") {
        parentOrigin = event.origin;
        announcedMode = currentMode();
        lastSlot = null;
        reportedSlot = null;
        post({ type: "ready", mode: announcedMode });
        reportRoute();
        options.onConnection?.(true);
        return true;
      }
      if (event.origin !== parentOrigin) return false;
      if (message.type === "navigate" && isThreadStackPath(message.path)) {
        options.navigate(message.path);
        return true;
      }
      if (message.type === "overlay-query" && options.onOverlayQuery) {
        options.onOverlayQuery();
        return true;
      }
      if (message.type === "placed" && options.onPlaced
        && (message.view === null || (THREADSTACK_SLOT_VIEWS as readonly unknown[]).includes(message.view))) {
        options.onPlaced(message.view as ThreadStackSlotView | null);
        return true;
      }
      if (message.type === "command" && message.name === "palette" && options.onPalette) {
        options.onPalette();
        return true;
      }
      return false;
    },
    reportRoute,
    /** The mode announced in the last `ready`, or null before the handshake. */
    mode: () => announcedMode,
    /** Re-sends `ready` when fused availability changed after the handshake. */
    announceMode(): boolean {
      if (!parentOrigin) return false;
      const mode = currentMode();
      if (mode === announcedMode) return false;
      announcedMode = mode;
      // A new `ready` restarts the shell's slot window, so the current placement must follow it.
      lastSlot = null;
      reportedSlot = null;
      return post({ type: "ready", mode });
    },
    /** The page's content rectangle in this document's viewport, or null when no ThreadStack page shows. */
    reportSlot(slot: ThreadStackSlot | null, scheme: ColorScheme = slot?.scheme ?? "light"): boolean {
      if (!parentOrigin) return false;
      let body: Record<string, unknown>;
      if (slot) {
        if (!THREADSTACK_SLOT_VIEWS.includes(slot.view) || !finiteRect(slot.rect)) return false;
        const { x, y, width, height } = slot.rect;
        body = { type: "slot", view: slot.view, rect: { x, y, width, height }, scheme: slot.scheme };
      } else body = { type: "slot", view: null, rect: null, scheme };
      reportedSlot = slot ? { ...slot, rect: { ...slot.rect } } : null;
      const key = JSON.stringify(body);
      if (key === lastSlot) return false;
      lastSlot = key;
      return post(body);
    },
    /** Only session selection is eligible; the shell resolves the point against its current list. */
    reportSlotActivation(activation: ThreadStackSlotActivation): boolean {
      if (!parentOrigin || announcedMode !== "fused" || currentMode() !== "fused"
        || activation.view !== "threads" || reportedSlot?.view !== "threads"
        || !Number.isFinite(activation.x) || !Number.isFinite(activation.y)) return false;
      const { x, y, width, height } = reportedSlot.rect;
      if (activation.x < Math.max(0, x) || activation.y < Math.max(0, y)
        || activation.x >= x + width || activation.y >= y + height) return false;
      if (activationSequence >= Number.MAX_SAFE_INTEGER) return false;
      return post({ type: "slot-activate", view: "threads", x: activation.x, y: activation.y, sequence: ++activationSequence });
    },
    /** `open` counts blocking overlays only; notices travel as rectangles the shell cuts out of its view. */
    reportOverlay(report: { open: boolean; regions: readonly ThreadStackRect[] }): boolean {
      const regions = report.regions.filter(finiteRect).slice(0, MAX_NOTICE_REGIONS)
        .map(({ x, y, width, height }) => ({ x, y, width, height }));
      return post({ type: "overlay", open: report.open === true, regions });
    },
    reportDisconnected: () => post({ type: "disconnected" }),
    openView(view: unknown): boolean {
      if (view !== "browse" && view !== "threads" && view !== "dashboard") return false;
      return post({ type: "open-view", view });
    },
    openExternal(value: string): boolean {
      let url: URL;
      try { url = new URL(value); } catch { return false; }
      if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.href.length > 8000) return false;
      return post({ type: "open-link", url: url.href });
    },
    disconnect() {
      parentOrigin = null;
      announcedMode = null;
      lastSlot = null;
      reportedSlot = null;
      options.onConnection?.(false);
    },
  };
}
