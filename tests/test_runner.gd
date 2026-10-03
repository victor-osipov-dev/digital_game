extends Node

# Автотесты, которые гоняют игру ЧЕРЕЗ её интерфейс: настоящие поля, кнопки
# и экраны OnlineLobby, живой сетевой сервер (WSS + зашитый сертификат).
# Регистрация аккаунтов и комнат — тоже через интерфейс.
#
# Запуск (проект уже импортирован, в папке есть .godot):
#   godot --headless --path . res://tests/test_runner.tscn -- --mode=smoke
#   godot --headless --path . res://tests/test_runner.tscn -- --mode=online --ts=<метка>
#   godot --headless --path . res://tests/test_runner.tscn -- --mode=host --ts=<метка>
#   godot --headless --path . res://tests/test_runner.tscn -- --mode=guest --ts=<метка>
#
# Для полноценного матча запускаются ДВА процесса с одинаковой меткой ts:
# host создаёт комнату на 2 места, guest находит её по имени в списке и
# входит; заполнив комнату, гость запускает партию сам (автостарт), и оба
# процесса уходят в сцену партии. Выходной код процесса: 0 — все шаги PASS,
# иначе 1.

const PASSWORD := "test1234"

var _exit_code := 0


var _mode := "smoke"
var _ts := "0"


func _ready() -> void:
	print("TEST  INFO | Godot %s | test_runner ready" % Engine.get_version_info().get("string", "?"))
	print("TEST  INFO | args=%s" % str(OS.get_cmdline_user_args()))
	for a in OS.get_cmdline_user_args():
		var parts := a.split("=", true, 1)
		if parts.size() != 2:
			continue
		match parts[0]:
			"--mode":
				_mode = parts[1]
			"--ts":
				_ts = parts[1]
	# Собственные узлы в _ready ещё нельзя добавлять в дерево: root в это
	# время сам разбирается с детьми. Стартуем со следующего кадра.
	call_deferred("_run")


func _run() -> void:
	# Мы — текущая сцена, и игра сама делает change_scene_to_file: она бы
	# освободила нас вместе с висящими корутинами. Отцепляемся, оставаясь
	# обычным узлом дерева, чтобы дождаться смены сцены и проверить её.
	var tree: SceneTree = get_tree()
	tree.root.remove_child(self)
	tree.root.add_child(self)
	tree.current_scene = null
	match _mode:
		"smoke":
			await _run_smoke()
		"online":
			await _run_online(_ts)
		"host":
			await _run_match_host(_ts)
		"guest":
			await _run_match_guest(_ts)
		_:
			_step("mode", false, "неизвестный режим %s" % _mode)
	print("TEST  DONE | exit=%d" % _exit_code)
	get_tree().quit(_exit_code)


func _step(name: String, ok: bool, detail: String = "") -> void:
	var tag := "PASS" if ok else "FAIL"
	var msg := "TEST  %s | %s" % [tag, name]
	if not detail.is_empty():
		msg += " | " + detail
	print(msg)
	if not ok:
		_exit_code = 1


func _wait_for(timeout_s: float, check: Callable) -> bool:
	var deadline := Time.get_ticks_msec() + int(timeout_s * 1000.0)
	while Time.get_ticks_msec() < deadline:
		if check.call():
			return true
		await get_tree().process_frame
	return false


## Ждёт заметку списка комнат. Раньше это место падало на гонке: фоновая
## проверка живости серверов (старт в open()) могла ещё не закончиться, и
## _load_rooms показывал ложное «нет связи ни с одним сервером». Теперь
## servers.probe() дожидается идущую проверку, и заметка честная.
func _await_rooms_ready(lobby: OnlineLobby) -> bool:
	return await _wait_for(10, func(): return not lobby._rooms_note.text.is_empty())


func _scene_is_game() -> bool:
	return get_tree().current_scene != null and get_tree().current_scene.name == "Game"


func _new_menu() -> Node:
	var menu = load("res://scenes/main_menu.tscn").instantiate()
	get_tree().root.add_child(menu)
	return menu


# ------------------------------------------------------------------- smoke

func _run_smoke() -> void:
	# Дефолты настроек: 2 — «Большой» текст, 5 — «Максимум», 1 — «Средний»
	# бот. Файл настроек на этой машине может перекрыть дефолты сохранёнными
	# значениями, поэтому на время проверки прячем его и восстанавливаем.
	var path := "user://settings.cfg"
	var existed := FileAccess.file_exists(path)
	var backup := FileAccess.get_file_as_string(path) if existed else ""
	if existed:
		DirAccess.open("user://").remove("settings.cfg")
	Settings.text_scale = 2
	Settings.tile_step = 5
	Settings.bot_level = 1
	Settings.load_settings()
	_step("smoke: дефолты настроек",
		Settings.text_scale == 2 and Settings.tile_step == 5 and Settings.bot_level == 1,
		"text=%d tile=%d bot=%d" % [Settings.text_scale, Settings.tile_step, Settings.bot_level])
	if existed:
		var f := FileAccess.open(path, FileAccess.WRITE)
		if f != null:
			f.store_string(backup)
			f.close()
	Settings.load_settings()

	var menu = _new_menu()
	await get_tree().process_frame
	_step("smoke: главное меню строится, сетевой экран готов",
		menu.online_lobby != null, "")
	menu.queue_free()
	await get_tree().process_frame

	var game = load("res://scenes/game.tscn").instantiate()
	get_tree().root.add_child(game)
	await get_tree().create_timer(0.4).timeout
	_step("smoke: экран партии строится",
		game.state != null and game.state.players.size() >= Settings.MIN_PLAYERS,
		"игроков %d" % game.state.players.size())
	game.queue_free()


# -------------------------------------------------- online: один клиент

func _run_online(ts: String) -> void:
	var menu = _new_menu()
	var lobby: OnlineLobby = menu.online_lobby
	menu._on_online_pressed()

	_step("online: сервер приветствует",
		await _wait_for(15, func(): return Net.is_greeted()), Net.server_label())

	var login := "dg%s" % ts
	lobby._login_edit.text = login
	lobby._pass_edit.text = PASSWORD
	lobby._nick_edit.text = "T%s" % ts
	await _wait_for(5, func(): return not lobby._register_btn.disabled)
	lobby._register_btn.pressed.emit()
	var reg := await _wait_for(15, func(): return Net.is_logged_in() and lobby._page_rooms.visible)
	_step("online: регистрация через интерфейс", reg, login)

	var ready := await _await_rooms_ready(lobby)
	_step("online: список комнат загружен", ready, lobby._rooms_note.text)
	if not ready:
		return

	lobby._room_name.text = "TEST-%s" % ts
	lobby._seats_option.select(0)
	lobby._create_btn.pressed.emit()
	var created := await _wait_for(15, func(): return lobby._page_lobby.visible and not lobby._lobby_code.text.is_empty())
	_step("online: комната создана", created, lobby._lobby_code.text)

	lobby._leave_btn.pressed.emit()
	var left := await _wait_for(10, func(): return lobby._page_rooms.visible)
	_step("online: выход из комнаты", left, "")

	await Net.logout()
	_step("online: выход из аккаунта", not Net.is_logged_in(), "")
	menu.queue_free()


# --------------------------------------------------------- матч: хост

func _run_match_host(ts: String) -> void:
	var menu = _new_menu()
	var lobby: OnlineLobby = menu.online_lobby
	menu._on_online_pressed()

	_step("host: сервер приветствует",
		await _wait_for(15, func(): return Net.is_greeted()), Net.server_label())

	var login := "hg%s" % ts
	lobby._login_edit.text = login
	lobby._pass_edit.text = PASSWORD
	lobby._nick_edit.text = "Host%s" % ts
	await _wait_for(5, func(): return not lobby._register_btn.disabled)
	lobby._register_btn.pressed.emit()
	var reg := await _wait_for(15, func(): return Net.is_logged_in() and lobby._page_rooms.visible)
	_step("host: регистрация", reg, login)
	if not reg:
		return

	# Дожидаемся завершения проверки живости серверов и обновляем список:
	# _do_create выбирает сервер по кэшу проверки, и до его наполнения
	# список комнат мог не загрузиться (гонка в открытии экрана).
	var ready := await _await_rooms_ready(lobby)
	_step("host: список комнат получен", ready, lobby._rooms_note.text)
	if not ready:
		return

	lobby._room_name.text = "dgtest-%s" % ts
	# Комната по умолчанию создаётся на 3 места; для матча двух игроков
	# выбираем 2 места через интерфейс, иначе партия стартует по таймеру
	# автостарта, а не «по заполнению» (обе схемы мы проверяем ниже).
	lobby._seats_option.select(0)
	lobby._create_btn.pressed.emit()
	var got_lobby := await _wait_for(20, func(): return lobby._page_lobby.visible and not lobby._lobby_code.text.is_empty())
	_step("host: комната создана", got_lobby,
		"" if got_lobby else "note='%s' busy='%s' logged=%s srv=%s (%s)" % [
			lobby._rooms_note.text, lobby._busy.text,
			Net.is_logged_in(), Net.server_label(),
			String(Net.server_entry().get("id", "?"))])
	if not got_lobby:
		return
	print("TEST  INFO | host room=%s" % lobby._lobby_code.text)

	# Комната 2 места: гость, заняв второе, заполняет её — и сервер
	# запускает партию САМ, без кнопки «Начать». Хосту рассылка уходит
	# GAME_STATE, и он сразу уходит в сцену партии. Ждать _lobby_all_in
	# нельзя: с полной комнатой лобби уже не показывается никому.
	var filled := await _wait_for(150, _scene_is_game)
	_step("host: гость заполнил комнату — партия стартовала сама", filled,
		"" if filled else "note='%s' seats='%s' scene='%s'" % [
			lobby._lobby_note.text, lobby._lobby_seats.text,
			get_tree().current_scene.name if get_tree().current_scene != null else "?"])
	if not filled:
		return

	var game = get_tree().current_scene
	var state_ok := await _wait_for(20, func():
		return game.state != null and game.state.players.size() >= 2 and game.state.local_seat >= 0)
	_step("host: состояние партии получено", state_ok,
		"" if not state_ok else "мест %d, я за %d" % [game.state.players.size(), game.state.local_seat])
	if state_ok:
		await _host_draft_steps(game)


# ------------------------------------- матч: черновик стола (host — автор)

## Раскладываем три фишки локально и следим, чтобы черновик уходил
## повторами: соперник обязан видеть серые фишки ВСЁ время нашего хода,
## а не до первого протухания. Гость за это время меряет накопление.
func _host_draft_steps(game: Node) -> void:
	var my_turn := await _wait_for(80, func():
		return game.state != null and game.state.my_turn() and not game.state.finished)
	_step("host: дождались своего хода", my_turn,
		"" if my_turn else "ходит %d, я за %d" % [game.state.current, game.state.local_seat])
	if not my_turn:
		return
	# Реджойн в полёте держит _sending до ответа сервера, а сам ответ
	# (game.state) гасит _sending ДО завершения корутины и потом своим
	# _apply_state стирает локальную раскладку и _last_draft_json.
	# Ждём, пока ворота будут непрерывно открыты 2 с — круговой реджойн
	# (~50 мс) гарантированно уложится.
	var quiet := 0.0
	var settled := false
	while quiet < 2.0:
		if game._sending:
			quiet = 0.0
		else:
			quiet += 0.2
		if quiet >= 2.0:
			settled = true
			break
		await get_tree().create_timer(0.2).timeout
	_step("host: реджойн улёгся — _sending не поднимался 2 с", settled,
		"sending=%s" % game._sending)
	if not settled:
		return
	# Три ряда по фишке. Правила здесь не проверяем — сервер до commit
	# их не трогает, важно накопление и доставка всего стола целиком.
	var hand: Array = game.state.hand()
	var want := mini(3, hand.size())
	var placed := 0
	for i in range(want):
		var t = hand[i]
		var row = game.state.add_row()
		if game.state.place_from_hand(int(t.id), row.id, 0):
			placed += 1
	game.refresh()
	_step("host: выложены три фишки локально", placed == want and want == 3,
		"положили %d из %d" % [placed, want])
	var sent := not String(game._last_draft_json).is_empty()
	_step("host: черновик отправлен сопернику", sent,
		"online=%s my=%s link=%s sending=%s dirty=%s rows=%d last='%s'" % [
			game._online, game.state.my_turn(), Net.is_linked(),
			game._sending, game.state.turn_dirty,
			game._build_draft_rows().size(), String(game._last_draft_json)])
	if not sent:
		return
	var first_sent: int = game._draft_sent_ms
	await get_tree().create_timer(8.0).timeout
	_step("host: черновик повторён без нового действия",
		game._draft_sent_ms > first_sent,
		"повтор через %d мс" % (game._draft_sent_ms - first_sent))
	# Гость меряет накопление 17 с — живём дольше его проверки, пока
	# ход и связь целы.
	await get_tree().create_timer(22.0).timeout
	_step("host: черновик всё ещё активен (живём дольше 15 с экспайра)",
		game.state.my_turn() and not String(game._last_draft_json).is_empty(), "")


# -------------------------------------------------------- матч: гость

func _run_match_guest(ts: String) -> void:
	var menu = _new_menu()
	var lobby: OnlineLobby = menu.online_lobby
	menu._on_online_pressed()

	_step("guest: сервер приветствует",
		await _wait_for(15, func(): return Net.is_greeted()), Net.server_label())

	var login := "gu%s" % ts
	lobby._login_edit.text = login
	lobby._pass_edit.text = PASSWORD
	lobby._nick_edit.text = "Guest%s" % ts
	await _wait_for(5, func(): return not lobby._register_btn.disabled)
	lobby._register_btn.pressed.emit()
	var reg := await _wait_for(15, func(): return Net.is_logged_in() and lobby._page_rooms.visible)
	_step("guest: регистрация", reg, login)
	if not reg:
		return

	var suffix := ts
	var ready := await _await_rooms_ready(lobby)
	_step("guest: список комнат получен", ready, lobby._rooms_note.text)
	if not ready:
		return
	var found := {}
	var deadline := Time.get_ticks_msec() + 120000
	while Time.get_ticks_msec() < deadline and found.is_empty():
		for raw in lobby._rooms:
			var room: Dictionary = raw
			var nm := String(room.get("name", ""))
			if nm.contains("dgtest") and nm.contains(suffix):
				found = room
				break
		if found.is_empty() and lobby._page_rooms.visible:
			lobby._refresh_btn.pressed.emit()
		await get_tree().create_timer(1.0).timeout
	_step("guest: комната найдена в списке", not found.is_empty(),
		"" if not found.is_empty() else "комнат=%d note='%s'" % [lobby._rooms.size(), lobby._rooms_note.text])
	if found.is_empty():
		return

	await lobby._do_join(String(found.get("code", "")), String(found.get("server", "")))
	var in_room := await _wait_for(25, func():
		return lobby._page_lobby.visible or (get_tree().current_scene != null and get_tree().current_scene.name == "Game"))
	_step("guest: вход в комнату", in_room, lobby._lobby_code.text)

	var watch := Time.get_ticks_msec() + 60000
	while Time.get_ticks_msec() < watch and not _scene_is_game():
		print("TEST  WATCH | guest | busy='%s' online=%s logged=%s page_rooms=%s page_lobby=%s scene=%s" % [
			lobby._busy.text, Net.is_online(), Net.is_logged_in(),
			lobby._page_rooms.visible, lobby._page_lobby.visible,
			get_tree().current_scene.name if get_tree().current_scene != null else "?"])
		await get_tree().create_timer(2.0).timeout
	var scene_started := await _wait_for(30, _scene_is_game)
	_step("guest: партия началась (сцена открыта)", scene_started,
		"" if scene_started else "busy='%s' page=%s note='%s' pending='%s'" % [
			lobby._busy.text, lobby._page_lobby.visible, lobby._lobby_note.text,
			JSON.stringify(Net.pending_room())])
	if not scene_started:
		return

	var game = get_tree().current_scene
	var state_ok := await _wait_for(20, func():
		return game.state != null and game.state.players.size() >= 2 and game.state.local_seat >= 0)
	_step("guest: состояние партии получено", state_ok,
		"" if not state_ok else "мест %d, я за %d" % [game.state.players.size(), game.state.local_seat])
	if state_ok:
		await _guest_draft_steps(game)


# ------------------------------------- матч: черновик стола (guest — зритель)

## Ждём черновик от хоста, проверяем новые фишки и главное — что они
## НЕ пропадают, пока автор молчит: повтор каждые 3 с обязан приходить
## дольше 15 с, иначе экспайр бы их съел.
func _guest_draft_steps(game: Node) -> void:
	var got := await _wait_for(90, func(): return game._draft_from >= 0)
	_step("guest: получен черновик соперника", got,
		"" if got else "from=%d" % game._draft_from)
	if not got:
		return
	_step("guest: черновик активен: рядов >= 3, новых >= 3",
		game._draft_active() and game._draft_rows.size() >= 3
			and game._draft_new_ids.size() >= 3,
		"рядов %d, новых %d" % [game._draft_rows.size(), game._draft_new_ids.size()])
	var placed_id := -1
	for k in game._draft_new_ids.keys():
		placed_id = int(k)
		break
	_step("guest: новая фишка помечена зелёным на столе",
		placed_id > 0 and game.get_tile_marks(placed_id).get("last", false)
			and not game.get_tile_marks(placed_id).has("draft"),
		"fid=%d" % placed_id)
	# Ничего не трогаем 17 с — дольше экспайра 15 с. Если бы автор
	# перестал повторять, новые фишки бы тут и пропали.
	await get_tree().create_timer(17.0).timeout
	_step("guest: новые фишки не пропали через 17 с",
		game._draft_from >= 0 and game._draft_active(),
		"from=%d активен=%s" % [game._draft_from, game._draft_active()])
	_step("guest: повторы продолжают приходить (пакет свежий)",
		Time.get_ticks_msec() - game._draft_at_ms < 6000,
		"последний пакет %d мс назад" % (Time.get_ticks_msec() - game._draft_at_ms))