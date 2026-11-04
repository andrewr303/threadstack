// Regression tests for verified review findings on the Sidebar Dock (Still) link.
import 'fake-indexeddb/auto';
import { describe, it, expect } from 'vitest';
import { PROTO } from '../../src/core/dock/protocol.js';
import { saveSettingsPatch, updateManualThreadFields } from '../../src/core/db.js';
import { fakeStill, harness, msg, pairDirect, seed, stillSender, thread } from './dock-helpers.js';

type Payload = { threadKey: string; transcript: { included: boolean }; seq: number; fingerprint: string };
const pushedKeys = (h: Awaited<ReturnType<typeof harness>>) =>
  h.still.of('threads.upsert').flatMap((c) => (c.message.threads as Payload[]).map((t) => t.threadKey));

async function configure(h: Awaited<ReturnType<typeof harness>>, prefs: Record<string, unknown> = { scope: 'all' }) {
  await h.dock.handleExternalMessage(msg('sync.configure', { prefs, epoch: 'epoch-1' }), stillSender());
  await h.dock.idle();
}

describe('drain privacy: settings changed while a drain runs', () => {
  it('a provider excluded mid-drain is not pushed by later batches of the same drain', async () => {
    let hook: (() => Promise<void>) | null = null;
    const still = fakeStill({
      'threads.upsert': async (m) => {
        const run = hook;
        hook = null;
        if (run) await run();
        return {
          ok: true,
          proto: PROTO,
          results: (m.threads as Payload[]).map((t) => ({ threadKey: t.threadKey, status: 'created', fingerprint: t.fingerprint, seq: t.seq })),
        };
      },
    });
    const h = await harness({ still });
    const keys: string[] = [];
    for (let i = 0; i < 21; i++) keys.push(await seed(h.db, thread(`t${i}`, `Thread ${i}`, [['user', `question ${i}`]])));
    await pairDirect(h, {}, false);
    // The user excludes ChatGPT from cloud processing while the first batch is on its way.
    hook = async () => {
      await saveSettingsPatch(h.db, { cloudExcludedProviders: ['chatgpt'] });
    };
    await configure(h);
    const pushed = pushedKeys(h);
    expect(h.still.of('threads.upsert')).toHaveLength(1);
    expect(pushed).toHaveLength(20);
    // The 21st thread was decided before the change but must never be sent after it.
    expect(keys.filter((k) => !pushed.includes(k))).toHaveLength(1);
    expect(await h.db.dockOutbox.count()).toBe(0);
  });

  it('a thread whose push is in flight when it becomes private is removed right after', async () => {
    let hook: (() => Promise<void>) | null = null;
    const still = fakeStill({
      'threads.upsert': async (m) => {
        const run = hook;
        hook = null;
        if (run) await run();
        return {
          ok: true,
          proto: PROTO,
          results: (m.threads as Payload[]).map((t) => ({ threadKey: t.threadKey, status: 'created', fingerprint: t.fingerprint, seq: t.seq })),
        };
      },
    });
    const h = await harness({ still });
    const a = await seed(h.db, thread('a', 'Alpha', [['user', 'alpha']]));
    await pairDirect(h, {}, false);
    // Settings → excluded providers while the push of `a` is not yet acknowledged (not in the ledger).
    hook = async () => {
      await saveSettingsPatch(h.db, { cloudExcludedProviders: ['chatgpt'] });
      await h.dock.syncNow({ privacy: true });
    };
    await configure(h);
    await h.dock.idle();
    const removes = h.still.of('threads.remove').map((c) => c.message);
    expect(removes).toEqual([expect.objectContaining({ threadKeys: [a], reason: 'local_only' })]);
    expect(await h.db.dockSent.get(a)).toBeUndefined();
  });
});

describe('removals Still answers without dropping the chat', () => {
  it('an out-of-scope thread Still kept still gets local_only when it later becomes private', async () => {
    const still = fakeStill({
      'threads.remove': (m) => ({
        ok: true,
        proto: PROTO,
        results: (m.threadKeys as string[]).map((threadKey) => ({ threadKey, status: m.reason === 'local_only' ? 'removed' : 'kept' })),
      }),
    });
    const h = await harness({ still });
    const b = await seed(h.db, thread('b', 'Beta', [['user', 'beta']], { project: 'HypeStake', categoryLocked: true }));
    await pairDirect(h, {}, false);
    await configure(h, { scope: 'projects', projects: ['HypeStake'] });
    expect(pushedKeys(h)).toEqual([b]);

    // Still narrows its scope: the thread leaves it, Still keeps the chat.
    await configure(h, { scope: 'projects', projects: ['Other'] });
    await h.dock.idle();
    expect(h.still.of('threads.remove').map((c) => c.message)).toEqual([expect.objectContaining({ threadKeys: [b], reason: 'out_of_scope' })]);
    expect((await h.db.dockSent.get(b))?.held).toBe('out_of_scope');

    // A later reconcile does not repeat the removal.
    h.clock.t += 11 * 60_000;
    await h.dock.reconcile(true);
    await h.dock.idle();
    expect(h.still.of('threads.remove')).toHaveLength(1);

    // Now the user makes it private: Still must forget it.
    await updateManualThreadFields(h.db, b, { cloudExcluded: true });
    await h.dock.syncNow({ threadKeys: [b], privacy: true });
    await h.dock.idle();
    const removes = h.still.of('threads.remove').map((c) => c.message);
    expect(removes).toHaveLength(2);
    expect(removes[1]).toMatchObject({ threadKeys: [b], reason: 'local_only' });
    expect(await h.db.dockSent.get(b)).toBeUndefined();
    expect(pushedKeys(h)).toEqual([b]);
  });

  it('a held thread that comes back into scope is pushed again', async () => {
    const still = fakeStill({
      'threads.remove': (m) => ({ ok: true, proto: PROTO, results: (m.threadKeys as string[]).map((threadKey) => ({ threadKey, status: 'kept' })) }),
    });
    const h = await harness({ still });
    const b = await seed(h.db, thread('b', 'Beta', [['user', 'beta']], { project: 'HypeStake', categoryLocked: true }));
    await pairDirect(h, {}, false);
    await configure(h, { scope: 'projects', projects: ['HypeStake'] });
    await configure(h, { scope: 'projects', projects: ['Other'] });
    await configure(h, { scope: 'projects', projects: ['HypeStake'] });
    expect(pushedKeys(h)).toEqual([b, b]);
    expect((await h.db.dockSent.get(b))?.held).toBeUndefined();
  });

  it('a missing answer clears the ledger row', async () => {
    const still = fakeStill({
      'threads.remove': (m) => ({ ok: true, proto: PROTO, results: (m.threadKeys as string[]).map((threadKey) => ({ threadKey, status: 'missing' })) }),
    });
    const h = await harness({ still });
    const b = await seed(h.db, thread('b', 'Beta', [['user', 'beta']], { project: 'HypeStake', categoryLocked: true }));
    await pairDirect(h, {}, false);
    await configure(h, { scope: 'projects', projects: ['HypeStake'] });
    await configure(h, { scope: 'projects', projects: ['Other'] });
    expect(await h.db.dockSent.get(b)).toBeUndefined();
  });
});
