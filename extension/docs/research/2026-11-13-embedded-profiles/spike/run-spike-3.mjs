// Third measurement: how much one seeding response can carry (count and bytes of appended
// Set-Cookie headers), so seeding can be split safely. Same fixture extension.
//   node docs/research/2026-11-13-embedded-profiles/spike/run-spike-3.mjs
import fs from 'node:fs';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const here = path.dirname(fileURLToPath(import.meta.url));
const extension = path.join(here, 'extension');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function resolveChromium() {
  if (process.env.CHROME_EXECUTABLE_PATH) return process.env.CHROME_EXECUTABLE_PATH;
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'ms-playwright');
  const builds = fs.readdirSync(cache).filter((n) => /^chromium-\d+$/.test(n)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    const candidate = path.join(cache, build, 'chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing');
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function handler(req, res) {
  const url = new URL(req.url, 'https://claude.ai');
  const header = req.headers.cookie || '';
  const names = header ? header.split(/;\s*/).map((p) => p.slice(0, p.indexOf('='))) : [];
  if (url.pathname === '/count') {
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    return res.end(JSON.stringify({ count: names.length, bytes: header.length, first: names[0] ?? null, last: names[names.length - 1] ?? null }));
  }
  res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
  res.end('ok');
}

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-spike-cert-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=tk-spike'], { stdio: 'ignore' });
  const server = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')), maxHeaderSize: 1024 * 1024 }, handler);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-spike3-')), {
    executablePath: resolveChromium(),
    headless: true,
    ignoreHTTPSErrors: true,
    args: ['--headless=new', '--no-first-run', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`, `--host-resolver-rules=MAP claude.ai 127.0.0.1:${port}`, '--ignore-certificate-errors'],
  });
  const results = { findings: {} };
  try {
    let [sw] = context.serviceWorkers();
    if (!sw) sw = await context.waitForEvent('serviceworker');
    const extId = new URL(sw.url()).host;
    results.userAgent = await sw.evaluate(() => navigator.userAgent);
    const cases = [
      { label: '100 cookies of 20 bytes', count: 100, size: 20 },
      { label: '170 cookies of 20 bytes', count: 170, size: 20 },
      { label: '10 cookies of 1000 bytes', count: 10, size: 1000 },
      { label: '40 cookies of 1000 bytes', count: 40, size: 1000 },
      { label: '80 cookies of 1000 bytes', count: 80, size: 1000 },
      { label: '20 cookies of 3900 bytes', count: 20, size: 3900 },
    ];
    for (const c of cases) {
      // A fresh host page each time: a new credentialless jar.
      const page = await context.newPage();
      await page.goto(`chrome-extension://${extId}/host.html`);
      await page.evaluate(() => chrome.runtime.sendMessage({ type: 'hello' }));
      const url = `https://claude.ai/robots.txt?tkseed=${Date.now()}`;
      const cookies = Array.from({ length: c.count }, (_, i) => `c${String(i).padStart(3, '0')}=${'x'.repeat(c.size)}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=3600`);
      const rule = await page.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'seed', url, cookies });
      const frames = async (src, name) => {
        await page.evaluate(({ src, name }) => {
          const f = document.createElement('iframe');
          f.name = name;
          f.setAttribute('credentialless', '');
          f.src = src;
          document.body.appendChild(f);
        }, { src, name });
        const started = Date.now();
        for (;;) {
          const f = page.frames().find((x) => x.name() === name && x.url().startsWith('https://'));
          if (f) return f;
          if (Date.now() - started > 10_000) throw new Error('frame did not load');
          await sleep(100);
        }
      };
      await frames(url, 'seed');
      await sleep(400);
      const probe = await frames('https://claude.ai/robots.txt', 'probe');
      const seen = await probe.evaluate(() => fetch('/count').then((r) => r.json()).catch((e) => ({ error: e.message })));
      results.findings[c.label] = { rule: rule.ok ? 'accepted' : rule.error, ...seen };
      console.log(`[spike3] ${c.label}: ${JSON.stringify(results.findings[c.label])}`);
      if (rule.ok) await page.evaluate((m) => chrome.runtime.sendMessage(m), { type: 'dropRule', id: rule.id });
      await page.close();
    }
  } finally {
    await context.close();
    server.close();
  }
  fs.writeFileSync(path.join(here, 'results-3-chromium.json'), `${JSON.stringify(results, null, 2)}\n`);
}

main().catch((error) => {
  console.error('[spike3] failed:', error);
  process.exit(1);
});
