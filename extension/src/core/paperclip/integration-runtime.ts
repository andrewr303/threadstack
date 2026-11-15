/** Worker-owned lifecycle and command integration. Shared dispatch never handles provider protocols. */
import { ensureStarterCollectionsAndSettings, saveSettingsPatch, type ThreadkeeperDB } from '../db.js';
import { chromeHelperEnv, helperPaperclip } from '../embed/helper.js';
import { createPaperclipStartCoordinator } from './lifecycle.js';
import { PaperclipBridge, type PaperclipBridgeDeps } from './bridge.js';
import { BridgeActionError } from './actions.js';
import { ACTION_TEXT, abortedBeforeTyping, actionAbortReason, type ActionAbortReason, type ActionOutcome, type AgentAction, type BridgeErrorCode } from './bridge-protocol.js';
import { configureModelCredentialResolver, createSecretReadCache, handleCredentialCommand, type ModelCredentialKey } from './credentials.js';
import { isSessionBoardCommand, proxySessionCommand } from './integration-client.js';

/** Longest wait for the manager's own verdict after an abort (REQ-11 AC-8, NF-2). */
export const MANAGER_VERDICT_WAIT_MS = 3_000;

/**
 * Worker side of an agent action: hands it to one manager document and returns the manager's verdict.
 * On abort it forwards the reason and waits (at most 3 s) for that verdict, so a switch-off before typing
 * reports `disabled: Agent actions are turned off.` and a deadline `timeout`. Only without any verdict is
 * the contract `unknown_delivery` text used, because text may have been submitted. Never replays.
 */
export function createManagerActionExecutor(deps: {
  ready(): Promise<void>;
  tabId(): number | undefined;
  sendExecute(tabId: number, action: AgentAction): Promise<unknown>;
  sendCancel(tabId: number, requestId: string, reason: ActionAbortReason): Promise<unknown>;
  verdictWaitMs?: number;
  now?: () => number;
}) {
  const unknown = () => new BridgeActionError('unknown_delivery', ACTION_TEXT.unknown);
  return async (action: AgentAction, signal: AbortSignal): Promise<ActionOutcome> => {
    await deps.ready();
    const tabId = deps.tabId();
    if (tabId === undefined) throw new BridgeActionError('browser_offline', 'Open the Threadkeeper window to act in browser sessions.');
    if (signal.aborted) throw abortedBeforeTyping(signal);
    if (action.deadlineAt <= (deps.now ?? Date.now)()) throw new BridgeActionError('timeout', ACTION_TEXT.timeout);
    const answer = deps.sendExecute(tabId, action);
    const response = await new Promise<unknown>((resolve, reject) => {
      let waitTimer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => {
        void deps.sendCancel(tabId, action.requestId, actionAbortReason(signal)).catch(() => undefined);
        waitTimer = setTimeout(() => reject(unknown()), Math.min(MANAGER_VERDICT_WAIT_MS, deps.verdictWaitMs ?? MANAGER_VERDICT_WAIT_MS));
      };
      const done = () => { if (waitTimer) clearTimeout(waitTimer); signal.removeEventListener('abort', onAbort); };
      signal.addEventListener('abort', onAbort, { once: true });
      answer.then(value => { done(); resolve(value); }, () => { done(); reject(unknown()); });
    });
    const r = response as { ok?: boolean; code?: BridgeErrorCode; error?: string | { code?: BridgeErrorCode; message?: string }; result?: ActionOutcome; data?: ActionOutcome } | undefined;
    if (!r?.ok) {
      const code = r?.code ?? (typeof r?.error === 'object' ? r.error.code : undefined) ?? 'unknown_delivery';
      const message = typeof r?.error === 'string' ? r.error : typeof r?.error === 'object' && r.error.message ? r.error.message : ACTION_TEXT.unknown;
      throw new BridgeActionError(code, code === 'unknown_delivery' ? ACTION_TEXT.unknown : message);
    }
    const result = (r.result ?? r.data) as (ActionOutcome & { delivered?: boolean; started?: boolean }) | undefined;
    if (!result || (result.delivered !== true && result.started !== true)) throw unknown();
    return result;
  };
}

/** REQ-13 FR-3: activating a tab in another window must also bring that window forward. */
export async function focusWorkspaceTab(api: {
  tabs: { update(tabId: number, info: { active: boolean }): Promise<{ windowId?: number } | undefined> };
  windows: { update(windowId: number, info: { focused: boolean }): Promise<unknown> };
}, tabId: number): Promise<void> {
  const tab = await api.tabs.update(tabId, { active: true });
  if (typeof tab?.windowId === 'number') await api.windows.update(tab.windowId, { focused: true });
}

/** MV3 evicts the worker; this alarm brings the bridge back whenever a company is paired (REQ-7 AC-7). */
export const BRIDGE_KEEPALIVE_ALARM = 'tk-paperclip-bridge';
export interface BridgeAlarms {
  get(name: string): Promise<unknown>;
  create(name: string, info: { periodInMinutes: number }): Promise<void> | void;
  clear(name: string): Promise<unknown>;
}

export function createPaperclipIntegrationRuntime(options: PaperclipBridgeDeps & { db: ThreadkeeperDB; alarms?: BridgeAlarms }) {
  // Secrets cached for features are dropped the moment any company's bridge fails (REQ-14 NF-8).
  let dropCachedSecrets = () => undefined as void;
  const bridge = new PaperclipBridge({ ...options, onDisconnect: (companyId) => { dropCachedSecrets(); options.onDisconnect?.(companyId); } });
  /** Independent of library sync (`paperclip.enabled`): a paired or revoking bridge keeps its own alarm. */
  const keepAlive = async (): Promise<boolean> => {
    const state = await bridge.status();
    const live = Object.values(state.companies).some(company => company.paired || company.pendingDisconnect);
    if (options.alarms) {
      if (live) { if (!await options.alarms.get(BRIDGE_KEEPALIVE_ALARM)) await options.alarms.create(BRIDGE_KEEPALIVE_ALARM, { periodInMinutes: 0.5 }); }
      else await options.alarms.clear(BRIDGE_KEEPALIVE_ALARM);
    }
    if (live) bridge.start();
    return live;
  };
  const start = createPaperclipStartCoordinator(() => helperPaperclip(chromeHelperEnv(), 'start'));
  const settings = () => ensureStarterCollectionsAndSettings(options.db);
  // Both checks use the current database record; an already-running feature cannot retain consent.
  // Short memory-only reuse keeps bulk indexing under Paperclip's 30 reads/minute. A cached value is
  // returned only while the pairing exists; consent is re-checked by every caller before reading.
  const secrets = createSecretReadCache((companyId, key) => bridge.resolveSecret(companyId, key));
  dropCachedSecrets = () => secrets.clear();
  const featureRead = async (companyId: string, key: ModelCredentialKey): Promise<string> => {
    if (!await bridge.getToken(companyId)) { secrets.clear(); throw new BridgeActionError('not_paired', 'Pair with Paperclip first.'); }
    return secrets.read(companyId, key);
  };
  configureModelCredentialResolver(async (companyId, key) => {
    const allowed = async () => {
      const config = (await settings()).paperclipCredentials;
      return config?.allowSecretTransfer && config.companyId === companyId && config.linkedKeys.includes(key);
    };
    // Coded errors let the feature notice tell "turned off" and "secret missing" from "not running".
    if (!await allowed()) { secrets.clear(); throw new BridgeActionError('disabled', 'Model key access is disabled'); }
    const value = await featureRead(companyId, key);
    if (!await allowed()) { secrets.clear(); throw new BridgeActionError('disabled', 'Model key access was disabled'); }
    return value;
  });
  return {
    bridge,
    keepAlive,
    async handle(message: { type: string; action?: unknown; payload?: unknown; retry?: unknown }): Promise<unknown> {
      if (message.type === 'PAPERCLIP_SERVICE_STATUS') return helperPaperclip(chromeHelperEnv(), 'status');
      if (message.type === 'PAPERCLIP_SERVICE_START') return start.start(message.retry === true);
      if (message.type === 'PAPERCLIP_SERVICE_INSTALL') return helperPaperclip(chromeHelperEnv(), 'install');
      if (message.type !== 'PAPERCLIP_INTEGRATION' || typeof message.action !== 'string' || message.action.length > 80) throw new Error('Invalid Paperclip command');
      const action = message.action;
      if (action === 'pair') {
        const current = await settings();
        if (!current.paperclip.hostEnabled) await saveSettingsPatch(options.db, { paperclip: { ...current.paperclip, hostEnabled: true } });
      }
      let data: unknown;
      // Any change to links, consent, source or pairing drops cached values before it runs.
      if (action !== 'credentials.resolve' && action !== 'status') secrets.clear();
      if (action.startsWith('credentials.')) data = await handleCredentialCommand(options.db, (companyId, key) => bridge.resolveSecret(companyId, key), action, message.payload, undefined, featureRead);
      else if (isSessionBoardCommand(action)) data = await proxySessionCommand(await settings(), action, message.payload);
      else data = await bridge.handleCommand(action, message.payload);
      await keepAlive();
      // Read-only refreshes may overlap user pairing before its token exists.
      // The bridge's own poll loop goes idle when no live/revoking pair remains;
      // stopping here would abort an unrelated in-flight pair or confirmation.
      return { ok: true, data };
    },
  };
}
