#!/bin/sh
# ==============================================================
#  Выпуск самоподписанного сертификата для игрового сервера.
#
#  Домена нет — адрес сервера это голый IP, поэтому в сертификат
#  обязателен subjectAltName с типом IPAddress. Без него клиент,
#  который проверяет имя, его отвергнет.
#
#  Клиент не хранит корневые сертификаты: он ЗАШИТЫВАЕТ сертификат
#  нужного сервера себе и проверяет, что предъявленный сервером
#  сертификат побайтово совпадает с зашитым. Поэтому сертификат
#  выпускается один раз и больше не перевыпускается: смена файла
#  означает, что старые клиенты перестанут подключаться.
#
#  Использование:  sh gen-cert.sh <ip-сервера> [каталог]
#  По умолчанию каталог — /etc/digital-game/tls
# ==============================================================

set -eu

IP="${1:?укажите IP-адрес сервера, например 85.209.2.116}"
DIR="${2:-/etc/digital-game/tls}"
DAYS=7300   # 20 лет: сертификат живёт дольше, чем сама игра

if [ ! -f "$DIR/cert.pem" ]; then
  mkdir -p "$DIR"
  chmod 750 "$DIR"

  # SAN нужен с IPAddress, а не с DNSName: адрес голый, резолвить нечего.
  # subjectAltName и basicConstraints=CA:FALSE — чтобы клиент, шитый
  # сертификатом как доверенным, не ругался на «сертификат не является CA».
  cat > "$DIR/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = ext
prompt = no

[dn]
CN = $IP

[ext]
basicConstraints = critical,CA:FALSE
keyUsage = critical,digitalSignature,keyEncipherment
extendedKeyUsage = serverAuth
subjectAltName = IP:$IP
EOF

  # RSA-2048, а не EC: клиент собран с mbedtls и RSA там понимается
  # везде, а рукопожатие случается один раз на подключение и неважно.
  openssl req -x509 -nodes \
    -newkey rsa:2048 \
    -days "$DAYS" \
    -keyout "$DIR/key.pem" \
    -out "$DIR/cert.pem" \
    -config "$DIR/openssl.cnf" 2>/dev/null

  chmod 600 "$DIR/key.pem"
  chmod 644 "$DIR/cert.pem"
  echo "выпущен сертификат для $IP, срок $DAYS дней"
else
  echo "сертификат для $IP уже есть, ничего не делаю"
  echo "ВАЖНО: перевыпуск сломает уже собранных клиентов."
  exit 0
fi

# Проверяем, что сертификат действительно годится для этого адреса.
openssl verify -CAfile "$DIR/cert.pem" -verify_ip "$IP" "$DIR/cert.pem"
echo
echo "Что дальше:"
echo "  1) отдать сертификат в клиент:"
echo "       sh server/deploy/fetch-certs.sh $IP"
echo "     он сам проверит, что сертификат выдан именно для $IP,"
echo "     и положит файл в res://certs/"
echo "  2) прописать в /etc/digital-game/server.env:"
echo "       DG_TLS_CERT=$DIR/cert.pem"
echo "       DG_TLS_KEY=$DIR/key.pem"
