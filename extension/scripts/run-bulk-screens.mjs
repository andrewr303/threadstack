// Bulk thread management in the packaged extension (Chromium, headless):
//   1. Row checkboxes and shift-click range select never change the opened thread.
//   2. The bulk bar applies a status change to exactly the checked threads, and Undo restores it.
//   3. Sort control, kanban and project-card checkboxes, the delete confirmation and layered Escape.
//   4. Light and dark themes, the 700 px narrow layout and the ~400 px side panel without horizontal overflow.
// Screenshots are written to evidence/bulk/. Requires `npm run build` first.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const dist = path.join(root, '.output', 'chrome-mv3');
const out = path.join(root, 'evidence', 'bulk');
const executablePath = process.env.CHROME_EXECUTABLE_PATH || undefined;
fs.mkdirSync(out, { recursive: true });

const log = (...a) => console.log('[bulk-screens]', ...a);
function check(condition, message) {
  if (!condition) throw new Error(`FAILED: ${message}`);
  log(`ok — ${message}`);
}

const horizontalOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const openedTitle = (page) => page.locator('.tk-detail-title').innerText();
const rowChecks = (page) => page.locator('#tk-main-list .tk-row-list .tk-row-check input');
const shot = (page, name) => page.screenshot({ path: path.join(out, name) });

/** Archived threads in the extension's own database. */
const countArchived = (page) =>
  page.evaluate(async () => {
    const req = indexedDB.open('ThreadkeeperDB');
    const db = await new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    const rows = await new Promise((resolve) => {
      const r = db.transaction('conversations').objectStore('conversations').getAll();
      r.onsuccess = () => resolve(r.result);
    });
    db.close();
    return rows.filter((c) => c.workflowState === 'archived').length;
  });

async function launch() {
  const context = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-bulk-')), {
    executablePath,
    headless: true,
    viewport: { width: 1280, height: 860 },
    args: ['--headless=new', `--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
  });
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  return { context, extId: new URL(sw.url()).host };
}

async function run() {
  const { context, extId } = await launch();
  const errors = [];
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(`page: ${e.message}`));
  await page.goto(`chrome-extension://${extId}/manager.html?surface=page&seed=1`);
  await rowChecks(page).nth(3).waitFor({ timeout: 10000 });

  // 1. Checking rows, with a shift-click range, leaves the opened thread alone.
  const before = await openedTitle(page);
  await rowChecks(page).nth(0).click();
  await rowChecks(page).nth(2).click({ modifiers: ['Shift'] });
  check((await page.locator('.tk-bulk-count').innerText()).startsWith('3 selected'), 'shift-click checks the range: 3 selected');
  check((await openedTitle(page)) === before, 'checking rows does not change the opened thread');
  check((await page.locator('#tk-main-list .tk-row-item[data-checked="true"]').count()) === 3, 'checked rows are marked');
  await shot(page, '01-bulk-bar-1280-light.png');

  // 2. Set status on exactly the checked threads, then Undo.
  const archivedBefore = await countArchived(page);
  const checkedTitles = await page
    .locator('#tk-main-list .tk-row-item[data-checked="true"] .tk-row-title')
    .allInnerTexts();
  await page.selectOption('select[aria-label="Action for the selected threads"]', 'status');
  await page.selectOption('select[aria-label="Status for the selected threads"]', 'archived');
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.locator('.tk-bulk-result', { hasText: 'Set 3 threads to Archived' }).waitFor();
  check(archivedBefore === 0, 'the seeded library starts with no archived threads');
  check((await countArchived(page)) === 3, `exactly the 3 checked threads were archived (${checkedTitles.join(' | ')})`);
  await shot(page, '02-bulk-applied.png');
  await page.locator('.tk-bulk-result').getByRole('button', { name: 'Undo' }).click();
  await page.locator('.tk-bulk-result', { hasText: 'Undid' }).waitFor();
  check((await countArchived(page)) === 0, 'Undo in the bar restores the previous status');

  // 3a. Sort: Title A–Z orders the list by title.
  await page.selectOption('select[aria-label="Sort threads"]', 'title');
  const titles = await page.locator('#tk-main-list .tk-row-list .tk-row-title').allInnerTexts();
  const sorted = [...titles].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true }));
  check(JSON.stringify(titles) === JSON.stringify(sorted), 'Title A–Z sorts the list');
  await page.selectOption('select[aria-label="Sort threads"]', 'recent');

  // 3b. Delete confirmation states the count; Escape closes the dialog first, then clears the selection.
  await page.getByRole('button', { name: 'Delete…' }).click();
  const dialog = page.locator('#tk-bulk-delete-dialog');
  await dialog.waitFor({ state: 'visible' });
  check(/Delete 3 threads\?/.test(await dialog.locator('h2').innerText()), 'delete dialog states the count');
  check(/tombstone/.test(await dialog.innerText()), 'delete dialog says deletion leaves tombstones');
  await shot(page, '03-delete-dialog.png');
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  check((await page.locator('.tk-bulk-count').count()) === 1, 'first Escape closes only the dialog');
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.locator('.tk-bulk-count').waitFor({ state: 'detached' });
  check(true, 'second Escape clears the selection');

  // 3c. Kanban and project cards carry checkboxes too.
  for (const [mode, file] of [
    ['kanban', '04-kanban-checked.png'],
    ['cards', '05-cards-checked.png'],
  ]) {
    await page.selectOption('select[aria-label="View mode"]', mode);
    const cardCheck = page.locator('#tk-main-list .tk-card-item .tk-row-check input');
    await cardCheck.first().waitFor();
    await cardCheck.first().click();
    check((await page.locator('#tk-main-list .tk-card-item[data-checked="true"]').count()) === 1, `${mode}: a card can be checked`);
    check((await openedTitle(page)) === before, `${mode}: checking a card does not change the opened thread`);
    const staleResult = await page.locator('.tk-bulk-result').allInnerTexts();
    check(staleResult.length === 0, `${mode}: a new selection starts without the last result line${staleResult.length ? ` (saw: ${staleResult.join(' / ')})` : ''}`);
    await shot(page, file);
    await page.keyboard.press('Escape');
  }
  await page.selectOption('select[aria-label="View mode"]', 'list');

  // 4. Dark theme, then the 700 px narrow layout.
  await rowChecks(page).nth(1).click();
  await page.getByRole('button', { name: 'Toggle color theme' }).click();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'dark');
  await shot(page, '06-bulk-bar-1280-dark.png');
  await page.setViewportSize({ width: 700, height: 860 });
  check((await horizontalOverflow(page)) === 0, '700 px narrow layout has no horizontal overflow with the bulk bar open');
  await shot(page, '07-bulk-bar-700-dark.png');
  await page.getByRole('button', { name: 'Toggle color theme' }).click();
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') === 'light');
  check((await horizontalOverflow(page)) === 0, '700 px narrow layout has no horizontal overflow in light');
  await shot(page, '08-bulk-bar-700-light.png');

  // Side panel at ~400 px.
  const side = await context.newPage();
  side.on('pageerror', (e) => errors.push(`sidepanel: ${e.message}`));
  await side.setViewportSize({ width: 400, height: 860 });
  await side.goto(`chrome-extension://${extId}/sidepanel.html`);
  await rowChecks(side).nth(2).waitFor({ timeout: 10000 });
  await rowChecks(side).nth(0).click();
  await rowChecks(side).nth(2).click({ modifiers: ['Shift'] });
  await side.selectOption('select[aria-label="Action for the selected threads"]', 'move');
  check((await horizontalOverflow(side)) === 0, 'side panel at 400 px has no horizontal overflow with the bulk bar open');
  await shot(side, '09-side-panel-400.png');

  // Keyboard: the select-all checkbox is reachable and shows focus.
  await side.locator('.tk-bulk-bar input[type="checkbox"]').focus();
  await side.keyboard.press('Space');
  const allChecked = await side.locator('#tk-main-list .tk-row-list .tk-row-item[data-checked="true"]').count();
  const allRows = await side.locator('#tk-main-list .tk-row-list .tk-row-item').count();
  check(allChecked === allRows, 'Space on "Select all in view" checks every row in view');
  await shot(side, '10-side-panel-select-all.png');

  check(errors.length === 0, `no page errors${errors.length ? `: ${errors.join('; ')}` : ''}`);
  await context.close();
}

if (!fs.existsSync(path.join(dist, 'manifest.json'))) {
  throw new Error('Build the extension first: npm run build');
}
await run();
log(`passed — screenshots in ${path.relative(root, out)}`);
