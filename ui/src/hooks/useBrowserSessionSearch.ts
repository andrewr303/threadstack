import { useCallback, useEffect, useRef, useState } from "react";
import { browserSessionError, browserSessionsApi, type BrowserSessionRow, type BrowserSessionSearchState } from "../api/browser-sessions";

interface SearchOptions {
  companyId: string | null;
  query: string;
  quality?: "fast" | "best";
  enabled?: boolean;
  limit?: number;
  requestKey?: number;
}
interface SearchSnapshot {
  key?: string;
  state: BrowserSessionSearchState;
  rows: BrowserSessionRow[];
  nextCursor: string | null;
  localOnly: boolean;
}
const EMPTY: SearchSnapshot = { state: "idle", rows: [], nextCursor: null, localOnly: false };

/** Independent request ownership prevents a browser search from delaying native results. */
export function useBrowserSessionSearch({ companyId, query, quality = "fast", enabled = true, limit = 8, requestKey = 0 }: SearchOptions) {
  const q = query.trim();
  const key = JSON.stringify([companyId, q, quality, enabled, limit, requestKey]);
  const [snapshot, setSnapshot] = useState<SearchSnapshot>(EMPTY);
  const [loadingMore, setLoadingMore] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [opening, setOpening] = useState<string | null>(null);
  const generation = useRef(0);
  const pageController = useRef<AbortController | null>(null);
  const openController = useRef<AbortController | null>(null);

  useEffect(() => {
    const current = ++generation.current;
    pageController.current?.abort();
    openController.current?.abort();
    setOpenError(null); setOpening(null); setLoadingMore(false);
    if (!enabled || !companyId || q.length < 2) { setSnapshot({ ...EMPTY, key }); return; }
    if (q.length > 2000) { setSnapshot({ ...EMPTY, key, state: "error" }); return; }
    const controller = new AbortController();
    pageController.current = controller;
    setSnapshot({ ...EMPTY, key, state: "loading" });
    const timer = setTimeout(() => {
      void browserSessionsApi.search(companyId, q, quality, { signal: controller.signal, limit }).then(
        (result) => {
          if (generation.current !== current || controller.signal.aborted) return;
          setSnapshot({ key, state: "ready", rows: result.sessions, nextCursor: result.nextCursor, localOnly: Boolean(result.degraded) });
        },
        (error: unknown) => {
          if (generation.current !== current || controller.signal.aborted) return;
          setSnapshot({ ...EMPTY, key, state: browserSessionError(error) });
        },
      );
    }, quality === "best" ? 0 : 250);
    return () => { clearTimeout(timer); controller.abort(); pageController.current?.abort(); openController.current?.abort(); };
  }, [companyId, q, quality, enabled, limit, requestKey, key]);

  const loadMore = useCallback(async () => {
    if (!companyId || !snapshot.nextCursor || loadingMore) return;
    const current = generation.current;
    const controller = new AbortController();
    pageController.current = controller;
    setLoadingMore(true);
    try {
      const result = await browserSessionsApi.search(companyId, q, quality, { signal: controller.signal, limit, cursor: snapshot.nextCursor });
      if (generation.current !== current || controller.signal.aborted) return;
      setSnapshot((previous) => {
        const seen = new Set(previous.rows.map((row) => row.threadKey));
        return { key: previous.key, state: "ready", rows: [...previous.rows, ...result.sessions.filter((row) => !seen.has(row.threadKey))], nextCursor: result.nextCursor, localOnly: previous.localOnly || Boolean(result.degraded) };
      });
    } catch (error) {
      if (generation.current === current && !controller.signal.aborted) setSnapshot((previous) => ({ ...previous, state: browserSessionError(error) }));
    } finally { if (generation.current === current) setLoadingMore(false); }
  }, [companyId, q, quality, limit, snapshot.nextCursor, loadingMore]);

  const open = useCallback(async (threadKey: string) => {
    if (!companyId || opening) return false;
    const current = generation.current;
    const controller = new AbortController();
    openController.current?.abort(); openController.current = controller;
    setOpening(threadKey); setOpenError(null);
    try {
      await browserSessionsApi.open(companyId, threadKey, controller.signal);
      return generation.current === current && !controller.signal.aborted;
    } catch (error) {
      if (generation.current !== current || controller.signal.aborted) return false;
      const status = (error as { status?: number } | undefined)?.status;
      setOpenError(status === 403 || status === 404 ? "This session is no longer available." : "The session could not be opened. Try again.");
      return false;
    } finally { if (generation.current === current) setOpening(null); }
  }, [companyId, opening]);

  // The render preceding the effect also belongs to the new company/query.
  const visible = snapshot.key === key;
  return { ...(visible ? snapshot : EMPTY), loadingMore: visible && loadingMore, loadMore, open, opening: visible ? opening : null, openError: visible ? openError : null };
}
