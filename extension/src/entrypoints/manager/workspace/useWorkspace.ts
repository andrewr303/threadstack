// The workspace controller: open session tabs, accounts, and what each embedded page reports.
// One instance lives in the manager page (full-tab surface only). Views read it and call its
// actions; the frame stage mounts an iframe for every tab in `plan.live`.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import type { ThreadStackDB } from '../../../core/db.js';
import type { ConversationRecord, SettingsRecord } from '../../../core/schema.js';
import { parsePaneName } from '../../../core/embed/frame.js';
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
import { createAdoptionGate, isEmbedGestureMessage } from './adoption.js';
import { loadSeed, reloadWorkspacePage, sendFrameCommand, startWorkspacePort, workspaceApi } from './client.js';
import { LAUNCH_PROVIDERS } from './launch.js';
import {
  accountForThread,
  browseVisibleTabs,
  embedTargetFor,
  fallbackTabTitle,
  findAccount,
  normalizeWorkspaceState,
  planFrames,
  slotOfTab,
  threadKeyForUrl,
  threadTabId,
  wantedProfiles,
  workspaceReducer,
  workspaceShape,
  type FramePlan,
  type ProfileSlotMap,
  type TabSlot,
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
  /** `external`: not a page ThreadStack embeds; the caller may open it in a Chrome tab. */
  | { ok: false; reason: 'external' | 'no_account'; message: string };

export interface WorkspaceInput {
  db: ThreadStackDB;
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
  /** Realm whose accounts are being changed right now (a sign-in starting or ending, a switch). */
  busyRealm: string | null;
  /** What this page's profile slots hold, by realm. Empty again after every page load. */
  slots: ProfileSlotMap;
  /**
   * False when the worker cannot see the cookies profile pages are given (an old manifest): a
   * profile then works until the page reloads, but its sign-in is not saved.
   */
  profilesSaved: boolean;
  /** Where a tab's page loads: an ordinary frame or the profile slot. */
  slotOf: (tab: SessionTab) => TabSlot;
  dispatch: (action: WorkspaceAction) => void;
  /** Open an address as a session tab under the realm's signed-in account (or `accountId`). */
  openUrl: (url: string, options?: { accountId?: string; activate?: boolean; title?: string }) => OpenOutcome;
  /**
   * Land on the start page: the most recently used tab of that product when one is open, else a
   * new tab on it.
   */
  openStartPage: (url: string) => OpenOutcome;
  /** Open a library thread as a session tab under the account it was captured with. */
  openThread: (conv: ConversationRecord, options?: { activate?: boolean }) => OpenOutcome;
  closeTab: (id: string) => void;
  activateTab: (id: string) => void;
  /**
   * Go to an account: its most recently used tab of the realm, or a new tab on the realm's
   * start page when it has none. Nothing is signed out anywhere.
   */
  goToAccount: (accountId: string) => OpenOutcome;
  /**
   * Load a profile account into this page's slot of its realm now. For an account without a
   * saved sign-in this is "sign in here": its pages open on the site's own sign-in page.
   */
  showProfile: (accountId: string, move?: boolean) => Promise<void>;
  /** Reload the page so that `tabId`'s account takes its realm's slot from the account holding it. */
  switchProfile: (tabId: string) => Promise<void>;
  /** Make an account the browser's own sign-in for its realm. Changes every tab of the realm. */
  useAsBrowserAccount: (accountId: string) => Promise<AccountsChangeResult | WorkspaceFailure>;
  /** Sign a profile account in through an ordinary browser tab (for sign-ins a frame cannot finish). */
  beginBrowserSignIn: (accountId: string) => Promise<AccountsChangeResult | WorkspaceFailure>;
  finishBrowserSignIn: (attemptId: string) => Promise<AccountsChangeResult | WorkspaceFailure>;
  cancelBrowserSignIn: (attemptId: string) => Promise<AccountsChangeResult | WorkspaceFailure>;
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
  back: (id: string) => void;
  forward: (id: string) => void;
  reload: (id: string) => void;
  /**
   * Send a tab to another address of the same sign-in. An address of another sign-in, or one
   * ThreadStack cannot embed, is refused: open it as its own tab or in Chrome instead.
   */
  navigate: (id: string, url: string) => OpenOutcome;
  /** Called by the frame stage when an iframe's load event fires. */
  noteFrameLoaded: (id: string) => void;
  /** A specific native frame was detached; its last observation is no longer live. */
  noteFrameGone?: (frameId: number) => void;
  accountOf: (tab: SessionTab) => AccountRecord | null;
}

function newTabId(): string {
  const bytes = new Uint8Array(6);
  crypto.getRandomValues(bytes);
  return `tab_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * The session tab an embedded frame belongs to: the frame's whole name as the workspace gave it,
 * or the tab id the content script already read out of it.
 */
export function tabIdFromPane(pane: unknown): string | null {
  if (typeof pane !== 'string' || !pane) return null;
  return pane.startsWith(EMBED_FRAME_NAME_PREFIX) ? (parsePaneName(pane)?.id ?? null) : pane;
}

/** Forget an observation immediately when its iframe leaves this manager's document. */
export function reportFrameGone(frameId: number): void {
  if (!Number.isSafeInteger(frameId) || frameId <= 0) return;
  void workspaceApi.paperclipIntegration('frame_gone', { frameId });
}

export function useWorkspace(input: WorkspaceInput): WorkspaceController {
  const { db, enabled, view, settings, conversations, liveThreadKey } = input;
  const [state, dispatch] = useReducer(workspaceReducer, EMPTY_WORKSPACE_STATE);
  const [realms, setRealms] = useState<RealmAccounts[]>([]);
  const [ready, setReady] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tabId, setTabId] = useState<number | null>(null);
  const [busyRealm, setBusyRealm] = useState<string | null>(null);
  const [slots, setSlots] = useState<ProfileSlotMap>({});
  const [profilesSaved, setProfilesSaved] = useState(true);
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
  const embeddingRef = useRef(embedding);
  embeddingRef.current = embedding;
  const adoptionGate = useMemo(() => createAdoptionGate(), []);
  const runtimesRef = useRef(runtimes);
  runtimesRef.current = runtimes;
  const slotsRef = useRef(slots);
  slotsRef.current = slots;
  /** Realms with a slot claim in flight, so one click or one render never starts two. */
  const claiming = useRef(new Set<string>());
  /** The session tab whose page was clicked last: a tab it opens belongs to the same account. */
  const lastGestureTab = useRef<string | null>(null);
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
        setProfilesSaved(hello.profiles !== false);
        setTabId(hello.tabId);
        setError(hello.embedding ? null : 'ThreadStack could not prepare this tab for embedded pages. Reload the extension, then this page.');
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
  /** Write the latest state now. Never throws; resolves once the write is done (or failed). */
  const persistNow = useCallback(async () => {
    if (!enabled || !hydrated.current) return;
    try {
      await db.kv.put({ key: KV_KEYS.workspaceState, value: stateRef.current, updatedAt: new Date().toISOString() });
    } catch {
      // The next change writes again.
    }
  }, [db, enabled]);

  // What the person arranged (tabs, their accounts, the dashboard) is written at once, so a reload
  // right after never loses it; a page reporting its title or address is written a moment later.
  const savedShape = useRef('');
  useEffect(() => {
    if (!enabled || !hydrated.current) return;
    const shape = workspaceShape(state);
    if (shape !== savedShape.current) {
      savedShape.current = shape;
      void persistNow();
      return;
    }
    const timer = setTimeout(() => void persistNow(), 300);
    return () => clearTimeout(timer);
  }, [enabled, state, persistNow]);

  // Leaving the page (closing it, reloading it, going elsewhere) writes what is pending.
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const onHide = () => void persistNow();
    window.addEventListener('pagehide', onHide);
    return () => window.removeEventListener('pagehide', onHide);
  }, [enabled, persistNow]);

  /** Reload the page once the latest state is written (a reload is how a profile slot is freed). */
  const reloadSaved = useCallback(() => {
    void persistNow().finally(reloadWorkspacePage);
  }, [persistNow]);

  const applyChange = useCallback((result: AccountsChangeResult | WorkspaceFailure) => {
    if (result.ok && alive.current) setRealms(result.realms);
    return result;
  }, []);

  /** The accounts as the worker has them now; null when it did not answer. */
  const loadAccounts = useCallback(async (): Promise<RealmAccounts[] | null> => {
    const res = await workspaceApi.listAccounts();
    if (!res.ok) return null;
    if (alive.current) setRealms(res.realms);
    return res.realms;
  }, []);

  const refreshAccounts = useCallback(async () => {
    await loadAccounts();
  }, [loadAccounts]);

  // ---- the worker stays awake while this page shows ------------------------------------------
  useEffect(() => {
    if (!enabled) return;
    return startWorkspacePort();
  }, [enabled]);

  // ---- what the frames and the service worker tell this page --------------------------------
  useEffect(() => {
    if (!enabled || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const onMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
      const msg = message as { type?: string } & Record<string, unknown>;
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'PROFILE_RETIRED') {
        // From the worker only (never a frame): this account's saved sign-in was replaced, so a
        // slot of this page that shows it holds old cookies. Its tabs rest until a reload.
        if (sender.tab || typeof msg.accountId !== 'string') return;
        const retired = msg.accountId;
        const movedFrom = Array.isArray(msg.movedFrom) ? msg.movedFrom : null;
        if (movedFrom && !movedFrom.includes(tabIdRef.current)) return;
        setSlots((prev) => {
          let changed = false;
          const next: Record<string, ProfileSlotMap[string]> = { ...prev };
          for (const [realm, slot] of Object.entries(prev)) {
            if (slot.accountId !== retired || slot.status === 'stale') continue;
            next[realm] = { accountId: retired, status: 'stale', moved: movedFrom !== null };
            changed = true;
          }
          return changed ? next : prev;
        });
        return;
      }
      if (msg.type === 'ACCOUNTS_CHANGED') {
        // Tabs whose account became, or stopped being, the browser's own sign-in move between an
        // ordinary frame and the profile slot by themselves (FrameStage keys frames by slot). A tab
        // that now needs a slot another account holds says so and offers to switch; nothing here
        // reloads the page, which would reload every embedded page of every site.
        void loadAccounts();
        return;
      }
      if (msg.type === 'EMBED_OPEN_REQUEST') {
        // The worker asks before it closes a tab whose opener is this one; only the answer
        // `adopted: true` lets it close the tab. Another workspace tab stays silent.
        const req = msg as unknown as Extract<WorkspaceBroadcast, { type: 'EMBED_OPEN_REQUEST' }>;
        if (sender.tab || req.tabId !== tabIdRef.current || typeof req.url !== 'string') return;
        // A tab the user (or an extension) opened next to this one is left alone: only one that
        // appeared right after a click inside an embedded page is taken in (adoption.ts).
        let adopted = false;
        if (embeddingRef.current && adoptionGate.claim()) {
          // It opens as the account of the page that was clicked, when it is the same sign-in.
          const opener = stateRef.current.tabs.find((t) => t.id === lastGestureTab.current);
          const target = embedTargetFor(req.url);
          const accountId = opener && target && target.realm.id === opener.realm ? opener.accountId : undefined;
          adopted = openUrlRef.current(req.url, accountId ? { accountId } : undefined).ok;
        }
        sendResponse({ ok: true, adopted });
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
  }, [enabled, refreshAccounts, adoptionGate]);

  // ---- clicks inside embedded pages, for the adoption check above ----------------------------
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    const onWindowMessage = (event: MessageEvent) => {
      if (!isEmbedGestureMessage(event.data) || !event.source) return;
      // Only from a page embedded directly in this one.
      const own = Array.from(document.querySelectorAll('iframe')).find(
        (frame) => frame.name.startsWith(EMBED_FRAME_NAME_PREFIX) && frame.contentWindow === event.source
      );
      if (own) {
        lastGestureTab.current = own.dataset.tab ?? null;
        adoptionGate.noteGesture();
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') adoptionGate.noteHidden();
    };
    window.addEventListener('message', onWindowMessage);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.removeEventListener('message', onWindowMessage);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [enabled, adoptionGate]);

  // ---- which pages are mounted ---------------------------------------------------------------
  const visible = useMemo(() => {
    if (!enabled) return [];
    // Split view shows two pages at once; the status board shows none.
    if (view === 'browse') return browseVisibleTabs(state);
    if (view === 'threads') return liveThreadKey ? [threadTabId(liveThreadKey)] : [];
    const panes = state.dashboard.panes.filter((k): k is string => typeof k === 'string').map(threadTabId);
    // The focused pane first, so it is the last to be unloaded when the limit is small.
    const focused = state.dashboard.panes[state.dashboard.focusedPane];
    return focused ? [threadTabId(focused), ...panes.filter((id) => id !== threadTabId(focused))] : panes;
  }, [enabled, view, state.activeTabId, state.tabs, state.browse, state.dashboard, liveThreadKey]);

  const plan = useMemo(
    () =>
      planFrames({
        tabs: enabled && embedding ? state.tabs : [],
        visible,
        warmed,
        realms,
        slots,
        maxLive: settings?.maxLiveFrames ?? 6,
      }),
    [enabled, embedding, state.tabs, visible, warmed, realms, slots, settings?.maxLiveFrames]
  );

  // ---- profile slots ---------------------------------------------------------------------------
  /**
   * Fill this page's slot of `realm` with `accountId`: the worker installs the rules and names
   * the addresses, the page loads them in hidden credentialless frames, and the worker confirms.
   * A slot is filled once per page load; only a failed attempt may be tried again.
   */
  const claimProfile = useCallback(async (realm: string, accountId: string, move = false): Promise<void> => {
    if (claiming.current.has(realm)) return;
    const held = slotsRef.current[realm];
    if (held && !(held.accountId === accountId && held.status === 'failed')) return;
    claiming.current.add(realm);
    const put = (slot: ProfileSlotMap[string] | null) => {
      if (!alive.current) return;
      setSlots((prev) => {
        // A retired slot stays retired until the page reloads, whatever an answer in flight says.
        if (prev[realm]?.status === 'stale') return prev;
        const next = { ...prev };
        if (slot) next[realm] = slot;
        else delete next[realm];
        return next;
      });
    };
    put({ accountId, status: 'seeding' });
    try {
      const claim = await workspaceApi.claimProfile(realm, accountId, move);
      if (!claim.ok) {
        if (claim.code === 'browser_account') {
          // It became the browser's own sign-in meanwhile: its tabs load in ordinary frames.
          put(null);
          await loadAccounts();
        } else if (claim.code === 'needs_reload') {
          // The worker holds this page's slot as it was before (another account, or a sign-in
          // replaced since): only a reload gives the page a new partition.
          put({ accountId, status: 'stale' });
        } else {
          put({ accountId, status: 'failed', error: claim.error, inUse: claim.code === 'profile_in_use' });
        }
        return;
      }
      for (const url of claim.steps) await loadSeed(url);
      const ready = await workspaceApi.profileReady(realm);
      put(
        ready.ok
          ? { accountId, status: 'ready', truncated: claim.truncated }
          : ready.code === 'needs_reload'
            ? { accountId, status: 'stale' }
            : { accountId, status: 'failed', error: ready.error }
      );
    } finally {
      claiming.current.delete(realm);
    }
  }, [loadAccounts]);

  // An account with a saved sign-in is loaded as soon as one of its tabs is shown.
  const wanted = useMemo(
    () => (enabled && embedding && ready ? wantedProfiles({ tabs: state.tabs, visible, realms, slots }) : []),
    [enabled, embedding, ready, state.tabs, visible, realms, slots]
  );
  useEffect(() => {
    for (const want of wanted) void claimProfile(want.realm, want.accountId);
  }, [wanted, claimProfile]);

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
      return { ok: false, reason: 'external', message: 'This thread has no web page ThreadStack can show here.' };
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

  /** Run an account change that can move the browser's cookies, showing the realm as busy meanwhile. */
  const changeAccounts = useCallback(
    async (realm: string | null, work: () => Promise<AccountsChangeResult | WorkspaceFailure>) => {
      if (realm) setBusyRealm(realm);
      try {
        return applyChange(await work());
      } finally {
        if (alive.current) setBusyRealm(null);
      }
    },
    [applyChange]
  );

  const realmOfAccount = useCallback((accountId: string) => findAccount(realmsRef.current, accountId)?.realm ?? null, []);

  const useAsBrowserAccount = useCallback<WorkspaceController['useAsBrowserAccount']>(
    (accountId) => changeAccounts(realmOfAccount(accountId), () => workspaceApi.activateAccount(accountId)),
    [changeAccounts, realmOfAccount]
  );

  const beginBrowserSignIn = useCallback<WorkspaceController['beginBrowserSignIn']>(
    (accountId) => changeAccounts(realmOfAccount(accountId), () => workspaceApi.beginBrowserSignIn(accountId)),
    [changeAccounts, realmOfAccount]
  );

  const pendingRealm = () => realmsRef.current.find((r) => r.pendingSignIn)?.realm.id ?? null;

  const finishBrowserSignIn = useCallback<WorkspaceController['finishBrowserSignIn']>(
    (attemptId) => changeAccounts(pendingRealm(), () => workspaceApi.finishBrowserSignIn(attemptId)),
    [changeAccounts]
  );

  const cancelBrowserSignIn = useCallback<WorkspaceController['cancelBrowserSignIn']>(
    (attemptId) => changeAccounts(pendingRealm(), () => workspaceApi.cancelBrowserSignIn(attemptId)),
    [changeAccounts]
  );

  const addAccount = useCallback<WorkspaceController['addAccount']>(
    async (details) => applyChange(await workspaceApi.addAccount(details)),
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
        // Its cookies are still in this page's slot; a reload is what clears them.
        if (slotsRef.current[account.realm]?.accountId === accountId) reloadSaved();
      }
      return result;
    },
    [applyChange]
  );

  const showProfile = useCallback<WorkspaceController['showProfile']>(
    async (accountId, move) => {
      const account = findAccount(realmsRef.current, accountId);
      if (account) await claimProfile(account.realm, accountId, move);
    },
    [claimProfile]
  );

  const switchProfile = useCallback<WorkspaceController['switchProfile']>(
    async (id) => {
      const current = stateRef.current;
      const tab = current.tabs.find((t) => t.id === id);
      if (!tab) return;
      // After the reload the slot goes to the first shown tab that needs it: make that this one.
      let next = workspaceReducer(current, { type: 'activate', id, now: Date.now() });
      const pane = next.dashboard.panes.findIndex((key) => key !== null && threadTabId(key) === id);
      if (pane >= 0) next = workspaceReducer(next, { type: 'dashboard_focus', index: pane });
      try {
        await db.kv.put({ key: KV_KEYS.workspaceState, value: next, updatedAt: new Date().toISOString() });
      } catch {
        // The reload still frees the slot; the person may have to choose the tab again.
      }
      reloadWorkspacePage();
    },
    [db]
  );

  const goToAccount = useCallback<WorkspaceController['goToAccount']>((accountId) => {
    const account = findAccount(realmsRef.current, accountId);
    if (!account) return { ok: false, reason: 'no_account', message: 'That account no longer exists.' };
    const current = stateRef.current;
    const own = current.tabs
      .filter((t) => t.accountId === accountId && t.realm === account.realm)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (own) {
      dispatch({ type: 'activate', id: own.id, now: Date.now() });
      return { ok: true, tabId: own.id };
    }
    // No tab of this account yet: the same product the person is looking at, else the sign-in's home.
    const showing = current.tabs.find((t) => t.id === current.activeTabId);
    const sameProduct = showing && showing.realm === account.realm ? LAUNCH_PROVIDERS.find((p) => p.provider === showing.provider) : undefined;
    const url = sameProduct?.url ?? realmById(account.realm)?.homeUrl;
    if (!url) return { ok: false, reason: 'external', message: 'This sign-in has no page to open here.' };
    return openUrlRef.current(url, { accountId });
  }, []);

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
  const slotOf = useCallback((tab: SessionTab) => slotOfTab(tab, realms), [realms]);

  const openStartPage = useCallback<WorkspaceController['openStartPage']>((url) => {
    const target = embedTargetFor(url);
    if (!target) return { ok: false, reason: 'external', message: 'This address opens in a Chrome tab.' };
    // A tab already on that product is the landing; a second one would only be clutter.
    const open = stateRef.current.tabs
      .filter((t) => t.provider === target.provider)
      .sort((a, b) => b.lastActiveAt - a.lastActiveAt)[0];
    if (open) {
      dispatch({ type: 'activate', id: open.id, now: Date.now() });
      return { ok: true, tabId: open.id };
    }
    return openUrlRef.current(target.url);
  }, []);

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
    busyRealm,
    slots,
    profilesSaved,
    slotOf,
    dispatch,
    openUrl,
    openStartPage,
    openThread,
    closeTab,
    activateTab,
    goToAccount,
    showProfile,
    switchProfile,
    useAsBrowserAccount,
    beginBrowserSignIn,
    finishBrowserSignIn,
    cancelBrowserSignIn,
    addAccount,
    updateAccount,
    removeAccount,
    refreshAccounts,
    back: (id) => frameCommand(id, 'back'),
    forward: (id) => frameCommand(id, 'forward'),
    reload,
    navigate,
    noteFrameLoaded,
    noteFrameGone: reportFrameGone,
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
