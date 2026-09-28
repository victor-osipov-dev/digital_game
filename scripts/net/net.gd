extends Node

# Связь с игровым сервером. Единственное место в клиенте, которое знает
# про сокеты, TLS и JSON — всё остальное работает через сигналы и await.
#
# Три вещи, ради которых файл и существует:
#
#  1) ЗАШИТЫЙ СЕРТИФИКАТ. Адреса серверов — голые IP, доменов нет, публичного
#     CA для них не бывает. Клиент требует, чтобы сервер предъявил ровно тот
#     сертификат, который лежит в сборке. Обойти это нельзя, отключать
#     проверку негде.
#
#  2) КОРРЕЛЯЦИЯ ПО RID. Ответ «мой ход отклонили» и чужое сообщение
#     «соперник сходил» приходят одним и тем же типом. Без метки в запросе
#     клиент не способен их различить и будет показывать чужие ошибки у себя.
#     Метка живёт только в личных ответах: рассылки её не несут.
#
#  3) ПЕРЕПОДКЛЮЧЕНИЕ. Обрыв связи посреди партии — обычное дело, а сервер
#     держит партию у себя. Переподключаемся к ТОМУ ЖЕ серверу (переключение
#     недопустимо: партия живёт только на нём) и переспрашиваем состояние.

const PING_EVERY_MS := 20000
const REQUEST_TIMEOUT_MS := 8000
const RETRY_MIN_MS := 800
const RETRY_MAX_MS := 15000
# Код закрытия, которым сервер отбирает место в столе у устаревшего
# соединения. Держим в паре с Hub.claimSeat на сервере: расхождение
# превратит вход во вторую вкладку в бесконечное выгоняние игроков.
const CLOSE_REPLACED := 4001

enum { OFFLINE, CONNECTING, GREETED, READY }

signal connection_changed(connected: bool, detail: String)
## Соединение есть, сервер поздоровался — можно входить.
signal greeted(hello: Dictionary)
signal logged_in(user: Dictionary, notice: String)
signal logged_out()
signal auth_failed(reason: String)
signal servers_list(list: Array)
signal rooms_list(rooms: Array, server: Dictionary)
signal room_state(room: Dictionary)
signal room_closed()
signal quick_state(queue: Dictionary)
signal game_state(state: Dictionary, grace: float, paused: bool)
## Ход отклонён. hard = true означает «сервер уже откатил наш стол», и
## присланное следом game_state нужно применить.
signal game_error(reason: String, hard: bool, errors: Array)
signal game_lost(reason: String)
signal notice(text: String)

var servers: Servers

var _peer: WebSocketPeer = null
var _entry: Dictionary = {}
var _state: int = OFFLINE
var _greeted := false
var _rid := 0
var _waiters: Array = []
var _session: Session = null
var _user: Dictionary = {}
var _catalog: Array = []
var _last_state: Dictionary = {}
var _auto_reconnect := false
var _retry_at_ms := 0
var _retry_ms := 0
var _last_tx_ms := 0
var _had_session := false


func _ready() -> void:
	servers = Servers.new()
	servers.name = "Servers"
	add_child(servers)
	_session = Session.load_from_disk()
	_had_session = _session.is_valid()


# ----------------------------------------------------------- подключение

## Подключается к серверу. Возвращает false, если начать не вышло.
func connect_to(entry: Dictionary) -> bool:
	if entry.is_empty():
		return false
	_auto_reconnect = true
	_retry_ms = 0
	return _open(entry)


func _open(entry: Dictionary) -> bool:
	_teardown(false)
	_entry = entry
	_greeted = false
	_peer = WebSocketPeer.new()
	# Запас с запасом: ответ game.state с чужой рукой — не самый крупный
	# пакет в игре, но и не самый маленький.
	_peer.inbound_buffer_size = 4 * 1024 * 1024
	_peer.outbound_buffer_size = 256 * 1024
	var label := servers.label_of(entry)
	var err := _peer.connect_to_url(servers.url_of(entry), Certs.tls_options_for(entry))
	if err != OK:
		_peer = null
		_fail("не удалось начать подключение к %s" % label)
		return false
	_state = CONNECTING
	connection_changed.emit(false, "подключение к %s…" % label)
	return true


## Разрывает связь. keep_session = true оставляет токен на диске.
func disconnect_from(keep_session := true) -> void:
	_auto_reconnect = false
	_teardown(false)
	_state = OFFLINE
	if not keep_session:
		_session.clear()
	_had_session = _session.is_valid()
	connection_changed.emit(false, "нет связи с сервером")


func _teardown(announce: bool) -> void:
	_fail_waiters("связь с сервером прервана")
	if _peer != null:
		_peer.close()
		_peer = null
	_greeted = false
	if announce:
		_state = OFFLINE


func _fail(reason: String) -> void:
	_teardown(false)
	_state = OFFLINE
	connection_changed.emit(false, reason)


func _fail_waiters(reason: String) -> void:
	if _waiters.is_empty():
		return
	_waiters.clear()
	_reply_arrived.emit()


func is_online() -> bool:
	return _peer != null and _state != OFFLINE

## Именно это, а не is_online: сокет уже поднят, но ещё не открыт.
func is_linked() -> bool:
	return _peer != null and _peer.get_ready_state() == WebSocketPeer.STATE_OPEN

## Сокет открыт И сервер уже поздоровался.
##
## Это то, на самом деле, означает «с сервером можно работать»: сокет
## открывается раньше первого пакета на целый круг туда-обратно, а
## спрашивать сервер можно только после приветствия. Разница видна
## глазом — до 200 мс на далёком сервере, — и всё это время запрос
## уходил бы «в пустоту».
func is_greeted() -> bool:
	return _greeted

func is_logged_in() -> bool:
	return _state == READY and not _user.is_empty()

func server_entry() -> Dictionary:
	return _entry

func server_label() -> String:
	return servers.label_of(_entry) if not _entry.is_empty() else "—"

func user() -> Dictionary:
	return _user

func catalog() -> Array:
	return _catalog

## Последнее известное состояние партии, или {} если её не было.
##
## Нужно при входе в сцену партии: пока грузится сцена, сервер мог прислать
## состояние в ответ на вход — и если его выбросить, игрок увидит пустой
## стол и подумает, что партия потерялась.
func pending_state() -> Dictionary:
	return _last_state.duplicate(true)

func in_game() -> bool:
	return not _last_state.is_empty()

func has_session() -> bool:
	return _session.is_valid()

func session_login() -> String:
	return _session.login

func session_nick() -> String:
	return _session.nick

## Токен сессии. Нужен не только для resume: им же клиент доказывает
## право смотреть список комнат на ДРУГОМ сервере, к которому не
## подключён. Сессия общая для всего кластера, поэтому токен подходит
## любому серверу.
func session_token() -> String:
	return _session.token


# ------------------------------------------------------------------ цикл

func _process(_delta: float) -> void:
	if _peer == null:
		_maybe_retry()
		return
	_peer.poll()
	match _peer.get_ready_state():
		WebSocketPeer.STATE_OPEN:
			_pump()
		WebSocketPeer.STATE_CLOSED:
			_on_closed()
		_:
			pass


func _pump() -> void:
	# _handle() зовёт сигналы, на которые в игре подписан интерфейс, а
	# обработчик вполне может вызвать disconnect_from() — например на
	# game_lost. Тогда _peer обнуляется, и следующая же проверка ниже
	# падает на null. Поэтому держим ссылку в отдельной переменной и после
	# КАЖДОГО разбора проверяем, что соединение всё то же самое: иначе
	# пакеты остались бы в канале непрочитанными, но это уже не наша
	# забота — соединения больше нет.
	var peer := _peer
	while peer != null and peer.get_available_packet_count() > 0:
		var text := peer.get_packet().get_string_from_utf8()
		var parsed = NetProtocol.parse(text)
		if not (parsed is Dictionary):
			continue   # мусор в канале — не повод рвать соединение
		_handle(parsed)
		if _peer != peer:
			return
	if _peer == null or _state != READY:
		return
	if Time.get_ticks_msec() - _last_tx_ms > PING_EVERY_MS:
		_send({ "t": NetProtocol.PING })


func _on_closed() -> void:
	var reason := _close_reason()
	_teardown(false)
	_state = OFFLINE
	if not _auto_reconnect:
		connection_changed.emit(false, reason)
		return
	# Если сессия была — молча возвращаемся в неё, игрок ничего не должен
	# вводить заново. Если не было — это первый вход: сообщаем честно,
	# молчаливое ожидание выглядит как зависание.
	if _had_session:
		connection_changed.emit(false, "связь потеряна (%s), переподключаемся…" % reason)
	else:
		connection_changed.emit(false, reason)
	_schedule_retry()


func _close_reason() -> String:
	if _peer == null:
		return "нет соединения"
	var code := _peer.get_close_code()
	if code == CLOSE_REPLACED:
		# Сервер отобрал это соединение, потому что игрок вошёл с другой
		# машины или в другой вкладке. Это не поломка, и переподключаться
		# нельзя: новая попытка снова отберёт место у той, другой, вкладки,
		# и игроки будут выгонять друг друга по кругу.
		return "вход выполнен в другом окне"
	if code == 1006 or code == 0:
		return "соединение оборвано"
	return "сервер закрыл соединение (код %d)" % code


## Место в столе занял более новый сокет того же игрока (код из
## Hub.claimSeat на сервере). Единственный код, при котором переподключение
## неуместно: связь закрыта намеренно, а не из-за обрыва.
func _is_replaced() -> bool:
	return _peer != null and _peer.get_close_code() == CLOSE_REPLACED


func _schedule_retry() -> void:
	_retry_ms = clampi(_retry_ms * 2, RETRY_MIN_MS, RETRY_MAX_MS)
	_retry_at_ms = Time.get_ticks_msec() + _retry_ms


func _maybe_retry() -> void:
	if not _auto_reconnect or _entry.is_empty():
		return
	if _is_replaced():
		# Место занято другим соединением того же игрока. Лезть снова —
		# значит выбить оттуда его. Ждём явного решения игрока.
		_auto_reconnect = false
		return
	if Time.get_ticks_msec() < _retry_at_ms:
		return
	_open(_entry)


# ------------------------------------------------------------ разбор пакетов

func _handle(msg: Dictionary) -> void:
	# Ответ на наш запрос. Метка есть только в личных ответах, поэтому
	# её наличие — достаточное основание разбудить именно этот запрос.
	if msg.has(NetProtocol.RID_FIELD):
		_resolve_waiter(String(msg[NetProtocol.RID_FIELD]), msg)
		return
	_dispatch(msg)


## Рассылка: пришла без метки, значит это не наш ответ.
func _dispatch(msg: Dictionary) -> void:
	var kind := String(msg.get("t", ""))
	match kind:
		NetProtocol.HELLO:
			_on_hello(msg)
		NetProtocol.GAME_STATE:
			var view: Dictionary = msg.get("state", {})
			if not view.is_empty():
				# Копия нужна потому, что ниже отдаём наружу ссылку на общий
				# словарь, а сцена может пережить следующее обновление.
				_last_state = view
			game_state.emit(view, float(msg.get("grace", 0.0)),
				bool(msg.get("paused", false)))
		NetProtocol.GAME_ERROR:
			game_error.emit(String(msg.get("reason", "ошибка")), bool(msg.get("hard", false)),
				msg.get("errors", []))
		NetProtocol.ROOM_STATE:
			room_state.emit(msg.get("room", {}))
		NetProtocol.ROOM_LEFT:
			# Партия закончилась уходом: состояние больше не наше, иначе
			# вернувшись в меню, сцена найдёт «свою» партию на чужом месте.
			_last_state = {}
			room_closed.emit()
		NetProtocol.QUICK_STATE:
			quick_state.emit(msg.get("queue", {}))
		NetProtocol.TOAST:
			notice.emit(String(msg.get("text", "")))
		_:
			pass   # неизвестное сообщение игнорируем: клиент новее сервера


func _on_hello(hello: Dictionary) -> void:
	_greeted = true
	_state = GREETED
	var tiles = hello.get("catalog", [])
	if tiles is Array:
		_catalog = tiles
	greeted.emit(hello)
	if _session.is_valid():
		# Молчаливый вход по сохранённому токену. Токен живой на любом
		# сервере кластера, поэтому смена сервера вход не ломает.
		call_deferred("_resume_silent")


func _resume_silent() -> void:
	var res := await request(NetProtocol.RESUME, { "token": _session.token })
	if String(res.get("t", "")) == NetProtocol.AUTH_OK:
		_apply_auth(res)
	else:
		# Токен протух (сменили пароль на другом сервере) — молча чистим
		# и пусть игрок войдёт руками.
		_session.clear()
		_state = GREETED
		auth_failed.emit(String(res.get("reason", "сессия больше недействительна")))


func _apply_auth(res: Dictionary) -> void:
	_state = READY
	_user = res.get("user", {})
	var token := String(res.get("token", ""))
	if not token.is_empty():
		_session.token = token
	_session.login = String(_user.get("login", ""))
	_session.nick = String(_user.get("nick", ""))
	_session.save()
	_had_session = true
	connection_changed.emit(true, server_label())
	logged_in.emit(_user, String(res.get("notice", "")))


func _resolve_waiter(rid: String, msg: Dictionary) -> void:
	for i in _waiters.size():
		var w: Dictionary = _waiters[i]
		if String(w.get("rid", "")) != rid:
			continue
		_waiters.remove_at(i)
		w["msg"] = msg
		break
	_reply_arrived.emit()


# ----------------------------------------------------------------- запросы

signal _reply_arrived

## Отправляет команду и ждёт ЛИЧНЫЙ ответ на неё.
##
## Возвращает {} при обрыве связи и {"t":"timeout"} при молчании сервера —
## то есть никогда не виснет. Для ответа на конкретную команду сервер
## шлёт ровно одно личное сообщение с её меткой.
func request(cmd: String, payload: Dictionary = {}, expect: PackedStringArray = PackedStringArray()) -> Dictionary:
	if _peer == null or _peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return { "t": "offline", "reason": "нет связи с сервером" }
	_rid += 1
	# Метка уникальна на всё время работы клиента: нумератор продолжается
	# после переподключения, а в метку входит время — старый ответ,
	# застрявший в очереди, совпасть уже не может.
	var rid := "c%d.%d" % [Time.get_ticks_msec(), _rid]
	var waiter := { "rid": rid, "cmd": cmd, "msg": {} }
	_waiters.append(waiter)
	var msg := payload.duplicate()
	msg["t"] = cmd
	msg[NetProtocol.RID_FIELD] = rid
	if not _send(msg):
		_waiters.erase(waiter)
		return { "t": "offline", "reason": "не удалось отправить команду" }

	var deadline := Time.get_ticks_msec() + REQUEST_TIMEOUT_MS
	while Time.get_ticks_msec() < deadline:
		if not waiter["msg"].is_empty():
			_check_expected(cmd, waiter["msg"], expect)
			return waiter["msg"]
		if _peer == null or _peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
			return { "t": "offline", "reason": "связь прервалась" }
		await _reply_arrived
	_waiters.erase(waiter)
	return { "t": "timeout", "reason": "сервер не ответил вовремя" }


## Тип ответа не тот, что ожидали. Это не поломка (сервер мог добавить
## новый тип), но о молчании лучше знать сразу, чем потом ловить
## отсутствие нужных полей.
func _check_expected(cmd: String, msg: Dictionary, expect: PackedStringArray) -> void:
	if expect.is_empty():
		return
	var kind := String(msg.get("t", ""))
	if not expect.has(kind):
		push_warning("на %s ожидали %s, пришло %s" % [cmd, ", ".join(expect), kind])


## Отправляет без ожидания ответа.
func notify(cmd: String, payload: Dictionary = {}) -> bool:
	var msg := payload.duplicate()
	msg["t"] = cmd
	return _send(msg)


func _send(msg: Dictionary) -> bool:
	if _peer == null or _peer.get_ready_state() != WebSocketPeer.STATE_OPEN:
		return false
	_last_tx_ms = Time.get_ticks_msec()
	return _peer.send_text(JSON.stringify(msg)) == OK


# ------------------------------------------------------------------- вход

## Дождаться приветствия сервера, но не дольше sec секунд.
##
## Сокет открывается не сразу: сначала рукопожатие TLS, потом первый
## пакет — приветствие с каталогом фишек. Между этими двумя событиями
## проходит целый круг туда-обратно, и на далёком сервере это сотни
## миллисекунд. Раньше вход в это окно отказывал с «нет связи с
## сервером» — при живой, только ещё не поздоровавшейся связи.
##
## Возвращает false, если за время ожидания так и не поздоровались либо
## соединение развалилось. Никогда не виснет.
func _await_greet(sec := 6.0) -> bool:
	var deadline := Time.get_ticks_msec() + int(sec * 1000.0)
	while Time.get_ticks_msec() < deadline:
		if _greeted:
			return true
		if _peer == null:
			return false
		# CLOSING — это ещё не обрыв, обрыв это CLOSED. Пока идёт
		# закрытие, приветствие в принципе может ещё прийти.
		if _peer.get_ready_state() == WebSocketPeer.STATE_CLOSED:
			return false
		# CONNECTING тоже терпим: игрок вправе нажать «Войти», не дожидаясь
		# конца рукопожатия, и ждать здесь правильнее, чем отказать.
		await get_tree().process_frame
	return _greeted


## Продолжает прошлую сессию. Ответ: {ok, reason, user}.
func resume() -> Dictionary:
	if not await _await_greet():
		return { "ok": false, "reason": "нет связи с сервером" }
	var res := await request(NetProtocol.RESUME, { "token": _session.token })
	return _finish_auth(res)


func login(login_name: String, password: String) -> Dictionary:
	if not await _await_greet():
		return { "ok": false, "reason": "нет связи с сервером" }
	var res := await request(NetProtocol.LOGIN, { "login": login_name, "password": password })
	return _finish_auth(res)


func register(login_name: String, password: String, nick: String) -> Dictionary:
	if not await _await_greet():
		return { "ok": false, "reason": "нет связи с сервером" }
	var res := await request(NetProtocol.REGISTER,
		{ "login": login_name, "password": password, "nick": nick })
	return _finish_auth(res)


func _finish_auth(res: Dictionary) -> Dictionary:
	if String(res.get("t", "")) == NetProtocol.AUTH_OK:
		_apply_auth(res)
		return { "ok": true, "user": _user }
	var reason := String(res.get("reason", "вход не удался"))
	auth_failed.emit(reason)
	return { "ok": false, "reason": reason }


func logout() -> Dictionary:
	var res := await request(NetProtocol.LOGOUT, { "token": _session.token })
	_user = {}
	_state = GREETED if _greeted else OFFLINE
	_session.clear()
	_had_session = false
	logged_out.emit()
	return res


func set_nick(nick: String) -> Dictionary:
	var res := await request(NetProtocol.CHANGE_NICK, { "nick": nick })
	if String(res.get("t", "")) == NetProtocol.AUTH_OK:
		_user = res.get("user", _user)
		_session.nick = nick
		_session.save()
	return res


func change_password(old_password: String, new_password: String) -> Dictionary:
	var res := await request(NetProtocol.CHANGE_PASSWORD,
		{ "old": old_password, "new": new_password })
	if String(res.get("t", "")) == NetProtocol.AUTH_OK:
		var token := String(res.get("token", ""))
		if not token.is_empty():
			_session.token = token
		_session.save()
	return res


# ------------------------------------------------------- серверы и комнаты

func request_servers_list() -> Dictionary:
	return await request(NetProtocol.SERVERS_LIST, {},
		PackedStringArray([NetProtocol.SERVERS_LIST_S2C, NetProtocol.GAME_ERROR]))


func request_rooms_list() -> Dictionary:
	return await request(NetProtocol.ROOMS_LIST, {},
		PackedStringArray([NetProtocol.ROOMS_LIST_S2C, NetProtocol.GAME_ERROR]))


func create_room(seats: int, require_30: bool, room_name: String, password: String) -> Dictionary:
	return await request(NetProtocol.ROOM_CREATE, {
		"seats": seats, "require30": require_30,
		"name": room_name, "password": password,
	})


func join_room(code: String, password: String) -> Dictionary:
	return await request(NetProtocol.ROOM_JOIN, { "code": code, "password": password })


func leave_room() -> Dictionary:
	return await request(NetProtocol.ROOM_LEAVE)


func start_room() -> Dictionary:
	return await request(NetProtocol.ROOM_START)


func quick_join(seats: int, require_30: bool) -> Dictionary:
	return await request(NetProtocol.QUICK_JOIN, { "seats": seats, "require30": require_30 })


func quick_leave() -> Dictionary:
	return await request(NetProtocol.QUICK_LEAVE)


# ----------------------------------------------------------------- партия

## Отправляет готовый стол и ждёт вердикта сервера.
func commit_table(rows: Array) -> Dictionary:
	return await request(NetProtocol.GAME_COMMIT, {
		"ops": [{ "op": "set_table", "rows": rows }],
	}, PackedStringArray([NetProtocol.GAME_STATE, NetProtocol.GAME_ERROR]))


func draw_from_deck() -> Dictionary:
	return await request(NetProtocol.GAME_DRAW, {},
		PackedStringArray([NetProtocol.GAME_STATE, NetProtocol.GAME_ERROR]))


func skip_turn() -> Dictionary:
	return await request(NetProtocol.GAME_SKIP, {},
		PackedStringArray([NetProtocol.GAME_STATE, NetProtocol.GAME_ERROR]))


## Переспрашивает состояние партии. Нужно после переподключения и при
## любом сомнении: сервер — единственный источник правды, клиент лишь зеркало.
func rejoin_game() -> Dictionary:
	var res := await request(NetProtocol.GAME_REJOIN, {},
		PackedStringArray([NetProtocol.GAME_STATE, NetProtocol.GAME_ERROR]))
	if String(res.get("t", "")) == NetProtocol.GAME_ERROR:
		# Партия живёт в памяти сервера. Перезапустил сервер — партии нет,
		# и продолжать нечего. Молча возвращаться в лобби нельзя: игрок
		# решит, что проиграл по правилам.
		game_lost.emit(String(res.get("reason", "партия недоступна")))
	return res
