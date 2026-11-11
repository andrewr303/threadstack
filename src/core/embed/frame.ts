// Where a content script is running. Every content script now runs in all frames of the hosts it
// matches, so each one decides at its very top whether it has anything to do there:
// - `top`: the page is a tab of its own, as before.
// - `workspace`: the page is embedded directly in Threadkeeper's own workspace page.
// - `other`: any other frame (an ad, a sign-in widget, a site embedding a provider, a frame
//   nested inside an embedded page). Scripts return at once and register nothing.
import { EMBED_FRAME_NAME_PREFIX } from '../workspace/types.js';

export type FrameMode = 'top' | 'workspace' | 'other';

/** The parts of a window the decision reads, so tests can pass a stand-in. */
export interface FrameWindow {
  top: unknown;
  name: string;
  location: { ancestorOrigins?: ArrayLike<string> | null };
}

/** Threadkeeper's own origin, or null when the extension context is gone (reloaded). */
function extensionOrigin(): string | null {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return null;
    // Built from the parts: URL#origin is "null" for schemes the URL standard does not know
    // outside a browser that registers chrome-extension.
    const url = new URL(chrome.runtime.getURL(''));
    return url.host ? `${url.protocol}//${url.host}` : null;
  } catch {
    return null;
  }
}

function isTop(win: FrameWindow): boolean {
  try {
    return win === win.top;
  } catch {
    return false;
  }
}

/** For the isolated world, which can ask chrome.runtime for the extension's exact origin. */
export function frameMode(win: FrameWindow = window as unknown as FrameWindow): FrameMode {
  if (isTop(win)) return 'top';
  try {
    const ancestors = win.location.ancestorOrigins;
    // Directly inside the extension page: one ancestor, and it is us. A frame nested deeper
    // inside an embedded page has two or more ancestors and is left alone.
    if (!ancestors || ancestors.length !== 1) return 'other';
    const own = extensionOrigin();
    return own !== null && ancestors[0] === own ? 'workspace' : 'other';
  } catch {
    return 'other';
  }
}

/**
 * For the MAIN world, which cannot call chrome.runtime: directly inside some extension page.
 * Looser than `frameMode`, so whatever acts on it must stay inert until the isolated half
 * (which checks the exact origin) talks to it.
 */
export function embeddedInExtensionPage(win: FrameWindow = window as unknown as FrameWindow): boolean {
  if (isTop(win)) return false;
  try {
    const ancestors = win.location.ancestorOrigins;
    return Boolean(ancestors && ancestors.length === 1 && String(ancestors[0]).startsWith('chrome-extension://'));
  } catch {
    return false;
  }
}

const MAX_PANE_NAME = 400;

/**
 * The SessionTab id the workspace gave this frame through its `name`, or null. The page can
 * rename its own window, so this is a hint for the workspace page; the worker identifies the
 * frame by `sender.frameId`.
 */
export function paneName(win: Pick<FrameWindow, 'name'> = window): string | null {
  let name: string;
  try {
    name = typeof win.name === 'string' ? win.name : '';
  } catch {
    return null;
  }
  if (!name.startsWith(EMBED_FRAME_NAME_PREFIX)) return null;
  const id = name.slice(EMBED_FRAME_NAME_PREFIX.length);
  return id.length > 0 && id.length <= MAX_PANE_NAME ? id : null;
}
