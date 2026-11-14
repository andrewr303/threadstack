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
 * - `embedded`: inside the workspace. One embedded account per realm is signed in at a time;
 *   the others are stored as encrypted cookie jars and restored on switch.
 * - `isolated`: in its own Chrome profile window opened by the Mac helper (never embedded).
 *   Lets two accounts of one realm be signed in at the same moment.
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
  /** Isolated accounts: the Chrome profile directory id (a UUID) the Mac helper opens. */
  profileId?: string;
  /**
   * The login the browser already had when Threadkeeper first saw this realm. Its threads keep
   * the thread keys written before accounts existed (settings.boundAccounts).
   */
  primary: boolean;
  identity: AccountIdentity | null;
  /** `unknown` until the site has been seen with this account. */
  signedIn: 'yes' | 'no' | 'unknown';
  /** A saved cookie jar exists, so this (inactive) account can be restored without signing in. */
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
}

export type ActiveAccounts = Record<string, string>;

/** What a page needs to draw accounts: the realm, its accounts and which one is signed in. */
export interface RealmAccounts {
  realm: RealmInfo;
  accounts: AccountRecord[];
  activeAccountId: string | null;
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

export type WorkspaceView = 'browse' | 'threads' | 'dashboard';
export const WORKSPACE_VIEWS: readonly WorkspaceView[] = ['browse', 'threads', 'dashboard'];

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
  /** Make `accountId` the signed-in account of its realm (saves and restores cookies). */
  | { type: 'ACCOUNTS_ACTIVATE'; accountId: string }
  | { type: 'ACCOUNTS_UPDATE'; accountId: string; label?: string; color?: AccountColor }
  /** Forget an account and its saved cookies. Its threads stay in the library. */
  | { type: 'ACCOUNTS_REMOVE'; accountId: string }
  | { type: 'HELPER_PING' }
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
  'ACCOUNTS_UPDATE',
  'ACCOUNTS_REMOVE',
  'HELPER_PING',
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
  | 'not_allowed';

export interface WorkspaceHelloResult {
  ok: true;
  tabId: number;
  /** Whether embedding rules are installed for this tab. */
  embedding: boolean;
  realms: RealmAccounts[];
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
  /** An embedded page tried to open a new window; open the address as a session tab instead. */
  | { type: 'EMBED_OPEN_REQUEST'; tabId: number; url: string };

/**
 * Content script in an embedded frame → extension. Sent with chrome.runtime.sendMessage, so
 * the workspace page receives it too and reads `sender.frameId`.
 */
export type EmbedFrameEvent =
  /** First message of an embedded document. The worker answers `EmbedHelloResult`. */
  | { type: 'EMBED_HELLO'; pane: string | null; url: string; title: string }
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
  | { type: 'EMBED_COOKIES_GET' }
  | { type: 'EMBED_COOKIE_SET'; cookie: string };

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
