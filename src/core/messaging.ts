import type { UpsertThreadInput } from './db.js';
import type { ProviderId } from './schema.js';

export type PrivilegedCommandType =
  | 'REDEEM_OVERLAY_HANDSHAKE'
  | 'OPEN_FULL_PAGE_MANAGER'
  | 'OPEN_ORIGINAL_THREAD'
  | 'CLOSE_THREADKEEPER_OVERLAY'
  | 'DELETE_THREAD'
  | 'EXPORT_BUNDLE'
  | 'UPDATE_SETTINGS'
  | 'RUN_RESUMABLE_JOBS'
  | 'SETTINGS_CHANGED'
  | 'RUN_ANALYSIS_NOW'
  | 'GET_DIAGNOSTICS'
  | 'START_HISTORY_SYNC'
  | 'CANCEL_HISTORY_SYNC'
  | 'GET_HISTORY_SYNC_STATE'
  | 'CAPTURE_TAB_NOW'
  | 'CAPTURE_SITES_CHANGED'
  | 'PAPERCLIP_SYNC_NOW'
  | DockCommandType;

/** Sidebar Dock (Still) link: manager pages and the consent page (connect.html) only. */
export type DockCommandType =
  | 'DOCK_SYNC_NOW'
  | 'DOCK_GET_STATE'
  | 'DOCK_PENDING'
  | 'DOCK_DECIDE'
  | 'DOCK_UNPAIR'
  | 'DOCK_SEND'
  | 'DOCK_COLLECTIONS'
  | 'DOCK_STATUS_FOR'
  | 'DOCK_SET_OPTIONS'
  | 'DOCK_UNBLOCK'
  | 'DOCK_RESYNC'
  | 'DOCK_OPEN_CONSENT';

export const DOCK_COMMAND_TYPES: ReadonlySet<string> = new Set<DockCommandType>([
  'DOCK_SYNC_NOW',
  'DOCK_GET_STATE',
  'DOCK_PENDING',
  'DOCK_DECIDE',
  'DOCK_UNPAIR',
  'DOCK_SEND',
  'DOCK_COLLECTIONS',
  'DOCK_STATUS_FOR',
  'DOCK_SET_OPTIONS',
  'DOCK_UNBLOCK',
  'DOCK_RESYNC',
  'DOCK_OPEN_CONSENT',
]);

export type ContentScriptCommandType =
  | 'PASSIVE_DOM_CAPTURE'
  | 'OVERLAY_STATE_CHANGED'
  | 'GET_CAPTURE_AUTH_STATE'
  | 'OVERLAY_FRAME_STATUS'
  | 'OPEN_MANAGER_FALLBACK'
  | 'HISTORY_SYNC_EVENT'
  | 'GET_CAPTURE_SITE';

export type ExtensionMessage =
  | {
      type: 'REDEEM_OVERLAY_HANDSHAKE';
      handshakeToken: string;
    }
  | {
      type: 'OPEN_FULL_PAGE_MANAGER';
      threadKey?: string | null;
      query?: string;
      handshakeToken?: string;
    }
  | {
      type: 'OPEN_ORIGINAL_THREAD';
      canonicalUrl: string;
      provider: ProviderId;
      expectedAccountId: string;
      expectedWorkspaceId: string;
      handshakeToken?: string;
    }
  | {
      type: 'PASSIVE_DOM_CAPTURE';
      payload: Omit<UpsertThreadInput, 'threadKey' | 'accountId' | 'workspaceId'>;
    }
  | {
      type: 'GET_CAPTURE_AUTH_STATE';
      provider: ProviderId;
    }
  | {
      type: 'TOGGLE_THREADKEEPER_OVERLAY';
      invocationSource: 'toolbar_action' | 'keyboard_command' | 'test_harness';
      handshakeToken: string;
    }
  | {
      type: 'CLOSE_THREADKEEPER_OVERLAY';
      handshakeToken: string;
    };

export interface SenderValidationResult {
  allowed: boolean;
  reason?: string;
}

const PRIVILEGED_TYPES = new Set<string>([
  'REDEEM_OVERLAY_HANDSHAKE',
  'OPEN_FULL_PAGE_MANAGER',
  'OPEN_ORIGINAL_THREAD',
  'CLOSE_THREADKEEPER_OVERLAY',
  'DELETE_THREAD',
  'EXPORT_BUNDLE',
  'UPDATE_SETTINGS',
  'RUN_RESUMABLE_JOBS',
  'SETTINGS_CHANGED',
  'RUN_ANALYSIS_NOW',
  'GET_DIAGNOSTICS',
  'START_HISTORY_SYNC',
  'CANCEL_HISTORY_SYNC',
  'GET_HISTORY_SYNC_STATE',
  'CAPTURE_TAB_NOW',
  'CAPTURE_SITES_CHANGED',
  'PAPERCLIP_SYNC_NOW',
  ...DOCK_COMMAND_TYPES,
]);

const CONTENT_SCRIPT_TYPES = new Set<string>([
  'PASSIVE_DOM_CAPTURE',
  'GET_CAPTURE_AUTH_STATE',
  'OVERLAY_STATE_CHANGED',
  'OVERLAY_FRAME_STATUS',
  'OPEN_MANAGER_FALLBACK',
  'HISTORY_SYNC_EVENT',
  'GET_CAPTURE_SITE',
]);

/** The fields of chrome.runtime.MessageSender the checks below read. */
export interface RuntimeSender {
  id?: string;
  url?: string;
  origin?: string;
  frameId?: number;
  tab?: { id?: number; url?: string };
}

/**
 * The page a capture-related content-script message came from: the sending frame's own URL,
 * which must be the top frame (frameId 0) of an http(s) page. Captures are never accepted from
 * iframes (an embedded page could otherwise file itself under the site that frames it), from
 * extension pages, or when the browser did not say which page sent it. Where the browser also
 * reports `sender.origin`, it must agree with the URL.
 */
export function captureSenderUrl(sender: RuntimeSender | null | undefined): string | null {
  if (!sender || !sender.tab) return null;
  if (typeof sender.frameId === 'number' && sender.frameId !== 0) return null;
  const url = sender.url ?? '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (typeof sender.origin === 'string' && sender.origin !== 'null' && sender.origin !== parsed.origin) return null;
  return parsed.href;
}

export function validateRuntimeMessageSender(
  message: { type?: string; handshakeToken?: unknown } | null | undefined,
  sender: RuntimeSender,
  expectedExtensionId: string
): SenderValidationResult {
  if (!message || typeof message.type !== 'string') {
    return { allowed: false, reason: 'Malformed message without type' };
  }

  if (sender.id && sender.id !== expectedExtensionId) {
    return {
      allowed: false,
      reason: `Rejected foreign extension sender: ${sender.id}`,
    };
  }

  if (PRIVILEGED_TYPES.has(message.type)) {
    const senderUrl = sender.url ?? '';
    const isOwnManagerPage = new RegExp(
      `^chrome-extension://${expectedExtensionId}/(manager|sidepanel|connect)\\.html(?:$|[?#])`
    ).test(senderUrl);
    const isDynamicExtensionManagerUrl =
      sender.id === expectedExtensionId &&
      /^chrome-extension:\/\/[a-z0-9-]+\/(manager|sidepanel|connect)\.html(?:$|[?#])/i.test(senderUrl);
    if (!isOwnManagerPage && !isDynamicExtensionManagerUrl) {
      return {
        allowed: false,
        reason: `Rejected privileged action "${message.type}" from non-manager origin: ${senderUrl || 'unknown'}`,
      };
    }
    if (
      message.type === 'CLOSE_THREADKEEPER_OVERLAY' ||
      message.type === 'REDEEM_OVERLAY_HANDSHAKE'
    ) {
      if (
        typeof message.handshakeToken !== 'string' ||
        message.handshakeToken.trim().length < 16
      ) {
        return {
          allowed: false,
          reason: `Rejected "${message.type}" with missing or short handshakeToken`,
        };
      }
    }
    return { allowed: true };
  }

  if (CONTENT_SCRIPT_TYPES.has(message.type)) {
    if (!sender.tab && !sender.url) {
      return {
        allowed: false,
        reason: `Rejected content-script message "${message.type}" without tab context`,
      };
    }
    return { allowed: true };
  }

  return { allowed: false, reason: `Unknown message type: ${message.type}` };
}

export function validateWindowPostMessage(
  event: {
    origin: string;
    data: unknown;
  },
  expectedExtensionOrigin: string,
  expectedHandshakeToken: string
): SenderValidationResult {
  if (!event.data || typeof event.data !== 'object') {
    return { allowed: false, reason: 'Non-object postMessage data' };
  }
  const payload = event.data as {
    source?: string;
    handshakeToken?: string;
    action?: string;
  };
  if (payload.source !== 'threadkeeper-manager-iframe') {
    return { allowed: false, reason: 'Unrecognized postMessage source' };
  }
  if (event.origin !== expectedExtensionOrigin) {
    return {
      allowed: false,
      reason: `Rejected postMessage from untrusted origin: ${event.origin}`,
    };
  }
  if (
    !expectedHandshakeToken ||
    payload.handshakeToken !== expectedHandshakeToken
  ) {
    return {
      allowed: false,
      reason: 'Rejected postMessage with missing or invalid handshakeToken',
    };
  }
  return { allowed: true };
}

/**
 * Consent decisions and unpairing come only from a top-level Threadkeeper page: never from the
 * manager framed inside a website (the overlay), where a hostile page could trick a click.
 * DOCK_DECIDE additionally requires connect.html itself.
 */
export function validateDockPageSender(
  type: string,
  sender: { id?: string; url?: string; frameId?: number; tab?: { id?: number; url?: string } },
  expectedExtensionId: string
): SenderValidationResult {
  const base = `chrome-extension://${expectedExtensionId}/`;
  const url = sender.url ?? '';
  if (sender.id && sender.id !== expectedExtensionId) return { allowed: false, reason: `Rejected ${type} from a foreign extension` };
  if (typeof sender.frameId === 'number' && sender.frameId !== 0) return { allowed: false, reason: `Rejected ${type} from a framed page` };
  if (sender.tab && !(sender.tab.url ?? '').startsWith(base)) return { allowed: false, reason: `Rejected ${type} from a page inside a website` };
  if (type === 'DOCK_DECIDE' && !new RegExp(`^chrome-extension://${expectedExtensionId}/connect\\.html(?:$|[?#])`).test(url)) {
    return { allowed: false, reason: 'Rejected DOCK_DECIDE outside the Threadkeeper consent window' };
  }
  return { allowed: true };
}
