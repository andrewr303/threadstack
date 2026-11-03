// Runs in the MAIN world of x.com / twitter.com at document_start (X is a single-page app, so
// /i/grok is reached without a page load). It watches the conversation data X's own page
// already loads and posts parsed Grok messages to the isolated content script. Requests and
// responses are never altered: fetch responses are cloned, XHR text is read only after load,
// and only GrokConversationItemsByRestId requests are looked at. Nothing here may throw into
// the page.
import {
  GROK_X_MESSAGE_SOURCE,
  extractGrokXRestId,
  isGrokXItemsUrl,
  parseGrokXItems,
  type GrokXCaptureMessage,
} from '../core/grok-x.js';

const HOOK_FLAG = Symbol.for('threadkeeper.grokXHook');

function post(json: unknown, url: string, body: unknown): void {
  try {
    const messages = parseGrokXItems(json);
    if (messages.length === 0) return;
    const message: GrokXCaptureMessage = {
      source: GROK_X_MESSAGE_SOURCE,
      restId: extractGrokXRestId(url, body, location.href),
      messages,
    };
    window.postMessage(message, location.origin);
  } catch {
    // never disturb the page
  }
}

function requestUrl(input: unknown): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  if (input instanceof Request) return input.url;
  return '';
}

function hookFetch(): void {
  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const pending: Promise<Response> = Reflect.apply(nativeFetch, this, args);
    try {
      const url = requestUrl(args[0]);
      if (isGrokXItemsUrl(url)) {
        const body = args[1]?.body;
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
                  (json: unknown) => post(json, url, body),
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

function hookXhr(): void {
  const proto = XMLHttpRequest.prototype;
  const nativeOpen = proto.open;
  const nativeSend = proto.send;
  const urls = new WeakMap<XMLHttpRequest, string>();
  proto.open = function (this: XMLHttpRequest, ...args: unknown[]): void {
    try {
      urls.set(this, requestUrl(args[1]));
    } catch {
      // ignore
    }
    // Forward the exact arguments: open(method, url, undefined) would make the request synchronous.
    Reflect.apply(nativeOpen, this, args);
  };
  proto.send = function (this: XMLHttpRequest, ...args: unknown[]): void {
    try {
      const url = urls.get(this) ?? '';
      if (isGrokXItemsUrl(url)) {
        const body = args[0];
        const xhr = this;
        xhr.addEventListener('load', () => {
          try {
            if (xhr.status < 200 || xhr.status >= 300) return;
            if (xhr.responseType === 'json') {
              post(xhr.response, url, body);
            } else if (xhr.responseType === '' || xhr.responseType === 'text') {
              post(JSON.parse(xhr.responseText), url, body);
            }
          } catch {
            // not JSON
          }
        });
      }
    } catch {
      // never disturb the page
    }
    Reflect.apply(nativeSend, this, args);
  };
}

try {
  if (!Reflect.get(window, HOOK_FLAG)) {
    Reflect.defineProperty(window, HOOK_FLAG, { value: true });
    hookFetch();
    hookXhr();
  }
} catch {
  // never disturb the page
}
