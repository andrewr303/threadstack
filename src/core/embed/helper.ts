// The service worker's side of the Mac helper: a native messaging host that opens an isolated
// account's own Chrome profile window. Used only when the person granted the optional
// nativeMessaging permission; without it every call answers `helper_unavailable`.
//
// The message format and the checks the helper repeats live in helper-protocol.ts.
import type { AccountRecord, HelperPingResult, WorkspaceFailure } from '../workspace/types.js';
import { HELPER_HOST, helperOpenRequest, type HelperRequest } from './helper-protocol.js';

export interface HelperEnv {
  /** Whether the optional nativeMessaging permission is held right now. */
  hasPermission(): Promise<boolean>;
  send(host: string, message: HelperRequest): Promise<unknown>;
}

const UNAVAILABLE: WorkspaceFailure = {
  ok: false,
  code: 'helper_unavailable',
  error: 'The Mac helper is not set up. Install it from Settings, then try again.',
};

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export async function helperPing(env: HelperEnv | null): Promise<HelperPingResult | WorkspaceFailure> {
  if (!env || !(await env.hasPermission().catch(() => false))) return UNAVAILABLE;
  let reply: unknown;
  try {
    reply = await env.send(HELPER_HOST, { type: 'ping' });
  } catch {
    // Host not installed, or it exited: the browser reports both the same way.
    return UNAVAILABLE;
  }
  const r = reply as Record<string, unknown> | null;
  const version = boundedString(r?.version, 40);
  const platform = boundedString(r?.platform, 40);
  if (!r || r.ok !== true || !version || !platform) return UNAVAILABLE;
  return { ok: true, version, platform };
}

export async function helperOpen(
  env: HelperEnv | null,
  account: Pick<AccountRecord, 'mode' | 'profileId'> | null,
  url: unknown
): Promise<{ ok: true } | WorkspaceFailure> {
  if (!account) return { ok: false, code: 'unknown_account', error: 'That account no longer exists.' };
  const request = helperOpenRequest(account, typeof url === 'string' ? url : '');
  if (typeof request === 'string') return { ok: false, code: 'not_allowed', error: request };
  if (!env || !(await env.hasPermission().catch(() => false))) return UNAVAILABLE;
  let reply: unknown;
  try {
    reply = await env.send(HELPER_HOST, request);
  } catch {
    return UNAVAILABLE;
  }
  const r = reply as Record<string, unknown> | null;
  if (r?.ok === true && r.opened === true) return { ok: true };
  // The helper's own reasons are short fixed sentences (mac-helper/core.cjs). Anything that looks
  // like a file path (a system error carrying the home folder) is not shown.
  const reason = boundedString(r?.error, 200);
  return {
    ok: false,
    code: 'helper_unavailable',
    error: reason && !/[\\/]/.test(reason) ? reason : 'The Mac helper could not open that window.',
  };
}

/** chrome.runtime.sendNativeMessage behind HelperEnv; null outside an extension worker. */
export function chromeHelperEnv(): HelperEnv | null {
  if (typeof chrome === 'undefined' || !chrome.runtime?.sendNativeMessage || !chrome.permissions?.contains) return null;
  return {
    hasPermission: () => chrome.permissions.contains({ permissions: ['nativeMessaging'] }),
    send: (host, message) => chrome.runtime.sendNativeMessage(host, message),
  };
}
