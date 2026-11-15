// Shared fixtures for the Sidebar Dock (Still) link tests.
import 'fake-indexeddb/auto';
import {
  ThreadkeeperDB,
  ensureStarterCollectionsAndSettings,
  upsertThread,
  type UpsertThreadInput,
} from '../../src/core/db.js';
import { buildThreadKey, insightKeyFor, type ThreadInsight } from '../../src/core/schema.js';
import { DockService, type DockDeps } from '../../src/core/dock/external.js';
import { memoryStore, patchDockSettings } from '../../src/core/dock/state.js';
import { PROTO } from '../../src/core/dock/protocol.js';

let counter = 0;
export function freshDb(): ThreadkeeperDB {
  counter += 1;
  return new ThreadkeeperDB(`DockTestDB_${Date.now()}_${counter}`);
}

export const STILL_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const OTHER_ID = 'ponmlkjihgfedcbaponmlkjihgfedcba';
export const TK_ID = 'aaaabbbbccccddddaaaabbbbccccdddd';
export const stillSender = (id = STILL_ID) => ({ id, url: `chrome-extension://${id}/index.html`, origin: `chrome-extension://${id}` });

export function thread(
  id: string,
  title: string,
  turns: Array<['user' | 'assistant' | 'tool' | 'system', string]>,
  extra: Partial<UpsertThreadInput> = {}
): UpsertThreadInput {
  const provider = extra.provider ?? 'chatgpt';
  const ids = { accountId: 'acct_test', workspaceId: 'ws_test' };
  return {
    threadKey: buildThreadKey({ provider, ...ids, sourceConversationId: id, branchId: 'main' }),
    provider,
    ...ids,
    sourceConversationId: id,
    branchId: 'main',
    canonicalUrl: provider === 'chatgpt' ? `https://chatgpt.com/c/${id}` : '',
    title,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: '2026-10-30T10:00:00.000Z',
    coverage: 'full',
    captureSource: 'export_import',
    messages: turns.map(([role, content], i) => ({ sourceMessageId: `${id}_m${i}`, role, content, createdAt: null })),
    ...extra,
  };
}

export async function seed(db: ThreadkeeperDB, input: UpsertThreadInput): Promise<string> {
  const res = await upsertThread(db, input);
  if (res.status !== 'stored') throw new Error('not stored');
  return input.threadKey;
}

export async function putInsight(db: ThreadkeeperDB, threadKey: string, patch: Partial<ThreadInsight> & Record<string, unknown> = {}): Promise<void> {
  const conv = await db.conversations.get(threadKey);
  if (!conv) throw new Error('no conv');
  const source = (patch.source as 'ai' | 'local' | undefined) ?? 'ai';
  await db.insights.put({
    insightKey: insightKeyFor(source, threadKey),
    threadKey,
    source,
    model: source === 'ai' ? 'claude-opus-5-5' : 'local-heuristics-v2',
    sourceRevision: conv.sourceRevision,
    contentHash: conv.contentHash,
    generatedAt: '2026-10-31T09:00:00.000Z',
    title: conv.title,
    gist: 'A gist',
    summary: 'A summary',
    userGoal: null,
    outcome: null,
    kind: 'coding',
    topics: ['webhooks'],
    entities: ['Stripe'],
    languages: [],
    artifacts: [],
    lastUserAsk: null,
    suggestedStatus: null,
    statusReason: null,
    suggestedProject: null,
    userTurns: 1,
    hasCode: false,
    ...patch,
  } as ThreadInsight);
}

export interface StillCall {
  to: string;
  message: Record<string, unknown>;
}

/** A scripted Still: answers by message type; records every call. */
export function fakeStill(handlers: Partial<Record<string, (m: Record<string, unknown>) => unknown>> = {}) {
  const calls: StillCall[] = [];
  const send = async (to: string, message: unknown) => {
    const m = message as Record<string, unknown>;
    calls.push({ to, message: m });
    const h = handlers[m.type as string];
    if (h) return h(m);
    if (m.type === 'threads.upsert') {
      const threads = m.threads as Array<Record<string, unknown>>;
      return {
        ok: true,
        proto: PROTO,
        results: threads.map((t) => ({ threadKey: t.threadKey, status: 'created', itemId: `chat_tk_${t.hash}`, fingerprint: t.fingerprint, seq: t.seq })),
      };
    }
    if (m.type === 'threads.remove') {
      return { ok: true, proto: PROTO, results: (m.threadKeys as string[]).map((threadKey) => ({ threadKey, status: 'removed' })) };
    }
    if (m.type === 'chats.status') return { ok: true, proto: PROTO, chats: {} };
    return { ok: true, proto: PROTO };
  };
  return { calls, send, of: (type: string) => calls.filter((c) => c.message.type === type) };
}

export interface Harness {
  db: ThreadkeeperDB;
  dock: DockService;
  still: ReturnType<typeof fakeStill>;
  clock: { t: number };
  windows: number;
}

export async function harness(options: { still?: ReturnType<typeof fakeStill>; deps?: Partial<DockDeps> } = {}): Promise<Harness> {
  const db = freshDb();
  await ensureStarterCollectionsAndSettings(db);
  const still = options.still ?? fakeStill();
  const clock = { t: Date.parse('2026-11-01T12:00:00.000Z') };
  const h: Harness = { db, dock: null as unknown as DockService, still, clock, windows: 0 };
  h.dock = new DockService({
    db,
    ownId: TK_ID,
    version: '0.4.0',
    now: () => clock.t,
    session: memoryStore(),
    sendExternal: still.send,
    openConsentWindow: async () => {
      h.windows += 1;
    },
    sleep: async () => undefined,
    ...options.deps,
  });
  return h;
}

/** Pair directly (skipping consent) and configure. */
export async function pairDirect(h: Harness, prefs: Partial<{ scope: 'all' | 'projects' | 'manual'; projects: string[]; providers: string[]; transcripts: boolean; autoUpdate: boolean }> = {}, configured = true) {
  await patchDockSettings(h.db, {
    pairedId: STILL_ID,
    pairedName: 'Still',
    pairedAt: new Date(h.clock.t).toISOString(),
    peerEpoch: 'epoch-1',
    configured,
    prefs: { scope: 'all', projects: [], providers: [], transcripts: true, autoUpdate: true, ...prefs },
  });
}

export function msg(type: string, fields: Record<string, unknown> = {}) {
  return { proto: PROTO, from: 'still', type, requestId: `req-${type}-${Math.random().toString(16).slice(2)}`, ...fields };
}
