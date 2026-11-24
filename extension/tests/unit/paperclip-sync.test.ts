import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ThreadStackDB,
  deleteConversationCascade,
  ensureStarterCollectionsAndSettings,
  saveSettingsPatch,
  updateManualThreadFields,
  upsertThread,
} from '../../src/core/db.js';
import { buildThreadKey, normalizePaperclipSettings, type SettingsRecord } from '../../src/core/schema.js';
import {
  describeSyncResult,
  failureBackoffMs,
  memoryStateStore,
  normalizeSyncState,
  runPaperclipSync,
  type SyncOptions,
} from '../../src/core/paperclip/sync.js';
import { paperclipThreadKey } from '../../src/core/paperclip/mapper.js';
import { FakePaperclip, claudeSession, runLog } from './paperclip-fake-server.js';

let n = 0;
let db: ThreadStackDB;
let server: FakePaperclip;
let settings: SettingsRecord;
let store: ReturnType<typeof memoryStateStore>;

const ACCOUNT = { accountId: 'acct_paperclip_primary', workspaceId: 'ws_personal' };
const key = (issueId: string) => paperclipThreadKey(ACCOUNT, issueId);

async function enable(patch: Partial<SettingsRecord['paperclip']> = {}) {
  settings = await saveSettingsPatch(db, {
    paperclip: normalizePaperclipSettings({ enabled: true, serverUrl: server.origin, deploymentMode: server.mode, ...patch }),
  });
}

function sync(extra: Partial<SyncOptions> = {}) {
  return runPaperclipSync({ db, settings, store, fetch: server.fetch, sleep: async () => undefined, ...extra });
}

function seed() {
  const company = server.addCompany({ id: 'c-1', name: 'Acme', issuePrefix: 'PAP' });
  server.projects.push({ id: 'p-1', name: 'Website', companyId: company.id });
  server.addAgent(company.id, { id: 'ceo', name: 'CEO', role: 'ceo', adapterType: 'paperclip_runner', adapterConfig: { provider: 'grok_bot' } });
  server.addAgent(company.id, { id: 'eng', name: 'Engineer', role: 'engineer', adapterType: 'claude_local' });
  const landing = server.addIssue({
    id: 'issue-1',
    companyId: company.id,
    identifier: 'PAP-1',
    title: 'Refresh the landing page',
    description: 'Rewrite the hero copy for the launch.',
    status: 'done',
    projectId: 'p-1',
    assigneeAgentId: 'eng',
    createdByAgentId: 'ceo',
    currentExecutionWorkspace: { cwd: '/work/site', branchName: 'pap-1' },
  });
  server.addComment(landing.id, { id: 'k1', authorType: 'user', body: 'Keep it short and friendly.' });
  server.addRun(landing.id, { id: 'run-1', agentId: 'eng', log: runLog(claudeSession('sess-1'), { split: true }), sessionIdAfter: 'sess-1' });
  server.addComment(landing.id, { id: 'k2', authorType: 'agent', authorAgentId: 'eng', body: 'Shipped the new hero copy.' });
  const plan = server.addIssue({ id: 'issue-2', companyId: company.id, identifier: 'PAP-2', title: 'Plan the launch', status: 'in_progress', assigneeAgentId: 'ceo' });
  server.addRun(plan.id, {
    id: 'run-2',
    agentId: 'ceo',
    adapterType: 'paperclip_runner',
    runtimeMode: 'native',
    events: [
      {
        seq: 1,
        eventType: 'item.completed',
        payload: { prpEvent: { schema: 'paperclip.prp.event.v1', schemaVersion: 1, runId: 'run-2', eventType: 'item.completed', itemId: 'm1', payload: { item: { kind: 'agent_message', text: 'Launch plan: three phases.' } } } },
      },
    ],
  });
}

beforeEach(async () => {
  n += 1;
  db = new ThreadStackDB(`PaperclipSyncDB_${n}_${Date.now()}`);
  settings = await ensureStarterCollectionsAndSettings(db);
  server = new FakePaperclip();
  store = memoryStateStore();
});

describe('Paperclip sync', () => {
  it('does nothing until it is turned on', async () => {
    seed();
    const outcome = await sync();
    expect(outcome.status).toBe('off');
    expect(server.requests).toHaveLength(0);
  });

  it('stores one organized thread per issue with comments, run transcripts, agent and links', async () => {
    seed();
    await enable();
    const outcome = await sync();
    expect(outcome.status).toBe('ok');
    expect(outcome.summary).toMatchObject({ companies: 1, issuesChecked: 2, threadsStored: 2, runsRead: 2, partial: false });

    const conv = (await db.conversations.get(key('issue-1')))!;
    expect(conv.provider).toBe('paperclip');
    expect(conv.title).toBe('PAP-1 Refresh the landing page');
    expect(conv.agentLabel).toBe('Engineer · Claude Code');
    expect(conv.canonicalUrl).toBe('http://localhost:3100/PAP/issues/PAP-1');
    expect(conv.providerProjectName).toBe('Website');
    expect(conv.resumeCommand).toBe('cd /work/site && claude --resume sess-1');
    // Paperclip's status wins over inferred status.
    expect(conv.workflowState).toBe('done');
    // Normal organize pipeline: local analysis and filing into the Paperclip project.
    expect(conv.project).toBe('Website');
    expect(conv.projectReason).toContain('Paperclip project "Website"');
    expect(await db.insights.where('threadKey').equals(conv.threadKey).count()).toBeGreaterThan(0);
    // Linked Claude Code session, recorded before that session is imported.
    expect(conv.linkedThreadKeys).toEqual([
      buildThreadKey({ provider: 'claude_code', accountId: 'acct_claude_code_primary', workspaceId: 'ws_personal', sourceConversationId: 'sess-1', branchId: 'main' }),
    ]);

    const messages = await db.messages.where('threadKey').equals(conv.threadKey).sortBy('ordinal');
    expect(messages.map((m) => m.role)).toEqual(['user', 'user', 'system', 'assistant', 'tool', 'assistant', 'assistant']);
    expect(messages[0].content).toContain('Task from CEO · Grok Bot');
    expect(messages[2].content).toMatch(/^Paperclip run by Engineer · Claude Code · finished/);
    expect(messages[2].sourceMessageId).toMatch(/^run:run-1:h:succeeded:\d+:s:sess-1$/);
    expect(messages[4].content).toContain('[tool] Read: src/landing.tsx');

    const native = (await db.conversations.get(key('issue-2')))!;
    expect(native.agentLabel).toBe('CEO · Grok Bot');
    expect(native.workflowState).toBe('active');
    const nativeMessages = await db.messages.where('threadKey').equals(native.threadKey).sortBy('ordinal');
    expect(nativeMessages.at(-1)?.content).toBe('Launch plan: three phases.');
    expect(server.count(/\/events$/)).toBe(1);

    const state = store.current;
    expect(state.threadCount).toBe(2);
    expect(state.lastError).toBe('');
    expect(state.companies['c-1'].cursor).not.toBe('');
    expect(describeSyncResult(state)).toBe('2 issues updated, 2 runs read.');
    expect(server.requests.every((r) => r.method === 'GET')).toBe(true);
  });

  it('links to Claude Code threads already in the library', async () => {
    seed();
    await enable();
    const cliKey = buildThreadKey({ provider: 'claude_code', accountId: 'acct_other', workspaceId: 'ws_x', sourceConversationId: 'sess-1', branchId: 'main' });
    await upsertThread(db, {
      threadKey: cliKey,
      provider: 'claude_code',
      accountId: 'acct_other',
      workspaceId: 'ws_x',
      sourceConversationId: 'sess-1',
      branchId: 'main',
      canonicalUrl: '',
      title: 'Landing page session',
      createdAt: null,
      updatedAt: null,
      coverage: 'full',
      captureSource: 'export_import',
      messages: [{ sourceMessageId: 'u1', role: 'user', content: 'fix the landing page', createdAt: null }],
    });
    await sync();
    expect((await db.conversations.get(key('issue-1')))!.linkedThreadKeys).toEqual([cliKey]);
  });

  it('syncs incrementally: unchanged issues and finished runs are not read again', async () => {
    seed();
    await enable();
    await sync();
    server.reset();

    const quiet = await sync();
    expect(quiet.summary.issuesChecked).toBe(0);
    expect(server.count(/^\/api\/issues\/[^/]+$/)).toBe(0);
    expect(server.count(/\/log$/)).toBe(0);

    server.reset();
    server.addComment('issue-1', { id: 'k3', authorType: 'user', body: 'Can you add a testimonial?' });
    const changed = await sync();
    expect(changed.summary).toMatchObject({ issuesChecked: 1, threadsStored: 1, runsRead: 0 });
    expect(server.requests.filter((r) => /^\/api\/issues\/[^/]+$/.test(r.path)).map((r) => r.path)).toEqual(['/api/issues/issue-1']);
    // The finished run's transcript was reused from the library, not downloaded again.
    expect(server.count(/\/log$/)).toBe(0);
    const messages = await db.messages.where('threadKey').equals(key('issue-1')).sortBy('ordinal');
    expect(messages.at(-1)?.content).toBe('Can you add a testimonial?');
    expect(messages.filter((m) => m.role === 'tool')).toHaveLength(1);
  });

  it('notices runs that changed without touching their issue', async () => {
    seed();
    await enable();
    await sync();
    server.reset();
    // A new run on issue-1 that does not bump the issue's updatedAt.
    server.addRun('issue-1', { id: 'run-3', agentId: 'eng', log: runLog(claudeSession('sess-1', 'Added a testimonial block.')), sessionIdAfter: 'sess-1' });
    const outcome = await sync();
    expect(outcome.summary).toMatchObject({ issuesChecked: 1, runsRead: 1 });
    expect(server.requests.filter((r) => r.path.endsWith('/log')).map((r) => r.path)).toEqual(['/api/heartbeat-runs/run-3/log']);
    const messages = await db.messages.where('threadKey').equals(key('issue-1')).sortBy('ordinal');
    expect(messages.at(-1)?.content).toBe('Added a testimonial block.');
    // Still linked once, not twice.
    expect((await db.conversations.get(key('issue-1')))!.linkedThreadKeys).toHaveLength(1);
  });

  it('re-reads a running run as its log grows', async () => {
    seed();
    server.addRun('issue-2', { id: 'run-live', agentId: 'eng', status: 'running', log: runLog([{ type: 'assistant', message: { content: [{ type: 'text', text: 'Starting.' }] } }]) });
    await enable();
    await sync();
    server.reset();
    server.appendLog('run-live', runLog([{ type: 'assistant', message: { content: [{ type: 'text', text: 'All done.' }] } }]), 'succeeded');
    await sync();
    expect(server.requests.filter((r) => r.path.endsWith('/log')).map((r) => r.path)).toEqual(['/api/heartbeat-runs/run-live/log']);
    const messages = await db.messages.where('threadKey').equals(key('issue-2')).sortBy('ordinal');
    expect(messages.map((m) => m.content)).toContain('Starting.\n\nAll done.');
  });

  it('continues a budget-limited sync where it stopped', async () => {
    seed();
    await enable();
    const first = await sync({ maxIssues: 1 });
    expect(first.status).toBe('partial');
    expect(first.summary.threadsStored).toBe(1);
    expect(await db.conversations.get(key('issue-2'))).toBeUndefined();
    server.reset();
    const second = await sync();
    expect(second.status).toBe('ok');
    expect(second.summary.threadsStored).toBe(1);
    expect(server.requests.filter((r) => /^\/api\/issues\/[^/]+$/.test(r.path)).map((r) => r.path)).toEqual(['/api/issues/issue-2']);
    expect(await db.conversations.get(key('issue-2'))).toBeDefined();
  });

  it('pages through many issues', async () => {
    const company = server.addCompany({ id: 'c-1', name: 'Acme' });
    for (let i = 0; i < 230; i++) server.addIssue({ id: `iss-${String(i).padStart(3, '0')}`, companyId: company.id, title: `Task ${i}` });
    await enable();
    const outcome = await sync({ maxIssues: 1000, organize: async () => undefined });
    expect(outcome.summary.threadsStored).toBe(230);
    expect(server.count(/\/companies\/c-1\/issues$/)).toBe(3);
  });

  it('backs off after a rate limit and resumes with Sync now', async () => {
    seed();
    await enable();
    server.rateLimits.push({ match: /\/companies\/c-1\/issues$/, remaining: 1, retryAfter: 600 });
    let clock = Date.parse('2026-11-03T12:00:00.000Z');
    const now = () => clock;
    const failed = await sync({ now });
    expect(failed.status).toBe('error');
    expect(store.current.lastError).toMatch(/slow down/);
    expect(Date.parse(store.current.backoffUntil) - clock).toBe(600_000);
    expect((await sync({ now })).status).toBe('backoff');
    clock += 60_000;
    const forced = await sync({ now, force: true });
    expect(forced.status).toBe('ok');
    expect(store.current.lastError).toBe('');
    expect(store.current.failures).toBe(0);
  });

  it('tells the user to sign in again when the key stops working', async () => {
    seed();
    server.mode = 'authenticated';
    await enable({ auth: 'board_key', apiKey: 'pcp_board_expiredexpiredexpired' });
    const outcome = await sync();
    expect(outcome.status).toBe('error');
    expect(outcome.error).toBe('Paperclip needs you to sign in again (Settings → Paperclip).');
    expect(store.current.failures).toBe(1);
  });

  it('uses the board key on an authenticated server', async () => {
    seed();
    server.mode = 'authenticated';
    server.validKeys.add('pcp_board_goodgoodgoodgoodgood');
    await enable({ auth: 'board_key', apiKey: 'pcp_board_goodgoodgoodgoodgood' });
    expect((await sync()).status).toBe('ok');
    expect(server.requests.every((r) => r.auth === 'Bearer pcp_board_goodgoodgoodgoodgood')).toBe(true);
  });

  it('syncs only the chosen companies', async () => {
    seed();
    const other = server.addCompany({ id: 'c-2', name: 'Side project', issuePrefix: 'SIDE' });
    server.addIssue({ id: 'side-1', companyId: other.id, title: 'Side task' });
    await enable({ companyScope: 'selected', companyIds: ['c-2'] });
    const outcome = await sync();
    expect(outcome.summary.companies).toBe(1);
    expect(outcome.threadKeys).toEqual([key('side-1')]);
  });

  it('respects threads deleted in ThreadStack', async () => {
    seed();
    await enable();
    await sync();
    await deleteConversationCascade(db, key('issue-1'));
    server.addComment('issue-1', { id: 'k9', authorType: 'user', body: 'more' });
    const outcome = await sync();
    expect(outcome.summary.skippedDeleted).toBe(1);
    expect(await db.conversations.get(key('issue-1'))).toBeUndefined();
  });

  it('keeps a status the user set by hand', async () => {
    seed();
    await enable();
    await sync();
    await updateManualThreadFields(db, key('issue-1'), { workflowState: 'paused' });
    server.addComment('issue-1', { id: 'k5', authorType: 'user', body: 'follow-up' });
    await sync();
    expect((await db.conversations.get(key('issue-1')))!.workflowState).toBe('paused');
  });

  it('starts over when the server changes', async () => {
    seed();
    await enable();
    await sync();
    expect(Object.keys(store.current.companies)).toEqual(['c-1']);
    const other = new FakePaperclip('http://localhost:3101');
    other.addCompany({ id: 'c-9', name: 'Other' });
    server = other;
    await enable();
    await sync();
    expect(store.current.serverUrl).toBe('http://localhost:3101');
    expect(Object.keys(store.current.companies)).toEqual(['c-9']);
  });

  it('organizes what it stored even when a later issue fails', async () => {
    seed();
    await enable();
    const organize = vi.fn(async () => undefined);
    server.rateLimits.push({ match: /\/issues\/issue-2\/comments$/, remaining: 99, retryAfter: 900 });
    const outcome = await sync({ organize });
    expect(outcome.status).toBe('error');
    expect(organize).toHaveBeenCalledWith([key('issue-1')], expect.anything());
  });
});

describe('Paperclip sync state', () => {
  it('backs off 5, 10, 20, 40, then 60 minutes', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map((f) => failureBackoffMs(f) / 60_000)).toEqual([0, 5, 10, 20, 40, 60, 60]);
  });

  it('normalizes anything stored', () => {
    const s = normalizeSyncState({ companies: { c: { cursor: 5, runMarks: { r: 'x', bad: 1 } } }, failures: 'nope' });
    expect(s.companies.c).toEqual({ name: '', cursor: '', cursorIds: [], runMarks: { r: 'x' } });
    expect(s.failures).toBe(0);
    expect(normalizeSyncState(null).version).toBe(1);
  });
});
