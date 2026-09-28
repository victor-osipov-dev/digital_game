#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Диагностика: почему сервер не видит свой сертификат."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import deploy

for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

env = deploy.load_env()
t = [x for x in deploy.build_targets(env) if x.key == "LV"][0]
r = deploy.Remote(t)
CMDS = [
    ("ls tls", "ls -la /etc/digital-game/tls/"),
    ("ls etc", "ls -la /etc/digital-game/"),
    ("namei", "namei -l /etc/digital-game/tls/cert.pem"),
    ("envfile tls", "grep -a TLS /etc/digital-game/server.env"),
    ("as service user", "sudo -u digital-game /opt/node/bin/node -e \""
                        "const fs=require('fs');"
                        "for (const p of ['/etc/digital-game/tls/cert.pem','/etc/digital-game/tls/key.pem']) "
                        "{ let why='ok'; try { fs.readFileSync(p); } catch(e) { why=e.code; } "
                        "console.log(p, fs.existsSync(p) ? 'exists' : 'MISSING', 'read:'+why); }\""),
    ("journal tls", "journalctl -u digital-game --no-pager | grep -ai -m5 'TLS\\|cert'"),
]
try:
    for name, cmd in CMDS:
        code, out = r.quiet(cmd, timeout=120)
        print(f"\n--- {name} (code {code})")
        for line in out.splitlines():
            if line.strip():
                print("   ", line)
finally:
    r.close()
