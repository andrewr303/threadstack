// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyThreadkeeperSlotActivation, connectThreadkeeperFusion } from "./threadkeeper-host-fusion";
import { registerThreadkeeperSlot } from "./threadkeeper-host-slot";

class InertResizeObserver { observe() {} unobserve() {} disconnect() {} }

afterEach(() => { document.body.innerHTML = ""; document.documentElement.removeAttribute("style"); vi.restoreAllMocks(); });

function setup(initialMode: "fused" | "switching" | null = "fused") {
  const root = document.createElement("div");
  root.id = "root";
  document.body.append(root);
  let mode = initialMode;
  const host = { reportSlot: vi.fn(() => true), reportOverlay: vi.fn(() => true), reportSlotActivation: vi.fn(() => true), announceMode: vi.fn(() => true), mode: vi.fn(() => mode) };
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

  it("hands a trusted primary mouse press on the placed empty Threads slot to session selection only just after a real overlay close", async () => {
    const { root, host, fusion } = setup();
    const slot = document.createElement("div");
    root.append(slot);
    const release = registerThreadkeeperSlot("threads", slot);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.append(dialog);
    try {
      fusion.refresh();
      fusion.placed("threads");
      dialog.setAttribute("data-state", "closed");
      // Explicit classifier input; this does not manufacture a browser-trusted event.
      const click = { type: "pointerdown", pointerType: "mouse", isPrimary: true, isTrusted: true, button: 0, buttons: 1, detail: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: slot, clientX: 300, clientY: 100 };
      expect(fusion.activateSlot?.(click)).toBe(true); // may beat the queued MutationObserver
      expect(host.reportSlotActivation).toHaveBeenCalledExactlyOnceWith({ view: "threads", x: 300, y: 100 });
      expect(host.reportOverlay).toHaveBeenLastCalledWith({ open: false, regions: [] });
      expect(host.reportOverlay.mock.invocationCallOrder.at(-1)!).toBeLessThan(host.reportSlotActivation.mock.invocationCallOrder[0]!);
    } finally { release(); fusion.dispose(); dialog.remove(); }
  });

  it("classifies only unmodified trusted slot input within the bounded accepted-close window", () => {
    const element = document.createElement("div");
    document.body.append(element);
    const event = { type: "pointerdown", pointerType: "mouse", isPrimary: true, isTrusted: true, button: 0, buttons: 1, detail: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: element, clientX: 300, clientY: 100 };
    const context = { slot: { view: "threads" as const, element }, closedSlot: element, placed: true, bounds: { x: 240, y: 48, width: 800, height: 600 }, overlayOpen: false, closedAt: 1000, now: 1250 };
    expect(classifyThreadkeeperSlotActivation(event, context)).toEqual({ view: "threads", x: 300, y: 100 });
    for (const patch of [{ isTrusted: false }, { button: 1 }, { type: "click", detail: 1 }, { type: "pointerup" }, { pointerType: "touch" }, { pointerType: "pen" }, { pointerType: "" }, { isPrimary: false }, { buttons: 0 }, { buttons: 3 }, { defaultPrevented: true }, { metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { target: document.body }, { clientX: NaN }, { clientY: Infinity }, { clientX: 239 }, { clientY: 648 }]) {
      expect(classifyThreadkeeperSlotActivation({ ...event, ...patch }, context)).toBeNull();
    }
    for (const patch of [{ overlayOpen: true }, { placed: false }, { closedAt: null }, { now: 999 }, { now: 1251 }, { closedSlot: null }, { bounds: null }, { slot: null }, { slot: { view: "browse" as const, element } }]) {
      expect(classifyThreadkeeperSlotActivation(event, { ...context, ...patch })).toBeNull();
    }
    element.append(document.createElement("p"));
    expect(classifyThreadkeeperSlotActivation(event, context)).toBeNull();
    element.replaceChildren("Visible slot message");
    expect(classifyThreadkeeperSlotActivation(event, context)).toBeNull();
    element.replaceChildren();
    element.remove();
    expect(classifyThreadkeeperSlotActivation(event, context)).toBeNull();
  });

  it("rejects another still-open overlay, expired closes, mode changes and unacknowledged placement", () => {
    vi.spyOn(Date, "now").mockReturnValue(1000);
    const { root, host, fusion, setMode } = setup();
    const slot = document.createElement("div"); root.append(slot);
    const release = registerThreadkeeperSlot("threads", slot);
    const dialog = document.createElement("div"); dialog.setAttribute("role", "dialog"); dialog.setAttribute("data-state", "open"); document.body.append(dialog);
    const click = { type: "pointerdown", pointerType: "mouse", isPrimary: true, isTrusted: true, button: 0, buttons: 1, detail: 0, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, target: slot, clientX: 300, clientY: 100 };
    try {
      fusion.refresh(); fusion.placed("threads");
      expect(fusion.activateSlot(click)).toBe(false);
      dialog.setAttribute("data-state", "closed");
      fusion.answerOverlayQuery();
      fusion.placed(null);
      expect(fusion.activateSlot(click)).toBe(false);
      fusion.placed("threads");
      const approval = document.createElement("div"); approval.setAttribute("role", "alertdialog"); approval.textContent = "Approval"; document.body.append(approval);
      expect(fusion.activateSlot(click)).toBe(false);
      approval.remove(); fusion.answerOverlayQuery();
      vi.mocked(Date.now).mockReturnValue(1251);
      expect(fusion.activateSlot(click)).toBe(false);
      vi.mocked(Date.now).mockReturnValue(1100);
      setMode("switching");
      expect(fusion.activateSlot(click)).toBe(false);
      setMode("fused"); fusion.refresh(); fusion.placed("threads");
      expect(fusion.activateSlot(click)).toBe(false); // a fresh handshake clears old close authority
      expect(host.reportSlotActivation).not.toHaveBeenCalled();
    } finally { release(); fusion.dispose(); dialog.remove(); }
  });
});
