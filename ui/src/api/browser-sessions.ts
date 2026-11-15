import { api, ApiError } from "./client";

export interface BrowserSessionRow {
  threadKey: string;
  title: string;
  provider: string;
  providerLabel?: string;
  accountLabel?: string;
  agentState?: string | null;
  updatedAt?: string | null;
  excerpt?: { text: string; messageIndex?: number; role?: string } | null;
}

export interface BrowserSessionSearchResponse {
  sessions: BrowserSessionRow[];
  nextCursor: string | null;
  degraded?: boolean | string;
}

const BASE = "/plugins/browser-sessions/api";

export const browserSessionsApi = {
  async search(companyId: string, query: string, quality: "fast" | "best", options: { signal?: AbortSignal; limit?: number; cursor?: string | null } = {}): Promise<BrowserSessionSearchResponse> {
    const params = new URLSearchParams({ companyId, q: query, quality, limit: String(options.limit ?? 8) });
    if (options.cursor) params.set("cursor", options.cursor);
    const data = await api.get<BrowserSessionSearchResponse>(`${BASE}/search?${params}`, { signal: options.signal, timeoutMs: 25_000, cache: "no-store", fresh: true });
    return { ...data, sessions: data.sessions.filter((row) => row.provider !== "paperclip") };
  },
  open(companyId: string, threadKey: string, signal?: AbortSignal): Promise<{ opened: true }> {
    return api.post(`${BASE}/sessions/open`, { companyId, threadKey }, { signal });
  },
};

export type BrowserSessionSearchState = "idle" | "loading" | "ready" | "disabled" | "unshared" | "offline" | "error";

export function browserSessionError(error: unknown): "disabled" | "unshared" | "offline" | "error" {
  const apiError = error as ApiError | undefined;
  const body = apiError?.body as { error?: string | { code?: string } } | undefined;
  const code = typeof body?.error === "object" ? body.error.code : apiError?.code ?? body?.error;
  if (code === "browser_offline") return "offline";
  if (code === "denied" || code === "not_shared" || apiError?.status === 403) return "unshared";
  if (apiError?.status === 404) return "disabled";
  return "error";
}
