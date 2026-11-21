'use strict';

// Выбор TLS-контекста по SNI имени клиента.
//
// DNS-имя — публичный сертификат (Let's Encrypt) для Web-клиентов.
// Всё остальное — прежний самоподписанный: IP-литералы нативных клиентов
// (они пинят именно его) и пустое SNI старых клиентов. Старые клиенты
// продолжают работать без обновления — смена сертификата их не касается.

function isIpLiteral(name) {
  const parts = String(name || '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => p !== '' && /^\d+$/.test(p)
    && Number(p) >= 0 && Number(p) <= 255);
}

// 'le' — публичный контекст, 'legacy' — самоподписанный.
function selectTlsContext(servername) {
  const name = String(servername || '').toLowerCase();
  if (name !== '' && !isIpLiteral(name)) return 'le';
  return 'legacy';
}

module.exports = { isIpLiteral, selectTlsContext };
