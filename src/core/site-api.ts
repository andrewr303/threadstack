import type { UpsertThreadInput } from './db.js';

/**
 * Parsers for the conversation data ChatGPT and Claude send to their own web apps.
 *
 * Both sites load a conversation as one JSON document, complete and with the site's own message
 * ids, timestamps and model names. Reading that is far more reliable than scraping rendered
 * markup, which changes with every redesign and only covers what is on screen.
 *
 * These endpoints are not documented or supported by the providers. The shapes below follow the
 * providers' own data exports (which the repo already parses) and open-source exporters, and
 * every field is validated at runtime because the data is untrusted: anything unexpected makes
 * the parser return null or skip the message, never throw.
 */

export type SiteProvider = 'chatgpt' | 'claude';

export interface SiteConversation {
  provider: SiteProvider;
  sourceConversationId: string;
  canonicalUrl: string;
  title: string;
  createdAt: string | null;
  updatedAt: string | null;
  messages: UpsertThreadInput['messages'];
  modelSlug: string | null;
  /** The site's id for the project the conversation belongs to; the name is not in this document. */
  providerProjectId: string | null;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Rec) : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** ISO string from epoch seconds, epoch milliseconds, or a date string. */
export function toIso(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  }
  if (typeof value === 'string' && value.trim()) {
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

function pathOf(url: string): string | null {
  try {
    return new URL(url, 'https://example.invalid').pathname;
  } catch {
    return null;
  }
}

/** GET /backend-api/conversation/<uuid>: one conversation. Sub-resources (…/textdocs, …/stream_status) are not. */
export function chatGptConversationIdFromApiUrl(url: string): string | null {
  const m = pathOf(url)?.match(/^\/backend-api\/conversation\/([0-9a-f-]{36})$/i);
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}

/** GET /api/organizations/<org>/chat_conversations/<uuid>: one conversation. */
export function claudeConversationFromApiUrl(url: string): { orgId: string; conversationId: string } | null {
  const m = pathOf(url)?.match(/^\/api\/organizations\/([0-9a-f-]{36})\/chat_conversations\/([0-9a-f-]{36})$/i);
  return m && UUID.test(m[1]) && UUID.test(m[2]) ? { orgId: m[1].toLowerCase(), conversationId: m[2].toLowerCase() } : null;
}

export function chatGptCanonicalUrl(conversationId: string): string {
  return `https://chatgpt.com/c/${conversationId}`;
}

export function claudeCanonicalUrl(conversationId: string): string {
  return `https://claude.ai/chat/${conversationId}`;
}

// ---------------------------------------------------------------------------
// ChatGPT
// ---------------------------------------------------------------------------

/**
 * ChatGPT marks citations, entity chips and similar inline widgets with private-use characters:
 *  starts one,  ends it,  separates its fields. They are widget markup, not text.
 */
export function cleanChatGptText(text: string): string {
  return text
    .replace(/entity(\[[^]*\])/g, (_m, json: string) => {
      try {
        const parsed: unknown = JSON.parse(json);
        return Array.isArray(parsed) && typeof parsed[1] === 'string' ? parsed[1] : '';
      } catch {
        return '';
      }
    })
    .replace(/[^]*/g, '')
    .replace(/[-]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Content types that are text a person reads. Reasoning, tool output and memory context are not. */
const CHATGPT_TEXT_TYPES = new Set(['text', 'multimodal_text', 'code']);

function chatGptNodeText(message: Rec): string {
  const content = rec(message.content);
  if (!content) return '';
  const type = str(content.content_type) ?? 'text';
  if (!CHATGPT_TEXT_TYPES.has(type)) return '';
  if (type === 'code') {
    // Code the assistant sends to a tool (python, browser) is addressed to it, not to the reader.
    return typeof content.text === 'string' ? content.text : '';
  }
  const parts = content.parts;
  if (Array.isArray(parts)) {
    return parts
      .map((p) => (typeof p === 'string' ? p : (str(rec(p)?.text) ?? '')))
      .filter(Boolean)
      .join('\n\n');
  }
  return typeof content.text === 'string' ? content.text : '';
}

/** The active path from the root to `current_node`; without one, the newest leaf's path. */
function chatGptActivePath(mapping: Rec, currentNode: string | null): Rec[] {
  let cursor = currentNode && rec(mapping[currentNode]) ? currentNode : null;
  if (!cursor) {
    let best = -1;
    for (const [id, raw] of Object.entries(mapping)) {
      const node = rec(raw);
      if (!node) continue;
      const children = node.children;
      if (Array.isArray(children) && children.length > 0) continue;
      const t = typeof rec(node.message)?.create_time === 'number' ? (rec(node.message)?.create_time as number) : 0;
      if (t >= best) {
        best = t;
        cursor = id;
      }
    }
  }
  const path: Rec[] = [];
  const seen = new Set<string>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const node = rec(mapping[cursor]);
    if (!node) break;
    path.push(node);
    cursor = str(node.parent);
  }
  return path.reverse();
}

export function parseChatGptConversation(json: unknown, hintedId?: string | null): SiteConversation | null {
  const root = rec(json);
  const mapping = rec(root?.mapping);
  if (!root || !mapping) return null;
  const rawId = str(root.conversation_id) ?? str(root.id) ?? hintedId ?? null;
  if (!rawId || !SAFE_ID.test(rawId)) return null;
  const sourceConversationId = rawId.toLowerCase();

  const messages: UpsertThreadInput['messages'] = [];
  let modelSlug: string | null = null;
  const used = new Set<string>();

  for (const node of chatGptActivePath(mapping, str(root.current_node))) {
    const message = rec(node.message);
    if (!message) continue;
    const role = str(rec(message.author)?.role);
    if (role !== 'user' && role !== 'assistant') continue;
    const metadata = rec(message.metadata);
    if (metadata?.is_visually_hidden_from_conversation === true) continue;
    if (role === 'assistant') {
      const recipient = str(message.recipient);
      if (recipient && recipient !== 'all') continue;
      if (str(message.channel) === 'analysis') continue;
    }
    const text = cleanChatGptText(chatGptNodeText(message));
    if (!text) continue;
    let id = str(message.id) ?? str(node.id) ?? `${sourceConversationId}_main_m_${messages.length}`;
    for (let n = 2; used.has(id); n++) id = `${id}#${n}`;
    used.add(id);
    if (role === 'assistant') modelSlug = str(metadata?.model_slug) ?? modelSlug;
    messages.push({
      sourceMessageId: id,
      role,
      content: text,
      createdAt: toIso(message.create_time),
      branchPath: 'main',
    });
  }

  return {
    provider: 'chatgpt',
    sourceConversationId,
    canonicalUrl: chatGptCanonicalUrl(sourceConversationId),
    title: (str(root.title) ?? '').trim(),
    createdAt: toIso(root.create_time),
    updatedAt: toIso(root.update_time),
    messages,
    modelSlug: modelSlug ?? str(root.default_model_slug),
    providerProjectId: str(root.gizmo_id),
  };
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/** Claude's sentinel parent id for the first message of a conversation. */
const CLAUDE_ROOT_PARENT = '00000000-0000-4000-8000-000000000000';

function claudeMessageText(message: Rec): string {
  const content = message.content;
  if (Array.isArray(content)) {
    const text = content
      .map((c) => {
        const item = rec(c);
        return item && item.type === 'text' ? (str(item.text) ?? '') : '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
    if (text) return text;
  }
  return typeof message.text === 'string' ? message.text.trim() : '';
}

/** The active branch: the chain from `current_leaf_message_uuid` to the root, else order of appearance. */
function claudeActiveMessages(all: Rec[], leaf: string | null): Rec[] {
  const byId = new Map<string, Rec>();
  for (const m of all) {
    const id = str(m.uuid);
    if (id) byId.set(id, m);
  }
  const linked = all.some((m) => str(m.parent_message_uuid));
  if (leaf && linked && byId.has(leaf)) {
    const chain: Rec[] = [];
    const seen = new Set<string>();
    let cursor: string | null = leaf;
    while (cursor && cursor !== CLAUDE_ROOT_PARENT && !seen.has(cursor)) {
      seen.add(cursor);
      const m = byId.get(cursor);
      if (!m) break;
      chain.push(m);
      cursor = str(m.parent_message_uuid);
    }
    return chain.reverse();
  }
  return [...all].sort((a, b) => {
    const ai = typeof a.index === 'number' ? a.index : Number.MAX_SAFE_INTEGER;
    const bi = typeof b.index === 'number' ? b.index : Number.MAX_SAFE_INTEGER;
    return ai - bi;
  });
}

export function parseClaudeConversation(json: unknown, hintedId?: string | null): SiteConversation | null {
  const root = rec(json);
  const list = root?.chat_messages;
  if (!root || !Array.isArray(list)) return null;
  const rawId = str(root.uuid) ?? hintedId ?? null;
  if (!rawId || !SAFE_ID.test(rawId)) return null;
  const sourceConversationId = rawId.toLowerCase();

  const messages: UpsertThreadInput['messages'] = [];
  const used = new Set<string>();
  for (const m of claudeActiveMessages(list.map(rec).filter((x): x is Rec => x !== null), str(root.current_leaf_message_uuid))) {
    const sender = str(m.sender);
    if (sender !== 'human' && sender !== 'assistant') continue;
    const text = claudeMessageText(m);
    if (!text) continue;
    let id = str(m.uuid) ?? `${sourceConversationId}_main_m_${messages.length}`;
    for (let n = 2; used.has(id); n++) id = `${id}#${n}`;
    used.add(id);
    messages.push({
      sourceMessageId: id,
      role: sender === 'human' ? 'user' : 'assistant',
      content: text,
      createdAt: toIso(m.created_at),
      branchPath: 'main',
    });
  }

  return {
    provider: 'claude',
    sourceConversationId,
    canonicalUrl: claudeCanonicalUrl(sourceConversationId),
    title: (str(root.name) ?? '').trim(),
    createdAt: toIso(root.created_at),
    updatedAt: toIso(root.updated_at),
    messages,
    modelSlug: str(root.model),
    providerProjectId: str(root.project_uuid),
  };
}

/** Parse whichever site's conversation document this is. */
export function parseSiteConversation(provider: SiteProvider, json: unknown, hintedId?: string | null): SiteConversation | null {
  return provider === 'chatgpt' ? parseChatGptConversation(json, hintedId) : parseClaudeConversation(json, hintedId);
}

/** The title a stored thread should carry: the site's, else the first message's opening words. */
export function siteConversationTitle(conv: SiteConversation): string {
  if (conv.title) return conv.title;
  const first = conv.messages.find((m) => m.role === 'user')?.content ?? '';
  const derived = first.replace(/\s+/g, ' ').slice(0, 80).trim();
  return derived || 'Untitled conversation';
}

// ---------------------------------------------------------------------------
// Page-world → content-script message
// ---------------------------------------------------------------------------

export const SITE_DATA_MESSAGE_SOURCE = 'threadkeeper-site-data';

export interface SiteDataMessage {
  source: typeof SITE_DATA_MESSAGE_SOURCE;
  provider: SiteProvider;
  conversationId: string;
  json: unknown;
}

/** Which site's conversation request this URL is, for the page-world observer. */
export function matchSiteConversationRequest(
  hostname: string,
  url: string
): { provider: SiteProvider; conversationId: string } | null {
  const host = hostname.toLowerCase();
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') {
    const id = chatGptConversationIdFromApiUrl(url);
    return id ? { provider: 'chatgpt', conversationId: id } : null;
  }
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    const found = claudeConversationFromApiUrl(url);
    return found ? { provider: 'claude', conversationId: found.conversationId } : null;
  }
  return null;
}

/** Validate a window message from the page-world observer. Anything else is ignored. */
export function parseSiteDataMessage(data: unknown): SiteDataMessage | null {
  const m = rec(data);
  if (!m || m.source !== SITE_DATA_MESSAGE_SOURCE) return null;
  const provider = m.provider;
  const id = m.conversationId;
  if ((provider !== 'chatgpt' && provider !== 'claude') || typeof id !== 'string' || !SAFE_ID.test(id)) return null;
  if (rec(m.json) === null) return null;
  return { source: SITE_DATA_MESSAGE_SOURCE, provider, conversationId: id.toLowerCase(), json: m.json };
}

// ---------------------------------------------------------------------------
// Validation of a conversation that crossed a message boundary
// ---------------------------------------------------------------------------

const MAX_MESSAGES = 20_000;
const MAX_MESSAGE_CHARS = 2_000_000;

/**
 * A SiteConversation received from a content script, rebuilt field by field. The content script
 * runs inside a web page's process; the service worker trusts none of its shape.
 */
export function validateSiteConversation(value: unknown): SiteConversation | null {
  const v = rec(value);
  if (!v) return null;
  const provider = v.provider;
  const id = v.sourceConversationId;
  if ((provider !== 'chatgpt' && provider !== 'claude') || typeof id !== 'string' || !SAFE_ID.test(id)) return null;
  if (!Array.isArray(v.messages) || v.messages.length > MAX_MESSAGES) return null;
  const messages: UpsertThreadInput['messages'] = [];
  for (const raw of v.messages) {
    const m = rec(raw);
    if (!m) return null;
    const role = m.role;
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof m.sourceMessageId !== 'string' || m.sourceMessageId.length === 0 || m.sourceMessageId.length > 200) return null;
    if (typeof m.content !== 'string' || m.content.length === 0 || m.content.length > MAX_MESSAGE_CHARS) return null;
    messages.push({
      sourceMessageId: m.sourceMessageId,
      role,
      content: m.content,
      createdAt: toIso(m.createdAt),
      branchPath: 'main',
    });
  }
  return {
    provider,
    sourceConversationId: id.toLowerCase(),
    canonicalUrl: provider === 'chatgpt' ? chatGptCanonicalUrl(id.toLowerCase()) : claudeCanonicalUrl(id.toLowerCase()),
    title: typeof v.title === 'string' ? v.title.slice(0, 300) : '',
    createdAt: toIso(v.createdAt),
    updatedAt: toIso(v.updatedAt),
    messages,
    modelSlug: typeof v.modelSlug === 'string' ? v.modelSlug.slice(0, 100) : null,
    providerProjectId: typeof v.providerProjectId === 'string' ? v.providerProjectId.slice(0, 100) : null,
  };
}
