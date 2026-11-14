import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { PROTO } from '../../src/core/dock/protocol.js';
import { ensureStarterCollectionsAndSettings, updateManualThreadFields, deleteConversationCascade } from '../../src/core/db.js';
import { markDockDirty, reconcileDock } from '../../src/core/dock/outbox.js';
import { fakeStill, harness, msg, pairDirect, putInsight, seed, STILL_ID, stillSender, thread } from './dock-helpers.js';

type Payload = { threadKey: string; transcript: { included: boolean; messages: unknown[] }; seq: number; fingerprint: string };
const pushedKeys = (h: Awaited<ReturnType<typeof harness>>) =>
  h.still.of('threads.upsert').flatMap((c) => (c.message.threads as Payload[]).map((t) => t.threadKey));

async function configure(h: Awaited<ReturnType<typeof harness>>, prefs: Record<string, unknown> = { scope: 'all' }) {
  const res = await h.dock.handleExternalMessage(msg('sync.configure', { prefs, epoch: 'epoch-1' }), stillSender());
  await h.dock.idle();
  return res;
}

describe('sync: configure, reconcile and drain', () => {
  it('nothing syncs before Start syncing; configure pushes every shareable in-scope thread', async () => {
    const h = await harness();
    const a = await seed(h.db, thread('a', 'Alpha', [['user', 'alpha question'], ['assistant', 'alpha answer']]));
    const b = await seed(h.db, thread('b', 'Beta', [['user', 'beta']], { project: 'HypeStake', categoryLocked: true }));
    await seed(h.db, thread('p', 'Private', [['user', 'secret']], { cloudExcluded: true }));
    await seed(h.db, thread('q', 'Diary', [['user', 'diary']], { project: 'Personal', categoryLocked: true }));
    await seed(h.db, thread('s', 'Synthetic', [['user', 'x']], { isSyntheticBenchmark: true }));
    await pairDirect(h, {}, false);
    await h.dock.reconcile(true);
    await h.dock.drain();
    expect(h.still.of('threads.upsert')).toHaveLength(0);

    const res = (await configure(h)) as Record<string, unknown>;
    expect(res).toMatchObject({ ok: true, proto: PROTO, total: 2 });
    expect(pushedKeys(h).sort()).toEqual([a, b].sort());
    const push = h.still.of('threads.upsert')[0].message;
    expect(push).toMatchObject({ proto: PROTO, from: 'threadkeeper', origin: 'sync' });
    // First push of a revision carries the transcript.
    expect((push.threads as Payload[])[0].transcript.included).toBe(true);
    expect(await h.db.dockSent.count()).toBe(2);
    expect(await h.db.dockOutbox.count()).toBe(0);
    const dock = (await ensureStarterCollectionsAndSettings(h.db)).sidebarDock;
    expect(dock).toMatchObject({ configured: true, prefs: { scope: 'all' } });
    expect(dock.lastPushAt).not.toBe('');
  });

  it('scope projects and provider filters; unchanged threads are not pushed again', async () => {
    const h = await harness();
    const a = await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']], { project: 'HypeStake', categoryLocked: true }));
    await seed(h.db, thread('b', 'Beta', [['user', 'beta']]));
    await seed(h.db, thread('c', 'Gamma', [['user', 'gamma']], { provider: 'claude', project: 'HypeStake', categoryLocked: true }));
    await pairDirect(h, {}, false);
    await configure(h, { scope: 'projects', projects: ['hypestake'], providers: ['chatgpt'] });
    expect(pushedKeys(h)).toEqual([a]);
    h.clock.t += 11 * 60_000;
    await h.dock.reconcile(false);
    await h.dock.idle();
    await h.dock.drain();
    expect(pushedKeys(h)).toEqual([a]);
  });

  it('metadata first: an analysis update is pushed without the transcript; needsTranscript re-queues one', async () => {
    let askTranscript = false;
    const still = fakeStill({
      'threads.upsert': (m) => ({
        ok: true,
        proto: PROTO,
        results: (m.threads as Payload[]).map((t) => ({ threadKey: t.threadKey, status: 'updated', fingerprint: t.fingerprint, seq: t.seq, needsTranscript: askTranscript && !t.transcript.included })),
      }),
    });
    const h = await harness({ still });
    const a = await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']]));
    await pairDirect(h, {}, false);
    await configure(h);
    expect(h.still.of('threads.upsert')).toHaveLength(1);

    await putInsight(h.db, a, { gist: 'New gist' });
    await h.dock.reconcile(true);
    await h.dock.drain();
    const second = h.still.of('threads.upsert')[1].message.threads as Payload[];
    expect(second[0].transcript.included).toBe(false);

    askTranscript = true;
    await putInsight(h.db, a, { gist: 'Newer gist', generatedAt: '2026-11-01T00:00:00.000Z' });
    await h.dock.reconcile(true);
    await h.dock.drain();
    const calls = h.still.of('threads.upsert');
    expect((calls[2].message.threads as Payload[])[0].transcript.included).toBe(false);
    expect((calls[3].message.threads as Payload[])[0].transcript.included).toBe(true);
    // seq grows with every payload.
    const seqs = calls.map((c) => (c.message.threads as Payload[])[0].seq);
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
  });

  it('privacy: a sent thread made local-only is removed (priority), never upserted', async () => {
    const h = await harness();
    const a = await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']]));
    await pairDirect(h, {}, false);
    await configure(h);
    await updateManualThreadFields(h.db, a, { cloudExcluded: true });
    // A pending debounced upsert must not leak it either.
    await markDockDirty(h.db, [a], { debounceMs: 0, now: h.clock.t });
    await h.dock.syncNow({ threadKeys: [a], privacy: true });
    await h.dock.idle();
    const removes = h.still.of('threads.remove');
    expect(removes).toHaveLength(1);
    expect(removes[0].message).toMatchObject({ threadKeys: [a], reason: 'local_only' });
    expect(h.still.of('threads.upsert')).toHaveLength(1);
    expect(await h.db.dockSent.get(a)).toBeUndefined();
  });

  it('a project made local-only is caught by the privacy fast path', async () => {
    const h = await harness();
    const a = await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']], { project: 'HypeStake', categoryLocked: true }));
    await pairDirect(h, {}, false);
    await configure(h);
    await h.db.collections.update('HypeStake', { cloudExcluded: true });
    await h.dock.syncNow({ privacy: true });
    await h.dock.idle();
    expect(h.still.of('threads.remove')[0].message).toMatchObject({ threadKeys: [a], reason: 'local_only' });
  });

  it('deleted and out-of-scope threads are removed with their reasons', async () => {
    const h = await harness();
    const a = await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']], { project: 'HypeStake', categoryLocked: true }));
    const b = await seed(h.db, thread('b', 'Beta', [['user', 'beta']], { project: 'HypeStake', categoryLocked: true }));
    await pairDirect(h, {}, false);
    await configure(h, { scope: 'projects', projects: ['HypeStake'] });
    await deleteConversationCascade(h.db, a);
    await updateManualThreadFields(h.db, b, { project: 'General research' });
    await h.dock.reconcile(true);
    await h.dock.drain();
    const removes = h.still.of('threads.remove').map((c) => c.message);
    expect(removes).toEqual(
      expect.arrayContaining([expect.objectContaining({ threadKeys: [a], reason: 'deleted' }), expect.objectContaining({ threadKeys: [b], reason: 'out_of_scope' })])
    );
    // Still answered 'removed' (moved to Trash under its preference): the chats may still hold
    // the threads, so the ledger keeps them as held, for a later local_only removal.
    expect((await h.db.dockSent.get(a))?.held).toBe('deleted');
    expect((await h.db.dockSent.get(b))?.held).toBe('out_of_scope');
    // Answered removals are not repeated.
    h.clock.t += 11 * 60_000;
    await h.dock.reconcile(true);
    await h.dock.drain();
    expect(h.still.of('threads.remove')).toHaveLength(removes.length);
  });

  it('busy is honoured without penalty; unreachable backs off 1/5/30/120 minutes; hello resets it', async () => {
    let mode: 'busy' | 'down' | 'up' = 'busy';
    const still = fakeStill({
      'threads.upsert': (m) => {
        if (mode === 'busy') return { ok: false, proto: PROTO, error: { code: 'busy', message: 'later', retryAfterMs: 2000 } };
        if (mode === 'down') throw new Error('Receiving end does not exist');
        return { ok: true, proto: PROTO, results: (m.threads as Payload[]).map((t) => ({ threadKey: t.threadKey, status: 'created' })) };
      },
    });
    const h = await harness({ still });
    const a = await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']]));
    await pairDirect(h, {}, false);
    await configure(h);
    let row = (await h.db.dockOutbox.get(a))!;
    expect(row.attempts).toBe(0);
    expect(Date.parse(row.notBefore) - h.clock.t).toBe(2000);

    mode = 'down';
    for (const minutes of [1, 5, 30, 120, 120]) {
      h.clock.t = Date.parse(row.notBefore);
      await h.dock.drain();
      row = (await h.db.dockOutbox.get(a))!;
      expect(Date.parse(row.notBefore) - h.clock.t).toBe(minutes * 60_000);
    }
    expect((await ensureStarterCollectionsAndSettings(h.db)).sidebarDock.lastError).toMatch(/not reachable/);

    mode = 'up';
    await h.dock.handleExternalMessage(msg('hello', { epoch: 'epoch-1' }), stillSender());
    await h.dock.idle();
    expect(await h.db.dockOutbox.count()).toBe(0);
    expect(await h.db.dockSent.get(a)).toBeDefined();
  });

  it('not_paired twice at least 60 s apart drops the pairing', async () => {
    const still = fakeStill({ 'threads.upsert': () => ({ ok: false, proto: PROTO, error: { code: 'not_paired', message: 'no' } }) });
    const h = await harness({ still });
    await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']]));
    await pairDirect(h, {}, false);
    await configure(h);
    expect((await ensureStarterCollectionsAndSettings(h.db)).sidebarDock.pairedId).toBe(STILL_ID);
    h.clock.t += 61_000;
    await h.dock.drain();
    const dock = (await ensureStarterCollectionsAndSettings(h.db)).sidebarDock;
    expect(dock.pairedId).toBe('');
    expect(await h.db.dockOutbox.count()).toBe(0);
  });

  it('dismissed stops tracking until a manual send; a manual send goes outside the scope with its target', async () => {
    let dismiss = true;
    const still = fakeStill({
      'threads.upsert': (m) => ({
        ok: true,
        proto: PROTO,
        results: (m.threads as Payload[]).map((t) => (dismiss && m.origin === 'sync' ? { threadKey: t.threadKey, status: 'skipped', reason: 'dismissed' } : { threadKey: t.threadKey, status: 'created' })),
      }),
    });
    const h = await harness({ still });
    const a = await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']]));
    const b = await seed(h.db, thread('b', 'Beta', [['user', 'beta']]));
    await pairDirect(h, {}, false);
    await configure(h);
    expect((await h.db.dockTracked.get(a))?.dismissed).toBe(true);
    await updateManualThreadFields(h.db, a, { manualTitleOverride: 'Changed' });
    await h.dock.reconcile(true);
    await h.dock.drain();
    expect(pushedKeys(h).filter((k) => k === a)).toHaveLength(1);

    // Manual send under scope 'manual' with a target collection.
    dismiss = false;
    await h.dock.handleExternalMessage(msg('sync.configure', { prefs: { scope: 'manual' }, epoch: 'epoch-1' }), stillSender());
    await h.dock.idle();
    const sent = await h.dock.sendThreads([a, b, 'nope'], { collectionName: '  Research  ' });
    expect(sent).toMatchObject({ ok: true, queued: 2, skipped: [{ threadKey: 'nope', reason: 'missing' }] });
    await h.dock.idle();
    const manual = h.still.of('threads.upsert').filter((c) => c.message.origin === 'manual');
    expect(manual).toHaveLength(1);
    expect(manual[0].message.target).toEqual({ collectionName: 'Research' });
    expect((manual[0].message.threads as Payload[]).map((t) => t.threadKey).sort()).toEqual([a, b].sort());
    expect((await h.db.dockTracked.get(a))?.dismissed).toBe(false);
  });

  it('never sends a private thread on a manual send', async () => {
    const h = await harness();
    const p = await seed(h.db, thread('p', 'Private', [['user', 'x']], { cloudExcluded: true }));
    await pairDirect(h);
    expect(await h.dock.sendThreads([p], null)).toMatchObject({ ok: true, queued: 0, skipped: [{ threadKey: p, reason: 'local_only' }] });
    await h.dock.idle();
    expect(h.still.calls).toHaveLength(0);
  });

  it('a new epoch discards the ledger and re-offers everything', async () => {
    const h = await harness();
    await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']]));
    await pairDirect(h, {}, false);
    await configure(h);
    expect(h.still.of('threads.upsert')).toHaveLength(1);
    await h.dock.handleExternalMessage(msg('hello', { epoch: 'epoch-2' }), stillSender());
    await h.dock.idle();
    expect(h.still.of('threads.upsert')).toHaveLength(2);
    expect((await ensureStarterCollectionsAndSettings(h.db)).sidebarDock.peerEpoch).toBe('epoch-2');
    expect((await h.db.dockSent.toArray())[0].epoch).toBe('epoch-2');
  });

  it('too_large on a batch splits it; on one thread it retries without the transcript', async () => {
    const still = fakeStill({
      'threads.upsert': (m) => {
        const threads = m.threads as Payload[];
        if (threads.length > 1) return { ok: false, proto: PROTO, error: { code: 'too_large', message: 'big' } };
        if (threads[0].transcript.included) return { ok: true, proto: PROTO, results: [{ threadKey: threads[0].threadKey, status: 'skipped', reason: 'too_large' }] };
        return { ok: true, proto: PROTO, results: [{ threadKey: threads[0].threadKey, status: 'created' }] };
      },
    });
    const h = await harness({ still });
    await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']]));
    await seed(h.db, thread('b', 'Beta', [['user', 'beta']]));
    await pairDirect(h, {}, false);
    await configure(h);
    await h.dock.drain();
    expect(await h.db.dockOutbox.count()).toBe(0);
    expect(await h.db.dockSent.count()).toBe(2);
    for (const r of await h.db.dockSent.toArray()) expect(r.transcriptRevision).toBe(-1);
  });

  it('reconcile is skipped within 10 minutes unless forced, and resumes from its cursor', async () => {
    const h = await harness();
    for (let i = 0; i < 5; i++) await seed(h.db, thread(`t${i}`, `T${i}`, [['user', `m${i}`]]));
    await pairDirect(h);
    const settings = await ensureStarterCollectionsAndSettings(h.db);
    const first = await reconcileDock(h.db, settings, { now: () => h.clock.t });
    expect(first).toMatchObject({ ran: true, done: true, queued: 5 });
    expect(await reconcileDock(h.db, settings, { now: () => h.clock.t })).toMatchObject({ ran: false });
    let t = h.clock.t + 11 * 60_000;
    // A zero budget does one page per call and keeps a cursor.
    const partial = await reconcileDock(h.db, settings, { now: () => (t += 10), budgetMs: 0 });
    expect(partial.ran).toBe(true);
  });

  it('chats.status sweep removes private threads Still still holds (after configure)', async () => {
    const still = fakeStill({
      'chats.status': (m) => ({
        ok: true,
        proto: PROTO,
        chats: Object.fromEntries((m.threadKeys as string[]).map((k) => [k, { itemId: 'chat_tk_x', collectionId: '', collectionName: '', trashed: false, hasTranscript: true, transcriptRevision: 1 }])),
      }),
    });
    const h = await harness({ still });
    const p = await seed(h.db, thread('p', 'Private', [['user', 'x']], { cloudExcluded: true }));
    await seed(h.db, thread('s', 'Synthetic', [['user', 'x']], { isSyntheticBenchmark: true }));
    await pairDirect(h, {}, false);
    await configure(h);
    const status = h.still.of('chats.status');
    expect(status).toHaveLength(1);
    expect(status[0].message.threadKeys).toEqual([p]);
    await h.dock.drain();
    expect(h.still.of('threads.remove')[0].message).toMatchObject({ threadKeys: [p], reason: 'local_only' });
  });
});

describe('outbox coalescing', () => {
  it('bumps dirtySeq, keeps leases, never downgrades a remove and keeps the strongest reason', async () => {
    const h = await harness();
    const now = h.clock.t;
    await markDockDirty(h.db, ['k'], { debounceMs: 90_000, now });
    let row = (await h.db.dockOutbox.get('k'))!;
    expect(row).toMatchObject({ op: 'upsert', dirtySeq: 1 });
    expect(Date.parse(row.notBefore) - now).toBe(90_000);
    await h.db.dockOutbox.update('k', { leaseUntil: 'L' });
    await markDockDirty(h.db, ['k'], { remove: 'local_only', immediate: true, now });
    await markDockDirty(h.db, ['k'], { remove: 'out_of_scope', immediate: true, now });
    await markDockDirty(h.db, ['k'], { debounceMs: 90_000, now });
    row = (await h.db.dockOutbox.get('k'))!;
    expect(row).toMatchObject({ op: 'remove', reason: 'local_only', dirtySeq: 4, leaseUntil: 'L' });
    expect(Date.parse(row.notBefore)).toBe(now);
  });
});
