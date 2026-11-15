import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { memoryActionJournal } from '../../src/core/paperclip/actions.js';
import { memoryBridgeStorage } from '../../src/core/paperclip/bridge.js';
import { BRIDGE_KEEPALIVE_ALARM, createManagerActionExecutor, createPaperclipIntegrationRuntime, focusWorkspaceTab } from '../../src/core/paperclip/integration-runtime.js';
import { freshDb } from './dock-helpers.js';
import { embedTexts, remoteSpace } from '../../src/core/embeddings.js';
import { configureModelCredentialResolver, resolveModelSettings } from '../../src/core/paperclip/credentials.js';

const databases: ReturnType<typeof freshDb>[] = [];
afterEach(async () => { vi.useRealTimers(); for (const db of databases.splice(0)) await db.delete(); });

it.each(['pair', 'pair_poll'])('does not abort in-flight %s when concurrent status sees no paired companies, and stays idle afterward', async action => {
  const db = freshDb(); databases.push(db);
  const settings = await ensureStarterCollectionsAndSettings(db); settings.paperclip.serverUrl = 'http://127.0.0.1:3100'; settings.paperclip.hostEnabled = true; await db.settings.put(settings);
  let complete!: () => void; let requestSignal: AbortSignal | null | undefined;
  let observed!: () => void; const started = new Promise<void>(resolve => { observed = resolve; });
  const initial = action === 'pair_poll' ? { companies: { company: { pending: { pairId: 'pair', code: 'ABCDEFGH', pollToken: 'fixture-poll-token', expiresAt: Date.now() + 600_000 } } } } : {};
  let requestCount = 0;
  const runtime = createPaperclipIntegrationRuntime({ db, storage: memoryBridgeStorage(initial as never), actionJournal: memoryActionJournal(), extensionVersion: 'fixture', extensionCommit: 'fixture', fetch: async (_url, init) => {
    requestCount++;
    requestSignal = init?.signal; observed();
    return new Promise<Response>((resolve, reject) => {
      const aborted = () => reject(new DOMException('signal is aborted without reason', 'AbortError'));
      requestSignal?.addEventListener('abort', aborted, { once: true });
      complete = () => { requestSignal?.removeEventListener('abort', aborted); resolve(new Response(JSON.stringify(action === 'pair_poll' ? { status: 'pending' } : { pairId: 'pair', code: 'ABCDEFGH', pollToken: 'fixture-poll-token', expiresAt: Date.now() + 600_000 }))); };
    });
  } });
  const pairing = runtime.handle({ type: 'PAPERCLIP_INTEGRATION', action, payload: { companyId: 'company' } });
  // Retain a rejection handler so the failure remains this assertion rather
  // than an unhandled rejection while reproducing the old lifecycle race.
  void pairing.catch(() => undefined);
  await started;
  await runtime.handle({ type: 'PAPERCLIP_INTEGRATION', action: 'status' });
  expect(requestSignal?.aborted).toBe(false);
  complete();
  expect(await pairing).toMatchObject({ ok: true, data: { companies: { company: { pending: { code: 'ABCDEFGH' } } } } });
  vi.useFakeTimers(); await vi.advanceTimersByTimeAsync(60_000);
  expect(requestCount).toBe(1);
  runtime.bridge.stop();
});

it('worker reuses a linked key briefly so 40 embeddings in a minute stay under 30 reads, honours switch-off at once and shows rotation within 60 s (REQ-14 F-9)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const db = freshDb(); databases.push(db);
  const settings = await ensureStarterCollectionsAndSettings(db);
  settings.paperclip.serverUrl = 'http://127.0.0.1:3100'; settings.embeddingProvider = 'voyage'; settings.voyageApiKey = '';
  settings.paperclipCredentials = { companyId: 'company-a', linkedKeys: ['voyageApiKey'], allowSecretTransfer: true };
  await db.settings.put(settings);
  let secret = 'first-secret'; let secretReads = 0;
  const runtime = createPaperclipIntegrationRuntime({ db, storage: memoryBridgeStorage({ serverUrl: 'http://127.0.0.1:3100', companies: { 'company-a': { token: 'a'.repeat(43), shared: true } } } as never), actionJournal: memoryActionJournal(), extensionVersion: 'fixture', extensionCommit: 'fixture',
    fetch: async (url) => { if (String(url).endsWith('/bridge/secret')) { secretReads++; return new Response(JSON.stringify({ value: secret })); } return new Response('{}'); } });
  const embedFetch = vi.fn(async () => new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.2, 0.7] }] }))) as unknown as typeof globalThis.fetch;
  for (let i = 0; i < 40; i++) { await embedTexts(settings, remoteSpace(settings)!, [`doc ${i}`], 'document', embedFetch); vi.advanceTimersByTime(1000); }
  expect(secretReads).toBeLessThanOrEqual(30);
  expect(secretReads).toBeGreaterThan(0);
  // Switch-off in the database wins over a stale caller snapshot and over the cache.
  await db.settings.update('default', { paperclipCredentials: { ...settings.paperclipCredentials, allowSecretTransfer: false } });
  const readsBefore = secretReads;
  await expect(resolveModelSettings(settings, 'embeddings', ['voyageApiKey'])).rejects.toThrow('turned off');
  expect(secretReads).toBe(readsBefore);
  await db.settings.update('default', { paperclipCredentials: settings.paperclipCredentials });
  secret = 'rotated-secret'; vi.advanceTimersByTime(60_000);
  expect((await resolveModelSettings(settings, 'embeddings', ['voyageApiKey'])).voyageApiKey).toBe('rotated-secret');
  expect(JSON.stringify(await db.settings.get('default'))).not.toContain('secret"');
  expect(JSON.stringify(await runtime.bridge.status())).not.toContain('rotated-secret');
  runtime.bridge.stop(); configureModelCredentialResolver(null);
});

it('keeps a dedicated bridge alarm while any company is paired, even with library sync off, and restarts the bridge from it (REQ-7 finding 5)', async () => {
  const db = freshDb(); databases.push(db);
  const settings = await ensureStarterCollectionsAndSettings(db); settings.paperclip.serverUrl = 'http://127.0.0.1:3100'; settings.paperclip.enabled = false; await db.settings.put(settings);
  const alarms = new Map<string, { periodInMinutes?: number }>();
  const fakeAlarms = { get: async (name: string) => alarms.get(name), create: async (name: string, info: { periodInMinutes?: number }) => { alarms.set(name, info); }, clear: async (name: string) => alarms.delete(name) };
  const paths: string[] = [];
  const storage = memoryBridgeStorage({ serverUrl: 'http://127.0.0.1:3100', companies: { company: { token: 'a'.repeat(43), shared: false } } } as never);
  const runtime = createPaperclipIntegrationRuntime({ db, storage, actionJournal: memoryActionJournal(), extensionVersion: 'fixture', extensionCommit: 'fixture', alarms: fakeAlarms,
    fetch: async (url) => { paths.push(new URL(String(url)).pathname); return new Response(JSON.stringify({ protocol: 'paperclip-threadkeeper/1', shared: false, requests: [], hints: [] })); } });
  expect(await runtime.keepAlive()).toBe(true);
  expect(alarms.get(BRIDGE_KEEPALIVE_ALARM)).toEqual({ periodInMinutes: 0.5 });
  await vi.waitFor(() => expect(paths.some(p => p.endsWith('/bridge/connect'))).toBe(true));
  runtime.bridge.stop();
  await storage.write({ serverUrl: 'http://127.0.0.1:3100', companies: {} } as never);
  const idle = createPaperclipIntegrationRuntime({ db, storage, actionJournal: memoryActionJournal(), extensionVersion: 'fixture', extensionCommit: 'fixture', alarms: fakeAlarms, fetch: async () => new Response('{}') });
  expect(await idle.keepAlive()).toBe(false);
  expect(alarms.has(BRIDGE_KEEPALIVE_ALARM)).toBe(false);
});

it('brings the window of an existing workspace tab forward when a session is opened from Paperclip (REQ-13 finding 7)', async () => {
  const calls: string[] = [];
  const api = {
    tabs: { update: async (tabId: number, info: { active?: boolean }) => { calls.push(`tab ${tabId} ${JSON.stringify(info)}`); return { id: tabId, windowId: 42 }; } },
    windows: { update: async (windowId: number, info: { focused?: boolean }) => { calls.push(`window ${windowId} ${JSON.stringify(info)}`); return {}; } },
  };
  await focusWorkspaceTab(api, 7);
  expect(calls).toEqual(['tab 7 {"active":true}', 'window 42 {"focused":true}']);
});

it('drops a cached model key as soon as bridge/poll fails (REQ-14 NF-8)', async () => {
  const db = freshDb(); databases.push(db);
  const settings = await ensureStarterCollectionsAndSettings(db);
  settings.paperclip.serverUrl = 'http://127.0.0.1:3100'; settings.embeddingProvider = 'voyage'; settings.voyageApiKey = '';
  settings.paperclipCredentials = { companyId: 'company-a', linkedKeys: ['voyageApiKey'], allowSecretTransfer: true };
  await db.settings.put(settings);
  let secretReads = 0;
  const runtime = createPaperclipIntegrationRuntime({ db, storage: memoryBridgeStorage({ serverUrl: 'http://127.0.0.1:3100', companies: { 'company-a': { token: 'a'.repeat(43), shared: false } } } as never), actionJournal: memoryActionJournal(), extensionVersion: 'fixture', extensionCommit: 'fixture',
    fetch: async (url) => {
      const path = new URL(String(url)).pathname;
      if (path.endsWith('/bridge/secret')) { secretReads++; return new Response(JSON.stringify({ value: 'cached-value' })); }
      if (path.endsWith('/bridge/connect')) return new Response(JSON.stringify({ protocol: 'paperclip-threadkeeper/1', shared: false }));
      if (path.endsWith('/bridge/poll')) return new Response(JSON.stringify({ error: { code: 'internal', message: 'down' } }), { status: 500 });
      return new Response('{}');
    } });
  await resolveModelSettings(settings, 'embeddings', ['voyageApiKey']);
  await resolveModelSettings(settings, 'embeddings', ['voyageApiKey']);
  expect(secretReads).toBe(1);
  await runtime.bridge.tick();
  await resolveModelSettings(settings, 'embeddings', ['voyageApiKey']);
  expect(secretReads).toBe(2);
  runtime.bridge.stop(); configureModelCredentialResolver(null);
});

describe('worker → manager action verdicts (REQ-11 AC-8, FR-1, NF-2)', () => {
  const action = { type: 'session.send', companyId: 'c', agentId: 'a', issueId: 'i', clientRequestId: 'k', requestId: 'req', createdAt: Date.now(), deadlineAt: Date.now() + 30_000, policyDisabledAt: 0, provider: 'claude', accountId: 'acct', threadKey: 't', url: 'https://claude.ai/chat/x', text: 'hello' } as const;
  it('on a switch-off abort, waits for the manager and returns its disabled verdict', async () => {
    let answer!: (value: unknown) => void;
    const cancels: unknown[] = [];
    const execute = createManagerActionExecutor({ ready: async () => undefined, tabId: () => 7, verdictWaitMs: 2_000,
      sendExecute: () => new Promise(resolve => { answer = resolve; }), sendCancel: async (_tab, requestId, reason) => { cancels.push({ requestId, reason }); setTimeout(() => answer({ ok: false, code: 'disabled', error: 'Agent actions are turned off.' }), 30); } });
    const controller = new AbortController();
    const run = execute(action as never, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 0)); // the action reached the manager
    controller.abort('disabled');
    await expect(run).rejects.toMatchObject({ code: 'disabled', message: 'Agent actions are turned off.' });
    expect(cancels).toEqual([{ requestId: 'req', reason: 'disabled' }]);
  });
  it('answers the contract unknown_delivery text only when the manager gives no verdict in time', async () => {
    const execute = createManagerActionExecutor({ ready: async () => undefined, tabId: () => 7, verdictWaitMs: 50, sendExecute: () => new Promise(() => undefined), sendCancel: async () => undefined });
    const controller = new AbortController();
    const run = execute(action as never, controller.signal);
    await new Promise(resolve => setTimeout(resolve, 0)); // the action reached the manager
    controller.abort('timeout');
    await expect(run).rejects.toMatchObject({ code: 'unknown_delivery', message: 'The message may or may not have been sent. Read the session before trying again.' });
  });
});
