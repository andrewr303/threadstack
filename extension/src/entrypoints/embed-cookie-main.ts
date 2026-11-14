// Runs in the MAIN world of every frame of the provider hosts at document_start: the page-world
// half of the cookie bridge for pages embedded in Threadkeeper's workspace (core/embed/
// cookie-shim.ts explains why it exists).
//
// It acts only in a frame directly inside an extension page. This world cannot call
// chrome.runtime to learn Threadkeeper's own origin, so it checks for any extension origin and
// then stays inert: document.cookie keeps its native behaviour until the isolated half (which
// does check the exact origin) delivers a cookie string. Inside another extension's page that
// never happens. In a top-level tab or any other frame nothing is installed.
//
// What crosses between the halves is only what this page could read and write in an ordinary
// tab: the script-visible cookies of its own address, and the raw strings it assigns. A page
// script listening to these events therefore learns nothing it could not read itself.
// Nothing here may throw into the page.
import { embeddedInExtensionPage } from '../core/embed/frame.js';
import { installCookieShim } from '../core/embed/cookie-shim.js';

const SHIM_FLAG = Symbol.for('threadkeeper.embedCookieShim');

try {
  if (embeddedInExtensionPage() && !Reflect.get(window, SHIM_FLAG)) {
    Reflect.defineProperty(window, SHIM_FLAG, { value: true });
    installCookieShim({
      proto: Document.prototype,
      doc: document,
      events: document,
      context: () => ({ host: location.hostname, path: location.pathname, now: Date.now() }),
    });
  }
} catch {
  // never disturb the page
}
