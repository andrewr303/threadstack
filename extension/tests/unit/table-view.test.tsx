import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { TableView } from '../../src/entrypoints/manager/table/TableView.js';
import { WorkspaceProvider, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import { sharedDb } from '../../src/entrypoints/manager/shared.js';
import { ensureStarterCollectionsAndSettings, upsertThread } from '../../src/core/db.js';
import { DEFAULT_SETTINGS, buildThreadKey, normalizeTableLayout, type ConversationRecord, type ProviderId, type SettingsRecord } from '../../src/core/schema.js';
import { applyAiCells, createTableColumn } from '../../src/core/thread-table.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let openSession: ReturnType<typeof vi.fn>;
let patchSettings: ReturnType<typeof vi.fn>;
let onThreadsEdited: ReturnType<typeof vi.fn>;
let settings: SettingsRecord;

async function addThread(id: string, title: string, provider: ProviderId, createdAt: string): Promise<ConversationRecord> {
  const threadKey = buildThreadKey({ provider, accountId: 'acct_v', workspaceId: 'ws_v', sourceConversationId: id, branchId: 'main' });
  const res = await upsertThread(sharedDb, {
    threadKey,
    provider,
    accountId: 'acct_v',
    workspaceId: 'ws_v',
    sourceConversationId: id,
    branchId: 'main',
    canonicalUrl: `https://example.com/${id}`,
    title,
    createdAt,
    updatedAt: createdAt,
    coverage: 'full',
    captureSource: 'export_import',
    messages: [{ sourceMessageId: `${id}_0`, role: 'user', content: title, createdAt: null }],
  });
  return res.record!;
}

async function flush() {
  // Dexie reads resolve over several microtask and macrotask turns.
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mount(convs: ConversationRecord[]) {
  const value = {
    surface: 'page',
    workspace: {} as never,
    settings,
    patchSettings,
    view: 'table',
    setView: vi.fn(),
    detailMode: 'summary',
    setDetailMode: vi.fn(),
    conversations: convs,
    conversationByKey: new Map(convs.map((c) => [c.threadKey, c])),
    insightsByThread: new Map(),
    summariesByThread: new Map(),
    selectedThreadKey: null,
    accountOfThread: () => ({ realm: null, account: null, active: true, switchable: false }),
    openSession,
    togglePinned: vi.fn(),
    openInChromeTab: vi.fn(),
    requestAddAccount: vi.fn(),
    openSettings: vi.fn(),
    announce: vi.fn(),
  } as unknown as WorkspaceContextValue;
  await act(async () => {
    root.render(
      <WorkspaceProvider value={value}>
        <TableView projectNames={['General research', 'Unfiled / Uncertain']} aiReady={false} onThreadsEdited={onThreadsEdited} />
      </WorkspaceProvider>
    );
  });
  await flush();
}

const headers = () => [
  ...[...container.querySelectorAll('thead .tk-table-sort > .tk-ellipsis')].map((el) => el.textContent),
  ...[...container.querySelectorAll('thead .tk-table-addcol .tk-visually-hidden')].map((el) => el.textContent),
];
const titles = () => [...container.querySelectorAll('tbody .tk-table-title')].map((b) => b.textContent);
/** What a cell says, without decorative marks hidden from assistive technology. */
const cellText = (rowIndex: number, col: string) => {
  const cell = container.querySelectorAll('tbody tr')[rowIndex]?.querySelector(`[data-col="${col}"]`);
  if (!cell) return undefined;
  const copy = cell.cloneNode(true) as Element;
  copy.querySelectorAll('[aria-hidden="true"]').forEach((el) => el.remove());
  return copy.textContent?.trim();
};

beforeEach(async () => {
  await sharedDb.delete();
  await sharedDb.open();
  await ensureStarterCollectionsAndSettings(sharedDb);
  settings = { ...DEFAULT_SETTINGS, threadsTable: normalizeTableLayout(undefined) };
  openSession = vi.fn();
  onThreadsEdited = vi.fn(async () => undefined);
  patchSettings = vi.fn(async (patch: Partial<SettingsRecord>) => {
    settings = { ...settings, ...patch };
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('TableView', () => {
  it('shows each thread with its type, provider and dates, newest first', async () => {
    const chat = await addThread('c1', 'Pricing research', 'chatgpt', '2026-10-01T12:00:00.000Z');
    const code = await addThread('c2', 'Fix flaky auth test', 'claude_code', '2026-11-01T12:00:00.000Z');
    await mount([chat, code]);
    expect(headers()).toEqual(['Title', 'Type', 'Provider', 'Created', 'Last active', 'Status', 'Project', 'Topics', 'New column']);
    expect(titles()).toEqual(['Fix flaky auth test', 'Pricing research']);
    expect(cellText(0, 'type')).toBe('Coding agent');
    expect(cellText(0, 'provider')).toBe('Claude Code');
    expect(cellText(1, 'type')).toBe('Chat');
    expect(cellText(1, 'provider')).toBe('ChatGPT');
    expect(cellText(1, 'created')).toBe('Oct 1, 2026');
  });

  it('sorts by a header and remembers it', async () => {
    const a = await addThread('a', 'Beta', 'chatgpt', '2026-10-01T12:00:00.000Z');
    const b = await addThread('b', 'Alpha', 'claude', '2026-11-01T12:00:00.000Z');
    await mount([a, b]);
    const titleSort = container.querySelector<HTMLButtonElement>('thead [data-col="title"] .tk-table-sort')!;
    await act(async () => titleSort.click());
    expect(patchSettings).toHaveBeenLastCalledWith({ threadsTable: { hidden: expect.any(Array), sort: { column: 'title', direction: 'asc' } } });
    await mount([a, b]);
    expect(titles()).toEqual(['Alpha', 'Beta']);
    expect(container.querySelector('thead [data-col="title"]')?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('edits a column value by hand and stores it as the person’s', async () => {
    const a = await addThread('a', 'Webhook retries', 'chatgpt', '2026-10-01T12:00:00.000Z');
    const column = await createTableColumn(sharedDb, { name: 'Notes', type: 'text' });
    await mount([a]);
    expect(headers()).toContain('Notes');
    const cell = container.querySelector<HTMLButtonElement>('tbody .tk-table-cellbtn')!;
    await act(async () => cell.click());
    const input = container.querySelector<HTMLInputElement>('tbody .tk-table-input')!;
    expect(input).not.toBeNull();
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Ship Friday');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await flush();
    const stored = await sharedDb.tableCells.toArray();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ columnId: column.id, threadKey: a.threadKey, value: 'Ship Friday', source: 'manual' });
    expect(container.querySelector('tbody .tk-table-cellbtn')?.textContent).toContain('Ship Friday');
  });

  it('leaves Claude’s value as Claude’s when a cell is opened and left unchanged', async () => {
    const a = await addThread('a', 'Webhook retries', 'chatgpt', '2026-10-01T12:00:00.000Z');
    const column = await createTableColumn(sharedDb, { name: 'Notes', type: 'text' });
    await applyAiCells(sharedDb, column.id, [{ threadKey: a.threadKey, value: 'Retries', reason: 'r' }], { model: 'm' });
    await mount([a]);
    expect(container.querySelector('tbody .tk-table-ai')).not.toBeNull();
    await act(async () => container.querySelector<HTMLButtonElement>('tbody .tk-table-cellbtn')!.click());
    const input = container.querySelector<HTMLInputElement>('tbody .tk-table-input')!;
    expect(input.value).toBe('Retries');
    await act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await flush();
    expect((await sharedDb.tableCells.toArray())[0]).toMatchObject({ value: 'Retries', source: 'ai' });
  });

  it('changes a thread’s status from the table', async () => {
    const a = await addThread('a', 'Webhook retries', 'chatgpt', '2026-10-01T12:00:00.000Z');
    await mount([a]);
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Status of Webhook retries"]')!;
    await act(async () => {
      select.value = 'done';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await flush();
    expect((await sharedDb.conversations.get(a.threadKey))?.workflowState).toBe('done');
    expect((await sharedDb.conversations.get(a.threadKey))?.workflowStateSource).toBe('manual');
    expect(onThreadsEdited).toHaveBeenCalledWith([a.threadKey], { privacy: false });
  });

  it('filters rows by search, including stored values, and opens a thread from its title', async () => {
    const a = await addThread('a', 'Webhook retries', 'chatgpt', '2026-10-01T12:00:00.000Z');
    const b = await addThread('b', 'Landing page', 'claude', '2026-10-02T12:00:00.000Z');
    await mount([a, b]);
    const search = container.querySelector<HTMLInputElement>('input[role="searchbox"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(search, 'claude');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(titles()).toEqual(['Landing page']);
    expect(container.querySelector('.tk-table-count')?.textContent).toBe('1 of 2 threads');
    await act(async () => container.querySelector<HTMLButtonElement>('tbody .tk-table-title')!.click());
    expect(openSession).toHaveBeenCalledWith(expect.objectContaining({ threadKey: b.threadKey }), 'threads');
  });
});
