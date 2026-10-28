import React, { useEffect, useState } from 'react';
import type {
  SettingsRecord,
  AutoOrganizeSettings,
  EmbeddingProviderId,
  CollectionRecord,
} from '../../core/schema.js';
import { UNFILED_PROJECT } from '../../core/db.js';
import { sharedDb } from './shared.js';
import { CAPABILITY_MATRIX } from '../../core/adapters.js';
import { CAPTURE_PROVIDER_IDS, PROVIDERS } from '../../core/providers.js';
import { MODEL_OPTIONS, estimateAnalysisCostUsd, testClaudeConnection } from '../../core/ai/claude.js';
import { embedTexts, remoteSpace } from '../../core/embeddings.js';

interface Props {
  dialogRef: React.MutableRefObject<HTMLDialogElement | null>;
  settings: SettingsRecord | null;
  threadCount: number;
  collections: CollectionRecord[];
  projectCounts: Record<string, number>;
  onCollectionsChanged: () => void;
  onPatch: (patch: Partial<SettingsRecord>) => Promise<void>;
  onRebuildVectors: () => void;
  onClosed: () => void;
}

function Section({ title, children, note }: { title: string; note?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="tk-settings-section">
      <h3 className="tk-settings-h3">{title}</h3>
      {note && <p className="tk-settings-note">{note}</p>}
      {children}
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint?: string;
}) {
  return (
    <label className="tk-toggle">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        {label}
        {hint && <span className="tk-toggle-hint">{hint}</span>}
      </span>
    </label>
  );
}

/** Per-project routing keywords, description and local-only flag. */
function ProjectRow({
  col,
  count,
  onChanged,
}: {
  col: CollectionRecord;
  count: number;
  onChanged: () => void;
}) {
  const [description, setDescription] = useState(col.description);
  const [keywords, setKeywords] = useState((col.keywords ?? []).join(', '));
  useEffect(() => {
    setDescription(col.description);
    setKeywords((col.keywords ?? []).join(', '));
  }, [col.name, col.description, (col.keywords ?? []).join(',')]);
  const save = (patch: Partial<CollectionRecord>) =>
    void sharedDb.collections.put({ ...col, ...patch }).then(onChanged);
  return (
    <div className="tk-project-row">
      <div className="tk-project-row-head">
        <strong>{col.name}</strong>
        <span className="tk-muted">
          {count} thread{count === 1 ? '' : 's'}
          {col.origin && col.origin !== 'user' ? ` · ${col.origin === 'starter' ? 'starter' : 'created automatically'}` : ''}
        </span>
        <label className="tk-inline-check">
          <input type="checkbox" checked={col.cloudExcluded} onChange={(e) => save({ cloudExcluded: e.target.checked })} />
          Local-only
        </label>
        {count === 0 && !col.isStarterArea && (
          <button type="button" className="tk-btn" onClick={() => void sharedDb.collections.delete(col.name).then(onChanged)}>
            Delete
          </button>
        )}
      </div>
      <div className="tk-field-row">
        <input
          className="tk-input tk-grow"
          aria-label={`Description of ${col.name}`}
          placeholder="Description (helps Claude file threads here)"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onBlur={() => description !== col.description && save({ description })}
        />
        <input
          className="tk-input tk-grow"
          aria-label={`Routing keywords for ${col.name}`}
          placeholder="Routing keywords, comma-separated"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
          onBlur={() =>
            save({
              keywords: Array.from(
                new Set(keywords.split(',').map((k) => k.trim().toLowerCase()).filter((k) => k.length >= 3))
              ),
            })
          }
        />
      </div>
    </div>
  );
}

export function SettingsDialog({
  dialogRef,
  settings,
  threadCount,
  collections,
  projectCounts,
  onCollectionsChanged,
  onPatch,
  onRebuildVectors,
  onClosed,
}: Props) {
  const [showKey, setShowKey] = useState(false);
  const [testState, setTestState] = useState<{ busy: boolean; message: string | null; ok?: boolean }>({ busy: false, message: null });
  const [embedTest, setEmbedTest] = useState<string | null>(null);

  const patchAuto = (patch: Partial<AutoOrganizeSettings>) =>
    settings ? onPatch({ autoOrganize: { ...settings.autoOrganize, ...patch } }) : Promise.resolve();

  const model = MODEL_OPTIONS.find((m) => m.id === settings?.aiModel) ?? MODEL_OPTIONS[0];
  const estimate = settings ? estimateAnalysisCostUsd(settings.aiModel, Math.max(threadCount, 1)) : 0;

  return (
    <dialog
      ref={dialogRef}
      id="tk-settings-dialog"
      className="tk-modal-dialog tk-modal-wide"
      aria-label="Settings, AI, privacy, and platform capabilities"
      onClose={onClosed}
    >
      <h2 className="tk-section-h2" style={{ marginBottom: 8 }}>
        Settings
      </h2>
      {settings && (
        <div className="tk-settings-stack">
          <Section
            title="AI analysis with Claude"
            note={
              <>
                With an Anthropic API key, Claude reads each new or changed thread once it goes quiet and writes a
                descriptive title, gist, summary, decisions, next steps and project assignment. The key is stored in
                this browser profile only (extension storage, unreadable by websites). Threads marked local-only, and
                threads already in a local-only project (like Personal), are never sent. A brand-new conversation is
                checked when it is analyzed, so it can be sent before Claude files it as personal — mark it local-only
                first if that matters.
              </>
            }
          >
            <div className="tk-field-row">
              <input
                type={showKey ? 'text' : 'password'}
                className="tk-input tk-grow"
                placeholder="sk-ant-…"
                aria-label="Anthropic API key"
                autoComplete="off"
                spellCheck={false}
                value={settings.anthropicApiKey}
                onChange={(e) => void onPatch({ anthropicApiKey: e.target.value.trim() })}
              />
              <button type="button" className="tk-btn" onClick={() => setShowKey((v) => !v)}>
                {showKey ? 'Hide' : 'Show'}
              </button>
              <button
                type="button"
                className="tk-btn"
                disabled={testState.busy}
                onClick={() => {
                  setTestState({ busy: true, message: 'Testing…' });
                  void testClaudeConnection(settings).then((r) =>
                    setTestState({ busy: false, message: r.message, ok: r.ok })
                  );
                }}
              >
                Test
              </button>
            </div>
            {testState.message && (
              <div className="tk-settings-result" data-ok={testState.ok ?? true} role="status">
                {testState.message}
              </div>
            )}
            <div className="tk-field-row">
              <label className="tk-field">
                Model
                <select
                  className="tk-select"
                  aria-label="Claude model"
                  value={settings.aiModel}
                  onChange={(e) => void onPatch({ aiModel: e.target.value as SettingsRecord['aiModel'] })}
                >
                  {MODEL_OPTIONS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — ${m.inputPerMTok}/${m.outputPerMTok} per MTok · {m.note}
                    </option>
                  ))}
                </select>
              </label>
              <label className="tk-field">
                Effort
                <select
                  className="tk-select"
                  aria-label="Analysis effort"
                  value={settings.aiEffort}
                  onChange={(e) => void onPatch({ aiEffort: e.target.value as SettingsRecord['aiEffort'] })}
                >
                  <option value="low">Low (fast, cheapest)</option>
                  <option value="medium">Medium</option>
                  <option value="high">High (most thorough)</option>
                </select>
              </label>
            </div>
            <p className="tk-settings-note">
              Rough cost to analyze all {threadCount} threads once with {model.label}: about $
              {estimate < 1 ? estimate.toFixed(2) : estimate.toFixed(0)}, assuming ≈9k input / 1.8k output tokens per
              thread. This is an estimate, not a measurement: long threads and the model's thinking can cost more. Only
              new or changed threads are re-analyzed.
            </p>
            <Toggle
              checked={settings.autoOrganize.aiAnalysis}
              onChange={(v) => void patchAuto({ aiAnalysis: v })}
              label="Analyze new and changed threads automatically"
              hint="Runs in the background after a chat has been quiet for the delay below."
            />
            <div className="tk-field-row">
              <label className="tk-field">
                Quiet delay (seconds)
                <input
                  type="number"
                  min={0}
                  className="tk-input"
                  aria-label="AI analysis quiet delay"
                  value={settings.autoOrganize.aiDebounceSeconds}
                  onChange={(e) => void patchAuto({ aiDebounceSeconds: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
              <label className="tk-field">
                Daily analysis limit (0 = unlimited)
                <input
                  type="number"
                  min={0}
                  className="tk-input"
                  aria-label="Daily AI analysis limit"
                  value={settings.autoOrganize.dailyAiAnalysisLimit}
                  onChange={(e) => void patchAuto({ dailyAiAnalysisLimit: Math.max(0, Number(e.target.value) || 0) })}
                />
              </label>
            </div>
            {settings.lastAiError && (
              <div className="tk-settings-result" data-ok="false" role="alert">
                Last AI error ({settings.lastAiErrorAt?.slice(0, 16).replace('T', ' ')}): {settings.lastAiError}
              </div>
            )}
          </Section>

          <Section
            title="Embeddings (semantic search, related threads, auto-filing)"
            note="On-device vectors are always maintained and need no key. A hosted model adds true semantic understanding; Anthropic recommends Voyage AI for embeddings."
          >
            <label className="tk-field">
              Provider
              <select
                className="tk-select"
                aria-label="Embedding provider"
                value={settings.embeddingProvider}
                onChange={(e) => void onPatch({ embeddingProvider: e.target.value as EmbeddingProviderId })}
              >
                <option value="local">On-device only (free, private)</option>
                <option value="voyage">Voyage AI</option>
                <option value="openai">OpenAI</option>
                <option value="ollama">Ollama (local server)</option>
              </select>
            </label>
            {settings.embeddingProvider === 'voyage' && (
              <div className="tk-field-row">
                <input
                  type="password"
                  className="tk-input tk-grow"
                  placeholder="Voyage API key (pa-…)"
                  aria-label="Voyage API key"
                  autoComplete="off"
                  value={settings.voyageApiKey}
                  onChange={(e) => void onPatch({ voyageApiKey: e.target.value.trim() })}
                />
                <select
                  className="tk-select"
                  aria-label="Voyage model"
                  value={settings.voyageModel}
                  onChange={(e) => void onPatch({ voyageModel: e.target.value as SettingsRecord['voyageModel'] })}
                >
                  <option value="voyage-4-lite">voyage-4-lite (fast, cheap)</option>
                  <option value="voyage-4">voyage-4</option>
                  <option value="voyage-4-large">voyage-4-large (best)</option>
                  <option value="voyage-code-4">voyage-code-4 (code-heavy libraries)</option>
                </select>
              </div>
            )}
            {settings.embeddingProvider === 'openai' && (
              <div className="tk-field-row">
                <input
                  type="password"
                  className="tk-input tk-grow"
                  placeholder="OpenAI API key (sk-…)"
                  aria-label="OpenAI API key"
                  autoComplete="off"
                  value={settings.openaiApiKey}
                  onChange={(e) => void onPatch({ openaiApiKey: e.target.value.trim() })}
                />
                <select
                  className="tk-select"
                  aria-label="OpenAI embedding model"
                  value={settings.openaiEmbeddingModel}
                  onChange={(e) =>
                    void onPatch({ openaiEmbeddingModel: e.target.value as SettingsRecord['openaiEmbeddingModel'] })
                  }
                >
                  <option value="text-embedding-3-small">text-embedding-3-small</option>
                  <option value="text-embedding-3-large">text-embedding-3-large</option>
                </select>
              </div>
            )}
            {settings.embeddingProvider === 'ollama' && (
              <>
                <div className="tk-field-row">
                  <input
                    type="url"
                    className="tk-input tk-grow"
                    aria-label="Ollama URL"
                    value={settings.ollamaUrl}
                    onChange={(e) => void onPatch({ ollamaUrl: e.target.value.trim() })}
                  />
                  <input
                    type="text"
                    className="tk-input"
                    aria-label="Ollama embedding model"
                    value={settings.ollamaEmbeddingModel}
                    onChange={(e) => void onPatch({ ollamaEmbeddingModel: e.target.value.trim() })}
                  />
                </div>
                <p className="tk-settings-note">
                  Start Ollama with <code>OLLAMA_ORIGINS=chrome-extension://*</code> so it accepts requests from the
                  extension (no extra browser permission is needed), and pull an embedding model (e.g.{' '}
                  <code>ollama pull nomic-embed-text</code>). Use Test to confirm.
                </p>
              </>
            )}
            <div className="tk-field-row">
              {settings.embeddingProvider !== 'local' && (
                <button
                  type="button"
                  className="tk-btn"
                  onClick={() => {
                    const space = remoteSpace(settings);
                    if (!space) {
                      setEmbedTest('Add the key / URL first.');
                      return;
                    }
                    setEmbedTest('Testing…');
                    void embedTexts(settings, space, ['Threadkeeper connection test'], 'query')
                      .then(([v]) => setEmbedTest(`Connected: ${space.model} returns ${v.length}-dimensional vectors.`))
                      .catch((err) => setEmbedTest(err instanceof Error ? err.message : String(err)));
                  }}
                >
                  Test
                </button>
              )}
              <button type="button" className="tk-btn" onClick={onRebuildVectors}>
                Rebuild vectors for the library
              </button>
            </div>
            {embedTest && (
              <div className="tk-settings-result" role="status">
                {embedTest}
              </div>
            )}
          </Section>

          <Section title="Automatic organization" note="Manual choices always win: locked or hand-filed threads and statuses you set are never changed.">
            <Toggle
              checked={settings.autoOrganize.localAnalysis}
              onChange={(v) => void patchAuto({ localAnalysis: v })}
              label="Analyze threads on-device as they are captured"
              hint="Instant gist, kind, topics, decisions and next steps — no network."
            />
            <Toggle
              checked={settings.autoOrganize.autoFile}
              onChange={(v) => void patchAuto({ autoFile: v })}
              label="File threads into projects automatically"
              hint="Uses provider projects, repositories, Claude, keyword rules and similar threads."
            />
            <Toggle
              checked={settings.autoOrganize.autoCreateProjects}
              onChange={(v) => void patchAuto({ autoCreateProjects: v })}
              label="Create new projects when a clear new workstream appears"
            />
            <Toggle
              checked={settings.autoOrganize.autoStatus}
              onChange={(v) => void patchAuto({ autoStatus: v })}
              label="Set status automatically (active, needs review, done, paused)"
            />
            <Toggle
              checked={settings.autoOrganize.autoTags}
              onChange={(v) => void patchAuto({ autoTags: v })}
              label="Add topic tags automatically"
            />
          </Section>

          <Section
            title="Projects"
            note="Threads that mention a project's keywords are filed there automatically; descriptions also guide Claude. Threads in a local-only project are never sent to any API."
          >
            {collections
              .filter((c) => c.name !== UNFILED_PROJECT)
              .sort((a, b) => (projectCounts[b.name] ?? 0) - (projectCounts[a.name] ?? 0) || a.name.localeCompare(b.name))
              .map((col) => (
                <ProjectRow key={col.name} col={col} count={projectCounts[col.name] ?? 0} onChanged={onCollectionsChanged} />
              ))}
          </Section>

          <Section title="Capture" note="Conversations you open on these sites are captured automatically and stay in this browser.">
            <div className="tk-capture-grid">
              {CAPTURE_PROVIDER_IDS.map((id) => (
                <Toggle
                  key={id}
                  checked={settings.authorizedHosts[id]}
                  onChange={(v) => void onPatch({ authorizedHosts: { ...settings.authorizedHosts, [id]: v } })}
                  label={`${PROVIDERS[id].label}`}
                  hint={PROVIDERS[id].captureNote}
                />
              ))}
            </div>
          </Section>

          <Section title="Appearance & toolbar button">
            <div className="tk-field-row">
              <label className="tk-field">
                Toolbar button opens
                <select
                  className="tk-select"
                  aria-label="Toolbar button behaviour"
                  value={settings.launchSurface}
                  onChange={(e) => void onPatch({ launchSurface: e.target.value as SettingsRecord['launchSurface'] })}
                >
                  <option value="side_panel">Side panel (recommended)</option>
                  <option value="overlay">Overlay on AI pages</option>
                  <option value="tab">Full-page library tab</option>
                </select>
              </label>
              <label className="tk-field">
                Theme
                <select
                  className="tk-select"
                  aria-label="Theme"
                  value={settings.theme}
                  onChange={(e) => void onPatch({ theme: e.target.value as SettingsRecord['theme'] })}
                >
                  <option value="system">Match system</option>
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                </select>
              </label>
            </div>
            <p className="tk-settings-note">Shortcuts: Alt+Shift+L side panel · Alt+Shift+K overlay · Alt+Shift+M full page.</p>
          </Section>

          <details className="tk-settings-section">
            <summary className="tk-settings-h3">Cloudflare Worker enrichment (advanced)</summary>
            <p className="tk-settings-note">
              Optional self-hosted Worker (DeepSeek + MongoDB Voyage). Not needed when Claude analysis is configured.
            </p>
            <Toggle
              checked={settings.cloudEnabled}
              onChange={(v) => void onPatch({ cloudEnabled: v })}
              label="Enable Worker enrichment"
            />
            <div className="tk-field-row">
              <input
                type="url"
                className="tk-input tk-grow"
                placeholder="https://threadkeeper-worker.example.workers.dev"
                aria-label="Worker Endpoint URL"
                value={settings.workerEndpointUrl}
                onChange={(e) => void onPatch({ workerEndpointUrl: e.target.value })}
              />
              <input
                type="password"
                className="tk-input"
                placeholder="Worker Bearer Token"
                aria-label="Worker Bearer Token"
                value={settings.workerBearerToken}
                onChange={(e) => void onPatch({ workerBearerToken: e.target.value })}
              />
              <input
                type="number"
                className="tk-input"
                aria-label="Daily cloud request budget"
                value={settings.dailyCloudRequestBudget}
                onChange={(e) =>
                  void onPatch({ dailyCloudRequestBudget: Math.max(0, Number.parseInt(e.target.value || '0', 10)) })
                }
              />
            </div>
          </details>

          <details className="tk-settings-section">
            <summary className="tk-settings-h3">Platform capability matrix (Y / P / N)</summary>
            <table className="tk-matrix">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>Adapter</th>
                  <th>DOM</th>
                  <th>Export</th>
                  <th>Branches</th>
                  <th>Time</th>
                  <th>Cloud Task</th>
                </tr>
              </thead>
              <tbody>
                {CAPABILITY_MATRIX.map((row) => (
                  <tr key={row.adapterId} title={row.notes}>
                    <td>{row.label}</td>
                    <td>{row.visibleDom}</td>
                    <td>{row.fullExport}</td>
                    <td>{row.branchHistory}</td>
                    <td>{row.timestamps}</td>
                    <td>{row.cloudTaskStatus}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </details>
        </div>
      )}
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 14 }}>
        <button type="button" className="tk-btn tk-btn-primary" onClick={() => dialogRef.current?.close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
