// @vitest-environment-options {"url": "https://x.com/i/grok?conversation=1890"}
// The page URL is a Grok-on-X conversation so the content script and the MAIN-world hook
// can be exercised as they run on x.com. The pure DOM tests below pass their own URLs.
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import {
  captureMatchPatterns,
  detectProviderFromUrl,
  extractConversationIdFromUrl,
  isCapturePageUrl,
  parseChatGptProjectRoute,
  toOriginMatchPatterns,
} from '../../src/core/providers.js';
import {
  canonicalizeConversationUrl,
  extractVisibleDomConversation,
  grokXConversationToExtraction,
} from '../../src/core/dom-capture.js';
import {
  extractGrokXRestId,
  isGrokXItemsUrl,
  mergeGrokXMessages,
  parseGrokXCaptureMessage,
  parseGrokXItems,
  stripGrokRender,
  type GrokXMessage,
} from '../../src/core/grok-x.js';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

const GROK_ITEMS_URL = `https://x.com/i/api/graphql/q1/GrokConversationItemsByRestId?variables=${encodeURIComponent(
  JSON.stringify({ restId: '1890' })
)}`;

/** X returns the newest item first. */
const grokItemsResponse = {
  data: {
    grokConversationItemsByRestId: {
      items: [
        {
          chat_item_id: 'c4',
          sender_type: 'Agent',
          message: 'Still drafting',
          is_partial: true,
        },
        {
          chat_item_id: 'c3',
          sender_type: 'Agent',
          message:
            'Lisbon is the capital<grok:render type="render_inline_citation"><argument name="citation_id">1</argument></grok:render>.',
          created_at_ms: 1793700000000,
        },
        { sender_type: 'System', message: 'internal note' },
        { sender_type: 'User', message: { text: 'not a string' } },
        { chat_item_id: 'c1', sender_type: 'User', message: 'What is the capital of Portugal?' },
      ],
    },
  },
};

function grokMessage(id: string, role: GrokXMessage['role'], text: string, createdAt: string | null = null): GrokXMessage {
  return { id, role, text, createdAt };
}

describe('Grok on X: URL identity', () => {
  it('treats only /i/grok on X hosts as Grok on X', () => {
    expect(detectProviderFromUrl('https://x.com/i/grok?conversation=1890')).toBe('grok_x');
    expect(detectProviderFromUrl('https://twitter.com/i/grok?conversation=1890')).toBe('grok_x');
    expect(detectProviderFromUrl('https://www.x.com/i/grok')).toBe('grok_x');
    expect(detectProviderFromUrl('https://mobile.twitter.com/i/grok/share')).toBe('grok_x');

    expect(detectProviderFromUrl('https://x.com/home')).toBeNull();
    expect(detectProviderFromUrl('https://x.com/i/grokking')).toBeNull();
    expect(detectProviderFromUrl('https://x.com/someone/status/1')).toBeNull();
    // The test-only provider hint cannot turn a normal X page into a capture page.
    expect(detectProviderFromUrl('https://x.com/home?tk_provider=chatgpt')).toBeNull();
    expect(detectProviderFromUrl('https://notx.com/i/grok')).toBeNull();
  });

  it('takes the id from ?conversation= and files every X host under one canonical URL', () => {
    expect(extractConversationIdFromUrl('https://twitter.com/i/grok?conversation=1890&t=abc')).toBe('1890');
    expect(extractConversationIdFromUrl('https://x.com/i/grok')).toBeNull();
    expect(extractConversationIdFromUrl('https://x.com/i/grok?conversation=a%20b')).toBeNull();
    expect(canonicalizeConversationUrl('https://twitter.com/i/grok?conversation=1890&t=abc#x')).toBe(
      'https://x.com/i/grok?conversation=1890'
    );
  });

  it('never scrapes the DOM on X, on /i/grok or elsewhere', () => {
    const doc = parse(`<html><body>
      <div data-message-author-role="user">A post that looks like a message</div>
      <div class="assistant-message">Another one</div></body></html>`);
    expect(extractVisibleDomConversation(doc, 'https://x.com/i/grok?conversation=1890')).toBeNull();
    expect(extractVisibleDomConversation(doc, 'https://x.com/home')).toBeNull();
  });

  it('opens the overlay only on registered https capture pages', () => {
    expect(isCapturePageUrl('https://x.com/i/grok?conversation=1890')).toBe(true);
    expect(isCapturePageUrl('https://x.com/home')).toBe(false);
    expect(isCapturePageUrl('https://chatgpt.com/c/abc')).toBe(true);
    expect(isCapturePageUrl('https://www.kimi.com/chat/abcdefghij0123456789')).toBe(true);
    expect(isCapturePageUrl('https://aistudio.google.com/prompts/1AbC')).toBe(true);
    expect(isCapturePageUrl('http://chatgpt.com/c/abc')).toBe(false);
    expect(isCapturePageUrl('https://example.com/?tk_provider=claude')).toBe(false);
    expect(isCapturePageUrl('not a url')).toBe(false);
  });
});

describe('Grok on X: response parser', () => {
  it('reads items oldest first with roles, stripped render blocks, ids and timestamps', () => {
    const messages = parseGrokXItems(grokItemsResponse);
    expect(messages).toEqual([
      { id: 'c1', role: 'user', text: 'What is the capital of Portugal?', createdAt: null },
      {
        id: 'c3',
        role: 'assistant',
        text: 'Lisbon is the capital.',
        createdAt: new Date(1793700000000).toISOString(),
      },
    ]);
  });

  it('accepts the snake_case container and gives id-less items stable content keys', () => {
    const response = {
      data: {
        grok_conversation_items_by_rest_id: {
          items: [
            { sender: 'grok', message: 'Hello again' },
            { sender: 'human', message: 'hi' },
            { sender: 'human', message: 'hi' },
          ],
        },
      },
    };
    const first = parseGrokXItems(response);
    const second = parseGrokXItems(JSON.parse(JSON.stringify(response)));
    expect(first.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(first.map((m) => m.id)).toEqual(second.map((m) => m.id));
    expect(new Set(first.map((m) => m.id)).size).toBe(3);
    expect(first[1].id).toBe(`${first[0].id}_2`);
  });

  it('returns nothing for unrelated or malformed JSON', () => {
    expect(parseGrokXItems(null)).toEqual([]);
    expect(parseGrokXItems({ data: { home: { items: [] } } })).toEqual([]);
    expect(parseGrokXItems({ data: { grokConversationItemsByRestId: { items: 'nope' } } })).toEqual([]);
    expect(parseGrokXItems([grokItemsResponse])).toEqual([]);
  });

  it('finds variables.restId in the request URL or JSON body', () => {
    expect(isGrokXItemsUrl(GROK_ITEMS_URL)).toBe(true);
    expect(isGrokXItemsUrl('https://x.com/i/api/graphql/q1/HomeTimeline')).toBe(false);
    expect(extractGrokXRestId(GROK_ITEMS_URL)).toBe('1890');
    expect(
      extractGrokXRestId(`/i/api/graphql/q1/GrokConversationItemsByRestId?variables=${encodeURIComponent('{"restId":"42"}')}`)
    ).toBe('42');
    expect(
      extractGrokXRestId('https://x.com/i/api/graphql/q1/GrokConversationItemsByRestId', JSON.stringify({ variables: { restId: '77' } }))
    ).toBe('77');
    expect(
      extractGrokXRestId('https://x.com/i/api/graphql/q1/GrokConversationItemsByRestId', JSON.stringify({ variables: '{"restId":"78"}' }))
    ).toBe('78');
    // Numbers lose precision for snowflake ids, and odd strings are not ids.
    expect(extractGrokXRestId(`https://x.com/q?variables=${encodeURIComponent('{"restId":1890}')}`)).toBeNull();
    expect(extractGrokXRestId(`https://x.com/q?variables=${encodeURIComponent('{"restId":"1 or 1"}')}`)).toBeNull();
    expect(extractGrokXRestId('https://x.com/q', 'not json')).toBeNull();
  });

  it('strips only grok:render blocks', () => {
    expect(stripGrokRender('A<grok:render a="1">x</grok:render> and <b>B</b>\n\n\n\nC')).toBe('A and <b>B</b>\n\nC');
  });
});

describe('Grok on X: posted payload validation', () => {
  const valid = {
    source: 'threadkeeper-grok-x',
    restId: '1890',
    messages: [
      { id: 'c1', role: 'user', text: 'Hi', createdAt: null },
      { id: 'c2', role: 'assistant', text: 'Hello', createdAt: '2026-11-03T10:00:00.000Z' },
    ],
  };

  it('accepts a well-formed payload and keeps only known fields', () => {
    const res = parseGrokXCaptureMessage({
      ...valid,
      extra: 'dropped',
      messages: [{ ...valid.messages[0], html: '<img src=x>' }, valid.messages[1]],
    });
    expect(res).toEqual(valid);
    expect(parseGrokXCaptureMessage({ ...valid, restId: null })?.restId).toBeNull();
  });

  it('rejects forged or malformed payloads', () => {
    const bad: unknown[] = [
      null,
      'threadkeeper-grok-x',
      { ...valid, source: 'threadkeeper-host-overlay' },
      { ...valid, restId: '../../etc' },
      { ...valid, restId: 1890 },
      { ...valid, messages: [] },
      { ...valid, messages: 'x' },
      { ...valid, messages: [{ ...valid.messages[0], role: 'system' }] },
      { ...valid, messages: [{ ...valid.messages[0], text: '   ' }] },
      { ...valid, messages: [{ ...valid.messages[0], text: 42 }] },
      { ...valid, messages: [{ ...valid.messages[0], id: 'a b' }] },
      { ...valid, messages: [valid.messages[0], valid.messages[0]] },
      { ...valid, messages: [{ ...valid.messages[0], createdAt: 'yesterday' }] },
      { ...valid, messages: [valid.messages[1], null] },
    ];
    for (const payload of bad) expect(parseGrokXCaptureMessage(payload)).toBeNull();
  });
});

describe('Grok on X: merging responses into one conversation', () => {
  const a = grokMessage('a', 'user', 'one');
  const b = grokMessage('b', 'assistant', 'two');
  const c = grokMessage('c', 'user', 'three');
  const d = grokMessage('d', 'assistant', 'four');

  it('puts an older page in front and lets an overlapping page replace its range', () => {
    expect(mergeGrokXMessages([c, d], [a, b]).map((m) => m.id)).toEqual(['a', 'b', 'c', 'd']);
    const edited = grokMessage('c', 'user', 'three (edited)');
    expect(mergeGrokXMessages([a, b, c], [edited, d]).map((m) => m.text)).toEqual([
      'one',
      'two',
      'three (edited)',
      'four',
    ]);
  });

  it('orders by timestamp when every message has one', () => {
    const late = grokMessage('x', 'user', 'later', '2026-11-03T12:00:00.000Z');
    const early = grokMessage('y', 'assistant', 'earlier', '2026-11-03T09:00:00.000Z');
    expect(mergeGrokXMessages([late], [early]).map((m) => m.id)).toEqual(['y', 'x']);
    expect(mergeGrokXMessages([early], [late]).map((m) => m.id)).toEqual(['y', 'x']);
  });

  it('builds a partial capture with a canonical URL and a title from the first question', () => {
    const res = grokXConversationToExtraction('1890', [a, b]);
    expect(res).toMatchObject({
      provider: 'grok_x',
      sourceConversationId: '1890',
      branchId: 'main',
      canonicalUrl: 'https://x.com/i/grok?conversation=1890',
      title: 'one',
      coverage: 'partial',
    });
    expect(res.messages.map((m) => m.sourceMessageId)).toEqual(['a', 'b']);
  });
});

describe('Grok on X: MAIN-world hook and isolated content script', () => {
  const posted: unknown[] = [];
  const sent: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  const pageFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  const nativeOpen = vi.fn<(...args: unknown[]) => void>();
  const nativeSend = vi.fn<(...args: unknown[]) => void>();
  let wrappedFetch: typeof fetch;

  beforeAll(async () => {
    window.fetch = pageFetch;
    XMLHttpRequest.prototype.open = nativeOpen;
    XMLHttpRequest.prototype.send = nativeSend;
    await import('../../src/entrypoints/grok-x-main.js');
    wrappedFetch = window.fetch;

    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (p: string) => `chrome-extension://tk-test-id/${p}`,
        sendMessage: (message: { type?: string; payload?: Record<string, unknown> }, cb?: (r: unknown) => void) => {
          sent.push(message);
          cb?.({ ok: true });
        },
        onMessage: { addListener: () => undefined },
      },
    });
    await import('../../src/entrypoints/content.js');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    history.replaceState(null, '', '/i/grok?conversation=1890');
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  it('reads matching fetch responses from a clone and hands the page the untouched response', async () => {
    const spy = vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message);
    });
    const response = new Response(JSON.stringify(grokItemsResponse), { status: 200 });
    pageFetch.mockResolvedValueOnce(response);
    const got = await window.fetch(GROK_ITEMS_URL);
    expect(got).toBe(response);
    expect(await got.json()).toEqual(grokItemsResponse);
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe('https://x.com');
    expect(posted.at(-1)).toMatchObject({
      source: 'threadkeeper-grok-x',
      restId: '1890',
      messages: [{ id: 'c1', role: 'user' }, { id: 'c3', role: 'assistant' }],
    });
  });

  it('parses nothing for other requests and passes failures through unchanged', async () => {
    const spy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const other = new Response('{"data":{}}');
    const clone = vi.spyOn(other, 'clone');
    pageFetch.mockResolvedValueOnce(other);
    expect(await window.fetch('https://x.com/i/api/graphql/q1/HomeTimeline')).toBe(other);
    const failure = new TypeError('offline');
    pageFetch.mockRejectedValueOnce(failure);
    await expect(window.fetch(GROK_ITEMS_URL)).rejects.toBe(failure);
    await flush();
    expect(clone).not.toHaveBeenCalled();
    expect(spy).not.toHaveBeenCalled();
  });

  it('forwards XHR arguments exactly and reads the text only after load', async () => {
    const spy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', GROK_ITEMS_URL);
    expect(nativeOpen.mock.calls.at(-1)).toEqual(['GET', GROK_ITEMS_URL]);
    xhr.send();
    expect(nativeSend).toHaveBeenCalledTimes(1);
    expect(spy).not.toHaveBeenCalled();
    Object.defineProperty(xhr, 'status', { value: 200 });
    Object.defineProperty(xhr, 'responseText', { value: JSON.stringify(grokItemsResponse) });
    xhr.dispatchEvent(new Event('load'));
    expect(spy).toHaveBeenCalledTimes(1);

    const timeline = new XMLHttpRequest();
    timeline.open('GET', 'https://x.com/i/api/graphql/q1/HomeTimeline', true);
    expect(nativeOpen.mock.calls.at(-1)).toHaveLength(3);
    timeline.send();
    Object.defineProperty(timeline, 'status', { value: 200 });
    Object.defineProperty(timeline, 'responseText', { value: JSON.stringify(grokItemsResponse) });
    timeline.dispatchEvent(new Event('load'));
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('wraps fetch only once even if the script runs again', async () => {
    vi.resetModules();
    await import('../../src/entrypoints/grok-x-main.js');
    expect(window.fetch).toBe(wrappedFetch);
  });

  const post = (data: unknown, init: { origin?: string; source?: MessageEventSource | null } = {}) =>
    window.dispatchEvent(
      new MessageEvent('message', {
        data,
        origin: init.origin ?? window.location.origin,
        source: init.source === undefined ? window : init.source,
      })
    );

  const capture = (restId: string | null, text: string) => {
    const key = text.replace(/\W+/g, '-');
    return {
      source: 'threadkeeper-grok-x',
      restId,
      messages: [
        { id: `${key}-q`, role: 'user', text, createdAt: null },
        { id: `${key}-a`, role: 'assistant', text: `Answer to ${text}`, createdAt: null },
      ],
    };
  };

  const capturesAfter = (action: () => void) => {
    vi.useFakeTimers();
    const before = sent.length;
    action();
    vi.advanceTimersByTime(1500);
    return sent.slice(before).filter((m) => m.type === 'PASSIVE_DOM_CAPTURE');
  };

  it('sends a partial dom_observer capture for the open Grok conversation', () => {
    const captures = capturesAfter(() => post(capture('1890', 'first question')));
    expect(captures).toHaveLength(1);
    expect(captures[0].payload).toMatchObject({
      provider: 'grok_x',
      sourceConversationId: '1890',
      canonicalUrl: 'https://x.com/i/grok?conversation=1890',
      title: 'first question',
      coverage: 'partial',
      captureSource: 'dom_observer',
    });
    expect((captures[0].payload?.messages as unknown[]).length).toBe(2);
  });

  it('ignores forged, foreign, malformed and mismatched messages', () => {
    expect(capturesAfter(() => post(capture('1890', 'baseline')))).toHaveLength(1);
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const forged = capturesAfter(() => {
      post(capture('1890', 'from a frame'), { source: iframe.contentWindow });
      post(capture('1890', 'no source'), { source: null });
      post(capture('1890', 'other origin'), { origin: 'https://evil.example' });
      post({ ...capture('1890', 'bad role'), messages: [{ id: 'x', role: 'system', text: 'hi', createdAt: null }] });
      post(capture('777', 'another conversation'));
    });
    iframe.remove();
    expect(forged).toHaveLength(0);

    // A genuine follow-up still merges with the baseline: nothing above replaced or joined it.
    const next = capturesAfter(() => post(capture('1890', 'followup')));
    expect(next).toHaveLength(1);
    const texts = (next[0].payload?.messages as Array<{ content: string }>).map((m) => m.content);
    expect(texts).toEqual(expect.arrayContaining(['baseline', 'followup']));
    expect(texts.join(' ')).not.toMatch(/frame|no source|other origin|hi$|another conversation/);
  });

  it('captures nothing once the user leaves /i/grok', () => {
    history.replaceState(null, '', '/home');
    expect(capturesAfter(() => post(capture('1890', 'after leaving')))).toHaveLength(0);
  });
});

describe('ChatGPT capture', () => {
  it('skips streaming turns and the transient Thinking message', () => {
    const doc = parse(`<html><head><title>Plan - ChatGPT</title></head><body>
      <div data-message-author-role="user" data-message-id="u1">Plan the launch</div>
      <div data-message-author-role="assistant" data-message-id="t0">Thinking</div>
      <div data-message-author-role="assistant" data-message-id="a1" data-message-model-slug="gpt-5">Here is a plan.</div>
      <div data-message-author-role="user" data-message-id="u2">Shorter please</div>
      <div data-message-author-role="assistant" data-message-id="a2" data-message-model-slug="gpt-5" data-message-streaming="true">Shor</div>
      <article data-is-streaming="true"><div data-message-author-role="assistant" data-message-id="a3" data-message-model-slug="gpt-5">Sho</div></article>
    </body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://chatgpt.com/c/conv1')!;
    expect(res.messages.map((m) => m.sourceMessageId)).toEqual(['u1', 'a1', 'u2']);
  });

  it('keeps slug-less replies when no reply has a model slug', () => {
    const doc = parse(`<html><body>
      <div data-message-author-role="user" data-message-id="u1">Hi</div>
      <div data-message-author-role="assistant" data-message-id="a1">Hello</div></body></html>`);
    expect(extractVisibleDomConversation(doc, 'https://chatgpt.com/c/conv1')!.messages).toHaveLength(2);
  });

  it('prefers the active sidebar row as title and rejects placeholder titles', () => {
    const sidebar = parse(`<html><head><title>Nuevo chat</title></head><body>
      <nav><a href="/c/other">Other chat</a><a aria-current="page" href="/c/conv9">Quarterly plan<button>Options</button></a></nav>
      <div data-message-author-role="user" data-message-id="u1">Plan Q3</div></body></html>`);
    expect(extractVisibleDomConversation(sidebar, 'https://chatgpt.com/c/conv9')!.title).toBe('Quarterly plan');

    const slideover = parse(`<html><head><title>ChatGPT</title></head><body>
      <div id="stage-slideover-sidebar"><a aria-current="page" href="/c/conv9">Trip budget</a></div>
      <div data-message-author-role="user" data-message-id="u1">Budget for Rome</div></body></html>`);
    expect(extractVisibleDomConversation(slideover, 'https://chatgpt.com/c/conv9')!.title).toBe('Trip budget');

    for (const placeholder of ['New chat', 'Nuevo chat', 'Neuer Chat', 'Nouveau chat', 'ChatGPT']) {
      const doc = parse(`<html><head><title>${placeholder}</title></head><body>
        <nav><a aria-current="page" href="/c/conv9">${placeholder}</a></nav>
        <div data-message-author-role="user" data-message-id="u1">Compare two laptops</div></body></html>`);
      expect(extractVisibleDomConversation(doc, 'https://chatgpt.com/c/conv9')!.title).toBe('Compare two laptops');
    }
  });

  it('reads ChatGPT Projects from 32-hex routes with or without a slug', () => {
    const projectId = 'g-p-0123456789abcdef0123456789abcdef';
    expect(parseChatGptProjectRoute(`https://chatgpt.com/g/${projectId}/c/conv1`)).toEqual({ projectId, slug: null });
    expect(parseChatGptProjectRoute(`https://chatgpt.com/u/1/g/${projectId}-launch-plan/project`)).toEqual({
      projectId,
      slug: 'launch-plan',
    });

    const labelled = parse(`<html><head><title>Kickoff</title></head><body>
      <nav><div data-app-action-sidebar-project-row data-app-action-sidebar-project-id="g-p-ffffffffffffffffffffffffffffffff" data-app-action-sidebar-project-label="Other"></div>
      <div data-app-action-sidebar-project-row data-app-action-sidebar-project-id="${projectId}" data-app-action-sidebar-project-label="Launch Plan"></div></nav>
      <div data-message-author-role="user" data-message-id="u1">Kickoff agenda</div></body></html>`);
    expect(extractVisibleDomConversation(labelled, `https://chatgpt.com/g/${projectId}/c/conv1`)!.providerProjectName).toBe('Launch Plan');

    const slugOnly = parse(`<html><body><div data-message-author-role="user" data-message-id="u1">Hi</div></body></html>`);
    expect(
      extractVisibleDomConversation(slugOnly, `https://chatgpt.com/u/1/g/${projectId}-launch-plan/c/conv1`)!.providerProjectName
    ).toBe('Launch Plan');

    const titled = parse(`<html><head><title>ChatGPT - Launch Plan</title></head><body>
      <div data-message-author-role="user" data-message-id="u1">Draft the brief</div></body></html>`);
    const res = extractVisibleDomConversation(titled, `https://chatgpt.com/g/${projectId}/c/conv1`)!;
    expect(res.providerProjectName).toBe('Launch Plan');
    expect(res.title).toBe('Draft the brief');
  });

  it('detects Codex under /u/<n>/codex', () => {
    expect(detectProviderFromUrl('https://chatgpt.com/u/1/codex/tasks/task_e_9')).toBe('codex');
    expect(detectProviderFromUrl('https://chatgpt.com/codex')).toBe('codex');
    expect(detectProviderFromUrl('https://chatgpt.com/u/1/c/abc')).toBe('chatgpt');
    expect(extractConversationIdFromUrl('https://chatgpt.com/u/1/codex/tasks/task_e_9')).toBe('task_e_9');
  });

  it('never captures turns inside any editable composer', () => {
    const doc = parse(`<html><body>
      <div data-message-author-role="user" data-message-id="u1">Sent question</div>
      <div contenteditable="plaintext-only"><div data-message-author-role="user" data-message-id="d1">Unsent draft</div></div>
      <div contenteditable="true"><p><span data-message-author-role="user" data-message-id="d2">Another draft</span></p></div>
    </body></html>`);
    expect(extractVisibleDomConversation(doc, 'https://chatgpt.com/c/conv1')!.messages.map((m) => m.content)).toEqual([
      'Sent question',
    ]);
  });
});

describe('Claude capture', () => {
  it('excludes open artifacts, thinking blocks and the streaming reply', () => {
    const doc = parse(`<html><head><title>Haiku - Claude</title></head><body>
      <div data-testid="user-message">Write a haiku about autumn</div>
      <div class="font-claude-response">
        <div class="transition-all duration-300">Thinking about syllables and imagery</div>
        <div class="grid-cols-1"><p>Autumn moonlight falls</p></div>
      </div>
      <div id="markdown-artifact" class="font-claude-response"><p>Artifact body</p></div>
      <div id="markdown-artifact-wrapper"><div id="markdown-artifact"><div class="font-claude-response">Nested artifact</div></div></div>
      <div data-is-streaming="true"><div class="font-claude-response">Partial</div></div>
    </body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://claude.ai/chat/abc')!;
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(res.messages[1].content).toBe('Autumn moonlight falls');
  });

  it('takes the title from the active sidebar row and rejects placeholders', () => {
    const row = parse(`<html><head><title>Claude</title></head><body>
      <nav data-testid="sidebar">
        <div data-row-key="chat:other"><span data-row-label>Older chat</span></div>
        <div data-row-key="chat:abc" aria-current="page"><a href="/chat/abc"><span data-row-label>Webhook retries</span></a><button>More</button></div>
      </nav>
      <div data-testid="user-message">Why do webhooks retry?</div></body></html>`);
    expect(extractVisibleDomConversation(row, 'https://claude.ai/chat/abc')!.title).toBe('Webhook retries');

    for (const placeholder of ['New chat', 'New session', 'Untitled', 'Claude']) {
      const doc = parse(`<html><head><title>${placeholder} - Claude</title></head><body>
        <div data-row-key="chat:abc" aria-current="page"><span data-row-label>${placeholder}</span></div>
        <div data-testid="user-message">Summarize the RFC</div></body></html>`);
      expect(extractVisibleDomConversation(doc, 'https://claude.ai/chat/abc')!.title).toBe('Summarize the RFC');
    }
  });
});

describe('Stable message keys', () => {
  const claudeWindow = (keys: number[]) =>
    parse(`<html><body>${keys
      .map((k) =>
        k % 2
          ? `<div data-turn-key="turn-${k}"><div data-testid="user-message">Question ${k}</div></div>`
          : `<div data-turn-key="turn-${k}"><div class="font-claude-response">Answer ${k}</div></div>`
      )
      .join('')}</body></html>`);

  it('names a message the same whichever slice of a virtual list is mounted', () => {
    const top = extractVisibleDomConversation(claudeWindow([1, 2, 3, 4]), 'https://claude.ai/chat/v1')!;
    const scrolled = extractVisibleDomConversation(claudeWindow([3, 4, 5, 6]), 'https://claude.ai/chat/v1')!;
    const idOf = (res: typeof top, text: string) => res.messages.find((m) => m.content === text)?.sourceMessageId;
    expect(idOf(top, 'Question 3')).toBe('turn-3');
    expect(idOf(scrolled, 'Question 3')).toBe('turn-3');
    expect(idOf(scrolled, 'Answer 6')).toBe('turn-6');
  });

  it('keeps data-message-id as the id when the turn also carries a turn key, so stored ids do not change', () => {
    const doc = parse(`<html><body>
      <article data-testid="conversation-turn-1" data-turn-key="tk-1"><div data-message-author-role="user" data-message-id="m-1">Hi</div></article>
      <article data-testid="conversation-turn-2" data-turn-key="tk-2"><div data-message-author-role="assistant">Hello</div></article>
    </body></html>`);
    expect(extractVisibleDomConversation(doc, 'https://chatgpt.com/c/c1')!.messages.map((m) => m.sourceMessageId)).toEqual([
      'm-1',
      'tk-2',
    ]);
  });

  it('reads DeepSeek and Kimi keys and keeps turns under one keyed ancestor distinct', () => {
    const deepseek = parse(`<html><body>
      <div data-virtual-list-item-key="k7"><div class="ds-message">Which sort is stable?</div></div>
      <div data-virtual-list-item-key="k8"><div class="ds-message"><div class="ds-markdown">Merge sort.</div></div></div></body></html>`);
    expect(
      extractVisibleDomConversation(deepseek, 'https://chat.deepseek.com/a/chat/s/77')!.messages.map((m) => m.sourceMessageId)
    ).toEqual(['k7', 'k8']);

    const shared = parse(`<html><body><div data-turn-key="t1">
      <div data-testid="user-message">Question</div><div class="font-claude-response">Answer</div></div></body></html>`);
    expect(extractVisibleDomConversation(shared, 'https://claude.ai/chat/s1')!.messages.map((m) => m.sourceMessageId)).toEqual([
      't1',
      't1#2',
    ]);

    const unkeyed = parse(`<html><body><div data-testid="user-message">Q</div></body></html>`);
    expect(extractVisibleDomConversation(unkeyed, 'https://claude.ai/chat/s2')!.messages[0].sourceMessageId).toBe(
      's2_main_m_0'
    );
  });
});

describe('Google AI Studio capture', () => {
  it('detects /prompts/:id and reads User / Model turns', () => {
    expect(detectProviderFromUrl('https://aistudio.google.com/prompts/1AbCdEf')).toBe('ai_studio');
    expect(extractConversationIdFromUrl('https://aistudio.google.com/prompts/1AbCdEf')).toBe('1AbCdEf');
    expect(extractConversationIdFromUrl('https://aistudio.google.com/prompts/new_chat')).toBeNull();

    const doc = parse(`<html><head><title>Google AI Studio</title></head><body>
      <ms-chat-turn><div data-turn-role="User"><div class="user-prompt-container">Explain attention</div></div></ms-chat-turn>
      <ms-chat-turn><div data-turn-role="Model"><div class="model-prompt-container">Attention weighs tokens.</div></div></ms-chat-turn>
      <div class="model-prompt-container">Second reply</div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://aistudio.google.com/prompts/1AbCdEf')!;
    expect(res.provider).toBe('ai_studio');
    expect(res.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Explain attention'],
      ['assistant', 'Attention weighs tokens.'],
      ['assistant', 'Second reply'],
    ]);
    expect(res.title).toBe('Explain attention');
    expect(extractVisibleDomConversation(doc, 'https://aistudio.google.com/prompts/new_chat')).toBeNull();
  });
});

describe('Kimi capture', () => {
  it('detects Kimi hosts and chat ids', () => {
    for (const host of ['www.kimi.com', 'kimi.com', 'kimi.ai']) {
      expect(detectProviderFromUrl(`https://${host}/chat/abcdefghij0123456789`)).toBe('kimi');
    }
    expect(extractConversationIdFromUrl('https://www.kimi.com/chat/abcdefghij0123456789')).toBe('abcdefghij0123456789');
    expect(extractConversationIdFromUrl('https://kimi.com/chat/123e4567-e89b-12d3-a456-426614174000')).toBe(
      '123e4567-e89b-12d3-a456-426614174000'
    );
    expect(extractConversationIdFromUrl('https://www.kimi.com/chat/short')).toBeNull();
    expect(extractConversationIdFromUrl('https://www.kimi.com/chat/ABCDEFGHIJ0123456789')).toBeNull();
  });

  it('reads segments, drops the thinking container and keys messages by data-archer-id', () => {
    const doc = parse(`<html><head><title>Rust lifetimes - Kimi</title></head><body>
      <div class="segment segment-user" data-archer-id="m-1">What is a lifetime?</div>
      <div class="segment segment-assistant" data-archer-id="m-2">
        <div class="thinking-container">Let me think about borrows</div>
        <div class="markdown">A lifetime is the scope a reference is valid for.</div>
      </div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://www.kimi.com/chat/abcdefghij0123456789')!;
    expect(res.provider).toBe('kimi');
    expect(res.title).toBe('Rust lifetimes');
    expect(res.messages.map((m) => [m.sourceMessageId, m.role, m.content])).toEqual([
      ['m-1', 'user', 'What is a lifetime?'],
      ['m-2', 'assistant', 'A lifetime is the scope a reference is valid for.'],
    ]);
  });
});

describe('Copilot capture', () => {
  it('covers copilot.com and the group/user-message markup', () => {
    expect(detectProviderFromUrl('https://copilot.com/chats/abc')).toBe('copilot');
    expect(detectProviderFromUrl('https://www.copilot.com/chats/abc')).toBe('copilot');
    expect(captureMatchPatterns()).toEqual(
      expect.arrayContaining(['https://copilot.com/*', 'https://www.copilot.com/*', 'https://copilot.microsoft.com/*'])
    );

    const doc = parse(`<html><head><title>Copilot</title></head><body><div data-content="conversation">
      <div class="group/user-message"><div data-content="user-message">Summarize this memo</div><span>Edited</span></div>
      <div class="group/ai-message"><div class="group/ai-message-item">The memo proposes a freeze.</div><button>Copy</button><span>Sources</span></div>
    </div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://www.copilot.com/chats/abc')!;
    expect(res.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Summarize this memo'],
      ['assistant', 'The memo proposes a freeze.'],
    ]);
  });
});

describe('Gemini, DeepSeek and Grok content', () => {
  it('reads Gemini titles and strips model thoughts', () => {
    const doc = parse(`<html><head><title>Gemini</title></head><body>
      <div data-test-id="conversation-title">Lisbon itinerary</div>
      <user-query><div class="query-text">Plan 3 days in Lisbon</div></user-query>
      <model-response><div class="markdown"><model-thoughts>Considering the user's pace</model-thoughts><p>Day 1: Alfama.</p></div></model-response>
    </body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://gemini.google.com/app/f00d')!;
    expect(res.title).toBe('Lisbon itinerary');
    expect(res.messages[1].content).toBe('Day 1: Alfama.');

    const activated = parse(`<html><head><title>Gemini</title></head><body>
      <mat-list-item class="mdc-list-item--activated"><span mat-line>Tapas list</span></mat-list-item>
      <user-query><div class="query-text">Best tapas</div></user-query></body></html>`);
    expect(extractVisibleDomConversation(activated, 'https://gemini.google.com/app/f00e')!.title).toBe('Tapas list');
  });

  it('keeps DeepSeek reasoning out of the answer and out of the user turns', () => {
    const doc = parse(`<html><body>
      <div class="ds-message">Which sort is stable?</div>
      <div class="ds-message"><div class="ds-think-content"><div class="ds-markdown">Reasoning about sorts</div></div><div class="ds-markdown">Merge sort.</div></div>
      <div class="ds-message"><div class="ds-think-content">Still thinking</div></div>
    </body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://chat.deepseek.com/a/chat/s/77')!;
    expect(res.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'Which sort is stable?'],
      ['assistant', 'Merge sort.'],
    ]);
  });

  it('uses the Grok response markdown as the content root', () => {
    const doc = parse(`<html><head><title>Rockets - Grok</title></head><body>
      <div id="response-1" class="flex items-end"><div class="message-bubble"><div class="response-content-markdown">What is delta-v?</div><span>12:04</span></div></div>
      <div id="response-2" class="flex items-start"><div class="message-bubble"><div class="response-content-markdown">Change in velocity.</div><span>12:05</span></div></div>
    </body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://grok.com/c/abc-123')!;
    expect(res.messages.map((m) => m.content)).toEqual(['What is delta-v?', 'Change in velocity.']);
  });
});

describe('Manifest match patterns', () => {
  it('normalizes web_accessible_resources matches to deduplicated origin patterns', () => {
    expect(
      toOriginMatchPatterns([
        'https://x.com/i/grok?conversation=*',
        'https://x.com/*',
        'https://Claude.ai/chat/*',
        '*://*.example.com/path/to',
        'https://aistudio.google.com',
        'not a pattern',
        'https:///nohost',
      ])
    ).toEqual(['https://x.com/*', 'https://claude.ai/*', '*://*.example.com/*', 'https://aistudio.google.com/*']);
  });

  it('derives origin-only patterns that cover every capture host, X included', () => {
    const capture = captureMatchPatterns();
    expect(capture).toEqual(expect.arrayContaining(['https://x.com/*', 'https://twitter.com/*']));
    const origins = toOriginMatchPatterns(capture);
    expect(origins).toEqual(capture);
    for (const pattern of origins) expect(pattern).toMatch(/^https:\/\/[^/?#*]+\/\*$/);
  });
});
