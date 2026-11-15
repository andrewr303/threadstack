import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../src/core/schema.js';
import { proxySessionCommand } from '../../src/core/paperclip/integration-client.js';
import { PaperclipClient } from '../../src/core/paperclip/client.js';

describe('manager session API proxy', () => {
  it('discloses management access in the board approval request', async () => {
    const request = vi.fn(async (_input: string, _init?: RequestInit) => Response.json({ id: 'challenge' }));
    await new PaperclipClient({ serverUrl: 'http://127.0.0.1:3100', fetch: request }).createCliAuthChallenge();
    const body = JSON.parse(request.mock.calls[0][1]!.body as string);
    expect(body.requestedAccess).toBe('board');
    expect(body.command).toMatch(/manage.*browser sessions/i);
    expect(body.command).toContain('model-key links');
  });
  const settings = { ...DEFAULT_SETTINGS, paperclip: { ...DEFAULT_SETTINGS.paperclip, serverUrl: 'http://127.0.0.1:3100', auth: 'board_key' as const, apiKey: 'board-key' } };
  it('uses only a fixed endpoint with board credentials and refuses redirects', async () => {
    const request = vi.fn(async () => Response.json({ links: [] }));
    await proxySessionCommand(settings, 'links', { companyId: 'one', threadKey: 'a:b' }, request);
    expect(request).toHaveBeenCalledWith('http://127.0.0.1:3100/api/plugins/browser-sessions/api/links?companyId=one&threadKey=a%3Ab', expect.objectContaining({ method: 'GET', redirect: 'error', credentials: 'omit', headers: expect.objectContaining({ Authorization: 'Bearer board-key' }) }));
  });
  it('rejects arbitrary commands and missing company before requesting anything', async () => {
    const request = vi.fn();
    await expect(proxySessionCommand(settings, '/secrets', { companyId: 'one' }, request)).rejects.toThrow('Unknown');
    await expect(proxySessionCommand(settings, 'links', {}, request)).rejects.toThrow('companyId');
    expect(request).not.toHaveBeenCalled();
  });
  it('reports plugin errors rather than returning a successful response', async () => {
    await expect(proxySessionCommand(settings, 'link', { companyId: 'one', issueId: 'issue', threadKey: 'thread' }, async () => Response.json({ error: { code: 'not_found', message: 'No such task' } }, { status: 404 }))).rejects.toThrow('No such task');
  });
});
