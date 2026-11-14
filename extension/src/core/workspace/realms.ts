// Login realms: which providers share one sign-in, which cookies carry it, and whether
// Threadkeeper may swap those cookies to switch accounts.
//
// A realm is one cookie jar from the browser's point of view. Claude and Claude Code are one
// realm (both live on claude.ai); ChatGPT, Codex and dots are another. One Chrome profile holds
// exactly one set of cookies per realm, so only one account of a realm is signed in at a time;
// switching means saving the current cookies and restoring another account's (accounts/switcher).
//
// Realms that share their sign-in with a whole ecosystem (Google, GitHub, Microsoft) are never
// switched: swapping those cookies would sign the person out of mail, repositories and
// documents in every other tab. They keep the browser's own login and the site's own switcher.
//
// Pure data and helpers: no chrome API, safe to import from pages, the worker and tests.
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from '../providers.js';

export interface RealmInfo {
  id: string;
  /** Name of the sign-in as a person knows it: "Claude", "ChatGPT", "X". */
  label: string;
  providers: ProviderId[];
  /**
   * Cookie domains that make up the login, as passed to chrome.cookies.getAll({ domain }).
   * A domain covers its subdomains. Listed narrowest-useful: never an identity provider's domain.
   */
  cookieDomains: string[];
  /**
   * Origin patterns Threadkeeper needs for cookie access and embedding beyond the providers'
   * own match patterns (sign-in hosts on another domain). Requested when an account is added.
   */
  extraHostPatterns: string[];
  /** Whether Threadkeeper may swap this realm's cookies to switch accounts. */
  switchable: boolean;
  /** Shown instead of the account switcher when `switchable` is false. */
  fixedReason?: string;
  /** Where a new account signs in. */
  signInUrl: string;
  /** Where "new tab" lands for this realm when no provider is chosen. */
  homeUrl: string;
}

const ECOSYSTEM_REASON =
  'This sign-in is shared with the rest of your account on that service, so Threadkeeper leaves it alone. Use the site’s own account switcher.';

type RealmSeed = Omit<RealmInfo, 'extraHostPatterns' | 'switchable'> &
  Partial<Pick<RealmInfo, 'extraHostPatterns' | 'switchable'>>;

function realm(seed: RealmSeed): RealmInfo {
  return { extraHostPatterns: [], switchable: true, ...seed };
}

/** Realms with more than one provider, or with cookies beyond the provider's own hosts. */
const NAMED_REALMS: RealmInfo[] = [
  realm({
    id: 'anthropic',
    label: 'Claude',
    providers: ['claude', 'claude_code', 'claude_duet'],
    cookieDomains: ['claude.ai'],
    signInUrl: 'https://claude.ai/login',
    homeUrl: 'https://claude.ai/new',
  }),
  realm({
    id: 'openai',
    label: 'ChatGPT',
    providers: ['chatgpt', 'codex', 'chatgpt_dots'],
    cookieDomains: ['chatgpt.com', 'chat.openai.com', 'auth.openai.com'],
    extraHostPatterns: ['https://auth.openai.com/*'],
    signInUrl: 'https://chatgpt.com/auth/login',
    homeUrl: 'https://chatgpt.com/',
  }),
  realm({
    id: 'xai',
    label: 'Grok',
    providers: ['grok'],
    cookieDomains: ['grok.com', 'accounts.x.ai'],
    extraHostPatterns: ['https://accounts.x.ai/*'],
    signInUrl: 'https://grok.com/',
    homeUrl: 'https://grok.com/',
  }),
  realm({
    id: 'x',
    label: 'X',
    providers: ['grok_x', 'grok_bot'],
    cookieDomains: ['x.com', 'twitter.com'],
    signInUrl: 'https://x.com/i/flow/login',
    homeUrl: 'https://x.com/i/grok',
  }),
  realm({
    id: 'cursor',
    label: 'Cursor',
    providers: ['cursor_agents'],
    cookieDomains: ['cursor.com', 'authenticator.cursor.sh'],
    extraHostPatterns: ['https://authenticator.cursor.sh/*'],
    signInUrl: 'https://cursor.com/agents',
    homeUrl: 'https://cursor.com/agents',
  }),
  realm({
    id: 'meta',
    label: 'Meta AI',
    providers: ['muse', 'meta_ai'],
    cookieDomains: ['muse.ai', 'meta.ai'],
    signInUrl: 'https://muse.ai/',
    homeUrl: 'https://muse.ai/',
  }),
  realm({
    id: 'google',
    label: 'Google',
    providers: ['gemini', 'ai_studio', 'gemini_notebook', 'jules'],
    cookieDomains: [],
    switchable: false,
    fixedReason: ECOSYSTEM_REASON,
    signInUrl: 'https://gemini.google.com/app',
    homeUrl: 'https://gemini.google.com/app',
  }),
  realm({
    id: 'github',
    label: 'GitHub',
    providers: ['github_copilot'],
    cookieDomains: [],
    switchable: false,
    fixedReason: ECOSYSTEM_REASON,
    signInUrl: 'https://github.com/copilot',
    homeUrl: 'https://github.com/copilot',
  }),
  realm({
    id: 'microsoft',
    label: 'Microsoft',
    providers: ['copilot'],
    cookieDomains: [],
    switchable: false,
    fixedReason: ECOSYSTEM_REASON,
    signInUrl: 'https://copilot.microsoft.com/',
    homeUrl: 'https://copilot.microsoft.com/',
  }),
];

const REALM_BY_PROVIDER = new Map<ProviderId, RealmInfo>();
for (const info of NAMED_REALMS) for (const provider of info.providers) REALM_BY_PROVIDER.set(provider, info);

/** `https://www.example.com/*` → `www.example.com`; null for patterns without a plain host. */
function hostOfPattern(pattern: string): string | null {
  const m = pattern.match(/^https?:\/\/([^/*]+)\/\*$/);
  return m ? m[1] : null;
}

/**
 * Every other web provider is its own realm. Those are not switched yet: each needs its cookie
 * domains checked against the live site first, and a wrong list signs the person out for nothing.
 */
function soloRealm(provider: ProviderId): RealmInfo {
  const info = PROVIDERS[provider];
  const hosts = info.matchPatterns.map(hostOfPattern).filter((h): h is string => h !== null);
  const home = hosts[0] ? `https://${hosts[0]}/` : '';
  return {
    id: `site.${provider}`,
    label: info.label,
    providers: [provider],
    cookieDomains: [],
    extraHostPatterns: [],
    switchable: false,
    fixedReason: 'Threadkeeper uses the account this browser is signed in to on this site.',
    signInUrl: home,
    homeUrl: home,
  };
}

const SOLO_CACHE = new Map<ProviderId, RealmInfo>();

/** The realm a provider signs in through. Providers never captured from a page have none. */
export function realmForProvider(provider: ProviderId): RealmInfo | null {
  const named = REALM_BY_PROVIDER.get(provider);
  if (named) return named;
  const info = PROVIDERS[provider];
  if (info.hostAccess === 'none' || info.hostAccess === 'custom') return null;
  let solo = SOLO_CACHE.get(provider);
  if (!solo) {
    solo = soloRealm(provider);
    SOLO_CACHE.set(provider, solo);
  }
  return solo;
}

export function realmById(id: string): RealmInfo | null {
  const named = NAMED_REALMS.find((r) => r.id === id);
  if (named) return named;
  if (id.startsWith('site.')) {
    const provider = id.slice('site.'.length) as ProviderId;
    return PROVIDER_IDS.includes(provider) ? realmForProvider(provider) : null;
  }
  return null;
}

/** Realms whose accounts Threadkeeper can switch, in display order. */
export function switchableRealms(): RealmInfo[] {
  return NAMED_REALMS.filter((r) => r.switchable);
}

export function allNamedRealms(): RealmInfo[] {
  return NAMED_REALMS.slice();
}

/** Whether `host` belongs to one of the realm's cookie domains (exact or a subdomain). */
export function realmOwnsHost(info: RealmInfo, host: string): boolean {
  const h = host.toLowerCase();
  return info.cookieDomains.some((d) => h === d || h.endsWith(`.${d}`));
}

/**
 * Id of the account that stands for the browser's own login in a realm. Account ids never
 * contain ':' (the thread-key separator), and neither do realm ids.
 */
export function primaryAccountId(realmId: string): string {
  return `primary~${realmId}`;
}
