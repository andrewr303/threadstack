/**
 * Incremental Paperclip → ThreadStack sync. Read-only: nothing is ever written to Paperclip.
 *
 * Per company (all the user can see, or the ones chosen in Settings):
 *   1. Runs: the newest 100 runs (GET /companies/:id/heartbeat-runs?summary=true). A run that is new
 *      or changed since the last sync marks its issue dirty, because a run does not always touch
 *      its issue's updatedAt.
 *   2. Issues: GET /companies/:id/issues?updatedSince=<cursor>&sortField=updated&sortDir=asc, paged.
 *      The filter is strictly greater-than and timestamps can tie, so the query starts 2 s before
 *      the cursor and issues already stored at the cursor are skipped.
 *   3. Each changed or dirty issue is fetched in full (issue, comments, runs) and stored as one
 *      thread. A finished run whose log size has not changed reuses the transcript already stored
 *      (its header message id records status and log size), so only new or growing runs are read.
 *
 * The cursor and run marks persist in chrome.storage.local, so an interrupted or budget-limited
 * sync resumes where it stopped. 429 answers are retried in place when short, otherwise the sync
 * backs off; repeated failures back off 5 → 60 minutes.
 */
import {
  ensureStarterCollectionsAndSettings,
  upsertThread,
  type ThreadStackDB,
} from '../db.js';
import { buildThreadKey, type ConversationRecord, type SettingsRecord } from '../schema.js';
import { processThreadsLocally } from '../pipeline.js';
import {
  PaperclipClient,
  PaperclipError,
  type FetchLike,
  type PcAgent,
  type PcCompany,
  type PcIssue,
  type PcIssueRun,
  type PcRunEvent,
} from './client.js';
import {
  agentLabel,
  buildIssueThread,
  entriesFromLog,
  entriesFromNativeEvents,
  isTerminalRun,
  paperclipThreadKey,
  parseRunHeaderId,
  runEntriesToMessages,
  runHeaderId,
  runHeaderText,
  workflowStateForIssue,
  type Msg,
  type RunBlock,
  type TranscriptEntry,
} from './mapper.js';

export const PAPERCLIP_STATE_KEY = 'tk.paperclip.sync.v1';
export const PAPERCLIP_SYNC_ALARM = 'tk-paperclip-sync';
export const PAPERCLIP_SYNC_PERIOD_MINUTES = 5;

/** Runs per issue whose transcripts are imported (older runs keep a one-line header). */
export const RUNS_WITH_TRANSCRIPT = 30;
/** Largest run log read per run. */
export const MAX_LOG_BYTES = 4 * 1024 * 1024;
const LOG_PAGE_BYTES = 1_048_576;
const MAX_RUN_EVENTS = 4000;
const ISSUE_PAGE = 100;
const RUN_MARK_LIMIT = 400;
const CURSOR_OVERLAP_MS = 2000;

export interface SyncSummary {
  companies: number;
  issuesChecked: number;
  threadsStored: number;
  runsRead: number;
  skippedDeleted: number;
  /** Stopped at the time or issue budget; the next sync continues. */
  partial: boolean;
}

export interface PaperclipCompanyState {
  name: string;
  /** updatedAt of the newest issue stored (ISO, '' before the first sync). */
  cursor: string;
  /** Issues already stored whose updatedAt equals the cursor (skipped on the overlapping re-read). */
  cursorIds: string[];
  /** runId → "status|updatedAt|logBytes" as last seen in the company's newest runs. */
  runMarks: Record<string, string>;
}

export interface PaperclipSyncState {
  version: 1;
  /** Server the cursors belong to; a different server starts over. */
  serverUrl: string;
  running: boolean;
  runningSince: string;
  progress: string;
  lastSyncAt: string;
  lastSuccessAt: string;
  lastError: string;
  lastErrorAt: string;
  failures: number;
  backoffUntil: string;
  lastResult: SyncSummary | null;
  /** Threads stored from Paperclip in total (informational). */
  threadCount: number;
  companies: Record<string, PaperclipCompanyState>;
}

export const EMPTY_PAPERCLIP_STATE: PaperclipSyncState = {
  version: 1,
  serverUrl: '',
  running: false,
  runningSince: '',
  progress: '',
  lastSyncAt: '',
  lastSuccessAt: '',
  lastError: '',
  lastErrorAt: '',
  failures: 0,
  backoffUntil: '',
  lastResult: null,
  threadCount: 0,
  companies: {},
};

function text(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** Coerce whatever is stored under PAPERCLIP_STATE_KEY. */
export function normalizeSyncState(raw: unknown): PaperclipSyncState {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const companies: Record<string, PaperclipCompanyState> = {};
  const rawCompanies = r.companies && typeof r.companies === 'object' ? (r.companies as Record<string, unknown>) : {};
  for (const [id, value] of Object.entries(rawCompanies)) {
    const c = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    const marks = c.runMarks && typeof c.runMarks === 'object' ? (c.runMarks as Record<string, unknown>) : {};
    companies[id] = {
      name: text(c.name),
      cursor: text(c.cursor),
      cursorIds: Array.isArray(c.cursorIds) ? c.cursorIds.filter((x): x is string => typeof x === 'string').slice(0, 200) : [],
      runMarks: Object.fromEntries(Object.entries(marks).filter(([, v]) => typeof v === 'string')) as Record<string, string>,
    };
  }
  const result = r.lastResult && typeof r.lastResult === 'object' ? (r.lastResult as SyncSummary) : null;
  return {
    version: 1,
    serverUrl: text(r.serverUrl),
    running: r.running === true,
    runningSince: text(r.runningSince),
    progress: text(r.progress),
    lastSyncAt: text(r.lastSyncAt),
    lastSuccessAt: text(r.lastSuccessAt),
    lastError: text(r.lastError),
    lastErrorAt: text(r.lastErrorAt),
    failures: Number.isFinite(Number(r.failures)) ? Math.max(0, Number(r.failures)) : 0,
    backoffUntil: text(r.backoffUntil),
    lastResult: result,
    threadCount: Number.isFinite(Number(r.threadCount)) ? Math.max(0, Number(r.threadCount)) : 0,
    companies,
  };
}

export interface SyncStateStore {
  load(): Promise<PaperclipSyncState>;
  save(state: PaperclipSyncState): Promise<void>;
}

export function memoryStateStore(initial?: Partial<PaperclipSyncState>): SyncStateStore & { current: PaperclipSyncState } {
  const store = {
    current: normalizeSyncState({ ...EMPTY_PAPERCLIP_STATE, ...(initial ?? {}) }),
    async load() {
      return normalizeSyncState(JSON.parse(JSON.stringify(store.current)));
    },
    async save(state: PaperclipSyncState) {
      store.current = normalizeSyncState(JSON.parse(JSON.stringify(state)));
    },
  };
  return store;
}

/** chrome.storage.local in the extension; memory elsewhere (tests, previews). */
export function chromeStateStore(): SyncStateStore {
  const area = typeof chrome !== 'undefined' ? chrome.storage?.local : undefined;
  if (!area) return memoryStateStore();
  return {
    async load() {
      const got = await area.get(PAPERCLIP_STATE_KEY);
      return normalizeSyncState(got?.[PAPERCLIP_STATE_KEY]);
    },
    async save(state) {
      await area.set({ [PAPERCLIP_STATE_KEY]: state });
    },
  };
}

/** Wait after the n-th consecutive failure: 5, 10, 20, 40, then 60 minutes. */
export function failureBackoffMs(failures: number): number {
  if (failures <= 0) return 0;
  return Math.min(60, 5 * 2 ** (failures - 1)) * 60_000;
}

/** A sentence for Settings, from any error a sync can hit. */
export function describeSyncError(err: unknown): string {
  if (err instanceof PaperclipError) {
    if (err.kind === 'unauthorized') return 'Paperclip needs you to sign in again (Settings → Paperclip).';
    if (err.kind === 'rate_limited') return 'Paperclip asked ThreadStack to slow down; the sync will continue shortly.';
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export interface SyncOptions {
  db: ThreadStackDB;
  settings?: SettingsRecord;
  store?: SyncStateStore;
  fetch?: FetchLike;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
  /** Wall-clock budget; whatever is left continues on the next sync. */
  budgetMs?: number;
  /** Issues fetched in full per sync. */
  maxIssues?: number;
  /** Ignore the failure backoff (Sync now). */
  force?: boolean;
  /** Local analysis + filing for the stored threads (defaults to processThreadsLocally). */
  organize?: (threadKeys: string[], settings: SettingsRecord) => Promise<void>;
  onProgress?: (message: string) => void;
}

export interface SyncOutcome {
  status: 'off' | 'backoff' | 'busy' | 'ok' | 'partial' | 'error';
  summary: SyncSummary;
  threadKeys: string[];
  error?: string;
}

interface CompanyContext {
  company: PcCompany;
  agents: Map<string, PcAgent>;
  projects: Map<string, string>;
  goals: Map<string, string>;
}

/** Group a stored thread's run messages by run id, keeping the header id that describes them. */
function storedRunBlocks(messages: Array<{ sourceMessageId: string; role: Msg['role']; content: string; createdAt: string | null; ordinal: number }>) {
  const blocks = new Map<string, { headerId: string; sessionId: string | null; messages: Msg[] }>();
  const sorted = [...messages].sort((a, b) => a.ordinal - b.ordinal);
  for (const m of sorted) {
    const match = m.sourceMessageId.match(/^run:([^:]+):/);
    if (!match) continue;
    const runId = match[1];
    let block = blocks.get(runId);
    if (!block) {
      block = { headerId: '', sessionId: null, messages: [] };
      blocks.set(runId, block);
    }
    const header = parseRunHeaderId(m.sourceMessageId);
    if (header) {
      block.headerId = m.sourceMessageId;
      block.sessionId = header.sessionId;
    }
    block.messages.push({ sourceMessageId: m.sourceMessageId, role: m.role, content: m.content, createdAt: m.createdAt, branchPath: 'main' });
  }
  return blocks;
}

function time(v: string | null | undefined): number {
  const t = v ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : 0;
}

export class PaperclipSync {
  private readonly db: ThreadStackDB;
  private readonly client: PaperclipClient;
  private readonly settings: SettingsRecord;
  private readonly now: () => number;
  summary: SyncSummary = { companies: 0, issuesChecked: 0, threadsStored: 0, runsRead: 0, skippedDeleted: 0, partial: false };
  readonly storedKeys: string[] = [];
  /** Paperclip workflow state per stored thread, applied after organizing. */
  readonly states = new Map<string, ReturnType<typeof workflowStateForIssue>>();

  constructor(db: ThreadStackDB, client: PaperclipClient, settings: SettingsRecord, now: () => number) {
    this.db = db;
    this.client = client;
    this.settings = settings;
    this.now = now;
  }

  async loadCompanyContext(company: PcCompany): Promise<CompanyContext> {
    const [agents, projects, goals] = await Promise.all([
      this.client.listAgents(company.id),
      this.client.listProjects(company.id).catch(() => []),
      this.client.listGoals(company.id).catch(() => []),
    ]);
    return {
      company,
      agents: new Map(agents.filter((a) => a && typeof a.id === 'string').map((a) => [a.id, a])),
      projects: new Map(projects.filter((p) => p?.id).map((p) => [p.id, p.name])),
      goals: new Map(goals.filter((g) => g?.id).map((g) => [g.id, g.title])),
    };
  }

  private async readRunEntries(run: PcIssueRun): Promise<{ entries: TranscriptEntry[]; truncated: boolean }> {
    const native = run.runtimeMode === 'native' || run.adapterType === 'paperclip_runner';
    const readEvents = async () => {
      const events: PcRunEvent[] = [];
      let after = 0;
      while (events.length < MAX_RUN_EVENTS) {
        const page = await this.client.listRunEvents(run.runId, after, 200);
        events.push(...page);
        const last = page.at(-1)?.seq;
        if (page.length < 200 || typeof last !== 'number' || last <= after) break;
        after = last;
      }
      return { entries: entriesFromNativeEvents(events), truncated: events.length >= MAX_RUN_EVENTS };
    };
    if (native) return readEvents();

    let content = '';
    let offset = 0;
    let truncated = false;
    for (;;) {
      const page = await this.client.readRunLog(run.runId, offset, LOG_PAGE_BYTES);
      content += page.content.endsWith('\n') || !page.content ? page.content : `${page.content}\n`;
      if (page.nextOffset === null || page.nextOffset === undefined || page.nextOffset <= offset) break;
      offset = page.nextOffset;
      if (offset >= MAX_LOG_BYTES) {
        truncated = true;
        break;
      }
    }
    const entries = entriesFromLog(content);
    if (entries.length === 0 && Number(run.logBytes ?? 0) === 0) {
      // No log on disk (or a native run reported as legacy): the events may still hold the conversation.
      try {
        return await readEvents();
      } catch {
        return { entries, truncated };
      }
    }
    return { entries, truncated };
  }

  /** Linked Claude Code / Codex threads for the sessions a run resumed. */
  private async linkedKeys(blocks: RunBlock[]): Promise<string[]> {
    const keys = new Set<string>();
    for (const block of blocks) {
      const provider = block.run.adapterType === 'claude_local' ? 'claude_code' : block.run.adapterType === 'codex_local' ? 'codex' : null;
      if (!provider || !block.sessionId) continue;
      const found = await this.db.conversations
        .where('sourceConversationId')
        .equals(block.sessionId)
        .filter((c) => c.provider === provider)
        .primaryKeys();
      if (found.length > 0) {
        for (const key of found) keys.add(String(key));
      } else {
        // Not imported yet: the key it will get once its CLI session is imported.
        const bound = this.settings.boundAccounts[provider];
        keys.add(buildThreadKey({ provider, accountId: bound.accountId, workspaceId: bound.workspaceId, sourceConversationId: block.sessionId, branchId: 'main' }));
      }
    }
    return Array.from(keys).slice(0, 50);
  }

  /** Fetch one issue in full and store it as a thread; returns its thread key. */
  async syncIssue(ctx: CompanyContext, issueId: string): Promise<string | null> {
    const issue: PcIssue = await this.client.getIssue(issueId);
    if (!issue?.id) return null;
    if (issue.companyId !== ctx.company.id) throw new PaperclipError('forbidden', 'Task belongs to another company');
    const account = this.settings.boundAccounts.paperclip;
    const threadKey = paperclipThreadKey(account, issue.id);
    const [comments, runRows, storedMessages, existing] = await Promise.all([
      this.client.listComments(issue.id),
      this.client.listIssueRuns(issue.id).catch((err) => {
        // Run telemetry can be off-limits for a restricted board user; the issue still syncs.
        if (err instanceof PaperclipError && (err.kind === 'forbidden' || err.kind === 'not_found')) return [] as PcIssueRun[];
        throw err;
      }),
      this.db.messages.where('threadKey').equals(threadKey).toArray(),
      this.db.conversations.get(threadKey),
    ]);
    const stored = storedRunBlocks(storedMessages);
    const runs = runRows
      .filter((r) => r && typeof r.runId === 'string')
      .sort((a, b) => time(a.startedAt ?? a.createdAt) - time(b.startedAt ?? b.createdAt));
    const withTranscript = new Set(runs.slice(-RUNS_WITH_TRANSCRIPT).map((r) => r.runId));

    const blocks: RunBlock[] = [];
    let latestModel: string | null = null;
    for (const run of runs) {
      const agent = run.agentId ? ctx.agents.get(run.agentId) : undefined;
      const label = agentLabel(agent, run.adapterType);
      const ts = run.startedAt ?? run.createdAt ?? null;
      const previous = stored.get(run.runId);

      if (!withTranscript.has(run.runId)) {
        const header: Msg = {
          sourceMessageId: runHeaderId(run, previous?.sessionId ?? null),
          role: 'system',
          content: runHeaderText(run, { agent: label, omitted: true }),
          createdAt: ts,
          branchPath: 'main',
        };
        blocks.push({ run, messages: [header], model: null, sessionId: previous?.sessionId ?? null, cwd: null });
        continue;
      }

      const storedHeader = previous ? parseRunHeaderId(previous.headerId) : null;
      const reusable =
        previous &&
        storedHeader &&
        isTerminalRun(run.status) &&
        storedHeader.status === run.status &&
        storedHeader.logBytes === Math.max(0, Math.trunc(Number(run.logBytes ?? 0)) || 0);
      if (reusable) {
        blocks.push({ run, messages: previous.messages, model: null, sessionId: previous.sessionId, cwd: null });
        continue;
      }

      const [detail, read] = await Promise.all([
        this.client.getRun(run.runId).catch(() => null),
        this.readRunEntries(run),
      ]);
      this.summary.runsRead++;
      const transcript = runEntriesToMessages(run.runId, read.entries, ts);
      const sessionId = (detail?.sessionIdAfter || transcript.sessionId || null) as string | null;
      const header: Msg = {
        sourceMessageId: runHeaderId(run, sessionId),
        role: 'system',
        content: runHeaderText(run, { agent: label, detail, errors: transcript.errors }) + (read.truncated ? '\n(Log too long; the start of the run is shown.)' : ''),
        createdAt: ts,
        branchPath: 'main',
      };
      if (transcript.model) latestModel = transcript.model;
      blocks.push({ run, messages: [header, ...transcript.messages], model: transcript.model, sessionId, cwd: null });
    }

    const thread = buildIssueThread({
      serverUrl: this.client.serverUrl,
      company: ctx.company,
      issue,
      comments,
      runs: blocks,
      agents: ctx.agents,
      projectName: (issue.projectId && ctx.projects.get(issue.projectId)) || issue.project?.name || null,
      goalTitle: (issue.goalId && ctx.goals.get(issue.goalId)) || issue.goal?.title || null,
      account,
      linkedThreadKeys: await this.linkedKeys(blocks),
    });
    if (!thread.modelSlug && !latestModel && existing?.modelSlug) thread.modelSlug = existing.modelSlug;

    const result = await upsertThread(this.db, thread);
    if (result.status === 'skipped_tombstone') {
      this.summary.skippedDeleted++;
      return null;
    }
    this.summary.threadsStored++;
    this.storedKeys.push(threadKey);
    this.states.set(threadKey, workflowStateForIssue(issue.status));
    return threadKey;
  }

  /** Paperclip's status wins over inferred status; a status the user set by hand is left alone. */
  async applyWorkflowStates(): Promise<void> {
    for (const [threadKey, state] of this.states) {
      await this.db.transaction('rw', this.db.conversations, async () => {
        const conv: ConversationRecord | undefined = await this.db.conversations.get(threadKey);
        if (!conv || conv.workflowStateSource === 'manual' || conv.workflowState === state) return;
        await this.db.conversations.put({ ...conv, workflowState: state, workflowStateSource: 'auto' });
      });
    }
  }
}

function filterCompanies(companies: PcCompany[], settings: SettingsRecord): PcCompany[] {
  const live = companies.filter((c) => c && typeof c.id === 'string' && c.status !== 'archived');
  if (settings.paperclip.companyScope !== 'selected') return live;
  const chosen = new Set(settings.paperclip.companyIds);
  return live.filter((c) => chosen.has(c.id));
}

/**
 * One sync pass. Never throws: failures land in the persisted state (lastError, backoff) and in
 * the returned outcome.
 */
export async function runPaperclipSync(options: SyncOptions): Promise<SyncOutcome> {
  const now = options.now ?? (() => Date.now());
  const store = options.store ?? chromeStateStore();
  const settings = options.settings ?? (await ensureStarterCollectionsAndSettings(options.db));
  const pc = settings.paperclip;
  const empty: SyncSummary = { companies: 0, issuesChecked: 0, threadsStored: 0, runsRead: 0, skippedDeleted: 0, partial: false };
  if (!pc.enabled || !pc.serverUrl) return { status: 'off', summary: empty, threadKeys: [] };

  const state = await store.load();
  if (state.serverUrl !== pc.serverUrl) {
    state.serverUrl = pc.serverUrl;
    state.companies = {};
    state.failures = 0;
    state.backoffUntil = '';
  }
  if (!options.force && state.backoffUntil && Date.parse(state.backoffUntil) > now()) {
    return { status: 'backoff', summary: empty, threadKeys: [] };
  }

  const startedAt = now();
  const deadline = startedAt + (options.budgetMs ?? 50_000);
  const maxIssues = options.maxIssues ?? 150;
  const progress = async (message: string) => {
    state.progress = message;
    options.onProgress?.(message);
    await store.save(state).catch(() => undefined);
  };
  state.running = true;
  state.runningSince = new Date(startedAt).toISOString();
  await progress('Connecting to Paperclip…');

  const client = new PaperclipClient({
    serverUrl: pc.serverUrl,
    apiKey: pc.auth === 'board_key' ? pc.apiKey : '',
    fetch: options.fetch,
    sleep: options.sleep,
    signal: options.signal,
  });
  const sync = new PaperclipSync(options.db, client, settings, now);
  const outOfBudget = () => now() >= deadline || sync.summary.issuesChecked >= maxIssues;
  let failure: unknown = null;

  try {
    const companies = filterCompanies(await client.listCompanies(), settings);
    sync.summary.companies = companies.length;
    for (const company of companies) {
      if (outOfBudget()) {
        sync.summary.partial = true;
        break;
      }
      const cstate: PaperclipCompanyState = state.companies[company.id] ?? { name: company.name, cursor: '', cursorIds: [], runMarks: {} };
      cstate.name = company.name;
      state.companies[company.id] = cstate;
      let ctx: CompanyContext | null = null;
      const context = async () => (ctx ??= await sync.loadCompanyContext(company));

      // 1. Runs that changed since the last sync mark their issues dirty.
      const dirty = new Set<string>();
      const runMarks = new Map<string, { mark: string; issueId: string | null }>();
      const recentRuns = await client.listCompanyRuns(company.id, 100).catch((err) => {
        if (err instanceof PaperclipError && (err.kind === 'forbidden' || err.kind === 'not_found')) return [];
        throw err;
      });
      for (const run of recentRuns) {
        if (!run?.id) continue;
        const issueId = run.issueId ?? run.contextSnapshot?.issueId ?? null;
        const mark = `${run.status}|${run.updatedAt ?? ''}|${Number(run.logBytes ?? 0)}`;
        runMarks.set(run.id, { mark, issueId });
        if (issueId && cstate.cursor && cstate.runMarks[run.id] !== mark) dirty.add(issueId);
      }

      // 2. Issues changed since the cursor, oldest change first.
      const handled = new Set<string>();
      const sinceMs = cstate.cursor ? Date.parse(cstate.cursor) - CURSOR_OVERLAP_MS : NaN;
      const updatedSince = Number.isFinite(sinceMs) ? new Date(sinceMs).toISOString() : undefined;
      let offset = 0;
      let companyPartial = false;
      for (;;) {
        await progress(`Checking ${company.name}…`);
        const page = await client.listIssues(company.id, { updatedSince, limit: ISSUE_PAGE, offset });
        for (const issue of page) {
          if (!issue?.id || handled.has(issue.id)) continue;
          const at = issue.updatedAt ?? '';
          const atCursor = cstate.cursor !== '' && time(at) <= time(cstate.cursor);
          if (atCursor && cstate.cursorIds.includes(issue.id) && !dirty.has(issue.id)) {
            handled.add(issue.id);
            continue;
          }
          if (outOfBudget()) {
            companyPartial = true;
            break;
          }
          sync.summary.issuesChecked++;
          await progress(`Reading ${issue.identifier || issue.title || 'issue'} (${company.name})…`);
          await sync.syncIssue(await context(), issue.id);
          handled.add(issue.id);
          dirty.delete(issue.id);
          if (at && time(at) > time(cstate.cursor)) {
            cstate.cursor = new Date(time(at)).toISOString();
            cstate.cursorIds = [issue.id];
          } else if (at && time(at) === time(cstate.cursor) && !cstate.cursorIds.includes(issue.id)) {
            cstate.cursorIds = [...cstate.cursorIds, issue.id].slice(-200);
          }
        }
        if (companyPartial || page.length < ISSUE_PAGE) break;
        offset += page.length;
      }

      // 3. Issues whose runs changed without touching the issue.
      for (const issueId of dirty) {
        if (handled.has(issueId)) continue;
        if (outOfBudget()) {
          companyPartial = true;
          break;
        }
        sync.summary.issuesChecked++;
        try {
          await sync.syncIssue(await context(), issueId);
          handled.add(issueId);
        } catch (err) {
          // The issue may be gone or hidden; its run mark is kept so it is not retried forever.
          if (!(err instanceof PaperclipError && (err.kind === 'not_found' || err.kind === 'forbidden'))) throw err;
          handled.add(issueId);
        }
      }

      // Remember run marks for the runs whose issues are now up to date (or that have no issue).
      const nextMarks: Record<string, string> = {};
      for (const [runId, { mark, issueId }] of runMarks) {
        if (!issueId || handled.has(issueId) || !cstate.cursor) nextMarks[runId] = mark;
        else if (cstate.runMarks[runId]) nextMarks[runId] = cstate.runMarks[runId];
      }
      cstate.runMarks = Object.fromEntries(Object.entries(nextMarks).slice(0, RUN_MARK_LIMIT));
      if (companyPartial) sync.summary.partial = true;
      await store.save(state).catch(() => undefined);
    }
  } catch (err) {
    failure = err;
  }

  // Threads stored before any failure still get organized.
  if (sync.storedKeys.length > 0) {
    await progress(`Organizing ${sync.storedKeys.length} thread${sync.storedKeys.length === 1 ? '' : 's'}…`);
    try {
      const organize =
        options.organize ??
        (async (keys: string[], s: SettingsRecord) => {
          await processThreadsLocally(options.db, keys, { aiDelaySeconds: s.autoOrganize.aiDebounceSeconds });
        });
      await organize(sync.storedKeys, settings);
      await sync.applyWorkflowStates();
    } catch (err) {
      failure ??= err;
    }
  }

  const finishedAt = new Date(now()).toISOString();
  state.running = false;
  state.progress = '';
  state.lastSyncAt = finishedAt;
  state.lastResult = { ...sync.summary };
  state.threadCount = await options.db.conversations.where('provider').equals('paperclip').count();
  let status: SyncOutcome['status'];
  if (failure) {
    status = 'error';
    state.failures += 1;
    const retryAfter = failure instanceof PaperclipError && failure.kind === 'rate_limited' ? failure.retryAfterMs ?? 0 : 0;
    state.backoffUntil = new Date(now() + Math.max(failureBackoffMs(state.failures), retryAfter)).toISOString();
    state.lastError = describeSyncError(failure);
    state.lastErrorAt = finishedAt;
  } else {
    status = sync.summary.partial ? 'partial' : 'ok';
    state.failures = 0;
    state.backoffUntil = '';
    state.lastError = '';
    state.lastErrorAt = '';
    state.lastSuccessAt = finishedAt;
  }
  await store.save(state).catch(() => undefined);
  return {
    status,
    summary: sync.summary,
    threadKeys: [...sync.storedKeys],
    ...(failure ? { error: state.lastError } : {}),
  };
}

/** Plain-language result line for Settings. */
export function describeSyncResult(state: PaperclipSyncState): string {
  const r = state.lastResult;
  if (!r) return 'Not synced yet.';
  if (r.threadsStored === 0 && !r.partial) return 'Up to date.';
  const parts = [`${r.threadsStored} issue${r.threadsStored === 1 ? '' : 's'} updated`];
  if (r.runsRead > 0) parts.push(`${r.runsRead} run${r.runsRead === 1 ? '' : 's'} read`);
  if (r.skippedDeleted > 0) parts.push(`${r.skippedDeleted} deleted here, left out`);
  return `${parts.join(', ')}${r.partial ? '; more to sync, continuing shortly' : ''}.`;
}

/** Apply a bounded bridge hint without advancing the periodic sync's cursor or run marks. */
export async function runPaperclipHintSync(
  hint: { companyId: string; issueIds: string[]; runIds?: string[] },
  options: SyncOptions,
): Promise<string[]> {
  const settings = options.settings ?? await ensureStarterCollectionsAndSettings(options.db);
  const pc = settings.paperclip;
  if (!pc.enabled || !hint.companyId || !Array.isArray(hint.issueIds)) return [];
  if (pc.companyScope === 'selected' && !pc.companyIds.includes(hint.companyId)) return [];
  const client = new PaperclipClient({ serverUrl: pc.serverUrl, apiKey: pc.auth === 'board_key' ? pc.apiKey : '', fetch: options.fetch, signal: options.signal, sleep: options.sleep });
  const company = filterCompanies(await client.listCompanies(), settings).find(c => c.id === hint.companyId);
  if (!company) return [];
  const sync = new PaperclipSync(options.db, client, settings, options.now ?? Date.now);
  const ctx = await sync.loadCompanyContext(company);
  const validId = (id: unknown): id is string => typeof id === 'string' && id.length > 0 && id.length <= 200;
  const issueIds = new Set(hint.issueIds.filter(validId));
  const runIds = [...new Set((hint.runIds ?? []).filter(validId))].slice(0, 100);
  // One deleted, hidden or foreign task or run is skipped; the rest of the hint still applies (REQ-12 F-3).
  const skippable = (err: unknown) => err instanceof PaperclipError && (err.kind === 'not_found' || err.kind === 'forbidden');
  if (runIds.length) {
    const summaries = await client.listCompanyRuns(company.id);
    for (const runId of runIds) {
      const summary = summaries.find(run => run.id === runId);
      let issueId = summary?.issueId ?? summary?.contextSnapshot?.issueId;
      if (!issueId) {
        try {
          const detail = await client.getRun(runId);
          if (detail.companyId !== company.id) throw new PaperclipError('forbidden', 'Run belongs to another company');
          issueId = detail.issueId ?? (typeof detail.contextSnapshot?.issueId === 'string' ? detail.contextSnapshot.issueId : undefined);
        } catch (err) { if (!skippable(err)) throw err; continue; }
      }
      if (validId(issueId)) issueIds.add(issueId);
    }
  }
  for (const id of [...issueIds].slice(0, 100)) {
    try { await sync.syncIssue(ctx, id); }
    catch (err) { if (!skippable(err)) throw err; }
  }
  if (options.store) {
    // "Last synced" reflects a hint-driven fetch; cursors, run marks and back-off stay the timer's.
    const state = await options.store.load();
    state.lastSyncAt = new Date((options.now ?? Date.now)()).toISOString();
    await options.store.save(state).catch(() => undefined);
  }
  if (sync.storedKeys.length) {
    if (options.organize) await options.organize(sync.storedKeys, settings);
    else await processThreadsLocally(options.db, sync.storedKeys, { aiDelaySeconds: settings.autoOrganize.aiDebounceSeconds });
    await sync.applyWorkflowStates();
  }
  return [...sync.storedKeys];
}

export type { CompanyContext };
