// Retrieval for Still's read requests (threads.search / list / context / related, facets), run in
// the service worker. It mirrors the manager's search (lexical + local hashed vectors, optional
// remote query embedding and reranker) and Ask's passage selection, with three extra rules:
// - only threads that may leave this browser are ever considered (filters apply before ranking);
// - remote models are used only when allowed (capability remote_models) and the deadline allows;
// - caches are per thread and per sourceRevision, so a changed thread is reloaded alone.

import type { ThreadkeeperDB } from '../db.js';
import {
  THREAD_KIND_LABELS,
  type ConversationRecord,
  type MessageRecord,
  type SettingsRecord,
  type StructuredSummaryRecord,
  type ThreadInsight,
} from '../schema.js';
import { getSmartTitle, resolveInsight } from '../insights.js';
import { providerCategory, providerLabel } from '../providers.js';
import { isRemoteAllowed, localOnlyProjectNames } from '../privacy.js';
import { LOCAL_SPACE, cosine, embedTexts, localHashEmbedding, primarySpace, remoteSpace, type EmbeddingSpace } from '../embeddings.js';
import { buildRerankDocument, rerankReady, rerankThreads } from '../rerank.js';
import { computeDeterministicHash } from '../schema.js';
import { remoteModelsAllowed } from './state.js';
import { buildThreadSummary } from './payload.js';
import {
  threadHash,
  type ContextRequest,
  type DockFilters,
  type ListRequest,
  type RerankMode,
  type SearchRequest,
  type ThreadSummary,
} from './protocol.js';


export interface QueryEnv {
  db: ThreadkeeperDB;
  settings: SettingsRecord;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Caches (per service-worker lifetime)
// ---------------------------------------------------------------------------

interface CachedTranscript {
  revision: number;
  messages: Array<{ ordinal: number; role: MessageRecord['role']; text: string }>;
  /** Lower-cased dialog text joined by '\n', with each message's start offset. */
  lower: string;
  offsets: number[];
  chars: number;
}

const CACHE_MESSAGE_CHARS = 20_000;
const CACHE_THREAD_CHARS = 300_000;
const CACHE_TOTAL_CHARS = 120_000_000;

class DockQueryCache {
  transcripts = new Map<string, CachedTranscript>();
  transcriptChars = 0;
  vectors = new Map<string, { revision: number; embedding: Float32Array }>();
  hashToKey = new Map<string, string>();
  hashedKeys = new Set<string>();

  clear(): void {
    this.transcripts.clear();
    this.transcriptChars = 0;
    this.vectors.clear();
    this.hashToKey.clear();
    this.hashedKeys.clear();
  }

  putTranscript(threadKey: string, entry: CachedTranscript): void {
    const old = this.transcripts.get(threadKey);
    if (old) {
      this.transcriptChars -= old.chars;
      this.transcripts.delete(threadKey);
    }
    this.transcripts.set(threadKey, entry);
    this.transcriptChars += entry.chars;
    // Oldest-inserted first: Map iteration order.
    for (const [key, value] of this.transcripts) {
      if (this.transcriptChars <= CACHE_TOTAL_CHARS) break;
      this.transcriptChars -= value.chars;
      this.transcripts.delete(key);
    }
  }
}

const cache = new DockQueryCache();

/** Drop every cached transcript and vector (tests; database reset). */
export function clearDockQueryCache(): void {
  cache.clear();
}

function toCachedTranscript(revision: number, list: MessageRecord[]): CachedTranscript {
  const sorted = [...list].sort((a, b) => a.ordinal - b.ordinal);
  const messages: CachedTranscript['messages'] = [];
  const parts: string[] = [];
  const offsets: number[] = [];
  let chars = 0;
  let offset = 0;
  for (const m of sorted) {
    if (chars >= CACHE_THREAD_CHARS) break;
    const text = (m.content ?? '').slice(0, Math.min(CACHE_MESSAGE_CHARS, CACHE_THREAD_CHARS - chars));
    messages.push({ ordinal: m.ordinal, role: m.role, text });
    const lower = text.toLowerCase();
    offsets.push(offset);
    parts.push(lower);
    offset += lower.length + 1;
    chars += text.length;
  }
  return { revision, messages, lower: parts.join('\n'), offsets, chars: chars * 2 };
}

async function ensureTranscripts(db: ThreadkeeperDB, convs: ConversationRecord[], deadlineAt: number, now: () => number): Promise<void> {
  const missing = convs.filter((c) => cache.transcripts.get(c.threadKey)?.revision !== c.sourceRevision).map((c) => c.threadKey);
  const revision = new Map(convs.map((c) => [c.threadKey, c.sourceRevision]));
  for (let i = 0; i < missing.length; i += 100) {
    if (now() > deadlineAt) return;
    const chunk = missing.slice(i, i + 100);
    const rows = await db.messages.where('threadKey').anyOf(chunk).toArray();
    const byThread = new Map<string, MessageRecord[]>(chunk.map((k) => [k, []]));
    for (const m of rows) byThread.get(m.threadKey)?.push(m);
    for (const [key, list] of byThread) cache.putTranscript(key, toCachedTranscript(revision.get(key) ?? 0, list));
  }
}

async function ensureVectors(db: ThreadkeeperDB, space: string, convs: ConversationRecord[]): Promise<Map<string, Float32Array>> {
  const out = new Map<string, Float32Array>();
  const missing: ConversationRecord[] = [];
  for (const c of convs) {
    const hit = cache.vectors.get(`${space}|${c.threadKey}`);
    if (hit && hit.revision === c.sourceRevision) out.set(c.threadKey, hit.embedding);
    else missing.push(c);
  }
  for (let i = 0; i < missing.length; i += 500) {
    const chunk = missing.slice(i, i + 500);
    const rows = await db.threadVectors.bulkGet(chunk.map((c) => `${space}|${c.threadKey}`));
    rows.forEach((row, idx) => {
      if (!row || !Array.isArray(row.embedding) || row.embedding.length === 0) return;
      const embedding = Float32Array.from(row.embedding);
      // Keyed on the conversation's revision: a newer revision reloads the vector.
      cache.vectors.set(`${space}|${chunk[idx].threadKey}`, { revision: chunk[idx].sourceRevision, embedding });
      out.set(chunk[idx].threadKey, embedding);
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Corpus: the shareable threads with their resolved insight
// ---------------------------------------------------------------------------

export interface CorpusEntry {
  conv: ConversationRecord;
  insight: ThreadInsight | null;
  summary: StructuredSummaryRecord | undefined;
  title: string;
  titleLower: string;
  titleTokens: string[];
  metaLower: string;
  summaryLower: string;
  updatedMs: number;
}

export interface Corpus {
  entries: CorpusEntry[];
  byKey: Map<string, CorpusEntry>;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((t) => t.length >= 2);
}

function updatedMsOf(conv: ConversationRecord): number {
  const t = Date.parse(conv.updatedAt ?? conv.lastCapturedAt ?? '');
  return Number.isFinite(t) ? t : 0;
}

/** Every thread that may go to Still: never synthetic, never local-only, never in a local-only project. */
export async function loadCorpus(db: ThreadkeeperDB, settings: SettingsRecord): Promise<Corpus> {
  const [convs, localOnly, insights, summaries] = await Promise.all([
    db.conversations.toArray(),
    localOnlyProjectNames(db),
    db.insights.toArray(),
    db.summaries.toArray(),
  ]);
  const local = new Map<string, ThreadInsight>();
  const ai = new Map<string, ThreadInsight>();
  for (const i of insights) (i.source === 'ai' ? ai : local).set(i.threadKey, i);
  const summaryByKey = new Map(summaries.map((s) => [s.threadKey, s]));
  const entries: CorpusEntry[] = [];
  for (const conv of convs) {
    if (conv.isSyntheticBenchmark || !isRemoteAllowed(conv, settings, localOnly)) continue;
    const insight = resolveInsight(conv, local.get(conv.threadKey), ai.get(conv.threadKey));
    const summary = summaryByKey.get(conv.threadKey);
    const title = getSmartTitle(conv, insight);
    const meta = [
      conv.project,
      conv.tags.join(' '),
      conv.latestDecisionText ?? '',
      conv.nextStepText ?? '',
      conv.providerProjectName ?? '',
      providerLabel(conv.provider),
      insight?.gist ?? '',
      insight?.summary ?? '',
      (insight?.overview ?? []).join(' '),
      insight?.topics.join(' ') ?? '',
      insight?.entities.join(' ') ?? '',
      insight ? THREAD_KIND_LABELS[insight.kind] ?? '' : '',
      conv.agentLabel ?? '',
    ].join(' ');
    const summaryText = summary
      ? [
          summary.whereYouLeftOff,
          summary.currentStatus,
          ...summary.decisions.map((d) => d.text),
          ...summary.actionItems.map((d) => d.text),
          ...summary.openQuestions.map((d) => d.text),
          ...(summary.keyPoints ?? []).map((d) => d.text),
          summary.nextStep ?? '',
        ].join(' ')
      : '';
    entries.push({
      conv,
      insight,
      summary,
      title,
      titleLower: title.toLowerCase(),
      titleTokens: tokenize(title),
      metaLower: meta.toLowerCase(),
      summaryLower: summaryText.toLowerCase(),
      updatedMs: updatedMsOf(conv),
    });
  }
  return { entries, byKey: new Map(entries.map((e) => [e.conv.threadKey, e])) };
}

/** Thread keys for full hashes and cite ids (cached per service-worker lifetime). */
export async function resolveHashes(db: ThreadkeeperDB, values: string[]): Promise<Map<string, string>> {
  const keys = (await db.conversations.toCollection().primaryKeys()) as string[];
  for (const key of keys) {
    if (cache.hashedKeys.has(key)) continue;
    const h = threadHash(key);
    cache.hashToKey.set(h, key);
    cache.hashToKey.set(`tk:${h.slice(0, 16)}`, key);
    cache.hashedKeys.add(key);
  }
  const out = new Map<string, string>();
  for (const v of values) {
    const key = cache.hashToKey.get(v);
    if (key) out.set(v, key);
  }
  return out;
}

export function applyFilters(entries: CorpusEntry[], f: DockFilters, hashKeys?: ReadonlySet<string>): CorpusEntry[] {
  const providers = f.providers ? new Set(f.providers) : null;
  const categories = f.categories ? new Set(f.categories) : null;
  const kinds = f.kinds ? new Set(f.kinds) : null;
  const projects = f.projects ? new Set(f.projects.map((p) => p.trim().toLowerCase())) : null;
  const states = f.states ? new Set(f.states) : null;
  const keys = f.threadKeys ? new Set(f.threadKeys) : null;
  const since = f.since ? Date.parse(f.since) : null;
  const until = f.until ? Date.parse(f.until) : null;
  return entries.filter((e) => {
    const c = e.conv;
    if (providers && !providers.has(c.provider)) return false;
    if (categories && !categories.has(providerCategory(c.provider))) return false;
    if (kinds && !(e.insight && kinds.has(e.insight.kind))) return false;
    if (projects && !projects.has(c.project.trim().toLowerCase())) return false;
    if (states && !states.has(c.workflowState)) return false;
    if (since !== null && e.updatedMs < since) return false;
    if (until !== null && e.updatedMs > until) return false;
    if (keys || hashKeys) {
      const inKeys = keys?.has(c.threadKey) ?? false;
      const inHashes = hashKeys?.has(c.threadKey) ?? false;
      if (!inKeys && !inHashes) return false;
    }
    return true;
  });
}

async function filteredCorpus(env: QueryEnv, filters: DockFilters): Promise<{ corpus: Corpus; entries: CorpusEntry[] }> {
  const corpus = await loadCorpus(env.db, env.settings);
  let hashKeys: Set<string> | undefined;
  if (filters.hashes?.length) hashKeys = new Set((await resolveHashes(env.db, filters.hashes)).values());
  return { corpus, entries: applyFilters(corpus.entries, filters, hashKeys) };
}

// ---------------------------------------------------------------------------
// Lexical scoring
// ---------------------------------------------------------------------------

interface LexicalHit {
  score: number;
  strong: boolean;
  reasons: string[];
  messageIndex: number | null;
  excerptText: string;
  excerptRole: string;
}

function lexical(entry: CorpusEntry, q: string, tokens: string[], transcript: CachedTranscript | undefined): LexicalHit {
  const hit: LexicalHit = { score: 0, strong: false, reasons: [], messageIndex: null, excerptText: '', excerptRole: '' };
  if (!q) return hit;
  if (entry.titleLower.includes(q)) {
    hit.score += 35;
    hit.strong = true;
    hit.reasons.push('Title match');
  } else if (tokens.length) {
    const inTitle = tokens.filter((t) => entry.titleLower.includes(t));
    if (inTitle.length === tokens.length) {
      hit.score += 28;
      hit.strong = true;
      hit.reasons.push('Title keywords');
    } else if (inTitle.length) {
      hit.score += 8 * inTitle.length;
      hit.reasons.push('Title keyword overlap');
    }
  }
  if (entry.metaLower.includes(q)) {
    hit.score += 18;
    hit.strong = true;
    hit.reasons.push('Summary, topic, or project match');
  } else if (tokens.length) {
    const inMeta = tokens.filter((t) => entry.metaLower.includes(t));
    if (inMeta.length === tokens.length) {
      hit.score += 12;
      hit.strong = tokens.length > 1 || hit.strong;
      hit.reasons.push('Metadata keyword match');
    } else if (inMeta.length) {
      hit.score += 4 * inMeta.length;
      hit.reasons.push('Metadata keyword overlap');
    }
  }
  if (entry.summaryLower && (entry.summaryLower.includes(q) || (tokens.length > 1 && tokens.every((t) => entry.summaryLower.includes(t))))) {
    hit.score += 20;
    hit.strong = true;
    hit.reasons.push('Structured summary match');
  }
  if (transcript && transcript.lower) {
    const phraseAt = transcript.lower.indexOf(q);
    if (phraseAt >= 0) {
      const idx = messageAt(transcript, phraseAt);
      hit.score += 25;
      hit.strong = true;
      hit.reasons.push(`Exact match in message m${transcript.messages[idx].ordinal + 1}`);
      setExcerpt(hit, transcript, idx, q);
    } else if (tokens.length && tokens.some((t) => transcript.lower.includes(t))) {
      let best = -1;
      let bestCount = 0;
      transcript.messages.forEach((m, i) => {
        if (m.role !== 'user' && m.role !== 'assistant') return;
        const lower = transcript.lower.slice(transcript.offsets[i], transcript.offsets[i] + m.text.length);
        const count = tokens.filter((t) => lower.includes(t)).length;
        if (count > bestCount) {
          bestCount = count;
          best = i;
        }
      });
      if (best >= 0) {
        const all = bestCount === tokens.length;
        hit.score += all ? 14 : 5 * bestCount;
        if (all && tokens.length > 1) hit.strong = true;
        hit.reasons.push(`${all ? 'Keywords' : 'Keyword overlap'} in message m${transcript.messages[best].ordinal + 1}`);
        setExcerpt(hit, transcript, best, tokens.find((t) => transcript.messages[best].text.toLowerCase().includes(t)) ?? '');
      }
    }
  }
  return hit;
}

function messageAt(t: CachedTranscript, offset: number): number {
  let lo = 0;
  let hi = t.offsets.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (t.offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function excerptAround(text: string, needle: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  const at = needle ? clean.toLowerCase().indexOf(needle) : -1;
  if (at < 0 || clean.length <= max) return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
  const start = Math.max(0, at - 60);
  const slice = clean.slice(start, start + max);
  return `${start > 0 ? '…' : ''}${slice}${start + max < clean.length ? '…' : ''}`;
}

function setExcerpt(hit: LexicalHit, t: CachedTranscript, idx: number, needle: string): void {
  const m = t.messages[idx];
  hit.messageIndex = m.ordinal;
  hit.excerptRole = m.role;
  hit.excerptText = excerptAround(m.text, needle);
}

// ---------------------------------------------------------------------------
// Ranking (lexical + vectors + optional reranker)
// ---------------------------------------------------------------------------

interface Ranked {
  entry: CorpusEntry;
  fused: number;
  lex: LexicalHit;
  vector: number;
  rerank: number | null;
}

interface RankOptions {
  query: string;
  semantic: 'local' | 'auto';
  rerank: RerankMode;
  /** Which manager setting governs rerank 'auto' (search vs Ask). */
  rerankSetting: 'rerankInSearch' | 'rerankInAsk';
  deadlineAt: number;
  scanMessages: boolean;
}

export interface RankOutcome {
  ranked: Ranked[];
  semantic: boolean;
  reranked: boolean;
}

function withDeadline(fetchImpl: typeof fetch, signal: AbortSignal): typeof fetch {
  return (input, init) => fetchImpl(input, { ...init, signal });
}

async function rankEntries(env: QueryEnv, entries: CorpusEntry[], o: RankOptions): Promise<RankOutcome> {
  const now = env.now ?? Date.now;
  const q = o.query.replace(/^"+|"+$/g, '').trim().toLowerCase();
  const tokens = Array.from(new Set(tokenize(q)));
  if (o.scanMessages) await ensureTranscripts(env.db, entries.map((e) => e.conv), o.deadlineAt, now);
  const lexHits = new Map<string, LexicalHit>();
  for (const e of entries) {
    const hit = lexical(e, q, tokens, o.scanMessages ? cache.transcripts.get(e.conv.threadKey) : undefined);
    lexHits.set(e.conv.threadKey, hit);
  }
  const fused = new Map<string, number>();
  const vectorScore = new Map<string, number>();
  const addRanked = (keys: string[], weight = 1) =>
    keys.forEach((k, rank) => fused.set(k, (fused.get(k) ?? 0) + weight / (60 + rank + 1)));

  const lexicalOrder = entries
    .filter((e) => (lexHits.get(e.conv.threadKey)?.score ?? 0) > 0)
    .sort((a, b) => (lexHits.get(b.conv.threadKey)!.score - lexHits.get(a.conv.threadKey)!.score) || b.updatedMs - a.updatedMs)
    .map((e) => e.conv.threadKey);
  addRanked(lexicalOrder);

  const rankBySpace = async (space: string, qv: ArrayLike<number>, threshold: number, weight: number) => {
    const vectors = await ensureVectors(env.db, space, entries.map((e) => e.conv));
    const scored: Array<[string, number]> = [];
    for (const [key, v] of vectors) {
      if (v.length !== qv.length) continue;
      scored.push([key, cosine(qv, v)]);
    }
    scored.sort((a, b) => b[1] - a[1]);
    const top = scored.slice(0, 40).filter(([, s]) => s >= threshold);
    for (const [k, s] of top) vectorScore.set(k, Math.max(vectorScore.get(k) ?? 0, s));
    addRanked(top.map(([k]) => k), weight);
    return top.length;
  };

  let semantic = false;
  if (q.length >= 3) {
    await rankBySpace(LOCAL_SPACE, localHashEmbedding(q), 0.18, 0.8);
    const space = remoteSpace(env.settings);
    if (o.semantic === 'auto' && space && remoteModelsAllowed(env.settings) && o.deadlineAt - now() > 1200) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(0, o.deadlineAt - now() - 300));
      try {
        const [qv] = await embedTexts(env.settings, space, [o.query.slice(0, 2000)], 'query', withDeadline(env.fetchImpl ?? fetch, controller.signal));
        if (Array.isArray(qv) && qv.length) {
          await rankBySpace(space.id, qv, 0.12, 1);
          semantic = true;
        }
      } catch {
        // remote embedding unavailable or too slow: lexical + local vectors still apply
      } finally {
        clearTimeout(timer);
      }
    }
  }

  const entryByKey = new Map(entries.map((e) => [e.conv.threadKey, e]));
  let ranked: Ranked[] = Array.from(fused.entries())
    .map(([key, score]) => ({
      entry: entryByKey.get(key)!,
      fused: score,
      lex: lexHits.get(key)!,
      vector: vectorScore.get(key) ?? 0,
      rerank: null as number | null,
    }))
    .filter((r) => r.entry)
    .sort((a, b) => b.fused - a.fused || b.entry.updatedMs - a.entry.updatedMs);

  let reranked = false;
  const wantsRerank =
    q.length > 0 &&
    ranked.length >= 2 &&
    rerankReady(env.settings) &&
    remoteModelsAllowed(env.settings) &&
    (o.rerank === 'on' || (o.rerank === 'auto' && env.settings[o.rerankSetting]));
  if (wantsRerank && o.deadlineAt - now() > 1500) {
    const pool = ranked.slice(0, Math.min(40, Math.max(2, env.settings.rerankCandidates || 40)));
    try {
      const outcome = await rerankThreads(
        env.settings,
        o.query,
        pool.map((r) => ({
          key: r.entry.conv.threadKey,
          document: buildRerankDocument({ title: r.entry.title, gist: r.entry.insight?.gist, excerpt: r.lex.excerptText || null }),
        })),
        // Every candidate is already remote-allowed (corpus rule).
        new Set(pool.map((r) => r.entry.conv.threadKey)),
        env.fetchImpl ?? fetch,
        { timeoutMs: Math.max(500, o.deadlineAt - now() - 200) }
      );
      if (outcome.scores.size > 0) {
        const byKey = new Map(pool.map((r) => [r.entry.conv.threadKey, r]));
        for (const [k, s] of outcome.scores) byKey.get(k)!.rerank = s;
        const reordered = outcome.order.map((k) => byKey.get(k)!).filter(Boolean);
        ranked = [...reordered, ...ranked.slice(pool.length)];
        reranked = true;
      }
    } catch {
      // keep first-stage order
    }
  }
  return { ranked, semantic, reranked };
}

function scoreOf(r: Ranked, max: number): number {
  if (r.rerank !== null) return Math.round(Math.max(0, Math.min(1, r.rerank)) * 1000) / 1000;
  return max > 0 ? Math.round((r.fused / max) * 1000) / 1000 : 0;
}

function toSearchSummary(r: Ranked, max: number, excerpts: boolean): ThreadSummary {
  const base = buildThreadSummary(r.entry.conv, r.entry.insight);
  const reasons = Array.from(new Set([...r.lex.reasons, ...(r.vector > 0 ? ['Similar meaning'] : []), ...(r.rerank !== null ? ['Reranked'] : [])])).slice(0, 5);
  const strong = r.lex.strong || (r.rerank !== null && r.rerank >= 0.5);
  const summary: ThreadSummary = { ...base, score: scoreOf(r, max), match: strong ? 'strong' : 'weak', matchReasons: reasons };
  if (excerpts) {
    summary.excerpt = r.lex.excerptText
      ? { text: r.lex.excerptText.slice(0, 220), messageIndex: r.lex.messageIndex, role: r.lex.excerptRole }
      : base.gist
        ? { text: base.gist.slice(0, 220), messageIndex: null, role: '' }
        : null;
  }
  return summary;
}

// ---------------------------------------------------------------------------
// Cursors: opaque offset bound to the request
// ---------------------------------------------------------------------------

export function makeCursor(offset: number, requestKey: string): string {
  return `c1.${offset}.${computeDeterministicHash(requestKey).slice(0, 8)}`;
}

export function readCursor(cursor: string | null, requestKey: string): number {
  if (!cursor) return 0;
  const m = cursor.match(/^c1\.(\d{1,7})\.([0-9a-f]{8})$/);
  if (!m || m[2] !== computeDeterministicHash(requestKey).slice(0, 8)) return 0;
  return Number(m[1]);
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

export interface SearchResponse {
  results: ThreadSummary[];
  total: number;
  nextCursor: string | null;
  semantic: boolean;
  reranked: boolean;
}

export async function searchThreads(env: QueryEnv, req: SearchRequest): Promise<SearchResponse> {
  const now = env.now ?? Date.now;
  const deadlineAt = now() + req.deadlineMs;
  if (!req.query) {
    const listed = await listThreads(env, { filters: req.filters, sort: 'recent', cursor: req.cursor, limit: req.limit });
    return { results: listed.results, total: listed.total, nextCursor: listed.nextCursor, semantic: false, reranked: false };
  }
  const { entries } = await filteredCorpus(env, req.filters);
  const outcome = await rankEntries(env, entries, {
    query: req.query,
    semantic: req.semantic,
    rerank: req.rerank,
    rerankSetting: 'rerankInSearch',
    deadlineAt,
    scanMessages: true,
  });
  const requestKey = JSON.stringify(['search', req.query, req.filters]);
  const offset = readCursor(req.cursor, requestKey);
  const max = outcome.ranked.reduce((m, r) => Math.max(m, r.fused), 0);
  const page = outcome.ranked.slice(offset, offset + req.limit);
  const next = offset + page.length;
  return {
    results: page.map((r) => toSearchSummary(r, max, req.excerpts)),
    total: outcome.ranked.length,
    nextCursor: next < outcome.ranked.length ? makeCursor(next, requestKey) : null,
    semantic: outcome.semantic,
    reranked: outcome.reranked,
  };
}

export interface ListResponse {
  results: ThreadSummary[];
  total: number;
  nextCursor: string | null;
}

export async function listThreads(env: QueryEnv, req: ListRequest): Promise<ListResponse> {
  const { entries } = await filteredCorpus(env, req.filters);
  const sorted = [...entries].sort((a, b) => {
    if (req.sort === 'oldest') return a.updatedMs - b.updatedMs || a.conv.threadKey.localeCompare(b.conv.threadKey);
    if (req.sort === 'title') return a.title.localeCompare(b.title, undefined, { sensitivity: 'base' }) || a.conv.threadKey.localeCompare(b.conv.threadKey);
    return b.updatedMs - a.updatedMs || a.conv.threadKey.localeCompare(b.conv.threadKey);
  });
  const requestKey = JSON.stringify(['list', req.sort, req.filters]);
  const offset = readCursor(req.cursor, requestKey);
  const page = sorted.slice(offset, offset + req.limit);
  const next = offset + page.length;
  return {
    results: page.map((e) => buildThreadSummary(e.conv, e.insight)),
    total: sorted.length,
    nextCursor: next < sorted.length ? makeCursor(next, requestKey) : null,
  };
}

export interface ContextPassage {
  messageIndex: number;
  role: string;
  text: string;
}

export interface ContextResponse {
  threads: Array<{ thread: ThreadSummary; passages: ContextPassage[] }>;
  semantic: boolean;
  reranked: boolean;
}

/** Ask-style passages inside one thread: user and assistant messages only, ordinals kept. */
export function selectPassages(
  messages: Array<{ ordinal: number; role: string; text: string }>,
  question: string,
  budgetChars: number,
  maxPassages = 3
): ContextPassage[] {
  const terms = Array.from(new Set(tokenize(question).filter((t) => t.length >= 3)));
  const dialog = messages.filter((m) => m.role === 'user' || m.role === 'assistant');
  if (dialog.length === 0 || budgetChars < 80) return [];
  const scored = dialog
    .map((m) => {
      const lower = m.text.toLowerCase();
      return { m, score: terms.reduce((n, t) => n + (lower.includes(t) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.m.ordinal - a.m.ordinal)
    .slice(0, maxPassages);
  const picked = scored.length ? scored.map((x) => x.m) : dialog.slice(-2);
  picked.sort((a, b) => a.ordinal - b.ordinal);
  const per = Math.max(80, Math.floor(budgetChars / picked.length));
  const out: ContextPassage[] = [];
  let used = 0;
  for (const m of picked) {
    const width = Math.min(per, 900, budgetChars - used);
    if (width < 60) break;
    const lower = m.text.toLowerCase();
    const at = terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
    const start = Math.max(0, at - Math.floor(width / 4));
    const slice = m.text.slice(start, start + width).replace(/\s+/g, ' ').trim();
    const text = `${start > 0 ? '…' : ''}${slice}${start + width < m.text.length ? '…' : ''}`;
    used += text.length;
    out.push({ messageIndex: m.ordinal, role: m.role, text });
  }
  return out;
}

export async function threadContext(env: QueryEnv, req: ContextRequest): Promise<ContextResponse> {
  const now = env.now ?? Date.now;
  const deadlineAt = now() + req.deadlineMs;
  const { entries } = await filteredCorpus(env, req.filters);
  // Candidates come from persisted vectors and insights; messages are read for the winners only.
  // When that finds too little (threads never analyzed on-device), fall back to a message scan
  // bounded by the deadline.
  const rankOptions = { query: req.question, semantic: req.semantic, rerank: req.rerank, rerankSetting: 'rerankInAsk' as const, deadlineAt };
  let outcome = await rankEntries(env, entries, { ...rankOptions, scanMessages: false });
  if (outcome.ranked.length < req.limit && deadlineAt - now() > req.deadlineMs * 0.4) {
    // Never repeat a remote call the first pass already paid for.
    const retry = await rankEntries(env, entries, {
      ...rankOptions,
      semantic: outcome.semantic ? 'local' : req.semantic,
      rerank: outcome.reranked ? 'off' : req.rerank,
      scanMessages: true,
    });
    outcome = { ranked: retry.ranked, semantic: outcome.semantic || retry.semantic, reranked: outcome.reranked || retry.reranked };
  }
  const top = outcome.ranked.slice(0, req.limit);
  // A filter on explicit threads (Still's chat in scope) still returns them when nothing ranks.
  if (top.length === 0 && (req.filters.threadKeys?.length || req.filters.hashes?.length)) {
    for (const e of entries.slice(0, req.limit)) top.push({ entry: e, fused: 0, lex: lexical(e, '', [], undefined), vector: 0, rerank: null });
  }
  await ensureTranscripts(env.db, top.map((r) => r.entry.conv), Number.POSITIVE_INFINITY, now);
  const max = outcome.ranked.reduce((m, r) => Math.max(m, r.fused), 0);
  const perThread = Math.floor(req.budgetChars / Math.max(1, top.length));
  let left = req.budgetChars;
  const threads: ContextResponse['threads'] = [];
  for (const r of top) {
    const transcript = cache.transcripts.get(r.entry.conv.threadKey);
    const passages = transcript ? selectPassages(transcript.messages, req.question, Math.min(perThread, left)) : [];
    left -= passages.reduce((n, p) => n + p.text.length, 0);
    threads.push({ thread: toSearchSummary(r, max, false), passages });
  }
  return { threads, semantic: outcome.semantic, reranked: outcome.reranked };
}

export async function relatedThreads(env: QueryEnv, threadKey: string, limit: number): Promise<ThreadSummary[] | null> {
  const corpus = await loadCorpus(env.db, env.settings);
  const seed = corpus.byKey.get(threadKey);
  if (!seed) return null;
  const pickSpace = async (): Promise<{ space: EmbeddingSpace; vectors: Map<string, Float32Array> } | null> => {
    const primary = primarySpace(env.settings);
    for (const space of primary.id === LOCAL_SPACE ? [primary] : [primary, { ...primary, id: LOCAL_SPACE, relatedThreshold: 0.3 }]) {
      const vectors = await ensureVectors(env.db, space.id, corpus.entries.map((e) => e.conv));
      if (vectors.has(threadKey)) return { space, vectors };
    }
    return null;
  };
  const picked = await pickSpace();
  if (!picked) return [];
  const seedVec = picked.vectors.get(threadKey)!;
  const scored: Array<[CorpusEntry, number]> = [];
  for (const e of corpus.entries) {
    if (e.conv.threadKey === threadKey || e.conv.sourceConversationId === seed.conv.sourceConversationId) continue;
    const v = picked.vectors.get(e.conv.threadKey);
    if (!v || v.length !== seedVec.length) continue;
    const sim = cosine(seedVec, v);
    if (sim >= picked.space.relatedThreshold) scored.push([e, sim]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, limit).map(([e, sim]) => ({
    ...buildThreadSummary(e.conv, e.insight),
    score: Math.round(sim * 1000) / 1000,
    match: sim >= picked.space.relatedThreshold + 0.1 ? ('strong' as const) : ('weak' as const),
    matchReasons: ['Similar meaning'],
  }));
}

export interface FacetsResponse {
  total: number;
  providers: Array<{ id: string; label: string; category: string; count: number }>;
  projects: Array<{ name: string; count: number }>;
  kinds: Array<{ id: string; label: string; count: number }>;
  states: Array<{ id: string; count: number }>;
}

/** Counts over shareable threads only: private threads and local-only projects never appear. */
export async function facets(env: QueryEnv): Promise<FacetsResponse> {
  const { entries } = await loadCorpus(env.db, env.settings);
  const count = <K>(keyOf: (e: CorpusEntry) => K | null) => {
    const m = new Map<K, number>();
    for (const e of entries) {
      const k = keyOf(e);
      if (k !== null) m.set(k, (m.get(k) ?? 0) + 1);
    }
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1]);
  };
  return {
    total: entries.length,
    providers: count((e) => e.conv.provider as string).map(([id, n]) => ({
      id,
      label: providerLabel(id),
      category: providerCategory(id),
      count: n,
    })),
    projects: count((e) => e.conv.project || null).slice(0, 500).map(([name, n]) => ({ name, count: n })),
    kinds: count((e) => e.insight?.kind ?? null).map(([id, n]) => ({ id, label: THREAD_KIND_LABELS[id] ?? id, count: n })),
    states: count((e) => e.conv.workflowState).map(([id, n]) => ({ id, count: n })),
  };
}
