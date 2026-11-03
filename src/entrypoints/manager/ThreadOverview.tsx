import React from 'react';
import type { ConversationRecord, ExtensionSummaryOutput, ThreadInsight } from '../../core/schema.js';
import { getSmartTitle } from '../../core/insights.js';
import { MODEL_OPTIONS } from '../../core/ai/claude.js';
import { isOlderAnalysis } from '../../core/pipeline.js';
import { providerLabel } from '../../core/providers.js';
import { buildSummaryMarkdown, overviewParagraphs, producedItems } from '../../core/summary-markdown.js';
import { KindLabel, PROJECT_SOURCE_LABELS, relativeTime } from './shared.js';

interface OverviewProps {
  conv: ConversationRecord;
  insight: ThreadInsight | null;
  /** The grounded summary (decisions, key points, where you left off); used by "Copy summary". */
  summary?: ExtensionSummaryOutput | null;
  canAnalyze: boolean;
  analyzing: boolean;
  onAnalyze: () => void;
  onCopy: (text: string, label: string) => void;
}

function modelLabel(model: string): string {
  return MODEL_OPTIONS.find((m) => model.replace(/^anthropic\./, '').startsWith(m.id))?.label ?? model;
}

/** A message reference that reads as "(m3)" when copied or spoken, while looking like a small "m3". */
export function MessageRef({ index }: { index: number | null | undefined }) {
  if (typeof index !== 'number' || index < 0) return null;
  return (
    <span className="tk-ref" title={`Message ${index + 1}`}>
      <span className="tk-visually-hidden"> (</span>m{index + 1}
      <span className="tk-visually-hidden">)</span>
    </span>
  );
}

/** "What is this thread?" — the summary layer above the evidence margin. */
export function ThreadOverview({ conv, insight, summary = null, canAnalyze, analyzing, onAnalyze, onCopy }: OverviewProps) {
  const isAi = insight?.source === 'ai';
  const stale = isAi && insight.sourceRevision !== conv.sourceRevision;
  const older = isOlderAnalysis(insight);
  const paragraphs = overviewParagraphs(insight);
  const produced = producedItems(insight);
  const languages = insight ? insight.languages.filter((l) => !insight.topics.includes(l)) : [];
  const analyzeLabel = analyzing ? 'Analyzing…' : !isAi ? 'Analyze with Claude' : stale ? 'Re-analyze' : 'Improve summary';
  return (
    <div className="tk-section tk-overview" data-evidence-location="overview">
      <div className="tk-overview-head">
        <h3 className="tk-section-h2">What this thread is about</h3>
        <div className="tk-overview-provenance">
          {insight ? (
            isAi ? (
              <span title={insight.generatedAt}>
                Analyzed by {modelLabel(insight.model)} · {relativeTime(insight.generatedAt)}
                {stale ? ' · thread changed since' : older ? ' · older summary format' : ''}
              </span>
            ) : (
              <span>On-device analysis</span>
            )
          ) : (
            <span>Not analyzed yet</span>
          )}
          {canAnalyze && conv.messageCount > 0 && (!isAi || stale || older) && (
            <button
              type="button"
              className="tk-btn"
              disabled={analyzing}
              onClick={onAnalyze}
              title={older && !stale ? 'Re-analyze with the current, more detailed summary format' : undefined}
            >
              {analyzeLabel}
            </button>
          )}
          {(insight || summary) && (
            <button
              type="button"
              className="tk-btn"
              onClick={() => onCopy(buildSummaryMarkdown({ conv, insight, summary }), 'Summary')}
            >
              Copy summary
            </button>
          )}
        </div>
      </div>

      {insight ? (
        <>
          {insight.gist && <p className="tk-overview-gist">{insight.gist}</p>}
          {paragraphs.length > 0 && (
            <div className="tk-overview-body">
              {paragraphs.map((p, i) => (
                <p key={i} className="tk-overview-summary">
                  {p}
                </p>
              ))}
            </div>
          )}
          {(insight.userGoal || insight.outcome || insight.statusReason) && (
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
          {produced.length > 0 && (
            <div className="tk-overview-block">
              <h4 className="tk-overview-h4">What was produced</h4>
              <ul className="tk-produced-list">
                {produced.slice(0, 12).map((a, i) => (
                  <li key={`${a.label}-${i}`} className="tk-produced-item" data-kind={a.kind}>
                    <span className="tk-artifact" data-kind={a.kind}>
                      {a.label}
                    </span>
                    {a.description ? (
                      <span className="tk-produced-desc">
                        {' — '}
                        {a.description}
                      </span>
                    ) : null}
                    <MessageRef index={a.messageIndex} />
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ul className="tk-chip-row" aria-label="Kind and topics">
            <li>
              <KindLabel kind={insight.kind} />
            </li>
            {insight.topics.map((t) => (
              <li key={t} className="tk-chip">
                <span className="tk-visually-hidden">, </span>
                {t}
              </li>
            ))}
            {languages.map((l) => (
              <li key={l} className="tk-chip tk-chip-quiet">
                <span className="tk-visually-hidden">, </span>
                {l}
              </li>
            ))}
          </ul>
          {insight.entities.length > 0 && (
            <div className="tk-overview-line">
              <span className="tk-muted">Mentions</span> {insight.entities.join(', ')}
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
