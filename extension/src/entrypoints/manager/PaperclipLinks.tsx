import React, { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { parseThreadKey, type ConversationRecord } from '../../core/schema.js';
import { providerLabel } from '../../core/providers.js';
import { PaperclipTaskLinks } from './PaperclipTaskLinks.js';
import { openModal } from './shared.js';
import { Icon } from './shell/icons.js';
import { useOptionalWorkspaceContext } from './workspace/context.js';

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

interface PaperclipLinksProps {
  conv: ConversationRecord;
  conversations: ConversationRecord[];
  onSelect: (threadKey: string) => void;
  /** Full-page thread controls keep the picker in a native dialog, outside the live-page header. */
  compact?: boolean;
}

/** "Linked session" note in the thread detail; the full page opens it from its controls row. */
export function PaperclipLinks({ compact, ...props }: PaperclipLinksProps) {
  return compact ? <ThreadLinksDialog {...props} /> : <ThreadLinksContent {...props} />;
}

function ThreadLinksDialog(props: PaperclipLinksProps) {
  const workspace = useOptionalWorkspaceContext();
  const [open, setOpen] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  const dialogId = useId();
  const dismiss = (focus = true) => { restoreFocus.current = focus; setOpen(false); };
  useEffect(() => {
    restoreFocus.current = false;
    setOpen(false);
  }, [props.conv.threadKey, workspace?.view]);
  useEffect(() => {
    if (open) openModal(dialogRef);
    else if (restoreFocus.current) { restoreFocus.current = false; triggerRef.current?.focus(); }
  }, [open]);
  if (props.conv.provider === 'paperclip' && sessionLinks(props.conv, props.conversations).links.length === 0) return null;
  return <>
    <button ref={triggerRef} type="button" className="tk-btn tk-thr-action" aria-label="Task links" title="Task links" aria-haspopup="dialog" aria-expanded={open} aria-controls={dialogId} onClick={() => setOpen(true)}>
      <Icon name="pullRequest" size={14} />
      <span className="tk-thr-action-label">Task links</span>
    </button>
    {open && createPortal(
      <dialog ref={dialogRef} id={dialogId} className="tk-modal-dialog tk-thread-links-dialog" aria-label="Task and session links" onClose={() => dismiss()} onCancel={event => { event.preventDefault(); dismiss(); }}>
        <h2 className="tk-section-h2">Task and session links</h2>
        <div className="tk-thread-links-content">
          <ThreadLinksContent {...props} onSelect={threadKey => { dismiss(false); props.onSelect(threadKey); }} onNavigate={() => dismiss(false)} />
        </div>
        <div className="tk-dialog-actions"><button type="button" className="tk-btn" onClick={() => dismiss()}>Close</button></div>
      </dialog>, document.body
    )}
  </>;
}

function ThreadLinksContent({
  conv,
  conversations,
  onSelect,
  onNavigate,
}: PaperclipLinksProps & {
  onNavigate?: () => void;
}) {
  const { kind, links } = sessionLinks(conv, conversations);
  if (links.length === 0) return <PaperclipTaskLinks conv={conv} onNavigate={onNavigate} />;
  const missing = links.filter((l) => !l.conv);
  return (
    <><div className="tk-filter-row" style={{ marginTop: 4 }} data-testid="paperclip-links">
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
    </div><PaperclipTaskLinks conv={conv} onNavigate={onNavigate} /></>
  );
}
