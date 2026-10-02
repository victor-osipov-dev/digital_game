'use strict';

const { config } = require('./config');
const log = require('./log');

// Реплицируются ровно три вещи:
//   1) реестр живых серверов кластера;
//   2) аккаунты (логин, ник, хеш пароля);
//   3) отзывы сессий (хеши токенов).
// Игровое состояние не реплицируется принципиально: партия живёт в памяти
// одного сервера и гибнет вместе с ним. Так и было задумано.
//
// Синхронизация — встречный HTTP POST раз в gossipIntervalMs плюс срочный
// пуш, когда сменился аккаунт. Курсор соседа (peer_state.last_seq) не даёт
// пересылать одно и то же повторно.

const ACCOUNT_BATCH = 200;
const REVOCATION_BATCH = 200;
// Даже подписанный сосед не должен присылать безразмерные массивы: тело и
// так ограничено 8 МБ, но явный предел защищает базу от раздувания одной
// аномальной репликой.
const MAX_INBOUND_ROWS = 1000;

function signBody(raw) {
  const crypto = require('crypto');
  return crypto.createHmac('sha256', config.clusterSecret).update(raw).digest('base64url');
}

class Cluster {
  constructor(db) {
    this.db = db;
    // Поле называется peerList, а не peers: свойство экземпляра `peers`
    // перекрыло бы метод peers() — вызов молча отдавал бы массив вместо
    // функции. Метод с таким же именем, как поле, в JS — ловушка.
    this.peerList = config.peerUrls.map((url) => ({ url: url.replace(/\/+$/, ''), id: null }));
    this.timer = null;
    this.busy = false;
  }

  selfRecord() {
    return {
      server_id: config.serverId,
      name: config.serverName,
      region: config.region,
      host: config.publicHost,
      port: config.publicPort,
      version: String(config.protocolVersion),
    };
  }

  // Периодический цикл: объявляем себя, забираем чужие записи, чистим мёртвые.
  start() {
    this.announceSelf();
    this.timer = setInterval(() => {
      this.cycle().catch((e) => log.warn(`gossip: ${e.message}`));
    }, config.gossipIntervalMs);
    if (this.timer.unref) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  announceSelf() {
    this.db.upsertClusterServer(this.selfRecord());
  }

  async cycle() {
    if (this.busy) return;
    this.busy = true;
    try {
      this.announceSelf();
      await this.exchange();
      const gone = this.db.pruneClusterServers(config.serverTtlMs);
      if (gone.length > 0) log.info(`из реестра выброшены молчавшие серверы: ${gone.join(', ')}`);
    } finally {
      this.busy = false;
    }
  }

  // Срочная отправка всем соседям (после регистрации/смены пароля).
  async push() {
    if (this.peerList.length === 0) return;
    try {
      await this.exchange();
    } catch (e) {
      log.warn(`срочный gossip не удался: ${e.message}`);
    }
  }

  async exchange() {
    const results = await Promise.allSettled(
      this.peerList.map((p) => this.talk(p)),
    );
    let ok = 0;
    for (const r of results) if (r.status === 'fulfilled') ok += 1;
    if (ok > 0) this.db.upsertClusterServer(this.selfRecord());
    return ok;
  }

  async talk(peer) {
    const state = this.db.getPeerState(peer.url);
    const since = state ? state.last_seq : 0;
    const revSince = state ? Number(state.rev_last_seq) || 0 : 0;
    const payload = {
      from: this.selfRecord(),
      since,
      revSince,
      accounts: this.db.outboxSince(since, ACCOUNT_BATCH).map(rowToAccount),
    };
    const body = JSON.stringify(payload);
    const http = require('http');
    const https = require('https');
    const lib = peer.url.startsWith('https://') ? https : http;
    const url = new URL(`${peer.url}/cluster/gossip`);

    const res = await new Promise((resolve, reject) => {
      const req = lib.request(
        {
          method: 'POST',
          hostname: url.hostname,
          port: url.port || (url.protocol === 'https:' ? 443 : 80),
          path: url.pathname,
          rejectUnauthorized: false,
          headers: {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(body),
            'x-dg-sign': signBody(body),
          },
          timeout: 8000,
        },
        (r) => {
          let data = '';
          r.setEncoding('utf8');
          r.on('data', (c) => { data += c; if (data.length > 8 * 1024 * 1024) req.destroy(); });
          r.on('end', () => resolve({ status: r.statusCode, data }));
        },
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('timeout')); });
      req.write(body);
      req.end();
    });

    if (res.status !== 200) {
      throw new Error(`peer ${peer.url} ответил ${res.status}`);
    }
    const reply = JSON.parse(res.data);
    if (!reply || !reply.from || !reply.from.server_id) {
      throw new Error(`peer ${peer.url} вернул мусор`);
    }
    this.ingest(reply);
    // Курсор двигаем только по тому, что реально долетело в this.accounts.
    // Если сервер срезал пачку (more=true), курсор остаётся на sent_up_to,
    // и доберём остаток на следующем цикле.
    if (!reply.more) {
      this.db.setPeerState(peer.url, Number(reply.sent_up_to) || 0, true);
    } else {
      this.db.setPeerState(peer.url, since, true);
    }
    // Тот же принцип для отзывов сессий: у них отдельный курсор.
    const peerState = this.db.getPeerState(peer.url) || {};
    if (!reply.rev_more) {
      this.db.setPeerState(peer.url, Number(peerState.last_seq) || 0, false, {
        lastSeq: Number(reply.rev_sent_up_to) || revSince,
        pulled: true,
      });
    } else {
      this.db.setPeerState(peer.url, Number(peerState.last_seq) || 0, false, {
        lastSeq: revSince,
        pulled: true,
      });
    }
    this.db.upsertClusterServer({
      server_id: reply.from.server_id,
      name: String(reply.from.name || reply.from.server_id),
      region: String(reply.from.region || '?'),
      host: String(reply.from.host || ''),
      port: Number(reply.from.port) || 0,
      version: String(reply.from.version || '?'),
    });
    peer.id = reply.from.server_id;
    return reply;
  }

  /**
   * Приём реплики от соседа.
   *
   * Сначала сам приславший: его запись лежит в `from`, а не в `servers`.
   * Если полагаться только на список, соседи узнают друг о друге лишь
   * через один gossip — с задержкой в лишний цикл.
   */
  ingest(reply) {
    if (reply.from && reply.from.server_id
        && reply.from.server_id !== config.serverId && reply.from.host) {
      this.db.upsertClusterServer({
        server_id: String(reply.from.server_id),
        name: String(reply.from.name || reply.from.server_id),
        region: String(reply.from.region || '?'),
        host: String(reply.from.host),
        port: Number(reply.from.port) || 0,
        version: String(reply.from.version || '?'),
      });
    }
    if (Array.isArray(reply.servers)) {
      for (const s of reply.servers) {
        if (!s || s.server_id === config.serverId) continue;
        if (!s.server_id || !s.host) continue;
        this.db.upsertClusterServer({
          server_id: String(s.server_id),
          name: String(s.name || s.server_id),
          region: String(s.region || '?'),
          host: String(s.host),
          port: Number(s.port) || 0,
          version: String(s.version || '?'),
        });
      }
    }
    let inserted = 0;
    let updated = 0;
    if (Array.isArray(reply.accounts)) {
      for (const acc of reply.accounts) {
        const how = this.db.mergeRemoteAccount(acc);
        if (how === 'inserted') inserted += 1;
        else if (how === 'updated') updated += 1;
      }
    }
    let revoked = 0;
    if (Array.isArray(reply.revocations)) {
      for (const rev of reply.revocations) {
        if (this.db.applyRemoteRevocation(rev) === 'inserted') revoked += 1;
      }
    }
    if (inserted > 0 || updated > 0 || revoked > 0) {
      log.info(`репликация от ${reply.from.server_id}: +${inserted} новых, обновлено ${updated}, отозвано сессий ${revoked}`);
    }
    return { inserted, updated, revoked };
  }

  /** Разбор входящего /cluster/gossip. Возвращает ответ для соседа. */
  handleGossip(body) {
    if (!body || typeof body !== 'object') return { ok: false, reason: 'bad body' };
    if (!body.from || !body.from.server_id) return { ok: false, reason: 'bad from' };
    if ((Array.isArray(body.accounts) && body.accounts.length > MAX_INBOUND_ROWS)
      || (Array.isArray(body.revocations) && body.revocations.length > MAX_INBOUND_ROWS)) {
      return { ok: false, reason: 'batch too large' };
    }
    // Мы должны знать и про себя: сосед получит наш реестр и увидит нас.
    this.announceSelf();
    this.ingest(body);
    // Сосед прислал свой курсор по НАШЕМУ outbox — отдаём ему пачку строго
    // после этого курсора. Курсор ответа равен seq последней реально
    // отправленной записи, а не текущему максимуму: иначе при усечении
    // пачки мы бы «перепрыгнули» неотправленные записи навсегда.
    const since = Number(body.since) || 0;
    const batch = this.db.outboxSince(since, ACCOUNT_BATCH);
    const sentUpTo = batch.length > 0 ? Number(batch[batch.length - 1].seq) : since;
    const revSince = Number(body.revSince) || 0;
    const revBatch = this.db.revokedSince(revSince, REVOCATION_BATCH);
    const revSentUpTo = revBatch.length > 0 ? Number(revBatch[revBatch.length - 1].seq) : revSince;
    return {
      ok: true,
      from: this.selfRecord(),
      sent_up_to: sentUpTo,
      more: batch.length === ACCOUNT_BATCH,
      accounts: batch.map(rowToAccount),
      rev_sent_up_to: revSentUpTo,
      rev_more: revBatch.length === REVOCATION_BATCH,
      revocations: revBatch.map((row) => ({
        token_hash: row.token_hash,
        login_ci: row.login_ci,
        revoked_ms: row.revoked_ms,
        expires_ms: row.expires_ms,
      })),
      servers: this.db.listClusterServers(),
    };
  }

  /** Список живых серверов для клиента. */
  registry() {
    this.announceSelf();
    const cutoff = Date.now() - config.serverTtlMs;
    const rows = this.db.listClusterServers().filter((r) => r.last_seen_ms >= cutoff);
    return rows.map((r) => ({
      id: r.server_id,
      name: r.name,
      region: r.region,
      host: r.host,
      port: r.port,
      version: r.version,
      online: true,
      self: r.server_id === config.serverId,
    }));
  }

  peers() {
    return this.peerList.map((p) => ({ url: p.url, id: p.id }));
  }
}

function rowToAccount(row) {
  return {
    login_ci: row.login_ci,
    login: row.login,
    nick: row.nick,
    pwd_hash: row.pwd_hash,
    origin: row.origin,
    created_ms: row.created_ms,
    updated_ms: row.updated_ms,
    session_epoch: Number(row.session_epoch) || 0,
  };
}

module.exports = { Cluster, rowToAccount };
