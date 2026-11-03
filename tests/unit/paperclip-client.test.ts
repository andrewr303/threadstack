import { describe, expect, it, vi } from 'vitest';
import {
  PaperclipClient,
  PaperclipError,
  discoverServer,
  hostPermissionPattern,
  isLoopbackServer,
  normalizeServerUrl,
  parseHealth,
  probeServer,
} from '../../src/core/paperclip/client.js';
import { BOARD_KEY_TTL_MS, looksLikeBoardKey, revokeBoardKey, signInWithApproval, verifyBoardKey } from '../../src/core/paperclip/auth.js';
import { FakePaperclip } from './paperclip-fake-server.js';

describe('Paperclip server addresses', () => {
  it('normalizes what people type to an origin', () => {
    expect(normalizeServerUrl('localhost:3100')).toBe('http://localhost:3100');
    expect(normalizeServerUrl(' http://127.0.0.1:3101/api/ ')).toBe('http://127.0.0.1:3101');
    expect(normalizeServerUrl('https://paperclip.example.ts.net/PAP/issues/PAP-1')).toBe('https://paperclip.example.ts.net');
    expect(normalizeServerUrl('ftp://host')).toBeNull();
    expect(normalizeServerUrl('http://user:pw@host:3100')).toBeNull();
    expect(normalizeServerUrl('')).toBeNull();
  });

  it('asks for host access without a port so one grant covers 3100-3110', () => {
    expect(hostPermissionPattern('http://localhost:3104')).toBe('http://localhost/*');
    expect(hostPermissionPattern('https://box.tailnet.ts.net:8443')).toBe('https://box.tailnet.ts.net/*');
    expect(isLoopbackServer('http://127.0.0.1:3100')).toBe(true);
    expect(isLoopbackServer('http://192.168.1.5:3100')).toBe(false);
  });

  it('recognizes Paperclip health answers only', () => {
    expect(parseHealth({ status: 'ok', deploymentMode: 'local_trusted', version: '0.3.1' })?.version).toBe('0.3.1');
    expect(parseHealth({ status: 'ok', deploymentMode: 'authenticated', deploymentExposure: 'private' })?.deploymentMode).toBe('authenticated');
    expect(parseHealth({ status: 'ok' })).toBeNull();
    expect(parseHealth([])).toBeNull();
  });
});

describe('PaperclipClient', () => {
  it('probes /api/health and reports the deployment mode', async () => {
    const server = new FakePaperclip();
    const found = await probeServer('localhost:3100', { fetch: server.fetch });
    expect(found.serverUrl).toBe('http://localhost:3100');
    expect(found.health.deploymentMode).toBe('local_trusted');
    expect(server.requests[0].path).toBe('/api/health');
    expect(server.requests[0].credentials).toBe('omit');
  });

  it('rejects a server that is not Paperclip', async () => {
    const fetchStub = vi.fn(async () => new Response('<html>hi</html>', { status: 200 }));
    await expect(probeServer('http://localhost:3100', { fetch: fetchStub })).rejects.toMatchObject({ kind: 'not_paperclip' });
  });

  it('finds Paperclip on the next free port', async () => {
    const server = new FakePaperclip('http://localhost:3103');
    const found = await discoverServer({ fetch: server.fetch });
    expect(found?.serverUrl).toBe('http://localhost:3103');
  });

  it('returns null when nothing answers', async () => {
    const server = new FakePaperclip('http://localhost:9999');
    expect(await discoverServer({ fetch: server.fetch })).toBeNull();
  });

  it('sends the board key as a Bearer token and maps 401', async () => {
    const server = new FakePaperclip();
    server.mode = 'authenticated';
    server.validKeys.add('pcp_board_good');
    server.addCompany({ id: 'c1', name: 'Acme' });
    const good = new PaperclipClient({ serverUrl: server.origin, apiKey: 'pcp_board_good', fetch: server.fetch });
    expect((await good.listCompanies()).map((c) => c.name)).toEqual(['Acme']);
    expect(server.requests.at(-1)?.auth).toBe('Bearer pcp_board_good');
    const bad = new PaperclipClient({ serverUrl: server.origin, apiKey: 'pcp_board_bad', fetch: server.fetch });
    await expect(bad.listCompanies()).rejects.toMatchObject({ kind: 'unauthorized', status: 401 });
  });

  it('waits out a short 429 and retries', async () => {
    const server = new FakePaperclip();
    server.addCompany({ id: 'c1', name: 'Acme' });
    server.rateLimits.push({ match: /\/companies$/, remaining: 2, retryAfter: 2 });
    const sleep = vi.fn(async () => undefined);
    const client = new PaperclipClient({ serverUrl: server.origin, fetch: server.fetch, sleep });
    expect(await client.listCompanies()).toHaveLength(1);
    expect(sleep).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('gives up on a long Retry-After with the wait attached', async () => {
    const server = new FakePaperclip();
    server.rateLimits.push({ match: /\/companies$/, remaining: 1, retryAfter: 120 });
    const client = new PaperclipClient({ serverUrl: server.origin, fetch: server.fetch, sleep: async () => undefined });
    const err = await client.listCompanies().catch((e) => e);
    expect(err).toBeInstanceOf(PaperclipError);
    expect(err.kind).toBe('rate_limited');
    expect(err.retryAfterMs).toBe(120_000);
  });

  it('maps network failures to a plain message', async () => {
    const server = new FakePaperclip();
    server.down = true;
    const client = new PaperclipClient({ serverUrl: server.origin, fetch: server.fetch });
    await expect(client.listCompanies()).rejects.toMatchObject({ kind: 'unreachable' });
  });

  it('pages through more than 500 comments with the after cursor', async () => {
    const server = new FakePaperclip();
    server.addCompany({ id: 'c1', name: 'Acme' });
    server.addIssue({ id: 'i1', companyId: 'c1', title: 'Busy' });
    for (let n = 0; n < 1203; n++) server.addComment('i1', { id: `cm${String(n).padStart(4, '0')}`, body: `comment ${n}` }, false);
    const client = new PaperclipClient({ serverUrl: server.origin, fetch: server.fetch });
    const comments = await client.listComments('i1');
    expect(comments).toHaveLength(1203);
    expect(comments[0].body).toBe('comment 0');
    expect(comments.at(-1)?.body).toBe('comment 1202');
    expect(server.count(/\/comments$/)).toBe(3);
    expect(server.requests.filter((r) => r.path.endsWith('/comments')).every((r) => r.query.order === 'asc')).toBe(true);
  });

  it('never sends a non-GET request except the auth routes', async () => {
    const server = new FakePaperclip();
    server.addCompany({ id: 'c1', name: 'Acme' });
    const client = new PaperclipClient({ serverUrl: server.origin, fetch: server.fetch });
    await client.listCompanies();
    await client.listCompanyRuns('c1');
    expect(server.requests.every((r) => r.method === 'GET')).toBe(true);
  });
});

describe('Paperclip sign-in', () => {
  it('runs the CLI approval flow: opens the approval page, polls, verifies the key', async () => {
    const server = new FakePaperclip();
    server.mode = 'authenticated';
    const opened: string[] = [];
    const statuses: string[] = [];
    const now = Date.parse('2026-11-03T10:00:00.000Z');
    const signedIn = await signInWithApproval({
      serverUrl: server.origin,
      fetch: server.fetch,
      openUrl: (url) => {
        opened.push(url);
      },
      onStatus: (s) => statuses.push(s.phase),
      sleep: async () => undefined,
      now: () => now,
    });
    expect(opened[0]).toMatch(/^http:\/\/localhost:3100\/cli-auth\/.+\?token=/);
    expect(statuses).toEqual(['waiting', 'approved']);
    expect(signedIn.apiKey).toMatch(/^pcp_board_/);
    expect(signedIn.accountLabel).toBe('Ada (ada@example.com)');
    expect(Date.parse(signedIn.expiresAt) - now).toBe(BOARD_KEY_TTL_MS);
    // The challenge itself is anonymous; only the verification carries the key.
    const post = server.requests.find((r) => r.method === 'POST')!;
    expect(post.auth).toBeNull();
    expect(server.requests.find((r) => r.path === '/api/cli-auth/me')?.auth).toBe(`Bearer ${signedIn.apiKey}`);
  });

  it('reports a declined request', async () => {
    const server = new FakePaperclip();
    server.mode = 'authenticated';
    server.challenges.push({ id: '00000000-0000-4000-8000-000000000009', token: 'secret-token-123456', boardApiToken: 'pcp_board_xxxxxxxxxxxxxxxxxxxx', statuses: ['pending', 'cancelled'], polls: -1 });
    await expect(
      signInWithApproval({ serverUrl: server.origin, fetch: server.fetch, openUrl: () => undefined, sleep: async () => undefined })
    ).rejects.toThrow('declined');
  });

  it('stops when cancelled', async () => {
    const server = new FakePaperclip();
    server.mode = 'authenticated';
    server.challenges.push({ id: '00000000-0000-4000-8000-000000000008', token: 'secret-token-123456', boardApiToken: 'pcp_board_xxxxxxxxxxxxxxxxxxxx', statuses: ['pending'], polls: -1 });
    const abort = new AbortController();
    let polls = 0;
    const result = signInWithApproval({
      serverUrl: server.origin,
      fetch: server.fetch,
      openUrl: () => undefined,
      signal: abort.signal,
      sleep: async () => {
        polls++;
        if (polls === 3) abort.abort();
      },
    });
    await expect(result).rejects.toMatchObject({ kind: 'aborted' });
  });

  it('checks a pasted key and explains a rejected one', async () => {
    const server = new FakePaperclip();
    server.mode = 'authenticated';
    server.validKeys.add('pcp_board_0123456789abcdef0123');
    expect(looksLikeBoardKey('pcp_board_0123456789abcdef0123')).toBe(true);
    expect(looksLikeBoardKey('sk-ant-xyz')).toBe(false);
    const ok = await verifyBoardKey(server.origin, 'pcp_board_0123456789abcdef0123', { fetch: server.fetch });
    expect(ok.accountLabel).toBe('Ada (ada@example.com)');
    await expect(verifyBoardKey(server.origin, 'pcp_board_nopenopenopenopenope', { fetch: server.fetch })).rejects.toThrow(
      'did not accept this key'
    );
    expect(await revokeBoardKey(server.origin, 'pcp_board_0123456789abcdef0123', server.fetch)).toBe(true);
    expect(server.validKeys.has('pcp_board_0123456789abcdef0123')).toBe(false);
  });
});
