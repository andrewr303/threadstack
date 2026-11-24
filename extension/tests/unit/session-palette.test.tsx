import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { SessionPalette } from '../../src/entrypoints/manager/shell/SessionPalette.js';
import {
  clampSelection,
  filterPalette,
  looksLikeAddress,
  moveSelection,
  paletteAddress,
  paletteCounts,
  paletteMatches,
  toPaletteSession,
} from '../../src/entrypoints/manager/shell/palette.js';
import {
  isSessionPaletteKey,
  shouldOpenSessionPalette,
  useWorkbenchKeyboard,
} from '../../src/entrypoints/manager/hooks/useWorkbenchKeyboard.js';
import { INITIAL_FUSION, usePaperclipFusionDom } from '../../src/entrypoints/manager/PaperclipFusion.js';
import type { PaperclipFrameControl } from '../../src/entrypoints/manager/PaperclipView.js';
import { WorkspaceProvider, type ThreadAccount, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import { threadTabId } from '../../src/entrypoints/manager/workspace/state.js';
import type { WorkspaceController } from '../../src/entrypoints/manager/workspace/useWorkspace.js';
import { realmById } from '../../src/core/workspace/realms.js';
import { EMPTY_WORKSPACE_STATE, type AccountRecord, type AgentState, type SessionTab } from '../../src/core/workspace/types.js';
import type { ConversationRecord } from '../../src/core/schema.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const claudeRealm = realmById('anthropic')!;

const ADMIN: AccountRecord = {
  id: 'acct_admin',
  realm: 'anthropic',
  label: 'Admin',
  color: 'peach',
  mode: 'embedded',
  primary: false,
  identity: null,
  signedIn: 'yes',
  hasJar: true,
  order: 1,
  createdAt: '2026-01-01T00:00:00Z',
  lastActiveAt: null,
};
const WORK: AccountRecord = { ...ADMIN, id: 'primary~anthropic', label: 'Work', color: 'teal', primary: true, order: 0 };

/** A session updated `minutesAgo` minutes before a fixed moment, so the recency order is known. */
function conv(key: string, title: string, minutesAgo: number, over: Partial<ConversationRecord> = {}): ConversationRecord {
  const at = new Date(Date.UTC(2026, 10, 10, 12, 0) - minutesAgo * 60_000).toISOString();
  return {
    threadKey: key,
    provider: 'claude_code',
    accountId: WORK.id,
    title,
    manualTitleOverride: null,
    canonicalUrl: `https://claude.ai/code/${key}`,
    pinned: false,
    workflowState: 'active',
    isSyntheticBenchmark: false,
    updatedAt: at,
    lastCapturedAt: at,
    agentState: null,
    agentStateAt: null,
    ...over,
  } as unknown as ConversationRecord;
}

const LIBRARY: ConversationRecord[] = [
  conv('ext', 'Extension support for non-Chrome browsers', 0, { agentState: 'running' }),
  conv('upwork', 'Upwork description variations', 4, { agentState: 'running' }),
  conv('datadog', 'Datadog platform integration', 60),
  conv('creator', 'Creator discovery agent web search', 2, { agentState: 'waiting_permission', accountId: ADMIN.id }),
  conv('homepage', 'Homepage 2.0 design variations', 6, { agentState: 'waiting_answer' }),
  conv('pricing', 'Pricing page copy', 1440, { provider: 'claude', canonicalUrl: 'https://claude.ai/chat/pricing', accountId: ADMIN.id }),
  conv('brand', 'On brand genome copy review', 300, { provider: 'chatgpt', canonicalUrl: 'https://chatgpt.com/c/brand', accountId: 'gpt' }),
  conv('old', 'Archived experiment', 5, { workflowState: 'archived' }),
  conv('bench', 'Benchmark record', 1, { isSyntheticBenchmark: true }),
];

const accountOfThread = (c: Pick<ConversationRecord, 'provider' | 'accountId'>): ThreadAccount => {
  const account = [WORK, ADMIN].find((a) => a.id === c.accountId) ?? null;
  return { realm: account ? claudeRealm : null, account, active: account?.id === WORK.id, switchable: true };
};
const labelOf = (c: ConversationRecord) => accountOfThread(c).account?.label ?? null;
const titles = (rows: { title: string }[]) => rows.map((r) => r.title);

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

describe('palette rules', () => {
  it('lists every eligible session, most recent first, with no query', () => {
    const keys = paletteMatches({ query: '', conversations: LIBRARY }).map((c) => c.threadKey);
    expect(keys).toEqual(['ext', 'creator', 'upwork', 'homepage', 'datadog', 'brand', 'pricing']);
  });

  it('keeps the library search order and adds sessions whose account name matches', () => {
    const search = vi.fn(() => [LIBRARY[2], LIBRARY[0], LIBRARY[7]]);
    const keys = paletteMatches({ query: ' admin ', conversations: LIBRARY, search, accountLabelOf: labelOf }).map((c) => c.threadKey);
    expect(search).toHaveBeenCalledWith('admin');
    // The archived thread the search returned is left out; Admin's two sessions follow the hits.
    expect(keys).toEqual(['datadog', 'ext', 'creator', 'pricing']);
  });

  it('sorts Needs you, then Running, then Idle, keeping the order within each', () => {
    const rows = paletteMatches({ query: '', conversations: LIBRARY }).map((c) => toPaletteSession(c));
    expect(titles(filterPalette(rows, 'all'))).toEqual([
      'Creator discovery agent web search',
      'Homepage 2.0 design variations',
      'Extension support for non-Chrome browsers',
      'Upwork description variations',
      'Datadog platform integration',
      'On brand genome copy review',
      'Pricing page copy',
    ]);
    expect(titles(filterPalette(rows, 'needs'))).toEqual(['Creator discovery agent web search', 'Homepage 2.0 design variations']);
    expect(titles(filterPalette(rows, 'running'))).toEqual(['Extension support for non-Chrome browsers', 'Upwork description variations']);
    expect(filterPalette(rows, 'chats').map((r) => r.conversation.threadKey)).toEqual(['brand', 'pricing']);
  });

  it('counts each filter against the current matches', () => {
    const all = paletteMatches({ query: '', conversations: LIBRARY }).map((c) => toPaletteSession(c));
    expect(paletteCounts(all)).toEqual({ all: 7, needs: 2, running: 2, coding: 5, chats: 2 });
    const copy = paletteMatches({ query: 'copy', conversations: LIBRARY }).map((c) => toPaletteSession(c));
    expect(paletteCounts(copy)).toEqual({ all: 2, needs: 0, running: 0, coding: 0, chats: 2 });
  });

  it('prefers the live run state of an open page, and gives chats no run state', () => {
    expect(toPaletteSession(LIBRARY[2], 'waiting_answer').rank).toBe(0);
    expect(toPaletteSession(LIBRARY[0], 'turn_complete').rank).toBe(2);
    expect(toPaletteSession(conv('chat', 'A chat', 0, { provider: 'claude', agentState: 'running' })).run).toBeNull();
  });

  it('recognises addresses and routes them through the Browse address rules', () => {
    expect(looksLikeAddress('claude.ai/code')).toBe(true);
    expect(looksLikeAddress('https://chatgpt.com')).toBe(true);
    expect(looksLikeAddress('fix the build')).toBe(false);
    expect(looksLikeAddress('v1.2')).toBe(false);
    expect(looksLikeAddress('pricing')).toBe(false);
    expect(paletteAddress('claude.ai/code')).toMatchObject({ kind: 'open', url: 'https://claude.ai/code', host: 'claude.ai', path: '/code' });
    expect(paletteAddress('example.com/docs')).toMatchObject({ kind: 'chrome', url: 'https://example.com/docs', host: 'example.com' });
    expect(paletteAddress('Datadog integration')).toBeNull();
  });

  it('moves the selection one row at a time and never wraps', () => {
    expect(moveSelection(0, -1, 3)).toBe(0);
    expect(moveSelection(0, 1, 3)).toBe(1);
    expect(moveSelection(2, 1, 3)).toBe(2);
    expect(moveSelection(-1, 1, 3)).toBe(1);
    expect(moveSelection(0, 1, 0)).toBe(-1);
    expect(clampSelection(5, 2)).toBe(1);
    expect(clampSelection(0, 0)).toBe(-1);
  });
});

// ---------------------------------------------------------------------------------------------
// The palette
// ---------------------------------------------------------------------------------------------

let container: HTMLDivElement;
let root: Root;
let openSession: ReturnType<typeof vi.fn>;
let setView: ReturnType<typeof vi.fn>;
let openUrl: ReturnType<typeof vi.fn>;
let openInChromeTab: ReturnType<typeof vi.fn>;
let onClose: ReturnType<typeof vi.fn>;

function Host({ open, tabs = [], live = {} }: { open: boolean; tabs?: SessionTab[]; live?: Record<string, AgentState> }) {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const workspace = {
    enabled: true,
    ready: true,
    realms: [{ realm: claudeRealm, accounts: [WORK, ADMIN], activeAccountId: WORK.id }],
    state: { ...EMPTY_WORKSPACE_STATE, tabs },
    plan: { live: [], resting: {} },
    runtime: (id: string) => ({ frameId: null, loaded: false, canGoBack: false, canGoForward: false, agentState: live[id] ?? null, reloads: 0 }),
    openUrl,
    dispatch: vi.fn(),
  } as unknown as WorkspaceController;
  const value = {
    surface: 'page',
    workspace,
    settings: null,
    patchSettings: vi.fn(),
    view: 'table',
    setView,
    detailMode: 'summary',
    setDetailMode: vi.fn(),
    conversations: LIBRARY,
    conversationByKey: new Map(LIBRARY.map((c) => [c.threadKey, c])),
    insightsByThread: new Map(),
    summariesByThread: new Map(),
    selectedThreadKey: null,
    accountOfThread,
    openSession,
    togglePinned: vi.fn(),
    openInChromeTab,
    requestAddAccount: vi.fn(),
    openSettings: vi.fn(),
    announce: vi.fn(),
  } as unknown as WorkspaceContextValue;
  return (
    <WorkspaceProvider value={value}>
      <button type="button" id="opener">
        Search
      </button>
      <SessionPalette dialogRef={dialogRef} open={open} onClose={onClose} />
    </WorkspaceProvider>
  );
}

function render(props: React.ComponentProps<typeof Host>) {
  act(() => root.render(<Host {...props} />));
}

const dialog = () => container.querySelector<HTMLDialogElement>('dialog.tk-palette')!;
const input = () => container.querySelector<HTMLInputElement>('.tk-palette-input')!;
const options = () => [...container.querySelectorAll<HTMLLIElement>('[role="option"]')];
const optionTitles = () => options().map((o) => o.querySelector('.tk-palette-title')!.textContent);
const selectedTitle = () => options().find((o) => o.getAttribute('aria-selected') === 'true')?.querySelector('.tk-palette-title')?.textContent;
const chip = (id: string) => container.querySelector<HTMLButtonElement>(`.tk-palette-chip[data-filter="${id}"]`)!;
const count = (id: string) => chip(id).querySelector('.tk-palette-count')!.firstChild!.textContent;
const key = (k: string, init: KeyboardEventInit = {}) =>
  act(() => {
    input().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }));
  });
function type(text: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  act(() => {
    setter.call(input(), text);
    input().dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function openFromOpener(props: Omit<React.ComponentProps<typeof Host>, 'open'> = {}) {
  render({ ...props, open: false });
  container.querySelector<HTMLButtonElement>('#opener')!.focus();
  render({ ...props, open: true });
}

beforeEach(() => {
  openSession = vi.fn();
  setView = vi.fn();
  openUrl = vi.fn(() => ({ ok: true, tabId: 'tab_1' }));
  openInChromeTab = vi.fn();
  onClose = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('SessionPalette', () => {
  it('opens on the input with every session, needing the person first', () => {
    openFromOpener();
    expect(dialog().hasAttribute('open')).toBe(true);
    expect(document.activeElement).toBe(input());
    expect(container.querySelector('[role="listbox"]')).not.toBeNull();
    expect(optionTitles()).toEqual([
      'Creator discovery agent web search',
      'Homepage 2.0 design variations',
      'Extension support for non-Chrome browsers',
      'Upwork description variations',
      'Datadog platform integration',
      'On brand genome copy review',
      'Pricing page copy',
    ]);
    expect(selectedTitle()).toBe('Creator discovery agent web search');
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);
    expect(options()[0].textContent).toContain('Needs approval');
    expect(options()[4].textContent).toContain('Idle');
    expect(container.querySelector('.tk-palette-total')!.textContent).toBe('7 of 7 sessions');
    expect([count('all'), count('needs'), count('running'), count('coding'), count('chats')]).toEqual(['7', '2', '2', '5', '2']);
  });

  it('narrows by the query and recounts the filters', () => {
    openFromOpener();
    type('variations');
    expect(optionTitles()).toEqual(['Homepage 2.0 design variations', 'Upwork description variations']);
    expect([count('all'), count('needs'), count('running'), count('chats')]).toEqual(['2', '1', '1', '0']);
    expect(container.querySelector('.tk-palette-total')!.textContent).toBe('2 of 7 sessions');
  });

  it('filters by run state or kind from the chips', () => {
    openFromOpener();
    act(() => chip('running').click());
    expect(chip('running').getAttribute('aria-pressed')).toBe('true');
    expect(chip('all').getAttribute('aria-pressed')).toBe('false');
    expect(optionTitles()).toEqual(['Extension support for non-Chrome browsers', 'Upwork description variations']);
    act(() => chip('chats').click());
    expect(optionTitles()).toEqual(['On brand genome copy review', 'Pricing page copy']);
  });

  it('moves with the arrows without wrapping, and opens the chosen session in Browse', () => {
    openFromOpener();
    key('ArrowUp');
    expect(selectedTitle()).toBe('Creator discovery agent web search');
    key('ArrowDown');
    key('ArrowDown');
    expect(selectedTitle()).toBe('Extension support for non-Chrome browsers');
    for (let i = 0; i < 10; i++) key('ArrowDown');
    expect(selectedTitle()).toBe('Pricing page copy');
    key('Enter');
    expect(openSession).toHaveBeenCalledWith(LIBRARY[5], 'browse');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog().hasAttribute('open')).toBe(false);
  });

  it('selects the row under the pointer and opens it on click', () => {
    openFromOpener();
    act(() => options()[3].dispatchEvent(new MouseEvent('mousemove', { bubbles: true })));
    expect(selectedTitle()).toBe('Upwork description variations');
    act(() => options()[3].click());
    expect(openSession).toHaveBeenCalledWith(LIBRARY[1], 'browse');
  });

  it('closes on Escape and gives focus back to where it was', () => {
    openFromOpener();
    key('Escape');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(document.activeElement?.id).toBe('opener');
    expect(openSession).not.toHaveBeenCalled();
  });

  it('closes on a click outside the panel', () => {
    openFromOpener();
    act(() => dialog().click());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the palette', () => {
    openFromOpener();
    const last = chip('chats');
    last.focus();
    act(() => {
      last.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(input());
    act(() => {
      input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true }));
    });
    expect(document.activeElement).toBe(last);
  });

  it('offers an address first and opens it as a tab in Browse', () => {
    openFromOpener();
    type('claude.ai/code');
    expect(options()[0].getAttribute('data-kind')).toBe('address');
    expect(options()[0].textContent).toContain('claude.ai');
    key('Enter');
    expect(openUrl).toHaveBeenCalledWith('https://claude.ai/code');
    expect(setView).toHaveBeenCalledWith('browse');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('says why an address did not open, and stays open', () => {
    openUrl.mockReturnValue({ ok: false, reason: 'limit', message: 'Too many tabs are open.' });
    openFromOpener();
    type('chatgpt.com');
    key('Enter');
    expect(container.querySelector('.tk-palette-problem')!.textContent).toContain('Too many tabs are open.');
    expect(onClose).not.toHaveBeenCalled();
  });

  it('offers a Chrome tab for a site it cannot show', () => {
    openFromOpener();
    type('example.com');
    key('Enter');
    expect(openInChromeTab).toHaveBeenCalledWith('https://example.com/');
    expect(openUrl).not.toHaveBeenCalled();
  });

  it('shows the live run state of an open page', () => {
    const tab: SessionTab = {
      id: threadTabId('datadog'),
      provider: 'claude_code',
      realm: 'anthropic',
      accountId: WORK.id,
      url: 'https://claude.ai/code/datadog',
      title: 'Datadog',
      threadKey: 'datadog',
      createdAt: 1,
      lastActiveAt: 1,
    };
    openFromOpener({ tabs: [tab], live: { [tab.id]: 'waiting_answer' } });
    expect(optionTitles().slice(0, 3)).toEqual([
      'Creator discovery agent web search',
      'Homepage 2.0 design variations',
      'Datadog platform integration',
    ]);
    expect(count('needs')).toBe('3');
  });

  it('closes when its owner closes it', () => {
    openFromOpener();
    render({ open: false });
    expect(dialog().hasAttribute('open')).toBe(false);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------------------------
// ⌘K
// ---------------------------------------------------------------------------------------------

describe('⌘K', () => {
  const k = (init: KeyboardEventInit = {}) => ({ key: 'k', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, ...init });
  const ctx = { surface: 'page' as const, enabled: true, fused: false, dialogOpen: false };

  it('is Command+K or Control+K with no other modifier', () => {
    expect(isSessionPaletteKey(k({ metaKey: true }))).toBe(true);
    expect(isSessionPaletteKey(k({ ctrlKey: true, key: 'K' }))).toBe(true);
    expect(isSessionPaletteKey(k())).toBe(false);
    expect(isSessionPaletteKey(k({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSessionPaletteKey(k({ ctrlKey: true, altKey: true }))).toBe(false);
  });

  it('opens the session palette only on the page, switched on, unfused, with no dialog open', () => {
    const cmd = k({ metaKey: true });
    expect(shouldOpenSessionPalette(cmd, ctx)).toBe(true);
    expect(shouldOpenSessionPalette(cmd, { ...ctx, fused: true })).toBe(false);
    expect(shouldOpenSessionPalette(cmd, { ...ctx, enabled: false })).toBe(false);
    expect(shouldOpenSessionPalette(cmd, { ...ctx, dialogOpen: true })).toBe(false);
    expect(shouldOpenSessionPalette(cmd, { ...ctx, surface: 'sidepanel' })).toBe(false);
  });

  function Keys({ fused, enabled, onOpen, control }: { fused: boolean; enabled: boolean; onOpen: () => void; control?: PaperclipFrameControl }) {
    const shellRef = useRef<HTMLDivElement | null>(null);
    const controlRef = useRef<PaperclipFrameControl | null>(control ?? null);
    useWorkbenchKeyboard({
      surface: 'page',
      handshakeToken: 't',
      dialogRefs: [],
      lastInnerModalCloseAtRef: useRef(0),
      listHits: [],
      selectedThreadKey: undefined,
      checkedCount: 0,
      searchInputRef: useRef(null),
      selectAllRef: useRef(null),
      rowRefs: useRef(new Map()),
      onFocusSearch: vi.fn(),
      onSelectThread: vi.fn(),
      onClearChecked: vi.fn(),
      onCloseOverlay: vi.fn(),
      paletteEnabled: enabled,
      fused,
      onOpenPalette: onOpen,
    });
    usePaperclipFusionDom({ fused, state: INITIAL_FUSION, shellRef, control: controlRef, onStaleOverlay: vi.fn() });
    return (
      <div ref={shellRef} className="tk-shell">
        <button type="button" id="in-view">
          In a view
        </button>
      </div>
    );
  }

  const pressFromView = () => {
    const target = container.querySelector<HTMLButtonElement>('#in-view')!;
    target.focus();
    const event = new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true, cancelable: true });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };

  it('opens the session palette and claims the key', () => {
    const onOpen = vi.fn();
    act(() => root.render(<Keys fused={false} enabled onOpen={onOpen} />));
    const event = pressFromView();
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
  });

  it('does nothing when the palette is switched off', () => {
    const onOpen = vi.fn();
    act(() => root.render(<Keys fused={false} enabled={false} onOpen={onOpen} />));
    const event = pressFromView();
    expect(onOpen).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('leaves ⌘K to Paperclip’s palette in fused mode', () => {
    const onOpen = vi.fn();
    const control: PaperclipFrameControl = { post: vi.fn(() => true), focus: vi.fn(), frame: () => null };
    act(() => root.render(<Keys fused enabled onOpen={onOpen} control={control} />));
    pressFromView();
    expect(onOpen).not.toHaveBeenCalled();
    expect(control.post).toHaveBeenCalledWith({ type: 'command', name: 'palette' });
  });
});
