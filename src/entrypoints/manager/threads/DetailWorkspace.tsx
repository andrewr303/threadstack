// What the detail pane adds on the full page: the workspace facts of a thread in its header, the
// pin and "Open in Browse" actions, the Summary / Live / Split switch and the live page itself.
// The side panel and the overlay never render any of it.
import React from 'react';
import type { ConversationRecord, DetailMode } from '../../../core/schema.js';
import { normalizePullRequestUrl, threadRepository } from '../../../core/repository.js';
import { relativeTime } from '../shared.js';
import { Icon } from '../shell/icons.js';
import { AccountChip, RunState, Segmented, type SegmentOption } from '../shell/primitives.js';
import { useWorkspaceContext } from '../workspace/context.js';
import { FrameSlot } from '../workspace/FrameStage.js';
import { RestingPage } from '../workspace/RestingPage.js';
import { embedTargetFor, threadTabId } from '../workspace/state.js';
import { isCodingProvider } from './grouping.js';

const MODE_LABELS: Record<DetailMode, string> = {
  summary: 'Summary',
  live: 'Live',
  split: 'Split',
};

/** Whether the thread has a web page that can be shown inside the workspace. */
export function hasEmbeddablePage(conversation: ConversationRecord): boolean {
  return embedTargetFor(conversation.canonicalUrl) !== null;
}

function pullRequestLabel(url: string): string {
  const number = url.match(/\/(\d+)\/?$/)?.[1];
  return number ? `Pull request #${number}` : 'Pull request';
}

/** Account, repository, branch, pull request and run state, for the meta line of the header. */
export function ThreadFacts({ conversation }: { conversation: ConversationRecord }) {
  const { accountOfThread } = useWorkspaceContext();
  const owner = accountOfThread(conversation);
  const repository = threadRepository(conversation, isCodingProvider);
  const pullRequest = normalizePullRequestUrl(conversation.pullRequestUrl ?? null);
  const showRun = isCodingProvider(conversation.provider) && conversation.agentState && conversation.agentState !== 'unknown';
  return (
    <>
      {owner.account && (
        <>
          <span aria-hidden="true">·</span>
          <AccountChip account={owner.account} active={owner.active} />
        </>
      )}
      {repository && (
        <>
          <span aria-hidden="true">·</span>
          <span className="tk-thr-fact">
            <Icon name="repo" size={14} />
            <span className="tk-visually-hidden">Repository </span>
            <span className="tk-thr-mono">{repository}</span>
          </span>
        </>
      )}
      {conversation.gitBranch && (
        <>
          <span aria-hidden="true">·</span>
          <span className="tk-thr-fact">
            <Icon name="branch" size={14} />
            <span className="tk-visually-hidden">Branch </span>
            <span className="tk-thr-mono">{conversation.gitBranch}</span>
          </span>
        </>
      )}
      {pullRequest && (
        <>
          <span aria-hidden="true">·</span>
          <span className="tk-thr-fact">
            <Icon name="pullRequest" size={14} />
            <a href={pullRequest} target="_blank" rel="noreferrer">
              {pullRequestLabel(pullRequest)}
            </a>
          </span>
        </>
      )}
      {showRun && (
        <>
          <span aria-hidden="true">·</span>
          <span className="tk-thr-fact">
            <RunState state={conversation.agentState} observedAt={conversation.agentStateAt} />
            {conversation.agentStateAt && <span className="tk-muted">last read {relativeTime(conversation.agentStateAt)}</span>}
          </span>
        </>
      )}
    </>
  );
}

/** "Pin to dashboard" and, when the session has a page to show, "Open in Browse". */
export function ThreadWorkspaceActions({ conversation }: { conversation: ConversationRecord }) {
  const { togglePinned, openSession } = useWorkspaceContext();
  return (
    <>
      <button type="button" className="tk-btn tk-thr-action" aria-pressed={conversation.pinned} onClick={() => void togglePinned(conversation)}>
        <Icon name={conversation.pinned ? 'unpin' : 'pin'} size={14} />
        {conversation.pinned ? 'Unpin from dashboard' : 'Pin to dashboard'}
      </button>
      {hasEmbeddablePage(conversation) && (
        <button type="button" className="tk-btn tk-thr-action" onClick={() => openSession(conversation, 'browse')}>
          <Icon name="browse" size={14} />
          Open in Browse
        </button>
      )}
    </>
  );
}

/**
 * Summary / Live / Split. A session with no web page (a terminal session, an import) can only be
 * read as a summary, so Live and Split are off and the line below says why.
 */
export function ThreadModeBar({
  conversation,
  onCopyResume,
  resumeShownElsewhere,
}: {
  conversation: ConversationRecord;
  onCopyResume: (command: string) => void;
  /** The header already offers "Copy resume command", so the note does not repeat the button. */
  resumeShownElsewhere: boolean;
}) {
  const { detailMode, setDetailMode, announce } = useWorkspaceContext();
  const embeddable = hasEmbeddablePage(conversation);
  const value: DetailMode = embeddable ? detailMode : 'summary';
  const options: SegmentOption<DetailMode>[] = [
    { value: 'summary', label: MODE_LABELS.summary, icon: 'summary' },
    { value: 'live', label: MODE_LABELS.live, icon: 'live', disabled: !embeddable },
    { value: 'split', label: MODE_LABELS.split, icon: 'split', disabled: !embeddable },
  ];
  return (
    <div className="tk-thr-modebar">
      <Segmented
        label="Thread view"
        value={value}
        options={options}
        onChange={(mode) => {
          setDetailMode(mode);
          announce(mode === 'summary' ? 'Showing the summary.' : mode === 'live' ? 'Showing the live page.' : 'Showing the summary beside the live page.');
        }}
      />
      {!embeddable && (
        <p className="tk-thr-nopage tk-muted">
          This session has no web page, so Live and Split are off.
          {conversation.resumeCommand ? ' Copy its resume command to pick it up in a terminal.' : ''}
          {conversation.resumeCommand && !resumeShownElsewhere && (
            <>
              {' '}
              <button type="button" className="tk-btn" onClick={() => onCopyResume(conversation.resumeCommand!)}>
                Copy resume command
              </button>
            </>
          )}
        </p>
      )}
    </div>
  );
}

/** The thread's real page. Its session tab appears one render after the mode changes. */
export function LivePage({ conversation }: { conversation: ConversationRecord }) {
  const { workspace } = useWorkspaceContext();
  const tabId = threadTabId(conversation.threadKey);
  const tab = workspace.state.tabs.find((t) => t.id === tabId) ?? null;
  return (
    <FrameSlot tabId={tabId} className="tk-thr-live">
      {tab ? (
        <RestingPage tab={tab} noun="page" />
      ) : (
        <p className="tk-thr-loading tk-muted" role="status">
          Opening the live page…
        </p>
      )}
    </FrameSlot>
  );
}
