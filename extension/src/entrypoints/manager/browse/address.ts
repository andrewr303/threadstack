// What to do with an address typed into the Browse bar. Pure: the view acts on the outcome.
import { embedTargetFor } from '../workspace/state.js';

export type AddressOutcome =
  /** Nothing typed, or no change. */
  | { kind: 'none' }
  /** Same sign-in as the tab: send the tab there. */
  | { kind: 'navigate'; url: string }
  /** Another provider Threadkeeper knows: open it as its own tab. */
  | { kind: 'open'; url: string }
  /** Cannot be shown here. `chromeUrl` is set when the address is a web page Chrome can open. */
  | { kind: 'refuse'; message: string; chromeUrl: string | null };

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

function hostOf(url: URL): string {
  return url.hostname.replace(/^www\./, '');
}

export function resolveAddress(raw: string, tab: { realm: string; url: string }): AddressOutcome {
  const text = raw.trim();
  if (!text || text === tab.url) return { kind: 'none' };
  let candidate = text;
  if (!HAS_SCHEME.test(candidate)) {
    // "claude.ai/code" is an address; "what is a webhook" is not.
    if (/\s/.test(candidate) || !candidate.includes('.')) {
      return { kind: 'refuse', message: 'That is not a web address. Type an address such as claude.ai/code.', chromeUrl: null };
    }
    candidate = `https://${candidate}`;
  }
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return { kind: 'refuse', message: 'That is not a web address. Type an address such as claude.ai/code.', chromeUrl: null };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { kind: 'refuse', message: 'Threadkeeper shows web pages only. Type an https address.', chromeUrl: null };
  }
  const target = embedTargetFor(parsed.href);
  if (!target) {
    const reason =
      parsed.protocol === 'http:'
        ? 'Threadkeeper shows https pages only.'
        : `Threadkeeper cannot show ${hostOf(parsed)} here. It shows the AI sites it knows.`;
    return { kind: 'refuse', message: `${reason} You can open it in a Chrome tab instead.`, chromeUrl: parsed.href };
  }
  return target.realm.id === tab.realm ? { kind: 'navigate', url: target.url } : { kind: 'open', url: target.url };
}

/** The host and the rest of an address, for showing the host in bold. */
export function splitAddress(url: string): { host: string; rest: string } {
  try {
    const parsed = new URL(url);
    const rest = `${parsed.pathname === '/' ? '' : parsed.pathname}${parsed.search}${parsed.hash}`;
    return { host: parsed.host, rest };
  } catch {
    return { host: url, rest: '' };
  }
}
