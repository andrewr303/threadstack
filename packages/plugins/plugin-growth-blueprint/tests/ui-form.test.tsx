// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createJob } from "../src/contracts.js";

// The host bridge is not available in tests; the start action is a mock each test controls.
const start = vi.hoisted(() => vi.fn());
vi.mock("@paperclipai/plugin-sdk/ui", () => ({
  useHostNavigation: () => ({ linkProps: (href: string) => ({ href }) }),
  usePluginAction: () => start,
  usePluginData: () => ({ data: null, loading: false, error: null, refresh: () => undefined }),
  usePluginStream: () => ({ lastEvent: null }),
}));

const { GrowthPage, dedupedNotice } = await import("../src/ui/index.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  start.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<GrowthPage context={{ companyId: "c1" } as never} />);
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = container.querySelector<T>(selector);
  if (!element) throw new Error(`No element for ${selector}`);
  return element;
};

function type(input: HTMLInputElement, value: string) {
  act(() => {
    // React tracks the value through the native setter, so a plain assignment is not seen.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function click(element: HTMLElement) {
  act(() => { element.click(); });
}

async function submit() {
  await act(async () => {
    $<HTMLFormElement>("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

const site = () => $<HTMLInputElement>("#growth-site");
const cap = () => $<HTMLInputElement>("#growth-cap");
const describedBy = (element: HTMLElement) => (element.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);

function startWithInvalidCap() {
  click($("#growth-mode-quick"));
  type(site(), "example.com");
  type(cap(), "abc");
}

describe("start form errors", () => {
  it("an invalid cap marks the cap input, describes it with the cap error and moves focus to it", async () => {
    startWithInvalidCap();
    await submit();
    expect(start).not.toHaveBeenCalled();
    const error = $("#growth-cap-error");
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toMatch(/data cap above \$0/);
    expect(cap().getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(cap())).toEqual(["growth-cap-help", "growth-cap-error"]);
    expect(site().getAttribute("aria-invalid")).toBeNull();
    expect(describedBy(site())).toEqual(["growth-site-help"]);
    expect(document.activeElement).toBe(cap());
  });

  it("editing the cap clears its error and never moves it to the Website field", async () => {
    startWithInvalidCap();
    await submit();
    type(cap(), "abcd");
    expect(container.querySelector("[role=alert]")).toBeNull();
    expect(cap().getAttribute("aria-invalid")).toBeNull();
    expect(site().getAttribute("aria-invalid")).toBeNull();
    expect(describedBy(site())).toEqual(["growth-site-help"]);
    expect(describedBy(cap())).toEqual(["growth-cap-help"]);
  });

  it("an invalid website marks the Website field and moves focus to it; editing the cap leaves that error alone", async () => {
    click($("#growth-mode-quick"));
    type(site(), "not a site");
    await submit();
    expect(site().getAttribute("aria-invalid")).toBe("true");
    expect(describedBy(site())).toEqual(["growth-site-help", "growth-site-error"]);
    expect(cap().getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(site());
    type(cap(), "2");
    expect(site().getAttribute("aria-invalid")).toBe("true");
    type(site(), "not a site.");
    expect(site().getAttribute("aria-invalid")).toBeNull();
  });

  it("a cap rejected by the worker marks the cap input, not the Website field", async () => {
    start.mockResolvedValue({ ok: false, reason: "invalid_cap", message: "Enter a data cap above $0 and up to $10.00." });
    click($("#growth-mode-quick"));
    type(site(), "example.com");
    type(cap(), "5");
    await submit();
    expect(cap().getAttribute("aria-invalid")).toBe("true");
    expect(site().getAttribute("aria-invalid")).toBeNull();
    expect(document.activeElement).toBe(cap());
  });

  it("an error that belongs to no input (paused agent) marks neither input", async () => {
    start.mockResolvedValue({ ok: false, reason: "agent_paused", message: "Growth is paused. Resume the Growth agent, then start again.", agentId: "a1" });
    type(site(), "example.com");
    await submit();
    expect($("#growth-form-error").textContent).toContain("Growth is paused");
    expect(site().getAttribute("aria-invalid")).toBeNull();
    expect(describedBy(site())).toEqual(["growth-site-help"]);
  });

  it("a valid submit sends the typed cap", async () => {
    start.mockResolvedValue({ ok: true, deduped: false, issueId: "i1", identifier: "GRO-1", job: null });
    click($("#growth-mode-quick"));
    type(site(), "example.com");
    type(cap(), "2.5");
    await submit();
    expect(start).toHaveBeenCalledWith({ companyId: "c1", site: "example.com", mode: "quick", capUsd: 2.5 });
    expect(container.querySelector("[role=alert]")).toBeNull();
  });

  it("a deduped start says when the existing task has a different data cap", async () => {
    const existing = createJob({ jobId: "gb-1", companyId: "c1", issueId: "i1", agentId: "a1", site: "q.com", now: new Date().toISOString(), mode: "quick", capUsd: 5 });
    start.mockResolvedValue({ ok: true, deduped: true, issueId: "i1", identifier: "GRO-1", job: existing });
    click($("#growth-mode-quick"));
    type(site(), "q.com");
    type(cap(), "9");
    await submit();
    const status = $("[role=status]").textContent ?? "";
    expect(status).toContain("started in the last 30 minutes");
    expect(status).toContain("That task's data cap is $5.00; your $9.00 cap was not applied.");
  });
});

describe("dedupedNotice", () => {
  it("stays plain when the caps match, the cap is unknown, or the mode is free", () => {
    const base = { site: "q.com", requestedCapUsd: 5 };
    expect(dedupedNotice({ ...base, mode: "quick", existingCapUsd: 5 })).not.toContain("not applied");
    expect(dedupedNotice({ ...base, mode: "quick" })).not.toContain("not applied");
    expect(dedupedNotice({ ...base, mode: "free", existingCapUsd: 0 })).not.toContain("not applied");
  });
});
