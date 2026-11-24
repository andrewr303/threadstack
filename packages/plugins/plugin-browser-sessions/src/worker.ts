import { readFileSync } from "node:fs";
import { definePlugin, runWorker, type PluginApiRequestInput, type PluginApiResponse, type PluginContext, type PluginPerformActionContext } from "@paperclipai/plugin-sdk";
import { SessionError, boundedInteger, record, requiredString, type BridgeResult } from "./contracts.js";
import { BrowserSessionsService } from "./service.js";
import { DatabaseStore, type Store } from "./store.js";
import { TOOLS } from "./manifest.js";

const CHANGE_EVENTS = ["issue.created", "issue.updated", "issue.comment.created", "issue.document.created", "issue.document.updated", "issue.document.deleted", "agent.run.started", "agent.run.finished", "agent.run.failed", "agent.run.cancelled"] as const;
function builtCommit() { try { return String((JSON.parse(readFileSync(new URL("./build-info.json", import.meta.url), "utf8")) as { commit: string }).commit); } catch { return "unknown"; } }
export function createBrowserSessionsPlugin(options: { store?: Store; commit?: string } = {}) {
  let service: BrowserSessionsService | undefined;
  const get = () => { if (!service) throw new SessionError("internal", "Browser sessions have not initialized."); return service; };
  async function boardAction(key: string, p: Record<string, unknown>, context: PluginPerformActionContext) {
    if (context.actor.type !== "user") throw new SessionError("denied", "Board access required.");
    if (!context.companyId || context.companyId !== p.companyId) throw new SessionError("denied", "Company scope mismatch.");
    return dispatch(get(), key, context.companyId, p, context.actor.userId ?? "board");
  }
  const plugin = definePlugin({
    multiCompanyConfig: true,
    async setup(ctx: PluginContext) {
      service = new BrowserSessionsService({ store: options.store ?? new DatabaseStore(ctx.db), host: ctx, commit: options.commit ?? builtCommit() });
      for (const tool of TOOLS) ctx.tools.register(tool.name, tool, (params, run) => get().executeTool(tool.name, params, run));
      for (const event of CHANGE_EVENTS) ctx.events.on(event, (payload) => get().domainEvent(payload));
      for (const key of ["status", "settings", "links", "task-sessions", "attention", "actions", "tasks", "credentials", "policy-get"]) ctx.data.register(key, (params) => dispatch(get(), key, requiredString(params.companyId, "companyId"), params, "board"));
      for (const key of ["pair-confirm", "sharing", "disconnect", "policy-save", "link", "unlink", "open", "view-open", "search-post"]) ctx.actions.register(key, (params, context) => boardAction(key, params, context));
    },
    async onConfigChanged() { /* Config is resolved afresh per company, never retained worker-wide. */ },
    async onHealth() { return { status: "ok", message: "Browser session bridge ready" }; },
    async onShutdown() { service?.close(); service = undefined; },
    async onIdleDrain() { return service?.hasPendingWork() ? "present" : "none"; },
    async onApiRequest(input: PluginApiRequestInput): Promise<PluginApiResponse> {
      try {
        if (input.actor.actorType !== "user") throw new SessionError("denied", "Board access required.");
        const p = input.method === "GET" ? input.query as Record<string, unknown> : record(input.body);
        // Header name kept from the Threadkeeper name for compatibility with paired extension builds.
        const companyId = input.companyId; const token = input.headers["x-threadkeeper-bridge-token"] ?? ""; const s = get();
        let body: unknown;
        switch (input.routeKey) {
          case "pair-start": body = await s.startPair(companyId, p); break;
          case "pair-poll": body = await s.pollPair(companyId, requiredString(p.pairId, "pairId"), requiredString(p.pollToken, "pollToken")); break;
          case "bridge-connect": body = await s.connect(companyId, token, p); break;
          case "bridge-poll": body = await s.poll(companyId, token, boundedInteger(p.waitMs, "waitMs", 0, 20_000, 20_000)); break;
          case "bridge-results": if (!Array.isArray(p.results)) throw new SessionError("bad_request", "results must be an array"); body = await s.results(companyId, token, p.results as BridgeResult[]); break;
          case "bridge-inventory": body = await s.inventory(companyId, token, p); break;
          case "bridge-offline": body = await s.offline(companyId, token); break;
          case "bridge-disconnect": body = await s.disconnect(companyId, input.actor.actorId, token); break;
          case "bridge-policy": body = await s.bridgePolicy(companyId, token, p.policy); break;
          case "bridge-share": await s.authenticate(companyId, token); body = await s.setShared(companyId, p.shared === true, input.actor.actorId); break;
          case "bridge-secret": body = await s.secret(companyId, token, requiredString(p.keyName, "keyName", 100)); break;
          // Board-only operations never run from an HTTP route, even if a stale manifest still declares one.
          case "pair-confirm": case "sharing": case "disconnect": throw new SessionError("not_found", "Plugin API route not found.");
          default: body = await dispatch(s, input.routeKey, companyId, p, input.actor.actorId);
        }
        return { body, headers: { "cache-control": "no-store" } };
      } catch (error) {
        const e = error instanceof SessionError ? error : new SessionError("internal", "The session operation failed.");
        return { status: ({ bad_request: 400, denied: 403, not_paired: 401, not_found: 404, busy: 409, version_mismatch: 409, too_large: 413, too_many_links: 422, rate_limited: 429, browser_offline: 503, timeout: 504 } as Record<string, number>)[e.code] ?? 500, body: { error: { code: e.code, message: e.message } }, headers: { "cache-control": "no-store" } };
      }
    },
  });
  return { plugin, service: get };
}
async function dispatch(s: BrowserSessionsService, key: string, companyId: string, p: Record<string, unknown>, actor: string): Promise<unknown> {
  switch (key) {
    case "status": return s.status(companyId);
    case "settings": return s.settings(companyId);
    case "pair-confirm": return s.confirmPair(companyId, requiredString(p.code, "code", 8), p.shared === true, actor);
    case "sharing": return s.setShared(companyId, p.shared === true, actor);
    case "disconnect": return s.disconnect(companyId, actor);
    case "policy-get": { const state = await s.state(companyId); return { policy: state.policy, trustedAgentIds: state.trustedAgentIds, eventsEnabled: state.eventsEnabled, effectivePolicy: s.effectivePolicy(state) }; }
    case "policy-save": return s.updateSettings(companyId, p, actor);
    case "links": return { links: await s.links(companyId, typeof p.threadKey === "string" ? p.threadKey : undefined, typeof p.issueId === "string" ? p.issueId : undefined) };
    case "link": return { link: await s.serial(companyId, () => s.link(companyId, requiredString(p.issueId, "issueId"), requiredString(p.threadKey, "threadKey"), "user", actor)) };
    case "unlink": return s.unlink(companyId, requiredString(p.issueId, "issueId"), requiredString(p.threadKey, "threadKey"), actor);
    case "task-sessions": return s.taskSessions(companyId, requiredString(p.issueId, "issueId"));
    case "attention": return s.needsAttention(companyId);
    case "actions": return { actions: await s.actions(companyId, typeof p.threadKey === "string" ? p.threadKey : undefined) };
    case "credentials": return s.credentials(companyId);
    case "tasks": { const tasks = await s.host.issues.list({ companyId, limit: 1000 }); const query = String(p.q ?? "").toLowerCase().slice(0, 200); return { tasks: tasks.filter((task) => !query || `${task.identifier} ${task.title}`.toLowerCase().includes(query)).slice(0, 50).map(({ id, title, identifier, status }) => ({ id, title, identifier, status })) }; }
    case "search": case "search-post": {
      const result = await s.executeTool("sessions_search", { query: p.q ?? p.query, limit: typeof p.limit === "string" ? Number(p.limit) : p.limit ?? 8, quality: p.quality ?? "best", cursor: p.cursor, filters: p.filters }, { companyId, agentId: "board", runId: "", projectId: "" });
      if (result.error) { const index = result.error.indexOf(": "); throw new SessionError(index < 0 ? result.error : result.error.slice(0, index), index < 0 ? result.error : result.error.slice(index + 2)); } return result.data;
    }
    case "open": { await s.requireShared(companyId); const threadKey = requiredString(p.threadKey, "threadKey"); if (!await s.store.get("session", companyId, threadKey)) throw new SessionError("not_found"); return s.request(companyId, "thread.open", { threadKey }); }
    case "view-open": { if (!["browse", "threads", "dashboard"].includes(String(p.view))) throw new SessionError("bad_request", "Unknown view."); return s.request(companyId, "view.open", { view: p.view }); }
    default: throw new SessionError("not_found", "Plugin API route not found.");
  }
}
const { plugin } = createBrowserSessionsPlugin();
export default plugin;
runWorker(plugin, import.meta.url);
