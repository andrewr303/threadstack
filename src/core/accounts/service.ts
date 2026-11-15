// The account service: the accounts of each login realm, which one the browser itself is signed
// in to (the realm's *browser account*), and the saved sign-ins of the others (*profiles*).
//
// A profile is shown inside the workspace from its saved jar, in the workspace page's own cookie
// partition (core/embed/profile-slots.ts), at the same moment as the browser account: nothing
// here is swapped for that. Swapping the browser's cookies remains for two things only: making
// another account the browser's own sign-in on request, and letting a profile sign in through
// an ordinary browser tab when its site's sign-in cannot finish inside a frame.
//
// A switch is: read the realm's cookies, save them encrypted as the outgoing account's jar and
// write a SwitchJournal (one transaction), remove every cookie of the realm, put the incoming
// account's jar back, then mark it active, drop its jar and clear the journal (one transaction).
// Once an account is active its live browser cookies are the only copy of its login, so its
// jar is deleted rather than left to go stale.
//
// Ordering: one promise chain per realm in memory, so two commands for a realm never
// interleave. The cookie-swapping part also holds one shared chain, because the journal is a
// single row; realm chains are always taken before the shared one, so they cannot deadlock. The
// journal covers the service worker being stopped mid-switch: recover() finishes it.
//
// Cookie values never leave this file except through AccountsEnv and the encrypted jar. Error
// results carry fixed messages, never an exception's text.
import type { ThreadkeeperDB } from '../db.js';
import type { ProviderId } from '../providers.js';
import { primaryAccountId, realmById, realmForProvider, switchableRealms, type RealmInfo } from '../workspace/realms.js';
import {
  ACCOUNT_COLORS,
  KV_KEYS,
  threadAccountId,
  type AccountColor,
  type AccountIdentity,
  type AccountRecord,
  type AccountsChangeResult,
  type ActiveAccounts,
  type PendingSignIn,
  type RealmAccounts,
  type StoredCookie,
  type SwitchJournal,
  type WorkspaceErrorCode,
  type WorkspaceFailure,
} from '../workspace/types.js';
import type { AccountService, AccountsEnv, AddAccountInput, CaptureAccount, IdentityOutcome } from './contract.js';
import { cookieSlot, isDeviceCookie } from './cookies.js';
import { decryptJar, encryptJar } from './crypto.js';
import { looksSignedIn } from './set-cookie.js';

const MAIN_LABEL = 'Main account';
const MAX_LABEL = 80;
const MAX_IDENTITY_TEXT = 200;
/** Remove passes before a clear gives up on cookies a page keeps setting again. */
const CLEAR_PASSES = 3;
/**
 * After a switch, pages loaded under the previous account can still deliver a response naming
 * that account. For this long, only observations that confirm the active account are used, so a
 * late answer cannot move the realm back to the account that was just switched away from.
 */
export const SWITCH_SETTLE_MS = 4000;
const SWITCH_LOCK = '*switch*';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Activate also reports cookies the browser refused to put back (not part of the contract yet). */
export interface AccountsSwitchResult extends AccountsChangeResult {
  refusedCookies: number;
}

function fail(error: string, code?: WorkspaceErrorCode): WorkspaceFailure {
  return code ? { ok: false, error, code } : { ok: false, error };
}

const SWITCH_FAILED = 'Could not switch accounts. Try again.';
const SIGNIN_OPEN = 'Another account is still signing in through the browser. Finish or cancel that first.';
const SAVE_FAILED = 'Could not save the account. Try again.';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isColor(value: unknown): value is AccountColor {
  return typeof value === 'string' && (ACCOUNT_COLORS as readonly string[]).includes(value);
}

function cleanLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const label = value.replace(/\s+/g, ' ').trim().slice(0, MAX_LABEL);
  return label.length > 0 ? label : null;
}

function isDefaultLabel(label: string): boolean {
  return label === MAIN_LABEL || /^Account \d+$/.test(label);
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim().slice(0, MAX_IDENTITY_TEXT);
  return text.length > 0 ? text : null;
}

/** Copies only the AccountIdentity fields, so nothing else a page sends can be stored. */
function cleanIdentity(raw: unknown, observedAt: string): AccountIdentity | null {
  if (!isRecord(raw)) return null;
  const key = typeof raw.key === 'string' ? raw.key.trim() : '';
  if (!key || key.length > MAX_IDENTITY_TEXT) return null;
  return {
    key,
    display: cleanText(raw.display),
    detail: cleanText(raw.detail),
    observedAt,
    source: raw.source === 'dom' ? 'dom' : 'network',
  };
}

function byOrder(a: AccountRecord, b: AccountRecord): number {
  return a.order - b.order || a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id);
}

function nextColor(accounts: AccountRecord[]): AccountColor {
  const unused = ACCOUNT_COLORS.find((c) => !accounts.some((a) => a.color === c));
  return unused ?? ACCOUNT_COLORS[accounts.length % ACCOUNT_COLORS.length];
}

function nextAccountLabel(accounts: AccountRecord[]): string {
  let n = accounts.length + 1;
  while (accounts.some((a) => a.label === `Account ${n}`)) n++;
  return `Account ${n}`;
}

function nextOrder(accounts: AccountRecord[]): number {
  return accounts.reduce((max, a) => Math.max(max, a.order), -1) + 1;
}

function readActiveMap(value: unknown): ActiveAccounts {
  const out: ActiveAccounts = {};
  if (!isRecord(value)) return out;
  for (const [realm, id] of Object.entries(value)) if (typeof id === 'string') out[realm] = id;
  return out;
}

function readJournalValue(value: unknown): SwitchJournal | null {
  if (!isRecord(value)) return null;
  if (typeof value.realm !== 'string' || typeof value.toAccountId !== 'string') return null;
  return {
    realm: value.realm,
    fromAccountId: typeof value.fromAccountId === 'string' ? value.fromAccountId : null,
    toAccountId: value.toAccountId,
    phase: 'saved',
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
    ...(value.keepTargetJar === true ? { keepTargetJar: true as const } : {}),
  };
}

function readPendingValue(value: unknown): PendingSignIn | null {
  if (!isRecord(value)) return null;
  if (typeof value.realm !== 'string' || typeof value.accountId !== 'string' || typeof value.returnToAccountId !== 'string') return null;
  return {
    realm: value.realm,
    accountId: value.accountId,
    returnToAccountId: value.returnToAccountId,
    startedAt: typeof value.startedAt === 'string' ? value.startedAt : '',
  };
}

/**
 * Accounts that used to live in their own Chrome profile window are profiles now. They never
 * had cookies in this browser profile, so they start without a sign-in.
 */
function asEmbedded(record: AccountRecord): AccountRecord {
  return record.mode === 'isolated' ? { ...record, mode: 'embedded', hasJar: false, signedIn: record.signedIn === 'yes' ? 'unknown' : record.signedIn } : record;
}

export function createAccountService(db: ThreadkeeperDB, env: AccountsEnv): AccountService {
  const locks = new Map<string, Promise<unknown>>();
  const lastSwitchAt = new Map<string, number>();

  const nowIso = () => env.now().toISOString();

  function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(name) ?? Promise.resolve();
    const run = previous.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined
    );
    locks.set(name, tail);
    void tail.then(() => {
      if (locks.get(name) === tail) locks.delete(name);
    });
    return run;
  }

  /** Realm chain first, then the shared cookie-swap chain. */
  function withSwitchLock<T>(realmId: string, fn: () => Promise<T>): Promise<T> {
    return withLock(realmId, () => withLock(SWITCH_LOCK, fn));
  }

  // -------------------------------------------------------------------------------------------
  // Records
  // -------------------------------------------------------------------------------------------

  async function realmAccounts(realmId: string): Promise<AccountRecord[]> {
    const rows = await db.accounts.where('realm').equals(realmId).toArray();
    return rows.map(asEmbedded).sort(byOrder);
  }

  /** Rewrites legacy isolated accounts as embedded profiles, once. */
  async function migrateLegacy(rows: AccountRecord[]): Promise<void> {
    const legacy = rows.filter((a) => a.mode === 'isolated');
    if (legacy.length === 0) return;
    try {
      await db.transaction('rw', db.accounts, async () => {
        for (const account of legacy) {
          const current = await db.accounts.get(account.id);
          if (current?.mode === 'isolated') await db.accounts.put(asEmbedded(current));
        }
      });
    } catch {
      // Read as embedded either way; the next list tries the rewrite again.
    }
  }

  function primaryRecord(realm: RealmInfo): AccountRecord {
    return {
      id: primaryAccountId(realm.id),
      realm: realm.id,
      label: MAIN_LABEL,
      color: ACCOUNT_COLORS[0],
      mode: 'embedded',
      primary: true,
      identity: null,
      signedIn: 'unknown',
      hasJar: false,
      order: 0,
      createdAt: nowIso(),
      lastActiveAt: null,
    };
  }

  /** Creates the primary account of each realm that lacks one; idempotent under concurrency. */
  async function ensurePrimaries(realms: RealmInfo[]): Promise<void> {
    if (realms.length === 0) return;
    const ids = realms.map((r) => primaryAccountId(r.id));
    const existing = await db.accounts.bulkGet(ids);
    if (existing.every(Boolean)) return;
    await db.transaction('rw', db.accounts, async () => {
      for (const realm of realms) {
        const id = primaryAccountId(realm.id);
        if (!(await db.accounts.get(id))) await db.accounts.add(primaryRecord(realm));
      }
    });
  }

  async function ensurePrimary(realm: RealmInfo): Promise<AccountRecord> {
    await ensurePrimaries([realm]);
    const primary = await db.accounts.get(primaryAccountId(realm.id));
    if (!primary) throw new Error('primary account missing');
    return primary;
  }

  /** An account by id; a switchable realm's primary account exists from first mention. */
  async function getAccount(id: unknown): Promise<AccountRecord | undefined> {
    if (typeof id !== 'string') return undefined;
    const stored = await db.accounts.get(id);
    const found = stored ? asEmbedded(stored) : undefined;
    if (found || !id.startsWith(primaryAccountId(''))) return found;
    const realm = realmById(id.slice(primaryAccountId('').length));
    return realm?.switchable && primaryAccountId(realm.id) === id ? ensurePrimary(realm) : undefined;
  }

  async function activeMap(): Promise<ActiveAccounts> {
    return readActiveMap((await db.kv.get(KV_KEYS.activeAccounts))?.value);
  }

  /** The stored choice when it still names an embedded account of the realm, else the primary. */
  function activeIdFor(realm: RealmInfo, accounts: AccountRecord[], map: ActiveAccounts): string {
    const chosen = map[realm.id];
    if (chosen && accounts.some((a) => a.id === chosen && a.mode === 'embedded')) return chosen;
    return primaryAccountId(realm.id);
  }

  /** Must run inside a transaction that includes db.kv. */
  async function setActiveInTx(realmId: string, accountId: string | null, at: string): Promise<void> {
    const map = readActiveMap((await db.kv.get(KV_KEYS.activeAccounts))?.value);
    if (accountId) map[realmId] = accountId;
    else delete map[realmId];
    await db.kv.put({ key: KV_KEYS.activeAccounts, value: map, updatedAt: at });
  }

  async function readJournal(): Promise<SwitchJournal | null> {
    return readJournalValue((await db.kv.get(KV_KEYS.switchJournal))?.value);
  }

  async function readPending(): Promise<PendingSignIn | null> {
    return readPendingValue((await db.kv.get(KV_KEYS.pendingSignIn))?.value);
  }

  async function newAccountId(): Promise<string> {
    for (;;) {
      const id = `acct_${env.randomHex(10)}`;
      if (!(await db.accounts.get(id))) return id;
    }
  }

  async function activeRecord(realm: RealmInfo): Promise<AccountRecord> {
    await ensurePrimary(realm);
    const accounts = await realmAccounts(realm.id);
    const id = activeIdFor(realm, accounts, await activeMap());
    const record = accounts.find((a) => a.id === id);
    if (!record) throw new Error('active account missing');
    return record;
  }

  async function listInternal(realmIds?: string[]): Promise<RealmAccounts[]> {
    const stored = await db.accounts.toArray();
    await migrateLegacy(stored);
    const all = stored.map(asEmbedded);
    const byRealm = new Map<string, AccountRecord[]>();
    for (const account of all) {
      const list = byRealm.get(account.realm) ?? [];
      list.push(account);
      byRealm.set(account.realm, list);
    }
    let realms: RealmInfo[];
    if (realmIds) {
      realms = [];
      for (const id of new Set(realmIds)) {
        const realm = typeof id === 'string' ? realmById(id) : null;
        if (realm && (realm.switchable || byRealm.has(realm.id))) realms.push(realm);
      }
    } else {
      realms = switchableRealms();
      for (const id of byRealm.keys()) {
        if (realms.some((r) => r.id === id)) continue;
        const realm = realmById(id);
        if (realm) realms.push(realm);
      }
    }
    const missing = realms.filter((r) => !(byRealm.get(r.id) ?? []).some((a) => a.id === primaryAccountId(r.id)));
    if (missing.length > 0) {
      await ensurePrimaries(missing);
      for (const realm of missing) byRealm.set(realm.id, await realmAccounts(realm.id));
    }
    const map = await activeMap();
    const pending = await readPending();
    return realms.map((realm) => {
      const accounts = (byRealm.get(realm.id) ?? []).slice().sort(byOrder);
      return {
        realm,
        accounts,
        activeAccountId: activeIdFor(realm, accounts, map),
        pendingSignIn: pending && pending.realm === realm.id ? pending : null,
      };
    });
  }

  async function changed(account: AccountRecord | null, switched: boolean): Promise<AccountsChangeResult> {
    return { ok: true, account, realms: await listInternal(), switched };
  }

  // -------------------------------------------------------------------------------------------
  // Cookies
  // -------------------------------------------------------------------------------------------

  /** Only the cookie domains host access covers count; with none, nothing can be switched. */
  async function hasRealmAccess(realm: RealmInfo): Promise<boolean> {
    for (const domain of realm.cookieDomains) {
      if (await env.hasHostAccess([`https://${domain}/*`])) return true;
    }
    return false;
  }

  async function readRealmCookies(realm: RealmInfo): Promise<StoredCookie[]> {
    const bySlot = new Map<string, StoredCookie>();
    for (const domain of realm.cookieDomains) {
      for (const cookie of await env.getCookies(domain)) {
        // The device's bot-check clearance is not part of anyone's login (see isDeviceCookie).
        if (isDeviceCookie(cookie)) continue;
        const slot = cookieSlot(cookie);
        if (!bySlot.has(slot)) bySlot.set(slot, cookie);
      }
    }
    return [...bySlot.values()];
  }

  /** Removes every cookie of the realm, reading again after each pass for ones set meanwhile. */
  async function clearRealmCookies(realm: RealmInfo, known?: StoredCookie[]): Promise<void> {
    let current = known ?? (await readRealmCookies(realm));
    for (let pass = 0; pass < CLEAR_PASSES && current.length > 0; pass++) {
      await Promise.all(current.map((cookie) => env.removeCookie(cookie)));
      current = await readRealmCookies(realm);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Switching (callers hold the realm chain and the shared switch chain)
  // -------------------------------------------------------------------------------------------

  /**
   * Second half of a switch, also used by recovery: clear, restore the target's jar if it has a
   * readable one, then make it active and forget its jar (`keepJar`: keep it, for a browser
   * sign-in that may be cancelled). Returns the refused cookie count.
   */
  async function finishSwitch(realm: RealmInfo, toId: string, known?: StoredCookie[], keepJar = false): Promise<number> {
    await clearRealmCookies(realm, known);
    const jar = await db.accountJars.get(toId);
    const cookies = jar ? await decryptJar(db, jar) : null;
    let refused = 0;
    if (cookies) {
      const results = await Promise.all(cookies.map((cookie) => env.setCookie(cookie).catch(() => false)));
      refused = results.filter((ok) => !ok).length;
    }
    const at = nowIso();
    await db.transaction('rw', db.accounts, db.accountJars, db.kv, async () => {
      await setActiveInTx(realm.id, toId, at);
      if (keepJar) {
        // The jar stays the account's sign-in until a finished browser sign-in replaces it.
        await db.accounts.update(toId, cookies ? { hasJar: true, lastActiveAt: at } : { hasJar: false, lastActiveAt: at, signedIn: 'no' });
      } else {
        await db.accountJars.delete(toId);
        // Without a jar the realm is now signed out for this account.
        await db.accounts.update(toId, cookies ? { hasJar: false, lastActiveAt: at } : { hasJar: false, lastActiveAt: at, signedIn: 'no' });
      }
      await db.kv.delete(KV_KEYS.switchJournal);
    });
    lastSwitchAt.set(realm.id, env.now().getTime());
    return refused;
  }

  /**
   * Full switch from `fromId` to `to`. `create` adds `to` in the same transaction as the journal,
   * so recovery always finds its target. `saveFrom` false drops the outgoing cookies (removal).
   */
  async function performSwitch(
    realm: RealmInfo,
    fromId: string | null,
    to: AccountRecord,
    options: { create: boolean; saveFrom: boolean; keepTargetJar?: boolean }
  ): Promise<number> {
    const outgoing = await readRealmCookies(realm);
    const sealed = fromId && options.saveFrom && outgoing.length > 0 ? await encryptJar(db, outgoing) : null;
    const at = nowIso();
    const journal: SwitchJournal = {
      realm: realm.id,
      fromAccountId: fromId,
      toAccountId: to.id,
      phase: 'saved',
      startedAt: at,
      ...(options.keepTargetJar ? { keepTargetJar: true as const } : {}),
    };
    await db.transaction('rw', db.accounts, db.accountJars, db.kv, async () => {
      if (options.create) await db.accounts.add(to);
      if (fromId && options.saveFrom) {
        if (sealed) {
          await db.accountJars.put({ accountId: fromId, iv: sealed.iv, data: sealed.data, cookieCount: sealed.cookieCount, savedAt: at });
          // Cookies without a sign-in among them (a visitor's) are kept, and say so.
          await db.accounts.update(fromId, looksSignedIn(outgoing, env.now().getTime(), isDeviceCookie) ? { hasJar: true } : { hasJar: true, signedIn: 'no' });
        } else {
          await db.accountJars.delete(fromId);
          await db.accounts.update(fromId, { hasJar: false, signedIn: 'no' });
        }
      }
      await db.kv.put({ key: KV_KEYS.switchJournal, value: journal, updatedAt: at });
    });
    return finishSwitch(realm, to.id, outgoing, options.keepTargetJar === true);
  }

  /** Finishes this realm's interrupted switch, if any. */
  async function finishPendingSwitch(realm: RealmInfo): Promise<void> {
    const journal = await readJournal();
    if (!journal || journal.realm !== realm.id) return;
    let target = await db.accounts.get(journal.toAccountId);
    const kept = Boolean(target && target.realm === realm.id && target.mode === 'embedded' && journal.keepTargetJar);
    if (!target || target.realm !== realm.id || target.mode !== 'embedded') target = await ensurePrimary(realm);
    await finishSwitch(realm, target.id, undefined, kept);
  }

  /**
   * Runs a cookie switch for `realm`, refusing while another realm's interrupted switch still
   * owns the journal. On failure after the journal was written, tries to finish the switch so
   * the realm is not left half cleared; if that fails too, recover() finishes it later.
   */
  async function guardedSwitch<T>(realm: RealmInfo, work: () => Promise<T | WorkspaceFailure>): Promise<T | WorkspaceFailure> {
    await finishPendingSwitch(realm);
    const pending = await readJournal();
    if (pending && pending.realm !== realm.id) {
      void service.recover();
      return fail('Another account switch is still finishing. Try again.', 'busy');
    }
    try {
      return await work();
    } catch {
      try {
        await finishPendingSwitch(realm);
      } catch {
        // Left for recover().
      }
      return fail(SWITCH_FAILED);
    }
  }

  /**
   * The live cookies already belong to `target` (the site said so): make it active without
   * touching cookies. `previous` keeps a jar it has, else gets `previousState`.
   */
  async function adoptLiveLogin(
    realm: RealmInfo,
    target: AccountRecord,
    previous: AccountRecord,
    identity: AccountIdentity,
    previousState: AccountRecord['signedIn'],
    create: boolean
  ): Promise<void> {
    const at = nowIso();
    await db.transaction('rw', db.accounts, db.accountJars, db.kv, async () => {
      if (create) await db.accounts.add(target);
      await setActiveInTx(realm.id, target.id, at);
      // Its saved jar is older than the login the browser holds now.
      await db.accountJars.delete(target.id);
      await db.accounts.update(target.id, { hasJar: false, signedIn: 'yes', identity, lastActiveAt: at });
      const previousJar = await db.accountJars.get(previous.id);
      // A copy kept while it was the browser account (snapshotBrowserAccount) is its sign-in now.
      if (previousJar) await db.accounts.update(previous.id, { hasJar: true });
      else await db.accounts.update(previous.id, { hasJar: false, signedIn: previousState });
    });
  }

  /** Full or empty: write `cookies` as the account's jar inside a transaction of its own. */
  async function storeJar(accountId: string, cookies: StoredCookie[]): Promise<void> {
    const kept = cookies.filter((c) => !isDeviceCookie(c));
    if (kept.length === 0) {
      await db.transaction('rw', db.accounts, db.accountJars, async () => {
        await db.accountJars.delete(accountId);
        if (await db.accounts.get(accountId)) await db.accounts.update(accountId, { hasJar: false, signedIn: 'no' });
      });
      return;
    }
    const sealed = await encryptJar(db, kept);
    const at = nowIso();
    const signedIn = looksSignedIn(kept, env.now().getTime(), isDeviceCookie);
    await db.transaction('rw', db.accounts, db.accountJars, async () => {
      const account = await db.accounts.get(accountId);
      // Removed meanwhile: its sign-in must not come back as an orphan jar.
      if (!account) return;
      await db.accountJars.put({ accountId, iv: sealed.iv, data: sealed.data, cookieCount: sealed.cookieCount, savedAt: at });
      const changes: Partial<AccountRecord> = { hasJar: true, lastActiveAt: at };
      if (!signedIn) changes.signedIn = 'no';
      else if (account.signedIn === 'no') changes.signedIn = 'unknown';
      await db.accounts.update(accountId, changes);
    });
  }

  /** The realm's pending browser sign-in, when it has one. */
  async function pendingFor(realmId: string): Promise<PendingSignIn | null> {
    const pending = await readPending();
    return pending && pending.realm === realmId ? pending : null;
  }

  /**
   * End a pending browser sign-in: make `returnTo` the browser account again. With `keep`, what
   * the browser holds is saved as the outgoing account's jar; without, it is dropped.
   */
  async function endPendingSignIn(keep: boolean): Promise<AccountsChangeResult | WorkspaceFailure> {
    const pending = await readPending();
    if (!pending) return fail('No sign-in is open.', 'not_allowed');
    const realm = realmById(pending.realm);
    if (!realm || !realm.switchable) {
      await db.kv.delete(KV_KEYS.pendingSignIn);
      return fail('This sign-in is not one Threadkeeper knows.', 'not_allowed');
    }
    return withSwitchLock(realm.id, () =>
      guardedSwitch(realm, async () => {
        const again = await readPending();
        if (!again || again.accountId !== pending.accountId) return fail('No sign-in is open.', 'not_allowed');
        const primary = await ensurePrimary(realm);
        const accounts = await realmAccounts(realm.id);
        const activeId = activeIdFor(realm, accounts, await activeMap());
        const returnTo = accounts.find((a) => a.id === pending.returnToAccountId) ?? primary;
        let switched = false;
        if (activeId !== returnTo.id) {
          if (!(await hasRealmAccess(realm))) return fail(`Allow Threadkeeper to access ${realm.label} first.`, 'needs_host_access');
          await performSwitch(realm, activeId, returnTo, { create: false, saveFrom: keep });
          // Cancelled: what the browser held is dropped, and a jar the account kept through the
          // sign-in (see beginBrowserSignIn) is its sign-in again.
          if (!keep) await db.accounts.update(activeId, { hasJar: Boolean(await db.accountJars.get(activeId)) });
          switched = true;
        }
        await db.kv.delete(KV_KEYS.pendingSignIn);
        return changed((await db.accounts.get(pending.accountId)) ?? null, switched);
      })
    );
  }

  // -------------------------------------------------------------------------------------------
  // Service
  // -------------------------------------------------------------------------------------------

  const service: AccountService = {
    async list(realmIds?: string[]): Promise<RealmAccounts[]> {
      return listInternal(realmIds);
    },

    async activeAccount(realmId: string): Promise<AccountRecord | null> {
      const realm = typeof realmId === 'string' ? realmById(realmId) : null;
      if (!realm) return null;
      if (!realm.switchable && (await db.accounts.where('realm').equals(realm.id).count()) === 0) return null;
      return activeRecord(realm);
    },

    async resolveForCapture(provider: ProviderId, bound: { accountId: string; workspaceId: string }): Promise<CaptureAccount> {
      const fallback: CaptureAccount = { accountId: bound.accountId, workspaceId: bound.workspaceId, account: null };
      try {
        const realm = realmForProvider(provider);
        if (!realm) return fallback;
        // Waits for a switch of this realm in progress, so a capture is filed after it settles.
        const account = await withLock(realm.id, () => service.activeAccount(realm.id));
        if (!account) return fallback;
        return { accountId: threadAccountId(account, bound.accountId), workspaceId: bound.workspaceId, account };
      } catch {
        return fallback;
      }
    },

    async add(input: AddAccountInput): Promise<AccountsChangeResult | WorkspaceFailure> {
      const realm = isRecord(input) && typeof input.realm === 'string' ? realmById(input.realm) : null;
      if (!realm) return fail('This sign-in is not one Threadkeeper knows.', 'not_allowed');
      const label = cleanLabel(input.label);
      const color = isColor(input.color) ? input.color : null;
      if (input.mode !== 'embedded' && input.mode !== 'isolated') return fail('Choose how this account is opened.', 'not_allowed');

      // An account brought over from Session Control keeps the id of the Chrome profile it
      // lived in, so importing the same list again does not add it twice.
      let profileId: string | undefined;
      if (input.profileId !== undefined) {
        if (typeof input.profileId !== 'string' || !UUID_RE.test(input.profileId.toLowerCase())) return fail('The profile id is not valid.', 'not_allowed');
        profileId = input.profileId.toLowerCase();
      }
      if (!realm.switchable) return fail(realm.fixedReason ?? 'Threadkeeper does not switch this sign-in.', 'not_switchable');
      // Showing the account later needs the realm's hosts; ask now, inside the click.
      if (!(await hasRealmAccess(realm))) return fail(`Allow Threadkeeper to access ${realm.label} first.`, 'needs_host_access');

      return withLock(realm.id, async () => {
        try {
          await ensurePrimary(realm);
          const accounts = await realmAccounts(realm.id);
          const record: AccountRecord = {
            id: await newAccountId(),
            realm: realm.id,
            label: label ?? nextAccountLabel(accounts),
            color: color ?? nextColor(accounts),
            mode: 'embedded',
            ...(profileId ? { profileId } : {}),
            primary: false,
            identity: null,
            signedIn: 'no',
            hasJar: false,
            order: nextOrder(accounts),
            createdAt: nowIso(),
            lastActiveAt: null,
          };
          await db.accounts.add(record);
          return changed(record, false);
        } catch {
          return fail(SAVE_FAILED);
        }
      });
    },

    async activate(accountId: string): Promise<AccountsSwitchResult | AccountsChangeResult | WorkspaceFailure> {
      const account = await getAccount(accountId);
      if (!account) return fail('That account no longer exists.', 'unknown_account');
      const realm = realmById(account.realm);
      if (!realm || !realm.switchable) return fail(realm?.fixedReason ?? 'Threadkeeper does not switch this sign-in.', 'not_switchable');

      return withSwitchLock(realm.id, () =>
        guardedSwitch<AccountsSwitchResult | AccountsChangeResult>(realm, async () => {
          const stored = await db.accounts.get(account.id);
          const target = stored ? asEmbedded(stored) : undefined;
          if (!target) return fail('That account no longer exists.', 'unknown_account');
          if (await pendingFor(realm.id)) return fail(SIGNIN_OPEN, 'signin_pending');
          await ensurePrimary(realm);
          const accounts = await realmAccounts(realm.id);
          const activeId = activeIdFor(realm, accounts, await activeMap());
          if (activeId === target.id) return changed(target, false);
          if (!(await hasRealmAccess(realm))) return fail(`Allow Threadkeeper to access ${realm.label} first.`, 'needs_host_access');
          const refusedCookies = await performSwitch(realm, activeId, target, { create: false, saveFrom: true });
          const result = await changed((await db.accounts.get(target.id)) ?? null, true);
          return { ...result, refusedCookies };
        })
      );
    },

    async update(accountId: string, patch: { label?: string; color?: AccountColor }): Promise<AccountsChangeResult | WorkspaceFailure> {
      const account = await getAccount(accountId);
      if (!account) return fail('That account no longer exists.', 'unknown_account');
      const changes: Partial<Pick<AccountRecord, 'label' | 'color'>> = {};
      if (isRecord(patch) && patch.label !== undefined) {
        const label = cleanLabel(patch.label);
        if (!label) return fail('Give the account a name.', 'not_allowed');
        changes.label = label;
      }
      if (isRecord(patch) && patch.color !== undefined) {
        if (!isColor(patch.color)) return fail('Choose one of the account colours.', 'not_allowed');
        changes.color = patch.color;
      }
      return withLock(account.realm, async () => {
        try {
          const updated = await db.accounts.update(account.id, changes);
          if (!updated && Object.keys(changes).length > 0 && !(await db.accounts.get(account.id))) {
            return fail('That account no longer exists.', 'unknown_account');
          }
          return changed((await db.accounts.get(account.id)) ?? null, false);
        } catch {
          return fail(SAVE_FAILED);
        }
      });
    },

    async remove(accountId: string): Promise<AccountsChangeResult | WorkspaceFailure> {
      const account = await getAccount(accountId);
      if (!account) return fail('That account no longer exists.', 'unknown_account');
      if (account.primary) return fail('The main account cannot be removed.', 'not_allowed');
      const realm = realmById(account.realm);

      const forget = async (): Promise<void> => {
        const at = nowIso();
        await db.transaction('rw', db.accounts, db.accountJars, db.kv, async () => {
          await db.accounts.delete(account.id);
          await db.accountJars.delete(account.id);
          const map = readActiveMap((await db.kv.get(KV_KEYS.activeAccounts))?.value);
          if (map[account.realm] === account.id) await setActiveInTx(account.realm, null, at);
        });
      };

      if (realm && (await pendingFor(realm.id))?.accountId === account.id) return fail(SIGNIN_OPEN, 'signin_pending');

      if (!realm || !realm.switchable) {
        return withLock(account.realm, async () => {
          try {
            await forget();
            return changed(null, false);
          } catch {
            return fail(SAVE_FAILED);
          }
        });
      }

      return withSwitchLock(realm.id, () =>
        guardedSwitch(realm, async () => {
          if (!(await db.accounts.get(account.id))) return fail('That account no longer exists.', 'unknown_account');
          const primary = await ensurePrimary(realm);
          const accounts = await realmAccounts(realm.id);
          let switched = false;
          if (activeIdFor(realm, accounts, await activeMap()) === account.id) {
            if (!(await hasRealmAccess(realm))) return fail(`Allow Threadkeeper to access ${realm.label} first.`, 'needs_host_access');
            // The removed account's cookies are dropped, not saved.
            await performSwitch(realm, account.id, primary, { create: false, saveFrom: false });
            switched = true;
          }
          await forget();
          return changed(null, switched);
        })
      );
    },

    async account(accountId: string): Promise<AccountRecord | null> {
      try {
        return (await getAccount(accountId)) ?? null;
      } catch {
        return null;
      }
    },

    async readJar(accountId: string): Promise<StoredCookie[] | null> {
      try {
        const account = await getAccount(accountId);
        if (!account) return null;
        const jar = await db.accountJars.get(account.id);
        return jar ? await decryptJar(db, jar) : null;
      } catch {
        return null;
      }
    },

    async writeJar(accountId: string, cookies: StoredCookie[]): Promise<void> {
      const account = await getAccount(accountId);
      if (!account) return;
      const realm = realmById(account.realm);
      if (!realm || !realm.switchable || !Array.isArray(cookies)) return;
      // After any switch of this realm in progress, so a jar is never written over one the
      // switch is about to restore from or delete.
      await withLock(realm.id, async () => {
        try {
          const accounts = await realmAccounts(realm.id);
          // The browser account's cookies are the browser's; a jar for it would only go stale.
          if (activeIdFor(realm, accounts, await activeMap()) === account.id) return;
          if ((await readJournal())?.realm === realm.id) return;
          await storeJar(account.id, cookies);
        } catch {
          // The next change of the jar is saved instead.
        }
      });
    },

    async deviceCookies(realmId: string): Promise<StoredCookie[]> {
      const realm = typeof realmId === 'string' ? realmById(realmId) : null;
      if (!realm) return [];
      const bySlot = new Map<string, StoredCookie>();
      try {
        for (const domain of realm.cookieDomains) {
          for (const cookie of await env.getCookies(domain)) {
            if (isDeviceCookie(cookie) && !bySlot.has(cookieSlot(cookie))) bySlot.set(cookieSlot(cookie), cookie);
          }
        }
      } catch {
        // Without them a profile page may be asked to pass the site's bot check once more.
      }
      return [...bySlot.values()];
    },

    async snapshotBrowserAccount(realmId: string): Promise<void> {
      const realm = typeof realmId === 'string' ? realmById(realmId) : null;
      if (!realm || !realm.switchable) return;
      await withSwitchLock(realm.id, async () => {
        try {
          if (await readJournal()) return;
          // During a browser sign-in the browser holds a sign-in in progress, and the account
          // signing in keeps its earlier saved sign-in until that ends: neither is replaced here.
          if (await pendingFor(realm.id)) return;
          if (!(await hasRealmAccess(realm))) return;
          await ensurePrimary(realm);
          const accounts = await realmAccounts(realm.id);
          const activeId = activeIdFor(realm, accounts, await activeMap());
          const cookies = await readRealmCookies(realm);
          // Only a sign-in is worth keeping; a visitor's cookies would replace a good copy.
          if (!looksSignedIn(cookies, env.now().getTime(), isDeviceCookie)) return;
          const sealed = await encryptJar(db, cookies);
          await db.accountJars.put({ accountId: activeId, iv: sealed.iv, data: sealed.data, cookieCount: sealed.cookieCount, savedAt: nowIso() });
          // `hasJar` stays false: while it is the browser account, its live cookies are its sign-in.
        } catch {
          // A missing copy only matters if the browser is later signed in as someone else.
        }
      });
    },

    async noteProfileIdentity(accountId: string, raw: Omit<AccountIdentity, 'observedAt'> | null): Promise<IdentityOutcome | null> {
      try {
        const found = await getAccount(accountId);
        if (!found) return null;
        const identity = raw === null ? null : cleanIdentity(raw, nowIso());
        if (raw !== null && !identity) return null;
        return await withLock(found.realm, async (): Promise<IdentityOutcome | null> => {
          const stored = await db.accounts.get(found.id);
          if (!stored) return null;
          const account = asEmbedded(stored);
          const base: IdentityOutcome = { realm: account.realm, activeAccountId: account.id, reassigned: false, updated: false };
          if (!identity) {
            if (account.signedIn === 'no') return base;
            await db.accounts.update(account.id, { signedIn: 'no' });
            return { ...base, updated: true };
          }
          const same = account.identity?.key === identity.key;
          const merged: AccountIdentity = same
            ? { ...identity, display: identity.display ?? account.identity!.display, detail: identity.detail ?? account.identity!.detail ?? null }
            : identity;
          const changes: Partial<AccountRecord> = { identity: merged, signedIn: 'yes' };
          if (merged.display && isDefaultLabel(account.label)) changes.label = merged.display.slice(0, MAX_LABEL);
          const updated =
            !same ||
            account.signedIn !== 'yes' ||
            merged.display !== account.identity?.display ||
            (merged.detail ?? null) !== (account.identity?.detail ?? null) ||
            changes.label !== undefined;
          await db.accounts.update(account.id, changes);
          return { ...base, updated };
        });
      } catch {
        return null;
      }
    },

    async beginBrowserSignIn(accountId: string): Promise<AccountsChangeResult | WorkspaceFailure> {
      const account = await getAccount(accountId);
      if (!account) return fail('That account no longer exists.', 'unknown_account');
      const realm = realmById(account.realm);
      if (!realm || !realm.switchable) return fail(realm?.fixedReason ?? 'Threadkeeper does not switch this sign-in.', 'not_switchable');

      return withSwitchLock(realm.id, () =>
        guardedSwitch(realm, async () => {
          const stored = await db.accounts.get(account.id);
          if (!stored) return fail('That account no longer exists.', 'unknown_account');
          const target = asEmbedded(stored);
          if (await readPending()) return fail(SIGNIN_OPEN, 'signin_pending');
          await ensurePrimary(realm);
          const accounts = await realmAccounts(realm.id);
          const activeId = activeIdFor(realm, accounts, await activeMap());
          if (activeId === target.id) return fail('This account is the one your browser is signed in to. Sign in on the site in any tab.', 'browser_account');
          if (!(await hasRealmAccess(realm))) return fail(`Allow Threadkeeper to access ${realm.label} first.`, 'needs_host_access');
          const pending: PendingSignIn = { realm: realm.id, accountId: target.id, returnToAccountId: activeId, startedAt: nowIso() };
          // Written first: if the worker stops after the switch, the page still offers to finish.
          await db.kv.put({ key: KV_KEYS.pendingSignIn, value: pending, updatedAt: pending.startedAt });
          try {
            // The account's saved sign-in goes into the browser but is kept: only a finished
            // sign-in replaces it, so cancelling leaves it as it was.
            await performSwitch(realm, activeId, target, { create: false, saveFrom: true, keepTargetJar: true });
          } catch (error) {
            // Nothing was cleared unless the journal was written; without it there is nothing to undo.
            if (!(await readJournal())) await db.kv.delete(KV_KEYS.pendingSignIn);
            throw error;
          }
          return changed((await db.accounts.get(target.id)) ?? null, true);
        })
      );
    },

    async finishBrowserSignIn(): Promise<AccountsChangeResult | WorkspaceFailure> {
      return endPendingSignIn(true);
    },

    async cancelBrowserSignIn(): Promise<AccountsChangeResult | WorkspaceFailure> {
      return endPendingSignIn(false);
    },

    async pendingSignIn(): Promise<PendingSignIn | null> {
      try {
        return await readPending();
      } catch {
        return null;
      }
    },

    async noteIdentity(provider: ProviderId, raw: Omit<AccountIdentity, 'observedAt'> | null): Promise<IdentityOutcome | null> {
      try {
        const realm = realmForProvider(provider);
        if (!realm || !realm.switchable) return null;
        const identity = raw === null ? null : cleanIdentity(raw, nowIso());
        if (raw !== null && !identity) return null;

        return await withLock(realm.id, async (): Promise<IdentityOutcome | null> => {
          try {
            const active = await activeRecord(realm);
            const base: IdentityOutcome = { realm: realm.id, activeAccountId: active.id, reassigned: false, updated: false };
            // A switch of this realm was interrupted; what the page saw may predate it.
            if ((await readJournal())?.realm === realm.id) return base;
            const settling = env.now().getTime() - (lastSwitchAt.get(realm.id) ?? -Infinity) < SWITCH_SETTLE_MS;

            if (!identity) {
              if (settling || active.signedIn === 'no') return base;
              await db.accounts.update(active.id, { signedIn: 'no' });
              return { ...base, updated: true };
            }

            if (active.identity?.key === identity.key) {
              const merged: AccountIdentity = {
                ...identity,
                display: identity.display ?? active.identity.display,
                detail: identity.detail ?? active.identity.detail ?? null,
              };
              const updated =
                active.signedIn !== 'yes' ||
                merged.display !== active.identity.display ||
                (merged.detail ?? null) !== (active.identity.detail ?? null);
              await db.accounts.update(active.id, { identity: merged, signedIn: 'yes' });
              return { ...base, updated, named: active.id };
            }

            if (settling) return base;

            const accounts = await realmAccounts(realm.id);
            const owner = accounts.find((a) => a.mode === 'embedded' && a.id !== active.id && a.identity?.key === identity.key);

            if (!active.identity) {
              if (owner) {
                await adoptLiveLogin(realm, owner, active, identity, 'unknown', false);
                return { realm: realm.id, activeAccountId: owner.id, reassigned: true, updated: true, named: owner.id };
              }
              const changes: Partial<AccountRecord> = { identity, signedIn: 'yes' };
              if (identity.display && isDefaultLabel(active.label)) changes.label = identity.display.slice(0, MAX_LABEL);
              await db.accounts.update(active.id, changes);
              return { ...base, updated: true, named: active.id };
            }

            // Signed in as someone else in this browser: file what follows under that person.
            if (owner) {
              await adoptLiveLogin(realm, owner, active, identity, 'no', false);
              return { realm: realm.id, activeAccountId: owner.id, reassigned: true, updated: true, named: owner.id };
            }
            const created: AccountRecord = {
              id: await newAccountId(),
              realm: realm.id,
              label: identity.display ? identity.display.slice(0, MAX_LABEL) : nextAccountLabel(accounts),
              color: nextColor(accounts),
              mode: 'embedded',
              primary: false,
              identity,
              signedIn: 'yes',
              hasJar: false,
              order: nextOrder(accounts),
              createdAt: nowIso(),
              lastActiveAt: null,
            };
            await adoptLiveLogin(realm, created, active, identity, 'no', true);
            return { realm: realm.id, activeAccountId: created.id, reassigned: true, updated: true, named: created.id };
          } catch {
            return null;
          }
        });
      } catch {
        return null;
      }
    },

    async recover(): Promise<void> {
      try {
        const journal = await readJournal();
        if (!journal) {
          // A row that is not a readable journal cannot be finished; drop it.
          if (await db.kv.get(KV_KEYS.switchJournal)) await db.kv.delete(KV_KEYS.switchJournal);
          return;
        }
        const realm = realmById(journal.realm);
        if (!realm || !realm.switchable) {
          await db.kv.delete(KV_KEYS.switchJournal);
          return;
        }
        await withSwitchLock(realm.id, () => finishPendingSwitch(realm));
      } catch {
        // The journal stays; the next start tries again.
      }
    },
  };

  return service;
}
