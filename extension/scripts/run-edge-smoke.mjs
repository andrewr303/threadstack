// Microsoft Edge smoke test for the "<id> is blocked · ERR_BLOCKED_BY_CLIENT" class of bugs.
//
//   A. The current build loads on every surface in real Edge: in-page overlay,
//      full-page library (extension-opened and web-opened) and the side panel.
//   B. A stale manifest (the 0.1 use_dynamic_url one Edge keeps after a rebuild
//      without Reload) is detected: the service worker reloads once, does not
//      loop, the overlay shows the reload banner, and a reload with the fixed
//      manifest on disk restores the full-page library.
//   C. A rebuild while the extension runs: the worker keeps its cached script,
//      reads the new build-info.json from disk when it next starts, and reloads.
//
// Requires `npm run build`. Edge is found via EDGE_EXECUTABLE_PATH or the
// standard install paths. Screenshots go to evidence/edge/.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, '.output', 'chrome-mv3');
const out = path.join(root, 'evidence', 'edge');
const log = (...a) => console.log('[edge-smoke]', ...a);

function findEdge() {
  const candidates = [
    process.env.EDGE_EXECUTABLE_PATH,
    '/opt/microsoft/msedge/msedge',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p));
}

function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log(`ok — ${message}`);
}

const CLAUDE_URL = 'https://claude.ai/chat/0f9c2d1e-1111-4a2b-9c3d-0000000000ed';
const CLAUDE_PAGE = `<html><head><title>Stripe webhook retries - Claude</title></head><body><main>
  <div data-testid="user-message">Customers get charged twice when Stripe retries our webhook. How do I make it idempotent?</div>
  <div class="font-claude-response"><p>Store each processed event id and skip duplicates.</p></div>
  <textarea id="composer">unsent draft</textarea></main></body></html>`;

async function launch(extDir, profileDir, edge) {
  // Developer mode on, as for any unpacked install; some Chromium builds otherwise disable an
  // unpacked extension when it reloads itself.
  fs.mkdirSync(path.join(profileDir, 'Default'), { recursive: true });
  fs.writeFileSync(path.join(profileDir, 'Default', 'Preferences'), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
  const ctx = await chromium.launchPersistentContext(profileDir, {
    executablePath: edge,
    headless: false,
    viewport: { width: 1280, height: 800 },
    args: [
      '--headless=new',
      '--no-sandbox',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--disable-extensions-except=${extDir}`,
      `--load-extension=${extDir}`,
    ],
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages'],
  });
  await ctx.route('https://claude.ai/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: CLAUDE_PAGE }));
  return ctx;
}

/** Our service worker (Edge also runs built-in extension workers). */
async function ourWorker(ctx, { exclude, timeoutMs = 20000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const w = ctx.serviceWorkers().filter((x) => x.url().endsWith('/background.js') && x !== exclude).pop();
    if (w) {
      try {
        await w.evaluate(() => chrome.runtime.id);
        return w;
      } catch {
        // worker is shutting down (reload in progress)
      }
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('extension service worker did not start');
}

async function pageText(page) {
  return page.evaluate(() => document.body?.innerText ?? '').catch((e) => `EVAL ERROR ${e}`);
}

const isBlocked = (text, url = '') => /is blocked|ERR_BLOCKED_BY_CLIENT/.test(text) || url.startsWith('chrome-error://');

async function openFullPage(ctx, sw) {
  const opened = ctx.waitForEvent('page', { timeout: 10000 });
  await sw.evaluate(() => chrome.tabs.create({ url: chrome.runtime.getURL('manager.html?surface=page') }));
  const page = await opened;
  await page.waitForLoadState('domcontentloaded').catch(() => undefined);
  await page.waitForTimeout(1500);
  return page;
}

async function openOverlay(ctx, sw) {
  const page = await ctx.newPage();
  await page.goto(CLAUDE_URL);
  await page.waitForTimeout(1200);
  const tabId = await sw.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, CLAUDE_URL);
  await sw.evaluate(
    async ({ tabId, url }) => globalThis.__threadkeeperInvokeAction(tabId, url, 'toolbar_action'),
    { tabId, url: CLAUDE_URL }
  );
  await page.waitForTimeout(2500);
  const frame = page.frames().find((f) => /^chrome-extension:\/\/[a-p]{32}\/manager\.html/.test(f.url()));
  const errorFrame = page.frames().some((f) => f.url().startsWith('chrome-error://'));
  return { page, frame, errorFrame };
}

async function scenarioCurrentBuild(edge) {
  log('— A. current build on every surface');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-edge-a-'));
  const ext = path.join(work, 'ext');
  fs.cpSync(dist, ext, { recursive: true });
  const buildInfo = JSON.parse(fs.readFileSync(path.join(ext, 'build-info.json'), 'utf8'));
  const ctx = await launch(ext, path.join(work, 'profile'), edge);
  try {
    const sw = await ourWorker(ctx);
    const running = await sw.evaluate(() => chrome.runtime.getManifest().version_name);
    check(running === buildInfo.versionName, `Edge runs this build's manifest (${running})`);

    const overlay = await openOverlay(ctx, sw);
    check(Boolean(overlay.frame) && !overlay.errorFrame, 'overlay frame loads on claude.ai (no chrome-error frame)');
    const overlayText = await pageText(overlay.frame);
    check(!isBlocked(overlayText), 'overlay frame is not an Edge block page');
    await overlay.frame.waitForSelector('[data-surface="overlay"] .tk-header', { timeout: 8000 });
    check(true, 'overlay redeemed its handshake and rendered the library');
    await overlay.page.screenshot({ path: path.join(out, 'a-overlay.png') });

    const full = await openFullPage(ctx, sw);
    check(!isBlocked(await pageText(full), full.url()), 'full-page library opened by the extension loads');
    check((await full.locator('[data-testid="stale-build-banner"]').count()) === 0, 'no stale-build banner when manifest matches');
    await full.screenshot({ path: path.join(out, 'a-full-page.png') });

    const webPage = await ctx.newPage();
    await webPage.goto(CLAUDE_URL);
    const popupP = ctx.waitForEvent('page', { timeout: 8000 });
    const extId = new URL(sw.url()).host;
    await webPage.evaluate((u) => window.open(u, '_blank'), `chrome-extension://${extId}/manager.html?surface=page`);
    const popup = await popupP;
    await popup.waitForTimeout(1500);
    check(!isBlocked(await pageText(popup), popup.url()), 'library opened from a web page (window.open) loads');

    const opened = await full.evaluate(async () => {
      try {
        const win = await chrome.windows.getCurrent();
        await chrome.sidePanel.open({ windowId: win.id });
        return 'opened';
      } catch (e) {
        return `error: ${e}`;
      }
    });
    check(opened === 'opened', 'side panel opens');
    await full.waitForTimeout(1500);
    const cdp = await ctx.newCDPSession(full);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const panel = targetInfos.find((t) => t.url.includes(`${extId}/sidepanel.html`));
    check(panel?.title === 'Threadkeeper', `side panel document loaded (title "${panel?.title}")`);
  } finally {
    await ctx.close();
  }
}

async function scenarioStaleManifest(edge) {
  log('— B. stale use_dynamic_url manifest left running after a rebuild');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-edge-b-'));
  const ext = path.join(work, 'ext');
  fs.cpSync(dist, ext, { recursive: true });
  const goodManifest = fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8');
  const stale = JSON.parse(goodManifest);
  stale.version = '0.1.0';
  delete stale.version_name;
  stale.web_accessible_resources = stale.web_accessible_resources.map((e) => ({ ...e, use_dynamic_url: true }));
  fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(stale, null, 2));

  const ctx = await launch(ext, path.join(work, 'profile'), edge);
  try {
    // The worker reloads the extension once on start, then must settle.
    let sw = await ourWorker(ctx);
    await new Promise((r) => setTimeout(r, 2500));
    sw = await ourWorker(ctx);
    const state = await sw.evaluate(async () => chrome.storage.local.get(['tk_auto_reload_build', 'tk_auto_reload_log']));
    const outcomes = (state.tk_auto_reload_log ?? []).map((e) => e.outcome);
    check(outcomes[0] === 'reloading', `service worker reloaded the extension to re-read the manifest (${outcomes.join(', ')})`);
    check(!outcomes.slice(1).includes('reloading'), 'no reload loop when the manifest on disk is still stale');

    const blocked = await openFullPage(ctx, sw);
    check(isBlocked(await pageText(blocked), blocked.url()), 'reproduced: Edge blocks the full page under the stale manifest');
    await blocked.screenshot({ path: path.join(out, 'b-stale-full-page-blocked.png') });
    await blocked.close();

    const overlay = await openOverlay(ctx, sw);
    check(Boolean(overlay.frame), 'overlay still loads under the stale manifest');
    await overlay.frame.waitForSelector('[data-testid="stale-build-banner"]', { timeout: 8000 });
    check(true, 'overlay shows the "needs a reload" banner');
    await overlay.page.screenshot({ path: path.join(out, 'b-stale-overlay-banner.png') });

    // The user rebuilds/pulls a fixed manifest and presses Reload (the banner button calls this).
    fs.writeFileSync(path.join(ext, 'manifest.json'), goodManifest);
    await sw.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await new Promise((r) => setTimeout(r, 2500));
    const sw2 = await ourWorker(ctx);
    const war = await sw2.evaluate(() => chrome.runtime.getManifest().web_accessible_resources);
    check(!war.some((e) => e.use_dynamic_url), 'after Reload the browser runs the fixed manifest');
    const full = await openFullPage(ctx, sw2);
    check(!isBlocked(await pageText(full), full.url()), 'full-page library loads after Reload');
    check((await full.locator('[data-testid="stale-build-banner"]').count()) === 0, 'banner is gone after Reload');
    await full.screenshot({ path: path.join(out, 'b-after-reload.png') });
  } finally {
    await ctx.close();
  }
}

async function scenarioRebuildWithoutReload(edge) {
  log('— C. rebuild on disk while the extension keeps running (cached worker, old manifest)');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-edge-c-'));
  const ext = path.join(work, 'ext');
  fs.cpSync(dist, ext, { recursive: true });
  const ctx = await launch(ext, path.join(work, 'profile'), edge);
  try {
    const sw = await ourWorker(ctx);
    const extId = new URL(sw.url()).host;
    const before = await sw.evaluate(() => chrome.runtime.getManifest().version_name);

    // What `npm run build` does: new build-info.json and manifest on disk, nothing reloaded.
    const info = JSON.parse(fs.readFileSync(path.join(ext, 'build-info.json'), 'utf8'));
    const next = { ...info, buildId: `${info.buildId}-next`, versionName: `${info.version} (build ${info.buildId}-next)` };
    fs.writeFileSync(path.join(ext, 'build-info.json'), JSON.stringify(next, null, 2));
    const manifest = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify({ ...manifest, version_name: next.versionName }, null, 2));

    // Stop the worker as the browser does when it is idle, then wake it with a message.
    const page = await ctx.newPage();
    await page.goto(`chrome-extension://${extId}/manager.html?surface=page`);
    const cdp = await ctx.newCDPSession(page);
    const versions = [];
    cdp.on('ServiceWorker.workerVersionUpdated', (e) => versions.push(...e.versions));
    await cdp.send('ServiceWorker.enable');
    await page.waitForTimeout(500);
    const ours = versions.filter((v) => v.scriptURL === `chrome-extension://${extId}/background.js` && v.runningStatus === 'running');
    check(ours.length > 0, 'found the running extension worker');
    await cdp.send('ServiceWorker.stopWorker', { versionId: ours[0].versionId });
    await page.waitForTimeout(1000);
    await page.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' }).catch(() => undefined)).catch(() => undefined);

    // The restarted worker runs its cached script, reads the new build-info.json and reloads once.
    let after = before;
    for (let i = 0; i < 40 && after === before; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const w = ctx.serviceWorkers().filter((x) => x.url().endsWith('/background.js')).pop();
      after = w ? await w.evaluate(() => chrome.runtime.getManifest().version_name).catch(() => before) : before;
    }
    check(after === next.versionName, `extension reloaded itself to the rebuilt manifest (${before} → ${after})`);
  } finally {
    await ctx.close();
  }
}

const edge = findEdge();
if (!edge) {
  console.error('[edge-smoke] Microsoft Edge not found. Set EDGE_EXECUTABLE_PATH to the msedge binary.');
  process.exit(2);
}
if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  console.error('[edge-smoke] Run `npm run build` first.');
  process.exit(2);
}
fs.mkdirSync(out, { recursive: true });
log('Edge:', edge);
try {
  await scenarioCurrentBuild(edge);
  await scenarioStaleManifest(edge);
  await scenarioRebuildWithoutReload(edge);
  log('PASS');
} catch (err) {
  console.error(err);
  process.exit(1);
}
