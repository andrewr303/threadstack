// Real-browser runner for REQ-6 fused mode (ThreadStack views laid inside Paperclip's own window).
// Verification only: it never edits product source. Fresh temp profile, private build, loopback only.
//
//   TK_E2E_DIST=/tmp/tk-fused-build \
//   CHROME_EXECUTABLE_PATH=<Chrome for Testing | Edge> \
//   TK_PAPERCLIP_E2E_OUT=.acceptances/paperclip-merge/round-17 \
//   node scripts/run-paperclip-fused-e2e.mjs
//
// Env: TK_PAPERCLIP_RUNTIME (fixture JSON, default /tmp/threadkeeper-acceptance-runtime.json),
// TK_FUSED_RECOVERY_MARKER (owned stop/start marker, default /tmp/threadkeeper-paperclip-recovery.json),
// TK_FUSED_SKIP_OFFLINE=1 skips the owned-server stop/start case.
// TK_FUSED_DARK=1 emulates the dark OS scheme. TK_FUSED_CASES selects explicit case IDs.
// TK_FUSED_TELEMETRY_ONLY=1 is diagnostic; TK_FUSED_PALETTE_TRIES allows4..16 zero-delay probes.
// TK_FUSED_SPLIT_PROBE=1 enables the declared FIFO transport-delay fault; never final acceptance.
// TK_FUSED_TWO_PRESS_PROBE=1 targets two legitimate presses in one held closing-surface window.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { installFusedInputTelemetry, installSplitPointerInterceptor, runSplitPointerProbe, verifyOutsidePaletteDismiss } from './paperclip-fused-telemetry.mjs';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forkRoot = path.resolve(extensionRoot, '..');
const dist = fs.realpathSync(process.env.TK_E2E_DIST || '/tmp/tk-fused-build');
const live = path.resolve('/Users/andrew/dev/threadkeeper/.output/chrome-mv3');
if (dist === live || dist.startsWith(`${live}${path.sep}`)) throw new Error('Refusing to test the live extension folder.');
if (dist === fs.realpathSync('/tmp/tk-build')) throw new Error('Refusing to touch /tmp/tk-build.');
const fixture = JSON.parse(fs.readFileSync(process.env.TK_PAPERCLIP_RUNTIME || '/tmp/threadkeeper-acceptance-runtime.json', 'utf8'));
const origin = new URL(fixture.origin).origin;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('An isolated loopback Paperclip server is required.');
if (fixture.port !== 3217) throw new Error('Only the disposable port 3217 instance is allowed.');
const marker = process.env.TK_FUSED_RECOVERY_MARKER || '/tmp/threadkeeper-paperclip-recovery.json';
const output = path.resolve(process.env.TK_PAPERCLIP_E2E_OUT || path.join(forkRoot, '.acceptances/paperclip-merge/round-17'));
const telemetryOnly = process.env.TK_FUSED_TELEMETRY_ONLY === '1';
const controlledProbe = process.env.TK_FUSED_SPLIT_PROBE === '1' || process.env.TK_FUSED_TWO_PRESS_PROBE === '1';
if (process.env.TK_FUSED_SPLIT_PROBE === '1' && process.env.TK_FUSED_TWO_PRESS_PROBE === '1') throw new Error('Use one controlled fault probe per round.');
const selectedCases = process.env.TK_FUSED_CASES ? new Set(process.env.TK_FUSED_CASES.split(',').filter(Boolean)) : null;
const colorScheme = process.env.TK_FUSED_DARK === '1' ? 'dark' : 'light';
if (fs.existsSync(path.join(output, 'results.json')) || fs.existsSync(path.join(output, 'seal.json'))) throw new Error('Refusing to overwrite a retained acceptance round.');
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
fs.copyFileSync(fileURLToPath(import.meta.url), path.join(output, 'assets/runner.mjs'));
fs.copyFileSync(new URL('./paperclip-fused-telemetry.mjs', import.meta.url), path.join(output, 'assets/input-telemetry.mjs'));
const prefix = fixture.companyPrefix;
const base = `/${encodeURIComponent(prefix)}`;

const manifestPath = path.join(dist, 'manifest.json');
const originalManifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(originalManifestBytes.toString('utf8'));
if (manifest.key) throw new Error('The isolated test build must not have a stable manifest key.');
const grantedOrigins = ['http://127.0.0.1/*', 'http://localhost/*', 'https://chatgpt.com/*'];
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), ...grantedOrigins])];
const fixtureManifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const diskBuild = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'));
const extensionId = [...crypto.createHash('sha256').update(dist).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
if (!fixture.extensionIds?.includes(extensionId)) throw new Error(`Server does not allow extension ${extensionId}; add it to PAPERCLIP_THREADKEEPER_EXTENSION_IDS and restart.`);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: forkRoot, encoding: 'utf8' }).trim();
const entryUrl = `chrome-extension://${extensionId}/manager.html?surface=page&view=paperclip&pc=${encodeURIComponent(`${base}/threads`)}`;
const directUrl = `chrome-extension://${extensionId}/manager.html?surface=page&view=threads`;
const executablePath = process.env.CHROME_EXECUTABLE_PATH;
if (!executablePath || !fs.existsSync(executablePath)) throw new Error('Set CHROME_EXECUTABLE_PATH to an existing Chrome for Testing or Edge binary.');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-fused-e2e-'));
const cases = [];
const events = [];
const diagnostics = {};
let context, helperContext, page, helper, sw, browserVersion, mainVideoPath;
const syntheticChatHtml = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Create Research Agent Plugin</title><style>
html,body{margin:0;min-height:100%;background:#111310;color:#e9ece7;font:16px/1.6 system-ui}main{max-width:760px;margin:auto;padding:24px}h1{font-size:20px;margin:0 0 24px}article{margin:24px 0}small{color:#b5c0b0}.question{margin-left:18%;padding:14px 20px;background:#28332c;border-radius:20px}footer{position:sticky;bottom:0;padding:16px;background:#111310}textarea{width:100%;box-sizing:border-box;padding:14px;background:#242a25;color:#e9ece7;border:1px solid #526053;border-radius:18px;font:inherit}</style></head><body data-tk-fixture-chat><main><small>Isolated synthetic conversation · no provider account</small><h1>Research workspace layout</h1><article class="question">Keep the navigation and controls compact so I can see more of this conversation.</article><article>The thread title and view controls share one row. Search and session navigation live in one sidebar, leaving the conversation the remaining width.</article><article>These messages are test data. This route is fulfilled locally by the test runner.</article><footer><textarea aria-label="Synthetic chat message" placeholder="Continue the synthetic conversation…"></textarea></footer></main></body></html>`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const record = (kind, detail) => { events.push({ at: new Date().toISOString(), kind, ...detail }); };
const artifactProvenance = {};
const sourceSnapshot = () => {
  const hashes = {};
  const walk = directory => {
    for (const entry of fs.readdirSync(path.join(forkRoot, directory), { withFileTypes: true })) {
      const name = path.posix.join(directory, entry.name);
      if (entry.isDirectory() && !['__tests__', '__snapshots__'].includes(entry.name)) walk(name);
      else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) continue;
      else if (entry.isFile()) hashes[name] = crypto.createHash('sha256').update(fs.readFileSync(path.join(forkRoot, name))).digest('hex');
    }
  };
  for (const directory of ['extension/src', 'ui/src']) walk(directory);
  return hashes;
};
const runtimeSources = sourceSnapshot();
fs.writeFileSync(path.join(output, 'assets/runtime-source-hashes.json'), JSON.stringify(runtimeSources, null, 2));
class Fail extends Error {}
const check = (condition, message, observed) => { if (!condition) throw new Fail(`${message} :: ${JSON.stringify(observed)}`); };
async function until(read, accept, timeout = 30_000, label = 'condition') {
  const start = Date.now(); let last;
  do { last = await read(); if (accept(last)) return last; await sleep(120); } while (Date.now() - start < timeout);
  throw new Fail(`Timed out waiting for ${label}: ${JSON.stringify(last)}`);
}
const shot = async (name, target = page) => {
  const file = path.join(output, `${name}.png`);
  const capturedAt = new Date().toISOString();
  await target.screenshot({ path: file });
  const relative = path.relative(output, file);
  artifactProvenance[relative] = { capturedAt, url: target.url(), viewport: target.viewportSize(), tool: 'Playwright Page.screenshot', sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
  return relative;
};

// ---- pixel sampling: decode a screenshot in a throwaway blank page --------------------------------
async function pixels(rects, extra = [], grids = []) {
  const buffer = await page.screenshot();
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  return helper.evaluate(async ({ b64, rects, dpr, extra, grids }) => {
    const img = new Image(); img.src = `data:image/png;base64,${b64}`; await img.decode();
    const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0);
    const statsFor = r => {
      const x = Math.max(0, Math.round(r.x * dpr)), y = Math.max(0, Math.round(r.y * dpr));
      const w = Math.max(1, Math.min(img.width - x, Math.round(r.width * dpr))), h = Math.max(1, Math.min(img.height - y, Math.round(r.height * dpr)));
      const data = ctx.getImageData(x, y, w, h).data; const seen = new Set(); let sum = 0, sumSq = 0; const n = data.length / 4;
      for (let i = 0; i < data.length; i += 4) { const l = 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; sum += l; sumSq += l * l; seen.add(`${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`); }
      const mean = sum / n; return { mean: +mean.toFixed(1), std: +Math.sqrt(Math.max(0, sumSq / n - mean * mean)).toFixed(2), distinct: seen.size };
    };
    const at = p => { const d = ctx.getImageData(Math.round(p.x * dpr), Math.round(p.y * dpr), 1, 1).data; return [d[0], d[1], d[2]]; };
    const gridFor = ({ rect, cols, rows }) => {
      const out = [];
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        const x = Math.round((rect.x + (rect.width * i) / cols) * dpr), y = Math.round((rect.y + (rect.height * j) / rows) * dpr);
        const w = Math.max(1, Math.round((rect.width / cols) * dpr)), h = Math.max(1, Math.round((rect.height / rows) * dpr));
        const d = ctx.getImageData(x, y, Math.min(w, img.width - x), Math.min(h, img.height - y)).data; let sum = 0;
        for (let k = 0; k < d.length; k += 4) sum += 0.2126 * d[k] + 0.7152 * d[k + 1] + 0.0722 * d[k + 2];
        out.push(sum / (d.length / 4));
      }
      return out;
    };
    return { stats: rects.map(statsFor), points: extra.map(at), grids: grids.map(gridFor) };
  }, { b64: buffer.toString('base64'), rects, dpr, extra, grids });
}

function correlation(a, b, skip = () => false) {
  const xs = [], ys = [];
  a.forEach((v, i) => { if (!skip(i)) { xs.push(v); ys.push(b[i]); } });
  const n = xs.length, mx = xs.reduce((p, c) => p + c, 0) / n, my = ys.reduce((p, c) => p + c, 0) / n;
  let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
  return { n, r: sxx && syy ? +(sxy / Math.sqrt(sxx * syy)).toFixed(3) : 0, baselineSpread: +Math.sqrt(sxx / n).toFixed(2) };
}

// ---- environment helpers -------------------------------------------------------------------------
const frameOf = () => page.frames().find(f => f.url().startsWith(origin) && f.parentFrame() === page.mainFrame());
async function frame() {
  return until(() => Promise.resolve(frameOf()), Boolean, 45_000, 'Paperclip frame');
}
// All geometry in one place. Everything is in CSS px of the top-level (shell) document; the frame
// is a full-window iframe at 0,0 so frame coordinates equal shell coordinates (asserted).
async function measure() {
  const f = await frame();
  const inFrame = await f.evaluate(() => {
    const rect = e => e ? e.getBoundingClientRect().toJSON() : null;
    const slot = document.querySelector('.threadstack-slot');
    return {
      path: location.pathname, timeOrigin: performance.timeOrigin,
      paperclipTheme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
      slot: rect(slot), slotAttr: document.documentElement.getAttribute('data-threadstack-slot'),
      slotVars: ['--tk-slot-x', '--tk-slot-y', '--tk-slot-w', '--tk-slot-h'].map(k => document.documentElement.style.getPropertyValue(k)),
      viewport: { w: innerWidth, h: innerHeight },
      sidebar: rect(document.querySelector('aside.coordinator-sidebar')),
      nav: [...document.querySelectorAll('nav[aria-label="ThreadStack"] a')].map(a => ({ text: a.textContent.trim(), href: a.getAttribute('href'), rect: rect(a) })),
      current: [...document.querySelectorAll('nav[aria-label="ThreadStack"] a[aria-current]')].map(a => a.textContent.trim()),
    };
  });
  const inShell = await page.evaluate(() => {
    const rect = e => e ? e.getBoundingClientRect().toJSON() : null;
    const vis = e => !!e && !e.hidden && e.getBoundingClientRect().width > 0;
    const wb = document.querySelector('.tk-workbench');
    const frameEl = document.querySelector('iframe[title="Paperclip"]');
    const view = document.querySelector('.tk-view-threads');
    return {
      workbench: wb ? { ...wb.dataset } : null, url: location.search,
      threadStackTheme: document.documentElement.getAttribute('data-theme'),
      shell: rect(document.querySelector('.tk-shell')), shellData: document.querySelector('.tk-shell') ? { ...document.querySelector('.tk-shell').dataset } : null,
      shellStyle: document.querySelector('.tk-shell')?.getAttribute('style') ?? null,
      frameRect: rect(frameEl), frameZ: frameEl ? getComputedStyle(frameEl.closest('.tk-view-paperclip') ?? frameEl).zIndex : null,
      rail: rect(document.querySelector('.tk-shell > .tk-rail')), railVisible: vis(document.querySelector('.tk-shell > .tk-rail')),
      views: Object.fromEntries([...document.querySelectorAll('.tk-main > .tk-view')].map(v => [v.className.replace('tk-view ', '').replace('tk-view-', ''), { hidden: v.hidden, rect: rect(v) }])),
      threadsView: { visible: vis(view), rect: rect(view) },
      rows: document.querySelectorAll('.tk-shell .tk-row-btn').length,
      viewport: { w: innerWidth, h: innerHeight },
    };
  });
  return { ...inFrame, ...inShell };
}
const within = (a, b, tol = 1) => a && b && ['x', 'y', 'width', 'height'].every(k => Math.abs(a[k] - b[k]) <= tol);
const center = r => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 });
// What the user would hit at a point: the top-level element for the shell document.
async function topAt(x, y) {
  return page.evaluate(([x, y]) => {
    const e = document.elementFromPoint(x, y); if (!e) return null;
    return { tag: e.tagName, title: e.getAttribute('title'), cls: String(e.className).slice(0, 80), inThreadsView: !!e.closest('.tk-view-threads, .tk-rail'), inShell: !!e.closest('.tk-shell'), inFrame: e.tagName === 'IFRAME' };
  }, [x, y]);
}
async function waitFusedOn(view = 'threads', timeout = 60_000) {
  return until(async () => {
    const m = await measure().catch(() => null);
    return m && m.workbench?.fused === 'true' && m.shellData?.view === view && m.threadsView.visible ? m : null;
  }, Boolean, timeout, `fused ${view}`);
}
async function resizedFused(width) {
  await page.setViewportSize({ width, height: 900 });
  return until(async () => {
    const state = await measure();
    return state.viewport.w === width && state.frameRect?.width === width && within(state.shell, state.slot, 1) ? state : null;
  }, Boolean, 10_000, `frame and shell placement converged after resize to ${width}`);
}
async function settledLiveFrame() {
  const geometry = await until(() => page.evaluate(() => {
    const slot = document.querySelector('.tk-thr-live');
    const frame = [...document.querySelectorAll('iframe.tk-frame')].find(element => element.src === 'https://chatgpt.com/c/fused_layout_chat' && getComputedStyle(element).display !== 'none');
    return { slot: slot?.getBoundingClientRect().toJSON(), frame: frame?.getBoundingClientRect().toJSON() };
  }), value => within(value.slot, value.frame, 1), 10_000, 'provider frame follows its actual live slot');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return geometry;
}
async function clickFrameLink(href) {
  const f = await frame();
  const link = f.locator(`aside a[href="${href}"]`).first();
  await link.waitFor({ state: 'visible', timeout: 20_000 });
  const r = await link.boundingBox();
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2); // real pointer event at the link
}
async function goThreads() {
  // Reach fused Threads reliably: reuse the live window when it is fused, otherwise enter through the
  // Paperclip view at /THR/threads (the same entry earlier rounds used).
  let m = frameOf() ? await measure().catch(() => null) : null;
  if (!m || m.workbench?.fused !== 'true' || m.workbench?.fusedRaised === 'true' || !m.slot) {
    await page.goto(entryUrl); return waitFusedOn('threads', 90_000);
  }
  if (m.path !== `${base}/threads`) await clickFrameLink(`${base}/threads`);
  return waitFusedOn('threads');
}
async function seedThreads() {
  const now = new Date().toISOString();
  await sw.evaluate(async ({ now }) => {
    const rows = [];
    for (let i = 0; i < 40; i++) {
      const provider = i === 0 ? 'chatgpt' : 'claude_code';
      const accountId = i === 0 ? 'acct_chatgpt_primary' : 'acct_claude_code_primary';
      const sourceConversationId = i === 0 ? 'fused_layout_chat' : `fused_seed_${i}`;
      rows.push({ threadKey: `${provider}:${accountId}:default:${sourceConversationId}:main`, provider, accountId, workspaceId: 'default', sourceConversationId, branchId: 'main', parentBranchId: null, siblingBranchIds: [], canonicalUrl: i === 0 ? 'https://chatgpt.com/c/fused_layout_chat' : `https://claude.ai/code/session_fused_${i}`, title: i === 0 ? 'Create Research Agent Plugin' : `Fused seed thread ${i + 1}`, manualTitleOverride: null, createdAt: now, updatedAt: new Date(Date.now() - i * 60000).toISOString(), lastCapturedAt: now, sourceRevision: 1, contentHash: 'fused-seed', coverage: 'full', captureSource: 'manual', messageCount: 1, project: 'General research', categoryLocked: true, tags: [], manualTags: [], workflowState: 'active', manualNotes: '', pinned: false, snoozedUntil: null, dismissedQueues: [], cloudExcluded: false, cloudTaskStatus: 'unsupported', isSyntheticBenchmark: false, latestDecisionText: null, latestDecisionMsgIndex: null, latestDecisionSpeaker: null, nextStepText: null, nextStepMsgIndex: null, nextStepSpeaker: null, agentState: null });
    }
    await globalThis.__threadStackDb.conversations.bulkPut(rows);
  }, { now });
}

// ---- case runner ---------------------------------------------------------------------------------
async function runCase(id, name, acs, action, prerequisites = ['setup']) {
  if (selectedCases && !selectedCases.has(id)) {
    await notRun(id, name, acs, 'Outside the explicitly selected targeted capture scope.');
    return;
  }
  if (telemetryOnly && !['setup', 'fused-direct-entry', 'fused-palette', 'fused-mobile-entry'].includes(id)) {
    await notRun(id, name, acs, 'Diagnostic run restricted to setup, direct entry, immediate palette input and narrow cold entry.');
    return;
  }
  const blocked = prerequisites.filter(p => cases.find(c => c.id === p)?.status !== 'pass');
  if (blocked.length) { cases.push({ id, name, acs, status: 'not_run', observation: `Prerequisite did not pass: ${blocked.join(', ')}`, evidence: [] }); return; }
  const startedAt = new Date().toISOString();
  const detail = {}; const evidence = [];
  const ctx = { detail, evidence, shot: async (suffix = '') => { evidence.push(await shot(`${id}${suffix}`)); } };
  try {
    const observation = await action(ctx);
    if (!evidence.length) evidence.push(await shot(id));
    cases.push({ id, name, acs, status: 'pass', startedAt, completedAt: new Date().toISOString(), observation, detail, evidence });
  } catch (error) {
    let state = null;
    try { evidence.push(await shot(`${id}-failed`)); state = await measure(); } catch {}
    if (telemetryOnly && id === 'fused-palette') {
      detail.inputAtFailure = {
        shell: await page.evaluate(() => (window.__tkInputTimeline ?? []).slice(-400)).catch(() => []),
        child: await frameOf()?.evaluate(() => (window.__tkInputTimeline ?? []).slice(-400)).catch(() => []),
      };
    }
    // Keep independent cases independent: a failed narrow layout or search assertion must
    // not strand all later cases at a narrow viewport or behind the same query.
    try {
      await page?.keyboard.press('Escape');
      if (page?.viewportSize()?.width !== 1280 || page?.viewportSize()?.height !== 900) await page.setViewportSize({ width: 1280, height: 900 });
      const searchTab = page?.locator('.tk-rail .tk-list-sidebar').getByRole('tab', { name: 'Search', exact: true });
      if (await searchTab?.isVisible()) await searchTab.click({ timeout: 3000 });
      const query = page?.locator('.tk-rail .tk-search-input');
      if (await query?.isVisible()) await query.fill('', { timeout: 3000 });
    } catch (cleanupError) { detail.caseCleanupError = String(cleanupError); }
    // A failed layout assertion during the outage must not leave the disposable service
    // stopped. The watcher still checks port/process ownership before it starts anything.
    if (id === 'fused-offline') {
      try {
        if (JSON.parse(fs.readFileSync(marker, 'utf8')).phase === 'stopped') {
          fs.writeFileSync(marker, JSON.stringify({ phase: 'request_start', at: new Date().toISOString(), reason: 'Restore owned fixture after failed offline case' }));
          const restored = await until(async () => JSON.parse(fs.readFileSync(marker, 'utf8')).phase, value => value === 'started' || value === 'watcher_error', 120_000, 'restore owned service after case failure');
          detail.fixtureRestoredAfterFailure = restored;
        }
      } catch (restoreError) { detail.fixtureRestoreError = String(restoreError); }
    }
    cases.push({ id, name, acs, status: error instanceof Fail ? 'fail' : 'fail', startedAt, completedAt: new Date().toISOString(), observation: error instanceof Fail ? error.message : (error.stack || String(error)), detail, failingState: state, evidence });
  }
  const last = cases.at(-1);
  fs.writeFileSync(path.join(output, `${id}.json`), JSON.stringify(last, null, 2));
  console.log(`[${last.status}] ${id}: ${String(last.observation).slice(0, 220)}`);
}
async function notRun(id, name, acs, reason) {
  const entry = { id, name, acs, status: 'not_run', observation: reason, evidence: [] };
  cases.push(entry); fs.writeFileSync(path.join(output, `${id}.json`), JSON.stringify(entry, null, 2)); console.log(`[not_run] ${id}: ${reason}`);
}

try {
  fs.writeFileSync(manifestPath, fixtureManifestBytes);
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 1280, height: 900 }, colorScheme,
    recordVideo: { dir: path.join(output, 'assets'), size: { width: 1280, height: 900 } },
    args: ['--headless=new', '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  browserVersion = context.browser()?.version() || 'unknown';
  // Reuse the persistent profile's initial page, and do pixel decoding in an unrecorded
  // helper context, so only the actual test page needs continuous video encoding.
  page = context.pages()[0] ?? await context.newPage();
  await context.route(/^https?:\/\//, route => {
    const requested = new URL(route.request().url());
    if (requested.origin === 'https://chatgpt.com' && requested.pathname === '/c/fused_layout_chat' && route.request().isNavigationRequest()) {
      record('synthetic-provider-document', { url: requested.href, note: 'Locally fulfilled test data; no provider connection or real account.' });
      return route.fulfill({ status: 200, contentType: 'text/html; charset=utf-8', body: syntheticChatHtml });
    }
    const hostname = requested.hostname;
    if (['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return route.continue();
    record('blocked-nonfixture-network', { origin: new URL(route.request().url()).origin });
    return route.abort('blockedbyclient');
  });
  // Log shell->page messages and slot attribute changes inside the Paperclip frame (diagnostic only).
  await context.addInitScript(() => {
    try {
      window.__tkLong = [];
      window.__tkLongSupported = PerformanceObserver.supportedEntryTypes.includes('longtask');
      new PerformanceObserver(list => { for (const e of list.getEntries()) window.__tkLong.push(Math.round(e.duration)); }).observe({ type: 'longtask', buffered: true });
    } catch { window.__tkLongSupported = false; }
  });
  if (telemetryOnly || controlledProbe) await installFusedInputTelemetry(context);
  if (controlledProbe) await installSplitPointerInterceptor(context, origin);
  await context.addInitScript(() => {
    if (location.origin !== 'http://127.0.0.1:3217' || window.parent === window) return;
    window.__tkLog = []; const t0 = performance.now();
    window.addEventListener('message', e => { if (e.data && e.data.source === 'threadkeeper-shell') window.__tkLog.push([Math.round(performance.now() - t0), 'msg', JSON.stringify(e.data).slice(0, 160)]); });
    const start = () => new MutationObserver(ms => { for (const m of ms) if (m.attributeName === 'data-threadstack-slot') window.__tkLog.push([Math.round(performance.now() - t0), 'slot-attr', document.documentElement.getAttribute('data-threadstack-slot')]); }).observe(document.documentElement, { attributes: true });
    if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start);
  });
  [sw] = context.serviceWorkers(); if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  check(new URL(sw.url()).host === extensionId, 'Path-derived extension ID loaded', { expected: extensionId, observed: new URL(sw.url()).host });
  const loadedManifest = await sw.evaluate(() => chrome.runtime.getManifest());
  check(loadedManifest.version_name === manifest.version_name, 'Browser manifest matches the build', { disk: manifest.version_name, browser: loadedManifest.version_name });
  helperContext = await context.browser().newContext();
  helper = await helperContext.newPage(); await helper.goto('about:blank');
  mainVideoPath = await page.video()?.path();
  page.on('pageerror', error => record('page-error', { message: error.message }));
  page.on('console', message => { if (message.type() === 'error') record('console-error', { text: message.text().slice(0, 600) }); });

  // ---------------------------------------------------------------- setup (connect through the real Settings UI)
  await runCase('setup', 'Connect through Settings, seed synthetic threads, enter the fused window', ['setup'], async ctx => {
    await page.goto(directUrl); await page.locator('.tk-workbench').waitFor({ state: 'visible' });
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true }); await dialog.waitFor({ state: 'visible' });
    await dialog.locator('#tk-settings-tab-paperclip').click();
    await dialog.getByLabel('Server address', { exact: true }).fill(origin);
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await dialog.getByText(/Found Paperclip.*local trusted mode/).waitFor({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.tk-rail .tk-paperclip-status[data-state="running"]').waitFor({ timeout: 20_000 });
    await seedThreads();
    ctx.detail.extensionId = extensionId;
    return `Connected to ${origin} through Settings; 40 synthetic threads seeded.`;
  }, []);

  // ---------------------------------------------------------------- fused-direct-entry
  await runCase('fused-direct-entry', 'Manager opened at ?view=threads with the server running reaches fused Threads', ['entry'], async ctx => {
    await page.goto(directUrl); await page.locator('.tk-workbench').waitFor();
    const start = Date.now();
    const timeline = [];
    const poll = setInterval(() => { page.evaluate(() => ({ url: location.search, dataset: { ...document.querySelector('.tk-workbench')?.dataset } })).then(v => timeline.push({ t: Date.now() - start, ...v }), () => {}); }, 3_000);
    let m;
    try { m = await until(async () => { const x = await measure().catch(() => null); return x && x.workbench?.fused === 'true' && x.shellData?.view === 'threads' && x.threadsView.visible && x.slot && within(x.shell, x.slot, 1) ? x : null; }, Boolean, 30_000, 'fused Threads from the plain Threads entry'); }
    catch (error) { ctx.detail.timeline = timeline.slice(0, 8); ctx.detail.finalPageUrl = page.url(); ctx.detail.frameUrls = page.frames().map(f => f.url()); ctx.detail.frameDialogs = await (frameOf()?.evaluate(() => [...document.querySelectorAll('[role="dialog"]')].map(d => d.textContent.slice(0, 100))) ?? null).catch(() => null); throw error; }
    finally { clearInterval(poll); }
    ctx.detail.msToFused = Date.now() - start; ctx.detail.url = page.url(); ctx.detail.state = { path: m.path, workbench: m.workbench, shell: m.shell, slot: m.slot };
    check(m.rows >= 30, 'Seeded rows rendered', m.rows);
    return `Opened ${directUrl.split('?')[1]} without visiting the Paperclip view; fused Threads in ${ctx.detail.msToFused} ms (shell within 1 px of slot).`;
  });

  if (process.env.TK_FUSED_SPLIT_PROBE === '1') await runCase('fused-pointer-split-probe', 'Fault probe: native down in the empty childslot, native up in the parent', ['diagnostic'], async ctx => {
    await goThreads();
    await verifyOutsidePaletteDismiss({ page, frame: await frame(), until, check, ctx });
    return runSplitPointerProbe({ page, frame: await frame(), origin, until, check, ctx });
  });
  if (process.env.TK_FUSED_TWO_PRESS_PROBE === '1') await runCase('fused-two-press-probe', 'Fault probe: two distinct native presses on the old childsurface', ['diagnostic'], async ctx => {
    await goThreads();
    await verifyOutsidePaletteDismiss({ page, frame: await frame(), until, check, ctx });
    return runSplitPointerProbe({ page, frame: await frame(), origin, until, check, ctx, twoPresses: true });
  });

  // ---------------------------------------------------------------- fused-palette (AC-4, AC-6)
  await runCase('fused-palette', 'Meta+K from a thread row opens Paperclip palette over the visible view', ['AC-4', 'AC-6'], async ctx => {
    const f0 = async () => frame();
    const selectedIndex = () => page.evaluate(() => [...document.querySelectorAll('.tk-shell .tk-row-btn')].findIndex(b => b.getAttribute('aria-selected') === 'true'));
    async function round({ settle, targetIndex, label }) {
      await goThreads();
      const f = await f0();
      const input = f.locator('[cmdk-input]').first();
      const problems = []; const d = { label, settle };
      const rowRect = await page.evaluate(() => { const l = document.querySelector('.tk-shell .tk-row-list'); l.scrollTop = 0; const b = document.querySelectorAll('.tk-shell .tk-row-btn')[1]; const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
      await page.mouse.click(rowRect.x, rowRect.y);
      const focused = await page.evaluate(() => !!document.activeElement?.closest('.tk-shell .tk-row-btn'));
      if (!focused) problems.push('focus was not on a thread row before Meta+K');
      const view = (await measure()).threadsView.rect;
      const GRID = { cols: 48, rows: 36 };
      const baseGrid = (await pixels([], [], [{ rect: view, ...GRID }])).grids[0];
      await page.keyboard.press('Meta+k');
      const opened = await input.waitFor({ state: 'visible', timeout: 6_000 }).then(() => true, () => false);
      d.opened = opened;
      if (!opened) { problems.push('AC-6: Meta+K with focus on a thread row did not open the palette'); d.problems = problems; return d; }
      await sleep(500);
      const open = await measure(); const pb = await input.boundingBox(); const top = await topAt(pb.x + pb.width / 2, pb.y + pb.height / 2);
      const dialogRect = await f.evaluate(() => document.querySelector('[role="dialog"]')?.getBoundingClientRect().toJSON() ?? null);
      const openGrid = (await pixels([], [], [{ rect: view, ...GRID }])).grids[0];
      const cellRect = i => ({ x: view.x + (view.width * (i % GRID.cols)) / GRID.cols, y: view.y + (view.height * Math.floor(i / GRID.cols)) / GRID.rows, width: view.width / GRID.cols, height: view.height / GRID.rows });
      const overlapsDialog = i => { const c = cellRect(i), r = dialogRect; return !!r && c.x < r.x + r.width + 8 && c.x + c.width > r.x - 8 && c.y < r.y + r.height + 8 && c.y + c.height > r.y - 8; };
      const corr = correlation(baseGrid, openGrid, overlapsDialog);
      d.open = { raised: open.workbench?.fusedRaised, topAtInput: top, threadsViewVisible: open.threadsView.visible, luminanceCorrelationOutsidePalette: corr, slotAttr: open.slotAttr };
      if (settle === false) await ctx.shot('-open');
      if (open.workbench?.fusedRaised !== 'true') problems.push('AC-4: frame not raised for the palette');
      if (!top?.inFrame) problems.push('AC-4: palette not on top at its input');
      if (!(open.threadsView.visible && corr.baselineSpread > 5 && corr.r >= 0.8)) problems.push(`AC-4: the view is not visible under the open palette (luminance correlation ${corr.r}, needs >= 0.8)`);
      await page.keyboard.type('fusedpal', { delay: 20 });
      d.typed = await input.inputValue();
      if (d.typed !== 'fusedpal') problems.push(`AC-4: typing did not reach the palette (value "${d.typed}")`);
      // Find the target before closing. The asserted path must send the click immediately
      // after Escape, without first waiting for the frame, dialog, or its exit animation.
      const p = await page.evaluate(i => { const b = document.querySelectorAll('.tk-shell .tk-row-btn')[i]; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; }, targetIndex);
      await page.keyboard.press('Escape');
      const escAt = Date.now();
      if (settle) {
        await until(async () => (await measure()).workbench?.fusedRaised, v => v === undefined || v === null, 8_000, 'frame lowered').catch(() => problems.push('AC-4: frame stayed raised after Escape'));
        await input.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => problems.push('AC-4: palette did not close on Escape'));
        await sleep(800);
      }
      await page.mouse.click(p.x, p.y);
      d.clickSentAfterEscapeMs = Date.now() - escAt;
      const clickedAt = Date.now();
      d.selected = await until(selectedIndex, v => v === targetIndex, 3_000, 'row selected after Escape').catch(() => selectedIndex());
      d.selectionWaitMs = Date.now() - clickedAt;
      await until(async () => (await measure()).workbench?.fusedRaised, v => v === undefined || v === null, 8_000, 'frame lowered').catch(() => problems.push('AC-4: frame stayed raised after Escape'));
      await input.waitFor({ state: 'hidden', timeout: 8_000 }).catch(() => problems.push('AC-4: palette did not close on Escape'));
      d.closedAfterMs = Date.now() - escAt;
      d.hitAfterClick = await topAt(p.x, p.y);
      if (d.selected !== targetIndex) problems.push(`AC-4: a click right after Escape did not select the row (selected ${d.selected}, wanted ${targetIndex})`);
      d.problems = problems;
      return d;
    }
    const withoutSettle = await round({ settle: false, targetIndex: 4, label: 'asserted: no settle' });
    const withSettle = await round({ settle: true, targetIndex: 5, label: 'control: 800 ms settle after Escape' });
    ctx.detail.withoutSettle = withoutSettle; ctx.detail.withSettle = withSettle;
    // Regression assertion: every zero-delay click must land. Compute the target BEFORE Escape,
    // so no hidden DOM/state wait masks the first pointer event after the close.
    const stats = {};
    const telemetry = [];
    if (telemetryOnly) ctx.detail.inputTimeline = telemetry;
    const preconditions = [];
    ctx.detail.immediateClickPreconditionContract = 'Before Escape: row1 is selected and focused, then the actual focused palette is fully visible and the parent is raised with the iframe on top at its input. No wait follows Escape before the native click.';
    ctx.detail.immediateClickPreconditions = preconditions;
    const zeroTries = telemetryOnly ? Math.min(16, Math.max(4, Number(process.env.TK_FUSED_PALETTE_TRIES) || 4)) : 4;
    for (const delay of [0, 100, 300]) {
      let ok = 0; const tries = delay === 0 ? zeroTries : 4;
      for (let k = 0; k < tries; k++) {
        await goThreads(); const f = await f0(); const input = f.locator('[cmdk-input]').first();
        await page.locator('.tk-shell .tk-row-list').evaluate(list => { list.scrollTop = 0; });
        const resetRow = page.locator('.tk-shell .tk-row-btn').nth(1);
        await resetRow.click(); // Stable/receives-events checks are setup BEFORE Escape.
        await until(selectedIndex, value => value === 1, 5000, 'reset row1 actually selected before opening the palette');
        const resetFocused = await page.locator('.tk-shell .tk-row-btn').nth(1).evaluate(row => row === document.activeElement);
        check(resetFocused, 'Reset row1 has keyboard focus before Meta+K', { delay, attempt: k });
        await page.keyboard.press('Meta+k');
        await input.waitFor({ state: 'visible', timeout: 5000 });
        const inputBox = await input.boundingBox();
        const ready = await until(async () => ({
          child: await f.evaluate(() => {
            const input = document.querySelector('[cmdk-input]'), dialog = input?.closest('[role="dialog"]');
            return { focused: input === document.activeElement, visible: Boolean(input?.getClientRects().length), opacity: dialog ? Number(getComputedStyle(dialog).opacity) : 0 };
          }),
          parent: await page.evaluate(point => ({ raised: document.querySelector('.tk-workbench')?.getAttribute('data-fused-raised'), iframeOwnsPoint: document.elementFromPoint(point.x, point.y)?.tagName === 'IFRAME' }), center(inputBox)),
        }), state => state.child.focused && state.child.visible && state.child.opacity >= 0.99 && state.parent.raised === 'true' && state.parent.iframeOwnsPoint, 5000, 'actual palette ready before Escape');
        preconditions.push({ delay, attempt: k, resetSelected: 1, resetFocused, ready });
        const target = 0;
        const pt = await page.locator('.tk-shell .tk-row-btn').nth(target).boundingBox();
        check(pt && pt.width > 0 && pt.height > 0, 'Immediate click target has a visible box before Escape', pt);
        if (telemetryOnly) {
          const point = center(pt);
          await page.evaluate(value => { window.__tkProbePoint = value; }, point);
          await f.evaluate(value => { window.__tkProbePoint = value; }, point);
        }
        const telemetryStart = Date.now();
        await page.keyboard.press('Escape'); if (delay) await sleep(delay);
        await page.mouse.click(pt.x + pt.width / 2, pt.y + pt.height / 2);
        const landed = await until(selectedIndex, v => v === target, 1_500, 'row').then(() => true, () => false);
        if (landed) ok += 1;
        if (telemetryOnly) {
          const shellEvents = await page.evaluate(start => (window.__tkInputTimeline ?? []).filter(event => event.at >= start - 10), telemetryStart);
          const childEvents = await f.evaluate(start => (window.__tkInputTimeline ?? []).filter(event => event.at >= start - 10), telemetryStart);
          telemetry.push({ delay, attempt: k, target, point: pt, landed, events: [...shellEvents, ...childEvents].sort((a, b) => a.at - b.at) });
        }
      }
      stats[`${delay}ms`] = `${ok}/${tries}`;
    }
    ctx.detail.clickLandsAfterEscape = stats;
    if (telemetryOnly) ctx.detail.inputTimeline = telemetry;
    await verifyOutsidePaletteDismiss({ page, frame: await frame(), until, check, ctx });
    const problems = [...(withoutSettle.problems ?? []).map(x => `[no settle] ${x}`), ...(withSettle.problems ?? []).map(x => `[settle] ${x}`)];
    if (stats['0ms'] !== `${zeroTries}/${zeroTries}`) problems.push(`Immediate click regression: ${stats['0ms']} zero-delay clicks reached the target (expected ${zeroTries}/${zeroTries})`);
    check(problems.length === 0, problems.join('; '), { clickLandsAfterEscape: stats });
    return 'Meta+K from a focused row opened the palette (frame raised, on top, view visible under it by luminance correlation); typing reached it; Escape closed it; a row click right afterwards worked with and without a settle.';
  });


  await runCase('fused-mobile-entry', 'Cold narrow Threads entry fills the mobile slot and keeps one usable Sessions drawer', ['entry', 'UI-sidebar', 'UI-header'], async ctx => {
    const observations = [];
    for (const width of [700, 480]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${directUrl}&threadKey=${encodeURIComponent('chatgpt:acct_chatgpt_primary:default:fused_layout_chat:main')}`);
      const mobile = await until(async () => {
        const state = await measure().catch(() => null);
        return state?.workbench?.fused === 'true' && state.shellData?.view === 'threads' && state.slot?.height > 500 && within(state.shell, state.slot, 1) ? state : null;
      }, Boolean, 30_000, `cold ${width}px entry with a nonzero content slot`);
      const rows = { width, shell: mobile.shell, slot: mobile.slot, frame: mobile.frameRect };
      await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
      const index = page.locator('.tk-rail .tk-list-sidebar');
      const query = index.getByRole('searchbox', { name: 'Search conversations, decisions, and messages', exact: true });
      await query.fill('29');
      await until(() => index.locator('.tk-row-title').first().innerText(), title => title.trim() === 'Fused seed thread 29', 15_000, 'matching session in narrow drawer');
      await ctx.shot(`-${width}-drawer`);
      await index.locator('.tk-row-btn').filter({ hasText: 'Fused seed thread 29' }).click();
      await page.locator('.tk-detail-title').filter({ hasText: 'Fused seed thread 29' }).waitFor({ state: 'visible' });
      rows.selectedTitle = await page.locator('.tk-detail-title').innerText();
      rows.sidebarIndexes = await page.locator('.tk-rail .tk-list-sidebar').count();
      rows.duplicateMainIndexes = await page.locator('.tk-view-threads .tk-list-pane').count();
      check(rows.sidebarIndexes === 1 && rows.duplicateMainIndexes === 0, 'One Sessions drawer selects the chat without a duplicate main list', rows);
      observations.push(rows);
      await ctx.shot(`-${width}-chat`);
    }
    ctx.detail.layouts = observations;
    await resizedFused(1280);
    await page.locator('.tk-rail .tk-search-input').fill('');
    await until(() => page.locator('.tk-shell .tk-row-btn').count(), count => count >= 40, 15_000, 'all sessions restored after narrow search');
    return 'Fresh Threads entries at700px and480px fill a nonzero mobile content slot. The single Sessions drawer searches and opens the matching chat; the main pane remains the selected conversation.';
  });

  // ---------------------------------------------------------------- fused-entries (AC-1)
  await runCase('fused-entries', 'Paperclip sidebar shows Browse, Threads, Session board', ['AC-1'], async ctx => {
    await goThreads();
    const m = await measure();
    const want = [['Browse', `${base}/browse`], ['Threads', `${base}/threads`], ['Session board', `${base}/session-board`]];
    ctx.detail.nav = m.nav;
    for (const [text, href] of want) {
      const item = m.nav.find(n => n.text === text);
      check(item && item.href === href && item.rect.width > 0 && item.rect.x + item.rect.width <= m.sidebar.x + m.sidebar.width + 1, `Sidebar entry ${text} -> ${href}`, m.nav);
    }
    check(m.nav.length === 3, 'Exactly three ThreadStack entries', m.nav);
    ctx.detail.navigation = [];
    for (const [text, href, view] of [['Browse', `${base}/browse`, 'browse'], ['Session board', `${base}/session-board`, 'dashboard'], ['Threads', `${base}/threads`, 'threads']]) {
      await clickFrameLink(href);
      const after = await until(async () => { const s = await measure(); return s.path === href && s.shellData?.view === view && s.workbench?.fused === 'true' ? s : null; }, Boolean, 20_000, `${text} placed`);
      ctx.detail.navigation.push({ clicked: text, framePath: after.path, shellView: after.shellData.view, slot: after.slot, shell: after.shell });
      await ctx.shot(`-${view}`);
    }
    return `Sidebar lists ${m.nav.map(n => `${n.text} (${n.href})`).join(', ')}; a real click on each reached its path and the matching shell view.`;
  });

  // ---------------------------------------------------------------- fused-in-place (AC-3, AC-7)
  await runCase('fused-in-place', 'Threads view inside the content rectangle; one switch; no reload', ['AC-3', 'AC-7'], async ctx => {
    await goThreads();
    const f = await frame();
    await page.evaluate(() => { document.querySelector('.tk-view-threads').__tkProbe = 'same-node'; });
    const timeOrigin = await f.evaluate(() => performance.timeOrigin);
    const m = await measure();
    const inside = m.shell.x >= m.slot.x - 1 && m.shell.y >= m.slot.y - 1 && m.shell.x + m.shell.width <= m.slot.x + m.slot.width + 1 && m.shell.y + m.shell.height <= m.slot.y + m.slot.height + 1;
    check(m.threadsView.visible && m.rows >= 30, 'Threads view with rows visible', { visible: m.threadsView.visible, rows: m.rows });
    check(inside, 'Threads view (shell) lies inside the slot rectangle', { shell: m.shell, slot: m.slot });
    const sidebarLink = m.nav.find(n => n.text === 'Threads').rect; const c = center(sidebarLink);
    const hit = await topAt(c.x, c.y);
    check(hit?.inFrame && m.sidebar.width > 100, "Paperclip's sidebar is visible and on top at its own entries", { hit, sidebar: m.sidebar });
    // Exactly one switch in the window: shell switches (radiogroup View, nav Views, rail buttons) + Paperclip nav.
    const switches = await page.evaluate(() => {
      const names = /^(Browse|Threads|Dashboard|Session board|Paperclip)$/;
      const visible = e => { const r = e.getBoundingClientRect(); const s = getComputedStyle(e); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && !e.closest('[hidden]'); };
      const shell = [...document.querySelectorAll('.tk-workbench [role="radiogroup"][aria-label="View"], .tk-workbench nav[aria-label="Views"]')].filter(visible).map(e => e.getAttribute('aria-label'));
      const named = [...document.querySelectorAll('.tk-shell button, .tk-shell [role="radio"], .tk-shell [role="tab"], .tk-shell a')].filter(e => visible(e) && names.test((e.getAttribute('aria-label') || e.textContent).trim())).map(e => `${e.tagName}:${(e.getAttribute('aria-label') || e.textContent).trim()}`);
      return { shellGroups: shell, shellNamed: named };
    });
    const frameNavGroups = await f.evaluate(() => [...document.querySelectorAll('nav[aria-label="ThreadStack"]')].filter(n => n.getBoundingClientRect().width > 0).length);
    ctx.detail.switches = { ...switches, paperclipNavGroups: frameNavGroups };
    check(switches.shellGroups.length === 0 && switches.shellNamed.length === 0 && frameNavGroups === 1, 'Exactly one view switch in the window (Paperclip sidebar group)', ctx.detail.switches);
    await ctx.shot('-threads');
    // Round trip: Paperclip page and back.
    await clickFrameLink(`${base}/issues`);
    const away = await until(async () => { const s = await measure(); return s.path === `${base}/issues` ? s : null; }, Boolean, 20_000, 'Tasks page');
    const keepsNode = await page.evaluate(() => document.querySelector('.tk-view-threads')?.__tkProbe === 'same-node');
    ctx.detail.onPaperclipPage = { path: away.path, workbench: away.workbench, threadsViewVisible: away.threadsView.visible, nodeStillConnected: keepsNode };
    await ctx.shot('-paperclip-page');
    await clickFrameLink(`${base}/threads`);
    const back = await waitFusedOn('threads');
    const sameNode = await page.evaluate(() => document.querySelector('.tk-view-threads')?.__tkProbe === 'same-node');
    const timeOriginAfter = await (await frame()).evaluate(() => performance.timeOrigin);
    ctx.detail.roundTrip = { timeOrigin, timeOriginAfter, sameNode };
    check(sameNode, 'Same view DOM node after Paperclip page round trip', ctx.detail.roundTrip);
    check(timeOrigin === timeOriginAfter, 'Same Paperclip document (performance.timeOrigin) after round trip', ctx.detail.roundTrip);
    check(back.rows >= 30, 'Rows still rendered', back.rows);
    return 'Threads view lies inside the slot with Paperclip sidebar on top at its entries; one switch group (Paperclip nav) and none in the shell; same view node and same frame timeOrigin after Tasks and back.';
  });

  // ---------------------------------------------------------------- fused-placement (AC-9)
  await runCase('fused-placement', 'View edges follow the slot through resize and sidebar changes', ['AC-9'], async ctx => {
    await goThreads();
    const steps = [];
    const sample = async label => {
      await sleep(900); // let ResizeObserver, the host message and the shell layout settle
      const m = await until(async () => { const s = await measure(); return within(s.shell, s.slot, 1) ? s : s; }, s => within(s.shell, s.slot, 1), 4_000, 'placement').catch(() => measure());
      const entry = { label, viewport: m.viewport, slot: m.slot, shell: m.shell, withinOnePx: within(m.shell, m.slot, 1), delta: m.slot && m.shell ? ['x', 'y', 'width', 'height'].map(k => +(m.shell[k] - m.slot[k]).toFixed(2)) : null, slotAttr: m.slotAttr };
      steps.push(entry); return entry;
    };
    await sample('initial');
    await page.setViewportSize({ width: 1000, height: 700 }); await sample('viewport 1000x700'); await ctx.shot('-1000x700');
    await page.setViewportSize({ width: 1440, height: 860 }); await sample('viewport 1440x860');
    await page.setViewportSize({ width: 1280, height: 900 }); await sample('viewport 1280x900');
    // Resize Paperclip's sidebar with a real pointer drag on its separator.
    const f = await frame();
    const sep = f.locator('[role="separator"][aria-label="Resize sidebar"]').first();
    if (await sep.count()) {
      const b = await sep.boundingBox();
      const x = b.x + 1, y = b.y + b.height / 2; // the leftmost px stays outside the shell, which starts at the slot edge
      await page.mouse.move(x, y); await page.mouse.down(); await page.mouse.move(x + 40, y, { steps: 5 }); await page.mouse.move(x + 90, y, { steps: 5 }); await page.mouse.up();
      await sample('sidebar dragged wider');
      await page.mouse.move(x + 90, y); await page.mouse.down(); await page.mouse.move(x - 10, y, { steps: 8 }); await page.mouse.up();
      await sample('sidebar dragged narrower');
    } else steps.push({ label: 'sidebar drag', skipped: 'no resize separator found' });
    // Collapse and expand with Paperclip's own `[` shortcut (focus is in the frame after a link click).
    await clickFrameLink(`${base}/threads`);
    await page.keyboard.press('[');
    await sample('sidebar collapsed ([)'); await ctx.shot('-collapsed');
    await page.keyboard.press('[');
    await sample('sidebar expanded ([)');
    ctx.detail.steps = steps;
    const widths = new Set(steps.filter(s => s.slot).map(s => Math.round(s.slot.width)));
    const bad = steps.filter(s => s.slot && !s.withinOnePx);
    check(widths.size >= 4, 'The slot actually changed size across steps (test is not vacuous)', [...widths]);
    check(bad.length === 0, 'Every edge within 1 CSS px of the slot', bad);
    return `${steps.length} placements measured (viewport resizes, sidebar drag, collapse/expand); max edge delta ${Math.max(...steps.filter(s => s.delta).flatMap(s => s.delta.map(Math.abs)))} px.`;
  });

  // ---------------------------------------------------------------- fused-layering (design: transparent after `placed`)
  await runCase('fused-layering', "Paperclip's content rectangle goes transparent after the shell sends placed; opaque again on leaving", ['REQ-6-design'], async ctx => {
    await goThreads();
    const f = await frame();
    const attr = () => f.evaluate(() => document.documentElement.getAttribute('data-threadstack-slot'));
    const t0 = Date.now();
    const onThreads = await until(attr, v => v === 'threads', 5_000, 'data-threadstack-slot=threads').catch(() => attr());
    const log = await f.evaluate(() => window.__tkLog ?? null);
    const placedMessages = (log ?? []).filter(e => e[1] === 'msg' && e[2].includes('"type":"placed"')).map(e => e[2]);
    ctx.detail.onThreads = { attr: onThreads, waitedMs: Date.now() - t0, placedMessagesReceivedByFrame: placedMessages.slice(-4), slotAttrMutations: (log ?? []).filter(e => e[1] === 'slot-attr').slice(-6) };
    await ctx.shot('-threads');
    await clickFrameLink(`${base}/issues`);
    await until(async () => (await measure()).path, v => v === `${base}/issues`, 15_000, 'Tasks page');
    const onTasks = await until(attr, v => v === null, 5_000, 'attribute removed on leaving').catch(() => attr());
    ctx.detail.onTasks = { attr: onTasks };
    await ctx.shot('-tasks');
    await clickFrameLink(`${base}/threads`); await waitFusedOn('threads');
    const back = await until(attr, v => v === 'threads', 5_000, 'attribute set again').catch(() => attr());
    ctx.detail.backOnThreads = { attr: back };
    await clickFrameLink(`${base}/browse`);
    const onBrowse = await until(attr, v => v === 'browse', 5_000, 'attribute browse').catch(() => attr());
    ctx.detail.onBrowse = { attr: onBrowse };
    await clickFrameLink(`${base}/threads`); await waitFusedOn('threads');
    check(onThreads === 'threads', 'data-threadstack-slot="threads" set after placed:threads', ctx.detail);
    check(onTasks === null, 'attribute removed on a Paperclip page', ctx.detail);
    check(back === 'threads' && onBrowse === 'browse', 'attribute follows the placed view on return and on Browse', ctx.detail);
    return `Attribute: threads on Threads, removed on Tasks, threads again on return, browse on Browse (first set after ${ctx.detail.onThreads.waitedMs} ms).`;
  });

  // ---------------------------------------------------------------- fused-input
  await runCase('fused-input', 'Real pointer input: row click, wheel scroll, Paperclip sidebar click', [], async ctx => {
    await goThreads();
    const rowPoint = async index => page.evaluate(i => { const b = document.querySelectorAll('.tk-shell .tk-row-btn')[i]; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, title: b.querySelector('.tk-row-title')?.textContent, selected: b.getAttribute('aria-selected') }; }, index);
    const before = await page.evaluate(() => [...document.querySelectorAll('.tk-shell .tk-row-btn')].findIndex(b => b.getAttribute('aria-selected') === 'true'));
    const target = before === 3 ? 4 : 3;
    const p = await rowPoint(target);
    const hit = await topAt(p.x, p.y);
    ctx.detail.rowHit = hit;
    check(hit?.inThreadsView, 'The row is the top element at its point (not covered by the frame)', hit);
    await page.mouse.click(p.x, p.y);
    const selected = await until(() => page.evaluate(() => [...document.querySelectorAll('.tk-shell .tk-row-btn')].findIndex(b => b.getAttribute('aria-selected') === 'true')), v => v === target, 5_000, 'row selection');
    ctx.detail.selection = { before, target, after: selected, title: p.title };
    // Wheel over the list.
    const list = await page.evaluate(() => { const l = document.querySelector('.tk-shell .tk-row-list'); const r = l.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + Math.min(r.height, 500) / 2, top: l.scrollTop, canScroll: l.scrollHeight > l.clientHeight }; });
    const listHit = await topAt(list.x, list.y);
    check(list.canScroll && listHit?.inThreadsView, 'List is scrollable and on top at the wheel point', { list, listHit });
    await page.mouse.move(list.x, list.y); await page.mouse.wheel(0, 700);
    const scrollTop = await until(() => page.evaluate(() => document.querySelector('.tk-shell .tk-row-list').scrollTop), v => v > 0, 5_000, 'scrollTop > 0');
    ctx.detail.wheel = { before: list.top, after: scrollTop };
    // A Paperclip sidebar item still reaches Paperclip.
    const f = await frame();
    const tasks = f.locator(`aside a[href="${base}/issues"]`).first();
    const b = await tasks.boundingBox();
    const sidebarHit = await topAt(b.x + b.width / 2, b.y + b.height / 2);
    await page.mouse.click(b.x + b.width / 2, b.y + b.height / 2);
    const nav = await until(async () => (await measure()).path, v => v === `${base}/issues`, 15_000, 'Paperclip Tasks route');
    ctx.detail.sidebarClick = { hit: sidebarHit, framePath: nav };
    check(sidebarHit?.inFrame, 'Sidebar item is hit by the frame', sidebarHit);
    await ctx.shot('-on-tasks');
    await clickFrameLink(`${base}/threads`); await waitFusedOn('threads');
    return `Row click selected "${p.title}" (index ${target}); wheel scrolled the list ${list.top} -> ${scrollTop}; sidebar click reached Paperclip (${nav}).`;
  });

  // ---------------------------------------------------------------- compact UI requested in the follow-up
  await runCase('single-session-sidebar', 'One Sessions sidebar owns search, filters, grouping and selection', ['UI-sidebar'], async ctx => {
    await goThreads();
    const index = page.locator('.tk-rail .tk-list-sidebar');
    check(await index.count() === 1 && await page.locator('.tk-view-threads .tk-list-pane').count() === 0,
      'There is exactly one thread index, in the existing Sessions rail', { railIndexes: await index.count(), duplicateMainIndexes: await page.locator('.tk-view-threads .tk-list-pane').count() });
    const query = index.getByRole('searchbox', { name: 'Search conversations, decisions, and messages', exact: true });
    // Local search intentionally matches any query term, so use a unique term rather than
    // incorrectly expecting an AND/substring match for the common words in every seed title.
    await query.fill('29');
    await until(() => index.locator('.tk-row-title').first().innerText(), title => title.trim() === 'Fused seed thread 29', 15_000, 'the matching sidebar session ranks first');
    await index.locator('.tk-row-btn').filter({ hasText: 'Fused seed thread 29' }).click();
    await page.locator('.tk-detail-title').filter({ hasText: 'Fused seed thread 29' }).waitFor();
    ctx.detail.filteredSelection = { query: await query.inputValue(), selectedTitle: await page.locator('.tk-detail-title').innerText(), rows: await index.locator('.tk-row-btn').count() };
    await ctx.shot('-search');
    await query.fill('');
    await until(() => index.locator('.tk-row-btn').count(), n => n >= 40, 15_000, 'all sessions after clearing search');
    const filters = index.getByRole('button', { name: /^Filters(?: · \d+)?$/ });
    await filters.click();
    await index.getByRole('combobox', { name: 'Sort threads', exact: true }).waitFor({ state: 'visible' });
    const grouping = index.getByRole('combobox', { name: 'Group by', exact: true });
    await grouping.selectOption('provider');
    ctx.detail.grouping = await until(() => grouping.inputValue(), value => value === 'provider', 5_000, 'saved provider grouping');
    check(ctx.detail.grouping === 'provider', 'Grouping can be changed within Sessions', ctx.detail);
    await ctx.shot('-filters');
    await grouping.selectOption('none');
    await until(() => grouping.inputValue(), value => value === 'none', 5_000, 'saved ungrouped list');
    await filters.click();
    const selectAll = index.getByRole('checkbox', { name: 'Select all in view', exact: true });
    await selectAll.check();
    ctx.detail.selectedAll = await selectAll.isChecked();
    check(ctx.detail.selectedAll, 'Bulk selection remains reachable in the single Sessions sidebar', ctx.detail);
    await ctx.shot('-bulk');
    await selectAll.uncheck();
    return 'The existing Sessions rail contains the only thread index. Search selected the matching chat, filter/sort/group controls opened there, grouping changed, and Select all remained usable.';
  });

  await runCase('compact-chat-header', 'Title and view tabs share a row; controls use one row; chat receives the remaining space', ['UI-header', 'UI-chat-space'], async ctx => {
    await goThreads();
    await page.locator('.tk-shell .tk-row-btn').filter({ hasText: 'Create Research Agent Plugin' }).click();
    await page.getByRole('radio', { name: 'Live', exact: true }).click();
    const fixtureFrame = () => page.frames().find(f => f.url() === 'https://chatgpt.com/c/fused_layout_chat');
    await until(async () => Boolean(await fixtureFrame()?.locator('[data-tk-fixture-chat]').count()), Boolean, 20_000, 'locally fulfilled synthetic chat frame');
    const layouts = [];
    for (const width of [1600, 1280, 700]) {
      await resizedFused(width);
      const geometry = await until(() => page.evaluate(() => {
        const rect = e => e ? e.getBoundingClientRect().toJSON() : null;
        const header = document.querySelector('.tk-detail-header');
        const controls = document.querySelector('.tk-detail-controls');
        const live = document.querySelector('.tk-thr-livewrap');
        const title = document.querySelector('.tk-detail-title');
        const mode = document.querySelector('.tk-thr-modebar');
        return { viewport: { width: innerWidth, height: innerHeight }, header: rect(header), title: rect(title), mode: rect(mode), controls: rect(controls), controlRects: [...(controls?.children ?? [])].map(rect), controlsOverflow: controls ? { clientWidth: controls.clientWidth, scrollWidth: controls.scrollWidth } : null, live: rect(live), detail: rect(document.querySelector('.tk-detail-pane')), duplicateMainIndexes: document.querySelectorAll('.tk-view-threads .tk-list-pane').length };
      }), g => g.live?.height > 300 && g.header?.height > 0, 10_000, `live geometry at ${width}`);
      layouts.push(geometry);
      check(Math.abs(geometry.title.y + geometry.title.height / 2 - geometry.mode.y - geometry.mode.height / 2) <= 2,
        `Title and Summary/Live/Split are vertically aligned in one row at ${width}`, geometry);
      check(geometry.controlRects.every(r => Math.abs(r.y + r.height / 2 - geometry.controls.y - geometry.controls.height / 2) <= 8),
        `Category, lock, status and actions remain on one row at ${width}`, geometry);
      check(geometry.header.height <= 160 && geometry.live.height >= 580,
        `The compact header leaves at least 580px of a 900px window for live chat at ${width}`, geometry);
      check(geometry.duplicateMainIndexes === 0, 'Chat pane is not split by a duplicate list column', geometry);
      geometry.liveFrame = await settledLiveFrame();
      await ctx.shot(`-${width}`);
    }
    ctx.detail.layouts = layouts;
    ctx.detail.providerFixture = 'Synthetic HTML served by the browser runner at one known ChatGPT-shaped test URL. No real provider account or network access.';
    await resizedFused(1280);
    const taskLinks = page.getByRole('button', { name: 'Task links', exact: true });
    await taskLinks.click();
    const taskDialog = page.getByRole('dialog', { name: 'Task and session links', exact: true });
    await taskDialog.waitFor({ state: 'visible' });
    ctx.detail.taskLinksComputedStyle = await taskDialog.evaluate(async dialog => {
      const finite = animation => Number.isFinite(animation.effect?.getComputedTiming().endTime);
      await Promise.all(dialog.getAnimations({ subtree: true }).filter(finite).map(animation => animation.finished.catch(() => {})));
      const style = getComputedStyle(dialog), backdrop = getComputedStyle(dialog, '::backdrop');
      return { backgroundColor: style.backgroundColor, opacity: style.opacity, animationName: style.animationName, backdrop: { backgroundColor: backdrop.backgroundColor, opacity: backdrop.opacity }, activeFiniteAnimations: dialog.getAnimations({ subtree: true }).filter(animation => finite(animation) && animation.playState === 'running').length };
    });
    const taskBox = await taskDialog.boundingBox();
    ctx.detail.taskLinksDialogOnTop = await page.evaluate(({ x, y }) => Boolean(document.elementFromPoint(x, y)?.closest('dialog')), center(taskBox));
    check(ctx.detail.taskLinksDialogOnTop, 'Task links opens above the live provider frame', ctx.detail);
    await ctx.shot('-task-links');
    await page.keyboard.press('Escape');
    await taskDialog.waitFor({ state: 'hidden' });
    ctx.detail.taskLinksFocusReturned = await taskLinks.evaluate(element => element === document.activeElement);
    check(ctx.detail.taskLinksFocusReturned, 'Escape closes Task links and returns focus to its single-row trigger', ctx.detail);
    await page.getByRole('radio', { name: 'Summary', exact: true }).click();
    return 'At 1600, 1280 and 700px widths, the title shares one row with view tabs and the controls remain on one row. The live synthetic conversation has at least 580px of vertical space in each 900px viewport.';
  });

  await runCase('sidebar-ask-layout', 'Ask has a full-width multiline question field and an accessible action below it', ['UI-ask'], async ctx => {
    await goThreads();
    const layouts = [];
    for (const width of [1280, 700]) {
      await resizedFused(width);
      if (width < 900) await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
      const index = page.locator('.tk-rail .tk-list-sidebar');
      await index.getByRole('tab', { name: 'Ask', exact: true }).click();
      const question = index.getByRole('textbox', { name: 'Ask a question about your past AI conversations', exact: true });
      await question.fill('Research workspace decisions\nKeep the sources local.');
      const geometry = await index.locator('.tk-ask-form').evaluate(form => {
        const input = form.querySelector('textarea'); const action = form.querySelector('button');
        return { form: form.getBoundingClientRect().toJSON(), input: input.getBoundingClientRect().toJSON(), action: action.getBoundingClientRect().toJSON(), rows: input.rows, value: input.value, horizontalOverflow: input.scrollWidth > input.clientWidth + 1, textFits: input.scrollHeight <= input.clientHeight + 1, actionEnabled: !action.disabled };
      });
      layouts.push({ width, ...geometry });
      check(geometry.input.width >= geometry.form.width - 2 && geometry.input.height >= 72 && geometry.rows >= 4,
        `The question field uses the sidebar width and four readable lines at ${width}`, geometry);
      check(geometry.action.y >= geometry.input.y + geometry.input.height && !geometry.horizontalOverflow && geometry.textFits && geometry.actionEnabled,
        `The Ask action sits below the readable question at ${width}`, geometry);
      await ctx.shot(`-${width}`);
      await index.getByRole('tab', { name: 'Search', exact: true }).click();
      if (width < 900) await page.keyboard.press('Escape');
    }
    ctx.detail.layouts = layouts;
    await page.setViewportSize({ width: 1280, height: 900 });
    return 'The Ask question field spans the Sessions sidebar at desktop and narrow widths, keeps four readable lines without a scrollbar for the two-line draft, and places its enabled action below the field.';
  });

  // ---------------------------------------------------------------- fused-notice (AC-5)
  await runCase('fused-notice', 'A real Paperclip toast shows over the view; dismiss works; view stays clickable', ['AC-5'], async ctx => {
    await goThreads();
    const f = await frame();
    let attempt = 0; let found = null;
    while (!found && attempt < 3) {
      attempt += 1;
      await f.locator('button[aria-label="New task"], button:has-text("New task")').first().click();
      const editor = f.locator('[role="dialog"] [contenteditable="true"]').first();
      await editor.waitFor({ state: 'visible', timeout: 15_000 });
      await editor.click();
      await page.keyboard.type(`Fused notice probe ${Date.now()}`, { delay: 5 });
      ctx.detail.dialogRaised = (await measure()).workbench?.fusedRaised;
      const create = f.locator('[role="dialog"]').getByRole('button', { name: 'Create task', exact: true });
      await create.waitFor({ state: 'visible', timeout: 10_000 });
      await create.click();
      const toast = f.locator('[data-threadstack-notice]').first();
      try { await toast.waitFor({ state: 'visible', timeout: 6_000 }); found = toast; } catch { /* try again */ }
    }
    check(found, 'A real toast appeared after creating a task through the UI', { attempts: attempt });
    // Everything below must fit inside the 3.5 s success-toast lifetime, so measure in one pass.
    await sleep(350); // let its enter transition and the shell's hole follow it
    const g = await f.evaluate(() => { const t = document.querySelector('[data-threadstack-notice]'); if (!t) return null; const r = t.getBoundingClientRect().toJSON(); const dismiss = t.querySelector('button[aria-label="Dismiss notification"]').getBoundingClientRect().toJSON(); return { rect: r, dismiss, bg: getComputedStyle(t).backgroundColor, text: t.textContent.slice(0, 80) }; });
    check(g, 'Toast still present for measurement', g);
    const m = await measure();
    const overlap = (() => { const a = g.rect, b = m.shell; const x1 = Math.max(a.x, b.x), y1 = Math.max(a.y, b.y), x2 = Math.min(a.x + a.width, b.x + b.width), y2 = Math.min(a.y + a.height, b.y + b.height); return x2 > x1 && y2 > y1 ? { x: x1, y: y1, width: x2 - x1, height: y2 - y1 } : null; })();
    const fys = [0.15, 0.85];
    const probePoints = overlap ? [0.1, 0.5, 0.9].flatMap(fx => fys.map(fy => ({ x: overlap.x + overlap.width * fx, y: g.rect.y + g.rect.height * fy }))) : [];
    // Reference: the same rows of the toast where no shell layer lies over it (left of the shell).
    const refPoints = fys.map(fy => ({ x: Math.max(g.rect.x + 6, Math.min(m.shell.x - 24, g.rect.x + 40)), y: g.rect.y + g.rect.height * fy }));
    const px = await pixels([], [...probePoints, ...refPoints]);
    const probes = px.points.slice(0, probePoints.length), refs = px.points.slice(probePoints.length);
    const hits = await Promise.all(probePoints.slice(0, 2).map(pt => topAt(pt.x, pt.y)));
    const near = probes.filter(c => refs.some(r => Math.max(Math.abs(c[0] - r[0]), Math.abs(c[1] - r[1]), Math.abs(c[2] - r[2])) <= 14)).length;
    ctx.detail.toast = { ...g, overlapWithShell: overlap, overlapPixels: probes, unobstructedReferencePixels: refs, matchingReference: `${near}/${probes.length}`, hitsInOverlap: hits, raisedWhileToast: m.workbench?.fusedRaised ?? null };
    await ctx.shot('-toast');
    check(m.workbench?.fusedRaised !== 'true', 'A toast does not raise the frame', m.workbench);
    if (overlap) {
      check(hits.every(h => h?.inFrame), 'The toast is on top where it overlaps the shell (hole in the view)', hits);
      check(near >= Math.ceil(probes.length * 0.8), 'Pixels in the overlap match the unobstructed toast colour (visible, not covered by the view)', ctx.detail.toast);
    } else ctx.detail.note = 'The toast does not overlap the shell rectangle in this layout; only the dismiss and click-through checks are meaningful.';
    // View stays clickable elsewhere, while the toast is up.
    const row = await page.evaluate(() => { const b = document.querySelectorAll('.tk-shell .tk-row-btn')[6]; b.scrollIntoView({ block: 'nearest' }); const r = b.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
    await page.mouse.click(row.x, row.y);
    const sel = await page.evaluate(() => [...document.querySelectorAll('.tk-shell .tk-row-btn')].findIndex(b => b.getAttribute('aria-selected') === 'true'));
    ctx.detail.clickThrough = { selectedIndex: sel };
    // Dismiss with a real click.
    const stillThere = await f.evaluate(() => !!document.querySelector('[data-threadstack-notice]'));
    if (stillThere) {
      const d = await f.evaluate(() => { const b = document.querySelector('[data-threadstack-notice] button[aria-label="Dismiss notification"]')?.getBoundingClientRect().toJSON(); return b ?? null; });
      if (d) { const dh = await topAt(d.x + d.width / 2, d.y + d.height / 2); ctx.detail.dismissHit = dh; await page.mouse.click(d.x + d.width / 2, d.y + d.height / 2); }
      await f.locator('[data-threadstack-notice]').first().waitFor({ state: 'detached', timeout: 3_000 }).catch(() => {});
      ctx.detail.dismissed = !(await f.evaluate(() => !!document.querySelector('[data-threadstack-notice]')));
    } else ctx.detail.dismissed = 'toast expired before the dismiss click';
    check(sel === 6, 'The view stayed clickable while the toast was up', ctx.detail.clickThrough);
    check(ctx.detail.dismissHit?.inFrame && ctx.detail.dismissed === true, 'The dismiss button was clickable and removed the toast', { hit: ctx.detail.dismissHit, dismissed: ctx.detail.dismissed });
    return `Toast "${g.text}" appeared (overlap with shell: ${overlap ? 'yes' : 'no'}), was on top, view row click selected index 6, dismiss button click removed it.`;
  });

  // ---------------------------------------------------------------- fused-jank (probe, no pass criterion beyond measurability)
  await runCase('fused-jank', 'Long-task probe: 5 s idle and 20 rapid dialog open/close cycles with Threads fused', ['probe'], async ctx => {
    await goThreads();
    const f = await frame();
    const counts = async () => ({ frame: await f.evaluate(() => ({ supported: window.__tkLongSupported, tasks: window.__tkLong.slice() })), shell: await page.evaluate(() => ({ supported: window.__tkLongSupported, tasks: window.__tkLong.slice() })) });
    const summarize = (before, after) => Object.fromEntries(['frame', 'shell'].map(k => { const t = after[k].tasks.slice(before[k].tasks.length); return [k, { supported: after[k].supported, count: t.length, totalMs: t.reduce((a, b) => a + b, 0), maxMs: Math.max(0, ...t), durationsMs: t.slice(0, 30) }]; }));
    const b0 = await counts();
    await sleep(5_000);
    const b1 = await counts();
    ctx.detail.idle5s = summarize(b0, b1);
    // 20 rapid open/close cycles of Paperclip's real New task dialog (each raises and lowers the frame).
    const t0 = Date.now(); let raisedSeen = 0; let failures = 0;
    for (let i = 0; i < 20; i++) {
      try {
        const btn = f.locator('button[aria-label="New task"], button:has-text("New task")').first();
        const bb = await btn.boundingBox();
        await page.mouse.click(bb.x + bb.width / 2, bb.y + bb.height / 2);
        await f.locator('[role="dialog"]').first().waitFor({ state: 'visible', timeout: 3_000 });
        if (await page.locator('.tk-workbench').getAttribute('data-fused-raised') === 'true') raisedSeen += 1;
        await page.keyboard.press('Escape');
        await f.locator('[role="dialog"]').first().waitFor({ state: 'detached', timeout: 3_000 });
      } catch { failures += 1; await page.keyboard.press('Escape').catch(() => {}); }
    }
    const b2 = await counts();
    ctx.detail.cycles20 = { ...summarize(b1, b2), elapsedMs: Date.now() - t0, cyclesWithFrameRaised: raisedSeen, failedCycles: failures };
    await sleep(600);
    const end = await measure();
    ctx.detail.afterwards = { fused: end.workbench?.fused, raised: end.workbench?.fusedRaised ?? null, shellWithinSlot: within(end.shell, end.slot, 1) };
    check(b1.frame.supported && b1.shell.supported, 'longtask entries are supported in this browser', { frame: b1.frame.supported, shell: b1.shell.supported });
    check(failures === 0, 'All 20 dialog open/close cycles completed', ctx.detail.cycles20);
    check(ctx.detail.afterwards.fused === 'true' && ctx.detail.afterwards.raised === null && ctx.detail.afterwards.shellWithinSlot, 'Fused state intact afterwards', ctx.detail.afterwards);
    const i = ctx.detail.idle5s, c = ctx.detail.cycles20;
    return `Idle 5 s: frame ${i.frame.count} long tasks (${i.frame.totalMs} ms), shell ${i.shell.count} (${i.shell.totalMs} ms). 20 cycles in ${c.elapsedMs} ms: frame ${c.frame.count} (${c.frame.totalMs} ms, max ${c.frame.maxMs}), shell ${c.shell.count} (${c.shell.totalMs} ms, max ${c.shell.maxMs}).`;
  });

  // ---------------------------------------------------------------- fused-fallback (AC-2)
  await runCase('fused-fallback', 'An ordinary tab at /THR/threads offers Open this in ThreadStack', ['AC-2'], async ctx => {
    const ordinary = await context.newPage();
    try {
      await ordinary.goto(`${origin}${base}/threads`);
      const heading = ordinary.getByRole('heading', { name: 'Open this in ThreadStack', exact: true });
      await heading.waitFor({ timeout: 30_000 });
      ctx.detail.url = ordinary.url();
      ctx.detail.body = (await ordinary.locator('main#main-content').innerText().catch(() => '')).slice(0, 600);
      ctx.detail.hostAttr = await ordinary.evaluate(() => document.documentElement.hasAttribute('data-threadstack-host'));
      ctx.detail.slotPresent = await ordinary.evaluate(() => !!document.querySelector('.threadstack-slot'));
      ctx.evidence.push(await shot('fused-fallback', ordinary));
    } finally { await ordinary.close(); await page.bringToFront(); }
    check(ctx.detail.hostAttr === false && ctx.detail.slotPresent === false, 'Ordinary tab is not treated as a verified host', ctx.detail);
    return 'The ordinary tab at /THR/threads shows the heading "Open this in ThreadStack" and no slot.';
  });

  // ---------------------------------------------------------------- fused-offline (AC-8)
  if (process.env.TK_FUSED_SKIP_OFFLINE === '1') await notRun('fused-offline', 'Server stop keeps Threads with the shell rail; restart resumes fused mode', ['AC-8'], 'Skipped by TK_FUSED_SKIP_OFFLINE=1.');
  else await runCase('fused-offline', 'Server stop keeps Threads with the shell rail; restart resumes fused mode', ['AC-8'], async ctx => {
    await goThreads();
    // Live capture can add another library identity for this synthetic URL. Reopen the
    // exact existing workspace session rather than choosing between two matching titles.
    await page.locator('.tk-shell .tk-row-btn[data-open="true"]').filter({ hasText: 'Create Research Agent Plugin' }).click();
    await page.getByRole('radio', { name: 'Live', exact: true }).click();
    // Ownership check before the owned stop path is used: the listener on 3217 must be the recorded source server.
    const meta = JSON.parse(fs.readFileSync(process.env.TK_PAPERCLIP_RUNTIME || '/tmp/threadkeeper-acceptance-runtime.json', 'utf8'));
    const listener = () => { try { return Number(execFileSync('lsof', ['-nP', '-iTCP:3217', '-sTCP:LISTEN', '-t'], { encoding: 'utf8' }).trim().split('\n')[0]); } catch { return null; } };
    const pid = listener();
    const command = pid ? execFileSync('ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' }) : '';
    ctx.detail.ownership = { listenerPid: pid, recordedPid: meta.serverPid, commandOk: command.includes(`${meta.repo}/server/src/index.ts`), metadataCurrent: pid === meta.serverPid };
    check(pid && ctx.detail.ownership.commandOk, 'Listener on 3217 is the owned source server', ctx.detail.ownership);
    check(JSON.parse(fs.readFileSync(marker, 'utf8')).phase !== 'watcher_error', 'Owned stop/start watcher is healthy', fs.readFileSync(marker, 'utf8'));
    await page.evaluate(() => { document.querySelector('.tk-view-threads').__tkProbe = 'offline-node'; });
    fs.writeFileSync(marker, JSON.stringify({ phase: 'request_stop', at: new Date().toISOString() }));
    await until(async () => JSON.parse(fs.readFileSync(marker, 'utf8')).phase, v => v === 'stopped' || v === 'watcher_error', 90_000, 'owned stop');
    check(JSON.parse(fs.readFileSync(marker, 'utf8')).phase === 'stopped' && listener() === null, 'Owned server stopped and port closed', fs.readFileSync(marker, 'utf8'));
    const off = await until(async () => { const m = await measure().catch(() => null); const inShell = await page.evaluate(() => ({ fused: document.querySelector('.tk-workbench')?.dataset.fused ?? null, radiogroup: !!document.querySelector('.tk-rail [role="radiogroup"][aria-label="View"], .tk-rail nav[aria-label="Views"]'), status: document.querySelector('.tk-rail .tk-paperclip-status')?.getAttribute('data-state') ?? null })); return inShell.fused === null ? inShell : null; }, Boolean, 60_000, 'fused mode to drop after the stop');
    await sleep(500);
    const state = await page.evaluate(() => { const vis = e => !!e && !e.hidden && e.getBoundingClientRect().width > 0; const view = document.querySelector('.tk-view-threads'); const rail = document.querySelector('.tk-shell > .tk-rail'); const rg = document.querySelector('.tk-rail [role="radiogroup"][aria-label="View"], .tk-rail nav[aria-label="Views"]'); return { fused: document.querySelector('.tk-workbench')?.dataset.fused ?? null, threadsVisible: vis(view), rows: document.querySelectorAll('.tk-shell .tk-row-btn').length, sameNode: view?.__tkProbe === 'offline-node', railVisible: vis(rail), railRect: rail?.getBoundingClientRect().toJSON(), switchVisible: vis(rg), switchLabels: [...(rg?.querySelectorAll('[role="radio"], button') ?? [])].map(e => (e.getAttribute('aria-label') || e.textContent).trim()), status: document.querySelector('.tk-rail .tk-paperclip-status')?.getAttribute('data-state') ?? null, shellStyle: document.querySelector('.tk-shell')?.getAttribute('style') }; });
    ctx.detail.offline = { ...off, ...state };
    await ctx.shot('-offline');
    check(state.threadsVisible && state.rows >= 30 && state.railVisible && state.switchVisible && state.sameNode, 'Offline: Threads view kept (same node), shell rail and its own view switch visible', ctx.detail.offline);
    // The user's screenshot shows standalone ThreadStack. Verify that surface while the
    // owned Paperclip server is stopped, then retain the original recovery case afterwards.
    ctx.detail.standaloneLayouts = [];
    for (const width of [1280, 700]) {
      await page.setViewportSize({ width, height: 900 });
      const layout = await until(() => page.evaluate(() => {
        const rect = selector => document.querySelector(selector)?.getBoundingClientRect().toJSON() ?? null;
        return { viewport: { width: innerWidth, height: innerHeight }, title: rect('.tk-detail-title'), modes: rect('.tk-thr-modebar'), header: rect('.tk-detail-header'), live: rect('.tk-thr-livewrap'), controls: rect('.tk-detail-controls'), actionRects: [...document.querySelectorAll('.tk-detail-controls > *')].map(e => e.getBoundingClientRect().toJSON()), sidebarIndexes: document.querySelectorAll('.tk-rail .tk-list-sidebar').length, duplicateMainIndexes: document.querySelectorAll('.tk-view-threads .tk-list-pane').length };
      }), value => value.live?.height >= 580, 10_000, `standalone live geometry at ${width}`);
      ctx.detail.standaloneLayouts.push(layout);
      check(layout.sidebarIndexes === 1 && layout.duplicateMainIndexes === 0 && layout.header.height <= 160,
        'Standalone Threads has one Sessions index and a compact header', layout);
      check(Math.abs(layout.title.y + layout.title.height / 2 - layout.modes.y - layout.modes.height / 2) <= 2 && layout.actionRects.every(r => Math.abs(r.y + r.height / 2 - layout.controls.y - layout.controls.height / 2) <= 8),
        'Standalone title/tabs and controls each fit one row', layout);
      layout.liveFrame = await settledLiveFrame();
      await ctx.shot(`-standalone-${width}`);
      if (width < 900) await page.getByRole('button', { name: 'Expand navigation', exact: true }).click();
      const index = page.locator('.tk-rail .tk-list-sidebar');
      await index.getByRole('tab', { name: 'Ask', exact: true }).click();
      await index.getByRole('textbox', { name: 'Ask a question about your past AI conversations', exact: true }).fill('Research decisions\nKeep the sources local.');
      const ask = await index.locator('.tk-ask-form').evaluate(form => {
        const input = form.querySelector('textarea').getBoundingClientRect().toJSON();
        const action = form.querySelector('button').getBoundingClientRect().toJSON();
        return { width: innerWidth, form: form.getBoundingClientRect().toJSON(), input, action };
      });
      check(ask.input.width >= ask.form.width - 2 && ask.action.y >= ask.input.y + ask.input.height,
        'Standalone Ask uses a full-width question field with its action below', ask);
      ctx.detail.standaloneLayouts.at(-1).ask = ask;
      await ctx.shot(`-standalone-ask-${width}`);
      await index.getByRole('tab', { name: 'Search', exact: true }).click();
      if (width < 900) await page.keyboard.press('Escape');
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    // Restart through the owned path.
    fs.writeFileSync(marker, JSON.stringify({ phase: 'request_start', at: new Date().toISOString() }));
    await until(async () => JSON.parse(fs.readFileSync(marker, 'utf8')).phase, v => v === 'started' || v === 'watcher_error', 120_000, 'owned start');
    check(JSON.parse(fs.readFileSync(marker, 'utf8')).phase === 'started', 'Owned server restarted', fs.readFileSync(marker, 'utf8'));
    const firstFused = await waitFusedOn('threads', 120_000);
    ctx.detail.firstFusedObservation = { path: firstFused.path, slotPresentInFrame: Boolean(firstFused.slot), shell: firstFused.shell };
    const resumed = await until(async () => { const m = await measure().catch(() => null); return m && m.workbench?.fused === 'true' && m.slot && within(m.shell, m.slot, 1) ? m : null; }, Boolean, 60_000, 'resumed placement to match the slot').catch(async error => { ctx.detail.resumeWait = String(error.message).slice(0, 800); return measure(); });
    const again = await page.evaluate(() => document.querySelector('.tk-view-threads')?.__tkProbe === 'offline-node');
    ctx.detail.resumed = { path: resumed.path, workbench: resumed.workbench, shell: resumed.shell, slot: resumed.slot, withinOnePx: within(resumed.shell, resumed.slot, 1), sameNodeAfterResume: again, ownership: { newListenerPid: listener() } };
    check(within(resumed.shell, resumed.slot, 1), 'Resumed placement matches the slot', ctx.detail.resumed);
    await ctx.shot('-resumed');
    return `Stopped the owned server (pid ${pid}); Threads stayed mounted with the shell rail and switch (${state.switchLabels.join('/')}); after restart fused mode resumed on ${resumed.path} (same view node: ${again}).`;
  });
} catch (error) {
  record('runner-error', { error: error.stack || String(error) }); process.exitCode = 1;
} finally {
  try { diagnostics.hostLog = await (await frame().catch(() => null))?.evaluate(() => window.__tkLog ?? null); } catch {}
  if (helperContext) await helperContext.close().catch(() => {});
  if (context) await context.close().catch(() => {});
  if (mainVideoPath) diagnostics.video = path.relative(output, mainVideoPath);
  diagnostics.artifactProvenance = artifactProvenance;
  diagnostics.sourceHashesUnchangedDuringRun = JSON.stringify(sourceSnapshot()) === JSON.stringify(runtimeSources);
  fs.rmSync(profile, { recursive: true, force: true });
  const currentSha = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
  const fixtureSha = crypto.createHash('sha256').update(fixtureManifestBytes).digest('hex');
  if (currentSha === fixtureSha) fs.writeFileSync(manifestPath, originalManifestBytes);
  const result = { completedAt: new Date().toISOString(), browser: { executablePath, version: browserVersion, colorScheme }, build: diskBuild, extensionId, revision, origin, companyPrefix: prefix, manifestFixture: { grantedOrigins, restored: crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex') === crypto.createHash('sha256').update(originalManifestBytes).digest('hex') }, counts: Object.fromEntries(['pass', 'fail', 'not_run'].map(s => [s, cases.filter(c => c.status === s).length])), cases: cases.map(({ id, name, acs, status, observation, evidence }) => ({ id, name, acs, status, observation: String(observation).slice(0, 600), evidence })), diagnostics, events: events.slice(0, 200) };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ complete: true, counts: result.counts, output }));
  if (cases.some(c => c.status === 'fail')) process.exitCode = 1;
}
