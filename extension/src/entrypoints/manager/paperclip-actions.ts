import { useEffect, useRef } from 'react';
import type { ConversationRecord, SettingsRecord } from '../../core/schema.js';
import { extractConversationIdFromUrl } from '../../core/providers.js';
import { ACTION_TEXT, BRIDGE_SUPPORTED_PROVIDERS, VERDICT_MARGIN_MS, abortCode, actionAbortReason, parseAbortReason, type ActionOutcome, type AgentAction, type BridgeErrorCode } from '../../core/paperclip/bridge-protocol.js';
import { accountForThread, embedTargetFor, needsSignIn } from './workspace/state.js';
import type { WorkspaceController } from './workspace/useWorkspace.js';

export class ManagerActionError extends Error {
  constructor(readonly code: BridgeErrorCode, message: string) { super(message); }
}
export interface ManagerActionEnvironment {
  workspace(): WorkspaceController;
  settings(): SettingsRecord | null;
  readThread(threadKey: string): Promise<ConversationRecord | undefined>;
  mayShare?(conversation: ConversationRecord): Promise<boolean>;
  showBrowse(): void;
  now?(): number;
  sleep?(milliseconds: number): Promise<void>;
  send?(tabId: number, frameId: number, command: Record<string, unknown>): Promise<unknown>;
}
/** REQ-11 FR-6: the page gets 30 s to load; after Send is ready, confirmation gets a full 15 s. */
export const PAGE_LOAD_MS = 30_000;
export const SEND_READY_MS = 2_000;
export const CONFIRMATION_MS = 15_000;
/** REQ-11 FR-1: `timeout` as in REQ-8 FR-9. */
export const ACTION_TIMEOUT_TEXT = ACTION_TEXT.timeout;
const START_URLS: Record<string, string> = {
  claude: 'https://claude.ai/new', claude_code: 'https://claude.ai/code', chatgpt: 'https://chatgpt.com/', codex: 'https://chatgpt.com/codex',
};

/** Page-side execution owns frame/account identity. It never chooses a different account or retries submission. */
export async function executePaperclipAction(action: AgentAction, signal: AbortSignal, env: ManagerActionEnvironment): Promise<ActionOutcome> {
  const now = env.now ?? Date.now;
  const sleep = env.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)));
  const check = () => {
    // Nothing has been typed yet: say exactly why it stopped (REQ-11 AC-8, FR-1, NF-2).
    if (signal.aborted) { const reason = actionAbortReason(signal); throw new ManagerActionError(abortCode(reason), ACTION_TEXT[reason]); }
    if (action.deadlineAt <= now()) throw new ManagerActionError('timeout', ACTION_TEXT.timeout);
  };
  check();
  if (!BRIDGE_SUPPORTED_PROVIDERS.includes(action.provider as typeof BRIDGE_SUPPORTED_PROVIDERS[number])) throw new ManagerActionError('unsupported', 'This provider has no send support yet.');
  const text = action.type === 'session.send' ? action.text : action.prompt;
  if (typeof action.requestId !== 'string' || !action.requestId || typeof text !== 'string' || !text.trim() || text.length > 20_000) throw new ManagerActionError('bad_request', 'Invalid browser action.');
  const ws = env.workspace();
  if (!ws.embedding || ws.tabId === null) throw new ManagerActionError('browser_offline', 'Open the Threadkeeper window to use browser actions.');
  let conv: ConversationRecord | undefined;
  let url: string;
  let accountId: string | undefined;
  if (action.type === 'session.send') {
    conv = await env.readThread(action.threadKey);
    check();
    if (!conv) throw new ManagerActionError('not_found', 'This session is no longer available.');
    if (conv.provider !== action.provider || conv.accountId !== action.accountId || conv.canonicalUrl !== action.url) throw new ManagerActionError('denied', 'The session account or destination changed. Read it before trying again.');
    if (conv.agentState === 'running') throw new ManagerActionError('busy', 'The session is still running. Wait for it to finish.');
    if (conv.agentState === 'signed_out') throw new ManagerActionError('signed_out', "The session's account is signed out.");
    const boundId = env.settings()?.boundAccounts[conv.provider]?.accountId;
    if (conv.accountId !== boundId && !ws.realms.some(realm => realm.accounts.some(account => account.id === conv!.accountId))) throw new ManagerActionError('signed_out', "The session's account is no longer available.");
    const owner = accountForThread(conv, ws.realms, boundId);
    accountId = owner?.account?.id;
    url = conv.canonicalUrl;
  } else {
    url = START_URLS[action.provider];
    const target = embedTargetFor(url);
    const entry = ws.realms.find(realm => realm.realm.id === target?.realm.id);
    const boundId = env.settings()?.boundAccounts[action.provider as keyof SettingsRecord['boundAccounts']]?.accountId;
    accountId = action.accountId === boundId ? entry?.accounts.find(account => account.primary)?.id : action.accountId;
    if (!accountId && entry?.accounts.length === 1) accountId = entry.accounts[0].id;
    if (!accountId) throw new ManagerActionError('bad_request', 'Choose the account for the new session.');
  }
  const target = embedTargetFor(url);
  const entry = ws.realms.find(realm => realm.realm.id === target?.realm.id);
  const account = entry?.accounts.find(item => item.id === accountId);
  if (!target || !entry || !account || account.mode !== 'embedded') throw new ManagerActionError('signed_out', "The session's account cannot be shown in this window.");
  const browserAccountId = entry.activeAccountId;
  if (entry.activeAccountId !== account.id) {
    const slot = ws.slots[target.realm.id];
    if (slot && (slot.accountId !== account.id || slot.status === 'failed' || slot.status === 'stale')) throw new ManagerActionError('signed_out', 'Another profile owns this window. Open a window with the session’s account.');
    if (needsSignIn(account)) throw new ManagerActionError('signed_out', "The session's account is signed out.");
  } else if (account.signedIn === 'no') {
    // The browser's own account has no saved jar, so needsSignIn() cannot judge it; a known signed-out
    // state must still stop before any tab is opened (REQ-11 FR-2 edge, F-8).
    throw new ManagerActionError('signed_out', "The session's account is signed out.");
  }
  check();
  const opened = conv ? ws.openThread(conv, { activate: true }) : ws.openUrl(url, { accountId: account.id, activate: true });
  if (!opened.ok) throw new ManagerActionError('signed_out', opened.message);
  env.showBrowse();
  ws.activateTab(opened.tabId);
  let frameId: number | null = null;
  // Page load gets 30 s, but never so long that delivery, confirmation and the verdict miss deadlineAt (NF-3b).
  const verdictBy = action.deadlineAt - VERDICT_MARGIN_MS;
  const pageLoadDeadline = Math.min(now() + PAGE_LOAD_MS, verdictBy - SEND_READY_MS - CONFIRMATION_MS - 500);
  while (frameId === null) {
    check();
    const current = env.workspace();
    if (current.realms.find(realm => realm.realm.id === target.realm.id)?.activeAccountId !== browserAccountId) throw new ManagerActionError('denied', 'The browser account changed while preparing this action.');
    const tab = current.state.tabs.find(item => item.id === opened.tabId);
    if (tab && tab.accountId !== account.id) throw new ManagerActionError('denied', 'The session account changed.');
    const slot = current.slots[target.realm.id];
    if (entry.activeAccountId !== account.id && slot && (slot.accountId !== account.id || slot.status === 'failed' || slot.status === 'stale')) throw new ManagerActionError('signed_out', 'The account is not available in this window.');
    const runtime = current.runtime(opened.tabId);
    if (runtime.agentState === 'running') throw new ManagerActionError('busy', 'The session is still running. Wait for it to finish.');
    if (runtime.agentState === 'signed_out') throw new ManagerActionError('signed_out', "The session's account is signed out.");
    if (runtime.loaded && runtime.frameId !== null) frameId = runtime.frameId;
    else if (now() >= pageLoadDeadline) throw new ManagerActionError('timeout', ACTION_TIMEOUT_TEXT);
    else await sleep(100);
  }
  check();
  if (conv) {
    const fresh = await env.readThread(conv.threadKey);
    if (!fresh || fresh.accountId !== conv.accountId || fresh.provider !== conv.provider || fresh.canonicalUrl !== url || (env.mayShare && !(await env.mayShare(fresh)))) {
      throw new ManagerActionError('not_found', 'This session is no longer available to Paperclip.');
    }
    check();
  }
  const destination = env.workspace();
  if (destination.realms.find(realm => realm.realm.id === target.realm.id)?.activeAccountId !== browserAccountId || destination.runtime(opened.tabId).frameId !== frameId) {
    throw new ManagerActionError('denied', 'The account or frame changed before delivery.');
  }
  const send = env.send ?? ((tabId, destination, command) => chrome.tabs.sendMessage(tabId, command, { frameId: destination }));
  const cancel = () => { void send(ws.tabId!, frameId!, { type: 'TK_SESSION_CANCEL', requestId: action.requestId, reason: actionAbortReason(signal) }).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  let response: unknown;
  try {
    response = await Promise.race([
      // The frame may spend up to SEND_READY_MS waiting for Send; confirmation still gets its full window.
      send(ws.tabId, frameId, { type: 'TK_SESSION_DELIVER', requestId: action.requestId, provider: action.provider, text, expectedUrl: url, deadlineAt: Math.min(verdictBy, now() + SEND_READY_MS + CONFIRMATION_MS + 500) }),
      new Promise((_, reject) => { timer = setTimeout(() => { cancel(); reject(new ManagerActionError('unknown_delivery', 'The message may or may not have been sent. Read the session before trying again.')); }, Math.max(1, Math.min(verdictBy - now() + 500, SEND_READY_MS + CONFIRMATION_MS + 1_500))); }),
    ]);
  } catch (error) {
    if (error instanceof ManagerActionError) throw error;
    throw new ManagerActionError('unknown_delivery', 'The message may or may not have been sent. Read the session before trying again.');
  } finally { if (timer) clearTimeout(timer); signal.removeEventListener('abort', cancel); }
  const result = response as { ok?: boolean; data?: { delivered?: boolean; at?: string; url?: string }; error?: { code?: BridgeErrorCode; message?: string } } | undefined;
  if (!result?.ok || !result.data?.delivered || typeof result.data.at !== 'string') throw new ManagerActionError(result?.error?.code ?? 'unknown_delivery', result?.error?.message ?? 'The message may or may not have been sent. Read the session before trying again.');
  if (action.type === 'session.send') return { delivered: true, at: result.data.at };
  let sessionUrl = result.data.url || url;
  const navigationDeadline = Math.min(action.deadlineAt, now() + 15_000);
  while (!extractConversationIdFromUrl(sessionUrl) && now() < navigationDeadline && !signal.aborted) {
    await sleep(100);
    sessionUrl = env.workspace().state.tabs.find(item => item.id === opened.tabId)?.url || sessionUrl;
  }
  if (!extractConversationIdFromUrl(sessionUrl)) throw new ManagerActionError('unknown_delivery', 'The first message was shown but its new session address is not confirmed. Read the session before trying again.');
  if (embedTargetFor(sessionUrl)?.provider !== action.provider) throw new ManagerActionError('unknown_delivery', 'The provider changed before the new session address was confirmed. Read the session before trying again.');
  const tab = env.workspace().state.tabs.find(item => item.id === opened.tabId);
  return { started: true, url: sessionUrl, threadKey: tab?.threadKey ?? null };
}

export function usePaperclipManagerActions(options: ManagerActionEnvironment & { enabled: boolean; openThread(threadKey: string): Promise<boolean> }) {
  const current = useRef(options); current.current = options;
  useEffect(() => {
    if (!options.enabled || typeof chrome === 'undefined' || !chrome.runtime?.onMessage) return;
    const controllers = new Map<string, AbortController>();
    const outcomes = new Map<string, { digest: string; promise: Promise<unknown> }>();
    const listener = (message: unknown, sender: chrome.runtime.MessageSender, respond: (result: unknown) => void): boolean | undefined => {
      if (sender.id !== chrome.runtime.id || sender.tab || (sender.url && sender.url !== chrome.runtime.getURL('background.js'))) return;
      if (!message || typeof message !== 'object') return;
      const request = message as { type?: string; action?: AgentAction; requestId?: string; threadKey?: string; reason?: string };
      if (request.type === 'PAPERCLIP_CANCEL_ACTION' && typeof request.requestId === 'string') { controllers.get(request.requestId)?.abort(parseAbortReason(request.reason)); respond({ ok: true }); return; }
      if (request.type === 'PAPERCLIP_OPEN_THREAD' && typeof request.threadKey === 'string') {
        void current.current.openThread(request.threadKey).then(opened => respond(opened ? { ok: true } : { ok: false, code: 'not_found', error: 'The session is no longer in this library.' }), () => respond({ ok: false, code: 'internal', error: 'The session could not be opened.' }));
        return true;
      }
      if (request.type !== 'PAPERCLIP_EXECUTE_ACTION' || !request.action || typeof request.action.requestId !== 'string') return;
      const action = request.action;
      const digest = JSON.stringify(action);
      const previous = outcomes.get(action.requestId);
      if (previous && previous.digest !== digest) { respond({ ok: false, code: 'bad_request', error: 'This request already has different content.' }); return; }
      if (previous) { void previous.promise.then(respond); return true; }
      if (outcomes.size >= 500) { respond({ ok: false, code: 'busy', error: 'Reopen the window before starting more browser actions.' }); return; }
      const controller = new AbortController(); controllers.set(action.requestId, controller);
      const promise = executePaperclipAction(action, controller.signal, {
        workspace: () => current.current.workspace(), settings: () => current.current.settings(), readThread: key => current.current.readThread(key), mayShare: conversation => current.current.mayShare?.(conversation) ?? Promise.resolve(false), showBrowse: () => current.current.showBrowse(),
      }).then(result => ({ ok: true, result }), error => ({ ok: false, code: error instanceof ManagerActionError ? error.code : 'unknown_delivery', error: error instanceof Error ? error.message : 'The delivery could not be confirmed.' })).finally(() => controllers.delete(action.requestId));
      outcomes.set(action.requestId, { digest, promise }); void promise.then(respond); return true;
    };
    chrome.runtime.onMessage.addListener(listener);
    return () => { chrome.runtime.onMessage.removeListener(listener); for (const controller of controllers.values()) controller.abort(); };
  }, [options.enabled]);
}
