import type { SettingsRecord } from '../schema.js';
import { normalizeServerUrl } from './client.js';
import { BRIDGE_API_PATH } from './bridge-protocol.js';

/** Board-only operations selected by a trusted manager. No arbitrary URL or bridge token escapes. */
const OPERATIONS: Record<string, { method: 'GET' | 'POST'; path: string }> = {
  links: { method: 'GET', path: 'links' },
  link: { method: 'POST', path: 'links' },
  unlink: { method: 'POST', path: 'links/remove' },
  tasks: { method: 'GET', path: 'tasks' },
  actions: { method: 'GET', path: 'actions' },
  plugin_policy: { method: 'GET', path: 'policy' },
  plugin_policy_update: { method: 'POST', path: 'policy' },
};

export function isSessionBoardCommand(action: string): boolean { return Object.hasOwn(OPERATIONS, action); }

export async function proxySessionCommand(settings: SettingsRecord, action: string, payload: unknown, request: typeof fetch = fetch): Promise<unknown> {
  if (!isSessionBoardCommand(action)) throw new Error('Unknown Paperclip session command');
  const op = OPERATIONS[action];
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('companyId is required');
  const data = payload as Record<string, unknown>;
  if (typeof data.companyId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(data.companyId)) throw new Error('companyId is required');
  const origin = normalizeServerUrl(settings.paperclip.serverUrl);
  if (!origin) throw new Error('Paperclip server address is invalid');
  const url = new URL(`${origin}${BRIDGE_API_PATH}/${op.path}`);
  if (op.method === 'GET') {
    for (const key of ['companyId', 'threadKey', 'issueId', 'q']) {
      if (typeof data[key] === 'string') url.searchParams.set(key, (data[key] as string).slice(0, 2000));
    }
  }
  const headers: Record<string, string> = { Accept: 'application/json', 'Content-Type': 'application/json' };
  if (settings.paperclip.auth === 'board_key' && settings.paperclip.apiKey) headers.Authorization = `Bearer ${settings.paperclip.apiKey}`;
  const response = await request(url.href, { method: op.method, headers, credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(15_000), ...(op.method === 'POST' ? { body: JSON.stringify(data) } : {}) });
  const text = await response.text();
  if (new TextEncoder().encode(text).byteLength > 4 * 1024 * 1024) throw new Error('Paperclip session response is too large');
  let result: Record<string, unknown>;
  try { result = JSON.parse(text); } catch { throw new Error('Paperclip returned an invalid session response'); }
  if (!response.ok || result?.ok === false || result?.error) {
    const error = result?.error;
    throw new Error(error && typeof error === 'object' && 'message' in error ? String(error.message).slice(0, 500) : `Paperclip session request failed (${response.status})`);
  }
  return result;
}
