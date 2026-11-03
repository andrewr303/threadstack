// End-to-end check of the packaged extension in Chromium:
//   1. Edge compatibility: the overlay loads from a static-ID chrome-extension:// URL, and the
//      watchdog swaps a blocked overlay for the full-page library.
//   2. Automatic capture + organization across Claude, ChatGPT (Project), Grok and Gemini pages.
//   3. Claude analysis, Auto-organize, Ask (streaming) and citations against a mocked Anthropic API.
//   4. Side panel layout without horizontal overflow.
// Screenshots are written to evidence/organizer/. Requires `npm run build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, '.output', 'chrome-mv3');
const out = path.join(root, 'evidence', 'organizer');
const executablePath = process.env.CHROME_EXECUTABLE_PATH || undefined;
fs.mkdirSync(out, { recursive: true });

const log = (...a) => console.log('[organizer-e2e]', ...a);
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log(`ok — ${message}`);
}

const PAGES = {
  'https://claude.ai/chat/0f9c2d1e-1111-4a2b-9c3d-000000000001': `<html><head><title>Stripe webhook retries - Claude</title></head><body><main>
    <header><a href="/project/abc">Payments Platform</a></header>
    <div data-testid="user-message">Customers get charged twice when Stripe retries our webhook. How do I make the handler idempotent?</div>
    <div class="font-claude-response"><p>Store each processed event id and skip duplicates. In <code>webhooks.ts</code>:</p><pre><code class="language-ts">if (await seen(event.id)) return;</code></pre><p>Next steps:</p><ul><li>Add a processed_events table with a unique index</li><li>Write a test that replays the same event twice</li></ul></div>
    <div data-testid="user-message">Let's go with the processed_events table. I'll write the replay test tomorrow.</div>
    <div class="font-claude-response"><p>Sounds good. Would you like me to draft the migration for processed_events?</p></div>
  </main></body></html>`,
  'https://chatgpt.com/g/g-p-6a7b8c9d0e-hypestake-growth/c/68aa0000-0000-0000-0000-000000000002': `<html><head><title>Sportsbook landing page copy - ChatGPT</title></head><body>
    <div data-message-author-role="user" data-message-id="u1"><div class="whitespace-pre-wrap">Write a hero headline for the HypeStake landing page aimed at sportsbook operators.</div></div>
    <div data-message-author-role="assistant" data-message-id="a1" data-message-model-slug="gpt-5"><div class="markdown"><p>"Price every market faster than the line moves." Three alternatives follow.</p></div></div>
  </body></html>`,
  'https://grok.com/c/7d1e0000-grok-0000-0000-000000000003': `<html><head><title>Kubernetes ingress 504s - Grok</title></head><body>
    <div id="response-1" class="flex items-end"><div class="message-bubble">Our kubernetes nginx ingress returns 504 gateway timeouts under load. What should I tune?</div></div>
    <div id="response-2" class="flex items-start"><div class="message-bubble">Raise proxy-read-timeout and check upstream keepalive settings on the ingress controller.</div></div>
  </body></html>`,
  'https://gemini.google.com/app/9e9e0000gem': `<html><head><title>Gemini</title></head><body>
    <user-query><div class="query-text">Plan a 3 day trip to Lisbon in March with food recommendations</div></user-query>
    <model-response><message-content><p>Day 1: Alfama and a fado dinner. Day 2: Belém pastries. Day 3: LX Factory.</p></message-content></model-response>
  </body></html>`,
};

function analysisFor(body) {
  const transcript = body.messages[0].content;
  const isPayments = /Stripe/.test(transcript);
  const isK8s = /kubernetes/i.test(transcript);
  const isTrip = /Lisbon/.test(transcript);
  return {
    title: isPayments
      ? 'Idempotent Stripe webhook handler (processed_events table)'
      : isK8s
        ? 'Fixing nginx ingress 504 timeouts on Kubernetes'
        : isTrip
          ? 'Lisbon 3-day March itinerary with food stops'
          : 'HypeStake hero headline for sportsbook operators',
    gist: isPayments
      ? 'Chose a processed_events table to dedupe Stripe retries; replay test and migration still to do.'
      : isK8s
        ? 'Tuning proxy-read-timeout and upstream keepalive to stop 504s under load.'
        : isTrip
          ? 'Day-by-day Lisbon plan: Alfama + fado, Belém pastries, LX Factory.'
          : 'Drafted landing-page hero headlines for HypeStake aimed at sportsbook operators.',
    summary: 'Produced by the mocked Claude endpoint used in this end-to-end check.',
    userGoal: isPayments ? 'Stop double charges from webhook retries' : null,
    outcome: null,
    kind: isPayments || isK8s ? 'debugging' : isTrip ? 'personal' : 'writing',
    topics: isPayments ? ['stripe', 'webhooks', 'idempotency'] : isK8s ? ['kubernetes', 'nginx-ingress'] : isTrip ? ['travel', 'lisbon'] : ['copywriting'],
    entities: isPayments ? ['Stripe', 'processed_events'] : [],
    project: isPayments
      ? { name: 'Payments', isNew: true, confidence: 0.9, reason: 'Payments engineering workstream' }
      : isK8s
        ? { name: 'Infrastructure', isNew: true, confidence: 0.82, reason: 'Platform and infrastructure work' }
        : isTrip
          ? { name: 'Personal', isNew: false, confidence: 0.9, reason: 'Travel planning' }
          : { name: 'HypeStake', isNew: false, confidence: 0.95, reason: 'HypeStake marketing' },
    status: isPayments ? 'needs_review' : 'active',
    statusReason: isPayments ? 'Claude offered to draft the migration' : 'In progress',
    whereYouLeftOff: {
      text: isPayments ? 'Decide whether Claude should draft the processed_events migration, then write the replay test.' : 'Continue from the latest answer.',
      messageNumber: 2,
      quote: isPayments ? 'Store each processed event id' : 'placeholder quote text',
    },
    decisions: isPayments ? [{ text: 'Use a processed_events table to dedupe events', messageNumber: 3, quote: "Let's go with the processed_events table", by: 'user' }] : [],
    actionItems: isPayments ? [{ text: 'Write a replay test for duplicate events', messageNumber: 3, quote: "I'll write the replay test tomorrow", by: 'user' }] : [],
    openQuestions: isPayments ? [{ text: 'Should Claude draft the migration?', messageNumber: 4, quote: 'Would you like me to draft the migration', by: 'assistant' }] : [],
    artifacts: isPayments ? [{ label: 'webhooks.ts', kind: 'code', messageNumber: 2 }] : [],
  };
}

const anthropicCalls = [];
async function routeAnthropic(route) {
  const req = route.request();
  const body = JSON.parse(req.postData() ?? '{}');
  const sys = Array.isArray(body.system) ? body.system.map((b) => b.text).join('\n') : String(body.system ?? '');
  const kind = /organize one person/.test(sys) ? 'analysis' : /reorganize/.test(sys) ? 'plan' : /answer questions/.test(sys) ? 'ask' : 'other';
  anthropicCalls.push({ kind, headers: req.headers(), body });
  const message = (text) => ({
    id: 'msg_e2e',
    type: 'message',
    role: 'assistant',
    model: body.model,
    content: [{ type: 'text', text }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: { input_tokens: 900, output_tokens: 200 },
  });
  if (body.stream) {
    const text = 'You chose a processed_events table to dedupe Stripe webhook retries [T1]. The replay test is still open [T1].';
    const events = [
      { type: 'message_start', message: { ...message(''), content: [], stop_reason: null } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      ...text.match(/.{1,24}/g).map((c) => ({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: c } })),
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } },
      { type: 'message_stop' },
    ];
    return route.fulfill({
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'access-control-allow-origin': '*' },
      body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    });
  }
  const payload =
    kind === 'analysis' ? analysisFor(body) : kind === 'plan' ? { newProjects: [], changes: [], excluded: [] } : 'ready';
  return route.fulfill({
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
    body: JSON.stringify(message(typeof payload === 'string' ? payload : JSON.stringify(payload))),
  });
}

async function launch(extensionDir) {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-e2e-')), {
    executablePath,
    headless: true,
    viewport: { width: 1440, height: 900 },
    args: ['--headless=new', `--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  for (const url of Object.keys(PAGES)) {
    await context.route(`${new URL(url).origin}/**`, (r) =>
      r.fulfill({ status: 200, contentType: 'text/html', body: PAGES[r.request().url().split('?')[0]] ?? '<html><body></body></html>' })
    );
  }
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return { context, sw, extId: new URL(sw.url()).host };
}

/** Copy of the build whose content script uses the static-ID URL, like Edge's runtime.getURL(). */
function edgeVariant(legacyDynamicUrl) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tk-edge-${legacyDynamicUrl ? 'legacy' : 'fixed'}-`));
  fs.cpSync(dist, dir, { recursive: true });
  const csPath = path.join(dir, 'content-scripts', 'content.js');
  const cs = fs.readFileSync(csPath, 'utf8');
  const patched = cs.replace(
    'const extUrl = chrome.runtime.getURL(',
    'const extUrl = ((p) => `chrome-extension://${chrome.runtime.id}/${p}`)('
  );
  if (patched === cs) throw new Error('Could not patch content script for the Edge emulation');
  fs.writeFileSync(csPath, patched);
  if (legacyDynamicUrl) {
    const manifestPath = path.join(dir, 'manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    manifest.web_accessible_resources[0].use_dynamic_url = true;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  }
  return dir;
}

async function invokeOverlay(sw, urlPart) {
  await sw.evaluate(async (part) => {
    const tab = (await chrome.tabs.query({})).find((t) => t.url?.includes(part));
    return globalThis.__threadkeeperInvokeAction(tab.id, tab.url, 'toolbar_action');
  }, urlPart);
}

async function edgeChecks() {
  const claudeUrl = Object.keys(PAGES)[0];
  {
    const { context, sw } = await launch(edgeVariant(false));
    const page = await context.newPage();
    await page.goto(claudeUrl);
    await page.waitForTimeout(1500);
    await invokeOverlay(sw, 'claude.ai/chat');
    const src = await page.locator('#threadkeeper-overlay-iframe').getAttribute('src');
    check(/^chrome-extension:\/\/[a-p]{32}\/manager\.html/.test(src ?? ''), 'Edge-style static-ID overlay URL is used');
    await page.frameLocator('#threadkeeper-overlay-iframe').locator('#tk-main-list .tk-row-btn').first().waitFor({ timeout: 8000 });
    check(true, 'overlay loads and authenticates from the static-ID URL (the reported ERR_BLOCKED_BY_CLIENT is fixed)');
    await page.screenshot({ path: path.join(out, 'edge-static-url-overlay.png') });
    await context.close();
  }
  {
    const { context, sw } = await launch(edgeVariant(true));
    const page = await context.newPage();
    await page.goto(claudeUrl);
    await page.waitForTimeout(1500);
    const tabsBefore = await sw.evaluate(async () => (await chrome.tabs.query({})).length);
    await invokeOverlay(sw, 'claude.ai/chat');
    await page.locator('#threadkeeper-overlay-root').waitFor({ state: 'detached', timeout: 9000 });
    await page.waitForTimeout(500);
    // The fallback must be the background's OPEN_MANAGER_FALLBACK handler opening one new tab. That tab
    // is itself blocked (empty URL) only because this variant re-adds the legacy manifest flag.
    const fallback = await sw.evaluate(async () => ({
      log: globalThis.__threadkeeperGetSecurityRejections().map((r) => r.reason),
      tabs: (await chrome.tabs.query({})).length,
    }));
    const fallbackLogged = fallback.log.some((r) => /Overlay frame did not load .* opened full-page manager/.test(r));
    const oneNewTab = fallback.tabs === tabsBefore + 1;
    check(
      fallbackLogged && oneNewTab,
      `watchdog removes a blocked overlay and opens the full-page library instead (logged=${fallbackLogged}, newTabs=${fallback.tabs - tabsBefore})`
    );
    await context.close();
  }
}

async function organizerChecks() {
  const { context, sw, extId } = await launch(dist);
  await context.route('https://api.anthropic.com/**', routeAnthropic);
  const errors = [];

  for (const url of Object.keys(PAGES)) {
    const p = await context.newPage();
    p.on('pageerror', (e) => errors.push(`${url}: ${e.message}`));
    await p.goto(url);
    await p.waitForTimeout(1800);
    await p.close();
  }
  const captured = await sw.evaluate(async () =>
    (await globalThis.__threadkeeperDb.conversations.toArray()).map((c) => ({
      provider: c.provider,
      project: c.project,
      source: c.projectSource,
      model: c.modelSlug,
    }))
  );
  check(captured.length === 4, `captured 4 conversations automatically (${captured.map((c) => c.provider).join(', ')})`);
  check(captured.some((c) => c.provider === 'chatgpt' && c.project === 'HypeStake' && c.source === 'provider' && c.model === 'gpt-5'),
    'ChatGPT Project "hypestake-growth" auto-filed into the existing HypeStake project');
  check(captured.some((c) => c.provider === 'claude' && c.project === 'Payments Platform'), 'Claude Project became a project automatically');

  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`manager: ${e.message}`));
  await page.goto(`chrome-extension://${extId}/manager.html?surface=page`);
  await page.locator('#tk-main-list .tk-row-btn').first().waitFor({ timeout: 8000 });
  await page.waitForTimeout(600);
  const kinds = await page.locator('#tk-main-list .tk-kind').count();
  const localGists = await page.locator('#tk-main-list .tk-row-gist').count();
  // A gist identical to the (message-derived) title is not repeated, so Gemini's row shows none yet.
  check(kinds === 4 && localGists >= 3, `on-device analysis labels every row before any API key is set (${kinds} kinds, ${localGists} gists)`);
  await page.screenshot({ path: path.join(out, '01-library-on-device.png') });

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.locator('dialog#tk-settings-dialog nav button', { hasText: 'AI models' }).click();
  await page.locator('input[aria-label="Anthropic API key"]').fill('sk-ant-e2e-test-key');
  await page.locator('dialog#tk-settings-dialog button', { hasText: 'Test' }).first().click();
  await page.locator('dialog#tk-settings-dialog .tk-settings-result', { hasText: 'Connected' }).waitFor({ timeout: 8000 });
  check(true, 'Settings → Test reaches the Anthropic API');
  await page.screenshot({ path: path.join(out, '02-settings.png') });
  await page.locator('dialog#tk-settings-dialog button', { hasText: 'Done' }).click();

  await page.getByRole('button', { name: 'Auto-organize', exact: true }).click();
  await page.locator('dialog#tk-organize-dialog[open]').waitFor();
  await page.waitForFunction(() => document.querySelectorAll('.tk-ai-mark').length >= 4, null, { timeout: 30000 });
  await page.screenshot({ path: path.join(out, '03-auto-organize.png') });
  await page.locator('dialog#tk-organize-dialog button', { hasText: 'Cancel' }).click();
  const analysisCall = anthropicCalls.find((c) => c.kind === 'analysis');
  check(anthropicCalls.filter((c) => c.kind === 'analysis').length === 4, 'Claude analyzed all 4 threads');
  check(analysisCall.headers['anthropic-beta']?.includes('server-side-fallback-2026-07-01') && analysisCall.body.fallbacks === 'default',
    'analysis requests opt into the server-side refusal fallback');
  check(analysisCall.body.output_config?.format?.type === 'json_schema', 'analysis uses structured outputs');

  const nav = await page.locator('.tk-nav').innerText();
  check(/Infrastructure/.test(nav), 'Claude created a new "Infrastructure" project for the Kubernetes thread');
  await page.locator('#tk-main-list .tk-row-btn', { hasText: 'Stripe' }).first().click();
  await page.waitForTimeout(400);
  const overview = await page.locator('.tk-overview').innerText();
  check(/Analyzed by Claude Opus 5\.5/.test(overview) && /processed_events/.test(overview), 'detail pane shows the Claude overview');
  check(/Payments Platform/.test(await page.locator('.tk-overview').innerText()), 'provider project outranks the weaker AI suggestion');
  await page.screenshot({ path: path.join(out, '04-thread-detail.png') });

  await page.locator('.tk-segmented button', { hasText: 'Ask' }).click();
  await page.locator('textarea[aria-label="Ask a question about your past AI conversations"]').fill('What did I decide about Stripe webhook retries?');
  await page.getByRole('button', { name: 'Ask Claude', exact: true }).click();
  await page.locator('.tk-ask-answer .tk-cite').first().waitFor({ timeout: 10000 });
  await page.screenshot({ path: path.join(out, '05-ask.png') });
  await page.locator('.tk-ask-answer .tk-cite').first().click();
  await page.waitForTimeout(300);
  check(/Stripe/.test(await page.locator('.tk-detail-title').innerText()), 'Ask answers with citations that open the cited thread');

  const side = await context.newPage();
  await side.setViewportSize({ width: 420, height: 860 });
  side.on('pageerror', (e) => errors.push(`sidepanel: ${e.message}`));
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await side.locator('#tk-main-list .tk-row-btn').first().waitFor({ timeout: 8000 });
  const overflow = await side.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check(overflow === 0, 'side panel at 420px has no horizontal overflow');
  await side.screenshot({ path: path.join(out, '06-side-panel.png') });

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  await context.close();
}

if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  throw new Error('Build the extension first: npm run build');
}
await edgeChecks();
await organizerChecks();
log(`passed — screenshots in ${path.relative(root, out)}`);
