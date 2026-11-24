import React, { useRef, useState } from 'react';
import {
  getDisplayTitle,
  type ConversationRecord,
  type MessageRecord,
  type SettingsRecord,
  type ThreadInsight,
} from '../../core/schema.js';
import type { MemorySearchIndex } from '../../core/search.js';
import { askLibraryWithClaude, hasClaudeKey, type AskContextThread } from '../../core/ai/claude.js';
import { cosine, embedTexts, localHashEmbedding, remoteSpace, LOCAL_SPACE } from '../../core/embeddings.js';
import {
  applyRerankOrder,
  bestMatchingExcerpt,
  buildRerankDocument,
  remoteRerankAllowedKeys,
  rerankReady,
  rerankThreads,
} from '../../core/rerank.js';
import { remoteAllowedKeys } from '../../core/privacy.js';
import { providerLabel } from '../../core/providers.js';
import { getSmartTitle } from '../../core/insights.js';
import { relativeTime, renderCitations, sharedDb } from './shared.js';
import { citedSourceKeys } from './dock.js';

interface Props {
  settings: SettingsRecord | null;
  conversations: ConversationRecord[];
  insights: Map<string, ThreadInsight>;
  messagesByThread: Map<string, MessageRecord[]>;
  vectors: Map<string, Map<string, number[]>>;
  searchIndex: MemorySearchIndex;
  onSelectThread: (threadKey: string) => void;
  onOpenSettings: () => void;
  /** Set when ThreadStack is connected to Still: "Send these threads to Still…" under the answer. */
  onSendToStill?: (threadKeys: string[]) => void;
}

const MAX_SOURCES = 8;

/** Ask reranks a smaller pool than search (default 30 when search uses 40). */
function askRerankPool(settings: SettingsRecord): number {
  return Math.max(MAX_SOURCES, Math.min(100, Math.round((settings.rerankCandidates || 40) * 0.75)));
}

function excerptsFor(messages: MessageRecord[], question: string): string[] {
  const terms = question
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length >= 4);
  const scored = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => {
      const lower = m.content.toLowerCase();
      const score = terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0);
      return { m, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  const pick = scored.length ? scored.map((x) => x.m) : messages.slice(-2);
  return pick.map((m) => {
    const lower = m.content.toLowerCase();
    const hit = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, hit - 200);
    const text = m.content.slice(start, start + 700).replace(/\s+/g, ' ').trim();
    return `[${m.role}] ${start > 0 ? '…' : ''}${text}`;
  });
}

export function AskPanel({
  settings,
  conversations,
  insights,
  messagesByThread,
  vectors,
  searchIndex,
  onSelectThread,
  onOpenSettings,
  onSendToStill,
}: Props) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<ConversationRecord[]>([]);
  const [status, setStatus] = useState<'idle' | 'retrieving' | 'answering' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const [rerankNote, setRerankNote] = useState<string | null>(null);
  const [withheld, setWithheld] = useState(0);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const canAsk = settings ? hasClaudeKey(settings) : false;

  /**
   * Second stage: rerank the best fused candidates before choosing sources.
   * Local-only threads are never sent and keep their place; any failure
   * keeps the first-stage order with a short note.
   */
  const rerankForAsk = async (q: string, ranked: ConversationRecord[]): Promise<ConversationRecord[]> => {
    setRerankNote(null);
    if (!settings || !settings.rerankInAsk || !rerankReady(settings) || ranked.length < 2) return ranked;
    const pool = ranked.slice(0, askRerankPool(settings));
    try {
      const allowed = await remoteRerankAllowedKeys(
        sharedDb,
        settings,
        pool.map((c) => c.threadKey)
      );
      const outcome = await rerankThreads(
        settings,
        q,
        pool.map((c) => {
          const insight = insights.get(c.threadKey) ?? null;
          return {
            key: c.threadKey,
            document: buildRerankDocument({
              title: getSmartTitle(c, insight),
              gist: insight?.gist,
              excerpt: bestMatchingExcerpt(messagesByThread.get(c.threadKey) ?? [], q),
            }),
          };
        }),
        allowed
      );
      if (outcome.scores.size > 0) setRerankNote(`Reranked with ${outcome.label}`);
      return [...applyRerankOrder(pool, (c) => c.threadKey, outcome.order), ...ranked.slice(pool.length)];
    } catch (err) {
      setRerankNote(`Not reranked: ${err instanceof Error ? err.message : String(err)}`);
      return ranked;
    }
  };

  const retrieve = async (q: string): Promise<ConversationRecord[]> => {
    const byKey = new Map(conversations.map((c) => [c.threadKey, c]));
    const fused = new Map<string, number>();
    const addRanked = (keys: string[]) =>
      keys.forEach((k, rank) => fused.set(k, (fused.get(k) ?? 0) + 1 / (60 + rank + 1)));

    addRanked(searchIndex.searchLocal(q, { includeSyntheticBenchmark: false }, 30).hits.map((h) => h.conversation.threadKey));

    const rankBySpace = (space: string, qv: number[]) => {
      const scored: Array<[string, number]> = [];
      for (const [threadKey, bySpace] of vectors) {
        const v = bySpace.get(space);
        if (v && byKey.has(threadKey)) scored.push([threadKey, cosine(qv, v)]);
      }
      scored.sort((a, b) => b[1] - a[1]);
      return scored.slice(0, 30).filter(([, s]) => s > 0.12).map(([k]) => k);
    };
    addRanked(rankBySpace(LOCAL_SPACE, localHashEmbedding(q)));
    const space = settings ? remoteSpace(settings) : null;
    if (settings && space) {
      try {
        const [qv] = await embedTexts(settings, space, [q], 'query');
        addRanked(rankBySpace(space.id, qv));
      } catch {
        // remote embeddings unavailable; lexical + local vectors still apply
      }
    }
    const candidates = Array.from(fused.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => byKey.get(k))
      .filter((c): c is ConversationRecord => Boolean(c && !c.isSyntheticBenchmark));
    // Sources become Claude's context, so local-only threads are dropped before choosing them.
    let ranked = candidates;
    if (settings && canAsk) {
      const allowed = await remoteAllowedKeys(sharedDb, settings, candidates.map((c) => c.threadKey));
      ranked = candidates.filter((c) => allowed.has(c.threadKey));
      setWithheld(candidates.slice(0, MAX_SOURCES).filter((c) => !allowed.has(c.threadKey)).length);
    } else {
      setWithheld(0);
    }
    return (await rerankForAsk(q, ranked)).slice(0, MAX_SOURCES);
  };

  const ask = async () => {
    const q = question.trim();
    if (!q || !settings) return;
    setStatus('retrieving');
    setError(null);
    setAnswer('');
    try {
      const found = await retrieve(q);
      setSources(found);
      if (!canAsk || found.length === 0) {
        setStatus('done');
        return;
      }
      setStatus('answering');
      const context: AskContextThread[] = found.map((c) => {
        const insight = insights.get(c.threadKey);
        return {
          title: getSmartTitle(c, insight ?? null),
          provider: providerLabel(c.provider),
          updatedAt: c.updatedAt,
          project: c.project,
          gist: insight?.gist ?? '',
          summary: insight?.summary ?? '',
          excerpts: excerptsFor(messagesByThread.get(c.threadKey) ?? [], q),
        };
      });
      let streamed = '';
      const full = await askLibraryWithClaude(settings, q, context, (delta) => {
        streamed += delta;
        setAnswer(streamed);
      });
      setAnswer(full);
      setStatus('done');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setStatus('error');
    }
  };

  return (
    <div className="tk-ask" aria-label="Ask your library">
      <div className="tk-ask-form">
        <textarea
          ref={inputRef}
          className="tk-input tk-ask-input"
          aria-label="Ask a question about your past AI conversations"
          placeholder="What did I decide about the pricing page?"
          value={question}
          rows={4}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <div className="tk-ask-submit">
          <span className="tk-ask-key-hint">Enter to ask · Shift+Enter for a new line</span>
          <button
            type="button"
            className="tk-btn tk-btn-primary"
            disabled={!question.trim() || status === 'retrieving' || status === 'answering'}
            onClick={() => void ask()}
          >
            {canAsk ? 'Ask Claude' : 'Find threads'}
          </button>
        </div>
      </div>
      {!canAsk && (
        <p className="tk-settings-note">
          Without an API key this finds the most relevant threads.{' '}
          <button type="button" className="tk-linklike" onClick={onOpenSettings}>
            Add an Anthropic key
          </button>{' '}
          to get answers with citations.
        </p>
      )}
      {status === 'retrieving' && <div className="tk-muted">Finding relevant threads…</div>}
      {error && (
        <div className="tk-settings-result" data-ok="false" role="alert">
          {error}
        </div>
      )}
      {withheld > 0 && (
        <div className="tk-muted" role="status" style={{ fontSize: 12 }}>
          {withheld} local-only thread{withheld === 1 ? '' : 's'} matched but {withheld === 1 ? 'was' : 'were'} not sent to Claude.
        </div>
      )}
      {answer && (
        <div className="tk-ask-answer" aria-live="polite">
          {answer.split(/\n{2,}/).map((para, i) => (
            <p key={i}>{renderCitations(para, (idx) => sources[idx] && onSelectThread(sources[idx].threadKey), sources.length)}</p>
          ))}
          {status === 'answering' && <span className="tk-muted">…</span>}
        </div>
      )}
      {sources.length > 0 && (
        <div className="tk-ask-sources">
          <div className="tk-eyebrow" style={{ padding: 0 }}>
            {canAsk ? 'Sources' : 'Most relevant threads'}
          </div>
          {rerankNote && (
            <div className="tk-muted" role="status" style={{ fontSize: 12 }}>
              {rerankNote}
            </div>
          )}
          <ol>
            {sources.map((c, i) => {
              const insight = insights.get(c.threadKey) ?? null;
              return (
                <li key={c.threadKey}>
                  <button type="button" className="tk-row-btn tk-ask-source" onClick={() => onSelectThread(c.threadKey)}>
                    <div className="tk-row-main">
                      <div className="tk-row-title">
                        <span className="tk-cite-static">T{i + 1}</span> {getSmartTitle(c, insight) || getDisplayTitle(c)}
                      </div>
                      {insight?.gist && <div className="tk-row-gist">{insight.gist}</div>}
                      <div className="tk-row-meta">
                        <span>{providerLabel(c.provider)}</span>
                        <span>·</span>
                        <span>{c.project}</span>
                        <span>·</span>
                        <span>{relativeTime(c.updatedAt)}</span>
                      </div>
                    </div>
                  </button>
                </li>
              );
            })}
          </ol>
          {onSendToStill && status === 'done' && (() => {
            const keys = citedSourceKeys(answer, sources.map((c) => c.threadKey));
            return (
              <button type="button" className="tk-linklike tk-ask-send" onClick={() => onSendToStill(keys)}>
                Send {keys.length === 1 ? 'this thread' : `these ${keys.length} threads`} to Still…
              </button>
            );
          })()}
        </div>
      )}
    </div>
  );
}
