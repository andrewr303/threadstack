// End-to-end check of ChatGPT capture and Catch up in the packaged extension, against a mock
// ChatGPT / Claude served by the test (no network, no account):
//   1. The page-world observer reads the conversation JSON the page loads, so a conversation whose
//      DOM shows only its last two messages is still stored complete (4 messages, coverage full).
//   2. A later DOM capture of the same conversation neither drops nor duplicates messages.
//   3. Catch up lists the recent conversations, skips the one already stored and unchanged, reads
//      the others, ignores one outside the window, and reports a signed-out Claude in plain words.
//   4. The catch-up brief renders, and its links open the thread.
//   5. Settings → Diagnostics → "Check capture" gives a verdict for the open AI tab.
//   6. The Catch up UI has no horizontal overflow at 420 px, and the page raises no errors.
// Screenshots are written to evidence/catchup/. Requires `npm run build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, '.output', 'chrome-mv3');
const out = path.join(root, 'evidence', 'catchup');
const executablePath = process.env.CHROME_EXECUTABLE_PATH || undefined;
fs.mkdirSync(out, { recursive: true });

const log = (...a) => console.log('[catchup-e2e]', ...a);
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log(`ok — ${message}`);
}

const DAY = 86_400_000;
// Whole seconds, so a time survives the round trip through epoch seconds exactly.
const secs = (daysAgo) => Math.floor((Date.now() - daysAgo * DAY) / 1000);
const iso = (daysAgo) => new Date(secs(daysAgo) * 1000).toISOString();
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

/** A conversation in ChatGPT's own JSON: four messages on the active path, one abandoned branch. */
function conversationJson(n, daysAgo, title) {
  const m = (id, role, text, t) => ({
    id,
    author: { role },
    create_time: t,
    recipient: 'all',
    content: { content_type: 'text', parts: [text] },
    metadata: role === 'assistant' ? { model_slug: 'gpt-5' } : {},
  });
  const t0 = secs(daysAgo + 1);
  return {
    conversation_id: uuid(n),
    title,
    create_time: t0,
    update_time: secs(daysAgo),
    current_node: `a2-${n}`,
    default_model_slug: 'gpt-5',
    mapping: {
      root: { id: 'root', parent: null, children: [`u1-${n}`], message: null },
      [`u1-${n}`]: { id: `u1-${n}`, parent: 'root', children: [`a1-${n}`], message: m(`u1-${n}`, 'user', `Opening question ${n}: how should we handle ${title}?`, t0) },
      [`a1-${n}`]: { id: `a1-${n}`, parent: `u1-${n}`, children: [`u2-${n}`, `old-${n}`], message: m(`a1-${n}`, 'assistant', `First answer ${n}: start with a written checklist.`, t0 + 5) },
      [`old-${n}`]: { id: `old-${n}`, parent: `a1-${n}`, children: [], message: m(`old-${n}`, 'user', 'An abandoned edit that must not appear', t0 + 6) },
      [`u2-${n}`]: { id: `u2-${n}`, parent: `a1-${n}`, children: [`a2-${n}`], message: m(`u2-${n}`, 'user', `Follow-up ${n}: list the owners and next steps.`, t0 + 10) },
      [`a2-${n}`]: { id: `a2-${n}`, parent: `u2-${n}`, children: [], message: m(`a2-${n}`, 'assistant', `Final answer ${n}: owners are assigned and the next step is review on Friday.`, t0 + 15) },
    },
  };
}

const CONVERSATIONS = [
  { n: 1, daysAgo: 2, title: 'Stripe webhook retries' },
  { n: 2, daysAgo: 10, title: 'Quarterly launch plan' },
  { n: 3, daysAgo: 20, title: 'Hiring scorecard' },
  { n: 4, daysAgo: 60, title: 'Old pricing experiment' },
];
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

/** The ChatGPT page for conversation 1: it loads the JSON like the real app, but renders only the last two turns. */
function chatPage(c) {
  const doc = conversationJson(c.n, c.daysAgo, c.title);
  return `<html><head><title>${c.title}</title></head><body><main id="thread"></main>
    <script>
      fetch('/backend-api/conversation/${uuid(c.n)}', { headers: { Authorization: 'Bearer page-token' } })
        .then((r) => r.json())
        .then((d) => {
          const nodes = ['u2-${c.n}', 'a2-${c.n}'].map((id) => d.mapping[id].message);
          document.getElementById('thread').innerHTML = nodes.map((m) =>
            '<article data-testid="conversation-turn"><div data-message-author-role="' + m.author.role + '" data-message-id="' + m.id + '"' +
            (m.author.role === 'assistant' ? ' data-message-model-slug="gpt-5"' : '') + '><div class="' +
            (m.author.role === 'assistant' ? 'markdown' : 'whitespace-pre-wrap') + '">' + m.content.parts[0] + '</div></div></article>').join('');
        });
    </script></body></html>`;
}

async function launch() {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-catchup-')), {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: ['--headless=new', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  const requests = [];
  await context.route('https://chatgpt.com/**', (r) => {
    const url = new URL(r.request().url());
    requests.push(`${r.request().method()} ${url.pathname}`);
    if (url.pathname === '/api/auth/session') return r.fulfill(json({ accessToken: 'mock-token' }));
    if (url.pathname === '/backend-api/conversations') {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const items = CONVERSATIONS.slice(offset, offset + 28).map((c) => ({ id: uuid(c.n), title: c.title, create_time: iso(c.daysAgo + 1), update_time: iso(c.daysAgo) }));
      return r.fulfill(json({ items, total: CONVERSATIONS.length, limit: 28, offset }));
    }
    const detail = url.pathname.match(/^\/backend-api\/conversation\/([0-9a-f-]{36})$/);
    if (detail) {
      const c = CONVERSATIONS.find((x) => uuid(x.n) === detail[1]);
      return c ? r.fulfill(json(conversationJson(c.n, c.daysAgo, c.title))) : r.fulfill(json({}, 404));
    }
    const chat = url.pathname.match(/^\/c\/([0-9a-f-]{36})$/);
    if (chat) {
      const c = CONVERSATIONS.find((x) => uuid(x.n) === chat[1]);
      return r.fulfill({ status: 200, contentType: 'text/html', body: c ? chatPage(c) : '<html><body></body></html>' });
    }
    return r.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><title>ChatGPT</title></head><body>Home</body></html>' });
  });
  // Claude: a signed-out visitor. The sync must say so rather than hang.
  await context.route('https://claude.ai/**', (r) => {
    const url = new URL(r.request().url());
    if (url.pathname.startsWith('/api/')) return r.fulfill(json({ error: 'unauthorized' }, 401));
    return r.fulfill({ status: 200, contentType: 'text/html', body: '<html><head><title>Claude</title></head><body>Sign in</body></html>' });
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return { context, sw, extId: new URL(sw.url()).host, requests };
}

const storedThreads = (sw) =>
  sw.evaluate(async () =>
    (await globalThis.__threadkeeperDb.conversations.toArray()).map((c) => ({
      id: c.sourceConversationId,
      title: c.title,
      count: c.messageCount,
      coverage: c.coverage,
      source: c.captureSource,
      updatedAt: c.updatedAt,
    }))
  );

async function run() {
  const { context, sw, extId, requests } = await launch();
  const errors = [];

  // 1 + 2. Capture: the DOM shows two messages; the page's own data holds all four.
  const chat = await context.newPage();
  chat.on('pageerror', (e) => errors.push(`chat: ${e.message}`));
  await chat.goto(`https://chatgpt.com/c/${uuid(1)}`);
  await chat.waitForFunction(() => document.querySelectorAll('[data-message-author-role]').length === 2);
  await chat.waitForTimeout(2500);
  let rows = await storedThreads(sw);
  const first = rows.find((r) => r.id === uuid(1));
  check(first?.count === 4 && first.coverage === 'full' && first.source === 'network_observer', `a conversation whose page shows 2 messages is stored complete from the site's own data (${first?.count} messages, ${first?.coverage}, ${first?.source})`);
  const messages = await sw.evaluate(async (id) => {
    const db = globalThis.__threadkeeperDb;
    const c = (await db.conversations.toArray()).find((x) => x.sourceConversationId === id);
    return (await db.messages.where('threadKey').equals(c.threadKey).sortBy('ordinal')).map((m) => m.content);
  }, uuid(1));
  check(!messages.some((t) => /abandoned edit/.test(t)) && /Opening question 1/.test(messages[0]), 'only the active branch is stored, in order');

  await chat.evaluate(() => document.body.appendChild(document.createElement('div'))); // provoke a DOM capture
  await chat.waitForTimeout(2500);
  rows = await storedThreads(sw);
  const afterDom = rows.find((r) => r.id === uuid(1));
  check(afterDom.count === 4 && afterDom.coverage === 'full' && afterDom.source === 'network_observer', 'a later DOM capture neither drops nor duplicates messages and keeps the complete copy');

  // 5. Capture check from the library.
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`manager: ${e.message}`));
  await page.goto(`chrome-extension://${extId}/manager.html?surface=page`);
  await page.locator('#tk-main-list .tk-row-btn').first().waitFor({ timeout: 8000 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('dialog#tk-settings-dialog nav button', { hasText: 'Diagnostics' }).click();
  await page.getByRole('button', { name: 'Check capture in my AI tab' }).click();
  await page.locator('.tk-diag-capture .tk-diag-status', { hasText: 'Capture is working' }).waitFor({ timeout: 8000 });
  const report = await page.locator('.tk-diag-capture').innerText();
  check(/4 messages\) is being read/.test(report) || /\(4 messages\)/.test(report), 'Check capture reports the complete conversation data for the open tab');
  check(!/Opening question|Stripe webhook/.test(report), 'the capture report holds no titles or message text');
  await page.screenshot({ path: path.join(out, '01-capture-check.png') });
  await page.locator('dialog#tk-settings-dialog button', { hasText: 'Done' }).click();

  // 3. Catch up.
  await page.getByRole('button', { name: 'Import / Export', exact: true }).click();
  const section = page.locator('section[aria-labelledby="tk-catchup-h"]');
  await section.waitFor();
  await page.screenshot({ path: path.join(out, '02-catchup-idle.png') });
  const tabsBefore = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
  await section.getByRole('button', { name: 'Catch up', exact: true }).click();
  const chatgptRow = section.locator('.tk-sync-list li', { hasText: 'ChatGPT' });
  await chatgptRow.locator('.tk-sync-status', { hasText: /^Done/ }).waitFor({ timeout: 20000 });
  const claudeRow = section.locator('.tk-sync-list li', { hasText: 'Claude' });
  await claudeRow.locator('.tk-sync-status', { hasText: /Sign in to Claude/ }).waitFor({ timeout: 20000 });
  await page.screenshot({ path: path.join(out, '03-catchup-done.png') });
  const status = await chatgptRow.locator('.tk-sync-status').innerText();
  check(/2 imported, 1 already up to date/.test(status), `ChatGPT: "${status}" (3 in the window, 1 unchanged, the 60-day-old one left out)`);
  check(/Sign in to Claude/.test(await claudeRow.locator('.tk-sync-status').innerText()), 'a signed-out Claude is reported in plain words, not as a hang');

  rows = await storedThreads(sw);
  const synced = rows.filter((r) => r.source === 'history_sync');
  check(synced.length === 2 && synced.every((r) => r.count === 4 && r.coverage === 'full'), 'the two new conversations are stored complete with the history_sync source');
  check(!rows.some((r) => r.id === uuid(4)), 'a conversation outside the 30-day window is not imported');
  check(!requests.some((r) => r.endsWith(`/backend-api/conversation/${uuid(4)}`)), 'it was never even fetched');
  check(requests.filter((r) => r === `GET /backend-api/conversation/${uuid(1)}`).length === 1, 'the unchanged conversation was not fetched again (only the page\'s own load)');
  check(requests.every((r) => r.startsWith('GET ') || r.startsWith('OPTIONS ')), 'Catch up only ever sends GET requests');
  const tabsAfter = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
  check(tabsAfter <= tabsBefore, `no tab is left open (${tabsBefore} before, ${tabsAfter} after)`);

  // 4. The brief.
  await section.getByRole('button', { name: 'Write catch-up brief' }).click();
  const brief = section.locator('article[aria-label="Catch-up brief"]');
  await brief.waitFor({ timeout: 10000 });
  const headline = await brief.locator('.tk-brief-h').innerText();
  check(/3 conversations/.test(headline) && /30 days/.test(headline), `the on-device brief counts the recent conversations ("${headline}")`);
  await page.screenshot({ path: path.join(out, '04-catchup-brief.png') });
  await brief.locator('.tk-linklike').first().click();
  await page.locator('.tk-detail-title').waitFor({ timeout: 5000 });
  check(true, 'a thread link in the brief opens that thread');

  // 6. Narrow layout and errors.
  const narrow = await context.newPage();
  await narrow.setViewportSize({ width: 420, height: 860 });
  narrow.on('pageerror', (e) => errors.push(`sidepanel: ${e.message}`));
  await narrow.goto(`chrome-extension://${extId}/sidepanel.html`);
  await narrow.locator('#tk-main-list .tk-row-btn').first().waitFor({ timeout: 8000 });
  await narrow.locator('summary[aria-label="More actions"]').click(); // the side panel keeps these in a menu
  await narrow.getByRole('button', { name: 'Import / Export', exact: true }).click();
  await narrow.locator('section[aria-labelledby="tk-catchup-h"]').waitFor();
  const overflow = await narrow.evaluate(() => {
    const dlg = document.querySelector('dialog#tk-import-export-dialog');
    return Math.max(dlg.scrollWidth - dlg.clientWidth, document.documentElement.scrollWidth - document.documentElement.clientWidth);
  });
  check(overflow <= 0, `Catch up has no horizontal overflow at 420px (${overflow}px)`);
  await narrow.screenshot({ path: path.join(out, '05-catchup-420.png') });

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  await context.close();
}

run().then(
  () => log('passed — screenshots in evidence/catchup'),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
