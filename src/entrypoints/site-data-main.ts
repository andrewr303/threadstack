// Runs in the MAIN world of chatgpt.com, chat.openai.com and claude.ai at document_start.
// These apps load each conversation as one JSON document; this script reads that response as the
// page receives it and hands it to the isolated content script, which parses and validates it.
// It does the same for the small response in which the site names the signed-in person
// (core/accounts/identity.ts decides which request that is), so captures are filed under the
// right account. Requests and responses are never altered: only those requests are looked at,
// their responses are cloned before the page reads them, and this script makes no request of
// its own. Nothing here may throw into the page.
import { matchIdentityRequest } from '../core/accounts/identity.js';
import { embeddedInExtensionPage } from '../core/embed/frame.js';
import {
  IDENTITY_MESSAGE_SOURCE,
  MAX_IDENTITY_BODY_CHARS,
  isIdentityReplayRequest,
  SITE_DATA_MESSAGE_SOURCE,
  matchSiteConversationRequest,
  type IdentityMessage,
  type SiteDataMessage,
} from '../core/site-api.js';

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

/** The last identity response seen, posted again when the content script asks (see site-api.ts). */
let lastIdentity: { kind: IdentityMessage['kind']; body: string } | null = null;

function postIdentity(kind: IdentityMessage['kind'], body: string): void {
  lastIdentity = { kind, body };
  try {
    const message: IdentityMessage = { source: IDENTITY_MESSAGE_SOURCE, kind, body };
    window.postMessage(message, location.origin);
  } catch {
    // never disturb the page
  }
}

/**
 * The body of a cloned response as text, or null when it is (or turns out to be) larger than
 * `max` characters: the clone is cancelled then, which leaves the page's own copy untouched.
 */
async function readCapped(response: Response, max: number): Promise<string | null> {
  // Content-Length counts bytes and a character takes at most four, so this only skips bodies
  // that cannot fit; the count below decides the rest.
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max * 4) return null;
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > max) {
      void reader.cancel().catch(() => undefined);
      return null;
    }
  }
  text += decoder.decode();
  return text.length <= max ? text : null;
}

function hookFetch(): void {
  const nativeFetch = window.fetch;
  if (typeof nativeFetch !== 'function') return;
  window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>): Promise<Response> {
    const pending: Promise<Response> = Reflect.apply(nativeFetch, this, args);
    try {
      const url = requestUrl(args[0]);
      const isGet = requestMethod(args[0], args[1]) === 'GET';
      const match = isGet ? matchSiteConversationRequest(location.hostname, url) : null;
      const identity = isGet && !match ? matchIdentityRequest(location.hostname, url) : null;
      if (identity) {
        // Registered before the page receives the promise, as below.
        pending.then(
          (response) => {
            try {
              if (!response.ok) return;
              readCapped(response.clone(), MAX_IDENTITY_BODY_CHARS).then(
                (text) => {
                  if (text) postIdentity(identity, text);
                },
                () => undefined
              );
            } catch {
              // body already used
            }
          },
          () => undefined
        );
      }
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
  // Content scripts run in every frame. Only a top-level page and a page embedded in an extension
  // page have an isolated content script listening (it checks for Threadkeeper's exact origin;
  // this world cannot), so any other frame is left alone.
  const wanted = window === window.top || embeddedInExtensionPage();
  if (wanted && !Reflect.get(window, HOOK_FLAG)) {
    Reflect.defineProperty(window, HOOK_FLAG, { value: true });
    hookFetch();
    window.addEventListener('message', (event: MessageEvent) => {
      try {
        if (event.source !== window || !isIdentityReplayRequest(event.data) || !lastIdentity) return;
        postIdentity(lastIdentity.kind, lastIdentity.body);
      } catch {
        // never disturb the page
      }
    });
  }
} catch {
  // never disturb the page
}
