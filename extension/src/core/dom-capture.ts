import {
  PROVIDERS,
  conversationQueryParams,
  detectProviderFromUrl,
  extractChatGptProjectSlug,
  extractConversationIdFromUrl,
  isProviderId,
  parseChatGptProjectRoute,
  providerCategory,
  type ProviderId,
} from './providers.js';
import { normalizePullRequestUrl, normalizeRepository, repositoryName } from './repository.js';
import { fnv1a32Hex, siteConversationKey } from './custom-sites.js';
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
  /** Where the turns came from: the provider's adapter, or the generic / heuristic fallbacks. */
  method: 'adapter' | 'generic' | 'heuristic' | 'none';
  /**
   * The page gives no reliable "still writing" signal for these turns, so the caller should only
   * send a capture whose text has stopped changing (content.ts checks two reads in a row).
   */
  stabilize: boolean;
}

/** An added site (Settings → Capture → Any AI site) the background confirmed for this page. */
export interface CaptureSiteContext {
  origin: string;
}

export interface ExtractOptions {
  /** Set only from the background's answer for this page; never from the page itself. */
  site?: CaptureSiteContext | null;
  /** The user asked for this tab (needed by explicit-only providers such as Grok Bot). */
  explicit?: boolean;
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
  /** A conversation id read from the page when the URL has none (ChatGPT dots on /dots/home). */
  conversationId?(doc: Document, url: string): string | null;
  /** Present anywhere in the page while a reply is being written: the newest assistant turn is skipped. */
  docStreaming?: string;
  /** No dependable streaming signal: send only text that has stopped changing. */
  stabilize?: boolean;
  /** No message ids in the page and the list grows at the top: ids from the content instead of positions. */
  hashIds?: boolean;
  /** Never fall back to the generic / heuristic readers (their guesses would be wrong here). */
  noFallback?: boolean;
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
 * Explicit role attributes shared by several providers and by ThreadStack test fixtures.
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

// ---- Adapters for the opt-in providers ------------------------------------------------------
// Every selector below comes from public exporters or the sites' own bundles (see the provider
// registry's selectorConfidence and README → Providers). None was checked against a signed-in
// page; the generic and heuristic readers stay behind them as fallbacks.

interface RoleAdapterSpec {
  /** Turn elements (outermost matches only). */
  turns: string;
  /** Limits `turns` to this container when present. */
  scope?: string;
  isUser(el: Element): boolean;
  userBody?: string;
  assistantBody?: string;
  /** Read every outermost match of `assistantBody` (replies split by widgets). */
  assistantBodies?: boolean;
  /** Turns to leave out (suggested follow-ups, start-of-chat cards). */
  exclude?: string;
  idOf?(el: Element): string | null;
  title(doc: Document, url: string, conversationId: string): string | null;
  strip?: string;
  docStreaming?: string;
  isStreaming?(el: Element): boolean;
  stabilize?: boolean;
  hashIds?: boolean;
  noFallback?: boolean;
  conversationId?(doc: Document, url: string): string | null;
  project?(doc: Document, url: string): string | null;
}

function roleAdapter(spec: RoleAdapterSpec): DomAdapter {
  return {
    turns(doc) {
      const scope = (spec.scope && doc.querySelector(spec.scope)) || doc;
      return outermost(Array.from(scope.querySelectorAll(spec.turns)))
        .filter((el) => !(spec.exclude && (el.matches(spec.exclude) || el.closest(spec.exclude))))
        .map((el) => {
          const user = spec.isUser(el);
          const bodySel = user ? spec.userBody : spec.assistantBody;
          let body: Element | null = null;
          let bodies: Element[] | undefined;
          if (bodySel) {
            if (!user && spec.assistantBodies) {
              const all = outermost(Array.from(el.querySelectorAll(bodySel)));
              if (all.length > 1) bodies = all;
              body = all[0] ?? null;
            } else {
              body = el.matches(bodySel) ? el : el.querySelector(bodySel);
            }
          }
          return { el, role: user ? ('user' as const) : ('assistant' as const), body: body ?? el, bodies, id: spec.idOf?.(el) ?? null };
        });
    },
    title: spec.title,
    project: spec.project,
    strip: spec.strip,
    docStreaming: spec.docStreaming,
    isStreaming: spec.isStreaming,
    stabilize: spec.stabilize,
    hashIds: spec.hashIds,
    noFallback: spec.noFallback,
    conversationId: spec.conversationId,
  };
}

/** document.title without a product suffix (or prefix), or null when only the product name is left. */
function titleWithout(doc: Document, product: RegExp, placeholder?: RegExp): string | null {
  const t = doc.title
    .replace(new RegExp(`\\s*[-|–—•·:]\\s*(?:${product.source})\\s*$`, 'i'), '')
    .replace(new RegExp(`^\\s*(?:${product.source})\\s*[-|–—•·:]\\s*`, 'i'), '')
    .trim();
  if (!t || new RegExp(`^(?:${product.source})$`, 'i').test(t)) return null;
  if (placeholder && placeholder.test(t)) return null;
  return t;
}

const hasClass = (el: Element, name: string) => el.classList.contains(name);
const matchesAnyOf = (el: Element, sel: string) => el.matches(sel) || Boolean(el.querySelector(sel));

/** ChatGPT dots (chatgpt.com/dots): a messaging layout, `.self` marks your own messages (ghost-in-the-loop, 2026-11). */
const DOTS_ROW = '.messaging-root .message-list .message-row[data-message-id], .message-list .message-row[data-message-id]';

function dotIdentity(doc: Document): string | null {
  // 1. The dot's own link in the page (/dots/<account>~<dot>).
  for (const a of Array.from(doc.querySelectorAll('a[href*="/dots/"]'))) {
    const current = a.getAttribute('aria-current');
    if (current && current !== 'false') {
      const m = (a.getAttribute('href') ?? '').match(/\/dots\/([A-Za-z0-9][\w-]{0,63})~([A-Za-z0-9][\w-]{0,63})/);
      if (m) return `dot_${m[1]}_${m[2]}`;
    }
  }
  // 2. Ids the messaging layout carries (room or thread).
  const holder = doc.querySelector('.messaging-root [data-room-id], .messaging-root [data-thread-id], [data-messaging-room-id]');
  const raw =
    holder?.getAttribute('data-room-id') || holder?.getAttribute('data-thread-id') || holder?.getAttribute('data-messaging-room-id');
  if (raw && /^[\w-]{1,100}$/.test(raw)) return `room_${raw}`;
  // 3. The dot's name in the conversation header: stable for as long as the dot keeps its name.
  const name = firstText(doc, [
    '.messaging-root [data-testid="dot-name"]',
    '.messaging-root header h1',
    '.messaging-root header h2',
    '.messaging-root [class*="header"] [class*="name"]',
  ]);
  return name ? `dotname_${fnv1a32Hex(name.toLowerCase())}` : null;
}

const chatgptDotsAdapter = roleAdapter({
  turns: DOTS_ROW,
  isUser: (el) => hasClass(el, 'self'),
  userBody: '.message-text',
  assistantBody: '.message-text',
  idOf: (el) => el.getAttribute('data-message-id'),
  title(doc) {
    const name = firstText(doc, ['.messaging-root [data-testid="dot-name"]', '.messaging-root header h1', '.messaging-root header h2']);
    return name ? `${name} (dot)` : null;
  },
  conversationId: dotIdentity,
  stabilize: true,
  noFallback: true,
});

/** Claude Duet (claude.ai/duet): selectors guessed from claude.ai's chat markup. */
const claudeDuetAdapter: DomAdapter = {
  ...claudeAdapter,
  title(doc) {
    const t = firstText(doc, ['[data-testid="duet-channel-name"]', '[data-testid="chat-title-button"]']) ?? cleanDocTitle(doc, /\s*[-|]\s*Claude.*$/i);
    return t && !/^(Claude|Duet|Claude Duet)$/i.test(t) ? t : null;
  },
  stabilize: true,
};

/**
 * Grok Bot through X Chat (x.com/i/chat). The chat renders inside an open shadow root, and the
 * page also holds human DMs, so this adapter is used only when the user asks for this tab.
 * Selectors from x-dm-export / x-chat-exporter (2026); roles are not marked, so own messages are
 * recognised by their alignment classes (low confidence).
 */
function xChatRoot(doc: Document): ParentNode | null {
  if (doc.querySelector('[data-testid="dm-message-scroller"]')) return doc;
  for (const el of Array.from(doc.querySelectorAll('main *'))) {
    const root = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
    if (root && root.querySelector('[data-testid="dm-conversation-more-button"], [data-testid="dm-message-scroller"]')) return root;
  }
  return null;
}

const X_CHAT_OWN = /(^|\s)(justify-end|items-end|self-end|flex-row-reverse|ml-auto)(\s|$)/;

const grokBotAdapter: DomAdapter = {
  turns(doc) {
    const root = xChatRoot(doc);
    if (!root) return [];
    const rows = Array.from(root.querySelectorAll('[data-testid^="message-"]')).filter(
      (el) => !/^message-text-/.test(el.getAttribute('data-testid') ?? '')
    );
    return outermost(rows).map((el) => {
      const testId = el.getAttribute('data-testid') ?? '';
      const own =
        el.getAttribute('data-own') === 'true' ||
        X_CHAT_OWN.test(typeof el.className === 'string' ? el.className : '') ||
        Boolean(el.querySelector(':scope > [class*="justify-end"], :scope > [class*="items-end"]'));
      return {
        el,
        role: own ? ('user' as const) : ('assistant' as const),
        body: el.querySelector('[data-testid^="message-text-"]') ?? el,
        id: testId.replace(/^message-/, '') || null,
      };
    });
  },
  title(doc) {
    const root = xChatRoot(doc);
    const header = root?.querySelector('[data-testid="dm-conversation-header"]');
    const name = header ? extractReadableText(header).split('\n')[0]?.trim() : '';
    return name ? `${name} on X Chat` : null;
  },
  stabilize: true,
  noFallback: true,
};

/** Meta AI (meta.ai/prompt/…): from the site's own React bundle (2026-11), medium-high. */
const META_ASSISTANT = '[data-testid="assistant-message"]';
const metaAiAdapter = roleAdapter({
  turns: '[data-message-item][data-message-id], [data-message-item]',
  scope: 'div[role="feed"]',
  isUser: (el) => el.hasAttribute('data-user-message') || Boolean(el.querySelector('[data-message-type="user"]')),
  userBody: '[data-message-type="user"]',
  assistantBody: META_ASSISTANT,
  idOf: (el) => el.getAttribute('data-message-id'),
  strip: '[data-testid^="subagent-cot"], [data-testid="sources-pill"], [data-testid="source-search-pill"], [data-testid="skip-reasoning-button"]',
  isStreaming: (el) =>
    Boolean(el.querySelector(`${META_ASSISTANT}[data-streaming-state="STREAMING"], ${META_ASSISTANT}[data-streaming-state="INIT"]`)),
  title(doc, _url, id) {
    const sidebar = id
      ? firstTitle(doc, [`[data-testid="conversation-item"] a[href$="/prompt/${CSS_ESCAPE(id)}"]`, `[data-testid="conversation-item"][href$="/prompt/${CSS_ESCAPE(id)}"]`], /^(Meta AI|New chat)$/i)
      : null;
    if (sidebar) return sidebar;
    const clean = doc.title.replace(/^\(\d+\+?\)\s*/, '');
    const t = clean.replace(/\s*[-|–—]\s*Meta AI.*$/i, '').trim();
    return t && !/^(Meta AI|New chat)$/i.test(t) ? t : null;
  },
});

/** Muse (muse.ai): no public selectors; message markers commonly used by React chat apps (low). */
const museAdapter = roleAdapter({
  turns: '[data-message-id][data-role], [data-message-role], [data-testid="user-message"], [data-testid="assistant-message"], [data-testid="agent-message"]',
  isUser: (el) =>
    /^(user|human)$/i.test(el.getAttribute('data-role') ?? el.getAttribute('data-message-role') ?? '') ||
    el.getAttribute('data-testid') === 'user-message',
  idOf: (el) => el.getAttribute('data-message-id'),
  title: (doc) => titleWithout(doc, /Muse(?:\s+[-—]\s+Your Personal AI Agent from Meta)?/, /^(New thread|Home)$/i),
  stabilize: true,
});

/** Poe: CSS-module class prefixes (hash suffixes rotate). Exporters 2024-2026, low-medium. */
const poeAdapter = roleAdapter({
  turns: '[class*="ChatMessage_messageRow"], [class*="ChatMessage_chatMessage"]',
  isUser: (el) => matchesAnyOf(el, '[class*="rightSideMessage"], [class*="humanMessageBubble"]'),
  userBody: '[class*="Markdown_markdownContainer"], [class*="Prose_prose"], [class*="Message_messageTextContainer"]',
  assistantBody: '[class*="Markdown_markdownContainer"], [class*="Prose_prose"], [class*="Message_messageTextContainer"]',
  idOf: (el) => el.getAttribute('data-message-id') ?? el.querySelector('[data-message-id]')?.getAttribute('data-message-id') ?? null,
  docStreaming: 'button[class*="ChatStopMessageButton"]',
  title: (doc) => titleWithout(doc, /Poe/),
  stabilize: true,
});

/** HuggingChat: chat-ui's own ChatMessage.svelte (HEAD 2026-11-03), high. */
const huggingChatAdapter = roleAdapter({
  turns: '[data-message-role="assistant"][data-message-id], [data-message-type="user"][data-message-id]',
  isUser: (el) => el.getAttribute('data-message-type') === 'user',
  userBody: 'p.disabled, .disabled',
  assistantBody: '.prose',
  assistantBodies: true,
  idOf: (el) => el.getAttribute('data-message-id'),
  docStreaming: 'button.stop-generating-btn, button[aria-label="Stop generating"]',
  title: (doc) => titleWithout(doc, /HuggingChat/, /^New Chat$/i),
});

/** Qwen Chat (ophel qwen-studio-config, 2026-11), high; data-role markup kept for the older layout. */
const QWEN_USER = '.qwen-chat-message-user, .chat-user-message-wrapper, [data-role="user"]';
const qwenAdapter = roleAdapter({
  turns: `${QWEN_USER}, .qwen-chat-message-assistant, [data-role="assistant"]`,
  isUser: (el) => el.matches(QWEN_USER),
  userBody: '.user-message-content',
  assistantBody: '.response-message-content',
  idOf: (el) =>
    el.id.match(/^(?:chat-response-message|qwen-chat-message-assistant|qwen-chat-message-user)-(.+)$/)?.[1] ??
    el.getAttribute('data-message-id'),
  strip: '.qwen-chat-thinking-status-card, .qwen-chat-thinking-tool-status-card-wraper, .response-message-footer',
  docStreaming: 'button.stop-button, [class*="stop-button"]',
  title: (doc) => titleWithout(doc, /Qwen(?:\s*Chat)?/, /^New Chat$/i),
});

/** Doubao (ophel doubao-config 2026-11, high; chat-memo-pro test ids for the older markup). */
const doubaoAdapter = roleAdapter({
  turns: '[data-target-id="message-box-target-id"] [data-message-id], [data-testid="send_message"], [data-testid="receive_message"]',
  isUser: (el) => hasClass(el, 'justify-end') || el.getAttribute('data-testid') === 'send_message',
  userBody: '.whitespace-pre-wrap, [data-testid="message_text_content"]',
  assistantBody: '.flow-markdown-body, .md-box-root, [data-testid="message_text_content"]',
  idOf: (el) => el.getAttribute('data-message-id'),
  strip: '[data-testid="think_block_collapse"]',
  docStreaming: '[data-testid="chat_input_local_break_button"], [class*="break-btn-"]',
  title(doc) {
    return (
      firstTitle(doc, ['#flow_chat_sidebar a[aria-current="page"] [data-testid="chat_list_item_title"]'], /^(新对话|New chat)$/) ??
      titleWithout(doc, /豆包|Doubao/)
    );
  },
});

/**
 * Open WebUI markup, used by Z.ai and recognised on self-hosted Open WebUI sites (ophel zai-config
 * and open-webui registry, 2026-11), high.
 */
const OWUI_TURN = '#messages-container [id^="message-"]';
function openWebUiAdapter(product: RegExp): DomAdapter {
  return roleAdapter({
    turns: OWUI_TURN,
    isUser: (el) => hasClass(el, 'user-message') || Boolean(el.querySelector(':scope > .user-message, .chat-user')),
    userBody: '.chat-user .markdown-prose, .chat-user .whitespace-pre-wrap, .chat-user',
    assistantBody: '#response-content-container, .markdown-prose:not(.chat-user)',
    idOf: (el) => el.id.replace(/^message-/, '') || null,
    strip: '.thinking-chain-container, .thinking-block, details[type="reasoning"], details[type="tool_calls"]',
    docStreaming: 'div[aria-label="停止"] button, button[aria-label="Stop"], #stop-response-button',
    title: (doc) => titleWithout(doc, product, /^(New Chat|新聊天)$/i),
  });
}
const zaiAdapter = openWebUiAdapter(/Z\.ai(?:\s*Chat)?|GLM/);
const openWebUiSiteAdapter = openWebUiAdapter(/Open WebUI/);

/** Manus (ophel manus registry 2026-11), high for turns; no streaming signal is known. */
const manusAdapter = roleAdapter({
  turns: '[data-chat-question-bubble="true"], .manus-markdown',
  scope: 'div[class*="--chat-message-list"]',
  isUser: (el) => el.getAttribute('data-chat-question-bubble') === 'true',
  exclude: '[data-chat-suggested-follow-ups]',
  title: (doc) => titleWithout(doc, /Manus/),
  stabilize: true,
});

/** Genspark (ophel + chat-memo-pro, 2026), high. */
const gensparkAdapter = roleAdapter({
  turns: '.conversation-statement',
  isUser: (el) => hasClass(el, 'user'),
  userBody: '.content',
  assistantBody: '.markdown-viewer',
  docStreaming: 'svg.stop-icon',
  title(doc) {
    const input = doc.querySelector('input.agent-name-input') as HTMLInputElement | null;
    const value = input?.value?.trim() || input?.getAttribute('value')?.trim();
    return value || firstText(doc, ['main h1']) || titleWithout(doc, /Genspark/);
  },
});

/**
 * Character.AI (Duetta exporter with 2026-10 fixtures), medium. The list is newest first, has no
 * message ids, and grows at the top, so turns are reversed and get content ids.
 */
const characterAdapter: DomAdapter = {
  turns(doc) {
    const list = doc.querySelector('#chat-messages');
    if (!list) return [];
    const turns: RawTurn[] = [];
    for (const child of Array.from(list.children)) {
      if (child.querySelector('.ticontainer')) continue; // typing indicator: still being written
      const active = child.querySelector('.swiper-slide-active') ?? child;
      const prose = active.querySelector('[data-testid="completed-message"] .prose') ?? active.querySelector('.prose');
      if (!prose) continue; // start-of-chat card, images
      const user = Boolean(child.querySelector('.flex-row-reverse'));
      const bot = Boolean(child.querySelector('.cai-badge'));
      if (user === bot) continue; // exactly one role marker, else unknown
      turns.push({ el: child, role: user ? 'user' : 'assistant', body: prose });
    }
    return turns.reverse();
  },
  title(doc) {
    const name = firstText(doc, ['#chat-header a[href^="/character/"] p']);
    return name ? `Chat with ${name}` : titleWithout(doc, /Character\.AI|character\.ai/);
  },
  isStreaming: (el) => Boolean(el.querySelector('.ticontainer')),
  hashIds: true,
  stabilize: true,
  noFallback: true,
};

/** Duck.ai (ophel duck-ai registry + the duck.ai bundle, 2026-11), high. */
const duckAdapter = roleAdapter({
  turns: '[data-testid="user-message"], [data-activeresponse="true"] > :nth-child(2)',
  isUser: (el) => el.getAttribute('data-testid') === 'user-message',
  strip: '[data-message-actions], button[data-streamdown="code-block-copy-button"]',
  title: (doc) => titleWithout(doc, /Duck\.ai|DuckDuckGo AI Chat/),
  stabilize: true,
});

/** Proton Lumo (ophel proton-lumo registry, 2026-11), medium. */
const lumoAdapter = roleAdapter({
  turns: '.lumo-chat-item[data-message-role]',
  isUser: (el) => el.getAttribute('data-message-role') === 'user',
  userBody: '.user-msg-container .lumo-markdown, .lumo-markdown',
  assistantBody: '.progressive-markdown-content, .lumo-markdown',
  strip: '.thinking-path, .action-toolbar, .user-toolbar',
  docStreaming: '.lumo-input-container button[aria-label*="Stop"], .thinking-path-header[aria-busy="true"]',
  title: (doc) => titleWithout(doc, /Lumo(?:\s+by\s+Proton)?|Proton Lumo/, /^New chat$/i),
});

/** Arena (exporter userscripts 2026), low: user bubbles align right, replies sit on the primary surface. */
const arenaAdapter = roleAdapter({
  turns: 'div.group.self-end, div[class*="bg-surface-primary"][class*="flex-col"][class*="min-w-0"]',
  isUser: (el) => hasClass(el, 'self-end'),
  assistantBody: '.prose, .markdown, [class*="prose"]',
  strip: '.thought-content, [class*="thought"]',
  title: (doc) => titleWithout(doc, /(?:LM)?Arena(?:\.ai)?/),
  stabilize: true,
});

/** T3 Chat: no public selectors; the role attributes most chat apps carry (low). */
const t3Adapter = roleAdapter({
  turns: '[data-message-role], [data-role="user"], [data-role="assistant"], [aria-label="Your message"], [aria-label="Assistant message"]',
  isUser: (el) =>
    /^user$/i.test(el.getAttribute('data-message-role') ?? el.getAttribute('data-role') ?? '') || el.getAttribute('aria-label') === 'Your message',
  title: (doc) => titleWithout(doc, /T3\s*Chat/, /^New Thread$/i),
  stabilize: true,
});

/** Gemini Notebook / NotebookLM (decant, 2026-10), medium. */
const notebookAdapter = roleAdapter({
  turns: '.from-user-container, .to-user-container',
  isUser: (el) => hasClass(el, 'from-user-container'),
  strip: 'button.citation-marker, mat-icon',
  title(doc) {
    return (
      firstText(doc, ['.notebook-title', 'input.title-input', '[data-test-id="notebook-title"]']) ??
      titleWithout(doc, /NotebookLM|Gemini Notebook|Google NotebookLM/, /^Untitled notebook$/i)
    );
  },
  stabilize: true,
});

/** GitHub Copilot on github.com: guessed from GitHub's CSS-module naming (low). */
const githubCopilotAdapter = roleAdapter({
  turns: '[class*="UserMessage-module__container"], [class*="CopilotMessage-module__container"], [class*="AssistantMessage-module__container"], [data-testid="user-message"], [data-testid="copilot-message"]',
  isUser: (el) => /UserMessage-module/.test(typeof el.className === 'string' ? el.className : '') || el.getAttribute('data-testid') === 'user-message',
  assistantBody: '.markdown-body',
  title: (doc) => titleWithout(doc, /GitHub Copilot|Copilot|GitHub/),
  stabilize: true,
  project(_doc, url) {
    const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/agent-sessions\//);
    return m ? m[2] : null;
  },
});

/** Cursor background agents: title only; the repository name is the project, like Claude Code and Codex. */
const cursorAgentsAdapter: DomAdapter = {
  ...titleOnlyAdapter(/Cursor(?:\s*Agents?)?/),
  project(doc, url) {
    const repository = extractRepositoryInfo(doc, url).repository;
    return repository ? repositoryName(repository) : null;
  },
};

/** Lovable (lovable-chat-exporter, 2026-10), medium: user message ids start with umsg_. */
const lovableAdapter = roleAdapter({
  turns: '[data-message-id]',
  isUser: (el) => (el.getAttribute('data-message-id') ?? '').startsWith('umsg_'),
  userBody: '[class*="PromptBox_customProse"], .prose',
  assistantBody: '.prose',
  assistantBodies: true,
  idOf: (el) => el.getAttribute('data-message-id'),
  title(doc) {
    return firstText(doc, ['nav button span.truncate', 'header button span.truncate']) ?? titleWithout(doc, /Lovable/);
  },
  stabilize: true,
});

/** Bolt (bolt-automations exporter, 2025), low. */
const boltAdapter = roleAdapter({
  turns: 'section[aria-label="Chat"] div[data-message-id], div[data-message-id]',
  isUser: (el) => hasClass(el, 'self-end'),
  userBody: 'div[class*="_MarkdownContent_"]',
  assistantBody: 'div[class*="_MarkdownContent_"]',
  assistantBodies: true,
  idOf: (el) => el.getAttribute('data-message-id'),
  title: (doc) => titleWithout(doc, /Bolt(?:\.new)?|bolt\.new/),
  stabilize: true,
});

/** Coding agents and builders without public selectors: generic readers plus a product title (low). */
function titleOnlyAdapter(product: RegExp, placeholder?: RegExp): DomAdapter {
  return { turns: () => [], title: (doc) => titleWithout(doc, product, placeholder), stabilize: true };
}

/** LibreChat (its own client source and ophel registry, 2026-10), medium. */
const libreChatAdapter = roleAdapter({
  turns: '.message-render',
  isUser: (el) => Boolean(el.querySelector(':scope > .user-turn')) || hasClass(el, 'user-turn'),
  userBody: '.message-content',
  assistantBody: '.message-content',
  isStreaming: (el) => Boolean(el.querySelector('.message-content.submitting')),
  docStreaming: '[data-testid="stop-generation-button"]',
  title: (doc) => titleWithout(doc, /LibreChat/, /^New Chat$/i),
});

/** LobeChat (ophel lobechat registry, 2026), low. */
const lobeChatAdapter = roleAdapter({
  turns: '.message-wrapper[data-message-id], #chatlist-list [data-index]',
  isUser(el) {
    const style = el.getAttribute('style') ?? '';
    if (/--lobe-flex-align:\s*flex-end/.test(style)) return true;
    if (/--lobe-flex-align:\s*flex-start/.test(style)) return false;
    return el.hasAttribute('data-index') && !el.querySelector('[data-layout="vertical"]');
  },
  userBody: 'article[data-code-type="markdown"]',
  assistantBody: 'article[data-code-type="markdown"]',
  idOf: (el) => el.getAttribute('data-message-id'),
  title: (doc) => titleWithout(doc, /LobeChat|LobeHub/),
  stabilize: true,
});

/** AnythingLLM (HistoricalMessage component source, 2026-11), low: rows align by role. */
const anythingLlmAdapter = roleAdapter({
  turns: '#chat-history .flex.justify-end.w-full.group, #chat-history .flex.justify-start.w-full.group',
  isUser: (el) => hasClass(el, 'justify-end'),
  title: (doc) => titleWithout(doc, /AnythingLLM(?:\s*\|\s*Your personal LLM trained on anything)?/),
  stabilize: true,
});

/** Self-hosted chat apps recognised on an added site, by markup the app always renders. */
export type SelfHostedApp = 'open_webui' | 'librechat' | 'lobechat' | 'anythingllm';

export function detectSelfHostedApp(doc: Document): SelfHostedApp | null {
  if (doc.querySelector('#messages-container') && doc.querySelector('#chat-input, #response-content-container, .user-message .chat-user')) {
    return 'open_webui';
  }
  if (doc.querySelector('.message-render') && doc.querySelector('[data-testid="text-input"], main[role="main"]')) return 'librechat';
  if (doc.querySelector('.message-wrapper[data-message-id], #chatlist-list')) return 'lobechat';
  if (doc.querySelector('#chat-history') && (/AnythingLLM/i.test(doc.title) || doc.querySelector('.justify-end.w-full.group, .justify-start.w-full.group'))) {
    return 'anythingllm';
  }
  return null;
}

const SITE_ID_PATHS: RegExp[] = [
  /\/workspace\/([\w.-]+)\/t\/([\w.-]+)/, // AnythingLLM thread
  /\/(?:c|chat|chats|conversation|conversations|thread|threads|t|session|sessions)\/([\w.-]{4,})(?:\/|$)/,
];
const SITE_ID_PARAMS = ['conversationId', 'conversation', 'chatId', 'chatID', 'chat', 'threadId', 'thread', 'topic', 'sessionId', 'session', 'id', 'c'];
const SITE_NOT_AN_ID = /^(new|settings|login|signin|admin|home|share|search|workspace|models|api)$/i;

/**
 * The conversation id on an added site: an id-looking path segment, an id query parameter, or a
 * hash route; null when the page has none (the caller then uses the opening message).
 */
export function siteConversationIdFromUrl(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const clean = (v: string | null | undefined) => {
    const t = (v ?? '').replace(/[^\w.-]/g, '_').slice(0, 100);
    return t && !SITE_NOT_AN_ID.test(t) ? t : null;
  };
  const anything = url.pathname.match(SITE_ID_PATHS[0]);
  if (anything) return clean(`${anything[1]}_${anything[2]}`);
  const fromPath = clean(url.pathname.match(SITE_ID_PATHS[1])?.[1]);
  if (fromPath) return fromPath;
  for (const key of SITE_ID_PARAMS) {
    const v = clean(url.searchParams.get(key));
    if (v) return v;
  }
  const hash = url.hash.replace(/^#/, '');
  const fromHash = clean(hash.match(SITE_ID_PATHS[1])?.[1]);
  if (fromHash) return fromHash;
  const anythingWorkspace = url.pathname.match(/^\/workspace\/([\w.-]+)\/?$/);
  return anythingWorkspace ? clean(`${anythingWorkspace[1]}_default`) : null;
}

const SITE_ADAPTERS: Record<SelfHostedApp | 'custom_web', DomAdapter> = {
  open_webui: openWebUiSiteAdapter,
  librechat: libreChatAdapter,
  lobechat: lobeChatAdapter,
  anythingllm: anythingLlmAdapter,
  custom_web: { turns: () => [], title: () => null, stabilize: true },
};

/** A generic page title: document.title without a trailing " - Site name". */
function genericSiteTitle(doc: Document): string | null {
  const t = doc.title.replace(/\s*[-|–—•·]\s*[^-|–—•·]{1,40}$/, '').trim();
  return t && t.length > 1 && !/^(new chat|chat|home|untitled)$/i.test(t) ? t : null;
}

const noDom: DomAdapter = { turns: () => [], title: () => null, noFallback: true };

const ADAPTERS: Record<ProviderId, DomAdapter> = {
  chatgpt: chatgptAdapter,
  codex: chatgptAdapter,
  claude: claudeAdapter,
  claude_code: claudeAdapter,
  grok: grokAdapter,
  // No DOM selectors are known; captured from X's own responses instead (grok-x.ts).
  grok_x: noDom,
  gemini: geminiAdapter,
  ai_studio: aiStudioAdapter,
  perplexity: perplexityAdapter,
  deepseek: deepseekAdapter,
  mistral: mistralAdapter,
  copilot: copilotAdapter,
  kimi: kimiAdapter,
  imported: noDom,
  chatgpt_dots: chatgptDotsAdapter,
  claude_duet: claudeDuetAdapter,
  grok_bot: grokBotAdapter,
  muse: museAdapter,
  meta_ai: metaAiAdapter,
  poe: poeAdapter,
  huggingchat: huggingChatAdapter,
  qwen: qwenAdapter,
  doubao: doubaoAdapter,
  zai: zaiAdapter,
  manus: manusAdapter,
  genspark: gensparkAdapter,
  minimax_agent: titleOnlyAdapter(/MiniMax(?:\s*Agent)?/),
  character_ai: characterAdapter,
  duck_ai: duckAdapter,
  lumo: lumoAdapter,
  arena: arenaAdapter,
  t3_chat: t3Adapter,
  gemini_notebook: notebookAdapter,
  github_copilot: githubCopilotAdapter,
  cursor_agents: cursorAgentsAdapter,
  devin: titleOnlyAdapter(/Devin/),
  jules: titleOnlyAdapter(/Jules/),
  lovable: lovableAdapter,
  bolt: boltAdapter,
  v0: titleOnlyAdapter(/v0(?:\s+by\s+Vercel)?/),
  replit: titleOnlyAdapter(/Replit/),
  lobechat: lobeChatAdapter,
  custom_web: SITE_ADAPTERS.custom_web,
  open_webui: openWebUiSiteAdapter,
  librechat: libreChatAdapter,
  anythingllm: anythingLlmAdapter,
  // Synced from the Paperclip API, never read from a page.
  paperclip: noDom,
};

function CSS_ESCAPE(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function unixToIsoOrNull(ts: string | null): string | null {
  if (!ts) return null;
  const parsed = Date.parse(ts);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

/** The provider a page is read as, and how: a registered provider page, or an added site. */
function resolvePageProvider(
  doc: Document,
  locationHref: string,
  options: ExtractOptions
): { provider: ProviderId; adapter: DomAdapter; site: CaptureSiteContext | null } | null {
  if (options.site) {
    // An added site: the page never names its own provider; the markup decides between the
    // recognised self-hosted apps and the catch-all.
    const app = detectSelfHostedApp(doc);
    return { provider: app ?? 'custom_web', adapter: SITE_ADAPTERS[app ?? 'custom_web'], site: options.site };
  }
  const providerAttr = doc.documentElement.getAttribute('data-tk-provider');
  const provider: ProviderId | null = isProviderId(providerAttr) ? providerAttr : detectProviderFromUrl(locationHref);
  // Imports and Paperclip (synced from its API) are never read from a page; Grok on X is read from
  // X's own responses (grok-x.ts).
  if (!provider || PROVIDERS[provider].hostAccess === 'none' || provider === 'grok_x') return null;
  // Custom-site providers are read only on sites the user added (the background says which).
  if (PROVIDERS[provider].hostAccess === 'custom') return null;
  if (PROVIDERS[provider].captureMode === 'explicit' && !options.explicit) return null;
  return { provider, adapter: ADAPTERS[provider], site: null };
}

interface DraftMessage {
  turn: RawTurn;
  index: number;
  text: string;
  createdAt: string | null;
}

export function extractVisibleDomConversation(
  doc: Document,
  locationHref: string,
  options: ExtractOptions = {}
): DomExtractionResult | null {
  const page = resolvePageProvider(doc, locationHref, options);
  if (!page) return null;
  const { provider, adapter, site } = page;

  let urlConversationId: string | null;
  if (site) {
    urlConversationId = siteConversationIdFromUrl(locationHref);
  } else {
    const convIdAttr =
      doc.documentElement.getAttribute('data-tk-conversation-id') ||
      doc.querySelector('[data-conversation-id]')?.getAttribute('data-conversation-id');
    urlConversationId = convIdAttr || extractConversationIdFromUrl(locationHref) || adapter.conversationId?.(doc, locationHref) || null;
    if (!urlConversationId) return null;
  }

  const branchAttr = site
    ? 'main'
    : doc.querySelector('[data-branch-id]')?.getAttribute('data-branch-id') ||
      doc.documentElement.getAttribute('data-tk-branch-id') ||
      'main';
  const branchId = branchAttr.trim() || 'main';

  let method: DomExtractionResult['method'] = 'adapter';
  let turns = adapter.turns(doc);
  const fallback = !adapter.noFallback && provider !== 'claude' && provider !== 'chatgpt';
  if (turns.length === 0 && fallback) {
    turns = genericTurns(doc);
    method = 'generic';
  }
  if (turns.length === 0 && fallback) {
    turns = heuristicTurns(doc);
    method = 'heuristic';
  }
  if (turns.length === 0) method = 'none';

  // A page-wide "still writing" signal (a stop button) means the newest reply is unfinished.
  let unfinishedIndex = -1;
  if (adapter.docStreaming && doc.querySelector(adapter.docStreaming)) {
    for (let i = turns.length - 1; i >= 0; i--) {
      if (turns[i].role !== 'user') {
        unfinishedIndex = i;
        break;
      }
    }
  }

  const drafts: DraftMessage[] = [];
  let modelSlug: string | null = null;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const el = turn.el;
    if (i === unfinishedIndex) continue;

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
      el.getAttribute('aria-busy') === 'true' ||
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
    drafts.push({ turn, index: i, text, createdAt: unixToIsoOrNull(explicitTs) });
  }

  // An added site without an id in its address: the conversation is named by its opening message.
  let conversationId = urlConversationId;
  if (site && !conversationId) {
    const opening = drafts.find((d) => d.turn.role === 'user')?.text;
    if (!opening) return null;
    conversationId = `m_${fnv1a32Hex(opening.replace(/\s+/g, ' ').trim())}`;
  }
  if (!conversationId) return null;
  const sourceConversationId = site ? `${siteConversationKey(site.origin)}~${conversationId}` : conversationId;

  const messages: UpsertThreadInput['messages'] = [];
  const usedIds = new Set<string>();
  for (const draft of drafts) {
    // Turns that share a keyed ancestor stay distinct, in a stable order.
    const baseId =
      stableMessageKey(draft.turn) ??
      (adapter.hashIds
        ? `h_${fnv1a32Hex(`${draft.turn.role}\n${draft.text}`)}`
        : `${sourceConversationId}_${branchId}_m_${draft.index}`);
    let sourceMessageId = baseId;
    for (let n = 2; usedIds.has(sourceMessageId); n++) sourceMessageId = `${baseId}#${n}`;
    usedIds.add(sourceMessageId);

    messages.push({
      sourceMessageId,
      role: draft.turn.role,
      content: draft.text,
      createdAt: draft.createdAt,
      branchPath: branchId,
    });
  }

  const adapterTitle = adapter.title(doc, locationHref, conversationId) ?? (site ? genericSiteTitle(doc) : null);
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? '';
  const derivedTitle = firstUser
    ? firstUser.replace(/\s+/g, ' ').slice(0, 80).trim()
    : '';
  const title = (adapterTitle || derivedTitle || 'Untitled conversation').trim();

  return {
    provider,
    sourceConversationId,
    branchId,
    canonicalUrl: canonicalizeConversationUrl(locationHref, site ? provider : undefined),
    title,
    coverage: messages.length > 0 ? 'partial' : 'title_only',
    messages,
    providerProjectName: adapter.project?.(doc, locationHref) ?? null,
    modelSlug,
    method,
    stabilize: Boolean(site) || method !== 'adapter' || Boolean(adapter.stabilize),
  };
}

/** Repository facts a coding-agent page shows about its session. */
export interface RepositoryInfo {
  /** Normalized "owner/name" (core/repository.ts), or null. */
  repository: string | null;
  /** Canonical pull request address, or null. */
  pullRequestUrl: string | null;
  gitBranch: string | null;
}

// github.com paths whose first segment is a site section, not an owner ("github.com/settings/profile").
const GITHUB_RESERVED_OWNERS = new Set([
  'about', 'apps', 'codespaces', 'collections', 'copilot', 'enterprise', 'events', 'explore', 'features',
  'issues', 'login', 'marketplace', 'new', 'notifications', 'orgs', 'pricing', 'pulls', 'search', 'security',
  'settings', 'signup', 'sponsors', 'topics', 'trending', 'users',
]);

// Message bodies can link to any repository; only the session's own chrome names its repository.
const REPOSITORY_LINK_EXCLUDED =
  'nav, aside, [data-message-author-role], [data-testid*="message"], .markdown-body, .prose, .markdown';

function repositoryFromHref(href: string, base: string): string | null {
  let resolved: URL;
  try {
    resolved = new URL(href, base);
  } catch {
    return null;
  }
  const repository = normalizeRepository(resolved.href);
  if (!repository || !repository.includes('/')) return null;
  if (/^(?:www\.)?github\.com$/i.test(resolved.hostname) && GITHUB_RESERVED_OWNERS.has(repository.split('/')[0])) return null;
  return repository;
}

function branchFromElement(el: Element): string | null {
  const label = (el.getAttribute('aria-label') ?? el.getAttribute('title') ?? '').trim();
  const labelled = label.match(/^(?:git\s+)?branch\s*[:\-]\s*(.+)$/i);
  let value: string | null = labelled ? labelled[1] : null;
  if (!value && (/^(?:git\s+)?branch$/i.test(label) || /branch/i.test(el.getAttribute('data-testid') ?? ''))) {
    value = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
  }
  if (!value) {
    const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (el.children.length === 0 && text.length < 120) value = text.match(/^branch\s*:\s*(\S+)$/i)?.[1] ?? null;
  }
  // A branch name has no spaces; "Create branch" or a sentence is a button or prose, not a name.
  return value && /^[\w./@+#-]{1,200}$/.test(value) ? value : null;
}

/**
 * Read the repository, branch and pull request a coding-agent page shows for its session
 * (Claude Code, Codex, Cursor agents, GitHub Copilot agent sessions, Jules, Devin).
 * The selectors are unverified against the live sites: they look for what any of these pages
 * has to show, a link to the repository or pull request and a labelled branch, and return null
 * rather than guess. Other pages return all nulls.
 */
export function extractRepositoryInfo(doc: Document, url: string): RepositoryInfo {
  const none: RepositoryInfo = { repository: null, pullRequestUrl: null, gitBranch: null };
  const provider = detectProviderFromUrl(url);
  if (!provider || providerCategory(provider) !== 'coding_agent') return none;

  let repository: string | null = null;
  let pullRequestUrl: string | null = null;
  if (provider === 'github_copilot') {
    const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/agent-sessions\//);
    if (m) {
      repository = normalizeRepository(`${m[1]}/${m[2]}`);
      pullRequestUrl = normalizePullRequestUrl(`https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`);
    }
  }

  const roots = Array.from(doc.querySelectorAll('header, main, [role="main"]'));
  if (roots.length === 0 && doc.body) roots.push(doc.body);
  const links = roots
    .flatMap((root) => Array.from(root.querySelectorAll('a[href]')))
    .filter((a) => !a.closest(REPOSITORY_LINK_EXCLUDED));
  for (const a of links) {
    const href = a.getAttribute('href') ?? '';
    if (!repository) repository = repositoryFromHref(href, url);
    if (!pullRequestUrl) {
      try {
        pullRequestUrl = normalizePullRequestUrl(new URL(href, url).href);
      } catch {
        // not an address
      }
    }
    if (repository && pullRequestUrl) break;
  }

  let gitBranch: string | null = null;
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (el.closest('[data-message-author-role], [data-testid*="message"], .markdown-body, .prose, .markdown')) continue;
      gitBranch = branchFromElement(el);
      if (gitBranch) break;
    }
    if (gitBranch) break;
  }
  return { repository, pullRequestUrl, gitBranch };
}

/** The provider's own project (ChatGPT/Claude Project, coding-agent repository) shown on this page. */
export function extractProviderProjectName(doc: Document, locationHref: string): string | null {
  const providerAttr = doc.documentElement.getAttribute('data-tk-provider');
  const provider: ProviderId | null = isProviderId(providerAttr) ? providerAttr : detectProviderFromUrl(locationHref);
  if (!provider || PROVIDERS[provider].hostAccess === 'custom') return null;
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
    method: 'adapter',
    stabilize: false,
  };
}

/**
 * Strip query strings and fragments that do not identify the conversation. Parameters that do
 * (?conversation, Genspark's ?id, Character.AI's ?hist, Duck.ai's ?chatID, …) are kept. Pass the
 * provider for an added site, where the id may sit in any common parameter or a hash route.
 */
export function canonicalizeConversationUrl(href: string, provider?: ProviderId): string {
  const owner = provider ?? detectProviderFromUrl(href);
  if (owner === 'grok_x') {
    const conv = extractConversationIdFromUrl(href);
    return conv ? grokXCanonicalUrl(conv) : 'https://x.com/i/grok';
  }
  try {
    const u = new URL(href);
    const keep = new URLSearchParams();
    const custom = owner !== null && PROVIDERS[owner].hostAccess === 'custom';
    for (const key of custom ? ['conversation', ...SITE_ID_PARAMS] : conversationQueryParams(owner)) {
      const value = u.searchParams.get(key);
      if (value) keep.set(key, value);
    }
    const qs = keep.toString();
    const hashRoute = custom && /^#\/[\w./-]+$/.test(u.hash) ? u.hash : '';
    return `${u.origin}${u.pathname}${qs ? `?${qs}` : ''}${hashRoute}`;
  } catch {
    return href;
  }
}
