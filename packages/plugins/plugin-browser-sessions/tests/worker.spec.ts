import { describe, expect, it, vi } from "vitest";
import type { PluginApiRequestInput } from "@paperclipai/plugin-sdk";
import manifest from "../src/manifest.js";
import { createBrowserSessionsPlugin } from "../src/worker.js";
import { MemoryStore } from "../src/store.js";
import { PROTOCOL } from "../src/contracts.js";

const COMPANY = "company-a";
async function setup() {
  const actions = new Map<string, (params: Record<string, unknown>, context: unknown) => Promise<unknown>>();
  const ctx = {
    tools: { register: vi.fn() }, events: { on: vi.fn(), emit: vi.fn(async () => {}) }, data: { register: vi.fn() },
    actions: { register: vi.fn((key: string, handler: (params: Record<string, unknown>, context: unknown) => Promise<unknown>) => { actions.set(key, handler); }) },
    config: { get: vi.fn(async () => ({})) }, secrets: { resolve: vi.fn() }, activity: { log: vi.fn(async () => {}) },
    issues: { get: vi.fn(async () => null) }, agents: { get: vi.fn(async () => null), list: vi.fn(async () => []) },
    companies: { get: vi.fn(async (id: string) => ({ id, name: "Acme" })) },
  };
  const { plugin, service } = createBrowserSessionsPlugin({ store: new MemoryStore(), commit: "abc1234" });
  await plugin.definition.setup(ctx as never);
  const api = (routeKey: string, body: Record<string, unknown>, headers: Record<string, string> = {}) => plugin.definition.onApiRequest!({ routeKey, method: "POST", path: `/${routeKey}`, params: {}, query: {}, body: { companyId: COMPANY, ...body }, actor: { actorType: "user", actorId: "local-board" }, companyId: COMPANY, headers } satisfies PluginApiRequestInput);
  const board = { actor: { type: "user", userId: "founder" }, companyId: COMPANY };
  return { plugin, service, api, actions, board };
}
describe("REQ-7 finding 1: board-only pairing, sharing and disconnect", () => {
  it("does not declare token-less HTTP routes for pair-confirm, sharing or disconnect", () => {
    const keys = (manifest.apiRoutes ?? []).map((route) => route.routeKey);
    expect(keys).not.toContain("pair-confirm"); expect(keys).not.toContain("sharing"); expect(keys).not.toContain("disconnect");
    expect(keys).toEqual(expect.arrayContaining(["pair-start", "pair-poll", "bridge-disconnect", "bridge-share"]));
  });
  it("refuses those keys on the HTTP path, so a local caller cannot finish start → confirm → poll", async () => {
    const { api, service } = await setup();
    const start = await api("pair-start", { protocol: PROTOCOL }); const pair = start.body as { pairId: string; code: string; pollToken: string };
    expect(await api("pair-confirm", { code: pair.code, shared: true })).toMatchObject({ status: 404, body: { error: { code: "not_found" } } });
    expect((await api("pair-poll", { pairId: pair.pairId, pollToken: pair.pollToken })).body).toEqual({ status: "pending" });
    expect(await api("sharing", { shared: true })).toMatchObject({ status: 404 });
    expect(await api("disconnect", {})).toMatchObject({ status: 404 });
    expect((await service().state(COMPANY)).tokenHash).toBeNull();
  });
  it("keeps the same operations available to a board user through the UI action path", async () => {
    const { api, actions, board } = await setup();
    const pair = (await api("pair-start", { protocol: PROTOCOL })).body as { pairId: string; code: string; pollToken: string };
    expect(await actions.get("pair-confirm")!({ companyId: COMPANY, code: pair.code, shared: true }, board)).toEqual({ confirmed: true });
    expect((await api("pair-poll", { pairId: pair.pairId, pollToken: pair.pollToken })).body).toMatchObject({ status: "paired" });
    expect(await actions.get("disconnect")!({ companyId: COMPANY }, board)).toEqual({ disconnected: true });
  });
});
describe("R2 NF-3: bridge-offline route", () => {
  it("is declared as a token-protected bridge route and dispatches to the offline signal", async () => {
    expect((manifest.apiRoutes ?? []).find((route) => route.routeKey === "bridge-offline")).toMatchObject({ path: "/bridge/offline", method: "POST", auth: "board" });
    const { api, actions, board, service } = await setup();
    const pair = (await api("pair-start", { protocol: PROTOCOL })).body as { pairId: string; code: string; pollToken: string };
    await actions.get("pair-confirm")!({ companyId: COMPANY, code: pair.code, shared: true }, board);
    const token = String(((await api("pair-poll", { pairId: pair.pairId, pollToken: pair.pollToken })).body as { bridgeToken: string }).bridgeToken);
    await api("bridge-connect", { protocol: PROTOCOL, policy: { enabled: false, providers: [], disabledAt: 0 } }, { "x-threadkeeper-bridge-token": token });
    expect(await api("bridge-offline", {})).toMatchObject({ status: 401, body: { error: { code: "not_paired" } } });
    expect(await api("bridge-offline", {}, { "x-threadkeeper-bridge-token": token })).toMatchObject({ body: { offline: true } });
    expect(await service().status(COMPANY)).toMatchObject({ connected: false, shared: true });
    service().close();
  });
});
