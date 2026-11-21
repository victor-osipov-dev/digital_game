extends SceneTree

# Тест соответствия правил между двумя движками.
#
# Одиночная игра считается на GDScript (scripts/core/rules.gd), сетевая — на
# JS (server/src/engine/rules.js). Если один из них начнёт считать иначе,
# сервер и клиент разойдутся в вердиктах посреди партии.
#
# Контракт лежит в tests/fixtures/rules_corpus.json и генерируется командой:
#     node server/tools/gen_corpus.js
#
# Запуск:
#     godot --headless --path . --script res://tests/test_conformance.gd

const CORPUS := "res://tests/fixtures/rules_corpus.json"
const MAX_REPORT := 12

var fails := 0
var total := 0
var reported := 0

func _initialize() -> void:
	if not FileAccess.file_exists(CORPUS):
		printerr("Нет файла контракта: " + CORPUS)
		printerr("Сгенерируй: node server/tools/gen_corpus.js")
		quit(1)
		return

	var text := FileAccess.get_file_as_string(CORPUS)
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_ARRAY:
		printerr("Не удалось разобрать контракт как JSON-массив")
		quit(1)
		return

	var cases: Array = parsed
	var t0 := Time.get_ticks_msec()
	var ok_rows := 0
	var ok_runs := 0
	var ok_sets := 0
	var jokers_checked := 0

	for entry in cases:
		total += 1
		var row: Array = entry[0]
		var expect: Array = entry[1]
		var tiles: Array = []
		for i in row.size():
			var s: Array = row[i]
			tiles.append(Tile.new(i, int(s[0]), int(s[1]), int(s[2]) == 1))

		var res: Dictionary = Rules.validate_row(tiles)
		var got_ok: bool = bool(res["ok"])
		var got_kind := String(res.get("kind", ""))
		var got_reason := String(res.get("reason", ""))
		var got_points := Rules.row_points(tiles)
		var jv: Dictionary = res.get("joker_values", {})

		var exp_ok: bool = int(expect[0]) == 1
		var exp_kind := String(expect[1])
		var exp_reason := String(expect[2])
		var exp_jokers: Array = expect[3]
		var exp_points := int(expect[4])

		var bad := ""
		if got_ok != exp_ok:
			bad = "ok: gdscript=%s js=%s" % [got_ok, exp_ok]
		elif got_ok and got_kind != exp_kind:
			bad = "kind: gdscript=%s js=%s" % [got_kind, exp_kind]
		elif got_reason != exp_reason:
			bad = "reason: gdscript=%s js=%s" % [got_reason, exp_reason]
		elif got_points != exp_points:
			bad = "points: gdscript=%d js=%d" % [got_points, exp_points]
		else:
			# Значения джокеров сверяются как множество: важно и какие ключи
			# вообще есть (у невалидных рядов их нет), и их значения.
			# JSON отдаёт числа как float — приводим к int, иначе сравнение
			# массивов будет ловить ложное расхождение 2 vs 2.0.
			var exp_jokers_int: Array = []
			for pair in exp_jokers:
				exp_jokers_int.append([int(pair[0]), int(pair[1])])
			var got_jokers: Array = []
			for tile in tiles:
				var t: Tile = tile
				if not t.is_joker:
					continue
				if jv.has(t.id):
					got_jokers.append([t.id, int(jv[t.id])])
			if got_jokers != exp_jokers_int:
				bad = "jokers: gdscript=%s js=%s" % [str(got_jokers), str(exp_jokers_int)]
			else:
				jokers_checked += exp_jokers_int.size()

		if bad == "":
			if exp_ok:
				ok_rows += 1
				if exp_kind == "run":
					ok_runs += 1
				elif exp_kind == "set":
					ok_sets += 1
		else:
			fails += 1
			if reported < MAX_REPORT:
				reported += 1
				printerr("FAIL %s" % bad)
				printerr("     row = %s" % str(row))

	var ms := Time.get_ticks_msec() - t0
	print("== Соответствие правил GDScript <-> JS ==")
	print("  кейсов:        %d" % total)
	print("  валидных:      %d (серий %d, наборов %d)" % [ok_rows, ok_runs, ok_sets])
	print("  невалидных:    %d" % (total - ok_rows))
	print("  значений джокеров сверено: %d" % jokers_checked)
	print("  время:         %d мс" % ms)
	print("")
	if fails == 0:
		print("RULES MATCH: GDScript и JS дают одинаковые вердикты на всех %d кейсах" % total)
		quit(0)
	else:
		printerr("RULES DIVERGED: расхождений %d из %d" % [fails, total])
		quit(1)
