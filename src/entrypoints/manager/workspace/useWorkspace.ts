// The workspace controller: open session tabs, accounts, and what each embedded page reports.
// One instance lives in the manager page (full-tab surface only). Views read it and call its
// actions; the frame stage mounts an iframe for every tab in `plan.live`.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ThreadkeeperDB } from '../../../core/db.js';
import type { ConversationRecord, SettingsRecord } from '../../../core/schema.js';
import { realmById } from '../../../core/workspace/realms.js';
import {
  EMBED_FRAME_NAME_PREFIX,
  EMPTY_WORKSPACE_STATE,
  KV_KEYS,
  isAgentState,
  type AccountColor,
  type AccountMode,
  type AccountRecord,
  type AccountsChangeResult,
  type AgentState,
  type RealmAccounts,
  type SessionTab,
  type WorkspaceBroadcast,
  type WorkspaceFailure,
  type WorkspaceState,
  type WorkspaceView,
} from '../../../core/workspace/types.js';
import { sendFrameCommand, workspaceApi } from './client.js';
import {
  accountForThread,
  embedTargetFor,
  fallbackTabTitle,
  findAccount,
  normalizeWorkspaceState,
  planFrames,
  threadKeyForUrl,
  threadTabId,
  workspaceReducer,
  type FramePlan,
  type WorkspaceAction,
} from './state.js';

/** What an embedded page has reported since it was mounted. Not persisted. */
export interface FrameRuntime {
  /** chrome frame id inside this tab; null until the page's content script said hello. */
  frameId: number | null;
  /** The page finished loading at least once. */
  loaded: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  agentState: AgentState | null;
  /** Bumped to force the iframe to load again from the tab's address. */
  reloads: number;
}

const EMPTY_RUNTIME: FrameRuntime = {
  frameId: null,
  loaded: false,
  canGoBack: false,
  canGoForward: false,
  agentState: null,
  reloads: 0,
};

export type OpenOutcome =
  | { ok: true; tabId: string }
  /** `external`: not a page Threadkeeper embeds; the caller may open it in a Chrome tab. */
  | { ok: false; reason: 'external' | 'no_account'; message: string };

export interface WorkspaceInput {
  db: ThreadkeeperDB;
  /** False on the side panel and the in-page overlay: nothing is embedded there. */
  enabled: boolean;
  view: WorkspaceView;
  settings: SettingsRecord | null;
  conversations: readonly ConversationRecord[];
  /** Thread shown live in the Threads detail pane, or null when it shows only the summary. */
  liveThreadKey: string | null;
}

export interface WorkspaceController {
  enabled: boolean;
  /** The first answer from the service worker arrived (or failed). */
  ready: boolean;
  /** This tab is registered and provider pages can load inside it. */
  embedding: boolean;
  /** Why the workspace could not start, in plain words. */
  error: string | null;
  tabId: number | null;
  realms: RealmAccounts[];
  state: WorkspaceState;
  plan: FramePlan;
  runtime: (tabId: string) => FrameRuntime;
  /** Realm whose accounts are being switched right now. */
  switchingRealm: string | null;
  dispatch: (action: WorkspaceAction) => void;
  /** Open an address as a session tab under the realm's signed-in account (or `accountId`). */
  openUrl: (url: string, options?: { accountId?: string; activate?: boolean; title?: string }) => OpenOutcome;
  /** Open a library thread as a session tab under the account it was captured with. */
  openThread: (conv: ConversationRecord, options?: { activate?: boolean }) => OpenOutcome;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  /** Sign the tab's realm in as the tab's account, so the tab can load. */
  switchAccount: (accountId: string) => Promise<AccountsChangeResult | WorkspaceFailure>;
  addAccount: (input: {
    realm: string;
    mode: AccountMode;
    label?: string;
    color?: AccountColor;
    profileId?: string;
  }) => Promise<AccountsChangeResult | WorkspaceFailure>;
  updateAccount: (accountId: string, patch: { label?: string; color?: AccountColor }) => Promise<AccountsChangeResult | WorkspaceFailure>;
  removeAccount: (accountId: string) => Promise<AccountsChangeResult | WorkspaceFailure>;
  refreshAccounts: () => Promise<void>;
  /** Open an address in an isolated account's own Chrome window (needs the Mac helper). */
  openIsolated: (accountId: string, url: string) => Promise<{ ok: true } | WorkspaceFailure>;
  back: (id: string) => void;
  forward: (id: string) => void;
  reload: (id: string) => void;
  /**
   * Send a tab to another address of the same sign-in. An address of another sign-in, or one
   * Threadkeeper cannot embed, is refused: open it as its own tab or in Chrome instead.
   */
  navigate: (id: string, url: string) => OpenOutcome;
  /** Called by the frame stage when an iframe's load event fires. */
  noteFrameLoaded: (id: string) => void;
  accountOf: (tab: SessionTab) => AccountRecord | null;
}

function newTabId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `tab_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/** The session tab an embedded frame belongs to, from the name its iframe was given. */
export function tabIdFromPane(pane: unknown): string | null {
  return typeof pane === 'string' && pane.startsWith(EMBED_FRAME_NAME_PREFIX)
    ? pane.slice(EMBED_FRAME_NAME_PREFIX.length)
    : typeof pane === 'string' && pane
      ? pane
      : null;
}

export function useWorkspace(input: WorkspaceInput): WorkspaceController {
  const { db, enabled, view, settings, conversations, liveThreadKey } = input;
  const [state, dispatch] = useReducer(workspaceReducer, EMPTY_WORKSPACE_STATE);
  const [realms, setRealms] = useState<RealmAccounts[]>([]);
  const [ready, setReady] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [switchingRealm, setSwitchingRealm] = useState<string | null>(null);
  const [runtimes, setRuntimes] = useState<Record<string, FrameRuntime>>({});
  // Tabs whose page has been mounted this session; they may stay loaded in the background.
  const [warmed, setWarmed] = useState<ReadonlySet<string>>(new Set());

  const hydrated = useRef(false);
  const alive = useRef(true);
  const stateRef = useRef(state);
  stateRef.current = state;
  const realmsRef = useRef(realms);
  realmsRef.current = realms;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const tabIdRef = useRef<number | null>(null);
  tabIdRef.current = tabId;
  const runtimesRef = useRef(runtimes);
  runtimesRef.current = runtimes;
  const threadKeys = useMemo(() => new Set(conversations.map((c) => c.threadKey)), [conversations]);
  const threadKeysRef = useRef(threadKeys);
  threadKeysRef.current = threadKeys;

  // ---- start: stored tabs first, then register with the service worker ----------------------
  useEffect(() => {
    alive.current = true;
    if (!enabled) return;
    void (async () => {
      try {
        const row = await db.kv.get(KV_KEYS.workspaceState);
        if (alive.current && row) dispatch({ type: 'hydrate', state: normalizeWorkspaceState(row.value) });
      } catch {
        // A missing or unreadable row only means the workspace starts empty.
      }
      hydrated.current = true;
      const hello = await workspaceApi.hello();
      if (!alive.current) return;
      if (hello.ok) {
        setRealms(hello.realms);
        setEmbedding(hello.embedding);
        setTabId(hello.tabId);
        setError(hello.embedding ? null : 'Threadkeeper could not prepare this tab for embedded pages. Reload the extension, then this page.');
      } else {
        setError(hello.error);
      }
      setReady(true);
    })();
    return () => {
      alive.current = false;
    };
  }, [db, enabled]);

  // ---- persist (the page is the only writer of this row) ------------------------------------
  useEffect(() => {
    if (!enabled || !hydrated.current) return;
    const timer = setTimeout(() => {
      void db.kv.put({ key: KV_KEYS.workspaceState, value: state, updatedAt: new Date().toISOString() }).catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [db, enabled, state]);

  const applyChange = useCallback((result: AccountsChangeResult | WorkspaceFailure) => {
    if (result.ok && alive.current) setRealms(result.realms);
    return result;
  }, []);

  const refreshAccounts = useCallback(async () => {
    const res = await workspaceApi.listAccounts();
    if (res.ok && alive.current) setRealms(res.realms);
  }, []);

  // ---- what the frames and the service worker tell this page --------------------------------
  useEffect(() => {
    if (!enabled || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const onMessage = (message: unknown, sender: chrome.runtime.MessageSender) => {
      const msg = message as { type?: string } & Record<string, unknown>;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'ACCOUNTS_CHANGED') {
        void refreshAccounts();
        return;
      }
      if (msg.type === 'EMBED_OPEN_REQUEST') {
        const req = msg as unknown as Extract<WorkspaceBroadcast, { type: 'EMBED_OPEN_REQUEST' }>;
        if (req.tabId === tabIdRef.current && typeof req.url === 'string') openUrlRef.current(req.url);
        return;
      }

      // Everything below comes from a content script inside one of this tab's frames.
      if (sender.id !== chrome.runtime.id || sender.tab?.id == null || sender.tab.id !== tabIdRef.current) return;
      const frameId = sender.frameId;
      if (typeof frameId !== 'number' || frameId === 0) return;
      if (msg.type !== 'EMBED_HELLO' && msg.type !== 'EMBED_NAV' && msg.type !== 'EMBED_AGENT_STATE') return;

      const fromName = tabIdFromPane(msg.pane);
      const known = Object.entries(runtimesRef.current).find(([, r]) => r.frameId === frameId)?.[0] ?? null;
      const id = fromName && stateRef.current.tabs.some((t) => t.id === fromName) ? fromName : known;
      if (!id) return;
      const tab = stateRef.current.tabs.find((t) => t.id === id);
      if (!tab) return;

      setRuntimes((prev) => {
        const current = prev[id] ?? EMPTY_RUNTIME;
        const next: FrameRuntime = { ...current, frameId, loaded: true };
        if (msg.type === 'EMBED_NAV') {
          next.canGoBack = msg.canGoBack === true;
          next.canGoForward = msg.canGoForward === true;
        }
        if (msg.type === 'EMBED_AGENT_STATE' && isAgentState(msg.state)) next.agentState = msg.state;
        return { ...prev, [id]: next };
      });

      if ((msg.type === 'EMBED_HELLO' || msg.type === 'EMBED_NAV') && typeof msg.url === 'string') {
        // Trust the address chrome reports for the frame over the one in the message.
        const url = sender.url && /^https:/.test(sender.url) && msg.type === 'EMBED_HELLO' ? sender.url : msg.url;
        if (!embedTargetFor(url)) return; // a sign-in or other host: keep the last session address
        const account = findAccount(realmsRef.current, tab.accountId);
        const target = embedTargetFor(url);
        const bound = target ? settingsRef.current?.boundAccounts[target.provider] : undefined;
        const key = threadKeyForUrl(url, account, bound);
        dispatch({
          type: 'navigated',
          id,
          url,
          title: typeof msg.title === 'string' ? msg.title.slice(0, 300) : '',
          // A hand-opened tab follows the page; a thread tab stays bound to its thread.
          threadKey: tab.id.startsWith('thread~') ? undefined : key && threadKeysRef.current.has(key) ? key : null,
        });
      }
    };
    chrome.runtime.onMessage.addListener(onMessage);
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, [enabled, refreshAccounts]);

  // ---- which pages are mounted ---------------------------------------------------------------
  const visible = useMemo(() => {
    if (!enabled) return [];
    if (view === 'browse') return state.activeTabId ? [state.activeTabId] : [];
    if (view === 'threads') return liveThreadKey ? [threadTabId(liveThreadKey)] : [];
    const panes = state.dashboard.panes.filter((k): k is string => typeof k === 'string').map(threadTabId);
    // The focused pane first, so it is the last to be unloaded when the limit is small.
    const focused = state.dashboard.panes[state.dashboard.focusedPane];
    return focused ? [threadTabId(focused), ...panes.filter((id) => id !== threadTabId(focused))] : panes;
  }, [enabled, view, state.activeTabId, state.dashboard, liveThreadKey]);

  const plan = useMemo(
    () =>
      planFrames({
        tabs: enabled && embedding ? state.tabs : [],
        visible,
        warmed,
        realms,
        maxLive: settings?.maxLiveFrames ?? 6,
      }),
    [enabled, embedding, state.tabs, visible, warmed, realms, settings?.maxLiveFrames]
  );

  useEffect(() => {
    // Remember what has been mounted, and forget closed tabs.
    const open = new Set(state.tabs.map((t) => t.id));
    setWarmed((prev) => {
      const next = new Set([...prev].filter((id) => open.has(id)));
      for (const id of plan.live) next.add(id);
      return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
    });
    setRuntimes((prev) => {
      const live = new Set(plan.live);
      let changed = false;
      const next: Record<string, FrameRuntime> = {};
      for (const [id, r] of Object.entries(prev)) {
        if (!open.has(id)) {
          changed = true;
          continue;
        }
        // An unmounted page has no frame any more; keep only what still describes the tab.
        if (!live.has(id) && (r.frameId !== null || r.loaded)) {
          next[id] = { ...r, frameId: null, loaded: false, canGoBack: false, canGoForward: false };
          changed = true;
        } else next[id] = r;
      }
      return changed ? next : prev;
    });
  }, [plan.live, state.tabs]);

  // ---- actions --------------------------------------------------------------------------------
  const openUrl = useCallback<WorkspaceController['openUrl']>((url, options) => {
    const target = embedTargetFor(url);
    if (!target) return { ok: false, reason: 'external', message: 'This address opens in a Chrome tab.' };
    const entry = realmsRef.current.find((r) => r.realm.id === target.realm.id);
    const accountId =
      options?.accountId ?? entry?.activeAccountId ?? entry?.accounts.find((a) => a.primary)?.id ?? `primary~${target.realm.id}`;
    const account = findAccount(realmsRef.current, accountId);
    const bound = settingsRef.current?.boundAccounts[target.provider];
    const key = threadKeyForUrl(target.url, account, bound);
    const id = newTabId();
    dispatch({
      type: 'open',
      id,
      url: target.url,
      provider: target.provider,
      realm: target.realm.id,
      accountId,
      title: options?.title ?? fallbackTabTitle(target.url, target.realm.label),
      threadKey: key && threadKeysRef.current.has(key) ? key : null,
      now: Date.now(),
      activate: options?.activate,
    });
    return { ok: true, tabId: id };
  }, []);
  const openUrlRef = useRef(openUrl);
  openUrlRef.current = openUrl;

  const openThread = useCallback<WorkspaceController['openThread']>((conv, options) => {
    const target = embedTargetFor(conv.canonicalUrl);
    if (!target) {
      return { ok: false, reason: 'external', message: 'This thread has no web page Threadkeeper can show here.' };
    }
    const legacy = settingsRef.current?.boundAccounts[conv.provider]?.accountId;
    const owner = accountForThread(conv, realmsRef.current, legacy);
    if (!owner) return { ok: false, reason: 'no_account', message: 'This thread has no account to open it with.' };
    const id = threadTabId(conv.threadKey);
    dispatch({
      type: 'open',
      id,
      url: target.url,
      provider: target.provider,
      realm: target.realm.id,
      accountId: owner.accountId,
      title: conv.manualTitleOverride || conv.title || fallbackTabTitle(target.url, target.realm.label),
      threadKey: conv.threadKey,
      now: Date.now(),
      activate: options?.activate,
    });
    return { ok: true, tabId: id };
  }, []);

  const closeTab = useCallback((id: string) => dispatch({ type: 'close', id }), []);
  const activateTab = useCallback((id: string) => dispatch({ type: 'activate', id, now: Date.now() }), []);

  const switchAccount = useCallback<WorkspaceController['switchAccount']>(
    async (accountId) => {
      const account = findAccount(realmsRef.current, accountId);
      if (account) setSwitchingRealm(account.realm);
      try {
        return applyChange(await workspaceApi.activateAccount(accountId));
      } finally {
        if (alive.current) setSwitchingRealm(null);
      }
    },
    [applyChange]
  );

  const addAccount = useCallback<WorkspaceController['addAccount']>(
    async (details) => {
      setSwitchingRealm(details.realm);
      try {
        return applyChange(await workspaceApi.addAccount(details));
      } finally {
        if (alive.current) setSwitchingRealm(null);
      }
    },
    [applyChange]
  );

  const updateAccount = useCallback<WorkspaceController['updateAccount']>(
    async (accountId, patch) => applyChange(await workspaceApi.updateAccount(accountId, patch)),
    [applyChange]
  );

  const removeAccount = useCallback<WorkspaceController['removeAccount']>(
    async (accountId) => {
      const account = findAccount(realmsRef.current, accountId);
      const result = applyChange(await workspaceApi.removeAccount(accountId));
      if (result.ok && account) {
        const fallback = result.realms.find((r) => r.realm.id === account.realm)?.accounts.find((a) => a.primary);
        if (fallback) dispatch({ type: 'account_removed', accountId, fallbackAccountId: fallback.id });
      }
      return result;
    },
    [applyChange]
  );

  const frameCommand = useCallback((id: string, command: 'back' | 'forward') => {
    const frameId = runtimesRef.current[id]?.frameId;
    const tab = tabIdRef.current;
    if (frameId == null || tab == null) return;
    void sendFrameCommand(tab, frameId, { type: 'TK_EMBED_COMMAND', command });
  }, []);

  const reload = useCallback((id: string) => {
    // Remount from the tab's address: this also recovers a page that never loaded, which a
    // message to its content script could not.
    setRuntimes((prev) => {
      const current = prev[id] ?? EMPTY_RUNTIME;
      return { ...prev, [id]: { ...EMPTY_RUNTIME, agentState: current.agentState, reloads: current.reloads + 1 } };
    });
  }, []);

  const navigate = useCallback<WorkspaceController['navigate']>((id, url) => {
    const tab = stateRef.current.tabs.find((t) => t.id === id);
    const target = embedTargetFor(url);
    if (!tab || !target) return { ok: false, reason: 'external', message: 'This address opens in a Chrome tab.' };
    if (target.realm.id !== tab.realm) {
      return { ok: false, reason: 'external', message: `That is a ${target.realm.label} page. Open it as its own tab.` };
    }
    const frameId = runtimesRef.current[id]?.frameId;
    const hostTab = tabIdRef.current;
    if (frameId != null && hostTab != null) {
      // The page navigates itself, which keeps its history; it then reports the new address.
      void sendFrameCommand(hostTab, frameId, { type: 'TK_EMBED_COMMAND', command: 'navigate', url: target.url });
    } else {
      // Not loaded (asleep, paused or blocked): point the tab there and load it afresh.
      dispatch({ type: 'navigated', id, url: target.url, title: '' });
      setRuntimes((prev) => {
        const current = prev[id] ?? EMPTY_RUNTIME;
        return { ...prev, [id]: { ...EMPTY_RUNTIME, agentState: current.agentState, reloads: current.reloads + 1 } };
      });
    }
    return { ok: true, tabId: id };
  }, []);

  const noteFrameLoaded = useCallback((id: string) => {
    setRuntimes((prev) => {
      const current = prev[id] ?? EMPTY_RUNTIME;
      return current.loaded ? prev : { ...prev, [id]: { ...current, loaded: true } };
    });
  }, []);

  const runtime = useCallback((id: string) => runtimes[id] ?? EMPTY_RUNTIME, [runtimes]);
  const accountOf = useCallback((tab: SessionTab) => findAccount(realms, tab.accountId), [realms]);

  return {
    enabled,
    ready,
    embedding,
    error,
    tabId,
    realms,
    state,
    plan,
    runtime,
    switchingRealm,
    dispatch,
    openUrl,
    openThread,
    closeTab,
    activateTab,
    switchAccount,
    addAccount,
    updateAccount,
    removeAccount,
    refreshAccounts,
    openIsolated: (accountId, url) => workspaceApi.helperOpen(accountId, url),
    back: (id) => frameCommand(id, 'back'),
    forward: (id) => frameCommand(id, 'forward'),
    reload,
    navigate,
    noteFrameLoaded,
    accountOf,
  };
}

/** Sandbox for embedded pages: everything a web app needs except navigating this page away. */
export const EMBED_SANDBOX =
  'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals';

/** Features embedded pages may use, as they could in their own tab. */
export const EMBED_ALLOW =
  'clipboard-read; clipboard-write; microphone; camera; display-capture; fullscreen; publickey-credentials-get; autoplay';

/** Label for the realm a tab belongs to, for titles and accessible names. */
export function realmLabel(realmId: string): string {
  return realmById(realmId)?.label ?? 'Site';
}
