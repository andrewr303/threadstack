// Capture on sites Threadkeeper does not hold from install: optional providers (host access asked
// for from the Settings toggle) and "any AI site" origins the user adds (self-hosted Open WebUI,
// LibreChat, LobeChat, AnythingLLM, or anything else).
//
// The list of added sites lives in chrome.storage.local under CUSTOM_SITES_KEY. It is the source
// of truth: the background reconciles registered content scripts against it (and against the
// host permissions actually held) on install, startup, permission changes and every edit.
//
// Everything above the "Chrome glue" line is pure and unit-tested; the glue takes the chrome
// APIs as arguments so it can be tested with fakes.

import {
  CAPTURE_PROVIDER_IDS,
  PROVIDERS,
  detectProviderFromUrl,
  runtimeMatchPatterns,
  toOriginMatchPatterns,
  type CaptureProviderId,
} from './providers.js';

export const CUSTOM_SITES_KEY = 'tk.captureSites.v1';
export const MAX_CUSTOM_SITES = 50;
const SITE_SCRIPT_PREFIX = 'tk-site-';
const PROVIDER_SCRIPT_PREFIX = 'tk-provider-';
export const CONTENT_SCRIPT_FILE = 'content-scripts/content.js';
/** Workspace embedding: cookie bridge and frame reporting (isolated world, document_start). */
export const EMBED_BRIDGE_FILE = 'content-scripts/embed-bridge.js';
/** Workspace embedding: page-world side of the cookie bridge (MAIN world, document_start). */
export const EMBED_COOKIE_MAIN_FILE = 'content-scripts/embed-cookie-main.js';

export interface CustomSite {
  /** Exact origin, e.g. https://chat.example.com or http://localhost:3000. */
  origin: string;
  /** What the user calls it (defaults to the host). */
  label: string;
  addedAt: string;
  enabled: boolean;
}

export interface CustomSitesState {
  version: 1;
  sites: CustomSite[];
}

export const EMPTY_CUSTOM_SITES: CustomSitesState = { version: 1, sites: [] };

/** 32-bit FNV-1a over UTF-16 code units, as 8 hex chars. Stable ids, not security. */
export function fnv1a32Hex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

const PRIVATE_HOST_RE =
  /^(localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|\[::1\]|[a-z0-9-]+\.(?:local|lan|internal|home\.arpa))$/i;

/** Plain-http origins are allowed only for local and private-network hosts (self-hosted apps). */
export function isPrivateHost(hostname: string): boolean {
  return PRIVATE_HOST_RE.test(hostname);
}

export type OriginCheck = { ok: true; origin: string; host: string } | { ok: false; error: string };

/**
 * Turn what the user typed (a URL, an origin or a bare host) into an exact origin, or a calm
 * error that says what to do instead.
 */
export function normalizeSiteOrigin(input: string): OriginCheck {
  const raw = input.trim();
  if (!raw) return { ok: false, error: 'Type the address of the AI site, for example https://chat.example.com.' };
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `${isPrivateHost(raw.split(/[/:]/)[0]) ? 'http' : 'https'}://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return { ok: false, error: 'That does not look like a web address.' };
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, error: 'Only web pages (https://) can be captured.' };
  }
  if (!url.hostname || url.username || url.password) {
    return { ok: false, error: 'That does not look like a web address.' };
  }
  if (url.protocol === 'http:' && !isPrivateHost(url.hostname)) {
    return { ok: false, error: 'Use the https:// address. Plain http is allowed only for sites on this computer or your local network.' };
  }
  const known = detectProviderFromUrl(url.href) ?? providerOwningHost(url.hostname);
  if (known && PROVIDERS[known].hostAccess !== 'custom') {
    return { ok: false, error: `${PROVIDERS[known].label} is already supported. Turn it on in the list above.` };
  }
  return { ok: true, origin: url.origin, host: url.host };
}

/**
 * A provider whose pages live on this host, even when its root page is not one of them
 * (github.com/copilot, x.com/i/grok, huggingface.co/chat…). Adding such a host as a site would
 * capture the whole host and share its host access with that provider's toggle.
 */
function providerOwningHost(hostname: string): CaptureProviderId | null {
  const host = hostname.toLowerCase();
  for (const id of CAPTURE_PROVIDER_IDS) {
    if (PROVIDERS[id].hostAccess === 'custom') continue;
    for (const pattern of toOriginMatchPatterns(PROVIDERS[id].matchPatterns)) {
      const m = pattern.match(/^[^:]+:\/\/([^/]+)\//);
      const h = m?.[1];
      if (!h) continue;
      if (h === host || (h.startsWith('*.') && (host === h.slice(2) || host.endsWith(h.slice(1))))) return id;
    }
  }
  return null;
}

/** Match pattern for an origin. Chrome patterns cannot name a port, so they cover every port of the host. */
export function originMatchPattern(origin: string): string {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
}

/** The prefix that keeps conversation ids from different added sites apart: host and port. */
export function siteConversationKey(origin: string): string {
  try {
    const url = new URL(origin);
    return `${url.hostname}${url.port ? `-${url.port}` : ''}`.toLowerCase().replace(/[^a-z0-9.-]/g, '-');
  } catch {
    return 'site';
  }
}

export function siteScriptId(origin: string): string {
  return `${SITE_SCRIPT_PREFIX}${fnv1a32Hex(origin)}`;
}

export function providerScriptId(id: CaptureProviderId): string {
  return `${PROVIDER_SCRIPT_PREFIX}${id}`;
}

export function isManagedScriptId(id: string): boolean {
  return id.startsWith(SITE_SCRIPT_PREFIX) || id.startsWith(PROVIDER_SCRIPT_PREFIX);
}

/** Validate whatever is stored; drops malformed rows and duplicates. */
export function normalizeCustomSites(raw: unknown): CustomSitesState {
  const sites: CustomSite[] = [];
  const seen = new Set<string>();
  const list = raw && typeof raw === 'object' && Array.isArray((raw as { sites?: unknown }).sites) ? (raw as { sites: unknown[] }).sites : [];
  for (const row of list) {
    if (!row || typeof row !== 'object') continue;
    const r = row as Record<string, unknown>;
    if (typeof r.origin !== 'string') continue;
    const checked = normalizeSiteOrigin(r.origin);
    if (!checked.ok || checked.origin !== r.origin || seen.has(checked.origin)) continue;
    seen.add(checked.origin);
    sites.push({
      origin: checked.origin,
      label: typeof r.label === 'string' && r.label.trim() ? r.label.trim().slice(0, 80) : checked.host,
      addedAt: typeof r.addedAt === 'string' ? r.addedAt : new Date(0).toISOString(),
      enabled: r.enabled !== false,
    });
    if (sites.length >= MAX_CUSTOM_SITES) break;
  }
  return { version: 1, sites };
}

export function addCustomSite(state: CustomSitesState, origin: string, now: string, label?: string): CustomSitesState {
  const checked = normalizeSiteOrigin(origin);
  if (!checked.ok) throw new Error(checked.error);
  const others = state.sites.filter((s) => s.origin !== checked.origin);
  if (others.length >= MAX_CUSTOM_SITES) throw new Error(`You can add up to ${MAX_CUSTOM_SITES} sites.`);
  const existing = state.sites.find((s) => s.origin === checked.origin);
  return {
    version: 1,
    sites: [
      ...others,
      { origin: checked.origin, label: label?.trim().slice(0, 80) || existing?.label || checked.host, addedAt: existing?.addedAt ?? now, enabled: true },
    ],
  };
}

export function removeCustomSite(state: CustomSitesState, origin: string): CustomSitesState {
  return { version: 1, sites: state.sites.filter((s) => s.origin !== origin) };
}

/** The enabled added site a page URL belongs to (exact origin, port included). */
export function matchCustomSite(state: CustomSitesState, url: string | undefined | null): CustomSite | null {
  if (!url) return null;
  let origin: string;
  try {
    origin = new URL(url).origin;
  } catch {
    return null;
  }
  return state.sites.find((s) => s.enabled && s.origin === origin) ?? null;
}

/** Shape accepted by chrome.scripting.registerContentScripts (the fields we use). */
export interface CaptureScript {
  id: string;
  matches: string[];
  js: string[];
  runAt: 'document_idle' | 'document_start';
  /** Every frame: the same pages also load inside Threadkeeper's workspace tab. */
  allFrames: true;
  persistAcrossSessions: true;
  world?: 'MAIN';
}

/** What chrome.scripting.getRegisteredContentScripts reports, as far as the plan compares it. */
export interface RegisteredScript {
  id: string;
  matches?: string[];
  js?: string[];
  runAt?: string;
  allFrames?: boolean;
  world?: string;
}

export interface CaptureScriptPlan {
  register: CaptureScript[];
  unregister: string[];
  /** Same id, different matches: unregistered then registered again. */
  update: CaptureScript[];
}

/** Suffixes of the embedding scripts registered next to each content.js (whose id has none). */
const BRIDGE_SUFFIX = '~bridge';
const COOKIE_MAIN_SUFFIX = '~cookie-main';
const CURSOR_ACCOUNT_PROVIDER = 'cursor_agents';

function needsProviderScripts(id: CaptureProviderId, authorized: boolean | undefined): boolean {
  return id === CURSOR_ACCOUNT_PROVIDER || authorized === true;
}

/**
 * The scripts for one provider or site: content.js under the id it always had, plus the two
 * embedding scripts under the same id with a suffix. All run in every frame.
 */
function scriptsFor(id: string, matches: string[]): CaptureScript[] {
  const base = { matches, allFrames: true as const, persistAcrossSessions: true as const };
  return [
    { id, ...base, js: [CONTENT_SCRIPT_FILE], runAt: 'document_idle' },
    { id: `${id}${BRIDGE_SUFFIX}`, ...base, js: [EMBED_BRIDGE_FILE], runAt: 'document_start' },
    { id: `${id}${COOKIE_MAIN_SUFFIX}`, ...base, js: [EMBED_COOKIE_MAIN_FILE], runAt: 'document_start', world: 'MAIN' },
  ];
}

/** Everything that decides what a registered script does; a difference means re-register. */
function scriptSignature(s: RegisteredScript | CaptureScript): string {
  return JSON.stringify([
    [...(s.matches ?? [])].sort(),
    s.js ?? [],
    s.runAt ?? 'document_idle',
    s.allFrames === true,
    s.world === 'MAIN' ? 'MAIN' : 'ISOLATED',
  ]);
}

/**
 * Which runtime content scripts should exist: one per enabled provider whose runtime patterns
 * are all granted, one per enabled added site whose origin is granted. Anything else we own is
 * removed. `granted(origins)` answers chrome.permissions.contains for those origins.
 */
export function planCaptureScripts(input: {
  authorizedHosts: Partial<Record<CaptureProviderId, boolean>>;
  sites: CustomSite[];
  granted: (origins: string[]) => boolean;
  registered: RegisteredScript[];
}): CaptureScriptPlan {
  const wanted = new Map<string, CaptureScript>();
  const want = (id: string, matches: string[]) => {
    for (const s of scriptsFor(id, matches)) wanted.set(s.id, s);
  };
  for (const id of CAPTURE_PROVIDER_IDS) {
    const patterns = runtimeMatchPatterns(id);
    if (patterns.length === 0 || !needsProviderScripts(id, input.authorizedHosts[id])) continue;
    if (!input.granted(toOriginMatchPatterns(patterns))) continue;
    const scriptId = providerScriptId(id);
    want(scriptId, patterns);
    if (id === CURSOR_ACCOUNT_PROVIDER) {
      const observer: CaptureScript = {
        id: `${scriptId}~site-data`,
        matches: patterns,
        js: ['content-scripts/site-data-main.js'],
        runAt: 'document_start',
        world: 'MAIN',
        allFrames: true,
        persistAcrossSessions: true,
      };
      wanted.set(observer.id, observer);
    }
  }
  const sitePatterns = new Set<string>();
  for (const site of input.sites) {
    if (!site.enabled) continue;
    const pattern = originMatchPattern(site.origin);
    if (!input.granted([pattern])) continue;
    // Two ports of one host share a pattern; one set of scripts covers both.
    if (sitePatterns.has(pattern)) continue;
    sitePatterns.add(pattern);
    want(siteScriptId(site.origin), [pattern]);
  }
  const plan: CaptureScriptPlan = { register: [], unregister: [], update: [] };
  const have = new Map(input.registered.filter((r) => isManagedScriptId(r.id)).map((r) => [r.id, r]));
  for (const [id] of have) {
    if (!wanted.has(id)) plan.unregister.push(id);
  }
  for (const [id, script] of wanted) {
    const row = have.get(id);
    if (!row) plan.register.push(script);
    else if (scriptSignature(row) !== scriptSignature(script)) plan.update.push(script);
  }
  return plan;
}

// ---- Chrome glue -------------------------------------------------------------------------

export interface StorageLike {
  get(key: string): Promise<Record<string, unknown>>;
  set(items: Record<string, unknown>): Promise<void>;
}

export async function readCustomSites(storage: StorageLike | undefined): Promise<CustomSitesState> {
  if (!storage) return EMPTY_CUSTOM_SITES;
  try {
    return normalizeCustomSites((await storage.get(CUSTOM_SITES_KEY))[CUSTOM_SITES_KEY]);
  } catch {
    return EMPTY_CUSTOM_SITES;
  }
}

export async function writeCustomSites(storage: StorageLike, state: CustomSitesState): Promise<void> {
  await storage.set({ [CUSTOM_SITES_KEY]: normalizeCustomSites(state) });
}

export interface CaptureScriptEnv {
  getRegistered(): Promise<RegisteredScript[]>;
  register(scripts: CaptureScript[]): Promise<void>;
  unregister(ids: string[]): Promise<void>;
  contains(origins: string[]): Promise<boolean>;
}

/**
 * Bring registered content scripts in line with settings, added sites and granted access.
 * Never throws; returns what changed (or the error) for the diagnostics log.
 */
export async function reconcileCaptureScripts(
  env: CaptureScriptEnv,
  input: { authorizedHosts: Partial<Record<CaptureProviderId, boolean>>; sites: CustomSite[] }
): Promise<{ registered: string[]; unregistered: string[]; error?: string }> {
  try {
    const registered = await env.getRegistered();
    const grants = new Map<string, boolean>();
    const askFor = new Set<string>();
    for (const id of CAPTURE_PROVIDER_IDS) {
      const patterns = runtimeMatchPatterns(id);
      if (patterns.length > 0 && needsProviderScripts(id, input.authorizedHosts[id])) askFor.add(JSON.stringify(toOriginMatchPatterns(patterns)));
    }
    for (const site of input.sites) if (site.enabled) askFor.add(JSON.stringify([originMatchPattern(site.origin)]));
    for (const key of askFor) grants.set(key, await env.contains(JSON.parse(key) as string[]).catch(() => false));
    const plan = planCaptureScripts({
      ...input,
      registered,
      granted: (origins) => grants.get(JSON.stringify(origins)) === true,
    });
    const drop = [...plan.unregister, ...plan.update.map((s) => s.id)];
    if (drop.length > 0) await env.unregister(drop);
    const add = [...plan.register, ...plan.update];
    if (add.length > 0) await env.register(add);
    return { registered: add.map((s) => s.id), unregistered: plan.unregister };
  } catch (err) {
    return { registered: [], unregistered: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** The chrome.scripting / chrome.permissions implementation of CaptureScriptEnv. */
export function chromeCaptureScriptEnv(): CaptureScriptEnv | null {
  if (typeof chrome === 'undefined' || !chrome.scripting?.registerContentScripts || !chrome.permissions?.contains) return null;
  return {
    getRegistered: async () =>
      (await chrome.scripting.getRegisteredContentScripts()).map((s) => ({
        id: s.id,
        matches: s.matches,
        js: s.js,
        runAt: s.runAt,
        allFrames: s.allFrames,
        world: s.world,
      })),
    register: (scripts) => chrome.scripting.registerContentScripts(scripts as chrome.scripting.RegisteredContentScript[]),
    unregister: (ids) => chrome.scripting.unregisterContentScripts({ ids }),
    contains: (origins) => chrome.permissions.contains({ origins }),
  };
}
