import React from 'react';
import {
  getDisplayTitle,
  type ConversationRecord,
  type DetailMode,
  type MessageRecord,
  type RelationshipRecord,
  type StructuredSummaryRecord,
  type ThreadInsight,
  type WorkflowState,
} from '../../../core/schema.js';
import { exportThreadToMarkdown } from '../../../core/adapters.js';
import { getSmartTitle } from '../../../core/insights.js';
import { providerLabel } from '../../../core/providers.js';
import { CoverageTick, StatusPill, relativeTime } from '../shared.js';
import { PaperclipLinks } from '../PaperclipLinks.js';
import { SemanticNeighbors, ThreadOverview, type RelatedThread } from '../ThreadOverview.js';
import { InStillBadge } from '../SidebarDock.js';
import { useOptionalWorkspaceContext } from '../workspace/context.js';
import { Icon } from '../shell/icons.js';
import { evidenceLabel, renderClaims, renderEvidencePassage, type EvidenceView } from './claims.js';
import { LivePage, ThreadFacts, ThreadModeBar, ThreadPageNote, ThreadWorkspaceActions, hasEmbeddablePage } from './DetailWorkspace.js';

const TRANSCRIPT_PAGE = 80;

export interface DetailPaneProps {
  /** The open thread; null shows the empty prompt. */
  conversation: ConversationRecord | null;
  insight: ThreadInsight | null;
  summary: StructuredSummaryRecord | null;
  messages: MessageRecord[];
  /** Relationships of the open thread that the user has not dismissed. */
  relationships: RelationshipRecord[];
  semanticNeighbors: RelatedThread[];
  conversations: ConversationRecord[];
  insightsByThread: Map<string, ThreadInsight>;
  projectNames: string[];
  evidence: EvidenceView;
  /** Hosted analysis is offered only with an Anthropic key. */
  aiReady: boolean;
  analyzing: boolean;
  cloudEnabled: boolean;
  stillPaired: boolean;
  /** When Still last received a push; keys the "In Still" badge so it refetches. */
  stillLastPushAt: string | undefined;
  /** False for local-only threads, threads in local-only projects and excluded providers. */
  mayShare: (conversation: ConversationRecord) => boolean;
  /** Narrow screens: the pane is a full-screen page over the list. */
  mobileDetailVisible: boolean;
  titleDraft: string;
  tagInputDraft: string;
  notesDraft: string;
  showAllMessages: boolean;
  onTitleDraftChange: (value: string) => void;
  onTagInputDraftChange: (value: string) => void;
  onNotesDraftChange: (value: string) => void;
  onShowAllMessages: () => void;
  onBackToList: () => void;
  onSelectThread: (threadKey: string) => void;
  onProjectChange: (project: string) => void | Promise<void>;
  onToggleLock: (locked: boolean) => void | Promise<void>;
  onWorkflowStateChange: (state: WorkflowState) => void | Promise<void>;
  onOpenOriginal: () => void;
  onCopy: (text: string, label: string) => void;
  onSendToStill: (threadKeys: string[], label: string) => void;
  onDelete: () => void | Promise<void>;
  onAnalyze: () => void | Promise<void>;
  onSetCloudExcluded: (threadKey: string, excluded: boolean) => void;
  onEnrich: (threadKey: string) => void;
  onSaveManualEdits: () => void | Promise<void>;
}

/** Header actions, summary sections with evidence, relations, manual overrides and the transcript. */
export function DetailPane({
  conversation,
  insight,
  summary,
  messages,
  relationships,
  semanticNeighbors,
  conversations,
  insightsByThread,
  projectNames,
  evidence,
  aiReady,
  analyzing,
  cloudEnabled,
  stillPaired,
  stillLastPushAt,
  mayShare,
  mobileDetailVisible,
  titleDraft,
  tagInputDraft,
  notesDraft,
  showAllMessages,
  onTitleDraftChange,
  onTagInputDraftChange,
  onNotesDraftChange,
  onShowAllMessages,
  onBackToList,
  onSelectThread,
  onProjectChange,
  onToggleLock,
  onWorkflowStateChange,
  onOpenOriginal,
  onCopy,
  onSendToStill,
  onDelete,
  onAnalyze,
  onSetCloudExcluded,
  onEnrich,
  onSaveManualEdits,
}: DetailPaneProps) {
  // The full page adds the workspace facts, the Summary / Live / Split switch and the live page.
  const ws = useOptionalWorkspaceContext();
  const onPage = ws?.surface === 'page';
  const mode: DetailMode = onPage && ws && conversation && hasEmbeddablePage(conversation) ? ws.detailMode : 'summary';

  /** Everything below the header: summary, evidence, relations, overrides and the transcript. */
  const renderBody = (conversation: ConversationRecord) => (
    <>
      <ThreadOverview
        conv={conversation}
        insight={insight}
        summary={summary}
        canAnalyze={aiReady}
        analyzing={analyzing}
        onAnalyze={() => void onAnalyze()}
        onCopy={onCopy}
      />

      {(summary?.keyPoints?.length ?? 0) > 0 && (
        <div className="tk-section" data-evidence-location="key-points">
          <h3 className="tk-section-h2">Key points</h3>
          {renderClaims(evidence, summary?.keyPoints ?? [], 'keypoint', '')}
        </div>
      )}

      {/* FOCAL ELEMENT: Where you left off (Evidence Location #1) */}
      <div className="tk-focal-left-off" data-evidence-location="where-you-left-off">
        <div className="tk-eyebrow" style={{ padding: 0 }}>
          Where you left off
        </div>
        <div className="tk-claim-row" style={{ borderBottom: 0, padding: 0 }}>
          <p className="tk-focal-serif-line">
            {summary?.whereYouLeftOff ??
              conversation.nextStepText ??
              conversation.latestDecisionText ??
              messages[messages.length - 1]?.content.slice(0, 400) ??
              'Title-only capture — open the original conversation or import an export file to read message turns.'}
          </p>
          {messages.length > 0 && (
            <button
              type="button"
              className="tk-evidence-marker"
              aria-expanded={evidence.activeEvidenceId === 'focal-left-off'}
              onClick={() => evidence.onToggle('focal-left-off')}
            >
              <span className="tk-evidence-pip" data-speaker="user_committed" aria-hidden="true" />
              {evidenceLabel(
                summary?.whereYouLeftOffMessageIndexes ?? [Math.max(0, messages.length - 1)]
              )}
            </button>
          )}
        </div>
        {summary?.nextStep ? (
          <p className="tk-focal-next-step">
            <span className="tk-focal-next-label">Next step:</span> {summary.nextStep}
          </p>
        ) : null}
        {renderEvidencePassage(
          evidence,
          'focal-left-off',
          summary?.whereYouLeftOffMessageIndexes ?? [Math.max(0, messages.length - 1)]
        )}
      </div>

      <div className="tk-section" data-evidence-location="decisions">
        <h3 className="tk-section-h2">Decisions</h3>
        {renderClaims(
          evidence,
          summary?.decisions ?? [],
          'decision',
          'No explicit decisions in this thread yet.',
          {
            text: conversation.latestDecisionText,
            ordinal: conversation.latestDecisionMsgIndex,
            speaker: conversation.latestDecisionSpeaker,
            id: 'cached-decision',
          }
        )}
      </div>

      <div className="tk-section" data-evidence-location="action-items">
        <h3 className="tk-section-h2">Action items & next steps</h3>
        {renderClaims(
          evidence,
          summary?.actionItems ?? [],
          'action',
          'No pending action items recorded for this conversation.',
          {
            text: conversation.nextStepText,
            ordinal: conversation.nextStepMsgIndex,
            speaker: conversation.nextStepSpeaker,
            id: 'cached-next-step',
          }
        )}
      </div>

      <div className="tk-section" data-evidence-location="open-questions">
        <h3 className="tk-section-h2">Open questions</h3>
        {renderClaims(evidence, summary?.openQuestions ?? [], 'question', 'No unresolved questions flagged in this thread.')}
      </div>

      <div className="tk-section" data-evidence-location="related-threads">
        <h3 className="tk-section-h2">Related threads & branches</h3>
        {relationships.map((rel) => {
          const otherKey = rel.fromThreadKey === conversation.threadKey ? rel.toThreadKey : rel.fromThreadKey;
          const otherConv = conversations.find((c) => c.threadKey === otherKey);
          const evId = `rel-${rel.relationshipKey}`;
          const localOrdinal =
            rel.fromThreadKey === conversation.threadKey ? rel.evidenceFromOrdinal : rel.evidenceToOrdinal;
          return (
            <div key={rel.relationshipKey}>
              <div className="tk-claim-row">
                <div>
                  <button type="button" className="tk-btn" style={{ marginRight: 8 }} onClick={() => onSelectThread(otherKey)}>
                    {rel.relationType.replace('_', ' ')}: {otherConv ? getDisplayTitle(otherConv) : otherKey}
                  </button>
                  <span className="tk-claim-text">{rel.reason}</span>
                </div>
                <button
                  type="button"
                  className="tk-evidence-marker"
                  aria-expanded={evidence.activeEvidenceId === evId}
                  onClick={() => evidence.onToggle(evId)}
                >
                  <span className="tk-evidence-pip" data-speaker="user_committed" aria-hidden="true" />
                  <span>m{localOrdinal + 1}</span>
                </button>
              </div>
              {renderEvidencePassage(evidence, evId, [localOrdinal])}
            </div>
          );
        })}
        <SemanticNeighbors related={semanticNeighbors} insights={insightsByThread} onSelect={onSelectThread} />
        {relationships.length === 0 && semanticNeighbors.length === 0 && (
          <div className="tk-empty-line">No related threads found yet.</div>
        )}
      </div>

      <div className="tk-section">
        <h3 className="tk-section-h2">Manual index overrides & notes</h3>
        <div className="tk-notes-box">
          <label className="tk-field">
            Title override
            <input
              type="text"
              className="tk-input"
              aria-label="Manual title override"
              value={titleDraft}
              onChange={(e) => onTitleDraftChange(e.target.value)}
            />
          </label>
          <label className="tk-field">
            Tags (comma-separated; synonyms normalized)
            <input
              type="text"
              className="tk-input"
              aria-label="Manual tags"
              value={tagInputDraft}
              onChange={(e) => onTagInputDraftChange(e.target.value)}
            />
          </label>
          <label className="tk-field">
            Workbench notes (preserved across re-imports)
            <textarea
              className="tk-input"
              style={{ minHeight: 68 }}
              aria-label="Manual workbench notes"
              value={notesDraft}
              onChange={(e) => onNotesDraftChange(e.target.value)}
            />
          </label>
          <div className="tk-notes-actions">
            <label className="tk-inline-check">
              <input
                type="checkbox"
                checked={conversation.cloudExcluded}
                onChange={(e) => onSetCloudExcluded(conversation.threadKey, e.target.checked)}
              />
              Local-only thread (never sent to Claude, embedding APIs or the Worker)
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              {cloudEnabled && (
                <button
                  type="button"
                  className="tk-btn"
                  onClick={() => onEnrich(conversation.threadKey)}
                >
                  Enrich via Worker
                </button>
              )}
              <button type="button" className="tk-btn tk-btn-primary" onClick={() => void onSaveManualEdits()}>
                Save notes & overrides
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="tk-section">
        <h3 className="tk-section-h2">Captured transcript ({messages.length} messages)</h3>
        {messages.length === 0 ? (
          <div className="tk-empty-line">
            No message bodies captured ({conversation.coverage} state). Open the original conversation or
            import an export file to populate message turns.
          </div>
        ) : (
          <div className="tk-transcript">
            {!showAllMessages && messages.length > TRANSCRIPT_PAGE && (
              <button type="button" className="tk-btn" onClick={() => onShowAllMessages()}>
                Show all {messages.length} messages ({messages.length - TRANSCRIPT_PAGE} earlier hidden)
              </button>
            )}
            {(showAllMessages ? messages : messages.slice(-TRANSCRIPT_PAGE)).map((m) => (
              <article key={m.messageKey} className="tk-message" data-role={m.role}>
                <div className="tk-message-meta tk-tabular">
                  m{m.ordinal + 1} · {m.role} ·{' '}
                  {m.createdAt ? m.createdAt.slice(0, 19).replace('T', ' ') : 'timestamp unknown'}
                </div>
                <div className="tk-message-body">{m.content}</div>
              </article>
            ))}
          </div>
        )}
      </div>
    </>
  );

  return (
    <section
      className="tk-detail-pane"
      aria-label="Conversation context and evidence"
      data-mobile-hidden={!mobileDetailVisible}
      data-thr-mode={onPage && mode !== 'summary' ? mode : undefined}
    >
      {conversation ? (
        <>
          <div className="tk-detail-header">
            <div className="tk-mobile-back-wrap">
              <button
                type="button"
                className="tk-btn"
                onClick={onBackToList}
              >
                ← Back to list
              </button>
            </div>

            <div className="tk-detail-title-row">
              <h2 className="tk-detail-title" title={getSmartTitle(conversation, insight)}>{getSmartTitle(conversation, insight)}</h2>
              {onPage && <ThreadModeBar conversation={conversation} />}
            </div>
            {insight && getSmartTitle(conversation, insight) !== getDisplayTitle(conversation) && (
              <div className="tk-muted" style={{ fontSize: 12 }}>
                Original title: {getDisplayTitle(conversation)}
              </div>
            )}

            {onPage && (
              <ThreadPageNote
                conversation={conversation}
                onCopyResume={(command) => onCopy(command, 'Resume command')}
                resumeShownElsewhere={
                  Boolean(conversation.resumeCommand) &&
                  !(/^https:\/\//.test(conversation.canonicalUrl) ||
                    (conversation.provider === 'paperclip' && /^http:\/\//.test(conversation.canonicalUrl)))
                }
              />
            )}

            <div className="tk-detail-meta-strip">
              <StatusPill state={conversation.workflowState} />
              <span>·</span>
              <CoverageTick coverage={conversation.coverage} />
              <span className="tk-tabular">
                rev r{conversation.sourceRevision} ({conversation.messageCount} msgs)
              </span>
              <span>·</span>
              <span>
                {providerLabel(conversation.provider)}
                {conversation.providerProjectName ? ` / ${conversation.providerProjectName}` : ''}
                {conversation.agentLabel ? ` · ${conversation.agentLabel}` : ''}
              </span>
              <span>·</span>
              <span title={`${conversation.accountId} / ${conversation.workspaceId}`}>
                updated {relativeTime(conversation.updatedAt ?? conversation.lastCapturedAt)}
              </span>
              {onPage && <ThreadFacts conversation={conversation} />}
              {stillPaired && mayShare(conversation) && (
                <InStillBadge
                  threadKey={conversation.threadKey}
                  paired={stillPaired}
                  revision={`${conversation.sourceRevision}:${stillLastPushAt ?? ''}`}
                />
              )}
            </div>

            {conversation.siblingBranchIds.length > 0 && (
              <div className="tk-filter-row" style={{ marginTop: 4 }}>
                <span className="tk-eyebrow" style={{ padding: 0 }}>
                  Branch ({conversation.branchId}):
                </span>
                {conversation.siblingBranchIds.map((sibId) => {
                  const sibConv = conversations.find(
                    (c) =>
                      c.sourceConversationId === conversation.sourceConversationId &&
                      c.accountId === conversation.accountId &&
                      c.branchId === sibId
                  );
                  if (!sibConv) return null;
                  return (
                    <button key={sibId} type="button" className="tk-btn" onClick={() => onSelectThread(sibConv.threadKey)}>
                      Switch to {sibId}
                    </button>
                  );
                })}
              </div>
            )}

            {!onPage && <PaperclipLinks conv={conversation} conversations={conversations} onSelect={onSelectThread} />}

            <div className="tk-detail-controls" role="group" aria-label="Thread controls" tabIndex={0}>
              <select
                className="tk-select tk-detail-category"
                aria-label="Assign project or area"
                title={conversation.project}
                value={conversation.project}
                onChange={(e) => void onProjectChange(e.target.value)}
              >
                {projectNames.map((area) => (
                  <option key={area} value={area}>
                    {area}
                  </option>
                ))}
              </select>
              <label className="tk-inline-check tk-detail-lock" title="Lock category">
                <input
                  type="checkbox"
                  checked={conversation.categoryLocked}
                  onChange={(e) => void onToggleLock(e.target.checked)}
                />
                <Icon name="lock" size={14} />
                <span className="tk-visually-hidden">Lock category</span>
              </label>
              <select
                className="tk-select tk-detail-state"
                aria-label="Change workflow state"
                value={conversation.workflowState}
                onChange={(e) => void onWorkflowStateChange(e.target.value as WorkflowState)}
              >
                <option value="active">Active</option>
                <option value="needs_review">Needs review</option>
                <option value="waiting">Waiting</option>
                <option value="paused">Paused</option>
                <option value="done">Done</option>
                <option value="archived">Archived</option>
              </select>
              {/^https:\/\//.test(conversation.canonicalUrl) ||
              (conversation.provider === 'paperclip' && /^http:\/\//.test(conversation.canonicalUrl)) ? (
                <button
                  type="button"
                  className="tk-btn tk-thr-action"
                  aria-label="Open original"
                  title="Open original"
                  onClick={onOpenOriginal}
                >
                  <Icon name="external" size={14} />
                  <span className="tk-thr-action-label">Original</span>
                </button>
              ) : conversation.resumeCommand ? (
                <button
                  type="button"
                  className="tk-btn tk-thr-action"
                  aria-label="Copy resume command"
                  title="Copy resume command"
                  onClick={() => onCopy(conversation.resumeCommand!, 'Resume command')}
                >
                  <Icon name="copy" size={14} />
                  <span className="tk-thr-action-label">Copy resume command</span>
                </button>
              ) : null}
              <button
                type="button"
                className="tk-btn tk-thr-action"
                aria-label="Copy handoff"
                title="Copy handoff"
                onClick={() =>
                  onCopy(
                    exportThreadToMarkdown(conversation, messages, summary, insight),
                    'Markdown handoff'
                  )
                }
              >
                <Icon name="copy" size={14} />
                <span className="tk-thr-action-label">Handoff</span>
              </button>
              {stillPaired && (
                <button
                  type="button"
                  className="tk-btn tk-thr-action"
                  aria-label="Send to Still"
                  disabled={!mayShare(conversation)}
                  title={
                    mayShare(conversation)
                      ? 'Add this thread to Still as a chat'
                      : 'Local-only threads, threads in local-only projects and excluded providers are never sent to Still'
                  }
                  onClick={() => onSendToStill([conversation.threadKey], 'this thread')}
                >
                  <Icon name="external" size={14} />
                  <span className="tk-thr-action-label">Send to Still…</span>
                </button>
              )}
              {onPage && <ThreadWorkspaceActions conversation={conversation} />}
              {onPage && <PaperclipLinks compact conv={conversation} conversations={conversations} onSelect={onSelectThread} />}
              <button type="button" className="tk-btn tk-btn-danger tk-thr-action" aria-label="Delete" title="Delete" onClick={() => void onDelete()}>
                <Icon name="trash" size={14} />
                <span className="tk-thr-action-label">Delete</span>
              </button>
            </div>
          </div>

          {onPage && mode !== 'summary' ? (
            <div className="tk-thr-body" data-mode={mode}>
              {mode === 'split' && <div className="tk-thr-summary">{renderBody(conversation)}</div>}
              <div className="tk-thr-livewrap">
                <LivePage conversation={conversation} />
              </div>
            </div>
          ) : (
            renderBody(conversation)
          )}
        </>
      ) : (
        <div className="tk-empty-line">Select a conversation to see what it is about and where you left off.</div>
      )}
    </section>
  );
}
