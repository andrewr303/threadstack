// Runs in the isolated world of every frame of the provider hosts at document_start: the
// extension half of the cookie bridge for pages embedded in Threadkeeper's workspace
// (core/embed/cookie-shim.ts explains why it exists; embed-cookie-main.ts is the page half).
//
// Only in a frame directly inside Threadkeeper's own page (frameMode() === 'workspace'). Anywhere
// else it stays silent, and the page half then never leaves the native document.cookie.
//
// It asks the worker for the cookies a script on this address could read in an ordinary tab
// (`EMBED_COOKIES_GET`; the worker takes the address from the sender, so no URL is sent), hands
// them to the page half, and forwards each assignment the page makes (`EMBED_COOKIE_SET`). The
// events on the document carry only that: the page's own script-visible cookies and the raw
// strings it assigned, which is why a page script listening to them learns nothing new.
import { TOP_LEVEL_MARK, frameMode, inProfileFrame, paneHasFlag, wantsTopLevelView } from '../core/embed/frame.js';
import { PROFILE_MARK } from '../core/embed/profile-page.js';
import {
  COOKIE_JAR_EVENT,
  COOKIE_READY_EVENT,
  COOKIE_SET_EVENT,
  MAX_JAR_LENGTH,
  parseSetDetail,
} from '../core/embed/cookie-shim.js';
import type { EmbedFrameEvent } from '../core/workspace/types.js';
import { EMBED_GESTURE_SOURCE } from './manager/workspace/adoption.js';

/** sessionStorage key of the last cookie string, for a synchronous first value after a reload. */
export const COOKIE_CACHE_KEY = 'threadkeeper.embedCookies';
const REFRESH_MS = 1000;

export interface CookieBridgeEnv {
  doc: Document;
  win: Window;
  storage: Storage | null;
  /**
   * This frame is a profile frame (credentialless). Sent with every cookie message, so the worker
   * knows which jar the frame reads and writes before the page has made a single request.
   */
  profile?: boolean;
  /** Best effort. False when the extension is gone; `done` then never runs. */
  send(message: EmbedFrameEvent, done: (response: unknown) => void): boolean;
}

export function startCookieBridge(env: CookieBridgeEnv): { stop(): void } {
  const { doc, win, storage } = env;
  const profile = env.profile === true;
  let cached: string | null = null;
  try {
    const value = storage?.getItem(COOKIE_CACHE_KEY);
    cached = typeof value === 'string' && value.length <= MAX_JAR_LENGTH ? value : null;
  } catch {
    // storage blocked for this frame
  }
  let current = cached;
  let fresh = false;
  let stopped = false;
  /** Every assignment up to this sequence number has been sent to the worker. */
  let ackSeq = 0;
  let lastDelivered = '';
  let inflight = false;
  let again = false;
  let sending = false;
  const queue: Array<{ seq: number; cookie: string }> = [];
  // Assignments made while the page ran on the cached copy, held until the worker answers.
  const held: Array<{ seq: number; cookie: string }> = [];

  const deliver = (cookie: string, ack: number, force = false) => {
    const detail = JSON.stringify({ cookie, ack });
    if (!force && detail === lastDelivered) return;
    lastDelivered = detail;
    try {
      doc.dispatchEvent(new CustomEvent(COOKIE_JAR_EVENT, { detail }));
    } catch {
      // never disturb the page
    }
  };

  const send = (message: EmbedFrameEvent, done: (response: unknown) => void) => {
    if (stopped) return;
    if (!env.send(message, done)) stop();
  };

  const pump = () => {
    if (sending || queue.length === 0) return;
    const item = queue.shift()!;
    sending = true;
    send({ type: 'EMBED_COOKIE_SET', cookie: item.cookie, profile }, () => {
      sending = false;
      // Sent, whatever the worker made of it: the refresh shows what the jar now holds.
      ackSeq = Math.max(ackSeq, item.seq);
      refresh();
      pump();
    });
  };

  const onFresh = (cookie: string, ackAtRequest: number) => {
    let ack = ackAtRequest;
    if (!fresh) {
      fresh = true;
      if (held.length > 0) {
        if (cookie === cached) {
          queue.push(...held);
        } else {
          // The cached copy was stale (another account was switched in since, or the site
          // changed its cookies), so what the page wrote while reading it is dropped rather
          // than written into the jar that is signed in now.
          ackSeq = Math.max(ackSeq, ...held.map((h) => h.seq));
          ack = Math.max(ack, ackSeq);
        }
        held.length = 0;
      }
    }
    if (cookie !== current) {
      current = cookie;
      try {
        storage?.setItem(COOKIE_CACHE_KEY, cookie);
      } catch {
        // storage full or blocked
      }
    }
    deliver(cookie, ack);
    pump();
  };

  function refresh(): void {
    if (stopped) return;
    if (inflight) {
      again = true;
      return;
    }
    inflight = true;
    const ackAtRequest = ackSeq;
    send({ type: 'EMBED_COOKIES_GET', profile }, (response) => {
      inflight = false;
      const r = response as { ok?: unknown; cookie?: unknown } | undefined;
      if (r?.ok === true && typeof r.cookie === 'string' && r.cookie.length <= MAX_JAR_LENGTH) onFresh(r.cookie, ackAtRequest);
      if (again) {
        again = false;
        refresh();
      }
    });
  }

  const onSet = (event: Event) => {
    const parsed = parseSetDetail((event as CustomEvent).detail);
    if (!parsed) return;
    if (!fresh && cached !== null) held.push(parsed);
    else {
      queue.push(parsed);
      pump();
    }
  };
  const onReady = () => {
    if (current !== null) deliver(current, ackSeq, true);
  };
  const onWake = () => refresh();

  doc.addEventListener(COOKIE_SET_EVENT, onSet);
  doc.addEventListener(COOKIE_READY_EVENT, onReady);
  win.addEventListener('focus', onWake);
  win.addEventListener('pageshow', onWake);
  const timer = win.setInterval(() => {
    if (doc.visibilityState === 'visible') refresh();
  }, REFRESH_MS);

  function stop(): void {
    if (stopped) return;
    stopped = true;
    win.clearInterval(timer);
    doc.removeEventListener(COOKIE_SET_EVENT, onSet);
    doc.removeEventListener(COOKIE_READY_EVENT, onReady);
    win.removeEventListener('focus', onWake);
    win.removeEventListener('pageshow', onWake);
  }

  if (cached !== null) deliver(cached, 0);
  refresh();
  return { stop };
}

/**
 * Leave the marks the page-world half acts on (embed-cookie-main.ts runs right after this
 * script, before any script of the page). Only this world knows that the frame sits directly
 * inside Threadkeeper's own page, so only it may ask for those changes.
 */
export function markEmbeddedDocument(
  doc: Pick<Document, 'documentElement'>,
  options: { profile: boolean; topLevel: boolean }
): void {
  try {
    const root = doc.documentElement;
    if (!root) return;
    if (options.profile) root.setAttribute(PROFILE_MARK, '');
    if (options.topLevel) root.setAttribute(TOP_LEVEL_MARK, '');
  } catch {
    // never disturb the page
  }
}

/**
 * Tells the workspace page (this frame's parent) about each real click, so it can tell a tab this
 * page opens from one the user opens next to the workspace (manager/workspace/adoption.ts). The
 * message carries nothing but the fact of the click. Capture phase, so it is posted before the
 * page's own handler opens anything.
 */
export function startGestureRelay(
  win: Pick<Window, 'addEventListener' | 'removeEventListener'>,
  parent: Pick<Window, 'postMessage'>,
  parentOrigin: string
): { stop(): void } {
  const onClick = (event: Event) => {
    if (!event.isTrusted) return;
    try {
      parent.postMessage({ source: EMBED_GESTURE_SOURCE }, parentOrigin);
    } catch {
      // never disturb the page
    }
  };
  // auxclick: a middle click opens a link in a new tab without a click event.
  win.addEventListener('click', onClick, true);
  win.addEventListener('auxclick', onClick, true);
  return {
    stop() {
      win.removeEventListener('click', onClick, true);
      win.removeEventListener('auxclick', onClick, true);
    },
  };
}

function sendToExtension(message: EmbedFrameEvent, done: (response: unknown) => void): boolean {
  try {
    if (typeof chrome === 'undefined' || !chrome.runtime?.id) return false;
    chrome.runtime.sendMessage(message, (response: unknown) => {
      // lastError (worker restarting, extension reloaded) must be read or Chrome logs it.
      done(chrome.runtime.lastError ? undefined : response);
    });
    return true;
  } catch {
    return false;
  }
}

const BRIDGE_GUARD = Symbol.for('threadkeeper.embedBridgeStarted');

try {
  const isolated = globalThis as unknown as Record<symbol, boolean>;
  if (!isolated[BRIDGE_GUARD] && frameMode() === 'workspace') {
    isolated[BRIDGE_GUARD] = true;
    const profile = inProfileFrame(window);
    markEmbeddedDocument(document, {
      profile,
      // The workspace can switch this off for a tab (Settings); the option travels in the frame name.
      topLevel: wantsTopLevelView(window.location.hostname) && !paneHasFlag('n'),
    });
    let storage: Storage | null = null;
    try {
      storage = window.sessionStorage;
    } catch {
      // storage blocked for this frame
    }
    startCookieBridge({ doc: document, win: window, storage, send: sendToExtension, profile });
    // frameMode() checked the parent is this extension's page; its origin is the only target.
    // Built from the parts, as frame.ts does: URL#origin can be "null" for an unregistered scheme.
    const own = new URL(chrome.runtime.getURL(''));
    startGestureRelay(window, window.parent, `${own.protocol}//${own.host}`);
  }
} catch {
  // never disturb the page
}
