import type { MessageRecord } from './schema.js';

/**
 * How a captured set of messages is folded into what is already stored.
 *
 * Two kinds of capture reach a thread:
 * - authoritative snapshots (exports, history sync, the site's own conversation data) hold the
 *   whole conversation and replace what was stored;
 * - DOM captures see only what the page has rendered (a window of a virtualized list, or the
 *   turns that finished since), so they are merged by message identity instead.
 */

export interface IncomingMessage {
  sourceMessageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string | null;
  branchPath?: string;
}

export interface StoredMessage {
  sourceMessageId: string;
  role: MessageRecord['role'];
  content: string;
  createdAt: string | null;
  branchPath: string;
}

export interface MergedMessage {
  sourceMessageId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  createdAt: string | null;
  branchPath?: string;
}

/** Message ids DOM capture assigns when the page exposes no id of its own. */
export const POSITIONAL_MESSAGE_ID = /_m_\d+$/;

/** Containment shorter than this is too weak to say two messages are the same. */
const MIN_CONTAINED_CHARS = 24;

/** Above this many pairs the content pass is skipped; ids alone anchor huge threads. */
const MAX_CONTENT_PAIRING_WORK = 400_000;

/**
 * Letters and digits only, lowercased: rendered text and the markdown it came from
 * ("**bold** text" vs "bold text") compare equal.
 */
function normalizeForMatch(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Same message, allowing for markup differences and a stripped thinking block. */
export function sameMessageText(a: string, b: string): boolean {
  const na = normalizeForMatch(a);
  const nb = normalizeForMatch(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  return short.length >= MIN_CONTAINED_CHARS && long.includes(short);
}

/**
 * Pair stored messages with an incoming partial capture, by stored index.
 *
 * Older captures used positional ids (<conv>_<branch>_m_<i>); newer ones key
 * messages by the site's own id and also clean the text (thinking blocks
 * removed, answer instead of reasoning). Without pairing, the first recapture
 * after that switch stores those messages twice. Passes, most certain first:
 * the same id; a positional message and a keyed one with the same role and
 * text; the same role where one text contains the other; and finally, between
 * two already-paired messages, the next positional message of the same role.
 * A keyed message with no paired message before it is never guessed, because
 * a visible window at the end of a long thread would otherwise overwrite an
 * older message.
 */
export function pairStoredWithIncoming(
  stored: Array<Pick<MessageRecord, 'sourceMessageId' | 'role' | 'content'>>,
  incoming: IncomingMessage[]
): Map<number, IncomingMessage> {
  const pairs = new Map<number, IncomingMessage>();
  const used = new Set<string>();
  const byId = new Map(incoming.map((m) => [m.sourceMessageId, m]));
  const isPositional = (id: string) => POSITIONAL_MESSAGE_ID.test(id);
  const pair = (i: number, m: IncomingMessage) => {
    pairs.set(i, m);
    used.add(m.sourceMessageId);
  };

  stored.forEach((prev, i) => {
    const m = byId.get(prev.sourceMessageId);
    if (m && !used.has(m.sourceMessageId)) pair(i, m);
  });

  const keyed = incoming.filter((m) => !isPositional(m.sourceMessageId));
  const textMatch = (a: string, b: string) => a === b;
  const containMatch = (a: string, b: string) => {
    const [short, long] = a.length <= b.length ? [a, b] : [b, a];
    return short.length >= MIN_CONTAINED_CHARS && long.includes(short);
  };
  for (const matches of [textMatch, containMatch]) {
    stored.forEach((prev, i) => {
      if (pairs.has(i) || !isPositional(prev.sourceMessageId)) return;
      const text = prev.content.trim();
      const m = keyed.find((k) => !used.has(k.sourceMessageId) && k.role === prev.role && matches(text, k.content.trim()));
      if (m) pair(i, m);
    });
  }

  const storedIndexOf = new Map(Array.from(pairs, ([i, m]) => [m.sourceMessageId, i]));
  let anchor: number | null = null;
  for (const m of incoming) {
    const at = storedIndexOf.get(m.sourceMessageId);
    if (at !== undefined) {
      anchor = at;
      continue;
    }
    if (anchor === null || isPositional(m.sourceMessageId) || used.has(m.sourceMessageId)) continue;
    for (let i = anchor + 1; i < stored.length && !pairs.has(i); i++) {
      if (isPositional(stored[i].sourceMessageId) && stored[i].role === m.role) {
        pair(i, m);
        storedIndexOf.set(m.sourceMessageId, i);
        anchor = i;
        break;
      }
    }
  }
  return pairs;
}

/**
 * Stored index → incoming index, as an order-preserving set of anchors.
 *
 * Starts from pairStoredWithIncoming, then
 * 1. drops pairs that only share a positional id (the same "_m_3" names different messages in
 *    different windows) unless their role and text agree, and any pair across roles;
 * 2. keeps the longest run that is increasing on both sides, so a crossing pair cannot scramble order;
 * 3. fills the gaps between anchors by role and text, which is how a site whose DOM ids differ from
 *    its data ids (Claude) still lines up with a snapshot.
 */
export function alignMessages(stored: StoredMessage[], incoming: IncomingMessage[]): Map<number, number> {
  const incomingIndex = new Map(incoming.map((m, j) => [m.sourceMessageId, j]));
  const idPairs = pairStoredWithIncoming(stored, incoming);

  const pairs: Array<[number, number]> = [];
  for (const [i, m] of idPairs) {
    const j = incomingIndex.get(m.sourceMessageId);
    if (j === undefined) continue;
    const prev = stored[i];
    if (prev.role !== m.role) continue;
    const weak = POSITIONAL_MESSAGE_ID.test(prev.sourceMessageId) && POSITIONAL_MESSAGE_ID.test(m.sourceMessageId);
    if (weak && !sameMessageText(prev.content, m.content)) continue;
    pairs.push([i, j]);
  }
  pairs.sort((a, b) => a[0] - b[0]);

  const anchors: Array<[number, number]> = [];
  let lastJ = -1;
  for (const [i, j] of pairs) {
    if (j > lastJ) {
      anchors.push([i, j]);
      lastJ = j;
    }
  }

  const aligned = new Map<number, number>(anchors);
  if (stored.length * incoming.length > MAX_CONTENT_PAIRING_WORK) return aligned;

  const bounds: Array<[number, number]> = [[-1, -1], ...anchors, [stored.length, incoming.length]];
  for (let g = 0; g + 1 < bounds.length; g++) {
    const [i0, j0] = bounds[g];
    const [i1, j1] = bounds[g + 1];
    let jCursor = j0 + 1;
    for (let i = i0 + 1; i < i1; i++) {
      for (let j = jCursor; j < j1; j++) {
        if (stored[i].role === incoming[j].role && sameMessageText(stored[i].content, incoming[j].content)) {
          aligned.set(i, j);
          jCursor = j + 1;
          break;
        }
      }
    }
  }
  return aligned;
}

export interface MergeOptions {
  /**
   * The stored copy came from a snapshot of the whole conversation (export, history sync, the
   * site's own data). Its text is kept over a re-rendering, and nothing in it is dropped
   * because the page did not show it.
   */
  authoritativeStored: boolean;
}

export interface MergeResult {
  messages: MergedMessage[];
  /** At least one message lined up, so the result continues the stored conversation. */
  anchored: boolean;
}

const asMerged = (m: StoredMessage): MergedMessage => ({
  sourceMessageId: m.sourceMessageId,
  role: m.role,
  content: m.content,
  createdAt: m.createdAt,
  branchPath: m.branchPath,
});

/**
 * Fold a DOM capture (a window of the conversation) into the stored messages.
 *
 * Messages that line up are refreshed (or kept, for an authoritative copy); messages the window
 * did not show are kept in place; messages after the last match that the window does show are
 * new, and replace whatever stored tail they contradict (a regenerated or edited reply).
 * Without a single match there is nothing to anchor on: a shorter capture adds to the stored
 * messages, a longer one replaces them.
 */
export function mergeCapturedMessages(
  stored: StoredMessage[],
  incoming: IncomingMessage[],
  options: MergeOptions
): MergeResult {
  const toNew = (m: IncomingMessage, fallbackBranch?: string): MergedMessage => ({
    sourceMessageId: m.sourceMessageId,
    role: m.role,
    content: m.content,
    createdAt: m.createdAt,
    branchPath: m.branchPath ?? fallbackBranch,
  });

  const aligned = alignMessages(stored, incoming);
  if (aligned.size === 0) {
    const keepStored = options.authoritativeStored ? stored.length >= incoming.length : stored.length > incoming.length;
    return keepStored
      ? { messages: [...stored.map(asMerged), ...incoming.map((m) => toNew(m))], anchored: false }
      : { messages: incoming.map((m) => toNew(m)), anchored: false };
  }

  const pairedByIncoming = new Map<number, number>(Array.from(aligned, ([i, j]) => [j, i]));
  const storedIdx = Array.from(aligned.keys());
  const first = Math.min(...storedIdx);
  const last = Math.max(...storedIdx);
  const lastJ = Math.max(...Array.from(aligned.values()));
  const newAfterLast = incoming.some((_, j) => j > lastJ && !pairedByIncoming.has(j));

  const out: MergedMessage[] = [];
  let si = 0;
  const flushStoredBefore = (limit: number) => {
    for (; si < limit; si++) {
      const inWindow = si > first && si < last;
      // Before the first match and between matches the stored copy is kept when it is a snapshot;
      // a DOM copy drops what the visible window skipped over (a regenerated reply).
      if (si < first || !inWindow || options.authoritativeStored) out.push(asMerged(stored[si]));
    }
  };

  flushStoredBefore(first);
  for (let j = 0; j < incoming.length; j++) {
    const i = pairedByIncoming.get(j);
    if (i === undefined) {
      out.push(toNew(incoming[j]));
      continue;
    }
    flushStoredBefore(i);
    const prev = stored[i];
    const inc = incoming[j];
    out.push(
      options.authoritativeStored
        ? { ...asMerged(prev), createdAt: prev.createdAt ?? inc.createdAt }
        : {
            sourceMessageId: inc.sourceMessageId,
            role: inc.role,
            content: inc.content,
            createdAt: inc.createdAt ?? prev.createdAt,
            branchPath: inc.branchPath ?? prev.branchPath,
          }
    );
    si = i + 1;
  }
  // Stored messages after the last match: kept unless the page shows something newer in their place.
  if (!newAfterLast) for (; si < stored.length; si++) out.push(asMerged(stored[si]));
  return { messages: out, anchored: true };
}

/**
 * A title taken from the first message or the "Untitled" placeholder, not from the site. A real
 * title that is already stored must not be replaced by one of these.
 */
export function looksDerivedTitle(title: string, messages: Array<{ role: string; content: string }>): boolean {
  const t = title.replace(/\s+/g, ' ').trim();
  if (!t || /^untitled( conversation)?$/i.test(t)) return true;
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  const derived = firstUser.replace(/\s+/g, ' ').slice(0, 80).trim();
  return derived.length > 0 && t === derived;
}
