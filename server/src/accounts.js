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

function checkNick(raw) {
  const v = String(raw || '').trim();
  if (v.length === 0) return 'Введите ник';
  if (v.length > 24) return 'Ник: максимум 24 символа';
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

function signToken(loginCi, accountUpdatedMs) {
  const now = Date.now();
  const payload = {
    l: loginCi,
    // 0 для токенов, выданных неизвестно когда, — такой не пройдёт проверку
    // ниже, потому что updated_ms аккаунта заведомо больше нуля.
    u: Number(accountUpdatedMs) || 0,
    iat: now,
    exp: now + 90 * 24 * 3600 * 1000,
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
  if (typeof payload.exp === 'number' && Date.now() > payload.exp) return null;
  return payload;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('base64url');
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
    if (!acc) {
      // Ровно столько работы, сколько при реальном логине, чтобы по
      // времени ответа нельзя было перебором отличить «нет логина»
      // от «неверный пароль».
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
    if (!acc) return { ok: false, reason: 'Сессия недействительна' };

    const fresh = typeof payload.u === 'number' && payload.u >= Number(acc.updated_ms);
    const hash = tokenHash(token);
    if (!fresh) {
      // Токен старше последнего изменения аккаунта — гасим и запись, если она
      // была, чтобы следующая попытка не тратила время на её поиск.
      this.db.dropSession(hash);
      return { ok: false, reason: 'Сессия недействительна' };
    }
    if (this.db.sessionExists(hash)) this.db.touchSession(hash);
    else this.db.putSession(hash, acc.login_ci);
    this.db.touchAccount(acc.login_ci);
    return { ok: true, account: acc, token: String(token) };
  }

  logout(token) {
    if (token) this.db.dropSession(tokenHash(token));
  }

  issue(account) {
    const token = signToken(account.login_ci, account.updated_ms);
    this.db.putSession(tokenHash(token), account.login_ci);
    return token;
  }

  changePassword(account, oldPassword, newPassword) {
    if (!verifyPassword(String(oldPassword || ''), account.pwd_hash)) {
      return { ok: false, reason: 'Старый пароль неверен' };
    }
    const pe = checkPassword(newPassword);
    if (pe) return { ok: false, reason: pe };
    const updated = this.db.updateAccount(account.login_ci, {
      pwd_hash: hashPassword(String(newPassword)),
    });
    this.db.dropSessionsOf(account.login_ci);
    return { ok: true, account: updated, token: this.issue(updated) };
  }

  changeNick(account, nickRaw) {
    const ne = checkNick(nickRaw);
    if (ne) return { ok: false, reason: ne };
    const nick = String(nickRaw).trim().slice(0, 24);
    return { ok: true, account: this.db.updateAccount(account.login_ci, { nick }) };
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
