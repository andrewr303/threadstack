// @vitest-environment jsdom
import { act, createElement, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ToastProvider, useToastActions } from "../context/ToastContext";
import { ToastViewport } from "../components/ToastViewport";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "../components/ui/dialog";
import { observeThreadkeeperOverlays, readThreadkeeperOverlays } from "./threadkeeper-overlays";

let root: HTMLDivElement;
const rects = new Map<Element, { x: number; y: number; width: number; height: number }>();
const measure = (element: Element) => rects.get(element) ?? { x: 0, y: 0, width: 0, height: 0 };
const read = () => readThreadkeeperOverlays({ doc: document, root, measure });

beforeEach(() => {
  root = document.createElement("div");
  root.id = "root";
  root.innerHTML = `<div class="paperclip-app-shell"><main id="main-content"><p>Page</p></main></div>`;
  document.body.append(root);
});
afterEach(() => { document.body.innerHTML = ""; rects.clear(); });

function portal(html: string, attrs: Record<string, string> = {}): HTMLElement {
  const element = document.createElement("div");
  element.innerHTML = html;
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value);
  document.body.append(element);
  return element;
}

function toast(index: number, hidden = false): HTMLElement {
  const item = document.createElement("li");
  item.setAttribute("data-threadkeeper-notice", "");
  item.innerHTML = `<p>Notice ${index}</p><button>Open</button>`;
  if (hidden) item.style.display = "none";
  root.querySelector(".paperclip-app-shell")!.append(item);
  rects.set(item, { x: 12, y: 700 - index * 60, width: 380, height: 52 });
  return item;
}

describe("Threadkeeper overlay observer", () => {
  it("reports nothing for the idle app", () => {
    expect(read()).toEqual({ open: false, regions: [] });
  });

  it("counts anything portalled outside the app root as a blocking overlay", () => {
    const radix = portal(`<div role="dialog" data-state="open"><input aria-label="Search"></div>`);
    expect(read().open).toBe(true);
    radix.remove();
    const popper = portal(`<div data-radix-popper-content-wrapper><div role="menu">Item</div></div>`);
    expect(read().open).toBe(true);
    popper.remove();
    expect(read().open).toBe(false);
  });

  it("ignores hidden, inert, empty, script, custom and opted-out elements outside the root", () => {
    portal(`<p>Recovery</p>`, { hidden: "" });
    portal(`<div role="region">Bulk actions</div>`, { inert: "", "aria-hidden": "true" });
    portal("");
    portal(`<p>Extension badge</p>`, { "data-threadkeeper-overlay": "ignore" });
    portal(`<p>Not shown</p>`, { style: "display: none" });
    const script = document.createElement("script");
    script.textContent = "1";
    document.body.append(script);
    const custom = document.createElement("grammarly-extension");
    custom.textContent = "injected";
    document.body.append(custom);
    expect(read()).toEqual({ open: false, regions: [] });
  });

  it("counts open dialogs and poppers drawn inside the app root, but not closed ones", () => {
    const shell = root.querySelector(".paperclip-app-shell")!;
    shell.insertAdjacentHTML("beforeend", `<div role="dialog" data-state="closed">Closing</div>`);
    expect(read().open).toBe(false);
    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    dialog.textContent = "Native";
    shell.append(dialog);
    expect(read().open).toBe(true);
    dialog.remove();
    shell.insertAdjacentHTML("beforeend", `<div data-radix-popper-content-wrapper><div role="listbox">Options</div></div>`);
    expect(read().open).toBe(true);
  });

  it.each(["body", "portal wrapper", "in-root popper"])("stops blocking for closed content retained by %s", (location) => {
    const container = location === "body" ? document.body : location === "portal wrapper" ? portal("") : root;
    const wrapper = document.createElement("div");
    if (location === "in-root popper") wrapper.setAttribute("data-radix-popper-content-wrapper", "");
    wrapper.innerHTML = `<div role="dialog" data-state="open"><input aria-label="Search"></div>`;
    container.append(wrapper);
    const content = wrapper.firstElementChild!;
    expect(read().open).toBe(true);
    content.setAttribute("data-state", "closed");
    // Presence retains the content until animationend, despite its semantic close.
    expect(content.isConnected).toBe(true);
    expect(read()).toEqual({ open: false, regions: [] });
  });

  it("keeps an independently open backdrop blocking after its dialog closes", () => {
    const backdrop = portal("", { "data-slot": "dialog-overlay", "data-state": "open" });
    const content = portal(`<input aria-label="Search">`, { role: "dialog", "data-state": "open" });
    expect(read().open).toBe(true);
    content.setAttribute("data-state", "closed");
    expect(read().open).toBe(true);
    backdrop.setAttribute("data-state", "closed");
    expect(read().open).toBe(false);
    // Reporting never removes the legitimate backdrop or edits its styles.
    expect(backdrop.isConnected).toBe(true);
    expect(backdrop.hasAttribute("style")).toBe(false);
  });

  it("keeps another open overlay and unmarked portal content blocking", () => {
    const wrapper = portal(`<div role="dialog" data-state="closed">Closing palette</div><div role="alertdialog" data-state="open">Approval</div>`);
    expect(read().open).toBe(true);
    wrapper.lastElementChild!.setAttribute("data-state", "closed");
    expect(read().open).toBe(false);
    wrapper.insertAdjacentHTML("beforeend", `<p>Unmarked overlay</p>`);
    expect(read().open).toBe(true);
  });

  it("preserves an unmarked empty backdrop beside closed content", () => {
    const wrapper = portal(`<div role="dialog" data-state="closed">Closing</div><div class="backdrop"></div>`);
    expect(read().open).toBe(true);
    wrapper.lastElementChild!.remove();
    expect(read().open).toBe(false);
  });

  it.each(["portal removal", "native dialog close"])("reports %s without waiting for a frame", async (close) => {
    const dialog = close === "portal removal" ? portal(`<input aria-label="Search">`, { role: "dialog" }) : document.createElement("dialog");
    if (close === "native dialog close") { dialog.setAttribute("open", ""); root.append(dialog); }
    const frames: Array<() => void> = [];
    const onChange = vi.fn();
    const observer = observeThreadkeeperOverlays({ doc: document, root, measure, onChange, schedule: (run) => { frames.push(run); } });
    try {
      expect(observer.read().open).toBe(true);
      if (close === "portal removal") dialog.remove(); else dialog.removeAttribute("open");
      await Promise.resolve();
      expect(onChange).toHaveBeenCalledExactlyOnceWith({ open: false, regions: [] });
      expect(frames).toHaveLength(0);
    } finally { observer.dispose(); }
  });

  it("does not lower the frame when another dialog opens in the same close batch", async () => {
    const palette = portal(`<input aria-label="Search">`, { role: "dialog", "data-state": "open" });
    const onChange = vi.fn();
    const observer = observeThreadkeeperOverlays({ doc: document, root, measure, onChange, schedule: (run) => run() });
    try {
      palette.setAttribute("data-state", "closed");
      portal(`<p>Approval</p>`, { role: "alertdialog", "data-state": "open" });
      await Promise.resolve();
      expect(onChange).not.toHaveBeenCalled();
      expect(observer.read().open).toBe(true);
    } finally { observer.dispose(); }
  });

  it("reports a semantic close before a queued frame, after checking every remaining overlay", async () => {
    const palette = portal(`<input aria-label="Search">`, { role: "dialog", "data-state": "open" });
    const approval = portal(`<p>Approval</p>`, { role: "alertdialog", "data-state": "open" });
    const frames: Array<() => void> = [];
    const onChange = vi.fn();
    const observer = observeThreadkeeperOverlays({ doc: document, root, measure, onChange, schedule: (run) => { frames.push(run); } });
    try {
      // Leave an unrelated DOM scan pending when the close arrives.
      root.querySelector("p")!.textContent = "Updated";
      await Promise.resolve();
      expect(frames).toHaveLength(1);
      palette.setAttribute("data-state", "closed");
      await Promise.resolve();
      expect(onChange).not.toHaveBeenCalled(); // the approval still blocks
      approval.setAttribute("data-state", "closed");
      await Promise.resolve();
      expect(onChange).toHaveBeenCalledExactlyOnceWith({ open: false, regions: [] });
      expect(frames).toHaveLength(1);
      frames.shift()!();
      expect(onChange).toHaveBeenCalledTimes(1);
    } finally { observer.dispose(); }
  });

  it("follows the real Radix Escape lifecycle while exit animations retain content and backdrop", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("CSS", { escape: (value: string) => value });
    // Browsers expose live computed styles; jsdom snapshots them. Model only animationName
    // so real Radix Presence takes its unmountSuspended path, without a browser/timer harness.
    const computedStyle = window.getComputedStyle.bind(window);
    const styleSpy = vi.spyOn(window, "getComputedStyle").mockImplementation((element, pseudo) => {
      const style = computedStyle(element, pseudo);
      if (!element.matches('[data-slot="dialog-content"], [data-slot="dialog-overlay"]')) return style;
      return new Proxy(style, { get(target, key) {
        return key === "animationName" ? `dialog-${element.getAttribute("data-state")}` : Reflect.get(target, key);
      } });
    });
    const reactRoot = createRoot(root);
    let observer: ReturnType<typeof observeThreadkeeperOverlays> | undefined;
    try {
      await act(async () => reactRoot.render(createElement(Dialog, { defaultOpen: true },
        createElement(DialogTrigger, null, "Search"),
        createElement(DialogContent, null,
          createElement(DialogTitle, null, "Command Palette"),
          createElement(DialogDescription, null, "Search commands"),
          createElement("input", { "aria-label": "Search commands" })),
      )));
      const content = document.querySelector('[data-slot="dialog-content"]')!;
      const backdrop = document.querySelector('[data-slot="dialog-overlay"]')!;
      expect(content.parentElement).toBe(document.body);
      expect(backdrop.parentElement).toBe(document.body);
      expect(content.getAttribute("data-state")).toBe("open");
      expect(read().open).toBe(true);
      const onChange = vi.fn();
      observer = observeThreadkeeperOverlays({ doc: document, root, measure, onChange, schedule: (run) => run() });
      await act(async () => document.activeElement!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
      expect(content.getAttribute("data-state")).toBe("closed");
      expect(backdrop.getAttribute("data-state")).toBe("closed");
      expect(content.isConnected && backdrop.isConnected).toBe(true);
      expect(read()).toEqual({ open: false, regions: [] });
      expect(onChange).toHaveBeenLastCalledWith({ open: false, regions: [] });
      const finish = (element: Element) => {
        const event = new Event("animationend", { bubbles: true });
        Object.defineProperty(event, "animationName", { value: "dialog-closed" });
        element.dispatchEvent(event);
      };
      await act(async () => { finish(content); finish(backdrop); });
      expect(content.isConnected || backdrop.isConnected).toBe(false);
      expect(read().open).toBe(false);
    } finally {
      observer?.dispose();
      await act(async () => reactRoot.unmount());
      styleSpy.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it("reports visible notices as at most eight regions without counting them as open", () => {
    toast(0);
    toast(1, true);
    for (let i = 2; i < 12; i++) toast(i);
    const state = read();
    expect(state.open).toBe(false);
    expect(state.regions).toHaveLength(8);
    expect(state.regions[0]).toEqual({ x: 12, y: 700, width: 380, height: 52 });
    expect(state.regions.some((region) => region.y === 640)).toBe(false);
  });

  it("finds Paperclip's real toast items as notices", () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const mount = document.createElement("div");
    root.append(mount);
    const reactRoot = createRoot(mount);
    function Notify() {
      const { pushToast } = useToastActions();
      useEffect(() => { pushToast({ title: "Run finished", action: { label: "Open", onClick: () => {} } }); }, [pushToast]);
      return createElement(ToastViewport);
    }
    try {
      act(() => reactRoot.render(createElement(ToastProvider, null, createElement(Notify))));
      const notices = root.querySelectorAll("[data-threadkeeper-notice]");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.textContent).toContain("Run finished");
      const state = readThreadkeeperOverlays({ doc: document, root, measure: () => ({ x: 12, y: 700, width: 380, height: 64 }) });
      expect(state).toEqual({ open: false, regions: [{ x: 12, y: 700, width: 380, height: 64 }] });
    } finally {
      act(() => reactRoot.unmount());
      vi.unstubAllGlobals();
    }
  });

  it("calls back once per distinct change, from one observer on the body", async () => {
    const onChange = vi.fn();
    // A synchronous frame keeps this test about change detection; coalescing is tested below.
    const observer = observeThreadkeeperOverlays({ doc: document, root, measure, onChange, schedule: (run) => run() });
    expect(observer.read()).toEqual({ open: false, regions: [] });
    const dialog = portal(`<div role="dialog">Palette</div>`);
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ open: true, regions: [] });
    dialog.querySelector("div")!.setAttribute("data-state", "open");
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(1);
    dialog.remove();
    await Promise.resolve();
    expect(onChange).toHaveBeenLastCalledWith({ open: false, regions: [] });
    const item = toast(0);
    await Promise.resolve();
    expect(onChange).toHaveBeenLastCalledWith({ open: false, regions: [{ x: 12, y: 700, width: 380, height: 52 }] });
    // A notice that finishes sliding in moves without a DOM mutation.
    rects.set(item, { x: 12, y: 690, width: 380, height: 52 });
    document.dispatchEvent(new Event("transitionend"));
    expect(onChange).toHaveBeenLastCalledWith({ open: false, regions: [{ x: 12, y: 690, width: 380, height: 52 }] });
    const calls = onChange.mock.calls.length;
    observer.dispose();
    portal(`<div role="dialog">After dispose</div>`);
    await Promise.resolve();
    expect(onChange).toHaveBeenCalledTimes(calls);
  });

  it("coalesces separate mutation batches into one scan per frame (quality F-4)", async () => {
    const frames: Array<() => void> = [];
    const onChange = vi.fn();
    const observer = observeThreadkeeperOverlays({ doc: document, root, measure, onChange, schedule: (run) => { frames.push(run); } });
    portal(`<div role="dialog">A</div>`);
    await Promise.resolve();
    portal(`<div role="dialog">B</div>`);
    await Promise.resolve();
    document.dispatchEvent(new Event("transitionend"));
    expect(onChange).not.toHaveBeenCalled();
    expect(frames).toHaveLength(1);
    frames.shift()!();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith({ open: true, regions: [] });
    // read() stays a fresh, synchronous reading for the shell's overlay query.
    document.body.querySelectorAll('[role="dialog"]').forEach((element) => element.parentElement!.remove());
    expect(observer.read()).toEqual({ open: false, regions: [] });
    observer.dispose();
  });
});
