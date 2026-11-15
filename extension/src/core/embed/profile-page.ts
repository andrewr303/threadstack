// What the page-world script changes in a page embedded in the workspace, beyond the cookie
// accessor (cookie-shim.ts). Each function takes the window and document it works on, so it can
// be tested with stand-ins. Nothing here may throw into the page.
//
// Every one of these acts only on a mark the isolated-world script left (frame.ts): the page
// world cannot tell whose page frames it, and none of this may happen in an ordinary tab or in
// a frame of some other site or extension.

/** Attribute the isolated-world script sets when the frame is a profile frame of the workspace. */
export const PROFILE_MARK = 'data-tk-profile';

interface MarkedDocument {
  documentElement: { hasAttribute(name: string): boolean; removeAttribute(name: string): void } | null;
}

/** Whether the isolated-world script left `mark`; the mark is removed so page scripts never see it. */
export function consumeMark(doc: MarkedDocument, mark: string): boolean {
  try {
    const root = doc.documentElement;
    if (!root || !root.hasAttribute(mark)) return false;
    root.removeAttribute(mark);
    return true;
  } catch {
    return false;
  }
}

const SELF_PROBE = 'data-tk-self';

/**
 * Make the page answer the common framing check `window.self !== window.top` like a top-level
 * page, so a site that hides its own navigation when framed shows it in the workspace.
 *
 * `window.top` cannot be redefined, but `window.self` can: it is made to return `window.top`.
 * Page code also uses the bare name `self` as its handle on its own window, and `window.top` is a
 * cross-origin window it may not touch, so first a global `let self = window` is declared through
 * an inline script: a global `let` shadows the window property for every later script and module
 * of the page. If that script does not run (a content security policy the header rule did not
 * remove), nothing is changed: `window.self` without the shadow would break the page.
 *
 * Measured in Chromium 153 and Edge 157 (docs/research/2026-11-13-embedded-profiles/spike,
 * run-spike-2): classic and module scripts keep working, and an ordinary tab is untouched.
 * The technique is the one a public extension uses for the same site (see the decision report).
 *
 * Returns whether the page now reads as top-level.
 */
export function presentAsTopLevel(win: Window, doc: Document): boolean {
  try {
    const root = doc.documentElement;
    if (!root) return false;
    const script = doc.createElement('script');
    script.textContent = `let self = window; document.documentElement.setAttribute('${SELF_PROBE}', '');`;
    (doc.head ?? root).appendChild(script);
    script.remove();
    if (!root.hasAttribute(SELF_PROBE)) return false;
    root.removeAttribute(SELF_PROBE);
    Object.defineProperty(win, 'self', {
      configurable: true,
      enumerable: true,
      get: () => win.top,
      // Assigning to window.self is rare and means nothing useful here; the bare name is the page's.
      set: () => undefined,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Refuse service workers and shared workers in a profile frame.
 *
 * A profile's pages live in the workspace page's own cookie partition. Measured there: requests a
 * service worker makes are sent without the site's SameSite=Lax and Strict cookies (so a page that
 * routes its requests through one is signed out), and they belong to no tab, so the cookies their
 * answers set would never reach the account's saved jar. A site must already work without them
 * (a first visit, private browsing), so they are refused the way a browser that disallows them
 * does: `register` rejects with a SecurityError and nothing is listed as registered.
 */
export function refuseBackgroundWorkers(win: Window): void {
  try {
    const container = win.navigator?.serviceWorker;
    if (container) {
      const proto = Object.getPrototypeOf(container) as object;
      // The page's own DOMException, so `instanceof` in page code behaves; Error where there is none.
      const Rejection = (win as unknown as { DOMException?: typeof DOMException }).DOMException ?? Error;
      const define = (name: string, value: unknown) => {
        try {
          Object.defineProperty(proto, name, { configurable: true, writable: true, value });
        } catch {
          // left as it is
        }
      };
      define('register', function register(): Promise<never> {
        return Promise.reject(new Rejection('Service workers are not available in this page.', 'SecurityError'));
      });
      define('getRegistration', function getRegistration(): Promise<undefined> {
        return Promise.resolve(undefined);
      });
      define('getRegistrations', function getRegistrations(): Promise<never[]> {
        return Promise.resolve([]);
      });
    }
  } catch {
    // never disturb the page
  }
  try {
    Object.defineProperty(win, 'SharedWorker', { configurable: true, writable: true, value: undefined });
  } catch {
    // never disturb the page
  }
}

/**
 * A document.cookie assignment as it must be handed to the browser inside a profile frame.
 *
 * Measured: a script in a frame of the workspace page can store only `SameSite=None; Secure`
 * cookies; anything else is silently dropped, and then never sent. The profile's partition is
 * private to the workspace page, so the cookie is stored as SameSite=None there. The assignment
 * the page actually made is what goes to the account's jar (cookie-shim.ts forwards it as it was).
 */
export function asCrossSiteAssignment(raw: string): string {
  const [pair, ...attributes] = raw.split(';');
  const kept = attributes.filter((part) => !/^\s*(?:samesite\s*=.*|secure)\s*$/i.test(part));
  return [pair, ...kept, ' SameSite=None', ' Secure'].join(';');
}
