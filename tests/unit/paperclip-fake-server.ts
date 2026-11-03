/**
 * In-memory Paperclip server for tests: a fetch stub that answers the read routes Threadkeeper
 * uses with the same shapes and semantics as Paperclip's server (strict updatedSince, ascending
 * sort with offset paging, comment `after` cursors, byte-offset log pages, 401 for missing keys
 * on an authenticated instance, the CLI-auth challenge flow).
 */
import type {
  PcAgent,
  PcComment,
  PcCompany,
  PcGoal,
  PcIssue,
  PcIssueRun,
  PcProject,
  PcRun,
  PcRunEvent,
} from '../../src/core/paperclip/client.js';

export interface FakeRun {
  row: PcIssueRun;
  detail: Partial<PcRun>;
  /** NDJSON run log ({ts, stream, chunk} per line). */
  log: string;
  events: PcRunEvent[];
  updatedAt: string;
  issueId: string;
  companyId: string;
}

export interface FakeChallenge {
  id: string;
  token: string;
  boardApiToken: string;
  /** Statuses returned by successive polls; the last one repeats. */
  statuses: string[];
  polls: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  query: Record<string, string>;
  auth: string | null;
  credentials: RequestCredentials | undefined;
}

export class FakePaperclip {
  origin: string;
  mode: 'local_trusted' | 'authenticated' = 'local_trusted';
  version = '0.3.1';
  validKeys = new Set<string>();
  companies: PcCompany[] = [];
  agents: PcAgent[] = [];
  agentCompany = new Map<string, string>();
  projects: Array<PcProject & { companyId: string }> = [];
  goals: Array<PcGoal & { companyId: string }> = [];
  issues: PcIssue[] = [];
  comments = new Map<string, PcComment[]>();
  runs: FakeRun[] = [];
  challenges: FakeChallenge[] = [];
  requests: RecordedRequest[] = [];
  /** path prefix → remaining 429 answers, with the Retry-After seconds to send. */
  rateLimits: Array<{ match: RegExp; remaining: number; retryAfter: number }> = [];
  down = false;
  private clock = Date.parse('2026-11-01T09:00:00.000Z');

  constructor(origin = 'http://localhost:3100') {
    this.origin = origin;
  }

  /** A strictly increasing ISO time, one minute apart. */
  tick(): string {
    this.clock += 60_000;
    return new Date(this.clock).toISOString();
  }

  addCompany(c: Partial<PcCompany> & { id: string; name: string }): PcCompany {
    const company = { issuePrefix: 'PAP', status: 'active', ...c };
    this.companies.push(company);
    return company;
  }

  addAgent(companyId: string, a: Partial<PcAgent> & { id: string; name: string }): PcAgent {
    const agent: PcAgent = { role: 'general', adapterType: 'claude_local', adapterConfig: {}, ...a };
    this.agents.push(agent);
    this.agentCompany.set(agent.id, companyId);
    return agent;
  }

  addIssue(i: Partial<PcIssue> & { id: string; companyId: string; title: string }): PcIssue {
    const at = this.tick();
    const issue: PcIssue = { status: 'todo', description: '', createdAt: at, updatedAt: at, ...i };
    this.issues.push(issue);
    this.comments.set(issue.id, []);
    return issue;
  }

  touch(issueId: string): void {
    const issue = this.issues.find((i) => i.id === issueId)!;
    issue.updatedAt = this.tick();
  }

  addComment(issueId: string, c: Partial<PcComment> & { id: string; body: string }, bumpIssue = true): PcComment {
    const comment: PcComment = { issueId, authorType: 'user', createdAt: this.tick(), ...c };
    this.comments.get(issueId)!.push(comment);
    if (bumpIssue) this.touch(issueId);
    return comment;
  }

  addRun(
    issueId: string,
    r: { id: string; agentId: string; adapterType?: string; status?: string; log?: string; events?: PcRunEvent[]; sessionIdAfter?: string; runtimeMode?: string }
  ): FakeRun {
    const issue = this.issues.find((i) => i.id === issueId)!;
    const startedAt = this.tick();
    const finishedAt = this.tick();
    const log = r.log ?? '';
    const run: FakeRun = {
      issueId,
      companyId: issue.companyId,
      updatedAt: finishedAt,
      log,
      events: r.events ?? [],
      row: {
        runId: r.id,
        status: r.status ?? 'succeeded',
        agentId: r.agentId,
        adapterType: r.adapterType ?? 'claude_local',
        runtimeMode: r.runtimeMode ?? 'legacy',
        startedAt,
        finishedAt,
        createdAt: startedAt,
        logBytes: log.length,
        usageJson: { inputTokens: 1200, outputTokens: 300 },
        resultJson: { costUsd: 0.12 },
      },
      detail: { sessionIdAfter: r.sessionIdAfter ?? null, error: null },
    };
    this.runs.push(run);
    return run;
  }

  /** Grow a run's log (a running run writing more output). */
  appendLog(runId: string, more: string, status?: string): void {
    const run = this.runs.find((r) => r.row.runId === runId)!;
    run.log += more;
    run.row.logBytes = run.log.length;
    if (status) run.row.status = status;
    run.updatedAt = this.tick();
  }

  count(re: RegExp, method = 'GET'): number {
    return this.requests.filter((r) => r.method === method && re.test(r.path)).length;
  }

  reset(): void {
    this.requests = [];
  }

  fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = new Headers(init.headers);
    const auth = headers.get('authorization');
    this.requests.push({
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      auth,
      credentials: init.credentials,
    });
    if (this.down || url.origin !== this.origin) throw new TypeError('Failed to fetch');
    const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...extra } });

    for (const limit of this.rateLimits) {
      if (limit.remaining > 0 && limit.match.test(url.pathname)) {
        limit.remaining--;
        return json({ error: 'Too many requests', retryAfterSeconds: limit.retryAfter }, 429, { 'Retry-After': String(limit.retryAfter) });
      }
    }

    const path = url.pathname.replace(/^\/api/, '');
    const q = url.searchParams;
    if (path === '/health') {
      return json({ status: 'ok', deploymentMode: this.mode, deploymentExposure: 'private', version: this.version });
    }

    // CLI auth (anonymous)
    if (path === '/cli-auth/challenges' && method === 'POST') {
      const n = this.challenges.length + 1;
      const challenge: FakeChallenge = this.challenges.find((c) => c.polls === -1) ?? {
        id: `00000000-0000-4000-8000-00000000000${n}`,
        token: `challenge-secret-${n}-xxxxxxxx`,
        boardApiToken: `pcp_board_${'a'.repeat(47)}${n}`,
        statuses: ['pending', 'approved'],
        polls: 0,
      };
      challenge.polls = 0;
      if (!this.challenges.includes(challenge)) this.challenges.push(challenge);
      return json(
        {
          id: challenge.id,
          token: challenge.token,
          boardApiToken: challenge.boardApiToken,
          approvalPath: `/cli-auth/${challenge.id}?token=${challenge.token}`,
          approvalUrl: `${this.origin}/cli-auth/${challenge.id}?token=${challenge.token}`,
          pollPath: `/cli-auth/challenges/${challenge.id}`,
          expiresAt: new Date(Date.now() + 600_000).toISOString(),
          suggestedPollIntervalMs: 1000,
        },
        201
      );
    }
    const challengeMatch = path.match(/^\/cli-auth\/challenges\/([^/]+)$/);
    if (challengeMatch && method === 'GET') {
      const c = this.challenges.find((x) => x.id === challengeMatch[1] && x.token === q.get('token'));
      if (!c) return json({ error: 'CLI auth challenge not found' }, 404);
      const status = c.statuses[Math.min(c.polls, c.statuses.length - 1)];
      c.polls++;
      if (status === 'approved') this.validKeys.add(c.boardApiToken);
      return json({ id: c.id, status, expiresAt: new Date(Date.now() + 600_000).toISOString() });
    }

    // Everything else needs a board actor.
    const bearer = auth?.replace(/^Bearer /, '') ?? '';
    if (this.mode === 'authenticated' && !this.validKeys.has(bearer)) {
      return json({ error: 'Board authentication required' }, 401);
    }
    if (method !== 'GET' && path !== '/cli-auth/revoke-current') return json({ error: 'read-only fake' }, 405);

    if (path === '/cli-auth/me') {
      return json({ userId: this.mode === 'local_trusted' ? 'local-board' : 'user_1', user: { name: 'Ada', email: 'ada@example.com' }, source: 'board_key' });
    }
    if (path === '/cli-auth/revoke-current') {
      this.validKeys.delete(bearer);
      return json({ revoked: true });
    }
    if (path === '/companies') return json(this.companies);

    let m = path.match(/^\/companies\/([^/]+)\/(agents|projects|goals|issues|heartbeat-runs)$/);
    if (m) {
      const [, cid, what] = m;
      if (!this.companies.some((c) => c.id === cid)) return json({ error: 'Company not found' }, 404);
      if (what === 'agents') return json(this.agents.filter((a) => this.agentCompany.get(a.id) === cid));
      if (what === 'projects') return json(this.projects.filter((p) => p.companyId === cid));
      if (what === 'goals') return json(this.goals.filter((g) => g.companyId === cid));
      if (what === 'heartbeat-runs') {
        const limit = Number(q.get('limit') ?? 200);
        const rows = this.runs
          .filter((r) => r.companyId === cid)
          .sort((a, b) => Date.parse(b.row.createdAt!) - Date.parse(a.row.createdAt!))
          .slice(0, limit)
          .map((r) => ({ id: r.row.runId, issueId: r.issueId, status: r.row.status, updatedAt: r.updatedAt, createdAt: r.row.createdAt, logBytes: r.row.logBytes }));
        return json(rows);
      }
      // issues: updatedSince is strictly greater-than; sortField=updated asc with offset paging.
      const since = q.get('updatedSince');
      let list = this.issues.filter((i) => i.companyId === cid);
      if (since) list = list.filter((i) => Date.parse(i.updatedAt!) > Date.parse(since));
      list = [...list].sort((a, b) => Date.parse(a.updatedAt!) - Date.parse(b.updatedAt!) || a.id.localeCompare(b.id));
      const offset = Number(q.get('offset') ?? 0);
      const limit = Math.min(Number(q.get('limit') ?? 500), 1000);
      // The list view is compact: no description.
      return json(list.slice(offset, offset + limit).map(({ description: _d, ...rest }) => rest));
    }

    m = path.match(/^\/issues\/([^/]+)$/);
    if (m) {
      const issue = this.issues.find((i) => i.id === m![1] || i.identifier === m![1]);
      if (!issue) return json({ error: 'Issue not found' }, 404);
      const project = this.projects.find((p) => p.id === issue.projectId);
      return json({ ...issue, project: project ? { id: project.id, name: project.name } : null });
    }
    m = path.match(/^\/issues\/([^/]+)\/comments$/);
    if (m) {
      let list = [...(this.comments.get(m[1]) ?? [])];
      if (q.get('order') !== 'asc') list.reverse();
      const after = q.get('after');
      if (after) {
        const idx = list.findIndex((c) => c.id === after);
        list = idx >= 0 ? list.slice(idx + 1) : list;
      }
      return json(list.slice(0, Math.min(Number(q.get('limit') ?? 500), 500)));
    }
    m = path.match(/^\/issues\/([^/]+)\/runs$/);
    if (m) return json(this.runs.filter((r) => r.issueId === m![1]).map((r) => ({ ...r.row })));

    m = path.match(/^\/heartbeat-runs\/([^/]+)(\/log|\/events)?$/);
    if (m) {
      const run = this.runs.find((r) => r.row.runId === m![1]);
      if (!run) return json({ error: 'Heartbeat run not found' }, 404);
      if (m[2] === '/log') {
        const offset = Number(q.get('offset') ?? 0);
        const limit = Number(q.get('limitBytes') ?? 256_000);
        const content = run.log.slice(offset, offset + limit);
        const end = offset + content.length;
        return json({ runId: run.row.runId, store: 'local_file', content, ...(end < run.log.length ? { nextOffset: end } : {}) });
      }
      if (m[2] === '/events') {
        const after = Number(q.get('afterSeq') ?? 0);
        const limit = Number(q.get('limit') ?? 200);
        return json(run.events.filter((e) => e.seq > after).slice(0, limit));
      }
      return json({ id: run.row.runId, issueId: run.issueId, status: run.row.status, logBytes: run.row.logBytes, ...run.detail });
    }
    return json({ error: `No route ${path}` }, 404);
  };
}

/** NDJSON run-log records for stdout lines, optionally splitting each line across two chunks. */
export function runLog(lines: unknown[], options: { split?: boolean; ts?: string } = {}): string {
  const ts = options.ts ?? '2026-11-01T09:30:00.000Z';
  const records: string[] = [];
  for (const line of lines) {
    const text = `${typeof line === 'string' ? line : JSON.stringify(line)}\n`;
    if (options.split && text.length > 10) {
      const cut = Math.floor(text.length / 2);
      records.push(JSON.stringify({ ts, stream: 'stdout', chunk: text.slice(0, cut) }));
      records.push(JSON.stringify({ ts, stream: 'stderr', chunk: 'warning: noise\n' }));
      records.push(JSON.stringify({ ts, stream: 'stdout', chunk: text.slice(cut) }));
    } else {
      records.push(JSON.stringify({ ts, stream: 'stdout', chunk: text }));
    }
  }
  return `${records.join('\n')}\n`;
}

/** A small Claude Code stream-json session. */
export function claudeSession(sessionId: string, text = 'Updated the landing page copy.'): unknown[] {
  return [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5', session_id: sessionId },
    { type: 'assistant', message: { content: [{ type: 'text', text: 'Reading the page first.' }, { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'src/landing.tsx' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'export function Landing() {}' }] } },
    { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't2', name: 'Edit', input: { file_path: 'src/landing.tsx' } }] } },
    { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
    { type: 'assistant', message: { content: [{ type: 'text', text }] } },
    { type: 'result', subtype: 'success', is_error: false, result: text, total_cost_usd: 0.12, usage: { input_tokens: 1200, output_tokens: 300 } },
  ];
}
