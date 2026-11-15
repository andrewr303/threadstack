// End-to-end check of the workspace in real Chromium, with the built extension and local
// stand-ins for provider sites served on the providers' real host names (so the extension's own
// host permissions, content scripts, header rules and cookie handling are what is exercised):
//
//   1. A provider page in a normal tab is captured and the site's identity is noted (unchanged).
//   2. The workspace tab registers itself and gets its header rule; a provider page that sends
//      X-Frame-Options and CSP frame-ancestors then loads inside the extension page, signed in.
//   3. Page scripts in the embedded frame can read and write ordinary cookies (the cookie bridge).
//   4. A session opened inside the frame is captured, with its repository and observed run state.
//   5. Adding an account signs nothing out; making it the browser's own sign-in signs the browser
//      out of the first one (device cookies stay), a session captured under the new account is
//      filed under it, and switching back and forth restores each sign-in.
//      (Accounts shown side by side inside the workspace: scripts/run-profiles-e2e.mjs.)
//   6. A provider page framed by some other website is never captured.
//   7. A link the embedded page opens in a new tab is handed back to the workspace.
//
// Nothing here talks to a real provider: every provider host is mapped to 127.0.0.1.
// Requires `npm run build` first. Screenshots go to evidence/workspace/.
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = process.env.TK_E2E_DIST ? path.resolve(process.env.TK_E2E_DIST) : path.join(root, '.output', 'chrome-mv3');
const out = path.join(root, 'evidence', 'workspace');
fs.mkdirSync(out, { recursive: true });

/**
 * The browser to drive: CHROME_EXECUTABLE_PATH when set, else the newest full Chromium that
 * Playwright has already downloaded (the headless shell cannot load extensions, and the build
 * Playwright expects by default may not be the one installed), else Playwright's own default.
 */
function resolveChromium() {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;
  const caches = [path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright'), path.join(os.homedir(), '.cache', 'ms-playwright')];
  const inside = [
    ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
    ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ['chrome-linux', 'chrome'],
  ];
  for (const cache of caches) {
    if (!fs.existsSync(cache)) continue;
    const builds = fs
      .readdirSync(cache)
      .filter((name) => /^chromium-\d+$/.test(name))
      .sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const parts of inside) {
        const candidate = path.join(cache, build, ...parts);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}
const executablePath = resolveChromium();

const log = (...a) => console.log('[workspace-e2e]', ...a);
const results = [];
function check(condition, message, detail) {
  results.push({ ok: Boolean(condition), message });
  if (!condition) throw new Error(`FAILED: ${message}${detail !== undefined ? `\n  observed: ${JSON.stringify(detail)}` : ''}`);
  log(`ok — ${message}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, accept, { timeout = 15_000, every = 150, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  for (;;) {
    last = await read();
    if (accept(last)) return last;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)}`);
    await sleep(every);
  }
}

// ---- Stand-in provider site -------------------------------------------------------------------

const ACCOUNTS = {
  A: { uuid: '11111111-aaaa-4aaa-8aaa-111111111111', email: 'ada@example.com', name: 'Ada Personal' },
  B: { uuid: '22222222-bbbb-4bbb-8bbb-222222222222', email: 'ada@work.example.com', name: 'Ada Work' },
};

function parseCookies(header) {
  const jar = {};
  for (const part of (header || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i)] = part.slice(i + 1);
  }
  return jar;
}

/** Headers a real provider sends to refuse framing; the workspace's rule must remove them. */
const REFUSE_FRAMING = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

function sessionPage(id, acct) {
  return `<!doctype html><html><head><title>Session ${id} - Claude</title></head><body>
<header>
  <span id="who">Signed in as ${acct}</span>
  <a href="https://github.com/hypestake/hypestake">hypestake/hypestake</a>
  <a href="https://github.com/hypestake/hypestake/pull/482">Pull request #482</a>
  <span data-testid="task-status" data-state="running">running</span>
</header>
<main>
  <div data-testid="user-message">Make the Stripe webhook handler safe to retry for session ${id}. A redelivered invoice.paid credited a wallet twice.</div>
  <div class="font-claude-response"><p>Events are now stored with their id before any side effect runs, so a redelivered invoice.paid cannot credit a wallet twice in session ${id}.</p><p>Next: run the replay test.</p></div>
  <p><a id="next" href="/code/session_${id}next">Open the follow-up session</a></p>
  <p><a id="blank" target="_blank" href="/code/session_${id}blank">Open in a new tab</a></p>
  <pre id="js-cookie"></pre>
</main>
<script>
  // What an app does on load: ask who is signed in, read a cookie from script, set one.
  fetch('/api/account').then((r) => r.json()).catch(() => null);
  function show() { document.getElementById('js-cookie').textContent = document.cookie; }
  show();
  setTimeout(show, 400); setTimeout(show, 1500); setTimeout(show, 3000);
  document.cookie = 'ui_pref=dark-${id}; Path=/; SameSite=Lax';
</script>
</body></html>`;
}

function providerHandler(req, res) {
  const host = (req.headers.host || '').split(':')[0];
  const url = new URL(req.url, `https://${host}`);
  const cookies = parseCookies(req.headers.cookie);
  const acct = cookies.sessionKey;
  const send = (status, headers, body) => {
    res.writeHead(status, { 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const html = (body, headers = {}) => send(200, { 'content-type': 'text/html; charset=utf-8', ...REFUSE_FRAMING, ...headers }, body);
  const json = (value, status = 200) => send(status, { 'content-type': 'application/json' }, JSON.stringify(value));

  if (host === 'other-site.test') {
    // Some unrelated website that frames a provider page.
    return send(200, { 'content-type': 'text/html' }, `<!doctype html><title>Other site</title><iframe id="f" src="https://claude.ai/code/session_framedelsewhere?plain=1" width="800" height="500"></iframe>`);
  }
  if (host !== 'claude.ai') return send(404, { 'content-type': 'text/plain' }, 'not a stand-in host');

  if (url.pathname === '/login') {
    const who = url.searchParams.get('as');
    if (who && ACCOUNTS[who]) {
      return send(302, {
        location: '/code/session_' + (url.searchParams.get('session') || `${who.toLowerCase()}1`),
        'set-cookie': [
          `sessionKey=${who}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`,
          `lastActiveOrg=org-${who}; Path=/; Secure; SameSite=Lax; Max-Age=86400`,
          // A device-level bot-check cookie: not part of anyone's sign-in.
          'cf_clearance=device-1; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=86400',
        ],
      }, '');
    }
    return html(`<!doctype html><title>Sign in - Claude</title><form><input type="email" name="email"><button>Log in</button></form>`);
  }
  if (url.pathname === '/api/account') {
    if (!acct || !ACCOUNTS[acct]) return json({ error: 'unauthorized' }, 401);
    const a = ACCOUNTS[acct];
    return json({ uuid: a.uuid, email_address: a.email, full_name: a.name });
  }
  if (url.pathname === '/echo') return json({ cookies });
  const session = url.pathname.match(/^\/code\/(session_[A-Za-z0-9]+)$/);
  if (session) {
    // ?plain=1 is the "framed by another website" case: there the browser sends no sign-in
    // cookie and no rule removes a framing refusal, so the page is served as it is to anyone.
    if (url.searchParams.get('plain')) {
      return html(sessionPage(session[1].replace(/^session_/, ''), acct ?? 'nobody'), { 'x-frame-options': '', 'content-security-policy': '' });
    }
    if (!acct) return send(302, { location: '/login', ...REFUSE_FRAMING }, '');
    return html(sessionPage(session[1].replace(/^session_/, ''), acct));
  }
  if (url.pathname === '/code' || url.pathname === '/') return acct ? html(`<!doctype html><title>Claude</title><p id="who">Signed in as ${acct}</p>`) : send(302, { location: '/login' }, '');
  return send(404, { 'content-type': 'text/plain' }, 'not found');
}

function startProviderServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-e2e-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  // A throwaway certificate; the browser is started with --ignore-certificate-errors.
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=threadkeeper-e2e'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const headers = res.writeHead.bind(res);
    // Empty header values mean "do not send this header".
    res.writeHead = (status, h = {}) => headers(status, Object.fromEntries(Object.entries(h).filter(([, v]) => v !== '')));
    providerHandler(req, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---- Browser ----------------------------------------------------------------------------------

async function launch(port) {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-workspace-e2e-')), {
    executablePath,
    headless: true,
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 900 },
    args: [
      '--headless=new',
      '--no-first-run',
      '--no-default-browser-check',
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      `--host-resolver-rules=MAP claude.ai 127.0.0.1:${port}, MAP other-site.test 127.0.0.1:${port}`,
      '--ignore-certificate-errors',
    ],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return { context, sw, extId: new URL(sw.url()).host };
}

const threads = (sw) =>
  sw.evaluate(async () =>
    (await globalThis.__threadkeeperDb.conversations.toArray()).map((c) => ({
      key: c.threadKey,
      provider: c.provider,
      accountId: c.accountId,
      id: c.sourceConversationId,
      repository: c.repository ?? null,
      pullRequestUrl: c.pullRequestUrl ?? null,
      agentState: c.agentState ?? null,
      messages: c.messageCount,
    }))
  );
const accountsOf = (sw) => sw.evaluate(async () => (await globalThis.__threadkeeperDb.accounts.toArray()).filter((a) => a.realm === 'anthropic'));
const cookieMap = (sw) =>
  sw.evaluate(async () => Object.fromEntries((await chrome.cookies.getAll({ domain: 'claude.ai' })).map((c) => [c.name, c.value])));
const command = (page, message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals';

let embedCount = 0;

/**
 * Put a provider page in the workspace tab the way the frame stage does: a named, sandboxed
 * direct child frame. Each call uses a fresh frame (and name), replacing the previous one, so
 * the frame returned is never the one that was just removed.
 */
async function embed(page, url) {
  const name = `tk-pane~e2e-${++embedCount}`;
  await page.evaluate(
    ({ name, url, sandbox }) => {
      document.querySelectorAll('iframe[name^="tk-pane~e2e-"]').forEach((f) => f.remove());
      const frame = document.createElement('iframe');
      frame.name = name;
      frame.setAttribute('sandbox', sandbox);
      frame.style.cssText = 'position:fixed;left:320px;top:120px;width:960px;height:640px;border:0;background:#fff;z-index:99999';
      frame.src = url;
      document.body.appendChild(frame);
    },
    { name, url, sandbox: SANDBOX }
  );
  return until(
    () => page.frames().find((f) => !f.isDetached() && f.name() === name && f.url().startsWith('https://claude.ai/')) ?? null,
    (f) => f !== null,
    { label: `a frame to load ${url}` }
  );
}

async function main() {
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new Error(`No build at ${dist}. Run \`npm run build\` first.`);
  const { server, port } = await startProviderServer();
  const { context, sw, extId } = await launch(port);
  try {
    // 1. A normal tab: sign in as A, the session is captured as before.
    const tab = await context.newPage();
    await tab.goto('https://claude.ai/login?as=A&session=a1');
    await tab.waitForSelector('#who');
    check((await tab.textContent('#who')) === 'Signed in as A', 'a provider page in a normal tab is signed in as account A');
    const first = await until(() => threads(sw), (t) => t.some((x) => x.id === 'session_a1'), { label: 'capture of session_a1' });
    const a1 = first.find((x) => x.id === 'session_a1');
    check(a1.provider === 'claude_code' && a1.accountId === 'acct_claude_code_primary', 'the normal tab is captured under the account threads had before accounts existed', a1);
    check(a1.repository === 'hypestake/hypestake', 'the repository shown on the page is stored as owner/name', a1.repository);
    check(a1.pullRequestUrl === 'https://github.com/hypestake/hypestake/pull/482', 'the pull request shown on the page is stored', a1.pullRequestUrl);
    check(a1.agentState === 'running', 'the run state the page shows is stored as observed', a1.agentState);
    const seenA = await until(() => accountsOf(sw), (list) => list.some((a) => a.primary && a.identity?.display === ACCOUNTS.A.email), { label: 'identity of account A' });
    check(seenA.length === 1, 'the sign-in the browser already had becomes the one primary account, with the identity the site reported', seenA.map((a) => a.identity?.display));

    // 2. The workspace tab registers and a provider page that refuses framing loads inside it.
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/manager.html?surface=page`);
    const hello = await command(page, { type: 'WORKSPACE_HELLO' });
    check(hello?.ok === true && hello.embedding === true, 'the workspace tab registers and embedding is ready', hello);
    check(hello.profiles === true, "the worker can follow the cookies of an added account's pages (webRequest)", hello);
    const rules = await sw.evaluate(() => chrome.declarativeNetRequest.getSessionRules());
    check(
      rules.length === 1 && rules[0].condition.tabIds?.length === 1 && rules[0].condition.tabIds[0] === hello.tabId && JSON.stringify(rules[0].condition.resourceTypes) === '["sub_frame"]',
      'one header rule exists, limited to sub-frames of the workspace tab',
      rules.map((r) => r.condition)
    );
    const frame = await embed(page, 'https://claude.ai/code/session_a2');
    await frame.waitForSelector('#who');
    check((await frame.textContent('#who')) === 'Signed in as A', 'a page that sends X-Frame-Options: DENY and frame-ancestors none loads in the workspace, signed in');
    check(page.url().startsWith(`chrome-extension://${extId}/manager.html`), 'the embedded page did not navigate the workspace away');

    // 3. Cookie bridge: scripts in the frame see and set ordinary cookies.
    const seen = await until(() => frame.textContent('#js-cookie'), (text) => /lastActiveOrg=org-A/.test(text ?? ''), { label: 'document.cookie in the frame to show the Lax cookie' });
    check(!/sessionKey/.test(seen), 'page scripts in the frame read the script-visible cookie and never the HttpOnly one', seen);
    const echoed = await until(
      () => frame.evaluate(() => fetch('/echo').then((r) => r.json())),
      (body) => body?.cookies?.ui_pref === 'dark-a2',
      { label: 'the cookie set from page script to reach the site' }
    );
    check(echoed.cookies.sessionKey === 'A', 'a cookie set by page script in the frame is stored and sent with the next request', echoed.cookies);

    // 4. The embedded session is captured.
    const second = await until(() => threads(sw), (t) => t.some((x) => x.id === 'session_a2'), { label: 'capture of the embedded session_a2' });
    const a2 = second.find((x) => x.id === 'session_a2');
    check(a2.accountId === 'acct_claude_code_primary' && a2.messages >= 2, 'a session open inside the workspace is captured under the signed-in account', a2);
    await page.screenshot({ path: path.join(out, '01-embedded-signed-in.png') });

    // 5. Accounts: add one (nothing is signed out), make it the browser's own sign-in (signs the
    // browser out of the first, keeps the device cookie), capture under it, switch both ways.
    const beforeAdd = await cookieMap(sw);
    const added = await command(page, { type: 'ACCOUNTS_ADD', realm: 'anthropic', mode: 'embedded', label: 'Work' });
    check(added?.ok === true && added.switched === false && added.account?.label === 'Work', 'adding an account answers with the new account and switches nothing', added?.error ?? added?.account);
    const workId = added.account.id;
    check(JSON.stringify(await cookieMap(sw)) === JSON.stringify(beforeAdd), "adding it leaves the browser's sign-in as it was");
    const made = await command(page, { type: 'ACCOUNTS_ACTIVATE', accountId: workId });
    check(made?.ok === true && made.switched === true, "making it the browser's sign-in reports the switch", made?.error);
    const afterAdd = await cookieMap(sw);
    check(afterAdd.sessionKey === undefined && afterAdd.lastActiveOrg === undefined, "making it the browser's sign-in signs the browser out of the first one", Object.keys(afterAdd));
    check(afterAdd.cf_clearance === 'device-1', 'the device bot-check cookie is left in place', afterAdd);
    // Right after a switch the worker ignores identity reports for a few seconds (a page loaded
    // before the switch may still be reporting the previous account). A person takes longer
    // than that to sign in; the script has to wait it out.
    await sleep(4500);
    await tab.goto('https://claude.ai/login?as=B&session=b1');
    await tab.waitForSelector('#who');
    const third = await until(() => threads(sw), (t) => t.some((x) => x.id === 'session_b1'), { label: 'capture of session_b1' });
    const b1 = third.find((x) => x.id === 'session_b1');
    check(b1.accountId === workId, 'a session captured after signing in as the new account is filed under it', { accountId: b1.accountId, workId });
    const seenB = await until(() => accountsOf(sw), (list) => list.find((a) => a.id === workId)?.identity?.display === ACCOUNTS.B.email, { label: 'identity of account B' });
    check(seenB.find((a) => a.primary)?.identity?.display === ACCOUNTS.A.email, 'each account keeps the identity its own sign-in reported', seenB.map((a) => [a.label, a.identity?.display]));

    const primaryId = seenB.find((a) => a.primary).id;
    const back = await command(page, { type: 'ACCOUNTS_ACTIVATE', accountId: primaryId });
    check(back?.ok === true && back.switched === true, 'switching back to the first account succeeds', back?.error);
    const restoredA = await cookieMap(sw);
    check(restoredA.sessionKey === 'A' && restoredA.lastActiveOrg === 'org-A', "the first account's sign-in is restored exactly", restoredA);
    const frameA = await embed(page, 'https://claude.ai/code/session_a2');
    await frameA.waitForSelector('#who');
    check((await frameA.textContent('#who')) === 'Signed in as A', 'after the switch the embedded page loads as the first account');
    const again = await command(page, { type: 'ACCOUNTS_ACTIVATE', accountId: workId });
    check(again?.ok === true && again.switched === true, 'switching to the second account succeeds', again?.error);
    const restoredB = await cookieMap(sw);
    check(restoredB.sessionKey === 'B' && restoredB.lastActiveOrg === 'org-B', "the second account's sign-in is restored exactly", restoredB);
    const frameB = await embed(page, 'https://claude.ai/code/session_b2');
    await frameB.waitForSelector('#who');
    check((await frameB.textContent('#who')) === 'Signed in as B', 'and the embedded page then loads as the second account');
    const fourth = await until(() => threads(sw), (t) => t.some((x) => x.id === 'session_b2'), { label: 'capture of the embedded session_b2' });
    check(fourth.find((x) => x.id === 'session_b2').accountId === workId, 'the embedded session of the second account is filed under the second account');
    const jars = await sw.evaluate(async () => (await globalThis.__threadkeeperDb.accountJars.toArray()).map((j) => ({ accountId: j.accountId, readable: typeof j.data === 'string' || JSON.stringify(j).includes('sessionKey') })));
    check(jars.length === 1 && jars[0].accountId === primaryId && jars[0].readable === false, 'only the account that is not signed in has a saved jar, and it is not stored as readable text', jars);
    await page.screenshot({ path: path.join(out, '02-embedded-second-account.png') });

    // 6. A provider page framed by another website is never captured.
    const other = await context.newPage();
    await other.goto('https://other-site.test/');
    const framed = await until(() => other.frames().find((f) => f.url().includes('session_framedelsewhere')) ?? null, (f) => f !== null, { label: 'the provider page framed by another site' });
    await framed.waitForSelector('#who');
    await sleep(3000);
    check(!(await threads(sw)).some((x) => x.id === 'session_framedelsewhere'), 'a provider page framed by some other website is not captured');
    await other.close();

    // 7. A link the embedded page opens in a new tab comes back to the workspace.
    const requested = page.evaluate(
      () =>
        new Promise((resolve) => {
          chrome.runtime.onMessage.addListener(function listener(message) {
            if (message?.type === 'EMBED_OPEN_REQUEST') {
              chrome.runtime.onMessage.removeListener(listener);
              resolve(message);
            }
          });
          setTimeout(() => resolve(null), 10_000);
        })
    );
    const pagesBefore = context.pages().length;
    await frameB.click('#blank');
    const request = await requested;
    check(request?.url === 'https://claude.ai/code/session_b2blank' && request.tabId === hello.tabId, 'a link opened in a new tab by the embedded page is handed to the workspace', request);
    await until(() => context.pages().length, (n) => n === pagesBefore, { label: 'the stray browser tab to be closed' });
    check(context.pages().length === pagesBefore, 'and no extra browser tab is left behind');

    const rejections = await sw.evaluate(() => globalThis.__threadkeeperGetSecurityRejections?.() ?? []);
    log(`security rejections recorded during the run: ${rejections.length}`);
    for (const r of rejections.slice(-6)) log(`  ${r.reason}`);
  } finally {
    await context.close();
    server.close();
  }
  log(`${results.length} checks passed`);
}

main().catch((error) => {
  console.error(error.message || error);
  console.error(`[workspace-e2e] ${results.filter((r) => r.ok).length} checks passed before the failure`);
  process.exit(1);
});
