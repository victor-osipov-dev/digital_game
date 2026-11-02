// Локальный отладочный сервер: отдаёт собранную игру из ./dist и подменяет
// относительный /sdk.js на мок Яндекс Игр SDK. Нужен, чтобы проверить всю
// интеграцию площадки (fullscreen, оценка, ярлык, буфер обмена, баннер,
// реклама) без sdk-dev-proxy и без настоящей площадки.
//
// Это НЕ настоящий SDK: реклама рисуется собственным оверлеем, показов нет.
// Запуск: node tools/mock-sdk-server.mjs   (порт по умолчанию 4177, PORT=…)

import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist');
const PORT = Number(process.env.PORT || 4177);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.glb': 'model/gltf-binary',
  '.hdr': 'application/octet-stream',
  '.env': 'application/octet-stream',
  '.ktx2': 'application/octet-stream',
  '.dds': 'application/octet-stream',
  '.basis': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

const MOCK_SDK = `window.__advCalls = [];
window.__handlers = {};
(function () {
  function overlay(label, ms, done) {
    var root = document.createElement('div');
    root.id = 'mock-ad';
    root.setAttribute('role', 'dialog');
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.92);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;font-family:Arial,sans-serif;';
    var badge = document.createElement('div');
    badge.textContent = 'MOCK YANDEX SDK · НЕ НАСТОЯЩАЯ РЕКЛАМА';
    badge.style.cssText = 'color:#FFC107;font-size:12px;letter-spacing:2px;';
    var title = document.createElement('div');
    title.textContent = label + ' (mock)';
    title.style.cssText = 'color:#fff;font-size:30px;font-weight:bold;';
    var counter = document.createElement('div');
    counter.style.cssText = 'color:#9A9BA8;font-size:15px;';
    root.appendChild(badge); root.appendChild(title); root.appendChild(counter);
    document.body.appendChild(root);
    var start = Date.now();
    var t = setInterval(function () {
      var left = Math.max(0, Math.ceil((ms - (Date.now() - start)) / 1000));
      counter.textContent = String(left);
      if (Date.now() - start >= ms) { clearInterval(t); root.remove(); done(); }
    }, 200);
  }
  window.YaGames = { init: async function () {
    var fs = {
      STATUS_ON: 'on', STATUS_OFF: 'off', status: 'off',
      request: async function () { fs.status = 'on'; window.__advCalls.push('fs-on'); },
      exit: async function () { fs.status = 'off'; window.__advCalls.push('fs-off'); },
    };
    return {
      features: {
        LoadingAPI: { ready: function () { window.__advCalls.push('ready'); } },
        GameplayAPI: {
          start: function () { window.__advCalls.push('gstart'); },
          stop: function () { window.__advCalls.push('gstop'); },
        },
      },
      environment: { i18n: { lang: 'ru' } },
      deviceInfo: { type: 'desktop' },
      screen: { fullscreen: fs },
      feedback: {
        canReview: async function () { return { value: true }; },
        requestReview: async function () { window.__advCalls.push('review'); return { feedbackSent: true }; },
      },
      shortcut: {
        canShowPrompt: async function () { return { canShow: true }; },
        showPrompt: async function () { window.__advCalls.push('shortcut'); return { outcome: 'accepted' }; },
      },
      clipboard: { writeText: function (x) { window.__advCalls.push('copy:' + x); } },
      adv: {
        showFullscreenAdv: function (c) {
          var cb = (c && c.callbacks) || c || {};
          window.__advCalls.push('inter');
          overlay('Реклама', 1800, function () { cb.onClose && cb.onClose(true); });
        },
        showRewardedVideo: function (c) {
          var cb = (c && c.callbacks) || c || {};
          window.__advCalls.push('rewarded');
          overlay('Видеореклама', 2600, function () { cb.onRewarded && cb.onRewarded(); cb.onClose && cb.onClose(true); });
        },
        showBannerAdv: async function () { window.__advCalls.push('banner-show'); return { stickyAdvIsShowing: true }; },
        hideBannerAdv: async function () { window.__advCalls.push('banner-hide'); return { stickyAdvIsShowing: false }; },
      },
      on: function (e, fn) { window.__handlers[e] = fn; },
    };
  } };
})();`;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path === '/sdk.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(MOCK_SDK);
      return;
    }
    if (path === '/') path = '/index.html';
    const filePath = normalize(join(ROOT, path));
    if (!filePath.startsWith(ROOT)) {
      res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('forbidden');
      return;
    }
    const body = await readFile(filePath);
    res.writeHead(200, {
      'Content-Type': MIME[extname(filePath).toLowerCase()] ?? 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
});

server.listen(PORT, () => {
  console.log(`mock-sdk server: http://localhost:${PORT}/  (dist: ${ROOT})`);
});
