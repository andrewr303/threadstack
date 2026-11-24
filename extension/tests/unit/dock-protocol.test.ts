import { describe, it, expect } from 'vitest';
import {
  PROTO,
  checkEnvelope,
  chatItemId,
  isExtensionId,
  oneLine,
  parseContext,
  parseFilters,
  parseGet,
  parsePairRequest,
  parseSearch,
  parseSyncConfigure,
  readChatsStatus,
  readCollections,
  readResponse,
  readUpsertResults,
  sanitizeAppName,
  threadCiteId,
  threadHash,
  BadRequest,
} from '../../src/core/dock/protocol.js';
import { validateDockSender } from '../../src/core/dock/external.js';
import { validateDockPageSender, validateRuntimeMessageSender } from '../../src/core/messaging.js';
import { normalizeSidebarDock, normalizeSettings } from '../../src/core/schema.js';
import { PROVIDERS, providerCategory, PROVIDER_IDS } from '../../src/core/providers.js';
import { codeMatches, expiresInLabel, groupedId, normalizeCodeInput } from '../../src/entrypoints/connect/consent.js';
import { codeHashFor } from '../../src/core/dock/state.js';

const STILL = 'abcdefghijklmnopabcdefghijklmnop';
const TK = 'aaaabbbbccccddddaaaabbbbccccdddd';

describe('ids (shared vectors with Still)', () => {
  it('threadHash matches the protocol test vectors exactly', () => {
    expect(threadHash('chatgpt:acct_chatgpt_primary:ws_personal:abc:main')).toBe('a8165e07c2949d16a9c49f5c0e061c8a');
    expect(threadHash('claude_code:acct_claude_code_primary:ws_personal:5f0c-ü/x y:main')).toBe('ec30122ef1e1608ee0a26be36b1ad12a');
  });

  it('derives chat ids and cite ids from the hash', () => {
    const key = 'chatgpt:acct_chatgpt_primary:ws_personal:abc:main';
    expect(chatItemId(key)).toBe('chat_tk_a8165e07c2949d16a9c49f5c0e061c8a');
    expect(threadCiteId(key)).toBe('tk:a8165e07c2949d16');
    expect(chatItemId(key)).toMatch(/^[\w:.-]{1,200}$/);
    expect(threadCiteId(key)).toMatch(/^[\w:.-]{1,200}$/);
  });

  it('accepts only 32-character a-p extension ids', () => {
    expect(isExtensionId(STILL)).toBe(true);
    expect(isExtensionId('abc')).toBe(false);
    expect(isExtensionId('abcdefghijklmnopabcdefghijklmnoz')).toBe(false);
  });
});

describe('envelope and field validation', () => {
  it('checks proto, from and the type allowlist', () => {
    expect(checkEnvelope(null)).toMatchObject({ ok: false, code: 'bad_request' });
    expect(checkEnvelope({ proto: 'still-threadstack/2', from: 'still', type: 'hello' })).toMatchObject({ ok: false, code: 'version_mismatch' });
    expect(checkEnvelope({ proto: PROTO, from: 'threadkeeper', type: 'hello' })).toMatchObject({ ok: false, code: 'bad_request' });
    expect(checkEnvelope({ proto: PROTO, from: 'still', type: 'threads.upsert' })).toMatchObject({ ok: false, code: 'unsupported' });
    expect(checkEnvelope({ proto: PROTO, from: 'still', type: 'hello', requestId: 'x' })).toMatchObject({ ok: true, type: 'hello' });
  });

  it('validates pair.request and sanitizes the self-declared name', () => {
    const r = parsePairRequest({ appName: 'Still‮ evil\n\tname that goes on and on and on forever', appVersion: '1.2', code: '123456', epoch: 'e-1', requestId: 'req-12345678' });
    expect(r.appName).not.toMatch(/[‮\n\t]/);
    expect(r.appName.length).toBeLessThanOrEqual(40);
    expect(() => parsePairRequest({ code: '12345', requestId: 'req-12345678' })).toThrow(BadRequest);
    expect(() => parsePairRequest({ code: '123456' })).toThrow(/requestId/);
    expect(sanitizeAppName('\u0000Still⁦')).toBe('Still');
    expect(oneLine('a\nb', 10)).toBe('a b');
  });

  it('caps and validates filters', () => {
    expect(parseFilters({ categories: ['coding_agent'], states: ['done'], since: '2026-10-01' })).toEqual({
      categories: ['coding_agent'],
      states: ['done'],
      since: '2026-10-01T00:00:00.000Z',
    });
    expect(() => parseFilters({ categories: ['robots'] })).toThrow(BadRequest);
    expect(() => parseFilters({ hashes: ['zz'] })).toThrow(BadRequest);
    expect(() => parseFilters({ providers: 'chatgpt' })).toThrow(BadRequest);
    expect(() => parseFilters({ threadKeys: new Array(501).fill('k') })).toThrow(/more than 500/);
  });

  it('clamps search and context limits and budgets', () => {
    const s = parseSearch({ query: ' x ', limit: 500, deadlineMs: 60_000 });
    expect(s).toMatchObject({ query: 'x', limit: 50, deadlineMs: 12_000, semantic: 'local', rerank: 'auto' });
    const c = parseContext({ question: 'why', limit: 99, budgetChars: 99_999, deadlineMs: 99_999 });
    expect(c).toMatchObject({ limit: 8, budgetChars: 24_000, deadlineMs: 9000, semantic: 'local', rerank: 'off' });
    expect(() => parseContext({})).toThrow(/question/);
    expect(() => parseSearch({ semantic: 'cloud' })).toThrow(BadRequest);
  });

  it('validates threads.get identifiers and windows', () => {
    const g = parseGet({ citeIds: ['tk:0123456789abcdef'], hashes: ['0123456789abcdef0123456789abcdef'], transcript: 'window', window: { from: 3, count: 9999 } });
    expect(g.ids.map((i) => i.kind)).toEqual(['citeId', 'hash']);
    expect(g.window).toEqual({ from: 3, count: 500 });
    expect(() => parseGet({})).toThrow(BadRequest);
    expect(() => parseGet({ citeIds: ['tk:nothex'] })).toThrow(BadRequest);
    expect(() => parseGet({ threadKeys: new Array(21).fill(0).map((_, i) => `k${i}`) })).toThrow(BadRequest);
  });

  it('validates sync prefs', () => {
    expect(parseSyncConfigure({ prefs: { scope: 'projects', projects: ['A'], transcripts: false }, epoch: 'e1' })).toEqual({
      prefs: { scope: 'projects', projects: ['A'], providers: [], transcripts: false, autoUpdate: true },
      epoch: 'e1',
    });
    expect(() => parseSyncConfigure({ prefs: { scope: 'everything' } })).toThrow(BadRequest);
    expect(() => parseSyncConfigure({ prefs: { scope: 'all' }, epoch: 'bad epoch!' })).toThrow(BadRequest);
  });
});

describe("Still's responses are validated too", () => {
  it('maps malformed answers to typed errors', () => {
    expect(readResponse(undefined)).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(readResponse({ ok: false, error: { code: 'weird', message: 'x' } })).toMatchObject({ ok: false, error: { code: 'internal' } });
    expect(readResponse({ ok: false, error: { code: 'busy', retryAfterMs: 1e12 } })).toMatchObject({ ok: false, error: { code: 'busy', retryAfterMs: 600_000 } });
    expect(readResponse({ ok: true, proto: 'other' })).toMatchObject({ ok: false, error: { code: 'version_mismatch' } });
    expect(readResponse({ ok: true, proto: PROTO, x: 1 })).toMatchObject({ ok: true });
  });

  it('keeps only results for threads that were sent', () => {
    const r = readUpsertResults(
      { results: [{ threadKey: 'a', status: 'created', itemId: 'chat_tk_1', needsTranscript: true }, { threadKey: 'z', status: 'created' }, { threadKey: 'a', status: 'exploded' }, 'junk'] },
      new Set(['a'])
    );
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ threadKey: 'a', status: 'created', needsTranscript: true });
  });

  it('sanitizes collections and chat status', () => {
    expect(readCollections({ collections: [{ id: 'c1', name: 'Work‮', path: 'Work' }, { id: 'bad id!', name: 'x' }, { id: 'c2', name: '' }] })).toEqual([
      { id: 'c1', name: 'Work', parentId: '', path: 'Work', icon: '', color: '' },
    ]);
    const status = readChatsStatus({ chats: { a: { itemId: 'chat_tk_1', trashed: true }, b: { itemId: 'x' } } }, new Set(['a']));
    expect(Object.keys(status)).toEqual(['a']);
    expect(status.a.trashed).toBe(true);
  });
});

describe('sender rules', () => {
  it('accepts only extension pages of the claimed id (url with slash or origin), never tabs', () => {
    expect(validateDockSender({ id: STILL, url: `chrome-extension://${STILL}/index.html` }, TK)).toEqual({ ok: true, id: STILL });
    expect(validateDockSender({ id: STILL, origin: `chrome-extension://${STILL}` }, TK)).toEqual({ ok: true, id: STILL });
    // Content script of Still on a web page.
    expect(validateDockSender({ id: STILL, url: 'https://evil.example/', tab: { id: 3 } }, TK).ok).toBe(false);
    expect(validateDockSender({ id: STILL, url: `chrome-extension://${STILL}/index.html`, tab: { id: 3 } }, TK).ok).toBe(false);
    // Prefix trick without the slash.
    expect(validateDockSender({ id: STILL, url: `chrome-extension://${STILL}evil/x.html` }, TK).ok).toBe(false);
    // Another id's page.
    expect(validateDockSender({ id: STILL, url: `chrome-extension://${TK}/x.html` }, TK).ok).toBe(false);
    expect(validateDockSender({ id: TK, url: `chrome-extension://${TK}/x.html` }, TK).ok).toBe(false);
    expect(validateDockSender({ url: 'https://x' }, TK).ok).toBe(false);
    expect(validateDockSender(null, TK).ok).toBe(false);
  });

  it('accepts DOCK_* from manager, side panel and connect.html; keeps .html.evil rejected', () => {
    for (const page of ['manager.html', 'sidepanel.html', 'connect.html', 'connect.html?x=1']) {
      expect(validateRuntimeMessageSender({ type: 'DOCK_GET_STATE' }, { id: TK, url: `chrome-extension://${TK}/${page}` }, TK).allowed).toBe(true);
    }
    expect(validateRuntimeMessageSender({ type: 'DOCK_DECIDE' }, { id: TK, url: `chrome-extension://${TK}/connect.html.evil` }, TK).allowed).toBe(false);
    expect(validateRuntimeMessageSender({ type: 'DOCK_SEND' }, { id: TK, url: 'https://claude.ai/', tab: { id: 1 } }, TK).allowed).toBe(false);
    expect(validateRuntimeMessageSender({ type: 'DOCK_GET_STATE' }, { id: STILL, url: `chrome-extension://${STILL}/manager.html` }, TK).allowed).toBe(false);
  });

  it('takes consent decisions only from the top-level connect.html', () => {
    const connect = `chrome-extension://${TK}/connect.html`;
    expect(validateDockPageSender('DOCK_DECIDE', { id: TK, url: connect, frameId: 0, tab: { id: 9, url: connect } }, TK).allowed).toBe(true);
    // Framed (e.g. inside the overlay in a website).
    expect(validateDockPageSender('DOCK_DECIDE', { id: TK, url: connect, frameId: 2, tab: { id: 9, url: 'https://claude.ai/' } }, TK).allowed).toBe(false);
    expect(validateDockPageSender('DOCK_DECIDE', { id: TK, url: `chrome-extension://${TK}/manager.html`, frameId: 0 }, TK).allowed).toBe(false);
    // Unpair from the top-level manager or side panel is fine; from the overlay frame it is not.
    expect(validateDockPageSender('DOCK_UNPAIR', { id: TK, url: `chrome-extension://${TK}/sidepanel.html` }, TK).allowed).toBe(true);
    expect(validateDockPageSender('DOCK_UNPAIR', { id: TK, url: `chrome-extension://${TK}/manager.html`, frameId: 0, tab: { id: 1, url: 'https://chatgpt.com/' } }, TK).allowed).toBe(false);
  });
});

describe('settings and registry', () => {
  it('normalizes the sidebarDock settings block', () => {
    const s = normalizeSettings({ sidebarDock: { pairedId: 'not-an-id', allowSearch: false, prefs: { scope: 'nope', projects: ['A', 'A', 7] } } } as never);
    expect(s.sidebarDock.pairedId).toBe('');
    expect(s.sidebarDock.allowSearch).toBe(false);
    expect(s.sidebarDock.prefs.scope).toBe('manual');
    expect(s.sidebarDock.prefs.projects).toEqual(['A']);
    expect(normalizeSidebarDock({ pairedId: STILL, configured: true }).configured).toBe(true);
    expect(normalizeSidebarDock({ pairedId: '', configured: true }).configured).toBe(false);
    expect(normalizeSettings(null).sidebarDock.allowRemoteModels).toBe(false);
  });

  it('gives every provider a category; Claude Code and Codex are coding agents', () => {
    for (const id of PROVIDER_IDS) expect(PROVIDERS[id].category).toBeTruthy();
    expect(providerCategory('claude_code')).toBe('coding_agent');
    expect(providerCategory('codex')).toBe('coding_agent');
    expect(providerCategory('chatgpt')).toBe('chat');
    expect(providerCategory('unknown_thing')).toBe('chat');
  });
});

describe('consent page helpers', () => {
  it('normalizes typed codes and checks them against the hash', async () => {
    expect(normalizeCodeInput('12 34-56 78')).toBe('123456');
    const hash = await codeHashFor('req-1', '654321');
    expect(await codeMatches('req-1', '654321', hash)).toBe(true);
    expect(await codeMatches('req-1', '654322', hash)).toBe(false);
    expect(await codeMatches('req-2', '654321', hash)).toBe(false);
    expect(expiresInLabel(30_000)).toBe('in less than a minute');
    expect(expiresInLabel(7 * 60_000 + 5)).toBe('in 7 minutes');
    expect(groupedId(STILL)).toBe('abcd efgh ijkl mnop abcd efgh ijkl mnop');
  });
});
