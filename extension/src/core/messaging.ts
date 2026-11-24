import type { UpsertThreadInput } from './db.js';
import type { ProviderId } from './schema.js';
import { isProviderAllowedOnUrl, isProviderId } from './providers.js';
import { EMBED_FRAME_EVENT_TYPES, WORKSPACE_COMMAND_TYPES } from './workspace/types.js';

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
 * What the worker knows about embedding, for recognising a page embedded in the workspace.
 * Everything is decided from chrome's sender object; nothing a message says is used.
 */
export interface EmbedSenderContext {
  extensionId: string;
  /** Whether the tab is a workspace tab the worker remembers (it said WORKSPACE_HELLO). */
  isWorkspaceTab: (tabId: number) => boolean;
  /** Plain-http pages are accepted only on loopback hosts and on sites the person added. */
  isAddedSiteUrl?: (url: string) => boolean;
}

function managerPageRe(extensionId: string): RegExp {
  return new RegExp(`^chrome-extension://${extensionId.replace(/[^a-z0-9]/gi, '')}/manager\\.html(?:$|[?#])`);
}

function isLoopbackHostname(host: string): boolean {
  return host === 'localhost' || /^127(?:\.\d{1,3}){3}$/.test(host) || host === '[::1]';
}

/**
 * The address of a page embedded in a workspace tab, or null when the sender is anything else.
 * An embedded frame is a content script of this extension in a frame (frameId not 0) of a tab
 * the worker remembers as a workspace tab, whose top document is ThreadStack's manager.html;
 * its own address is https (http only on loopback or an added site) and its origin agrees.
 *
 * The worker cannot see how deep the frame sits: a provider frame nested inside an embedded
 * page looks the same from here. The embed content script reports only when its single
 * ancestor (location.ancestorOrigins) is the extension itself.
 */
export function embeddedFrameUrl(sender: RuntimeSender | null | undefined, ctx: EmbedSenderContext | null | undefined): string | null {
  if (!sender || !ctx || sender.id !== ctx.extensionId) return null;
  const tabId = sender.tab?.id;
  if (typeof tabId !== 'number' || !ctx.isWorkspaceTab(tabId)) return null;
  if (!managerPageRe(ctx.extensionId).test(sender.tab?.url ?? '')) return null;
  if (typeof sender.frameId !== 'number' || sender.frameId === 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(sender.url ?? '');
  } catch {
    return null;
  }
  if (parsed.username || parsed.password) return null;
  if (parsed.protocol === 'http:') {
    if (!isLoopbackHostname(parsed.hostname) && !ctx.isAddedSiteUrl?.(parsed.href)) return null;
  } else if (parsed.protocol !== 'https:') {
    return null;
  }
  if (sender.origin !== parsed.origin) return null;
  return parsed.href;
}

/** The capture page a content-script message came from, and whether it is embedded in the workspace. */
export function captureSenderPage(
  sender: RuntimeSender | null | undefined,
  embed?: EmbedSenderContext | null
): { url: string; embedded: boolean } | null {
  if (!sender || !sender.tab) return null;
  if (typeof sender.frameId === 'number' && sender.frameId !== 0) {
    const url = embeddedFrameUrl(sender, embed);
    return url ? { url, embedded: true } : null;
  }
  const url = sender.url ?? '';
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
  if (typeof sender.origin === 'string' && sender.origin !== 'null' && sender.origin !== parsed.origin) return null;
  return { url: parsed.href, embedded: false };
}

/**
 * The page a capture-related content-script message came from: the sending frame's own URL,
 * which must be the top frame (frameId 0) of an http(s) page. Captures are never accepted from
 * other iframes (an embedded page could otherwise file itself under the site that frames it),
 * from extension pages, or when the browser did not say which page sent it. Where the browser
 * also reports `sender.origin`, it must agree with the URL. The one kind of frame accepted is a
 * page embedded in ThreadStack's own workspace tab (embeddedFrameUrl), and only when `embed`
 * is given; it is still checked against its own URL, never the tab's.
 */
export function captureSenderUrl(sender: RuntimeSender | null | undefined, embed?: EmbedSenderContext | null): string | null {
  return captureSenderPage(sender, embed)?.url ?? null;
}

/**
 * Workspace commands (accounts, embedding rules, the Mac helper) come only from ThreadStack's
 * manager page running as a top-level tab: never the side panel (no tab), the consent page, the
 * in-page overlay (its tab is a website), a frame, or a website. An overlay handshake token
 * does not change this.
 */
export function validateWorkspaceSender(type: string, sender: RuntimeSender, expectedExtensionId: string): SenderValidationResult {
  const page = managerPageRe(expectedExtensionId);
  if (sender.id !== expectedExtensionId) return { allowed: false, reason: `Rejected ${type} from outside ThreadStack` };
  if (!sender.tab || typeof sender.tab.id !== 'number') return { allowed: false, reason: `Rejected ${type} from a page without a tab` };
  if (sender.frameId !== 0) return { allowed: false, reason: `Rejected ${type} from a framed page` };
  if (!page.test(sender.url ?? '') || !page.test(sender.tab.url ?? '')) {
    return { allowed: false, reason: `Rejected ${type} from a page other than the ThreadStack workspace` };
  }
  return { allowed: true };
}

/** A provider's own top-level tab (frameId 0, https) sending as this extension's content script. */
function providerTopFrameUrl(sender: RuntimeSender, expectedExtensionId: string): string | null {
  if (sender.id !== expectedExtensionId || !sender.tab || sender.frameId !== 0) return null;
  let parsed: URL;
  try {
    parsed = new URL(sender.url ?? '');
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (typeof sender.origin === 'string' && sender.origin !== parsed.origin) return null;
  return parsed.href;
}

/**
 * Messages of embedded pages (EMBED_FRAME_EVENT_TYPES) come only from embedded frames.
 * ACCOUNT_IDENTITY may also come from a provider's own top-level tab; either way the page must
 * be one of the named provider's pages.
 */
export function validateEmbedFrameSender(
  message: { type: string; provider?: unknown },
  sender: RuntimeSender,
  ctx: EmbedSenderContext | null | undefined
): SenderValidationResult {
  const embedded = embeddedFrameUrl(sender, ctx);
  if (message.type !== 'ACCOUNT_IDENTITY') {
    return embedded ? { allowed: true } : { allowed: false, reason: `Rejected ${message.type} from a page not embedded in the workspace` };
  }
  const url = embedded ?? (ctx ? providerTopFrameUrl(sender, ctx.extensionId) : null);
  if (!url) return { allowed: false, reason: 'Rejected ACCOUNT_IDENTITY from a page that is neither embedded nor a provider tab' };
  if (!isProviderId(message.provider) || !isProviderAllowedOnUrl(message.provider, url)) {
    return { allowed: false, reason: 'Rejected ACCOUNT_IDENTITY for a provider that does not own the page' };
  }
  return { allowed: true };
}

export function validateRuntimeMessageSender(
  message: { type?: string; handshakeToken?: unknown; provider?: unknown } | null | undefined,
  sender: RuntimeSender,
  expectedExtensionId: string,
  embed?: Omit<EmbedSenderContext, 'extensionId'>
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

  // Own classes, checked before anything else so no other rule (or token) can admit them.
  if (WORKSPACE_COMMAND_TYPES.has(message.type)) {
    return validateWorkspaceSender(message.type, sender, expectedExtensionId);
  }
  if (EMBED_FRAME_EVENT_TYPES.has(message.type)) {
    return validateEmbedFrameSender(
      { type: message.type, provider: message.provider },
      sender,
      embed ? { ...embed, extensionId: expectedExtensionId } : null
    );
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
 * Consent decisions and unpairing come only from a top-level ThreadStack page: never from the
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
    return { allowed: false, reason: 'Rejected DOCK_DECIDE outside the ThreadStack consent window' };
  }
  return { allowed: true };
}
