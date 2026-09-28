#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Одноразовая разведка серверов перед деплоем. Ничего не меняет."""
import sys, pathlib
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import deploy

env = deploy.load_env()
targets = deploy.build_targets(env)
CMDS = [
    ("os", ". /etc/os-release && echo $PRETTY_NAME"),
    ("arch", "uname -m"),
    ("node", "command -v node || echo none"),
    ("port 6767", "ss -ltn 'sport = :6767' | tail -n +2 | wc -l"),
    ("mem", "free -m | head -2"),
    ("swap", "swapon --show | tail -n +2 | wc -l"),
    ("disk /", "df -h / | tail -1"),
    ("443 listeners", "ss -ltn 'sport = :443' | tail -n +2 | wc -l"),
    ("our user", "id -p digital-game || echo none"),
    ("our app", "ls -d /opt/digital-game 2>/dev/null || echo none"),
    ("openssl", "openssl version 2>/dev/null || echo none"),
    ("xz", "command -v xz || echo none"),
]
for t in targets:
    print(f"\n================ {t}")
    r = deploy.Remote(t)
    try:
        for name, cmd in CMDS:
            code, out = r.quiet(cmd, timeout=90)
            one = " | ".join(x.strip() for x in out.strip().splitlines() if x.strip())
            print(f"  {name:12} {one}")
    finally:
        r.close()
