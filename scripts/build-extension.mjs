import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, '.output', 'chrome-mv3');

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

async function build() {
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
      'process.env.NODE_ENV': '"production"',
    },
  });

  // 4. Copy styles.css
  fs.copyFileSync(
    path.join(rootDir, 'src/entrypoints/manager/styles.css'),
    path.join(outDir, 'assets/manager.css'),
  );

  // 5. Write manager.html
  const managerHtml = `<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Threadkeeper — Conversation Archive & Workbench</title>
  <link rel="stylesheet" href="./assets/manager.css" />
</head>
<body>
  <div id="root"></div>
  <script type="module" src="./assets/manager.js"></script>
</body>
</html>
`;
  fs.writeFileSync(path.join(outDir, 'manager.html'), managerHtml, 'utf8');

  // 6. Write manifest.json
  const manifest = {
    manifest_version: 3,
    name: 'Threadkeeper',
    version: '0.1.0',
    description:
      'Quiet, context-rich cross-provider AI conversation library with zero closed-state DOM footprint.',
    permissions: ['storage', 'unlimitedStorage', 'alarms', 'scripting'],
    host_permissions: [
      'https://chatgpt.com/*',
      'https://chat.openai.com/*',
      'https://claude.ai/*',
    ],
    background: {
      service_worker: 'background.js',
      type: 'module',
    },
    action: {
      default_title: 'Open Threadkeeper (Alt+Shift+K)',
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
        description: 'Toggle Threadkeeper overlay on active AI tab',
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
        matches: [
          'https://chatgpt.com/*',
          'https://chat.openai.com/*',
          'https://claude.ai/*',
        ],
        js: ['content-scripts/content.js'],
        run_at: 'document_idle',
      },
    ],
    web_accessible_resources: [
      {
        resources: ['manager.html', 'assets/*'],
        matches: [
          'https://chatgpt.com/*',
          'https://chat.openai.com/*',
          'https://claude.ai/*',
        ],
        use_dynamic_url: true,
      },
    ],
    content_security_policy: {
      extension_pages: "script-src 'self'; object-src 'self';",
    },
  };
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // 7. Generate icons
  for (const size of [16, 32, 48, 128]) {
    fs.writeFileSync(path.join(outDir, 'icons', `icon-${size}.png`), createPngBuffer(size));
  }

  console.log(`Built Threadkeeper MV3 extension to ${outDir}`);
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
