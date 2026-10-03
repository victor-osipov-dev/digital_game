extends SceneTree

const Lang := preload("res://scripts/core/lang.gd")

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


func _auth_note_visible() -> bool:
	var note = inst.get("_auth_note")
	return bool(note.visible) if note != null else false


func _checks() -> void:
	var lobby := inst
	var before := _page_visible("_page_auth")
	check(before, "auth page is the starting page")

	# 1. Успешный вход (обёртка Net.login) открывает страницу комнат.
	lobby.call("_after_auth", { "ok": true, "user": {} }, "Вход выполнен")
	check(_page_visible("_page_rooms"), "successful login switches to rooms page")
	check(not _page_visible("_page_auth"), "auth page hidden after login")

	# 2. Отказ входа не уводит со страницы и показывает именно причину
	#    сервера. Сервер намеренно не различает несуществующий логин и
	#    неверный пароль, чтобы ответы не выдавали список логинов.
	lobby.call("_enter_auth")
	lobby.call("_after_auth", { "ok": false, "reason": "Неверный логин или пароль" }, "Вход выполнен")
	check(_page_visible("_page_auth"), "failed login stays on auth page")
	check(_auth_note_text() == "Неверный логин или пароль",
		"failed login shows server reason, got: %s" % _auth_note_text())

	# 3. Та же общая причина показывается и во втором случае.
	lobby.call("_after_auth", { "ok": false, "reason": "Неверный логин или пароль" }, "Вход выполнен")
	check(_auth_note_text() == "Неверный логин или пароль",
		"unknown login shows the same server reason, got: %s" % _auth_note_text())

	# 4. Сбой связи не выглядит как «неправильный логин или пароль».
	lobby.call("_after_auth", { "ok": false, "reason": "нет связи с сервером" }, "Вход выполнен")
	check(_auth_note_text() == "нет связи с сервером",
		"offline shows offline reason, got: %s" % _auth_note_text())

	# 5. Успешная регистрация тоже открывает комнаты.
	lobby.call("_after_auth", { "ok": true, "user": {} }, "Аккаунт создан")
	check(_page_visible("_page_rooms"), "successful register switches to rooms page")
	_check_password_remembered()
	_check_auth_error_matrix()


## Матрица ошибок входа/регистрации: каждая причина — и клиентская
## проверка, и любая серверная (валидация accounts.js, ошибки хаба,
## транспорт) — обязана показаться игроку ВИДИМОЙ строкой, а не осесть
## в скрытой метке. Раньше _auth_note никто не включал обратно, и все
## эти тексты были невидимы при зелёном .text.
func _check_auth_error_matrix() -> void:
	var lobby := inst
	lobby.call("_enter_auth")
	# Клиентские проверки (возврат до сети — вызов без await безопасен).
	var login_edit = inst.get("_login_edit")
	var pass_edit = inst.get("_pass_edit")
	var nick_edit = inst.get("_nick_edit")
	login_edit.text = ""
	pass_edit.text = ""
	lobby.call("_do_login")
	check(_auth_note_text() == "Заполните логин и пароль",
		"пустой вход отклоняется до сети, got: %s" % _auth_note_text())
	check(_auth_note_visible(), "подсказка про пустые поля ВИДНА")
	login_edit.text = "bob"
	nick_edit.text = ""
	lobby.call("_do_register")
	check(_auth_note_text() == "Заполните логин, пароль и имя",
		"пустая регистрация отклоняется до сети, got: %s" % _auth_note_text())
	check(_auth_note_visible(), "подсказка про пустые поля регистрации ВИДНА")
	# Порог — как на сервере (6), а не 4: пароль из 5 символов раньше
	# уходил в сеть и возвращался отказом оттуда.
	nick_edit.text = "Боб"
	pass_edit.text = "12345"
	lobby.call("_do_register")
	check(_auth_note_text() == "Пароль: минимум 6 символов",
		"короткий пароль ловится клиентом, got: %s" % _auth_note_text())
	check(_auth_note_visible(), "подсказка про короткий пароль ВИДНА")
	# Все серверные причины — дословно и видимо.
	var server_reasons := [
		"Введите логин",
		"Логин: 3–20 символов, латиница, цифры, _ . -",
		"Пароль: минимум 6 символов",
		"Пароль: максимум 200 символов",
		"Введите ник",
		"Ник: максимум 24 символа",
		"Ник: без управляющих символов",
		"Ник: это служебное имя",
		"Ник: ботом может называться только бот",
		"Неверный логин или пароль",
		"Сессия недействительна",
		"Старый пароль неверен",
		"Этот логин уже занят",
		"Сначала войдите",
		"Соединение только для чтения",
		"Слишком много попыток. Подождите минуту.",
		"Внутренняя ошибка сервера",
	]
	for reason in server_reasons:
		lobby.call("_after_auth", { "ok": false, "reason": reason }, "X")
		if _auth_note_text() != reason or not _auth_note_visible():
			check(false, "серверная причина показана: %s (got: %s, visible=%s)"
				% [reason, _auth_note_text(), str(_auth_note_visible())])
	check(true, "все %d серверных причин видны дословно" % server_reasons.size())
	# Транспортные формы и пустой ответ — с запасным текстом, но тоже видно.
	lobby.call("_after_auth", { "t": "offline", "reason": "нет связи с сервером" }, "X")
	check(_auth_note_text() == "нет связи с сервером" and _auth_note_visible(),
		"обрыв связи показан, got: %s" % _auth_note_text())
	lobby.call("_after_auth", { "t": "timeout", "reason": "сервер не ответил вовремя" }, "X")
	check(_auth_note_text() == "сервер не ответил вовремя" and _auth_note_visible(),
		"таймаут показан, got: %s" % _auth_note_text())
	lobby.call("_after_auth", { "t": "auth.err", "reason": "" }, "X")
	check(_auth_note_text() == "Не удалось войти" and _auth_note_visible(),
		"пустая причина заменена запасной и видна, got: %s" % _auth_note_text())
	lobby.call("_after_auth", {}, "X")
	check(_auth_note_text() == "Не удалось войти" and _auth_note_visible(),
		"пустой ответ заменён запасным и виден, got: %s" % _auth_note_text())
	# Ошибка — красная, возврат на страницу входа — чистая и скрытая.
	var note = inst.get("_auth_note")
	check(note.get_theme_color("font_color") == Color("FF8A80"),
		"ошибка подсвечена красным")
	lobby.call("_enter_auth")
	check(_auth_note_text().is_empty() and not _auth_note_visible(),
		"вход на страницу гасит строку")
	# Серверная причина переводится на странице входа.
	Lang.set_lang("en")
	lobby.call("_after_auth",
		{ "ok": false, "reason": "Неверный логин или пароль" }, "X")
	check(_auth_note_text() == "Wrong login or password" and _auth_note_visible(),
		"серверная причина переведена, got: %s" % _auth_note_text())
	Lang.set_lang("ru")


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