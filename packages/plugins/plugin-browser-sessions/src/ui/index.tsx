import { useEffect, useRef, useState, type ReactNode } from "react";
import { useHostLocation, useHostNavigation, usePluginAction, usePluginData, usePluginStream, type PluginCompanySettingsPageProps, type PluginDetailTabProps, type PluginPageProps, type PluginSidebarProps, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { SUPPORTED_PROVIDERS, type ActionPolicy, type ActionRecord, type SessionLink, type SessionRow } from "../contracts.js";

const button = "inline-flex items-center justify-center rounded-md border border-border bg-background px-3 py-2 text-sm font-medium text-foreground hover:bg-accent disabled:opacity-50";
const input = "w-full rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground";
type Status = { connected: boolean; shared: boolean; lastSeenAt: string | null; browser: string; sessionCount: number; warning: string | null; versionMismatch: boolean; policy: ActionPolicy; effectivePolicy: ActionPolicy; message?: string };
type Settings = Status & { paired?: boolean; trustedAgentIds: string[]; eventsEnabled: boolean; agents: { id: string; name: string; status: string }[]; credentials: { linkedKeys: string[]; allowSecretTransfer: boolean }; actions: ActionRecord[] };
function errorText(error: unknown) { return error && typeof error === "object" && "message" in error ? String(error.message) : String(error); }
function Empty({ children }: { children: ReactNode }) { return <p className="py-4 text-sm text-muted-foreground">{children}</p>; }
function useSessionData<T>(key: string, params: Record<string, unknown>) {
  const result = usePluginData<T>(key, params);
  const stream = usePluginStream(`sessions:${params.companyId ?? ""}`);
  useEffect(() => { if (stream.lastEvent) void result.refresh(); }, [stream.lastEvent]);
  return result;
}
const PROVIDER_LABELS: Record<string, string> = { claude: "Claude", claude_code: "Claude Code", chatgpt: "ChatGPT", codex: "Codex", gemini: "Gemini" };
const label = (provider: string) => PROVIDER_LABELS[provider] ?? provider;
/** "1 hour ago", "5 minutes ago": the relative time the contracts show after `Last seen`. */
export function relativeTime(iso: string, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  const [count, unit] = seconds < 3600 ? [Math.floor(seconds / 60), "minute"] : seconds < 86_400 ? [Math.floor(seconds / 3600), "hour"] : [Math.floor(seconds / 86_400), "day"];
  return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
}
function statusLabel(data: Status) { return data.versionMismatch ? "Version mismatch" : data.connected ? `Connected to Threadkeeper${data.browser ? ` in ${data.browser}` : ""}` : "Not connected"; }
function StateLabel({ row }: { row: SessionRow }) { return <span>{row.observed ? ({ running: "Running", idle: "Idle", signed_out: "Signed out", turn_complete: "Finished", waiting_answer: "Needs your answer", waiting_permission: "Needs approval", needs_user_answer: "Needs your answer", needs_answer: "Needs your answer", needs_approval: "Needs approval", failed: "Failed" } as Record<string, string>)[String(row.agentState)] ?? "Unknown" : "Not observed"}{!row.observed && row.agentStateAt ? ` · Last seen ${relativeTime(row.agentStateAt)}` : ""}</span>; }

function PairingForm({ companyId, refresh }: { companyId: string; refresh: () => void }) {
  const confirm = usePluginAction("pair-confirm");
  const [code, setCode] = useState("");
  const [shareAfterPair, setShareAfterPair] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  async function submit() {
    setFailure(null);
    setPending(true);
    try {
      await confirm({ companyId, code, shared: shareAfterPair });
      setCode("");
    } catch (error) {
      setFailure(errorText(error));
    } finally {
      setPending(false);
      refresh();
    }
  }
  return <form className="space-y-3 rounded-lg border border-border p-4" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <label className="block space-y-2"><span className="text-sm font-medium">Confirm pairing code</span><input className={input} value={code} onChange={e => { setCode(e.target.value.toUpperCase()); setFailure(null); }} maxLength={8} autoComplete="off" placeholder="8-character code" /></label>
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={shareAfterPair} onChange={e => setShareAfterPair(e.target.checked)} />Share sessions with this company after pairing</label>
    <div className="flex justify-end border-t border-border pt-3"><button className={button} disabled={pending || code.length !== 8}>Confirm code</button></div>
  </form>;
}

export function SettingsPage({ context }: PluginCompanySettingsPageProps) {
  const { data, loading, error, refresh } = useSessionData<Settings>("settings", { companyId: context.companyId });
  const share = usePluginAction("sharing"); const disconnect = usePluginAction("disconnect"); const policy = usePluginAction("policy-save");
  const [failure, setFailure] = useState<string | null>(null); const [pending, setPending] = useState(false);
  const navigation = useHostNavigation();
  async function act(fn: () => Promise<unknown>) { setPending(true); setFailure(null); try { await fn(); await refresh(); } catch (error) { setFailure(errorText(error)); } finally { setPending(false); } }
  if (!context.companyId) return <Empty>Select a company to configure browser sessions.</Empty>;
  if (loading && !data) return <Empty>Loading browser session settings…</Empty>;
  if (error) return <p role="alert">{error.message}</p>;
  if (!data) return null;
  const paired = data.paired ?? (data.connected || !!data.lastSeenAt || data.versionMismatch);
  const savePolicy = (next: ActionPolicy) => act(() => policy({ companyId: context.companyId, policy: next }));
  return <section className="space-y-6" aria-label="Browser sessions settings">
    <div className="space-y-2"><h2 className="text-lg font-semibold">Browser sessions</h2><p role="status" className="text-sm">{statusLabel(data)}</p>{!data.connected && data.lastSeenAt && <p className="text-sm text-muted-foreground">Last seen {relativeTime(data.lastSeenAt)}</p>}{data.warning && <p className="text-sm text-muted-foreground">{data.warning}</p>}<button className={button} onClick={() => void refresh()}>Refresh status</button></div>
    {failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}
    {!paired && <PairingForm key={context.companyId} companyId={context.companyId} refresh={refresh} />}
    <div className="space-y-3"><h3 className="font-medium">Sharing</h3><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={data.shared} disabled={pending || !data.lastSeenAt} onChange={(e) => void act(() => share({ companyId: context.companyId, shared: e.target.checked }))} />Share sessions with this company</label><p className="text-sm text-muted-foreground">{data.shared ? `${data.sessionCount} sessions shared` : "No company can see your sessions yet. Choose one to share with."}</p><button className={button} disabled={pending} onClick={() => void act(() => disconnect({ companyId: context.companyId }))}>Disconnect</button></div>
    <div className="space-y-3 border-t border-border pt-4"><h3 className="font-medium">Agent actions</h3><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={data.policy.enabled} disabled={pending} onChange={(e) => void savePolicy({ ...data.policy, enabled: e.target.checked })} />Allow trusted agents to act in my browser</label><p className="text-sm text-muted-foreground">Agents will send messages and start sessions as you. Providers may forbid automated use of personal accounts.</p><p className="text-sm text-muted-foreground">Enable the same providers in Threadkeeper. Both sides must allow each action.</p><div className="flex flex-wrap gap-4">{SUPPORTED_PROVIDERS.map((provider) => <label key={provider} className="flex items-center gap-2 text-sm"><input type="checkbox" checked={data.policy.providers.includes(provider)} disabled={pending} onChange={(e) => void savePolicy({ ...data.policy, providers: e.target.checked ? [...data.policy.providers, provider] : data.policy.providers.filter((p) => p !== provider) })} />{label(provider)}</label>)}<label className="flex items-center gap-2 text-sm text-muted-foreground opacity-50"><input type="checkbox" checked={false} disabled />{label("gemini")} · Not supported yet</label></div><p className="text-sm text-muted-foreground">10 messages and 3 new sessions per agent per hour.</p></div>
    <fieldset className="space-y-3"><legend className="font-medium">Trusted agents</legend>{!data.agents.length && <Empty>No agents in this company.</Empty>}{data.agents.map((agent) => <div key={agent.id} className="flex items-center gap-3 text-sm"><span>{agent.name} · {agent.status}</span><label className="flex items-center gap-2"><input type="checkbox" checked={data.trustedAgentIds.includes(agent.id)} disabled={pending} onChange={(e) => void act(() => policy({ companyId: context.companyId, trustedAgentIds: e.target.checked ? [...data.trustedAgentIds, agent.id] : data.trustedAgentIds.filter((id) => id !== agent.id) }))} />Trusted</label></div>)}</fieldset>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={data.eventsEnabled} disabled={pending} onChange={(e) => void act(() => policy({ companyId: context.companyId, eventsEnabled: e.target.checked }))} />Session changes update tasks and wake agents</label>
    <div className="space-y-3 border-t border-border pt-4"><h3 className="font-medium">Model keys</h3><p className="text-sm text-muted-foreground">Read keys from the selected company. Choose references and review their availability in the model key controls below. Secret values reach only the paired extension after you enable transfer.</p><p className="text-sm">Secret transfer: {data.credentials.allowSecretTransfer ? "Enabled" : "Off"}</p><a className="text-sm underline" {...navigation.linkProps("/company/settings/instance/plugins/browser-sessions")}>Manage model keys</a></div>
    <RecentActions actions={data.actions} />
  </section>;
}
function RecentActions({ actions }: { actions: ActionRecord[] }) {
  return <section className="space-y-3 border-t border-border pt-4"><h3 className="font-medium">Recent actions</h3>{!actions.length && <Empty>No agent has acted yet.</Empty>}<ul className="space-y-2">{actions.map((action) => <li key={action.id} className="rounded-md border border-border p-3 text-sm"><details><summary className="cursor-pointer">{new Date(action.createdAt).toLocaleString()} · {action.agentName ?? action.agentId} · {action.status}</summary><dl className="my-2 space-y-1"><div>Action: {action.tool === "session_send" ? "Send a message" : "Start a session"}</div><div>Task: {action.issueId ?? "None"}</div><div>Provider: {label(action.provider)}</div><div>Account: {action.accountLabel || "Default"}</div><div>Session: {action.sessionTitle ?? (action.tool === "session_start" ? "New session" : action.threadKey ?? "Unknown")}</div></dl><pre className="whitespace-pre-wrap break-words text-sm">{action.text}</pre></details></li>)}</ul></section>;
}

export function TaskSessionsTab({ context }: PluginDetailTabProps) {
  const { data, loading, error, refresh } = useSessionData<Status & { sessions: { link: SessionLink; session: SessionRow | null }[] }>("task-sessions", { companyId: context.companyId, issueId: context.entityId });
  const unlink = usePluginAction("unlink"); const open = usePluginAction("open"); const link = usePluginAction("link"); const search = usePluginAction("search-post");
  const [query, setQuery] = useState(""); const [matches, setMatches] = useState<SessionRow[]>([]); const [failure, setFailure] = useState<string | null>(null); const [pending, setPending] = useState(false);
  async function act(fn: () => Promise<unknown>) { setPending(true); setFailure(null); try { await fn(); await refresh(); } catch (e) { setFailure(errorText(e)); } finally { setPending(false); } }
  if (loading && !data) return <Empty>Loading linked sessions…</Empty>;
  if (error) return <p role="alert">{error.message}</p>;
  if (!data) return null;
  if (!data.shared) return <Empty>{data.message ?? "Sessions are not shared with this company."}</Empty>;
  return <section className="space-y-4" aria-label="Task sessions">{failure && <p role="alert" className="text-sm text-destructive">{failure}</p>}{!data.connected && <p className="text-sm text-muted-foreground">Browser is not connected. Showing last known observations.</p>}<ul className="space-y-2">{data.sessions.map(({ link: entry, session }) => <li key={entry.id} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border p-3"><div className="min-w-0 space-y-1"><p className="break-words text-sm font-medium">{session?.title ?? "Session no longer available"}</p>{session && <p className="text-xs text-muted-foreground">{session.providerLabel ?? session.provider} · {session.accountLabel || "Default account"} · <StateLabel row={session} /></p>}<p className="text-xs text-muted-foreground">Linked by {entry.origin === "user" ? "the board" : entry.origin}</p></div><div className="flex flex-wrap items-center gap-2">{session && !data.connected && <span className="text-xs text-muted-foreground">Open the browser to use this.</span>}{session && <button className={button} disabled={pending || !data.connected} title={!data.connected ? "Open the browser to use this." : undefined} onClick={() => void act(() => open({ companyId: context.companyId, threadKey: entry.threadKey }))}>Open</button>}<button className={button} disabled={pending} onClick={() => void act(() => unlink({ companyId: context.companyId, issueId: context.entityId, threadKey: entry.threadKey }))}>Unlink</button></div></li>)}</ul>{!data.sessions.length && <Empty>No sessions linked to this task.</Empty>}
    <form className="space-y-2 border-t border-border pt-4" onSubmit={(e) => { e.preventDefault(); void act(async () => { const result = await search({ companyId: context.companyId, query, limit: 20, quality: "fast" }) as { sessions: SessionRow[] }; setMatches(result.sessions); }); }}><label className="block text-sm font-medium" htmlFor="session-link-query">Link a session</label><div className="flex gap-2"><input id="session-link-query" className={input} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search shared sessions" maxLength={2000} /><button className={button} disabled={pending || !data.connected || !query.trim()}>Search</button></div></form>
    <ul className="space-y-2">{matches.map((row) => <li key={row.threadKey} className="flex items-center justify-between gap-3 text-sm"><span className="break-words">{row.title}</span><button className={button} disabled={pending} onClick={() => void act(() => link({ companyId: context.companyId, issueId: context.entityId, threadKey: row.threadKey }))}>Link</button></li>)}</ul>
  </section>;
}
export function SessionsNeedingYou({ context }: PluginWidgetProps) {
  const { data, loading, error } = useSessionData<Status & { sessions: (SessionRow & { linkedTasks?: { issueId: string; identifier: string | null; title: string | null }[] })[]; total: number }>("attention", { companyId: context.companyId });
  const navigation = useHostNavigation(); const open = usePluginAction("open"); const [failure, setFailure] = useState<string | null>(null);
  if (data && !data.shared) return <section aria-label="Sessions needing you"><h3 className="font-medium">Sessions needing you</h3><Empty>{data.message ?? "Sessions are not shared with this company."}</Empty></section>;
  return <section className="space-y-3" aria-label="Sessions needing you"><h3 className="font-medium">Sessions needing you</h3>{loading && !data ? <Empty>Loading…</Empty> : error ? <p role="status" className="text-sm text-muted-foreground">{error.message}</p> : data && !data.sessions.length ? <Empty>Nothing needs you.</Empty> : <ul className="space-y-2">{data?.sessions.map((row) => <li key={row.threadKey}><button className="w-full text-left text-sm hover:underline disabled:opacity-50" disabled={!data.connected} onClick={() => void open({ companyId: context.companyId, threadKey: row.threadKey }).catch((e) => setFailure(errorText(e)))}>{row.title} · {row.providerLabel ?? label(row.provider)} · <StateLabel row={row} />{row.linkedTasks?.length ? ` · ${row.linkedTasks.map((task) => task.identifier ?? task.title ?? task.issueId).join(", ")}` : ""}</button></li>)}</ul>}{failure && <p role="alert">{failure}</p>}{data && data.total > 0 && <a className="text-sm underline" {...navigation.linkProps("/threads")}>{data.total > 10 ? `View all (${data.total})` : "View all"}</a>}</section>;
}
export function SessionSidebar({ context }: PluginSidebarProps) {
  const navigation = useHostNavigation(); if (!context.companyId) return null;
  return <nav aria-label="Threadkeeper" className="space-y-1">{[["Browse", "/browse"], ["Threads", "/threads"], ["Session board", "/session-board"]].map(([label, to]) => <a key={to} className="block rounded-md px-3 py-2 text-sm text-sidebar-foreground hover:bg-sidebar-accent" {...navigation.linkProps(to!)}>{label}</a>)}</nav>;
}
function ExtensionView({ context, view, title }: PluginPageProps & { view: "browse" | "threads" | "dashboard"; title: string }) {
  const open = usePluginAction("view-open"); const [embedded, setEmbedded] = useState(false); const [failure, setFailure] = useState<string | null>(null);
  const openSession = usePluginAction("open"); const location = useHostLocation(); const opened = useRef<string | null>(null);
  useEffect(() => { const query = new URLSearchParams(location.search); const key = query.get("threadKey"); if (view === "threads" && query.get("open") === "1" && key && opened.current !== key) { opened.current = key; void openSession({ companyId: context.companyId, threadKey: key }).catch((error) => setFailure(errorText(error))); } }, [view, location.search, context.companyId]);
  useEffect(() => { const connected = document.documentElement.hasAttribute("data-threadkeeper-host"); setEmbedded(connected); if (connected) window.dispatchEvent(new CustomEvent("paperclip:threadkeeper-open-view", { detail: { view } })); }, [view]);
  return <section className="space-y-4 p-4"><h1 className="text-lg font-semibold">{embedded ? title : "Open this in Threadkeeper"}</h1><p className="text-sm text-muted-foreground">{embedded ? `${title} opens in the Threadkeeper window.` : "Browse, Threads and the session board run inside the Threadkeeper window."}</p><button className={button} onClick={() => { if (embedded) window.dispatchEvent(new CustomEvent("paperclip:threadkeeper-open-view", { detail: { view } })); else void open({ companyId: context.companyId, view }).catch((e) => setFailure(errorText(e))); }}>Open Threadkeeper</button>{failure && <p role="alert">{failure}</p>}{view === "dashboard" && <SessionsNeedingYou context={context} />}</section>;
}
export function BrowsePage(props: PluginPageProps) { return <ExtensionView {...props} view="browse" title="Browse" />; }
export function ThreadsPage(props: PluginPageProps) { return <ExtensionView {...props} view="threads" title="Threads" />; }
export function BoardPage(props: PluginPageProps) { return <ExtensionView {...props} view="dashboard" title="Session board" />; }
