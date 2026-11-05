"use strict";
(() => {
  // src/core/providers.ts
  var PROVIDER_IDS = [
    "chatgpt",
    "claude",
    "claude_code",
    "codex",
    "grok",
    "grok_x",
    "gemini",
    "ai_studio",
    "perplexity",
    "deepseek",
    "mistral",
    "copilot",
    "kimi",
    "imported"
  ];
  var CAPTURE_PROVIDER_IDS = PROVIDER_IDS.filter(
    (id) => id !== "imported"
  );
  function isProviderId(value) {
    return typeof value === "string" && PROVIDER_IDS.includes(value);
  }
  var X_HOST_RE = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/;
  function isXHostname(hostname) {
    return X_HOST_RE.test(hostname.toLowerCase());
  }
  var KIMI_HOSTS = /* @__PURE__ */ new Set(["www.kimi.com", "kimi.com", "kimi.ai"]);
  var COPILOT_HOSTS = /* @__PURE__ */ new Set(["copilot.microsoft.com", "copilot.com", "www.copilot.com"]);
  function providerForPage(parsed) {
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
      return /^(?:\/u\/[^/]+)?\/codex(\/|$)/.test(path) ? "codex" : "chatgpt";
    }
    if (host === "claude.ai" || host.endsWith(".claude.ai")) {
      return /^\/code(\/|$)/.test(path) ? "claude_code" : "claude";
    }
    if (host === "grok.com" || host.endsWith(".grok.com")) return "grok";
    if (isXHostname(host)) return /^\/i\/grok(\/|$)/.test(path) ? "grok_x" : null;
    if (host === "gemini.google.com") return "gemini";
    if (host === "aistudio.google.com") return "ai_studio";
    if (host === "perplexity.ai" || host.endsWith(".perplexity.ai")) return "perplexity";
    if (host === "chat.deepseek.com") return "deepseek";
    if (host === "chat.mistral.ai") return "mistral";
    if (COPILOT_HOSTS.has(host)) return "copilot";
    if (KIMI_HOSTS.has(host)) return "kimi";
    return null;
  }
  function detectProviderFromUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const owner = providerForPage(parsed);
    if (owner) return owner;
    if (isXHostname(parsed.hostname)) return null;
    const hinted = parsed.searchParams.get("tk_provider");
    return isProviderId(hinted) ? hinted : null;
  }
  var SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  function extractConversationIdFromUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const path = parsed.pathname;
    switch (providerForPage(parsed)) {
      case "grok_x": {
        const conv = parsed.searchParams.get("conversation");
        return conv && SAFE_ID_RE.test(conv) ? conv : null;
      }
      case "ai_studio": {
        const m = path.match(/^\/prompts\/([a-zA-Z0-9_-]+)(?:\/|$)/);
        return m && m[1] !== "new_chat" ? m[1] : null;
      }
      case "kimi": {
        const m = path.match(/^\/chat\/([0-9a-f-]{36}|[a-z0-9]{20})(?:\/|$)/);
        return m ? m[1] : null;
      }
      default:
        break;
    }
    const patterns = [
      /\/codex\/tasks\/([a-zA-Z0-9_-]+)/,
      // Codex cloud task
      /\/code\/([a-zA-Z0-9_-]{6,})/,
      // Claude Code on the web session
      /\/c\/([a-zA-Z0-9_-]+)/,
      // ChatGPT, Grok
      /\/chat\/s\/([a-zA-Z0-9_-]+)/,
      // DeepSeek
      /\/chat\/([a-zA-Z0-9_-]+)/,
      // Claude, Mistral, Grok (legacy)
      /\/chats\/([a-zA-Z0-9_-]+)/,
      // Copilot
      /\/app\/([a-zA-Z0-9_-]+)/,
      // Gemini
      /\/gem\/[a-zA-Z0-9_-]+\/([a-zA-Z0-9_-]+)/,
      // Gemini Gems
      /\/search\/([a-zA-Z0-9._-]+)/
      // Perplexity
    ];
    for (const re of patterns) {
      const m = path.match(re);
      if (m) return m[1];
    }
    const grokParam = parsed.searchParams.get("conversation");
    if (grokParam) return grokParam;
    return parsed.searchParams.get("tk_conv_id");
  }
  function parseChatGptProjectRoute(url) {
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
  function extractChatGptProjectSlug(url) {
    const slug = parseChatGptProjectRoute(url)?.slug;
    if (!slug || !/^[a-z0-9-]+$/i.test(slug)) return null;
    const name = slug.split("-").filter(Boolean).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ");
    return name || null;
  }

  // src/core/dom-capture.ts
  var SKIP_TAGS = /* @__PURE__ */ new Set([
    "BUTTON",
    "SVG",
    "STYLE",
    "SCRIPT",
    "NOSCRIPT",
    "TEXTAREA",
    "INPUT",
    "SELECT",
    "TEMPLATE",
    "IMG",
    "VIDEO",
    "AUDIO",
    "CANVAS",
    "FORM"
  ]);
  var BLOCK_TAGS = /* @__PURE__ */ new Set([
    "P",
    "DIV",
    "LI",
    "UL",
    "OL",
    "H1",
    "H2",
    "H3",
    "H4",
    "H5",
    "H6",
    "BLOCKQUOTE",
    "TABLE",
    "TR",
    "SECTION",
    "ARTICLE",
    "HEADER",
    "FOOTER",
    "HR"
  ]);
  function extractReadableText(root, skipSelector) {
    const out = [];
    const skipped = new Set(skipSelector ? Array.from(root.querySelectorAll(skipSelector)) : []);
    const walk = (node) => {
      if (node.nodeType === 3) {
        out.push(node.nodeValue ?? "");
        return;
      }
      if (node.nodeType !== 1) return;
      const el = node;
      const tag = el.tagName.toUpperCase();
      if (SKIP_TAGS.has(tag) || skipped.has(el)) return;
      if (el.getAttribute("aria-hidden") === "true") return;
      if (el.classList.contains("sr-only")) return;
      if (tag === "BR") {
        out.push("\n");
        return;
      }
      if (tag === "PRE") {
        const code = el.querySelector("code") ?? el;
        const lang = (code.className.match(/language-([\w+-]+)/) ?? [])[1] ?? "";
        out.push(`
\`\`\`${lang}
${(code.textContent ?? "").replace(/\n+$/, "")}
\`\`\`
`);
        return;
      }
      const block = BLOCK_TAGS.has(tag);
      if (block) out.push("\n");
      if (tag === "LI") out.push("- ");
      for (const child of Array.from(el.childNodes)) walk(child);
      if (block) out.push("\n");
    };
    walk(root);
    return out.join("").replace(/\u00a0/g, " ").replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+(?=\S)/g, (m) => m.includes("- ") ? m : "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  function outermost(elements) {
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
  function cleanDocTitle(doc, suffixes) {
    const t = doc.title.replace(suffixes, "").trim();
    return t.length > 0 ? t : null;
  }
  function firstTitle(doc, selectors, placeholder) {
    for (const sel of selectors) {
      for (const el of Array.from(doc.querySelectorAll(sel))) {
        const text = extractReadableText(el).replace(/\s+/g, " ").trim();
        if (text && !placeholder.test(text)) return text;
      }
    }
    return null;
  }
  var MESSAGE_KEY_ATTRS = [
    "data-turn-key",
    // ChatGPT, Claude
    "data-message-id",
    "data-virtual-list-item-key",
    // DeepSeek
    "data-archer-id"
    // Kimi
  ];
  var MESSAGE_KEY_SELECTOR = MESSAGE_KEY_ATTRS.map((attr) => `[${attr}]`).join(", ");
  function ownMessageKey(el) {
    for (const attr of MESSAGE_KEY_ATTRS) {
      const value = el.getAttribute(attr)?.trim();
      if (value) return value;
    }
    return null;
  }
  function stableMessageKey(turn) {
    if (turn.id) return turn.id;
    const own = ownMessageKey(turn.el);
    if (own) return own;
    const holder = turn.el.parentElement?.closest(MESSAGE_KEY_SELECTOR);
    return holder ? ownMessageKey(holder) : null;
  }
  function repoFromGithubLink(doc) {
    const link = doc.querySelector('main a[href*="github.com/"], header a[href*="github.com/"]');
    const href = link?.getAttribute("href") ?? "";
    const m = href.match(/github\.com\/[^/]+\/([^/?#]+)/);
    return m ? m[1].replace(/\.git$/, "") : null;
  }
  var GENERIC_ROLE_SELECTOR = [
    "[data-message-author-role]",
    '[data-testid^="conversation-turn"]',
    "[data-tk-message-role]"
  ].join(", ");
  function genericRole(el) {
    const roleAttr = el.getAttribute("data-message-author-role") || el.getAttribute("data-tk-message-role") || el.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role") || (el.classList.contains("font-user-message") ? "user" : "assistant");
    return roleAttr === "user" || roleAttr === "human" ? "user" : roleAttr === "tool" ? "tool" : "assistant";
  }
  function genericTurns(doc) {
    return outermost(Array.from(doc.querySelectorAll(GENERIC_ROLE_SELECTOR))).map((el) => ({
      el,
      role: genericRole(el),
      body: el.querySelector("[data-message-content]") ?? el.querySelector(".markdown") ?? el.querySelector(".whitespace-pre-wrap") ?? null,
      id: el.getAttribute("data-message-id") || el.querySelector("[data-message-id]")?.getAttribute("data-message-id") || null,
      model: el.getAttribute("data-message-model-slug") || el.querySelector("[data-message-model-slug]")?.getAttribute("data-message-model-slug") || null
    }));
  }
  var HEURISTIC_USER = /(^|[-_\s])(user|human|query|prompt)([-_\s]|$)/i;
  var HEURISTIC_ASSISTANT = /(^|[-_\s])(assistant|bot|ai|model|response|answer)([-_\s]|$)/i;
  function heuristicTurns(doc) {
    const candidates = Array.from(
      doc.querySelectorAll(
        '[data-testid*="message" i], [data-role], [data-author], [class*="message" i], [data-content$="message"]'
      )
    ).filter(
      (el) => !el.closest('nav, aside, form, [contenteditable="true"], [contenteditable="plaintext-only"]')
    );
    const turns = [];
    for (const el of outermost(candidates)) {
      const descriptor = [
        el.getAttribute("data-testid"),
        el.getAttribute("data-role"),
        el.getAttribute("data-author"),
        el.getAttribute("data-content"),
        typeof el.className === "string" ? el.className : ""
      ].filter(Boolean).join(" ");
      if (HEURISTIC_USER.test(descriptor)) turns.push({ el, role: "user" });
      else if (HEURISTIC_ASSISTANT.test(descriptor)) turns.push({ el, role: "assistant" });
    }
    if (turns.length > 0) return turns;
    return outermost(
      Array.from(doc.querySelectorAll(".markdown, .prose, .ds-markdown, message-content"))
    ).map((el) => ({ el, role: "assistant" }));
  }
  var CHATGPT_PLACEHOLDER_TITLE = /^(ChatGPT|Codex|New chat|Nuevo chat|Neuer Chat|Nouveau chat)$/i;
  var CHATGPT_STREAMING = '[data-message-streaming="true"], [data-is-streaming="true"], .result-streaming';
  function chatgptProjectName(doc, url) {
    const route = parseChatGptProjectRoute(url);
    if (!route) return null;
    const hex = route.projectId.replace(/^g-p-/i, "");
    for (const row of Array.from(doc.querySelectorAll("[data-app-action-sidebar-project-id]"))) {
      const id = row.getAttribute("data-app-action-sidebar-project-id") ?? "";
      if (id !== route.projectId && id !== hex && !id.startsWith(`${route.projectId}-`)) continue;
      const label = row.getAttribute("data-app-action-sidebar-project-label")?.replace(/\s+/g, " ").trim();
      if (label) return label;
    }
    const fromSlug = extractChatGptProjectSlug(url);
    if (fromSlug) return fromSlug;
    const fromTitle = doc.title.match(/^ChatGPT\s+[-–—]\s+(.+)$/)?.[1]?.trim();
    return fromTitle || null;
  }
  var chatgptAdapter = {
    turns(doc) {
      const turns = genericTurns(doc);
      const slugged = turns.some((t) => t.role === "assistant" && t.model);
      return slugged ? turns.filter((t) => t.role !== "assistant" || t.model) : turns;
    },
    title(doc, url, conversationId) {
      const id = conversationId ? CSS_ESCAPE(conversationId) : "";
      const sidebar = firstTitle(
        doc,
        [
          ...id ? [
            `nav a[aria-current="page"][href$="/c/${id}"]`,
            `#stage-slideover-sidebar a[aria-current="page"][href$="/c/${id}"]`,
            `nav a[href$="/c/${id}"]`
          ] : [],
          'nav a[aria-current="page"][href*="/c/"]',
          '#stage-slideover-sidebar a[aria-current="page"][href*="/c/"]'
        ],
        CHATGPT_PLACEHOLDER_TITLE
      );
      if (sidebar) return sidebar;
      if (/^ChatGPT\s+[-–—]\s+/.test(doc.title)) return null;
      const t = cleanDocTitle(doc, /\s*[-|]\s*(ChatGPT|Codex).*$/i);
      return t && !CHATGPT_PLACEHOLDER_TITLE.test(t) ? t : null;
    },
    project(doc, url) {
      return chatgptProjectName(doc, url) ?? (detectProviderFromUrl(url) === "codex" ? repoFromGithubLink(doc) : null);
    },
    isStreaming(el) {
      return Boolean(el.closest(CHATGPT_STREAMING) || el.querySelector(CHATGPT_STREAMING));
    }
  };
  var CLAUDE_TURN_SELECTOR = [
    '[data-testid="user-message"]',
    ".font-claude-response:not(#markdown-artifact)",
    ".font-claude-message",
    '[data-testid="assistant-message"]'
  ].join(", ");
  var CLAUDE_PLACEHOLDER_TITLE = /^(Claude|Claude Code|New chat|New session|Untitled)$/i;
  var claudeAdapter = {
    turns(doc) {
      const generic = genericTurns(doc);
      const turns = generic.length > 0 ? generic : outermost(Array.from(doc.querySelectorAll(CLAUDE_TURN_SELECTOR))).map((el) => ({
        el,
        role: el.matches('[data-testid="user-message"]') ? "user" : "assistant"
      }));
      return turns.filter((t) => !t.el.closest("#markdown-artifact"));
    },
    title(doc) {
      const t = firstTitle(
        doc,
        [
          '[data-row-key^="chat:"][aria-current]:not([aria-current="false"]) [data-row-label]',
          '[aria-current="page"]',
          "[data-conversation-title]",
          '[data-testid="chat-title-button"]',
          '[data-testid="chat-menu-trigger"]'
        ],
        CLAUDE_PLACEHOLDER_TITLE
      ) ?? cleanDocTitle(doc, /\s*[-|]\s*Claude.*$/i);
      return t && !CLAUDE_PLACEHOLDER_TITLE.test(t) ? t : null;
    },
    // A reply's direct child with the transition-all class is the collapsible thinking block.
    strip: ':scope > [class*="transition-all"]',
    project(doc, url) {
      const links = Array.from(doc.querySelectorAll('a[href^="/project/"]')).filter(
        (a) => !a.closest("nav, aside")
      );
      const name = links[0]?.textContent?.replace(/\s+/g, " ").trim();
      if (name) return name;
      return detectProviderFromUrl(url) === "claude_code" ? repoFromGithubLink(doc) : null;
    },
    isStreaming(el) {
      return Boolean(
        el.closest('[data-is-streaming="true"]') || el.querySelector('[data-is-streaming="true"]')
      );
    }
  };
  var grokAdapter = {
    turns(doc) {
      const containers = Array.from(doc.querySelectorAll('[id^="response-"]'));
      const fromContainers = containers.map((el) => {
        const bubble = el.querySelector(".response-content-markdown") ?? el.querySelector(".message-bubble") ?? el;
        const isUser = /\bitems-end\b/.test(typeof el.className === "string" ? el.className : "") || Boolean(el.querySelector(".items-end .message-bubble"));
        return { el, body: bubble, role: isUser ? "user" : "assistant" };
      }).filter((t) => t.body);
      if (fromContainers.length > 0) return fromContainers;
      return Array.from(doc.querySelectorAll(".message-bubble")).map((el) => ({
        el,
        role: el.closest(".items-end") ? "user" : "assistant"
      }));
    },
    title(doc) {
      const t = cleanDocTitle(doc, /\s*[-|]\s*Grok.*$/i);
      return t && !/^Grok$/i.test(t) ? t : null;
    }
  };
  var geminiAdapter = {
    turns(doc) {
      return Array.from(doc.querySelectorAll("user-query, model-response")).map((el) => {
        const isUser = el.tagName.toLowerCase() === "user-query";
        return {
          el,
          role: isUser ? "user" : "assistant",
          body: isUser ? el.querySelector(".query-text, user-query-content") ?? el : el.querySelector("message-content, .markdown") ?? el
        };
      });
    },
    title(doc) {
      const selected = firstTitle(
        doc,
        [
          '[data-test-id="conversation-title"]',
          "conversation-actions .conversation-title",
          ".conversation.selected .conversation-title",
          '[data-test-id="conversation"].selected',
          ".selected .conversation-title",
          "mat-list-item.mdc-list-item--activated [mat-line]"
        ],
        /^(Google\s+)?Gemini$/i
      );
      if (selected) return selected;
      const t = cleanDocTitle(doc, /\s*[-|]\s*(Google\s+)?Gemini.*$/i);
      return t && !/^(Google\s+)?Gemini$/i.test(t) ? t : null;
    },
    strip: "model-thoughts"
  };
  var perplexityAdapter = {
    turns(doc) {
      const nodes = Array.from(
        doc.querySelectorAll('main h1, [class*="group/query"], [data-testid="query-text"], main .prose')
      );
      return outermost(nodes).map((el) => ({
        el,
        role: el.matches(".prose") ? "assistant" : "user"
      }));
    },
    title(doc) {
      const t = cleanDocTitle(doc, /\s*[-|]\s*Perplexity.*$/i);
      return t && !/^Perplexity$/i.test(t) ? t : null;
    }
  };
  var DEEPSEEK_THINKING = ".ds-think-content";
  var deepseekAdapter = {
    turns(doc) {
      const messages = Array.from(doc.querySelectorAll(".ds-message"));
      if (messages.length > 0) {
        return outermost(messages).map((el) => {
          const isAssistant = Boolean(
            el.querySelector(`.ds-markdown, .ds-assistant-message-main-content, ${DEEPSEEK_THINKING}`)
          );
          if (!isAssistant) return { el, role: "user" };
          const answer = Array.from(el.querySelectorAll(".ds-markdown")).find(
            (md) => !md.closest(DEEPSEEK_THINKING)
          );
          return {
            el,
            body: answer ?? el.querySelector(".ds-assistant-message-main-content") ?? el,
            role: "assistant"
          };
        });
      }
      return [];
    },
    title(doc) {
      const t = cleanDocTitle(doc, /\s*[-|]\s*DeepSeek.*$/i);
      return t && !/^DeepSeek$/i.test(t) ? t : null;
    },
    strip: DEEPSEEK_THINKING
  };
  var COPILOT_USER_TURN = '.group\\/user-message, [data-content="user-message"]';
  var COPILOT_TURN = [
    COPILOT_USER_TURN,
    ".group\\/ai-message",
    ".group\\/ai-message-item",
    '[data-content="ai-message"]'
  ].join(", ");
  var copilotAdapter = {
    turns(doc) {
      return outermost(Array.from(doc.querySelectorAll(COPILOT_TURN))).map((el) => {
        const isUser = el.matches(COPILOT_USER_TURN);
        return {
          el,
          role: isUser ? "user" : "assistant",
          body: isUser ? el.querySelector('[data-content="user-message"]') ?? el : el.querySelector(".group\\/ai-message-item") ?? el
        };
      });
    },
    title(doc) {
      const t = cleanDocTitle(doc, /\s*[-|]\s*(Microsoft\s+)?Copilot.*$/i);
      return t && !/^(Microsoft\s+)?Copilot/i.test(t) ? t : null;
    }
  };
  var AI_STUDIO_USER_TURN = '.user-prompt-container, [data-turn-role="User"]';
  var aiStudioAdapter = {
    turns(doc) {
      return outermost(
        Array.from(
          doc.querySelectorAll(
            `${AI_STUDIO_USER_TURN}, .model-prompt-container, [data-turn-role="Model"]`
          )
        )
      ).map((el) => ({
        el,
        role: el.matches(AI_STUDIO_USER_TURN) ? "user" : "assistant"
      }));
    },
    title(doc) {
      const t = cleanDocTitle(doc, /\s*[-|]\s*Google AI Studio.*$/i);
      return t && !/^(Google AI Studio|Untitled prompt|New chat)$/i.test(t) ? t : null;
    }
  };
  var kimiAdapter = {
    turns(doc) {
      return outermost(Array.from(doc.querySelectorAll(".segment-user, .segment-assistant"))).map(
        (el) => ({
          el,
          role: el.matches(".segment-user") ? "user" : "assistant"
        })
      );
    },
    title(doc) {
      const t = cleanDocTitle(doc, /\s+-\s+Kimi$/i);
      return t && !/^Kimi$/i.test(t) ? t : null;
    },
    strip: ".thinking-container"
  };
  var mistralAdapter = {
    turns: () => [],
    title(doc) {
      const t = cleanDocTitle(doc, /\s*[-|]\s*(Le Chat|Mistral).*$/i);
      return t && !/^(Le Chat|Mistral)/i.test(t) ? t : null;
    }
  };
  var ADAPTERS = {
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
    imported: { turns: () => [], title: () => null }
  };
  function CSS_ESCAPE(value) {
    return value.replace(/["\\]/g, "\\$&");
  }
  function unixToIsoOrNull(ts) {
    if (!ts) return null;
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  function extractVisibleDomConversation(doc, locationHref) {
    const providerAttr = doc.documentElement.getAttribute("data-tk-provider");
    const provider = isProviderId(providerAttr) ? providerAttr : detectProviderFromUrl(locationHref);
    if (!provider || provider === "imported" || provider === "grok_x") return null;
    const convIdAttr = doc.documentElement.getAttribute("data-tk-conversation-id") || doc.querySelector("[data-conversation-id]")?.getAttribute("data-conversation-id");
    const sourceConversationId = convIdAttr || extractConversationIdFromUrl(locationHref);
    if (!sourceConversationId) return null;
    const branchAttr = doc.querySelector("[data-branch-id]")?.getAttribute("data-branch-id") || doc.documentElement.getAttribute("data-tk-branch-id") || "main";
    const branchId = branchAttr.trim() || "main";
    const adapter = ADAPTERS[provider];
    let turns = adapter.turns(doc);
    if (turns.length === 0 && provider !== "claude" && provider !== "chatgpt") {
      turns = genericTurns(doc);
    }
    if (turns.length === 0 && provider !== "claude" && provider !== "chatgpt") {
      turns = heuristicTurns(doc);
    }
    const messages = [];
    const usedIds = /* @__PURE__ */ new Set();
    let modelSlug = null;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const el = turn.el;
      if (el.closest(
        'form, [data-testid="composer"], [contenteditable="true"], [contenteditable="plaintext-only"]'
      )) {
        continue;
      }
      if (el.getAttribute("data-streaming") === "true" || el.classList.contains("result-streaming") || el.querySelector('[data-streaming="true"], .result-streaming') || adapter.isStreaming?.(el)) {
        continue;
      }
      const bodyNode = turn.body ?? el;
      const text = extractReadableText(bodyNode, turn.role === "user" ? void 0 : adapter.strip);
      if (!text) continue;
      if (turn.model) modelSlug = turn.model;
      const timeEl = el.querySelector("time[datetime]");
      const explicitTs = el.getAttribute("data-message-timestamp") || timeEl?.getAttribute("datetime") || null;
      const baseId = stableMessageKey(turn) ?? `${sourceConversationId}_${branchId}_m_${i}`;
      let sourceMessageId = baseId;
      for (let n = 2; usedIds.has(sourceMessageId); n++) sourceMessageId = `${baseId}#${n}`;
      usedIds.add(sourceMessageId);
      messages.push({
        sourceMessageId,
        role: turn.role,
        content: text,
        createdAt: unixToIsoOrNull(explicitTs),
        branchPath: branchId
      });
    }
    const adapterTitle = adapter.title(doc, locationHref, sourceConversationId);
    const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
    const derivedTitle = firstUser ? firstUser.replace(/\s+/g, " ").slice(0, 80).trim() : "";
    const title = (adapterTitle || derivedTitle || "Untitled conversation").trim();
    return {
      provider,
      sourceConversationId,
      branchId,
      canonicalUrl: canonicalizeConversationUrl(locationHref),
      title,
      coverage: messages.length > 0 ? "partial" : "title_only",
      messages,
      providerProjectName: adapter.project?.(doc, locationHref) ?? null,
      modelSlug
    };
  }
  function grokXCanonicalUrl(conversationId) {
    return `https://x.com/i/grok?conversation=${encodeURIComponent(conversationId)}`;
  }
  function grokXConversationToExtraction(conversationId, messages) {
    const firstUser = messages.find((m) => m.role === "user")?.text ?? "";
    const derivedTitle = firstUser.replace(/\s+/g, " ").slice(0, 80).trim();
    return {
      provider: "grok_x",
      sourceConversationId: conversationId,
      branchId: "main",
      canonicalUrl: grokXCanonicalUrl(conversationId),
      title: derivedTitle || "Untitled conversation",
      coverage: messages.length > 0 ? "partial" : "title_only",
      messages: messages.map((m) => ({
        sourceMessageId: m.id,
        role: m.role,
        content: m.text,
        createdAt: m.createdAt,
        branchPath: "main"
      })),
      providerProjectName: null,
      modelSlug: null
    };
  }
  function canonicalizeConversationUrl(href) {
    if (detectProviderFromUrl(href) === "grok_x") {
      const conv = extractConversationIdFromUrl(href);
      return conv ? grokXCanonicalUrl(conv) : "https://x.com/i/grok";
    }
    try {
      const u = new URL(href);
      const keep = new URLSearchParams();
      const conv = u.searchParams.get("conversation");
      if (conv) keep.set("conversation", conv);
      const qs = keep.toString();
      return `${u.origin}${u.pathname}${qs ? `?${qs}` : ""}`;
    } catch {
      return href;
    }
  }

  // src/core/grok-x.ts
  var GROK_X_MESSAGE_SOURCE = "threadkeeper-grok-x";
  var REST_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
  var MESSAGE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
  var MAX_MESSAGES = 5e3;
  var MAX_TEXT_LENGTH = 5e5;
  function isRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function parseGrokXCaptureMessage(data) {
    if (!isRecord(data) || data.source !== GROK_X_MESSAGE_SOURCE) return null;
    const rawRestId = data.restId;
    let restId = null;
    if (rawRestId !== null && rawRestId !== void 0) {
      if (typeof rawRestId !== "string" || !REST_ID_RE.test(rawRestId)) return null;
      restId = rawRestId;
    }
    const rawMessages = data.messages;
    if (!Array.isArray(rawMessages) || rawMessages.length === 0 || rawMessages.length > MAX_MESSAGES) {
      return null;
    }
    const messages = [];
    const ids = /* @__PURE__ */ new Set();
    for (const raw of rawMessages) {
      if (!isRecord(raw)) return null;
      const { id, role, text, createdAt } = raw;
      if (typeof id !== "string" || !MESSAGE_ID_RE.test(id) || ids.has(id)) return null;
      if (role !== "user" && role !== "assistant") return null;
      if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT_LENGTH) return null;
      if (createdAt !== null && (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)))) {
        return null;
      }
      ids.add(id);
      messages.push({ id, role, text, createdAt });
    }
    return { source: GROK_X_MESSAGE_SOURCE, restId, messages };
  }
  function mergeGrokXMessages(existing, incoming) {
    if (existing.length === 0) return incoming.slice();
    const incomingIds = new Set(incoming.map((m) => m.id));
    const overlaps = existing.map((m, i) => incomingIds.has(m.id) ? i : -1).filter((i) => i >= 0);
    let aligned = overlaps.length > 0;
    if (aligned) {
      const j0 = incoming.findIndex((m) => m.id === existing[overlaps[0]].id);
      for (let k = 0; overlaps[0] + k < existing.length && j0 + k < incoming.length; k++) {
        if (existing[overlaps[0] + k].id !== incoming[j0 + k].id) {
          aligned = false;
          break;
        }
      }
    }
    const merged = !aligned ? [...incoming, ...existing] : [
      ...existing.slice(0, overlaps[0]),
      ...incoming,
      ...existing.slice(overlaps[overlaps.length - 1] + 1).filter((m) => !incomingIds.has(m.id))
    ];
    if (merged.every((m) => m.createdAt)) {
      return merged.map((m, i) => ({ m, i, t: Date.parse(m.createdAt ?? "") })).sort((a, b) => a.t - b.t || a.i - b.i).map(({ m }) => m);
    }
    return merged;
  }

  // src/core/messaging.ts
  function validateWindowPostMessage(event, expectedExtensionOrigin, expectedHandshakeToken) {
    if (!event.data || typeof event.data !== "object") {
      return { allowed: false, reason: "Non-object postMessage data" };
    }
    const payload = event.data;
    if (payload.source !== "threadkeeper-manager-iframe") {
      return { allowed: false, reason: "Unrecognized postMessage source" };
    }
    if (event.origin !== expectedExtensionOrigin) {
      return {
        allowed: false,
        reason: `Rejected postMessage from untrusted origin: ${event.origin}`
      };
    }
    if (!expectedHandshakeToken || payload.handshakeToken !== expectedHandshakeToken) {
      return {
        allowed: false,
        reason: "Rejected postMessage with missing or invalid handshakeToken"
      };
    }
    return { allowed: true };
  }

  // src/entrypoints/content.ts
  var OVERLAY_DIALOG_ID = "threadkeeper-overlay-root";
  var activeHandshakeToken = "";
  var savedHostState = null;
  var overlayWatchdog = null;
  var OVERLAY_LOAD_TIMEOUT_MS = 5e3;
  var captureDebounceTimer = null;
  var lastCapturedFingerprint = "";
  function captureCurrentPageState() {
    const active = document.activeElement;
    let selectionStart = null;
    let selectionEnd = null;
    let selectionRange = null;
    if (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) {
      try {
        selectionStart = active.selectionStart;
        selectionEnd = active.selectionEnd;
      } catch {
      }
    } else if (active instanceof HTMLElement && active.isContentEditable) {
      try {
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          selectionRange = sel.getRangeAt(0).cloneRange();
        }
      } catch {
      }
    }
    const scrollableAncestors = [];
    const seenElements = /* @__PURE__ */ new Set();
    let cursor = active ?? document.scrollingElement;
    while (cursor) {
      if (cursor instanceof HTMLElement && (cursor.scrollTop !== 0 || cursor.scrollLeft !== 0)) {
        seenElements.add(cursor);
        scrollableAncestors.push({
          element: cursor,
          scrollTop: cursor.scrollTop,
          scrollLeft: cursor.scrollLeft
        });
      }
      cursor = cursor.parentElement;
    }
    const allHostNodes = document.querySelectorAll("*");
    for (let i = 0; i < allHostNodes.length; i++) {
      const node = allHostNodes[i];
      if (node instanceof HTMLElement && !seenElements.has(node) && node.id !== OVERLAY_DIALOG_ID && !node.closest(`#${OVERLAY_DIALOG_ID}`) && (node.scrollTop !== 0 || node.scrollLeft !== 0)) {
        seenElements.add(node);
        scrollableAncestors.push({
          element: node,
          scrollTop: node.scrollTop,
          scrollLeft: node.scrollLeft
        });
      }
    }
    return {
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      activeElement: active,
      selectionStart,
      selectionEnd,
      selectionRange,
      scrollableAncestors
    };
  }
  function restoreHostPageState(state) {
    if (!state) return;
    window.scrollTo(state.scrollX, state.scrollY);
    for (const item of state.scrollableAncestors) {
      if (document.contains(item.element)) {
        item.element.scrollTop = item.scrollTop;
        item.element.scrollLeft = item.scrollLeft;
      }
    }
    if (state.activeElement && state.activeElement instanceof HTMLElement && document.contains(state.activeElement)) {
      state.activeElement.focus({ preventScroll: true });
      if ((state.activeElement instanceof HTMLTextAreaElement || state.activeElement instanceof HTMLInputElement) && state.selectionStart !== null && state.selectionEnd !== null) {
        try {
          state.activeElement.setSelectionRange(
            state.selectionStart,
            state.selectionEnd
          );
        } catch {
        }
      } else if (state.activeElement.isContentEditable && state.selectionRange) {
        try {
          const sel = window.getSelection();
          if (sel) {
            sel.removeAllRanges();
            sel.addRange(state.selectionRange);
          }
        } catch {
        }
      }
    }
  }
  function closeOverlayAndRestore() {
    if (overlayWatchdog) {
      clearTimeout(overlayWatchdog);
      overlayWatchdog = null;
    }
    const existing = document.getElementById(OVERLAY_DIALOG_ID);
    if (existing) {
      if (existing instanceof HTMLDialogElement && existing.open) {
        try {
          existing.close();
        } catch {
        }
      }
      existing.remove();
    }
    activeHandshakeToken = "";
    const toRestore = savedHostState;
    savedHostState = null;
    restoreHostPageState(toRestore);
  }
  function openOrToggleOverlay(handshakeToken) {
    const existing = document.getElementById(OVERLAY_DIALOG_ID);
    if (existing) {
      closeOverlayAndRestore();
      return { state: "closed" };
    }
    savedHostState = captureCurrentPageState();
    activeHandshakeToken = handshakeToken;
    const dialog = document.createElement("dialog");
    dialog.id = OVERLAY_DIALOG_ID;
    dialog.setAttribute("aria-label", "Threadkeeper Workbench");
    dialog.style.cssText = [
      "padding: 0",
      "border: 1px solid rgba(22, 21, 20, 0.22)",
      "border-radius: 10px",
      "width: min(94vw, 1360px)",
      "height: min(90vh, 880px)",
      "max-width: 1360px",
      "max-height: 880px",
      "margin: auto",
      "background: #F6F4EF",
      "box-shadow: 0 24px 60px rgba(0, 0, 0, 0.28)",
      "overflow: hidden"
    ].join(";");
    const iframe = document.createElement("iframe");
    iframe.id = "threadkeeper-overlay-iframe";
    const extUrl = chrome.runtime.getURL(
      `manager.html?surface=overlay&token=${encodeURIComponent(handshakeToken)}`
    );
    iframe.src = extUrl;
    iframe.title = "Threadkeeper Conversation Manager";
    iframe.style.cssText = "width: 100%; height: 100%; border: 0; display: block; background: transparent;";
    dialog.addEventListener("cancel", (ev) => {
      ev.preventDefault();
      if (iframe.contentWindow) {
        const extOrigin = new URL(chrome.runtime.getURL("")).origin;
        iframe.contentWindow.postMessage(
          {
            source: "threadkeeper-host-overlay",
            handshakeToken: activeHandshakeToken,
            action: "REQUEST_ESCAPE"
          },
          extOrigin
        );
      } else {
        closeOverlayAndRestore();
      }
    });
    dialog.addEventListener("click", (ev) => {
      if (ev.target === dialog) {
        closeOverlayAndRestore();
      }
    });
    dialog.appendChild(iframe);
    document.body.appendChild(dialog);
    if (typeof dialog.showModal === "function") {
      dialog.showModal();
    } else {
      dialog.setAttribute("open", "true");
    }
    iframe.focus();
    armOverlayWatchdog(handshakeToken);
    return { state: "opened" };
  }
  function armOverlayWatchdog(token) {
    if (overlayWatchdog) clearTimeout(overlayWatchdog);
    overlayWatchdog = setTimeout(() => {
      overlayWatchdog = null;
      if (activeHandshakeToken !== token || !document.getElementById(OVERLAY_DIALOG_ID)) return;
      try {
        chrome.runtime.sendMessage(
          { type: "OVERLAY_FRAME_STATUS" },
          (resp) => {
            if (chrome.runtime.lastError || !resp?.ok || resp.redeemed) return;
            if (activeHandshakeToken !== token) return;
            closeOverlayAndRestore();
            chrome.runtime.sendMessage({ type: "OPEN_MANAGER_FALLBACK", reason: "overlay_frame_blocked" });
          }
        );
      } catch {
      }
    }, OVERLAY_LOAD_TIMEOUT_MS);
  }
  var pendingExplicitInvoke = false;
  var grokXConversation = null;
  function extractCurrentConversation() {
    const href = window.location.href;
    if (detectProviderFromUrl(href) === "grok_x") {
      const urlId = extractConversationIdFromUrl(href);
      if (!grokXConversation || urlId && urlId !== grokXConversation.id) return null;
      return grokXConversationToExtraction(grokXConversation.id, grokXConversation.messages);
    }
    return extractVisibleDomConversation(document, href);
  }
  function onGrokXWindowMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const capture = parseGrokXCaptureMessage(event.data);
    if (!capture) return;
    const href = window.location.href;
    if (detectProviderFromUrl(href) !== "grok_x") return;
    const urlId = extractConversationIdFromUrl(href);
    const id = capture.restId ?? urlId;
    if (!id || urlId && urlId !== id) return;
    const known = grokXConversation?.id === id ? grokXConversation.messages : [];
    grokXConversation = { id, messages: mergeGrokXMessages(known, capture.messages) };
    schedulePassiveDomCapture();
  }
  function schedulePassiveDomCapture(explicitInvoke = false) {
    if (explicitInvoke) {
      pendingExplicitInvoke = true;
    }
    if (captureDebounceTimer) {
      clearTimeout(captureDebounceTimer);
    }
    const isExplicit = pendingExplicitInvoke;
    captureDebounceTimer = setTimeout(() => {
      const useExplicit = pendingExplicitInvoke;
      pendingExplicitInvoke = false;
      const extracted = extractCurrentConversation();
      if (!extracted) return;
      const fingerprint = `${extracted.provider}:${extracted.sourceConversationId}:${extracted.branchId}:${extracted.title}:${extracted.providerProjectName ?? ""}:${extracted.messages.map((m) => `${m.sourceMessageId}:${m.content.length}`).join("|")}`;
      if (!useExplicit && fingerprint === lastCapturedFingerprint) return;
      if (typeof chrome !== "undefined" && chrome.runtime?.sendMessage) {
        try {
          chrome.runtime.sendMessage(
            {
              type: "PASSIVE_DOM_CAPTURE",
              explicitInvoke: useExplicit,
              payload: {
                provider: extracted.provider,
                sourceConversationId: extracted.sourceConversationId,
                branchId: extracted.branchId,
                canonicalUrl: extracted.canonicalUrl,
                title: extracted.title,
                createdAt: null,
                updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
                coverage: extracted.coverage,
                captureSource: "dom_observer",
                messages: extracted.messages,
                providerProjectName: extracted.providerProjectName,
                modelSlug: extracted.modelSlug
              }
            },
            (resp) => {
              if (resp?.ok) {
                lastCapturedFingerprint = fingerprint;
              }
            }
          );
        } catch {
        }
      }
    }, isExplicit ? 50 : 900);
  }
  var ISOLATED_WORLD_GUARD = Symbol.for("threadkeeper.contentScriptInitialized");
  var isolatedGlobal = globalThis;
  if (!isolatedGlobal[ISOLATED_WORLD_GUARD]) {
    isolatedGlobal[ISOLATED_WORLD_GUARD] = true;
    window.addEventListener("message", (event) => {
      if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return;
      const extOrigin = new URL(chrome.runtime.getURL("")).origin;
      const check = validateWindowPostMessage(
        event,
        extOrigin,
        activeHandshakeToken
      );
      if (!check.allowed) {
        return;
      }
      const payload = event.data;
      if (payload.action === "CLOSE_OVERLAY") {
        closeOverlayAndRestore();
      }
    });
    const onX = isXHostname(window.location.hostname);
    if (onX) {
      window.addEventListener("message", onGrokXWindowMessage);
    }
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (message && message.type === "TOGGLE_THREADKEEPER_OVERLAY" && typeof message.handshakeToken === "string" && message.handshakeToken.length >= 16) {
          const res = openOrToggleOverlay(message.handshakeToken);
          if (res.state === "opened") {
            schedulePassiveDomCapture(true);
          }
          sendResponse({ ok: true, state: res.state });
          return true;
        }
        if (message && message.type === "CLOSE_THREADKEEPER_OVERLAY") {
          if (typeof message.handshakeToken === "string" && message.handshakeToken.length >= 16 && activeHandshakeToken.length >= 16 && message.handshakeToken === activeHandshakeToken) {
            closeOverlayAndRestore();
            sendResponse({ ok: true, state: "closed" });
          } else {
            sendResponse({
              ok: false,
              error: "Invalid or missing handshakeToken"
            });
          }
          return true;
        }
        return false;
      });
    }
    if (!onX && typeof MutationObserver !== "undefined" && document.documentElement) {
      const isOverlayNode = (node) => node instanceof Element && (node.id === OVERLAY_DIALOG_ID || Boolean(node.closest(`#${OVERLAY_DIALOG_ID}`)));
      const observer = new MutationObserver((mutations) => {
        if (mutations.every((m) => {
          if (isOverlayNode(m.target)) return true;
          const changed = [
            ...Array.from(m.addedNodes),
            ...Array.from(m.removedNodes)
          ];
          return changed.length > 0 && changed.every(isOverlayNode);
        })) {
          return;
        }
        schedulePassiveDomCapture();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
      schedulePassiveDomCapture();
    }
  }
})();
