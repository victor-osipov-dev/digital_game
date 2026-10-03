extends SceneTree

# ==============================================================
#  Черновик стола (game.draft) на стороне КЛИЕНТА.
#
#  Живого превью наведения (game.peek) клиент не рисует: пока карточку
#  держат, соперникам ничего не показываем. Серверную ретрансляцию
#  проверяет run_tests.js, а здесь — то, что видит игрок: выставленные
#  фишки чужого хода — прозрачными с жирной зелёной рамкой, их накопление
#  до конца хода (черновик обязан переживать промежуточные game.state),
#  гашение при смене хода и по таймауту.
#
#  Состояние берётся из tests/fixtures/views.json — того самого, что
#  присылает сервер (seat0: мы за 0-м, ходит 2-й).
#
#     godot --headless --path . --script res://tests/test_draft.gd
# ==============================================================

const FIXTURE := "res://tests/fixtures/views.json"

var fails := 0
var total := 0
var game: Node = null
var view: Dictionary = {}
var catalog: Array = []

# Конкретные номера фишек в фикстуре случайны (переснимается с раздачей),
# поэтому тест берёт их из неё, а не из констант: иначе переснял фикстуру —
# и тест разом посыпался. Нужны три вещи:
#   _tbl  — фишка, которая уже на серверном столе (без метки в черновике);
#   _na/_nb — фишки, которых на столе нет (новые, с зелёной рамкой);
#   _ha/_hb — фишки из своей руки (для выкладки).
var _tbl := 0
var _na := 0
var _nb := 0
var _ha := 0
var _hb := 0
var _nc := 0

func _pick_ids(data: Dictionary) -> void:
	var used := {}
	for tid in view["hand"]:
		used[int(tid)] = true
	for row in view["table"]:
		for tid in row["tileIds"]:
			used[int(tid)] = true
	_tbl = int(view["table"][0]["tileIds"][0])
	_ha = int(view["hand"][0])
	_hb = int(view["hand"][1])
	var picks := []
	for t in data["catalog"]:
		var tid := int((t as Dictionary)["id"])
		if used.has(tid):
			continue
		picks.append(tid)
		if picks.size() >= 3:
			break
	_na = picks[0]
	_nb = picks[1]
	_nc = picks[2]


func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	root.size = Vector2i(576, 1024)
	if not FileAccess.file_exists(FIXTURE):
		printerr("Нет фикстуры %s" % FIXTURE)
		quit(1)
		return
	var data = JSON.parse_string(FileAccess.get_file_as_string(FIXTURE))
	if not (data is Dictionary):
		printerr("Фикстура не разобралась: %s" % FIXTURE)
		quit(1)
		return
	ViewBuilder.set_catalog(data["catalog"])
	catalog = data["catalog"]
	view = data["game"]["seat0"]
	_pick_ids(data)
	var packed := load("res://scenes/game.tscn") as PackedScene
	if packed == null:
		printerr("game.tscn не читается")
		quit(1)
		return
	game = packed.instantiate()
	root.add_child(game)
	await process_frame
	await process_frame
	await process_frame

	_apply(view)
	test_draft_arrives()
	test_draft_survives_state()
	test_draft_recolor_on_base_change()
	test_no_hover_preview()
	test_turn_change_clears()
	test_expiry()
	test_invariant()
	test_author_turn_survives_state()
	test_turn_deadline()
	test_committed_last_turn_opaque()
	await test_commit_flies_in()
	await test_draft_tile_flies_live()
	await test_bot_move_flies()
	await test_bot_commit_staggered()

	if fails == 0:
		print("\nЧЕРНОВИК/ПРЕВЬЮ: все %d проверок прошли" % total)
		quit(0)
	else:
		printerr("\nЧЕРНОВИК/ПРЕВЬЮ: ПРОВАЛОВ %d из %d" % [fails, total])
		quit(1)


# ------------------------------------------------------------------ проверки

func test_draft_arrives() -> void:
	section("приём черновика: новые фишки и рисунок стола")
	game._on_net_draft(2, [
		{"id": 900, "tiles": [_tbl, _na]},
		{"id": 901, "tiles": [_nb]},
	])
	ok("черновик активен", game._draft_active(), "from=%d" % game._draft_from)
	ok("новых ровно две фишки",
		game._draft_new_ids.size() == 2 and game._draft_new_ids.has(_na)
			and game._draft_new_ids.has(_nb),
		"new=%s" % [game._draft_new_ids.keys()])
	ok("фишка из серверного стола без меток",
		not game.get_tile_marks(_tbl).has("last")
			and not game.get_tile_marks(_tbl).has("draft"))
	_check_placed_style(_na, "новая фишка прозрачная с зелёной рамкой")
	var rows: Array = game._table_rows()
	ok("стол показан целиком из черновика (2 ряда)",
		rows.size() == 2 and int(rows[0]["id"]) == 900 and int(rows[1]["id"]) == 901,
		"рядов %d" % rows.size())
	ok("на экране те же 2 ряда", game.row_blocks.size() == 2,
		"row_blocks=%d" % game.row_blocks.size())


func test_draft_survives_state() -> void:
	section("промежуточный game.state не гасит черновик")
	_apply(view)
	ok("черновик пережил состояние тем же ходом",
		game._draft_from == 2 and game._draft_active(),
		"from=%d" % game._draft_from)
	ok("новые на месте", game._draft_new_ids.size() == 2,
		"new=%d" % game._draft_new_ids.size())
	ok("стол всё ещё из черновика", game.row_blocks.size() == 2
		and game.row_blocks[0].row_id == 900)


func test_draft_recolor_on_base_change() -> void:
	section("новые пересчитываются по новой серверной базе")
	var v: Dictionary = view.duplicate(true)
	v["table"] = [] # база пуста — теперь новой становится и 72
	_apply(v)
	ok("черновик пережил даже пустую базу", game._draft_from == 2 and game._draft_active(),
		"from=%d" % game._draft_from)
	ok("новые пересчитаны: стол пуст, новых три",
		game._draft_new_ids.size() == 3 and game._draft_new_ids.has(_tbl)
			and game._draft_new_ids.has(_na) and game._draft_new_ids.has(_nb),
		"new=%s" % [game._draft_new_ids.keys()])
	_check_placed_style(_tbl, "фишка с пустого стола тоже с зелёной рамкой")


func test_turn_change_clears() -> void:
	section("смена хода гасит черновик")
	var v: Dictionary = view.duplicate(true)
	v["current"] = 0 # ход ушёл от автора (2-й) — рисовать его стол нельзя
	_apply(v)
	ok("черновик погашен", game._draft_from == -1 and not game._draft_active(),
		"from=%d" % game._draft_from)
	var rows: Array = game._table_rows()
	ok("стол снова серверный (2 ряда с id 1 и 2)",
		rows.size() == 2 and int(rows[0]["id"]) == 1 and int(rows[1]["id"]) == 2,
		"ids=%d,%d" % [int(rows[0].get("id", -1)), int(rows[1].get("id", -1))])


func test_expiry() -> void:
	section("15 с молчания автора гасят черновик")
	_apply(view)
	game._on_net_draft(2, [{"id": 900, "tiles": [_tbl, _na]}, {"id": 901, "tiles": [_nb]}])
	ok("снова принят", game._draft_active())
	game._draft_at_ms = Time.get_ticks_msec() - 16000
	game._expire_draft()
	ok("после таймаута погашен", game._draft_from == -1 and not game._draft_active())
	ok("стол вернулся серверный", game.row_blocks.size() == 2
		and game.row_blocks[0].row_id == 1)


func test_invariant() -> void:
	section("инварианты стола без врезки")
	ok("без врезки дети table_box = ряды + подсказка",
		game.table_box.get_child_count() == game.row_blocks.size() + 1,
		"детей %d, рядов %d" % [game.table_box.get_child_count(), game.row_blocks.size()])


func test_author_turn_survives_state() -> void:
	section("рассылка посреди нашего хода не стирает раскладку")
	var v: Dictionary = view.duplicate(true)
	v["current"] = 0
	v["myTurn"] = true
	_apply(v)
	var row = game.state.add_row()
	var placed: bool = game.state.place_from_hand(_ha, row.id, 0)
	placed = placed and game.state.place_from_hand(_hb, row.id, 1)
	ok("локально выложили два в новый ряд", placed and game.state.turn_dirty,
		"рядов %d turn_placed %d" % [
			game.state.table.size(), game.state.turn_placed.size()])
	# Пауза из-за обрыва соперника: сервер стола не менял, замер только
	# отсчёт. Рассылка идёт и автору — без возврата правок он терял бы
	# раскладку и переставал повторять черновик.
	game._apply_state(v, 0.0, true)
	game.refresh()
	ok("раскладка вернулась (3 ряда)", game.state.table.size() == 3,
		"рядов %d" % game.state.table.size())
	ok("обе фишки всё ещё в этом ходу",
		game.state.turn_placed.size() == 2 and game.state.turn_dirty,
		"turn_placed %d" % game.state.turn_placed.size())
	ok("рука уменьшена ровно на выложенное",
		game.state.hand().size() == 9, "в руке %d" % game.state.hand().size())
	ok("новый ряд хранит две фишки из руки",
		_row_tiles(game.state.table, row.id) == [_ha, _hb],
		"tiles=%s" % [_row_tiles(game.state.table, row.id)])
	# Серверный стол ИЗМЕНИЛСЯ — истина сервера, правок больше нет.
	var v2: Dictionary = v.duplicate(true)
	((v2["table"][0]) as Dictionary)["tileIds"].append(77)
	game._apply_state(v2, 0.0, false)
	game.refresh()
	ok("после смены серверного стола правки отброшены",
		game.state.table.size() == 2 and game.state.turn_placed.is_empty()
			and not game.state.turn_dirty,
		"рядов %d turn_placed %d" % [
			game.state.table.size(), game.state.turn_placed.size()])


func _row_tiles(rows: Array, row_id: int) -> Array:
	for r in rows:
		if (r as GameState.Row).id == row_id:
			var out := []
			for t in (r as GameState.Row).tiles:
				out.append((t as Tile).id)
			return out
	return []


# --------------------------------------------------- принятый ход и прилёты

## Отсчёт хода: секунды сервера, а не единица. Ловили вживую: `or`
## в GDScript возвращает bool, и int(60 or 0) давал int(true) = 1 —
## таймер всегда показывал одну секунду и гас.
func test_turn_deadline() -> void:
	section("отсчёт хода: секунды сервера")
	var saved_online: bool = game._online
	game._online = true
	var v: Dictionary = view.duplicate(true)
	v["turnLeft"] = 60
	var before := Time.get_ticks_msec()
	game._on_state_received(v, 0.0, false, false)
	var span: int = int(game._turn_deadline_ms) - before
	ok("дедлайн на 60 с вперёд", span >= 59000 and span <= 60100,
		"через %d мс" % span)
	var v0: Dictionary = view.duplicate(true)
	v0["turnLeft"] = null
	game._on_state_received(v0, 0.0, false, false)
	ok("null гасит дедлайн", int(game._turn_deadline_ms) == 0)
	game._online = saved_online

## Фикстура везёт lastTurn [66,68,69] прямо на столе: это принятый
## прошлый ход, и он обязан быть обычным (только зелёная рамка),
## а не прозрачным весь следующий ход.
func test_committed_last_turn_opaque() -> void:
	section("принятый прошлый ход непрозрачный")
	game._clear_draft()
	_apply(view)
	for tid in [66, 68, 69]:
		_check_committed_style(tid, "фишка %d прошлого хода обычная" % tid)
	ok("свой черновик пуст", game._draft_new_ids.is_empty())


## Коммит: принятые фишки прилетают сверху, даже если черновик уже
## показывал их прозрачными, и гаснут до обычных с зелёной рамкой.
## Полёт проверяем без абсолютных позиций (раскладка считается кадром
## позже пересборки): в полёте позиция меняется между кадрами, после
## посадки — стоит.
func test_commit_flies_in() -> void:
	section("коммит прилетает и гаснет до обычного")
	game._clear_draft()
	_apply(view)
	var v2: Dictionary = view.duplicate(true)
	(v2["table"] as Array).append({"id": 50, "tileIds": [_na]})
	v2["lastTurn"] = [_na]
	game._on_state_received(v2, 0.0, false, false)
	ok("новая фишка построена", _placed_view(_na) != null)
	await process_frame
	await process_frame
	var p1 := _flight_positions([_na])
	await process_frame
	await process_frame
	var p2 := _flight_positions([_na])
	ok("фишка в полёте (позиция меняется между кадрами)",
		p1.has(_na) and p2.has(_na) \
			and not (p1[_na] as Vector2).is_equal_approx(p2[_na]))
	for i in range(70):
		await process_frame
	var p3 := _flight_positions([_na])
	await process_frame
	await process_frame
	var p4 := _flight_positions([_na])
	ok("фишка долетела (позиция встала)",
		p3.has(_na) and p4.has(_na) \
			and (p3[_na] as Vector2).is_equal_approx(p4[_na]))
	_check_committed_style(_na, "принятая фишка обычная с зелёной рамкой")


## Живой черновик: новая фишка соперника прилетает прозрачной.
func test_draft_tile_flies_live() -> void:
	section("живой черновик прилетает прозрачным")
	game._clear_draft()
	_apply(view)
	game._on_net_draft(2, [{"id": 900, "tiles": [_tbl, _na]}])
	ok("новая фишка построена", _placed_view(_na) != null)
	await process_frame
	await process_frame
	var p1 := _flight_positions([_na])
	await process_frame
	await process_frame
	var p2 := _flight_positions([_na])
	ok("фишка в полёте (позиция меняется между кадрами)",
		p1.has(_na) and p2.has(_na) \
			and not (p1[_na] as Vector2).is_equal_approx(p2[_na]))
	for i in range(70):
		await process_frame
	var p3 := _flight_positions([_na])
	await process_frame
	await process_frame
	var p4 := _flight_positions([_na])
	ok("фишка долетела (позиция встала)",
		p3.has(_na) and p4.has(_na) \
			and (p3[_na] as Vector2).is_equal_approx(p4[_na]))
	_check_placed_style(_na, "долетевшая фишка черновика прозрачная")
	game._clear_draft()


## Бот: постановка идёт по одной фишке (видно рост стола 1-2-3),
## принятые фишки — непрозрачные. Рука ригнута (ровно один
## выкладываемый ряд), seed фиксирован. Тумблер Settings.bot_anim
## выключает пошаговость: стол собирается сразу.
func test_bot_move_flies() -> void:
	section("ход бота идёт по одной фишке")
	var settings := root.get_node_or_null("Settings")
	var saved_count: int = settings.player_count
	var saved_req: bool = settings.require_30
	var saved_level: int = settings.bot_level
	var saved_anim: bool = settings.bot_anim
	var saved_bot0: bool = settings.is_bot(0)
	var saved_bot1: bool = settings.is_bot(1)
	settings.bot_anim = true
	var run: Array = await _bot_match_setup()
	seed(20240517)
	game._bot_seq = 9
	game._bot_execute(9)
	var counts := []
	# Таймеры шагов — real-time (0.55 с), кадры могут идти быстрее:
	# ждём факта смены хода, а не фиксированное число кадров.
	for i in range(600):
		await process_frame
		counts.append(_table_tile_count())
		if game.state.current != 0:
			break
	var seen := []
	for c in counts:
		if seen.is_empty() or seen[seen.size() - 1] != c:
			seen.append(c)
	ok("стол рос по одной фишке", seen == [1, 2, 3], "рост=%s" % [seen])
	var ids: Array = game.state.last_turn_tile_ids.duplicate()
	ok("бот именно выложился, а не взял", ids.size() == 3, "last=%s" % [ids])
	var hit := 0
	for rid in run:
		if ids.has(rid):
			hit += 1
	ok("выложен ригнутый ряд", hit == 3, "last=%s run=%s" % [ids, run])
	for i in range(40):
		await process_frame
	var p1 := _flight_positions(ids)
	await process_frame
	await process_frame
	var p2 := _flight_positions(ids)
	var home := 0
	for tid in ids:
		var a: int = int(tid)
		if p1.has(a) and p2.has(a) \
				and (p1[a] as Vector2).is_equal_approx(p2[a]):
			home += 1
	ok("все долетели и стоят", home == 3, "стоит %d из 3" % home)
	for tid in ids:
		_check_committed_style(int(tid), "фишка бота %d обычная" % int(tid))
	section("анимация бота выключается настройкой")
	settings.bot_anim = false
	await _bot_match_setup()
	game._bot_seq = 21
	game._bot_execute(21)
	ok("без анимации стол собран сразу", _table_tile_count() == 3,
		"фишек %d" % _table_tile_count())
	ok("ход завершён сразу",
		game.state.current == 1 and game.state.last_turn_tile_ids.size() == 3,
		"current=%d last=%d" % [game.state.current, game.state.last_turn_tile_ids.size()])
	settings.player_count = saved_count
	settings.require_30 = saved_req
	settings.bot_level = saved_level
	settings.bot_anim = saved_anim
	settings.set_bot(0, saved_bot0)
	settings.set_bot(1, saved_bot1)


## Сетевой бот: его коммит прилетает поэтапно, как локальный, —
## задержки 0 / 0.45 / 0.9 с. Ловим по реальному времени: «приземлился»
## значит позиция встала И alpha доросла до метки (ждущий в углу
## неподвижен, но прозрачен). Разброс посадок обязан быть от 300 мс —
## разом прилетает всё за десятки мс.
func test_bot_commit_staggered() -> void:
	section("коммит сетевого бота идёт поэтапно")
	game._clear_draft()
	_apply(view)
	(game.state.players[2] as GameState.Player).is_bot = true
	var v2: Dictionary = view.duplicate(true)
	(v2["table"] as Array).append({"id": 50, "tileIds": [_na, _nb, _nc]})
	v2["lastTurn"] = [_na, _nb, _nc]
	v2["current"] = 0
	game._on_state_received(v2, 0.0, false, false)
	var need := [_na, _nb, _nc]
	var hist := {}
	var landed_at := {}
	for i in range(300):
		await process_frame
		var now := Time.get_ticks_msec()
		for tid in need:
			var a: int = int(tid)
			if landed_at.has(a):
				continue
			var v := _placed_view(a)
			if v == null:
				continue
			if not hist.has(a):
				hist[a] = []
			var h: Array = hist[a]
			h.append((v as Control).position)
			while h.size() > 3:
				h.remove_at(0)
			var steady := h.size() == 3 \
				and (h[0] as Vector2).is_equal_approx(h[1]) \
				and (h[1] as Vector2).is_equal_approx(h[2])
			if steady and (v as Control).modulate.a > 0.99:
				landed_at[a] = now
		if landed_at.size() == need.size():
			break
	ok("все три долетели", landed_at.size() == 3, "сели %d" % landed_at.size())
	if landed_at.size() == 3:
		var times := landed_at.values()
		times.sort()
		var spread: int = int(times[times.size() - 1]) - int(times[0])
		ok("посадки разнесены во времени", spread >= 300,
			"разброс %d мс" % spread)
	for tid in need:
		_check_committed_style(int(tid), "фишка бота %d обычная" % int(tid))


## Локальный матч с ботом за 0-м местом и ригнутой рукой (красные
## 5-6-7 + запасная синяя 9, чтобы бот не победил этим же ходом).
## Возвращает id ряда. Рука уже показана (пересобрана).
func _bot_match_setup() -> Array:
	var settings := root.get_node_or_null("Settings")
	settings.player_count = 2
	settings.require_30 = false
	settings.bot_level = 0
	settings.set_player_name(0, "Бот")
	settings.set_player_name(1, "Человек")
	settings.set_bot(0, true)
	settings.set_bot(1, false)
	game._new_match()
	for i in range(3):
		await process_frame
	var run := []
	var run_values := [5, 6, 7]
	var spare := 0
	for t in catalog:
		var d := t as Dictionary
		if bool(d.get("is_joker", false)):
			continue
		var v := int(d.get("value", 0))
		if int(d.get("color", -1)) == 0 and run_values.has(v):
			run_values.erase(v)
			run.append(int(d.get("id", 0)))
			if run.size() >= 3:
				break
	# Запасная фишка в руку, чтобы бот не победил этим же ходом:
	# одиночка ни с чем не комбинируется (нужен ряд минимум из трёх).
	for t in catalog:
		var d := t as Dictionary
		if int(d.get("color", -1)) == 1 and int(d.get("value", 0)) == 9 \
				and not bool(d.get("is_joker", false)):
			spare = int(d.get("id", 0))
			break
	ok("нашли красные 5-6-7 в каталоге", run.size() == 3, "ids=%s" % [run])
	ok("нашли запасную синюю 9", spare > 0)
	var hand: Array = []
	for rid in run:
		hand.append(ViewBuilder.tile(rid))
	hand.append(ViewBuilder.tile(spare))
	(game.state.players[0] as GameState.Player).hand = hand
	# Пересборка после рига: в кадре рука бота, и при ходе фишки
	# переедут из неё на стол, а не прилетят вместе со всей раздачей.
	game.refresh()
	for i in range(3):
		await process_frame
	return run


## Сколько фишек сейчас показано на столе (по видам, а не по состоянию).
func _table_tile_count() -> int:
	var n := 0
	for block in game.row_blocks:
		var flow = block.get("flow")
		if flow != null:
			n += (flow.get("tile_views") as Array).size()
	return n


## Позиции видов фишек на столе прямо сейчас (локальные): для проверки
## движения между кадрами. Абсолютные значения не сравниваем — раскладка
## считается кадром позже пересборки, и снимок «до» ловил бы нули.
func _flight_positions(ids: Array) -> Dictionary:
	var out := {}
	for tid in ids:
		var v := _placed_view(int(tid))
		if v != null:
			out[int(tid)] = (v as Control).position
	return out


# --------------------------------------------------- без живого превью

func test_no_hover_preview() -> void:
	section("наведение не вставляет слоты и призраки")
	_apply(view)
	game._on_net_draft(2, [{"id": 900, "tiles": [_tbl, _na]}, {"id": 901, "tiles": [_nb]}])
	ok("в столе только ряды и подсказка",
		game.table_box.get_child_count() == game.row_blocks.size() + 1,
		"детей %d, рядов %d" % [game.table_box.get_child_count(), game.row_blocks.size()])
	for block in game.row_blocks:
		var flow = block.get("flow")
		var views: Array = flow.get("tile_views") if flow != null else []
		ok("ряд не растянут призраком", flow != null and views.size() <= 2)


func _placed_view(tile_id: int) -> Control:
	for block in game.row_blocks:
		var flow = block.get("flow")
		if flow == null:
			continue
		for item in flow.get("tile_views"):
			var view := item as Control
			var tile = view.get("tile") if view != null else null
			if tile != null and int(tile.get("id")) == tile_id:
				return view
	return null


func _check_placed_style(tile_id: int, msg: String) -> void:
	var marks: Dictionary = game.get_tile_marks(tile_id)
	ok(msg, bool(marks.get("draft", false)) and not marks.has("last"))
	var view := _placed_view(tile_id)
	ok("поставленная фишка есть на столе", view != null)
	if view == null:
		return
	ok("поставленная фишка прозрачная, alpha=%f" % view.modulate.a, view.modulate.a < 0.99)
	var sb := view.get_theme_stylebox("panel")
	ok("у поставленной фишки зелёная рамка",
		sb is StyleBoxFlat and (sb as StyleBoxFlat).border_color == Color("43A047"))


## Принятый прошлый ход: обычный, только с зелёной рамкой. Прозрачность
## обязана гаснуть в момент коммита, а не висеть весь следующий ход —
## это и была жалоба («видно прозрачными до хода 3-го игрока»).
func _check_committed_style(tile_id: int, msg: String) -> void:
	var marks: Dictionary = game.get_tile_marks(tile_id)
	ok(msg, bool(marks.get("last", false)) and not marks.has("draft"))
	var view := _placed_view(tile_id)
	ok("принятая фишка есть на столе", view != null)
	if view == null:
		return
	ok("принятая фишка непрозрачная, alpha=%f" % view.modulate.a, view.modulate.a > 0.99)
	var sb := view.get_theme_stylebox("panel")
	ok("у принятой фишки зелёная рамка",
		sb is StyleBoxFlat and (sb as StyleBoxFlat).border_color == Color("43A047"))


# ------------------------------------------------------------------ служебное

func _apply(v: Dictionary) -> void:
	game._apply_state(v, 0.0, false)
	game.refresh()


func section(name: String) -> void:
	print("\n== %s ==" % name)


func ok(msg: String, cond: bool, detail: String = "") -> void:
	total += 1
	if cond:
		print("  ok  " + msg)
	else:
		fails += 1
		var line := "FAIL  " + msg
		if not detail.is_empty():
			line += " | " + detail
		printerr(line)
