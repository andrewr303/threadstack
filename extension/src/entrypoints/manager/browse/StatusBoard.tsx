// The status board: Browse's other mode. The library's sessions in three columns by what their
// page last showed: waiting on the person, running, or idle. Run states are the ones observed
// (the live page of an open tab first, else what was recorded with the thread); nothing here
// guesses a state or changes one. A card opens its session in Browse.
import React, { useMemo, useState } from 'react';
import { getDisplayTitle, type ConversationRecord } from '../../../core/schema.js';
import { AGENT_STATE_LABELS, agentStateNeedsYou, type AgentState } from '../../../core/workspace/types.js';
import { railEligibleSessions } from '../shell/SessionsNav.js';
import { AccountChip, ProviderMark, providerName } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { selfConversation, sortLens } from '../workspace/lens.js';
import { SESSION_GROUP_LABELS, sessionGroupOf } from '../workspace/state.js';
import { relativeTime } from './format.js';

/** Which sessions the board shows: every kind, or only coding agents or chats. */
export type BoardGroup = 'all' | 'coding' | 'chats';

export type BoardColumnId = 'needs' | 'running' | 'idle';

/** Most cards a column lists; the rest are in Threads ("Show all"). */
export const BOARD_COLUMN_LIMIT = 40;

const GROUPS: ReadonlyArray<{ id: BoardGroup; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'coding', label: 'Coding agents' },
  { id: 'chats', label: 'Chats' },
];

const COLUMNS: ReadonlyArray<{ id: BoardColumnId; label: string }> = [
  { id: 'needs', label: 'Needs you' },
  { id: 'running', label: 'Running' },
  { id: 'idle', label: 'Idle' },
];

/** The column a run state belongs in. No state, or one that asks nothing, is idle. */
export function boardColumnOf(state: AgentState | null | undefined): BoardColumnId {
  if (agentStateNeedsYou(state)) return 'needs';
  if (state === 'running') return 'running';
  return 'idle';
}

export interface BoardCard {
  conv: ConversationRecord;
  state: AgentState | null;
  /** The session has an open Browse tab. */
  open: boolean;
}

/**
 * The board's columns, newest first in each. Only coding agents report run states; other
 * sessions are idle unless their open page reports one. `liveState` is what an open tab's page
 * reports right now (null when it reported nothing).
 */
export function buildBoard(
  conversations: readonly ConversationRecord[],
  group: BoardGroup,
  openTabs: ReadonlyMap<string, string>,
  liveState: (tabId: string) => AgentState | null
): { total: number; columns: Record<BoardColumnId, BoardCard[]> } {
  const eligible = railEligibleSessions(conversations).filter((conv) => group === 'all' || sessionGroupOf(conv.provider) === group);
  const columns: Record<BoardColumnId, BoardCard[]> = { needs: [], running: [], idle: [] };
  for (const conv of sortLens(eligible, 'recent', selfConversation)) {
    const tabId = openTabs.get(conv.threadKey) ?? null;
    const live = tabId ? liveState(tabId) : null;
    const recorded = sessionGroupOf(conv.provider) === 'coding' ? conv.agentState ?? null : null;
    const state = live ?? recorded;
    columns[boardColumnOf(state)].push({ conv, state, open: tabId !== null });
  }
  return { total: eligible.length, columns };
}

export function StatusBoard({ onShowTabs }: { onShowTabs: () => void }) {
  const { workspace, conversations, accountOfThread, openSession, showInThreads, setView } = useWorkspaceContext();
  const [group, setGroup] = useState<BoardGroup>('all');
  const tabs = workspace.state.tabs;

  // Thread key -> the Browse tab showing it.
  const openTabs = useMemo(() => {
    const map = new Map<string, string>();
    for (const tab of tabs) {
      if (tab.threadKey && !map.has(tab.threadKey)) map.set(tab.threadKey, tab.id);
      if (tab.id.startsWith('thread~')) map.set(tab.id.slice('thread~'.length), tab.id);
    }
    return map;
  }, [tabs]);

  const board = useMemo(
    () => buildBoard(conversations, group, openTabs, (tabId) => {
      const live = workspace.runtime(tabId).agentState;
      return live && live !== 'unknown' ? live : null;
    }),
    [conversations, group, openTabs, workspace]
  );

  const showAll = () => {
    if (showInThreads) showInThreads(group === 'all' ? { by: 'none', key: null } : { by: 'kind', key: group });
    else setView('threads');
  };

  return (
    <div className="tk-board" aria-label="Status board">
      <header className="tk-board-head tk-glass">
        <h1 className="tk-board-title">Sessions</h1>
        <div className="tk-board-groups" role="radiogroup" aria-label="Show">
          {GROUPS.map((option) => (
            <button
              key={option.id}
              type="button"
              role="radio"
              aria-checked={group === option.id}
              className="tk-board-group"
              onClick={() => setGroup(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <span className="tk-board-spacer" />
        <button type="button" className="tk-board-showall" onClick={showAll}>
          Show all {board.total.toLocaleString()}
        </button>
        <button type="button" className="tk-btn tk-board-tabs-btn" onClick={onShowTabs}>
          Open tabs
          <span className="tk-board-count">{tabs.length}</span>
        </button>
      </header>
      <div className="tk-board-cols">
        {COLUMNS.map((column) => {
          const cards = board.columns[column.id];
          const shown = cards.slice(0, BOARD_COLUMN_LIMIT);
          const headingId = `tk-board-col-${column.id}`;
          return (
            <section key={column.id} className="tk-board-col tk-glass" data-column={column.id} aria-labelledby={headingId}>
              <div className="tk-board-col-head">
                <span className="tk-board-col-dot" aria-hidden="true" />
                <h2 id={headingId} className="tk-board-col-title">{column.label}</h2>
                <span className="tk-board-col-count">{cards.length.toLocaleString()}</span>
              </div>
              <div className="tk-board-col-body">
                {shown.length === 0 ? (
                  <p className="tk-board-empty">Nothing here.</p>
                ) : (
                  <ul className="tk-board-list">
                    {shown.map((card) => (
                      <li key={card.conv.threadKey}>
                        <Card card={card} accountOfThread={accountOfThread} onOpen={(conv) => openSession(conv, 'browse')} />
                      </li>
                    ))}
                  </ul>
                )}
                {cards.length > shown.length && (
                  <p className="tk-board-more">
                    {(cards.length - shown.length).toLocaleString()} more in Threads
                  </p>
                )}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}

function Card({
  card,
  accountOfThread,
  onOpen,
}: {
  card: BoardCard;
  accountOfThread: ReturnType<typeof useWorkspaceContext>['accountOfThread'];
  onOpen: (conv: ConversationRecord) => void;
}) {
  const { conv, state, open } = card;
  const title = getDisplayTitle(conv) || 'Untitled session';
  const owner = accountOfThread(conv);
  const needs = agentStateNeedsYou(state);
  // The same activity time the board is ordered by (the session's own update, else its capture).
  const when = relativeTime(conv.updatedAt ?? conv.lastCapturedAt);
  const action = state === 'waiting_answer' ? 'Answer' : 'Open';
  return (
    <article className="tk-board-card" data-open={open ? 'true' : undefined} data-needs-you={needs ? 'true' : undefined}>
      <button type="button" className="tk-board-card-main" title={`Open ${title}`} onClick={() => onOpen(conv)}>
        <ProviderMark provider={conv.provider} />
        <span className="tk-board-card-title">{title}</span>
        <span className="tk-visually-hidden">, {providerName(conv.provider)}{open ? ', open in a tab' : ''}</span>
      </button>
      <div className="tk-board-card-meta">
        {owner.realm && owner.account && <AccountChip account={owner.account} active={owner.active} />}
        <span>
          {SESSION_GROUP_LABELS[sessionGroupOf(conv.provider)]}
          {when ? ` · ${when}` : ''}
        </span>
      </div>
      {needs && state && (
        <div className="tk-board-card-needs">
          <span className="tk-board-card-run">{AGENT_STATE_LABELS[state]}</span>
          {/* No Approve: the extension has no action that answers a permission prompt for the
              person, so the card only opens the session where they can answer it themselves. */}
          <button type="button" className="tk-btn tk-board-card-open" aria-label={`${action}: ${title}`} onClick={() => onOpen(conv)}>
            {action}
          </button>
        </div>
      )}
    </article>
  );
}
