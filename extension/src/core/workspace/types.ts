// Shared contract for the workspace: accounts, embedded session tabs, the observed state of a
// coding-agent run, and the messages the workspace page, the content script and the service
// worker exchange. Types and constants only, so every context can import it.
import type { ProviderId } from '../providers.js';
import type { RealmInfo } from './realms.js';

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

/** Account tints. Always shown with the account's name or initial, never as the only signal. */
export const ACCOUNT_COLORS = ['teal', 'peach', 'violet', 'sage', 'blue', 'gold'] as const;
export type AccountColor = (typeof ACCOUNT_COLORS)[number];

/**
 * How an account's sessions are reached.
 * - `embedded`: inside the workspace. The realm's *browser account* is the one the browser itself
 *   is signed in to and loads in ordinary frames; every other account is a *profile*: its sign-in
 *   is kept as an encrypted cookie jar and loads in the workspace page's separate (credentialless)
 *   cookie partition, so it is signed in at the same moment as the browser account.
 * - `isolated`: legacy. Accounts that used to open in their own Chrome profile window through the
 *   Mac helper. They are read as `embedded` profiles that still need a sign-in (accounts/service).
 */
export type AccountMode = 'embedded' | 'isolated';

/** Who the site says is signed in. Kept on this device; never exported, synced or sent to AI. */
export interface AccountIdentity {
  /** Stable key for comparing identities: a hash of the site's own user or organization id. */
  key: string;
  /** What to show: the email or name the site displays, or null when only the key is known. */
  display: string | null;
  /** Plan or workspace name when the site exposes it. */
  detail?: string | null;
  observedAt: string;
  /** `network`: read from a response the page itself requested. `dom`: read from visible page text. */
  source: 'network' | 'dom';
}

export interface AccountRecord {
  /** Never contains ':'. `primary~<realm>` for the browser's own login, else `acct_<hex>`. */
  id: string;
  realm: string;
  /** Name the person recognises. Starts as the detected identity or "Account 2"; editable. */
  label: string;
  color: AccountColor;
  mode: AccountMode;
  /** Legacy isolated accounts: the Chrome profile directory id (a UUID) the Mac helper opened. */
  profileId?: string;
  /**
   * The login the browser already had when Threadkeeper first saw this realm. Its threads keep
   * the thread keys written before accounts existed (settings.boundAccounts).
   */
  primary: boolean;
  identity: AccountIdentity | null;
  /** `unknown` until the site has been seen with this account. */
  signedIn: 'yes' | 'no' | 'unknown';
  /**
   * A saved cookie jar exists: the account can be shown as a profile, or made the browser's
   * sign-in, without signing in again.
   */
  hasJar: boolean;
  order: number;
  createdAt: string;
  lastActiveAt: string | null;
}

/** An account's saved cookies, encrypted. Own table so nothing that lists accounts can leak it. */
export interface AccountJarRecord {
  accountId: string;
  /** AES-GCM initialisation vector. */
  iv: Uint8Array;
  /** AES-GCM ciphertext of JSON `StoredCookie[]`. */
  data: ArrayBuffer;
  cookieCount: number;
  savedAt: string;
}

/** The fields of chrome.cookies.Cookie needed to put a cookie back exactly as it was. */
export interface StoredCookie {
  name: string;
  value: string;
  domain: string;
  hostOnly: boolean;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite: 'no_restriction' | 'lax' | 'strict' | 'unspecified';
  session: boolean;
  expirationDate?: number;
  partitionKey?: { topLevelSite?: string; hasCrossSiteAncestor?: boolean };
  /** The site set it with the Partitioned attribute (cookies read from a response, not from chrome.cookies). */
  partitioned?: boolean;
}

/** Small values owned by one writer each (see KV_KEYS). */
export interface KvRecord {
  key: string;
  value: unknown;
  updatedAt: string;
}

export const KV_KEYS = {
  /** Written by the service worker only: Record<realmId, accountId>. */
  activeAccounts: 'accounts.active',
  /** Written by the service worker only: an account switch in progress (crash recovery). */
  switchJournal: 'accounts.switchJournal',
  /** Written by the service worker only: PendingSignIn, a sign-in borrowed from the browser. */
  pendingSignIn: 'accounts.signIn',
  /** Written by the workspace page only: WorkspaceState. */
  workspaceState: 'workspace.state',
} as const;

/** Written before a switch clears any cookie, so an interrupted switch can be finished. */
export interface SwitchJournal {
  realm: string;
  fromAccountId: string | null;
  toAccountId: string;
  /** `saved`: the outgoing jar is stored and cookies may be partly cleared or restored. */
  phase: 'saved';
  startedAt: string;
  /**
   * The target's saved jar is put into the browser but kept, not deleted (a browser sign-in:
   * cancelling it must leave the account's earlier sign-in as it was).
   */
  keepTargetJar?: true;
}

export type ActiveAccounts = Record<string, string>;

/**
 * A profile account signing in through the browser itself (for sign-ins that cannot finish
 * inside a frame: Google, Apple, passkeys). The browser's own sign-in for the realm is set aside
 * while the person signs in as `accountId` in an ordinary tab, then put back.
 */
export interface PendingSignIn {
  realm: string;
  /** The account being signed in; it is the realm's browser account until the sign-in ends. */
  accountId: string;
  /** The account that was the browser's own before, restored when the sign-in ends. */
  returnToAccountId: string;
  startedAt: string;
}

/** What a page needs to draw accounts: the realm, its accounts and which one the browser holds. */
export interface RealmAccounts {
  realm: RealmInfo;
  accounts: AccountRecord[];
  /**
   * The realm's browser account: the one signed in to the browser itself (ordinary tabs and the
   * workspace's ordinary frames). Every other embedded account is a profile.
   */
  activeAccountId: string | null;
  /** Set while a profile account is signing in through the browser (see PendingSignIn). */
  pendingSignIn?: PendingSignIn | null;
}

/**
 * The account id written into a thread key for a capture of `provider` under `account`.
 * The primary account keeps the id threads were stored under before accounts existed.
 */
export function threadAccountId(account: Pick<AccountRecord, 'id' | 'primary'>, legacyBoundAccountId: string): string {
  return account.primary ? legacyBoundAccountId : account.id;
}

// ---------------------------------------------------------------------------------------------
// Coding-agent run state
// ---------------------------------------------------------------------------------------------

/**
 * What the page showed about a coding-agent run when it was last read. A point-in-time
 * observation of visible controls, never a claim about work on the provider's servers.
 */
export const AGENT_STATES = [
  'running',
  'waiting_permission',
  'waiting_answer',
  'turn_complete',
  'failed',
  'idle',
  'signed_out',
  'unknown',
] as const;
export type AgentState = (typeof AGENT_STATES)[number];

export const AGENT_STATE_LABELS: Record<AgentState, string> = {
  running: 'Running',
  waiting_permission: 'Needs approval',
  waiting_answer: 'Needs your answer',
  turn_complete: 'Finished',
  failed: 'Failed',
  idle: 'Idle',
  signed_out: 'Signed out',
  unknown: 'Not observed',
};

export function isAgentState(value: unknown): value is AgentState {
  return typeof value === 'string' && (AGENT_STATES as readonly string[]).includes(value);
}

/** States that mean the session is waiting on the person. */
export function agentStateNeedsYou(state: AgentState | null | undefined): boolean {
  return state === 'waiting_permission' || state === 'waiting_answer' || state === 'failed';
}

// ---------------------------------------------------------------------------------------------
// Embedded session tabs
// ---------------------------------------------------------------------------------------------

/** One open session in the workspace. The same tab can be shown in Browse, Threads or Dashboard. */
export interface SessionTab {
  /** `tab_<hex>` for tabs opened by hand, `thread~<threadKey>` for a library thread opened live. */
  id: string;
  provider: ProviderId | null;
  realm: string;
  /** Account the tab belongs to; the realm must be switched to it before the tab can load. */
  accountId: string;
  /** Last address the embedded page reported (https only). */
  url: string;
  title: string;
  /** Library thread this tab shows, once known. */
  threadKey: string | null;
  createdAt: number;
  lastActiveAt: number;
}

export const DASHBOARD_LAYOUTS = [1, 2, 3, 4] as const;
export type DashboardLayout = (typeof DASHBOARD_LAYOUTS)[number];

export type WorkspaceView = 'browse' | 'threads' | 'table' | 'dashboard' | 'paperclip';
export const WORKSPACE_VIEWS: readonly WorkspaceView[] = ['browse', 'threads', 'table', 'dashboard', 'paperclip'];

export interface WorkspaceState {
  version: 1;
  tabs: SessionTab[];
  /** Tab shown in Browse. */
  activeTabId: string | null;
  dashboard: {
    layout: DashboardLayout;
    /** Thread keys shown in the panes, in order; null is an empty pane. */
    panes: Array<string | null>;
    focusedPane: number;
  };
  /** Side-navigation groups the person collapsed. */
  collapsedGroups: string[];
}

export const EMPTY_WORKSPACE_STATE: WorkspaceState = {
  version: 1,
  tabs: [],
  activeTabId: null,
  dashboard: { layout: 2, panes: [null, null], focusedPane: 0 },
  collapsedGroups: [],
};

/**
 * Name of the port the workspace page keeps open to the service worker while it is showing
 * (see background.ts: the worker follows the cookies of profile pages and must stay running).
 */
export const WORKSPACE_PORT_NAME = 'tk-workspace';
/** How often the workspace page sends a message over that port. */
export const WORKSPACE_PORT_BEAT_MS = 20_000;

/** Prefix of the `name` given to every embedded iframe; the rest is the SessionTab id. */
export const EMBED_FRAME_NAME_PREFIX = 'tk-pane~';

/** Most embedded pages kept loaded at once; the least recently used beyond this are put to sleep. */
export const DEFAULT_MAX_LIVE_FRAMES = 6;

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/**
 * Workspace page → service worker. Accepted only from Threadkeeper's own manager page running
 * as a top-level tab (never the in-page overlay, a frame, the side panel or a website).
 */
export type WorkspaceCommand =
  /** Register this tab so embedding rules apply to it. Answers `WorkspaceHelloResult`. */
  | { type: 'WORKSPACE_HELLO' }
  | { type: 'ACCOUNTS_LIST' }
  | {
      type: 'ACCOUNTS_ADD';
      realm: string;
      mode: AccountMode;
      label?: string;
      color?: AccountColor;
      /** Isolated accounts imported from Session Control keep their existing profile. */
      profileId?: string;
    }
  /**
   * Make `accountId` the browser's own sign-in for its realm (saves the browser's current
   * cookies as the outgoing account's jar and restores this account's). Changes every tab.
   */
  | { type: 'ACCOUNTS_ACTIVATE'; accountId: string }
  /**
   * Sign a profile account in through the browser: the browser's own sign-in is set aside, the
   * realm's sign-in page opens in an ordinary tab, and ACCOUNTS_SIGNIN_FINISH puts things back.
   */
  | { type: 'ACCOUNTS_SIGNIN_BEGIN'; accountId: string }
  /** Keep what the browser is signed in to now as the pending account's jar and restore the browser's own. */
  | { type: 'ACCOUNTS_SIGNIN_FINISH' }
  /** Give the pending sign-in up: restore the browser's own sign-in, keep nothing. */
  | { type: 'ACCOUNTS_SIGNIN_CANCEL' }
  /**
   * Show `accountId` in this tab's profile slot for its realm. Answers ProfileClaimResult: the
   * addresses the page loads in hidden credentialless frames to put the account's cookies in
   * place. One profile per realm per page load; another one needs the page reloaded.
   */
  | { type: 'PROFILE_CLAIM'; realm: string; accountId: string }
  /** The seeding addresses have loaded: the slot is ready and its header rules are removed. */
  | { type: 'PROFILE_READY'; realm: string }
  | { type: 'ACCOUNTS_UPDATE'; accountId: string; label?: string; color?: AccountColor }
  /** Forget an account and its saved cookies. Its threads stay in the library. */
  | { type: 'ACCOUNTS_REMOVE'; accountId: string }
  | { type: 'HELPER_PING' }
  /** Integration commands are accepted only from the top-level manager document. */
  | { type: 'PAPERCLIP_INTEGRATION'; action: string; payload?: unknown }
  | { type: 'PAPERCLIP_SERVICE_STATUS' }
  | { type: 'PAPERCLIP_SERVICE_START'; retry?: boolean }
  | { type: 'PAPERCLIP_SERVICE_INSTALL' }
  /** Open `url` in an isolated account's own Chrome profile window. */
  | { type: 'HELPER_OPEN'; accountId: string; url: string }
  /** Library backups kept on disk by the Mac helper (core/backup-helper.ts). */
  | { type: 'BACKUP_STATUS' }
  | { type: 'BACKUP_NOW' }
  | { type: 'BACKUP_RESTORE'; name: string };

export const WORKSPACE_COMMAND_TYPES: ReadonlySet<string> = new Set<WorkspaceCommand['type']>([
  'WORKSPACE_HELLO',
  'ACCOUNTS_LIST',
  'ACCOUNTS_ADD',
  'ACCOUNTS_ACTIVATE',
  'ACCOUNTS_SIGNIN_BEGIN',
  'ACCOUNTS_SIGNIN_FINISH',
  'ACCOUNTS_SIGNIN_CANCEL',
  'PROFILE_CLAIM',
  'PROFILE_READY',
  'ACCOUNTS_UPDATE',
  'ACCOUNTS_REMOVE',
  'HELPER_PING',
  'PAPERCLIP_INTEGRATION',
  'PAPERCLIP_SERVICE_STATUS',
  'PAPERCLIP_SERVICE_START',
  'PAPERCLIP_SERVICE_INSTALL',
  'HELPER_OPEN',
  'BACKUP_STATUS',
  'BACKUP_NOW',
  'BACKUP_RESTORE',
]);

export type WorkspaceFailure = { ok: false; error: string; code?: WorkspaceErrorCode };

export type WorkspaceErrorCode =
  /** The realm's sign-in is not one Threadkeeper switches. */
  | 'not_switchable'
  /** Host access for the realm's sites has not been granted. */
  | 'needs_host_access'
  | 'unknown_account'
  | 'busy'
  | 'helper_unavailable'
  | 'not_allowed'
  /** This page already shows another profile of the realm; reload it to show this one. */
  | 'needs_reload'
  /** The account is the browser's own sign-in: it loads in ordinary frames, not the profile slot. */
  | 'browser_account'
  /** Another account is signing in through the browser right now. */
  | 'signin_pending'
  /** The account is shown in another workspace tab; two pages must not keep one sign-in apart. */
  | 'profile_in_use';

export interface WorkspaceHelloResult {
  ok: true;
  tabId: number;
  /** Whether embedding rules are installed for this tab. */
  embedding: boolean;
  /**
   * Whether the worker can see the cookies profile pages are given (the webRequest permission).
   * Without it a profile still works until the page reloads, but its sign-in is not saved.
   */
  profiles: boolean;
  realms: RealmAccounts[];
}

/** Answer to PROFILE_CLAIM. */
export interface ProfileClaimResult {
  ok: true;
  realm: string;
  accountId: string;
  /** Addresses to load, in order, each in a hidden credentialless frame, before PROFILE_READY. */
  steps: string[];
  /** Whether the account has a saved sign-in (false: its pages will show the site's sign-in page). */
  signedIn: boolean;
  /**
   * The saved sign-in is larger than a profile can hold (the browser keeps about 10 KB of cookies
   * per site there), so part of it was left out and the site may ask for a sign-in.
   */
  truncated: boolean;
}

export interface AccountsListResult {
  ok: true;
  realms: RealmAccounts[];
}

export interface AccountsChangeResult {
  ok: true;
  account: AccountRecord | null;
  realms: RealmAccounts[];
  /** True when the realm's cookies were swapped, so its embedded pages must reload. */
  switched: boolean;
}

export interface HelperPingResult {
  ok: true;
  version: string;
  platform: string;
}

/** Service worker → every extension page. */
export type WorkspaceBroadcast =
  | { type: 'ACCOUNTS_CHANGED'; realm: string; activeAccountId: string | null; switched: boolean }
  /**
   * The account's saved sign-in was replaced (it became the browser's, came back from it, or was
   * removed): a page whose profile slot shows it holds old cookies and must reload to show it.
   * Sent before the ACCOUNTS_CHANGED of the same change.
   */
  | { type: 'PROFILE_RETIRED'; accountId: string }
  /** An embedded page tried to open a new window; open the address as a session tab instead. */
  | { type: 'EMBED_OPEN_REQUEST'; tabId: number; url: string };

/**
 * Content script in an embedded frame → extension. Sent with chrome.runtime.sendMessage, so
 * the workspace page receives it too and reads `sender.frameId`.
 */
export type EmbedFrameEvent =
  /**
   * First message of an embedded document. The worker answers `EmbedHelloResult`. `profile` is
   * true in a credentialless frame (the workspace's profile slot), read by the content script
   * itself, never taken from the page.
   */
  | { type: 'EMBED_HELLO'; pane: string | null; url: string; title: string; profile?: boolean }
  | {
      type: 'EMBED_NAV';
      pane: string | null;
      url: string;
      title: string;
      canGoBack: boolean;
      canGoForward: boolean;
    }
  | { type: 'EMBED_AGENT_STATE'; pane: string | null; url: string; state: AgentState }
  | { type: 'ACCOUNT_IDENTITY'; provider: ProviderId; identity: Omit<AccountIdentity, 'observedAt'> | null }
  /**
   * Cookie bridge. Scripts in a frame embedded in an extension page cannot read or write the
   * site's ordinary (SameSite Lax or Strict) cookies through document.cookie, although the
   * browser sends them on requests. The frame's content script asks the worker for the
   * script-visible cookies of its own address and forwards what the page sets. The worker
   * takes the address from the sender, never from the message.
   */
  | { type: 'EMBED_COOKIES_GET'; profile?: boolean }
  | { type: 'EMBED_COOKIE_SET'; cookie: string; profile?: boolean };

export const EMBED_FRAME_EVENT_TYPES: ReadonlySet<string> = new Set<EmbedFrameEvent['type']>([
  'EMBED_HELLO',
  'EMBED_NAV',
  'EMBED_AGENT_STATE',
  'ACCOUNT_IDENTITY',
  'EMBED_COOKIES_GET',
  'EMBED_COOKIE_SET',
]);

/** Answer to EMBED_COOKIES_GET: what document.cookie would return in an ordinary tab. */
export type EmbedCookiesResult = { ok: true; cookie: string } | WorkspaceFailure;

export type EmbedHelloResult = { ok: true; frameId: number; tabId: number } | WorkspaceFailure;

/** Workspace page → one embedded frame, via chrome.tabs.sendMessage(tabId, msg, { frameId }). */
export type EmbedFrameCommand =
  | { type: 'TK_EMBED_COMMAND'; command: 'back' | 'forward' | 'reload' }
  | { type: 'TK_EMBED_COMMAND'; command: 'navigate'; url: string };
