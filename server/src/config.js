'use strict';

const fs = require('fs');
const path = require('path');

// Конфиг приходит из окружения, а окружение — из systemd-юнита
// (EnvironmentFile=/etc/digital-game/server.env). Локально для разработки
// можно положить .env рядом с server/ — он в .gitignore.

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const raw = fs.readFileSync(file, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (s === '' || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq === -1) continue;
    const key = s.slice(0, eq).trim();
    let val = s.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.join(__dirname, '..', '.env'));
loadDotEnv('/etc/digital-game/server.env');

function str(key, def) {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
}

function int(key, def) {
  const v = Number(process.env[key]);
  return Number.isFinite(v) ? Math.trunc(v) : def;
}

const config = {
  // --- идентификация сервера в кластере --------------------------------
  serverId: str('DG_SERVER_ID', 'srv-local'),
  serverName: str('DG_SERVER_NAME', 'Локальный сервер'),
  region: str('DG_REGION', 'local'),
  // Адрес, который видят клиенты. Не обязательно совпадает с тем, на что
  // сервер слушает: за nginx/ NAT может быть другое имя.
  publicHost: str('DG_PUBLIC_HOST', '127.0.0.1'),
  publicPort: int('DG_PUBLIC_PORT', 6767),
  listenHost: str('DG_LISTEN_HOST', '0.0.0.0'),
  listenPort: int('DG_LISTEN_PORT', 6767),

  // --- база -------------------------------------------------------------
  dataDir: str('DG_DATA_DIR', path.join(__dirname, '..', 'data')),
  dbFile: str('DG_DB_FILE', ''),

  // --- TLS (самоподписанный сертификат) ---------------------------------
  tlsKeyFile: str('DG_TLS_KEY', ''),
  tlsCertFile: str('DG_TLS_CERT', ''),

  // --- кластер: репликация аккаунтов и реестра серверов -----------------
  // Секрет один на весь кластер: подписывает и gossip между серверами, и
  // токены сессий (поэтому токен, выданный RU, принимает и LV).
  clusterSecret: str('DG_CLUSTER_SECRET', 'dev-secret-change-me'),
  peerUrls: str('DG_PEER_URLS', '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
  // Как часто сервер объявляет себя соседям и забирает их состояние.
  gossipIntervalMs: int('DG_GOSSIP_INTERVAL_MS', 60000),
  // Сколько молчащий сервер может не появляться, прежде чем его запись
  // в реестре исчезнет. Задаёт скорость «удаления» сервера из кластера.
  serverTtlMs: int('DG_SERVER_TTL_MS', 150000),
  // Сколько секунд тишины сервера считается «умершим» для клиента.
  healthTimeoutMs: int('DG_HEALTH_TIMEOUT_MS', 2500),

  // --- ограничения (серверы слабые, держим всё мелким) ------------------
  maxRooms: int('DG_MAX_ROOMS', 60),
  maxSocketsPerIp: int('DG_MAX_SOCKETS_PER_IP', 12),
  authAttemptsPerMinute: int('DG_AUTH_ATTEMPTS_PER_MIN', 20),
  // Суммарные попытки входа с одного доверенного IP за минуту. Ограничение
  // именно по IP, а не по сокету: переподключение создаёт новый контекст и
  // иначе обнуляло бы счётчик.
  authIpAttemptsPerMinute: int('DG_AUTH_IP_ATTEMPTS_PER_MIN', 60),
  // X-Forwarded-For доверяем только перечисленным прокси. По умолчанию
  // список пуст, и для лимитов/журнала берётся прямой адрес сокета.
  trustedProxies: str('DG_TRUSTED_PROXIES', '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== ''),
  // 1 «unit» scrypt = 16 КиБ. Для слабого 1 vCPU держим 16 (128 КиБ).
  scryptN: int('DG_SCRYPT_N', 16384),
  scryptR: int('DG_SCRYPT_R', 8),
  scryptP: int('DG_SCRYPT_P', 1),
  keyLen: int('DG_KEY_LEN', 32),
  saltLen: int('DG_SALT_LEN', 16),

  // --- игровые таймеры ---------------------------------------------------
  // Сколько держать место игроку, который отвалился.
  disconnectGraceMs: int('DG_DISCONNECT_GRACE_MS', 90000),
  // Комната без активности исчезает из списка.
  roomIdleTtlMs: int('DG_ROOM_IDLE_TTL_MS', 600000),
  // Очередь быстрого матча: сколько ждать, не набралось ли людей.
  quickMatchWaitMs: int('DG_QUICK_MATCH_WAIT_MS', 60000),
  quickMatchSweepMs: int('DG_QUICK_MATCH_SWEEP_MS', 5000),
  pingIntervalMs: int('DG_PING_INTERVAL_MS', 25000),
  pongTimeoutMs: int('DG_PONG_TIMEOUT_MS', 20000),

  // --- автостарт и боты ------------------------------------------------
  // Лобби с людьми ждёт пустые места это время, а потом добирает их ботами.
  botFillWaitMs: int('DG_BOT_FILL_WAIT_MS', 60000),
  // Сколько секунд даётся живому игроку на ход. По истечении сервер сам
  // берёт фишку из колоды (или пропускает ход на пустой колоде) и
  // передаёт очередь дальше — партия не встаёт, если игрок отвлёкся.
  turnSeconds: int('DG_TURN_SECONDS', 60),
  // Знакомый минимум «думать» боту, чтобы ход читался как человеческий.
  botTurnDelayMs: int('DG_BOT_TURN_DELAY_MS', 1400),
  // Случайная добавка к задержке: один и тот же ход не должен выглядеть как
  // бенчмарк. Держим в пределах комфорта (иначе партия застрянет у бота).
  botTurnJitterMs: int('DG_BOT_TURN_JITTER_MS', 1000),
  // Пауза между двумя ходами ботов подряд (бот за ботом): клиент
  // показывает каждый ход несколько секунд (шаги + титр), и без неё
  // состояния прилетали бы пачкой — к своему ходу игрок видел бы уже
  // подтаявший отсчёт вместо полной минуты. После хода человека первый
  // бот идёт с обычной короткой задержкой выше.
  botAfterBotDelayMs: int('DG_BOT_AFTER_BOT_DELAY_MS', 3000),

  // Прочее
  protocolVersion: int('DG_PROTOCOL_VERSION', 1),
  logLevel: str('DG_LOG_LEVEL', 'info'),
};

config.dbPath = config.dbFile || path.join(config.dataDir, 'digital-game.sqlite3');

module.exports = { config, loadDotEnv };
