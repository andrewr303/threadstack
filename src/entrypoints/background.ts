import {
  ThreadkeeperDB,
  ensureStarterCollectionsAndSettings,
  upsertThread,
  processResumableJobs,
} from '../core/db.js';
import { buildThreadKey } from '../core/schema.js';
import { seedSyntheticWorkbenchLibrary } from '../core/synthetic-fixtures.js';
import { validateRuntimeMessageSender } from '../core/messaging.js';
import { requestThreadEnrichment } from '../core/cloud-client.js';

const db = new ThreadkeeperDB();
const securityRejectionLog: Array<{ timestamp: string; reason: string }> = [];
type HandshakeEntry = { token: string; redeemed: boolean };
const tabHandshakeTokens = new Map<number, HandshakeEntry>();
const SESSION_HANDSHAKE_KEY = 'tk_tab_handshakes';

async function readSessionHandshakeMap(): Promise<Record<string, HandshakeEntry>> {
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    try {
      const res = await chrome.storage.session.get(SESSION_HANDSHAKE_KEY);
      const raw = res?.[SESSION_HANDSHAKE_KEY];
      if (raw && typeof raw === 'object') {
        return { ...(raw as Record<string, HandshakeEntry>) };
      }
    } catch {
      // ignore session storage failures in restricted contexts
    }
  }
  return {};
}

async function writeSessionHandshakeMap(
  map: Record<string, HandshakeEntry>
): Promise<void> {
  if (typeof chrome !== 'undefined' && chrome.storage?.session) {
    try {
      await chrome.storage.session.set({ [SESSION_HANDSHAKE_KEY]: map });
    } catch {
      // ignore session storage failures
    }
  }
}

async function getTabHandshake(
  tabId: number
): Promise<HandshakeEntry | undefined> {
  const mem = tabHandshakeTokens.get(tabId);
  if (mem) return mem;
  const sessionMap = await readSessionHandshakeMap();
  const persisted = sessionMap[String(tabId)];
  if (
    persisted &&
    typeof persisted.token === 'string' &&
    typeof persisted.redeemed === 'boolean'
  ) {
    tabHandshakeTokens.set(tabId, persisted);
    return persisted;
  }
  return undefined;
}

async function setTabHandshake(
  tabId: number,
  entry: HandshakeEntry
): Promise<void> {
  tabHandshakeTokens.set(tabId, entry);
  const sessionMap = await readSessionHandshakeMap();
  sessionMap[String(tabId)] = entry;
  await writeSessionHandshakeMap(sessionMap);
}

async function deleteTabHandshake(tabId: number): Promise<void> {
  tabHandshakeTokens.delete(tabId);
  const sessionMap = await readSessionHandshakeMap();
  if (Object.prototype.hasOwnProperty.call(sessionMap, String(tabId))) {
    delete sessionMap[String(tabId)];
    await writeSessionHandshakeMap(sessionMap);
  }
}

if (typeof chrome !== 'undefined' && chrome.tabs?.onRemoved) {
  chrome.tabs.onRemoved.addListener((tabId) => {
    void deleteTabHandshake(tabId);
  });
}

function generateHandshakeToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function invokeOverlayOnTab(
  tabId: number | undefined,
  tabUrl: string | undefined,
  invocationSource: 'toolbar_action' | 'keyboard_command' | 'test_harness'
): Promise<{ mode: 'overlay' | 'full_page_tab'; tabId?: number }> {
  await ensureStarterCollectionsAndSettings(db);
  if (invocationSource === 'test_harness') {
    await seedSyntheticWorkbenchLibrary(db);
  }

  const canInjectOverlay =
    typeof tabId === 'number' &&
    typeof tabUrl === 'string' &&
    /^https:\/\/(chatgpt\.com|chat\.openai\.com|claude\.ai)\//i.test(tabUrl);

  if (canInjectOverlay && tabId !== undefined) {
    const handshakeToken = generateHandshakeToken();
    await setTabHandshake(tabId, { token: handshakeToken, redeemed: false });
    try {
      const resp = (await chrome.tabs.sendMessage(tabId, {
        type: 'TOGGLE_THREADKEEPER_OVERLAY',
        invocationSource,
        handshakeToken,
      })) as { state?: 'opened' | 'closed' } | undefined;
      if (resp?.state === 'closed') {
        await deleteTabHandshake(tabId);
      }
      return { mode: 'overlay', tabId };
    } catch {
      // If content script was not yet injected on this page, inject on demand upon deliberate user click
      try {
        await chrome.scripting.executeScript({
          target: { tabId },
          files: ['content-scripts/content.js'],
        });
        const resp = (await chrome.tabs.sendMessage(tabId, {
          type: 'TOGGLE_THREADKEEPER_OVERLAY',
          invocationSource,
          handshakeToken,
        })) as { state?: 'opened' | 'closed' } | undefined;
        if (resp?.state === 'closed') {
          await deleteTabHandshake(tabId);
        }
        return { mode: 'overlay', tabId };
      } catch {
        await deleteTabHandshake(tabId);
        // Fall through to full-page manager tab
      }
    }
  }

  const managerUrl = chrome.runtime.getURL('manager.html?surface=page');
  const existingTabs = await chrome.tabs.query({ url: `${ chrome.runtime.getURL('manager.html') }*` });
  if (existingTabs.length > 0 && existingTabs[0].id !== undefined) {
    await chrome.tabs.update(existingTabs[0].id, { active: true });
    return { mode: 'full_page_tab', tabId: existingTabs[0].id };
  }
  const created = await chrome.tabs.create({ url: managerUrl });
  return { mode: 'full_page_tab', tabId: created.id };
}

// Deliberate user invocation ONLY: toolbar click or keyboard command
if (typeof chrome !== 'undefined' && chrome.action?.onClicked) {
  chrome.action.onClicked.addListener((tab) => {
    void invokeOverlayOnTab(tab.id, tab.url, 'toolbar_action');
  });
}

if (typeof chrome !== 'undefined' && chrome.commands?.onCommand) {
  chrome.commands.onCommand.addListener(async (command) => {
    if (command === 'toggle-threadkeeper' || command === 'toggle-overlay') {
      const [activeTab] = await chrome.tabs.query({
        active: true,
        currentWindow: true,
      });
      await invokeOverlayOnTab(
        activeTab?.id,
        activeTab?.url,
        'keyboard_command'
      );
    } else if (command === 'open-manager') {
      await invokeOverlayOnTab(undefined, undefined, 'keyboard_command');
    }
  });
}

// Install & Startup: initialize IndexedDB starter areas and alarm silently — NEVER open UI or seed synthetic demo data
if (typeof chrome !== 'undefined' && chrome.runtime?.onInstalled) {
  chrome.runtime.onInstalled.addListener(() => {
    void (async () => {
      await ensureStarterCollectionsAndSettings(db);
      if (chrome.alarms) {
        await chrome.alarms.create('threadkeeper-resumable-jobs', {
          periodInMinutes: 5,
        });
      }
    })();
  });
}

if (typeof chrome !== 'undefined' && chrome.alarms?.onAlarm) {
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === 'threadkeeper-resumable-jobs') {
      void processResumableJobs(db, async (job) => {
        if (job.jobType === 'enrich_thread') {
          await requestThreadEnrichment(db, job.threadKey);
        }
      });
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    void (async () => {
      const validation = validateRuntimeMessageSender(
        message,
        sender,
        chrome.runtime.id
      );
      if (!validation.allowed) {
        securityRejectionLog.push({
          timestamp: new Date().toISOString(),
          reason: validation.reason ?? 'Rejected runtime message',
        });
        sendResponse({ ok: false, error: validation.reason });
        return;
      }

      if (message.type === 'GET_CAPTURE_AUTH_STATE') {
        const settings = await ensureStarterCollectionsAndSettings(db);
        const provider = message.provider as 'chatgpt' | 'claude';
        const authorized = Boolean(settings.authorizedHosts[provider]);
        sendResponse({
          ok: true,
          authorized,
          boundAccount: settings.boundAccounts[provider],
        });
        return;
      }

      if (message.type === 'PASSIVE_DOM_CAPTURE') {
        const settings = await ensureStarterCollectionsAndSettings(db);
        const provider = message.payload.provider as 'chatgpt' | 'claude';
        if (!settings.authorizedHosts[provider] && !message.explicitInvoke) {
          sendResponse({
            ok: false,
            skipped: 'provider_not_authorized',
          });
          return;
        }
        const bound = settings.boundAccounts[provider];
        const threadKey = buildThreadKey({
          provider,
          accountId: bound.accountId,
          workspaceId: bound.workspaceId,
          sourceConversationId: message.payload.sourceConversationId,
          branchId: message.payload.branchId,
        });
        const result = await upsertThread(db, {
          ...message.payload,
          threadKey,
          accountId: bound.accountId,
          workspaceId: bound.workspaceId,
        });
        sendResponse({
          ok: true,
          status: result.status,
          threadKey,
          coverage: result.record?.coverage,
        });
        return;
      }

      if (message.type === 'REDEEM_OVERLAY_HANDSHAKE') {
        const tabId = sender.tab?.id;
        if (typeof tabId !== 'number') {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: 'Rejected REDEEM_OVERLAY_HANDSHAKE without tabId',
          });
          sendResponse({
            ok: false,
            error: 'Missing tabId for overlay handshake',
          });
          return;
        }
        const entry = await getTabHandshake(tabId);
        if (!entry || entry.token !== message.handshakeToken) {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: `Rejected REDEEM_OVERLAY_HANDSHAKE with invalid token on tab ${tabId}`,
          });
          sendResponse({
            ok: false,
            error: 'Invalid overlay handshake token',
          });
          return;
        }
        if (entry.redeemed) {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: `Rejected second-use REDEEM_OVERLAY_HANDSHAKE replay on tab ${tabId}`,
          });
          sendResponse({
            ok: false,
            error: 'Overlay handshake token already redeemed for this tab',
          });
          return;
        }
        await setTabHandshake(tabId, {
          token: entry.token,
          redeemed: true,
        });
        sendResponse({ ok: true, redeemed: true });
        return;
      }

      const isEmbeddedInHostTab =
        typeof sender.tab?.id === 'number' &&
        !(sender.tab.url ?? '').startsWith('chrome-extension://');

      const privilegedOverlayTypes = new Set([
        'OPEN_FULL_PAGE_MANAGER',
        'OPEN_ORIGINAL_THREAD',
        'DELETE_THREAD',
        'EXPORT_BUNDLE',
        'UPDATE_SETTINGS',
        'RUN_RESUMABLE_JOBS',
      ]);

      if (isEmbeddedInHostTab && privilegedOverlayTypes.has(message.type)) {
        const activeEntry = await getTabHandshake(sender.tab!.id!);
        if (
          !activeEntry ||
          !activeEntry.redeemed ||
          activeEntry.token !== message.handshakeToken
        ) {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: `Rejected ${message.type} from unauthenticated overlay frame on tab ${sender.tab!.id}`,
          });
          sendResponse({
            ok: false,
            error: 'Unauthorized overlay iframe sender',
          });
          return;
        }
      }

      if (message.type === 'OPEN_FULL_PAGE_MANAGER') {
        const params = new URLSearchParams({ surface: 'page' });
        if (message.threadKey) params.set('threadKey', message.threadKey);
        if (message.query) params.set('q', message.query);
        const targetUrl = chrome.runtime.getURL(`manager.html?${params.toString()}`);
        const existingTabs = await chrome.tabs.query({
          url: `${chrome.runtime.getURL('manager.html')}*`,
        });
        if (existingTabs.length > 0 && existingTabs[0].id !== undefined) {
          await chrome.tabs.update(existingTabs[0].id, {
            url: targetUrl,
            active: true,
          });
          sendResponse({ ok: true, tabId: existingTabs[0].id, reused: true });
        } else {
          const created = await chrome.tabs.create({ url: targetUrl });
          sendResponse({ ok: true, tabId: created.id, reused: false });
        }
        return;
      }

      if (message.type === 'OPEN_ORIGINAL_THREAD') {
        const settings = await ensureStarterCollectionsAndSettings(db);
        const bound = settings.boundAccounts[message.provider as 'chatgpt' | 'claude' | 'imported'];
        if (
          bound &&
          (bound.accountId !== message.expectedAccountId ||
            bound.workspaceId !== message.expectedWorkspaceId) &&
          !message.forceOpen
        ) {
          sendResponse({
            ok: false,
            status: 'account_mismatch',
            boundAccount: bound,
            expectedAccount: {
              accountId: message.expectedAccountId,
              workspaceId: message.expectedWorkspaceId,
            },
          });
          return;
        }
        const allTabs = await chrome.tabs.query({});
        const match = allTabs.find((t) => t.url === message.canonicalUrl);
        if (match && match.id !== undefined) {
          await chrome.tabs.update(match.id, { active: true });
          sendResponse({ ok: true, status: 'reused_tab', tabId: match.id });
        } else {
          const created = await chrome.tabs.create({ url: message.canonicalUrl });
          sendResponse({ ok: true, status: 'opened_new_tab', tabId: created.id });
        }
        return;
      }

      if (message.type === 'CLOSE_THREADKEEPER_OVERLAY') {
        let targetTabId = sender.tab?.id;
        if (
          typeof targetTabId !== 'number' ||
          (sender.tab?.url ?? '').startsWith('chrome-extension://')
        ) {
          const [activeTab] = await chrome.tabs.query({
            active: true,
            currentWindow: true,
          });
          targetTabId = activeTab?.id;
        }
        if (typeof targetTabId !== 'number') {
          sendResponse({
            ok: false,
            error: 'No target tab for CLOSE_THREADKEEPER_OVERLAY',
          });
          return;
        }
        const activeEntry = await getTabHandshake(targetTabId);
        if (
          !activeEntry ||
          !activeEntry.redeemed ||
          activeEntry.token !== message.handshakeToken
        ) {
          securityRejectionLog.push({
            timestamp: new Date().toISOString(),
            reason: `Rejected CLOSE_THREADKEEPER_OVERLAY with invalid or unredeemed handshakeToken on tab ${targetTabId}`,
          });
          sendResponse({
            ok: false,
            error: 'Invalid or unredeemed handshakeToken',
          });
          return;
        }
        try {
          const closeResp = (await chrome.tabs.sendMessage(targetTabId, {
            type: 'CLOSE_THREADKEEPER_OVERLAY',
            handshakeToken: message.handshakeToken,
          })) as { ok?: boolean; error?: string } | undefined;
          if (!closeResp?.ok) {
            sendResponse({
              ok: false,
              error: closeResp?.error ?? 'Content script rejected close',
            });
            return;
          }
          await deleteTabHandshake(targetTabId);
        } catch {
          await deleteTabHandshake(targetTabId);
        }
        sendResponse({ ok: true });
        return;
      }

      sendResponse({ ok: true });
    })();
    return true;
  });
}

// Expose test-harness entrypoints on ServiceWorker globalThis for packaged-extension acceptance testing
(globalThis as unknown as Record<string, unknown>).__threadkeeperInvokeAction =
  invokeOverlayOnTab;
(globalThis as unknown as Record<string, unknown>).__threadkeeperGetSecurityRejections =
  () => [...securityRejectionLog];
(globalThis as unknown as Record<string, unknown>).__threadkeeperClearInMemoryHandshakes =
  () => {
    tabHandshakeTokens.clear();
    return tabHandshakeTokens.size;
  };
