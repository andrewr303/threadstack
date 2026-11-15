// "Session Control backup" in the Import dialog: read the backup file, show what would be
// imported, then import it. Runs only on the full page, where the account service is reachable.
import React, { useRef, useState } from 'react';
import type { SettingsRecord } from '../../../core/schema.js';
import {
  parseSessionControlBackup,
  planSessionControlImport,
  type SessionControlImportPlan,
} from '../../../core/session-control-import.js';
import { sharedDb } from '../shared.js';
import { useOptionalWorkspaceContext } from '../workspace/context.js';
import { openFullPage, useMounted } from './common.js';
import { applySessionControlImport, previewSessionControlImport } from './sessionControlImport.js';

const MAX_BACKUP_BYTES = 25 * 1024 * 1024;

function readText(file: File): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsText(file);
  });
}

export function SessionControlImportSection({
  settings,
  onImported,
}: {
  settings: SettingsRecord | null;
  onImported: (message: string) => Promise<void> | void;
}) {
  const ctx = useOptionalWorkspaceContext();
  const mounted = useMounted();
  const inputRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [plan, setPlan] = useState<SessionControlImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  if (!ctx || !ctx.workspace.enabled) {
    return (
      <section className="tk-settings-section tk-acct-import" aria-labelledby="tk-acct-sc-h">
        <h3 className="tk-settings-h3" id="tk-acct-sc-h">
          Session Control backup
        </h3>
        <p className="tk-settings-note">
          The Session Control import runs from the full page, because it adds accounts as well as sessions. Open the full page, then
          choose Import and export there.
        </p>
        <div className="tk-field-row">
          <button type="button" className="tk-btn" onClick={openFullPage}>
            Open the full page
          </button>
        </div>
      </section>
    );
  }

  const { workspace } = ctx;
  const preview = plan ? previewSessionControlImport(plan, workspace.realms) : null;

  const read = async (file: File | undefined) => {
    setPlan(null);
    setError(null);
    setDone(null);
    setFileName(null);
    if (!file) return;
    if (!settings) {
      setError('Settings are still loading. Try again in a moment.');
      return;
    }
    if (file.size > MAX_BACKUP_BYTES) {
      setError('That file is much larger than a Session Control backup. Choose the file its Export button saved.');
      return;
    }
    try {
      const state = parseSessionControlBackup(await readText(file));
      const bound = settings.boundAccounts.claude_code;
      const planned = planSessionControlImport(state, {
        boundClaudeCodeAccountId: bound.accountId,
        workspaceId: bound.workspaceId,
      });
      if (!mounted.current) return;
      setFileName(file.name);
      setPlan(planned);
    } catch (err) {
      if (mounted.current) setError(err instanceof Error ? err.message : 'That file could not be read.');
    }
  };

  const run = async () => {
    if (!plan || busy) return;
    setBusy(true);
    setError(null);
    try {
      const outcome = await applySessionControlImport(plan, {
        db: sharedDb,
        realms: workspace.realms,
        addAccount: workspace.addAccount,
      });
      await workspace.refreshAccounts();
      if (!mounted.current) return;
      setDone(outcome.message);
      setPlan(null);
      setFileName(null);
      await onImported(outcome.message);
    } catch (err) {
      if (mounted.current) setError(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <section className="tk-settings-section tk-acct-import" aria-labelledby="tk-acct-sc-h">
      <h3 className="tk-settings-h3" id="tk-acct-sc-h">
        Session Control backup
      </h3>
      <p className="tk-settings-note">
        Choose the .json file Session Control saved with Export. Its accounts, projects and Claude Code sessions are added here;
        accounts that used their own Chrome profile keep that profile.
      </p>
      <div className="tk-field-row">
        <button type="button" className="tk-btn" disabled={busy} onClick={() => inputRef.current?.click()}>
          Choose backup file…
        </button>
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          hidden
          aria-label="Session Control backup file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = '';
            void read(file);
          }}
        />
        {fileName && <span className="tk-muted tk-ellipsis">{fileName}</span>}
      </div>

      {error && (
        <p className="tk-acct-field-error" role="alert">
          {error}
        </p>
      )}

      {preview && (
        <div className="tk-acct-preview" aria-label="What will be imported">
          <dl className="tk-acct-facts">
            <div>
              <dt>Sessions to import</dt>
              <dd>{preview.sessions}</dd>
            </div>
            <div>
              <dt>Accounts</dt>
              <dd>
                {preview.accounts.length === 0 ? (
                  'None'
                ) : (
                  <ul className="tk-acct-preview-list">
                    {preview.accounts.map((a) => (
                      <li key={a.label + a.email}>
                        <strong>{a.label}</strong>
                        {a.email ? `, ${a.email}` : ''}. {a.where}. {a.status}.
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
            <div>
              <dt>Projects</dt>
              <dd>{preview.projects.length === 0 ? 'None to add' : preview.projects.join(', ')}</dd>
            </div>
            <div>
              <dt>Sessions skipped</dt>
              <dd>
                {preview.skipped.length === 0 ? (
                  'None'
                ) : (
                  <ul className="tk-acct-preview-list">
                    {preview.skipped.map((s, i) => (
                      <li key={`${s.title}-${i}`}>
                        <strong>{s.title}</strong>. {s.reason}
                      </li>
                    ))}
                  </ul>
                )}
              </dd>
            </div>
          </dl>
          <p className="tk-acct-help">Sessions that are already in the library are left as they are.</p>
          <div className="tk-field-row">
            <button type="button" className="tk-btn tk-btn-primary" disabled={busy || !plan} onClick={() => void run()}>
              {busy ? 'Importing…' : 'Import sessions'}
            </button>
          </div>
        </div>
      )}

      {done && (
        <p className="tk-settings-result" role="status">
          {done}
        </p>
      )}
    </section>
  );
}
