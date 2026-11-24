// Serves the built extension pages over http://127.0.0.1 with a stand-in for the `chrome` API,
// so the manager UI can be rendered and inspected in an ordinary browser (design review,
// screenshots). It is a preview only: nothing here is the extension. Capture, the service
// worker, cookies, embedding rules and account switching do not exist in this page, and every
// runtime message is answered by the stub below. Use the Playwright scripts for real behaviour.
//
// Limit: provider sites (claude.ai, chatgpt.com, cursor.com ...) refuse to load inside frames
// without the extension's header-rewriting rules, so embedded session pages show the page's
// own refusal or stay blank here. The preview shows the workspace chrome, accounts and
// resting states, not the embedded pages themselves.
//
// Workspace commands (WORKSPACE_HELLO, ACCOUNTS_*, HELPER_PING) are answered from in-memory
// accounts that start as the demo library's (WORKSPACE_DEMO_ACCOUNTS in
// src/core/synthetic-fixtures.ts). A page can replace any answer with window.__tkPreviewAnswers.
//
//   npm run build && node scripts/preview-server.mjs [port]
//   open http://127.0.0.1:4317/manager.html?surface=page&seed=1
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(__dirname, '..', '.output', 'chrome-mv3');
const port = Number(process.argv[2] || process.env.TK_PREVIEW_PORT || 4317);

if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.error('No build found. Run `npm run build` first.');
  process.exit(1);
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
};

/** The stub is rebuilt per request so a rebuild's manifest is picked up without a restart. */
function chromeStub() {
  const manifest = fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8');
  return `(() => {
  const manifest = ${manifest};
  const listeners = new Set();
  const event = () => ({ addListener() {}, removeListener() {}, hasListener: () => false });
  const store = (area) => ({
    async get(keys) {
      const raw = JSON.parse(localStorage.getItem('tk-preview-' + area) || '{}');
      if (keys == null) return raw;
      const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : Object.keys(keys);
      const out = Array.isArray(keys) || typeof keys === 'string' ? {} : { ...keys };
      for (const k of list) if (k in raw) out[k] = raw[k];
      return out;
    },
    async set(items) {
      const raw = JSON.parse(localStorage.getItem('tk-preview-' + area) || '{}');
      localStorage.setItem('tk-preview-' + area, JSON.stringify({ ...raw, ...items }));
    },
    async remove(keys) {
      const raw = JSON.parse(localStorage.getItem('tk-preview-' + area) || '{}');
      for (const k of [].concat(keys)) delete raw[k];
      localStorage.setItem('tk-preview-' + area, JSON.stringify(raw));
    },
    async clear() { localStorage.removeItem('tk-preview-' + area); },
    async setAccessLevel() {},
  });
  // Pages can install their own answers for specific message types (used by design fixtures).
  const answers = (window.__tkPreviewAnswers = window.__tkPreviewAnswers || {});

  // ---- Workspace accounts (in memory; a reload starts again from this literal) ----
  // KEEP IN STEP with src/core/workspace/realms.ts (the realm objects) and
  // WORKSPACE_DEMO_ACCOUNTS in src/core/synthetic-fixtures.ts (the anthropic and openai rows).
  const REALMS = {
    anthropic: { id: 'anthropic', label: 'Claude', providers: ['claude', 'claude_code', 'claude_duet'], cookieDomains: ['claude.ai'], extraHostPatterns: [], switchable: true, signInUrl: 'https://claude.ai/login', homeUrl: 'https://claude.ai/new' },
    openai: { id: 'openai', label: 'ChatGPT', providers: ['chatgpt', 'codex', 'chatgpt_dots'], cookieDomains: ['chatgpt.com', 'chat.openai.com', 'auth.openai.com'], extraHostPatterns: ['https://auth.openai.com/*'], switchable: true, signInUrl: 'https://chatgpt.com/auth/login', homeUrl: 'https://chatgpt.com/' },
    xai: { id: 'xai', label: 'Grok', providers: ['grok'], cookieDomains: ['grok.com', 'accounts.x.ai'], extraHostPatterns: ['https://accounts.x.ai/*'], switchable: true, signInUrl: 'https://grok.com/', homeUrl: 'https://grok.com/' },
    x: { id: 'x', label: 'X', providers: ['grok_x', 'grok_bot'], cookieDomains: ['x.com', 'twitter.com'], extraHostPatterns: [], switchable: true, signInUrl: 'https://x.com/i/flow/login', homeUrl: 'https://x.com/i/grok' },
    cursor: { id: 'cursor', label: 'Cursor', providers: ['cursor_agents'], cookieDomains: ['cursor.com', 'authenticator.cursor.sh'], extraHostPatterns: ['https://authenticator.cursor.sh/*'], switchable: true, signInUrl: 'https://cursor.com/agents', homeUrl: 'https://cursor.com/agents' },
    meta: { id: 'meta', label: 'Meta AI', providers: ['muse', 'meta_ai'], cookieDomains: ['muse.ai', 'meta.ai'], extraHostPatterns: [], switchable: true, signInUrl: 'https://muse.ai/', homeUrl: 'https://muse.ai/' },
  };
  const STAMP = '2026-01-05T09:00:00.000Z';
  const acct = (id, realm, label, color, primary, email, order, signedIn) => ({
    id, realm, label, color, mode: 'embedded', primary,
    identity: email ? { key: 'demo-' + id, display: email, detail: null, observedAt: STAMP, source: 'dom' } : null,
    signedIn, hasJar: !primary, order, createdAt: STAMP, lastActiveAt: primary ? STAMP : null,
  });
  const accounts = [
    acct('primary~anthropic', 'anthropic', 'Personal', 'sage', true, 'andrew@example.com', 0, 'yes'),
    acct('acct_demowork01', 'anthropic', 'Work', 'peach', false, 'andrew@work.example.com', 1, 'unknown'),
    acct('primary~openai', 'openai', 'Personal', 'blue', true, 'andrew@example.com', 0, 'yes'),
    acct('acct_demowork02', 'openai', 'Work', 'teal', false, 'andrew@work.example.com', 1, 'unknown'),
    acct('primary~xai', 'xai', 'Personal', 'sage', true, 'andrew@example.com', 0, 'yes'),
    acct('primary~x', 'x', 'Personal', 'violet', true, 'andrew@example.com', 0, 'yes'),
    acct('primary~cursor', 'cursor', 'Personal', 'gold', true, 'andrew@example.com', 0, 'yes'),
    acct('primary~meta', 'meta', 'Personal', 'blue', true, 'andrew@example.com', 0, 'yes'),
  ];
  const activeByRealm = { anthropic: 'primary~anthropic', openai: 'primary~openai', xai: 'primary~xai', x: 'primary~x', cursor: 'primary~cursor', meta: 'primary~meta' };
  const clone = (v) => JSON.parse(JSON.stringify(v));
  const realmsAnswer = () => Object.values(REALMS).map((realm) => ({
    realm: clone(realm),
    accounts: clone(accounts.filter((a) => a.realm === realm.id).sort((a, b) => a.order - b.order)),
    activeAccountId: activeByRealm[realm.id] || null,
  }));
  const fail = (error, code) => ({ ok: false, error, ...(code ? { code } : {}) });
  const COLORS = ['teal', 'peach', 'violet', 'sage', 'blue', 'gold'];
  const workspaceAnswers = {
    WORKSPACE_HELLO: () => ({ ok: true, tabId: 1, embedding: true, realms: realmsAnswer() }),
    ACCOUNTS_LIST: () => ({ ok: true, realms: realmsAnswer() }),
    ACCOUNTS_ACTIVATE: (m) => {
      const account = accounts.find((a) => a.id === m.accountId);
      if (!account) return fail('That account does not exist.', 'unknown_account');
      const switched = activeByRealm[account.realm] !== account.id;
      activeByRealm[account.realm] = account.id;
      account.signedIn = 'yes';
      account.lastActiveAt = new Date().toISOString();
      const result = { ok: true, account: clone(account), realms: realmsAnswer(), switched };
      // Delivered after the answer, the way the service worker broadcasts to every page.
      setTimeout(() => window.__tkPreviewBroadcast({ type: 'ACCOUNTS_CHANGED', realm: account.realm, activeAccountId: account.id, switched }), 0);
      return result;
    },
    ACCOUNTS_ADD: (m) => {
      if (!REALMS[m.realm]) return fail('That sign-in is not one ThreadStack switches.', 'not_switchable');
      const inRealm = accounts.filter((a) => a.realm === m.realm);
      const used = new Set(inRealm.map((a) => a.color));
      const account = {
        id: 'acct_demo' + Math.random().toString(16).slice(2, 10), realm: m.realm,
        label: (m.label || '').trim() || 'Account ' + (inRealm.length + 1),
        color: m.color || COLORS.find((c) => !used.has(c)) || COLORS[0],
        mode: m.mode === 'isolated' ? 'isolated' : 'embedded', ...(m.profileId ? { profileId: m.profileId } : {}),
        primary: false, identity: null, signedIn: 'unknown', hasJar: false,
        order: inRealm.length, createdAt: new Date().toISOString(), lastActiveAt: null,
      };
      accounts.push(account);
      return { ok: true, account: clone(account), realms: realmsAnswer(), switched: false };
    },
    ACCOUNTS_UPDATE: (m) => {
      const account = accounts.find((a) => a.id === m.accountId);
      if (!account) return fail('That account does not exist.', 'unknown_account');
      if (typeof m.label === 'string' && m.label.trim()) account.label = m.label.trim();
      if (COLORS.includes(m.color)) account.color = m.color;
      return { ok: true, account: clone(account), realms: realmsAnswer(), switched: false };
    },
    ACCOUNTS_REMOVE: (m) => {
      const index = accounts.findIndex((a) => a.id === m.accountId);
      if (index === -1) return fail('That account does not exist.', 'unknown_account');
      if (accounts[index].primary) return fail('The browser’s own sign-in cannot be removed.', 'not_allowed');
      const [gone] = accounts.splice(index, 1);
      if (activeByRealm[gone.realm] === gone.id) {
        const primary = accounts.find((a) => a.realm === gone.realm && a.primary);
        activeByRealm[gone.realm] = primary ? primary.id : null;
      }
      return { ok: true, account: null, realms: realmsAnswer(), switched: false };
    },
    HELPER_PING: () => fail('The Mac helper is not available in the preview.', 'helper_unavailable'),
  };
  window.chrome = {
    runtime: {
      id: 'tkpreview',
      lastError: undefined,
      getURL: (p) => location.origin + '/' + String(p || '').replace(/^\\//, ''),
      getManifest: () => manifest,
      reload() {},
      async sendMessage(message) {
        const type = message && message.type;
        if (type && typeof answers[type] === 'function') return answers[type](message);
        if (type && Object.prototype.hasOwnProperty.call(workspaceAnswers, type)) return workspaceAnswers[type](message);
        if (type === 'GET_DIAGNOSTICS') return { ok: true, recentEvents: [] };
        // Anything else has no service worker behind it: answer the way an unreachable or
        // refusing worker does, so the page takes its own "not available" path.
        return { ok: false, error: 'Not available in the preview.' };
      },
      onMessage: {
        addListener: (fn) => listeners.add(fn),
        removeListener: (fn) => listeners.delete(fn),
        hasListener: (fn) => listeners.has(fn),
      },
      onMessageExternal: event(),
    },
    storage: { local: store('local'), session: store('session'), onChanged: event() },
    tabs: {
      async query() { return []; },
      async getCurrent() { return { id: 1 }; },
      async create({ url }) { window.open(url, '_blank', 'noopener'); return {}; },
      async update() { return {}; },
      async sendMessage() { return undefined; },
      onUpdated: event(), onActivated: event(), onRemoved: event(),
    },
    windows: { async update() { return {}; } },
    permissions: {
      async contains() { return true; },
      async request() { return true; },
      async remove() { return true; },
      onAdded: event(), onRemoved: event(),
    },
    scripting: {
      async registerContentScripts() {},
      async unregisterContentScripts() {},
      async getRegisteredContentScripts() { return []; },
    },
  };
  /** Lets a fixture push a broadcast (for example LIBRARY_CHANGED) into the page. */
  window.__tkPreviewBroadcast = (message) => { for (const fn of listeners) fn(message, { id: 'tkpreview' }, () => {}); };
})();`;
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://127.0.0.1:${port}`);
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/manager.html';
  if (rel === '/__chrome-stub.js') {
    res.writeHead(200, { 'content-type': TYPES['.js'], 'cache-control': 'no-store' });
    res.end(chromeStub());
    return;
  }
  // Review material that is not part of the extension: design prototypes under
  // .output/design and screenshots under evidence/, so they can be opened in the same browser.
  const side = [
    ['/__design/', path.resolve(dist, '..', 'design')],
    ['/__evidence/', path.resolve(dist, '..', '..', 'evidence')],
  ].find(([prefix]) => rel.startsWith(prefix));
  const base = side ? side[1] : dist;
  const file = path.normalize(path.join(base, side ? rel.slice(side[0].length) : rel));
  if (!file.startsWith(base + path.sep) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
    return;
  }
  const ext = path.extname(file);
  let body = fs.readFileSync(file);
  if (ext === '.html' && !side) {
    // The stub must exist before the page's module script runs.
    body = Buffer.from(
      body.toString('utf8').replace(/<head>/i, '<head>\n    <script src="/__chrome-stub.js"></script>')
    );
  }
  res.writeHead(200, { 'content-type': TYPES[ext] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(body);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`ThreadStack preview: http://127.0.0.1:${port}/manager.html?surface=page&seed=1`);
});
