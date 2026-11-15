import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { freshDb, seed, thread } from './dock-helpers.js';
import { PaperclipBridge, buildInventoryPackets, commitOfBuildId, detectBrowserName, memoryBridgeStorage, type PaperclipBridgeDeps } from '../../src/core/paperclip/bridge.js';
import { buildSessionInventory } from '../../src/core/paperclip/bridge-query.js';
import { SessionObservationLedger } from '../../src/core/paperclip/observations.js';
import { memoryActionJournal } from '../../src/core/paperclip/actions.js';
import { BRIDGE_API_PATH, BRIDGE_PROTOCOL, type SessionObservations } from '../../src/core/paperclip/bridge-protocol.js';

const databases: ReturnType<typeof freshDb>[] = [];
afterEach(async () => { for (const db of databases.splice(0)) await db.delete(); });
async function harness(options: { observations?: SessionObservations; now?: () => number; onHint?: PaperclipBridgeDeps['onHint']; log?: (m: string) => void } = {}, hints: unknown[] = [], rejectKeys: Set<string> = new Set()) {
  const db = freshDb(); databases.push(db); const settings = await ensureStarterCollectionsAndSettings(db);
  settings.paperclip.serverUrl = 'http://127.0.0.1:3100';
  await db.settings.put(settings);
  const calls: Array<{ path: string; body: Record<string, unknown>; token: string }> = [];
  const token = 'a'.repeat(43); let shared = true; let offline = false;
  const fetcher: typeof fetch = async (input, init) => {
    if (offline) throw new TypeError('offline');
    const url = new URL(String(input)); const path = url.pathname.replace(`${BRIDGE_API_PATH}/`, '');
    const body = JSON.parse(String(init?.body)); const headers = new Headers(init?.headers);
    calls.push({ path, body, token: headers.get('X-Threadkeeper-Bridge-Token') ?? '' });
    let response: unknown = {};
    if (path === 'pair/start') response = { pairId: 'pair', code: 'ABCDEFGH', pollToken: 'poll-token', expiresAt: Date.now() + 600_000 };
    else if (path === 'pair/poll') response = { status: 'paired', bridgeToken: token, shared };
    else {
      expect(headers.get('X-Threadkeeper-Bridge-Token')).toBe(token);
      if (path === 'bridge/connect') response = { protocol: BRIDGE_PROTOCOL, pluginVersion: '0.1', pluginCommit: 'commit', shared, fingerprints: {}, policy: { enabled: false, providers: [], disabledAt: 0 }, links: [] };
      if (path === 'bridge/poll') response = { requests: [], hints: hints.splice(0), policy: { enabled: false, providers: [], disabledAt: 0 }, links: [] };
      if (path === 'bridge/inventory') response = { accepted: (body.upserts as Array<{ threadKey: string }>).map(r => r.threadKey).filter(k => !rejectKeys.has(k)), rejected: (body.upserts as Array<{ threadKey: string }>).filter(r => rejectKeys.has(r.threadKey)).map(r => ({ threadKey: r.threadKey, code: 'bad_request' })), automaticLinksAccepted: body.automaticLinks ?? [], automaticLinksRejected: [] };
      if (path === 'bridge/share') shared = body.shared;
      if (path === 'bridge/secret') response = { value: 'memory-only-secret' };
    }
    return new Response(JSON.stringify(response), { headers: { 'Content-Type': 'application/json' } });
  };
  const bridge = new PaperclipBridge({ db, settings: async () => settings, storage: memoryBridgeStorage(), actionJournal: memoryActionJournal(), extensionVersion: '0.5', extensionCommit: 'commit', fetch: fetcher, ...options });
  return { db, bridge, calls, settings, token, offline: (value: boolean) => { offline = value; } };
}

describe('paired bridge transport', () => {
  it('keeps credentials out of UI status and uses the separate token on every bridge call', async () => {
    const h = await harness();
    const pending = await h.bridge.pair('company'); expect(pending.companies.company.pending?.code).toBe('ABCDEFGH');
    await h.bridge.pollPair('company'); await h.bridge.tick();
    expect((await h.bridge.status()).companies.company.paired).toBe(true);
    expect(JSON.stringify(await h.bridge.status())).not.toContain(h.token);
    expect(h.calls.filter(c => c.path.startsWith('pair/')).every(c => c.token === '')).toBe(true);
    expect(h.calls.filter(c => c.path.startsWith('bridge/')).every(c => c.token === h.token)).toBe(true);
  });
  it('sends only changed fingerprints and removes newly private sessions', async () => {
    const h = await harness(); const key = await seed(h.db, thread('visible', 'Visible', [['user', 'hi']]));
    await h.bridge.pair('company'); await h.bridge.pollPair('company'); await h.bridge.tick();
    expect(h.calls.filter(c => c.path === 'bridge/inventory')).toHaveLength(1);
    await h.bridge.tick(); expect(h.calls.filter(c => c.path === 'bridge/inventory')).toHaveLength(1);
    await h.db.conversations.update(key, { cloudExcluded: true }); await h.bridge.tick();
    expect(h.calls.filter(c => c.path === 'bridge/inventory').at(-1)?.body.removes).toEqual([key]);
    expect((await h.bridge.status()).companies.company.sessionCount).toBe(0);
  });
  it('drops pairing on server changes before transmitting its token to the new origin', async () => {
    const h = await harness(); await h.bridge.pair('company'); await h.bridge.pollPair('company');
    h.settings.paperclip.serverUrl = 'http://127.0.0.1:3200';
    await h.bridge.tick();
    expect(h.calls.filter(c => c.path === 'bridge/connect')).toHaveLength(0);
    expect(await h.bridge.getToken('company')).toBeNull();
  });
  it('does not cache secret values in durable state', async () => {
    const h = await harness(); await h.bridge.pair('company'); await h.bridge.pollPair('company');
    expect(await h.bridge.resolveSecret('company', 'voyageApiKey')).toBe('memory-only-secret');
    expect(JSON.stringify(await h.bridge.status())).not.toContain('memory-only-secret');
  });
  it('refuses secret reads over plain http to a non-loopback server before any request (REQ-14 F-1)', async () => {
    const h = await harness(); h.settings.paperclip.serverUrl = 'http://10.0.0.5:3100';
    await h.bridge.pair('company'); await h.bridge.pollPair('company');
    await expect(h.bridge.resolveSecret('company', 'voyageApiKey')).rejects.toThrow(/https|this computer/i);
    expect(h.calls.filter(c => c.path === 'bridge/secret')).toHaveLength(0);
  });
  it('does not hold the bridge tick on a slow hint sync, so the next poll is not delayed (REQ-12 F-4)', async () => {
    const hint = { type: 'paperclip.changed', companyId: 'company', issueIds: ['issue-1'], runIds: [] };
    const onHint = vi.fn(() => new Promise<void>(() => undefined));
    const h = await harness({ onHint }, [hint]);
    await h.bridge.pair('company'); await h.bridge.pollPair('company');
    const settled = await Promise.race([h.bridge.tick().then(() => 'done'), new Promise(resolve => setTimeout(() => resolve('held'), 1500))]);
    expect(settled).toBe('done');
    expect(onHint).toHaveBeenCalledTimes(1);
    await h.bridge.tick();
    expect(h.calls.filter(c => c.path === 'bridge/poll')).toHaveLength(2);
    expect((await h.bridge.status()).companies.company.connected).toBe(true);
  });
  it('keeps the bridge connected when a hint sync fails (REQ-12 F-3)', async () => {
    const hint = { type: 'paperclip.changed', companyId: 'company', issueIds: ['gone'], runIds: [] };
    const logs: string[] = [];
    const h = await harness({ onHint: async () => { throw new Error('not_found'); }, log: m => logs.push(m) }, [hint]);
    await h.bridge.pair('company'); await h.bridge.pollPair('company');
    await h.bridge.tick(); await new Promise(resolve => setTimeout(resolve, 0));
    const company = (await h.bridge.status()).companies.company;
    expect(company.connected).toBe(true);
    expect(company.lastError).toBe('');
    expect(logs.some(m => /disconnected/.test(m))).toBe(false);
    await h.bridge.tick();
    expect(h.calls.filter(c => c.path === 'bridge/connect')).toHaveLength(1);
  });
  it('sends only the commit part of the build id and names Edge or Chrome (REQ-7 finding 3, AC-1)', async () => {
    expect(commitOfBuildId('20261114.120000-abc1234')).toBe('abc1234');
    expect(commitOfBuildId('abc1234')).toBe('abc1234');
    expect(commitOfBuildId('20261114.120000-nogit')).toBe('');
    const edge = { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0', userAgentData: { brands: [{ brand: 'Microsoft Edge', version: '130' }, { brand: 'Chromium', version: '130' }] } };
    const chrome = { userAgent: 'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/130.0 Safari/537.36', userAgentData: { brands: [{ brand: 'Google Chrome', version: '130' }, { brand: 'Chromium', version: '130' }] } };
    expect(detectBrowserName(edge)).toBe('Microsoft Edge');
    expect(detectBrowserName({ userAgent: edge.userAgent })).toBe('Microsoft Edge');
    expect(detectBrowserName(chrome)).toBe('Google Chrome');
    expect(detectBrowserName({ userAgent: 'something else' })).toBe('Chromium');
    const db = freshDb(); databases.push(db); const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip.serverUrl = 'http://127.0.0.1:3100';
    const bodies: Array<Record<string, unknown>> = [];
    const bridge = new PaperclipBridge({ db, settings: async () => settings, storage: memoryBridgeStorage(), actionJournal: memoryActionJournal(), extensionVersion: '0.5', extensionCommit: '20261114.120000-abc1234', browser: 'Microsoft Edge',
      fetch: async (_input, init) => { const body = JSON.parse(String(init?.body)); bodies.push(body); return new Response(JSON.stringify({ pairId: 'p', code: 'ABCDEFGH', pollToken: 't', expiresAt: Date.now() + 60_000 })); } });
    await bridge.pair('company');
    expect(bodies[0]).toMatchObject({ extensionCommit: 'abc1234', browser: 'Microsoft Edge' });
  });
  it('does not resend a row Paperclip rejected until that row changes (REQ-7 finding 6)', async () => {
    const logs: string[] = [];
    const db0 = { log: (m: string) => logs.push(m) };
    const rejected = new Set<string>();
    const h = await harness(db0, [], rejected);
    const bad = await seed(h.db, thread('bad', 'Rejected row', [['user', 'hi']]));
    rejected.add(bad);
    await h.bridge.pair('company'); await h.bridge.pollPair('company'); await h.bridge.tick();
    const sent = () => h.calls.filter(c => c.path === 'bridge/inventory').flatMap(c => (c.body.upserts as Array<{ threadKey: string }>).map(r => r.threadKey)).filter(k => k === bad).length;
    expect(sent()).toBe(1);
    await h.bridge.tick(); await h.bridge.tick();
    expect(sent()).toBe(1);
    expect(logs.filter(m => m.includes('rejected session'))).toHaveLength(1);
    await h.db.conversations.update(bad, { title: 'Rejected row, edited', sourceRevision: 2 });
    await h.bridge.tick();
    expect(sent()).toBe(2);
  });
  it('surfaces a disabled or failed plugin error instead of a generic failure, keeping the pairing (REQ-7 FR-9)', async () => {
    const db = freshDb(); databases.push(db); const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip.serverUrl = 'http://127.0.0.1:3100';
    const bridge = new PaperclipBridge({ db, settings: async () => settings, storage: memoryBridgeStorage({ serverUrl: 'http://127.0.0.1:3100', companies: { company: { token: 'a'.repeat(43), shared: true } } } as never), actionJournal: memoryActionJournal(), extensionVersion: '0.5', extensionCommit: 'x',
      fetch: async () => new Response(JSON.stringify({ error: 'Plugin not found' }), { status: 404 }) });
    await bridge.tick();
    const company = (await bridge.status()).companies.company;
    expect(company.lastError).toContain('Plugin not found');
    expect(company.paired).toBe(true);
  });
  it('treats a 403 bad-token answer from bridge/secret as not paired, and consent-off as denied (plugin follow-up 5)', async () => {
    const db = freshDb(); databases.push(db); const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip.serverUrl = 'http://127.0.0.1:3100';
    let message = 'Only the paired extension can read model keys.';
    const bridge = new PaperclipBridge({ db, settings: async () => settings, storage: memoryBridgeStorage({ serverUrl: 'http://127.0.0.1:3100', companies: { company: { token: 'a'.repeat(43), shared: true } } } as never), actionJournal: memoryActionJournal(), extensionVersion: '0.5', extensionCommit: 'x',
      fetch: async () => new Response(JSON.stringify({ error: { code: 'denied', message } }), { status: 403 }) });
    await expect(bridge.resolveSecret('company', 'voyageApiKey')).rejects.toMatchObject({ code: 'not_paired' });
    message = 'Secret transfer to the paired extension is turned off.';
    await expect(bridge.resolveSecret('company', 'voyageApiKey')).rejects.toMatchObject({ code: 'denied' });
  });
  it('signals offline to every paired company with keepalive, ignoring 404 and network errors (NF-3)', async () => {
    const db = freshDb(); databases.push(db); const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip.serverUrl = 'http://127.0.0.1:3100';
    const seen: Array<{ path: string; body: unknown; token: string | null; keepalive?: boolean }> = [];
    const bridge = new PaperclipBridge({ db, settings: async () => settings, actionJournal: memoryActionJournal(), extensionVersion: '0.5', extensionCommit: 'x',
      storage: memoryBridgeStorage({ serverUrl: 'http://127.0.0.1:3100', companies: { a: { token: 'a'.repeat(43), shared: true }, b: { token: 'b'.repeat(43), shared: false }, gone: { token: 'c'.repeat(43), revoked: true }, unpaired: {} } } as never),
      fetch: async (input, init) => {
        seen.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)), token: new Headers(init?.headers).get('X-Threadkeeper-Bridge-Token'), keepalive: init?.keepalive });
        if (seen.length === 1) return new Response(JSON.stringify({ error: 'Plugin API route not found.' }), { status: 404 });
        throw new TypeError('network');
      } });
    await expect(bridge.signalOffline()).resolves.toBeUndefined();
    expect(seen.map(c => c.path)).toEqual([`${BRIDGE_API_PATH}/bridge/offline`, `${BRIDGE_API_PATH}/bridge/offline`]);
    expect(seen.map(c => c.body)).toEqual([{ companyId: 'a' }, { companyId: 'b' }]);
    expect(seen.map(c => c.token)).toEqual(['a'.repeat(43), 'b'.repeat(43)]);
    expect(seen.every(c => c.keepalive === true)).toBe(true);
    expect((await bridge.status()).companies.a.paired).toBe(true);
  });
  it('announces cancel-requests on connect and cancels only the requests Paperclip lists (plugin round 2 c)', async () => {
    const db = freshDb(); databases.push(db); const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip.serverUrl = 'http://127.0.0.1:3100';
    const bodies: Record<string, Record<string, unknown>> = {};
    const bridge = new PaperclipBridge({ db, settings: async () => settings, actionJournal: memoryActionJournal(), extensionVersion: '0.5', extensionCommit: 'x',
      storage: memoryBridgeStorage({ serverUrl: 'http://127.0.0.1:3100', companies: { company: { token: 'a'.repeat(43), shared: false } } } as never),
      fetch: async (input, init) => {
        const path = new URL(String(input)).pathname.replace(`${BRIDGE_API_PATH}/`, ''); bodies[path] = JSON.parse(String(init?.body));
        const response = path === 'bridge/connect' ? { protocol: BRIDGE_PROTOCOL, shared: false } : path === 'bridge/poll' ? { requests: [], hints: [], cancelledRequestIds: ['req-9', 7] } : {};
        return new Response(JSON.stringify(response));
      } });
    const cancelled: string[][] = [];
    (bridge as unknown as { actions: { cancelRequests: (ids: string[]) => void } }).actions.cancelRequests = ids => { cancelled.push(ids); };
    await bridge.tick();
    expect(bodies['bridge/connect'].capabilities).toEqual(['cancel-requests']);
    expect(cancelled).toEqual([['req-9']]);
  });
  it('revalidates pending actions against the new links instead of cancelling every action (F-3)', async () => {
    const db = freshDb(); databases.push(db); const settings = await ensureStarterCollectionsAndSettings(db);
    settings.paperclip.serverUrl = 'http://127.0.0.1:3100';
    const link = { id: 'l1', companyId: 'company', issueId: 'task', threadKey: 'thread', origin: 'user', creator: 'founder', createdAt: '2026-11-14T00:00:00.000Z' };
    const bridge = new PaperclipBridge({ db, settings: async () => settings, actionJournal: memoryActionJournal(), extensionVersion: '0.5', extensionCommit: 'x',
      storage: memoryBridgeStorage({ serverUrl: 'http://127.0.0.1:3100', companies: { company: { token: 'a'.repeat(43), shared: false, links: [link] } } } as never),
      fetch: async (input) => {
        const path = new URL(String(input)).pathname.replace(`${BRIDGE_API_PATH}/`, '');
        const response = path === 'bridge/connect' ? { protocol: BRIDGE_PROTOCOL, shared: false, links: [link] } : path === 'bridge/poll' ? { requests: [], hints: [], links: [] } : {};
        return new Response(JSON.stringify(response));
      } });
    const actions = (bridge as unknown as { actions: { revalidateLinks: (id: string, links: unknown[]) => void; cancelPending: () => void } }).actions;
    const revalidated: unknown[][] = []; let cancelledAll = 0;
    actions.revalidateLinks = (_id, links) => { revalidated.push(links); };
    actions.cancelPending = () => { cancelledAll++; };
    await bridge.tick();
    expect(revalidated).toEqual([[]]);
    expect(cancelledAll).toBe(0);
  });
  it('revokes sharing locally while offline and does not accept a stale remote grant on reconnect', async () => {
    const h = await harness(); await h.bridge.pair('company'); await h.bridge.pollPair('company'); await h.bridge.tick();
    h.offline(true);
    await expect(h.bridge.share('company', false)).rejects.toThrow('offline');
    expect((await h.bridge.status()).companies.company.shared).toBe(false);
    h.offline(false); await h.bridge.tick();
    expect((await h.bridge.status()).companies.company.shared).toBe(false);
    expect(h.calls.filter(c => c.path === 'bridge/share').at(-1)?.body.shared).toBe(false);
  });
  it('disconnects immediately offline and retries remote revocation without exposing the token', async () => {
    const h = await harness(); await h.bridge.pair('company'); await h.bridge.pollPair('company');
    h.offline(true); const status = await h.bridge.disconnect('company');
    expect(status.companies.company).toMatchObject({ paired: false, shared: false, pendingDisconnect: true });
    expect(await h.bridge.getToken('company')).toBeNull(); expect(JSON.stringify(status)).not.toContain(h.token);
    h.offline(false); await h.bridge.tick(); expect((await h.bridge.status()).companies.company).toBeUndefined();
    expect(h.calls.filter(c => c.path === 'bridge/disconnect')).toHaveLength(1);
  });
  it('projects stored automatic task links in company-scoped inventory without sending task content', async () => {
    const h = await harness();
    const key = await seed(h.db, thread('code', 'Code', [['user', 'coding']], { provider: 'claude_code', canonicalUrl: 'https://claude.ai/code/session_code' }));
    await seed(h.db, thread('task', 'PRIVATE TASK TITLE', [['user', 'PRIVATE TASK CONTENT']], { provider: 'paperclip', paperclipCompanyId: 'company', canonicalUrl: 'http://127.0.0.1:3100/C/issues/C-1', linkedThreadKeys: [key] }));
    await seed(h.db, thread('other-task', 'OTHER COMPANY', [['user', 'other']], { provider: 'paperclip', paperclipCompanyId: 'other', canonicalUrl: 'http://127.0.0.1:3100/C/issues/C-2', linkedThreadKeys: [key] }));
    await h.bridge.pair('company'); await h.bridge.pollPair('company'); await h.bridge.tick();
    const inventory = h.calls.filter(c => c.path === 'bridge/inventory');
    expect(inventory.flatMap(c => c.body.automaticLinks)).toEqual([{ issueId: 'task', threadKey: key }]);
    expect(JSON.stringify(inventory)).not.toContain('PRIVATE TASK'); expect(JSON.stringify(inventory)).not.toContain('other-task');
    await h.bridge.tick(); expect(h.calls.filter(c => c.path === 'bridge/inventory')).toHaveLength(inventory.length);
  });
  it('uses live observations and emits a settled transition once for each granted company', async () => {
    let now = Date.now(); const observations = new SessionObservationLedger({ now: () => now });
    const h = await harness({ observations, now: () => now });
    const key = await seed(h.db, thread('state', 'State', [['user', 'coding']], { provider: 'claude_code', agentState: 'running' }));
    observations.observe({ tabId: 1, frameId: 2, threadKey: key, state: 'running' });
    for (const company of ['a', 'b']) { await h.bridge.pair(company); await h.bridge.pollPair(company); }
    await h.bridge.tick();
    expect(h.calls.filter(c => c.path === 'bridge/inventory').every(c => (c.body.upserts as Array<{ observed: boolean }>)[0].observed)).toBe(true);
    now++; observations.observe({ tabId: 1, frameId: 2, threadKey: key, state: 'waiting_permission' });
    now += 4999; await h.bridge.tick();
    expect(h.calls.filter(c => c.path === 'bridge/inventory').flatMap(c => c.body.events)).toEqual([]);
    now++; await h.bridge.tick();
    const eventCalls = h.calls.filter(c => c.path === 'bridge/inventory' && (c.body.events as unknown[]).length);
    expect(eventCalls.map(c => c.body.companyId).sort()).toEqual(['a', 'b']);
    expect(eventCalls[0].body.events).toMatchObject([{ threadKey: key, from: 'running', to: 'waiting_permission', observed: true }]);
    await h.bridge.tick(); expect(h.calls.filter(c => c.path === 'bridge/inventory' && (c.body.events as unknown[]).length)).toHaveLength(2);
    observations.forgetTab(1); await h.bridge.tick();
    expect((h.calls.filter(c => c.path === 'bridge/inventory').at(-1)?.body.upserts as Array<{ observed: boolean }>)[0].observed).toBe(false);
  });
  it('keeps UTF-8 rows, removals and automatic links within the shared four-megabyte wire budget', async () => {
    const h = await harness(); await seed(h.db, thread('sized', 'Sized', [['user', 'test']]));
    const [row] = await buildSessionInventory(h.db);
    const packets = buildInventoryPackets('company', Array.from({ length: 80 }, (_, i) => ({ ...row, threadKey: `key-${i}`, title: '💡'.repeat(14_000) })), Array.from({ length: 2000 }, (_, i) => `${i}${'尾'.repeat(200)}`), [], Array.from({ length: 120 }, (_, i) => ({ issueId: `issue-${i}`, threadKey: `key-${i}` })));
    expect(packets.length).toBeGreaterThan(1);
    expect(packets.every(packet => new TextEncoder().encode(JSON.stringify(packet)).byteLength <= 4 * 1024 * 1024 && packet.automaticLinks.length <= 50)).toBe(true);
    expect(packets.flatMap(p => p.upserts)).toHaveLength(80); expect(packets.flatMap(p => p.removes)).toHaveLength(2000); expect(packets.flatMap(p => p.automaticLinks)).toHaveLength(120);
  });
  it('splits short removals at the receiver count limit even when bytes would fit', () => {
    const removes = Array.from({ length: 20_001 }, (_, i) => `k${i}`);
    const packets = buildInventoryPackets('company', [], removes, [], []);
    expect(packets.map(packet => packet.removes.length)).toEqual([10_000, 10_000, 1]);
    expect(packets.flatMap(packet => packet.removes)).toEqual(removes);
  });
  it('splits short upserts at the receiver count limit even when bytes would fit', () => {
    const row = { threadKey: 'k', fingerprint: 'f', title: 't', provider: 'codex', providerLabel: 'Codex', hash: 'h', gist: '', category: 'coding_agent', agentLabel: '', kind: '', kindLabel: '', project: '', workflowState: 'active', createdAt: null, updatedAt: null, messageCount: 0, url: '', model: '', workspacePath: '', branchId: '', siblingThreadKeys: [], analysisVersion: 0, accountId: '', accountLabel: '', sessionGroup: '', agentState: 'unknown', agentStateAt: null, repository: '', pullRequestUrl: '', pinned: false, observed: false } as const;
    const upserts = Array.from({ length: 6001 }, (_, i) => ({ ...row, siblingThreadKeys: [], threadKey: `k${i}` }));
    expect(new TextEncoder().encode(JSON.stringify(upserts)).byteLength).toBeLessThan(4 * 1024 * 1024);
    const packets = buildInventoryPackets('company', upserts, [], [], []);
    expect(packets.map(packet => packet.upserts.length)).toEqual([5000, 1001]);
    expect(packets.flatMap(packet => packet.upserts)).toEqual(upserts);
  });
});
