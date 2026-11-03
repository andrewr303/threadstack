import { containsPromptInjectionAttempt } from '../../shared/cloud.js';
import {
  CAPTURE_PROVIDER_IDS,
  PROVIDER_IDS,
  isProviderId,
  type CaptureProviderId,
  type ProviderId,
} from './providers.js';

import { DEFAULT_AWS_SETTINGS, type AwsSettings } from './aws.js';

export type { ProviderId, CaptureProviderId } from './providers.js';
export type { AwsSettings } from './aws.js';

export type CoverageState =
  | 'full'
  | 'partial'
  | 'title_only'
  | 'metadata_only'
  | 'stale';

export type CaptureSource =
  | 'dom_observer'
  /** The site's own conversation data, read as the page received it (complete, with ids and times). */
  | 'network_observer'
  /** The user's recent history pulled from the site while they are signed in (Catch up). */
  | 'history_sync'
  | 'export_import'
  | 'portable_import'
  | 'manual'
  | 'synthetic_benchmark';

export type WorkflowState =
  | 'active'
  | 'needs_review'
  | 'waiting'
  | 'paused'
  | 'done'
  | 'archived';

export type ResurfaceQueue =
  | 'continue_working'
  | 'needs_review'
  | 'waiting'
  | 'recently_changed'
  | 'unfiled'
  | 'worth_revisiting';

export const STARTER_AREAS = [
  'HypeStake',
  'Velotic / FrameConcepts',
  'Daydock / Meridian',
  'General research',
  'Personal',
  'Unfiled / Uncertain',
] as const;

export type StarterArea = (typeof STARTER_AREAS)[number];

export interface ThreadIdentity {
  provider: ProviderId;
  accountId: string;
  workspaceId: string;
  sourceConversationId: string;
  branchId: string;
}

export function buildThreadKey(id: ThreadIdentity): string {
  const clean = (val: string, fallback: string) =>
    (val || fallback).trim().replace(/:/g, '_');
  return [
    clean(id.provider, 'imported'),
    clean(id.accountId, 'acct_default'),
    clean(id.workspaceId, 'ws_personal'),
    clean(id.sourceConversationId, 'unknown_conv'),
    clean(id.branchId, 'main'),
  ].join(':');
}

export function parseThreadKey(threadKey: string): ThreadIdentity | null {
  const parts = threadKey.split(':');
  if (parts.length !== 5) return null;
  const [provider, accountId, workspaceId, sourceConversationId, branchId] = parts;
  if (!isProviderId(provider)) {
    return null;
  }
  return {
    provider,
    accountId,
    workspaceId,
    sourceConversationId,
    branchId,
  };
}

export interface ConversationRecord {
  threadKey: string;
  provider: ProviderId;
  accountId: string;
  workspaceId: string;
  sourceConversationId: string;
  branchId: string;
  parentBranchId: string | null;
  siblingBranchIds: string[];
  canonicalUrl: string;
  title: string;
  manualTitleOverride: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  lastCapturedAt: string;
  sourceRevision: number;
  contentHash: string;
  coverage: CoverageState;
  captureSource: CaptureSource;
  messageCount: number;
  project: string;
  categoryLocked: boolean;
  tags: string[];
  manualTags: string[];
  workflowState: WorkflowState;
  manualNotes: string;
  pinned: boolean;
  snoozedUntil: string | null;
  dismissedQueues: ResurfaceQueue[];
  cloudExcluded: boolean;
  cloudTaskStatus: 'unsupported';
  isSyntheticBenchmark: boolean;
  latestDecisionText: string | null;
  latestDecisionMsgIndex: number | null;
  latestDecisionSpeaker: 'user_committed' | 'assistant_suggested' | null;
  nextStepText: string | null;
  nextStepMsgIndex: number | null;
  nextStepSpeaker: 'user_committed' | 'assistant_suggested' | null;
  /** Project/folder the provider itself files this thread under (ChatGPT/Claude Projects, CLI repo). */
  providerProjectName?: string | null;
  /** Working directory of a CLI coding session (Claude Code, Codex CLI). */
  workspacePath?: string | null;
  gitBranch?: string | null;
  /** Model the conversation ran on, when the provider exposes it. */
  modelSlug?: string | null;
  /** Shell command that resumes a CLI session, e.g. `claude --resume <id>`. */
  resumeCommand?: string | null;
  /** Where the current project assignment came from; manual/locked assignments are never overridden. */
  projectSource?: ProjectSource;
  /** Human-readable reason for an automatic project assignment. */
  projectReason?: string | null;
  /** Whether workflowState was set by the user or inferred automatically. */
  workflowStateSource?: 'auto' | 'manual';
  /**
   * Who did the work in an agent thread: the agent's name and the runner it uses,
   * e.g. "CEO · Grok Bot" or "Engineer · Claude Code" (Paperclip issues).
   */
  agentLabel?: string | null;
  /**
   * Other threads that hold the same work, e.g. the Claude Code or Codex sessions a
   * Paperclip agent ran for this issue (their keys, whether or not they are imported yet).
   */
  linkedThreadKeys?: string[];
}

export type ProjectSource =
  | 'default'
  | 'import'
  | 'provider'
  | 'ai'
  | 'rules'
  | 'similar'
  | 'cluster'
  | 'manual';

export interface MessageRecord {
  messageKey: string;
  threadKey: string;
  ordinal: number;
  sourceMessageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string | null;
  contentHash: string;
  hasCode: boolean;
  hasArtifact: boolean;
  branchPath: string;
}

export interface ChunkRecord {
  chunkKey: string;
  threadKey: string;
  chunkIndex: number;
  messageStartOrdinal: number;
  messageEndOrdinal: number;
  text: string;
  contentHash: string;
  sourceRevision: number;
}

export interface VectorIndexEntry {
  vectorKey: string;
  indexType: 'standard' | 'contextual';
  model: 'voyage-4' | 'voyage-4-large' | 'voyage-context-4';
  dimensions: 256 | 512 | 1024 | 2048;
  threadKey: string;
  chunkKey: string;
  accountId: string;
  workspaceId: string;
  provider: ProviderId;
  sourceRevision: number;
  contextGroupHash: string | null;
  embedding: number[];
  updatedAt: string;
}

export interface ExtractedItem {
  text: string;
  messageIndexes: number[];
  evidenceQuote: string;
  provenance?: 'explicit' | 'inferred';
  speaker: 'user_committed' | 'assistant_suggested';
}

export interface ExtensionSummaryOutput {
  whereYouLeftOff: string;
  whereYouLeftOffMessageIndexes: number[];
  currentStatus: string;
  currentStatusMessageIndexes: number[];
  decisions: ExtractedItem[];
  openQuestions: ExtractedItem[];
  actionItems: ExtractedItem[];
  constraints: ExtractedItem[];
  entities: string[];
  artifactReferences: string[];
  suggestedProject: string | null;
  suggestedTags: string[];
  confidence: number;
}

export interface StructuredSummaryRecord extends ExtensionSummaryOutput {
  threadKey: string;
  sourceRevision: number;
  contentHash: string;
  model: string;
  generatedAt: string;
  groundingVerified: boolean;
}

export function verifyExtensionSummaryEvidence(
  summary: ExtensionSummaryOutput,
  messages: Array<{
    index: number;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
  }>
): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  const byIndex = new Map<number, (typeof messages)[number]>();
  for (const m of messages) {
    byIndex.set(m.index, m);
  }

  if (summary.whereYouLeftOffMessageIndexes.length === 0) {
    errors.push('whereYouLeftOffMessageIndexes must reference at least one source message.');
  }
  for (const idx of summary.whereYouLeftOffMessageIndexes) {
    if (!byIndex.has(idx)) {
      errors.push(`whereYouLeftOff references missing message index ${idx}.`);
    }
  }
  for (const idx of summary.currentStatusMessageIndexes) {
    if (!byIndex.has(idx)) {
      errors.push(`currentStatus references missing message index ${idx}.`);
    }
  }

  if (
    containsPromptInjectionAttempt(summary.whereYouLeftOff) ||
    containsPromptInjectionAttempt(summary.currentStatus)
  ) {
    errors.push('Summary text contains untrusted prompt injection directive.');
  }

  const checkItems = (items: ExtractedItem[], section: string) => {
    for (const item of items) {
      if (!item.messageIndexes || item.messageIndexes.length === 0) {
        errors.push(`${section} item "${item.text}" has no messageIndexes.`);
        continue;
      }
      if (containsPromptInjectionAttempt(item.text)) {
        errors.push(`${section} item "${item.text}" contains prompt injection directive.`);
      }
      let quoteMatched = false;
      let hasUserSpeaker = false;
      const normQuote = item.evidenceQuote.replace(/\s+/g, ' ').trim().toLowerCase();
      for (const idx of item.messageIndexes) {
        const msg = byIndex.get(idx);
        if (!msg) {
          errors.push(`${section} item "${item.text}" references non-existent message index ${idx}.`);
          continue;
        }
        if (msg.role === 'user') {
          hasUserSpeaker = true;
        }
        const normContent = msg.content.replace(/\s+/g, ' ').trim().toLowerCase();
        if (normQuote.length >= 12 && normContent.includes(normQuote)) {
          quoteMatched = true;
        }
      }
      if (!quoteMatched) {
        errors.push(`${section} item "${item.text}" quote "${item.evidenceQuote}" is not grounded in referenced messages.`);
      }
      if (item.speaker === 'user_committed' && !hasUserSpeaker) {
        errors.push(`${section} item "${item.text}" marks assistant-only message as user_committed.`);
      }
    }
  };

  checkItems(summary.decisions, 'decision');
  checkItems(summary.openQuestions, 'openQuestion');
  checkItems(summary.actionItems, 'actionItem');
  checkItems(summary.constraints, 'constraint');

  return {
    valid: errors.length === 0,
    errors,
  };
}

export type RelationType =
  | 'related'
  | 'continues'
  | 'supersedes'
  | 'contradicts'
  | 'branches_from'
  | 'shares_artifact';

export interface RelationshipRecord {
  relationshipKey: string;
  fromThreadKey: string;
  toThreadKey: string;
  relationType: RelationType;
  reason: string;
  evidenceFromOrdinal: number;
  evidenceToOrdinal: number;
  confidence: number;
  confirmedByUser: boolean;
  dismissedByUser: boolean;
}

export interface CollectionRecord {
  name: string;
  description: string;
  isStarterArea: boolean;
  cloudExcluded: boolean;
  createdAt: string;
  /** Terms that route a thread into this project during automatic filing. */
  keywords?: string[];
  /** Who created the project: starter set, the user, the auto-organizer or a provider project. */
  origin?: 'starter' | 'user' | 'auto' | 'provider';
}

export interface TagRecord {
  canonicalName: string;
  synonyms: string[];
  usageCount: number;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  jobId: string;
  jobType: 'enrich_thread' | 'embed_thread' | 'reconcile_index' | 'analyze_thread';
  threadKey: string;
  targetRevision: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  /** Earliest time the job may run (debounces analysis while a chat is still active). */
  notBefore?: string;
  /** Lease expiry for a claimed job so the service worker and manager never double-process. */
  leaseUntil?: string | null;
}

export const THREAD_KINDS = [
  'coding',
  'debugging',
  'writing',
  'research',
  'planning',
  'brainstorming',
  'learning',
  'data',
  'design',
  'business',
  'personal',
  'other',
] as const;

export type ThreadKind = (typeof THREAD_KINDS)[number];

export const THREAD_KIND_LABELS: Record<ThreadKind, string> = {
  coding: 'Building',
  debugging: 'Debugging',
  writing: 'Writing',
  research: 'Research',
  planning: 'Planning',
  brainstorming: 'Ideas',
  learning: 'Learning',
  data: 'Data & analysis',
  design: 'Design',
  business: 'Business',
  personal: 'Personal',
  other: 'General',
};

export type ArtifactKind = 'code' | 'document' | 'design' | 'data' | 'link' | 'other';

/**
 * What a thread is about, beyond its title. `local` insights are computed
 * instantly on-device; `ai` insights come from Claude and win when current.
 */
export interface ThreadInsight {
  insightKey: string;
  threadKey: string;
  source: 'local' | 'ai';
  model: string;
  sourceRevision: number;
  contentHash: string;
  generatedAt: string;
  title: string;
  gist: string;
  summary: string;
  userGoal: string | null;
  outcome: string | null;
  kind: ThreadKind;
  topics: string[];
  entities: string[];
  languages: string[];
  artifacts: Array<{ label: string; kind: ArtifactKind; messageIndex: number | null }>;
  lastUserAsk: string | null;
  suggestedStatus: WorkflowState | null;
  statusReason: string | null;
  suggestedProject: {
    name: string;
    isNew: boolean;
    confidence: number;
    reason: string;
  } | null;
  userTurns: number;
  hasCode: boolean;
}

export function insightKeyFor(source: ThreadInsight['source'], threadKey: string): string {
  return `${source}|${threadKey}`;
}

/** One embedding per thread per vector space, used for semantic search, auto-filing and related threads. */
export interface ThreadVectorRecord {
  vectorKey: string;
  space: string;
  threadKey: string;
  sourceRevision: number;
  docHash: string;
  embedding: number[];
  updatedAt: string;
}

export interface StoredHandleRecord {
  id: string;
  kind: 'claude_code_projects' | 'codex_sessions';
  handle: unknown;
  label: string;
  lastSyncedAt: string | null;
}

export interface ChangeLogEntry {
  changeId: string;
  createdAt: string;
  description: string;
  undone: boolean;
  snapshots: Array<{
    threadKey: string;
    previousProject: string;
    previousCategoryLocked: boolean;
    previousTags: string[];
    previousManualTags: string[];
    previousWorkflowState: WorkflowState;
    previousManualTitleOverride: string | null;
    previousProjectSource?: ProjectSource;
    previousWorkflowStateSource?: 'auto' | 'manual';
    /** Recorded by bulk edits; undo restores them when present. */
    previousProjectReason?: string | null;
    previousPinned?: boolean;
    previousCloudExcluded?: boolean;
  }>;
  /** Projects created by this change; removed on undo when empty. */
  createdCollections?: string[];
}

export interface TombstoneRecord {
  threadKey: string;
  provider?: ProviderId;
  sourceConversationId?: string;
  branchId?: string;
  deletedAt: string;
  lastKnownContentHash: string;
}

export type AiModelId =
  | 'claude-opus-5-5'
  | 'claude-sonnet-5-5'
  | 'claude-haiku-5-5'
  | 'claude-fable-5-1';

export type EmbeddingProviderId = 'local' | 'voyage' | 'mongodb' | 'cohere' | 'openai' | 'ollama' | 'bedrock';

/** Voyage models served by MongoDB Atlas (ai.mongodb.com). */
export type MongoDbEmbeddingModel = 'voyage-4-lite' | 'voyage-4' | 'voyage-4-large' | 'voyage-code-4';
export type MongoDbRerankModel = 'rerank-3-lite' | 'rerank-3' | 'rerank-2.5-lite' | 'rerank-2.5';
/** Which Atlas model API host a key belongs to; a key only works on the geography it was issued for. */
export type MongoDbGeography = 'global' | 'us' | 'eu';

/** Cohere models called directly on api.cohere.com. */
export type CohereEmbeddingModel =
  | 'embed-v5.0-fast'
  | 'embed-v5.0-pro'
  | 'embed-v4.0'
  | 'embed-multilingual-v3.0'
  | 'embed-english-v3.0';
export type CohereEmbeddingDimensions = 256 | 512 | 1024 | 1536 | 2048;
export type CohereRerankModel =
  | 'rerank-v5.0-fast'
  | 'rerank-v5.0-pro'
  | 'rerank-v4.0-fast'
  | 'rerank-v4.0-pro'
  | 'rerank-v3.5';

/** Where Claude requests go: Anthropic's API, Claude in Amazon Bedrock, or Claude Platform on AWS. */
export type AiBackend = 'anthropic' | 'bedrock' | 'aws_platform';

export type BedrockEmbeddingModel =
  | 'amazon.titan-embed-text-v2:0'
  | 'cohere.embed-v4:0'
  | 'cohere.embed-english-v3'
  | 'cohere.embed-multilingual-v3';

export type RerankProviderId = 'none' | 'voyage' | 'mongodb' | 'cohere' | 'bedrock';

export type BedrockRerankModel = 'cohere.rerank-v3-5:0' | 'amazon.rerank-v1:0';

export interface AutoOrganizeSettings {
  /** Run the on-device analyzer on every capture/import (instant, free). */
  localAnalysis: boolean;
  /** Queue Claude analysis for new or changed threads when an API key is set. */
  aiAnalysis: boolean;
  /** File threads into projects automatically (never touches locked/manual assignments). */
  autoFile: boolean;
  /** Allow new projects to be created from provider projects, repos and AI suggestions. */
  autoCreateProjects: boolean;
  /** Infer workflow status (active / needs review / done / paused) unless set manually. */
  autoStatus: boolean;
  /** Add topic tags automatically. */
  autoTags: boolean;
  /** Seconds a thread must be quiet before AI analysis runs (avoids re-analyzing mid-chat). */
  aiDebounceSeconds: number;
  /** Maximum Claude analyses per UTC day (0 = unlimited). */
  dailyAiAnalysisLimit: number;
}

export interface PaperclipSettings {
  /** Sync is on: issues are pulled every few minutes and on "Sync now". */
  enabled: boolean;
  /** Server origin, e.g. http://localhost:3100 (the API lives under /api). */
  serverUrl: string;
  /** How requests authenticate: none on a local_trusted instance, else a board API key. */
  auth: 'none' | 'board_key';
  /** Board API key (pcp_board_…), from the approval flow or pasted. */
  apiKey: string;
  /** When the board key stops working ('' = unknown). */
  apiKeyExpiresAt: string;
  /** Who the key signs in as, shown in Settings. */
  accountLabel: string;
  /** Deployment mode reported by /api/health at the last check. */
  deploymentMode: '' | 'local_trusted' | 'authenticated';
  /** Every company the user can see, or only the chosen ones. */
  companyScope: 'all' | 'selected';
  companyIds: string[];
  /** Listen to the server's live events (local_trusted only) to sync sooner. */
  liveUpdates: boolean;
}

export const DEFAULT_PAPERCLIP_URL = 'http://localhost:3100';

export const DEFAULT_PAPERCLIP_SETTINGS: PaperclipSettings = {
  enabled: false,
  serverUrl: DEFAULT_PAPERCLIP_URL,
  auth: 'none',
  apiKey: '',
  apiKeyExpiresAt: '',
  accountLabel: '',
  deploymentMode: '',
  companyScope: 'all',
  companyIds: [],
  liveUpdates: true,
};

/** Coerce a stored (possibly partial or older) Paperclip settings object. */
export function normalizePaperclipSettings(raw: Partial<PaperclipSettings> | null | undefined): PaperclipSettings {
  const base = { ...DEFAULT_PAPERCLIP_SETTINGS, ...(raw && typeof raw === 'object' ? raw : {}) };
  const text = (v: unknown, fallback = '') => (typeof v === 'string' ? v.trim() : fallback);
  return {
    enabled: base.enabled === true,
    serverUrl: text(base.serverUrl, DEFAULT_PAPERCLIP_URL) || DEFAULT_PAPERCLIP_URL,
    auth: base.auth === 'board_key' ? 'board_key' : 'none',
    apiKey: text(base.apiKey),
    apiKeyExpiresAt: text(base.apiKeyExpiresAt),
    accountLabel: text(base.accountLabel).slice(0, 200),
    deploymentMode:
      base.deploymentMode === 'local_trusted' || base.deploymentMode === 'authenticated' ? base.deploymentMode : '',
    companyScope: base.companyScope === 'selected' ? 'selected' : 'all',
    companyIds: Array.isArray(base.companyIds)
      ? Array.from(new Set(base.companyIds.filter((id): id is string => typeof id === 'string' && id.trim() !== '').map((id) => id.trim()))).slice(0, 200)
      : [],
    liveUpdates: base.liveUpdates !== false,
  };
}

export interface SettingsRecord {
  id: 'default';
  settingsVersion?: number;
  authorizedHosts: Record<CaptureProviderId, boolean>;
  boundAccounts: Record<ProviderId, { accountId: string; workspaceId: string }>;
  cloudEnabled: boolean;
  workerEndpointUrl: string;
  workerBearerToken: string;
  cloudExcludedProviders: ProviderId[];
  dailyCloudRequestBudget: number;
  dailyCloudRequestsUsed: number;
  dailyCloudBudgetDate: string;
  embeddingIndexType: 'standard' | 'contextual';
  embeddingModel: 'voyage-4' | 'voyage-4-large' | 'voyage-context-4';
  embeddingDimensions: 256 | 512 | 1024 | 2048;
  /** Voyage reranker, used directly (rerankProvider "voyage") and by the optional Worker. */
  rerankModel: 'rerank-3-lite' | 'rerank-3';
  enableClefRouting: boolean;
  density: 'comfortable' | 'compact';
  theme: 'light' | 'dark' | 'system';
  sidebarCollapsed: boolean;
  viewMode: 'list' | 'kanban' | 'cards';
  lastSelectedThreadKey: string | null;
  lastSearchQuery: string;
  lastActiveArea: string;
  lastActiveQueue: ResurfaceQueue | 'all';
  /** Toolbar button behaviour: side panel (default), in-page overlay, or a full tab. */
  launchSurface: 'side_panel' | 'overlay' | 'tab';
  /** Where Claude requests go. */
  aiBackend: AiBackend;
  anthropicApiKey: string;
  /** Shared AWS region and credentials (Bedrock Claude, embeddings and reranking). */
  aws: AwsSettings;
  /** Claude Platform on AWS workspace (wrkspc_…) and short-term API key. */
  awsPlatformWorkspaceId: string;
  awsPlatformApiKey: string;
  aiModel: AiModelId;
  aiEffort: 'low' | 'medium' | 'high';
  aiAnalysesToday: number;
  aiAnalysesDate: string;
  embeddingProvider: EmbeddingProviderId;
  voyageApiKey: string;
  voyageModel: 'voyage-4-lite' | 'voyage-4' | 'voyage-4-large' | 'voyage-code-4';
  openaiApiKey: string;
  openaiEmbeddingModel: 'text-embedding-3-small' | 'text-embedding-3-large';
  ollamaUrl: string;
  ollamaEmbeddingModel: string;
  bedrockEmbeddingModel: BedrockEmbeddingModel;
  bedrockEmbeddingDimensions: 256 | 512 | 1024;
  /** MongoDB Atlas model API (Voyage models). The key is issued in Atlas, not at voyageai.com. */
  mongodbApiKey: string;
  mongodbGeography: MongoDbGeography;
  mongodbEmbeddingModel: MongoDbEmbeddingModel;
  mongodbEmbeddingDimensions: 256 | 512 | 1024 | 2048;
  mongodbRerankModel: MongoDbRerankModel;
  /** Cohere's own API (api.cohere.com). */
  cohereApiKey: string;
  cohereEmbeddingModel: CohereEmbeddingModel;
  /** Used by embed-v4.0 and embed-v5.0-*; the v3 models have a fixed size. */
  cohereEmbeddingDimensions: CohereEmbeddingDimensions;
  cohereRerankModel: CohereRerankModel;
  /** Second-stage reranker for search results and Ask context. */
  rerankProvider: RerankProviderId;
  bedrockRerankModel: BedrockRerankModel;
  /** How many first-stage candidates the reranker re-scores. */
  rerankCandidates: number;
  rerankInSearch: boolean;
  rerankInAsk: boolean;
  autoOrganize: AutoOrganizeSettings;
  /** Paperclip server sync (issues, comments and agent runs as threads). */
  paperclip: PaperclipSettings;
  /** Last background AI failure, surfaced in the manager so silent failures are visible. */
  lastAiError?: string | null;
  lastAiErrorAt?: string | null;
}

const DEFAULT_ACCOUNT_IDS: Record<ProviderId, string> = {
  chatgpt: 'acct_chatgpt_primary',
  claude: 'acct_claude_primary',
  claude_code: 'acct_claude_code_primary',
  codex: 'acct_codex_primary',
  grok: 'acct_grok_primary',
  grok_x: 'acct_grok_x_primary',
  gemini: 'acct_gemini_primary',
  ai_studio: 'acct_ai_studio_primary',
  perplexity: 'acct_perplexity_primary',
  deepseek: 'acct_deepseek_primary',
  mistral: 'acct_mistral_primary',
  copilot: 'acct_copilot_primary',
  kimi: 'acct_kimi_primary',
  paperclip: 'acct_paperclip_primary',
  imported: 'acct_imported_primary',
};

export const DEFAULT_AUTO_ORGANIZE: AutoOrganizeSettings = {
  localAnalysis: true,
  aiAnalysis: true,
  autoFile: true,
  autoCreateProjects: true,
  autoStatus: true,
  autoTags: true,
  aiDebounceSeconds: 90,
  dailyAiAnalysisLimit: 150,
};

export const DEFAULT_SETTINGS: SettingsRecord = {
  id: 'default',
  settingsVersion: 2,
  authorizedHosts: Object.fromEntries(
    CAPTURE_PROVIDER_IDS.map((id) => [id, true])
  ) as Record<CaptureProviderId, boolean>,
  boundAccounts: Object.fromEntries(
    PROVIDER_IDS.map((id) => [
      id,
      { accountId: DEFAULT_ACCOUNT_IDS[id], workspaceId: 'ws_personal' },
    ])
  ) as Record<ProviderId, { accountId: string; workspaceId: string }>,
  cloudEnabled: false,
  workerEndpointUrl: '',
  workerBearerToken: '',
  cloudExcludedProviders: [],
  dailyCloudRequestBudget: 0,
  dailyCloudRequestsUsed: 0,
  dailyCloudBudgetDate: '2026-10-25',
  embeddingIndexType: 'standard',
  embeddingModel: 'voyage-4',
  embeddingDimensions: 1024,
  rerankModel: 'rerank-3-lite',
  enableClefRouting: false,
  density: 'comfortable',
  theme: 'system',
  sidebarCollapsed: false,
  viewMode: 'list',
  lastSelectedThreadKey: null,
  lastSearchQuery: '',
  lastActiveArea: 'All threads',
  lastActiveQueue: 'all',
  launchSurface: 'side_panel',
  aiBackend: 'anthropic',
  anthropicApiKey: '',
  aws: { ...DEFAULT_AWS_SETTINGS },
  awsPlatformWorkspaceId: '',
  awsPlatformApiKey: '',
  aiModel: 'claude-opus-5-5',
  aiEffort: 'low',
  aiAnalysesToday: 0,
  aiAnalysesDate: '',
  embeddingProvider: 'local',
  voyageApiKey: '',
  voyageModel: 'voyage-4-lite',
  openaiApiKey: '',
  openaiEmbeddingModel: 'text-embedding-3-small',
  ollamaUrl: 'http://localhost:11434',
  ollamaEmbeddingModel: 'nomic-embed-text',
  bedrockEmbeddingModel: 'amazon.titan-embed-text-v2:0',
  bedrockEmbeddingDimensions: 1024,
  mongodbApiKey: '',
  mongodbGeography: 'global',
  mongodbEmbeddingModel: 'voyage-4-lite',
  mongodbEmbeddingDimensions: 1024,
  mongodbRerankModel: 'rerank-3-lite',
  cohereApiKey: '',
  cohereEmbeddingModel: 'embed-v5.0-fast',
  cohereEmbeddingDimensions: 1024,
  cohereRerankModel: 'rerank-v5.0-fast',
  rerankProvider: 'none',
  bedrockRerankModel: 'cohere.rerank-v3-5:0',
  rerankCandidates: 40,
  rerankInSearch: true,
  rerankInAsk: true,
  autoOrganize: { ...DEFAULT_AUTO_ORGANIZE },
  paperclip: { ...DEFAULT_PAPERCLIP_SETTINGS },
};

/**
 * Merge a stored (possibly older) settings record over the defaults so every
 * field and every provider entry exists. Unknown legacy values are kept.
 */
export function normalizeSettings(raw: Partial<SettingsRecord> | null | undefined): SettingsRecord {
  const base = raw ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...base,
    id: 'default',
    authorizedHosts: {
      ...DEFAULT_SETTINGS.authorizedHosts,
      ...(base.authorizedHosts ?? {}),
    },
    boundAccounts: {
      ...DEFAULT_SETTINGS.boundAccounts,
      ...(base.boundAccounts ?? {}),
    },
    autoOrganize: {
      ...DEFAULT_AUTO_ORGANIZE,
      ...(base.autoOrganize ?? {}),
    },
    aws: {
      ...DEFAULT_AWS_SETTINGS,
      ...(base.aws ?? {}),
    },
    paperclip: normalizePaperclipSettings(base.paperclip),
  };
}

export function computeDeterministicHash(input: string): string {
  let h1 = 0xdeadbeef ^ input.length;
  let h2 = 0x41c6ce57 ^ input.length;
  for (let i = 0, ch; i < input.length; i++) {
    ch = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (
    (h2 >>> 0).toString(16).padStart(8, '0') +
    (h1 >>> 0).toString(16).padStart(8, '0')
  );
}

export function getDisplayTitle(conv: ConversationRecord): string {
  if (conv.manualTitleOverride && conv.manualTitleOverride.trim().length > 0) {
    return conv.manualTitleOverride.trim();
  }
  return conv.title;
}
