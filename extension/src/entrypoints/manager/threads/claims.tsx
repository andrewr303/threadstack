import React from 'react';
import type { ConversationRecord, MessageRecord, StructuredSummaryRecord } from '../../../core/schema.js';

/** The open thread and which evidence marker is expanded; the detail pane owns both. */
export interface EvidenceView {
  activeEvidenceId: string | null;
  conversation: ConversationRecord | null;
  messages: MessageRecord[];
  /** Expand this marker, or collapse it when it is already the open one. */
  onToggle: (evidenceId: string) => void;
}

export function renderEvidencePassage(view: EvidenceView, evidenceId: string, messageIndexes: number[]) {
  const selectedConversation = view.conversation;
  if (view.activeEvidenceId !== evidenceId || !selectedConversation) return null;
  const cited = messageIndexes
    .map((ord) => view.messages.find((m) => m.ordinal === ord))
    .filter((m): m is MessageRecord => Boolean(m));
  return (
    <div className="tk-evidence-passage-box" role="region" aria-label="Source passage">
      <div className="tk-tabular" style={{ fontWeight: 600, marginBottom: 4 }}>
        Captured evidence · sourceRevision r{selectedConversation.sourceRevision} · {selectedConversation.coverage}{' '}
        coverage
      </div>
      {cited.length > 0 ? (
        cited.map((m) => (
          <div key={m.messageKey} style={{ marginTop: 4 }}>
            <strong>
              [m{m.ordinal + 1} · {m.role}]
            </strong>
            : “{m.content.length > 1200 ? `${m.content.slice(0, 1200)}…` : m.content}”
          </div>
        ))
      ) : (
        <div>
          Message m{(messageIndexes[0] ?? 0) + 1} captured in thread revision r{selectedConversation.sourceRevision}.
        </div>
      )}
    </div>
  );
}

/** "m3,m5" in the margin; reads "(source m3,m5)" when copied or announced. */
export const evidenceLabel = (indexes: number[]) => (
  <>
    <span className="tk-visually-hidden"> (source </span>
    <span>{indexes.map((i) => `m${i + 1}`).join(',')}</span>
    <span className="tk-visually-hidden">)</span>
  </>
);

export function renderClaims(
  view: EvidenceView,
  items: StructuredSummaryRecord['decisions'],
  prefix: string,
  emptyText: string,
  fallback?: { text: string | null; ordinal: number | null; speaker: 'user_committed' | 'assistant_suggested' | null; id: string }
) {
  const { activeEvidenceId, onToggle } = view;
  if (items.length > 0) {
    return (
      <ul className="tk-claim-list">
        {items.map((d, idx) => {
          const evId = `${prefix}-${idx}`;
          const rationale = d.rationale?.trim();
          return (
            <li key={evId}>
              <div className="tk-claim-row">
                <span className="tk-claim-text">
                  {d.text}
                  {rationale ? (
                    <span className="tk-claim-rationale">
                      {' — '}
                      {rationale}
                    </span>
                  ) : null}
                </span>
                <button
                  type="button"
                  className="tk-evidence-marker"
                  title={d.speaker === 'user_committed' ? 'You committed to this' : 'Assistant suggested this'}
                  aria-expanded={activeEvidenceId === evId}
                  onClick={() => onToggle(evId)}
                >
                  <span className="tk-evidence-pip" data-speaker={d.speaker} aria-hidden="true" />
                  {evidenceLabel(d.messageIndexes)}
                </button>
              </div>
              {renderEvidencePassage(view, evId, d.messageIndexes)}
            </li>
          );
        })}
      </ul>
    );
  }
  if (fallback?.text) {
    return (
      <div>
        <div className="tk-claim-row">
          <span className="tk-claim-text">{fallback.text}</span>
          <button
            type="button"
            className="tk-evidence-marker"
            aria-expanded={activeEvidenceId === fallback.id}
            onClick={() => onToggle(fallback.id)}
          >
            <span className="tk-evidence-pip" data-speaker={fallback.speaker ?? 'user_committed'} aria-hidden="true" />
            {evidenceLabel([fallback.ordinal ?? 0])}
          </button>
        </div>
        {renderEvidencePassage(view, fallback.id, [fallback.ordinal ?? 0])}
      </div>
    );
  }
  return <div className="tk-empty-line">{emptyText}</div>;
}
