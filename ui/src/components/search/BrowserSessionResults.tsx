import { useState } from "react";
import { Button } from "../ui/button";
import { useBrowserSessionSearch } from "../../hooks/useBrowserSessionSearch";
import { relativeTime } from "../../lib/utils";
import { applyCompanyPrefix, extractCompanyPrefixFromPath } from "../../lib/company-routes";

export function BrowserSessionResults({ companyId, query, quality = "fast", requestKey = 0 }: {
  companyId: string | null;
  query: string;
  quality?: "fast" | "best";
  requestKey?: number;
}) {
  const [retry, setRetry] = useState(0);
  const search = useBrowserSessionSearch({ companyId, query, quality, requestKey: requestKey + retry });
  const sharingHref = applyCompanyPrefix("/company/settings/browser-sessions", extractCompanyPrefixFromPath(window.location.pathname));
  if (search.state === "idle" || search.state === "disabled") return null;
  return (
    <section aria-label="Sessions" className="border-t border-border px-4 py-4 sm:px-6" data-testid="browser-session-results">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Sessions</h2>
        {search.localOnly ? <span className="text-xs text-muted-foreground">Local results only</span> : null}
      </div>
      <div aria-live="polite" className="mt-2 text-sm text-muted-foreground">
        {search.state === "loading" ? "Searching sessions…" : null}
        {search.state === "offline" ? "Sessions can be searched while ThreadStack is running." : null}
        {search.state === "unshared" ? <p>Sessions are not shared with this company. <a className="underline" href={sharingHref}>Share sessions</a></p> : null}
        {search.state === "error" ? <p>Session search did not answer. Try again. <Button variant="ghost" size="sm" onClick={() => setRetry((value) => value + 1)}>Retry</Button></p> : null}
        {search.state === "ready" && search.rows.length === 0 ? "No sessions match." : null}
        {search.openError ? <p role="alert">{search.openError}</p> : null}
      </div>
      {search.rows.length > 0 ? (
        <ul className="mt-2 flex flex-col gap-1">
          {search.rows.map((row) => (
            <li key={row.threadKey}>
              <button type="button" data-session-key={row.threadKey} disabled={search.opening !== null} onClick={() => { void search.open(row.threadKey); }} className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-ring">
                <span className="truncate text-sm font-medium">{row.title}</span>
                <span className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{row.providerLabel || row.provider}</span>
                  {row.accountLabel ? <span>{row.accountLabel}</span> : null}
                  {row.agentState ? <span>{row.agentState.replaceAll("_", " ")}</span> : null}
                  {row.updatedAt && Number.isFinite(Date.parse(row.updatedAt)) ? <time dateTime={row.updatedAt}>{relativeTime(row.updatedAt)}</time> : null}
                </span>
                {row.excerpt?.text ? <span className="truncate text-xs text-muted-foreground">{row.excerpt.text}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {search.nextCursor ? <Button className="mt-2" variant="ghost" size="sm" disabled={search.loadingMore} onClick={() => { void search.loadMore(); }}>{search.loadingMore ? "Searching sessions…" : "Show more"}</Button> : null}
    </section>
  );
}
