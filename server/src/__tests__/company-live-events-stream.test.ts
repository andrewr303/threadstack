import express from "express";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Request } from "express";
import { createCompanyLiveEventStreams } from "../routes/company-live-events-stream.js";
import { publishLiveEvent, subscribeCompanyLiveEvents } from "../services/live-events.js";
import { idleAdmissionMiddleware, trackIdleRequestHandlers } from "../middleware/idle-admission.js";
import { idleWorkSnapshot } from "../services/task-admission.js";
import { createCompanyLiveDelivery } from "../realtime/company-live-delivery.js";

const COMPANY = "company-a";
const other = "company-b";
const actor = { type: "board" as const, userId: "viewer", source: "local_implicit" as const };
const handles: Array<() => Promise<void>> = [];
afterEach(async () => { for (const cleanup of handles.splice(0)) await cleanup(); });

async function fixture(input: { actor?: Request["actor"]; db?: unknown; keepaliveMs?: number; beforeActor?: () => Promise<void> } = {}) {
  const unsubscribed = vi.fn();
  const delivered = vi.fn();
  const streams = createCompanyLiveEventStreams((input.db ?? {}) as never, {
    keepaliveMs: input.keepaliveMs ?? 30_000,
    subscribe: (companyId, listener) => {
      const stop = subscribeCompanyLiveEvents(companyId, event => { delivered(); listener(event); });
      return () => { unsubscribed(); stop(); };
    },
  });
  const app = express();
  app.use(idleAdmissionMiddleware);
  app.use(async (req, _res, next) => { await input.beforeActor?.(); req.actor = input.actor ?? actor; next(); });
  app.use("/api", streams.router);
  app.use((error: { status?: number; message?: string }, _req: Request, res: express.Response, _next: express.NextFunction) => {
    res.status(error.status ?? 500).json({ error: error.message });
  });
  trackIdleRequestHandlers(app);
  const server: Server = createServer(app);
  await new Promise<void>(resolve => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address() as { port: number };
  handles.push(async () => { streams.close(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  return { streams, unsubscribed, delivered, url: `http://127.0.0.1:${address.port}/api/companies/${COMPANY}/events/stream` };
}

async function nextData(reader: ReadableStreamDefaultReader<Uint8Array>) {
  let text = "";
  while (true) {
    const chunk = await reader.read();
    if (chunk.done) throw new Error("Stream closed before data");
    text += new TextDecoder().decode(chunk.value);
    const found = text.split("\n").find(line => line.startsWith("data: "));
    if (found) return JSON.parse(found.slice(6));
  }
}

describe("same-auth company live SSE", () => {
  it.each([
    [{ type: "none", source: "none" }, 401],
    [{ type: "board", source: "session", userId: "viewer", companyIds: [other] }, 403],
    [{ type: "agent", source: "agent_key", agentId: "agent", companyId: other, keyId: "key" }, 403],
    [{ type: "agent", source: "agent_key", agentId: "agent", companyId: COMPANY, keyId: "key", keyScope: { type: "connection_test" } }, 403],
    [{ type: "agent", source: "agent_jwt", agentId: "agent", companyId: COMPANY }, 403],
  ] as const)("refuses unauthorized or foreign-company actors before streaming", async (requestActor, status) => {
    const f = await fixture({ actor: requestActor as Request["actor"] });
    const response = await fetch(f.url);
    expect(response.status).toBe(status);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(f.streams.size).toBe(0);
  });

  it("admits a full agent API key only for its own company", async () => {
    const f = await fixture({ actor: { type: "agent", source: "agent_key", agentId: "agent", companyId: COMPANY, keyId: "key" } });
    const abort = new AbortController();
    const response = await fetch(f.url, { signal: abort.signal });
    expect(response.status).toBe(200);
    abort.abort();
    await vi.waitFor(() => expect(f.streams.size).toBe(0));
  });

  it("forwards only the subscribed company and releases idle work and listeners on disconnect", async () => {
    const f = await fixture();
    const abort = new AbortController();
    const response = await fetch(f.url, { signal: abort.signal });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(f.streams.size).toBe(1);
    await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
    const reader = response.body!.getReader();
    const message = nextData(reader);
    publishLiveEvent({ companyId: other, type: "agent.status", payload: { agentId: "foreign", status: "running" } });
    const published = publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: { agentId: "owned", status: "idle" } });
    expect(await message).toMatchObject({ id: published.id, companyId: COMPANY, type: "agent.status", payload: published.payload });
    expect(f.delivered).toHaveBeenCalledTimes(1);
    abort.abort();
    await vi.waitFor(() => expect(f.unsubscribed).toHaveBeenCalledTimes(1));
    expect(f.streams.size).toBe(0);
    publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: {} });
    expect(f.delivered).toHaveBeenCalledTimes(1);
  });

  it("uses the same viewer projection as WebSocket and rechecks membership", async () => {
    let active = true;
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => active ? [{ id: "active" }] : [] }) }) }));
    const f = await fixture({ actor: { type: "board", source: "session", userId: "viewer", companyIds: [COMPANY] }, db: { select } });
    const abort = new AbortController();
    const response = await fetch(f.url, { signal: abort.signal });
    const reader = response.body!.getReader();
    const message = nextData(reader);
    publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: { agentId: "agent", status: "idle", privateText: "must not leave" } });
    expect((await message).payload).toEqual({ agentId: "agent", status: "idle" });
    const previousReads = select.mock.calls.length;
    active = false;
    publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: { agentId: "agent", status: "running" } });
    await vi.waitFor(() => expect(select.mock.calls.length).toBeGreaterThan(previousReads));
    abort.abort();
    await vi.waitFor(() => expect(f.streams.size).toBe(0));
  });

  it("drops all events after the shared viewer authorization sees membership revoked", async () => {
    let active = true;
    const writes: object[] = [];
    const select = vi.fn(() => ({ from: () => ({ where: () => ({ limit: async () => active ? [{ id: "active" }] : [] }) }) }));
    const delivery = createCompanyLiveDelivery({ select } as never, { companyId: COMPANY, actorType: "board", actorId: "viewer",
      actor: { type: "board", source: "session", userId: "viewer", companyIds: [COMPANY] } }, {
      readyState: 1, send: (data, done) => { writes.push(JSON.parse(data)); done?.(); }, close: vi.fn(),
    });
    try {
      delivery.enqueue(publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: { status: "idle" } }));
      await vi.waitFor(() => expect(writes).toHaveLength(1));
      active = false;
      const reads = select.mock.calls.length;
      delivery.enqueue(publishLiveEvent({ companyId: COMPANY, type: "agent.status", payload: { status: "running" } }));
      await vi.waitFor(() => expect(select.mock.calls.length).toBeGreaterThan(reads));
      await vi.waitFor(() => expect(idleWorkSnapshot().active).toBe(0));
      expect(writes).toHaveLength(1);
    } finally { delivery.dispose(); }
  });

  it("clears the bounded connection keepalive and closes streams on owner shutdown", async () => {
    const f = await fixture({ keepaliveMs: 10 });
    const response = await fetch(f.url);
    const reader = response.body!.getReader();
    let text = "";
    while (!text.includes(": keepalive")) text += new TextDecoder().decode((await reader.read()).value);
    f.streams.close();
    expect(f.unsubscribed).toHaveBeenCalledTimes(1);
    expect(f.streams.size).toBe(0);
    while (!(await reader.read()).done) { /* drain the final comment */ }
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(f.unsubscribed).toHaveBeenCalledTimes(1);
  });

  it("does not subscribe when a client disconnects while ordinary HTTP authentication is pending", async () => {
    let entered = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const f = await fixture({ beforeActor: async () => { entered = true; await gate; } });
    const abort = new AbortController();
    const response = fetch(f.url, { signal: abort.signal }).catch(() => null);
    await vi.waitFor(() => expect(entered).toBe(true));
    abort.abort(); await response;
    await new Promise(resolve => setTimeout(resolve, 10));
    release();
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(f.streams.size).toBe(0);
    expect(f.delivered).not.toHaveBeenCalled();
    expect(idleWorkSnapshot().active).toBe(0);
  });
});
