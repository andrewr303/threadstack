// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadkeeperHost, fusedPagesAvailable, isThreadkeeperPath, readThreadkeeperExtensionIds, threadkeeperSlotView } from "./threadkeeper-host";

const id = "abcdefghijklmnopabcdefghijklmnop";

afterEach(() => { document.head.innerHTML = ""; vi.restoreAllMocks(); });

describe("Threadkeeper host boundary", () => {
  it("reads only validated runtime extension IDs", () => {
    document.head.innerHTML = `<meta name="paperclip-threadkeeper-extension-ids" content="${id},bad,${id}">`;
    expect(readThreadkeeperExtensionIds()).toEqual([id]);
  });

  it("refuses protocol-relative, escaped, control-character and overlength paths", () => {
    for (const path of ["//evil.test", "/\\evil.test", "/task\nfoo", "https://evil.test", "/" + "a".repeat(2000)]) {
      expect(isThreadkeeperPath(path)).toBe(false);
    }
    expect(isThreadkeeperPath("/ACME/issues/ACME-12?q=a#comment")).toBe(true);
  });

  it("does nothing without a runtime allowlist or outside a frame", () => {
    const postMessage = vi.fn();
    const host = createThreadkeeperHost({ extensionIds: [], parent: { postMessage } as unknown as Window, navigate: vi.fn(), currentPath: () => "/ACME/issues", currentTitle: () => "Tasks" });
    expect(host.handleMessage({ origin: `chrome-extension://${id}`, source: window.parent, data: { source: "threadkeeper-shell", v: 1, type: "hello" } } as MessageEvent)).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("authenticates the exact parent before navigation or route disclosure", () => {
    const postMessage = vi.fn();
    const navigate = vi.fn();
    const parent = { postMessage } as unknown as Window;
    const host = createThreadkeeperHost({ extensionIds: [id], parent, navigate, currentPath: () => "/ACME/issues", currentTitle: () => "Tasks" });
    const event = (origin: string, source: unknown, type: string, path?: string) => ({ origin, source, data: { source: "threadkeeper-shell", v: 1, type, path } } as MessageEvent);
    host.handleMessage(event("https://evil.test", parent, "hello"));
    host.handleMessage(event(`chrome-extension://${id}`, {}, "hello"));
    host.handleMessage(event(`chrome-extension://${id}`, parent, "navigate", "/ACME/agents"));
    expect(postMessage).not.toHaveBeenCalled();
    expect(navigate).not.toHaveBeenCalled();
    expect(host.handleMessage(event(`chrome-extension://${id}`, parent, "hello"))).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ source: "paperclip-ui", v: 1, type: "ready", mode: "switching" }, `chrome-extension://${id}`);
    expect(postMessage).toHaveBeenCalledWith({ source: "paperclip-ui", v: 1, type: "route", path: "/ACME/issues", title: "Tasks" }, `chrome-extension://${id}`);
    host.handleMessage(event(`chrome-extension://${id}`, parent, "navigate", "//evil.test"));
    expect(navigate).not.toHaveBeenCalled();
    host.handleMessage(event(`chrome-extension://${id}`, parent, "navigate", "/ACME/agents"));
    expect(navigate).toHaveBeenCalledWith("/ACME/agents");
  });

  it("opens only safe external links through the authenticated parent", () => {
    const postMessage = vi.fn();
    const parent = { postMessage } as unknown as Window;
    const host = createThreadkeeperHost({ extensionIds: [id], parent, navigate: vi.fn(), currentPath: () => "/", currentTitle: () => "Paperclip" });
    expect(host.openExternal("https://claude.ai/code/session_123")).toBe(false);
    host.handleMessage({ origin: `chrome-extension://${id}`, source: parent, data: { source: "threadkeeper-shell", v: 1, type: "hello" } } as MessageEvent);
    expect(host.openExternal("javascript:alert(1)")).toBe(false);
    expect(host.openExternal("https://claude.ai/code/session_123")).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ source: "paperclip-ui", v: 1, type: "open-link", url: "https://claude.ai/code/session_123" }, `chrome-extension://${id}`);
  });

  it("reports a lost native connection only after the exact allowed-parent handshake", () => {
    const postMessage = vi.fn(); const parent = { postMessage } as unknown as Window;
    const host = createThreadkeeperHost({ extensionIds: [id], parent, navigate: vi.fn(), currentPath: () => "/", currentTitle: () => "Paperclip" });
    expect(host.reportDisconnected()).toBe(false);
    host.handleMessage({ origin: `chrome-extension://${id}`, source: parent, data: { source: "threadkeeper-shell", v: 1, type: "hello" } } as MessageEvent);
    expect(host.reportDisconnected()).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ source: "paperclip-ui", v: 1, type: "disconnected" }, `chrome-extension://${id}`);
    host.disconnect();
    expect(host.reportDisconnected()).toBe(false);
  });
});

describe("Threadkeeper fused mode (REQ-6)", () => {
  const origin = `chrome-extension://${id}`;
  const connect = (options: Partial<Parameters<typeof createThreadkeeperHost>[0]> = {}) => {
    const postMessage = vi.fn();
    const parent = { postMessage } as unknown as Window;
    const host = createThreadkeeperHost({ extensionIds: [id], parent, navigate: vi.fn(), currentPath: () => "/ACME/threads", currentTitle: () => "Threads", ...options });
    const send = (data: Record<string, unknown>, from: string = origin) =>
      host.handleMessage({ origin: from, source: parent, data: { source: "threadkeeper-shell", v: 1, ...data } } as MessageEvent);
    return { host, postMessage, parent, send };
  };

  it("bounds session-selection handoff to the authenticated fused Threads slot", () => {
    const { host, postMessage, send } = connect({ fusedAvailable: () => true });
    const activation = { view: "threads" as const, x: 300, y: 100 };
    expect(host.reportSlotActivation?.(activation)).toBe(false);
    send({ type: "hello" });
    expect(host.reportSlotActivation?.(activation)).toBe(false);
    host.reportSlot({ view: "threads", rect: { x: 240, y: 48, width: 800, height: 600 }, scheme: "light" });
    expect(host.reportSlotActivation?.(activation)).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ source: "paperclip-ui", v: 1, type: "slot-activate", ...activation, sequence: 1 }, origin);
    for (const invalid of [{ ...activation, x: 239 }, { ...activation, y: 648 }, { ...activation, x: NaN }, { ...activation, y: Infinity }, { ...activation, view: "browse" }]) {
      expect(host.reportSlotActivation?.(invalid as typeof activation)).toBe(false);
    }
    host.reportSlot(null);
    expect(host.reportSlotActivation?.(activation)).toBe(false);
    host.disconnect();
    expect(host.reportSlotActivation?.(activation)).toBe(false);
  });

  it("assigns monotonic gesture sequences itself and does not consume numbers for rejected input", () => {
    const { host, postMessage, send } = connect({ fusedAvailable: () => true });
    const activation = { view: "threads" as const, x: 300, y: 100, sequence: 9000 };
    const slot = { view: "threads" as const, rect: { x: 240, y: 48, width: 800, height: 600 }, scheme: "light" as const };
    expect(host.reportSlotActivation(activation)).toBe(false);
    send({ type: "hello" }); host.reportSlot(slot);
    expect(host.reportSlotActivation(activation)).toBe(true);
    expect(host.reportSlotActivation({ ...activation, x: NaN })).toBe(false);
    expect(host.reportSlotActivation({ ...activation, x: 2000 })).toBe(false);
    expect(host.reportSlotActivation({ ...activation, x: 400 })).toBe(true);
    send({ type: "hello" });
    expect(host.reportSlotActivation(activation)).toBe(false); // a fresh ready needs its own slot
    host.reportSlot(slot);
    expect(host.reportSlotActivation(activation)).toBe(true);
    host.disconnect();
    expect(host.reportSlotActivation(activation)).toBe(false);
    send({ type: "hello" }); host.reportSlot(slot);
    expect(host.reportSlotActivation(activation)).toBe(true);
    const packets = postMessage.mock.calls.map(([packet]) => packet).filter(packet => packet.type === "slot-activate");
    expect(packets).toEqual([300, 400, 300, 300].map((x, index) => ({
      source: "paperclip-ui", v: 1, type: "slot-activate", view: "threads", x, y: 100, sequence: index + 1,
    })));
  });

  it("refuses slot activation while switching, after availability loss and on other plugin views", () => {
    let available = false;
    const { host, send } = connect({ fusedAvailable: () => available });
    const activation = { view: "threads" as const, x: 300, y: 100 };
    const rect = { x: 240, y: 48, width: 800, height: 600 };
    send({ type: "hello" }); host.reportSlot({ view: "threads", rect, scheme: "light" });
    expect(host.reportSlotActivation(activation)).toBe(false);
    available = true; host.announceMode();
    expect(host.reportSlotActivation(activation)).toBe(false); // new mode needs a fresh slot
    host.reportSlot({ view: "browse", rect, scheme: "light" });
    expect(host.reportSlotActivation(activation)).toBe(false);
    host.reportSlot({ view: "threads", rect, scheme: "light" });
    available = false;
    expect(host.reportSlotActivation(activation)).toBe(false);
  });

  it("announces fused mode only while the Threadkeeper pages are available and re-announces a change once", () => {
    let available = false;
    const { host, postMessage, send } = connect({ fusedAvailable: () => available });
    expect(host.announceMode()).toBe(false);
    send({ type: "hello" });
    expect(postMessage).toHaveBeenCalledWith({ source: "paperclip-ui", v: 1, type: "ready", mode: "switching" }, origin);
    postMessage.mockClear();
    available = true;
    expect(host.announceMode()).toBe(true);
    expect(postMessage).toHaveBeenCalledWith({ source: "paperclip-ui", v: 1, type: "ready", mode: "fused" }, origin);
    postMessage.mockClear();
    expect(host.announceMode()).toBe(false);
    expect(postMessage).not.toHaveBeenCalled();
  });

  it("re-sends the same slot after a mode change so the shell's new ready window gets one (F-1 order)", () => {
    let available = false;
    const { host, postMessage, send } = connect({ fusedAvailable: () => available });
    const slot = { view: "threads" as const, rect: { x: 240, y: 48, width: 1200, height: 800 }, scheme: "dark" as const };
    send({ type: "hello" });
    expect(host.reportSlot(slot)).toBe(true);
    available = true;
    postMessage.mockClear();
    expect(host.announceMode()).toBe(true);
    expect(host.reportSlot(slot)).toBe(true);
    expect(postMessage.mock.calls.map((call) => call[0].type)).toEqual(["ready", "slot"]);
    expect(postMessage.mock.calls[0]![0]).toMatchObject({ type: "ready", mode: "fused" });
  });

  it("reports the content rectangle only to the verified parent, skips repeats and clears it on leaving", () => {
    const { host, postMessage, send } = connect();
    const rect = { x: 240.5, y: 48, width: 1200, height: 800 };
    expect(host.reportSlot({ view: "threads", rect, scheme: "dark" })).toBe(false);
    send({ type: "hello" });
    postMessage.mockClear();
    expect(host.reportSlot({ view: "threads", rect, scheme: "dark" })).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ source: "paperclip-ui", v: 1, type: "slot", view: "threads", rect, scheme: "dark" }, origin);
    expect(host.reportSlot({ view: "threads", rect: { ...rect }, scheme: "dark" })).toBe(false);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(host.reportSlot({ view: "threads", rect: { ...rect, width: Number.NaN }, scheme: "dark" })).toBe(false);
    expect(host.reportSlot({ view: "settings" as never, rect, scheme: "dark" })).toBe(false);
    expect(host.reportSlot(null, "light")).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ source: "paperclip-ui", v: 1, type: "slot", view: null, rect: null, scheme: "light" }, origin);
    expect(postMessage).toHaveBeenCalledTimes(2);
    // A new handshake (a reloaded shell) gets the current placement again.
    send({ type: "hello" });
    expect(host.reportSlot(null, "light")).toBe(true);
  });

  it("answers overlay queries and opens the palette only for the verified parent", () => {
    const onOverlayQuery = vi.fn();
    const onPalette = vi.fn();
    const { send } = connect({ onOverlayQuery, onPalette });
    expect(send({ type: "overlay-query" })).toBe(false);
    expect(send({ type: "command", name: "palette" })).toBe(false);
    send({ type: "hello" });
    expect(send({ type: "command", name: "palette" }, "https://evil.test")).toBe(false);
    expect(send({ type: "command", name: "delete-everything" })).toBe(false);
    expect(onPalette).not.toHaveBeenCalled();
    expect(onOverlayQuery).not.toHaveBeenCalled();
    expect(send({ type: "overlay-query" })).toBe(true);
    expect(send({ type: "command", name: "palette" })).toBe(true);
    expect(onOverlayQuery).toHaveBeenCalledTimes(1);
    expect(onPalette).toHaveBeenCalledTimes(1);
  });

  it("reports blocking overlays with at most eight valid notice regions", () => {
    const { host, postMessage, send } = connect();
    expect(host.reportOverlay({ open: true, regions: [] })).toBe(false);
    send({ type: "hello" });
    const region = (i: number) => ({ x: 12, y: 700 - i * 60, width: 380, height: 52 });
    const regions = [region(0), { x: 1, y: 1, width: 0, height: 4 }, { x: Number.POSITIVE_INFINITY, y: 0, width: 4, height: 4 }, ...Array.from({ length: 9 }, (_, i) => region(i + 1))];
    expect(host.reportOverlay({ open: false, regions })).toBe(true);
    const sent = postMessage.mock.lastCall![0];
    expect(sent).toMatchObject({ source: "paperclip-ui", v: 1, type: "overlay", open: false });
    expect(sent.regions).toHaveLength(8);
    expect(sent.regions[0]).toEqual(region(0));
    expect(sent.regions[1]).toEqual(region(1));
    expect(host.reportOverlay({ open: true, regions: [] })).toBe(true);
    expect(postMessage).toHaveBeenLastCalledWith({ source: "paperclip-ui", v: 1, type: "overlay", open: true, regions: [] }, origin);
  });

  it("accepts the shell's placement acknowledgement only from the verified parent and for a known view (F-2)", () => {
    const onPlaced = vi.fn();
    const { send } = connect({ onPlaced });
    expect(send({ type: "placed", view: "threads" })).toBe(false);
    send({ type: "hello" });
    expect(send({ type: "placed", view: "threads" }, "https://evil.test")).toBe(false);
    expect(send({ type: "placed", view: "dashboard" })).toBe(false);
    expect(onPlaced).not.toHaveBeenCalled();
    expect(send({ type: "placed", view: "session-board" })).toBe(true);
    expect(send({ type: "placed", view: null })).toBe(true);
    expect(onPlaced.mock.calls).toEqual([["session-board"], [null]]);
  });

  it("recognizes the browser-sessions plugin pages that can be fused", () => {
    const slots = (routes: string[]) => routes.map((routePath) => ({ type: "page", routePath }));
    expect(fusedPagesAvailable([{ pluginKey: "browser-sessions", slots: slots(["browse", "threads", "session-board"]) }])).toBe(true);
    expect(fusedPagesAvailable([{ pluginKey: "browser-sessions", slots: slots(["browse"]) }])).toBe(false);
    expect(fusedPagesAvailable([{ pluginKey: "someone-else", slots: slots(["browse", "threads", "session-board"]) }])).toBe(false);
    expect(fusedPagesAvailable(undefined)).toBe(false);
    expect(threadkeeperSlotView("browser-sessions", "session-board")).toBe("session-board");
    expect(threadkeeperSlotView("browser-sessions", "wiki")).toBeNull();
    expect(threadkeeperSlotView("someone-else", "threads")).toBeNull();
  });
});
