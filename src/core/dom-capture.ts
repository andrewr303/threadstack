import {
  detectProviderFromUrl,
  extractChatGptProjectSlug,
  extractConversationIdFromUrl,
  isProviderId,
  parseChatGptProjectRoute,
  type ProviderId,
} from './providers.js';
import type { UpsertThreadInput } from './db.js';
import type { GrokXMessage } from './grok-x.js';

export interface DomExtractionResult {
  provider: ProviderId;
  sourceConversationId: string;
  branchId: string;
  canonicalUrl: string;
  title: string;
  coverage: 'partial' | 'title_only';
  messages: UpsertThreadInput['messages'];
  providerProjectName: string | null;
  modelSlug: string | null;
}

type TurnRole = 'user' | 'assistant' | 'tool';

interface RawTurn {
  el: Element;
  role: TurnRole;
  body?: Element | null;
  /** Several content blocks of one message (a reply with text on both sides of a widget), read in order. */
  bodies?: Element[];
  id?: string | null;
  model?: string | null;
}

interface DomAdapter {
  turns(doc: Document): RawTurn[];
  title(doc: Document, url: string, conversationId: string): string | null;
  project?(doc: Document, url: string): string | null;
  isStreaming?(el: Element): boolean;
  /** Blocks inside a reply that are not its text (reasoning, thinking); `:scope` is the reply body. */
  strip?: string;
}

const SKIP_TAGS = new Set([
  'BUTTON',
  'SVG',
  'STYLE',
  'SCRIPT',
  'NOSCRIPT',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'TEMPLATE',
  'IMG',
  'VIDEO',
  'AUDIO',
  'CANVAS',
  'FORM',
]);

const BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'UL',
  'OL',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'TABLE',
  'TR',
  'SECTION',
  'ARTICLE',
  'HEADER',
  'FOOTER',
  'HR',
]);

/**
 * Structure-aware text extraction: keeps paragraph and list breaks, renders code
 * blocks as fenced code, and drops buttons, icons and screen-reader-only labels
 * ("Copy code", "You said:") that `textContent` would otherwise merge in.
 */
export function extractReadableText(root: Element, skipSelector?: string): string {
  const out: string[] = [];
  const skipped = new Set<Element>(skipSelector ? Array.from(root.querySelectorAll(skipSelector)) : []);
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag) || skipped.has(el)) return;
    if (el.getAttribute('aria-hidden') === 'true') return;
    if (el.classList.contains('sr-only')) return;
    if (tag === 'BR') {
      out.push('\n');
      return;
    }
    if (tag === 'PRE') {
      const code = el.querySelector('code') ?? el;
      const lang = (code.className.match(/language-([\w+-]+)/) ?? [])[1] ?? '';
      out.push(`\n\`\`\`${lang}\n${(code.textContent ?? '').replace(/\n+$/, '')}\n\`\`\`\n`);
      return;
    }
    const block = BLOCK_TAGS.has(tag);
    if (block) out.push('\n');
    if (tag === 'LI') out.push('- ');
    for (const child of Array.from(el.childNodes)) walk(child);
    if (block) out.push('\n');
  };
  walk(root);
  return out
    .join('')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+(?=\S)/g, (m) => (m.includes('- ') ? m : '\n'))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Keep only outermost matches so nested wrappers never double-count a turn. */
function outermost(elements: Element[]): Element[] {
  const set = new Set(elements);
  return elements.filter((el) => {
    let p = el.parentElement;
    while (p) {
      if (set.has(p)) return false;
      p = p.parentElement;
    }
    return true;
  });
}

function cleanDocTitle(doc: Document, suffixes: RegExp): string | null {
  const t = doc.title.replace(suffixes, '').trim();
  return t.length > 0 ? t : null;
}

function firstText(doc: Document | Element, selectors: string[]): string | null {
  for (const sel of selectors) {
    const el = doc.querySelector(sel);
    const text = el?.textContent?.replace(/\s+/g, ' ').trim();
    if (text) return text;
  }
  return null;
}

/**
 * First readable text among the selectors' matches that is not a placeholder such as
 * "New chat". Buttons and screen-reader labels inside a sidebar row are ignored.
 */
function firstTitle(doc: Document, selectors: string[], placeholder: RegExp): string | null {
  for (const sel of selectors) {
    for (const el of Array.from(doc.querySelectorAll(sel))) {
      const text = extractReadableText(el).replace(/\s+/g, ' ').trim();
      if (text && !placeholder.test(text)) return text;
    }
  }
  return null;
}

const MESSAGE_KEY_ATTRS = [
  'data-turn-key', // ChatGPT, Claude
  'data-message-id',
  'data-virtual-list-item-key', // DeepSeek
  'data-archer-id', // Kimi
] as const;
const MESSAGE_KEY_SELECTOR = MESSAGE_KEY_ATTRS.map((attr) => `[${attr}]`).join(', ');

function ownMessageKey(el: Element): string | null {
  for (const attr of MESSAGE_KEY_ATTRS) {
    const value = el.getAttribute(attr)?.trim();
    if (value) return value;
  }
  return null;
}

/**
 * A key that names the same message wherever a virtualized list renders it: the adapter's
 * id (data-message-id, as before, so stored ids do not change), then the turn's own key
 * attribute, then the nearest keyed ancestor. Positional ids shift with the scroll
 * position, so they are only the last resort.
 */
function stableMessageKey(turn: RawTurn): string | null {
  if (turn.id) return turn.id;
  const own = ownMessageKey(turn.el);
  if (own) return own;
  const holder = turn.el.parentElement?.closest(MESSAGE_KEY_SELECTOR);
  return holder ? ownMessageKey(holder) : null;
}

/** Repository name from the first GitHub link on a coding-agent page (Claude Code / Codex web). */
function repoFromGithubLink(doc: Document): string | null {
  const link = doc.querySelector('main a[href*="github.com/"], header a[href*="github.com/"]');
  const href = link?.getAttribute('href') ?? '';
  const m = href.match(/github\.com\/[^/]+\/([^/?#]+)/);
  return m ? m[1].replace(/\.git$/, '') : null;
}

const GENERIC_ROLE_SELECTOR = [
  '[data-message-author-role]',
  '[data-testid^="conversation-turn"]',
  '[data-tk-message-role]',
].join(', ');

function genericRole(el: Element): TurnRole {
  const roleAttr =
    el.getAttribute('data-message-author-role') ||
    el.getAttribute('data-tk-message-role') ||
    el.querySelector('[data-message-author-role]')?.getAttribute('data-message-author-role') ||
    // ChatGPT's turn wrapper names its speaker even when the message inside has not rendered yet.
    el.getAttribute('data-turn') ||
    (el.classList.contains('font-user-message') ? 'user' : 'assistant');
  return roleAttr === 'user' || roleAttr === 'human'
    ? 'user'
    : roleAttr === 'tool'
      ? 'tool'
      : 'assistant';
}

/** The content blocks of one message: its explicit content node, else every rendered markdown block. */
function messageBodies(el: Element): { body: Element | null; bodies?: Element[] } {
  const explicit = el.querySelector('[data-message-content]');
  if (explicit) return { body: explicit };
  const markdown = outermost(Array.from(el.querySelectorAll('.markdown')));
  if (markdown.length > 1) return { body: markdown[0], bodies: markdown };
  return { body: markdown[0] ?? el.querySelector('.whitespace-pre-wrap') ?? null };
}

function messageTurn(el: Element, container: Element): RawTurn {
  const withRole = el.hasAttribute('data-message-author-role') ? el : container;
  return {
    el,
    role: genericRole(withRole),
    ...messageBodies(el),
    id:
      el.getAttribute('data-message-id') ||
      el.querySelector('[data-message-id]')?.getAttribute('data-message-id') ||
      null,
    model:
      el.getAttribute('data-message-model-slug') ||
      el.querySelector('[data-message-model-slug]')?.getAttribute('data-message-model-slug') ||
      null,
  };
}

/**
 * Explicit role attributes shared by several providers and by Threadkeeper test fixtures.
 *
 * A ChatGPT turn can hold several messages (a preamble, a tool step, the final answer); each
 * is its own turn so none of them is lost behind the first one.
 */
function genericTurns(doc: Document): RawTurn[] {
  const turns: RawTurn[] = [];
  for (const container of outermost(Array.from(doc.querySelectorAll(GENERIC_ROLE_SELECTOR)))) {
    const own = container.hasAttribute('data-message-author-role') ? [container] : [];
    const inner = outermost(Array.from(container.querySelectorAll('[data-message-author-role]')));
    const messages = own.length > 0 ? own : inner;
    if (messages.length > 1) {
      for (const el of messages) turns.push(messageTurn(el, container));
    } else {
      turns.push(messageTurn(container, container));
    }
  }
  return turns;
}

const HEURISTIC_USER = /(^|[-_\s])(user|human|query|prompt)([-_\s]|$)/i;
const HEURISTIC_ASSISTANT = /(^|[-_\s])(assistant|bot|ai|model|response|answer)([-_\s]|$)/i;

/**
 * Last-resort extraction for unknown or changed markup: elements whose test id,
 * role attribute or class names say "user message" / "assistant message", then
 * rendered markdown blocks as assistant turns.
 */
function heuristicTurns(doc: Document): RawTurn[] {
  const candidates = Array.from(
    doc.querySelectorAll(
      '[data-testid*="message" i], [data-role], [data-author], [class*="message" i], [data-content$="message"]'
    )
  ).filter(
    (el) => !el.closest('nav, aside, form, [contenteditable="true"], [contenteditable="plaintext-only"]')
  );
  const turns: RawTurn[] = [];
  for (const el of outermost(candidates)) {
    const descriptor = [
      el.getAttribute('data-testid'),
      el.getAttribute('data-role'),
      el.getAttribute('data-author'),
      el.getAttribute('data-content'),
      typeof el.className === 'string' ? el.className : '',
    ]
      .filter(Boolean)
      .join(' ');
    if (HEURISTIC_USER.test(descriptor)) turns.push({ el, role: 'user' });
    else if (HEURISTIC_ASSISTANT.test(descriptor)) turns.push({ el, role: 'assistant' });
  }
  if (turns.length > 0) return turns;
  return outermost(
    Array.from(doc.querySelectorAll('.markdown, .prose, .ds-markdown, message-content'))
  ).map((el) => ({ el, role: 'assistant' as const }));
}

/** Untitled-chat labels ChatGPT shows per locale; never a conversation title. */
const CHATGPT_PLACEHOLDER_TITLE = /^(ChatGPT|Codex|New chat|Nuevo chat|Neuer Chat|Nouveau chat)$/i;
const CHATGPT_STREAMING =
  '[data-message-streaming="true"], [data-is-streaming="true"], .result-streaming';

/** Project name for a ChatGPT Project route: sidebar label, then URL slug, then "ChatGPT - {name}". */
function chatgptProjectName(doc: Document, url: string): string | null {
  const route = parseChatGptProjectRoute(url);
  if (!route) return null;
  const hex = route.projectId.replace(/^g-p-/i, '');
  for (const row of Array.from(doc.querySelectorAll('[data-app-action-sidebar-project-id]'))) {
    const id = row.getAttribute('data-app-action-sidebar-project-id') ?? '';
    if (id !== route.projectId && id !== hex && !id.startsWith(`${route.projectId}-`)) continue;
    const label = row.getAttribute('data-app-action-sidebar-project-label')?.replace(/\s+/g, ' ').trim();
    if (label) return label;
  }
  const fromSlug = extractChatGptProjectSlug(url);
  if (fromSlug) return fromSlug;
  const fromTitle = doc.title.match(/^ChatGPT\s+[-–—]\s+(.+)$/)?.[1]?.trim();
  return fromTitle || null;
}

const chatgptAdapter: DomAdapter = {
  turns(doc) {
    const turns = genericTurns(doc);
    // While reasoning, ChatGPT shows a transient "Thinking" assistant message that has no
    // model slug; the real replies carry one.
    const slugged = turns.some((t) => t.role === 'assistant' && t.model);
    return slugged ? turns.filter((t) => t.role !== 'assistant' || t.model) : turns;
  },
  title(doc, url, conversationId) {
    const id = conversationId ? CSS_ESCAPE(conversationId) : '';
    const sidebar = firstTitle(
      doc,
      [
        ...(id
          ? [
              `nav a[aria-current="page"][href$="/c/${id}"]`,
              `#stage-slideover-sidebar a[aria-current="page"][href$="/c/${id}"]`,
              `nav a[href$="/c/${id}"]`,
            ]
          : []),
        'nav a[aria-current="page"][href*="/c/"]',
        '#stage-slideover-sidebar a[aria-current="page"][href*="/c/"]',
      ],
      CHATGPT_PLACEHOLDER_TITLE
    );
    if (sidebar) return sidebar;
    // "ChatGPT - {name}" is a project page title, not a conversation title.
    if (/^ChatGPT\s+[-–—]\s+/.test(doc.title)) return null;
    const t = cleanDocTitle(doc, /\s*[-|]\s*(ChatGPT|Codex).*$/i);
    return t && !CHATGPT_PLACEHOLDER_TITLE.test(t) ? t : null;
  },
  project(doc, url) {
    return (
      chatgptProjectName(doc, url) ??
      (detectProviderFromUrl(url) === 'codex' ? repoFromGithubLink(doc) : null)
    );
  },
  isStreaming(el) {
    return Boolean(el.closest(CHATGPT_STREAMING) || el.querySelector(CHATGPT_STREAMING));
  },
};

const CLAUDE_TURN_SELECTOR = [
  '[data-testid="user-message"]',
  '.font-claude-response:not(#markdown-artifact)',
  '.font-claude-message',
  '[data-testid="assistant-message"]',
].join(', ');
const CLAUDE_PLACEHOLDER_TITLE = /^(Claude|Claude Code|New chat|New session|Untitled)$/i;

const claudeAdapter: DomAdapter = {
  turns(doc) {
    const generic = genericTurns(doc);
    const turns =
      generic.length > 0
        ? generic
        : outermost(Array.from(doc.querySelectorAll(CLAUDE_TURN_SELECTOR))).map((el) => ({
            el,
            role: el.matches('[data-testid="user-message"]')
              ? ('user' as const)
              : ('assistant' as const),
          }));
    // An open artifact is rendered with the reply font; it is not a message.
    return turns.filter((t) => !t.el.closest('#markdown-artifact'));
  },
  title(doc) {
    const t =
      firstTitle(
        doc,
        [
          '[data-row-key^="chat:"][aria-current]:not([aria-current="false"]) [data-row-label]',
          '[aria-current="page"]',
          '[data-conversation-title]',
          '[data-testid="chat-title-button"]',
          '[data-testid="chat-menu-trigger"]',
        ],
        CLAUDE_PLACEHOLDER_TITLE
      ) ?? cleanDocTitle(doc, /\s*[-|]\s*Claude.*$/i);
    return t && !CLAUDE_PLACEHOLDER_TITLE.test(t) ? t : null;
  },
  // A reply's direct child with the transition-all class is the collapsible thinking block.
  strip: ':scope > [class*="transition-all"]',
  project(doc, url) {
    const links = Array.from(doc.querySelectorAll('a[href^="/project/"]')).filter(
      (a) => !a.closest('nav, aside')
    );
    const name = links[0]?.textContent?.replace(/\s+/g, ' ').trim();
    if (name) return name;
    return detectProviderFromUrl(url) === 'claude_code' ? repoFromGithubLink(doc) : null;
  },
  isStreaming(el) {
    return Boolean(
      el.closest('[data-is-streaming="true"]') || el.querySelector('[data-is-streaming="true"]')
    );
  },
};

const grokAdapter: DomAdapter = {
  turns(doc) {
    const containers = Array.from(doc.querySelectorAll('[id^="response-"]'));
    const fromContainers = containers
      .map((el) => {
        const bubble =
          el.querySelector('.response-content-markdown') ?? el.querySelector('.message-bubble') ?? el;
        const isUser =
          /\bitems-end\b/.test(typeof el.className === 'string' ? el.className : '') ||
          Boolean(el.querySelector('.items-end .message-bubble'));
        return { el, body: bubble, role: isUser ? ('user' as const) : ('assistant' as const) };
      })
      .filter((t) => t.body);
    if (fromContainers.length > 0) return fromContainers;
    return Array.from(doc.querySelectorAll('.message-bubble')).map((el) => ({
      el,
      role: el.closest('.items-end') ? ('user' as const) : ('assistant' as const),
    }));
  },
  title(doc) {
    const t = cleanDocTitle(doc, /\s*[-|]\s*Grok.*$/i);
    return t && !/^Grok$/i.test(t) ? t : null;
  },
};

const geminiAdapter: DomAdapter = {
  turns(doc) {
    return Array.from(doc.querySelectorAll('user-query, model-response')).map((el) => {
      const isUser = el.tagName.toLowerCase() === 'user-query';
      return {
        el,
        role: isUser ? ('user' as const) : ('assistant' as const),
        body: isUser
          ? el.querySelector('.query-text, user-query-content') ?? el
          : el.querySelector('message-content, .markdown') ?? el,
      };
    });
  },
  title(doc) {
    const selected = firstTitle(
      doc,
      [
        '[data-test-id="conversation-title"]',
        'conversation-actions .conversation-title',
        '.conversation.selected .conversation-title',
        '[data-test-id="conversation"].selected',
        '.selected .conversation-title',
        'mat-list-item.mdc-list-item--activated [mat-line]',
      ],
      /^(Google\s+)?Gemini$/i
    );
    if (selected) return selected;
    const t = cleanDocTitle(doc, /\s*[-|]\s*(Google\s+)?Gemini.*$/i);
    return t && !/^(Google\s+)?Gemini$/i.test(t) ? t : null;
  },
  strip: 'model-thoughts',
};

const perplexityAdapter: DomAdapter = {
  turns(doc) {
    const nodes = Array.from(
      doc.querySelectorAll('main h1, [class*="group/query"], [data-testid="query-text"], main .prose')
    );
    return outermost(nodes).map((el) => ({
      el,
      role: el.matches('.prose') ? ('assistant' as const) : ('user' as const),
    }));
  },
  title(doc) {
    const t = cleanDocTitle(doc, /\s*[-|]\s*Perplexity.*$/i);
    return t && !/^Perplexity$/i.test(t) ? t : null;
  },
};

const DEEPSEEK_THINKING = '.ds-think-content';

const deepseekAdapter: DomAdapter = {
  turns(doc) {
    const messages = Array.from(doc.querySelectorAll('.ds-message'));
    if (messages.length > 0) {
      return outermost(messages).map((el) => {
        const isAssistant = Boolean(
          el.querySelector(`.ds-markdown, .ds-assistant-message-main-content, ${DEEPSEEK_THINKING}`)
        );
        if (!isAssistant) return { el, role: 'user' as const };
        // The reasoning is rendered as markdown too; the answer is the markdown outside it.
        const answer = Array.from(el.querySelectorAll('.ds-markdown')).find(
          (md) => !md.closest(DEEPSEEK_THINKING)
        );
        return {
          el,
          body: answer ?? el.querySelector('.ds-assistant-message-main-content') ?? el,
          role: 'assistant' as const,
        };
      });
    }
    return [];
  },
  title(doc) {
    const t = cleanDocTitle(doc, /\s*[-|]\s*DeepSeek.*$/i);
    return t && !/^DeepSeek$/i.test(t) ? t : null;
  },
  strip: DEEPSEEK_THINKING,
};

const COPILOT_USER_TURN = '.group\\/user-message, [data-content="user-message"]';
const COPILOT_TURN = [
  COPILOT_USER_TURN,
  '.group\\/ai-message',
  '.group\\/ai-message-item',
  '[data-content="ai-message"]',
].join(', ');

const copilotAdapter: DomAdapter = {
  turns(doc) {
    return outermost(Array.from(doc.querySelectorAll(COPILOT_TURN))).map((el) => {
      const isUser = el.matches(COPILOT_USER_TURN);
      return {
        el,
        role: isUser ? ('user' as const) : ('assistant' as const),
        body: isUser
          ? el.querySelector('[data-content="user-message"]') ?? el
          : el.querySelector('.group\\/ai-message-item') ?? el,
      };
    });
  },
  title(doc) {
    const t = cleanDocTitle(doc, /\s*[-|]\s*(Microsoft\s+)?Copilot.*$/i);
    return t && !/^(Microsoft\s+)?Copilot/i.test(t) ? t : null;
  },
};

const AI_STUDIO_USER_TURN = '.user-prompt-container, [data-turn-role="User"]';

const aiStudioAdapter: DomAdapter = {
  turns(doc) {
    return outermost(
      Array.from(
        doc.querySelectorAll(
          `${AI_STUDIO_USER_TURN}, .model-prompt-container, [data-turn-role="Model"]`
        )
      )
    ).map((el) => ({
      el,
      role: el.matches(AI_STUDIO_USER_TURN) ? ('user' as const) : ('assistant' as const),
    }));
  },
  title(doc) {
    const t = cleanDocTitle(doc, /\s*[-|]\s*Google AI Studio.*$/i);
    return t && !/^(Google AI Studio|Untitled prompt|New chat)$/i.test(t) ? t : null;
  },
};

const kimiAdapter: DomAdapter = {
  turns(doc) {
    return outermost(Array.from(doc.querySelectorAll('.segment-user, .segment-assistant'))).map(
      (el) => ({
        el,
        role: el.matches('.segment-user') ? ('user' as const) : ('assistant' as const),
      })
    );
  },
  title(doc) {
    const t = cleanDocTitle(doc, /\s+-\s+Kimi$/i);
    return t && !/^Kimi$/i.test(t) ? t : null;
  },
  strip: '.thinking-container',
};

const mistralAdapter: DomAdapter = {
  turns: () => [],
  title(doc) {
    const t = cleanDocTitle(doc, /\s*[-|]\s*(Le Chat|Mistral).*$/i);
    return t && !/^(Le Chat|Mistral)/i.test(t) ? t : null;
  },
};

const ADAPTERS: Record<ProviderId, DomAdapter> = {
  chatgpt: chatgptAdapter,
  codex: chatgptAdapter,
  claude: claudeAdapter,
  claude_code: claudeAdapter,
  grok: grokAdapter,
  // No DOM selectors are known; captured from X's own responses instead (grok-x.ts).
  grok_x: { turns: () => [], title: () => null },
  gemini: geminiAdapter,
  ai_studio: aiStudioAdapter,
  perplexity: perplexityAdapter,
  deepseek: deepseekAdapter,
  mistral: mistralAdapter,
  copilot: copilotAdapter,
  kimi: kimiAdapter,
  imported: { turns: () => [], title: () => null },
};

function CSS_ESCAPE(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function unixToIsoOrNull(ts: string | null): string | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

export function extractVisibleDomConversation(
  doc: Document,
  locationHref: string
): DomExtractionResult | null {
  const providerAttr = doc.documentElement.getAttribute('data-tk-provider');
  const provider: ProviderId | null = isProviderId(providerAttr)
    ? providerAttr
    : detectProviderFromUrl(locationHref);
  // Grok on X is read from X's own responses (grok-x.ts); its DOM is never scraped.
  if (!provider || provider === 'imported' || provider === 'grok_x') return null;

  const convIdAttr =
    doc.documentElement.getAttribute('data-tk-conversation-id') ||
    doc.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id');
  const sourceConversationId = convIdAttr || extractConversationIdFromUrl(locationHref);
  if (!sourceConversationId) return null;

  const branchAttr =
    doc.querySelector('[data-branch-id]')?.getAttribute('data-branch-id') ||
    doc.documentElement.getAttribute('data-tk-branch-id') ||
    'main';
  const branchId = branchAttr.trim() || 'main';

  const adapter = ADAPTERS[provider];
  let turns = adapter.turns(doc);
  if (turns.length === 0 && provider !== 'claude' && provider !== 'chatgpt') {
    turns = genericTurns(doc);
  }
  if (turns.length === 0 && provider !== 'claude' && provider !== 'chatgpt') {
    turns = heuristicTurns(doc);
  }

  const messages: UpsertThreadInput['messages'] = [];
  const usedIds = new Set<string>();
  let modelSlug: string | null = null;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const el = turn.el;

    // Never capture the composer or an unsent draft
    if (
      el.closest(
        'form, [data-testid="composer"], [contenteditable="true"], [contenteditable="plaintext-only"]'
      )
    ) {
      continue;
    }

    // Never capture an in-progress streaming response
    if (
      el.getAttribute('data-streaming') === 'true' ||
      el.classList.contains('result-streaming') ||
      el.querySelector('[data-streaming="true"], .result-streaming') ||
      adapter.isStreaming?.(el)
    ) {
      continue;
    }

    const skip = turn.role === 'user' ? undefined : adapter.strip;
    const text = turn.bodies
      ? turn.bodies
          .map((b) => extractReadableText(b, skip))
          .filter(Boolean)
          .join('\n\n')
      : extractReadableText(turn.body ?? el, skip);
    if (!text) continue;

    if (turn.model) modelSlug = turn.model;

    const timeEl = el.querySelector('time[datetime]');
    const explicitTs =
      el.getAttribute('data-message-timestamp') || timeEl?.getAttribute('datetime') || null;

    // Turns that share a keyed ancestor stay distinct, in a stable order.
    const baseId = stableMessageKey(turn) ?? `${sourceConversationId}_${branchId}_m_${i}`;
    let sourceMessageId = baseId;
    for (let n = 2; usedIds.has(sourceMessageId); n++) sourceMessageId = `${baseId}#${n}`;
    usedIds.add(sourceMessageId);

    messages.push({
      sourceMessageId,
      role: turn.role,
      content: text,
      createdAt: unixToIsoOrNull(explicitTs),
      branchPath: branchId,
    });
  }

  const adapterTitle = adapter.title(doc, locationHref, sourceConversationId);
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  const derivedTitle = firstUser
    ? firstUser.replace(/\s+/g, ' ').slice(0, 80).trim()
    : '';
  const title = (adapterTitle || derivedTitle || 'Untitled conversation').trim();

  return {
    provider,
    sourceConversationId,
    branchId,
    canonicalUrl: canonicalizeConversationUrl(locationHref),
    title,
    coverage: messages.length > 0 ? 'partial' : 'title_only',
    messages,
    providerProjectName: adapter.project?.(doc, locationHref) ?? null,
    modelSlug,
  };
}

/** The provider's own project (ChatGPT/Claude Project, coding-agent repository) shown on this page. */
export function extractProviderProjectName(doc: Document, locationHref: string): string | null {
  const providerAttr = doc.documentElement.getAttribute('data-tk-provider');
  const provider: ProviderId | null = isProviderId(providerAttr) ? providerAttr : detectProviderFromUrl(locationHref);
  if (!provider) return null;
  return ADAPTERS[provider].project?.(doc, locationHref) ?? null;
}

/** The one URL a Grok-on-X conversation is filed under, whichever X host it was opened on. */
export function grokXCanonicalUrl(conversationId: string): string {
  return `https://x.com/i/grok?conversation=${encodeURIComponent(conversationId)}`;
}

/**
 * A Grok-on-X conversation read from X's own GrokConversationItemsByRestId responses, in
 * the same shape as a DOM capture. Coverage stays partial: only what X loaded is seen.
 */
export function grokXConversationToExtraction(
  conversationId: string,
  messages: GrokXMessage[]
): DomExtractionResult {
  const firstUser = messages.find((m) => m.role === 'user')?.text ?? '';
  const derivedTitle = firstUser.replace(/\s+/g, ' ').slice(0, 80).trim();
  return {
    provider: 'grok_x',
    sourceConversationId: conversationId,
    branchId: 'main',
    canonicalUrl: grokXCanonicalUrl(conversationId),
    title: derivedTitle || 'Untitled conversation',
    coverage: messages.length > 0 ? 'partial' : 'title_only',
    messages: messages.map((m) => ({
      sourceMessageId: m.id,
      role: m.role,
      content: m.text,
      createdAt: m.createdAt,
      branchPath: 'main',
    })),
    providerProjectName: null,
    modelSlug: null,
  };
}

/** Strip query strings and fragments that do not identify the conversation. */
export function canonicalizeConversationUrl(href: string): string {
  if (detectProviderFromUrl(href) === 'grok_x') {
    const conv = extractConversationIdFromUrl(href);
    return conv ? grokXCanonicalUrl(conv) : 'https://x.com/i/grok';
  }
  try {
    const u = new URL(href);
    const keep = new URLSearchParams();
    const conv = u.searchParams.get('conversation');
    if (conv) keep.set('conversation', conv);
    const qs = keep.toString();
    return `${u.origin}${u.pathname}${qs ? `?${qs}` : ''}`;
  } catch {
    return href;
  }
}
