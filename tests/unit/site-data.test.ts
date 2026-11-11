// @vitest-environment-options {"url": "https://chatgpt.com/c/11111111-2222-4333-8444-555555555555"}
// The page is a ChatGPT conversation so the MAIN-world observer and the content script can be
// exercised as they run on chatgpt.com. The parser tests are pure.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  chatGptConversationIdFromApiUrl,
  claudeConversationFromApiUrl,
  cleanChatGptText,
  matchSiteConversationRequest,
  parseChatGptConversation,
  parseClaudeConversation,
  parseIdentityMessage,
  parseSiteDataMessage,
  siteConversationTitle,
  toIso,
} from '../../src/core/site-api.js';
import { extractVisibleDomConversation } from '../../src/core/dom-capture.js';

const CONV = '11111111-2222-4333-8444-555555555555';
const ORG = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

// ---------------------------------------------------------------------------
// Parsers
// ---------------------------------------------------------------------------

const node = (id: string, parent: string | null, children: string[], message: Record<string, unknown> | null) => ({ id, parent, children, message });
const msg = (id: string, role: string, parts: unknown[], extra: Record<string, unknown> = {}, contentType = 'text') => ({
  id,
  author: { role },
  create_time: 1793700000,
  recipient: 'all',
  content: { content_type: contentType, parts },
  metadata: {},
  ...extra,
});

const chatGptConversation = {
  conversation_id: CONV,
  title: 'Stripe webhook retries',
  create_time: 1793690000.5,
  update_time: 1793700500,
  default_model_slug: 'gpt-5',
  gizmo_id: 'g-p-0123456789abcdef0123456789abcdef',
  current_node: 'a2b',
  mapping: {
    root: node('root', null, ['sys'], null),
    sys: node('sys', 'root', ['ctx'], msg('sys', 'system', ['']) as never),
    ctx: node('ctx', 'sys', ['u1'], msg('ctx', 'user', ['hidden memory'], { metadata: { is_visually_hidden_from_conversation: true } }, 'user_editable_context')),
    u1: node('u1', 'ctx', ['think'], msg('u1', 'user', ['How do I stop double charges when Stripe retries?'])),
    think: node('think', 'u1', ['tool'], { ...msg('think', 'assistant', [], {}, 'thoughts'), content: { content_type: 'thoughts', thoughts: [{ content: 'reasoning' }] } }),
    tool: node('tool', 'think', ['out'], { ...msg('tool', 'assistant', [], { recipient: 'python' }, 'code'), content: { content_type: 'code', text: 'print(1)' } }),
    out: node('out', 'tool', ['a1'], msg('out', 'tool', ['1'], {}, 'execution_output')),
    a1: node('a1', 'out', ['u2', 'u2alt'], msg('a1', 'assistant', ['Store each processed event id.citeturn0search0 Skip duplicates.'], { metadata: { model_slug: 'gpt-5' } })),
    // The abandoned branch (the user edited the question).
    u2alt: node('u2alt', 'a1', ['a2alt'], msg('u2alt', 'user', ['Old wording of the follow-up'])),
    a2alt: node('a2alt', 'u2alt', [], msg('a2alt', 'assistant', ['Answer to the old wording'])),
    u2: node('u2', 'a1', ['a2a'], msg('u2', 'user', ['Show me the table definition'])),
    a2a: node('a2a', 'u2', ['a2b'], msg('a2a', 'assistant', ['Let me write that out.'], { channel: 'commentary', metadata: { model_slug: 'gpt-5' } })),
    a2b: node('a2b', 'a2a', [], msg('a2b', 'assistant', ['CREATE TABLE processed_events (id text primary key);'], { metadata: { model_slug: 'gpt-5-thinking' } })),
  },
};

describe('ChatGPT conversation parser', () => {
  const parsed = parseChatGptConversation(chatGptConversation)!;

  it('follows the active branch and keeps only what a reader sees', () => {
    expect(parsed.messages.map((m) => m.sourceMessageId)).toEqual(['u1', 'a1', 'u2', 'a2a', 'a2b']);
    expect(parsed.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'assistant']);
  });

  it('removes citation widgets and keeps the surrounding text', () => {
    expect(parsed.messages[1].content).toBe('Store each processed event id. Skip duplicates.');
    expect(cleanChatGptText('See entity["company","Stripe","payments"] docs')).toBe('See Stripe docs');
  });

  it('carries the title, times, model, project id and canonical URL', () => {
    expect(parsed).toMatchObject({
      provider: 'chatgpt',
      sourceConversationId: CONV,
      canonicalUrl: `https://chatgpt.com/c/${CONV}`,
      title: 'Stripe webhook retries',
      modelSlug: 'gpt-5-thinking',
      providerProjectId: 'g-p-0123456789abcdef0123456789abcdef',
      createdAt: '2026-11-03T05:53:20.500Z'.replace('05:53:20', new Date(1793690000500).toISOString().slice(11, 19)),
    });
    expect(parsed.messages[0].createdAt).toBe(new Date(1793700000 * 1000).toISOString());
  });

  it('falls back to the newest leaf without current_node, and to a derived title', () => {
    const noCurrent = parseChatGptConversation({ ...chatGptConversation, current_node: undefined, title: '' })!;
    expect(noCurrent.messages.length).toBeGreaterThan(0);
    expect(siteConversationTitle(noCurrent)).toBe('How do I stop double charges when Stripe retries?');
  });

  it('rejects data that is not a conversation, and survives hostile shapes', () => {
    expect(parseChatGptConversation(null)).toBeNull();
    expect(parseChatGptConversation({ mapping: [] })).toBeNull();
    expect(parseChatGptConversation({ conversation_id: '../x', mapping: {} })).toBeNull();
    expect(
      parseChatGptConversation({ conversation_id: CONV, current_node: 'a', mapping: { a: { id: 'a', parent: 'a', message: { author: 'x', content: 5 } } } })!.messages
    ).toEqual([]);
  });
});

describe('Claude conversation parser', () => {
  const claude = {
    uuid: CONV,
    name: 'Launch plan',
    created_at: '2026-11-01T10:00:00.000000Z',
    updated_at: '2026-11-02T10:00:00.000000Z',
    model: 'claude-opus-5-5',
    project_uuid: 'bbbbbbbb-0000-4000-8000-000000000001',
    current_leaf_message_uuid: 'm4',
    chat_messages: [
      { uuid: 'm1', sender: 'human', index: 0, parent_message_uuid: '00000000-0000-4000-8000-000000000000', text: 'Plan the launch', content: [{ type: 'text', text: 'Plan the launch' }], created_at: '2026-11-01T10:00:00Z' },
      { uuid: 'm2', sender: 'assistant', index: 1, parent_message_uuid: 'm1', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'Start with the checklist.' }, { type: 'tool_use', name: 'artifacts' }] },
      { uuid: 'm3x', sender: 'human', index: 2, parent_message_uuid: 'm2', content: [{ type: 'text', text: 'Abandoned edit' }] },
      { uuid: 'm3', sender: 'human', index: 2, parent_message_uuid: 'm2', text: 'Add owners' },
      { uuid: 'm4', sender: 'assistant', index: 3, parent_message_uuid: 'm3', content: [{ type: 'text', text: 'Owners added.' }] },
    ],
  };

  it('follows the branch ending at the current leaf and ignores thinking and tool blocks', () => {
    const p = parseClaudeConversation(claude)!;
    expect(p.messages.map((m) => [m.sourceMessageId, m.role, m.content])).toEqual([
      ['m1', 'user', 'Plan the launch'],
      ['m2', 'assistant', 'Start with the checklist.'],
      ['m3', 'user', 'Add owners'],
      ['m4', 'assistant', 'Owners added.'],
    ]);
    expect(p).toMatchObject({ title: 'Launch plan', modelSlug: 'claude-opus-5-5', canonicalUrl: `https://claude.ai/chat/${CONV}` });
  });

  it('uses message order when there are no parent links', () => {
    const flat = { ...claude, current_leaf_message_uuid: null, chat_messages: claude.chat_messages.filter((m) => m.uuid !== 'm3x').map(({ parent_message_uuid: _p, ...rest }) => rest) };
    expect(parseClaudeConversation(flat)!.messages.map((m) => m.sourceMessageId)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });

  it('rejects non-conversations', () => {
    expect(parseClaudeConversation({ uuid: CONV })).toBeNull();
    expect(parseClaudeConversation('x')).toBeNull();
  });
});

describe('request URLs and times', () => {
  it('matches only a conversation document, never a sub-resource or a send', () => {
    expect(chatGptConversationIdFromApiUrl(`https://chatgpt.com/backend-api/conversation/${CONV}`)).toBe(CONV);
    expect(chatGptConversationIdFromApiUrl(`/backend-api/conversation/${CONV}?x=1`)).toBe(CONV);
    expect(chatGptConversationIdFromApiUrl(`/backend-api/conversation/${CONV}/textdocs`)).toBeNull();
    expect(chatGptConversationIdFromApiUrl('/backend-api/conversation')).toBeNull();
    expect(chatGptConversationIdFromApiUrl('/backend-api/conversations?offset=0')).toBeNull();
    expect(claudeConversationFromApiUrl(`/api/organizations/${ORG}/chat_conversations/${CONV}?tree=True`)).toEqual({ orgId: ORG, conversationId: CONV });
    expect(claudeConversationFromApiUrl(`/api/organizations/${ORG}/chat_conversations`)).toBeNull();
    expect(matchSiteConversationRequest('chatgpt.com', `/backend-api/conversation/${CONV}`)?.provider).toBe('chatgpt');
    expect(matchSiteConversationRequest('claude.ai', `/api/organizations/${ORG}/chat_conversations/${CONV}`)?.provider).toBe('claude');
    expect(matchSiteConversationRequest('example.com', `/backend-api/conversation/${CONV}`)).toBeNull();
  });

  it('reads seconds, milliseconds and date strings', () => {
    expect(toIso(1793700000)).toBe(new Date(1793700000000).toISOString());
    expect(toIso(1793700000000)).toBe(new Date(1793700000000).toISOString());
    expect(toIso('2026-11-03T00:00:00Z')).toBe('2026-11-03T00:00:00.000Z');
    expect(toIso(0)).toBeNull();
    expect(toIso('nope')).toBeNull();
  });

  it('validates the page-world message', () => {
    expect(parseSiteDataMessage({ source: 'threadkeeper-site-data', provider: 'chatgpt', conversationId: CONV, json: {} })?.conversationId).toBe(CONV);
    expect(parseSiteDataMessage({ source: 'other', provider: 'chatgpt', conversationId: CONV, json: {} })).toBeNull();
    expect(parseSiteDataMessage({ source: 'threadkeeper-site-data', provider: 'grok', conversationId: CONV, json: {} })).toBeNull();
    expect(parseSiteDataMessage({ source: 'threadkeeper-site-data', provider: 'claude', conversationId: '../x', json: {} })).toBeNull();
    expect(parseSiteDataMessage({ source: 'threadkeeper-site-data', provider: 'claude', conversationId: CONV, json: [] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DOM: several messages in one turn
// ---------------------------------------------------------------------------

describe('identity window message', () => {
  it('accepts a known source with a text body up to 64 KB, and nothing else', () => {
    const ok = { source: 'threadkeeper-identity', kind: 'chatgpt_session', body: '{"user":{}}' };
    expect(parseIdentityMessage(ok)).toEqual(ok);
    expect(parseIdentityMessage({ ...ok, body: 'x'.repeat(64 * 1024) })).not.toBeNull();
    expect(parseIdentityMessage({ ...ok, body: 'x'.repeat(64 * 1024 + 1) })).toBeNull();
    expect(parseIdentityMessage({ ...ok, body: '' })).toBeNull();
    expect(parseIdentityMessage({ ...ok, body: { user: {} } })).toBeNull();
    expect(parseIdentityMessage({ ...ok, kind: 'toString' })).toBeNull();
    expect(parseIdentityMessage({ ...ok, kind: 'gmail' })).toBeNull();
    expect(parseIdentityMessage({ ...ok, source: 'threadkeeper-site-data' })).toBeNull();
    expect(parseIdentityMessage('{"source":"threadkeeper-identity"}')).toBeNull();
    expect(parseIdentityMessage(null)).toBeNull();
  });
});

describe('ChatGPT turns that hold several messages', () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

  it('keeps every message of a turn, not only the first', () => {
    const doc = parse(`<html><body>
      <article data-testid="conversation-turn-1" data-turn="user"><div data-message-author-role="user" data-message-id="u1"><div class="whitespace-pre-wrap">Find the retry policy</div></div></article>
      <section data-testid="conversation-turn-2" data-turn="assistant">
        <div data-message-author-role="assistant" data-message-id="a1" data-message-model-slug="gpt-5"><div class="markdown"><p>Let me look that up.</p></div></div>
        <div data-message-author-role="assistant" data-message-id="a2" data-message-model-slug="gpt-5"><div class="markdown"><p>Stripe retries for up to three days.</p></div></div>
      </section></body></html>`);
    const res = extractVisibleDomConversation(doc, `https://chatgpt.com/c/${CONV}`)!;
    expect(res.messages.map((m) => [m.sourceMessageId, m.content])).toEqual([
      ['u1', 'Find the retry policy'],
      ['a1', 'Let me look that up.'],
      ['a2', 'Stripe retries for up to three days.'],
    ]);
  });

  it('reads all markdown blocks of one message', () => {
    const doc = parse(`<html><body>
      <div data-message-author-role="assistant" data-message-id="a1" data-message-model-slug="gpt-5">
        <div class="markdown"><p>First part.</p></div><div class="widget">Chart</div><div class="markdown"><p>Second part.</p></div>
      </div></body></html>`);
    expect(extractVisibleDomConversation(doc, `https://chatgpt.com/c/${CONV}`)!.messages[0].content).toBe('First part.\n\nSecond part.');
  });

  it('takes the speaker from the turn wrapper when the message has not rendered its own role yet', () => {
    const doc = parse(`<html><body>
      <article data-testid="conversation-turn-1" data-turn="user"><div class="whitespace-pre-wrap">Plan the launch</div></article>
      <article data-testid="conversation-turn-2" data-turn="assistant"><div class="markdown">Here is a plan.</div></article></body></html>`);
    expect(extractVisibleDomConversation(doc, `https://chatgpt.com/c/${CONV}`)!.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });
});

// ---------------------------------------------------------------------------
// MAIN-world observer and content script
// ---------------------------------------------------------------------------

describe('ChatGPT: MAIN-world observer and isolated content script', () => {
  const posted: Array<Record<string, unknown>> = [];
  const sent: Array<{ type?: string; payload?: Record<string, unknown> }> = [];
  const pageFetch = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>();
  const listeners: Array<(m: unknown, s: unknown, r: (x: unknown) => void) => unknown> = [];

  beforeAll(async () => {
    window.fetch = pageFetch;
    await import('../../src/entrypoints/site-data-main.js');
    vi.stubGlobal('chrome', {
      runtime: {
        getURL: (p: string) => `chrome-extension://tk-test-id/${p}`,
        sendMessage: (message: { type?: string; payload?: Record<string, unknown> }, cb?: (r: unknown) => void) => {
          sent.push(message);
          cb?.({ ok: true });
        },
        onMessage: { addListener: (fn: (m: unknown, s: unknown, r: (x: unknown) => void) => unknown) => listeners.push(fn) },
      },
    });
    await import('../../src/entrypoints/content.js');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    document.body.innerHTML = '';
    history.replaceState(null, '', `/c/${CONV}`);
  });

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const deliver = (data: unknown, init: { origin?: string; source?: MessageEventSource | null } = {}) =>
    window.dispatchEvent(
      new MessageEvent('message', { data, origin: init.origin ?? window.location.origin, source: init.source === undefined ? window : init.source })
    );
  const siteMessage = (id = CONV, json: unknown = chatGptConversation) => ({ source: 'threadkeeper-site-data', provider: 'chatgpt', conversationId: id, json });
  const networkCaptures = (action: () => void) => {
    vi.useFakeTimers();
    const before = sent.length;
    action();
    vi.advanceTimersByTime(6000);
    return sent.slice(before).filter((m) => m.type === 'PASSIVE_DOM_CAPTURE' && m.payload?.captureSource === 'network_observer');
  };

  it('posts the conversation response from a clone and hands the page the untouched response', async () => {
    const spy = vi.spyOn(window, 'postMessage').mockImplementation((message: unknown) => {
      posted.push(message as Record<string, unknown>);
    });
    const response = new Response(JSON.stringify(chatGptConversation), { status: 200 });
    pageFetch.mockResolvedValueOnce(response);
    const got = await window.fetch(`/backend-api/conversation/${CONV}`);
    expect(got).toBe(response);
    expect((await got.json()).title).toBe('Stripe webhook retries');
    await flush();
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][1]).toBe('https://chatgpt.com');
    expect(posted.at(-1)).toMatchObject({ source: 'threadkeeper-site-data', provider: 'chatgpt', conversationId: CONV });
  });

  it('ignores sends, sub-resources, failures and other URLs, and rethrows page errors unchanged', async () => {
    const spy = vi.spyOn(window, 'postMessage').mockImplementation(() => undefined);
    pageFetch.mockResolvedValueOnce(new Response('{}'));
    await window.fetch(`/backend-api/conversation/${CONV}`, { method: 'POST', body: '{}' });
    pageFetch.mockResolvedValueOnce(new Response('{}'));
    await window.fetch(`/backend-api/conversation/${CONV}/textdocs`);
    pageFetch.mockResolvedValueOnce(new Response('{}'));
    await window.fetch('/backend-api/conversations?offset=0&limit=28');
    pageFetch.mockResolvedValueOnce(new Response('nope', { status: 500 }));
    await window.fetch(`/backend-api/conversation/${CONV}`);
    const failure = new TypeError('offline');
    pageFetch.mockRejectedValueOnce(failure);
    await expect(window.fetch(`/backend-api/conversation/${CONV}`)).rejects.toBe(failure);
    await flush();
    expect(spy).not.toHaveBeenCalled();
  });

  it('sends a full capture of the open conversation, tagged as the site\'s own data', () => {
    const captures = networkCaptures(() => deliver(siteMessage()));
    expect(captures).toHaveLength(1);
    expect(captures[0].payload).toMatchObject({
      provider: 'chatgpt',
      sourceConversationId: CONV,
      branchId: 'main',
      title: 'Stripe webhook retries',
      coverage: 'full',
      captureSource: 'network_observer',
      modelSlug: 'gpt-5-thinking',
    });
    expect((captures[0].payload?.messages as Array<{ sourceMessageId: string }>).map((m) => m.sourceMessageId)).toEqual(['u1', 'a1', 'u2', 'a2a', 'a2b']);
  });

  it('ignores forged, foreign, mismatched and malformed messages', () => {
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);
    const captures = networkCaptures(() => {
      deliver(siteMessage(), { source: iframe.contentWindow });
      deliver(siteMessage(), { source: null });
      deliver(siteMessage(), { origin: 'https://evil.example' });
      deliver(siteMessage('99999999-2222-4333-8444-555555555555')); // another conversation
      deliver(siteMessage(CONV, { mapping: 'nope' }));
      deliver({ ...siteMessage(), provider: 'claude' }); // wrong site for this page
    });
    expect(captures).toHaveLength(0);
  });

  it('answers a capture probe with what a capture would see', () => {
    document.body.innerHTML = `<div data-message-author-role="user" data-message-id="p1">Probe question</div>
      <div data-message-author-role="assistant" data-message-id="p2" data-message-model-slug="gpt-5">Probe answer</div>`;
    let report: Record<string, unknown> | undefined;
    for (const fn of listeners) fn({ type: 'TK_CAPTURE_PROBE' }, {}, (r) => (report = (r as { report: Record<string, unknown> }).report));
    expect(report).toMatchObject({ provider: 'chatgpt', conversationId: CONV, domMessages: 2, domRoles: { user: 1, assistant: 1 } });
  });

  it('does not file the previous conversation\'s messages under the new URL after a navigation', async () => {
    vi.useFakeTimers();
    const other = '22222222-2222-4333-8444-555555555555';
    const renderConversation = (n: string) => {
      document.body.innerHTML = `<div data-message-author-role="user" data-message-id="${n}-u">Question ${n}</div>
        <div data-message-author-role="assistant" data-message-id="${n}-a" data-message-model-slug="gpt-5">Answer ${n}</div>`;
    };
    const domCaptures = () => sent.filter((m) => m.type === 'PASSIVE_DOM_CAPTURE' && m.payload?.captureSource === 'dom_observer');

    renderConversation('A');
    await vi.advanceTimersByTimeAsync(6000);
    const first = domCaptures().at(-1)!;
    expect(first.payload?.sourceConversationId).toBe(CONV);

    // The URL changes first; the page still shows conversation A for a moment.
    const before = domCaptures().length;
    history.replaceState(null, '', `/c/${other}`);
    document.body.appendChild(document.createElement('span')); // a mutation, as the app would cause
    await vi.advanceTimersByTimeAsync(2000);
    const during = domCaptures().slice(before).filter((m) => m.payload?.sourceConversationId === other);
    expect(during.every((m) => (m.payload?.messages as unknown[]).length === 0)).toBe(true);
    expect(JSON.stringify(domCaptures().slice(before))).not.toContain('Answer A');

    // The page then renders conversation B and it is captured under B.
    renderConversation('B');
    await vi.advanceTimersByTimeAsync(6000);
    const last = domCaptures().at(-1)!;
    expect(last.payload?.sourceConversationId).toBe(other);
    expect((last.payload?.messages as Array<{ content: string }>).map((m) => m.content)).toEqual(['Question B', 'Answer B']);
  });

  it('captures a page that never goes quiet instead of waiting for a pause', async () => {
    vi.useFakeTimers();
    const domCaptures = () => sent.filter((m) => m.type === 'PASSIVE_DOM_CAPTURE' && m.payload?.captureSource === 'dom_observer');
    const before = domCaptures().length;
    document.body.innerHTML = `<div data-message-author-role="user" data-message-id="busy-u">Busy question</div>
      <div data-message-author-role="assistant" data-message-id="busy-a" data-message-model-slug="gpt-5">Busy answer</div>`;
    // A timer that ticks every 500 ms (a "Thinking for 12 s" counter) keeps resetting a trailing debounce.
    const ticker = document.createElement('span');
    document.body.appendChild(ticker);
    let n = 0;
    const handle = setInterval(() => {
      ticker.textContent = String(++n);
    }, 500);
    await vi.advanceTimersByTimeAsync(4600);
    clearInterval(handle);
    expect(domCaptures().length).toBeGreaterThan(before);
  });
});
