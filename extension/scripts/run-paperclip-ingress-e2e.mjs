// Affected acceptance for local-trusted process-owner inspection. Existing isolated fixture only.
// Pairing codes stay in memory; no video, DOM dump, headers or bodies containing credentials.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const extensionRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repo = path.resolve(extensionRoot, '..');
const fixture = JSON.parse(fs.readFileSync('/tmp/threadkeeper-acceptance-runtime.json', 'utf8'));
const origin = new URL(fixture.origin).origin;
if (origin !== 'http://127.0.0.1:3217' || fixture.postgresPort !== 55487) throw new Error('Only the owned3217/55487 fixture is allowed.');
const dist = fs.realpathSync('/tmp/tk-fused-build');
const live = fs.realpathSync('/Users/andrew/dev/threadkeeper/.output/chrome-mv3');
if (dist === live || dist.startsWith(`${live}${path.sep}`)) throw new Error('Refusing the live extension.');
const output = path.resolve(process.env.TK_AUTH_OUT || '');
if (!process.env.TK_AUTH_OUT || fs.existsSync(output)) throw new Error('Choose a fresh explicit TK_AUTH_OUT directory.');
const executablePath = process.env.CHROME_EXECUTABLE_PATH;
if (!executablePath || !fs.existsSync(executablePath)) throw new Error('An existing selected Chrome/Edge executable is required.');
fs.mkdirSync(path.join(output, 'assets'), { recursive: true });
const manifestPath = path.join(dist, 'manifest.json');
const originalManifest = fs.readFileSync(manifestPath);
const manifest = JSON.parse(originalManifest);
if (manifest.key) throw new Error('The test extension must have no stable key.');
manifest.host_permissions = [...new Set([...(manifest.host_permissions ?? []), 'http://127.0.0.1/*', 'http://localhost/*'])];
const fixtureManifest = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
const extensionId = [...crypto.createHash('sha256').update(dist).digest('hex').slice(0, 32)].map(c => String.fromCharCode(97 + parseInt(c, 16))).join('');
if (!fixture.extensionIds.includes(extensionId)) throw new Error('Server allowlist must include the path-derived test extension ID.');
const build = JSON.parse(fs.readFileSync(path.join(dist, 'build-info.json')));
const middleware = path.join(repo, 'server/src/middleware/local-agent-process-boundary.ts');
const middlewareSha = crypto.createHash('sha256').update(fs.readFileSync(middleware)).digest('hex');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-auth-ingress-'));
const base = `/${fixture.companyPrefix}`;
const manager = `chrome-extension://${extensionId}/manager.html?surface=page&view=threads`;
const cases = [], events = [], assetReads = [];
let context, page, board, sw, browserVersion, sensitivePairingUi = false;
const record = (kind, data) => events.push({ at: new Date().toISOString(), kind, ...data });
const check = (value, message) => { if (!value) throw new Error(message); };
async function until(read, accept, timeout = 35000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await read(); if (accept(value)) return value; await new Promise(resolve => setTimeout(resolve, 150)); }
  throw new Error('Expected browser outcome did not arrive within its bound.');
}
async function shot(id, target) {
  const capturedAt = new Date().toISOString(), relative = `assets/${id}.png`;
  await target.screenshot({ path: path.join(output, relative) });
  return { path: relative, capturedAt, url: target.url(), viewport: target.viewportSize(), type: 'screenshot' };
}
async function run(id, name, action) {
  const item = { id, name, startedAt: new Date().toISOString(), evidence: [] };
  try { item.observation = await action(item); item.status = 'pass'; }
  catch (error) {
    item.status = 'fail'; item.observation = String(error.stack || error);
    if (!sensitivePairingUi) item.evidence.push(await shot(`${id}-failed`, board && !board.isClosed() ? board : page).catch(() => null));
    else item.evidenceGap = 'Screenshot omitted while a transient pairing code might be visible.';
  }
  item.completedAt = new Date().toISOString(); item.evidence = item.evidence.filter(Boolean); cases.push(item);
  fs.writeFileSync(path.join(output, `${id}.json`), JSON.stringify(item, null, 2));
  console.log(JSON.stringify({ id, status: item.status, observation: item.observation?.slice(0, 250) }));
  return item.status === 'pass';
}
async function settings() {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true });
  await dialog.locator('#tk-settings-tab-paperclip').click(); return dialog;
}
try {
  fs.writeFileSync(manifestPath, fixtureManifest);
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true, colorScheme: 'dark', viewport: { width: 1280, height: 900 }, args: ['--headless=new', '--no-first-run', '--no-default-browser-check', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`] });
  browserVersion = context.browser().version();
  await context.route(/^https?:\/\//, route => ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort('blockedbyclient'));
  context.on('response', response => {
    const url = new URL(response.url());
    if (url.origin !== origin) return;
    if (url.pathname.startsWith('/api/')) record('response', { method: response.request().method(), operation: /pair/i.test(url.pathname) ? 'browser-pairing-route' : url.pathname, status: response.status() });
    if (url.pathname.startsWith('/assets/') && /\.(?:js|css)$/.test(url.pathname)) assetReads.push((async () => {
      const body = await response.body(); const disk = path.join(repo, 'ui/dist', url.pathname);
      record('served-asset', { path: url.pathname, sha256: crypto.createHash('sha256').update(body).digest('hex'), matchesDisk: fs.existsSync(disk) && body.equals(fs.readFileSync(disk)) });
    })().catch(error => record('asset-read-error', { message: String(error) })));
  });
  [sw] = context.serviceWorkers(); if (!sw) sw = await context.waitForEvent('serviceworker');
  check(new URL(sw.url()).host === extensionId, 'The exact isolated extension must load.');
  check((await sw.evaluate(() => chrome.runtime.getManifest())).version_name === build.versionName, 'Loaded build must match the retained extension build.');
  page = context.pages()[0] ?? await context.newPage();
  const connected = await run('AUTH-I1', 'Legitimate browser connects to the real local-trusted app', async item => {
    await page.goto(manager); await page.locator('.tk-workbench').waitFor();
    const dialog = await settings();
    await dialog.getByLabel('Server address', { exact: true }).fill(origin);
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await dialog.getByText(/Found Paperclip.*local trusted mode/).waitFor({ timeout: 35000 });
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await page.locator('.tk-rail .tk-paperclip-status[data-state="running"]').waitFor({ timeout: 35000 });
    const frame = await until(() => Promise.resolve(page.frames().find(frame => frame.url().startsWith(origin))), Boolean);
    await frame.locator(`aside a[href="${base}/issues"]`).waitFor();
    item.evidence.push(await shot('AUTH-I1-connected', page));
    return 'Real extension Settings Connect reached running status and the actual company sidebar rendered. No provider account or credential was injected.';
  });
  if (connected) {
    await run('AUTH-I2', 'Legitimate company task and settings navigation is authorized', async item => {
      board = await context.newPage();
      await board.goto(`${origin}${base}/issues?view=all`);
      await board.locator('section.coordinator-task-list').getByText(fixture.issueIdentifier, { exact: true }).waitFor({ timeout: 45000 });
      item.evidence.push(await shot('AUTH-I2-company-tasks', board));
      await board.goto(`${origin}${base}/company/settings/browser-sessions`);
      await board.getByRole('region', { name: 'Browser sessions settings', exact: true }).waitFor({ timeout: 35000 });
      item.evidence.push(await shot('AUTH-I2-browser-settings', board));
      return 'The actual company Tasks list includes the owned THR-1 fixture, and its Browser sessions settings region renders through normal browser ingress.';
    });
    await run('AUTH-I3', 'Pair and read a shared synthetic session while excluding its private control', async item => {
      const suffix = executablePath.includes('Edge') ? 'edge' : 'chrome';
      const key = `claude_code:acct_claude_code_primary:default:authfallback_${suffix}:main`, title = `Authfallback shared session ${suffix}`, privateTitle = `Authfallback private control ${suffix}`;
      await sw.evaluate(async ({ key, title, privateTitle }) => {
        const now = new Date().toISOString();
        const base = { provider: 'claude_code', accountId: 'acct_claude_code_primary', workspaceId: 'default', sourceConversationId: 'authfallback', branchId: 'main', parentBranchId: null, siblingBranchIds: [], canonicalUrl: 'https://claude.ai/code/session_authfallback', title, manualTitleOverride: null, createdAt: now, updatedAt: now, lastCapturedAt: now, sourceRevision: 1, contentHash: 'authfallback-fixture', coverage: 'full', captureSource: 'manual', messageCount: 1, project: 'General research', categoryLocked: true, tags: [], manualTags: [], workflowState: 'active', manualNotes: '', pinned: false, snoozedUntil: null, dismissedQueues: [], cloudExcluded: false, cloudTaskStatus: 'unsupported', isSyntheticBenchmark: false, latestDecisionText: null, latestDecisionMsgIndex: null, latestDecisionSpeaker: null, nextStepText: null, nextStepMsgIndex: null, nextStepSpeaker: null, agentState: null };
        await globalThis.__threadStackDb.conversations.bulkPut([{ ...base, threadKey: key }, { ...base, threadKey: key + '_private', title: privateTitle, sourceConversationId: 'authfallback_private', cloudExcluded: true }]);
        await globalThis.__threadStackDb.messages.put({ messageKey: key + ':m0', threadKey: key, ordinal: 0, sourceMessageId: 'authfallback-m0', role: 'user', content: 'Synthetic authfallback evidence: make webhook retries safe.', createdAt: now, contentHash: 'authfallback-message', hasCode: false, hasArtifact: false, branchPath: 'main' });
      }, { key, title, privateTitle });
      if (!board || board.isClosed()) board = await context.newPage();
      await board.goto(`${origin}${base}/company/settings/browser-sessions`);
      const region = board.getByRole('region', { name: 'Browser sessions settings', exact: true });
      await region.waitFor();
      const disconnect = region.getByRole('button', { name: 'Disconnect', exact: true });
      if (await disconnect.count() === 1 && await disconnect.isEnabled()) { await disconnect.click(); await until(() => region.getByRole('checkbox', { name: 'Share sessions with this company', exact: true }).isDisabled(), Boolean); }
      await page.bringToFront(); const dialog = await settings();
      const pair = dialog.getByRole('button', { name: /^Pair / });
      await pair.waitFor({ state: 'visible', timeout: 35000 }); check(await pair.count() === 1, 'Exactly one owned test company can pair.');
      sensitivePairingUi = true; await pair.click();
      const code = (await dialog.locator('.tk-paperclip-pair-code').innerText()).trim();
      check(/^[A-Z0-9]{8}$/.test(code), 'The real UI supplies a pairing code.');
      await board.bringToFront(); await board.reload();
      await board.getByLabel('Confirm pairing code', { exact: true }).fill(code);
      await board.getByLabel('Share sessions with this company after pairing', { exact: true }).check();
      await board.getByRole('button', { name: 'Confirm code', exact: true }).click();
      await page.bringToFront();
      await dialog.getByLabel(/^Share sessions with /).waitFor({ timeout: 35000 });
      check(await dialog.getByLabel(/^Share sessions with /).isChecked(), 'The owned company explicitly shares the seeded library.');
      await dialog.getByRole('button', { name: 'Done', exact: true }).click();
      await board.goto(`${origin}${base}/search?q=authfallback`); sensitivePairingUi = false;
      const results = board.locator('[data-testid="browser-session-results"]');
      await results.getByText(title, { exact: true }).waitFor({ timeout: 45000 });
      const text = await results.innerText(); check(!text.includes(privateTitle), 'Private synthetic control must be excluded.');
      check(text.includes('webhook retries safe'), 'The paired search UI reads the actual synthetic message excerpt.');
      item.evidence.push(await shot('AUTH-I3-shared-read', board));
      await board.goto(`${origin}${base}/company/settings/browser-sessions`);
      await board.getByRole('region', { name: 'Browser sessions settings', exact: true }).getByRole('button', { name: 'Disconnect', exact: true }).click();
      return 'Real board/extension pairing and explicit sharing succeeded. Company search read the seeded message excerpt and excluded its private control. The disposable pairing was then disconnected. Pairing code and tokens were never captured.';
    });
  }
} catch (error) { record('runner-error', { message: String(error.stack || error) }); process.exitCode = 1; }
finally {
  await Promise.allSettled(assetReads);
  if (context) await context.close().catch(() => {});
  fs.rmSync(profile, { recursive: true, force: true });
  if (fs.readFileSync(manifestPath).equals(fixtureManifest)) fs.writeFileSync(manifestPath, originalManifest);
  const result = { completedAt: new Date().toISOString(), browser: { executablePath, version: browserVersion }, origin, extensionId, build, middlewareSha256: middlewareSha, middlewareUnchangedDuringRun: middlewareSha === crypto.createHash('sha256').update(fs.readFileSync(middleware)).digest('hex'), manifestRestored: fs.readFileSync(manifestPath).equals(originalManifest), credentialCapturePolicy: 'No videos, DOM dumps, request headers or pairing values; snapshots only after transient pairing code is gone.', cases, events, counts: Object.fromEntries(['pass', 'fail'].map(status => [status, cases.filter(item => item.status === status).length])) };
  fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify({ complete: true, counts: result.counts, output }));
  if (cases.some(item => item.status === 'fail')) process.exitCode = 1;
}
