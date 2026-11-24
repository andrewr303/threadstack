/**
 * Signing ThreadStack in to an authenticated Paperclip server.
 *
 * A local_trusted instance (the `npx paperclipai onboard` default) treats every request on the
 * loopback interface as its board, so nothing is needed. An authenticated instance gets a board
 * API key through the same approval flow the Paperclip CLI uses:
 *
 *   1. POST /api/cli-auth/challenges (anonymous) → { id, token, boardApiToken, approvalUrl, … }
 *   2. the user approves in Paperclip at approvalUrl (opened in a tab)
 *   3. poll GET /api/cli-auth/challenges/:id?token=… until status is "approved"
 *   4. boardApiToken is now a working key; GET /api/cli-auth/me confirms who it signs in as
 *
 * A key the user pastes (pcp_board_…) is checked the same way. Board keys last 30 days.
 */
import { PaperclipClient, PaperclipError, type FetchLike, type PcMe } from './client.js';

/** Board keys expire 30 days after they are issued (BOARD_API_KEY_TTL_MS in Paperclip). */
export const BOARD_KEY_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const BOARD_KEY_RE = /^pcp_board_[A-Za-z0-9_-]{16,}$/;

export function looksLikeBoardKey(value: string): boolean {
  return BOARD_KEY_RE.test(value.trim());
}

export interface SignedIn {
  apiKey: string;
  accountLabel: string;
  /** ISO time the key stops working, or '' when unknown. */
  expiresAt: string;
}

export function describeAccount(me: PcMe): string {
  const name = me.user?.name?.trim();
  const email = me.user?.email?.trim();
  if (name && email) return `${name} (${email})`;
  return name || email || (me.userId === 'local-board' ? 'Local board' : me.userId);
}

/** Check a key against GET /api/cli-auth/me and describe whose it is. */
export async function verifyBoardKey(
  serverUrl: string,
  apiKey: string,
  options: { fetch?: FetchLike; now?: () => number } = {}
): Promise<SignedIn> {
  const key = apiKey.trim();
  if (!key) throw new PaperclipError('unauthorized', 'Paste a board API key first.');
  const client = new PaperclipClient({ serverUrl, apiKey: key, fetch: options.fetch });
  let me: PcMe;
  try {
    me = await client.me();
  } catch (err) {
    if (err instanceof PaperclipError && (err.kind === 'unauthorized' || err.kind === 'forbidden')) {
      throw new PaperclipError('unauthorized', 'Paperclip did not accept this key. It may have expired or been revoked.');
    }
    throw err;
  }
  if (!me || typeof me.userId !== 'string') {
    throw new PaperclipError('bad_response', 'Paperclip did not say who this key belongs to.');
  }
  return { apiKey: key, accountLabel: describeAccount(me), expiresAt: '' };
}

export type ApprovalStatus =
  | { phase: 'waiting'; approvalUrl: string; expiresAt: string }
  | { phase: 'approved'; signedIn: SignedIn }
  | { phase: 'failed'; message: string };

export interface ApprovalFlowOptions {
  serverUrl: string;
  fetch?: FetchLike;
  /** Opens the approval page for the user (a new tab). */
  openUrl: (url: string) => void | Promise<void>;
  onStatus?: (status: ApprovalStatus) => void;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** Poll interval floor; Paperclip suggests 1 s, and polling is rate limited per IP. */
  pollIntervalMs?: number;
}

const sleepFor = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });

/**
 * Run the approval flow end to end. Resolves with the new key once the user approves, or throws a
 * PaperclipError when the request is cancelled, expires, or the server cannot be reached.
 */
export async function signInWithApproval(options: ApprovalFlowOptions): Promise<SignedIn> {
  const now = options.now ?? (() => Date.now());
  const sleep = options.sleep ?? ((ms: number) => sleepFor(ms, options.signal));
  const client = new PaperclipClient({ serverUrl: options.serverUrl, fetch: options.fetch, signal: options.signal });
  const challenge = await client.createCliAuthChallenge();
  if (!challenge?.id || !challenge.token || !challenge.boardApiToken) {
    throw new PaperclipError('bad_response', 'Paperclip did not start an approval request.');
  }
  const approvalUrl = challenge.approvalUrl || `${client.serverUrl}${challenge.approvalPath}`;
  const deadline = Date.parse(challenge.expiresAt) || now() + 10 * 60 * 1000;
  options.onStatus?.({ phase: 'waiting', approvalUrl, expiresAt: new Date(deadline).toISOString() });
  await options.openUrl(approvalUrl);

  const interval = Math.max(options.pollIntervalMs ?? 1500, challenge.suggestedPollIntervalMs || 1000);
  for (;;) {
    if (options.signal?.aborted) throw new PaperclipError('aborted', 'Sign-in was cancelled.');
    if (now() > deadline) throw new PaperclipError('unauthorized', 'The approval request expired. Start again.');
    await sleep(interval);
    if (options.signal?.aborted) throw new PaperclipError('aborted', 'Sign-in was cancelled.');
    let status: string;
    try {
      status = (await client.getCliAuthChallenge(challenge.id, challenge.token)).status;
    } catch (err) {
      // A missed poll (rate limit, brief network hiccup) is retried on the next tick.
      if (err instanceof PaperclipError && (err.kind === 'rate_limited' || err.kind === 'timeout' || err.kind === 'unreachable')) continue;
      throw err;
    }
    if (status === 'pending') continue;
    if (status === 'approved') {
      const signedIn = await verifyBoardKey(options.serverUrl, challenge.boardApiToken, { fetch: options.fetch });
      const result = { ...signedIn, expiresAt: new Date(now() + BOARD_KEY_TTL_MS).toISOString() };
      options.onStatus?.({ phase: 'approved', signedIn: result });
      return result;
    }
    const message =
      status === 'cancelled' ? 'The request was declined in Paperclip.' : 'The approval request expired. Start again.';
    options.onStatus?.({ phase: 'failed', message });
    throw new PaperclipError('unauthorized', message);
  }
}

/** Best effort: tell Paperclip to revoke the key ThreadStack holds. */
export async function revokeBoardKey(serverUrl: string, apiKey: string, fetchImpl?: FetchLike): Promise<boolean> {
  if (!apiKey.trim()) return false;
  try {
    await new PaperclipClient({ serverUrl, apiKey, fetch: fetchImpl, timeoutMs: 5000 }).revokeCurrentKey();
    return true;
  } catch {
    return false;
  }
}
