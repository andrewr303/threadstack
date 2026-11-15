// Host access for embedding. A provider on a host Threadkeeper does not hold from install
// (Cursor, Muse, Devin, ...) can be embedded only after the person grants that host, and its
// sessions are saved only once capture is on for it. One click does both, because a page that is
// shown but silently not saved would break the promise that sessions save themselves.
import { useCallback, useEffect, useState } from 'react';
import {
  PROVIDERS,
  isCaptureProviderId,
  runtimeMatchPatterns,
  runtimePermissionOrigins,
  type ProviderId,
} from '../../../core/providers.js';
import type { SettingsRecord } from '../../../core/schema.js';
import { realmForProvider } from '../../../core/workspace/realms.js';
import { notifyBackground } from '../shared.js';

/** Origins the provider needs beyond the install-time ones (empty when none are needed). */
export function embedOriginsFor(provider: ProviderId): string[] {
  return runtimePermissionOrigins(provider);
}

/** Sign-in hosts on another domain; asked for together with the provider, and optional. */
export function signInOriginsFor(provider: ProviderId): string[] {
  return realmForProvider(provider)?.extraHostPatterns ?? [];
}

async function contains(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  if (typeof chrome === 'undefined' || !chrome.permissions?.contains) return false;
  try {
    return await chrome.permissions.contains({ origins });
  } catch {
    return false;
  }
}

export type HostAccess = 'checking' | 'granted' | 'needed';

/**
 * Whether the provider's pages can load here. `allow` must be called from a click: Chrome only
 * shows its permission prompt in response to one.
 */
export function useEmbedAccess(
  provider: ProviderId | null,
  settings: SettingsRecord | null,
  patchSettings: (patch: Partial<SettingsRecord>) => Promise<void>
): { access: HostAccess; allow: () => Promise<boolean> } {
  const [access, setAccess] = useState<HostAccess>('checking');

  useEffect(() => {
    let alive = true;
    if (!provider) {
      setAccess('granted');
      return;
    }
    setAccess('checking');
    void contains(embedOriginsFor(provider)).then((ok) => alive && setAccess(ok ? 'granted' : 'needed'));
    // The permissions events cannot be unsubscribed in the typings; calls after unmount are ignored.
    const recheck = () => {
      if (alive) void contains(embedOriginsFor(provider)).then((ok) => alive && setAccess(ok ? 'granted' : 'needed'));
    };
    if (typeof chrome !== 'undefined' && chrome.permissions?.onAdded) {
      chrome.permissions.onAdded.addListener(recheck);
      chrome.permissions.onRemoved.addListener(recheck);
    }
    return () => {
      alive = false;
    };
  }, [provider]);

  const allow = useCallback(async () => {
    if (!provider || typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
    const origins = embedOriginsFor(provider);
    let granted = false;
    try {
      // One prompt for the site and its sign-in host; the sign-in host is a convenience, so a
      // browser that refuses the combined request is asked again for the site alone.
      granted = await chrome.permissions.request({ origins: [...origins, ...signInOriginsFor(provider)] });
    } catch {
      granted = false;
    }
    if (!granted) {
      try {
        granted = origins.length === 0 ? true : await chrome.permissions.request({ origins });
      } catch {
        granted = false;
      }
    }
    if (!granted) return false;
    setAccess('granted');
    // Saving follows showing: turn capture on for the provider and register its scripts.
    if (settings && isCaptureProviderId(provider) && PROVIDERS[provider].captureMode === 'passive' && !settings.authorizedHosts[provider]) {
      await patchSettings({ authorizedHosts: { ...settings.authorizedHosts, [provider]: true } });
    }
    notifyBackground({ type: 'CAPTURE_SITES_CHANGED', patterns: runtimeMatchPatterns(provider) });
    return true;
  }, [provider, settings, patchSettings]);

  return { access, allow };
}
