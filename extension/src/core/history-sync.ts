import { PROVIDERS, type CaptureProviderId } from './providers.js';
import { validateSiteConversation, type SiteConversation } from './site-api.js';

/**
 * Catch up: pull the user's recent conversations from the AI sites they are already signed in to,
 * so history does not have to be exported by hand.
 *
 * Two ways, chosen per site:
 * - "api": ChatGPT and Claude. The page's own signed-in session lists recent conversations and
 *   loads each one as JSON (complete, with ids, times and model), paced and cancellable.
 * - "sidebar": every other site, and the coding-agent pages (Claude Code on claude.ai/code, Codex
 *   on chatgpt.com/codex), whose session lists are not read through any endpoint ThreadStack
 *   knows. The list's links are read and each conversation is opened in a background tab, where
 *   normal capture reads it (for coding sessions that includes the repository, pull request and
 *   run state the page shows). Slower, and only as good as the site's DOM.
 *
 * Nothing here runs unless the user starts it, and it only ever reads.
 */

export type SyncProviderId =
  | 'chatgpt'
  | 'claude'
  | 'claude_code'
  | 'codex'
  | 'grok'
  | 'gemini'
  | 'perplexity'
  | 'deepseek'
  | 'mistral'
  | 'copilot'
  | 'kimi'
  | 'ai_studio';

export interface SyncProviderInfo {
  id: SyncProviderId;
  label: string;
  strategy: 'api' | 'sidebar';
  /** Opened in a background tab when the user has no tab for the site. */
  homeUrl: string;
  hostPatterns: string[];
  /** What the user should expect, shown before they start. */
  note: string;
  /** Can read the whole history the account lists, not only the recent part. */
  allHistory: boolean;
  /**
   * The list lives on one page of a shared host (claude.ai/code, chatgpt.com/codex): the run
   * always opens that page in its own background tab instead of borrowing a tab of the host,
   * which may show something else and is the person's to scroll.
   */
  ownListTab?: boolean;
  /** Which signed-in session the site's own identity request reads (chatgpt.com or claude.ai). */
  identityHost?: 'chatgpt' | 'claude';
}

const patterns = (id: CaptureProviderId) => PROVIDERS[id].matchPatterns;

export const SYNC_PROVIDERS: SyncProviderInfo[] = [
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    strategy: 'api',
    homeUrl: 'https://chatgpt.com/',
    hostPatterns: patterns('chatgpt'),
    note: 'Complete history with dates, read through your signed-in session.',
    allHistory: true,
    identityHost: 'chatgpt',
  },
  {
    id: 'claude',
    label: 'Claude',
    strategy: 'api',
    homeUrl: 'https://claude.ai/new',
    hostPatterns: patterns('claude'),
    note: 'Complete history with dates, read through your signed-in session.',
    allHistory: true,
    identityHost: 'claude',
  },
  {
    id: 'claude_code',
    label: 'Claude Code',
    strategy: 'sidebar',
    homeUrl: 'https://claude.ai/code',
    hostPatterns: patterns('claude_code'),
    note: 'Opens each Claude Code session from your session list in a background tab, with its repository and pull request when the page shows them.',
    allHistory: true,
    ownListTab: true,
    identityHost: 'claude',
  },
  {
    id: 'codex',
    label: 'Codex',
    strategy: 'sidebar',
    homeUrl: 'https://chatgpt.com/codex',
    hostPatterns: patterns('codex'),
    note: 'Opens each Codex task from your task list in a background tab, with its repository and pull request when the page shows them.',
    allHistory: true,
    ownListTab: true,
    identityHost: 'chatgpt',
  },
  {
    id: 'gemini',
    label: 'Gemini',
    strategy: 'sidebar',
    homeUrl: 'https://gemini.google.com/app',
    hostPatterns: patterns('gemini'),
    note: 'Opens your most recent chats one by one. No dates, so it takes the newest ones.',
    allHistory: false,
  },
  {
    id: 'grok',
    label: 'Grok',
    strategy: 'sidebar',
    homeUrl: 'https://grok.com/',
    hostPatterns: patterns('grok'),
    note: 'Opens your most recent chats one by one. No dates, so it takes the newest ones.',
    allHistory: false,
  },
  {
    id: 'perplexity',
    label: 'Perplexity',
    strategy: 'sidebar',
    homeUrl: 'https://www.perplexity.ai/library',
    hostPatterns: patterns('perplexity'),
    note: 'Opens your most recent threads one by one. No dates, so it takes the newest ones.',
    allHistory: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    strategy: 'sidebar',
    homeUrl: 'https://chat.deepseek.com/',
    hostPatterns: patterns('deepseek'),
    note: 'Opens your most recent chats one by one. No dates, so it takes the newest ones.',
    allHistory: false,
  },
  {
    id: 'kimi',
    label: 'Kimi',
    strategy: 'sidebar',
    homeUrl: 'https://www.kimi.com/',
    hostPatterns: patterns('kimi'),
    note: 'Opens your most recent chats one by one. No dates, so it takes the newest ones.',
    allHistory: false,
  },
  {
    id: 'mistral',
    label: 'Le Chat',
    strategy: 'sidebar',
    homeUrl: 'https://chat.mistral.ai/chat',
    hostPatterns: patterns('mistral'),
    note: 'Opens your most recent chats one by one. No dates, so it takes the newest ones.',
    allHistory: false,
  },
  {
    id: 'copilot',
    label: 'Copilot',
    strategy: 'sidebar',
    homeUrl: 'https://copilot.microsoft.com/',
    hostPatterns: patterns('copilot'),
    note: 'Opens your most recent chats one by one. No dates, so it takes the newest ones.',
    allHistory: false,
  },
  {
    id: 'ai_studio',
    label: 'Google AI Studio',
    strategy: 'sidebar',
    homeUrl: 'https://aistudio.google.com/library',
    hostPatterns: patterns('ai_studio'),
    note: 'Opens your most recent saved chats one by one. No dates, so it takes the newest ones.',
    allHistory: false,
  },
];

export function syncProviderInfo(id: string): SyncProviderInfo | null {
  return SYNC_PROVIDERS.find((p) => p.id === id) ?? null;
}

export function isSyncProviderId(value: unknown): value is SyncProviderId {
  return typeof value === 'string' && SYNC_PROVIDERS.some((p) => p.id === value);
}

export const SYNC_DEFAULT_DAYS = 30;
export const SYNC_MAX_DAYS = 31;
/** Conversations read per site in one run. The sidebar way opens a tab for each, so it is lower. */
export const SYNC_MAX_API = 300;
export const SYNC_MAX_SIDEBAR = 30;
/** Coding sessions read in an all-history run: each one is a tab, so there is still a ceiling. */
export const SYNC_MAX_SIDEBAR_ALL = 300;

/** How many list entries a tab-by-tab run reads for this site and scope. */
export function sidebarLimit(info: SyncProviderInfo, scope: 'recent' | 'all'): number {
  return scope === 'all' && info.allHistory ? SYNC_MAX_SIDEBAR_ALL : SYNC_MAX_SIDEBAR;
}

export interface SyncRequest {
  providers: SyncProviderId[];
  days: number;
  scope?: 'recent' | 'all';
}

export function clampSyncDays(days: unknown): number {
  const n = typeof days === 'number' && Number.isFinite(days) ? Math.round(days) : SYNC_DEFAULT_DAYS;
  return Math.min(SYNC_MAX_DAYS, Math.max(1, n));
}

export function syncCutoffMs(days: number, now: number): number {
  return now - clampSyncDays(days) * 86_400_000;
}

// ---------------------------------------------------------------------------
// Events from the page to the service worker
// ---------------------------------------------------------------------------

export type SyncErrorCode = 'needs_login' | 'blocked' | 'rate_limited' | 'unsupported' | 'network' | 'no_conversations' | 'timeout';

/**
 * Failures the service worker finds itself (never reported by a page): each names what was being
 * waited for, so a stuck step says which one it was.
 */
export type SyncStepErrorCode =
  | 'no_access'
  | 'page_timeout'
  | 'no_reader'
  | 'tab_closed'
  | 'account_changed'
  | 'capture_failed'
  | 'step_timeout'
  | 'account_unverified'
  | 'interrupted';

export type SyncEvent =
  | { kind: 'phase'; runId: string; provider: SyncProviderId; phase: 'listing' | 'fetching'; total: number | null; message: string | null }
  | { kind: 'conversation'; runId: string; provider: SyncProviderId; conversation: SiteConversation }
  | { kind: 'skipped'; runId: string; provider: SyncProviderId; id: string; reason: 'up_to_date' | 'too_old' | 'empty' }
  | { kind: 'failed'; runId: string; provider: SyncProviderId; id: string; message: string }
  | { kind: 'done'; runId: string; provider: SyncProviderId; listed: number; message: string | null; truncated?: boolean }
  /** The page is still working (retrying, or waiting for a slow answer); it has nothing to report. */
  | { kind: 'heartbeat'; runId: string; provider: SyncProviderId }
  | { kind: 'error'; runId: string; provider: SyncProviderId; code: SyncErrorCode; message: string };

const ERROR_CODES = new Set<string>(['needs_login', 'blocked', 'rate_limited', 'unsupported', 'network', 'no_conversations', 'timeout']);

function rec(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const text = (v: unknown, max = 300): string | null => (typeof v === 'string' ? v.slice(0, max) : null);

/** Rebuild a sync event from untrusted input; null for anything that is not exactly one. */
export function validateSyncEvent(value: unknown): SyncEvent | null {
  const e = rec(value);
  if (!e) return null;
  const runId = text(e.runId, 64);
  if (!runId || !/^[A-Za-z0-9_-]{4,64}$/.test(runId) || !isSyncProviderId(e.provider)) return null;
  const provider = e.provider;
  switch (e.kind) {
    case 'phase':
      if (e.phase !== 'listing' && e.phase !== 'fetching') return null;
      return {
        kind: 'phase',
        runId,
        provider,
        phase: e.phase,
        total: typeof e.total === 'number' && Number.isFinite(e.total) ? Math.max(0, Math.round(e.total)) : null,
        message: text(e.message),
      };
    case 'conversation': {
      const conversation = validateSiteConversation(e.conversation);
      return conversation && conversation.provider === provider ? { kind: 'conversation', runId, provider, conversation } : null;
    }
    case 'skipped': {
      const id = text(e.id, 128);
      return id && (e.reason === 'up_to_date' || e.reason === 'too_old' || e.reason === 'empty')
        ? { kind: 'skipped', runId, provider, id, reason: e.reason }
        : null;
    }
    case 'failed': {
      const id = text(e.id, 128);
      return id ? { kind: 'failed', runId, provider, id, message: text(e.message) ?? 'Failed' } : null;
    }
    case 'done':
      return {
        kind: 'done',
        runId,
        provider,
        listed: typeof e.listed === 'number' && Number.isFinite(e.listed) ? Math.max(0, Math.round(e.listed)) : 0,
        message: text(e.message),
        ...(e.truncated === true ? { truncated: true } : {}),
      };
    case 'heartbeat':
      return { kind: 'heartbeat', runId, provider };
    case 'error':
      return typeof e.code === 'string' && ERROR_CODES.has(e.code)
        ? { kind: 'error', runId, provider, code: e.code as SyncErrorCode, message: text(e.message) ?? 'Failed' }
        : null;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// State shown in the UI
// ---------------------------------------------------------------------------

export type SyncProviderStatus = 'queued' | 'opening' | 'account' | 'listing' | 'fetching' | 'done' | 'error' | 'cancelled';

/** Statuses a run never leaves: anything else is still in progress. */
export function isFinishedStatus(status: SyncProviderStatus): boolean {
  return status === 'done' || status === 'error' || status === 'cancelled';
}

export interface SyncProviderState {
  provider: SyncProviderId;
  label: string;
  strategy: 'api' | 'sidebar';
  status: SyncProviderStatus;
  /** Conversations found in the window. */
  listed: number;
  /** Conversations newly stored or updated. */
  stored: number;
  /** Already up to date, empty or outside the window. */
  skipped: number;
  failed: number;
  message: string | null;
  /** The account this site's threads are filed under in this run (its label), when known. */
  account?: string | null;
  /** Read but holding no message ThreadStack could use; not stored, and never called up to date. */
  empty?: number;
  /** The site has more than this run read (a cap, or a list that did not finish loading). */
  truncated?: boolean;
  /** When the current step began (ISO), so a page can tell a slow step from a stuck one. */
  stepAt?: string | null;
}

/** Claude analysis of what the run brought in, which starts only once the run has ended. */
export interface SyncAnalysisState {
  /** Threads whose analysis was waiting for the run and was started when it ended. */
  queued: number;
  at: string;
}

export interface SyncState {
  runId: string | null;
  running: boolean;
  days: number;
  scope?: 'recent' | 'all';
  startedAt: string | null;
  finishedAt: string | null;
  providers: SyncProviderState[];
  /** Last time the worker running this saved it; a page uses it to notice a run nobody is driving. */
  heartbeatAt?: string | null;
  /** The worker stopped mid-run; the unfinished sites can be started again. */
  interrupted?: boolean;
  analysis?: SyncAnalysisState | null;
}

export const EMPTY_SYNC_STATE: SyncState = { runId: null, running: false, days: SYNC_DEFAULT_DAYS, startedAt: null, finishedAt: null, providers: [] };

export function initialSyncState(runId: string, req: SyncRequest, nowIso: string): SyncState {
  return {
    runId,
    running: true,
    days: clampSyncDays(req.days),
    scope: req.scope === 'all' ? 'all' : 'recent',
    startedAt: nowIso,
    finishedAt: null,
    providers: req.providers.flatMap((id) => {
      const info = syncProviderInfo(id);
      return info
        ? [{ provider: id, label: info.label, strategy: info.strategy, status: 'queued' as const, listed: 0, stored: 0, skipped: 0, failed: 0, message: null, account: null, stepAt: null }]
        : [];
    }),
  };
}

export function updateProvider(state: SyncState, provider: SyncProviderId, patch: Partial<SyncProviderState> | ((p: SyncProviderState) => Partial<SyncProviderState>)): SyncState {
  return {
    ...state,
    providers: state.providers.map((p) => (p.provider === provider ? { ...p, ...(typeof patch === 'function' ? patch(p) : patch) } : p)),
  };
}

/** Plain words for what each error means and what to do about it. */
export function describeSyncError(code: SyncErrorCode | SyncStepErrorCode, label: string): string {
  switch (code) {
    case 'no_access':
      return `ThreadStack is not allowed to read ${label}. Turn ${label} on under Settings, Capture, allow access when asked, and try again.`;
    case 'page_timeout':
      return `${label} did not finish loading in time. Check that ${label} opens in a normal tab, then try again.`;
    case 'no_reader':
      return `ThreadStack could not start reading the ${label} page. Reload any open ${label} tab and try again.`;
    case 'tab_closed':
      return `The ${label} tab was closed during the import. What was imported so far is kept.`;
    case 'account_changed':
      return `The ${label} account signed in changed during the import, so it stopped to keep each account's threads apart. Run the import again for the account now signed in.`;
    case 'capture_failed':
      return `${label} did not show the conversations ThreadStack opened. Check that you are signed in and that a conversation opens in a normal tab. What was imported so far is kept.`;
    case 'step_timeout':
      return `${label} stopped responding, so ThreadStack moved on. What was imported so far is kept.`;
    case 'account_unverified':
      return `ThreadStack could not confirm which ${label} account is signed in, so nothing more was imported from ${label}. Open ${label} in a tab, check you are signed in to the account you want, and try again.`;
    case 'interrupted':
      return `The browser stopped the extension during the import. What was imported is kept; continue the import to finish ${label}.`;
    case 'needs_login':
      return `Sign in to ${label} in this browser, then run Catch up again.`;
    case 'blocked':
      return `${label} blocked the request, often a check that needs a person. Open ${label} in a tab, complete any check, and try again.`;
    case 'rate_limited':
      return `${label} asked us to slow down. Wait a few minutes and run Catch up again; what was already imported is kept.`;
    case 'unsupported':
      return `${label} did not answer in the format ThreadStack reads. The site may have changed; use its data export instead.`;
    case 'network':
      return `Could not reach ${label}. Check your connection and try again.`;
    case 'no_conversations':
      return `No conversations found in ${label}'s sidebar. Sign in, open the site once, and try again.`;
    case 'timeout':
      return `${label} stopped answering. What was imported so far is kept.`;
  }
}

