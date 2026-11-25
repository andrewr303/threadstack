"use strict";
(() => {
  // src/core/workspace/types.ts
  var EMBED_FRAME_NAME_PREFIX = "tk-pane~";

  // src/core/embed/frame.ts
  function extensionOrigin() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return null;
      const url = new URL(chrome.runtime.getURL(""));
      return url.host ? `${url.protocol}//${url.host}` : null;
    } catch {
      return null;
    }
  }
  function isTop(win) {
    try {
      return win === win.top;
    } catch {
      return false;
    }
  }
  function frameMode(win = window) {
    if (isTop(win)) return "top";
    try {
      const ancestors = win.location.ancestorOrigins;
      if (!ancestors || ancestors.length !== 1) return "other";
      const own = extensionOrigin();
      return own !== null && ancestors[0] === own ? "workspace" : "other";
    } catch {
      return "other";
    }
  }
  var MAX_PANE_NAME = 400;
  function parsePaneName(name) {
    if (typeof name !== "string" || !name.startsWith(EMBED_FRAME_NAME_PREFIX)) return null;
    let rest = name.slice(EMBED_FRAME_NAME_PREFIX.length);
    let flags = "";
    if (rest.startsWith("!")) {
      const end = rest.indexOf("!", 1);
      if (end === -1) return null;
      flags = rest.slice(1, end);
      if (!/^[a-z]{0,8}$/.test(flags)) return null;
      rest = rest.slice(end + 1);
    }
    return rest.length > 0 && rest.length <= MAX_PANE_NAME ? { id: rest, flags } : null;
  }
  function readName(win) {
    try {
      return typeof win.name === "string" ? win.name : "";
    } catch {
      return "";
    }
  }
  function paneHasFlag(flag, win = window) {
    return parsePaneName(readName(win))?.flags.includes(flag) ?? false;
  }
  function inProfileFrame(win = window) {
    try {
      return win.credentialless === true;
    } catch {
      return false;
    }
  }
  var TOP_LEVEL_VIEW_HOSTS = ["claude.ai"];
  function wantsTopLevelView(hostname) {
    const host = hostname.toLowerCase();
    return TOP_LEVEL_VIEW_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
  }
  var TOP_LEVEL_MARK = "data-tk-top-level";

  // src/core/embed/profile-page.ts
  var PROFILE_MARK = "data-tk-profile";

  // src/core/embed/cookie-shim.ts
  var COOKIE_JAR_EVENT = "threadkeeper:embed-cookie-jar";
  var COOKIE_SET_EVENT = "threadkeeper:embed-cookie-set";
  var COOKIE_READY_EVENT = "threadkeeper:embed-cookie-ready";
  var MAX_ASSIGNMENT_LENGTH = 8192;
  var MAX_JAR_LENGTH = 8e5;
  function parseSetDetail(detail) {
    if (typeof detail !== "string" || detail.length > MAX_ASSIGNMENT_LENGTH + 100) return null;
    try {
      const value = JSON.parse(detail);
      if (typeof value !== "object" || value === null) return null;
      const { seq, cookie } = value;
      if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 1) return null;
      if (typeof cookie !== "string" || cookie.length === 0 || cookie.length > MAX_ASSIGNMENT_LENGTH) return null;
      return { seq, cookie };
    } catch {
      return null;
    }
  }

  // src/entrypoints/manager/workspace/adoption.ts
  var EMBED_GESTURE_SOURCE = "threadkeeper-embed-gesture";

  // src/entrypoints/embed-bridge.ts
  var COOKIE_CACHE_KEY = "threadkeeper.embedCookies";
  var REFRESH_MS = 1e3;
  function startCookieBridge(env) {
    const { doc, win, storage } = env;
    const profile = env.profile === true;
    let cached = null;
    try {
      const value = storage?.getItem(COOKIE_CACHE_KEY);
      cached = typeof value === "string" && value.length <= MAX_JAR_LENGTH ? value : null;
    } catch {
    }
    let current = cached;
    let fresh = false;
    let stopped = false;
    let ackSeq = 0;
    let lastDelivered = "";
    let inflight = false;
    let again = false;
    let sending = false;
    const queue = [];
    const held = [];
    const deliver = (cookie, ack, force = false) => {
      const detail = JSON.stringify({ cookie, ack });
      if (!force && detail === lastDelivered) return;
      lastDelivered = detail;
      try {
        doc.dispatchEvent(new CustomEvent(COOKIE_JAR_EVENT, { detail }));
      } catch {
      }
    };
    const send = (message, done) => {
      if (stopped) return;
      if (!env.send(message, done)) stop();
    };
    const pump = () => {
      if (sending || queue.length === 0) return;
      const item = queue.shift();
      sending = true;
      send({ type: "EMBED_COOKIE_SET", cookie: item.cookie, profile }, () => {
        sending = false;
        ackSeq = Math.max(ackSeq, item.seq);
        refresh();
        pump();
      });
    };
    const onFresh = (cookie, ackAtRequest) => {
      let ack = ackAtRequest;
      if (!fresh) {
        fresh = true;
        if (held.length > 0) {
          if (cookie === cached) {
            queue.push(...held);
          } else {
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
        }
      }
      deliver(cookie, ack);
      pump();
    };
    function refresh() {
      if (stopped) return;
      if (inflight) {
        again = true;
        return;
      }
      inflight = true;
      const ackAtRequest = ackSeq;
      send({ type: "EMBED_COOKIES_GET", profile }, (response) => {
        inflight = false;
        const r = response;
        if (r?.ok === true && typeof r.cookie === "string" && r.cookie.length <= MAX_JAR_LENGTH) onFresh(r.cookie, ackAtRequest);
        if (again) {
          again = false;
          refresh();
        }
      });
    }
    const onSet = (event) => {
      const parsed = parseSetDetail(event.detail);
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
    win.addEventListener("focus", onWake);
    win.addEventListener("pageshow", onWake);
    const timer = win.setInterval(() => {
      if (doc.visibilityState === "visible") refresh();
    }, REFRESH_MS);
    function stop() {
      if (stopped) return;
      stopped = true;
      win.clearInterval(timer);
      doc.removeEventListener(COOKIE_SET_EVENT, onSet);
      doc.removeEventListener(COOKIE_READY_EVENT, onReady);
      win.removeEventListener("focus", onWake);
      win.removeEventListener("pageshow", onWake);
    }
    if (cached !== null) deliver(cached, 0);
    refresh();
    return { stop };
  }
  function markEmbeddedDocument(doc, options) {
    try {
      const root = doc.documentElement;
      if (!root) return;
      if (options.profile) root.setAttribute(PROFILE_MARK, "");
      if (options.topLevel) root.setAttribute(TOP_LEVEL_MARK, "");
    } catch {
    }
  }
  function startGestureRelay(win, parent, parentOrigin) {
    const onClick = (event) => {
      if (!event.isTrusted) return;
      try {
        parent.postMessage({ source: EMBED_GESTURE_SOURCE }, parentOrigin);
      } catch {
      }
    };
    win.addEventListener("click", onClick, true);
    win.addEventListener("auxclick", onClick, true);
    return {
      stop() {
        win.removeEventListener("click", onClick, true);
        win.removeEventListener("auxclick", onClick, true);
      }
    };
  }
  function sendToExtension(message, done) {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime?.id) return false;
      chrome.runtime.sendMessage(message, (response) => {
        done(chrome.runtime.lastError ? void 0 : response);
      });
      return true;
    } catch {
      return false;
    }
  }
  var BRIDGE_GUARD = Symbol.for("threadkeeper.embedBridgeStarted");
  try {
    const isolated = globalThis;
    if (!isolated[BRIDGE_GUARD] && frameMode() === "workspace") {
      isolated[BRIDGE_GUARD] = true;
      const profile = inProfileFrame(window);
      markEmbeddedDocument(document, {
        profile,
        // The workspace can switch this off for a tab (Settings); the option travels in the frame name.
        topLevel: wantsTopLevelView(window.location.hostname) && !paneHasFlag("n")
      });
      let storage = null;
      try {
        storage = window.sessionStorage;
      } catch {
      }
      startCookieBridge({ doc: document, win: window, storage, send: sendToExtension, profile });
      const own = new URL(chrome.runtime.getURL(""));
      startGestureRelay(window, window.parent, `${own.protocol}//${own.host}`);
    }
  } catch {
  }
})();
