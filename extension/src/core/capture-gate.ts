// The background's decision on a capture sent by a content script. A content script runs inside
// a website, so nothing it says is trusted on its own: the page it came from (sender.url, top
// frame only, or a page embedded in ThreadStack's own workspace tab) must be one of the claimed
// provider's pages, or an enabled site the user added; capture must be on for that provider; and
// "the user asked for this tab" counts only with a token the background itself handed to that
// tab moments ago.

import {
  CUSTOM_SITE_PROVIDER_IDS,
  PROVIDERS,
  isCaptureProviderId,
  isProviderAllowedOnUrl,
  type CaptureProviderId,
} from './providers.js';
import { matchCustomSite, siteConversationKey, type CustomSite, type CustomSitesState } from './custom-sites.js';
import { captureSenderPage, type EmbedSenderContext, type RuntimeSender } from './messaging.js';
import { canonicalizeConversationUrl } from './dom-capture.js';
import { normalizePullRequestUrl, normalizeRepository } from './repository.js';
import { isAgentState, type AgentState } from './workspace/types.js';

/** A one-time-ish permission for one tab: the overlay was opened there, or the user chose "Capture this tab". */
export interface ExplicitGrant {
  token: string;
  /** `capture`: the user asked to save this tab. `overlay`: the user opened ThreadStack on it. */
  kind: 'capture' | 'overlay';
  expiresAt: number;
}

export const EXPLICIT_GRANT_MS = 60_000;

export type CaptureDecision =
  | {
      ok: true;
      provider: CaptureProviderId;
      sourceConversationId: string;
      canonicalUrl: string;
      explicit: boolean;
      site: CustomSite | null;
      /** The capture came from a page embedded in a workspace tab. */
      embedded: boolean;
    }
  | { ok: false; skipped?: string; error?: string };

const CONV_ID_MAX = 300;

export function decideCapture(input: {
  payload: { provider?: unknown; sourceConversationId?: unknown; canonicalUrl?: unknown } | null | undefined;
  explicitToken?: unknown;
  sender: RuntimeSender;
  authorizedHosts: Partial<Record<CaptureProviderId, boolean>>;
  sites: CustomSitesState;
  grant: ExplicitGrant | null | undefined;
  now: number;
  /** Lets pages embedded in the workspace through the sender check; without it every frame is refused. */
  embed?: EmbedSenderContext | null;
}): CaptureDecision {
  const page = captureSenderPage(input.sender, input.embed);
  if (!page) return { ok: false, error: 'Captures are accepted only from the top frame of a web page or a page open in the ThreadStack workspace.' };
  const pageUrl = page.url;
  const embedded = page.embedded;
  const raw = input.payload?.provider;
  if (!isCaptureProviderId(raw)) return { ok: false, error: 'Unknown capture provider' };
  const provider: CaptureProviderId = raw;
  const conv = input.payload?.sourceConversationId;
  if (typeof conv !== 'string' || conv.length === 0 || conv.length > CONV_ID_MAX) {
    return { ok: false, error: 'Missing conversation id' };
  }

  // Grants belong to the tab the person invoked ThreadStack on; a workspace tab never gets one,
  // and a page embedded there never borrows one. Explicit-only capture stays explicit.
  const grant = embedded ? null : input.grant;
  const grantValid = Boolean(
    grant && typeof input.explicitToken === 'string' && input.explicitToken === grant.token && grant.expiresAt > input.now
  );
  const info = PROVIDERS[provider];

  // Self-hosted apps on a site the user added. Most are custom-only providers; LobeChat also has a
  // hosted page (app.lobehub.com, an optional provider), so its self-hosted copies on an added site
  // take this branch too, while captures from its hosted page go through the provider checks below.
  const selfHosted =
    info.hostAccess !== 'custom' && CUSTOM_SITE_PROVIDER_IDS.includes(provider) && !isProviderAllowedOnUrl(provider, pageUrl)
      ? matchCustomSite(input.sites, pageUrl)
      : null;
  if (info.hostAccess === 'custom' || selfHosted) {
    const site = selfHosted ?? matchCustomSite(input.sites, pageUrl);
    if (!site) return { ok: false, skipped: 'site_not_added' };
    // Ids are namespaced by the site so two self-hosted apps never share a thread.
    if (!conv.startsWith(`${siteConversationKey(site.origin)}~`)) return { ok: false, error: 'Conversation id does not belong to this site' };
    const claimed = typeof input.payload?.canonicalUrl === 'string' ? input.payload.canonicalUrl : '';
    const canonicalUrl = sameOrigin(claimed, site.origin) ? claimed : canonicalizeConversationUrl(pageUrl, provider);
    return { ok: true, provider, sourceConversationId: conv, canonicalUrl, explicit: grantValid, site, embedded };
  }

  if (!isProviderAllowedOnUrl(provider, pageUrl)) {
    return { ok: false, error: `A ${info.label} capture must come from a ${info.label} page.` };
  }
  if (info.captureMode === 'explicit') {
    // Pages that also hold private, non-AI conversations: only the tab the user chose to save.
    if (!input.authorizedHosts[provider]) return { ok: false, skipped: 'provider_not_authorized' };
    if (!grantValid || grant?.kind !== 'capture') return { ok: false, skipped: 'explicit_only' };
  } else if (!input.authorizedHosts[provider] && !grantValid) {
    return { ok: false, skipped: 'provider_not_authorized' };
  }
  const claimed = typeof input.payload?.canonicalUrl === 'string' ? input.payload.canonicalUrl : '';
  const canonicalUrl = /^https:\/\//i.test(claimed) && isProviderAllowedOnUrl(provider, claimed) ? claimed : canonicalizeConversationUrl(pageUrl);
  return { ok: true, provider, sourceConversationId: conv, canonicalUrl, explicit: grantValid, site: null, embedded };
}

/** Coding-session fields a capture may carry, after validation. */
export interface CodingFields {
  repository?: string;
  pullRequestUrl?: string;
  gitBranch?: string;
  agentState?: AgentState;
}

const BRANCH_MAX = 250;
// eslint-disable-next-line no-control-regex
const BRANCH_BAD = /[\u0000-\u0020\u007f~^:?*[\\]/;

/**
 * The repository, pull request, branch and agent state a content script reported, each checked
 * on its own; anything invalid is dropped rather than stored.
 */
export function sanitizeCodingFields(payload: Record<string, unknown> | null | undefined): CodingFields {
  const out: CodingFields = {};
  if (!payload) return out;
  if (typeof payload.repository === 'string' && payload.repository.length <= 400) {
    const repository = normalizeRepository(payload.repository);
    if (repository) out.repository = repository;
  }
  if (typeof payload.pullRequestUrl === 'string' && payload.pullRequestUrl.length <= 2048) {
    const pr = normalizePullRequestUrl(payload.pullRequestUrl);
    if (pr) out.pullRequestUrl = pr;
  }
  if (typeof payload.gitBranch === 'string') {
    const branch = payload.gitBranch.trim();
    if (branch.length > 0 && branch.length <= BRANCH_MAX && !BRANCH_BAD.test(branch)) out.gitBranch = branch;
  }
  if (isAgentState(payload.agentState)) out.agentState = payload.agentState;
  return out;
}

function sameOrigin(url: string, origin: string): boolean {
  try {
    return new URL(url).origin === origin;
  } catch {
    return false;
  }
}

/** Random token for an explicit grant (hex, 32 chars). */
export function newGrantToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}
