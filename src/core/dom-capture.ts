import {
  detectProviderFromUrl,
  extractChatGptProjectSlug,
  extractConversationIdFromUrl,
  isProviderId,
  type ProviderId,
} from './providers.js';
import type { UpsertThreadInput } from './db.js';

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
  id?: string | null;
  model?: string | null;
}

interface DomAdapter {
  turns(doc: Document): RawTurn[];
  title(doc: Document, url: string, conversationId: string): string | null;
  project?(doc: Document, url: string): string | null;
  isStreaming?(el: Element): boolean;
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
export function extractReadableText(root: Element): string {
  const out: string[] = [];
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out.push(node.nodeValue ?? '');
      return;
    }
    if (node.nodeType !== 1) return;
    const el = node as Element;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return;
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
    (el.classList.contains('font-user-message') ? 'user' : 'assistant');
  return roleAttr === 'user' || roleAttr === 'human'
    ? 'user'
    : roleAttr === 'tool'
      ? 'tool'
      : 'assistant';
}

/** Explicit role attributes shared by several providers and by Threadkeeper test fixtures. */
function genericTurns(doc: Document): RawTurn[] {
  return outermost(Array.from(doc.querySelectorAll(GENERIC_ROLE_SELECTOR))).map((el) => ({
    el,
    role: genericRole(el),
    body:
      el.querySelector('[data-message-content]') ??
      el.querySelector('.markdown') ??
      el.querySelector('.whitespace-pre-wrap') ??
      null,
    id:
      el.getAttribute('data-message-id') ||
      el.querySelector('[data-message-id]')?.getAttribute('data-message-id') ||
      null,
    model:
      el.getAttribute('data-message-model-slug') ||
      el.querySelector('[data-message-model-slug]')?.getAttribute('data-message-model-slug') ||
      null,
  }));
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
  ).filter((el) => !el.closest('nav, aside, form, [contenteditable="true"]'));
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

const chatgptAdapter: DomAdapter = {
  turns: genericTurns,
  title(doc, url, conversationId) {
    const sidebar = conversationId
      ? doc.querySelector(`nav a[href$="/c/${CSS_ESCAPE(conversationId)}"]`)
      : null;
    const sidebarTitle = sidebar?.textContent?.replace(/\s+/g, ' ').trim();
    if (sidebarTitle) return sidebarTitle;
    const t = cleanDocTitle(doc, /\s*[-|]\s*(ChatGPT|Codex).*$/i);
    return t && !/^(ChatGPT|Codex|New chat)$/i.test(t) ? t : null;
  },
  project(doc, url) {
    return (
      extractChatGptProjectSlug(url) ??
      (detectProviderFromUrl(url) === 'codex' ? repoFromGithubLink(doc) : null)
    );
  },
  isStreaming(el) {
    return Boolean(
      el.classList.contains('result-streaming') || el.querySelector('.result-streaming')
    );
  },
};

const CLAUDE_TURN_SELECTOR = [
  '[data-testid="user-message"]',
  '.font-claude-response',
  '.font-claude-message',
  '[data-testid="assistant-message"]',
].join(', ');

const claudeAdapter: DomAdapter = {
  turns(doc) {
    const generic = genericTurns(doc);
    if (generic.length > 0) return generic;
    return outermost(Array.from(doc.querySelectorAll(CLAUDE_TURN_SELECTOR))).map((el) => ({
      el,
      role: el.matches('[data-testid="user-message"]') ? ('user' as const) : ('assistant' as const),
    }));
  },
  title(doc) {
    return (
      firstText(doc, [
        '[data-conversation-title]',
        '[data-testid="chat-title-button"]',
        '[data-testid="chat-menu-trigger"]',
      ]) ?? cleanDocTitle(doc, /\s*[-|]\s*Claude.*$/i)
    );
  },
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
        const bubble = el.querySelector('.message-bubble') ?? el;
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
    const selected = firstText(doc, [
      '.conversation.selected .conversation-title',
      '[data-test-id="conversation"].selected',
      '.selected .conversation-title',
    ]);
    if (selected) return selected;
    const t = cleanDocTitle(doc, /\s*[-|]\s*(Google\s+)?Gemini.*$/i);
    return t && !/^(Google\s+)?Gemini$/i.test(t) ? t : null;
  },
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

const deepseekAdapter: DomAdapter = {
  turns(doc) {
    const messages = Array.from(doc.querySelectorAll('.ds-message'));
    if (messages.length > 0) {
      return outermost(messages).map((el) => {
        const md = el.querySelector('.ds-markdown');
        return md
          ? { el, body: md, role: 'assistant' as const }
          : { el, role: 'user' as const };
      });
    }
    return [];
  },
  title(doc) {
    const t = cleanDocTitle(doc, /\s*[-|]\s*DeepSeek.*$/i);
    return t && !/^DeepSeek$/i.test(t) ? t : null;
  },
};

const copilotAdapter: DomAdapter = {
  turns(doc) {
    return Array.from(
      doc.querySelectorAll('[data-content="user-message"], [data-content="ai-message"]')
    ).map((el) => ({
      el,
      role:
        el.getAttribute('data-content') === 'user-message'
          ? ('user' as const)
          : ('assistant' as const),
    }));
  },
  title(doc) {
    const t = cleanDocTitle(doc, /\s*[-|]\s*(Microsoft\s+)?Copilot.*$/i);
    return t && !/^(Microsoft\s+)?Copilot/i.test(t) ? t : null;
  },
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
  gemini: geminiAdapter,
  perplexity: perplexityAdapter,
  deepseek: deepseekAdapter,
  mistral: mistralAdapter,
  copilot: copilotAdapter,
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
  if (!provider || provider === 'imported') return null;

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
  let modelSlug: string | null = null;

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const el = turn.el;

    // Never capture the composer or an unsent draft
    if (
      el.closest('form') ||
      el.closest('[data-testid="composer"]') ||
      el.getAttribute('contenteditable') === 'true'
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

    const bodyNode = turn.body ?? el;
    const text = extractReadableText(bodyNode);
    if (!text) continue;

    if (turn.model) modelSlug = turn.model;

    const timeEl = el.querySelector('time[datetime]');
    const explicitTs =
      el.getAttribute('data-message-timestamp') || timeEl?.getAttribute('datetime') || null;

    messages.push({
      sourceMessageId: turn.id || `${sourceConversationId}_${branchId}_m_${i}`,
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

/** Strip query strings and fragments that do not identify the conversation. */
export function canonicalizeConversationUrl(href: string): string {
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
