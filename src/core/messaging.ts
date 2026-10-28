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
  | 'RUN_ANALYSIS_NOW';

export type ContentScriptCommandType =
  | 'PASSIVE_DOM_CAPTURE'
  | 'OVERLAY_STATE_CHANGED'
  | 'GET_CAPTURE_AUTH_STATE'
  | 'OVERLAY_FRAME_STATUS'
  | 'OPEN_MANAGER_FALLBACK';

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
]);

const CONTENT_SCRIPT_TYPES = new Set<string>([
  'PASSIVE_DOM_CAPTURE',
  'GET_CAPTURE_AUTH_STATE',
  'OVERLAY_STATE_CHANGED',
  'OVERLAY_FRAME_STATUS',
  'OPEN_MANAGER_FALLBACK',
]);

export function validateRuntimeMessageSender(
  message: { type?: string; handshakeToken?: unknown } | null | undefined,
  sender: { id?: string; url?: string; tab?: { id?: number; url?: string } },
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
      `^chrome-extension://${expectedExtensionId}/(manager|sidepanel)\\.html(?:$|[?#])`
    ).test(senderUrl);
    const isDynamicExtensionManagerUrl =
      sender.id === expectedExtensionId &&
      /^chrome-extension:\/\/[a-z0-9-]+\/(manager|sidepanel)\.html(?:$|[?#])/i.test(senderUrl);
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
