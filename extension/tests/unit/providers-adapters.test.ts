// DOM adapters for the opt-in providers. Every fixture is synthetic, modelled on the
// selectors documented in public exporters and the sites' own bundles (see providers.ts
// selectorConfidence); none was recorded from a signed-in page.
import { describe, expect, it } from 'vitest';
import {
  detectSelfHostedApp,
  extractVisibleDomConversation,
  siteConversationIdFromUrl,
} from '../../src/core/dom-capture.js';

const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
const turns = (res: ReturnType<typeof extractVisibleDomConversation>) => res!.messages.map((m) => [m.role, m.content]);

describe('Meta AI', () => {
  const page = (streaming = 'DONE') => parse(`<html><head><title>(2) Trip to Lisbon | Meta AI</title></head><body>
    <nav><div data-testid="conversation-item"><a href="/prompt/abc-1">Trip to Lisbon</a></div></nav>
    <div role="feed">
      <div data-message-item data-message-id="u1" role="article" data-user-message=""><div data-message-type="user" class="group/user-message">Plan three days in Lisbon</div></div>
      <div data-message-item data-message-id="a1" role="article"><div data-testid="assistant-message" data-streaming-state="DONE">
        <div data-testid="subagent-cot-1">Searching the web…</div><p>Day 1: Alfama and the castle.</p><span data-testid="sources-pill">3 sources</span></div></div>
      <div data-message-item data-message-id="u2" role="article" data-user-message=""><div data-message-type="user">Add a food tour</div></div>
      <div data-message-item data-message-id="a2" role="article"><div data-testid="assistant-message" data-streaming-state="${streaming}"><p>Partial…</p></div></div>
    </div></body></html>`);

  it('reads roles from data-user-message, strips reasoning and source pills, keeps message ids', () => {
    const res = extractVisibleDomConversation(page(), 'https://www.meta.ai/prompt/abc-1')!;
    expect(res.provider).toBe('meta_ai');
    expect(res.sourceConversationId).toBe('abc-1');
    expect(res.title).toBe('Trip to Lisbon');
    expect(turns(res)).toEqual([
      ['user', 'Plan three days in Lisbon'],
      ['assistant', 'Day 1: Alfama and the castle.'],
      ['user', 'Add a food tour'],
      ['assistant', 'Partial…'],
    ]);
    expect(res.messages.map((m) => m.sourceMessageId)).toEqual(['u1', 'a1', 'u2', 'a2']);
    expect(res.method).toBe('adapter');
    expect(res.stabilize).toBe(false);
  });

  it('skips a reply that is still streaming', () => {
    const res = extractVisibleDomConversation(page('STREAMING'), 'https://www.meta.ai/prompt/abc-1')!;
    expect(res.messages.map((m) => m.sourceMessageId)).toEqual(['u1', 'a1', 'u2']);
  });
});

describe('HuggingChat', () => {
  it('reads chat-ui markup, joins split prose blocks and skips the reply being generated', () => {
    const html = (stop: string) => parse(`<html><head><title>Sorting in Rust - HuggingChat</title></head><body>
      <div data-message-type="user" data-message-id="m1" role="presentation"><p class="disabled">How do I sort a Vec?</p><button>Edit</button></div>
      <div data-message-role="assistant" data-message-id="m2" role="presentation"><details>Thinking…</details>
        <div class="prose"><p>Use <code>sort()</code>.</p></div><div class="widget">tool</div><div class="prose"><p>Or sort_by for keys.</p></div></div>
      <div data-message-type="user" data-message-id="m3" role="presentation"><p class="disabled">And stable?</p></div>
      <div data-message-role="assistant" data-message-id="m4" role="presentation"><div class="prose"><p>Half an ans</p></div></div>
      ${stop}</body></html>`);
    const done = extractVisibleDomConversation(html(''), 'https://huggingface.co/chat/conversation/0123456789abcdef01234567')!;
    expect(done.title).toBe('Sorting in Rust');
    expect(turns(done)).toEqual([
      ['user', 'How do I sort a Vec?'],
      ['assistant', 'Use sort().\n\nOr sort_by for keys.'],
      ['user', 'And stable?'],
      ['assistant', 'Half an ans'],
    ]);
    const live = extractVisibleDomConversation(html('<button class="stop-generating-btn" aria-label="Stop generating">Stop</button>'), 'https://huggingface.co/chat/conversation/0123456789abcdef01234567')!;
    expect(live.messages.map((m) => m.sourceMessageId)).toEqual(['m1', 'm2', 'm3']);
  });

  it('captures nothing on HuggingChat pages that are not conversations', () => {
    expect(extractVisibleDomConversation(parse('<div class="prose">x</div>'), 'https://huggingface.co/chat/settings')).toBeNull();
  });
});

describe('Poe', () => {
  it('matches CSS-module prefixes whatever their hash suffix', () => {
    const doc = parse(`<html><head><title>Haiku about tea - Poe</title></head><body><div class="ChatMessagesView_infiniteScroll__K">
      <div class="ChatMessage_messageRow__DHlnq"><div class="Message_rightSideMessageWrapper__x"><div class="Message_humanMessageBubble__DtRxA"><div class="Markdown_markdownContainer__Tz3HQ">Write a haiku about tea</div></div></div></div>
      <div class="ChatMessage_messageRow__DHlnq"><div class="Message_leftSideMessageBubble__y"><div class="Message_botMessageBubble__aYctV"><div class="Markdown_markdownContainer__Tz3HQ"><p>Steam curls from the cup</p></div></div></div></div>
    </div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://poe.com/chat/2abc9')!;
    expect(res.provider).toBe('poe');
    expect(res.title).toBe('Haiku about tea');
    expect(turns(res)).toEqual([
      ['user', 'Write a haiku about tea'],
      ['assistant', 'Steam curls from the cup'],
    ]);
    // No dependable streaming signal on Poe: the content script waits for the text to settle.
    expect(res.stabilize).toBe(true);
  });
});

describe('Qwen Chat and Z.ai', () => {
  it('reads Qwen user and assistant blocks and strips the thinking card', () => {
    const doc = parse(`<html><head><title>Vector DB choice - Qwen</title></head><body><div id="chat-message-container">
      <div class="qwen-chat-message-user" id="qwen-chat-message-user-u1"><div class="user-message-content">Which vector DB for 1M docs?</div></div>
      <div class="qwen-chat-message-assistant" id="qwen-chat-message-assistant-a1"><div class="qwen-chat-thinking-status-card">Thinking done</div>
        <div class="response-message-content"><p>pgvector is enough at that size.</p></div><div class="response-message-footer">Copy</div></div>
    </div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://chat.qwen.ai/c/9f1e2d3c-aaaa')!;
    expect(res.title).toBe('Vector DB choice');
    expect(turns(res)).toEqual([
      ['user', 'Which vector DB for 1M docs?'],
      ['assistant', 'pgvector is enough at that size.'],
    ]);
    expect(res.messages.map((m) => m.sourceMessageId)).toEqual(['u1', 'a1']);
  });

  it('reads Z.ai (Open WebUI markup) and drops reasoning blocks', () => {
    const doc = parse(`<html><head><title>GLM test | Z.ai</title></head><body><div id="chat-container"><div id="messages-container">
      <div id="message-u1" class="user-message"><div class="chat-user"><div class="markdown-prose">Explain RLHF</div></div></div>
      <div id="message-a1"><div class="thinking-chain-container">chain</div><div class="markdown-prose"><p>RLHF tunes a model on human preferences.</p></div></div>
    </div></div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://chat.z.ai/c/0a1b2c3d-1')!;
    expect(res.provider).toBe('zai');
    expect(res.title).toBe('GLM test');
    expect(turns(res)).toEqual([
      ['user', 'Explain RLHF'],
      ['assistant', 'RLHF tunes a model on human preferences.'],
    ]);
  });
});

describe('Doubao, Genspark, Manus, Lumo, Duck.ai', () => {
  it('Doubao: justify-end marks the user; the stop button marks an unfinished reply', () => {
    const doc = (stop: boolean) => parse(`<html><head><title>周末计划 - 豆包</title></head><body><div data-target-id="message-box-target-id">
      <div data-message-id="1" class="flex justify-end"><div class="whitespace-pre-wrap wrap-anywhere">周末去哪儿？</div></div>
      <div data-message-id="2" class="flex"><div data-testid="think_block_collapse">思考中</div><div class="flow-markdown-body"><p>去西湖。</p></div></div>
    </div>${stop ? '<button data-testid="chat_input_local_break_button">停止</button>' : ''}</body></html>`);
    expect(turns(extractVisibleDomConversation(doc(false), 'https://www.doubao.com/chat/12345'))).toEqual([
      ['user', '周末去哪儿？'],
      ['assistant', '去西湖。'],
    ]);
    expect(turns(extractVisibleDomConversation(doc(true), 'https://www.doubao.com/chat/12345'))).toEqual([['user', '周末去哪儿？']]);
  });

  it('Genspark: statements by role, title from the agent name input', () => {
    const doc = parse(`<html><body><input class="agent-name-input" value="Market scan"><div class="conversation-content">
      <div class="conversation-statement user"><div class="content">Scan EV charger makers</div></div>
      <div class="conversation-statement assistant"><div class="markdown-viewer"><p>Top five by revenue…</p></div></div>
    </div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://www.genspark.ai/agents?id=proj_1')!;
    expect(res.title).toBe('Market scan');
    expect(res.canonicalUrl).toBe('https://www.genspark.ai/agents?id=proj_1');
    expect(turns(res)).toEqual([
      ['user', 'Scan EV charger makers'],
      ['assistant', 'Top five by revenue…'],
    ]);
  });

  it('Manus: question bubbles and markdown replies, never the suggested follow-ups', () => {
    const doc = parse(`<html><head><title>Competitor report - Manus</title></head><body><div class="x--chat-message-list">
      <div data-chat-question-bubble="true">Build a competitor report</div>
      <div class="manus-markdown"><p>I'll start by listing competitors.</p></div>
      <div data-chat-suggested-follow-ups><div class="manus-markdown">Want a chart?</div></div>
    </div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://manus.im/app/TaskX1')!;
    expect(res.title).toBe('Competitor report');
    expect(turns(res)).toEqual([
      ['user', 'Build a competitor report'],
      ['assistant', "I'll start by listing competitors."],
    ]);
  });

  it('Lumo: roles from data-message-role, thinking path stripped', () => {
    const doc = parse(`<html><head><title>Privacy laws | Lumo</title></head><body><div class="lumo-message-chain">
      <div class="lumo-chat-item" data-message-role="user"><div class="user-msg-container"><div class="lumo-markdown">Summarize GDPR</div></div></div>
      <div class="lumo-chat-item" data-message-role="assistant"><div class="thinking-path">…</div><div class="progressive-markdown-content"><p>GDPR governs personal data in the EU.</p></div></div>
    </div></body></html>`);
    expect(turns(extractVisibleDomConversation(doc, 'https://lumo.proton.me/u/0/c/1234abcd-ef'))).toEqual([
      ['user', 'Summarize GDPR'],
      ['assistant', 'GDPR governs personal data in the EU.'],
    ]);
  });

  it('Duck.ai: only the active response, never a hidden alternative, and only saved chats', () => {
    const doc = parse(`<html><body><main>
      <div data-testid="user-message">Is coffee bad for sleep?</div>
      <div data-activeresponse="false"><span>model</span><div>An older answer</div></div>
      <div data-activeresponse="true"><span>model</span><div><p>Caffeine lasts about 5 hours.</p><div data-message-actions>Copy</div></div></div>
    </main></body></html>`);
    expect(turns(extractVisibleDomConversation(doc, 'https://duck.ai/chat?chatID=c1'))).toEqual([
      ['user', 'Is coffee bad for sleep?'],
      ['assistant', 'Caffeine lasts about 5 hours.'],
    ]);
    expect(extractVisibleDomConversation(doc, 'https://duck.ai/chat')).toBeNull();
  });
});

describe('Character.AI', () => {
  const doc = (typing = false) => parse(`<html><body><div id="chat-header"><a href="/character/abc"><p>Sherlock</p></a></div>
    <div id="chat-messages" style="flex-direction: column-reverse">
      ${typing ? '<div><div class="cai-badge">c.ai</div><div class="ticontainer">…</div></div>' : ''}
      <div><div class="cai-badge">c.ai</div><div data-testid="completed-message"><div class="prose">Elementary.</div></div></div>
      <div><div class="flex-row-reverse"><div data-testid="completed-message"><div class="prose">How did you know?</div></div></div></div>
      <div><div class="cai-badge">c.ai</div><div class="swiper-slide">Other reply</div><div class="swiper-slide swiper-slide-active"><div data-testid="completed-message"><div class="prose">You have been in Afghanistan.</div></div></div></div>
      <div><div class="flex-row-reverse"><div data-testid="completed-message"><div class="prose">Hello</div></div></div></div>
      <div><a href="/character/abc"><p class="bold">Sherlock</p></a><p>Start of chat</p></div>
    </div></body></html>`);

  it('reverses the newest-first list, reads the active alternative, and names the chat after the character', () => {
    const res = extractVisibleDomConversation(doc(), 'https://character.ai/chat/char_abcdef?hist=h1')!;
    expect(res.sourceConversationId).toBe('h1');
    expect(res.title).toBe('Chat with Sherlock');
    expect(turns(res)).toEqual([
      ['user', 'Hello'],
      ['assistant', 'You have been in Afghanistan.'],
      ['user', 'How did you know?'],
      ['assistant', 'Elementary.'],
    ]);
  });

  it('gives content ids that survive older messages loading at the top, and skips a reply being typed', () => {
    const a = extractVisibleDomConversation(doc(), 'https://character.ai/chat/char_abcdef?hist=h1')!;
    const b = extractVisibleDomConversation(doc(true), 'https://character.ai/chat/char_abcdef?hist=h1')!;
    expect(a.messages.every((m) => m.sourceMessageId.startsWith('h_'))).toBe(true);
    expect(b.messages.map((m) => m.sourceMessageId)).toEqual(a.messages.map((m) => m.sourceMessageId));
  });
});

describe('ChatGPT dots', () => {
  const page = (extra = '') => parse(`<html><body><div class="messaging-root">
    <header><h1>Scout</h1></header>${extra}
    <div class="message-list">
      <div class="message-row self" data-message-id="d1"><div class="message-text">Remind me to file taxes</div></div>
      <div class="message-row" data-message-id="d2"><div class="message-text">Done — Friday 9am.</div></div>
    </div></div></body></html>`);

  it('reads the messaging layout (.self is you) and names the thread after the dot when the URL has no id', () => {
    const res = extractVisibleDomConversation(page(), 'https://chatgpt.com/dots/home')!;
    expect(res.provider).toBe('chatgpt_dots');
    expect(res.sourceConversationId).toMatch(/^dotname_[0-9a-f]{8}$/);
    expect(res.title).toBe('Scout (dot)');
    expect(turns(res)).toEqual([
      ['user', 'Remind me to file taxes'],
      ['assistant', 'Done — Friday 9am.'],
    ]);
    // Same dot, same id on the next visit.
    expect(extractVisibleDomConversation(page(), 'https://chatgpt.com/dots/home')!.sourceConversationId).toBe(res.sourceConversationId);
  });

  it('prefers the dot id from its own link, then the room id', () => {
    expect(
      extractVisibleDomConversation(page('<a href="/dots/acct1~scout" aria-current="page">Scout</a>'), 'https://chatgpt.com/dots/home')!.sourceConversationId
    ).toBe('dot_acct1_scout');
    expect(extractVisibleDomConversation(page('<div data-room-id="room-9"></div>'), 'https://chatgpt.com/dots/home')!.sourceConversationId).toBe('room_room-9');
    expect(extractVisibleDomConversation(page(), 'https://chatgpt.com/dots/acct1~scout')!.sourceConversationId).toBe('dot_acct1_scout');
  });
});

describe('Grok Bot on X Chat (explicit only)', () => {
  const page = () => {
    const doc = parse(`<html><body><main><div id="host"></div></main></body></html>`);
    const host = doc.getElementById('host')!;
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `<div data-testid="dm-conversation-header">Grok Bot</div><button data-testid="dm-conversation-more-button"></button>
      <div data-testid="dm-message-scroller">
        <div data-testid="message-101" class="flex justify-end"><div data-testid="message-text-101">Ship the weekly report</div></div>
        <div data-testid="message-102" class="flex justify-start"><div data-testid="message-text-102">Report sent to the team.</div></div>
      </div>`;
    return doc;
  };

  it('never reads X Chat on its own', () => {
    expect(extractVisibleDomConversation(page(), 'https://x.com/i/chat/1234-5678')).toBeNull();
  });

  it('reads the open chat inside the shadow root when the user asks for this tab', () => {
    const res = extractVisibleDomConversation(page(), 'https://x.com/i/chat/1234-5678', { explicit: true })!;
    expect(res.provider).toBe('grok_bot');
    expect(res.sourceConversationId).toBe('1234-5678');
    expect(res.title).toBe('Grok Bot on X Chat');
    expect(turns(res)).toEqual([
      ['user', 'Ship the weekly report'],
      ['assistant', 'Report sent to the team.'],
    ]);
    expect(res.messages.map((m) => m.sourceMessageId)).toEqual(['101', '102']);
  });
});

describe('Builders, coding agents and others', () => {
  it('Lovable: umsg_ ids are yours', () => {
    const doc = parse(`<html><head><title>Todo app - Lovable</title></head><body>
      <div data-message-id="umsg_1"><div class="prose">Add dark mode</div></div>
      <div data-message-id="aimsg_2"><div class="prose"><p>Added a theme toggle.</p></div><div class="prose"><p>Updated 3 files.</p></div></div>
    </body></html>`);
    expect(turns(extractVisibleDomConversation(doc, 'https://lovable.dev/projects/p1'))).toEqual([
      ['user', 'Add dark mode'],
      ['assistant', 'Added a theme toggle.\n\nUpdated 3 files.'],
    ]);
  });

  it('Gemini Notebook: from-user / to-user containers, citation markers dropped', () => {
    const doc = parse(`<html><head><title>Thesis sources - NotebookLM</title></head><body>
      <div class="from-user-container">What do my sources say about attention?</div>
      <div class="to-user-container"><p>They agree it scales quadratically<button class="citation-marker">1</button>.</p></div>
    </body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://notebooklm.google.com/notebook/nb1')!;
    expect(res.title).toBe('Thesis sources');
    expect(turns(res)).toEqual([
      ['user', 'What do my sources say about attention?'],
      ['assistant', 'They agree it scales quadratically.'],
    ]);
  });

  it('agents without known selectors fall back to the generic readers and must settle first', () => {
    const doc = parse(`<html><head><title>Fix flaky test - Devin</title></head><body>
      <div data-message-author-role="user">Fix the flaky login test</div>
      <div data-message-author-role="assistant">Found a race in the fixture; patched it.</div>
    </body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://app.devin.ai/sessions/d1')!;
    expect(res.provider).toBe('devin');
    expect(res.title).toBe('Fix flaky test');
    expect(res.method).toBe('generic');
    expect(res.stabilize).toBe(true);
    expect(turns(res)).toEqual([
      ['user', 'Fix the flaky login test'],
      ['assistant', 'Found a race in the fixture; patched it.'],
    ]);
  });
});

describe('Added sites (any AI site)', () => {
  const site = { origin: 'http://localhost:3000' };

  it('recognises self-hosted apps by their markup', () => {
    expect(detectSelfHostedApp(parse('<div id="messages-container"></div><textarea id="chat-input"></textarea>'))).toBe('open_webui');
    expect(detectSelfHostedApp(parse('<main role="main"><div class="message-render"></div></main>'))).toBe('librechat');
    expect(detectSelfHostedApp(parse('<div class="message-wrapper" data-message-id="1"></div>'))).toBe('lobechat');
    expect(detectSelfHostedApp(parse('<title>AnythingLLM | Your personal LLM trained on anything</title><div id="chat-history"></div>'))).toBe('anythingllm');
    expect(detectSelfHostedApp(parse('<div class="chat"></div>'))).toBeNull();
  });

  it('reads Open WebUI, namespacing the id by the site so two servers never share a thread', () => {
    const doc = parse(`<html><head><title>Docker networking • Open WebUI</title></head><body><textarea id="chat-input"></textarea><div id="messages-container">
      <div id="message-u1" class="user-message"><div class="chat-user"><div class="whitespace-pre-wrap">Why can't my container reach the host?</div></div></div>
      <div id="message-a1"><div id="response-content-container"><details type="reasoning">hmm</details><p>Use host.docker.internal.</p></div></div>
    </div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'http://localhost:3000/c/2f0d6b1e-1', { site })!;
    expect(res.provider).toBe('open_webui');
    expect(res.sourceConversationId).toBe('localhost-3000~2f0d6b1e-1');
    expect(res.title).toBe('Docker networking');
    expect(turns(res)).toEqual([
      ['user', "Why can't my container reach the host?"],
      ['assistant', 'Use host.docker.internal.'],
    ]);
  });

  it('reads LibreChat turns and skips the message still being submitted', () => {
    const doc = parse(`<html><head><title>Regex help | LibreChat</title></head><body><main role="main">
      <div class="message-render"><div class="user-turn"><div class="message-content">Match an email</div></div></div>
      <div class="message-render"><div class="agent-turn"><div class="message-content">Use ^\\S+@\\S+$ as a start.</div></div></div>
      <div class="message-render"><div class="agent-turn"><div class="message-content submitting">Thinking</div></div></div>
    </main></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://chat.example.com/c/abc12345', { site: { origin: 'https://chat.example.com' } })!;
    expect(res.provider).toBe('librechat');
    expect(turns(res)).toEqual([
      ['user', 'Match an email'],
      ['assistant', 'Use ^\\S+@\\S+$ as a start.'],
    ]);
  });

  it('uses role heuristics on unknown apps and names an id-less chat by its opening message', () => {
    const doc = parse(`<html><head><title>My Bot</title></head><body>
      <div class="msg user-message">What is 2+2?</div><div class="msg bot-message">4</div></body></html>`);
    const a = extractVisibleDomConversation(doc, 'https://bot.example.org/', { site: { origin: 'https://bot.example.org' } })!;
    expect(a.provider).toBe('custom_web');
    expect(a.sourceConversationId).toMatch(/^bot\.example\.org~m_[0-9a-f]{8}$/);
    expect(a.stabilize).toBe(true);
    expect(turns(a)).toEqual([
      ['user', 'What is 2+2?'],
      ['assistant', '4'],
    ]);
    // An empty page with no id is not a conversation.
    expect(extractVisibleDomConversation(parse('<p>Welcome</p>'), 'https://bot.example.org/', { site: { origin: 'https://bot.example.org' } })).toBeNull();
  });

  it('ignores provider claims the page makes about itself', () => {
    const doc = parse(`<html data-tk-provider="chatgpt" data-tk-conversation-id="stolen"><body><div data-message-author-role="user">hi</div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://bot.example.org/c/real-1234', { site: { origin: 'https://bot.example.org' } })!;
    expect(res.provider).toBe('custom_web');
    expect(res.sourceConversationId).toBe('bot.example.org~real-1234');
  });

  it('is never read without the site context the background confirms', () => {
    const doc = parse(`<div data-message-author-role="user">hi</div>`);
    expect(extractVisibleDomConversation(doc, 'https://bot.example.org/c/real-1234')).toBeNull();
  });

  it('finds ids in common paths, query parameters and hash routes', () => {
    expect(siteConversationIdFromUrl('http://localhost:3001/workspace/team/t/thread-1')).toBe('team_thread-1');
    expect(siteConversationIdFromUrl('http://localhost:3001/workspace/team')).toBe('team_default');
    expect(siteConversationIdFromUrl('https://x.example/chat?session=s1&topic=t1')).toBe('t1');
    expect(siteConversationIdFromUrl('https://x.example/#/chat/abcd')).toBe('abcd');
    expect(siteConversationIdFromUrl('https://x.example/c/new')).toBeNull();
    expect(siteConversationIdFromUrl('https://x.example/')).toBeNull();
  });
});
