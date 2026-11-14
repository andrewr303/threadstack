// The real chrome.cookies / chrome.permissions behind AccountsEnv. Service worker only.
//
// Cookie values pass through here and go nowhere else: nothing in this file logs, throws or
// reports a cookie, so a failure message can never carry a credential.
import type { AccountsEnv } from './contract.js';
import type { StoredCookie } from '../workspace/types.js';
import { removeDetails, toSetDetails, toStoredCookie } from './cookies.js';

/**
 * Top-level sites whose cookie partitions belong to a realm domain. The site of a host is its
 * last two labels, which is right for every domain in the realm list (none sits under a
 * multi-part public suffix such as co.uk); a new realm on such a suffix must extend this.
 */
export function partitionSites(domain: string, extensionUrl = chrome.runtime.getURL('')): string[] {
  const labels = domain.toLowerCase().split('.').filter(Boolean);
  const site = `https://${labels.slice(-2).join('.')}`;
  const own = extensionUrl.replace(/\/$/, '');
  return own ? [site, own] : [site];
}

export function chromeAccountsEnv(): AccountsEnv {
  return {
    async getCookies(domain: string): Promise<StoredCookie[]> {
      // The ordinary jar, plus the two partitions a realm's own pages write to: the site as its
      // own top-level page, and the site embedded in Threadkeeper's workspace page.
      //
      // Deliberately not `partitionKey: {}` (every partition at once): in the embedding spike
      // that call crashed Chromium 153 whenever a credentialless iframe somewhere in the browser
      // held cookies. Naming the partitions also keeps the jar to what a sign-in can use.
      const found: chrome.cookies.Cookie[] = await chrome.cookies.getAll({ domain });
      for (const topLevelSite of partitionSites(domain)) {
        try {
          found.push(...(await chrome.cookies.getAll({ domain, partitionKey: { topLevelSite } })));
        } catch {
          // A browser without partitioned cookies: the ordinary jar is the whole login.
        }
      }
      return found.map(toStoredCookie);
    },
    async setCookie(cookie: StoredCookie): Promise<boolean> {
      try {
        // Resolves null (or rejects) when Chrome refuses the cookie, for example an expired one.
        return (await chrome.cookies.set(toSetDetails(cookie))) != null;
      } catch {
        return false;
      }
    },
    async removeCookie(cookie: StoredCookie): Promise<void> {
      try {
        await chrome.cookies.remove(removeDetails(cookie));
      } catch {
        // The service reads the jar again after clearing and retries what is left.
      }
    },
    async hasHostAccess(patterns: string[]): Promise<boolean> {
      if (patterns.length === 0) return false;
      try {
        return await chrome.permissions.contains({ origins: patterns });
      } catch {
        return false;
      }
    },
    now: () => new Date(),
    randomHex(length: number): string {
      const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length / 2)));
      return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('').slice(0, length);
    },
  };
}
