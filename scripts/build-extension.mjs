import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, '.output', 'chrome-mv3');
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

function createPngBuffer(size) {
  const width = size;
  const height = size;
  const rawData = Buffer.alloc(height * (1 + width * 4));

  for (let y = 0; y < height; y++) {
    const rowStart = y * (1 + width * 4);
    rawData[rowStart] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const px = rowStart + 1 + x * 4;
      const border = Math.max(1, Math.floor(size * 0.12));
      const isOuter = x < border || x >= width - border || y < border || y >= height - border;
      const isSpine = x >= Math.floor(size * 0.28) && x < Math.floor(size * 0.38) && y >= border * 2 && y < height - border * 2;
      if (isOuter) {
        // Warm paper border #F6F4EF
        rawData[px] = 0xf6;
        rawData[px + 1] = 0xf4;
        rawData[px + 2] = 0xef;
        rawData[px + 3] = 0xff;
      } else if (isSpine) {
        // Warm amber spine #9A5B13
        rawData[px] = 0x9a;
        rawData[px + 1] = 0x5b;
        rawData[px + 2] = 0x13;
        rawData[px + 3] = 0xff;
      } else {
        // Warm ink background #161513
        rawData[px] = 0x16;
        rawData[px + 1] = 0x15;
        rawData[px + 2] = 0x13;
        rawData[px + 3] = 0xff;
      }
    }
  }

  function crc32(buf) {
    let crc = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
      crc ^= buf[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
    return Buffer.concat([len, typeBuf, data, crcBuf]);
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(rawData);
  const iend = Buffer.alloc(0);

  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', iend),
  ]);
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
  return {
    capture,
    grokX,
    domCapture: capture.filter((pattern) => !grokX.includes(pattern)),
    // web_accessible_resources only accepts origin patterns (scheme://host/*).
    webAccessible: registry.toOriginMatchPatterns(capture),
  };
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

  // 4. Copy styles.css
  fs.copyFileSync(
    path.join(rootDir, 'src/entrypoints/manager/styles.css'),
    path.join(outDir, 'assets/manager.css'),
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
  fs.writeFileSync(path.join(outDir, 'manager.html'), pageHtml('page', 'Threadkeeper — AI thread library'), 'utf8');
  fs.writeFileSync(path.join(outDir, 'sidepanel.html'), pageHtml('sidepanel', 'Threadkeeper'), 'utf8');

  // 6. Write manifest.json
  const patterns = await loadManifestMatchPatterns();
  const capturePatterns = patterns.capture;
  const manifest = {
    manifest_version: 3,
    name: 'Threadkeeper',
    version: buildInfo.version,
    version_name: buildInfo.versionName,
    description:
      'Automatically captures, understands and organizes your AI threads across ChatGPT, Claude, Claude Code, Codex, Grok, Gemini and more.',
    permissions: ['storage', 'unlimitedStorage', 'alarms', 'scripting', 'sidePanel'],
    host_permissions: [
      ...capturePatterns,
      'https://api.anthropic.com/*',
      'https://api.voyageai.com/*',
      'https://api.openai.com/*',
    ],
    // AWS hosts are granted per region at runtime (Settings → AI / Embeddings), never at install.
    optional_host_permissions: ['https://*.api.aws/*', 'https://*.amazonaws.com/*'],
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    side_panel: {
      default_path: 'sidepanel.html',
    },
    action: {
      default_title: 'Threadkeeper',
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
        description: 'Toggle Threadkeeper overlay on the active AI tab',
      },
      'open-side-panel': {
        suggested_key: {
          default: 'Alt+Shift+L',
          mac: 'Alt+Shift+L',
        },
        description: 'Open Threadkeeper in the side panel',
      },
      'open-manager': {
        suggested_key: {
          default: 'Alt+Shift+M',
          mac: 'Alt+Shift+M',
        },
        description: 'Open Threadkeeper full-page library',
      },
    },
    content_scripts: [
      {
        matches: patterns.domCapture,
        js: ['content-scripts/content.js'],
        run_at: 'document_idle',
      },
      {
        matches: patterns.grokX,
        js: ['content-scripts/content.js'],
        run_at: 'document_start',
      },
      {
        matches: patterns.grokX,
        js: ['content-scripts/grok-x-main.js'],
        run_at: 'document_start',
        world: 'MAIN',
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

  // 7. Generate icons
  for (const size of [16, 32, 48, 128]) {
    fs.writeFileSync(path.join(outDir, 'icons', `icon-${size}.png`), createPngBuffer(size));
  }

  console.log(`Built Threadkeeper ${buildInfo.versionName} to ${outDir}`);
  console.log(
    [
      '',
      'Next: reload the extension so the browser picks up the new manifest.',
      '  Edge:   edge://extensions   → Threadkeeper → Reload',
      '  Chrome: chrome://extensions → Threadkeeper → Reload',
      `The extensions page should then show version ${buildInfo.versionName}.`,
      'If you forget, the extension reloads itself within a few minutes, and an open library page offers a one-click Reload.',
    ].join('\n')
  );
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
