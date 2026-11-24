import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { ThreadStackDB, UNFILED_PROJECT, upsertThread, type UpsertThreadInput } from '../../src/core/db.js';
import {
  buildLocalBrief,
  collectCatchUpThreads,
  generateCatchUpBrief,
  loadLastBrief,
  saveLastBrief,
  type CatchUpBrief,
  type CatchUpThread,
} from '../../src/core/catch-up.js';
import { THREAD_KINDS, buildThreadKey, normalizeSettings, type SettingsRecord, type ThreadInsight } from '../../src/core/schema.js';

let n = 0;
const freshDb = () => new ThreadStackDB(`ThreadStackCatchUp_${Date.now()}_${++n}`);

const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const DAY = 86_400_000;
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

function input(id: string, daysAgo: number, patch: Partial<UpsertThreadInput> = {}): UpsertThreadInput {
  return {
    threadKey: buildThreadKey({ provider: 'chatgpt', accountId: 'a', workspaceId: 'w', sourceConversationId: id, branchId: 'main' }),
    provider: 'chatgpt',
    accountId: 'a',
    workspaceId: 'w',
    sourceConversationId: id,
    branchId: 'main',
    canonicalUrl: `https://chatgpt.com/c/${id}`,
    title: `Thread ${id}`,
    createdAt: iso(daysAgo + 1),
    updatedAt: iso(daysAgo),
    coverage: 'full',
    captureSource: 'history_sync',
    messages: [{ sourceMessageId: `${id}-u`, role: 'user', content: `SECRET MESSAGE TEXT ${id}`, createdAt: null, branchPath: 'main' }],
    ...patch,
  };
}

const keyOf = (id: string) => input(id, 0).threadKey;

async function addInsight(db: ThreadStackDB, id: string, gist: string, summary = `Summary of ${id}.`, source: ThreadInsight['source'] = 'local') {
  const threadKey = keyOf(id);
  await db.insights.put({
    insightKey: `${source}|${threadKey}`,
    threadKey,
    source,
    model: 'test',
    sourceRevision: 1,
    contentHash: 'h',
    generatedAt: iso(0),
    title: `Thread ${id}`,
    gist,
    summary,
    userGoal: null,
    outcome: null,
    kind: THREAD_KINDS[0],
    topics: [],
    entities: [],
    languages: [],
    artifacts: [],
    lastUserAsk: null,
    suggestedStatus: null,
    statusReason: null,
    suggestedProject: null,
    userTurns: 1,
    hasCode: false,
  });
}

const thread = (patch: Partial<CatchUpThread>): CatchUpThread => ({
  threadKey: 'k',
  title: 'T',
  provider: 'ChatGPT',
  project: 'Alpha',
  updatedAt: iso(1),
  gist: 'g',
  summary: 's',
  decisions: [],
  nextSteps: [],
  openQuestions: [],
  status: 'active',
  remoteAllowed: true,
  ...patch,
});

const claudeSettings = (): SettingsRecord => normalizeSettings({ anthropicApiKey: 'sk-ant-test' });

type Call = { body: any };
function claudeFetch(calls: Call[], respond: (call: Call) => unknown, status = 200) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input, init);
    const text = await req.text();
    const call = { body: text ? JSON.parse(text) : null };
    calls.push(call);
    if (status !== 200) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        model: 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify(respond(call)) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
}

describe('collectCatchUpThreads', () => {
  it('returns the window newest first and skips tombstoned and synthetic threads', async () => {
    const db = freshDb();
    await upsertThread(db, input('old', 40));
    await upsertThread(db, input('mid', 10));
    await upsertThread(db, input('new', 1));
    await upsertThread(db, input('gone', 2));
    await upsertThread(db, input('synthetic', 3, { isSyntheticBenchmark: true }));
    await db.tombstones.put({ threadKey: keyOf('gone'), provider: 'chatgpt', sourceConversationId: 'gone', branchId: 'main', deletedAt: iso(0) } as never);
    await addInsight(db, 'new', 'The newest gist');

    const out = await collectCatchUpThreads(db, claudeSettings(), { sinceMs: NOW - 30 * DAY });
    expect(out.map((t) => t.title)).toEqual(['Thread new', 'Thread mid']);
    expect(out[0].gist).toBe('The newest gist');
    expect(out[1].gist).toBe('');
    expect(await collectCatchUpThreads(db, claudeSettings(), { sinceMs: NOW - 30 * DAY, limit: 1 })).toHaveLength(1);
  });

  it('prefers Claude analysis, takes decisions and next steps from the stored summary, and flags local-only threads', async () => {
    const db = freshDb();
    await upsertThread(db, input('a', 1, { latestDecisionText: 'Use a processed_events table', nextStepText: 'Write the replay test' }));
    await upsertThread(db, input('private', 2, { cloudExcluded: true }));
    await upsertThread(db, input('inproject', 3, { project: 'Personal' }));
    await db.collections.put({ name: 'Personal', description: '', isStarterArea: true, cloudExcluded: true, createdAt: iso(5) });
    await addInsight(db, 'a', 'local gist', 'local summary', 'local');
    await addInsight(db, 'a', 'claude gist', 'claude summary', 'ai');

    const byTitle = new Map((await collectCatchUpThreads(db, claudeSettings(), { sinceMs: NOW - 30 * DAY })).map((t) => [t.title, t]));
    expect(byTitle.get('Thread a')).toMatchObject({
      gist: 'claude gist',
      summary: 'claude summary',
      decisions: ['Use a processed_events table'],
      nextSteps: ['Write the replay test'],
      remoteAllowed: true,
    });
    expect(byTitle.get('Thread private')?.remoteAllowed).toBe(false);
    expect(byTitle.get('Thread inproject')?.remoteAllowed).toBe(false);
  });
});

describe('buildLocalBrief', () => {
  it('groups by project, orders by recent activity, dedupes and caps, and lists loose ends', () => {
    const threads = [
      thread({ threadKey: 'b1', title: 'B newest', project: 'Beta', updatedAt: iso(1), gist: 'Beta is shipping', nextSteps: ['Ship it', 'ship it', 'Tell users'], openQuestions: ['Which region?'], status: 'waiting' }),
      thread({ threadKey: 'a1', title: 'A one', project: 'Alpha', updatedAt: iso(5), gist: 'Alpha gist', nextSteps: Array.from({ length: 9 }, (_, i) => `step ${i}`) }),
      thread({ threadKey: 'b2', title: 'B older', project: 'Beta', updatedAt: iso(8), gist: 'Older beta gist', nextSteps: ['Ship it'] }),
      thread({ threadKey: 'u1', title: 'Loose', project: UNFILED_PROJECT, updatedAt: iso(2), gist: '' }),
      thread({ threadKey: 'l1', title: 'Hidden', project: 'Alpha', updatedAt: iso(6), remoteAllowed: false }),
    ];
    const brief = buildLocalBrief(threads, { sinceMs: NOW - 30 * DAY, days: 30, now: NOW });
    expect(brief.headline).toBe('5 conversations across 3 projects in the last 30 days.');
    expect(brief.source).toBe('local');
    expect(brief.workstreams.map((w) => w.name)).toEqual(['Beta', UNFILED_PROJECT, 'Alpha']);
    const beta = brief.workstreams[0];
    expect(beta.where).toBe('Beta is shipping');
    expect(beta.threadKeys).toEqual(['b1', 'b2']);
    expect(beta.nextSteps).toEqual(['Ship it', 'Tell users']);
    expect(beta.openLoops).toEqual(['Which region?', 'B newest: waiting']);
    expect(brief.workstreams[2].nextSteps).toHaveLength(5);
    expect(brief.looseEnds).toEqual([{ text: 'Loose is not filed in a project and has no summary yet', threadKey: 'u1' }]);
    expect(brief.threadCount).toBe(5);
    expect(brief.withheld).toBe(1);
    expect(brief.sinceIso).toBe(new Date(NOW - 30 * DAY).toISOString());
  });

  it('says so plainly when nothing happened', () => {
    expect(buildLocalBrief([], { sinceMs: NOW - DAY, days: 1, now: NOW }).headline).toBe('No conversations in the last 1 day.');
  });
});

describe('generateCatchUpBrief', () => {
  async function seeded() {
    const db = freshDb();
    await upsertThread(db, input('x', 1));
    await upsertThread(db, input('y', 2));
    await upsertThread(db, input('private', 3, { cloudExcluded: true }));
    await upsertThread(db, input('inproject', 4, { project: 'Personal' }));
    await db.collections.put({ name: 'Personal', description: '', isStarterArea: true, cloudExcluded: true, createdAt: iso(9) });
    await addInsight(db, 'x', 'Gist of x');
    await addInsight(db, 'y', 'Gist of y');
    await addInsight(db, 'private', 'PRIVATE GIST');
    await addInsight(db, 'inproject', 'PERSONAL PROJECT GIST');
    return db;
  }

  it('without a key it returns the on-device brief and makes no request', async () => {
    const db = await seeded();
    const calls: Call[] = [];
    const brief = await generateCatchUpBrief(db, normalizeSettings({}), { days: 30, now: NOW, fetchImpl: claudeFetch(calls, () => ({})) });
    expect(brief.source).toBe('local');
    expect(brief.threadCount).toBe(4);
    expect(calls).toHaveLength(0);
  });

  it('sends only notes of threads that may leave the device, never message text, and keeps local-only threads in the brief', async () => {
    const db = await seeded();
    const calls: Call[] = [];
    const fetchImpl = claudeFetch(calls, () => ({
      headline: 'Two active threads.',
      workstreams: [{ name: 'Webhooks', where: 'Retries handled.', threads: [1, 2, 99, 0, 1.5], openLoops: ['Which region?'], nextSteps: ['Write the replay test'] }],
      looseEnds: [{ text: 'Real loose end', thread: 2 }, { text: 'Invented', thread: 42 }],
    }));
    const brief = await generateCatchUpBrief(db, claudeSettings(), { days: 30, now: NOW, fetchImpl });

    expect(calls).toHaveLength(1);
    const sent = JSON.stringify(calls[0].body);
    expect(sent).toContain('Gist of x');
    expect(sent).toContain('Gist of y');
    expect(sent).not.toMatch(/PRIVATE GIST|PERSONAL PROJECT GIST|Thread private|Thread inproject/);
    expect(sent).not.toContain('SECRET MESSAGE TEXT');

    expect(brief.source).toBe('claude');
    expect(brief.model).toBe('claude-opus-5-5');
    expect(brief.headline).toBe('Two active threads.');
    expect(brief.threadCount).toBe(4);
    expect(brief.withheld).toBe(2);
    expect(brief.note).toMatch(/2 local-only conversations were summarized on this device/);

    // Hallucinated T-numbers (99, 0, 1.5, 42) are dropped; the two real ones map back to thread keys.
    const webhooks = brief.workstreams.find((w) => w.name === 'Webhooks')!;
    expect(webhooks.threadKeys).toEqual([keyOf('x'), keyOf('y')]);
    expect(brief.looseEnds.map((l) => l.text)).toContain('Real loose end');
    expect(brief.looseEnds.map((l) => l.text)).not.toContain('Invented');

    // Every thread is shown somewhere, including the local-only ones.
    const shown = new Set(brief.workstreams.flatMap((w) => w.threadKeys));
    for (const id of ['x', 'y', 'private', 'inproject']) expect(shown.has(keyOf(id))).toBe(true);
  });

  it('drops a workstream whose threads are all invented, and still shows the real threads', async () => {
    const db = await seeded();
    const fetchImpl = claudeFetch([], () => ({ headline: 'h', workstreams: [{ name: 'Ghost', where: 'w', threads: [77], openLoops: [], nextSteps: [] }], looseEnds: [] }));
    const brief = await generateCatchUpBrief(db, claudeSettings(), { days: 30, now: NOW, fetchImpl });
    expect(brief.workstreams.map((w) => w.name)).not.toContain('Ghost');
    expect(new Set(brief.workstreams.flatMap((w) => w.threadKeys)).has(keyOf('x'))).toBe(true);
  });

  it('falls back to the on-device brief with a note when Claude fails', async () => {
    const db = await seeded();
    const brief = await generateCatchUpBrief(db, claudeSettings(), { days: 30, now: NOW, fetchImpl: claudeFetch([], () => ({}), 401) });
    expect(brief.source).toBe('local');
    expect(brief.model).toBeNull();
    expect(brief.note).toMatch(/built on this device/);
    expect(brief.note).toMatch(/rejected the API key/);
    expect(brief.threadCount).toBe(4);
  });

  it('does not call Claude when every recent thread is local-only', async () => {
    const db = freshDb();
    await upsertThread(db, input('p', 1, { cloudExcluded: true }));
    const calls: Call[] = [];
    const brief = await generateCatchUpBrief(db, claudeSettings(), { days: 30, now: NOW, fetchImpl: claudeFetch(calls, () => ({})) });
    expect(calls).toHaveLength(0);
    expect(brief.source).toBe('local');
    expect(brief.note).toMatch(/1 local-only conversation was summarized/);
  });
});

describe('last brief storage', () => {
  afterEach(() => localStorage.clear());
  const brief: CatchUpBrief = buildLocalBrief([thread({ threadKey: 'k1' })], { sinceMs: NOW - 30 * DAY, days: 30, now: NOW });

  it('round-trips through localStorage', async () => {
    expect(await loadLastBrief()).toBeNull();
    await saveLastBrief(brief);
    expect(await loadLastBrief()).toEqual(brief);
  });

  it('rejects malformed stored values instead of rendering them', async () => {
    for (const bad of ['{"headline": 3}', 'not json', '[]', JSON.stringify({ ...brief, workstreams: [{ name: 'x' }] }), JSON.stringify({ ...brief, source: 'other' })]) {
      localStorage.setItem('tk_last_catch_up', bad);
      expect(await loadLastBrief()).toBeNull();
    }
  });
});
