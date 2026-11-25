import React, { useCallback, useEffect, useState } from 'react';
import { BRIDGE_STORAGE_KEY, BRIDGE_SUPPORTED_PROVIDERS, DEFAULT_ACTION_POLICY, commitOfBuildId } from '../../core/paperclip/bridge-protocol.js';
import { BUILD_INFO } from '../../core/build-info.js';
import { providerLabel } from '../../core/providers.js';
import type { PcCompany } from '../../core/paperclip/client.js';
import type { PublicBridgeState } from '../../core/paperclip/bridge.js';
import { workspaceApi } from './workspace/client.js';

interface AgentActionRow {
  clientRequestId?: string; requestId?: string; agentId: string; issueId: string; tool: string;
  text: string; status: string; createdAt: string; accountLabel?: string; provider?: string;
}

const EMPTY: PublicBridgeState = { serverUrl: '', companies: {}, policy: { ...DEFAULT_ACTION_POLICY, providers: [] }, allowRemoteModels: false, shareTranscripts: false };

/** "5 minutes ago", as the contract words it (FR-7). */
export function lastSeenText(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

export function PaperclipBridgeSettings({ companies, extensionCommit = commitOfBuildId(BUILD_INFO.buildId) }: { companies: PcCompany[] | null; extensionCommit?: string }) {
  const [state, setState] = useState<PublicBridgeState>(EMPTY);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [selectedCompany, setSelectedCompany] = useState('');
  const [actions, setActions] = useState<AgentActionRow[]>([]);
  const refresh = useCallback(async () => {
    const result = await workspaceApi.paperclipIntegration<PublicBridgeState>('status');
    if (result.ok) { setState(result.data); return true; }
    setNote(result.error);
    return false;
  }, []);
  useEffect(() => {
    void refresh();
    const events = typeof chrome !== 'undefined' ? chrome.storage?.onChanged : undefined;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[BRIDGE_STORAGE_KEY]) void refresh();
    };
    events?.addListener(changed);
    return () => events?.removeListener(changed);
  }, [refresh]);
  const run = async (action: string, payload: unknown) => {
    setBusy(true); setNote(null);
    try {
      const result = await workspaceApi.paperclipIntegration(action, payload);
      if (!result.ok) setNote(result.error);
      await refresh();
    } finally { setBusy(false); }
  };
  const pendingIds = Object.entries(state.companies).filter(([, s]) => s.pending && !s.paired).map(([id]) => id).sort().join(',');
  useEffect(() => {
    if (!pendingIds) return;
    let alive = true;
    const timer = setInterval(() => {
      if (document.visibilityState === 'hidden') return;
      void Promise.all(pendingIds.split(',').map(companyId => workspaceApi.paperclipIntegration('pair_poll', { companyId })))
        .then(() => { if (alive) void refresh(); });
    }, 2_000);
    return () => { alive = false; clearInterval(timer); };
  }, [pendingIds, refresh]);
  useEffect(() => {
    if (!selectedCompany && companies?.length) setSelectedCompany(companies[0].id);
  }, [companies, selectedCompany]);
  const loadActions = useCallback(async () => {
    if (!selectedCompany) { setActions([]); return; }
    const result = await workspaceApi.paperclipIntegration<{ actions: AgentActionRow[] }>('actions', { companyId: selectedCompany });
    if (result.ok) setActions(result.data.actions ?? []);
    else { setActions([]); setNote(result.error); }
  }, [selectedCompany]);
  useEffect(() => { void loadActions(); }, [loadActions]);
  const updatePolicy = (enabled: boolean, providers: string[]) => run('policy', {
    policy: { enabled, providers, disabledAt: !enabled || state.policy.providers.some(id => !providers.includes(id)) ? Date.now() : state.policy.disabledAt },
  });
  return (
    <>
      <section className="tk-settings-section">
        <h3 className="tk-settings-h3">Browser sessions</h3>
        <p className="tk-settings-note">Pair each company in Paperclip, then choose whether its agents may read your browser library. Local-only threads and projects are never shared.</p>
        {!companies?.length && <p className="tk-settings-note">Connect Paperclip and refresh its company list to pair browser sessions.</p>}
        {!!companies?.length && !companies.some(company => state.companies[company.id]?.paired && state.companies[company.id]?.shared) && <p className="tk-settings-note">No company can see your sessions yet. Choose one to share with.</p>}
        {companies?.map(company => {
          const status = state.companies[company.id];
          return <div className="tk-paperclip-company" key={company.id}>
            <strong>{company.name}{company.issuePrefix && ` (${company.issuePrefix})`}</strong>
            <span className="tk-muted" role="status">
              {status?.lastError?.startsWith('version_mismatch') ? 'Version mismatch' : status?.paired && status.connected ? 'Connected' : 'Not connected'}
              {status?.paired && !status.connected && status.lastSeenAt > 0 && ` · Last seen ${lastSeenText(status.lastSeenAt)}`}
              {status?.paired && status.shared && ` · ${status.sessionCount} session${status.sessionCount === 1 ? '' : 's'} shared`}
            </span>
            {status?.paired && extensionCommit && status.pluginCommit && commitOfBuildId(status.pluginCommit) && commitOfBuildId(status.pluginCommit) !== extensionCommit
              && <p className="tk-settings-result" data-ok="false">ThreadStack and Paperclip were built from different commits ({extensionCommit} and {commitOfBuildId(status.pluginCommit)}).</p>}
            {!status?.paired && <button type="button" className="tk-btn" disabled={busy} onClick={() => void run('pair', { companyId: company.id })}>Pair {company.name}</button>}
            {status?.pending && !status.paired && <p role="status">In Paperclip’s Browser sessions settings, enter this code in Confirm pairing code: <strong className="tk-paperclip-pair-code">{status.pending.code}</strong>. It expires in 10 minutes.</p>}
            {status?.paired && <>
              <label className="tk-toggle"><input type="checkbox" checked={status.shared} disabled={busy} onChange={event => void run('share', { companyId: company.id, shared: event.target.checked })} /><span>Share sessions with {company.name}</span></label>
              <button type="button" className="tk-btn" disabled={busy} onClick={() => void run('disconnect', { companyId: company.id })}>Disconnect {company.name}</button>
            </>}
            {status?.lastError && <p className="tk-settings-result" data-ok="false">{status.lastError}</p>}
          </div>;
        })}
        <label className="tk-toggle"><input type="checkbox" checked={state.shareTranscripts === true} disabled={busy} onChange={event => void run('options', { shareTranscripts: event.target.checked, allowRemoteModels: state.allowRemoteModels === true })} /><span>Allow agents to read full transcripts<span className="tk-toggle-hint">Turn off to limit reads to summaries and bounded context.</span></span></label>
        <label className="tk-toggle"><input type="checkbox" checked={state.allowRemoteModels === true} disabled={busy} onChange={event => void run('options', { allowRemoteModels: event.target.checked, shareTranscripts: state.shareTranscripts === true })} /><span>Allow configured remote models for agent searches<span className="tk-toggle-hint">Otherwise agent searches use the local index without remote embedding or reranking calls.</span></span></label>
      </section>
      <section className="tk-settings-section">
        <h3 className="tk-settings-h3">Agent actions</h3>
        <label className="tk-toggle"><input type="checkbox" checked={state.policy.enabled} onChange={event => void updatePolicy(event.target.checked, state.policy.providers)} /><span>Allow trusted agents to act in my browser</span></label>
        <p className="tk-settings-note">Agents will send messages and start sessions as you. Providers may forbid automated use of personal accounts. Both Paperclip and this browser must allow an action; turning either side off stops queued actions.</p>
        <div className="tk-capture-grid">{BRIDGE_SUPPORTED_PROVIDERS.map(provider => <label key={provider} className="tk-toggle"><input type="checkbox" checked={state.policy.providers.includes(provider)} onChange={event => void updatePolicy(state.policy.enabled, event.target.checked ? [...state.policy.providers, provider] : state.policy.providers.filter(id => id !== provider))} /><span>{providerLabel(provider)}</span></label>)}</div>
        <p className="tk-settings-note">10 messages and 3 new sessions per agent per hour. At most one message per session per minute. Mark trusted agents in Paperclip’s Browser sessions settings.</p>
        <h4>Recent actions</h4>
        <label className="tk-field">Company<select className="tk-input" value={selectedCompany} onChange={event => setSelectedCompany(event.target.value)}><option value="">Choose a company</option>{companies?.map(company => <option key={company.id} value={company.id}>{company.name}</option>)}</select></label>
        {!actions.length && <p className="tk-settings-note">No agent has acted yet.</p>}
        {actions.map((action, index) => <details className="tk-paperclip-action" key={action.requestId ?? action.clientRequestId ?? index}><summary>{action.agentId} · {action.tool} · {action.status} · {action.createdAt}</summary><p>{action.issueId} · {action.provider ? providerLabel(action.provider) : ''} · {action.accountLabel}</p><pre>{action.text}</pre></details>)}
        <button type="button" className="tk-btn" disabled={busy || !selectedCompany} onClick={() => void loadActions()}>Refresh recent actions</button>
      </section>
      {note && <p role="status" className="tk-settings-result" data-ok="false">{note}</p>}
    </>
  );
}
