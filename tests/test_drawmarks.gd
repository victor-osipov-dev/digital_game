extends SceneTree

# ==============================================================
#  Пометки взятия из колоды.
#
#  Своё взятие — зелёный шарик в углу фишки, пока она в руке взявшего
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

	if fails == 0:
		print("\nВЗЯТИЕ: все %d проверок прошли" % total)
		quit(0)
	else:
		printerr("\nВЗЯТИЕ: ПРОВАЛОВ %d из %d" % [fails, total])
		quit(1)


## Взятая из колоды помечается шариком, пока она в руке: выложил —
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
	# Ход вернулся к взявшему — шарик на фишке в его руке.
	game.state.current = 0
	game.refresh()
	ok("шарик виден на фишке", _hand_badge(took))
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
	# Хелпер пометки: место без фишки — только чип, без шарика.
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


## Шарик взятой фишки: флаг вида (сам шарик рисуется в _draw).
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
