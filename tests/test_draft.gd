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
		if picks.size() >= 2:
			break
	_na = picks[0]
	_nb = picks[1]


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
	ok("фишка из серверного стола без метки", not game.get_tile_marks(_tbl).has("last"))
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
	ok(msg, bool(marks.get("last", false)) and not marks.has("draft"))
	var view := _placed_view(tile_id)
	ok("поставленная фишка есть на столе", view != null)
	if view == null:
		return
	ok("поставленная фишка прозрачная, alpha=%f" % view.modulate.a, view.modulate.a < 0.99)
	var sb := view.get_theme_stylebox("panel")
	ok("у поставленной фишки зелёная рамка",
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
