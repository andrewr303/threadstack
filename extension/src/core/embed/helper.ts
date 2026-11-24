// The service worker's side of the Mac helper: a native messaging host that opens an isolated
// account's own Chrome profile window. Used only when the person granted the optional
// nativeMessaging permission; without it every call answers `helper_unavailable`.
//
// The message format and the checks the helper repeats live in helper-protocol.ts.
import type { AccountRecord, HelperPingResult, WorkspaceFailure } from '../workspace/types.js';
import { HELPER_HOST, helperOpenRequest, type HelperRequest, type PaperclipHelperResult } from './helper-protocol.js';

export type { PaperclipHelperResult } from './helper-protocol.js';

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

/**
 * Why the browser could not reach the helper, in words that say what to do, or null when the
 * error is not one of the browser's own ("Specified native messaging host not found." and so on).
 */
export function helperConnectionReason(err: unknown): string | null {
  const text = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
  if (/not found/i.test(text)) {
    return 'The Mac helper is not installed for this browser. Each browser needs its own registration: run Install Mac Helper.command again, which sets it up for every browser on this Mac.';
  }
  if (/forbidden/i.test(text)) {
    return 'The Mac helper is installed, but not for this copy of ThreadStack. Run Install Mac Helper.command again so it picks up this one.';
  }
  if (/exited/i.test(text)) {
    // The helper refuses a copy of ThreadStack it was not installed for by stopping at once; a
    // missing Node.js or a crash looks the same from here.
    return 'The Mac helper stopped before answering. Run Install Mac Helper.command again so it is set up for this copy of ThreadStack (it needs Node.js 22 or newer).';
  }
  return null;
}

export function helperFailure(err: unknown): WorkspaceFailure {
  const reason = helperConnectionReason(err);
  return reason ? { ok: false, code: 'helper_unavailable', error: reason } : UNAVAILABLE;
}

function boundedString(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

export async function helperPing(env: HelperEnv | null): Promise<HelperPingResult | WorkspaceFailure> {
  if (!env || !(await env.hasPermission().catch(() => false))) return UNAVAILABLE;
  let reply: unknown;
  try {
    reply = await env.send(HELPER_HOST, { type: 'ping' });
  } catch (err) {
    return helperFailure(err);
  }
  const r = reply as Record<string, unknown> | null;
  const version = boundedString(r?.version, 40);
  const platform = boundedString(r?.platform, 40);
  if (!r || r.ok !== true || !version || !platform) return UNAVAILABLE;
  return { ok: true, version, platform };
}

/** Only fixed lifecycle verbs cross native messaging; callers cannot supply executable paths. */
export async function helperPaperclip(env: HelperEnv | null, action: 'status' | 'start' | 'install'): Promise<PaperclipHelperResult> {
  if (!env || !(await env.hasPermission().catch(() => false))) return { ok: false, error: 'helper_unavailable' };
  try {
    const reply = await env.send(HELPER_HOST, { type: `paperclip.${action}` });
    const r = reply as Record<string, unknown> | null;
    if (r?.ok === true) {
      const service = (r.paperclip as { service?: unknown } | undefined)?.service;
      if (action === 'status' && (service === 'running' || service === 'stopped' || service === 'not_installed')) {
        return { ok: true, paperclip: { service } };
      }
      if (action !== 'status' && r.started === true) return { ok: true, started: true };
    }
    if (r?.ok === false && typeof r.error === 'string' && /^[a-z_]{1,80}$/.test(r.error)) return { ok: false, error: r.error };
  } catch { /* An older or missing helper is an unavailable lifecycle service. */ }
  return { ok: false, error: 'helper_unavailable' };
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
  } catch (err) {
    return helperFailure(err);
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
