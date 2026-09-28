class_name GameState
extends RefCounted

const DEAL_SIZE := 14
const MAX_CHECKPOINTS := 3

class Player:
	extends RefCounted
	var pname: String = ""
	var hand: Array = []

	func _init(p_name: String = "") -> void:
		pname = p_name

class Row:
	extends RefCounted
	var id: int = 0
	var tiles: Array = []

	func _init(p_id: int = 0) -> void:
		id = p_id

var players: Array = []
var table: Array = []
var deck: Deck = Deck.new()
var current: int = 0
var require_30: bool = true
var first_turn: bool = true
var finished: bool = false
var winner: int = -1
var turn_placed: Array = []
var turn_dirty: bool = false
var last_turn_tile_ids: Array = []
var checkpoints: Array = []
var _snap_table: Array = []
var _snap_hand: Array = []
var _next_row_id: int = 1

# --- сетевая партия ------------------------------------------------------
#
# В одиночной игре рука есть у всех, и ходит current. В сетевой сервер
# отдаёт руку ТОЛЬКО хозяину: у соперников её нет вовсе, есть число фишек.
# Поэтому «чьи фишки я вижу» и «кто ходит» — разные вещи, и их нельзя
# выводить одно из другого.
var local_seat: int = -1
var hand_count_override: Array = []   # число фишек у соперников
var deck_count_override: int = -1     # сколько осталось в колоде
# На связи ли игрок. В одиночной игре за всех отвечает бот, и поле пустое;
# в сетевой это единственный способ показать «соперник отвалился».
var connected: Array = []

## На связи ли игрок. Нет данных — считаем, что да: иначе одиночная партия
## и только что собранная сетевая показали бы «нет связи» у всех.
func is_connected_player(i: int) -> bool:
	if i < 0 or i >= connected.size():
		return true
	return bool(connected[i])

# Место, чья рука настоящая. В одиночной игре это всегда current.
func hand_seat() -> int:
	return local_seat if local_seat >= 0 else current

## Наш ли сейчас ход. В сетевой игре current может указывать на соперника.
func my_turn() -> bool:
	return local_seat < 0 or current == local_seat

static func create(num_players: int, names: Array, p_require_30: bool) -> GameState:
	var state := GameState.new()
	state.require_30 = p_require_30
	for i in num_players:
		var pname := "Игрок %d" % (i + 1)
		if i < names.size() and not String(names[i]).strip_edges().is_empty():
			pname = String(names[i]).strip_edges()
		state.players.append(Player.new(pname))
	for p in state.players:
		for _i in DEAL_SIZE:
			var t: Tile = state.deck.draw()
			if t == null:
				break
			p.hand.append(t)
		Tile.sort_tiles(p.hand)
	state._take_snapshot()
	return state

func player_count() -> int:
	return players.size()

func player_name(i: int) -> String:
	return (players[i] as Player).pname

func current_player() -> Player:
	return players[current] as Player

func hand() -> Array:
	return (players[hand_seat()] as Player).hand

func hand_size(i: int) -> int:
	# У соперника настоящей руки нет — сервер прислал только число.
	if not hand_count_override.is_empty() and i >= 0 and i < hand_count_override.size():
		return int(hand_count_override[i])
	if i < 0 or i >= players.size():
		return 0
	return (players[i] as Player).hand.size()

func tiles_left_in_deck() -> int:
	if deck_count_override >= 0:
		return deck_count_override
	return deck.count()

func can_touch_row(_row: Row) -> bool:
	return not finished

func can_place_into(_row: Row) -> bool:
	return not finished

func can_drag_from_row(_row: Row, _tile: Tile) -> bool:
	return not finished

func can_take_back(tile: Tile) -> bool:
	return not finished and turn_placed.has(tile)

func can_draw() -> bool:
	return not finished and turn_placed.is_empty() and tiles_left_in_deck() > 0 and table_status().ok

func can_skip() -> bool:
	return not finished and turn_placed.is_empty() and tiles_left_in_deck() == 0 and table_status().ok

func add_row() -> Row:
	var row := Row.new(_next_row_id)
	_next_row_id += 1
	table.append(row)
	turn_dirty = true
	return row

## Сдвигает счётчик новых рядов за пределы уже занятых id. Нужно при
## пересборке состояния с сервера: иначе первый же новый ряд получит id,
## который уже занят чужим рядом на столе.
func reserve_row_ids(used: int) -> void:
	_next_row_id = maxi(_next_row_id, used + 1)

func remove_row(row: Row) -> void:
	table.erase(row)

func row_by_id(row_id: int) -> Row:
	for row in table:
		if row.id == row_id:
			return row
	return null

func place_from_hand(tile_id: int, row_id: int, index: int) -> bool:
	if finished:
		return false
	var row := row_by_id(row_id)
	if row == null or not can_touch_row(row):
		return false
	var hand_tiles := hand()
	var tile: Tile = null
	for t in hand_tiles:
		if t.id == tile_id:
			tile = t
			break
	if tile == null:
		return false
	hand_tiles.erase(tile)
	var pos := clampi(index, 0, row.tiles.size())
	row.tiles.insert(pos, tile)
	turn_placed.append(tile)
	turn_dirty = true
	return true

func move_tile(src_row_id: int, tile_id: int, dst_row_id: int, dst_index: int) -> bool:
	if finished:
		return false
	var src := row_by_id(src_row_id)
	var dst := row_by_id(dst_row_id)
	if src == null or dst == null:
		return false
	if not can_touch_row(src) or not can_touch_row(dst):
		return false
	var old := _index_of(src, tile_id)
	if old < 0:
		return false
	var tile: Tile = src.tiles[old]
	if src == dst:
		src.tiles.remove_at(old)
		var target := dst_index
		if old < target:
			target -= 1
		target = clampi(target, 0, src.tiles.size())
		src.tiles.insert(target, tile)
		turn_dirty = true
		return true
	src.tiles.remove_at(old)
	var pos := clampi(dst_index, 0, dst.tiles.size())
	dst.tiles.insert(pos, tile)
	if src.tiles.is_empty():
		remove_row(src)
	turn_dirty = true
	return true

func take_back_to_hand(row_id: int, tile_id: int) -> bool:
	if finished:
		return false
	var row := row_by_id(row_id)
	if row == null:
		return false
	var idx := _index_of(row, tile_id)
	if idx < 0:
		return false
	var tile: Tile = row.tiles[idx]
	if not turn_placed.has(tile):
		return false
	row.tiles.remove_at(idx)
	turn_placed.erase(tile)
	turn_dirty = true
	var owner := hand_seat()
	(players[owner] as Player).hand.append(tile)
	Tile.sort_tiles((players[owner] as Player).hand)
	if row.tiles.is_empty():
		remove_row(row)
	return true

func draw_from_deck() -> Dictionary:
	if finished:
		return _result(false, "Игра окончена")
	if not turn_placed.is_empty():
		return _result(false, "Нельзя брать из колоды после выкладки")
	if deck.count() == 0:
		return _result(false, "Колода пуста")
	var status := table_status()
	if not status["ok"]:
		return _result(false, "Сначала закончите перестановку на столе")
	var tile := deck.draw()
	if tile == null:
		return _result(false, "Колода пуста")
	var me := players[hand_seat()] as Player
	me.hand.append(tile)
	Tile.sort_tiles(me.hand)
	_advance()
	return _result(true, "", {tile=tile})

func skip_turn() -> Dictionary:
	if finished:
		return _result(false, "Игра окончена")
	if deck.count() > 0:
		return _result(false, "Колода ещё полна — возьмите число")
	if not turn_placed.is_empty():
		return _result(false, "Воспользуйтесь кнопкой «Продолжить»")
	var status := table_status()
	if not status["ok"]:
		return _result(false, "Сначала закончите перестановку на столе")
	_advance()
	return _result(true, "")

## Проверки перед завершением хода. Ничего не меняет.
##
## Нужны для сетевой игры: сервер всё равно проверит у себя, но ждать
## сети, чтобы показать «ряд невалиден», неудобно — ошибку видно сразу.
func check_turn() -> Dictionary:
	if finished:
		return _result(false, "Игра окончена")
	if turn_placed.is_empty():
		return _result(false, "Выложите хотя бы одно число или возьмите из колоды")
	var status := table_status()
	if not status["ok"]:
		var errors: Array = status["errors"]
		return {
			ok=false,
			reason=String(errors[0]["reason"]) if not errors.is_empty() else "Стол в невалидном состоянии",
			errors=errors,
		}
	if require_30 and first_turn:
		var pts := opening_points()
		if pts < Rules.OPENING_POINTS:
			return {
				ok=false,
				reason="Самый первый ход игры — минимум %d очков (у вас %d)" % [Rules.OPENING_POINTS, pts],
				errors=[],
			}
	return _result(true, "")

func end_turn() -> Dictionary:
	var check := check_turn()
	if not check["ok"]:
		return check
	first_turn = false
	_remove_empty_rows()
	if hand().is_empty():
		winner = hand_seat()
		finished = true
		return {ok=true, reason="", errors=[], win=true}
	_advance()
	return {ok=true, reason="", errors=[], win=false}

## Готовый стол для сервера: [{id, tiles:[tile_id,...]}].
## id > 0 — существующий ряд, 0 — новый. Пустые ряды не отправляем:
## на сервере они и так исчезнут.
func set_table_ops() -> Array:
	var rows := []
	for row in table:
		var r := row as Row
		if r.tiles.is_empty():
			continue
		var ids := PackedInt32Array()
		for t in r.tiles:
			ids.append((t as Tile).id)
		rows.append({"id": r.id, "tiles": ids})
	return rows

func table_status() -> Dictionary:
	var errors := []
	for i in table.size():
		var tiles: Array = (table[i] as Row).tiles
		if tiles.is_empty():
			continue
		var result := Rules.validate_row(tiles)
		if not result["ok"]:
			errors.append({row=i, reason=result["reason"]})
	return {ok=errors.is_empty(), errors=errors}

func opening_points() -> int:
	var total := 0
	for tile in turn_placed:
		for row in table:
			var idx := _index_of(row as Row, tile.id)
			if idx < 0:
				continue
			var result := Rules.validate_row((row as Row).tiles)
			if tile.is_joker and result["ok"]:
				total += int(result["joker_values"].get(tile.id, 0))
			else:
				total += tile.value
			break
	return total

func _advance() -> void:
	last_turn_tile_ids.clear()
	for t in turn_placed:
		last_turn_tile_ids.append((t as Tile).id)
	turn_placed.clear()
	first_turn = false
	checkpoints.clear()
	current = (current + 1) % player_count()
	_take_snapshot()

func save_checkpoint() -> bool:
	if finished or not turn_dirty:
		return false
	checkpoints.append({
		table=_capture_table(),
		hand=hand().duplicate(),
		turn_placed=turn_placed.duplicate(),
	})
	while checkpoints.size() > MAX_CHECKPOINTS:
		checkpoints.remove_at(0)
	return true

func restore_checkpoint() -> bool:
	if finished or checkpoints.is_empty():
		return false
	var snap: Dictionary = checkpoints.pop_back()
	_apply_table(snap["table"])
	(players[hand_seat()] as Player).hand = (snap["hand"] as Array).duplicate()
	turn_placed = (snap["turn_placed"] as Array).duplicate()
	turn_dirty = true
	return true

func checkpoint_count() -> int:
	return checkpoints.size()

func apply_ops(ops: Array) -> bool:
	if finished:
		return false
	var created := {}
	for op in ops:
		var kind := String(op.get("op", ""))
		if kind == "place":
			var row := _resolve_ref(String(op.get("to", "")), created)
			if row == null:
				return false
			if not place_from_hand(int(op.get("tile", -1)), row.id, int(op.get("index", 99))):
				return false
		elif kind == "move":
			var src := _resolve_ref(String(op.get("from", "")), created)
			var dst := _resolve_ref(String(op.get("to", "")), created)
			if src == null or dst == null:
				return false
			if not move_tile(src.id, int(op.get("tile", -1)), dst.id, int(op.get("index", 99))):
				return false
		else:
			return false
	return true

func _resolve_ref(ref: String, created: Dictionary) -> Row:
	if ref.begins_with("n"):
		if not created.has(ref):
			created[ref] = add_row().id
		return row_by_id(int(created[ref]))
	elif ref.begins_with("r"):
		return row_by_id(int(ref.substr(1)))
	return null

func _remove_empty_rows() -> void:
	var kept: Array = []
	for row in table:
		if not (row as Row).tiles.is_empty():
			kept.append(row)
	table = kept

func _capture_table() -> Array:
	var out := []
	for row in table:
		var r := row as Row
		out.append({id=r.id, tiles=r.tiles.duplicate()})
	return out

func _apply_table(data: Array) -> void:
	table = []
	for entry in data:
		var r := Row.new(int(entry["id"]))
		r.tiles = (entry["tiles"] as Array).duplicate()
		table.append(r)

func take_turn_snapshot() -> void:
	_take_snapshot()

func _take_snapshot() -> void:
	_snap_table = _capture_table()
	_snap_hand = (players[hand_seat()] as Player).hand.duplicate()
	turn_dirty = false

func restore_turn_snapshot() -> bool:
	if finished:
		return false
	_apply_table(_snap_table)
	(players[hand_seat()] as Player).hand = _snap_hand.duplicate()
	turn_placed.clear()
	turn_dirty = false
	return true

func _index_of(row: Row, tile_id: int) -> int:
	for i in row.tiles.size():
		if (row.tiles[i] as Tile).id == tile_id:
			return i
	return -1

func _result(ok: bool, reason: String, extra: Dictionary = {}) -> Dictionary:
	var out := {ok=ok, reason=reason}
	for key in extra:
		out[key] = extra[key]
	return out
