class_name Certs
extends RefCounted
const Lang := preload("res://scripts/core/lang.gd")

# Сертификаты серверов, зашитые прямо в клиент.
#
# Доменов нет — адреса серверов это голые IP, а публичного CA для них не
# существует. Обычный клиент в такой ситуации либо отключает проверку
# («accept_invalid_certs»), либо требует сертификат, выпущенный для
# конкретного имени.
#
# Здесь третий путь, самый строгий: клиент знает сертификат каждого
# сервера заранее и требует, чтобы сервер предъявил ИМЕННО ЕГО. Подменить
# сервер посередине нельзя, а «отключить проверку» в коде негде.
#
# Файлы лежат в res://certs/ и попадают в сборку. Кладёт их туда
# server/deploy/deploy.py (или fetch-certs.sh), который забирает их с живых
# серверов. Расширение — .crt, и это не украшение: только .crt движок
# считает ресурсом, он проходит через импорт и потому гарантированно
# оказывается внутри PCK собранной игры. Файл .pem в сборку сам не
# попадает, и без include-фильтра в пресете экспорта клиент уедет без
# сертификатов и молча не сможет подключиться.
# ПЕРЕВЫПУСК сертификата на сервере без обновления клиента = потеря связи
# с ним у всех, кто ещё не обновился. Поэтому файлы коммитятся и меняются
# только вместе с клиентом.

const DIR := "res://certs/"

## Расширения в порядке предпочтения. .crt — родной для движка,
## .pem принимается на случай, если в репозитории остались старые файлы.
const EXTS: Array[String] = [".crt", ".pem"]

static var _cache := {}

## Голый IPv4-адрес (ему нужен зашитый сертификат) против DNS-имени
## (ему хватает системного корня — браузерного или ОС).
static func is_ip_host(host: String) -> bool:
	var parts := String(host).strip_edges().split(".")
	if parts.size() != 4:
		return false
	for part in parts:
		if part.is_empty() or not part.is_valid_int():
			return false
		var n := int(part)
		if n < 0 or n > 255:
			return false
	return true

## Сертификат сервера либо null, если его нет в сборке.
static func find(server_id: String, host: String) -> X509Certificate:
	var key := "%s|%s" % [server_id, host]
	if not _cache.has(key):
		_cache[key] = _load(server_id, host)
	return _cache[key]

static func _load(server_id: String, host: String) -> X509Certificate:
	# Ищем по id сервера, а если не нашли — по адресу: id может отличаться
	# от имени файла, а адрес у сервера один.
	var names := PackedStringArray()
	if not server_id.is_empty():
		names.append(server_id)
	if not host.is_empty():
		names.append(host.replace(".", "-"))
	for name in names:
		for ext in EXTS:
			var path := DIR + name + ext
			if not FileAccess.file_exists(path):
				continue
			var cert := _read(path, ext)
			if cert != null:
				return cert
	push_error(Lang.t("сертификат сервера %s не найден в %s — связь с ним будет отвергнута")
		% [server_id, DIR])
	return null

## Читает сертификат, СПОСОБОМ, КОТОРЫЙ СООТВЕТСТВУЕТ расширению.
##
## Способа тут принципиально разные, и путать их дорого. Для .crt путь
## один: ResourceLoader — файл родной, импортирован и лежит в PCK.
## Для .pem путь другой: расширения движок ресурсом НЕ считает
## (ResourceLoader.exists() == false), load() по нему печатает
## «No loader found for resource» и возвращает null, и читать файл надо
## руками через FileAccess + load_from_string(). Раньше здесь стоял
## load() для обоих расширений, из-за чего каждый запуск клиента
## засорялся ошибкой про .pem, а в собранной игре файл всё равно не
## находился. Копировать в user:// и грузить оттуда тоже не нужно:
## load_from_string() разбирает PEM прямо из памяти.
static func _read(path: String, ext: String) -> X509Certificate:
	if ext == ".crt":
		var res = ResourceLoader.load(path)
		if res is X509Certificate:
			return res
		# Импорта ещё не было (свежий клон, движок запустили без --import).
		# Содержимое всё равно PEM, поэтому ниже разберём его как текст.
	var text := FileAccess.get_file_as_string(path)
	if text.strip_edges().is_empty():
		return null
	var cert := X509Certificate.new()
	if cert.load_from_string(text) != OK:
		return null
	return cert

## Готовые опции TLS для подключения к серверу.
##
## common_name_override обязателен: в сертификате адрес записан как CN и
## как subjectAltName типа IP, а часть сборок Godot сверяет только CN.
## Пустое имя приводит к расхождению на ровно месте, где всё остальное
## уже проверено, поэтому говорим движку, какое имя считать верным.
static func tls_options_for(entry: Dictionary) -> TLSOptions:
	var id := String(entry.get("id", ""))
	var host := String(entry.get("host", ""))
	# DNS-имя сверяет системный корень (браузерный или ОС) — зашитый
	# сертификат не нужен, и искать его не надо: иначе каждый коннект
	# в Web-журнал падала бы ложная ошибка «сертификат не найден».
	if not is_ip_host(host):
		return TLSOptions.client(null, host)
	var cert := find(id, host)
	if cert == null:
		# Зашитого сертификата нет — проверять будет нечем, и самоподписанный
		# сертификат сервера не пройдёт проверку по системному корню.
		# Связь с этим сервером просто не установится: это правильный отказ,
		# а не пропуск проверки. Так клиент, у которого забыли положить
		# сертификаты, честно молчит вместо того, чтобы работать по открытой
		# сети.
		return TLSOptions.client(null, host)
	return TLSOptions.client(cert, host)

## Диагностика для меню: id серверов без сертификата.
static func missing_in(list: Array) -> PackedStringArray:
	var out := PackedStringArray()
	for raw in list:
		if not (raw is Dictionary):
			continue
		var entry: Dictionary = raw
		var host := String(entry.get("host", ""))
		# DNS-имена сверяются системным корнем — зашитый сертификат им
		# не нужен и никогда не понадобится, в отчёт не попадают.
		if not is_ip_host(host):
			continue
		if find(String(entry.get("id", "")), host) == null:
			out.append(String(entry.get("id", "")))
	return out
