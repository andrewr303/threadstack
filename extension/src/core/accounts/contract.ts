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
   * Add an account. An embedded account becomes the realm's active account at once: the
   * current cookies are saved to the outgoing account and the realm is left signed out, ready
   * for the person to sign in. An isolated account only records the profile.
   */
  add(input: AddAccountInput): Promise<AccountsChangeResult | WorkspaceFailure>;
  /** Make an embedded account the signed-in one: save the outgoing cookies, restore its own. */
  activate(accountId: string): Promise<AccountsChangeResult | WorkspaceFailure>;
  update(accountId: string, patch: { label?: string; color?: AccountColor }): Promise<AccountsChangeResult | WorkspaceFailure>;
  /** Forget an account and its saved cookies. Threads keep their keys. A primary account cannot be removed. */
  remove(accountId: string): Promise<AccountsChangeResult | WorkspaceFailure>;
  /**
   * The site reported who is signed in (or, with null, that nobody is). Records it on the
   * active account; if it belongs to a different account, that account becomes the active
   * one, and an identity no account has yet gets a new account, so a capture is never filed
   * under the wrong person.
   */
  noteIdentity(provider: ProviderId, identity: Omit<AccountIdentity, 'observedAt'> | null): Promise<IdentityOutcome | null>;
  /** Finish a switch that was interrupted (service worker stopped mid-way). Safe to call on every start. */
  recover(): Promise<void>;
}
