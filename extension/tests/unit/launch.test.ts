import { describe, expect, it } from 'vitest';
import {
  LAUNCH_GROUP_ORDER,
  LAUNCH_PROVIDERS,
  launchGroupOf,
  launchSections,
} from '../../src/entrypoints/manager/workspace/launch.js';
import { embedTargetFor, sessionGroupOf } from '../../src/entrypoints/manager/workspace/state.js';

describe('new tab launch list', () => {
  it('lists the nineteen providers once each, in the agreed order', () => {
    expect(LAUNCH_PROVIDERS.map((p) => p.provider)).toEqual([
      'claude_code', 'codex', 'cursor_agents', 'github_copilot', 'jules', 'devin',
      'chatgpt', 'claude', 'grok', 'grok_x', 'gemini', 'perplexity', 'deepseek', 'mistral', 'copilot',
      'grok_bot', 'chatgpt_dots', 'muse', 'claude_duet',
    ]);
  });

  it.each(LAUNCH_PROVIDERS.map((p) => [p.provider, p.url] as const))('%s starts at an embeddable address of its own', (provider, url) => {
    const target = embedTargetFor(url);
    expect(target, url).not.toBeNull();
    expect(target?.provider).toBe(provider);
  });

  it('uses the addresses named for the providers that share a host', () => {
    const urlOf = (id: string) => LAUNCH_PROVIDERS.find((p) => p.provider === id)?.url;
    expect(urlOf('claude_code')).toBe('https://claude.ai/code');
    expect(urlOf('claude')).toBe('https://claude.ai/new');
    expect(urlOf('codex')).toBe('https://chatgpt.com/codex');
    expect(urlOf('grok_x')).toBe('https://x.com/i/grok');
    expect(urlOf('grok_bot')).toBe('https://x.com/i/chat');
  });

  it('comes out as coding agents, chats and bots through the rail grouping', () => {
    expect(LAUNCH_GROUP_ORDER).toEqual(['coding', 'chats', 'bots']);
    const byGroup = (group: string) => LAUNCH_PROVIDERS.filter((p) => launchGroupOf(p.provider) === group).map((p) => p.provider);
    expect(byGroup('coding')).toEqual(['claude_code', 'codex', 'cursor_agents', 'github_copilot', 'jules', 'devin']);
    expect(byGroup('bots')).toEqual(['grok_bot', 'chatgpt_dots', 'muse', 'claude_duet']);
    expect(byGroup('chats')).toEqual(['chatgpt', 'claude', 'grok', 'grok_x', 'gemini', 'perplexity', 'deepseek', 'mistral', 'copilot']);
    // Only answer engines fall in the rail's fourth group; the page folds that into Chats.
    for (const entry of LAUNCH_PROVIDERS) {
      const rail = sessionGroupOf(entry.provider);
      expect(launchGroupOf(entry.provider)).toBe(rail === 'more' ? 'chats' : rail);
    }
  });

  it('builds three titled sections that together hold every provider', () => {
    const sections = launchSections();
    expect(sections.map((s) => s.label)).toEqual(['Coding agents', 'Chats', 'Bots']);
    expect(sections.flatMap((s) => s.providers)).toHaveLength(LAUNCH_PROVIDERS.length);
  });
});
