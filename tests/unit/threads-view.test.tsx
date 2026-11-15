// The Threads view on the full page: grouping, the workspace filters, the detail pane's modes, the
// agent run block and the related-thread reasons. Components are rendered by hand inside a
// WorkspaceProvider; no database or service worker is involved.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, type AgentRunFacts, type ConversationRecord, type SettingsRecord, type ThreadInsight } from '../../src/core/schema.js';
import { MemorySearchIndex, type SearchHit } from '../../src/core/search.js';
import { realmForProvider } from '../../src/core/workspace/realms.js';
import { EMPTY_WORKSPACE_STATE, type AccountRecord, type RealmAccounts, type SessionTab } from '../../src/core/workspace/types.js';
import { ListPane, type ListPaneProps } from '../../src/entrypoints/manager/threads/ListPane.js';
import { DetailPane, type DetailPaneProps } from '../../src/entrypoints/manager/threads/DetailPane.js';
import { NavRail, type NavRailProps } from '../../src/entrypoints/manager/threads/NavRail.js';
import { resetThreadGrouping } from '../../src/entrypoints/manager/threads/grouping.js';
import { matchesRunFilter, type RunFilter } from '../../src/entrypoints/manager/threads/filters.js';
import type { ThreadSortMode } from '../../src/entrypoints/manager/BulkActions.js';
import type { SessionKind } from '../../src/entrypoints/manager/workspace/lens.js';
import { useThreadSearch } from '../../src/entrypoints/manager/hooks/useThreadSearch.js';
import { SemanticNeighbors, ThreadOverview, type RelatedThread } from '../../src/entrypoints/manager/ThreadOverview.js';
import { WorkspaceProvider, type ThreadAccount, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import { threadTabId } from '../../src/entrypoints/manager/workspace/state.js';
import type { WorkspaceController } from '../../src/entrypoints/manager/workspace/useWorkspace.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function account(id: string, realm: string, label: string, color: AccountRecord['color'], primary = false): AccountRecord {
  return {
    id,
    realm,
    label,
    color,
    mode: 'embedded',
    primary,
    identity: null,
    signedIn: 'unknown',
    hasJar: false,
    order: 0,
    createdAt: '2026-11-01T00:00:00.000Z',
    lastActiveAt: null,
  };
}

const WORK = account('primary~anthropic', 'anthropic', 'Work', 'teal', true);
const PERSONAL = account('acct_personal', 'anthropic', 'Personal', 'peach');
const OPENAI_WORK = account('primary~openai', 'openai', 'Work', 'sage', true);

const REALMS: RealmAccounts[] = [
  { realm: realmForProvider('claude_code')!, accounts: [WORK, PERSONAL], activeAccountId: WORK.id },
  { realm: realmForProvider('codex')!, accounts: [OPENAI_WORK], activeAccountId: OPENAI_WORK.id },
];

/** Which workspace account each fixture's stored account id stands for. */
const OWNERS: Record<string, AccountRecord> = { stored_work: WORK, stored_personal: PERSONAL, stored_openai: OPENAI_WORK };

function accountOfThread(conv: Pick<ConversationRecord, 'provider' | 'accountId'>): ThreadAccount {
  const owner = OWNERS[conv.accountId] ?? null;
  const realm = owner ? REALMS.find((r) => r.realm.id === owner.realm) ?? null : null;
  return {
    realm: realm?.realm ?? null,
    account: owner,
    active: !realm || realm.activeAccountId === owner?.id,
    switchable: true,
  };
}

let counter = 0;
function conv(patch: Partial<ConversationRecord> & Pick<ConversationRecord, 'provider' | 'accountId'>): ConversationRecord {
  counter += 1;
  const id = patch.sourceConversationId ?? `c${counter}`;
  return {
    threadKey: `${patch.provider}|${patch.accountId}|${id}`,
    workspaceId: 'ws',
    sourceConversationId: id,
    branchId: 'main',
    parentBranchId: null,
    siblingBranchIds: [],
    canonicalUrl: '',
    title: `Thread ${counter}`,
    manualTitleOverride: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: `2026-11-0${(counter % 8) + 1}T10:00:00.000Z`,
    lastCapturedAt: '2026-11-09T10:00:00.000Z',
    sourceRevision: 1,
    contentHash: 'h',
    coverage: 'full',
    captureSource: 'export_import',
    messageCount: 4,
    project: 'Hypestake',
    categoryLocked: false,
    tags: [],
    manualTags: [],
    workflowState: 'active',
    manualNotes: '',
    pinned: false,
    snoozedUntil: null,
    dismissedQueues: [],
    cloudExcluded: false,
    cloudTaskStatus: 'unsupported',
    isSyntheticBenchmark: false,
    latestDecisionText: null,
    latestDecisionMsgIndex: null,
    latestDecisionSpeaker: null,
    nextStepText: null,
    nextStepMsgIndex: null,
    nextStepSpeaker: null,
    ...patch,
  } as ConversationRecord;
}

const hit = (conversation: ConversationRecord): SearchHit => ({
  conversation,
  score: 1,
  lexicalScore: 0,
  vectorScore: 0,
  rerankScore: null,
  matchReasons: [],
  supportingExcerpt: '',
  matchedMessageOrdinal: null,
});

function tab(threadKey: string, provider: SessionTab['provider'] = 'chatgpt'): SessionTab {
  return {
    id: threadTabId(threadKey),
    provider,
    realm: 'openai',
    accountId: OPENAI_WORK.id,
    url: 'https://chatgpt.com/c/abc',
    title: 'Live',
    threadKey,
    createdAt: 1,
    lastActiveAt: 1,
  };
}

function makeContext(over: Partial<WorkspaceContextValue> & { tabs?: SessionTab[] } = {}): WorkspaceContextValue {
  const { tabs = [], ...rest } = over;
  const workspace = {
    enabled: true,
    ready: false,
    embedding: true,
    error: null,
    realms: REALMS,
    state: { ...EMPTY_WORKSPACE_STATE, tabs },
    plan: { live: [], resting: {} },
    runtime: () => ({ frameId: null, loaded: false, canGoBack: false, canGoForward: false, agentState: null, reloads: 0 }),
    switchingRealm: null,
    dispatch: vi.fn(),
  } as unknown as WorkspaceController;
  return {
    surface: 'page',
    workspace,
    settings: DEFAULT_SETTINGS,
    patchSettings: vi.fn(async () => undefined),
    view: 'threads',
    setView: vi.fn(),
    detailMode: 'summary',
    setDetailMode: vi.fn(),
    conversations: [],
    conversationByKey: new Map(),
    insightsByThread: new Map(),
    summariesByThread: new Map(),
    selectedThreadKey: null,
    accountOfThread,
    openSession: vi.fn(),
    togglePinned: vi.fn(async () => undefined),
    openInChromeTab: vi.fn(),
    requestAddAccount: vi.fn(),
    openSettings: vi.fn(),
    announce: vi.fn(),
    ...rest,
  };
}

// ---------------------------------------------------------------------------------------------
// Rendering helpers
// ---------------------------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  resetThreadGrouping();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetThreadGrouping();
  vi.unstubAllGlobals();
});

async function render(el: React.ReactElement) {
  await act(async () => root.render(el));
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

async function click(el: Element | null | undefined) {
  if (!el) throw new Error('element not found');
  await act(async () => {
    (el as HTMLElement).click();
  });
}

async function choose(select: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')!.set!.call(select, value);
    select.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

const q = <T extends Element = HTMLElement>(sel: string) => container.querySelector<T>(sel);
const qa = <T extends Element = HTMLElement>(sel: string) => [...container.querySelectorAll<T>(sel)];
const byText = (sel: string, text: string | RegExp) =>
  qa(sel).find((n) => (typeof text === 'string' ? n.textContent?.trim() === text : text.test(n.textContent ?? '')));

// ---------------------------------------------------------------------------------------------
// The list: a harness that wires the search hook to the list the way the app does
// ---------------------------------------------------------------------------------------------

interface HarnessProps {
  conversations: ConversationRecord[];
  settings?: SettingsRecord;
  repositoryFilter?: string | null;
  accountFilter?: string | null;
  runFilter?: RunFilter;
  typeFilter?: SessionKind | 'all';
  sortMode?: ThreadSortMode;
  onResult?: (result: ReturnType<typeof useThreadSearch>) => void;
  listOverrides?: Partial<ListPaneProps>;
}

function Harness({ conversations, settings = DEFAULT_SETTINGS, repositoryFilter, accountFilter, runFilter, typeFilter = 'all', sortMode = 'recent', onResult, listOverrides }: HarnessProps) {
  const searchIndex = React.useMemo(() => {
    const index = new MemorySearchIndex();
    index.loadSnapshot({ conversations });
    return index;
  }, [conversations]);
  const insightsByThread = React.useMemo(() => new Map<string, ThreadInsight>(), []);
  const result = useThreadSearch({
    settings,
    conversations,
    searchIndex,
    summariesByThread: new Map(),
    messagesByThread: new Map(),
    insightsByThread,
    vectorsByThread: new Map(),
    vectorRows: [],
    searchQuery: '',
    providerFilter: 'all',
    activeArea: 'All threads',
    stateFilter: 'all',
    coverageFilter: 'all',
    kindFilter: 'all',
    activeQueue: 'all',
    sortMode,
    repositoryFilter,
    accountFilter,
    runFilter,
    typeFilter,
    accountIdOf: (c) => accountOfThread(c).account?.id ?? null,
    accountOrder: REALMS.flatMap((r) => r.accounts.map((a) => a.id)),
  });
  onResult?.(result);
  const props: ListPaneProps = {
    repositoryFilter,
    accountFilter,
    runFilter,
    typeFilter,
    onTypeFilterChange: vi.fn(),
    onRepositoryFilterChange: vi.fn(),
    onAccountFilterChange: vi.fn(),
    onRunFilterChange: vi.fn(),
    settings,
    conversations,
    insightsByThread,
    summariesByThread: new Map(),
    messagesByThread: new Map(),
    vectorsByThread: new Map(),
    searchIndex,
    collectionByName: new Map(),
    projectNames: ['Hypestake'],
    providerOptions: [],
    listHits: result.listHits,
    kanbanColumns: result.kanbanColumns,
    cardGroups: result.cardGroups,
    viewKeys: result.viewKeys,
    queueItemsMap: null,
    selectedThreadKey: null,
    activeTabConversation: null,
    listMode: 'search',
    searchQuery: '',
    rerankNote: null,
    providerFilter: 'all',
    kindFilter: 'all',
    stateFilter: 'all',
    coverageFilter: 'all',
    sortMode,
    checkedKeys: new Set(),
    isCompact: false,
    stillPaired: false,
    searchInputRef: { current: null },
    selectAllRef: { current: null },
    bulkDeleteDialogRef: { current: null },
    onListModeChange: vi.fn(),
    onSearchChange: vi.fn(),
    onSearchSubmit: vi.fn(),
    onProviderFilterChange: vi.fn(),
    onKindFilterChange: vi.fn(),
    onStateFilterChange: vi.fn(),
    onCoverageFilterChange: vi.fn(),
    onSortModeChange: vi.fn(),
    onPatchSettings: vi.fn(async () => undefined),
    onSelectThread: vi.fn(),
    onToggleChecked: vi.fn(),
    onSelectionChange: vi.fn(),
    onBulkChanged: vi.fn(async () => undefined),
    onBulkDialogClosed: vi.fn(),
    onAnnounce: vi.fn(),
    onSendToStill: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenImport: vi.fn(),
    canEdit: () => true,
    registerRow: vi.fn(),
    ...listOverrides,
  };
  return <ListPane {...props} />;
}

const GROUPED: SettingsRecord = { ...DEFAULT_SETTINGS, threadsGroupBy: 'repository' };

/** Two coding providers and two accounts on one repository, one more repository, one chat. */
function library() {
  return {
    claudeWork: conv({ provider: 'claude_code', accountId: 'stored_work', repository: 'acme/app', title: 'Retry webhooks', agentState: 'waiting_permission', agentStateAt: '2026-11-09T09:00:00.000Z' }),
    codexOpenai: conv({ provider: 'codex', accountId: 'stored_openai', repository: 'acme/app', title: 'Queue line moves', agentState: 'running' }),
    claudePersonal: conv({ provider: 'claude_code', accountId: 'stored_personal', repository: 'acme/web', title: 'Landing page', agentState: 'turn_complete' }),
    // A terminal session that only knows its folder name: it folds into the one owner/name that ends with it.
    cli: conv({ provider: 'claude_code', accountId: 'stored_work', workspacePath: '/Users/sam/code/app', title: 'Spike from the terminal' }),
    chat: conv({ provider: 'chatgpt', accountId: 'stored_openai', title: 'Release notes' }),
  };
}

function headers() {
  return qa('.tk-thr-group-head');
}

function headerName(el: Element): string {
  return el.querySelector('.tk-thr-group-name')?.textContent ?? '';
}

describe('Threads list: grouping', () => {
  it('puts sessions of two providers and two accounts on one repository under one header', async () => {
    const l = library();
    const conversations = [l.claudeWork, l.codexOpenai, l.claudePersonal, l.cli, l.chat];
    let result!: ReturnType<typeof useThreadSearch>;
    await render(
      <WorkspaceProvider value={makeContext({ settings: GROUPED })}>
        <Harness conversations={conversations} settings={GROUPED} onResult={(r) => (result = r)} />
      </WorkspaceProvider>
    );
    const names = headers().map(headerName);
    // The terminal session folded into acme/app, so that group has three sessions; "No repository" is last.
    expect(names).toEqual(['acme/app', 'acme/web', 'No repository']);
    expect(headers().map((h) => h.querySelector('.tk-thr-group-count')?.textContent)).toEqual(['3', '1', '1']);
    expect(headers().every((h) => h.getAttribute('aria-expanded') === 'true')).toBe(true);
    // The repository is set in the mono font, the "No repository" label is not.
    expect(headers()[0].querySelector('.tk-thr-mono')?.textContent).toBe('acme/app');
    expect(headers()[2].querySelector('.tk-thr-mono')).toBeNull();
    // Rows keep their list structure inside each group.
    const firstGroup = q('.tk-thr-group')!;
    expect(firstGroup.querySelectorAll('ul.tk-row-list > li.tk-row-item .tk-row-btn')).toHaveLength(3);
    // The view order is the order the rows are drawn in.
    const drawn = qa('.tk-row-item .tk-row-title').map((n) => n.textContent);
    expect(result.viewKeys).toHaveLength(5);
    const titleOf = new Map(conversations.map((c) => [c.threadKey, c.title]));
    expect(result.viewKeys.map((k) => titleOf.get(k))).toEqual(drawn);
    expect(result.listHits.map((h) => h.conversation.threadKey)).toEqual(result.viewKeys);
  });

  it('shows the account and run state of a row on the full page only', async () => {
    const l = library();
    const conversations = [l.claudePersonal, l.codexOpenai];
    await render(
      <WorkspaceProvider value={makeContext({ settings: GROUPED })}>
        <Harness conversations={conversations} />
      </WorkspaceProvider>
    );
    const personalRow = byText('.tk-row-item', /Landing page/)!;
    // Personal is not the account signed in to its realm, so the chip is shown (with a word for it).
    expect(personalRow.querySelector('.tk-acct')?.textContent).toContain('Personal');
    expect(personalRow.querySelector('.tk-acct')?.textContent).toContain('not signed in');
    expect(personalRow.querySelector('.tk-run')?.textContent).toBe('Finished');
    expect(personalRow.textContent).toContain('acme/web');
    // OpenAI has one account and it is the signed-in one: no chip, but the run state is there.
    const codexRow = byText('.tk-row-item', /Queue line moves/)!;
    expect(codexRow.querySelector('.tk-acct')).toBeNull();
    expect(codexRow.querySelector('.tk-run')?.textContent).toBe('Running');
  });

  it('removes the rows and the keys of a collapsed group from the view order', async () => {
    const l = library();
    const conversations = [l.claudeWork, l.codexOpenai, l.claudePersonal, l.cli, l.chat];
    let result!: ReturnType<typeof useThreadSearch>;
    const onAnnounce = vi.fn();
    await render(
      <WorkspaceProvider value={makeContext({ settings: GROUPED })}>
        <Harness conversations={conversations} settings={GROUPED} onResult={(r) => (result = r)} listOverrides={{ onAnnounce }} />
      </WorkspaceProvider>
    );
    expect(result.viewKeys).toHaveLength(5);
    await click(headers()[0]);
    expect(headers()[0].getAttribute('aria-expanded')).toBe('false');
    expect(qa('.tk-row-item')).toHaveLength(2);
    expect(result.viewKeys).toEqual([l.claudePersonal.threadKey, l.chat.threadKey]);
    expect(result.viewKeys).not.toContain(l.claudeWork.threadKey);
    // The count stays on the header and the change is announced.
    expect(headers()[0].querySelector('.tk-thr-group-count')?.textContent).toBe('3');
    expect(onAnnounce).toHaveBeenCalledWith(expect.stringContaining('acme/app collapsed'));
    // Expanding brings them back.
    await click(headers()[0]);
    expect(result.viewKeys).toHaveLength(5);
    expect(qa('.tk-row-item')).toHaveLength(5);
  });

  it('groups by account with "<Sign-in> · <Account>" and by project, and binds the switch to the setting', async () => {
    const l = library();
    const conversations = [l.claudeWork, l.codexOpenai, l.claudePersonal];
    const onPatchSettings = vi.fn(async () => undefined);
    const byAccount: SettingsRecord = { ...DEFAULT_SETTINGS, threadsGroupBy: 'account' };
    await render(
      <WorkspaceProvider value={makeContext({ settings: byAccount })}>
        <Harness conversations={conversations} settings={byAccount} listOverrides={{ onPatchSettings }} />
      </WorkspaceProvider>
    );
    expect(headers().map(headerName).sort()).toEqual(['ChatGPT · Work', 'Claude · Personal', 'Claude · Work'].sort());
    const group = q<HTMLSelectElement>('select[aria-label="Group by"]')!;
    expect(group.value).toBe('account');
    // Two providers and several accounts are in play, so Provider and Account are offered, in the
    // Threads order. Type is left out: every thread here is a coding session, one bucket only.
    expect([...group.options].map((o) => o.textContent)).toEqual([
      'None', 'Project', 'Repository', 'Account', 'Provider', 'Last active', 'Status',
    ]);
    await choose(group, 'repository');
    expect(onPatchSettings).toHaveBeenCalledWith({ threadsGroupBy: 'repository' });
  });

  it('does not group, or add the workspace toolbar, on the side panel', async () => {
    const l = library();
    await render(
      <WorkspaceProvider value={makeContext({ surface: 'sidepanel', settings: GROUPED })}>
        <Harness conversations={[l.claudeWork, l.codexOpenai]} settings={GROUPED} />
      </WorkspaceProvider>
    );
    expect(headers()).toHaveLength(0);
    expect(q('.tk-thr-toolbar')).toBeNull();
    expect(qa('.tk-row-item')).toHaveLength(2);
    expect(q('.tk-row-item .tk-run')).toBeNull();
  });
});

describe('Threads list: workspace filters', () => {
  it('keeps active filters collapsible and shows their count beside the always available controls', async () => {
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness
          conversations={[]}
          runFilter="needs_you"
          accountFilter={PERSONAL.id}
          listOverrides={{ providerFilter: 'claude_code', kindFilter: 'coding' }}
        />
      </WorkspaceProvider>
    );
    const toggle = q<HTMLButtonElement>('.tk-thr-filters-toggle')!;
    const bar = q('.tk-search-bar')!;
    expect(toggle.textContent).toBe('Filters · 4');
    expect(toggle.disabled).toBe(false);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(bar.getAttribute('data-filters-open')).toBe('false');
    expect(q('input[type="search"]')).not.toBeNull();
    expect(q('select[aria-label="Group by"]')).not.toBeNull();
    expect(q('select[aria-label="View mode"]')).not.toBeNull();
    expect(q('select[aria-label="Sort threads"]')).not.toBeNull();
    expect([...q('.tk-filter-row')!.children].slice(0, 3).map((el) => el.getAttribute('aria-label') ?? el.textContent)).toEqual([
      'View mode', 'Sort threads', 'Filters · 4',
    ]);
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(bar.getAttribute('data-filters-open')).toBe('true');
    await click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(bar.getAttribute('data-filters-open')).toBe('false');
    expect(toggle.textContent).toBe('Filters · 4');
  });

  async function hitsFor(filters: Pick<HarnessProps, 'repositoryFilter' | 'accountFilter' | 'runFilter'>, conversations: ConversationRecord[]) {
    let result!: ReturnType<typeof useThreadSearch>;
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness conversations={conversations} onResult={(r) => (result = r)} {...filters} />
      </WorkspaceProvider>
    );
    return result.listHits.map((h) => h.conversation.title).sort();
  }

  it('narrows by repository, folding a bare name into its owner/name group', async () => {
    const l = library();
    const all = [l.claudeWork, l.codexOpenai, l.claudePersonal, l.cli, l.chat];
    expect(await hitsFor({ repositoryFilter: 'acme/app' }, all)).toEqual(['Queue line moves', 'Retry webhooks', 'Spike from the terminal']);
    expect(await hitsFor({ repositoryFilter: 'acme/web' }, all)).toEqual(['Landing page']);
    // A bare name matches the owner/name group that ends with it.
    expect(await hitsFor({ repositoryFilter: 'app' }, all)).toEqual(['Queue line moves', 'Retry webhooks', 'Spike from the terminal']);
    expect(await hitsFor({ repositoryFilter: null }, all)).toHaveLength(5);
  });

  it('narrows by account', async () => {
    const l = library();
    const all = [l.claudeWork, l.codexOpenai, l.claudePersonal, l.cli, l.chat];
    expect(await hitsFor({ accountFilter: PERSONAL.id }, all)).toEqual(['Landing page']);
    expect(await hitsFor({ accountFilter: WORK.id }, all)).toEqual(['Retry webhooks', 'Spike from the terminal']);
    expect(await hitsFor({ accountFilter: OPENAI_WORK.id }, all)).toEqual(['Queue line moves', 'Release notes']);
  });

  it('narrows by what the run last showed', async () => {
    const l = library();
    const all = [l.claudeWork, l.codexOpenai, l.claudePersonal, l.cli, l.chat];
    expect(await hitsFor({ runFilter: 'needs_you' }, all)).toEqual(['Retry webhooks']);
    expect(await hitsFor({ runFilter: 'running' }, all)).toEqual(['Queue line moves']);
    expect(await hitsFor({ runFilter: 'finished' }, all)).toEqual(['Landing page']);
    expect(matchesRunFilter('failed', 'needs_you')).toBe(true);
    expect(matchesRunFilter(null, 'running')).toBe(false);
  });

  it('offers the filters in the toolbar and shows a removable repository chip', async () => {
    const l = library();
    const onRunFilterChange = vi.fn();
    const onAccountFilterChange = vi.fn();
    const onRepositoryFilterChange = vi.fn();
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness
          conversations={[l.claudeWork, l.claudePersonal]}
          repositoryFilter="acme/app"
          listOverrides={{ onRunFilterChange, onAccountFilterChange, onRepositoryFilterChange }}
        />
      </WorkspaceProvider>
    );
    const run = q<HTMLSelectElement>('select[aria-label="Filter by run state"]')!;
    expect([...run.options].map((o) => o.textContent)).toEqual(['Any run state', 'Needs you', 'Running', 'Finished']);
    await choose(run, 'needs_you');
    expect(onRunFilterChange).toHaveBeenCalledWith('needs_you');
    // One realm has two accounts, so the account select is there, grouped by sign-in.
    const acct = q<HTMLSelectElement>('select[aria-label="Filter by account"]')!;
    expect([...acct.querySelectorAll('optgroup')].map((g) => g.label)).toEqual(['Claude', 'ChatGPT']);
    await choose(acct, PERSONAL.id);
    expect(onAccountFilterChange).toHaveBeenCalledWith(PERSONAL.id);
    const chip = q('.tk-thr-filter-chip')!;
    expect(chip.textContent).toContain('acme/app');
    await click(chip.querySelector('button'));
    expect(onRepositoryFilterChange).toHaveBeenCalledWith(null);
  });
});

describe('Threads list: the lens (type filter, more groupings, order)', () => {
  /** A coding session on two accounts, a Codex session in review, a finished chat and a bot. */
  function mixed() {
    return {
      claude: conv({ provider: 'claude_code', accountId: 'stored_work', repository: 'acme/app', title: 'Retry webhooks', createdAt: '2026-10-01T10:00:00', updatedAt: '2026-11-10T09:00:00' }),
      codex: conv({ provider: 'codex', accountId: 'stored_openai', repository: 'acme/app', title: 'Queue line moves', workflowState: 'needs_review', createdAt: '2026-11-08T10:00:00', updatedAt: '2026-11-09T09:00:00' }),
      chat: conv({ provider: 'chatgpt', accountId: 'stored_openai', title: 'Release notes', workflowState: 'done', createdAt: '2026-11-05T10:00:00', updatedAt: '2026-11-03T09:00:00' }),
      bot: conv({ provider: 'grok_bot', accountId: 'stored_openai', title: 'Nightly digest', createdAt: '2026-11-09T10:00:00', updatedAt: '2026-11-01T09:00:00' }),
    };
  }
  const all = () => Object.values(mixed());

  async function hitTitles(props: Partial<HarnessProps>, conversations: ConversationRecord[] = all()) {
    let result!: ReturnType<typeof useThreadSearch>;
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness conversations={conversations} onResult={(r) => (result = r)} {...props} />
      </WorkspaceProvider>
    );
    return result.listHits.map((h) => h.conversation.title);
  }

  it('narrows by type', async () => {
    expect((await hitTitles({ typeFilter: 'coding' })).sort()).toEqual(['Queue line moves', 'Retry webhooks']);
    expect(await hitTitles({ typeFilter: 'chats' })).toEqual(['Release notes']);
    expect(await hitTitles({ typeFilter: 'bots' })).toEqual(['Nightly digest']);
    expect(await hitTitles({ typeFilter: 'more' })).toEqual([]);
    expect(await hitTitles({ typeFilter: 'all' })).toHaveLength(4);
    // Together with the other filters (AND).
    expect(await hitTitles({ typeFilter: 'coding', accountFilter: OPENAI_WORK.id })).toEqual(['Queue line moves']);
  });

  it('offers a Type filter beside the provider filter, and it counts toward "Filters"', async () => {
    const onTypeFilterChange = vi.fn();
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness conversations={all()} typeFilter="chats" listOverrides={{ onTypeFilterChange }} />
      </WorkspaceProvider>
    );
    const select = q<HTMLSelectElement>('select[aria-label="Filter by type"]')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(['All types', 'Coding sessions', 'Chats', 'Bots', 'Other']);
    expect(select.value).toBe('chats');
    const row = [...q('.tk-filter-row')!.children].map((el) => el.getAttribute('aria-label') ?? el.textContent);
    expect(row.indexOf('Filter by type')).toBe(row.indexOf('Filter by provider') + 1);
    expect(q('.tk-thr-filters-toggle')!.textContent).toBe('Filters · 1');
    await choose(select, 'coding');
    expect(onTypeFilterChange).toHaveBeenCalledWith('coding');
  });

  it('shows a removable chip for each active workspace filter, with one action to clear them all', async () => {
    const l = mixed();
    const handlers = {
      onTypeFilterChange: vi.fn(),
      onProviderFilterChange: vi.fn(),
      onAccountFilterChange: vi.fn(),
      onRepositoryFilterChange: vi.fn(),
      onRunFilterChange: vi.fn(),
    };
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness
          conversations={[l.claude]}
          typeFilter="coding"
          accountFilter={PERSONAL.id}
          repositoryFilter="acme/app"
          runFilter="needs_you"
          listOverrides={{ providerFilter: 'claude_code', ...handlers }}
        />
      </WorkspaceProvider>
    );
    const chips = qa('.tk-thr-chips .tk-thr-filter-chip');
    expect(q('.tk-thr-chips')!.getAttribute('aria-label')).toBe('Active filters');
    expect(chips.map((c) => c.firstElementChild!.textContent)).toEqual([
      'Type: Coding sessions',
      'Provider: Claude Code',
      'Account: Claude · Personal',
      'Repository: acme/app',
      'Run state: Needs you',
    ]);
    expect(chips.map((c) => c.querySelector('button')!.getAttribute('aria-label'))).toEqual([
      'Remove type filter Coding sessions',
      'Remove provider filter Claude Code',
      'Remove account filter Claude · Personal',
      'Remove repository filter acme/app',
      'Remove run state filter Needs you',
    ]);
    await click(chips[0].querySelector('button'));
    expect(handlers.onTypeFilterChange).toHaveBeenLastCalledWith('all');
    await click(chips[1].querySelector('button'));
    expect(handlers.onProviderFilterChange).toHaveBeenLastCalledWith('all');
    await click(chips[2].querySelector('button'));
    expect(handlers.onAccountFilterChange).toHaveBeenLastCalledWith(null);
    await click(chips[4].querySelector('button'));
    expect(handlers.onRunFilterChange).toHaveBeenLastCalledWith('all');
    // One action clears every one of them.
    for (const fn of Object.values(handlers)) fn.mockClear();
    await click(byText('.tk-thr-chips button', 'Clear filters'));
    expect(handlers.onTypeFilterChange).toHaveBeenCalledWith('all');
    expect(handlers.onProviderFilterChange).toHaveBeenCalledWith('all');
    expect(handlers.onAccountFilterChange).toHaveBeenCalledWith(null);
    expect(handlers.onRepositoryFilterChange).toHaveBeenCalledWith(null);
    expect(handlers.onRunFilterChange).toHaveBeenCalledWith('all');
  });

  it('shows no chips without an active filter, nor on the side panel', async () => {
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness conversations={all()} />
      </WorkspaceProvider>
    );
    expect(q('.tk-thr-chips')).toBeNull();
    act(() => root.unmount());
    root = createRoot(container);
    await render(
      <WorkspaceProvider value={makeContext({ surface: 'sidepanel' })}>
        <Harness conversations={all()} typeFilter="chats" />
      </WorkspaceProvider>
    );
    expect(q('.tk-thr-chips')).toBeNull();
    expect(q('select[aria-label="Filter by type"]')).toBeNull();
  });

  it('the empty-state button clears the type filter too', async () => {
    const l = mixed();
    const onTypeFilterChange = vi.fn();
    const onRepositoryFilterChange = vi.fn();
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness conversations={[l.claude]} typeFilter="bots" listOverrides={{ onTypeFilterChange, onRepositoryFilterChange }} />
      </WorkspaceProvider>
    );
    expect(qa('.tk-row-item')).toHaveLength(0);
    const clear = byText('.tk-empty-state button', /Clear type, repository, account and run filters/)!;
    await click(clear);
    expect(onTypeFilterChange).toHaveBeenCalledWith('all');
    expect(onRepositoryFilterChange).toHaveBeenCalledWith(null);
  });

  it('offers every grouping when the library has several types, providers and accounts, in the Threads order', async () => {
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness conversations={all()} />
      </WorkspaceProvider>
    );
    const select = q<HTMLSelectElement>('select[aria-label="Group by"]')!;
    expect([...select.options].map((o) => o.textContent)).toEqual(['None', 'Project', 'Repository', 'Account', 'Type', 'Provider', 'Last active', 'Status']);
    expect(select.value).toBe('none');
  });

  it('groups by type: coding sessions, chats, bots, then other', async () => {
    const settings: SettingsRecord = { ...DEFAULT_SETTINGS, threadsGroupBy: 'kind' };
    let result!: ReturnType<typeof useThreadSearch>;
    const library = all().reverse();
    await render(
      <WorkspaceProvider value={makeContext({ settings })}>
        <Harness conversations={library} settings={settings} onResult={(r) => (result = r)} />
      </WorkspaceProvider>
    );
    expect(headers().map(headerName)).toEqual(['Coding sessions', 'Chats', 'Bots']);
    expect(headers().map((h) => h.querySelector('.tk-thr-group-count')?.textContent)).toEqual(['2', '1', '1']);
    expect(headers().map((h) => h.closest('.tk-thr-group')!.getAttribute('data-group'))).toEqual(['kind:coding', 'kind:chats', 'kind:bots']);
    // The order the rows are drawn in is the order the keys are in.
    const drawn = qa('.tk-row-item .tk-row-title').map((n) => n.textContent);
    const titleOf = new Map(library.map((c) => [c.threadKey, c.title]));
    expect(result.viewKeys.map((k) => titleOf.get(k))).toEqual(drawn);
  });

  it('groups by provider, biggest first and then by name', async () => {
    const l = mixed();
    const extra = conv({ provider: 'claude_code', accountId: 'stored_personal', title: 'Landing page' });
    const settings: SettingsRecord = { ...DEFAULT_SETTINGS, threadsGroupBy: 'provider' };
    await render(
      <WorkspaceProvider value={makeContext({ settings })}>
        <Harness conversations={[l.chat, l.codex, l.claude, extra, l.bot]} settings={settings} />
      </WorkspaceProvider>
    );
    expect(headers().map(headerName)).toEqual(['Claude Code', 'ChatGPT', 'Codex', 'Grok Bot']);
  });

  it('groups by status in the workflow order', async () => {
    const settings: SettingsRecord = { ...DEFAULT_SETTINGS, threadsGroupBy: 'status' };
    await render(
      <WorkspaceProvider value={makeContext({ settings })}>
        <Harness conversations={all()} settings={settings} />
      </WorkspaceProvider>
    );
    expect(headers().map(headerName)).toEqual(['Active', 'Needs review', 'Done']);
    expect(headers().map((h) => h.querySelector('.tk-thr-group-count')?.textContent)).toEqual(['2', '1', '1']);
  });

  it('groups by when it was last active, by local calendar day', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date(2026, 10, 10, 15, 0, 0));
    try {
      const settings: SettingsRecord = { ...DEFAULT_SETTINGS, threadsGroupBy: 'date' };
      await render(
        <WorkspaceProvider value={makeContext({ settings })}>
          <Harness conversations={all()} settings={settings} />
        </WorkspaceProvider>
      );
      // Claude today (10 Nov), Codex yesterday (9 Nov), the chat 7 days back, the bot 9 days back.
      expect(headers().map(headerName)).toEqual(['Today', 'Yesterday', 'Previous 7 days', 'Previous 30 days']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('groups by account in sign-in order, not the order the threads came in', async () => {
    const l = mixed();
    const personal = conv({ provider: 'claude_code', accountId: 'stored_personal', title: 'Landing page' });
    const settings: SettingsRecord = { ...DEFAULT_SETTINGS, threadsGroupBy: 'account' };
    await render(
      <WorkspaceProvider value={makeContext({ settings })}>
        <Harness conversations={[l.codex, personal, l.claude]} settings={settings} />
      </WorkspaceProvider>
    );
    expect(headers().map(headerName)).toEqual(['Claude · Work', 'Claude · Personal', 'ChatGPT · Work']);
  });

  it('keeps a group header sticky while its group is open', () => {
    const css = readFileSync(join(__dirname, '../../src/entrypoints/manager/styles/30-threads.css'), 'utf8');
    expect(css).toMatch(/\.tk-thr-group-head\[aria-expanded="true"\]\s*\{[^}]*position:\s*sticky[^}]*top:\s*0/);
    expect(css).not.toMatch(/\.tk-thr-group-head\s*\{[^}]*position:\s*sticky/);
  });

  it('adds "Recently created" to the order and orders the list by creation time', async () => {
    const onSortModeChange = vi.fn();
    expect(await hitTitles({ sortMode: 'created' })).toEqual(['Nightly digest', 'Queue line moves', 'Release notes', 'Retry webhooks']);
    const sort = q<HTMLSelectElement>('select[aria-label="Sort threads"]')!;
    expect([...sort.options].map((o) => o.textContent)).toEqual(['Recent activity', 'Oldest first', 'Recently created', 'Title A–Z', 'Most messages']);
    expect(sort.value).toBe('created');
    act(() => root.unmount());
    root = createRoot(container);
    await render(
      <WorkspaceProvider value={makeContext()}>
        <Harness conversations={all()} listOverrides={{ onSortModeChange }} />
      </WorkspaceProvider>
    );
    await choose(q<HTMLSelectElement>('select[aria-label="Sort threads"]')!, 'created');
    expect(onSortModeChange).toHaveBeenCalledWith('created');
  });
});

// ---------------------------------------------------------------------------------------------
// The rail
// ---------------------------------------------------------------------------------------------

describe('Threads rail: repositories', () => {
  const railProps = (over: Partial<NavRailProps>): NavRailProps => ({
    collapsed: false,
    drawerOpen: false,
    activeArea: 'All threads',
    activeQueue: 'all',
    counts: null,
    projectNames: [],
    collectionByName: new Map(),
    conversations: [],
    summariesByThread: new Map(),
    newProjectDraft: null,
    onNewProjectDraftChange: vi.fn(),
    onCreateProject: vi.fn(),
    onAreaSelect: vi.fn(),
    onQueueSelect: vi.fn(),
    ...over,
  });

  it('lists each repository of the open coding sessions with counts, and a second click clears the filter', async () => {
    const l = library();
    const archived = conv({ provider: 'claude_code', accountId: 'stored_work', repository: 'acme/old', workflowState: 'archived' });
    const onRepositorySelect = vi.fn();
    const conversations = [l.claudeWork, l.codexOpenai, l.claudePersonal, l.cli, l.chat, archived];
    await render(<NavRail {...railProps({ conversations, onRepositorySelect, repositoryFilter: 'acme/web' })} />);
    const section = q('.tk-thr-nav-repos')!;
    expect(section.querySelector('.tk-eyebrow')?.textContent).toBe('Repositories');
    const items = [...section.querySelectorAll('button')];
    expect(items.map((b) => b.textContent)).toEqual(['acme/app3', 'acme/web1']);
    expect(items.map((b) => b.getAttribute('aria-current'))).toEqual(['false', 'true']);
    await click(items[0]);
    expect(onRepositorySelect).toHaveBeenLastCalledWith('acme/app');
    await click(items[1]);
    expect(onRepositorySelect).toHaveBeenLastCalledWith(null);
  });

  it('adds nothing without the repository handler', async () => {
    await render(<NavRail {...railProps({ conversations: Object.values(library()) })} />);
    expect(q('.tk-thr-nav-repos')).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// The detail pane
// ---------------------------------------------------------------------------------------------

function detailProps(conversation: ConversationRecord, over: Partial<DetailPaneProps> = {}): DetailPaneProps {
  const noop = vi.fn();
  return {
    conversation,
    insight: null,
    summary: null,
    messages: [],
    relationships: [],
    semanticNeighbors: [],
    conversations: [conversation],
    insightsByThread: new Map(),
    projectNames: ['Hypestake'],
    evidence: { activeEvidenceId: null, conversation, messages: [], onToggle: noop },
    aiReady: false,
    analyzing: false,
    cloudEnabled: false,
    stillPaired: false,
    stillLastPushAt: undefined,
    mayShare: () => true,
    mobileDetailVisible: true,
    titleDraft: '',
    tagInputDraft: '',
    notesDraft: '',
    showAllMessages: false,
    onTitleDraftChange: noop,
    onTagInputDraftChange: noop,
    onNotesDraftChange: noop,
    onShowAllMessages: noop,
    onBackToList: noop,
    onSelectThread: noop,
    onProjectChange: noop,
    onToggleLock: noop,
    onWorkflowStateChange: noop,
    onOpenOriginal: noop,
    onCopy: noop,
    onSendToStill: noop,
    onDelete: noop,
    onAnalyze: noop,
    onSetCloudExcluded: noop,
    onEnrich: noop,
    onSaveManualEdits: noop,
    ...over,
  };
}

const webSession = () =>
  conv({
    provider: 'chatgpt',
    accountId: 'stored_openai',
    canonicalUrl: 'https://chatgpt.com/c/abc',
    title: 'Release notes',
  });

const terminalSession = () =>
  conv({
    provider: 'claude_code',
    accountId: 'stored_work',
    canonicalUrl: '',
    resumeCommand: 'claude --resume abc',
    repository: 'acme/app',
    gitBranch: 'tk/webhook-retries',
    pullRequestUrl: 'https://github.com/acme/app/pull/482',
    agentState: 'waiting_permission',
    agentStateAt: '2026-11-09T09:00:00.000Z',
    title: 'Terminal session',
  });

describe('Detail pane: mode switch', () => {
  it('is absent on the side panel and adds nothing to its markup', async () => {
    const c = webSession();
    await render(
      <WorkspaceProvider value={makeContext({ surface: 'sidepanel' })}>
        <DetailPane {...detailProps(c)} />
      </WorkspaceProvider>
    );
    expect(q('[aria-label="Thread view"]')).toBeNull();
    expect(byText('button', 'Pin to dashboard')).toBeUndefined();
    expect(q('.tk-thr-modebar')).toBeNull();
    expect(q('.tk-detail-pane')?.hasAttribute('data-thr-mode')).toBe(false);
  });

  it('turns Live and Split off for a session with no web page, and says so', async () => {
    const c = terminalSession();
    const setDetailMode = vi.fn();
    await render(
      <WorkspaceProvider value={makeContext({ detailMode: 'live', setDetailMode })}>
        <DetailPane {...detailProps(c)} />
      </WorkspaceProvider>
    );
    const radios = qa<HTMLButtonElement>('[aria-label="Thread view"] [role="radio"]');
    expect(radios.map((r) => [r.textContent, r.disabled])).toEqual([
      ['Summary', false],
      ['Live', true],
      ['Split', true],
    ]);
    // A remembered Live mode does not hide the summary of a session that has no page.
    expect(radios[0].getAttribute('aria-checked')).toBe('true');
    expect(q('.tk-thr-live')).toBeNull();
    expect(q('.tk-thr-nopage')?.textContent).toContain('no web page');
    expect(q('.tk-thr-nopage')?.textContent).toContain('resume command');
    // The existing "Copy resume command" buttons are the ones offered; the note adds none.
    expect(q('.tk-thr-nopage button')).toBeNull();
    expect(qa('.tk-detail-header button').filter((b) => b.textContent === 'Copy resume command')).toHaveLength(1);
    expect(byText('button', 'Open in Browse')).toBeUndefined();
  });

  it('switches modes on the full page and announces the change', async () => {
    const c = webSession();
    const setDetailMode = vi.fn();
    const announce = vi.fn();
    await render(
      <WorkspaceProvider value={makeContext({ setDetailMode, announce })}>
        <DetailPane {...detailProps(c)} />
      </WorkspaceProvider>
    );
    const radios = qa<HTMLButtonElement>('[aria-label="Thread view"] [role="radio"]');
    expect(radios.every((r) => !r.disabled)).toBe(true);
    await click(radios[1]);
    expect(setDetailMode).toHaveBeenCalledWith('live');
    expect(announce).toHaveBeenCalledWith('Showing the live page.');
    await click(radios[2]);
    expect(setDetailMode).toHaveBeenLastCalledWith('split');
  });

  it('Live replaces the body with a slot for the thread tab, and Split keeps the summary beside it', async () => {
    const c = webSession();
    const withTab = makeContext({ detailMode: 'live', tabs: [tab(c.threadKey)] });
    await render(
      <WorkspaceProvider value={withTab}>
        <DetailPane {...detailProps(c)} />
      </WorkspaceProvider>
    );
    const slot = q('.tk-frame-slot.tk-thr-live')!;
    expect(slot.getAttribute('data-tab')).toBe(threadTabId(c.threadKey));
    // The resting page is inside it (here: the workspace is not ready yet); the summary sections are gone.
    expect(slot.textContent).toContain('Starting the workspace');
    expect(q('.tk-overview')).toBeNull();
    expect(q('.tk-detail-pane')?.getAttribute('data-thr-mode')).toBe('live');
    // The header stays.
    expect(q('.tk-detail-title')?.textContent).toBe('Release notes');

    await render(
      <WorkspaceProvider value={makeContext({ detailMode: 'split', tabs: [tab(c.threadKey)] })}>
        <DetailPane {...detailProps(c)} />
      </WorkspaceProvider>
    );
    expect(q('.tk-thr-body')?.getAttribute('data-mode')).toBe('split');
    expect(q('.tk-thr-summary .tk-overview')).not.toBeNull();
    expect(q('.tk-thr-livewrap .tk-thr-live')).not.toBeNull();
  });

  it('shows a quiet loading line until the thread tab exists', async () => {
    const c = webSession();
    await render(
      <WorkspaceProvider value={makeContext({ detailMode: 'live' })}>
        <DetailPane {...detailProps(c)} />
      </WorkspaceProvider>
    );
    const slot = q('.tk-thr-live')!;
    expect(slot.getAttribute('data-tab')).toBe(threadTabId(c.threadKey));
    expect(slot.textContent).toContain('Opening the live page');
  });
});

describe('Detail pane: facts and actions', () => {
  it('shows account, repository, branch, pull request and the observed run state', async () => {
    const c = terminalSession();
    await render(
      <WorkspaceProvider value={makeContext()}>
        <DetailPane {...detailProps(c)} />
      </WorkspaceProvider>
    );
    const strip = q('.tk-detail-meta-strip')!;
    expect(strip.querySelector('.tk-acct')?.textContent).toContain('Work');
    expect(strip.textContent).toContain('acme/app');
    expect(strip.textContent).toContain('tk/webhook-retries');
    const pr = strip.querySelector<HTMLAnchorElement>('a')!;
    expect(pr.textContent).toBe('Pull request #482');
    expect(pr.getAttribute('href')).toBe('https://github.com/acme/app/pull/482');
    expect(pr.getAttribute('target')).toBe('_blank');
    expect(pr.getAttribute('rel')).toBe('noreferrer');
    expect(strip.querySelector('.tk-run')?.textContent).toBe('Needs approval');
    expect(strip.textContent).toContain('last read');
  });

  it('pins and unpins, and opens a web session in Browse', async () => {
    const c = webSession();
    const togglePinned = vi.fn(async () => undefined);
    const openSession = vi.fn();
    await render(
      <WorkspaceProvider value={makeContext({ togglePinned, openSession })}>
        <DetailPane {...detailProps(c)} />
      </WorkspaceProvider>
    );
    const pin = byText('button', 'Pin to dashboard') as HTMLButtonElement;
    expect(pin.getAttribute('aria-pressed')).toBe('false');
    await click(pin);
    expect(togglePinned).toHaveBeenCalledWith(c);
    await click(byText('button', 'Open in Browse'));
    expect(openSession).toHaveBeenCalledWith(c, 'browse');

    const pinned = { ...c, pinned: true };
    await render(
      <WorkspaceProvider value={makeContext({ togglePinned, openSession })}>
        <DetailPane {...detailProps(pinned)} />
      </WorkspaceProvider>
    );
    expect((byText('button', 'Unpin from dashboard') as HTMLButtonElement).getAttribute('aria-pressed')).toBe('true');
  });
});

// ---------------------------------------------------------------------------------------------
// Summary: agent run and related threads
// ---------------------------------------------------------------------------------------------

function insightFor(c: ConversationRecord, patch: Partial<ThreadInsight> = {}): ThreadInsight {
  return {
    insightKey: `ai|${c.threadKey}`,
    threadKey: c.threadKey,
    source: 'ai',
    model: 'claude-opus-5-5',
    sourceRevision: c.sourceRevision,
    contentHash: c.contentHash,
    generatedAt: '2026-11-09T10:00:00.000Z',
    title: c.title,
    gist: 'Make webhook handling safe to retry.',
    summary: 'Make webhook handling safe to retry.',
    userGoal: null,
    outcome: null,
    kind: 'coding' as ThreadInsight['kind'],
    topics: [],
    entities: [],
    languages: [],
    artifacts: [],
    lastUserAsk: null,
    suggestedStatus: null,
    statusReason: null,
    suggestedProject: null,
    userTurns: 3,
    hasCode: true,
    analysisVersion: 99,
    ...patch,
  };
}

const RUN: AgentRunFacts = {
  repository: 'acme/app',
  branch: 'tk/webhook-retries',
  pullRequests: [{ url: 'https://github.com/acme/app/pull/482', state: 'open' }],
  filesChanged: Array.from({ length: 18 }, (_, i) => `src/payments/file-${i + 1}.ts`),
  commandsRun: [
    { command: 'pnpm test payments', outcome: 'ok' },
    { command: 'pnpm lint', outcome: 'failed' },
    { command: 'pnpm build', outcome: 'unknown' },
  ],
  tests: { status: 'failing', detail: 'One test skipped.' },
  blockedOn: 'permission',
  runState: 'awaiting_user',
};

describe('Summary: agent run', () => {
  const overview = (c: ConversationRecord, insight: ThreadInsight | null, canAnalyze = true) => (
    <WorkspaceProvider value={makeContext()}>
      <ThreadOverview conv={c} insight={insight} canAnalyze={canAnalyze} analyzing={false} onAnalyze={() => {}} onCopy={() => {}} />
    </WorkspaceProvider>
  );

  it('shows the run facts under "What this thread is about"', async () => {
    const c = terminalSession();
    await render(overview(c, insightFor(c, { agentRun: RUN })));
    const block = q('.tk-thr-run')!;
    expect(block.querySelector('h4')?.textContent).toBe('Agent run');
    const text = block.textContent ?? '';
    expect(text).toContain('acme/app');
    expect(text).toContain('tk/webhook-retries');
    expect(block.querySelector<HTMLAnchorElement>('a')?.getAttribute('rel')).toBe('noreferrer');
    expect(text).toContain('Pull request #482');
    expect(text).toContain('(open)');
    // At most 15 files, one per line, in the mono font.
    expect(block.querySelectorAll('.tk-thr-files li')).toHaveLength(15);
    expect(text).toContain('and 3 more');
    expect([...block.querySelectorAll('.tk-thr-outcome')].map((o) => o.textContent)).toEqual(['ok', 'failed', 'unknown']);
    expect(text).toContain('Failing. One test skipped.');
    expect(text).toContain('Waiting on');
    expect(text).toContain('Your approval');
  });

  it('shows nothing for a thread without facts, and leaves out "Waiting on" when nothing blocks it', async () => {
    const chat = webSession();
    await render(overview(chat, insightFor(chat, { agentRun: null })));
    expect(q('.tk-thr-run')).toBeNull();
    const c = terminalSession();
    await render(overview(c, insightFor(c, { agentRun: { ...RUN, repository: null, branch: null, pullRequests: [], filesChanged: [], commandsRun: [], tests: { status: 'unknown', detail: null }, blockedOn: 'none' } })));
    expect(q('.tk-thr-run')).toBeNull();
    await render(overview(c, insightFor(c, { agentRun: { ...RUN, blockedOn: 'none' } })));
    expect(q('.tk-thr-run')).not.toBeNull();
    expect(q('.tk-thr-run')?.textContent).not.toContain('Waiting on');
  });

  it('does not appear on the side panel', async () => {
    const c = terminalSession();
    await render(
      <WorkspaceProvider value={makeContext({ surface: 'sidepanel' })}>
        <ThreadOverview conv={c} insight={insightFor(c, { agentRun: RUN })} canAnalyze analyzing={false} onAnalyze={() => {}} onCopy={() => {}} />
      </WorkspaceProvider>
    );
    expect(q('.tk-thr-run')).toBeNull();
  });

  it('explains that "Improve summary" adds the run details for a coding session analysed before them', async () => {
    const c = terminalSession();
    await render(overview(c, insightFor(c)));
    const improve = byText('button', 'Improve summary') as HTMLButtonElement;
    expect(improve).toBeDefined();
    const hint = document.getElementById(improve.getAttribute('aria-describedby')!)!;
    expect(hint.textContent).toContain('run details');
    // A chat has nothing to add.
    const chat = webSession();
    await render(overview(chat, insightFor(chat)));
    expect(byText('button', 'Improve summary')).toBeUndefined();
  });
});

describe('Summary: related threads', () => {
  it('says why a thread is related, and keeps the percentage for similar ones only', async () => {
    const make = (title: string, reason: RelatedThread['reason'], similarity: number): RelatedThread => ({
      conv: conv({ provider: 'claude_code', accountId: 'stored_work', title }),
      similarity,
      reason,
    });
    const related = [
      make('Other account', 'same_conversation', 0),
      make('Same PR', 'same_pull_request', 0),
      make('Same branch', 'same_branch', 0),
      make('Same repo', 'same_repository', 0),
      make('Close in meaning', 'similar', 0.82),
      make('No reason given', undefined, 0.7),
    ];
    await render(
      <WorkspaceProvider value={makeContext()}>
        <SemanticNeighbors related={related} insights={new Map()} onSelect={() => {}} />
      </WorkspaceProvider>
    );
    const rows = qa('.tk-related-item');
    expect(rows.map((r) => r.querySelector('.tk-thr-reason')?.textContent)).toEqual([
      'Same session, other account',
      'Same pull request',
      'Same branch',
      'Same repository',
      'Similar',
      'Similar',
    ]);
    const meta = (i: number) => rows[i].querySelector('.tk-related-meta')?.textContent ?? '';
    expect(meta(0)).not.toContain('%');
    expect(meta(3)).not.toContain('%');
    expect(meta(4)).toContain('82% similar');
    expect(meta(5)).toContain('70% similar');
    // The existing hooks stay.
    expect(rows[0].classList.contains('tk-related-item')).toBe(true);
    expect(rows[0].querySelector('.tk-related-title')?.textContent).toBe('Other account');
  });

  it('keeps the side panel as it was', async () => {
    const related: RelatedThread[] = [{ conv: conv({ provider: 'claude_code', accountId: 'stored_work', title: 'Close' }), similarity: 0.82 }];
    await render(
      <WorkspaceProvider value={makeContext({ surface: 'sidepanel' })}>
        <SemanticNeighbors related={related} insights={new Map()} onSelect={() => {}} />
      </WorkspaceProvider>
    );
    expect(q('.tk-thr-reason')).toBeNull();
    expect(q('.tk-related-list .tk-eyebrow')?.textContent).toBe('Similar threads');
    expect(q('.tk-related-meta')?.textContent).toContain('82% similar');
  });
});

describe('Detail pane: a web session that is not one of the known providers', () => {
  it('offers the resume command in the note when the header does not', async () => {
    // An https address no provider claims: "Open original" shows in the header, so the note carries the button.
    const c = conv({ provider: 'custom_web', accountId: 'stored_work', canonicalUrl: 'https://example.com/chat/1', resumeCommand: 'tool --resume 1' });
    const onCopy = vi.fn();
    await render(
      <WorkspaceProvider value={makeContext()}>
        <DetailPane {...detailProps(c, { onCopy })} />
      </WorkspaceProvider>
    );
    const button = q('.tk-thr-nopage button')!;
    expect(button.textContent).toBe('Copy resume command');
    await click(button);
    expect(onCopy).toHaveBeenCalledWith('tool --resume 1', 'Resume command');
  });
});
