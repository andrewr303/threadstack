/**
 * Read-only HTTP client for a Paperclip server (https://github.com/paperclipai/paperclip).
 *
 * Every route lives under `<origin>/api`. Paperclip sends no CORS headers, so this runs in the
 * service worker or an extension page, with host access to the server's origin granted from
 * Settings → Paperclip. Requests never carry cookies: a local_trusted instance needs no
 * credentials at all, and an authenticated one gets a board API key as a Bearer token.
 *
 * Threadkeeper only reads. The only non-GET calls are the CLI-auth challenge that asks the user
 * to approve a key (auth.ts) and revoking that key again when the user signs out.
 */

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type PaperclipErrorKind =
  | 'unreachable'
  | 'timeout'
  | 'aborted'
  | 'not_paperclip'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'rate_limited'
  | 'bad_response'
  | 'server';

export class PaperclipError extends Error {
  readonly kind: PaperclipErrorKind;
  readonly status: number | null;
  /** For rate_limited: how long the server asked us to wait. */
  readonly retryAfterMs: number | null;

  constructor(kind: PaperclipErrorKind, message: string, options: { status?: number | null; retryAfterMs?: number | null } = {}) {
    super(message);
    this.name = 'PaperclipError';
    this.kind = kind;
    this.status = options.status ?? null;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }
}

export function isPaperclipError(err: unknown, kind?: PaperclipErrorKind): err is PaperclipError {
  return err instanceof PaperclipError && (kind === undefined || err.kind === kind);
}

/** Default port of `npx paperclipai onboard`; a busy port makes the server take the next free one. */
export const PAPERCLIP_DEFAULT_PORT = 3100;
export const PAPERCLIP_PORT_RANGE = Array.from({ length: 11 }, (_, i) => PAPERCLIP_DEFAULT_PORT + i);

/**
 * The server origin a user typed ("localhost:3100", "http://box.tailnet:3100/api/", a pasted issue
 * URL…), or null when it is not an http(s) address.
 */
export function normalizeServerUrl(input: string): string | null {
  let raw = (input ?? '').trim();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) raw = `http://${raw}`;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname || url.username || url.password) return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Host-permission match pattern for a server origin. Match patterns ignore ports, so one grant covers 3100-3110. */
export function hostPermissionPattern(serverUrl: string): string | null {
  const origin = normalizeServerUrl(serverUrl);
  if (!origin) return null;
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

/** True for loopback servers, the only ones Threadkeeper declares optional host access for up front. */
export function isLoopbackServer(serverUrl: string): boolean {
  const origin = normalizeServerUrl(serverUrl);
  if (!origin) return false;
  const host = new URL(origin).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export interface PaperclipHealth {
  status: string;
  deploymentMode: 'local_trusted' | 'authenticated' | '';
  deploymentExposure: string;
  version: string;
}

/** A /api/health body is Paperclip's when it names a deployment mode (every variant of the route does). */
export function parseHealth(body: unknown): PaperclipHealth | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const mode = b.deploymentMode;
  if (typeof b.status !== 'string' || (mode !== 'local_trusted' && mode !== 'authenticated')) return null;
  return {
    status: b.status,
    deploymentMode: mode,
    deploymentExposure: typeof b.deploymentExposure === 'string' ? b.deploymentExposure : '',
    version: typeof b.version === 'string' ? b.version : typeof b.serverVersion === 'string' ? b.serverVersion : '',
  };
}

// ---------------------------------------------------------------------------
// API shapes (only the fields Threadkeeper reads; everything else is ignored)
// ---------------------------------------------------------------------------

export interface PcCompany {
  id: string;
  name: string;
  issuePrefix?: string | null;
  status?: string | null;
}

export interface PcAgent {
  id: string;
  name: string;
  urlKey?: string | null;
  role?: string | null;
  title?: string | null;
  adapterType?: string | null;
  adapterConfig?: Record<string, unknown> | null;
}

export interface PcProject {
  id: string;
  name: string;
}

export interface PcGoal {
  id: string;
  title: string;
}

export interface PcIssue {
  id: string;
  companyId: string;
  identifier?: string | null;
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  parentId?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  lastActivityAt?: string | null;
  completedAt?: string | null;
  project?: { id?: string; name?: string | null } | null;
  goal?: { id?: string; title?: string | null } | null;
  currentExecutionWorkspace?: { cwd?: string | null; repoUrl?: string | null; branchName?: string | null } | null;
}

export interface PcComment {
  id: string;
  issueId?: string;
  authorType?: 'user' | 'agent' | 'system' | string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  body?: string | null;
  presentation?: { kind?: string | null } | null;
  deletedAt?: string | null;
  createdAt?: string | null;
}

/** A row of GET /issues/:id/runs. */
export interface PcIssueRun {
  runId: string;
  status: string;
  agentId?: string | null;
  adapterType?: string | null;
  runtimeMode?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string | null;
  logBytes?: number | null;
  invocationSource?: string | null;
  usageJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  error?: string | null;
}

/** GET /heartbeat-runs/:runId (fields used for linking and the run header). */
export interface PcRun {
  id: string;
  companyId?: string;
  agentId?: string | null;
  issueId?: string | null;
  status: string;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  error?: string | null;
  exitCode?: number | null;
  usageJson?: Record<string, unknown> | null;
  resultJson?: Record<string, unknown> | null;
  sessionIdBefore?: string | null;
  sessionIdAfter?: string | null;
  logBytes?: number | null;
  runtimeMode?: string | null;
  contextSnapshot?: Record<string, unknown> | null;
}

/** A row of GET /companies/:id/heartbeat-runs?summary=true (newest first). */
export interface PcRunSummary {
  id: string;
  issueId?: string | null;
  status: string;
  updatedAt?: string | null;
  createdAt?: string | null;
  logBytes?: number | null;
  contextSnapshot?: { issueId?: string | null } | null;
}

export interface PcRunLogPage {
  content: string;
  nextOffset?: number | null;
}

export interface PcRunEvent {
  id?: string | number;
  seq: number;
  eventType: string;
  stream?: string | null;
  message?: string | null;
  payload?: Record<string, unknown> | null;
  createdAt?: string | null;
}

export interface PcMe {
  userId: string;
  user?: { name?: string | null; email?: string | null } | null;
  isInstanceAdmin?: boolean;
  companyIds?: string[];
  source?: string;
}

export interface PcCliChallenge {
  id: string;
  token: string;
  boardApiToken: string;
  approvalPath: string;
  approvalUrl: string | null;
  expiresAt: string;
  suggestedPollIntervalMs: number;
}

export interface PcCliChallengeStatus {
  status: 'pending' | 'approved' | 'cancelled' | 'expired' | string;
  expiresAt?: string;
}

export interface IssueListParams {
  updatedSince?: string;
  limit?: number;
  offset?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface PaperclipClientOptions {
  serverUrl: string;
  apiKey?: string;
  fetch?: FetchLike;
  /** Per request; long log pages get the same budget. */
  timeoutMs?: number;
  /** How many times a 429 is retried in place before giving up. */
  maxRateLimitRetries?: number;
  /** Longest wait honoured in place; a longer Retry-After stops the sync instead. */
  maxRateLimitWaitMs?: number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asArray<T>(body: unknown, ...keys: string[]): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === 'object') {
    for (const key of keys) {
      const v = (body as Record<string, unknown>)[key];
      if (Array.isArray(v)) return v as T[];
    }
  }
  throw new PaperclipError('bad_response', 'Paperclip answered with something other than a list.');
}

function retryAfterMs(res: Response, body: unknown): number {
  const header = res.headers.get('retry-after');
  const fromHeader = header ? Number(header) : NaN;
  const fromBody =
    body && typeof body === 'object' ? Number((body as Record<string, unknown>).retryAfterSeconds) : NaN;
  const seconds = Number.isFinite(fromHeader) && fromHeader >= 0 ? fromHeader : Number.isFinite(fromBody) && fromBody >= 0 ? fromBody : 5;
  return Math.min(Math.max(seconds, 1), 3600) * 1000;
}

function errorMessage(body: unknown): string {
  if (body && typeof body === 'object' && typeof (body as Record<string, unknown>).error === 'string') {
    return String((body as Record<string, unknown>).error).slice(0, 300);
  }
  return '';
}

export class PaperclipClient {
  readonly serverUrl: string;
  private readonly apiKey: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxWaitMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly signal: AbortSignal | undefined;
  /** Requests made, for progress readouts and tests. */
  requestCount = 0;

  constructor(options: PaperclipClientOptions) {
    const origin = normalizeServerUrl(options.serverUrl);
    if (!origin) throw new PaperclipError('unreachable', `"${options.serverUrl}" is not a server address.`);
    this.serverUrl = origin;
    this.apiKey = (options.apiKey ?? '').trim();
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 20_000;
    this.maxRetries = options.maxRateLimitRetries ?? 3;
    this.maxWaitMs = options.maxRateLimitWaitMs ?? 30_000;
    this.sleep = options.sleep ?? defaultSleep;
    this.signal = options.signal;
  }

  /** `path` is relative to /api and starts with a slash. */
  async request<T>(
    path: string,
    options: { query?: Record<string, string | number | boolean | null | undefined>; method?: 'GET' | 'POST'; body?: unknown; auth?: boolean } = {}
  ): Promise<T> {
    const url = new URL(`${this.serverUrl}/api${path}`);
    for (const [key, value] of Object.entries(options.query ?? {})) {
      if (value === undefined || value === null || value === '') continue;
      url.searchParams.set(key, String(value));
    }
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (options.auth !== false && this.apiKey) headers.Authorization = `Bearer ${this.apiKey}`;
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    for (let attempt = 0; ; attempt++) {
      if (this.signal?.aborted) throw new PaperclipError('aborted', 'Sync was stopped.');
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      this.signal?.addEventListener('abort', onAbort);
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, this.timeoutMs);
      let res: Response;
      this.requestCount++;
      try {
        res = await this.fetchImpl(url.toString(), {
          method: options.method ?? 'GET',
          headers,
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
          credentials: 'omit',
          cache: 'no-store',
          redirect: 'error',
          signal: controller.signal,
        });
      } catch (err) {
        if (this.signal?.aborted) throw new PaperclipError('aborted', 'Sync was stopped.');
        if (timedOut) throw new PaperclipError('timeout', `Paperclip at ${this.serverUrl} did not answer in time.`);
        throw new PaperclipError(
          'unreachable',
          `Can't reach Paperclip at ${this.serverUrl}. Check that it is running and that Threadkeeper may access it.`
        );
      } finally {
        clearTimeout(timer);
        this.signal?.removeEventListener('abort', onAbort);
      }

      let body: unknown = null;
      const text = await res.text().catch(() => '');
      if (text) {
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
          if (res.ok) throw new PaperclipError('not_paperclip', `${this.serverUrl} did not answer like a Paperclip server.`, { status: res.status });
        }
      }

      if (res.status === 429) {
        const wait = retryAfterMs(res, body);
        if (attempt < this.maxRetries && wait <= this.maxWaitMs) {
          await this.sleep(wait);
          continue;
        }
        throw new PaperclipError('rate_limited', 'Paperclip asked Threadkeeper to slow down.', { status: 429, retryAfterMs: wait });
      }
      if (res.ok) return body as T;
      const detail = errorMessage(body);
      if (res.status === 401) {
        throw new PaperclipError('unauthorized', detail || 'Paperclip needs you to sign in again.', { status: 401 });
      }
      if (res.status === 403) {
        throw new PaperclipError('forbidden', detail || 'This Paperclip account cannot read that.', { status: 403 });
      }
      if (res.status === 404) throw new PaperclipError('not_found', detail || 'Not found in Paperclip.', { status: 404 });
      throw new PaperclipError('server', detail || `Paperclip answered ${res.status}.`, { status: res.status });
    }
  }

  async health(): Promise<PaperclipHealth> {
    const body = await this.request<unknown>('/health', { auth: false });
    const health = parseHealth(body);
    if (!health) throw new PaperclipError('not_paperclip', `${this.serverUrl} is running, but it is not a Paperclip server.`);
    return health;
  }

  me(): Promise<PcMe> {
    return this.request<PcMe>('/cli-auth/me');
  }

  async listCompanies(): Promise<PcCompany[]> {
    return asArray<PcCompany>(await this.request('/companies', { query: { scope: 'accessible' } }), 'companies');
  }

  async listAgents(companyId: string): Promise<PcAgent[]> {
    return asArray<PcAgent>(await this.request(`/companies/${encodeURIComponent(companyId)}/agents`), 'agents');
  }

  async listProjects(companyId: string): Promise<PcProject[]> {
    return asArray<PcProject>(await this.request(`/companies/${encodeURIComponent(companyId)}/projects`), 'projects');
  }

  async listGoals(companyId: string): Promise<PcGoal[]> {
    return asArray<PcGoal>(await this.request(`/companies/${encodeURIComponent(companyId)}/goals`), 'goals');
  }

  /** Issues updated strictly after `updatedSince`, oldest change first. */
  async listIssues(companyId: string, params: IssueListParams = {}): Promise<PcIssue[]> {
    return asArray<PcIssue>(
      await this.request(`/companies/${encodeURIComponent(companyId)}/issues`, {
        query: {
          updatedSince: params.updatedSince,
          sortField: 'updated',
          sortDir: 'asc',
          limit: params.limit ?? 100,
          offset: params.offset ?? 0,
        },
      }),
      'issues',
      'items'
    );
  }

  getIssue(issueId: string): Promise<PcIssue> {
    return this.request<PcIssue>(`/issues/${encodeURIComponent(issueId)}`);
  }

  /** Every comment, oldest first (pages of 500 until a short page). */
  async listComments(issueId: string, maxComments = 5000): Promise<PcComment[]> {
    const out: PcComment[] = [];
    let after: string | undefined;
    while (out.length < maxComments) {
      const page = asArray<PcComment>(
        await this.request(`/issues/${encodeURIComponent(issueId)}/comments`, {
          query: { order: 'asc', limit: 500, after },
        }),
        'comments'
      );
      out.push(...page);
      if (page.length < 500) break;
      const last = page[page.length - 1]?.id;
      if (!last || last === after) break;
      after = last;
    }
    return out.slice(0, maxComments);
  }

  async listIssueRuns(issueId: string): Promise<PcIssueRun[]> {
    return asArray<PcIssueRun>(await this.request(`/issues/${encodeURIComponent(issueId)}/runs`), 'runs');
  }

  getRun(runId: string): Promise<PcRun> {
    return this.request<PcRun>(`/heartbeat-runs/${encodeURIComponent(runId)}`);
  }

  async readRunLog(runId: string, offset = 0, limitBytes = 1_048_576): Promise<PcRunLogPage> {
    const body = await this.request<Record<string, unknown>>(`/heartbeat-runs/${encodeURIComponent(runId)}/log`, {
      query: { offset, limitBytes },
    });
    const next = body?.nextOffset;
    return {
      content: typeof body?.content === 'string' ? body.content : '',
      nextOffset: typeof next === 'number' && Number.isFinite(next) ? next : null,
    };
  }

  async listRunEvents(runId: string, afterSeq = 0, limit = 200): Promise<PcRunEvent[]> {
    return asArray<PcRunEvent>(
      await this.request(`/heartbeat-runs/${encodeURIComponent(runId)}/events`, {
        query: { afterSeq, limit, view: 'conversation' },
      }),
      'events'
    );
  }

  /** The newest runs of a company (the only way to notice runs that did not touch their issue). */
  async listCompanyRuns(companyId: string, limit = 100): Promise<PcRunSummary[]> {
    return asArray<PcRunSummary>(
      await this.request(`/companies/${encodeURIComponent(companyId)}/heartbeat-runs`, { query: { summary: true, limit } }),
      'runs'
    );
  }

  createCliAuthChallenge(requestedCompanyId?: string): Promise<PcCliChallenge> {
    return this.request<PcCliChallenge>('/cli-auth/challenges', {
      method: 'POST',
      auth: false,
      body: {
        command: 'Threadkeeper: read issues, comments and agent runs',
        clientName: 'Threadkeeper',
        requestedAccess: 'board',
        ...(requestedCompanyId ? { requestedCompanyId } : {}),
      },
    });
  }

  getCliAuthChallenge(id: string, token: string): Promise<PcCliChallengeStatus> {
    return this.request<PcCliChallengeStatus>(`/cli-auth/challenges/${encodeURIComponent(id)}`, {
      auth: false,
      query: { token },
    });
  }

  async revokeCurrentKey(): Promise<void> {
    await this.request('/cli-auth/revoke-current', { method: 'POST', body: {} });
  }
}

export interface ProbeResult {
  serverUrl: string;
  health: PaperclipHealth;
}

/** Check that a Paperclip server answers at `serverUrl` (GET /api/health). */
export async function probeServer(
  serverUrl: string,
  options: { fetch?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ProbeResult> {
  const client = new PaperclipClient({
    serverUrl,
    fetch: options.fetch,
    timeoutMs: options.timeoutMs ?? 4000,
    maxRateLimitRetries: 1,
    signal: options.signal,
  });
  return { serverUrl: client.serverUrl, health: await client.health() };
}

/**
 * Find a Paperclip server on this computer: the given URL first, then localhost and 127.0.0.1
 * on ports 3100-3110 (Paperclip moves to the next free port when 3100 is taken).
 */
export async function discoverServer(
  options: { preferred?: string; fetch?: FetchLike; timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ProbeResult | null> {
  const candidates: string[] = [];
  const preferred = options.preferred ? normalizeServerUrl(options.preferred) : null;
  if (preferred) candidates.push(preferred);
  for (const host of ['localhost', '127.0.0.1']) {
    for (const port of PAPERCLIP_PORT_RANGE) {
      const url = `http://${host}:${port}`;
      if (!candidates.includes(url)) candidates.push(url);
    }
  }
  const results = await Promise.all(
    candidates.map((url) =>
      probeServer(url, { fetch: options.fetch, timeoutMs: options.timeoutMs ?? 2500, signal: options.signal }).catch(() => null)
    )
  );
  return results.find((r): r is ProbeResult => r !== null) ?? null;
}
