// Where each provider starts, for the Browse "new tab" page: an ordered list of start addresses
// and the three groups they are shown under. Pure data and helpers.
import type { ProviderId } from '../../../core/providers.js';
import { SESSION_GROUP_LABELS, sessionGroupOf } from './state.js';

export interface LaunchProvider {
  provider: ProviderId;
  /** An https page of the provider that Threadkeeper can embed (see embedTargetFor). */
  url: string;
}

/** In the order they appear on the new tab page, within each group. */
export const LAUNCH_PROVIDERS: readonly LaunchProvider[] = [
  { provider: 'claude_code', url: 'https://claude.ai/code' },
  { provider: 'codex', url: 'https://chatgpt.com/codex' },
  { provider: 'cursor_agents', url: 'https://cursor.com/agents' },
  { provider: 'github_copilot', url: 'https://github.com/copilot' },
  { provider: 'jules', url: 'https://jules.google.com/' },
  { provider: 'devin', url: 'https://app.devin.ai/' },
  { provider: 'chatgpt', url: 'https://chatgpt.com/' },
  { provider: 'claude', url: 'https://claude.ai/new' },
  { provider: 'grok', url: 'https://grok.com/' },
  { provider: 'grok_x', url: 'https://x.com/i/grok' },
  { provider: 'gemini', url: 'https://gemini.google.com/app' },
  { provider: 'perplexity', url: 'https://www.perplexity.ai/' },
  { provider: 'deepseek', url: 'https://chat.deepseek.com/' },
  { provider: 'mistral', url: 'https://chat.mistral.ai/chat' },
  { provider: 'copilot', url: 'https://copilot.microsoft.com/' },
  { provider: 'grok_bot', url: 'https://x.com/i/chat' },
  { provider: 'chatgpt_dots', url: 'https://chatgpt.com/dots' },
  { provider: 'muse', url: 'https://muse.ai/' },
  { provider: 'claude_duet', url: 'https://claude.ai/duet' },
];

export type LaunchGroup = 'coding' | 'chats' | 'bots';

export const LAUNCH_GROUP_ORDER: readonly LaunchGroup[] = ['coding', 'chats', 'bots'];

/**
 * The group a provider is listed under. The side rail has a fourth "More" group (search
 * engines, app builders); the new tab page only offers answer engines among them, which read
 * as chats, so "More" folds into Chats here.
 */
export function launchGroupOf(provider: ProviderId | string): LaunchGroup {
  const group = sessionGroupOf(provider);
  return group === 'more' ? 'chats' : group;
}

export interface LaunchSection {
  group: LaunchGroup;
  label: string;
  providers: LaunchProvider[];
}

export function launchSections(): LaunchSection[] {
  return LAUNCH_GROUP_ORDER.map((group) => ({
    group,
    label: SESSION_GROUP_LABELS[group],
    providers: LAUNCH_PROVIDERS.filter((entry) => launchGroupOf(entry.provider) === group),
  })).filter((section) => section.providers.length > 0);
}
