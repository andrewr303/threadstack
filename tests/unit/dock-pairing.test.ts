import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { PROTO } from '../../src/core/dock/protocol.js';
import { ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import { fakeStill, harness, msg, OTHER_ID, pairDirect, STILL_ID, stillSender, TK_ID } from './dock-helpers.js';

async function settingsOf(h: Awaited<ReturnType<typeof harness>>) {
  return (await ensureStarterCollectionsAndSettings(h.db)).sidebarDock;
}

describe('external handler: senders and envelopes', () => {
  it('answers hello unpaired without writing anything', async () => {
    const h = await harness();
    const before = JSON.stringify(await h.db.settings.toArray());
    const res = await h.dock.handleExternalMessage(msg('hello', { epoch: 'e1' }), stillSender());
    expect(res).toEqual({ ok: true, proto: PROTO, app: 'threadkeeper', version: '0.4.0', paired: false });
    expect(JSON.stringify(await h.db.settings.toArray())).toBe(before);
    expect(await h.db.dockMeta.count()).toBe(0);
  });

  it('rejects spoofed senders: content scripts, other pages, own id, no id', async () => {
    const logs: string[] = [];
    const h = await harness({ deps: { log: (r) => logs.push(r) } });
    await pairDirect(h);
    const m = msg('threads.list');
    for (const sender of [
      { id: STILL_ID, url: 'https://evil.example/page', tab: { id: 4 } },
      { id: STILL_ID, url: `chrome-extension://${STILL_ID}/index.html`, tab: { id: 4 } },
      { id: STILL_ID, url: `chrome-extension://${OTHER_ID}/index.html` },
      { id: TK_ID, url: `chrome-extension://${TK_ID}/manager.html` },
      { url: 'https://evil.example/' },
    ]) {
      const res = await h.dock.handleExternalMessage(m, sender);
      expect(res.ok).toBe(false);
    }
    expect(logs.length).toBeGreaterThanOrEqual(5);
  });

  it('enforces proto, type allowlist, pairing and size in that order', async () => {
    const h = await harness();
    expect(await h.dock.handleExternalMessage({ ...msg('hello'), proto: 'still-threadkeeper/9' }, stillSender())).toMatchObject({ ok: false, error: { code: 'version_mismatch' } });
    expect(await h.dock.handleExternalMessage(msg('threads.delete_everything'), stillSender())).toMatchObject({ ok: false, error: { code: 'unsupported' } });
    expect(await h.dock.handleExternalMessage(msg('threads.search', { query: 'x' }), stillSender())).toMatchObject({ ok: false, error: { code: 'not_paired' } });
    expect(await h.dock.handleExternalMessage('garbage', stillSender())).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    await pairDirect(h);
    const huge = msg('threads.search', { query: 'x'.repeat(10), filler: 'y'.repeat(4 * 1024 * 1024 + 10) });
    expect(await h.dock.handleExternalMessage(huge, stillSender())).toMatchObject({ ok: false, error: { code: 'too_large' } });
    // Malformed fields are bad_request, never a crash.
    expect(await h.dock.handleExternalMessage(msg('threads.search', { query: 42 }), stillSender())).toMatchObject({ ok: false, error: { code: 'bad_request' } });
    expect(await h.dock.handleExternalMessage(msg('threads.get', { threadKeys: 'all' }), stillSender())).toMatchObject({ ok: false, error: { code: 'bad_request' } });
  });

  it('tells the paired Still its capabilities, and nobody else', async () => {
    const h = await harness();
    await pairDirect(h);
    const res = (await h.dock.handleExternalMessage(msg('hello', { epoch: 'epoch-1' }), stillSender())) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: true, paired: true, tk: { version: '0.4.0' } });
    expect((res.tk as { capabilities: string[] }).capabilities).toEqual(expect.arrayContaining(['sync', 'search', 'context', 'transcripts', 'open']));
    expect((res.tk as { capabilities: string[] }).capabilities).not.toContain('remote_models');
    const other = await h.dock.handleExternalMessage(msg('hello'), stillSender(OTHER_ID));
    expect(other).toEqual({ ok: true, proto: PROTO, app: 'threadkeeper', version: '0.4.0', paired: false });
  });
});

describe('pairing with consent and a one-time code', () => {
  const request = (code = '123456', requestId = 'req-00000001') => msg('pair.request', { appName: 'Still', appVersion: '2.0', code, epoch: 'epoch-A', requestId });

  it('records one pending request, opens one window, pairs only after Still acks pair.granted', async () => {
    const h = await harness();
    expect(await h.dock.handleExternalMessage(request(), stillSender())).toMatchObject({ ok: true, status: 'pending' });
    expect(h.windows).toBe(1);
    // A repeat never reopens the window or extends the expiry, but takes the new code.
    h.clock.t += 60_000;
    expect(await h.dock.handleExternalMessage(request('654321', 'req-00000002'), stillSender())).toMatchObject({ ok: true, status: 'pending' });
    expect(h.windows).toBe(1);
    const pending = (await h.dock.getPending())!;
    expect(pending.requestId).toBe('req-00000002');
    expect(Date.parse(pending.expiresAt) - Date.parse('2026-11-01T12:00:00.000Z')).toBe(10 * 60_000);
    // Another sender while one is pending: busy, no window.
    expect(await h.dock.handleExternalMessage(request(), stillSender(OTHER_ID))).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(h.windows).toBe(1);

    // Wrong code: refused, still pending.
    expect(await h.dock.decide({ requestId: 'req-00000002', allow: true, code: '123456' })).toMatchObject({ ok: false, status: 'wrong_code' });
    expect((await settingsOf(h)).pairedId).toBe('');
    // Right code: pair.granted goes to Still; Still acks; paired, not configured.
    expect(await h.dock.decide({ requestId: 'req-00000002', allow: true, code: '654321', allowRemoteModels: true })).toEqual({ ok: true, status: 'paired' });
    const granted = h.still.of('pair.granted');
    expect(granted).toHaveLength(1);
    expect(granted[0].to).toBe(STILL_ID);
    expect(granted[0].message).toMatchObject({ proto: PROTO, from: 'threadkeeper', requestId: 'req-00000002' });
    const dock = await settingsOf(h);
    expect(dock).toMatchObject({ pairedId: STILL_ID, pairedName: 'Still', configured: false, peerEpoch: 'epoch-A', allowRemoteModels: true });
    expect(await h.dock.getPending()).toBeNull();
    // Now paired: another extension's request is busy and opens nothing.
    expect(await h.dock.handleExternalMessage(request('111111', 'req-00000003'), stillSender(OTHER_ID))).toMatchObject({ ok: false, error: { code: 'busy' } });
    expect(await h.dock.handleExternalMessage(request('111111', 'req-00000003'), stillSender())).toMatchObject({ ok: true, status: 'paired' });
    await h.dock.idle();
  });

  it('keeps retrying pair.granted while Still is unreachable, until it acks', async () => {
    let reachable = false;
    const still = fakeStill({
      'pair.granted': () => {
        if (!reachable) throw new Error('Could not establish connection. Receiving end does not exist.');
        return { ok: true, proto: PROTO };
      },
    });
    const retries: boolean[] = [];
    const h = await harness({ still, deps: { schedulePairRetry: (on) => retries.push(on) } });
    await h.dock.handleExternalMessage(request(), stillSender());
    expect(await h.dock.decide({ requestId: 'req-00000001', allow: true, code: '123456' })).toEqual({ ok: true, status: 'granted' });
    expect((await settingsOf(h)).pairedId).toBe('');
    expect(retries).toEqual([true]);
    reachable = true;
    h.clock.t += 30_000;
    expect(await h.dock.deliverGrant()).toEqual({ ok: true, status: 'paired' });
    expect((await settingsOf(h)).pairedId).toBe(STILL_ID);
    expect(retries[retries.length - 1]).toBe(false);
    await h.dock.idle();
  });

  it('stops when Still no longer waits, and expires after 10 minutes', async () => {
    const still = fakeStill({ 'pair.granted': () => ({ ok: false, proto: PROTO, error: { code: 'bad_request', message: 'No pending request' } }) });
    const h = await harness({ still });
    await h.dock.handleExternalMessage(request(), stillSender());
    expect(await h.dock.decide({ requestId: 'req-00000001', allow: true, code: '123456' })).toMatchObject({ ok: false, status: 'expired' });
    expect(await h.dock.getPending()).toBeNull();

    await h.dock.handleExternalMessage(request('222222', 'req-00000009'), stillSender());
    h.clock.t += 10 * 60_000 + 1;
    expect(await h.dock.getPending()).toBeNull();
    expect(await h.dock.decide({ requestId: 'req-00000009', allow: true, code: '222222' })).toMatchObject({ ok: false, status: 'expired' });
  });

  it('cancels after five wrong codes', async () => {
    const h = await harness();
    await h.dock.handleExternalMessage(request(), stillSender());
    for (let i = 0; i < 4; i++) expect(await h.dock.decide({ requestId: 'req-00000001', allow: true, code: '000000' })).toMatchObject({ status: 'wrong_code' });
    expect(await h.dock.decide({ requestId: 'req-00000001', allow: true, code: '000000' })).toMatchObject({ status: 'cancelled' });
    expect(await h.dock.getPending()).toBeNull();
  });

  it('deny blocks the sender until unblocked', async () => {
    const h = await harness();
    await h.dock.handleExternalMessage(request(), stillSender());
    expect(await h.dock.decide({ requestId: 'req-00000001', allow: false })).toEqual({ ok: true, status: 'denied' });
    expect(h.still.of('pair.denied')).toHaveLength(1);
    expect((await settingsOf(h)).blockedIds).toEqual([STILL_ID]);
    expect(await h.dock.handleExternalMessage(request(), stillSender())).toMatchObject({ ok: false, error: { code: 'denied' } });
    await h.dock.unblock(STILL_ID);
    h.clock.t += 11 * 60_000;
    expect(await h.dock.handleExternalMessage(request(), stillSender())).toMatchObject({ ok: true, status: 'pending' });
  });

  it('pair.revoke from Still forgets the pairing and the ledger', async () => {
    const h = await harness();
    await pairDirect(h);
    await h.db.dockSent.put({ threadKey: 'k', peerId: STILL_ID, epoch: 'epoch-1', fingerprint: 'f', seq: 1, transcriptRevision: 1, prefsHash: 't1', cheapDigest: '', itemId: '', sentAt: '' });
    expect(await h.dock.handleExternalMessage(msg('pair.revoke'), stillSender())).toMatchObject({ ok: true });
    expect((await settingsOf(h)).pairedId).toBe('');
    expect(await h.db.dockSent.count()).toBe(0);
    // A revoke from a stranger is refused and changes nothing.
    await pairDirect(h);
    expect(await h.dock.handleExternalMessage(msg('pair.revoke'), stillSender(OTHER_ID))).toMatchObject({ ok: false, error: { code: 'not_paired' } });
    expect((await settingsOf(h)).pairedId).toBe(STILL_ID);
  });

  it('unpair from Threadkeeper flushes local_only removals first, then revokes', async () => {
    const h = await harness();
    await pairDirect(h);
    await h.db.dockOutbox.bulkPut([
      { threadKey: 'priv', op: 'remove', reason: 'local_only', notBefore: new Date(h.clock.t).toISOString(), attempts: 0, lastError: '', leaseUntil: '', dirtySeq: 1, updatedAt: '' },
      { threadKey: 'up', op: 'upsert', notBefore: new Date(h.clock.t).toISOString(), attempts: 0, lastError: '', leaseUntil: '', dirtySeq: 1, updatedAt: '' },
    ]);
    await h.dock.unpair();
    const types = h.still.calls.map((c) => c.message.type);
    expect(types).toEqual(['threads.remove', 'pair.revoke']);
    expect(h.still.calls[0].message).toMatchObject({ threadKeys: ['priv'], reason: 'local_only' });
    expect((await settingsOf(h)).pairedId).toBe('');
    expect(await h.db.dockOutbox.count()).toBe(0);
  });
});
