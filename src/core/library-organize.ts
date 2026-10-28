import {
  getDisplayTitle,
  type CollectionRecord,
  type ConversationRecord,
  type SettingsRecord,
  type ThreadInsight,
} from './schema.js';
import { UNFILED_PROJECT, ensureStarterCollectionsAndSettings, type ThreadkeeperDB } from './db.js';
import { previewNaturalLanguageOrganize, type OrganizeProposalItem } from './organization.js';
import {
  clusterThreads,
  decideProject,
  findMatchingProject,
  loadOrganizeContext,
} from './auto-organize.js';
import { LOCAL_SPACE, primarySpace } from './embeddings.js';
import { resolveInsight } from './insights.js';
import { hasClaudeKey, planOrganizationWithClaude, type OrganizeThreadRow } from './ai/claude.js';
import { providerLabel } from './providers.js';
import { isRemoteProcessingAllowed } from './pipeline.js';

export interface LibraryPlan {
  mode: 'ai' | 'local';
  proposals: OrganizeProposalItem[];
  notes: string[];
}

const AUTO_INSTRUCTION =
  'Organize my whole library: file every thread into the best existing project, group recurring unfiled work into new projects, and add useful topic tags.';

const MAX_AI_ROWS = 250;

async function loadInsights(db: ThreadkeeperDB, conversations: ConversationRecord[]) {
  const all = await db.insights.toArray();
  const local = new Map<string, ThreadInsight>();
  const ai = new Map<string, ThreadInsight>();
  for (const i of all) (i.source === 'ai' ? ai : local).set(i.threadKey, i);
  const resolved = new Map<string, ThreadInsight>();
  for (const c of conversations) {
    const r = resolveInsight(c, local.get(c.threadKey), ai.get(c.threadKey));
    if (r) resolved.set(c.threadKey, r);
  }
  return resolved;
}

/** Proposals without AI: re-run the filer over every revisable thread, then cluster what is left unfiled. */
async function planLocally(
  db: ThreadkeeperDB,
  settings: SettingsRecord,
  conversations: ConversationRecord[],
  insights: Map<string, ThreadInsight>,
  instruction: string
): Promise<LibraryPlan> {
  const collections = await db.collections.toArray();
  if (instruction.trim()) {
    const extraText = new Map<string, string>();
    for (const [k, i] of insights) extraText.set(k, `${i.gist} ${i.summary} ${i.topics.join(' ')} ${i.entities.join(' ')}`);
    return {
      mode: 'local',
      proposals: previewNaturalLanguageOrganize(instruction, conversations, { collections, extraText }),
      notes: ['Keyword matching (add an Anthropic API key in Settings for Claude-planned organization).'],
    };
  }

  const ctx = await loadOrganizeContext(db, settings);
  const proposals: OrganizeProposalItem[] = [];
  const space = primarySpace(settings);
  const vectorRows = await db.threadVectors.where('space').anyOf([space.id, LOCAL_SPACE]).toArray();
  const vectorsByThread = new Map<string, Map<string, number[]>>();
  for (const v of vectorRows) {
    const m = vectorsByThread.get(v.threadKey) ?? new Map<string, number[]>();
    m.set(v.space, v.embedding);
    vectorsByThread.set(v.threadKey, m);
  }

  const stillUnfiled: ConversationRecord[] = [];
  for (const conv of conversations) {
    if (conv.isSyntheticBenchmark || conv.categoryLocked || conv.projectSource === 'manual') continue;
    const insight = insights.get(conv.threadKey) ?? null;
    const opening = '';
    const decision = decideProject(conv, insight, opening, ctx, settings, vectorsByThread.get(conv.threadKey) ?? new Map());
    if (decision && decision.project !== conv.project) {
      proposals.push({
        threadKey: conv.threadKey,
        title: getDisplayTitle(conv),
        currentProject: conv.project,
        proposedProject: decision.project,
        currentTags: conv.tags,
        proposedTags: insight?.topics.slice(0, 4) ?? [],
        proposedState: null,
        categoryLocked: false,
        excludedByInstruction: false,
        reason: decision.reason,
        confidence: decision.confidence,
        source: decision.source,
        newProject: decision.create
          ? { name: decision.create.name, description: decision.create.description, keywords: decision.create.keywords ?? [] }
          : null,
      });
    } else if (conv.project === UNFILED_PROJECT) {
      stillUnfiled.push(conv);
    }
  }

  const clusterSpace = vectorRows.some((v) => v.space === space.id) ? space : { id: LOCAL_SPACE, relatedThreshold: 0.3 };
  const items = stillUnfiled
    .map((c) => ({
      threadKey: c.threadKey,
      embedding: vectorsByThread.get(c.threadKey)?.get(clusterSpace.id),
      topics: insights.get(c.threadKey)?.topics ?? [],
    }))
    .filter((i): i is { threadKey: string; embedding: number[]; topics: string[] } => Boolean(i.embedding));
  // On-device vectors: related threads measure ~0.34-0.55 and unrelated ones ~0.15-0.2,
  // so cluster at the related threshold; hosted models get a small extra margin.
  const clusterThreshold =
    clusterSpace.id === LOCAL_SPACE ? clusterSpace.relatedThreshold : clusterSpace.relatedThreshold + 0.05;
  const clusters = clusterThreads(items, collections, clusterThreshold);
  const byKey = new Map(conversations.map((c) => [c.threadKey, c]));
  for (const cluster of clusters.slice(0, 12)) {
    const target = cluster.existingProject ?? cluster.name;
    for (const key of cluster.threadKeys) {
      const conv = byKey.get(key)!;
      proposals.push({
        threadKey: key,
        title: getDisplayTitle(conv),
        currentProject: conv.project,
        proposedProject: target,
        currentTags: conv.tags,
        proposedTags: cluster.topics.slice(0, 3),
        proposedState: null,
        categoryLocked: false,
        excludedByInstruction: false,
        reason: `Groups ${cluster.threadKeys.length} similar unfiled threads (${cluster.topics.slice(0, 3).join(', ') || 'shared vocabulary'})`,
        confidence: Math.min(0.8, cluster.cohesion + 0.2),
        source: 'cluster',
        newProject: cluster.existingProject
          ? null
          : { name: cluster.name, description: `Auto-grouped: ${cluster.topics.join(', ')}`, keywords: cluster.topics },
      });
    }
  }
  return {
    mode: 'local',
    proposals,
    notes: [
      `${proposals.length} change(s) from provider projects, keyword rules, similar threads and ${clusters.length} cluster(s) of unfiled threads.`,
    ],
  };
}

/**
 * Plan a library reorganization. With an Anthropic key Claude plans it;
 * otherwise the on-device filer and clustering do. Nothing is applied here —
 * the caller previews proposals and applies them with an undo log.
 */
export async function planLibraryOrganization(
  db: ThreadkeeperDB,
  options: { instruction?: string; preferAi?: boolean; fetchImpl?: typeof fetch } = {}
): Promise<LibraryPlan> {
  const settings = await ensureStarterCollectionsAndSettings(db);
  const conversations = (await db.conversations.toArray()).filter((c) => !c.isSyntheticBenchmark);
  const insights = await loadInsights(db, conversations);
  const instruction = options.instruction?.trim() ?? '';

  if (options.preferAi === false || !hasClaudeKey(settings)) {
    return planLocally(db, settings, conversations, insights, instruction);
  }

  // Candidate selection: matches for an instruction first; otherwise the threads the filer is least sure about.
  const words = instruction.toLowerCase().split(/\W+/).filter((w) => w.length >= 4);
  const scoreOf = (c: ConversationRecord): number => {
    const i = insights.get(c.threadKey);
    const text = `${getDisplayTitle(c)} ${i?.gist ?? ''} ${i?.topics.join(' ') ?? ''}`.toLowerCase();
    const lexical = words.reduce((n, w) => n + (text.includes(w) ? 2 : 0), 0);
    const uncertain = c.project === UNFILED_PROJECT ? 3 : c.projectSource === 'similar' || c.projectSource === 'default' ? 2 : 0;
    return instruction ? lexical * 3 + uncertain : uncertain;
  };
  const allowed: ConversationRecord[] = [];
  for (const c of conversations) {
    if (await isRemoteProcessingAllowed(db, c, settings)) allowed.push(c);
  }
  const candidates = allowed
    .sort((a, b) => scoreOf(b) - scoreOf(a) || (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
    .slice(0, MAX_AI_ROWS);
  if (candidates.length === 0) {
    return { mode: 'ai', proposals: [], notes: ['No threads are eligible for AI organization.'] };
  }

  const collections: CollectionRecord[] = await db.collections.toArray();
  const rows: OrganizeThreadRow[] = candidates.map((c) => {
    const i = insights.get(c.threadKey);
    return {
      title: getDisplayTitle(c),
      gist: i?.gist ?? '',
      project: c.project,
      locked: c.categoryLocked || c.projectSource === 'manual',
      topics: i?.topics.slice(0, 6) ?? c.tags.slice(0, 6),
      provider: providerLabel(c.provider),
    };
  });
  const plan = await planOrganizationWithClaude(
    settings,
    {
      instruction: instruction || AUTO_INSTRUCTION,
      threads: rows,
      projects: collections.filter((c) => c.name !== UNFILED_PROJECT).map((c) => ({ name: c.name, description: c.description })),
    },
    options.fetchImpl
  );

  const newProjects = new Map(plan.newProjects.map((p) => [p.name.trim().toLowerCase(), p]));
  const proposals: OrganizeProposalItem[] = [];
  const seen = new Set<string>();
  for (const ex of plan.excluded) {
    const conv = candidates[Math.round(ex.thread) - 1];
    if (!conv || seen.has(conv.threadKey)) continue;
    seen.add(conv.threadKey);
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
      reason: ex.reason,
      confidence: 0.9,
    });
  }
  for (const change of plan.changes) {
    const conv = candidates[Math.round(change.thread) - 1];
    if (!conv || seen.has(conv.threadKey)) continue;
    seen.add(conv.threadKey);
    let target = change.project?.trim() || null;
    let newProject: OrganizeProposalItem['newProject'] = null;
    if (target) {
      const existing = findMatchingProject(target, collections);
      if (existing) target = existing.name;
      else {
        const np = newProjects.get(target.toLowerCase());
        newProject = { name: target, description: np?.description ?? '', keywords: np?.keywords ?? [] };
      }
    }
    const locked = conv.categoryLocked || conv.projectSource === 'manual';
    proposals.push({
      threadKey: conv.threadKey,
      title: getDisplayTitle(conv),
      currentProject: conv.project,
      proposedProject: locked ? null : target,
      currentTags: conv.tags,
      proposedTags: change.addTags.map((t) => t.toLowerCase()),
      proposedState: change.status,
      categoryLocked: locked,
      excludedByInstruction: false,
      reason: change.reason,
      confidence: 0.85,
      source: instruction ? 'manual' : 'ai',
      newProject: locked ? null : newProject,
    });
  }
  return {
    mode: 'ai',
    proposals,
    notes: [
      `Claude reviewed ${candidates.length} thread(s)${allowed.length > candidates.length ? ` (the ${candidates.length} most relevant of ${allowed.length})` : ''} and proposed ${plan.newProjects.length} new project(s).`,
    ],
  };
}
