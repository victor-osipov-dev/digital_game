#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
deploy.py — ставит игровой сервер на VPS без участия человека.

Серверы RU и LV одинаково слабые, и ставить их нужно одинаково. Скрипт
делает ВСЁ сам: создаёт пользователя, ставит Node, заливает код, выпускает
сертификат, включает systemd, дожидается готовности и забирает сертификаты
в клиент.

Что скрипт НЕ делает и не должен:
  * трогает nginx на 443 — там чужое продакшен-приложение (ai-box-cars.ru);
  * создаёт своп и не чистит диск: памяти на RU 256 МБ, но удалять
    пакеты рядом с чужым продакшеном — это способ сломать чужое;
  * ставит Docker и прочее heavyweight — памяти в обрез;
  * трогает что-либо за пределами /opt/digital-game, /etc/digital-game,
    /var/lib/digital-game и собственного systemd-юнита.

Учётные данные берутся из .env в корне репозитория (в git он не входит).

Запуск:
    python server/deploy/deploy.py              # обе машины
    python server/deploy/deploy.py ru           # только Россия
    python server/deploy/deploy.py lv
    python server/deploy/deploy.py --certs-only # только забрать сертификаты
    python server/deploy/deploy.py --status     # ничего не ставить
"""

from __future__ import annotations

import argparse
import posixpath
import shlex
import socket
import sys
import time
from pathlib import Path

import paramiko

ROOT = Path(__file__).resolve().parents[2]
SERVER_DIR = ROOT / "server"
CERTS_DIR = ROOT / "certs"

# Node ставим статической сборкой в /opt, а не из репозитория Ubuntu:
# там node 18, а серверу нужен node:sqlite (появился в 22-м). Статика не
# зависит от версии дистрибутива и не тянет за собой полсотни пакетов.
NODE_VERSION = "v24.21.0"
NODE_TARBALL = f"node-{NODE_VERSION}-linux-x64.tar.xz"
NODE_URL = f"https://nodejs.org/dist/{NODE_VERSION}/{NODE_TARBALL}"
# Контрольная сумма из официального SHASUMS256.txt. Не выдумывается: если
# сумма не совпала, значит архив скачался битым или его подменили по дороге,
# и запускать его нельзя.
NODE_SHA = "fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6"

REMOTE_APP = "/opt/digital-game"
REMOTE_ETC = "/etc/digital-game"
REMOTE_TLS = f"{REMOTE_ETC}/tls"
REMOTE_DATA = "/var/lib/digital-game"
REMOTE_ENV = f"{REMOTE_ETC}/server.env"
REMOTE_UNIT = "/etc/systemd/system/digital-game.service"
SERVICE = "digital-game.service"
SERVICE_USER = "digital-game"
NODE_DIR = "/opt/node"
PORT = 6767


# --------------------------------------------------------------------- .env

def load_env() -> dict:
    """Читает .env из корня репозитория.

    Свой разбор, а не os.environ: переменные этой оболочки победили бы
    тому, что в файле, а deploy обязан видеть ровно то, что записано.
    """
    path = ROOT / ".env"
    if not path.exists():
        sys.exit(f"нет {path} — деплоить нечем")
    out: dict = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        s = line.strip()
        if not s or s.startswith("#") or "=" not in s:
            continue
        key, val = s.split("=", 1)
        out[key.strip()] = val.strip()
    return out


# ------------------------------------------------------------------- хосты

class Target:
    def __init__(self, key: str, env: dict):
        self.key = key
        k = key.upper()
        self.host = env[f"{k}_HOST"]
        self.user = env.get(f"{k}_USER", "root")
        self.password = env.get(f"{k}_PASSWORD", "")
        self.server_id = env[f"DG_{k}_SERVER_ID"]
        self.server_name = env[f"DG_{k}_SERVER_NAME"]
        self.region = env[f"DG_{k}_REGION"]
        self.public_host = env[f"DG_{k}_PUBLIC_HOST"]
        self.peers: list["Target"] = []

    def __str__(self) -> str:
        return f"{self.key} {self.public_host} ({self.server_id})"


def build_targets(env: dict) -> list[Target]:
    found = [Target(k, env) for k in ("RU", "LV") if env.get(f"{k}_HOST")]
    if not found:
        sys.exit("в .env нет ни RU_HOST, ни LV_HOST")
    # Соседями считаются ВСЕ серверы из .env, даже когда ставим один из
    # них: RU должен знать про LV, и наоборот, иначе реестр будет полупустым
    # ровно тогда, когда один из серверов недавно поднят.
    for t in found:
        t.peers = [o for o in found if o is not t]
    return found


# ------------------------------------------------------------------ вывод

def log(msg: str) -> None:
    print(f"     {msg}", flush=True)


def step(msg: str) -> None:
    print(f"\n== {msg}", flush=True)


def die(msg: str) -> "None":
    print(f"\nОШИБКА: {msg}", file=sys.stderr, flush=True)
    sys.exit(1)


# ---------------------------------------------------------------------- ssh

class Remote:
    def __init__(self, target: Target):
        self.t = target
        self.ssh = paramiko.SSHClient()
        self.ssh.set_missing_host_key_policy(paramiko.AutoAddPolicy())
        log(f"подключаюсь к {target.public_host} …")
        try:
            self.ssh.connect(
                target.host,
                username=target.user,
                password=target.password or None,
                timeout=30,
                banner_timeout=60,
                auth_timeout=30,
                look_for_keys=False,
                allow_agent=False,
            )
        except paramiko.AuthenticationException:
            die(f"{target.public_host}: не тот пароль для {target.user}")
        except OSError as e:
            die(f"{target.public_host}: не соединиться ({e})")
        self.sftp = self.ssh.open_sftp()

    def run(self, cmd: str, timeout: int = 900) -> str:
        """Выполняет команду, печатает вывод, падает при ненулевом коде."""
        log(f"$ {cmd}")
        code, out = self._exec(cmd, timeout)
        for line in out.splitlines():
            if line.strip():
                print(f"     | {line}", flush=True)
        if code != 0:
            raise RuntimeError(f"команда упала (код {code}): {cmd}\n{out}")
        return out

    def quiet(self, cmd: str, timeout: int = 300) -> tuple[int, str]:
        """Как run, но молча и без падения: для проверок «есть ли / работает ли»."""
        return self._exec(cmd, timeout)

    def _exec(self, cmd: str, timeout: int) -> tuple[int, str]:
        _, stdout, stderr = self.ssh.exec_command(cmd, timeout=timeout)
        # Читаем оба канала в одном цикле: раздельные read() взаимно
        # блокируются, и процесс, много пишущий в stderr, повесит нас.
        chan = stdout.channel
        buf: list[bytes] = []
        while True:
            moved = False
            while chan.recv_ready():
                buf.append(chan.recv(65536))
                moved = True
            while chan.recv_stderr_ready():
                buf.append(chan.recv_stderr(65536))
                moved = True
            if chan.exit_status_ready() and not chan.recv_ready() and not chan.recv_stderr_ready():
                break
            if not moved:
                time.sleep(0.05)
        code = chan.recv_exit_status()
        return code, b"".join(buf).decode("utf-8", "replace")

    def put(self, local: Path, remote: str, mode: int = 0o644) -> None:
        self.sftp.put(str(local), remote)
        self.sftp.chmod(remote, mode)

    def mkdir(self, remote: str, mode: int = 0o755) -> None:
        try:
            self.sftp.mkdir(remote, mode)
        except IOError:
            pass  # уже есть — это не ошибка, а норма

    def get(self, remote: str, local: Path) -> None:
        self.sftp.get(remote, str(local))

    def close(self) -> None:
        for closer in (self.sftp, self.ssh):
            try:
                closer.close()
            except Exception:  # noqa: BLE001 — закрытие не должно ронять деплой
                pass


# --------------------------------------------------------------- установка

def install_packages(remote: Remote) -> None:
    """Ставит только то, без чего сервер не запустится.

    Без --purge и без apt-get clean: удаление пакетов рядом с чужим
    продакшеном на этих машинах — не наша забота.
    """
    code, out = remote.quiet("openssl version && command -v xz && id -u")
    if code == 0 and out.strip().splitlines()[-1].strip() == "0":
        if "already the newest" not in out:
            log("openssl и xz уже на месте, пропускаю apt")
            return
    remote.run(
        "DEBIAN_FRONTEND=noninteractive apt-get update -qq && "
        "DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends "
        "ca-certificates openssl xz-utils",
        timeout=1200,
    )


def install_node(remote: Remote) -> str:
    """Ставит Node в /opt/node. Идемпотентно: уже нужная версия — не трогаем."""
    # node -v печатает версию С Буквы v («v24.21.0»), и сравнивать надо
    # именно с таким видом: срезанная «v» давала вечное «уже стоит/не
    # запускается» и заставляло переустанавливать node при каждом деплое.
    want = NODE_VERSION
    code, out = remote.quiet(f"{NODE_DIR}/bin/node -v")
    if code == 0 and out.strip() == want:
        log(f"node {want} уже стоит")
        return "уже установлен"

    # id -u, а не id -p: -p («печатать порт») в coreutils этих машин нет,
    # и проверка молча упала бы с ошибкой, посчитав пользователя
    # несуществующим при каждом запуске.
    remote.run(f"id -u node >/dev/null 2>&1 || "
               f"useradd --system --home-dir {NODE_DIR} --shell /usr/sbin/nologin node")
    code, _ = remote.quiet("test -f /opt/node.tar.xz")
    if code != 0:
        log(f"качаю {NODE_TARBALL} (~50 МБ) …")
        # Скачиваем во временный файл и переименовываем только после
        # успеха: оборванная закачка не должна выглядеть как готовый архив.
        remote.run(
            f"curl -fsSL --retry 3 --retry-delay 2 -o /opt/node.tar.xz.part "
            f"{shlex.quote(NODE_URL)} && mv /opt/node.tar.xz.part /opt/node.tar.xz",
            timeout=1800,
        )

    log("сверяю контрольную сумму")
    code, got = remote.quiet("sha256sum /opt/node.tar.xz | cut -d' ' -f1")
    got = got.strip()
    if got != NODE_SHA:
        die(f"контрольная сумма node не совпала.\n"
            f"      ожидали: {NODE_SHA}\n      получили: {got}\n"
            f"      Обнови NODE_SHA в deploy.py под фактическую сумму {NODE_TARBALL}.")

    remote.run(
        f"mkdir -p {NODE_DIR} && tar -xJf /opt/node.tar.xz -C {NODE_DIR} "
        f"--strip-components=1 && chown -R node:node {NODE_DIR}",
        timeout=900,
    )
    code, ver = remote.quiet(f"{NODE_DIR}/bin/node -v")
    if code != 0 or ver.strip() != want:
        die(f"node распаковался, но не запускается: {ver!r}")
    log(f"node {ver.strip()} установлен в {NODE_DIR}")
    return "установлен"


def make_user(remote: Remote) -> None:
    remote.run(
        f"id -u {SERVICE_USER} >/dev/null 2>&1 || "
        f"useradd --system --home-dir {REMOTE_APP} --shell /usr/sbin/nologin {SERVICE_USER}"
    )
    remote.run(f"mkdir -p {REMOTE_APP} {REMOTE_ETC} {REMOTE_TLS} {REMOTE_DATA}")
    # Каталог данных доступен сервису на запись: SQLite обязан создать
    # файл сам, а каталога не будет — сервис не поднимется.
    remote.run(f"chown {SERVICE_USER}:{SERVICE_USER} {REMOTE_DATA}")
    # Группа на КАЖДОМ каталоге, а не только на верхнем. Каталог с
    # сертификатами, оставшийся root:root с правами 750, непроходим для
    # пользователя службы, и node падает с EACCES — причём fs.existsSync
    # на таком файле врёт, отдавая «файла нет», и сервер молча поднимается
    # без TLS. Поэтому права выставляем явно на каждый наш каталог.
    for d in (REMOTE_ETC, REMOTE_TLS):
        remote.run(f"chown root:{SERVICE_USER} {d} && chmod 750 {d}")


def upload_app(remote: Remote) -> int:
    """Заливает server/ в /opt/digital-game. Возвращает число файлов.

    Заливаем исходники и package.json, но НЕ node_modules: там лежат
    бинарные модули под нашу платформу, а на сервере своя. Установку
    зависимостей сервер делает сам под свой Node.
    """
    if not (SERVER_DIR / "src" / "index.js").exists():
        die(f"нет {SERVER_DIR / 'src' / 'index.js'} — это не сервер")

    # Удаляем ТОЛЬКО свой каталог приложения. /opt и /etc на этих
    # машинах общие с чужими сервисами, и «прибраться» здесь нельзя.
    remote.run(f"rm -rf {REMOTE_APP}/src {REMOTE_APP}/tools {REMOTE_APP}/deploy "
               f"{REMOTE_APP}/package.json {REMOTE_APP}/package-lock.json", timeout=300)

    count = 0
    for rel in ("src", "tools", "deploy"):
        local = SERVER_DIR / rel
        if not local.is_dir():
            continue
        remote.mkdir(f"{REMOTE_APP}/{rel}")
        for entry in sorted(local.rglob("*")):
            if any(part in ("node_modules", ".git", "__pycache__") for part in entry.parts):
                continue
            target = posixpath.join(REMOTE_APP, rel, entry.relative_to(local).as_posix())
            if entry.is_dir():
                remote.mkdir(target)
            elif entry.suffix != ".py":
                remote.put(entry, target, 0o644)
                count += 1
    for name in ("package.json", "package-lock.json"):
        local = SERVER_DIR / name
        if local.exists():
            remote.put(local, f"{REMOTE_APP}/{name}", 0o644)
            count += 1
    remote.run(f"chown -R {SERVICE_USER}:{SERVICE_USER} {REMOTE_APP}")
    return count


def npm_install(remote: Remote) -> None:
    # --omit=dev --no-audit: на слабой машине аудит npm ходит в сеть и
    # ест память, а нам нужна ровно production-часть (это один ws).
    remote.run(
        f"cd {REMOTE_APP} && PATH={NODE_DIR}/bin:$PATH "
        f"{NODE_DIR}/bin/npm install --omit=dev --no-audit --no-fund",
        timeout=1800,
    )
    # node:sqlite встроен, но в сборках без него сервер падает на старте.
    # Проверяем ДО включения службы: узнать об этом из журнала systemd
    # post-mortem'ом дороже. API именно DatabaseSync — функции open() у
    # node:sqlite нет, и проверка на ней врала бы, что модуль недоступен.
    code, out = remote.quiet(
        f"cd {REMOTE_APP} && PATH={NODE_DIR}/bin:$PATH {NODE_DIR}/bin/node -e "
        + shlex.quote("const {DatabaseSync}=require('node:sqlite');"
                      "new DatabaseSync(':memory:').close();console.log('sqlite ok')"))
    if code != 0 or "sqlite ok" not in out:
        die(f"node:sqlite недоступен на сервере:\n{out}")
    log("node:sqlite доступен")


def write_env(remote: Remote, target: Target, secret: str) -> None:
    """Пишет /etc/digital-game/server.env.

    Файл вне репозитория и с правами 0640: в отчёт на поддержку попадёт
    строка EnvironmentFile из юнита, а не содержимое. Секрет в этом файле —
    единственное, что отличает наш кластер от чужого, который подделал бы
    gossip и подсунул свои аккаунты.
    """
    peers = ",".join(f"https://{p.public_host}:{PORT}" for p in target.peers)
    body = f"""# Сгенерировано deploy.py {time.strftime('%Y-%m-%d %H:%M')} по МСК.
# Следующий запуск deploy.py перезапишет файл целиком.
#
# DG_CLUSTER_SECRET — общий секрет кластера: им подписывается gossip
# (репликация аккаунтов и реестра серверов) и подписываются токены сессий.
# Он же отличает наш кластер от чужого. Секрет разный у клиента и сервера,
# поэтому клиент не может подделать ни вход, ни ход.

# --- кто я ---------------------------------------------------------------
DG_SERVER_ID={target.server_id}
DG_SERVER_NAME={target.server_name}
DG_REGION={target.region}
DG_PUBLIC_HOST={target.public_host}
DG_PUBLIC_PORT={PORT}
DG_LISTEN_HOST=0.0.0.0
DG_LISTEN_PORT={PORT}

# --- TLS ----------------------------------------------------------------
# Самоподписанный сертификат: домена нет, адрес — голый IP. Клиент зашивает
# сертификат и сверяет его побайтово, поэтому перевыпуск без новой сборки
# клиента = потеря связи у всех, кто ещё не обновился.
DG_TLS_CERT={REMOTE_TLS}/cert.pem
DG_TLS_KEY={REMOTE_TLS}/key.pem
# Публичный сертификат (Let's Encrypt) для DNS-имён Web-клиентов.
# Подаётся только по SNI DNS-имени (см. tls_select.js); без него и по IP —
# прежний самоподписанный. Пусто — работает только legacy-режим.
DG_TLS_LE_CERT={REMOTE_TLS}/le-cert.pem
DG_TLS_LE_KEY={REMOTE_TLS}/le-key.pem

# --- кластер ------------------------------------------------------------
DG_CLUSTER_SECRET={secret}
DG_PEER_URLS={peers}
DG_GOSSIP_INTERVAL_MS=60000
DG_SERVER_TTL_MS=180000
DG_DATA_DIR={REMOTE_DATA}
DG_LOG_LEVEL=info
DG_DISCONNECT_GRACE_MS=90000
"""
    tmp = ROOT / ".deploy-server.env.tmp"
    tmp.write_text(body, encoding="utf-8")
    try:
        remote.put(tmp, REMOTE_ENV, 0o640)
    finally:
        tmp.unlink(missing_ok=True)
    remote.run(f"chown root:{SERVICE_USER} {REMOTE_ENV} && chmod 640 {REMOTE_ENV}")
    log(f"server.env записан, соседи: {peers or '(нет)'}")


def write_cert(remote: Remote, target: Target) -> None:
    """Готовит самоподписанный сертификат.

    Идемпотентность тут НЕ одинаковая, и это важно. ВЫПУСК сертификата
    идемпотентен намеренно: перевыпуск обрывает связь у всех, кто ещё не
    обновил клиент, и делать это по «деплою» нельзя. А права на каталог
    и файлы, наоборот, приводятся к нужным КАЖДЫЙ раз — они ничего не
    ломают у живых клиентов, зато чинят ровно ту беду, из-за которой
    сервер не стартует.

    Раньше всё это было за одним ранним выходом «сертификат уже есть», и
    сервер, чей ключ однажды выдали с правами 600, оставался сломанным
    навсегда: правильные права никто уже не выставлял.
    """
    ip = target.public_host
    code, _ = remote.quiet(f"test -s {REMOTE_TLS}/cert.pem")
    if code == 0:
        log("сертификат уже выпущен — не трогаю (перевыпуск оборвал бы связь)")
    else:
        remote.run(
            f"openssl req -x509 -nodes -newkey rsa:2048 -days 7300 "
            f"-keyout {REMOTE_TLS}/key.pem -out {REMOTE_TLS}/cert.pem "
            f"-subj '/CN={ip}' "
            f"-addext 'subjectAltName=IP:{ip}' "
            f"-addext 'basicConstraints=critical,CA:FALSE' "
            f"-addext 'keyUsage=critical,digitalSignature,keyEncipherment' "
            f"-addext 'extendedKeyUsage=serverAuth'",
            timeout=600,
        )

    # Каталог обязан принадлежать root:группа-службы и быть 750, иначе
    # пользователь службы в него не войдёт даже с правами на сам файл.
    # 640 на ключе, а не 600: 600 в chown на группу не даёт группе
    # ровно ничего, и node падает с EACCES. Читать ключ обязан тот, кто
    # его читает, — пользователь службы.
    remote.run(f"chown root:{SERVICE_USER} {REMOTE_TLS}")
    remote.run(f"chmod 750 {REMOTE_TLS}")
    remote.run(f"chown root:{SERVICE_USER} {REMOTE_TLS}/key.pem {REMOTE_TLS}/cert.pem")
    remote.run(f"chmod 640 {REMOTE_TLS}/key.pem && chmod 644 {REMOTE_TLS}/cert.pem")

    # Проверяем выпущенное, а не написанное: openssl принимает
    # subjectAltName=IP:1.2.3.4 и для чужого адреса, а клиент — нет.
    code, out = remote.quiet(
        f"openssl verify -CAfile {REMOTE_TLS}/cert.pem -verify_ip {ip} {REMOTE_TLS}/cert.pem")
    if code != 0:
        die(f"сертификат не проходит проверку для {ip}:\n{out}")

    # И последнее: читает ли ключ ТОТ, кто будет его читать. Права,
    # выставленные от root'а, выглядят правильно и при этом могут не
    # пускать пользователя службы — а узнать об этом можно только
    # попыткой прочитать от его имени. Ловим здесь, а не в журнале
    # systemd, где это выглядит как «сервер сломался» без причины.
    code, out = remote.quiet(
        f"sudo -u {SERVICE_USER} /opt/node/bin/node -e "
        + shlex.quote(f"require('fs').readFileSync('{REMOTE_TLS}/key.pem');"
                      f"require('fs').readFileSync('{REMOTE_TLS}/cert.pem');"
                      "console.log('readable')")
        + " 2>&1 || true")
    if "readable" not in out:
        die(f"пользователь службы {SERVICE_USER} не может прочитать ключ или "
            f"сертификат:\n{out}")
    log(f"сертификат для {ip} готов, проверен и читается службой")


def install_unit(remote: Remote) -> None:
    local = SERVER_DIR / "deploy" / "digital-game.service"
    if not local.exists():
        die(f"нет юнита {local}")
    text = local.read_text(encoding="utf-8")
    # В PATH systemd своего пользователя node нет, поэтому ExecStart
    # обязан указывать полный путь к /opt/node/bin/node.
    text = text.replace(
        "ExecStart=/usr/bin/node /opt/digital-game/src/index.js",
        f"ExecStart={NODE_DIR}/bin/node /opt/digital-game/src/index.js",
    )
    if "/usr/bin/node" in text:
        die("в ExecStart остался /usr/bin/node — юнит не будет стартовать")

    # ProtectSystem=strict делает всю ФС доступной только для чтения,
    # кроме перечисленных в ReadWritePaths каталогов. Забытый там
    # /var/lib/digital-game означает, что SQLite не сможет создать файл
    # базы, и сертив упадёт при старте с «unable to open database file».
    # Ловим это здесь, до включения службы, а не по журналу systemd.
    strict = "ProtectSystem=strict" in text
    rw = [ln.split("=", 1)[1].strip()
          for ln in text.splitlines()
          if ln.strip().startswith("ReadWritePaths=")]
    rw_paths = " ".join(rw)
    if strict and REMOTE_DATA not in rw_paths:
        die(f"в юните ProtectSystem=strict, но {REMOTE_DATA} не попал в "
            f"ReadWritePaths (там: {rw_paths or 'ничего'}).\n"
            f"         Добавь строку ReadWritePaths={REMOTE_DATA} — иначе "
            f"SQLite не сможет создать файл базы.")

    tmp = ROOT / ".deploy-unit.tmp"
    tmp.write_text(text, encoding="utf-8")
    try:
        remote.put(tmp, REMOTE_UNIT, 0o644)
    finally:
        tmp.unlink(missing_ok=True)

    # systemd НЕ ругается на неизвестный ключ всерьёз: пишет в журнал
    # «Unknown key name ... ignoring» и едет дальше. Из-за этого
    # ограничение числа попыток перезапуска однажды не работало, и
    # падающий сервер стартовал 35 раз подряд. Проверяем юнит ДО
    # включения — systemd-analyze verify ловит именно такие вещи.
    code, out = remote.quiet(
        f"systemd-analyze verify {REMOTE_UNIT} 2>&1 || true", timeout=180)
    bad = [ln.strip() for ln in out.splitlines()
           if "Unknown key" in ln or "unknown key" in ln
           or "Invalid" in ln or "error" in ln.lower()]
    if bad:
        die("юнит не проходит проверку systemd:\n        "
            + "\n        ".join(bad[:10]))
    log("юнит проходит systemd-analyze verify")

    remote.run(
        f"systemctl daemon-reload && systemctl enable {SERVICE} && "
        f"systemctl restart {SERVICE}",
        timeout=600,
    )


# ------------------------------------------------------------- проверки

def wait_ready(remote: Remote, target: Target, seconds: int = 90) -> None:
    """Ждёт, пока сервер ответит на настоящее WebSocket-рукопожатие.

    Проверяем ровно тем, чем пользуется игрок, а не «порт открыт»: порт
    может слушать и мёртвый процесс, а игра идёт по TLS + WebSocket.
    """
    # Тело скрипта — обычная строка с %s, а не f-строка: в коде на JS
    # полно фигурных скобок, и f-строка пытается подставить в них
    # выражения Python, падая на месте вхождения первого же «{}».
    js = """
const WebSocket = require('ws');
const w = new WebSocket('wss://127.0.0.1:%d', { rejectUnauthorized: false });
const fail = (why) => { console.log('FAIL ' + why); process.exit(1); };
const timer = setTimeout(() => fail('timeout'), 5000);
w.on('open', () => w.send(JSON.stringify({ t: 'ping' })));
w.on('message', (d) => {
  const m = JSON.parse(d.toString());
  if (m.t === 'hello') console.log('hello server=' + m.server.id);
  else if (m.t === 'pong') { clearTimeout(timer); console.log('pong'); process.exit(0); }
});
w.on('error', (e) => fail(e.message));
""" % PORT
    probe = (
        f"cd {REMOTE_APP} && PATH={NODE_DIR}/bin:$PATH {NODE_DIR}/bin/node -e "
        + shlex.quote(js)
    )
    deadline = time.time() + seconds
    why = "неизвестно"
    while time.time() < deadline:
        code, out = remote.quiet("systemctl is-active " + SERVICE)
        if out.strip() != "active":
            why = f"служба {out.strip()}"
        else:
            code, out = remote.quiet(probe, timeout=60)
            tail = out.strip().splitlines()[-1] if out.strip() else "(пусто)"
            if code == 0 and "pong" in tail:
                log(f"сервер отвечает ({tail})")
                return
            why = f"рукопожатие: {tail}"
        time.sleep(4)
    code, journal = remote.quiet(f"journalctl -u {SERVICE} -n 40 --no-pager")
    die(f"{target.public_host}: сервер не поднялся за {seconds}с ({why})\n"
        f"--- журнал ---\n{journal}")


def report_status(remote: Remote) -> None:
    code, out = remote.quiet(
        f"systemctl is-active {SERVICE}; "
        f"systemctl show {SERVICE} -p MemoryCurrent -p NRestarts; "
        f"ss -ltn 'sport = :{PORT}' | tail -n +2")
    for line in out.strip().splitlines():
        if line.strip():
            print(f"     | {line}")


def port_open(host: str, port: int = PORT, timeout: float = 8.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


# ------------------------------------------------- сертификаты в клиент

def fetch_certs(targets: list[Target], force: bool = False) -> None:
    """Кладёт сертификаты серверов в res://certs/.

    Имя файла — адрес с точками вместо дефисов, как их ищет Certs._load.
    Расширение .crt, а не .pem: только .crt движок Godot считает ресурсом,
    он проходит через импорт и потому гарантированно попадает внутрь PCK
    собранной игры. .pem в сборку не уезжает, и клиент уехал бы без
    сертификатов — молча, потому что связь с обоими серверами просто
    не устанавливалась бы. Содержимое при этом остаётся PEM-текстом:
    такой файл X509Certificate тоже разбирает.

    Проверяем, что сертификат выдан ИМЕННО для этого адреса: ошибка здесь
    дала бы клиент, который не подключается ни к одному серверу, и
    выглядела бы как «сервер не отвечает».
    """
    CERTS_DIR.mkdir(exist_ok=True)
    for t in targets:
        step(f"сертификат {t.public_host}")
        tmp = CERTS_DIR / f".tmp-{t.key}.crt"
        r = Remote(t)
        try:
            r.get(f"{REMOTE_TLS}/cert.pem", tmp)
        except FileNotFoundError:
            die(f"на {t.public_host} нет {REMOTE_TLS}/cert.pem — сервер там "
                f"ещё не разворачивался. Сначала python server/deploy/deploy.py {t.key.lower()}")
        except Exception as e:  # noqa: BLE001
            die(f"не удалось забрать сертификат с {t.public_host}: {e}")
        finally:
            r.close()
        text = tmp.read_text(encoding="utf-8", errors="replace")
        if "BEGIN CERTIFICATE" not in text:
            tmp.unlink(missing_ok=True)
            die(f"{t.public_host}: пришёл не сертификат — деплой не доведён до конца")
        dst = CERTS_DIR / f"{t.public_host.replace('.', '-')}.crt"
        if dst.exists() and not force and dst.read_text(encoding="utf-8") == text:
            log(f"{dst.name} уже совпадает — не трогаю")
        else:
            dst.write_text(text, encoding="utf-8", newline="\n")
            log(f"положил {dst.name}")
        # Старый .pem, если он остался от прежних запусков, убираем: он бы
        # перебивал выбор в Certs._load и завёл бы в заблуждение того, кто
        # будет читать репозиторий.
        stale = CERTS_DIR / f"{t.public_host.replace('.', '-')}.pem"
        if stale.exists():
            stale.unlink()
            log(f"убрал устаревший {stale.name}")
        tmp.unlink(missing_ok=True)


# ------------------------------------------------------------- внешняя проверка

def run_deploy_check(targets: list[Target]) -> None:
    """Прогоняет server/tools/deploy_check.js по живым серверам.

    Отдельный инструмент, а не код здесь: ту же проверку должен уметь
    запустить и человек без Python, и CI, и она проверяет протокол так же,
    как это делает клиент.
    """
    import subprocess
    tool = SERVER_DIR / "tools" / "deploy_check.js"
    if not tool.exists():
        die(f"нет {tool}")
    args = ["node", str(tool)]
    for t in targets:
        args += ["--server", f"{t.server_id}={t.public_host}:{PORT}"]
    log("запускаю deploy_check.js …")
    proc = subprocess.run(args, cwd=str(ROOT))
    if proc.returncode != 0:
        die("проверка кластера не прошла — смотрите вывод выше")


# -------------------------------------------------------------------- main

def deploy(target: Target, secret: str) -> None:
    step(f"{target.key}: {target.public_host} ({target.server_id})")
    r = Remote(target)
    try:
        log("готовлю систему")
        install_packages(r)
        install_node(r)
        make_user(r)
        log("заливаю код")
        n = upload_app(r)
        log(f"залито файлов: {n}")
        log("ставлю зависимости")
        npm_install(r)
        log("пишу конфигурацию")
        write_env(r, target, secret)
        log("выпускаю сертификат")
        write_cert(r, target)
        log("включаю службу")
        install_unit(r)
        wait_ready(r, target)
        log("память и перезапуски")
        report_status(r)
    finally:
        r.close()


def main() -> int:
    # Консоль Windows по умолчанию cp1251/cp866 и не умеет ни «→», который
    # печатает systemctl при enable, ни русские буквы в именах полей. Без
    # этого деплой падает ПОСЛЕ успешной установки — на ровном месте,
    # уже с работающим сервисом. Ошибки заменяем на «?», а не роняем:
    # потеря одной строки вывода лучше, чем прерванный деплой.
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass  # поток подменён тестом или не поддерживает reconfigure

    ap = argparse.ArgumentParser(description="деплой игрового сервера")
    ap.add_argument("which", nargs="?", default="both", choices=["both", "ru", "lv"])
    ap.add_argument("--certs-only", action="store_true", help="только забрать сертификаты в клиент")
    ap.add_argument("--status", action="store_true", help="ничего не ставить, только проверить")
    ap.add_argument("--check", action="store_true", help="только проверить кластер")
    ap.add_argument("--force", action="store_true", help="перезаписать сертификаты в клиенте")
    args = ap.parse_args()

    env = load_env()
    all_targets = build_targets(env)
    # Сравниваем без учёта регистра: argparse принимает «ru»/«lv», а
    # в Target ключи заглавными. Раньше выбор молча отбирал ПУСТОЙ список,
    # скрипт радостно ничего не ставил и уходил за сертификатами.
    want = args.which.lower()
    targets = all_targets if want == "both" else [
        t for t in all_targets if t.key.lower() == want
    ]
    if not targets:
        die(f"выбрано {args.which!r}, но такого сервера нет. Доступны: "
            + ", ".join(t.key for t in all_targets))
    secret = env.get("DG_CLUSTER_SECRET", "")

    if args.status:
        for t in all_targets:
            step(f"{t.public_host}")
            r = Remote(t)
            try:
                report_status(r)
                log(f"порт {PORT} снаружи: {'отвечает' if port_open(t.public_host) else 'ЗАКРЫТ'}")
            finally:
                r.close()
        return 0

    if args.certs_only:
        fetch_certs(all_targets, args.force)
        return 0

    if args.check:
        run_deploy_check(all_targets)
        return 0

    if not secret or secret.startswith("ЗАМЕНИТЬ"):
        die("в .env нет нормального DG_CLUSTER_SECRET. Сгенерировать:\n"
            "  node -e \"console.log(require('crypto').randomBytes(32).toString('base64url'))\"")

    for t in targets:
        deploy(t, secret)

    # Сертификаты забираем только у тех, кого сейчас поставили: остальные
    # либо уже в репозитории, либо ещё не развёрнуты, и требовать от них
    # файла при неполном деплое бессмысленно.
    step("сертификаты в клиент")
    fetch_certs(targets, force=True)

    if want != "both":
        print(f"\nГотово: {', '.join(t.key for t in targets)} развёрнут(ы). "
              "Проверка кластера имеет смысл только когда подняты оба:\n"
              "  python server/deploy/deploy.py --check")
        return 0

    step("проверка кластера")
    for t in all_targets:
        if not port_open(t.public_host):
            die(f"{t.public_host}: порт {PORT} не отвечает снаружи — проверьте firewall")
        log(f"{t.public_host}: порт {PORT} снаружи отвечает")
    run_deploy_check(all_targets)

    print("\nГОТОВО.")
    print("  · оба сервера работают и видят друг друга;")
    print("  · аккаунты и сессии реплицируются между ними;")
    print("  · сертификаты лежат в res://certs/ — закоммить их и собери клиент.")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        print(f"\nОШИБКА: {e}", file=sys.stderr, flush=True)
        sys.exit(1)
