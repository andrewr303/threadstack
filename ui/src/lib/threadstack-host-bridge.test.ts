// @vitest-environment jsdom
// The real ThreadStackHostBridge, framed by an allowed extension: shell messages arrive as window
// `message` events through the early boot channel, exactly as in the browser (REQ-6 round 3).
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const id = "abcdefghijklmnopabcdefghijklmnop";
const origin = `chrome-extension://${id}`;
const contributions = [{
  pluginId: "plugin-bs", pluginKey: "browser-sessions", displayName: "Browser sessions", version: "1", uiEntryFile: "ui.js", launchers: [],
  slots: ["browse", "threads", "session-board"].map((routePath) => ({ type: "page", id: routePath, displayName: routePath, exportName: "Page", routePath })),
}];
vi.mock("../api/plugins", () => ({ pluginsApi: { listUiContributions: vi.fn(async () => contributions) } }));

let parentFrame: HTMLIFrameElement;
let parent: Window;
let post: ReturnType<typeof vi.fn>;
let root: Root;
let mount: HTMLDivElement;
let documentListeners: ReturnType<typeof vi.spyOn>;
const sent = () => post.mock.calls.map((call) => call[0] as Record<string, unknown>);

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function fromShell(data: Record<string, unknown>, from = origin, source: Window = parent) {
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: from, source, data: { source: "threadkeeper-shell", v: 1, ...data } })); });
  await flush();
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.head.innerHTML = `<meta name="paperclip-threadstack-extension-ids" content="${id}">`;
  parentFrame = document.createElement("iframe");
  document.body.append(parentFrame);
  parent = parentFrame.contentWindow!;
  post = vi.fn();
  parent.postMessage = post as unknown as Window["postMessage"];
  Object.defineProperty(window, "parent", { configurable: true, get: () => parent });
  const appRoot = document.createElement("div");
  appRoot.id = "root";
  document.body.append(appRoot);
  mount = document.createElement("div");
  appRoot.append(mount);
  documentListeners = vi.spyOn(document, "addEventListener");
  vi.resetModules();
  const { ThreadStackHostBridge } = await import("../components/ThreadStackHostBridge");
  root = createRoot(mount);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: ["/ACME/threads"] }, createElement(ThreadStackHostBridge))));
  });
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  documentListeners.mockRestore();
  Object.defineProperty(window, "parent", { configurable: true, get: () => window });
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-threadstack-slot");
  document.documentElement.removeAttribute("data-threadstack-host");
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
});

describe("ThreadStackHostBridge through the boot channel", () => {
  it("captures pointerdown for selection recovery and refuses programmatic pointer events", async () => {
    expect(documentListeners.mock.calls.filter((call: unknown[]) => call[0] === "pointerdown" && call[2] === true)).toHaveLength(1);
    await fromShell({ type: "hello" });
    const { registerThreadStackSlot } = await import("./threadstack-host-slot");
    const slot = document.createElement("div");
    document.getElementById("root")!.append(slot);
    const release = registerThreadStackSlot("threads", slot);
    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.append(dialog);
    try {
      await fromShell({ type: "placed", view: "threads" });
      await fromShell({ type: "overlay-query" });
      dialog.setAttribute("data-state", "closed");
      await flush();
      post.mockClear();
      // A script-created event is never represented as a browser-trusted pointer press.
      const event = new MouseEvent("pointerdown", { button: 0, buttons: 1, clientX: 300, clientY: 100, bubbles: true });
      expect(event.isTrusted).toBe(false);
      slot.dispatchEvent(event);
      await flush();
      expect(sent().some((packet) => packet.type === "slot-activate")).toBe(false);
    } finally { release(); dialog.remove(); }
  });
  it("delivers placed, the palette command and overlay queries from the verified shell", async () => {
    await fromShell({ type: "hello" });
    await flush();
    expect(sent()).toContainEqual({ source: "paperclip-ui", v: 1, type: "ready", mode: "fused" });
    const { registerThreadStackSlot } = await import("./threadstack-host-slot");
    const slot = document.createElement("div");
    document.getElementById("root")!.append(slot);
    const release = registerThreadStackSlot("threads", slot);

    await fromShell({ type: "placed", view: "threads" });
    expect(document.documentElement.getAttribute("data-threadstack-slot")).toBe("threads");

    const keys: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent) => keys.push(event);
    document.addEventListener("keydown", listener);
    await fromShell({ type: "command", name: "palette" });
    document.removeEventListener("keydown", listener);
    expect(keys.map((event) => [event.key, event.metaKey])).toEqual([["k", true]]);

    post.mockClear();
    await fromShell({ type: "overlay-query" });
    expect(sent()).toEqual([{ source: "paperclip-ui", v: 1, type: "overlay", open: false, regions: [] }]);
    release();
  });

  it("keeps refusing other origins and sources, and anything before hello", async () => {
    const { registerThreadStackSlot } = await import("./threadstack-host-slot");
    const slot = document.createElement("div");
    document.getElementById("root")!.append(slot);
    const release = registerThreadStackSlot("threads", slot);
    const keys: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent) => keys.push(event);
    document.addEventListener("keydown", listener);
    const refuse = async (from = origin, source = parent) => {
      await fromShell({ type: "placed", view: "threads" }, from, source);
      // placed has no reply: inspect its actual effect on a registered slot (N-4).
      expect(document.documentElement.hasAttribute("data-threadstack-slot")).toBe(false);
      await fromShell({ type: "command", name: "palette" }, from, source);
      await fromShell({ type: "overlay-query" }, from, source);
      expect(keys).toEqual([]);
      expect(sent()).toEqual([]);
    };
    try {
      await refuse();
      await fromShell({ type: "hello" });
      post.mockClear();
      await refuse("https://evil.test");
      await refuse(origin, window);
      // Prove the registered slot and keyboard listener would expose an accepted message.
      await fromShell({ type: "placed", view: "threads" });
      expect(document.documentElement.getAttribute("data-threadstack-slot")).toBe("threads");
      await fromShell({ type: "command", name: "palette" });
      expect(keys.map((event) => [event.key, event.metaKey])).toEqual([["k", true]]);
    } finally {
      document.removeEventListener("keydown", listener);
      release();
    }
  });
});
