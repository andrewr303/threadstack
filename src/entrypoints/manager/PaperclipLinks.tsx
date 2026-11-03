import React from 'react';
import { parseThreadKey, type ConversationRecord } from '../../core/schema.js';
import { providerLabel } from '../../core/providers.js';

export interface SessionLink {
  threadKey: string;
  /** The linked thread when it is in the library. */
  conv: ConversationRecord | null;
  label: string;
}

/**
 * Threads linked to `conv`: for a Paperclip issue, the Claude Code / Codex sessions its agents ran
 * (imported or not yet); for a Claude Code / Codex session, the Paperclip issues that ran it.
 */
export function sessionLinks(conv: ConversationRecord, conversations: ConversationRecord[]): { kind: 'sessions' | 'issues'; links: SessionLink[] } {
  if (conv.provider === 'paperclip') {
    const byKey = new Map(conversations.map((c) => [c.threadKey, c]));
    const links = (conv.linkedThreadKeys ?? []).map((threadKey) => {
      const linked = byKey.get(threadKey) ?? null;
      const id = parseThreadKey(threadKey);
      const provider = providerLabel(linked?.provider ?? id?.provider ?? '');
      const name = linked ? linked.manualTitleOverride || linked.title : `session ${(id?.sourceConversationId ?? threadKey).slice(0, 8)}`;
      return { threadKey, conv: linked, label: `${provider} · ${name}` };
    });
    return { kind: 'sessions', links };
  }
  if (conv.provider === 'claude_code' || conv.provider === 'codex') {
    const links = conversations
      .filter((c) => c.provider === 'paperclip' && (c.linkedThreadKeys ?? []).includes(conv.threadKey))
      .map((c) => ({ threadKey: c.threadKey, conv: c, label: `Paperclip · ${c.manualTitleOverride || c.title}` }));
    return { kind: 'issues', links };
  }
  return { kind: 'sessions', links: [] };
}

/** "Linked session" note in the thread detail. */
export function PaperclipLinks({
  conv,
  conversations,
  onSelect,
}: {
  conv: ConversationRecord;
  conversations: ConversationRecord[];
  onSelect: (threadKey: string) => void;
}) {
  const { kind, links } = sessionLinks(conv, conversations);
  if (links.length === 0) return null;
  const missing = links.filter((l) => !l.conv);
  return (
    <div className="tk-filter-row" style={{ marginTop: 4 }} data-testid="paperclip-links">
      <span className="tk-eyebrow" style={{ padding: 0 }}>
        {kind === 'sessions' ? (links.length === 1 ? 'Linked session:' : 'Linked sessions:') : 'Run by Paperclip:'}
      </span>
      {links
        .filter((l) => l.conv)
        .map((l) => (
          <button key={l.threadKey} type="button" className="tk-btn" onClick={() => onSelect(l.threadKey)}>
            {l.label}
          </button>
        ))}
      {missing.length > 0 && (
        <span className="tk-muted" style={{ fontSize: 12 }}>
          {missing.map((l) => l.label).join(', ')} not imported yet. Import the session files (Import / Export) to link{' '}
          {missing.length === 1 ? 'it' : 'them'}.
        </span>
      )}
    </div>
  );
}
