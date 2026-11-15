// Follow-up probe for two questions raised by the first spike run (throwaway; not product code):
//  (1) Does wheel / gesture scrolling over the clipped hole reach the view beneath?
//  (2) How long after the clip is re-applied until pointer input passes through again (stale hit-test window)?
// Usage: node probe-input.mjs <edge|cft>-ext | <chrome|edge|cft>-web
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServers } from './server.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const forkRoot = path.resolve(here, '../../../..');
const require = createRequire(path.join(forkRoot, 'extension', 'package.json'));
const { chromium } = require('playwright');
const target = process.argv[2];
const [browserName, mode] = (target || '').split('-');
function cftExecutable() {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const builds = fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) for (const parts of [['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'], ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing']]) {
    const candidate = path.join(cache, build, ...parts);
    if (fs.existsSync(candidate)) return candidate;
  }
  throw new Error('No Playwright Chromium build found.');
}
const executablePath = { edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }[browserName] ?? cftExecutable();
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const servers = await startServers();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'req6-probe-'));
const extDir = path.join(here, 'ext');
const out = { target, startedAt: new Date().toISOString() };
let context;
try {
  const args = ['--headless=new', '--no-first-run', '--no-default-browser-check'];
  if (mode === 'ext') args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1, args });
  out.browserVersion = context.browser()?.version();
  let hostBase; const frameOrigin = servers.ipOrigin; let nestedOrigin;
  if (mode === 'ext') {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    hostBase = `chrome-extension://${new URL(worker.url()).host}/host.html`; nestedOrigin = servers.nameOrigin;
  } else { hostBase = `${servers.nameOrigin}/host.html`; nestedOrigin = servers.ipOrigin; }
  const page = await context.newPage();
  await page.goto(`${hostBase}?${new URLSearchParams({ frame: frameOrigin, nested: nestedOrigin, clip: '1' })}`);
  await page.waitForFunction(() => window.__state?.ready && window.__state.slot && window.__state.clipped, null, { timeout: 20_000 });
  const frame = page.frames().find((item) => item.url().startsWith(`${frameOrigin}/frame.html`));
  await page.evaluate(() => {
    window.__wheel = [];
    document.getElementById('view').addEventListener('wheel', (event) => window.__wheel.push({ deltaY: event.deltaY, target: event.target.id || event.target.tagName }), { passive: true });
    window.__clicks = [];
    document.getElementById('view').addEventListener('pointerdown', (event) => window.__clicks.push({ t: performance.now(), x: event.clientX }));
  });
  await frame.evaluate(() => { window.__wheel = []; document.addEventListener('wheel', (event) => window.__wheel.push({ deltaY: event.deltaY }), { passive: true }); });
  const slot = await page.evaluate(() => window.__state.slot);
  const point = { x: slot.x + slot.width - 60, y: slot.y + 200 };
  const scrollTop = () => page.evaluate(() => document.getElementById('view').scrollTop);
  const reset = async () => { await page.evaluate(() => { document.getElementById('view').scrollTop = 0; window.__wheel.length = 0; }); await frame.evaluate(() => { window.__wheel.length = 0; }); };

  // (1a) Playwright wheel (Input.dispatchMouseEvent mouseWheel).
  await page.mouse.move(point.x, point.y); await sleep(200);
  await page.mouse.wheel(0, 400); await sleep(1200);
  out.wheelPlaywright = { scrollTop: await scrollTop(), hostWheelEvents: (await page.evaluate(() => window.__wheel.length)), frameWheelEvents: await frame.evaluate(() => window.__wheel.length) };
  await reset();
  // (1b) Repeated wheel ticks.
  for (let i = 0; i < 5; i += 1) { await page.mouse.wheel(0, 120); await sleep(120); }
  await sleep(800);
  out.wheelRepeated = { scrollTop: await scrollTop(), hostWheelEvents: (await page.evaluate(() => window.__wheel.length)), frameWheelEvents: await frame.evaluate(() => window.__wheel.length) };
  await reset();
  // (1c) Synthesized gesture scroll (trackpad-like), dispatched through the browser's gesture pipeline.
  const session = await context.newCDPSession(page);
  try {
    await session.send('Input.synthesizeScrollGesture', { x: point.x, y: point.y, yDistance: -400, gestureSourceType: 'mouse', speed: 1200 });
    await sleep(800);
    out.gestureMouse = { scrollTop: await scrollTop(), hostWheelEvents: (await page.evaluate(() => window.__wheel.length)), frameWheelEvents: await frame.evaluate(() => window.__wheel.length) };
  } catch (error) { out.gestureMouse = { error: String(error).split('\n')[0] }; }
  await reset();
  try {
    await session.send('Input.synthesizeScrollGesture', { x: point.x, y: point.y, yDistance: -400, gestureSourceType: 'touch', speed: 1200 });
    await sleep(800);
    out.gestureTouch = { scrollTop: await scrollTop() };
  } catch (error) { out.gestureTouch = { error: String(error).split('\n')[0] }; }
  await reset();
  // (1d) Control: the same wheel with the frame unclipped must NOT scroll the view (the frame takes it).
  await page.evaluate(() => window.__setClipEnabled(false)); await sleep(300);
  await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 400); await sleep(1000);
  out.wheelUnclippedControl = { scrollTop: await scrollTop(), hostWheelEvents: (await page.evaluate(() => window.__wheel.length)), frameWheelEvents: await frame.evaluate(() => window.__wheel.length) };
  await reset();
  // (1e) Keyboard scrolling of the focused view (PageDown) after clicking into it.
  await page.evaluate(() => window.__setClipEnabled(true)); await sleep(300);
  await page.mouse.click(point.x, point.y); await sleep(100);
  await page.keyboard.press('PageDown'); await sleep(600);
  out.keyboardPageDown = { scrollTop: await scrollTop() };
  await reset();

  // (2) Stale hit-test window after re-applying the clip: click `delay` ms after the clip returns.
  const delays = [0, 4, 8, 16, 24, 33, 50, 75, 100, 150];
  const rounds = 6; const table = {};
  for (const delay of delays) {
    let through = 0;
    for (let i = 0; i < rounds; i += 1) {
      await page.evaluate(() => window.__setClipEnabled(false)); await sleep(200);
      const before = await page.evaluate(() => window.__clicks.length);
      // Re-apply the clip inside the page, then click from the driver after `delay` ms.
      await page.evaluate(() => { window.__setClipEnabled(true); window.__clipAt = performance.now(); });
      if (delay > 0) await sleep(delay);
      await page.mouse.click(point.x, point.y + 40);
      await sleep(120);
      if ((await page.evaluate(() => window.__clicks.length)) > before) through += 1;
    }
    table[delay] = `${through}/${rounds}`;
  }
  out.clickAfterClipRestoreMs = table;
  // Same for lifting: after removing the clip, how soon does the frame take input?
  const liftTable = {};
  await frame.evaluate(() => { window.__content = []; document.getElementById('content').addEventListener('pointerdown', () => window.__content.push(performance.now())); });
  for (const delay of [0, 8, 16, 33, 50, 100]) {
    let taken = 0;
    for (let i = 0; i < rounds; i += 1) {
      await page.evaluate(() => window.__setClipEnabled(true)); await sleep(200);
      const before = await frame.evaluate(() => window.__content.length);
      await page.evaluate(() => window.__setClipEnabled(false));
      if (delay > 0) await sleep(delay);
      await page.mouse.click(point.x, point.y + 40);
      await sleep(120);
      if ((await frame.evaluate(() => window.__content.length)) > before) taken += 1;
    }
    liftTable[delay] = `${taken}/${rounds}`;
  }
  out.frameTakesClickAfterLiftMs = liftTable;
} catch (error) { out.error = String(error?.stack || error); }
finally {
  out.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.join(here, 'results'), { recursive: true });
  fs.writeFileSync(path.join(here, 'results', `${target}-probe-input.json`), `${JSON.stringify(out, null, 2)}\n`);
  console.log(JSON.stringify(out, null, 1));
  await context?.close().catch(() => {});
  servers.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
