import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
// TK_OUT_DIR builds somewhere else, so a test build never replaces the folder a browser has loaded
// (a loaded ThreadStack reloads itself when the build in its folder changes).
const finalDir = process.env.TK_OUT_DIR ? path.resolve(process.env.TK_OUT_DIR) : path.join(rootDir, '.output', 'chrome-mv3');
// Everything is built here first and then moved into finalDir file by file (publish()), so the
// folder a browser has loaded is never empty or missing its manifest, not even for a moment.
const outDir = `${finalDir}.staging`;
const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));

/**
 * Every build gets a unique id. It is compiled into the bundles and written to
 * the manifest as version_name, so the running extension can tell when the
 * browser still holds a previous build's manifest (unpacked extensions only
 * re-read manifest.json on Reload).
 */
function createBuildInfo() {
  const builtAt = new Date();
  let sha = 'nogit';
  try {
    sha = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: rootDir, encoding: 'utf8' }).trim() || sha;
  } catch {
    // building outside a git checkout
  }
  const stamp = builtAt.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '.');
  const buildId = `${stamp}-${sha}`;
  return { version: pkg.version, versionName: `${pkg.version} (build ${buildId})`, buildId, builtAt: builtAt.toISOString() };
}

/**
 * Replace finalDir's contents with the staged build. Each file is put in place with a rename
 * (atomic), files the new build no longer has are removed afterwards, and manifest.json goes
 * last, so a browser that starts or reloads in the middle always finds a loadable extension.
 */
function publish(stagedDir, targetDir) {
  const list = (dir, base = '') =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const rel = path.join(base, entry.name);
      return entry.isDirectory() ? list(path.join(dir, entry.name), rel) : [rel];
    });
  // Only ever replace a folder that is empty or already holds a ThreadStack build: everything in
  // the target that is not part of the new build is deleted below.
  if (fs.existsSync(targetDir) && fs.readdirSync(targetDir).length > 0) {
    let name = null;
    try {
      name = JSON.parse(fs.readFileSync(path.join(targetDir, 'manifest.json'), 'utf8')).name;
    } catch {
      // no manifest: not a build folder
    }
    // Builds made before the rename are named Threadkeeper; they are the same extension.
    if (name !== 'ThreadStack' && name !== 'Threadkeeper') {
      fs.rmSync(stagedDir, { recursive: true, force: true });
      throw new Error(`${targetDir} is not empty and is not a ThreadStack build. Choose an empty folder.`);
    }
  }
  const staged = list(stagedDir);
  // manifest.json and then build-info.json go last: the running extension compares build-info.json
  // with its manifest and reloads once per build, so it must not see the new build-info early.
  const last = ['manifest.json', 'build-info.json'];
  const ordered = [...staged.filter((f) => !last.includes(f)), ...last.filter((f) => staged.includes(f))];
  for (const rel of ordered) {
    const to = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    const temp = `${to}.tk-new`;
    fs.copyFileSync(path.join(stagedDir, rel), temp);
    fs.renameSync(temp, to);
  }
  const keep = new Set(staged);
  for (const rel of list(targetDir)) {
    if (!keep.has(rel)) fs.rmSync(path.join(targetDir, rel), { force: true });
  }
  fs.rmSync(stagedDir, { recursive: true, force: true });
}

/** The ID a browser gives an unpacked extension that has no manifest key: a hash of its folder. */
function pathExtensionId(dir) {
  // The browser hashes the real path (symlinks resolved).
  try {
    dir = fs.realpathSync(dir);
  } catch {
    // not built yet: the path as given
  }
  const hex = crypto.createHash('sha256').update(dir).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
}

/**
 * Whether this build carries the fixed manifest key (shared/extension-key.json).
 *
 * With the key, ThreadStack has the same extension ID wherever its folder is, so loading it
 * from another checkout or moving the folder keeps the library. Without it the ID is a hash of
 * the folder path. A browser keeps an extension's data under its ID, and changing the ID starts
 * an empty library, so a folder that a browser on this computer already has loaded under its
 * path ID keeps building without the key until the person moves on purpose (docs/mac-helper.md,
 * "The extension ID").
 * TK_STABLE_ID=1 forces the key, TK_STABLE_ID=0 forces the path ID. A build to another folder
 * (TK_OUT_DIR) has no key unless forced, so a test build can never open the real library.
 */
function decideManifestKey(targetDir) {
  const fixed = JSON.parse(fs.readFileSync(path.join(rootDir, 'shared', 'extension-key.json'), 'utf8'));
  if (process.env.TK_STABLE_ID === '1') return { key: fixed.key, id: fixed.extensionId, legacyId: null };
  if (process.env.TK_STABLE_ID === '0' || process.env.TK_OUT_DIR) return { key: null, id: pathExtensionId(targetDir), legacyId: null };
  let realTarget = targetDir;
  try {
    realTarget = fs.realpathSync(targetDir);
  } catch {
    // not built yet
  }
  // Any ID other than the fixed one under which a browser has this folder loaded. The ID is taken
  // from the browser's own record, not recomputed, so it is right on every platform.
  let loadedUnder = null;
  const bases = [];
  if (process.platform === 'darwin') bases.push(path.join(os.homedir(), 'Library', 'Application Support'));
  else if (process.platform === 'win32') bases.push(process.env.LOCALAPPDATA ?? '');
  else bases.push(path.join(os.homedir(), '.config'));
  const browsers = [
    'Google/Chrome', 'Google/Chrome Beta', 'Google/Chrome Dev', 'Google/Chrome Canary', 'Google/Chrome for Testing',
    'Chromium', 'Microsoft Edge', 'Microsoft Edge Beta', 'Microsoft Edge Dev', 'Microsoft Edge Canary',
    'BraveSoftware/Brave-Browser', 'Arc/User Data', 'Vivaldi', 'com.operasoftware.Opera',
    'google-chrome', 'chromium', 'microsoft-edge', 'Google/Chrome/User Data', 'Microsoft/Edge/User Data',
    'BraveSoftware/Brave-Browser/User Data',
  ];
  for (const base of bases.filter(Boolean)) {
    for (const browser of browsers) {
      let profiles = [];
      try {
        profiles = fs.readdirSync(path.join(base, browser), { withFileTypes: true }).filter((d) => d.isDirectory() && (d.name === 'Default' || /^Profile \d+$/.test(d.name)));
      } catch {
        continue;
      }
      for (const profile of profiles) {
        for (const file of ['Secure Preferences', 'Preferences']) {
          let settings;
          try {
            settings = JSON.parse(fs.readFileSync(path.join(base, browser, profile.name, file), 'utf8'))?.extensions?.settings;
          } catch {
            continue;
          }
          // Only the list of extensions and the folder each loads from is looked at.
          for (const [id, entry] of Object.entries(settings ?? {})) {
            if (!entry || typeof entry.path !== 'string' || ![targetDir, realTarget].includes(path.resolve(entry.path))) continue;
            if (id !== fixed.extensionId) loadedUnder = id;
          }
        }
      }
    }
  }
  // One profile still on a path ID is enough: adding the key would empty that profile's library.
  if (loadedUnder) return { key: null, id: loadedUnder, legacyId: loadedUnder };
  return { key: fixed.key, id: fixed.extensionId, legacyId: null };
}

/**
 * Load the provider registry itself (compiled on the fly) so manifest host
 * permissions and content-script matches come from the same code the adapters use.
 */
async function loadManifestMatchPatterns() {
  const result = await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/core/providers.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  const registry = await import(`data:text/javascript;base64,${source}`);
  const capture = registry.captureMatchPatterns();
  if (!Array.isArray(capture) || capture.length === 0) {
    throw new Error('Provider registry returned no capture match patterns');
  }
  // Grok on X: X is a single-page app, so its scripts load on every X page at document_start
  // (the MAIN-world hook must be in place before X requests the conversation).
  const grokX = registry.PROVIDERS.grok_x.matchPatterns;
  if (!Array.isArray(grokX) || grokX.length === 0) {
    throw new Error('Provider registry returned no Grok on X match patterns');
  }
  // ChatGPT and Claude load each conversation as one JSON document; a MAIN-world script reads it.
  const siteData = [...registry.PROVIDERS.chatgpt.matchPatterns, ...registry.PROVIDERS.claude.matchPatterns];
  if (siteData.length === 0) {
    throw new Error('Provider registry returned no ChatGPT / Claude match patterns');
  }
  // Providers on hosts ThreadStack does not hold from install (asked for at runtime, then their
  // content script is registered with chrome.scripting.registerContentScripts).
  const optionalCapture = registry.optionalCaptureMatchPatterns();
  if (!Array.isArray(optionalCapture) || optionalCapture.some((p) => capture.includes(p))) {
    throw new Error('A provider pattern is both required and optional');
  }
  return {
    capture,
    optionalCapture,
    // Host permissions take origins (any path is ignored), so huggingface.co/chat* asks for huggingface.co.
    optionalCaptureOrigins: registry.toOriginMatchPatterns(optionalCapture),
    siteData,
    grokX,
    domCapture: capture.filter((pattern) => !grokX.includes(pattern)),
    // web_accessible_resources only accepts origin patterns (scheme://host/*).
    webAccessible: registry.toOriginMatchPatterns(capture),
  };
}

/**
 * Load the login realms (compiled on the fly, like the registry) so the sign-in hosts accounts
 * need beyond the providers' own patterns are optional host permissions.
 */
async function loadRealmHostPatterns() {
  const result = await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/core/workspace/realms.ts')],
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    write: false,
  });
  const source = Buffer.from(result.outputFiles[0].text).toString('base64');
  const realms = await import(`data:text/javascript;base64,${source}`);
  const named = realms.allNamedRealms();
  if (!Array.isArray(named) || named.length === 0) {
    throw new Error('Realm registry returned no realms');
  }
  return Array.from(new Set(named.flatMap((r) => r.extraHostPatterns)));
}

async function build() {
  const buildInfo = createBuildInfo();
  const define = { __TK_BUILD__: JSON.stringify(buildInfo) };
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'content-scripts'), { recursive: true });
  fs.mkdirSync(path.join(outDir, 'icons'), { recursive: true });

  // 1. Bundle background service worker (ESM)
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/entrypoints/background.ts')],
    outfile: path.join(outDir, 'background.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    define,
  });

  // 2. Bundle content script (IIFE for MV3 content_scripts)
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/entrypoints/content.ts')],
    outfile: path.join(outDir, 'content-scripts/content.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    define,
  });

  // 2b. Bundle the Grok on X MAIN-world script (IIFE, no extension APIs)
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/entrypoints/grok-x-main.ts')],
    outfile: path.join(outDir, 'content-scripts/grok-x-main.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    minify: true,
  });

  // 2c. Bundle the ChatGPT / Claude MAIN-world script (IIFE, no extension APIs)
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/entrypoints/site-data-main.ts')],
    outfile: path.join(outDir, 'content-scripts/site-data-main.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    minify: true,
  });

  // 2d. Bundle the workspace embedding scripts: the isolated-world bridge (extension APIs) and its
  // page-world half (no extension APIs). Both run in every frame from document_start.
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/entrypoints/embed-bridge.ts')],
    outfile: path.join(outDir, 'content-scripts/embed-bridge.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    define,
  });
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/entrypoints/embed-cookie-main.ts')],
    outfile: path.join(outDir, 'content-scripts/embed-cookie-main.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    minify: true,
  });

  // 3. Bundle manager UI (ESM)
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/entrypoints/manager/main.tsx')],
    outfile: path.join(outDir, 'assets/manager.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    define: {
      ...define,
      'process.env.NODE_ENV': '"production"',
    },
  });

  // 3b. Bundle the Sidebar Dock (Still) consent page (ESM). connect.html is NOT web-accessible:
  // it only ever opens as ThreadStack's own top-level popup.
  await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/entrypoints/connect/main.tsx')],
    outfile: path.join(outDir, 'assets/connect.js'),
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: ['chrome120'],
    sourcemap: false,
    minify: true,
    define: {
      ...define,
      'process.env.NODE_ENV': '"production"',
    },
  });

  // 4. Styles. The manager stylesheet is plain CSS in several files: styles.css (the library
  // components) followed by styles/*.css in name order (tokens and shared pieces first, then one
  // file per view). They are joined as they are; no file may @import another.
  const managerCssDir = path.join(rootDir, 'src/entrypoints/manager');
  const viewCssDir = path.join(managerCssDir, 'styles');
  const cssParts = [path.join(managerCssDir, 'styles.css')];
  if (fs.existsSync(viewCssDir)) {
    for (const name of fs.readdirSync(viewCssDir).filter((n) => n.endsWith('.css')).sort()) {
      cssParts.push(path.join(viewCssDir, name));
    }
  }
  fs.writeFileSync(
    path.join(outDir, 'assets/manager.css'),
    cssParts.map((file) => `/* ${path.relative(managerCssDir, file)} */\n${fs.readFileSync(file, 'utf8')}`).join('\n')
  );
  fs.copyFileSync(
    path.join(rootDir, 'src/entrypoints/connect/styles.css'),
    path.join(outDir, 'assets/connect.css'),
  );

  // 5. Write manager.html (full page + in-page overlay) and sidepanel.html (browser side panel)
  const pageHtml = (surface, title) => `<!DOCTYPE html>
<html lang="en" data-surface="${surface}">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <link rel="stylesheet" href="./assets/manager.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./assets/manager.js"></script>
</body>
</html>
`;
  fs.writeFileSync(path.join(outDir, 'manager.html'), pageHtml('page', 'ThreadStack — AI thread library'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'sidepanel.html'), pageHtml('sidepanel', 'ThreadStack'), 'utf8');
  fs.writeFileSync(
    path.join(outDir, 'connect.html'),
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ThreadStack — Connect Still?</title>
  <link rel="stylesheet" href="./assets/connect.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./assets/connect.js"></script>
</body>
</html>
`,
    'utf8',
  );

  // 6. Write manifest.json
  const patterns = await loadManifestMatchPatterns();
  const capturePatterns = patterns.capture;
  const realmHostPatterns = await loadRealmHostPatterns();
  const hostPermissions = [
    ...capturePatterns,
    'https://api.anthropic.com/*',
    'https://api.voyageai.com/*',
    'https://api.openai.com/*',
  ];
  if (realmHostPatterns.some((p) => hostPermissions.includes(p))) {
    throw new Error('A sign-in host must be optional, never an install-time host permission');
  }
  // Workspace embedding scripts load wherever the reader does, Grok on X included.
  const embedPatterns = Array.from(new Set([...patterns.domCapture, ...patterns.grokX]));
  const identity = decideManifestKey(finalDir);
  const manifest = {
    manifest_version: 3,
    name: 'ThreadStack',
    // The same extension ID wherever the folder is (see decideManifestKey).
    ...(identity.key ? { key: identity.key } : {}),
    version: buildInfo.version,
    version_name: buildInfo.versionName,
    description:
      'Automatically captures, understands and organizes your AI threads across ChatGPT, Claude, Claude Code, Codex, Grok, Gemini and more.',
    // activeTab: lets Settings → Capture read the address of the tab the user invoked ThreadStack
    // on ("Add this site"); it adds no install warning. cookies: the browser account's sign-in
    // and the embedded pages' cookie bridge. declarativeNetRequestWithHostAccess: the session
    // rules that let provider pages load inside the workspace tab and put an added account's
    // saved sign-in in place there. webRequest: seeing (never changing) the cookies the pages of
    // an added account are given inside the workspace tab, so its saved sign-in stays current.
    // None adds an install warning; all act only on hosts ThreadStack already has access to.
    permissions: [
      'storage',
      'unlimitedStorage',
      'alarms',
      'scripting',
      'sidePanel',
      'activeTab',
      'cookies',
      'declarativeNetRequestWithHostAccess',
      'webRequest',
    ],
    // The Mac helper (library backups kept on disk), asked for when set up.
    optional_permissions: ['nativeMessaging'],
    // Unchanged since v0.4: an update that grows this list disables the extension until approved.
    host_permissions: hostPermissions,
    // AWS hosts (per region), MongoDB Atlas model hosts (per geography) and Cohere are granted at
    // runtime from Settings → Search & embeddings, never at install. Settings → Capture asks for
    // one origin at a time: a provider the user turns on (patterns.optionalCaptureOrigins) or an AI site
    // the user adds, which can be any https origin or a local / private-network http one.
    optional_host_permissions: [
      'https://*.api.aws/*',
      'https://*.amazonaws.com/*',
      'https://ai.mongodb.com/*',
      'https://us.ai.mongodb.com/*',
      'https://eu.ai.mongodb.com/*',
      'https://api.cohere.com/*',
      ...patterns.optionalCaptureOrigins,
      // Sign-in hosts of login realms (accounts), asked for when an account is added.
      ...realmHostPatterns,
      'https://*/*',
      'http://*/*',
      // A Paperclip server on this computer (any port), granted from Settings → Paperclip.
      'http://localhost/*',
      'http://127.0.0.1/*',
    ],
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    action: {
      default_title: 'ThreadStack',
      default_icon: {
        16: 'icons/icon-16.png',
        32: 'icons/icon-32.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
    commands: {
      'toggle-overlay': {
        suggested_key: {
          default: 'Alt+Shift+K',
          mac: 'Alt+Shift+K',
        },
        description: 'Toggle ThreadStack overlay on the active AI tab',
      },
      'open-side-panel': {
        suggested_key: {
          default: 'Alt+Shift+L',
          mac: 'Alt+Shift+L',
        },
        description: 'Open ThreadStack in the side panel',
      },
      'open-manager': {
        suggested_key: {
          default: 'Alt+Shift+M',
          mac: 'Alt+Shift+M',
        },
        description: 'Open ThreadStack full-page library',
      },
    },
    // all_frames: the same pages also load inside ThreadStack's workspace tab. The scripts tell
    // an embedded frame (single ancestor: the extension) from a site's own iframes themselves.
    content_scripts: [
      {
        matches: patterns.domCapture,
        js: ['content-scripts/content.js'],
        run_at: 'document_idle',
        all_frames: true,
      },
      {
        matches: patterns.grokX,
        js: ['content-scripts/content.js'],
        run_at: 'document_start',
        all_frames: true,
      },
      {
        matches: patterns.grokX,
        js: ['content-scripts/grok-x-main.js'],
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: true,
      },
      {
        // Must be in place before the app requests the conversation.
        matches: patterns.siteData,
        js: ['content-scripts/site-data-main.js'],
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: true,
      },
      {
        matches: embedPatterns,
        js: ['content-scripts/embed-bridge.js'],
        run_at: 'document_start',
        all_frames: true,
      },
      {
        matches: embedPatterns,
        js: ['content-scripts/embed-cookie-main.js'],
        run_at: 'document_start',
        world: 'MAIN',
        all_frames: true,
      },
    ],
    // No use_dynamic_url: Edge (and older Chrome) resolve chrome.runtime.getURL() to the
    // static extension ID, and a static URL for a dynamic-URL resource is refused with
    // ERR_BLOCKED_BY_CLIENT ("<id> is blocked"). Framing is protected by the one-time
    // overlay handshake instead.
    web_accessible_resources: [
      {
        resources: ['manager.html', 'assets/*'],
        matches: patterns.webAccessible,
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  };
  if (manifest.web_accessible_resources.some((entry) => entry.use_dynamic_url)) {
    // Edge blocks static-ID URLs of dynamic-URL resources: "<id> is blocked · ERR_BLOCKED_BY_CLIENT".
    throw new Error('web_accessible_resources must not use use_dynamic_url (breaks Microsoft Edge)');
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  fs.writeFileSync(path.join(outDir, 'build-info.json'), JSON.stringify(buildInfo, null, 2), 'utf8');

  // 7. Brand: the ThreadStack mark as the extension's icons, and the rail's mark and wordmark next
  // to manager.html (assets/brand/). The PNGs are made from the brand artwork; see assets/brand/README.md.
  const brandDir = path.join(rootDir, 'assets', 'brand');
  for (const size of [16, 32, 48, 128]) {
    fs.copyFileSync(path.join(brandDir, `icon-${size}.png`), path.join(outDir, 'icons', `icon-${size}.png`));
  }
  fs.mkdirSync(path.join(outDir, 'assets', 'brand'), { recursive: true });
  for (const name of ['threadstack-wordmark.png', 'threadstack-mark.png']) {
    fs.copyFileSync(path.join(brandDir, name), path.join(outDir, 'assets', 'brand', name));
  }

  publish(outDir, finalDir);

  console.log(`Built ThreadStack ${buildInfo.versionName} to ${finalDir}`);
  console.log(`Extension ID: ${identity.id}${identity.key ? ' (fixed: the same wherever this folder is)' : ''}`);
  if (identity.legacyId) {
    console.log(
      [
        '',
        'A browser on this computer has this folder loaded under an ID that depends on the folder path,',
        'so this build keeps that ID and the library stays where it is. Do not move or rename the folder.',
        'To move to the fixed ID without risk, follow "The extension ID" in docs/mac-helper.md.',
      ].join('\n')
    );
  }
  console.log(
    [
      '',
      'Next: reload the extension so the browser picks up the new manifest.',
      '  Edge:   edge://extensions   → ThreadStack → Reload',
      '  Chrome: chrome://extensions → ThreadStack → Reload',
      `The extensions page should then show version ${buildInfo.versionName}.`,
      'If you forget, the extension reloads itself within a few minutes, and an open library page offers a one-click Reload.',
    ].join('\n')
  );
}

// `--print-id`: say which extension ID a build of this folder would have, and build nothing.
if (process.argv.includes('--print-id')) {
  const identity = decideManifestKey(finalDir);
  console.log(`${identity.id} ${identity.key ? 'fixed' : 'path'}`);
  process.exit(0);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
