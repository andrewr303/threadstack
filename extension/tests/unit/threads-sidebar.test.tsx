import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type ConversationRecord } from '../../src/core/schema.js';
import { MemorySearchIndex, type SearchHit } from '../../src/core/search.js';
import { EMPTY_WORKSPACE_STATE } from '../../src/core/workspace/types.js';
import { ListPane, type ListPaneProps } from '../../src/entrypoints/manager/threads/ListPane.js';
import { Rail, type RailProps } from '../../src/entrypoints/manager/shell/Rail.js';
import { WorkspaceProvider, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const conversation = {
  threadKey: 'chatgpt:one', provider: 'chatgpt', title: 'Research decisions', project: 'Research',
  workflowState: 'active', coverage: 'full', branchId: 'main', messageCount: 7,
  updatedAt: '2026-11-14T12:00:00Z', lastCapturedAt: '2026-11-14T12:00:00Z',
} as ConversationRecord;
const hit: SearchHit = { conversation, score: 1, lexicalScore: 1, vectorScore: 0, rerankScore: null,
  supportingExcerpt: 'A matching decision in the conversation', matchReasons: ['Title match'], matchedMessageOrdinal: null };
let container: HTMLDivElement;
let root: Root;
let selectThread: ReturnType<typeof vi.fn>;
let selectRows: ReturnType<typeof vi.fn>;
let search: ReturnType<typeof vi.fn>;
let patch: ReturnType<typeof vi.fn>;

function props(overrides: Partial<ListPaneProps> = {}): ListPaneProps {
  return {
    settings: DEFAULT_SETTINGS, conversations: [conversation], insightsByThread: new Map(), summariesByThread: new Map(),
    messagesByThread: new Map(), vectorsByThread: new Map(), searchIndex: new MemorySearchIndex(),
    collectionByName: new Map(), projectNames: ['Research'], providerOptions: ['chatgpt'], listHits: [hit],
    kanbanColumns: [], cardGroups: [], viewKeys: [conversation.threadKey], queueItemsMap: null,
    selectedThreadKey: conversation.threadKey, activeTabConversation: null, listMode: 'search', searchQuery: '', rerankNote: null,
    providerFilter: 'all', kindFilter: 'all', stateFilter: 'all', coverageFilter: 'all', sortMode: 'recent', checkedKeys: new Set(),
    isCompact: false, stillPaired: false, searchInputRef: { current: null }, selectAllRef: { current: null }, bulkDeleteDialogRef: { current: null },
    onListModeChange: vi.fn(), onSearchChange: search, onSearchSubmit: vi.fn(), onProviderFilterChange: vi.fn(),
    onKindFilterChange: vi.fn(), onStateFilterChange: vi.fn(), onCoverageFilterChange: vi.fn(), onSortModeChange: vi.fn(),
    onPatchSettings: patch, onSelectThread: selectThread, onToggleChecked: selectRows, onSelectionChange: vi.fn(),
    onBulkChanged: vi.fn(async () => {}), onBulkDialogClosed: vi.fn(), onAnnounce: vi.fn(), onSendToStill: vi.fn(),
    onOpenSettings: vi.fn(), onOpenImport: vi.fn(), canEdit: () => true, registerRow: vi.fn(),
    ...overrides,
  };
}

function context(): WorkspaceContextValue {
  return {
    surface: 'page', settings: DEFAULT_SETTINGS, patchSettings: patch, view: 'threads', setView: vi.fn(),
    detailMode: 'live', setDetailMode: vi.fn(), conversations: [conversation], conversationByKey: new Map([[conversation.threadKey, conversation]]),
    insightsByThread: new Map(), summariesByThread: new Map(), selectedThreadKey: conversation.threadKey,
    accountOfThread: () => ({ realm: null, account: null, active: false, switchable: false }), openSession: vi.fn(),
    togglePinned: vi.fn(), openInChromeTab: vi.fn(), requestAddAccount: vi.fn(), openSettings: vi.fn(), announce: vi.fn(),
    workspace: { ready: true, enabled: true, realms: [], state: EMPTY_WORKSPACE_STATE, plan: { live: [], resting: {} }, error: null },
  } as unknown as WorkspaceContextValue;
}

async function renderSidebar(overrides: Partial<ListPaneProps> = {}, rail: Partial<RailProps> = {}) {
  const list = <ListPane {...props(overrides)} placement="sidebar" />;
  await act(async () => root.render(
    <WorkspaceProvider value={context()}>
      <Rail collapsed={false} drawerOpen={false} view="threads" effectiveTheme="dark" onViewChange={vi.fn()}
        onToggleCollapsed={vi.fn()} onCloseDrawer={vi.fn()} onToggleTheme={vi.fn()} onOpenSettings={vi.fn()} sessions={list} {...rail}>
        <nav aria-label="Projects and resurfacing queues"><button>All threads</button></nav>
      </Rail>
    </WorkspaceProvider>
  ));
}

beforeEach(() => {
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  selectThread = vi.fn(); selectRows = vi.fn(); search = vi.fn(); patch = vi.fn(async () => {});
});
afterEach(() => { act(() => root.unmount()); container.remove(); });

describe('Threads navigation in the existing sidebar', () => {
  it('uses one complete thread index in place of the duplicate recent sessions list', async () => {
    await renderSidebar();
    expect(container.querySelectorAll('.tk-list-pane')).toHaveLength(1);
    expect(container.querySelector('.tk-list-pane')?.closest('.tk-rail')).not.toBeNull();
    expect(container.querySelector('.tk-rail-sessions')).toBeNull();
    expect(container.querySelector('[aria-label="Search conversations, decisions, and messages"]')).not.toBeNull();
    expect(container.querySelector('details summary')?.textContent).toContain('Projects');
    const row = container.querySelector<HTMLButtonElement>('button.tk-row-btn')!;
    expect(row.getAttribute('aria-selected')).toBe('true');
    await act(async () => row.click());
    expect(selectThread).toHaveBeenCalledWith(conversation.threadKey);
    const checkbox = container.querySelector<HTMLInputElement>('input[aria-label="Select Research decisions"]')!;
    await act(async () => checkbox.click());
    expect(selectRows).toHaveBeenCalledWith(conversation.threadKey, true, false);
    expect(selectThread).toHaveBeenCalledTimes(1);
  });

  it('keeps sorting, grouping and capture filters available behind a compact disclosure', async () => {
    await renderSidebar();
    const toggle = container.querySelector<HTMLButtonElement>('.tk-thr-filters-toggle')!;
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await act(async () => toggle.click());
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    for (const name of ['Sort threads', 'Group by', 'View mode', 'Filter by capture coverage']) {
      expect(container.querySelector(`select[aria-label="${name}"]`)).not.toBeNull();
    }
    const group = container.querySelector<HTMLSelectElement>('select[aria-label="Group by"]')!;
    await act(async () => { group.value = 'project'; group.dispatchEvent(new Event('change', { bubbles: true })); });
    expect(patch).toHaveBeenCalledWith({ threadsGroupBy: 'project' });
  });

  it('gives Ask its own full-width form with a usable textarea and a separate action row', async () => {
    await renderSidebar({ listMode: 'ask' });
    const form = container.querySelector('.tk-ask-form')!;
    const textarea = form.querySelector('textarea')!;
    expect(textarea.rows).toBeGreaterThanOrEqual(4);
    expect(form.querySelector('.tk-ask-submit button')?.textContent).toBe('Find threads');
    expect(form.querySelector('.tk-ask-submit')?.contains(textarea)).toBe(false);
  });

  it('keeps an Ask draft mounted when the sidebar collapses or another view is opened', async () => {
    await renderSidebar({ listMode: 'ask' });
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, 'What did we decide?');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await renderSidebar({ listMode: 'ask' }, { collapsed: true });
    expect(container.querySelector('textarea')).toBe(textarea);
    expect(textarea.closest<HTMLElement>('.tk-rail-scroll')?.hidden).toBe(true);
    await renderSidebar({ listMode: 'ask' }, { view: 'browse' });
    expect(container.querySelector('textarea')).toBe(textarea);
    await renderSidebar({ listMode: 'ask' });
    expect(textarea.value).toBe('What did we decide?');
    expect(textarea.closest<HTMLElement>('.tk-rail-scroll')?.hidden).toBe(false);
  });
});
