import { describe, it, expect } from 'vitest';
import { parseSessionControlBackup, planSessionControlImport } from '../../src/core/session-control-import';
import { computeDeterministicHash } from '../../src/core/schema';

const P1 = '0b336235-3358-4cb4-9500-123456789abc';
const P2 = '1c446346-4469-4dc5-a611-23456789abcd';

function state(): any {
  const now = Date.UTC(2026, 0, 2, 3, 4, 5);
  const sess = (id: string, over: any = {}) => ({
    id, accountId: 'a1', workspaceId: 'personal', title: `Title ${id}`, url: `https://claude.ai/code/session_${id}`,
    notes: '', repository: '', branch: '', status: 'saved', pinned: false, archived: false, updatedAt: now, createdAt: now - 1000, ...over,
  });
  return {
    version: 1,
    accounts: [
      { id: 'a1', name: 'Main', email: 'm@x.test', color: 'peach', mode: 'current' },
      { id: 'a2', name: 'Work', email: 'w@x.test', color: 'violet', mode: 'isolated', profileId: P1 },
    ],
    workspaces: [{ id: 'personal', name: 'Personal', icon: 'user' }, { id: 'client', name: 'Client Work', icon: 'folder' }],
    sessions: [sess('s1'), sess('s2', { accountId: 'a2', workspaceId: 'client' })],
    activity: [],
    settings: { compact: false },
  };
}
const opts = { boundClaudeCodeAccountId: 'acct_claude_code_primary', workspaceId: 'ws_personal' };

describe('parseSessionControlBackup', () => {
  it('roundtrips a valid backup and keeps markup-looking notes as text', () => {
    const s = state();
    s.sessions[0].notes = '<script>alert(1)</script>';
    expect(parseSessionControlBackup(JSON.stringify(s)).sessions[0].notes).toBe('<script>alert(1)</script>');
  });
  it('rejects bad input with the original messages', () => {
    const bad = (fn: (s: any) => void, re: RegExp) => {
      const s = state();
      fn(s);
      expect(() => parseSessionControlBackup(JSON.stringify(s))).toThrow(re);
    };
    expect(() => parseSessionControlBackup('{nope')).toThrow(/supported Session Control backup/);
    bad((s) => (s.version = 2), /not a supported/);
    bad((s) => (s.accounts[1].profileId = 'x'), /invalid profile ID/);
    bad((s) => ((s.accounts[0].mode = 'isolated'), (s.accounts[0].profileId = P1)), /different profile/);
    bad((s) => (s.accounts[1].mode = 'current'), /Only one/);
    bad((s) => (s.sessions[0].accountId = 'missing'), /invalid account/);
    bad((s) => (s.sessions[0].workspaceId = 'missing'), /invalid account/);
    bad((s) => (s.sessions[0].id = 'a1'), /duplicate/);
    bad((s) => (s.sessions[0].status = 'toString'), /invalid/);
    bad((s) => (s.sessions[0].url = 'https://evil.test/code/a'), /Claude Code URL/);
    bad((s) => (s.workspaces = []), /at least one workspace/);
    bad((s) => (s.accounts = new Array(101).fill(s.accounts[0])), /size/);
  });
});

describe('planSessionControlImport', () => {
  it('maps accounts: current is primary, isolated gets a stable id and keeps its profile', () => {
    const plan = planSessionControlImport(parseSessionControlBackup(JSON.stringify(state())), opts);
    const [main, work] = plan.accounts;
    expect(main).toMatchObject({ accountId: 'acct_claude_code_primary', recordId: 'primary~anthropic', primary: true, realm: 'anthropic', color: 'peach', label: 'Main', email: 'm@x.test' });
    expect(main.profileId).toBeUndefined();
    expect(work.accountId).toBe('acct_sc' + computeDeterministicHash(P1).slice(0, 10));
    expect(work).toMatchObject({ mode: 'isolated', profileId: P1, primary: false, color: 'violet' });
    const again = planSessionControlImport(parseSessionControlBackup(JSON.stringify(state())), opts);
    expect(again).toEqual(plan);
  });
  it('maps projects and Personal', () => {
    const plan = planSessionControlImport(parseSessionControlBackup(JSON.stringify(state())), opts);
    expect(plan.projects).toEqual(['Client Work']);
    expect(plan.threads.map((t) => t.project)).toEqual(['Personal', 'Client Work']);
  });
  it('builds claude_code threads', () => {
    const s = state();
    s.sessions[0] = { ...s.sessions[0], notes: '<b>x</b> & more', repository: 'Acme / App', branch: 'feat/x', pinned: true, status: 'attention' };
    const plan = planSessionControlImport(parseSessionControlBackup(JSON.stringify(s)), opts);
    const t = plan.threads[0];
    expect(t).toMatchObject({
      provider: 'claude_code', sourceConversationId: 'session_s1', canonicalUrl: 'https://claude.ai/code/session_s1',
      threadKey: 'claude_code:acct_claude_code_primary:ws_personal:session_s1:main', manualNotes: '<b>x</b> & more',
      repository: 'acme/app', gitBranch: 'feat/x', pinned: true, workflowState: 'needs_review', coverage: 'metadata_only',
      captureSource: 'manual', messages: [], updatedAt: '2026-01-02T03:04:05.000Z', createdAt: '2026-01-02T03:04:04.000Z',
    });
    expect(plan.threads[1].accountId).toBe(plan.accounts[1].accountId);
  });
  it('keeps unnormalizable repository text in providerProjectName', () => {
    const s = state();
    s.sessions[0].repository = 'a/b/c/d';
    const t = planSessionControlImport(parseSessionControlBackup(JSON.stringify(s)), opts).threads[0];
    expect(t.repository).toBeNull();
    expect(t.providerProjectName).toBe('a/b/c/d');
  });
  it('maps every status and archived', () => {
    const s = state();
    const expected: Record<string, string> = { saved: 'active', running: 'active', attention: 'needs_review', done: 'done', paused: 'paused' };
    s.sessions = Object.keys(expected).map((st, i) => ({ ...s.sessions[0], id: `x${i}`, url: `https://claude.ai/code/x${i}`, status: st }));
    s.sessions.push({ ...s.sessions[0], id: 'arch', url: 'https://claude.ai/code/arch', status: 'done', archived: true });
    const states = planSessionControlImport(parseSessionControlBackup(JSON.stringify(s)), opts).threads.map((t) => t.workflowState);
    expect(states).toEqual([...Object.values(expected), 'archived']);
  });
  it('skips the bare home page and sample data with reasons', () => {
    const s = state();
    s.sessions[0].url = 'https://claude.ai/code';
    s.sessions[1].url = 'https://claude.ai/code/sample-1';
    const plan = planSessionControlImport(parseSessionControlBackup(JSON.stringify(s)), opts);
    expect(plan.threads).toHaveLength(0);
    expect(plan.skipped.map((k) => k.title)).toEqual(['Title s1', 'Title s2']);
    expect(plan.skipped[0].reason).toMatch(/home page/);
    expect(plan.skipped[1].reason).toMatch(/Sample/);
  });
});
