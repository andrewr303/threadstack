// Profiles: showing an account that is not the browser's own sign-in inside a workspace page.
// Ties together the account service (who the accounts are, their saved jars), the profile slots
// (which account each workspace tab shows for a realm, and which frames are profile frames) and
// the live jars (the worker's copy of each shown account's cookies).
//
// Everything a frame is attributed to comes from chrome's own description of the sender or the
// request (tab id, frame id, address) and from what the frame's content script said about its
// own document. Nothing a page says decides which account something belongs to.
import type { AccountService } from '../accounts/contract.js';
import { isDeviceCookie } from '../accounts/cookies.js';
import type { ProfileJars } from '../accounts/profile-jars.js';
import { bareDomain, looksSignedIn } from '../accounts/set-cookie.js';
import { realmById, realmOwnsHost, switchableRealms, type RealmInfo } from '../workspace/realms.js';
import type { AccountRecord, ProfileClaimResult, WorkspaceFailure } from '../workspace/types.js';
import { buildSeedPlan, siteOfHost } from './profile-seed.js';
import type { ProfileSlots } from './profile-slots.js';

export interface ProfilesDeps {
  /** Null when the account service could not be created. */
  accounts: () => AccountService | null;
  slots: ProfileSlots;
  jars: ProfileJars;
  /** Whether host access covers every origin pattern in the list. */
  hasHostAccess(patterns: string[]): Promise<boolean>;
  now(): number;
  randomHex(length: number): string;
  /** This extension's own origin (`chrome-extension://<id>`): requests it starts count as the page's own. */
  ownOrigin?: string;
}

/** What the worker is told about one response to a request of a workspace tab. */
export interface ObservedResponse {
  tabId: number;
  frameId: number;
  parentFrameId?: number;
  url: string;
  setCookies: string[];
  /** The origin that started the request (chrome's `initiator`); absent when the browser did. */
  initiator?: string;
  /** chrome's resource type: `sub_frame` is a navigation of the frame itself. */
  type?: string;
}

/** `https://claude.ai` for any https address on claude.ai or a subdomain of it; null otherwise. */
function schemefulSite(address: string): string | null {
  try {
    const parsed = new URL(address);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return `${parsed.protocol}//${siteOfHost(parsed.hostname)}`;
  } catch {
    return null;
  }
}

/**
 * Whether the browser treats a request as same-site for the cookies its response sets: started
 * by the browser itself, by this extension's page, or by a page of the same site (scheme
 * included). A page of another site inside a profile frame is not.
 */
export function sameSiteRequest(response: Pick<ObservedResponse, 'url' | 'initiator'>, ownOrigin?: string): boolean {
  const { initiator } = response;
  if (initiator === undefined) return true;
  if (ownOrigin && initiator === ownOrigin) return true;
  const from = schemefulSite(initiator);
  return from !== null && from === schemefulSite(response.url);
}

/**
 * Whether every cookie of a response is kept, or only SameSite=None ones. Kept whole:
 * - a navigation of the frame itself (`sub_frame`): the browser judges those by the frame's
 *   ancestors, and a sign-in that passes through the provider's other site (auth.openai.com
 *   back to chatgpt.com, accounts.x.ai back to grok.com) ends with one;
 * - a request a same-site page, this extension, or a page of the same sign-in started.
 * Otherwise a page of another site made the request inside a profile frame (a link followed
 * there): the browser keeps only SameSite=None cookies of it, and so does the saved sign-in.
 */
export function keepsAllCookies(response: Pick<ObservedResponse, 'url' | 'initiator' | 'type'>, ownOrigin?: string): boolean {
  if (response.type === 'sub_frame') return true;
  if (sameSiteRequest(response, ownOrigin)) return true;
  const realm = realmOfHost(hostOf(response.url));
  const from = response.initiator ? hostOf(response.initiator) : null;
  return Boolean(realm && from && realmOwnsHost(realm, from) && response.initiator?.startsWith('https:'));
}

/** Whether a Set-Cookie header asks for `SameSite=None`: the only kind a cross-site request may set. */
export function setsSameSiteNone(header: string): boolean {
  return header
    .split(';')
    .slice(1)
    .some((part) => {
      const [name, ...rest] = part.split('=');
      return name.trim().toLowerCase() === 'samesite' && rest.join('=').trim().toLowerCase() === 'none';
    });
}

export type FrameAccount =
  /** An ordinary frame: the realm's browser account, as for any tab. */
  | { kind: 'plain' }
  /** A profile frame; `account` is null when its slot is not ready (nothing may be filed). */
  | { kind: 'profile'; account: AccountRecord | null };

const UNAVAILABLE: WorkspaceFailure = { ok: false, error: 'Accounts are not available right now. Reload Threadkeeper and try again.' };

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}

/** The switchable realm a host belongs to, or null. */
export function realmOfHost(host: string | null): RealmInfo | null {
  return host ? (switchableRealms().find((r) => realmOwnsHost(r, host)) ?? null) : null;
}

export class Profiles {
  constructor(private readonly deps: ProfilesDeps) {}

  /** PROFILE_CLAIM: show `accountId` in the tab's slot of `realmId`. */
  async claim(tabId: number, realmId: string, accountId: string): Promise<ProfileClaimResult | WorkspaceFailure> {
    const accounts = this.deps.accounts();
    if (!accounts) return UNAVAILABLE;
    const realm = realmById(realmId);
    if (!realm || !realm.switchable) return { ok: false, error: realm?.fixedReason ?? 'Threadkeeper does not keep accounts for this sign-in.', code: 'not_switchable' };
    const account = await accounts.account(accountId);
    if (!account || account.realm !== realm.id) return { ok: false, error: 'That account no longer exists.', code: 'unknown_account' };
    const [entry] = await accounts.list([realm.id]);
    if (!entry) return UNAVAILABLE;
    if (entry.activeAccountId === account.id) {
      return { ok: false, error: 'This account is the one your browser is signed in to.', code: 'browser_account' };
    }
    const reachable = await this.deps.hasHostAccess(realm.cookieDomains.slice(0, 1).map((d) => `https://${d}/*`));
    if (!reachable) return { ok: false, error: `Allow Threadkeeper to access ${realm.label} first.`, code: 'needs_host_access' };

    // A sign-in popup opened from a profile page lands in the browser's own cookies. With a copy
    // kept now, the browser account's sign-in survives being replaced that way.
    void accounts.snapshotBrowserAccount(realm.id).catch(() => undefined);

    const cookies = await this.deps.jars.cookies(account.id);
    const deviceCookies = (await accounts.deviceCookies(realm.id)).filter(isDeviceCookie);
    const hosts = new Set([...cookies, ...deviceCookies].map((c) => bareDomain(c)));
    const allowed = new Set<string>();
    for (const host of hosts) {
      if (realmOwnsHost(realm, host) && (await this.deps.hasHostAccess([`https://${host}/*`]))) allowed.add(host);
    }
    const now = this.deps.now();
    const plan = buildSeedPlan({ cookies, deviceCookies, hostAllowed: (host) => allowed.has(host), nonce: this.deps.randomHex(24), nowMs: now });
    const claimed = await this.deps.slots.claim(tabId, realm.id, account.id, plan);
    if (!claimed.ok) return claimed;
    return {
      ok: true,
      realm: realm.id,
      accountId: account.id,
      steps: claimed.steps,
      signedIn: looksSignedIn(cookies, now, isDeviceCookie),
      truncated: plan.truncated,
    };
  }

  /** PROFILE_READY: the page loaded the seeding addresses. */
  markReady(tabId: number, realmId: string): Promise<{ ok: true } | WorkspaceFailure> {
    return this.deps.slots.markReady(tabId, realmId);
  }

  private async file(tabId: number, url: string, headers: readonly string[]): Promise<void> {
    const realm = realmOfHost(hostOf(url));
    if (!realm) return;
    const accountId = this.deps.slots.accountFor(tabId, realm.id);
    if (!accountId) return;
    await this.deps.jars.applyResponse(accountId, headers, url);
  }

  /** A response to a request of a workspace tab that carried `Set-Cookie` (or a seeding address). */
  async onResponse(response: ObservedResponse): Promise<void> {
    await this.deps.slots.ready();
    if (this.deps.slots.noteSeedResponse(response.tabId, response.url)) return;
    if (response.setCookies.length === 0 || response.frameId <= 0) return;
    if (!realmOfHost(hostOf(response.url))) return;
    // A page of another site in a profile frame (a link followed there) can send requests to the
    // realm, as in a forced sign-in. The browser keeps only SameSite=None cookies of such a
    // response; the saved sign-in must not keep more than the browser does.
    const headers = keepsAllCookies(response, this.deps.ownOrigin) ? response.setCookies : response.setCookies.filter(setsSameSiteNone);
    if (headers.length === 0) return;
    const kind = this.deps.slots.kindOf(response.tabId, response.frameId, response.parentFrameId);
    if (kind === 'plain') return;
    if (kind === 'unknown') {
      this.deps.slots.hold(response.tabId, { frameId: response.frameId, url: response.url, headers });
      return;
    }
    await this.file(response.tabId, response.url, headers);
  }

  /** A frame's content script said what its document is (`profile`: credentialless). */
  async frameSeen(tabId: number, frameId: number, profile: boolean): Promise<void> {
    await this.deps.slots.ready();
    const held = this.deps.slots.frameSeen(tabId, frameId, profile);
    for (const response of held) await this.file(tabId, response.url, response.headers);
  }

  /**
   * Whose pages a frame of a workspace tab shows. An unknown frame counts as ordinary only when
   * the caller knows it is not credentialless (`profileHint` false); with no hint it is treated
   * as a profile frame without an account, so nothing is filed for it.
   */
  async accountOfFrame(tabId: number, frameId: number, url: string, profileHint?: boolean): Promise<FrameAccount> {
    await this.deps.slots.ready();
    let kind = this.deps.slots.kindOf(tabId, frameId);
    if (kind === 'unknown' && typeof profileHint === 'boolean') {
      await this.frameSeen(tabId, frameId, profileHint);
      kind = profileHint ? 'profile' : 'plain';
    }
    if (kind === 'plain') return { kind: 'plain' };
    // Nobody has said what this frame is: it gets no account at all.
    if (kind === 'unknown') return { kind: 'profile', account: null };
    const realm = realmOfHost(hostOf(url));
    const accountId = realm ? this.deps.slots.accountFor(tabId, realm.id) : null;
    const account = accountId ? ((await this.deps.accounts()?.account(accountId)) ?? null) : null;
    return { kind: 'profile', account };
  }

  /** Save what the account's live copy holds now, before its saved jar is used elsewhere. */
  flush(accountId: string): Promise<void> {
    return this.deps.jars.flush(accountId);
  }

  /**
   * The account's saved jar was replaced or removed behind the live copy (it became the browser's
   * sign-in, came back from it, or the account was removed). The live copy is dropped and every
   * slot showing the account is retired: its partition holds the old cookies, so nothing of it is
   * filed any more. Answers the slots retired.
   */
  accountReplaced(accountId: string): Promise<Array<{ tabId: number; realmId: string }>> {
    this.deps.jars.forget(accountId);
    return this.deps.slots.retire(accountId);
  }
}
