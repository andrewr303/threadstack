import { MessageSquare } from "lucide-react";
import { CommandGroup, CommandItem, CommandSeparator } from "../ui/command";
import type { useBrowserSessionSearch } from "../../hooks/useBrowserSessionSearch";

export function BrowserSessionPaletteGroup({ search, query, onOpened }: {
  search: ReturnType<typeof useBrowserSessionSearch>;
  query: string;
  onOpened: () => void;
}) {
  if (search.state !== "ready" || search.rows.length === 0) return null;
  return <>
    <CommandSeparator />
    <CommandGroup heading="Sessions">
      {search.rows.slice(0, 5).map((row) => (
        <CommandItem key={row.threadKey} data-testid="command-session-result" value={`${query} ${row.title} ${row.threadKey}`} disabled={search.opening !== null} onSelect={() => { void search.open(row.threadKey).then((opened) => { if (opened) onOpened(); }); }}>
          <MessageSquare className="mr-2 h-4 w-4" />
          <span className="flex-1 truncate">{row.title}</span>
          <span className="ml-2 text-xs text-muted-foreground">{row.providerLabel || row.provider}</span>
        </CommandItem>
      ))}
      {search.openError ? <p role="alert" className="px-2 py-2 text-sm text-muted-foreground">{search.openError}</p> : null}
    </CommandGroup>
  </>;
}
