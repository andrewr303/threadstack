// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionResults } from "./BrowserSessionResults";
import { browserSessionsApi } from "../../api/browser-sessions";
import { ApiError } from "../../api/api-error";
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("../../api/browser-sessions", async () => {
  const actual = await vi.importActual<typeof import("../../api/browser-sessions")>("../../api/browser-sessions");
  return { ...actual, browserSessionsApi: { search: vi.fn(), open: vi.fn() } };
});
let root: Root;
let container: HTMLDivElement;
const row = { threadKey: "claude:1", title: "Webhook retries", provider: "claude", providerLabel: "Claude", accountLabel: "Work", agentState: "waiting_answer", updatedAt: "2026-11-13T01:00:00Z", excerpt: { text: "Retry Stripe webhook delivery" } };
beforeEach(() => {
  vi.useFakeTimers();
  vi.mocked(browserSessionsApi.search).mockResolvedValue({ sessions: [row], nextCursor: null });
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
});
afterEach(async () => { await act(() => root.unmount()); container.remove(); vi.useRealTimers(); vi.clearAllMocks(); });
async function render(query: string, quality: "fast" | "best" = "fast", companyId = "company-a") {
  await act(() => root.render(<BrowserSessionResults companyId={companyId} query={query} quality={quality} />));
}
async function pause(ms = 250) { await act(() => vi.advanceTimersByTimeAsync(ms)); }

describe("independent session search", () => {
  it("waits for two characters and a 250ms pause without issuing stale searches", async () => {
    await render("x"); await pause(); expect(browserSessionsApi.search).not.toHaveBeenCalled(); expect(container.textContent).toBe("");
    await render("web"); await pause(200); expect(browserSessionsApi.search).not.toHaveBeenCalled();
    await render("webhook"); await pause(250);
    expect(browserSessionsApi.search).toHaveBeenCalledTimes(1);
    expect(browserSessionsApi.search).toHaveBeenCalledWith("company-a", "webhook", "fast", expect.objectContaining({ limit: 8, signal: expect.any(AbortSignal) }));
    expect(container.textContent).toContain("Webhook retries"); expect(container.textContent).toContain("Claude"); expect(container.textContent).toContain("Work"); expect(container.textContent).toContain("Retry Stripe webhook delivery");
  });

  it("uses best immediately on submission and shows a local fallback", async () => {
    vi.mocked(browserSessionsApi.search).mockResolvedValue({ sessions: [row], nextCursor: null, degraded: true });
    await render("webhook", "best"); await pause(0);
    expect(browserSessionsApi.search).toHaveBeenCalledWith("company-a", "webhook", "best", expect.anything());
    expect(container.textContent).toContain("Local results only");
  });

  it("shows loading independently and discards a late response after company changes", async () => {
    let finish!: (value: { sessions: typeof row[]; nextCursor: null }) => void;
    vi.mocked(browserSessionsApi.search).mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    await render("webhook"); await pause(); expect(container.textContent).toContain("Searching sessions…");
    await render("webhook", "fast", "company-b"); await pause();
    await act(() => finish({ sessions: [{ ...row, title: "Old company private match" }], nextCursor: null }));
    expect(container.textContent).not.toContain("Old company private match");
    expect(container.textContent).toContain("Webhook retries");
  });

  it("shows offline, sharing and timeout copy and omits a disabled plugin", async () => {
    for (const [status, body, text] of [
      [503, { error: { code: "browser_offline" } }, "Sessions can be searched while ThreadStack is running."],
      [403, { error: { code: "denied" } }, "Sessions are not shared with this company."],
      [504, {}, "Session search did not answer. Try again."],
      [404, {}, ""],
    ] as const) {
      vi.mocked(browserSessionsApi.search).mockRejectedValueOnce(new ApiError("problem", status, body));
      await render(`query-${status}`); await pause();
      expect(container.textContent).toContain(text);
      if (status === 404) expect(container.textContent).toBe("");
    }
  });

  it("rechecks permission before opening and explains a now-private result", async () => {
    vi.mocked(browserSessionsApi.open).mockRejectedValueOnce(new ApiError("denied", 403, { error: { code: "denied" } }));
    await render("webhook"); await pause();
    await act(() => container.querySelector<HTMLButtonElement>('[data-session-key="claude:1"]')!.click());
    expect(browserSessionsApi.open).toHaveBeenCalledWith("company-a", "claude:1", expect.any(AbortSignal));
    expect(container.textContent).toContain("This session is no longer available.");
  });

  it("loads another eight-result page with the returned cursor and deduplicates rows", async () => {
    vi.mocked(browserSessionsApi.search).mockResolvedValueOnce({ sessions: [row], nextCursor: "second-page" });
    vi.mocked(browserSessionsApi.search).mockResolvedValueOnce({ sessions: [row, { ...row, threadKey: "claude:2", title: "More retries" }], nextCursor: null });
    await render("webhook"); await pause();
    const more = [...container.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Show more")!;
    await act(() => more.click());
    expect(browserSessionsApi.search).toHaveBeenLastCalledWith("company-a", "webhook", "fast", expect.objectContaining({ limit: 8, cursor: "second-page" }));
    expect(container.querySelectorAll("[data-session-key]")).toHaveLength(2);
    expect(container.textContent).not.toContain("Show more");
  });
});
