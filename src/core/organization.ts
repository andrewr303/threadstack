import {
  getDisplayTitle,
  type ConversationRecord,
  type StructuredSummaryRecord,
  type ResurfaceQueue,
  type ChangeLogEntry,
  type WorkflowState,
} from './schema.js';
import type { ThreadkeeperDB } from './db.js';

const TAG_SYNONYM_MAP: Record<string, string> = {
  'brand-id': 'branding',
  'brand-identity': 'branding',
  'logo-design': 'logo',
  'wordmark-design': 'logo',
  'next.js': 'nextjs',
  'react.js': 'react',
  'postgres-schema': 'schema',
  'db-schema': 'schema',
  'ui-polish': 'design-system',
};

export function normalizeTag(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9./-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return TAG_SYNONYM_MAP[cleaned] ?? cleaned;
}

export function normalizeTags(tags: string[]): string[] {
  const set = new Set<string>();
  for (const t of tags) {
    const norm = normalizeTag(t);
    if (norm.length > 0) set.add(norm);
  }
  return Array.from(set);
}

export interface ResurfacedThreadItem {
  conversation: ConversationRecord;
  queue: ResurfaceQueue;
  resurfaceReason: string;
  evidenceMessageOrdinal: number | null;
}

export function computeResurfacingQueueItems(
  conversations: ConversationRecord[],
  summariesByThread: Map<string, StructuredSummaryRecord>,
  queue: ResurfaceQueue,
  nowIso = new Date().toISOString()
): ResurfacedThreadItem[] {
  const results: ResurfacedThreadItem[] = [];

  for (const conv of conversations) {
    if (conv.isSyntheticBenchmark) continue;
    if (conv.workflowState === 'archived' || conv.workflowState === 'done') {
      continue;
    }
    if (conv.dismissedQueues.includes(queue)) continue;
    if (conv.snoozedUntil && conv.snoozedUntil > nowIso) continue;

    const summary = summariesByThread.get(conv.threadKey);

    if (queue === 'continue_working') {
      if (conv.pinned || conv.nextStepText || (summary?.actionItems.length ?? 0) > 0) {
        const nextText =
          conv.nextStepText ?? summary?.actionItems[0]?.text ?? 'Pinned active thread';
        const ord =
          conv.nextStepMsgIndex ??
          summary?.actionItems[0]?.messageIndexes[0] ??
          0;
        results.push({
          conversation: conv,
          queue,
          resurfaceReason: `Next step: ${nextText}`,
          evidenceMessageOrdinal: ord,
        });
      }
    } else if (queue === 'needs_review') {
      const openQ = summary?.openQuestions ?? [];
      if (conv.workflowState === 'needs_review' || openQ.length > 0) {
        results.push({
          conversation: conv,
          queue,
          resurfaceReason:
            openQ.length > 0
              ? `Open question: ${openQ[0].text}`
              : 'Marked as Needs review',
          evidenceMessageOrdinal: openQ[0]?.messageIndexes[0] ?? 0,
        });
      }
    } else if (queue === 'waiting') {
      if (conv.workflowState === 'waiting') {
        results.push({
          conversation: conv,
          queue,
          resurfaceReason:
            summary?.currentStatus ?? 'Waiting on external dependency or review',
          evidenceMessageOrdinal:
            summary?.currentStatusMessageIndexes[0] ?? 0,
        });
      }
    } else if (queue === 'recently_changed') {
      if (conv.sourceRevision > 1 || conv.updatedAt) {
        results.push({
          conversation: conv,
          queue,
          resurfaceReason: `Updated at revision r${conv.sourceRevision} (${conv.coverage} coverage)`,
          evidenceMessageOrdinal: Math.max(0, conv.messageCount - 1),
        });
      }
    } else if (queue === 'unfiled') {
      if (conv.project === 'Unfiled / Uncertain') {
        results.push({
          conversation: conv,
          queue,
          resurfaceReason: 'Captured in Unfiled / Uncertain without assigned project',
          evidenceMessageOrdinal: 0,
        });
      }
    } else if (queue === 'worth_revisiting') {
      if (
        conv.siblingBranchIds.length > 0 ||
        (summary?.decisions.length ?? 0) > 0 ||
        conv.latestDecisionText
      ) {
        const reason =
          conv.siblingBranchIds.length > 0
            ? `Has ${conv.siblingBranchIds.length} sibling branch(es) (${conv.siblingBranchIds.join(', ')})`
            : `Committed decision: ${conv.latestDecisionText ?? summary?.decisions[0]?.text}`;
        results.push({
          conversation: conv,
          queue,
          resurfaceReason: reason,
          evidenceMessageOrdinal:
            conv.latestDecisionMsgIndex ??
            summary?.decisions[0]?.messageIndexes[0] ??
            0,
        });
      }
    }
  }

  return results;
}

export interface OrganizeProposalItem {
  threadKey: string;
  title: string;
  currentProject: string;
  proposedProject: string | null;
  currentTags: string[];
  proposedTags: string[];
  proposedState: WorkflowState | null;
  categoryLocked: boolean;
  excludedByInstruction: boolean;
  reason: string;
  confidence: number;
}

function inferProjectFromKeywords(text: string): string | null {
  const lower = text.toLowerCase();
  if (lower.includes('daydock') || lower.includes('meridian')) {
    return 'Daydock / Meridian';
  }
  if (lower.includes('hypestake') || lower.includes('odds') || lower.includes('sportsbook')) {
    return 'HypeStake';
  }
  if (lower.includes('velotic') || lower.includes('frameconcepts') || lower.includes('shader')) {
    return 'Velotic / FrameConcepts';
  }
  if (lower.includes('personal') || lower.includes('vacation') || lower.includes('tax')) {
    return 'Personal';
  }
  if (lower.includes('research') || lower.includes('benchmark')) {
    return 'General research';
  }
  return null;
}

export function previewNaturalLanguageOrganize(
  instruction: string,
  conversations: ConversationRecord[]
): OrganizeProposalItem[] {
  const raw = instruction.trim();
  if (!raw) return [];

  // Parse "..., but keep <exclusion> separate" or "except <exclusion>"
  const splitMatch = raw.match(
    /^(.*?)(?:,\s*|\s+)(?:but\s+keep\s+|except\s+|excluding\s+)(.*?)(?:\s+separate|\s+untouched|\s+alone)?$/i
  );

  const includeClause = (splitMatch ? splitMatch[1] : raw).toLowerCase();
  const excludeClause = (splitMatch ? splitMatch[2] : '').toLowerCase();

  const stopWords = new Set([
    'group',
    'move',
    'file',
    'organize',
    'tag',
    'my',
    'all',
    'the',
    'conversations',
    'threads',
    'chats',
    'into',
    'under',
    'with',
    'and',
    'for',
  ]);

  const includeKeywords = includeClause
    .replace(/[^a-z0-9\s/-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  const excludeKeywords = excludeClause
    .replace(/[^a-z0-9\s/-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 3 && !stopWords.has(w));

  const targetProject = inferProjectFromKeywords(includeClause);
  const derivedTags = normalizeTags(
    includeKeywords.filter(
      (k) =>
        !['daydock', 'meridian', 'hypestake', 'velotic', 'frameconcepts'].includes(
          k
        )
    )
  );

  const proposals: OrganizeProposalItem[] = [];

  for (const conv of conversations) {
    if (conv.isSyntheticBenchmark) continue;
    const haystack = `${getDisplayTitle(conv)} ${conv.tags.join(' ')} ${conv.manualNotes} ${conv.latestDecisionText ?? ''}`.toLowerCase();

    const matchesInclude =
      includeKeywords.length > 0 &&
      includeKeywords.every((kw) => haystack.includes(kw));
    const matchesPartialInclude =
      includeKeywords.length > 0 &&
      includeKeywords.some((kw) => haystack.includes(kw));
    const matchesExclude =
      excludeKeywords.length > 0 &&
      excludeKeywords.some((kw) => haystack.includes(kw));

    if (matchesPartialInclude && matchesExclude) {
      proposals.push({
        threadKey: conv.threadKey,
        title: getDisplayTitle(conv),
        currentProject: conv.project,
        proposedProject: null,
        currentTags: conv.tags,
        proposedTags: conv.tags,
        proposedState: null,
        categoryLocked: conv.categoryLocked,
        excludedByInstruction: true,
        reason: `Kept separate per exclusion clause ("${excludeKeywords.join(' ')}")`,
        confidence: 0.96,
      });
      continue;
    }

    if (!matchesInclude) continue;

    if (conv.categoryLocked) {
      proposals.push({
        threadKey: conv.threadKey,
        title: getDisplayTitle(conv),
        currentProject: conv.project,
        proposedProject: null,
        currentTags: conv.tags,
        proposedTags: Array.from(new Set([...conv.tags, ...derivedTags])),
        proposedState: null,
        categoryLocked: true,
        excludedByInstruction: false,
        reason: `Matched "${includeKeywords.join(' ')}", but project "${conv.project}" is manually locked; only tags proposed`,
        confidence: 0.92,
      });
      continue;
    }

    proposals.push({
      threadKey: conv.threadKey,
      title: getDisplayTitle(conv),
      currentProject: conv.project,
      proposedProject: targetProject ?? conv.project,
      currentTags: conv.tags,
      proposedTags: Array.from(new Set([...conv.tags, ...derivedTags])),
      proposedState: null,
      categoryLocked: false,
      excludedByInstruction: false,
      reason: `Matched "${includeKeywords.join(' ')}" → file under ${targetProject ?? conv.project}`,
      confidence: 0.91,
    });
  }

  return proposals;
}

export async function applyOrganizeProposals(
  db: ThreadkeeperDB,
  description: string,
  proposals: OrganizeProposalItem[]
): Promise<ChangeLogEntry> {
  const actionable = proposals.filter((p) => !p.excludedByInstruction);
  const snapshots: ChangeLogEntry['snapshots'] = [];

  await db.transaction('rw', [db.conversations, db.changeLogs], async () => {
    for (const item of actionable) {
      const existing = await db.conversations.get(item.threadKey);
      if (!existing) continue;

      snapshots.push({
        threadKey: existing.threadKey,
        previousProject: existing.project,
        previousCategoryLocked: existing.categoryLocked,
        previousTags: [...existing.tags],
        previousManualTags: [...existing.manualTags],
        previousWorkflowState: existing.workflowState,
        previousManualTitleOverride: existing.manualTitleOverride,
      });

      const nextProject =
        existing.categoryLocked || !item.proposedProject
          ? existing.project
          : item.proposedProject;

      const nextTags = normalizeTags([
        ...existing.tags,
        ...existing.manualTags,
        ...item.proposedTags,
      ]);

      await db.conversations.put({
        ...existing,
        project: nextProject,
        tags: nextTags,
        workflowState: item.proposedState ?? existing.workflowState,
      });
    }
  });

  const entry: ChangeLogEntry = {
    changeId: `chg_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
    createdAt: new Date().toISOString(),
    description,
    undone: false,
    snapshots,
  };
  await db.changeLogs.put(entry);
  return entry;
}

export async function undoChangeLog(
  db: ThreadkeeperDB,
  changeId: string
): Promise<{ restoredCount: number }> {
  const entry = await db.changeLogs.get(changeId);
  if (!entry || entry.undone) {
    return { restoredCount: 0 };
  }

  let restoredCount = 0;
  await db.transaction('rw', [db.conversations, db.changeLogs], async () => {
    for (const snap of entry.snapshots) {
      const existing = await db.conversations.get(snap.threadKey);
      if (!existing) continue;
      await db.conversations.put({
        ...existing,
        project: snap.previousProject,
        categoryLocked: snap.previousCategoryLocked,
        tags: snap.previousTags,
        manualTags: snap.previousManualTags,
        workflowState: snap.previousWorkflowState,
        manualTitleOverride: snap.previousManualTitleOverride,
      });
      restoredCount += 1;
    }
    await db.changeLogs.put({
      ...entry,
      undone: true,
    });
  });

  return { restoredCount };
}
