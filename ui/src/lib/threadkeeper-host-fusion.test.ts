// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { connectThreadkeeperFusion } from "./threadkeeper-host-fusion";
import { registerThreadkeeperSlot } from "./threadkeeper-host-slot";

class InertResizeObserver { observe() {} unobserve() {} disconnect() {} }

afterEach(() => { document.body.innerHTML = ""; document.documentElement.removeAttribute("style"); });

function setup(initialMode: "fused" | "switching" | null = "fused") {
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  let mode = initialMode;
  const host = { reportSlot: vi.fn(() => true), reportOverlay: vi.fn(() => true), announceMode: vi.fn(() => true), mode: vi.fn(() => mode) };
  const fusion = connectThreadkeeperFusion({
    doc: document,
    root,
    host,
    measure: () => ({ x: 240, y: 48, width: 1200, height: 800 }),
    ResizeObserver: InertResizeObserver as unknown as typeof ResizeObserver,
    schedule: (run) => run(),
  });
  return { root, host, fusion, setMode: (next: typeof mode) => { mode = next; } };
}

describe("Threadkeeper fusion wiring", () => {
  it("forwards slot placement and overlay changes to the host", async () => {
    const { host, fusion } = setup();
    const element = document.createElement("div");
    document.body.querySelector("#root")!.append(element);
    const release = registerThreadkeeperSlot("threads", element);
    expect(host.reportSlot).toHaveBeenLastCalledWith({ view: "threads", rect: { x: 240, y: 48, width: 1200, height: 800 }, scheme: "light" }, "light");
    fusion.refresh(); // the fused ready (hello) starts the overlay observer
    const dialog = document.createElement("div");
    dialog.innerHTML = `<div role="dialog">Palette</div>`;
    document.body.append(dialog);
    await Promise.resolve();
    expect(host.reportOverlay).toHaveBeenLastCalledWith({ open: true, regions: [] });
    release();
    fusion.dispose();
  });

  it("re-sends the current state after a handshake and answers an overlay query with a fresh reading", () => {
    const { host, fusion } = setup();
    host.reportSlot.mockClear();
    host.reportOverlay.mockClear();
    fusion.refresh();
    expect(host.reportSlot).toHaveBeenCalledWith(null, "light");
    expect(host.reportOverlay).toHaveBeenCalledWith({ open: false, regions: [] });
    host.reportOverlay.mockClear();
    fusion.answerOverlayQuery();
    expect(host.reportOverlay).toHaveBeenCalledTimes(1);
    fusion.dispose();
  });

  it("forwards a Radix semantic close while the dialog and backdrop are still mounted", async () => {
    const { host, fusion } = setup();
    const content = document.createElement("div");
    content.setAttribute("role", "dialog");
    content.setAttribute("data-state", "open");
    content.innerHTML = `<input aria-label="Search">`;
    const backdrop = document.createElement("div");
    backdrop.setAttribute("data-slot", "dialog-overlay");
    backdrop.setAttribute("data-state", "open");
    document.body.append(backdrop, content);
    try {
      fusion.refresh();
      expect(host.reportOverlay).toHaveBeenLastCalledWith({ open: true, regions: [] });
      host.reportOverlay.mockClear();
      content.setAttribute("data-state", "closed");
      await Promise.resolve();
      expect(host.reportOverlay).not.toHaveBeenCalled(); // the backdrop is still open
      backdrop.setAttribute("data-state", "closed");
      await Promise.resolve();
      expect(host.reportOverlay).toHaveBeenCalledExactlyOnceWith({ open: false, regions: [] });
      expect(content.isConnected && backdrop.isConnected).toBe(true);
    } finally { fusion.dispose(); }
  });

  it("follows a changed ready with the current placement and overlays, and stays quiet otherwise (F-1)", () => {
    const { host, fusion } = setup();
    const element = document.createElement("div");
    document.body.append(element);
    const release = registerThreadkeeperSlot("threads", element);
    const order: string[] = [];
    host.announceMode.mockImplementation(() => { order.push("ready"); return true; });
    host.reportSlot.mockImplementation(() => { order.push("slot"); return true; });
    host.reportOverlay.mockImplementation(() => { order.push("overlay"); return true; });
    expect(fusion.announceMode()).toBe(true);
    expect(order).toEqual(["ready", "slot", "overlay"]);
    order.length = 0;
    host.announceMode.mockImplementation(() => { order.push("ready"); return false; });
    expect(fusion.announceMode()).toBe(false);
    expect(order).toEqual(["ready"]);
    release();
    fusion.dispose();
  });

  it("makes the page transparent only for the view the shell placed, until the next ready (F-2)", () => {
    const { fusion } = setup();
    const element = document.createElement("div");
    document.body.append(element);
    const release = registerThreadkeeperSlot("threads", element);
    expect(document.documentElement.hasAttribute("data-threadkeeper-slot")).toBe(false);
    fusion.placed("threads");
    expect(document.documentElement.getAttribute("data-threadkeeper-slot")).toBe("threads");
    // hello or a mode change sends a new ready: the shell has to place its view again.
    fusion.refresh();
    expect(document.documentElement.hasAttribute("data-threadkeeper-slot")).toBe(false);
    release();
    fusion.dispose();
  });

  it("watches overlays only after a fused ready and stops when the page switches back (quality F-4)", async () => {
    const { host, fusion, setMode } = setup(null);
    const dialog = () => { const element = document.createElement("div"); element.innerHTML = `<div role="dialog">Menu</div>`; document.body.append(element); return element; };
    const first = dialog();
    await Promise.resolve();
    expect(host.reportOverlay).not.toHaveBeenCalled();
    first.remove();
    setMode("switching");
    fusion.refresh();
    dialog();
    await Promise.resolve();
    expect(host.reportOverlay).not.toHaveBeenCalled();
    setMode("fused");
    fusion.refresh();
    expect(host.reportOverlay).toHaveBeenLastCalledWith({ open: true, regions: [] });
    document.body.querySelectorAll('[role="dialog"]').forEach((element) => element.parentElement!.remove());
    await Promise.resolve();
    expect(host.reportOverlay).toHaveBeenLastCalledWith({ open: false, regions: [] });
    const calls = host.reportOverlay.mock.calls.length;
    setMode("switching");
    fusion.refresh();
    dialog();
    await Promise.resolve();
    expect(host.reportOverlay).toHaveBeenCalledTimes(calls);
    // An explicit query is still answered with a fresh reading.
    fusion.answerOverlayQuery();
    expect(host.reportOverlay).toHaveBeenLastCalledWith({ open: true, regions: [] });
    fusion.dispose();
  });

  it("opens the existing command palette through its keyboard shortcut", () => {
    const { fusion } = setup();
    const seen: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent) => seen.push(event);
    document.addEventListener("keydown", listener);
    fusion.openPalette();
    document.removeEventListener("keydown", listener);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ key: "k", metaKey: true, bubbles: true, cancelable: true });
    fusion.dispose();
  });
});
