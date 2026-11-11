// Page-side client for the workspace commands (accounts, embedding, the Mac helper). Every call
// goes to the service worker, which accepts them only from this page running as its own tab.
// Calls never throw: failures come back as { ok: false, error } with plain wording.
import type {
  AccountColor,
  AccountMode,
  AccountsChangeResult,
  AccountsListResult,
  EmbedFrameCommand,
  HelperPingResult,
  WorkspaceCommand,
  WorkspaceFailure,
  WorkspaceHelloResult,
} from '../../../core/workspace/types.js';

type SendFn = (message: WorkspaceCommand) => Promise<unknown>;
type FrameSendFn = (tabId: number, frameId: number, message: EmbedFrameCommand) => Promise<unknown>;

let sendOverride: SendFn | null = null;
let frameSendOverride: FrameSendFn | null = null;

/** Tests inject their own transport; pass null to restore the real one. */
export function configureWorkspaceClient(options: { send?: SendFn | null; sendToFrame?: FrameSendFn | null }): void {
  if (options.send !== undefined) sendOverride = options.send;
  if (options.sendToFrame !== undefined) frameSendOverride = options.sendToFrame;
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
  activateAccount: (accountId: string) => call<AccountsChangeResult>({ type: 'ACCOUNTS_ACTIVATE', accountId }),
  updateAccount: (accountId: string, patch: { label?: string; color?: AccountColor }) =>
    call<AccountsChangeResult>({ type: 'ACCOUNTS_UPDATE', accountId, ...patch }),
  removeAccount: (accountId: string) => call<AccountsChangeResult>({ type: 'ACCOUNTS_REMOVE', accountId }),
  helperPing: () => call<HelperPingResult>({ type: 'HELPER_PING' }),
  helperOpen: (accountId: string, url: string) => call<{ ok: true }>({ type: 'HELPER_OPEN', accountId, url }),
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
