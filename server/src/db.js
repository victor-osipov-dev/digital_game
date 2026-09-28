'use strict';

const fs = require('fs');
const path = require('path');
const { Database } = require('./sqlite');
const { config } = require('./config');
const log = require('./log');

// Схема. Аккаунты реплицируются между серверами, игровое состояние — нет:
// партия живёт в памяти процесса и гибнет вместе с ним (это осознанно).
const SCHEMA = `
CREATE TABLE IF NOT EXISTS accounts (
  login_ci     TEXT PRIMARY KEY,          -- логин в нижнем регистре
  login        TEXT NOT NULL,             -- как игрок его написал
  nick         TEXT NOT NULL,
  pwd_hash     TEXT NOT NULL,             -- scrypt: <salt_b64>$<hash_b64>
  origin       TEXT NOT NULL,             -- server_id, который принял регистрацию
  created_ms   INTEGER NOT NULL,
  updated_ms   INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL DEFAULT 0,
  games        INTEGER NOT NULL DEFAULT 0,
  wins         INTEGER NOT NULL DEFAULT 0
);

-- Журнал исходящих изменений: соседям уходит всё, что появилось после
-- их курсора. Курсоры соседей лежат в peer_state.
CREATE TABLE IF NOT EXISTS outbox (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT,
  login_ci    TEXT NOT NULL,
  created_ms  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outbox_login ON outbox(login_ci);

CREATE TABLE IF NOT EXISTS peer_state (
  peer_id      TEXT PRIMARY KEY,
  last_seq     INTEGER NOT NULL DEFAULT 0,
  last_pull_ms INTEGER NOT NULL DEFAULT 0,
  last_seen_ms INTEGER NOT NULL DEFAULT 0
);

-- Реестр живых серверов кластера. Каждая запись обновляется владельцем
-- раз в gossipIntervalMs; молчащие дольше serverTtlMs исчезают.
CREATE TABLE IF NOT EXISTS cluster_servers (
  server_id     TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  region        TEXT NOT NULL,
  host          TEXT NOT NULL,
  port          INTEGER NOT NULL,
  version       TEXT NOT NULL,
  first_seen_ms INTEGER NOT NULL,
  last_seen_ms  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  login_ci     TEXT NOT NULL,
  created_ms   INTEGER NOT NULL,
  last_seen_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_login ON sessions(login_ci);
`;

class Db {
  constructor() {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    this.db = new Database(config.dbPath);
    // WAL переживает перезапуск без потери данных и не блокирует чтение.
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('synchronous = NORMAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(SCHEMA);
    log.info(`sqlite готов: ${config.dbPath}`);
  }

  // ------------------------------------------------------------ аккаунты

  getAccount(loginCi) {
    return this.db.prepare('SELECT * FROM accounts WHERE login_ci = ?').get(loginCi) || null;
  }

  /**
   * Создание аккаунта. Возвращает {ok, account} либо {ok:false, reason}.
   * Аккаунт НЕ перезаписывается, если логин уже занят: правило
   * «кто первый создал — тот владелец» (см. mergeRemoteAccount).
   */
  createAccount(rec) {
    const existing = this.getAccount(rec.login_ci);
    if (existing) return { ok: false, reason: 'Этот логин уже занят' };
    const tx = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO accounts (login_ci, login, nick, pwd_hash, origin, created_ms, updated_ms, last_seen_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(rec.login_ci, rec.login, rec.nick, rec.pwd_hash, rec.origin, rec.created_ms, rec.updated_ms);
      this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
        .run(rec.login_ci, rec.created_ms);
    });
    tx();
    return { ok: true, account: this.getAccount(rec.login_ci) };
  }

  // Смена ника/пароля двигает updated_ms и кладёт запись в outbox.
  // updated_ms строго монотонен на аккаунт, чтобы «часы» не откатились
  // и старый пароль не пришёл поверх нового.
  updateAccount(loginCi, patch) {
    const cur = this.getAccount(loginCi);
    if (!cur) return null;
    const now = Math.max(Date.now(), cur.updated_ms + 1);
    const nick = patch.nick !== undefined ? patch.nick : cur.nick;
    const pwdHash = patch.pwd_hash !== undefined ? patch.pwd_hash : cur.pwd_hash;
    const tx = this.db.transaction(() => {
      this.db.prepare(
        'UPDATE accounts SET nick = ?, pwd_hash = ?, updated_ms = ? WHERE login_ci = ?',
      ).run(nick, pwdHash, now, loginCi);
      this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
        .run(loginCi, now);
    });
    tx();
    return this.getAccount(loginCi);
  }

  touchAccount(loginCi) {
    this.db.prepare('UPDATE accounts SET last_seen_ms = ? WHERE login_ci = ?')
      .run(Date.now(), loginCi);
  }

  addResult(loginCi, won) {
    this.db.prepare(
      'UPDATE accounts SET games = games + 1, wins = wins + ? WHERE login_ci = ?',
    ).run(won ? 1 : 0, loginCi);
  }

  /**
   * Приём реплики от соседа. Правило владения: «кто первый создал — тот
   * и владелец» (выбор пользователя).
   *
   * Отсюда следует главное ограничение безопасности: содержание аккаунта
   * (ник и хеш пароля) принимается ТОЛЬКО от сервера-владельца, то есть
   * когда origin реплики совпадает с origin нашей записи. Иначе любой
   * сосед, знающий логин, прислал бы «свой» хеш пароля и угнал бы чужой
   * аккаунт.
   *
   * Принятое кладём в outbox — иначе аккаунт, дошедший от соседа, не
   * дойдёт до третьего сервера. Сходимость обеспечивает строгое сравнение
   * updated_ms: при повторной доставке запись уже не «свежее».
   */
  mergeRemoteAccount(remote) {
    if (!remote || !remote.login_ci) return 'skip';
    const cur = this.getAccount(remote.login_ci);
    if (!cur) {
      this.db.prepare(`
        INSERT INTO accounts (login_ci, login, nick, pwd_hash, origin, created_ms, updated_ms, last_seen_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, 0)
      `).run(
        remote.login_ci, remote.login, remote.nick, remote.pwd_hash,
        remote.origin, remote.created_ms, remote.updated_ms,
      );
      this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
        .run(remote.login_ci, Number(remote.updated_ms));
      return 'inserted';
    }
    if (String(remote.origin) !== String(cur.origin)) return 'not-owner';
    if (Number(remote.updated_ms) > Number(cur.updated_ms)) {
      this.db.prepare(
        'UPDATE accounts SET login = ?, nick = ?, pwd_hash = ?, updated_ms = ? WHERE login_ci = ?',
      ).run(remote.login, remote.nick, remote.pwd_hash, Number(remote.updated_ms), remote.login_ci);
      this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
        .run(remote.login_ci, Number(remote.updated_ms));
      return 'updated';
    }
    return 'stale';
  }

  // ------------------------------------------------------------ outbox

  outboxSince(seq, limit) {
    return this.db.prepare(
      `SELECT o.seq AS seq, a.* FROM outbox o
       JOIN accounts a ON a.login_ci = o.login_ci
       WHERE o.seq > ? ORDER BY o.seq ASC LIMIT ?`,
    ).all(seq, limit);
  }

  outboxSeq() {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM outbox').get();
    return r.s;
  }

  getPeerState(peerId) {
    return this.db.prepare('SELECT * FROM peer_state WHERE peer_id = ?').get(peerId) || null;
  }

  setPeerState(peerId, lastSeq, pulled) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO peer_state (peer_id, last_seq, last_pull_ms, last_seen_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        last_seq = excluded.last_seq,
        last_pull_ms = excluded.last_pull_ms,
        last_seen_ms = excluded.last_seen_ms
    `).run(peerId, lastSeq, pulled ? now : 0, now);
  }

  // ------------------------------------------------------------ сессии

  putSession(tokenHash, loginCi) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO sessions (token_hash, login_ci, created_ms, last_seen_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(token_hash) DO UPDATE SET last_seen_ms = excluded.last_seen_ms
    `).run(tokenHash, loginCi, now, now);
  }

  sessionExists(tokenHash) {
    const r = this.db.prepare('SELECT token_hash FROM sessions WHERE token_hash = ?').get(tokenHash);
    return !!r;
  }

  touchSession(tokenHash) {
    this.db.prepare('UPDATE sessions SET last_seen_ms = ? WHERE token_hash = ?')
      .run(Date.now(), tokenHash);
  }

  dropSession(tokenHash) {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
  }

  dropSessionsOf(loginCi) {
    this.db.prepare('DELETE FROM sessions WHERE login_ci = ?').run(loginCi);
  }

  pruneSessions() {
    const cutoff = Date.now() - 90 * 24 * 3600 * 1000;
    this.db.prepare('DELETE FROM sessions WHERE last_seen_ms < ?').run(cutoff);
  }

  // ------------------------------------------------------------ кластер

  upsertClusterServer(rec) {
    const now = Date.now();
    this.db.prepare(`
      INSERT INTO cluster_servers (server_id, name, region, host, port, version, first_seen_ms, last_seen_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(server_id) DO UPDATE SET
        name = excluded.name, region = excluded.region, host = excluded.host,
        port = excluded.port, version = excluded.version,
        last_seen_ms = excluded.last_seen_ms
    `).run(
      rec.server_id, rec.name, rec.region, rec.host, rec.port, rec.version, now, now,
    );
  }

  listClusterServers() {
    return this.db.prepare('SELECT * FROM cluster_servers ORDER BY server_id ASC').all();
  }

  /** Записи, которые никто не подтверждал дольше TTL, выбрасываем. */
  pruneClusterServers(ttlMs) {
    const cutoff = Date.now() - ttlMs;
    const gone = this.db.prepare('SELECT server_id FROM cluster_servers WHERE last_seen_ms < ?')
      .all(cutoff);
    for (const g of gone) {
      this.db.prepare('DELETE FROM cluster_servers WHERE server_id = ?').run(g.server_id);
    }
    return gone.map((g) => g.server_id);
  }

  close() {
    this.db.close();
  }
}

module.exports = { Db };
