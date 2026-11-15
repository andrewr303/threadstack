// Throwaway two-origin fixture. This never starts Paperclip or loads the real extension.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = path.dirname(fileURLToPath(import.meta.url));
let hostOrigin;
let frameOrigin;
const start = (file) => new Promise((resolve) => {
  const server = http.createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');
    const html = fs.readFileSync(path.join(dir, file), 'utf8').replaceAll('{{hostOrigin}}', hostOrigin).replaceAll('{{frameOrigin}}', frameOrigin);
    response.end(html);
  });
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const host = await start('host.html');
hostOrigin = `http://127.0.0.1:${host.address().port}`;
const frame = await start('frame.html');
frameOrigin = `http://127.0.0.1:${frame.address().port}`;
console.log(JSON.stringify({ host: hostOrigin, frame: frameOrigin }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { host.close(); frame.close(); });
