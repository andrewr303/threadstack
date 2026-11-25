import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ThreadStackDB, upsertThread, type UpsertThreadInput } from '../../src/core/db.js';
import { alignMessages, looksDerivedTitle, mergeCapturedMessages, sameMessageText } from '../../src/core/merge.js';
import { buildThreadKey, type CaptureSource, type CoverageState } from '../../src/core/schema.js';

let n = 0;
const freshDb = () => new ThreadStackDB(`ThreadStackMerge_${Date.now()}_${++n}`);

const conv = '7a1b2c3d-0000-4000-8000-00000000abcd';
const threadKey = buildThreadKey({
  provider: 'chatgpt',
  accountId: 'acct_chatgpt_primary',
  workspaceId: 'ws_personal',
  sourceConversationId: conv,
  branchId: 'main',
});

type Msg = UpsertThreadInput['messages'][number];
const m = (id: string, role: 'user' | 'assistant', content: string): Msg => ({
  sourceMessageId: id,
  role,
  content,
  createdAt: null,
  branchPath: 'main',
});

/** Alternating user/assistant messages "q1", "a1", "q2", "a2" … for turn numbers lo..hi. */
function turns(lo: number, hi: number, text: (role: 'user' | 'assistant', k: number) => string = (r, k) => `${r === 'user' ? 'Question' : 'Answer'} number ${k} about webhook retries`): Msg[] {
  const out: Msg[] = [];
  for (let k = lo; k <= hi; k++) {
    out.push(m(`u${k}`, 'user', text('user', k)));
    out.push(m(`a${k}`, 'assistant', text('assistant', k)));
  }
  return out;
}

function capture(
  messages: Msg[],
  patch: { source?: CaptureSource; coverage?: CoverageState; title?: string } = {}
): UpsertThreadInput {
  return {
    threadKey,
    provider: 'chatgpt',
    accountId: 'acct_chatgpt_primary',
    workspaceId: 'ws_personal',
    sourceConversationId: conv,
    branchId: 'main',
    canonicalUrl: `https://chatgpt.com/c/${conv}`,
    title: patch.title ?? 'Stripe webhook retries',
    createdAt: null,
    updatedAt: '2026-11-03T00:00:00.000Z',
    coverage: patch.coverage ?? 'partial',
    captureSource: patch.source ?? 'dom_observer',
    messages,
  };
}

async function stored(db: ThreadStackDB) {
  return db.messages.where('threadKey').equals(threadKey).sortBy('ordinal');
}

describe('DOM windows are merged by identity', () => {
  it('keeps the older messages when the visible window moves down and is larger than what was stored', async () => {
    const db = freshDb();
    await upsertThread(db, capture(turns(1, 3))); // 6 messages: the top of the thread
    await upsertThread(db, capture(turns(2, 5))); // 8 messages: a later window, longer than the stored copy
    expect((await stored(db)).map((r) => r.sourceMessageId)).toEqual(
      ['u1', 'a1', 'u2', 'a2', 'u3', 'a3', 'u4', 'a4', 'u5', 'a5']
    );
  });

  it('keeps the newer messages when the window moves back up', async () => {
    const db = freshDb();
    await upsertThread(db, capture(turns(1, 6)));
    await upsertThread(db, capture(turns(1, 2)));
    expect((await stored(db)).map((r) => r.sourceMessageId)).toHaveLength(12);
  });

  it('replaces the tail a regenerated reply contradicts, and nothing before it', async () => {
    const db = freshDb();
    await upsertThread(db, capture(turns(1, 3)));
    const regenerated = [...turns(1, 2), m('u3', 'user', 'Question number 3 about webhook retries'), m('a3-new', 'assistant', 'A different third answer')];
    await upsertThread(db, capture(regenerated));
    const ids = (await stored(db)).map((r) => r.sourceMessageId);
    expect(ids).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3-new']);
  });

  it('does not pair different messages that happen to share a positional id', () => {
    const pos = (i: number, role: 'user' | 'assistant', text: string): Msg => m(`${conv}_main_m_${i}`, role, text);
    const storedTop = [pos(0, 'user', 'Alpha question one'), pos(1, 'assistant', 'Alpha answer one'), pos(2, 'user', 'Beta question two')].map((x) => ({
      ...x,
      branchPath: 'main',
    }));
    // A different window of the same thread: same positional ids, different messages.
    const lowerWindow = [pos(0, 'user', 'Gamma question nine'), pos(1, 'assistant', 'Gamma answer nine')];
    expect(alignMessages(storedTop, lowerWindow).size).toBe(0);
  });
});

describe('snapshots outrank re-renderings', () => {
  const markdownReply = 'Use an **idempotency key**: store each event id and skip any event you have already processed.';
  const renderedReply = 'Use an idempotency key: store each event id and skip any event you have already processed.';

  it('keeps the snapshot text when the DOM shows the same messages rendered differently, and stays full', async () => {
    const db = freshDb();
    const snapshot = [m('u1', 'user', 'How do I stop double charges?'), m('a1', 'assistant', markdownReply)];
    await upsertThread(db, capture(snapshot, { source: 'network_observer', coverage: 'full' }));
    const before = (await db.conversations.get(threadKey))!;

    await upsertThread(db, capture([m('u1', 'user', 'How do I stop double charges?'), m('a1', 'assistant', renderedReply)]));
    const after = (await db.conversations.get(threadKey))!;
    expect((await stored(db)).map((r) => r.content)).toEqual(['How do I stop double charges?', markdownReply]);
    expect(after.coverage).toBe('full');
    expect(after.captureSource).toBe('network_observer');
    // Same content, so no new revision and nothing to re-analyze.
    expect(after.sourceRevision).toBe(before.sourceRevision);
  });

  it('appends turns that finished after the snapshot, keeps it full, and does not duplicate when ids differ', async () => {
    const db = freshDb();
    await upsertThread(db, capture([m('u1', 'user', 'How do I stop double charges?'), m('a1', 'assistant', markdownReply)], { source: 'history_sync', coverage: 'full' }));
    // Claude-style: the DOM has no message uuid, so its ids differ from the snapshot's.
    await upsertThread(
      db,
      capture([
        m('turn-1', 'user', 'How do I stop double charges?'),
        m('turn-2', 'assistant', renderedReply),
        m('turn-3', 'user', 'Show me the table definition'),
      ])
    );
    const rows = await stored(db);
    expect(rows.map((r) => r.content)).toEqual(['How do I stop double charges?', markdownReply, 'Show me the table definition']);
    expect((await db.conversations.get(threadKey))!.coverage).toBe('full');
  });

  it('never drops snapshot messages the page did not show between matches', async () => {
    const db = freshDb();
    await upsertThread(db, capture(turns(1, 3), { source: 'export_import', coverage: 'full' }));
    // The page omits turn 2's assistant message (for example a tool-only turn it renders without text).
    const without = turns(1, 3).filter((x) => x.sourceMessageId !== 'a2');
    await upsertThread(db, capture(without));
    expect((await stored(db)).map((r) => r.sourceMessageId)).toEqual(['u1', 'a1', 'u2', 'a2', 'u3', 'a3']);
  });

  it('a later snapshot replaces the stored messages entirely', async () => {
    const db = freshDb();
    await upsertThread(db, capture(turns(1, 3)));
    await upsertThread(db, capture(turns(1, 4), { source: 'history_sync', coverage: 'full' }));
    const rec = (await db.conversations.get(threadKey))!;
    expect(rec.messageCount).toBe(8);
    expect(rec.coverage).toBe('full');
    expect(rec.captureSource).toBe('history_sync');
  });
});

describe('titles', () => {
  it('does not overwrite a real title with one derived from the first message', async () => {
    const db = freshDb();
    await upsertThread(db, capture(turns(1, 1), { source: 'network_observer', coverage: 'full', title: 'Stripe webhook retries' }));
    await upsertThread(db, capture(turns(1, 2), { title: 'Question number 1 about webhook retries' }));
    expect((await db.conversations.get(threadKey))!.title).toBe('Stripe webhook retries');
    await upsertThread(db, capture(turns(1, 2), { title: 'Webhook retry policy' }));
    expect((await db.conversations.get(threadKey))!.title).toBe('Webhook retry policy');
  });

  it('recognizes derived and placeholder titles', () => {
    const msgs = [{ role: 'user', content: 'Plan the launch for next week' }];
    expect(looksDerivedTitle('Plan the launch for next week', msgs)).toBe(true);
    expect(looksDerivedTitle('Untitled conversation', msgs)).toBe(true);
    expect(looksDerivedTitle('Launch plan', msgs)).toBe(false);
  });
});

describe('large threads', () => {
  it('aligns a 400-message snapshot with a DOM copy whose ids all differ, quickly and without duplicates', () => {
    const body = (k: number) => `Message number ${k} with enough words to be a real turn about retries and tables ${'x'.repeat(400)}`;
    const snapshot = Array.from({ length: 400 }, (_, k) => ({ ...m(`api-${k}`, k % 2 ? 'assistant' : 'user', body(k)), branchPath: 'main' }));
    const dom = Array.from({ length: 400 }, (_, k) => m(`dom-${k}`, k % 2 ? 'assistant' : 'user', body(k)));
    const t0 = performance.now();
    const result = mergeCapturedMessages(snapshot, dom, { authoritativeStored: true });
    const ms = performance.now() - t0;
    expect(result.anchored).toBe(true);
    expect(result.messages).toHaveLength(400);
    expect(result.messages.every((x, k) => x.sourceMessageId === `api-${k}`)).toBe(true);
    expect(ms).toBeLessThan(1000);
  });
});

describe('merge primitives', () => {
  it('compares text without markup and tolerates a stripped prefix', () => {
    expect(sameMessageText('**Bold** answer', 'Bold answer')).toBe(true);
    expect(sameMessageText('Thought for 3s\nStore each processed event id and skip duplicates.', 'Store each processed event id and skip duplicates.')).toBe(true);
    expect(sameMessageText('short', 'shorter text')).toBe(false);
    expect(sameMessageText('', 'x')).toBe(false);
  });

  it('with no anchor a shorter capture adds and a longer one replaces', () => {
    const base = turns(1, 2).map((x) => ({ ...x, branchPath: 'main' }));
    const elsewhere = [m('x1', 'user', 'Unrelated message one'), m('x2', 'assistant', 'Unrelated reply one')];
    const shorter = mergeCapturedMessages(base, elsewhere, { authoritativeStored: false });
    expect(shorter.anchored).toBe(false);
    expect(shorter.messages).toHaveLength(6);
    const longer = mergeCapturedMessages(elsewhere.map((x) => ({ ...x, branchPath: 'main' })), turns(1, 2), { authoritativeStored: false });
    expect(longer.messages.map((x) => x.sourceMessageId)).toEqual(['u1', 'a1', 'u2', 'a2']);
  });
});
