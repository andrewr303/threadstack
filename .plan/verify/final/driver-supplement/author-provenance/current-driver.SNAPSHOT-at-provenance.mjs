// Explicit project Playwright runner for the merge plan. Never loads the user's profile or build.
// Prepare an isolated server with TK_PAPERCLIP_RUNTIME, build to /tmp/tk-build, then run this file.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forkRoot = path.resolve(extensionRoot, '..');
const dist = fs.realpathSync(process.env.TK_E2E_DIST || '/tmp/tk-build');
const live = path.resolve('/Users/andrew/dev/threadkeeper/.output/chrome-mv3');
if (dist === live || dist.startsWith(`${live}${path.sep}`)) throw new Error('Refusing to test the live extension folder.');
const fixture = JSON.parse(fs.readFileSync(process.env.TK_PAPERCLIP_RUNTIME || '/tmp/threadkeeper-acceptance-runtime.json', 'utf8'));
const origin = new URL(fixture.origin).origin;
if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(origin).hostname)) throw new Error('An isolated loopback Paperclip server is required.');
if (!fixture.companyId || !fixture.companyPrefix) throw new Error('Isolated company fixture is required.');
const output = path.resolve(process.env.TK_PAPERCLIP_E2E_OUT || path.join(forkRoot, '.acceptances/paperclip-merge/round-1'));
if (fs.existsSync(path.join(output, 'seal.json'))) throw new Error('Sealed evidence is immutable. Select a new TK_PAPERCLIP_E2E_OUT round.');
const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
const assets = path.join(output, 'assets', `attempt-${stamp}`);
fs.mkdirSync(assets, { recursive: true });
const manifestPath = path.join(dist, 'manifest.json');
const originalManifestBytes = fs.readFileSync(manifestPath);
const manifest = JSON.parse(originalManifestBytes.toString('utf8'));
if (manifest.key) throw new Error('The isolated test build must not have a stable manifest key.');
let permissionFixture = null;
let fixtureManifestBytes = null;
if (process.env.TK_E2E_PREGRANT_LOOPBACK === '1') {
  if (dist !== fs.realpathSync('/tmp/tk-build')) throw new Error('Permission fixture is restricted to /tmp/tk-build.');
  const origins = ['http://127.0.0.1/*', 'http://localhost/*'];
  const originalHosts = manifest.host_permissions ?? [];
  manifest.host_permissions = [...new Set([...originalHosts, ...origins])];
  const fixtureBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(path.join(assets, 'manifest-original.json'), originalManifestBytes);
  fs.writeFileSync(path.join(assets, 'manifest-fixture.json'), fixtureBytes);
  permissionFixture = { grantedOrigins: origins, originalSha256: crypto.createHash('sha256').update(originalManifestBytes).digest('hex'), fixtureSha256: crypto.createHash('sha256').update(fixtureBytes).digest('hex'), addedHostPermissions: origins.filter(value => !originalHosts.includes(value)), sourceBundlesChanged: false, restored: false };
  fixtureManifestBytes = fixtureBytes;
}
const diskBuild = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json'), 'utf8'));
const extensionId = [...crypto.createHash('sha256').update(dist).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: forkRoot, encoding: 'utf8' }).trim();
const companyPath = `/${encodeURIComponent(fixture.companyPrefix)}`;
const managerUrl = `chrome-extension://${extensionId}/manager.html?surface=page&view=threads`;

// Same configured executable resolution as run-workspace-e2e.mjs; never downloads a browser.
function resolveChromium() {
  if (process.env.CHROME_EXECUTABLE_PATH) {
    if (!fs.existsSync(process.env.CHROME_EXECUTABLE_PATH)) throw new Error('CHROME_EXECUTABLE_PATH does not exist.');
    return process.env.CHROME_EXECUTABLE_PATH;
  }
  for (const cache of [path.join(os.homedir(), 'Library/Caches/ms-playwright'), path.join(os.homedir(), '.cache/ms-playwright')]) {
    if (!fs.existsSync(cache)) continue;
    const builds = fs.readdirSync(cache).filter(name => /^chromium-\d+$/.test(name)).sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
    for (const build of builds) for (const parts of [
      ['chrome-mac-arm64', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing'],
      ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'], ['chrome-linux', 'chrome'],
    ]) {
      const candidate = path.join(cache, build, ...parts);
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('No configured full Chromium executable is installed. Set CHROME_EXECUTABLE_PATH.');
}
const executablePath = resolveChromium();
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-paperclip-e2e-'));
const events = [];
const cases = [];
const selectedCases = process.env.TK_PAPERCLIP_E2E_CASES ? new Set(process.env.TK_PAPERCLIP_E2E_CASES.split(',')) : null;
let context;
let page;
let evidencePage;
let sw;
let browserVersion;
let videoStartedAt = null;
const liveSockets = new Set();
const liveEvents = [];
let lastMainSocketClosedAt = null;
let observingRecoveryLoss = false;
const record = (kind, detail) => { const event = { at: new Date().toISOString(), kind, ...detail }; events.push(event); console.log(JSON.stringify(event)); };
const assert = (condition, message, observed) => { record('assertion', { ok: Boolean(condition), message, observed }); if (!condition) throw new Error(message); };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(read, accept, timeout = 30_000) {
  const start = Date.now(); let last;
  do { last = await read(); if (accept(last)) return last; await sleep(150); } while (Date.now() - start < timeout);
  throw new Error(`Condition timed out: ${JSON.stringify(last)}`);
}
function relative(file) { return path.relative(output, file); }
async function capture(id, target = page) {
  const capturedAt = new Date().toISOString();
  const png = path.join(assets, `${id}.png`);
  const dom = path.join(assets, `${id}.dom.json`);
  await target.screenshot({ path: png, fullPage: true });
  const snapshot = { capturedAt, url: target.url(), title: await target.title(), viewport: target.viewportSize(), frames: [] };
  for (const frame of target.frames()) {
    try { snapshot.frames.push({ url: frame.url(), name: frame.name(), title: await frame.title(), text: (await frame.locator('body').innerText()).slice(0, 40_000), timeOrigin: await frame.evaluate(() => performance.timeOrigin) }); }
    catch (error) { snapshot.frames.push({ url: frame.url(), unavailable: String(error) }); }
  }
  fs.writeFileSync(dom, JSON.stringify(snapshot, null, 2));
  return [{ path: relative(png), type: 'screenshot', capturedAt, inspected: false }, { path: relative(dom), type: 'dom_snapshot', capturedAt, inspected: false }];
}
async function runCase(id, name, action) {
  if (selectedCases && !selectedCases.has(id)) { cases.push({ id, name, status: 'not_run', observation: 'Outside this explicitly selected diagnostic execution.', evidence: [] }); return; }
  const depends = id === 'pc-frame' ? ['pc-connect'] : id === 'pc-connect' ? [] : ['pc-connect', 'pc-frame'];
  const missing = depends.filter(dependency => cases.find(item => item.id === dependency)?.status !== 'pass');
  if (missing.length) { cases.push({ id, name, status: 'blocked', observation: `Prerequisite cases did not pass: ${missing.join(', ')}`, evidence: [] }); return; }
  const startedAt = new Date().toISOString(); record('case-start', { id, name });
  try { const result = await action(); const evidence = [...await capture(id), ...(result?.evidence ?? [])]; const observation = typeof result === 'string' ? result : result.observation; cases.push({ id, name, status: 'pass', startedAt, completedAt: new Date().toISOString(), observation, evidence }); record('case-pass', { id, observation }); }
  catch (error) { const target = evidencePage && !evidencePage.isClosed() ? evidencePage : page; const evidence = target && !target.isClosed() ? await capture(`${id}-failed`, target).catch(() => []) : []; cases.push({ id, name, status: 'fail', startedAt, completedAt: new Date().toISOString(), observation: error.stack || String(error), evidence }); record('case-fail', { id, error: String(error) }); }
}
async function paperclipFrame(expectedOrigin = origin) {
  await page.locator('iframe[title="Paperclip"]').waitFor({ state: 'visible', timeout: 45_000 });
  const frame = await until(() => Promise.resolve(page.frames().find(frame => frame.url().startsWith(expectedOrigin) && frame.parentFrame() === page.mainFrame())), Boolean);
  await frame.waitForFunction(() => document.documentElement.hasAttribute('data-threadkeeper-host'), { timeout: 15_000 });
  await page.locator('.tk-paperclip-loading').waitFor({ state: 'hidden', timeout: 15_000 });
  return frame;
}
async function chooseView(name) {
  const radios = page.getByRole('radio', { name, exact: true });
  const buttons = page.getByRole('button', { name, exact: true });
  if (await radios.count() === 1 && await radios.isVisible()) await radios.click();
  else { assert(await buttons.count() === 1, `Exactly one shell ${name} control`, await buttons.count()); await buttons.click(); }
}
async function settingsPaperclip() {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.waitFor({ state: 'visible' });
  await dialog.locator('#tk-settings-tab-paperclip').click();
  return dialog;
}
async function chooseTaskSessionsTab(board) {
  const tab = board.locator('[role="tab"],button').filter({ hasText: /^Sessions$/ });
  await tab.waitFor({ state: 'visible', timeout: 45_000 });
  assert(await tab.count() === 1, 'Exactly one task Sessions tab exists', await tab.count());
  await tab.click();
}

try {
  if (fixtureManifestBytes) fs.writeFileSync(manifestPath, fixtureManifestBytes);
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true, viewport: { width: 1280, height: 900 },
    recordVideo: { dir: path.join(assets, 'videos'), size: { width: 1280, height: 900 } },
    args: ['--headless=new', '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  browserVersion = context.browser()?.version() || 'unknown';
  const isBridgeRequest = request => {
    const url = new URL(request.url());
    return url.origin === origin && url.pathname.startsWith('/api/plugins/browser-sessions/api/');
  };
  context.on('request', request => { if (isBridgeRequest(request)) { const url = new URL(request.url()); record('bridge-network', { event: 'request', method: request.method(), path: url.pathname, source: request.serviceWorker() ? 'service-worker' : 'page', ...(url.pathname.endsWith('/search') ? { quality: url.searchParams.get('quality'), queryLength: (url.searchParams.get('q') ?? '').length, limit: url.searchParams.get('limit') } : {}) }); } });
  context.on('requestfailed', request => { if (isBridgeRequest(request)) record('bridge-network', { event: 'failed', method: request.method(), path: new URL(request.url()).pathname, error: request.failure()?.errorText ?? 'unknown' }); });
  context.on('response', response => { if (isBridgeRequest(response.request())) record('bridge-network', { event: 'response', path: new URL(response.url()).pathname, status: response.status() }); });
  context.on('response', response => { const url = new URL(response.url()); if (url.pathname.endsWith('/events/stream') && ['127.0.0.1', 'localhost'].includes(url.hostname)) record('native-sse-response', { host: url.host, path: url.pathname, status: response.status() }); });
  context.on('requestfailed', request => { const url = new URL(request.url()); if (url.pathname.endsWith('/events/stream') && ['127.0.0.1', 'localhost'].includes(url.hostname)) record('native-sse-failed', { host: url.host, path: url.pathname, error: request.failure()?.errorText ?? 'unknown' }); });
  await context.route(/^https?:\/\//, route => {
    const hostname = new URL(route.request().url()).hostname;
    if (['127.0.0.1', 'localhost', '[::1]'].includes(hostname)) return route.continue();
    record('blocked-nonfixture-network', { origin: new URL(route.request().url()).origin });
    return route.abort('blockedbyclient');
  });
  [sw] = context.serviceWorkers(); if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 30_000 });
  assert(new URL(sw.url()).host === extensionId, 'The isolated path-derived extension ID is loaded', { expected: extensionId, observed: new URL(sw.url()).host });
  const loadedManifest = await sw.evaluate(() => chrome.runtime.getManifest());
  assert(loadedManifest.version_name === manifest.version_name, 'Browser manifest matches the test build', { disk: manifest.version_name, browser: loadedManifest.version_name });
  videoStartedAt = new Date().toISOString();
  page = await context.newPage();
  evidencePage = page;
  page.on('pageerror', error => record('page-error', { message: error.message }));
  page.on('console', message => { if (message.type() === 'error') record('console-error', { text: message.text().slice(0, 2000) }); });
  page.on('response', response => { const url = new URL(response.url()); if (url.origin === origin && url.pathname.startsWith('/api/')) record('api-response', { path: url.pathname, status: response.status() }); });
  page.on('websocket', socket => {
    const url = new URL(socket.url());
    if (!url.pathname.endsWith('/events/ws') || !['127.0.0.1', 'localhost'].includes(url.hostname)) return;
    const isMain = url.host === new URL(origin).host;
    if (isMain) liveSockets.add(socket);
    record('native-live-socket', { state: 'created', host: url.host, path: url.pathname });
    const observeLoss = () => { if (isMain && observingRecoveryLoss && lastMainSocketClosedAt === null) lastMainSocketClosedAt = Date.now(); };
    socket.on('socketerror', error => { observeLoss(); record('native-live-socket', { state: 'error', host: url.host, path: url.pathname, error }); });
    socket.on('framereceived', event => {
      try {
        const data = JSON.parse(String(event.payload));
        const item = { host: url.host, eventType: data.type, action: data.payload?.action ?? null, companyId: data.companyId, issueId: data.payload?.issueId ?? data.payload?.issue?.id ?? (data.payload?.entityType === 'issue' ? data.payload?.entityId : null) };
        if (item.issueId) { liveEvents.push(item); record('native-live-event', item); }
      } catch {}
    });
    socket.on('close', () => { if (isMain) liveSockets.delete(socket); observeLoss(); record('native-live-socket', { state: 'closed', host: url.host, path: url.pathname }); });
  });

  await runCase('pc-connect', 'Connect the extension to the isolated local server', async () => {
    await page.goto(managerUrl); await page.locator('.tk-workbench').waitFor({ state: 'visible' });
    const dialog = await settingsPaperclip();
    await dialog.getByLabel('Server address', { exact: true }).fill(origin);
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await dialog.getByText(/Found Paperclip.*local trusted mode/).waitFor({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.tk-rail .tk-paperclip-status[data-state="running"]').waitFor({ timeout: 20_000 });
    return `Connected through the actual Settings UI to ${origin}; health status is running without a provider account or credential.`;
  });

  await runCase('pc-frame', 'The real Paperclip app fills a direct-child frame with its sidebar', async () => {
    // An agentless fixture's Dashboard intentionally opens the first-agent wizard.
    // Start at its existing Tasks route; do not create an agent or suppress the wizard's DOM.
    const entry = new URL(managerUrl); entry.searchParams.set('view', 'paperclip'); entry.searchParams.set('pc', `${companyPath}/issues?view=all`);
    await page.goto(entry.href);
    const frame = await paperclipFrame();
    await frame.locator(`aside a[href="${companyPath}/issues"]`).waitFor({ timeout: 60_000 });
    const actualTasks = frame.locator('main#main-content section.coordinator-task-list');
    await actualTasks.waitFor({ state: 'visible', timeout: 45_000 });
    await actualTasks.getByText(fixture.issueIdentifier, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    const geometry = await page.locator('iframe[title="Paperclip"]').evaluate(element => ({ parentIsManager: element.ownerDocument.defaultView === window, rect: element.getBoundingClientRect().toJSON(), sandbox: element.getAttribute('sandbox') }));
    const sidebar = await frame.locator('aside').evaluateAll(elements => elements.filter(element => element.getBoundingClientRect().width > 0).map(element => ({ text: element.textContent, rect: element.getBoundingClientRect().toJSON() })));
    assert(frame.parentFrame() === page.mainFrame(), 'Paperclip iframe is a direct child of the manager document');
    assert(sidebar.some(item => item.text?.includes('Tasks') && item.text.includes('Chat') && item.text.includes('Inbox') && item.text.includes('More')), 'Actual current Paperclip coordinator sidebar includes Chat, Tasks, Inbox and More', sidebar);
    assert(!geometry.sandbox.includes('allow-top-navigation'), 'Paperclip frame cannot navigate the top-level window', geometry);
    record('frame-layout', { geometry, sidebar });
    return 'The actual local Paperclip application renders its native Chat/Tasks/Inbox/More navigation in a direct-child frame; the sandbox keeps top navigation disabled.';
  });

  await runCase('pc-preserve', 'Switching views preserves the Paperclip document', async () => {
    const frame = await paperclipFrame(); const initialTimeOrigin = await frame.evaluate(() => performance.timeOrigin); const initialUrl = frame.url();
    await chooseView('Threads'); await page.locator('.tk-shell[data-view="threads"]').waitFor();
    await chooseView('Browse'); await page.locator('.tk-shell[data-view="browse"]').waitFor();
    await chooseView('Paperclip'); const restored = await paperclipFrame();
    const restoredTimeOrigin = await restored.evaluate(() => performance.timeOrigin);
    assert(initialTimeOrigin === restoredTimeOrigin && initialUrl === restored.url(), 'Same Paperclip document and route after Threads/Browse/Paperclip switches', { initialTimeOrigin, restoredTimeOrigin, initialUrl, restoredUrl: restored.url() });
    return 'Threads and Browse remain usable; returning to Paperclip retains the same document time origin and route with no reload.';
  });

  await runCase('pc-plugin-navigation', 'Paperclip sidebar entries switch the actual mounted Threadkeeper views', async () => {
    const frame = await paperclipFrame(); const documentId = await frame.evaluate(() => performance.timeOrigin);
    for (const [label, route, view] of [['Threads', 'threads', 'threads'], ['Browse', 'browse', 'browse'], ['Session board', 'session-board', 'dashboard']]) {
      const entry = frame.locator(`nav[aria-label="Threadkeeper"] a[href="${companyPath}/${route}"]`);
      await entry.waitFor({ state: 'visible', timeout: 20_000 });
      assert(await entry.innerText() === label, `Actual plugin sidebar entry ${label} is present`);
      await entry.click(); await page.locator(`.tk-shell[data-view="${view}"]`).waitFor({ state: 'visible', timeout: 20_000 });
      await chooseView('Paperclip');
      assert(await (await paperclipFrame()).evaluate(() => performance.timeOrigin) === documentId, `${label} fallback switching preserves the Paperclip document`);
    }
    const ordinary = await context.newPage(); evidencePage = ordinary;
    await ordinary.goto(`${origin}${companyPath}/threads`);
    await ordinary.getByRole('heading', { name: 'Open this in Threadkeeper', exact: true }).waitFor({ timeout: 30_000 });
    await ordinary.getByText('Browse, Threads and the session board run inside the Threadkeeper window.', { exact: true }).waitFor();
    const evidence = await capture('pc-plugin-navigation-ordinary', ordinary);
    await ordinary.close(); evidencePage = page; await page.bringToFront();
    return { observation: 'The real Paperclip coordinator sidebar exposes Threads, Browse and Session board; each selects the corresponding mounted extension view without reloading Paperclip. Its ordinary-tab page presents the documented Open this in Threadkeeper fallback.', evidence };
  });

  await runCase('pc-deep-link', 'Native navigation synchronizes a route that survives manager reload', async () => {
    const frame = await paperclipFrame();
    await frame.locator(`aside a[href="${companyPath}/issues"]`).click();
    await until(() => Promise.resolve(new URL(page.url()).searchParams.get('pc')), value => value?.startsWith(`${companyPath}/issues`));
    await frame.getByRole('link', { name: 'Inbox', exact: true }).click();
    await until(() => Promise.resolve(new URL(frame.url()).pathname), value => value === `${companyPath}/decisions`);
    await frame.getByRole('button', { name: 'More workspace pages', exact: true }).click();
    await frame.getByRole('link', { name: 'Search', exact: true }).click();
    await until(() => Promise.resolve(new URL(frame.url()).pathname), value => value === `${companyPath}/search`);
    await page.goBack(); await until(() => Promise.resolve(new URL(frame.url()).pathname), value => value === `${companyPath}/decisions`);
    await page.goBack(); await until(() => Promise.resolve(new URL(frame.url()).pathname), value => value === `${companyPath}/issues`);
    await page.goForward(); await until(() => Promise.resolve(new URL(frame.url()).pathname), value => value === `${companyPath}/decisions`);
    await page.goForward(); await until(() => Promise.resolve(new URL(frame.url()).pathname), value => value === `${companyPath}/search`);
    record('native-history', { back: [`${companyPath}/decisions`, `${companyPath}/issues`], forward: [`${companyPath}/decisions`, `${companyPath}/search`] });
    await frame.locator(`aside a[href="${companyPath}/issues"]`).click();
    await until(() => Promise.resolve(new URL(page.url()).searchParams.get('pc')), value => value?.startsWith(`${companyPath}/issues`));
    const storedPath = new URL(page.url()).searchParams.get('pc'); const oldDocument = await frame.evaluate(() => performance.timeOrigin);
    await page.reload(); const restored = await paperclipFrame();
    await restored.locator('aside.coordinator-sidebar').waitFor({ state: 'visible', timeout: 45_000 });
    await until(() => Promise.resolve({ frame: new URL(restored.url()).pathname, parent: new URL(page.url()).searchParams.get('pc') }), value => value.frame === new URL(storedPath, origin).pathname && value.parent === storedPath);
    await restored.locator('main#main-content section.coordinator-task-list').getByText(fixture.issueIdentifier, { exact: true }).waitFor({ state: 'visible', timeout: 30_000 });
    assert(new URL(page.url()).searchParams.get('view') === 'paperclip', 'Manager restores the Paperclip view after reload');
    assert(await restored.evaluate(() => performance.timeOrigin) !== oldDocument, 'Reload exercises route restoration in a fresh document');
    return `Paperclip's native Tasks, Inbox and Search links synchronized routes; browser Back twice and Forward twice traversed the actual frame history. Manager reload restored pc=${storedPath}.`;
  });

  await runCase('pc-message-security', 'Invalid route messages cannot alter manager navigation', async () => {
    const frame = await paperclipFrame();
    await frame.getByRole('button', { name: 'More workspace pages', exact: true }).click();
    await frame.getByRole('link', { name: 'Search', exact: true }).click();
    await frame.locator('[data-page="search"]').waitFor({ state: 'visible' });
    await until(() => Promise.resolve(new URL(page.url()).searchParams.get('pc')), value => value === `${companyPath}/search`);
    const before = page.url();
    await frame.evaluate(extensionOrigin => parent.postMessage({ source: 'paperclip-ui', v: 1, type: 'route', path: '//evil.example' }, extensionOrigin), `chrome-extension://${extensionId}`);
    await page.evaluate(() => window.postMessage({ source: 'paperclip-ui', v: 1, type: 'route', path: '/forged' }, window.location.origin));
    await sleep(200);
    assert(page.url() === before, 'Protocol-relative route and wrong-source message were ignored', { before, after: page.url() });
    return 'An explicit hostile-message probe from the real frame and a wrong-source probe leave the manager route unchanged.';
  });

  if (process.env.TK_PAPERCLIP_SESSION_UI === '1') {
    await runCase('pc-session-ui', 'Pair, search a shared synthetic session and persist its task link', async () => {
      if (process.env.TK_PAPERCLIP_PLUGIN_READY_FILE) {
        const readyFile = path.resolve(process.env.TK_PAPERCLIP_PLUGIN_READY_FILE);
        record('plugin-build-control', { phase: 'waiting_final_plugin', path: readyFile });
        await until(() => Promise.resolve(fs.existsSync(readyFile) ? JSON.parse(fs.readFileSync(readyFile, 'utf8')).phase : null), phase => phase === 'ready', 300_000);
      }
      const now = new Date().toISOString();
      const suffix = (process.env.TK_PAPERCLIP_SESSION_SUFFIX || 'chromium').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40);
      const fixtureKey = `claude_code:acct_claude_primary:default:threadkeeper_acceptance_${suffix}:main`;
      const title = `Acceptance webhook retry session (${suffix})`;
      await sw.evaluate(async ({ now, fixtureKey, title }) => {
        const base = { provider: 'claude_code', accountId: 'acct_claude_primary', workspaceId: 'default', sourceConversationId: 'threadkeeper_acceptance', branchId: 'main', parentBranchId: null, siblingBranchIds: [], canonicalUrl: 'https://claude.ai/code/session_threadkeeper_acceptance', title, manualTitleOverride: null, createdAt: now, updatedAt: now, lastCapturedAt: now, sourceRevision: 1, contentHash: 'isolated-acceptance-fixture', coverage: 'full', captureSource: 'manual', messageCount: 1, project: 'General research', categoryLocked: true, tags: [], manualTags: [], workflowState: 'active', manualNotes: '', pinned: false, snoozedUntil: null, dismissedQueues: [], cloudExcluded: false, cloudTaskStatus: 'unsupported', isSyntheticBenchmark: false, latestDecisionText: null, latestDecisionMsgIndex: null, latestDecisionSpeaker: null, nextStepText: 'Check webhook retries', nextStepMsgIndex: 0, nextStepSpeaker: 'user_committed', agentState: null };
        await globalThis.__threadkeeperDb.conversations.bulkPut([{ ...base, threadKey: fixtureKey }, { ...base, threadKey: fixtureKey + '_private', sourceConversationId: 'threadkeeper_acceptance_private', title: 'Acceptance webhook private control', cloudExcluded: true }]);
        await globalThis.__threadkeeperDb.messages.put({ messageKey: fixtureKey + ':m0', threadKey: fixtureKey, ordinal: 0, sourceMessageId: 'fixture-m0', role: 'user', content: 'Make acceptance webhook retries safe for Stripe delivery.', createdAt: now, contentHash: 'isolated-acceptance-message', hasCode: false, hasArtifact: false, branchPath: 'main' });
      }, { now, fixtureKey, title });
      record('fixture-seed', { database: 'owned empty extension profile', shared: 1, private: 1, title, noProviderNetwork: true });
      // A company permits one paired browser. Explicitly retire the prior disposable
      // profile through the real board UI before pairing the new owned test profile.
      const previousBrowser = await context.newPage(); evidencePage = previousBrowser;
      await previousBrowser.goto(`${origin}${companyPath}/company/settings/browser-sessions`);
      const browserSettings = previousBrowser.getByRole('region', { name: 'Browser sessions settings', exact: true });
      await browserSettings.getByRole('button', { name: 'Disconnect', exact: true }).click({ timeout: 30_000 });
      await until(() => browserSettings.getByRole('checkbox', { name: 'Share sessions with this company', exact: true }).isDisabled(), Boolean);
      record('fixture-pairing-reset', { companyId: fixture.companyId, method: 'Real board Disconnect control', source: 'Prior disposable browser profile' });
      await previousBrowser.close(); evidencePage = page; await page.bringToFront();
      const dialog = await settingsPaperclip();
      const pair = dialog.getByRole('button', { name: /^Pair / });
      await pair.waitFor({ state: 'visible', timeout: 20_000 });
      assert(await pair.count() === 1, 'Exactly one isolated company can be paired', await pair.count());
      await pair.click();
      await dialog.locator('.tk-paperclip-pair-code').waitFor();
      const code = (await dialog.locator('.tk-paperclip-pair-code').innerText()).trim();
      assert(/^[A-Z0-9]{8}$/.test(code), 'Pairing UI supplies an eight-character code');
      const board = await context.newPage();
      evidencePage = board;
      await board.goto(`${origin}${companyPath}/company/settings/browser-sessions`);
      await board.getByLabel('Confirm pairing code', { exact: true }).fill(code);
      await board.getByLabel('Share sessions with this company after pairing', { exact: true }).check();
      await board.getByRole('button', { name: 'Confirm code', exact: true }).click();
      await page.bringToFront();
      await dialog.getByLabel(/^Share sessions with /).waitFor({ timeout: 20_000 });
      assert(await dialog.getByLabel(/^Share sessions with /).isChecked(), 'Company sharing is enabled after explicit confirmation');
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await board.bringToFront();
      await board.goto(`${origin}${companyPath}/search?q=acceptance+webhook`);
      const results = board.locator('[data-testid="browser-session-results"]');
      await results.getByText(title, { exact: true }).waitFor({ timeout: 35_000 });
      assert(!(await results.innerText()).includes('Acceptance webhook private control'), 'The private fixture never appears in real session search');
      const evidence = await capture('pc-session-ui-search', board);
      await board.goto(`${origin}${companyPath}/issues/${fixture.issueIdentifier}`);
      await chooseTaskSessionsTab(board);
      const taskSessions = board.getByRole('region', { name: 'Task sessions', exact: true });
      await taskSessions.getByLabel('Link a session', { exact: true }).fill('acceptance webhook');
      await taskSessions.getByRole('button', { name: 'Search', exact: true }).click();
      await taskSessions.locator('li').filter({ hasText: title }).getByRole('button', { name: 'Link', exact: true }).click({ timeout: 25_000 });
      await taskSessions.locator('li').filter({ hasText: title }).getByRole('button', { name: 'Unlink', exact: true }).waitFor();
      await board.reload();
      await chooseTaskSessionsTab(board);
      await board.getByRole('region', { name: 'Task sessions', exact: true }).locator('li').filter({ hasText: title }).getByRole('button', { name: 'Unlink', exact: true }).waitFor();
      evidence.push(...await capture('pc-session-ui-linked-task', board));
      const boardVideo = await board.video()?.path();
      if (boardVideo) evidence.push({ path: relative(boardVideo), type: 'video', capturedAt: now, inspected: false });
      await board.close(); evidencePage = page; await page.bringToFront();
      return { observation: 'Paired through both real UIs, explicitly shared one synthetic session, excluded its private control from search, and persisted a real task link across reload. No provider page was opened.', evidence };
    });
  } else cases.push({ id: 'pc-session-ui', name: 'Paired shared session search and task-link UI', status: 'blocked', observation: 'The isolated plugin pairing/session UI case was not selected for this execution.', evidence: [] });

  if (process.env.TK_PAPERCLIP_RECOVERY_CONTROL) {
    await runCase('pc-recovery', 'An owned server outage preserves a route and recovers the frame', async () => {
      await page.bringToFront(); evidencePage = page;
      const openSettings = page.getByRole('dialog', { name: 'Settings', exact: true });
      if (await openSettings.isVisible()) await openSettings.getByRole('button', { name: 'Done', exact: true }).click();
      await chooseView('Paperclip');
      const control = path.resolve(process.env.TK_PAPERCLIP_RECOVERY_CONTROL);
      const before = (await paperclipFrame()).url();
      await until(() => Promise.resolve(liveSockets.size), count => count > 0, 15_000);
      lastMainSocketClosedAt = null;
      observingRecoveryLoss = true;
      const offlineObserved = page.locator('.tk-paperclip-empty').waitFor({ state: 'visible', timeout: 180_000 }).then(() => Date.now());
      fs.writeFileSync(control, JSON.stringify({ phase: 'request_stop', at: new Date().toISOString() })); record('recovery-control', { phase: 'request_stop', path: control });
      const stopped = await until(async () => JSON.parse(fs.readFileSync(control, 'utf8')), value => value.phase === 'stopped', 180_000);
      const observedOfflineAt = await offlineObserved;
      const offlineLatencyMs = observedOfflineAt - (lastMainSocketClosedAt ?? Date.parse(stopped.at));
      observingRecoveryLoss = false;
      assert(lastMainSocketClosedAt !== null && offlineLatencyMs <= 5_000, 'Offline panel appears within five seconds of first native socket loss', { firstSocketLossAt: lastMainSocketClosedAt, observedOfflineAt, offlineLatencyMs, upperBoundAfterFirstObservedLossMs: Math.max(0, offlineLatencyMs) });
      const offlineEvidence = await capture('pc-recovery-offline');
      fs.writeFileSync(control, JSON.stringify({ phase: 'request_start', at: new Date().toISOString() })); record('recovery-control', { phase: 'request_start', path: control });
      await until(async () => JSON.parse(fs.readFileSync(control, 'utf8')).phase, phase => phase === 'started', 180_000);
      await page.locator('.tk-paperclip-empty').waitFor({ state: 'hidden', timeout: 45_000 });
      const restored = await paperclipFrame(); await until(() => Promise.resolve(restored.url()), url => new URL(url).pathname === new URL(before).pathname);
      if (new URL(before).pathname.endsWith('/search')) await restored.locator('[data-page="search"]').waitFor({ state: 'visible', timeout: 30_000 });
      else if (new URL(before).pathname.endsWith('/issues')) await restored.locator('section.coordinator-task-list').waitFor({ state: 'visible', timeout: 30_000 });
      record('recovery-offline-evidence', { paths: offlineEvidence });
      return { observation: `The owned fixture server stopped and restarted; the extension rendered its offline panel, then restored ${new URL(before).pathname}.`, evidence: offlineEvidence };
    });
  } else cases.push({ id: 'pc-recovery', name: 'An owned server outage preserves a route and recovers the frame', status: 'blocked', observation: 'No owned-server recovery control was selected for this execution.', evidence: [] });

  if (process.env.TK_PAPERCLIP_AUTH_RUNTIME) {
    await runCase('pc-authenticated-frame', 'Real signup, approval, iframe sign-in, service worker and live task update', async () => {
      const authFixture = JSON.parse(fs.readFileSync(process.env.TK_PAPERCLIP_AUTH_RUNTIME, 'utf8'));
      const authOrigin = new URL(authFixture.origin).origin;
      if (!['127.0.0.1', 'localhost'].includes(new URL(authOrigin).hostname)) throw new Error('Authenticated fixture must be loopback.');
      const authPage = await context.newPage(); evidencePage = authPage;
      await authPage.goto(`${authOrigin}/auth`);
      if (process.env.TK_PAPERCLIP_AUTH_EXISTING_USER !== '1') {
        await authPage.getByRole('button', { name: 'Create one', exact: true }).click();
        await authPage.getByLabel('Name', { exact: true }).fill(authFixture.fixtureUser.name);
      }
      await authPage.getByLabel('Email', { exact: true }).fill(authFixture.fixtureUser.email);
      await authPage.getByLabel('Password', { exact: true }).fill(authFixture.fixtureUser.password);
      await authPage.getByRole('button', { name: process.env.TK_PAPERCLIP_AUTH_EXISTING_USER === '1' ? 'Sign In' : 'Create Account', exact: true }).click();
      await authPage.waitForURL(url => url.pathname !== '/auth', { timeout: 30_000 });
      const health = await authPage.evaluate(async () => (await (await fetch('/api/health')).json()).bootstrapStatus);
      if (health === 'bootstrap_pending') {
        await authPage.goto(authFixture.bootstrapUrl);
        await authPage.getByRole('button', { name: 'Accept invite', exact: true }).click();
        await authPage.getByRole('heading', { name: 'Bootstrap complete', exact: true }).waitFor();
        await authPage.getByRole('link', { name: 'Open board', exact: true }).click();
      }
      // Documented authenticated fixture setup, matching multi-user-authenticated.spec.ts.
      const company = await authPage.evaluate(async () => {
        const existing = await (await fetch('/api/companies', { credentials: 'include' })).json();
        const found = existing.find(item => item.name === 'Threadkeeper authenticated acceptance');
        if (found) return { id: found.id, prefix: found.issuePrefix };
        const response = await fetch('/api/companies', { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Threadkeeper authenticated acceptance' }) });
        if (!response.ok) throw new Error(`Company fixture setup failed (${response.status})`);
        const value = await response.json(); return { id: value.id, prefix: value.issuePrefix };
      });
      record('authenticated-fixture', { origin: authOrigin, companyId: company.id, companyPrefix: company.prefix, setup: 'Real UI signup and documented bootstrap; no cookie or token injection' });
      await page.bringToFront(); evidencePage = page;
      const dialog = await settingsPaperclip();
      await dialog.getByLabel('Server address', { exact: true }).fill(authOrigin);
      await dialog.getByTestId('paperclip-settings').getByRole('button', { name: /^(Connect|Check again)$/ }).click();
      await dialog.getByText(/This server needs you to sign in/).waitFor({ timeout: 20_000 });
      const approvalOpened = context.waitForEvent('page', { timeout: 30_000 });
      await dialog.getByRole('button', { name: 'Sign in with Paperclip', exact: true }).click();
      const approval = await approvalOpened;
      await approval.getByRole('button', { name: 'Approve CLI access', exact: true }).click({ timeout: 30_000 });
      await page.bringToFront();
      await dialog.getByRole('button', { name: 'Sign out', exact: true }).waitFor({ timeout: 30_000 });
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      const authenticatedEntry = new URL(managerUrl); authenticatedEntry.searchParams.set('view', 'paperclip'); authenticatedEntry.searchParams.set('pc', `/${company.prefix}/issues?view=all`);
      await page.goto(authenticatedEntry.href);
      const frame = await paperclipFrame(authOrigin);
      await frame.locator('aside.coordinator-sidebar').waitFor({ state: 'visible', timeout: 45_000 });
      if (process.env.TK_PAPERCLIP_WS_DIAGNOSTIC === '1') {
        const probe = target => target.evaluate(({ companyId }) => new Promise(resolve => {
          const url = new URL(`/api/companies/${encodeURIComponent(companyId)}/events/ws`, location.origin); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
          const socket = new WebSocket(url.href); let done = false;
          const finish = opened => { if (done) return; done = true; clearTimeout(timer); socket.close(); resolve({ opened, origin: location.origin, framed: window.parent !== window }); };
          const timer = setTimeout(() => finish(false), 5_000);
          socket.onopen = () => finish(true); socket.onerror = () => finish(false);
        }), { companyId: company.id });
        record('authenticated-ws-realm-control', { ordinary: await probe(authPage), iframe: await probe(frame) });
      }
      // Passive handshake diagnostics only. No cookies, headers or token values are retained.
      const network = await context.newCDPSession(frame);
      const socketPaths = new Map();
      await network.send('Network.enable');
      network.on('Network.webSocketCreated', event => { const url = new URL(event.url); socketPaths.set(event.requestId, url.pathname); });
      network.on('Network.webSocketHandshakeResponseReceived', event => record('authenticated-ws-handshake', { path: socketPaths.get(event.requestId) ?? 'native WebSocket', status: event.response.status, statusText: event.response.statusText }));
      network.on('Network.webSocketFrameError', event => record('authenticated-ws-error', { path: socketPaths.get(event.requestId) ?? 'native WebSocket', error: event.errorMessage }));
      network.on('Network.eventSourceMessageReceived', event => {
        try {
          const data = JSON.parse(event.data);
          const item = { host: new URL(authOrigin).host, transport: 'eventsource', eventType: data.type, action: data.payload?.action ?? null, companyId: data.companyId, issueId: data.payload?.issueId ?? (data.payload?.entityType === 'issue' ? data.payload?.entityId : null) };
          if (item.issueId) { liveEvents.push(item); record('native-live-event', item); }
        } catch {}
      });
      await frame.getByRole('button', { name: 'Open account menu', exact: true }).click();
      await frame.getByRole('button', { name: 'Sign out', exact: true }).click();
      await frame.getByRole('heading', { name: 'Sign in to Paperclip', exact: true }).waitFor();
      await frame.getByLabel('Email', { exact: true }).fill(authFixture.fixtureUser.email);
      await frame.getByLabel('Password', { exact: true }).fill(authFixture.fixtureUser.password);
      await frame.getByRole('button', { name: 'Sign In', exact: true }).click();
      await frame.waitForURL(url => url.pathname !== '/auth', { timeout: 30_000 });
      await frame.goto(`${authOrigin}/${company.prefix}/issues?view=all`);
      await frame.locator(`aside a[href="/${company.prefix}/issues"]`).waitFor({ state: 'visible', timeout: 45_000 });
      await frame.locator('section.coordinator-task-list').waitFor({ state: 'visible', timeout: 30_000 });
      record('authenticated-frame-state', await frame.evaluate(async () => {
        const response = await fetch('/api/auth/get-session', { credentials: 'include', cache: 'no-store' });
        const session = await response.json();
        return { hostVerified: document.documentElement.hasAttribute('data-threadkeeper-host'), transport: document.documentElement.getAttribute('data-paperclip-live-transport'), visibility: document.visibilityState, sessionStatus: response.status, userPresent: Boolean(session?.user) };
      }));
      await until(() => frame.evaluate(() => document.documentElement.getAttribute('data-paperclip-live-transport')), mode => mode === 'eventsource', 20_000);
      const documentId = await frame.evaluate(() => performance.timeOrigin);
      const taskTitle = `Authenticated websocket acceptance update ${Date.now()}`;
      const taskId = await authPage.evaluate(async ({ companyId, title }) => {
        const response = await fetch(`/api/companies/${encodeURIComponent(companyId)}/issues`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, status: 'backlog' }) });
        if (!response.ok) throw new Error(`Task fixture setup failed (${response.status})`);
        return (await response.json()).id;
      }, { companyId: company.id, title: taskTitle });
      await until(() => Promise.resolve(liveEvents.some(event => event.host === new URL(authOrigin).host && event.issueId === taskId && (event.eventType === 'issue.created' || event.action === 'issue.created'))), Boolean, 20_000);
      await frame.getByText(taskTitle, { exact: true }).waitFor({ timeout: 20_000 });
      assert(await frame.evaluate(() => performance.timeOrigin) === documentId, 'Authenticated task update appears without reloading the iframe');
      const registrations = await until(() => frame.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).map(item => ({ scope: item.scope, active: item.active?.scriptURL ?? null }))), values => values.some(item => item.scope === `${authOrigin}/` && item.active?.endsWith('/sw.js')), 15_000);
      assert(registrations.some(item => item.scope === `${authOrigin}/` && item.active?.endsWith('/sw.js')), 'Real Paperclip service worker is active in the authenticated iframe', registrations);
      await network.detach();
      const authEvidence = [];
      for (const target of [authPage, approval]) { const video = await target.video()?.path(); if (video) authEvidence.push({ path: relative(video), type: 'video', capturedAt: new Date().toISOString(), inspected: false }); }
      await authPage.close(); await approval.close(); await page.bringToFront();
      return { observation: 'A disposable user signed in through the real UI, approved Threadkeeper board access, then signed out and signed back in inside the real Paperclip iframe. Its same-auth HTTP event stream delivered the matching created-task event and updated the actual UI without reload; the real app service worker was active. No authentication cookies or tokens were injected.', evidence: authEvidence };
    });
  }
  if (process.env.TK_PAPERCLIP_READ_HOLD) {
    const control = path.resolve(process.env.TK_PAPERCLIP_READ_HOLD);
    const paired = cases.find(item => item.id === 'pc-session-ui')?.status === 'pass';
    if (!paired) throw new Error('Read-tool hold requires a successful explicit UI pairing case.');
    fs.writeFileSync(control, JSON.stringify({ phase: 'ready', at: new Date().toISOString(), origin, companyId: fixture.companyId, extensionId }));
    record('read-tool-hold', { phase: 'ready', path: control, companyId: fixture.companyId });
    await until(() => Promise.resolve(JSON.parse(fs.readFileSync(control, 'utf8')).phase), phase => phase === 'done', 300_000);
    record('read-tool-hold', { phase: 'done' });
  }

} catch (error) { record('runner-error', { error: error.stack || String(error) }); process.exitCode = 1; }
finally {
  let videoPath = null;
  if (page) { try { videoPath = await page.video()?.path(); } catch {} }
  if (context) await context.close();
  fs.rmSync(profile, { recursive: true, force: true });
  if (permissionFixture) {
    const currentSha = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex');
    if (currentSha === permissionFixture.fixtureSha256) fs.writeFileSync(manifestPath, originalManifestBytes);
    else permissionFixture.restoreSkippedDueToConcurrentChange = true;
    permissionFixture.restored = crypto.createHash('sha256').update(fs.readFileSync(manifestPath)).digest('hex') === permissionFixture.originalSha256;
  }
  const raw = { startedAt: stamp, completedAt: new Date().toISOString(), videoStartedAt, runtime: { name: 'project-playwright-runner', executablePath, browserVersion }, context: { managerUrl, origin, companyId: fixture.companyId, companyPrefix: fixture.companyPrefix, revision, diskBuild, loadedExtensionId: extensionId, permissionFixture }, cases, videoPath: videoPath ? relative(videoPath) : null, events };
  fs.writeFileSync(path.join(assets, 'execution.json'), JSON.stringify(raw, null, 2));
  fs.writeFileSync(path.join(output, 'latest-execution.json'), JSON.stringify({ execution: relative(path.join(assets, 'execution.json')) }, null, 2));
  record('complete', { execution: relative(path.join(assets, 'execution.json')), counts: Object.fromEntries(['pass', 'fail', 'blocked', 'not_run'].map(status => [status, cases.filter(item => item.status === status).length])) });
  if (cases.some(item => item.status === 'fail')) process.exitCode = 1;
}
