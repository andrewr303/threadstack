import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gunzipSync, strFromU8 } from 'fflate';
import { writeBackup } from '../../src/core/backup.js';
import { ThreadkeeperDB, ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { normalizeSettings } from '../../src/core/schema.js';
import { embedTexts, remoteSpace } from '../../src/core/embeddings.js';
import { requestQueryEmbedding } from '../../src/core/cloud-client.js';
import {
  configureModelCredentialResolver, credentialPresent, moveModelKeys, resolveModelSettings,
  handleCredentialCommand, createCredentialBackend, createSecretReadCache,
  type CredentialBackend, type PaperclipCredentialSettings,
} from '../../src/core/paperclip/credentials.js';

function settings(keys = ['voyageApiKey'], consent = true) {
  return { ...normalizeSettings(null), embeddingProvider: 'voyage' as const, voyageApiKey: '',
    paperclipCredentials: { companyId: 'company-a', linkedKeys: keys, allowSecretTransfer: consent } satisfies PaperclipCredentialSettings };
}
afterEach(() => configureModelCredentialResolver(null));

describe('Paperclip model credentials', () => {
  it('resolves a fresh in-memory copy and sees rotation on the next operation', async () => {
    const original = settings();
    const resolve = vi.fn().mockResolvedValueOnce('first-secret').mockResolvedValueOnce('rotated-secret');
    configureModelCredentialResolver(resolve);
    expect((await resolveModelSettings(original, 'embeddings', ['voyageApiKey'])).voyageApiKey).toBe('first-secret');
    expect((await resolveModelSettings(original, 'embeddings', ['voyageApiKey'])).voyageApiKey).toBe('rotated-secret');
    expect(original.voyageApiKey).toBe('');
    expect(resolve).toHaveBeenCalledWith('company-a', 'voyageApiKey', original);
  });

  it('a read in flight when the cache is cleared does not store its value afterwards (F-5)', async () => {
    let release!: (value: string) => void; let reads = 0;
    const cache = createSecretReadCache(() => { reads++; return reads === 1 ? new Promise<string>(resolve => { release = resolve; }) : Promise.resolve('fresh'); });
    const inFlight = cache.read('company-a', 'voyageApiKey');
    cache.clear();
    release('stale-before-clear');
    expect(await inFlight).toBe('stale-before-clear');
    expect(await cache.read('company-a', 'voyageApiKey')).toBe('fresh');
    expect(reads).toBe(2);
  });

  it('requires consent even when a stale local value exists and never falls back to it', async () => {
    const original = { ...settings(['voyageApiKey'], false), voyageApiKey: 'stale' };
    const resolve = vi.fn(); configureModelCredentialResolver(resolve);
    await expect(resolveModelSettings(original, 'embeddings', ['voyageApiKey'])).rejects.toThrow('paused');
    expect(resolve).not.toHaveBeenCalled();
    expect(credentialPresent(original, 'voyageApiKey')).toBe(false);
  });

  it('pauses a remote call when the bridge is down but local embeddings still work', async () => {
    const original = settings();
    configureModelCredentialResolver(async () => { throw new Error('offline'); });
    const fetch = vi.fn();
    await expect(embedTexts(original, remoteSpace(original)!, ['hello'], 'query', fetch)).rejects.toThrow('Paperclip is not running, so embeddings is paused.');
    expect(fetch).not.toHaveBeenCalled();
    const local = { id: 'local:hash-v1:384', provider: 'local' as const, model: 'hash-v1', relatedThreshold: 0.3 };
    expect((await embedTexts(original, local, ['hello'], 'query', fetch))[0]).toHaveLength(384);
  });

  it('tells a missing secret and turned-off transfer apart from Paperclip not running (REQ-14 F-11)', async () => {
    const coded = (code: string) => Object.assign(new Error(code), { code });
    configureModelCredentialResolver(async () => { throw coded('not_found'); });
    const missing = await resolveModelSettings(settings(), 'embeddings', ['voyageApiKey']).catch((e) => e);
    expect(missing.reason).toBe('missing');
    expect(missing.message).toContain('missing');
    expect(missing.message).not.toContain('not running');
    configureModelCredentialResolver(async () => { throw coded('denied'); });
    const off = await resolveModelSettings(settings(), 'embeddings', ['voyageApiKey']).catch((e) => e);
    expect(off.reason).toBe('disabled');
    expect(off.message).not.toContain('not running');
    configureModelCredentialResolver(async () => { throw coded('not_paired'); });
    const unpaired = await resolveModelSettings(settings(), 'embeddings', ['voyageApiKey']).catch((e) => e);
    expect(unpaired.reason).toBe('not_paired');
    expect(unpaired.message).toBe('Threadkeeper is not paired with Paperclip, so embeddings is paused.');
    configureModelCredentialResolver(async () => { throw new TypeError('Failed to fetch'); });
    const down = await resolveModelSettings(settings(), 'embeddings', ['voyageApiKey']).catch((e) => e);
    expect(down.reason).toBe('unavailable');
    expect(down.message).toBe('Paperclip is not running, so embeddings is paused.');
  });

  it('uses the linked value through the real embedding entry point without storing it', async () => {
    const original = settings(); configureModelCredentialResolver(async () => 'only-in-memory');
    const fetch = vi.fn(async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer only-in-memory');
      return new Response(JSON.stringify({ data: [{ index: 0, embedding: [0.2, 0.7] }] }));
    }) as unknown as typeof globalThis.fetch;
    await embedTexts(original, remoteSpace(original)!, ['hello'], 'query', fetch);
    expect(original.voyageApiKey).toBe('');
    expect(JSON.stringify(original)).not.toContain('only-in-memory');
  });

  it('deletes each original key only after exact readback and preserves failed/concurrently edited keys', async () => {
    const db = new ThreadkeeperDB(`credentials-${Date.now()}`);
    const original = { ...await ensureStarterCollectionsAndSettings(db), voyageApiKey: 'move-voyage', openaiApiKey: 'keep-openai', cohereApiKey: 'old-cohere', paperclipCredentials: { companyId: 'company-a', linkedKeys: [], allowSecretTransfer: true } };
    await db.settings.put(original);
    const backend = {
      listSecrets: async () => [],
      saveSecret: async (key: string) => { if (key === 'cohereApiKey') await db.settings.update('default', { cohereApiKey: 'edited-cohere' }); return `secret-${key}`; },
      link: async () => undefined,
      resolve: async (key: string) => key === 'voyageApiKey' ? 'move-voyage' : key === 'cohereApiKey' ? 'old-cohere' : 'wrong-readback',
    } as unknown as CredentialBackend;
    const result = await moveModelKeys(db, original, backend);
    const stored = await db.settings.get('default');
    expect(result.moved).toEqual(['voyageApiKey']);
    expect(stored?.voyageApiKey).toBe('');
    expect(stored?.openaiApiKey).toBe('keep-openai');
    expect(stored?.cohereApiKey).toBe('edited-cohere');
    expect(stored?.paperclipCredentials?.linkedKeys).toEqual(['voyageApiKey']);
    expect(result.notMoved).toEqual(expect.arrayContaining(['openaiApiKey', 'cohereApiKey']));
    const chunks: Uint8Array[] = [];
    await writeBackup(db, (chunk) => { chunks.push(chunk); }, { extensionId: 'a'.repeat(32), extensionVersion: 'test' });
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const backup = strFromU8(gunzipSync(bytes));
    expect(backup).not.toContain('move-voyage');
    expect(backup).toContain('keep-openai');
    await db.delete();
  });

  it('clears the stored value once a link is read back, so IndexedDB and backups are free of it (REQ-14 F-2)', async () => {
    const db = new ThreadkeeperDB(`credential-link-clear-${Date.now()}`);
    const base = await ensureStarterCollectionsAndSettings(db);
    await db.settings.put({ ...base, voyageApiKey: 'stale-stored-voyage', paperclipCredentials: { companyId: 'company-a', linkedKeys: [], allowSecretTransfer: true } });
    const factory = (() => ({ listSecrets: async () => [{ id: 'secret-1', name: 'Voyage' }], link: async () => undefined, resolve: async () => 'from-paperclip',
      metadata: async () => ({ companyId: 'company-a', linkedKeys: ['voyageApiKey'], allowSecretTransfer: true, missingKeys: [] }) })) as any;
    await handleCredentialCommand(db, async () => 'from-paperclip', 'credentials.link', { companyId: 'company-a', keyName: 'voyageApiKey', secretId: 'secret-1' }, factory);
    const stored = await db.settings.get('default');
    expect(stored?.voyageApiKey).toBe('');
    expect(stored?.paperclipCredentials?.linkedKeys).toEqual(['voyageApiKey']);
    const chunks: Uint8Array[] = [];
    await writeBackup(db, (chunk) => { chunks.push(chunk); }, { extensionId: 'a'.repeat(32), extensionVersion: 'test' });
    const bytes = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
    let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    expect(strFromU8(gunzipSync(bytes))).not.toContain('stale-stored-voyage');
    await db.delete();
  });

  it('keeps the stored value when the linked secret cannot be read back', async () => {
    const db = new ThreadkeeperDB(`credential-link-keep-${Date.now()}`);
    const base = await ensureStarterCollectionsAndSettings(db);
    await db.settings.put({ ...base, voyageApiKey: 'kept-voyage', paperclipCredentials: { companyId: 'company-a', linkedKeys: [], allowSecretTransfer: true } });
    const factory = (() => ({ listSecrets: async () => [{ id: 'secret-1', name: 'Voyage' }], link: async () => undefined, resolve: async () => { throw new Error('offline'); } })) as any;
    await expect(handleCredentialCommand(db, async () => '', 'credentials.link', { companyId: 'company-a', keyName: 'voyageApiKey', secretId: 'secret-1' }, factory)).rejects.toThrow('kept');
    expect((await db.settings.get('default'))?.voyageApiKey).toBe('kept-voyage');
    await db.delete();
  });

  it('switching the source company A to B clears the PREVIOUS company A config on the server (REQ-14 F-6)', async () => {
    const db = new ThreadkeeperDB(`credential-switch-${Date.now()}`);
    await db.settings.put(settings());
    const cleared: string[] = [];
    const factory = ((_s: unknown, companyId: string) => ({ clearLinks: async () => { cleared.push(companyId); },
      metadata: async () => ({ companyId, linkedKeys: [], allowSecretTransfer: false, missingKeys: [] }), listSecrets: async () => [] })) as any;
    await handleCredentialCommand(db, async () => '', 'credentials.source', { companyId: 'company-b' }, factory);
    expect(cleared).toContain('company-a');
    expect((await db.settings.get('default'))?.paperclipCredentials).toMatchObject({ companyId: 'company-b', linkedKeys: [], allowSecretTransfer: false });
    await db.delete();
  });

  it('deselecting the source company clears local consent first and then the previous company config', async () => {
    const db = new ThreadkeeperDB(`credential-deselect-${Date.now()}`);
    await db.settings.put(settings());
    const cleared: string[] = [];
    const factory = ((_s: unknown, companyId: string) => ({ clearLinks: async () => { cleared.push(companyId); throw new Error('offline'); } })) as any;
    await expect(handleCredentialCommand(db, async () => '', 'credentials.clear', {}, factory)).rejects.toThrow('offline');
    expect(cleared).toEqual(['company-a']);
    expect((await db.settings.get('default'))?.paperclipCredentials).toMatchObject({ companyId: '', linkedKeys: [], allowSecretTransfer: false });
    await db.delete();
  });

  it('cloud calls accept a linked worker token with an empty local value (REQ-14 F-8)', async () => {
    const db = new ThreadkeeperDB(`credential-worker-${Date.now()}`);
    const base = await ensureStarterCollectionsAndSettings(db);
    await db.settings.put({ ...base, cloudEnabled: true, workerEndpointUrl: 'https://worker.example.test', workerBearerToken: '', dailyCloudRequestBudget: 10,
      paperclipCredentials: { companyId: 'company-a', linkedKeys: ['workerBearerToken'], allowSecretTransfer: true } });
    configureModelCredentialResolver(async () => 'linked-worker-token');
    const fetch = vi.fn(async () => new Response('{}', { status: 500 })) as unknown as typeof globalThis.fetch;
    const result = await requestQueryEmbedding(db, 'hello', fetch);
    expect(result.reason ?? '').not.toContain('not configured');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(new Headers((fetch as any).mock.calls[0][1].headers).get('authorization')).toBe('Bearer linked-worker-token');
    expect((await db.settings.get('default'))?.workerBearerToken).toBe('');
    await db.delete();
  });

  it('denies another company and revocation while a secret read is in flight', async () => {
    const db = new ThreadkeeperDB(`credential-gate-${Date.now()}`);
    await db.settings.put(settings());
    const resolve = vi.fn(async () => { await db.settings.update('default', { paperclipCredentials: { companyId: 'company-a', linkedKeys: ['voyageApiKey'], allowSecretTransfer: false } }); return 'never-delivered'; });
    const factory = (() => ({ resolve })) as any;
    await expect(handleCredentialCommand(db, resolve, 'credentials.resolve', { companyId: 'foreign', keyName: 'voyageApiKey' }, factory)).rejects.toThrow('disabled');
    expect(resolve).not.toHaveBeenCalled();
    await expect(handleCredentialCommand(db, resolve, 'credentials.resolve', { companyId: 'company-a', keyName: 'voyageApiKey' }, factory)).rejects.toThrow('disabled');
    await db.delete();
  });

  it('commits local denial even if the server cannot save the switch-off', async () => {
    const db = new ThreadkeeperDB(`credential-off-${Date.now()}`);
    await db.settings.put(settings());
    const factory = (() => ({ setConsent: async () => { throw new Error('offline'); } })) as any;
    await expect(handleCredentialCommand(db, async () => '', 'credentials.consent', { companyId: 'company-a', enabled: false }, factory)).rejects.toThrow('offline');
    expect((await db.settings.get('default'))?.paperclipCredentials?.allowSecretTransfer).toBe(false);
    await db.delete();
  });

  it('uses governed board APIs for secret creation and ref config, blocks redirects, and resolves only through the paired callback', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = vi.fn(async (input, init: RequestInit) => {
      const url = String(input); calls.push({ url, init });
      if (url.includes('/config?')) return new Response(JSON.stringify({ configJson: { keep: 'unchanged', credentialLinks: {} } }));
      if (url.endsWith('/config')) return new Response('{}');
      if (init.method === 'POST') return new Response(JSON.stringify({ id: 'secret-voyage' }));
      return new Response('[]');
    }) as unknown as typeof globalThis.fetch;
    const paired = vi.fn(async () => 'fixture-value');
    const original = { ...settings(), paperclip: { ...settings().paperclip, apiKey: 'pcp_board_fixture' } };
    const backend = createCredentialBackend(original, 'company-a', paired, fetch);
    const secretId = await backend.saveSecret('voyageApiKey', 'fixture-value');
    await backend.link('voyageApiKey', secretId);
    expect(await backend.resolve('voyageApiKey')).toBe('fixture-value');
    expect(paired).toHaveBeenCalledWith('company-a', 'voyageApiKey');
    expect(calls.every((call) => call.init.redirect === 'error' && call.init.credentials === 'omit')).toBe(true);
    const config = JSON.parse(String(calls.find((call) => call.url.endsWith('/config'))!.init.body));
    expect(config.configJson.keep).toBe('unchanged');
    expect(config.configJson.credentialLinks.voyageApiKey).toEqual({ type: 'secret_ref', secretId, version: 'latest' });
    expect(JSON.stringify(config)).not.toContain('fixture-value');
  });

  it('refuses to send a secret value to a plain-http server that is not loopback (REQ-14 F-1)', async () => {
    const fetch = vi.fn(async () => new Response('[]')) as unknown as typeof globalThis.fetch;
    const lan = { ...settings(), paperclip: { ...settings().paperclip, serverUrl: 'http://10.0.0.5:3100' } };
    await expect(createCredentialBackend(lan, 'company-a', vi.fn(), fetch).saveSecret('voyageApiKey', 'never-sent')).rejects.toThrow(/https|this computer/i);
    expect(fetch).not.toHaveBeenCalled();
    const secure = { ...settings(), paperclip: { ...settings().paperclip, serverUrl: 'https://paperclip.example.test' } };
    const okFetch = vi.fn(async (_input, init: RequestInit) => new Response(init.method === 'POST' ? JSON.stringify({ id: 'secret-id' }) : '[]')) as unknown as typeof globalThis.fetch;
    expect(await createCredentialBackend(secure, 'company-a', vi.fn(), okFetch).saveSecret('voyageApiKey', 'value')).toBe('secret-id');
  });

  it('recognizes a deleted secret without reading or exposing any value', async () => {
    const paired = vi.fn();
    const fetch = vi.fn(async (input) => {
      const url = String(input);
      return new Response(JSON.stringify(url.includes('/api/credentials?') ? { linkedKeys: ['voyageApiKey'], allowSecretTransfer: true }
        : url.includes('/config?') ? { configJson: { credentialLinks: { voyageApiKey: { secretId: 'deleted-id' } } } } : []));
    }) as unknown as typeof globalThis.fetch;
    const metadata = await createCredentialBackend(settings(), 'company-a', paired, fetch).metadata();
    expect(metadata.linkedKeys).toEqual([]);
    expect(metadata.missingKeys).toEqual(['voyageApiKey']);
    expect(paired).not.toHaveBeenCalled();
  });

  it('does not resurrect an unlink when the offline server still reports the old link', async () => {
    const db = new ThreadkeeperDB(`credential-unlink-${Date.now()}`);
    await db.settings.put(settings());
    const factory = (() => ({ link: async () => { throw new Error('offline'); }, metadata: async () => ({ companyId: 'company-a', linkedKeys: ['voyageApiKey'], allowSecretTransfer: true }), listSecrets: async () => [] })) as any;
    await expect(handleCredentialCommand(db, async () => '', 'credentials.link', { companyId: 'company-a', keyName: 'voyageApiKey', secretId: null }, factory)).rejects.toThrow('offline');
    const status = await handleCredentialCommand(db, async () => '', 'credentials.status', { companyId: 'company-a' }, factory) as any;
    expect(status.linkedKeys).toEqual([]);
    expect((await db.settings.get('default'))?.paperclipCredentials?.linkedKeys).toEqual([]);
    await db.delete();
  });
});
