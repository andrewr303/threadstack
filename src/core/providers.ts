// Single source of truth for every AI product Threadkeeper understands.
// Manifest host permissions, content-script matches (static and runtime-registered), DOM
// adapters, filters, categories and labels are all derived from this registry. Adding a
// provider means: one entry here, its page routing in `providerForPage`, its id rule in
// `extractConversationIdFromUrl`, a DOM adapter in dom-capture.ts and a default account id in
// schema.ts (the last two fail to compile until they exist).
//
// Ids are stored inside every thread key: never rename or remove one.

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
  // Agents and chats on hosts Threadkeeper already reads (path-routed like claude_code).
  'chatgpt_dots',
  'claude_duet',
  'grok_bot',
  // Products on their own hosts: host access is asked for when the user turns them on.
  'muse',
  'meta_ai',
  'poe',
  'huggingchat',
  'qwen',
  'doubao',
  'zai',
  'manus',
  'genspark',
  'minimax_agent',
  'character_ai',
  'duck_ai',
  'lumo',
  'arena',
  't3_chat',
  'gemini_notebook',
  'github_copilot',
  'cursor_agents',
  'devin',
  'jules',
  'lovable',
  'bolt',
  'v0',
  'replit',
  'lobechat',
  // Sites the user adds in Settings → Capture: a catch-all plus self-hosted apps recognised on them.
  'custom_web',
  'open_webui',
  'librechat',
  'anythingllm',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export type CaptureProviderId = Exclude<ProviderId, 'imported'>;

/** What kind of product a provider is. Shared with Sidebar Dock (protocol `category`). */
export const PROVIDER_CATEGORIES = ['chat', 'coding_agent', 'agent', 'builder', 'search', 'companion'] as const;
export type ProviderCategory = (typeof PROVIDER_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<ProviderCategory, string> = {
  chat: 'Chat assistants',
  coding_agent: 'Coding agents',
  agent: 'Agents',
  builder: 'App builders',
  search: 'Search',
  companion: 'Companions',
};

/**
 * How Threadkeeper gets onto a provider's pages:
 * - `required`: an install-time host permission and a static content script (the providers
 *   Threadkeeper has always read; adding hosts here would disable the extension on update).
 * - `optional`: the host permission is requested when the user turns the provider on, then the
 *   content script is registered at runtime (custom-sites.ts).
 * - `custom`: only on sites the user adds in Settings → Capture.
 * - `none`: never captured from a page (imports).
 */
export type HostAccess = 'required' | 'optional' | 'custom' | 'none';

/**
 * How sure we are that the DOM selectors match the live site. Every adapter is tested only
 * against synthetic fixtures modelled on public exporters and the sites' own bundles.
 */
export type SelectorConfidence = 'high' | 'medium' | 'low';

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  maker: string;
  category: ProviderCategory;
  /** Match patterns of the pages that may be captured (content-script matches). */
  matchPatterns: string[];
  hostAccess: HostAccess;
  /**
   * Extra pages of a `required` provider that were added later and therefore need a runtime
   * grant (for example www.kimi.ai). Ignored for other host-access kinds.
   */
  optionalMatchPatterns?: string[];
  /**
   * `passive`: captured as the user reads. `explicit`: only when the user asks for this tab
   * (Settings → Capture → "Capture this tab"); used where the same pages also hold private,
   * non-AI conversations.
   */
  captureMode: 'passive' | 'explicit';
  /** Whether capture is on for a fresh profile (optional providers also need host access). */
  defaultEnabled: boolean;
  /** Query parameters that identify the conversation; kept in canonical URLs. */
  idParams?: string[];
  selectorConfidence: SelectorConfidence;
  /** How a captured conversation can be reopened. */
  reopen: 'web' | 'terminal' | 'none';
  /** Short description shown in settings. */
  captureNote: string;
}

type Entry = Omit<ProviderInfo, 'id' | 'hostAccess' | 'captureMode' | 'defaultEnabled' | 'reopen'> &
  Partial<Pick<ProviderInfo, 'hostAccess' | 'captureMode' | 'defaultEnabled' | 'reopen'>>;

/** Legacy providers: required hosts, passive capture, on by default. */
function legacy(id: ProviderId, entry: Entry): ProviderInfo {
  return { id, hostAccess: 'required', captureMode: 'passive', defaultEnabled: true, reopen: 'web', ...entry };
}

/** Providers on new hosts: host access is requested from the Settings toggle; off until then. */
function optional(id: ProviderId, entry: Entry): ProviderInfo {
  return { id, hostAccess: 'optional', captureMode: 'passive', defaultEnabled: false, reopen: 'web', ...entry };
}

/** Self-hosted apps and the catch-all: only on sites the user adds. */
function custom(id: ProviderId, entry: Entry): ProviderInfo {
  return { id, hostAccess: 'custom', captureMode: 'passive', defaultEnabled: true, reopen: 'web', ...entry };
}

export const PROVIDERS: Record<ProviderId, ProviderInfo> = {
  chatgpt: legacy('chatgpt', {
    label: 'ChatGPT',
    maker: 'OpenAI',
    category: 'chat',
    matchPatterns: ['https://chatgpt.com/*', 'https://chat.openai.com/*'],
    idParams: [],
    selectorConfidence: 'high',
    captureNote: 'Chats, custom GPTs and ChatGPT Projects (project name is used for auto-filing).',
  }),
  claude: legacy('claude', {
    label: 'Claude',
    maker: 'Anthropic',
    category: 'chat',
    matchPatterns: ['https://claude.ai/*'],
    selectorConfidence: 'high',
    captureNote: 'Chats on claude.ai, including chats inside Claude Projects.',
  }),
  claude_code: legacy('claude_code', {
    label: 'Claude Code',
    maker: 'Anthropic',
    category: 'coding_agent',
    matchPatterns: ['https://claude.ai/*'],
    reopen: 'terminal',
    selectorConfidence: 'high',
    captureNote:
      'Claude Code on the web (claude.ai/code) plus local CLI sessions imported from ~/.claude/projects.',
  }),
  codex: legacy('codex', {
    label: 'Codex',
    maker: 'OpenAI',
    category: 'coding_agent',
    matchPatterns: ['https://chatgpt.com/*'],
    reopen: 'terminal',
    selectorConfidence: 'high',
    captureNote:
      'Codex cloud tasks (chatgpt.com/codex) plus local Codex CLI sessions imported from ~/.codex/sessions.',
  }),
  grok: legacy('grok', {
    label: 'Grok',
    maker: 'xAI',
    category: 'chat',
    matchPatterns: ['https://grok.com/*'],
    selectorConfidence: 'medium',
    captureNote: 'Conversations on grok.com.',
  }),
  grok_x: legacy('grok_x', {
    label: 'Grok on X',
    maker: 'xAI',
    category: 'chat',
    // X is a single-page app: /i/grok is reached without a page load, so scripts run on every
    // X page. Only /i/grok is ever captured (see detectProviderFromUrl).
    matchPatterns: ['https://x.com/*', 'https://twitter.com/*'],
    idParams: ['conversation'],
    selectorConfidence: 'high',
    captureNote:
      'Grok conversations inside X (x.com/i/grok), read from the conversation data X itself loads. Other X pages are never captured.',
  }),
  gemini: legacy('gemini', {
    label: 'Gemini',
    maker: 'Google',
    category: 'chat',
    matchPatterns: ['https://gemini.google.com/*'],
    selectorConfidence: 'medium',
    captureNote: 'Conversations and Gems on gemini.google.com.',
  }),
  ai_studio: legacy('ai_studio', {
    label: 'Google AI Studio',
    maker: 'Google',
    category: 'chat',
    matchPatterns: ['https://aistudio.google.com/*'],
    selectorConfidence: 'medium',
    captureNote: 'Saved prompts and chats on aistudio.google.com.',
  }),
  perplexity: legacy('perplexity', {
    label: 'Perplexity',
    maker: 'Perplexity',
    category: 'search',
    matchPatterns: ['https://www.perplexity.ai/*', 'https://perplexity.ai/*'],
    selectorConfidence: 'medium',
    captureNote: 'Threads on perplexity.ai.',
  }),
  deepseek: legacy('deepseek', {
    label: 'DeepSeek',
    maker: 'DeepSeek',
    category: 'chat',
    matchPatterns: ['https://chat.deepseek.com/*'],
    selectorConfidence: 'medium',
    captureNote: 'Chats on chat.deepseek.com.',
  }),
  mistral: legacy('mistral', {
    label: 'Le Chat',
    maker: 'Mistral',
    category: 'chat',
    matchPatterns: ['https://chat.mistral.ai/*'],
    selectorConfidence: 'low',
    captureNote: 'Chats on chat.mistral.ai.',
  }),
  copilot: legacy('copilot', {
    label: 'Copilot',
    maker: 'Microsoft',
    category: 'chat',
    matchPatterns: [
      'https://copilot.microsoft.com/*',
      'https://copilot.com/*',
      'https://www.copilot.com/*',
    ],
    selectorConfidence: 'medium',
    captureNote: 'Chats on copilot.microsoft.com and copilot.com (copilot.com/chat/conversation/…).',
  }),
  kimi: legacy('kimi', {
    label: 'Kimi',
    maker: 'Moonshot AI',
    category: 'chat',
    matchPatterns: ['https://www.kimi.com/*', 'https://kimi.com/*', 'https://kimi.ai/*'],
    // The international site (Aug 2026). Asked for at runtime so the update does not disable
    // the extension with a new install-time permission.
    optionalMatchPatterns: ['https://www.kimi.ai/*'],
    selectorConfidence: 'medium',
    captureNote: 'Chats on kimi.com and kimi.ai.',
  }),
  imported: {
    id: 'imported',
    label: 'Imported',
    maker: 'Other',
    category: 'chat',
    matchPatterns: [],
    hostAccess: 'none',
    captureMode: 'passive',
    defaultEnabled: false,
    selectorConfidence: 'high',
    reopen: 'none',
    captureNote: 'Threads imported from files that do not belong to a known provider.',
  },

  chatgpt_dots: legacy('chatgpt_dots', {
    label: 'ChatGPT dots',
    maker: 'OpenAI',
    category: 'agent',
    matchPatterns: ['https://chatgpt.com/*'],
    selectorConfidence: 'medium',
    captureNote:
      'Your always-on dots on chatgpt.com/dots. The page does not show a conversation id, so each dot is filed by its own identity on the page.',
  }),
  claude_duet: legacy('claude_duet', {
    label: 'Claude Duet',
    maker: 'Anthropic',
    category: 'agent',
    matchPatterns: ['https://claude.ai/*'],
    selectorConfidence: 'low',
    captureNote: 'Claude Duet on claude.ai/duet (the main chat and its channels).',
  }),
  grok_bot: legacy('grok_bot', {
    label: 'Grok Bot',
    maker: 'xAI',
    category: 'agent',
    matchPatterns: ['https://x.com/*', 'https://twitter.com/*'],
    captureMode: 'explicit',
    defaultEnabled: false,
    selectorConfidence: 'low',
    captureNote:
      'Your Grok Bot through X Chat (x.com/i/chat). X Chat also holds your private messages, so a chat is saved only when you open it and choose "Capture this tab"; nothing on X Chat is ever read on its own.',
  }),

  muse: optional('muse', {
    label: 'Muse',
    maker: 'Meta',
    category: 'agent',
    matchPatterns: ['https://muse.ai/*', 'https://www.muse.ai/*'],
    selectorConfidence: 'low',
    captureNote: 'Meta’s Muse agent on muse.ai (threads at muse.ai/thread/…).',
  }),
  meta_ai: optional('meta_ai', {
    label: 'Meta AI',
    maker: 'Meta',
    category: 'chat',
    matchPatterns: ['https://www.meta.ai/*', 'https://meta.ai/*'],
    selectorConfidence: 'medium',
    captureNote: 'Chats on meta.ai (meta.ai/prompt/…).',
  }),
  poe: optional('poe', {
    label: 'Poe',
    maker: 'Quora',
    category: 'chat',
    matchPatterns: ['https://poe.com/*'],
    selectorConfidence: 'low',
    captureNote: 'Chats with any bot on poe.com (poe.com/chat/…).',
  }),
  huggingchat: optional('huggingchat', {
    label: 'HuggingChat',
    maker: 'Hugging Face',
    category: 'chat',
    matchPatterns: ['https://huggingface.co/chat*'],
    selectorConfidence: 'high',
    captureNote: 'Chats on huggingface.co/chat. Other Hugging Face pages are never read.',
  }),
  qwen: optional('qwen', {
    label: 'Qwen Chat',
    maker: 'Alibaba',
    category: 'chat',
    matchPatterns: ['https://chat.qwen.ai/*'],
    selectorConfidence: 'high',
    captureNote: 'Chats on chat.qwen.ai.',
  }),
  doubao: optional('doubao', {
    label: 'Doubao',
    maker: 'ByteDance',
    category: 'chat',
    matchPatterns: ['https://www.doubao.com/*'],
    selectorConfidence: 'high',
    captureNote: 'Chats on doubao.com (豆包).',
  }),
  zai: optional('zai', {
    label: 'Z.ai',
    maker: 'Zhipu',
    category: 'chat',
    matchPatterns: ['https://chat.z.ai/*', 'https://zchat.z.ai/*'],
    selectorConfidence: 'high',
    captureNote: 'GLM chats on chat.z.ai.',
  }),
  manus: optional('manus', {
    label: 'Manus',
    maker: 'Manus',
    category: 'agent',
    matchPatterns: ['https://manus.im/*', 'https://www.manus.im/*'],
    selectorConfidence: 'medium',
    captureNote: 'Manus tasks (manus.im/app/…): your requests and Manus’s replies; tool steps are left out.',
  }),
  genspark: optional('genspark', {
    label: 'Genspark',
    maker: 'Genspark',
    category: 'agent',
    matchPatterns: ['https://www.genspark.ai/*', 'https://genspark.ai/*'],
    idParams: ['id'],
    selectorConfidence: 'high',
    captureNote: 'Genspark agent chats (genspark.ai/agents?id=…).',
  }),
  minimax_agent: optional('minimax_agent', {
    label: 'MiniMax Agent',
    maker: 'MiniMax',
    category: 'agent',
    matchPatterns: ['https://agent.minimax.io/*', 'https://agent.minimaxi.com/*'],
    idParams: ['id'],
    selectorConfidence: 'low',
    captureNote: 'MiniMax Agent sessions (agent.minimax.io/?id=…).',
  }),
  character_ai: optional('character_ai', {
    label: 'Character.AI',
    maker: 'Character.AI',
    category: 'companion',
    matchPatterns: ['https://character.ai/*'],
    idParams: ['hist'],
    selectorConfidence: 'medium',
    captureNote: 'Chats with characters on character.ai. A chat opened from History keeps its own id.',
  }),
  duck_ai: optional('duck_ai', {
    label: 'Duck.ai',
    maker: 'DuckDuckGo',
    category: 'chat',
    matchPatterns: ['https://duck.ai/*'],
    idParams: ['chatID'],
    selectorConfidence: 'high',
    captureNote: 'Saved chats on duck.ai. Chats that Duck.ai does not save are not captured either.',
  }),
  lumo: optional('lumo', {
    label: 'Lumo',
    maker: 'Proton',
    category: 'chat',
    matchPatterns: ['https://lumo.proton.me/*'],
    selectorConfidence: 'medium',
    captureNote: 'Chats on lumo.proton.me.',
  }),
  arena: optional('arena', {
    label: 'Arena',
    maker: 'LMArena',
    category: 'chat',
    matchPatterns: ['https://arena.ai/*', 'https://lmarena.ai/*'],
    selectorConfidence: 'low',
    captureNote: 'Chats and battles on arena.ai (formerly LMArena).',
  }),
  t3_chat: optional('t3_chat', {
    label: 'T3 Chat',
    maker: 'T3',
    category: 'chat',
    matchPatterns: ['https://t3.chat/*'],
    selectorConfidence: 'low',
    captureNote: 'Chats on t3.chat.',
  }),
  gemini_notebook: optional('gemini_notebook', {
    label: 'Gemini Notebook',
    maker: 'Google',
    category: 'chat',
    matchPatterns: ['https://notebook.google.com/*', 'https://notebooklm.google.com/*'],
    selectorConfidence: 'medium',
    captureNote: 'The chat inside each notebook (formerly NotebookLM).',
  }),
  github_copilot: optional('github_copilot', {
    label: 'GitHub Copilot',
    maker: 'GitHub',
    category: 'coding_agent',
    matchPatterns: ['https://github.com/*'],
    selectorConfidence: 'low',
    captureNote:
      'Copilot chats and agent tasks on github.com/copilot, and agent sessions on pull requests. No other GitHub page is read.',
  }),
  cursor_agents: optional('cursor_agents', {
    label: 'Cursor agents',
    maker: 'Anysphere',
    category: 'coding_agent',
    matchPatterns: ['https://cursor.com/*', 'https://www.cursor.com/*'],
    idParams: ['id'],
    selectorConfidence: 'low',
    captureNote: 'Cursor background agents on cursor.com/agents.',
  }),
  devin: optional('devin', {
    label: 'Devin',
    maker: 'Cognition',
    category: 'coding_agent',
    matchPatterns: ['https://app.devin.ai/*'],
    selectorConfidence: 'low',
    captureNote: 'Devin sessions on app.devin.ai.',
  }),
  jules: optional('jules', {
    label: 'Jules',
    maker: 'Google',
    category: 'coding_agent',
    matchPatterns: ['https://jules.google.com/*'],
    selectorConfidence: 'low',
    captureNote: 'Jules tasks on jules.google.com.',
  }),
  lovable: optional('lovable', {
    label: 'Lovable',
    maker: 'Lovable',
    category: 'builder',
    matchPatterns: ['https://lovable.dev/*'],
    selectorConfidence: 'medium',
    captureNote: 'The chat of each Lovable project.',
  }),
  bolt: optional('bolt', {
    label: 'Bolt',
    maker: 'StackBlitz',
    category: 'builder',
    matchPatterns: ['https://bolt.new/*'],
    selectorConfidence: 'low',
    captureNote: 'The chat of each Bolt project (bolt.new/~/…).',
  }),
  v0: optional('v0', {
    label: 'v0',
    maker: 'Vercel',
    category: 'builder',
    matchPatterns: ['https://v0.app/*', 'https://v0.dev/*'],
    selectorConfidence: 'low',
    captureNote: 'v0 chats (v0.app/chat/…).',
  }),
  replit: optional('replit', {
    label: 'Replit Agent',
    maker: 'Replit',
    category: 'builder',
    matchPatterns: ['https://replit.com/*'],
    selectorConfidence: 'low',
    captureNote: 'The Agent chat inside your Replit apps (replit.com/@you/app).',
  }),
  lobechat: optional('lobechat', {
    label: 'LobeChat',
    maker: 'LobeHub',
    category: 'chat',
    matchPatterns: ['https://app.lobehub.com/*'],
    idParams: ['session', 'topic'],
    selectorConfidence: 'low',
    captureNote: 'LobeChat on app.lobehub.com. Self-hosted LobeChat is recognised on sites you add below.',
  }),

  custom_web: custom('custom_web', {
    label: 'Other AI sites',
    maker: 'Any',
    category: 'chat',
    matchPatterns: [],
    selectorConfidence: 'low',
    captureNote: 'Sites you add yourself. Messages are found by their roles on the page.',
  }),
  open_webui: custom('open_webui', {
    label: 'Open WebUI',
    maker: 'Self-hosted',
    category: 'chat',
    matchPatterns: [],
    selectorConfidence: 'medium',
    captureNote: 'Recognised on sites you add.',
  }),
  librechat: custom('librechat', {
    label: 'LibreChat',
    maker: 'Self-hosted',
    category: 'chat',
    matchPatterns: [],
    selectorConfidence: 'medium',
    captureNote: 'Recognised on sites you add.',
  }),
  anythingllm: custom('anythingllm', {
    label: 'AnythingLLM',
    maker: 'Self-hosted',
    category: 'chat',
    matchPatterns: [],
    selectorConfidence: 'low',
    captureNote: 'Recognised on sites you add.',
  }),
};

export const CAPTURE_PROVIDER_IDS = PROVIDER_IDS.filter(
  (id): id is CaptureProviderId => id !== 'imported'
);

/** Providers captured only on sites the user adds (the catch-all and recognised self-hosted apps). */
export const CUSTOM_SITE_PROVIDER_IDS: CaptureProviderId[] = ['custom_web', 'open_webui', 'librechat', 'lobechat', 'anythingllm'];

/** Providers whose pages need a runtime host grant (the toggle in Settings asks for it). */
export const OPTIONAL_PROVIDER_IDS = CAPTURE_PROVIDER_IDS.filter((id) => PROVIDERS[id].hostAccess === 'optional');

export function providerCategory(id: ProviderId | string): ProviderCategory {
  return isProviderId(id) ? PROVIDERS[id].category : 'chat';
}

export function isProviderCategory(value: unknown): value is ProviderCategory {
  return typeof value === 'string' && (PROVIDER_CATEGORIES as readonly string[]).includes(value);
}

/**
 * Install-time match patterns for manifest host_permissions and the static content scripts:
 * only `required` providers. Deduplicated.
 */
export function captureMatchPatterns(): string[] {
  return Array.from(
    new Set(
      CAPTURE_PROVIDER_IDS.filter((id) => PROVIDERS[id].hostAccess === 'required').flatMap(
        (id) => PROVIDERS[id].matchPatterns
      )
    )
  );
}

/**
 * The patterns of a provider that need a runtime grant and a runtime-registered content script:
 * every pattern of an `optional` provider, the `optionalMatchPatterns` of a `required` one.
 */
export function runtimeMatchPatterns(id: ProviderId): string[] {
  const info = PROVIDERS[id];
  if (info.hostAccess === 'optional') return [...info.matchPatterns];
  if (info.hostAccess === 'required') return [...(info.optionalMatchPatterns ?? [])];
  return [];
}

/** Every pattern any provider can ask for at runtime (documentation for the manifest; covered by https://*\/*). */
export function optionalCaptureMatchPatterns(): string[] {
  return Array.from(new Set(CAPTURE_PROVIDER_IDS.flatMap((id) => runtimeMatchPatterns(id))));
}

/** Host-permission origins for a provider's runtime patterns (permissions.request ignores paths). */
export function runtimePermissionOrigins(id: ProviderId): string[] {
  return toOriginMatchPatterns(runtimeMatchPatterns(id));
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

/** True when a match pattern (scheme://host/path) covers the URL. Ports in the URL are ignored, as Chrome does. */
export function matchPatternCovers(pattern: string, url: string): boolean {
  const m = pattern.trim().match(/^(\*|https?):\/\/(\*|(?:\*\.)?[^/*:]+)(\/.*)$/i);
  if (!m) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
  if (m[1] === '*' ? scheme !== 'http' && scheme !== 'https' : scheme !== m[1].toLowerCase()) return false;
  const hostPattern = m[2].toLowerCase();
  const host = parsed.hostname.toLowerCase();
  if (hostPattern !== '*') {
    if (hostPattern.startsWith('*.')) {
      const base = hostPattern.slice(2);
      if (host !== base && !host.endsWith(`.${base}`)) return false;
    } else if (host !== hostPattern) {
      return false;
    }
  }
  const pathRe = new RegExp(
    `^${m[3].replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
  );
  return pathRe.test(`${parsed.pathname}${parsed.search}`);
}

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerLabel(id: ProviderId | string): string {
  return isProviderId(id) ? PROVIDERS[id].label : String(id);
}

const X_HOST_RE = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/;

/** x.com / twitter.com (with optional www. or mobile.), where only /i/grok and /i/chat are AI pages. */
export function isXHostname(hostname: string): boolean {
  return X_HOST_RE.test(hostname.toLowerCase());
}

const KIMI_HOSTS = new Set(['www.kimi.com', 'kimi.com', 'kimi.ai', 'www.kimi.ai']);
const COPILOT_HOSTS = new Set(['copilot.microsoft.com', 'copilot.com', 'www.copilot.com']);

/** Hosts that belong to one provider entirely. Path-routed hosts are handled in providerForPage. */
const HOST_PROVIDERS: Record<string, ProviderId> = {
  'grok.com': 'grok',
  'gemini.google.com': 'gemini',
  'aistudio.google.com': 'ai_studio',
  'chat.deepseek.com': 'deepseek',
  'chat.mistral.ai': 'mistral',
  'muse.ai': 'muse',
  'www.muse.ai': 'muse',
  'meta.ai': 'meta_ai',
  'www.meta.ai': 'meta_ai',
  'poe.com': 'poe',
  'chat.qwen.ai': 'qwen',
  'www.doubao.com': 'doubao',
  'chat.z.ai': 'zai',
  'zchat.z.ai': 'zai',
  'www.zchat.z.ai': 'zai',
  'manus.im': 'manus',
  'www.manus.im': 'manus',
  'genspark.ai': 'genspark',
  'www.genspark.ai': 'genspark',
  'agent.minimax.io': 'minimax_agent',
  'agent.minimaxi.com': 'minimax_agent',
  'character.ai': 'character_ai',
  'duck.ai': 'duck_ai',
  'lumo.proton.me': 'lumo',
  'arena.ai': 'arena',
  'lmarena.ai': 'arena',
  't3.chat': 't3_chat',
  'notebook.google.com': 'gemini_notebook',
  'notebooklm.google.com': 'gemini_notebook',
  'app.devin.ai': 'devin',
  'jules.google.com': 'jules',
  'bolt.new': 'bolt',
  'v0.app': 'v0',
  'v0.dev': 'v0',
  'app.lobehub.com': 'lobechat',
};

/** Provider that owns a page by host and path alone (no test hints). */
function providerForPage(parsed: URL): ProviderId | null {
  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname;
  if (host === 'chatgpt.com' || host.endsWith('.chatgpt.com') || host === 'chat.openai.com') {
    if (/^(?:\/u\/[^/]+)?\/dots(\/|$)/.test(path)) return 'chatgpt_dots';
    return /^(?:\/u\/[^/]+)?\/codex(\/|$)/.test(path) ? 'codex' : 'chatgpt';
  }
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) {
    if (/^\/duet(\/|$)/.test(path)) return 'claude_duet';
    return /^\/code(\/|$)/.test(path) ? 'claude_code' : 'claude';
  }
  if (host.endsWith('.grok.com')) return 'grok';
  // Inside X only /i/grok (Grok) and /i/chat (X Chat, where a Grok Bot lives) are AI pages.
  if (isXHostname(host)) {
    if (/^\/i\/grok(\/|$)/.test(path)) return 'grok_x';
    if (/^\/i\/chat(\/|$)/.test(path)) return 'grok_bot';
    return null;
  }
  if (host === 'perplexity.ai' || host.endsWith('.perplexity.ai')) return 'perplexity';
  if (COPILOT_HOSTS.has(host)) return 'copilot';
  if (KIMI_HOSTS.has(host)) return 'kimi';
  if (host === 'huggingface.co') return /^\/chat(\/|$)/.test(path) ? 'huggingchat' : null;
  if (host === 'github.com') {
    if (/^\/copilot(\/|$)/.test(path)) return 'github_copilot';
    if (/^\/[^/]+\/[^/]+\/pull\/\d+\/agent-sessions(\/|$)/.test(path)) return 'github_copilot';
    return null;
  }
  if (host === 'cursor.com' || host === 'www.cursor.com') {
    return /^\/agents(\/|$)/.test(path) ? 'cursor_agents' : null;
  }
  if (host === 'lovable.dev') return /^\/projects\//.test(path) ? 'lovable' : null;
  if (host === 'replit.com') return /^\/@[^/]+\/[^/]+/.test(path) ? 'replit' : null;
  return HOST_PROVIDERS[host] ?? null;
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
  return isProviderId(hinted) && PROVIDERS[hinted].hostAccess !== 'custom' ? hinted : null;
}

/**
 * True for an https page of a provider whose host Threadkeeper holds from install: the pages
 * that get the static content script and may host the overlay (the overlay frame is only web
 * accessible there). Unlike detectProviderFromUrl it ignores the tk_provider test hint, so an
 * arbitrary site cannot opt itself in.
 */
export function isCapturePageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const owner = parsed.protocol === 'https:' ? providerForPage(parsed) : null;
    return owner !== null && PROVIDERS[owner].hostAccess === 'required' && matchesAny(PROVIDERS[owner].matchPatterns, url);
  } catch {
    return false;
  }
}

function matchesAny(patterns: readonly string[], url: string): boolean {
  return patterns.some((p) => matchPatternCovers(p, url));
}

/**
 * Whether a capture claiming `provider` may come from a page at `url`: the page must be one of
 * the provider's own pages. Routing between providers that share a host (chatgpt / codex /
 * chatgpt_dots) is not enforced, because a single-page app can change its path between the
 * read and the send. Custom-site providers are never allowed here (see custom-sites.ts).
 */
export function isProviderAllowedOnUrl(provider: ProviderId, url: string): boolean {
  const info = PROVIDERS[provider];
  if (info.hostAccess !== 'required' && info.hostAccess !== 'optional') return false;
  const patterns = [...info.matchPatterns, ...(info.optionalMatchPatterns ?? [])];
  return patterns.some((p) => matchPatternCovers(p, url));
}

const SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

function safeId(value: string | null | undefined): string | null {
  if (!value) return null;
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return null;
  }
  return SAFE_ID_RE.test(decoded) ? decoded : null;
}

function firstMatch(path: string, re: RegExp): string | null {
  const m = path.match(re);
  return m ? m[1] : null;
}

/**
 * Conversation id for providers that have their own URL rule. `undefined` means "use the
 * generic patterns"; `null` means "this page has no conversation id".
 */
function providerConversationId(provider: ProviderId, parsed: URL): string | null | undefined {
  const path = parsed.pathname;
  const q = (key: string) => safeId(parsed.searchParams.get(key));
  switch (provider) {
    case 'grok_x':
      // https://x.com/i/grok?conversation=<id>; a bare /i/grok is a new, unsaved chat.
      return q('conversation');
    case 'grok_bot':
      // X Chat: /i/chat/<conversationId> (group ids look like 123-456).
      return safeId(firstMatch(path, /^\/i\/chat\/([^/?#]+)/));
    case 'ai_studio': {
      const m = firstMatch(path, /^\/prompts\/([a-zA-Z0-9_-]+)(?:\/|$)/);
      return m && m !== 'new_chat' ? m : null;
    }
    case 'kimi':
      return firstMatch(path, /^\/chat\/([0-9a-f-]{36}|[a-z0-9]{20})(?:\/|$)/);
    case 'copilot':
      // copilot.com/chat/conversation/<uuid> (2026) and the older /chats/<id>.
      return (
        firstMatch(path, /^\/chat\/conversation\/([a-zA-Z0-9_-]+)/) ??
        firstMatch(path, /^\/chats\/([a-zA-Z0-9_-]+)/)
      );
    case 'chatgpt_dots': {
      // A dot's own page: /dots/<account>~<dot>. /dots/home shows no id (the adapter reads the page).
      const m = path.match(/^(?:\/u\/[^/]+)?\/dots\/([A-Za-z0-9][\w-]{0,63})~([A-Za-z0-9][\w-]{0,63})(?:\/|$)/);
      return m ? `dot_${m[1]}_${m[2]}` : null;
    }
    case 'claude_duet': {
      const chan = firstMatch(path, /^\/duet\/(chan_[A-Za-z0-9_-]+)/);
      if (chan) return chan;
      return /^\/duet\/?$/.test(path) ? 'duet_main' : null;
    }
    case 'muse': {
      const thread = firstMatch(path, /^\/thread\/([A-Za-z0-9_-]+)\/?$/);
      if (thread) return thread === 'new' ? null : thread;
      return path === '/' || path === '' ? 'main' : null;
    }
    case 'meta_ai':
      return firstMatch(path, /^\/prompt\/([A-Za-z0-9_-]+)\/?$/);
    case 'poe':
      return firstMatch(path, /^\/chat\/([A-Za-z0-9]+)\/?$/);
    case 'huggingchat':
      // 24-hex ids are conversations; 7-character ids under the same path are share links.
      return firstMatch(path, /^\/chat\/conversation\/([0-9a-f]{24})\/?$/);
    case 'qwen':
    case 'zai':
    case 'arena':
      return firstMatch(path, /^\/c\/([0-9A-Za-z][0-9A-Za-z_-]{7,})(?:\/|$)/);
    case 'doubao': {
      const id = firstMatch(path, /^\/(?:code\/)?chat\/([A-Za-z0-9_-]+)/);
      return id && id !== 'new' && !id.startsWith('local') ? id : null;
    }
    case 'manus':
      return firstMatch(path, /^\/app\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
    case 'genspark':
      return /^\/agents\/?$/.test(path) ? q('id') : null;
    case 'minimax_agent':
      return /^\/(?:mavis\/?)?$/.test(path) ? q('id') : null;
    case 'character_ai': {
      const character = firstMatch(path, /^\/chat\/([A-Za-z0-9_-]{8,128})\/?$/);
      if (!character) return null;
      // ?hist=<chat id> names the chat; without it the page shows the latest chat with the character.
      return q('hist') ?? `c_${character}`;
    }
    case 'duck_ai':
      // Duck.ai writes ?chatID= only for saved chats; an unsaved chat is never captured.
      return q('chatID');
    case 'lumo':
      return firstMatch(path, /^(?:\/u\/\d+)?\/c\/([0-9A-Fa-f-]{8,})(?:\/|$)/);
    case 't3_chat':
      return firstMatch(path, /^\/chat\/([A-Za-z0-9_-]+)(?:\/|$)/);
    case 'gemini_notebook':
      return firstMatch(path, /^\/notebook\/([A-Za-z0-9_-]+)(?:\/|$)/);
    case 'github_copilot': {
      const chat = firstMatch(path, /^\/copilot\/c\/([A-Za-z0-9_-]+)/);
      if (chat) return chat;
      const task = firstMatch(path, /^\/copilot\/tasks\/([A-Za-z0-9_-]+)/);
      if (task) return `task_${task}`;
      const m = path.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/agent-sessions\/([A-Za-z0-9_-]+)/);
      return m ? `session_${m[4]}` : null;
    }
    case 'cursor_agents': {
      const id = firstMatch(path, /^\/agents\/(bc-[A-Za-z0-9_-]+)/) ?? q('id');
      return id && id.startsWith('bc-') ? id : null;
    }
    case 'devin':
      return firstMatch(path, /^\/sessions\/([A-Za-z0-9_-]+)/);
    case 'jules':
      return firstMatch(path, /^\/(?:session|task)\/([A-Za-z0-9_-]+)/);
    case 'lovable':
      return firstMatch(path, /^\/projects\/([A-Za-z0-9_-]+)/);
    case 'bolt':
      return safeId(firstMatch(path, /^\/~\/([A-Za-z0-9_.-]+)/)?.replace(/\./g, '_'));
    case 'v0': {
      const id = firstMatch(path, /^\/chat\/([A-Za-z0-9_-]+)/);
      return id && id !== 'new' ? id : null;
    }
    case 'replit': {
      const m = path.match(/^\/@([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)/);
      return m ? safeId(`${m[1]}_${m[2].replace(/\./g, '_')}`) : null;
    }
    case 'lobechat': {
      const topic = q('topic');
      const session = q('session');
      return topic ? (session ? `${session}_${topic}` : topic) : session;
    }
    case 'custom_web':
    case 'open_webui':
    case 'librechat':
    case 'anythingllm':
    case 'imported':
      return null;
    default:
      return undefined;
  }
}

/** Extract a stable conversation id from a provider URL. */
export function extractConversationIdFromUrl(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const owner = providerForPage(parsed);
  if (owner) {
    const specific = providerConversationId(owner, parsed);
    if (specific !== undefined) return specific;
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
  // Test hint, only on pages no provider owns (fixtures served from localhost).
  return owner ? null : parsed.searchParams.get('tk_conv_id');
}

/** Query parameters that identify a conversation on this provider's pages (kept in canonical URLs). */
export function conversationQueryParams(provider: ProviderId | null): string[] {
  const own = provider ? PROVIDERS[provider].idParams ?? [] : [];
  return Array.from(new Set(['conversation', ...own]));
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
