import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { SettingsRecord } from '../../core/schema.js';
import {
  EMPTY_SYNC_STATE,
  SYNC_DEFAULT_DAYS,
  SYNC_PROVIDERS,
  type SyncProviderId,
  type SyncProviderState,
  type SyncState,
} from '../../core/history-sync.js';
import { HISTORY_SYNC_STATE_KEY } from '../../core/sync-env.js';
import { generateCatchUpBrief, loadLastBrief, saveLastBrief, type CatchUpBrief } from '../../core/catch-up.js';
import { hasClaudeKey } from '../../core/ai/claude.js';
import { sharedDb } from './shared.js';

interface Props {
  settings: SettingsRecord | null;
  /** Called when a run finishes with something new, so the library reloads and analysis starts. */
  onImported: (message: string) => Promise<void> | void;
  onOpenThread: (threadKey: string) => void;
}

const DAY_CHOICES = [7, 14, 30];

function hasRuntime(): boolean {
  return typeof chrome !== 'undefined' && typeof chrome.runtime?.sendMessage === 'function' && Boolean(chrome.storage?.local);
}

/** The latest run's progress: read once, then follow the service worker's updates. */
function useSyncState(): SyncState {
  const [state, setState] = useState<SyncState>(EMPTY_SYNC_STATE);
  useEffect(() => {
    if (!hasRuntime()) return;
    let alive = true;
    // Asking the service worker also repairs a run it lost when the browser restarted it.
    void chrome.runtime
      .sendMessage({ type: 'GET_HISTORY_SYNC_STATE' })
      .then((reply: { ok?: boolean; state?: SyncState } | undefined) => {
        if (alive && reply?.ok && reply.state) setState(reply.state);
      })
      .catch(() => undefined);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      const next = changes[HISTORY_SYNC_STATE_KEY]?.newValue as SyncState | undefined;
      if (area === 'local' && next && Array.isArray(next.providers)) setState(next);
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      alive = false;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, []);
  return state;
}

function progressOf(p: SyncProviderState): number {
  return p.stored + p.skipped + p.failed;
}

function statusLine(p: SyncProviderState): string {
  switch (p.status) {
    case 'queued':
      return 'Waiting';
    case 'opening':
      return 'Opening the site';
    case 'listing':
      return 'Finding recent conversations';
    case 'fetching':
      return `Reading ${progressOf(p)} of ${p.listed}`;
    case 'cancelled':
      return `Cancelled. ${p.stored} imported so far.`;
    case 'error':
      return p.message ?? 'Something went wrong.';
    case 'done': {
      const parts = [`${p.stored} imported`];
      if (p.skipped) parts.push(`${p.skipped} already up to date`);
      if (p.failed) parts.push(`${p.failed} could not be read`);
      return `Done: ${parts.join(', ')}.`;
    }
  }
}

function runSummary(state: SyncState): string {
  const stored = state.providers.reduce((n, p) => n + p.stored, 0);
  const sites = state.providers.filter((p) => p.stored > 0).map((p) => p.label);
  return stored > 0
    ? `Caught up on ${stored} conversation${stored === 1 ? '' : 's'} from ${sites.join(', ')}.`
    : 'Catch up finished. Nothing new to import.';
}

export function CatchUpSection({ settings, onImported, onOpenThread }: Props) {
  const sync = useSyncState();
  const [days, setDays] = useState(SYNC_DEFAULT_DAYS);
  const [selected, setSelected] = useState<Set<SyncProviderId>>(new Set(['chatgpt', 'claude']));
  const [startError, setStartError] = useState<string | null>(null);
  const [brief, setBrief] = useState<CatchUpBrief | null>(null);
  const [briefBusy, setBriefBusy] = useState(false);
  const [briefError, setBriefError] = useState<string | null>(null);
  const [titles, setTitles] = useState<Map<string, string>>(new Map());
  const wasRunning = useRef(false);

  const available = SYNC_PROVIDERS.filter((p) => settings?.authorizedHosts[p.id] !== false);
  const complete = available.filter((p) => p.strategy === 'api');
  const slower = available.filter((p) => p.strategy === 'sidebar');

  // A run that just finished brings new threads in: reload the library and start analysis.
  useEffect(() => {
    if (wasRunning.current && !sync.running && sync.runId) {
      if (sync.providers.some((p) => p.stored > 0)) void onImported(runSummary(sync));
    }
    wasRunning.current = sync.running;
  }, [sync, onImported]);

  useEffect(() => {
    let alive = true;
    void loadLastBrief().then((b) => alive && b && setBrief(b));
    return () => {
      alive = false;
    };
  }, []);

  // Thread titles for the brief's links.
  useEffect(() => {
    if (!brief) return;
    const keys = Array.from(new Set([...brief.workstreams.flatMap((w) => w.threadKeys), ...brief.looseEnds.map((l) => l.threadKey)]));
    let alive = true;
    void sharedDb.conversations.bulkGet(keys).then((rows) => {
      if (!alive) return;
      setTitles(new Map(rows.flatMap((c) => (c ? [[c.threadKey, c.manualTitleOverride || c.title] as [string, string]] : []))));
    });
    return () => {
      alive = false;
    };
  }, [brief]);

  const toggle = (id: SyncProviderId, on: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });

  const start = useCallback(async () => {
    setStartError(null);
    if (!hasRuntime()) return setStartError('Catch up needs the extension running.');
    try {
      const reply = (await chrome.runtime.sendMessage({ type: 'START_HISTORY_SYNC', providers: Array.from(selected), days })) as
        | { ok?: boolean; error?: string }
        | undefined;
      if (!reply?.ok) setStartError(reply?.error ?? 'Catch up could not start.');
    } catch {
      setStartError('Could not reach the extension. Reload it and try again.');
    }
  }, [selected, days]);

  const cancel = () => void chrome.runtime.sendMessage({ type: 'CANCEL_HISTORY_SYNC' }).catch(() => undefined);

  const writeBrief = async () => {
    if (!settings) return;
    setBriefBusy(true);
    setBriefError(null);
    try {
      const next = await generateCatchUpBrief(sharedDb, settings, { days });
      setBrief(next);
      await saveLastBrief(next);
    } catch (err) {
      setBriefError(`Could not write the brief: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBriefBusy(false);
    }
  };

  const claude = settings ? hasClaudeKey(settings) : false;
  const title = (key: string) => titles.get(key) ?? 'Conversation';
  const stillSummarizing = Boolean(brief?.looseEnds.some((l) => l.text.includes('no summary yet')));

  return (
    <section className="tk-settings-section" aria-labelledby="tk-catchup-h">
      <h3 className="tk-settings-h3" id="tk-catchup-h">
        Catch up from your accounts
      </h3>
      <p className="tk-settings-note">
        Pull your recent conversations straight from the sites you are signed in to, with no export. Threadkeeper reads
        through your own signed-in session in this browser, one conversation at a time, and only reads. Each one is then
        summarized and filed like any other thread.
      </p>

      <div className="tk-field-row">
        <label className="tk-field">
          How far back
          <select className="tk-select" value={days} disabled={sync.running} onChange={(e) => setDays(Number(e.target.value))}>
            {DAY_CHOICES.map((d) => (
              <option key={d} value={d}>
                Last {d} days
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="tk-catchup-providers" role="group" aria-label="Sites to catch up on">
        {complete.map((p) => (
          <label key={p.id} className="tk-toggle">
            <input type="checkbox" checked={selected.has(p.id)} disabled={sync.running} onChange={(e) => toggle(p.id, e.target.checked)} />
            <span>
              {p.label}
              <span className="tk-toggle-hint">{p.note}</span>
            </span>
          </label>
        ))}
      </div>
      {slower.length > 0 && (
        <details className="tk-catchup-more">
          <summary className="tk-muted">Other sites (slower)</summary>
          <p className="tk-settings-note">
            These sites do not offer a history Threadkeeper can read directly, so it opens each recent conversation in a
            background tab for a few seconds and closes it. They need to be signed in too.
          </p>
          <div className="tk-catchup-providers">
            {slower.map((p) => (
              <label key={p.id} className="tk-toggle">
                <input type="checkbox" checked={selected.has(p.id)} disabled={sync.running} onChange={(e) => toggle(p.id, e.target.checked)} />
                <span>
                  {p.label}
                  <span className="tk-toggle-hint">{p.note}</span>
                </span>
              </label>
            ))}
          </div>
        </details>
      )}

      <div className="tk-field-row">
        {sync.running ? (
          <button type="button" className="tk-btn" onClick={cancel}>
            Cancel
          </button>
        ) : (
          <button type="button" className="tk-btn tk-btn-primary" disabled={selected.size === 0 || !settings} onClick={() => void start()}>
            Catch up
          </button>
        )}
      </div>

      {startError && (
        <div className="tk-settings-result" data-ok="false" role="alert">
          {startError}
        </div>
      )}

      {sync.providers.length > 0 && (
        <ul className="tk-sync-list" aria-live="polite" aria-label="Catch up progress">
          {sync.providers.map((p) => (
            <li key={p.provider} data-status={p.status}>
              <span className="tk-sync-name">{p.label}</span>
              <span className="tk-sync-status">{statusLine(p)}</span>
              {p.status === 'fetching' && p.listed > 0 && <progress className="tk-sync-bar" max={p.listed} value={progressOf(p)} aria-label={`${p.label} progress`} />}
            </li>
          ))}
        </ul>
      )}

      {!sync.running && sync.runId && sync.providers.length > 0 && (
        <div className="tk-catchup-brief-controls">
          <p className="tk-settings-note">
            {claude
              ? 'Claude writes the brief from titles and summaries only, never message text. Local-only threads stay on this device.'
              : 'The brief is built on this device from the summaries Threadkeeper wrote. Add a Claude key in Settings for a written one.'}
          </p>
          <div className="tk-field-row">
            <button type="button" className="tk-btn" disabled={briefBusy} onClick={() => void writeBrief()}>
              {briefBusy ? 'Writing…' : brief ? 'Write a new brief' : 'Write catch-up brief'}
            </button>
          </div>
        </div>
      )}
      {briefError && (
        <div className="tk-settings-result" data-ok="false" role="alert">
          {briefError}
        </div>
      )}

      {brief && (
        <article className="tk-brief" aria-label="Catch-up brief">
          <h4 className="tk-brief-h">{brief.headline}</h4>
          <p className="tk-settings-note">
            {brief.source === 'claude' ? `Written by ${brief.model ?? 'Claude'}` : 'Built on this device'} ·{' '}
            {new Date(brief.generatedAt).toLocaleString()}
          </p>
          {brief.note && <p className="tk-settings-note">{brief.note}</p>}
          {stillSummarizing && (
            <p className="tk-settings-note">Some threads are still being summarized in the background. Write the brief again in a few minutes for a fuller one.</p>
          )}
          {brief.workstreams.map((w) => (
            <section key={w.name} className="tk-brief-ws">
              <h5 className="tk-brief-ws-h">{w.name}</h5>
              {w.where && <p className="tk-brief-where">{w.where}</p>}
              {w.openLoops.length > 0 && (
                <>
                  <p className="tk-brief-label">Open loops</p>
                  <ul>
                    {w.openLoops.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </>
              )}
              {w.nextSteps.length > 0 && (
                <>
                  <p className="tk-brief-label">Next steps</p>
                  <ul>
                    {w.nextSteps.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ul>
                </>
              )}
              <p className="tk-brief-threads">
                {w.threadKeys.slice(0, 6).map((key) => (
                  <button key={key} type="button" className="tk-linklike" onClick={() => onOpenThread(key)}>
                    {title(key)}
                  </button>
                ))}
                {w.threadKeys.length > 6 && <span className="tk-muted"> +{w.threadKeys.length - 6} more</span>}
              </p>
            </section>
          ))}
          {brief.looseEnds.length > 0 && (
            <section className="tk-brief-ws">
              <h5 className="tk-brief-ws-h">Loose ends</h5>
              <ul>
                {brief.looseEnds.slice(0, 12).map((l) => (
                  <li key={`${l.threadKey}:${l.text}`}>
                    <button type="button" className="tk-linklike" onClick={() => onOpenThread(l.threadKey)}>
                      {l.text}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </article>
      )}
    </section>
  );
}
