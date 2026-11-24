import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ThreadStackDB, ensureStarterCollectionsAndSettings, saveSettingsPatch, upsertThread, type UpsertThreadInput } from '../../src/core/db.js';
import {
  buildThreadKey,
  insightKeyFor,
  type AgentRunFacts,
  type ConversationRecord,
  type MessageRecord,
  type ThreadInsight,
} from '../../src/core/schema.js';
import { LOCAL_ANALYZER_MODEL, analyzeThreadLocally, extractAgentFacts, resolveInsight } from '../../src/core/insights.js';
import { ThreadAnalysisSchema, buildAnalysisRequest, type ThreadAnalysis } from '../../src/core/ai/claude.js';
import {
  accountLabelForThread,
  analysisToInsight,
  analyzeThreadRemotely,
  needsAgentRunUpgrade,
  queueAnalysis,
} from '../../src/core/pipeline.js';
import { buildSummaryMarkdown } from '../../src/core/summary-markdown.js';
import { buildThreadEmbeddingDocument } from '../../src/core/embeddings.js';
import { collectCatchUpThreads, generateCatchUpBrief } from '../../src/core/catch-up.js';
import { normalizeSettings } from '../../src/core/schema.js';
import { primaryAccountId } from '../../src/core/workspace/realms.js';

let n = 0;
const freshDb = () => new ThreadStackDB(`AgentRunDB_${Date.now()}_${++n}`);
const ACCOUNT = { accountId: 'acct_test', workspaceId: 'ws_test' };

function msgs(rows: Array<[MessageRecord['role'], string]>): MessageRecord[] {
  return rows.map(([role, content], ordinal) => ({
    messageKey: `m${ordinal}`,
    threadKey: 't',
    ordinal,
    sourceMessageId: `s${ordinal}`,
    role,
    content,
    createdAt: null,
    contentHash: `h${ordinal}`,
    hasCode: false,
    hasArtifact: false,
    branchPath: 'main',
  }));
}

function conv(patch: Partial<ConversationRecord> = {}): ConversationRecord {
  return {
    threadKey: 't',
    provider: 'claude_code',
    accountId: 'a',
    workspaceId: 'w',
    sourceConversationId: 'c',
    branchId: 'main',
    parentBranchId: null,
    siblingBranchIds: [],
    canonicalUrl: 'https://claude.ai/code/session_1',
    title: 'Fix the login redirect',
    manualTitleOverride: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    lastCapturedAt: '2026-11-02T10:00:00.000Z',
    sourceRevision: 1,
    contentHash: 'h',
    coverage: 'full',
    captureSource: 'history_sync',
    messageCount: 4,
    project: 'Unfiled',
    categoryLocked: false,
    tags: [],
    manualTags: [],
    workflowState: 'active',
    manualNotes: '',
    pinned: false,
    snoozedUntil: null,
    dismissedQueues: [],
    cloudExcluded: false,
    cloudTaskStatus: 'unsupported',
    isSyntheticBenchmark: false,
    latestDecisionText: null,
    latestDecisionMsgIndex: null,
    latestDecisionSpeaker: null,
    nextStepText: null,
    nextStepMsgIndex: null,
    nextStepSpeaker: null,
    ...patch,
  } as ConversationRecord;
}

const NOW = Date.parse('2026-11-03T12:00:00.000Z');

/** The shape CLI imports write: "[tool] Name: detail", then "[tool result]" or "[tool error]". */
const CLAUDE_CODE = msgs([
  ['user', 'The login redirect loops after sign in. Fix it and open a pull request.'],
  ['assistant', 'I will look at the auth guard first.'],
  ['tool', '[tool] Read: src/auth/guard.ts\n[tool result] export function guard() {}'],
  ['tool', '[tool] Bash: git checkout -b fix/login-redirect\n[tool result] Switched to a new branch'],
  ['tool', '[tool] Edit: src/auth/guard.ts\n[tool result] updated'],
  ['tool', '[tool] MultiEdit: src/auth/redirect.ts\n[tool result] updated'],
  ['tool', '[tool] Edit: src/auth/guard.ts\n[tool result] updated'],
  ['tool', '[tool] Bash: npm test\n[tool error] FAIL tests/guard.test.ts\n 2 failed | 10 passed'],
  ['tool', '[tool] Bash: git remote add origin git@github.com:Acme/Webapp.git\n[tool result] '],
  ['assistant', 'Two tests still fail in guard.test.ts.'],
]);

describe('extractAgentFacts', () => {
  it('reads a Claude Code style transcript', () => {
    const facts = extractAgentFacts(conv(), CLAUDE_CODE)!;
    expect(facts).not.toBeNull();
    expect(facts.filesChanged).toEqual(['src/auth/guard.ts', 'src/auth/redirect.ts']);
    expect(facts.branch).toBe('fix/login-redirect');
    expect(facts.repository).toBe('acme/webapp');
    expect(facts.tests.status).toBe('failing');
    expect(facts.tests.detail).toMatch(/failed/);
    const test = facts.commandsRun.find((c) => c.command === 'npm test');
    expect(test?.outcome).toBe('failed');
    expect(facts.commandsRun.find((c) => c.command.startsWith('git checkout'))?.outcome).toBe('ok');
    expect(facts.blockedOn).toBe('none');
    expect(facts.runState).toBe('finished');
  });

  it('reads a Codex style transcript with apply_patch and a pull request', () => {
    const codex = msgs([
      ['user', 'Add retry to the uploader'],
      ['tool', '[tool] shell: git switch -c feature/uploader-retry\n[tool result] Switched to a new branch'],
      ['tool', "[tool] apply_patch: *** Begin Patch\n*** Update File: src/uploader.ts\n@@\n+retry\n*** Add File: src/retry.ts\n+x\n*** End Patch\n[tool result] Success. Updated the following files"],
      ['tool', '[tool] shell: pnpm test\n[tool result] Tests  14 passed (14)'],
      ['tool', '[tool] shell: gh pr create --fill\n[tool result] https://github.com/Acme/Uploader/pull/42'],
      ['assistant', 'Opened https://github.com/Acme/Uploader/pull/42 for review.'],
    ]);
    const facts = extractAgentFacts(conv({ provider: 'codex' }), codex)!;
    expect(facts.filesChanged).toEqual(['src/uploader.ts', 'src/retry.ts']);
    expect(facts.branch).toBe('feature/uploader-retry');
    expect(facts.tests).toEqual({ status: 'passing', detail: 'Tests 14 passed (14)' });
    expect(facts.pullRequests).toEqual([{ url: 'https://github.com/acme/uploader/pull/42', state: 'unknown' }]);
    expect(facts.repository).toBe('acme/uploader');
  });

  it('marks merged pull requests and prefers the record over the transcript', () => {
    const facts = extractAgentFacts(
      conv({ repository: 'Acme/Other', gitBranch: 'main' }),
      msgs([
        ['user', 'ship it'],
        ['assistant', 'https://github.com/acme/other/pull/7 was merged. Done.'],
      ])
    )!;
    expect(facts.pullRequests[0]).toEqual({ url: 'https://github.com/acme/other/pull/7', state: 'merged' });
    expect(facts.repository).toBe('acme/other');
    expect(facts.branch).toBe('main');
  });

  it('keeps at most 15 files and the newest 8 commands, and reports tests as not run', () => {
    const rows: Array<[MessageRecord['role'], string]> = [['user', 'go']];
    for (let i = 0; i < 20; i++) rows.push(['tool', `[tool] Write: src/f${i}.ts\n[tool result] ok`]);
    for (let i = 0; i < 12; i++) rows.push(['tool', `[tool] Bash: echo ${i}\n[tool result] ${i}`]);
    const facts = extractAgentFacts(conv(), msgs(rows))!;
    expect(facts.filesChanged).toHaveLength(15);
    expect(facts.commandsRun).toHaveLength(8);
    expect(facts.commandsRun[7].command).toBe('echo 11');
    expect(facts.tests).toEqual({ status: 'not_run', detail: null });
  });

  it('detects what the run is waiting on and maps the observed state', () => {
    const permission = extractAgentFacts(
      conv(),
      msgs([
        ['user', 'deploy'],
        ['tool', '[tool] Bash: ./deploy.sh\n[tool error] The user doesn\'t want to proceed with this tool use.'],
      ])
    )!;
    expect(permission.blockedOn).toBe('permission');
    expect(permission.runState).toBe('awaiting_user');

    const input = extractAgentFacts(conv(), msgs([['user', 'pick a db'], ['assistant', 'Should I use Postgres or SQLite for this?']]))!;
    expect(input.blockedOn).toBe('input');

    const observed = extractAgentFacts(conv({ agentState: 'running' }), msgs([['user', 'x'], ['tool', '[tool] Bash: ls\n[tool result] a']]))!;
    expect(observed.runState).toBe('running');
    expect(extractAgentFacts(conv({ agentState: 'failed' }), CLAUDE_CODE)!.runState).toBe('errored');
    expect(extractAgentFacts(conv({ agentState: 'turn_complete' }), CLAUDE_CODE)!.runState).toBe('finished');
    expect(extractAgentFacts(conv({ agentState: 'waiting_answer' }), CLAUDE_CODE)!.runState).toBe('awaiting_user');
  });

  it('returns null for chats without tool messages', () => {
    expect(extractAgentFacts(conv({ provider: 'chatgpt' }), msgs([['user', 'hi'], ['assistant', 'hello']]))).toBeNull();
    const local = analyzeThreadLocally(conv({ provider: 'chatgpt' }), msgs([['user', 'hi there friend'], ['assistant', 'hello']]), { nowMs: NOW });
    expect(local.insight.agentRun).toBeUndefined();
  });
});

describe('status inference with agent facts', () => {
  const at = (patch: Partial<ConversationRecord>, rows = CLAUDE_CODE) =>
    analyzeThreadLocally(conv(patch), rows, { nowMs: NOW }).insight;

  it('uses the local analyzer v3 and stores the facts on the local insight', () => {
    expect(LOCAL_ANALYZER_MODEL).toBe('local-heuristics-v3');
    expect(at({}).agentRun?.filesChanged).toContain('src/auth/guard.ts');
  });

  it('asks for review when the observed state needs the person', () => {
    const approval = at({ agentState: 'waiting_permission' });
    expect(approval.suggestedStatus).toBe('needs_review');
    expect(approval.statusReason).toMatch(/waiting for your approval/);
    expect(at({ agentState: 'waiting_answer' }).statusReason).toMatch(/waiting on your answer/);
    expect(at({ agentState: 'failed' }).suggestedStatus).toBe('needs_review');
  });

  it('asks for review when the transcript shows a denied approval', () => {
    const insight = at({}, msgs([['user', 'go'], ['tool', '[tool] Bash: rm -rf dist\n[tool error] Permission denied: requires approval']]));
    expect(insight.suggestedStatus).toBe('needs_review');
    expect(insight.agentRun?.blockedOn).toBe('permission');
  });

  it('keeps failing tests active', () => {
    const insight = at({});
    expect(insight.suggestedStatus).toBe('active');
    expect(insight.statusReason).toMatch(/Tests are failing/);
  });

  it('asks for review of an open pull request once the run finished', () => {
    const rows = msgs([
      ['user', 'open a PR'],
      ['tool', '[tool] Bash: gh pr create\n[tool result] https://github.com/acme/app/pull/9'],
      ['assistant', 'Opened the pull request.'],
    ]);
    const insight = at({}, rows);
    expect(insight.suggestedStatus).toBe('needs_review');
    expect(insight.statusReason).toBe('Pull request is open for review');
    // A merged one is not waiting for review.
    const merged = at({}, msgs([['user', 'x'], ['assistant', 'https://github.com/acme/app/pull/9 is merged.']]));
    expect(merged.suggestedStatus).toBe('active');
  });

  it('keeps the rules for threads without agent facts', () => {
    const chat = analyzeThreadLocally(
      conv({ provider: 'chatgpt' }),
      msgs([['user', 'Help me plan the launch'], ['assistant', 'Would you like me to draft the timeline first?']]),
      { nowMs: NOW }
    ).insight;
    expect(chat.suggestedStatus).toBe('needs_review');
    expect(chat.statusReason).toMatch(/waiting on your answer/);
  });

  it('classifies any coding-agent provider as coding', () => {
    const insight = analyzeThreadLocally(conv({ provider: 'codex', title: 'Add uploader' }), msgs([['user', 'do the thing now'], ['assistant', 'done.']]), { nowMs: NOW }).insight;
    expect(insight.kind).toBe('coding');
  });
});

const AGENT_RUN: NonNullable<ThreadAnalysis['agentRun']> = {
  repository: 'Acme/Webapp',
  branch: null,
  pullRequests: [{ url: 'https://github.com/acme/webapp/pull/3?diff=split', state: 'open' }],
  filesChanged: ['src/a.ts'],
  commandsRun: [{ command: 'npm test', outcome: 'ok' }],
  tests: { status: 'passing', detail: '12 passed' },
  blockedOn: 'none',
  runState: 'unknown',
};

const ANALYSIS: ThreadAnalysis = {
  title: 'Login redirect fix',
  gist: 'Redirect loop fixed in the auth guard; tests pass.',
  overview: ['The auth guard looped after sign in.', 'It now stops at the first redirect.'],
  userGoal: 'Stop the redirect loop',
  outcome: null,
  kind: 'debugging',
  topics: ['auth'],
  entities: [],
  project: null,
  status: 'active',
  statusReason: 'Pull request open',
  keyPoints: [],
  whereYouLeftOff: { text: 'The guard was fixed.', nextStep: null, messageNumber: 1, quote: 'redirect loop' },
  decisions: [],
  actionItems: [],
  openQuestions: [],
  produced: [],
  agentRun: null,
};

describe('analysis schema and mapping', () => {
  it('requires agentRun, nullable, with no length constraints', () => {
    const json = JSON.stringify(z.toJSONSchema(ThreadAnalysisSchema));
    expect(json).not.toMatch(/minItems|maxItems|minLength|maxLength/);
    expect(() => ThreadAnalysisSchema.parse(ANALYSIS)).not.toThrow();
    expect(() => ThreadAnalysisSchema.parse({ ...ANALYSIS, agentRun: AGENT_RUN })).not.toThrow();
    const { agentRun: _omitted, ...without } = ANALYSIS;
    expect(() => ThreadAnalysisSchema.parse(without)).toThrow();
  });

  it('copies null for non-agent threads and normalizes and fills a non-null run', () => {
    const c = conv({ gitBranch: 'fix/x', agentState: 'turn_complete', pullRequestUrl: 'https://github.com/acme/webapp/pull/4' });
    const plain = analysisToInsight(c, ANALYSIS, CLAUDE_CODE, 'claude-opus-5-5', undefined);
    expect(plain.agentRun).toBeNull();
    const run = analysisToInsight(c, { ...ANALYSIS, agentRun: AGENT_RUN }, CLAUDE_CODE, 'claude-opus-5-5', undefined).agentRun!;
    expect(run.repository).toBe('acme/webapp');
    expect(run.branch).toBe('fix/x');
    expect(run.runState).toBe('finished');
    expect(run.pullRequests).toEqual([
      { url: 'https://github.com/acme/webapp/pull/3', state: 'open' },
      { url: 'https://github.com/acme/webapp/pull/4', state: 'unknown' },
    ]);
  });

  it('clamps list sizes', () => {
    const big: NonNullable<ThreadAnalysis['agentRun']> = {
      ...AGENT_RUN,
      filesChanged: Array.from({ length: 40 }, (_, i) => `f${i}.ts`),
      commandsRun: Array.from({ length: 20 }, (_, i) => ({ command: `c${i}`, outcome: 'ok' as const })),
    };
    const run = analysisToInsight(conv(), { ...ANALYSIS, agentRun: big }, CLAUDE_CODE, 'm', undefined).agentRun!;
    expect(run.filesChanged).toHaveLength(15);
    expect(run.commandsRun).toHaveLength(8);
    expect(run.commandsRun[7].command).toBe('c19');
  });

  it('keeps the AI run in resolveInsight and falls back to the local one', () => {
    const c = conv();
    const local = analyzeThreadLocally(c, CLAUDE_CODE, { nowMs: NOW }).insight;
    const aiNull = analysisToInsight(c, ANALYSIS, CLAUDE_CODE, 'm', local);
    expect(resolveInsight(c, local, aiNull)?.agentRun).toEqual(local.agentRun);
    const aiRun = analysisToInsight(c, { ...ANALYSIS, agentRun: AGENT_RUN }, CLAUDE_CODE, 'm', local);
    expect(resolveInsight(c, local, aiRun)?.agentRun?.tests.status).toBe('passing');
    const oldAi: ThreadInsight = { ...aiRun, sourceRevision: 0 };
    expect(resolveInsight(c, local, oldAi)?.agentRun?.tests.status).toBe('passing');
  });
});

describe('analysis request header', () => {
  const base = {
    title: 'Fix',
    providerLabel: 'Claude Code',
    providerProjectName: null,
    workspacePath: null,
    updatedAt: null,
    messages: [{ ordinal: 0, role: 'user', content: 'hello there' }],
    projects: [],
    knownTags: [],
  };

  it('adds the agent lines only when present', () => {
    const bare = buildAnalysisRequest(base).user;
    for (const label of ['Repository:', 'Branch:', 'Pull request:', 'Account:', 'Model:', 'Agent:', 'Observed run state:']) {
      expect(bare).not.toContain(label);
    }
    const full = buildAnalysisRequest({
      ...base,
      repository: 'acme/webapp',
      branch: 'fix/x',
      pullRequestUrl: 'https://github.com/acme/webapp/pull/3',
      accountLabel: 'Work',
      model: 'claude-opus-5-5',
      agentLabel: 'Builder',
      observedRunState: 'Needs approval',
    });
    expect(full.user).toContain('Repository: acme/webapp');
    expect(full.user).toContain('Branch: fix/x');
    expect(full.user).toContain('Pull request: https://github.com/acme/webapp/pull/3');
    expect(full.user).toContain('Account: Work');
    expect(full.user).toContain('Model: claude-opus-5-5');
    expect(full.user).toContain('Agent: Builder');
    expect(full.user).toContain('Observed run state: Needs approval');
    expect(full.system).toMatch(/Coding-agent sessions/);
    expect(full.system).toMatch(/You organize one person's library/);
  });
});

async function seedAgent(db: ThreadStackDB, patch: Partial<UpsertThreadInput> = {}) {
  const settings = await ensureStarterCollectionsAndSettings(db);
  await saveSettingsPatch(db, { anthropicApiKey: 'sk-ant-test', autoOrganize: { ...settings.autoOrganize, aiDebounceSeconds: 0 } });
  const input: UpsertThreadInput = {
    threadKey: buildThreadKey({ provider: 'claude_code', ...ACCOUNT, sourceConversationId: 's1', branchId: 'main' }),
    provider: 'claude_code',
    ...ACCOUNT,
    sourceConversationId: 's1',
    branchId: 'main',
    canonicalUrl: 'https://claude.ai/code/session_s1',
    title: 'Fix the login redirect',
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-02T10:00:00.000Z',
    coverage: 'full',
    captureSource: 'history_sync',
    messages: CLAUDE_CODE.map((m, i) => ({ sourceMessageId: `m${i}`, role: m.role, content: m.content, createdAt: null })),
    ...patch,
  };
  await upsertThread(db, input);
  const c = (await db.conversations.get(input.threadKey))!;
  return { input, conv: c };
}

function aiInsight(c: ConversationRecord, extra: Partial<ThreadInsight> = {}): ThreadInsight {
  return { ...analysisToInsight(c, ANALYSIS, CLAUDE_CODE, 'claude-opus-5-5', undefined), ...extra };
}

describe('needsAgentRunUpgrade', () => {
  it('is true only for current-format AI insights of coding agents with no agentRun', async () => {
    const c = conv();
    const withRun = aiInsight(c);
    const { agentRun: _drop, ...older } = withRun;
    expect(needsAgentRunUpgrade(c, older as ThreadInsight)).toBe(true);
    expect(needsAgentRunUpgrade(c, withRun)).toBe(false); // null: Claude already read it
    expect(needsAgentRunUpgrade(conv({ provider: 'chatgpt' }), older as ThreadInsight)).toBe(false);
    expect(needsAgentRunUpgrade(c, { ...(older as ThreadInsight), source: 'local' })).toBe(false);
    expect(needsAgentRunUpgrade(c, undefined)).toBe(false);
  });

  it('is acted on by an explicit request and never by automatic work', async () => {
    const db = freshDb();
    const { conv: c } = await seedAgent(db);
    const { agentRun: _drop, ...older } = aiInsight(c);
    await db.insights.put(older as ThreadInsight);

    const calls: unknown[] = [];
    const fetchImpl = (async (_i: RequestInfo | URL, init?: RequestInit) => {
      calls.push(init?.body);
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify({ ...ANALYSIS, agentRun: AGENT_RUN }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;

    const automatic = await analyzeThreadRemotely(db, c.threadKey, { fetchImpl });
    expect(automatic.status).not.toBe('analyzed');
    expect(calls).toHaveLength(0);

    const queued = await queueAnalysis(db, [c.threadKey]);
    expect(queued).toMatchObject({ queued: 1, upgrades: 1 });
    const requested = await analyzeThreadRemotely(db, c.threadKey, { fetchImpl, requested: true });
    expect(requested.status).toBe('analyzed');
    expect(calls).toHaveLength(1);
    const stored = await db.insights.get(insightKeyFor('ai', c.threadKey));
    expect(stored?.agentRun?.tests.status).toBe('passing');
    // The request carried the repository from the capture, not an account id.
    const body = String(calls[0]);
    expect(body).not.toContain('acct_test');
  });
});

describe('account label', () => {
  it('reads the label of the account that owns the thread, or the primary account for the legacy id', async () => {
    const db = freshDb();
    const settings = normalizeSettings({});
    const base = { realm: 'claude', color: 'teal' as const, mode: 'embedded' as const, identity: null, signedIn: 'yes' as const, hasJar: false, order: 0, createdAt: 'x', lastActiveAt: null };
    await db.accounts.bulkPut([
      { ...base, id: primaryAccountId('claude'), label: 'Personal', primary: true },
      { ...base, id: 'acct_ab12', label: 'Work', primary: false },
    ]);
    expect(await accountLabelForThread(db, { provider: 'claude_code', accountId: 'acct_ab12' }, settings)).toBe('Work');
    const legacy = settings.boundAccounts.claude_code.accountId;
    const label = await accountLabelForThread(db, { provider: 'claude_code', accountId: legacy }, settings);
    expect(['Personal', null]).toContain(label);
    expect(await accountLabelForThread(db, { provider: 'claude_code', accountId: 'gone' }, settings)).toBeNull();
  });

  it('never returns the signed-in identity or an email address as the label', async () => {
    const db = freshDb();
    const settings = normalizeSettings({});
    const base = { realm: 'claude', color: 'teal' as const, mode: 'embedded' as const, signedIn: 'yes' as const, hasJar: false, order: 0, createdAt: 'x', lastActiveAt: null, primary: false };
    await db.accounts.bulkPut([
      { ...base, id: 'acct_mail', label: 'someone@realmail.com', identity: null },
      { ...base, id: 'acct_name', label: 'Sam Example', identity: { key: 'claude:abc', display: 'Sam Example' } as never },
      { ...base, id: 'acct_mixed', label: 'Work (sam@corp.example)', identity: null },
    ]);
    for (const accountId of ['acct_mail', 'acct_name', 'acct_mixed']) {
      expect(await accountLabelForThread(db, { provider: 'claude_code', accountId }, settings)).toBeNull();
    }
  });
});

describe('embedding document and Markdown', () => {
  const c = conv();
  const local = analyzeThreadLocally(c, CLAUDE_CODE, { nowMs: NOW }).insight;
  const withRun: ThreadInsight = { ...local, agentRun: { ...(local.agentRun as AgentRunFacts), pullRequests: [{ url: 'https://github.com/acme/webapp/pull/3', state: 'open' }] } };

  it('adds Repository, Branch, Pull request and Files lines only for runs', () => {
    const doc = buildThreadEmbeddingDocument(c, withRun, CLAUDE_CODE);
    expect(doc).toContain('Repository: acme/webapp');
    expect(doc).toContain('Branch: fix/login-redirect');
    expect(doc).toContain('Pull request: https://github.com/acme/webapp/pull/3');
    expect(doc).toContain('Files: src/auth/guard.ts, src/auth/redirect.ts');
    const plain = buildThreadEmbeddingDocument(conv({ provider: 'chatgpt' }), { ...local, agentRun: undefined }, CLAUDE_CODE);
    expect(plain).not.toMatch(/^(Repository|Branch|Pull request|Files):/m);
  });

  it('writes an Agent run block before Context, only when the run exists', () => {
    const md = buildSummaryMarkdown({ conv: c, insight: withRun, summary: null });
    expect(md).toContain('## Agent run');
    expect(md).toContain('- **Repository:** `acme/webapp`');
    expect(md).toContain('- **Pull requests:** <https://github.com/acme/webapp/pull/3>');
    expect(md).toContain('- **Files changed:** `src/auth/guard.ts`, `src/auth/redirect.ts`');
    expect(md).toContain('  - `npm test` (failed)');
    expect(md).toContain('- **Tests:** failing');
    expect(md.indexOf('## Agent run')).toBeLessThan(md.indexOf('## Context'));
    const none = buildSummaryMarkdown({ conv: c, insight: { ...local, agentRun: undefined }, summary: null });
    expect(none).not.toContain('Agent run');
    const nullRun = buildSummaryMarkdown({ conv: c, insight: { ...local, agentRun: null }, summary: null });
    expect(nullRun).not.toContain('Agent run');
  });
});

describe('privacy', () => {
  it('sends nothing for a local-only agent thread, in analysis and in catch up', async () => {
    const db = freshDb();
    const { conv: c } = await seedAgent(db, { cloudExcluded: true, repository: 'acme/webapp', pullRequestUrl: 'https://github.com/acme/webapp/pull/3' });
    let sent = 0;
    const fetchImpl = (async () => {
      sent++;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;
    const result = await analyzeThreadRemotely(db, c.threadKey, { fetchImpl, requested: true });
    expect(result.status).toBe('skipped');
    const settings = normalizeSettings({ anthropicApiKey: 'sk-ant-test' });
    const brief = await generateCatchUpBrief(db, settings, { days: 30, now: NOW, fetchImpl });
    expect(sent).toBe(0);
    expect(brief.source).toBe('local');
    expect(brief.withheld).toBe(1);
  });

  it('puts run facts, not message text, in the catch-up request', async () => {
    const db = freshDb();
    const { conv: c } = await seedAgent(db, { repository: 'acme/webapp', pullRequestUrl: 'https://github.com/acme/webapp/pull/3', agentState: 'waiting_permission' });
    await db.insights.put(analyzeThreadLocally(c, CLAUDE_CODE, { nowMs: NOW }).insight);
    const settings = normalizeSettings({ anthropicApiKey: 'sk-ant-test' });
    const rows = await collectCatchUpThreads(db, settings, { sinceMs: NOW - 30 * 86_400_000 });
    expect(rows[0]).toMatchObject({ repository: 'acme/webapp', testsStatus: 'failing', runState: 'awaiting_user' });

    const bodies: string[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input, init);
      bodies.push(await req.text());
      return new Response(
        JSON.stringify({
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          model: 'claude-opus-5-5',
          content: [{ type: 'text', text: JSON.stringify({ headline: 'h', workstreams: [], looseEnds: [] }) }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          stop_details: null,
          usage: { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      );
    }) as typeof fetch;
    await generateCatchUpBrief(db, settings, { days: 30, now: NOW, fetchImpl });
    const sent = bodies.join('\n');
    expect(sent).toContain('repo acme/webapp');
    expect(sent).toContain('PR https://github.com/acme/webapp/pull/3');
    expect(sent).toContain('tests failing');
    expect(sent).toContain('waiting on permission');
    expect(sent).not.toContain('Switched to a new branch'); // tool output is message text
  });
});
