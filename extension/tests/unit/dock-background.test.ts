import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll, vi } from 'vitest';
import { PROTO } from '../../src/core/dock/protocol.js';

// Exercises the real service-worker wiring: the external listener, DOCK_* routing and sender rules.
const TK = 'aaaabbbbccccddddaaaabbbbccccdddd';
const STILL = 'abcdefghijklmnopabcdefghijklmnop';

type Listener = (message: unknown, sender: unknown, sendResponse: (r: unknown) => void) => boolean | void;
const listeners: { internal?: Listener; external?: Listener } = {};
const windowsCreated: Array<{ url?: string; type?: string }> = [];
const toStill: Array<Record<string, unknown>> = [];

function call(listener: Listener | undefined, message: unknown, sender: unknown): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    const keep = listener!(message, sender, (r) => resolve(r as Record<string, unknown>));
    expect(keep).toBe(true);
  });
}

const manager = { id: TK, url: `chrome-extension://${TK}/manager.html`, tab: { id: 1, url: `chrome-extension://${TK}/manager.html` }, frameId: 0 };
const connect = { id: TK, url: `chrome-extension://${TK}/connect.html`, tab: { id: 2, url: `chrome-extension://${TK}/connect.html` }, frameId: 0 };
const still = { id: STILL, url: `chrome-extension://${STILL}/index.html`, origin: `chrome-extension://${STILL}` };
const env = (type: string, fields: Record<string, unknown> = {}) => ({ proto: PROTO, from: 'still', type, requestId: `r-${type}-12345678`, ...fields });

beforeAll(async () => {
  const session = new Map<string, unknown>();
  const event = (key: 'internal' | 'external' | null) => ({
    addListener: (fn: Listener) => {
      if (key) listeners[key] = fn;
    },
    removeListener: () => undefined,
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: TK,
      getURL: (p: string) => `chrome-extension://${TK}/${p}`,
      getManifest: () => ({ version: '0.4.0' }),
      sendMessage: async (a: unknown, b?: unknown) => {
        if (typeof a !== 'string') return undefined;
        const m = b as Record<string, unknown>;
        toStill.push(m);
        return { ok: true, proto: PROTO };
      },
      onMessage: event('internal'),
      onMessageExternal: event('external'),
      onInstalled: event(null),
      onStartup: event(null),
    },
    storage: {
      session: {
        get: async (k: string) => (session.has(k) ? { [k]: session.get(k) } : {}),
        set: async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) session.set(k, JSON.parse(JSON.stringify(v)));
        },
      },
    },
    alarms: { create: async () => undefined, clear: async () => true, onAlarm: event(null) },
    tabs: { onRemoved: event(null), query: async () => [], create: async () => ({ id: 9 }), update: async () => ({}) },
    windows: {
      create: async (opts: { url?: string; type?: string }) => {
        windowsCreated.push(opts);
        return { id: 5 };
      },
    },
  });
  await import('../../src/entrypoints/background.js');
});

describe('background wiring for the Still link', () => {
  it('registers a separate external listener that returns flat envelopes', async () => {
    expect(listeners.external).toBeTypeOf('function');
    const res = await call(listeners.external, env('hello'), still);
    expect(res).toMatchObject({ ok: true, proto: PROTO, app: 'threadkeeper', paired: false });
    const spoofed = await call(listeners.external, env('hello'), { ...still, tab: { id: 3, url: 'https://evil.example/' } });
    expect(spoofed).toMatchObject({ ok: false, proto: PROTO, error: { code: 'not_paired' } });
  });

  it('never routes external messages into the internal handler', async () => {
    const res = await call(listeners.external, { type: 'DOCK_UNPAIR' }, still);
    expect(res).toMatchObject({ ok: false, error: { code: 'version_mismatch' } });
  });

  it('routes DOCK_* from ThreadStack pages and refuses them from websites', async () => {
    const state = await call(listeners.internal, { type: 'DOCK_GET_STATE' }, manager);
    expect(state).toMatchObject({ ok: true, state: { ownId: TK, paired: false } });
    const fromSite = await call(listeners.internal, { type: 'DOCK_GET_STATE' }, { id: TK, url: 'https://claude.ai/chat/1', tab: { id: 4, url: 'https://claude.ai/chat/1' } });
    expect(fromSite.ok).toBe(false);
    const decideFromManager = await call(listeners.internal, { type: 'DOCK_DECIDE', requestId: 'x', allow: true }, manager);
    expect(decideFromManager).toMatchObject({ ok: false, error: 'Open ThreadStack in its own window to do this.' });
  });

  it('pairs end to end: request → consent window → code → pair.granted → paired', async () => {
    const pending = await call(listeners.external, env('pair.request', { appName: 'Still', appVersion: '2', code: '424242', epoch: 'ep-1' }), still);
    expect(pending, JSON.stringify(pending)).toMatchObject({ ok: true, status: 'pending' });
    expect(windowsCreated).toEqual([expect.objectContaining({ url: `chrome-extension://${TK}/connect.html`, type: 'popup' })]);
    const view = await call(listeners.internal, { type: 'DOCK_PENDING' }, connect);
    expect(view).toMatchObject({ ok: true, pending: { senderId: STILL, appName: 'Still', requestId: 'r-pair.request-12345678' } });
    const decided = await call(listeners.internal, { type: 'DOCK_DECIDE', requestId: 'r-pair.request-12345678', allow: true, code: '424242' }, connect);
    expect(decided).toEqual({ ok: true, status: 'paired' });
    expect(toStill.find((m) => m.type === 'pair.granted')).toMatchObject({ requestId: 'r-pair.request-12345678', from: 'threadkeeper' });
    const state = await call(listeners.internal, { type: 'DOCK_GET_STATE' }, manager);
    expect(state).toMatchObject({ ok: true, state: { paired: true, pairedId: STILL, configured: false } });
    // Paired: reads work; a stranger is still refused.
    expect(await call(listeners.external, env('facets'), still)).toMatchObject({ ok: true, total: 0 });
    expect(await call(listeners.external, env('facets'), { id: 'ponmlkjihgfedcbaponmlkjihgfedcba', url: 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/x.html' })).toMatchObject({
      ok: false,
      error: { code: 'not_paired' },
    });
  });
});
