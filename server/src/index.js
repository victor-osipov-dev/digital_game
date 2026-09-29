'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const { config } = require('./config');
const log = require('./log');
const { Db } = require('./db');
const { Accounts } = require('./accounts');
const { Cluster } = require('./cluster');
const { Rooms } = require('./rooms');
const { Hub } = require('./hub');

const startedAt = Date.now();

// ---------------------------------------------------------------- запуск

const db = new Db();
const accounts = new Accounts(db);
const cluster = new Cluster(db);
const rooms = new Rooms(db);
// Быстрому матчу нужно уметь превратить id в данные игрока.
rooms.setUserResolver((id) => {
  const acc = db.getAccount(id);
  return acc ? { id: acc.login_ci, login: acc.login, nick: acc.nick, account: acc } : null;
});

const hub = new Hub({ db, accounts, cluster, rooms });
// Автостарт комнаты завершается здесь: хаб рассылает стартовое состояние
// всем участникам и запускает ботов на пустых местах.
rooms.onPlay = (room) => hub.onRoomPlay(room);

// Свойство экземпляра с тем же именем, что и метод класса, молча
// перекрывает метод: `cluster.peers()` превращался в `cluster.peers` (массив)
// и падал уже в момент старта. Проверяем на старте, а не по месту падения.
for (const [name, obj] of [['Cluster', cluster], ['Hub', hub], ['Rooms', rooms], ['Db', db], ['Accounts', accounts]]) {
  const proto = Object.getPrototypeOf(obj);
  for (const field of Object.keys(obj)) {
    if (typeof proto[field] === 'function') {
      throw new Error(`${name}.${field} — поле перекрывает метод класса с тем же именем, переименуйте одно из них`);
    }
  }
}

const server = createServer();
hub.attach(server);
cluster.start();

// Режим берём у САМОГО сервера, а не у config: конфиг может быть
// настроен, а TLS при этом не подняться. Раньше строка печатала «TLS» по
// наличию путей в конфиге и врала ровно тогда, когда это было важнее всего.
const mode = server instanceof https.Server ? 'TLS' : 'БЕЗ TLS!';

server.listen(config.listenPort, config.listenHost, () => {
  log.info(`${config.serverName} (${config.serverId}) слушает `
    + `${config.listenHost}:${config.listenPort} — ${mode}`);
  if (mode !== 'TLS') {
    log.error('работаю без TLS: клиент подключается только по wss и не сможет');
  }
  if (config.peerUrls.length > 0) {
    log.info(`соседи: ${cluster.peers().map((p) => p.url).join(', ')}`);
  } else {
    log.warn('соседей не задано (DG_PEER_URLS пуст) — работаем автономно');
  }
});

function createServer() {
  if (!config.tlsCertFile && !config.tlsKeyFile) {
    // TLS не настроен вовсе — осознанный режим для локальных стендов и
    // тестов, и только он. Молчание тут допустимо, но громко говорим.
    log.warn('TLS не настроен (DG_TLS_CERT/DG_TLS_KEY пусты) — работаю без TLS. '
      + 'Клиент говорит только по wss и такой сервер ему не годится.');
    return http.createServer(handle);
  }
  if (!config.tlsCertFile || !config.tlsKeyFile) {
    throw new Error('заданы не оба пути: DG_TLS_CERT=' + String(config.tlsCertFile)
      + ', DG_TLS_KEY=' + String(config.tlsKeyFile));
  }
  const cert = readTls(config.tlsCertFile, 'сертификат');
  const key = readTls(config.tlsKeyFile, 'ключ');
  return https.createServer({ cert, key, minVersion: 'TLSv1.2' }, handle);
}

// Читаем файлы и РАЗЛИЧАЕМ две разные беды, которые раньше сливались в
// одну тихую: «сертификата нет» и «сертификат есть, но не прочитать».
// Проверка стояла на existsSync, а он возвращает false в обоих случаях
// одинаково — потому что на непроходимом родительском каталоге stat()
// отдаёт EACCES. Итог был такой: сервер, которому выдали и сертификат и
// ключ, поднимался БЕЗ TLS на публичном порту, и логины с ходами шли
// открытым текстом, а в журнале стояло безобидное «сертификат не найден».
// Теперь такая настройка — ошибка запуска, а не предупреждение.
function readTls(file, what) {
  try {
    return fs.readFileSync(file);
  } catch (e) {
    if (e.code === 'EACCES' || e.code === 'EPERM') {
      throw new Error(`не могу прочитать ${what}: ${file} — нет прав (${e.code}). `
        + 'Обычно каталог с сертификатами достался root:root с правами 750, '
        + `и пользователь службы в него не входит. Лечится: `
        + `chown root:digital-game $(dirname ${file}) && chmod 750 $(dirname ${file})`);
    }
    if (e.code === 'ENOENT') {
      throw new Error(`не могу прочитать ${what}: ${file} — файла нет. `
        + 'Выпустить: sh server/deploy/gen-cert.sh <ip>');
    }
    throw new Error(`не могу прочитать ${what}: ${file} — ${e.code || e.message}`);
  }
}

// ---------------------------------------------------------------- HTTP
// Весь обмен с клиентом идёт по WebSocket. Здесь только три вещи:
// служебный /health, gossip между серверами и 404 на всё остальное.

function handle(req, res) {
  let url;
  try {
    url = new URL(req.url, 'http://x');
  } catch (_) {
    return reply(res, 400, { error: 'bad url' });
  }
  const p = url.pathname;

  if (p === '/health') {
    return reply(res, 200, {
      ok: true,
      id: config.serverId,
      name: config.serverName,
      region: config.region,
      host: config.publicHost,
      port: config.publicPort,
      version: config.protocolVersion,
      uptimeMs: Date.now() - startedAt,
      sockets: hub.sockets.size,
      rooms: rooms.rooms.size,
      rssMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
    });
  }

  if (p === '/cluster/gossip' && req.method === 'POST') {
    return readBody(req, res, (raw) => {
      if (!verifySignature(raw, req)) {
        log.warn(`gossip без верной подписи с ${req.socket.remoteAddress}`);
        return reply(res, 403, { error: 'bad signature' });
      }
      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch (_) {
        return reply(res, 400, { error: 'bad json' });
      }
      const out = cluster.handleGossip(parsed);
      if (!out.ok) return reply(res, 400, out);
      log.debug(`gossip от ${parsed.from.server_id}: `
        + `отдано аккаунтов ${out.accounts.length}, серверов ${out.servers.length}`);
      return reply(res, 200, out);
    });
  }

  if (p === '/cluster/servers') {
    return reply(res, 200, { servers: cluster.registry() });
  }

  return reply(res, 404, { error: 'not found' });
}

function verifySignature(raw, req) {
  const crypto = require('crypto');
  const sig = String(req.headers['x-dg-sign'] || '');
  if (sig === '') return false;
  const expect = crypto.createHmac('sha256', config.clusterSecret).update(raw).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function readBody(req, res, cb) {
  // Реплика аккаунтов может быть большой, но не бесконечной.
  const LIMIT = 4 * 1024 * 1024;
  let size = 0;
  const chunks = [];
  req.on('data', (c) => {
    size += c.length;
    if (size > LIMIT) {
      req.destroy();
      res.writeHead(413);
      res.end();
      return;
    }
    chunks.push(c);
  });
  req.on('end', () => cb(Buffer.concat(chunks).toString('utf8')));
  req.on('error', () => { /* клиент отвалился, отвечать некому */ });
}

function reply(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

// ---------------------------------------------------------------- выключение

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info(`получен ${signal}, останавливаюсь`);
  cluster.stop();
  rooms.stop();
  hub.stop();
  server.close(() => {
    db.close();
    log.info('остановлен');
    process.exit(0);
  });
  // Не ждём вечно: сокеты могут быть живыми.
  setTimeout(() => process.exit(0), 4000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => log.error(`uncaught: ${e.stack || e.message}`));
process.on('unhandledRejection', (e) => log.error(`unhandled rejection: ${e}`));
