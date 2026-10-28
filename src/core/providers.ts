// Single source of truth for every AI product Threadkeeper understands.
// Manifest host permissions, content-script matches, DOM adapters, filters and
// labels are all derived from this registry so adding a provider is one entry.

export const PROVIDER_IDS = [
  'chatgpt',
  'claude',
  'claude_code',
  'codex',
  'grok',
  'gemini',
  'perplexity',
  'deepseek',
  'mistral',
  'copilot',
  'imported',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type CaptureProviderId = Exclude<ProviderId, 'imported'>;

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  maker: string;
  /** Manifest match patterns whose pages may be captured (empty for import-only providers). */
  matchPatterns: string[];
  /** How a captured conversation can be reopened. */
  reopen: 'web' | 'terminal' | 'none';
  /** Short description shown in settings. */
  captureNote: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  chatgpt: {
    id: 'chatgpt',
    label: 'ChatGPT',
    maker: 'OpenAI',
    matchPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    reopen: 'web',
    captureNote: 'Chats, custom GPTs and ChatGPT Projects (project name is used for auto-filing).',
  },
  claude: {
    id: 'claude',
    label: 'Claude',
    maker: 'Anthropic',
    matchPatterns: ['https://claude.ai/*'],
    reopen: 'web',
    captureNote: 'Chats on claude.ai, including chats inside Claude Projects.',
  },
  claude_code: {
    id: 'claude_code',
    label: 'Claude Code',
    maker: 'Anthropic',
    matchPatterns: ['https://claude.ai/*'],
    reopen: 'terminal',
    captureNote:
      'Claude Code on the web (claude.ai/code) plus local CLI sessions imported from ~/.claude/projects.',
  },
  codex: {
    id: 'codex',
    label: 'Codex',
    maker: 'OpenAI',
    matchPatterns: ['https://chatgpt.com/*'],
    reopen: 'terminal',
    captureNote:
      'Codex cloud tasks (chatgpt.com/codex) plus local Codex CLI sessions imported from ~/.codex/sessions.',
  },
  grok: {
    id: 'grok',
    label: 'Grok',
    maker: 'xAI',
    matchPatterns: ['https://grok.com/*'],
    reopen: 'web',
    captureNote: 'Conversations on grok.com.',
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini',
    maker: 'Google',
    matchPatterns: ['https://gemini.google.com/*'],
    reopen: 'web',
    captureNote: 'Conversations and Gems on gemini.google.com.',
  },
  perplexity: {
    id: 'perplexity',
    label: 'Perplexity',
    maker: 'Perplexity',
    matchPatterns: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
    reopen: 'web',
    captureNote: 'Threads on perplexity.ai.',
  },
  deepseek: {
    id: 'deepseek',
    label: 'DeepSeek',
    maker: 'DeepSeek',
    matchPatterns: ['https://chat.deepseek.com/*'],
    reopen: 'web',
    captureNote: 'Chats on chat.deepseek.com.',
  },
  mistral: {
    id: 'mistral',
    label: 'Le Chat',
    maker: 'Mistral',
    matchPatterns: ['https://chat.mistral.ai/*'],
    reopen: 'web',
    captureNote: 'Chats on chat.mistral.ai.',
  },
  copilot: {
    id: 'copilot',
    label: 'Copilot',
    maker: 'Microsoft',
    matchPatterns: ['https://copilot.microsoft.com/*'],
    reopen: 'web',
    captureNote: 'Chats on copilot.microsoft.com.',
  },
  imported: {
    id: 'imported',
    label: 'Imported',
    maker: 'Other',
    matchPatterns: [],
    reopen: 'none',
    captureNote: 'Threads imported from files that do not belong to a known provider.',
  },
};

export const CAPTURE_PROVIDER_IDS = PROVIDER_IDS.filter(
  (id): id is CaptureProviderId => id !== 'imported'
);

/** Deduplicated match patterns for manifest content scripts and host permissions. */
export function captureMatchPatterns(): string[] {
  return Array.from(
    new Set(CAPTURE_PROVIDER_IDS.flatMap((id) => PROVIDERS[id].matchPatterns))
  );
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerLabel(id: ProviderId | string): string {
  return isProviderId(id) ? PROVIDERS[id].label : String(id);
}

/** Resolve which provider owns a page URL (path-sensitive: claude.ai/code is Claude Code). */
export function detectProviderFromUrl(url: string): ProviderId | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') {
    return /^\/codex(\/|$)/.test(path) ? 'codex' : 'chatgpt';
  }
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    return /^\/code(\/|$)/.test(path) ? 'claude_code' : 'claude';
  }
  if (host === 'grok.com' || host.endsWith('.grok.com')) return 'grok';
  if (host === 'gemini.google.com') return 'gemini';
  if (host === 'perplexity.ai' || host.endsWith('.perplexity.ai')) return 'perplexity';
  if (host === 'chat.deepseek.com') return 'deepseek';
  if (host === 'chat.mistral.ai') return 'mistral';
  if (host === 'copilot.microsoft.com') return 'copilot';
  const hinted = parsed.searchParams.get('tk_provider');
  return isProviderId(hinted) ? hinted : null;
}

/** Extract a stable conversation id from a provider URL. */
export function extractConversationIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname;
  const patterns: RegExp[] = [
    /\/codex\/tasks\/([a-zA-Z0-9_-]+)/, // Codex cloud task
    /\/code\/([a-zA-Z0-9_-]{6,})/, // Claude Code on the web session
    /\/c\/([a-zA-Z0-9_-]+)/, // ChatGPT, Grok
    /\/chat\/s\/([a-zA-Z0-9_-]+)/, // DeepSeek
    /\/chat\/([a-zA-Z0-9_-]+)/, // Claude, Mistral, Grok (legacy)
    /\/chats\/([a-zA-Z0-9_-]+)/, // Copilot
    /\/app\/([a-zA-Z0-9_-]+)/, // Gemini
    /\/gem\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)/, // Gemini Gems
    /\/search\/([a-zA-Z0-9._-]+)/, // Perplexity
  ];
  for (const re of patterns) {
    const m = path.match(re);
    if (m) return m[1];
  }
  const grokParam = parsed.searchParams.get('conversation');
  if (grokParam) return grokParam;
  return parsed.searchParams.get('tk_conv_id');
}

/**
 * ChatGPT Project URLs look like /g/g-p-<hash>-<slug>/c/<id>. The slug is the
 * user's own project name, which is a strong auto-filing signal.
 */
export function extractChatGptProjectSlug(url: string): string | null {
  try {
    const m = new URL(url).pathname.match(/\/g\/g-p-[a-f0-9]+-([a-z0-9-]+)(?:\/|$)/i);
    if (!m) return null;
    return m[1]
      .split('-')
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');
  } catch {
    return null;
  }
}
