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
	_check_ya_poll_dispatch()
	_check_web_fast_path()
	_check_ya_benefit_modal()
	_check_tab_padding()


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


## Web-вход без промежуточной страницы (требования Яндекс Игр 1–7):
## маршрут, тихий профиль раньше диалога, модалка с выбором, гость.
func _check_web_fast_path() -> void:
	var src := _lobby_source()
	if src.is_empty():
		return
	var enter_auth := _func_body(src, "func _enter_auth")
	check(enter_auth.contains('OS.has_feature("web")')
		and enter_auth.contains("_enter_web_fast"),
		"на Web страница входа заменена быстрым путём")
	var fast := _func_body(src, "func _enter_web_fast")
	check(not fast.contains("open_auth_dialog"),
		"быстрый путь сам диалог не открывает (только _do_ya_login по выбору)")
	check(fast.contains("authorized") and fast.contains("_do_ya_login()"),
		"тихий профиль без диалога ведёт к молчаливому входу")
	check(fast.contains("_show_ya_benefit()"),
		"без готового профиля — модалка с пользой")
	var build := _func_body(src, "func _build_ya_benefit")
	check(build.contains("Войти через Яндекс") and build.contains("Без входа"),
		"в модалке обе кнопки: вход и гость")
	var no := _func_body(src, "func _on_ya_benefit_no")
	check(no.contains("close()"), "отказ закрывает лобби в меню, ничего не стирая")
	var yes := _func_body(src, "func _on_ya_benefit_yes")
	check(yes.contains("_do_ya_login()"), "согласие идёт штатным входом")


## Модалка живьём: видна, кнопки на месте, гость закрывает лобби.
func _check_ya_benefit_modal() -> void:
	var lobby := inst
	lobby.call("_show_ya_benefit")
	var modal = inst.get("_ya_modal")
	check(modal != null and (modal as Control).visible, "модалка пользы показывается")
	check(_find_modal_button(modal, "Войти через Яндекс") != null,
		"кнопка входа на месте")
	check(_find_modal_button(modal, "Без входа") != null,
		"кнопка гостя на месте")
	lobby.call("_on_ya_benefit_yes")
	check(not (modal as Control).visible, "согласие прячет модалку")
	check(bool(inst.get("_ya_busy")), "согласие запускает вход")
	lobby.call("_show_ya_benefit")
	lobby.call("_on_ya_benefit_no")
	check(not (modal as Control).visible, "отказ прячет модалку")
	check(not inst.visible, "отказ возвращает в главное меню")


## Вкладки комнат с широкими боковыми полями (палец попадает).
func _check_tab_padding() -> void:
	for name in ["_tab_create_btn", "_tab_code_btn"]:
		var b = inst.get(name) as Button
		if b == null:
			check(false, "вкладка %s существует" % name)
			continue
		var sb := b.get_theme_stylebox("normal")
		var left := sb.content_margin_left if sb != null else -1.0
		check(left >= 28.0, "у %s боковые поля %.0f, надо 28" % [name, left])


func _find_modal_button(node: Node, text: String) -> Button:
	if node is Button and String((node as Button).text) == text:
		return node as Button
	for child in node.get_children():
		var found := _find_modal_button(child, text)
		if found != null:
			return found
	return null


func _lobby_source() -> String:
	var f := FileAccess.open("res://scripts/ui/online_lobby.gd", FileAccess.READ)
	if f == null:
		check(false, "online_lobby.gd читается")
		return ""
	var src := f.get_as_text()
	f.close()
	return src


func _func_body(src: String, sig: String) -> String:
	var start := src.find(sig)
	if start < 0:
		check(false, "есть " + sig)
		return ""
	var rest := src.substr(start + sig.length())
	var next := rest.find("\nfunc ")
	if next < 0:
		return rest
	return rest.left(next)


## Диспетчер опроса SDK в лобби: kind "sdk" обязан уходить в
## poll_sdk_ready, а не падать в poll_player (у него нет ключа "ready").
## Без этой ветки _do_ya_login всегда считал SDK неготовым и молча
## отказывал даже под dev-proxy со стабом («ничего не происходит»).
func _check_ya_poll_dispatch() -> void:
	var f := FileAccess.open("res://scripts/ui/online_lobby.gd", FileAccess.READ)
	if f == null:
		check(false, "online_lobby.gd читается")
		return
	var src := f.get_as_text()
	f.close()
	var i_sdk := src.find('== "sdk"')
	var i_ready := src.find("poll_sdk_ready", i_sdk)
	var i_player := src.find("poll_player", i_sdk)
	check(i_sdk >= 0 and i_ready >= 0 and (i_player < 0 or i_ready < i_player),
		"ветка \"sdk\" ведёт в poll_sdk_ready до poll_player")
	check(src.contains('_ysdk_call("ensure_sdk")'),
		"_do_ya_login сам просит SDK (не только главное меню)")


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