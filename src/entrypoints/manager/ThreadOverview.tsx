import React from 'react';
import type { ConversationRecord, ThreadInsight } from '../../core/schema.js';
import { getSmartTitle } from '../../core/insights.js';
import { MODEL_OPTIONS } from '../../core/ai/claude.js';
import { providerLabel } from '../../core/providers.js';
import { KindLabel, PROJECT_SOURCE_LABELS, relativeTime } from './shared.js';

interface OverviewProps {
  conv: ConversationRecord;
  insight: ThreadInsight | null;
  canAnalyze: boolean;
  analyzing: boolean;
  onAnalyze: () => void;
  onCopy: (text: string, label: string) => void;
}

function modelLabel(model: string): string {
  return MODEL_OPTIONS.find((m) => model.startsWith(m.id))?.label ?? model;
}

/** "What is this thread?" — the summary layer above the evidence margin. */
export function ThreadOverview({ conv, insight, canAnalyze, analyzing, onAnalyze, onCopy }: OverviewProps) {
  const isAi = insight?.source === 'ai';
  const stale = isAi && insight.sourceRevision !== conv.sourceRevision;
  return (
    <div className="tk-section tk-overview" data-evidence-location="overview">
      <div className="tk-overview-head">
        <h3 className="tk-section-h2">What this thread is about</h3>
        <div className="tk-overview-provenance">
          {insight ? (
            isAi ? (
              <span title={insight.generatedAt}>
                Analyzed by {modelLabel(insight.model)} · {relativeTime(insight.generatedAt)}
                {stale ? ' · thread changed since' : ''}
              </span>
            ) : (
              <span>On-device analysis</span>
            )
          ) : (
            <span>Not analyzed yet</span>
          )}
          {canAnalyze && conv.messageCount > 0 && (!isAi || stale) && (
            <button type="button" className="tk-btn" disabled={analyzing} onClick={onAnalyze}>
              {analyzing ? 'Analyzing…' : isAi ? 'Re-analyze' : 'Analyze with Claude'}
            </button>
          )}
        </div>
      </div>

      {insight ? (
        <>
          <p className="tk-overview-gist">{insight.gist}</p>
          {insight.summary && insight.summary !== insight.gist && <p className="tk-overview-summary">{insight.summary}</p>}
          {(insight.userGoal || insight.outcome) && (
            <dl className="tk-overview-dl">
              {insight.userGoal && (
                <>
                  <dt>Goal</dt>
                  <dd>{insight.userGoal}</dd>
                </>
              )}
              {insight.outcome && (
                <>
                  <dt>Outcome</dt>
                  <dd>{insight.outcome}</dd>
                </>
              )}
              {insight.statusReason && (
                <>
                  <dt>Status</dt>
                  <dd>{insight.statusReason}</dd>
                </>
              )}
            </dl>
          )}
          <div className="tk-chip-row">
            <KindLabel kind={insight.kind} />
            {insight.topics.map((t) => (
              <span key={t} className="tk-chip">
                {t}
              </span>
            ))}
            {insight.languages
              .filter((l) => !insight.topics.includes(l))
              .map((l) => (
                <span key={l} className="tk-chip tk-chip-quiet">
                  {l}
                </span>
              ))}
          </div>
          {insight.entities.length > 0 && (
            <div className="tk-overview-line">
              <span className="tk-muted">Mentions</span> {insight.entities.join(', ')}
            </div>
          )}
          {insight.artifacts.length > 0 && (
            <div className="tk-overview-line">
              <span className="tk-muted">Artifacts</span>{' '}
              {insight.artifacts.slice(0, 8).map((a, i) => (
                <span key={`${a.label}-${i}`} className="tk-artifact" data-kind={a.kind}>
                  {a.label}
                  {a.messageIndex !== null ? <span className="tk-muted"> m{a.messageIndex + 1}</span> : null}
                </span>
              ))}
            </div>
          )}
        </>
      ) : (
        <p className="tk-muted">This thread has not been analyzed yet; it will be shortly.</p>
      )}

      <div className="tk-overview-line">
        <span className="tk-muted">Project</span> {conv.project}
        {conv.categoryLocked ? ' (locked)' : ''} ·{' '}
        <span className="tk-muted">
          {PROJECT_SOURCE_LABELS[conv.projectSource ?? 'import']}
          {conv.projectReason ? ` — ${conv.projectReason}` : ''}
        </span>
      </div>

      {(conv.workspacePath || conv.resumeCommand || conv.modelSlug) && (
        <div className="tk-cli-box">
          {conv.workspacePath && (
            <div>
              <span className="tk-muted">Workspace</span> <code>{conv.workspacePath}</code>
              {conv.gitBranch ? (
                <>
                  {' '}
                  <span className="tk-muted">on</span> <code>{conv.gitBranch}</code>
                </>
              ) : null}
            </div>
          )}
          {conv.modelSlug && (
            <div>
              <span className="tk-muted">Model</span> <code>{conv.modelSlug}</code>
            </div>
          )}
          {conv.resumeCommand && (
            <div className="tk-field-row">
              <code className="tk-grow tk-code-line">{conv.resumeCommand}</code>
              <button type="button" className="tk-btn" onClick={() => onCopy(conv.resumeCommand!, 'Resume command')}>
                Copy resume command
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export interface RelatedThread {
  conv: ConversationRecord;
  similarity: number;
}

export function SemanticNeighbors({
  related,
  insights,
  onSelect,
}: {
  related: RelatedThread[];
  insights: Map<string, ThreadInsight>;
  onSelect: (threadKey: string) => void;
}) {
  if (related.length === 0) return null;
  return (
    <div className="tk-related-list">
      <div className="tk-eyebrow" style={{ padding: 0 }}>
        Similar threads
      </div>
      {related.map(({ conv, similarity }) => {
        const insight = insights.get(conv.threadKey) ?? null;
        return (
          <button key={conv.threadKey} type="button" className="tk-related-item" onClick={() => onSelect(conv.threadKey)}>
            <span className="tk-related-title">{getSmartTitle(conv, insight)}</span>
            <span className="tk-related-meta">
              {providerLabel(conv.provider)} · {conv.project} · {relativeTime(conv.updatedAt)} ·{' '}
              {Math.round(similarity * 100)}% similar
            </span>
            {insight?.gist && <span className="tk-related-gist">{insight.gist}</span>}
          </button>
        );
      })}
    </div>
  );
}
