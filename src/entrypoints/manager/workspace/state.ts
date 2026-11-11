// Workspace state: the open session tabs, the dashboard panes, and the plan that decides which
// embedded pages are loaded. Pure functions only, so the rules can be tested without a browser.
//
// One rule shapes everything here: a Chrome profile has one set of cookies per login realm, so
// only the tabs of the realm's signed-in account can be loaded. Tabs of another account of the
// same realm are shown paused until the person switches to that account.
import {
  detectProviderFromUrl,
  extractConversationIdFromUrl,
  providerCategory,
  type ProviderCategory,
  type ProviderId,
} from '../../../core/providers.js';
import { buildThreadKey, type ConversationRecord } from '../../../core/schema.js';
import { primaryAccountId, realmForProvider, type RealmInfo } from '../../../core/workspace/realms.js';
import {
  DASHBOARD_LAYOUTS,
  EMPTY_WORKSPACE_STATE,
  type AccountRecord,
  type ActiveAccounts,
  type DashboardLayout,
  type RealmAccounts,
  type SessionTab,
  type WorkspaceState,
} from '../../../core/workspace/types.js';

// ---------------------------------------------------------------------------------------------
// What can be embedded
// ---------------------------------------------------------------------------------------------

export interface EmbedTarget {
  url: string;
  provider: ProviderId;
  realm: RealmInfo;
}

/**
 * Whether an address can be shown as a session tab: an https page of a provider Threadkeeper
 * knows. Anything else (other sites, http, local files) opens in an ordinary Chrome tab.
 */
export function embedTargetFor(url: string): EmbedTarget | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null;
  const provider = detectProviderFromUrl(parsed.href);
  if (!provider) return null;
  const realm = realmForProvider(provider);
  return realm ? { url: parsed.href, provider, realm } : null;
}

/** The side-navigation group a provider's sessions belong to. */
export type SessionGroup = 'coding' | 'chats' | 'bots' | 'more';

export const SESSION_GROUP_LABELS: Record<SessionGroup, string> = {
  coding: 'Coding agents',
  chats: 'Chats',
  bots: 'Bots',
  more: 'More',
};

export const SESSION_GROUP_ORDER: readonly SessionGroup[] = ['coding', 'chats', 'bots', 'more'];

const GROUP_BY_CATEGORY: Record<ProviderCategory, SessionGroup> = {
  coding_agent: 'coding',
  chat: 'chats',
  agent: 'bots',
  companion: 'bots',
  builder: 'more',
  search: 'more',
};

export function sessionGroupOf(provider: ProviderId | string): SessionGroup {
  return GROUP_BY_CATEGORY[providerCategory(provider)];
}

// ---------------------------------------------------------------------------------------------
// Accounts as the workspace sees them
// ---------------------------------------------------------------------------------------------

export function findAccount(realms: readonly RealmAccounts[], accountId: string): AccountRecord | null {
  for (const r of realms) {
    const found = r.accounts.find((a) => a.id === accountId);
    if (found) return found;
  }
  return null;
}

export function activeAccountsOf(realms: readonly RealmAccounts[]): ActiveAccounts {
  const out: ActiveAccounts = {};
  for (const r of realms) if (r.activeAccountId) out[r.realm.id] = r.activeAccountId;
  return out;
}

/**
 * The workspace account a stored thread belongs to. Threads of the primary account carry the
 * id they were stored under before accounts existed (`legacyAccountId`, from
 * settings.boundAccounts); every other account's threads carry the account's own id.
 */
export function accountForThread(
  conv: Pick<ConversationRecord, 'provider' | 'accountId'>,
  realms: readonly RealmAccounts[],
  legacyAccountId: string | undefined
): { realm: RealmInfo; account: AccountRecord | null; accountId: string } | null {
  const realm = realmForProvider(conv.provider);
  if (!realm) return null;
  const entry = realms.find((r) => r.realm.id === realm.id);
  const own = entry?.accounts.find((a) => a.id === conv.accountId) ?? null;
  if (own) return { realm, account: own, accountId: own.id };
  const primary = entry?.accounts.find((a) => a.primary) ?? null;
  // An id that is neither an account nor the legacy id belongs to an account that was removed
  // (or to an import); it is shown under the primary account, which is the browser's own login.
  if (conv.accountId === legacyAccountId || !conv.accountId.startsWith('acct_')) {
    return { realm, account: primary, accountId: primary?.id ?? primaryAccountId(realm.id) };
  }
  return { realm, account: null, accountId: conv.accountId };
}

/** The thread-key account id for captures made under `account` (see threadAccountId). */
export function threadKeyForUrl(
  url: string,
  account: Pick<AccountRecord, 'id' | 'primary'> | null,
  bound: { accountId: string; workspaceId: string } | undefined
): string | null {
  const provider = detectProviderFromUrl(url);
  const conversationId = provider ? extractConversationIdFromUrl(url) : null;
  if (!provider || !conversationId || !bound) return null;
  const accountId = !account || account.primary ? bound.accountId : account.id;
  return buildThreadKey({
    provider,
    accountId,
    workspaceId: bound.workspaceId,
    sourceConversationId: conversationId,
    branchId: 'main',
  });
}

// ---------------------------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------------------------

export const THREAD_TAB_PREFIX = 'thread~';

export function threadTabId(threadKey: string): string {
  return `${THREAD_TAB_PREFIX}${threadKey}`;
}

export type WorkspaceAction =
  | { type: 'hydrate'; state: WorkspaceState }
  | {
      type: 'open';
      /** `tab_<hex>` for a tab opened by hand; threadTabId(key) to open (or re-focus) a library thread. */
      id: string;
      url: string;
      provider: ProviderId | null;
      realm: string;
      accountId: string;
      title: string;
      threadKey: string | null;
      now: number;
      /** Make it the Browse tab. Default true. */
      activate?: boolean;
    }
  | { type: 'close'; id: string }
  | { type: 'activate'; id: string; now: number }
  | { type: 'navigated'; id: string; url: string; title: string; threadKey?: string | null }
  | { type: 'move'; id: string; toIndex: number }
  | { type: 'retarget_account'; id: string; accountId: string }
  | { type: 'account_removed'; accountId: string; fallbackAccountId: string }
  | { type: 'dashboard_layout'; layout: DashboardLayout }
  | { type: 'dashboard_pane'; index: number; threadKey: string | null }
  | { type: 'dashboard_focus'; index: number }
  | { type: 'dashboard_unpin'; threadKey: string }
  | { type: 'toggle_group'; group: string };

const MAX_TABS = 40;

function clampPanes(panes: Array<string | null>, layout: DashboardLayout): Array<string | null> {
  const next = panes.slice(0, layout);
  while (next.length < layout) next.push(null);
  return next;
}

export function workspaceReducer(state: WorkspaceState, action: WorkspaceAction): WorkspaceState {
  switch (action.type) {
    case 'hydrate':
      return normalizeWorkspaceState(action.state);

    case 'open': {
      const existing = state.tabs.find((t) => t.id === action.id);
      const activate = action.activate !== false;
      if (existing) {
        const tabs = state.tabs.map((t) =>
          t.id === action.id
            ? {
                ...t,
                // A thread tab keeps the page the person navigated to; only a tab for another
                // account of the same thread is re-pointed.
                accountId: action.accountId,
                realm: action.realm,
                threadKey: action.threadKey ?? t.threadKey,
                lastActiveAt: action.now,
              }
            : t
        );
        return { ...state, tabs, activeTabId: activate ? action.id : state.activeTabId };
      }
      const tab: SessionTab = {
        id: action.id,
        provider: action.provider,
        realm: action.realm,
        accountId: action.accountId,
        url: action.url,
        title: action.title,
        threadKey: action.threadKey,
        createdAt: action.now,
        lastActiveAt: action.now,
      };
      let tabs = [...state.tabs, tab];
      if (tabs.length > MAX_TABS) {
        // Close the least recently used tab that is neither the new one nor shown in Browse.
        const victim = tabs
          .filter((t) => t.id !== tab.id && t.id !== state.activeTabId)
          .sort((a, b) => a.lastActiveAt - b.lastActiveAt)[0];
        if (victim) tabs = tabs.filter((t) => t.id !== victim.id);
      }
      return { ...state, tabs, activeTabId: activate ? tab.id : state.activeTabId };
    }

    case 'close': {
      const index = state.tabs.findIndex((t) => t.id === action.id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((t) => t.id !== action.id);
      let activeTabId = state.activeTabId;
      if (activeTabId === action.id) {
        // Like a browser: the neighbour to the right, else the one to the left.
        activeTabId = (tabs[index] ?? tabs[index - 1])?.id ?? null;
      }
      return { ...state, tabs, activeTabId };
    }

    case 'activate': {
      if (!state.tabs.some((t) => t.id === action.id)) return state;
      return {
        ...state,
        activeTabId: action.id,
        tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, lastActiveAt: action.now } : t)),
      };
    }

    case 'navigated': {
      let changed = false;
      const tabs = state.tabs.map((t) => {
        if (t.id !== action.id) return t;
        const threadKey = action.threadKey === undefined ? t.threadKey : action.threadKey;
        if (t.url === action.url && t.title === action.title && t.threadKey === threadKey) return t;
        changed = true;
        const target = embedTargetFor(action.url);
        return {
          ...t,
          url: action.url,
          title: action.title || t.title,
          threadKey,
          // Staying inside the realm, the page may move between its products (Claude to Claude Code).
          provider: target && target.realm.id === t.realm ? target.provider : t.provider,
        };
      });
      return changed ? { ...state, tabs } : state;
    }

    case 'move': {
      const from = state.tabs.findIndex((t) => t.id === action.id);
      if (from === -1) return state;
      const to = Math.max(0, Math.min(state.tabs.length - 1, action.toIndex));
      if (from === to) return state;
      const tabs = state.tabs.slice();
      const [tab] = tabs.splice(from, 1);
      tabs.splice(to, 0, tab);
      return { ...state, tabs };
    }

    case 'retarget_account':
      return {
        ...state,
        tabs: state.tabs.map((t) => (t.id === action.id ? { ...t, accountId: action.accountId } : t)),
      };

    case 'account_removed':
      return {
        ...state,
        tabs: state.tabs.map((t) =>
          t.accountId === action.accountId ? { ...t, accountId: action.fallbackAccountId } : t
        ),
      };

    case 'dashboard_layout':
      return {
        ...state,
        dashboard: {
          layout: action.layout,
          panes: clampPanes(state.dashboard.panes, action.layout),
          focusedPane: Math.min(state.dashboard.focusedPane, action.layout - 1),
        },
      };

    case 'dashboard_pane': {
      if (action.index < 0 || action.index >= state.dashboard.layout) return state;
      // A thread sits in one pane at a time: placing it again moves it.
      const panes = state.dashboard.panes.map((key, i) =>
        i === action.index ? action.threadKey : key !== null && key === action.threadKey ? null : key
      );
      return { ...state, dashboard: { ...state.dashboard, panes, focusedPane: action.index } };
    }

    case 'dashboard_focus':
      if (action.index < 0 || action.index >= state.dashboard.layout) return state;
      return { ...state, dashboard: { ...state.dashboard, focusedPane: action.index } };

    case 'dashboard_unpin':
      return {
        ...state,
        dashboard: {
          ...state.dashboard,
          panes: state.dashboard.panes.map((key) => (key === action.threadKey ? null : key)),
        },
      };

    case 'toggle_group': {
      const collapsed = state.collapsedGroups.includes(action.group);
      return {
        ...state,
        collapsedGroups: collapsed
          ? state.collapsedGroups.filter((g) => g !== action.group)
          : [...state.collapsedGroups, action.group],
      };
    }
  }
}

/** Make stored state safe to use: drop what is malformed, keep the invariants. */
export function normalizeWorkspaceState(raw: unknown): WorkspaceState {
  const base = (raw && typeof raw === 'object' ? raw : {}) as Partial<WorkspaceState>;
  const seen = new Set<string>();
  const tabs: SessionTab[] = [];
  for (const t of Array.isArray(base.tabs) ? base.tabs : []) {
    if (!t || typeof t.id !== 'string' || typeof t.url !== 'string' || typeof t.accountId !== 'string') continue;
    if (seen.has(t.id) || typeof t.realm !== 'string' || !embedTargetFor(t.url)) continue;
    seen.add(t.id);
    tabs.push({
      id: t.id,
      provider: t.provider ?? null,
      realm: t.realm,
      accountId: t.accountId,
      url: t.url,
      title: typeof t.title === 'string' ? t.title : '',
      threadKey: typeof t.threadKey === 'string' ? t.threadKey : null,
      createdAt: Number.isFinite(t.createdAt) ? t.createdAt : 0,
      lastActiveAt: Number.isFinite(t.lastActiveAt) ? t.lastActiveAt : 0,
    });
    if (tabs.length === MAX_TABS) break;
  }
  const layout = DASHBOARD_LAYOUTS.includes(base.dashboard?.layout as DashboardLayout)
    ? (base.dashboard!.layout as DashboardLayout)
    : EMPTY_WORKSPACE_STATE.dashboard.layout;
  const rawPanes = Array.isArray(base.dashboard?.panes) ? base.dashboard!.panes : [];
  const usedKeys = new Set<string>();
  const panes = clampPanes(
    rawPanes.map((key) => {
      if (typeof key !== 'string' || usedKeys.has(key)) return null;
      usedKeys.add(key);
      return key;
    }),
    layout
  );
  const focused = base.dashboard?.focusedPane;
  return {
    version: 1,
    tabs,
    activeTabId: typeof base.activeTabId === 'string' && seen.has(base.activeTabId) ? base.activeTabId : tabs[0]?.id ?? null,
    dashboard: {
      layout,
      panes,
      focusedPane: typeof focused === 'number' && focused >= 0 && focused < layout ? focused : 0,
    },
    collapsedGroups: Array.isArray(base.collapsedGroups)
      ? base.collapsedGroups.filter((g): g is string => typeof g === 'string').slice(0, 40)
      : [],
  };
}

// ---------------------------------------------------------------------------------------------
// Which embedded pages are loaded
// ---------------------------------------------------------------------------------------------

/**
 * Why a tab is not loaded right now.
 * - `account`: its realm is signed in as another account; switching accounts loads it.
 * - `isolated`: its account lives in its own Chrome window (Mac helper) and is never embedded.
 * - `asleep`: nothing is wrong; it was not shown yet this session, or was unloaded to keep the
 *   number of loaded pages within the limit. Showing it loads it.
 */
export type TabRest = 'account' | 'isolated' | 'asleep';

export interface FramePlan {
  /** Tabs whose page should be mounted, most recently used first. */
  live: string[];
  /** Every other tab, with the reason. */
  resting: Record<string, TabRest>;
}

export interface FramePlanInput {
  tabs: readonly SessionTab[];
  /** Tabs some view is showing right now, in priority order. */
  visible: readonly string[];
  /** Tabs whose page has been mounted this session (candidates to keep loaded in the background). */
  warmed: ReadonlySet<string>;
  realms: readonly RealmAccounts[];
  maxLive: number;
}

export function planFrames(input: FramePlanInput): FramePlan {
  const active = activeAccountsOf(input.realms);
  const resting: Record<string, TabRest> = {};
  const eligible: SessionTab[] = [];
  for (const tab of input.tabs) {
    const account = findAccount(input.realms, tab.accountId);
    if (account?.mode === 'isolated') {
      resting[tab.id] = 'isolated';
      continue;
    }
    const entry = input.realms.find((r) => r.realm.id === tab.realm);
    // A realm Threadkeeper does not switch has one login, the browser's: every tab can load.
    const signedIn = !entry || !entry.realm.switchable || !active[tab.realm] || active[tab.realm] === tab.accountId;
    if (!signedIn) {
      resting[tab.id] = 'account';
      continue;
    }
    eligible.push(tab);
  }
  const limit = Math.max(1, input.maxLive);
  const live: string[] = [];
  const take = (id: string) => {
    if (live.length < limit && !live.includes(id) && eligible.some((t) => t.id === id)) live.push(id);
  };
  // Shown tabs first, even beyond what was loaded before; then the most recently used warm ones.
  for (const id of input.visible) take(id);
  const background = eligible
    .filter((t) => input.warmed.has(t.id) && !live.includes(t.id))
    .sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  for (const t of background) take(t.id);
  for (const t of eligible) if (!live.includes(t.id)) resting[t.id] = 'asleep';
  return { live, resting };
}

/** A short name for a tab when the page has not reported a title yet. */
export function fallbackTabTitle(url: string, realmLabel: string): string {
  try {
    const u = new URL(url);
    const tail = u.pathname.replace(/\/+$/, '').split('/').pop();
    return tail && tail.length <= 40 ? `${realmLabel} · ${tail}` : realmLabel;
  } catch {
    return realmLabel;
  }
}
