import {
  getDisplayTitle,
  type CollectionRecord,
  type ConversationRecord,
  type ProjectSource,
  type SettingsRecord,
  type ThreadInsight,
  type ThreadVectorRecord,
} from './schema.js';
import { UNFILED_PROJECT, type ThreadkeeperDB } from './db.js';
import { LOCAL_SPACE, cosine, nearestNeighbors, primarySpace } from './embeddings.js';
import { normalizeTags } from './organization.js';
import { GENERIC_NAME_TOKENS, findMatchingProject, normalizeName } from './project-match.js';

export { findMatchingProject, normalizeName } from './project-match.js';

/** Project sources whose assignments are reliable enough to teach the k-NN filer. */
const TRUSTED_SOURCES = new Set<ProjectSource>(['manual', 'provider', 'ai', 'import', 'rules', 'cluster']);
/** Assignments the auto-organizer may revise when a stronger signal arrives. */
const REVISABLE_SOURCES = new Set<ProjectSource>(['default', 'import', 'rules', 'similar', 'ai', 'provider', 'cluster']);

const SOURCE_STRENGTH: Record<ProjectSource, number> = {
  default: 0,
  similar: 1,
  rules: 2,
  cluster: 2,
  import: 3,
  ai: 4,
  provider: 5,
  manual: 9,
};

export interface OrganizeContext {
  collections: CollectionRecord[];
  /** Vectors of threads with trusted, filed projects, per space. */
  trusted: Map<string, Array<Pick<ThreadVectorRecord, 'threadKey' | 'embedding'> & { project: string }>>;
  loadedAt: number;
}

export async function loadOrganizeContext(
  db: ThreadkeeperDB,
  settings: SettingsRecord
): Promise<OrganizeContext> {
  const [collections, conversations] = await Promise.all([
    db.collections.toArray(),
    db.conversations.toArray(),
  ]);
  const trustedProject = new Map<string, string>();
  for (const c of conversations) {
    if (c.isSyntheticBenchmark || c.project === UNFILED_PROJECT || !c.project) continue;
    if (c.categoryLocked || TRUSTED_SOURCES.has(c.projectSource ?? 'import')) {
      trustedProject.set(c.threadKey, c.project);
    }
  }
  const trusted: OrganizeContext['trusted'] = new Map();
  const spaces = Array.from(new Set([LOCAL_SPACE, primarySpace(settings).id]));
  for (const space of spaces) {
    const vectors = await db.threadVectors.where('space').equals(space).toArray();
    trusted.set(
      space,
      vectors
        .filter((v) => trustedProject.has(v.threadKey))
        .map((v) => ({ threadKey: v.threadKey, embedding: v.embedding, project: trustedProject.get(v.threadKey)! }))
    );
  }
  return { collections, trusted, loadedAt: Date.now() };
}

function keywordsFor(c: CollectionRecord): string[] {
  const own = (c.keywords ?? []).map((k) => k.toLowerCase().trim()).filter((k) => k.length >= 3);
  if (c.origin === 'starter') return own;
  const name = normalizeName(c.name);
  const distinctive = name.split(' ').filter((t) => t.length >= 4 && !GENERIC_NAME_TOKENS.has(t));
  return Array.from(new Set([...own, ...(distinctive.length ? [name] : [])]));
}

function countMatches(haystack: string, keyword: string): number {
  if (!keyword) return 0;
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '[\\s_-]+');
  const re = new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'g');
  return (haystack.match(re) ?? []).length;
}

export interface RuleScore {
  project: string;
  score: number;
  hits: string[];
}

/** Keyword routing: project keywords found in the title, gist, topics and opening turns. */
export function scoreProjectRules(
  conv: ConversationRecord,
  insight: ThreadInsight | null,
  openingText: string,
  collections: CollectionRecord[]
): RuleScore[] {
  const fields: Array<[string, number]> = [
    [getDisplayTitle(conv).toLowerCase(), 3],
    [`${insight?.gist ?? ''} ${insight?.summary ?? ''}`.toLowerCase(), 2],
    [[...(insight?.topics ?? []), ...(insight?.entities ?? [])].join(' ').toLowerCase(), 2],
    [(conv.providerProjectName ?? '').toLowerCase(), 4],
    [(conv.workspacePath ?? '').toLowerCase(), 2],
    [openingText.slice(0, 4000).toLowerCase(), 1],
  ];
  const results: RuleScore[] = [];
  for (const c of collections) {
    if (c.name === UNFILED_PROJECT) continue;
    let score = 0;
    const hits = new Set<string>();
    for (const kw of keywordsFor(c)) {
      for (const [text, weight] of fields) {
        const n = countMatches(text, kw);
        if (n > 0) {
          score += Math.min(n, 3) * weight;
          hits.add(kw);
        }
      }
    }
    if (score > 0) results.push({ project: c.name, score, hits: Array.from(hits) });
  }
  return results.sort((a, b) => b.score - a.score);
}

export interface ProjectDecision {
  project: string;
  source: ProjectSource;
  confidence: number;
  reason: string;
  /** Present when the decision needs a new project created first. */
  create?: CollectionRecord;
}

function newCollection(name: string, origin: CollectionRecord['origin'], keywords: string[], description: string): CollectionRecord {
  return {
    name: name.trim().slice(0, 80),
    description,
    isStarterArea: false,
    cloudExcluded: false,
    createdAt: new Date().toISOString(),
    keywords: Array.from(new Set([normalizeName(name), ...keywords.map((k) => k.toLowerCase())])).filter(Boolean).slice(0, 12),
    origin,
  };
}

/**
 * Decide where a thread belongs. Returns null when nothing beats the current
 * assignment. Never called for locked or manually filed threads.
 */
export function decideProject(
  conv: ConversationRecord,
  insight: ThreadInsight | null,
  openingText: string,
  ctx: OrganizeContext,
  settings: SettingsRecord,
  vectors: Map<string, number[]>
): ProjectDecision | null {
  const allowCreate = settings.autoOrganize.autoCreateProjects;

  // 1. The provider's own organization: ChatGPT/Claude Projects, CLI repository.
  if (conv.providerProjectName?.trim()) {
    const match = findMatchingProject(conv.providerProjectName, ctx.collections);
    const label =
      conv.provider === 'claude_code' || conv.provider === 'codex'
        ? `repository "${conv.providerProjectName}"`
        : `${conv.provider === 'chatgpt' ? 'ChatGPT' : 'Claude'} project "${conv.providerProjectName}"`;
    if (match) {
      return { project: match.name, source: 'provider', confidence: 0.95, reason: `Matches ${label}` };
    }
    if (allowCreate) {
      return {
        project: conv.providerProjectName.trim(),
        source: 'provider',
        confidence: 0.9,
        reason: `New project from ${label}`,
        create: newCollection(conv.providerProjectName, 'provider', [], `Threads from ${label}`),
      };
    }
  }

  // 2. Claude's judgement.
  const suggestion = insight?.source === 'ai' ? insight.suggestedProject : null;
  if (suggestion && suggestion.name.trim()) {
    const match = findMatchingProject(suggestion.name, ctx.collections);
    if (match && suggestion.confidence >= 0.5) {
      return { project: match.name, source: 'ai', confidence: suggestion.confidence, reason: suggestion.reason || 'Claude matched this thread to the project' };
    }
    if (!match && suggestion.isNew && allowCreate && suggestion.confidence >= 0.7) {
      return {
        project: suggestion.name.trim(),
        source: 'ai',
        confidence: suggestion.confidence,
        reason: suggestion.reason || 'Claude proposed a new project',
        create: newCollection(suggestion.name, 'auto', insight?.topics.slice(0, 4) ?? [], suggestion.reason || ''),
      };
    }
  }

  // 3. Keyword routing.
  const rules = scoreProjectRules(conv, insight, openingText, ctx.collections);
  if (rules.length > 0 && rules[0].score >= 3 && (rules.length === 1 || rules[0].score >= rules[1].score * 1.5)) {
    return {
      project: rules[0].project,
      source: 'rules',
      confidence: Math.min(0.9, 0.5 + rules[0].score / 20),
      reason: `Mentions ${rules[0].hits.slice(0, 3).map((h) => `"${h}"`).join(', ')}`,
    };
  }

  // 4. Nearest neighbours among confidently filed threads.
  const space = primarySpace(settings);
  for (const [spaceId, threshold] of [
    [space.id, space.relatedThreshold],
    [LOCAL_SPACE, 0.32],
  ] as Array<[string, number]>) {
    const vec = vectors.get(spaceId);
    const pool = ctx.trusted.get(spaceId);
    if (!vec || !pool || pool.length < 3) continue;
    const neighbors = nearestNeighbors(vec, pool, 7, {
      exclude: new Set([conv.threadKey]),
      minSimilarity: threshold,
    });
    if (neighbors.length === 0) continue;
    const projectOf = new Map(pool.map((p) => [p.threadKey, p.project]));
    const votes = new Map<string, number>();
    let total = 0;
    for (const n of neighbors) {
      const p = projectOf.get(n.threadKey)!;
      votes.set(p, (votes.get(p) ?? 0) + n.similarity);
      total += n.similarity;
    }
    const [bestProject, bestVote] = Array.from(votes.entries()).sort((a, b) => b[1] - a[1])[0];
    const share = bestVote / total;
    if (share >= 0.6 && bestVote >= threshold * 1.6) {
      const count = neighbors.filter((n) => projectOf.get(n.threadKey) === bestProject).length;
      return {
        project: bestProject,
        source: 'similar',
        confidence: Math.min(0.85, share * (neighbors[0].similarity + 0.2)),
        reason: `Similar to ${count} thread${count === 1 ? '' : 's'} already in ${bestProject}`,
      };
    }
  }
  return null;
}

export interface AutoOrganizeResult {
  projectChanged: boolean;
  statusChanged: boolean;
  tagsChanged: boolean;
  createdProject: string | null;
}

/**
 * Apply automatic filing, status and tags to one thread. Respects locks,
 * manual assignments and manual workflow states.
 */
export async function applyAutoOrganization(
  db: ThreadkeeperDB,
  threadKey: string,
  settings: SettingsRecord,
  ctx: OrganizeContext,
  insight: ThreadInsight | null,
  previousTopics: string[] = []
): Promise<AutoOrganizeResult> {
  const result: AutoOrganizeResult = { projectChanged: false, statusChanged: false, tagsChanged: false, createdProject: null };
  const conv = await db.conversations.get(threadKey);
  if (!conv || conv.isSyntheticBenchmark) return result;
  const opts = settings.autoOrganize;

  let decision: ProjectDecision | null = null;
  const currentSource = conv.projectSource ?? (conv.project === UNFILED_PROJECT ? 'default' : 'import');
  if (opts.autoFile && !conv.categoryLocked && REVISABLE_SOURCES.has(currentSource)) {
    const [messages, vectorRows] = await Promise.all([
      db.messages.where('threadKey').equals(threadKey).sortBy('ordinal'),
      db.threadVectors.where('threadKey').equals(threadKey).toArray(),
    ]);
    const opening = messages
      .filter((m) => m.role === 'user')
      .slice(0, 3)
      .map((m) => m.content)
      .join('\n');
    const vectors = new Map(vectorRows.map((v) => [v.space, v.embedding]));
    decision = decideProject(conv, insight, opening, ctx, settings, vectors);
    // A weaker signal never overrides (or relabels) an assignment made by a stronger one.
    if (
      decision &&
      conv.project !== UNFILED_PROJECT &&
      SOURCE_STRENGTH[decision.source] < SOURCE_STRENGTH[currentSource]
    ) {
      decision = null;
    }
  }

  await db.transaction('rw', [db.conversations, db.collections], async () => {
    const live = await db.conversations.get(threadKey);
    if (!live) return;
    const next: ConversationRecord = { ...live };

    if (decision && !live.categoryLocked && live.projectSource !== 'manual') {
      if (decision.create && !(await db.collections.get(decision.create.name))) {
        await db.collections.put(decision.create);
        ctx.collections.push(decision.create);
        result.createdProject = decision.create.name;
      }
      if (live.project !== decision.project || live.projectSource !== decision.source || live.projectReason !== decision.reason) {
        result.projectChanged = live.project !== decision.project;
        next.project = decision.project;
        next.projectSource = decision.source;
        next.projectReason = decision.reason;
      }
    }

    if (
      opts.autoStatus &&
      insight?.suggestedStatus &&
      live.workflowStateSource !== 'manual' &&
      live.workflowState !== 'archived' &&
      live.workflowState !== insight.suggestedStatus
    ) {
      next.workflowState = insight.suggestedStatus;
      next.workflowStateSource = 'auto';
      result.statusChanged = true;
    }

    if (opts.autoTags && insight) {
      const stale = new Set(previousTopics.map((t) => t.toLowerCase()));
      const kept = live.tags.filter((t) => !stale.has(t.toLowerCase()));
      const tags = normalizeTags([...live.manualTags, ...kept, ...insight.topics]).slice(0, 16);
      if (tags.join('|') !== live.tags.join('|')) {
        next.tags = tags;
        result.tagsChanged = true;
      }
    }

    if (
      result.projectChanged ||
      result.statusChanged ||
      result.tagsChanged ||
      next.projectSource !== live.projectSource ||
      next.projectReason !== live.projectReason
    ) {
      await db.conversations.put(next);
    }
  });

  if (decision && result.projectChanged) {
    // Keep the in-memory k-NN pool current for the rest of a batch.
    if (TRUSTED_SOURCES.has(decision.source)) {
      const rows = await db.threadVectors.where('threadKey').equals(threadKey).toArray();
      for (const row of rows) {
        const pool = ctx.trusted.get(row.space);
        if (pool) {
          const idx = pool.findIndex((p) => p.threadKey === threadKey);
          const entry = { threadKey, embedding: row.embedding, project: decision.project };
          if (idx >= 0) pool[idx] = entry;
          else pool.push(entry);
        }
      }
    }
  }
  return result;
}

export function lastReasonFor(decision: ProjectDecision | null): string | null {
  return decision?.reason ?? null;
}

// ---------------------------------------------------------------------------
// Library-wide clustering (no AI required)
// ---------------------------------------------------------------------------

export interface ClusterProposal {
  name: string;
  threadKeys: string[];
  topics: string[];
  existingProject: string | null;
  cohesion: number;
}

/**
 * Greedy single-pass clustering of unfiled threads in one vector space.
 * Clusters of three or more become proposed projects named after their most
 * shared topics, or routed to an existing project with a matching name.
 */
export function clusterThreads(
  items: Array<{ threadKey: string; embedding: number[]; topics: string[] }>,
  collections: CollectionRecord[],
  threshold: number,
  minSize = 3
): ClusterProposal[] {
  const assigned = new Set<string>();
  const neighborLists = items.map((a) =>
    items
      .filter((b) => b.threadKey !== a.threadKey)
      .map((b) => ({ b, sim: cosine(a.embedding, b.embedding) }))
      .filter((x) => x.sim >= threshold)
  );
  const order = items.map((_, i) => i).sort((i, j) => neighborLists[j].length - neighborLists[i].length);
  const clusters: ClusterProposal[] = [];
  for (const i of order) {
    const seed = items[i];
    if (assigned.has(seed.threadKey)) continue;
    const members = [seed, ...neighborLists[i].filter((x) => !assigned.has(x.b.threadKey)).map((x) => x.b)];
    if (members.length < minSize) continue;
    for (const m of members) assigned.add(m.threadKey);
    const topicCounts = new Map<string, number>();
    for (const m of members) for (const t of new Set(m.topics)) topicCounts.set(t, (topicCounts.get(t) ?? 0) + 1);
    const shared = Array.from(topicCounts.entries())
      .filter(([, c]) => c >= Math.max(2, Math.ceil(members.length * 0.34)))
      .sort((a, b) => b[1] - a[1])
      .map(([t]) => t);
    const nameTopics = shared.slice(0, 2);
    const name = nameTopics.length
      ? nameTopics.map((t) => t.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')).join(' / ')
      : `Related threads: ${seed.topics[0] ?? 'misc'}`;
    const existing = nameTopics.length ? findMatchingProject(nameTopics.join(' '), collections) : null;
    let cohesion = 0;
    let pairs = 0;
    for (let a = 0; a < members.length; a++) {
      for (let b = a + 1; b < members.length; b++) {
        cohesion += cosine(members[a].embedding, members[b].embedding);
        pairs++;
      }
    }
    clusters.push({
      name,
      threadKeys: members.map((m) => m.threadKey),
      topics: shared.slice(0, 5),
      existingProject: existing?.name ?? null,
      cohesion: pairs ? cohesion / pairs : 1,
    });
  }
  return clusters.sort((a, b) => b.threadKeys.length - a.threadKeys.length);
}
