// Where a content script is running. Every content script now runs in all frames of the hosts it
// matches, so each one decides at its very top whether it has anything to do there:
// - `top`: the page is a tab of its own, as before.
// - `workspace`: the page is embedded directly in ThreadStack's own workspace page.
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

/** ThreadStack's own origin, or null when the extension context is gone (reloaded). */
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
 * Options the workspace page passes to a frame through its `name`, which a script can read
 * before anything else has loaded: `tk-pane~<id>`, or `tk-pane~!<flags>!<id>` with one letter
 * per option. Session tab ids never start with "!".
 * - `n`: do not make the page answer framing checks like a top-level page (see below).
 */
export type PaneFlag = 'n';

export interface PaneInfo {
  /** The SessionTab id. */
  id: string;
  flags: string;
}

/**
 * The `name` the workspace gives the frame of a session tab. An id that starts with "!" always
 * gets a (possibly empty) options section, so it can never be read back as options.
 */
export function buildPaneName(id: string, flags: readonly PaneFlag[] = []): string {
  const letters = [...new Set(flags)].sort().join('');
  return letters || id.startsWith('!') ? `${EMBED_FRAME_NAME_PREFIX}!${letters}!${id}` : `${EMBED_FRAME_NAME_PREFIX}${id}`;
}

/** The id and options in a frame name, or null when the name is not one the workspace gave. */
export function parsePaneName(name: unknown): PaneInfo | null {
  if (typeof name !== 'string' || !name.startsWith(EMBED_FRAME_NAME_PREFIX)) return null;
  let rest = name.slice(EMBED_FRAME_NAME_PREFIX.length);
  let flags = '';
  if (rest.startsWith('!')) {
    const end = rest.indexOf('!', 1);
    if (end === -1) return null;
    flags = rest.slice(1, end);
    if (!/^[a-z]{0,8}$/.test(flags)) return null;
    rest = rest.slice(end + 1);
  }
  return rest.length > 0 && rest.length <= MAX_PANE_NAME ? { id: rest, flags } : null;
}

function readName(win: Pick<FrameWindow, 'name'>): string {
  try {
    return typeof win.name === 'string' ? win.name : '';
  } catch {
    return '';
  }
}

/**
 * The SessionTab id the workspace gave this frame through its `name`, or null. The page can
 * rename its own window, so this is a hint for the workspace page; the worker identifies the
 * frame by `sender.frameId`.
 */
export function paneName(win: Pick<FrameWindow, 'name'> = window): string | null {
  return parsePaneName(readName(win))?.id ?? null;
}

/** Whether the workspace set an option for this frame (see PaneFlag). */
export function paneHasFlag(flag: PaneFlag, win: Pick<FrameWindow, 'name'> = window): boolean {
  return parsePaneName(readName(win))?.flags.includes(flag) ?? false;
}

/**
 * Whether this document is in a credentialless frame: the workspace's profile slot, with its own
 * cookies and site storage. Read from the window itself, so in the isolated world a page script
 * cannot change the answer.
 */
export function inProfileFrame(win: unknown = window): boolean {
  try {
    return (win as { credentialless?: unknown }).credentialless === true;
  } catch {
    return false;
  }
}

/**
 * Sites that hide their own navigation when they find themselves in a frame. Embedded in the
 * workspace, their pages are made to answer that check like a top-level page (profile-page.ts),
 * so the whole product is reachable there. Kept as a short list of hosts, not derived from the
 * provider registry, because the scripts that read it run in every frame of every provider page.
 * tests/unit/frame-names.test.ts pins the list and its host matching.
 */
export const TOP_LEVEL_VIEW_HOSTS: readonly string[] = ['claude.ai'];

export function wantsTopLevelView(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return TOP_LEVEL_VIEW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/**
 * Attribute the isolated-world script leaves on the document element, at document_start, for
 * the page-world script that runs right after it: "this frame is directly inside ThreadStack's
 * own page and should answer framing checks like a top-level page". Only the isolated world can
 * tell whose page frames it; the page world consumes the mark at once.
 */
export const TOP_LEVEL_MARK = 'data-tk-top-level';
