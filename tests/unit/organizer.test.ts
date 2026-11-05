import 'fake-indexeddb/auto';
import Dexie from 'dexie';
import { zipSync, strToU8 } from 'fflate';
import { describe, it, expect } from 'vitest';
import {
  buildThreadKey,
  insightKeyFor,
  verifyExtensionSummaryEvidence,
  type ConversationRecord,
  type MessageRecord,
} from '../../src/core/schema.js';
import {
  ThreadkeeperDB,
  ensureStarterCollectionsAndSettings,
  saveSettingsPatch,
  updateManualThreadFields,
  upsertThread,
  type UpsertThreadInput,
} from '../../src/core/db.js';
import {
  detectProviderFromUrl,
  extractConversationIdFromUrl,
  extractChatGptProjectSlug,
  captureMatchPatterns,
} from '../../src/core/providers.js';
import { extractVisibleDomConversation, extractReadableText } from '../../src/core/dom-capture.js';
import { parseClaudeCodeSession, parseCodexSession } from '../../src/core/cli-sessions.js';
import { detectImportKind, importFiles } from '../../src/core/importers.js';
import { analyzeThreadLocally, deriveGist, getSmartTitle, resolveInsight } from '../../src/core/insights.js';
import { LOCAL_SPACE, cosine, embedTexts, localHashEmbedding, remoteSpace } from '../../src/core/embeddings.js';
import { findMatchingProject, loadOrganizeContext, clusterThreads } from '../../src/core/auto-organize.js';
import {
  analyzeJobId,
  enqueueLibraryAnalysis,
  processThreadLocally,
  processThreadsLocally,
  runAnalysisJobs,
} from '../../src/core/pipeline.js';
import { planLibraryOrganization } from '../../src/core/library-organize.js';
import { applyOrganizeProposals, undoChangeLog } from '../../src/core/organization.js';
import { buildTranscript } from '../../src/core/ai/claude.js';
import { validateRuntimeMessageSender } from '../../src/core/messaging.js';

let dbCounter = 0;
function freshDb(): ThreadkeeperDB {
  dbCounter += 1;
  return new ThreadkeeperDB(`OrganizerTestDB_${dbCounter}_${Date.now()}`);
}

const ACCOUNT = { accountId: 'acct_test', workspaceId: 'ws_test' };

function thread(
  id: string,
  title: string,
  turns: Array<['user' | 'assistant', string]>,
  extra: Partial<UpsertThreadInput> = {}
): UpsertThreadInput {
  const provider = extra.provider ?? 'chatgpt';
  return {
    threadKey: buildThreadKey({ provider, ...ACCOUNT, sourceConversationId: id, branchId: 'main' }),
    provider,
    ...ACCOUNT,
    sourceConversationId: id,
    branchId: 'main',
    canonicalUrl: `https://chatgpt.com/c/${id}`,
    title,
    createdAt: '2026-10-20T10:00:00.000Z',
    updatedAt: new Date().toISOString(),
    coverage: 'full',
    captureSource: 'export_import',
    messages: turns.map(([role, content], i) => ({
      sourceMessageId: `${id}_m${i}`,
      role,
      content,
      createdAt: null,
    })),
    ...extra,
  };
}

/** A fetch stub that answers the Anthropic Messages API with a fixed structured output. */
function anthropicFetch(output: unknown, calls: Array<{ url: string; headers: Record<string, string>; body: any }>, status = 200) {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers: Record<string, string> = {};
    new Headers(init?.headers as HeadersInit).forEach((v, k) => (headers[k] = v));
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    calls.push({ url, headers, body });
    if (status !== 200) {
      return new Response(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(
      JSON.stringify({
        id: `msg_${calls.length}`,
        type: 'message',
        role: 'assistant',
        model: body?.model ?? 'claude-opus-5-5',
        content: [{ type: 'text', text: JSON.stringify(output) }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        stop_details: null,
        usage: { input_tokens: 1200, output_tokens: 300, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
}

describe('Providers & URL identity', () => {
  it('detects every supported product, including path-scoped Claude Code and Codex', () => {
    expect(detectProviderFromUrl('https://chatgpt.com/c/abc')).toBe('chatgpt');
    expect(detectProviderFromUrl('https://chatgpt.com/codex/tasks/task_e_123')).toBe('codex');
    expect(detectProviderFromUrl('https://claude.ai/chat/uuid-1')).toBe('claude');
    expect(detectProviderFromUrl('https://claude.ai/code/session_01ABCdef')).toBe('claude_code');
    expect(detectProviderFromUrl('https://grok.com/c/7f3a')).toBe('grok');
    expect(detectProviderFromUrl('https://gemini.google.com/app/9b1c2d')).toBe('gemini');
    expect(detectProviderFromUrl('https://www.perplexity.ai/search/how-to-x-AbC123')).toBe('perplexity');
    expect(detectProviderFromUrl('https://chat.deepseek.com/a/chat/s/1234-abcd')).toBe('deepseek');
    expect(detectProviderFromUrl('https://chat.mistral.ai/chat/55aa')).toBe('mistral');
    expect(detectProviderFromUrl('https://copilot.microsoft.com/chats/xyz789')).toBe('copilot');
    expect(detectProviderFromUrl('https://example.com/c/abc')).toBeNull();

    expect(extractConversationIdFromUrl('https://chatgpt.com/codex/tasks/task_e_123')).toBe('task_e_123');
    expect(extractConversationIdFromUrl('https://claude.ai/code/session_01ABCdef')).toBe('session_01ABCdef');
    expect(extractConversationIdFromUrl('https://chat.deepseek.com/a/chat/s/1234-abcd')).toBe('1234-abcd');
    expect(extractConversationIdFromUrl('https://gemini.google.com/app/9b1c2d')).toBe('9b1c2d');
    expect(extractConversationIdFromUrl('https://copilot.microsoft.com/chats/xyz789')).toBe('xyz789');
    expect(extractConversationIdFromUrl('https://www.perplexity.ai/search/how-to-x-AbC123')).toBe('how-to-x-AbC123');
  });

  it('reads ChatGPT Project names from project URLs and derives manifest match patterns from the registry', () => {
    expect(
      extractChatGptProjectSlug('https://chatgpt.com/g/g-p-67c1a2b3c4d5e6f-threadkeeper-launch/c/abc')
    ).toBe('Threadkeeper Launch');
    expect(extractChatGptProjectSlug('https://chatgpt.com/g/g-abc123/c/xyz')).toBeNull();
    const patterns = captureMatchPatterns();
    expect(patterns).toEqual(expect.arrayContaining(['https://claude.ai/*', 'https://grok.com/*', 'https://gemini.google.com/*']));
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});

describe('DOM capture adapters', () => {
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');

  it('captures Claude turns, skips the streaming reply, and reads the Claude Project from the header', () => {
    const doc = parse(`<!doctype html><html><head><title>Webhook retries - Claude</title></head><body>
      <nav><a href="/project/p-other">Sidebar project</a></nav>
      <header><a href="/project/p-1">Payments Platform</a></header>
      <div data-testid="user-message">Why do Stripe webhooks retry three times?</div>
      <div class="font-claude-response"><p>Stripe retries failed deliveries with exponential backoff.</p><button>Copy</button></div>
      <div data-testid="user-message">How do I make the handler idempotent?</div>
      <div data-is-streaming="true"><div class="font-claude-response">Partial answer…</div></div>
    </body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://claude.ai/chat/7a1b2c3d?foo=1')!;
    expect(res.provider).toBe('claude');
    expect(res.sourceConversationId).toBe('7a1b2c3d');
    expect(res.canonicalUrl).toBe('https://claude.ai/chat/7a1b2c3d');
    expect(res.title).toBe('Webhook retries');
    expect(res.providerProjectName).toBe('Payments Platform');
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(res.messages[1].content).not.toMatch(/Copy/);
  });

  it('captures Claude Code on the web as its own provider', () => {
    const doc = parse(`<html><head><title>Fix flaky test - Claude Code</title></head><body><main>
      <a href="https://github.com/acme/billing-service">acme/billing-service</a>
      <div data-testid="user-message">Fix the flaky invoice test</div>
      <div class="font-claude-response">I found a race in the clock mock.</div></main></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://claude.ai/code/session_011CUabc')!;
    expect(res.provider).toBe('claude_code');
    expect(res.sourceConversationId).toBe('session_011CUabc');
    expect(res.providerProjectName).toBe('billing-service');
    expect(res.messages).toHaveLength(2);
  });

  it('captures ChatGPT model slug, project slug and fenced code without "Copy code" chrome', () => {
    const doc = parse(`<html><head><title>Parse CSV - ChatGPT</title></head><body>
      <div data-message-author-role="user" data-message-id="u1"><div class="whitespace-pre-wrap">Parse this CSV in Python</div></div>
      <div data-message-author-role="assistant" data-message-id="a1" data-message-model-slug="gpt-5">
        <div class="markdown"><p>Use the csv module:</p><pre><div>python<button>Copy code</button></div><code class="language-python">import csv\nrows = list(csv.reader(f))</code></pre></div>
      </div></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://chatgpt.com/g/g-p-6a7b8c9d-data-tools/c/conv1')!;
    expect(res.modelSlug).toBe('gpt-5');
    expect(res.providerProjectName).toBe('Data Tools');
    expect(res.messages[1].content).toContain('```python\nimport csv');
    expect(res.messages[1].content).not.toContain('Copy code');
  });

  it('captures Grok, Gemini, Copilot and DeepSeek markup', () => {
    const grok = extractVisibleDomConversation(
      parse(`<html><head><title>Rocket math - Grok</title></head><body>
        <div id="response-1" class="flex items-end"><div class="message-bubble">What is delta-v?</div></div>
        <div id="response-2" class="flex items-start"><div class="message-bubble">Delta-v is the change in velocity.</div></div></body></html>`),
      'https://grok.com/c/abc-123'
    )!;
    expect(grok.provider).toBe('grok');
    expect(grok.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    const gemini = extractVisibleDomConversation(
      parse(`<html><head><title>Gemini</title></head><body>
        <user-query><div class="query-text">Plan a 3 day Lisbon trip</div></user-query>
        <model-response><message-content><p>Day 1: Alfama.</p></message-content></model-response></body></html>`),
      'https://gemini.google.com/app/f00d'
    )!;
    expect(gemini.provider).toBe('gemini');
    expect(gemini.title).toBe('Plan a 3 day Lisbon trip');
    expect(gemini.messages).toHaveLength(2);

    const copilot = extractVisibleDomConversation(
      parse(`<html><head><title>Copilot</title></head><body>
        <div data-content="user-message">Summarize this memo</div>
        <div data-content="ai-message">The memo proposes a hiring freeze.</div></body></html>`),
      'https://copilot.microsoft.com/chats/c1'
    )!;
    expect(copilot.messages.map((m) => m.role)).toEqual(['user', 'assistant']);

    const deepseek = extractVisibleDomConversation(
      parse(`<html><head><title>Sorting - DeepSeek</title></head><body>
        <div class="ds-message">Which sort is stable?</div>
        <div class="ds-message"><div class="ds-markdown">Merge sort is stable.</div></div></body></html>`),
      'https://chat.deepseek.com/a/chat/s/77'
    )!;
    expect(deepseek.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('falls back to role heuristics when a site ships unknown markup', () => {
    const doc = parse(`<html><head><title>Le Chat</title></head><body><main>
      <div class="msg user-message">Draft a polite follow-up email</div>
      <div class="msg assistant-message">Here is a short follow-up email.</div></main></body></html>`);
    const res = extractVisibleDomConversation(doc, 'https://chat.mistral.ai/chat/m1')!;
    expect(res.provider).toBe('mistral');
    expect(res.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
  });

  it('extracts readable text with list structure', () => {
    const el = parse('<div><p>Steps:</p><ul><li>One</li><li>Two</li></ul><span class="sr-only">You said:</span></div>').body.firstElementChild!;
    expect(extractReadableText(el)).toBe('Steps:\n\n- One\n\n- Two');
  });
});

describe('Claude Code and Codex CLI sessions', () => {
  const claudeCodeJsonl = [
    { type: 'summary', summary: 'Fix flaky invoice test', leafUuid: 'a3' },
    { type: 'user', sessionId: 's-1', cwd: '/Users/me/code/billing-service', gitBranch: 'fix/flaky', uuid: 'u0', isMeta: true, timestamp: '2026-10-01T10:00:00Z', message: { role: 'user', content: 'Caveat: The messages below were generated by the user while running local commands.' } },
    { type: 'user', sessionId: 's-1', cwd: '/Users/me/code/billing-service', uuid: 'u1', timestamp: '2026-10-01T10:00:01Z', message: { role: 'user', content: 'The invoice test fails randomly. Find out why.' } },
    { type: 'assistant', sessionId: 's-1', uuid: 'a1', timestamp: '2026-10-01T10:00:05Z', message: { id: 'msg_A', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'Let me look at the test.' }] } },
    { type: 'assistant', sessionId: 's-1', uuid: 'a2', timestamp: '2026-10-01T10:00:06Z', message: { id: 'msg_A', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'npm test -- invoice' } }] } },
    { type: 'user', sessionId: 's-1', uuid: 'u2', timestamp: '2026-10-01T10:00:09Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: '1 failing: expected 2026-10-01 got 2026-09-30' }] } },
    { type: 'assistant', sessionId: 's-1', uuid: 'a3', timestamp: '2026-10-01T10:00:12Z', message: { id: 'msg_B', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'text', text: 'The clock mock is timezone dependent; I pinned it to UTC.' }] } },
    { type: 'user', sessionId: 's-1', uuid: 'u3', isSidechain: true, timestamp: '2026-10-01T10:00:13Z', message: { role: 'user', content: 'subagent chatter' } },
  ]
    .map((r) => JSON.stringify(r))
    .join('\n');

  it('parses a Claude Code transcript into a thread with repo project, branch and resume command', () => {
    const t = parseClaudeCodeSession(claudeCodeJsonl, { ...ACCOUNT, fileName: 's-1.jsonl' })!;
    expect(t.provider).toBe('claude_code');
    expect(t.title).toBe('Fix flaky invoice test');
    expect(t.providerProjectName).toBe('billing-service');
    expect(t.gitBranch).toBe('fix/flaky');
    expect(t.modelSlug).toBe('claude-opus-5-5');
    expect(t.resumeCommand).toBe('cd /Users/me/code/billing-service && claude --resume s-1');
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant']);
    expect(t.messages[2].content).toContain('[tool] Bash: npm test -- invoice');
    expect(t.messages[2].content).toContain('[tool result] 1 failing');
    expect(t.messages.some((m) => m.content.includes('subagent'))).toBe(false);
    expect(new Set(t.messages.map((m) => m.sourceMessageId)).size).toBe(t.messages.length);
  });

  it('parses modern and legacy Codex rollouts', () => {
    const modern = [
      { timestamp: '2026-10-02T09:00:00Z', type: 'session_meta', payload: { id: '0199a-uuid', cwd: '/home/me/api', git: { branch: 'main', repository_url: 'git@github.com:acme/orders-api.git' } } },
      { timestamp: '2026-10-02T09:00:01Z', type: 'turn_context', payload: { model: 'gpt-5-codex', cwd: '/home/me/api' } },
      { timestamp: '2026-10-02T09:00:01Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
      { timestamp: '2026-10-02T09:00:02Z', type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Add pagination to GET /orders' }] } },
      { timestamp: '2026-10-02T09:00:03Z', type: 'response_item', payload: { type: 'function_call', name: 'shell', arguments: '{"command":["bash","-lc","rg orders"]}' } },
      { timestamp: '2026-10-02T09:00:04Z', type: 'response_item', payload: { type: 'function_call_output', output: '{"output":"src/orders.ts"}' } },
      { timestamp: '2026-10-02T09:00:09Z', type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Added cursor pagination.' }] } },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const t = parseCodexSession(modern, { ...ACCOUNT, fileName: 'rollout-2026-10-02T09-00-00-0199a-uuid.jsonl' })!;
    expect(t.provider).toBe('codex');
    expect(t.sourceConversationId).toBe('0199a-uuid');
    expect(t.providerProjectName).toBe('orders-api');
    expect(t.modelSlug).toBe('gpt-5-codex');
    expect(t.title).toBe('Add pagination to GET /orders');
    expect(t.messages.map((m) => m.role)).toEqual(['user', 'tool', 'assistant']);
    expect(t.resumeCommand).toContain('codex resume 0199a-uuid');

    const legacy = [
      { id: 'legacy-1', timestamp: '2025-08-01T00:00:00Z', instructions: null },
      { record_type: 'state' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Explain this regex' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'It matches ISO dates.' }] },
    ]
      .map((r) => JSON.stringify(r))
      .join('\n');
    const l = parseCodexSession(legacy, ACCOUNT)!;
    expect(l.sourceConversationId).toBe('legacy-1');
    expect(l.messages).toHaveLength(2);
  });

  it('detects formats and imports a zipped ChatGPT export plus a session file, organizing as it lands', async () => {
    expect(detectImportKind('s.jsonl', claudeCodeJsonl)).toBe('claude_code');
    expect(detectImportKind('c.json', JSON.stringify([{ uuid: 'x', chat_messages: [] }]))).toBe('claude');
    expect(detectImportKind('p.json', JSON.stringify({ format: 'threadkeeper-portable-v1', conversations: [] }))).toBe('portable');

    const db = freshDb();
    const settings = await ensureStarterCollectionsAndSettings(db);
    const chatgpt = [
      {
        id: 'cg-1',
        title: 'HypeStake odds feed latency',
        create_time: 1760000000,
        update_time: 1760000500,
        current_node: 'n2',
        mapping: {
          n1: { id: 'n1', parent: null, children: ['n2'], message: { id: 'n1', author: { role: 'user' }, content: { parts: ['Our sportsbook odds feed lags 4 seconds behind. How do we cut latency?'] } } },
          n2: { id: 'n2', parent: 'n1', children: [], message: { id: 'n2', author: { role: 'assistant' }, content: { parts: ['Switch the odds feed to websockets and cache prices at the edge.'] } } },
        },
      },
    ];
    const zip = zipSync({ 'conversations.json': strToU8(JSON.stringify(chatgpt)), 'user.json': strToU8('{}') });
    const report = await importFiles(db, settings, [
      { name: 'chatgpt-export.zip', bytes: zip },
      { name: 's-1.jsonl', text: claudeCodeJsonl },
    ]);
    expect(report.imported).toBe(2);
    expect(report.byKind).toEqual({ chatgpt: 1, claude_code: 1 });

    const cg = await db.conversations.get(report.threadKeys[0]);
    expect(cg?.project).toBe('HypeStake');
    expect(cg?.projectSource).toBe('rules');
    const cc = await db.conversations.get(report.threadKeys[1]);
    expect(cc?.project).toBe('billing-service');
    expect(cc?.projectSource).toBe('provider');
    expect(await db.collections.get('billing-service')).toMatchObject({ origin: 'provider' });
    expect(await db.insights.get(insightKeyFor('local', report.threadKeys[1]))).toBeDefined();
  });
});

describe('On-device analysis', () => {
  const conv = (title: string, provider: ConversationRecord['provider'] = 'chatgpt', updatedAt = new Date().toISOString()) =>
    ({
      threadKey: 't1',
      provider,
      title,
      manualTitleOverride: null,
      updatedAt,
      lastCapturedAt: updatedAt,
      sourceRevision: 3,
      contentHash: 'h',
    }) as ConversationRecord;
  const msgs = (turns: Array<['user' | 'assistant', string]>): MessageRecord[] =>
    turns.map(([role, content], i) => ({
      messageKey: `t1:m:${i}`,
      threadKey: 't1',
      ordinal: i,
      sourceMessageId: `m${i}`,
      role,
      content,
      createdAt: null,
      contentHash: '',
      hasCode: /```/.test(content),
      hasArtifact: false,
      branchPath: 'main',
    }));

  it('derives a gist, kind, topics, grounded decisions, next steps and a done status', () => {
    const messages = msgs([
      ['user', "Hey Claude, can you help me fix this TypeError: cannot read properties of undefined in checkout.tsx? It crashes when the cart is empty."],
      ['assistant', 'The crash happens because `cart.items` is undefined before the fetch resolves.\n\n```tsx\nconst items = cart?.items ?? [];\n```\n\nNext steps:\n- Add a loading state to checkout.tsx\n- Write a unit test for the empty cart case'],
      ['user', "Let's go with the optional chaining fix and keep the loading state."],
      ['assistant', 'Great. I recommend also logging the empty-cart path. Would you like me to write the test?'],
      ['user', 'Thanks, that worked!'],
    ]);
    const { insight, summary } = analyzeThreadLocally(conv('New chat'), messages);
    expect(insight.gist).toMatch(/^Fix this TypeError/);
    expect(insight.title).toMatch(/^Fix this TypeError/);
    expect(insight.kind).toBe('debugging');
    expect(insight.suggestedStatus).toBe('done');
    expect(insight.artifacts.map((a) => a.label)).toContain('checkout.tsx');
    expect(insight.languages).toContain('typescript');
    expect(summary!.decisions.some((d) => d.speaker === 'user_committed' && /optional chaining/.test(d.text))).toBe(true);
    expect(summary!.actionItems.some((a) => /loading state/.test(a.text))).toBe(true);
    const verified = verifyExtensionSummaryEvidence(
      summary!,
      messages.map((m) => ({ index: m.ordinal, role: m.role, content: m.content }))
    );
    expect(verified.errors).toEqual([]);
  });

  it('only treats a genuine wrap-up as done', () => {
    const statusAfter = (last: string) =>
      analyzeThreadLocally(
        conv('Login bug'),
        msgs([['user', 'Login fails with a 500 error'], ['assistant', 'Clear the stale session cookie.'], ['user', last]])
      ).insight.suggestedStatus;
    expect(statusAfter('Perfect, that worked!')).toBe('done');
    expect(statusAfter('thanks')).toBe('done');
    expect(statusAfter("Thanks, but it still doesn't work.")).not.toBe('done');
    expect(statusAfter('Thank you! Now how do I add tests?')).not.toBe('done');
    expect(statusAfter('Thanks. Can you also add logging?')).not.toBe('done');
  });

  it('flags threads waiting on the user and old threads as paused', () => {
    const waiting = analyzeThreadLocally(
      conv('Pricing page'),
      msgs([
        ['user', 'Draft three pricing tiers for a B2B analytics tool'],
        ['assistant', 'Here are Starter, Team and Enterprise tiers. Would you like me to add annual discounts?'],
      ])
    );
    expect(waiting.insight.suggestedStatus).toBe('needs_review');
    expect(waiting.summary!.openQuestions[0].speaker).toBe('assistant_suggested');
    const old = analyzeThreadLocally(
      conv('Garden plan', 'chatgpt', '2026-01-01T00:00:00.000Z'),
      msgs([['user', 'Which vegetables grow well in shade?'], ['assistant', 'Lettuce, kale and spinach tolerate shade.']])
    );
    expect(old.insight.suggestedStatus).toBe('paused');
    expect(deriveGist('Hi! Could you please summarize this contract for me?')).toBe('Summarize this contract for me');
  });

  it('prefers a current AI insight, merges a stale one with fresh local details, and keeps real titles', () => {
    const c = conv('Q3 board deck');
    const local = analyzeThreadLocally(c, msgs([['user', 'Outline the Q3 board deck'], ['assistant', 'Here is an outline.']])).insight;
    const ai = { ...local, source: 'ai' as const, title: 'Q3 board deck outline: growth, burn, hiring', gist: 'AI gist', sourceRevision: 2 };
    expect(resolveInsight(c, local, { ...ai, sourceRevision: 3 })?.gist).toBe('AI gist');
    const merged = resolveInsight(c, local, ai)!;
    expect(merged.gist).toBe('AI gist');
    expect(merged.lastUserAsk).toBe(local.lastUserAsk);
    expect(getSmartTitle(c, merged)).toBe('Q3 board deck');
    expect(getSmartTitle(conv('New chat'), merged)).toBe('Q3 board deck outline: growth, burn, hiring');
    // A title that is just the opening message yields to Claude's title, but not to a local one.
    const rawTitle = conv('Plan a 3 day trip to Lisbon in March with food recommendations');
    expect(getSmartTitle(rawTitle, { ...merged, title: 'Lisbon 3-day itinerary' })).toBe('Lisbon 3-day itinerary');
    expect(getSmartTitle(rawTitle, { ...local, title: 'Lisbon 3-day itinerary' })).toBe(rawTitle.title);
  });
});

describe('Embeddings', () => {
  it('produces normalized local vectors where related text is closer than unrelated text', () => {
    const a = localHashEmbedding('stripe webhook retries idempotency key payment handler');
    const b = localHashEmbedding('make the stripe webhook handler idempotent so payment retries are safe');
    const c = localHashEmbedding('sourdough starter hydration and baking schedule');
    expect(a).toHaveLength(384);
    expect(Math.abs(cosine(a, a) - 1)).toBeLessThan(1e-3);
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c) + 0.2);
  });

  it('calls Voyage, OpenAI and Ollama with their documented request shapes', async () => {
    const db = freshDb();
    const base = await ensureStarterCollectionsAndSettings(db);
    const seen: Array<{ url: string; body: any; auth: string | null }> = [];
    const fetchStub = (async (url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      seen.push({ url, body, auth: new Headers(init.headers).get('authorization') });
      const n = body.input.length;
      const data = url.includes('/api/embed')
        ? { embeddings: Array.from({ length: n }, () => [0.1, 0.2]) }
        : { data: Array.from({ length: n }, (_, index) => ({ index, embedding: [0.3, 0.4] })) };
      return new Response(JSON.stringify(data), { status: 200 });
    }) as unknown as typeof fetch;

    const voyage = { ...base, embeddingProvider: 'voyage' as const, voyageApiKey: 'pa-test' };
    const vs = remoteSpace(voyage)!;
    expect(vs.id).toBe('voyage:mongodb:voyage-4-lite');
    await embedTexts(voyage, vs, ['a', 'b'], 'document', fetchStub);
    expect(seen[0]).toMatchObject({ url: 'https://ai.mongodb.com/v1/embeddings', auth: 'Bearer pa-test' });
    expect(seen[0].body).toMatchObject({ model: 'voyage-4-lite', input_type: 'document', input: ['a', 'b'] });

    const openai = { ...base, embeddingProvider: 'openai' as const, openaiApiKey: 'sk-test' };
    await embedTexts(openai, remoteSpace(openai)!, ['q'], 'query', fetchStub);
    expect(seen[1]).toMatchObject({ url: 'https://api.openai.com/v1/embeddings' });
    expect(seen[1].body.model).toBe('text-embedding-3-small');

    const ollama = { ...base, embeddingProvider: 'ollama' as const };
    const [vec] = await embedTexts(ollama, remoteSpace(ollama)!, ['q'], 'query', fetchStub);
    expect(seen[2].url).toBe('http://localhost:11434/api/embed');
    expect(vec).toEqual([0.1, 0.2]);
  });
});

describe('Automatic organization', () => {
  it('matches provider and AI project names to existing projects', async () => {
    const db = freshDb();
    await ensureStarterCollectionsAndSettings(db);
    const cols = await db.collections.toArray();
    expect(findMatchingProject('daydock', cols)?.name).toBe('Daydock / Meridian');
    expect(findMatchingProject('hypestake-web', cols)?.name).toBe('HypeStake');
    expect(findMatchingProject('Velotic', cols)?.name).toBe('Velotic / FrameConcepts');
    expect(findMatchingProject('totally-new-repo', cols)).toBeNull();
  });

  it('files by similarity to confidently filed threads, never touches manual or locked threads, and does not downgrade', async () => {
    const db = freshDb();
    await ensureStarterCollectionsAndSettings(db);
    await db.collections.put({ name: 'Garden', description: '', isStarterArea: false, cloudExcluded: false, createdAt: '', keywords: [], origin: 'user' });
    const garden = [
      ['g1', 'Tomato blight treatment', 'My tomato plants have blight spots on the leaves, how do I treat tomato blight organically?'],
      ['g2', 'Raised bed soil mix', 'What soil mix should I use for raised garden beds with tomato and pepper plants?'],
      ['g3', 'Watering schedule for tomatoes', 'How often should I water tomato plants in raised beds during summer heat?'],
    ];
    for (const [id, title, text] of garden) {
      const t = thread(id, title, [['user', text], ['assistant', 'Use compost, mulch and water the tomato plants deeply at the soil line.']]);
      await upsertThread(db, t);
      await updateManualThreadFields(db, t.threadKey, { project: 'Garden' });
    }
    await processThreadsLocally(db, garden.map(([id]) => buildThreadKey({ provider: 'chatgpt', ...ACCOUNT, sourceConversationId: id, branchId: 'main' })));

    const newcomer = thread('g4', 'Pepper plants yellow leaves', [
      ['user', 'My pepper and tomato plants in the raised bed have yellow leaves. Soil or watering problem?'],
      ['assistant', 'Yellow leaves on tomato and pepper plants usually mean overwatering or low nitrogen in the soil.'],
    ]);
    await upsertThread(db, newcomer);
    await processThreadLocally(db, newcomer.threadKey);
    const filed = await db.conversations.get(newcomer.threadKey);
    expect(filed?.project).toBe('Garden');
    expect(filed?.projectSource).toBe('similar');
    expect(filed?.projectReason).toMatch(/Similar to \d threads? already in Garden/);

    // Manual assignment is final.
    await updateManualThreadFields(db, newcomer.threadKey, { project: 'Personal', categoryLocked: false });
    await processThreadLocally(db, newcomer.threadKey, { force: true });
    expect((await db.conversations.get(newcomer.threadKey))?.project).toBe('Personal');

    // A provider project (strong signal) is not overridden by a weaker keyword match later.
    const repo = thread('r1', 'HypeStake landing copy', [['user', 'Write hero copy for the HypeStake landing page'], ['assistant', 'Here is hero copy.']], {
      providerProjectName: 'marketing-site',
    });
    await upsertThread(db, repo);
    await processThreadLocally(db, repo.threadKey);
    const repoConv = await db.conversations.get(repo.threadKey);
    expect(repoConv?.project).toBe('marketing-site');
    expect(repoConv?.projectSource).toBe('provider');
  });

  it('sets status automatically but respects a status the user chose', async () => {
    const db = freshDb();
    await ensureStarterCollectionsAndSettings(db);
    const t = thread('s1', 'Fix login bug', [['user', 'Login fails with 500'], ['assistant', 'Clear the stale session cookie.'], ['user', 'Thanks, that worked!']]);
    await upsertThread(db, t);
    await processThreadLocally(db, t.threadKey);
    expect((await db.conversations.get(t.threadKey))?.workflowState).toBe('done');
    await updateManualThreadFields(db, t.threadKey, { workflowState: 'needs_review' });
    await processThreadLocally(db, t.threadKey, { force: true });
    expect((await db.conversations.get(t.threadKey))?.workflowState).toBe('needs_review');
  });

  it('clusters unfiled threads into proposed projects and applies them with a full undo', async () => {
    const db = freshDb();
    await ensureStarterCollectionsAndSettings(db);
    await saveSettingsPatch(db, { autoOrganize: { ...(await ensureStarterCollectionsAndSettings(db)).autoOrganize, autoFile: false } });
    const topics = [
      ['k1', 'Kubernetes ingress timeouts', 'Our kubernetes ingress returns 504 timeouts under load; nginx ingress controller config?'],
      ['k2', 'Kubernetes pod autoscaling', 'How should I configure kubernetes horizontal pod autoscaling for the nginx ingress pods?'],
      ['k3', 'Kubernetes ingress TLS', 'Set up TLS certificates for the kubernetes nginx ingress controller with cert-manager.'],
      ['x1', 'Birthday gift ideas', 'Gift ideas for my sister who loves hiking'],
    ];
    for (const [id, title, text] of topics) {
      await upsertThread(db, thread(id, title, [['user', text], ['assistant', `Answer about ${title.toLowerCase()} and the details you asked for.`]]));
    }
    await processThreadsLocally(db, (await db.conversations.toArray()).map((c) => c.threadKey));
    const plan = await planLibraryOrganization(db, { preferAi: false });
    expect(plan.mode).toBe('local');
    const clustered = plan.proposals.filter((p) => p.source === 'cluster');
    expect(clustered.map((p) => p.title).sort()).toEqual(['Kubernetes ingress TLS', 'Kubernetes ingress timeouts', 'Kubernetes pod autoscaling']);
    const projectName = clustered[0].proposedProject!;
    expect(projectName.toLowerCase()).toContain('kubernetes');

    const entry = await applyOrganizeProposals(db, 'auto', plan.proposals);
    expect(await db.collections.get(projectName)).toBeDefined();
    expect((await db.conversations.toArray()).filter((c) => c.project === projectName)).toHaveLength(3);
    await undoChangeLog(db, entry.changeId);
    expect(await db.collections.get(projectName)).toBeUndefined();
    expect((await db.conversations.toArray()).every((c) => c.project === 'Unfiled / Uncertain')).toBe(true);
  });

  it('clusterThreads requires a minimum cluster size', () => {
    const v = localHashEmbedding('alpha beta gamma');
    const out = clusterThreads(
      [
        { threadKey: 'a', embedding: v, topics: ['alpha'] },
        { threadKey: 'b', embedding: v, topics: ['alpha'] },
      ],
      [],
      0.3
    );
    expect(out).toEqual([]);
  });
});

describe('Claude analysis pipeline (mocked Anthropic API)', () => {
  const analysis = {
    title: 'Stripe webhook idempotency for the orders service',
    gist: 'Stripe webhook handler made idempotent with an event-id table; replay test still to write.',
    overview: [
      'Duplicate order charges came from Stripe retrying the same webhook event.',
      'You chose to store processed event ids in a table and skip duplicates.\n\nThe replay test is still to be written.',
    ],
    userGoal: 'Stop duplicate order charges',
    outcome: null,
    kind: 'debugging',
    topics: ['Stripe Webhooks', 'idempotency'],
    entities: ['Stripe', 'orders-service'],
    project: { name: 'Payments', isNew: true, confidence: 0.86, reason: 'Ongoing payments workstream' },
    status: 'active',
    statusReason: 'Tests still to write',
    keyPoints: [
      { text: 'Stripe retries resend the same event id', messageNumber: 2, quote: 'Retries resend the same event', by: 'assistant', rationale: null },
      { text: 'Invented key point', messageNumber: 1, quote: 'not in any message at all', by: 'user', rationale: null },
    ],
    whereYouLeftOff: {
      text: 'The dedupe table was agreed and the handler updated.',
      nextStep: 'Write the duplicate-delivery replay test.',
      messageNumber: 4,
      quote: 'write a test that replays the same event',
    },
    decisions: [
      {
        text: 'Use an idempotency table keyed by event id',
        messageNumber: 3,
        quote: 'store processed event ids in a table',
        by: 'user',
        rationale: 'so a retried event is skipped instead of charged again',
      },
    ],
    actionItems: [{ text: 'Write the replay test', messageNumber: 4, quote: 'write a test that replays the same event', by: 'assistant', rationale: 'ignored outside decisions' }],
    openQuestions: [{ text: 'Hallucinated question', messageNumber: 2, quote: 'this quote does not exist anywhere', by: 'user', rationale: null }],
    produced: [{ label: 'webhooks.ts', kind: 'code', description: 'Webhook handler that skips processed event ids', messageNumber: 2 }],
  };

  async function seed(db: ThreadkeeperDB, key = 'sk-ant-test') {
    const settings = await ensureStarterCollectionsAndSettings(db);
    await saveSettingsPatch(db, { anthropicApiKey: key, autoOrganize: { ...settings.autoOrganize, aiDebounceSeconds: 0 } });
    const t = thread('pay-1', 'Webhook duplicates', [
      ['user', 'Customers get charged twice when Stripe retries the webhook.'],
      ['assistant', 'Retries resend the same event. Check webhooks.ts for the handler.'],
      ['user', 'OK, store processed event ids in a table and skip duplicates.'],
      ['assistant', 'Done. Next, write a test that replays the same event twice.'],
    ]);
    await upsertThread(db, t);
    return t;
  }

  it('never sends tags that come from local-only threads to Claude', async () => {
    const db = freshDb();
    const t = await seed(db);
    await upsertThread(db, {
      ...thread('secret-1', 'Board prep', [['user', 'Draft talking points for the acquisition.']]),
      tags: ['secret-merger-codename'],
      cloudExcluded: true,
    });
    await upsertThread(db, { ...thread('open-1', 'Retry policy', [['user', 'How long should webhook retries back off?']]), tags: ['retry-policy'] });
    await processThreadLocally(db, t.threadKey);

    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    await runAnalysisJobs(db, { fetchImpl: anthropicFetch(analysis, calls) });
    const sent = JSON.stringify(calls[0].body);
    expect(sent).toContain('retry-policy');
    expect(sent).not.toContain('secret-merger-codename');
  });

  it('queues analysis on capture, calls Claude with structured output + refusal fallback, and files with the stronger signal', async () => {
    const db = freshDb();
    const t = await seed(db);
    const local = await processThreadLocally(db, t.threadKey);
    expect(local.enqueued).toBe(true);
    expect((await db.jobs.get(analyzeJobId(t.threadKey)))?.status).toBe('pending');

    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const summary = await runAnalysisJobs(db, { fetchImpl: anthropicFetch(analysis, calls) });
    expect(summary).toMatchObject({ processed: 1, analyzed: 1, failed: 0 });

    const req = calls[0];
    expect(req.url).toContain('https://api.anthropic.com/v1/messages');
    expect(req.headers['authorization']).toBe('Bearer sk-ant-test');
    expect(req.headers['anthropic-dangerous-direct-browser-access']).toBe('true');
    expect(req.headers['anthropic-beta']).toContain('server-side-fallback-2026-07-01');
    expect(req.body.model).toBe('claude-opus-5-5');
    expect(req.body.fallbacks).toBe('default');
    expect(req.body.thinking).toBeUndefined();
    expect(req.body.output_config.effort).toBe('medium'); // analysis runs at Medium at least (aiEffort is 'low')
    expect(req.body.output_config.format.type).toBe('json_schema');
    expect(req.body.system[1].cache_control).toEqual({ type: 'ephemeral' });
    expect(req.body.messages[0].content).toContain('[m3 · user]');

    const ai = await db.insights.get(insightKeyFor('ai', t.threadKey));
    expect(ai).toMatchObject({ source: 'ai', title: analysis.title, kind: 'debugging' });
    expect(ai!.topics).toEqual(['stripe-webhooks', 'idempotency']);
    const stored = await db.summaries.get(t.threadKey);
    expect(stored?.model).toBe('claude-opus-5-5');
    expect(stored?.decisions).toHaveLength(1);
    expect(stored?.decisions[0].messageIndexes).toEqual([2]);
    expect(stored?.openQuestions).toHaveLength(0); // ungrounded item dropped, rest kept
    const conv = await db.conversations.get(t.threadKey);
    expect(conv?.project).toBe('Payments');
    expect(conv?.projectSource).toBe('ai');
    expect(await db.collections.get('Payments')).toMatchObject({ origin: 'auto' });
    expect((await db.jobs.get(analyzeJobId(t.threadKey)))?.status).toBe('completed');
  });

  it('pauses on an invalid key without burning retries, and honours the daily limit', async () => {
    const db = freshDb();
    const t = await seed(db, 'sk-ant-bad');
    await processThreadLocally(db, t.threadKey);
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const res = await runAnalysisJobs(db, { fetchImpl: anthropicFetch(analysis, calls, 401) });
    expect(res.stoppedReason).toMatch(/rejected the API key/);
    const job = await db.jobs.get(analyzeJobId(t.threadKey));
    expect(job?.status).toBe('pending');
    expect(job?.attempts).toBe(0);
    expect((await ensureStarterCollectionsAndSettings(db)).lastAiError).toMatch(/API key/);
    expect((await ensureStarterCollectionsAndSettings(db)).aiAnalysesToday).toBe(0); // failed call refunded its slot

    const db2 = freshDb();
    const t2 = await seed(db2);
    const s2 = await ensureStarterCollectionsAndSettings(db2);
    await saveSettingsPatch(db2, { autoOrganize: { ...s2.autoOrganize, dailyAiAnalysisLimit: 1 }, aiAnalysesToday: 1, aiAnalysesDate: new Date().toISOString().slice(0, 10) });
    await processThreadLocally(db2, t2.threadKey);
    const limited = await runAnalysisJobs(db2, { fetchImpl: anthropicFetch(analysis, []) });
    expect(limited.stoppedReason).toMatch(/Daily AI analysis limit/);
    expect((await db2.jobs.get(analyzeJobId(t2.threadKey)))?.status).toBe('pending');
  });

  it('never sends local-only threads or local-only projects to Claude', async () => {
    const db = freshDb();
    const t = await seed(db);
    await updateManualThreadFields(db, t.threadKey, { cloudExcluded: true });
    const r = await processThreadLocally(db, t.threadKey);
    expect(r.enqueued).toBe(false);
    expect(await enqueueLibraryAnalysis(db)).toBe(0);
  });

  it('plans library organization with Claude and maps thread numbers back to threads', async () => {
    const db = freshDb();
    const t = await seed(db);
    await processThreadLocally(db, t.threadKey);
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    const plan = await planLibraryOrganization(db, {
      instruction: 'Put payment threads in a Payments project',
      fetchImpl: anthropicFetch(
        {
          newProjects: [{ name: 'Payments', description: 'Billing and payments', keywords: ['stripe', 'billing'] }],
          changes: [{ thread: 1, project: 'Payments', addTags: ['billing'], status: null, reason: 'About Stripe charges' }],
          excluded: [],
        },
        calls
      ),
    });
    expect(plan.mode).toBe('ai');
    expect(plan.proposals).toHaveLength(1);
    expect(plan.proposals[0]).toMatchObject({ threadKey: t.threadKey, proposedProject: 'Payments', source: 'manual' });
    expect(plan.proposals[0].newProject?.keywords).toEqual(['stripe', 'billing']);
    expect(calls[0].body.messages[0].content).toContain('[T1] Webhook duplicates');
  });

  it('keeps the opening and the latest turns when a transcript exceeds the budget', () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ ordinal: i, role: i % 2 ? 'assistant' : 'user', content: `message ${i} `.repeat(200) }));
    const t = buildTranscript(many, 20_000);
    expect(t.omitted).toBeGreaterThan(0);
    expect(t.text).toContain('[m1 · user]');
    expect(t.text).toContain('[m50 · assistant]');
    expect(t.text).toContain('middle messages omitted');
  });
});

describe('Migration and messaging', () => {
  it('upgrades a v1 database: capture on for every provider, provenance backfilled', async () => {
    const name = `MigrationDB_${Date.now()}`;
    const v1 = new Dexie(name);
    v1.version(1).stores({
      conversations: 'threadKey, provider, accountId, workspaceId, sourceConversationId, project, workflowState, coverage, updatedAt, isSyntheticBenchmark',
      messages: 'messageKey, threadKey, ordinal, sourceMessageId',
      chunks: 'chunkKey, threadKey, chunkIndex',
      vectors: 'vectorKey, [indexType+model+dimensions], threadKey, chunkKey, accountId, workspaceId, provider',
      summaries: 'threadKey, sourceRevision',
      relationships: 'relationshipKey, fromThreadKey, toThreadKey, relationType',
      collections: 'name, isStarterArea',
      tags: 'canonicalName',
      jobs: 'jobId, status, threadKey, jobType',
      changeLogs: 'changeId, createdAt, undone',
      tombstones: 'threadKey, [provider+sourceConversationId+branchId], deletedAt',
      settings: 'id',
    });
    await v1.open();
    await v1.table('settings').put({
      id: 'default',
      authorizedHosts: { chatgpt: false, claude: false },
      boundAccounts: { chatgpt: { accountId: 'a', workspaceId: 'w' }, claude: { accountId: 'b', workspaceId: 'w' }, imported: { accountId: 'c', workspaceId: 'w' } },
      theme: 'dark',
    });
    await v1.table('conversations').put({ threadKey: 'k1', project: 'HypeStake', categoryLocked: false, workflowState: 'waiting' });
    v1.close();

    const db = new ThreadkeeperDB(name);
    const settings = await ensureStarterCollectionsAndSettings(db);
    expect(settings.authorizedHosts.claude).toBe(true);
    expect(settings.authorizedHosts.grok).toBe(true);
    expect(settings.boundAccounts.chatgpt.accountId).toBe('a');
    expect(settings.boundAccounts.codex.accountId).toBe('acct_codex_primary');
    expect(settings.theme).toBe('dark');
    expect(settings.aiModel).toBe('claude-opus-5-5');
    const conv = await db.conversations.get('k1');
    expect(conv?.projectSource).toBe('import');
    expect(conv?.workflowStateSource).toBe('manual');
  });

  it('accepts privileged messages from the side panel and the new content-script messages', () => {
    const id = 'abcdefghijklmnopabcdefghijklmnop';
    expect(
      validateRuntimeMessageSender({ type: 'SETTINGS_CHANGED' }, { id, url: `chrome-extension://${id}/sidepanel.html` }, id).allowed
    ).toBe(true);
    expect(
      validateRuntimeMessageSender({ type: 'RUN_ANALYSIS_NOW' }, { id, url: 'https://claude.ai/chat/x', tab: { id: 1 } }, id).allowed
    ).toBe(false);
    expect(
      validateRuntimeMessageSender({ type: 'OVERLAY_FRAME_STATUS' }, { id, url: 'https://claude.ai/chat/x', tab: { id: 1 } }, id).allowed
    ).toBe(true);
    expect(
      validateRuntimeMessageSender({ type: 'SETTINGS_CHANGED' }, { id, url: `chrome-extension://${id}/manager.html.evil` }, id).allowed
    ).toBe(false);
  });

  it('stores local vectors in the local space on capture', async () => {
    const db = freshDb();
    await ensureStarterCollectionsAndSettings(db);
    const t = thread('v1', 'Vector check', [['user', 'Explain vector databases'], ['assistant', 'They index embeddings.']]);
    await upsertThread(db, t);
    await processThreadLocally(db, t.threadKey);
    const vec = await db.threadVectors.get(`${LOCAL_SPACE}|${t.threadKey}`);
    expect(vec?.embedding).toHaveLength(384);
    const ctx = await loadOrganizeContext(db, await ensureStarterCollectionsAndSettings(db));
    expect(ctx.collections.length).toBeGreaterThan(0);
  });
});
