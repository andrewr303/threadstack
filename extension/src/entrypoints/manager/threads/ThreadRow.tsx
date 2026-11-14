import React from 'react';
import type { ThreadInsight } from '../../../core/schema.js';
import type { SearchHit } from '../../../core/search.js';
import { getSmartTitle } from '../../../core/insights.js';
import { providerLabel } from '../../../core/providers.js';
import { CoverageTick, KindLabel, StatusPill, relativeTime } from '../shared.js';
import { RowCheck } from '../BulkActions.js';
import { AccountChip, RunState } from '../shell/primitives.js';
import { useOptionalWorkspaceContext } from '../workspace/context.js';
import { isCodingProvider } from './grouping.js';

export interface ThreadRowProps {
  hit: SearchHit;
  /** Opened in the detail pane. */
  selected: boolean;
  /** Ticked for a bulk action; independent of `selected`. */
  checked: boolean;
  insight: ThreadInsight | null;
  /** Set while a resurfacing queue is chosen: its reason replaces the excerpt. */
  queueInfo: { resurfaceReason: string } | undefined;
  /** A search is active, so the matching excerpt and reason are shown. */
  searching: boolean;
  whereYouLeftOff: string | null | undefined;
  onToggleChecked: (threadKey: string, checked: boolean, extendRange: boolean) => void;
  onSelect: (threadKey: string) => void;
  /** Lets the owner focus a row from the keyboard. */
  registerRow: (threadKey: string, el: HTMLButtonElement) => void;
  /** Full page: the repository this thread is grouped under, when it has one. */
  repository?: string | null;
}

export function ThreadRow({
  hit,
  selected,
  checked,
  insight,
  queueInfo,
  searching,
  whereYouLeftOff,
  onToggleChecked,
  onSelect,
  registerRow,
  repository,
}: ThreadRowProps) {
  const c = hit.conversation;
  const ws = useOptionalWorkspaceContext();
  // The workspace facts (account, run state, repository) are for the full page only.
  const onPage = ws?.surface === 'page';
  const owner = onPage ? ws.accountOfThread(c) : null;
  const ownerRealm = owner?.realm ? ws!.workspace.realms.find((r) => r.realm.id === owner.realm!.id) : null;
  const showAccount = Boolean(owner?.account && ((ownerRealm?.accounts.length ?? 0) > 1 || !owner.active));
  const showRun = onPage && isCodingProvider(c.provider) && Boolean(c.agentState) && c.agentState !== 'unknown';
  const secondLine = queueInfo ? queueInfo.resurfaceReason : searching ? hit.supportingExcerpt : whereYouLeftOff ?? hit.supportingExcerpt;
  return (
    <li className="tk-row-item" data-checked={checked}>
      <RowCheck threadKey={c.threadKey} title={getSmartTitle(c, insight)} checked={checked} onToggle={onToggleChecked} />
      <button
        ref={(el) => {
          if (el) registerRow(c.threadKey, el);
        }}
        type="button"
        className="tk-row-btn"
        aria-selected={selected}
        onClick={() => onSelect(c.threadKey)}
      >
        <div className="tk-row-main">
          <div className="tk-row-title">{getSmartTitle(c, insight)}</div>
          {insight?.gist && insight.gist !== getSmartTitle(c, insight) && <div className="tk-row-gist">{insight.gist}</div>}
          {secondLine && secondLine !== insight?.gist && <div className="tk-row-excerpt">{secondLine}</div>}
          <div className="tk-row-meta">
            {insight && <KindLabel kind={insight.kind} />}
            {insight?.topics.slice(0, 3).map((t) => (
              <span key={t} className="tk-chip tk-chip-small">
                {t}
              </span>
            ))}
            <span>
              {c.project}
              {c.categoryLocked ? ' (locked)' : ''}
            </span>
            <span>·</span>
            <span>{providerLabel(c.provider)}</span>
            {showAccount && (
              <>
                <span aria-hidden="true">·</span>
                <AccountChip account={owner!.account} active={owner!.active} />
              </>
            )}
            {showRun && (
              <>
                <span aria-hidden="true">·</span>
                <RunState state={c.agentState} observedAt={c.agentStateAt} />
              </>
            )}
            {onPage && repository && (
              <>
                <span aria-hidden="true">·</span>
                <span className="tk-thr-mono tk-ellipsis" title={repository}>
                  {repository}
                </span>
              </>
            )}
            {c.messageCount > 0 && (
              <>
                <span>·</span>
                <span className="tk-tabular">{c.messageCount} msgs</span>
              </>
            )}
            {c.branchId !== 'main' && (
              <>
                <span>·</span>
                <span>branch: {c.branchId}</span>
              </>
            )}
            {searching && hit.matchReasons[0] && (
              <>
                <span>·</span>
                <span>{hit.matchReasons[0]}</span>
              </>
            )}
          </div>
        </div>
        <div className="tk-row-right">
          <span className="tk-tabular" title={c.updatedAt ?? undefined}>
            {relativeTime(c.updatedAt ?? c.lastCapturedAt)}
          </span>
          <CoverageTick coverage={c.coverage} />
          <StatusPill state={c.workflowState} />
          {insight?.source === 'ai' && (
            <span className="tk-ai-mark" title={`Analyzed by ${insight.model}`}>
              AI
            </span>
          )}
        </div>
      </button>
    </li>
  );
}
