// How the Threads list is grouped on the full page, and what is collapsed. Pure helpers plus a
// tiny shared store: the search hook (which owns the order of rows, selection ranges and j / k)
// and the list (which draws the group headers) have to agree on both, and they live in
// different places of the component tree.
import { useSyncExternalStore } from 'react';
import { providerCategory } from '../../../core/providers.js';
import { groupByRepository, hasRepositoryOwner, repositoryName, threadRepository } from '../../../core/repository.js';
import type { ConversationRecord, ThreadsGroupBy } from '../../../core/schema.js';
import type { SearchHit } from '../../../core/search.js';

export const isCodingProvider = (provider: string): boolean => providerCategory(provider) === 'coding_agent';

// ---------------------------------------------------------------------------------------------
// Repositories
// ---------------------------------------------------------------------------------------------

/**
 * The repository each thread is grouped under, with bare names folded into the one "owner/name"
 * that ends with them (see groupByRepository). Threads without a repository map to null.
 * Built over every non-synthetic thread so a thread's group does not change with the filters.
 */
export function buildRepositoryIndex(conversations: readonly ConversationRecord[]): ReadonlyMap<string, string | null> {
  const real = conversations.filter((c) => !c.isSyntheticBenchmark);
  const { groups, ungrouped } = groupByRepository(real, (c) => threadRepository(c, isCodingProvider));
  const index = new Map<string, string | null>();
  for (const g of groups) for (const c of g.items) index.set(c.threadKey, g.repository);
  for (const c of ungrouped) index.set(c.threadKey, null);
  return index;
}

/** One repository of the rail: its name and how many open (not archived) sessions worked in it. */
export interface RepositoryEntry {
  repository: string;
  count: number;
}

/** Repositories of the non-archived, non-synthetic sessions, biggest first, then by name. */
export function repositoryEntries(
  conversations: readonly ConversationRecord[],
  index: ReadonlyMap<string, string | null> = buildRepositoryIndex(conversations)
): RepositoryEntry[] {
  const counts = new Map<string, number>();
  for (const c of conversations) {
    if (c.isSyntheticBenchmark || c.workflowState === 'archived') continue;
    const repository = index.get(c.threadKey);
    if (repository) counts.set(repository, (counts.get(repository) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([repository, count]) => ({ repository, count }))
    .sort((a, b) => b.count - a.count || a.repository.localeCompare(b.repository));
}

/** Whether a thread's repository group is the one a filter names; a bare filter matches "owner/name". */
export function matchesRepository(group: string | null | undefined, filter: string): boolean {
  if (!group) return false;
  if (group === filter) return true;
  return !hasRepositoryOwner(filter) && hasRepositoryOwner(group) && repositoryName(group) === filter;
}

// ---------------------------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------------------------

export interface ThreadGroup {
  /** Stable id: `<groupBy>:<key>`. What is collapsed is remembered by it. */
  id: string;
  /** Project name, repository, or account id; null for "no repository" / "no account". */
  key: string | null;
  hits: SearchHit[];
}

export interface GroupKeys {
  repository: (conv: ConversationRecord) => string | null;
  account: (conv: ConversationRecord) => string | null;
}

/**
 * Split hits (already in list order) into groups. Projects and accounts appear in the order their
 * first thread does; repositories are ordered like the rail (biggest first, then by name); the
 * group of threads without a repository or account comes last. Inside a group the order is kept.
 */
export function groupThreadHits(hits: readonly SearchHit[], groupBy: ThreadsGroupBy, keys: GroupKeys): ThreadGroup[] {
  if (groupBy === 'none') return [];
  const keyOf = (hit: SearchHit): string | null => {
    const conv = hit.conversation;
    if (groupBy === 'project') return conv.project || 'Unassigned';
    return groupBy === 'repository' ? keys.repository(conv) : keys.account(conv);
  };
  const byKey = new Map<string | null, SearchHit[]>();
  for (const hit of hits) {
    const key = keyOf(hit);
    const list = byKey.get(key);
    if (list) list.push(hit);
    else byKey.set(key, [hit]);
  }
  const groups: ThreadGroup[] = [...byKey.entries()].map(([key, list]) => ({
    id: `${groupBy}:${key ?? ''}`,
    key,
    hits: list,
  }));
  if (groupBy === 'repository') {
    groups.sort((a, b) => b.hits.length - a.hits.length || (a.key ?? '').localeCompare(b.key ?? ''));
  }
  // "Nothing to group by" is always last, whatever the order above was.
  return [...groups.filter((g) => g.key !== null), ...groups.filter((g) => g.key === null)];
}

// ---------------------------------------------------------------------------------------------
// Shared state
// ---------------------------------------------------------------------------------------------

export interface ThreadGroupingState {
  /** The full-page list is mounted and draws groups (the side panel and overlay never do). */
  pageList: boolean;
  collapsed: ReadonlySet<string>;
}

let current: ThreadGroupingState = { pageList: false, collapsed: new Set() };
const listeners = new Set<() => void>();

function publish(next: ThreadGroupingState): void {
  current = next;
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useThreadGrouping(): ThreadGroupingState {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export function setPageList(on: boolean): void {
  if (current.pageList !== on) publish({ ...current, pageList: on });
}

export function toggleGroupCollapsed(id: string): void {
  const collapsed = new Set(current.collapsed);
  if (!collapsed.delete(id)) collapsed.add(id);
  publish({ ...current, collapsed });
}

/** For tests: forget what is collapsed and whether a page list is mounted. */
export function resetThreadGrouping(): void {
  publish({ pageList: false, collapsed: new Set() });
}
