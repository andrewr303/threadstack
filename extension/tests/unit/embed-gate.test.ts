import { describe, expect, it } from 'vitest';
import {
  captureSenderUrl,
  embeddedFrameUrl,
  validateRuntimeMessageSender,
  validateWorkspaceSender,
  type EmbedSenderContext,
  type RuntimeSender,
} from '../../src/core/messaging.js';
import { decideCapture, sanitizeCodingFields } from '../../src/core/capture-gate.js';
import { EMPTY_CUSTOM_SITES, addCustomSite } from '../../src/core/custom-sites.js';
import { DEFAULT_SETTINGS } from '../../src/core/schema.js';
import { EMBED_FRAME_EVENT_TYPES, WORKSPACE_COMMAND_TYPES } from '../../src/core/workspace/types.js';

const EXT = 'aaaabbbbccccddddaaaabbbbccccdddd';
const MANAGER = `chrome-extension://${EXT}/manager.html`;
const WORKSPACE_TAB = 11;

// The senders chrome reports for each place a message can come from.
const workspacePage: RuntimeSender = { id: EXT, url: `${MANAGER}?surface=page`, origin: `chrome-extension://${EXT}`, frameId: 0, tab: { id: WORKSPACE_TAB, url: `${MANAGER}?surface=page` } };
const sidePanel: RuntimeSender = { id: EXT, url: `chrome-extension://${EXT}/sidepanel.html`, origin: `chrome-extension://${EXT}` };
const consentPage: RuntimeSender = { id: EXT, url: `chrome-extension://${EXT}/connect.html`, frameId: 0, tab: { id: 12, url: `chrome-extension://${EXT}/connect.html` } };
/** The in-page overlay: manager.html framed inside a website. */
const overlayFrame: RuntimeSender = { id: EXT, url: `${MANAGER}?surface=overlay`, origin: `chrome-extension://${EXT}`, frameId: 4, tab: { id: 13, url: 'https://chatgpt.com/c/1' } };
/** A provider page embedded in the workspace tab (content script in that frame). */
const embedded = (url = 'https://claude.ai/chat/abc', extra: Partial<RuntimeSender> = {}): RuntimeSender => ({
  id: EXT,
  url,
  origin: new URL(url).origin,
  frameId: 7,
  tab: { id: WORKSPACE_TAB, url: `${MANAGER}?surface=page` },
  ...extra,
});
/** A provider frame inside some other website (a normal tab). */
const providerInWebsite: RuntimeSender = { id: EXT, url: 'https://claude.ai/chat/abc', origin: 'https://claude.ai', frameId: 3, tab: { id: 14, url: 'https://evil.example/' } };
/** A provider's own top-level tab. */
const providerTab = (url = 'https://claude.ai/chat/abc'): RuntimeSender => ({ id: EXT, url, origin: new URL(url).origin, frameId: 0, tab: { id: 15, url } });

const sites = addCustomSite(EMPTY_CUSTOM_SITES, 'http://chat.lan:3000', '2026-11-03T12:00:00.000Z');
const ctx: EmbedSenderContext = {
  extensionId: EXT,
  isWorkspaceTab: (tabId) => tabId === WORKSPACE_TAB,
  isAddedSiteUrl: (url) => new URL(url).origin === 'http://chat.lan:3000',
};
const { extensionId: _ignored, ...ctxNoId } = ctx;

describe('workspace commands: only the manager page as a top-level tab', () => {
  const types = [...WORKSPACE_COMMAND_TYPES];

  it('accepts every workspace command from the workspace page', () => {
    for (const type of types) expect(validateRuntimeMessageSender({ type }, workspacePage, EXT).allowed, type).toBe(true);
  });

  it('refuses the side panel, the consent page, the overlay, embedded frames, websites and other extensions', () => {
    const refused: Array<[string, RuntimeSender]> = [
      ['side panel (no tab)', sidePanel],
      ['consent page', consentPage],
      ['overlay inside a website', overlayFrame],
      ['embedded provider frame', embedded()],
      ['provider frame inside a website', providerInWebsite],
      ['provider tab', providerTab()],
      ['manager framed inside the workspace tab', { ...workspacePage, frameId: 2 }],
      ['other extension', { ...workspacePage, id: 'zzzzbbbbccccddddaaaabbbbccccdddd' }],
      ['no extension id', { ...workspacePage, id: undefined }],
      ['frame id missing', { ...workspacePage, frameId: undefined }],
      ['look-alike page', { ...workspacePage, url: `chrome-extension://${EXT}/manager.html.evil`, tab: { id: 11, url: `chrome-extension://${EXT}/manager.html.evil` } }],
      ['tab is a website', { ...workspacePage, tab: { id: 11, url: 'https://claude.ai/' } }],
    ];
    for (const type of types) {
      for (const [label, sender] of refused) {
        expect(validateRuntimeMessageSender({ type }, sender, EXT, ctxNoId).allowed, `${type} from ${label}`).toBe(false);
      }
    }
  });

  it('ignores an overlay handshake token', () => {
    const token = 't'.repeat(32);
    for (const type of types) {
      expect(validateRuntimeMessageSender({ type, handshakeToken: token }, overlayFrame, EXT).allowed).toBe(false);
    }
    expect(validateWorkspaceSender('ACCOUNTS_ACTIVATE', overlayFrame, EXT)).toMatchObject({ allowed: false, reason: expect.stringMatching(/framed/) });
  });
});

describe('embedded frame events: only pages embedded in a remembered workspace tab', () => {
  const frameOnly = [...EMBED_FRAME_EVENT_TYPES].filter((t) => t !== 'ACCOUNT_IDENTITY');

  it('accepts an embedded https frame and returns its own address', () => {
    expect(embeddedFrameUrl(embedded(), ctx)).toBe('https://claude.ai/chat/abc');
    for (const type of frameOnly) expect(validateRuntimeMessageSender({ type }, embedded(), EXT, ctxNoId).allowed, type).toBe(true);
  });

  it('refuses everything else', () => {
    const refused: Array<[string, RuntimeSender]> = [
      ['workspace page itself', workspacePage],
      ['side panel', sidePanel],
      ['overlay inside a website', overlayFrame],
      ['provider frame inside a website', providerInWebsite],
      ['provider top-level tab', providerTab()],
      ['tab not remembered', embedded(undefined, { tab: { id: 99, url: `${MANAGER}?surface=page` } })],
      ['remembered tab that is no longer manager.html', embedded(undefined, { tab: { id: WORKSPACE_TAB, url: 'https://claude.ai/' } })],
      ['top frame of the tab', embedded(undefined, { frameId: 0 })],
      ['frame id missing', embedded(undefined, { frameId: undefined })],
      ['origin disagrees', embedded(undefined, { origin: 'https://evil.example' })],
      ['origin missing', embedded(undefined, { origin: undefined })],
      ['http on a public host', embedded('http://claude.ai/chat/abc')],
      ['credentials in the address', embedded('https://user:pw@claude.ai/chat/abc')],
      ['another extension', embedded(undefined, { id: 'zzzzbbbbccccddddaaaabbbbccccdddd' })],
      ['not a web page', embedded('chrome-extension://aaaabbbbccccddddaaaabbbbccccdddd/x.html', { origin: `chrome-extension://${EXT}` })],
    ];
    for (const [label, sender] of refused) {
      expect(embeddedFrameUrl(sender, ctx), label).toBeNull();
      for (const type of frameOnly) expect(validateRuntimeMessageSender({ type }, sender, EXT, ctxNoId).allowed, `${type} from ${label}`).toBe(false);
    }
    // Without the worker's embedding context every frame is refused.
    expect(validateRuntimeMessageSender({ type: 'EMBED_HELLO' }, embedded(), EXT).allowed).toBe(false);
  });

  it('accepts plain http only on loopback hosts and on sites the person added', () => {
    expect(embeddedFrameUrl(embedded('http://localhost:3000/c/1'), ctx)).toBe('http://localhost:3000/c/1');
    expect(embeddedFrameUrl(embedded('http://127.0.0.1:8080/'), ctx)).toBe('http://127.0.0.1:8080/');
    expect(embeddedFrameUrl(embedded('http://chat.lan:3000/c/1'), ctx)).toBe('http://chat.lan:3000/c/1');
    expect(embeddedFrameUrl(embedded('http://chat.lan:4000/c/1'), ctx)).toBeNull();
    expect(embeddedFrameUrl(embedded('http://192.168.1.5/'), ctx)).toBeNull();
  });

  it('documents the limit: a provider frame nested inside an embedded page looks the same to the worker', () => {
    // Both report frameId != 0, the workspace tab and their own URL; the worker cannot tell depth.
    // The embed content script therefore reports only when location.ancestorOrigins is exactly
    // [extension origin], and the worker still checks every claim against sender.url.
    const nested = embedded('https://claude.ai/chat/abc', { frameId: 23 });
    expect(embeddedFrameUrl(nested, ctx)).toBe('https://claude.ai/chat/abc');
  });

  it('accepts ACCOUNT_IDENTITY from an embedded frame or a provider tab, only for the provider that owns the page', () => {
    const msg = (provider: string) => ({ type: 'ACCOUNT_IDENTITY', provider });
    expect(validateRuntimeMessageSender(msg('claude'), embedded(), EXT, ctxNoId).allowed).toBe(true);
    expect(validateRuntimeMessageSender(msg('claude'), providerTab(), EXT, ctxNoId).allowed).toBe(true);
    expect(validateRuntimeMessageSender(msg('chatgpt'), providerTab('https://chatgpt.com/c/1'), EXT, ctxNoId).allowed).toBe(true);
    // A page cannot speak for another provider.
    expect(validateRuntimeMessageSender(msg('chatgpt'), embedded(), EXT, ctxNoId).allowed).toBe(false);
    expect(validateRuntimeMessageSender(msg('chatgpt'), providerTab(), EXT, ctxNoId).allowed).toBe(false);
    expect(validateRuntimeMessageSender(msg('nonsense'), providerTab(), EXT, ctxNoId).allowed).toBe(false);
    // Not from a provider frame inside some website, an added site, the overlay or a plain-http tab.
    expect(validateRuntimeMessageSender(msg('claude'), providerInWebsite, EXT, ctxNoId).allowed).toBe(false);
    expect(validateRuntimeMessageSender(msg('custom_web'), providerTab('https://chat.example.com/'), EXT, ctxNoId).allowed).toBe(false);
    expect(validateRuntimeMessageSender(msg('claude'), overlayFrame, EXT, ctxNoId).allowed).toBe(false);
    expect(validateRuntimeMessageSender(msg('claude'), { ...providerTab(), url: 'http://claude.ai/', origin: 'http://claude.ai' }, EXT, ctxNoId).allowed).toBe(false);
  });

  it('leaves the existing classes alone', () => {
    expect(validateRuntimeMessageSender({ type: 'GET_CAPTURE_SITE' }, providerTab(), EXT).allowed).toBe(true);
    expect(validateRuntimeMessageSender({ type: 'DOCK_GET_STATE' }, workspacePage, EXT).allowed).toBe(true);
    expect(validateRuntimeMessageSender({ type: 'DOCK_GET_STATE' }, embedded(), EXT, ctxNoId).allowed).toBe(false);
  });
});

describe('capture gate for embedded frames', () => {
  const auth = DEFAULT_SETTINGS.authorizedHosts;
  const base = { authorizedHosts: auth, sites, grant: null, now: 1000 };

  it('accepts an embedded provider page, checked against the frame URL, and flags it', () => {
    expect(captureSenderUrl(embedded())).toBeNull();
    expect(captureSenderUrl(embedded(), ctx)).toBe('https://claude.ai/chat/abc');
    const d = decideCapture({ ...base, embed: ctx, payload: { provider: 'claude', sourceConversationId: 'abc' }, sender: embedded() });
    expect(d).toMatchObject({ ok: true, provider: 'claude', embedded: true, canonicalUrl: 'https://claude.ai/chat/abc' });
    // Without the context the same frame is refused, as before.
    expect(decideCapture({ ...base, payload: { provider: 'claude', sourceConversationId: 'abc' }, sender: embedded() })).toMatchObject({ ok: false });
    // A top-frame capture is not embedded.
    const top = decideCapture({ ...base, embed: ctx, payload: { provider: 'claude', sourceConversationId: 'abc' }, sender: providerTab() });
    expect(top).toMatchObject({ ok: true, embedded: false });
  });

  it('checks the provider against the frame, never the tab', () => {
    // The tab is Threadkeeper's own page; the frame is ChatGPT, so it cannot file a Claude thread.
    expect(decideCapture({ ...base, embed: ctx, payload: { provider: 'claude', sourceConversationId: 'c1' }, sender: embedded('https://chatgpt.com/c/c1') })).toMatchObject({
      ok: false,
      error: expect.stringMatching(/Claude page/),
    });
  });

  it('refuses provider frames inside other websites and unremembered tabs', () => {
    expect(decideCapture({ ...base, embed: ctx, payload: { provider: 'claude', sourceConversationId: 'abc' }, sender: providerInWebsite })).toMatchObject({ ok: false });
    const stray = embedded(undefined, { tab: { id: 99, url: MANAGER } });
    expect(decideCapture({ ...base, embed: ctx, payload: { provider: 'claude', sourceConversationId: 'abc' }, sender: stray })).toMatchObject({ ok: false });
  });

  it('keeps explicit-only capture explicit: an embedded X Chat gets nothing, even with a grant on the tab', () => {
    const on = { ...auth, grok_bot: true };
    const token = 't'.repeat(32);
    const grant = { token, kind: 'capture' as const, expiresAt: 5000 };
    const sender = embedded('https://x.com/i/chat/1-2');
    expect(decideCapture({ ...base, authorizedHosts: on, embed: ctx, payload: { provider: 'grok_bot', sourceConversationId: '1-2' }, sender })).toEqual({ ok: false, skipped: 'explicit_only' });
    expect(
      decideCapture({ ...base, authorizedHosts: on, embed: ctx, payload: { provider: 'grok_bot', sourceConversationId: '1-2' }, sender, explicitToken: token, grant })
    ).toEqual({ ok: false, skipped: 'explicit_only' });
  });

  it('lets an embedded added site through the added-site rules', () => {
    const payload = { provider: 'open_webui', sourceConversationId: 'chat.lan-3000~c1' };
    expect(decideCapture({ ...base, embed: ctx, payload, sender: embedded('http://chat.lan:3000/c/c1') })).toMatchObject({ ok: true, embedded: true, site: { origin: 'http://chat.lan:3000' } });
  });
});

describe('coding fields of a capture', () => {
  it('keeps valid values in normalized form and drops the rest', () => {
    expect(
      sanitizeCodingFields({
        repository: 'https://github.com/Acme/App/pull/3',
        pullRequestUrl: 'https://www.github.com/Acme/App/pull/3?x=1',
        gitBranch: ' feature/login-fix ',
        agentState: 'waiting_permission',
      })
    ).toEqual({ repository: 'acme/app', pullRequestUrl: 'https://github.com/acme/app/pull/3', gitBranch: 'feature/login-fix', agentState: 'waiting_permission' });
    expect(
      sanitizeCodingFields({
        repository: 'not a repo / with spaces / and more',
        pullRequestUrl: 'https://evil.example/acme/app/pull/3',
        gitBranch: 'bad branch',
        agentState: 'hacked',
      })
    ).toEqual({});
    expect(sanitizeCodingFields({ repository: 42, pullRequestUrl: null, gitBranch: 'x'.repeat(251), agentState: undefined })).toEqual({});
    expect(sanitizeCodingFields({ gitBranch: 'a\u0000b' })).toEqual({});
    expect(sanitizeCodingFields({ repository: 'x'.repeat(401) })).toEqual({});
    expect(sanitizeCodingFields(null)).toEqual({});
  });
});
