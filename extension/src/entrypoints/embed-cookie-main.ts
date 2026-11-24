// Runs in the MAIN world of every frame of the provider hosts at document_start: the page-world
// half of the cookie bridge for pages embedded in ThreadStack's workspace (core/embed/
// cookie-shim.ts explains why it exists).
//
// It acts only in a frame directly inside an extension page. This world cannot call
// chrome.runtime to learn ThreadStack's own origin, so it checks for any extension origin and
// then stays inert: document.cookie keeps its native behaviour until the isolated half (which
// does check the exact origin) delivers a cookie string. Inside another extension's page that
// never happens. In a top-level tab or any other frame nothing is installed.
//
// What crosses between the halves is only what this page could read and write in an ordinary
// tab: the script-visible cookies of its own address, and the raw strings it assigns. A page
// script listening to these events therefore learns nothing it could not read itself.
// Nothing here may throw into the page.
//
// Two more things happen here, each only when the isolated half left its mark on the document
// (it runs first and is the one that knows the frame is inside ThreadStack's own page):
// - a site that hides its navigation when framed is made to answer that check like a top-level
//   page (core/embed/profile-page.ts presentAsTopLevel);
// - in a profile frame (the workspace's separate cookie partition), service workers are refused
//   and cookie assignments are stored in the form that partition accepts.
import { TOP_LEVEL_MARK, embeddedInExtensionPage } from '../core/embed/frame.js';
import { installCookieShim } from '../core/embed/cookie-shim.js';
import { PROFILE_MARK, asCrossSiteAssignment, consumeMark, presentAsTopLevel, refuseBackgroundWorkers } from '../core/embed/profile-page.js';

const SHIM_FLAG = Symbol.for('threadkeeper.embedCookieShim');

try {
  if (embeddedInExtensionPage() && !Reflect.get(window, SHIM_FLAG)) {
    Reflect.defineProperty(window, SHIM_FLAG, { value: true });
    // Both marks are read (and removed) before anything else, so no page script ever sees them.
    const topLevel = consumeMark(document, TOP_LEVEL_MARK);
    const profile = consumeMark(document, PROFILE_MARK);
    if (profile) refuseBackgroundWorkers(window);
    installCookieShim({
      proto: Document.prototype,
      doc: document,
      events: document,
      context: () => ({ host: location.hostname, path: location.pathname, now: Date.now() }),
      rewriteNative: profile && location.protocol === 'https:' ? asCrossSiteAssignment : undefined,
    });
    // Last: from here on `window.self` is no longer this window.
    if (topLevel) presentAsTopLevel(window, document);
  }
} catch {
  // never disturb the page
}
