import React, { useId } from 'react';
import type { RelatedReason } from '../../core/related.js';
import type { ConversationRecord, ExtensionSummaryOutput, ThreadInsight } from '../../core/schema.js';
import { getSmartTitle } from '../../core/insights.js';
import { MODEL_OPTIONS } from '../../core/ai/claude.js';
import { isOlderAnalysis, needsAgentRunUpgrade } from '../../core/pipeline.js';
import { providerLabel } from '../../core/providers.js';
import { buildSummaryMarkdown, overviewParagraphs, producedItems } from '../../core/summary-markdown.js';
import { KindLabel, PROJECT_SOURCE_LABELS, relativeTime } from './shared.js';
import { AgentRunBlock, hasAgentRunContent } from './threads/AgentRun.js';
import { useOptionalWorkspaceContext } from './workspace/context.js';

/** The agent run, the related-thread reasons and their wording are for the full page; a component rendered without a workspace around it shows them too. */
function useFullPage(): boolean {
  const ws = useOptionalWorkspaceContext();
  return !ws || ws.surface === 'page';
}

const RELATED_REASON_WORDS: Record<RelatedReason, string> = {
  same_conversation: 'Same session, other account',
  same_pull_request: 'Same pull request',
  same_branch: 'Same branch',
  same_repository: 'Same repository',
  similar: 'Similar',
};

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
  const fullPage = useFullPage();
  // A coding session analysed before agent facts existed: only an explicit "Improve summary" adds them.
  const upgradesRun = fullPage && needsAgentRunUpgrade(conv, insight);
  const upgradeHintId = useId();
  const runHeadingId = useId();
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
          {canAnalyze && conv.messageCount > 0 && (!isAi || stale || older || upgradesRun) && (
            <button
              type="button"
              className="tk-btn"
              disabled={analyzing}
              onClick={onAnalyze}
              aria-describedby={upgradesRun ? upgradeHintId : undefined}
              title={older && !stale ? 'Re-analyze with the current, more detailed summary format' : undefined}
            >
              {analyzeLabel}
            </button>
          )}
          {canAnalyze && conv.messageCount > 0 && upgradesRun && (
            <span className="tk-muted tk-thr-hint" id={upgradeHintId}>
              Adds the run details: files changed, commands, tests and pull requests.
            </span>
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
          {fullPage && hasAgentRunContent(insight.agentRun) && <AgentRunBlock run={insight.agentRun} headingId={runHeadingId} />}
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
  /** Cosine similarity, or 0 when the thread is related by structure only. */
  similarity: number;
  /** Why it is related (core/related.ts); absent means similar meaning. */
  reason?: RelatedReason;
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
  const fullPage = useFullPage();
  if (related.length === 0) return null;
  return (
    <div className="tk-related-list">
      <div className="tk-eyebrow" style={{ padding: 0 }}>
        {fullPage ? 'Related threads' : 'Similar threads'}
      </div>
      {related.map(({ conv, similarity, reason }) => {
        const insight = insights.get(conv.threadKey) ?? null;
        // Full page: say why it is related first; only a similar thread has a percentage.
        const word = RELATED_REASON_WORDS[reason ?? 'similar'];
        const showPercent = !fullPage || !reason || reason === 'similar';
        return (
          <button
            key={conv.threadKey}
            type="button"
            className="tk-related-item"
            data-reason={fullPage ? reason ?? 'similar' : undefined}
            onClick={() => onSelect(conv.threadKey)}
          >
            <span className="tk-related-title">{getSmartTitle(conv, insight)}</span>
            <span className="tk-related-meta">
              {fullPage && (
                <>
                  <span className="tk-thr-reason">{word}</span> ·{' '}
                </>
              )}
              {providerLabel(conv.provider)} · {conv.project} · {relativeTime(conv.updatedAt)}
              {showPercent && <> · {Math.round(similarity * 100)}% similar</>}
            </span>
            {insight?.gist && <span className="tk-related-gist">{insight.gist}</span>}
          </button>
        );
      })}
    </div>
  );
}
