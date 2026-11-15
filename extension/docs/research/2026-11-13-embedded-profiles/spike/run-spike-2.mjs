// Second set of measurements (same fixture extension as run-spike.mjs):
//   a. chrome.runtime.getFrameId in an extension page, and whether a frame keeps its id.
//   b. Which cookies a WebSocket handshake carries from an ordinary and a credentialless frame.
//   c. How many cookies one seeding response can carry.
//   d. Whether a page that hides its navigation when `window.self !== window.top` shows it again
//      once the page-world script answers that check like a top-level page.
//
//   node docs/research/2026-11-13-embedded-profiles/spike/run-spike-2.mjs
import crypto from 'node:crypto';
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.join(here, 'extension');

function resolveChromium() {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  if (!fs.existsSync(cache)) return undefined;
  const builds = fs.readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const parts of [
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
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

function parseCookies(header) {
  const jar = {};
  for (const part of (header || '').split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0) jar[part.slice(0, i)] = part.slice(i + 1);
  }
  return jar;
}

const REFUSE = { 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'; script-src 'self' 'nonce-abc'" };
const wsSeen = {};

/** A page that behaves like an app with a framing check, written the way a bundler would. */
function framedPage(meta) {
  return `<!doctype html><html><head><title>app</title>${meta ? `<meta http-equiv="Content-Security-Policy" content="script-src 'self' 'nonce-abc'">` : ''}</head><body>
<nav id="side">sidebar</nav><p id="probe"></p><p id="module"></p>
<script nonce="abc">
  var framed = window.self !== window.top;
  document.getElementById('side').hidden = framed;
  self.__probe = 'set-through-self';
  var notes = [String(framed), String(window.__probe), typeof self.crypto, String(self === window), String(globalThis.self === window)];
  try { notes.push('parent:' + String(window.parent === window)); } catch (e) { notes.push('parent:err'); }
  document.getElementById('probe').textContent = notes.join('|');
</script>
<script type="module" nonce="abc">
  document.getElementById('module').textContent = String(self === window) + '|' + typeof self.fetch;
</script>
</body></html>`;
}

function handler(req, res) {
  const host = (req.headers.host || '').split(':')[0];
  const url = new URL(req.url, `https://${host}`);
  const cookies = parseCookies(req.headers.cookie);
  const send = (status, headers, body) => {
    res.writeHead(status, { 'cache-control': 'no-store', ...headers });
    res.end(body);
  };
  const json = (value) => send(200, { 'content-type': 'application/json' }, JSON.stringify(value));
  if (url.pathname === '/echo') return json({ cookies });
  if (url.pathname === '/ws-log') return json({ seen: wsSeen[url.searchParams.get('id')] ?? null });
  if (url.pathname === '/login') {
    const who = url.searchParams.get('as') || 'A';
    return send(302, {
      location: '/page',
      ...REFUSE,
      'set-cookie': [
        `sessionKey=${who}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=86400`,
        `strict=${who}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=86400`,
        `none=${who}; Path=/; Secure; HttpOnly; SameSite=None; Max-Age=86400`,
      ],
    }, '');
  }
  if (url.pathname === '/page') return send(200, { 'content-type': 'text/html', ...REFUSE }, `<!doctype html><title>page</title><p id="who">${cookies.sessionKey ?? 'nobody'}</p>`);
  if (url.pathname === '/app') return send(200, { 'content-type': 'text/html', ...REFUSE }, framedPage(false));
  if (url.pathname === '/app-meta') return send(200, { 'content-type': 'text/html', ...REFUSE }, framedPage(true));
  if (url.pathname === '/robots.txt') return send(200, { 'content-type': 'text/plain' }, 'User-agent: *\n');
  return send(404, { 'content-type': 'text/plain' }, 'not found');
}

function startServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-spike-cert-'));
  const key = path.join(dir, 'key.pem');
  const cert = path.join(dir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '2', '-subj', '/CN=tk-spike'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, handler);
  // Complete the WebSocket handshake by hand, only to see which cookies it carried.
  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'https://claude.ai');
    wsSeen[url.searchParams.get('id')] = parseCookies(req.headers.cookie);
    const accept = crypto.createHash('sha1').update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`).digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    setTimeout(() => socket.destroy(), 200);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

const SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads allow-modals';

async function addFrame(page, { name, url, credentialless }) {
  await page.evaluate(
    ({ name, url, credentialless, sandbox }) => {
      const frame = document.createElement('iframe');
      frame.name = name;
      frame.setAttribute('sandbox', sandbox);
      if (credentialless) frame.setAttribute('credentialless', '');
      frame.style.cssText = 'width:600px;height:160px;border:1px solid #888';
      frame.src = url;
      document.body.appendChild(frame);
    },
    { name, url, credentialless: Boolean(credentialless), sandbox: SANDBOX }
  );
  return until(() => page.frames().find((f) => !f.isDetached() && f.name() === name && f.url().startsWith('https://')) ?? null, (f) => f !== null, { label: `frame ${name}` });
}

const send = (page, message) => page.evaluate((m) => chrome.runtime.sendMessage(m), message);

async function main() {
  const { server, port } = await startServer();
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-spike2-')), {
    executablePath: resolveChromium(),
    headless: true,
    ignoreHTTPSErrors: true,
    args: ['--headless=new', '--no-first-run', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=MAP claude.ai 127.0.0.1:${port}`, '--ignore-certificate-errors'],
  });
  const results = { findings: {} };
  const note = (key, value) => {
    results.findings[key] = value;
    console.log(`[spike2] ${key}: ${JSON.stringify(value)}`);
  };
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    results.userAgent = await sw.evaluate(() => navigator.userAgent);
    console.log('[spike2]', results.userAgent);

    const tab = await context.newPage();
    await tab.goto('https://claude.ai/login?as=A');
    const page = await context.newPage();
    await page.goto(`chrome-extension://${extId}/host.html`);
    await send(page, { type: 'hello' });

    // a. Frame ids.
    note('a_getFrameId_type', await page.evaluate(() => typeof chrome.runtime.getFrameId));
    const idBefore = await page.evaluate(() => {
      const frame = document.createElement('iframe');
      frame.name = 'id-probe';
      frame.setAttribute('credentialless', '');
      document.body.appendChild(frame);
      return typeof chrome.runtime.getFrameId === 'function' ? chrome.runtime.getFrameId(frame) : null;
    });
    note('a_frame_id_before_first_load', idBefore);
    await page.evaluate(() => {
      document.querySelector('iframe[name="id-probe"]').src = 'https://claude.ai/page';
    });
    await until(() => page.frames().find((f) => f.name() === 'id-probe' && f.url().includes('/page')) ?? null, (f) => f !== null, { label: 'id-probe load' });
    await sleep(300);
    await page.evaluate(() => {
      document.querySelector('iframe[name="id-probe"]').src = 'https://claude.ai/page?second=1';
    });
    await until(() => page.frames().find((f) => f.name() === 'id-probe' && f.url().includes('second=1')) ?? null, (f) => f !== null, { label: 'id-probe second load' });
    await sleep(300);
    const reported = (await send(page, { type: 'frames' })).frames.filter((f) => f.name === 'id-probe');
    note('a_frame_ids_reported_by_content_script', reported.map((f) => ({ frameId: f.frameId, credentialless: f.credentialless, hadRoot: f.hadRoot })));
    note('a_frame_id_after', await page.evaluate(() => (typeof chrome.runtime.getFrameId === 'function' ? chrome.runtime.getFrameId(document.querySelector('iframe[name="id-probe"]')) : null)));

    // b. WebSocket handshakes.
    const plain = await addFrame(page, { name: 'plain-ws', url: 'https://claude.ai/page' });
    const cred = await addFrame(page, { name: 'cred-ws', url: 'https://claude.ai/login?as=B', credentialless: true });
    await cred.waitForSelector('#who');
    const openSocket = (frame, id) =>
      frame.evaluate(
        (id) =>
          new Promise((resolve) => {
            const ws = new WebSocket(`wss://claude.ai/socket?id=${id}`);
            ws.onopen = () => resolve('open');
            ws.onerror = () => resolve('error');
            setTimeout(() => resolve('timeout'), 4000);
          }),
        id
      );
    note('b_ws_plain_frame', { state: await openSocket(plain, 'plain'), seen: (await plain.evaluate(() => fetch('/ws-log?id=plain').then((r) => r.json()))).seen, fetchSees: (await plain.evaluate(() => fetch('/echo').then((r) => r.json()))).cookies });
    note('b_ws_credentialless_frame', { state: await openSocket(cred, 'cred'), seen: (await cred.evaluate(() => fetch('/ws-log?id=cred').then((r) => r.json()))).seen, fetchSees: (await cred.evaluate(() => fetch('/echo').then((r) => r.json()))).cookies });
    note('b_ws_top_level_tab', { state: await tab.evaluate((id) => new Promise((resolve) => { const ws = new WebSocket(`wss://claude.ai/socket?id=${id}`); ws.onopen = () => resolve('open'); ws.onerror = () => resolve('error'); }), 'tab'), seen: (await tab.evaluate(() => fetch('/ws-log?id=tab').then((r) => r.json()))).seen });

    // c. A large seed: 80 cookies of about 1 KB in one response, and one of about 4 KB.
    const seedUrl = `https://claude.ai/robots.txt?tkseed=${Date.now()}`;
    const big = Array.from({ length: 80 }, (_, i) => `big${i}=${'x'.repeat(1000)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`);
    big.push(`huge=${'y'.repeat(4000)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`);
    const seedRule = await send(page, { type: 'seed', url: seedUrl, cookies: big });
    note('c_large_seed_rule', seedRule);
    if (seedRule.ok) {
      await addFrame(page, { name: 'cred-seed', url: seedUrl, credentialless: true });
      await sleep(400);
      const got = (await cred.evaluate(() => fetch('/echo').then((r) => r.json()))).cookies;
      note('c_large_seed_cookies_stored', { big: Object.keys(got).filter((k) => k.startsWith('big')).length, huge: got.huge?.length ?? 0 });
    }

    // d. The framing check.
    for (const [name, url] of [['plain-app', '/app'], ['top-app', '/app'], ['top-app-meta', '/app-meta'], ['top-cred-app', '/app']]) {
      const frame = await addFrame(page, { name, url: `https://claude.ai${url}`, credentialless: name.includes('cred') });
      await frame.waitForSelector('#probe');
      await sleep(150);
      note(`d_${name}`, {
        sidebarHidden: await frame.evaluate(() => document.getElementById('side').hidden),
        probe: await frame.textContent('#probe'),
        module: await frame.textContent('#module'),
      });
    }
    // The same page as an ordinary tab is untouched.
    await tab.goto('https://claude.ai/app');
    note('d_ordinary_tab', { sidebarHidden: await tab.evaluate(() => document.getElementById('side').hidden), probe: await tab.textContent('#probe') });
  } finally {
    await context.close();
    server.close();
  }
  const file = path.join(here, `results-2-${process.env.CHROME_EXECUTABLE_PATH ? 'edge' : 'chromium'}.json`);
  fs.writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
  console.log(`[spike2] wrote ${file}`);
}

main().catch((error) => {
  console.error('[spike2] failed:', error);
  process.exit(1);
});
