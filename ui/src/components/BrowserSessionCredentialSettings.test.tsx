// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserSessionCredentialSettings } from "./BrowserSessionCredentialSettings";
import { pluginsApi } from "../api/plugins";
import { secretsApi } from "../api/secrets";

vi.mock("../api/plugins", () => ({ pluginsApi: { get: vi.fn(), getConfig: vi.fn() } }));
vi.mock("../api/secrets", () => ({ secretsApi: { list: vi.fn() } }));
vi.mock("../pages/PluginSettings", () => ({ PluginConfigForm: () => <div>Native secret reference picker</div> }));
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root; let container: HTMLDivElement; let client: QueryClient;
beforeEach(() => {
  container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(pluginsApi.get).mockResolvedValue({ status: "ready", manifestJson: { instanceConfigSchema: { type: "object", properties: { credentialLinks: { type: "object", properties: { voyageApiKey: { title: "Voyage API key", type: "string", format: "secret-ref" }, openaiApiKey: { title: "OpenAI API key", type: "string", format: "secret-ref" }, anthropicApiKey: { title: "Anthropic API key", type: "string", format: "secret-ref" } } } } } } } as never);
});
afterEach(async () => { await act(() => root.unmount()); client.clear(); container.remove(); vi.clearAllMocks(); });
async function render(companyId: string) { await act(async () => root.render(<QueryClientProvider client={client}><BrowserSessionCredentialSettings pluginId="browser-plugin" companyId={companyId} /></QueryClientProvider>)); await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); }

describe("company-scoped model key status", () => {
  it("distinguishes active, missing and unlinked secret references without resolving values", async () => {
    vi.mocked(pluginsApi.getConfig).mockResolvedValue({ configJson: { credentialLinks: { voyageApiKey: { type: "secret_ref", secretId: "good" }, openaiApiKey: { type: "secret_ref", secretId: "deleted" } } } } as never);
    vi.mocked(secretsApi.list).mockResolvedValue([{ id: "good", companyId: "company-a", status: "active" }] as never);
    await render("company-a");
    expect(container.textContent).toContain("Voyage API key: Linked");
    expect(container.textContent).toContain("OpenAI API key: Secret missing");
    expect(container.textContent).toContain("Anthropic API key: Not linked");
    expect(secretsApi.list).toHaveBeenCalledWith("company-a");
    expect(container.textContent).toContain("Native secret reference picker");
  });

  it("rechecks references in the new company and never accepts a different company's secret", async () => {
    vi.mocked(pluginsApi.getConfig).mockResolvedValue({ configJson: { credentialLinks: { voyageApiKey: { type: "secret_ref", secretId: "good" } } } } as never);
    vi.mocked(secretsApi.list).mockImplementation(async () => [{ id: "good", companyId: "company-a", status: "active" }] as never);
    await render("company-a"); expect(container.textContent).toContain("Voyage API key: Linked");
    await render("company-b"); expect(container.textContent).toContain("Voyage API key: Secret missing");
    expect(pluginsApi.getConfig).toHaveBeenCalledWith("browser-plugin", "company-b");
    expect(secretsApi.list).toHaveBeenCalledWith("company-b");
  });
});
