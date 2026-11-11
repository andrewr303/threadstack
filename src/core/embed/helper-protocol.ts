// Messages between the extension and the Mac helper (mac-helper/), and the checks the helper
// repeats on its side. Pure: no chrome API, so pages, the worker and tests can all use it.
import type { AccountRecord } from '../workspace/types.js';

/** Native messaging host name; must equal HOST in mac-helper/core.cjs. */
export const HELPER_HOST = 'com.threadkeeper.accounts';

const BASE_HOSTS = [
  'claude.ai', 'chatgpt.com', 'chat.openai.com', 'grok.com', 'x.com', 'twitter.com', 'cursor.com',
  'muse.ai', 'meta.ai', 'gemini.google.com', 'aistudio.google.com', 'jules.google.com',
  'perplexity.ai', 'chat.deepseek.com', 'chat.mistral.ai', 'copilot.microsoft.com', 'copilot.com',
  'github.com', 'app.devin.ai',
];
const SIGN_IN_HOSTS = ['auth.openai.com', 'accounts.x.ai', 'authenticator.cursor.sh'];

/** Hosts the helper will open. A test proves this equals ALLOWED_HOSTS in mac-helper/core.cjs. */
export const HELPER_ALLOWED_HOSTS: readonly string[] = [
  ...BASE_HOSTS.flatMap((h) => [h, `www.${h}`]),
  ...SIGN_IN_HOSTS,
];

export const HELPER_PROFILE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type HelperRequest =
  | { type: 'ping' }
  | { type: 'open'; profileId: string; url: string };

export type HelperResponse =
  | { ok: true; version: string; platform: string }
  | { ok: true; opened: true }
  | { ok: false; error: string };

/** Whether `value` is an address the helper accepts: https, allow-listed host, nothing unusual. */
export function isHelperUrl(value: string): boolean {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    return false;
  }
  return (
    u.protocol === 'https:' &&
    !u.port &&
    !u.username &&
    !u.password &&
    HELPER_ALLOWED_HOSTS.includes(u.hostname)
  );
}

/** The open message for an isolated account, or an error string saying why it cannot be sent. */
export function helperOpenRequest(
  account: Pick<AccountRecord, 'mode' | 'profileId'>,
  url: string
): Extract<HelperRequest, { type: 'open' }> | string {
  if (account.mode !== 'isolated') return 'Only separate-window accounts open through the Mac helper.';
  if (!account.profileId || !HELPER_PROFILE_ID.test(account.profileId)) return 'Invalid account profile ID.';
  if (!isHelperUrl(url)) return 'Only https addresses on supported AI sites may be opened.';
  return { type: 'open', profileId: account.profileId, url };
}
