extends SceneTree

# Сверка клиента с НАСТОЯЩИМ представлением, которое присылает сервер.
#
# Фикстура снимается с живого кода сервера:
#     node server/tools/gen_view_fixture.js
# и кладёт в tests/fixtures/views.json ровно те словари, которые летят в
# game.state. Тест собирает из них GameState ровно так же, как это делает
# игра, и сверяет каждое поле.
#
# Зачем так: views.js и view_builder.gd — две стороны одного контракта.
# Тест на выдуманном JSON проверит только сам себя и промолчит, если в
# сервере переименуют поле. Тест на снятом с сервера JSON падает сразу.
#
#     godot --headless --path . --script res://tests/test_view.gd

const FIXTURE := "res://tests/fixtures/views.json"

var fails := 0
var total := 0


func _initialize() -> void:
	if not FileAccess.file_exists(FIXTURE):
		printerr("Нет фикстуры %s — сними её: node server/tools/gen_view_fixture.js" % FIXTURE)
		quit(1)
		return
	var data = JSON.parse_string(FileAccess.get_file_as_string(FIXTURE))
	if not (data is Dictionary):
		printerr("Фикстура не разобралась как объект: %s" % FIXTURE)
		quit(1)
		return

	print("== Клиент и сервер: один контракт ==")
	test_catalog(data)
	test_round_trip(data)
	test_no_opponent_hands(data)
	test_seat_views(data)
	test_set_table_ops(data)
	test_local_edits(data)
	test_snapshot_rollback(data)
	test_check_turn(data)
	test_seat_count_mismatch()
	test_servers_list()
	test_certs()

	print("")
	if fails == 0:
		print("ПРЕДСТАВЛЕНИЕ СОВПАДАЕТ: GameState собирается из ответа сервера без потерь")
		quit(0)
	else:
		printerr("РАСХОЖДЕНИЙ: %d из %d" % [fails, total])
		quit(1)


# ------------------------------------------------------------------ проверки

func test_catalog(data: Dictionary) -> void:
	var catalog: Array = data["catalog"]
	section("каталог фишек")
	ok("в каталоге все 106 фишек", catalog.size() == 106, "пришло %d" % catalog.size())
	ViewBuilder.set_catalog(catalog)
	ok("каталог принят", ViewBuilder.catalog_ready())
	# Один и тот же объект на весь сеанс: состояние сравнивает фишки по
	# ссылке (можно ли забрать назад), и новый объект ломал бы это тихо.
	ok("один объект на номер фишки", ViewBuilder.tile(5) == ViewBuilder.tile(5))
	var t := ViewBuilder.tile(1)
	ok("номер 1 — красная единица", t.color == Tile.TColor.RED and t.value == 1 and not t.is_joker)
	ok("джокер помечен", ViewBuilder.tile(106).is_joker)


func test_round_trip(data: Dictionary) -> void:
	section("состояние собирается из представления")
	var view: Dictionary = data["game"]["seat0"]
	var want: Dictionary = data["expectations"]
	var g := ViewBuilder.build(view)

	ok("наше место", g.local_seat == int(view["you"]))
	ok("сколько мест", g.players.size() == int(view["seats"]), "%d" % g.players.size())
	ok("ходит тот, кого указал сервер", g.current == int(view["current"]))
	ok("наш ход совпал с сервером", g.my_turn() == bool(view["myTurn"]))
	ok("осталось в колоде", g.tiles_left_in_deck() == int(view["deckCount"]))
	ok("нужен ли первый ход на 30", g.require_30 == bool(view["require30"]))
	ok("первый ход ещё не сделан", g.finished == bool(view["finished"]))

	var want_hand: Array = []
	for raw in view["hand"]:
		want_hand.append(int(raw))
	ok("своя рука пришла целиком", _ids(g.hand()) == want_hand,
		"хотели %s, получили %s" % [want_hand, _ids(g.hand())])

	var counts: Array = view["players"]
	for i in counts.size():
		ok("фишек у игрока %d — как сказал сервер" % i,
			g.hand_size(i) == int(counts[i]["handCount"]),
			"хотели %d, получили %d" % [int(counts[i]["handCount"]), g.hand_size(i)])
		ok("игрок %d назван верно" % i, g.player_name(i) == String(counts[i]["nick"]),
			"%s != %s" % [g.player_name(i), String(counts[i]["nick"])])

	var rows: Array = view["table"]
	ok("стол пришёл целиком", g.table.size() == rows.size(),
		"%d рядов вместо %d" % [g.table.size(), rows.size()])
	for i in mini(rows.size(), want["tableRows"].size()):
		var got := (g.table[i] as GameState.Row)
		ok("ряд %d: номер и фишки" % i,
			got.id == int(rows[i]["id"]) and _ids(got.tiles) == _int_list(rows[i]["tileIds"]),
			"ряд %d: id=%d %s" % [i, got.id, _ids(got.tiles)])

	ok("прошлый ход помечен", g.last_turn_tile_ids == _int_list(view["lastTurn"]))
	ok("свои ходы этого поворота помечены",
		_ids(g.turn_placed) == _int_list(view["turnPlaced"]),
		"%s != %s" % [_ids(g.turn_placed), _int_list(view["turnPlaced"])])

	# Все 106 фишек на месте: рука + стол + колода + руки соперников.
	# Сумма не сходится — значит, представление где-то потерялось или
	# где-то протекла чужая рука.
	var total_tiles := g.hand().size() + g.tiles_left_in_deck()
	for i in counts.size():
		total_tiles += g.hand_size(i)
	for row in g.table:
		total_tiles += (row as GameState.Row).tiles.size()
	total_tiles -= g.hand().size()   # своя рука уже учтена в hand_size
	ok("все 106 фишек учтены", total_tiles == 106, "получилось %d" % total_tiles)


func test_no_opponent_hands(data: Dictionary) -> void:
	section("чужие руки клиенту не достаются")
	for seat in ["seat0", "seat1", "seat2"]:
		var view: Dictionary = data["game"][seat]
		var g := ViewBuilder.build(view)
		var me := int(view["you"])
		var clean := true
		var detail := ""
		for i in g.players.size():
			var hand: Array = (g.players[i] as GameState.Player).hand
			if i == me:
				continue
			if not hand.is_empty():
				clean = false
				detail = "место %d: %d лишних фишек" % [i, hand.size()]
		ok("%s: у соперников рук нет" % seat, clean, detail)


func test_seat_views(data: Dictionary) -> void:
	section("три места смотрят по-разному")
	var views: Dictionary = data["game"]
	var whos_turn: Array = []
	for seat in ["seat0", "seat1", "seat2"]:
		var g := ViewBuilder.build(views[seat])
		if g.my_turn():
			whos_turn.append(int(views[seat]["you"]))
	ok("ход ровно у одного", whos_turn.size() == 1, "ходов: %s" % [whos_turn])
	if whos_turn.size() == 1:
		ok("это место, которое сервер назвал current",
			int(whos_turn[0]) == int(views["seat%d" % whos_turn[0]]["current"]))

	# У кого ход — у того в представлении должны быть свои ходы и подсвечен
	# current. Проверяем, что мы читаем поля, а не угадываем.
	for seat in ["seat0", "seat1", "seat2"]:
		var view: Dictionary = views[seat]
		var g := ViewBuilder.build(view)
		if g.my_turn():
			ok("%s: ход свой, поле turnPlaced читается" % seat,
				_ids(g.turn_placed) == _int_list(view["turnPlaced"]))
		else:
			ok("%s: ход чужой, своих ходов нет" % seat, g.turn_placed.is_empty())


func test_set_table_ops(data: Dictionary) -> void:
	section("обратно на сервер: set_table")
	var want: Dictionary = data["expectations"]
	# Ряд в представлении лежит с полем tileIds, а отправлять надо с tiles.
	for seat in ["seat0", "seat1", "seat2"]:
		var g := ViewBuilder.build(data["game"][seat])
		var rows := g.set_table_ops()
		ok("%s: столько же рядов" % seat, rows.size() == (want["tableRows"] as Array).size(),
			"%d вместо %d" % [rows.size(), (want["tableRows"] as Array).size()])
		for i in rows.size():
			var want_row: Dictionary = (want["tableRows"] as Array)[i]
			var got: Dictionary = rows[i]
			ok("%s: ряд %d — id и фишки" % [seat, i],
				int(got["id"]) == int(want_row["id"])
					and _int_list(got["tiles"]) == _int_list(want_row["tiles"]),
				"получили {%s: %s}" % [got["id"], _int_list(got["tiles"])])

	# Пустой ряд отправлять незачем: сервер и так его убирает, а лишний id
	# в сообщении — лишняя возможность разойтись.
	var g := ViewBuilder.build(data["game"]["seat0"])
	(g.table[0] as GameState.Row).tiles.clear()
	ok("пустой ряд не отправляется", g.set_table_ops().size() == 1)


func test_local_edits(data: Dictionary) -> void:
	section("правка стола поверх серверного состояния")
	var g := ViewBuilder.build(data["game"]["seat2"])
	ok("ход наш", g.my_turn())

	var hand := g.hand()
	if hand.is_empty():
		ok("тест пропущен: рука пуста", true)
		return
	var tile: Tile = hand[0]
	var row := g.add_row()
	ok("новый ряд получил незанятый номер",
		row.id > _max_row_id(data["expectations"]["tableRows"]),
		"получили %d" % row.id)
	ok("фишка легла в ряд", g.place_from_hand(tile.id, row.id, 0))
	ok("фишка ушла из руки", not hand.has(tile))
	ok("фишка помечена как наша", g.turn_placed.has(tile))
	ok("фишка в ряду та же самая", (row.tiles[0] as Tile) == tile)
	ok("взятую назад фишку можно вернуть", g.can_take_back(tile))
	ok("ход считается изменённым", g.turn_dirty)

	var rows := g.set_table_ops()
	var found := false
	for r in rows:
		if int((r as Dictionary)["id"]) == 0:
			found = _int_list((r as Dictionary)["tiles"]) == [tile.id]
	ok("новый ряд поехал бы на сервер с id=0-ным", found)


func test_snapshot_rollback(data: Dictionary) -> void:
	section("откат к состоянию сервера")
	var g := ViewBuilder.build(data["game"]["seat2"])
	var hand_before := _ids(g.hand())
	var table_before := _serialize_table(g)
	ok("в начале поворота откатывать нечего", g.turn_placed.is_empty())

	var hand := g.hand()
	if hand.is_empty():
		ok("тест пропущен: рука пуста", true)
		return
	var row := g.add_row()
	g.place_from_hand(hand[0].id, row.id, 0)
	ok("после правки стол изменился", _serialize_table(g) != table_before)

	ok("откат сработал", g.restore_turn_snapshot())
	ok("стол вернулся к серверному", _serialize_table(g) == table_before)
	ok("рука вернулась к серверной", _ids(g.hand()) == hand_before)
	ok("рядов не осталось лишних", g.table.size() == (data["expectations"]["tableRows"] as Array).size())


func test_check_turn(data: Dictionary) -> void:
	section("проверка хода перед отправкой")
	var g := ViewBuilder.build(data["game"]["seat2"])
	# Пустой ход сервер не примет, и клиент должен сказать об этом сам.
	var res := g.check_turn()
	ok("пустой ход отвергнут локально", not bool(res["ok"]), String(res.get("reason", "")))
	ok("и сказано почему", not String(res.get("reason", "")).is_empty())

	# Ход без новых фишек — тоже не ход: нечего показывать.
	var hand := g.hand()
	if not hand.is_empty():
		var moved: Tile = null
		for row in g.table:
			var tiles: Array = (row as GameState.Row).tiles
			if not tiles.is_empty():
				moved = tiles[0]
				break
		if moved != null:
			var src: GameState.Row = g.row_by_id(_row_id_of(g, moved))
			var dst: GameState.Row = g.table[g.table.size() - 1]
			g.move_tile(src.id, moved.id, dst.id, 0)
			ok("перекладывание без новых фишек отвергнуто", not bool(g.check_turn()["ok"]))

	# Нормальный ход должен проходить локальную проверку, иначе игрок
	# получит ошибку, которой нет.
	var fresh := ViewBuilder.build(data["game"]["seat2"])
	if not fresh.hand().is_empty():
		var r := fresh.add_row()
		fresh.place_from_hand(fresh.hand()[0].id, r.id, 0)
		# Ряд из одной фишки невалиден по правилам, а не из-за сети:
		# важно, что причина названа правильно.
		var one := fresh.check_turn()
		ok("короткий ряд отвергнут по правилам", not bool(one["ok"]))
		ok("названа причина", not String(one.get("reason", "")).is_empty())


func test_seat_count_mismatch() -> void:
	section("битое представление не должно ломать игру")
	var g := ViewBuilder.build({
		"you": 0, "seats": 3, "current": 9, "hand": [1, 2, 3],
		"players": [{"nick": "A", "handCount": 3}, {"nick": "B", "handCount": 3}],
		"table": [], "deckCount": 100, "finished": false, "winner": -1,
	})
	ok("current зажат в пределы столов", g.current < g.players.size(),
		"получили %d при %d местах" % [g.current, g.players.size()])
	ok("чужое место не сломало сборку", g.hand().size() == 3)


func test_servers_list() -> void:
	section("список серверов")
	ok("в игре зашиты оба сервера", Servers.BUILTIN.size() == 2,
		"зашито %d" % Servers.BUILTIN.size())
	var seen := {}
	for entry in Servers.BUILTIN:
		seen[String(entry["id"])] = true
		ok("адрес непустой", not String(entry["host"]).is_empty(), String(entry["id"]))
		ok("порт задан", int(entry["port"]) > 0, String(entry["id"]))
	ok("серверы различимы по id", seen.size() == Servers.BUILTIN.size())
	# Подпись собирает экземпляр: проверяем, что он не течёт при сборке
	# мусора, иначе меню будет жечь память на каждом открытии.
	var probe := Servers.new()
	ok("у сервера есть подпись", _label(probe, Servers.BUILTIN[0]) != "")
	probe.free()


func test_certs() -> void:
	section("сертификаты")
	# Собирать игру без сертификатов нельзя, но и ронять сборку из-за
	# отсутствующего файла — тоже нельзя: клиент обязан честно молчать
	# и не подключаться, а не работать по открытой сети.
	var ids := Certs.missing_in(Servers.BUILTIN)
	# Сколько бы их ни было, опции TLS собираются, а список серверов
	# не падает — иначе не войти даже в одиночную игру.
	for entry in Servers.BUILTIN:
		var opts := Certs.tls_options_for(entry)
		ok("опции TLS собираются для %s" % String(entry["id"]), opts != null)

	# А вот это — уже настоящее требование, а не «не хуже было бы».
	# Без зашитых сертификатов клиент не подключится НИ к одному серверу,
	# и снаружи это выглядит не как поломка сборки, а как «сервер не
	# отвечает». Файлы лежат в репозитории (certs/*.crt) и обязаны
	# доезжать до сборки.
	#
	# Раньше здесь стояло `if ids.is_empty(): напечатать(список)`, то есть
	# проверка срабатывала ровно тогда, когда всё хорошо, и печатала
	# ПУСТОЙ список. Сломанная сборка и рабочая выглядели одинаково.
	ok("сертификаты обоих серверов зашиты в клиент", ids.is_empty(),
		"не хватает: %s. Доложить: python server/deploy/deploy.py --certs-only"
			% ", ".join(ids))
	if not ids.is_empty():
		push_error("НЕТ СЕРТИФИКАТОВ: %s — игра не подключится ни к одному серверу"
			% ", ".join(ids))


# --------------------------------------------------------------------- утилиты

func section(name: String) -> void:
	print("-- %s" % name)


func ok(name: String, cond: bool, detail: String = "") -> void:
	total += 1
	if cond:
		print("  ok    %s" % name)
		return
	fails += 1
	printerr("  FAIL  %s%s" % [name, "" if detail.is_empty() else "  (%s)" % detail])


func _ids(tiles: Array) -> Array:
	var out := []
	for t in tiles:
		out.append((t as Tile).id)
	return out


func _int_list(raw: Array) -> Array:
	var out := []
	for v in raw:
		out.append(int(v))
	return out


func _serialize_table(g: GameState) -> String:
	var parts := PackedStringArray()
	for row in g.table:
		parts.append("%d:%s" % [(row as GameState.Row).id, str(_ids((row as GameState.Row).tiles))])
	return ",".join(parts)


func _max_row_id(rows: Array) -> int:
	var out := 0
	for r in rows:
		out = maxi(out, int((r as Dictionary)["id"]))
	return out


## Ряд, в котором лежит фишка.
func _row_id_of(g: GameState, tile: Tile) -> int:
	for row in g.table:
		if (row as GameState.Row).tiles.has(tile):
			return (row as GameState.Row).id
	return -1


func _label(list: Servers, entry: Dictionary) -> String:
	return list.label_of(entry)
