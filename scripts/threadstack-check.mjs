import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scripts = {
  'check:extension': 'node scripts/threadstack-check.mjs extension',
  'check:all': 'node scripts/threadstack-check.mjs all',
  'deploy:extension': 'node scripts/threadstack-deploy.mjs',
};

/** Fail before any subprocess if the check can deploy or pnpm can override React 18. */
export function assertThreadStackSafety(root = repoRoot, outputs = ['/tmp/tk-build', '/tmp/tk-build.staging']) {
  for (const output of outputs) {
    if (fs.existsSync(output) && fs.lstatSync(output).isSymbolicLink()) throw new Error('check:extension must build to /tmp/tk-build only (no output symlinks)');
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (manifest.scripts?.['check:extension'] !== scripts['check:extension']) {
    throw new Error('check:extension must build to /tmp/tk-build only');
  }
  if (manifest.scripts?.['check:all'] !== scripts['check:all']) throw new Error('check:all must use the guarded ThreadStack check');
  const workspace = fs.readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8');
  const section = /^packages:\s*\n([\s\S]*?)(?=^\S|$(?![\s\S]))/m.exec(workspace)?.[1] ?? '';
  const patterns = [...section.matchAll(/^\s+-\s+(.+?)\s*(?:#.*)?$/gm)].map(m => m[1].replace(/^["']|["']$/g, ''));
  const belongs = name => patterns.filter(p => !p.startsWith('!')).some(p => path.matchesGlob(name, p))
    && !patterns.filter(p => p.startsWith('!')).some(p => path.matchesGlob(name, p.slice(1)));
  const lockfile = fs.readFileSync(path.join(root, 'pnpm-lock.yaml'), 'utf8');
  if (['extension', 'extension/worker'].some(belongs) || /^  ['"]?extension(?:\/[^\s:'"]+)?['"]?:\s*$/m.test(lockfile)) {
    throw new Error('extension must not be a pnpm workspace member (React 18)');
  }
  const reactFile = path.join(root, 'extension/node_modules/react/package.json');
  if (fs.existsSync(reactFile) && !JSON.parse(fs.readFileSync(reactFile, 'utf8')).version?.startsWith('18.')) {
    throw new Error('extension must keep React 18 in its separate npm installation');
  }
}

/**
 * After the build: `/tmp/tk-build/manifest.json` must exist, have been written by this run (a stale
 * folder from an earlier run is not evidence) and carry no `key`, so a check build can never claim
 * the fixed extension ID of a browser's loaded copy.
 */
export function assertBuiltManifest(dir = '/tmp/tk-build', since = 0) {
  const file = path.join(dir, 'manifest.json');
  let stat, manifest;
  try { stat = fs.statSync(file); manifest = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { throw new Error(`${file} was not built`); }
  if (stat.mtimeMs < since) throw new Error(`${file} is stale: the build did not replace it`);
  if (manifest && typeof manifest === 'object' && Object.hasOwn(manifest, 'key')) throw new Error(`${file} must not contain a key`);
}

export function safeBuildEnv(env = process.env) {
  const result = { ...env, TK_OUT_DIR: '/tmp/tk-build', TK_STABLE_ID: '0' };
  delete result.TK_LIVE_DIR;
  return result;
}

export function checkCommands(mode) {
  if (!['all', 'extension'].includes(mode)) throw new Error('Use threadstack-check.mjs all or extension');
  // `pnpm run check:all` must keep the caller's pinned pnpm, even if PATH contains another major.
  const pnpmScript = process.env.npm_execpath && /pnpm[^/\\]*\.(?:c?js|mjs)$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null;
  const pnpm = args => pnpmScript ? { command: process.execPath, args: [pnpmScript, ...args], directory: '.' }
    : { command: process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', args, directory: '.' };
  return [
    ...(mode === 'all' ? [pnpm(['typecheck']), pnpm(['test:run'])] : []),
    // The guard tests (`pnpm run test:threadstack`) run in both modes, as plain argv.
    { command: process.execPath, args: ['--test', 'scripts/threadstack.test.mjs', 'scripts/threadstack-contracts.test.mjs'], directory: '.' },
    { command: process.execPath, args: ['node_modules/typescript/bin/tsc', '--noEmit'], directory: 'extension' },
    { command: process.execPath, args: ['node_modules/vitest/vitest.mjs', 'run'], directory: 'extension' },
    { command: process.execPath, args: ['scripts/build-extension.mjs'], directory: 'extension' },
  ];
}

function main() {
  assertThreadStackSafety();
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major < 24 || (major === 24 && minor < 11)) throw new Error('The fork requires Node 24.11 or newer');
  const startedAt = Date.now();
  for (const command of checkCommands(process.argv[2])) {
    const result = spawnSync(command.command, command.args, {
      cwd: path.join(repoRoot, command.directory), env: safeBuildEnv(), stdio: 'inherit', shell: false,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) { process.exitCode = result.status || 1; return; }
  }
  assertBuiltManifest('/tmp/tk-build', startedAt - 1_000);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}
