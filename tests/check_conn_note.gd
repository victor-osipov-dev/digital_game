extends SceneTree

# ==============================================================
#  Проверка надписи о связи и кликабельности кнопок входа в
#  сетевом меню.
#
#  connection_changed приходит с connected == false и при НАСТОЯЩЕМ
#  обрыве, и при рукопожатии: сокет уже создан, но ещё не открыт.
#  Меню раньше трактовало любое false как «нет связи» и писало красное
#  «Нет связи с сервером: подключение к России (ru)…» — рядом с живым
#  пингом того же сервера. Надпись ещё и залипала на странице входа.
#
#  Кнопки «Войти» и «Создать аккаунт» считались один раз в _build,
#  когда is_greeted() ещё false, и без подписки на greeted оставались
#  серыми навсегда, даже после приветствия.
#
#  Тест гоняет обработчик напрямую, подставляя состояние Net:
#  CONNECTING, обрыв, восстановление и приветствие.
#
#  Запуск:
#     godot --headless --path . --script res://tests/check_conn_note.gd
# ==============================================================

var fails := 0
var inst: Control = null
var phase := 0


func check(cond: bool, msg: String) -> void:
	if cond:
		print("  ok  " + msg)
	else:
		fails += 1
		printerr("FAIL  " + msg)


func _initialize() -> void:
	process_frame.connect(_on_frame)


func _on_frame() -> void:
	match phase:
		0:
			phase = 1
			var net := root.get_node_or_null("Net")
			if net == null:
				printerr("FAIL  no Net autoload")
				quit(1)
				return
			# Подменяем состояние Net, чтобы не ходить в сеть: проверка
			# про кнопки и надпись, а не про доступность серверов.
			net.set("_state", net.get("_state"))
			net.set("_greeted", false)
			var script := load("res://scripts/ui/online_lobby.gd") as GDScript
			if script == null:
				printerr("FAIL  cannot load online_lobby.gd")
				quit(1)
				return
			inst = script.new() as Control
			if inst == null:
				printerr("FAIL  cannot instantiate OnlineLobby")
				quit(1)
				return
			root.add_child(inst)
			inst.visible = true
		1:
			phase = 2
			_checks()
			quit(0 if fails == 0 else 1)


## Ставит Net в нужное состояние: 1 = CONNECTING, 0 = OFFLINE,
## сокет при CONNECTING непустой, иначе is_online() врёт.
func _set_state(connecting: bool) -> void:
	var net := root.get_node_or_null("Net")
	if connecting:
		net.set("_state", 1)
		net.set("_peer", WebSocketPeer.new())
	else:
		net.set("_state", 0)
		net.set("_peer", null)


func _set_greeted(g: bool) -> void:
	var net := root.get_node_or_null("Net")
	net.set("_greeted", g)


func _busy_text() -> String:
	var busy = inst.get("_busy")
	return String(busy.text) if busy != null else ""


func _login_enabled() -> bool:
	return not (inst.get("_login_btn") as Button).disabled


func _register_enabled() -> bool:
	return not (inst.get("_register_btn") as Button).disabled


func _checks() -> void:
	var lobby := inst
	check(lobby.get("_busy") != null, "busy note label exists")
	check(lobby.get("_login_btn") != null, "login button exists")
	check(lobby.get("_register_btn") != null, "register button exists")

	# 0. До приветствия кнопки входа неактивны: вход ещё невозможен.
	_set_state(true)
	_set_greeted(false)
	lobby.call("_enter_auth")
	check(not _login_enabled(), "login disabled before greeting")
	check(not _register_enabled(), "register disabled before greeting")

	# 0.5 Приветствие пришло — кнопки входа оживают. Раньше тут был
	#     баг: _update_buttons вызывался только в _build, и кнопки
	#     оставались серыми навсегда.
	_set_greeted(true)
	lobby.call("_on_net_greeted", {})
	check(_login_enabled(), "login enabled after greeting")
	check(_register_enabled(), "register enabled after greeting")

	# 1. Рукопожатие: сокет создан, но ещё не открыт. Красного
	#    «Нет связи» быть не должно — связи ещё нет, но и не было.
	_set_state(true)
	_set_greeted(true)
	lobby.call("_on_net_connection", false, "подключение к России (ru)…")
	check(not _busy_text().contains("Нет связи"),
		"handshake is not reported as lost connection, got: %s" % _busy_text())
	check(_login_enabled(), "login stays enabled during handshake")

	# 2. Настоящий обрыв: сокета нет, состояние OFFLINE.
	_set_state(false)
	lobby.call("_on_net_connection", false, "соединение оборвано")
	check(_busy_text().contains("Нет связи"),
		"real disconnect still warns, got: %s" % _busy_text())

	# 3. Восстановление: красная надпись обязана уйти, иначе она
	#    переживёт удачный переподключительный сеанс.
	_set_state(true)
	_set_greeted(true)
	lobby.call("_on_net_connection", true, "Россия")
	check(_busy_text().is_empty(),
		"note cleared after reconnect, got: %s" % _busy_text())
	check(_login_enabled(), "login enabled after reconnect")

	# 4. Занятая надпись — про другой запрос, её нельзя затирать.
	_set_state(true)
	lobby.call("_set_busy", "Собираем список комнат…")
	lobby.call("_on_net_connection", true, "Россия")
	check(_busy_text() == "Собираем список комнат…",
		"busy note of a pending request survives reconnect, got: %s" % _busy_text())

	# 5. Страница входа не должна тащить на себе надпись о связи.
	_set_state(false)
	lobby.call("_on_net_connection", false, "соединение оборвано")
	lobby.call("_enter_auth")
	check(_busy_text().is_empty(),
		"auth page carries no connection note, got: %s" % _busy_text())

	_set_state(false)