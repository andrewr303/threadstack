// REQ-6 five-check spike runner (throwaway; not product code). Records results under ./results/.
// Usage: node run-spike.mjs <edge-ext|cft-ext|chrome-ext|chrome-web|edge-web|cft-web>
// Never uses a user profile: every run gets a fresh temporary profile directory.
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
if (!['edge', 'cft', 'chrome'].includes(browserName) || !['ext', 'web'].includes(mode)) {
  console.error('usage: node run-spike.mjs <edge|cft|chrome>-<ext|web>'); process.exit(2);
}

function cftExecutable() {
  const cache = path.join(os.homedir(), 'Library/Caches/ms-playwright');
  const builds = fs.readdirSync(cache).filter((name) => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
  for (const build of builds) {
    for (const parts of [['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'], ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'], ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium']]) {
      const candidate = path.join(cache, build, ...parts);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('No Playwright Chromium build found.');
}
const executablePath = {
  edge: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  chrome: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  cft: null,
}[browserName] ?? cftExecutable();

const results = path.join(here, 'results');
fs.mkdirSync(results, { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(read, accept, timeout = 15_000, label = 'condition') {
  const start = Date.now(); let last;
  do { last = await read(); if (accept(last)) return last; await sleep(50); } while (Date.now() - start < timeout);
  throw new Error(`${label} timed out: ${JSON.stringify(last)}`);
}

const VIEW = { width: 1280, height: 800 };
const isGreen = ([r, g, b]) => g > r + 40 && g > b + 20;
const isYellow = ([r, g, b]) => r > 200 && g > 170 && b < 90;
const isSidebar = ([r, g, b]) => Math.abs(r - 30) < 12 && Math.abs(g - 40) < 12 && Math.abs(b - 60) < 12;

const servers = await startServers();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'req6-spike-'));
const extDir = path.join(here, 'ext');
const out = { target, mode, executablePath, startedAt: new Date().toISOString(), checks: {}, errors: [] };
let context;

try {
  const args = ['--headless=new', '--no-first-run', '--no-default-browser-check'];
  if (mode === 'ext') args.push(`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`);
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, viewport: VIEW, deviceScaleFactor: 1, args });
  out.browserVersion = context.browser()?.version() ?? 'unknown';

  let hostBase; let frameOrigin; let nestedOrigin;
  if (mode === 'ext') {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 20_000 });
    hostBase = `chrome-extension://${new URL(worker.url()).host}/host.html`;
    frameOrigin = servers.ipOrigin; nestedOrigin = servers.nameOrigin;
  } else {
    hostBase = `${servers.nameOrigin}/host.html`;
    frameOrigin = servers.ipOrigin; nestedOrigin = servers.ipOrigin;
  }
  // `new URL('chrome-extension://…').origin` is "null" in Node, so derive the origin textually.
  out.hostOrigin = hostBase.slice(0, hostBase.indexOf('/host.html')); out.frameOrigin = frameOrigin; out.nestedOrigin = nestedOrigin;

  async function open(query = {}) {
    const page = await context.newPage();
    const search = new URLSearchParams({ frame: frameOrigin, nested: nestedOrigin, ...query });
    await page.goto(`${hostBase}?${search}`);
    await until(() => page.evaluate(() => Boolean(window.__state?.ready && window.__state.slot)), Boolean, 20_000, 'host handshake');
    const frame = await until(() => Promise.resolve(page.frames().find((item) => item.url().startsWith(`${frameOrigin}/frame.html`))), Boolean, 10_000, 'frame');
    const nested = await until(() => Promise.resolve(page.frames().find((item) => item.url().startsWith(`${nestedOrigin}/nested.html`))), Boolean, 10_000, 'nested frame');
    await nested.waitForSelector('#provider-input');
    return { page, frame, nested };
  }
  const hostLog = (page) => page.evaluate(() => window.__log.slice());
  const frameLog = (frame) => frame.evaluate(() => window.__flog.slice());
  const pixel = async (page, x, y) => decodePng(await page.screenshot({ clip: { x: Math.round(x), y: Math.round(y), width: 1, height: 1 } })).at(0, 0);
  const center = (rect) => ({ x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 });
  const rectOf = (scope, selector) => scope.evaluate((sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; }, selector);

  // ---- Process isolation of the framed document (fidelity of the hit-testing path).
  {
    const { page } = await open();
    const session = await context.newCDPSession(page);
    const { targetInfos } = await session.send('Target.getTargets');
    out.oopif = targetInfos.filter((info) => info.type === 'iframe').map((info) => new URL(info.url).origin);
    out.frameIsOutOfProcess = out.oopif.includes(frameOrigin);
    await page.close();
  }

  // ---- Check 1: a transparent cross-origin frame shows the element beneath it.
  {
    const matrix = [
      { id: 'default', docScheme: 'none', iframeScheme: 'none', hostScheme: 'none', expectTransparent: true },
      { id: 'doc-dark-unmatched', docScheme: 'dark', iframeScheme: 'none', hostScheme: 'none', expectTransparent: false },
      { id: 'doc-dark-iframe-dark', docScheme: 'dark', iframeScheme: 'dark', hostScheme: 'none', expectTransparent: true },
      { id: 'doc-dark-host-dark', docScheme: 'dark', iframeScheme: 'none', hostScheme: 'dark', expectTransparent: true },
      { id: 'doc-light-host-dark-unmatched', docScheme: 'light', iframeScheme: 'none', hostScheme: 'dark', expectTransparent: false },
      { id: 'doc-light-host-dark-iframe-light', docScheme: 'light', iframeScheme: 'light', hostScheme: 'dark', expectTransparent: true },
    ];
    const rows = [];
    for (const row of matrix) {
      const { page } = await open({ clip: '0', docScheme: row.docScheme, iframeScheme: row.iframeScheme, hostScheme: row.hostScheme });
      const slot = await page.evaluate(() => window.__state.slot);
      const sample = await pixel(page, slot.x + 30, slot.y + slot.height - 30);
      const nav = await pixel(page, 20, slot.y + slot.height - 30);
      rows.push({ ...row, sample, transparent: isGreen(sample), frameSidebarPainted: isSidebar(nav) });
      if (row.id === 'default') await page.screenshot({ path: path.join(results, `${target}-c1-unclipped-transparent.png`) });
      await page.close();
    }
    const required = rows.filter((row) => row.expectTransparent);
    out.checks.c1 = {
      name: 'A cross-origin frame whose page background is transparent shows the element beneath it',
      pass: required.every((row) => row.transparent && row.frameSidebarPainted),
      note: 'Rows with expectTransparent=false document the color-scheme mismatch rule; they are informational and do not gate the check.',
      mismatchRowsBehaveAsExpected: rows.filter((row) => !row.expectTransparent).every((row) => !row.transparent),
      rows,
    };
  }

  // ---- Check 2: clip-path hole passes pointer input to the element beneath; outside reaches the frame.
  {
    const { page, frame, nested } = await open({ clip: '1' });
    await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'clip applied');
    const underlay = center(await rectOf(page, '#underlay'));
    const inContent = center(await rectOf(frame, '#in-content'));
    const frameBtn = center(await rectOf(frame, '#frame-btn'));
    const steps = {};
    await page.mouse.move(underlay.x, underlay.y); await sleep(150);
    await page.mouse.click(underlay.x, underlay.y); await sleep(200);
    let host = await hostLog(page); let inner = await frameLog(frame);
    steps.insideReachesBeneath = host.some((e) => e.kind === 'underlay-click');
    steps.hoverReachesBeneath = host.some((e) => e.kind === 'underlay-hover');
    await page.mouse.click(inContent.x, inContent.y); await sleep(200);
    host = await hostLog(page); inner = await frameLog(frame);
    steps.frameElementInsideHoleNotClicked = !inner.some((e) => e.kind === 'in-content-click');
    steps.viewReceivedClickAtFrameElementPoint = host.some((e) => e.kind === 'view-click' && Math.abs(e.x - inContent.x) < 2 && Math.abs(e.y - inContent.y) < 2);
    await page.mouse.click(frameBtn.x, frameBtn.y); await sleep(200);
    host = await hostLog(page); inner = await frameLog(frame);
    steps.outsideReachesFrame = inner.some((e) => e.kind === 'frame-btn-click');
    steps.outsideNotSeenByView = !host.some((e) => e.kind === 'view-click' && Math.abs(e.x - frameBtn.x) < 2 && Math.abs(e.y - frameBtn.y) < 2);
    const slot = await page.evaluate(() => window.__state.slot);
    await page.mouse.move(slot.x + slot.width - 60, slot.y + 200); await page.mouse.wheel(0, 400); await sleep(400);
    steps.wheelScrollsBeneath = (await page.evaluate(() => document.getElementById('view').scrollTop)) > 0;
    await page.evaluate(() => { document.getElementById('view').scrollTop = 0; }); await sleep(100);
    // Through the hole into a nested cross-site "provider" frame.
    const providerInput = center(await rectOf(nested, '#provider-input'));
    const nestedBox = await rectOf(page, '#nested');
    await page.mouse.click(nestedBox.x + providerInput.x, nestedBox.y + providerInput.y); await sleep(200);
    await page.keyboard.type('p'); await sleep(150);
    steps.nestedProviderFrameReceivesInput = (await nested.evaluate(() => document.getElementById('provider-input').value)) === 'p';
    // Edge of the hole: 2px inside vs 2px outside the left edge.
    const before = (await hostLog(page)).filter((e) => e.kind === 'view-click').length;
    await page.mouse.click(slot.x + 2, slot.y + slot.height - 100); await sleep(150);
    steps.justInsideEdgeReachesView = (await hostLog(page)).filter((e) => e.kind === 'view-click').length === before + 1;
    await page.mouse.click(slot.x - 2, slot.y + slot.height - 100); await sleep(150);
    steps.justOutsideEdgeStaysInFrame = (await hostLog(page)).filter((e) => e.kind === 'view-click').length === before + 1;
    // Control: without the clip the same point is taken by the frame, proving the clip (not transparency) routes input.
    await page.evaluate(() => window.__setClipEnabled(false)); await sleep(150);
    const clicksBefore = (await hostLog(page)).filter((e) => e.kind === 'underlay-click').length;
    await page.mouse.click(underlay.x, underlay.y); await sleep(200);
    steps.controlUnclippedFrameTakesClick = (await hostLog(page)).filter((e) => e.kind === 'underlay-click').length === clicksBefore;
    await page.screenshot({ path: path.join(results, `${target}-c2-clipped.png`) });
    out.checks.c2 = { name: 'With clip-path removing a rectangle from the frame, a click inside reaches the element beneath and a click outside reaches the frame', pass: Object.values(steps).every(Boolean), steps };
    await page.close();
  }

  // ---- Check 4: lifting and restoring the clip causes no visible flash.
  async function flashRun(query, cycles = 8) {
    const { page, frame } = await open({ clip: '1', ...query });
    await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'clip applied');
    const slot = await page.evaluate(() => window.__state.slot);
    await page.evaluate(() => window.__openPalette());
    await until(() => frame.evaluate(() => document.getElementById('dialog').open), Boolean, 5_000, 'dialog open');
    const dialogRect = await rectOf(frame, '#dialog');
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'clip restored');
    const session = await context.newCDPSession(page);
    const frames = [];
    session.on('Page.screencastFrame', (event) => { frames.push({ data: event.data, timestamp: event.metadata.timestamp }); session.send('Page.screencastFrameAck', { sessionId: event.sessionId }).catch(() => {}); });
    await session.send('Page.startScreencast', { format: 'png', everyNthFrame: 1 });
    await sleep(200);
    for (let i = 0; i < cycles; i += 1) {
      await page.evaluate(() => window.__openPalette());
      await until(() => frame.evaluate(() => document.getElementById('dialog').open), Boolean, 5_000, 'dialog open');
      await sleep(120);
      await page.keyboard.press('Escape');
      await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'clip restored');
      await sleep(120);
    }
    await sleep(200);
    await session.send('Page.stopScreencast');
    const pView = { x: slot.x + 30, y: slot.y + slot.height - 30 };
    const pDialog = { x: dialogRect.x + 8, y: dialogRect.y + 8 };
    let violations = 0; let withDialog = 0; let withoutDialog = 0; const violationSamples = [];
    for (const item of frames) {
      const png = decodePng(Buffer.from(item.data, 'base64'));
      const sx = png.width / VIEW.width; const sy = png.height / VIEW.height;
      const viewPixel = png.at(pView.x * sx, pView.y * sy); const dialogPixel = png.at(pDialog.x * sx, pDialog.y * sy);
      const viewVisible = isGreen(viewPixel); const overlayVisible = isYellow(dialogPixel);
      if (overlayVisible) withDialog += 1; else withoutDialog += 1;
      if (!viewVisible && !overlayVisible) { violations += 1; if (violationSamples.length < 5) violationSamples.push({ timestamp: item.timestamp, viewPixel, dialogPixel }); }
    }
    const latencies = (await hostLog(page)).filter((e) => e.kind === 'overlay' && typeof e.latency === 'number').map((e) => e.latency).sort((a, b) => a - b);
    await page.close();
    return { query, cycles, framesCaptured: frames.length, framesWithDialog: withDialog, framesWithoutDialog: withoutDialog, violations, violationSamples, overlayMessageLatencyMs: { median: latencies[Math.floor(latencies.length / 2)] ?? null, max: latencies[latencies.length - 1] ?? null, count: latencies.length } };
  }
  {
    const transparent = await flashRun({});
    const transparentDelayed = await flashRun({ restoreDelay: '150' });
    const opaqueImmediate = await flashRun({ opaque: '1' });
    const opaqueDelayedControl = await flashRun({ opaque: '1', restoreDelay: '150' });
    out.checks.c4 = {
      name: 'Lifting and restoring the clip causes no visible flash for longer than one frame at 60 Hz',
      pass: transparent.violations === 0 && transparentDelayed.violations === 0 && transparent.framesWithDialog > 0 && transparent.framesWithoutDialog > 0 && opaqueDelayedControl.violations > 0,
      rule: 'A violation is a presented frame in which neither the view beneath nor the overlay is visible. Every presented frame is captured through the DevTools screencast, which is stricter than reviewing a 60 Hz recording.',
      detectorProvenByNegativeControl: opaqueDelayedControl.violations > 0,
      transparent, transparentDelayed, opaqueImmediate, opaqueDelayedControl,
    };
  }

  // ---- Check 5: keyboard focus moves to the frame's dialog on open and back to the view on close.
  async function focusRun(focus) {
    const { page, frame, nested } = await open({ clip: '1', focus });
    await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'clip applied');
    const steps = {};
    const editor = center(await rectOf(page, '#editor'));
    await page.mouse.click(editor.x, editor.y); await sleep(150);
    await page.keyboard.type('abc'); await sleep(100);
    steps.viewEditorTypedThroughHole = (await page.evaluate(() => document.getElementById('editor').value)) === 'abc';
    await page.keyboard.press('Meta+k');
    await until(() => frame.evaluate(() => document.getElementById('dialog').open), Boolean, 5_000, 'dialog open');
    await sleep(200);
    steps.shellSawShortcut = (await hostLog(page)).some((e) => e.kind === 'host-shortcut');
    steps.hostActiveIsFrame = (await page.evaluate(() => window.__active())) === 'paperclip';
    steps.frameHasFocus = await frame.evaluate(() => document.hasFocus());
    steps.frameActiveIsDialogInput = (await frame.evaluate(() => document.activeElement && document.activeElement.id)) === 'dialog-input';
    await page.keyboard.type('xyz'); await sleep(100);
    steps.dialogReceivedTyping = (await frame.evaluate(() => document.getElementById('dialog-input').value)) === 'xyz';
    steps.viewEditorUntouchedWhileDialogOpen = (await page.evaluate(() => document.getElementById('editor').value)) === 'abc';
    await page.keyboard.press('Escape');
    await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'clip restored');
    await sleep(150);
    steps.focusReturnedToViewEditor = (await page.evaluate(() => window.__active())) === 'editor';
    await page.keyboard.type('def'); await sleep(100);
    steps.viewEditorTypedAfterClose = (await page.evaluate(() => document.getElementById('editor').value)) === 'abcdef';
    // Dialog opened by a click inside the frame, closed by its own button.
    const openButton = center(await rectOf(frame, '#open-dialog'));
    await page.mouse.click(openButton.x, openButton.y);
    await until(() => frame.evaluate(() => document.getElementById('dialog').open), Boolean, 5_000, 'dialog open by click');
    await sleep(150);
    await page.keyboard.type('q'); await sleep(100);
    steps.clickOpenedDialogReceivedTyping = (await frame.evaluate(() => document.getElementById('dialog-input').value)).endsWith('q');
    const closeButton = center(await rectOf(frame, '#dialog-close'));
    await page.mouse.click(closeButton.x, closeButton.y);
    await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'clip restored after click close');
    await sleep(150);
    await page.keyboard.type('g'); await sleep(100);
    steps.focusReturnedAfterClickClose = (await page.evaluate(() => document.getElementById('editor').value)) === 'abcdefg';
    // A notice over the view: visible, its action clickable, then the view is usable again.
    const toastButton = center(await rectOf(frame, '#show-toast'));
    await page.mouse.click(toastButton.x, toastButton.y);
    await until(() => frame.evaluate(() => document.getElementById('toast').style.display === 'block'), Boolean, 5_000, 'toast shown');
    await sleep(150);
    const toastRect = await rectOf(frame, '#toast');
    const toastPixel = await pixel(page, toastRect.x + 6, toastRect.y + 6);
    steps.noticeVisibleOverView = toastPixel[0] > 90 && toastPixel[1] < 40 && toastPixel[2] > 120;
    const slot = await page.evaluate(() => window.__state.slot);
    steps.viewStillVisibleBeneathNotice = isGreen(await pixel(page, slot.x + 30, slot.y + slot.height - 30));
    await page.screenshot({ path: path.join(results, `${target}-c5-notice-${focus}.png`) });
    const action = center(await rectOf(frame, '#toast-action'));
    await page.mouse.click(action.x, action.y);
    await until(() => page.evaluate(() => window.__state.clipped), Boolean, 5_000, 'clip restored after notice');
    steps.noticeActionClickable = (await frameLog(frame)).some((e) => e.kind === 'toast-action');
    const underlay = center(await rectOf(page, '#underlay'));
    const clicksBefore = (await hostLog(page)).filter((e) => e.kind === 'underlay-click').length;
    await page.mouse.click(underlay.x, underlay.y); await sleep(150);
    steps.viewClickableAfterNotice = (await hostLog(page)).filter((e) => e.kind === 'underlay-click').length === clicksBefore + 1;
    // Focus inside an embedded provider page: the shortcut stays with that page.
    const providerInput = center(await rectOf(nested, '#provider-input'));
    const nestedBox = await rectOf(page, '#nested');
    await page.mouse.click(nestedBox.x + providerInput.x, nestedBox.y + providerInput.y); await sleep(150);
    const shortcutsBefore = (await hostLog(page)).filter((e) => e.kind === 'host-shortcut').length;
    await page.keyboard.press('Meta+k'); await sleep(400);
    steps.providerPageKeepsShortcut = (await hostLog(page)).filter((e) => e.kind === 'host-shortcut').length === shortcutsBefore
      && !(await frame.evaluate(() => document.getElementById('dialog').open))
      && (await nested.evaluate(() => window.__keys.some((k) => k.key.toLowerCase() === 'k' && k.meta)));
    await page.close();
    return { focus, pass: Object.values(steps).every(Boolean), steps };
  }
  {
    const hostDriven = await focusRun('host');
    const frameDriven = await focusRun('frame');
    out.checks.c5 = {
      name: 'Keyboard focus moves from the view beneath to a dialog in the frame when it opens and back when it closes',
      pass: hostDriven.pass,
      note: 'hostDriven (the shell calls iframe.focus() before sending the command) is the design under test. frameDriven (the frame focuses itself) is recorded for information only.',
      hostDriven, frameDriven,
    };
  }

  // ---- Extra: placement accuracy and bad rectangles (feeds AC-9 and AC-11 feasibility).
  {
    const { page, frame } = await open({ clip: '1' });
    const compare = async () => {
      const reported = await rectOf(frame, '#content');
      const placed = await rectOf(page, '#view');
      return { reported, placed, maxEdgeDelta: Math.max(Math.abs(reported.x - placed.x), Math.abs(reported.y - placed.y), Math.abs(reported.x + reported.width - placed.x - placed.width), Math.abs(reported.y + reported.height - placed.y - placed.height)) };
    };
    const initial = await compare();
    const toggle = center(await rectOf(frame, '#toggle-narrow'));
    await page.mouse.click(toggle.x, toggle.y); await sleep(300);
    const afterSidebarResize = await compare();
    await page.setViewportSize({ width: 1100, height: 700 }); await sleep(400);
    const afterWindowResize = await compare();
    const slotBefore = await page.evaluate(() => window.__state.slot);
    await frame.evaluate((origin) => {
      parent.postMessage({ source: 'paperclip-ui', v: 1, type: 'slot', view: 'threads', rect: { x: -5, y: 0, width: 100, height: 100 } }, origin);
      parent.postMessage({ source: 'paperclip-ui', v: 1, type: 'slot', view: 'threads', rect: { x: 10, y: 10, width: -40, height: 100 } }, origin);
      parent.postMessage({ source: 'paperclip-ui', v: 1, type: 'slot', view: 'threads', rect: { x: 10, y: 10, width: 99999, height: 100 } }, origin);
    }, out.hostOrigin);
    await sleep(250);
    const slotAfter = await page.evaluate(() => window.__state.slot);
    const ignored = (await hostLog(page)).filter((e) => e.kind === 'slot-ignored').length;
    out.checks.extra = {
      name: 'Placement accuracy after resize and rejection of bad rectangles (informational for AC-9 and AC-11)',
      pass: initial.maxEdgeDelta <= 1 && afterSidebarResize.maxEdgeDelta <= 1 && afterWindowResize.maxEdgeDelta <= 1 && ignored === 3 && JSON.stringify(slotBefore) === JSON.stringify(slotAfter),
      initial, afterSidebarResize, afterWindowResize, badRectanglesIgnored: ignored,
    };
    await page.close();
  }
} catch (error) {
  out.errors.push(String(error?.stack || error));
} finally {
  out.finishedAt = new Date().toISOString();
  out.pass = out.errors.length === 0 && ['c1', 'c2', 'c4', 'c5'].every((key) => out.checks[key]?.pass === true);
  fs.writeFileSync(path.join(results, `${target}.json`), `${JSON.stringify(out, null, 2)}\n`);
  await context?.close().catch(() => {});
  servers.close();
  fs.rmSync(profile, { recursive: true, force: true });
  const summary = Object.fromEntries(Object.entries(out.checks).map(([key, value]) => [key, value.pass]));
  console.log(JSON.stringify({ target, browserVersion: out.browserVersion, frameIsOutOfProcess: out.frameIsOutOfProcess, pass: out.pass, summary, errors: out.errors.map((e) => e.split('\n')[0]) }));
}
