import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { ThreadkeeperDB, upsertThread, type UpsertThreadInput } from '../../src/core/db.js';
import { buildThreadKey } from '../../src/core/schema.js';

let dbCounter = 0;
function freshDb(): ThreadkeeperDB {
  dbCounter += 1;
  return new ThreadkeeperDB(`ThreadkeeperMessageIdentity_${Date.now()}_${dbCounter}`);
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
