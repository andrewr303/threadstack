// Threadkeeper's side of the Still (Sidebar Dock) link in the manager: the Settings panel, the
// "Send to Still" target picker and dialog, and the "In Still" badge. Data comes from ./dock.ts.
//
// Consent decisions are never taken here: a pending request is reviewed only in the top-level
// connect.html window ("Review request…"), and Disconnect / option toggles are refused by the
// worker when the manager runs framed inside a website (the overlay), so the overlay explains that.

import React, { useEffect, useId, useState } from 'react';
import { expiresInLabel, groupedId } from '../connect/consent.js';
import { relativeTime } from './shared.js';
import {
  NEW_COLLECTION,
  describeSendOutcome,
  describeSyncPrefs,
  dockStatusSummary,
  openDockConsent,
  resyncDock,
  sendThreadsToStill,
  setDockOptions,
  stillBadgeText,
  stillTargetFromChoice,
  targetLabel,
  unblockDock,
  unpairDock,
  useStillCollections,
  useStillStatus,
  type CollectionsState,
  type DockStateView,
} from './dock.js';

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function isFramedPage(): boolean {
  try {
    return typeof window !== 'undefined' && window.top !== window.self;
  } catch {
    return true;
  }
}

function copy(text: string): Promise<boolean> {
  try {
    return navigator.clipboard ? navigator.clipboard.writeText(text).then(() => true, () => false) : Promise.resolve(false);
  } catch {
    return Promise.resolve(false);
  }
}

function DockToggle({
  checked,
  disabled,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="tk-toggle">
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="tk-toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

function DockSection({ title, note, children }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="tk-settings-section">
      <h3 className="tk-settings-h3">{title}</h3>
      {note && <p className="tk-settings-note">{note}</p>}
      {children}
    </section>
  );
}

type Line = { message: string | null; ok?: boolean };

/** This Threadkeeper's extension id, for pasting into Still when it cannot find Threadkeeper itself. */
function OwnId({ id }: { id: string }) {
  const [copied, setCopied] = useState<Line>({ message: null });
  if (!id) return <p className="tk-settings-note">The ID is shown when Threadkeeper runs as an extension.</p>;
  return (
    <>
      <div className="tk-field-row tk-dock-id-row">
        <code className="tk-dock-id" aria-label="This Threadkeeper's extension ID">
          {groupedId(id)}
        </code>
        <button
          type="button"
          className="tk-btn"
          onClick={() =>
            void copy(id).then((ok) =>
              setCopied(ok ? { message: 'ID copied.', ok: true } : { message: 'Copying is blocked here; select the ID and copy it.', ok: false })
            )
          }
        >
          Copy ID
        </button>
      </div>
      {copied.message && (
        <p className="tk-settings-note" role="status" data-ok={copied.ok}>
          {copied.message}
        </p>
      )}
    </>
  );
}

/** Settings → Sidebar Dock. */
export function SidebarDockPanel({
  state,
  loaded,
  onRefresh,
  framed = isFramedPage(),
  now = Date.now(),
}: {
  state: DockStateView | null;
  loaded: boolean;
  onRefresh: () => Promise<void> | void;
  framed?: boolean;
  now?: number;
}) {
  const [line, setLine] = useState<Line>({ message: null });
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  const act = async (label: string, work: () => Promise<{ ok: boolean; error?: string; message?: string }>) => {
    if (busy) return;
    setBusy(label);
    try {
      const res = await work();
      setLine(res.ok ? { message: res.message ?? null, ok: true } : { message: res.error ?? 'That did not work.', ok: false });
    } finally {
      setBusy(null);
      await onRefresh();
    }
  };

  const summary = dockStatusSummary(state);
  const ownId = state?.ownId ?? (typeof chrome !== 'undefined' && chrome.runtime?.id ? chrome.runtime.id : '');
  const framedNote = framed ? (
    <p className="tk-settings-note tk-dock-framed">
      To review requests, disconnect or change these options, open Threadkeeper in its own window (side panel or full
      page). Websites can frame this overlay, so Threadkeeper does not accept those changes here.
    </p>
  ) : null;

  if (!loaded) {
    return (
      <DockSection title="Sidebar Dock (Still)">
        <p className="tk-settings-note" aria-busy="true">
          Checking the connection…
        </p>
      </DockSection>
    );
  }

  const pending = state?.pending ?? null;
  const left = pending ? Math.max(0, Date.parse(pending.expiresAt) - now) : 0;
  const setOption = (patch: Parameters<typeof setDockOptions>[0]) =>
    void act('options', async () => {
      const res = await setDockOptions(patch);
      return res.ok ? { ok: true } : res;
    });

  return (
    <>
      <DockSection
        title="Sidebar Dock (Still)"
        note="Still is a separate sidebar extension. Connected, it keeps a copy of the threads it chooses as chats in its collections, and its assistant can search your threads. Still keeps working if Threadkeeper is off."
      >
        <p className="tk-dock-status" data-tone={summary.tone} role="status">
          <span className="tk-dock-dot" aria-hidden="true" data-on={Boolean(state?.paired)} />
          {summary.long}
        </p>
        {line.message && (
          <div className="tk-settings-result" data-ok={line.ok ?? true} role="status">
            {line.message}
          </div>
        )}
        {framedNote}

        {pending && (
          <div className="tk-dock-request" aria-label="Connection request">
            <dl className="tk-diag-grid">
              <dt>Asks as</dt>
              <dd>
                “{pending.appName}”{pending.appVersion ? ` ${pending.appVersion}` : ''}
              </dd>
              <dt>Extension ID</dt>
              <dd>
                <code>{groupedId(pending.senderId)}</code>
              </dd>
              <dt>Asked</dt>
              <dd>
                {relativeTime(pending.at)} · expires {expiresInLabel(left)}
              </dd>
            </dl>
            {pending.granted ? (
              <p className="tk-settings-note">You allowed it. Threadkeeper is waiting for Still to confirm; this finishes on its own.</p>
            ) : (
              <>
                <p className="tk-settings-note">
                  Review it in the Threadkeeper window: you type the 6-digit code Still shows, then allow or deny. Deny
                  blocks this extension until you unblock it below.
                </p>
                {!framed && (
                  <div className="tk-field-row">
                    <button
                      type="button"
                      className="tk-btn tk-btn-primary"
                      disabled={Boolean(busy)}
                      onClick={() =>
                        void act('review', async () => {
                          const res = await openDockConsent();
                          return res.ok ? { ok: true } : res;
                        })
                      }
                    >
                      Review request…
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {!state?.paired && !pending && (
          <p className="tk-settings-note">
            To connect, open Still: Settings → Integrations → AI chat threads → Find Threadkeeper. Threadkeeper then
            opens a window where you type the code Still shows. Nothing is shared until you allow it.
          </p>
        )}

        {state?.paired && (
          <dl className="tk-diag-grid tk-dock-facts">
            <dt>Connected to</dt>
            <dd>
              {state.pairedName || 'Still'} <code>{groupedId(state.pairedId)}</code>
            </dd>
            <dt>Since</dt>
            <dd>{state.pairedAt ? new Date(state.pairedAt).toLocaleString() : 'Unknown'}</dd>
            <dt>Last push</dt>
            <dd>{state.lastPushAt ? relativeTime(state.lastPushAt) : 'Nothing pushed yet'}</dd>
            <dt>In Still</dt>
            <dd className="tk-tabular">
              {plural(state.sent, 'thread')} sent
              {state.tracked ? ` · ${plural(state.tracked, 'thread')} added by hand or by Still` : ''}
              {state.queued ? ` · ${state.queued} waiting to go` : ''}
            </dd>
            {state.lastError && (
              <>
                <dt>Last problem</dt>
                <dd className="tk-dock-error">
                  {state.lastError}
                  {state.lastErrorAt ? ` (${relativeTime(state.lastErrorAt)})` : ''}
                </dd>
              </>
            )}
          </dl>
        )}
        {!state?.paired && state?.lastError && (
          <p className="tk-settings-note tk-dock-error">
            Last connection ended: {state.lastError}
            {state.lastErrorAt ? ` (${relativeTime(state.lastErrorAt)})` : ''}.
          </p>
        )}
      </DockSection>

      {state?.paired && (
        <DockSection
          title="What Still asked to sync"
          note="Still chooses this in its own settings (Settings → Integrations → AI chat threads). Private threads never sync, whatever Still asks."
        >
          <dl className="tk-diag-grid">
            {describeSyncPrefs(state.prefs, state.configured, state.shareTranscripts).map((row) => (
              <React.Fragment key={row.label}>
                <dt>{row.label}</dt>
                <dd>{row.value}</dd>
              </React.Fragment>
            ))}
          </dl>
        </DockSection>
      )}

      <DockSection
        title="What Still may use"
        note="Never shared: local-only threads, threads in local-only projects, providers excluded from cloud processing, and synthetic threads. Still may send what it receives to the AI provider chosen in Still."
      >
        <DockToggle
          checked={state?.allowSearch ?? true}
          disabled={framed || Boolean(busy)}
          onChange={(v) => setOption({ allowSearch: v })}
          label="Let Still search my threads"
          hint="Still's search and assistant can find and read shareable threads, including ones not synced."
        />
        <DockToggle
          checked={state?.shareTranscripts ?? true}
          disabled={framed || Boolean(busy)}
          onChange={(v) => setOption({ shareTranscripts: v })}
          label="Share full transcripts"
          hint="Off: Still gets titles and summaries only. Secrets in tool and system messages are always replaced with [redacted]."
        />
        <DockToggle
          checked={state?.allowRemoteModels ?? false}
          disabled={framed || Boolean(busy)}
          onChange={(v) => setOption({ allowRemoteModels: v })}
          label="Let Still's searches use my embedding and rerank providers"
          hint="Off: searches from Still run on-device only. On: Still's questions can reach the embedding and rerank services set in Search & embeddings."
        />
      </DockSection>

      {state?.paired && !framed && (
        <DockSection title="Connection">
          <div className="tk-field-row">
            <button
              type="button"
              className="tk-btn"
              disabled={Boolean(busy)}
              title="Offer every thread in Still's scope again, for example after restoring Still from a backup"
              onClick={() =>
                void act('resync', async () => {
                  const res = await resyncDock();
                  return res.ok
                    ? { ok: true, message: res.queued ? `Offering ${plural(res.queued, 'thread')} to Still again.` : 'Still is up to date.' }
                    : res;
                })
              }
            >
              {busy === 'resync' ? 'Resyncing…' : 'Resync'}
            </button>
            {!confirmDisconnect ? (
              <button type="button" className="tk-btn tk-btn-danger" disabled={Boolean(busy)} onClick={() => setConfirmDisconnect(true)}>
                Disconnect…
              </button>
            ) : (
              <span className="tk-dock-confirm" role="group" aria-label="Confirm disconnect">
                <span className="tk-settings-note">Still keeps the chats it has; nothing new is sent.</span>
                <button
                  type="button"
                  className="tk-btn tk-btn-danger"
                  disabled={Boolean(busy)}
                  onClick={() =>
                    void act('disconnect', async () => {
                      const res = await unpairDock();
                      setConfirmDisconnect(false);
                      return res.ok ? { ok: true, message: 'Disconnected from Still.' } : res;
                    })
                  }
                >
                  {busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}
                </button>
                <button type="button" className="tk-btn" onClick={() => setConfirmDisconnect(false)}>
                  Cancel
                </button>
              </span>
            )}
          </div>
        </DockSection>
      )}

      {state && state.blockedIds.length > 0 && (
        <DockSection title="Blocked extensions" note="You denied these. They cannot ask to connect until you unblock them.">
          <ul className="tk-dock-blocked">
            {state.blockedIds.map((id) => (
              <li key={id}>
                <code>{groupedId(id)}</code>
                {!framed && (
                  <button
                    type="button"
                    className="tk-btn"
                    disabled={Boolean(busy)}
                    onClick={() =>
                      void act('unblock', async () => {
                        const res = await unblockDock(id);
                        return res.ok ? { ok: true, message: 'Unblocked. It can ask to connect again.' } : res;
                      })
                    }
                  >
                    Unblock
                  </button>
                )}
              </li>
            ))}
          </ul>
        </DockSection>
      )}

      <DockSection
        title="This Threadkeeper's ID"
        note="If Still cannot find Threadkeeper by itself, paste this ID into Still's connect form."
      >
        <OwnId id={ownId} />
      </DockSection>
    </>
  );
}

// ---------------------------------------------------------------------------
// Target picker + Send to Still dialog
// ---------------------------------------------------------------------------

/** Still's default placement, an existing Still collection, or a new collection by name. */
export function StillTargetPicker({
  choice,
  newName,
  collections,
  onChoice,
  onNewName,
  compact = false,
}: {
  choice: string;
  newName: string;
  collections: CollectionsState;
  onChoice: (choice: string) => void;
  onNewName: (name: string) => void;
  compact?: boolean;
}) {
  const nameId = useId();
  const unavailable = collections.status === 'error';
  return (
    <>
      <select
        className={`tk-select${compact ? ' tk-bulk-target' : ''}`}
        aria-label="Where Still puts the threads"
        value={choice}
        onChange={(e) => onChoice(e.target.value)}
      >
        <option value="">Still's default placement</option>
        {collections.status === 'loading' && collections.collections.length === 0 && (
          <option value="" disabled>
            Loading Still's collections…
          </option>
        )}
        {unavailable && (
          <option value="" disabled>
            Still's collections are unavailable
          </option>
        )}
        {collections.collections.length > 0 && (
          <optgroup label="Collections in Still">
            {collections.collections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.path || c.name}
              </option>
            ))}
          </optgroup>
        )}
        <option value={NEW_COLLECTION}>New collection…</option>
      </select>
      {choice === NEW_COLLECTION && (
        <input
          id={nameId}
          type="text"
          className={`tk-input${compact ? ' tk-bulk-target' : ''}`}
          aria-label="Name of the new Still collection"
          placeholder="New collection name"
          maxLength={120}
          value={newName}
          onChange={(e) => onNewName(e.target.value)}
        />
      )}
    </>
  );
}

export interface SendRequest {
  threadKeys: string[];
  /** What is being sent, e.g. "this thread" or "12 search results". */
  label: string;
}

/** The modal behind every "Send to Still…" button except the bulk bar (which picks inline). */
export function SendToStillDialog({
  dialogRef,
  request,
  onClosed,
  onDone,
}: {
  dialogRef: React.MutableRefObject<HTMLDialogElement | null>;
  request: SendRequest | null;
  onClosed: () => void;
  onDone: (message: string) => void;
}) {
  const [choice, setChoice] = useState('');
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Line>({ message: null });
  const collections = useStillCollections(Boolean(request));

  useEffect(() => {
    setResult({ message: null });
    setBusy(false);
  }, [request]);

  const count = request?.threadKeys.length ?? 0;
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!request || busy) return;
    const target = stillTargetFromChoice(choice, newName);
    if (!target.ok) {
      setResult({ message: target.error, ok: false });
      return;
    }
    setBusy(true);
    setResult({ message: 'Sending…', ok: true });
    const outcome = await sendThreadsToStill(request.threadKeys, target.target);
    const text = describeSendOutcome(outcome, targetLabel(choice, newName, collections.collections));
    setBusy(false);
    setResult({ message: text.text, ok: text.ok });
    if (text.ok) {
      onDone(text.text);
      if (choice === NEW_COLLECTION) setNewName('');
    }
  };

  return (
    <dialog ref={dialogRef} id="tk-send-still-dialog" className="tk-modal-dialog" aria-labelledby="tk-send-still-title" onClose={onClosed}>
      <form onSubmit={(e) => void submit(e)}>
        <h2 id="tk-send-still-title" className="tk-section-h2" style={{ marginBottom: 8 }}>
          Send {request?.label ?? 'threads'} to Still
        </h2>
        <p className="tk-settings-note" style={{ marginTop: 0 }}>
          {count === 1 ? 'The thread arrives' : `The ${count} threads arrive`} in Still as chats with their summaries.
          Sending works whatever Still syncs on its own, and brings back a chat you deleted there. Local-only threads
          are never sent.
        </p>
        <div className="tk-field-row tk-send-still-target">
          <StillTargetPicker
            choice={choice}
            newName={newName}
            collections={collections}
            onChoice={setChoice}
            onNewName={setNewName}
          />
        </div>
        {collections.status === 'error' && (
          <p className="tk-settings-note">{collections.error} You can still send to Still's default placement.</p>
        )}
        {result.message && (
          <div className="tk-settings-result" data-ok={result.ok ?? true} role="status">
            {result.message}
          </div>
        )}
        <div className="tk-dialog-actions">
          <button type="button" className="tk-btn" onClick={() => dialogRef.current?.close()}>
            {result.ok && result.message && !busy && result.message !== 'Sending…' ? 'Close' : 'Cancel'}
          </button>
          <button type="submit" className="tk-btn tk-btn-primary" disabled={busy || count === 0}>
            {busy ? 'Sending…' : count === 1 ? 'Send' : `Send ${count}`}
          </button>
        </div>
      </form>
    </dialog>
  );
}

/** "In Still · <collection>" in the thread detail (cached DOCK_STATUS_FOR). Nothing when Still does not hold it. */
export function InStillBadge({ threadKey, paired, revision }: { threadKey: string; paired: boolean; revision?: unknown }) {
  const status = useStillStatus(threadKey, paired, revision);
  if (!paired || !status) return null;
  const text = stillBadgeText(status);
  return (
    <span
      className="tk-chip tk-chip-small tk-in-still"
      data-trashed={status.trashed}
      title={status.hasTranscript ? 'Still has this thread with its transcript' : 'Still has this thread (summary only)'}
    >
      {text}
    </span>
  );
}
