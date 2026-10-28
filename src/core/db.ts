import Dexie, { type Table } from 'dexie';
import { PROVIDER_IDS, CAPTURE_PROVIDER_IDS } from './providers.js';
import {
  STARTER_AREAS,
  normalizeSettings,
  computeDeterministicHash,
  verifyExtensionSummaryEvidence as verifyStructuredSummaryEvidence,
  type ExtensionSummaryOutput as StructuredSummaryOutput,
  type ConversationRecord,
  type MessageRecord,
  type ChunkRecord,
  type VectorIndexEntry,
  type StructuredSummaryRecord,
  type RelationshipRecord,
  type CollectionRecord,
  type TagRecord,
  type JobRecord,
  type ChangeLogEntry,
  type TombstoneRecord,
  type SettingsRecord,
  type CoverageState,
  type CaptureSource,
  type ProviderId,
  type WorkflowState,
  type ThreadInsight,
  type ThreadVectorRecord,
  type StoredHandleRecord,
  type ProjectSource,
} from './schema.js';

export class ThreadkeeperDB extends Dexie {
  conversations!: Table<ConversationRecord, string>;
  messages!: Table<MessageRecord, string>;
  chunks!: Table<ChunkRecord, string>;
  vectors!: Table<VectorIndexEntry, string>;
  summaries!: Table<StructuredSummaryRecord, string>;
  relationships!: Table<RelationshipRecord, string>;
  collections!: Table<CollectionRecord, string>;
  tags!: Table<TagRecord, string>;
  jobs!: Table<JobRecord, string>;
  changeLogs!: Table<ChangeLogEntry, string>;
  tombstones!: Table<TombstoneRecord, string>;
  settings!: Table<SettingsRecord, string>;
  insights!: Table<ThreadInsight, string>;
  threadVectors!: Table<ThreadVectorRecord, string>;
  handles!: Table<StoredHandleRecord, string>;

  constructor(dbName = 'ThreadkeeperDB') {
    super(dbName);
    this.version(1).stores({
      conversations:
        'threadKey, provider, accountId, workspaceId, sourceConversationId, project, workflowState, coverage, updatedAt, isSyntheticBenchmark',
      messages: 'messageKey, threadKey, ordinal, sourceMessageId',
      chunks: 'chunkKey, threadKey, chunkIndex',
      vectors:
        'vectorKey, [indexType+model+dimensions], threadKey, chunkKey, accountId, workspaceId, provider',
      summaries: 'threadKey, sourceRevision',
      relationships: 'relationshipKey, fromThreadKey, toThreadKey, relationType',
      collections: 'name, isStarterArea',
      tags: 'canonicalName',
      jobs: 'jobId, status, threadKey, jobType',
      changeLogs: 'changeId, createdAt, undone',
      tombstones: 'threadKey, [provider+sourceConversationId+branchId], deletedAt',
      settings: 'id',
    });
    this.version(2)
      .stores({
        insights: 'insightKey, threadKey, source, kind',
        threadVectors: 'vectorKey, threadKey, space',
        handles: 'id',
      })
      .upgrade(async (tx) => {
        // v1 shipped with capture opt-in and off for every host, so nothing was
        // captured or organized automatically. Automatic capture is now the default.
        await tx
          .table('settings')
          .toCollection()
          .modify((raw: Partial<SettingsRecord>) => {
            const next = normalizeSettings(raw);
            for (const id of CAPTURE_PROVIDER_IDS) {
              next.authorizedHosts[id] = true;
            }
            next.settingsVersion = 2;
            Object.assign(raw, next);
          });
        await tx
          .table('conversations')
          .toCollection()
          .modify((conv: ConversationRecord) => {
            if (!conv.projectSource) {
              conv.projectSource = conv.categoryLocked
                ? 'manual'
                : conv.project === UNFILED_PROJECT
                  ? 'default'
                  : 'import';
            }
            if (!conv.workflowStateSource) {
              conv.workflowStateSource = conv.workflowState === 'active' ? 'auto' : 'manual';
            }
          });
        await tx
          .table('collections')
          .toCollection()
          .modify((col: CollectionRecord) => {
            if (!col.origin) col.origin = col.isStarterArea ? 'starter' : 'user';
            if (!col.keywords) col.keywords = [];
          });
      });
  }
}

export const UNFILED_PROJECT = 'Unfiled / Uncertain';

export async function ensureStarterCollectionsAndSettings(
  db: ThreadkeeperDB
): Promise<SettingsRecord> {
  const existingSettings = await db.settings.get('default');
  if (!existingSettings) {
    await db.settings.put(normalizeSettings(null));
  }
  const existingCollections = await db.collections.count();
  if (existingCollections === 0) {
    const now = new Date().toISOString();
    const descriptions: Record<string, string> = {
      HypeStake: 'Sports analytics, market pricing, and HypeStake product threads',
      'Velotic / FrameConcepts':
        'Creative tooling, motion pipelines, and FrameConcepts studio work',
      'Daydock / Meridian':
        'Scheduling, workspace architecture, and Daydock / Meridian brand systems',
      'General research': 'Technical explorations, benchmarks, and cross-domain study',
      Personal: 'Personal planning, notes, and private threads',
      'Unfiled / Uncertain': 'Captured or imported threads awaiting classification',
    };
    await db.collections.bulkPut(
      STARTER_AREAS.map((name) => ({
        name,
        description: descriptions[name] ?? '',
        isStarterArea: true,
        cloudExcluded: name === 'Personal',
        createdAt: now,
        keywords: STARTER_AREA_KEYWORDS[name] ?? [],
        origin: 'starter' as const,
      }))
    );
  }
  return normalizeSettings(await db.settings.get('default'));
}

/** Seed routing keywords for the starter areas; users and the auto-organizer extend these. */
export const STARTER_AREA_KEYWORDS: Record<string, string[]> = {
  HypeStake: ['hypestake', 'sportsbook', 'odds', 'betting', 'wager', 'parlay'],
  'Velotic / FrameConcepts': ['velotic', 'frameconcepts', 'frame concepts', 'shader', 'motion pipeline'],
  'Daydock / Meridian': ['daydock', 'meridian'],
  'General research': [],
  Personal: [],
  'Unfiled / Uncertain': [],
};

/** Persist a settings patch and return the normalized result. */
export async function saveSettingsPatch(
  db: ThreadkeeperDB,
  patch: Partial<SettingsRecord>
): Promise<SettingsRecord> {
  return db.transaction('rw', db.settings, async () => {
    const current = normalizeSettings(await db.settings.get('default'));
    const updated = normalizeSettings({ ...current, ...patch });
    await db.settings.put(updated);
    return updated;
  });
}

export interface UpsertThreadInput {
  threadKey: string;
  provider: ProviderId;
  accountId: string;
  workspaceId: string;
  sourceConversationId: string;
  branchId: string;
  parentBranchId?: string | null;
  siblingBranchIds?: string[];
  canonicalUrl: string;
  title: string;
  manualTitleOverride?: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  coverage: CoverageState;
  captureSource: CaptureSource;
  project?: string;
  categoryLocked?: boolean;
  tags?: string[];
  workflowState?: WorkflowState;
  manualNotes?: string;
  pinned?: boolean;
  cloudExcluded?: boolean;
  isSyntheticBenchmark?: boolean;
  latestDecisionText?: string | null;
  latestDecisionMsgIndex?: number | null;
  latestDecisionSpeaker?: 'user_committed' | 'assistant_suggested' | null;
  nextStepText?: string | null;
  nextStepMsgIndex?: number | null;
  nextStepSpeaker?: 'user_committed' | 'assistant_suggested' | null;
  providerProjectName?: string | null;
  workspacePath?: string | null;
  gitBranch?: string | null;
  modelSlug?: string | null;
  resumeCommand?: string | null;
  projectSource?: ProjectSource;
  messages: Array<{
    sourceMessageId: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    createdAt: string | null;
    branchPath?: string;
  }>;
  restoreDeleted?: boolean;
}

export function buildChunksFromMessages(
  threadKey: string,
  messages: MessageRecord[],
  sourceRevision: number
): ChunkRecord[] {
  if (messages.length === 0) return [];
  const sorted = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  const chunks: ChunkRecord[] = [];
  const windowSize = 3;
  const stride = 2;
  let chunkIndex = 0;

  for (let i = 0; i < sorted.length; i += stride) {
    const slice = sorted.slice(i, i + windowSize);
    if (slice.length === 0) break;
    const text = slice
      .map((m) => `[m${m.ordinal + 1} ${m.role}]: ${m.content}`)
      .join('\n\n');
    chunks.push({
      chunkKey: `${threadKey}:c:${chunkIndex}`,
      threadKey,
      chunkIndex,
      messageStartOrdinal: slice[0].ordinal,
      messageEndOrdinal: slice[slice.length - 1].ordinal,
      text,
      contentHash: computeDeterministicHash(text),
      sourceRevision,
    });
    chunkIndex += 1;
    if (i + windowSize >= sorted.length) break;
  }
  return chunks;
}

async function findMatchingTombstone(
  db: ThreadkeeperDB,
  input: {
    threadKey: string;
    provider: ProviderId;
    sourceConversationId: string;
    branchId: string;
  }
) {
  const direct = await db.tombstones.get(input.threadKey);
  if (direct) return direct;
  return db.tombstones
    .where('[provider+sourceConversationId+branchId]')
    .equals([input.provider, input.sourceConversationId, input.branchId])
    .first();
}

export async function upsertThread(
  db: ThreadkeeperDB,
  input: UpsertThreadInput
): Promise<{ status: 'skipped_tombstone' | 'stored'; record?: ConversationRecord }> {
  return db.transaction(
    'rw',
    [db.conversations, db.messages, db.chunks, db.vectors, db.tombstones],
    async () => {
      const tombstone = await findMatchingTombstone(db, input);
      if (tombstone && !input.restoreDeleted) {
        return { status: 'skipped_tombstone' as const };
      }
      if (tombstone && input.restoreDeleted) {
        const matchingTombstones = await db.tombstones
          .where('[provider+sourceConversationId+branchId]')
          .equals([input.provider, input.sourceConversationId, input.branchId])
          .toArray();
        const keysToDelete = Array.from(
          new Set([
            input.threadKey,
            tombstone.threadKey,
            ...matchingTombstones.map((t) => t.threadKey),
          ])
        );
        await db.tombstones.bulkDelete(keysToDelete);
      }

      // Enforce DOM capture coverage honesty: DOM observer can never claim 'full'
      let effectiveCoverage: CoverageState = input.coverage;
      if (input.captureSource === 'dom_observer' && effectiveCoverage === 'full') {
        effectiveCoverage = input.messages.length > 0 ? 'partial' : 'title_only';
      }
      if (input.messages.length === 0 && effectiveCoverage === 'partial') {
        effectiveCoverage = 'title_only';
      }

      const existing = await db.conversations.get(input.threadKey);
      const existingMessages = existing
        ? await db.messages.where('threadKey').equals(input.threadKey).sortBy('ordinal')
        : [];

      // Merge messages so partial DOM revisit after lazy-unmount never loses previously captured messages
      const mergedMessagePayloads: Array<{
        sourceMessageId: string;
        role: 'user' | 'assistant' | 'system' | 'tool';
        content: string;
        createdAt: string | null;
        branchPath: string;
      }> = [];

      if (
        existing &&
        input.captureSource === 'dom_observer' &&
        existingMessages.length > input.messages.length
      ) {
        const bySourceId = new Map(
          input.messages.map((m) => [m.sourceMessageId, m])
        );
        for (const prev of existingMessages) {
          const updated = bySourceId.get(prev.sourceMessageId);
          if (updated) {
            mergedMessagePayloads.push({
              sourceMessageId: updated.sourceMessageId,
              role: updated.role,
              content: updated.content,
              createdAt: updated.createdAt ?? prev.createdAt,
              branchPath: updated.branchPath ?? prev.branchPath,
            });
            bySourceId.delete(prev.sourceMessageId);
          } else {
            mergedMessagePayloads.push({
              sourceMessageId: prev.sourceMessageId,
              role: prev.role,
              content: prev.content,
              createdAt: prev.createdAt,
              branchPath: prev.branchPath,
            });
          }
        }
        for (const remaining of bySourceId.values()) {
          mergedMessagePayloads.push({
            sourceMessageId: remaining.sourceMessageId,
            role: remaining.role,
            content: remaining.content,
            createdAt: remaining.createdAt,
            branchPath: remaining.branchPath ?? input.branchId,
          });
        }
      } else {
        for (const msg of input.messages) {
          mergedMessagePayloads.push({
            sourceMessageId: msg.sourceMessageId,
            role: msg.role,
            content: msg.content,
            createdAt: msg.createdAt,
            branchPath: msg.branchPath ?? input.branchId,
          });
        }
      }

      const normalizedMessages: MessageRecord[] = mergedMessagePayloads.map((m, idx) => {
        const content = m.content.trim();
        return {
          messageKey: `${input.threadKey}:m:${idx}`,
          threadKey: input.threadKey,
          ordinal: idx,
          sourceMessageId: m.sourceMessageId || `msg_${idx}`,
          role: m.role,
          content,
          createdAt: m.createdAt,
          contentHash: computeDeterministicHash(`${m.role}:${content}`),
          hasCode: /```|`[^`]+`|\bfunction\b|\bconst\b|\bSELECT\b/.test(content),
          hasArtifact: /\[artifact|canvas|document|diagram|\.tsx|\.py|\.sql/i.test(content),
          branchPath: m.branchPath,
        };
      });

      const combinedHash = computeDeterministicHash(
        `${input.title}|${normalizedMessages.map((m) => m.contentHash).join(',')}`
      );

      const contentChanged = !existing || existing.contentHash !== combinedHash;
      const nextRevision = existing
        ? contentChanged
          ? existing.sourceRevision + 1
          : existing.sourceRevision
        : 1;

      // Preserve full coverage if previously imported from full export and unchanged
      if (
        existing &&
        existing.coverage === 'full' &&
        input.captureSource === 'dom_observer' &&
        !contentChanged
      ) {
        effectiveCoverage = 'full';
      }

      const preservedManualTags = existing?.manualTags ?? [];
      const mergedTags = Array.from(
        new Set([...(input.tags ?? []), ...(existing?.tags ?? []), ...preservedManualTags])
      );

      const effectiveProject = existing?.categoryLocked
        ? existing.project
        : input.project ?? existing?.project ?? UNFILED_PROJECT;
      const effectiveProjectSource: ProjectSource = existing?.categoryLocked
        ? existing.projectSource ?? 'manual'
        : input.project !== undefined && input.project !== existing?.project
          ? input.projectSource ?? 'import'
          : existing?.projectSource ?? input.projectSource ?? (effectiveProject === UNFILED_PROJECT ? 'default' : 'import');

      const now = new Date().toISOString();
      const record: ConversationRecord = {
        threadKey: input.threadKey,
        provider: input.provider,
        accountId: input.accountId,
        workspaceId: input.workspaceId,
        sourceConversationId: input.sourceConversationId,
        branchId: input.branchId,
        parentBranchId: input.parentBranchId ?? existing?.parentBranchId ?? null,
        siblingBranchIds: input.siblingBranchIds ?? existing?.siblingBranchIds ?? [],
        canonicalUrl: input.canonicalUrl,
        title: input.title,
        manualTitleOverride:
          existing?.manualTitleOverride ?? input.manualTitleOverride ?? null,
        createdAt: input.createdAt ?? existing?.createdAt ?? null,
        updatedAt: input.updatedAt ?? existing?.updatedAt ?? null,
        lastCapturedAt: now,
        sourceRevision: nextRevision,
        contentHash: combinedHash,
        coverage: effectiveCoverage,
        captureSource:
          existing?.captureSource === 'export_import' && input.captureSource === 'dom_observer'
            ? 'export_import'
            : input.captureSource,
        messageCount: normalizedMessages.length,
        project: effectiveProject,
        categoryLocked: existing?.categoryLocked ?? input.categoryLocked ?? false,
        tags: mergedTags,
        manualTags: preservedManualTags,
        workflowState: existing?.workflowState ?? input.workflowState ?? 'active',
        manualNotes: existing?.manualNotes ?? input.manualNotes ?? '',
        pinned: existing?.pinned ?? input.pinned ?? false,
        snoozedUntil: existing?.snoozedUntil ?? null,
        dismissedQueues: existing?.dismissedQueues ?? [],
        cloudExcluded: existing?.cloudExcluded ?? input.cloudExcluded ?? false,
        cloudTaskStatus: 'unsupported',
        isSyntheticBenchmark:
          input.isSyntheticBenchmark ?? existing?.isSyntheticBenchmark ?? false,
        latestDecisionText:
          input.latestDecisionText ?? existing?.latestDecisionText ?? null,
        latestDecisionMsgIndex:
          input.latestDecisionMsgIndex ?? existing?.latestDecisionMsgIndex ?? null,
        latestDecisionSpeaker:
          input.latestDecisionSpeaker ?? existing?.latestDecisionSpeaker ?? null,
        nextStepText: input.nextStepText ?? existing?.nextStepText ?? null,
        nextStepMsgIndex: input.nextStepMsgIndex ?? existing?.nextStepMsgIndex ?? null,
        nextStepSpeaker: input.nextStepSpeaker ?? existing?.nextStepSpeaker ?? null,
        providerProjectName:
          input.providerProjectName ?? existing?.providerProjectName ?? null,
        workspacePath: input.workspacePath ?? existing?.workspacePath ?? null,
        gitBranch: input.gitBranch ?? existing?.gitBranch ?? null,
        modelSlug: input.modelSlug ?? existing?.modelSlug ?? null,
        resumeCommand: input.resumeCommand ?? existing?.resumeCommand ?? null,
        projectSource: effectiveProjectSource,
        // An explicit non-default state arriving with an import was set by a person; keep it.
        workflowStateSource:
          existing?.workflowStateSource ??
          (input.workflowState && input.workflowState !== 'active' ? 'manual' : 'auto'),
      };

      await db.conversations.put(record);
      if (contentChanged && !record.isSyntheticBenchmark) {
        await db.messages.where('threadKey').equals(input.threadKey).delete();
        if (normalizedMessages.length > 0) {
          await db.messages.bulkPut(normalizedMessages);
        }
        await db.chunks.where('threadKey').equals(input.threadKey).delete();
        const chunks = buildChunksFromMessages(
          input.threadKey,
          normalizedMessages,
          nextRevision
        );
        if (chunks.length > 0) {
          await db.chunks.bulkPut(chunks);
        }
        // Invalidate stale vectors from older revisions of this thread
        const oldVectors = await db.vectors
          .where('threadKey')
          .equals(input.threadKey)
          .toArray();
        const staleVectorKeys = oldVectors
          .filter((v) => v.sourceRevision < nextRevision)
          .map((v) => v.vectorKey);
        if (staleVectorKeys.length > 0) {
          await db.vectors.bulkDelete(staleVectorKeys);
        }
      }

      return { status: 'stored' as const, record };
    }
  );
}

export async function updateManualThreadFields(
  db: ThreadkeeperDB,
  threadKey: string,
  patch: {
    manualTitleOverride?: string | null;
    project?: string;
    categoryLocked?: boolean;
    manualTags?: string[];
    workflowState?: WorkflowState;
    manualNotes?: string;
    pinned?: boolean;
    snoozedUntil?: string | null;
    dismissedQueues?: ConversationRecord['dismissedQueues'];
    cloudExcluded?: boolean;
  }
): Promise<ConversationRecord | null> {
  return db.transaction('rw', [db.conversations, db.tombstones], async () => {
    const directTombstone = await db.tombstones.get(threadKey);
    if (directTombstone) return null;

    const existing = await db.conversations.get(threadKey);
    if (!existing) return null;

    const compositeTombstone = await findMatchingTombstone(db, existing);
    if (compositeTombstone) return null;

    const nextManualTags =
      patch.manualTags !== undefined ? patch.manualTags : existing.manualTags;
    const nextTags =
      patch.manualTags !== undefined
        ? Array.from(new Set(patch.manualTags))
        : existing.tags;

    const updated: ConversationRecord = {
      ...existing,
      projectSource:
        patch.project !== undefined && patch.project !== existing.project
          ? 'manual'
          : patch.categoryLocked === true
            ? 'manual'
            : existing.projectSource,
      projectReason:
        patch.project !== undefined && patch.project !== existing.project
          ? 'Filed by you'
          : existing.projectReason,
      workflowStateSource:
        patch.workflowState !== undefined ? 'manual' : existing.workflowStateSource,
      manualTitleOverride:
        patch.manualTitleOverride !== undefined
          ? patch.manualTitleOverride
          : existing.manualTitleOverride,
      project: patch.project !== undefined ? patch.project : existing.project,
      categoryLocked:
        patch.categoryLocked !== undefined
          ? patch.categoryLocked
          : patch.project !== undefined
            ? true
            : existing.categoryLocked,
      manualTags: nextManualTags,
      tags: nextTags,
      workflowState:
        patch.workflowState !== undefined
          ? patch.workflowState
          : existing.workflowState,
      manualNotes:
        patch.manualNotes !== undefined ? patch.manualNotes : existing.manualNotes,
      pinned: patch.pinned !== undefined ? patch.pinned : existing.pinned,
      snoozedUntil:
        patch.snoozedUntil !== undefined ? patch.snoozedUntil : existing.snoozedUntil,
      dismissedQueues:
        patch.dismissedQueues !== undefined
          ? patch.dismissedQueues
          : existing.dismissedQueues,
      cloudExcluded:
        patch.cloudExcluded !== undefined
          ? patch.cloudExcluded
          : existing.cloudExcluded,
    };

    await db.conversations.put(updated);
    return updated;
  });
}

export async function applySummaryEnrichment(
  db: ThreadkeeperDB,
  params: {
    threadKey: string;
    sourceRevision: number;
    contentHash: string;
    model: string;
    summary: StructuredSummaryOutput;
  }
): Promise<{
  applied: boolean;
  reason?: string;
  summaryRecord?: StructuredSummaryRecord;
}> {
  const tombstone = await db.tombstones.get(params.threadKey);
  if (tombstone) {
    return { applied: false, reason: 'thread_deleted_tombstone' };
  }

  const conv = await db.conversations.get(params.threadKey);
  if (!conv) {
    return { applied: false, reason: 'thread_not_found' };
  }

  const compositeTombstonePre = await findMatchingTombstone(db, conv);
  if (compositeTombstonePre) {
    return { applied: false, reason: 'thread_deleted_tombstone' };
  }

  if (conv.coverage === 'title_only' || conv.coverage === 'metadata_only') {
    return {
      applied: false,
      reason: `refused_coverage_${conv.coverage}`,
    };
  }

  if (Number(params.sourceRevision) !== Number(conv.sourceRevision)) {
    return {
      applied: false,
      reason: `stale_revision_${params.sourceRevision}_current_${conv.sourceRevision}`,
    };
  }

  if (
    typeof params.contentHash !== 'string' ||
    params.contentHash.trim().length === 0 ||
    typeof conv.contentHash !== 'string' ||
    conv.contentHash.trim().length === 0 ||
    params.contentHash !== conv.contentHash
  ) {
    return {
      applied: false,
      reason: `stale_content_hash_${params.contentHash}_current_${conv.contentHash}`,
    };
  }

  const messages = await db.messages
    .where('threadKey')
    .equals(params.threadKey)
    .sortBy('ordinal');

  const grounding = verifyStructuredSummaryEvidence(
    params.summary,
    messages.map((m) => ({
      index: m.ordinal,
      role: m.role,
      content: m.content,
    }))
  );

  if (!grounding.valid) {
    return {
      applied: false,
      reason: `grounding_failed: ${grounding.errors.join('; ')}`,
    };
  }

  const summaryRecord: StructuredSummaryRecord = {
    threadKey: params.threadKey,
    sourceRevision: params.sourceRevision,
    contentHash: params.contentHash,
    model: params.model,
    generatedAt: new Date().toISOString(),
    whereYouLeftOff: params.summary.whereYouLeftOff,
    whereYouLeftOffMessageIndexes: params.summary.whereYouLeftOffMessageIndexes,
    currentStatus: params.summary.currentStatus,
    currentStatusMessageIndexes: params.summary.currentStatusMessageIndexes,
    decisions: params.summary.decisions,
    openQuestions: params.summary.openQuestions,
    actionItems: params.summary.actionItems,
    constraints: params.summary.constraints,
    entities: params.summary.entities,
    artifactReferences: params.summary.artifactReferences,
    suggestedProject: params.summary.suggestedProject,
    suggestedTags: params.summary.suggestedTags,
    confidence: params.summary.confidence,
    groundingVerified: true,
  };

  const firstDecision = params.summary.decisions[0];
  const firstAction = params.summary.actionItems[0];

  let txRejectedReason: string | undefined;
  let finalConv: ConversationRecord | undefined;

  await db.transaction(
    'rw',
    [db.conversations, db.messages, db.summaries, db.tombstones],
    async () => {
      const txTombstone = await db.tombstones.get(params.threadKey);
      if (txTombstone) {
        txRejectedReason = 'thread_deleted_tombstone';
        return;
      }
      const txConv = await db.conversations.get(params.threadKey);
      if (!txConv) {
        txRejectedReason = 'thread_not_found';
        return;
      }
      const txCompositeTombstone = await findMatchingTombstone(db, txConv);
      if (txCompositeTombstone) {
        txRejectedReason = 'thread_deleted_tombstone';
        return;
      }
      if (Number(params.sourceRevision) !== Number(txConv.sourceRevision)) {
        txRejectedReason = `stale_revision_${params.sourceRevision}_current_${txConv.sourceRevision}`;
        return;
      }
      if (
        typeof params.contentHash !== 'string' ||
        params.contentHash.trim().length === 0 ||
        typeof txConv.contentHash !== 'string' ||
        txConv.contentHash.trim().length === 0 ||
        params.contentHash !== txConv.contentHash
      ) {
        txRejectedReason = `stale_content_hash_${params.contentHash}_current_${txConv.contentHash}`;
        return;
      }

      const txMessages = await db.messages
        .where('threadKey')
        .equals(params.threadKey)
        .sortBy('ordinal');
      const txGrounding = verifyStructuredSummaryEvidence(
        params.summary,
        txMessages.map((m) => ({
          index: m.ordinal,
          role: m.role,
          content: m.content,
        }))
      );
      if (!txGrounding.valid) {
        txRejectedReason = `grounding_failed: ${txGrounding.errors.join('; ')}`;
        return;
      }

      const resolvedProject =
        txConv.categoryLocked || !params.summary.suggestedProject
          ? txConv.project
          : txConv.project === 'Unfiled / Uncertain'
            ? params.summary.suggestedProject
            : txConv.project;

      const mergedTags = Array.from(
        new Set(
          [
            ...txConv.tags,
            ...txConv.manualTags,
            ...params.summary.suggestedTags,
          ]
            .map((t) => t.trim().slice(0, 60))
            .filter((t) => t.length >= 1)
        )
      ).slice(0, 100);

      finalConv = {
        ...txConv,
        project: resolvedProject,
        tags: mergedTags,
        latestDecisionText: firstDecision?.text ?? txConv.latestDecisionText,
        latestDecisionMsgIndex:
          firstDecision?.messageIndexes[0] ?? txConv.latestDecisionMsgIndex,
        latestDecisionSpeaker:
          firstDecision?.speaker ?? txConv.latestDecisionSpeaker,
        nextStepText: firstAction?.text ?? txConv.nextStepText,
        nextStepMsgIndex:
          firstAction?.messageIndexes[0] ?? txConv.nextStepMsgIndex,
        nextStepSpeaker: firstAction?.speaker ?? txConv.nextStepSpeaker,
      };

      await db.summaries.put(summaryRecord);
      await db.conversations.put(finalConv);
    }
  );

  if (txRejectedReason) {
    return { applied: false, reason: txRejectedReason };
  }

  return { applied: true, summaryRecord };
}

export async function deleteConversationCascade(
  db: ThreadkeeperDB,
  threadKey: string
): Promise<void> {
  await db.transaction(
    'rw',
    [
      db.conversations,
      db.messages,
      db.chunks,
      db.vectors,
      db.summaries,
      db.relationships,
      db.jobs,
      db.tombstones,
      db.insights,
      db.threadVectors,
    ],
    async () => {
      const existing = await db.conversations.get(threadKey);
      const parts = threadKey.split(':');
      const provider = existing?.provider ?? (parts[0] as ProviderId | undefined);
      const sourceConversationId = existing?.sourceConversationId ?? parts[3];
      const branchId = existing?.branchId ?? parts[4] ?? 'root';
      await db.tombstones.put({
        threadKey,
        provider,
        sourceConversationId,
        branchId,
        deletedAt: new Date().toISOString(),
        lastKnownContentHash: existing?.contentHash ?? '',
      });
      await db.conversations.delete(threadKey);
      await db.messages.where('threadKey').equals(threadKey).delete();
      await db.chunks.where('threadKey').equals(threadKey).delete();
      await db.vectors.where('threadKey').equals(threadKey).delete();
      await db.summaries.delete(threadKey);
      await db.insights.where('threadKey').equals(threadKey).delete();
      await db.threadVectors.where('threadKey').equals(threadKey).delete();
      await db.relationships.where('fromThreadKey').equals(threadKey).delete();
      await db.relationships.where('toThreadKey').equals(threadKey).delete();

      const pendingJobs = await db.jobs
        .where('threadKey')
        .equals(threadKey)
        .toArray();
      for (const job of pendingJobs) {
        if (job.status === 'pending' || job.status === 'running') {
          await db.jobs.put({
            ...job,
            status: 'cancelled',
            lastError: 'Cancelled due to thread deletion',
            updatedAt: new Date().toISOString(),
          });
        }
      }
    }
  );
}

export interface LibraryReconciledCounts {
  totalThreads: number;
  filedCount: number;
  unfiledCount: number;
  partialOrTitleOnlyCount: number;
  needsReviewCount: number;
  syntheticBenchmarkCount: number;
  projectCounts: Record<string, number>;
  providerCounts: Record<ProviderId, number>;
  coverageCounts: Record<CoverageState, number>;
}

export async function reconcileLibraryCounts(
  db: ThreadkeeperDB,
  options?: { includeSyntheticBenchmark?: boolean; accountId?: string; workspaceId?: string }
): Promise<LibraryReconciledCounts> {
  const all = await db.conversations.toArray();
  let syntheticBenchmarkCount = 0;

  const projectCounts: Record<string, number> = {};
  for (const area of STARTER_AREAS) {
    projectCounts[area] = 0;
  }
  const providerCounts = Object.fromEntries(
    PROVIDER_IDS.map((id) => [id, 0])
  ) as Record<ProviderId, number>;
  const coverageCounts: Record<CoverageState, number> = {
    full: 0,
    partial: 0,
    title_only: 0,
    metadata_only: 0,
    stale: 0,
  };

  let totalThreads = 0;
  let filedCount = 0;
  let unfiledCount = 0;
  let partialOrTitleOnlyCount = 0;
  let needsReviewCount = 0;

  for (const conv of all) {
    if (conv.isSyntheticBenchmark) {
      syntheticBenchmarkCount += 1;
      if (!options?.includeSyntheticBenchmark) {
        continue;
      }
    }
    if (options?.accountId && conv.accountId !== options.accountId) continue;
    if (options?.workspaceId && conv.workspaceId !== options.workspaceId) continue;

    totalThreads += 1;
    const proj = conv.project || UNFILED_PROJECT;
    projectCounts[proj] = (projectCounts[proj] ?? 0) + 1;
    if (proj === UNFILED_PROJECT) {
      unfiledCount += 1;
    } else {
      filedCount += 1;
    }
    providerCounts[conv.provider] = (providerCounts[conv.provider] ?? 0) + 1;
    coverageCounts[conv.coverage] = (coverageCounts[conv.coverage] ?? 0) + 1;
    if (conv.coverage === 'partial' || conv.coverage === 'title_only') {
      partialOrTitleOnlyCount += 1;
    }
    if (conv.workflowState === 'needs_review') {
      needsReviewCount += 1;
    }
  }

  return {
    totalThreads,
    filedCount,
    unfiledCount,
    partialOrTitleOnlyCount,
    needsReviewCount,
    syntheticBenchmarkCount,
    projectCounts,
    providerCounts,
    coverageCounts,
  };
}

export async function enqueueJob(
  db: ThreadkeeperDB,
  params: {
    jobType: JobRecord['jobType'];
    threadKey: string;
    targetRevision: number;
    maxAttempts?: number;
  }
): Promise<JobRecord> {
  const jobId = `${params.jobType}:${params.threadKey}:rev${params.targetRevision}`;
  const now = new Date().toISOString();
  const record: JobRecord = {
    jobId,
    jobType: params.jobType,
    threadKey: params.threadKey,
    targetRevision: params.targetRevision,
    status: 'pending',
    attempts: 0,
    maxAttempts: params.maxAttempts ?? 3,
    lastError: null,
    createdAt: now,
    updatedAt: now,
  };
  await db.jobs.put(record);
  return record;
}

export async function processResumableJobs(
  db: ThreadkeeperDB,
  handler: (job: JobRecord, conv: ConversationRecord) => Promise<void>,
  maxBatchSize = 5
): Promise<{ processed: number; completed: number; cancelled: number; failed: number }> {
  // First recover any interrupted 'running' jobs back to 'pending' if under maxAttempts
  const runningJobs = await db.jobs.where('status').equals('running').toArray();
  for (const job of runningJobs) {
    if (job.attempts >= job.maxAttempts) {
      await db.jobs.put({
        ...job,
        status: 'failed',
        lastError: job.lastError ?? 'Exceeded maxAttempts after interruption',
        updatedAt: new Date().toISOString(),
      });
    } else {
      await db.jobs.put({
        ...job,
        status: 'pending',
        updatedAt: new Date().toISOString(),
      });
    }
  }

  const pendingJobs = await db.jobs
    .where('status')
    .equals('pending')
    .limit(maxBatchSize)
    .toArray();

  let processed = 0;
  let completed = 0;
  let cancelled = 0;
  let failed = 0;

  for (const job of pendingJobs) {
    processed += 1;
    const tombstone = await db.tombstones.get(job.threadKey);
    const conv = await db.conversations.get(job.threadKey);
    if (tombstone || !conv || conv.sourceRevision > job.targetRevision) {
      await db.jobs.put({
        ...job,
        status: 'cancelled',
        lastError: tombstone
          ? 'Thread deleted'
          : !conv
            ? 'Thread missing'
            : 'Superseded by newer revision',
        updatedAt: new Date().toISOString(),
      });
      cancelled += 1;
      continue;
    }

    const runningState: JobRecord = {
      ...job,
      status: 'running',
      attempts: job.attempts + 1,
      updatedAt: new Date().toISOString(),
    };
    await db.jobs.put(runningState);

    try {
      await handler(runningState, conv);
      // Re-check tombstone after async handler completes so a mid-flight deletion never resurrects or completes
      const postTombstone = await db.tombstones.get(job.threadKey);
      if (postTombstone) {
        await db.jobs.put({
          ...runningState,
          status: 'cancelled',
          lastError: 'Thread deleted during job execution',
          updatedAt: new Date().toISOString(),
        });
        cancelled += 1;
      } else {
        await db.jobs.put({
          ...runningState,
          status: 'completed',
          updatedAt: new Date().toISOString(),
        });
        completed += 1;
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const terminal = runningState.attempts >= runningState.maxAttempts;
      await db.jobs.put({
        ...runningState,
        status: terminal ? 'failed' : 'pending',
        lastError: msg,
        updatedAt: new Date().toISOString(),
      });
      if (terminal) failed += 1;
    }
  }

  return { processed, completed, cancelled, failed };
}
