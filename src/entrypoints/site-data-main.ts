// Runs in the MAIN world of chatgpt.com, chat.openai.com and claude.ai at document_start.
// These apps load each conversation as one JSON document; this script reads that response as the
// page receives it and hands it to the isolated content script, which parses and validates it.
// Requests and responses are never altered: only the conversation request is looked at, its
// response is cloned before the page reads it, and this script makes no request of its own.
// Nothing here may throw into the page.
import { SITE_DATA_MESSAGE_SOURCE, matchSiteConversationRequest, type SiteDataMessage } from '../core/site-api.js';

const HOOK_FLAG = Symbol.for('threadkeeper.siteDataHook');

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return '';
}

function requestMethod(input: unknown, init: RequestInit | undefined): string {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  return String(method).toUpperCase();
}

function post(provider: SiteDataMessage['provider'], conversationId: string, json: unknown): void {
  try {
    const message: SiteDataMessage = { source: SITE_DATA_MESSAGE_SOURCE, provider, conversationId, json };
    window.postMessage(message, location.origin);
  } catch {
    // never disturb the page
  }
}

function hookFetch(): void {
  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const pending: Promise<Response> = Reflect.apply(nativeFetch, this, args);
    try {
      const url = requestUrl(args[0]);
      const match = requestMethod(args[0], args[1]) === 'GET' ? matchSiteConversationRequest(location.hostname, url) : null;
      if (match) {
        // Registered before the page receives the promise, so the clone happens before the
        // page reads the body.
        pending.then(
          (response) => {
            try {
              if (!response.ok) return;
              response
                .clone()
                .json()
                .then(
                  (json: unknown) => post(match.provider, match.conversationId, json),
                  () => undefined
                );
            } catch {
              // body already used or not JSON
            }
          },
          () => undefined
        );
      }
    } catch {
      // never disturb the page
    }
    return pending;
  };
}

try {
  if (!Reflect.get(window, HOOK_FLAG)) {
    Reflect.defineProperty(window, HOOK_FLAG, { value: true });
    hookFetch();
  }
} catch {
  // never disturb the page
}
