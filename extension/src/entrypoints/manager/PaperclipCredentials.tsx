import React, { useCallback, useEffect, useId, useState } from 'react';
import type { SettingsRecord } from '../../core/schema.js';
import type { PcCompany } from '../../core/paperclip/client.js';
import { paperclipPermissionOrigins } from '../../core/host-access.js';
import {
  MODEL_CREDENTIAL_KEYS, getModelCredential, normalizePaperclipCredentials,
  type CredentialStatus, type ModelCredentialKey,
} from '../../core/paperclip/credentials.js';
import { workspaceApi } from './workspace/client.js';

const LABELS: Record<ModelCredentialKey, string> = {
  anthropicApiKey: 'Anthropic', awsPlatformApiKey: 'Claude Platform on AWS', voyageApiKey: 'Voyage',
  openaiApiKey: 'OpenAI', mongodbApiKey: 'MongoDB Atlas models', cohereApiKey: 'Cohere',
  workerBearerToken: 'Cloud worker token', 'aws.bedrockApiKey': 'Bedrock API key',
  'aws.accessKeyId': 'AWS access key ID', 'aws.secretAccessKey': 'AWS secret access key', 'aws.sessionToken': 'AWS session token',
};
export function isModelCredentialLinked(settings: SettingsRecord, key: string): boolean {
  return normalizePaperclipCredentials(settings.paperclipCredentials).linkedKeys.includes(key);
}
async function allowAccess(serverUrl: string): Promise<boolean> {
  const origins = paperclipPermissionOrigins(serverUrl);
  if (!origins.length) return false;
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return true;
  try { return await chrome.permissions.request({ origins }); } catch { return false; }
}

/** Metadata only. Secret values are consumed solely in the feature modules and never rendered. */
export function PaperclipCredentials({ settings, onPatch, companies = [] }: {
  settings: SettingsRecord;
  onPatch: (patch: Partial<SettingsRecord>) => Promise<void>;
  companies?: PcCompany[];
}) {
  const config = normalizePaperclipCredentials(settings.paperclipCredentials);
  const id = useId();
  const [status, setStatus] = useState<CredentialStatus | null>(null);
  const [selected, setSelected] = useState<Partial<Record<ModelCredentialKey, string>>>({});
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [failed, setFailed] = useState(false);
  const refresh = useCallback(async (companyId: string) => {
    const response = await workspaceApi.paperclipIntegration<CredentialStatus>('credentials.status', { companyId });
    if (!response.ok) { setNote(response.error); setFailed(true); return; }
    setStatus(response.data);
  }, []);
  useEffect(() => {
    setStatus(null); setSelected({});
    if (config.companyId) void refresh(config.companyId);
  }, [config.companyId, settings.paperclip.serverUrl, refresh]);

  const change = async (action: string, payload: Record<string, unknown>, prompt = true) => {
    if (busy) return;
    setBusy(true); setNote(''); setFailed(false);
    try {
      if (prompt && !await allowAccess(settings.paperclip.serverUrl)) throw new Error('Allow access to Paperclip to manage model keys.');
      const response = await workspaceApi.paperclipIntegration<CredentialStatus>(action, payload);
      if (!response.ok) throw new Error(response.error);
      const next = normalizePaperclipCredentials(response.data);
      const patch: Partial<SettingsRecord> = { paperclipCredentials: next };
      // onPatch merges over the fresh DB row. Migration already cleared keys transactionally;
      // replaying this component's older settings here could overwrite a concurrent key edit.
      await onPatch(patch);
      setStatus(response.data);
      if (response.data.notMoved?.length) {
        setFailed(true);
        setNote(`Not moved: ${response.data.notMoved.map((key) => LABELS[key]).join(', ')}. Their stored keys were kept.`);
      } else setNote(action === 'credentials.move' ? 'Model keys moved and read back successfully.' : 'Model key settings saved.');
    } catch (error) {
      setFailed(true); setNote(error instanceof Error ? error.message : 'Paperclip model keys are unavailable.');
      // The worker commits local denial before remote writes; mirror it even if Paperclip is down.
      if (action === 'credentials.source') await onPatch({ paperclipCredentials: { companyId: String(payload.companyId), linkedKeys: [], allowSecretTransfer: false } });
      if (action === 'credentials.clear') await onPatch({ paperclipCredentials: { companyId: '', linkedKeys: [], allowSecretTransfer: false } });
      if (action === 'credentials.consent' && payload.enabled === false) await onPatch({ paperclipCredentials: { ...config, allowSecretTransfer: false } });
      if (action === 'credentials.link' && payload.secretId === null) await onPatch({ paperclipCredentials: { ...config, blockedKeys: [...new Set([...(config.blockedKeys ?? []), String(payload.keyName)])], linkedKeys: config.linkedKeys.filter((key) => key !== payload.keyName) } });
    } finally { setBusy(false); }
  };
  const hasStored = MODEL_CREDENTIAL_KEYS.some((key) => getModelCredential(settings, key).trim());
  return <section className="tk-settings-section" aria-label="Model keys">
    <h3 className="tk-settings-h3">Model keys</h3>
    <p className="tk-settings-note">Keep model keys in Paperclip. Linked values stay in memory for the current call and are left out of ThreadStack storage and backups.</p>
    <div className="tk-field">
      <label htmlFor={`${id}-company`}>Read keys from</label>
      <select id={`${id}-company`} className="tk-input" disabled={busy} value={config.companyId} onChange={(event) => {
        const companyId = event.target.value;
        // Deselecting also clears the previous company's consent and links in Paperclip.
        if (!companyId) void change('credentials.clear', {}, false);
        else void change('credentials.source', { companyId });
      }}>
        <option value="">Choose a company</option>
        {config.companyId && !companies.some((company) => company.id === config.companyId) && <option value={config.companyId}>{config.companyId}</option>}
        {companies.map((company) => <option value={company.id} key={company.id}>{company.name}</option>)}
      </select>
    </div>
    <label className="tk-toggle"><input type="checkbox" checked={config.allowSecretTransfer} disabled={!config.companyId || busy} onChange={(event) => void change('credentials.consent', { companyId: config.companyId, enabled: event.target.checked })} />
      <span>Allow paired ThreadStack to use this company’s model keys<span className="tk-toggle-hint">Keys cross the paired connection only when a feature needs them. Linked remote features pause while Paperclip is unavailable; local search keeps working.</span></span>
    </label>
    {config.companyId && <>
      {MODEL_CREDENTIAL_KEYS.map((key) => {
        const linked = config.linkedKeys.includes(key);
        const missing = status?.missingKeys.includes(key);
        return <div className="tk-field" key={key}>
          <label htmlFor={`${id}-${key}`}>{LABELS[key]} <span className="tk-settings-note">{missing ? 'Secret missing' : linked ? 'From Paperclip · Linked' : 'Not linked'}</span></label>
          <div className="tk-field-row">
            <select className="tk-input tk-grow" id={`${id}-${key}`} disabled={busy || !config.allowSecretTransfer} value={selected[key] ?? ''} onChange={(event) => setSelected((old) => ({ ...old, [key]: event.target.value }))}>
              <option value="">Use Paperclip secret…</option>
              {(status?.secrets ?? []).map((secret) => <option value={secret.id} key={secret.id}>{secret.name}</option>)}
            </select>
            <button type="button" className="tk-btn" disabled={busy || !config.allowSecretTransfer || !selected[key]} onClick={() => void change('credentials.link', { companyId: config.companyId, keyName: key, secretId: selected[key] })}>Link</button>
            {linked && <button type="button" className="tk-btn" disabled={busy} onClick={() => void change('credentials.link', { companyId: config.companyId, keyName: key, secretId: null }, false)}>Unlink</button>}
          </div>
        </div>;
      })}
      <div className="tk-field-row">
        <button type="button" className="tk-btn" disabled={busy} onClick={() => void change('credentials.status', { companyId: config.companyId })}>Refresh model keys</button>
        {hasStored && <button type="button" className="tk-btn" disabled={busy || !config.allowSecretTransfer} onClick={() => void change('credentials.move', { companyId: config.companyId })}>Move my keys to Paperclip</button>}
      </div>
    </>}
    {note && <p className={`tk-settings-note${failed ? ' tk-text-danger' : ''}`} role={failed ? 'alert' : 'status'}>{note}</p>}
  </section>;
}
