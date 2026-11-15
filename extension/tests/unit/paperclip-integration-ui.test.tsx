import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaperclipBridgeSettings } from '../../src/entrypoints/manager/PaperclipBridgeSettings.js';
import { PaperclipTaskLinks, linkedTaskPath } from '../../src/entrypoints/manager/PaperclipTaskLinks.js';
import { WorkspaceProvider, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import { configureWorkspaceClient } from '../../src/entrypoints/manager/workspace/client.js';
import { PaperclipConnectionContext } from '../../src/entrypoints/manager/PaperclipConnection.js';
import { DEFAULT_SETTINGS, type ConversationRecord } from '../../src/core/schema.js';
import type { PublicBridgeState } from '../../src/core/paperclip/bridge.js';
import type { SessionLink } from '../../src/core/paperclip/bridge-protocol.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
const companies = [{ id: 'company-a', name: 'Acme', issuePrefix: 'ACME' }];
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(() => { act(() => root.unmount()); host.remove(); configureWorkspaceClient({ send: null }); vi.unstubAllGlobals(); });
async function settle(ms = 0) { await act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); }); }
function button(label: string) { const result = [...host.querySelectorAll('button')].find(item => item.textContent?.trim() === label); if (!result) throw new Error(`Missing button ${label}`); return result; }
function state(): PublicBridgeState { return { serverUrl: 'http://localhost:3100', companies: {}, policy: { enabled: false, providers: [], disabledAt: 0 }, allowRemoteModels: false, shareTranscripts: false }; }

describe('browser-session settings', () => {
  it('shows separate off-by-default consent and exposes only the pairing code', async () => {
    const current = state();
    const sent: unknown[] = [];
    configureWorkspaceClient({ send: async (command) => {
      sent.push(command);
      const input = command as { action?: string };
      if (input.action === 'pair') current.companies['company-a'] = { pendingDisconnect: false, paired: false, shared: false, connected: false, lastSeenAt: 0, lastError: '', pluginVersion: '', pluginCommit: '', links: [], sessionCount: 0, pending: { code: 'AB12CD34', expiresAt: Date.now() + 300000 } };
      return { ok: true, data: input.action === 'actions' ? { actions: [] } : structuredClone(current) };
    } });
    await act(async () => root.render(<PaperclipBridgeSettings companies={companies} />));
    await settle();
    expect([...host.querySelectorAll<HTMLInputElement>('input[type=checkbox]')].every(input => !input.checked)).toBe(true);
    await act(async () => button('Pair Acme').click()); await settle();
    expect(host.textContent).toContain('AB12CD34');
    expect(sent).toContainEqual({ type: 'PAPERCLIP_INTEGRATION', action: 'pair', payload: { companyId: 'company-a' } });
    expect(host.querySelector('input[type=password]')).toBeNull();
  });
  it('revokes queued-action generations when the master switch is turned off', async () => {
    const current = state(); current.policy = { enabled: true, providers: ['claude'], disabledAt: 0 };
    const sent: Array<{ action?: string; payload?: unknown }> = [];
    configureWorkspaceClient({ send: async (command) => { sent.push(command as never); return { ok: true, data: (command as { action?: string }).action === 'actions' ? { actions: [] } : structuredClone(current) }; } });
    await act(async () => root.render(<PaperclipBridgeSettings companies={[]} />)); await settle();
    const master = [...host.querySelectorAll('label')].find(label => label.textContent === 'Allow trusted agents to act in my browser')!.querySelector('input')!;
    await act(async () => master.click()); await settle();
    expect(sent.find(item => item.action === 'policy')?.payload).toMatchObject({ policy: { enabled: false, providers: ['claude'], disabledAt: expect.any(Number) } });
    expect((sent.find(item => item.action === 'policy')?.payload as { policy: { disabledAt: number } }).policy.disabledAt).toBeGreaterThan(0);
  });
});

describe('browser-session status copy (REQ-7 FR-2, FR-7, UI Layout)', () => {
  const company = (patch: Record<string, unknown>) => ({ pendingDisconnect: false, paired: true, shared: true, connected: true, lastSeenAt: Date.now(), lastError: '', pluginVersion: '0.1', pluginCommit: 'abc1234', links: [], sessionCount: 12, pending: null, ...patch });
  async function render(companiesState: Record<string, unknown>, extensionCommit = 'abc1234') {
    act(() => root.unmount()); root = createRoot(host);
    const current = { ...state(), companies: companiesState } as unknown as PublicBridgeState;
    configureWorkspaceClient({ send: async (command) => ({ ok: true, data: (command as { action?: string }).action === 'actions' ? { actions: [] } : structuredClone(current) }) });
    await act(async () => root.render(<PaperclipBridgeSettings companies={[...companies, { id: 'company-b', name: 'Beta', issuePrefix: 'BETA' }]} extensionCommit={extensionCommit} />)); await settle();
  }
  it('shows Connected and the shared count', async () => {
    await render({ 'company-a': company({}) });
    expect(host.textContent).toContain('Connected');
    expect(host.textContent).toContain('12 sessions shared');
    expect(host.textContent).not.toContain('No company can see your sessions yet');
  });
  it('shows Not connected with a relative last-seen time', async () => {
    await render({ 'company-a': company({ connected: false, lastSeenAt: Date.now() - 5 * 60_000 }) });
    expect(host.textContent).toContain('Not connected');
    expect(host.textContent).toContain('Last seen 5 minutes ago');
  });
  it('warns when commits differ, shows Version mismatch and surfaces a plugin error', async () => {
    await render({ 'company-a': company({ pluginCommit: 'def5678', connected: false, lastError: 'version_mismatch: Paperclip and Threadkeeper use different bridge protocols.' }) });
    expect(host.textContent).toContain('Threadkeeper and Paperclip were built from different commits (abc1234 and def5678).');
    expect(host.textContent).toContain('Version mismatch');
    await render({ 'company-a': company({ connected: false, lastError: 'unsupported: Paperclip plugin "browser-sessions": Plugin not found' }) });
    expect(host.textContent).toContain('Plugin not found');
    expect(host.textContent).not.toContain('different commits');
  });
  it('says the pairing code expires in 10 minutes and shows the empty state', async () => {
    await render({ 'company-a': company({ paired: false, shared: false, connected: false, pending: { code: 'AB12CD34', expiresAt: Date.now() + 600_000 } }) });
    expect(host.textContent).toContain('10 minutes');
    expect(host.textContent).not.toContain('five minutes');
    expect(host.textContent).toContain('No company can see your sessions yet. Choose one to share with.');
  });
});

describe('thread task links', () => {
  it('keeps task paths local and encodes identifiers', () => {
    expect(linkedTaskPath({ issueId: 'uuid', issueIdentifier: 'ACME-12' })).toBe('/ACME/issues/ACME-12');
    expect(linkedTaskPath({ issueId: 'a/b' })).toBe('/issues/a%2Fb');
  });
  it('links a shared session to the chosen task and opens the dedicated app view', async () => {
    const current = state();
    current.companies['company-a'] = { pendingDisconnect: false, paired: true, shared: true, connected: true, lastSeenAt: Date.now(), lastError: '', pluginVersion: '1', pluginCommit: '', links: [], sessionCount: 1, pending: null };
    const links: SessionLink[] = []; const sent: unknown[] = []; const openPaperclip = vi.fn();
    configureWorkspaceClient({ send: async (command) => {
      sent.push(command);
      const input = command as { action?: string; payload?: { companyId?: string; issueId?: string; threadKey?: string } };
      if (input.action === 'link') links.push({ id: 'link-a', companyId: 'company-a', issueId: 'task-a', threadKey: 'thread-a', origin: 'user', creator: 'founder', createdAt: new Date().toISOString(), issueIdentifier: 'ACME-12', issueTitle: 'Ship the change', issueStatus: 'todo' });
      const data = input.action === 'status' ? structuredClone(current) : input.action === 'tasks' ? { tasks: [{ id: 'task-a', identifier: 'ACME-12', title: 'Ship the change', status: 'todo' }] } : input.action === 'links' ? { links: [...links] } : { actions: [] };
      return { ok: true, data };
    } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(companies), { status: 200 })));
    const conv = { provider: 'claude', threadKey: 'thread-a' } as ConversationRecord;
    const context = { surface: 'page', settings: DEFAULT_SETTINGS, openPaperclip } as unknown as WorkspaceContextValue;
    const connection = { snapshot: { state: 'running' as const, origin: 'http://localhost:3100' }, retry: vi.fn(), setup: vi.fn(), allowAccess: vi.fn() };
    await act(async () => root.render(<WorkspaceProvider value={context}><PaperclipConnectionContext.Provider value={connection}><PaperclipTaskLinks conv={conv} /></PaperclipConnectionContext.Provider></WorkspaceProvider>));
    await settle();
    await act(async () => button('Link to a task').click()); await settle(280);
    await act(async () => button('ACME-12 · Ship the change · todo').click()); await settle();
    expect(sent).toContainEqual({ type: 'PAPERCLIP_INTEGRATION', action: 'link', payload: { companyId: 'company-a', issueId: 'task-a', threadKey: 'thread-a' } });
    await act(async () => button('ACME-12 · Ship the change').click());
    expect(openPaperclip).toHaveBeenCalledWith('/ACME/issues/ACME-12');
  });
});
