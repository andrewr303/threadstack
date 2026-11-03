// The background's decision on a capture sent by a content script. A content script runs inside
// a website, so nothing it says is trusted on its own: the page it came from (sender.url, top
// frame only) must be one of the claimed provider's pages, or an enabled site the user added;
// capture must be on for that provider; and "the user asked for this tab" counts only with a
// token the background itself handed to that tab moments ago.

import {
  PROVIDERS,
  isProviderAllowedOnUrl,
  isProviderId,
  type CaptureProviderId,
} from './providers.js';
import { matchCustomSite, siteConversationKey, type CustomSite, type CustomSitesState } from './custom-sites.js';
import { captureSenderUrl, type RuntimeSender } from './messaging.js';
import { canonicalizeConversationUrl } from './dom-capture.js';

/** A one-time-ish permission for one tab: the overlay was opened there, or the user chose "Capture this tab". */
export interface ExplicitGrant {
  token: string;
  /** `capture`: the user asked to save this tab. `overlay`: the user opened Threadkeeper on it. */
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
}): CaptureDecision {
  const pageUrl = captureSenderUrl(input.sender);
  if (!pageUrl) return { ok: false, error: 'Captures are accepted only from the top frame of a web page.' };
  const raw = input.payload?.provider;
  if (!isProviderId(raw) || raw === 'imported') return { ok: false, error: 'Unknown capture provider' };
  const provider: CaptureProviderId = raw;
  const conv = input.payload?.sourceConversationId;
  if (typeof conv !== 'string' || conv.length === 0 || conv.length > CONV_ID_MAX) {
    return { ok: false, error: 'Missing conversation id' };
  }

  const grant = input.grant;
  const grantValid = Boolean(
    grant && typeof input.explicitToken === 'string' && input.explicitToken === grant.token && grant.expiresAt > input.now
  );
  const info = PROVIDERS[provider];

  if (info.hostAccess === 'custom') {
    const site = matchCustomSite(input.sites, pageUrl);
    if (!site) return { ok: false, skipped: 'site_not_added' };
    // Ids are namespaced by the site so two self-hosted apps never share a thread.
    if (!conv.startsWith(`${siteConversationKey(site.origin)}~`)) return { ok: false, error: 'Conversation id does not belong to this site' };
    const claimed = typeof input.payload?.canonicalUrl === 'string' ? input.payload.canonicalUrl : '';
    const canonicalUrl = sameOrigin(claimed, site.origin) ? claimed : canonicalizeConversationUrl(pageUrl, provider);
    return { ok: true, provider, sourceConversationId: conv, canonicalUrl, explicit: grantValid, site };
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
  return { ok: true, provider, sourceConversationId: conv, canonicalUrl, explicit: grantValid, site: null };
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
