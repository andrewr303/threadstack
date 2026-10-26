import { z } from 'zod';
import {
  getDisplayTitle,
  STARTER_AREAS,
  type ConversationRecord,
  type ExtensionSummaryOutput,
  type SettingsRecord,
  type StructuredSummaryRecord,
} from './schema.js';
import {
  applySummaryEnrichment,
  ensureStarterCollectionsAndSettings,
  type ThreadkeeperDB,
} from './db.js';
import {
  StructuredSummaryOutputSchema,
  DEEPSEEK_MODEL_ID,
} from '../../shared/cloud.js';

const ExtractedItemZodSchema = z.object({
  text: z.string().min(1),
  messageIndexes: z.array(z.number().int().nonnegative()).min(1),
  evidenceQuote: z.string().min(1),
  provenance: z.enum(['explicit', 'inferred']).optional(),
  speaker: z.enum(['user_committed', 'assistant_suggested']),
});

export const ExtensionSummaryOutputZodSchema = z.object({
  whereYouLeftOff: z.string().min(1),
  whereYouLeftOffMessageIndexes: z.array(z.number().int().nonnegative()).min(1),
  currentStatus: z.string().min(1),
  currentStatusMessageIndexes: z.array(z.number().int().nonnegative()).min(1),
  decisions: z.array(ExtractedItemZodSchema),
  openQuestions: z.array(ExtractedItemZodSchema),
  actionItems: z.array(ExtractedItemZodSchema),
  constraints: z.array(ExtractedItemZodSchema),
  entities: z.array(z.string()),
  artifactReferences: z.array(z.string()),
  suggestedProject: z.string().nullable(),
  suggestedTags: z.array(z.string()),
  confidence: z.number().min(0).max(1),
});

export interface CloudEligibilityResult {
  allowed: boolean;
  reason?: string;
}

export function currentUtcDateKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function checkCloudEligibility(
  db: ThreadkeeperDB,
  conv: ConversationRecord,
  settings?: SettingsRecord
): Promise<CloudEligibilityResult> {
  const s = settings ?? (await ensureStarterCollectionsAndSettings(db));
  if (!s.cloudEnabled) {
    return { allowed: false, reason: 'Cloud enrichment is disabled (local-only mode)' };
  }
  if (!s.workerEndpointUrl.trim() || !s.workerBearerToken.trim()) {
    return { allowed: false, reason: 'Worker endpoint or bearer token not configured' };
  }
  if (conv.cloudExcluded) {
    return { allowed: false, reason: 'Thread is marked local-only (cloudExcluded)' };
  }
  if (s.cloudExcludedProviders.includes(conv.provider)) {
    return {
      allowed: false,
      reason: `Provider ${conv.provider} is excluded from cloud calls`,
    };
  }
  const collection = await db.collections.get(conv.project);
  if (collection?.cloudExcluded) {
    return {
      allowed: false,
      reason: `Project "${conv.project}" is excluded from cloud calls`,
    };
  }
  if (conv.coverage === 'title_only' || conv.coverage === 'metadata_only') {
    return {
      allowed: false,
      reason: `Cannot summarize ${conv.coverage} conversation without message text`,
    };
  }
  if (s.dailyCloudRequestBudget <= 0) {
    return {
      allowed: false,
      reason: 'Daily cloud request budget is 0',
    };
  }
  const today = currentUtcDateKey();
  const usedToday = s.dailyCloudBudgetDate === today ? s.dailyCloudRequestsUsed : 0;
  if (usedToday >= s.dailyCloudRequestBudget) {
    return {
      allowed: false,
      reason: `Daily cloud request budget exhausted (${usedToday}/${s.dailyCloudRequestBudget})`,
    };
  }
  return { allowed: true };
}

async function reserveClientBudgetSlot(
  db: ThreadkeeperDB,
  fallbackSettings: SettingsRecord
): Promise<
  | { allowed: true; settings: SettingsRecord }
  | { allowed: false; reason: string; settings: SettingsRecord }
> {
  return db.transaction('rw', db.settings, async () => {
    const live = (await db.settings.get('default')) ?? fallbackSettings;
    if (!live.cloudEnabled) {
      return { allowed: false, reason: 'Cloud mode is disabled', settings: live };
    }
    if (!live.workerEndpointUrl.trim() || !live.workerBearerToken.trim()) {
      return {
        allowed: false,
        reason: 'Worker endpoint or bearer token not configured',
        settings: live,
      };
    }
    if (live.dailyCloudRequestBudget <= 0) {
      return {
        allowed: false,
        reason: 'Daily cloud request budget is 0',
        settings: live,
      };
    }
    const today = currentUtcDateKey();
    const usedToday =
      live.dailyCloudBudgetDate === today ? live.dailyCloudRequestsUsed : 0;
    if (usedToday >= live.dailyCloudRequestBudget) {
      return {
        allowed: false,
        reason: `Daily cloud request budget exhausted (${usedToday}/${live.dailyCloudRequestBudget})`,
        settings: live,
      };
    }
    const updated: SettingsRecord = {
      ...live,
      dailyCloudBudgetDate: today,
      dailyCloudRequestsUsed: usedToday + 1,
    };
    await db.settings.put(updated);
    return { allowed: true, settings: updated };
  });
}

async function refundClientBudgetSlot(
  db: ThreadkeeperDB,
  fallbackSettings: SettingsRecord
): Promise<void> {
  await db.transaction('rw', db.settings, async () => {
    const live = (await db.settings.get('default')) ?? fallbackSettings;
    if (
      fallbackSettings.dailyCloudBudgetDate &&
      live.dailyCloudBudgetDate !== fallbackSettings.dailyCloudBudgetDate
    ) {
      return;
    }
    const updated: SettingsRecord = {
      ...live,
      dailyCloudRequestsUsed: Math.max(0, live.dailyCloudRequestsUsed - 1),
    };
    await db.settings.put(updated);
  });
}

export async function requestThreadEnrichment(
  db: ThreadkeeperDB,
  threadKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<{
  status: 'cached' | 'enriched' | 'rejected';
  reason?: string;
  summary?: StructuredSummaryRecord;
}> {
  const conv = await db.conversations.get(threadKey);
  if (!conv) {
    return { status: 'rejected', reason: 'Thread not found' };
  }

  const existingSummary = await db.summaries.get(threadKey);
  if (
    existingSummary &&
    existingSummary.sourceRevision === conv.sourceRevision &&
    existingSummary.contentHash === conv.contentHash
  ) {
    return { status: 'cached', summary: existingSummary };
  }

  const settings = await ensureStarterCollectionsAndSettings(db);
  const eligibility = await checkCloudEligibility(db, conv, settings);
  if (!eligibility.allowed) {
    return { status: 'rejected', reason: eligibility.reason };
  }

  const messages = await db.messages
    .where('threadKey')
    .equals(threadKey)
    .sortBy('ordinal');

  if (messages.length === 0) {
    return { status: 'rejected', reason: 'No captured messages available' };
  }

  const encoder = new TextEncoder();
  const maxMessageBytesBudget = 200_000;
  let runningBytes = 0;
  const recentCandidateMessages = messages.slice(-200);
  const selectedMessages: typeof messages = [];
  for (let i = recentCandidateMessages.length - 1; i >= 0; i--) {
    const m = recentCandidateMessages[i];
    const trimmedContent = m.content.trim().slice(0, 32000) || '[non-text turn]';
    const candidateWireMsg = {
      ordinal: i + 1,
      messageId: (m.sourceMessageId?.trim() || `msg_${m.ordinal + 1}`).slice(0, 200),
      role: m.role,
      content: trimmedContent,
      timestamp: m.createdAt,
    };
    const msgBytes = encoder.encode(JSON.stringify(candidateWireMsg)).byteLength;
    if (selectedMessages.length > 0 && runningBytes + msgBytes > maxMessageBytesBudget) {
      break;
    }
    runningBytes += msgBytes;
    selectedMessages.unshift(m);
  }

  const anyMessageTruncated = selectedMessages.some((m) => m.content.trim().length > 32000);

  const wireMessages = selectedMessages.map((m, idx) => ({
    wireOrdinal: idx + 1,
    dbOrdinal: m.ordinal,
    messageId: (m.sourceMessageId?.trim() || `msg_${m.ordinal + 1}`).slice(0, 200),
    role: m.role,
    content: m.content.trim().slice(0, 32000) || '[non-text turn]',
    timestamp: m.createdAt,
  }));

  const wireCoverage =
    conv.coverage === 'full' &&
    wireMessages.length === messages.length &&
    !anyMessageTruncated
      ? 'full'
      : 'partial';

  const wireOriginalTitle = (getDisplayTitle(conv).trim() || 'Untitled Conversation').slice(0, 300);
  const wireEstablishedTags = Array.from(
    new Set(
      conv.tags
        .map((t) => t.trim().slice(0, 60))
        .filter((t) => t.length >= 1)
    )
  ).slice(0, 100);

  const reservation = await reserveClientBudgetSlot(db, settings);
  if (!reservation.allowed) {
    return { status: 'rejected', reason: reservation.reason };
  }
  const reservedSettings = reservation.settings;

  const endpoint = `${settings.workerEndpointUrl.replace(/\/+$/, '')}/v1/enrich-thread`;
  let response: Response;
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.workerBearerToken}`,
      },
      body: JSON.stringify({
        threadKey: conv.threadKey,
        originalTitle: wireOriginalTitle,
        coverage: wireCoverage,
        sourceRevision: String(conv.sourceRevision),
        candidateProjects: [...STARTER_AREAS],
        establishedTags: wireEstablishedTags,
        messages: wireMessages.map((wm) => ({
          ordinal: wm.wireOrdinal,
          messageId: wm.messageId,
          role: wm.role,
          content: wm.content,
          timestamp: wm.timestamp,
        })),
      }),
    });
  } catch (err) {
    await refundClientBudgetSlot(db, reservedSettings);
    return {
      status: 'rejected',
      reason: `Network failure: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    await refundClientBudgetSlot(db, reservedSettings);
    let errText = `Worker HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) errText = body.error;
    } catch {
      // ignore json parse failure
    }
    return { status: 'rejected', reason: errText };
  }

  let payload: { summary?: unknown; model?: string };
  try {
    payload = (await response.json()) as { summary?: unknown; model?: string };
  } catch {
    return { status: 'rejected', reason: 'Malformed JSON from Worker' };
  }

  const workerParse = StructuredSummaryOutputSchema.safeParse(payload.summary);
  if (!workerParse.success) {
    return {
      status: 'rejected',
      reason: `Schema validation failed: ${workerParse.error.message}`,
    };
  }
  const w = workerParse.data;
  const byMessageId = new Map(wireMessages.map((wm) => [wm.messageId, wm]));

  const verifyAndResolveAnchor = (
    label: string,
    anchor: typeof w.overviewAnchor
  ): { valid: true; dbOrdinal: number } | { valid: false; reason: string } => {
    if (anchor.sourceRevision !== String(conv.sourceRevision)) {
      return {
        valid: false,
        reason: `${label} sourceRevision mismatch (${anchor.sourceRevision} !== ${conv.sourceRevision})`,
      };
    }
    const matched = byMessageId.get(anchor.messageId);
    const ordinalMatches =
      matched !== undefined && anchor.messageOrdinal === matched.wireOrdinal;
    if (!matched || !ordinalMatches) {
      return {
        valid: false,
        reason: `${label} messageId/ordinal mismatch (${anchor.messageId} @ ${anchor.messageOrdinal})`,
      };
    }
    const normalizedMsg = matched.content.replace(/\s+/g, ' ').trim().toLowerCase();
    const normalizedQuote = anchor.quote.replace(/\s+/g, ' ').trim().toLowerCase();
    if (normalizedQuote.length < 12 || !normalizedMsg.includes(normalizedQuote)) {
      return {
        valid: false,
        reason: `${label} quote is not grounded in message ${matched.messageId}`,
      };
    }
    return { valid: true, dbOrdinal: matched.dbOrdinal };
  };

  const overviewCheck = verifyAndResolveAnchor('overviewAnchor', w.overviewAnchor);
  if (!overviewCheck.valid) {
    return { status: 'rejected', reason: overviewCheck.reason };
  }
  const whereLeftOffCheck = verifyAndResolveAnchor('whereLeftOffAnchor', w.whereLeftOffAnchor);
  if (!whereLeftOffCheck.valid) {
    return { status: 'rejected', reason: whereLeftOffCheck.reason };
  }

  const claimDbOrdinals = new Map<string, number>();
  for (const c of w.claims) {
    const claimCheck = verifyAndResolveAnchor(`Claim "${c.id}" anchor`, c.anchor);
    if (!claimCheck.valid) {
      return {
        status: 'rejected',
        reason: claimCheck.reason,
      };
    }
    claimDbOrdinals.set(c.id, claimCheck.dbOrdinal);
  }

  const toItem = (c: (typeof w.claims)[number]) => ({
    text: c.text,
    messageIndexes: [claimDbOrdinals.get(c.id) ?? Math.max(0, c.anchor.messageOrdinal - 1)],
    evidenceQuote: c.anchor.quote,
    provenance: c.anchor.provenance,
    speaker: c.anchor.commitment,
  });

  const normalizedSummary: ExtensionSummaryOutput = {
    whereYouLeftOff: w.whereLeftOff,
    whereYouLeftOffMessageIndexes: [whereLeftOffCheck.dbOrdinal],
    currentStatus: w.oneSentenceOverview,
    currentStatusMessageIndexes: [overviewCheck.dbOrdinal],
    decisions: w.claims.filter((c) => c.kind === 'decision').map(toItem),
    openQuestions: w.claims.filter((c) => c.kind === 'question').map(toItem),
    actionItems: w.claims.filter((c) => c.kind === 'action').map(toItem),
    constraints: w.claims.filter((c) => c.kind === 'constraint').map(toItem),
    entities: [],
    artifactReferences: w.importantOutputs.map((o) => o.label),
    suggestedProject: w.suggestedProjectName,
    suggestedTags: w.suggestedTags,
    confidence: w.confidence,
  };

  const applied = await applySummaryEnrichment(db, {
    threadKey: conv.threadKey,
    sourceRevision: conv.sourceRevision,
    contentHash: conv.contentHash,
    model: payload.model ?? DEEPSEEK_MODEL_ID,
    summary: normalizedSummary,
  });

  if (!applied.applied) {
    return { status: 'rejected', reason: applied.reason };
  }

  return { status: 'enriched', summary: applied.summaryRecord };
}

export async function requestQueryEmbedding(
  db: ThreadkeeperDB,
  query: string,
  fetchImpl: typeof fetch = fetch
): Promise<{
  status: 'ok' | 'rejected';
  reason?: string;
  embedding?: number[];
  space?: {
    indexType: 'standard' | 'contextual';
    model: string;
    dimensions: 256 | 512 | 1024 | 2048;
  };
}> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  const reservation = await reserveClientBudgetSlot(db, settings);
  if (!reservation.allowed) {
    return { status: 'rejected', reason: reservation.reason };
  }
  const reserved = reservation.settings;
  const baseUrl = settings.workerEndpointUrl.replace(/\/+$/, '');
  const isContextual =
    settings.embeddingIndexType === 'contextual' &&
    settings.embeddingModel === 'voyage-context-4';
  const endpoint = isContextual
    ? `${baseUrl}/v1/embeddings/contextual`
    : `${baseUrl}/v1/embeddings/standard`;

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.workerBearerToken}`,
      },
      body: JSON.stringify(
        isContextual
          ? {
              inputs: [[query]],
              model: 'voyage-context-4',
              inputType: 'query',
              outputDimension: settings.embeddingDimensions,
            }
          : {
              input: [query],
              model:
                settings.embeddingModel === 'voyage-4-large'
                  ? 'voyage-4-large'
                  : 'voyage-4',
              inputType: 'query',
              outputDimension: settings.embeddingDimensions,
            }
      ),
    });
    if (!res.ok) {
      await refundClientBudgetSlot(db, reserved);
      return { status: 'rejected', reason: `Worker HTTP ${res.status}` };
    }
    if (isContextual) {
      const data = (await res.json()) as {
        documents?: Array<{ chunks: Array<{ embedding: number[] }> }>;
        model?: string;
        dimensions?: 256 | 512 | 1024 | 2048;
      };
      const vec = data.documents?.[0]?.chunks?.[0]?.embedding;
      if (!vec) {
        return { status: 'rejected', reason: 'Empty contextual query vector' };
      }
      return {
        status: 'ok',
        embedding: vec,
        space: {
          indexType: 'contextual',
          model: data.model ?? 'voyage-context-4',
          dimensions: data.dimensions ?? settings.embeddingDimensions,
        },
      };
    }
    const data = (await res.json()) as {
      embeddings?: number[][];
      model?: string;
      dimensions?: 256 | 512 | 1024 | 2048;
    };
    const vec = data.embeddings?.[0];
    if (!vec) {
      return { status: 'rejected', reason: 'Empty standard query vector' };
    }
    return {
      status: 'ok',
      embedding: vec,
      space: {
        indexType: 'standard',
        model: data.model ?? settings.embeddingModel,
        dimensions: data.dimensions ?? settings.embeddingDimensions,
      },
    };
  } catch (err) {
    await refundClientBudgetSlot(db, reserved);
    return {
      status: 'rejected',
      reason: `Network failure: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function requestCandidateRerank(
  db: ThreadkeeperDB,
  query: string,
  documents: string[],
  topK = 20,
  fetchImpl: typeof fetch = fetch
): Promise<{
  status: 'ok' | 'rejected';
  reason?: string;
  results?: Array<{ index: number; relevanceScore: number }>;
}> {
  if (documents.length === 0) {
    return { status: 'ok', results: [] };
  }
  const settings = await ensureStarterCollectionsAndSettings(db);
  const reservation = await reserveClientBudgetSlot(db, settings);
  if (!reservation.allowed) {
    return { status: 'rejected', reason: reservation.reason };
  }
  const reserved = reservation.settings;
  const endpoint = `${settings.workerEndpointUrl.replace(/\/+$/, '')}/v1/rerank`;

  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.workerBearerToken}`,
      },
      body: JSON.stringify({
        query,
        documents,
        model: settings.rerankModel,
        topK: Math.min(topK, documents.length),
      }),
    });
    if (!res.ok) {
      await refundClientBudgetSlot(db, reserved);
      return { status: 'rejected', reason: `Worker HTTP ${res.status}` };
    }
    const data = (await res.json()) as {
      results?: Array<{ index: number; relevanceScore: number }>;
    };
    return { status: 'ok', results: data.results ?? [] };
  } catch (err) {
    await refundClientBudgetSlot(db, reserved);
    return {
      status: 'rejected',
      reason: `Network failure: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

