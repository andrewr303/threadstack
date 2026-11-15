// Small pure helpers shared by the Dashboard's bar and panes.
import type { ConversationRecord } from '../../../core/schema.js';
import {
  applyLensFilters,
  groupLens,
  selfConversation,
  sortLens,
  type AccountIdOf,
  type LensFilters,
  type LensGroup,
  type LensGroupBy,
  type LensSort,
} from '../workspace/lens.js';
import { embedTargetFor } from '../workspace/state.js';

export function sessionTitle(conv: ConversationRecord): string {
  return conv.manualTitleOverride || conv.title || 'Untitled session';
}

/** Whether a session has a web page the workspace can embed. */
export function hasWebPage(conv: ConversationRecord): boolean {
  return embedTargetFor(conv.canonicalUrl) !== null;
}

/** Pinned sessions, most recently updated first. Archived and synthetic benchmark threads never show. */
export function pinnedSessions(conversations: readonly ConversationRecord[]): ConversationRecord[] {
  const stamp = (c: ConversationRecord) => Date.parse(c.updatedAt ?? c.lastCapturedAt) || 0;
  return conversations
    .filter((c) => c.pinned && c.workflowState !== 'archived' && !c.isSyntheticBenchmark)
    .sort((a, b) => stamp(b) - stamp(a));
}

export interface PinnedLens {
  filters: LensFilters;
  sortBy: LensSort;
  groupBy: LensGroupBy;
}

/**
 * The pinned sessions the bar offers: narrowed by the filters, ordered, and split into clusters
 * (one cluster when not grouped). Sessions already placed in a pane are not dropped here; the
 * view keeps those in their pane whatever the filters say.
 */
export function organizePinned(
  pinned: readonly ConversationRecord[],
  lens: PinnedLens,
  context: { accountIdOf?: AccountIdOf; accountOrder?: readonly string[]; now?: number } = {}
): { visible: ConversationRecord[]; groups: LensGroup<ConversationRecord>[] } {
  const filtered = applyLensFilters(pinned, lens.filters, selfConversation, context.accountIdOf);
  const visible = sortLens(filtered, lens.sortBy, selfConversation);
  const groups = groupLens(visible, lens.groupBy, selfConversation, context);
  return { visible, groups };
}
