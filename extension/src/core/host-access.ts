// Optional host access is shared between features: an added capture site, an optional provider and
// the Paperclip server can all rest on the same Chrome grant (patterns cannot name a port, so
// http://localhost:3000 and Paperclip on http://localhost:3100 both need http://localhost/*).
// Before revoking a grant, check that no other feature still relies on it.

import { CAPTURE_PROVIDER_IDS, PROVIDERS, runtimePermissionOrigins, type CaptureProviderId } from './providers.js';
import { originMatchPattern, type CustomSitesState } from './custom-sites.js';
import { hostPermissionPattern, isLoopbackServer } from './paperclip/client.js';

/** Origins to ask for: both loopback names for a local server (so ports 3100-3110 can be tried), else the server's host. */
export function paperclipPermissionOrigins(serverUrl: string): string[] {
  if (isLoopbackServer(serverUrl)) return ['http://localhost/*', 'http://127.0.0.1/*'];
  const pattern = hostPermissionPattern(serverUrl);
  return pattern ? [pattern] : [];
}

export interface HostAccessUsers {
  /** Added capture sites (every listed site, on or off: turning one back on must not need a new prompt). */
  sites: CustomSitesState;
  /** Capture on/off per provider, as it will be after the change. */
  authorizedHosts: Partial<Record<CaptureProviderId, boolean>>;
  paperclip: { enabled: boolean; serverUrl: string };
}

/** Every optional origin pattern some feature still needs. */
export function originsInUse(users: HostAccessUsers): string[] {
  const out = new Set<string>();
  for (const site of users.sites.sites) {
    try {
      out.add(originMatchPattern(site.origin));
    } catch {
      // a malformed stored origin needs nothing
    }
  }
  for (const id of CAPTURE_PROVIDER_IDS) {
    if (PROVIDERS[id].hostAccess === 'optional' && users.authorizedHosts[id]) {
      for (const o of runtimePermissionOrigins(id)) out.add(o);
    }
  }
  if (users.paperclip.enabled) for (const o of paperclipPermissionOrigins(users.paperclip.serverUrl)) out.add(o);
  return Array.from(out);
}

function parsePattern(pattern: string): { scheme: string; host: string } | null {
  const m = pattern.trim().toLowerCase().match(/^(\*|https?):\/\/([^/]+)\//);
  return m ? { scheme: m[1], host: m[2] } : null;
}

function hostCovers(pattern: string, host: string): boolean {
  if (pattern === '*' || pattern === host) return true;
  if (pattern.startsWith('*.')) {
    const base = pattern.slice(2);
    return host === base || host.endsWith(`.${base}`);
  }
  return false;
}

/** True when the two patterns can match a common page (same scheme family, overlapping hosts). */
export function patternsOverlap(a: string, b: string): boolean {
  const pa = parsePattern(a);
  const pb = parsePattern(b);
  if (!pa || !pb) return a.toLowerCase() === b.toLowerCase();
  const schemes = pa.scheme === '*' || pb.scheme === '*' || pa.scheme === pb.scheme;
  return schemes && (hostCovers(pa.host, pb.host) || hostCovers(pb.host, pa.host));
}

/** The candidate patterns no other feature still needs: the only ones safe to revoke. */
export function releasableOrigins(candidates: readonly string[], users: HostAccessUsers): string[] {
  const inUse = originsInUse(users);
  return candidates.filter((c) => !inUse.some((u) => patternsOverlap(c, u)));
}
