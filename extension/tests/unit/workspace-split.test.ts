// Browse split view and the status board's mode: the reducer rules from the design prototype
// (toggleSplit, closeTab, openSession) and how a stored state from before split view is read.
import { describe, expect, it } from 'vitest';
import {
  browseOf,
  browseVisibleTabs,
  normalizeWorkspaceState,
  paneOfTab,
  tabsInPane,
  workspaceReducer,
  workspaceShape,
  type WorkspaceAction,
} from '../../src/entrypoints/manager/workspace/state.js';
import { primaryAccountId } from '../../src/core/workspace/realms.js';
import { DEFAULT_BROWSE_LAYOUT, EMPTY_WORKSPACE_STATE, type WorkspaceState } from '../../src/core/workspace/types.js';

const CLAUDE = primaryAccountId('anthropic');

function open(id: string, now: number, activate = true): WorkspaceAction {
  return {
    type: 'open',
    id,
    url: `https://claude.ai/code/session_${id}`,
    provider: 'claude_code',
    realm: 'anthropic',
    accountId: CLAUDE,
    title: id,
    threadKey: null,
    now,
    activate,
  };
}

const run = (state: WorkspaceState, ...actions: WorkspaceAction[]) => actions.reduce(workspaceReducer, state);
const ids = (state: WorkspaceState, pane: 0 | 1) => tabsInPane(state.tabs, pane).map((t) => t.id);

/** a and b in the left pane, c and d in the right one, split on, right pane focused showing d. */
function splitFour(): WorkspaceState {
  return run(
    EMPTY_WORKSPACE_STATE,
    open('a', 1),
    open('b', 2),
    { type: 'browse_split', on: true },
    { type: 'browse_focus', pane: 1 },
    open('c', 3),
    open('d', 4)
  );
}

describe('split view: turning it on and off', () => {
  it('is off by default and changes nothing about the single tab strip', () => {
    const s = run(EMPTY_WORKSPACE_STATE, open('a', 1), open('b', 2));
    expect(browseOf(s)).toMatchObject({ split: false, mode: 'tabs', focusedPane: 0 });
    expect(s.activeTabId).toBe('b');
    expect(s.tabs.map(paneOfTab)).toEqual([0, 0]);
    expect(browseVisibleTabs(s)).toEqual(['b']);
  });

  it('on: the shown tab\'s pane is focused and each pane shows its tab (or nothing)', () => {
    const s = run(EMPTY_WORKSPACE_STATE, open('a', 1), open('b', 2), { type: 'activate', id: 'a', now: 3 }, { type: 'browse_split', on: true });
    const layout = browseOf(s);
    expect(layout.split).toBe(true);
    expect(layout.focusedPane).toBe(0);
    expect(layout.paneActive).toEqual(['a', null]);
    expect(s.activeTabId).toBe('a');
    // The empty right pane loads nothing; the left pane's page is the visible one.
    expect(browseVisibleTabs(s)).toEqual(['a']);
  });

  it('on: a pane whose remembered tab is gone falls back to its first tab', () => {
    const s = splitFour();
    const off = run(s, { type: 'browse_split', on: false }, { type: 'close', id: 'a' }, { type: 'activate', id: 'd', now: 9 });
    // Left pane remembered 'b' after the close; the right pane shows d.
    const on = workspaceReducer(off, { type: 'browse_split', on: true });
    expect(browseOf(on).paneActive).toEqual(['b', 'd']);
    expect(browseOf(on).focusedPane).toBe(1);
  });

  it('off: keeps the focused pane\'s tab in front', () => {
    const s = run(splitFour(), { type: 'browse_focus', pane: 0 });
    expect(s.activeTabId).toBe('b');
    const off = workspaceReducer(s, { type: 'browse_split', on: false });
    expect(browseOf(off).split).toBe(false);
    expect(off.activeTabId).toBe('b');
    expect(browseVisibleTabs(off)).toEqual(['b']);
    // Tabs keep their panes, so splitting again restores the arrangement.
    expect(ids(off, 0)).toEqual(['a', 'b']);
    expect(ids(off, 1)).toEqual(['c', 'd']);
    const again = workspaceReducer(off, { type: 'browse_split', on: true });
    expect(browseOf(again).paneActive).toEqual(['b', 'd']);
  });

  it('off with the focused pane empty keeps the other pane\'s tab', () => {
    const s = run(EMPTY_WORKSPACE_STATE, open('a', 1), { type: 'browse_split', on: true }, { type: 'browse_focus', pane: 1 });
    expect(s.activeTabId).toBeNull();
    const off = workspaceReducer(s, { type: 'browse_split', on: false });
    expect(off.activeTabId).toBe('a');
    expect(browseOf(off).focusedPane).toBe(0);
  });

  it('turning it on leaves the status board', () => {
    const s = run(EMPTY_WORKSPACE_STATE, open('a', 1), { type: 'browse_mode', mode: 'board' }, { type: 'browse_split', on: true });
    expect(browseOf(s).mode).toBe('tabs');
  });
});

describe('split view: each tab belongs to one pane', () => {
  it('opening a new session puts it in the focused pane', () => {
    const s = splitFour();
    expect(ids(s, 0)).toEqual(['a', 'b']);
    expect(ids(s, 1)).toEqual(['c', 'd']);
    expect(browseOf(s).paneActive).toEqual(['b', 'd']);
    expect(s.activeTabId).toBe('d');
    // Both panes' pages are visible, the focused one first.
    expect(browseVisibleTabs(s)).toEqual(['d', 'b']);
  });

  it('opening a session that is already open shows it in its own pane and focuses that pane', () => {
    const s = workspaceReducer(splitFour(), open('a', 10));
    expect(s.tabs).toHaveLength(4);
    expect(ids(s, 0)).toEqual(['a', 'b']);
    expect(browseOf(s).focusedPane).toBe(0);
    expect(browseOf(s).paneActive).toEqual(['a', 'd']);
    expect(s.activeTabId).toBe('a');
  });

  it('a tab opened in the background does not change what either pane shows', () => {
    const s = workspaceReducer(splitFour(), open('e', 10, false));
    expect(ids(s, 1)).toEqual(['c', 'd', 'e']);
    expect(browseOf(s).paneActive).toEqual(['b', 'd']);
    expect(s.activeTabId).toBe('d');
  });

  it('activating a tab of the other pane moves the focus there', () => {
    const s = workspaceReducer(splitFour(), { type: 'activate', id: 'a', now: 20 });
    expect(browseOf(s).focusedPane).toBe(0);
    expect(browseOf(s).paneActive).toEqual(['a', 'd']);
    expect(s.activeTabId).toBe('a');
  });

  it('focusing a pane makes its tab the active one; focusing the focused pane changes nothing', () => {
    const s = splitFour();
    expect(workspaceReducer(s, { type: 'browse_focus', pane: 1 })).toBe(s);
    const left = workspaceReducer(s, { type: 'browse_focus', pane: 0 });
    expect(left.activeTabId).toBe('b');
    expect(browseOf(left).focusedPane).toBe(0);
  });

  it('focusing a pane does nothing while not split', () => {
    const s = run(EMPTY_WORKSPACE_STATE, open('a', 1));
    expect(workspaceReducer(s, { type: 'browse_focus', pane: 1 })).toBe(s);
  });

  it('a tab can move to the other pane, where it is shown and focused', () => {
    const s = workspaceReducer(splitFour(), { type: 'browse_move_tab', id: 'b', pane: 1 });
    expect(ids(s, 0)).toEqual(['a']);
    expect(ids(s, 1)).toEqual(['b', 'c', 'd']);
    // The left pane falls back to b's neighbour.
    expect(browseOf(s).paneActive).toEqual(['a', 'b']);
    expect(browseOf(s).focusedPane).toBe(1);
    expect(s.activeTabId).toBe('b');
    expect(workspaceReducer(s, { type: 'browse_move_tab', id: 'b', pane: 1 })).toBe(s);
  });
});

describe('split view: closing a tab', () => {
  it('activates the next tab within the same pane, else the previous one', () => {
    let s = run(splitFour(), { type: 'activate', id: 'c', now: 20 });
    s = workspaceReducer(s, { type: 'close', id: 'c' });
    expect(s.activeTabId).toBe('d');
    expect(browseOf(s).paneActive).toEqual(['b', 'd']);
    s = workspaceReducer(s, { type: 'close', id: 'd' });
    // The right pane is empty and still focused: it shows its new tab page, never the left's tab.
    expect(s.activeTabId).toBeNull();
    expect(browseOf(s).paneActive).toEqual(['b', null]);
    expect(browseVisibleTabs(s)).toEqual(['b']);
  });

  it('closing the other pane\'s tab leaves the focused pane alone', () => {
    const s = workspaceReducer(splitFour(), { type: 'close', id: 'b' });
    expect(s.activeTabId).toBe('d');
    expect(browseOf(s).paneActive).toEqual(['a', 'd']);
    expect(browseOf(s).focusedPane).toBe(1);
  });

  it('closing the last tab of the left pane picks the previous tab in that pane, not one in the right pane', () => {
    let s = run(splitFour(), { type: 'browse_focus', pane: 0 });
    s = workspaceReducer(s, { type: 'close', id: 'b' });
    expect(s.activeTabId).toBe('a');
  });

  it('unsplit, closing keeps today\'s rule across the whole strip', () => {
    // a, b | c, d; unsplit the strip reads a b c d. Closing b shows c (to its right) even though
    // c is in the other pane, as a single strip would.
    let s = run(splitFour(), { type: 'browse_split', on: false }, { type: 'activate', id: 'b', now: 30 });
    s = workspaceReducer(s, { type: 'close', id: 'b' });
    expect(s.activeTabId).toBe('c');
    // A new tab now opens next to c, in c's pane.
    s = workspaceReducer(s, open('e', 31));
    expect(ids(s, 1)).toEqual(['c', 'd', 'e']);
  });
});

describe('the status board mode', () => {
  it('switches between the tabs and the board, and the board shows no pages', () => {
    const s = run(EMPTY_WORKSPACE_STATE, open('a', 1), { type: 'browse_mode', mode: 'board' });
    expect(browseOf(s).mode).toBe('board');
    expect(browseVisibleTabs(s)).toEqual([]);
    expect(workspaceReducer(s, { type: 'browse_mode', mode: 'board' })).toBe(s);
    expect(browseVisibleTabs(workspaceReducer(s, { type: 'browse_mode', mode: 'tabs' }))).toEqual(['a']);
  });
});

describe('persistence', () => {
  it('reads a state stored before split view as one pane showing the tabs', () => {
    const stored = {
      version: 1,
      tabs: [
        { id: 'a', provider: 'claude_code', realm: 'anthropic', accountId: CLAUDE, url: 'https://claude.ai/code/x', title: 'A', threadKey: null, createdAt: 1, lastActiveAt: 1 },
      ],
      activeTabId: 'a',
      dashboard: { layout: 2, panes: [null, null], focusedPane: 0 },
      collapsedGroups: [],
    };
    const s = normalizeWorkspaceState(stored);
    expect(s.browse).toEqual(DEFAULT_BROWSE_LAYOUT);
    expect(s.tabs[0].pane).toBeUndefined();
    expect(s.activeTabId).toBe('a');
    expect(normalizeWorkspaceState(null)).toEqual(EMPTY_WORKSPACE_STATE);
  });

  it('round-trips a split arrangement and drops what does not fit it', () => {
    const s = splitFour();
    const back = normalizeWorkspaceState(JSON.parse(JSON.stringify(s)));
    expect(back.browse).toEqual(browseOf(s));
    expect(back.tabs.map(paneOfTab)).toEqual([0, 0, 1, 1]);
    expect(back.activeTabId).toBe('d');

    const broken = normalizeWorkspaceState({
      ...JSON.parse(JSON.stringify(s)),
      // A pane pointing at a tab of the other pane, or at nothing, is cleared; junk values default.
      browse: { split: 'yes', paneActive: ['d', 'zzz'], focusedPane: 7, mode: 'carousel' },
    });
    expect(broken.browse).toEqual({ split: false, paneActive: [null, null], focusedPane: 0, mode: 'tabs' });
  });

  it('while split, the active tab is the focused pane\'s, even if the stored one disagrees', () => {
    const raw = JSON.parse(JSON.stringify(splitFour()));
    raw.activeTabId = 'a';
    expect(normalizeWorkspaceState(raw).activeTabId).toBe('d');
  });

  it('writes the arrangement at once: splitting, focusing a pane, moving a tab, the board', () => {
    const start = run(EMPTY_WORKSPACE_STATE, open('a', 1), open('b', 2));
    const shape = workspaceShape(start);
    const split = workspaceReducer(start, { type: 'browse_split', on: true });
    expect(workspaceShape(split)).not.toBe(shape);
    expect(workspaceShape(workspaceReducer(start, { type: 'browse_mode', mode: 'board' }))).not.toBe(shape);
    expect(workspaceShape(workspaceReducer(start, { type: 'browse_move_tab', id: 'a', pane: 1 }))).not.toBe(shape);
    const four = splitFour();
    expect(workspaceShape(workspaceReducer(four, { type: 'browse_focus', pane: 0 }))).not.toBe(workspaceShape(four));
  });
});
