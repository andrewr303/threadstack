import { containsPromptInjectionAttempt } from '../../shared/cloud.js';

export type ProviderId = 'chatgpt' | 'claude' | 'imported';

export type CoverageState =
  | 'full'
  | 'partial'
  | 'title_only'
  | 'metadata_only'
  | 'stale';

export type CaptureSource =
  | 'dom_observer'
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
  if (provider !== 'chatgpt' && provider !== 'claude' && provider !== 'imported') {
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
}

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
}

export interface TagRecord {
  canonicalName: string;
  synonyms: string[];
  usageCount: number;
}

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface JobRecord {
  jobId: string;
  jobType: 'enrich_thread' | 'embed_thread' | 'reconcile_index';
  threadKey: string;
  targetRevision: number;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
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
  }>;
}

export interface TombstoneRecord {
  threadKey: string;
  provider?: ProviderId;
  sourceConversationId?: string;
  branchId?: string;
  deletedAt: string;
  lastKnownContentHash: string;
}

export interface SettingsRecord {
  id: 'default';
  authorizedHosts: {
    chatgpt: boolean;
    claude: boolean;
  };
  boundAccounts: {
    chatgpt: { accountId: string; workspaceId: string };
    claude: { accountId: string; workspaceId: string };
    imported: { accountId: string; workspaceId: string };
  };
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
}

export const DEFAULT_SETTINGS: SettingsRecord = {
  id: 'default',
  authorizedHosts: {
    chatgpt: false,
    claude: false,
  },
  boundAccounts: {
    chatgpt: { accountId: 'acct_chatgpt_primary', workspaceId: 'ws_personal' },
    claude: { accountId: 'acct_claude_primary', workspaceId: 'ws_personal' },
    imported: { accountId: 'acct_imported_primary', workspaceId: 'ws_personal' },
  },
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
  theme: 'light',
  sidebarCollapsed: false,
  viewMode: 'list',
  lastSelectedThreadKey: null,
  lastSearchQuery: '',
  lastActiveArea: 'All threads',
  lastActiveQueue: 'all',
};

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
