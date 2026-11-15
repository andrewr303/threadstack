import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it } from "vitest";
import { BoardPage, BrowsePage, SessionsNeedingYou, SettingsPage, TaskSessionsTab, ThreadsPage, relativeTime } from "../src/ui/index.js";

type BridgeGlobal = typeof globalThis & { __paperclipPluginBridge__?: { sdkUi: Record<string, unknown> } };
afterEach(() => { delete (globalThis as BridgeGlobal).__paperclipPluginBridge__; });
it.each([["Browse", BrowsePage], ["Threads", ThreadsPage], ["Session board", BoardPage]] as const)("renders the agreed ordinary-tab Threadkeeper handoff for %s", (_name, Page) => {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = { sdkUi: {
    usePluginAction: () => async () => ({}),
    useHostLocation: () => ({ pathname: "/THR/threads", search: "", hash: "" }),
    useHostNavigation: () => ({ linkProps: (href: string) => ({ href }) }),
    usePluginData: () => ({ data: { shared: false, sessions: [], total: 0 }, loading: false, error: null, refresh: () => {} }),
    usePluginStream: () => ({ lastEvent: null }),
  } };
  const html = renderToStaticMarkup(createElement(Page, { context: { companyId: "company", companyPrefix: "THR", projectId: null, entityId: null, entityType: null, userId: "board" } }));
  expect(html).toContain("Open this in Threadkeeper");
  expect(html).toContain("Browse, Threads and the session board run inside the Threadkeeper window.");
  expect(html).toContain(">Open Threadkeeper</button>");
});

function withBridge(data: unknown) {
  (globalThis as BridgeGlobal).__paperclipPluginBridge__ = { sdkUi: {
    usePluginAction: () => async () => ({}),
    useHostLocation: () => ({ pathname: "/THR/dashboard", search: "", hash: "" }),
    useHostNavigation: () => ({ linkProps: (href: string) => ({ href }) }),
    usePluginData: () => ({ data, loading: false, error: null, refresh: () => {} }),
    usePluginStream: () => ({ lastEvent: null }),
  } };
}
const context = { companyId: "company", companyPrefix: "THR", projectId: null, entityId: "task-a", entityType: "issue", userId: "board" };
const policy = { enabled: false, providers: [], disabledAt: 0 };
const settings = (actions: unknown[]) => ({ connected: true, shared: true, lastSeenAt: new Date().toISOString(), browser: "Edge", sessionCount: 2, warning: null, versionMismatch: false, policy, effectivePolicy: policy, trustedAgentIds: [], eventsEnabled: true, agents: [{ id: "agent-a", name: "Builder", status: "idle" }], credentials: { linkedKeys: [], allowSecretTransfer: false }, actions });
it("REQ-11 F-6: shows the contract texts and the empty Recent actions state", () => {
  withBridge(settings([]));
  const html = renderToStaticMarkup(createElement(SettingsPage, { context }));
  expect(html).toContain("Allow trusted agents to act in my browser");
  expect(html).toContain("Agents will send messages and start sessions as you. Providers may forbid automated use of personal accounts.");
  expect(html).toContain("10 messages and 3 new sessions per agent per hour.");
  expect(html).toContain("No agent has acted yet.");
  expect(html).toMatch(/Builder[^<]*<\/span>[\s\S]*?Trusted|Trusted[\s\S]*?Builder/);
});
it("REQ-11 F-6: lists an action with the agent's name, task and session title", () => {
  withBridge(settings([{ id: "a1", companyId: "company", agentId: "agent-a", agentName: "Builder", runId: "r", issueId: "task-a", tool: "session_send", threadKey: "claude:one", sessionTitle: "Fix the build", provider: "claude", accountLabel: "Work", text: "Full text", clientRequestId: "c", inputHash: "h", admitted: false, status: "Refused: not trusted", createdAt: new Date().toISOString(), completedAt: null }]));
  const html = renderToStaticMarkup(createElement(SettingsPage, { context }));
  expect(html).toContain("Refused: not trusted"); expect(html).toContain("Builder"); expect(html).toContain("Fix the build"); expect(html).toContain("Full text");
  expect(html).not.toContain("agent-a");
});

it("REQ-9/10: relative times read as the contract shows them", () => {
  const now = Date.parse("2026-11-14T12:00:00Z");
  expect(relativeTime("2026-11-14T11:00:00Z", now)).toBe("1 hour ago"); expect(relativeTime("2026-11-14T11:55:00Z", now)).toBe("5 minutes ago");
  expect(relativeTime("2026-11-14T11:59:30Z", now)).toBe("just now"); expect(relativeTime("2026-11-12T12:00:00Z", now)).toBe("2 days ago");
});
it("REQ-9 AC-5 / REQ-10 AC-8: an offline task tab shows Not observed, a relative Last seen and a visible hint", () => {
  const seen = new Date(Date.now() - 3_600_000).toISOString();
  withBridge({ connected: false, shared: true, lastSeenAt: seen, browser: "Edge", sessionCount: 1, warning: null, versionMismatch: false, policy, effectivePolicy: policy, sessions: [{ link: { id: "l1", companyId: "company", issueId: "task-a", threadKey: "claude:one", origin: "user", creator: "board", createdAt: seen }, session: { threadKey: "claude:one", fingerprint: "f", title: "One", provider: "claude", providerLabel: "Claude", url: "https://claude.ai/chat/one", observed: false, agentState: "running", agentStateAt: seen } }] });
  const html = renderToStaticMarkup(createElement(TaskSessionsTab, { context }));
  expect(html).toContain("Not observed"); expect(html).toContain("Last seen 1 hour ago"); expect(html).toMatch(/>Open the browser to use this\.</);
});
it("REQ-9 AC-7: the widget's empty text", () => {
  withBridge({ connected: true, shared: true, lastSeenAt: null, browser: "", sessionCount: 0, warning: null, versionMismatch: false, policy, effectivePolicy: policy, sessions: [], total: 0 });
  expect(renderToStaticMarkup(createElement(SessionsNeedingYou, { context }))).toContain("Nothing needs you.");
});
it("REQ-9 AC-7: widget rows show provider and linked task, and View all leads to Threads", () => {
  const at = new Date().toISOString();
  withBridge({ connected: true, shared: true, lastSeenAt: at, browser: "Edge", sessionCount: 25, warning: null, versionMismatch: false, policy, effectivePolicy: policy, total: 25, sessions: [{ threadKey: "claude:one", fingerprint: "f", title: "One", provider: "claude", providerLabel: "Claude", url: "https://claude.ai/chat/one", observed: true, agentState: "waiting_answer", agentStateAt: at, linkedTasks: [{ issueId: "task-a", identifier: "THR-7", title: "Fix" }] }] });
  const html = renderToStaticMarkup(createElement(SessionsNeedingYou, { context }));
  expect(html).toContain("Claude"); expect(html).toContain("THR-7"); expect(html).toContain('href="/threads"'); expect(html).toContain("View all (25)");
});
it("REQ-10 AC-9 / REQ-7 FR-7: settings label and relative last seen", () => {
  withBridge({ ...settings([]), connected: false, lastSeenAt: new Date(Date.now() - 5 * 60_000).toISOString() });
  const html = renderToStaticMarkup(createElement(SettingsPage, { context }));
  expect(html).toContain("Session changes update tasks and wake agents"); expect(html).toContain("Not connected"); expect(html).toContain("Last seen 5 minutes ago");
});
