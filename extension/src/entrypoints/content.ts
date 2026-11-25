import {
  extractProviderProjectName,
  extractRepositoryInfo,
  extractVisibleDomConversation,
  grokXConversationToExtraction,
  type CaptureSiteContext,
  type DomExtractionResult,
} from '../core/dom-capture.js';
import {
  IDENTITY_REPLAY_SOURCE,
  parseIdentityMessage,
  parseSiteConversation,
  parseSiteDataMessage,
  siteConversationTitle,
  type SiteConversation,
} from '../core/site-api.js';
import { mergeGrokXMessages, parseGrokXCaptureMessage, type GrokXMessage } from '../core/grok-x.js';
import { validateWindowPostMessage } from '../core/messaging.js';
import { isSyncProviderId, type SyncEvent } from '../core/history-sync.js';
import { readSignedInIdentity, runApiSync } from '../core/site-history.js';
import { loadSidebarList } from '../core/sidebar-history.js';
import {
  detectProviderFromUrl,
  extractConversationIdFromUrl,
  isXHostname,
  providerCategory,
  type ProviderId,
} from '../core/providers.js';
import { frameMode, inProfileFrame, paneName } from '../core/embed/frame.js';
import { agentStateOf, readAgentPage, shouldReportAgentObservation } from '../core/embed/agent-state.js';
import { parseIdentity, providerForIdentitySource } from '../core/accounts/identity.js';
import { realmForProvider, realmOwnsHost, switchableRealms } from '../core/workspace/realms.js';
import type { AgentState, EmbedFrameEvent } from '../core/workspace/types.js';
import { createSessionDeliveryHandler } from '../core/embed/session-delivery.js';

const OVERLAY_DIALOG_ID = 'threadkeeper-overlay-root';

/**
 * Content scripts run in every frame of the hosts they match. This one works in a top-level tab
 * and in a page embedded directly in ThreadStack's workspace; in any other frame it registers
 * nothing (see the guard at the bottom).
 */
const FRAME_MODE = frameMode();
const IN_WORKSPACE = FRAME_MODE === 'workspace';

interface SavedHostState {
  scrollX: number;
  scrollY: number;
  activeElement: Element | null;
  selectionStart: number | null;
  selectionEnd: number | null;
  selectionRange: Range | null;
  scrollableAncestors: Array<{
    element: HTMLElement;
    scrollTop: number;
    scrollLeft: number;
  }>;
}

let activeHandshakeToken = '';
let savedHostState: SavedHostState | null = null;
let overlayWatchdog: ReturnType<typeof setTimeout> | null = null;
const OVERLAY_LOAD_TIMEOUT_MS = 5000;
let captureDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let lastCapturedFingerprint = '';

function captureCurrentPageState(): SavedHostState {
  const active = document.activeElement;
  let selectionStart: number | null = null;
  let selectionEnd: number | null = null;
  let selectionRange: Range | null = null;
  if (
    active instanceof HTMLTextAreaElement ||
    active instanceof HTMLInputElement
  ) {
    try {
      selectionStart = active.selectionStart;
      selectionEnd = active.selectionEnd;
    } catch {
      // ignore input types without selection
    }
  } else if (active instanceof HTMLElement && active.isContentEditable) {
    try {
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        selectionRange = sel.getRangeAt(0).cloneRange();
      }
    } catch {
      // ignore selection clone failures
    }
  }

  const scrollableAncestors: SavedHostState['scrollableAncestors'] = [];
  const seenElements = new Set<HTMLElement>();
  let cursor: Element | null = active ?? document.scrollingElement;
  while (cursor) {
    if (cursor instanceof HTMLElement && (cursor.scrollTop !== 0 || cursor.scrollLeft !== 0)) {
      seenElements.add(cursor);
      scrollableAncestors.push({
        element: cursor,
        scrollTop: cursor.scrollTop,
        scrollLeft: cursor.scrollLeft,
      });
    }
    cursor = cursor.parentElement;
  }

  const allHostNodes = document.querySelectorAll('*');
  for (let i = 0; i < allHostNodes.length; i++) {
    const node = allHostNodes[i];
    if (
      node instanceof HTMLElement &&
      !seenElements.has(node) &&
      node.id !== OVERLAY_DIALOG_ID &&
      !node.closest(`#${OVERLAY_DIALOG_ID}`) &&
      (node.scrollTop !== 0 || node.scrollLeft !== 0)
    ) {
      seenElements.add(node);
      scrollableAncestors.push({
        element: node,
        scrollTop: node.scrollTop,
        scrollLeft: node.scrollLeft,
      });
    }
  }

  return {
    scrollX: window.scrollX,
    scrollY: window.scrollY,
    activeElement: active,
    selectionStart,
    selectionEnd,
    selectionRange,
    scrollableAncestors,
  };
}

function restoreHostPageState(state: SavedHostState | null): void {
  if (!state) return;
  window.scrollTo(state.scrollX, state.scrollY);
  for (const item of state.scrollableAncestors) {
    if (document.contains(item.element)) {
      item.element.scrollTop = item.scrollTop;
      item.element.scrollLeft = item.scrollLeft;
    }
  }
  if (
    state.activeElement &&
    state.activeElement instanceof HTMLElement &&
    document.contains(state.activeElement)
  ) {
    state.activeElement.focus({ preventScroll: true });
    if (
      (state.activeElement instanceof HTMLTextAreaElement ||
        state.activeElement instanceof HTMLInputElement) &&
      state.selectionStart !== null &&
      state.selectionEnd !== null
    ) {
      try {
        state.activeElement.setSelectionRange(
          state.selectionStart,
          state.selectionEnd
        );
      } catch {
        // ignore
      }
    } else if (state.activeElement.isContentEditable && state.selectionRange) {
      try {
        const sel = window.getSelection();
        if (sel) {
          sel.removeAllRanges();
          sel.addRange(state.selectionRange);
        }
      } catch {
        // ignore
      }
    }
  }
}

export function closeOverlayAndRestore(): void {
  if (overlayWatchdog) {
    clearTimeout(overlayWatchdog);
    overlayWatchdog = null;
  }
  const existing = document.getElementById(OVERLAY_DIALOG_ID);
  if (existing) {
    if (existing instanceof HTMLDialogElement && existing.open) {
      try {
        existing.close();
      } catch {
        // ignore
      }
    }
    existing.remove();
  }
  activeHandshakeToken = '';
  const toRestore = savedHostState;
  savedHostState = null;
  restoreHostPageState(toRestore);
}

export function openOrToggleOverlay(handshakeToken: string): {
  state: 'opened' | 'closed';
} {
  const existing = document.getElementById(OVERLAY_DIALOG_ID);
  if (existing) {
    closeOverlayAndRestore();
    return { state: 'closed' };
  }

  savedHostState = captureCurrentPageState();
  activeHandshakeToken = handshakeToken;

  const dialog = document.createElement('dialog');
  dialog.id = OVERLAY_DIALOG_ID;
  dialog.setAttribute('aria-label', 'ThreadStack Workbench');
  dialog.style.cssText = [
    'padding: 0',
    'border: 1px solid rgba(22, 21, 20, 0.22)',
    'border-radius: 10px',
    'width: min(94vw, 1360px)',
    'height: min(90vh, 880px)',
    'max-width: 1360px',
    'max-height: 880px',
    'margin: auto',
    'background: #F6F4EF',
    'box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28)',
    'overflow: hidden',
  ].join(';');

  const iframe = document.createElement('iframe');
  iframe.id = 'threadkeeper-overlay-iframe';
  const extUrl = chrome.runtime.getURL(
    `manager.html?surface=overlay&token=${encodeURIComponent(handshakeToken)}`
  );
  iframe.src = extUrl;
  iframe.title = 'ThreadStack Conversation Manager';
  iframe.style.cssText =
    'width: 100%; height: 100%; border: 0; display: block; background: transparent;';

  dialog.addEventListener('cancel', (ev) => {
    ev.preventDefault();
    if (iframe.contentWindow) {
      const extOrigin = new URL(chrome.runtime.getURL('')).origin;
      iframe.contentWindow.postMessage(
        {
          source: 'threadkeeper-host-overlay',
          handshakeToken: activeHandshakeToken,
          action: 'REQUEST_ESCAPE',
        },
        extOrigin
      );
    } else {
      closeOverlayAndRestore();
    }
  });

  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) {
      closeOverlayAndRestore();
    }
  });

  dialog.appendChild(iframe);
  document.body.appendChild(dialog);
  if (typeof dialog.showModal === 'function') {
    dialog.showModal();
  } else {
    dialog.setAttribute('open', 'true');
  }
  iframe.focus();
  armOverlayWatchdog(handshakeToken);

  return { state: 'opened' };
}

/**
 * Self-healing: if the manager frame has not redeemed its handshake in time it
 * never loaded (blocked by the browser, an extension or the page), so swap the
 * dead overlay for the full-page library instead of leaving an error page.
 */
function armOverlayWatchdog(token: string): void {
  if (overlayWatchdog) clearTimeout(overlayWatchdog);
  overlayWatchdog = setTimeout(() => {
    overlayWatchdog = null;
    if (activeHandshakeToken !== token || !document.getElementById(OVERLAY_DIALOG_ID)) return;
    try {
      chrome.runtime.sendMessage(
        { type: 'OVERLAY_FRAME_STATUS' },
        (resp: { ok?: boolean; redeemed?: boolean } | undefined) => {
          if (chrome.runtime.lastError || !resp?.ok || resp.redeemed) return;
          if (activeHandshakeToken !== token) return;
          closeOverlayAndRestore();
          chrome.runtime.sendMessage({ type: 'OPEN_MANAGER_FALLBACK', reason: 'overlay_frame_blocked' });
        }
      );
    } catch {
      // extension context invalidated (reloaded); nothing to fall back to
    }
  }, OVERLAY_LOAD_TIMEOUT_MS);
}

let pendingExplicitInvoke = false;
/**
 * The background's token for this tab when the capture was asked for (overlay opened, or
 * "Capture this tab"), and which of the two: only "capture" opens explicit-only providers.
 */
let pendingExplicitToken: string | null = null;
let pendingExplicitKind: 'overlay' | 'capture' = 'overlay';

/** Set when the background confirms this page is a site the user added (never from the page). */
let captureSite: CaptureSiteContext | null = null;

/** Grok on X: messages X's own page loaded for the open conversation (see grok-x-main.ts). */
let grokXConversation: { id: string; messages: GrokXMessage[] } | null = null;

/** ChatGPT / Claude: the conversation data the page itself loaded for the open conversation. */
let siteConversation: SiteConversation | null = null;

/**
 * The conversation on screen: Grok on X from X's own responses, every other site from the DOM.
 * `explicit` is true only when the user chose "Capture this tab" for this page.
 */
function extractCurrentConversation(explicit = false): DomExtractionResult | null {
  const href = window.location.href;
  if (detectProviderFromUrl(href) === 'grok_x') {
    const urlId = extractConversationIdFromUrl(href);
    if (!grokXConversation || (urlId && urlId !== grokXConversation.id)) return null;
    return grokXConversationToExtraction(grokXConversation.id, grokXConversation.messages);
  }
  return extractVisibleDomConversation(document, href, { site: captureSite, explicit });
}

/** What the last capture attempt did, for the "Check this tab" report in Settings → Diagnostics. */
interface CaptureStatus {
  at: string;
  method: 'dom' | 'site_data';
  outcome: 'stored' | 'unchanged' | 'skipped' | 'error' | 'stale_dom' | 'no_conversation' | 'settling';
  detail?: string;
  messages?: number;
}
let lastCaptureStatus: CaptureStatus | null = null;
function noteCapture(status: Omit<CaptureStatus, 'at'>): void {
  lastCaptureStatus = { at: new Date().toISOString(), ...status };
}

function sendCapture(
  payload: Record<string, unknown>,
  explicitInvoke: boolean,
  done: (resp: { ok?: boolean; status?: string; skipped?: string; error?: string } | undefined) => void,
  explicitToken: string | null = null
): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  try {
    const message: Record<string, unknown> = { type: 'PASSIVE_DOM_CAPTURE', explicitInvoke, payload };
    if (explicitToken) message.explicitToken = explicitToken;
    chrome.runtime.sendMessage(message, (resp) => {
      // lastError (service worker restarting, extension reloaded) must be read or Chrome logs it.
      const failed = chrome.runtime.lastError;
      done(failed ? undefined : (resp as { ok?: boolean; status?: string; skipped?: string; error?: string } | undefined));
    });
  } catch {
    // extension context invalidated (reloaded); nothing to send to
  }
}

/**
 * Messages from the MAIN-world script on X. Any page script can post to the window, so the
 * sender must be this window and the payload is fully re-validated; only the Grok
 * conversation that is open (/i/grok, matching ?conversation=) is kept.
 */
function onGrokXWindowMessage(event: MessageEvent): void {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const capture = parseGrokXCaptureMessage(event.data);
  if (!capture) return;
  const href = window.location.href;
  if (detectProviderFromUrl(href) !== 'grok_x') return;
  const urlId = extractConversationIdFromUrl(href);
  const id = capture.restId ?? urlId;
  if (!id || (urlId && urlId !== id)) return;
  const known = grokXConversation?.id === id ? grokXConversation.messages : [];
  grokXConversation = { id, messages: mergeGrokXMessages(known, capture.messages) };
  schedulePassiveDomCapture();
}

/**
 * Messages from the MAIN-world scripts on ChatGPT and Claude (site-data-main.ts). Any page script
 * can post to the window, so the sender must be this window, the payload is fully re-validated,
 * and only the conversation that is open is kept.
 */
function onSiteDataWindowMessage(event: MessageEvent): void {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const data = parseSiteDataMessage(event.data);
  if (!data) return;
  const href = window.location.href;
  const page = detectProviderFromUrl(href);
  if (page !== data.provider) return; // claude.ai/code and /codex are other providers
  const urlId = extractConversationIdFromUrl(href)?.toLowerCase();
  if (!urlId || urlId !== data.conversationId) return;
  const parsed = parseSiteConversation(data.provider, data.json, data.conversationId);
  if (!parsed || parsed.sourceConversationId !== urlId) return;
  siteConversation = parsed;
  scheduleSiteDataCapture();
}

let siteDataTimer: ReturnType<typeof setTimeout> | null = null;
let lastSiteDataFingerprint = '';

function scheduleSiteDataCapture(): void {
  if (siteDataTimer) clearTimeout(siteDataTimer);
  siteDataTimer = setTimeout(() => {
    siteDataTimer = null;
    const conv = siteConversation;
    if (!conv) return;
    // Still the conversation on screen? (The user may have navigated while the response arrived.)
    const urlId = extractConversationIdFromUrl(window.location.href)?.toLowerCase();
    if (urlId !== conv.sourceConversationId) return;
    const fingerprint = `${conv.sourceConversationId}:${conv.title}:${conv.messages.map((m) => `${m.sourceMessageId}:${m.content.length}`).join('|')}`;
    if (fingerprint === lastSiteDataFingerprint) return;
    sendCapture(
      {
        provider: conv.provider,
        sourceConversationId: conv.sourceConversationId,
        branchId: 'main',
        canonicalUrl: conv.canonicalUrl,
        title: siteConversationTitle(conv),
        createdAt: conv.createdAt,
        updatedAt: conv.updatedAt ?? new Date().toISOString(),
        coverage: conv.messages.length > 0 ? 'full' : 'title_only',
        captureSource: 'network_observer',
        messages: conv.messages,
        // The data names the project by id only; the page shows its name.
        providerProjectName: extractProviderProjectName(document, window.location.href),
        modelSlug: conv.modelSlug,
      },
      false,
      (resp) => {
        if (resp?.ok) {
          lastSiteDataFingerprint = fingerprint;
          noteCapture({ method: 'site_data', outcome: 'stored', messages: conv.messages.length });
        } else {
          noteCapture({ method: 'site_data', outcome: resp?.skipped ? 'skipped' : 'error', detail: resp?.skipped });
        }
      }
    );
  }, 300);
}

// ---- Coding-agent sessions: run state and repository ----------------------

/** The run state a coding-agent page shows; null for every other kind of provider. */
function agentStateFor(provider: ProviderId | null): AgentState | null {
  if (!provider || providerCategory(provider) !== 'coding_agent') return null;
  try {
    return agentStateOf(readAgentPage(document));
  } catch {
    return 'unknown';
  }
}

/** Run state and repository facts to add to a capture: only the fields the page showed. */
function sessionFacts(provider: ProviderId): Record<string, string> {
  const facts: Record<string, string> = {};
  const state = agentStateFor(provider);
  if (state && state !== 'unknown') facts.agentState = state;
  try {
    const repo = extractRepositoryInfo(document, window.location.href);
    if (repo.repository) facts.repository = repo.repository;
    if (repo.pullRequestUrl) facts.pullRequestUrl = repo.pullRequestUrl;
    if (repo.gitBranch) facts.gitBranch = repo.gitBranch;
  } catch {
    // a page the reader does not understand adds nothing
  }
  return facts;
}

// ---- Messages to the extension (best effort) ------------------------------

/** Send without retrying: the worker may be asleep or the extension reloaded. Never throws. */
function sendToExtension(message: EmbedFrameEvent, done?: (response: unknown) => void): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  try {
    chrome.runtime.sendMessage(message, (response: unknown) => {
      const failed = chrome.runtime.lastError;
      done?.(failed ? undefined : response);
    });
  } catch {
    // extension context invalidated (reloaded); nothing to send to
  }
}

// ---- Who is signed in -----------------------------------------------------

let lastIdentityKey: string | null = null;

/**
 * Identity responses from the MAIN-world observer (site-data-main.ts). Any page script can post
 * to the window, so the sender must be this window, the payload is fully re-validated, and the
 * identity must belong to the sign-in this page is part of.
 */
function onIdentityWindowMessage(event: MessageEvent): void {
  if (event.source !== window || event.origin !== window.location.origin) return;
  const message = parseIdentityMessage(event.data);
  if (!message) return;
  const provider = providerForIdentitySource(message.kind);
  const realm = realmForProvider(provider);
  if (!realm || !realmOwnsHost(realm, window.location.hostname)) return;
  let identity: ReturnType<typeof parseIdentity> = null;
  try {
    identity = parseIdentity(message.kind, JSON.parse(message.body));
  } catch {
    return;
  }
  if (!identity || typeof identity.key !== 'string' || !identity.key) return;
  if (lastIdentityKey === identity.key) return;
  lastIdentityKey = identity.key;
  sendToExtension({ type: 'ACCOUNT_IDENTITY', provider, identity });
}

/** Sign-in pages of the switchable realms: claude.ai/login, chatgpt.com/auth/login, x.com/i/flow/login. */
const LOGIN_PATH = /^\/(?:auth\/)?(?:login|log-in|signin|sign-in)\/?$|^\/i\/flow\/login\/?$/i;
let signedOutSent = false;

/** On a plain sign-in page of a switchable realm, tell the extension nobody is signed in (once). */
function checkSignedOut(): void {
  if (signedOutSent || !LOGIN_PATH.test(window.location.pathname)) return;
  const host = window.location.hostname;
  const realm = switchableRealms().find((r) => realmOwnsHost(r, host));
  if (!realm) return;
  let login = false;
  try {
    login = readAgentPage(document).login;
  } catch {
    return;
  }
  if (!login) return;
  signedOutSent = true;
  lastIdentityKey = null;
  const onPage = detectProviderFromUrl(window.location.href);
  const provider = onPage && realm.providers.includes(onPage) ? onPage : realm.providers[0];
  sendToExtension({ type: 'ACCOUNT_IDENTITY', provider, identity: null });
}

// ---- Page checks (throttled) ----------------------------------------------

/** Reading controls forces layout, so the page is read at most this often. */
const PAGE_CHECK_MS = 2000;
let pageCheckTimer: ReturnType<typeof setTimeout> | null = null;
let lastPageCheck = 0;

function schedulePageCheck(): void {
  if (pageCheckTimer) return;
  const wait = Math.max(0, lastPageCheck + PAGE_CHECK_MS - Date.now());
  pageCheckTimer = setTimeout(() => {
    pageCheckTimer = null;
    lastPageCheck = Date.now();
    checkSignedOut();
    if (IN_WORKSPACE) reportAgentState();
  }, wait);
}

// ---- Embedded in the workspace --------------------------------------------

/** The SessionTab id the workspace named this frame with, read once per document. */
const EMBED_PANE = IN_WORKSPACE ? paneName() : null;
/** This frame's id in the workspace tab, from the worker's answer to EMBED_HELLO. */
let embedFrameId: number | null = null;

interface NavigationLike extends EventTarget {
  canGoBack?: boolean;
  canGoForward?: boolean;
  back?: () => { committed?: Promise<unknown>; finished?: Promise<unknown> };
  forward?: () => { committed?: Promise<unknown>; finished?: Promise<unknown> };
}

function navigationApi(): NavigationLike | null {
  const nav = (window as unknown as { navigation?: unknown }).navigation;
  return typeof nav === 'object' && nav !== null ? (nav as NavigationLike) : null;
}

/**
 * Commands meant for top-level pages reach every frame of a tab when the worker sends them to
 * the whole tab. An embedded page acts on one only when the worker addressed this frame and
 * said so (`frameId` in the message, as learned from EMBED_HELLO).
 */
const TOP_FRAME_COMMANDS: ReadonlySet<string> = new Set([
  'TK_CAPTURE_NOW',
  'TK_HISTORY_SYNC_RUN',
  'TK_HISTORY_SYNC_CANCEL',
  'TK_HISTORY_LIST_SIDEBAR',
  'TK_HISTORY_IDENTITY',
  'TK_CAPTURE_PROBE',
]);

function addressedToThisFrame(message: { frameId?: unknown }): boolean {
  return FRAME_MODE === 'top' || (embedFrameId !== null && message.frameId === embedFrameId);
}

const HELLO_RETRY_MS = [2000, 10_000];

function sendEmbedHello(attempt = 0): void {
  sendToExtension(
    { type: 'EMBED_HELLO', pane: EMBED_PANE, url: window.location.href, title: document.title, profile: inProfileFrame(window) },
    (response) => {
      const r = response as { ok?: unknown; frameId?: unknown } | undefined;
      if (r?.ok === true && typeof r.frameId === 'number' && Number.isInteger(r.frameId) && r.frameId > 0) {
        embedFrameId = r.frameId;
        return;
      }
      const delay = HELLO_RETRY_MS[attempt];
      if (delay !== undefined) setTimeout(() => sendEmbedHello(attempt + 1), delay);
    }
  );
}

let lastNavKey = '';
let navTimer: ReturnType<typeof setTimeout> | null = null;

function reportNav(): void {
  const nav = navigationApi();
  const message: EmbedFrameEvent = {
    type: 'EMBED_NAV',
    pane: EMBED_PANE,
    url: window.location.href,
    title: document.title,
    canGoBack: nav?.canGoBack === true,
    canGoForward: nav?.canGoForward === true,
  };
  const key = JSON.stringify([message.url, message.title, message.canGoBack, message.canGoForward]);
  if (key === lastNavKey) return;
  lastNavKey = key;
  sendToExtension(message);
}

function scheduleNavReport(): void {
  if (navTimer) return;
  navTimer = setTimeout(() => {
    navTimer = null;
    reportNav();
  }, 150);
}

let lastAgentState: AgentState = 'unknown';
let lastAgentUrl = '';
let lastAgentReportAt = 0;
let lastAgentCheckAt = 0;

function reportAgentState(): void {
  const url = window.location.href;
  const state = agentStateFor(detectProviderFromUrl(url)) ?? 'unknown';
  const now = Date.now();
  lastAgentCheckAt = now;
  // Stable controls stay fresh through a lightweight heartbeat; historical state never does.
  if (!shouldReportAgentObservation(lastAgentUrl ? { state: lastAgentState, url: lastAgentUrl, at: lastAgentReportAt } : null, { state, url }, now)) return;
  lastAgentState = state;
  lastAgentUrl = url;
  lastAgentReportAt = now;
  sendToExtension({ type: 'EMBED_AGENT_STATE', pane: EMBED_PANE, url, state });
}

/** The title lives in <head>, which a document_start script may not have yet. */
function observeTitle(): void {
  const head = document.head;
  if (!head) {
    document.addEventListener('DOMContentLoaded', observeTitle, { once: true });
    return;
  }
  new MutationObserver(scheduleNavReport).observe(head, { childList: true, subtree: true, characterData: true });
}

/** Settle a Navigation API result so a refused traversal does not surface as an unhandled rejection. */
function settle(result: { committed?: Promise<unknown>; finished?: Promise<unknown> } | undefined): void {
  result?.committed?.catch(() => undefined);
  result?.finished?.catch(() => undefined);
}

/** back, forward, reload and navigate (https only) from the workspace page. */
function runEmbedCommand(message: Record<string, unknown>): { ok: boolean; error?: string } {
  const nav = navigationApi();
  switch (message.command) {
    case 'back':
      if (nav && typeof nav.back === 'function') {
        if (nav.canGoBack !== true) return { ok: false, error: 'no_history' };
        settle(nav.back());
      } else {
        history.back();
      }
      return { ok: true };
    case 'forward':
      if (nav && typeof nav.forward === 'function') {
        if (nav.canGoForward !== true) return { ok: false, error: 'no_history' };
        settle(nav.forward());
      } else {
        history.forward();
      }
      return { ok: true };
    case 'reload':
      // After the answer is on its way: the document is about to go.
      setTimeout(() => window.location.reload(), 0);
      return { ok: true };
    case 'navigate': {
      if (typeof message.url !== 'string' || message.url.length > 4096) return { ok: false, error: 'bad_url' };
      let target: URL;
      try {
        target = new URL(message.url);
      } catch {
        return { ok: false, error: 'bad_url' };
      }
      if (target.protocol !== 'https:') return { ok: false, error: 'bad_url' };
      setTimeout(() => window.location.assign(target.href), 0);
      return { ok: true };
    }
    default:
      return { ok: false, error: 'unknown_command' };
  }
}

function startEmbedBridge(): void {
  sendEmbedHello();
  reportNav();
  observeTitle();
  const nav = navigationApi();
  // Same-document navigations (pushState, back) update the history flags without a new load.
  nav?.addEventListener('currententrychange', scheduleNavReport);
  window.addEventListener('popstate', scheduleNavReport);
  window.addEventListener('hashchange', scheduleNavReport);
  window.addEventListener('pageshow', scheduleNavReport);
}

// ---- DOM capture ----------------------------------------------------------

/** The longest a burst of page changes may postpone a capture. A streaming reply or a ticking timer never lets the page go quiet. */
const CAPTURE_MAX_WAIT_MS = 4000;
const CAPTURE_QUIET_MS = 900;
let pendingSince = 0;

/**
 * Right after the URL changes, a single-page app still shows the previous conversation for a
 * moment. Messages from it must not be filed under the new conversation's id, so a capture whose
 * conversation differs from the last one but whose message ids (or text) are the last one's is
 * stale and is retried shortly.
 */
interface LastExtraction {
  conversationId: string;
  keyedIds: Set<string>;
  textFingerprint: string;
}
let lastExtraction: LastExtraction | null = null;
let staleRetries = 0;
const MAX_STALE_RETRIES = 8;

/**
 * Pages without a dependable "still writing" signal (generic readers, added sites, some
 * adapters): a capture is sent only when two reads in a row see the same text, so a reply is not
 * stored half-written. Explicit captures skip the wait.
 */
const SETTLE_RECHECK_MS = 1500;
let lastUnsettledFingerprint = '';
let settleTimer: ReturnType<typeof setTimeout> | null = null;

function textFingerprintOf(messages: DomExtractionResult['messages']): string {
  return messages.map((m) => `${m.role}:${m.content}`).join('␞');
}

function keyedIdsOf(messages: DomExtractionResult['messages']): Set<string> {
  return new Set(messages.map((m) => m.sourceMessageId).filter((id) => !/_m_\d+(#\d+)?$/.test(id)));
}

function isStaleAfterNavigation(extracted: DomExtractionResult): boolean {
  const last = lastExtraction;
  if (!last || last.conversationId === extracted.sourceConversationId || extracted.messages.length === 0) return false;
  for (const id of keyedIdsOf(extracted.messages)) if (last.keyedIds.has(id)) return true;
  return last.textFingerprint !== '' && last.textFingerprint === textFingerprintOf(extracted.messages);
}

function schedulePassiveDomCapture(
  explicitInvoke = false,
  explicitToken: string | null = null,
  explicitKind: 'overlay' | 'capture' = 'overlay'
): void {
  if (explicitInvoke) {
    pendingExplicitInvoke = true;
    if (explicitToken) {
      pendingExplicitToken = explicitToken;
      pendingExplicitKind = explicitKind;
    }
  }
  if (captureDebounceTimer) {
    clearTimeout(captureDebounceTimer);
  }
  const now = Date.now();
  if (pendingSince === 0) pendingSince = now;
  const isExplicit = pendingExplicitInvoke;
  // Quiet for 900 ms, but never later than 4 s after the first change in this burst.
  const delay = isExplicit ? 50 : Math.max(50, Math.min(CAPTURE_QUIET_MS, pendingSince + CAPTURE_MAX_WAIT_MS - now));
  captureDebounceTimer = setTimeout(() => {
    const useExplicit = pendingExplicitInvoke;
    const useToken = useExplicit ? pendingExplicitToken : null;
    const useKind = pendingExplicitKind;
    pendingExplicitInvoke = false;
    pendingExplicitToken = null;
    pendingExplicitKind = 'overlay';
    pendingSince = 0;
    captureDebounceTimer = null;
    const extracted = extractCurrentConversation(Boolean(useToken) && useKind === 'capture');
    if (!extracted) {
      noteCapture({ method: 'dom', outcome: 'no_conversation', detail: 'The page is not an open conversation yet.' });
      return;
    }
    if (isStaleAfterNavigation(extracted) && staleRetries < MAX_STALE_RETRIES) {
      staleRetries += 1;
      noteCapture({ method: 'dom', outcome: 'stale_dom', detail: 'Waiting for the page to replace the previous conversation.' });
      captureDebounceTimer = setTimeout(() => schedulePassiveDomCapture(useExplicit, useToken, useKind), 700);
      return;
    }
    staleRetries = 0;

    const facts = sessionFacts(extracted.provider);
    // A run that changes state, or a repository that appears, is worth a capture even when the
    // messages did not change.
    const fingerprint = `${extracted.provider}:${extracted.sourceConversationId}:${extracted.branchId}:${extracted.title}:${extracted.providerProjectName ?? ''}:${JSON.stringify(facts)}:${extracted.messages.map((m) => `${m.sourceMessageId}:${m.content.length}`).join('|')}`;
    if (!useExplicit && fingerprint === lastCapturedFingerprint) {
      noteCapture({ method: 'dom', outcome: 'unchanged', messages: extracted.messages.length });
      return;
    }
    if (!useExplicit && extracted.stabilize) {
      const textPrint = `${fingerprint}␞${textFingerprintOf(extracted.messages)}`;
      if (textPrint !== lastUnsettledFingerprint) {
        lastUnsettledFingerprint = textPrint;
        noteCapture({ method: 'dom', outcome: 'settling', detail: 'Waiting for the page to stop changing.', messages: extracted.messages.length });
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          schedulePassiveDomCapture();
        }, SETTLE_RECHECK_MS);
        return;
      }
    }
    lastUnsettledFingerprint = '';

    sendCapture(
      {
        provider: extracted.provider,
        sourceConversationId: extracted.sourceConversationId,
        branchId: extracted.branchId,
        canonicalUrl: extracted.canonicalUrl,
        title: extracted.title,
        createdAt: null,
        updatedAt: new Date().toISOString(),
        coverage: extracted.coverage,
        captureSource: 'dom_observer',
        messages: extracted.messages,
        providerProjectName: extracted.providerProjectName,
        modelSlug: extracted.modelSlug,
        ...facts,
      },
      useExplicit,
      (resp) => {
        if (resp?.ok) {
          lastCapturedFingerprint = fingerprint;
          lastExtraction = {
            conversationId: extracted.sourceConversationId,
            keyedIds: keyedIdsOf(extracted.messages),
            textFingerprint: textFingerprintOf(extracted.messages),
          };
          noteCapture({ method: 'dom', outcome: 'stored', messages: extracted.messages.length });
        } else {
          noteCapture({ method: 'dom', outcome: resp?.skipped ? 'skipped' : 'error', detail: resp?.skipped ?? resp?.error ?? 'No answer from the extension.' });
        }
      },
      useToken
    );
  }, delay);
}

// ---- Catch up (history sync) ----------------------------------------------

let syncCancelled = false;
/** The reader running in this page, if any. A newer run replaces it (see startApiSync). */
let currentSync: { runId: string; cancelled: boolean } | null = null;

const sleepMs = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Send one event; false when the worker no longer wants this run (it ended, or the worker restarted). */
async function emitSyncEvent(event: SyncEvent): Promise<boolean> {
  try {
    // The worker replies after storage completes. Await it before sending done,
    // which may close an owned source tab and end the run.
    const reply = await chrome.runtime.sendMessage({ type: 'HISTORY_SYNC_EVENT', event });
    return Boolean(reply?.ok);
  } catch {
    return false;
  }
}

/** Start the signed-in reader for this site. Only the site this page belongs to can be read. */
function startApiSync(message: Record<string, unknown>): { ok: boolean; error?: string } {
  const provider = message.provider;
  const host = window.location.hostname.toLowerCase();
  const onChatGpt = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com';
  const onClaude = host === 'claude.ai' || host.endsWith('.claude.ai');
  if ((provider !== 'chatgpt' || !onChatGpt) && (provider !== 'claude' || !onClaude)) return { ok: false, error: 'wrong_site' };
  if (typeof message.runId !== 'string' || typeof message.sinceMs !== 'number' || !Number.isFinite(message.sinceMs)
    || typeof message.max !== 'number' || !Number.isFinite(message.max)) {
    return { ok: false, error: 'bad_request' };
  }
  // A reader still going here belongs to a run the worker has given up on (it stopped, or timed
  // the page out): the new run replaces it instead of being refused as busy.
  if (currentSync) currentSync.cancelled = true;
  const run = { runId: message.runId, cancelled: false };
  currentSync = run;
  const known: Record<string, string> = {};
  if (typeof message.known === 'object' && message.known !== null) {
    for (const [k, v] of Object.entries(message.known as Record<string, unknown>)) if (typeof v === 'string') known[k.toLowerCase()] = v;
  }
  void runApiSync({
    provider,
    runId: message.runId,
    sinceMs: message.sinceMs,
    max: message.scope === 'all' ? Number.MAX_SAFE_INTEGER : Math.min(500, Math.max(1, Math.round(message.max))),
    scope: message.scope === 'all' ? 'all' : 'recent',
    known,
    origin: window.location.origin,
    cookies: document.cookie,
    fetchImpl: window.fetch.bind(window),
    emit: async (event) => {
      if (run.cancelled) return;
      if (!(await emitSyncEvent(event))) run.cancelled = true;
    },
    isCancelled: () => run.cancelled,
    sleep: sleepMs,
  }).finally(() => {
    if (currentSync === run) currentSync = null;
  });
  return { ok: true };
}

/** Who this site says is signed in, read with its own request; decided by this page's host only. */
async function signedInIdentity(): Promise<Record<string, unknown>> {
  const host = window.location.hostname.toLowerCase();
  const site = host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com' ? 'chatgpt'
    : host === 'claude.ai' || host.endsWith('.claude.ai') ? 'claude' : null;
  if (!site) return { ok: true, status: 'unknown' };
  const result = await readSignedInIdentity({ site, origin: window.location.origin, fetchImpl: window.fetch.bind(window) });
  return { ok: true, ...result };
}

/** What a capture of this tab would see right now, without storing anything. */
function probeCapture(): Record<string, unknown> {
  const href = window.location.href;
  let extracted: DomExtractionResult | null = null;
  let error: string | null = null;
  try {
    extracted = extractCurrentConversation();
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  return {
    url: href,
    provider: extracted?.provider ?? detectProviderFromUrl(href),
    site: captureSite?.origin ?? null,
    method: extracted?.method ?? null,
    conversationId: extractConversationIdFromUrl(href),
    domMessages: extracted?.messages.length ?? 0,
    domRoles: extracted ? extracted.messages.reduce<Record<string, number>>((acc, m) => ((acc[m.role] = (acc[m.role] ?? 0) + 1), acc), {}) : {},
    domTitle: extracted?.title ?? null,
    domProject: extracted?.providerProjectName ?? null,
    siteDataMessages: siteConversation && siteConversation.sourceConversationId === extractConversationIdFromUrl(href)?.toLowerCase() ? siteConversation.messages.length : null,
    lastCapture: lastCaptureStatus,
    error,
  };
}

/** Ask the background whether this page belongs to a site the user added under Capture → Any AI site. */
function requestCaptureSite(): void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return;
  try {
    chrome.runtime.sendMessage({ type: 'GET_CAPTURE_SITE' }, (resp: { ok?: boolean; site?: { origin?: unknown } } | undefined) => {
      if (chrome.runtime.lastError || !resp?.ok || typeof resp.site?.origin !== 'string') return;
      if (resp.site.origin !== window.location.origin) return;
      captureSite = { origin: resp.site.origin };
      schedulePassiveDomCapture();
    });
  } catch {
    // extension context invalidated
  }
}

const ISOLATED_WORLD_GUARD = Symbol.for('threadkeeper.contentScriptInitialized');
const isolatedGlobal = globalThis as unknown as Record<symbol, boolean>;

// In any frame other than a top-level page or a page embedded directly in the workspace, do
// nothing at all: no listeners, no observers, no messages.
if (FRAME_MODE !== 'other' && !isolatedGlobal[ISOLATED_WORLD_GUARD]) {
  isolatedGlobal[ISOLATED_WORLD_GUARD] = true;

  // Listen for postMessage from the extension iframe (strictly validated by origin + handshakeToken).
  // An embedded page never shows the in-page overlay, so it has nothing to listen for.
  if (!IN_WORKSPACE) {
    window.addEventListener('message', (event: MessageEvent) => {
      if (typeof chrome === 'undefined' || !chrome.runtime?.getURL) return;
      const extOrigin = new URL(chrome.runtime.getURL('')).origin;
      const check = validateWindowPostMessage(
        event,
        extOrigin,
        activeHandshakeToken
      );
      if (!check.allowed) {
        return;
      }
      const payload = event.data as { action?: string };
      if (payload.action === 'CLOSE_OVERLAY') {
        closeOverlayAndRestore();
      }
    });
  }

  const onX = isXHostname(window.location.hostname);
  if (onX) {
    window.addEventListener('message', onGrokXWindowMessage);
  } else {
    window.addEventListener('message', onSiteDataWindowMessage);
  }
  window.addEventListener('message', onIdentityWindowMessage);
  // The page may have asked who is signed in before this script started; hear it again.
  try {
    window.postMessage({ source: IDENTITY_REPLAY_SOURCE }, window.location.origin);
  } catch {
    // never disturb the page
  }

  // Listen for deliberate invocation from background service worker
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    const deliverSession = createSessionDeliveryHandler({ ownId: chrome.runtime.id, doc: document, url: () => window.location.href, workspace: IN_WORKSPACE });
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (deliverSession(message, _sender, sendResponse)) return true;
      if (IN_WORKSPACE && message && message.type === 'TK_EMBED_COMMAND') {
        sendResponse(runEmbedCommand(message as Record<string, unknown>));
        return true;
      }
      if (IN_WORKSPACE && message && (message.type === 'TOGGLE_THREADKEEPER_OVERLAY' || message.type === 'CLOSE_THREADKEEPER_OVERLAY')) {
        // No overlay inside the workspace: the workspace is ThreadStack already.
        return false;
      }
      if (
        message &&
        typeof message.type === 'string' &&
        TOP_FRAME_COMMANDS.has(message.type) &&
        !addressedToThisFrame(message as { frameId?: unknown })
      ) {
        return false;
      }
      if (
        message &&
        message.type === 'TOGGLE_THREADKEEPER_OVERLAY' &&
        typeof message.handshakeToken === 'string' &&
        message.handshakeToken.length >= 16
      ) {
        const res = openOrToggleOverlay(message.handshakeToken);
        if (res.state === 'opened') {
          // Opening ThreadStack here counts as asking for this page (the background holds the same token).
          schedulePassiveDomCapture(true, message.handshakeToken, 'overlay');
        }
        sendResponse({ ok: true, state: res.state });
        return true;
      }
      if (message && message.type === 'TK_PING') {
        sendResponse({ ok: true });
        return true;
      }
      if (message && message.type === 'TK_CAPTURE_NOW') {
        const token = typeof message.explicitToken === 'string' && message.explicitToken.length >= 16 ? message.explicitToken : null;
        schedulePassiveDomCapture(true, token, token ? 'capture' : 'overlay');
        sendResponse({ ok: true });
        return true;
      }
      if (message && message.type === 'TK_HISTORY_SYNC_RUN') {
        sendResponse(startApiSync(message as Record<string, unknown>));
        return true;
      }
      if (message && message.type === 'TK_HISTORY_SYNC_CANCEL') {
        syncCancelled = true;
        if (currentSync) currentSync.cancelled = true;
        sendResponse({ ok: true });
        return true;
      }
      if (message && message.type === 'TK_HISTORY_IDENTITY') {
        void signedInIdentity().then(sendResponse, () => sendResponse({ ok: true, status: 'unknown' }));
        return true;
      }
      if (message && message.type === 'TK_HISTORY_LIST_SIDEBAR') {
        const provider = message.provider;
        const limit = typeof message.limit === 'number' ? Math.min(1000, Math.max(1, Math.round(message.limit))) : 30;
        const maxScrolls = typeof message.maxScrolls === 'number' ? Math.min(300, Math.max(1, Math.round(message.maxScrolls))) : undefined;
        const patience = typeof message.patience === 'number' ? Math.min(6, Math.max(1, Math.round(message.patience))) : undefined;
        if (!isSyncProviderId(provider)) {
          sendResponse({ ok: false, items: [] });
          return true;
        }
        syncCancelled = false;
        void loadSidebarList(document, window, provider, { limit, maxScrolls, patience, sleep: sleepMs, isCancelled: () => syncCancelled }).then(
          ({ items, complete }) => sendResponse({ ok: true, items, complete }),
          () => sendResponse({ ok: false, items: [] })
        );
        return true;
      }
      if (message && message.type === 'TK_CAPTURE_PROBE') {
        sendResponse({ ok: true, report: probeCapture() });
        return true;
      }
      if (message && message.type === 'CLOSE_THREADKEEPER_OVERLAY') {
        if (
          typeof message.handshakeToken === 'string' &&
          message.handshakeToken.length >= 16 &&
          activeHandshakeToken.length >= 16 &&
          message.handshakeToken === activeHandshakeToken
        ) {
          closeOverlayAndRestore();
          sendResponse({ ok: true, state: 'closed' });
        } else {
          sendResponse({
            ok: false,
            error: 'Invalid or missing handshakeToken',
          });
        }
        return true;
      }
      return false;
    });
  }

  // Set up zero-footprint passive DOM observer (never touches or mutates DOM).
  // Not on X: Grok there comes from X's own responses, and no other X page is captured.
  if (!onX && typeof MutationObserver !== 'undefined' && document.documentElement) {
    const isOverlayNode = (node: Node): boolean =>
      typeof Element !== 'undefined' &&
      node instanceof Element &&
      (node.id === OVERLAY_DIALOG_ID ||
        Boolean(node.closest(`#${OVERLAY_DIALOG_ID}`)));

    const observer = new MutationObserver((mutations) => {
      // Ignore mutations inside or adding/removing our own dialog if open
      if (
        mutations.every((m) => {
          if (isOverlayNode(m.target)) return true;
          const changed = [
            ...Array.from(m.addedNodes),
            ...Array.from(m.removedNodes),
          ];
          return changed.length > 0 && changed.every(isOverlayNode);
        })
      ) {
        return;
      }
      schedulePassiveDomCapture();
      schedulePageCheck();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    if (detectProviderFromUrl(window.location.href) === null) {
      // No provider owns this page: read it only if the user added the site (the background decides).
      requestCaptureSite();
    } else {
      schedulePassiveDomCapture();
    }
  }

  if (IN_WORKSPACE) startEmbedBridge();
  schedulePageCheck();

  // A single-page app can change the conversation without a page load. The mutation observer
  // usually notices, but a cheap URL check makes sure a switch is never missed. The same check
  // keeps an embedded page's address current in the workspace, and looks again at a sign-in page
  // (X has no DOM observer, and its sign-in form appears after the address).
  let lastHref = window.location.href;
  window.setInterval(() => {
    if (IN_WORKSPACE) {
      scheduleNavReport();
      if (Date.now() - lastAgentCheckAt >= 10_000) schedulePageCheck();
    }
    if (window.location.href === lastHref) {
      if (!signedOutSent && LOGIN_PATH.test(window.location.pathname)) schedulePageCheck();
      return;
    }
    lastHref = window.location.href;
    staleRetries = 0;
    if (!onX) schedulePassiveDomCapture();
    schedulePageCheck();
  }, 1500);
}
