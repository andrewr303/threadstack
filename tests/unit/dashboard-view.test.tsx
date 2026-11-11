import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { DashboardView } from '../../src/entrypoints/manager/dashboard/DashboardView.js';
import { WorkspaceProvider, type WorkspaceContextValue } from '../../src/entrypoints/manager/workspace/context.js';
import { FrameStage } from '../../src/entrypoints/manager/workspace/FrameStage.js';
import { threadTabId } from '../../src/entrypoints/manager/workspace/state.js';
import type { WorkspaceController, FrameRuntime } from '../../src/entrypoints/manager/workspace/useWorkspace.js';
import { EMPTY_WORKSPACE_STATE, type SessionTab, type WorkspaceState } from '../../src/core/workspace/types.js';
import type { ConversationRecord } from '../../src/core/schema.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const runtime: FrameRuntime = { frameId: null, loaded: false, canGoBack: false, canGoForward: false, agentState: null, reloads: 0 };

function conv(key: string, title: string, over: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    threadKey: key,
    provider: 'claude_code',
    accountId: 'primary~anthropic',
    title,
    manualTitleOverride: null,
    canonicalUrl: `https://claude.ai/code/${key}`,
    pinned: true,
    workflowState: 'active',
    isSyntheticBenchmark: false,
    updatedAt: '2026-01-01T00:00:00Z',
    lastCapturedAt: '2026-01-01T00:00:00Z',
    agentState: null,
    agentStateAt: null,
    ...over,
  } as unknown as ConversationRecord;
}

function tabFor(key: string): SessionTab {
  return { id: threadTabId(key), provider: 'claude_code', realm: 'anthropic', accountId: 'primary~anthropic', url: `https://claude.ai/code/${key}`, title: key, threadKey: key, createdAt: 1, lastActiveAt: 1 };
}

let container: HTMLDivElement;
let root: Root;
let dispatch: ReturnType<typeof vi.fn>;
let openThread: ReturnType<typeof vi.fn>;
let openSession: ReturnType<typeof vi.fn>;
let togglePinned: ReturnType<typeof vi.fn>;
let setView: ReturnType<typeof vi.fn>;

function mount(convs: ConversationRecord[], dashboard: Partial<WorkspaceState['dashboard']> = {}, tabs: SessionTab[] = [], view: 'dashboard' | 'browse' = 'dashboard') {
  const state: WorkspaceState = {
    ...EMPTY_WORKSPACE_STATE,
    tabs,
    dashboard: { ...EMPTY_WORKSPACE_STATE.dashboard, ...dashboard },
  };
  const workspace = {
    ready: true,
    embedding: true,
    error: null,
    realms: [],
    state,
    plan: { live: [], resting: {} },
    runtime: () => runtime,
    dispatch,
    openThread,
    noteFrameLoaded: vi.fn(),
  } as unknown as WorkspaceController;
  const value = {
    surface: 'page',
    workspace,
    settings: null,
    patchSettings: vi.fn(),
    view,
    setView,
    detailMode: 'summary',
    setDetailMode: vi.fn(),
    conversations: convs,
    conversationByKey: new Map(convs.map((c) => [c.threadKey, c])),
    insightsByThread: new Map(),
    summariesByThread: new Map(),
    selectedThreadKey: null,
    accountOfThread: () => ({ realm: null, account: { label: 'Work', color: 'teal', mode: 'embedded' }, active: true, switchable: true }),
    openSession,
    togglePinned,
    openInChromeTab: vi.fn(),
    requestAddAccount: vi.fn(),
    openSettings: vi.fn(),
    announce: vi.fn(),
  } as unknown as WorkspaceContextValue;
  act(() =>
    root.render(
      <WorkspaceProvider value={value}>
        <FrameStage workspace={workspace}>
          <DashboardView />
        </FrameStage>
      </WorkspaceProvider>
    )
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  dispatch = vi.fn();
  openThread = vi.fn(() => ({ ok: true, tabId: 'x' }));
  openSession = vi.fn();
  togglePinned = vi.fn(async () => {});
  setView = vi.fn();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

const pins = () => [...container.querySelectorAll<HTMLButtonElement>('.tk-dash-pin')];

describe('DashboardView', () => {
  const a = conv('a', 'Alpha', { updatedAt: '2026-01-01T00:00:00Z' });
  const b = conv('b', 'Beta', { updatedAt: '2026-03-01T00:00:00Z' });
  const c = conv('c', 'Gamma', { updatedAt: '2026-02-01T00:00:00Z' });

  it('lists pinned sessions most recently updated first, without archived or unpinned ones', () => {
    mount([a, b, c, conv('d', 'Archived', { workflowState: 'archived' }), conv('e', 'Loose', { pinned: false })]);
    expect(pins().map((p) => p.querySelector('.tk-dash-pin-label')?.textContent)).toEqual(['Beta', 'Gamma', 'Alpha']);
  });

  it('opens a pressed session without activating Browse and places it in the focused pane', () => {
    mount([a, b], { layout: 2, panes: [null, null], focusedPane: 1 });
    act(() => pins()[0].click());
    expect(openThread).toHaveBeenCalledWith(b, { activate: false });
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_pane', index: 1, threadKey: 'b' });
  });

  it('changes the number of panes through the layout control', () => {
    mount([a]);
    const group = container.querySelector('[role="radiogroup"]')!;
    const four = group.querySelector<HTMLButtonElement>('[aria-label="4 panes"]')!;
    act(() => four.click());
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_layout', layout: 4 });
  });

  it('gives each pane a slot for its thread tab and a name', () => {
    mount([a, b], { layout: 2, panes: ['a', 'b'], focusedPane: 0 }, [tabFor('a'), tabFor('b')]);
    expect(container.querySelector(`[data-tab="${threadTabId('a')}"]`)).not.toBeNull();
    const first = container.querySelector('section[aria-label="Pane 1: Alpha"]')!;
    expect(first.getAttribute('aria-current')).toBe('true');
    expect(container.querySelector('section[aria-label="Pane 2: Beta"]')!.getAttribute('aria-current')).toBeNull();
  });

  it('opens the tab of a pane that has none, without activating Browse', () => {
    mount([a], { layout: 1, panes: ['a'], focusedPane: 0 }, []);
    expect(openThread).toHaveBeenCalledWith(a, { activate: false });
  });

  it('focuses a pane from its header', () => {
    mount([a, b], { layout: 2, panes: ['a', 'b'], focusedPane: 0 }, [tabFor('a'), tabFor('b')]);
    const second = container.querySelector<HTMLButtonElement>('[data-pane-focus="1"]')!;
    act(() => second.click());
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_focus', index: 1 });
  });

  it('unpins and opens in Browse from the pane header', () => {
    mount([a], { layout: 1, panes: ['a'], focusedPane: 0 }, [tabFor('a')]);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Unpin Alpha from dashboard"]')!.click());
    expect(togglePinned).toHaveBeenCalledWith(a);
    act(() => container.querySelector<HTMLButtonElement>('[aria-label="Open Alpha in Browse"]')!.click());
    expect(openSession).toHaveBeenCalledWith(a, 'browse');
  });

  it('swaps a session from the menu and closes it with Escape, returning focus', () => {
    mount([a, b], { layout: 2, panes: ['a', null], focusedPane: 0 }, [tabFor('a')]);
    const trigger = container.querySelector<HTMLButtonElement>('[aria-label="Swap session in pane 1"]')!;
    act(() => trigger.click());
    const items = container.querySelectorAll('[role="menuitem"]');
    expect(items).toHaveLength(1);
    act(() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    expect(container.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
    act(() => trigger.click());
    act(() => (container.querySelector('[role="menuitem"]') as HTMLButtonElement).click());
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_pane', index: 0, threadKey: 'b' });
  });

  it('clears a pane whose thread is no longer pinned', () => {
    mount([conv('a', 'Alpha', { pinned: false }), b], { layout: 2, panes: ['a', null], focusedPane: 0 });
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_pane', index: 0, threadKey: null });
    expect(container.querySelector('section[aria-label="Pane 1: Alpha"]')).toBeNull();
  });

  it('offers unplaced pinned sessions in an empty pane, or says all are placed', () => {
    mount([a, b], { layout: 2, panes: ['a', null], focusedPane: 1 }, [tabFor('a')]);
    const empty = container.querySelector('section[aria-label="Pane 2: empty"]')!;
    expect(empty.textContent).toContain('Nothing in this pane');
    act(() => empty.querySelector<HTMLButtonElement>('.tk-btn')!.click());
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_pane', index: 1, threadKey: 'b' });
    mount([a], { layout: 2, panes: ['a', null], focusedPane: 1 }, [tabFor('a')]);
    expect(container.querySelector('section[aria-label="Pane 2: empty"]')!.textContent).toContain('already in a pane');
  });

  it('shows one notice with a way to Threads when nothing is pinned', () => {
    mount([conv('a', 'Alpha', { pinned: false })]);
    expect(container.textContent).toContain('No pinned sessions yet');
    act(() => [...container.querySelectorAll<HTMLButtonElement>('button')].find((x) => x.textContent === 'Go to Threads')!.click());
    expect(setView).toHaveBeenCalledWith('threads');
  });

  it('sends a session with no web page to Threads and says why', () => {
    const doc = conv('n', 'Notes', { canonicalUrl: 'file:///notes.md' });
    mount([doc]);
    expect(pins()[0].title).toContain('no web page');
    act(() => pins()[0].click());
    expect(openSession).toHaveBeenCalledWith(doc, 'threads');
    expect(openThread).not.toHaveBeenCalled();
  });

  it('focuses a pane with Alt+number only while the dashboard is showing', () => {
    mount([a, b], { layout: 2, panes: ['a', 'b'], focusedPane: 0 }, [tabFor('a'), tabFor('b')]);
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true })));
    expect(dispatch).toHaveBeenCalledWith({ type: 'dashboard_focus', index: 1 });
    dispatch.mockClear();
    mount([a, b], { layout: 2, panes: ['a', 'b'], focusedPane: 0 }, [tabFor('a'), tabFor('b')], 'browse');
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', code: 'Digit2', altKey: true })));
    expect(dispatch).not.toHaveBeenCalledWith({ type: 'dashboard_focus', index: 1 });
  });
});
