// Запуск официального @yandex-games/sdk-dev-proxy для этой игры.
//
// Реальная реклама (interstitial/rewarded) возможна только в режиме
// без --dev-mode и только с App ID черновика из консоли Яндекс Игр:
//
//   YANDEX_APP_ID=123456 npm run yandex:proxy
//
// Dev-режим (без App ID) поднимает официальный dev-адаптер SDK и HTTP-мост,
// потому что у sdk-dev-proxy самоподписанный сертификат без SAN, который
// браузеры не принимают:
//
//   npm run yandex:proxy:dev
//
// Настройки также можно положить в .env.local:
//   YANDEX_APP_ID=123456
//   YANDEX_PROXY_PORT=8080
//   YANDEX_DEV_MODE=1

import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadEnvFile(file) {
  if (!existsSync(file)) return;
  const text = readFileSync(file, 'utf8');
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, '.env.local'));
loadEnvFile(path.join(ROOT, '.env'));

const cliArgs = process.argv.slice(2);
const devMode = cliArgs.includes('--dev-mode') || process.env.YANDEX_DEV_MODE === '1';
const port = Number(process.env.YANDEX_PROXY_PORT || 8080);
const bridgePort = Number(process.env.YANDEX_BRIDGE_PORT || port + 1);
const appId = (process.env.YANDEX_APP_ID || '').trim();

const dist = path.join(ROOT, 'dist', 'index.html');
if (!existsSync(dist)) {
  console.error('Нет dist/index.html. Сначала выполните: npm run build');
  process.exit(1);
}

if (!devMode && !appId) {
  console.error(
    [
      'Для настоящей рекламы нужен App ID черновика игры из консоли Яндекс Игр.',
      'Запустите так:',
      '  PowerShell: $env:YANDEX_APP_ID="123456"; npm run yandex:proxy',
      'или создайте .env.local со строкой YANDEX_APP_ID=123456',
      '',
      'Без App ID доступен только dev-режим без настоящих показов:',
      '  npm run yandex:proxy:dev',
    ].join('\n'),
  );
  process.exit(1);
}

const cli = path.join(
  ROOT,
  'node_modules',
  '@yandex-games',
  'sdk-dev-proxy',
  'bin',
  'index.js',
);

const proxyArgs = [cli, '-p', path.join(ROOT, 'dist'), '--port', String(port), '-l', 'false'];
if (devMode) proxyArgs.push('--dev-mode');
else proxyArgs.push('--app-id', appId);

const children = [];

const proxy = spawn(process.execPath, proxyArgs, {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});
children.push(proxy);

if (devMode) {
  const bridge = spawn(process.execPath, [path.join(ROOT, 'tools', 'yandex-dev-http-bridge.mjs')], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      PROXY_PORT: String(port),
      BRIDGE_PORT: String(bridgePort),
    },
  });
  children.push(bridge);

  console.log('');
  console.log(`Откройте игру через HTTP-мост: http://localhost:${bridgePort}/`);
  console.log('Это dev-адаптер SDK: настоящих рекламных показов в нём нет.');
}

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));
proxy.on('exit', (code) => shutdown(code ?? 0));
