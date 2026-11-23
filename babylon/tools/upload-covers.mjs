// Загружает три обложки Playgama: start_cover_upload -> PUT -> confirm_cover_upload.
// Обложки берутся из babylon/artwork: cover-square.png, cover-portrait.png, cover-landscape.png.
import fs from 'node:fs';
import path from 'node:path';

const TOKEN = JSON.parse(fs.readFileSync('C:/Users/victor/AppData/Local/Temp/opencode/playgama-mcp/token.json', 'utf8')).access_token;
const APP = 'cmwcgwq760rrnk30ix468w9rd';
const ROOT = 'C:/Users/victor/Desktop/Projects/games/digital_game/babylon/artwork';
let nextId = 1;

async function mcp(name, args) {
  const res = await fetch('https://developer.playgama.com/api/mcp', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/call', params: { name, arguments: args } }),
  });
  const text = await res.text();
  const lines = text.split(/\r?\n/).filter((l) => l.startsWith('data:'));
  const parsed = lines.length
    ? lines.map((l) => JSON.parse(l.slice(5).trim()))
    : [JSON.parse(text)];
  const r = parsed.find((x) => x.result || x.error);
  if (!r || r.error || (r.result && r.result.isError)) {
    throw new Error(name + ' failed: ' + text.slice(0, 500));
  }
  return JSON.parse(r.result.content[0].text);
}

const covers = [
  { slot: 'square', file: path.join(ROOT, 'cover-square.png') },
  { slot: 'portrait', file: path.join(ROOT, 'cover-portrait.png') },
  { slot: 'landscape', file: path.join(ROOT, 'cover-landscape.png') },
];

for (const { slot, file } of covers) {
  const body = fs.readFileSync(file);
  const start = await mcp('start_cover_upload', {
    applicationId: APP,
    cover: slot,
    format: 'png',
    contentSize: body.length,
  });
  console.log(`[${slot}] mediaId=${start.mediaId ?? JSON.stringify(start).slice(0, 200)}`);
  const put = await fetch(start.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': start.headers?.['Content-Type'] ?? 'image/png', 'Content-Length': String(body.length) },
    body,
  });
  console.log(`[${slot}] PUT status ${put.status}`);
  if (put.status !== 200) {
    console.log(await put.text());
    process.exit(1);
  }
  const conf = await mcp('confirm_cover_upload', { applicationId: APP, mediaId: start.mediaId });
  console.log(`[${slot}] confirmed: ${JSON.stringify(conf)}`);
}
console.log('ALL COVERS DONE');
