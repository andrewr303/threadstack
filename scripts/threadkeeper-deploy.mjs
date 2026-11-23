import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Real path of `p`, also when its tail does not exist yet: the deepest existing ancestor is resolved. */
function realResolve(p) {
  let current = path.resolve(p);
  const rest = [];
  for (let hops = 0; !fs.existsSync(current) && path.dirname(current) !== current; hops++) {
    // A dangling symlink still names its target: follow it rather than treating it as a new folder.
    let link = null;
    try { if (fs.lstatSync(current).isSymbolicLink()) link = fs.readlinkSync(current); } catch { /* not there */ }
    if (link !== null && hops < 40) { current = path.resolve(path.dirname(current), link); continue; }
    rest.unshift(path.basename(current)); current = path.dirname(current);
  }
  let real = current;
  try { real = fs.realpathSync(current); } catch { /* keep the lexical path */ }
  return path.join(real, ...rest);
}
const within = (inner, outer) => inner === outer || inner.startsWith(outer.endsWith(path.sep) ? outer : outer + path.sep);

function isLegacyLiveBuild(target, fork) {
  const relative = path.join('.output', 'chrome-mv3');
  if (target !== path.join(fork, relative) || realResolve(target) !== path.join(realResolve(fork), relative)) return false;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(target, 'manifest.json'), 'utf8'));
    return manifest.name === 'Threadkeeper' && manifest.manifest_version === 3 && !Object.hasOwn(manifest, 'key')
      && !fs.lstatSync(target + '.staging', { throwIfNoEntry: false })
      && !fs.readdirSync(target, { recursive: true, withFileTypes: true }).some(entry => entry.isSymbolicLink());
  } catch { return false; }
}

export function deploymentEnv(env = process.env, { home = os.homedir(), fork = path.resolve(here, '..') } = {}) {
  if (!env.TK_LIVE_DIR?.trim()) throw new Error('Set TK_LIVE_DIR to the folder your browser loads Threadkeeper from.');
  const refusal = new Error('TK_LIVE_DIR must name an absolute dedicated build folder.');
  const target = path.resolve(env.TK_LIVE_DIR);
  if (!path.isAbsolute(env.TK_LIVE_DIR) || path.dirname(target) === target || target === path.resolve('.')) throw refusal;
  // Symlinks are resolved first, so an alias cannot name the fork, the home folder or the check output.
  const real = realResolve(target);
  // The existing legacy unpacked build is the only in-checkout destination.
  const build = [realResolve('/tmp/tk-build'), realResolve('/tmp/tk-build.staging')];
  if (path.dirname(real) === real || within(realResolve(home), real) || build.some(b => within(real, b))) throw refusal;
  if (within(real, realResolve(fork)) && !isLegacyLiveBuild(target, fork)) throw refusal;
  if (within(target, fork) && !within(real, realResolve(fork))) throw refusal;
  return { ...env, TK_OUT_DIR: target, TK_STABLE_ID: '0' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const env = deploymentEnv();
    const extension = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../extension');
    const result = spawnSync(process.execPath, ['scripts/build-extension.mjs'], { cwd: extension, env, stdio: 'inherit', shell: false });
    if (result.error) throw result.error;
    process.exitCode = result.status || (result.signal ? 1 : 0);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
