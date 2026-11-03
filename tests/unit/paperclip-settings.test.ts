import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CAPTURE_PROVIDER_IDS,
  PROVIDERS,
  captureMatchPatterns,
  detectProviderFromUrl,
  isCaptureProviderId,
  providerLabel,
} from '../../src/core/providers.js';
import {
  DEFAULT_PAPERCLIP_SETTINGS,
  DEFAULT_SETTINGS,
  normalizePaperclipSettings,
  normalizeSettings,
  type ConversationRecord,
} from '../../src/core/schema.js';
import { PaperclipLiveHint, isRelevantLiveEvent, liveEventsUrl, type WebSocketLike } from '../../src/core/paperclip/live.js';
import { sessionLinks } from '../../src/entrypoints/manager/PaperclipLinks.js';
import { isSyncRunning, paperclipPermissionOrigins, paperclipSectionStatus } from '../../src/entrypoints/manager/PaperclipSettings.js';
import { EMPTY_PAPERCLIP_STATE } from '../../src/core/paperclip/sync.js';

describe('Paperclip provider entry', () => {
  it('is an agent platform that is never captured from pages', () => {
    expect(PROVIDERS.paperclip).toMatchObject({ label: 'Paperclip', category: 'agent', reopen: 'web', matchPatterns: [] });
    expect(providerLabel('paperclip')).toBe('Paperclip');
    expect(CAPTURE_PROVIDER_IDS).not.toContain('paperclip');
    expect(CAPTURE_PROVIDER_IDS).not.toContain('imported');
    expect(isCaptureProviderId('paperclip')).toBe(false);
    expect(isCaptureProviderId('chatgpt')).toBe(true);
    expect(captureMatchPatterns().some((p) => p.includes('localhost'))).toBe(false);
    expect(detectProviderFromUrl('http://localhost:3100/PAP/issues/PAP-1')).toBeNull();
  });

  it('has a default account for thread keys and no capture toggle', () => {
    expect(DEFAULT_SETTINGS.boundAccounts.paperclip).toEqual({ accountId: 'acct_paperclip_primary', workspaceId: 'ws_personal' });
    expect('paperclip' in DEFAULT_SETTINGS.authorizedHosts).toBe(false);
  });
});

describe('Paperclip settings', () => {
  it('fills defaults into older settings records', () => {
    const s = normalizeSettings({ id: 'default', theme: 'dark' } as never);
    expect(s.paperclip).toEqual(DEFAULT_PAPERCLIP_SETTINGS);
    expect(s.paperclip.serverUrl).toBe('http://localhost:3100');
    expect(s.boundAccounts.paperclip.accountId).toBe('acct_paperclip_primary');
  });

  it('coerces stored values', () => {
    const p = normalizePaperclipSettings({
      enabled: 'yes' as never,
      serverUrl: '  ',
      auth: 'cookie' as never,
      deploymentMode: 'cloud' as never,
      companyScope: 'selected',
      companyIds: ['a', 'a', ' b ', 3 as never, ''],
      liveUpdates: undefined,
    });
    expect(p).toMatchObject({ enabled: false, serverUrl: 'http://localhost:3100', auth: 'none', deploymentMode: '', companyScope: 'selected', companyIds: ['a', 'b'], liveUpdates: true });
  });

  it('asks for both loopback names for a local server, the host otherwise', () => {
    expect(paperclipPermissionOrigins('http://localhost:3105')).toEqual(['http://localhost/*', 'http://127.0.0.1/*']);
    expect(paperclipPermissionOrigins('https://pc.example.com')).toEqual(['https://pc.example.com/*']);
    expect(paperclipPermissionOrigins('nonsense://')).toEqual([]);
  });

  it('summarizes the section for the settings navigation', () => {
    const on = { ...DEFAULT_PAPERCLIP_SETTINGS, enabled: true, deploymentMode: 'local_trusted' as const };
    expect(paperclipSectionStatus(DEFAULT_PAPERCLIP_SETTINGS, null)).toEqual({ text: 'Off' });
    expect(paperclipSectionStatus(on, EMPTY_PAPERCLIP_STATE)).toEqual({ text: 'On' });
    expect(paperclipSectionStatus({ ...on, deploymentMode: 'authenticated' }, null)).toEqual({ text: 'Sign in', tone: 'danger' });
    expect(paperclipSectionStatus(on, { ...EMPTY_PAPERCLIP_STATE, lastError: 'x' })).toEqual({ text: 'Error', tone: 'danger' });
  });

  it('treats a sync left running by a stopped worker as over', () => {
    const now = Date.parse('2026-11-03T12:00:00.000Z');
    expect(isSyncRunning({ ...EMPTY_PAPERCLIP_STATE, running: true, runningSince: '2026-11-03T11:58:00.000Z' }, now)).toBe(true);
    expect(isSyncRunning({ ...EMPTY_PAPERCLIP_STATE, running: true, runningSince: '2026-11-03T11:00:00.000Z' }, now)).toBe(false);
  });
});

describe('linked sessions', () => {
  const conv = (c: Partial<ConversationRecord> & { threadKey: string; provider: ConversationRecord['provider'] }): ConversationRecord =>
    ({ title: 'T', manualTitleOverride: null, sourceConversationId: c.threadKey.split(':')[3], ...c }) as ConversationRecord;
  const cliKey = 'claude_code:acct_claude_code_primary:ws_personal:sess-1:main';
  const missingKey = 'codex:acct_codex_primary:ws_personal:019a7777-aaaa:main';
  const issue = conv({ threadKey: 'paperclip:acct_paperclip_primary:ws_personal:issue-1:main', provider: 'paperclip', title: 'PAP-1 Landing', linkedThreadKeys: [cliKey, missingKey] });
  const cli = conv({ threadKey: cliKey, provider: 'claude_code', title: 'Landing session' });

  it('lists the sessions of an issue, imported or not', () => {
    const { kind, links } = sessionLinks(issue, [issue, cli]);
    expect(kind).toBe('sessions');
    expect(links.map((l) => [l.label, Boolean(l.conv)])).toEqual([
      ['Claude Code · Landing session', true],
      ['Codex · session 019a7777', false],
    ]);
  });

  it('lists the issues that ran a session', () => {
    const { kind, links } = sessionLinks(cli, [issue, cli]);
    expect(kind).toBe('issues');
    expect(links.map((l) => l.label)).toEqual(['Paperclip · PAP-1 Landing']);
    expect(sessionLinks(conv({ threadKey: 'chatgpt:a:w:x:main', provider: 'chatgpt' }), [issue]).links).toEqual([]);
  });
});

describe('live change hints', () => {
  afterEach(() => vi.useRealTimers());

  it('builds the company event socket URL', () => {
    expect(liveEventsUrl('http://localhost:3100', 'c-1')).toBe('ws://localhost:3100/api/companies/c-1/events/ws');
    expect(liveEventsUrl('https://pc.example.com', 'c-1')).toBe('wss://pc.example.com/api/companies/c-1/events/ws');
    expect(liveEventsUrl('http://localhost:3100', '../x')).toBeNull();
  });

  it('reacts to issue and run events only', () => {
    expect(isRelevantLiveEvent(JSON.stringify({ type: 'activity.logged', payload: { entityType: 'issue' } }))).toBe(true);
    expect(isRelevantLiveEvent({ type: 'heartbeat.run.status', payload: { status: 'succeeded' } })).toBe(true);
    expect(isRelevantLiveEvent({ type: 'activity.logged', payload: { entityType: 'agent' } })).toBe(false);
    expect(isRelevantLiveEvent({ type: 'heartbeat.run.log' })).toBe(false);
    expect(isRelevantLiveEvent('not json')).toBe(false);
  });

  it('debounces bursts into one sync and closes cleanly', () => {
    vi.useFakeTimers();
    const sockets: Array<WebSocketLike & { url: string; closed: boolean }> = [];
    const onChange = vi.fn();
    const hint = new PaperclipLiveHint({
      serverUrl: 'http://localhost:3100',
      companyIds: ['c-1', 'c-2'],
      onChange,
      debounceMs: 1000,
      createSocket: (url) => {
        const s = { url, readyState: 1, closed: false, onmessage: null, onclose: null, onerror: null, close() { this.closed = true; this.readyState = 3; } };
        sockets.push(s);
        return s;
      },
    });
    hint.open();
    expect(sockets.map((s) => s.url)).toEqual([
      'ws://localhost:3100/api/companies/c-1/events/ws',
      'ws://localhost:3100/api/companies/c-2/events/ws',
    ]);
    expect(hint.isOpen).toBe(true);
    expect(hint.matches('http://localhost:3100/', ['c-2', 'c-1'])).toBe(true);
    for (let i = 0; i < 5; i++) sockets[i % 2].onmessage?.({ data: JSON.stringify({ type: 'heartbeat.run.status', payload: {} }) });
    sockets[0].onmessage?.({ data: JSON.stringify({ type: 'agent.status' }) });
    vi.advanceTimersByTime(1000);
    expect(onChange).toHaveBeenCalledTimes(1);
    hint.close();
    expect(sockets.every((s) => s.closed)).toBe(true);
    expect(hint.isOpen).toBe(false);
  });
});

describe('Settings → Paperclip panel', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function renderPanel(paperclip: Partial<typeof DEFAULT_PAPERCLIP_SETTINGS>, onPatch = vi.fn(async () => undefined)) {
    const React = await import('react');
    const { act } = React;
    const { createRoot } = await import('react-dom/client');
    const { PaperclipSettings } = await import('../../src/entrypoints/manager/PaperclipSettings.js');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const settings = normalizeSettings({ paperclip: normalizePaperclipSettings({ ...DEFAULT_PAPERCLIP_SETTINGS, ...paperclip }) } as never);
    await act(async () => {
      root.render(React.createElement(PaperclipSettings, { settings, onPatch }));
    });
    const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
    return { container, onPatch, act, flush, root };
  }

  it('asks for host access inside the click, then finds the server and saves its mode', async () => {
    const { FakePaperclip } = await import('./paperclip-fake-server.js');
    const server = new FakePaperclip('http://localhost:3102');
    vi.stubGlobal('fetch', server.fetch);
    const order: string[] = [];
    const request = vi.fn(async () => {
      order.push('permission');
      return true;
    });
    vi.stubGlobal('chrome', { permissions: { request } });
    const { container, onPatch, act, flush } = await renderPanel({});
    const button = Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Connect')!;
    await act(async () => {
      button.click();
      order.push('clicked');
    });
    for (let i = 0; i < 5; i++) await flush();
    // The permission prompt is requested synchronously in the click, before any network call.
    expect(order[0]).toBe('permission');
    expect(request).toHaveBeenCalledWith({ origins: ['http://localhost/*', 'http://127.0.0.1/*'] });
    expect(onPatch).toHaveBeenCalledWith({
      paperclip: expect.objectContaining({ serverUrl: 'http://localhost:3102', deploymentMode: 'local_trusted', auth: 'none' }),
    });
    expect(container.textContent).toContain('Found Paperclip 0.3.1 at http://localhost:3102');
  });

  it('explains when access is declined', async () => {
    vi.stubGlobal('chrome', { permissions: { request: vi.fn(async () => false) } });
    const { container, act, flush } = await renderPanel({});
    await act(async () => {
      Array.from(container.querySelectorAll('button')).find((b) => b.textContent === 'Connect')!.click();
    });
    await flush();
    expect(container.textContent).toContain('Access to localhost:3100 was not granted');
  });

  it('offers sign-in on an authenticated server and lists companies once ready', async () => {
    const { FakePaperclip } = await import('./paperclip-fake-server.js');
    const server = new FakePaperclip();
    server.mode = 'authenticated';
    server.validKeys.add('pcp_board_goodgoodgoodgoodgood');
    server.addCompany({ id: 'c-1', name: 'Acme', issuePrefix: 'PAP' });
    vi.stubGlobal('fetch', server.fetch);
    const needsSignIn = await renderPanel({ deploymentMode: 'authenticated' });
    expect(needsSignIn.container.textContent).toContain('Sign in with Paperclip');
    expect(needsSignIn.container.textContent).not.toContain('Companies');
    await needsSignIn.act(async () => needsSignIn.root.unmount());

    const ready = await renderPanel({
      deploymentMode: 'authenticated',
      auth: 'board_key',
      apiKey: 'pcp_board_goodgoodgoodgoodgood',
      accountLabel: 'Ada',
      companyScope: 'selected',
    });
    await ready.flush();
    await ready.flush();
    expect(ready.container.textContent).toContain('Signed in as Ada');
    expect(ready.container.textContent).toContain('Acme');
    expect(ready.container.textContent).toContain('Sync now');
  });
});
