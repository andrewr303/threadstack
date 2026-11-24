// Small pieces the account menu, the Add account dialog, Settings and the import share.
import { useEffect, useRef } from 'react';
import { ACCOUNT_COLORS, type AccountColor } from '../../../core/workspace/types.js';
import type { RealmInfo } from '../../../core/workspace/realms.js';

export { ACCOUNT_COLORS };

/** The six account colours by name. A colour is never shown without its name or the account's name. */
export const COLOR_LABELS: Record<AccountColor, string> = {
  teal: 'Teal',
  peach: 'Peach',
  violet: 'Violet',
  sage: 'Sage',
  blue: 'Blue',
  gold: 'Gold',
};

export const MAX_ACCOUNT_NAME = 40;

/** Origin patterns ThreadStack needs to save and restore a sign-in's cookies. */
export function realmHostOrigins(realm: RealmInfo): string[] {
  return [...new Set([...realm.cookieDomains.map((d) => `https://*.${d}/*`), ...realm.extraHostPatterns])];
}

/**
 * Ask Chrome for host access. Chrome shows its prompt only in response to a click, so callers
 * run this from a click handler before awaiting anything else. A refusal or an unavailable
 * API resolves false and never throws.
 */
export async function requestOrigins(origins: string[]): Promise<boolean> {
  if (origins.length === 0) return true;
  if (typeof chrome === 'undefined' || !chrome.permissions?.request) return false;
  try {
    return await chrome.permissions.request({ origins });
  } catch {
    return false;
  }
}

/** The ThreadStack page that manages accounts, from the side panel or the in-page overlay. */
export function openFullPage(): void {
  try {
    if (typeof chrome !== 'undefined' && chrome.tabs?.create && chrome.runtime?.getURL) {
      void chrome.tabs.create({ url: chrome.runtime.getURL('manager.html?surface=page') });
      return;
    }
  } catch {
    // fall through to a plain window
  }
  window.open('manager.html?surface=page', '_blank');
}

/** A ref that says whether the component is still mounted, for work that finishes after an await. */
export function useMounted(): React.MutableRefObject<boolean> {
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return mounted;
}
