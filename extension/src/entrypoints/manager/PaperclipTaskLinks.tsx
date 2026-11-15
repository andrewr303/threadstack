import React, { useCallback, useContext, useEffect, useRef, useState } from 'react';
import type { ConversationRecord } from '../../core/schema.js';
import type { PublicBridgeState } from '../../core/paperclip/bridge.js';
import type { SessionLink } from '../../core/paperclip/bridge-protocol.js';
import { BRIDGE_STORAGE_KEY } from '../../core/paperclip/bridge-protocol.js';
import { PaperclipClient, type PcCompany } from '../../core/paperclip/client.js';
import { useOptionalWorkspaceContext } from './workspace/context.js';
import { workspaceApi } from './workspace/client.js';
import { PaperclipConnectionContext } from './PaperclipConnection.js';

interface Task { id: string; identifier?: string | null; title: string; status: string }
interface ActionRow { agentId: string; tool: string; createdAt: string; status: string }

export function linkedTaskPath(link: Pick<SessionLink, 'issueIdentifier' | 'issueId'>, company?: Pick<PcCompany, 'issuePrefix'>): string {
  const prefix = company?.issuePrefix || link.issueIdentifier?.match(/^(.+)-\d+$/)?.[1];
  return `${prefix ? `/${encodeURIComponent(prefix)}` : ''}/issues/${encodeURIComponent(link.issueIdentifier || link.issueId)}`;
}

/** Founder-owned links are distinct from imported run references. */
export function PaperclipTaskLinks({ conv }: { conv: ConversationRecord }) {
  const workspace = useOptionalWorkspaceContext();
  const connection = useContext(PaperclipConnectionContext);
  const [links, setLinks] = useState<SessionLink[]>([]);
  const [companies, setCompanies] = useState<PcCompany[]>([]);
  const [sharedCompanies, setSharedCompanies] = useState<string[]>([]);
  const [companyId, setCompanyId] = useState('');
  const [picker, setPicker] = useState(false);
  const [query, setQuery] = useState('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [actions, setActions] = useState<ActionRow[]>([]);
  const requestVersion = useRef(0);
  const refreshEpoch = useRef(0);
  const active = workspace?.surface === 'page' && conv.provider !== 'paperclip';
  const running = connection?.snapshot.state === 'running';
  const pc = workspace?.settings?.paperclip;
  useEffect(() => {
    if (!active || !pc) return;
    let alive = true;
    void new PaperclipClient({ serverUrl: pc.serverUrl, apiKey: pc.auth === 'board_key' ? pc.apiKey : '' }).listCompanies()
      .then(list => { if (alive) setCompanies(list); }).catch(() => undefined);
    return () => { alive = false; };
  }, [active, pc?.serverUrl, pc?.apiKey]);
  const refresh = useCallback(async () => {
    if (!active) return;
    const epoch = refreshEpoch.current;
    const status = await workspaceApi.paperclipIntegration<PublicBridgeState>('status');
    if (epoch !== refreshEpoch.current) return;
    if (!status.ok) { setNote(status.error); return; }
    const ids = Object.entries(status.data.companies).filter(([, company]) => company.paired && company.shared).map(([id]) => id);
    setSharedCompanies(ids);
    setCompanyId(previous => ids.includes(previous) ? previous : ids[0] ?? '');
    const cached = ids.flatMap(id => status.data.companies[id].links).filter(link => link.threadKey === conv.threadKey);
    if (!running) { setLinks(cached); return; }
    const results = await Promise.all(ids.map(async id => {
      const result = await workspaceApi.paperclipIntegration<{ links: SessionLink[] }>('links', { companyId: id, threadKey: conv.threadKey });
      return result.ok ? result.data.links : cached.filter(link => link.companyId === id);
    }));
    if (epoch !== refreshEpoch.current) return;
    setLinks(results.flat());
    const history = await Promise.all(ids.map(async id => {
      const result = await workspaceApi.paperclipIntegration<{ actions: ActionRow[] }>('actions', { companyId: id, threadKey: conv.threadKey });
      return result.ok ? result.data.actions : [];
    }));
    if (epoch === refreshEpoch.current) setActions(history.flat().filter(action => action.status === 'delivered' || action.status === 'started' || action.status === 'succeeded').slice(0, 10));
  }, [active, conv.threadKey, running]);
  useEffect(() => {
    setLinks([]); setActions([]); setPicker(false); setQuery(''); setNote(null);
    if (!active) return;
    void refresh();
    const timer = setInterval(() => { if (document.visibilityState !== 'hidden') void refresh(); }, 10_000);
    const events = typeof chrome !== 'undefined' ? chrome.storage?.onChanged : undefined;
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => { if (area === 'local' && changes[BRIDGE_STORAGE_KEY]) void refresh(); };
    if (active) events?.addListener(changed);
    return () => { ++refreshEpoch.current; clearInterval(timer); events?.removeListener(changed); };
  }, [refresh, active]);
  useEffect(() => {
    const version = ++requestVersion.current;
    if (!picker || !companyId || !running) { setTasks([]); return; }
    const timer = setTimeout(() => {
      void workspaceApi.paperclipIntegration<{ tasks: Task[] }>('tasks', { companyId, q: query }).then(result => {
        if (version !== requestVersion.current) return;
        if (result.ok) { setTasks(result.data.tasks ?? []); setNote(null); }
        else { setTasks([]); setNote(result.error); }
      });
    }, 250);
    return () => { clearTimeout(timer); ++requestVersion.current; };
  }, [picker, companyId, query, running]);
  if (!active) return null;
  const mutate = async (action: 'link' | 'unlink', issueId: string, selectedCompany = companyId) => {
    if (!running) { setNote('Paperclip is not running.'); return; }
    setBusy(true); setNote(null);
    const result = await workspaceApi.paperclipIntegration(action, { companyId: selectedCompany, issueId, threadKey: conv.threadKey });
    if (result.ok) { setPicker(false); await refresh(); }
    else setNote(result.error);
    setBusy(false);
  };
  return <section className="tk-paperclip-task-links" aria-label="Linked Paperclip tasks">
    {links.length > 0 && <h4>Linked tasks</h4>}
    {links.map(link => <div className="tk-field-row" key={link.id}>
      <button type="button" className="tk-btn" onClick={() => workspace?.openPaperclip?.(linkedTaskPath(link, companies.find(company => company.id === link.companyId)))}>{link.issueIdentifier || link.issueId} · {link.issueTitle || 'Paperclip task'}</button>
      <span className="tk-muted">{link.issueStatus || 'Status unavailable'}</span>
      <button type="button" className="tk-btn" disabled={busy || !running} onClick={() => void mutate('unlink', link.issueId, link.companyId)} aria-label={`Unlink ${link.issueIdentifier || link.issueId}`}>Unlink</button>
    </div>)}
    <button type="button" className="tk-btn" onClick={() => { setPicker(value => !value); setNote(running ? null : 'Paperclip is not running.'); }}>Link to a task</button>
    {picker && <div className="tk-paperclip-task-picker">
      {!running ? <p role="status">Paperclip is not running.</p> : sharedCompanies.length === 0 ? <p role="status">Pair and share sessions with a company in Settings → Paperclip first.</p> : <>
        <label className="tk-field">Company<select className="tk-input" value={companyId} onChange={event => setCompanyId(event.target.value)}>{sharedCompanies.map(id => <option key={id} value={id}>{companies.find(company => company.id === id)?.name || id}</option>)}</select></label>
        <label className="tk-field">Find a task<input className="tk-input" value={query} onChange={event => setQuery(event.target.value)} placeholder="Task title or identifier" /></label>
        {tasks.map(task => <button key={task.id} type="button" className="tk-btn" disabled={busy} onClick={() => void mutate('link', task.id)}>{task.identifier || task.id} · {task.title} · {task.status}</button>)}
        {!tasks.length && <p className="tk-settings-note">No matching tasks.</p>}
      </>}
    </div>}
    {actions.map((action, index) => <p key={`${action.createdAt}-${index}`} className="tk-muted">{action.agentId} {action.tool.includes('start') ? 'started this session' : 'sent a message'} · {action.createdAt}</p>)}
    {note && <p role="status" className="tk-settings-note">{note}</p>}
  </section>;
}
