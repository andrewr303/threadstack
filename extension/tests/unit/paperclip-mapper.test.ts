import { describe, expect, it } from 'vitest';
import {
  RUN_MESSAGE_LIMIT,
  agentLabel,
  buildIssueThread,
  entriesFromLog,
  entriesFromNativeEvents,
  issueUrl,
  paperclipThreadKey,
  parseRunHeaderId,
  parseStdoutLine,
  resumeCommandFor,
  runEntriesToMessages,
  runHeaderId,
  runHeaderText,
  runnerLabel,
  stdoutLinesFromLog,
  workflowStateForIssue,
  type RunBlock,
  type TranscriptEntry,
} from '../../src/core/paperclip/mapper.js';
import type { PcAgent, PcIssueRun, PcRunEvent } from '../../src/core/paperclip/client.js';
import { claudeSession, runLog } from './paperclip-fake-server.js';

const ACCOUNT = { accountId: 'acct_paperclip_primary', workspaceId: 'ws_personal' };

describe('agent labels', () => {
  const agent = (a: Partial<PcAgent>): PcAgent => ({ id: 'a', name: 'Agent', ...a });

  it('names the agent and the runner it uses', () => {
    expect(agentLabel(agent({ name: 'CEO', role: 'ceo', adapterType: 'paperclip_runner', adapterConfig: { provider: 'grok_bot' } }))).toBe('CEO · Grok Bot');
    expect(agentLabel(agent({ name: 'Engineer', adapterType: 'claude_local' }))).toBe('Engineer · Claude Code');
    expect(agentLabel(agent({ name: 'Muse', adapterType: 'paperclip_runner', adapterConfig: { provider: 'muse' } }))).toBe('Muse');
    expect(agentLabel(agent({ name: 'OpenAI Dot', adapterType: 'paperclip_runner', adapterConfig: { provider: 'openai_dot' } }))).toBe('OpenAI Dot');
    expect(agentLabel(agent({ name: '', role: 'cto', adapterType: 'codex_local' }))).toBe('CTO · Codex');
    expect(agentLabel(null, 'gemini_local')).toBe('Gemini CLI');
  });

  it('labels runners, including ACPX and unknown adapters', () => {
    expect(runnerLabel('paperclip_runner', { provider: 'acpx', acpxAgent: 'grok' })).toBe('Grok Build');
    expect(runnerLabel('opencode_local')).toBe('OpenCode');
    expect(runnerLabel('future_local')).toBe('Future');
    expect(runnerLabel(null)).toBe('');
  });
});

describe('issue fields', () => {
  it('maps Paperclip statuses to workflow states', () => {
    expect(workflowStateForIssue('in_progress')).toBe('active');
    expect(workflowStateForIssue('in_review')).toBe('needs_review');
    expect(workflowStateForIssue('todo')).toBe('waiting');
    expect(workflowStateForIssue('backlog')).toBe('waiting');
    expect(workflowStateForIssue('blocked')).toBe('paused');
    expect(workflowStateForIssue('done')).toBe('done');
    expect(workflowStateForIssue('cancelled')).toBe('archived');
    expect(workflowStateForIssue('mystery')).toBe('active');
  });

  it('links to the issue page under the company prefix', () => {
    expect(issueUrl('http://localhost:3100', { issuePrefix: 'PAP' }, { id: 'u1', identifier: 'PAP-12' })).toBe('http://localhost:3100/PAP/issues/PAP-12');
    expect(issueUrl('http://localhost:3100/', null, { id: 'u1', identifier: null })).toBe('http://localhost:3100/issues/u1');
  });
});

describe('run logs', () => {
  it('reassembles stdout lines split across chunks and ignores stderr', () => {
    const log = runLog([{ type: 'assistant', message: { content: [{ type: 'text', text: 'hello there' }] } }, 'plain text line'], { split: true });
    const lines = stdoutLinesFromLog(log);
    expect(lines.map((l) => l.text)).toEqual([
      JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'hello there' }] } }),
      'plain text line',
    ]);
    expect(lines.every((l) => l.ts === '2026-11-01T09:30:00.000Z')).toBe(true);
  });

  it('keeps a final line without a trailing newline', () => {
    const log = `${JSON.stringify({ ts: 't', stream: 'stdout', chunk: '{"type":"text","part":{"text":"end"}}' })}\n`;
    expect(stdoutLinesFromLog(log).map((l) => l.text)).toEqual(['{"type":"text","part":{"text":"end"}}']);
  });

  it('parses Claude Code stream-json', () => {
    const entries = entriesFromLog(runLog(claudeSession('sess-1')));
    expect(entries.map((e) => e.kind)).toEqual(['init', 'assistant', 'tool_call', 'tool_result', 'tool_call', 'tool_result', 'assistant', 'result']);
    expect(entries[0]).toMatchObject({ kind: 'init', model: 'claude-sonnet-5', sessionId: 'sess-1' });
  });

  it('parses codex exec --json events', () => {
    const lines = [
      { type: 'thread.started', thread_id: '019a-codex' },
      { type: 'item.started', item: { id: 'c1', type: 'command_execution', command: 'bash -lc "npm test"' } },
      { type: 'item.completed', item: { id: 'c1', type: 'command_execution', command: 'npm test', aggregated_output: '3 failing', exit_code: 1, status: 'failed' } },
      { type: 'item.completed', item: { id: 'r1', type: 'reasoning', text: 'thinking…' } },
      { type: 'item.completed', item: { id: 'f1', type: 'file_change', changes: [{ kind: 'update', path: 'src/a.ts' }] } },
      { type: 'item.completed', item: { id: 'm1', type: 'agent_message', text: 'Fixed the failing tests.' } },
      { type: 'turn.completed', usage: { input_tokens: 10 } },
    ];
    const entries = lines.flatMap((l) => parseStdoutLine(JSON.stringify(l)));
    expect(entries.map((e) => e.kind)).toEqual(['init', 'tool_call', 'tool_result', 'tool_call', 'assistant']);
    expect(entries[2]).toMatchObject({ kind: 'tool_result', isError: true });
  });

  it('parses OpenCode parts and Grok Build deltas, and skips noise', () => {
    expect(parseStdoutLine('{"type":"text","part":{"text":"From OpenCode"}}')).toEqual([{ kind: 'assistant', ts: null, text: 'From OpenCode' }]);
    expect(parseStdoutLine('{"type":"text","data":"Gro"}')).toEqual([{ kind: 'assistant', ts: null, text: 'Gro', delta: true }]);
    expect(parseStdoutLine('{"type":"tool_use","part":{"tool":"bash","state":{"input":{"command":"ls"},"output":"a b","status":"completed"}}}').map((e) => e.kind)).toEqual(['tool_call', 'tool_result']);
    expect(parseStdoutLine('{"type":"step_start"}')).toEqual([]);
    expect(parseStdoutLine('not json')).toEqual([]);
  });
});

describe('native runner events', () => {
  const ev = (seq: number, eventType: string, payload: Record<string, unknown>, itemId?: string): PcRunEvent => ({
    seq,
    eventType,
    payload: { prpEvent: { schema: 'paperclip.prp.event.v1', schemaVersion: 1, runId: 'r', eventType, itemId, payload } },
  });

  it('prefers completed assistant items over their deltas and merges orphan deltas', () => {
    const entries = entriesFromNativeEvents([
      ev(1, 'item.delta', { kind: 'agent_message', text: 'Hel' }, 'm1'),
      ev(2, 'item.delta', { kind: 'agent_message', text: 'lo' }, 'm1'),
      ev(3, 'item.completed', { item: { kind: 'agentMessage', text: 'Hello from Grok Bot.' } }, 'm1'),
      ev(4, 'item.started', { item: { kind: 'tool_call', name: 'search', input: { query: 'paperclip' } } }, 't1'),
      ev(5, 'item.completed', { item: { kind: 'tool_call', output: '3 results' } }, 't1'),
      ev(6, 'item.delta', { kind: 'assistant_message', text: 'Stream' }, 'm2'),
      ev(7, 'item.delta', { kind: 'assistant_message', text: 'ing' }, 'm2'),
    ]);
    const messages = runEntriesToMessages('r', entries, null).messages;
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['assistant', 'Hello from Grok Bot.'],
      ['tool', '[tool] search: paperclip\n[tool result] 3 results'],
      ['assistant', 'Streaming'],
    ]);
  });
});

describe('run transcripts', () => {
  it('condenses tool calls like CLI sessions and numbers messages per run', () => {
    const t = runEntriesToMessages('run-1', entriesFromLog(runLog(claudeSession('sess-1'))), '2026-11-01T09:00:00.000Z');
    expect(t.sessionId).toBe('sess-1');
    expect(t.model).toBe('claude-sonnet-5');
    expect(t.messages.map((m) => [m.sourceMessageId, m.role, m.content])).toEqual([
      ['run:run-1:0', 'assistant', 'Reading the page first.'],
      ['run:run-1:1', 'tool', '[tool] Read: src/landing.tsx\n[tool result] export function Landing() {}\n[tool] Edit: src/landing.tsx\n[tool result] ok'],
      ['run:run-1:2', 'assistant', 'Updated the landing page copy.'],
    ]);
  });

  it('keeps the opening and the latest steps of a very long run', () => {
    const entries: TranscriptEntry[] = [];
    for (let i = 0; i < 1000; i++) {
      entries.push({ kind: 'assistant', ts: null, text: `step ${i}` });
      entries.push({ kind: 'user', ts: null, text: `ok ${i}` });
    }
    const { messages } = runEntriesToMessages('r', entries, null);
    expect(messages).toHaveLength(RUN_MESSAGE_LIMIT);
    expect(messages[0].content).toBe('step 0');
    expect(messages.some((m) => m.role === 'system' && /earlier steps of this run are not shown/.test(m.content))).toBe(true);
    expect(messages.at(-1)?.content).toBe('ok 999');
  });

  it('collects run errors for the header', () => {
    const t = runEntriesToMessages('r', [{ kind: 'result', ts: null, isError: true, errors: ['Model rejected the request'] }], null);
    expect(t.errors).toEqual(['Model rejected the request']);
  });

  it('round-trips header ids with the resumed session', () => {
    const run = { runId: 'r-1', status: 'succeeded', logBytes: 2048 };
    expect(runHeaderId(run)).toBe('run:r-1:h:succeeded:2048');
    expect(parseRunHeaderId(runHeaderId(run, 'sess_abc-1'))).toEqual({ runId: 'r-1', status: 'succeeded', logBytes: 2048, sessionId: 'sess_abc-1' });
    // Unsafe session ids are never embedded.
    expect(runHeaderId(run, 'a b; rm -rf')).toBe('run:r-1:h:succeeded:2048');
    expect(parseRunHeaderId('run:r-1:3')).toBeNull();
  });

  it('writes a readable run header', () => {
    const run: PcIssueRun = {
      runId: 'r',
      status: 'failed',
      startedAt: '2026-11-01T09:00:00.000Z',
      finishedAt: '2026-11-01T09:04:12.000Z',
      usageJson: { inputTokens: 15000, outputTokens: 3200 },
      resultJson: { costUsd: 0.4211 },
    };
    expect(runHeaderText(run, { agent: 'Engineer · Claude Code', detail: { error: 'Process exited with code 1' } })).toBe(
      'Paperclip run by Engineer · Claude Code · failed in 4m 12s · 18k tokens · $0.42\nError: Process exited with code 1'
    );
  });
});

describe('issue threads', () => {
  const agents = new Map<string, PcAgent>([
    ['ceo', { id: 'ceo', name: 'CEO', role: 'ceo', adapterType: 'paperclip_runner', adapterConfig: { provider: 'grok_bot' } }],
    ['eng', { id: 'eng', name: 'Engineer', role: 'engineer', adapterType: 'claude_local', adapterConfig: { model: 'claude-opus-5' } }],
  ]);
  const run = (id: string, at: string, adapterType = 'claude_local', agentId = 'eng'): PcIssueRun => ({
    runId: id,
    status: 'succeeded',
    agentId,
    adapterType,
    startedAt: at,
    finishedAt: at,
    createdAt: at,
    logBytes: 10,
  });

  function block(r: PcIssueRun, sessionId: string | null, text: string): RunBlock {
    return {
      run: r,
      messages: [
        { sourceMessageId: runHeaderId(r, sessionId), role: 'system', content: `Paperclip run ${r.runId}`, createdAt: r.startedAt ?? null, branchPath: 'main' },
        { sourceMessageId: `run:${r.runId}:0`, role: 'assistant', content: text, createdAt: r.startedAt ?? null, branchPath: 'main' },
      ],
      model: 'claude-sonnet-5',
      sessionId,
      cwd: null,
    };
  }

  const base = {
    serverUrl: 'http://localhost:3100',
    company: { id: 'c-1', name: 'Acme', issuePrefix: 'PAP' },
    agents,
    account: ACCOUNT,
  };

  it('orders description, comments and runs by time, as one thread per issue', () => {
    const thread = buildIssueThread({
      ...base,
      issue: {
        id: 'issue-1',
        companyId: 'c-1',
        identifier: 'PAP-12',
        title: 'Refresh the landing page',
        description: 'Rewrite the hero copy and fix the CTA.',
        status: 'in_review',
        assigneeAgentId: 'eng',
        createdByAgentId: 'ceo',
        createdAt: '2026-11-01T09:00:00.000Z',
        updatedAt: '2026-11-01T11:00:00.000Z',
        currentExecutionWorkspace: { cwd: '/work/site', branchName: 'pap-12' },
      },
      comments: [
        { id: 'k1', authorType: 'user', body: 'Keep it short.', createdAt: '2026-11-01T09:05:00.000Z' },
        { id: 'k2', authorType: 'agent', authorAgentId: 'eng', body: 'Done, please review.', createdAt: '2026-11-01T10:30:00.000Z' },
        { id: 'k3', authorType: 'system', body: 'Status changed to in_review', createdAt: '2026-11-01T10:31:00.000Z' },
        { id: 'k4', authorType: 'user', body: 'gone', deletedAt: '2026-11-01T10:40:00.000Z', createdAt: '2026-11-01T10:35:00.000Z' },
      ],
      runs: [block(run('r1', '2026-11-01T10:00:00.000Z'), 'sess-1', 'Updated the copy.')],
      projectName: 'Website',
      linkedThreadKeys: ['claude_code:acct_claude_code_primary:ws_personal:sess-1:main'],
    });
    expect(thread.threadKey).toBe(paperclipThreadKey(ACCOUNT, 'issue-1'));
    expect(thread.threadKey).toBe('paperclip:acct_paperclip_primary:ws_personal:issue-1:main');
    expect(thread.title).toBe('PAP-12 Refresh the landing page');
    expect(thread.canonicalUrl).toBe('http://localhost:3100/PAP/issues/PAP-12');
    expect(thread.messages.map((m) => [m.role, m.content.split('\n')[0]])).toEqual([
      ['user', 'Task from CEO · Grok Bot'],
      ['user', 'Keep it short.'],
      ['system', 'Paperclip run r1'],
      ['assistant', 'Updated the copy.'],
      ['assistant', 'Done, please review.'],
      ['system', 'Status changed to in_review'],
    ]);
    expect(thread.messages[0].content).toContain('Rewrite the hero copy');
    expect(thread.agentLabel).toBe('Engineer · Claude Code');
    expect(thread.providerProjectName).toBe('Website');
    expect(thread.workspacePath).toBe('/work/site');
    expect(thread.gitBranch).toBe('pap-12');
    expect(thread.modelSlug).toBe('claude-sonnet-5');
    expect(thread.resumeCommand).toBe('cd /work/site && claude --resume sess-1');
    expect(thread.updatedAt).toBe('2026-11-01T11:00:00.000Z');
    expect(thread.coverage).toBe('full');
    expect(thread.captureSource).toBe('export_import');
    expect(thread.linkedThreadKeys).toEqual(['claude_code:acct_claude_code_primary:ws_personal:sess-1:main']);
  });

  it('names agents in comments when several agents talk, and falls back to goal then company for the project', () => {
    const thread = buildIssueThread({
      ...base,
      issue: { id: 'i2', companyId: 'c-1', title: 'Plan Q1', createdAt: '2026-11-01T09:00:00.000Z', updatedAt: '2026-11-01T09:00:00.000Z' },
      comments: [
        { id: 'a', authorType: 'agent', authorAgentId: 'ceo', body: 'Here is the plan.', createdAt: '2026-11-01T09:01:00.000Z' },
        { id: 'b', authorType: 'agent', authorAgentId: 'eng', body: 'Looks feasible.', createdAt: '2026-11-01T09:02:00.000Z' },
      ],
      runs: [],
      goalTitle: 'Grow revenue',
    });
    expect(thread.messages.slice(1).map((m) => m.content)).toEqual(['**CEO:** Here is the plan.', '**Engineer:** Looks feasible.']);
    expect(thread.providerProjectName).toBe('Grow revenue');
    expect(thread.messages[0].content).toBe('Plan Q1');
    const companyOnly = buildIssueThread({ ...base, issue: { id: 'i3', companyId: 'c-1', title: 'x' }, comments: [], runs: [] });
    expect(companyOnly.providerProjectName).toBe('Acme');
    expect(companyOnly.title).toBe('x');
  });

  it('builds resume commands only for safe session ids', () => {
    const claude = block(run('r', '2026-11-01T10:00:00.000Z'), 'sess-1', 'x');
    expect(resumeCommandFor({ ...claude, cwd: "/work/my site's" }, 'c-1')).toBe("cd '/work/my site'\\''s' && claude --resume sess-1");
    const codex = block(run('r', '2026-11-01T10:00:00.000Z', 'codex_local'), '019a-1', 'x');
    expect(resumeCommandFor(codex, 'c-1')).toBe('CODEX_HOME="$HOME/.paperclip/instances/default/companies/c-1/codex-home" codex resume 019a-1');
    expect(resumeCommandFor({ ...claude, sessionId: '$(rm -rf ~)' }, 'c-1')).toBeNull();
    expect(resumeCommandFor(block(run('r', '2026-11-01T10:00:00.000Z', 'paperclip_runner'), 's', 'x'), 'c-1')).toBeNull();
  });
});
