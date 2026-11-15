import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { freshDb, seed, thread } from './dock-helpers.js';
import { BrowserActionGuard, BridgeActionError, memoryActionJournal } from '../../src/core/paperclip/actions.js';
import { abortedBeforeTyping, type ActionPolicy, type BridgeRequest, type SessionLink } from '../../src/core/paperclip/bridge-protocol.js';

const databases: ReturnType<typeof freshDb>[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });

async function harness() {
  const db = freshDb(); databases.push(db); await ensureStarterCollectionsAndSettings(db);
  const key = await seed(db, thread('act', 'Act', [['user', 'old']]));
  const policy: ActionPolicy = { enabled: true, providers: ['chatgpt'], disabledAt: 0 };
  const links: SessionLink[] = [{ id: 'link', companyId: 'a', issueId: 'task', threadKey: key, origin: 'user', creator: 'founder', createdAt: new Date().toISOString() }];
  const execute = vi.fn(async () => ({ delivered: true as const, at: new Date().toISOString() }));
  const journal = memoryActionJournal();
  const guard = new BrowserActionGuard({ db, journal, policy: () => policy, links: () => links, execute });
  const request = (id = 'client-1', text = 'hello'): BridgeRequest => ({ requestId: id, type: 'session.send', params: { agentId: 'agent', issueId: 'task', threadKey: key, clientRequestId: id, text, policyDisabledAt: 0 }, createdAt: Date.now(), deadlineAt: Date.now() + 30_000 });
  return { db, key, policy, links, execute, journal, guard, request };
}

describe('browser action safety', () => {
  it('deduplicates concurrent and later sends using a durable reservation', async () => {
    const h = await harness();
    const [a, b] = await Promise.all([h.guard.run('a', h.request()), h.guard.run('a', h.request())]);
    expect(a.ok && b.ok).toBe(true); expect(h.execute).toHaveBeenCalledTimes(1);
    expect((await h.guard.run('a', h.request())).ok).toBe(true); expect(h.execute).toHaveBeenCalledTimes(1);
    expect(await h.guard.run('a', h.request('client-1', 'different'))).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('refuses agent-made links and private or running sessions', async () => {
    const h = await harness(); h.links[0].origin = 'agent';
    expect(await h.guard.run('a', h.request())).toMatchObject({ ok: false, error: { code: 'denied' } });
    h.links[0].origin = 'user'; await h.db.conversations.update(h.key, { cloudExcluded: true });
    expect(await h.guard.run('a', h.request('2'))).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await h.db.conversations.update(h.key, { cloudExcluded: false, agentState: 'running' });
    expect(await h.guard.run('a', h.request('3'))).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('off wins and stale requests are dropped after reconnect', async () => {
    const h = await harness(); h.policy.disabledAt = Date.now();
    expect(await h.guard.run('a', h.request())).toMatchObject({ ok: false, error: { code: 'disabled' } });
    h.policy.disabledAt = 0; h.policy.enabled = false;
    expect(await h.guard.run('a', h.request('2'))).toMatchObject({ ok: false, error: { code: 'disabled' } });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('records adapter and page-changed failures for Diagnostics without message text (REQ-11 F-5)', async () => {
    const h = await harness();
    const failures: Array<{ code: string; provider: string }> = [];
    const guard = new BrowserActionGuard({ db: h.db, journal: memoryActionJournal(), policy: () => h.policy, links: () => h.links, execute: h.execute, onFailure: (action, error) => failures.push({ code: error.code, provider: action.provider }) });
    h.execute.mockRejectedValueOnce(new BridgeActionError('unsupported', 'ChatGPT has no send support yet.'));
    expect(await guard.run('a', h.request('f1', 'secret words'))).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    h.execute.mockRejectedValueOnce(new BridgeActionError('denied', 'The loaded page is no longer the requested session.'));
    expect(await guard.run('a', h.request('f2', 'secret words'))).toMatchObject({ ok: false, error: { code: 'denied' } });
    expect(failures).toEqual([{ code: 'unsupported', provider: 'chatgpt' }, { code: 'denied', provider: 'chatgpt' }]);
  });

  it('reports a held action\'s verdict before its deadline so Paperclip receives it in time (plugin follow-up 3)', async () => {
    const h = await harness();
    h.execute.mockImplementationOnce(((_action: unknown, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new BridgeActionError('unknown_delivery', 'Not confirmed.')), { once: true }))) as never);
    const request = { ...h.request('held'), deadlineAt: Date.now() + 2_600 };
    const result = await h.guard.run('a', request);
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown_delivery' } });
    expect(request.deadlineAt - Date.now()).toBeGreaterThanOrEqual(1_000);
  });

  it('tells the executor why it was aborted: switch-off or deadline (NF-2)', async () => {
    const h = await harness();
    const reasons: unknown[] = [];
    const held = ((_a: unknown, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener('abort', () => { reasons.push(signal.reason); reject(new BridgeActionError('disabled', 'Agent actions are turned off.')); }, { once: true }))) as never;
    h.execute.mockImplementationOnce(held);
    const off = h.guard.run('a', h.request('r-off'));
    await new Promise(resolve => setTimeout(resolve, 50)); h.guard.cancelPending(); await off;
    h.execute.mockImplementationOnce(held);
    await h.guard.run('a', { ...h.request('r-late'), deadlineAt: Date.now() + 1_600 });
    expect(reasons).toEqual(['disabled', 'timeout']);
  });

  it('cancels only the listed request, telling its executor it was denied (plugin round 2 c/d)', async () => {
    const h = await harness();
    const reasons: Record<string, unknown> = {};
    h.execute.mockImplementation(((action: { requestId: string }, signal: AbortSignal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { reasons[action.requestId] = signal.reason; reject(new BridgeActionError('denied', 'This agent is not trusted for browser actions.')); }, { once: true });
      setTimeout(() => resolve({ delivered: true, at: new Date().toISOString() }), 150);
    })) as never);
    const one = h.guard.run('a', { ...h.request('c-1'), requestId: 'req-1' });
    const two = h.guard.run('a', { ...h.request('c-2'), requestId: 'req-2' });
    await new Promise(resolve => setTimeout(resolve, 50));
    h.guard.cancelRequests(['req-1']);
    expect(await one).toMatchObject({ ok: false, error: { code: 'denied', message: 'This agent is not trusted for browser actions.' } });
    expect((await two).ok).toBe(true);
    expect(reasons).toEqual({ 'req-1': 'denied' });
  });

  it('remembers a cancel that arrives before its request is registered, and tolerates repeated ids (F-2)', async () => {
    const h = await harness();
    h.guard.cancelRequests(['req-early']); h.guard.cancelRequests(['req-early']);
    expect(await h.guard.run('a', { ...h.request('c-early'), requestId: 'req-early' })).toMatchObject({ ok: false, error: { code: 'denied', message: 'This agent is not trusted for browser actions.' } });
    expect(h.execute).not.toHaveBeenCalled();
    h.guard.cancelRequests(['req-early']);
    expect((await h.guard.run('a', { ...h.request('c-other'), requestId: 'req-other' })).ok).toBe(true);
  });

  it('when links change, aborts only actions whose own link vanished, with the FR-1 link text (F-3)', async () => {
    const h = await harness();
    const other = await seed(h.db, thread('act-b', 'Act B', [['user', 'old']]));
    h.links.push({ id: 'link-b', companyId: 'a', issueId: 'task', threadKey: other, origin: 'user', creator: 'founder', createdAt: new Date().toISOString() });
    h.execute.mockImplementation(((_action: unknown, signal: AbortSignal) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new BridgeActionError('denied', 'aborted')), { once: true });
      setTimeout(() => resolve({ delivered: true, at: new Date().toISOString() }), 150);
    })) as never);
    const keep = h.guard.run('a', h.request('keep'));
    const drop = h.guard.run('a', { ...h.request('drop'), requestId: 'req-drop', params: { ...h.request('drop').params, threadKey: other } });
    await new Promise(resolve => setTimeout(resolve, 50));
    h.guard.revalidateLinks('a', h.links.filter(link => link.threadKey !== other));
    expect((await keep).ok).toBe(true);
    expect(await drop).toMatchObject({ ok: false, error: { code: 'denied', message: 'aborted' } });
    const reasons: unknown[] = [];
    h.execute.mockImplementation(((_action: unknown, signal: AbortSignal) => new Promise((_, reject) => signal.addEventListener('abort', () => { reasons.push(signal.reason); reject(new BridgeActionError('denied', 'x')); }, { once: true }))) as never);
    const held = h.guard.run('a', { ...h.request('drop-2'), requestId: 'req-drop-2', params: { ...h.request('drop-2').params, threadKey: other } });
    await new Promise(resolve => setTimeout(resolve, 50));
    h.guard.revalidateLinks('a', []); await held;
    expect(reasons).toEqual(['unlinked']);
    expect(abortedBeforeTyping({ aborted: true, reason: 'unlinked' } as AbortSignal)).toMatchObject({ code: 'denied', message: 'The session is not linked to the task you are working on.' });
  });

  it('never retries uncertain delivery, including after a guard restart', async () => {
    const h = await harness(); h.execute.mockRejectedValueOnce(new BridgeActionError('unknown_delivery', 'Delivery was not confirmed.'));
    expect(await h.guard.run('a', h.request())).toMatchObject({ ok: false, error: { code: 'unknown_delivery' } });
    const restarted = new BrowserActionGuard({ db: h.db, journal: h.journal, policy: () => h.policy, links: () => h.links, execute: h.execute });
    expect(await restarted.run('a', h.request())).toMatchObject({ ok: false, error: { code: 'unknown_delivery' } });
    expect(h.execute).toHaveBeenCalledTimes(1);
  });
});
