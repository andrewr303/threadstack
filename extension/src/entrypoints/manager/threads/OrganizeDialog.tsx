import React from 'react';
import type { OrganizeProposalItem } from '../../../core/organization.js';

export interface OrganizeDialogProps {
  dialogRef: React.MutableRefObject<HTMLDialogElement | null>;
  instruction: string;
  proposals: OrganizeProposalItem[];
  notes: string[];
  /** Progress text while planning or auto-organizing; null when idle. */
  busy: string | null;
  /** Proposals the user unticked, by thread key. */
  deselected: Set<string>;
  /** Hosted planning is offered only with an Anthropic key. */
  aiReady: boolean;
  onInstructionChange: (value: string) => void;
  onPreview: () => void;
  onPlanWithClaude: () => void | Promise<void>;
  onToggleProposal: (threadKey: string, included: boolean) => void;
  onApply: () => void | Promise<void>;
  onClosed: () => void;
}

/** Organize (natural language, Claude-planned, or automatic): review proposals, then apply. */
export function OrganizeDialog({
  dialogRef,
  instruction,
  proposals,
  notes,
  busy,
  deselected,
  aiReady,
  onInstructionChange,
  onPreview,
  onPlanWithClaude,
  onToggleProposal,
  onApply,
  onClosed,
}: OrganizeDialogProps) {
  return (
    <dialog
      ref={dialogRef}
      id="tk-organize-dialog"
      className="tk-modal-dialog tk-modal-wide"
      aria-label="Organize conversations"
      onClose={onClosed}
    >
      <h2 className="tk-section-h2" style={{ marginBottom: 8 }}>
        Organize conversations
      </h2>
      <p className="tk-settings-note" style={{ marginTop: 0 }}>
        Describe what you want, or run Auto-organize. Nothing changes until you apply, and every apply can be undone.
      </p>
      <div className="tk-field-row" style={{ marginBottom: 12 }}>
        <input
          type="text"
          className="tk-input tk-grow"
          aria-label="Natural language organization instruction"
          placeholder="e.g. Put my Daydock logo threads in Daydock / Meridian, but keep the homepage research separate"
          value={instruction}
          onChange={(e) => onInstructionChange(e.target.value)}
        />
        <button type="button" className="tk-btn" disabled={Boolean(busy)} onClick={onPreview}>
          Preview
        </button>
        {aiReady && (
          <button type="button" className="tk-btn tk-btn-primary" disabled={Boolean(busy)} onClick={() => void onPlanWithClaude()}>
            Plan with Claude
          </button>
        )}
      </div>
      {(busy || notes.length > 0) && (
        <div className="tk-settings-result" role="status">
          {busy ?? notes.join(' ')}
        </div>
      )}

      <div className="tk-proposal-list">
        {proposals.length === 0 ? (
          <div className="tk-empty-line">
            {busy ? 'Working…' : 'No changes proposed yet.'}
          </div>
        ) : (
          proposals.map((p) => (
            <label key={p.threadKey} className="tk-proposal" data-excluded={p.excludedByInstruction}>
              {!p.excludedByInstruction && (
                <input
                  type="checkbox"
                  checked={!deselected.has(p.threadKey)}
                  onChange={(e) => onToggleProposal(p.threadKey, e.target.checked)}
                />
              )}
              <span>
                <span className="tk-proposal-title">{p.title}</span>
                <span className="tk-proposal-detail">
                  {p.excludedByInstruction ? (
                    <>Excluded — {p.reason}</>
                  ) : (
                    <>
                      {p.currentProject} → <strong>{p.proposedProject ?? `${p.currentProject} (unchanged)`}</strong>
                      {p.newProject ? <span className="tk-auto-mark"> new project</span> : null}
                      {p.proposedState ? ` · status: ${p.proposedState}` : ''}
                      {p.proposedTags.length ? ` · tags: ${p.proposedTags.join(', ')}` : ''} ({p.reason})
                    </>
                  )}
                </span>
              </span>
            </label>
          ))
        )}
      </div>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button type="button" className="tk-btn" onClick={() => dialogRef.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className="tk-btn tk-btn-primary"
          disabled={Boolean(busy) || proposals.length === 0}
          onClick={() => void onApply()}
        >
          Apply changes
        </button>
      </div>
    </dialog>
  );
}
