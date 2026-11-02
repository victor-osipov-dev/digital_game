// HTTP-мост к официальному @yandex-games/sdk-dev-proxy.
//
// Зачем: sdk-dev-proxy всегда отдаёт HTTPS с зашитым самоподписанным
// сертификатом без SAN/CN. Браузеры такой сертификат не принимают, а
// ослаблять проверку TLS в браузере нельзя. localhost по HTTP — безопасный
// контекст, поэтому мост отдаёт игру и /sdk.js по http://localhost:8081,
// а запросы проксирует в официальный proxy на https://localhost:8080.
//
// Только для локальной разработки. Запуск:
//   node tools/yandex-dev-http-bridge.mjs
// Переменные: BRIDGE_PORT (8081), PROXY_PORT (8080).

import http from 'node:http';
import https from 'node:https';

const BRIDGE_PORT = Number(process.env.BRIDGE_PORT || 8081);
const PROXY_PORT = Number(process.env.PROXY_PORT || 8080);

const agent = new https.Agent({ rejectUnauthorized: false });

const server = http.createServer((req, res) => {
  const headers = { ...req.headers, host: `localhost:${PROXY_PORT}` };
  const proxyReq = https.request(
    {
      hostname: 'localhost',
      port: PROXY_PORT,
      path: req.url,
      method: req.method,
      headers,
      agent,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(`sdk-dev-proxy недоступен на https://localhost:${PROXY_PORT}: ${err.message}`);
  });
  req.pipe(proxyReq);
});

server.listen(BRIDGE_PORT, '127.0.0.1', () => {
  console.log(`Yandex dev HTTP bridge: http://localhost:${BRIDGE_PORT}/`);
  console.log(`-> official proxy: https://localhost:${PROXY_PORT}/`);
});
