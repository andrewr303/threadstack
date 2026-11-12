import React, { useCallback, useEffect, useId, useState } from 'react';
import type {
  SettingsRecord,
  AutoOrganizeSettings,
  EmbeddingProviderId,
  CollectionRecord,
  AiBackend,
  BedrockEmbeddingModel,
  BedrockRerankModel,
  CohereEmbeddingModel,
  CohereRerankModel,
  MongoDbEmbeddingModel,
  MongoDbGeography,
  MongoDbRerankModel,
  RerankProviderId,
} from '../../core/schema.js';
import { UNFILED_PROJECT } from '../../core/db.js';
import { notifyBackground, sharedDb } from './shared.js';
import { listOlderAnalyses, queueOlderAnalysisUpgrades } from '../../core/pipeline.js';
import { CAPABILITY_MATRIX } from '../../core/adapters.js';
import { CAPTURE_PROVIDER_IDS, PROVIDERS } from '../../core/providers.js';
import {
  ANALYSIS_AVG_INPUT_TOKENS,
  ANALYSIS_AVG_OUTPUT_TOKENS,
  MODEL_OPTIONS,
  estimateAnalysisCostUsd,
  testClaudeConnection,
} from '../../core/ai/claude.js';
import { CaptureSettings } from './CaptureSettings.js';
import { AccountsSettings } from './accounts/AccountsSettings.js';
import { BACKEND_OPTIONS, aiCredentialsReady, aiHostOrigins, backendHost, resolveModelId } from '../../core/ai/backends.js';
import {
  awsCredentialsReady,
  hasHostAccess,
  isValidAwsRegion,
  requestHostAccess,
  type AwsSettings,
} from '../../core/aws.js';
import { embeddingApiOrigins, embeddingHostOrigins, testEmbedding } from '../../core/embeddings.js';
import {
  COHERE_EMBEDDING_MODELS,
  COHERE_RERANK_MODELS,
  MONGODB_EMBEDDING_DIMENSIONS,
  MONGODB_EMBEDDING_MODELS,
  MONGODB_GEOGRAPHY_LABELS,
  MONGODB_RERANK_MODELS,
  cohereEffectiveDimensions,
  cohereEmbeddingInfo,
  cohereSupportsDimensions,
  isBedrockCohereV3,
  voyageBaseUrl,
} from '../../core/model-apis.js';
import { rerankHostOrigins, rerankProblem, testReranker } from '../../core/rerank.js';
import { detectBrowser, extensionsPageUrl, reloadWouldHelp } from '../../core/diagnostics.js';
import { DiagnosticsPanel, useDiagnostics } from './Diagnostics.js';
import { SidebarDockPanel } from './SidebarDock.js';
import { dockStatusSummary, dockSyncNow, type DockStateView } from './dock.js';
import { PaperclipSettings, paperclipSectionStatus, usePaperclipSyncState } from './PaperclipSettings.js';
import type { PaperclipSyncState } from '../../core/paperclip/sync.js';

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
  /** Still (Sidebar Dock) link state, owned by App (useDockState). */
  dock?: { state: DockStateView | null; loaded: boolean; refresh: () => Promise<void> };
  /** Open the dialog on this section (e.g. from "Connect Still first"). */
  initialSection?: SectionId | null;
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
    void sharedDb.collections.put({ ...col, ...patch }).then(() => {
      // A project turning local-only must leave Still at once.
      if ('cloudExcluded' in patch) dockSyncNow([], { privacy: true });
      onChanged();
    });
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

export type SectionId =
  | 'general'
  | 'capture'
  | 'accounts'
  | 'paperclip'
  | 'ai'
  | 'aws'
  | 'search'
  | 'organize'
  | 'privacy'
  | 'sidebarDock'
  | 'diagnostics';

const SECTION_LABELS: Array<{ id: SectionId; label: string }> = [
  { id: 'general', label: 'General' },
  { id: 'capture', label: 'Capture' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'paperclip', label: 'Paperclip' },
  { id: 'ai', label: 'AI models' },
  { id: 'aws', label: 'Amazon Web Services' },
  { id: 'search', label: 'Search & embeddings' },
  { id: 'organize', label: 'Organization' },
  { id: 'privacy', label: 'Privacy & limits' },
  { id: 'sidebarDock', label: 'Sidebar Dock' },
  { id: 'diagnostics', label: 'Diagnostics' },
];

const AWS_REGIONS = [
  'us-east-1',
  'us-east-2',
  'us-west-2',
  'ca-central-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-west-3',
  'eu-north-1',
  'ap-northeast-1',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-south-1',
  'sa-east-1',
];

const BEDROCK_EMBEDDING_OPTIONS: Array<{ id: BedrockEmbeddingModel; label: string }> = [
  { id: 'amazon.titan-embed-text-v2:0', label: 'Amazon Titan Text Embeddings V2' },
  { id: 'cohere.embed-v4:0', label: 'Cohere Embed v4' },
  { id: 'cohere.embed-english-v3', label: 'Cohere Embed English v3 (1024 fixed)' },
  { id: 'cohere.embed-multilingual-v3', label: 'Cohere Embed Multilingual v3 (1024 fixed)' },
];

const BEDROCK_RERANK_OPTIONS: Array<{ id: BedrockRerankModel; label: string }> = [
  { id: 'cohere.rerank-v3-5:0', label: 'Cohere Rerank 3.5' },
  { id: 'amazon.rerank-v1:0', label: 'Amazon Rerank 1.0' },
];

/** AWS hosts the current settings call, so access can be granted for exactly those. */
function awsOriginsInUse(settings: SettingsRecord): string[] {
  const rerankOrigins = settings.rerankProvider === 'bedrock' ? rerankHostOrigins(settings) : [];
  return Array.from(new Set([...aiHostOrigins(settings), ...embeddingHostOrigins(settings), ...rerankOrigins]));
}

function usesAws(settings: SettingsRecord): boolean {
  return (
    settings.aiBackend !== 'anthropic' || settings.embeddingProvider === 'bedrock' || settings.rerankProvider === 'bedrock'
  );
}

const MONGODB_GEOGRAPHY_URLS = {
  global: 'https://ai.mongodb.com',
  us: 'https://us.ai.mongodb.com',
  eu: 'https://eu.ai.mongodb.com',
} as const;

/** Name shown for each hosted embedding provider. */
const EMBEDDING_PROVIDER_NAMES: Record<EmbeddingProviderId, string> = {
  local: 'Local',
  voyage: 'Voyage',
  mongodb: 'Atlas Voyage',
  cohere: 'Cohere',
  bedrock: 'Bedrock',
  openai: 'OpenAI',
  ollama: 'Ollama',
};

/** Where captured text can go with the current settings. Local-only threads never go anywhere. */
function dataDestinations(settings: SettingsRecord): Array<{ what: string; where: string }> {
  const out: Array<{ what: string; where: string }> = [];
  if (aiCredentialsReady(settings)) {
    out.push({ what: 'Claude analysis, Organize and Ask', where: backendHost(settings) });
  }
  if (settings.embeddingProvider === 'voyage' && settings.voyageApiKey.trim()) out.push({ what: 'Embeddings', where: new URL(voyageBaseUrl(settings)).host });
  if (settings.embeddingProvider === 'mongodb' && settings.mongodbApiKey.trim()) {
    out.push({ what: 'Embeddings', where: new URL(MONGODB_GEOGRAPHY_URLS[settings.mongodbGeography]).host });
  }
  if (settings.embeddingProvider === 'cohere' && settings.cohereApiKey.trim()) out.push({ what: 'Embeddings', where: 'api.cohere.com' });
  if (settings.embeddingProvider === 'openai' && settings.openaiApiKey.trim()) out.push({ what: 'Embeddings', where: 'api.openai.com' });
  if (settings.embeddingProvider === 'ollama') out.push({ what: 'Embeddings', where: settings.ollamaUrl || 'Ollama' });
  if (settings.embeddingProvider === 'bedrock' && awsCredentialsReady(settings.aws)) {
    out.push({ what: 'Embeddings', where: `bedrock-runtime.${settings.aws.region}.amazonaws.com` });
  }
  if (settings.rerankProvider === 'voyage' && settings.voyageApiKey.trim()) {
    out.push({ what: 'Reranking (short excerpts)', where: new URL(voyageBaseUrl(settings)).host });
  }
  if (settings.rerankProvider === 'mongodb' && settings.mongodbApiKey.trim()) {
    out.push({ what: 'Reranking (short excerpts)', where: new URL(MONGODB_GEOGRAPHY_URLS[settings.mongodbGeography]).host });
  }
  if (settings.rerankProvider === 'cohere' && settings.cohereApiKey.trim()) {
    out.push({ what: 'Reranking (short excerpts)', where: 'api.cohere.com' });
  }
  if (settings.rerankProvider === 'bedrock' && awsCredentialsReady(settings.aws)) {
    const host = settings.aws.auth === 'iam' ? 'bedrock-agent-runtime' : 'bedrock-runtime';
    out.push({ what: 'Reranking (short excerpts)', where: `${host}.${settings.aws.region}.amazonaws.com` });
  }
  if (settings.cloudEnabled && settings.workerEndpointUrl.trim()) {
    out.push({ what: 'Worker enrichment', where: settings.workerEndpointUrl });
  }
  if (settings.sidebarDock?.pairedId) {
    out.push({ what: 'Threads Still syncs, is sent or searches', where: `${settings.sidebarDock.pairedName || 'Still'} (another extension in this browser)` });
  }
  return out;
}

function sectionStatus(
  id: SectionId,
  settings: SettingsRecord,
  extra: { projectCount: number; reloadNeeded: boolean; dock?: DockStateView | null; paperclip?: PaperclipSyncState | null }
): { text: string; tone?: 'danger' } | null {
  switch (id) {
    case 'paperclip':
      return paperclipSectionStatus(settings.paperclip, extra.paperclip ?? null);
    case 'capture': {
      const listed = CAPTURE_PROVIDER_IDS.filter((p) => PROVIDERS[p].hostAccess !== 'custom');
      const on = listed.filter((p) => settings.authorizedHosts[p]).length;
      return { text: `${on} of ${listed.length}` };
    }
    case 'ai':
      return aiCredentialsReady(settings)
        ? { text: BACKEND_OPTIONS.find((b) => b.id === settings.aiBackend)?.label.replace(/^Claude Platform on AWS$/, 'AWS') ?? '' }
        : { text: 'Off' };
    case 'aws':
      if (!usesAws(settings)) return { text: 'Unused' };
      return awsCredentialsReady(settings.aws) ? { text: settings.aws.region } : { text: 'Needs keys', tone: 'danger' };
    case 'search': {
      const embed = EMBEDDING_PROVIDER_NAMES[settings.embeddingProvider] ?? 'Local';
      return { text: settings.rerankProvider === 'none' ? embed : `${embed} + rerank` };
    }
    case 'organize':
      return { text: String(extra.projectCount) };
    case 'sidebarDock': {
      if (extra.dock === undefined) return settings.sidebarDock.pairedId ? { text: 'Connected' } : { text: 'Off' };
      const s = dockStatusSummary(extra.dock);
      return { text: s.short, tone: s.tone };
    }
    case 'diagnostics':
      return extra.reloadNeeded ? { text: 'Reload', tone: 'danger' } : { text: 'OK' };
    default:
      return null;
  }
}

function VoyageEndpoint({ settings, onPatch }: Pick<Props, 'onPatch'> & { settings: SettingsRecord }) {
  return (
    <label className="tk-field">
      Voyage API endpoint (shared by embeddings and reranking)
      <select className="tk-select" aria-label="Voyage API endpoint" value={settings.voyageEndpoint}
        onChange={(e) => void onPatch({ voyageEndpoint: e.target.value as SettingsRecord['voyageEndpoint'] })}>
        <option value="mongodb">MongoDB Atlas — ai.mongodb.com</option>
        <option value="legacy">Legacy Voyage — api.voyageai.com</option>
      </select>
      <span className="tk-settings-note">Use MongoDB Atlas for Atlas model API keys. Use Legacy Voyage for keys from voyageai.com. For US/EU scoped keys, choose the MongoDB Atlas provider and matching geography.</span>
    </label>
  );
}

function SecretInput({
  value,
  onChange,
  label,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  label: string;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  const id = useId();
  return (
    <div className="tk-field">
      <label htmlFor={id}>{label}</label>
      <div className="tk-field-row">
        <input
          id={id}
          type={show ? 'text' : 'password'}
          className="tk-input tk-grow"
          placeholder={placeholder}
          aria-label={label}
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
        />
        <button type="button" className="tk-btn" aria-label={`${show ? 'Hide' : 'Show'} ${label}`} onClick={() => setShow((v) => !v)}>
          {show ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
}

function Result({ state }: { state: { message: string | null; ok?: boolean } }) {
  if (!state.message) return null;
  return (
    <div className="tk-settings-result" data-ok={state.ok ?? true} role="status">
      {state.message}
    </div>
  );
}

type TestState = { busy: boolean; message: string | null; ok?: boolean };
const IDLE: TestState = { busy: false, message: null };

function formatUsd(usd: number): string {
  return usd < 1 ? usd.toFixed(2) : usd < 100 ? usd.toFixed(1) : usd.toFixed(0);
}

/**
 * Settings → AI models → "Older summaries": re-analyze AI summaries written before the current format
 * (overview, key points, what was produced, next step). Never automatic: count + estimate + confirm.
 */
function UpgradeOlderSummaries({ settings, active }: { settings: SettingsRecord; active: boolean }) {
  const [count, setCount] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [state, setState] = useState<TestState>(IDLE);
  const refresh = useCallback(() => {
    void listOlderAnalyses(sharedDb)
      .then((keys) => setCount(keys.length))
      .catch(() => setCount(null));
  }, []);
  useEffect(() => {
    if (active) refresh();
  }, [active, refresh]);

  const ready = aiCredentialsReady(settings);
  const model = MODEL_OPTIONS.find((m) => m.id === settings.aiModel) ?? MODEL_OPTIONS[0];
  const estimate = estimateAnalysisCostUsd(settings.aiModel, count ?? 0);
  const limit = settings.autoOrganize.dailyAiAnalysisLimit;

  const upgrade = async () => {
    setState({ busy: true, message: 'Queuing…' });
    try {
      const r = await queueOlderAnalysisUpgrades(sharedDb);
      notifyBackground({ type: 'RUN_ANALYSIS_NOW' });
      setConfirming(false);
      setState({
        busy: false,
        ok: true,
        message:
          r.queued === 0
            ? 'Nothing to upgrade.'
            : `Queued ${r.queued} thread${r.queued === 1 ? '' : 's'}. Threadkeeper rewrites them in the background${
                limit > 0 && r.queued > limit ? `, up to ${limit} a day (your daily limit)` : ''
              }.`,
      });
      refresh();
    } catch (err) {
      setState({ busy: false, ok: false, message: err instanceof Error ? err.message : String(err) });
    }
  };

  if (count === 0 && !state.message) {
    return <p className="tk-settings-note">Every Claude summary already uses the current format.</p>;
  }
  return (
    <>
      <p className="tk-settings-note">
        {count === null
          ? 'Counting older summaries…'
          : `${count} thread${count === 1 ? ' has' : 's have'} a Claude summary in the older, shorter format. Upgrading re-analyzes them once with ${model.label} for an in-depth overview, key points, what was produced and a clear next step. Threads that change are re-analyzed anyway.`}
      </p>
      {count !== null && count > 0 && !confirming && (
        <div className="tk-field-row">
          <button type="button" className="tk-btn" disabled={!ready || state.busy} onClick={() => setConfirming(true)}>
            Upgrade older summaries…
          </button>
          {!ready && <span className="tk-muted">Set up Claude above first.</span>}
        </div>
      )}
      {confirming && count !== null && count > 0 && (
        <div className="tk-settings-confirm" role="group" aria-label="Confirm summary upgrade">
          <p className="tk-settings-note">
            Re-analyze {count} thread{count === 1 ? '' : 's'} with {model.label}? This costs about ${formatUsd(estimate)} at
            Anthropic's list price{settings.aiBackend === 'anthropic' ? '' : ' (AWS bills at its own rates)'}
            {limit > 0 ? ` and counts toward your daily limit of ${limit} analyses` : ''}. Local-only threads are never sent.
          </p>
          <div className="tk-field-row">
            <button type="button" className="tk-btn tk-btn-primary" disabled={state.busy} onClick={() => void upgrade()}>
              Upgrade {count} summar{count === 1 ? 'y' : 'ies'}
            </button>
            <button type="button" className="tk-btn" disabled={state.busy} onClick={() => setConfirming(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      <Result state={state} />
    </>
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
  dock,
  initialSection,
}: Props) {
  const [section, setSection] = useState<SectionId>('general');
  useEffect(() => {
    if (initialSection) setSection(initialSection);
  }, [initialSection]);
  const [aiTest, setAiTest] = useState<TestState>(IDLE);
  const [embedTest, setEmbedTest] = useState<TestState>(IDLE);
  const [rerankTest, setRerankTest] = useState<TestState>(IDLE);
  /** Typed value of "Candidates to rerank"; clamped when the field loses focus. */
  const [candidatesDraft, setCandidatesDraft] = useState<string | null>(null);
  /** Typed value of "Pages kept loaded"; clamped when the field loses focus. */
  const [liveFramesDraft, setLiveFramesDraft] = useState<string | null>(null);
  const [awsAccess, setAwsAccess] = useState<boolean | null>(null);
  const diagnostics = useDiagnostics();
  const paperclipState = usePaperclipSyncState();

  const patchAuto = (patch: Partial<AutoOrganizeSettings>) =>
    settings ? onPatch({ autoOrganize: { ...settings.autoOrganize, ...patch } }) : Promise.resolve();
  const patchAws = (patch: Partial<AwsSettings>) =>
    settings ? onPatch({ aws: { ...settings.aws, ...patch } }) : Promise.resolve();

  const origins = settings ? awsOriginsInUse(settings) : [];
  const originsKey = origins.join(' ');
  useEffect(() => {
    if (!originsKey) {
      setAwsAccess(null);
      return;
    }
    void hasHostAccess(originsKey.split(' ')).then(setAwsAccess);
  }, [originsKey]);

  /** Ask for the AWS hosts in use; must run from a click. */
  const ensureAwsAccess = useCallback(async (): Promise<boolean> => {
    if (!originsKey) return true;
    const granted = await requestHostAccess(originsKey.split(' '));
    setAwsAccess(granted);
    return granted;
  }, [originsKey]);

  if (!settings) {
    return (
      <dialog ref={dialogRef} id="tk-settings-dialog" className="tk-modal-dialog tk-modal-wide" aria-label="Settings" onClose={onClosed} />
    );
  }

  const model = MODEL_OPTIONS.find((m) => m.id === settings.aiModel) ?? MODEL_OPTIONS[0];
  const estimate = estimateAnalysisCostUsd(settings.aiModel, Math.max(threadCount, 1));
  const projectCount = collections.filter((c) => c.name !== UNFILED_PROJECT).length;
  const reloadNeeded = diagnostics.snapshot ? reloadWouldHelp(diagnostics.snapshot.health) : false;
  const browser = detectBrowser(navigator.userAgent);

  const testAi = async () => {
    setAiTest({ busy: true, message: 'Testing…' });
    if (aiHostOrigins(settings).length && !(await requestHostAccess(aiHostOrigins(settings)))) {
      setAiTest({ busy: false, ok: false, message: `Access to ${backendHost(settings)} was not granted, so Threadkeeper cannot reach it.` });
      return;
    }
    const r = await testClaudeConnection(settings);
    setAiTest({ busy: false, message: r.message, ok: r.ok });
  };

  const testEmbeddings = async () => {
    setEmbedTest({ busy: true, message: 'Testing…' });
    const origins = embeddingApiOrigins(settings);
    if (origins.length && !(await requestHostAccess(origins))) {
      setEmbedTest({ busy: false, ok: false, message: `Access to ${origins[0].replace(/^https:\/\//, '').replace(/\/\*$/, '')} was not granted.` });
      return;
    }
    const r = await testEmbedding(settings);
    setEmbedTest({ busy: false, ok: r.ok, message: r.message });
  };

  const testRerank = async () => {
    const problem = rerankProblem(settings);
    if (problem) {
      setRerankTest({ busy: false, ok: false, message: problem });
      return;
    }
    setRerankTest({ busy: true, message: 'Testing…' });
    const origins = rerankHostOrigins(settings);
    if (origins.length && !(await requestHostAccess(origins))) {
      setRerankTest({ busy: false, ok: false, message: `Access to ${origins[0].replace(/^https:\/\//, '').replace(/\/\*$/, '')} was not granted.` });
      return;
    }
    const r = await testReranker(settings);
    setRerankTest({ busy: false, ok: r.ok, message: r.message });
  };

  const openShortcuts = () => {
    try {
      void chrome.tabs.create({ url: `${extensionsPageUrl(browser)}/shortcuts` });
    } catch {
      // tabs API unavailable in this context
    }
  };

  const awsSummary = (
    <p className="tk-settings-note">
      {awsCredentialsReady(settings.aws)
        ? `Uses the AWS credentials for ${settings.aws.region} (${settings.aws.auth === 'api_key' ? 'Bedrock API key' : 'IAM access keys'}).`
        : 'Needs AWS credentials.'}{' '}
      <button type="button" className="tk-linklike" onClick={() => setSection('aws')}>
        Edit in Amazon Web Services
      </button>
    </p>
  );

  const panels: Record<SectionId, React.ReactNode> = {
    general: (
      <>
        <Section title="Appearance & toolbar button">
          <div className="tk-field-row">
            <label className="tk-field">
              Toolbar button opens
              <select
                className="tk-select"
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
                value={settings.theme}
                onChange={(e) => void onPatch({ theme: e.target.value as SettingsRecord['theme'] })}
              >
                <option value="system">Match system</option>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <label className="tk-field">
              Density
              <select
                className="tk-select"
                value={settings.density}
                onChange={(e) => void onPatch({ density: e.target.value as SettingsRecord['density'] })}
              >
                <option value="comfortable">Comfortable</option>
                <option value="compact">Compact</option>
              </select>
            </label>
          </div>
        </Section>
        <Section title="Workspace">
          <Toggle
            checked={settings.surfaces === 'solid'}
            onChange={(v) => void onPatch({ surfaces: v ? 'solid' : 'glass' })}
            label="Solid surfaces"
            hint="Replace translucent panels with opaque ones."
          />
          <div className="tk-field-row">
            <label className="tk-field">
              Pages kept loaded
              <input
                type="number"
                min={2}
                max={12}
                className="tk-input"
                aria-describedby="tk-live-frames-hint"
                value={liveFramesDraft ?? String(settings.maxLiveFrames)}
                onChange={(e) => setLiveFramesDraft(e.target.value)}
                onBlur={() => {
                  if (liveFramesDraft === null) return;
                  void onPatch({ maxLiveFrames: Math.min(12, Math.max(2, Math.round(Number(liveFramesDraft)) || settings.maxLiveFrames)) });
                  setLiveFramesDraft(null);
                }}
              />
            </label>
          </div>
          <p id="tk-live-frames-hint" className="tk-settings-note">
            More pages stay ready in the background; each uses memory.
          </p>
        </Section>
        <Section title="Keyboard shortcuts" note="Alt+Shift+L opens the side panel, Alt+Shift+K the overlay on an AI page, and Alt+Shift+M the full-page library.">
          <div className="tk-field-row">
            <button type="button" className="tk-btn" onClick={openShortcuts}>
              Change shortcuts…
            </button>
          </div>
        </Section>
      </>
    ),

    capture: <CaptureSettings settings={settings} onPatch={onPatch} />,

    accounts: <AccountsSettings />,

    paperclip: <PaperclipSettings settings={settings} onPatch={onPatch} />,

    ai: (
      <>
        <Section
          title="Where Claude runs"
          note="Claude reads each new or changed thread once it goes quiet and writes a descriptive title, gist, summary, decisions, next steps and project. Keys stay in this browser profile (extension storage that websites cannot read)."
        >
          <fieldset className="tk-fieldset">
            <legend className="tk-visually-hidden">Claude provider</legend>
            {BACKEND_OPTIONS.map((b) => (
              <label key={b.id} className="tk-toggle">
                <input
                  type="radio"
                  name="tk-ai-backend"
                  checked={settings.aiBackend === b.id}
                  onChange={() => {
                    setAiTest(IDLE);
                    void onPatch({ aiBackend: b.id as AiBackend });
                  }}
                />
                <span>
                  {b.label}
                  <span className="tk-toggle-hint">{b.note}</span>
                </span>
              </label>
            ))}
          </fieldset>

          {settings.aiBackend === 'anthropic' && (
            <SecretInput
              label="Anthropic API key"
              placeholder="sk-ant-…"
              value={settings.anthropicApiKey}
              onChange={(v) => void onPatch({ anthropicApiKey: v })}
            />
          )}
          {settings.aiBackend === 'bedrock' && (
            <>
              {awsSummary}
              <p className="tk-settings-note">
                Requests go to Amazon Bedrock ({`bedrock-runtime.${settings.aws.region}.amazonaws.com`}) with the
                inference profile <code>{resolveModelId(settings)}</code>: the geographic profile for this region when
                Bedrock offers one, otherwise the global profile. Enable model access for these models in the Bedrock
                console first.
              </p>
            </>
          )}
          {settings.aiBackend === 'aws_platform' && (
            <>
              <label className="tk-field">
                Workspace ID
                <input
                  type="text"
                  className="tk-input"
                  placeholder="wrkspc_…"
                  autoComplete="off"
                  spellCheck={false}
                  value={settings.awsPlatformWorkspaceId}
                  onChange={(e) => void onPatch({ awsPlatformWorkspaceId: e.target.value.trim() })}
                />
              </label>
              {settings.aws.auth === 'api_key' ? (
                <>
                  <SecretInput
                    label="Claude Platform on AWS API key"
                    placeholder="Short-term API key"
                    value={settings.awsPlatformApiKey}
                    onChange={(v) => void onPatch({ awsPlatformApiKey: v })}
                  />
                  <p className="tk-settings-note">
                    Short-term keys last at most 12 hours. Mint one with AWS's token generator for Claude Platform on AWS,
                    or switch to IAM access keys under Amazon Web Services.
                  </p>
                </>
              ) : (
                awsSummary
              )}
            </>
          )}

          <div className="tk-field-row">
            <button type="button" className="tk-btn" disabled={aiTest.busy} onClick={() => void testAi()}>
              Test connection
            </button>
          </div>
          <Result state={aiTest} />
        </Section>

        <Section title="Model">
          <div className="tk-field-row">
            <label className="tk-field">
              Model
              <select
                className="tk-select"
                value={settings.aiModel}
                onChange={(e) => void onPatch({ aiModel: e.target.value as SettingsRecord['aiModel'] })}
              >
                {MODEL_OPTIONS.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {m.note}
                  </option>
                ))}
              </select>
            </label>
            <label className="tk-field">
              Effort
              <select
                className="tk-select"
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
            Analyzing all {threadCount} threads once with {model.label} costs about $
            {estimate < 1 ? estimate.toFixed(2) : estimate.toFixed(0)} at{' '}
            {model.id.startsWith('gpt-') ? "Amazon Bedrock's US rate" : "Anthropic's list price"} (${model.inputPerMTok} / $
            {model.outputPerMTok} per million input / output tokens), assuming about{' '}
            {Math.round(ANALYSIS_AVG_INPUT_TOKENS / 1000)}k input and {(ANALYSIS_AVG_OUTPUT_TOKENS / 1000).toFixed(1)}k output
            tokens per thread. This is an estimate: long threads and the model's thinking cost more
            {settings.aiBackend === 'anthropic' ? '' : ', and AWS bills at its own rates'}. Only new or changed threads are
            analyzed again. Thread analysis always runs at Medium effort or higher, whatever the setting.
          </p>
        </Section>

        <Section title="Older summaries">
          <UpgradeOlderSummaries settings={settings} active={section === 'ai'} />
        </Section>

        <Section title="Automatic analysis">
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
      </>
    ),

    aws: (
      <>
        <Section
          title="AWS account"
          note={`Used by ${[
            settings.aiBackend === 'bedrock' ? 'AI models in Amazon Bedrock' : '',
            settings.aiBackend === 'aws_platform' ? 'Claude Platform on AWS' : '',
            settings.embeddingProvider === 'bedrock' ? 'Bedrock embeddings' : '',
            settings.rerankProvider === 'bedrock' ? 'Bedrock reranking' : '',
          ]
            .filter(Boolean)
            .join(', ') || 'nothing yet: choose an AWS option under AI models or Search & embeddings'}.`}
        >
          <label className="tk-field">
            Region
            <input
              type="text"
              className="tk-input"
              list="tk-aws-regions"
              autoComplete="off"
              spellCheck={false}
              value={settings.aws.region}
              aria-invalid={!isValidAwsRegion(settings.aws.region)}
              onChange={(e) => void patchAws({ region: e.target.value.trim().toLowerCase() })}
            />
            <datalist id="tk-aws-regions">
              {AWS_REGIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </label>
          {!isValidAwsRegion(settings.aws.region) && (
            <div className="tk-settings-result" data-ok="false" role="alert">
              Enter a region code such as us-east-1.
            </div>
          )}
          <fieldset className="tk-fieldset">
            <legend className="tk-visually-hidden">AWS credential type</legend>
            <label className="tk-toggle">
              <input type="radio" name="tk-aws-auth" checked={settings.aws.auth === 'api_key'} onChange={() => void patchAws({ auth: 'api_key' })} />
              <span>
                Bedrock API key
                <span className="tk-toggle-hint">
                  Simplest. Prefer a short-term key (lasts at most 12 hours); AWS recommends long-term keys only for
                  exploration. Not accepted by the Bedrock Rerank API, so Bedrock reranking then uses Cohere Rerank 3.5
                  directly.
                </span>
              </span>
            </label>
            <label className="tk-toggle">
              <input type="radio" name="tk-aws-auth" checked={settings.aws.auth === 'iam'} onChange={() => void patchAws({ auth: 'iam' })} />
              <span>
                IAM access keys
                <span className="tk-toggle-hint">
                  Requests are signed in this browser (SigV4). Use temporary credentials with a session token where you
                  can, scoped to the Bedrock actions you need.
                </span>
              </span>
            </label>
          </fieldset>
          {settings.aws.auth === 'api_key' ? (
            <SecretInput
              label="Bedrock API key"
              placeholder="bedrock-api-key-…"
              value={settings.aws.bedrockApiKey}
              onChange={(v) => void patchAws({ bedrockApiKey: v })}
            />
          ) : (
            <>
              <div className="tk-field-row">
                <label className="tk-field">
                  Access key ID
                  <input
                    type="text"
                    className="tk-input"
                    autoComplete="off"
                    spellCheck={false}
                    value={settings.aws.accessKeyId}
                    onChange={(e) => void patchAws({ accessKeyId: e.target.value.trim() })}
                  />
                </label>
              </div>
              <SecretInput
                label="Secret access key"
                value={settings.aws.secretAccessKey}
                onChange={(v) => void patchAws({ secretAccessKey: v })}
              />
              <SecretInput
                label="Session token (optional)"
                placeholder="Session token for temporary credentials"
                value={settings.aws.sessionToken}
                onChange={(v) => void patchAws({ sessionToken: v })}
              />
            </>
          )}
        </Section>

        <Section
          title="Browser access to AWS"
          note="Threadkeeper holds no AWS host permission until you allow the endpoints for this region. The browser asks once."
        >
          {origins.length === 0 ? (
            <p className="tk-settings-note">Nothing to allow yet: no AWS feature is turned on.</p>
          ) : (
            <>
              <ul className="tk-plain-list">
                {origins.map((o) => (
                  <li key={o}>
                    <code>{o.replace('https://', '').replace('/*', '')}</code>
                  </li>
                ))}
              </ul>
              <div className="tk-field-row">
                <button
                  type="button"
                  className={`tk-btn${awsAccess ? '' : ' tk-btn-primary'}`}
                  disabled={awsAccess === true}
                  onClick={() => void ensureAwsAccess()}
                >
                  {awsAccess ? 'Access allowed' : 'Allow access'}
                </button>
              </div>
            </>
          )}
        </Section>
      </>
    ),

    search: (
      <>
        <Section
          title="Embeddings"
          note="On-device vectors are always kept and need no key. A hosted model adds real semantic search, better related threads and better auto-filing."
        >
          <label className="tk-field">
            Provider
            <select
              className="tk-select"
              value={settings.embeddingProvider}
              onChange={(e) => {
                setEmbedTest(IDLE);
                void onPatch({ embeddingProvider: e.target.value as EmbeddingProviderId });
              }}
            >
              <option value="local">On-device only (free, private)</option>
              <option value="voyage">Voyage AI</option>
              <option value="mongodb">MongoDB Atlas (Voyage)</option>
              <option value="cohere">Cohere</option>
              <option value="bedrock">Amazon Bedrock</option>
              <option value="openai">OpenAI</option>
              <option value="ollama">Ollama (local server)</option>
            </select>
          </label>
          {settings.embeddingProvider === 'voyage' && (
            <>
              <VoyageEndpoint settings={settings} onPatch={onPatch} />
              <SecretInput label="Voyage API key" placeholder="pa-…" value={settings.voyageApiKey} onChange={(v) => void onPatch({ voyageApiKey: v })} />
              <label className="tk-field">
                Model
                <select
                  className="tk-select"
                  value={settings.voyageModel}
                  onChange={(e) => void onPatch({ voyageModel: e.target.value as SettingsRecord['voyageModel'] })}
                >
                  <option value="voyage-4-lite">voyage-4-lite (fast, cheap)</option>
                  <option value="voyage-4">voyage-4</option>
                  <option value="voyage-4-large">voyage-4-large (best)</option>
                  <option value="voyage-code-4">voyage-code-4 (code-heavy libraries)</option>
                </select>
              </label>
            </>
          )}
          {settings.embeddingProvider === 'mongodb' && (
            <>
              <SecretInput
                label="Atlas model API key"
                placeholder="Created in MongoDB Atlas"
                value={settings.mongodbApiKey}
                onChange={(v) => void onPatch({ mongodbApiKey: v })}
              />
              <label className="tk-field">
                Geography
                <select
                  className="tk-select"
                  value={settings.mongodbGeography}
                  onChange={(e) => void onPatch({ mongodbGeography: e.target.value as MongoDbGeography })}
                >
                  {(Object.keys(MONGODB_GEOGRAPHY_LABELS) as MongoDbGeography[]).map((g) => (
                    <option key={g} value={g}>
                      {MONGODB_GEOGRAPHY_LABELS[g]}
                    </option>
                  ))}
                </select>
              </label>
              <div className="tk-field-row">
                <label className="tk-field">
                  Model
                  <select
                    className="tk-select"
                    value={settings.mongodbEmbeddingModel}
                    onChange={(e) => void onPatch({ mongodbEmbeddingModel: e.target.value as MongoDbEmbeddingModel })}
                  >
                    {MONGODB_EMBEDDING_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="tk-field">
                  Dimensions
                  <select
                    className="tk-select"
                    value={settings.mongodbEmbeddingDimensions}
                    onChange={(e) =>
                      void onPatch({ mongodbEmbeddingDimensions: Number(e.target.value) as SettingsRecord['mongodbEmbeddingDimensions'] })
                    }
                  >
                    {MONGODB_EMBEDDING_DIMENSIONS.map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </label>
              </div>
              <p className="tk-settings-note">
                The same Voyage models as voyageai.com, billed through your Atlas account. A key only works on the
                geography it was created for. Threadkeeper asks for access to that one host when you press Test.
              </p>
            </>
          )}
          {settings.embeddingProvider === 'cohere' && (
            <>
              <SecretInput label="Cohere API key" placeholder="From dashboard.cohere.com" value={settings.cohereApiKey} onChange={(v) => void onPatch({ cohereApiKey: v })} />
              <div className="tk-field-row">
                <label className="tk-field">
                  Model
                  <select
                    className="tk-select"
                    value={settings.cohereEmbeddingModel}
                    onChange={(e) => void onPatch({ cohereEmbeddingModel: e.target.value as CohereEmbeddingModel })}
                  >
                    {COHERE_EMBEDDING_MODELS.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label}
                      </option>
                    ))}
                  </select>
                </label>
                {cohereSupportsDimensions(settings.cohereEmbeddingModel) && (
                  <label className="tk-field">
                    Dimensions
                    <select
                      className="tk-select"
                      value={cohereEffectiveDimensions(settings.cohereEmbeddingModel, settings.cohereEmbeddingDimensions)}
                      onChange={(e) =>
                        void onPatch({ cohereEmbeddingDimensions: Number(e.target.value) as SettingsRecord['cohereEmbeddingDimensions'] })
                      }
                    >
                      {cohereEmbeddingInfo(settings.cohereEmbeddingModel).dimensions.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
              <p className="tk-settings-note">
                Embed v5.0 Pro and Fast share one vector space, so you can index with Pro and keep Fast for queries without rebuilding.
                1024 dimensions keeps a large library compact; 2048 is the v5.0 default.
              </p>
            </>
          )}
          {settings.embeddingProvider === 'bedrock' && (
            <>
              {awsSummary}
              <div className="tk-field-row">
                <label className="tk-field">
                  Model
                  <select
                    className="tk-select"
                    value={settings.bedrockEmbeddingModel}
                    onChange={(e) => void onPatch({ bedrockEmbeddingModel: e.target.value as BedrockEmbeddingModel })}
                  >
                    {BEDROCK_EMBEDDING_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.label}
                      </option>
                    ))}
                  </select>
                </label>
                {!isBedrockCohereV3(settings.bedrockEmbeddingModel) && (
                <label className="tk-field">
                  Dimensions
                  <select
                    className="tk-select"
                    value={settings.bedrockEmbeddingDimensions}
                    onChange={(e) =>
                      void onPatch({ bedrockEmbeddingDimensions: Number(e.target.value) as SettingsRecord['bedrockEmbeddingDimensions'] })
                    }
                  >
                    <option value={256}>256</option>
                    <option value={512}>512</option>
                    <option value={1024}>1024</option>
                  </select>
                </label>
                )}
              </div>
            </>
          )}
          {settings.embeddingProvider === 'openai' && (
            <>
              <SecretInput label="OpenAI API key" placeholder="sk-…" value={settings.openaiApiKey} onChange={(v) => void onPatch({ openaiApiKey: v })} />
              <label className="tk-field">
                Model
                <select
                  className="tk-select"
                  value={settings.openaiEmbeddingModel}
                  onChange={(e) => void onPatch({ openaiEmbeddingModel: e.target.value as SettingsRecord['openaiEmbeddingModel'] })}
                >
                  <option value="text-embedding-3-small">text-embedding-3-small</option>
                  <option value="text-embedding-3-large">text-embedding-3-large</option>
                </select>
              </label>
            </>
          )}
          {settings.embeddingProvider === 'ollama' && (
            <>
              <div className="tk-field-row">
                <label className="tk-field">
                  Ollama URL
                  <input type="url" className="tk-input" value={settings.ollamaUrl} onChange={(e) => void onPatch({ ollamaUrl: e.target.value.trim() })} />
                </label>
                <label className="tk-field">
                  Model
                  <input
                    type="text"
                    className="tk-input"
                    value={settings.ollamaEmbeddingModel}
                    onChange={(e) => void onPatch({ ollamaEmbeddingModel: e.target.value.trim() })}
                  />
                </label>
              </div>
              <p className="tk-settings-note">
                Start Ollama with <code>OLLAMA_ORIGINS=chrome-extension://*</code> so it accepts requests from the extension,
                and pull an embedding model (for example <code>ollama pull nomic-embed-text</code>).
              </p>
            </>
          )}
          <div className="tk-field-row">
            {settings.embeddingProvider !== 'local' && (
              <button type="button" className="tk-btn" disabled={embedTest.busy} onClick={() => void testEmbeddings()}>
                Test
              </button>
            )}
            <button type="button" className="tk-btn" onClick={onRebuildVectors}>
              Rebuild vectors for the library
            </button>
          </div>
          <Result state={embedTest} />
        </Section>

        <Section
          title="Reranking"
          note="A reranker re-reads the best candidates of a search or an Ask question and puts the most relevant first. It runs when you press Enter or Ask, never while you type, and sends only titles, gists and short excerpts."
        >
          <label className="tk-field">
            Reranker
            <select
              className="tk-select"
              value={settings.rerankProvider}
              onChange={(e) => {
                setRerankTest(IDLE);
                void onPatch({ rerankProvider: e.target.value as RerankProviderId });
              }}
            >
              <option value="none">Off</option>
              <option value="voyage">Voyage AI</option>
              <option value="mongodb">MongoDB Atlas (Voyage)</option>
              <option value="cohere">Cohere</option>
              <option value="bedrock">Amazon Bedrock</option>
            </select>
          </label>
          {settings.rerankProvider === 'mongodb' && (
            <>
              {settings.embeddingProvider !== 'mongodb' && (
                <>
                  <SecretInput
                    label="Atlas model API key"
                    placeholder="Created in MongoDB Atlas"
                    value={settings.mongodbApiKey}
                    onChange={(v) => void onPatch({ mongodbApiKey: v })}
                  />
                  <label className="tk-field">
                    Geography
                    <select
                      className="tk-select"
                      value={settings.mongodbGeography}
                      onChange={(e) => void onPatch({ mongodbGeography: e.target.value as MongoDbGeography })}
                    >
                      {(Object.keys(MONGODB_GEOGRAPHY_LABELS) as MongoDbGeography[]).map((g) => (
                        <option key={g} value={g}>
                          {MONGODB_GEOGRAPHY_LABELS[g]}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
              <label className="tk-field">
                Model
                <select
                  className="tk-select"
                  value={settings.mongodbRerankModel}
                  onChange={(e) => void onPatch({ mongodbRerankModel: e.target.value as MongoDbRerankModel })}
                >
                  {MONGODB_RERANK_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {settings.rerankProvider === 'cohere' && (
            <>
              {settings.embeddingProvider !== 'cohere' && (
                <SecretInput label="Cohere API key" placeholder="From dashboard.cohere.com" value={settings.cohereApiKey} onChange={(v) => void onPatch({ cohereApiKey: v })} />
              )}
              <label className="tk-field">
                Model
                <select
                  className="tk-select"
                  value={settings.cohereRerankModel}
                  onChange={(e) => void onPatch({ cohereRerankModel: e.target.value as CohereRerankModel })}
                >
                  {COHERE_RERANK_MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          {settings.rerankProvider === 'voyage' && (
            <>
              {settings.embeddingProvider !== 'voyage' && (
                <>
                  <VoyageEndpoint settings={settings} onPatch={onPatch} />
                  <SecretInput label="Voyage API key" placeholder="pa-…" value={settings.voyageApiKey} onChange={(v) => void onPatch({ voyageApiKey: v })} />
                </>
              )}
              <label className="tk-field">
                Model
                <select
                  className="tk-select"
                  value={settings.rerankModel}
                  onChange={(e) => void onPatch({ rerankModel: e.target.value as SettingsRecord['rerankModel'] })}
                >
                  <option value="rerank-3-lite">rerank-3-lite (fast, cheap)</option>
                  <option value="rerank-3">rerank-3 (most accurate)</option>
                </select>
              </label>
            </>
          )}
          {settings.rerankProvider === 'bedrock' && (
            <>
              {awsSummary}
              <label className="tk-field">
                Model
                <select
                  className="tk-select"
                  value={settings.bedrockRerankModel}
                  onChange={(e) => void onPatch({ bedrockRerankModel: e.target.value as BedrockRerankModel })}
                >
                  {BEDROCK_RERANK_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="tk-settings-note">
                Cohere Rerank 3.5 runs in us-east-1, us-west-2, ca-central-1, eu-central-1 and ap-northeast-1; Amazon Rerank
                1.0 in us-west-2, ca-central-1, eu-central-1 and ap-northeast-1, and needs IAM access keys.
              </p>
            </>
          )}
          {settings.rerankProvider !== 'none' && (
            <>
              <div className="tk-field-row">
                <label className="tk-field">
                  Candidates to rerank
                  <input
                    type="number"
                    min={5}
                    max={100}
                    className="tk-input"
                    value={candidatesDraft ?? String(settings.rerankCandidates)}
                    onChange={(e) => setCandidatesDraft(e.target.value)}
                    onBlur={() => {
                      if (candidatesDraft === null) return;
                      void onPatch({ rerankCandidates: Math.min(100, Math.max(5, Number(candidatesDraft) || 40)) });
                      setCandidatesDraft(null);
                    }}
                  />
                </label>
              </div>
              <Toggle
                checked={settings.rerankInSearch}
                onChange={(v) => void onPatch({ rerankInSearch: v })}
                label="Rerank search results"
                hint="Runs when you press Enter in the search box."
              />
              <Toggle checked={settings.rerankInAsk} onChange={(v) => void onPatch({ rerankInAsk: v })} label="Rerank the threads Ask reads" />
              <div className="tk-field-row">
                <button type="button" className="tk-btn" disabled={rerankTest.busy} onClick={() => void testRerank()}>
                  Test reranker
                </button>
              </div>
              <Result state={rerankTest} />
            </>
          )}
        </Section>
      </>
    ),

    organize: (
      <>
        <Section title="Automatic organization" note="Manual choices always win: locked or hand-filed threads and statuses you set are never changed.">
          <Toggle
            checked={settings.autoOrganize.localAnalysis}
            onChange={(v) => void patchAuto({ localAnalysis: v })}
            label="Analyze threads on-device as they are captured"
            hint="Instant gist, kind, topics, decisions and next steps, with no network."
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
          <Toggle checked={settings.autoOrganize.autoTags} onChange={(v) => void patchAuto({ autoTags: v })} label="Add topic tags automatically" />
        </Section>
        <Section
          title="Projects"
          note="Threads that mention a project's keywords are filed there automatically, and descriptions guide Claude. Threads in a local-only project are never sent to any API."
        >
          {collections
            .filter((c) => c.name !== UNFILED_PROJECT)
            .sort((a, b) => (projectCounts[b.name] ?? 0) - (projectCounts[a.name] ?? 0) || a.name.localeCompare(b.name))
            .map((col) => (
              <ProjectRow key={col.name} col={col} count={projectCounts[col.name] ?? 0} onChanged={onCollectionsChanged} />
            ))}
        </Section>
      </>
    ),

    privacy: (
      <>
        <Section
          title="What leaves this browser"
          note="Threads marked local-only, and threads filed in a local-only project, are never sent anywhere. A new conversation is checked when it is analyzed, so mark it local-only first if it must never leave."
        >
          {dataDestinations(settings).length === 0 ? (
            <p className="tk-settings-note">Nothing. Everything runs on-device with the current settings.</p>
          ) : (
            <dl className="tk-diag-grid">
              {dataDestinations(settings).map((d) => (
                <React.Fragment key={`${d.what}-${d.where}`}>
                  <dt>{d.what}</dt>
                  <dd>
                    <code>{d.where}</code>
                  </dd>
                </React.Fragment>
              ))}
            </dl>
          )}
        </Section>
        <details className="tk-settings-section">
          <summary className="tk-settings-h3">Cloudflare Worker enrichment (advanced)</summary>
          <p className="tk-settings-note">
            Optional self-hosted Worker (DeepSeek + MongoDB Voyage). Not needed when Claude analysis is configured.
          </p>
          <Toggle checked={settings.cloudEnabled} onChange={(v) => void onPatch({ cloudEnabled: v })} label="Enable Worker enrichment" />
          <div className="tk-field-row">
            <label className="tk-field">
              Worker URL
              <input
                type="url"
                className="tk-input"
                placeholder="https://threadkeeper-worker.example.workers.dev"
                value={settings.workerEndpointUrl}
                onChange={(e) => void onPatch({ workerEndpointUrl: e.target.value })}
              />
            </label>
            <label className="tk-field">
              Daily request budget
              <input
                type="number"
                min={0}
                className="tk-input"
                value={settings.dailyCloudRequestBudget}
                onChange={(e) => void onPatch({ dailyCloudRequestBudget: Math.max(0, Number.parseInt(e.target.value || '0', 10)) })}
              />
            </label>
          </div>
          <SecretInput label="Worker bearer token" value={settings.workerBearerToken} onChange={(v) => void onPatch({ workerBearerToken: v })} />
        </details>
      </>
    ),

    sidebarDock: (
      <SidebarDockPanel
        state={dock?.state ?? null}
        loaded={dock ? dock.loaded : true}
        onRefresh={() => dock?.refresh()}
      />
    ),

    diagnostics: (
      <>
        <Section
          title="Extension health"
          note="Checks that the browser runs the same build as the files on disk. A mismatch is what shows “<id> is blocked · ERR_BLOCKED_BY_CLIENT” in Microsoft Edge."
        >
          <DiagnosticsPanel snapshot={diagnostics.snapshot} onRefresh={diagnostics.refresh} />
        </Section>
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
      </>
    ),
  };

  return (
    <dialog
      ref={dialogRef}
      id="tk-settings-dialog"
      className="tk-modal-dialog tk-modal-wide tk-modal-settings"
      aria-label="Settings"
      onClose={onClosed}
    >
      <h2 className="tk-section-h2" style={{ marginBottom: 8 }}>
        Settings
      </h2>
      <div className="tk-settings-layout">
        <nav className="tk-settings-nav" aria-label="Settings sections">
          <div className="tk-nav-list">
            {SECTION_LABELS.map((s) => {
              const status = sectionStatus(s.id, settings, {
                projectCount,
                reloadNeeded,
                dock: dock ? dock.state : undefined,
                paperclip: paperclipState,
              });
              return (
                <button
                  key={s.id}
                  type="button"
                  id={`tk-settings-tab-${s.id}`}
                  className="tk-nav-item"
                  aria-current={section === s.id}
                  aria-controls="tk-settings-panel"
                  onClick={() => setSection(s.id)}
                >
                  <span>{s.label}</span>
                  {status && (
                    <span className="tk-nav-count" data-tone={status.tone}>
                      {status.text}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </nav>
        <div
          className="tk-settings-panel tk-settings-stack"
          id="tk-settings-panel"
          role="region"
          aria-labelledby={`tk-settings-tab-${section}`}
          data-testid={`settings-panel-${section}`}
        >
          {panels[section]}
        </div>
      </div>
      <div className="tk-settings-footer">
        <button type="button" className="tk-btn tk-btn-primary" onClick={() => dialogRef.current?.close()}>
          Done
        </button>
      </div>
    </dialog>
  );
}
