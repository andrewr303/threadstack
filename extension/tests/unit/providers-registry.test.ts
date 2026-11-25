import { describe, expect, it } from 'vitest';
import {
  CAPTURE_PROVIDER_IDS,
  CUSTOM_SITE_PROVIDER_IDS,
  NON_CAPTURE_PROVIDER_IDS,
  OPTIONAL_PROVIDER_IDS,
  PROVIDER_CATEGORIES,
  PROVIDER_IDS,
  PROVIDERS,
  captureMatchPatterns,
  conversationQueryParams,
  detectProviderFromUrl,
  extractConversationIdFromUrl,
  isCaptureProviderId,
  isCapturePageUrl,
  isProviderAllowedOnUrl,
  matchPatternCovers,
  optionalCaptureMatchPatterns,
  providerCategory,
  runtimeMatchPatterns,
  runtimePermissionOrigins,
  toOriginMatchPatterns,
} from '../../src/core/providers.js';
import { canonicalizeConversationUrl } from '../../src/core/dom-capture.js';
import { DEFAULT_SETTINGS, buildThreadKey, normalizeSettings, parseThreadKey } from '../../src/core/schema.js';

/** The capture hosts of v0.4 (install-time): these must never grow, or Chrome disables the extension on update. */
const V04_REQUIRED_PATTERNS = [
  'https://chatgpt.com/*',
  'https://chat.openai.com/*',
  'https://claude.ai/*',
  'https://grok.com/*',
  'https://x.com/*',
  'https://twitter.com/*',
  'https://gemini.google.com/*',
  'https://aistudio.google.com/*',
  'https://www.perplexity.ai/*',
  'https://perplexity.ai/*',
  'https://chat.deepseek.com/*',
  'https://chat.mistral.ai/*',
  'https://copilot.microsoft.com/*',
  'https://copilot.com/*',
  'https://www.copilot.com/*',
  'https://www.kimi.com/*',
  'https://kimi.com/*',
  'https://kimi.ai/*',
];

describe('provider registry', () => {
  it('keeps every v0.4 id, in order, so stored thread keys stay valid', () => {
    expect(PROVIDER_IDS.slice(0, 14)).toEqual([
      'chatgpt', 'claude', 'claude_code', 'codex', 'grok', 'grok_x', 'gemini',
      'ai_studio', 'perplexity', 'deepseek', 'mistral', 'copilot', 'kimi', 'imported',
    ]);
    expect(new Set(PROVIDER_IDS).size).toBe(PROVIDER_IDS.length);
  });

  it('gives every provider a label, maker, category and consistent host access', () => {
    for (const id of PROVIDER_IDS) {
      const info = PROVIDERS[id];
      expect(info.id).toBe(id);
      expect(info.label.length).toBeGreaterThan(0);
      expect(info.maker.length).toBeGreaterThan(0);
      expect(PROVIDER_CATEGORIES).toContain(info.category);
      expect(info.captureNote.length).toBeGreaterThan(10);
      if (info.hostAccess === 'required' || info.hostAccess === 'optional') {
        expect(info.matchPatterns.length).toBeGreaterThan(0);
        for (const p of info.matchPatterns) expect(p).toMatch(/^https:\/\/[a-z0-9.-]+\/[\w*]*\*?$/);
      } else {
        expect(info.matchPatterns).toEqual([]);
      }
    }
  });

  it('files coding agents and the named products under the right category', () => {
    expect(providerCategory('claude_code')).toBe('coding_agent');
    expect(providerCategory('codex')).toBe('coding_agent');
    expect(providerCategory('github_copilot')).toBe('coding_agent');
    expect(providerCategory('chatgpt_dots')).toBe('agent');
    expect(providerCategory('muse')).toBe('agent');
    expect(providerCategory('grok_bot')).toBe('agent');
    expect(providerCategory('perplexity')).toBe('search');
    expect(providerCategory('character_ai')).toBe('companion');
    expect(providerCategory('lovable')).toBe('builder');
    expect(providerCategory('nonsense')).toBe('chat');
  });

  it('keeps install-time hosts exactly as in v0.4; everything new is asked for at runtime', () => {
    expect(captureMatchPatterns()).toEqual(V04_REQUIRED_PATTERNS);
    const optional = optionalCaptureMatchPatterns();
    expect(optional).toEqual(expect.arrayContaining(['https://muse.ai/*', 'https://poe.com/*', 'https://www.kimi.ai/*', 'https://github.com/*']));
    for (const p of optional) expect(V04_REQUIRED_PATTERNS).not.toContain(p);
    expect(runtimeMatchPatterns('kimi')).toEqual(['https://www.kimi.ai/*']);
    expect(runtimeMatchPatterns('chatgpt')).toEqual([]);
    expect(runtimePermissionOrigins('huggingchat')).toEqual(['https://huggingface.co/*']);
    expect(OPTIONAL_PROVIDER_IDS).not.toContain('chatgpt_dots');
    expect(OPTIONAL_PROVIDER_IDS).toContain('meta_ai');
    expect(CUSTOM_SITE_PROVIDER_IDS).toEqual(expect.arrayContaining(['custom_web', 'open_webui', 'librechat', 'anythingllm']));
  });

  it('turns on only providers ThreadStack can read from install; Grok Bot and new hosts start off', () => {
    expect(DEFAULT_SETTINGS.authorizedHosts.chatgpt).toBe(true);
    expect(DEFAULT_SETTINGS.authorizedHosts.chatgpt_dots).toBe(true);
    expect(DEFAULT_SETTINGS.authorizedHosts.grok_bot).toBe(false);
    expect(DEFAULT_SETTINGS.authorizedHosts.poe).toBe(false);
    // Existing profiles get the new ids with their defaults, and keep their own choices.
    const migrated = normalizeSettings({ authorizedHosts: { chatgpt: false } } as never);
    expect(migrated.authorizedHosts.chatgpt).toBe(false);
    expect(migrated.authorizedHosts.meta_ai).toBe(false);
    for (const id of CAPTURE_PROVIDER_IDS) expect(migrated.boundAccounts[id].accountId).toBe(`acct_${id}_primary`);
  });

  it('gives every provider (incl. Paperclip) a default account and normalizes a v0.4 record', () => {
    for (const id of PROVIDER_IDS) {
      expect(DEFAULT_SETTINGS.boundAccounts[id]).toEqual({ accountId: `acct_${id}_primary`, workspaceId: 'ws_personal' });
    }
    const v04 = normalizeSettings({
      authorizedHosts: { chatgpt: true, claude: false },
      boundAccounts: { chatgpt: { accountId: 'acct_mine', workspaceId: 'ws_work' } },
    } as never);
    expect(v04.boundAccounts.chatgpt).toEqual({ accountId: 'acct_mine', workspaceId: 'ws_work' });
    for (const id of PROVIDER_IDS) {
      if (id === 'chatgpt') continue;
      expect(v04.boundAccounts[id].accountId).toBe(`acct_${id}_primary`);
    }
    expect(v04.authorizedHosts.claude).toBe(false);
    for (const id of CAPTURE_PROVIDER_IDS) expect(typeof v04.authorizedHosts[id]).toBe('boolean');
    // Paperclip and imports are never captured from a page, so they have no capture switch.
    expect('paperclip' in v04.authorizedHosts).toBe(false);
    expect('imported' in v04.authorizedHosts).toBe(false);
    expect(v04.paperclip.enabled).toBe(false);
    expect(v04.sidebarDock.pairedId).toBe('');
  });

  it('keeps non-capture providers and host access none in step', () => {
    const none = PROVIDER_IDS.filter((id) => PROVIDERS[id].hostAccess === 'none');
    expect([...NON_CAPTURE_PROVIDER_IDS].sort()).toEqual([...none].sort());
    expect(PROVIDERS.paperclip).toMatchObject({ category: 'agent', reopen: 'web', matchPatterns: [] });
    expect(isCaptureProviderId('paperclip')).toBe(false);
    expect(isCaptureProviderId('imported')).toBe(false);
    expect(isCaptureProviderId('custom_web')).toBe(true);
    expect(providerCategory('paperclip')).toBe('agent');
  });

  it('round-trips thread keys for new providers', () => {
    const key = buildThreadKey({ provider: 'custom_web', accountId: 'acct_custom_web_primary', workspaceId: 'ws_personal', sourceConversationId: 'chat.example.com~abc', branchId: 'main' });
    expect(parseThreadKey(key)).toMatchObject({ provider: 'custom_web', sourceConversationId: 'chat.example.com~abc' });
  });
});

describe('match patterns', () => {
  it('covers hosts, paths and wildcards like Chrome', () => {
    expect(matchPatternCovers('https://huggingface.co/chat*', 'https://huggingface.co/chat/conversation/x')).toBe(true);
    expect(matchPatternCovers('https://huggingface.co/chat*', 'https://huggingface.co/models')).toBe(false);
    expect(matchPatternCovers('https://*.example.com/*', 'https://a.example.com/x')).toBe(true);
    expect(matchPatternCovers('https://*.example.com/*', 'https://example.com/')).toBe(true);
    expect(matchPatternCovers('https://*.example.com/*', 'https://badexample.com/')).toBe(false);
    expect(matchPatternCovers('http://localhost/*', 'http://localhost:3000/c/1')).toBe(true);
    expect(matchPatternCovers('https://poe.com/*', 'http://poe.com/')).toBe(false);
    expect(matchPatternCovers('not a pattern', 'https://poe.com/')).toBe(false);
  });

  it('normalizes optional origins for host permissions', () => {
    expect(toOriginMatchPatterns(['https://huggingface.co/chat*'])).toEqual(['https://huggingface.co/*']);
  });
});

describe('page routing', () => {
  const cases: Array<[string, string | null]> = [
    ['https://chatgpt.com/dots/home', 'chatgpt_dots'],
    ['https://chatgpt.com/u/1/dots/acct~dot1', 'chatgpt_dots'],
    ['https://chatgpt.com/codex/tasks/t1', 'codex'],
    ['https://chatgpt.com/c/abc', 'chatgpt'],
    ['https://claude.ai/duet', 'claude_duet'],
    ['https://claude.ai/duet/chan_123', 'claude_duet'],
    ['https://claude.ai/code/sess', 'claude_code'],
    ['https://x.com/i/chat/123-456', 'grok_bot'],
    ['https://x.com/i/grok?conversation=1', 'grok_x'],
    ['https://x.com/home', null],
    ['https://muse.ai/thread/abc', 'muse'],
    ['https://www.meta.ai/prompt/abc', 'meta_ai'],
    ['https://poe.com/chat/2abc', 'poe'],
    ['https://huggingface.co/chat/conversation/0123456789abcdef01234567', 'huggingchat'],
    ['https://huggingface.co/models', null],
    ['https://chat.qwen.ai/c/1234abcd', 'qwen'],
    ['https://www.doubao.com/chat/123', 'doubao'],
    ['https://chat.z.ai/c/1234abcd', 'zai'],
    ['https://manus.im/app/abc', 'manus'],
    ['https://www.genspark.ai/agents?id=x1', 'genspark'],
    ['https://agent.minimax.io/?id=1', 'minimax_agent'],
    ['https://character.ai/chat/abcdefgh12', 'character_ai'],
    ['https://duck.ai/chat?chatID=1', 'duck_ai'],
    ['https://lumo.proton.me/u/0/c/1234abcd-1', 'lumo'],
    ['https://lmarena.ai/c/abc', 'arena'],
    ['https://t3.chat/chat/abc', 't3_chat'],
    ['https://notebooklm.google.com/notebook/abc', 'gemini_notebook'],
    ['https://github.com/copilot/c/abc', 'github_copilot'],
    ['https://github.com/acme/app/pull/12/agent-sessions/s1', 'github_copilot'],
    ['https://github.com/acme/app', null],
    ['https://cursor.com/agents/bc-1', 'cursor_agents'],
    ['https://cursor.com/pricing', null],
    ['https://app.devin.ai/sessions/s1', 'devin'],
    ['https://jules.google.com/session/1', 'jules'],
    ['https://lovable.dev/projects/p1', 'lovable'],
    ['https://lovable.dev/pricing', null],
    ['https://bolt.new/~/sb1-x', 'bolt'],
    ['https://v0.app/chat/my-app-x1', 'v0'],
    ['https://replit.com/@me/my-app', 'replit'],
    ['https://replit.com/pricing', null],
    ['https://www.kimi.ai/chat/abcdefghij0123456789', 'kimi'],
    ['https://app.lobehub.com/chat?session=a&topic=b', 'lobechat'],
    ['https://chat.example.com/c/abc', null],
  ];
  it.each(cases)('%s → %s', (url, provider) => {
    expect(detectProviderFromUrl(url)).toBe(provider);
  });

  it('never lets the test hint name a custom-site provider or open a capture page', () => {
    expect(detectProviderFromUrl('http://127.0.0.1:4000/?tk_provider=claude')).toBe('claude');
    expect(detectProviderFromUrl('http://127.0.0.1:4000/?tk_provider=custom_web')).toBeNull();
    expect(isCapturePageUrl('https://example.com/?tk_provider=claude')).toBe(false);
  });

  it('hosts the overlay only where the host is held from install', () => {
    expect(isCapturePageUrl('https://x.com/i/chat/1-2')).toBe(true);
    expect(isCapturePageUrl('https://chatgpt.com/dots/home')).toBe(true);
    expect(isCapturePageUrl('https://poe.com/chat/abc')).toBe(false);
    expect(isCapturePageUrl('https://www.kimi.ai/chat/abcdefghij0123456789')).toBe(false);
    expect(isCapturePageUrl('https://kimi.ai/chat/abcdefghij0123456789')).toBe(true);
  });

  it('accepts a provider only from its own pages', () => {
    expect(isProviderAllowedOnUrl('chatgpt', 'https://chatgpt.com/codex/x')).toBe(true);
    expect(isProviderAllowedOnUrl('chatgpt_dots', 'https://chatgpt.com/dots/home')).toBe(true);
    expect(isProviderAllowedOnUrl('claude', 'https://chatgpt.com/c/1')).toBe(false);
    expect(isProviderAllowedOnUrl('huggingchat', 'https://huggingface.co/models')).toBe(false);
    expect(isProviderAllowedOnUrl('kimi', 'https://www.kimi.ai/chat/x')).toBe(true);
    expect(isProviderAllowedOnUrl('custom_web', 'https://chat.example.com/')).toBe(false);
    expect(isProviderAllowedOnUrl('imported', 'https://chatgpt.com/')).toBe(false);
  });
});

describe('conversation ids', () => {
  const cases: Array<[string, string | null]> = [
    ['https://chatgpt.com/dots/acct_1~dot-2', 'dot_acct_1_dot-2'],
    ['https://chatgpt.com/dots/home', null],
    ['https://claude.ai/duet', 'duet_main'],
    ['https://claude.ai/duet/chan_abc', 'chan_abc'],
    ['https://x.com/i/chat/1234-5678', '1234-5678'],
    ['https://x.com/i/chat', null],
    ['https://muse.ai/', 'main'],
    ['https://muse.ai/thread/s_1', 's_1'],
    ['https://muse.ai/thread/new', null],
    ['https://muse.ai/goals/g1', null],
    ['https://www.meta.ai/prompt/abc-123', 'abc-123'],
    ['https://www.meta.ai/share/abc', null],
    ['https://poe.com/chat/2xyz9', '2xyz9'],
    ['https://poe.com/Claude-Sonnet', null],
    // The generic /chat/ rule used to return "conversation" here.
    ['https://huggingface.co/chat/conversation/0123456789abcdef01234567', '0123456789abcdef01234567'],
    ['https://huggingface.co/chat/conversation/abc1234', null],
    ['https://huggingface.co/chat/settings', null],
    ['https://chat.qwen.ai/c/9f1e2d3c-aaaa', '9f1e2d3c-aaaa'],
    ['https://www.doubao.com/chat/12345', '12345'],
    ['https://www.doubao.com/code/chat/777', '777'],
    ['https://www.doubao.com/chat/local_1', null],
    ['https://chat.z.ai/c/0a1b2c3d-1', '0a1b2c3d-1'],
    ['https://manus.im/app/TaskX1', 'TaskX1'],
    ['https://www.genspark.ai/agents?type=x&id=proj_1', 'proj_1'],
    ['https://www.genspark.ai/agents?type=x', null],
    ['https://agent.minimax.io/mavis?id=777', '777'],
    ['https://agent.minimax.io/', null],
    // Character.AI: the chat id is ?hist=; without it, the latest chat with the character.
    ['https://character.ai/chat/char_abcdef?hist=11111111-2222', '11111111-2222'],
    ['https://character.ai/chat/char_abcdef', 'c_char_abcdef'],
    ['https://duck.ai/chat?chatID=c1', 'c1'],
    ['https://duck.ai/chat', null],
    ['https://lumo.proton.me/u/0/c/1234abcd-ef', '1234abcd-ef'],
    ['https://arena.ai/c/5d3c2b1a-0000', '5d3c2b1a-0000'],
    ['https://t3.chat/chat/abc_1', 'abc_1'],
    ['https://notebook.google.com/notebook/nb1', 'nb1'],
    ['https://github.com/copilot/c/chat1', 'chat1'],
    ['https://github.com/copilot/tasks/t9', 'task_t9'],
    ['https://github.com/acme/app/pull/12/agent-sessions/s1', 'session_s1'],
    ['https://cursor.com/agents/bc-1234', 'bc-1234'],
    ['https://cursor.com/agents?id=bc-77', 'bc-77'],
    ['https://cursor.com/agents', null],
    ['https://app.devin.ai/sessions/d1', 'd1'],
    ['https://jules.google.com/task/j1', 'j1'],
    ['https://lovable.dev/projects/uuid-1', 'uuid-1'],
    ['https://bolt.new/~/sb1.abc', 'sb1_abc'],
    ['https://v0.app/chat/landing-page-x1', 'landing-page-x1'],
    ['https://replit.com/@me/my.app', 'me_my_app'],
    ['https://app.lobehub.com/chat?session=s1&topic=t1', 's1_t1'],
    // copilot.com moved conversations to /chat/conversation/<uuid> (the generic rule returned "conversation").
    ['https://copilot.com/chat/conversation/0f0e0d0c-1111', '0f0e0d0c-1111'],
    ['https://copilot.microsoft.com/chats/xyz789', 'xyz789'],
    ['https://www.kimi.ai/chat/abcdefghij0123456789', 'abcdefghij0123456789'],
  ];
  it.each(cases)('%s → %s', (url, id) => {
    expect(extractConversationIdFromUrl(url)).toBe(id);
  });

  it('keeps id-carrying query parameters in canonical URLs and drops the rest', () => {
    expect(conversationQueryParams('character_ai')).toEqual(['conversation', 'hist']);
    expect(canonicalizeConversationUrl('https://character.ai/chat/char_abcdef?hist=h1&utm=x#top')).toBe('https://character.ai/chat/char_abcdef?hist=h1');
    expect(canonicalizeConversationUrl('https://duck.ai/chat?chatID=c1&q=hello')).toBe('https://duck.ai/chat?chatID=c1');
    expect(canonicalizeConversationUrl('https://www.genspark.ai/agents?type=x&id=p1')).toBe('https://www.genspark.ai/agents?id=p1');
    expect(canonicalizeConversationUrl('https://chatgpt.com/c/abc?model=x')).toBe('https://chatgpt.com/c/abc');
    expect(canonicalizeConversationUrl('http://localhost:3000/#/chat/abc?x', 'custom_web')).toBe('http://localhost:3000/');
    expect(canonicalizeConversationUrl('http://localhost:3000/#/chat/abc', 'custom_web')).toBe('http://localhost:3000/#/chat/abc');
    expect(canonicalizeConversationUrl('https://chat.example.com/chat?conversationId=k1&tab=2', 'custom_web')).toBe('https://chat.example.com/chat?conversationId=k1');
  });
});
