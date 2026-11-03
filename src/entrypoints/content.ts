import {
  extractVisibleDomConversation,
  grokXConversationToExtraction,
  type DomExtractionResult,
} from '../core/dom-capture.js';
import { mergeGrokXMessages, parseGrokXCaptureMessage, type GrokXMessage } from '../core/grok-x.js';
import { validateWindowPostMessage } from '../core/messaging.js';
import { detectProviderFromUrl, extractConversationIdFromUrl, isXHostname } from '../core/providers.js';

const OVERLAY_DIALOG_ID = 'threadkeeper-overlay-root';

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
  dialog.setAttribute('aria-label', 'Threadkeeper Workbench');
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
  iframe.title = 'Threadkeeper Conversation Manager';
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

/** Grok on X: messages X's own page loaded for the open conversation (see grok-x-main.ts). */
let grokXConversation: { id: string; messages: GrokXMessage[] } | null = null;

/** The conversation on screen: Grok on X from X's own responses, every other site from the DOM. */
function extractCurrentConversation(): DomExtractionResult | null {
  const href = window.location.href;
  if (detectProviderFromUrl(href) === 'grok_x') {
    const urlId = extractConversationIdFromUrl(href);
    if (!grokXConversation || (urlId && urlId !== grokXConversation.id)) return null;
    return grokXConversationToExtraction(grokXConversation.id, grokXConversation.messages);
  }
  return extractVisibleDomConversation(document, href);
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

function schedulePassiveDomCapture(explicitInvoke = false): void {
  if (explicitInvoke) {
    pendingExplicitInvoke = true;
  }
  if (captureDebounceTimer) {
    clearTimeout(captureDebounceTimer);
  }
  const isExplicit = pendingExplicitInvoke;
  captureDebounceTimer = setTimeout(() => {
    const useExplicit = pendingExplicitInvoke;
    pendingExplicitInvoke = false;
    const extracted = extractCurrentConversation();
    if (!extracted) return;

    const fingerprint = `${extracted.provider}:${extracted.sourceConversationId}:${extracted.branchId}:${extracted.title}:${extracted.providerProjectName ?? ''}:${extracted.messages.map((m) => `${m.sourceMessageId}:${m.content.length}`).join('|')}`;
    if (!useExplicit && fingerprint === lastCapturedFingerprint) return;

    if (typeof chrome !== 'undefined' && chrome.runtime?.sendMessage) {
      try {
        chrome.runtime.sendMessage(
          {
            type: 'PASSIVE_DOM_CAPTURE',
            explicitInvoke: useExplicit,
            payload: {
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
            },
          },
          (resp: { ok?: boolean } | undefined) => {
            if (resp?.ok) {
              lastCapturedFingerprint = fingerprint;
            }
          }
        );
      } catch {
        // Ignore if extension context invalidated
      }
    }
  }, isExplicit ? 50 : 900);
}

const ISOLATED_WORLD_GUARD = Symbol.for('threadkeeper.contentScriptInitialized');
const isolatedGlobal = globalThis as unknown as Record<symbol, boolean>;

if (!isolatedGlobal[ISOLATED_WORLD_GUARD]) {
  isolatedGlobal[ISOLATED_WORLD_GUARD] = true;

  // Listen for postMessage from the extension iframe (strictly validated by origin + handshakeToken)
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

  const onX = isXHostname(window.location.hostname);
  if (onX) {
    window.addEventListener('message', onGrokXWindowMessage);
  }

  // Listen for deliberate invocation from background service worker
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (
        message &&
        message.type === 'TOGGLE_THREADKEEPER_OVERLAY' &&
        typeof message.handshakeToken === 'string' &&
        message.handshakeToken.length >= 16
      ) {
        const res = openOrToggleOverlay(message.handshakeToken);
        if (res.state === 'opened') {
          schedulePassiveDomCapture(true);
        }
        sendResponse({ ok: true, state: res.state });
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
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    schedulePassiveDomCapture();
  }
}
