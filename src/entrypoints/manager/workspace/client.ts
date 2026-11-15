// Page-side client for the workspace commands (accounts, embedding, the Mac helper). Every call
// goes to the service worker, which accepts them only from this page running as its own tab.
// Calls never throw: failures come back as { ok: false, error } with plain wording.
import {
  WORKSPACE_PORT_BEAT_MS,
  WORKSPACE_PORT_NAME,
  type AccountColor,
  type AccountMode,
  type AccountsChangeResult,
  type AccountsListResult,
  type EmbedFrameCommand,
  type HelperPingResult,
  type ProfileClaimResult,
  type WorkspaceCommand,
  type WorkspaceFailure,
  type WorkspaceHelloResult,
} from '../../../core/workspace/types.js';

import type { BackupNowResult, BackupRestoreResult, BackupStatus } from '../../../core/backup-helper.js';

type SendFn = (message: WorkspaceCommand) => Promise<unknown>;
type FrameSendFn = (tabId: number, frameId: number, message: EmbedFrameCommand) => Promise<unknown>;
type SeedFn = (url: string) => Promise<void>;

let sendOverride: SendFn | null = null;
let frameSendOverride: FrameSendFn | null = null;
let seedOverride: SeedFn | null = null;
let reloadOverride: (() => void) | null = null;

/** Tests inject their own transport; pass null to restore the real one. */
export function configureWorkspaceClient(options: {
  send?: SendFn | null;
  sendToFrame?: FrameSendFn | null;
  /** How a seeding address is loaded (the real one uses a hidden credentialless frame). */
  seed?: SeedFn | null;
  /** How the page reloads itself. */
  reload?: (() => void) | null;
}): void {
  if (options.send !== undefined) sendOverride = options.send;
  if (options.sendToFrame !== undefined) frameSendOverride = options.sendToFrame;
  if (options.seed !== undefined) seedOverride = options.seed;
  if (options.reload !== undefined) reloadOverride = options.reload;
}

function transport(): SendFn | null {
  if (sendOverride) return sendOverride;
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendMessage) return null;
  return (message) => chrome.runtime.sendMessage(message) as Promise<unknown>;
}

async function call<T extends { ok: true }>(command: WorkspaceCommand): Promise<T | WorkspaceFailure> {
  const send = transport();
  if (!send) return { ok: false, error: 'Threadkeeper is not running as an extension here.' };
  try {
    const res = (await send(command)) as (Record<string, unknown> & { ok?: unknown }) | undefined;
    if (res && res.ok === true) return res as unknown as T;
    const error = typeof res?.error === 'string' && res.error.trim() ? res.error.trim() : 'That did not work.';
    const code = typeof res?.code === 'string' ? (res.code as WorkspaceFailure['code']) : undefined;
    return { ok: false, error, code };
  } catch (err) {
    return {
      ok: false,
      error: `Threadkeeper's background did not answer (${err instanceof Error ? err.message : String(err)}).`,
    };
  }
}

export const workspaceApi = {
  /** Register this tab for embedding and learn the accounts. Call once when the page opens. */
  hello: () => call<WorkspaceHelloResult>({ type: 'WORKSPACE_HELLO' }),
  listAccounts: () => call<AccountsListResult>({ type: 'ACCOUNTS_LIST' }),
  addAccount: (input: { realm: string; mode: AccountMode; label?: string; color?: AccountColor; profileId?: string }) =>
    call<AccountsChangeResult>({ type: 'ACCOUNTS_ADD', ...input }),
  /** Make the account the browser's own sign-in for its realm (changes every tab). */
  activateAccount: (accountId: string) => call<AccountsChangeResult>({ type: 'ACCOUNTS_ACTIVATE', accountId }),
  beginBrowserSignIn: (accountId: string) => call<AccountsChangeResult>({ type: 'ACCOUNTS_SIGNIN_BEGIN', accountId }),
  finishBrowserSignIn: () => call<AccountsChangeResult>({ type: 'ACCOUNTS_SIGNIN_FINISH' }),
  cancelBrowserSignIn: () => call<AccountsChangeResult>({ type: 'ACCOUNTS_SIGNIN_CANCEL' }),
  /** Show a profile account in this page's slot of its realm; answers the addresses to load. */
  claimProfile: (realm: string, accountId: string) => call<ProfileClaimResult>({ type: 'PROFILE_CLAIM', realm, accountId }),
  profileReady: (realm: string) => call<{ ok: true }>({ type: 'PROFILE_READY', realm }),
  updateAccount: (accountId: string, patch: { label?: string; color?: AccountColor }) =>
    call<AccountsChangeResult>({ type: 'ACCOUNTS_UPDATE', accountId, ...patch }),
  removeAccount: (accountId: string) => call<AccountsChangeResult>({ type: 'ACCOUNTS_REMOVE', accountId }),
  helperPing: () => call<HelperPingResult>({ type: 'HELPER_PING' }),
  helperOpen: (accountId: string, url: string) => call<{ ok: true }>({ type: 'HELPER_OPEN', accountId, url }),
  backupStatus: () => call<BackupStatus>({ type: 'BACKUP_STATUS' }),
  backupNow: () => call<Extract<BackupNowResult, { ok: true }>>({ type: 'BACKUP_NOW' }),
  backupRestore: (name: string) => call<Extract<BackupRestoreResult, { ok: true }>>({ type: 'BACKUP_RESTORE', name }),
};

/**
 * Ask one embedded page to go back, forward, reload or open an address. Resolves false when
 * the page has no listener (still loading, blocked, or not a site Threadkeeper reads).
 */
export async function sendFrameCommand(tabId: number, frameId: number, command: EmbedFrameCommand): Promise<boolean> {
  try {
    if (frameSendOverride) {
      await frameSendOverride(tabId, frameId, command);
      return true;
    }
    if (typeof chrome === 'undefined' || !chrome.tabs?.sendMessage) return false;
    await chrome.tabs.sendMessage(tabId, command, { frameId });
    return true;
  } catch {
    return false;
  }
}

/** Sandbox of the hidden frames that put a profile's cookies in place: the measured arrangement. */
const SEED_SANDBOX = 'allow-scripts allow-same-origin';
/** A seeding address that has not loaded after this long is given up on; the worker says whether it answered. */
const SEED_TIMEOUT_MS = 12_000;

/**
 * Load one seeding address in a hidden credentialless frame and wait for it. The response is
 * what matters (the worker's header rule adds the account's cookies to it); the frame is removed
 * as soon as it has loaded. Never rejects: PROFILE_READY reports an address that did not answer.
 */
export function loadSeed(url: string): Promise<void> {
  if (seedOverride) return seedOverride(url).catch(() => undefined);
  if (typeof document === 'undefined' || !/^https:\/\//.test(url)) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const frame = document.createElement('iframe');
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      frame.remove();
      resolve();
    };
    const timer = setTimeout(finish, SEED_TIMEOUT_MS);
    frame.setAttribute('credentialless', '');
    frame.setAttribute('sandbox', SEED_SANDBOX);
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.dataset.tkSeed = 'true';
    frame.style.cssText = 'position:fixed;width:1px;height:1px;left:-10px;top:-10px;border:0;opacity:0;pointer-events:none';
    frame.addEventListener('load', finish);
    frame.addEventListener('error', finish);
    frame.src = url;
    document.body.appendChild(frame);
  });
}

/** Reload the workspace page: the only way to a fresh profile partition. */
export function reloadWorkspacePage(): void {
  if (reloadOverride) {
    reloadOverride();
    return;
  }
  if (typeof window !== 'undefined') window.location.reload();
}

/**
 * Keep a port open to the service worker while this page shows, with a message every few
 * seconds, so the worker that follows the cookies of profile pages is not put to sleep under a
 * page in use. Reconnects when the worker restarts. Returns a stop function.
 */
export function startWorkspacePort(): () => void {
  if (typeof chrome === 'undefined' || !chrome.runtime?.connect) return () => undefined;
  let stopped = false;
  let port: chrome.runtime.Port | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let retry: ReturnType<typeof setTimeout> | null = null;
  const connect = () => {
    if (stopped) return;
    try {
      port = chrome.runtime.connect({ name: WORKSPACE_PORT_NAME });
      port.onDisconnect.addListener(() => {
        // Reading lastError keeps Chrome from logging it.
        void chrome.runtime.lastError;
        port = null;
        if (!stopped) retry = setTimeout(connect, 1_000);
      });
    } catch {
      port = null;
      if (!stopped) retry = setTimeout(connect, 5_000);
    }
  };
  connect();
  beat = setInterval(() => {
    try {
      port?.postMessage({ type: 'beat' });
    } catch {
      // the disconnect handler reconnects
    }
  }, WORKSPACE_PORT_BEAT_MS);
  return () => {
    stopped = true;
    if (beat) clearInterval(beat);
    if (retry) clearTimeout(retry);
    try {
      port?.disconnect();
    } catch {
      // already closed
    }
  };
}
