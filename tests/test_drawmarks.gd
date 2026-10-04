extends SceneTree

# ==============================================================
#  Пометки взятия из колоды.
#
#  Своё взятие — галочка с кружочком в углу фишки, пока она в руке взявшего
#  (выложил — убрался, взял новую — заменился). Чужое взятие
#  (бот или соперник по сети) — «· взял» у имени в чипах: рука +1
#  при том же столе и пустом lastTurn.
#
#     godot --headless --path . --script res://tests/test_drawmarks.gd
# ==============================================================

const FIXTURE := "res://tests/fixtures/views.json"

var fails := 0
var total := 0
var game: Node = null
var view: Dictionary = {}
var catalog: Array = []
var _na := 0
var _nb := 0
var _nc := 0


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
	_pick_ids(data, view)
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

	test_draw_marks_tile()
	await test_bot_draw_marked()
	await test_bot_draw_flies_single()
	await test_no_stagger_when_bot_anim_off()

	if fails == 0:
		print("\nВЗЯТИЕ: все %d проверок прошли" % total)
		quit(0)
	else:
		printerr("\nВЗЯТИЕ: ПРОВАЛОВ %d из %d" % [fails, total])
		quit(1)


## Взятая из колоды помечается галочкой с кружочком, пока она в руке: выложил —
## убралась сама, взял новую — заменилась. Чип показывает «· взял».
func test_draw_marks_tile() -> void:
	section("взятая фишка помечается галочкой")
	game._clear_draft()
	var settings := root.get_node_or_null("Settings")
	settings.set_player_count(2)
	settings.set_bot(0, false)
	settings.set_bot(1, false)
	game._new_match()
	var before := {}
	for t in game.state.hand():
		before[(t as Tile).id] = true
	game._on_draw_confirmed()
	ok("место взятия запомнено", game.get("_drew_seat") == 0)
	var marks: Dictionary = game.get("_draw_marks")
	ok("номер взятой запомнен", (marks as Dictionary).has(0))
	var took := int((marks as Dictionary).get(0, -1))
	ok("взята новая фишка", took > 0 and not before.has(took))
	var tm: Dictionary = game.call("get_tile_marks", took)
	ok("метка drawn стоит", bool(tm.get("drawn", false)))
	var others_clean := true
	for t in game.state.hand():
		var tid := (t as Tile).id
		if tid != took and bool((game.call("get_tile_marks", tid) as Dictionary).get("drawn", false)):
			others_clean = false
	ok("у остальных метки нет", others_clean)
	# Ход вернулся к взявшему — галочка на фишке в его руке.
	game.state.current = 0
	game.refresh()
	ok("галочка видна на фишке", _hand_badge(took))
	ok("чип показывает взятие", _chip_has("взял"))
	# Выложил (фишка ушла из руки) — метка снялась сама.
	var hand: Array = game.state.players[0].hand
	for i in range(hand.size()):
		if (hand[i] as Tile).id == took:
			hand.remove_at(i)
			break
	game.refresh()
	var tm2: Dictionary = game.call("get_tile_marks", took)
	ok("после выкладки метки нет", not bool(tm2.get("drawn", false)))
	# Хелпер пометки: место без фишки — только чип, без галочки.
	game.call("_note_draw", 1, null)
	ok("пометка места работает", game.get("_drew_seat") == 1)
	ok("чип показывает и чужое взятие", _chip_has("взял"))


## Взятие бота по сети видно у имени: рука +1 при том же столе.
## Пропуск (рука та же) и выкладка (lastTurn не пуст) — не взятия.
func test_bot_draw_marked() -> void:
	section("взятие бота помечается у имени")
	game._clear_draft()
	game._new_match()
	game._online = true
	var s0: Dictionary = view.duplicate(true)
	for i in range((s0["players"] as Array).size()):
		(s0["players"] as Array)[i]["isBot"] = (i == 2)
	s0["current"] = 2
	game._on_state_received(s0, 0.0, false, false)
	# Бот берёт: рука +1, стол тот же, lastTurn пуст.
	var s1: Dictionary = s0.duplicate(true)
	(s1["players"] as Array)[2]["handCount"] = int((s1["players"] as Array)[2]["handCount"]) + 1
	s1["current"] = 0
	s1["lastTurn"] = []
	game._on_state_received(s1, 0.0, false, false)
	ok("место взятия — бот", game.get("_drew_seat") == 2)
	ok("чип показывает взятие", _chip_has("взял"))
	# Пропуск: рука та же — не взятие.
	var s2: Dictionary = s0.duplicate(true)
	s2["current"] = 0
	s2["lastTurn"] = []
	game._on_state_received(s2, 0.0, false, false)
	ok("пропуск не помечается", game.get("_drew_seat") == -1)
	# Выкладка: lastTurn не пуст — не взятие.
	var s3: Dictionary = s0.duplicate(true)
	(s3["table"] as Array).append({"id": 54, "tileIds": [_na, _nb, _nc]})
	s3["lastTurn"] = [_na, _nb, _nc]
	s3["current"] = 0
	game._on_state_received(s3, 0.0, false, false)
	ok("выкладка не помечается", game.get("_drew_seat") == -1)
	game._online = false


## Бот берёт из колоды: прилетает ровно одна фишка, а не вся рука.
## Регрессия: снимок до/после слайдил всю переехавшую руку — со стороны
## «боту прилетело несколько карточек», хотя брал он одну.
func test_bot_draw_flies_single() -> void:
	section("бот берёт одну фишку — летит только она")
	var settings := root.get_node_or_null("Settings")
	var saved_count = settings.player_count
	var saved_req = settings.require_30
	var saved_level = settings.bot_level
	var saved_bot0 = settings.is_bot(0)
	var saved_bot1 = settings.is_bot(1)
	settings.player_count = 2
	settings.require_30 = false
	settings.bot_level = 0
	settings.set_bot(0, true)
	settings.set_bot(1, false)
	game._clear_draft()
	game._new_match()
	game._bot_seq = 51
	for i in range(3):
		await process_frame
	# Рука без комбинаций (цвета и значения разные): выложить нечего —
	# план обязан взять из колоды, детерминированно.
	var hand: Array = []
	var used_colors := {}
	var used_values := {}
	for t in catalog:
		var d := t as Dictionary
		if bool(d.get("is_joker", false)):
			continue
		var cc := int(d.get("color", -1))
		var vv := int(d.get("value", 0))
		if used_colors.has(cc) or used_values.has(vv):
			continue
		used_colors[cc] = true
		used_values[vv] = true
		hand.append(ViewBuilder.tile(int(d.get("id", 0))))
		if hand.size() >= 4:
			break
	ok("рука без комбинаций собрана", hand.size() == 4, "фишек %d" % hand.size())
	(game.state.players[0] as GameState.Player).hand = hand
	game.refresh()
	for i in range(3):
		await process_frame
	game._bot_execute(51)
	var drawn := -1
	var marks: Dictionary = game.get("_draw_marks")
	for seat in marks:
		drawn = int(marks[seat])
	ok("бот взял ровно одну", drawn > 0, "drawn=%d" % drawn)
	# Смена руки при передаче хода — немая: ни прилётов, ни слайдов.
	# Раньше здесь летела вся рука (чужая — призраками, наша — прилётом).
	var maxfly := 0
	for i in range(40):
		await process_frame
		maxfly = maxi(maxfly, _flying_ids().size())
	ok("при взятии ничего не летает", maxfly == 0, "максимум %d" % maxfly)
	for i in range(3):
		await process_frame
	var calm := []
	for i in range(10):
		await process_frame
		calm.append(_all_positions())
	var steady := true
	for snapshot in calm:
		if snapshot != calm[0]:
			steady = false
	ok("стол и рука стоят с первых кадров", steady, "разъехались")
	for i in range(120):
		await process_frame
		if _flying_ids().is_empty():
			break
	ok("к концу ничего не зависло в полёте", _flying_ids().is_empty(),
		"летят: %s" % [_flying_ids()])
	settings.player_count = saved_count
	settings.require_30 = saved_req
	settings.bot_level = saved_level
	settings.set_bot(0, saved_bot0)
	settings.set_bot(1, saved_bot1)


## Выключенная «анимация бота» убирает поэтапность и в сети: коммит бота
## не встаёт шагами в очередь, а прилетает сразу, как в одиночной игре.
## Титры при этом остаются (как офлайн) — проверяется только показ шагов.
func test_no_stagger_when_bot_anim_off() -> void:
	section("без анимации бота шаги очередью не идут")
	var settings := root.get_node_or_null("Settings")
	var saved_anim = settings.bot_anim
	settings.bot_anim = false
	game._clear_draft()
	game._online = true
	var s0: Dictionary = view.duplicate(true)
	for i in range((s0["players"] as Array).size()):
		(s0["players"] as Array)[i]["isBot"] = (i == 1 or i == 2)
	s0["current"] = 0
	game._on_state_received(s0, 0.0, false, false)
	for i in range(20):
		await process_frame
	var s1: Dictionary = s0.duplicate(true)
	(s1["table"] as Array).append({"id": 55, "tileIds": [_na, _nb, _nc]})
	s1["lastTurn"] = [_na, _nb, _nc]
	s1["current"] = 2
	game._on_state_received(s1, 0.0, false, false)
	# Очередного полёта нет — только титр; фишки сели быстро, а не вразбивку.
	# (Сегмент из очереди выходит синхронно, поэтому смотрим флаг полёта,
	# а не саму очередь: она пуста в обоих режимах.)
	ok("шаги очередью не летят", not game._flight_active,
		"презентация летит очередью")
	var placed := 0
	for i in range(150):
		await process_frame
		placed = _visible_count([_na, _nb, _nc])
		if placed == 3 and _flying_ids().is_empty():
			break
	ok("все три сели быстро", placed == 3, "видно %d из 3" % placed)
	settings.bot_anim = saved_anim
	game._online = false


## Сколько из перечисленных фишек видно на столе (alpha доросла).
func _visible_count(ids: Array) -> int:
	var n := 0
	for block in game.row_blocks:
		var flow = block.get("flow")
		if flow == null:
			continue
		for item in flow.get("tile_views"):
			var v := item as Control
			if v == null:
				continue
			var tile = v.get("tile")
			if tile != null and ids.has(int(tile.get("id"))) \
					and (v as Control).modulate.a > 0.99:
				n += 1
	return n


## Id фишек, которые сейчас летят или спрятаны под полёт (alpha < 1).
func _flying_ids() -> Array:
	var out := []
	var flows := [game.hand_flow]
	for block in game.row_blocks:
		var flow = block.get("flow")
		if flow != null:
			flows.append(flow)
	for flow in flows:
		if flow == null:
			continue
		for item in flow.get("tile_views"):
			var v := item as Control
			if v == null:
				continue
			if (v as Control).modulate.a < 0.99:
				var tile = v.get("tile")
				if tile != null:
					out.append(int(tile.get("id")))
	return out


## Позиции всех видов (рука + стол) по возрастанию — для проверки покоя.
func _all_positions() -> Array:
	var out := []
	var flows := [game.hand_flow]
	for block in game.row_blocks:
		var flow = block.get("flow")
		if flow != null:
			flows.append(flow)
	for flow in flows:
		if flow == null:
			continue
		for item in flow.get("tile_views"):
			var v := item as Control
			if v != null:
				out.append(v.position)
	out.sort()
	return out


## Галочка взятой фишки: флаг вида (сам бейдж рисуется в _draw).
func _hand_badge(tile_id: int) -> bool:
	var views: Array = []
	if game.hand_flow != null and game.hand_flow.get("tile_views") != null:
		views = game.hand_flow.get("tile_views")
	for item in views:
		var v := item as Control
		if v == null:
			continue
		var tile = v.get("tile")
		if tile == null or int(tile.get("id")) != tile_id:
			continue
		if bool(v.get("mark_drawn")):
			return true
	return false


## У имени какого-то игрока чип с подстрокой.
func _chip_has(part: String) -> bool:
	for child in game.chips_box.get_children():
		for c in (child as Control).get_children():
			if c is Label and String((c as Label).text).contains(part):
				return true
	return false


func _pick_ids(data: Dictionary, v: Dictionary) -> void:
	var used := {}
	for tid in v["hand"]:
		used[int(tid)] = true
	for row in v["table"]:
		for tid in row["tileIds"]:
			used[int(tid)] = true
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
