// CDP-проба: открыть страницу, собрать console-логи и состояние window.bridge.
// Использование: node tools/cdp-probe.mjs http://127.0.0.1:8899 [мсекунд]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const url = process.argv[2] ?? 'http://127.0.0.1:8899';
const waitMs = Number(process.argv[3] ?? 12000);

const edgePaths = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const edge = edgePaths.find((p) => fs.existsSync(p));
if (!edge) {
  console.error('msedge.exe not found');
  process.exit(1);
}

const userDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edge-cdp-'));
const chrome = spawn(edge, [
  '--headless=new',
  '--disable-gpu-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  `--remote-debugging-port=9223`,
  `--user-data-dir=${userDir}`,
  '--window-size=1280,800',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getTargetWsUrl() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch('http://127.0.0.1:9223/json');
      const targets = await res.json();
      const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* not ready yet */ }
    await sleep(300);
  }
  throw new Error('no CDP target');
}

const wsUrl = await getTargetWsUrl();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });

let msgId = 0;
const pending = new Map();
const logs = [];
function send(method, params, sessionId) {
  const id = ++msgId;
  return new Promise((resolve) => {
    pending.set(id, resolve);
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
}
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.consoleAPICalled') {
    const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
    logs.push(`[console.${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[exception] ${d.text} ${d.exception?.description ?? ''}`);
  } else if (msg.method === 'Log.entryAdded') {
    logs.push(`[log.${msg.params.entry.level}] ${msg.params.entry.text}`);
  }
};

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');
await send('Page.navigate', { url });
await sleep(waitMs);

const evalRes = await send('Runtime.evaluate', {
  expression: `JSON.stringify({
    hasBridge: typeof window.bridge !== 'undefined',
    isInitialized: typeof window.bridge !== 'undefined' ? window.bridge.isInitialized : null,
    platformId: typeof window.bridge !== 'undefined' && window.bridge.platform ? window.bridge.platform.id : null,
    audioEnabled: typeof window.bridge !== 'undefined' && window.bridge.platform ? window.bridge.platform.isAudioEnabled : null,
    title: document.title,
    loaderRemoved: !document.getElementById('boot-loader'),
    configStatus: typeof window.playgamaBridgeConfig !== 'undefined' ? 'global' : 'none',
  })`,
  returnByValue: true,
});
console.log('STATE:', evalRes.result?.result?.value ?? JSON.stringify(evalRes));
console.log('--- LOGS ---');
for (const l of logs) console.log(l);

ws.close();
chrome.kill();
