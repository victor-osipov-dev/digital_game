// Локальный статический сервер для dist-папки (правильные MIME для .js/.mjs).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2] ?? 'dist-playgama';
const port = Number(process.argv[3] ?? 8899);
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.mp3': 'audio/mpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
};

http.createServer((req, res) => {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  let file = path.join(root, url === '/' ? 'index.html' : url);
  try {
    const stat = fs.statSync(file);
    if (stat.isDirectory()) file = path.join(file, 'index.html');
  } catch {
    res.writeHead(404).end('not found');
    return;
  }
  const data = fs.readFileSync(file);
  res.writeHead(200, {
    'Content-Type': mime[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Cache-Control': 'no-store',
  });
  res.end(data);
}).listen(port, '127.0.0.1', () => console.log(`serving ${root} on http://127.0.0.1:${port}`));
