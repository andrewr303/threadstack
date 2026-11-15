import { describe, expect, it, vi } from 'vitest';
import type { AgentAction } from '../../src/core/paperclip/bridge-protocol.js';
import type { ConversationRecord, SettingsRecord } from '../../src/core/schema.js';
import { DEFAULT_SETTINGS } from '../../src/core/schema.js';
import { realmForProvider } from '../../src/core/workspace/realms.js';
import type { WorkspaceController } from '../../src/entrypoints/manager/workspace/useWorkspace.js';
import { executePaperclipAction, type ManagerActionEnvironment } from '../../src/entrypoints/manager/paperclip-actions.js';

function fixture() {
  const conv = { provider: 'claude', accountId: 'acct_me', canonicalUrl: 'https://claude.ai/chat/one', threadKey: 'thread-one', agentState: 'turn_complete' } as ConversationRecord;
  const action: AgentAction = { type: 'session.send', companyId: 'company', agentId: 'agent', issueId: 'task', clientRequestId: 'client', requestId: 'request', createdAt: 1, deadlineAt: 20_000, policyDisabledAt: 0, provider: 'claude', accountId: conv.accountId, threadKey: conv.threadKey, url: conv.canonicalUrl, text: 'A useful reply' };
  const workspace = {
    embedding: true, tabId: 7, realms: [{ realm: realmForProvider('claude'), activeAccountId: 'acct_me', accounts: [{ id: 'acct_me', primary: true, mode: 'embedded' }] }], slots: {},
    state: { tabs: [{ id: 'embedded-one', provider: 'claude', realm: 'anthropic', accountId: 'acct_me', url: conv.canonicalUrl, threadKey: conv.threadKey }] },
    runtime: () => ({ frameId: 3, loaded: true, agentState: 'turn_complete' }),
    openThread: vi.fn(() => ({ ok: true, tabId: 'embedded-one' })), activateTab: vi.fn(),
  } as unknown as WorkspaceController;
  const send = vi.fn(async () => ({ ok: true, data: { delivered: true, at: '2026-11-13T12:00:00Z', url: conv.canonicalUrl } }));
  const environment: ManagerActionEnvironment = { workspace: () => workspace, settings: () => DEFAULT_SETTINGS as SettingsRecord, readThread: async () => conv, showBrowse: vi.fn(), now: () => 100, sleep: async () => undefined, send };
  return { conv, action, workspace, send, environment };
}

describe('manager browser-action executor', () => {
  it('delivers only to the resolved exact account and frame', async () => {
    const { action, send, environment } = fixture();
    await expect(executePaperclipAction(action, new AbortController().signal, environment)).resolves.toEqual({ delivered: true, at: '2026-11-13T12:00:00Z' });
    expect(send).toHaveBeenCalledWith(7, 3, expect.objectContaining({ type: 'TK_SESSION_DELIVER', requestId: 'request', expectedUrl: 'https://claude.ai/chat/one' }));
  });
  it('refuses stale account identity without opening or typing', async () => {
    const { action, workspace, send, environment } = fixture();
    await expect(executePaperclipAction({ ...action, accountId: 'acct_other' } as AgentAction, new AbortController().signal, environment)).rejects.toMatchObject({ code: 'denied' });
    expect(workspace.openThread).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('starts under the explicit account and returns the confirmed session address', async () => {
    const { action, conv, workspace, send, environment } = fixture();
    workspace.openUrl = vi.fn(() => ({ ok: true as const, tabId: 'embedded-one' }));
    const start: AgentAction = { ...action, type: 'session.start', provider: 'claude', accountId: 'acct_me', prompt: 'Begin the work' };
    await expect(executePaperclipAction(start, new AbortController().signal, environment)).resolves.toEqual({ started: true, url: conv.canonicalUrl, threadKey: conv.threadKey });
    expect(workspace.openUrl).toHaveBeenCalledWith('https://claude.ai/new', { accountId: 'acct_me', activate: true });
    expect(send).toHaveBeenCalledWith(7, 3, expect.objectContaining({ text: 'Begin the work', expectedUrl: 'https://claude.ai/new' }));
  });
  it('refuses a profile slot occupied by another account', async () => {
    const { action, workspace, send, environment } = fixture();
    workspace.realms[0].activeAccountId = 'browser-account';
    Object.assign(workspace.realms[0].accounts[0], { hasJar: true, signedIn: 'yes' });
    workspace.slots = { anthropic: { accountId: 'different-profile', status: 'ready' } };
    await expect(executePaperclipAction(action, new AbortController().signal, environment)).rejects.toMatchObject({ code: 'signed_out' });
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses a signed-out browser account without opening a tab (REQ-11 F-8)', async () => {
    const { action, workspace, send, environment } = fixture();
    Object.assign(workspace.realms[0].accounts[0], { signedIn: 'no' });
    await expect(executePaperclipAction(action, new AbortController().signal, environment)).rejects.toMatchObject({ code: 'signed_out' });
    expect(workspace.openThread).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });
  it('limits page loading to 30 s and leaves the frame a full 15 s confirmation after the Send-ready wait (REQ-11 F-7)', async () => {
    const { action, workspace, send, environment } = fixture();
    let clock = 1_000; environment.now = () => clock; environment.sleep = async (ms: number) => { clock += ms; };
    const slow = { ...action, createdAt: 1_000, deadlineAt: 1_000 + 60_000 };
    (workspace as unknown as { runtime: () => unknown }).runtime = () => ({ frameId: null, loaded: false, agentState: 'unknown' });
    await expect(executePaperclipAction(slow, new AbortController().signal, environment)).rejects.toMatchObject({ code: 'timeout', message: expect.stringContaining('30') });
    expect(clock - 1_000).toBeGreaterThanOrEqual(30_000); expect(clock - 1_000).toBeLessThan(31_000);
    expect(send).not.toHaveBeenCalled();
    (workspace as unknown as { runtime: () => unknown }).runtime = () => ({ frameId: 3, loaded: true, agentState: 'turn_complete' });
    clock = 1_000;
    await executePaperclipAction(slow, new AbortController().signal, environment);
    const command = (send.mock.calls[0] as unknown[])[2] as { deadlineAt: number };
    expect(command.deadlineAt - clock).toBeGreaterThanOrEqual(17_000);
  });
  it('fits page load and delivery inside the action deadline, leaving time to report the verdict (NF-3b)', async () => {
    const { action, workspace, send, environment } = fixture();
    let clock = 1_000; environment.now = () => clock; environment.sleep = async (ms: number) => { clock += ms; };
    const tight = { ...action, createdAt: 1_000, deadlineAt: 1_000 + 40_000 };
    (workspace as unknown as { runtime: () => unknown }).runtime = () => ({ frameId: null, loaded: false, agentState: 'unknown' });
    await expect(executePaperclipAction(tight, new AbortController().signal, environment)).rejects.toMatchObject({ code: 'timeout' });
    // 40 s budget − (2 s Send-ready + 15 s confirmation + 0.5 s) − 1.5 s verdict margin = 21 s of page load.
    expect(clock - 1_000).toBeLessThanOrEqual(21_100);
    (workspace as unknown as { runtime: () => unknown }).runtime = () => ({ frameId: 3, loaded: true, agentState: 'turn_complete' });
    clock = 1_000;
    await executePaperclipAction({ ...tight, deadlineAt: 1_000 + 10_000 }, new AbortController().signal, environment);
    const command = (send.mock.calls[0] as unknown[])[2] as { deadlineAt: number };
    expect(command.deadlineAt).toBeLessThanOrEqual(1_000 + 10_000 - 1_500);
  });
  it('reports the contract text for why it stopped before typing: switch-off or deadline (NF-2)', async () => {
    const { action, send, environment } = fixture();
    const off = new AbortController(); off.abort('disabled');
    await expect(executePaperclipAction(action, off.signal, environment)).rejects.toMatchObject({ code: 'disabled', message: 'Agent actions are turned off.' });
    const late = new AbortController(); late.abort('timeout');
    await expect(executePaperclipAction(action, late.signal, environment)).rejects.toMatchObject({ code: 'timeout', message: 'The browser did not answer in 30 seconds.' });
    expect(send).not.toHaveBeenCalled();
  });
  it('never submits expired or cancelled actions', async () => {
    const { action, send, environment } = fixture();
    const cancelled = new AbortController(); cancelled.abort();
    await expect(executePaperclipAction(action, cancelled.signal, environment)).rejects.toMatchObject({ code: 'disabled' });
    await expect(executePaperclipAction({ ...action, deadlineAt: 99 }, new AbortController().signal, environment)).rejects.toMatchObject({ code: 'timeout' });
    expect(send).not.toHaveBeenCalled();
  });
  it('reports ambiguous delivery as unknown and never resubmits', async () => {
    const { action, send, environment } = fixture();
    send.mockResolvedValue({ ok: false, error: { code: 'unknown_delivery', message: 'Read the session before trying again.' } } as never);
    await expect(executePaperclipAction(action, new AbortController().signal, environment)).rejects.toMatchObject({ code: 'unknown_delivery' });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it('rechecks privacy after loading the frame and refuses a newly private session', async () => {
    const { action, send, environment } = fixture();
    environment.mayShare = async () => false;
    await expect(executePaperclipAction(action, new AbortController().signal, environment)).rejects.toMatchObject({ code: 'not_found' });
    expect(send).not.toHaveBeenCalled();
  });
  it('refuses a browser account change during the final privacy check', async () => {
    const { action, workspace, send, environment } = fixture();
    environment.mayShare = async () => { workspace.realms[0].activeAccountId = 'different-login'; return true; };
    await expect(executePaperclipAction(action, new AbortController().signal, environment)).rejects.toMatchObject({ code: 'denied' });
    expect(send).not.toHaveBeenCalled();
  });
});
