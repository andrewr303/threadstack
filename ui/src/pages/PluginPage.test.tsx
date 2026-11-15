// @vitest-environment jsdom

import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PluginPage } from "./PluginPage";
import { setVerifiedThreadkeeperHost } from "@/lib/threadkeeper-host-state";
import { currentThreadkeeperSlot } from "@/lib/threadkeeper-host-slot";

const mockPluginsApi = vi.hoisted(() => ({
  listUiContributions: vi.fn(),
}));

const mockSetBreadcrumbs = vi.hoisted(() => vi.fn());
const mockParams = vi.hoisted(() => ({
  companyPrefix: "PAP" as string | undefined,
  pluginId: undefined as string | undefined,
  pluginRoutePath: undefined as string | undefined,
  "*": undefined as string | undefined,
}));

vi.mock("@/api/plugins", () => ({
  pluginsApi: mockPluginsApi,
}));

vi.mock("@/context/BreadcrumbContext", () => ({
  useBreadcrumbs: () => ({
    setBreadcrumbs: mockSetBreadcrumbs,
  }),
}));

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "PAP" }],
    selectedCompanyId: "company-1",
  }),
}));

vi.mock("@/lib/router", () => ({
  Link: ({ to, children }: { to: string; children: React.ReactNode }) => <a href={to}>{children}</a>,
  Navigate: () => null,
  useParams: () => mockParams,
}));

vi.mock("@/plugins/slots", async () => {
  const actual = await vi.importActual<typeof import("@/plugins/slots")>("@/plugins/slots");
  return {
    resolveRouteSidebarSlot: actual.resolveRouteSidebarSlot,
    PluginSlotMount: ({ slot }: { slot: { displayName: string } }) => (
      <div data-testid="plugin-slot-mount">{slot.displayName}</div>
    ),
  };
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  await callback();
  await Promise.resolve();
  await new Promise((resolve) => window.setTimeout(resolve, 0));
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function pageContribution(overrides: Partial<{ slots: unknown[] }> = {}) {
  return {
    pluginId: "plugin-wiki",
    pluginKey: "paperclipai.plugin-llm-wiki",
    displayName: "LLM Wiki",
    version: "0.1.0",
    uiEntryFile: "ui.js",
    slots: [
      {
        type: "page",
        id: "wiki-page",
        displayName: "Wiki",
        exportName: "WikiPage",
        routePath: "wiki",
      },
    ],
    launchers: [],
    ...overrides,
  };
}

async function renderPage(container: HTMLDivElement) {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  await act(async () => {
    root.render(
      <QueryClientProvider client={queryClient}>
        <PluginPage />
      </QueryClientProvider>,
    );
  });
  await flushReact();
  await flushReact();
  return root;
}

describe("PluginPage", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    mockParams.companyPrefix = "PAP";
    mockParams.pluginId = undefined;
    mockParams.pluginRoutePath = undefined;
    mockParams["*"] = undefined;
  });

  afterEach(() => {
    container.remove();
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  it("renders the breadcrumb and Back button on a legacy plugin route (no routeSidebar)", async () => {
    mockParams.pluginRoutePath = "wiki";
    mockPluginsApi.listUiContributions.mockResolvedValue([pageContribution()]);

    const root = await renderPage(container);

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([
      { label: "Plugins", href: "/company/settings/instance/plugins" },
      { label: "LLM Wiki" },
    ]);
    expect(container.textContent).toContain("Back");
    expect(container.querySelector('a[href="/PAP/dashboard"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it("uses a route title and hides the Back button when a routeSidebar matches the active route", async () => {
    mockParams.pluginRoutePath = "wiki";
    mockPluginsApi.listUiContributions.mockResolvedValue([
      pageContribution({
        slots: [
          {
            type: "page",
            id: "wiki-page",
            displayName: "Wiki",
            exportName: "WikiPage",
            routePath: "wiki",
          },
          {
            type: "routeSidebar",
            id: "wiki-sidebar",
            displayName: "Wiki Sidebar",
            exportName: "WikiRouteSidebar",
            routePath: "wiki",
          },
        ],
      }),
    ]);

    const root = await renderPage(container);

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "Wiki" }]);
    expect(container.textContent).not.toContain("Back");
    expect(container.querySelector('a[href="/PAP/dashboard"]')).toBeNull();
    // Page slot itself still renders.
    expect(container.querySelector('[data-testid="plugin-slot-mount"]')?.textContent).toBe("Wiki");

    await act(async () => {
      root.unmount();
    });
  });

  describe("Threadkeeper fused slot (REQ-6)", () => {
    const browserSessions = () => pageContribution({
      slots: [
        { type: "page", id: "browser-browse", displayName: "Browse", exportName: "BrowsePage", routePath: "browse" },
        { type: "page", id: "browser-threads", displayName: "Threads", exportName: "ThreadsPage", routePath: "threads" },
        { type: "page", id: "browser-session-board", displayName: "Session board", exportName: "BoardPage", routePath: "session-board" },
      ],
    });
    afterEach(() => setVerifiedThreadkeeperHost(false));

    it("keeps the plugin page outside a verified Threadkeeper window", async () => {
      mockParams.pluginRoutePath = "threads";
      mockPluginsApi.listUiContributions.mockResolvedValue([{ ...browserSessions(), pluginId: "plugin-bs", pluginKey: "browser-sessions", displayName: "Browser sessions" }]);
      const root = await renderPage(container);
      expect(container.querySelector('[data-testid="plugin-slot-mount"]')?.textContent).toBe("Threads");
      expect(container.querySelector("[data-threadkeeper-slot-view]")).toBeNull();
      expect(currentThreadkeeperSlot()).toBeNull();
      await act(async () => root.unmount());
    });

    it("renders a transparent slot instead of the page body for the verified host and releases it on leaving", async () => {
      setVerifiedThreadkeeperHost(true);
      mockParams.pluginRoutePath = "session-board";
      mockPluginsApi.listUiContributions.mockResolvedValue([{ ...browserSessions(), pluginId: "plugin-bs", pluginKey: "browser-sessions", displayName: "Browser sessions" }]);
      // F-2: a shell that has not engaged fused mode still switches to the view when it is chosen.
      const requested: unknown[] = [];
      const listener = (event: Event) => requested.push((event as CustomEvent).detail);
      window.addEventListener("paperclip:threadkeeper-open-view", listener);
      const root = await renderPage(container);
      window.removeEventListener("paperclip:threadkeeper-open-view", listener);
      expect(requested).toEqual([{ view: "dashboard" }]);
      const slot = container.querySelector<HTMLElement>("[data-threadkeeper-slot-view]");
      expect(slot?.getAttribute("data-threadkeeper-slot-view")).toBe("session-board");
      expect(slot?.textContent).toBe("");
      expect(container.querySelector('[data-testid="plugin-slot-mount"]')).toBeNull();
      expect(container.textContent).not.toContain("Back");
      expect(currentThreadkeeperSlot()).toEqual({ view: "session-board", element: slot });
      expect(mockSetBreadcrumbs).toHaveBeenLastCalledWith([{ label: "Session board" }]);
      await act(async () => root.unmount());
      expect(currentThreadkeeperSlot()).toBeNull();
    });

    it("never replaces another plugin's page that uses the same route", async () => {
      setVerifiedThreadkeeperHost(true);
      mockParams.pluginRoutePath = "wiki";
      mockPluginsApi.listUiContributions.mockResolvedValue([pageContribution()]);
      const root = await renderPage(container);
      expect(container.querySelector('[data-testid="plugin-slot-mount"]')?.textContent).toBe("Wiki");
      expect(container.querySelector("[data-threadkeeper-slot-view]")).toBeNull();
      await act(async () => root.unmount());
    });
  });

  it("uses the selected plugin page path as the route-sidebar title", async () => {
    mockParams.pluginRoutePath = "wiki";
    mockParams["*"] = "page/templates%3A%3Aindex.md";
    mockPluginsApi.listUiContributions.mockResolvedValue([
      pageContribution({
        slots: [
          {
            type: "page",
            id: "wiki-page",
            displayName: "Wiki",
            exportName: "WikiPage",
            routePath: "wiki",
          },
          {
            type: "routeSidebar",
            id: "wiki-sidebar",
            displayName: "Wiki Sidebar",
            exportName: "WikiRouteSidebar",
            routePath: "wiki",
          },
        ],
      }),
    ]);

    const root = await renderPage(container);

    expect(mockSetBreadcrumbs).toHaveBeenCalledWith([{ label: "index" }]);

    await act(async () => {
      root.unmount();
    });
  });
});
