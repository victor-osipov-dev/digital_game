#!/usr/bin/env node
'use strict';

// ==============================================================
//  local_cluster.js — два сервера на этой машине, с TLS и gossip'ом.
//
//  Нужен, чтобы ПРОВЕРИТЬ ДЕПЛОЙ, не трогая боевые машины. Серверы
//  поднимаются на 127.0.0.1:21677/21678, общаются друг с другом
//  ровно так же, как боевые, и после этого с ними работает
//  deploy_check.js --certs-dir.
//
//  Отличие от боевого один, и он важный: сертификат здесь выпущен
//  на 127.0.0.1, а не на боевой IP. Именно поэтому проверка сертификата
//  в deploy_check не нарисована — она и на боевых машинах проверяет
//  то же самое, а вот выпуск боевого сертификата делает deploy.py,
//  который после выпуска сверяет его openssl verify -verify_ip.
//
//  Запуск:
//      node server/tools/local_cluster.js            # поднять и ждать Ctrl+C
//      node server/tools/local_cluster.js --check    # поднять, прогнать
//                                                   # deploy_check, убить
// ==============================================================

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const PORT_A = 21677;
const PORT_B = 21678;
const SECRET = 'local-cluster-secret-4711';
const RUN_DIR = path.join(os.tmpdir(), 'dg-local-cluster');
const CERTS_DIR = path.join(RUN_DIR, 'certs');

const OPENSSL = [
  'C:/Program Files/PostgreSQL/12/bin/openssl.exe',
  '/usr/bin/openssl',
  'openssl',
].find((p) => {
  if (p === 'openssl') return true;
  return fs.existsSync(p);
});

function sh(cmd, args, opts) {
  const r = spawnSync(cmd, args, Object.assign({ encoding: 'utf8' }, opts || {}));
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  }
  return r.stdout;
}

function makeCert() {
  // Один сертификат на оба порта: сертификат проверяет ИМЯ, а не порт,
  // поэтому 127.0.0.1 годится для обоих.
  const cert = path.join(CERTS_DIR, 'cert.pem');
  const key = path.join(CERTS_DIR, 'key.pem');
  if (fs.existsSync(cert)) return { cert, key };
  // Свой openssl.cnf, а не системный: сборки openssl внутри других
  // программ (PostgreSQL, nanoCAD) ищут конфиг по путям своей сборки
  // и на чужой машине падают с «no such file». Конфиг сгодится и в
  // OpenSSL 1.1, и в 3.x, поэтому здесь ровно три секции и ничего лишнего:
  // секция providers нужна только 3.x, а 1.1 на ней падает.
  const cnf = path.join(CERTS_DIR, 'openssl.cnf');
  fs.writeFileSync(cnf, [
    '[req]',
    'distinguished_name = dn',
    'x509_extensions = ext',
    'prompt = no',
    '',
    '[dn]',
    'CN = 127.0.0.1',
    '',
    '[ext]',
    'basicConstraints = critical,CA:FALSE',
    'keyUsage = critical,digitalSignature,keyEncipherment',
    'extendedKeyUsage = serverAuth',
    'subjectAltName = IP:127.0.0.1',
    '',
  ].join('\n'), 'utf8');
  sh(OPENSSL, [
    'req', '-x509', '-nodes', '-newkey', 'rsa:2048', '-days', '3650',
    '-keyout', key, '-out', cert,
    '-config', cnf,
  ], { env: Object.assign({}, process.env, { OPENSSL_CONF: cnf }) });
  // Имя файла — как ищет Certs._load в клиенте: адрес дефисами.
  // .crt — родное расширение Godot, .pem тоже ищется, но вторым.
  fs.copyFileSync(cert, path.join(CERTS_DIR, '127-0-0-1.crt'));
  fs.copyFileSync(cert, path.join(CERTS_DIR, '127-0-0-1.pem'));
  return { cert, key };
}

function startOne(id, name, region, port, peerPort, cert, key) {
  const data = path.join(RUN_DIR, id);
  fs.mkdirSync(data, { recursive: true });
  return spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
    cwd: path.join(ROOT, 'server'),
    stdio: ['ignore', 'inherit', 'inherit'],
    env: Object.assign({}, process.env, {
      DG_SERVER_ID: id,
      DG_SERVER_NAME: name,
      DG_REGION: region,
      DG_PUBLIC_HOST: '127.0.0.1',
      DG_PUBLIC_PORT: String(port),
      DG_LISTEN_HOST: '127.0.0.1',
      DG_LISTEN_PORT: String(port),
      DG_TLS_CERT: cert,
      DG_TLS_KEY: key,
      DG_CLUSTER_SECRET: SECRET,
      DG_PEER_URLS: `https://127.0.0.1:${peerPort}`,
      // Ускоряем gossip: в бою раз в минуту, тут раз в секунду, иначе
      // проверка репликации ждала бы минуту на каждый шаг.
      DG_GOSSIP_INTERVAL_MS: '1000',
      DG_SERVER_TTL_MS: '5000',
      DG_DATA_DIR: data,
      DG_LOG_LEVEL: 'info',
      DG_DISCONNECT_GRACE_MS: '5000',
    }),
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const check = process.argv.includes('--check');
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  fs.mkdirSync(CERTS_DIR, { recursive: true });
  const { cert, key } = makeCert();
  console.log(`локальный кластер: 127.0.0.1:${PORT_A} и :${PORT_B}`);
  console.log(`данные и сертификаты: ${RUN_DIR}`);

  const a = startOne('srv-local-a', 'Локальный A', 'local', PORT_A, PORT_B, cert, key);
  const b = startOne('srv-local-b', 'Локальный B', 'local', PORT_B, PORT_A, cert, key);
  let code = 0;
  try {
    await sleep(2500);
    if (check) {
      const r = spawnSync(process.execPath, [
        path.join(ROOT, 'server', 'tools', 'deploy_check.js'),
        '--server', `srv-local-a=127.0.0.1:${PORT_A}`,
        '--server', `srv-local-b=127.0.0.1:${PORT_B}`,
        '--certs-dir', CERTS_DIR,
        '--wait', '20',
      ], { cwd: ROOT, stdio: 'inherit' });
      code = r.status;
    } else {
      console.log('\nнажмите Ctrl+C, чтобы остановить');
      await new Promise(() => {});
    }
  } finally {
    a.kill();
    b.kill();
  }
  process.exit(code);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
