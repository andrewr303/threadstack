import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SYNC_PROVIDERS,
  describeSyncError,
  syncProviderInfo,
  type SyncProviderId,
  type SyncProviderState,
  type SyncState,
} from '../../src/core/history-sync.js';
import { readSignedInIdentity, runApiSync } from '../../src/core/site-history.js';
import { readSidebarConversations } from '../../src/core/sidebar-history.js';
import {
  HistorySyncOrchestrator,
  STEP_TIMEOUTS,
  type SyncAccount,
  type SyncEnv,
  type SyncIdentityReply,
} from '../../src/core/sync-orchestrator.js';
import type { SiteConversation } from '../../src/core/site-api.js';
import { ThreadkeeperDB, upsertThread } from '../../src/core/db.js';
import { DEFAULT_SETTINGS } from '../../src/core/schema.js';
import { HISTORY_SYNC_STATE_KEY, createChromeSyncEnv, syncedThreadInput } from '../../src/core/sync-env.js';
import {
  ANALYSIS_HELD_REASON,
  ANALYSIS_HOLD_KEY,
  HOLD_STALE_MS,
  activeAnalysisHold,
  holdAnalysis,
  releaseAnalysisHold,
  touchAnalysisHold,
} from '../../src/core/analysis-hold.js';
import { analyzeJobId, enqueueAnalysis, nextDueAnalysisAt, runAnalysisJobs } from '../../src/core/pipeline.js';
import { describeProviderProgress, importAnnouncement, importTotals } from '../../src/entrypoints/manager/ImportProgress.js';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
/** A promise that never settles: a step that hangs. */
const never = <T>() => new Promise<T>(() => undefined);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// An injected environment whose timers run 1000 times faster than they say, so a 30-second
// step ceiling is reached in 30 ms and a test can let a step hang for real.
// ---------------------------------------------------------------------------

interface FakeOptions {
  enabled?: SyncProviderId[];
  tabs?: Partial<Record<SyncProviderId, number>>;
  sidebar?: Partial<Record<SyncProviderId, Array<{ id: string; url: string; title: string }>>>;
  tabInfo?: (tabId: number) => { url: string | null; title: string | null } | null;
  identity?: SyncIdentityReply;
  accounts?: SyncAccount[];
}

function fake(opts: FakeOptions = {}) {
  let clock = NOW;
  let nextTab = 100;
  const opened: string[] = [];
  const closed: number[] = [];
  const sent: Array<{ tabId: number; message: Record<string, unknown> }> = [];
  const saved: SyncState[] = [];
  const stored: Array<{ conv: SiteConversation; account: SyncAccount | null | undefined }> = [];
  const calls: string[] = [];
  const tabUrls = new Map<number, string>();
  // A tab of the person's shows its site's home page.
  for (const [id, tabId] of Object.entries(opts.tabs ?? {})) tabUrls.set(tabId!, syncProviderInfo(id)!.homeUrl);
  let accountIndex = 0;
  const hooks: { onSend?: (tabId: number, m: Record<string, unknown>) => unknown } = {};
  const env: SyncEnv = {
    now: () => clock,
    newRunId: () => 'sync_test_0001',
    sleep: async (ms) => void (clock += ms),
    timeout: (ms) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const promise = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          clock += ms;
          resolve();
        }, Math.max(1, ms / 1000));
      });
      return { promise, cancel: () => clearTimeout(timer) };
    },
    findTab: async (info) => opts.tabs?.[info.id] ?? null,
    openTab: async (url) => {
      const id = nextTab++;
      opened.push(url);
      tabUrls.set(id, url);
      return id;
    },
    closeTab: async (tabId) => void closed.push(tabId),
    waitTabReady: async () => true,
    ensureContentScript: async () => true,
    sendToTab: async (tabId, message) => {
      const m = message as Record<string, unknown>;
      sent.push({ tabId, message: m });
      const answer = hooks.onSend?.(tabId, m);
      if (answer !== undefined) return answer;
      if (m.type === 'TK_HISTORY_IDENTITY') return { ok: true, ...(opts.identity ?? { status: 'unknown' }) };
      if (m.type === 'TK_HISTORY_LIST_SIDEBAR') return { ok: true, items: opts.sidebar?.[m.provider as SyncProviderId] ?? [] };
      return { ok: true };
    },
    enabledProviders: async () => new Set(opts.enabled ?? ['chatgpt', 'claude', 'claude_code', 'codex', 'gemini']),
    knownUpdatedAt: async () => ({}),
    storeConversation: async (conv, account) => {
      stored.push({ conv, account });
      return 'stored';
    },
    hasRecentCapture: async () => false,
    saveState: async (state) => void saved.push(JSON.parse(JSON.stringify(state))),
    tabInfo: async (tabId) =>
      opts.tabInfo ? opts.tabInfo(tabId) : { url: tabUrls.get(tabId) ?? 'https://chatgpt.com/', title: 'App' },
    holdAnalysis: async (runId) => void calls.push(`hold ${runId}`),
    touchAnalysisHold: async () => undefined,
    releaseAnalysis: async (runId) => {
      calls.push(`release ${runId}`);
      return 3;
    },
  };
  if (opts.accounts) {
    env.resolveAccount = async () => {
      calls.push('resolve');
      return opts.accounts![Math.min(accountIndex, opts.accounts!.length - 1)];
    };
    env.noteIdentity = async (_p, identity) => void calls.push(`identity ${identity.key}`);
  }
  return {
    env,
    opened,
    closed,
    sent,
    saved,
    stored,
    calls,
    hooks,
    switchAccount: () => void (accountIndex += 1),
  };
}

const conv = (n: number): SiteConversation => ({
  provider: 'chatgpt',
  sourceConversationId: uuid(n),
  canonicalUrl: `https://chatgpt.com/c/${uuid(n)}`,
  title: `Chat ${n}`,
  createdAt: null,
  updatedAt: '2026-11-10T00:00:00.000Z',
  messages: [{ sourceMessageId: `m${n}`, role: 'user', content: `Hello ${n}`, createdAt: null, branchPath: 'main' }],
  modelSlug: null,
  providerProjectId: null,
});

/** Make the page-side reader answer a run with `n` conversations and then "done". */
function answerRuns(f: ReturnType<typeof fake>, orch: HistorySyncOrchestrator, provider: SyncProviderId, n = 0) {
  const previous = f.hooks.onSend;
  f.hooks.onSend = (tabId, m) => {
    if (m.type === 'TK_HISTORY_SYNC_RUN' && m.provider === provider) {
      const base = { runId: m.runId as string, provider } as const;
      void (async () => {
        for (let i = 1; i <= n; i++) await orch.handleEvent({ kind: 'conversation', ...base, provider: 'chatgpt', conversation: conv(i) }, tabId);
        await orch.handleEvent({ kind: 'done', ...base, listed: n, message: null }, tabId);
      })();
      return { ok: true };
    }
    return previous?.(tabId, m);
  };
}

const statusOf = (orch: HistorySyncOrchestrator, id: SyncProviderId) => orch.state.providers.find((p) => p.provider === id)!;

// ---------------------------------------------------------------------------
// Hangs
// ---------------------------------------------------------------------------

describe('online import never hangs on a step', () => {
  it('a tab lookup that never answers fails that site with a plain reason and moves on to the next', async () => {
    const f = fake({ enabled: ['chatgpt', 'claude'], tabs: { claude: 5 } });
    f.env.findTab = async (info) => (info.id === 'chatgpt' ? never<number | null>() : 5);
    const orch = new HistorySyncOrchestrator(f.env);
    answerRuns(f, orch, 'claude');
    await orch.start({ providers: ['chatgpt', 'claude'], days: 30 });
    await orch.idle();
    expect(statusOf(orch, 'chatgpt')).toMatchObject({ status: 'error', message: describeSyncError('step_timeout', 'ChatGPT') });
    expect(statusOf(orch, 'claude').status).toBe('done');
    expect(orch.state.running).toBe(false);
  });

  it('a tab that never finishes loading ends as "did not finish loading" and its tab is closed', async () => {
    const f = fake({ enabled: ['chatgpt'] });
    f.env.waitTabReady = () => never<boolean>();
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    expect(statusOf(orch, 'chatgpt').message).toBe(describeSyncError('page_timeout', 'ChatGPT'));
    expect(f.closed).toEqual([100]);
  });

  it('a reader that never answers in the person\'s tab is retried once in a fresh tab, then reported', async () => {
    const f = fake({ enabled: ['chatgpt'], tabs: { chatgpt: 7 } });
    f.env.ensureContentScript = () => never<boolean>();
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    expect(f.opened).toEqual(['https://chatgpt.com/']);
    expect(f.closed).toEqual([100]); // never the person's tab 7
    expect(statusOf(orch, 'chatgpt').message).toBe(describeSyncError('no_reader', 'ChatGPT'));
  });

  it('a start request the page never answers is reported instead of waiting for the idle timeout', async () => {
    const f = fake({ enabled: ['chatgpt'], tabs: { chatgpt: 7 } });
    f.hooks.onSend = (_t, m) => (m.type === 'TK_HISTORY_SYNC_RUN' ? never() : undefined);
    const orch = new HistorySyncOrchestrator(f.env);
    const started = Date.now();
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    expect(statusOf(orch, 'chatgpt').message).toBe(describeSyncError('no_reader', 'ChatGPT'));
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('a sign-in page or a bot check instead of the app is named as such', async () => {
    const login = fake({ enabled: ['claude'], tabInfo: () => ({ url: 'https://claude.ai/login?returnTo=%2Fnew', title: 'Claude' }) });
    const o1 = new HistorySyncOrchestrator(login.env);
    await o1.start({ providers: ['claude'], days: 30 });
    await o1.idle();
    expect(statusOf(o1, 'claude').message).toMatch(/Sign in to Claude/);

    const elsewhere = fake({ enabled: ['chatgpt'], tabInfo: () => ({ url: 'https://auth.openai.com/log-in', title: 'Log in' }) });
    const o2 = new HistorySyncOrchestrator(elsewhere.env);
    await o2.start({ providers: ['chatgpt'], days: 30 });
    await o2.idle();
    expect(statusOf(o2, 'chatgpt').message).toMatch(/Sign in to ChatGPT/);

    // Another host of the same site is the app, not a sign-in redirect.
    const legacy = fake({ enabled: ['chatgpt'], tabs: { chatgpt: 7 }, tabInfo: () => ({ url: 'https://chat.openai.com/', title: 'ChatGPT' }) });
    const oLegacy = new HistorySyncOrchestrator(legacy.env);
    answerRuns(legacy, oLegacy, 'chatgpt');
    await oLegacy.start({ providers: ['chatgpt'], days: 30 });
    await oLegacy.idle();
    expect(statusOf(oLegacy, 'chatgpt').status).toBe('done');

    const check = fake({ enabled: ['chatgpt'], tabInfo: () => ({ url: 'https://chatgpt.com/', title: 'Just a moment...' }) });
    const o3 = new HistorySyncOrchestrator(check.env);
    await o3.start({ providers: ['chatgpt'], days: 30 });
    await o3.idle();
    expect(statusOf(o3, 'chatgpt').message).toMatch(/blocked the request/);
    expect(check.sent.some((s) => s.message.type === 'TK_HISTORY_SYNC_RUN')).toBe(false);
  });

  it('a site the browser has no host permission for is reported without opening anything', async () => {
    const f = fake({ enabled: ['gemini'] });
    f.env.hasHostAccess = async () => false;
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['gemini'], days: 30 });
    await orch.idle();
    expect(statusOf(orch, 'gemini').message).toBe(describeSyncError('no_access', 'Gemini'));
    expect(f.opened).toEqual([]);
  });

  it('a tab closed while the reader runs is noticed within the tab check, not after the idle timeout', async () => {
    let open = true;
    const f = fake({ enabled: ['chatgpt'], tabs: { chatgpt: 7 }, tabInfo: () => (open ? { url: 'https://chatgpt.com/', title: 'ChatGPT' } : null) });
    f.hooks.onSend = (_t, m) => {
      if (m.type === 'TK_HISTORY_SYNC_RUN') setTimeout(() => void (open = false), 5);
      return undefined;
    };
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    expect(statusOf(orch, 'chatgpt').message).toBe(describeSyncError('tab_closed', 'ChatGPT'));
  });

  it('a sidebar list that never comes back fails that site', async () => {
    const f = fake({ enabled: ['gemini'], tabs: { gemini: 3 } });
    f.hooks.onSend = (_t, m) => (m.type === 'TK_HISTORY_LIST_SIDEBAR' ? never() : undefined);
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['gemini'], days: 30 });
    await orch.idle();
    expect(statusOf(orch, 'gemini')).toMatchObject({ status: 'error', message: describeSyncError('step_timeout', 'Gemini') });
  });

  it('stops a tab-by-tab site after three conversations in a row are never captured', async () => {
    const items = [1, 2, 3, 4, 5].map((n) => ({ id: `chat${n}0000`, url: `https://gemini.google.com/app/chat${n}0000`, title: `G${n}` }));
    const f = fake({ enabled: ['gemini'], tabs: { gemini: 3 }, sidebar: { gemini: items } });
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['gemini'], days: 30 });
    await orch.idle();
    expect(statusOf(orch, 'gemini')).toMatchObject({ status: 'error', failed: 3, message: describeSyncError('capture_failed', 'Gemini') });
    expect(f.opened).toHaveLength(3);
  });

  it('cancel ends a step that hangs at once', async () => {
    const f = fake({ enabled: ['chatgpt'] });
    f.env.waitTabReady = () => never<boolean>();
    // Make the step ceiling long enough that only the cancel can end it.
    f.env.timeout = () => ({ promise: never<void>(), cancel: () => undefined });
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await new Promise((r) => setTimeout(r, 5));
    orch.cancel();
    await orch.idle();
    expect(statusOf(orch, 'chatgpt').status).toBe('cancelled');
    expect(orch.state.running).toBe(false);
    expect(f.saved.at(-1)?.running).toBe(false);
  });

  it('saves every step change at once, so a page never keeps showing "opening"', async () => {
    const f = fake({ enabled: ['chatgpt'], tabs: { chatgpt: 7 }, accounts: [{ accountId: 'a', workspaceId: 'w', label: 'Work' }] });
    const orch = new HistorySyncOrchestrator(f.env);
    // The reader starts and then says nothing for a while: the stored state must already say "listing".
    f.hooks.onSend = (tabId, m) => {
      if (m.type === 'TK_HISTORY_SYNC_RUN') {
        setTimeout(() => void orch.handleEvent({ kind: 'done', runId: m.runId as string, provider: 'chatgpt', listed: 0, message: null }, tabId), 30);
      }
      return undefined;
    };
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    const steps = f.saved.map((s) => s.providers[0].status).filter((s, i, all) => s !== all[i - 1]);
    expect(steps).toEqual(['queued', 'opening', 'account', 'listing', 'done']);
    expect(f.saved.every((s) => typeof s.heartbeatAt === 'string')).toBe(true);
    expect(f.saved.find((s) => s.providers[0].status === 'listing')?.providers[0].stepAt).toBeTruthy();
  });

  it('a worker restart mid-run ends the run as interrupted, releases analysis, and leaves no step showing', async () => {
    const lost: SyncState = {
      runId: 'sync_lost_0001',
      running: true,
      days: 30,
      scope: 'all',
      startedAt: new Date(NOW - 60_000).toISOString(),
      finishedAt: null,
      providers: [
        { provider: 'chatgpt', label: 'ChatGPT', strategy: 'api', status: 'done', listed: 4, stored: 4, skipped: 0, failed: 0, message: null },
        { provider: 'claude', label: 'Claude', strategy: 'api', status: 'opening', listed: 0, stored: 0, skipped: 0, failed: 0, message: null },
      ],
    };
    const f = fake();
    f.env.loadState = async () => lost;
    const orch = new HistorySyncOrchestrator(f.env);
    const state = await orch.currentState();
    expect(state).toMatchObject({ running: false, interrupted: true, analysis: { queued: 3 } });
    expect(state.providers.map((p) => p.status)).toEqual(['done', 'error']);
    expect(state.providers[1].message).toBe(describeSyncError('interrupted', 'Claude'));
    expect(f.calls).toEqual(['release sync_lost_0001']);
    expect(f.saved.at(-1)).toMatchObject({ running: false, interrupted: true });
  });

  it('tells a reader from a run the worker no longer has to stop', async () => {
    const orch = new HistorySyncOrchestrator(fake().env);
    expect(await orch.handleEvent({ kind: 'done', runId: 'sync_dead_0001', provider: 'chatgpt', listed: 0, message: null }, 4)).toBe(false);
  });
});

describe('page-side reader requests have deadlines', () => {
  const base = {
    runId: 'run_abcd',
    sinceMs: 0,
    max: 10,
    known: {},
    origin: 'https://chatgpt.com',
    cookies: '',
    isCancelled: () => false,
    sleep: async () => undefined,
    requestTimeoutMs: 20,
  };

  it('a request that never answers ends the run with an error event instead of hanging', async () => {
    const events: Array<{ kind: string; code?: string }> = [];
    let calls = 0;
    await runApiSync({
      ...base,
      provider: 'chatgpt',
      fetchImpl: (() => {
        calls += 1;
        return never<Response>();
      }) as typeof fetch,
      emit: (e) => void events.push(e as { kind: string; code?: string }),
    });
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'network' });
    expect(calls).toBe(3); // retried, then gave up
  });

  it('a response whose body never finishes is abandoned too', async () => {
    const events: Array<{ kind: string; code?: string }> = [];
    const stalled = { ok: true, status: 200, headers: new Headers(), json: () => never() } as unknown as Response;
    await runApiSync({
      ...base,
      provider: 'chatgpt',
      fetchImpl: (async () => stalled) as typeof fetch,
      emit: (e) => void events.push(e as { kind: string; code?: string }),
    });
    expect(events.at(-1)).toMatchObject({ kind: 'error', code: 'network' });
  });
});

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

describe('import progress', () => {
  const p = (patch: Partial<SyncProviderState>): SyncProviderState => ({
    provider: 'chatgpt', label: 'ChatGPT', strategy: 'api', status: 'queued', listed: 0, stored: 0, skipped: 0, failed: 0, message: null, ...patch,
  });

  it('is indeterminate until the total is known, then counts read out of the total', () => {
    expect(describeProviderProgress(p({ status: 'opening' }))).toMatchObject({ step: 'Step 1 of 4: Opening the site', value: null, max: null });
    expect(describeProviderProgress(p({ status: 'account' })).step).toBe('Step 2 of 4: Checking which account is signed in');
    const listing = describeProviderProgress(p({ status: 'listing', listed: 56 }));
    expect(listing).toMatchObject({ value: null, max: null, detail: '56 conversations found so far.' });
    const fetching = describeProviderProgress(p({ status: 'fetching', listed: 40, stored: 10, skipped: 2, failed: 1 }));
    expect(fetching).toMatchObject({ step: 'Step 4 of 4: Importing', value: 13, max: 40 });
    expect(fetching.detail).toBe('13 of 40 read. 10 imported, 2 already up to date, 1 could not be read.');
    expect(fetching.valueText).toBe('13 of 40 threads read, 10 imported');
  });

  it('describes finished, cancelled and stopped sites with their counts', () => {
    expect(describeProviderProgress(p({ status: 'done', listed: 3, stored: 3 }))).toMatchObject({ step: 'Done', value: 3, max: 3 });
    expect(describeProviderProgress(p({ status: 'cancelled', stored: 2 })).detail).toBe('2 imported so far.');
    const stopped = describeProviderProgress(p({ status: 'error', message: 'Sign in to ChatGPT.', stored: 1 }));
    expect(stopped).toMatchObject({ step: 'Stopped' });
    expect(stopped.detail).toBe('Sign in to ChatGPT. 1 imported.');
  });

  it('totals across sites, and announces steps and the outcome without counts that change every second', () => {
    const running: SyncState = {
      runId: 'r', running: true, days: 30, startedAt: null, finishedAt: null,
      providers: [p({ status: 'done', listed: 5, stored: 5 }), p({ provider: 'claude', label: 'Claude', status: 'fetching', listed: 10, stored: 2 })],
    };
    expect(importTotals(running)).toEqual({ found: 15, imported: 7, read: 7, totalKnown: true });
    expect(importAnnouncement(running)).toBe('Importing from Claude: Importing.');
    expect(importTotals({ ...running, providers: [p({ status: 'listing', listed: 3 })] }).totalKnown).toBe(false);
    const finished = { ...running, running: false, providers: [p({ status: 'done', stored: 5 }), p({ provider: 'claude', label: 'Claude', status: 'error', stored: 2 })] };
    expect(importAnnouncement(finished)).toBe('Import finished: 7 threads imported. Stopped early: Claude.');
  });
});

// ---------------------------------------------------------------------------
// Claude Code and Codex on the web
// ---------------------------------------------------------------------------

describe('Claude Code and Codex session lists', () => {
  const doc = (html: string) => new DOMParser().parseFromString(`<html><body>${html}</body></html>`, 'text/html');

  it('reads Claude Code sessions from claude.ai/code, not the chats beside them', () => {
    const d = doc(`<nav>
      <a href="/new">New chat</a>
      <a href="/chat/${uuid(1)}">A chat</a>
      <a href="/code">Code</a>
      <a href="/code/new">New session</a>
      <a href="/code/session_011CUabcDEF">Fix the webhook retries</a>
      <a href="https://claude.ai/code/session_022XYZghi">Add rate limits</a>
      <a href="/code/session_011CUabcDEF">Fix the webhook retries again</a>
    </nav>`);
    const items = readSidebarConversations(d, 'https://claude.ai/code', 'claude_code');
    expect(items.map((i) => [i.id, i.title, i.url])).toEqual([
      ['session_011CUabcDEF', 'Fix the webhook retries', 'https://claude.ai/code/session_011CUabcDEF'],
      ['session_022XYZghi', 'Add rate limits', 'https://claude.ai/code/session_022XYZghi'],
    ]);
  });

  it('reads Codex tasks from chatgpt.com/codex, including a second signed-in profile\'s /u/1 links', () => {
    const d = doc(`<main>
      <a href="/c/${uuid(2)}">A ChatGPT chat</a>
      <a href="/codex/settings">Settings</a>
      <a href="/codex/tasks/task_e_6801abc">Refactor billing</a>
      <a href="/u/1/codex/tasks/task_e_6802def">Bump deps</a>
    </main>`);
    const items = readSidebarConversations(d, 'https://chatgpt.com/codex', 'codex');
    expect(items.map((i) => i.id)).toEqual(['task_e_6801abc', 'task_e_6802def']);
  });

  it('are import sites that read the whole list in their own list tab, with no path guessed for them', async () => {
    for (const id of ['claude_code', 'codex'] as const) {
      expect(syncProviderInfo(id)).toMatchObject({ strategy: 'sidebar', allHistory: true, ownListTab: true });
    }
    expect(syncProviderInfo('claude_code')?.homeUrl).toBe('https://claude.ai/code');
    expect(syncProviderInfo('codex')?.homeUrl).toBe('https://chatgpt.com/codex');
    expect(SYNC_PROVIDERS.filter((p) => p.allHistory).map((p) => p.id)).toEqual(['chatgpt', 'claude', 'claude_code', 'codex']);

    const sessions = [1, 2].map((n) => ({ id: `session_0${n}abcdef`, url: `https://claude.ai/code/session_0${n}abcdef`, title: `S${n}` }));
    const f = fake({ tabs: { claude_code: 9 }, sidebar: { claude_code: sessions }, tabInfo: () => ({ url: 'https://claude.ai/code', title: 'Claude Code' }) });
    const orch = new HistorySyncOrchestrator(f.env);
    f.hooks.onSend = (tabId, m) => {
      if (m.type === 'TK_CAPTURE_NOW') {
        const s = sessions.find((x) => f.opened.at(-1) === x.url);
        if (s) setTimeout(() => orch.noteCapture(tabId, s.id, 12), 0);
      }
      return undefined;
    };
    await orch.start({ providers: ['claude_code', 'gemini'], days: 30, scope: 'all' });
    await orch.idle();
    // All history keeps the coding sites and drops the recent-only ones.
    expect(orch.state.providers.map((p) => p.provider)).toEqual(['claude_code']);
    // Its own list tab, not the person's claude.ai tab 9; the whole list; then each session.
    expect(f.opened).toEqual(['https://claude.ai/code', ...sessions.map((s) => s.url)]);
    expect(f.sent.find((s) => s.message.type === 'TK_HISTORY_LIST_SIDEBAR')?.message).toMatchObject({ provider: 'claude_code', limit: 300, maxScrolls: 75 });
    expect(statusOf(orch, 'claude_code')).toMatchObject({ status: 'done', listed: 2, stored: 2 });
  });
});

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

describe('import attribution with several accounts of one site', () => {
  const work: SyncAccount = { accountId: 'acct_work', workspaceId: 'personal', label: 'Work' };
  const home: SyncAccount = { accountId: 'acct_home', workspaceId: 'personal', label: 'Home' };
  const signedIn: SyncIdentityReply = { status: 'signed_in', identity: { key: 'chatgpt:abc', display: 'me@example.com', detail: null, source: 'network' } };

  it('reports who the site says is signed in before settling the account, and files every thread under it', async () => {
    const f = fake({ enabled: ['chatgpt'], tabs: { chatgpt: 7 }, identity: signedIn, accounts: [work] });
    const orch = new HistorySyncOrchestrator(f.env);
    answerRuns(f, orch, 'chatgpt', 2);
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    expect(f.calls.slice(0, 3)).toEqual(['hold sync_test_0001', 'identity chatgpt:abc', 'resolve']);
    expect(f.stored.map((s) => s.account)).toEqual([work, work]);
    expect(statusOf(orch, 'chatgpt')).toMatchObject({ account: 'Work', stored: 2 });
  });

  it('stops a site whose sign-in changes during the run instead of mixing two accounts', async () => {
    const f = fake({ enabled: ['chatgpt'], tabs: { chatgpt: 7 }, identity: signedIn, accounts: [work, home] });
    const orch = new HistorySyncOrchestrator(f.env);
    f.hooks.onSend = (tabId, m) => {
      if (m.type !== 'TK_HISTORY_SYNC_RUN') return undefined;
      const base = { runId: m.runId as string, provider: 'chatgpt' as const };
      void (async () => {
        await orch.handleEvent({ kind: 'conversation', ...base, conversation: conv(1) }, tabId);
        f.switchAccount(); // another tab switched the browser to Home
        await orch.handleEvent({ kind: 'conversation', ...base, conversation: conv(2) }, tabId);
      })();
      return { ok: true };
    };
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    expect(f.stored.map((s) => s.conv.title)).toEqual(['Chat 1']);
    expect(statusOf(orch, 'chatgpt')).toMatchObject({ status: 'error', message: describeSyncError('account_changed', 'ChatGPT') });
    expect(f.sent.some((s) => s.message.type === 'TK_HISTORY_SYNC_CANCEL')).toBe(true);
  });

  it('a signed-out session is reported as such before anything is listed', async () => {
    const f = fake({ enabled: ['codex'], identity: { status: 'signed_out' }, accounts: [work], tabInfo: () => ({ url: 'https://chatgpt.com/codex', title: 'Codex' }) });
    const orch = new HistorySyncOrchestrator(f.env);
    await orch.start({ providers: ['codex'], days: 30 });
    await orch.idle();
    expect(statusOf(orch, 'codex').message).toMatch(/Sign in to Codex/);
    expect(f.sent.some((s) => s.message.type === 'TK_HISTORY_LIST_SIDEBAR')).toBe(false);
  });

  it('a second account\'s run adds its own threads and leaves the first account\'s untouched', async () => {
    const db = new ThreadkeeperDB('online-import-two-accounts');
    try {
      const first = await upsertThread(db, syncedThreadInput(conv(1), work, new Date(NOW).toISOString()));
      const second = await upsertThread(db, syncedThreadInput({ ...conv(1), title: 'Same id, other person', messages: [{ sourceMessageId: 'x', role: 'user', content: 'Other', createdAt: null, branchPath: 'main' }] }, home, new Date(NOW).toISOString()));
      expect(first.status).toBe('stored');
      expect(second.status).toBe('stored');
      const rows = await db.conversations.where('sourceConversationId').equals(uuid(1)).toArray();
      expect(rows.map((r) => [r.accountId, r.title]).sort()).toEqual([
        ['acct_home', 'Same id, other person'],
        ['acct_work', 'Chat 1'],
      ]);
      // Resuming under the second account does not treat the first account's copy as already imported.
      await db.conversations.update(rows.find((r) => r.accountId === 'acct_work')!.threadKey, { updatedAt: '2026-11-11T00:00:00.000Z' });
      await db.conversations.update(rows.find((r) => r.accountId === 'acct_home')!.threadKey, { coverage: 'partial' });
      const env = createChromeSyncEnv(db, { loadSettings: async () => DEFAULT_SETTINGS, storeConversation: async () => 'stored' });
      expect(await env.knownUpdatedAt('chatgpt', work)).toEqual({ [uuid(1)]: '2026-11-11T00:00:00.000Z' });
      expect(await env.knownUpdatedAt('chatgpt', home)).toEqual({});
    } finally {
      await db.delete();
    }
  });

  it('reads who is signed in from the site\'s own identity request, strictly', async () => {
    const answer = (body: unknown, status = 200) => (async () => new Response(JSON.stringify(body), { status })) as typeof fetch;
    const chatgpt = { site: 'chatgpt' as const, origin: 'https://chatgpt.com' };
    const claude = { site: 'claude' as const, origin: 'https://claude.ai' };
    expect(await readSignedInIdentity({ ...chatgpt, fetchImpl: answer({ user: { id: 'user-1', email: 'a@b.co' }, accessToken: 't' }) }))
      .toMatchObject({ status: 'signed_in', identity: { key: expect.stringMatching(/^chatgpt:/), display: 'a@b.co' } });
    expect(await readSignedInIdentity({ ...chatgpt, fetchImpl: answer({}) })).toEqual({ status: 'signed_out' });
    expect(await readSignedInIdentity({ ...claude, fetchImpl: answer({ error: 'x' }, 401) })).toEqual({ status: 'signed_out' });
    expect(await readSignedInIdentity({ ...claude, fetchImpl: answer({ uuid: 'u-1', email_address: 'c@d.co' }) }))
      .toMatchObject({ status: 'signed_in', identity: { key: expect.stringMatching(/^claude:/) } });
    // An organization (no email) is not a person; a timeout is unknown, never a guess.
    expect(await readSignedInIdentity({ ...claude, fetchImpl: answer({ uuid: 'org-1', name: 'Org' }) })).toEqual({ status: 'unknown' });
    expect(await readSignedInIdentity({ ...claude, requestTimeoutMs: 10, fetchImpl: (() => never<Response>()) as typeof fetch })).toEqual({ status: 'unknown' });
  });
});

// ---------------------------------------------------------------------------
// Analysis waits for the import
// ---------------------------------------------------------------------------

describe('hosted analysis waits for the online import', () => {
  async function withJob(name: string, fn: (db: ThreadkeeperDB) => Promise<void>) {
    const db = new ThreadkeeperDB(name);
    try {
      await fn(db);
    } finally {
      await db.delete();
    }
  }

  it('leases no job while a run holds analysis, and starts the run\'s jobs once it ends', async () => {
    await withJob('hold-basic', async (db) => {
      await holdAnalysis(db, 'sync_a', Date.now());
      // Imported during the run, with the usual debounce.
      await enqueueAnalysis(db, { threadKey: 'chatgpt|t1', sourceRevision: 1 }, 0);
      await enqueueAnalysis(db, { threadKey: 'chatgpt|t2', sourceRevision: 1 }, 600);
      const held = await runAnalysisJobs(db, { maxJobs: 5 });
      expect(held).toMatchObject({ processed: 0, stoppedReason: ANALYSIS_HELD_REASON });
      expect((await db.jobs.get(analyzeJobId('chatgpt|t1')))?.status).toBe('pending');
      expect(await nextDueAnalysisAt(db)).toBeNull();

      expect(await releaseAnalysisHold(db, 'sync_a', Date.now())).toBe(2);
      expect(await db.kv.get(ANALYSIS_HOLD_KEY)).toBeUndefined();
      // Both are due now, including the one that was debounced.
      expect(await nextDueAnalysisAt(db)).toBeLessThanOrEqual(Date.now());
      const after = await runAnalysisJobs(db, { maxJobs: 5 });
      expect(after.processed).toBe(2);
      // Once: nothing is left to start again.
      expect((await runAnalysisJobs(db, { maxJobs: 5 })).processed).toBe(0);
    });
  });

  it('a hold that is not renewed stops counting, and only its own run can end it', async () => {
    await withJob('hold-stale', async (db) => {
      await holdAnalysis(db, 'sync_b', NOW);
      expect(await activeAnalysisHold(db, NOW + 1000)).toMatchObject({ runId: 'sync_b' });
      await touchAnalysisHold(db, 'sync_b', NOW + HOLD_STALE_MS - 1000);
      expect(await activeAnalysisHold(db, NOW + HOLD_STALE_MS + 1000)).not.toBeNull();
      expect(await activeAnalysisHold(db, NOW + 2 * HOLD_STALE_MS)).toBeNull();
      expect(await releaseAnalysisHold(db, 'other_run', NOW)).toBe(0);
      expect(await db.kv.get(ANALYSIS_HOLD_KEY)).toBeDefined();
    });
  });

  it('a worker that restarts with a dead run releases the queue and starts analysis', async () => {
    await withJob('hold-restart', async (db) => {
      const store: Record<string, unknown> = {};
      vi.stubGlobal('chrome', {
        storage: {
          local: {
            get: async (key: string) => ({ [key]: store[key] }),
            set: async (items: Record<string, unknown>) => void Object.assign(store, items),
          },
        },
      });
      const started = Date.now();
      await holdAnalysis(db, 'sync_dead_1', started);
      await enqueueAnalysis(db, { threadKey: 'claude|t9', sourceRevision: 1 }, 600);
      store[HISTORY_SYNC_STATE_KEY] = {
        runId: 'sync_dead_1', running: true, days: 30, scope: 'all', startedAt: new Date(started).toISOString(), finishedAt: null,
        providers: [{ provider: 'claude', label: 'Claude', strategy: 'api', status: 'fetching', listed: 10, stored: 1, skipped: 0, failed: 0, message: null }],
      } satisfies SyncState;

      // Before the new worker looks, nothing may start early.
      expect((await runAnalysisJobs(db, { maxJobs: 5 })).processed).toBe(0);

      const kick = vi.fn();
      const orch = new HistorySyncOrchestrator(createChromeSyncEnv(db, { loadSettings: async () => DEFAULT_SETTINGS, storeConversation: async () => 'stored', kickAnalysis: kick }));
      const state = await orch.recover();
      expect(state).toMatchObject({ running: false, interrupted: true, analysis: { queued: 1 } });
      expect(kick).toHaveBeenCalledTimes(1);
      expect(await db.kv.get(ANALYSIS_HOLD_KEY)).toBeUndefined();
      expect((store[HISTORY_SYNC_STATE_KEY] as SyncState).running).toBe(false);
      expect((await runAnalysisJobs(db, { maxJobs: 5 })).processed).toBe(1);
    });
  });

  it('a run holds analysis from its start and releases it once at the end, after reporting the import finished', async () => {
    const f = fake({ enabled: ['chatgpt'], tabs: { chatgpt: 7 } });
    const orch = new HistorySyncOrchestrator(f.env);
    answerRuns(f, orch, 'chatgpt', 1);
    await orch.start({ providers: ['chatgpt'], days: 30 });
    await orch.idle();
    expect(f.calls).toEqual(['hold sync_test_0001', 'release sync_test_0001']);
    const finishedAt = f.saved.findIndex((s) => !s.running);
    const analysedAt = f.saved.findIndex((s) => s.analysis);
    expect(finishedAt).toBeGreaterThan(-1);
    expect(analysedAt).toBeGreaterThan(finishedAt);
    expect(orch.state.analysis?.queued).toBe(3);
  });
});

vi.setConfig({ testTimeout: 15_000 });
void STEP_TIMEOUTS;
