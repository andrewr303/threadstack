// @vitest-environment jsdom
// The real ThreadkeeperHostBridge, framed by an allowed extension: shell messages arrive as window
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
const sent = () => post.mock.calls.map((call) => call[0] as Record<string, unknown>);

async function flush() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); }); }
async function fromShell(data: Record<string, unknown>, from = origin, source: Window = parent) {
  await act(async () => { window.dispatchEvent(new MessageEvent("message", { origin: from, source, data: { source: "threadkeeper-shell", v: 1, ...data } })); });
  await flush();
}

beforeEach(async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  document.head.innerHTML = `<meta name="paperclip-threadkeeper-extension-ids" content="${id}">`;
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
  vi.resetModules();
  const { ThreadkeeperHostBridge } = await import("../components/ThreadkeeperHostBridge");
  root = createRoot(mount);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(createElement(QueryClientProvider, { client }, createElement(MemoryRouter, { initialEntries: ["/ACME/threads"] }, createElement(ThreadkeeperHostBridge))));
  });
  await flush();
});

afterEach(async () => {
  await act(async () => root.unmount());
  Object.defineProperty(window, "parent", { configurable: true, get: () => window });
  document.body.innerHTML = "";
  document.head.innerHTML = "";
  document.documentElement.removeAttribute("data-threadkeeper-slot");
  document.documentElement.removeAttribute("data-threadkeeper-host");
  document.documentElement.removeAttribute("style");
  vi.unstubAllGlobals();
});

describe("ThreadkeeperHostBridge through the boot channel", () => {
  it("delivers placed, the palette command and overlay queries from the verified shell", async () => {
    await fromShell({ type: "hello" });
    await flush();
    expect(sent()).toContainEqual({ source: "paperclip-ui", v: 1, type: "ready", mode: "fused" });
    const { registerThreadkeeperSlot } = await import("./threadkeeper-host-slot");
    const slot = document.createElement("div");
    document.getElementById("root")!.append(slot);
    const release = registerThreadkeeperSlot("threads", slot);

    await fromShell({ type: "placed", view: "threads" });
    expect(document.documentElement.getAttribute("data-threadkeeper-slot")).toBe("threads");

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
    const { registerThreadkeeperSlot } = await import("./threadkeeper-host-slot");
    const slot = document.createElement("div");
    document.getElementById("root")!.append(slot);
    const release = registerThreadkeeperSlot("threads", slot);
    const keys: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent) => keys.push(event);
    document.addEventListener("keydown", listener);
    const refuse = async (from = origin, source = parent) => {
      await fromShell({ type: "placed", view: "threads" }, from, source);
      // placed has no reply: inspect its actual effect on a registered slot (N-4).
      expect(document.documentElement.hasAttribute("data-threadkeeper-slot")).toBe(false);
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
      expect(document.documentElement.getAttribute("data-threadkeeper-slot")).toBe("threads");
      await fromShell({ type: "command", name: "palette" });
      expect(keys.map((event) => [event.key, event.metaKey])).toEqual([["k", true]]);
    } finally {
      document.removeEventListener("keydown", listener);
      release();
    }
  });
});
