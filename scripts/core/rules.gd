class_name Rules
const Lang := preload("res://scripts/core/lang.gd")

const MIN_TILES := 3
const MAX_SET := 4
const MIN_VALUE := 1
const MAX_VALUE := 13
const OPENING_POINTS := 30

static func validate_row(tiles: Array) -> Dictionary:
	if tiles.size() < MIN_TILES:
		return _fail(Lang.t("в ряду должно быть минимум 3 числа"))
	var as_set := _check_set(tiles)
	if as_set["ok"]:
		return as_set
	var as_run := _check_run(tiles)
	if as_run["ok"]:
		return as_run
	var reason := String(as_run["reason"])
	if reason.is_empty():
		reason = String(as_set["reason"])
	if reason.is_empty():
		reason = Lang.t("не серия одного цвета по порядку и не набор одного значения разных цветов")
	return _fail(reason)

static func _fail(reason: String) -> Dictionary:
	return {"ok": false, "reason": reason, "kind": "", "joker_values": {}}

static func _ok(kind: String, joker_values: Dictionary) -> Dictionary:
	return {"ok": true, "reason": "", "kind": kind, "joker_values": joker_values}

static func _check_set(tiles: Array) -> Dictionary:
	var values: Array = []
	var colors := {}
	var joker_count := 0
	for t in tiles:
		if t.is_joker:
			joker_count += 1
		else:
			values.append(t.value)
			colors[t.color] = true
	var first_value := -1
	if not values.is_empty():
		first_value = values[0]
		for v in values:
			if v != first_value:
				return _fail("")
		if colors.size() != values.size():
			return _fail(Lang.t("в наборе не может быть двух чисел одного цвета"))
	if tiles.size() > MAX_SET:
		return _fail(Lang.t("набор не может быть длиннее 4 чисел (уникальные цвета)"))
	if colors.size() + joker_count > MAX_SET:
		return _fail(Lang.t("в наборе не может быть двух чисел одного цвета"))
	var joker_values := {}
	for t in tiles:
		if t.is_joker:
			joker_values[t.id] = first_value if first_value >= MIN_VALUE else MIN_VALUE
	return _ok("set", joker_values)

static func _check_run(tiles: Array) -> Dictionary:
	var run_color := -1
	for t in tiles:
		if t.is_joker:
			continue
		if run_color == -1:
			run_color = t.color
		elif t.color != run_color:
			return _fail(Lang.t("серия должна быть одного цвета"))
	var joker_values := {}
	var n := tiles.size()
	var idx := 0
	var lead := 0
	while idx < n and tiles[idx].is_joker:
		lead += 1
		idx += 1
	if idx >= n:
		if n > MAX_VALUE:
			return _fail(Lang.t("серия не может быть длиннее 13 чисел"))
		for i in n:
			joker_values[tiles[i].id] = i + 1
		return _ok("run", joker_values)
	var first_val: int = tiles[idx].value
	if first_val - lead < MIN_VALUE:
		return _fail(Lang.t("серия выходит за пределы чисел 1..13"))
	for i in lead:
		joker_values[tiles[idx - lead + i].id] = first_val - lead + i
	var prev := first_val
	idx += 1
	while idx < n:
		var t: Tile = tiles[idx]
		if t.is_joker:
			var k := 0
			var start := idx
			while idx < n and tiles[idx].is_joker:
				k += 1
				idx += 1
			if idx >= n:
				if prev + k > MAX_VALUE:
					return _fail(Lang.t("серия выходит за пределы чисел 1..13"))
				for i in k:
					joker_values[tiles[start + i].id] = prev + 1 + i
				prev += k
			else:
				var nxt: int = tiles[idx].value
				if nxt != prev + k + 1:
					return _fail(Lang.t("в серии не хватает числа %d (стоит %d)") % [prev + k + 1, nxt])
				for i in k:
					joker_values[tiles[start + i].id] = prev + 1 + i
				prev = nxt
				idx += 1
		else:
			if t.value != prev + 1:
				return _fail(Lang.t("числа идут не по порядку: после %d нужно %d") % [prev, prev + 1])
			prev = t.value
			idx += 1
	return _ok("run", joker_values)

static func row_points(tiles: Array) -> int:
	var result := validate_row(tiles)
	var joker_values: Dictionary = result["joker_values"]
	var total := 0
	for t in tiles:
		if t.is_joker:
			total += int(joker_values.get(t.id, 0))
		else:
			total += t.value
	return total

static func rules_text() -> String:
	return "\n".join(PackedStringArray([
		Lang.t("[b]Цель[/b]"),
		Lang.t("Первый игрок, оставшийся без чисел в руке, побеждает."),
		"",
		Lang.t("[b]Колода[/b]"),
		Lang.t("106 чисел: 4 цвета (красный, синий, чёрный, оранжевый), значения 1–13,"),
		Lang.t("по 2 экземпляра каждого + 2 джокера (жёлтый и фиолетовый)."),
		Lang.t("Джокер заменяет любое число любого цвета."),
		"",
		Lang.t("[b]Ход[/b]"),
		Lang.t("Каждый ход — ровно одно действие: выложить хотя бы одно число из руки"),
		Lang.t("ИЛИ взять одно случайное число из колоды."),
		Lang.t("В течение хода стол можно свободно перестраивать, а кнопка"),
		Lang.t("«Отменить ход» возвращает стол и руку к началу текущего хода."),
		"",
		Lang.t("[b]Ряды[/b]"),
		Lang.t("Серия: 3 и более числа одного цвета по порядку (например 5, 6, 7)."),
		Lang.t(
			"Набор: 3 или 4 числа одного значения разных цветов (например 7 красная, 7 синяя, 7 чёрная)."),
		Lang.t("Перестраивать можно любые ряды на столе, включая выложенные другими игроками:"),
		Lang.t("разбивать их, переносить числа между рядами и возвращать в руку."),
		Lang.t("На поле можно временно разбивать ряды (в том числе на 1 число),"),
		Lang.t("но к концу хода каждый ряд обязан содержать минимум 3 числа и быть валидным."),
		"",
		Lang.t("[b]Первый ход[/b]"),
		Lang.t("Самый первый ход игры (первый игрок) должен быть не меньше 30 очков (сумма чисел),"),
		Lang.t("если правило включено в настройках."),
		Lang.t("Всем остальным игрокам выкладываться можно с любого числа очков."),
		"",
		Lang.t("[b]Колода пуста[/b]"),
		Lang.t("Брать неоткуда — остаётся только выкладка. Если выложить нечем — ход пропускается."),
	]))
