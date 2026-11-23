// The account service as the rest of the extension sees it. The service worker owns the one
// instance; pages reach it through WorkspaceCommand messages (core/workspace/types.ts).
//
// Everything that touches cookies goes through `AccountsEnv`, so the service can be tested
// with a fake and no page-side code can import a cookie API by accident.
import type { ProviderId } from '../providers.js';
import type {
  AccountColor,
  AccountIdentity,
  AccountMode,
  AccountRecord,
  AccountsChangeResult,
  PendingSignIn,
  RealmAccounts,
  StoredCookie,
  WorkspaceFailure,
} from '../workspace/types.js';

/** The slice of chrome.cookies / chrome.permissions the service uses. */
export interface AccountsEnv {
  /** Every cookie of `domain` and its subdomains that the extension may read (all partitions). */
  getCookies(domain: string): Promise<StoredCookie[]>;
  /** Put one cookie back. Resolves false when the browser refuses it. */
  setCookie(cookie: StoredCookie): Promise<boolean>;
  removeCookie(cookie: StoredCookie): Promise<void>;
  /** Whether host access covers every origin pattern in the list. */
  hasHostAccess(patterns: string[]): Promise<boolean>;
  now(): Date;
  /** Random lowercase hex of the given length. */
  randomHex(length: number): string;
}

export interface CaptureAccount {
  /** Account id to write into the thread key. */
  accountId: string;
  workspaceId: string;
  /** The account the capture was attributed to; null when the provider has no realm. */
  account: AccountRecord | null;
}

export interface AddAccountInput {
  realm: string;
  mode: AccountMode;
  label?: string;
  color?: AccountColor;
  profileId?: string;
}

export interface IdentityOutcome {
  realm: string;
  activeAccountId: string | null;
  /** True when the active account of the realm changed because the site showed another identity. */
  reassigned: boolean;
  /** True when the stored identity or sign-in state of an account changed. */
  updated: boolean;
  /**
   * The account this report named, when it named someone and was taken into account (not a
   * "nobody signed in" report, and not one set aside right after a switch).
   */
  named?: string | null;
}

export interface AccountService {
  /**
   * Realms with their accounts, creating the primary account of a realm on first sight.
   * `realmIds` limits the answer; by default every switchable realm plus any realm that
   * already has an account.
   */
  list(realmIds?: string[]): Promise<RealmAccounts[]>;
  /** The signed-in account of a realm (its primary account when nothing was switched yet). */
  activeAccount(realmId: string): Promise<AccountRecord | null>;
  /**
   * Which account a capture of `provider` belongs to right now. `bound` is the provider's
   * entry in settings.boundAccounts: the primary account keeps that id, so threads stored
   * before accounts existed keep their keys. Never throws; falls back to `bound`.
   */
  resolveForCapture(provider: ProviderId, bound: { accountId: string; workspaceId: string }): Promise<CaptureAccount>;
  /**
   * Add an account. It is a profile from the start: no cookie of the browser is touched, and
   * the account has no sign-in until the person signs in inside its profile pages or through
   * `beginBrowserSignIn`.
   */
  add(input: AddAccountInput): Promise<AccountsChangeResult | WorkspaceFailure>;
  /**
   * Make an account the browser's own sign-in for its realm: save the browser's current cookies
   * as the outgoing account's jar, restore this account's. Every tab of the realm changes.
   */
  activate(accountId: string): Promise<AccountsChangeResult | WorkspaceFailure>;
  /** An account by id, or null. Legacy isolated accounts are returned as embedded profiles. */
  account(accountId: string): Promise<AccountRecord | null>;
  /**
   * A profile account's saved cookies, or null when it has none (or they cannot be read). The
   * realm's browser account has no jar to read: its cookies are the browser's.
   */
  readJar(accountId: string): Promise<StoredCookie[] | null>;
  /**
   * Save a profile account's cookies as they are now. Ignored for an account that is the
   * browser's own sign-in at that moment (its cookies live in the browser). An empty list
   * deletes the jar.
   */
  writeJar(accountId: string, cookies: StoredCookie[]): Promise<void>;
  /** The bot-check cookies the browser holds for a realm, which every profile of it shares. */
  deviceCookies(realmId: string): Promise<StoredCookie[]>;
  /**
   * Keep a copy of the browser account's cookies as they are now, so that signing in as someone
   * else in the browser (a sign-in popup from a profile page does that) cannot lose them.
   */
  snapshotBrowserAccount(realmId: string): Promise<void>;
  /**
   * The site named who is signed in inside a profile's pages (or, with null, that nobody is).
   * Recorded on that account only; a profile is whoever signed in there.
   */
  noteProfileIdentity(accountId: string, identity: Omit<AccountIdentity, 'observedAt'> | null): Promise<IdentityOutcome | null>;
  /**
   * Sign a profile account in through the browser itself: the browser's own sign-in for the
   * realm is saved and cleared, and the account becomes the browser account until
   * `finishBrowserSignIn` or `cancelBrowserSignIn`.
   */
  beginBrowserSignIn(accountId: string): Promise<AccountsChangeResult | WorkspaceFailure>;
  /** Keep what the browser is signed in to as the pending account's jar; restore the browser's own. */
  finishBrowserSignIn(attemptId?: string, requireIdentity?: boolean): Promise<AccountsChangeResult | WorkspaceFailure>;
  /** Give the pending sign-in up: restore the browser's own sign-in and keep nothing. */
  cancelBrowserSignIn(attemptId?: string): Promise<AccountsChangeResult | WorkspaceFailure>;
  pendingSignIn(): Promise<PendingSignIn | null>;
  update(accountId: string, patch: { label?: string; color?: AccountColor }): Promise<AccountsChangeResult | WorkspaceFailure>;
  /** Forget an account and its saved cookies. Threads keep their keys. A primary account cannot be removed. */
  remove(accountId: string): Promise<AccountsChangeResult | WorkspaceFailure>;
  /**
   * The site reported who is signed in (or, with null, that nobody is). Records it on the
   * active account; if it belongs to a different account, that account becomes the active
   * one, and an identity no account has yet gets a new account, so a capture is never filed
   * under the wrong person.
   */
  noteIdentity(provider: ProviderId, identity: Omit<AccountIdentity, 'observedAt'> | null, attempt?: PendingSignIn): Promise<IdentityOutcome | null>;
  /** Finish a switch that was interrupted (service worker stopped mid-way). Safe to call on every start. */
  recover(): Promise<void>;
}
