// End-to-end check, in real Chromium with the built extension, that two accounts of one sign-in
// are signed in at the same moment inside the workspace, and that nothing of it leaks into the
// browser's own sign-in. Provider sites are local stand-ins served on their real host names, so
// the extension's own host permissions, content scripts, header rules and webRequest listener are
// what is exercised.
//
//   1. The browser is signed in as A in an ordinary tab; the workspace lands on Claude Code as A,
//      and the page shows its own navigation although it is in a frame.
//   2. Adding account B signs nothing out. "Sign in here" opens B's tab in the workspace's own
//      cookie partition; signing in there keeps B's sign-in, files B's sessions under B and
//      records B's identity, while the browser and every ordinary tab stay signed in as A.
//   3. The Dashboard shows A and B side by side, both live.
//   4. After the workspace page reloads, B comes back signed in from its saved sign-in alone.
//      When B's saved sign-in is replaced behind the page (B becomes the browser's account and
//      back), B's pane stops using the old cookies and asks for a reload, which shows B again.
//   5. Account C signs in through an ordinary browser tab: the browser's sign-in is set aside,
//      C's is kept, and A's is put back by itself once the site names C.
//   6. Controls: a provider page framed by another site still hides its navigation, and with the
//      setting switched off the workspace leaves it hidden too.
//
// Build first, into a folder no browser has loaded:
//   TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs
//   TK_E2E_DIST=/tmp/tk-build node scripts/run-profiles-e2e.mjs
// Screenshots go to evidence/profiles/.
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
const out = path.join(root, 'evidence', 'profiles');
fs.mkdirSync(out, { recursive: true });

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
    const builds = fs.readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) {
      for (const parts of inside) {
        const candidate = path.join(cache, build, ...parts);
        if (fs.existsSync(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

const log = (...a) => console.log('[profiles-e2e]', ...a);
const results = [];
function check(condition, message, detail) {
  results.push({ ok: Boolean(condition), message });
  if (!condition) throw new Error(`FAILED: ${message}${detail !== undefined ? `\n  observed: ${JSON.stringify(detail)}` : ''}`);
  log(`ok — ${message}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, accept, { timeout = 20_000, every = 150, label = 'condition' } = {}) {
  const started = Date.now();
  let last;
  for (;;) {
    try {
      last = await read();
    } catch (error) {
      last = `error: ${error.message}`;
    }
    if (accept(last)) return last;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(last)?.slice(0, 400)}`);
    await sleep(every);
  }
}

// ---- Stand-in site ------------------------------------------------------------------------------

const ACCOUNTS = {
  A: { uuid: '11111111-aaaa-4aaa-8aaa-111111111111', email: 'ada@example.com' },
  B: { uuid: '22222222-bbbb-4bbb-8bbb-222222222222', email: 'ada@work.example.com' },
  C: { uuid: '33333333-cccc-4ccc-8ccc-333333333333', email: 'ada@client.example.com' },
};
const REFUSE = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

function parseCookies(header) {
  const jar = {};
  for (const part of (header || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i)] = part.slice(i + 1);
  }
  return jar;
}

/** Like the real app: its navigation is not rendered when the page finds itself in a frame. */
const SHELL_SCRIPT = `<script>
  var framed = window.self !== window.top;
  document.getElementById('sidebar').hidden = framed;
  document.getElementById('framed').textContent = framed ? 'framed' : 'top-level';
  fetch('/api/account').then(function (r) { return r.json(); }).catch(function () { return null; });
</script>`;

function shell(acct, body) {
  return `<!doctype html><html><head><title>${acct ? `Claude (${acct})` : 'Claude'}</title></head><body>
<nav id="sidebar"><a href="/new">Chats</a> <a href="/code">Code</a> <span>Recents</span></nav>
<p id="framed"></p>
<p id="who">Signed in as ${acct ?? 'nobody'}</p>
${body}
${SHELL_SCRIPT}
</body></html>`;
}

function sessionBody(id) {
  return `<header>
  <a href="https://github.com/hypestake/hypestake">hypestake/hypestake</a>
  <span data-testid="task-status" data-state="running">running</span>
</header>
<main>
  <div data-testid="user-message">Plan the release notes for session ${id}, one per account.</div>
  <div class="font-claude-response"><p>Release notes for session ${id} are drafted and grouped by product area.</p><p>Next: review them.</p></div>
</main>`;
}

function handler(req, res) {
  const host = (req.headers.host || '').split(':')[0];
  const url = new URL(req.url, `https://${host}`);
  const cookies = parseCookies(req.headers.cookie);
  const acct = ACCOUNTS[cookies.sessionKey] ? cookies.sessionKey : null;
  const send = (status, headers, body) => {
    res.writeHead(status, { 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const html = (body, extra = {}) => send(200, { 'content-type': 'text/html; charset=utf-8', ...REFUSE, ...extra }, body);
  const json = (value, status = 200) => send(status, { 'content-type': 'application/json' }, JSON.stringify(value));

  if (host === 'other-site.test') {
    return send(200, { 'content-type': 'text/html' }, '<!doctype html><title>Other site</title><iframe name="elsewhere" src="https://claude.ai/code/session_elsewhere?plain=1" width="800" height="400"></iframe>');
  }
  if (host !== 'claude.ai') return send(404, { 'content-type': 'text/plain' }, 'not a stand-in host');

  if (url.pathname === '/login') {
    const who = url.searchParams.get('as');
    const next = url.searchParams.get('next') || '/new';
    if (who && ACCOUNTS[who]) {
      return send(302, {
        location: next,
        ...REFUSE,
        'set-cookie': [
          `sessionKey=${who}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`,
          `lastActiveOrg=org-${who}; Path=/; Secure; SameSite=Lax; Max-Age=86400`,
          // The network edge's bot-check: the browser's, not anyone's sign-in.
          'cf_clearance=device-1; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=86400',
        ],
      }, '');
    }
    const link = (k) => `<a id="login-${k}" href="/login?as=${k}&next=${encodeURIComponent(next)}">Log in as ${k}</a>`;
    return html(`<!doctype html><title>Sign in - Claude</title><form><input type="email" name="email"><button>Log in</button></form>${Object.keys(ACCOUNTS).map(link).join(' ')}`);
  }
  if (url.pathname === '/api/account') {
    if (!acct) return json({ error: 'unauthorized' }, 401);
    return json({ uuid: ACCOUNTS[acct].uuid, email_address: ACCOUNTS[acct].email, full_name: `Ada ${acct}` });
  }
  if (url.pathname === '/echo') return json({ cookies });
  if (url.pathname === '/robots.txt') return send(200, { 'content-type': 'text/plain' }, 'User-agent: *\nAllow: /\n');
  const session = url.pathname.match(/^\/code\/(session_[A-Za-z0-9]+)$/);
  if (session) {
    // ?plain=1: framed by another website, which no rule of the extension touches.
    if (url.searchParams.get('plain')) return html(shell(acct, sessionBody(session[1])), { 'x-frame-options': '', 'content-security-policy': '' });
    if (!acct) return send(302, { location: `/login?next=${encodeURIComponent(url.pathname)}`, ...REFUSE }, '');
    return html(shell(acct, sessionBody(session[1].replace(/^session_/, ''))));
  }
  if (url.pathname === '/code' || url.pathname === '/new' || url.pathname === '/') {
    if (!acct) return send(302, { location: `/login?next=${encodeURIComponent(url.pathname)}`, ...REFUSE }, '');
    return html(shell(acct, `<p><a id="open-${acct.toLowerCase()}1" href="/code/session_${acct.toLowerCase()}1">Open session ${acct.toLowerCase()}1</a></p>`));
  }
  return send(404, { 'content-type': 'text/plain' }, 'not found');
}

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-profiles-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=threadkeeper-e2e'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (req, res) => {
    const writeHead = res.writeHead.bind(res);
    // Empty header values mean "do not send this header".
    res.writeHead = (status, h = {}) => writeHead(status, Object.fromEntries(Object.entries(h).filter(([, v]) => v !== '')));
    handler(req, res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---- Browser helpers ----------------------------------------------------------------------------

const threads = (sw) =>
  sw.evaluate(async () =>
    (await globalThis.__threadkeeperDb.conversations.toArray()).map((c) => ({ key: c.threadKey, accountId: c.accountId, id: c.sourceConversationId, messages: c.messageCount }))
  );
const claudeAccounts = (sw) =>
  sw.evaluate(async () =>
    (await globalThis.__threadkeeperDb.accounts.toArray())
      .filter((a) => a.realm === 'anthropic')
      .map((a) => ({ id: a.id, label: a.label, primary: a.primary, mode: a.mode, hasJar: a.hasJar, signedIn: a.signedIn, identity: a.identity?.display ?? null }))
  );
const jarOf = (sw, id) => sw.evaluate(async (accountId) => {
  const jar = await globalThis.__threadkeeperDb.accountJars.get(accountId);
  return jar ? { cookieCount: jar.cookieCount, plaintext: new TextDecoder('latin1').decode(new Uint8Array(jar.data)).includes('sessionKey') } : null;
}, id);
const browserJar = (sw) =>
  sw.evaluate(async () => Object.fromEntries((await chrome.cookies.getAll({ domain: 'claude.ai' })).map((c) => [c.name, c.value])));

/** The workspace's embedded page of a session tab, by the tab's id. */
const paneFrame = (page, tabId) => page.frames().find((f) => !f.isDetached() && f.name().startsWith('tk-pane~') && f.name().endsWith(tabId)) ?? null;
const textOf = async (frame, selector) => (frame ? frame.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector).catch(() => null) : null);

/** Click a button by its exact visible name, once it is there and enabled (Playwright waits). */
async function clickButton(page, text) {
  await page.getByRole('button', { name: text, exact: true }).first().click({ timeout: 20_000 });
}

async function main() {
  if (!fs.existsSync(path.join(dist, 'manifest.json'))) throw new Error(`No build at ${dist}. Build first: TK_OUT_DIR=/tmp/tk-build node scripts/build-extension.mjs`);
  const manifest = JSON.parse(fs.readFileSync(path.join(dist, 'manifest.json'), 'utf8'));
  check(manifest.permissions.includes('webRequest'), 'the build asks for webRequest, so the cookies of an added account can be followed');
  const { server, port } = await startServer();
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-profiles-e2e-')), {
    executablePath: resolveChromium(),
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
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    log(`browser: ${await sw.evaluate(() => navigator.userAgent)}`);

    // 1. The browser's own sign-in, then the workspace lands on Claude Code as that account.
    const tab = await context.newPage();
    await tab.goto('https://claude.ai/login?as=A&next=/code/session_a1');
    await tab.waitForSelector('#who');
    check((await tab.textContent('#who')) === 'Signed in as A', 'an ordinary tab is signed in as A');
    check((await tab.textContent('#framed')) === 'top-level' && (await tab.isVisible('#sidebar')), 'as a top-level page the stand-in shows its navigation');
    await until(() => threads(sw), (t) => t.some((x) => x.id === 'session_a1'), { label: 'capture of session_a1' });
    await until(() => claudeAccounts(sw), (list) => list.some((a) => a.primary && a.identity === ACCOUNTS.A.email), { label: 'identity of A' });

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/manager.html?surface=page`);
    await page.waitForSelector('.tk-workbench[data-view="browse"]', { timeout: 20_000 });
    const landingTab = await until(
      () => page.evaluate(() => document.querySelector('iframe.tk-frame[data-loaded="true"]')?.getAttribute('data-tab') ?? null),
      (id) => typeof id === 'string',
      { label: 'the start page to load' }
    );
    const landed = paneFrame(page, landingTab);
    check(landed && new URL(landed.url()).pathname === '/code', 'the workspace lands on Claude Code', landed?.url());
    check((await textOf(landed, '#who')) === 'Signed in as A', 'in an ordinary frame with the browser account, A');
    check((await textOf(landed, '#framed')) === 'top-level', "the framed page's own check reads top-level");
    check(await landed.evaluate(() => !document.getElementById('sidebar').hidden), "so it shows its own navigation inside the workspace");
    await page.screenshot({ path: path.join(out, '01-landing-claude-code.png') });

    // 2. Add B: nothing is signed out. Then "Sign in here" signs B in inside the workspace.
    const cookiesBefore = await browserJar(sw);
    await page.click('.tk-rail-add');
    await page.waitForSelector('#tk-add-account-dialog[open]');
    check(!(await page.textContent('#tk-add-account-dialog')).includes('will be signed out'), 'the add dialog promises no sign-out');
    await page.fill('#tk-add-account-dialog input[type="text"]', 'Work');
    await page.click('#tk-add-account-dialog footer button.tk-acct-submit');
    const work = await until(() => claudeAccounts(sw), (list) => list.some((a) => a.label === 'Work'), { label: 'account Work' }).then((list) => list.find((a) => a.label === 'Work'));
    check(work.mode === 'embedded' && !work.primary && work.hasJar === false, 'Work is an added account without a sign-in yet', work);
    const cookiesAfterAdd = await browserJar(sw);
    check(cookiesAfterAdd.sessionKey === 'A' && cookiesAfterAdd.lastActiveOrg === cookiesBefore.lastActiveOrg, "adding it leaves the browser's sign-in exactly as it was", cookiesAfterAdd);

    await clickButton(page, 'Sign in here');
    const workTab = await until(
      () => page.evaluate(() => document.querySelector('iframe.tk-frame[data-slot="profile"]')?.getAttribute('data-tab') ?? null),
      (id) => typeof id === 'string',
      { label: "Work's page in the profile slot" }
    );
    const signIn = await until(() => paneFrame(page, workTab), (f) => f !== null && new URL(f.url()).pathname === '/login', { label: "the site's sign-in page in Work's frame" });
    check(await signIn.evaluate(() => window.credentialless === true), "Work's page loads in a credentialless frame (the workspace's own cookie partition)");
    await signIn.click('#login-B');
    const workFrame = await until(() => paneFrame(page, workTab), (f) => f !== null && f.url().endsWith('/new'), { label: "Work's frame after signing in" });
    await until(() => textOf(workFrame, '#who'), (t) => t === 'Signed in as B', { label: 'Work signed in as B' });
    check(true, 'Work is signed in as B inside the workspace');
    check(await workFrame.evaluate(() => !document.getElementById('sidebar').hidden), 'with its navigation shown too');
    const landedNow = paneFrame(page, landingTab);
    check(landedNow === null || (await textOf(landedNow, '#who')) !== 'Signed in as B', "the browser account's page did not turn into B");
    const cookiesAfterB = await browserJar(sw);
    check(cookiesAfterB.sessionKey === 'A', "the browser is still signed in as A after B signed in", cookiesAfterB);
    await tab.reload();
    await tab.waitForSelector('#who');
    check((await tab.textContent('#who')) === 'Signed in as A', 'and so is the ordinary tab');

    const workSaved = await until(() => claudeAccounts(sw), (list) => {
      const w = list.find((a) => a.id === work.id);
      return w?.hasJar === true && w?.identity === ACCOUNTS.B.email;
    }, { label: "Work's saved sign-in and identity" }).then((list) => list.find((a) => a.id === work.id));
    check(workSaved.signedIn === 'yes' && workSaved.label === 'Work', 'Work keeps its name and records who signed in there', workSaved);
    const jar = await jarOf(sw, work.id);
    check(jar && jar.cookieCount >= 2 && jar.plaintext === false, "Work's sign-in is kept, encrypted, not as readable text", jar);
    const primaryNow = (await claudeAccounts(sw)).find((a) => a.primary);
    check(primaryNow.identity === ACCOUNTS.A.email, "the browser account's identity is untouched", primaryNow);

    // A session opened in Work's page is filed under Work, not under the browser's account.
    await workFrame.click('#open-b1');
    const filed = await until(() => threads(sw), (t) => t.some((x) => x.id === 'session_b1'), { label: 'capture of session_b1' }).then((t) => t.find((x) => x.id === 'session_b1'));
    check(filed.accountId === work.id, 'a session opened as Work is filed under Work', filed);
    const a1 = (await threads(sw)).find((x) => x.id === 'session_a1');
    check(a1.accountId === 'acct_claude_code_primary', "the browser account's sessions stay under it", a1);

    // 3. Side by side on the Dashboard.
    await sw.evaluate(async (keys) => {
      for (const key of keys) await globalThis.__threadkeeperDb.conversations.update(key, { pinned: true });
      chrome.runtime.sendMessage({ type: 'LIBRARY_CHANGED' }).catch(() => undefined);
    }, [a1.key, filed.key]);
    await page.click('.tk-rail-seg [role="radio"]:has-text("Dashboard")');
    await page.waitForSelector('.tk-workbench[data-view="dashboard"]');
    for (let pane = 0; pane < 2; pane++) {
      await until(() => page.$$eval('.tk-dash-empty button', (b) => b.length), (n) => n > 0, { label: `a pinned session to place in pane ${pane + 1}` });
      await page.click('.tk-dash-empty button');
    }
    const aThreadTab = `thread~${a1.key}`;
    const bThreadTab = `thread~${filed.key}`;
    await until(() => textOf(paneFrame(page, aThreadTab), '#who'), (t) => t === 'Signed in as A', { label: "A's pane" });
    await until(() => textOf(paneFrame(page, bThreadTab), '#who'), (t) => t === 'Signed in as B', { label: "Work's pane" });
    check(true, 'the Dashboard shows A and Work side by side, both signed in at once');
    await page.screenshot({ path: path.join(out, '02-dashboard-two-accounts.png') });

    // 4. After a reload, Work comes back from its saved sign-in alone.
    await page.reload();
    await page.waitForSelector('.tk-workbench[data-view="dashboard"]', { timeout: 20_000 });
    await until(() => textOf(paneFrame(page, bThreadTab), '#who'), (t) => t === 'Signed in as B', { label: "Work's pane after reload", timeout: 30_000 });
    await until(() => textOf(paneFrame(page, aThreadTab), '#who'), (t) => t === 'Signed in as A', { label: "A's pane after reload" });
    check(true, "after a reload Work is signed in again from its saved sign-in, without signing in");
    check((await browserJar(sw)).sessionKey === 'A', 'the browser is still A');
    const seedRulesLeft = await sw.evaluate(async () => (await chrome.declarativeNetRequest.getSessionRules()).filter((r) => r.id >= 2000).length);
    check(seedRulesLeft === 0, 'no seeding rule is left once the account is in place', seedRulesLeft);
    await page.screenshot({ path: path.join(out, '03-dashboard-after-reload.png') });

    // 4b. Work's saved sign-in is replaced behind this page (it becomes the browser's account and
    // back): the page must not put Work's pages back in its partition with the old cookies.
    const toWork = await page.evaluate((id) => chrome.runtime.sendMessage({ type: 'ACCOUNTS_ACTIVATE', accountId: id }), work.id);
    check(toWork?.ok === true && (await browserJar(sw)).sessionKey === 'B', 'making Work the browser account puts its sign-in in the browser', toWork?.error);
    const toA = await page.evaluate((id) => chrome.runtime.sendMessage({ type: 'ACCOUNTS_ACTIVATE', accountId: id }), primaryNow.id);
    check(toA?.ok === true && (await browserJar(sw)).sessionKey === 'A', 'and making A the browser account again puts A back', toA?.error);
    await until(() => page.evaluate(() => document.body.innerText.includes('Work’s sign-in changed')), (shown) => shown === true, { label: "Work's pane asking for a reload" });
    // The notice and the frame's removal land in one render; Playwright hears of the removal a moment later.
    const leftover = await until(() => Promise.resolve(paneFrame(page, bThreadTab)), (f) => f === null, { timeout: 5_000, label: "Work's old page to be removed" }).catch(() => paneFrame(page, bThreadTab));
    check(leftover === null, "Work's pane no longer shows the page loaded with its old cookies; it asks for a reload", leftover && {
      url: leftover.url(),
      who: await textOf(leftover, '#who'),
      frames: await page.evaluate(() => [...document.querySelectorAll('iframe.tk-frame')].map((f) => ({ tab: f.getAttribute('data-tab'), slot: f.getAttribute('data-slot') }))),
    });
    check((await jarOf(sw, work.id))?.cookieCount >= 2, "Work's sign-in is saved again, from the browser");
    await clickButton(page, 'Reload to show Work');
    await page.waitForSelector('.tk-workbench[data-view="dashboard"]', { timeout: 20_000 });
    await until(() => textOf(paneFrame(page, bThreadTab), '#who'), (t) => t === 'Signed in as B', { label: "Work's pane after the reload it asked for", timeout: 30_000 });
    await until(() => textOf(paneFrame(page, aThreadTab), '#who'), (t) => t === 'Signed in as A', { label: "A's pane after that reload" });
    check(true, 'after that reload Work is signed in from its new saved sign-in, beside A');

    // 5. Account C signs in through an ordinary browser tab.
    const added = await page.evaluate(() => chrome.runtime.sendMessage({ type: 'ACCOUNTS_ADD', realm: 'anthropic', mode: 'embedded', label: 'Client' }));
    check(added?.ok === true && added.switched === false, 'adding Client signs nothing out', added?.error);
    const clientId = added.account.id;
    const opened = context.waitForEvent('page');
    const begun = await page.evaluate((id) => chrome.runtime.sendMessage({ type: 'ACCOUNTS_SIGNIN_BEGIN', accountId: id }), clientId);
    check(begun?.ok === true && begun.switched === true, "starting Client's browser sign-in sets the browser's sign-in aside", begun?.error);
    const signInTab = await opened;
    await signInTab.waitForLoadState('domcontentloaded');
    check(new URL(signInTab.url()).pathname === '/login', "the realm's sign-in page opens in an ordinary tab", signInTab.url());
    check((await browserJar(sw)).sessionKey === undefined, 'while it is open the browser holds no Claude sign-in');
    // A person takes a few seconds; identity reports right after a switch are ignored on purpose.
    await sleep(4_500);
    await signInTab.click('#login-C');
    await until(() => claudeAccounts(sw), (list) => list.find((a) => a.id === clientId)?.hasJar === true, { label: "Client's saved sign-in", timeout: 30_000 });
    const afterClient = await until(() => browserJar(sw), (j) => j.sessionKey === 'A', { label: "the browser's own sign-in coming back" });
    check(afterClient.sessionKey === 'A', "once the site names Client, Client's sign-in is kept and the browser is A again", afterClient);
    const pending = await sw.evaluate(async () => (await globalThis.__threadkeeperDb.kv.get('accounts.signIn'))?.value ?? null);
    check(pending === null, 'the sign-in is over', pending);
    const client = (await claudeAccounts(sw)).find((a) => a.id === clientId);
    check(client.identity === ACCOUNTS.C.email, 'Client records who signed in', client);
    await until(() => Promise.resolve(signInTab.isClosed()), (closed) => closed === true, { label: 'the sign-in tab to close' });
    check(true, 'and the sign-in tab is closed');

    // 6. Controls.
    const other = await context.newPage();
    await other.goto('https://other-site.test/');
    const elsewhere = await until(() => other.frames().find((f) => f.name() === 'elsewhere' && f.url().includes('session_elsewhere')) ?? null, (f) => f !== null, { label: 'the page framed by another site' });
    await elsewhere.waitForSelector('#framed');
    check((await elsewhere.textContent('#framed')) === 'framed' && (await elsewhere.evaluate(() => document.getElementById('sidebar').hidden)), 'framed by another site the page still finds itself framed and hides its navigation');
    await other.close();

    await sw.evaluate(async () => {
      await globalThis.__threadkeeperDb.settings.update('default', { embedFullNavigation: false });
    });
    await page.reload();
    await page.waitForSelector('.tk-workbench[data-view="dashboard"]', { timeout: 20_000 });
    const plainA = await until(() => paneFrame(page, aThreadTab), (f) => f !== null && f.name().includes('!n!'), { label: "A's pane without the navigation option" });
    await until(() => textOf(plainA, '#framed'), (t) => t === 'framed', { label: 'the setting to take effect' });
    check(await plainA.evaluate(() => document.getElementById('sidebar').hidden), 'with "Show each site’s full navigation" off, the workspace leaves the check alone');
    await sw.evaluate(async () => {
      await globalThis.__threadkeeperDb.settings.update('default', { embedFullNavigation: true });
    });

    const rejections = await sw.evaluate(() => globalThis.__threadkeeperGetSecurityRejections?.() ?? []);
    log(`security rejections recorded during the run: ${rejections.length}`);
    for (const r of rejections.slice(-8)) log(`  ${r.reason}`);
  } finally {
    await context.close();
    server.close();
  }
  log(`${results.length} checks passed`);
}

main().catch((error) => {
  console.error(error.message || error);
  console.error(`[profiles-e2e] ${results.filter((r) => r.ok).length} checks passed before the failure`);
  process.exit(1);
});
