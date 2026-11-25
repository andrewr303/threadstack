// Grok inside X (x.com/i/grok) has no known DOM selectors. X's own page loads every
// conversation through the GrokConversationItemsByRestId GraphQL query, so ThreadStack reads
// those responses passively (src/entrypoints/grok-x-main.ts, MAIN world) and parses them here.
// The isolated content script re-validates the posted result before anything is stored.
// This module is bundled into the page's MAIN world: keep it dependency-free and small.

export const GROK_X_ITEMS_OPERATION = 'GrokConversationItemsByRestId';
export const GROK_X_MESSAGE_SOURCE = 'threadkeeper-grok-x';

export interface GrokXMessage {
  /** X's chat item id when present, otherwise a content hash; unique within one response. */
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: string | null;
}

/** What the MAIN-world script posts to the isolated content script. */
export interface GrokXCaptureMessage {
  source: typeof GROK_X_MESSAGE_SOURCE;
  /** variables.restId of the request (the conversation id), or null when it was not found. */
  restId: string | null;
  /** Oldest first. */
  messages: GrokXMessage[];
}

const REST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const MAX_MESSAGES = 5000;
const MAX_TEXT_LENGTH = 500_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Only these requests are ever parsed. */
export function isGrokXItemsUrl(url: string): boolean {
  return url.includes(GROK_X_ITEMS_OPERATION);
}

function restIdFromVariables(variables: unknown): string | null {
  let vars = variables;
  if (typeof vars === 'string') {
    try {
      vars = JSON.parse(vars);
    } catch {
      return null;
    }
  }
  if (!isRecord(vars)) return null;
  const id = vars.restId;
  return typeof id === 'string' && REST_ID_RE.test(id) ? id : null;
}

/** Conversation id of a GrokConversationItemsByRestId request: variables.restId in the URL query or JSON body. */
export function extractGrokXRestId(url: string, body?: unknown, base = 'https://x.com'): string | null {
  try {
    const fromQuery = restIdFromVariables(new URL(url, base).searchParams.get('variables'));
    if (fromQuery) return fromQuery;
  } catch {
    // not a URL
  }
  if (typeof body !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(body);
    return isRecord(parsed) ? restIdFromVariables(parsed.variables) : null;
  } catch {
    return null;
  }
}

/** Drop Grok's inline render directives (citations, cards): <grok:render …>…</grok:render>. */
export function stripGrokRender(text: string): string {
  return text
    .replace(/<grok:render\b[^>]*>[\s\S]*?<\/grok:render>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function roleOf(item: Record<string, unknown>): GrokXMessage['role'] | null {
  const raw =
    typeof item.sender_type === 'string'
      ? item.sender_type
      : typeof item.sender === 'string'
        ? item.sender
        : '';
  const sender = raw.trim();
  if (/^(user|human)$/i.test(sender)) return 'user';
  if (/^(agent|grok|assistant)$/i.test(sender)) return 'assistant';
  return null;
}

/** FNV-1a, enough to give an id-less item a key that survives re-reads and pagination. */
function hashText(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${input.length.toString(36)}${(h >>> 0).toString(36)}`;
}

/**
 * Parse one GrokConversationItemsByRestId response into messages, oldest first.
 * Items are newest first at data.grokConversationItemsByRestId.items (snake_case variant
 * accepted); the role comes from sender_type / sender and the text from message.
 */
export function parseGrokXItems(json: unknown): GrokXMessage[] {
  if (!isRecord(json) || !isRecord(json.data)) return [];
  const container =
    json.data.grokConversationItemsByRestId ?? json.data.grok_conversation_items_by_rest_id;
  if (!isRecord(container) || !Array.isArray(container.items)) return [];
  const items: unknown[] = container.items;
  const out: GrokXMessage[] = [];
  const seen = new Map<string, number>();
  for (let i = items.length - 1; i >= 0 && out.length < MAX_MESSAGES; i--) {
    const item = items[i];
    // is_partial (unverified field): never store a reply that is still being written.
    if (!isRecord(item) || item.is_partial === true) continue;
    const role = roleOf(item);
    const text =
      typeof item.message === 'string' ? stripGrokRender(item.message).slice(0, MAX_TEXT_LENGTH) : '';
    if (!role || !text) continue;
    // chat_item_id / created_at_ms are optional and unverified; content hash otherwise.
    const itemId =
      typeof item.chat_item_id === 'string' && MESSAGE_ID_RE.test(item.chat_item_id)
        ? item.chat_item_id
        : `h${hashText(`${role}\n${text}`)}`;
    const n = (seen.get(itemId) ?? 0) + 1;
    seen.set(itemId, n);
    const createdMs = item.created_at_ms;
    out.push({
      id: n > 1 ? `${itemId}_${n}` : itemId,
      role,
      text,
      createdAt:
        typeof createdMs === 'number' && Number.isFinite(createdMs) && createdMs > 0
          ? new Date(createdMs).toISOString()
          : null,
    });
  }
  return out;
}

/**
 * Narrow a window message to a Grok-on-X capture. Any page script can post to the window,
 * so everything is checked; one malformed message rejects the whole payload.
 */
export function parseGrokXCaptureMessage(data: unknown): GrokXCaptureMessage | null {
  if (!isRecord(data) || data.source !== GROK_X_MESSAGE_SOURCE) return null;
  const rawRestId = data.restId;
  let restId: string | null = null;
  if (rawRestId !== null && rawRestId !== undefined) {
    if (typeof rawRestId !== 'string' || !REST_ID_RE.test(rawRestId)) return null;
    restId = rawRestId;
  }
  const rawMessages = data.messages;
  if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > MAX_MESSAGES) {
    return null;
  }
  const messages: GrokXMessage[] = [];
  const ids = new Set<string>();
  for (const raw of rawMessages as unknown[]) {
    if (!isRecord(raw)) return null;
    const { id, role, text, createdAt } = raw;
    if (typeof id !== 'string' || !MESSAGE_ID_RE.test(id) || ids.has(id)) return null;
    if (role !== 'user' && role !== 'assistant') return null;
    if (typeof text !== 'string' || text.trim() === '' || text.length > MAX_TEXT_LENGTH) return null;
    if (createdAt !== null && (typeof createdAt !== 'string' || !Number.isFinite(Date.parse(createdAt)))) {
      return null;
    }
    ids.add(id);
    messages.push({ id, role, text, createdAt });
  }
  return { source: GROK_X_MESSAGE_SOURCE, restId, messages };
}

/**
 * Merge one response into what is already known for a conversation. X pages long
 * conversations: a response that shares no message with what is known is an older page and
 * goes in front; an overlapping one replaces its range. When every message carries a
 * timestamp, the timestamps decide the order.
 */
export function mergeGrokXMessages(existing: GrokXMessage[], incoming: GrokXMessage[]): GrokXMessage[] {
  if (existing.length === 0) return incoming.slice();
  const incomingIds = new Set(incoming.map((m) => m.id));
  const overlaps = existing.map((m, i) => (incomingIds.has(m.id) ? i : -1)).filter((i) => i >= 0);
  // Content-hash ids can repeat across pages ("hi" twice), so a shared id is an overlap only when the
  // two pages line up from there on; otherwise the incoming page is a separate, older page.
  let aligned = overlaps.length > 0;
  if (aligned) {
    const j0 = incoming.findIndex((m) => m.id === existing[overlaps[0]].id);
    for (let k = 0; overlaps[0] + k < existing.length && j0 + k < incoming.length; k++) {
      if (existing[overlaps[0] + k].id !== incoming[j0 + k].id) {
        aligned = false;
        break;
      }
    }
  }
  const merged =
    !aligned
      ? [...incoming, ...existing]
      : [
          ...existing.slice(0, overlaps[0]),
          ...incoming,
          ...existing.slice(overlaps[overlaps.length - 1] + 1).filter((m) => !incomingIds.has(m.id)),
        ];
  if (merged.every((m) => m.createdAt)) {
    return merged
      .map((m, i) => ({ m, i, t: Date.parse(m.createdAt ?? '') }))
      .sort((a, b) => a.t - b.t || a.i - b.i)
      .map(({ m }) => m);
  }
  return merged;
}
