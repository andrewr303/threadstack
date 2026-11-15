// Deliberate provider actions arrive only through extension runtime messaging, never page events.
import { detectProviderFromUrl, providerLabel } from '../providers.js';
import { ACTION_TEXT, BRIDGE_SUPPORTED_PROVIDERS, BridgeActionError, abortedBeforeTyping, parseAbortReason } from '../paperclip/bridge-protocol.js';

export interface SessionDeliveryCommand {
  requestId: string; provider: string; text: string; expectedUrl: string; deadlineAt: number;
}
export interface DeliveryOptions {
  signal?: AbortSignal; visible?: (element: Element) => boolean; confirmationMs?: number; now?: () => number;
  /** Read at every delivery boundary; the captured request URL alone cannot identify a live SPA session. */
  currentUrl?: () => string;
}

interface Adapter { composer: string; send: string; userMessages: string }
const ADAPTERS: Record<string, Adapter> = {
  chatgpt: { composer: '#prompt-textarea, textarea[data-testid="prompt-textarea"]', send: '[data-testid="send-button"], button[aria-label="Send prompt"]', userMessages: '[data-message-author-role="user"]' },
  codex: { composer: '#prompt-textarea, textarea[data-testid="prompt-textarea"], textarea[placeholder*="follow" i]', send: '[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]', userMessages: '[data-message-author-role="user"], [data-testid="user-message"]' },
  claude: { composer: '[contenteditable="true"][data-testid="chat-input"], div.ProseMirror[contenteditable="true"], textarea[placeholder*="Claude" i]', send: 'button[aria-label="Send message"], button[data-testid="send-button"]', userMessages: '[data-testid="user-message"]' },
  claude_code: { composer: '[contenteditable="true"][data-testid="chat-input"], div.ProseMirror[contenteditable="true"], textarea[placeholder*="follow" i]', send: 'button[aria-label="Send message"], button[data-testid="send-button"]', userMessages: '[data-testid="user-message"]' },
};
const shownText = (el: Element) => ((el as HTMLElement).innerText ?? el.textContent ?? '').trim();
const normalizeText = (text: string) => text.replace(/\s+/g, ' ').trim();

function samePage(actual: string, expected: string): boolean {
  try { const a = new URL(actual), b = new URL(expected); return a.protocol === 'https:' && a.origin === b.origin && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, ''); } catch { return false; }
}
/** Before submission an abort is `disabled` (switch-off) or `timeout` (deadline), with the contract text. */
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw abortedBeforeTyping(signal); }

export async function deliverProviderMessage(doc: Document, actualUrl: string, command: SessionDeliveryCommand, options: DeliveryOptions = {}): Promise<{ delivered: true; at: string }> {
  const now = options.now ?? Date.now;
  const visible = options.visible ?? ((el: Element) => el.getClientRects().length > 0);
  checkAbort(options.signal);
  if (!command || typeof command.requestId !== 'string' || !command.requestId || command.requestId.length > 128 || typeof command.text !== 'string' || !command.text.trim() || command.text.length > 20_000 || !Number.isFinite(command.deadlineAt)) throw new BridgeActionError('bad_request', 'Invalid browser delivery request.');
  if (command.deadlineAt <= now()) throw new BridgeActionError('timeout', ACTION_TEXT.timeout);
  if (!samePage(actualUrl, command.expectedUrl) || detectProviderFromUrl(actualUrl) !== command.provider) throw new BridgeActionError('denied', 'The loaded page is not the requested session.');
  if (!BRIDGE_SUPPORTED_PROVIDERS.includes(command.provider as typeof BRIDGE_SUPPORTED_PROVIDERS[number])) throw new BridgeActionError('unsupported', `${providerLabel(command.provider)} has no send support yet.`);
  const view = doc.defaultView;
  const root = doc.documentElement;
  const readUrl = options.currentUrl ?? (() => view?.location.href ?? doc.location.href);
  const initialUrl = readUrl();
  const isCurrentSession = () => {
    try {
      const liveUrl = readUrl();
      return doc.documentElement === root && (!view || view.document === doc)
        && samePage(liveUrl, command.expectedUrl) && samePage(liveUrl, actualUrl)
        && detectProviderFromUrl(liveUrl) === command.provider
        && new URL(liveUrl).search === new URL(initialUrl).search;
    } catch { return false; }
  };
  const checkSession = () => {
    checkAbort(options.signal);
    if (!isCurrentSession()) throw new BridgeActionError('denied', 'The loaded page is no longer the requested session.');
    if (command.deadlineAt <= now()) throw new BridgeActionError('timeout', ACTION_TEXT.timeout);
  };
  checkSession();
  const adapter = ADAPTERS[command.provider];
  const checkProviderState = () => {
    const buttons = Array.from(doc.querySelectorAll('button')).filter(visible);
    if (Array.from(doc.querySelectorAll('input[type=password], input[type=email]')).some(visible) || buttons.some(b => /^(log in|sign in|continue with google|continue with apple)$/i.test(shownText(b)))) throw new BridgeActionError('signed_out', "The session's account is signed out.");
    if (/verify you are human|just a moment|access denied/i.test(doc.title) || doc.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha"]')) throw new BridgeActionError('unsupported', `${providerLabel(command.provider)} is showing a check that needs you.`);
    if (buttons.some(b => /^(stop|stop generating|stop response)$/i.test(b.getAttribute('aria-label') || shownText(b))) || Array.from(doc.querySelectorAll('[role=dialog]')).some(visible)) throw new BridgeActionError('busy', 'The session is still running. Wait for it to finish.');
  };
  checkProviderState();
  const composers = Array.from(doc.querySelectorAll<HTMLElement>(adapter.composer)).filter(visible);
  const sends = Array.from(doc.querySelectorAll<HTMLButtonElement>(adapter.send)).filter(visible);
  if (composers.length !== 1 || sends.length !== 1) throw new BridgeActionError('unsupported', `${providerLabel(command.provider)} has no send support yet.`);
  const composer = composers[0];
  const current = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.textContent ?? '';
  if (current.trim()) throw new BridgeActionError('busy', 'The session has an unsent draft. Finish it before an agent sends a message.');
  // Count copies of this exact text rather than tracking elements: providers re-render (remount) earlier
  // messages, and a fresh element with old text must not read as delivery (REQ-11 F-13).
  const matchingCount = () => Array.from(doc.querySelectorAll(adapter.userMessages)).filter(el => visible(el) && normalizeText(shownText(el)) === normalizeText(command.text)).length;
  const before = matchingCount();
  checkSession();
  const readDraft = () => composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.textContent ?? '';
  const writeDraft = (text: string) => {
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(composer, text);
    } else { composer.textContent = text; }
    composer.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  };
  let submitted = false;
  try {
    checkSession();
    writeDraft(command.text);
    // Providers normally disable Send for an empty draft and may replace it on React's next render.
    const readyDeadline = Math.min(command.deadlineAt, now() + 2000);
    let ready = Array.from(doc.querySelectorAll<HTMLButtonElement>(adapter.send)).filter(visible);
    while (ready.length === 1 && ready[0].disabled && now() < readyDeadline) {
      checkSession(); await new Promise(resolve => setTimeout(resolve, 25));
      checkSession();
      ready = Array.from(doc.querySelectorAll<HTMLButtonElement>(adapter.send)).filter(visible);
    }
    checkSession();
    checkProviderState();
    if (!composer.isConnected || !doc.contains(composer)) throw new BridgeActionError('denied', 'The session composer changed before the agent could send.');
    if (normalizeText(readDraft()) !== normalizeText(command.text)) throw new BridgeActionError('busy', 'The draft changed before the agent could send.');
    if (ready.length !== 1 || ready[0].disabled) throw new BridgeActionError('unsupported', `${providerLabel(command.provider)} has no send support yet.`);
    checkSession();
    submitted = true;
    ready[0].click();
  } catch (error) {
    // Restore only our own unsubmitted draft. A concurrent human edit is never erased.
    if (!submitted && isCurrentSession() && composer.isConnected && readDraft() === command.text) writeDraft('');
    if (submitted) throw new BridgeActionError('unknown_delivery', 'The message may or may not have been sent. Read the session before trying again.');
    throw error;
  }
  // Once submitted, cancellation cannot prove it was not sent. Confirmation is still attempted,
  // and a timeout is deliberately uncertain rather than permission to retry.
  const confirmationDeadline = Math.min(command.deadlineAt, now() + (options.confirmationMs ?? 15_000));
  const delivered = () => matchingCount() > before;
  if (!isCurrentSession()) throw new BridgeActionError('unknown_delivery', 'The session changed after submission. Read the requested session before trying again.');
  if (delivered()) return { delivered: true, at: new Date(now()).toISOString() };
  return new Promise((resolve, reject) => {
    let settled = false;
    const inspect = () => { if (!isCurrentSession()) finish(false); else if (delivered()) finish(true); };
    const observer = new MutationObserver(inspect);
    const finish = (success: boolean) => { if (settled) return; settled = true; observer.disconnect(); clearTimeout(timer); clearInterval(sessionWatch); success ? resolve({ delivered: true, at: new Date(now()).toISOString() }) : reject(new BridgeActionError('unknown_delivery', 'The message may or may not have been sent. Read the session before trying again.')); };
    const timer = setTimeout(() => finish(isCurrentSession() && delivered()), Math.max(1, confirmationDeadline - now()));
    // History navigation does not have to mutate the DOM, so the observer alone is insufficient.
    const sessionWatch = setInterval(inspect, 25);
    observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true });
    inspect();
  });
}

/** Install on direct workspace frames only. A page cannot access chrome.runtime's listener. */
export function createSessionDeliveryHandler(options: { ownId: string; doc: Document; url: () => string; workspace: boolean }) {
  const pending = new Map<string, AbortController>();
  return (message: unknown, sender: { id?: string; url?: string; origin?: string }, respond: (response: unknown) => void): boolean => {
    if (!message || typeof message !== 'object') return false;
    const m = message as Record<string, unknown>;
    if (m.type !== 'TK_SESSION_DELIVER' && m.type !== 'TK_SESSION_CANCEL') return false;
    const ownOrigin = `chrome-extension://${options.ownId}`;
    if (!options.workspace || sender.id !== options.ownId || !(sender.origin === ownOrigin || sender.url?.startsWith(`${ownOrigin}/`))) { respond({ ok: false, error: { code: 'denied', message: 'Browser actions require the Threadkeeper workspace.' } }); return true; }
    if (m.type === 'TK_SESSION_CANCEL') { if (typeof m.requestId === 'string') pending.get(m.requestId)?.abort(parseAbortReason(m.reason)); respond({ ok: true }); return true; }
    if (typeof m.requestId !== 'string' || pending.has(m.requestId)) { respond({ ok: false, error: { code: 'busy', message: 'This browser action is already running.' } }); return true; }
    const controller = new AbortController(); pending.set(m.requestId, controller);
    void deliverProviderMessage(options.doc, options.url(), m as unknown as SessionDeliveryCommand, { signal: controller.signal, currentUrl: options.url }).then(data => respond({ ok: true, data: { ...data, url: options.url() } }), err => respond({ ok: false, error: { code: err instanceof BridgeActionError ? err.code : 'unknown_delivery', message: err instanceof BridgeActionError ? err.message : 'Delivery could not be confirmed.' } })).finally(() => pending.delete(m.requestId as string));
    return true;
  };
}
