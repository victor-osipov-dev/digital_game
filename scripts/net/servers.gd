class_name Servers
extends Node
const Lang := preload("res://scripts/core/lang.gd")

# Список игровых серверов.
#
# Список ЗАШИТ в клиент, и по требованиянию сразу записывается на диск:
# единственный источник правды для остального кода — файл, а не литерал
# в исходнике. Так его можно поправить на месте, не пересобирая игру.
#
# Зашитый список при этом не мёртвый код: при старте он СЛИВАЕТСЯ с файлом
# по id сервера. Поэтому и обновление клиента (добавили сервер, сменили
# адрес) доедет до игроков, и ручная правка файла не потеряется.

const PATH := "user://servers.json"
const PROBE_TIMEOUT_MS := 2500
const PROBE_TTL_S := 30.0
# Запрос списка комнат: вход на сервере плюс сам запрос. Один RTT на
# сервер, поэтому запас берём с запасом — но не настолько, чтобы пустой
# список серверов висел на экране.
const ROOMS_TIMEOUT_MS := 4000

# Фазы разговора за список комнат (автомат в _rooms_step).
const PH_SEND_RESUME := 0
const PH_WAIT_AUTH := 1
const PH_WAIT_LIST := 2

# Зашитый эталон. Адрес — голый IP: домена у машин нет, и клиент шлёт
# WSS напрямую на этот адрес и порт. Web-сборке IP не годятся (браузер
# не прощает самоподписанные сертификаты), поэтому у неё свой эталон —
# те же серверы по DNS-именам с публичными сертификатами.
const BUILTIN_IP := [
	{
		"id": "srv-ru",
		"name": "Россия",
		"region": "ru",
		"host": "85.209.2.116",
		"port": 6767,
	},
	{
		"id": "srv-lv",
		"name": "Латвия",
		"region": "lv",
		"host": "31.56.196.114",
		"port": 6767,
	},
]
const BUILTIN_WEB := [
	{
		"id": "srv-ru",
		"name": "Россия",
		"region": "ru",
		"host": "rudigitalgame.fimdi.ru",
		"port": 6767,
	},
	{
		"id": "srv-lv",
		"name": "Латвия",
		"region": "lv",
		"host": "lvdigitalgame.fimdi.ru",
		"port": 6767,
	},
]


var _entries: Array = []
var _loaded := false
# id -> {online, ms, reason, checked_at}
var _health := {}
var _probing := false


## Эталон под платформу: параметр — ради тестов без браузера.
static func builtin_for(is_web: bool) -> Array:
	return BUILTIN_WEB if is_web else BUILTIN_IP


## Эталон текущей сборки.
static func builtin() -> Array:
	return builtin_for(OS.has_feature("web"))


func _ready() -> void:
	load_list()


# ------------------------------------------------------------- список

## Загружает список с диска, сливает с зашитым и перезаписывает файл.
func load_list() -> Array:
	if _loaded:
		return _entries
	var stored := _read_file()
	_entries = _merge(builtin(), stored)
	_save(_entries)
	_loaded = true
	return _entries

func all() -> Array:
	load_list()
	return _entries

func count() -> int:
	return all().size()

func by_id(id: String) -> Dictionary:
	for entry in all():
		if String(entry.get("id", "")) == id:
			return entry
	return {}

func first() -> Dictionary:
	var list := all()
	return list[0] if not list.is_empty() else {}

func url_of(entry: Dictionary) -> String:
	return "wss://%s:%d" % [String(entry.get("host", "")), int(entry.get("port", 6767))]

## Подпись сервера для интерфейса: «Россия (ru)». Имя идёт через
## словарь (встроенные имена — русские), своё название сервера при
## этом не портится: чего нет в словаре, показывается как есть.
func label_of(entry: Dictionary) -> String:
	var name := Lang.t(String(entry.get("name", "?")))
	var region := String(entry.get("region", ""))
	if region.is_empty():
		return name
	return "%s (%s)" % [name, region]


# ------------------------------------------------------- проверка живости

## Проверяет серверы и возвращает id -> {online, ms, reason}.
##
## Проверка идёт настоящим WebSocket с зашитым сертификатом: тот же путь,
## каким потом пойдёт игра. Проверять /health отдельно было бы обманом —
## «сервер отвечает» и «с сервером можно играть» не одно и то же.
##
## Результат кэшируется: список комнат нужен редко, а платить RTT всем
## серверам при каждом открытии меню незачем.
func probe(force := false) -> Dictionary:
	if _probing:
		# Проверка уже идёт (например, запущена open() и ещё не кончилась).
		# Отдать кэш сейчас — соврать «все сервера мертвы» на пустом кэше:
		# так и делал _load_rooms. Дожидаемся конца той же проверки.
		while _probing:
			await get_tree().process_frame
		return _health
	if not force and _fresh():
		return _health
	_probing = true
	var result := await _probe_all()
	_health = result
	_probing = false
	return _health

## Результат последней проверки: id -> сведения о сервере. Пусто, если
## проверки ещё не было. Отдельный метод, чтобы меню не лезло в поля.
func health() -> Dictionary:
	return _health


func health_of(entry: Dictionary) -> Dictionary:
	var id := String(entry.get("id", ""))
	var info: Dictionary = _health.get(id, {})
	if info.is_empty():
		return {
			"id": id,
			"name": String(entry.get("name", "?")),
			"region": String(entry.get("region", "")),
			"online": false,
			"ms": 0,
			"reason": Lang.t("не проверен"),
			"checked_at": 0.0,
		}
	return info

func _fresh() -> bool:
	if _health.is_empty():
		return false
	var any: Dictionary = _health.values()[0]
	return Time.get_unix_time_from_system() - float(any.get("checked_at", 0.0)) < PROBE_TTL_S

func _probe_all() -> Dictionary:
	var pending: Array = []
	var out := {}
	for entry in all():
		var id := String(entry.get("id", "?"))
		var peer := WebSocketPeer.new()
		# Запас на приветствие сервера; ответы покрупнее сюда не влезают,
		# но при проверке мы их и не читаем.
		peer.inbound_buffer_size = 64 * 1024
		peer.outbound_buffer_size = 64 * 1024
		var err := peer.connect_to_url(url_of(entry), Certs.tls_options_for(entry))
		if err != OK:
			out[id] = _mark(entry, false, 0, Lang.t("не удалось начать подключение"))
			continue
		pending.append({"peer": peer, "entry": entry, "started": Time.get_ticks_msec()})

	var deadline := Time.get_ticks_msec() + PROBE_TIMEOUT_MS
	while not pending.is_empty() and Time.get_ticks_msec() < deadline:
		var still := []
		for item in pending:
			var peer: WebSocketPeer = item["peer"]
			peer.poll()
			match peer.get_ready_state():
				WebSocketPeer.STATE_OPEN:
					if _took_hello(peer):
						var took := Time.get_ticks_msec() - int(item["started"])
						out[String(item["entry"].get("id", "?"))] = _mark(item["entry"], true, took, "")
						peer.close()
					else:
						# Соединение открыто, приветствия пока нет.
						still.append(item)
				WebSocketPeer.STATE_CLOSED:
					out[String(item["entry"].get("id", "?"))] = _mark(
						item["entry"], false, Time.get_ticks_msec() - int(item["started"]),
						_close_reason(peer))
				_:
					still.append(item)
		pending = still
		if pending.is_empty():
			break
		await get_tree().process_frame

	# Не ответили за отведённое время — считаем мёртвыми.
	for item in pending:
		var peer: WebSocketPeer = item["peer"]
		peer.close()
		out[String(item["entry"].get("id", "?"))] = _mark(
			item["entry"], false, Time.get_ticks_msec() - int(item["started"]), Lang.t("не ответил"))
	return out

## Читает приветствие сервера. true, если оно пришло.
func _took_hello(peer: WebSocketPeer) -> bool:
	while peer.get_available_packet_count() > 0:
		var parsed = NetProtocol.parse(peer.get_packet().get_string_from_utf8())
		if parsed is Dictionary and String(parsed.get("t", "")) == NetProtocol.HELLO:
			return true
	return false

## Человеческое объяснение кода закрытия. 1006 — соединение оборвалось
## на уровне TLS или вообще не было установлено; так выглядит и
## неверный сертификат, и неоткрытый порт, и сервер за фаерволом.
func _close_reason(peer: WebSocketPeer) -> String:
	var code := peer.get_close_code()
	if code == 1006 or code == 0:
		return Lang.t("соединение не установлено")
	return Lang.t("отказал сервер (код %d)") % code

func _mark(entry: Dictionary, online: bool, ms: int, reason: String) -> Dictionary:
	return {
		"id": String(entry.get("id", "?")),
		"name": String(entry.get("name", "?")),
		"region": String(entry.get("region", "")),
		"online": online,
		"ms": ms,
		"reason": reason,
		"checked_at": Time.get_unix_time_from_system(),
	}


# ------------------------------------------------------- список комнат

## Собирает список комнат со ВСЕХ серверов разом.
##
## Основное соединение у клиента одно, и оно смотрит только на свой сервер.
## Но игрок ищет соперника, а не «соперника на той же машине»: список должен
## быть общим. Поэтому каждому серверу открывается отдельная короткая
## связь, отправляется rooms.list, и связь закрывается.
##
## Даже к серверу, к которому мы уже подключены, идём отдельной связью.
## Иначе пришлось бы смешивать два разных момента времени — свой ответ и
## чужой, — и список мигал бы при обновлении. Лишнее рукопожатие (~50 мс)
## того не стоит.
##
## Запрос ДВУХШАГОВЫЙ: сервер отдаёт rooms.list только вошедшим, поэтому
## сначала lobby.open, потом — и только после ответа на вход — rooms.list.
##
## Вход именно наблюдательский (lobby.open), а не обычный. Разница не в
## удобстве, а в том, что обычный вход ПЕРЕХВАТЫВАЕТ сокет игрока: сервер
## считает, что игрок вернулся на нашу короткую связь, забывает про его
## настоящее соединение, и при её закрытии выбивает его из комнаты. Если в
## комнате остаётся один игрок, сервер удаляет её. То есть простое
## открытие списка комнат стоило игроку его комнаты.
##
## token — сессионный токен. Сессия общая для всего кластера, поэтому
## токен, выданный на одном сервере, подходит любому другому.
##
## Возвращает плоский список, где у каждой комнаты добавлены server/serverName
## и failedServers — подсказка, что часть списка недоступна.
func list_rooms(token: String) -> Dictionary:
	var jobs: Array = []
	var skipped: Array = []
	for entry in all():
		var id := String(entry.get("id", "?"))
		if not bool(health_of(entry).get("online", false)):
			# Заведомо мёртвый сервер не опрашиваем: ждать его ответа
			# бессмысленно, и список комнат просто задержится.
			continue
		if token.is_empty():
			# Без сессии сервер список всё равно не отдаст. Помечаем сервер
			# недоступным, а НЕ возвращаем «0 комнат»: молчаливая пустота
			# выглядит как «никто не играет» и вводит в заблуждение.
			skipped.append(id)
			continue
		var peer := WebSocketPeer.new()
		# Комнат может быть много, а ответ с токеном и списком не влезает
		# в 64 КБ. Список на дисплее всё равно не покажем целиком.
		peer.inbound_buffer_size = 1024 * 1024
		peer.outbound_buffer_size = 64 * 1024
		if peer.connect_to_url(url_of(entry), Certs.tls_options_for(entry)) != OK:
			skipped.append(id)
			continue
		# Запросы уходят из цикла опроса, а не отсюда: connect_to_url
		# возвращается немедленно, сокет открывается позже, и send_text
		# в ещё не открытый канал молча уходит в никуда.
		jobs.append({"peer": peer, "entry": entry, "id": id, "token": token,
			"rooms": null, "phase": PH_SEND_RESUME})

	if jobs.is_empty():
		return {"rooms": [], "failedServers": skipped}

	var started := jobs.duplicate()
	var deadline := Time.get_ticks_msec() + ROOMS_TIMEOUT_MS
	while not jobs.is_empty() and Time.get_ticks_msec() < deadline:
		var still: Array = []
		for job in jobs:
			var peer: WebSocketPeer = job["peer"]
			peer.poll()
			match peer.get_ready_state():
				WebSocketPeer.STATE_OPEN:
					if not _rooms_step(peer, job):
						still.append(job)
				WebSocketPeer.STATE_CLOSED:
					peer.close()
				_:
					still.append(job)
		jobs = still
		if jobs.is_empty():
			break
		await get_tree().process_frame

	# Не ответившие считаем неудачными: молча выкидывать их нельзя, игрок
	# увидел бы неполный список и решил, что комнат нигде нет.
	# skipped — те, до кого даже не дошли; у них причины нет, но в
	# failedServers они тоже обязаны быть.
	for job in jobs:
		(job["peer"] as WebSocketPeer).close()

	var rooms: Array = []
	var failed: Array = skipped.duplicate()
	for job in started:
		var entry: Dictionary = job["entry"]
		var id := String(entry.get("id", "?"))
		if job["rooms"] == null:
			failed.append(id)
			continue
		for raw in job["rooms"]:
			if not (raw is Dictionary):
				continue
			var room: Dictionary = (raw as Dictionary).duplicate()
			room["server"] = id
			room["serverName"] = label_of(entry)
			rooms.append(room)
	return {"rooms": rooms, "failedServers": failed}


## Один шаг разговора с сервером. true — работа с ним закончена.
##
## Разговор двухшаговый, и порядок шагов жёсткий:
##   1) lobby.open — вход только на чтение; сервер отдаёт rooms.list
##      лишь вошедшим, но обычный вход тут недопустим (см. list_rooms);
##   2) ждём ответ на вход;
##   3) rooms.list — с rid, по которому узнаём именно свой ответ.
##
## auth.err на шаге 2 — не повод прекращать разговор: всё равно спрашиваем
## список, чтобы сервер сам сказал «войдите» или «пусто». Иначе мы повиснем
## до таймаута и не отличим отказ от молчания.
func _rooms_step(peer: WebSocketPeer, job: Dictionary) -> bool:
	match int(job["phase"]):
		PH_SEND_RESUME:
			# Именно lobby.open, а НЕ auth.resume. Обычный вход перехватывает
			# сокет игрока: сервер считает, что игрок вернулся на этот сокет,
			# теряет связь с его настоящим соединением, и когда эта короткая
			# связь закрывается — выбивает его из комнаты, а комнату с одним
			# игроком удаляет. Список комнат не должен стоить игроку комнаты.
			_send(peer, {
				"t": NetProtocol.LOBBY_OPEN,
				"token": String(job["token"]),
				NetProtocol.RID_FIELD: "auth-%s" % job["id"],
			})
			job["phase"] = PH_WAIT_AUTH
			return false
		PH_WAIT_AUTH:
			for m in _drain(peer):
				var t := String(m.get("t", ""))
				if t == NetProtocol.AUTH_OK or t == NetProtocol.AUTH_ERR:
					_send(peer, {
						"t": NetProtocol.ROOMS_LIST,
						NetProtocol.RID_FIELD: "rooms-%s" % job["id"],
					})
					job["phase"] = PH_WAIT_LIST
					return false
			return false
		PH_WAIT_LIST:
			for m in _drain(peer):
				if String(m.get("t", "")) == NetProtocol.ROOMS_LIST_S2C:
					job["rooms"] = m.get("rooms", [])
					return true
			return false
	return false


## Забирает из сокета всё, что накопилось. Мусор (не словари) отбрасывает.
## В потоке идёт приветствие сервера, потом ответ на вход, потом комнаты —
## поэтому вернуть «одно сообщение» нельзя, нужен весь остаток пачки.
func _drain(peer: WebSocketPeer) -> Array:
	var out: Array = []
	while peer.get_available_packet_count() > 0:
		var parsed: Variant = NetProtocol.parse(
			peer.get_packet().get_string_from_utf8())
		if parsed is Dictionary:
			out.append(parsed as Dictionary)
	return out

func _send(peer: WebSocketPeer, msg: Dictionary) -> void:
	peer.send_text(JSON.stringify(msg))


# ------------------------------------------------------------- выбор

## Живые серверы, быстрые первыми. Сортировка нужна не для красоты:
## списком комнат хочется открываться мгновенно, и для этого годится
## только самый отзывчивый.
func online_sorted() -> Array:
	var out := []
	for entry in all():
		var info := health_of(entry)
		if bool(info.get("online", false)):
			out.append({"entry": entry, "ms": int(info.get("ms", 0))})
	out.sort_custom(_faster)
	return out

func _faster(a: Dictionary, b: Dictionary) -> bool:
	return int(a["ms"]) < int(b["ms"])

func online_count() -> int:
	return online_sorted().size()

func any_online() -> bool:
	return online_count() > 0

## Сервер для СОЗДАНИЯ комнаты — случайный из живых.
##
## Именно случайный, а не самый быстрый: если всегда выбирать самый
## отзывчивый, комнаты скопятся на одной машине, и вторая будет пустать.
## Единственный критерий — сервер жив: на мёртвом создать нельзя.
func random_online() -> Dictionary:
	var alive := online_sorted()
	if alive.is_empty():
		return {}
	var rng := RandomNumberGenerator.new()
	rng.randomize()
	return alive[rng.randi_range(0, alive.size() - 1)]["entry"]

## Сервер для ЗАПРОСА списка комнат: самый быстрый живой.
func fastest_online() -> Dictionary:
	var alive := online_sorted()
	if alive.is_empty():
		return {}
	return alive[0]["entry"]

## Подсказка, когда живых серверов нет: с кем именно не вышло.
func offline_hint() -> String:
	var names := PackedStringArray()
	for entry in all():
		names.append(label_of(entry))
	if names.is_empty():
		return Lang.t("Список серверов пуст — игра собрана неправильно.")
	return Lang.t("Нет связи ни с одним сервером (%s).") % ", ".join(names)

## Названия живых — короткой строкой в заголовке.
func online_summary() -> String:
	var names := PackedStringArray()
	for item in online_sorted():
		names.append(label_of(item["entry"]))
	if names.is_empty():
		return Lang.t("нет связи")
	return Lang.t("%s онлайн") % ", ".join(names)


# ----------------------------------------------------------------- файл

## Сливает зашитый список с файлом. Поля зашитого побеждают: обновление
## клиента должно перекрывать ручную правку того же сервера. Записи,
## которых в зашитом нет, сохраняются — вдруг кто-то добавил свой.
func _merge(builtin: Array, stored: Array) -> Array:
	var out := []
	var seen := {}
	for entry in builtin:
		seen[String(entry.get("id", ""))] = true
		out.append(_clean(entry))
	for entry in stored:
		var id := String(entry.get("id", ""))
		if seen.has(id):
			continue
		var clean := _clean(entry)
		if not String(clean.get("host", "")).is_empty():
			out.append(clean)
	return out

## Убирает записи без адреса: битый файл не должен ломать вход в игру.
func _clean(entry: Dictionary) -> Dictionary:
	var host := String(entry.get("host", "")).strip_edges()
	return {
		"id": String(entry.get("id", host)),
		"name": String(entry.get("name", host)),
		"region": String(entry.get("region", "")),
		"host": host,
		"port": clampi(int(entry.get("port", 6767)), 1, 65535),
	}

func _read_file() -> Array:
	if not FileAccess.file_exists(PATH):
		return []
	var text := FileAccess.get_file_as_string(PATH)
	if text.strip_edges().is_empty():
		return []
	var parsed = JSON.parse_string(text)
	if not (parsed is Array):
		return []
	var out := []
	for raw in parsed as Array:
		if raw is Dictionary:
			out.append(_clean(raw))
	return out

## Пишем во временный файл и переименовываем: оборванная запись не
## должна остаться на месте рабочего файла.
func _save(list: Array) -> void:
	var tmp := PATH + ".tmp"
	var f := FileAccess.open(tmp, FileAccess.WRITE)
	if f == null:
		push_warning(Lang.t("не удалось записать %s: %s")
			% [PATH, error_string(FileAccess.get_open_error())])
		return
	f.store_string(JSON.stringify(list, "  "))
	f.close()
	var err := DirAccess.rename_absolute(tmp, PATH)
	if err != OK:
		# На Windows переименование поверх существующего файла может не
		# пройти — это не повод терять записанное.
		DirAccess.remove_absolute(PATH)
		err = DirAccess.rename_absolute(tmp, PATH)
		if err != OK:
			push_warning(Lang.t("не удалось сохранить %s: %s") % [PATH, error_string(err)])
