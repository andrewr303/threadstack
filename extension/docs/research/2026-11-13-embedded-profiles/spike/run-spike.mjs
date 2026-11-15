// Measures, in real Chromium, how a credentialless iframe inside an extension page handles
// cookies, storage, service workers and header rules, next to an ordinary iframe of the same
// site in the same page. The answers decide how Threadkeeper keeps several accounts of one site
// signed in at once (docs/research/2026-11-13-embedded-profiles/outputs/decision-report.md).
//
// Nothing here talks to a real site: claude.ai is mapped to a local stand-in server.
//
//   node docs/research/2026-11-13-embedded-profiles/spike/run-spike.mjs [--block-3pc]
//
// Writes spike/results[-block3pc].json next to this file.
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.join(here, 'extension');
const block3pc = process.argv.includes('--block-3pc');

function resolveChromium() {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  const builds = fs.readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const parts of [
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
    ]) {
      const candidate = path.join(cache, build, ...parts);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(read, accept, { timeout = 15_000, every = 100, label = 'condition' } = {}) {
  const started = Date.now();
  for (;;) {
    const value = await read();
    if (accept(value)) return value;
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${label}; last: ${JSON.stringify(value)}`);
    await sleep(every);
  }
}

// ---- Stand-in site ------------------------------------------------------------------------------

function parseCookies(header) {
  const jar = {};
  for (const part of (header || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i)] = part.slice(i + 1);
  }
  return jar;
}

const REFUSE = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'" };

function handler(req, res) {
  const host = (req.headers.host || '').split(':')[0];
  const url = new URL(req.url, `https://${host}`);
  const cookies = parseCookies(req.headers.cookie);
  const send = (status, headers, body) => {
    res.writeHead(status, { 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const json = (value, status = 200, headers = {}) => send(status, { 'content-type': 'application/json', ...headers }, JSON.stringify(value));
  const html = (body, headers = {}) => send(200, { 'content-type': 'text/html; charset=utf-8', ...REFUSE, ...headers }, body);

  if (host === 'other-site.test') {
    return send(200, { 'content-type': 'text/html' }, '<!doctype html><title>other</title><iframe name="third" src="https://claude.ai/echo-frame"></iframe>');
  }
  if (url.pathname === '/echo-frame') {
    return send(200, { 'content-type': 'text/html' }, `<!doctype html><title>echo</title><pre id="c">${JSON.stringify(cookies)}</pre>`);
  }
  if (url.pathname === '/echo') return json({ cookies, raw: req.headers.cookie ?? '', secFetchDest: req.headers['sec-fetch-dest'] ?? null, secFetchSite: req.headers['sec-fetch-site'] ?? null });
  if (url.pathname === '/echo-sw') return json({ sw: false, cookies });
  if (url.pathname === '/set') return json({ cookies }, 200, { 'set-cookie': url.searchParams.getAll('c') });
  if (url.pathname === '/login') {
    const who = url.searchParams.get('as') || 'A';
    return send(302, {
      location: '/page',
      ...REFUSE,
      'set-cookie': [
        `sessionKey=${who}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`,
        `lastActiveOrg=org-${who}; Path=/; Secure; SameSite=Lax; Max-Age=86400`,
        `cf_clearance=device-${who}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=86400`,
      ],
    }, '');
  }
  if (url.pathname === '/page') {
    return html(`<!doctype html><title>page</title><p id="who">${cookies.sessionKey ?? 'nobody'}</p><a id="pop" target="_blank" href="/popup">popup</a>`);
  }
  if (url.pathname === '/popup') {
    return html(`<!doctype html><title>popup</title><p id="who">${cookies.sessionKey ?? 'nobody'}</p><script>document.title = window.opener ? 'has-opener' : 'no-opener';</script>`);
  }
  if (url.pathname === '/robots.txt') return send(200, { 'content-type': 'text/plain' }, 'User-agent: *\nDisallow:\n');
  if (url.pathname === '/sw.js') {
    return send(200, { 'content-type': 'text/javascript' }, `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (new URL(e.request.url).pathname === '/echo-sw') {
    e.respondWith(fetch('/echo').then((r) => r.json()).then((body) => new Response(JSON.stringify({ sw: true, cookies: body.cookies }), { headers: { 'content-type': 'application/json' } })));
  }
});`);
  }
  if (url.pathname === '/sw-register') {
    return html(`<!doctype html><title>sw</title><p id="state">registering</p><script>
navigator.serviceWorker.register('/sw.js').then(() => navigator.serviceWorker.ready).then(() => {
  const done = () => { document.getElementById('state').textContent = 'controlled'; };
  if (navigator.serviceWorker.controller) done(); else navigator.serviceWorker.addEventListener('controllerchange', done);
}).catch((e) => { document.getElementById('state').textContent = 'failed: ' + e.message; });
</script>`);
  }
  return send(404, { 'content-type': 'text/plain' }, 'not found');
}

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-spike-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=tk-spike'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

// ---- Browser ------------------------------------------------------------------------------------

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals';

async function addFrame(page, { name, url, credentialless }) {
  await page.evaluate(
    ({ name, url, credentialless, sandbox }) => {
      document.querySelector(`iframe[name="${name}"]`)?.remove();
      const frame = document.createElement('iframe');
      frame.name = name;
      frame.setAttribute('sandbox', sandbox);
      if (credentialless) frame.setAttribute('credentialless', '');
      frame.style.cssText = 'width:600px;height:200px;border:1px solid #888';
      frame.src = url;
      document.body.appendChild(frame);
    },
    { name, url, credentialless: Boolean(credentialless), sandbox: SANDBOX }
  );
  return until(
    () => page.frames().find((f) => !f.isDetached() && f.name() === name && f.url().startsWith('https://')) ?? null,
    (f) => f !== null,
    { label: `frame ${name}` }
  );
}

const echo = (frame, pathName = '/echo') => frame.evaluate((p) => fetch(p).then((r) => r.json()), pathName);
const send = (page, message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);

async function main() {
  const { server, port } = await startServer();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-spike-profile-'));
  if (block3pc) {
    fs.mkdirSync(path.join(profile, 'Default'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'Default', 'Preferences'), JSON.stringify({ profile: { cookie_controls_mode: 1, block_third_party_cookies: true } }));
  }
  const context = await chromium.launchPersistentContext(profile, {
    executablePath: resolveChromium(),
    headless: true,
    ignoreHTTPSErrors: true,
    args: [
      '--headless=new',
      '--no-first-run',
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      `--host-resolver-rules=MAP claude.ai 127.0.0.1:${port}, MAP sub.claude.ai 127.0.0.1:${port}, MAP other-site.test 127.0.0.1:${port}`,
      '--ignore-certificate-errors',
    ],
  });
  const results = { block3pc, findings: {} };
  const note = (key, value) => {
    results.findings[key] = value;
    console.log(`[spike] ${key}: ${JSON.stringify(value)}`);
  };
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    results.userAgent = await sw.evaluate(() => navigator.userAgent);
    console.log('[spike]', results.userAgent);

    // The browser's own sign-in: account A, in an ordinary tab.
    const tab = await context.newPage();
    await tab.goto('https://claude.ai/login?as=A');
    note('01_tab_signed_in', await tab.textContent('#who'));

    // Control: the same site framed by an unrelated website. With third-party cookies blocked
    // it receives no cookies at all; otherwise only the SameSite=None one.
    const other = await context.newPage();
    await other.goto('https://other-site.test/');
    const third = await until(() => other.frames().find((f) => f.name() === 'third' && f.url().includes('/echo-frame')) ?? null, (f) => f !== null, { label: 'third-party frame' });
    note('01b_control_third_party_frame_cookies', JSON.parse(await third.textContent('#c')));
    await other.close();

    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/host.html`);
    const hello = await send(page, { type: 'hello' });
    note('02_host_tab', hello);

    // An ordinary frame uses the browser's sign-in (the existing behaviour).
    const plain = await addFrame(page, { name: 'plain-1', url: 'https://claude.ai/page' });
    note('03_plain_frame_cookies', (await echo(plain)).cookies);
    note('03_plain_frame_document_cookie', await plain.evaluate(() => document.cookie));

    // A credentialless frame starts with no cookies at all.
    const cred = await addFrame(page, { name: 'cred-1', url: 'https://claude.ai/page', credentialless: true });
    note('04_credentialless_frame_initial_cookies', (await echo(cred)).cookies);
    note('04_credentialless_flag_page_world', await cred.evaluate(() => window.credentialless));

    // Signing in inside it: a redirect that sets HttpOnly SameSite=Lax cookies, then a fetch.
    await send(page, { type: 'clearLog' });
    const cred2 = await addFrame(page, { name: 'cred-1b', url: 'https://claude.ai/login?as=B', credentialless: true });
    await cred2.waitForSelector('#who');
    note('05_credentialless_after_login_page_shows', await cred2.textContent('#who'));
    note('05_credentialless_after_login_fetch_cookies', (await echo(cred2)).cookies);
    note('05_credentialless_document_cookie', await cred2.evaluate(() => document.cookie));

    // The browser's own jar is untouched, and the ordinary frame is still account A.
    const jar = (await send(page, { type: 'cookies' })).cookies;
    note('06_browser_jar_plain', Object.fromEntries(jar.plain.map((c) => [c.name, c.value])));
    note('06_browser_jar_partitions', Object.fromEntries(Object.entries(jar).filter(([k]) => k !== 'plain').map(([k, v]) => [k, Array.isArray(v) ? v.map((c) => `${c.name}=${c.value}`) : v])));
    note('07_plain_frame_still', (await echo(plain)).cookies);

    // A second credentialless frame shares the first one's cookies.
    const cred3 = await addFrame(page, { name: 'cred-2', url: 'https://claude.ai/page', credentialless: true });
    note('08_second_credentialless_frame_cookies', (await echo(cred3)).cookies);

    // What the extension is told about those requests.
    const loginLog = (await send(page, { type: 'log', match: '/login' })).log;
    note('09_webrequest_login_seen', loginLog.filter((e) => e.stage === 'headersReceived').map((e) => ({ tabId: e.tabId, frameId: e.frameId, parentFrameId: e.parentFrameId, type: e.type, setCookie: e.setCookie })));
    note('09_frames_reported_by_content_script', (await send(page, { type: 'frames' })).frames.map((f) => ({ name: f.name, frameId: f.frameId, credentialless: f.credentialless })));

    // Script access inside the credentialless frame.
    await cred3.evaluate(() => {
      document.cookie = 'js_lax=1; Path=/; SameSite=Lax';
      document.cookie = 'js_none=1; Path=/; SameSite=None; Secure';
      document.cookie = 'js_default=1; Path=/';
    });
    note('10_credentialless_js_written_document_cookie', await cred3.evaluate(() => document.cookie));
    note('10_credentialless_js_written_sent', (await echo(cred3)).cookies);

    // Storage: separate from the ordinary frame.
    await plain.evaluate(() => localStorage.setItem('tk_spike', 'plain'));
    note('11_localStorage_seen_by_credentialless', await cred3.evaluate(() => localStorage.getItem('tk_spike')));
    await cred3.evaluate(() => localStorage.setItem('tk_spike', 'cred'));
    note('11_localStorage_seen_by_plain_after', await plain.evaluate(() => localStorage.getItem('tk_spike')));
    note('11_localStorage_shared_between_credentialless', await cred2.evaluate(() => localStorage.getItem('tk_spike')));

    // Service workers. First one registered by the browser's own tab.
    await tab.goto('https://claude.ai/sw-register');
    await until(() => tab.textContent('#state'), (t) => t === 'controlled' || String(t).startsWith('failed'), { label: 'tab service worker' });
    note('12_tab_sw_state', await tab.textContent('#state'));
    const plain2 = await addFrame(page, { name: 'plain-2', url: 'https://claude.ai/page' });
    note('12_plain_frame_controlled_by_tab_sw', await echo(plain2, '/echo-sw'));
    const cred4 = await addFrame(page, { name: 'cred-3', url: 'https://claude.ai/page', credentialless: true });
    note('12_credentialless_frame_controlled_by_tab_sw', await echo(cred4, '/echo-sw'));
    // Then one registered inside the credentialless frame.
    const cred5 = await addFrame(page, { name: 'cred-3b', url: 'https://claude.ai/sw-register', credentialless: true });
    const swState = await until(() => cred5.textContent('#state'), (t) => t === 'controlled' || String(t).startsWith('failed'), { label: 'credentialless service worker', timeout: 10_000 }).catch((e) => `timeout: ${e.message}`);
    note('13_credentialless_sw_state', swState);
    await send(page, { type: 'clearLog' });
    note('13_credentialless_fetch_through_own_sw', await echo(cred5, '/echo-sw').catch((e) => `error: ${e.message}`));
    await sleep(300);
    const swLog = (await send(page, { type: 'log', match: '/echo' })).log;
    note('13_webrequest_for_sw_fetch', swLog.filter((e) => e.stage === 'sendHeaders').map((e) => ({ url: new URL(e.url).pathname, tabId: e.tabId, frameId: e.frameId, type: e.type, cookie: e.cookie })));

    // A popup opened from the credentialless frame.
    const cred6 = await addFrame(page, { name: 'cred-4', url: 'https://claude.ai/page', credentialless: true });
    const popupPromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);
    await cred6.click('#pop');
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('load');
      note('14_popup_from_credentialless', { title: await popup.title(), who: await popup.textContent('#who') });
      await popup.close();
    } else note('14_popup_from_credentialless', 'no popup');

    // Reloading the host page: a new credentialless jar, and nothing left of the old one.
    await page.reload();
    await send(page, { type: 'hello' });
    const fresh = await addFrame(page, { name: 'cred-fresh', url: 'https://claude.ai/page', credentialless: true });
    note('15_after_host_reload_credentialless_cookies', (await echo(fresh)).cookies);
    note('15_after_host_reload_credentialless_localStorage', await fresh.evaluate(() => localStorage.getItem('tk_spike')));
    note('15_after_host_reload_controlled_by_old_sw', await echo(fresh, '/echo-sw'));

    // Seeding: Set-Cookie headers appended by a header rule to the response of one address.
    const seedUrl = `https://claude.ai/robots.txt?tkseed=${Date.now()}`;
    const seedCookies = [
      'sessionKey=C; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400',
      'lastActiveOrg=org-C; Path=/; Secure; SameSite=Lax; Max-Age=86400',
      'domainwide=1; Domain=claude.ai; Path=/; Secure; SameSite=None; Max-Age=86400',
      '__Host-strict=1; Path=/; Secure; HttpOnly; SameSite=Strict',
      'scoped=1; Path=/api; Secure; HttpOnly; SameSite=Lax',
    ];
    const seedRule = await send(page, { type: 'seed', url: seedUrl, cookies: seedCookies });
    await send(page, { type: 'clearLog' });
    await addFrame(page, { name: 'cred-seed', url: seedUrl, credentialless: true });
    await sleep(300);
    note('16_seed_rule', seedRule);
    note('16_seeded_cookies_sent_from_credentialless', (await echo(fresh)).cookies);
    note('16_seeded_path_scoped_cookie', await fresh.evaluate(() => fetch('/api/x').then(() => null).catch(() => null)).then(async () => (await send(page, { type: 'log', match: '/api/x' })).log.filter((e) => e.stage === 'sendHeaders').map((e) => e.cookie)));
    // Which seeded cookies reach a subdomain: only the one with a Domain attribute should.
    const subFrame = await addFrame(page, { name: 'cred-sub', url: 'https://sub.claude.ai/page', credentialless: true });
    note('16_seeded_on_subdomain', (await echo(subFrame)).cookies);
    note('16_seed_response_as_webrequest_saw_it', (await send(page, { type: 'log', match: 'tkseed' })).log.filter((e) => e.stage === 'headersReceived').map((e) => ({ setCookie: e.setCookie, type: e.type })));
    const jar2 = (await send(page, { type: 'cookies' })).cookies;
    note('16_browser_jar_after_seed', Object.fromEntries(jar2.plain.map((c) => [c.name, c.value])));
    await send(page, { type: 'dropRule', id: seedRule.id });

    // Signing the profile out again: expire what was seeded, the same way.
    const clearUrl = `https://claude.ai/robots.txt?tkseed=clear-${Date.now()}`;
    const clearRule = await send(page, { type: 'seed', url: clearUrl, cookies: ['sessionKey=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0', 'lastActiveOrg=; Path=/; Secure; SameSite=Lax; Max-Age=0'] });
    await addFrame(page, { name: 'cred-seed2', url: clearUrl, credentialless: true });
    await sleep(300);
    note('17_after_expiring_seed', (await echo(fresh)).cookies);
    await send(page, { type: 'dropRule', id: clearRule.id });

    // Seeding through a subresource request (fetch) instead of a frame.
    const fetchSeedUrl = `https://claude.ai/robots.txt?tkseed=fetch-${Date.now()}`;
    const fetchRule = await send(page, { type: 'seed', url: fetchSeedUrl, cookies: ['viafetch=1; Path=/; Secure; HttpOnly; SameSite=Lax'], resourceTypes: ['xmlhttprequest'] });
    await fresh.evaluate((u) => fetch(u).then((r) => r.text()), fetchSeedUrl);
    note('18_seed_through_fetch', (await echo(fresh)).cookies);
    await send(page, { type: 'dropRule', id: fetchRule.id });

    // The alternative mechanism, for comparison: rewrite the Cookie header for the whole tab.
    const alt = await send(page, { type: 'cookieRule', urlFilter: '||claude.ai/echo', cookie: 'sessionKey=Z; lastActiveOrg=org-Z' });
    const plain3 = await addFrame(page, { name: 'plain-3', url: 'https://claude.ai/page' });
    note('19_cookie_header_rule_plain_frame', (await echo(plain3)).cookies);
    note('19_cookie_header_rule_through_tab_sw', await echo(plain3, '/echo-sw'));
    await send(page, { type: 'dropRule', id: alt.id });
    const altSet = await send(page, { type: 'cookieRule', urlFilter: '||claude.ai/set', cookie: 'sessionKey=Z' });
    await send(page, { type: 'clearLog' });
    await plain3.evaluate(() => fetch('/set?c=' + encodeURIComponent('leak=1; Path=/; Secure; SameSite=Lax')).then((r) => r.json()));
    await sleep(200);
    note('20_set_cookie_removed_but_seen_by_webrequest', (await send(page, { type: 'log', match: '/set' })).log.filter((e) => e.stage === 'headersReceived').map((e) => e.setCookie));
    note('20_browser_jar_after_removed_set_cookie', Object.fromEntries(((await send(page, { type: 'cookies' })).cookies.plain).map((c) => [c.name, c.value])));
    await send(page, { type: 'dropRule', id: altSet.id });
  } finally {
    await context.close();
    server.close();
  }
  const file = path.join(here, block3pc ? 'results-block3pc.json' : 'results.json');
  fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`[spike] wrote ${file}`);
}

main().catch((error) => {
  console.error('[spike] failed:', error);
  process.exit(1);
});
