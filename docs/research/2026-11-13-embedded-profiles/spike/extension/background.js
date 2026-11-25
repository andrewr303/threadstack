// Research fixture (see ../run-spike.mjs). Records what the browser reports about requests made
// by frames of the host page, and installs the header rules the measurements need.
const log = [];
const push = (entry) => {
  log.push(entry);
  if (log.length > 2000) log.shift();
};

const FRAME_RULE = 1;
let nextRuleId = 100;

function headerValues(headers, name) {
  return (headers || []).filter((h) => h.name.toLowerCase() === name).map((h) => h.value);
}

chrome.webRequest.onHeadersReceived.addListener(
  (d) => {
    push({
      stage: 'headersReceived',
      url: d.url,
      type: d.type,
      tabId: d.tabId,
      frameId: d.frameId,
      parentFrameId: d.parentFrameId,
      frameType: d.frameType,
      documentLifecycle: d.documentLifecycle,
      initiator: d.initiator,
      statusCode: d.statusCode,
      setCookie: headerValues(d.responseHeaders, 'set-cookie'),
      xfo: headerValues(d.responseHeaders, 'x-frame-options'),
    });
  },
  { urls: ['https://claude.ai/*', 'https://*.claude.ai/*'] },
  ['responseHeaders', 'extraHeaders']
);

chrome.webRequest.onSendHeaders.addListener(
  (d) => {
    push({
      stage: 'sendHeaders',
      url: d.url,
      type: d.type,
      tabId: d.tabId,
      frameId: d.frameId,
      parentFrameId: d.parentFrameId,
      initiator: d.initiator,
      cookie: headerValues(d.requestHeaders, 'cookie'),
    });
  },
  { urls: ['https://claude.ai/*', 'https://*.claude.ai/*'] },
  ['requestHeaders', 'extraHeaders']
);

const frames = [];

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    switch (message?.type) {
      case 'hello': {
        const tabId = sender.tab.id;
        await chrome.declarativeNetRequest.updateSessionRules({
          removeRuleIds: [FRAME_RULE],
          addRules: [
            {
              id: FRAME_RULE,
              priority: 1,
              action: {
                type: 'modifyHeaders',
                responseHeaders: ['x-frame-options', 'content-security-policy'].map((header) => ({ header, operation: 'remove' })),
              },
              condition: { tabIds: [tabId], resourceTypes: ['sub_frame'] },
            },
          ],
        });
        return { ok: true, tabId };
      }
      case 'seed': {
        // Append Set-Cookie headers to the response of one exact URL in this tab.
        const id = nextRuleId++;
        await chrome.declarativeNetRequest.updateSessionRules({
          addRules: [
            {
              id,
              priority: 5,
              action: {
                type: 'modifyHeaders',
                responseHeaders: [
                  ...message.cookies.map((value) => ({ header: 'set-cookie', operation: 'append', value })),
                  ...['x-frame-options', 'content-security-policy'].map((header) => ({ header, operation: 'remove' })),
                ],
              },
              condition: { tabIds: [sender.tab.id], urlFilter: `|${message.url}|`, resourceTypes: message.resourceTypes ?? ['sub_frame'] },
            },
          ],
        });
        return { ok: true, id };
      }
      case 'cookieRule': {
        // The alternative mechanism: set the Cookie request header and drop Set-Cookie, per tab.
        const id = nextRuleId++;
        await chrome.declarativeNetRequest.updateSessionRules({
          addRules: [
            {
              id,
              priority: 5,
              action: {
                type: 'modifyHeaders',
                requestHeaders: [{ header: 'cookie', operation: 'set', value: message.cookie }],
                responseHeaders: [{ header: 'set-cookie', operation: 'remove' }],
              },
              condition: { tabIds: [sender.tab.id], urlFilter: message.urlFilter },
            },
          ],
        });
        return { ok: true, id };
      }
      case 'dropRule':
        await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [message.id] });
        return { ok: true };
      case 'rules':
        return { ok: true, rules: await chrome.declarativeNetRequest.getSessionRules() };
      case 'log':
        return { ok: true, log: log.filter((e) => !message.match || e.url.includes(message.match)) };
      case 'clearLog':
        log.length = 0;
        return { ok: true };
      case 'cookies': {
        const out = { plain: await chrome.cookies.getAll({ domain: 'claude.ai' }) };
        for (const topLevelSite of ['https://claude.ai', `chrome-extension://${chrome.runtime.id}`]) {
          try {
            out[topLevelSite] = await chrome.cookies.getAll({ domain: 'claude.ai', partitionKey: { topLevelSite } });
          } catch (error) {
            out[topLevelSite] = `error: ${error.message}`;
          }
        }
        return { ok: true, cookies: out };
      }
      case 'frameHello':
        frames.push({ frameId: sender.frameId, tabId: sender.tab?.id, url: sender.url, origin: sender.origin, credentialless: message.credentialless, name: message.name });
        return { ok: true, frameId: sender.frameId };
      case 'frames':
        return { ok: true, frames };
      default:
        return { ok: false };
    }
  })().then(sendResponse, (error) => sendResponse({ ok: false, error: String(error?.message ?? error) }));
  return true;
});
