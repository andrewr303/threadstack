import React, { useEffect, useRef, useState } from 'react';
import type { SettingsRecord, StoredHandleRecord } from '../../core/schema.js';
import { exportPortableBundle } from '../../core/adapters.js';
import { importFiles, readJsonlTree, type DirectoryHandleLike, type ImportFileInput, type ImportReport } from '../../core/importers.js';
import { seedSyntheticWorkbenchLibrary, generate652ChatGPTExportFixture } from '../../core/synthetic-fixtures.js';
import { parseChatGPTExport } from '../../core/adapters.js';
import { upsertThread } from '../../core/db.js';
import { sharedDb } from './shared.js';

interface Props {
  dialogRef: React.MutableRefObject<HTMLDialogElement | null>;
  settings: SettingsRecord | null;
  onImported: (message: string) => Promise<void> | void;
  onClosed: () => void;
}

type PickerWindow = Window & {
  showDirectoryPicker?: (opts?: { id?: string; mode?: 'read' }) => Promise<DirectoryHandleLike>;
};

const FOLDER_KINDS: Array<{ kind: StoredHandleRecord['kind']; label: string; path: string }> = [
  { kind: 'claude_code_projects', label: 'Claude Code sessions', path: '~/.claude/projects' },
  { kind: 'codex_sessions', label: 'Codex CLI sessions', path: '~/.codex/sessions' },
];

export function describeReport(report: ImportReport): string {
  const parts = Object.entries(report.byKind).map(([k, n]) => `${n} ${k.replace('_', ' ')}`);
  const extras = [
    report.skippedDeleted ? `${report.skippedDeleted} previously deleted skipped` : '',
    report.unrecognized.length ? `${report.unrecognized.length} file(s) not recognized` : '',
    report.errors.length ? `${report.errors.length} error(s): ${report.errors.slice(0, 2).join('; ')}` : '',
  ].filter(Boolean);
  return `Imported ${report.imported} thread(s)${parts.length ? ` (${parts.join(', ')})` : ''}${extras.length ? ` · ${extras.join(' · ')}` : ''}.`;
}

/** Re-import changed sessions from folders the user already granted. */
export async function syncSavedFolders(
  settings: SettingsRecord,
  options: { interactive: boolean; onProgress?: (m: string) => void }
): Promise<ImportReport | null> {
  const handles = await sharedDb.handles.toArray();
  if (handles.length === 0) return null;
  const files: ImportFileInput[] = [];
  const synced: StoredHandleRecord[] = [];
  for (const h of handles) {
    const dir = h.handle as DirectoryHandleLike;
    let perm = (await dir.queryPermission?.({ mode: 'read' })) ?? 'granted';
    if (perm !== 'granted' && options.interactive) perm = (await dir.requestPermission?.({ mode: 'read' })) ?? perm;
    if (perm !== 'granted') continue;
    const since = h.lastSyncedAt ? Date.parse(h.lastSyncedAt) : undefined;
    files.push(...(await readJsonlTree(dir, { since })));
    synced.push(h);
  }
  const now = new Date().toISOString();
  for (const h of synced) await sharedDb.handles.put({ ...h, lastSyncedAt: now });
  if (files.length === 0) return synced.length ? { byKind: {}, imported: 0, skippedDeleted: 0, unrecognized: [], errors: [], threadKeys: [] } : null;
  return importFiles(sharedDb, settings, files, options.onProgress);
}

export function ImportDialog({ dialogRef, settings, onImported, onClosed }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pasteText, setPasteText] = useState('');
  const [exportText, setExportText] = useState('');
  const [folders, setFolders] = useState<StoredHandleRecord[]>([]);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);
  const hasPicker = typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';

  const refreshFolders = () => void sharedDb.handles.toArray().then(setFolders);
  useEffect(refreshFolders, []);

  const run = async (label: string, work: () => Promise<string>) => {
    setBusy(label);
    setResult(null);
    try {
      const message = await work();
      setResult(message);
      await onImported(message);
    } catch (err) {
      setResult(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(null);
    }
  };

  const importFileList = (list: FileList | null) => {
    if (!list || list.length === 0 || !settings) return;
    void run('Reading files…', async () => {
      const inputs: ImportFileInput[] = [];
      for (const f of Array.from(list)) {
        if (/\.zip$/i.test(f.name)) inputs.push({ name: f.name, bytes: new Uint8Array(await f.arrayBuffer()) });
        else if (/\.(json|jsonl)$/i.test(f.name)) inputs.push({ name: f.webkitRelativePath || f.name, text: await f.text() });
      }
      const report = await importFiles(sharedDb, settings, inputs, setBusy);
      return describeReport(report);
    });
  };

  const pickFolder = (kind: StoredHandleRecord['kind'], label: string) => {
    if (!settings) return;
    if (!hasPicker) {
      dirInputRef.current?.click();
      return;
    }
    void run(`Choose your ${label} folder…`, async () => {
      const dir = await (window as PickerWindow).showDirectoryPicker!({ id: kind, mode: 'read' });
      setBusy(`Reading ${dir.name}…`);
      const files = await readJsonlTree(dir);
      await sharedDb.handles.put({ id: kind, kind, handle: dir, label: dir.name, lastSyncedAt: new Date().toISOString() });
      refreshFolders();
      const report = await importFiles(sharedDb, settings, files, setBusy);
      return `${describeReport(report)} Folder saved; new sessions sync automatically when Threadkeeper opens.`;
    });
  };

  return (
    <dialog
      ref={dialogRef}
      id="tk-import-export-dialog"
      className="tk-modal-dialog tk-modal-wide"
      aria-label="Import and export conversations"
      onClose={onClosed}
    >
      <h2 className="tk-section-h2" style={{ marginBottom: 8 }}>
        Import & Export Library
      </h2>

      <section className="tk-settings-section">
        <h3 className="tk-settings-h3">Import exports and sessions</h3>
        <p className="tk-settings-note">
          Drop in a ChatGPT or Claude data export (the .zip or its conversations.json), a Threadkeeper Portable bundle,
          or Claude Code / Codex .jsonl session files. The format is detected automatically and everything is organized
          as it lands.
        </p>
        <div className="tk-field-row">
          <button type="button" className="tk-btn tk-btn-primary" disabled={Boolean(busy)} onClick={() => fileInputRef.current?.click()}>
            Choose files…
          </button>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".json,.jsonl,.zip,application/json,application/zip"
            hidden
            onChange={(e) => {
              importFileList(e.target.files);
              e.target.value = '';
            }}
          />
          <input
            ref={dirInputRef}
            type="file"
            hidden
            multiple
            {...({ webkitdirectory: '' } as Record<string, string>)}
            onChange={(e) => {
              importFileList(e.target.files);
              e.target.value = '';
            }}
          />
        </div>
      </section>

      <section className="tk-settings-section">
        <h3 className="tk-settings-h3">Coding agents on this computer</h3>
        <p className="tk-settings-note">
          Pick the folder once; Threadkeeper remembers it and imports new sessions each time it opens. In the macOS
          picker press ⌘⇧. to show hidden folders.
        </p>
        <div className="tk-field-row">
          {FOLDER_KINDS.map((f) => (
            <button key={f.kind} type="button" className="tk-btn" disabled={Boolean(busy)} onClick={() => pickFolder(f.kind, f.label)}>
              Import {f.label} <span className="tk-muted">({f.path})</span>
            </button>
          ))}
        </div>
        {folders.length > 0 && (
          <ul className="tk-folder-list">
            {folders.map((f) => (
              <li key={f.id}>
                <span>
                  {FOLDER_KINDS.find((k) => k.kind === f.kind)?.label}: <code>{f.label}</code> · last synced{' '}
                  {f.lastSyncedAt ? f.lastSyncedAt.slice(0, 16).replace('T', ' ') : 'never'}
                </span>
                <span className="tk-field-row">
                  <button
                    type="button"
                    className="tk-btn"
                    disabled={Boolean(busy) || !settings}
                    onClick={() =>
                      settings &&
                      void run('Syncing…', async () => {
                        const report = await syncSavedFolders(settings, { interactive: true, onProgress: setBusy });
                        refreshFolders();
                        return report ? describeReport(report) : 'Nothing to sync.';
                      })
                    }
                  >
                    Sync now
                  </button>
                  <button
                    type="button"
                    className="tk-btn"
                    onClick={() => void sharedDb.handles.delete(f.id).then(refreshFolders)}
                  >
                    Forget
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {(busy || result) && (
        <div className="tk-settings-result" role="status" aria-live="polite">
          {busy ?? result}
        </div>
      )}

      <details className="tk-settings-section">
        <summary className="tk-settings-h3">Paste JSON</summary>
        <textarea
          className="tk-input"
          style={{ width: '100%', minHeight: 120, margin: '8px 0' }}
          aria-label="Paste JSON payload to import"
          placeholder="Paste ChatGPT conversations.json, Claude export JSON, a Portable bundle, or session JSONL…"
          value={pasteText}
          onChange={(e) => setPasteText(e.target.value)}
        />
        <button
          type="button"
          className="tk-btn"
          disabled={!pasteText.trim() || Boolean(busy) || !settings}
          onClick={() =>
            settings &&
            void run('Importing…', async () => {
              const report = await importFiles(sharedDb, settings, [{ name: 'pasted.json', text: pasteText }], setBusy);
              if (report.unrecognized.length) return 'That text was not recognized as a supported export.';
              setPasteText('');
              return describeReport(report);
            })
          }
        >
          Import JSON
        </button>
      </details>

      <details className="tk-settings-section">
        <summary className="tk-settings-h3">Export</summary>
        <div className="tk-field-row" style={{ margin: '8px 0' }}>
          <button
            type="button"
            className="tk-btn"
            onClick={() =>
              void exportPortableBundle(sharedDb).then((bundle) => {
                const text = JSON.stringify(bundle, null, 2);
                setExportText(text);
                const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
                const a = document.createElement('a');
                a.href = url;
                a.download = `threadkeeper-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                setTimeout(() => URL.revokeObjectURL(url), 2000);
              })
            }
          >
            Download Portable JSON
          </button>
        </div>
        {exportText && (
          <textarea
            readOnly
            className="tk-input"
            style={{ width: '100%', minHeight: 90 }}
            aria-label="Exported Portable JSON bundle"
            value={exportText.slice(0, 200_000)}
          />
        )}
      </details>

      <details className="tk-settings-section">
        <summary className="tk-settings-h3">Demo data</summary>
        <div className="tk-field-row" style={{ margin: '8px 0' }}>
          <button
            type="button"
            className="tk-btn"
            onClick={() =>
              void run('Loading demo threads…', async () => {
                await seedSyntheticWorkbenchLibrary(sharedDb, { force: true });
                return 'Loaded starter demo threads.';
              })
            }
          >
            Load starter demo threads
          </button>
          <button
            type="button"
            className="tk-btn"
            onClick={() =>
              void run('Importing 652-thread fixture…', async () => {
                const bound = settings?.boundAccounts.chatgpt ?? { accountId: 'acct_chatgpt_primary', workspaceId: 'ws_personal' };
                for (const item of parseChatGPTExport(generate652ChatGPTExportFixture(), bound)) {
                  await upsertThread(sharedDb, item);
                }
                return 'Imported 652 ChatGPT fixture conversations.';
              })
            }
          >
            Load 652-thread ChatGPT fixture
          </button>
        </div>
      </details>

      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 12 }}>
        <button type="button" className="tk-btn" onClick={() => dialogRef.current?.close()}>
          Close
        </button>
      </div>
    </dialog>
  );
}
