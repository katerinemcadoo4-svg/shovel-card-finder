import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { dirname, extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'dist');
const prefix = process.env.SITE_PREFIX || '/shovel-card-finder/';
const port = Number(process.env.PORT || 8765);
if (!prefix.startsWith('/') || !prefix.endsWith('/')) throw new Error('SITE_PREFIX must start and end with /');

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.wasm': 'application/wasm',
};

const server = createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    if (!pathname.startsWith(prefix)) { response.writeHead(404).end('Not found'); return; }
    const relative = pathname.slice(prefix.length) || 'index.html';
    const absolute = resolve(root, relative);
    if (absolute !== root && !absolute.startsWith(root + sep)) { response.writeHead(403).end('Forbidden'); return; }
    const info = await stat(absolute);
    if (!info.isFile()) { response.writeHead(404).end('Not found'); return; }
    const bytes = await readFile(absolute);
    response.writeHead(200, {
      'Content-Type': mime[extname(absolute)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Content-Length': bytes.length,
    }).end(bytes);
  } catch {
    response.writeHead(404).end('Not found');
  }
});
server.listen(port, '127.0.0.1', () => {
  console.log(`Preview: http://127.0.0.1:${port}${prefix}`);
});
