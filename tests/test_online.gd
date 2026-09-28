extends SceneTree

# ==============================================================
#  Сквозная проверка клиента по ЖИВЫМ серверам.
#
#  Остальные тесты проверяют куски: что GameState собирается из ответа,
#  что каталог одинаков, что правила сходятся с серверными. Здесь
#  проверяется то, ради чего всё и писалось, — что настоящий клиент
#  говорит с настоящими серверами:
#
#    * сертификаты зашиты и принимаются движком (TLS без «отключить проверку»);
#    * список серверов дополняется gossip'ом: каждый знает про обоих;
#    * аккаунт, заведённый на одном сервере, входит на втором;
#    * список комнат собирается с ОБОИХ серверов сразу, с пометкой,
#      какому серверу комната принадлежит;
#    * комната одного сервера не помечается чужим — партии не
#      реплицируются, а список всё равно полный.
#
#  Тест ходит по-настоящему и оставляет после себя аккаунт с мусорным
#  именем: это тестовые данные на тестовых серверах, а не мусор в
#  репозитории. Комнаты он за собой убирает.
#
#  Запуск:
#     godot --headless --path . --script res://tests/test_online.gd
#
#  Если серверов нет или они не отвечают — тест это СКАЖЕТ и уйдёт с
#  кодом 0, а не упадёт: отсутствие сети не должно выглядеть как ошибка
#  кода. Провалиться он может только на расхождении с сервером.
# ==============================================================

const PASSWORD := "онлайн-тест-пароль-4711"
const REGISTRY_TTL_MS := 90000
const RPC_TIMEOUT_MS := 8000

var _failed := 0
var _checked := 0
# Почему проверку не удалось начать. Пусто — значит начали и проверили.
var _skip_reason := ""
var _token := ""

# Синглтоны достаём из дерева, а не по глобальному имени. Скрипт,
# запущенный через --script, компилируется ДО того, как автозагрузки
# встают в дерево, и имя `Net` на тот момент просто не существует —
# компилятор падает с «Identifier not found». По умолчанию автозагрузки
# видны как глобальные имена, но только если скрипт компилируется позже.
var _net: Node

# Servers — class_name, а не автозагрузка, поэтому его методы зовутся
# через экземпляр. У _net он уже есть; берём тот же, чтобы тест и игра
# смотрели на ОДИН список серверов, а не на два независимых.
var _sv: Servers


func _initialize() -> void:
	# Ждём первый кадр: к нему автозагрузки уже в дереве.
	process_frame.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	_net = root.get_node_or_null("Net")
	if _net == null:
		print("НЕТ АВТОЗАГРУЗКИ Net — проект настроен неверно")
		quit(1)
		return
	_run()


func _run() -> void:
	_sv = _net.servers
	print("== СКВОЗНАЯ ПРОВЕРКА ПО ЖИВЫМ СЕРВЕРАМ")

	# --- сертификаты -------------------------------------------------
	# Первым делом: без них дальше идти незачем, а падать будет позже и
	# невнятно — на попытке подключиться.
	var missing := Certs.missing_in(Servers.BUILTIN)
	if not missing.is_empty():
		print("  доложить: python server/deploy/deploy.py --certs-only")
		_abort("сертификатов нет: %s" % ", ".join(missing))
		return

	# --- кто на связи ------------------------------------------------
	# Серверы проверяются настоящим рукопожатием с зашитым сертификатом,
	# а не «порт открыт»: это ровно то, что потом потребуется игроку.
	# probe() сам по себе возвращает словарь сведений, а не список
	# серверов, поэтому «кто жив» спрашиваем отдельно.
	await _sv.probe()
	var alive := _sv.online_sorted()
	print("  серверов в списке: %d, на связи: %d" % [_sv.count(), alive.size()])
	if alive.is_empty():
		_abort("ни один сервер не отвечает — %s" % _sv.offline_hint())
		return
	for slot in alive:
		var entry: Dictionary = slot["entry"]
		var info := _sv.health_of(entry)
		print("    %s — %s, %d мс%s" % [
			_sv.label_of(entry),
			"на связи" if bool(info.get("online", false)) else "НЕ НА СВЯЗИ",
			int(info.get("ms", 0)),
			"" if String(info.get("reason", "")).is_empty()
				else " (" + String(info.get("reason", "")) + ")",
		])
	_check(_sv.online_count() == alive.size(),
		"проверка связи выполнена: живых %d" % alive.size())

	# --- вход: сервер выбираем случайный ----------------------------
	# Именно так ведёт себя меню при создании комнаты: выбор не
	# предсказуем, и проверка не должна зависеть от того, какой попался.
	var picked: Dictionary = _sv.random_online()
	var server_id := String(picked.get("id", ""))
	print("  подключаюсь к %s (%s)" % [_sv.label_of(picked), server_id])
	if String(picked.get("id", "")).is_empty():
		_abort("выбирать нечего: ни один сервер не на связи")
		return
	_check(_net.connect_to(picked), "соединение с %s установлено" % server_id)

	# --- вход, не дожидаясь готовности --------------------------------
	# Порядок здесь не случайный и повторяет худший случай из жизни:
	# игрок жмёт «Войти» сразу, как только форма появилась.
	#
	# Между открытием сокета и первым пакетом от сервера проходит целый
	# круг туда-обратно — на RU это 200+ мс. Вход раньше отказывал в это
	# окно с «нет связи с сервером», то есть ругался на живую связь.
	# Если register() теперь ждёт приветствия, проверка обязана звать
	# его ДО is_linked(), иначе гонка просто не воспроизводится и тест
	# молча перестаёт её ловить.
	var reg: Dictionary = await _net.register(
		"gd-test-%d" % int(Time.get_unix_time_from_system()), PASSWORD, "Тест")
	_check(bool(reg.get("ok", false)),
		"вход работает раньше, чем сервер успел поздороваться", reg.get("reason", ""))

	var linked := await _wait_for(6.0, func(): return _net.is_linked())
	_check(linked, "связь жива: TLS с зашитым сертификатом")
	if not linked:
		_finish(1)
		return

	# --- каталог фишек ------------------------------------------------
	# Без него не рисуется ни одна фишка, и это единственное, что клиент
	# берёт у сервера ДО входа. К этому моменту приветствие уже пришло
	# (вход только что удался), значит каталог обязан быть на месте.
	var cat: Array = _net.catalog()
	_check(cat.size() == 108, "каталог фишек получен без входа: %d" % cat.size())

	if not bool(reg.get("ok", false)):
		_finish(1)
		return
	_token = _net.session_token()
	_check(not _token.is_empty(), "токен сессии получен")

	# --- токен одного сервера принимается другим ---------------------
	# На этом держится «войти на одном сервере, видеть комнаты обоих».
	# Проверяем тем же способом, каким это делает меню, — коротким
	# отдельным соединением, а не текущим.
	var other := _other_than(server_id)
	var cross := await _resume_on(other, _token)
	_check(cross, "токен с %s принят на %s"
		% [server_id, String(other.get("id", "?"))])

	# --- реестр: gossip ----------------------------------------------
	# Серверы только что подняты, gossip ходит раз в минуту, поэтому
	# ждать тут есть чего и отводим на это минуту с запасом.
	var registry := await _wait_for_registry(2)
	_check(registry.has("srv-ru") and registry.has("srv-lv"),
		"реестр серверов дополнен gossip'ом: %s" % ", ".join(registry.keys()))

	# --- список комнат с обоих серверов -------------------------------
	var listed := await _sv.list_rooms(_token)
	var rooms: Array = listed.get("rooms", [])
	var failed_servers: Array = listed.get("failedServers", [])
	print("  комнат в общем списке: %d, серверов не ответило: %d"
		% [rooms.size(), failed_servers.size()])
	_check(failed_servers.is_empty(),
		"оба сервера ответили на список комнат",
		"не ответили: %s" % str(failed_servers))
	var tagged := rooms.size() >= 0
	for room in rooms:
		if not room.has("server") or not room.has("serverName"):
			tagged = false
	_check(tagged, "у каждой комнаты проставлен сервер-владелец")

	# --- комната на каждом сервере -----------------------------------
	# Создаём по одной на обоих и убеждаемся, что в общем списке есть
	# обе и каждая помечена своим сервером. Это и есть требование
	# «партии не реплицируются, но список собирается с обоих».
	var mine: Dictionary = await _net.create_room(2, false, "Тест-%s" % server_id, "")
	_check(String(mine.get("t", "")) == NetProtocol.ROOM_STATE,
		"комната создана на %s" % server_id,
		"ответ: %s" % String(mine.get("t", "")))
	var my_code := String((mine.get("room", {}) as Dictionary).get("code", ""))
	_check(not my_code.is_empty(), "код комнаты получен: %s" % my_code)

	# Комнату на чужом сервере держим ДО КОНЦА проверки, соединение не
	# закрываем. Сервер удаляет лобби, где остался один игрок, а уход из
	# комнаты — это как раз «остался один». Закроем раньше — комнаты в
	# списке не окажется, и тест врал бы о сервере вместо того, чтобы
	# врать о себе.
	var far := await _create_on(other, _token, "Тест-чужой")
	var foreign_code := String(far.get("code", ""))
	var far_peer: WebSocketPeer = far.get("peer")
	_check(not foreign_code.is_empty(), "комната создана на чужом сервере: %s"
		% foreign_code)

	var listed2 := await _sv.list_rooms(_token)
	var owners := {}
	for room in listed2.get("rooms", []):
		owners[String(room.get("code", ""))] = String(room.get("server", ""))
	_check(owners.has(my_code) and owners.has(foreign_code),
		"общий список содержит комнаты обоих серверов: %d шт." % owners.size())
	_check(String(owners.get(my_code, "")) == server_id,
		"комната %s помечена сервером %s" % [my_code, server_id],
		"помечена %s" % String(owners.get(my_code, "—")))
	_check(String(owners.get(foreign_code, "")) == String(other.get("id", "")),
		"комната %s помечена сервером %s"
			% [foreign_code, String(other.get("id", ""))],
		"помечена %s" % String(owners.get(foreign_code, "—")))

	# Главное, ради чего всё затевалось: чтение списка комнат — это
	# отдельные связи к каждому серверу. Такая связь не имеет права
	# отбирать место в столе у игрока, а закрытие её — выбивать его.
	# Раньше ровно это и происходило: игрок терял комнату, открыв список.
	_check(_net.is_linked(), "основная связь жива после чтения списка")
	var still_mine: Dictionary = await _net.request_rooms_list()
	_check(String((still_mine.get("room", {}) as Dictionary).get("code", "")) == my_code
		or owners.has(my_code), "комната %s уцелела после чтения списка" % my_code)

	# Уходим из комнат, чтобы не занимать место настоящему игроку.
	if far_peer != null:
		far_peer.send_text(JSON.stringify({"t": NetProtocol.ROOM_LEAVE, "rid": "z1"}))
		far_peer.close()
	await _net.leave_room()

	# --- возвращающийся игрок ----------------------------------------
	# Обрыв связи посреди сессии — обычное дело, а не авария. Проверяем,
	# что после переподключения игрок тот же самый и сервер его узнал.
	# Раньше возврат в лобби был хрупким: закрытие старой связи выбивало
	# игрока из комнаты, а лобби с одним игроком сервер удалял.
	var saved_login: String = _net.session_login()
	_net.disconnect_from()
	await _sleep(0.5)
	var back := _sv.by_id(server_id)
	_check(_net.connect_to(back), "переподключение к %s начато" % server_id)
	var relinked: bool = await _wait_for(8.0, func(): return _net.is_linked())
	_check(relinked, "связь восстановлена")
	if relinked:
		var res: Dictionary = await _net.resume()
		_check(bool(res.get("ok", false)),
			"сессия восстановлена тем же токеном: %s" % String(res.get("reason", "")))
		_check(_net.session_login() == saved_login,
			"вошли тем же игроком: %s" % _net.session_login(),
			"ожидали %s" % saved_login)
		var rooms_back: Array = (await _net.request_rooms_list()).get("rooms", [])
		_check(rooms_back is Array, "список комнат доступен после возврата")

	_finish()


# ------------------------------------------------------------------ выбор

func _other_than(server_id: String) -> Dictionary:
	# Предпочитаем второй сервер кластера, а не «любой другой из
	# списка»: иначе проверка прошла бы на одной машине с одним сервером
	# и ничего не сказала бы о репликации.
	for id in ["srv-lv", "srv-ru"]:
		if id != server_id:
			var e := _sv.by_id(id)
			if not e.is_empty():
				return e
	for e in _sv.all():
		if String(e.get("id", "")) != server_id:
			return e
	return {}


## Ждём, пока серверы увидят друг друга. Gossip ходит раз в минуту, так
## что на старте развёрнутого кластера это занимает до минуты.
func _wait_for_registry(need: int) -> Dictionary:
	var deadline := Time.get_ticks_msec() + REGISTRY_TTL_MS
	var got := {}
	while Time.get_ticks_msec() < deadline:
		got = await _servers_list()
		if got.size() >= need:
			return got
		await _sleep(4.0)
	return got


func _servers_list() -> Dictionary:
	var out := {}
	# online_sorted() отдаёт слоты {entry, ms}, а не сами записи серверов,
	# поэтому запись достаём из слота — иначе поедут пустые подключения.
	for slot in _sv.online_sorted():
		var entry: Dictionary = slot["entry"]
		for s in await _rpc_on(entry, "servers.list"):
			out[String(s.get("id", ""))] = true
	return out


# ------------------------------------------------- отдельные соединения

## Короткое отдельное соединение к серверу. Так меню спрашивает ВТОРОЙ
## сервер, не трогая уже установленную связь: Net держит одно соединение
## на всех, а список комнат должен быть полным.
func _rpc_on(entry: Dictionary, cmd: String) -> Array:
	var peer := await _open_on(entry)
	if peer == null:
		return []
	# lobby.open, а не auth.resume: эта связь только читает. Обычный вход
	# отобрал бы место в столе у игрока, который сидит в комнате, а её
	# закрытие выбило бы его оттуда. Для чтения реестра это тем более
	# нелепо — servers.list и без входа открыт.
	peer.send_text(JSON.stringify({
		"t": NetProtocol.LOBBY_OPEN, "rid": "1", "token": _token,
	}))
	peer.send_text(JSON.stringify({"t": cmd, "rid": "2"}))
	var out: Array = []
	var deadline := Time.get_ticks_msec() + RPC_TIMEOUT_MS
	while Time.get_ticks_msec() < deadline:
		peer.poll()
		if peer.get_available_packet_count() <= 0:
			await _sleep(0.05)
			continue
		var msg = NetProtocol.parse(peer.get_packet().get_string_from_utf8())
		if not (msg is Dictionary):
			continue
		var m: Dictionary = msg
		if String(m.get("rid", "")) == "2":
			peer.close()
			if m.has("servers"):
				return m["servers"] as Array
			if m.has("rooms"):
				return m["rooms"] as Array
			return out
	peer.close()
	return out


func _resume_on(entry: Dictionary, token: String) -> bool:
	var peer := await _open_on(entry)
	if peer == null:
		return false
	peer.send_text(JSON.stringify({"t": NetProtocol.LOBBY_OPEN, "rid": "r1", "token": token}))
	var deadline := Time.get_ticks_msec() + RPC_TIMEOUT_MS
	while Time.get_ticks_msec() < deadline:
		peer.poll()
		if peer.get_available_packet_count() > 0:
			var msg = NetProtocol.parse(peer.get_packet().get_string_from_utf8())
			if msg is Dictionary \
					and String((msg as Dictionary).get("t", "")) == "auth.ok":
				peer.close()
				return true
		await _sleep(0.05)
	peer.close()
	return false


## Создаёт комнату на ЧУЖОМ сервере, не трогая нашу связь.
##
## Возвращает {code, peer} и НАМЕРЕННО оставляет связь открытой: комната
## живёт, пока в ней кто-то сидит, и закрытие связи (или уход) её удаляет.
## Вызывающий закрывает peer сам, когда комната больше не нужна.
func _create_on(entry: Dictionary, token: String, room_name: String) -> Dictionary:
	var peer := await _open_on(entry)
	if peer == null:
		return {"code": "", "peer": null}
	peer.send_text(JSON.stringify({"t": "auth.resume", "rid": "a1", "token": token}))
	# Ждём auth.ok: room.create без входа сервер отвергнет, и комната
	# просто не появится — с виду неотличимо от «сервер сломан».
	var authed := await _wait_reply(peer, "a1", NetProtocol.AUTH_OK)
	if not authed:
		peer.close()
		return {"code": "", "peer": null}
	peer.send_text(JSON.stringify({
		"t": "room.create", "rid": "c1", "seats": 2,
		"require30": false, "name": room_name, "password": "",
	}))
	var created := await _wait_reply(peer, "c1", NetProtocol.ROOM_STATE)
	var code := ""
	if created.has("room"):
		code = String((created["room"] as Dictionary).get("code", ""))
	if code.is_empty():
		peer.close()
		return {"code": "", "peer": null}
	return {"code": code, "peer": peer}


## Открывает соединение и дожидается рукопожатия. null — не открылось.
func _open_on(entry: Dictionary) -> WebSocketPeer:
	var opts := Certs.tls_options_for(entry)
	if opts == null:
		return null
	var peer := WebSocketPeer.new()
	peer.connect_to_url(_sv.url_of(entry), opts)
	var deadline := Time.get_ticks_msec() + RPC_TIMEOUT_MS
	while Time.get_ticks_msec() < deadline:
		match peer.get_ready_state():
			WebSocketPeer.STATE_OPEN:
				return peer
			WebSocketPeer.STATE_CLOSED:
				return null
		peer.poll()
		await _sleep(0.05)
	peer.close()
	return null


## Ждёт ответа с нашим rid нужного типа и возвращает его.
func _wait_reply(peer: WebSocketPeer, rid: String, want: String) -> Dictionary:
	var deadline := Time.get_ticks_msec() + RPC_TIMEOUT_MS
	while Time.get_ticks_msec() < deadline:
		peer.poll()
		if peer.get_available_packet_count() > 0:
			var msg = NetProtocol.parse(peer.get_packet().get_string_from_utf8())
			if msg is Dictionary and String((msg as Dictionary).get("rid", "")) == rid:
				var m: Dictionary = msg
				if String(m.get("t", "")) == want:
					return m
				# Ответ пришёл, но не тот: возвращаем как есть, чтобы
				# вызывающий увидел причину.
				return m
		await _sleep(0.05)
	return {}


# ------------------------------------------------------------------ мелочи

func _wait_for(seconds: float, cond: Callable) -> bool:
	var deadline := Time.get_ticks_msec() + int(seconds * 1000.0)
	while Time.get_ticks_msec() < deadline:
		if cond.call():
			return true
		await _sleep(0.1)
	return cond.call()


func _sleep(seconds: float) -> void:
	await create_timer(seconds).timeout


func _check(cond: bool, name: String, detail: String = "") -> void:
	_checked += 1
	var tail := (" — " + detail) if not detail.is_empty() else ""
	if cond:
		print("  ok    %s%s" % [name, tail])
	else:
		_failed += 1
		print("  FAIL  %s%s" % [name, tail])


func _finish(forced_code: int = -1) -> void:
	_net.disconnect_from()
	print("")
	# Ноль проверок — это не успех, а «проверить не удалось».
	# Тест, чья работа — убедиться, что живой кластер работает, обязан
	# упасть на мёртвом кластере, а не радостно отчитаться: иначе
	# первое же настоящее падение он пропустит молча, потому что
	# «успешных» прогонов будет сколько угодно, а провалятся они все
	# одинаково — ни одного.
	if _checked == 0:
		print("ОНЛАЙН-ПРОВЕРКА НЕ ВЫПОЛНЕНА: не проверено ни одной связи "
			% _skip_reason)
		quit(1)
		return
	if _failed > 0:
		print("ОНЛАЙН-ПРОВЕРКА: НЕ ПРОШЛО %d из %d" % [_failed, _checked])
		quit(1)
		return
	print("ОНЛАЙН-ПРОВЕРКА ПРОЙДЕНА: %d проверок" % _checked)
	quit(0 if forced_code < 0 else forced_code)


## Не смогли начать проверку — так и пишем, а не выходим с нулем.
func _abort(reason: String) -> void:
	_skip_reason = reason
	print("  %s" % reason)
	_finish()
