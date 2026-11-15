// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadkeeperSlot } from "./ThreadkeeperSlot";
import { createThreadkeeperSlotReporter, currentThreadkeeperSlot, SLOT_ATTRIBUTE } from "@/lib/threadkeeper-host-slot";

const notice = "Threadkeeper is not responding. Reload the window.";
let root: Root | null;
let container: HTMLDivElement;
let reporter: ReturnType<typeof createThreadkeeperSlotReporter>;
const status = () => container.querySelector('[role="status"]');
const advance = async (ms: number) => { await act(async () => { vi.advanceTimersByTime(ms); }); };
const acknowledge = async (view: Parameters<typeof reporter.acknowledge>[0]) => {
  await act(async () => { reporter.acknowledge(view); });
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  reporter = createThreadkeeperSlotReporter({ doc: document, report: vi.fn() });
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  reporter.dispose();
  container.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function render(view: "threads" | "session-board" = "threads") {
  await act(async () => { root!.render(<ThreadkeeperSlot view={view} label="Threads" />); });
}

describe("ThreadkeeperSlot placement status", () => {
  it("registers the real slot and opens the matching fallback without making it transparent", async () => {
    const requested: unknown[] = [];
    const listener = (event: Event) => requested.push((event as CustomEvent).detail);
    window.addEventListener("paperclip:threadkeeper-open-view", listener);
    try {
      await render("session-board");
      expect(requested).toEqual([{ view: "dashboard" }]);
      expect(currentThreadkeeperSlot()).toEqual({ view: "session-board", element: container.firstElementChild });
      expect(document.documentElement.hasAttribute(SLOT_ATTRIBUTE)).toBe(false);
    } finally {
      window.removeEventListener("paperclip:threadkeeper-open-view", listener);
    }
  });

  it("shows the exact status only after two seconds without a placement", async () => {
    await render();
    await advance(1_999);
    expect(status()).toBeNull();
    await advance(1);
    expect(status()?.textContent).toBe(notice);
    expect(document.documentElement.hasAttribute(SLOT_ATTRIBUTE)).toBe(false);
  });

  it("cancels the deadline when the bridge acknowledges the matching view", async () => {
    await render();
    await advance(1_000);
    await acknowledge("threads");
    await advance(2_000);
    expect(status()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps waiting for its own view when a different view is acknowledged", async () => {
    await render();
    await advance(1_000);
    await acknowledge("browse");
    await advance(1_000);
    expect(status()?.textContent).toBe(notice);
    expect(document.documentElement.hasAttribute(SLOT_ATTRIBUTE)).toBe(false);
  });

  it("clears a late failure and starts a fresh deadline if placement is lost", async () => {
    await render();
    await advance(2_000);
    expect(status()?.textContent).toBe(notice);
    await acknowledge("threads");
    expect(status()).toBeNull();
    await acknowledge(null);
    await advance(1_999);
    expect(status()).toBeNull();
    await advance(1);
    expect(status()?.textContent).toBe(notice);
  });

  it("releases registration, its timer and observer when unmounted", async () => {
    await render();
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    await act(async () => root!.unmount());
    root = null;
    expect(currentThreadkeeperSlot()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(disconnect).toHaveBeenCalledTimes(1);
    await advance(2_000);
    expect(container.textContent).toBe("");
  });
});
