import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertBuiltManifest, assertThreadkeeperSafety, checkCommands, safeBuildEnv } from './threadkeeper-check.mjs';
import { deploymentEnv } from './threadkeeper-deploy.mjs';

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-check-test-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: {
    'check:extension': 'node scripts/threadkeeper-check.mjs extension',
    'check:all': 'node scripts/threadkeeper-check.mjs all',
    'deploy:extension': 'node scripts/threadkeeper-deploy.mjs',
  } }));
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - packages/*\n  - ui\n');
  fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'importers:\n  .: {}\n');
  return root;
}

test('checks refuse unsafe script or workspace edits before running anything', () => {
  const root = fixture();
  try {
    assert.doesNotThrow(() => assertThreadkeeperSafety(root));
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
    manifest.scripts['check:extension'] = 'cd extension && npm run check';
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    assert.throws(() => assertThreadkeeperSafety(root), /check:extension must build to \/tmp\/tk-build only/);
    manifest.scripts['check:extension'] = 'node scripts/threadkeeper-check.mjs extension';
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify(manifest));
    fs.appendFileSync(path.join(root, 'pnpm-workspace.yaml'), '  - "**"\n');
    assert.throws(() => assertThreadkeeperSafety(root), /extension must not be a pnpm workspace member \(React 18\)/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('checks and deployment force path IDs, with no inherited live destination', () => {
  const env = safeBuildEnv({ TK_OUT_DIR: '/live', TK_LIVE_DIR: '/live', TK_STABLE_ID: '1' });
  assert.equal(env.TK_OUT_DIR, '/tmp/tk-build');
  assert.equal(env.TK_STABLE_ID, '0');
  assert.equal(env.TK_LIVE_DIR, undefined);
  assert.throws(() => deploymentEnv({}), /Set TK_LIVE_DIR to the folder your browser loads Threadkeeper from/);
  assert.throws(() => deploymentEnv({ TK_LIVE_DIR: '/' }), /dedicated build folder/);
  assert.equal(deploymentEnv({ TK_LIVE_DIR: '/tmp/live-test', TK_STABLE_ID: '1' }).TK_STABLE_ID, '0');
  assert.equal(deploymentEnv({ TK_LIVE_DIR: '/tmp/live-test' }).TK_OUT_DIR, '/tmp/live-test');
});

test('whole-fork command plan checks both toolchains and stops through argv execution', () => {
  const commands = checkCommands('all');
  assert.deepEqual(commands.slice(0, 2).map(c => c.args.at(-1)), ['typecheck', 'test:run']);
  assert.deepEqual(commands.at(-1).args, ['scripts/build-extension.mjs']);
  // The guard tests run in both modes, from the fork root, before the extension toolchain.
  assert.deepEqual(commands.filter(c => c.directory === '.').map(c => c.args.at(-1)), ['typecheck', 'test:run', 'scripts/threadkeeper-contracts.test.mjs']);
  assert.ok(commands.slice(3).every(c => c.directory === 'extension'));
  assert.deepEqual(checkCommands('extension').filter(c => c.directory === '.').map(c => c.args), [['--test', 'scripts/threadkeeper.test.mjs', 'scripts/threadkeeper-contracts.test.mjs']]);
  assert.ok(commands.every(c => !c.shell));
});

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const temp = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-guard-test-')));

test('guard tests are wired into package.json and both check modes', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['test:threadkeeper'], 'node --test scripts/threadkeeper.test.mjs scripts/threadkeeper-contracts.test.mjs');
  for (const mode of ['all', 'extension']) {
    assert.ok(checkCommands(mode).some(c => c.args.join(' ') === '--test scripts/threadkeeper.test.mjs scripts/threadkeeper-contracts.test.mjs' && c.directory === '.'), mode);
  }
});

test('a lockfile importer or a non-18 React installation fails the guard', () => {
  const root = fixture();
  try {
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'importers:\n  .: {}\n  extension:\n    dependencies: {}\n');
    assert.throws(() => assertThreadkeeperSafety(root), /extension must not be a pnpm workspace member \(React 18\)/);
    fs.writeFileSync(path.join(root, 'pnpm-lock.yaml'), 'importers:\n  .: {}\n');
    const react = path.join(root, 'extension/node_modules/react');
    fs.mkdirSync(react, { recursive: true });
    fs.writeFileSync(path.join(react, 'package.json'), JSON.stringify({ version: '19.0.0' }));
    assert.throws(() => assertThreadkeeperSafety(root), /extension must keep React 18/);
    fs.writeFileSync(path.join(react, 'package.json'), JSON.stringify({ version: '18.3.1' }));
    assert.doesNotThrow(() => assertThreadkeeperSafety(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an output path that is a symlink fails the guard before anything runs', () => {
  const root = fixture(), base = temp();
  try {
    const real = path.join(base, 'real'); fs.mkdirSync(real);
    const link = path.join(base, 'link'); fs.symlinkSync(real, link);
    assert.throws(() => assertThreadkeeperSafety(root, [link]), /no output symlinks/);
    assert.doesNotThrow(() => assertThreadkeeperSafety(root, [real, path.join(base, 'absent')]));
  } finally { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(base, { recursive: true, force: true }); }
});

test('the built manifest must exist, be fresh and carry no key; a stale build is replaced, not trusted', () => {
  const dir = temp();
  try {
    const manifest = path.join(dir, 'manifest.json');
    assert.throws(() => assertBuiltManifest(dir, 0), /manifest\.json was not built/);
    fs.writeFileSync(manifest, JSON.stringify({ name: 'Threadkeeper', key: 'MIIB' }));
    assert.throws(() => assertBuiltManifest(dir, 0), /must not contain a key/);
    fs.writeFileSync(manifest, JSON.stringify({ name: 'Threadkeeper' }));
    const old = new Date(Date.now() - 3_600_000); fs.utimesSync(manifest, old, old);
    assert.throws(() => assertBuiltManifest(dir, Date.now() - 60_000), /stale/);
    fs.writeFileSync(manifest, JSON.stringify({ name: 'Threadkeeper' }));
    assert.doesNotThrow(() => assertBuiltManifest(dir, Date.now() - 60_000));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('deployment refuses relative, unsafe and aliased targets', () => {
  const base = temp();
  try {
    const home = path.join(base, 'home'), fork = path.join(home, 'dev', 'threadkeeper', 'paperclip');
    fs.mkdirSync(fork, { recursive: true });
    const refuse = (value, pattern = /dedicated build folder/) => assert.throws(() => deploymentEnv({ TK_LIVE_DIR: value }, { home, fork }), pattern);
    for (const value of ['.', 'foo/', '..', 'foo', './foo']) refuse(value);
    refuse('/');
    refuse(home);
    refuse(`${home}/`);
    refuse(path.dirname(home));
    refuse(fork);
    refuse(path.join(fork, 'extension', '.output', 'chrome-mv3'));
    refuse('/tmp/tk-build');
    refuse('/tmp/tk-build/inner');
    refuse('/tmp/tk-build/../tk-build');
    const alias = (name, to) => { const link = path.join(base, name); fs.symlinkSync(to, link); return link; };
    refuse(alias('home-alias', home));
    refuse(alias('fork-alias', path.join(fork, 'extension')));
    refuse(alias('build-alias', '/tmp/tk-build'));
    // The real default home is guarded too, and the real fork is refused without injection.
    assert.throws(() => deploymentEnv({ TK_LIVE_DIR: os.homedir() }), /dedicated build folder/);
    assert.throws(() => deploymentEnv({ TK_LIVE_DIR: path.join(repoRoot, 'extension') }), /dedicated build folder/);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('deployment allows other folders inside the home directory, such as the documented live folder', () => {
  const base = temp();
  try {
    const home = path.join(base, 'home'), fork = path.join(home, 'dev', 'threadkeeper', 'paperclip');
    fs.mkdirSync(fork, { recursive: true });
    const live = path.join(home, 'dev', 'threadkeeper', '.output', 'chrome-mv3');
    const env = deploymentEnv({ TK_LIVE_DIR: live, TK_STABLE_ID: '1' }, { home, fork });
    assert.equal(env.TK_OUT_DIR, live);
    assert.equal(env.TK_STABLE_ID, '0');
    assert.equal(fs.existsSync(live), false, 'the guard itself writes nothing');
    fs.mkdirSync(live, { recursive: true });
    const link = path.join(base, 'live-link'); fs.symlinkSync(live, link);
    assert.equal(deploymentEnv({ TK_LIVE_DIR: link }, { home, fork }).TK_OUT_DIR, link);
    assert.doesNotThrow(() => deploymentEnv({ TK_LIVE_DIR: path.join(home, 'Documents', 'tk') }, { home, fork }));
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('the deploy entry point exits 1 and writes nothing when TK_LIVE_DIR is missing or relative', () => {
  const base = temp();
  try {
    const cwd = path.join(base, 'a', 'b'); fs.mkdirSync(cwd, { recursive: true });
    const script = path.join(repoRoot, 'scripts', 'threadkeeper-deploy.mjs');
    const run = live => {
      const env = { ...process.env }; delete env.TK_LIVE_DIR;
      if (live !== undefined) env.TK_LIVE_DIR = live;
      return spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8', timeout: 30_000 });
    };
    for (const live of [undefined, '', '.', 'foo/', '..']) {
      const result = run(live);
      assert.equal(result.status, 1, `TK_LIVE_DIR=${JSON.stringify(live)}: ${result.stderr}`);
      assert.match(result.stderr, /TK_LIVE_DIR/);
    }
    assert.deepEqual(fs.readdirSync(cwd), []);
    assert.deepEqual(fs.readdirSync(path.join(base, 'a')), ['b']);
    assert.deepEqual(fs.readdirSync(base), ['a']);
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
