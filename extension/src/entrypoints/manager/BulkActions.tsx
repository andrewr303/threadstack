import React, { useEffect, useState } from 'react';
import type { ConversationRecord, LensSort, WorkflowState } from '../../core/schema.js';
import {
  UNFILED_PROJECT,
  applyBulkThreadEdit,
  deleteConversationsCascade,
  exportSelectedThreads,
  type BulkThreadPatch,
} from '../../core/db.js';
import { exportThreadToMarkdown, type PortableBundle } from '../../core/adapters.js';
import { normalizeTag, undoChangeLog } from '../../core/organization.js';
import { WORKFLOW_LABELS, openModal, sharedDb } from './shared.js';
import { LENS_SORT_LABELS, hitConversation, sortLens } from './workspace/lens.js';
import {
  NEW_COLLECTION,
  describeSendOutcome,
  dockSyncNow,
  sendThreadsToStill,
  stillTargetFromChoice,
  targetLabel,
  useStillCollections,
} from './dock.js';
import { StillTargetPicker } from './SidebarDock.js';

// ---- List order ----

export type ThreadSortMode = LensSort;

export const THREAD_SORT_LABELS: Record<ThreadSortMode, string> = LENS_SORT_LABELS;

/**
 * Order the list. 'recent' keeps the order the list already has (latest activity, or best
 * match while searching); the other modes are the shared lens orders. The sort is stable, so
 * ties keep the incoming order.
 */
export function sortThreadHits<T extends { conversation: ConversationRecord }>(
  hits: readonly T[],
  mode: ThreadSortMode,
  titleOf: (conv: ConversationRecord) => string
): T[] {
  if (mode === 'recent') return [...hits];
  return sortLens(hits, mode, hitConversation, titleOf);
}

// ---- Selection ----

/**
 * Check or uncheck one row. With an anchor (shift-click), every row from the anchor to
 * this one, in view order, takes the same state.
 */
export function selectRange(
  viewOrder: readonly string[],
  current: ReadonlySet<string>,
  anchorKey: string | null,
  targetKey: string,
  checked: boolean
): Set<string> {
  const next = new Set(current);
  const to = viewOrder.indexOf(targetKey);
  const from = anchorKey === null ? -1 : viewOrder.indexOf(anchorKey);
  const keys = from >= 0 && to >= 0 ? viewOrder.slice(Math.min(from, to), Math.max(from, to) + 1) : [targetKey];
  for (const key of keys) {
    if (checked) next.add(key);
    else next.delete(key);
  }
  return next;
}

/** The checkbox beside a row. It is not inside the row button, so checking never opens the thread. */
export function RowCheck({
  threadKey,
  title,
  checked,
  onToggle,
}: {
  threadKey: string;
  title: string;
  checked: boolean;
  onToggle: (threadKey: string, checked: boolean, extendRange: boolean) => void;
}) {
  return (
    <label className="tk-row-check">
      <input
        type="checkbox"
        aria-label={`Select ${title}`}
        checked={checked}
        onChange={(e) => {
          const native = e.nativeEvent;
          onToggle(threadKey, e.currentTarget.checked, native instanceof MouseEvent && native.shiftKey);
        }}
      />
    </label>
  );
}

// ---- Export ----

/** One Markdown handoff for several threads, each in the single-thread handoff format. */
export function bundleToMarkdown(bundle: PortableBundle): string {
  return bundle.conversations
    .map((entry) => exportThreadToMarkdown(entry.conversation, entry.messages, entry.summary))
    .join('\n\n---\n\n');
}

function downloadText(fileName: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- Bulk action bar ----

type BulkAction =
  | 'move'
  | 'status'
  | 'tag'
  | 'pin'
  | 'unpin'
  | 'local_on'
  | 'local_off'
  | 'export_markdown'
  | 'export_portable'
  | 'send_still';

const EDIT_ACTIONS: Array<[BulkAction, string]> = [
  ['move', 'Move to project'],
  ['status', 'Set status'],
  ['tag', 'Add tag'],
  ['pin', 'Pin'],
  ['unpin', 'Unpin'],
  ['local_on', 'Local-only on'],
  ['local_off', 'Local-only off'],
];

const EXPORT_ACTIONS: Array<[BulkAction, string]> = [
  ['export_markdown', 'Markdown handoff'],
  ['export_portable', 'Portable JSON'],
];

const SHARE_ACTIONS: Array<[BulkAction, string]> = [['send_still', 'Send to Still…']];

/** Edits that can make a thread private (or shareable again): Still must hear about them at once. */
export function bulkPatchAffectsPrivacy(patch: BulkThreadPatch): boolean {
  return patch.cloudExcluded !== undefined || patch.project !== undefined;
}

const WORKFLOW_STATES = Object.keys(WORKFLOW_LABELS) as WorkflowState[];

const threadCount = (n: number) => `${n} thread${n === 1 ? '' : 's'}`;

interface BulkResult {
  text: string;
  changeId: string | null;
  ok: boolean;
}

interface Props {
  /** Checked threads, including any the current filters hide. */
  selectedKeys: ReadonlySet<string>;
  /** Threads shown in the current view, in the order they are shown. */
  viewKeys: readonly string[];
  projectNames: readonly string[];
  selectAllRef: React.MutableRefObject<HTMLInputElement | null>;
  deleteDialogRef: React.MutableRefObject<HTMLDialogElement | null>;
  canEdit: () => boolean;
  onSelectionChange: (next: Set<string>) => void;
  /** After the library changed: reload, announce, and drop deleted threads from the selection. */
  onChanged: (message: string, deletedKeys: readonly string[]) => Promise<void>;
  onAnnounce: (message: string) => void;
  onDialogClosed: () => void;
  /** ThreadStack is connected to Still: offer "Send to Still…". */
  stillPaired?: boolean;
}

export function BulkActions({
  selectedKeys,
  viewKeys,
  projectNames,
  selectAllRef,
  deleteDialogRef,
  canEdit,
  onSelectionChange,
  onChanged,
  onAnnounce,
  onDialogClosed,
  stillPaired = false,
}: Props) {
  const [action, setAction] = useState<BulkAction>('move');
  // Empty until chosen: the most used project (first in the list) is offered first.
  const [projectTarget, setProjectTarget] = useState<string>('');
  const [statusTarget, setStatusTarget] = useState<WorkflowState>('active');
  const [tagDraft, setTagDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [stillChoice, setStillChoice] = useState('');
  const [stillNewName, setStillNewName] = useState('');
  const effectiveAction: BulkAction = action === 'send_still' && !stillPaired ? 'move' : action;
  const stillCollections = useStillCollections(effectiveAction === 'send_still' && selectedKeys.size > 0);

  const count = selectedKeys.size;
  const viewSet = new Set(viewKeys);
  const selectedInView = viewKeys.filter((k) => selectedKeys.has(k));
  const hiddenCount = count - selectedInView.length;
  const allInView = viewKeys.length > 0 && selectedInView.length === viewKeys.length;
  const someInView = selectedInView.length > 0 && !allInView;
  // Shown threads first, in view order, then any the filters hide.
  const orderedSelection = [...selectedInView, ...Array.from(selectedKeys).filter((k) => !viewSet.has(k))];
  const target = projectNames.includes(projectTarget) ? projectTarget : projectNames[0] ?? UNFILED_PROJECT;
  const tag = normalizeTag(tagDraft);

  useEffect(() => {
    if (selectAllRef.current) selectAllRef.current.indeterminate = someInView;
  });

  // A new selection starts without the previous action's result line (reset during render, not after it).
  const [renderedCount, setRenderedCount] = useState(count);
  if (renderedCount !== count) {
    setRenderedCount(count);
    if (renderedCount === 0 && count > 0) setResult(null);
  }

  // After Clear or Delete the bar's own controls are gone; keep focus in the list toolbar, or in
  // the search field when nothing is left in view.
  const focusSelectAll = () =>
    requestAnimationFrame(() => {
      const box = selectAllRef.current;
      if (box && !box.disabled) box.focus();
      else document.querySelector<HTMLInputElement>('#tk-main-list input[type="search"]')?.focus();
    });

  const run = async (work: () => Promise<{ text: string; changeId?: string | null; deletedKeys?: string[]; reload: boolean }>) => {
    if (busy || !canEdit()) return;
    setBusy(true);
    setResult({ text: 'Working…', changeId: null, ok: true });
    try {
      const done = await work();
      setResult({ text: done.text, changeId: done.changeId ?? null, ok: true });
      if (done.reload) await onChanged(done.text, done.deletedKeys ?? []);
      else onAnnounce(done.text);
    } catch (err) {
      const text = `That did not work: ${err instanceof Error ? err.message : String(err)}`;
      setResult({ text, changeId: null, ok: false });
      onAnnounce(text);
    } finally {
      setBusy(false);
    }
  };

  const edit = (patch: BulkThreadPatch, describe: (n: number) => string) =>
    run(async () => {
      const entry = await applyBulkThreadEdit(sharedDb, orderedSelection, patch, describe);
      if (!entry) return { text: 'Nothing changed: the selected threads no longer exist.', reload: true };
      dockSyncNow(
        entry.snapshots.map((snap) => snap.threadKey),
        { privacy: bulkPatchAffectsPrivacy(patch) }
      );
      return { text: `${entry.description}.`, changeId: entry.changeId, reload: true };
    });

  const exportAs = (format: 'markdown' | 'portable') =>
    run(async () => {
      const bundle = await exportSelectedThreads(sharedDb, orderedSelection);
      const day = new Date().toISOString().slice(0, 10);
      if (format === 'markdown') {
        downloadText(`threadstack-handoff-${day}.md`, bundleToMarkdown(bundle), 'text/markdown');
      } else {
        downloadText(`threadstack-selected-${day}.json`, JSON.stringify(bundle, null, 2), 'application/json');
      }
      const n = bundle.conversations.length;
      return {
        text: `Exported ${threadCount(n)} as ${format === 'markdown' ? 'a Markdown handoff' : 'Portable JSON'}.`,
        reload: false,
      };
    });

  const sendToStill = () =>
    run(async () => {
      const target = stillTargetFromChoice(stillChoice, stillNewName);
      if (!target.ok) throw new Error(target.error);
      const outcome = await sendThreadsToStill(orderedSelection, target.target);
      const line = describeSendOutcome(outcome, targetLabel(stillChoice, stillNewName, stillCollections.collections));
      if (!line.ok) throw new Error(line.text);
      if (stillChoice === NEW_COLLECTION) setStillNewName('');
      return { text: line.text, reload: false };
    });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    switch (effectiveAction) {
      case 'move':
        return void edit({ project: target }, (n) => `Moved ${threadCount(n)} to ${target} (locked)`);
      case 'status':
        return void edit({ workflowState: statusTarget }, (n) => `Set ${threadCount(n)} to ${WORKFLOW_LABELS[statusTarget]}`);
      case 'tag':
        if (!tag) return;
        setTagDraft('');
        return void edit({ addTags: [tag] }, (n) => `Tagged ${threadCount(n)} “${tag}”`);
      case 'pin':
        return void edit({ pinned: true }, (n) => `Pinned ${threadCount(n)}`);
      case 'unpin':
        return void edit({ pinned: false }, (n) => `Unpinned ${threadCount(n)}`);
      case 'local_on':
        return void edit({ cloudExcluded: true }, (n) => `Marked ${threadCount(n)} local-only`);
      case 'local_off':
        return void edit({ cloudExcluded: false }, (n) => `Turned off local-only for ${threadCount(n)}`);
      case 'export_markdown':
        return void exportAs('markdown');
      case 'export_portable':
        return void exportAs('portable');
      case 'send_still':
        return void sendToStill();
    }
  };

  const handleUndo = (changeId: string, text: string) =>
    void run(async () => {
      const undone = await sharedDb.changeLogs.get(changeId);
      const res = await undoChangeLog(sharedDb, changeId);
      // Undo can flip local-only or move threads between projects.
      if (res.restoredCount > 0) dockSyncNow(undone?.snapshots.map((snap) => snap.threadKey) ?? [], { privacy: true });
      return {
        text: res.restoredCount > 0 ? `Undid “${text.replace(/\.$/, '')}”.` : 'That change was already undone.',
        reload: true,
      };
    });

  const handleConfirmDelete = () => {
    const keys = [...orderedSelection];
    deleteDialogRef.current?.close();
    void run(async () => {
      const n = await deleteConversationsCascade(sharedDb, keys);
      dockSyncNow(keys, { privacy: true });
      focusSelectAll();
      return { text: `Deleted ${threadCount(n)}. Each left a tombstone.`, deletedKeys: keys, reload: true };
    });
  };

  const showBar = viewKeys.length > 0 || count > 0;
  const undoId = result?.changeId ?? null;

  return (
    <>
      {showBar && (
        <section className="tk-bulk-bar" aria-label="Select and change several threads" data-active={count > 0}>
          <div className="tk-bulk-head">
            <label className="tk-inline-check">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allInView}
                disabled={viewKeys.length === 0}
                onChange={(e) => {
                  const next = new Set(selectedKeys);
                  for (const k of viewKeys) {
                    if (e.currentTarget.checked) next.add(k);
                    else next.delete(k);
                  }
                  onSelectionChange(next);
                }}
              />
              Select all in view
            </label>
            {count > 0 && (
              <>
                <span className="tk-bulk-count tk-tabular">
                  {count} selected{hiddenCount > 0 ? ` · ${hiddenCount} not in view` : ''}
                </span>
                <button
                  type="button"
                  className="tk-btn"
                  onClick={() => {
                    onSelectionChange(new Set());
                    setResult(null);
                    focusSelectAll();
                  }}
                >
                  Clear
                </button>
                <button
                  type="button"
                  className="tk-btn tk-btn-danger tk-bulk-delete"
                  disabled={busy}
                  onClick={() => openModal(deleteDialogRef)}
                >
                  Delete…
                </button>
              </>
            )}
          </div>

          {count > 0 && (
            <form className="tk-bulk-form" onSubmit={handleSubmit}>
              <select
                className="tk-select"
                aria-label="Action for the selected threads"
                value={effectiveAction}
                onChange={(e) => setAction(e.target.value as BulkAction)}
              >
                <optgroup label="Change">
                  {EDIT_ACTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Export">
                  {EXPORT_ACTIONS.map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </optgroup>
                {stillPaired && (
                  <optgroup label="Share">
                    {SHARE_ACTIONS.map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </optgroup>
                )}
              </select>
              {effectiveAction === 'send_still' && (
                <StillTargetPicker
                  compact
                  choice={stillChoice}
                  newName={stillNewName}
                  collections={stillCollections}
                  onChoice={setStillChoice}
                  onNewName={setStillNewName}
                />
              )}
              {effectiveAction === 'move' && (
                <select
                  className="tk-select tk-bulk-target"
                  aria-label="Project to move the selected threads to"
                  value={target}
                  onChange={(e) => setProjectTarget(e.target.value)}
                >
                  {projectNames.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              )}
              {effectiveAction === 'status' && (
                <select
                  className="tk-select tk-bulk-target"
                  aria-label="Status for the selected threads"
                  value={statusTarget}
                  onChange={(e) => setStatusTarget(e.target.value as WorkflowState)}
                >
                  {WORKFLOW_STATES.map((state) => (
                    <option key={state} value={state}>
                      {WORKFLOW_LABELS[state]}
                    </option>
                  ))}
                </select>
              )}
              {effectiveAction === 'tag' && (
                <input
                  type="text"
                  className="tk-input tk-bulk-target"
                  aria-label="Tag to add to the selected threads"
                  placeholder="Tag"
                  value={tagDraft}
                  onChange={(e) => setTagDraft(e.target.value)}
                />
              )}
              <button
                type="submit"
                className="tk-btn tk-btn-primary"
                disabled={
                  busy ||
                  (effectiveAction === 'tag' && !tag) ||
                  (effectiveAction === 'send_still' && stillChoice === NEW_COLLECTION && !stillNewName.trim())
                }
              >
                {effectiveAction === 'export_markdown' || effectiveAction === 'export_portable'
                  ? 'Export'
                  : effectiveAction === 'send_still'
                    ? 'Send'
                    : 'Apply'}
              </button>
            </form>
          )}

          {result && (
            <p className="tk-bulk-result" data-ok={result.ok}>
              {result.text}
              {undoId && !busy && (
                <>
                  {' '}
                  <button type="button" className="tk-linklike" onClick={() => handleUndo(undoId, result.text)}>
                    Undo
                  </button>
                </>
              )}
            </p>
          )}
        </section>
      )}

      <dialog
        ref={deleteDialogRef}
        id="tk-bulk-delete-dialog"
        className="tk-modal-dialog"
        aria-label="Delete selected threads"
        onClose={onDialogClosed}
      >
        <h2 className="tk-section-h2" style={{ marginBottom: 8 }}>
          Delete {threadCount(count)}?
        </h2>
        <p className="tk-settings-note" style={{ marginTop: 0 }}>
          This removes {count === 1 ? 'the selected thread' : `all ${count} selected threads`}, with their messages,
          summaries and vectors, from your library. Each deletion leaves a tombstone, so capture and imports will not
          bring the thread back. This cannot be undone.
          {hiddenCount > 0 ? ` ${hiddenCount} of them ${hiddenCount === 1 ? 'is' : 'are'} not in the current view.` : ''}
        </p>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
          <button type="button" className="tk-btn" onClick={() => deleteDialogRef.current?.close()}>
            Cancel
          </button>
          <button
            type="button"
            className="tk-btn tk-btn-danger"
            disabled={busy || count === 0}
            onClick={handleConfirmDelete}
          >
            Delete {threadCount(count)}
          </button>
        </div>
      </dialog>
    </>
  );
}
