// The "lens": one model of filter + sort + group that the side navigation, the Threads list and
// the Dashboard's pinned bar all use, so a person can manage hundreds of sessions the same way
// everywhere. Pure functions only: no React, no chrome APIs. The three surfaces differ in what
// they offer (see SURFACE_GROUP_BY), never in what a choice means.
import { providerLabel, type ProviderId } from '../../../core/providers.js';
import { threadRepository } from '../../../core/repository.js';
import {
  LENS_GROUP_BY,
  LENS_SORT,
  getDisplayTitle,
  type ConversationRecord,
  type LensGroupBy,
  type LensSort,
  type WorkflowState,
} from '../../../core/schema.js';
import { SESSION_GROUP_ORDER, sessionGroupOf, type SessionGroup } from './state.js';

export { LENS_SORT };
export type { LensGroupBy, LensSort };

// ---------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------

/** What kind of session it is. The same four groups the side navigation has always had. */
export type SessionKind = SessionGroup;

export const SESSION_KINDS: readonly SessionKind[] = SESSION_GROUP_ORDER;

/** Names used in filter menus and the Threads list. The side navigation keeps SESSION_GROUP_LABELS. */
export const SESSION_KIND_LABELS: Record<SessionKind, string> = {
  coding: 'Coding sessions',
  chats: 'Chats',
  bots: 'Bots',
  more: 'Other',
};

export const LENS_GROUP_BY_LABELS: Record<LensGroupBy, string> = {
  kind: 'Type',
  provider: 'Provider',
  account: 'Account',
  date: 'Last active',
  repository: 'Repository',
  project: 'Project',
  status: 'Status',
  none: 'None',
};

export const LENS_SORT_LABELS: Record<LensSort, string> = {
  recent: 'Recent activity',
  oldest: 'Oldest first',
  created: 'Recently created',
  title: 'Title A–Z',
  messages: 'Most messages',
};

export const WORKFLOW_ORDER: readonly WorkflowState[] = ['active', 'needs_review', 'waiting', 'paused', 'done', 'archived'];

export const WORKFLOW_LABELS: Record<WorkflowState, string> = {
  active: 'Active',
  needs_review: 'Needs review',
  waiting: 'Waiting',
  paused: 'Paused',
  done: 'Done',
  archived: 'Archived',
};

export type DateBucket = 'today' | 'yesterday' | 'week' | 'month' | 'older';

export const DATE_BUCKETS: readonly DateBucket[] = ['today', 'yesterday', 'week', 'month', 'older'];

export const DATE_BUCKET_LABELS: Record<DateBucket, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'Previous 7 days',
  month: 'Previous 30 days',
  older: 'Older',
};

// ---------------------------------------------------------------------------------------------
// What each surface offers
// ---------------------------------------------------------------------------------------------

export type LensSurface = 'sidebar' | 'threads' | 'dashboard';

/** The one table of grouping choices per surface. The first entry the surface lists first is not
 *  its default: see SURFACE_DEFAULT_GROUP_BY. */
export const SURFACE_GROUP_BY: Record<LensSurface, readonly LensGroupBy[]> = {
  sidebar: ['kind', 'provider', 'account', 'date', 'repository', 'none'],
  threads: ['none', 'project', 'repository', 'account', 'kind', 'provider', 'date', 'status'],
  dashboard: ['none', 'kind', 'provider', 'account'],
};

export const SURFACE_DEFAULT_GROUP_BY: Record<LensSurface, LensGroupBy> = {
  sidebar: 'kind',
  threads: 'none',
  dashboard: 'none',
};

export const DEFAULT_LENS_SORT: LensSort = 'recent';

/** Facts about the library that decide which grouping choices are worth showing. */
export interface LensFacts {
  /** Some sign-in has more than one account. */
  multiAccount: boolean;
  /** How many different kinds / providers the sessions in the list have, when known. */
  kindCount?: number;
  providerCount?: number;
}

/**
 * The grouping choices to offer on a surface. "Account" is hidden when no sign-in has more than
 * one account, and Type or Provider when every session has the same one (a single bucket tells
 * a person nothing). "None" and the choice currently in force always stay.
 */
export function availableGroupBy(surface: LensSurface, facts: LensFacts, current?: LensGroupBy): LensGroupBy[] {
  return SURFACE_GROUP_BY[surface].filter((value) => {
    if (value === current || value === 'none') return true;
    if (value === 'account') return facts.multiAccount;
    if (value === 'kind') return facts.kindCount === undefined || facts.kindCount > 1;
    if (value === 'provider') return facts.providerCount === undefined || facts.providerCount > 1;
    return true;
  });
}

// ---------------------------------------------------------------------------------------------
// Persisted values
// ---------------------------------------------------------------------------------------------

/** A stored grouping this surface does not offer (or a value from another version) becomes its default. */
export function sanitizeGroupBy(surface: LensSurface, value: unknown): LensGroupBy {
  return (LENS_GROUP_BY as readonly unknown[]).includes(value) && SURFACE_GROUP_BY[surface].includes(value as LensGroupBy)
    ? (value as LensGroupBy)
    : SURFACE_DEFAULT_GROUP_BY[surface];
}

export function sanitizeSort(value: unknown): LensSort {
  return (LENS_SORT as readonly unknown[]).includes(value) ? (value as LensSort) : DEFAULT_LENS_SORT;
}

/**
 * Collapsed groups are stored by group id. Before the lens, the side navigation stored the bare
 * kind (`coding`); that is the same group as `kind:coding`.
 */
export function legacyGroupId(id: string): string | null {
  return id.startsWith('kind:') && id.length > 5 ? id.slice(5) : null;
}

export function isGroupCollapsed(collapsed: readonly string[], id: string): boolean {
  if (collapsed.includes(id)) return true;
  const legacy = legacyGroupId(id);
  return legacy !== null && collapsed.includes(legacy);
}

/**
 * The id to hand to a toggle so the group flips: the stored spelling when there is one, so an
 * old entry is removed instead of shadowed by a new one.
 */
export function collapseToggleId(collapsed: readonly string[], id: string): string {
  const legacy = legacyGroupId(id);
  return legacy !== null && !collapsed.includes(id) && collapsed.includes(legacy) ? legacy : id;
}

// ---------------------------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------------------------

/** An empty list means "no restriction on this dimension". OR inside a dimension, AND across. */
export interface LensFilters {
  kinds: SessionKind[];
  providers: ProviderId[];
  accounts: string[];
}

export const EMPTY_LENS_FILTERS: LensFilters = { kinds: [], providers: [], accounts: [] };

/** How many values are selected across the dimensions. */
export function lensFilterCount(filters: LensFilters): number {
  return filters.kinds.length + filters.providers.length + filters.accounts.length;
}

export function isLensFiltered(filters: LensFilters): boolean {
  return lensFilterCount(filters) > 0;
}

/** Toggle one value of one dimension, returning a new filter set. */
export function toggleLensFilter<K extends keyof LensFilters>(filters: LensFilters, dimension: K, value: LensFilters[K][number]): LensFilters {
  const list = filters[dimension] as Array<LensFilters[K][number]>;
  const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return { ...filters, [dimension]: next };
}

/** Maps a session to the id of the account it was captured under (the workspace decides). */
export type AccountIdOf = (conv: ConversationRecord) => string | null;

/** Read the conversation out of whatever a list holds (a record, a search hit). */
export type ConversationOf<T> = (item: T) => ConversationRecord;

export const selfConversation: ConversationOf<ConversationRecord> = (conv) => conv;
export const hitConversation = <T extends { conversation: ConversationRecord }>(hit: T): ConversationRecord => hit.conversation;

export function matchesLensFilters(conv: ConversationRecord, filters: LensFilters, accountIdOf?: AccountIdOf): boolean {
  if (filters.kinds.length > 0 && !filters.kinds.includes(sessionGroupOf(conv.provider))) return false;
  if (filters.providers.length > 0 && !filters.providers.includes(conv.provider)) return false;
  if (filters.accounts.length > 0 && accountIdOf) {
    const id = accountIdOf(conv);
    if (!id || !filters.accounts.includes(id)) return false;
  }
  return true;
}

export function applyLensFilters<T>(items: readonly T[], filters: LensFilters, get: ConversationOf<T>, accountIdOf?: AccountIdOf): readonly T[] {
  if (!isLensFiltered(filters)) return items;
  return items.filter((item) => matchesLensFilters(get(item), filters, accountIdOf));
}

// ---------------------------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------------------------

/** When a session was last active: `updatedAt`, else the last capture. 0 when neither parses. */
export function activityTime(conv: ConversationRecord): number {
  const stamp = Date.parse(conv.updatedAt ?? conv.lastCapturedAt ?? '');
  return Number.isFinite(stamp) ? stamp : 0;
}

/** When a session was created, falling back to its activity time. */
export function createdTime(conv: ConversationRecord): number {
  const stamp = Date.parse(conv.createdAt ?? '');
  return Number.isFinite(stamp) ? stamp : activityTime(conv);
}

const TITLE_COMPARE: Intl.CollatorOptions = { sensitivity: 'base', numeric: true };

/** Order a list. Stable: items that tie keep the order they came in. */
export function sortLens<T>(
  items: readonly T[],
  sort: LensSort,
  get: ConversationOf<T>,
  titleOf: (conv: ConversationRecord) => string = getDisplayTitle
): T[] {
  const rows = items.map((item, index) => ({ item, index, conv: get(item) }));
  let compare: (a: (typeof rows)[number], b: (typeof rows)[number]) => number;
  if (sort === 'title') {
    const titles = new Map(rows.map((row) => [row.index, titleOf(row.conv) ?? '']));
    compare = (a, b) => (titles.get(a.index) ?? '').localeCompare(titles.get(b.index) ?? '', undefined, TITLE_COMPARE);
  } else if (sort === 'oldest') {
    compare = (a, b) => activityTime(a.conv) - activityTime(b.conv);
  } else if (sort === 'created') {
    compare = (a, b) => createdTime(b.conv) - createdTime(a.conv);
  } else if (sort === 'messages') {
    compare = (a, b) => (b.conv.messageCount ?? 0) - (a.conv.messageCount ?? 0);
  } else {
    compare = (a, b) => activityTime(b.conv) - activityTime(a.conv);
  }
  // Array.prototype.sort is stable; the index makes that explicit and survives odd engines.
  return rows.sort((a, b) => compare(a, b) || a.index - b.index).map((row) => row.item);
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/** Whole local calendar days from `then` to `now` (0 = the same day). Daylight saving safe. */
function calendarDaysBetween(now: number, then: number): number {
  const a = new Date(now);
  const b = new Date(then);
  return Math.round((Date.UTC(a.getFullYear(), a.getMonth(), a.getDate()) - Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())) / 86_400_000);
}

/**
 * Which bucket a moment falls in, by local calendar day: Today, Yesterday, Previous 7 days (2 to
 * 7 days ago), Previous 30 days (8 to 30 days ago), Older. A moment in the future is Today; one
 * that cannot be read is Older.
 */
export function dateBucketOfTime(stamp: number, now: number): DateBucket {
  if (!Number.isFinite(stamp) || stamp <= 0) return 'older';
  const days = calendarDaysBetween(now, stamp);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days <= 7) return 'week';
  if (days <= 30) return 'month';
  return 'older';
}

export function dateBucketOf(conv: ConversationRecord, now: number): DateBucket {
  return dateBucketOfTime(activityTime(conv), now);
}

// ---------------------------------------------------------------------------------------------
// Grouping
// ---------------------------------------------------------------------------------------------

export interface LensGroup<T> {
  /** `<groupBy>:<key>`; the key part is empty for the "nothing to group by" group. */
  id: string;
  /** Provider id, kind, repository, account id, bucket, status or project; null when there is none. */
  key: string | null;
  sessions: T[];
}

export interface LensGroupContext {
  /** The moment "today" is measured from (date grouping). */
  now?: number;
  accountIdOf?: AccountIdOf;
  /** Account ids in the order they are shown elsewhere (sign-in order, then account order). */
  accountOrder?: readonly string[];
  /** The repository a session is filed under; defaults to the one the session itself names. */
  repositoryOf?: (conv: ConversationRecord) => string | null;
}

/** The project name a session is grouped under when it has none. */
export const UNASSIGNED_PROJECT = 'Unassigned';

const isCodingProvider = (provider: string): boolean => sessionGroupOf(provider) === 'coding';

/** The group key of one session for one grouping; null means "nothing to group by". */
export function lensKeyOf(conv: ConversationRecord, groupBy: LensGroupBy, ctx: LensGroupContext = {}): string | null {
  switch (groupBy) {
    case 'kind':
      return sessionGroupOf(conv.provider);
    case 'provider':
      return conv.provider;
    case 'account':
      return ctx.accountIdOf?.(conv) ?? null;
    case 'date':
      return dateBucketOf(conv, ctx.now ?? Date.now());
    case 'repository':
      return (ctx.repositoryOf ?? ((c: ConversationRecord) => threadRepository(c, isCodingProvider)))(conv);
    case 'project':
      return conv.project || UNASSIGNED_PROJECT;
    case 'status':
      return conv.workflowState ?? null;
    case 'none':
      return null;
  }
}

/** The name of a group that needs no outside knowledge. Accounts are named by the caller. */
export function lensGroupLabel(groupBy: LensGroupBy, key: string | null, kindLabels: Record<SessionKind, string> = SESSION_KIND_LABELS): string {
  switch (groupBy) {
    case 'kind':
      return key ? kindLabels[key as SessionKind] ?? key : 'Other';
    case 'provider':
      return key ? providerLabel(key) : 'No provider';
    case 'date':
      return key ? DATE_BUCKET_LABELS[key as DateBucket] ?? key : 'Older';
    case 'status':
      return key ? WORKFLOW_LABELS[key as WorkflowState] ?? key : 'No status';
    case 'repository':
      return key ?? 'No repository';
    case 'project':
      return key ?? UNASSIGNED_PROJECT;
    case 'account':
      return key ?? 'No account';
    case 'none':
      return 'All sessions';
  }
}

function groupRank(groupBy: LensGroupBy, key: string, ctx: LensGroupContext): number {
  const order: readonly string[] =
    groupBy === 'kind' ? SESSION_GROUP_ORDER : groupBy === 'date' ? DATE_BUCKETS : groupBy === 'status' ? WORKFLOW_ORDER : ctx.accountOrder ?? [];
  const at = order.indexOf(key);
  return at >= 0 ? at : order.length;
}

/**
 * Split items that are already filtered and sorted into ordered groups. Inside a group the
 * incoming order is kept; empty groups are not returned.
 *
 * Order: kind is coding, chats, bots, other; date is newest bucket first; status follows the
 * workflow (active ... archived); account follows `accountOrder`, then any account it does not
 * know in the order first seen; provider, repository and project are biggest group first, then
 * by name. The group of sessions with nothing to group by is always last.
 */
export function groupLens<T>(items: readonly T[], groupBy: LensGroupBy, get: ConversationOf<T>, ctx: LensGroupContext = {}): LensGroup<T>[] {
  if (groupBy === 'none') return items.length > 0 ? [{ id: 'none:', key: null, sessions: [...items] }] : [];
  const byKey = new Map<string | null, T[]>();
  const context: LensGroupContext = groupBy === 'date' ? { ...ctx, now: ctx.now ?? Date.now() } : ctx;
  for (const item of items) {
    const key = lensKeyOf(get(item), groupBy, context);
    const list = byKey.get(key);
    if (list) list.push(item);
    else byKey.set(key, [item]);
  }
  const groups: LensGroup<T>[] = [...byKey.entries()].map(([key, sessions]) => ({ id: `${groupBy}:${key ?? ''}`, key, sessions }));
  const named = (g: LensGroup<T>) => lensGroupLabel(groupBy, g.key);
  const bySize = groupBy === 'provider' || groupBy === 'repository' || groupBy === 'project';
  const ranked = groupBy === 'kind' || groupBy === 'date' || groupBy === 'status' || groupBy === 'account';
  if (bySize) {
    groups.sort((a, b) => b.sessions.length - a.sessions.length || named(a).localeCompare(named(b), undefined, TITLE_COMPARE));
  } else if (ranked) {
    // Stable: accounts the order does not name keep the order they were first seen in.
    groups.sort((a, b) => groupRank(groupBy, a.key ?? '', context) - groupRank(groupBy, b.key ?? '', context));
  }
  const nothing = (g: LensGroup<T>) => g.key === null || (groupBy === 'project' && g.key === UNASSIGNED_PROJECT);
  return [...groups.filter((g) => !nothing(g)), ...groups.filter(nothing)];
}

// ---------------------------------------------------------------------------------------------
// Counts, for menus
// ---------------------------------------------------------------------------------------------

export interface LensCounts {
  kinds: Map<SessionKind, number>;
  providers: Map<ProviderId, number>;
  accounts: Map<string, number>;
}

/** How many sessions each kind, provider and account has in a list (before any filter). */
export function countLens<T>(items: readonly T[], get: ConversationOf<T>, accountIdOf?: AccountIdOf): LensCounts {
  const counts: LensCounts = { kinds: new Map(), providers: new Map(), accounts: new Map() };
  for (const item of items) {
    const conv = get(item);
    const kind = sessionGroupOf(conv.provider);
    counts.kinds.set(kind, (counts.kinds.get(kind) ?? 0) + 1);
    counts.providers.set(conv.provider, (counts.providers.get(conv.provider) ?? 0) + 1);
    const account = accountIdOf?.(conv);
    if (account) counts.accounts.set(account, (counts.accounts.get(account) ?? 0) + 1);
  }
  return counts;
}

// ---------------------------------------------------------------------------------------------
// Hand-off to the Threads list
// ---------------------------------------------------------------------------------------------

/**
 * "Show all" in the side navigation: switch to Threads narrowed to one group. Type, provider,
 * account and repository have a matching Threads filter; date and none just switch.
 */
export interface ShowInThreadsRequest {
  by: LensGroupBy;
  key: string | null;
}
