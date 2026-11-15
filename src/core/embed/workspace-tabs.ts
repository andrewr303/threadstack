// Workspace tabs: Threadkeeper's own manager.html running as a top-level tab that embeds provider
// pages. The service worker remembers each one (chrome.storage.session, so a restarted worker
// still knows them), keeps one header rule per tab (rules.ts), answers the workspace page's
// account commands, and decides which new windows an embedded page opens are taken back into
// the workspace.
//
// Everything here takes its chrome APIs as arguments so it can be tested with fakes.
import type { AccountService } from '../accounts/contract.js';
import { PROVIDERS, detectProviderFromUrl, isProviderAllowedOnUrl } from '../providers.js';
import {
  ACCOUNT_COLORS,
  type AccountColor,
  type AccountIdentity,
  type AccountRecord,
  type AccountsChangeResult,
  type HelperPingResult,
  type ProfileClaimResult,
  type WorkspaceBroadcast,
  type WorkspaceFailure,
} from '../workspace/types.js';
import { realmById } from '../workspace/realms.js';
import { installEmbedRule, orphanRuleIds, removeEmbedRules, type SessionRulesApi } from './rules.js';

/** chrome.storage.session key: Record<tabId, ruleId | null>. */
export const WORKSPACE_TABS_KEY = 'tk_workspace_tabs';

export interface KeyValueStore {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export interface WorkspaceTabsEnv {
  store: KeyValueStore | null;
  rules: SessionRulesApi | null;
  /**
   * The tab's address; `undefined` when the tab exists but its address is not visible to the
   * extension (which is always the case for Threadkeeper's own pages: it holds no "tabs"
   * permission), `null` when the tab is gone.
   */
  tabUrl(tabId: number): Promise<string | null | undefined>;
  /** chrome-extension://<id>/manager.html */
  managerUrl: string;
}

/** Whether `url` is the manager page itself (any query or fragment), not a look-alike path. */
export function isManagerTabUrl(url: string | null | undefined, managerUrl: string): boolean {
  if (!url || !url.startsWith(managerUrl)) return false;
  const rest = url.slice(managerUrl.length);
  return rest === '' || rest.startsWith('?') || rest.startsWith('#');
}

export class WorkspaceTabs {
  /** tabId → rule id (null when no rule could be installed). */
  private tabs = new Map<number, number | null>();
  private loaded: Promise<void> | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly env: WorkspaceTabsEnv) {}

  /** Load what an earlier worker remembered. Safe to await on every message. */
  ready(): Promise<void> {
    if (!this.loaded) {
      this.loaded = (async () => {
        try {
          const raw = (await this.env.store?.get(WORKSPACE_TABS_KEY))?.[WORKSPACE_TABS_KEY];
          if (raw && typeof raw === 'object') {
            for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
              const tabId = Number(key);
              if (!Number.isInteger(tabId) || tabId < 0) continue;
              if (!this.tabs.has(tabId)) this.tabs.set(tabId, typeof value === 'number' ? value : null);
            }
          }
        } catch {
          // session storage unavailable: start empty
        }
      })();
    }
    return this.loaded;
  }

  /** Synchronous lookup for sender checks; call ready() first. */
  has(tabId: number | undefined): boolean {
    return typeof tabId === 'number' && this.tabs.has(tabId);
  }

  ids(): number[] {
    return [...this.tabs.keys()];
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async persist(): Promise<void> {
    if (!this.env.store) return;
    const value: Record<string, number | null> = {};
    for (const [tabId, ruleId] of this.tabs) value[String(tabId)] = ruleId;
    try {
      await this.env.store.set({ [WORKSPACE_TABS_KEY]: value });
    } catch {
      // the in-memory copy still answers for this worker's lifetime
    }
  }

  /** A workspace page said hello from `tabId` (sender already validated as a manager tab). */
  hello(tabId: number): Promise<{ embedding: boolean }> {
    return this.serial(async () => {
      await this.ready();
      await this.pruneNow(tabId);
      let ruleId: number | null = null;
      if (this.env.rules) {
        const remembered = new Map<number, number>();
        for (const [t, r] of this.tabs) if (typeof r === 'number') remembered.set(t, r);
        try {
          ruleId = await installEmbedRule(this.env.rules, tabId, remembered);
        } catch {
          ruleId = null;
        }
      }
      this.tabs.set(tabId, ruleId);
      await this.persist();
      return { embedding: ruleId !== null };
    });
  }

  /** The tab closed or stopped being a workspace page: drop its rule and forget it. */
  forget(tabId: number): Promise<void> {
    return this.serial(async () => {
      await this.ready();
      await this.forgetNow(tabId);
    });
  }

  private async forgetNow(tabId: number): Promise<void> {
    if (!this.tabs.has(tabId)) return;
    const ruleId = this.tabs.get(tabId);
    this.tabs.delete(tabId);
    if (typeof ruleId === 'number' && this.env.rules) await removeEmbedRules(this.env.rules, [ruleId]).catch(() => undefined);
    await this.persist();
  }

  /** Forget remembered tabs that are no longer manager pages, and remove rules nobody owns. */
  prune(): Promise<void> {
    return this.serial(async () => {
      await this.ready();
      await this.pruneNow(null);
    });
  }

  private async pruneNow(keep: number | null): Promise<void> {
    for (const tabId of [...this.tabs.keys()]) {
      if (tabId === keep) continue;
      // Only what is known counts: a closed tab, or one seen showing another address. A tab whose
      // address cannot be read is left alone; its page's connection tells when it leaves.
      const url = await this.env.tabUrl(tabId).catch(() => undefined);
      if (url === null || (typeof url === 'string' && !isManagerTabUrl(url, this.env.managerUrl))) await this.forgetNow(tabId);
    }
    if (!this.env.rules) return;
    try {
      const remembered = new Map<number, number>();
      for (const [t, r] of this.tabs) if (typeof r === 'number') remembered.set(t, r);
      // A rule for the tab saying hello that no record accounts for is removed too; hello
      // installs a fresh one right after.
      await removeEmbedRules(this.env.rules, orphanRuleIds(await this.env.rules.getSessionRules(), remembered));
    } catch {
      // rules API unavailable; nothing to clean
    }
  }
}

// ---- New windows opened by an embedded page --------------------------------------------------

export type NewTabAdoption = 'adopt' | 'wait' | 'leave';

/**
 * What to do with a tab that a page inside a workspace tab opened. Only an https page of a
 * provider Threadkeeper knows, opened in a normal window, is taken back into the workspace;
 * popup windows (sign-in flows use them) and every other address are left alone. An empty or
 * about:blank address means the real one has not arrived yet.
 */
export function decideNewTabAdoption(input: {
  openerIsWorkspace: boolean;
  url: string | null | undefined;
  windowType: string | null | undefined;
}): NewTabAdoption {
  if (!input.openerIsWorkspace) return 'leave';
  const url = input.url ?? '';
  if (url === '' || url === 'about:blank') return 'wait';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'leave';
  }
  if (parsed.protocol !== 'https:') return 'leave';
  const provider = detectProviderFromUrl(parsed.href);
  // isProviderAllowedOnUrl ignores the tk_provider test hint, so an arbitrary site cannot opt in.
  if (!provider || PROVIDERS[provider].hostAccess === 'custom' || !isProviderAllowedOnUrl(provider, parsed.href)) return 'leave';
  return input.windowType === 'normal' ? 'adopt' : 'leave';
}

// ---- Identity reports ------------------------------------------------------------------------

function boundedText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text.length > 0 && text.length <= max ? text : null;
}

/**
 * The identity an ACCOUNT_IDENTITY message carries, rebuilt from checked fields only: null when
 * the page says nobody is signed in, undefined when the report is malformed (then it is ignored).
 */
export function sanitizeIdentity(value: unknown): Omit<AccountIdentity, 'observedAt'> | null | undefined {
  if (value === null) return null;
  if (!value || typeof value !== 'object') return undefined;
  const v = value as Record<string, unknown>;
  const key = boundedText(v.key, 200);
  if (!key) return undefined;
  if (v.source !== 'network' && v.source !== 'dom') return undefined;
  const display = v.display === null || v.display === undefined ? null : boundedText(v.display, 200);
  if (display === null && v.display !== null && v.display !== undefined) return undefined;
  const detail = v.detail === null || v.detail === undefined ? null : boundedText(v.detail, 200);
  if (detail === null && v.detail !== null && v.detail !== undefined) return undefined;
  return { key, display, detail, source: v.source };
}

// ---- Workspace commands ----------------------------------------------------------------------

/** The profile slots as the commands use them (core/embed/profiles.ts behind it). */
export interface ProfileCommands {
  /** Whether the worker can see the cookies profile pages are given, so sign-ins are saved. */
  available: boolean;
  claim(tabId: number, realmId: string, accountId: string): Promise<ProfileClaimResult | WorkspaceFailure>;
  ready(tabId: number, realmId: string): Promise<{ ok: true } | WorkspaceFailure>;
  /** The tab loaded a new workspace page: its slots start empty. */
  reset(tabId: number): Promise<void>;
  /**
   * The account's saved jar was replaced or removed behind the worker's live copy: drop the copy,
   * retire every slot showing the account and tell the pages (PROFILE_RETIRED). Awaited before the
   * change is announced, so no page re-places its frames in a partition that is out of date.
   */
  accountReplaced(accountId: string): Promise<void>;
  /** Save the account's live copy now, so a switch that uses its saved jar has the latest cookies. */
  flush(accountId: string): Promise<void>;
}

export interface WorkspaceCommandDeps {
  /** Null when the account service could not be created. */
  accounts: AccountService | null;
  tabs: WorkspaceTabs;
  helperPing(): Promise<HelperPingResult | WorkspaceFailure>;
  helperOpen(account: AccountRecord | null, url: unknown): Promise<{ ok: true } | WorkspaceFailure>;
  broadcast(message: WorkspaceBroadcast): void;
  /** Null in a browser without the pieces profiles need. */
  profiles?: ProfileCommands | null;
  /** Open a realm's sign-in page in an ordinary tab, for a sign-in borrowed from the browser. */
  openSignInTab?(url: string): Promise<void>;
  /** Close the tab `openSignInTab` opened, when it is still there. */
  closeSignInTab?(): Promise<void>;
}

const UNAVAILABLE: WorkspaceFailure = { ok: false, error: 'Accounts are not available right now. Reload Threadkeeper and try again.' };
const FAILED: WorkspaceFailure = { ok: false, error: 'Threadkeeper could not change accounts. Try again.' };

function idString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= 100 ? value : null;
}

function optionalLabel(value: unknown): string | undefined | false {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return false;
  const label = value.trim();
  return label.length > 0 && label.length <= 80 ? label : false;
}

function optionalColor(value: unknown): AccountColor | undefined | false {
  if (value === undefined || value === null) return undefined;
  return (ACCOUNT_COLORS as readonly unknown[]).includes(value) ? (value as AccountColor) : false;
}

const PROFILE_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function findAccount(accounts: AccountService, accountId: string): Promise<AccountRecord | null> {
  const realms = await accounts.list();
  for (const r of realms) {
    const found = r.accounts.find((a) => a.id === accountId);
    if (found) return found;
  }
  return null;
}

function isChange(result: AccountsChangeResult | WorkspaceFailure): result is AccountsChangeResult {
  return result.ok === true;
}

/**
 * Answer one WorkspaceCommand. The sender is already validated as a top-level manager tab;
 * `tabId` is that tab. Every field of the message is checked here before it reaches the service.
 */
export async function handleWorkspaceCommand(
  message: Record<string, unknown> & { type: string },
  tabId: number,
  deps: WorkspaceCommandDeps
): Promise<unknown> {
  const accounts = deps.accounts;
  try {
    switch (message.type) {
      case 'WORKSPACE_HELLO': {
        // A new page in this tab has a new, empty cookie partition for profiles.
        await deps.profiles?.reset(tabId).catch(() => undefined);
        const { embedding } = await deps.tabs.hello(tabId);
        const realms = accounts ? await accounts.list().catch(() => []) : [];
        return { ok: true, tabId, embedding, profiles: Boolean(deps.profiles?.available), realms };
      }
      case 'PROFILE_CLAIM': {
        if (!accounts || !deps.profiles) return UNAVAILABLE;
        const realm = idString(message.realm);
        const accountId = idString(message.accountId);
        if (!realm || !accountId) return { ok: false, error: 'That account request is not valid.', code: 'not_allowed' };
        return await deps.profiles.claim(tabId, realm, accountId);
      }
      case 'PROFILE_READY': {
        if (!deps.profiles) return UNAVAILABLE;
        const realm = idString(message.realm);
        if (!realm) return { ok: false, error: 'That account request is not valid.', code: 'not_allowed' };
        return await deps.profiles.ready(tabId, realm);
      }
      case 'ACCOUNTS_SIGNIN_BEGIN': {
        if (!accounts) return UNAVAILABLE;
        const accountId = idString(message.accountId);
        if (!accountId) return { ok: false, error: 'That account no longer exists.', code: 'unknown_account' };
        await deps.profiles?.flush(accountId).catch(() => undefined);
        const result = await accounts.beginBrowserSignIn(accountId);
        if (isChange(result)) {
          // Its saved jar went into the browser; the worker's copy of it is no longer the truth.
          await deps.profiles?.accountReplaced(accountId).catch(() => undefined);
          const realm = result.account?.realm;
          if (realm) {
            announce(deps, result, realm);
            const url = realmById(realm)?.signInUrl;
            if (url) await deps.openSignInTab?.(url).catch(() => undefined);
          }
        }
        return result;
      }
      case 'ACCOUNTS_SIGNIN_FINISH':
      case 'ACCOUNTS_SIGNIN_CANCEL': {
        if (!accounts) return UNAVAILABLE;
        const pending = await accounts.pendingSignIn();
        const result = message.type === 'ACCOUNTS_SIGNIN_FINISH' ? await accounts.finishBrowserSignIn() : await accounts.cancelBrowserSignIn();
        if (isChange(result) && pending) {
          await deps.profiles?.accountReplaced(pending.accountId).catch(() => undefined);
          await deps.profiles?.accountReplaced(pending.returnToAccountId).catch(() => undefined);
          announce(deps, result, pending.realm);
          await deps.closeSignInTab?.().catch(() => undefined);
        }
        return result;
      }
      case 'ACCOUNTS_LIST': {
        if (!accounts) return UNAVAILABLE;
        return { ok: true, realms: await accounts.list() };
      }
      case 'ACCOUNTS_ADD': {
        if (!accounts) return UNAVAILABLE;
        const realm = idString(message.realm);
        const mode = message.mode === 'embedded' || message.mode === 'isolated' ? message.mode : null;
        const label = optionalLabel(message.label);
        const color = optionalColor(message.color);
        const profileId = message.profileId === undefined || message.profileId === null ? undefined : message.profileId;
        if (!realm || !mode || label === false || color === false) return { ok: false, error: 'That account request is not valid.', code: 'not_allowed' };
        if (profileId !== undefined && (typeof profileId !== 'string' || !PROFILE_ID_RE.test(profileId) || mode !== 'isolated')) {
          return { ok: false, error: 'Invalid account profile ID.', code: 'not_allowed' };
        }
        const result = await accounts.add({ realm, mode, label, color, profileId });
        if (isChange(result)) announce(deps, result, result.account?.realm ?? realm);
        return result;
      }
      case 'ACCOUNTS_ACTIVATE':
      case 'ACCOUNTS_REMOVE':
      case 'ACCOUNTS_UPDATE': {
        if (!accounts) return UNAVAILABLE;
        const accountId = idString(message.accountId);
        if (!accountId) return { ok: false, error: 'That account no longer exists.', code: 'unknown_account' };
        const before = await findAccount(accounts, accountId);
        let result: AccountsChangeResult | WorkspaceFailure;
        // Its saved jar is about to go into the browser: first save what its pages changed.
        if (message.type === 'ACCOUNTS_ACTIVATE') await deps.profiles?.flush(accountId).catch(() => undefined);
        if (message.type === 'ACCOUNTS_ACTIVATE') result = await accounts.activate(accountId);
        else if (message.type === 'ACCOUNTS_REMOVE') result = await accounts.remove(accountId);
        else {
          const label = optionalLabel(message.label);
          const color = optionalColor(message.color);
          if (label === false || color === false) return { ok: false, error: 'That name or color is not valid.', code: 'not_allowed' };
          result = await accounts.update(accountId, { label, color });
        }
        const realm = (isChange(result) ? result.account?.realm : undefined) ?? before?.realm;
        // A removed account, and one whose jar went into the browser, have no live copy to keep.
        if (isChange(result) && message.type !== 'ACCOUNTS_UPDATE') await deps.profiles?.accountReplaced(accountId).catch(() => undefined);
        // Removing the browser's own account hands the browser to another account, whose saved
        // sign-in goes into it: a slot showing that one is out of date too.
        if (isChange(result) && message.type === 'ACCOUNTS_REMOVE' && realm) {
          const next = result.realms.find((r) => r.realm.id === realm)?.activeAccountId;
          if (next && next !== accountId) await deps.profiles?.accountReplaced(next).catch(() => undefined);
        }
        if (isChange(result) && realm) announce(deps, result, realm);
        return result;
      }
      case 'HELPER_PING':
        return await deps.helperPing();
      case 'HELPER_OPEN': {
        if (!accounts) return UNAVAILABLE;
        const accountId = idString(message.accountId);
        const account = accountId ? await findAccount(accounts, accountId) : null;
        return await deps.helperOpen(account, message.url);
      }
      default:
        return { ok: false, error: `Unknown ${message.type}`, code: 'not_allowed' };
    }
  } catch {
    // The service's own errors can carry details about accounts; the page gets a plain sentence.
    return FAILED;
  }
}

function announce(deps: WorkspaceCommandDeps, result: AccountsChangeResult, realm: string): void {
  const info = result.realms.find((r) => r.realm.id === realm);
  deps.broadcast({ type: 'ACCOUNTS_CHANGED', realm, activeAccountId: info?.activeAccountId ?? null, switched: result.switched });
}
