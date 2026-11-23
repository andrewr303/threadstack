// Putting a profile account's saved cookies into the workspace page's credentialless cookie
// partition ("seeding").
//
// chrome.cookies cannot reach that partition, but a response loaded in a credentialless frame
// can set cookies in it, HttpOnly ones included. So for each host the account has cookies on,
// the workspace page loads one small address of that host in a hidden credentialless frame while
// a declarativeNetRequest session rule, limited to that tab and that exact address, appends the
// account's cookies to the response as `Set-Cookie` headers. Measured in Chromium 153 and Edge
// 157 (docs/research/2026-11-13-embedded-profiles/spike): the cookies land in the partition, the
// browser's own jar is untouched, and the extension's own webRequest listener sees the response
// without the appended headers.
//
// The partition holds about 10 KB of cookies per site and evicts the oldest first (measured), so
// the cookies that carry the sign-in are written last and, when a jar is too large, the least
// important ones are left out.
//
// Pure: the chrome API is passed in where needed.
import { isDeviceCookie } from '../accounts/cookies.js';
import { bareDomain, cookiePairBytes, serializeSetCookie } from '../accounts/set-cookie.js';
import type { StoredCookie } from '../workspace/types.js';
import { EMBED_STRIPPED_HEADERS } from './rules.js';

/** Session rule ids this module owns (rules.ts owns 1000 to 1999). */
export const SEED_RULE_ID_MIN = 2000;
export const SEED_RULE_ID_MAX = 2999;

/** A small address every site answers; what it answers does not matter, only that it does. */
export const SEED_PATH = '/robots.txt';
export const SEED_PARAM = 'tk_profile_seed';

/**
 * Bytes of cookie names and values a profile may hold per site. The browser's own limit for a
 * partition is 10,240; staying under it leaves room for what the site sets while it loads.
 */
export const PARTITION_SITE_BUDGET_BYTES = 9_200;

/** The site (registrable domain) of a host: its last two labels, as in accounts/chrome-env.ts. */
export function siteOfHost(host: string): string {
  return host.toLowerCase().split('.').filter(Boolean).slice(-2).join('.');
}

export function seedUrl(host: string, nonce: string): string {
  return `https://${host}${SEED_PATH}?${SEED_PARAM}=${nonce}`;
}

/** The nonce of a seeding address, or null for any other address. */
export function seedNonceOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.pathname !== SEED_PATH) return null;
    const nonce = parsed.searchParams.get(SEED_PARAM);
    return nonce && /^[a-f0-9]{8,64}$/.test(nonce) ? nonce : null;
  } catch {
    return null;
  }
}

// Cookies of analytics and support widgets: the first to be left out of a jar that is too large.
const LOW_VALUE_RE =
  /^(?:_ga|_gid|_gat|_gcl|_fbp|_fbc|_hj|_clck|_clsk|_dd_s|_rdt_|_tt_|_uet|_pk_|_lr_|_sp_|__utm|__stripe_|ajs_|amp_|mp_|ph_|sp_|intercom-|optimizely|statsig|datadog|mixpanel|hubspot|__hs|_hp2_|sentry)/i;

/**
 * How much a cookie matters to a sign-in, lowest first: analytics, other script-visible cookies,
 * the device's bot-check, then everything scripts cannot read (which is where sign-ins live).
 */
export function seedPriority(cookie: Pick<StoredCookie, 'name' | 'httpOnly'>): 0 | 1 | 2 | 3 {
  if (isDeviceCookie(cookie)) return 2;
  if (cookie.httpOnly || /^__(?:Host|Secure)-/i.test(cookie.name)) return 3;
  return LOW_VALUE_RE.test(cookie.name) ? 0 : 1;
}

export interface SeedStep {
  host: string;
  url: string;
  /** `Set-Cookie` header values, least important first. */
  headers: string[];
}

export interface SeedPlan {
  steps: SeedStep[];
  /** Cookies on hosts that are not the realm's or that Threadkeeper may not reach. */
  skipped: number;
  /** Cookies left out because the site's share of the partition was full. */
  dropped: number;
  /** A cookie that carries a sign-in was among those left out. */
  truncated: boolean;
}

export interface SeedPlanInput {
  /** The account's saved cookies (never the device's bot-check ones). */
  cookies: readonly StoredCookie[];
  /** The browser's bot-check cookies for the realm, shared by every profile. */
  deviceCookies: readonly StoredCookie[];
  /** Whether a host belongs to the realm and Threadkeeper holds access to it. */
  hostAllowed: (host: string) => boolean;
  nonce: string;
  nowMs: number;
}

export function buildSeedPlan(input: SeedPlanInput): SeedPlan {
  let skipped = 0;
  const seen = new Set<string>();
  const candidates: Array<{ cookie: StoredCookie; host: string; header: string; priority: number; order: number }> = [];
  // The account's own cookies win over a device cookie in the same slot.
  for (const cookie of [...input.cookies, ...input.deviceCookies]) {
    const slot = JSON.stringify([cookie.name, cookie.domain, cookie.path]);
    if (seen.has(slot)) continue;
    seen.add(slot);
    const host = bareDomain(cookie);
    const header = serializeSetCookie(cookie, input.nowMs);
    // Expired, or not something a header can carry: there is nothing to put back.
    if (!header) continue;
    if (!host || !input.hostAllowed(host)) {
      skipped += 1;
      continue;
    }
    candidates.push({ cookie, host, header, priority: seedPriority(cookie), order: candidates.length });
  }

  // Per site, keep the most important cookies that fit.
  let dropped = 0;
  let truncated = false;
  const kept = new Set<number>();
  const bySite = new Map<string, typeof candidates>();
  for (const c of candidates) {
    const site = siteOfHost(c.host);
    const list = bySite.get(site);
    if (list) list.push(c);
    else bySite.set(site, [c]);
  }
  for (const list of bySite.values()) {
    let used = 0;
    for (const c of [...list].sort((a, b) => b.priority - a.priority || a.order - b.order)) {
      const size = cookiePairBytes(c.cookie);
      if (used + size > PARTITION_SITE_BUDGET_BYTES) {
        dropped += 1;
        if (c.priority === 3) truncated = true;
        continue;
      }
      used += size;
      kept.add(c.order);
    }
  }

  const byHost = new Map<string, typeof candidates>();
  for (const c of candidates) {
    if (!kept.has(c.order)) continue;
    const list = byHost.get(c.host);
    if (list) list.push(c);
    else byHost.set(c.host, [c]);
  }
  const steps: SeedStep[] = [...byHost.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([host, list]) => ({
      host,
      url: seedUrl(host, input.nonce),
      // Least important first: the browser evicts the oldest cookies of a full partition first.
      headers: [...list].sort((a, b) => a.priority - b.priority || a.order - b.order).map((c) => c.header),
    }));
  return { steps, skipped, dropped, truncated };
}

export interface SeedRule {
  id: number;
  priority: 3;
  action: {
    type: 'modifyHeaders';
    responseHeaders: Array<{ header: string; operation: 'append'; value: string } | { header: string; operation: 'remove' }>;
  };
  condition: { tabIds: number[]; urlFilter: string; resourceTypes: ['sub_frame'] };
}

/**
 * The rule that appends one step's cookies to the response of its address, in one tab. It also
 * removes the headers that refuse framing, so the answer loads in the hidden frame at all.
 */
export function seedRule(id: number, tabId: number, step: SeedStep): SeedRule {
  return {
    id,
    priority: 3,
    action: {
      type: 'modifyHeaders',
      responseHeaders: [
        ...step.headers.map((value) => ({ header: 'set-cookie', operation: 'append' as const, value })),
        ...EMBED_STRIPPED_HEADERS.map((header) => ({ header, operation: 'remove' as const })),
      ],
    },
    // `|` anchors both ends: this address and nothing else.
    condition: { tabIds: [tabId], urlFilter: `|${step.url}|`, resourceTypes: ['sub_frame'] },
  };
}

export function isSeedRuleId(id: number): boolean {
  return Number.isInteger(id) && id >= SEED_RULE_ID_MIN && id <= SEED_RULE_ID_MAX;
}

/** `count` free ids in the owned range, or null when the range cannot hold them. */
export function allocateSeedRuleIds(taken: Iterable<number>, count: number): number[] | null {
  const used = new Set(taken);
  const ids: number[] = [];
  for (let id = SEED_RULE_ID_MIN; id <= SEED_RULE_ID_MAX && ids.length < count; id++) {
    if (!used.has(id)) ids.push(id);
  }
  return ids.length === count ? ids : null;
}
