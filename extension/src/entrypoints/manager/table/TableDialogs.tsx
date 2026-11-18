// The Table view's dialogs: define or edit a column, have Claude draft columns, and confirm a
// Claude run before it starts (what it reads, what it leaves alone, and roughly what it costs).
import React, { useEffect, useState } from 'react';
import { TABLE_COLUMN_TYPES, type TableColumnRecord, type TableColumnType } from '../../../core/schema.js';
import { MAX_INSTRUCTIONS, TABLE_COLUMN_TYPE_LABELS, isChoiceType, type TableColumnDraft } from '../../../core/thread-table.js';
import type { ColumnProposal, FillPlan } from '../../../core/table-fill.js';

type DialogRef = React.MutableRefObject<HTMLDialogElement | null>;

/** What the column dialog starts from: an existing column, a proposal, or nothing. */
export type ColumnDialogSeed = { mode: 'create'; draft?: TableColumnDraft } | { mode: 'edit'; column: TableColumnRecord };

const optionsText = (options: readonly string[] | undefined) => (options ?? []).join('\n');
const parseOptions = (text: string) => text.split(/\n|,/).map((o) => o.trim()).filter(Boolean);

export function ColumnDialog({
  dialogRef,
  seed,
  onSave,
  onClosed,
}: {
  dialogRef: DialogRef;
  seed: ColumnDialogSeed | null;
  /** Throws (with a message for the person) when the column cannot be saved. */
  onSave: (draft: TableColumnDraft, seed: ColumnDialogSeed) => Promise<void>;
  onClosed: () => void;
}) {
  const [name, setName] = useState('');
  const [type, setType] = useState<TableColumnType>('select');
  const [options, setOptions] = useState('');
  const [instructions, setInstructions] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!seed) return;
    const source = seed.mode === 'edit' ? seed.column : seed.draft;
    setName(source?.name ?? '');
    setType(source?.type ?? 'select');
    setOptions(optionsText(source?.options));
    setInstructions(source?.instructions ?? '');
    setError(null);
  }, [seed]);

  const editing = seed?.mode === 'edit';
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!seed) return;
    setSaving(true);
    setError(null);
    try {
      await onSave({ name, type, options: isChoiceType(type) ? parseOptions(options) : [], instructions }, seed);
      dialogRef.current?.close();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <dialog ref={dialogRef} className="tk-modal-dialog tk-table-dialog" aria-labelledby="tk-table-column-title" onClose={onClosed}>
      <form onSubmit={(e) => void submit(e)}>
        <h2 className="tk-section-h2" id="tk-table-column-title">
          {editing ? 'Edit column' : 'New column'}
        </h2>
        <div className="tk-table-form">
          <label className="tk-field">
            <span>Name</span>
            <input className="tk-input" value={name} maxLength={60} required autoFocus onChange={(e) => setName(e.target.value)} placeholder="e.g. Category" />
          </label>
          <label className="tk-field">
            <span>Values</span>
            <select className="tk-select" value={type} disabled={editing} onChange={(e) => setType(e.target.value as TableColumnType)}>
              {TABLE_COLUMN_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TABLE_COLUMN_TYPE_LABELS[t]}
                </option>
              ))}
            </select>
            {editing && <span className="tk-table-hint">A column keeps the kind of values it was made with.</span>}
          </label>
          {isChoiceType(type) && (
            <label className="tk-field">
              <span>Choices, one per line</span>
              <textarea className="tk-input" rows={4} value={options} onChange={(e) => setOptions(e.target.value)} placeholder={'Bug\nFeature\nResearch'} />
              <span className="tk-table-hint">Leave empty and Claude names the choices the first time it fills the column.</span>
            </label>
          )}
          <label className="tk-field">
            <span>What belongs here (Claude reads this when it fills the column)</span>
            <textarea
              className="tk-input"
              rows={3}
              maxLength={MAX_INSTRUCTIONS}
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="e.g. The part of the product the thread is about. Use Billing for anything involving Stripe."
            />
          </label>
        </div>
        {error && (
          <p className="tk-table-error" role="alert">
            {error}
          </p>
        )}
        <div className="tk-dialog-actions">
          <button type="button" className="tk-btn" onClick={() => dialogRef.current?.close()}>
            Cancel
          </button>
          <button type="submit" className="tk-btn tk-btn-primary" disabled={saving}>
            {editing ? 'Save column' : 'Add column'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

export function SuggestColumnsDialog({
  dialogRef,
  busy,
  error,
  proposals,
  added,
  threadsRead,
  onSuggest,
  onAdd,
  onEdit,
  onClosed,
}: {
  dialogRef: DialogRef;
  busy: boolean;
  error: string | null;
  proposals: ColumnProposal[];
  /** Names of proposals already added. */
  added: ReadonlySet<string>;
  threadsRead: number;
  onSuggest: (request: string) => void;
  onAdd: (proposal: ColumnProposal) => void;
  onEdit: (proposal: ColumnProposal) => void;
  onClosed: () => void;
}) {
  const [request, setRequest] = useState('');
  return (
    <dialog ref={dialogRef} className="tk-modal-dialog tk-modal-wide tk-table-dialog" aria-labelledby="tk-table-suggest-title" onClose={onClosed}>
      <h2 className="tk-section-h2" id="tk-table-suggest-title">
        Columns from Claude
      </h2>
      <p className="tk-settings-note">
        Describe a column you want, or leave this empty and Claude proposes a few from your recent threads. It reads titles and summaries of
        threads that may leave this browser, never local-only ones. Nothing is added until you choose.
      </p>
      <form
        className="tk-field-row"
        onSubmit={(e) => {
          e.preventDefault();
          onSuggest(request);
        }}
      >
        <input
          className="tk-input tk-grow"
          aria-label="Describe the column you want"
          placeholder="e.g. whether the thread ended with code that shipped"
          value={request}
          onChange={(e) => setRequest(e.target.value)}
        />
        <button type="submit" className="tk-btn tk-btn-primary" disabled={busy}>
          {busy ? 'Asking Claude…' : request.trim() ? 'Draft column' : 'Suggest columns'}
        </button>
      </form>
      {error && (
        <p className="tk-table-error" role="alert">
          {error}
        </p>
      )}
      {proposals.length > 0 && (
        <>
          <p className="tk-table-hint" role="status">
            Based on {threadsRead} recent {threadsRead === 1 ? 'thread' : 'threads'}.
          </p>
          <ul className="tk-table-proposals">
            {proposals.map((p) => (
              <li key={p.name} className="tk-table-proposal">
                <div className="tk-table-proposal-text">
                  <strong>{p.name}</strong>
                  <span className="tk-table-hint">
                    {TABLE_COLUMN_TYPE_LABELS[p.type]}
                    {p.options.length ? `: ${p.options.join(', ')}` : ''}
                  </span>
                  {p.instructions && <span>{p.instructions}</span>}
                  {p.why && <span className="tk-table-hint">{p.why}</span>}
                </div>
                <div className="tk-table-proposal-actions">
                  {added.has(p.name) ? (
                    <span className="tk-table-hint">Added</span>
                  ) : (
                    <>
                      <button type="button" className="tk-btn tk-btn-quiet" onClick={() => onEdit(p)}>
                        Edit first
                      </button>
                      <button type="button" className="tk-btn" onClick={() => onAdd(p)}>
                        Add column
                      </button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <div className="tk-dialog-actions">
        <button type="button" className="tk-btn" onClick={() => dialogRef.current?.close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}

const usd = (n: number) => (n < 0.01 ? 'under $0.01' : `about $${n.toFixed(2)}`);

export function FillConfirmDialog({
  dialogRef,
  plan,
  modelLabel,
  onConfirm,
  onClosed,
}: {
  dialogRef: DialogRef;
  plan: FillPlan | null;
  modelLabel: string;
  onConfirm: (plan: FillPlan) => void;
  onClosed: () => void;
}) {
  const n = plan?.threadKeys.length ?? 0;
  const left: string[] = [];
  if (plan?.keptManual) left.push(`${plan.keptManual} ${plan.keptManual === 1 ? 'value' : 'values'} you set by hand`);
  if (plan?.alreadyFilled) left.push(`${plan.alreadyFilled} Claude already filled`);
  if (plan?.skippedLocalOnly) left.push(`${plan.skippedLocalOnly} local-only ${plan.skippedLocalOnly === 1 ? 'thread' : 'threads'}`);
  return (
    <dialog ref={dialogRef} className="tk-modal-dialog tk-table-dialog" aria-labelledby="tk-table-fill-title" onClose={onClosed}>
      <h2 className="tk-section-h2" id="tk-table-fill-title">
        {plan?.mode === 'refresh' ? 'Refill' : 'Fill'} “{plan?.column.name}” with Claude
      </h2>
      {plan && (
        <>
          <p>
            Claude reads the summaries of {n} {n === 1 ? 'thread' : 'threads'} in {plan.requests} {plan.requests === 1 ? 'request' : 'requests'} with{' '}
            {modelLabel}. Estimated cost: {usd(plan.estimatedUsd)}.
          </p>
          {left.length > 0 && <p className="tk-table-hint">Left as they are: {left.join(', ')}.</p>}
          <p className="tk-table-hint">You can stop at any time; values written so far stay, and you can change any of them by hand.</p>
        </>
      )}
      <div className="tk-dialog-actions">
        <button type="button" className="tk-btn" onClick={() => dialogRef.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className="tk-btn tk-btn-primary"
          disabled={!plan || n === 0}
          onClick={() => {
            if (!plan) return;
            dialogRef.current?.close();
            onConfirm(plan);
          }}
        >
          Fill {n} {n === 1 ? 'cell' : 'cells'}
        </button>
      </div>
    </dialog>
  );
}
