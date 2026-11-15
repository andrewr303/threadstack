import { afterEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "./client";
import { browserSessionsApi, browserSessionError } from "./browser-sessions";

vi.mock("./client", async () => {
  const actual = await vi.importActual<typeof import("./api-error")>("./api-error");
  return { ...actual, api: { get: vi.fn(), post: vi.fn() } };
});
afterEach(() => vi.clearAllMocks());

describe("browser session board client", () => {
  it("uses the company-scoped GET contract and excludes duplicated Paperclip threads", async () => {
    vi.mocked(api.get).mockResolvedValue({ sessions: [{ threadKey: "chat:1", provider: "claude", title: "Retry" }, { threadKey: "paperclip:1", provider: "paperclip", title: "Task" }], nextCursor: "next", degraded: true });
    const signal = new AbortController().signal;
    const data = await browserSessionsApi.search("company-a", "webhook retries", "best", { limit: 8, cursor: "page:2", signal });
    expect(api.get).toHaveBeenCalledWith("/plugins/browser-sessions/api/search?companyId=company-a&q=webhook+retries&quality=best&limit=8&cursor=page%3A2", { signal, timeoutMs: 25_000, cache: "no-store", fresh: true });
    expect(data.sessions.map((row) => row.threadKey)).toEqual(["chat:1"]);
    expect(data.degraded).toBe(true);
  });

  it("revalidates a selected session through the bridge instead of opening a cached URL", async () => {
    vi.mocked(api.post).mockResolvedValue({ opened: true });
    await browserSessionsApi.open("company-a", "claude:account:workspace:thread:main");
    expect(api.post).toHaveBeenCalledWith("/plugins/browser-sessions/api/sessions/open", { companyId: "company-a", threadKey: "claude:account:workspace:thread:main" }, { signal: undefined });
  });

  it("maps typed bridge errors and missing plugins to honest UI states", () => {
    expect(browserSessionError(new ApiError("offline", 503, { error: { code: "browser_offline" } }))).toBe("offline");
    expect(browserSessionError(new ApiError("denied", 403, { error: { code: "denied" } }))).toBe("unshared");
    expect(browserSessionError(new ApiError("missing", 404, {}))).toBe("disabled");
    expect(browserSessionError(new ApiError("timeout", 504, {}))).toBe("error");
  });
});
