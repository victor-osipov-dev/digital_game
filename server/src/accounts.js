'use strict';

const crypto = require('crypto');
const { config } = require('./config');
const log = require('./log');

// Логин: 3..20 символов, буквы/цифры/подчёркивание/точка/дефис.
// Ник свободнее: 1..24 любых видимых символов.
const LOGIN_RE = /^[A-Za-z0-9_.-]{3,20}$/;

function normalizeLogin(raw) {
  return String(raw || '').trim().toLowerCase();
}

function checkLogin(raw) {
  const v = String(raw || '').trim();
  if (v.length === 0) return 'Введите логин';
  if (!LOGIN_RE.test(v)) return 'Логин: 3–20 символов, латиница, цифры, _ . -';
  return '';
}

function checkPassword(raw) {
  const v = String(raw || '');
  if (v.length < 6) return 'Пароль: минимум 6 символов';
  if (v.length > 200) return 'Пароль: максимум 200 символов';
  return '';
}

const NICK_RESERVED = new Set([
  'admin', 'administrator', 'root', 'support', 'moderator', 'system',
  'админ', 'администратор', 'поддержка', 'модер', 'модератор', 'система',
]);

function checkNick(raw) {
  const v = String(raw || '').trim();
  if (v.length === 0) return 'Введите ник';
  if (v.length > 24) return 'Ник: максимум 24 символа';
  // Управляющие символы ломают списки игроков и журналы, а «админ» и «бот»
  // вводят соперников в заблуждение: за ботов играют только серверные места.
  if (/[\u0000-\u001F\u007F-\u009F]/.test(v)) return 'Ник: без управляющих символов';
  const compact = v.toLowerCase().replace(/[\s_-]+/g, '');
  if (NICK_RESERVED.has(compact)) return 'Ник: это служебное имя';
  if (/^(bot|бот)\d*$/.test(compact)) return 'Ник: ботом может называться только бот';
  return '';
}

// ------------------------------------------------------------------ пароли

function hashPassword(plain) {
  const salt = crypto.randomBytes(config.saltLen);
  const key = crypto.scryptSync(plain, salt, config.keyLen, {
    N: config.scryptN, r: config.scryptR, p: config.scryptP,
  });
  return `${salt.toString('base64')}$${key.toString('base64')}`;
}

function verifyPassword(plain, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 2) return false;
  let salt;
  let expected;
  try {
    salt = Buffer.from(parts[0], 'base64');
    expected = Buffer.from(parts[1], 'base64');
  } catch (_) {
    return false;
  }
  if (expected.length !== config.keyLen) return false;
  let key;
  try {
    key = crypto.scryptSync(plain, salt, config.keyLen, {
      N: config.scryptN, r: config.scryptR, p: config.scryptP,
    });
  } catch (_) {
    return false;
  }
  return crypto.timingSafeEqual(key, expected);
}

// ------------------------------------------------------------------ токены
//
// Токен подписан общим секретом кластера, поэтому его выдаёт любой сервер,
// а принимает любой: залогинились на RU, переключились на LV — и вход живой.
//
// Сессии по кластеру НЕ реплицируются (это лишний трафик ради строчки в
// базе), поэтому сервер, который видит токен впервые, «усыновляет» его.
// Чтобы отзыв всё-таки работал и на чужом сервере, токен помнит updated_ms
// аккаунта на момент выдачи (поле u). Если с тех пор пароль или ник
// менялись, updated_ms аккаунта больше — значит токен выдан до смены и
// должен умереть. Смена пароля на одном сервере таким образом гасит токены
// на всех остальных, как только до них дойдёт реплика аккаунта.

function b64u(buf) {
  return Buffer.from(buf).toString('base64url');
}

// Время жизни токена: отзывы сессий при удалении аккаунта живут столько же,
// иначе отозванный токен воскрес бы на соседе после чистки просроченных.
const TOKEN_TTL_MS = 90 * 24 * 3600 * 1000;

function signToken(loginCi, sessionEpoch) {
  const now = Date.now();
  const payload = {
    l: loginCi,
    // Эпоха сессий, а не updated_ms: смена ника не должна убивать токены,
    // а смена пароля обязана убивать их все. Старые токены без v понимают
    // u как updated_ms — для них проверка ниже отдельная.
    v: 2,
    u: Number(sessionEpoch) || 0,
    iat: now,
    exp: now + TOKEN_TTL_MS,
  };
  const body = b64u(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', config.clusterSecret).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyToken(token) {
  const t = String(token || '');
  const dot = t.lastIndexOf('.');
  if (dot <= 0) return null;
  const body = t.slice(0, dot);
  const sig = t.slice(dot + 1);
  const expect = crypto.createHmac('sha256', config.clusterSecret).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length) return null;
  if (!crypto.timingSafeEqual(a, b)) return null;
  let payload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
  if (!payload || typeof payload.l !== 'string') return null;
  if (payload.v !== undefined && payload.v !== 2) return null;
  if (typeof payload.u !== 'number') return null;
  if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
  return payload;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url');
}

function tokenEpochOk(payload, acc) {
  if (payload.v === 2) return payload.u === (Number(acc.session_epoch) || 0);
  return payload.u >= Number(acc.updated_ms);
}

// ------------------------------------------------------------------ сервис

class Accounts {
  constructor(db) {
    this.db = db;
  }

  register(loginRaw, password, nickRaw) {
    const le = checkLogin(loginRaw);
    if (le) return { ok: false, reason: le };
    const pe = checkPassword(password);
    if (pe) return { ok: false, reason: pe };
    // Ник по умолчанию равен логину, если игрок ничего не ввёл.
    const nick = String(nickRaw || '').trim() || String(loginRaw).trim();
    const ne = checkNick(nick);
    if (ne) return { ok: false, reason: ne };

    const loginCi = normalizeLogin(loginRaw);
    // Удалённый логин можно занять заново: tombstone стираем, дальше —
    // обычное создание свежей записи (статистика и данные не воскресают).
    if (this._isDeleted(loginCi)) this.db.wipeTombstone(loginCi);
    const now = Date.now();
    const rec = {
      login_ci: loginCi,
      login: String(loginRaw).trim(),
      nick: nick.slice(0, 24),
      pwd_hash: hashPassword(password),
      origin: config.serverId,
      created_ms: now,
      updated_ms: now,
    };
    const res = this.db.createAccount(rec);
    if (!res.ok) return { ok: false, reason: res.reason };
    log.info(`регистрация: ${loginCi} (origin ${config.serverId})`);
    return { ok: true, account: res.account, token: this.issue(res.account) };
  }

  login(loginRaw, password) {
    const loginCi = normalizeLogin(loginRaw);
    const acc = this.db.getAccount(loginCi);
    // Удалённый — как несуществующий: та же общая ошибка и та же
    // стоимость хеширования, чтобы не выдавать факт прошлого существования.
    if (!acc || this._isDeleted(loginCi)) {
      // Ровно столько работы, сколько при реальном логине, чтобы по
      // времени ответа нельзя было перебором отличить несуществующий
      // логин от неверного пароля. Текст ошибки тоже общий: разные
      // тексты превращали бы каждую попытку в проверку существования логина.
      hashPassword(String(password || ''));
      return { ok: false, reason: 'Неверный логин или пароль' };
    }
    if (!verifyPassword(String(password || ''), acc.pwd_hash)) {
      return { ok: false, reason: 'Неверный логин или пароль' };
    }
    this.db.touchAccount(loginCi);
    return { ok: true, account: acc, token: this.issue(acc) };
  }

  /**
   * Вход через Yandex ID (только Web/Yandex Games): находит аккаунт
   * ya:<uid> или создаёт его. Отдельное пространство имён — обычный
   * register/login такой логин не примут (двоеточие вне [A-Za-z0-9_.-]),
   * а пароль здесь случайный и никому не выдаётся: подобрать его нельзя,
   * перехватить чужой ya-аккаунт паролем — тоже. Гостевая сущность без
   * доверия парольного аккаунта: для казуальной игры хватает, секретов
   * в таких аккаунтах не держим. Подпись Yandex не проверяем (нужен ключ
   * покупок, которого нет) — фиксируем это ограничение явно.
   * Формат UID: цифры 1–20 (настоящий Yandex ID) плюс канонический UUID
   * 8-4-4-4-12 — так генерирует uniqueID стаб sdk-dev-proxy в dev-mode.
   * Модель угроз от этого не меняется: подпись всё равно не проверяется,
   * а пространство UUID не перебирается и живёт в отдельном ya:-неймспейсе.
   */
  loginYa(uidRaw, nickRaw) {
    const uid = String(uidRaw || '').trim();
    const YA_UID_RE = /^(?:[0-9]{1,20}|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
    if (!YA_UID_RE.test(uid)) return { ok: false, reason: 'Некорректный Yandex ID' };
    const login = `ya:${uid}`;
    const loginCi = login.toLowerCase();
    let acc = this.db.getAccount(loginCi);
    // Удалённый UID занимается заново свежей записью (как в register).
    if (acc && this._isDeleted(loginCi)) {
      this.db.wipeTombstone(loginCi);
      acc = null;
    }
    if (!acc) {
      let nick = String(nickRaw || '').trim();
      if (checkNick(nick)) nick = `Игрок-${uid.slice(-4)}`;
      const now = Date.now();
      const rec = {
        login_ci: loginCi,
        login,
        nick: nick.slice(0, 24),
        pwd_hash: hashPassword(crypto.randomBytes(32).toString('base64url')),
        origin: config.serverId,
        created_ms: now,
        updated_ms: now,
      };
      const res = this.db.createAccount(rec);
      if (!res.ok) return { ok: false, reason: res.reason };
      acc = res.account;
      log.info(`вход Yandex ID: ${loginCi} (origin ${config.serverId})`);
    }
    this.db.touchAccount(loginCi);
    return { ok: true, account: acc, token: this.issue(acc) };
  }

  /**
   * Вход по сохранённому токену, в том числе выданному другим сервером.
   *
   * Проверка updated_ms делается ВСЕГДА, даже для сессии, о которой мы знаем:
   * если пароль сменили на соседнем сервере, до нас дойдёт реплика аккаунта,
   * но локальную сессию никто не удалит. Без этой проверки токен, выданный до
   * смены пароля, продолжал бы работать на всех серверах, кроме того, где
   * сменили.
   *
   * Незнакомая сессия (токен выдан соседом, sessions не реплицируются)
   * принимается и записывается у нас — дальше проверка локальная.
   */
  resume(token) {
    const payload = verifyToken(token);
    if (!payload) return { ok: false, reason: 'Сессия недействительна' };
    const acc = this.db.getAccount(payload.l);
    // Удалённый аккаунт старым токеном не воскрешается (сессии при
    // удалении отзываются, но сам токен мог сохраниться у клиента).
    if (!acc || this._isDeleted(payload.l)) return { ok: false, reason: 'Сессия недействительна' };

    const fresh = tokenEpochOk(payload, acc);
    const hash = tokenHash(token);
    if (!fresh) {
      // Токен старше последнего изменения аккаунта — гасим и запись, если она
      // была, чтобы следующая попытка не тратила время на её поиск.
      this.db.dropSession(hash);
      return { ok: false, reason: 'Сессия недействительна' };
    }
    if (this.db.revokedSession(hash)) {
      this.db.dropSession(hash);
      return { ok: false, reason: 'Сессия недействительна' };
    }
    if (this.db.sessionExists(hash)) this.db.touchSession(hash);
    else this.db.putSession(hash, acc.login_ci);
    this.db.touchAccount(acc.login_ci);
    return { ok: true, account: acc, token: String(token) };
  }

  logout(token) {
    const payload = verifyToken(token);
    if (!payload || typeof payload.l !== 'string') return false;
    const hash = tokenHash(token);
    const expires = Number(payload.exp) || 0;
    this.db.dropSession(hash);
    // Отзываем именно этот токен на всех серверах: сессии по кластеру не
    // реплицируются, а подпись остаётся валидной до exp. Без записи отзыва
    // выход на одном сервере не закрывал бы вход на другом.
    this.db.revokeSession(hash, payload.l, Date.now(), expires);
    return true;
  }

  sessionAlive(token) {
    const payload = verifyToken(token);
    if (!payload || typeof payload.l !== 'string') return false;
    const acc = this.db.getAccount(payload.l);
    if (!acc || this._isDeleted(payload.l) || !tokenEpochOk(payload, acc)) return false;
    if (this.db.revokedSession(tokenHash(token))) return false;
    return true;
  }

  issue(account) {
    const token = signToken(account.login_ci, Number(account.session_epoch) || 0);
    this.db.putSession(tokenHash(token), account.login_ci);
    return token;
  }

  changePassword(account, oldPassword, newPassword) {
    if (!verifyPassword(String(oldPassword || ''), account.pwd_hash)) {
      return { ok: false, reason: 'Старый пароль неверен' };
    }
    const pe = checkPassword(newPassword);
    if (pe) return { ok: false, reason: pe };
    const updated = this.db.updateCredentials(
      account.login_ci,
      hashPassword(String(newPassword)),
    );
    this.db.dropSessionsOf(account.login_ci);
    return { ok: true, account: updated, token: this.issue(updated) };
  }

  changeNick(account, nickRaw) {
    const ne = checkNick(nickRaw);
    if (ne) return { ok: false, reason: ne };
    const nick = String(nickRaw).trim().slice(0, 24);
    return { ok: true, account: this.db.updateAccount(account.login_ci, { nick }) };
  }

  /** Tombstone-проверка: true — аккаунт удалён (строка-пустышка для реплики). */
  _isDeleted(loginCi) {
    const acc = this.db.getAccount(loginCi);
    return !!acc && Number(acc.deleted_ms) > 0;
  }

  /**
   * Удаление аккаунта со всеми данными: все сессии отзываются (отзывы
   * реплицируются штатным журналом), запись превращается в tombstone без
   * PII и статистики. Возвращает ok — дальше хаб рвёт текущее соединение.
   */
  deleteAccount(loginCi) {
    const acc = this.db.getAccount(loginCi);
    if (!acc || Number(acc.deleted_ms) > 0) return { ok: false, reason: 'Аккаунт не найден' };
    const now = Date.now();
    for (const hash of this.db.sessionsOf(loginCi)) {
      this.db.dropSession(hash);
      this.db.revokeSession(hash, loginCi, now, now + TOKEN_TTL_MS);
    }
    this.db.deleteAccount(loginCi);
    log.info(`удаление аккаунта: ${loginCi} (origin ${config.serverId})`);
    return { ok: true };
  }

  /**
   * Таблица лидеров: топ сервера (только проверенные сервером очки —
   * ручек записи статистики у клиентов нет) плюс место вызывающего.
   */
  boardList(loginCi, limit) {
    const entries = this.db.boardTop(limit).map((r) => ({
      nick: r.nick, games: Number(r.games), wins: Number(r.wins),
    }));
    let me = null;
    const acc = loginCi ? this.db.getAccount(String(loginCi)) : null;
    if (acc && Number(acc.deleted_ms) === 0 && Number(acc.games) > 0) {
      me = {
        nick: acc.nick, games: Number(acc.games), wins: Number(acc.wins),
        rank: this.db.boardRank(acc.login_ci),
      };
    }
    return { entries, me };
  }

  /** То, что сервер отдаёт наружу. Хеш пароля наружу не уходит. */
  publicView(account) {
    return {
      login: account.login,
      nick: account.nick,
      games: account.games,
      wins: account.wins,
    };
  }
}

module.exports = {
  Accounts, normalizeLogin, checkLogin, checkPassword, checkNick,
  hashPassword, verifyPassword, signToken, verifyToken, tokenHash,
};
