extends SceneTree

# ==============================================================
#  Проверка перехода после входа/регистрации в сетевом меню.
#
#  Net.login/Net.register возвращают не сырое сообщение сервера, а
#  обёртку {ok:true, user} / {ok:false, reason}. Лобби раньше сверяло
#  поле "t" (=== auth.ok), которого в обёртке нет: успешный вход
#  оставлял игрока на форме входа («ничего не происходит»), хотя
#  сессия уже сохранена — комнаты появлялись только после закрытия
#  и повторного открытия экрана.
#
#  Тест гоняет _after_auth с подставленными ответами, без сети:
#  список комнат подкладывается, чтобы _goto_rooms не ходил на сервер.
#
#  Запуск:
#     godot --headless --path . --script res://tests/check_auth_flow.gd
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
			net.set("_state", 3)
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
			# Подкладываем готовый список комнат, чтобы _goto_rooms не
			# дёргал серверы (тест автономный).
			inst.set("_rooms", [{
				"code": "X1", "name": "Комната", "filled": 1, "seats": 2,
				"serverName": "S", "server": "s", "require30": false,
				"hasPassword": false,
			}])
		1:
			phase = 2
			_checks()
			quit(0 if fails == 0 else 1)


func _page_visible(name: String) -> bool:
	var p = inst.get(name)
	return (p as Control).visible if p != null else false


func _auth_note_text() -> String:
	var note = inst.get("_auth_note")
	return String(note.text) if note != null else ""


func _checks() -> void:
	var lobby := inst
	var before := _page_visible("_page_auth")
	check(before, "auth page is the starting page")

	# 1. Успешный вход (обёртка Net.login) открывает страницу комнат.
	lobby.call("_after_auth", { "ok": true, "user": {} }, "Вход выполнен")
	check(_page_visible("_page_rooms"), "successful login switches to rooms page")
	check(not _page_visible("_page_auth"), "auth page hidden after login")

	# 2. Отказ с причиной «Неверный пароль» не уводит со страницы и
	#    показывает именно причину сервера.
	lobby.call("_enter_auth")
	lobby.call("_after_auth", { "ok": false, "reason": "Неверный пароль" }, "Вход выполнен")
	check(_page_visible("_page_auth"), "failed login stays on auth page")
	check(_auth_note_text() == "Неверный пароль",
		"wrong password shows server reason, got: %s" % _auth_note_text())

	# 3. Неизвестный логин — другая причина, тоже показывается.
	lobby.call("_after_auth", { "ok": false, "reason": "Логин не найден" }, "Вход выполнен")
	check(_auth_note_text() == "Логин не найден",
		"unknown login shows server reason, got: %s" % _auth_note_text())

	# 4. Сбой связи не выглядит как «неправильный логин или пароль».
	lobby.call("_after_auth", { "ok": false, "reason": "нет связи с сервером" }, "Вход выполнен")
	check(_auth_note_text() == "нет связи с сервером",
		"offline shows offline reason, got: %s" % _auth_note_text())

	# 5. Успешная регистрация тоже открывает комнаты.
	lobby.call("_after_auth", { "ok": true, "user": {} }, "Аккаунт создан")
	check(_page_visible("_page_rooms"), "successful register switches to rooms page")