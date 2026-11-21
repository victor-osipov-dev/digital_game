#!/bin/sh
# ==============================================================
#  Certbot deploy-hook: разложить свежие LE-сертификаты и
#  перезапустить игру.
#
#  Ставится один раз на каждый сервер:
#    install -m 750 -o root -g root le-renew-hook.sh \
#      /etc/letsencrypt/renewal-hooks/deploy/digital-game.sh
#
#  Срабатывает только при фактическом обновлении сертификата
#  (не при холостом `certbot renew`). Имя certbot-сертификата
#  обязано быть `digital-game` (см. --cert-name при выпуске).
# ==============================================================

set -eu

TLS_DIR="/etc/digital-game/tls"
LIVE="/etc/letsencrypt/live/digital-game"

cp "$LIVE/fullchain.pem" "$TLS_DIR/le-cert.pem"
cp "$LIVE/privkey.pem" "$TLS_DIR/le-key.pem"
chown root:digital-game "$TLS_DIR/le-cert.pem" "$TLS_DIR/le-key.pem"
chmod 644 "$TLS_DIR/le-cert.pem"
chmod 640 "$TLS_DIR/le-key.pem"
systemctl restart digital-game.service
