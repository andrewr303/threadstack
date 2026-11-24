import React, { useCallback, useEffect, useId, useRef, useState } from 'react';
import { DEFAULT_PAPERCLIP_URL, type PaperclipSettings as PaperclipSettingsRecord, type SettingsRecord } from '../../core/schema.js';
import {
  PaperclipClient,
  PaperclipError,
  discoverServer,
  isLoopbackServer,
  normalizeServerUrl,
  probeServer,
  type PcCompany,
} from '../../core/paperclip/client.js';
import { looksLikeBoardKey, revokeBoardKey, signInWithApproval, verifyBoardKey } from '../../core/paperclip/auth.js';
import {
  EMPTY_PAPERCLIP_STATE,
  PAPERCLIP_STATE_KEY,
  chromeStateStore,
  describeSyncResult,
  normalizeSyncState,
  type PaperclipSyncState,
} from '../../core/paperclip/sync.js';
import { relativeTime } from './shared.js';
import { paperclipPermissionOrigins } from '../../core/host-access.js';
import { PaperclipConnectionRow } from './PaperclipConnection.js';
import { PaperclipBridgeSettings } from './PaperclipBridgeSettings.js';
import { PaperclipCredentials } from './PaperclipCredentials.js';

type Note = { message: string | null; ok?: boolean };

/** A sync whose worker stopped mid-way leaves running: true behind; treat it as over after a while. */
const STALE_RUN_MS = 6 * 60_000;

export function isSyncRunning(state: PaperclipSyncState, now = Date.now()): boolean {
  return state.running && now - (Date.parse(state.runningSince) || 0) < STALE_RUN_MS;
}

/** Short status for the settings navigation. */
export function paperclipSectionStatus(pc: PaperclipSettingsRecord, state: PaperclipSyncState | null): { text: string; tone?: 'danger' } {
  if (!pc.enabled) return { text: 'Off' };
  if (pc.deploymentMode === 'authenticated' && (pc.auth !== 'board_key' || !pc.apiKey)) return { text: 'Sign in', tone: 'danger' };
  if (state?.lastError) return { text: 'Error', tone: 'danger' };
  return { text: 'On' };
}

export { paperclipPermissionOrigins };

/** Persisted sync state, kept live through chrome.storage change events. */
export function usePaperclipSyncState(): PaperclipSyncState {
  const [state, setState] = useState<PaperclipSyncState>(EMPTY_PAPERCLIP_STATE);
  useEffect(() => {
    let alive = true;
    void chromeStateStore()
      .load()
      .then((s) => alive && setState(s))
      .catch(() => undefined);
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && changes[PAPERCLIP_STATE_KEY]) setState(normalizeSyncState(changes[PAPERCLIP_STATE_KEY].newValue));
    };
    const events = typeof chrome !== 'undefined' ? chrome.storage?.onChanged : undefined;
    events?.addListener(onChanged);
    return () => {
      alive = false;
      events?.removeListener(onChanged);
    };
  }, []);
  return state;
}

/**
 * Ask for host access to the Paperclip server. Called first thing in a click handler: the
 * browser only shows the permission prompt during the user's gesture.
 */
function requestServerAccess(serverUrl: string): Promise<boolean> {
  const origins = paperclipPermissionOrigins(serverUrl);
  if (origins.length === 0) return Promise.resolve(false);
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return Promise.resolve(true);
  try {
    return chrome.permissions.request({ origins }).catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function errorText(err: unknown): string {
  if (err instanceof PaperclipError) return err.message;
  return err instanceof Error ? err.message : String(err);
}

function openTab(url: string): void {
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create) {
      void chrome.tabs.create({ url });
      return;
    }
  } catch {
    // fall back to window.open
  }
  window.open(url, '_blank', 'noopener');
}

function Status({ note }: { note: Note }) {
  if (!note.message) return null;
  return (
    <div className="tk-settings-result" data-ok={note.ok ?? true} role="status">
      {note.message}
    </div>
  );
}

export function PaperclipSettings({
  settings,
  onPatch,
}: {
  settings: SettingsRecord;
  onPatch: (patch: Partial<SettingsRecord>) => Promise<void>;
}) {
  const pc = settings.paperclip;
  const state = usePaperclipSyncState();
  const [url, setUrl] = useState(pc.serverUrl || DEFAULT_PAPERCLIP_URL);
  const [connect, setConnect] = useState<Note & { busy?: boolean }>({ message: null });
  const [auth, setAuth] = useState<Note & { busy?: boolean; approvalUrl?: string }>({ message: null });
  const [pastedKey, setPastedKey] = useState('');
  const [companies, setCompanies] = useState<PcCompany[] | null>(null);
  const [companyNote, setCompanyNote] = useState<Note>({ message: null });
  const [syncNote, setSyncNote] = useState<Note & { busy?: boolean }>({ message: null });
  const signInAbort = useRef<AbortController | null>(null);
  const urlId = useId();
  const keyId = useId();

  useEffect(() => setUrl(pc.serverUrl || DEFAULT_PAPERCLIP_URL), [pc.serverUrl]);
  useEffect(() => () => signInAbort.current?.abort(), []);

  const patch = useCallback(
    (next: Partial<PaperclipSettingsRecord>) => onPatch({ paperclip: { ...settings.paperclip, ...next } }),
    [onPatch, settings.paperclip]
  );

  const needsKey = pc.deploymentMode === 'authenticated';
  const signedIn = pc.auth === 'board_key' && Boolean(pc.apiKey);
  const ready = pc.deploymentMode !== '' && (!needsKey || signedIn);
  const running = isSyncRunning(state);

  const loadCompanies = useCallback(
    async (target: PaperclipSettingsRecord) => {
      setCompanyNote({ message: 'Loading companies…' });
      try {
        const client = new PaperclipClient({ serverUrl: target.serverUrl, apiKey: target.auth === 'board_key' ? target.apiKey : '' });
        const list = (await client.listCompanies()).filter((c) => c && typeof c.id === 'string');
        setCompanies(list);
        setCompanyNote({ message: list.length === 0 ? 'No companies yet. Create one in Paperclip, then refresh.' : null });
      } catch (err) {
        setCompanies(null);
        setCompanyNote({ ok: false, message: errorText(err) });
      }
    },
    []
  );

  // Show the company picker as soon as the server is reachable with the stored settings.
  useEffect(() => {
    if (ready && companies === null) void loadCompanies(pc);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pc.serverUrl, pc.apiKey]);

  const onConnect = () => {
    const typed = normalizeServerUrl(url);
    if (!typed) {
      setConnect({ ok: false, message: 'Enter the address Paperclip runs at, for example http://localhost:3100.' });
      return;
    }
    // Permission first, while the click still counts as a user gesture.
    const access = requestServerAccess(typed);
    setConnect({ busy: true, message: 'Looking for Paperclip…' });
    void (async () => {
      if (!(await access)) {
        setConnect({
          ok: false,
          message: `Access to ${new URL(typed).host} was not granted, so ThreadStack cannot reach Paperclip there.`,
        });
        return;
      }
      let found = await probeServer(typed).catch(() => null);
      if (!found && isLoopbackServer(typed)) found = await discoverServer({ preferred: typed });
      if (!found) {
        setConnect({
          ok: false,
          message: isLoopbackServer(typed)
            ? `No Paperclip server answered at ${typed} or on ports 3100-3110. Start it with "npx paperclipai onboard" (or "pnpm dev"), then try again.`
            : `No Paperclip server answered at ${typed}. Check the address and that this browser can reach it.`,
        });
        return;
      }
      const mode = found.health.deploymentMode;
      const changedServer = found.serverUrl !== pc.serverUrl;
      const next: Partial<PaperclipSettingsRecord> = {
        serverUrl: found.serverUrl,
        deploymentMode: mode,
        ...(mode === 'local_trusted' ? { auth: 'none' as const } : {}),
        ...(changedServer ? { apiKey: '', apiKeyExpiresAt: '', accountLabel: '', companyIds: [], companyScope: 'all' as const, auth: mode === 'local_trusted' ? ('none' as const) : ('board_key' as const) } : {}),
      };
      await patch(next);
      setUrl(found.serverUrl);
      setCompanies(null);
      setConnect({
        ok: true,
        message: `Found Paperclip${found.health.version ? ` ${found.health.version}` : ''} at ${found.serverUrl}. ${
          mode === 'local_trusted' ? 'It runs in local trusted mode, so no sign-in is needed.' : 'This server needs you to sign in.'
        }`,
      });
    })();
  };

  const onSignIn = () => {
    signInAbort.current?.abort();
    const abort = new AbortController();
    signInAbort.current = abort;
    setAuth({ busy: true, message: 'Asking Paperclip for access…' });
    void (async () => {
      try {
        const signedInAs = await signInWithApproval({
          serverUrl: pc.serverUrl,
          openUrl: openTab,
          signal: abort.signal,
          onStatus: (s) => {
            if (s.phase === 'waiting') {
              setAuth({
                busy: true,
                approvalUrl: s.approvalUrl,
                message: 'Approve ThreadStack in the Paperclip tab that just opened. This waits up to 10 minutes.',
              });
            }
          },
        });
        await patch({ auth: 'board_key', apiKey: signedInAs.apiKey, apiKeyExpiresAt: signedInAs.expiresAt, accountLabel: signedInAs.accountLabel });
        setAuth({ ok: true, message: `Signed in as ${signedInAs.accountLabel}.` });
      } catch (err) {
        if (abort.signal.aborted) setAuth({ message: null });
        else setAuth({ ok: false, message: errorText(err) });
      }
    })();
  };

  const onUseKey = async () => {
    const key = pastedKey.trim();
    if (!looksLikeBoardKey(key)) {
      setAuth({ ok: false, message: 'A board API key starts with pcp_board_.' });
      return;
    }
    setAuth({ busy: true, message: 'Checking the key…' });
    try {
      const signedInAs = await verifyBoardKey(pc.serverUrl, key);
      await patch({ auth: 'board_key', apiKey: key, apiKeyExpiresAt: '', accountLabel: signedInAs.accountLabel });
      setPastedKey('');
      setAuth({ ok: true, message: `Signed in as ${signedInAs.accountLabel}.` });
    } catch (err) {
      setAuth({ ok: false, message: errorText(err) });
    }
  };

  const onSignOut = async () => {
    const revoked = await revokeBoardKey(pc.serverUrl, pc.apiKey);
    await patch({ apiKey: '', apiKeyExpiresAt: '', accountLabel: '', enabled: false });
    setCompanies(null);
    setAuth({
      ok: true,
      message: revoked ? 'Signed out; the key was revoked in Paperclip.' : 'Signed out. Paperclip could not be reached to revoke the key; it expires on its own within 30 days.',
    });
  };

  const onSyncNow = () => {
    if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) {
      setSyncNote({ ok: false, message: 'Sync runs in the ThreadStack extension.' });
      return;
    }
    setSyncNote({ busy: true, message: 'Syncing…' });
    chrome.runtime
      .sendMessage({ type: 'PAPERCLIP_SYNC_NOW' })
      .then((res: { ok?: boolean; outcome?: { status: string; error?: string } } | undefined) => {
        const outcome = res?.outcome;
        if (!outcome) setSyncNote({ ok: false, message: 'ThreadStack did not answer. Reload the extension and try again.' });
        else if (outcome.status === 'off') setSyncNote({ ok: false, message: 'Turn on Paperclip sync first.' });
        else if (outcome.status === 'error') setSyncNote({ ok: false, message: outcome.error ?? 'Sync failed.' });
        else setSyncNote({ message: null });
      })
      .catch(() => setSyncNote({ ok: false, message: 'ThreadStack did not answer. Reload the extension and try again.' }));
  };

  const toggleCompany = (id: string, on: boolean) => {
    const ids = new Set(pc.companyIds);
    if (on) ids.add(id);
    else ids.delete(id);
    void patch({ companyIds: Array.from(ids) });
  };

  return (
    <>
      <PaperclipConnectionRow onConfigure={() => { if (needsKey && !signedIn) onSignIn(); else openTab(pc.serverUrl); }} />
      <PaperclipBridgeSettings companies={companies} />
      <PaperclipCredentials settings={settings} onPatch={onPatch} companies={companies ?? []} />
      <section className="tk-settings-section" data-testid="paperclip-settings">
        <h3 className="tk-settings-h3">Paperclip server</h3>
        <p className="tk-settings-note">
          Paperclip runs companies of AI agents on your own server. ThreadStack reads each issue with its comments and the
          transcripts of the agent runs that worked on it, as one thread per issue. It never changes anything in Paperclip.
        </p>
        <div className="tk-field">
          <label htmlFor={urlId}>Server address</label>
          <div className="tk-field-row">
            <input
              id={urlId}
              type="url"
              className="tk-input tk-grow"
              placeholder={DEFAULT_PAPERCLIP_URL}
              spellCheck={false}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <button type="button" className="tk-btn" disabled={connect.busy} onClick={onConnect}>
              {pc.deploymentMode ? 'Check again' : 'Connect'}
            </button>
          </div>
        </div>
        <Status note={connect} />
        {pc.deploymentMode && !connect.message && (
          <p className="tk-settings-note">
            Connected to {pc.serverUrl} ({pc.deploymentMode === 'local_trusted' ? 'local trusted mode, no sign-in needed' : 'sign-in required'}).
          </p>
        )}
      </section>

      {needsKey && (
        <section className="tk-settings-section">
          <h3 className="tk-settings-h3">Sign in</h3>
          {signedIn ? (
            <>
              <p className="tk-settings-note">
                Signed in{pc.accountLabel ? ` as ${pc.accountLabel}` : ''}.
                {pc.apiKeyExpiresAt ? ` The key expires ${new Date(pc.apiKeyExpiresAt).toLocaleDateString()}; sign in again then.` : ''}
              </p>
              <div className="tk-field-row">
                <button type="button" className="tk-btn" onClick={() => void onSignOut()}>
                  Sign out
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="tk-settings-note">
                ThreadStack asks Paperclip for a read key the same way the Paperclip CLI does: you approve it in Paperclip, and the
                key stays in this browser profile (extension storage that websites cannot read).
              </p>
              <div className="tk-field-row">
                <button type="button" className="tk-btn tk-btn-primary" disabled={auth.busy} onClick={onSignIn}>
                  Sign in with Paperclip
                </button>
                {auth.busy && (
                  <button type="button" className="tk-btn" onClick={() => signInAbort.current?.abort()}>
                    Cancel
                  </button>
                )}
                {auth.approvalUrl && auth.busy && (
                  <button type="button" className="tk-linklike" onClick={() => openTab(auth.approvalUrl!)}>
                    Open the approval page again
                  </button>
                )}
              </div>
              <details>
                <summary className="tk-settings-note">Paste a board API key instead</summary>
                <div className="tk-field">
                  <label htmlFor={keyId}>Board API key</label>
                  <div className="tk-field-row">
                    <input
                      id={keyId}
                      type="password"
                      className="tk-input tk-grow"
                      placeholder="pcp_board_…"
                      autoComplete="off"
                      spellCheck={false}
                      value={pastedKey}
                      onChange={(e) => setPastedKey(e.target.value.trim())}
                    />
                    <button type="button" className="tk-btn" disabled={auth.busy || !pastedKey} onClick={() => void onUseKey()}>
                      Use key
                    </button>
                  </div>
                </div>
              </details>
            </>
          )}
          <Status note={auth} />
        </section>
      )}

      {ready && (
        <section className="tk-settings-section">
          <h3 className="tk-settings-h3">Companies</h3>
          <fieldset className="tk-fieldset">
            <legend className="tk-visually-hidden">Which companies to sync</legend>
            <label className="tk-toggle">
              <input type="radio" name="tk-paperclip-scope" checked={pc.companyScope === 'all'} onChange={() => void patch({ companyScope: 'all' })} />
              <span>Every company I can see</span>
            </label>
            <label className="tk-toggle">
              <input
                type="radio"
                name="tk-paperclip-scope"
                checked={pc.companyScope === 'selected'}
                onChange={() => void patch({ companyScope: 'selected' })}
              />
              <span>Only the companies I choose</span>
            </label>
          </fieldset>
          {pc.companyScope === 'selected' && companies && (
            <div className="tk-capture-grid">
              {companies.map((c) => (
                <label key={c.id} className="tk-toggle">
                  <input type="checkbox" checked={pc.companyIds.includes(c.id)} onChange={(e) => toggleCompany(c.id, e.target.checked)} />
                  <span>
                    {c.name}
                    {c.issuePrefix ? <span className="tk-toggle-hint">Issues {c.issuePrefix}-…</span> : null}
                  </span>
                </label>
              ))}
            </div>
          )}
          {pc.companyScope === 'selected' && companies && pc.companyIds.length === 0 && (
            <p className="tk-settings-note">Choose at least one company, or nothing is synced.</p>
          )}
          <div className="tk-field-row">
            <button type="button" className="tk-btn" onClick={() => void loadCompanies(pc)}>
              Refresh list
            </button>
          </div>
          <Status note={companyNote} />
        </section>
      )}

      {ready && (
        <section className="tk-settings-section">
          <h3 className="tk-settings-h3">Sync</h3>
          <label className="tk-toggle">
            <input type="checkbox" checked={pc.enabled} onChange={(e) => void patch({ enabled: e.target.checked })} />
            <span>
              Sync Paperclip issues into ThreadStack
              <span className="tk-toggle-hint">
                Checks for changes every 5 minutes while this browser runs. Threads are analyzed and filed by Paperclip project like
                any other thread.
              </span>
            </span>
          </label>
          {pc.deploymentMode === 'local_trusted' && (
            <label className="tk-toggle">
              <input type="checkbox" checked={pc.liveUpdates} onChange={(e) => void patch({ liveUpdates: e.target.checked })} />
              <span>
                Sync sooner when Paperclip reports a change
                <span className="tk-toggle-hint">Listens to the local server's live events while ThreadStack is awake.</span>
              </span>
            </label>
          )}
          <div className="tk-field-row">
            <button type="button" className="tk-btn tk-btn-primary" disabled={!pc.enabled || running || syncNote.busy} onClick={onSyncNow}>
              {running || syncNote.busy ? 'Syncing…' : 'Sync now'}
            </button>
          </div>
          <dl className="tk-diag-grid" data-testid="paperclip-sync-status">
            <dt>Last sync</dt>
            <dd>{state.lastSyncAt ? `${relativeTime(state.lastSyncAt)} · ${describeSyncResult(state)}` : 'Not synced yet.'}</dd>
            <dt>Threads from Paperclip</dt>
            <dd>{state.threadCount}</dd>
            {running && state.progress && (
              <>
                <dt>Now</dt>
                <dd>{state.progress}</dd>
              </>
            )}
            {state.lastError && (
              <>
                <dt>Problem</dt>
                <dd>
                  {state.lastError}
                  {state.backoffUntil && Date.parse(state.backoffUntil) > Date.now()
                    ? ` Next try ${relativeTime(state.backoffUntil)}.`
                    : ''}
                </dd>
              </>
            )}
          </dl>
          <Status note={syncNote} />
          <p className="tk-settings-note">
            Claude Code runs keep their sessions in ~/.claude/projects, so importing that folder links each issue to its sessions.
            Paperclip gives Codex agents their own Codex home: import
            {' '}<code>~/.paperclip/instances/default/companies/&lt;company id&gt;/codex-home</code> in Import / Export → Codex CLI
            sessions to link Codex runs.
          </p>
        </section>
      )}
    </>
  );
}
