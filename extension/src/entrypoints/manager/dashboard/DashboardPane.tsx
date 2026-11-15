// One pane of the Dashboard: a slim header (who, which account, what the page showed last, and
// three actions) over a slot where the session's page appears.
import React from 'react';
import type { ConversationRecord } from '../../../core/schema.js';
import { AGENT_STATE_LABELS } from '../../../core/workspace/types.js';
import { Icon } from '../shell/icons.js';
import { AccountChip, Notice, onMenuKeyDown, ProviderMark, RunState, usePopover } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { FrameSlot } from '../workspace/FrameStage.js';
import { RestingPage } from '../workspace/RestingPage.js';
import { threadTabId } from '../workspace/state.js';
import { hasWebPage, sessionTitle } from './shared.js';

export interface DashboardPaneProps {
  index: number;
  conv: ConversationRecord | null;
  focused: boolean;
  pinned: readonly ConversationRecord[];
  /** Thread keys shown in the panes right now, by pane. */
  placed: ReadonlyArray<string | null>;
  /** Pinned sessions with a page that the Dashboard's filters hide from `pinned`. */
  hiddenByFilters?: number;
  onClearFilters?: () => void;
  onFocus: (index: number) => void;
  onPlace: (index: number, conv: ConversationRecord) => void;
  onSwap: (index: number, conv: ConversationRecord) => void;
}

export function DashboardPane({ index, conv, focused, pinned, placed, hiddenByFilters = 0, onClearFilters, onFocus, onPlace, onSwap }: DashboardPaneProps) {
  const ctx = useWorkspaceContext();
  const number = index + 1;
  const headFocus = (
    <button
      type="button"
      className="tk-dash-focus"
      data-pane-focus={index}
      aria-pressed={focused}
      onClick={() => onFocus(index)}
    >
      {conv ? <ProviderMark provider={conv.provider} /> : null}
      <span className="tk-dash-title tk-ellipsis">{conv ? sessionTitle(conv) : `Pane ${number}`}</span>
    </button>
  );

  if (!conv) {
    const spare = pinned.filter((c) => !placed.includes(c.threadKey) && hasWebPage(c));
    return (
      <section className="tk-dash-pane" data-focused={focused} aria-label={`Pane ${number}: empty`} aria-current={focused ? 'true' : undefined} onFocusCapture={() => onFocus(index)}>
        <div className="tk-dash-head">{headFocus}</div>
        <div className="tk-dash-empty">
          <Notice
            title="Nothing in this pane"
            actions={
              spare.length > 0 ? (
                <>
                  {spare.map((c) => (
                    <button key={c.threadKey} type="button" className="tk-btn" onClick={() => onPlace(index, c)}>
                      <ProviderMark provider={c.provider} size="sm" />
                      <span className="tk-ellipsis">{sessionTitle(c)}</span>
                    </button>
                  ))}
                </>
              ) : hiddenByFilters > 0 && onClearFilters ? (
                <button type="button" className="tk-btn" onClick={onClearFilters}>
                  Clear filters
                </button>
              ) : undefined
            }
          >
            {spare.length > 0 ? (
              <p>Choose a pinned session to show it here.</p>
            ) : hiddenByFilters > 0 ? (
              <p>
                {hiddenByFilters === 1 ? 'One more pinned session is' : `${hiddenByFilters} more pinned sessions are`} hidden by the
                Dashboard filters.
              </p>
            ) : (
              <p>Every pinned session is already in a pane.</p>
            )}
          </Notice>
        </div>
      </section>
    );
  }

  const title = sessionTitle(conv);
  const tabId = threadTabId(conv.threadKey);
  const tab = ctx.workspace.state.tabs.find((t) => t.id === tabId) ?? null;
  const owner = ctx.accountOfThread(conv);
  return (
    <section className="tk-dash-pane" data-focused={focused} aria-label={`Pane ${number}: ${title}`} aria-current={focused ? 'true' : undefined} onFocusCapture={() => onFocus(index)}>
      <div className="tk-dash-head" onPointerDown={() => onFocus(index)}>
        {headFocus}
        <span className="tk-dash-meta">
          <AccountChip account={owner.account} active={owner.active} />
          <RunState state={conv.agentState} observedAt={conv.agentStateAt} />
        </span>
        <span className="tk-dash-acts">
          <SwapMenu index={index} conv={conv} pinned={pinned} placed={placed} onSwap={onSwap} />
          <button
            type="button"
            className="tk-icon-btn"
            aria-label={`Unpin ${title} from dashboard`}
            title="Unpin from dashboard"
            onClick={() => void ctx.togglePinned(conv)}
          >
            <Icon name="unpin" />
          </button>
          <button
            type="button"
            className="tk-icon-btn"
            aria-label={`Open ${title} in Browse`}
            title="Open in Browse"
            onClick={() => ctx.openSession(conv, 'browse')}
          >
            <Icon name="browse" />
          </button>
        </span>
      </div>
      <FrameSlot tabId={tabId} className="tk-dash-body">
        {tab ? <RestingPage tab={tab} noun="pane" /> : <Notice title="Opening this session">The page appears here in a moment.</Notice>}
      </FrameSlot>
    </section>
  );
}

function SwapMenu({
  index,
  conv,
  pinned,
  placed,
  onSwap,
}: {
  index: number;
  conv: ConversationRecord;
  pinned: readonly ConversationRecord[];
  placed: ReadonlyArray<string | null>;
  onSwap: (index: number, conv: ConversationRecord) => void;
}) {
  const pop = usePopover();
  const others = pinned.filter((c) => c.threadKey !== conv.threadKey);
  const ctx = useWorkspaceContext();
  return (
    <span className="tk-dash-swap">
      <button
        type="button"
        className="tk-icon-btn"
        {...pop.triggerProps}
        aria-label={`Swap session in pane ${index + 1}`}
        title="Swap session"
      >
        <Icon name="swap" />
      </button>
      {pop.open && (
        <div {...pop.menuProps} className="tk-pop tk-dash-menu" aria-label={`Show in pane ${index + 1}`} onKeyDown={onMenuKeyDown}>
          {others.length === 0 ? (
            <p className="tk-dash-menu-note tk-muted">No other pinned sessions. Pin one from Threads.</p>
          ) : (
            others.map((c) => {
              const at = placed.indexOf(c.threadKey);
              const acct = ctx.accountOfThread(c);
              const state = c.agentState && c.agentState !== 'unknown' ? ` · ${AGENT_STATE_LABELS[c.agentState]}` : '';
              return (
                <button
                  key={c.threadKey}
                  type="button"
                  role="menuitem"
                  className="tk-pop-item tk-dash-menu-item"
                  disabled={!hasWebPage(c)}
                  onClick={() => {
                    pop.setOpen(false);
                    onSwap(index, c);
                  }}
                >
                  <ProviderMark provider={c.provider} size="sm" />
                  <span className="tk-dash-menu-text">
                    <span className="tk-ellipsis">{sessionTitle(c)}</span>
                    <span className="tk-dash-menu-sub tk-muted tk-ellipsis">{(acct.account?.label ?? 'Removed account') + state}</span>
                  </span>
                  {at >= 0 && <span className="tk-dash-menu-right tk-muted">Pane {at + 1}</span>}
                </button>
              );
            })
          )}
        </div>
      )}
    </span>
  );
}
