import 'fake-indexeddb/auto';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, it, expect, vi } from 'vitest';
import { buildThreadKey, type ConversationRecord, type RelationshipRecord } from '../../src/core/schema.js';
import {
  ThreadStackDB,
  UNFILED_PROJECT,
  applyBulkThreadEdit,
  deleteConversationsCascade,
  exportSelectedThreads,
  updateManualThreadFields,
  upsertThread,
  type UpsertThreadInput,
} from '../../src/core/db.js';
import { importPortableBundle } from '../../src/core/adapters.js';
import { undoChangeLog } from '../../src/core/organization.js';
import {
  RowCheck,
  bundleToMarkdown,
  selectRange,
  sortThreadHits,
} from '../../src/entrypoints/manager/BulkActions.js';

let dbCounter = 0;
function freshDb(): ThreadStackDB {
  dbCounter += 1;
  return new ThreadStackDB(`BulkTestDB_${dbCounter}_${Date.now()}`);
}

const ACCOUNT = { accountId: 'acct_bulk', workspaceId: 'ws_bulk' };

function thread(id: string, extra: Partial<UpsertThreadInput> = {}): UpsertThreadInput {
  return {
    threadKey: buildThreadKey({ provider: 'chatgpt', ...ACCOUNT, sourceConversationId: id, branchId: 'main' }),
    provider: 'chatgpt',
    ...ACCOUNT,
    sourceConversationId: id,
    branchId: 'main',
    canonicalUrl: `https://chatgpt.com/c/${id}`,
    title: `Thread ${id}`,
    createdAt: '2026-10-01T09:00:00.000Z',
    updatedAt: '2026-10-02T09:00:00.000Z',
    coverage: 'full',
    captureSource: 'export_import',
    tags: ['seed'],
    messages: [
      { sourceMessageId: `${id}_m0`, role: 'user', content: `Question about ${id}`, createdAt: null },
      { sourceMessageId: `${id}_m1`, role: 'assistant', content: `Answer about ${id}`, createdAt: null },
    ],
    ...extra,
  };
}

/** Five threads: a, b and c are selected in most tests; d and e must never change. */
async function seedLibrary(db: ThreadStackDB): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};
  const specs: Array<[string, Partial<UpsertThreadInput>]> = [
    ['a', { project: 'Daydock / Meridian', projectSource: 'ai' }],
    ['b', { project: 'HypeStake', categoryLocked: true, projectSource: 'manual', pinned: true }],
    ['c', {}],
    ['d', { project: 'HypeStake', projectSource: 'rules' }],
    ['e', { cloudExcluded: true }],
  ];
  for (const [id, extra] of specs) {
    const res = await upsertThread(db, thread(id, extra));
    keys[id] = res.record!.threadKey;
  }
  return keys;
}

async function snapshot(db: ThreadStackDB, keys: string[]): Promise<Record<string, ConversationRecord>> {
  const out: Record<string, ConversationRecord> = {};
  for (const k of keys) out[k] = (await db.conversations.get(k))!;
  return out;
}

describe('applyBulkThreadEdit updates exactly the selected threads', () => {
  const cases: Array<[string, Parameters<typeof applyBulkThreadEdit>[2], (c: ConversationRecord) => void]> = [
    ['move', { project: 'General research' }, (c) => {
      expect(c.project).toBe('General research');
      expect(c.categoryLocked).toBe(true);
      expect(c.projectSource).toBe('manual');
    }],
    ['move to Unfiled', { project: UNFILED_PROJECT }, (c) => expect(c.project).toBe(UNFILED_PROJECT)],
    ['status', { workflowState: 'done' }, (c) => {
      expect(c.workflowState).toBe('done');
      expect(c.workflowStateSource).toBe('manual');
    }],
    ['tag', { addTags: ['Brand ID'] }, (c) => {
      // Normalized through the tag synonyms, kept as a manual tag, existing tags kept.
      expect(c.tags).toEqual(expect.arrayContaining(['seed', 'branding']));
      expect(c.manualTags).toEqual(expect.arrayContaining(['seed', 'branding']));
    }],
    ['pin', { pinned: true }, (c) => expect(c.pinned).toBe(true)],
    ['unpin', { pinned: false }, (c) => expect(c.pinned).toBe(false)],
    ['local-only on', { cloudExcluded: true }, (c) => expect(c.cloudExcluded).toBe(true)],
    ['local-only off', { cloudExcluded: false }, (c) => expect(c.cloudExcluded).toBe(false)],
  ];

  for (const [name, patch, check] of cases) {
    it(name, async () => {
      const db = freshDb();
      const keys = await seedLibrary(db);
      const selected = [keys.a, keys.b, keys.c];
      const untouchedBefore = await snapshot(db, [keys.d, keys.e]);

      const entry = await applyBulkThreadEdit(db, selected, patch, (n) => `${name} ${n}`);

      expect(entry?.snapshots.map((s) => s.threadKey).sort()).toEqual([...selected].sort());
      expect(entry?.description).toBe(`${name} 3`);
      for (const k of selected) check((await db.conversations.get(k))!);
      expect(await snapshot(db, [keys.d, keys.e])).toEqual(untouchedBefore);
      expect(await db.changeLogs.count()).toBe(1);
    });
  }

  it('records nothing for an empty patch, and skips deleted threads', async () => {
    const db = freshDb();
    const keys = await seedLibrary(db);
    expect(await applyBulkThreadEdit(db, [keys.a], { addTags: ['  '] }, 'noop')).toBeNull();
    expect(await db.changeLogs.count()).toBe(0);

    await deleteConversationsCascade(db, [keys.b]);
    const entry = await applyBulkThreadEdit(db, [keys.a, keys.b], { pinned: true }, (n) => `Pinned ${n}`);
    expect(entry?.snapshots.map((s) => s.threadKey)).toEqual([keys.a]);
    expect(entry?.description).toBe('Pinned 1');
  });
});

describe('bulk edits mean what single-thread edits mean', () => {
  it('moving locks the category exactly as the single-thread project picker does', async () => {
    const single = freshDb();
    const bulk = freshDb();
    const singleKeys = await seedLibrary(single);
    const bulkKeys = await seedLibrary(bulk);

    // The single-thread UI calls updateManualThreadFields(..., { project, categoryLocked: true }).
    for (const id of ['a', 'b', 'c']) {
      await updateManualThreadFields(single, singleKeys[id], { project: 'General research', categoryLocked: true });
    }
    await applyBulkThreadEdit(bulk, [bulkKeys.a, bulkKeys.b, bulkKeys.c], { project: 'General research' }, 'move');

    for (const id of ['a', 'b', 'c']) {
      const s = (await single.conversations.get(singleKeys[id]))!;
      const b = (await bulk.conversations.get(bulkKeys[id]))!;
      expect({ project: b.project, locked: b.categoryLocked, source: b.projectSource, reason: b.projectReason }).toEqual({
        project: s.project,
        locked: s.categoryLocked,
        source: s.projectSource,
        reason: s.projectReason,
      });
    }
  });

  it('status, pin and local-only leave the category lock as it was, like the single-thread controls', async () => {
    const db = freshDb();
    const keys = await seedLibrary(db);
    await applyBulkThreadEdit(db, [keys.a, keys.b], { workflowState: 'waiting', pinned: true, cloudExcluded: true }, 'mix');
    const a = (await db.conversations.get(keys.a))!;
    const b = (await db.conversations.get(keys.b))!;
    expect(a.categoryLocked).toBe(false);
    expect(a.project).toBe('Daydock / Meridian');
    expect(a.projectSource).toBe('ai');
    expect(b.categoryLocked).toBe(true);
    expect(b.project).toBe('HypeStake');
  });

  it('a manual move survives a later import that proposes another project', async () => {
    const db = freshDb();
    const keys = await seedLibrary(db);
    await applyBulkThreadEdit(db, [keys.a], { project: 'General research' }, 'move');
    await upsertThread(db, thread('a', { project: 'HypeStake', projectSource: 'import' }));
    expect((await db.conversations.get(keys.a))!.project).toBe('General research');
  });
});

describe('Undo restores every previous value', () => {
  it('after a move, a status change, a tag, a pin and local-only', async () => {
    const db = freshDb();
    const keys = await seedLibrary(db);
    const selected = [keys.a, keys.b, keys.c];
    const before = await snapshot(db, selected);

    const entries = [
      await applyBulkThreadEdit(db, selected, { project: 'General research' }, 'move'),
      await applyBulkThreadEdit(db, selected, { workflowState: 'archived' }, 'status'),
      await applyBulkThreadEdit(db, selected, { addTags: ['launch'] }, 'tag'),
      await applyBulkThreadEdit(db, selected, { pinned: false }, 'unpin'),
      await applyBulkThreadEdit(db, selected, { cloudExcluded: true }, 'local'),
    ];
    // Undo newest first, as the header's Undo does.
    for (const entry of entries.reverse()) {
      const res = await undoChangeLog(db, entry!.changeId);
      expect(res.restoredCount).toBe(3);
    }

    const after = await snapshot(db, selected);
    for (const k of selected) {
      const b = before[k];
      const a = after[k];
      expect({
        project: a.project,
        categoryLocked: a.categoryLocked,
        projectSource: a.projectSource,
        projectReason: a.projectReason ?? null,
        workflowState: a.workflowState,
        workflowStateSource: a.workflowStateSource,
        tags: a.tags,
        manualTags: a.manualTags,
        pinned: a.pinned,
        cloudExcluded: a.cloudExcluded,
      }).toEqual({
        project: b.project,
        categoryLocked: b.categoryLocked,
        projectSource: b.projectSource,
        projectReason: b.projectReason ?? null,
        workflowState: b.workflowState,
        workflowStateSource: b.workflowStateSource,
        tags: b.tags,
        manualTags: b.manualTags,
        pinned: b.pinned,
        cloudExcluded: b.cloudExcluded,
      });
    }
    expect((await db.changeLogs.toArray()).every((c) => c.undone)).toBe(true);
  });

  it('restores mixed previous pin states thread by thread', async () => {
    const db = freshDb();
    const keys = await seedLibrary(db);
    // b starts pinned, a does not.
    const entry = await applyBulkThreadEdit(db, [keys.a, keys.b], { pinned: true }, 'pin');
    await undoChangeLog(db, entry!.changeId);
    expect((await db.conversations.get(keys.a))!.pinned).toBe(false);
    expect((await db.conversations.get(keys.b))!.pinned).toBe(true);
  });
});

describe('deleteConversationsCascade', () => {
  it('deletes exactly the selected threads, leaves tombstones, and blocks re-capture', async () => {
    const db = freshDb();
    const keys = await seedLibrary(db);
    const deleted = await deleteConversationsCascade(db, [keys.a, keys.c, keys.c]);

    expect(deleted).toBe(2);
    expect(await db.conversations.get(keys.a)).toBeUndefined();
    expect(await db.conversations.get(keys.c)).toBeUndefined();
    expect(await db.messages.where('threadKey').equals(keys.a).count()).toBe(0);
    expect((await db.tombstones.toArray()).map((t) => t.threadKey).sort()).toEqual([keys.a, keys.c].sort());
    for (const id of ['b', 'd', 'e']) expect(await db.conversations.get(keys[id])).toBeDefined();

    expect((await upsertThread(db, thread('a'))).status).toBe('skipped_tombstone');
  });
});

describe('exportSelectedThreads', () => {
  it('includes exactly the selected threads and only the relationships between them', async () => {
    const db = freshDb();
    const keys = await seedLibrary(db);
    const rel = (from: string, to: string): RelationshipRecord => ({
      relationshipKey: `${from}->${to}`,
      fromThreadKey: from,
      toThreadKey: to,
      relationType: 'related',
      reason: 'test',
      evidenceFromOrdinal: 0,
      evidenceToOrdinal: 0,
      confidence: 0.9,
      confirmedByUser: false,
      dismissedByUser: false,
    });
    await db.relationships.bulkPut([rel(keys.a, keys.c), rel(keys.a, keys.d), rel(keys.e, keys.c)]);

    const bundle = await exportSelectedThreads(db, [keys.c, keys.a]);

    expect(bundle.format).toBe('threadkeeper-portable-v1');
    expect(bundle.conversations.map((e) => e.conversation.threadKey)).toEqual([keys.c, keys.a]);
    expect(bundle.conversations[0].messages.map((m) => m.content)).toEqual(['Question about c', 'Answer about c']);
    expect(bundle.relationships.map((r) => r.relationshipKey)).toEqual([`${keys.a}->${keys.c}`]);

    const markdown = bundleToMarkdown(bundle);
    expect(markdown).toContain('# Thread c');
    expect(markdown).toContain('# Thread a');
    expect(markdown).not.toContain('Thread b');
    expect(markdown).not.toContain('Thread d');
    expect(markdown.split('\n---\n')).toHaveLength(2);

    // The bundle re-imports as exactly those threads.
    const target = freshDb();
    const res = await importPortableBundle(target, bundle);
    expect(res.importedCount).toBe(2);
    expect((await target.conversations.toArray()).map((c) => c.sourceConversationId).sort()).toEqual(['a', 'c']);
  });
});

describe('list sort', () => {
  const hit = (id: string, updatedAt: string | null, title: string, messageCount: number) => ({
    conversation: {
      threadKey: id,
      title,
      updatedAt,
      lastCapturedAt: '2026-10-05T00:00:00.000Z',
      messageCount,
    } as ConversationRecord,
  });
  // Arrives in the list's current order (most recent first).
  const hits = [
    hit('x', '2026-10-30T10:00:00.000Z', 'beta notes', 4),
    hit('y', '2026-10-20T10:00:00.000Z', 'Alpha plan', 12),
    hit('z', null, 'item 10', 1),
    hit('w', '2026-10-01T10:00:00.000Z', 'item 9', 12),
  ];
  const titleOf = (c: ConversationRecord) => c.title;
  const order = (mode: Parameters<typeof sortThreadHits>[1]) =>
    sortThreadHits(hits, mode, titleOf).map((h) => h.conversation.threadKey);

  it('Recent activity keeps the current order', () => expect(order('recent')).toEqual(['x', 'y', 'z', 'w']));
  it('Oldest first orders by last activity, falling back to capture time', () =>
    expect(order('oldest')).toEqual(['w', 'z', 'y', 'x']));
  it('Title A–Z ignores case and orders numbers naturally', () => expect(order('title')).toEqual(['y', 'x', 'w', 'z']));
  it('Most messages keeps the current order between equals', () => expect(order('messages')).toEqual(['y', 'w', 'x', 'z']));
  it('does not reorder the array it was given', () => {
    order('title');
    expect(hits.map((h) => h.conversation.threadKey)).toEqual(['x', 'y', 'z', 'w']);
  });
});

describe('selection', () => {
  const view = ['k1', 'k2', 'k3', 'k4', 'k5'];

  it('a click toggles one row', () => {
    expect([...selectRange(view, new Set(['k1']), null, 'k3', true)]).toEqual(['k1', 'k3']);
    expect([...selectRange(view, new Set(['k1', 'k3']), null, 'k3', false)]).toEqual(['k1']);
  });

  it('shift-click checks every row between the last one and this one, either direction', () => {
    expect([...selectRange(view, new Set(['k2']), 'k2', 'k4', true)].sort()).toEqual(['k2', 'k3', 'k4']);
    expect([...selectRange(view, new Set(['k4']), 'k4', 'k1', true)].sort()).toEqual(['k1', 'k2', 'k3', 'k4']);
  });

  it('shift-click can uncheck a range, and keeps rows outside it', () => {
    const next = selectRange(view, new Set(view), 'k2', 'k4', false);
    expect([...next].sort()).toEqual(['k1', 'k5']);
  });

  it('an anchor no longer in view toggles only the clicked row', () => {
    expect([...selectRange(view, new Set(), 'gone', 'k3', true)]).toEqual(['k3']);
  });

  it('the row checkbox reports shift-clicks and never bubbles into the row', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const container = document.createElement('div');
    document.body.appendChild(container);
    const onToggle = vi.fn();
    const onRowClick = vi.fn();
    const root = createRoot(container);
    await act(async () => {
      root.render(
        React.createElement(
          'li',
          null,
          React.createElement(RowCheck, { threadKey: 'k2', title: 'Thread two', checked: false, onToggle }),
          React.createElement('button', { type: 'button', onClick: onRowClick }, 'open')
        )
      );
    });
    const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    expect(box.getAttribute('aria-label')).toBe('Select Thread two');

    await act(async () => {
      box.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    expect(onToggle).toHaveBeenLastCalledWith('k2', true, true);

    await act(async () => {
      box.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onToggle).toHaveBeenLastCalledWith('k2', true, false);
    expect(onRowClick).not.toHaveBeenCalled();

    await act(async () => root.unmount());
    container.remove();
  });
});

describe('undoing a bulk edit never switches off local-only protection set since', () => {
  it('restores the moved project but keeps a local-only flag added after the move', async () => {
    const db = freshDb();
    const keys = await seedLibrary(db);
    const move = await applyBulkThreadEdit(db, [keys.a, keys.c], { project: 'General research' }, 'move');
    // After the move, the user marks thread a local-only on its own.
    await updateManualThreadFields(db, keys.a, { cloudExcluded: true });

    await undoChangeLog(db, move!.changeId);

    const a = (await db.conversations.get(keys.a))!;
    expect(a.project).toBe('Daydock / Meridian');
    expect(a.cloudExcluded).toBe(true);
  });

  it('still reverts local-only when the bulk edit itself changed it', async () => {
    const db = freshDb();
    const keys = await seedLibrary(db);
    const local = await applyBulkThreadEdit(db, [keys.c], { cloudExcluded: true }, 'local');
    await undoChangeLog(db, local!.changeId);
    expect((await db.conversations.get(keys.c))!.cloudExcluded).toBe(false);
  });
});
