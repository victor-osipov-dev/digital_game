class_name OnlineLobby
extends Control

# Сетевое меню: вход, список комнат со всех серверов, ожидание игроков.
#
# Отдельный экран, а не ещё одна кнопка в главном меню, потому что здесь
# есть состояния, которых в главном нет: сервер может быть недоступен,
# сессия может протухнуть, комната может ждать второго игрока минуту.
# Всё это нужно показывать, а не сообщать тостом поверх пустоты.
#
# Кто где настоящий: сервер держит партию, здесь мы только спрашиваем
# «что там» и отправляем «хочу».

var _overlay: ColorRect = null
var _page_auth: VBoxContainer = null
var _page_rooms: VBoxContainer = null
var _page_lobby: VBoxContainer = null

var _status: Label = null
var _busy: Label = null

var _login_edit: LineEdit = null
var _pass_edit: LineEdit = null
var _nick_edit: LineEdit = null
var _auth_note: Label = null
var _login_btn: Button = null
var _register_btn: Button = null

var _server_label: Label = null
var _server_box: VBoxContainer = null
var _rooms_box: VBoxContainer = null
var _rooms_note: Label = null
var _refresh_btn: Button = null

var _seats_option: OptionButton = null
var _room_name: LineEdit = null
var _room_pass: LineEdit = null
var _require_30: CheckBox = null
var _create_btn: Button = null
var _quick_btn: Button = null
var _join_code: LineEdit = null
var _join_pass: LineEdit = null
var _join_btn: Button = null

var _lobby_code: Label = null
var _lobby_seats: Label = null
var _lobby_players: VBoxContainer = null
var _auto_hint: Label = null
var _start_btn: Button = null
var _leave_btn: Button = null
var _lobby_note: Label = null

var _rooms: Array = []
var _busy_flag := false
var _started := false
var _tick: Timer = null
var _back_btn: Button = null
var _stuck_box: PanelContainer = null
var _stuck_label: Label = null

# Комната, в которой мы сейчас сидим (страница лобби). Нужна, чтобы при
# выходе из лобби в главное меню не потерять её: кнопки «вернуться» и
# «покинуть насовсем» должны остаться доступными и там, и в списке комнат.
var _current_room: Dictionary = {}
# Код текущей комнаты отдельным полем: _current_room чистится, когда мы
# уходим парковать комнату в главное меню, а код ещё понадобится, если
# партия начнётся без нас — восстановить pending как «партия идёт».
var _lobby_room_code := ""
var _return_btn: Button = null
var _drop_btn: Button = null
# Все ли места заняты — по последнему снимку лобби. Кнопка «Начать»
# опирается на это, а не пересчитывает сама: пересчёт в двух местах
# разойдётся, и хост увидит доступную кнопку, которую сервер не примет.
var _lobby_all_in := false
# Достаточно ли ЖИВЫХ ЛЮДЕЙ, чтобы партия могла начаться: двое и больше.
# Боты доберутся сами как при заполнении, так и по таймеру автостарта,
# поэтому кнопке «Начать» не нужна полная комната — нужны двое.
var _lobby_ready := false

# Как часто освежать «кто на связи», пока меню открыто. Реже, чем список
# комнат: список — по кнопке, а вот «сервер жив» должно исправляться само,
# иначе меню минутами обещает связь с машиной, которая давно упала.
const HEALTH_TICK_S := 20.0


# =============================================================== жизненный цикл

func _ready() -> void:
	# Интерфейс строится сразу, а не при первом открытии: иначе первое
	# нажатие «Играть по сети» ждало бы сборку разметки, и кнопка выглядела
	# бы зависшей. При этом сам экран остаётся скрытым и не перехватывает
	# щелчки главного меню.
	_build()


func open() -> void:
	_build()
	visible = true
	_tick.start()
	_refresh_presence()
	_enter()

func close() -> void:
	# Уже начатую партию бросать нельзя: место в комнате держится, и её
	# нужно покинуть явно, иначе сервер будет ждать нас до конца партии.
	if _started:
		_started = false
		Net.leave_room()
		_current_room = {}
	# Выходим из лобби комнаты в главное меню, саму комнату не покидая:
	# место за нами сохраняется, и «вернуться»/«покинуть насовсем» должны
	# ждать игрока и на главном экране, и в списке комнат.
	elif not _current_room.is_empty():
		Net.park_room(_current_room)
		_current_room = {}
	visible = false
	_tick.stop()


func _on_net_connection(connected: bool, detail: String) -> void:
	_update_status()
	if not visible:
		return
	if connected:
		# Связь восстановлена: прежнее «нет связи» должно уйти, иначе
		# красная надпись переживёт удачный переподключительный сеанс.
		# Занятую надпись трогать нельзя — она про другой запрос.
		if not _busy_flag:
			_set_note(_busy, "", false)
		# Приветствие к этой точке уже пришло, если состояние живое, —
		# пересчитываем кнопки, чтобы не оставить их серыми: они считаются
		# один раз в _build, и между открытием сокета и hello флажок
		# is_greeted() ещё ложный.
		_update_buttons()
		# Вход через reconnect уже случился и pending сверен с сервером
		# (auth.ok.room). Если сервер больше не числит нас в комнате, а лобби
		# всё ещё показывает комнату с прошлой жизни — комната закрылась,
		# пока мы были офлайн, и держать её на экране нельзя: выход оттуда
		# припарковал бы мёртвую комнату и повесил баннер «вы всё ещё в
		# комнате», в которую не вернуться.
		if not _current_room.is_empty():
			_reconcile_room_after_reconnect()
		return
	# connected == false значит не «связь оборвалась», а «связи пока
	# нет»: так же помечает рукопожатие, когда сокет уже создан, но
	# ещё не открыт. Красное «Нет связи» рядом с живым пингом того же
	# сервера в списке выглядело как противоречие, поэтому обрывом
	# считаем только настоящий OFFLINE, а is_online() — ровно та
	# проверка, которая эти состояния различает (её же _on_tick
	# использует, чтобы не пересоздавать сокет на ровном месте).
	if Net.is_online():
		return
	_set_note(_busy, "Нет связи с сервером: %s" % detail, true)


func _on_net_greeted(_hello: Dictionary) -> void:
	# Кнопки входа считаются в _build, когда is_greeted() ещё false, и
	# ждут именно этого сигнала, чтобы стать кликабельными.
	_update_buttons()


func _on_net_room_state(room: Dictionary) -> void:
	_show_lobby(room)

func _on_net_room_left() -> void:
	_started = false
	_current_room = {}
	_lobby_room_code = ""
	if visible:
		_goto_rooms()

## Сличает комнату, которую показывает лобби, с серверной правдой после
## переподключения. pending уже заполнен из auth.ok.room: пустой — комната
## закрылась, пока нас не было (или владелец вышел), и место в ней больше
## не держится. Возвращаемся в список и говорим об этом прямо, а не вешаем
## баннер «вы всё ещё в комнате», в которую вернуться нельзя.
func _reconcile_room_after_reconnect() -> void:
	if not Net.pending_room().is_empty():
		# Сервер подтвердил, что место за нами держится: лобби не врёт.
		return
	var code := String(_current_room.get("code", "?"))
	_current_room = {}
	_lobby_room_code = ""
	if _page_lobby.visible:
		_goto_rooms()
		_set_note(_rooms_note, "Комната %s закрылась, пока вы были офлайн" % code, true)

func _on_net_game_state(_view: Dictionary, _grace: float, _paused: bool, _waiting: bool) -> void:
	# Партия началась — уходим в неё, сами её не рисуем. Сидим на странице
	# комнат, а не в лобби комнаты? Тогда это не наша рассылка (мягко
	# вышедшего игрока сервер из партии выписал, состояния ему не шлют).
	if not _page_lobby.visible:
		# Партия началась, пока мы в отрыве от лобби (главное меню после
		# парковки комнаты). Рассылка GAME_STATE СБРАСЫВАЕТ pending, и без
		# восстановления пропала бы и кнопка «вернуться», и баннер в списке
		# комнат, хотя место в партии за нами ещё держится. Возвращаем
		# pending как «партия идёт» — вернуться в неё всё ещё можно.
		if not _lobby_room_code.is_empty():
			Net.park_room({"code": _lobby_room_code, "state": "playing"})
		return
	# Смена сцены уже заказана (room_state тоже уводит в партию) —
	# повторный вызов осиротил бы первый экземпляр сцены.
	if _started:
		return
	_started = true
	Net.plan_game(true)
	get_tree().change_scene_to_file("res://scenes/game.tscn")


func _enter() -> void:
	if not Net.is_linked():
		# Сервер выбираем при входе: партия живёт на одном сервере, и
		# менять сервер посреди неё нельзя.
		_do_connect()
		return
	if not Net.is_logged_in():
		_enter_auth()
		return
	_goto_rooms()


func _enter_auth() -> void:
	_set_page(_page_auth)
	_update_status()
	_update_buttons()
	# Надпись о связи сюда не переносится: на странице входа она была бы
	# не к месту и залипала бы после успешного подключения, потому что
	# чистится только вместе с busy-задачей.
	_set_note(_busy, "", false)
	_auth_note.text = ""
	if _login_edit.text.is_empty():
		_login_edit.text = Net.session_login()
	if _nick_edit.text.is_empty():
		_nick_edit.text = Net.session_nick()
	_login_edit.grab_focus()


## Подключается к серверу. Какой именно — неважно для входа: сессия
## общая для всего кластера, и вход на любом сервере открывает комнаты
## обоих. Но если в сети есть РАБОТАЮЩАЯ партия, подключаться надо
## ровно к тому серверу, который её держит, иначе партия потеряется.
func _do_connect() -> void:
	var sv: Servers = Net.servers
	var entry := sv.fastest_online()
	if entry.is_empty():
		# Ни один сервер не прошёл проверку. Всё равно пробуем первый:
		# проверка могла не успеть, а сервер вполне может быть живым.
		entry = sv.first()
	if entry.is_empty():
		_set_note(_busy, sv.offline_hint(), true)
		return
	_set_note(_busy, "Подключаемся к %s…" % sv.label_of(entry), false)
	if not Net.connect_to(entry):
		return
	# Ждём не фиксированное время, а прихода приветствия: у скрипта нет
	# прямого сигнала «готов», а ждать наугад — значит иногда показывать
	# форму входа ещё до готовности сервера к входу.
	var deadline := Time.get_ticks_msec() + 8000
	while Time.get_ticks_msec() < deadline:
		if Net.is_logged_in():
			_goto_rooms()
			return
		if Net.is_greeted():
			# Сервер поздоровался, а сессии нет — нет смысла ждать
			# остаток таймаута, вход уже возможен.
			break
		if not Net.is_online() and Net.has_session():
			# Сокет упал, пока поднимался. Пробуем следующий сервер.
			break
		await get_tree().process_frame
	if Net.is_logged_in():
		_goto_rooms()
	elif visible:
		_enter_auth()
		_update_status()
		_update_buttons()


# =============================================================== вход

func _do_login() -> void:
	var login_name := _login_edit.text.strip_edges()
	var password := _pass_edit.text
	if login_name.is_empty() or password.is_empty():
		_auth_note.text = "Заполните логин и пароль"
		return
	_auth_note.text = "Входим…"
	var res := await Net.login(login_name, password)
	_after_auth(res, "Вход выполнен")


func _do_register() -> void:
	var login_name := _login_edit.text.strip_edges()
	var password := _pass_edit.text
	var nick := _nick_edit.text.strip_edges()
	if login_name.is_empty() or password.is_empty() or nick.is_empty():
		_auth_note.text = "Заполните логин, пароль и имя"
		return
	if password.length() < 4:
		_auth_note.text = "Пароль слишком короткий (минимум 4 символа)"
		return
	_auth_note.text = "Создаём аккаунт…"
	var res := await Net.register(login_name, password, nick)
	_after_auth(res, "Аккаунт создан")


func _after_auth(res: Dictionary, ok_text: String) -> void:
	# Net.login/Net.register возвращают не сырое сообщение сервера, а
	# единую обёртку: {ok:true, user} либо {ok:false, reason}. Проверка
	# поля "t" тут не годится — его в обёртке нет, и успешный вход
	# выглядел бы как отказ (в сессию вошли, а страницу комнат не
	# показали, пока не переоткрыть экран).
	if bool(res.get("ok", false)):
		_auth_note.text = ok_text
		_goto_rooms()
		return
	_auth_note.text = _reason(res, "Не удалось войти")


func _do_logout() -> void:
	await Net.logout()
	_enter_auth()


# =============================================================== список комнат

func _goto_rooms() -> void:
	_set_page(_page_rooms)
	_update_status()
	_refresh_stuck()
	if _rooms.is_empty():
		await _load_rooms()
	else:
		_render_rooms()


## Собираем список комнат со всех живых серверов.
##
## Проверка живости — здесь же: она нужна ровно для этого запроса. Если
## живых серверов нет, список всё равно не придёт, а сообщение об этом
## должно быть предметным, а не «ничего не нашлось».
func _load_rooms() -> void:
	_set_busy("Собираем список комнат…")
	await Net.servers.probe(true)
	_update_presence()
	if not Net.servers.any_online():
		_rooms = []
		_rooms_note.text = Net.servers.offline_hint()
		_render_rooms()
		_set_busy("")
		return
	# Список комнат сервер отдаёт только вошедшим, поэтому вход нужен и тут.
	# Сессия общая для всего кластера: токен, выданный на одном сервере,
	# подходит любому другому, и отдельный вход не требуется.
	var got := await Net.servers.list_rooms(Net.session_token())
	_rooms = got.get("rooms", [])
	var failed: Array = got.get("failedServers", [])
	if failed.is_empty():
		_rooms_note.text = "Комнат найдено: %d" % _rooms.size()
	else:
		_rooms_note.text = "Показаны комнаты без %s. Остальные серверы не ответили." % \
			", ".join(_failed_names(failed))
	_render_rooms()
	_set_busy("")


func _failed_names(ids: Array) -> PackedStringArray:
	var out := PackedStringArray()
	for id in ids:
		var entry := Net.servers.by_id(String(id))
		out.append(Net.servers.label_of(entry) if not entry.is_empty() else String(id))
	return out


func _refresh_rooms() -> void:
	await _load_rooms()


func _render_rooms() -> void:
	for child in _rooms_box.get_children():
		_rooms_box.remove_child(child)
		child.free()
	if _rooms.is_empty():
		var empty := Label.new()
		empty.text = "Пока никто не создал комнату. Создайте свою."
		empty.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		empty.add_theme_font_size_override("font_size", Settings.fs(14))
		empty.add_theme_color_override("font_color", Color(1, 1, 1, 0.5))
		_rooms_box.add_child(empty)
		return
	for room in _rooms:
		_rooms_box.add_child(_make_room_row(room as Dictionary))
	ScrollFix.relax(_rooms_box)


func _make_room_row(room: Dictionary) -> Control:
	var row := PanelContainer.new()
	row.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(1, 1, 1, 0.05)
	sb.set_corner_radius_all(10)
	sb.border_color = Color(1, 1, 1, 0.12)
	sb.set_border_width_all(1)
	sb.content_margin_left = 10.0
	sb.content_margin_right = 10.0
	sb.content_margin_top = 6.0
	sb.content_margin_bottom = 6.0
	row.add_theme_stylebox_override("panel", sb)

	var box := HBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	row.add_child(box)

	var filled := int(room.get("filled", 0))
	var seats := int(room.get("seats", 2))
	# Название сервера в строке обязательно: список собирается с обоих
	# серверов, и без подписи две одинаковые комнаты «2/2» не отличить.
	var text := "%s · %d/%d · %s" % [
		String(room.get("name", "?")), filled, seats,
		String(room.get("serverName", "?")),
	]
	# Идущую партию тоже показываем в списке: в неё можно войти вместо
	# бота. Помечать надо явно — иначе по «N/M» человека примут её за
	# лобби, где можно сесть на свободное место.
	if String(room.get("state", "")) == "playing":
		text += " · партия идёт"
	var bots := int(room.get("bots", 0))
	if bots > 0:
		text += " · боты: %d" % bots
	if bool(room.get("require30", true)):
		text += " · от 30"
	if bool(room.get("hasPassword", false)):
		text += " · пароль"

	var lab := Label.new()
	lab.text = text
	lab.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	lab.add_theme_font_size_override("font_size", Settings.fs(14))
	lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	lab.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	box.add_child(lab)

	var join := Button.new()
	join.text = "Войти"
	join.custom_minimum_size = Vector2(Settings.touch(84), Settings.touch(38))
	join.add_theme_font_size_override("font_size", Settings.fs(14))
	join.pressed.connect(_do_join.bind(String(room.get("code", "")), String(room.get("server", ""))))
	box.add_child(join)
	return row


func _do_join(code: String, server_id: String) -> void:
	if code.is_empty():
		return
	# Комната живёт на конкретном сервере, и партия потом будет только
	# там же. Значит, подключение надо перевести ЗАРАНЕЕ: если сначала
	# спросить «есть ли такой код?» на своём сервере, а потом
	# переподключиться, между шагами комната может закрыться, и мы
	# окажемся в лобби чужого сервера без партии.
	if not server_id.is_empty() and server_id != String(Net.server_entry().get("id", "")):
		if not await _switch_to(server_id, "Комната на сервере %s" % server_id):
			return
	if not Net.is_logged_in():
		_enter_auth()
		return
	_set_busy("Заходим в %s…" % code)
	var res := await Net.join_room(code, _join_pass.text)
	_set_busy("")
	if _enter_from_join(res):
		return
	# Вход по коду ничего не говорит о сервере, поэтому «не найдена» на
	# текущем сервере — не ответ, а «ещё не смотрели». Обходим остальные
	# живые: иначе код, выданный на другом сервере, был бы нерабочим.
	if server_id.is_empty() and String(res.get("reason", "")) == "Комната не найдена":
		var home := String(Net.server_entry().get("id", ""))
		for other in Net.servers.online_sorted():
			var other_id := String((other["entry"] as Dictionary).get("id", ""))
			if other_id == home:
				continue
			if not await _switch_to(other_id, "Ищем комнату"):
				return
			var again := await Net.join_room(code, _join_pass.text)
			if _enter_from_join(again):
				return
			# Не нашли и здесь. Возвращаемся домой: оставшись на чужом
			# сервере, мы бы молча смотрели не на тот список комнат.
			await _switch_to(home, "Возвращаемся")
			break
	var failed_code := String(res.get("reason", "")) == "Комната не найдена"
	if failed_code and String(Net.pending_room().get("code", "")).to_upper() == code.to_upper():
		# Возврат в комнату, которую сервер больше не знает: место за нами
		# не держится, и напоминание «вы всё ещё в комнате» врало бы.
		Net.clear_pending_room()
	_set_note(_rooms_note, _reason(res, "Не удалось войти в комнату"), true)


## Разбор ответа на ROOM_JOIN: лобби комнаты или — если мы последним
## заполнили комнату или вошли вместо бота — уже сама партия.
## true, если ответ обработан.
func _enter_from_join(res: Dictionary) -> bool:
	match String(res.get("t", "")):
		NetProtocol.ROOM_STATE:
			_show_lobby(res.get("room", {}))
			return true
		NetProtocol.GAME_STATE:
			# Вход в идущую/только что заполненную партию: сцену меняем
			# сами (game.tscn в _ready добудет свежее состояние через
			# game.rejoin) — рассылка GAME_STATE сюда не придёт, сервер
			# исключает из неё наше место.
			_started = true
			Net.plan_game(true)
			get_tree().change_scene_to_file("res://scenes/game.tscn")
			return true
	return false


## Подключается к серверу по id. false, если сервера больше нет в списке
## или связь не поднялась — тогда звать уже некуда.
func _switch_to(id: String, why: String) -> bool:
	var entry := Net.servers.by_id(id)
	if entry.is_empty():
		_set_note(_rooms_note, "Сервер %s больше не в списке" % id, true)
		return false
	_set_busy("%s: %s…" % [why, Net.servers.label_of(entry)])
	if not Net.connect_to(entry):
		_set_busy("")
		_set_note(_rooms_note, "Не удалось подключиться к %s" % Net.servers.label_of(entry), true)
		return false
	# Соединение поднимается асинхронно: ждём готовности, иначе первый
	# же запрос уйдёт в ещё не открытый сокет.
	var deadline := Time.get_ticks_msec() + 8000
	while Time.get_ticks_msec() < deadline and Net.is_online() and not Net.is_logged_in():
		await get_tree().process_frame
	_set_busy("")
	if not Net.is_logged_in():
		_set_note(_rooms_note, "Сессия не восстановилась на %s" % Net.servers.label_of(entry), true)
		return false
	return true


func _do_create() -> void:
	if not Net.is_logged_in():
		_enter_auth()
		return
	# Комнату создаём на СЛУЧАЙНОМ живом сервере: так комнаты
	# распределяются по обеим машинам, а не копятся на одной.
	var entry := Net.servers.random_online()
	if entry.is_empty():
		_set_note(_rooms_note, Net.servers.offline_hint(), true)
		return
	if String(entry.get("id", "")) != String(Net.server_entry().get("id", "")):
		if not await _switch_to(String(entry.get("id", "")), "Создаём комнату"):
			return
	_set_busy("Создаём комнату на %s…" % Net.servers.label_of(entry))
	var res := await Net.create_room(
		_seats_option.get_selected_id(), _create_require_30(), _room_name.text, _room_pass.text)
	_set_busy("")
	if String(res.get("t", "")) == NetProtocol.ROOM_STATE:
		_show_lobby(res.get("room", {}))
		return
	_set_note(_rooms_note, _reason(res, "Не удалось создать комнату"), true)


func _do_quick() -> void:
	if not Net.is_logged_in():
		_enter_auth()
		return
	_set_busy("Ищем соперника…")
	var res := await Net.quick_join(_seats_option.get_selected_id(), _create_require_30())
	_set_busy("")
	match String(res.get("t", "")):
		NetProtocol.QUICK_STATE:
			if bool(res.get("started", false)):
				_set_note(_rooms_note, "Партия началась!", false)
			else:
				_set_note(_rooms_note,
					"В очереди %d. Ждём соперника." % int(res.get("waiting", 1)), false)
		NetProtocol.ROOM_STATE:
			# Сервер собрал комнату и посадил нас: значит, пора в партию.
			_show_lobby(res.get("room", {}))
		_:
			_set_note(_rooms_note, _reason(res, "Быстрый матч недоступен"), true)


func _create_require_30() -> bool:
	# Отдельный флажок, а не настройка одиночной игры: правило живёт
	# в комнате, и менять его молча означало бы сыграть не по тем
	# правилам, которые человек только что прочитал.
	return _require_30.button_pressed


# =============================================================== ожидание комнаты

func _show_lobby(room: Dictionary) -> void:
	if room.is_empty():
		return
	_current_room = room
	_lobby_room_code = String(room.get("code", ""))
	if visible:
		# Мы смотрим на комнату — «застрявшей» больше нет, баннеру нечего
		# показывать, а кнопки «вернуться» не нужны: мы уже внутри.
		Net.clear_pending_room()
	else:
		# Комната обновилась, пока мы в отрыве (главное меню после парковки):
		# обновляем parked-состояние, чтобы напоминания не врали и не гаснуть
		# от ROOM_STATE, который сбрасывает pending.
		Net.park_room(room)
	_set_page(_page_lobby)
	_lobby_code.text = "Комната %s" % String(room.get("code", "?"))
	_lobby_seats.text = "%s · места: %d · первый ход: %s" % [
		Net.server_label(),
		int(room.get("seats", 0)),
		"от 30 очков" if bool(room.get("require30", true)) else "без ограничения",
	]
	_lobby_note.text = ""
	for child in _lobby_players.get_children():
		_lobby_players.remove_child(child)
		child.free()
	var players: Array = room.get("players", [])
	var me := int(room.get("you", -1))
	# Сервер присылает ВСЕ места, включая пустые. Считать занятые надо
	# отдельно: иначе «занято» всегда равно числу мест, кнопка «Начать»
	# всегда доступна, а сервер отвечает «Занято 2 из 5» — и человек
	# бесконечно жмёт на кнопку, которая не может сработать.
	var taken := 0
	for p in players:
		var d: Dictionary = p
		var is_taken := not bool(d.get("empty", false))
		if is_taken:
			taken += 1
		var line := Label.new()
		var nick := String(d.get("nick", "?"))
		if not is_taken:
			nick = "— свободно —"
		elif not bool(d.get("connected", true)):
			nick += "  (нет связи)"
		if int(d.get("seat", -1)) == me:
			nick = "▶ " + nick
		line.text = "Место %d:  %s" % [int(d.get("seat", 0)) + 1, nick]
		line.add_theme_font_size_override("font_size", Settings.fs(15))
		line.add_theme_color_override("font_color",
			Color("90CAF9") if int(d.get("seat", -1)) == me else Color(1, 1, 1, 0.85))
		_lobby_players.add_child(line)

	var seats := int(room.get("seats", 0))
	var is_host := bool(room.get("isHost", false))
	var all_in := taken >= seats
	_lobby_all_in = all_in
	# Боты добирают пустые места сами (при заполнении или по таймеру
	# автостарта), поэтому кнопке «Начать» вместе со всеми не нужен —
	# нужны лишь двое живых.
	_lobby_ready = taken >= 2
	_start_btn.visible = is_host
	if is_host:
		_start_btn.text = "Начать партию" if _lobby_ready \
			else "Ждём игроков (%d из %d)" % [taken, seats]
	_update_buttons()
	_auto_hint.text = "Игра начнётся сама при заполнении или примерно через минуту; " \
		+ "свободные места займут боты."
	# Сервер всё равно не начнёт, пока не придут двое и не все будут на
	# связи, — но сказать об этом заранее честнее, чем ловить отказ.
	_set_note(_lobby_note,
		("Все на месте. %s" % ("Начинайте." if is_host else "Ждём, начнёт хост."))
		if all_in else ("Ждём остальных игроков (%d из %d)." % [taken, seats]),
		false)
	ScrollFix.relax(_lobby_players)


func _do_start() -> void:
	_set_busy("Начинаем…")
	var res := await Net.start_room()
	_set_busy("")
	if String(res.get("t", "")) == NetProtocol.GAME_STATE:
		# Хосту сервер шлёт ЛИЧНЫЙ ответ с его рукой, но не рассылку
		# (broadcastRoom исключает его место) — из-за этого _on_net_game_state
		# у хоста не срабатывает, и без явного перехода хост застревал в
		# лобби после нажатия «Начать партию». Сцену меняем здесь же.
		_started = true
		Net.plan_game(true)
		get_tree().change_scene_to_file("res://scenes/game.tscn")
		return
	_set_note(_lobby_note, _reason(res, "Не удалось начать партию"), true)


func _do_leave_room() -> void:
	await Net.leave_room()
	_goto_rooms()


# ----------------------------------------------------------------- возврат


## Баннер «вы всё ещё в комнате». Показывается на странице комнат, когда
## сервер сообщил, что игрок числится в комнате/партии (мягкий выход,
## вход в аккаунт при живом месте), а сам возвращать его не стал.
func _refresh_stuck(_room := {}) -> void:
	if _stuck_box == null:
		return
	var pending := Net.pending_room()
	if pending.is_empty():
		_stuck_box.visible = false
		return
	var code := String(pending.get("code", "?"))
	var playing := String(pending.get("state", "")) == "playing"
	var where := "игроки в сборе"
	if playing:
		where = "партия идёт"
	_stuck_label.text = "Вы всё ещё в комнате %s: %s. " % [code, where]
	_stuck_label.text += "Вернитесь в неё или покиньте насовсем."
	_return_btn.text = "Вернуться в партию" if playing else "Вернуться в комнату"
	_stuck_box.visible = true
	_update_buttons()


## «Вернуться» с баннера. Для партии — просто открываем сцену: свежее
## состояние она добудет сама (game.rejoin в _ready / после переподключения)
## и почистит pending. Для лобби — обычный вход по коду комнаты.
func _do_return_room() -> void:
	var pending := Net.pending_room()
	if String(pending.get("state", "")) == "playing":
		if not Net.is_online():
			# Без связи сцена партии в _ready ушла бы в локальную игру, а
			# это не «вернуться в партию». Лучше честно сказать, что связи нет.
			_set_note(_rooms_note, "Нет связи с сервером: вернуться в партию пока нельзя", true)
			return
		Net.plan_game(true)
		get_tree().change_scene_to_file("res://scenes/game.tscn")
		return
	if not String(pending.get("code", "")).is_empty():
		await _do_join(String(pending.get("code", "")), "")


## «Покинуть комнату» с баннера: полный выход из лобби или партии, место
## освобождается сразу, вернуть игрока в неё уже никто не сможет.
## true, если комната покинута; false, если сервер отказал и причина
## выведена в _rooms_note.
func _do_drop_room() -> bool:
	_set_busy("Покидаем комнату…")
	var res := await Net.drop_room()
	_set_busy("")
	if String(res.get("t", "")) == NetProtocol.ROOM_LEFT:
		return true
	_set_note(_rooms_note, _reason(res, "Не удалось покинуть комнату"), true)
	return false


## Точка входа из главного меню: «Вернуться в игру». Для партии — просто
## открываем сцену (состояние она добудет сама). Для комнаты — открываем
## сетевой экран и заходим в комнату, чтобы игрок увидел, куда пришёл.
func return_to_room() -> void:
	var pending := Net.pending_room()
	if String(pending.get("state", "")) == "playing":
		if not Net.is_online():
			# Без связи предупреждение должно быть видно: открываем сетевой
			# экран, и _do_return_room скажет там, что вернуться пока нельзя.
			open()
		_do_return_room()
		return
	open()
	_do_return_room()


## Точка входа из главного меню: «Покинуть комнату» — полный выход, место
## освобождается сразу, баннер и напоминание гаснут вместе с pending.
## Неудачу (например, нет связи) показываем на видимом сетевом экране,
## а не глотаем в скрытом.
func drop_room_now() -> void:
	if not await _do_drop_room():
		open()


# =============================================================== общие мелочи

func _set_page(page: VBoxContainer) -> void:
	for p in [_page_auth, _page_rooms, _page_lobby]:
		(p as Control).visible = p == page
	_update_status()


func _set_busy(text: String) -> void:
	_busy_flag = not text.is_empty()
	_set_note(_busy, text, false)
	_update_buttons()


func _all_buttons() -> Array:
	var out: Array = []
	_walk_buttons(self, out)
	return out


func _walk_buttons(node: Node, out: Array) -> void:
	if node is Button:
		out.append(node)
	for child in node.get_children():
		_walk_buttons(child, out)


## Состояние ВСЕХ кнопок вычисляется здесь, целиком, каждый раз заново.
##
## Раньше _set_busy гасил всё подряд, а оживлял по списку — и кнопки,
## в списк не попавшие («Назад», «Начать партию», «Войти» в строках
## списка комнат), после первого же запроса оставались мёртвыми навсегда.
## Списка тут принципиально нет: сначала гасим всё, потом точечно
## разрешаем то, что сейчас имеет смысл.
func _update_buttons() -> void:
	var busy := _busy_flag
	# Для входа нужен не просто открытый сокет, а приветствие сервера:
	# сокет открывается на целый круг раньше первого пакета. Кнопка,
	# разрешённая по одному сокету, предлагала игроку клик, который
	# заведомо не мог сработать.
	var linked := Net.is_greeted()
	var authed := Net.is_logged_in()
	for node in _all_buttons():
		(node as Button).disabled = busy
	# «Назад» остаётся живым даже во время запроса: из экрана, который
	# ждёт ответа сервера, должен быть выход.
	_back_btn.disabled = false
	_login_btn.disabled = busy or not linked
	_register_btn.disabled = busy or not linked
	_refresh_btn.disabled = busy or not linked
	_create_btn.disabled = busy or not authed
	_quick_btn.disabled = busy or not authed
	_join_btn.disabled = busy or not authed
	_start_btn.disabled = busy or not authed or not _lobby_ready
	_leave_btn.disabled = busy or not authed
	# Баннер «вы всё ещё в комнате»: кнопки живут, только когда есть что
	# возвращать. Внутри запроса (busy) они гаснут вместе со всеми.
	var stuck := not Net.pending_room().is_empty()
	_return_btn.disabled = busy or not stuck
	_drop_btn.disabled = busy or not stuck
	_join_code.editable = authed and not busy
	_join_pass.editable = authed and not busy


func _update_status() -> void:
	var text := "Сервер: %s" % Net.server_label()
	var warn := false
	if not Net.is_online():
		text = "Нет связи с сервером"
		warn = true
	elif not Net.is_greeted():
		# Сокет поднят, но сервер ещё не поздоровался. Молчать тут
		# нельзя: игрок видит серые кнопки и ждёт, что сломалось.
		text += " · подключение…"
	elif Net.is_logged_in():
		text += " · %s" % Net.session_nick()
	_set_note(_status, text, warn)


func _update_presence() -> void:
	for child in _server_box.get_children():
		_server_box.remove_child(child)
		child.free()
	var health := Net.servers.health()
	if health.is_empty():
		return
	for id in health:
		var info: Dictionary = health[id]
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 6)
		var dot := Label.new()
		var up := bool(info.get("online", false))
		dot.text = "●" if up else "○"
		dot.add_theme_font_size_override("font_size", Settings.fs(13))
		dot.add_theme_color_override("font_color",
			Color("66BB6A") if up else Color(1, 1, 1, 0.3))
		row.add_child(dot)
		var lab := Label.new()
		lab.text = String(info.get("name", id))
		lab.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		lab.add_theme_font_size_override("font_size", Settings.fs(13))
		lab.add_theme_color_override("font_color",
			Color(1, 1, 1, 0.85) if up else Color(1, 1, 1, 0.45))
		row.add_child(lab)
		var ms := Label.new()
		if up:
			ms.text = "%d мс" % int(info.get("ms", 0))
		else:
			ms.text = String(info.get("reason", "нет связи"))
		ms.add_theme_font_size_override("font_size", Settings.fs(12))
		ms.add_theme_color_override("font_color", Color(1, 1, 1, 0.5))
		row.add_child(ms)
		_server_box.add_child(row)
	ScrollFix.relax(_server_box)


func _reason(res: Dictionary, fallback: String) -> String:
	var text := String(res.get("reason", ""))
	if text.is_empty():
		match String(res.get("t", "")):
			"offline":
				return "Нет связи с сервером"
			"timeout":
				return "Сервер не ответил вовремя"
			NetProtocol.AUTH_ERR:
				return "Не удалось войти"
	return text if not text.is_empty() else fallback


func _set_note(label: Label, text: String, warn: bool) -> void:
	if label == null:
		return
	label.text = text
	label.visible = not text.is_empty()
	label.add_theme_color_override("font_color",
		Color("FF8A80") if warn else Color(1, 1, 1, 0.7))


func _apply_accent(button: Button, normal: Color, hover: Color, pressed: Color) -> void:
	for pair in [["normal", normal], ["hover", hover], ["pressed", pressed]]:
		var sb := StyleBoxFlat.new()
		sb.bg_color = pair[1]
		sb.set_corner_radius_all(10)
		sb.content_margin_left = 12.0
		sb.content_margin_right = 12.0
		sb.content_margin_top = 6.0
		sb.content_margin_bottom = 6.0
		button.add_theme_stylebox_override(String(pair[0]), sb)
	button.add_theme_color_override("font_color", Color.WHITE)
	button.add_theme_color_override("font_hover_color", Color.WHITE)
	button.add_theme_color_override("font_pressed_color", Color.WHITE)
	button.add_theme_color_override("font_disabled_color", Color(1, 1, 1, 0.35))


func _header(text: String, size: int = 17) -> Label:
	var lab := Label.new()
	lab.text = text
	lab.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	lab.add_theme_font_size_override("font_size", Settings.fs(size))
	lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	return lab


func _field(placeholder: String, secret := false) -> LineEdit:
	var edit := LineEdit.new()
	edit.placeholder_text = placeholder
	edit.custom_minimum_size = Vector2(0, Settings.touch(44))
	edit.add_theme_font_size_override("font_size", Settings.fs(15))
	edit.secret = secret
	return edit


func _button(text: String, size: int = 15) -> Button:
	var b := Button.new()
	b.text = text
	b.custom_minimum_size = Vector2(0, Settings.touch(48))
	b.add_theme_font_size_override("font_size", Settings.fs(size))
	return b


# =============================================================== сборка интерфейса

func _build() -> void:
	if _overlay != null:
		return
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	visible = false
	mouse_filter = Control.MOUSE_FILTER_STOP

	_overlay = ColorRect.new()
	_overlay.color = Color("12151C")
	_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(_overlay)

	# Разметка — MarginContainer на весь экран, а НЕ CenterContainer.
	#
	# CenterContainer отдаёт ребёнку ровно его минимальный размер. У
	# прокручиваемого ScrollContainer минимум по вертикали равен нулю
	# (иначе он не прокручивал бы), поэтому CenterContainer давал ему
	# высоту 0 — и весь экран превращался в один тёмный прямоугольник:
	# наложение рисуется, а содержимое обрезано по нулевой высоте.
	# Главное меню от этого спасалось вручную (main_menu._sync_scroll_min),
	# здесь такой подпорки не было ни разу.
	#
	# MarginContainer занимает весь экран и отдаёт ScrollContainer всё
	# оставшееся место, а тот раздаёт его содержимому. Размер считает
	# движок, подгонять его вручную больше не нужно и незачем: такой
	# подпор забывают переписать, стоит content_min измениться.
	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 14)
	margin.add_theme_constant_override("margin_right", 14)
	margin.add_theme_constant_override("margin_top", 12)
	margin.add_theme_constant_override("margin_bottom", 12)
	_overlay.add_child(margin)

	var scroll := ScrollContainer.new()
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	margin.add_child(scroll)

	# 496, а не 520: вертикальная полоса прокрутки съедает около 12 px, и
	# при минимуме 520 содержимое переставало бы помещаться и обрезалось
	# справа. Поля 14 + 14 плюс 496 — как раз 524, окно игры 576.
	var root := VBoxContainer.new()
	root.custom_minimum_size = Vector2(496, 0)
	root.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.add_theme_constant_override("separation", 10)
	# Контейнер лобби не ловит касание: иначе жест упирается в него и
	# список комнат/игроков не проскроллить пальцем.
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	scroll.add_child(root)

	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 10)
	root.add_child(head)
	head.add_child(_header("ИГРА ПО СЕТИ", 24))
	var head_space := Control.new()
	head_space.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	head.add_child(head_space)
	_back_btn = _button("Назад", 14)
	_back_btn.custom_minimum_size = Vector2(Settings.touch(110), Settings.touch(40))
	_back_btn.pressed.connect(close)
	head.add_child(_back_btn)

	_status = Label.new()
	_status.add_theme_font_size_override("font_size", Settings.fs(13))
	root.add_child(_status)
	_busy = Label.new()
	_busy.add_theme_font_size_override("font_size", Settings.fs(13))
	_busy.visible = false
	root.add_child(_busy)

	_server_box = VBoxContainer.new()
	_server_box.add_theme_constant_override("separation", 2)
	# Пустой контейнер без флагов схлопывается в ноль по ширине, и
	# строки серверов потом рисуются по содержимому, а не во всю
	# ширину экрана. Флаг задаётся сразу, на пустом.
	_server_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	root.add_child(_server_box)

	_page_auth = _build_auth()
	_page_rooms = _build_rooms()
	_page_lobby = _build_lobby()
	root.add_child(_page_auth)
	root.add_child(_page_rooms)
	root.add_child(_page_lobby)

	Net.connection_changed.connect(_on_net_connection)
	# Приветствие — момент, когда вход на сервере становится возможен:
	# кнопки «Войти»/«Создать аккаунт» считаются один раз в _build, пока
	# is_greeted() ещё false, и без подписки остаются серыми навсегда.
	Net.greeted.connect(_on_net_greeted)
	Net.room_state.connect(_on_net_room_state)
	Net.room_closed.connect(_on_net_room_left)
	Net.game_state.connect(_on_net_game_state)
	Net.pending_room_changed.connect(_refresh_stuck)
	_tick = Timer.new()
	_tick.wait_time = HEALTH_TICK_S
	_tick.autostart = false
	_tick.timeout.connect(_on_tick)
	add_child(_tick)
	_set_page(_page_auth)
	_refresh_stuck()
	_update_buttons()
	# Страницы лобби, строки серверов и комнат — контейнеры, а не кнопки:
	# без этого палец упирается в них и лобби не листается.
	ScrollFix.relax(root)


## Периодически освежаем «кто на связи». Отдельный таймер, а не ожидание
## события: сервер умирает молча, и без проверки меню минутами обещает
## связь с машиной, которой уже нет.
func _on_tick() -> void:
	if not visible:
		return
	_refresh_presence()
	if not Net.is_online() and Net.has_session():
		# Сокет молча упал, а сессия на месте — пробуем вернуться.
		# Именно is_online, а не is_linked: пока идёт рукопожатие, сокет
		# ещё не открыт, и проверка по is_linked сочла бы нормальную
		# попытку обрывом — а _do_connect на этом сокет пересоздал бы,
		# и подключение не началось бы никогда.
		_do_connect()


## Проверяет живость серверов и перерисовывает строку статуса.
## Отдельная от _update_presence, потому что проверка ходит в сеть и
## занимает до двух с половиной секунд — на это время экран должен
## остаться живым, а не замереть.
func _refresh_presence() -> void:
	await Net.servers.probe(false)
	if visible:
		_update_presence()


func _build_auth() -> VBoxContainer:
	var page := VBoxContainer.new()
	page.add_theme_constant_override("separation", 8)
	page.visible = false

	page.add_child(_header("Вход", 19))
	_login_edit = _field("логин")
	page.add_child(_login_edit)
	_pass_edit = _field("пароль", true)
	page.add_child(_pass_edit)
	page.add_child(_header("Если аккаунта нет", 15))
	_nick_edit = _field("имя в игре")
	page.add_child(_nick_edit)

	_login_btn = _button("Войти", 17)
	_login_btn.pressed.connect(_do_login)
	_apply_accent(_login_btn, Color("1565C0"), Color("1976D2"), Color("0D47A1"))
	page.add_child(_login_btn)

	_register_btn = _button("Создать аккаунт", 15)
	_register_btn.pressed.connect(_do_register)
	page.add_child(_register_btn)

	_auth_note = Label.new()
	_auth_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	# Метка с автопереносом без заданной ширины схлопывается до одного
	# пикселя: переносить ей не по чему, и текст обрезается по символу.
	# Ширину обязаны давать флагом, иначе причина «пустого места»
	# неотличима от «текста нет».
	_auth_note.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_auth_note.add_theme_font_size_override("font_size", Settings.fs(13))
	_auth_note.visible = false
	page.add_child(_auth_note)
	return page


func _build_rooms() -> VBoxContainer:
	var page := VBoxContainer.new()
	page.add_theme_constant_override("separation", 8)
	page.visible = false

	# --- «вы всё ещё в комнате»: мягко вышедшего из партии игрока сервер
	# не возвращает сам, но и не выписывает молча — место держится за ним.
	# Баннер показывает это прямо на странице комнат и отдаёт два выхода:
	# вернуться или покинуть комнату с концами.
	_stuck_box = PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color("3E2723", 0.95)
	sb.corner_radius_top_left = 8
	sb.corner_radius_top_right = 8
	sb.corner_radius_bottom_left = 8
	sb.corner_radius_bottom_right = 8
	sb.content_margin_left = 12
	sb.content_margin_right = 12
	sb.content_margin_top = 10
	sb.content_margin_bottom = 10
	_stuck_box.add_theme_stylebox_override("panel", sb)
	_stuck_box.visible = false
	page.add_child(_stuck_box)
	var stuck_inner := VBoxContainer.new()
	stuck_inner.add_theme_constant_override("separation", 6)
	_stuck_box.add_child(stuck_inner)
	_stuck_label = Label.new()
	_stuck_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_stuck_label.add_theme_font_size_override("font_size", Settings.fs(15))
	_stuck_label.add_theme_color_override("font_color", Color("FFE0B2"))
	stuck_inner.add_child(_stuck_label)
	var stuck_row := HBoxContainer.new()
	stuck_row.add_theme_constant_override("separation", 8)
	stuck_inner.add_child(stuck_row)
	_return_btn = _button("Вернуться", 14)
	_return_btn.pressed.connect(_do_return_room)
	_apply_accent(_return_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	stuck_row.add_child(_return_btn)
	_drop_btn = _button("Покинуть комнату", 14)
	_drop_btn.pressed.connect(_do_drop_room)
	stuck_row.add_child(_drop_btn)

	# --- создать
	page.add_child(_header("Своя комната", 19))
	page.add_child(_header("Сервер выбирается случайно, чтобы комнаты шли на обе машины", 12))
	var create_row := HBoxContainer.new()
	create_row.add_theme_constant_override("separation", 8)
	page.add_child(create_row)
	_seats_option = OptionButton.new()
	_seats_option.custom_minimum_size = Vector2(Settings.touch(110), Settings.touch(44))
	Settings.style_option(_seats_option, 15)
	for n in range(2, 6):
		_seats_option.add_item("мест: %d" % n)
		_seats_option.set_item_id(_seats_option.get_item_count() - 1, n)
	_seats_option.select(1)
	create_row.add_child(_seats_option)
	_room_name = _field("название (необязательно)")
	_room_name.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	create_row.add_child(_room_name)
	_room_pass = _field("пароль (необязательно)", true)
	_room_pass.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	create_row.add_child(_room_pass)
	_require_30 = CheckBox.new()
	_require_30.text = "Первый ход: минимум 30 очков"
	_require_30.button_pressed = Settings.require_30
	_require_30.add_theme_font_size_override("font_size", Settings.fs(15))
	_require_30.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	page.add_child(_require_30)
	_create_btn = _button("Создать", 16)
	_create_btn.pressed.connect(_do_create)
	_apply_accent(_create_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	page.add_child(_create_btn)

	_quick_btn = _button("Быстрый матч", 15)
	_quick_btn.pressed.connect(_do_quick)
	page.add_child(_quick_btn)

	# --- список
	page.add_child(_header("Все комнаты", 19))
	var head := HBoxContainer.new()
	head.add_theme_constant_override("separation", 8)
	page.add_child(head)
	_rooms_note = Label.new()
	_rooms_note.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	# Тексты сюда длинные («Показаны комнаты без …, остальные серверы не
	# ответили»), и без переноса они просто уезжают за край строки.
	_rooms_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_rooms_note.add_theme_font_size_override("font_size", Settings.fs(13))
	head.add_child(_rooms_note)
	_refresh_btn = _button("Обновить", 13)
	_refresh_btn.custom_minimum_size = Vector2(Settings.touch(120), Settings.touch(40))
	_refresh_btn.pressed.connect(_refresh_rooms)
	head.add_child(_refresh_btn)

	_rooms_box = VBoxContainer.new()
	_rooms_box.add_theme_constant_override("separation", 4)
	_rooms_box.custom_minimum_size = Vector2(0, 140)
	_rooms_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	page.add_child(_rooms_box)

	# --- по коду
	page.add_child(_header("Войти по коду", 15))
	var code_row := HBoxContainer.new()
	code_row.add_theme_constant_override("separation", 8)
	page.add_child(code_row)
	_join_code = _field("код")
	_join_code.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	code_row.add_child(_join_code)
	_join_pass = _field("пароль", true)
	_join_pass.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	code_row.add_child(_join_pass)
	_join_btn = _button("Войти", 15)
	_join_btn.pressed.connect(func(): _do_join(_join_code.text.strip_edges().to_upper(), ""))
	page.add_child(_join_btn)

	_logout_row(page)
	return page


func _logout_row(page: VBoxContainer) -> void:
	var row := HBoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_END
	page.add_child(row)
	var out := _button("Выйти из аккаунта", 13)
	out.custom_minimum_size = Vector2(200, Settings.touch(40))
	out.pressed.connect(_do_logout)
	row.add_child(out)


func _build_lobby() -> VBoxContainer:
	var page := VBoxContainer.new()
	page.add_theme_constant_override("separation", 8)
	page.visible = false

	_lobby_code = _header("", 24)
	page.add_child(_lobby_code)
	_lobby_seats = Label.new()
	_lobby_seats.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_lobby_seats.add_theme_font_size_override("font_size", Settings.fs(13))
	_lobby_seats.add_theme_color_override("font_color", Color(1, 1, 1, 0.6))
	page.add_child(_lobby_seats)
	_lobby_players = VBoxContainer.new()
	_lobby_players.add_theme_constant_override("separation", 6)
	_lobby_players.custom_minimum_size = Vector2(0, 160)
	_lobby_players.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	page.add_child(_lobby_players)

	_auto_hint = Label.new()
	_auto_hint.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_auto_hint.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_auto_hint.add_theme_font_size_override("font_size", Settings.fs(12))
	_auto_hint.add_theme_color_override("font_color", Color(1, 1, 1, 0.5))
	page.add_child(_auto_hint)

	_lobby_note = Label.new()
	_lobby_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_lobby_note.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_lobby_note.add_theme_font_size_override("font_size", Settings.fs(13))
	_lobby_note.visible = false
	page.add_child(_lobby_note)

	_start_btn = _button("Начать партию", 18)
	_start_btn.pressed.connect(_do_start)
	_apply_accent(_start_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	page.add_child(_start_btn)

	_leave_btn = _button("Выйти из комнаты", 15)
	_leave_btn.pressed.connect(_do_leave_room)
	page.add_child(_leave_btn)
	return page


# =============================================================== общие мелочи
