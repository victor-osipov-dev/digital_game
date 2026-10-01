extends SceneTree

# ==============================================================
#  Черновик стола (game.draft) и превью нового ряда (game.peek)
#  на стороне КЛИЕНТА.
#
#  Серверную ретрансляцию проверяет run_tests.js, а здесь — то, что
#  видит игрок: серые фишки чужого хода, их накопление до конца хода
#  (черновик обязан переживать промежуточные game.state), гашение при
#  смене хода и по таймауту, плюс врезку нового ряда под призраком —
#  без неё призрак лёг бы поверх соседней карточки.
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
	await test_peek_new_row()
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
	section("приём черновика: серые и рисунок стола")
	game._on_net_draft(2, [
		{"id": 900, "tiles": [72, 1]},
		{"id": 901, "tiles": [2]},
	])
	ok("черновик активен", game._draft_active(), "from=%d" % game._draft_from)
	ok("серыми ровно новые фишки {1,2}",
		game._draft_grey_ids.size() == 2 and game._draft_grey_ids.has(1)
			and game._draft_grey_ids.has(2),
		"grey=%s" % [game._draft_grey_ids.keys()])
	ok("фишка из серверного стола (72) не серая", not game.get_tile_marks(72).get("draft", false))
	ok("новая фишка помечена серой", game.get_tile_marks(1).get("draft", false))
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
	ok("серые на месте", game._draft_grey_ids.size() == 2,
		"grey=%d" % game._draft_grey_ids.size())
	ok("стол всё ещё из черновика", game.row_blocks.size() == 2
		and game.row_blocks[0].row_id == 900)


func test_draft_recolor_on_base_change() -> void:
	section("серые пересчитываются по новой серверной базе")
	var v: Dictionary = view.duplicate(true)
	v["table"] = [] # база пуста — теперь серой становится и 72
	_apply(v)
	ok("черновик пережил даже пустую базу", game._draft_from == 2 and game._draft_active(),
		"from=%d" % game._draft_from)
	ok("серые пересчитаны: {72,1,2}",
		game._draft_grey_ids.size() == 3 and game._draft_grey_ids.has(72)
			and game._draft_grey_ids.has(1) and game._draft_grey_ids.has(2),
		"grey=%s" % [game._draft_grey_ids.keys()])
	ok("72 теперь серая", game.get_tile_marks(72).get("draft", false))


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
	game._on_net_draft(2, [{"id": 900, "tiles": [72, 1]}, {"id": 901, "tiles": [2]}])
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
	var placed: bool = game.state.place_from_hand(5, row.id, 0)
	placed = placed and game.state.place_from_hand(9, row.id, 1)
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
	ok("новый ряд хранит [5,9]", _row_tiles(game.state.table, row.id) == [5, 9],
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


# --------------------------------------------------- превью нового ряда

func test_peek_new_row() -> void:
	section("призрак нового ряда врезает ряд, а не ложится поверх")
	_apply(view)
	game._on_net_draft(2, [{"id": 900, "tiles": [72, 1]}, {"id": 901, "tiles": [2]}])
	# Ряды на экране: 900, 901. Соперник наводит на разряд ПЕРЕД вторым.
	game._on_net_peek(17, "new", -1, -1, 1)
	ok("врезка создана", game._peek_slot != null)
	ok("призрак создан", game._peek_ghost != null)
	ok("врезка встала между рядами (child index 1)",
		game._peek_slot.get_index() == 1,
		"index=%d" % game._peek_slot.get_index())
	ok("детей table_box = ряды + врезка + подсказка",
		game.table_box.get_child_count() == game.row_blocks.size() + 2,
		"детей %d, рядов %d" % [game.table_box.get_child_count(), game.row_blocks.size()])
	# Разметке нужно кадр-два; дальше меряем уже разложенные позиции.
	await process_frame
	await process_frame
	var slot: Control = game._peek_slot
	var first: Control = game.row_blocks[0]
	var second: Control = game.row_blocks[1]
	ok("врезка лежит ниже первого ряда", slot.global_position.y > first.global_position.y,
		"slot.y=%.1f first.y=%.1f" % [slot.global_position.y, first.global_position.y])
	ok("врезка лежит выше второго ряда (тот расступился)",
		slot.global_position.y < second.global_position.y,
		"slot.y=%.1f second.y=%.1f" % [slot.global_position.y, second.global_position.y])
	game._sync_peek_slot()
	ok("призрак держится на врезке",
		game._peek_ghost.global_position == slot.global_position,
		"ghost=%s slot=%s" % [game._peek_ghost.global_position, slot.global_position])
	# Смена цели: into по черновому ряду — врезки быть не должно.
	game._on_net_peek(72, "into", 900, 0, -1)
	ok("into не оставляет врезку", game._peek_slot == null and game._peek_ghost != null)
	# Вернулись к новому ряду и тут же пришёл повтор черновика:
	# пересборка стола обязана вернуть врезку на её место.
	game._on_net_peek(17, "new", -1, -1, 1)
	ok("врезка снова создана", game._peek_slot != null)
	game._on_net_draft(2, [
		{"id": 900, "tiles": [72, 1, 3]},
		{"id": 901, "tiles": [2]},
	])
	ok("после пересборки черновика врезка на месте (child index 1)",
		game._peek_slot != null and game._peek_slot.get_index() == 1,
		"index=%d" % (game._peek_slot.get_index()
			if game._peek_slot != null else -1))
	game._sync_peek_slot()
	ok("призрак по-прежнему на врезке",
		game._peek_ghost != null and game._peek_slot != null
			and game._peek_ghost.global_position == game._peek_slot.global_position)
	# clear гасит и врезку, и призрак.
	game._on_net_peek(0, "clear", -1, -1, -1)
	ok("clear убрал врезку и призрак",
		game._peek_slot == null and game._peek_ghost == null)
	ok("дети table_box вернулись к рядам + подсказке",
		game.table_box.get_child_count() == game.row_blocks.size() + 1,
		"детей %d, рядов %d" % [game.table_box.get_child_count(), game.row_blocks.size()])


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
