// REQ-6 spike, layered variant (throwaway; not product code).
// The view sits ABOVE the transparent frame by z-order. A blocking overlay raises the frame; a
// non-blocking notice shows through a hole cut in the view. Records results under ./results/.
// Usage: node run-layered.mjs <edge|cft>-ext | <chrome|edge|cft>-web
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { startServers } from './server.mjs';
import { decodePng } from './png.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const forkRoot = path.resolve(here, '../../../..');
const require = createRequire(path.join(forkRoot, 'extension', 'package.json'));
const { chromium } = require('playwright');
const target = process.argv[2];
const [browserName, mode] = (target || '').split('-');
if (!['edge', 'cft', 'chrome'].includes(browserName) || !['ext', 'web'].includes(mode)) { console.error('usage: node run-layered.mjs <edge|cft|chrome>-<ext|web>'); process.exit(2); }
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
const results = path.join(here, 'results'); fs.mkdirSync(results, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, accept, timeout = 15_000, label = 'condition') {
  const start = Date.now(); let last;
  do { last = await read(); if (accept(last)) return last; await sleep(40); } while (Date.now() - start < timeout);
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}
const VIEW = { width: 1280, height: 800 };
const isGreen = ([r, g, b]) => g > r + 40 && g > b + 20;
const isYellow = ([r, g, b]) => r > 200 && g > 170 && b < 90;
const isPurple = ([r, g, b]) => r > 90 && g < 40 && b > 120;
const servers = await startServers();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'req6-layered-'));
const extDir = path.join(here, 'ext');
const out = { target, variant: 'layered', executablePath, startedAt: new Date().toISOString(), checks: {}, errors: [] };
let context;
try {
  const args = ['--headless=new', '--no-first-run', '--no-default-browser-check'];
  if (mode === 'ext') args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: VIEW, deviceScaleFactor: 1, args });
  out.browserVersion = context.browser()?.version() ?? 'unknown';
  let hostBase; const frameOrigin = servers.ipOrigin; let nestedOrigin;
  if (mode === 'ext') {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    hostBase = `chrome-extension://${new URL(worker.url()).host}/host.html`; nestedOrigin = servers.nameOrigin;
  } else { hostBase = `${servers.nameOrigin}/host.html`; nestedOrigin = servers.ipOrigin; }
  const hostOrigin = hostBase.slice(0, hostBase.indexOf('/host.html'));
  async function open(query = {}) {
    const page = await context.newPage();
    await page.goto(`${hostBase}?${new URLSearchParams({ frame: frameOrigin, nested: nestedOrigin, layer: '1', notices: 'regions', ...query })}`);
    await until(() => page.evaluate(() => Boolean(window.__state?.ready && window.__state.slot && window.__state.clipped)), Boolean, 20_000, 'host handshake');
    const frame = await until(() => Promise.resolve(page.frames().find((item) => item.url().startsWith(`${frameOrigin}/frame.html`))), Boolean, 10_000, 'frame');
    const nested = await until(() => Promise.resolve(page.frames().find((item) => item.url().startsWith(`${nestedOrigin}/nested.html`))), Boolean, 10_000, 'nested');
    await nested.waitForSelector('#provider-input');
    return { page, frame, nested };
  }
  const hostLog = (page) => page.evaluate(() => window.__log.slice());
  const frameLog = (frame) => frame.evaluate(() => window.__flog.slice());
  const count = async (page, kind) => (await hostLog(page)).filter((e) => e.kind === kind).length;
  const pixel = async (page, x, y) => decodePng(await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } })).at(0, 0);
  const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const rectOf = (scope, selector) => scope.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, selector);
  const scrollTop = (page) => page.evaluate(() => document.getElementById('view').scrollTop);
  const resetScroll = (page) => page.evaluate(() => { document.getElementById('view').scrollTop = 0; });

  // ---- L1: steady state. Plain z-order: the view takes input in its rectangle, the frame elsewhere.
  {
    const { page, frame, nested } = await open();
    const steps = {};
    const slot = await page.evaluate(() => window.__state.slot);
    const underlay = center(await rectOf(page, '#underlay'));
    await page.mouse.click(underlay.x, underlay.y); await sleep(150);
    steps.viewClickable = (await count(page, 'underlay-click')) === 1;
    const frameBtn = center(await rectOf(frame, '#frame-btn'));
    await page.mouse.click(frameBtn.x, frameBtn.y); await sleep(150);
    steps.frameSidebarClickable = (await frameLog(frame)).some((e) => e.kind === 'frame-btn-click');
    const inContent = center(await rectOf(frame, '#in-content'));
    await page.mouse.click(inContent.x, inContent.y); await sleep(150);
    steps.frameContentCoveredByView = !(await frameLog(frame)).some((e) => e.kind === 'in-content-click');
    const point = { x: slot.x + slot.width - 60, y: slot.y + 200 };
    await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, 400); await sleep(900);
    steps.wheelScrollsView = (await scrollTop(page)) > 0; steps.wheelScrollTop = await scrollTop(page);
    await resetScroll(page);
    const session = await context.newCDPSession(page);
    try { await session.send('Input.synthesizeScrollGesture', { x: point.x, y: point.y, yDistance: -400, gestureSourceType: 'mouse', speed: 1200 }); await sleep(600); steps.gestureScrollsView = (await scrollTop(page)) > 0; }
    catch (error) { steps.gestureScrollsView = false; steps.gestureError = String(error).split('\n')[0]; }
    await resetScroll(page); await sleep(500);
    const providerInput = center(await rectOf(nested, '#provider-input'));
    const nestedBox = await rectOf(page, '#nested');
    await page.mouse.click(nestedBox.x + providerInput.x, nestedBox.y + providerInput.y); await sleep(150);
    await page.keyboard.type('p'); await sleep(120);
    steps.nestedProviderFrameReceivesInput = (await nested.evaluate(() => document.getElementById('provider-input').value)) === 'p';
    steps.viewVisible = isGreen(await pixel(page, slot.x + 30, slot.y + slot.height - 30));
    await page.screenshot({ path: path.join(results, `${target}-layered-steady.png`) });
    const { wheelScrollTop, gestureError, ...gates } = steps;
    out.checks.l1 = { name: 'Steady state: the view above the transparent frame takes clicks, wheel and gesture scrolling; the frame keeps its sidebar', pass: Object.values(gates).every(Boolean), steps };
    await page.close();
  }

  // ---- L2: blocking overlay raises the frame; focus goes in and comes back; no frame without view or overlay.
  async function overlayRun(query, cycles = 8) {
    const { page, frame } = await open(query);
    const steps = {};
    const slot = await page.evaluate(() => window.__state.slot);
    const editor = center(await rectOf(page, '#editor'));
    await page.mouse.click(editor.x, editor.y); await page.keyboard.type('abc'); await sleep(100);
    await page.keyboard.press('Meta+k');
    await until(() => frame.evaluate(() => document.getElementById('dialog').open), Boolean, 5_000, 'dialog open');
    await sleep(200);
    const dialogRect = await rectOf(frame, '#dialog');
    steps.frameRaised = (await page.evaluate(() => document.getElementById('paperclip').style.zIndex)) === '30';
    steps.dialogVisible = isYellow(await pixel(page, dialogRect.x + 8, dialogRect.y + 8));
    steps.viewVisibleBeneathOverlay = isGreen(await pixel(page, slot.x + 30, slot.y + slot.height - 30));
    steps.hostActiveIsFrame = (await page.evaluate(() => window.__active())) === 'paperclip';
    await page.keyboard.type('xyz'); await sleep(100);
    steps.dialogReceivedTyping = (await frame.evaluate(() => document.getElementById('dialog-input').value)) === 'xyz';
    await page.screenshot({ path: path.join(results, `${target}-layered-overlay.png`) });
    const before = await scrollTop(page);
    await page.mouse.move(slot.x + slot.width - 60, slot.y + 200); await page.mouse.wheel(0, 300); await sleep(500);
    steps.viewDoesNotScrollUnderModal = (await scrollTop(page)) === before;
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'frame lowered');
    await sleep(150);
    steps.frameLowered = (await page.evaluate(() => document.getElementById('paperclip').style.zIndex)) === '10';
    steps.focusReturnedToViewEditor = (await page.evaluate(() => window.__active())) === 'editor';
    await page.keyboard.type('def'); await sleep(100);
    steps.viewEditorTypedAfterClose = (await page.evaluate(() => document.getElementById('editor').value)) === 'abcdef';
    // Every presented frame across open/close cycles.
    const session = await context.newCDPSession(page);
    const frames = [];
    session.on('Page.screencastFrame', (event) => { frames.push(event.data); session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); });
    await session.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await sleep(200);
    for (let i = 0; i < cycles; i += 1) {
      await page.evaluate(() => window.__openPalette());
      await until(() => frame.evaluate(() => document.getElementById('dialog').open), Boolean, 5_000, 'dialog open');
      await sleep(120);
      await page.keyboard.press('Escape');
      await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'frame lowered');
      await sleep(120);
    }
    await sleep(200); await session.send('Page.stopScreencast');
    let violations = 0; let withDialog = 0; let withoutDialog = 0;
    for (const data of frames) {
      const png = decodePng(Buffer.from(data, 'base64'));
      const sx = png.width / VIEW.width; const sy = png.height / VIEW.height;
      const viewVisible = isGreen(png.at((slot.x + 30) * sx, (slot.y + slot.height - 30) * sy));
      const overlayVisible = isYellow(png.at((dialogRect.x + 8) * sx, (dialogRect.y + 8) * sy));
      if (overlayVisible) withDialog += 1; else withoutDialog += 1;
      if (!viewVisible && !overlayVisible) violations += 1;
    }
    await page.close();
    return { query, steps, flash: { framesCaptured: frames.length, framesWithDialog: withDialog, framesWithoutDialog: withoutDialog, violations } };
  }
  {
    const normal = await overlayRun({});
    const delayed = await overlayRun({ restoreDelay: '150' });
    const opaqueControl = await overlayRun({ opaque: '1', restoreDelay: '150' });
    const gate = (run) => Object.values(run.steps).every(Boolean) && run.flash.violations === 0 && run.flash.framesWithDialog > 0 && run.flash.framesWithoutDialog > 0;
    out.checks.l2 = {
      name: 'Blocking overlay: raising the frame shows the overlay over the still-visible view, moves focus in and back, with no frame lacking both',
      pass: gate(normal) && delayed.flash.violations === 0 && opaqueControl.flash.violations > 0,
      note: 'opaqueControl is the negative control (an opaque content area must be detected as a violation); its step results are not gated.',
      detectorProvenByNegativeControl: opaqueControl.flash.violations > 0,
      normal, delayed, opaqueControl: { flash: opaqueControl.flash, viewVisibleBeneathOverlay: opaqueControl.steps.viewVisibleBeneathOverlay },
    };
  }

  // ---- L3: a non-blocking notice shows through a hole in the view while the rest of the view stays live.
  {
    const { page, frame } = await open();
    const steps = {};
    const slot = await page.evaluate(() => window.__state.slot);
    const toastButton = center(await rectOf(frame, '#show-toast'));
    await page.mouse.click(toastButton.x, toastButton.y);
    await until(() => page.evaluate(() => window.__state.regions.length), (n) => n === 1, 5_000, 'notice region reported');
    await sleep(200);
    const toastRect = await rectOf(frame, '#toast');
    steps.frameNotRaisedForNotice = (await page.evaluate(() => document.getElementById('paperclip').style.zIndex)) === '10';
    steps.noticeVisibleThroughHole = isPurple(await pixel(page, toastRect.x + 6, toastRect.y + 6));
    steps.viewVisibleAroundNotice = isGreen(await pixel(page, slot.x + 30, slot.y + slot.height - 30)) && isGreen(await pixel(page, toastRect.x - 12, toastRect.y + 6));
    const underlay = center(await rectOf(page, '#underlay'));
    const clicksBefore = await count(page, 'underlay-click');
    await page.mouse.click(underlay.x, underlay.y); await sleep(150);
    steps.viewClickableWhileNoticeShows = (await count(page, 'underlay-click')) === clicksBefore + 1;
    await page.mouse.move(slot.x + slot.width - 400, slot.y + 200); await page.mouse.wheel(0, 400); await sleep(900);
    steps.viewScrollsWhileNoticeShows = (await scrollTop(page)) > 0;
    await resetScroll(page); await sleep(100);
    await page.screenshot({ path: path.join(results, `${target}-layered-notice.png`) });
    const action = center(await rectOf(frame, '#toast-action'));
    await page.mouse.click(action.x, action.y);
    await until(() => page.evaluate(() => window.__state.regions.length), (n) => n === 0, 5_000, 'notice region cleared');
    steps.noticeActionClickable = (await frameLog(frame)).some((e) => e.kind === 'toast-action');
    await sleep(150);
    const viewClicksBefore = await count(page, 'view-click');
    await page.mouse.click(action.x, action.y); await sleep(150);
    steps.holeClosedAfterNotice = (await count(page, 'view-click')) === viewClicksBefore + 1;
    out.checks.l3 = { name: 'Notice: visible and clickable through a hole in the view while the rest of the view stays clickable and scrollable', pass: Object.values(steps).every(Boolean), steps };
    await page.close();
  }

  // ---- L4: how soon after a raise / lower does input follow the new order.
  {
    const { page, frame } = await open();
    const slot = await page.evaluate(() => window.__state.slot);
    const point = { x: slot.x + slot.width - 60, y: slot.y + 240 };
    await frame.evaluate(() => { window.__content = 0; document.addEventListener('pointerdown', () => { window.__content += 1; }); });
    const rounds = 6; const afterLower = {}; const afterRaise = {};
    for (const delay of [0, 4, 8, 16, 33, 50, 100]) {
      let viewTook = 0; let frameTook = 0;
      for (let i = 0; i < rounds; i += 1) {
        await page.evaluate(() => window.__forceOverlay(true)); await sleep(180);
        const before = await count(page, 'view-click');
        await page.evaluate(() => window.__forceOverlay(false));
        if (delay) await sleep(delay);
        await page.mouse.click(point.x, point.y); await sleep(110);
        if ((await count(page, 'view-click')) > before) viewTook += 1;
        await sleep(120);
        const frameBefore = await frame.evaluate(() => window.__content);
        await page.evaluate(() => window.__forceOverlay(true));
        if (delay) await sleep(delay);
        await page.mouse.click(point.x, point.y); await sleep(110);
        if ((await frame.evaluate(() => window.__content)) > frameBefore) frameTook += 1;
        await page.evaluate(() => window.__forceOverlay(false)); await sleep(120);
      }
      afterLower[delay] = `${viewTook}/${rounds}`; afterRaise[delay] = `${frameTook}/${rounds}`;
    }
    const settled = (table) => ['33', '50', '100'].every((key) => table[key] === `${rounds}/${rounds}`);
    out.checks.l4 = { name: 'Input follows a raise or lower within two frames at 60 Hz (33 ms)', pass: settled(afterLower) && settled(afterRaise), viewTakesClickMsAfterLower: afterLower, frameTakesClickMsAfterRaise: afterRaise };
    await page.close();
  }

  // ---- L5: placement accuracy and bad rectangles.
  {
    const { page, frame } = await open();
    const compare = async () => {
      const reported = await rectOf(frame, '#content'); const placed = await rectOf(page, '#view');
      return Math.max(Math.abs(reported.x - placed.x), Math.abs(reported.y - placed.y), Math.abs(reported.x + reported.width - placed.x - placed.width), Math.abs(reported.y + reported.height - placed.y - placed.height));
    };
    const initial = await compare();
    const toggle = center(await rectOf(frame, '#toggle-narrow'));
    await page.mouse.click(toggle.x, toggle.y); await sleep(300);
    const afterSidebarResize = await compare();
    await page.setViewportSize({ width: 1100, height: 700 }); await sleep(400);
    const afterWindowResize = await compare();
    const slotBefore = await page.evaluate(() => window.__state.slot);
    await frame.evaluate((origin) => {
      for (const rect of [{ x: -5, y: 0, width: 100, height: 100 }, { x: 10, y: 10, width: -40, height: 100 }, { x: 10, y: 10, width: 99999, height: 100 }]) parent.postMessage({ source: 'paperclip-ui', v: 1, type: 'slot', view: 'threads', rect }, origin);
    }, hostOrigin);
    await sleep(250);
    const ignored = await count(page, 'slot-ignored');
    const slotAfter = await page.evaluate(() => window.__state.slot);
    out.checks.l5 = { name: 'Placement within 1 CSS pixel after sidebar and window resize; bad rectangles ignored', pass: initial <= 1 && afterSidebarResize <= 1 && afterWindowResize <= 1 && ignored === 3 && JSON.stringify(slotBefore) === JSON.stringify(slotAfter), maxEdgeDeltaPx: { initial, afterSidebarResize, afterWindowResize }, badRectanglesIgnored: ignored };
    await page.close();
  }
} catch (error) { out.errors.push(String(error?.stack || error)); }
finally {
  out.finishedAt = new Date().toISOString();
  out.pass = out.errors.length === 0 && ['l1', 'l2', 'l3', 'l4', 'l5'].every((key) => out.checks[key]?.pass === true);
  fs.writeFileSync(path.join(results, `${target}-layered.json`), `${JSON.stringify(out, null, 2)}\n`);
  await context?.close().catch(() => {});
  servers.close();
  fs.rmSync(profile, { recursive: true, force: true });
  console.log(JSON.stringify({ target, variant: 'layered', browserVersion: out.browserVersion, pass: out.pass, summary: Object.fromEntries(Object.entries(out.checks).map(([key, value]) => [key, value.pass])), errors: out.errors.map((e) => e.split('\n')[0]) }));
}
