// The panel beside a Browse page: what ThreadStack knows about the session in the tab. It is an
// opaque reading surface; the page keeps its place and only this panel animates in.
import React, { useState } from 'react';
import { providerCategory } from '../../../core/providers.js';
import type { AgentRunFacts, ConversationRecord, StructuredSummaryRecord, ThreadInsight } from '../../../core/schema.js';
import type { SessionTab } from '../../../core/workspace/types.js';
import { Icon } from '../shell/icons.js';
import { AccountChip, ProviderMark, RunState, providerName } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { pullRequestLabel, relativeTime } from './format.js';

const MAX_LISTED = 8;

const TEST_WORDS: Record<AgentRunFacts['tests']['status'], string> = {
  passing: 'Passing',
  failing: 'Failing',
  not_run: 'Not run',
  unknown: 'Not known',
};

const BLOCKED_WORDS: Record<AgentRunFacts['blockedOn'], string> = {
  none: 'Nothing',
  permission: 'Your approval',
  input: 'Your answer',
  ci: 'A CI run',
  external: 'Something outside the session',
};

const COMMAND_WORDS: Record<AgentRunFacts['commandsRun'][number]['outcome'], { word: string; state: string }> = {
  ok: { word: 'Succeeded', state: 'turn_complete' },
  failed: { word: 'Failed', state: 'failed' },
  unknown: { word: 'Outcome not seen', state: 'idle' },
};

function AgentRun({ run, id }: { run: AgentRunFacts; id: string }) {
  const files = run.filesChanged.slice(0, MAX_LISTED);
  const commands = run.commandsRun.slice(0, MAX_LISTED);
  return (
    <section className="tk-browse-sum-section tk-browse-run" aria-labelledby={`${id}-run`}>
      <h3 className="tk-eyebrow" id={`${id}-run`}>Agent run</h3>
      <dl className="tk-browse-run-grid">
        <dt>Files changed</dt>
        <dd>
          {files.length === 0 ? (
            <span className="tk-muted">None recorded</span>
          ) : (
            <ul className="tk-browse-run-list">
              {files.map((file) => (
                <li key={file}>
                  <span className="tk-browse-run-path tk-ellipsis" title={file}>{file}</span>
                </li>
              ))}
              {run.filesChanged.length > files.length && (
                <li className="tk-muted">and {run.filesChanged.length - files.length} more</li>
              )}
            </ul>
          )}
        </dd>
        <dt>Commands</dt>
        <dd>
          {commands.length === 0 ? (
            <span className="tk-muted">None recorded</span>
          ) : (
            <ul className="tk-browse-run-list">
              {commands.map((entry, index) => {
                const outcome = COMMAND_WORDS[entry.outcome];
                return (
                  <li key={`${index}-${entry.command}`}>
                    <span className="tk-browse-run-path tk-ellipsis" title={entry.command}>{entry.command}</span>
                    <span className="tk-run" data-state={outcome.state} data-needs-you={entry.outcome === 'failed' ? 'true' : 'false'}>
                      <span className="tk-run-dot" aria-hidden="true" />
                      <span className="tk-run-label">{outcome.word}</span>
                    </span>
                  </li>
                );
              })}
              {run.commandsRun.length > commands.length && (
                <li className="tk-muted">and {run.commandsRun.length - commands.length} more</li>
              )}
            </ul>
          )}
        </dd>
        <dt>Tests</dt>
        <dd>
          {TEST_WORDS[run.tests.status]}
          {run.tests.detail ? <span className="tk-muted">. {run.tests.detail}</span> : null}
        </dd>
        <dt>Waiting on</dt>
        <dd>{BLOCKED_WORDS[run.blockedOn]}</dd>
      </dl>
    </section>
  );
}

function MetaLine({ conv, tab }: { conv: ConversationRecord; tab: SessionTab }) {
  const { accountOfThread, workspace } = useWorkspaceContext();
  const { account, active } = accountOfThread(conv);
  const coding = providerCategory(conv.provider) === 'coding_agent';
  const state = coding ? (workspace.runtime(tab.id).agentState ?? conv.agentState ?? null) : null;
  const observed = relativeTime(conv.agentStateAt);
  return (
    <p className="tk-browse-sum-meta">
      <span className="tk-browse-sum-meta-item">
        <ProviderMark provider={conv.provider} size="sm" />
        <span>{providerName(conv.provider)}</span>
      </span>
      <AccountChip account={account} active={active} />
      {conv.repository && (
        <span className="tk-browse-sum-meta-item">
          <Icon name="repo" size={14} />
          <span className="tk-ellipsis">{conv.repository}</span>
        </span>
      )}
      {conv.gitBranch && (
        <span className="tk-browse-sum-meta-item">
          <Icon name="branch" size={14} />
          <span className="tk-ellipsis">{conv.gitBranch}</span>
        </span>
      )}
      {conv.pullRequestUrl && (
        <a className="tk-browse-sum-meta-item tk-browse-sum-link" href={conv.pullRequestUrl} target="_blank" rel="noopener noreferrer">
          <Icon name="pullRequest" size={14} />
          <span>Pull request {pullRequestLabel(conv.pullRequestUrl)}</span>
        </a>
      )}
      {state && state !== 'unknown' && (
        <span className="tk-browse-sum-meta-item">
          <RunState state={state} observedAt={conv.agentStateAt} />
          <span className="tk-muted">{observed ? `Observed ${observed}` : 'As last read from the page'}</span>
        </span>
      )}
    </p>
  );
}

function SavedSummary({
  conv,
  tab,
  summary,
  insight,
  id,
}: {
  conv: ConversationRecord;
  tab: SessionTab;
  summary: StructuredSummaryRecord | undefined;
  insight: ThreadInsight | undefined;
  id: string;
}) {
  const gist = insight?.gist?.trim() || summary?.currentStatus?.trim() || '';
  const leftOff = summary?.whereYouLeftOff?.trim() || '';
  const nextStep = summary?.nextStep?.trim() || conv.nextStepText?.trim() || '';
  const captured = relativeTime(conv.lastCapturedAt);
  return (
    <>
      <h3 className="tk-browse-sum-title">{conv.manualTitleOverride || conv.title}</h3>
      <MetaLine conv={conv} tab={tab} />
      {gist && (
        <section className="tk-browse-sum-section" aria-labelledby={`${id}-gist`}>
          <h3 className="tk-eyebrow" id={`${id}-gist`}>What this is about</h3>
          <p className="tk-browse-sum-gist">{gist}</p>
        </section>
      )}
      {leftOff || nextStep ? (
        <section className="tk-browse-leftoff" aria-labelledby={`${id}-left`}>
          <div className="tk-browse-leftoff-head">
            <h3 className="tk-eyebrow" id={`${id}-left`}>Where you left off</h3>
            {captured && <span className="tk-browse-leftoff-time">Captured {captured}</span>}
          </div>
          {leftOff && <p className="tk-browse-leftoff-line">{leftOff}</p>}
          {nextStep && (
            <p className="tk-browse-leftoff-next">
              <b>Next step</b>
              <span>{nextStep}</span>
            </p>
          )}
        </section>
      ) : (
        !gist && <p className="tk-muted">No summary has been written for this session yet.</p>
      )}
      {insight?.agentRun && <AgentRun run={insight.agentRun} id={id} />}
    </>
  );
}

export function SummaryPanel({
  id,
  tab,
  onClose,
}: {
  id: string;
  tab: SessionTab;
  onClose: () => void;
}) {
  const { conversationByKey, insightsByThread, summariesByThread, openSession, togglePinned, announce } = useWorkspaceContext();
  const conv = tab.threadKey ? conversationByKey.get(tab.threadKey) : undefined;
  const [busy, setBusy] = useState(false);

  const pin = async () => {
    if (!conv || busy) return;
    const wasPinned = conv.pinned;
    setBusy(true);
    try {
      await togglePinned(conv);
      announce(wasPinned ? 'Unpinned from the dashboard' : 'Pinned to the dashboard');
    } finally {
      setBusy(false);
    }
  };

  return (
    <aside
      id={id}
      className="tk-browse-summary"
      aria-label="Session summary"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        event.stopPropagation();
        onClose();
      }}
    >
      <header className="tk-browse-summary-head">
        <h2>Summary</h2>
        <button type="button" className="tk-icon-btn" aria-label="Close summary" title="Close summary" onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>
      <div className="tk-browse-summary-body">
        {conv ? (
          <SavedSummary
            conv={conv}
            tab={tab}
            summary={summariesByThread.get(conv.threadKey)}
            insight={insightsByThread.get(conv.threadKey)}
            id={id}
          />
        ) : (
          <>
            <h3 className="tk-browse-sum-title">{tab.title || 'This session'}</h3>
            <section className="tk-browse-sum-section" aria-labelledby={`${id}-unsaved`}>
              <h3 className="tk-eyebrow" id={`${id}-unsaved`}>Not saved yet</h3>
              <p className="tk-browse-sum-gist">
                ThreadStack saves this session by itself once the page shows a conversation. Nothing needs to be saved by hand.
              </p>
            </section>
          </>
        )}
      </div>
      {conv && (
        <footer className="tk-browse-summary-foot">
          <button type="button" className="tk-btn tk-btn-primary" onClick={() => openSession(conv, 'threads')}>
            <Icon name="threads" />
            Open in Threads
          </button>
          <button type="button" className="tk-btn" disabled={busy} onClick={pin}>
            <Icon name={conv.pinned ? 'unpin' : 'pin'} />
            {conv.pinned ? 'Unpin from dashboard' : 'Pin to dashboard'}
          </button>
        </footer>
      )}
    </aside>
  );
}
