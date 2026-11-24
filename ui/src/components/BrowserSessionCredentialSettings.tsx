import { useQuery } from "@tanstack/react-query";
import { pluginsApi } from "../api/plugins";
import { queryKeys } from "../lib/queryKeys";
import { QueryErrorState, useQueryView } from "./QueryView";
import { PluginConfigForm } from "../pages/PluginSettings";
import type { JsonSchemaNode } from "./JsonSchemaForm";
import { secretsApi } from "../api/secrets";

/** Host-owned secret references use the existing native picker and company-scoped API. */
export function BrowserSessionCredentialSettings({ pluginId, companyId }: { pluginId: string; companyId: string }) {
  const plugin = useQuery({ queryKey: queryKeys.plugins.detail(pluginId), queryFn: () => pluginsApi.get(pluginId) });
  const config = useQuery({ queryKey: queryKeys.plugins.config(pluginId, companyId), queryFn: () => pluginsApi.getConfig(pluginId, companyId) });
  const secrets = useQuery({ queryKey: queryKeys.secrets.list(companyId), queryFn: () => secretsApi.list(companyId) });
  const pluginView = useQueryView(plugin);
  const configView = useQueryView(config);
  if (pluginView.kind === "error") return <QueryErrorState error={pluginView.error} action="load model key settings" onRetry={pluginView.retry} />;
  if (configView.kind === "error") return <QueryErrorState error={configView.error} action="load model key settings" onRetry={configView.retry} />;
  const schema = plugin.data?.manifestJson?.instanceConfigSchema as JsonSchemaNode | undefined;
  if (!schema || pluginView.kind === "loading" || pluginView.kind === "reconnecting" || configView.kind === "loading" || configView.kind === "reconnecting") return <p className="text-sm text-muted-foreground">Loading model key settings…</p>;
  return <section className="mt-6 space-y-4" aria-label="Model keys">
    <div className="space-y-1">
      <h2 className="text-base font-medium">Model keys</h2>
      <p className="text-sm text-muted-foreground">Choose keys from this organization’s secrets. Linked keys reach ThreadStack only when you turn on sharing below.</p>
    </div>
    {secrets.isError ? <QueryErrorState error={secrets.error} action="check linked model keys" onRetry={() => { void secrets.refetch(); }} /> : secrets.isPending ? <p className="text-sm text-muted-foreground">Checking linked keys…</p> : <ul className="space-y-1 text-sm" aria-label="Linked key status">
      {Object.entries(schema.properties?.credentialLinks?.properties ?? {}).map(([key, property]) => {
        const links = config.data?.configJson?.credentialLinks as Record<string, unknown> | undefined;
        const value = links?.[key];
        const secretId = value && typeof value === "object" && "secretId" in value ? String(value.secretId) : typeof value === "string" && value ? value : null;
        const secret = secretId ? secrets.data.find((candidate) => candidate.id === secretId && candidate.companyId === companyId && candidate.status === "active") : null;
        return <li key={key}>{property.title || key}: {secretId ? secret ? "Linked" : "Secret missing" : "Not linked"}</li>;
      })}
    </ul>}
    <PluginConfigForm key={`${pluginId}:${companyId}`} pluginId={pluginId} companyId={companyId} schema={schema} initialValues={config.data?.configJson} pluginStatus={plugin.data?.status} />
  </section>;
}
