// Throwaway loopback servers for the REQ-6 spike. Never starts Paperclip or loads the real extension.
// Port A (127.0.0.1): frame + nested pages. Port B (localhost): the same files, used as a second site
// (localhost and 127.0.0.1 are different sites, so frames across them are process-isolated).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const roots = [path.join(dir, 'pages'), path.join(dir, 'ext')];
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json' };

function handler(request, response) {
  const name = path.basename(new URL(request.url, 'http://x').pathname);
  for (const root of roots) {
    const file = path.join(root, name);
    if (name && fs.existsSync(file) && fs.statSync(file).isFile()) {
      response.setHeader('Content-Type', types[path.extname(file)] ?? 'application/octet-stream');
      response.setHeader('Cache-Control', 'no-store');
      response.end(fs.readFileSync(file));
      return;
    }
  }
  response.statusCode = 404; response.end('not found');
}

const listen = (host, port = 0) => new Promise((resolve, reject) => {
  const server = http.createServer(handler);
  server.once('error', reject);
  server.listen(port, host, () => resolve(server));
});

export async function startServers() {
  const a = await listen('127.0.0.1');
  const b = await listen('127.0.0.1');
  // Chrome resolves `localhost` to loopback; also bind ::1 on the same port when available.
  let b6 = null;
  try { b6 = await listen('::1', b.address().port); } catch { /* IPv6 loopback is optional. */ }
  return {
    ipOrigin: `http://127.0.0.1:${a.address().port}`,
    nameOrigin: `http://localhost:${b.address().port}`,
    close: () => { a.close(); b.close(); b6?.close(); },
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const servers = await startServers();
  console.log(JSON.stringify({ ipOrigin: servers.ipOrigin, nameOrigin: servers.nameOrigin }));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { servers.close(); process.exit(0); });
}
