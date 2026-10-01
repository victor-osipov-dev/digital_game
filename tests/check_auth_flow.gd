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
#  Тут же проверяется запоминание пароля на устройстве: он лежит
#  в user://session.json рядом с токеном (не в настройках игры),
#  подставляется в поле на странице входа и стирается при выходе.
#  Смена сцены с отсоединённого узла проверяется отдельно, в
#  check_scene_guard (нужен stderr дочернего процесса).
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
	_check_password_remembered()


## Пароль помнится на устройстве: пишется в сессию при наборе в поле,
## переживает перезапуск и подставляется обратно; при выходе стирается.
func _check_password_remembered() -> void:
	var net := root.get_node_or_null("Net")
	var pass_edit = inst.get("_pass_edit")
	if net == null or pass_edit == null:
		check(false, "Net и поле пароля на месте")
		return
	var session_path := "user://session.json"
	var backup := ""
	if FileAccess.file_exists(session_path):
		backup = FileAccess.get_file_as_string(session_path)
	# Образец пароля, не настоящий: в выводе теста секретов быть не должно.
	const SECRET := "pass-7Hq2"
	net.call("remember_password", SECRET)
	check(net.call("session_password") == SECRET, "пароль запомнен в сессии")

	# Переживает перезапуск: читаем файл заново, как это делает игра.
	var session_script = load("res://scripts/net/session.gd")
	var session = session_script.call("load_from_disk")
	check(String(session.get("password")) == SECRET,
		"пароль пережил перезапуск (лежит в session.json)")

	# Набор в поле тоже запоминает: сигнал text_changed ведёт в Net.
	pass_edit.text = ""
	pass_edit.text = SECRET
	check(net.call("session_password") == SECRET, "набор в поле запомнил пароль")

	# Подставляется обратно при возврате на страницу входа.
	pass_edit.text = ""
	inst.call("_enter_auth")
	check(String(pass_edit.text) == SECRET, "пароль подставлен в поле входа")

	# Выход из аккаунта пароль стирает, и на диске его не остаётся.
	net.get("_session").call("clear")
	check(net.call("session_password").is_empty(), "выход стирает пароль")
	check(not FileAccess.file_exists(session_path)
		or not FileAccess.get_file_as_string(session_path).contains(SECRET),
		"в session.json пароля не осталось")

	# Возвращаем файл сессии как был — тест не должен оставлять следов.
	if backup.is_empty():
		if FileAccess.file_exists(session_path):
			DirAccess.remove_absolute(session_path)
	else:
		var f := FileAccess.open(session_path, FileAccess.WRITE)
		if f != null:
			f.store_string(backup)
			f.close()