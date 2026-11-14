import { describe, expect, it, vi } from 'vitest';
import {
  CUSTOM_SITES_KEY,
  EMPTY_CUSTOM_SITES,
  addCustomSite,
  fnv1a32Hex,
  matchCustomSite,
  normalizeCustomSites,
  normalizeSiteOrigin,
  originMatchPattern,
  planCaptureScripts,
  providerScriptId,
  readCustomSites,
  reconcileCaptureScripts,
  removeCustomSite,
  siteConversationKey,
  siteScriptId,
  writeCustomSites,
  type CaptureScript,
} from '../../src/core/custom-sites.js';
import { decideCapture, type ExplicitGrant } from '../../src/core/capture-gate.js';
import { captureSenderUrl, validateRuntimeMessageSender } from '../../src/core/messaging.js';
import { DEFAULT_SETTINGS } from '../../src/core/schema.js';

const NOW = '2026-11-03T12:00:00.000Z';

describe('added sites: origins', () => {
  it('normalizes what the user types into an exact origin', () => {
    expect(normalizeSiteOrigin('https://chat.example.com/c/123?x=1')).toEqual({ ok: true, origin: 'https://chat.example.com', host: 'chat.example.com' });
    expect(normalizeSiteOrigin('chat.example.com')).toMatchObject({ ok: true, origin: 'https://chat.example.com' });
    expect(normalizeSiteOrigin('localhost:3000')).toMatchObject({ ok: true, origin: 'http://localhost:3000' });
    expect(normalizeSiteOrigin('http://192.168.1.20:8080/')).toMatchObject({ ok: true, origin: 'http://192.168.1.20:8080' });
    expect(normalizeSiteOrigin('http://nas.local')).toMatchObject({ ok: true });
  });

  it('refuses public plain-http, non-web schemes, credentials and providers Threadkeeper already lists', () => {
    expect(normalizeSiteOrigin('http://chat.example.com')).toMatchObject({ ok: false });
    expect(normalizeSiteOrigin('file:///etc/passwd')).toMatchObject({ ok: false });
    expect(normalizeSiteOrigin('chrome://extensions')).toMatchObject({ ok: false });
    expect(normalizeSiteOrigin('https://user:pw@chat.example.com')).toMatchObject({ ok: false });
    expect(normalizeSiteOrigin('')).toMatchObject({ ok: false });
    const known = normalizeSiteOrigin('https://poe.com/chat/abc');
    expect(known.ok).toBe(false);
    expect(!known.ok && known.error).toMatch(/Poe is already supported/);
  });

  it('uses host-wide match patterns, host-and-port conversation keys, and stable script ids', () => {
    expect(originMatchPattern('http://localhost:3000')).toBe('http://localhost/*');
    expect(siteConversationKey('http://localhost:3000')).toBe('localhost-3000');
    expect(siteConversationKey('https://Chat.Example.com')).toBe('chat.example.com');
    expect(siteScriptId('https://a.example')).toBe(`tk-site-${fnv1a32Hex('https://a.example')}`);
    expect(fnv1a32Hex('')).toBe('811c9dc5');
  });
});

describe('added sites: list', () => {
  it('adds, dedupes, removes and matches by exact origin (port included)', () => {
    let state = addCustomSite(EMPTY_CUSTOM_SITES, 'http://localhost:3000/c/1', NOW);
    state = addCustomSite(state, 'localhost:3000', NOW, 'Open WebUI');
    expect(state.sites).toEqual([{ origin: 'http://localhost:3000', label: 'Open WebUI', addedAt: NOW, enabled: true }]);
    expect(matchCustomSite(state, 'http://localhost:3000/c/abc')?.origin).toBe('http://localhost:3000');
    expect(matchCustomSite(state, 'http://localhost:3001/c/abc')).toBeNull();
    expect(matchCustomSite(state, 'not a url')).toBeNull();
    expect(removeCustomSite(state, 'http://localhost:3000').sites).toEqual([]);
    expect(() => addCustomSite(state, 'http://public.example.com', NOW)).toThrow(/https/);
  });

  it('drops malformed, duplicate and unsafe stored rows', () => {
    const state = normalizeCustomSites({
      sites: [
        { origin: 'https://a.example', label: 'A', addedAt: NOW },
        { origin: 'https://a.example' },
        { origin: 'https://a.example/path' },
        { origin: 'http://public.example' },
        { origin: 42 },
        null,
        { origin: 'https://b.example', enabled: false },
      ],
    });
    expect(state.sites.map((s) => [s.origin, s.enabled])).toEqual([
      ['https://a.example', true],
      ['https://b.example', false],
    ]);
    expect(matchCustomSite(state, 'https://b.example/x')).toBeNull();
    expect(normalizeCustomSites('garbage')).toEqual(EMPTY_CUSTOM_SITES);
  });

  it('reads and writes through chrome.storage', async () => {
    const store: Record<string, unknown> = {};
    const storage = {
      get: async (key: string) => ({ [key]: store[key] }),
      set: async (items: Record<string, unknown>) => void Object.assign(store, items),
    };
    await writeCustomSites(storage, addCustomSite(EMPTY_CUSTOM_SITES, 'https://a.example', NOW));
    expect((store[CUSTOM_SITES_KEY] as { sites: unknown[] }).sites).toHaveLength(1);
    expect((await readCustomSites(storage)).sites[0].origin).toBe('https://a.example');
    expect(await readCustomSites(undefined)).toEqual(EMPTY_CUSTOM_SITES);
  });
});

describe('runtime content scripts', () => {
  const sites = addCustomSite(addCustomSite(EMPTY_CUSTOM_SITES, 'http://localhost:3000', NOW), 'http://localhost:8080', NOW).sites;

  it('registers enabled, granted providers and sites; one set of scripts per host; removes the rest', () => {
    const plan = planCaptureScripts({
      authorizedHosts: { poe: true, meta_ai: true, kimi: true, chatgpt: true, muse: false },
      sites,
      granted: (origins) => !origins.includes('https://www.meta.ai/*'),
      registered: [
        { id: 'tk-provider-muse', matches: ['https://muse.ai/*'] },
        { id: 'tk-provider-poe', matches: ['https://old.poe.com/*'] },
        { id: 'someone-else', matches: ['https://x/*'] },
      ],
    });
    expect(plan.unregister).toEqual(['tk-provider-muse']);
    expect(plan.update.map((s) => s.id)).toEqual(['tk-provider-poe']);
    const site = siteScriptId('http://localhost:3000');
    expect(plan.register.map((s) => [s.id, s.matches])).toEqual([
      ['tk-provider-kimi', ['https://www.kimi.ai/*']],
      ['tk-provider-kimi~bridge', ['https://www.kimi.ai/*']],
      ['tk-provider-kimi~cookie-main', ['https://www.kimi.ai/*']],
      ['tk-provider-poe~bridge', ['https://poe.com/*']],
      ['tk-provider-poe~cookie-main', ['https://poe.com/*']],
      [site, ['http://localhost/*']],
      [`${site}~bridge`, ['http://localhost/*']],
      [`${site}~cookie-main`, ['http://localhost/*']],
    ]);
    // content.js keeps the id it always had; every script runs in all frames (the workspace embeds these pages).
    const byId = new Map([...plan.register, ...plan.update].map((s) => [s.id, s]));
    expect(byId.get('tk-provider-kimi')).toEqual({
      id: 'tk-provider-kimi',
      matches: ['https://www.kimi.ai/*'],
      js: ['content-scripts/content.js'],
      runAt: 'document_idle',
      allFrames: true,
      persistAcrossSessions: true,
    });
    expect(byId.get('tk-provider-kimi~bridge')).toMatchObject({ js: ['content-scripts/embed-bridge.js'], runAt: 'document_start', allFrames: true });
    expect(byId.get('tk-provider-kimi~bridge')?.world).toBeUndefined();
    expect(byId.get('tk-provider-kimi~cookie-main')).toMatchObject({ js: ['content-scripts/embed-cookie-main.js'], runAt: 'document_start', allFrames: true, world: 'MAIN' });
    for (const s of [...plan.register, ...plan.update]) expect(s).toMatchObject({ allFrames: true, persistAcrossSessions: true });
  });

  it('re-registers a script registered top-frame-only by an older version', () => {
    const scripts = planCaptureScripts({ authorizedHosts: { kimi: true }, sites: [], granted: () => true, registered: [] }).register;
    const current = scripts.map((s) => ({ ...s }));
    const old = current.map((s) => (s.id === 'tk-provider-kimi' ? { ...s, allFrames: false } : s));
    expect(planCaptureScripts({ authorizedHosts: { kimi: true }, sites: [], granted: () => true, registered: current })).toEqual({ register: [], unregister: [], update: [] });
    const plan = planCaptureScripts({ authorizedHosts: { kimi: true }, sites: [], granted: () => true, registered: old });
    expect(plan.update.map((s) => s.id)).toEqual(['tk-provider-kimi']);
    expect(plan.register).toEqual([]);
    // Chrome reports the isolated world explicitly; that is the same as leaving it out.
    const reported = current.map((s) => ({ ...s, world: s.world ?? 'ISOLATED' }));
    expect(planCaptureScripts({ authorizedHosts: { kimi: true }, sites: [], granted: () => true, registered: reported }).update).toEqual([]);
  });

  it('reconciles through the chrome APIs and reports failures instead of throwing', async () => {
    const registered: CaptureScript[] = [];
    const env = {
      getRegistered: vi.fn(async () => registered.map((s) => ({ ...s }))),
      register: vi.fn(async (scripts: CaptureScript[]) => void registered.push(...scripts)),
      unregister: vi.fn(async (ids: string[]) => {
        for (const id of ids) registered.splice(registered.findIndex((s) => s.id === id), 1);
      }),
      contains: vi.fn(async () => true),
    };
    const poe = providerScriptId('poe');
    const first = await reconcileCaptureScripts(env, { authorizedHosts: { poe: true }, sites: [] });
    expect(first.registered).toEqual([poe, `${poe}~bridge`, `${poe}~cookie-main`]);
    const second = await reconcileCaptureScripts(env, { authorizedHosts: { poe: true }, sites: [] });
    expect(second).toEqual({ registered: [], unregistered: [] });
    const third = await reconcileCaptureScripts(env, { authorizedHosts: { poe: false }, sites: [] });
    expect(third.unregistered).toEqual([poe, `${poe}~bridge`, `${poe}~cookie-main`]);
    env.getRegistered.mockRejectedValueOnce(new Error('scripting unavailable'));
    expect((await reconcileCaptureScripts(env, { authorizedHosts: {}, sites: [] })).error).toBe('scripting unavailable');
  });
});

describe('capture sender rules', () => {
  const tab = { id: 7, url: 'https://chatgpt.com/c/1' };

  it('accepts only the top frame of an http(s) page whose origin agrees', () => {
    expect(captureSenderUrl({ tab, url: 'https://chatgpt.com/c/1', frameId: 0, origin: 'https://chatgpt.com' })).toBe('https://chatgpt.com/c/1');
    expect(captureSenderUrl({ tab, url: 'https://chatgpt.com/c/1', frameId: 3 })).toBeNull();
    expect(captureSenderUrl({ tab, url: 'https://chatgpt.com/c/1', origin: 'https://evil.example' })).toBeNull();
    expect(captureSenderUrl({ url: 'https://chatgpt.com/c/1' })).toBeNull();
    expect(captureSenderUrl({ tab, url: 'chrome-extension://abc/manager.html' })).toBeNull();
    expect(captureSenderUrl(undefined)).toBeNull();
  });

  it('lets content scripts ask about their site but keeps site edits for extension pages', () => {
    expect(validateRuntimeMessageSender({ type: 'GET_CAPTURE_SITE' }, { tab, url: tab.url }, 'ext').allowed).toBe(true);
    expect(validateRuntimeMessageSender({ type: 'CAPTURE_SITES_CHANGED' }, { tab, url: tab.url }, 'ext').allowed).toBe(false);
    expect(validateRuntimeMessageSender({ type: 'CAPTURE_TAB_NOW' }, { id: 'ext', url: 'chrome-extension://ext/sidepanel.html' }, 'ext').allowed).toBe(true);
  });
});

describe('capture decisions', () => {
  const sites = addCustomSite(EMPTY_CUSTOM_SITES, 'http://localhost:3000', NOW);
  const auth = DEFAULT_SETTINGS.authorizedHosts;
  const sender = (url: string, frameId = 0) => ({ tab: { id: 1, url }, url, frameId });
  const base = { authorizedHosts: auth, sites, grant: null, now: 1000 };
  const grant = (kind: ExplicitGrant['kind']): ExplicitGrant => ({ token: 't'.repeat(32), kind, expiresAt: 5000 });

  it('accepts a provider capture from its own page and keeps a valid canonical URL', () => {
    const d = decideCapture({ ...base, payload: { provider: 'chatgpt', sourceConversationId: 'c1', canonicalUrl: 'https://chatgpt.com/c/c1' }, sender: sender('https://chatgpt.com/c/c1') });
    expect(d).toMatchObject({ ok: true, provider: 'chatgpt', canonicalUrl: 'https://chatgpt.com/c/c1', explicit: false });
  });

  it('rejects a page filing itself under another provider, iframes, and bad ids', () => {
    expect(decideCapture({ ...base, payload: { provider: 'claude', sourceConversationId: 'c1' }, sender: sender('https://chatgpt.com/c/c1') })).toMatchObject({ ok: false, error: expect.stringMatching(/Claude page/) });
    expect(decideCapture({ ...base, payload: { provider: 'chatgpt', sourceConversationId: 'c1' }, sender: sender('https://chatgpt.com/c/c1', 2) })).toMatchObject({ ok: false });
    expect(decideCapture({ ...base, payload: { provider: 'imported', sourceConversationId: 'c1' }, sender: sender('https://chatgpt.com/c/c1') })).toMatchObject({ ok: false });
    expect(decideCapture({ ...base, payload: { provider: 'paperclip', sourceConversationId: 'c1' }, sender: sender('http://localhost:3100/PAP/issues/PAP-1') })).toMatchObject({ ok: false, error: 'Unknown capture provider' });
    expect(decideCapture({ ...base, payload: { provider: 'chatgpt', sourceConversationId: '' }, sender: sender('https://chatgpt.com/c/c1') })).toMatchObject({ ok: false });
    expect(decideCapture({ ...base, payload: { provider: 'chatgpt', sourceConversationId: 'x'.repeat(301) }, sender: sender('https://chatgpt.com/c/c1') })).toMatchObject({ ok: false });
  });

  it('replaces a canonical URL that points elsewhere with the sender page', () => {
    const d = decideCapture({ ...base, payload: { provider: 'chatgpt', sourceConversationId: 'c1', canonicalUrl: 'https://evil.example/phish' }, sender: sender('https://chatgpt.com/c/c1?x=1') });
    expect(d).toMatchObject({ ok: true, canonicalUrl: 'https://chatgpt.com/c/c1' });
  });

  it('skips a provider that is off, unless the user asked for this tab with a live token', () => {
    const off = { ...auth, poe: false };
    const payload = { provider: 'poe', sourceConversationId: 'p1' };
    expect(decideCapture({ ...base, authorizedHosts: off, payload, sender: sender('https://poe.com/chat/p1') })).toEqual({ ok: false, skipped: 'provider_not_authorized' });
    // A content script saying "explicit" proves nothing without the background's token.
    expect(decideCapture({ ...base, authorizedHosts: off, payload, explicitToken: 'forged-token-forged-token', sender: sender('https://poe.com/chat/p1'), grant: grant('overlay') })).toMatchObject({ ok: false });
    expect(decideCapture({ ...base, authorizedHosts: off, payload, explicitToken: 't'.repeat(32), sender: sender('https://poe.com/chat/p1'), grant: grant('overlay') })).toMatchObject({ ok: true, explicit: true });
    expect(decideCapture({ ...base, now: 9999, authorizedHosts: off, payload, explicitToken: 't'.repeat(32), sender: sender('https://poe.com/chat/p1'), grant: grant('overlay') })).toMatchObject({ ok: false });
  });

  it('saves Grok Bot chats only when on and the user chose "Capture this tab"', () => {
    const payload = { provider: 'grok_bot', sourceConversationId: '1-2' };
    const page = sender('https://x.com/i/chat/1-2');
    const token = 't'.repeat(32);
    expect(decideCapture({ ...base, payload, sender: page, explicitToken: token, grant: grant('capture') })).toEqual({ ok: false, skipped: 'provider_not_authorized' });
    const on = { ...auth, grok_bot: true };
    expect(decideCapture({ ...base, authorizedHosts: on, payload, sender: page })).toEqual({ ok: false, skipped: 'explicit_only' });
    expect(decideCapture({ ...base, authorizedHosts: on, payload, sender: page, explicitToken: token, grant: grant('overlay') })).toEqual({ ok: false, skipped: 'explicit_only' });
    expect(decideCapture({ ...base, authorizedHosts: on, payload, sender: page, explicitToken: token, grant: grant('capture') })).toMatchObject({ ok: true, provider: 'grok_bot' });
  });

  it('accepts added-site captures only from that exact origin and only with its own id prefix', () => {
    const payload = { provider: 'open_webui', sourceConversationId: 'localhost-3000~c1', canonicalUrl: 'http://localhost:3000/c/c1' };
    expect(decideCapture({ ...base, payload, sender: sender('http://localhost:3000/c/c1') })).toMatchObject({ ok: true, provider: 'open_webui', site: { origin: 'http://localhost:3000' } });
    expect(decideCapture({ ...base, payload, sender: sender('http://localhost:4000/c/c1') })).toEqual({ ok: false, skipped: 'site_not_added' });
    expect(decideCapture({ ...base, payload: { ...payload, sourceConversationId: 'chatgpt.com~c1' }, sender: sender('http://localhost:3000/c/c1') })).toMatchObject({ ok: false, error: expect.any(String) });
    // A known provider page cannot claim to be a custom site.
    expect(decideCapture({ ...base, payload: { provider: 'custom_web', sourceConversationId: 'chatgpt.com~c1' }, sender: sender('https://chatgpt.com/c/c1') })).toEqual({ ok: false, skipped: 'site_not_added' });
    // A site cannot claim to be a provider.
    expect(decideCapture({ ...base, payload: { provider: 'chatgpt', sourceConversationId: 'c1' }, sender: sender('http://localhost:3000/c/c1') })).toMatchObject({ ok: false });
    const foreign = decideCapture({ ...base, payload: { ...payload, canonicalUrl: 'https://evil.example/' }, sender: sender('http://localhost:3000/c/c1?utm=1') });
    expect(foreign).toMatchObject({ ok: true, canonicalUrl: 'http://localhost:3000/c/c1' });
  });

  it('accepts self-hosted LobeChat on an added site, and still checks its hosted page as a provider', () => {
    const lobeSites = addCustomSite(EMPTY_CUSTOM_SITES, 'https://lobe.example.com', NOW);
    const payload = { provider: 'lobechat', sourceConversationId: 'lobe.example.com~s1_t1', canonicalUrl: 'https://lobe.example.com/chat?session=s1&topic=t1' };
    const page = sender('https://lobe.example.com/chat?session=s1&topic=t1');
    expect(decideCapture({ ...base, sites: lobeSites, payload, sender: page })).toMatchObject({
      ok: true,
      provider: 'lobechat',
      sourceConversationId: 'lobe.example.com~s1_t1',
      canonicalUrl: 'https://lobe.example.com/chat?session=s1&topic=t1',
      site: { origin: 'https://lobe.example.com' },
    });
    // The id must carry that site's prefix; an origin the user did not add is not a LobeChat page.
    expect(decideCapture({ ...base, sites: lobeSites, payload: { ...payload, sourceConversationId: 'other.example~s1' }, sender: page })).toMatchObject({ ok: false, error: expect.any(String) });
    expect(decideCapture({ ...base, sites: EMPTY_CUSTOM_SITES, payload, sender: page })).toMatchObject({ ok: false, error: expect.stringMatching(/LobeChat page/) });
    // The hosted app keeps the provider rules (off by default, no site prefix).
    const hosted = { provider: 'lobechat', sourceConversationId: 's1_t1' };
    const hostedPage = sender('https://app.lobehub.com/chat?session=s1&topic=t1');
    expect(decideCapture({ ...base, sites: lobeSites, payload: hosted, sender: hostedPage })).toMatchObject({ ok: false, skipped: 'provider_not_authorized' });
    expect(decideCapture({ ...base, sites: lobeSites, authorizedHosts: { ...auth, lobechat: true }, payload: hosted, sender: hostedPage })).toMatchObject({ ok: true, provider: 'lobechat', site: null });
  });
});
