// Repository identity for coding sessions. One normalized value lets threads from different
// providers and accounts that worked on the same repository be grouped together.
//
// The normalized form is lowercase "owner/name". When only the name is known (a CLI session's
// folder name, a page that shows no owner) the value is just "name"; grouping then folds a
// bare name into the single "owner/name" that ends with it, and leaves it on its own when
// that would be a guess (no such repository, or more than one).
import type { ConversationRecord } from './schema.js';

const SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
const HOSTS = /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/i;
/** First path segments of github.com that are site sections, not account names. */
const GITHUB_SECTIONS = new Set([
  'about', 'account', 'apps', 'codespaces', 'collections', 'copilot', 'customer-stories', 'dashboard',
  'enterprise', 'events', 'explore', 'features', 'issues', 'join', 'login', 'logout', 'marketplace',
  'new', 'notifications', 'organizations', 'orgs', 'pricing', 'pulls', 'readme', 'search', 'security',
  'sessions', 'settings', 'signup', 'site', 'sponsors', 'team', 'topics', 'trending', 'users',
]);

function isSiteSection(hostname: string, owner: string): boolean {
  return /^(?:www\.)?github\.com$/i.test(hostname) && GITHUB_SECTIONS.has(owner);
}

function cleanSegment(value: string): string | null {
  const v = value.trim().replace(/\.git$/i, '');
  if (!SEGMENT.test(v) || v === '.' || v === '..') return null;
  return v.toLowerCase();
}

/**
 * Normalize what a page, a log or a person gave as a repository:
 * `https://github.com/Owner/Repo/pull/3`, `git@github.com:Owner/Repo.git`, `Owner/Repo`,
 * `Owner / Repo`, or a bare `Repo`. Returns "owner/name", "name", or null when it is not one.
 */
export function normalizeRepository(input: string | null | undefined): string | null {
  if (!input) return null;
  let text = input.trim();
  if (!text || text.length > 400) return null;

  const ssh = text.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  if (ssh) {
    const owner = cleanSegment(ssh[2]);
    const name = cleanSegment(ssh[3]);
    return owner && name ? `${owner}/${name}` : null;
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) {
    let url: URL;
    try {
      url = new URL(text);
    } catch {
      return null;
    }
    if (!HOSTS.test(url.hostname)) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length < 2) return null;
    const owner = cleanSegment(parts[0]);
    const name = cleanSegment(parts[1]);
    // github.com/settings/profile is a page of the site, not a repository.
    if (owner && isSiteSection(url.hostname, owner)) return null;
    return owner && name ? `${owner}/${name}` : null;
  }

  text = text.replace(/\s*\/\s*/g, '/');
  const parts = text.split('/');
  if (parts.length === 2) {
    const owner = cleanSegment(parts[0]);
    const name = cleanSegment(parts[1]);
    return owner && name ? `${owner}/${name}` : null;
  }
  if (parts.length === 1) return cleanSegment(parts[0]);
  return null;
}

/** Repository name without its owner: "acme/app" → "app". */
export function repositoryName(repository: string): string {
  const slash = repository.lastIndexOf('/');
  return slash === -1 ? repository : repository.slice(slash + 1);
}

/** Whether the value names its owner ("owner/name"). */
export function hasRepositoryOwner(repository: string): boolean {
  return repository.includes('/');
}

/** Pull request address on a known forge, canonical and without query or fragment; else null. */
export function normalizePullRequestUrl(input: string | null | undefined): string | null {
  if (!input) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || !HOSTS.test(url.hostname)) return null;
  // GitLab writes /owner/name/-/merge_requests/7; the "/-" carries no meaning.
  const m = url.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/-)?\/(pull|pulls|merge_requests|pull-requests)\/(\d+)/);
  if (!m) return null;
  const owner = cleanSegment(m[1]);
  const name = cleanSegment(m[2]);
  if (!owner || !name || isSiteSection(url.hostname, owner)) return null;
  const kind = m[3] === 'pulls' ? 'pull' : m[3];
  return `https://${url.hostname.replace(/^www\./i, '').toLowerCase()}/${owner}/${name}/${kind}/${m[4]}`;
}

type RepoSource = Pick<ConversationRecord, 'repository' | 'providerProjectName' | 'workspacePath' | 'provider'>;

/**
 * The repository a thread should be grouped under, before bare names are folded: its stored
 * `repository`, else (for coding sessions only) the provider's project name or the last folder
 * of the working directory. `isCodingProvider` decides what counts as a coding session.
 */
export function threadRepository(conv: RepoSource, isCodingProvider: (provider: string) => boolean): string | null {
  const stored = normalizeRepository(conv.repository ?? null);
  if (stored) return stored;
  if (!isCodingProvider(conv.provider)) return null;
  const named = normalizeRepository(conv.providerProjectName ?? null);
  if (named) return named;
  const path = (conv.workspacePath ?? '').replace(/[\\/]+$/, '');
  const base = path.split(/[\\/]/).pop() ?? '';
  return normalizeRepository(base);
}

export interface RepositoryGroup<T> {
  /** "owner/name", or a bare "name" that could not be matched to one owner. */
  repository: string;
  items: T[];
}

/**
 * Group threads by repository. `repositoryOf` returns each thread's own value (see
 * `threadRepository`); threads without one are returned in `ungrouped`. A bare name joins the
 * one "owner/name" group with that name; with none or several it stays its own group.
 * Groups are ordered by size, then name.
 */
export function groupByRepository<T>(
  items: readonly T[],
  repositoryOf: (item: T) => string | null
): { groups: RepositoryGroup<T>[]; ungrouped: T[] } {
  const own = new Map<T, string>();
  const ownersByName = new Map<string, Set<string>>();
  const ungrouped: T[] = [];
  for (const item of items) {
    const repo = repositoryOf(item);
    if (!repo) {
      ungrouped.push(item);
      continue;
    }
    own.set(item, repo);
    if (hasRepositoryOwner(repo)) {
      const name = repositoryName(repo);
      let set = ownersByName.get(name);
      if (!set) ownersByName.set(name, (set = new Set()));
      set.add(repo);
    }
  }
  const byRepo = new Map<string, T[]>();
  for (const item of items) {
    let repo = own.get(item);
    if (!repo) continue;
    if (!hasRepositoryOwner(repo)) {
      const candidates = ownersByName.get(repo);
      if (candidates && candidates.size === 1) repo = [...candidates][0];
    }
    let list = byRepo.get(repo);
    if (!list) byRepo.set(repo, (list = []));
    list.push(item);
  }
  const groups = [...byRepo.entries()]
    .map(([repository, list]) => ({ repository, items: list }))
    .sort((a, b) => b.items.length - a.items.length || a.repository.localeCompare(b.repository));
  return { groups, ungrouped };
}
