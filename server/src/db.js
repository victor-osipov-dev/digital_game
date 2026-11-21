'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
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
  session_epoch INTEGER NOT NULL DEFAULT 0, -- растёт только при смене пароля
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

-- Отзыв конкретных сессий. Сессии по кластеру не реплицируются, а выход
-- обязан работать на всех серверах, поэтому разносим именно факты отзыва.
CREATE TABLE IF NOT EXISTS revoked_sessions (
  token_hash   TEXT PRIMARY KEY,
  login_ci     TEXT NOT NULL,
  revoked_ms   INTEGER NOT NULL,
  expires_ms   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_revoked_sessions_login ON revoked_sessions(login_ci);

-- Журнал исходящих отзывов для соседей: курсор отдельный от аккаунтов.
CREATE TABLE IF NOT EXISTS revocation_outbox (
  seq          INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT NOT NULL,
  login_ci     TEXT NOT NULL,
  revoked_ms   INTEGER NOT NULL,
  expires_ms   INTEGER NOT NULL
);
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
    this._ensureColumn('peer_state', 'rev_last_seq', 'INTEGER NOT NULL DEFAULT 0');
    this._ensureColumn('peer_state', 'rev_last_pull_ms', 'INTEGER NOT NULL DEFAULT 0');
    this._ensureColumn('accounts', 'session_epoch', 'INTEGER NOT NULL DEFAULT 0');
    // Мягкое удаление (tombstone для репликации): 0 — жив, иначе ms удаления.
    this._ensureColumn('accounts', 'deleted_ms', 'INTEGER NOT NULL DEFAULT 0');
    this.pruneOutbox();
    log.info(`sqlite готов: ${config.dbPath}`);
  }

  _ensureColumn(table, column, type) {
    try {
      this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
    } catch (e) {
      if (!/duplicate column name/i.test(String((e && e.message) || e))) throw e;
    }
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

  // Смена пароля двигает и updated_ms, и эпоху сессий: все токены,
  // выданные до смены, обязаны умереть на всех серверах. Смена ника epoch
  // не трогает, чтобы не выкидывать игрока из игры сменой подписи.
  updateCredentials(loginCi, pwdHash) {
    const cur = this.getAccount(loginCi);
    if (!cur) return null;
    const now = Math.max(Date.now(), cur.updated_ms + 1);
    const tx = this.db.transaction(() => {
      this.db.prepare(
        'UPDATE accounts SET pwd_hash = ?, session_epoch = session_epoch + 1, updated_ms = ? WHERE login_ci = ?',
      ).run(pwdHash, now, loginCi);
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

  /**
   * Учёт сыгранной партии. Вызывается ТОЛЬКО из hub.recordGameResult —
   * единственного писателя games/wins: он срабатывает один раз на партию
   * (сторожок room._statsRecorded) со всех путей хода — обычный ход,
   * черновик по дедлайну, ход бота. Клиентских ручек записи статистики
   * нет вообще, накрутить победы запросом нельзя. Удалённым (tombstone)
   * не начисляем. Состояние уходит в outbox — статистика реплицируется
   * как аккаунты. updated_ms НЕ двигаем, чтобы не мешать правилу
   * владения контентом.
   */
  addResult(loginCi, won) {
    const info = this.db.prepare(
      'UPDATE accounts SET games = games + 1, wins = wins + ? WHERE login_ci = ? AND deleted_ms = 0',
    ).run(won ? 1 : 0, loginCi);
    if (info.changes > 0) {
      this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
        .run(loginCi, Date.now());
    }
    return info.changes > 0;
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
   * Статистика (games/wins) правилу владения НЕ подчиняется: это
   * монотонные счётчики, их всегда сводим через max — иначе счёт,
   * набранный на другом сервере, терялся бы или откатывался. Конкурентные
   * инкременты на двух серверах max недооценивает (берёт больший, а не
   * сумму) — для казуального топа приемлемо, зафиксировано явно.
   *
   * Удаление — через tombstone (deleted_ms): свежая tombstone гасит живую
   * запись; живая запись свежее tombstone считается перерегистрацией и
   * принимается целиком (с новым origin). Возвраты: 'inserted', 'updated',
   * 'stale', 'not-owner' — как раньше, плюс 'deleted' (применили чужое
   * удаление) и 'tombstone' (наша tombstone устояла).
   *
   * Принятое кладём в outbox — иначе аккаунт, дошедший от соседа, не
   * дойдёт до третьего сервера. Сходимость обеспечивает строгое сравнение
   * updated_ms: при повторной доставке запись уже не «свежее».
   */
  mergeRemoteAccount(remote) {
    if (!remote || !remote.login_ci) return 'skip';
    const rGames = Math.max(0, Number(remote.games) || 0);
    const rWins = Math.max(0, Number(remote.wins) || 0);
    const rDel = Number(remote.deleted_ms) || 0;
    const cur = this.getAccount(remote.login_ci);
    if (!cur) {
      this.db.prepare(`
        INSERT INTO accounts (login_ci, login, nick, pwd_hash, origin, created_ms, updated_ms, session_epoch, last_seen_ms, games, wins, deleted_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        remote.login_ci, remote.login, remote.nick, remote.pwd_hash,
        remote.origin, remote.created_ms, remote.updated_ms, Number(remote.session_epoch) || 0,
        rGames, rWins, rDel,
      );
      this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
        .run(remote.login_ci, Number(remote.updated_ms));
      return 'inserted';
    }
    const cDel = Number(cur.deleted_ms) || 0;
    if (rDel > 0 && rDel >= cDel && rDel > Number(cur.updated_ms)) {
      // Свежая чужая tombstone гасит живую запись: трём PII и статистику.
      this._applyTombstone(remote.login_ci, rDel, Math.max(rDel, Number(cur.updated_ms) + 1));
      return 'deleted';
    }
    if (cDel > 0) {
      if (rDel > 0) return 'tombstone';
      // Живая реплика новее нашей tombstone — перерегистрация на соседе:
      // принимаем целиком (контент, статистику, новый origin).
      if (Number(remote.updated_ms) > cDel) {
        this.db.prepare(
          `UPDATE accounts SET login = ?, nick = ?, pwd_hash = ?, origin = ?,
            updated_ms = ?, session_epoch = ?, games = ?, wins = ?, deleted_ms = 0
           WHERE login_ci = ?`,
        ).run(
          remote.login, remote.nick, remote.pwd_hash, remote.origin,
          Number(remote.updated_ms), Number(remote.session_epoch) || 0,
          rGames, rWins, remote.login_ci,
        );
        this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
          .run(remote.login_ci, Number(remote.updated_ms));
        return 'updated';
      }
      return 'tombstone';
    }
    if (String(remote.origin) !== String(cur.origin)) {
      this._mergeStatsMax(remote.login_ci, rGames, rWins);
      return 'not-owner';
    }
    if (Number(remote.updated_ms) > Number(cur.updated_ms)) {
      this.db.prepare(
        'UPDATE accounts SET login = ?, nick = ?, pwd_hash = ?, updated_ms = ?, session_epoch = ? WHERE login_ci = ?',
      ).run(
        remote.login, remote.nick, remote.pwd_hash, Number(remote.updated_ms),
        Number(remote.session_epoch) || 0, remote.login_ci,
      );
      this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
        .run(remote.login_ci, Number(remote.updated_ms));
      this._mergeStatsMax(remote.login_ci, rGames, rWins);
      return 'updated';
    }
    this._mergeStatsMax(remote.login_ci, rGames, rWins);
    return 'stale';
  }

  /**
   * Сведение счётчиков через max (только живым записям). В outbox пишем
   * ТОЛЬКО когда числа реально выросли: SQLite считает changes даже при
   * записи тех же значений, и без проверки gossip разносил бы одни и те
   * же строки по кругу бесконечно пухнущим outbox (ловили вживую —
   * серверы начинали захлёбываться под gossip-штормом).
   */
  _mergeStatsMax(loginCi, games, wins) {
    const cur = this.getAccount(loginCi);
    if (!cur || Number(cur.deleted_ms) > 0) return;
    const g = Math.max(Number(cur.games) || 0, Math.max(0, Number(games) || 0));
    const w = Math.max(Number(cur.wins) || 0, Math.max(0, Number(wins) || 0));
    if (g === Number(cur.games) && w === Number(cur.wins)) return;
    this.db.prepare('UPDATE accounts SET games = ?, wins = ? WHERE login_ci = ?')
      .run(g, w, loginCi);
    this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
      .run(loginCi, Date.now());
  }

  /** Наложить tombstone: стереть PII и статистику, пометить время. */
  _applyTombstone(loginCi, deletedMs, updatedMs) {
    this.db.prepare(
      `UPDATE accounts SET nick = '', pwd_hash = ?, games = 0, wins = 0,
        updated_ms = ?, deleted_ms = ? WHERE login_ci = ?`,
    ).run(`*deleted*${crypto.randomBytes(16).toString('base64url')}`, updatedMs, deletedMs, loginCi);
    this.db.prepare('INSERT INTO outbox (login_ci, created_ms) VALUES (?, ?)')
      .run(loginCi, updatedMs);
  }

  // ------------------------------------------------------------ топ и удаление

  /**
   * Топ по победам (только живые с сыгранными партиями). Удалённые и
   * нулевые не светятся. Ранг не считаем здесь — его дocчитывает
   * boardList по месту игрока.
   */
  boardTop(limit) {
    const n = Math.max(1, Math.min(100, Number(limit) || 20));
    return this.db.prepare(
      `SELECT nick, games, wins FROM accounts
       WHERE deleted_ms = 0 AND games > 0
       ORDER BY wins DESC, games ASC, nick ASC LIMIT ?`,
    ).all(n);
  }

  /** Место игрока в топе (1-based) либо null, если его там нет. */
  boardRank(loginCi) {
    const me = this.getAccount(loginCi);
    if (!me || Number(me.deleted_ms) > 0 || Number(me.games) <= 0) return null;
    const r = this.db.prepare(
      `SELECT COUNT(*) AS c FROM accounts
       WHERE deleted_ms = 0 AND games > 0
         AND (wins > ? OR (wins = ? AND games < ?))`,
    ).get(Number(me.wins), Number(me.wins), Number(me.games));
    return Number(r.c) + 1;
  }

  /**
   * Мягкое удаление: стираем PII и статистику, ставим tombstone.
   * Строка остаётся ради репликации (соседи должны узнать и забыть тоже),
   * сессии и их отзывы чистятся отдельно в accounts.deleteAccount.
   */
  deleteAccount(loginCi) {
    const cur = this.getAccount(loginCi);
    if (!cur || Number(cur.deleted_ms) > 0) return false;
    const tomb = Math.max(Date.now(), Number(cur.updated_ms) + 1);
    this._applyTombstone(loginCi, tomb, tomb);
    return true;
  }

  /** Убрать tombstone перед перерегистрацией того же логина (свежая запись). */
  wipeTombstone(loginCi) {
    this.db.prepare('DELETE FROM accounts WHERE login_ci = ? AND deleted_ms > 0')
      .run(loginCi);
  }

  /** Хеши всех сессий логина — чтобы отозвать их все при удалении. */
  sessionsOf(loginCi) {
    return this.db.prepare('SELECT token_hash FROM sessions WHERE login_ci = ?')
      .all(loginCi).map((r) => r.token_hash);
  }

  // ------------------------------------------------------------ outbox

  /**
   * Дедупликация журналов: на логин/токен оставляем только свежайшую
   * строку. Безопасно для сходимости: merge идемпотентен по updated_ms
   * (старые состояния проигрывают новым), курсоры соседей — по seq,
   * а seq монотонны и не переиспользуются. Чинит раздутие после багов
   * вроде «писать в outbox без изменений» — gossip иначе догонял бы
   * backlog десятками минут.
   */
  pruneOutbox() {
    const a = this.db.prepare(
      'DELETE FROM outbox WHERE seq NOT IN (SELECT MAX(seq) FROM outbox GROUP BY login_ci)',
    ).run();
    const r = this.db.prepare(
      'DELETE FROM revocation_outbox WHERE seq NOT IN (SELECT MAX(seq) FROM revocation_outbox GROUP BY token_hash)',
    ).run();
    if (a.changes > 0 || r.changes > 0) {
      log.info(`outbox ужаты: аккаунты -${a.changes}, отзывы -${r.changes}`);
    }
    return a.changes + r.changes;
  }

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

  setPeerState(peerId, lastSeq, pulled, rev = {}) {
    const now = Date.now();
    const cur = this.getPeerState(peerId) || {};
    const revSeq = rev.lastSeq === undefined ? Number(cur.rev_last_seq) || 0 : rev.lastSeq;
    const revPull = rev.pulled ? now : Number(cur.rev_last_pull_ms) || 0;
    this.db.prepare(`
      INSERT INTO peer_state (
        peer_id, last_seq, last_pull_ms, last_seen_ms, rev_last_seq, rev_last_pull_ms
      )
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(peer_id) DO UPDATE SET
        last_seq = excluded.last_seq,
        last_pull_ms = excluded.last_pull_ms,
        last_seen_ms = excluded.last_seen_ms,
        rev_last_seq = excluded.rev_last_seq,
        rev_last_pull_ms = excluded.rev_last_pull_ms
    `).run(peerId, lastSeq, pulled ? now : 0, now, revSeq, revPull);
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

  revokeSession(tokenHash, loginCi, revokedMs = Date.now(), expiresMs = 0) {
    const tx = this.db.transaction(() => {
      const info = this.db.prepare(`
        INSERT INTO revoked_sessions (token_hash, login_ci, revoked_ms, expires_ms)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(token_hash) DO NOTHING
      `).run(tokenHash, loginCi, revokedMs, expiresMs);
      if (info.changes > 0) {
        this.db.prepare(`
          INSERT INTO revocation_outbox (token_hash, login_ci, revoked_ms, expires_ms)
          VALUES (?, ?, ?, ?)
        `).run(tokenHash, loginCi, revokedMs, expiresMs);
      }
      return info.changes > 0;
    });
    return tx();
  }

  revokedSession(tokenHash, now = Date.now()) {
    const row = this.db.prepare('SELECT * FROM revoked_sessions WHERE token_hash = ?').get(tokenHash);
    if (!row) return null;
    if (Number(row.expires_ms) <= now) {
      this.db.prepare('DELETE FROM revoked_sessions WHERE token_hash = ?').run(tokenHash);
      return null;
    }
    return row;
  }

  revokedSince(seq, limit) {
    this.pruneRevokedSessions();
    return this.db.prepare(`
      SELECT seq, token_hash, login_ci, revoked_ms, expires_ms
      FROM revocation_outbox
      WHERE seq > ? ORDER BY seq ASC LIMIT ?
    `).all(seq, limit);
  }

  revocationSeq() {
    const r = this.db.prepare('SELECT COALESCE(MAX(seq), 0) AS s FROM revocation_outbox').get();
    return r.s;
  }

  applyRemoteRevocation(remote, now = Date.now()) {
    if (!remote || typeof remote.token_hash !== 'string' || typeof remote.login_ci !== 'string') return 'skip';
    const revokedMs = Number(remote.revoked_ms);
    const expiresMs = Number(remote.expires_ms);
    if (!Number.isFinite(revokedMs) || !Number.isFinite(expiresMs)) return 'skip';
    if (expiresMs <= now) return 'expired';
    const info = this.db.prepare(`
      INSERT INTO revoked_sessions (token_hash, login_ci, revoked_ms, expires_ms)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(token_hash) DO NOTHING
    `).run(remote.token_hash, remote.login_ci, revokedMs, expiresMs);
    if (info.changes === 0) return 'duplicate';
    this.db.prepare(`
      INSERT INTO revocation_outbox (token_hash, login_ci, revoked_ms, expires_ms)
      VALUES (?, ?, ?, ?)
    `).run(remote.token_hash, remote.login_ci, revokedMs, expiresMs);
    return 'inserted';
  }

  pruneRevokedSessions(now = Date.now()) {
    this.db.prepare('DELETE FROM revoked_sessions WHERE expires_ms <= ?').run(now);
    // Просроченные записи не нужны и в журнале: токен с истёкшим exp всё
    // равно не пройдёт verifyToken, а журнал иначе рос бы бесконечно.
    this.db.prepare('DELETE FROM revocation_outbox WHERE expires_ms <= ?').run(now);
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
