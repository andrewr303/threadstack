// Cross-package invariants between the Threadkeeper extension and the browser-sessions plugin (AGENTS.md §5.2).
// Neither package's suite sees the other's contracts, so a one-sided change could pass both.
// Numeric timing literals are parsed below; navigation checks execute the real TypeScript contracts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseSync } from 'oxc-parser';
import { tsImport } from '../cli/node_modules/tsx/dist/esm/api/index.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = {
  bridgeProtocol: 'extension/src/core/paperclip/bridge-protocol.ts',
  integrationRuntime: 'extension/src/core/paperclip/integration-runtime.ts',
  managerActions: 'extension/src/entrypoints/manager/paperclip-actions.ts',
  extensionHost: 'extension/src/core/paperclip/host.ts',
  fusion: 'extension/src/entrypoints/manager/PaperclipFusion.ts',
  manager: 'extension/src/entrypoints/manager/App.tsx',
  pluginContracts: 'packages/plugins/plugin-browser-sessions/src/contracts.ts',
  pluginManifest: 'packages/plugins/plugin-browser-sessions/src/manifest.ts',
  pluginPage: 'ui/src/pages/PluginPage.tsx',
  uiHost: 'ui/src/lib/threadkeeper-host.ts',
  uiSlot: 'ui/src/lib/threadkeeper-host-slot.ts',
};

/** Numeric value of `export const NAME = 1_500;` (digits, `_`, `*`, spaces only). */
export function constantFrom(source, name, label = 'source') {
  const match = source.match(new RegExp(`export const ${name}\\s*(?::\\s*number\\s*)?=\\s*([0-9_*\\s]+);`));
  if (!match) throw new Error(`${name} is not a numeric export const in ${label}`);
  return match[1].split('*').map((part) => Number(part.replace(/[_\s]/g, ''))).reduce((a, b) => a * b, 1);
}
function constant(file, name) { return constantFrom(fs.readFileSync(path.join(root, files[file]), 'utf8'), name, files[file]); }

/**
 * Returns every violated invariant (empty when the two packages agree).
 * Plugin: an action's deadlineAt = created + timeout − reportMargin; its own timer fires at created + timeout;
 * a cancelled action waits settle for the browser's verdict.
 * Extension: the guard stops at deadlineAt − verdictMargin and then waits at most verdictWait for the manager;
 * a cancel is seen within one loop pause plus one long-poll wait.
 */
export function timingViolations(v) {
  const errors = [];
  const verdictAfterDeadline = v.verdictWait - v.verdictMargin;
  if (verdictAfterDeadline + 1_000 > v.reportMargin) errors.push(`verdict lands ${verdictAfterDeadline} ms after deadlineAt; plugin timer is ${v.reportMargin} ms after it (need ≥1 s headroom)`);
  const cancelVerdict = v.loop + v.pollWait + v.verdictWait;
  if (cancelVerdict + 500 > v.settle) errors.push(`a cancel's verdict can take ${cancelVerdict} ms; plugin settle window is ${v.settle} ms (need ≥0.5 s headroom)`);
  const actionNeeds = v.pageLoad + v.sendReady + v.confirmation + 500 + v.verdictMargin;
  for (const [kind, budget] of [['send', v.sendTimeout], ['start', v.startTimeout]]) {
    if (actionNeeds > budget - v.reportMargin) errors.push(`${kind}: page load + delivery + verdict need ${actionNeeds} ms; plugin gives ${budget - v.reportMargin} ms before deadlineAt`);
  }
  return errors;
}

function currentTimings() {
  return {
    verdictMargin: constant('bridgeProtocol', 'VERDICT_MARGIN_MS'),
    loop: constant('bridgeProtocol', 'BRIDGE_LOOP_MS'),
    pollWait: constant('bridgeProtocol', 'BRIDGE_POLL_WAIT_MS'),
    verdictWait: constant('integrationRuntime', 'MANAGER_VERDICT_WAIT_MS'),
    pageLoad: constant('managerActions', 'PAGE_LOAD_MS'),
    sendReady: constant('managerActions', 'SEND_READY_MS'),
    confirmation: constant('managerActions', 'CONFIRMATION_MS'),
    reportMargin: constant('pluginContracts', 'ACTION_REPORT_MARGIN_MS'),
    settle: constant('pluginContracts', 'ACTION_SETTLE_MS'),
    sendTimeout: constant('pluginContracts', 'SEND_TIMEOUT_MS'),
    startTimeout: constant('pluginContracts', 'START_TIMEOUT_MS'),
  };
}

test('the extension reports an action verdict before the plugin times it out, and a cancel inside the settle window', () => {
  assert.deepEqual(timingViolations(currentTimings()), []);
});

test('the timing check catches a one-sided change (guards the check itself)', () => {
  const ok = currentTimings();
  assert.equal(timingViolations({ ...ok, verdictWait: ok.reportMargin + ok.verdictMargin }).length > 0, true);
  assert.equal(timingViolations({ ...ok, settle: ok.loop + ok.pollWait + ok.verdictWait }).length > 0, true);
  assert.equal(timingViolations({ ...ok, sendTimeout: 40_000 }).length > 0, true);
  assert.equal(constantFrom('export const X = 4 * 1024;', 'X'), 4096);
  assert.throws(() => constantFrom('export const X = other;', 'X'), /not a numeric/);
});

test('MAX_NOTICE_REGIONS matches between the extension host and the Paperclip UI', () => {
  assert.equal(constant('extensionHost', 'MAX_NOTICE_REGIONS'), constant('uiHost', 'MAX_NOTICE_REGIONS'));
});

test('the post-overlay session-selection window matches on both sides', () => {
  assert.equal(constant('extensionHost', 'SLOT_ACTIVATION_WINDOW_MS'), constant('uiHost', 'SLOT_ACTIVATION_WINDOW_MS'));
});

function descendants(node, predicate) {
  if (!node || typeof node !== 'object') return [];
  return [
    ...(predicate(node) ? [node] : []),
    ...Object.values(node).flatMap((child) => Array.isArray(child)
      ? child.flatMap((item) => descendants(item, predicate)) : descendants(child, predicate)),
  ];
}

/**
 * The two React entrypoints need their own browser/DB harnesses. Isolate only their real message
 * effects, located by syntax and message type, and execute them with explicit boundary bindings.
 * No mapping is reimplemented here; source formatting and quote style do not affect discovery.
 */
function messageEffect(file, ownerName, message) {
  const filename = files[file] ?? file;
  const source = fs.readFileSync(path.join(root, filename), 'utf8');
  const { program, errors } = parseSync(filename, source);
  assert.deepEqual(errors, [], filename);
  const owners = descendants(program, (node) => node.type === 'FunctionDeclaration' && node.id?.name === ownerName);
  assert.equal(owners.length, 1, `${filename}: ${ownerName}`);
  const effects = descendants(owners[0], (node) => node.type === 'CallExpression' && node.callee?.name === 'useEffect')
    .map((call) => call.arguments[0])
    .filter((callback) => descendants(callback, message).length > 0);
  assert.equal(effects.length, 1, `${filename}: one ${ownerName} message effect`);
  const callback = effects[0];
  const code = stripTypeScriptTypes(`(${source.slice(callback.start, callback.end)})`);
  return (bindings) => new Function(...Object.keys(bindings), `return ${code};`)(...Object.values(bindings))();
}

/** Follow the component PluginPage actually imports, keeping the boundary check across that seam. */
function slotComponentFile() {
  const source = fs.readFileSync(path.join(root, files.pluginPage), 'utf8');
  const { program, errors } = parseSync(files.pluginPage, source);
  assert.deepEqual(errors, [], files.pluginPage);
  const imports = program.body.filter((node) => node.type === 'ImportDeclaration'
    && node.specifiers.some((specifier) => specifier.local.name === 'ThreadkeeperSlot'));
  assert.equal(imports.length, 1, 'PluginPage imports its ThreadkeeperSlot');
  const specifier = imports[0].source.value;
  return specifier.startsWith('@/') ? `ui/src/${specifier.slice(2)}.tsx`
    : path.join(path.dirname(files.pluginPage), `${specifier}.tsx`);
}

const placementEffect = messageEffect('manager', 'App', (node) =>
  node.type === 'ObjectExpression' && node.properties.some((property) =>
    (property.key?.name ?? property.key?.value) === 'type' && property.value?.value === 'placed'));
const openViewEffect = messageEffect(slotComponentFile(), 'ThreadkeeperSlot', (node) =>
  node.type === 'NewExpression' && node.callee?.name === 'CustomEvent'
    && node.arguments[0]?.value === 'paperclip:threadkeeper-open-view');

const [extensionHost, fusion, uiHost, uiSlot, pluginManifest] = await Promise.all(
  ['extensionHost', 'fusion', 'uiHost', 'uiSlot', 'pluginManifest'].map((file) =>
    tsImport(path.join(root, files[file]), import.meta.url)),
);
const views = [['browse', 'browse'], ['threads', 'threads'], ['session-board', 'dashboard']];

test('the plugin pages and UI host expose the same Threadkeeper routes', () => {
  const pages = pluginManifest.default.ui.slots.filter((slot) => slot.type === 'page').map((slot) => slot.routePath);
  assert.deepEqual(pages, views.map(([route]) => route));
  assert.deepEqual(uiHost.THREADKEEPER_SLOT_VIEWS, pages);
});

for (const [route, shellView] of views) {
  test(`${route} round-trips through PluginPage, the host parser, fusion and App placement as ${shellView}`, () => {
    const packets = [];
    const placed = [];
    const parent = { postMessage: (data) => packets.push(data) };
    const frame = {};
    const extensionOrigin = `chrome-extension://${'a'.repeat(32)}`;
    const pageOrigin = 'http://127.0.0.1:3100';
    const rect = { x: 240, y: 48, width: 1040, height: 752 };
    const host = uiHost.createThreadkeeperHost({
      parent, extensionIds: ['a'.repeat(32)], currentPath: () => `/ACME/${route}`,
      currentTitle: () => route, navigate: () => {}, fusedAvailable: () => true,
      onPlaced: (view) => placed.push(view),
    });
    const fromShell = (body) => host.handleMessage({
      source: parent, origin: extensionOrigin, data: { source: 'threadkeeper-shell', v: 1, ...body },
    });
    const fromPage = (data) => extensionHost.parsePaperclipHostMessage(
      { source: frame, origin: pageOrigin, data }, frame, pageOrigin, { width: 1280, height: 800 },
    );
    assert.equal(fromShell({ type: 'hello' }), true);
    const ready = fromPage(packets.find((packet) => packet.type === 'ready'));
    const window = new EventTarget();
    window.addEventListener('paperclip:threadkeeper-open-view', (event) => {
      assert.equal(host.openView(event.detail.view), true);
    });
    const release = openViewEffect({
      view: uiHost.threadkeeperSlotView('browser-sessions', route),
      ref: { current: { ownerDocument: { documentElement: { getAttribute: () => route } } } },
      registerThreadkeeperSlot: uiSlot.registerThreadkeeperSlot, window, CustomEvent,
      // Placement observation belongs to the component's UI tests; keep this message effect deterministic.
      SLOT_ATTRIBUTE: uiSlot.SLOT_ATTRIBUTE, setUnresponsive: () => {},
      MutationObserver: class { observe() {} disconnect() {} }, setTimeout, clearTimeout,
    });
    try {
      assert.equal(uiSlot.currentThreadkeeperSlot().view, route);
      assert.deepEqual(fromPage(packets.find((packet) => packet.type === 'open-view')), { type: 'open-view', view: shellView });
      assert.equal(host.reportSlot({ view: uiSlot.currentThreadkeeperSlot().view, rect, scheme: 'dark' }), true);
      const slot = fromPage(packets.find((packet) => packet.type === 'slot'));
      assert.deepEqual(slot, { type: 'slot', view: shellView, rect, scheme: 'dark' });
      const state = fusion.fusionReducer(fusion.fusionReducer(fusion.INITIAL_FUSION, { ...ready, at: 1000 }), { ...slot, at: 1100 });
      assert.equal(state.engaged, true);
      assert.equal(state.slotView, shellView);
      assert.equal(fusion.fusedRoute(state.slotView, '/ACME/issues/T-1'), `/ACME/${route}`);
      const paperclipControl = { current: { post: (body) => assert.equal(fromShell(body), true) } };
      placementEffect({ fused: true, fusion: state, paperclipControl });
      assert.deepEqual(placed, [route]);
      placementEffect({ fused: false, fusion: state, paperclipControl });
      assert.deepEqual(placed, [route]);
      assert.equal(host.reportSlot(null), true);
      const cleared = fromPage(packets.at(-1));
      const leaving = fusion.fusionReducer(state, { ...cleared, at: 1200 });
      placementEffect({ fused: true, fusion: leaving, paperclipControl });
      assert.deepEqual(placed, [route, null]);
    } finally {
      release();
      host.disconnect();
    }
  });
}
