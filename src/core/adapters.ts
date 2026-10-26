import {
  buildThreadKey,
  getDisplayTitle,
  type ConversationRecord,
  type MessageRecord,
  type StructuredSummaryRecord,
  type RelationshipRecord,
  type ProviderId,
} from './schema.js';
import type { UpsertThreadInput, ThreadkeeperDB } from './db.js';
import { upsertThread } from './db.js';

export type CapabilitySupport = 'Y' | 'P' | 'N';

export interface AdapterCapabilityRow {
  adapterId: string;
  label: string;
  visibleDom: CapabilitySupport;
  fullExport: CapabilitySupport;
  branchHistory: CapabilitySupport;
  timestamps: CapabilitySupport;
  artifacts: CapabilitySupport;
  cloudTaskStatus: 'N';
  openOriginal: CapabilitySupport;
  notes: string;
}

export const CAPABILITY_MATRIX: AdapterCapabilityRow[] = [
  {
    adapterId: 'chatgpt_dom',
    label: 'ChatGPT Web (Visible DOM)',
    visibleDom: 'Y',
    fullExport: 'N',
    branchHistory: 'P',
    timestamps: 'P',
    artifacts: 'P',
    cloudTaskStatus: 'N',
    openOriginal: 'Y',
    notes:
      'Captures rendered turns in the active tab with honest partial/title_only coverage; never scrapes hidden endpoints.',
  },
  {
    adapterId: 'chatgpt_export',
    label: 'ChatGPT Export (conversations.json)',
    visibleDom: 'N',
    fullExport: 'Y',
    branchHistory: 'Y',
    timestamps: 'Y',
    artifacts: 'P',
    cloudTaskStatus: 'N',
    openOriginal: 'Y',
    notes:
      'Reconstructs full mapping tree including active path and distinct sibling branches with exact Unix timestamps.',
  },
  {
    adapterId: 'claude_dom',
    label: 'Claude Web (Visible DOM)',
    visibleDom: 'Y',
    fullExport: 'N',
    branchHistory: 'P',
    timestamps: 'P',
    artifacts: 'P',
    cloudTaskStatus: 'N',
    openOriginal: 'Y',
    notes:
      'Captures completed rendered turns and artifact cards in the active tab with partial/title_only coverage.',
  },
  {
    adapterId: 'claude_export',
    label: 'Claude Export (conversations.json)',
    visibleDom: 'N',
    fullExport: 'Y',
    branchHistory: 'P',
    timestamps: 'Y',
    artifacts: 'P',
    cloudTaskStatus: 'N',
    openOriginal: 'Y',
    notes:
      'Imports full exported conversation history and ISO timestamps.',
  },
  {
    adapterId: 'portable_bundle',
    label: 'Threadkeeper Portable JSON / Markdown',
    visibleDom: 'N',
    fullExport: 'Y',
    branchHistory: 'Y',
    timestamps: 'Y',
    artifacts: 'Y',
    cloudTaskStatus: 'N',
    openOriginal: 'Y',
    notes:
      'Lossless round-trip export/import of threads, messages, manual overrides, locks, summaries, and relationships.',
  },
];

interface ChatGPTExportNode {
  id: string;
  parent?: string | null;
  children?: string[];
  message?: {
    id?: string;
    author?: { role?: string };
    create_time?: number | null;
    content?: {
      content_type?: string;
      parts?: Array<string | Record<string, unknown>>;
      text?: string;
    };
  } | null;
}

export interface ChatGPTExportConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number | null;
  update_time?: number | null;
  current_node?: string | null;
  mapping?: Record<string, ChatGPTExportNode>;
  project?: string;
  tags?: string[];
}

function unixToIsoOrNull(ts: number | string | null | undefined): string | null {
  if (ts === null || ts === undefined || ts === '') return null;
  if (typeof ts === 'string') {
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  if (typeof ts === 'number' && Number.isFinite(ts) && ts > 0) {
    const ms = ts < 1e12 ? ts * 1000 : ts;
    return new Date(ms).toISOString();
  }
  return null;
}

function extractChatGPTNodeText(node: ChatGPTExportNode): string {
  const content = node.message?.content;
  if (!content) return '';
  if (typeof content.text === 'string') return content.text.trim();
  if (Array.isArray(content.parts)) {
    return content.parts
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && 'text' in part && typeof part.text === 'string') {
          return part.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  return '';
}

function collectPathToLeaf(
  mapping: Record<string, ChatGPTExportNode>,
  leafId: string
): ChatGPTExportNode[] {
  const path: ChatGPTExportNode[] = [];
  const visited = new Set<string>();
  let cursor: string | null | undefined = leafId;
  while (cursor && mapping[cursor] && !visited.has(cursor)) {
    visited.add(cursor);
    path.push(mapping[cursor]);
    cursor = mapping[cursor].parent;
  }
  return path.reverse();
}

export function parseChatGPTExport(
  items: ChatGPTExportConversation[],
  options: { accountId: string; workspaceId: string }
): UpsertThreadInput[] {
  const results: UpsertThreadInput[] = [];

  for (let idx = 0; idx < items.length; idx++) {
    const item = items[idx];
    const convId =
      item.conversation_id || item.id || `chatgpt_export_${idx + 1}`;
    const title = (item.title || 'Untitled conversation').trim();
    const createdAt = unixToIsoOrNull(item.create_time);
    const updatedAt = unixToIsoOrNull(item.update_time) ?? createdAt;
    const canonicalUrl = `https://chatgpt.com/c/${convId}`;
    const mapping = item.mapping ?? {};

    // Find leaf nodes in mapping
    const allIds = Object.keys(mapping);
    const leaves = allIds.filter((id) => {
      const children = mapping[id]?.children ?? [];
      return children.length === 0;
    });

    const primaryLeaf =
      (item.current_node && mapping[item.current_node]
        ? item.current_node
        : leaves[leaves.length - 1]) ?? null;

    if (!primaryLeaf) {
      const threadKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: options.accountId,
        workspaceId: options.workspaceId,
        sourceConversationId: convId,
        branchId: 'main',
      });
      results.push({
        threadKey,
        provider: 'chatgpt',
        accountId: options.accountId,
        workspaceId: options.workspaceId,
        sourceConversationId: convId,
        branchId: 'main',
        parentBranchId: null,
        siblingBranchIds: [],
        canonicalUrl,
        title,
        createdAt,
        updatedAt,
        coverage: 'title_only',
        captureSource: 'export_import',
        project: item.project,
        tags: item.tags,
        messages: [],
      });
      continue;
    }

    const distinctLeaves = [
      primaryLeaf,
      ...leaves.filter((l) => l !== primaryLeaf),
    ];

    const branchEntries: Array<{
      branchId: string;
      leafId: string;
      messages: UpsertThreadInput['messages'];
    }> = [];

    for (let bIdx = 0; bIdx < distinctLeaves.length; bIdx++) {
      const leafId = distinctLeaves[bIdx];
      const nodes = collectPathToLeaf(mapping, leafId);
      const messages: UpsertThreadInput['messages'] = [];
      for (const n of nodes) {
        const roleRaw = n.message?.author?.role;
        if (!roleRaw || roleRaw === 'system') continue;
        const text = extractChatGPTNodeText(n);
        if (!text) continue;
        const role: 'user' | 'assistant' | 'tool' =
          roleRaw === 'user'
            ? 'user'
            : roleRaw === 'tool'
              ? 'tool'
              : 'assistant';
        messages.push({
          sourceMessageId: n.message?.id || n.id,
          role,
          content: text,
          createdAt: unixToIsoOrNull(n.message?.create_time),
          branchPath: bIdx === 0 ? 'main' : `branch_${bIdx + 1}`,
        });
      }
      if (messages.length > 0 || bIdx === 0) {
        branchEntries.push({
          branchId: bIdx === 0 ? 'main' : `branch_${bIdx + 1}`,
          leafId,
          messages,
        });
      }
    }

    const allBranchIds = branchEntries.map((b) => b.branchId);
    for (const branch of branchEntries) {
      const threadKey = buildThreadKey({
        provider: 'chatgpt',
        accountId: options.accountId,
        workspaceId: options.workspaceId,
        sourceConversationId: convId,
        branchId: branch.branchId,
      });
      results.push({
        threadKey,
        provider: 'chatgpt',
        accountId: options.accountId,
        workspaceId: options.workspaceId,
        sourceConversationId: convId,
        branchId: branch.branchId,
        parentBranchId: branch.branchId === 'main' ? null : 'main',
        siblingBranchIds: allBranchIds.filter((id) => id !== branch.branchId),
        canonicalUrl,
        title:
          branch.branchId === 'main'
            ? title
            : `${title} (${branch.branchId})`,
        createdAt,
        updatedAt,
        coverage: branch.messages.length > 0 ? 'full' : 'title_only',
        captureSource: 'export_import',
        project: item.project,
        tags: item.tags,
        messages: branch.messages,
      });
    }
  }

  return results;
}

export interface ClaudeExportConversation {
  uuid?: string;
  name?: string;
  created_at?: string | null;
  updated_at?: string | null;
  project?: string;
  tags?: string[];
  chat_messages?: Array<{
    uuid?: string;
    sender?: 'human' | 'assistant' | string;
    text?: string;
    created_at?: string | null;
  }>;
}

export function parseClaudeExport(
  items: ClaudeExportConversation[],
  options: { accountId: string; workspaceId: string }
): UpsertThreadInput[] {
  return items.map((item, idx) => {
    const convId = item.uuid || `claude_export_${idx + 1}`;
    const title = (item.name || 'Untitled Claude conversation').trim();
    const createdAt = unixToIsoOrNull(item.created_at);
    const updatedAt = unixToIsoOrNull(item.updated_at) ?? createdAt;
    const messages = (item.chat_messages ?? [])
      .filter((m) => (m.text ?? '').trim().length > 0)
      .map((m, mIdx) => ({
        sourceMessageId: m.uuid || `${convId}_m_${mIdx}`,
        role: (m.sender === 'human' ? 'user' : 'assistant') as 'user' | 'assistant',
        content: (m.text ?? '').trim(),
        createdAt: unixToIsoOrNull(m.created_at),
        branchPath: 'main',
      }));

    const threadKey = buildThreadKey({
      provider: 'claude',
      accountId: options.accountId,
      workspaceId: options.workspaceId,
      sourceConversationId: convId,
      branchId: 'main',
    });

    return {
      threadKey,
      provider: 'claude',
      accountId: options.accountId,
      workspaceId: options.workspaceId,
      sourceConversationId: convId,
      branchId: 'main',
      parentBranchId: null,
      siblingBranchIds: [],
      canonicalUrl: `https://claude.ai/chat/${convId}`,
      title,
      createdAt,
      updatedAt,
      coverage: messages.length > 0 ? 'full' : 'title_only',
      captureSource: 'export_import',
      project: item.project,
      tags: item.tags,
      messages,
    };
  });
}

export interface PortableBundle {
  format: 'threadkeeper-portable-v1';
  exportedAt: string;
  conversations: Array<{
    conversation: ConversationRecord;
    messages: MessageRecord[];
    summary: StructuredSummaryRecord | null;
  }>;
  relationships: RelationshipRecord[];
}

export async function exportPortableBundle(
  db: ThreadkeeperDB,
  options?: { includeSyntheticBenchmark?: boolean }
): Promise<PortableBundle> {
  const allConvs = await db.conversations.toArray();
  const filtered = allConvs.filter(
    (c) => options?.includeSyntheticBenchmark || !c.isSyntheticBenchmark
  );
  const conversations: PortableBundle['conversations'] = [];
  for (const conv of filtered) {
    const messages = await db.messages
      .where('threadKey')
      .equals(conv.threadKey)
      .sortBy('ordinal');
    const summary = (await db.summaries.get(conv.threadKey)) ?? null;
    conversations.push({ conversation: conv, messages, summary });
  }
  const relationships = await db.relationships.toArray();
  return {
    format: 'threadkeeper-portable-v1',
    exportedAt: new Date().toISOString(),
    conversations,
    relationships,
  };
}

export async function importPortableBundle(
  db: ThreadkeeperDB,
  bundle: PortableBundle,
  options?: { overrideAccountId?: string; overrideWorkspaceId?: string }
): Promise<{ importedCount: number; skippedTombstones: number }> {
  let importedCount = 0;
  let skippedTombstones = 0;

  for (const entry of bundle.conversations) {
    const c = entry.conversation;
    const accountId = options?.overrideAccountId ?? c.accountId;
    const workspaceId = options?.overrideWorkspaceId ?? c.workspaceId;
    const threadKey = buildThreadKey({
      provider: c.provider,
      accountId,
      workspaceId,
      sourceConversationId: c.sourceConversationId,
      branchId: c.branchId,
    });

    const res = await upsertThread(db, {
      threadKey,
      provider: c.provider,
      accountId,
      workspaceId,
      sourceConversationId: c.sourceConversationId,
      branchId: c.branchId,
      parentBranchId: c.parentBranchId,
      siblingBranchIds: c.siblingBranchIds,
      canonicalUrl: c.canonicalUrl,
      title: c.title,
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
      coverage: c.coverage,
      captureSource: 'portable_import',
      project: c.project,
      categoryLocked: c.categoryLocked,
      tags: c.tags,
      workflowState: c.workflowState,
      manualNotes: c.manualNotes,
      cloudExcluded: c.cloudExcluded,
      latestDecisionText: c.latestDecisionText,
      latestDecisionMsgIndex: c.latestDecisionMsgIndex,
      latestDecisionSpeaker: c.latestDecisionSpeaker,
      nextStepText: c.nextStepText,
      nextStepMsgIndex: c.nextStepMsgIndex,
      nextStepSpeaker: c.nextStepSpeaker,
      messages: entry.messages.map((m) => ({
        sourceMessageId: m.sourceMessageId,
        role: m.role,
        content: m.content,
        createdAt: m.createdAt,
        branchPath: m.branchPath,
      })),
    });

    if (res.status === 'skipped_tombstone') {
      skippedTombstones += 1;
    } else {
      importedCount += 1;
      if (entry.summary) {
        await db.summaries.put({
          ...entry.summary,
          threadKey,
        });
      }
    }
  }

  if (bundle.relationships?.length) {
    await db.relationships.bulkPut(bundle.relationships);
  }

  return { importedCount, skippedTombstones };
}

export function exportThreadToMarkdown(
  conv: ConversationRecord,
  messages: MessageRecord[],
  summary: StructuredSummaryRecord | null
): string {
  const lines: string[] = [];
  lines.push(`# ${getDisplayTitle(conv)}`);
  lines.push('');
  lines.push(`- **Provider**: ${conv.provider}`);
  lines.push(`- **Project / Area**: ${conv.project}${conv.categoryLocked ? ' (locked)' : ''}`);
  lines.push(`- **Workflow State**: ${conv.workflowState}`);
  lines.push(`- **Capture Coverage**: ${conv.coverage} (rev ${conv.sourceRevision})`);
  lines.push(`- **Canonical URL**: ${conv.canonicalUrl}`);
  if (conv.tags.length > 0) {
    lines.push(`- **Tags**: ${conv.tags.join(', ')}`);
  }
  lines.push('');

  if (summary) {
    lines.push('## Where you left off');
    lines.push(
      `${summary.whereYouLeftOff} _(evidence: ${summary.whereYouLeftOffMessageIndexes.map((i) => `m${i + 1}`).join(', ')})_`
    );
    lines.push('');
    lines.push('## Current status');
    lines.push(
      `${summary.currentStatus} _(evidence: ${summary.currentStatusMessageIndexes.map((i) => `m${i + 1}`).join(', ')})_`
    );
    lines.push('');
    if (summary.decisions.length > 0) {
      lines.push('## Decisions');
      for (const d of summary.decisions) {
        lines.push(
          `- [${d.speaker === 'user_committed' ? 'Committed' : 'Suggested'} · ${d.messageIndexes.map((i) => `m${i + 1}`).join(', ')}] ${d.text}`
        );
      }
      lines.push('');
    }
    if (summary.openQuestions.length > 0) {
      lines.push('## Open questions');
      for (const q of summary.openQuestions) {
        lines.push(
          `- [${q.messageIndexes.map((i) => `m${i + 1}`).join(', ')}] ${q.text}`
        );
      }
      lines.push('');
    }
    if (summary.actionItems.length > 0) {
      lines.push('## Action items');
      for (const a of summary.actionItems) {
        lines.push(
          `- [${a.messageIndexes.map((i) => `m${i + 1}`).join(', ')}] ${a.text}`
        );
      }
      lines.push('');
    }
  }

  if (conv.manualNotes.trim().length > 0) {
    lines.push('## Notes');
    lines.push(conv.manualNotes.trim());
    lines.push('');
  }

  lines.push('## Captured Transcript');
  for (const m of messages) {
    lines.push(`### [m${m.ordinal + 1}] ${m.role.toUpperCase()}`);
    lines.push(m.content);
    lines.push('');
  }

  return lines.join('\n');
}

export interface DomExtractionResult {
  provider: ProviderId;
  sourceConversationId: string;
  branchId: string;
  canonicalUrl: string;
  title: string;
  coverage: 'partial' | 'title_only';
  messages: UpsertThreadInput['messages'];
}

export function detectProviderFromUrl(url: string): ProviderId | null {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    if (host.includes('chatgpt.com') || host.includes('chat.openai.com')) {
      return 'chatgpt';
    }
    if (host.includes('claude.ai')) {
      return 'claude';
    }
    if (parsed.searchParams.get('tk_provider') === 'chatgpt') return 'chatgpt';
    if (parsed.searchParams.get('tk_provider') === 'claude') return 'claude';
    return null;
  } catch {
    return null;
  }
}

export function extractConversationIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    const chatgptMatch = parsed.pathname.match(/\/c\/([a-zA-Z0-9_-]+)/);
    if (chatgptMatch) return chatgptMatch[1];
    const claudeMatch = parsed.pathname.match(/\/chat\/([a-zA-Z0-9_-]+)/);
    if (claudeMatch) return claudeMatch[1];
    const paramId = parsed.searchParams.get('tk_conv_id');
    if (paramId) return paramId;
    return null;
  } catch {
    return null;
  }
}

export function extractVisibleDomConversation(
  doc: Document,
  locationHref: string
): DomExtractionResult | null {
  const providerAttr = doc.documentElement.getAttribute('data-tk-provider');
  const provider: ProviderId | null =
    providerAttr === 'chatgpt' || providerAttr === 'claude'
      ? providerAttr
      : detectProviderFromUrl(locationHref);

  if (!provider) return null;

  const convIdAttr =
    doc.documentElement.getAttribute('data-tk-conversation-id') ||
    doc.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id');
  const sourceConversationId =
    convIdAttr || extractConversationIdFromUrl(locationHref);

  if (!sourceConversationId) return null;

  const branchAttr =
    doc.querySelector('[data-branch-id]')?.getAttribute('data-branch-id') ||
    doc.documentElement.getAttribute('data-tk-branch-id') ||
    'main';
  const branchId = branchAttr.trim() || 'main';

  const rawTitle =
    doc.querySelector('[data-conversation-title]')?.textContent ||
    doc.title.replace(/\s*[-|]\s*(ChatGPT|Claude).*$/i, '') ||
    'Untitled conversation';
  const title = rawTitle.trim() || 'Untitled conversation';

  // Select only completed turn elements, explicitly excluding composer inputs and active streaming nodes
  const turnElements = Array.from(
    doc.querySelectorAll(
      '[data-message-author-role], [data-testid^="conversation-turn"], [data-tk-message-role]'
    )
  );

  const messages: UpsertThreadInput['messages'] = [];

  for (let i = 0; i < turnElements.length; i++) {
    const el = turnElements[i];

    // Never capture inside a composer form or contenteditable draft
    if (
      el.closest('form') ||
      el.closest('[data-testid="composer"]') ||
      el.getAttribute('contenteditable') === 'true'
    ) {
      continue;
    }

    // Never capture an in-progress streaming response
    if (
      el.getAttribute('data-streaming') === 'true' ||
      el.classList.contains('result-streaming') ||
      el.querySelector('[data-streaming="true"], .result-streaming')
    ) {
      continue;
    }

    const roleAttr =
      el.getAttribute('data-message-author-role') ||
      el.getAttribute('data-tk-message-role') ||
      el
        .querySelector('[data-message-author-role]')
        ?.getAttribute('data-message-author-role') ||
      (el.classList.contains('font-user-message') ? 'user' : 'assistant');

    const role: 'user' | 'assistant' | 'tool' =
      roleAttr === 'user' || roleAttr === 'human'
        ? 'user'
        : roleAttr === 'tool'
          ? 'tool'
          : 'assistant';

    const sourceMessageId =
      el.getAttribute('data-message-id') ||
      el.querySelector('[data-message-id]')?.getAttribute('data-message-id') ||
      `${sourceConversationId}_${branchId}_m_${i}`;

    // Clone or read text excluding button/toolbar children
    const bodyNode = el.querySelector('[data-message-content]') ?? el;
    const text = (bodyNode.textContent ?? '').trim();
    if (!text) continue;

    const timeEl = el.querySelector('time[datetime]');
    const explicitTs =
      el.getAttribute('data-message-timestamp') ||
      timeEl?.getAttribute('datetime') ||
      null;

    messages.push({
      sourceMessageId,
      role,
      content: text,
      createdAt: unixToIsoOrNull(explicitTs),
      branchPath: branchId,
    });
  }

  return {
    provider,
    sourceConversationId,
    branchId,
    canonicalUrl: locationHref,
    title,
    coverage: messages.length > 0 ? 'partial' : 'title_only',
    messages,
  };
}
