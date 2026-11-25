import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ThreadStackDB, pairStoredWithIncoming, upsertThread, type UpsertThreadInput } from '../../src/core/db.js';
import { buildThreadKey } from '../../src/core/schema.js';

let dbCounter = 0;
function freshDb(): ThreadStackDB {
  dbCounter += 1;
  return new ThreadStackDB(`ThreadStackMessageIdentity_${Date.now()}_${dbCounter}`);
}

const conv = 'c0ffee00-0000-4000-8000-000000000001';
const threadKey = buildThreadKey({
  provider: 'claude',
  accountId: 'acct_claude_primary',
  workspaceId: 'ws_personal',
  sourceConversationId: conv,
  branchId: 'main',
});

function capture(messages: UpsertThreadInput['messages']): UpsertThreadInput {
  return {
    threadKey,
    provider: 'claude',
    accountId: 'acct_claude_primary',
    workspaceId: 'ws_personal',
    sourceConversationId: conv,
    branchId: 'main',
    canonicalUrl: `https://claude.ai/chat/${conv}`,
    title: 'Stripe webhook retries',
    createdAt: null,
    updatedAt: '2026-11-03T00:00:00.000Z',
    coverage: 'partial',
    captureSource: 'dom_observer',
    messages,
  };
}

const msg = (id: string, role: 'user' | 'assistant', content: string) => ({
  sourceMessageId: id,
  role,
  content,
  createdAt: null,
  branchPath: 'main',
});

describe('message identity across the switch to site-provided message keys', () => {
  it('replaces positional ids with the keyed twin instead of storing the message twice', async () => {
    const db = freshDb();
    // Captured before 0.3: positional ids.
    await upsertThread(
      db,
      capture([
        msg(`${conv}_main_m_0`, 'user', 'Customers get charged twice when Stripe retries.'),
        msg(`${conv}_main_m_1`, 'assistant', 'Store each processed event id and skip duplicates.'),
        msg(`${conv}_main_m_2`, 'user', "Let's go with a processed_events table."),
      ])
    );
    // Recaptured from a virtualized list that shows only the last two turns, now keyed by data-turn-key.
    await upsertThread(
      db,
      capture([
        msg('turn-b', 'assistant', 'Store each processed event id and skip duplicates.'),
        msg('turn-c', 'user', "Let's go with a processed_events table."),
      ])
    );
    let stored = await db.messages.where('threadKey').equals(threadKey).sortBy('ordinal');
    expect(stored.map((m) => m.content)).toEqual([
      'Customers get charged twice when Stripe retries.',
      'Store each processed event id and skip duplicates.',
      "Let's go with a processed_events table.",
    ]);

    // A new turn changes the content, so the merged list is written: matched turns take the keyed ids.
    await upsertThread(
      db,
      capture([
        msg('turn-c', 'user', "Let's go with a processed_events table."),
        msg('turn-d', 'assistant', 'Want me to draft the migration?'),
      ])
    );
    stored = await db.messages.where('threadKey').equals(threadKey).sortBy('ordinal');
    expect(stored.map((m) => m.sourceMessageId)).toEqual([`${conv}_main_m_0`, `${conv}_main_m_1`, 'turn-c', 'turn-d']);
    expect(stored.map((m) => m.content)).toEqual([
      'Customers get charged twice when Stripe retries.',
      'Store each processed event id and skip duplicates.',
      "Let's go with a processed_events table.",
      'Want me to draft the migration?',
    ]);
  });

  it('keeps distinct messages that only share a role', async () => {
    const db = freshDb();
    await upsertThread(
      db,
      capture([
        msg(`${conv}_main_m_0`, 'user', 'First question'),
        msg(`${conv}_main_m_1`, 'assistant', 'First answer'),
        msg(`${conv}_main_m_2`, 'user', 'Second question'),
      ])
    );
    await upsertThread(db, capture([msg('turn-x', 'assistant', 'A different answer'), msg('turn-y', 'user', 'Third question')]));
    const stored = await db.messages.where('threadKey').equals(threadKey).sortBy('ordinal');
    expect(stored.map((m) => m.content)).toEqual([
      'First question',
      'First answer',
      'Second question',
      'A different answer',
      'Third question',
    ]);
  });
});

describe('pairStoredWithIncoming', () => {
  const stored = (pairs: Array<[string, 'user' | 'assistant', string]>) =>
    pairs.map(([sourceMessageId, role, content]) => ({ sourceMessageId, role, content }));
  const pos = (i: number) => `${conv}_main_m_${i}`;
  const ids = (m: Map<number, { sourceMessageId: string }>) =>
    Object.fromEntries(Array.from(m, ([i, v]) => [i, v.sourceMessageId]));

  it('pairs repeated identical messages one to one, in order', () => {
    const pairs = pairStoredWithIncoming(
      stored([
        [pos(0), 'user', 'continue'],
        [pos(1), 'assistant', 'Step one done.'],
        [pos(2), 'user', 'continue'],
        [pos(3), 'assistant', 'Step two done.'],
      ]),
      [msg('k2', 'user', 'continue'), msg('k3', 'assistant', 'Step two done.'), msg('k0', 'user', 'continue')]
    );
    // Each stored "continue" takes a different keyed id; none is left over to append.
    expect(new Set(Object.values(ids(pairs))).size).toBe(Object.keys(ids(pairs)).length);
    expect(Object.values(ids(pairs)).sort()).toEqual(['k0', 'k2', 'k3']);
  });

  it('matches a stored reply whose thinking block is now stripped', () => {
    const answer = 'Store each processed event id and skip duplicates before charging.';
    const pairs = pairStoredWithIncoming(
      stored([
        [pos(0), 'user', 'Customers get charged twice.'],
        [pos(1), 'assistant', `Thought for 4s. Considering idempotency keys…\n${answer}`],
      ]),
      [msg('turn-a', 'user', 'Customers get charged twice.'), msg('turn-b', 'assistant', answer)]
    );
    expect(ids(pairs)).toEqual({ 0: 'turn-a', 1: 'turn-b' });
  });

  it('aligns a reply whose text changed completely between matched neighbours (DeepSeek reasoning → answer)', () => {
    const pairs = pairStoredWithIncoming(
      stored([
        [pos(0), 'user', 'Plan the migration.'],
        [pos(1), 'assistant', 'Reasoning: first list the tables…'],
        [pos(2), 'user', 'Now write it.'],
        [pos(3), 'assistant', 'Old final answer'],
      ]),
      [
        msg('key-0', 'user', 'Plan the migration.'),
        msg('key-1', 'assistant', 'Create processed_events, then backfill.'),
        msg('key-2', 'user', 'Now write it.'),
        msg('key-3', 'assistant', 'Here is the SQL.'),
      ]
    );
    expect(ids(pairs)).toEqual({ 0: 'key-0', 1: 'key-1', 2: 'key-2', 3: 'key-3' });
  });

  it('never guesses a position without a matched message before it', () => {
    const pairs = pairStoredWithIncoming(
      stored([
        [pos(0), 'user', 'First question'],
        [pos(1), 'assistant', 'First answer'],
        [pos(2), 'user', 'Second question'],
        [pos(3), 'assistant', 'Second answer'],
      ]),
      // A window at the end of the thread whose texts all changed: nothing to anchor on.
      [msg('w-1', 'user', 'A later question'), msg('w-2', 'assistant', 'A later answer')]
    );
    expect(pairs.size).toBe(0);
  });
});
