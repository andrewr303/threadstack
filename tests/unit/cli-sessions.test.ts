import 'fake-indexeddb/auto';
import { zipSync } from 'fflate';
import { describe, it, expect } from 'vitest';
import { ThreadkeeperDB, ensureStarterCollectionsAndSettings } from '../../src/core/db.js';
import {
  isClaudeCodeSideFile,
  parseClaudeCodeSession,
  parseCodexRollout,
  parseCodexSession,
  resolveCodexRollouts,
  type CodexRollout,
} from '../../src/core/cli-sessions.js';
import { detectImportKind, importFiles, readJsonlTree, type DirectoryHandleLike } from '../../src/core/importers.js';

let dbCounter = 0;
function freshDb(): ThreadkeeperDB {
  dbCounter += 1;
  return new ThreadkeeperDB(`CliSessionsTestDB_${dbCounter}_${Date.now()}`);
}

const ACCOUNT = { accountId: 'acct_test', workspaceId: 'ws_test' };
const jsonl = (records: object[]) => records.map((r) => JSON.stringify(r)).join('\n');

async function storedContents(db: ThreadkeeperDB, threadKey: string) {
  const rows = await db.messages.where('threadKey').equals(threadKey).sortBy('ordinal');
  return rows.map((m) => [m.role, m.content]);
}

// ---------------------------------------------------------------- Claude Code

const SESSION = 'b9f1c2d4-1111-4a1a-8a1a-000000000001';
let tick = 0;
const nextTs = () => new Date(Date.UTC(2026, 9, 20, 9, 0, tick++)).toISOString();
const ccUser = (uuid: string, content: unknown, extra: object = {}) => ({
  type: 'user',
  sessionId: SESSION,
  cwd: '/Users/me/code/webhooks',
  gitBranch: 'retry-fix',
  uuid,
  timestamp: nextTs(),
  message: { role: 'user', content },
  ...extra,
});
const ccAssistant = (uuid: string, text: string, extra: object = {}) => ({
  type: 'assistant',
  sessionId: SESSION,
  uuid,
  timestamp: nextTs(),
  message: { id: `msg_${uuid}`, role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text }] },
  ...extra,
});

describe('Claude Code side files', () => {
  it('recognizes subagent, workflow, tool-result, MCP task, memory and set-aside files', () => {
    const side = [
      `-Users-me-api/${SESSION}/subagents/agent-a1b2c3.jsonl`,
      `-Users-me-api/${SESSION}/subagents/workflows/wf_7f3a/agent-d4e5.jsonl`,
      `-Users-me-api/${SESSION}/tool-results/toolu_01.jsonl`,
      `-Users-me-api/${SESSION}/mcp-tasks/task-9.jsonl`,
      '-Users-me-api/memory/session-notes.jsonl',
      '-Users-me-api/agent-0f9e8d.jsonl',
      `-Users-me-api/${SESSION}.orphaned-20261020T090000-ab12.jsonl`,
      `-Users-me-api/${SESSION}.jsonl.superseded-20261020T090000`,
      `projects\\-Users-me-api\\${SESSION}\\subagents\\agent-x.jsonl`,
      'agent-picked-directly.jsonl',
    ];
    for (const path of side) expect(isClaudeCodeSideFile(path), path).toBe(true);
    const main = [`-Users-me-api/${SESSION}.jsonl`, `projects/-Users-me-memory-svc/${SESSION}.jsonl`, `${SESSION}.jsonl`];
    for (const path of main) expect(isClaudeCodeSideFile(path), path).toBe(false);
  });

  it('never imports a side file over the parent thread that shares its sessionId', async () => {
    const db = freshDb();
    const settings = await ensureStarterCollectionsAndSettings(db);
    const main = jsonl([
      ccUser('u1', 'Why does the payment webhook retry twice?'),
      ccAssistant('a1', 'The handler times out after 10 s, so Stripe retries.'),
    ]);
    // Side transcripts reuse the parent's sessionId and do not all mark isSidechain.
    const side = jsonl([
      ccUser('s1', 'Search the codebase for the retry limit'),
      ccAssistant('s2', 'RETRY_LIMIT=2 in config.ts'),
    ]);
    const dir = '-Users-me-code-webhooks';
    const report = await importFiles(db, settings, [
      { name: `${dir}/${SESSION}.jsonl`, text: main },
      { name: `${dir}/${SESSION}/subagents/agent-a1b2.jsonl`, text: side },
      { name: `${dir}/${SESSION}/subagents/workflows/wf_9/agent-c3.jsonl`, text: side },
      { name: `${dir}/${SESSION}/tool-results/toolu_1.jsonl`, text: side },
      { name: `${dir}/${SESSION}/mcp-tasks/task-1.jsonl`, text: side },
      { name: `${dir}/memory/log.jsonl`, text: side },
      { name: `${dir}/agent-d4e5.jsonl`, text: side },
      { name: `${dir}/${SESSION}.orphaned-20261020-ab12.jsonl`, text: side },
      { name: `${dir}/${SESSION}.jsonl.superseded-20261020`, text: side },
    ]);
    expect(report.imported).toBe(1);
    expect(report.byKind).toEqual({ claude_code: 1 });
    expect(report.unrecognized).toEqual([]);
    expect(await storedContents(db, report.threadKeys[0])).toEqual([
      ['user', 'Why does the payment webhook retry twice?'],
      ['assistant', 'The handler times out after 10 s, so Stripe retries.'],
    ]);
  });

  it('still drops sidechain records inside the main transcript', () => {
    const t = parseClaudeCodeSession(
      jsonl([
        ccUser('u1', 'Rename the queue'),
        ccUser('u2', 'subagent prompt', { isSidechain: true }),
        ccAssistant('a2', 'subagent answer', { isSidechain: true }),
        ccAssistant('a1', 'Renamed to payments-retry.'),
      ]),
      ACCOUNT
    )!;
    expect(t.messages.map((m) => m.content)).toEqual(['Rename the queue', 'Renamed to payments-retry.']);
  });
});

describe('Claude Code titles', () => {
  const summary = { type: 'summary', summary: 'Webhook retry investigation', leafUuid: 'a1' };
  const aiTitle = { type: 'ai-title', sessionId: SESSION, title: 'Fix duplicate webhook retries' };
  const agentName = { type: 'agent-name', sessionId: SESSION, agentName: 'payments-agent' };
  const customTitle = { type: 'custom-title', sessionId: SESSION, customTitle: 'Stripe retry bug' };
  const titleOf = (before: object[], after: object[] = []) =>
    parseClaudeCodeSession(
      jsonl([...before, ccUser('u1', 'Why does the payment webhook retry twice?'), ccAssistant('a1', 'Timeouts.'), ...after]),
      ACCOUNT
    )!.title;

  it('prefers custom-title, then agent-name, then ai-title, then summary, then the first prompt', () => {
    expect(titleOf([])).toBe('Why does the payment webhook retry twice?');
    expect(titleOf([summary])).toBe('Webhook retry investigation');
    expect(titleOf([summary], [aiTitle])).toBe('Fix duplicate webhook retries');
    expect(titleOf([summary], [aiTitle, agentName])).toBe('payments-agent');
    expect(titleOf([customTitle, summary], [aiTitle, agentName])).toBe('Stripe retry bug');
  });

  it('reads the title field names defensively and lets a later rename win', () => {
    expect(titleOf([{ type: 'custom-title', title: '  Retry   storm  ' }])).toBe('Retry storm');
    expect(titleOf([{ type: 'custom-title', name: 'Named via name' }])).toBe('Named via name');
    expect(titleOf([{ type: 'agent-name', name: 'deploy-agent' }])).toBe('deploy-agent');
    expect(titleOf([{ type: 'agent-name', title: 'titled-agent' }])).toBe('titled-agent');
    expect(titleOf([{ type: 'ai-title', aiTitle: 'Webhook timeouts' }])).toBe('Webhook timeouts');
    expect(titleOf([{ type: 'custom-title', customTitle: 'First name' }], [{ type: 'custom-title', customTitle: 'Second name' }])).toBe(
      'Second name'
    );
    // an empty rename record does not blank out the earlier title
    expect(titleOf([{ type: 'custom-title', customTitle: 'Kept' }], [{ type: 'custom-title', customTitle: '  ' }])).toBe('Kept');
  });
});

describe('Claude Code local_command system records', () => {
  it('keeps readable slash commands and ignores command output and other system records', () => {
    const system = (content: string, extra: object = {}) => ({
      type: 'system',
      subtype: 'local_command',
      sessionId: SESSION,
      uuid: `sys_${tick}`,
      timestamp: nextTs(),
      level: 'info',
      content,
      ...extra,
    });
    const t = parseClaudeCodeSession(
      jsonl([
        ccUser('u1', 'Review the auth middleware'),
        system('<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>src/auth.ts</command-args>'),
        system('<local-command-stdout>Reviewing src/auth.ts…</local-command-stdout>'),
        system('<command-name>/clear</command-name>\n<command-args></command-args>'),
        system('Status line without a command envelope'),
        system('<command-name>/compact</command-name>', { subtype: 'turn_duration' }),
        system('<command-name>/sidechain-only</command-name>', { isSidechain: true }),
        ccAssistant('a1', 'The middleware accepts expired tokens for 5 minutes.'),
      ]),
      ACCOUNT
    )!;
    expect(t.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Review the auth middleware'],
      ['user', '/review src/auth.ts'],
      ['assistant', 'The middleware accepts expired tokens for 5 minutes.'],
    ]);
  });
});

// ---------------------------------------------------------------- Codex CLI

const meta = (payload: object, timestamp: string) => ({
  timestamp,
  type: 'session_meta',
  payload: { timestamp, cwd: '/home/me/api', originator: 'codex_cli_rs', cli_version: '0.80.0', source: 'cli', ...payload },
});
const item = (role: 'user' | 'assistant', text: string, timestamp: string) => ({
  timestamp,
  type: 'response_item',
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] },
});
const at = (minute: number, second = 0) => new Date(Date.UTC(2026, 9, 1, 10, minute, second)).toISOString();
const rollout = (records: object[], fileName: string) => parseCodexRollout(jsonl(records), { ...ACCOUNT, fileName })!;

const P = '01990a00-0000-7000-8000-00000000000a';
const F = '01990a00-0000-7000-8000-00000000000b';
const G = '01990a00-0000-7000-8000-00000000000c';
const parentTurns = [
  item('user', 'Add rate limiting to /login', at(0, 1)),
  item('assistant', 'Added a token bucket per IP.', at(0, 5)),
  item('user', 'Make the limit configurable', at(1)),
  item('assistant', 'LOGIN_RATE_LIMIT now sets it.', at(1, 5)),
];
const parentRecords = [meta({ id: P, session_id: P }, at(0)), ...parentTurns];
/** A legacy fork: its own session_meta, then the parent's rollout copied with fresh timestamps, then its own turns. */
const forkRecords = (id: string, parent: string, root: string | null, replay: object[], own: object[], minute = 20) => [
  meta({ id, forked_from_id: parent, ...(root ? { session_id: root } : {}) }, at(minute)),
  ...replay.map((r) => ({ ...r, timestamp: at(minute, 1) })),
  ...own,
];
const forkOwnTurns = [item('user', 'Use Redis for the counters instead', at(21)), item('assistant', 'Counters now live in Redis.', at(21, 9))];
const parentFile = `rollout-2026-10-01T10-00-00-${P}.jsonl`;
const forkFile = `rollout-2026-10-01T10-20-00-${F}.jsonl`;

describe('Codex forks', () => {
  it('files a fork parsed on its own as a branch of its parent, never over the parent thread', () => {
    const t = parseCodexSession(jsonl(forkRecords(F, P, P, parentRecords, forkOwnTurns)), { ...ACCOUNT, fileName: forkFile })!;
    expect(t.sourceConversationId).toBe(P);
    expect(t.branchId).toBe(F);
    expect(t.parentBranchId).toBe('main');
    expect(t.siblingBranchIds).toEqual(['main']);
    expect(t.threadKey).toBe(`codex:acct_test:ws_test:${P}:${F}`);
    expect(t.resumeCommand).toBe(`cd /home/me/api && codex resume ${F}`);
    // without the parent there is nothing to compare against, so the replay stays
    expect(t.messages.map((m) => m.content)).toEqual([...parentTurns, ...forkOwnTurns].map((r) => r.payload.content[0].text));
    expect(t.messages.every((m) => m.branchPath === F)).toBe(true);
  });

  it('drops the replayed parent history when the parent is in the same import, in either order', async () => {
    const parent = rollout(parentRecords, parentFile);
    const fork = rollout(forkRecords(F, P, P, parentRecords, forkOwnTurns), forkFile);
    for (const batch of [[parent, fork], [fork, parent]]) {
      const threads = await resolveCodexRollouts(batch);
      expect(threads).toHaveLength(2);
      const p = threads.find((t) => t.branchId === 'main')!;
      const f = threads.find((t) => t.branchId === F)!;
      expect(p.messages).toHaveLength(4);
      expect(p.siblingBranchIds).toEqual([F]);
      expect(p.coverage).toBe('full');
      expect(f.coverage).toBe('partial');
      expect(f.title).toBe('Use Redis for the counters instead');
      expect(f.messages.map((m) => [m.role, m.content])).toEqual([
        ['system', `Forked from Codex thread ${P}; the 4 earlier messages are on that thread.`],
        ['user', 'Use Redis for the counters instead'],
        ['assistant', 'Counters now live in Redis.'],
      ]);
    }
    // the inputs are not modified
    expect(parent.thread.siblingBranchIds).toBeUndefined();
    expect(fork.thread.messages).toHaveLength(6);
  });

  it('keeps a fork that re-asks the prompt where it split off, and drops a fork with nothing new', async () => {
    const parent = rollout(parentRecords, parentFile);
    const reask = rollout(
      forkRecords(F, P, P, [parentRecords[0], ...parentTurns.slice(0, 2)], [
        item('user', 'Make the limit configurable', at(21)),
        item('assistant', 'Added a --login-rate-limit flag.', at(21, 7)),
      ]),
      forkFile
    );
    const [, f] = await resolveCodexRollouts([parent, reask]);
    expect(f.messages.map((m) => m.content)).toEqual([
      `Forked from Codex thread ${P}; the 2 earlier messages are on that thread.`,
      'Make the limit configurable',
      'Added a --login-rate-limit flag.',
    ]);

    const empty = rollout(forkRecords(F, P, P, parentRecords, []), forkFile);
    const threads = await resolveCodexRollouts([parent, empty]);
    expect(threads.map((t) => t.branchId)).toEqual(['main']);
  });

  it('links nested forks through the root thread and de-duplicates against the direct parent', async () => {
    const parent = rollout(parentRecords, parentFile);
    const forkRecs = forkRecords(F, P, P, parentRecords, forkOwnTurns);
    const fork = rollout(forkRecs, forkFile);
    const nestedOwn = [item('user', 'Expire Redis keys after an hour', at(41)), item('assistant', 'Keys now have a 3600 s TTL.', at(41, 4))];
    const nested = rollout(forkRecords(G, F, P, forkRecs, nestedOwn, 40), `rollout-2026-10-01T10-40-00-${G}.jsonl`);
    const threads = await resolveCodexRollouts([nested, fork, parent]);
    const g = threads.find((t) => t.branchId === G)!;
    expect(g.sourceConversationId).toBe(P);
    expect(g.parentBranchId).toBe(F);
    expect(g.siblingBranchIds).toEqual(['main', F]);
    expect(g.messages.map((m) => m.content).slice(1)).toEqual(['Expire Redis keys after an hour', 'Keys now have a 3600 s TTL.']);
    expect(threads.find((t) => t.branchId === F)!.siblingBranchIds).toEqual(['main', G]);
    expect(threads.find((t) => t.branchId === 'main')!.siblingBranchIds).toEqual([F]);
  });

  it('falls back to forked_from_id as the root on CLIs that do not write session_id', () => {
    const t = parseCodexSession(jsonl(forkRecords(F, P, null, parentRecords, forkOwnTurns)), ACCOUNT)!;
    expect(t.sourceConversationId).toBe(P);
    expect(t.parentBranchId).toBe('main');
    const viaParentThreadId = parseCodexSession(
      jsonl([meta({ id: F, parent_thread_id: P }, at(20)), ...forkOwnTurns]),
      ACCOUNT
    )!;
    expect(viaParentThreadId.threadKey).toBe(`codex:acct_test:ws_test:${P}:${F}`);
  });

  it('de-duplicates against the stored parent when a later sync reads only the fork', async () => {
    const db = freshDb();
    const settings = await ensureStarterCollectionsAndSettings(db);
    const first = await importFiles(db, settings, [{ name: `sessions/2026/10/01/${parentFile}`, text: jsonl(parentRecords) }]);
    expect(first.imported).toBe(1);
    const second = await importFiles(db, settings, [
      { name: `sessions/2026/10/01/${forkFile}`, text: jsonl(forkRecords(F, P, P, parentRecords, forkOwnTurns)) },
    ]);
    expect(second.imported).toBe(1);
    const forkKey = second.threadKeys[0];
    expect(forkKey.endsWith(`:${P}:${F}`)).toBe(true);
    expect(await storedContents(db, forkKey)).toEqual([
      ['system', `Forked from Codex thread ${P}; the 4 earlier messages are on that thread.`],
      ['user', 'Use Redis for the counters instead'],
      ['assistant', 'Counters now live in Redis.'],
    ]);
    // the parent thread is untouched and keeps its own transcript
    expect(await storedContents(db, first.threadKeys[0])).toHaveLength(4);
  });

  it('de-duplicates a fork of a stored fork when a later sync reads only the nested fork', async () => {
    const db = freshDb();
    const settings = await ensureStarterCollectionsAndSettings(db);
    const forkRecs = forkRecords(F, P, P, parentRecords, forkOwnTurns);
    await importFiles(db, settings, [
      { name: `sessions/2026/10/01/${parentFile}`, text: jsonl(parentRecords) },
      { name: `sessions/2026/10/01/${forkFile}`, text: jsonl(forkRecs) },
    ]);
    const nestedOwn = [item('user', 'Expire Redis keys after an hour', at(41)), item('assistant', 'Keys now have a 3600 s TTL.', at(41, 4))];
    const later = await importFiles(db, settings, [
      { name: `sessions/2026/10/01/rollout-2026-10-01T10-40-00-${G}.jsonl`, text: jsonl(forkRecords(G, F, P, forkRecs, nestedOwn, 40)) },
    ]);
    const nestedKey = later.threadKeys[0];
    expect(nestedKey.endsWith(`:${P}:${G}`)).toBe(true);
    expect((await storedContents(db, nestedKey)).slice(1)).toEqual([
      ['user', 'Expire Redis keys after an hour'],
      ['assistant', 'Keys now have a 3600 s TTL.'],
    ]);
  });
});

describe('Codex sub-agent rollouts', () => {
  const S = '01990a00-0000-7000-8000-0000000000d1';
  const spawnedRecords = (markers: object) => [
    meta({ id: S, session_id: P, ...markers }, at(30)),
    ...parentTurns.map((r) => ({ ...r, timestamp: at(30, 1) })),
    item('user', 'Find every caller of rateLimit()', at(30, 2)),
    item('assistant', 'Three callers: login, signup, reset.', at(30, 9)),
  ];
  const variants: Array<[string, object]> = [
    ['agent_role', { agent_role: 'explorer' }],
    ['agent_type alias', { agent_type: 'worker' }],
    ['agent_nickname', { agent_nickname: 'Ada' }],
    ['agent_path', { agent_path: '/root/explorer' }],
    [
      'thread_spawn source',
      { parent_thread_id: P, source: { subagent: { thread_spawn: { parent_thread_id: P, depth: 1 } } } },
    ],
    ['review source', { source: { subagent: 'review' } }],
    ['internal source', { source: { internal: 'memory_consolidation' } }],
    ['thread_source subagent', { thread_source: 'subagent' }],
    ['thread_source guardian_review', { thread_source: 'guardian_review' }],
  ];

  it.each(variants)('never turns a rollout marked by %s into a thread', (_label, markers) => {
    const text = jsonl(spawnedRecords(markers));
    expect(parseCodexRollout(text, ACCOUNT)!.auxiliary).toBe(true);
    expect(parseCodexSession(text, ACCOUNT)).toBeNull();
  });

  it('keeps ordinary sources as threads', () => {
    for (const source of ['cli', 'vscode', 'exec', { custom: 'acme-ide' }]) {
      const text = jsonl([meta({ id: P, source, thread_source: 'user' }, at(0)), ...parentTurns]);
      expect(parseCodexSession(text, ACCOUNT)?.sourceConversationId).toBe(P);
    }
  });

  it('imports the parent once and no sub-agent duplicate', async () => {
    const db = freshDb();
    const settings = await ensureStarterCollectionsAndSettings(db);
    const report = await importFiles(db, settings, [
      { name: `sessions/2026/10/01/${parentFile}`, text: jsonl(parentRecords) },
      {
        name: `sessions/2026/10/01/rollout-2026-10-01T10-30-00-${S}.jsonl`,
        text: jsonl(spawnedRecords({ parent_thread_id: P, agent_nickname: 'Ada', agent_role: 'explorer' })),
      },
    ]);
    expect(report.imported).toBe(1);
    expect(report.byKind).toEqual({ codex: 1 });
    expect(await db.conversations.count()).toBe(1);
  });
});

describe('Codex rollouts that share a thread id', () => {
  const R = '01990a00-0000-7000-8000-0000000000e1';
  const ROLLOUT = '01990a00-0000-7000-8000-0000000000e2';
  const original = [
    meta({ id: R }, at(0)),
    item('user', 'Draft the users.email migration', at(0, 1)),
    item('assistant', 'Draft A: add the column as nullable.', at(0, 5)),
    item('user', 'Also backfill it', at(5)),
    item('assistant', 'Added a backfill script.', at(5, 9)),
  ];
  // thread/revert keeps the thread id and writes a new rollout file named ..._<rolloutId>.jsonl
  const reverted = [
    meta({ id: R }, at(50)),
    item('user', 'Draft the users.email migration', at(50, 1)),
    item('assistant', 'Draft A: add the column as nullable.', at(50, 1)),
    item('user', 'Make it NOT NULL with a default instead', at(51)),
    item('assistant', 'The migration now uses NOT NULL DEFAULT \'\'.', at(51, 6)),
  ];
  const originalFile = `rollout-2026-10-01T10-00-00-${R}.jsonl`;
  const revertedFile = `rollout-2026-10-01T10-50-00-${R}_${ROLLOUT}.jsonl`;

  it('folds them into one thread holding the newest content, in either order', async () => {
    for (const batch of [
      [rollout(original, originalFile), rollout(reverted, revertedFile)],
      [rollout(reverted, revertedFile), rollout(original, originalFile)],
    ]) {
      const threads = await resolveCodexRollouts(batch);
      expect(threads).toHaveLength(1);
      expect(threads[0].sourceConversationId).toBe(R);
      expect(threads[0].messages.map((m) => m.content)).toContain('Make it NOT NULL with a default instead');
      expect(threads[0].messages.map((m) => m.content)).not.toContain('Also backfill it');
    }
  });

  it('breaks a timestamp tie by the later rollout file name', async () => {
    const sameTime = (text: string) => [meta({ id: R }, at(0)), item('user', text, at(1)), item('assistant', 'ok', at(2))];
    const threads = await resolveCodexRollouts([
      rollout(sameTime('from the reverted file'), revertedFile),
      rollout(sameTime('from the original file'), originalFile),
    ]);
    expect(threads[0].title).toBe('from the reverted file');
  });

  it('does not let an older rollout read by a later sync replace the newer stored thread', async () => {
    const db = freshDb();
    const settings = await ensureStarterCollectionsAndSettings(db);
    const first = await importFiles(db, settings, [{ name: revertedFile, text: jsonl(reverted) }]);
    expect(first.imported).toBe(1);
    const second = await importFiles(db, settings, [{ name: originalFile, text: jsonl(original) }]);
    expect(second.imported).toBe(0);
    const stored = await storedContents(db, first.threadKeys[0]);
    expect(stored.map(([, content]) => content)).toContain('Make it NOT NULL with a default instead');
  });
});

describe('Codex .jsonl.zst rollouts', () => {
  // Codex compresses rollouts older than a week with zstd level 3. Generated with
  // Node's zstd stream encoder at level 3 (no content size in the frame header,
  // one compressed block) and verified to round-trip through fzstd.
  const ZST_BASE64 =
    'KLUv/QBYlRMApqt9JhCNOgeOyBiKyafgjkMRr/1hJqnavsvE7eY9wI7BQaOSIAAAAQANdABtAHIAdCkkacUvr1SSVpQmS834dzobsqwknV8OKYTlYq/FXjOy+DsliV8OHVMAxYAMrBMfhvFAiHEM6GDWoRxMI7oJghju75SseKfgtCgQ+3LYe0k8Za1b/74Ypb8cwjnXOPecewPu4RzGMRgBxzl/xy7YdS/Zrwgy4r35y+nW7O9rTfrlW8Fa97q2pbSVJ1aXnnmah2ms+ru11Lx6ss0zSkyzZgBUKpW3rJoIF9eMzZRFWlaLxatYd+TvFs0kCp0t68SWfnltuvHvkciQTq94b1l9ubTi3zfSbNYvd40baNzfecoaj67FmkVlybTO5mSmbUOK4mUa5J5Js2rlxWa0mEfLo0iF06OI94hieF0zPqr4e23eK6so3MgF+cstC0aJp+zIGSRAovKGAilJDxrPVpdKbLKtZVs6ITu1bRglRDbd2B4WHq1iWcGubSPdtmFPhz+pM4wDAJWKZWX8PiEssxkl3onZVb2k5qXYp4EcjnMahcKMoUJznFZlo0iWCSYsK27UUnBaSxvFsPWcIi0lrWWjVrK8tCW0hu40Oza0hvNohl1lrRB69GBAaAKOcxr0POh5AU5rOK1jQwHdhhj05Efv0Zd3hnU2pUZFIi0gUCIyM0kPDAsnLr/DMfhEhUHgWMtaCy9cSQZQiQOWjPtSDxwD8JJyWTqDRRdWf/XHoHADzXC7A2x0xwbhAjsMuORhc0VobcEJ1iMhZIuYFBa5uThLI/sOBmTWvcqPvsPgFaDu2l5Od5dPfC6OXrHKMrD3piSthSg=';
  const zst = () => Uint8Array.from(atob(ZST_BASE64), (c) => c.charCodeAt(0));
  const ZST_ID = '0199b0c4-7d2e-7a10-9a51-5c2e8f1d3b7a';
  const zstName = `archived_sessions/rollout-2026-10-20T08-00-00-${ZST_ID}.jsonl.zst`;

  it('decompresses and imports a compressed rollout, also from inside a zip', async () => {
    for (const input of [
      { name: zstName, bytes: zst() },
      { name: 'codex-backup.zip', bytes: zipSync({ [zstName]: zst() }) },
    ]) {
      const db = freshDb();
      const settings = await ensureStarterCollectionsAndSettings(db);
      const report = await importFiles(db, settings, [input]);
      expect(report.errors).toEqual([]);
      expect(report.byKind).toEqual({ codex: 1 });
      const conv = await db.conversations.get(report.threadKeys[0]);
      expect(conv).toMatchObject({
        sourceConversationId: ZST_ID,
        title: 'Rotate the staging TLS certificate before it expires on Friday.',
        providerProjectName: 'infra',
        gitBranch: 'certs',
        modelSlug: 'gpt-5.5-codex',
        workspacePath: '/home/me/infra',
        updatedAt: '2026-10-20T08:00:09.500Z',
      });
      expect((await storedContents(db, report.threadKeys[0])).map(([role]) => role)).toEqual(['user', 'tool', 'assistant']);
    }
  });

  it('reports a truncated .zst as an error and imports the other files', async () => {
    const db = freshDb();
    const settings = await ensureStarterCollectionsAndSettings(db);
    const truncated = zst().subarray(0, 300);
    const report = await importFiles(db, settings, [
      { name: zstName, bytes: truncated },
      { name: `sessions/2026/10/01/${parentFile}`, text: jsonl(parentRecords) },
    ]);
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0].startsWith(`${zstName}: `)).toBe(true);
    expect(report.byKind).toEqual({ codex: 1 });
  });

  it('detects a single-line compressed rollout name as Codex', () => {
    expect(detectImportKind('rollout-x.jsonl.zst', JSON.stringify(meta({ id: P }, at(0))))).toBe('codex');
  });
});

describe('Session folder walk', () => {
  type Tree = { [name: string]: string | Uint8Array | Tree };
  const fakeFile = (value: string | Uint8Array, lastModified: number) => ({
    lastModified,
    text: async () => (typeof value === 'string' ? value : new TextDecoder().decode(value)),
    arrayBuffer: async () => (typeof value === 'string' ? new TextEncoder().encode(value) : value).slice().buffer,
  });
  const fakeDir = (name: string, tree: Tree, mtimes: Record<string, number> = {}, path = ''): DirectoryHandleLike => ({
    name,
    kind: 'directory',
    async *values() {
      for (const [child, value] of Object.entries(tree)) {
        const childPath = `${path}${child}`;
        if (typeof value === 'string' || value instanceof Uint8Array) {
          yield { kind: 'file' as const, name: child, getFile: async () => fakeFile(value, mtimes[childPath] ?? 2000) };
        } else {
          yield { ...fakeDir(child, value, mtimes, `${childPath}/`) };
        }
      }
    },
  });
  const plain = jsonl(parentRecords);
  const packed = Uint8Array.from(atob('KLUv/QBYlRMA'), (c) => c.charCodeAt(0));

  it('reads sessions and archived_sessions of a picked ~/.codex, preferring a plain rollout over its .zst', async () => {
    const codexHome = fakeDir('.codex', {
      'config.toml': 'model = "gpt-5.5-codex"',
      'history.jsonl': '{"session_id":"x","ts":1,"text":"hi"}',
      log: { 'codex-tui.jsonl': '{}' },
      sessions: {
        '2026': {
          '10': {
            '20': { 'rollout-a.jsonl': plain, 'rollout-a.jsonl.zst': packed },
            '13': { 'rollout-b.jsonl.zst': packed, '.rollout-materialize-123.jsonl': plain, 'rollout-b.txt': 'x' },
          },
        },
      },
      archived_sessions: { 'rollout-c.jsonl.zst': packed },
    });
    const files = await readJsonlTree(codexHome);
    // (integer-like object keys iterate in ascending order, so day 13 comes first)
    expect(files.map((f) => f.name)).toEqual([
      'sessions/2026/10/13/rollout-b.jsonl.zst',
      'sessions/2026/10/20/rollout-a.jsonl',
      'archived_sessions/rollout-c.jsonl.zst',
    ]);
    expect(files[0].text).toBeUndefined();
    expect(files[0].bytes).toEqual(packed);
    expect(files[1].text).toBe(plain);
  });

  it('reads only main transcripts under ~/.claude/projects and honours `since`', async () => {
    const project = {
      [`${SESSION}.jsonl`]: 'main',
      'c0ffee00-0000-4000-8000-000000000002.jsonl': 'old',
      [SESSION]: {
        subagents: { 'agent-1.jsonl': 'x', workflows: { wf_1: { 'agent-2.jsonl': 'x' } } },
        'tool-results': { 't.jsonl': 'x' },
        'mcp-tasks': { 'm.jsonl': 'x' },
      },
      'agent-legacy.jsonl': 'x',
      [`${SESSION}.orphaned-1-ab.jsonl`]: 'x',
      [`${SESSION}.jsonl.superseded-1`]: 'x',
      memory: { 'notes.jsonl': 'x' },
    };
    const mtimes = { '-Users-me-api/c0ffee00-0000-4000-8000-000000000002.jsonl': 500 };
    const projects = fakeDir('projects', { '-Users-me-api': project }, mtimes);
    expect((await readJsonlTree(projects)).map((f) => f.name)).toEqual([
      `-Users-me-api/${SESSION}.jsonl`,
      '-Users-me-api/c0ffee00-0000-4000-8000-000000000002.jsonl',
    ]);
    expect((await readJsonlTree(projects, { since: 1000 })).map((f) => f.name)).toEqual([`-Users-me-api/${SESSION}.jsonl`]);

    // picking ~/.claude itself walks projects/ only (not history.jsonl or plugins)
    const claudeHome = fakeDir(
      '.claude',
      {
        'history.jsonl': '{"display":"hi"}',
        plugins: { 'cache.jsonl': '{}' },
        projects: { '-Users-me-api': project },
      },
      { 'projects/-Users-me-api/c0ffee00-0000-4000-8000-000000000002.jsonl': 500 }
    );
    expect((await readJsonlTree(claudeHome, { since: 1000 })).map((f) => f.name)).toEqual([
      `projects/-Users-me-api/${SESSION}.jsonl`,
    ]);
  });
});

describe('existing Codex rollouts', () => {
  it('keeps plain threads on the main branch and reads the first session_meta only', () => {
    const records = [
      meta({ id: P, git: { branch: 'main', repository_url: 'git@github.com:acme/orders-api.git' } }, at(0)),
      { timestamp: at(0, 1), type: 'turn_context', payload: { model: 'gpt-5.5-codex', cwd: '/home/me/api' } },
      ...parentTurns,
      // a stray later session_meta (as fork history copies carry) must not change identity or repository
      meta({ id: F, cwd: '/elsewhere', git: { branch: 'other', repository_url: 'git@github.com:acme/other.git' } }, at(9)),
    ];
    const r: CodexRollout = parseCodexRollout(jsonl(records), { ...ACCOUNT, fileName: `${parentFile}.zst` })!;
    expect(r.threadId).toBe(P);
    expect(r.fileName).toBe(parentFile);
    expect(r.forkedFromId).toBeNull();
    expect(r.thread).toMatchObject({
      sourceConversationId: P,
      branchId: 'main',
      parentBranchId: null,
      providerProjectName: 'orders-api',
      gitBranch: 'main',
      workspacePath: '/home/me/api',
      modelSlug: 'gpt-5.5-codex',
    });
    expect(r.thread.siblingBranchIds).toBeUndefined();
  });
});
