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
import { providerLabel } from '../../core/providers.js';
import { getSmartTitle } from '../../core/insights.js';
import { relativeTime, renderCitations } from './shared.js';

interface Props {
  settings: SettingsRecord | null;
  conversations: ConversationRecord[];
  insights: Map<string, ThreadInsight>;
  messagesByThread: Map<string, MessageRecord[]>;
  vectors: Map<string, Map<string, number[]>>;
  searchIndex: MemorySearchIndex;
  onSelectThread: (threadKey: string) => void;
  onOpenSettings: () => void;
}

const MAX_SOURCES = 8;

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
}: Props) {
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [sources, setSources] = useState<ConversationRecord[]>([]);
  const [status, setStatus] = useState<'idle' | 'retrieving' | 'answering' | 'done' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const canAsk = settings ? hasClaudeKey(settings) : false;

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
    return Array.from(fused.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_SOURCES)
      .map(([k]) => byKey.get(k)!)
      .filter((c) => c && !c.isSyntheticBenchmark);
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
          placeholder="e.g. What did I decide about the pricing page headline? Which thread had the Stripe webhook fix?"
          value={question}
          rows={2}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask();
            }
          }}
        />
        <button
          type="button"
          className="tk-btn tk-btn-primary"
          disabled={!question.trim() || status === 'retrieving' || status === 'answering'}
          onClick={() => void ask()}
        >
          {canAsk ? 'Ask Claude' : 'Find threads'}
        </button>
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
        </div>
      )}
    </div>
  );
}
