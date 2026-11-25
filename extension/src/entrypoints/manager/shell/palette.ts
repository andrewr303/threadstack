// The session palette's rules (⌘K): which sessions a query and a filter leave, in which order,
// what each filter chip counts, and whether the query is an address. Pure functions, so the
// rules are tested without a page; SessionPalette.tsx draws them.
import { getDisplayTitle, type ConversationRecord } from '../../../core/schema.js';
import { agentStateNeedsYou, type AgentState } from '../../../core/workspace/types.js';
import { resolveAddress, splitAddress } from '../browse/address.js';
import { sessionGroupOf, type SessionGroup } from '../workspace/state.js';

export type PaletteFilter = 'all' | 'needs' | 'running' | 'coding' | 'chats';

/** The chips, in order. `run` chips filter by run state, `type` chips by kind of session. */
export const PALETTE_FILTERS: ReadonlyArray<{ id: PaletteFilter; label: string; family: 'all' | 'run' | 'type' }> = [
  { id: 'all', label: 'All', family: 'all' },
  { id: 'needs', label: 'Needs you', family: 'run' },
  { id: 'running', label: 'Running', family: 'run' },
  { id: 'coding', label: 'Coding agents', family: 'type' },
  { id: 'chats', label: 'Chats', family: 'type' },
];

/** Most result rows drawn at once; the footer says when more matched. */
export const PALETTE_RENDER_LIMIT = 100;

/** 0 needs the person, 1 is running, 2 is everything else (idle). Results sort by it. */
export type PaletteRank = 0 | 1 | 2;

export interface PaletteSession {
  conversation: ConversationRecord;
  title: string;
  group: SessionGroup;
  /** The run state the palette shows; null when nothing was observed (shown as Idle). */
  run: AgentState | null;
  rank: PaletteRank;
}

/** Sessions the palette lists: no synthetic benchmark records, no archived threads (as the rail). */
export function paletteEligible(conv: ConversationRecord): boolean {
  return !conv.isSyntheticBenchmark && conv.workflowState !== 'archived';
}

/**
 * The run state to show for a session. A page open in the workspace reports its state live, and
 * that wins over the stored one. Only coding agents have runs (as in the rail and the tabs).
 */
export function paletteRunState(conv: ConversationRecord, live?: AgentState | null): AgentState | null {
  if (sessionGroupOf(conv.provider) !== 'coding') return null;
  const state = live ?? conv.agentState ?? null;
  return state && state !== 'unknown' ? state : null;
}

export function paletteRank(run: AgentState | null): PaletteRank {
  if (agentStateNeedsYou(run)) return 0;
  return run === 'running' ? 1 : 2;
}

export function toPaletteSession(conv: ConversationRecord, live?: AgentState | null): PaletteSession {
  const run = paletteRunState(conv, live);
  return {
    conversation: conv,
    title: getDisplayTitle(conv) || 'Untitled session',
    group: sessionGroupOf(conv.provider),
    run,
    rank: paletteRank(run),
  };
}

export function matchesPaletteFilter(session: PaletteSession, filter: PaletteFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'needs':
      return session.rank === 0;
    case 'running':
      return session.rank === 1;
    case 'coding':
      return session.group === 'coding';
    case 'chats':
      return session.group === 'chats';
  }
}

/** How many of `sessions` each chip would leave (the counts are of the current query's matches). */
export function paletteCounts(sessions: readonly PaletteSession[]): Record<PaletteFilter, number> {
  const counts: Record<PaletteFilter, number> = { all: 0, needs: 0, running: 0, coding: 0, chats: 0 };
  for (const s of sessions) {
    for (const { id } of PALETTE_FILTERS) if (matchesPaletteFilter(s, id)) counts[id] += 1;
  }
  return counts;
}

/**
 * The rows a filter leaves, needing the person first, then running, then idle. The sort is
 * stable: within a rank the search's order (relevance, or recency with no query) is kept.
 */
export function filterPalette(sessions: readonly PaletteSession[], filter: PaletteFilter): PaletteSession[] {
  return sessions
    .map((session, index) => ({ session, index }))
    .filter(({ session }) => matchesPaletteFilter(session, filter))
    .sort((a, b) => a.session.rank - b.session.rank || a.index - b.index)
    .map(({ session }) => session);
}

/** Most recently active first; the order with no query. */
export function byRecency(a: ConversationRecord, b: ConversationRecord): number {
  const at = (c: ConversationRecord) => Date.parse(c.updatedAt || c.lastCapturedAt || '') || 0;
  return at(b) - at(a);
}

/**
 * The sessions for a query: the library search's matches in its order, then sessions whose
 * account name matches and the search did not find. An empty query lists every eligible
 * session, most recent first.
 */
export function paletteMatches(input: {
  query: string;
  conversations: readonly ConversationRecord[];
  /** The library search: matching conversations, best first. */
  search?: (query: string) => readonly ConversationRecord[];
  /** The account name a session is shown under, for matching by account. */
  accountLabelOf?: (conv: ConversationRecord) => string | null;
}): ConversationRecord[] {
  const q = input.query.trim().toLowerCase();
  const eligible = input.conversations.filter(paletteEligible);
  if (!q) return eligible.slice().sort(byRecency);
  const allowed = new Set(eligible.map((c) => c.threadKey));
  const found = input.search
    ? input.search(input.query.trim())
    : eligible.filter((c) => (getDisplayTitle(c) || '').toLowerCase().includes(q));
  const out: ConversationRecord[] = [];
  const seen = new Set<string>();
  for (const c of found) {
    if (!allowed.has(c.threadKey) || seen.has(c.threadKey)) continue;
    seen.add(c.threadKey);
    out.push(c);
  }
  if (input.accountLabelOf) {
    for (const c of eligible) {
      if (seen.has(c.threadKey)) continue;
      const label = input.accountLabelOf(c);
      if (label && label.toLowerCase().includes(q)) {
        seen.add(c.threadKey);
        out.push(c);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Addresses
// ---------------------------------------------------------------------------------------------

const HOSTLIKE = /^(?:https?:\/\/)?(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d{1,5})?(?:[/?#]\S*)?$/i;

/** "claude.ai/code" and "https://chatgpt.com" are addresses; "v1.2", "fix the build" are not. */
export function looksLikeAddress(query: string): boolean {
  const text = query.trim();
  if (!text || /\s/.test(text)) return false;
  return HOSTLIKE.test(text);
}

export type PaletteAddress =
  /** An AI site ThreadStack shows: opens as a tab in Browse. */
  | { kind: 'open'; url: string; host: string; path: string }
  /** A web page ThreadStack cannot show: offered as a Chrome tab. */
  | { kind: 'chrome'; url: string; host: string; path: string; message: string };

/**
 * The address result for a query, through the same rules as the Browse address field
 * (browse/address.ts). Not being typed into a tab, an address of a known site always opens as
 * a new tab, never navigates one.
 */
export function paletteAddress(query: string): PaletteAddress | null {
  if (!looksLikeAddress(query)) return null;
  const outcome = resolveAddress(query, { realm: '', url: '' });
  if (outcome.kind === 'open' || outcome.kind === 'navigate') {
    const { host, rest } = splitAddress(outcome.url);
    return { kind: 'open', url: outcome.url, host, path: rest };
  }
  if (outcome.kind === 'refuse' && outcome.chromeUrl) {
    const { host, rest } = splitAddress(outcome.chromeUrl);
    return { kind: 'chrome', url: outcome.chromeUrl, host, path: rest, message: outcome.message };
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------------------------

/** ↑/↓: one row at a time, stopping at either end (no wrap). -1 when there are no rows. */
export function moveSelection(index: number, delta: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(length - 1, (index < 0 ? 0 : index) + delta));
}

/** Keep a selection inside the rows after they change (the query or the filter). */
export function clampSelection(index: number, length: number): number {
  if (length <= 0) return -1;
  return Math.max(0, Math.min(length - 1, index));
}
