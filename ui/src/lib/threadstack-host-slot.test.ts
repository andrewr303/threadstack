// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThreadStackSlotReporter, currentThreadStackSlot, registerThreadStackSlot } from "./threadstack-host-slot";

class FakeResizeObserver {
  static instances: FakeResizeObserver[] = [];
  observed = new Set<Element>();
  constructor(public callback: () => void) { FakeResizeObserver.instances.push(this); }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
  fire() { this.callback(); }
}

const html = document.documentElement;
afterEach(() => {
  FakeResizeObserver.instances = [];
  html.className = "";
  html.removeAttribute("data-threadstack-slot");
  html.removeAttribute("style");
  document.body.innerHTML = "";
});

function setup() {
  let rect = { x: 240, y: 48, width: 1200, height: 800 };
  const report = vi.fn();
  const reporter = createThreadStackSlotReporter({
    doc: document,
    report,
    measure: () => rect,
    ResizeObserver: FakeResizeObserver as unknown as typeof ResizeObserver,
  });
  const element = document.createElement("div");
  document.body.append(element);
  return { report, reporter, element, resize: (next: typeof rect) => { rect = next; } };
}

describe("ThreadStack slot reporter", () => {
  it("reports the registered slot, marks the document and clears both when the page leaves", () => {
    html.classList.add("dark");
    const { report, reporter, element } = setup();
    expect(report).toHaveBeenLastCalledWith(null, "dark");
    const unregister = registerThreadStackSlot("threads", element);
    expect(currentThreadStackSlot()?.view).toBe("threads");
    expect(report).toHaveBeenLastCalledWith({ view: "threads", rect: { x: 240, y: 48, width: 1200, height: 800 }, scheme: "dark" }, "dark");
    // Until the shell says it placed its view, the page keeps Paperclip's own background (F-2).
    expect(html.hasAttribute("data-threadstack-slot")).toBe(false);
    reporter.acknowledge("browse");
    expect(html.hasAttribute("data-threadstack-slot")).toBe(false);
    reporter.acknowledge("threads");
    expect(html.getAttribute("data-threadstack-slot")).toBe("threads");
    expect(html.style.getPropertyValue("--tk-slot-x")).toBe("240px");
    expect(html.style.getPropertyValue("--tk-slot-h")).toBe("800px");
    expect(FakeResizeObserver.instances[0]!.observed.has(element)).toBe(true);
    unregister();
    expect(currentThreadStackSlot()).toBeNull();
    expect(report).toHaveBeenLastCalledWith(null, "dark");
    expect(html.hasAttribute("data-threadstack-slot")).toBe(false);
    expect(html.style.getPropertyValue("--tk-slot-x")).toBe("");
    expect(FakeResizeObserver.instances[0]!.observed.has(element)).toBe(false);
    reporter.dispose();
  });

  it("drops the transparency when the shell withdraws its view or the page changes", () => {
    const { reporter, element } = setup();
    const unregister = registerThreadStackSlot("threads", element);
    reporter.acknowledge("threads");
    expect(html.getAttribute("data-threadstack-slot")).toBe("threads");
    reporter.acknowledge(null);
    expect(html.hasAttribute("data-threadstack-slot")).toBe(false);
    reporter.acknowledge("threads");
    unregister();
    const second = document.createElement("div");
    document.body.append(second);
    const next = registerThreadStackSlot("browse", second);
    // The acknowledgement was for Threads; Browse waits for its own.
    expect(html.hasAttribute("data-threadstack-slot")).toBe(false);
    next();
    reporter.dispose();
  });

  it("reports again when the rectangle, the window or the color scheme changes", async () => {
    const { report, reporter, element, resize } = setup();
    const unregister = registerThreadStackSlot("browse", element);
    resize({ x: 64, y: 48, width: 1376, height: 800 });
    FakeResizeObserver.instances[0]!.fire();
    expect(report).toHaveBeenLastCalledWith({ view: "browse", rect: { x: 64, y: 48, width: 1376, height: 800 }, scheme: "light" }, "light");
    resize({ x: 64, y: 48, width: 1000, height: 700 });
    window.dispatchEvent(new Event("resize"));
    expect(report).toHaveBeenLastCalledWith({ view: "browse", rect: { x: 64, y: 48, width: 1000, height: 700 }, scheme: "light" }, "light");
    html.classList.add("dark");
    await Promise.resolve();
    expect(report).toHaveBeenLastCalledWith({ view: "browse", rect: { x: 64, y: 48, width: 1000, height: 700 }, scheme: "dark" }, "dark");
    reporter.dispose();
    const calls = report.mock.calls.length;
    window.dispatchEvent(new Event("resize"));
    expect(report).toHaveBeenCalledTimes(calls);
    unregister();
  });

  it("keeps only the newest registration when routes swap pages", () => {
    const { report, reporter, element } = setup();
    const second = document.createElement("div");
    document.body.append(second);
    const first = registerThreadStackSlot("threads", element);
    const next = registerThreadStackSlot("session-board", second);
    first();
    expect(currentThreadStackSlot()?.view).toBe("session-board");
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ view: "session-board" }), "light");
    next();
    reporter.dispose();
  });
});
