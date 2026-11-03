// Single source of truth for every AI product Threadkeeper understands.
// Manifest host permissions, content-script matches, DOM adapters, filters and
// labels are all derived from this registry so adding a provider is one entry.

export const PROVIDER_IDS = [
  'chatgpt',
  'claude',
  'claude_code',
  'codex',
  'grok',
  'grok_x',
  'gemini',
  'ai_studio',
  'perplexity',
  'deepseek',
  'mistral',
  'copilot',
  'kimi',
  'imported',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type CaptureProviderId = Exclude<ProviderId, 'imported'>;

/** What kind of AI product a provider is; used for filters and by the Sidebar Dock integration. */
export const PROVIDER_CATEGORIES = ['chat', 'coding_agent', 'agent', 'builder', 'search', 'companion'] as const;
export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  maker: string;
  /** Manifest match patterns whose pages may be captured (empty for import-only providers). */
  matchPatterns: string[];
  /** How a captured conversation can be reopened. */
  reopen: 'web' | 'terminal' | 'none';
  /** Product category: chat assistants, coding agents, autonomous agents, app builders, AI search, companions. */
  category: ProviderCategory;
  /** Short description shown in settings. */
  captureNote: string;
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  chatgpt: {
    id: 'chatgpt',
    category: 'chat',
    label: 'ChatGPT',
    maker: 'OpenAI',
    matchPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    reopen: 'web',
    captureNote: 'Chats, custom GPTs and ChatGPT Projects (project name is used for auto-filing).',
  },
  claude: {
    id: 'claude',
    category: 'chat',
    label: 'Claude',
    maker: 'Anthropic',
    matchPatterns: ['https://claude.ai/*'],
    reopen: 'web',
    captureNote: 'Chats on claude.ai, including chats inside Claude Projects.',
  },
  claude_code: {
    id: 'claude_code',
    category: 'coding_agent',
    label: 'Claude Code',
    maker: 'Anthropic',
    matchPatterns: ['https://claude.ai/*'],
    reopen: 'terminal',
    captureNote:
      'Claude Code on the web (claude.ai/code) plus local CLI sessions imported from ~/.claude/projects.',
  },
  codex: {
    id: 'codex',
    category: 'coding_agent',
    label: 'Codex',
    maker: 'OpenAI',
    matchPatterns: ['https://chatgpt.com/*'],
    reopen: 'terminal',
    captureNote:
      'Codex cloud tasks (chatgpt.com/codex) plus local Codex CLI sessions imported from ~/.codex/sessions.',
  },
  grok: {
    id: 'grok',
    category: 'chat',
    label: 'Grok',
    maker: 'xAI',
    matchPatterns: ['https://grok.com/*'],
    reopen: 'web',
    captureNote: 'Conversations on grok.com.',
  },
  grok_x: {
    id: 'grok_x',
    category: 'chat',
    label: 'Grok on X',
    maker: 'xAI',
    // X is a single-page app: /i/grok is reached without a page load, so scripts run on every
    // X page. Only /i/grok is ever captured (see detectProviderFromUrl).
    matchPatterns: ['https://x.com/*', 'https://twitter.com/*'],
    reopen: 'web',
    captureNote:
      'Grok conversations inside X (x.com/i/grok), read from the conversation data X itself loads. Other X pages are never captured.',
  },
  gemini: {
    id: 'gemini',
    category: 'chat',
    label: 'Gemini',
    maker: 'Google',
    matchPatterns: ['https://gemini.google.com/*'],
    reopen: 'web',
    captureNote: 'Conversations and Gems on gemini.google.com.',
  },
  ai_studio: {
    id: 'ai_studio',
    category: 'chat',
    label: 'Google AI Studio',
    maker: 'Google',
    matchPatterns: ['https://aistudio.google.com/*'],
    reopen: 'web',
    captureNote: 'Saved prompts and chats on aistudio.google.com.',
  },
  perplexity: {
    id: 'perplexity',
    category: 'search',
    label: 'Perplexity',
    maker: 'Perplexity',
    matchPatterns: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
    reopen: 'web',
    captureNote: 'Threads on perplexity.ai.',
  },
  deepseek: {
    id: 'deepseek',
    category: 'chat',
    label: 'DeepSeek',
    maker: 'DeepSeek',
    matchPatterns: ['https://chat.deepseek.com/*'],
    reopen: 'web',
    captureNote: 'Chats on chat.deepseek.com.',
  },
  mistral: {
    id: 'mistral',
    category: 'chat',
    label: 'Le Chat',
    maker: 'Mistral',
    matchPatterns: ['https://chat.mistral.ai/*'],
    reopen: 'web',
    captureNote: 'Chats on chat.mistral.ai.',
  },
  copilot: {
    id: 'copilot',
    category: 'chat',
    label: 'Copilot',
    maker: 'Microsoft',
    matchPatterns: [
      'https://copilot.microsoft.com/*',
      'https://copilot.com/*',
      'https://www.copilot.com/*',
    ],
    reopen: 'web',
    captureNote: 'Chats on copilot.microsoft.com and copilot.com.',
  },
  kimi: {
    id: 'kimi',
    category: 'chat',
    label: 'Kimi',
    maker: 'Moonshot AI',
    matchPatterns: ['https://www.kimi.com/*', 'https://kimi.com/*', 'https://kimi.ai/*'],
    reopen: 'web',
    captureNote: 'Chats on kimi.com.',
  },
  imported: {
    id: 'imported',
    category: 'chat',
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

/**
 * web_accessible_resources only accepts origin patterns (scheme://host/*): any path or
 * query in a match pattern is replaced with /*, then duplicates are dropped.
 */
export function toOriginMatchPatterns(patterns: readonly string[]): string[] {
  const out = new Set<string>();
  for (const pattern of patterns) {
    const m = pattern.trim().match(/^(\*|[a-z][a-z0-9+.-]*):\/\/([^/?#]*)/i);
    if (!m || (m[2] === '' && m[1].toLowerCase() !== 'file')) continue;
    out.add(`${m[1].toLowerCase()}://${m[2].toLowerCase()}/*`);
  }
  return Array.from(out);
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerLabel(id: ProviderId | string): string {
  return isProviderId(id) ? PROVIDERS[id].label : String(id);
}

/** The provider's category; unknown ids count as chat. */
export function providerCategory(id: ProviderId | string): ProviderCategory {
  return isProviderId(id) ? PROVIDERS[id].category : 'chat';
}

const X_HOST_RE = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/;

/** x.com / twitter.com (with optional www. or mobile.), where only /i/grok is an AI page. */
export function isXHostname(hostname: string): boolean {
  return X_HOST_RE.test(hostname.toLowerCase());
}

const KIMI_HOSTS = new Set(['www.kimi.com', 'kimi.com', 'kimi.ai']);
const COPILOT_HOSTS = new Set(['copilot.microsoft.com', 'copilot.com', 'www.copilot.com']);

/** Provider that owns a page by host and path alone (no test hints). */
function providerForPage(parsed: URL): ProviderId | null {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') {
    return /^(?:\/u\/[^/]+)?\/codex(\/|$)/.test(path) ? 'codex' : 'chatgpt';
  }
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    return /^\/code(\/|$)/.test(path) ? 'claude_code' : 'claude';
  }
  if (host === 'grok.com' || host.endsWith('.grok.com')) return 'grok';
  // Grok inside X: only /i/grok. Every other X page is not an AI page.
  if (isXHostname(host)) return /^\/i\/grok(\/|$)/.test(path) ? 'grok_x' : null;
  if (host === 'gemini.google.com') return 'gemini';
  if (host === 'aistudio.google.com') return 'ai_studio';
  if (host === 'perplexity.ai' || host.endsWith('.perplexity.ai')) return 'perplexity';
  if (host === 'chat.deepseek.com') return 'deepseek';
  if (host === 'chat.mistral.ai') return 'mistral';
  if (COPILOT_HOSTS.has(host)) return 'copilot';
  if (KIMI_HOSTS.has(host)) return 'kimi';
  return null;
}

/** Resolve which provider owns a page URL (path-sensitive: claude.ai/code is Claude Code). */
export function detectProviderFromUrl(url: string): ProviderId | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const owner = providerForPage(parsed);
  if (owner) return owner;
  if (isXHostname(parsed.hostname)) return null;
  const hinted = parsed.searchParams.get('tk_provider');
  return isProviderId(hinted) ? hinted : null;
}

/**
 * True for an https page of a registered capture provider: the pages that get the content
 * script and may host the overlay. Unlike detectProviderFromUrl it ignores the tk_provider
 * test hint, so an arbitrary site cannot opt itself in.
 */
export function isCapturePageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const owner = parsed.protocol === 'https:' ? providerForPage(parsed) : null;
    return owner !== null && owner !== 'imported';
  } catch {
    return false;
  }
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/** Extract a stable conversation id from a provider URL. */
export function extractConversationIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const path = parsed.pathname;
  switch (providerForPage(parsed)) {
    case 'grok_x': {
      // https://x.com/i/grok?conversation=<id>; a bare /i/grok is a new, unsaved chat.
      const conv = parsed.searchParams.get('conversation');
      return conv && SAFE_ID_RE.test(conv) ? conv : null;
    }
    case 'ai_studio': {
      const m = path.match(/^\/prompts\/([a-zA-Z0-9_-]+)(?:\/|$)/);
      return m && m[1] !== 'new_chat' ? m[1] : null;
    }
    case 'kimi': {
      const m = path.match(/^\/chat\/([0-9a-f-]{36}|[a-z0-9]{20})(?:\/|$)/);
      return m ? m[1] : null;
    }
    default:
      break;
  }
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
 * ChatGPT Project routes: /g/g-p-<id>[-<slug>]/c/<conversation> or /g/g-p-<id>[-<slug>]/project,
 * optionally behind /u/<n>. Current project ids are 32 hex characters; the slug is optional.
 */
export function parseChatGptProjectRoute(
  url: string
): { projectId: string; slug: string | null } | null {
  try {
    const m = new URL(url).pathname.match(
      /^(?:\/u\/[^/]+)?\/g\/(g-p-[0-9a-f]+)(?:-([^/?#]*))?(?:\/|$)/i
    );
    if (!m) return null;
    return { projectId: m[1], slug: m[2] ? decodeURIComponent(m[2]) : null };
  } catch {
    return null;
  }
}

/**
 * The project slug in a ChatGPT Project URL, title-cased. The slug is the user's own
 * project name, which is a strong auto-filing signal.
 */
export function extractChatGptProjectSlug(url: string): string | null {
  const slug = parseChatGptProjectRoute(url)?.slug;
  if (!slug || !/^[a-z0-9-]+$/i.test(slug)) return null;
  const name = slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
  return name || null;
}
