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
    "imported",
    // Synced from the user's own Paperclip server (Settings → Paperclip), never captured from a page.
    "paperclip",
    // Agents and chats on hosts Threadkeeper already reads (path-routed like claude_code).
    "chatgpt_dots",
    "claude_duet",
    "grok_bot",
    // Products on their own hosts: host access is asked for when the user turns them on.
    "muse",
    "meta_ai",
    "poe",
    "huggingchat",
    "qwen",
    "doubao",
    "zai",
    "manus",
    "genspark",
    "minimax_agent",
    "character_ai",
    "duck_ai",
    "lumo",
    "arena",
    "t3_chat",
    "gemini_notebook",
    "github_copilot",
    "cursor_agents",
    "devin",
    "jules",
    "lovable",
    "bolt",
    "v0",
    "replit",
    "lobechat",
    // Sites the user adds in Settings → Capture: a catch-all plus self-hosted apps recognised on them.
    "custom_web",
    "open_webui",
    "librechat",
    "anythingllm"
  ];
  var NON_CAPTURE_PROVIDER_IDS = ["imported", "paperclip"];
  function legacy(id, entry) {
    return { id, hostAccess: "required", captureMode: "passive", defaultEnabled: true, reopen: "web", ...entry };
  }
  function optional(id, entry) {
    return { id, hostAccess: "optional", captureMode: "passive", defaultEnabled: false, reopen: "web", ...entry };
  }
  function custom(id, entry) {
    return { id, hostAccess: "custom", captureMode: "passive", defaultEnabled: true, reopen: "web", ...entry };
  }
  var PROVIDERS = {
    chatgpt: legacy("chatgpt", {
      label: "ChatGPT",
      maker: "OpenAI",
      category: "chat",
      matchPatterns: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
      idParams: [],
      selectorConfidence: "high",
      captureNote: "Chats, custom GPTs and ChatGPT Projects (project name is used for auto-filing)."
    }),
    claude: legacy("claude", {
      label: "Claude",
      maker: "Anthropic",
      category: "chat",
      matchPatterns: ["https://claude.ai/*"],
      selectorConfidence: "high",
      captureNote: "Chats on claude.ai, including chats inside Claude Projects."
    }),
    claude_code: legacy("claude_code", {
      label: "Claude Code",
      maker: "Anthropic",
      category: "coding_agent",
      matchPatterns: ["https://claude.ai/*"],
      reopen: "terminal",
      selectorConfidence: "high",
      captureNote: "Claude Code on the web (claude.ai/code) plus local CLI sessions imported from ~/.claude/projects."
    }),
    codex: legacy("codex", {
      label: "Codex",
      maker: "OpenAI",
      category: "coding_agent",
      matchPatterns: ["https://chatgpt.com/*"],
      reopen: "terminal",
      selectorConfidence: "high",
      captureNote: "Codex cloud tasks (chatgpt.com/codex) plus local Codex CLI sessions imported from ~/.codex/sessions."
    }),
    grok: legacy("grok", {
      label: "Grok",
      maker: "xAI",
      category: "chat",
      matchPatterns: ["https://grok.com/*"],
      selectorConfidence: "medium",
      captureNote: "Conversations on grok.com."
    }),
    grok_x: legacy("grok_x", {
      label: "Grok on X",
      maker: "xAI",
      category: "chat",
      // X is a single-page app: /i/grok is reached without a page load, so scripts run on every
      // X page. Only /i/grok is ever captured (see detectProviderFromUrl).
      matchPatterns: ["https://x.com/*", "https://twitter.com/*"],
      idParams: ["conversation"],
      selectorConfidence: "high",
      captureNote: "Grok conversations inside X (x.com/i/grok), read from the conversation data X itself loads. Other X pages are never captured."
    }),
    gemini: legacy("gemini", {
      label: "Gemini",
      maker: "Google",
      category: "chat",
      matchPatterns: ["https://gemini.google.com/*"],
      selectorConfidence: "medium",
      captureNote: "Conversations and Gems on gemini.google.com."
    }),
    ai_studio: legacy("ai_studio", {
      label: "Google AI Studio",
      maker: "Google",
      category: "chat",
      matchPatterns: ["https://aistudio.google.com/*"],
      selectorConfidence: "medium",
      captureNote: "Saved prompts and chats on aistudio.google.com."
    }),
    perplexity: legacy("perplexity", {
      label: "Perplexity",
      maker: "Perplexity",
      category: "search",
      matchPatterns: ["https://www.perplexity.ai/*", "https://perplexity.ai/*"],
      selectorConfidence: "medium",
      captureNote: "Threads on perplexity.ai."
    }),
    deepseek: legacy("deepseek", {
      label: "DeepSeek",
      maker: "DeepSeek",
      category: "chat",
      matchPatterns: ["https://chat.deepseek.com/*"],
      selectorConfidence: "medium",
      captureNote: "Chats on chat.deepseek.com."
    }),
    mistral: legacy("mistral", {
      label: "Le Chat",
      maker: "Mistral",
      category: "chat",
      matchPatterns: ["https://chat.mistral.ai/*"],
      selectorConfidence: "low",
      captureNote: "Chats on chat.mistral.ai."
    }),
    copilot: legacy("copilot", {
      label: "Copilot",
      maker: "Microsoft",
      category: "chat",
      matchPatterns: [
        "https://copilot.microsoft.com/*",
        "https://copilot.com/*",
        "https://www.copilot.com/*"
      ],
      selectorConfidence: "medium",
      captureNote: "Chats on copilot.microsoft.com and copilot.com (copilot.com/chat/conversation/\u2026)."
    }),
    kimi: legacy("kimi", {
      label: "Kimi",
      maker: "Moonshot AI",
      category: "chat",
      matchPatterns: ["https://www.kimi.com/*", "https://kimi.com/*", "https://kimi.ai/*"],
      // The international site (Aug 2026). Asked for at runtime so the update does not disable
      // the extension with a new install-time permission.
      optionalMatchPatterns: ["https://www.kimi.ai/*"],
      selectorConfidence: "medium",
      captureNote: "Chats on kimi.com and kimi.ai."
    }),
    paperclip: {
      id: "paperclip",
      label: "Paperclip",
      maker: "Paperclip",
      category: "agent",
      // Read from the user's own Paperclip server through its API (Settings → Paperclip), never captured.
      matchPatterns: [],
      hostAccess: "none",
      captureMode: "passive",
      defaultEnabled: false,
      selectorConfidence: "high",
      reopen: "web",
      captureNote: "Issues, comments and agent runs synced from your Paperclip server (Settings \u2192 Paperclip)."
    },
    imported: {
      id: "imported",
      label: "Imported",
      maker: "Other",
      category: "chat",
      matchPatterns: [],
      hostAccess: "none",
      captureMode: "passive",
      defaultEnabled: false,
      selectorConfidence: "high",
      reopen: "none",
      captureNote: "Threads imported from files that do not belong to a known provider."
    },
    chatgpt_dots: legacy("chatgpt_dots", {
      label: "ChatGPT dots",
      maker: "OpenAI",
      category: "agent",
      matchPatterns: ["https://chatgpt.com/*"],
      selectorConfidence: "medium",
      captureNote: "Your always-on dots on chatgpt.com/dots. The page does not show a conversation id, so each dot is filed by its own identity on the page."
    }),
    claude_duet: legacy("claude_duet", {
      label: "Claude Duet",
      maker: "Anthropic",
      category: "agent",
      matchPatterns: ["https://claude.ai/*"],
      selectorConfidence: "low",
      captureNote: "Claude Duet on claude.ai/duet (the main chat and its channels)."
    }),
    grok_bot: legacy("grok_bot", {
      label: "Grok Bot",
      maker: "xAI",
      category: "agent",
      matchPatterns: ["https://x.com/*", "https://twitter.com/*"],
      captureMode: "explicit",
      defaultEnabled: false,
      selectorConfidence: "low",
      captureNote: 'Your Grok Bot through X Chat (x.com/i/chat). X Chat also holds your private messages, so a chat is saved only when you open it and choose "Capture this tab"; nothing on X Chat is ever read on its own.'
    }),
    muse: optional("muse", {
      label: "Muse",
      maker: "Meta",
      category: "agent",
      matchPatterns: ["https://muse.ai/*", "https://www.muse.ai/*"],
      selectorConfidence: "low",
      captureNote: "Meta\u2019s Muse agent on muse.ai (threads at muse.ai/thread/\u2026)."
    }),
    meta_ai: optional("meta_ai", {
      label: "Meta AI",
      maker: "Meta",
      category: "chat",
      matchPatterns: ["https://www.meta.ai/*", "https://meta.ai/*"],
      selectorConfidence: "medium",
      captureNote: "Chats on meta.ai (meta.ai/prompt/\u2026)."
    }),
    poe: optional("poe", {
      label: "Poe",
      maker: "Quora",
      category: "chat",
      matchPatterns: ["https://poe.com/*"],
      selectorConfidence: "low",
      captureNote: "Chats with any bot on poe.com (poe.com/chat/\u2026)."
    }),
    huggingchat: optional("huggingchat", {
      label: "HuggingChat",
      maker: "Hugging Face",
      category: "chat",
      matchPatterns: ["https://huggingface.co/chat*"],
      selectorConfidence: "high",
      captureNote: "Chats on huggingface.co/chat. Other Hugging Face pages are never read."
    }),
    qwen: optional("qwen", {
      label: "Qwen Chat",
      maker: "Alibaba",
      category: "chat",
      matchPatterns: ["https://chat.qwen.ai/*"],
      selectorConfidence: "high",
      captureNote: "Chats on chat.qwen.ai."
    }),
    doubao: optional("doubao", {
      label: "Doubao",
      maker: "ByteDance",
      category: "chat",
      matchPatterns: ["https://www.doubao.com/*"],
      selectorConfidence: "high",
      captureNote: "Chats on doubao.com (\u8C46\u5305)."
    }),
    zai: optional("zai", {
      label: "Z.ai",
      maker: "Zhipu",
      category: "chat",
      matchPatterns: ["https://chat.z.ai/*", "https://zchat.z.ai/*"],
      selectorConfidence: "high",
      captureNote: "GLM chats on chat.z.ai."
    }),
    manus: optional("manus", {
      label: "Manus",
      maker: "Manus",
      category: "agent",
      matchPatterns: ["https://manus.im/*", "https://www.manus.im/*"],
      selectorConfidence: "medium",
      captureNote: "Manus tasks (manus.im/app/\u2026): your requests and Manus\u2019s replies; tool steps are left out."
    }),
    genspark: optional("genspark", {
      label: "Genspark",
      maker: "Genspark",
      category: "agent",
      matchPatterns: ["https://www.genspark.ai/*", "https://genspark.ai/*"],
      idParams: ["id"],
      selectorConfidence: "high",
      captureNote: "Genspark agent chats (genspark.ai/agents?id=\u2026)."
    }),
    minimax_agent: optional("minimax_agent", {
      label: "MiniMax Agent",
      maker: "MiniMax",
      category: "agent",
      matchPatterns: ["https://agent.minimax.io/*", "https://agent.minimaxi.com/*"],
      idParams: ["id"],
      selectorConfidence: "low",
      captureNote: "MiniMax Agent sessions (agent.minimax.io/?id=\u2026)."
    }),
    character_ai: optional("character_ai", {
      label: "Character.AI",
      maker: "Character.AI",
      category: "companion",
      matchPatterns: ["https://character.ai/*"],
      idParams: ["hist"],
      selectorConfidence: "medium",
      captureNote: "Chats with characters on character.ai. A chat opened from History keeps its own id."
    }),
    duck_ai: optional("duck_ai", {
      label: "Duck.ai",
      maker: "DuckDuckGo",
      category: "chat",
      matchPatterns: ["https://duck.ai/*"],
      idParams: ["chatID"],
      selectorConfidence: "high",
      captureNote: "Saved chats on duck.ai. Chats that Duck.ai does not save are not captured either."
    }),
    lumo: optional("lumo", {
      label: "Lumo",
      maker: "Proton",
      category: "chat",
      matchPatterns: ["https://lumo.proton.me/*"],
      selectorConfidence: "medium",
      captureNote: "Chats on lumo.proton.me."
    }),
    arena: optional("arena", {
      label: "Arena",
      maker: "LMArena",
      category: "chat",
      matchPatterns: ["https://arena.ai/*", "https://lmarena.ai/*"],
      selectorConfidence: "low",
      captureNote: "Chats and battles on arena.ai (formerly LMArena)."
    }),
    t3_chat: optional("t3_chat", {
      label: "T3 Chat",
      maker: "T3",
      category: "chat",
      matchPatterns: ["https://t3.chat/*"],
      selectorConfidence: "low",
      captureNote: "Chats on t3.chat."
    }),
    gemini_notebook: optional("gemini_notebook", {
      label: "Gemini Notebook",
      maker: "Google",
      category: "chat",
      matchPatterns: ["https://notebook.google.com/*", "https://notebooklm.google.com/*"],
      selectorConfidence: "medium",
      captureNote: "The chat inside each notebook (formerly NotebookLM)."
    }),
    github_copilot: optional("github_copilot", {
      label: "GitHub Copilot",
      maker: "GitHub",
      category: "coding_agent",
      matchPatterns: ["https://github.com/*"],
      selectorConfidence: "low",
      captureNote: "Copilot chats and agent tasks on github.com/copilot, and agent sessions on pull requests. No other GitHub page is read."
    }),
    cursor_agents: optional("cursor_agents", {
      label: "Cursor agents",
      maker: "Anysphere",
      category: "coding_agent",
      matchPatterns: ["https://cursor.com/*", "https://www.cursor.com/*"],
      idParams: ["id"],
      selectorConfidence: "low",
      captureNote: "Cursor background agents on cursor.com/agents."
    }),
    devin: optional("devin", {
      label: "Devin",
      maker: "Cognition",
      category: "coding_agent",
      matchPatterns: ["https://app.devin.ai/*"],
      selectorConfidence: "low",
      captureNote: "Devin sessions on app.devin.ai."
    }),
    jules: optional("jules", {
      label: "Jules",
      maker: "Google",
      category: "coding_agent",
      matchPatterns: ["https://jules.google.com/*"],
      selectorConfidence: "low",
      captureNote: "Jules tasks on jules.google.com."
    }),
    lovable: optional("lovable", {
      label: "Lovable",
      maker: "Lovable",
      category: "builder",
      matchPatterns: ["https://lovable.dev/*"],
      selectorConfidence: "medium",
      captureNote: "The chat of each Lovable project."
    }),
    bolt: optional("bolt", {
      label: "Bolt",
      maker: "StackBlitz",
      category: "builder",
      matchPatterns: ["https://bolt.new/*"],
      selectorConfidence: "low",
      captureNote: "The chat of each Bolt project (bolt.new/~/\u2026)."
    }),
    v0: optional("v0", {
      label: "v0",
      maker: "Vercel",
      category: "builder",
      matchPatterns: ["https://v0.app/*", "https://v0.dev/*"],
      selectorConfidence: "low",
      captureNote: "v0 chats (v0.app/chat/\u2026)."
    }),
    replit: optional("replit", {
      label: "Replit Agent",
      maker: "Replit",
      category: "builder",
      matchPatterns: ["https://replit.com/*"],
      selectorConfidence: "low",
      captureNote: "The Agent chat inside your Replit apps (replit.com/@you/app)."
    }),
    lobechat: optional("lobechat", {
      label: "LobeChat",
      maker: "LobeHub",
      category: "chat",
      matchPatterns: ["https://app.lobehub.com/*"],
      idParams: ["session", "topic"],
      selectorConfidence: "low",
      captureNote: "LobeChat on app.lobehub.com. Self-hosted LobeChat is recognised on sites you add below."
    }),
    custom_web: custom("custom_web", {
      label: "Other AI sites",
      maker: "Any",
      category: "chat",
      matchPatterns: [],
      selectorConfidence: "low",
      captureNote: "Sites you add yourself. Messages are found by their roles on the page."
    }),
    open_webui: custom("open_webui", {
      label: "Open WebUI",
      maker: "Self-hosted",
      category: "chat",
      matchPatterns: [],
      selectorConfidence: "medium",
      captureNote: "Recognised on sites you add."
    }),
    librechat: custom("librechat", {
      label: "LibreChat",
      maker: "Self-hosted",
      category: "chat",
      matchPatterns: [],
      selectorConfidence: "medium",
      captureNote: "Recognised on sites you add."
    }),
    anythingllm: custom("anythingllm", {
      label: "AnythingLLM",
      maker: "Self-hosted",
      category: "chat",
      matchPatterns: [],
      selectorConfidence: "low",
      captureNote: "Recognised on sites you add."
    })
  };
  var CAPTURE_PROVIDER_IDS = PROVIDER_IDS.filter(
    (id) => !NON_CAPTURE_PROVIDER_IDS.includes(id)
  );
  var OPTIONAL_PROVIDER_IDS = CAPTURE_PROVIDER_IDS.filter((id) => PROVIDERS[id].hostAccess === "optional");
  function providerCategory(id) {
    return isProviderId(id) ? PROVIDERS[id].category : "chat";
  }
  function isProviderId(value) {
    return typeof value === "string" && PROVIDER_IDS.includes(value);
  }
  function providerLabel(id) {
    return isProviderId(id) ? PROVIDERS[id].label : String(id);
  }
  var X_HOST_RE = /^(?:www\.|mobile\.)?(?:x|twitter)\.com$/;
  function isXHostname(hostname) {
    return X_HOST_RE.test(hostname.toLowerCase());
  }
  var KIMI_HOSTS = /* @__PURE__ */ new Set(["www.kimi.com", "kimi.com", "kimi.ai", "www.kimi.ai"]);
  var COPILOT_HOSTS = /* @__PURE__ */ new Set(["copilot.microsoft.com", "copilot.com", "www.copilot.com"]);
  var HOST_PROVIDERS = {
    "grok.com": "grok",
    "gemini.google.com": "gemini",
    "aistudio.google.com": "ai_studio",
    "chat.deepseek.com": "deepseek",
    "chat.mistral.ai": "mistral",
    "muse.ai": "muse",
    "www.muse.ai": "muse",
    "meta.ai": "meta_ai",
    "www.meta.ai": "meta_ai",
    "poe.com": "poe",
    "chat.qwen.ai": "qwen",
    "www.doubao.com": "doubao",
    "chat.z.ai": "zai",
    "zchat.z.ai": "zai",
    "www.zchat.z.ai": "zai",
    "manus.im": "manus",
    "www.manus.im": "manus",
    "genspark.ai": "genspark",
    "www.genspark.ai": "genspark",
    "agent.minimax.io": "minimax_agent",
    "agent.minimaxi.com": "minimax_agent",
    "character.ai": "character_ai",
    "duck.ai": "duck_ai",
    "lumo.proton.me": "lumo",
    "arena.ai": "arena",
    "lmarena.ai": "arena",
    "t3.chat": "t3_chat",
    "notebook.google.com": "gemini_notebook",
    "notebooklm.google.com": "gemini_notebook",
    "app.devin.ai": "devin",
    "jules.google.com": "jules",
    "bolt.new": "bolt",
    "v0.app": "v0",
    "v0.dev": "v0",
    "app.lobehub.com": "lobechat"
  };
  function providerForPage(parsed) {
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname;
    if (host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com") {
      if (/^(?:\/u\/[^/]+)?\/dots(\/|$)/.test(path)) return "chatgpt_dots";
      return /^(?:\/u\/[^/]+)?\/codex(\/|$)/.test(path) ? "codex" : "chatgpt";
    }
    if (host === "claude.ai" || host.endsWith(".claude.ai")) {
      if (/^\/duet(\/|$)/.test(path)) return "claude_duet";
      return /^\/code(\/|$)/.test(path) ? "claude_code" : "claude";
    }
    if (host.endsWith(".grok.com")) return "grok";
    if (isXHostname(host)) {
      if (/^\/i\/grok(\/|$)/.test(path)) return "grok_x";
      if (/^\/i\/chat(\/|$)/.test(path)) return "grok_bot";
      return null;
    }
    if (host === "perplexity.ai" || host.endsWith(".perplexity.ai")) return "perplexity";
    if (COPILOT_HOSTS.has(host)) return "copilot";
    if (KIMI_HOSTS.has(host)) return "kimi";
    if (host === "huggingface.co") return /^\/chat(\/|$)/.test(path) ? "huggingchat" : null;
    if (host === "github.com") {
      if (/^\/copilot(\/|$)/.test(path)) return "github_copilot";
      if (/^\/[^/]+\/[^/]+\/pull\/\d+\/agent-sessions(\/|$)/.test(path)) return "github_copilot";
      return null;
    }
    if (host === "cursor.com" || host === "www.cursor.com") {
      return /^\/agents(\/|$)/.test(path) ? "cursor_agents" : null;
    }
    if (host === "lovable.dev") return /^\/projects\//.test(path) ? "lovable" : null;
    if (host === "replit.com") return /^\/@[^/]+\/[^/]+/.test(path) ? "replit" : null;
    return HOST_PROVIDERS[host] ?? null;
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
    return isProviderId(hinted) && PROVIDERS[hinted].hostAccess !== "custom" ? hinted : null;
  }
  var SAFE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
  function safeId(value) {
    if (!value) return null;
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      return null;
    }
    return SAFE_ID_RE.test(decoded) ? decoded : null;
  }
  function firstMatch(path, re) {
    const m = path.match(re);
    return m ? m[1] : null;
  }
  function providerConversationId(provider, parsed) {
    const path = parsed.pathname;
    const q = (key) => safeId(parsed.searchParams.get(key));
    switch (provider) {
      case "grok_x":
        return q("conversation");
      case "grok_bot":
        return safeId(firstMatch(path, /^\/i\/chat\/([^/?#]+)/));
      case "ai_studio": {
        const m = firstMatch(path, /^\/prompts\/([a-zA-Z0-9_-]+)(?:\/|$)/);
        return m && m !== "new_chat" ? m : null;
      }
      case "kimi":
        return firstMatch(path, /^\/chat\/([0-9a-f-]{36}|[a-z0-9]{20})(?:\/|$)/);
      case "copilot":
        return firstMatch(path, /^\/chat\/conversation\/([a-zA-Z0-9_-]+)/) ?? firstMatch(path, /^\/chats\/([a-zA-Z0-9_-]+)/);
      case "chatgpt_dots": {
        const m = path.match(/^(?:\/u\/[^/]+)?\/dots\/([A-Za-z0-9][\w-]{0,63})~([A-Za-z0-9][\w-]{0,63})(?:\/|$)/);
        return m ? `dot_${m[1]}_${m[2]}` : null;
      }
      case "claude_duet": {
        const chan = firstMatch(path, /^\/duet\/(chan_[A-Za-z0-9_-]+)/);
        if (chan) return chan;
        return /^\/duet\/?$/.test(path) ? "duet_main" : null;
      }
      case "muse": {
        const thread = firstMatch(path, /^\/thread\/([A-Za-z0-9_-]+)\/?$/);
        if (thread) return thread === "new" ? null : thread;
        return path === "/" || path === "" ? "main" : null;
      }
      case "meta_ai":
        return firstMatch(path, /^\/prompt\/([A-Za-z0-9_-]+)\/?$/);
      case "poe":
        return firstMatch(path, /^\/chat\/([A-Za-z0-9]+)\/?$/);
      case "huggingchat":
        return firstMatch(path, /^\/chat\/conversation\/([0-9a-f]{24})\/?$/);
      case "qwen":
      case "zai":
      case "arena":
        return firstMatch(path, /^\/c\/([0-9A-Za-z][0-9A-Za-z_-]{7,})(?:\/|$)/);
      case "doubao": {
        const id = firstMatch(path, /^\/(?:code\/)?chat\/([A-Za-z0-9_-]+)/);
        return id && id !== "new" && !id.startsWith("local") ? id : null;
      }
      case "manus":
        return firstMatch(path, /^\/app\/([A-Za-z0-9_-]+)(?:[/?#]|$)/);
      case "genspark":
        return /^\/agents\/?$/.test(path) ? q("id") : null;
      case "minimax_agent":
        return /^\/(?:mavis\/?)?$/.test(path) ? q("id") : null;
      case "character_ai": {
        const character = firstMatch(path, /^\/chat\/([A-Za-z0-9_-]{8,128})\/?$/);
        if (!character) return null;
        return q("hist") ?? `c_${character}`;
      }
      case "duck_ai":
        return q("chatID");
      case "lumo":
        return firstMatch(path, /^(?:\/u\/\d+)?\/c\/([0-9A-Fa-f-]{8,})(?:\/|$)/);
      case "t3_chat":
        return firstMatch(path, /^\/chat\/([A-Za-z0-9_-]+)(?:\/|$)/);
      case "gemini_notebook":
        return firstMatch(path, /^\/notebook\/([A-Za-z0-9_-]+)(?:\/|$)/);
      case "github_copilot": {
        const chat = firstMatch(path, /^\/copilot\/c\/([A-Za-z0-9_-]+)/);
        if (chat) return chat;
        const task = firstMatch(path, /^\/copilot\/tasks\/([A-Za-z0-9_-]+)/);
        if (task) return `task_${task}`;
        const m = path.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)\/agent-sessions\/([A-Za-z0-9_-]+)/);
        return m ? `session_${m[4]}` : null;
      }
      case "cursor_agents": {
        const id = firstMatch(path, /^\/agents\/(bc-[A-Za-z0-9_-]+)/) ?? q("id");
        return id && id.startsWith("bc-") ? id : null;
      }
      case "devin":
        return firstMatch(path, /^\/sessions\/([A-Za-z0-9_-]+)/);
      case "jules":
        return firstMatch(path, /^\/(?:session|task)\/([A-Za-z0-9_-]+)/);
      case "lovable":
        return firstMatch(path, /^\/projects\/([A-Za-z0-9_-]+)/);
      case "bolt":
        return safeId(firstMatch(path, /^\/~\/([A-Za-z0-9_.-]+)/)?.replace(/\./g, "_"));
      case "v0": {
        const id = firstMatch(path, /^\/chat\/([A-Za-z0-9_-]+)/);
        return id && id !== "new" ? id : null;
      }
      case "replit": {
        const m = path.match(/^\/@([A-Za-z0-9_-]+)\/([A-Za-z0-9_.-]+)/);
        return m ? safeId(`${m[1]}_${m[2].replace(/\./g, "_")}`) : null;
      }
      case "lobechat": {
        const topic = q("topic");
        const session = q("session");
        return topic ? session ? `${session}_${topic}` : topic : session;
      }
      case "custom_web":
      case "open_webui":
      case "librechat":
      case "anythingllm":
      case "imported":
      case "paperclip":
        return null;
      default:
        return void 0;
    }
  }
  function extractConversationIdFromUrl(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return null;
    }
    const owner = providerForPage(parsed);
    if (owner) {
      const specific = providerConversationId(owner, parsed);
      if (specific !== void 0) return specific;
    }
    const path = parsed.pathname;
    const patterns2 = [
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
    for (const re of patterns2) {
      const m = path.match(re);
      if (m) return m[1];
    }
    const grokParam = parsed.searchParams.get("conversation");
    if (grokParam) return grokParam;
    return owner ? null : parsed.searchParams.get("tk_conv_id");
  }
  function conversationQueryParams(provider) {
    const own = provider ? PROVIDERS[provider].idParams ?? [] : [];
    return Array.from(/* @__PURE__ */ new Set(["conversation", ...own]));
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

  // src/core/repository.ts
  var SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;
  var HOSTS = /^(?:www\.)?(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)$/i;
  var GITHUB_SECTIONS = /* @__PURE__ */ new Set([
    "about",
    "account",
    "apps",
    "codespaces",
    "collections",
    "copilot",
    "customer-stories",
    "dashboard",
    "enterprise",
    "events",
    "explore",
    "features",
    "issues",
    "join",
    "login",
    "logout",
    "marketplace",
    "new",
    "notifications",
    "organizations",
    "orgs",
    "pricing",
    "pulls",
    "readme",
    "search",
    "security",
    "sessions",
    "settings",
    "signup",
    "site",
    "sponsors",
    "team",
    "topics",
    "trending",
    "users"
  ]);
  function isSiteSection(hostname, owner) {
    return /^(?:www\.)?github\.com$/i.test(hostname) && GITHUB_SECTIONS.has(owner);
  }
  function cleanSegment(value) {
    const v = value.trim().replace(/\.git$/i, "");
    if (!SEGMENT.test(v) || v === "." || v === "..") return null;
    return v.toLowerCase();
  }
  function normalizeRepository(input) {
    if (!input) return null;
    let text2 = input.trim();
    if (!text2 || text2.length > 400) return null;
    const ssh = text2.match(/^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
    if (ssh) {
      const owner = cleanSegment(ssh[2]);
      const name = cleanSegment(ssh[3]);
      return owner && name ? `${owner}/${name}` : null;
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text2)) {
      let url;
      try {
        url = new URL(text2);
      } catch {
        return null;
      }
      if (!HOSTS.test(url.hostname)) return null;
      const parts2 = url.pathname.split("/").filter(Boolean);
      if (parts2.length < 2) return null;
      const owner = cleanSegment(parts2[0]);
      const name = cleanSegment(parts2[1]);
      if (owner && isSiteSection(url.hostname, owner)) return null;
      return owner && name ? `${owner}/${name}` : null;
    }
    text2 = text2.replace(/\s*\/\s*/g, "/");
    const parts = text2.split("/");
    if (parts.length === 2) {
      const owner = cleanSegment(parts[0]);
      const name = cleanSegment(parts[1]);
      return owner && name ? `${owner}/${name}` : null;
    }
    if (parts.length === 1) return cleanSegment(parts[0]);
    return null;
  }
  function repositoryName(repository) {
    const slash = repository.lastIndexOf("/");
    return slash === -1 ? repository : repository.slice(slash + 1);
  }
  function normalizePullRequestUrl(input) {
    if (!input) return null;
    let url;
    try {
      url = new URL(input.trim());
    } catch {
      return null;
    }
    if (url.protocol !== "https:" || !HOSTS.test(url.hostname)) return null;
    const m = url.pathname.match(/^\/([^/]+)\/([^/]+)(?:\/-)?\/(pull|pulls|merge_requests|pull-requests)\/(\d+)/);
    if (!m) return null;
    const owner = cleanSegment(m[1]);
    const name = cleanSegment(m[2]);
    if (!owner || !name || isSiteSection(url.hostname, owner)) return null;
    const kind = m[3] === "pulls" ? "pull" : m[3];
    return `https://${url.hostname.replace(/^www\./i, "").toLowerCase()}/${owner}/${name}/${kind}/${m[4]}`;
  }

  // src/core/custom-sites.ts
  function fnv1a32Hex(text2) {
    let h = 2166136261;
    for (let i = 0; i < text2.length; i++) {
      h ^= text2.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h.toString(16).padStart(8, "0");
  }
  function siteConversationKey(origin) {
    try {
      const url = new URL(origin);
      return `${url.hostname}${url.port ? `-${url.port}` : ""}`.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
    } catch {
      return "site";
    }
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
  function firstText(doc, selectors) {
    for (const sel of selectors) {
      const el = doc.querySelector(sel);
      const text2 = el?.textContent?.replace(/\s+/g, " ").trim();
      if (text2) return text2;
    }
    return null;
  }
  function firstTitle(doc, selectors, placeholder) {
    for (const sel of selectors) {
      for (const el of Array.from(doc.querySelectorAll(sel))) {
        const text2 = extractReadableText(el).replace(/\s+/g, " ").trim();
        if (text2 && !placeholder.test(text2)) return text2;
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
    const roleAttr = el.getAttribute("data-message-author-role") || el.getAttribute("data-tk-message-role") || el.querySelector("[data-message-author-role]")?.getAttribute("data-message-author-role") || // ChatGPT's turn wrapper names its speaker even when the message inside has not rendered yet.
    el.getAttribute("data-turn") || (el.classList.contains("font-user-message") ? "user" : "assistant");
    return roleAttr === "user" || roleAttr === "human" ? "user" : roleAttr === "tool" ? "tool" : "assistant";
  }
  function messageBodies(el) {
    const explicit = el.querySelector("[data-message-content]");
    if (explicit) return { body: explicit };
    const markdown = outermost(Array.from(el.querySelectorAll(".markdown")));
    if (markdown.length > 1) return { body: markdown[0], bodies: markdown };
    return { body: markdown[0] ?? el.querySelector(".whitespace-pre-wrap") ?? null };
  }
  function messageTurn(el, container) {
    const withRole = el.hasAttribute("data-message-author-role") ? el : container;
    return {
      el,
      role: genericRole(withRole),
      ...messageBodies(el),
      id: el.getAttribute("data-message-id") || el.querySelector("[data-message-id]")?.getAttribute("data-message-id") || null,
      model: el.getAttribute("data-message-model-slug") || el.querySelector("[data-message-model-slug]")?.getAttribute("data-message-model-slug") || null
    };
  }
  function genericTurns(doc) {
    const turns = [];
    for (const container of outermost(Array.from(doc.querySelectorAll(GENERIC_ROLE_SELECTOR)))) {
      const own = container.hasAttribute("data-message-author-role") ? [container] : [];
      const inner = outermost(Array.from(container.querySelectorAll("[data-message-author-role]")));
      const messages = own.length > 0 ? own : inner;
      if (messages.length > 1) {
        for (const el of messages) turns.push(messageTurn(el, container));
      } else {
        turns.push(messageTurn(container, container));
      }
    }
    return turns;
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
  function roleAdapter(spec) {
    return {
      turns(doc) {
        const scope = spec.scope && doc.querySelector(spec.scope) || doc;
        return outermost(Array.from(scope.querySelectorAll(spec.turns))).filter((el) => !(spec.exclude && (el.matches(spec.exclude) || el.closest(spec.exclude)))).map((el) => {
          const user = spec.isUser(el);
          const bodySel = user ? spec.userBody : spec.assistantBody;
          let body = null;
          let bodies;
          if (bodySel) {
            if (!user && spec.assistantBodies) {
              const all = outermost(Array.from(el.querySelectorAll(bodySel)));
              if (all.length > 1) bodies = all;
              body = all[0] ?? null;
            } else {
              body = el.matches(bodySel) ? el : el.querySelector(bodySel);
            }
          }
          return { el, role: user ? "user" : "assistant", body: body ?? el, bodies, id: spec.idOf?.(el) ?? null };
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
      conversationId: spec.conversationId
    };
  }
  function titleWithout(doc, product, placeholder) {
    const t = doc.title.replace(new RegExp(`\\s*[-|\u2013\u2014\u2022\xB7:]\\s*(?:${product.source})\\s*$`, "i"), "").replace(new RegExp(`^\\s*(?:${product.source})\\s*[-|\u2013\u2014\u2022\xB7:]\\s*`, "i"), "").trim();
    if (!t || new RegExp(`^(?:${product.source})$`, "i").test(t)) return null;
    if (placeholder && placeholder.test(t)) return null;
    return t;
  }
  var hasClass = (el, name) => el.classList.contains(name);
  var matchesAnyOf = (el, sel) => el.matches(sel) || Boolean(el.querySelector(sel));
  var DOTS_ROW = ".messaging-root .message-list .message-row[data-message-id], .message-list .message-row[data-message-id]";
  function dotIdentity(doc) {
    for (const a of Array.from(doc.querySelectorAll('a[href*="/dots/"]'))) {
      const current = a.getAttribute("aria-current");
      if (current && current !== "false") {
        const m = (a.getAttribute("href") ?? "").match(/\/dots\/([A-Za-z0-9][\w-]{0,63})~([A-Za-z0-9][\w-]{0,63})/);
        if (m) return `dot_${m[1]}_${m[2]}`;
      }
    }
    const holder = doc.querySelector(".messaging-root [data-room-id], .messaging-root [data-thread-id], [data-messaging-room-id]");
    const raw = holder?.getAttribute("data-room-id") || holder?.getAttribute("data-thread-id") || holder?.getAttribute("data-messaging-room-id");
    if (raw && /^[\w-]{1,100}$/.test(raw)) return `room_${raw}`;
    const name = firstText(doc, [
      '.messaging-root [data-testid="dot-name"]',
      ".messaging-root header h1",
      ".messaging-root header h2",
      '.messaging-root [class*="header"] [class*="name"]'
    ]);
    return name ? `dotname_${fnv1a32Hex(name.toLowerCase())}` : null;
  }
  var chatgptDotsAdapter = roleAdapter({
    turns: DOTS_ROW,
    isUser: (el) => hasClass(el, "self"),
    userBody: ".message-text",
    assistantBody: ".message-text",
    idOf: (el) => el.getAttribute("data-message-id"),
    title(doc) {
      const name = firstText(doc, ['.messaging-root [data-testid="dot-name"]', ".messaging-root header h1", ".messaging-root header h2"]);
      return name ? `${name} (dot)` : null;
    },
    conversationId: dotIdentity,
    stabilize: true,
    noFallback: true
  });
  var claudeDuetAdapter = {
    ...claudeAdapter,
    title(doc) {
      const t = firstText(doc, ['[data-testid="duet-channel-name"]', '[data-testid="chat-title-button"]']) ?? cleanDocTitle(doc, /\s*[-|]\s*Claude.*$/i);
      return t && !/^(Claude|Duet|Claude Duet)$/i.test(t) ? t : null;
    },
    stabilize: true
  };
  function xChatRoot(doc) {
    if (doc.querySelector('[data-testid="dm-message-scroller"]')) return doc;
    for (const el of Array.from(doc.querySelectorAll("main *"))) {
      const root = el.shadowRoot;
      if (root && root.querySelector('[data-testid="dm-conversation-more-button"], [data-testid="dm-message-scroller"]')) return root;
    }
    return null;
  }
  var X_CHAT_OWN = /(^|\s)(justify-end|items-end|self-end|flex-row-reverse|ml-auto)(\s|$)/;
  var grokBotAdapter = {
    turns(doc) {
      const root = xChatRoot(doc);
      if (!root) return [];
      const rows = Array.from(root.querySelectorAll('[data-testid^="message-"]')).filter(
        (el) => !/^message-text-/.test(el.getAttribute("data-testid") ?? "")
      );
      return outermost(rows).map((el) => {
        const testId = el.getAttribute("data-testid") ?? "";
        const own = el.getAttribute("data-own") === "true" || X_CHAT_OWN.test(typeof el.className === "string" ? el.className : "") || Boolean(el.querySelector(':scope > [class*="justify-end"], :scope > [class*="items-end"]'));
        return {
          el,
          role: own ? "user" : "assistant",
          body: el.querySelector('[data-testid^="message-text-"]') ?? el,
          id: testId.replace(/^message-/, "") || null
        };
      });
    },
    title(doc) {
      const root = xChatRoot(doc);
      const header = root?.querySelector('[data-testid="dm-conversation-header"]');
      const name = header ? extractReadableText(header).split("\n")[0]?.trim() : "";
      return name ? `${name} on X Chat` : null;
    },
    stabilize: true,
    noFallback: true
  };
  var META_ASSISTANT = '[data-testid="assistant-message"]';
  var metaAiAdapter = roleAdapter({
    turns: "[data-message-item][data-message-id], [data-message-item]",
    scope: 'div[role="feed"]',
    isUser: (el) => el.hasAttribute("data-user-message") || Boolean(el.querySelector('[data-message-type="user"]')),
    userBody: '[data-message-type="user"]',
    assistantBody: META_ASSISTANT,
    idOf: (el) => el.getAttribute("data-message-id"),
    strip: '[data-testid^="subagent-cot"], [data-testid="sources-pill"], [data-testid="source-search-pill"], [data-testid="skip-reasoning-button"]',
    isStreaming: (el) => Boolean(el.querySelector(`${META_ASSISTANT}[data-streaming-state="STREAMING"], ${META_ASSISTANT}[data-streaming-state="INIT"]`)),
    title(doc, _url, id) {
      const sidebar = id ? firstTitle(doc, [`[data-testid="conversation-item"] a[href$="/prompt/${CSS_ESCAPE(id)}"]`, `[data-testid="conversation-item"][href$="/prompt/${CSS_ESCAPE(id)}"]`], /^(Meta AI|New chat)$/i) : null;
      if (sidebar) return sidebar;
      const clean = doc.title.replace(/^\(\d+\+?\)\s*/, "");
      const t = clean.replace(/\s*[-|–—]\s*Meta AI.*$/i, "").trim();
      return t && !/^(Meta AI|New chat)$/i.test(t) ? t : null;
    }
  });
  var museAdapter = roleAdapter({
    turns: '[data-message-id][data-role], [data-message-role], [data-testid="user-message"], [data-testid="assistant-message"], [data-testid="agent-message"]',
    isUser: (el) => /^(user|human)$/i.test(el.getAttribute("data-role") ?? el.getAttribute("data-message-role") ?? "") || el.getAttribute("data-testid") === "user-message",
    idOf: (el) => el.getAttribute("data-message-id"),
    title: (doc) => titleWithout(doc, /Muse(?:\s+[-—]\s+Your Personal AI Agent from Meta)?/, /^(New thread|Home)$/i),
    stabilize: true
  });
  var poeAdapter = roleAdapter({
    turns: '[class*="ChatMessage_messageRow"], [class*="ChatMessage_chatMessage"]',
    isUser: (el) => matchesAnyOf(el, '[class*="rightSideMessage"], [class*="humanMessageBubble"]'),
    userBody: '[class*="Markdown_markdownContainer"], [class*="Prose_prose"], [class*="Message_messageTextContainer"]',
    assistantBody: '[class*="Markdown_markdownContainer"], [class*="Prose_prose"], [class*="Message_messageTextContainer"]',
    idOf: (el) => el.getAttribute("data-message-id") ?? el.querySelector("[data-message-id]")?.getAttribute("data-message-id") ?? null,
    docStreaming: 'button[class*="ChatStopMessageButton"]',
    title: (doc) => titleWithout(doc, /Poe/),
    stabilize: true
  });
  var huggingChatAdapter = roleAdapter({
    turns: '[data-message-role="assistant"][data-message-id], [data-message-type="user"][data-message-id]',
    isUser: (el) => el.getAttribute("data-message-type") === "user",
    userBody: "p.disabled, .disabled",
    assistantBody: ".prose",
    assistantBodies: true,
    idOf: (el) => el.getAttribute("data-message-id"),
    docStreaming: 'button.stop-generating-btn, button[aria-label="Stop generating"]',
    title: (doc) => titleWithout(doc, /HuggingChat/, /^New Chat$/i)
  });
  var QWEN_USER = '.qwen-chat-message-user, .chat-user-message-wrapper, [data-role="user"]';
  var qwenAdapter = roleAdapter({
    turns: `${QWEN_USER}, .qwen-chat-message-assistant, [data-role="assistant"]`,
    isUser: (el) => el.matches(QWEN_USER),
    userBody: ".user-message-content",
    assistantBody: ".response-message-content",
    idOf: (el) => el.id.match(/^(?:chat-response-message|qwen-chat-message-assistant|qwen-chat-message-user)-(.+)$/)?.[1] ?? el.getAttribute("data-message-id"),
    strip: ".qwen-chat-thinking-status-card, .qwen-chat-thinking-tool-status-card-wraper, .response-message-footer",
    docStreaming: 'button.stop-button, [class*="stop-button"]',
    title: (doc) => titleWithout(doc, /Qwen(?:\s*Chat)?/, /^New Chat$/i)
  });
  var doubaoAdapter = roleAdapter({
    turns: '[data-target-id="message-box-target-id"] [data-message-id], [data-testid="send_message"], [data-testid="receive_message"]',
    isUser: (el) => hasClass(el, "justify-end") || el.getAttribute("data-testid") === "send_message",
    userBody: '.whitespace-pre-wrap, [data-testid="message_text_content"]',
    assistantBody: '.flow-markdown-body, .md-box-root, [data-testid="message_text_content"]',
    idOf: (el) => el.getAttribute("data-message-id"),
    strip: '[data-testid="think_block_collapse"]',
    docStreaming: '[data-testid="chat_input_local_break_button"], [class*="break-btn-"]',
    title(doc) {
      return firstTitle(doc, ['#flow_chat_sidebar a[aria-current="page"] [data-testid="chat_list_item_title"]'], /^(新对话|New chat)$/) ?? titleWithout(doc, /豆包|Doubao/);
    }
  });
  var OWUI_TURN = '#messages-container [id^="message-"]';
  function openWebUiAdapter(product) {
    return roleAdapter({
      turns: OWUI_TURN,
      isUser: (el) => hasClass(el, "user-message") || Boolean(el.querySelector(":scope > .user-message, .chat-user")),
      userBody: ".chat-user .markdown-prose, .chat-user .whitespace-pre-wrap, .chat-user",
      assistantBody: "#response-content-container, .markdown-prose:not(.chat-user)",
      idOf: (el) => el.id.replace(/^message-/, "") || null,
      strip: '.thinking-chain-container, .thinking-block, details[type="reasoning"], details[type="tool_calls"]',
      docStreaming: 'div[aria-label="\u505C\u6B62"] button, button[aria-label="Stop"], #stop-response-button',
      title: (doc) => titleWithout(doc, product, /^(New Chat|新聊天)$/i)
    });
  }
  var zaiAdapter = openWebUiAdapter(/Z\.ai(?:\s*Chat)?|GLM/);
  var openWebUiSiteAdapter = openWebUiAdapter(/Open WebUI/);
  var manusAdapter = roleAdapter({
    turns: '[data-chat-question-bubble="true"], .manus-markdown',
    scope: 'div[class*="--chat-message-list"]',
    isUser: (el) => el.getAttribute("data-chat-question-bubble") === "true",
    exclude: "[data-chat-suggested-follow-ups]",
    title: (doc) => titleWithout(doc, /Manus/),
    stabilize: true
  });
  var gensparkAdapter = roleAdapter({
    turns: ".conversation-statement",
    isUser: (el) => hasClass(el, "user"),
    userBody: ".content",
    assistantBody: ".markdown-viewer",
    docStreaming: "svg.stop-icon",
    title(doc) {
      const input = doc.querySelector("input.agent-name-input");
      const value = input?.value?.trim() || input?.getAttribute("value")?.trim();
      return value || firstText(doc, ["main h1"]) || titleWithout(doc, /Genspark/);
    }
  });
  var characterAdapter = {
    turns(doc) {
      const list = doc.querySelector("#chat-messages");
      if (!list) return [];
      const turns = [];
      for (const child of Array.from(list.children)) {
        if (child.querySelector(".ticontainer")) continue;
        const active = child.querySelector(".swiper-slide-active") ?? child;
        const prose = active.querySelector('[data-testid="completed-message"] .prose') ?? active.querySelector(".prose");
        if (!prose) continue;
        const user = Boolean(child.querySelector(".flex-row-reverse"));
        const bot = Boolean(child.querySelector(".cai-badge"));
        if (user === bot) continue;
        turns.push({ el: child, role: user ? "user" : "assistant", body: prose });
      }
      return turns.reverse();
    },
    title(doc) {
      const name = firstText(doc, ['#chat-header a[href^="/character/"] p']);
      return name ? `Chat with ${name}` : titleWithout(doc, /Character\.AI|character\.ai/);
    },
    isStreaming: (el) => Boolean(el.querySelector(".ticontainer")),
    hashIds: true,
    stabilize: true,
    noFallback: true
  };
  var duckAdapter = roleAdapter({
    turns: '[data-testid="user-message"], [data-activeresponse="true"] > :nth-child(2)',
    isUser: (el) => el.getAttribute("data-testid") === "user-message",
    strip: '[data-message-actions], button[data-streamdown="code-block-copy-button"]',
    title: (doc) => titleWithout(doc, /Duck\.ai|DuckDuckGo AI Chat/),
    stabilize: true
  });
  var lumoAdapter = roleAdapter({
    turns: ".lumo-chat-item[data-message-role]",
    isUser: (el) => el.getAttribute("data-message-role") === "user",
    userBody: ".user-msg-container .lumo-markdown, .lumo-markdown",
    assistantBody: ".progressive-markdown-content, .lumo-markdown",
    strip: ".thinking-path, .action-toolbar, .user-toolbar",
    docStreaming: '.lumo-input-container button[aria-label*="Stop"], .thinking-path-header[aria-busy="true"]',
    title: (doc) => titleWithout(doc, /Lumo(?:\s+by\s+Proton)?|Proton Lumo/, /^New chat$/i)
  });
  var arenaAdapter = roleAdapter({
    turns: 'div.group.self-end, div[class*="bg-surface-primary"][class*="flex-col"][class*="min-w-0"]',
    isUser: (el) => hasClass(el, "self-end"),
    assistantBody: '.prose, .markdown, [class*="prose"]',
    strip: '.thought-content, [class*="thought"]',
    title: (doc) => titleWithout(doc, /(?:LM)?Arena(?:\.ai)?/),
    stabilize: true
  });
  var t3Adapter = roleAdapter({
    turns: '[data-message-role], [data-role="user"], [data-role="assistant"], [aria-label="Your message"], [aria-label="Assistant message"]',
    isUser: (el) => /^user$/i.test(el.getAttribute("data-message-role") ?? el.getAttribute("data-role") ?? "") || el.getAttribute("aria-label") === "Your message",
    title: (doc) => titleWithout(doc, /T3\s*Chat/, /^New Thread$/i),
    stabilize: true
  });
  var notebookAdapter = roleAdapter({
    turns: ".from-user-container, .to-user-container",
    isUser: (el) => hasClass(el, "from-user-container"),
    strip: "button.citation-marker, mat-icon",
    title(doc) {
      return firstText(doc, [".notebook-title", "input.title-input", '[data-test-id="notebook-title"]']) ?? titleWithout(doc, /NotebookLM|Gemini Notebook|Google NotebookLM/, /^Untitled notebook$/i);
    },
    stabilize: true
  });
  var githubCopilotAdapter = roleAdapter({
    turns: '[class*="UserMessage-module__container"], [class*="CopilotMessage-module__container"], [class*="AssistantMessage-module__container"], [data-testid="user-message"], [data-testid="copilot-message"]',
    isUser: (el) => /UserMessage-module/.test(typeof el.className === "string" ? el.className : "") || el.getAttribute("data-testid") === "user-message",
    assistantBody: ".markdown-body",
    title: (doc) => titleWithout(doc, /GitHub Copilot|Copilot|GitHub/),
    stabilize: true,
    project(_doc, url) {
      const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/\d+\/agent-sessions\//);
      return m ? m[2] : null;
    }
  });
  var cursorAgentsAdapter = {
    ...titleOnlyAdapter(/Cursor(?:\s*Agents?)?/),
    project(doc, url) {
      const repository = extractRepositoryInfo(doc, url).repository;
      return repository ? repositoryName(repository) : null;
    }
  };
  var lovableAdapter = roleAdapter({
    turns: "[data-message-id]",
    isUser: (el) => (el.getAttribute("data-message-id") ?? "").startsWith("umsg_"),
    userBody: '[class*="PromptBox_customProse"], .prose',
    assistantBody: ".prose",
    assistantBodies: true,
    idOf: (el) => el.getAttribute("data-message-id"),
    title(doc) {
      return firstText(doc, ["nav button span.truncate", "header button span.truncate"]) ?? titleWithout(doc, /Lovable/);
    },
    stabilize: true
  });
  var boltAdapter = roleAdapter({
    turns: 'section[aria-label="Chat"] div[data-message-id], div[data-message-id]',
    isUser: (el) => hasClass(el, "self-end"),
    userBody: 'div[class*="_MarkdownContent_"]',
    assistantBody: 'div[class*="_MarkdownContent_"]',
    assistantBodies: true,
    idOf: (el) => el.getAttribute("data-message-id"),
    title: (doc) => titleWithout(doc, /Bolt(?:\.new)?|bolt\.new/),
    stabilize: true
  });
  function titleOnlyAdapter(product, placeholder) {
    return { turns: () => [], title: (doc) => titleWithout(doc, product, placeholder), stabilize: true };
  }
  var libreChatAdapter = roleAdapter({
    turns: ".message-render",
    isUser: (el) => Boolean(el.querySelector(":scope > .user-turn")) || hasClass(el, "user-turn"),
    userBody: ".message-content",
    assistantBody: ".message-content",
    isStreaming: (el) => Boolean(el.querySelector(".message-content.submitting")),
    docStreaming: '[data-testid="stop-generation-button"]',
    title: (doc) => titleWithout(doc, /LibreChat/, /^New Chat$/i)
  });
  var lobeChatAdapter = roleAdapter({
    turns: ".message-wrapper[data-message-id], #chatlist-list [data-index]",
    isUser(el) {
      const style = el.getAttribute("style") ?? "";
      if (/--lobe-flex-align:\s*flex-end/.test(style)) return true;
      if (/--lobe-flex-align:\s*flex-start/.test(style)) return false;
      return el.hasAttribute("data-index") && !el.querySelector('[data-layout="vertical"]');
    },
    userBody: 'article[data-code-type="markdown"]',
    assistantBody: 'article[data-code-type="markdown"]',
    idOf: (el) => el.getAttribute("data-message-id"),
    title: (doc) => titleWithout(doc, /LobeChat|LobeHub/),
    stabilize: true
  });
  var anythingLlmAdapter = roleAdapter({
    turns: "#chat-history .flex.justify-end.w-full.group, #chat-history .flex.justify-start.w-full.group",
    isUser: (el) => hasClass(el, "justify-end"),
    title: (doc) => titleWithout(doc, /AnythingLLM(?:\s*\|\s*Your personal LLM trained on anything)?/),
    stabilize: true
  });
  function detectSelfHostedApp(doc) {
    if (doc.querySelector("#messages-container") && doc.querySelector("#chat-input, #response-content-container, .user-message .chat-user")) {
      return "open_webui";
    }
    if (doc.querySelector(".message-render") && doc.querySelector('[data-testid="text-input"], main[role="main"]')) return "librechat";
    if (doc.querySelector(".message-wrapper[data-message-id], #chatlist-list")) return "lobechat";
    if (doc.querySelector("#chat-history") && (/AnythingLLM/i.test(doc.title) || doc.querySelector(".justify-end.w-full.group, .justify-start.w-full.group"))) {
      return "anythingllm";
    }
    return null;
  }
  var SITE_ID_PATHS = [
    /\/workspace\/([\w.-]+)\/t\/([\w.-]+)/,
    // AnythingLLM thread
    /\/(?:c|chat|chats|conversation|conversations|thread|threads|t|session|sessions)\/([\w.-]{4,})(?:\/|$)/
  ];
  var SITE_ID_PARAMS = ["conversationId", "conversation", "chatId", "chatID", "chat", "threadId", "thread", "topic", "sessionId", "session", "id", "c"];
  var SITE_NOT_AN_ID = /^(new|settings|login|signin|admin|home|share|search|workspace|models|api)$/i;
  function siteConversationIdFromUrl(href) {
    let url;
    try {
      url = new URL(href);
    } catch {
      return null;
    }
    const clean = (v) => {
      const t = (v ?? "").replace(/[^\w.-]/g, "_").slice(0, 100);
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
    const hash = url.hash.replace(/^#/, "");
    const fromHash = clean(hash.match(SITE_ID_PATHS[1])?.[1]);
    if (fromHash) return fromHash;
    const anythingWorkspace = url.pathname.match(/^\/workspace\/([\w.-]+)\/?$/);
    return anythingWorkspace ? clean(`${anythingWorkspace[1]}_default`) : null;
  }
  var SITE_ADAPTERS = {
    open_webui: openWebUiSiteAdapter,
    librechat: libreChatAdapter,
    lobechat: lobeChatAdapter,
    anythingllm: anythingLlmAdapter,
    custom_web: { turns: () => [], title: () => null, stabilize: true }
  };
  function genericSiteTitle(doc) {
    const t = doc.title.replace(/\s*[-|–—•·]\s*[^-|–—•·]{1,40}$/, "").trim();
    return t && t.length > 1 && !/^(new chat|chat|home|untitled)$/i.test(t) ? t : null;
  }
  var noDom = { turns: () => [], title: () => null, noFallback: true };
  var ADAPTERS = {
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
    paperclip: noDom
  };
  function CSS_ESCAPE(value) {
    return value.replace(/["\\]/g, "\\$&");
  }
  function unixToIsoOrNull(ts) {
    if (!ts) return null;
    const parsed = Date.parse(ts);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
  }
  function resolvePageProvider(doc, locationHref, options) {
    if (options.site) {
      const app = detectSelfHostedApp(doc);
      return { provider: app ?? "custom_web", adapter: SITE_ADAPTERS[app ?? "custom_web"], site: options.site };
    }
    const providerAttr = doc.documentElement.getAttribute("data-tk-provider");
    const provider = isProviderId(providerAttr) ? providerAttr : detectProviderFromUrl(locationHref);
    if (!provider || PROVIDERS[provider].hostAccess === "none" || provider === "grok_x") return null;
    if (PROVIDERS[provider].hostAccess === "custom") return null;
    if (PROVIDERS[provider].captureMode === "explicit" && !options.explicit) return null;
    return { provider, adapter: ADAPTERS[provider], site: null };
  }
  function extractVisibleDomConversation(doc, locationHref, options = {}) {
    const page = resolvePageProvider(doc, locationHref, options);
    if (!page) return null;
    const { provider, adapter, site } = page;
    let urlConversationId;
    if (site) {
      urlConversationId = siteConversationIdFromUrl(locationHref);
    } else {
      const convIdAttr = doc.documentElement.getAttribute("data-tk-conversation-id") || doc.querySelector("[data-conversation-id]")?.getAttribute("data-conversation-id");
      urlConversationId = convIdAttr || extractConversationIdFromUrl(locationHref) || adapter.conversationId?.(doc, locationHref) || null;
      if (!urlConversationId) return null;
    }
    const branchAttr = site ? "main" : doc.querySelector("[data-branch-id]")?.getAttribute("data-branch-id") || doc.documentElement.getAttribute("data-tk-branch-id") || "main";
    const branchId = branchAttr.trim() || "main";
    let method = "adapter";
    let turns = adapter.turns(doc);
    const fallback = !adapter.noFallback && provider !== "claude" && provider !== "chatgpt";
    if (turns.length === 0 && fallback) {
      turns = genericTurns(doc);
      method = "generic";
    }
    if (turns.length === 0 && fallback) {
      turns = heuristicTurns(doc);
      method = "heuristic";
    }
    if (turns.length === 0) method = "none";
    let unfinishedIndex = -1;
    if (adapter.docStreaming && doc.querySelector(adapter.docStreaming)) {
      for (let i = turns.length - 1; i >= 0; i--) {
        if (turns[i].role !== "user") {
          unfinishedIndex = i;
          break;
        }
      }
    }
    const drafts = [];
    let modelSlug = null;
    for (let i = 0; i < turns.length; i++) {
      const turn = turns[i];
      const el = turn.el;
      if (i === unfinishedIndex) continue;
      if (el.closest(
        'form, [data-testid="composer"], [contenteditable="true"], [contenteditable="plaintext-only"]'
      )) {
        continue;
      }
      if (el.getAttribute("data-streaming") === "true" || el.classList.contains("result-streaming") || el.querySelector('[data-streaming="true"], .result-streaming') || el.getAttribute("aria-busy") === "true" || adapter.isStreaming?.(el)) {
        continue;
      }
      const skip = turn.role === "user" ? void 0 : adapter.strip;
      const text2 = turn.bodies ? turn.bodies.map((b) => extractReadableText(b, skip)).filter(Boolean).join("\n\n") : extractReadableText(turn.body ?? el, skip);
      if (!text2) continue;
      if (turn.model) modelSlug = turn.model;
      const timeEl = el.querySelector("time[datetime]");
      const explicitTs = el.getAttribute("data-message-timestamp") || timeEl?.getAttribute("datetime") || null;
      drafts.push({ turn, index: i, text: text2, createdAt: unixToIsoOrNull(explicitTs) });
    }
    let conversationId = urlConversationId;
    if (site && !conversationId) {
      const opening = drafts.find((d) => d.turn.role === "user")?.text;
      if (!opening) return null;
      conversationId = `m_${fnv1a32Hex(opening.replace(/\s+/g, " ").trim())}`;
    }
    if (!conversationId) return null;
    const sourceConversationId = site ? `${siteConversationKey(site.origin)}~${conversationId}` : conversationId;
    const messages = [];
    const usedIds = /* @__PURE__ */ new Set();
    for (const draft of drafts) {
      const baseId = stableMessageKey(draft.turn) ?? (adapter.hashIds ? `h_${fnv1a32Hex(`${draft.turn.role}
${draft.text}`)}` : `${sourceConversationId}_${branchId}_m_${draft.index}`);
      let sourceMessageId = baseId;
      for (let n = 2; usedIds.has(sourceMessageId); n++) sourceMessageId = `${baseId}#${n}`;
      usedIds.add(sourceMessageId);
      messages.push({
        sourceMessageId,
        role: draft.turn.role,
        content: draft.text,
        createdAt: draft.createdAt,
        branchPath: branchId
      });
    }
    const adapterTitle = adapter.title(doc, locationHref, conversationId) ?? (site ? genericSiteTitle(doc) : null);
    const firstUser = messages.find((m) => m.role === "user")?.content ?? "";
    const derivedTitle = firstUser ? firstUser.replace(/\s+/g, " ").slice(0, 80).trim() : "";
    const title = (adapterTitle || derivedTitle || "Untitled conversation").trim();
    return {
      provider,
      sourceConversationId,
      branchId,
      canonicalUrl: canonicalizeConversationUrl(locationHref, site ? provider : void 0),
      title,
      coverage: messages.length > 0 ? "partial" : "title_only",
      messages,
      providerProjectName: adapter.project?.(doc, locationHref) ?? null,
      modelSlug,
      method,
      stabilize: Boolean(site) || method !== "adapter" || Boolean(adapter.stabilize)
    };
  }
  var GITHUB_RESERVED_OWNERS = /* @__PURE__ */ new Set([
    "about",
    "apps",
    "codespaces",
    "collections",
    "copilot",
    "enterprise",
    "events",
    "explore",
    "features",
    "issues",
    "login",
    "marketplace",
    "new",
    "notifications",
    "orgs",
    "pricing",
    "pulls",
    "search",
    "security",
    "settings",
    "signup",
    "sponsors",
    "topics",
    "trending",
    "users"
  ]);
  var REPOSITORY_LINK_EXCLUDED = 'nav, aside, [data-message-author-role], [data-testid*="message"], .markdown-body, .prose, .markdown';
  function repositoryFromHref(href, base) {
    let resolved;
    try {
      resolved = new URL(href, base);
    } catch {
      return null;
    }
    const repository = normalizeRepository(resolved.href);
    if (!repository || !repository.includes("/")) return null;
    if (/^(?:www\.)?github\.com$/i.test(resolved.hostname) && GITHUB_RESERVED_OWNERS.has(repository.split("/")[0])) return null;
    return repository;
  }
  function branchFromElement(el) {
    const label = (el.getAttribute("aria-label") ?? el.getAttribute("title") ?? "").trim();
    const labelled = label.match(/^(?:git\s+)?branch\s*[:\-]\s*(.+)$/i);
    let value = labelled ? labelled[1] : null;
    if (!value && (/^(?:git\s+)?branch$/i.test(label) || /branch/i.test(el.getAttribute("data-testid") ?? ""))) {
      value = (el.textContent ?? "").replace(/\s+/g, " ").trim();
    }
    if (!value) {
      const text2 = (el.textContent ?? "").replace(/\s+/g, " ").trim();
      if (el.children.length === 0 && text2.length < 120) value = text2.match(/^branch\s*:\s*(\S+)$/i)?.[1] ?? null;
    }
    return value && /^[\w./@+#-]{1,200}$/.test(value) ? value : null;
  }
  function extractRepositoryInfo(doc, url) {
    const none = { repository: null, pullRequestUrl: null, gitBranch: null };
    const provider = detectProviderFromUrl(url);
    if (!provider || providerCategory(provider) !== "coding_agent") return none;
    let repository = null;
    let pullRequestUrl = null;
    if (provider === "github_copilot") {
      const m = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)\/agent-sessions\//);
      if (m) {
        repository = normalizeRepository(`${m[1]}/${m[2]}`);
        pullRequestUrl = normalizePullRequestUrl(`https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`);
      }
    }
    const roots = Array.from(doc.querySelectorAll('header, main, [role="main"]'));
    if (roots.length === 0 && doc.body) roots.push(doc.body);
    const links = roots.flatMap((root) => Array.from(root.querySelectorAll("a[href]"))).filter((a) => !a.closest(REPOSITORY_LINK_EXCLUDED));
    for (const a of links) {
      const href = a.getAttribute("href") ?? "";
      if (!repository) repository = repositoryFromHref(href, url);
      if (!pullRequestUrl) {
        try {
          pullRequestUrl = normalizePullRequestUrl(new URL(href, url).href);
        } catch {
        }
      }
      if (repository && pullRequestUrl) break;
    }
    let gitBranch = null;
    for (const root of roots) {
      for (const el of Array.from(root.querySelectorAll("*"))) {
        if (el.closest('[data-message-author-role], [data-testid*="message"], .markdown-body, .prose, .markdown')) continue;
        gitBranch = branchFromElement(el);
        if (gitBranch) break;
      }
      if (gitBranch) break;
    }
    return { repository, pullRequestUrl, gitBranch };
  }
  function extractProviderProjectName(doc, locationHref) {
    const providerAttr = doc.documentElement.getAttribute("data-tk-provider");
    const provider = isProviderId(providerAttr) ? providerAttr : detectProviderFromUrl(locationHref);
    if (!provider || PROVIDERS[provider].hostAccess === "custom") return null;
    return ADAPTERS[provider].project?.(doc, locationHref) ?? null;
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
      modelSlug: null,
      method: "adapter",
      stabilize: false
    };
  }
  function canonicalizeConversationUrl(href, provider) {
    const owner = provider ?? detectProviderFromUrl(href);
    if (owner === "grok_x") {
      const conv = extractConversationIdFromUrl(href);
      return conv ? grokXCanonicalUrl(conv) : "https://x.com/i/grok";
    }
    try {
      const u = new URL(href);
      const keep = new URLSearchParams();
      const custom2 = owner !== null && PROVIDERS[owner].hostAccess === "custom";
      for (const key of custom2 ? ["conversation", ...SITE_ID_PARAMS] : conversationQueryParams(owner)) {
        const value = u.searchParams.get(key);
        if (value) keep.set(key, value);
      }
      const qs = keep.toString();
      const hashRoute = custom2 && /^#\/[\w./-]+$/.test(u.hash) ? u.hash : "";
      return `${u.origin}${u.pathname}${qs ? `?${qs}` : ""}${hashRoute}`;
    } catch {
      return href;
    }
  }

  // src/core/site-api.ts
  function rec(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  function str(value) {
    return typeof value === "string" && value.length > 0 ? value : null;
  }
  function toIso(value) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return new Date(value < 1e12 ? value * 1e3 : value).toISOString();
    }
    if (typeof value === "string" && value.trim()) {
      const ms = Date.parse(value);
      return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
    }
    return null;
  }
  var SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;
  function chatGptCanonicalUrl(conversationId) {
    return `https://chatgpt.com/c/${conversationId}`;
  }
  function claudeCanonicalUrl(conversationId) {
    return `https://claude.ai/chat/${conversationId}`;
  }
  function cleanChatGptText(text2) {
    return text2.replace(/entity(\[[^]*\])/g, (_m, json) => {
      try {
        const parsed = JSON.parse(json);
        return Array.isArray(parsed) && typeof parsed[1] === "string" ? parsed[1] : "";
      } catch {
        return "";
      }
    }).replace(/[^]*/g, "").replace(/[-]/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }
  var CHATGPT_TEXT_TYPES = /* @__PURE__ */ new Set(["text", "multimodal_text", "code"]);
  function chatGptNodeText(message) {
    const content = rec(message.content);
    if (!content) return "";
    const type = str(content.content_type) ?? "text";
    if (!CHATGPT_TEXT_TYPES.has(type)) return "";
    if (type === "code") {
      return typeof content.text === "string" ? content.text : "";
    }
    const parts = content.parts;
    if (Array.isArray(parts)) {
      return parts.map((p) => typeof p === "string" ? p : str(rec(p)?.text) ?? "").filter(Boolean).join("\n\n");
    }
    return typeof content.text === "string" ? content.text : "";
  }
  function chatGptActivePath(mapping, currentNode) {
    let cursor = currentNode && rec(mapping[currentNode]) ? currentNode : null;
    if (!cursor) {
      let best = -1;
      for (const [id, raw] of Object.entries(mapping)) {
        const node = rec(raw);
        if (!node) continue;
        const children = node.children;
        if (Array.isArray(children) && children.length > 0) continue;
        const t = typeof rec(node.message)?.create_time === "number" ? rec(node.message)?.create_time : 0;
        if (t >= best) {
          best = t;
          cursor = id;
        }
      }
    }
    const path = [];
    const seen = /* @__PURE__ */ new Set();
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      const node = rec(mapping[cursor]);
      if (!node) break;
      path.push(node);
      cursor = str(node.parent);
    }
    return path.reverse();
  }
  function parseChatGptConversation(json, hintedId) {
    const root = rec(json);
    const mapping = rec(root?.mapping);
    if (!root || !mapping) return null;
    const rawId = str(root.conversation_id) ?? str(root.id) ?? hintedId ?? null;
    if (!rawId || !SAFE_ID.test(rawId)) return null;
    const sourceConversationId = rawId.toLowerCase();
    const messages = [];
    let modelSlug = null;
    const used = /* @__PURE__ */ new Set();
    for (const node of chatGptActivePath(mapping, str(root.current_node))) {
      const message = rec(node.message);
      if (!message) continue;
      const role = str(rec(message.author)?.role);
      if (role !== "user" && role !== "assistant") continue;
      const metadata = rec(message.metadata);
      if (metadata?.is_visually_hidden_from_conversation === true) continue;
      if (role === "assistant") {
        const recipient = str(message.recipient);
        if (recipient && recipient !== "all") continue;
        if (str(message.channel) === "analysis") continue;
      }
      const text2 = cleanChatGptText(chatGptNodeText(message));
      if (!text2) continue;
      let id = str(message.id) ?? str(node.id) ?? `${sourceConversationId}_main_m_${messages.length}`;
      for (let n = 2; used.has(id); n++) id = `${id}#${n}`;
      used.add(id);
      if (role === "assistant") modelSlug = str(metadata?.model_slug) ?? modelSlug;
      messages.push({
        sourceMessageId: id,
        role,
        content: text2,
        createdAt: toIso(message.create_time),
        branchPath: "main"
      });
    }
    return {
      provider: "chatgpt",
      sourceConversationId,
      canonicalUrl: chatGptCanonicalUrl(sourceConversationId),
      title: (str(root.title) ?? "").trim(),
      createdAt: toIso(root.create_time),
      updatedAt: toIso(root.update_time),
      messages,
      modelSlug: modelSlug ?? str(root.default_model_slug),
      providerProjectId: str(root.gizmo_id)
    };
  }
  var CLAUDE_ROOT_PARENT = "00000000-0000-4000-8000-000000000000";
  function claudeMessageText(message) {
    const content = message.content;
    if (Array.isArray(content)) {
      const text2 = content.map((c) => {
        const item = rec(c);
        return item && item.type === "text" ? str(item.text) ?? "" : "";
      }).filter(Boolean).join("\n\n").trim();
      if (text2) return text2;
    }
    return typeof message.text === "string" ? message.text.trim() : "";
  }
  function claudeActiveMessages(all, leaf) {
    const byId = /* @__PURE__ */ new Map();
    for (const m of all) {
      const id = str(m.uuid);
      if (id) byId.set(id, m);
    }
    const linked = all.some((m) => str(m.parent_message_uuid));
    if (leaf && linked && byId.has(leaf)) {
      const chain = [];
      const seen = /* @__PURE__ */ new Set();
      let cursor = leaf;
      while (cursor && cursor !== CLAUDE_ROOT_PARENT && !seen.has(cursor)) {
        seen.add(cursor);
        const m = byId.get(cursor);
        if (!m) break;
        chain.push(m);
        cursor = str(m.parent_message_uuid);
      }
      return chain.reverse();
    }
    return [...all].sort((a, b) => {
      const ai = typeof a.index === "number" ? a.index : Number.MAX_SAFE_INTEGER;
      const bi = typeof b.index === "number" ? b.index : Number.MAX_SAFE_INTEGER;
      return ai - bi;
    });
  }
  function parseClaudeConversation(json, hintedId) {
    const root = rec(json);
    const list = root?.chat_messages;
    if (!root || !Array.isArray(list)) return null;
    const rawId = str(root.uuid) ?? hintedId ?? null;
    if (!rawId || !SAFE_ID.test(rawId)) return null;
    const sourceConversationId = rawId.toLowerCase();
    const messages = [];
    const used = /* @__PURE__ */ new Set();
    for (const m of claudeActiveMessages(list.map(rec).filter((x) => x !== null), str(root.current_leaf_message_uuid))) {
      const sender = str(m.sender);
      if (sender !== "human" && sender !== "assistant") continue;
      const text2 = claudeMessageText(m);
      if (!text2) continue;
      let id = str(m.uuid) ?? `${sourceConversationId}_main_m_${messages.length}`;
      for (let n = 2; used.has(id); n++) id = `${id}#${n}`;
      used.add(id);
      messages.push({
        sourceMessageId: id,
        role: sender === "human" ? "user" : "assistant",
        content: text2,
        createdAt: toIso(m.created_at),
        branchPath: "main"
      });
    }
    return {
      provider: "claude",
      sourceConversationId,
      canonicalUrl: claudeCanonicalUrl(sourceConversationId),
      title: (str(root.name) ?? "").trim(),
      createdAt: toIso(root.created_at),
      updatedAt: toIso(root.updated_at),
      messages,
      modelSlug: str(root.model),
      providerProjectId: str(root.project_uuid)
    };
  }
  function parseSiteConversation(provider, json, hintedId) {
    return provider === "chatgpt" ? parseChatGptConversation(json, hintedId) : parseClaudeConversation(json, hintedId);
  }
  function siteConversationTitle(conv) {
    if (conv.title) return conv.title;
    const first = conv.messages.find((m) => m.role === "user")?.content ?? "";
    const derived = first.replace(/\s+/g, " ").slice(0, 80).trim();
    return derived || "Untitled conversation";
  }
  var SITE_DATA_MESSAGE_SOURCE = "threadkeeper-site-data";
  function parseSiteDataMessage(data) {
    const m = rec(data);
    if (!m || m.source !== SITE_DATA_MESSAGE_SOURCE) return null;
    const provider = m.provider;
    const id = m.conversationId;
    if (provider !== "chatgpt" && provider !== "claude" || typeof id !== "string" || !SAFE_ID.test(id)) return null;
    if (rec(m.json) === null) return null;
    return { source: SITE_DATA_MESSAGE_SOURCE, provider, conversationId: id.toLowerCase(), json: m.json };
  }
  var IDENTITY_MESSAGE_SOURCE = "threadkeeper-identity";
  var IDENTITY_REPLAY_SOURCE = "threadkeeper-identity-replay";
  var MAX_IDENTITY_BODY_CHARS = 64 * 1024;
  var IDENTITY_SOURCES = {
    chatgpt_session: true,
    claude_account: true,
    cursor_me: true
  };
  function isIdentitySource(value) {
    return typeof value === "string" && Object.prototype.hasOwnProperty.call(IDENTITY_SOURCES, value);
  }
  function parseIdentityMessage(data) {
    const m = rec(data);
    if (!m || m.source !== IDENTITY_MESSAGE_SOURCE) return null;
    if (!isIdentitySource(m.kind)) return null;
    if (typeof m.body !== "string" || m.body.length === 0 || m.body.length > MAX_IDENTITY_BODY_CHARS) return null;
    return { source: IDENTITY_MESSAGE_SOURCE, kind: m.kind, body: m.body };
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
      const { id, role, text: text2, createdAt } = raw;
      if (typeof id !== "string" || !MESSAGE_ID_RE.test(id) || ids.has(id)) return null;
      if (role !== "user" && role !== "assistant") return null;
      if (typeof text2 !== "string" || text2.trim() === "" || text2.length > MAX_TEXT_LENGTH) return null;
      if (createdAt !== null && (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt)))) {
        return null;
      }
      ids.add(id);
      messages.push({ id, role, text: text2, createdAt });
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

  // src/core/workspace/types.ts
  var EMBED_FRAME_NAME_PREFIX = "tk-pane~";

  // src/core/messaging.ts
  var DOCK_COMMAND_TYPES = /* @__PURE__ */ new Set([
    "DOCK_SYNC_NOW",
    "DOCK_GET_STATE",
    "DOCK_PENDING",
    "DOCK_DECIDE",
    "DOCK_UNPAIR",
    "DOCK_SEND",
    "DOCK_COLLECTIONS",
    "DOCK_STATUS_FOR",
    "DOCK_SET_OPTIONS",
    "DOCK_UNBLOCK",
    "DOCK_RESYNC",
    "DOCK_OPEN_CONSENT"
  ]);
  var PRIVILEGED_TYPES = /* @__PURE__ */ new Set([
    "REDEEM_OVERLAY_HANDSHAKE",
    "OPEN_FULL_PAGE_MANAGER",
    "OPEN_ORIGINAL_THREAD",
    "CLOSE_THREADKEEPER_OVERLAY",
    "DELETE_THREAD",
    "EXPORT_BUNDLE",
    "UPDATE_SETTINGS",
    "RUN_RESUMABLE_JOBS",
    "SETTINGS_CHANGED",
    "RUN_ANALYSIS_NOW",
    "GET_DIAGNOSTICS",
    "START_HISTORY_SYNC",
    "CANCEL_HISTORY_SYNC",
    "GET_HISTORY_SYNC_STATE",
    "CAPTURE_TAB_NOW",
    "CAPTURE_SITES_CHANGED",
    "PAPERCLIP_SYNC_NOW",
    ...DOCK_COMMAND_TYPES
  ]);
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

  // src/core/history-sync.ts
  var patterns = (id) => PROVIDERS[id].matchPatterns;
  var SYNC_PROVIDERS = [
    {
      id: "chatgpt",
      label: "ChatGPT",
      strategy: "api",
      homeUrl: "https://chatgpt.com/",
      hostPatterns: patterns("chatgpt"),
      note: "Complete history with dates, read through your signed-in session.",
      allHistory: true,
      identityHost: "chatgpt"
    },
    {
      id: "claude",
      label: "Claude",
      strategy: "api",
      homeUrl: "https://claude.ai/new",
      hostPatterns: patterns("claude"),
      note: "Complete history with dates, read through your signed-in session.",
      allHistory: true,
      identityHost: "claude"
    },
    {
      id: "claude_code",
      label: "Claude Code",
      strategy: "sidebar",
      homeUrl: "https://claude.ai/code",
      hostPatterns: patterns("claude_code"),
      note: "Opens each Claude Code session from your session list in a background tab, with its repository and pull request when the page shows them.",
      allHistory: true,
      ownListTab: true,
      identityHost: "claude"
    },
    {
      id: "codex",
      label: "Codex",
      strategy: "sidebar",
      homeUrl: "https://chatgpt.com/codex",
      hostPatterns: patterns("codex"),
      note: "Opens each Codex task from your task list in a background tab, with its repository and pull request when the page shows them.",
      allHistory: true,
      ownListTab: true,
      identityHost: "chatgpt"
    },
    {
      id: "gemini",
      label: "Gemini",
      strategy: "sidebar",
      homeUrl: "https://gemini.google.com/app",
      hostPatterns: patterns("gemini"),
      note: "Opens your most recent chats one by one. No dates, so it takes the newest ones.",
      allHistory: false
    },
    {
      id: "grok",
      label: "Grok",
      strategy: "sidebar",
      homeUrl: "https://grok.com/",
      hostPatterns: patterns("grok"),
      note: "Opens your most recent chats one by one. No dates, so it takes the newest ones.",
      allHistory: false
    },
    {
      id: "perplexity",
      label: "Perplexity",
      strategy: "sidebar",
      homeUrl: "https://www.perplexity.ai/library",
      hostPatterns: patterns("perplexity"),
      note: "Opens your most recent threads one by one. No dates, so it takes the newest ones.",
      allHistory: false
    },
    {
      id: "deepseek",
      label: "DeepSeek",
      strategy: "sidebar",
      homeUrl: "https://chat.deepseek.com/",
      hostPatterns: patterns("deepseek"),
      note: "Opens your most recent chats one by one. No dates, so it takes the newest ones.",
      allHistory: false
    },
    {
      id: "kimi",
      label: "Kimi",
      strategy: "sidebar",
      homeUrl: "https://www.kimi.com/",
      hostPatterns: patterns("kimi"),
      note: "Opens your most recent chats one by one. No dates, so it takes the newest ones.",
      allHistory: false
    },
    {
      id: "mistral",
      label: "Le Chat",
      strategy: "sidebar",
      homeUrl: "https://chat.mistral.ai/chat",
      hostPatterns: patterns("mistral"),
      note: "Opens your most recent chats one by one. No dates, so it takes the newest ones.",
      allHistory: false
    },
    {
      id: "copilot",
      label: "Copilot",
      strategy: "sidebar",
      homeUrl: "https://copilot.microsoft.com/",
      hostPatterns: patterns("copilot"),
      note: "Opens your most recent chats one by one. No dates, so it takes the newest ones.",
      allHistory: false
    },
    {
      id: "ai_studio",
      label: "Google AI Studio",
      strategy: "sidebar",
      homeUrl: "https://aistudio.google.com/library",
      hostPatterns: patterns("ai_studio"),
      note: "Opens your most recent saved chats one by one. No dates, so it takes the newest ones.",
      allHistory: false
    }
  ];
  function isSyncProviderId(value) {
    return typeof value === "string" && SYNC_PROVIDERS.some((p) => p.id === value);
  }
  function describeSyncError(code, label) {
    switch (code) {
      case "no_access":
        return `Threadkeeper is not allowed to read ${label}. Turn ${label} on under Settings, Capture, allow access when asked, and try again.`;
      case "page_timeout":
        return `${label} did not finish loading in time. Check that ${label} opens in a normal tab, then try again.`;
      case "no_reader":
        return `Threadkeeper could not start reading the ${label} page. Reload any open ${label} tab and try again.`;
      case "tab_closed":
        return `The ${label} tab was closed during the import. What was imported so far is kept.`;
      case "account_changed":
        return `The ${label} account signed in changed during the import, so it stopped to keep each account's threads apart. Run the import again for the account now signed in.`;
      case "capture_failed":
        return `${label} did not show the conversations Threadkeeper opened. Check that you are signed in and that a conversation opens in a normal tab. What was imported so far is kept.`;
      case "step_timeout":
        return `${label} stopped responding, so Threadkeeper moved on. What was imported so far is kept.`;
      case "account_unverified":
        return `Threadkeeper could not confirm which ${label} account is signed in, so nothing more was imported from ${label}. Open ${label} in a tab, check you are signed in to the account you want, and try again.`;
      case "interrupted":
        return `The browser stopped the extension during the import. What was imported is kept; continue the import to finish ${label}.`;
      case "needs_login":
        return `Sign in to ${label} in this browser, then run Catch up again.`;
      case "blocked":
        return `${label} blocked the request, often a check that needs a person. Open ${label} in a tab, complete any check, and try again.`;
      case "rate_limited":
        return `${label} asked us to slow down. Wait a few minutes and run Catch up again; what was already imported is kept.`;
      case "unsupported":
        return `${label} did not answer in the format Threadkeeper reads. The site may have changed; use its data export instead.`;
      case "network":
        return `Could not reach ${label}. Check your connection and try again.`;
      case "no_conversations":
        return `No conversations found in ${label}'s sidebar. Sign in, open the site once, and try again.`;
      case "timeout":
        return `${label} stopped answering. What was imported so far is kept.`;
    }
  }

  // src/core/hash.ts
  function computeDeterministicHash(input) {
    let h1 = 3735928559 ^ input.length;
    let h2 = 1103547991 ^ input.length;
    for (let i = 0, ch; i < input.length; i++) {
      ch = input.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ h1 >>> 16, 2246822507) ^ Math.imul(h2 ^ h2 >>> 13, 3266489909);
    h2 = Math.imul(h2 ^ h2 >>> 16, 2246822507) ^ Math.imul(h1 ^ h1 >>> 13, 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, "0") + (h1 >>> 0).toString(16).padStart(8, "0");
  }

  // src/core/accounts/identity.ts
  var IDENTITY_BODY_LIMIT_BYTES = 64 * 1024;
  var MAX_TEXT = 200;
  function providerForIdentitySource(source) {
    return source === "chatgpt_session" ? "chatgpt" : source === "claude_account" ? "claude" : "cursor_agents";
  }
  var SOURCE_FAMILY = {
    chatgpt_session: "chatgpt",
    claude_account: "claude",
    cursor_me: "cursor"
  };
  function isRecord2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
  }
  function stableId(value) {
    if (typeof value === "string") {
      const id = value.trim();
      return id.length > 0 && id.length <= MAX_TEXT ? id : null;
    }
    if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
    return null;
  }
  function text(value) {
    if (typeof value !== "string") return null;
    const t = value.trim();
    return t.length > 0 ? t.slice(0, MAX_TEXT) : null;
  }
  function email(value) {
    const t = text(value);
    return t && /^[^\s@]+@[^\s@]+$/.test(t) ? t : null;
  }
  function identity(source, id, display, detail) {
    return {
      key: `${SOURCE_FAMILY[source]}:${computeDeterministicHash(id)}`,
      display,
      detail,
      source: "network"
    };
  }
  function parseChatgpt(json) {
    if (!isRecord2(json) || !isRecord2(json.user)) return null;
    const id = stableId(json.user.id);
    if (!id) return null;
    const display = email(json.user.email) ?? text(json.user.name);
    const plan = isRecord2(json.account) ? text(json.account.planType) : null;
    return identity("chatgpt_session", id, display, plan);
  }
  function parseClaude(json) {
    if (!isRecord2(json)) return null;
    const account = isRecord2(json.account) ? json.account : json;
    const id = stableId(account.uuid) ?? stableId(account.id);
    if (!id) return null;
    const address = email(account.email_address) ?? email(account.email);
    if (!address) return null;
    return identity("claude_account", id, address, null);
  }
  function parseCursor(json) {
    if (!isRecord2(json)) return null;
    const id = stableId(json.sub) ?? stableId(json.id);
    if (!id) return null;
    const address = email(json.email);
    if (!address) return null;
    return identity("cursor_me", id, address, null);
  }
  function parseIdentity(source, json) {
    try {
      if (source === "chatgpt_session") return parseChatgpt(json);
      if (source === "claude_account") return parseClaude(json);
      if (source === "cursor_me") return parseCursor(json);
      return null;
    } catch {
      return null;
    }
  }

  // src/core/site-history.ts
  var REQUEST_TIMEOUT_MS = 3e4;
  var SyncFailure = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
    }
  };
  var FORMAT_CHANGED = new SyncFailure("unsupported", "conversations hold no messages");
  var PAUSE_MIN_MS = 500;
  var PAUSE_SPREAD_MS = 500;
  var MAX_ATTEMPTS = 3;
  var MAX_CONSECUTIVE_FAILURES = 3;
  var CHATGPT_PAGE = 28;
  var LIST_LIMIT = 2e4;
  var EMPTY_PROBE = 5;
  var CLAUDE_PAGE = 50;
  function cookie(cookies, name) {
    for (const part of cookies.split(";")) {
      const [k, ...v] = part.trim().split("=");
      if (k === name) return decodeURIComponent(v.join("="));
    }
    return null;
  }
  function rec2(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
  }
  async function timedGet(p, url, headers) {
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const ms = p.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    let timedOut = false;
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller?.abort();
        reject(new SyncFailure("network", "timed out"));
      }, ms);
    });
    deadline.catch(() => void 0);
    const done = () => clearTimeout(timer);
    try {
      const res = await Promise.race([
        p.fetchImpl(url, { method: "GET", credentials: "include", headers: { Accept: "application/json", ...headers }, signal: controller?.signal }),
        deadline
      ]);
      const read = async () => {
        try {
          return await Promise.race([res.json(), deadline]);
        } catch (err) {
          if (timedOut) throw new SyncFailure("network", "timed out");
          throw err instanceof SyncFailure ? err : new SyncFailure("blocked", "not json");
        } finally {
          done();
        }
      };
      return { res, read, done };
    } catch {
      done();
      return null;
    }
  }
  async function heartbeat(p) {
    await p.emit({ kind: "heartbeat", runId: p.runId, provider: p.provider });
  }
  async function getJson(p, url, headers) {
    let wait = 4e3;
    const retry = async (ms) => {
      await heartbeat(p);
      await p.sleep(ms);
      wait *= 2;
      await heartbeat(p);
    };
    for (let attempt = 1; ; attempt++) {
      const canRetry = attempt < MAX_ATTEMPTS && !p.isCancelled();
      const got = await timedGet(p, url, headers);
      if (!got) {
        if (canRetry) {
          await retry(wait);
          continue;
        }
        throw new SyncFailure("network", "network");
      }
      const res = got.res;
      if (res.ok) {
        try {
          return await got.read();
        } catch (err) {
          if (err instanceof SyncFailure && err.message === "timed out" && canRetry) {
            await retry(wait);
            continue;
          }
          throw err;
        }
      }
      got.done();
      if (res.status === 401) throw new SyncFailure("needs_login", "unauthorized");
      if (res.status === 403) throw new SyncFailure("blocked", "forbidden");
      if ((res.status === 429 || res.status >= 500) && canRetry) {
        const retryAfter = Number(res.headers.get("retry-after"));
        await retry(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 60) * 1e3 : wait);
        continue;
      }
      throw new SyncFailure(res.status === 429 ? "rate_limited" : "network", `HTTP ${res.status}`);
    }
  }
  async function chatGptHeaders(p) {
    const session = rec2(await getJson(p, `${p.origin}/api/auth/session`, {}));
    const token = typeof session?.accessToken === "string" ? session.accessToken : null;
    if (!token) throw new SyncFailure("needs_login", "no access token");
    const headers = { Authorization: `Bearer ${token}` };
    const device = cookie(p.cookies, "oai-did");
    if (device) headers["oai-device-id"] = device;
    const account = cookie(p.cookies, "_account");
    if (account && account !== "personal") headers["ChatGPT-Account-Id"] = account;
    return headers;
  }
  function parseChatGptList(json) {
    const items = rec2(json)?.items;
    if (!Array.isArray(items)) return null;
    const out = [];
    for (const raw of items) {
      const item = rec2(raw);
      if (!item || typeof item.id !== "string") continue;
      out.push({
        id: item.id.toLowerCase(),
        title: typeof item.title === "string" ? item.title : "",
        updatedAt: toIso(item.update_time),
        createdAt: toIso(item.create_time)
      });
    }
    return items.length > 0 && out.length === 0 ? null : out;
  }
  async function listChatGpt(p, headers) {
    const found = [];
    const seen = /* @__PURE__ */ new Set();
    for (const archived of p.scope === "all" ? [false, true] : [false]) {
      let stale = 0;
      for (let offset = 0; found.length < LIST_LIMIT && stale < 2; offset += CHATGPT_PAGE) {
        if (p.isCancelled()) break;
        const page = parseChatGptList(
          await getJson(p, `${p.origin}/backend-api/conversations?offset=${offset}&limit=${CHATGPT_PAGE}&order=updated&is_archived=${archived}`, headers)
        );
        if (page === null) throw new SyncFailure("unsupported", "list shape");
        if (page.length === 0) break;
        const fresh = page.filter((c) => !seen.has(c.id));
        if (fresh.length === 0) throw new SyncFailure("unsupported", "repeated history page");
        fresh.forEach((c) => seen.add(c.id));
        const recent = fresh.filter((c) => p.scope === "all" || !c.updatedAt || Date.parse(c.updatedAt) >= p.sinceMs);
        found.push(...recent);
        await p.emit({ kind: "phase", runId: p.runId, provider: p.provider, phase: "listing", total: found.length, message: `Found ${found.length} conversations` });
        stale = recent.length === 0 ? stale + 1 : 0;
        if (page.length < CHATGPT_PAGE) break;
        await p.sleep(PAUSE_MIN_MS);
      }
    }
    return found.slice(0, LIST_LIMIT);
  }
  async function claudeOrganization(p) {
    const fromCookie = cookie(p.cookies, "lastActiveOrg");
    if (fromCookie && /^[0-9a-f-]{36}$/i.test(fromCookie)) return fromCookie.toLowerCase();
    const orgs = await getJson(p, `${p.origin}/api/organizations`, {});
    if (!Array.isArray(orgs)) throw new SyncFailure("unsupported", "organizations shape");
    const rows = orgs.map(rec2).filter((o) => o !== null && typeof o.uuid === "string");
    const chat = rows.find((o) => Array.isArray(o.capabilities) && o.capabilities.includes("chat"));
    const uuid = (chat ?? rows[0])?.uuid;
    if (typeof uuid !== "string") throw new SyncFailure("needs_login", "no organization");
    return uuid.toLowerCase();
  }
  function parseClaudeList(json) {
    if (!Array.isArray(json)) return null;
    const out = [];
    for (const raw of json) {
      const item = rec2(raw);
      if (!item || typeof item.uuid !== "string") continue;
      out.push({
        id: item.uuid.toLowerCase(),
        title: typeof item.name === "string" ? item.name : "",
        updatedAt: toIso(item.updated_at),
        createdAt: toIso(item.created_at)
      });
    }
    return json.length > 0 && out.length === 0 ? null : out;
  }
  async function listClaude(p, org) {
    const found = [];
    const seen = /* @__PURE__ */ new Set();
    let stale = 0;
    let base = `${p.origin}/api/organizations/${org}/chat_conversations_v2`;
    let query = (offset) => `limit=${CLAUDE_PAGE}&offset=${offset}${p.scope === "all" ? "" : "&starred=false"}&consistency=eventual`;
    for (let offset = 0; found.length < LIST_LIMIT && stale < 2; offset += CLAUDE_PAGE) {
      if (p.isCancelled()) break;
      let json;
      try {
        json = await getJson(p, `${base}?${query(offset)}`, {});
      } catch (err) {
        if (offset === 0 && err instanceof SyncFailure && err.code === "network" && base.endsWith("_v2")) {
          base = `${p.origin}/api/organizations/${org}/chat_conversations`;
          query = (o) => `limit=${CLAUDE_PAGE}&offset=${o}`;
          offset -= CLAUDE_PAGE;
          continue;
        }
        throw err;
      }
      const page = parseClaudeList(rec2(json)?.data ?? json);
      if (page === null) throw new SyncFailure("unsupported", "list shape");
      if (page.length === 0) break;
      const fresh = page.filter((c) => !seen.has(c.id));
      if (fresh.length === 0) throw new SyncFailure("unsupported", "repeated history page");
      fresh.forEach((c) => seen.add(c.id));
      const recent = fresh.filter((c) => p.scope === "all" || !c.updatedAt || Date.parse(c.updatedAt) >= p.sinceMs);
      found.push(...recent);
      await p.emit({ kind: "phase", runId: p.runId, provider: p.provider, phase: "listing", total: found.length, message: `Found ${found.length} conversations` });
      stale = recent.length === 0 ? stale + 1 : 0;
      if (page.length < CLAUDE_PAGE) break;
      await p.sleep(PAUSE_MIN_MS);
    }
    found.sort((a, b) => Date.parse(b.updatedAt ?? "") - Date.parse(a.updatedAt ?? ""));
    return found.slice(0, LIST_LIMIT);
  }
  async function readSignedInIdentity(p) {
    if (p.site === "chatgpt") return readIdentityFrom(p, `${p.origin}/api/auth/session`, "chatgpt_session");
    const first = await readIdentityFrom(p, `${p.origin}/api/account`, "claude_account");
    return first.status === "unknown" ? readIdentityFrom(p, `${p.origin}/api/bootstrap`, "claude_account") : first;
  }
  async function readIdentityFrom(p, url, source) {
    const got = await timedGet(p, url, {});
    if (!got) return { status: "unknown" };
    if (got.res.status === 401) {
      got.done();
      return { status: "signed_out" };
    }
    if (!got.res.ok) {
      got.done();
      return { status: "unknown" };
    }
    let json;
    try {
      json = await got.read();
    } catch {
      return { status: "unknown" };
    }
    const identity2 = parseIdentity(source, json);
    if (identity2) return { status: "signed_in", identity: identity2 };
    const body = rec2(json);
    if (p.site === "chatgpt" && body && Object.keys(body).length === 0) return { status: "signed_out" };
    return { status: "unknown" };
  }
  function isUpToDate(listed, known) {
    const stored = known[listed.id];
    return Boolean(stored && listed.updatedAt && Date.parse(stored) >= Date.parse(listed.updatedAt));
  }
  async function runApiSync(p) {
    const base = { runId: p.runId, provider: p.provider };
    const label = p.provider === "chatgpt" ? "ChatGPT" : "Claude";
    const random = p.random ?? Math.random;
    try {
      await p.emit({ kind: "phase", ...base, phase: "listing", total: null, message: p.scope === "all" ? "Listing all conversations" : "Listing recent conversations" });
      let listed;
      let headers = {};
      let org = "";
      if (p.provider === "chatgpt") {
        headers = await chatGptHeaders(p);
        listed = await listChatGpt(p, headers);
      } else {
        org = await claudeOrganization(p);
        listed = await listClaude(p, org);
      }
      if (p.isCancelled()) {
        await p.emit({ kind: "done", ...base, listed: listed.length, message: "Cancelled" });
        return;
      }
      await p.emit({ kind: "phase", ...base, phase: "fetching", total: listed.length, message: null });
      let failures = 0;
      let read = 0;
      let empty = 0;
      let truncated = false;
      for (const item of listed) {
        if (p.isCancelled()) break;
        if (isUpToDate(item, p.known)) {
          await p.emit({ kind: "skipped", ...base, id: item.id, reason: "up_to_date" });
          continue;
        }
        if (read >= p.max) {
          truncated = true;
          break;
        }
        read += 1;
        try {
          const json = p.provider === "chatgpt" ? await getJson(p, `${p.origin}/backend-api/conversation/${item.id}`, headers) : await getJson(
            p,
            `${p.origin}/api/organizations/${org}/chat_conversations/${item.id}?tree=True&rendering_mode=messages&render_all_tools=true`,
            {}
          );
          const conv = p.provider === "chatgpt" ? parseChatGptConversation(json, item.id) : parseClaudeConversation(json, item.id);
          if (!conv) throw new SyncFailure("unsupported", "conversation shape");
          if (conv.messages.length === 0) {
            empty += 1;
            await p.emit({ kind: "skipped", ...base, id: item.id, reason: "empty" });
            if (read === EMPTY_PROBE && empty === EMPTY_PROBE) throw FORMAT_CHANGED;
          } else {
            await p.emit({
              kind: "conversation",
              ...base,
              conversation: { ...conv, title: conv.title || item.title, updatedAt: conv.updatedAt ?? item.updatedAt, createdAt: conv.createdAt ?? item.createdAt }
            });
          }
          failures = 0;
        } catch (err) {
          if (err instanceof SyncFailure && (err.code === "needs_login" || err.code === "blocked" || err.code === "rate_limited" || err === FORMAT_CHANGED)) throw err;
          failures += 1;
          await p.emit({ kind: "failed", ...base, id: item.id, message: err instanceof SyncFailure ? err.message : "Unexpected error" });
          if (failures >= MAX_CONSECUTIVE_FAILURES) {
            throw err instanceof SyncFailure ? err : new SyncFailure("unsupported", "repeated failures");
          }
        }
        await p.sleep(PAUSE_MIN_MS + random() * PAUSE_SPREAD_MS);
      }
      await p.emit({
        kind: "done",
        ...base,
        listed: listed.length,
        message: p.isCancelled() ? "Cancelled" : null,
        ...truncated && !p.isCancelled() ? { truncated: true } : {}
      });
    } catch (err) {
      const code = err instanceof SyncFailure ? err.code : "network";
      await p.emit({ kind: "error", ...base, code, message: describeSyncError(code, label) });
    }
  }

  // src/core/sidebar-history.ts
  var NOT_A_CONVERSATION = /* @__PURE__ */ new Set(["new", "new_chat", "library", "history", "recents", "settings", "search"]);
  function readSidebarConversations(doc, pageUrl, provider, limit = Infinity) {
    const out = [];
    const seen = /* @__PURE__ */ new Set();
    for (const a of Array.from(doc.querySelectorAll("a[href]"))) {
      if (out.length >= limit) break;
      let url;
      try {
        url = new URL(a.getAttribute("href") ?? "", pageUrl);
      } catch {
        continue;
      }
      if (url.protocol !== "https:") continue;
      if (detectProviderFromUrl(url.href) !== provider) continue;
      const id = extractConversationIdFromUrl(url.href);
      if (!id || NOT_A_CONVERSATION.has(id.toLowerCase()) || seen.has(id)) continue;
      seen.add(id);
      const title = (a.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 160);
      out.push({ id, url: `${url.origin}${url.pathname}${url.search}`, title });
    }
    return out;
  }
  function scrollParent(el, win) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const overflow = win.getComputedStyle(p).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && p.scrollHeight > p.clientHeight + 4) return p;
    }
    return null;
  }
  async function loadSidebarList(doc, win, provider, options) {
    const patience = options.patience ?? 2;
    const maxScrolls = options.maxScrolls ?? 20;
    let items = readSidebarConversations(doc, win.location.href, provider, options.limit);
    let idle = 0;
    let restore = null;
    let complete = false;
    for (let i = 0; ; i++) {
      if (idle >= patience) {
        complete = true;
        break;
      }
      if (i >= maxScrolls || items.length >= options.limit || options.isCancelled?.()) break;
      const lastLink = Array.from(doc.querySelectorAll("a[href]")).filter((a) => items.some((it) => a.getAttribute("href")?.includes(it.id))).pop();
      const scroller = lastLink ? scrollParent(lastLink, win) : null;
      if (!scroller) {
        complete = true;
        break;
      }
      restore ??= { el: scroller, top: scroller.scrollTop };
      scroller.scrollTop = scroller.scrollHeight;
      await options.sleep(700);
      const next = readSidebarConversations(doc, win.location.href, provider, options.limit);
      idle = next.length > items.length ? 0 : idle + 1;
      items = next;
    }
    if (restore) restore.el.scrollTop = restore.top;
    return { items, complete };
  }

  // src/core/embed/frame.ts
  function extensionOrigin() {
    try {
      if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return null;
      const url = new URL(chrome.runtime.getURL(""));
      return url.host ? `${url.protocol}//${url.host}` : null;
    } catch {
      return null;
    }
  }
  function isTop(win) {
    try {
      return win === win.top;
    } catch {
      return false;
    }
  }
  function frameMode(win = window) {
    if (isTop(win)) return "top";
    try {
      const ancestors = win.location.ancestorOrigins;
      if (!ancestors || ancestors.length !== 1) return "other";
      const own = extensionOrigin();
      return own !== null && ancestors[0] === own ? "workspace" : "other";
    } catch {
      return "other";
    }
  }
  var MAX_PANE_NAME = 400;
  function parsePaneName(name) {
    if (typeof name !== "string" || !name.startsWith(EMBED_FRAME_NAME_PREFIX)) return null;
    let rest = name.slice(EMBED_FRAME_NAME_PREFIX.length);
    let flags = "";
    if (rest.startsWith("!")) {
      const end = rest.indexOf("!", 1);
      if (end === -1) return null;
      flags = rest.slice(1, end);
      if (!/^[a-z]{0,8}$/.test(flags)) return null;
      rest = rest.slice(end + 1);
    }
    return rest.length > 0 && rest.length <= MAX_PANE_NAME ? { id: rest, flags } : null;
  }
  function readName(win) {
    try {
      return typeof win.name === "string" ? win.name : "";
    } catch {
      return "";
    }
  }
  function paneName(win = window) {
    return parsePaneName(readName(win))?.id ?? null;
  }
  function inProfileFrame(win = window) {
    try {
      return win.credentialless === true;
    } catch {
      return false;
    }
  }

  // src/core/embed/agent-state.ts
  function shouldReportAgentObservation(previous, next, now, heartbeatMs = 1e4) {
    if (!previous) return next.state !== "unknown";
    if (next.state !== previous.state || next.url !== previous.url) return true;
    return next.state !== "unknown" && now - previous.at >= heartbeatMs;
  }
  var TERMINAL_STATUSES = ["completed", "failed", "cancelled", "paused", "auth_expired", "process_exit"];
  function visible(el) {
    return !!el && el.getClientRects().length > 0;
  }
  function shownText(el) {
    const inner = el.innerText;
    return typeof inner === "string" ? inner : el.textContent ?? "";
  }
  var STOP_LABEL = /^(stop|stop generating|stop response)$/i;
  var SIGN_IN_LABEL = /^(log in|sign in|continue with google|continue with apple)$/i;
  var WORKING_STATUS = /^(running|executing|waiting for tool|waiting for network)$/;
  var CHALLENGE_TITLE = /just a moment|verify you are human|access denied/i;
  var PERMISSION_TEXT = /allow|approve|permission/i;
  function readAgentPage(doc) {
    const buttons = Array.from(doc.querySelectorAll("button")).filter(visible);
    const dialog = Array.from(doc.querySelectorAll("[role=dialog]")).find(visible) ?? null;
    const taskStatus = Array.from(doc.querySelectorAll('[data-testid="task-status"], [data-session-status]')).find(visible) ?? null;
    const status = taskStatus ? (taskStatus.getAttribute("data-session-status") || taskStatus.getAttribute("data-state") || shownText(taskStatus)).trim().toLowerCase() : "";
    const terminal = TERMINAL_STATUSES.includes(status) ? status : null;
    const signInField = Array.from(doc.querySelectorAll("input[type=email],input[type=password]")).some(visible);
    return {
      terminal,
      waitingTool: taskStatus !== null && WORKING_STATUS.test(status),
      login: signInField || buttons.some((b) => SIGN_IN_LABEL.test(shownText(b).trim())),
      challenge: CHALLENGE_TITLE.test(doc.title),
      stop: buttons.some((b) => STOP_LABEL.test((b.getAttribute("aria-label") || shownText(b)).trim())),
      permission: dialog !== null && PERMISSION_TEXT.test(shownText(dialog)),
      question: dialog !== null && dialog.querySelector("input,textarea") !== null && dialog.querySelector("input[type=password],input[type=email]") === null
    };
  }
  var TERMINAL_STATE = {
    completed: "turn_complete",
    failed: "failed",
    cancelled: "idle",
    paused: "idle",
    // The site says the sign-in ran out: the same as a sign-in form for the person.
    auth_expired: "signed_out",
    // The run's process ended without saying how; no state claims more than that.
    process_exit: "unknown"
  };
  function agentStateOf(read) {
    if (read.login) return "signed_out";
    if (read.permission) return "waiting_permission";
    if (read.question) return "waiting_answer";
    if (read.terminal) return TERMINAL_STATE[read.terminal];
    if (read.stop || read.waitingTool) return "running";
    return "unknown";
  }

  // src/core/workspace/realms.ts
  var ECOSYSTEM_REASON = "This sign-in is shared with the rest of your account on that service, so Threadkeeper leaves it alone. Use the site\u2019s own account switcher.";
  function realm(seed) {
    return { extraHostPatterns: [], switchable: true, ...seed };
  }
  var NAMED_REALMS = [
    realm({
      id: "anthropic",
      label: "Claude",
      providers: ["claude", "claude_code", "claude_duet"],
      cookieDomains: ["claude.ai"],
      signInUrl: "https://claude.ai/login",
      homeUrl: "https://claude.ai/new"
    }),
    realm({
      id: "openai",
      label: "ChatGPT",
      providers: ["chatgpt", "codex", "chatgpt_dots"],
      cookieDomains: ["chatgpt.com", "chat.openai.com", "auth.openai.com"],
      extraHostPatterns: ["https://auth.openai.com/*"],
      signInUrl: "https://chatgpt.com/auth/login",
      homeUrl: "https://chatgpt.com/"
    }),
    realm({
      id: "xai",
      label: "Grok",
      providers: ["grok"],
      cookieDomains: ["grok.com", "accounts.x.ai"],
      extraHostPatterns: ["https://accounts.x.ai/*"],
      signInUrl: "https://grok.com/",
      homeUrl: "https://grok.com/"
    }),
    realm({
      id: "x",
      label: "X",
      providers: ["grok_x", "grok_bot"],
      cookieDomains: ["x.com", "twitter.com"],
      signInUrl: "https://x.com/i/flow/login",
      homeUrl: "https://x.com/i/grok"
    }),
    realm({
      id: "cursor",
      label: "Cursor",
      providers: ["cursor_agents"],
      cookieDomains: ["cursor.com", "authenticator.cursor.sh"],
      extraHostPatterns: ["https://authenticator.cursor.sh/*"],
      signInUrl: "https://cursor.com/agents",
      homeUrl: "https://cursor.com/agents"
    }),
    realm({
      id: "meta",
      label: "Meta AI",
      providers: ["muse", "meta_ai"],
      cookieDomains: ["muse.ai", "meta.ai"],
      signInUrl: "https://muse.ai/",
      homeUrl: "https://muse.ai/"
    }),
    realm({
      id: "google",
      label: "Google",
      providers: ["gemini", "ai_studio", "gemini_notebook", "jules"],
      cookieDomains: [],
      switchable: false,
      fixedReason: ECOSYSTEM_REASON,
      signInUrl: "https://gemini.google.com/app",
      homeUrl: "https://gemini.google.com/app"
    }),
    realm({
      id: "github",
      label: "GitHub",
      providers: ["github_copilot"],
      cookieDomains: [],
      switchable: false,
      fixedReason: ECOSYSTEM_REASON,
      signInUrl: "https://github.com/copilot",
      homeUrl: "https://github.com/copilot"
    }),
    realm({
      id: "microsoft",
      label: "Microsoft",
      providers: ["copilot"],
      cookieDomains: [],
      switchable: false,
      fixedReason: ECOSYSTEM_REASON,
      signInUrl: "https://copilot.microsoft.com/",
      homeUrl: "https://copilot.microsoft.com/"
    })
  ];
  var REALM_BY_PROVIDER = /* @__PURE__ */ new Map();
  for (const info of NAMED_REALMS) for (const provider of info.providers) REALM_BY_PROVIDER.set(provider, info);
  function hostOfPattern(pattern) {
    const m = pattern.match(/^https?:\/\/([^/*]+)\/\*$/);
    return m ? m[1] : null;
  }
  function soloRealm(provider) {
    const info = PROVIDERS[provider];
    const hosts = info.matchPatterns.map(hostOfPattern).filter((h) => h !== null);
    const home = hosts[0] ? `https://${hosts[0]}/` : "";
    return {
      id: `site.${provider}`,
      label: info.label,
      providers: [provider],
      cookieDomains: [],
      extraHostPatterns: [],
      switchable: false,
      fixedReason: "Threadkeeper uses the account this browser is signed in to on this site.",
      signInUrl: home,
      homeUrl: home
    };
  }
  var SOLO_CACHE = /* @__PURE__ */ new Map();
  function realmForProvider(provider) {
    const named = REALM_BY_PROVIDER.get(provider);
    if (named) return named;
    const info = PROVIDERS[provider];
    if (info.hostAccess === "none" || info.hostAccess === "custom") return null;
    let solo = SOLO_CACHE.get(provider);
    if (!solo) {
      solo = soloRealm(provider);
      SOLO_CACHE.set(provider, solo);
    }
    return solo;
  }
  function switchableRealms() {
    return NAMED_REALMS.filter((r) => r.switchable);
  }
  function realmOwnsHost(info, host) {
    const h = host.toLowerCase();
    return info.cookieDomains.some((d) => h === d || h.endsWith(`.${d}`));
  }

  // src/core/dock/protocol.ts
  var MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
  var RESPONSE_BUDGET_BYTES = Math.floor(3.9 * 1024 * 1024);
  var TRANSCRIPT_MAX_TOTAL_CHARS = 3 * 1024 * 1024;
  var PAIR_REQUEST_TTL_MS = 10 * 6e4;
  var utf8 = new TextEncoder();

  // src/core/paperclip/bridge-protocol.ts
  var BRIDGE_SUPPORTED_PROVIDERS = ["claude", "claude_code", "chatgpt", "codex"];
  var BridgeActionError = class extends Error {
    constructor(code, message) {
      super(message);
      this.code = code;
      this.name = "BridgeActionError";
    }
  };
  var ACTION_TEXT = {
    disabled: "Agent actions are turned off.",
    denied: "This agent is not trusted for browser actions.",
    unlinked: "The session is not linked to the task you are working on.",
    timeout: "The browser did not answer in 30 seconds.",
    unknown: "The message may or may not have been sent. Read the session before trying again."
  };
  function actionAbortReason(signal) {
    return parseAbortReason(signal?.reason);
  }
  function parseAbortReason(value) {
    return value === "timeout" || value === "denied" || value === "unlinked" ? value : "disabled";
  }
  function abortCode(reason) {
    return reason === "unlinked" ? "denied" : reason;
  }
  function abortedBeforeTyping(signal) {
    const reason = actionAbortReason(signal);
    return new BridgeActionError(abortCode(reason), ACTION_TEXT[reason]);
  }

  // src/core/embed/session-delivery.ts
  var ADAPTERS2 = {
    chatgpt: { composer: '#prompt-textarea, textarea[data-testid="prompt-textarea"]', send: '[data-testid="send-button"], button[aria-label="Send prompt"]', userMessages: '[data-message-author-role="user"]' },
    codex: { composer: '#prompt-textarea, textarea[data-testid="prompt-textarea"], textarea[placeholder*="follow" i]', send: '[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send message"]', userMessages: '[data-message-author-role="user"], [data-testid="user-message"]' },
    claude: { composer: '[contenteditable="true"][data-testid="chat-input"], div.ProseMirror[contenteditable="true"], textarea[placeholder*="Claude" i]', send: 'button[aria-label="Send message"], button[data-testid="send-button"]', userMessages: '[data-testid="user-message"]' },
    claude_code: { composer: '[contenteditable="true"][data-testid="chat-input"], div.ProseMirror[contenteditable="true"], textarea[placeholder*="follow" i]', send: 'button[aria-label="Send message"], button[data-testid="send-button"]', userMessages: '[data-testid="user-message"]' }
  };
  var shownText2 = (el) => (el.innerText ?? el.textContent ?? "").trim();
  var normalizeText = (text2) => text2.replace(/\s+/g, " ").trim();
  function samePage(actual, expected) {
    try {
      const a = new URL(actual), b = new URL(expected);
      return a.protocol === "https:" && a.origin === b.origin && a.pathname.replace(/\/$/, "") === b.pathname.replace(/\/$/, "");
    } catch {
      return false;
    }
  }
  function checkAbort(signal) {
    if (signal?.aborted) throw abortedBeforeTyping(signal);
  }
  async function deliverProviderMessage(doc, actualUrl, command, options = {}) {
    const now = options.now ?? Date.now;
    const visible2 = options.visible ?? ((el) => el.getClientRects().length > 0);
    checkAbort(options.signal);
    if (!command || typeof command.requestId !== "string" || !command.requestId || command.requestId.length > 128 || typeof command.text !== "string" || !command.text.trim() || command.text.length > 2e4 || !Number.isFinite(command.deadlineAt)) throw new BridgeActionError("bad_request", "Invalid browser delivery request.");
    if (command.deadlineAt <= now()) throw new BridgeActionError("timeout", ACTION_TEXT.timeout);
    if (!samePage(actualUrl, command.expectedUrl) || detectProviderFromUrl(actualUrl) !== command.provider) throw new BridgeActionError("denied", "The loaded page is not the requested session.");
    if (!BRIDGE_SUPPORTED_PROVIDERS.includes(command.provider)) throw new BridgeActionError("unsupported", `${providerLabel(command.provider)} has no send support yet.`);
    const view = doc.defaultView;
    const root = doc.documentElement;
    const readUrl = options.currentUrl ?? (() => view?.location.href ?? doc.location.href);
    const initialUrl = readUrl();
    const isCurrentSession = () => {
      try {
        const liveUrl = readUrl();
        return doc.documentElement === root && (!view || view.document === doc) && samePage(liveUrl, command.expectedUrl) && samePage(liveUrl, actualUrl) && detectProviderFromUrl(liveUrl) === command.provider && new URL(liveUrl).search === new URL(initialUrl).search;
      } catch {
        return false;
      }
    };
    const checkSession = () => {
      checkAbort(options.signal);
      if (!isCurrentSession()) throw new BridgeActionError("denied", "The loaded page is no longer the requested session.");
      if (command.deadlineAt <= now()) throw new BridgeActionError("timeout", ACTION_TEXT.timeout);
    };
    checkSession();
    const adapter = ADAPTERS2[command.provider];
    const checkProviderState = () => {
      const buttons = Array.from(doc.querySelectorAll("button")).filter(visible2);
      if (Array.from(doc.querySelectorAll("input[type=password], input[type=email]")).some(visible2) || buttons.some((b) => /^(log in|sign in|continue with google|continue with apple)$/i.test(shownText2(b)))) throw new BridgeActionError("signed_out", "The session's account is signed out.");
      if (/verify you are human|just a moment|access denied/i.test(doc.title) || doc.querySelector('iframe[src*="challenges.cloudflare.com"], iframe[src*="captcha"]')) throw new BridgeActionError("unsupported", `${providerLabel(command.provider)} is showing a check that needs you.`);
      if (buttons.some((b) => /^(stop|stop generating|stop response)$/i.test(b.getAttribute("aria-label") || shownText2(b))) || Array.from(doc.querySelectorAll("[role=dialog]")).some(visible2)) throw new BridgeActionError("busy", "The session is still running. Wait for it to finish.");
    };
    checkProviderState();
    const composers = Array.from(doc.querySelectorAll(adapter.composer)).filter(visible2);
    const sends = Array.from(doc.querySelectorAll(adapter.send)).filter(visible2);
    if (composers.length !== 1 || sends.length !== 1) throw new BridgeActionError("unsupported", `${providerLabel(command.provider)} has no send support yet.`);
    const composer = composers[0];
    const current = composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.textContent ?? "";
    if (current.trim()) throw new BridgeActionError("busy", "The session has an unsent draft. Finish it before an agent sends a message.");
    const matchingCount = () => Array.from(doc.querySelectorAll(adapter.userMessages)).filter((el) => visible2(el) && normalizeText(shownText2(el)) === normalizeText(command.text)).length;
    const before = matchingCount();
    checkSession();
    const readDraft = () => composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement ? composer.value : composer.textContent ?? "";
    const writeDraft = (text2) => {
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(composer, text2);
      } else {
        composer.textContent = text2;
      }
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: text2 }));
    };
    let submitted = false;
    try {
      checkSession();
      writeDraft(command.text);
      const readyDeadline = Math.min(command.deadlineAt, now() + 2e3);
      let ready = Array.from(doc.querySelectorAll(adapter.send)).filter(visible2);
      while (ready.length === 1 && ready[0].disabled && now() < readyDeadline) {
        checkSession();
        await new Promise((resolve) => setTimeout(resolve, 25));
        checkSession();
        ready = Array.from(doc.querySelectorAll(adapter.send)).filter(visible2);
      }
      checkSession();
      checkProviderState();
      if (!composer.isConnected || !doc.contains(composer)) throw new BridgeActionError("denied", "The session composer changed before the agent could send.");
      if (normalizeText(readDraft()) !== normalizeText(command.text)) throw new BridgeActionError("busy", "The draft changed before the agent could send.");
      if (ready.length !== 1 || ready[0].disabled) throw new BridgeActionError("unsupported", `${providerLabel(command.provider)} has no send support yet.`);
      checkSession();
      submitted = true;
      ready[0].click();
    } catch (error) {
      if (!submitted && isCurrentSession() && composer.isConnected && readDraft() === command.text) writeDraft("");
      if (submitted) throw new BridgeActionError("unknown_delivery", "The message may or may not have been sent. Read the session before trying again.");
      throw error;
    }
    const confirmationDeadline = Math.min(command.deadlineAt, now() + (options.confirmationMs ?? 15e3));
    const delivered = () => matchingCount() > before;
    if (!isCurrentSession()) throw new BridgeActionError("unknown_delivery", "The session changed after submission. Read the requested session before trying again.");
    if (delivered()) return { delivered: true, at: new Date(now()).toISOString() };
    return new Promise((resolve, reject) => {
      let settled = false;
      const inspect = () => {
        if (!isCurrentSession()) finish(false);
        else if (delivered()) finish(true);
      };
      const observer = new MutationObserver(inspect);
      const finish = (success) => {
        if (settled) return;
        settled = true;
        observer.disconnect();
        clearTimeout(timer);
        clearInterval(sessionWatch);
        success ? resolve({ delivered: true, at: new Date(now()).toISOString() }) : reject(new BridgeActionError("unknown_delivery", "The message may or may not have been sent. Read the session before trying again."));
      };
      const timer = setTimeout(() => finish(isCurrentSession() && delivered()), Math.max(1, confirmationDeadline - now()));
      const sessionWatch = setInterval(inspect, 25);
      observer.observe(doc.documentElement, { subtree: true, childList: true, characterData: true });
      inspect();
    });
  }
  function createSessionDeliveryHandler(options) {
    const pending = /* @__PURE__ */ new Map();
    return (message, sender, respond) => {
      if (!message || typeof message !== "object") return false;
      const m = message;
      if (m.type !== "TK_SESSION_DELIVER" && m.type !== "TK_SESSION_CANCEL") return false;
      const ownOrigin = `chrome-extension://${options.ownId}`;
      if (!options.workspace || sender.id !== options.ownId || !(sender.origin === ownOrigin || sender.url?.startsWith(`${ownOrigin}/`))) {
        respond({ ok: false, error: { code: "denied", message: "Browser actions require the Threadkeeper workspace." } });
        return true;
      }
      if (m.type === "TK_SESSION_CANCEL") {
        if (typeof m.requestId === "string") pending.get(m.requestId)?.abort(parseAbortReason(m.reason));
        respond({ ok: true });
        return true;
      }
      if (typeof m.requestId !== "string" || pending.has(m.requestId)) {
        respond({ ok: false, error: { code: "busy", message: "This browser action is already running." } });
        return true;
      }
      const controller = new AbortController();
      pending.set(m.requestId, controller);
      void deliverProviderMessage(options.doc, options.url(), m, { signal: controller.signal, currentUrl: options.url }).then((data) => respond({ ok: true, data: { ...data, url: options.url() } }), (err) => respond({ ok: false, error: { code: err instanceof BridgeActionError ? err.code : "unknown_delivery", message: err instanceof BridgeActionError ? err.message : "Delivery could not be confirmed." } })).finally(() => pending.delete(m.requestId));
      return true;
    };
  }

  // src/entrypoints/content.ts
  var OVERLAY_DIALOG_ID = "threadkeeper-overlay-root";
  var FRAME_MODE = frameMode();
  var IN_WORKSPACE = FRAME_MODE === "workspace";
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
  var pendingExplicitToken = null;
  var pendingExplicitKind = "overlay";
  var captureSite = null;
  var grokXConversation = null;
  var siteConversation = null;
  function extractCurrentConversation(explicit = false) {
    const href = window.location.href;
    if (detectProviderFromUrl(href) === "grok_x") {
      const urlId = extractConversationIdFromUrl(href);
      if (!grokXConversation || urlId && urlId !== grokXConversation.id) return null;
      return grokXConversationToExtraction(grokXConversation.id, grokXConversation.messages);
    }
    return extractVisibleDomConversation(document, href, { site: captureSite, explicit });
  }
  var lastCaptureStatus = null;
  function noteCapture(status) {
    lastCaptureStatus = { at: (/* @__PURE__ */ new Date()).toISOString(), ...status };
  }
  function sendCapture(payload, explicitInvoke, done, explicitToken = null) {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    try {
      const message = { type: "PASSIVE_DOM_CAPTURE", explicitInvoke, payload };
      if (explicitToken) message.explicitToken = explicitToken;
      chrome.runtime.sendMessage(message, (resp) => {
        const failed = chrome.runtime.lastError;
        done(failed ? void 0 : resp);
      });
    } catch {
    }
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
  function onSiteDataWindowMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const data = parseSiteDataMessage(event.data);
    if (!data) return;
    const href = window.location.href;
    const page = detectProviderFromUrl(href);
    if (page !== data.provider) return;
    const urlId = extractConversationIdFromUrl(href)?.toLowerCase();
    if (!urlId || urlId !== data.conversationId) return;
    const parsed = parseSiteConversation(data.provider, data.json, data.conversationId);
    if (!parsed || parsed.sourceConversationId !== urlId) return;
    siteConversation = parsed;
    scheduleSiteDataCapture();
  }
  var siteDataTimer = null;
  var lastSiteDataFingerprint = "";
  function scheduleSiteDataCapture() {
    if (siteDataTimer) clearTimeout(siteDataTimer);
    siteDataTimer = setTimeout(() => {
      siteDataTimer = null;
      const conv = siteConversation;
      if (!conv) return;
      const urlId = extractConversationIdFromUrl(window.location.href)?.toLowerCase();
      if (urlId !== conv.sourceConversationId) return;
      const fingerprint = `${conv.sourceConversationId}:${conv.title}:${conv.messages.map((m) => `${m.sourceMessageId}:${m.content.length}`).join("|")}`;
      if (fingerprint === lastSiteDataFingerprint) return;
      sendCapture(
        {
          provider: conv.provider,
          sourceConversationId: conv.sourceConversationId,
          branchId: "main",
          canonicalUrl: conv.canonicalUrl,
          title: siteConversationTitle(conv),
          createdAt: conv.createdAt,
          updatedAt: conv.updatedAt ?? (/* @__PURE__ */ new Date()).toISOString(),
          coverage: conv.messages.length > 0 ? "full" : "title_only",
          captureSource: "network_observer",
          messages: conv.messages,
          // The data names the project by id only; the page shows its name.
          providerProjectName: extractProviderProjectName(document, window.location.href),
          modelSlug: conv.modelSlug
        },
        false,
        (resp) => {
          if (resp?.ok) {
            lastSiteDataFingerprint = fingerprint;
            noteCapture({ method: "site_data", outcome: "stored", messages: conv.messages.length });
          } else {
            noteCapture({ method: "site_data", outcome: resp?.skipped ? "skipped" : "error", detail: resp?.skipped });
          }
        }
      );
    }, 300);
  }
  function agentStateFor(provider) {
    if (!provider || providerCategory(provider) !== "coding_agent") return null;
    try {
      return agentStateOf(readAgentPage(document));
    } catch {
      return "unknown";
    }
  }
  function sessionFacts(provider) {
    const facts = {};
    const state = agentStateFor(provider);
    if (state && state !== "unknown") facts.agentState = state;
    try {
      const repo = extractRepositoryInfo(document, window.location.href);
      if (repo.repository) facts.repository = repo.repository;
      if (repo.pullRequestUrl) facts.pullRequestUrl = repo.pullRequestUrl;
      if (repo.gitBranch) facts.gitBranch = repo.gitBranch;
    } catch {
    }
    return facts;
  }
  function sendToExtension(message, done) {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    try {
      chrome.runtime.sendMessage(message, (response) => {
        const failed = chrome.runtime.lastError;
        done?.(failed ? void 0 : response);
      });
    } catch {
    }
  }
  var sentIdentityKeys = /* @__PURE__ */ new Set();
  function onIdentityWindowMessage(event) {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = parseIdentityMessage(event.data);
    if (!message) return;
    const provider = providerForIdentitySource(message.kind);
    const realm2 = realmForProvider(provider);
    if (!realm2 || !realmOwnsHost(realm2, window.location.hostname)) return;
    let identity2 = null;
    try {
      identity2 = parseIdentity(message.kind, JSON.parse(message.body));
    } catch {
      return;
    }
    if (!identity2 || typeof identity2.key !== "string" || !identity2.key) return;
    if (sentIdentityKeys.has(identity2.key)) return;
    sentIdentityKeys.add(identity2.key);
    sendToExtension({ type: "ACCOUNT_IDENTITY", provider, identity: identity2 });
  }
  var LOGIN_PATH = /^\/(?:auth\/)?(?:login|log-in|signin|sign-in)\/?$|^\/i\/flow\/login\/?$/i;
  var signedOutSent = false;
  function checkSignedOut() {
    if (signedOutSent || !LOGIN_PATH.test(window.location.pathname)) return;
    const host = window.location.hostname;
    const realm2 = switchableRealms().find((r) => realmOwnsHost(r, host));
    if (!realm2) return;
    let login = false;
    try {
      login = readAgentPage(document).login;
    } catch {
      return;
    }
    if (!login) return;
    signedOutSent = true;
    const onPage = detectProviderFromUrl(window.location.href);
    const provider = onPage && realm2.providers.includes(onPage) ? onPage : realm2.providers[0];
    sendToExtension({ type: "ACCOUNT_IDENTITY", provider, identity: null });
  }
  var PAGE_CHECK_MS = 2e3;
  var pageCheckTimer = null;
  var lastPageCheck = 0;
  function schedulePageCheck() {
    if (pageCheckTimer) return;
    const wait = Math.max(0, lastPageCheck + PAGE_CHECK_MS - Date.now());
    pageCheckTimer = setTimeout(() => {
      pageCheckTimer = null;
      lastPageCheck = Date.now();
      checkSignedOut();
      if (IN_WORKSPACE) reportAgentState();
    }, wait);
  }
  var EMBED_PANE = IN_WORKSPACE ? paneName() : null;
  var embedFrameId = null;
  function navigationApi() {
    const nav = window.navigation;
    return typeof nav === "object" && nav !== null ? nav : null;
  }
  var TOP_FRAME_COMMANDS = /* @__PURE__ */ new Set([
    "TK_CAPTURE_NOW",
    "TK_HISTORY_SYNC_RUN",
    "TK_HISTORY_SYNC_CANCEL",
    "TK_HISTORY_LIST_SIDEBAR",
    "TK_HISTORY_IDENTITY",
    "TK_CAPTURE_PROBE"
  ]);
  function addressedToThisFrame(message) {
    return FRAME_MODE === "top" || embedFrameId !== null && message.frameId === embedFrameId;
  }
  var HELLO_RETRY_MS = [2e3, 1e4];
  function sendEmbedHello(attempt = 0) {
    sendToExtension(
      { type: "EMBED_HELLO", pane: EMBED_PANE, url: window.location.href, title: document.title, profile: inProfileFrame(window) },
      (response) => {
        const r = response;
        if (r?.ok === true && typeof r.frameId === "number" && Number.isInteger(r.frameId) && r.frameId > 0) {
          embedFrameId = r.frameId;
          return;
        }
        const delay = HELLO_RETRY_MS[attempt];
        if (delay !== void 0) setTimeout(() => sendEmbedHello(attempt + 1), delay);
      }
    );
  }
  var lastNavKey = "";
  var navTimer = null;
  function reportNav() {
    const nav = navigationApi();
    const message = {
      type: "EMBED_NAV",
      pane: EMBED_PANE,
      url: window.location.href,
      title: document.title,
      canGoBack: nav?.canGoBack === true,
      canGoForward: nav?.canGoForward === true
    };
    const key = JSON.stringify([message.url, message.title, message.canGoBack, message.canGoForward]);
    if (key === lastNavKey) return;
    lastNavKey = key;
    sendToExtension(message);
  }
  function scheduleNavReport() {
    if (navTimer) return;
    navTimer = setTimeout(() => {
      navTimer = null;
      reportNav();
    }, 150);
  }
  var lastAgentState = "unknown";
  var lastAgentUrl = "";
  var lastAgentReportAt = 0;
  var lastAgentCheckAt = 0;
  function reportAgentState() {
    const url = window.location.href;
    const state = agentStateFor(detectProviderFromUrl(url)) ?? "unknown";
    const now = Date.now();
    lastAgentCheckAt = now;
    if (!shouldReportAgentObservation(lastAgentUrl ? { state: lastAgentState, url: lastAgentUrl, at: lastAgentReportAt } : null, { state, url }, now)) return;
    lastAgentState = state;
    lastAgentUrl = url;
    lastAgentReportAt = now;
    sendToExtension({ type: "EMBED_AGENT_STATE", pane: EMBED_PANE, url, state });
  }
  function observeTitle() {
    const head = document.head;
    if (!head) {
      document.addEventListener("DOMContentLoaded", observeTitle, { once: true });
      return;
    }
    new MutationObserver(scheduleNavReport).observe(head, { childList: true, subtree: true, characterData: true });
  }
  function settle(result) {
    result?.committed?.catch(() => void 0);
    result?.finished?.catch(() => void 0);
  }
  function runEmbedCommand(message) {
    const nav = navigationApi();
    switch (message.command) {
      case "back":
        if (nav && typeof nav.back === "function") {
          if (nav.canGoBack !== true) return { ok: false, error: "no_history" };
          settle(nav.back());
        } else {
          history.back();
        }
        return { ok: true };
      case "forward":
        if (nav && typeof nav.forward === "function") {
          if (nav.canGoForward !== true) return { ok: false, error: "no_history" };
          settle(nav.forward());
        } else {
          history.forward();
        }
        return { ok: true };
      case "reload":
        setTimeout(() => window.location.reload(), 0);
        return { ok: true };
      case "navigate": {
        if (typeof message.url !== "string" || message.url.length > 4096) return { ok: false, error: "bad_url" };
        let target;
        try {
          target = new URL(message.url);
        } catch {
          return { ok: false, error: "bad_url" };
        }
        if (target.protocol !== "https:") return { ok: false, error: "bad_url" };
        setTimeout(() => window.location.assign(target.href), 0);
        return { ok: true };
      }
      default:
        return { ok: false, error: "unknown_command" };
    }
  }
  function startEmbedBridge() {
    sendEmbedHello();
    reportNav();
    observeTitle();
    const nav = navigationApi();
    nav?.addEventListener("currententrychange", scheduleNavReport);
    window.addEventListener("popstate", scheduleNavReport);
    window.addEventListener("hashchange", scheduleNavReport);
    window.addEventListener("pageshow", scheduleNavReport);
  }
  var CAPTURE_MAX_WAIT_MS = 4e3;
  var CAPTURE_QUIET_MS = 900;
  var pendingSince = 0;
  var lastExtraction = null;
  var staleRetries = 0;
  var MAX_STALE_RETRIES = 8;
  var SETTLE_RECHECK_MS = 1500;
  var lastUnsettledFingerprint = "";
  var settleTimer = null;
  function textFingerprintOf(messages) {
    return messages.map((m) => `${m.role}:${m.content}`).join("\u241E");
  }
  function keyedIdsOf(messages) {
    return new Set(messages.map((m) => m.sourceMessageId).filter((id) => !/_m_\d+(#\d+)?$/.test(id)));
  }
  function isStaleAfterNavigation(extracted) {
    const last = lastExtraction;
    if (!last || last.conversationId === extracted.sourceConversationId || extracted.messages.length === 0) return false;
    for (const id of keyedIdsOf(extracted.messages)) if (last.keyedIds.has(id)) return true;
    return last.textFingerprint !== "" && last.textFingerprint === textFingerprintOf(extracted.messages);
  }
  function schedulePassiveDomCapture(explicitInvoke = false, explicitToken = null, explicitKind = "overlay") {
    if (explicitInvoke) {
      pendingExplicitInvoke = true;
      if (explicitToken) {
        pendingExplicitToken = explicitToken;
        pendingExplicitKind = explicitKind;
      }
    }
    if (captureDebounceTimer) {
      clearTimeout(captureDebounceTimer);
    }
    const now = Date.now();
    if (pendingSince === 0) pendingSince = now;
    const isExplicit = pendingExplicitInvoke;
    const delay = isExplicit ? 50 : Math.max(50, Math.min(CAPTURE_QUIET_MS, pendingSince + CAPTURE_MAX_WAIT_MS - now));
    captureDebounceTimer = setTimeout(() => {
      const useExplicit = pendingExplicitInvoke;
      const useToken = useExplicit ? pendingExplicitToken : null;
      const useKind = pendingExplicitKind;
      pendingExplicitInvoke = false;
      pendingExplicitToken = null;
      pendingExplicitKind = "overlay";
      pendingSince = 0;
      captureDebounceTimer = null;
      const extracted = extractCurrentConversation(Boolean(useToken) && useKind === "capture");
      if (!extracted) {
        noteCapture({ method: "dom", outcome: "no_conversation", detail: "The page is not an open conversation yet." });
        return;
      }
      if (isStaleAfterNavigation(extracted) && staleRetries < MAX_STALE_RETRIES) {
        staleRetries += 1;
        noteCapture({ method: "dom", outcome: "stale_dom", detail: "Waiting for the page to replace the previous conversation." });
        captureDebounceTimer = setTimeout(() => schedulePassiveDomCapture(useExplicit, useToken, useKind), 700);
        return;
      }
      staleRetries = 0;
      const facts = sessionFacts(extracted.provider);
      const fingerprint = `${extracted.provider}:${extracted.sourceConversationId}:${extracted.branchId}:${extracted.title}:${extracted.providerProjectName ?? ""}:${JSON.stringify(facts)}:${extracted.messages.map((m) => `${m.sourceMessageId}:${m.content.length}`).join("|")}`;
      if (!useExplicit && fingerprint === lastCapturedFingerprint) {
        noteCapture({ method: "dom", outcome: "unchanged", messages: extracted.messages.length });
        return;
      }
      if (!useExplicit && extracted.stabilize) {
        const textPrint = `${fingerprint}\u241E${textFingerprintOf(extracted.messages)}`;
        if (textPrint !== lastUnsettledFingerprint) {
          lastUnsettledFingerprint = textPrint;
          noteCapture({ method: "dom", outcome: "settling", detail: "Waiting for the page to stop changing.", messages: extracted.messages.length });
          if (settleTimer) clearTimeout(settleTimer);
          settleTimer = setTimeout(() => {
            settleTimer = null;
            schedulePassiveDomCapture();
          }, SETTLE_RECHECK_MS);
          return;
        }
      }
      lastUnsettledFingerprint = "";
      sendCapture(
        {
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
          modelSlug: extracted.modelSlug,
          ...facts
        },
        useExplicit,
        (resp) => {
          if (resp?.ok) {
            lastCapturedFingerprint = fingerprint;
            lastExtraction = {
              conversationId: extracted.sourceConversationId,
              keyedIds: keyedIdsOf(extracted.messages),
              textFingerprint: textFingerprintOf(extracted.messages)
            };
            noteCapture({ method: "dom", outcome: "stored", messages: extracted.messages.length });
          } else {
            noteCapture({ method: "dom", outcome: resp?.skipped ? "skipped" : "error", detail: resp?.skipped ?? resp?.error ?? "No answer from the extension." });
          }
        },
        useToken
      );
    }, delay);
  }
  var syncCancelled = false;
  var currentSync = null;
  var sleepMs = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  async function emitSyncEvent(event) {
    try {
      const reply = await chrome.runtime.sendMessage({ type: "HISTORY_SYNC_EVENT", event });
      return Boolean(reply?.ok);
    } catch {
      return false;
    }
  }
  function startApiSync(message) {
    const provider = message.provider;
    const host = window.location.hostname.toLowerCase();
    const onChatGpt = host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com";
    const onClaude = host === "claude.ai" || host.endsWith(".claude.ai");
    if ((provider !== "chatgpt" || !onChatGpt) && (provider !== "claude" || !onClaude)) return { ok: false, error: "wrong_site" };
    if (typeof message.runId !== "string" || typeof message.sinceMs !== "number" || !Number.isFinite(message.sinceMs) || typeof message.max !== "number" || !Number.isFinite(message.max)) {
      return { ok: false, error: "bad_request" };
    }
    if (currentSync) currentSync.cancelled = true;
    const run = { runId: message.runId, cancelled: false };
    currentSync = run;
    const known = {};
    if (typeof message.known === "object" && message.known !== null) {
      for (const [k, v] of Object.entries(message.known)) if (typeof v === "string") known[k.toLowerCase()] = v;
    }
    void runApiSync({
      provider,
      runId: message.runId,
      sinceMs: message.sinceMs,
      max: message.scope === "all" ? Number.MAX_SAFE_INTEGER : Math.min(500, Math.max(1, Math.round(message.max))),
      scope: message.scope === "all" ? "all" : "recent",
      known,
      origin: window.location.origin,
      cookies: document.cookie,
      fetchImpl: window.fetch.bind(window),
      emit: async (event) => {
        if (run.cancelled) return;
        if (!await emitSyncEvent(event)) run.cancelled = true;
      },
      isCancelled: () => run.cancelled,
      sleep: sleepMs
    }).finally(() => {
      if (currentSync === run) currentSync = null;
    });
    return { ok: true };
  }
  async function signedInIdentity() {
    const host = window.location.hostname.toLowerCase();
    const site = host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host === "chat.openai.com" ? "chatgpt" : host === "claude.ai" || host.endsWith(".claude.ai") ? "claude" : null;
    if (!site) return { ok: true, status: "unknown" };
    const result = await readSignedInIdentity({ site, origin: window.location.origin, fetchImpl: window.fetch.bind(window) });
    return { ok: true, ...result };
  }
  function probeCapture() {
    const href = window.location.href;
    let extracted = null;
    let error = null;
    try {
      extracted = extractCurrentConversation();
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    return {
      url: href,
      provider: extracted?.provider ?? detectProviderFromUrl(href),
      site: captureSite?.origin ?? null,
      method: extracted?.method ?? null,
      conversationId: extractConversationIdFromUrl(href),
      domMessages: extracted?.messages.length ?? 0,
      domRoles: extracted ? extracted.messages.reduce((acc, m) => (acc[m.role] = (acc[m.role] ?? 0) + 1, acc), {}) : {},
      domTitle: extracted?.title ?? null,
      domProject: extracted?.providerProjectName ?? null,
      siteDataMessages: siteConversation && siteConversation.sourceConversationId === extractConversationIdFromUrl(href)?.toLowerCase() ? siteConversation.messages.length : null,
      lastCapture: lastCaptureStatus,
      error
    };
  }
  function requestCaptureSite() {
    if (typeof chrome === "undefined" || !chrome.runtime?.sendMessage) return;
    try {
      chrome.runtime.sendMessage({ type: "GET_CAPTURE_SITE" }, (resp) => {
        if (chrome.runtime.lastError || !resp?.ok || typeof resp.site?.origin !== "string") return;
        if (resp.site.origin !== window.location.origin) return;
        captureSite = { origin: resp.site.origin };
        schedulePassiveDomCapture();
      });
    } catch {
    }
  }
  var ISOLATED_WORLD_GUARD = Symbol.for("threadkeeper.contentScriptInitialized");
  var isolatedGlobal = globalThis;
  if (FRAME_MODE !== "other" && !isolatedGlobal[ISOLATED_WORLD_GUARD]) {
    isolatedGlobal[ISOLATED_WORLD_GUARD] = true;
    if (!IN_WORKSPACE) {
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
    }
    const onX = isXHostname(window.location.hostname);
    if (onX) {
      window.addEventListener("message", onGrokXWindowMessage);
    } else {
      window.addEventListener("message", onSiteDataWindowMessage);
    }
    window.addEventListener("message", onIdentityWindowMessage);
    try {
      window.postMessage({ source: IDENTITY_REPLAY_SOURCE }, window.location.origin);
    } catch {
    }
    if (typeof chrome !== "undefined" && chrome.runtime?.onMessage) {
      const deliverSession = createSessionDeliveryHandler({ ownId: chrome.runtime.id, doc: document, url: () => window.location.href, workspace: IN_WORKSPACE });
      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (deliverSession(message, _sender, sendResponse)) return true;
        if (IN_WORKSPACE && message && message.type === "TK_EMBED_COMMAND") {
          sendResponse(runEmbedCommand(message));
          return true;
        }
        if (IN_WORKSPACE && message && (message.type === "TOGGLE_THREADKEEPER_OVERLAY" || message.type === "CLOSE_THREADKEEPER_OVERLAY")) {
          return false;
        }
        if (message && typeof message.type === "string" && TOP_FRAME_COMMANDS.has(message.type) && !addressedToThisFrame(message)) {
          return false;
        }
        if (message && message.type === "TOGGLE_THREADKEEPER_OVERLAY" && typeof message.handshakeToken === "string" && message.handshakeToken.length >= 16) {
          const res = openOrToggleOverlay(message.handshakeToken);
          if (res.state === "opened") {
            schedulePassiveDomCapture(true, message.handshakeToken, "overlay");
          }
          sendResponse({ ok: true, state: res.state });
          return true;
        }
        if (message && message.type === "TK_PING") {
          sendResponse({ ok: true });
          return true;
        }
        if (message && message.type === "TK_CAPTURE_NOW") {
          const token = typeof message.explicitToken === "string" && message.explicitToken.length >= 16 ? message.explicitToken : null;
          schedulePassiveDomCapture(true, token, token ? "capture" : "overlay");
          sendResponse({ ok: true });
          return true;
        }
        if (message && message.type === "TK_HISTORY_SYNC_RUN") {
          sendResponse(startApiSync(message));
          return true;
        }
        if (message && message.type === "TK_HISTORY_SYNC_CANCEL") {
          syncCancelled = true;
          if (currentSync) currentSync.cancelled = true;
          sendResponse({ ok: true });
          return true;
        }
        if (message && message.type === "TK_HISTORY_IDENTITY") {
          void signedInIdentity().then(sendResponse, () => sendResponse({ ok: true, status: "unknown" }));
          return true;
        }
        if (message && message.type === "TK_HISTORY_LIST_SIDEBAR") {
          const provider = message.provider;
          const limit = typeof message.limit === "number" ? Math.min(1e3, Math.max(1, Math.round(message.limit))) : 30;
          const maxScrolls = typeof message.maxScrolls === "number" ? Math.min(300, Math.max(1, Math.round(message.maxScrolls))) : void 0;
          const patience = typeof message.patience === "number" ? Math.min(6, Math.max(1, Math.round(message.patience))) : void 0;
          if (!isSyncProviderId(provider)) {
            sendResponse({ ok: false, items: [] });
            return true;
          }
          syncCancelled = false;
          void loadSidebarList(document, window, provider, { limit, maxScrolls, patience, sleep: sleepMs, isCancelled: () => syncCancelled }).then(
            ({ items, complete }) => sendResponse({ ok: true, items, complete }),
            () => sendResponse({ ok: false, items: [] })
          );
          return true;
        }
        if (message && message.type === "TK_CAPTURE_PROBE") {
          sendResponse({ ok: true, report: probeCapture() });
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
      const isOverlayNode = (node) => typeof Element !== "undefined" && node instanceof Element && (node.id === OVERLAY_DIALOG_ID || Boolean(node.closest(`#${OVERLAY_DIALOG_ID}`)));
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
        schedulePageCheck();
      });
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true
      });
      if (detectProviderFromUrl(window.location.href) === null) {
        requestCaptureSite();
      } else {
        schedulePassiveDomCapture();
      }
    }
    if (IN_WORKSPACE) startEmbedBridge();
    schedulePageCheck();
    let lastHref = window.location.href;
    window.setInterval(() => {
      if (IN_WORKSPACE) {
        scheduleNavReport();
        if (Date.now() - lastAgentCheckAt >= 1e4) schedulePageCheck();
      }
      if (window.location.href === lastHref) {
        if (!signedOutSent && LOGIN_PATH.test(window.location.pathname)) schedulePageCheck();
        return;
      }
      lastHref = window.location.href;
      staleRetries = 0;
      if (!onX) schedulePassiveDomCapture();
      schedulePageCheck();
    }, 1500);
  }
})();
