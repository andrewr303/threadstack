// Host access shared between added sites, optional providers and Paperclip: revoking one feature's
// grant must not take away another's.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CUSTOM_SITES_KEY, EMPTY_CUSTOM_SITES, addCustomSite, normalizeSiteOrigin } from '../../src/core/custom-sites.js';
import { originsInUse, patternsOverlap, releasableOrigins } from '../../src/core/host-access.js';
import { DEFAULT_PAPERCLIP_SETTINGS, DEFAULT_SETTINGS, normalizeSettings } from '../../src/core/schema.js';

const NOW = '2026-11-03T12:00:00.000Z';
const paperclipOff = { enabled: false, serverUrl: 'http://localhost:3100' };
const paperclipLocal = { enabled: true, serverUrl: 'http://localhost:3100' };

describe('which host access is still in use', () => {
  it('retains the app and bridge origin independently from library sync', () => {
    const users = { sites: EMPTY_CUSTOM_SITES, authorizedHosts: DEFAULT_SETTINGS.authorizedHosts, paperclip: { ...paperclipOff, hostEnabled: true } };
    expect(releasableOrigins(['http://localhost/*'], users)).toEqual([]);
  });
  it('keeps a loopback grant Paperclip relies on when an added localhost site is removed', () => {
    const users = { sites: EMPTY_CUSTOM_SITES, authorizedHosts: DEFAULT_SETTINGS.authorizedHosts, paperclip: paperclipLocal };
    expect(releasableOrigins(['http://localhost/*'], users)).toEqual([]);
    expect(releasableOrigins(['http://localhost/*'], { ...users, paperclip: paperclipOff })).toEqual(['http://localhost/*']);
  });

  it('keeps a provider grant an added site on that host relies on, and the reverse', () => {
    const sites = { ...EMPTY_CUSTOM_SITES, sites: [{ origin: 'https://github.com', label: 'github.com', addedAt: NOW, enabled: true }] };
    const off = { ...DEFAULT_SETTINGS.authorizedHosts, github_copilot: false };
    expect(releasableOrigins(['https://github.com/*'], { sites, authorizedHosts: off, paperclip: paperclipOff })).toEqual([]);
    const on = { ...DEFAULT_SETTINGS.authorizedHosts, github_copilot: true };
    expect(releasableOrigins(['https://github.com/*'], { sites: EMPTY_CUSTOM_SITES, authorizedHosts: on, paperclip: paperclipOff })).toEqual([]);
    expect(releasableOrigins(['https://github.com/*'], { sites: EMPTY_CUSTOM_SITES, authorizedHosts: off, paperclip: paperclipOff })).toEqual(['https://github.com/*']);
    expect(originsInUse({ sites: EMPTY_CUSTOM_SITES, authorizedHosts: on, paperclip: paperclipOff })).toContain('https://github.com/*');
  });

  it('treats wildcard hosts as overlapping their subdomains', () => {
    expect(patternsOverlap('https://*.example.com/*', 'https://chat.example.com/*')).toBe(true);
    expect(patternsOverlap('https://chat.example.com/*', 'https://*.example.com/*')).toBe(true);
    expect(patternsOverlap('http://localhost/*', 'https://localhost/*')).toBe(false);
    expect(patternsOverlap('https://a.example/*', 'https://b.example/*')).toBe(false);
  });

  it('refuses to add a host a path-routed provider lives on', () => {
    for (const host of ['github.com', 'https://x.com', 'huggingface.co']) {
      const checked = normalizeSiteOrigin(host);
      expect(checked.ok).toBe(false);
      expect(!checked.ok && checked.error).toMatch(/already supported/);
    }
    expect(normalizeSiteOrigin('https://chat.example.com')).toMatchObject({ ok: true });
  });
});

describe('Settings → Capture: removing an added site', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  async function renderAndRemove(paperclip: { enabled: boolean; serverUrl: string }) {
    const React = await import('react');
    const { act } = React;
    const { createRoot } = await import('react-dom/client');
    const { CaptureSettings } = await import('../../src/entrypoints/manager/CaptureSettings.js');
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let stored: Record<string, unknown> = { [CUSTOM_SITES_KEY]: addCustomSite(EMPTY_CUSTOM_SITES, 'http://localhost:3000', NOW) };
    const remove = vi.fn(async () => true);
    const listener = { addListener: () => undefined, removeListener: () => undefined };
    vi.stubGlobal('chrome', {
      runtime: { id: 'ext', sendMessage: vi.fn(async () => undefined) },
      storage: {
        local: {
          get: async (key: string) => ({ [key]: stored[key] }),
          set: async (items: Record<string, unknown>) => {
            stored = { ...stored, ...items };
          },
        },
        onChanged: listener,
      },
      permissions: { contains: async () => true, request: async () => true, remove, onAdded: listener, onRemoved: listener },
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const settings = normalizeSettings({ paperclip: { ...DEFAULT_PAPERCLIP_SETTINGS, ...paperclip } } as never);
    await act(async () => {
      root.render(React.createElement(CaptureSettings, { settings, onPatch: async () => undefined }));
    });
    const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));
    await flush();
    const button = Array.from(container.querySelectorAll('.tk-capture-site button')).find((b) => b.textContent === 'Remove') as HTMLButtonElement;
    expect(button).toBeTruthy();
    await act(async () => button.click());
    for (let i = 0; i < 5; i++) await flush();
    await act(async () => root.unmount());
    return { remove, container };
  }

  it('does not revoke http://localhost/* while Paperclip runs on localhost', async () => {
    const { remove } = await renderAndRemove(paperclipLocal);
    expect(remove).not.toHaveBeenCalled();
  });

  it('revokes it when nothing else needs it', async () => {
    const { remove } = await renderAndRemove(paperclipOff);
    expect(remove).toHaveBeenCalledWith({ origins: ['http://localhost/*'] });
  });
});
