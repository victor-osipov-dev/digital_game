extends SceneTree

const T := Tile.TColor

var fails := 0
var total := 0
var _nid := 10000

func check(cond: bool, msg: String) -> void:
	total += 1
	if cond:
		print("  ok  " + msg)
	else:
		fails += 1
		printerr("FAIL  " + msg)

func t(v: int, c: int = T.RED) -> Tile:
	_nid += 1
	return Tile.new(_nid, c, v, false)

func jk(c: int = T.BLUE) -> Tile:
	_nid += 1
	return Tile.new(_nid, c, 1, true)

func fresh(s: GameState, tiles: Array) -> void:
	var p: GameState.Player = s.current_player()
	while not p.hand.is_empty():
		p.hand.pop_back()
	for tile in tiles:
		p.hand.append(tile)

func _init() -> void:
	print("== Deck ==")
	var d := Deck.new()
	check(d.total_tiles() == 108, "total tiles = 108, got %d" % d.total_tiles())
	var counts := {}
	var jokers := 0
	for tile in d.tiles:
		if (tile as Tile).is_joker:
			jokers += 1
		else:
			var key := "%d/%d" % [tile.color, tile.value]
			counts[key] = int(counts.get(key, 0)) + 1
	check(jokers == 4, "4 jokers, got %d" % jokers)
	check(counts.size() == 52, "52 distinct color/value pairs, got %d" % counts.size())
	var all_two := true
	for k in counts:
		if counts[k] != 2:
			all_two = false
	check(all_two, "each pair has exactly 2 copies")
	var drawn := 0
	while d.draw() != null:
		drawn += 1
	check(drawn == 108 and d.count() == 0, "deck empties after 108 draws")
	check(d.draw() == null, "draw from empty deck returns null")

	print("== Rules: runs ==")
	var r := Rules.validate_row([t(5), t(6), t(7)])
	check(r.ok and r.kind == "run", "5,6,7 same color is a run")
	r = Rules.validate_row([t(5), t(6), t(7, T.BLUE)])
	check(not r.ok, "mixed colors is not a run")
	r = Rules.validate_row([t(1), t(13)])
	check(not r.ok, "2 tiles rejected")
	r = Rules.validate_row([t(13), t(12), t(11)])
	check(not r.ok, "descending order rejected")
	r = Rules.validate_row([t(5), t(6), t(8)])
	check(not r.ok, "gap rejected")
	r = Rules.validate_row([t(12), t(13), jk()])
	check(not r.ok, "joker after 13 rejected")
	r = Rules.validate_row([jk(), t(2), t(3)])
	check(r.ok and int(r.joker_values.values()[0]) == 1, "leading joker becomes 1")
	r = Rules.validate_row([t(5), jk(), t(7)])
	check(r.ok and int(r.joker_values.values()[0]) == 6, "middle joker becomes 6")
	r = Rules.validate_row([t(11), t(12), jk()])
	check(r.ok and int(r.joker_values.values()[0]) == 13, "trailing joker becomes 13")
	r = Rules.validate_row([jk(), jk(), jk()])
	check(r.ok, "three jokers form a valid row (set or run)")
	var long_run: Array = []
	for v in range(1, 14):
		long_run.append(t(v))
	long_run.append(jk())
	r = Rules.validate_row(long_run)
	check(not r.ok, "13 numbers + joker rejected (over 13)")
	r = Rules.validate_row([t(5, T.RED), t(5, T.RED), t(6, T.RED)])
	check(not r.ok, "duplicate values in run rejected")

	print("== Rules: sets ==")
	r = Rules.validate_row([t(7), t(7, T.BLUE), t(7, T.BLACK)])
	check(r.ok and r.kind == "set", "7R,7B,7K is a set")
	r = Rules.validate_row([t(7), t(7, T.BLUE), t(7, T.BLACK), t(7, T.ORANGE)])
	check(r.ok and r.kind == "set", "4 different colors set is valid")
	r = Rules.validate_row([t(7), t(7), t(7, T.BLUE)])
	check(not r.ok, "two red 7s rejected")
	r = Rules.validate_row([t(7), t(7, T.BLUE), t(7, T.BLACK), t(7, T.ORANGE), jk()])
	check(not r.ok, "set of 5 rejected")
	r = Rules.validate_row([t(7), t(7, T.BLUE), jk()])
	check(r.ok and r.kind == "set" and int(r.joker_values.values()[0]) == 7, "set + joker = 7")
	r = Rules.validate_row([t(7), t(8), t(7, T.BLUE)])
	check(not r.ok, "7,8,7 neither set nor run")
	check(Rules.row_points([t(5), t(6), t(7)]) == 18, "row points 5+6+7 = 18")
	check(Rules.row_points([t(7), t(7, T.BLUE), jk()]) == 21, "set points with joker = 21")

	print("== GameState: setup ==")
	var s := GameState.create(3, ["Анна", "Борис", ""], true)
	check(s.player_count() == 3, "3 players")
	check(s.player_name(0) == "Анна" and s.player_name(2) == "Игрок 3", "names + default")
	check(s.hand_size(0) == 14 and s.hand_size(2) == 14, "14 tiles each")
	check(s.tiles_left_in_deck() == 66, "deck left = 108 - 42 = 66, got %d" % s.tiles_left_in_deck())
	check(s.can_draw(), "can draw at start")
	check(not s.can_skip(), "cannot skip while deck has tiles")

	print("== GameState: opening 30 ==")
	s = GameState.create(2, ["A", "B"], true)
	fresh(s, [t(5), t(6), t(7), t(10), t(11), t(12), t(13)])
	var row1 := s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 5")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 6")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7")
	check(not s.can_draw(), "cannot draw after placing")
	var res: Dictionary = s.end_turn()
	check(not res.ok, "end turn rejected: below 30 points (%s)" % res.get("reason", ""))
	check(s.first_turn, "still first turn (30 rule applies)")
	var row2 := s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row2.id, 99), "place 10")
	check(s.place_from_hand(s.hand()[0].id, row2.id, 99), "place 11")
	check(s.place_from_hand(s.hand()[0].id, row2.id, 99), "place 12")
	check(s.opening_points() == 51, "opening points = 5+6+7+10+11+12 = 51, got %d" % s.opening_points())
	check(s.hand_size(0) == 1, "tile 13 stays in hand")
	res = s.end_turn()
	check(res.ok, "end turn accepted: 51 points (%s)" % res.get("reason", ""))
	check(not s.first_turn, "first_turn cleared after the opening turn")
	check(s.current == 1, "turn moved to player 1")

	print("== GameState: 30-point rule disabled ==")
	s = GameState.create(2, ["A", "B"], false)
	fresh(s, [t(5), t(6), t(7)])
	row1 = s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 5")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 6")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7")
	res = s.end_turn()
	check(res.ok, "require_30=false: 15 points accepted (%s)" % res.get("reason", ""))
	check(not s.first_turn, "first turn finished")

	print("== GameState: rows always touchable (incl. opponents') ==")
	s = GameState.create(2, ["A", "B"], false)
	fresh(s, [t(5), t(6), t(7), t(13)])
	row1 = s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 5")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 6")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7")
	res = s.end_turn()
	check(res.ok, "player 0 ends turn (%s)" % res.get("reason", ""))
	check(s.current == 1, "player 1 to move")
	check(s.can_touch_row(row1), "opponent's row touchable right away")
	check(s.can_drag_from_row(row1, row1.tiles[0]), "can drag tile from opponent's row")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 0), "player 1 places into opponent's row")
	check(s.move_tile(row1.id, (row1.tiles[0] as Tile).id, row1.id, 2), "reorder tiles in opponent's row")

	print("== GameState: 30 only for the very first turn + undo ==")
	s = GameState.create(2, ["A", "B"], true)
	fresh(s, [t(5), t(6), t(7)])
	row1 = s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 5")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 6")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7")
	check(s.turn_dirty, "turn is dirty after placements")
	res = s.end_turn()
	check(not res.ok, "very first turn: 15 points rejected (%s)" % res.get("reason", ""))
	check(s.restore_turn_snapshot(), "undo restores snapshot")
	check(s.table.is_empty(), "table cleared by undo")
	check(s.hand_size(0) == 14, "hand restored to dealt 14 tiles, got %d" % s.hand_size(0))
	check(not s.turn_dirty, "dirty flag cleared")
	check(s.turn_placed.is_empty(), "turn_placed cleared")
	res = s.draw_from_deck()
	check(res.ok and s.current == 1, "draw ends the first turn")
	check(not s.first_turn, "30-rule off after the first turn")
	fresh(s, [t(5), t(6), t(7)])
	row1 = s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 5")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 6")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7")
	res = s.end_turn()
	check(res.ok, "second player's first move: 15 points accepted (%s)" % res.get("reason", ""))

	print("== GameState: take-back and validity ==")
	s = GameState.create(2, ["A", "B"], false)
	fresh(s, [t(5), t(6), t(7), t(9)])
	row1 = s.add_row()
	var arr: Array = s.hand()
	var id5: int = (arr[0] as Tile).id
	var id6: int = (arr[1] as Tile).id
	var id7: int = (arr[2] as Tile).id
	check(s.place_from_hand(id5, row1.id, 99), "place 5")
	check(s.place_from_hand(id6, row1.id, 99), "place 6")
	check(s.place_from_hand(id7, row1.id, 99), "place 7")
	check(s.take_back_to_hand(row1.id, id6), "take 6 back to hand")
	check(s.hand_size(0) == 2 and row1.tiles.size() == 2, "hand 2 tiles (9,6), row 2 tiles (5,7)")
	check(not s.table_status().ok, "row 5,7 invalid mid-turn")
	check(not s.can_draw(), "cannot draw with placed tiles")
	res = s.end_turn()
	check(not res.ok, "end turn blocked: invalid row (%s)" % res.get("reason", ""))
	check(s.place_from_hand(id6, row1.id, 1), "place 6 back between 5 and 7")
	check(s.table_status().ok, "row 5,6,7 valid again")
	res = s.end_turn()
	check(res.ok, "end turn accepted after fix (%s)" % res.get("reason", ""))
	check(not s.can_take_back(row1.tiles[0] as Tile), "take-back forbidden next turn (turn_placed cleared)")

	print("== GameState: split rows mid-turn ==")
	s = GameState.create(2, ["A", "B"], false)
	fresh(s, [t(5), t(6), t(7), t(9)])
	row1 = s.add_row()
	arr = s.hand()
	id5 = (arr[0] as Tile).id
	id6 = (arr[1] as Tile).id
	id7 = (arr[2] as Tile).id
	var id9: int = (arr[3] as Tile).id
	check(s.place_from_hand(id5, row1.id, 99), "place 5")
	check(s.place_from_hand(id6, row1.id, 99), "place 6")
	check(s.place_from_hand(id7, row1.id, 99), "place 7")
	row2 = s.add_row()
	check(s.place_from_hand(id9, row2.id, 99), "place 9 into new row")
	check(s.move_tile(row1.id, id6, row2.id, 1), "move 6 into row with 9")
	check(not s.table_status().ok, "5,7 and 9,6 are invalid")
	res = s.end_turn()
	check(not res.ok, "end turn blocked while table invalid (%s)" % res.get("reason", ""))
	check(s.move_tile(row2.id, id6, row1.id, 1), "move 6 back to 5,7")
	check(not s.table_status().ok, "lone 9 still invalidates table")
	check(s.take_back_to_hand(row2.id, id9), "take lone 9 back to hand")
	check(s.table_status().ok, "table valid again after removing lone 9")
	res = s.end_turn()
	check(res.ok, "end turn accepted after fix (%s)" % res.get("reason", ""))

	print("== GameState: draw / skip / advance ==")
	s = GameState.create(2, ["A", "B"], false)
	var before := s.hand_size(0)
	res = s.draw_from_deck()
	check(res.ok and s.hand_size(0) == before + 1, "draw adds a tile")
	check(s.current == 1, "draw advances turn")
	check(s.tiles_left_in_deck() == 79, "deck decremented: 108-28-1=79, got %d" % s.tiles_left_in_deck())
	check(s.turn_placed.is_empty(), "turn_placed reset after draw")
	s = GameState.create(2, ["A", "B"], false)
	s.deck.tiles.clear()
	check(not s.can_draw(), "empty deck: no draw")
	check(s.can_skip(), "empty deck: skip allowed")
	res = s.skip_turn()
	check(res.ok and s.current == 1, "skip advances turn")
	fresh(s, [t(5), t(6), t(7), t(8)])
	row1 = s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 5")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 6")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7")
	check(s.hand_size(1) == 1, "one tile (8) stays in hand")
	res = s.end_turn()
	check(res.ok and res.get("win", false) == false, "turn ok, no win")
	check(s.current == 0, "turn passed back to player 0")

	print("== GameState: win ==")
	s = GameState.create(2, ["A", "B"], false)
	fresh(s, [t(5), t(6), t(7)])
	row1 = s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 5")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 6")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7")
	res = s.end_turn()
	check(res.ok and res.get("win", false) == true, "empty hand = win")
	check(s.finished and s.winner == 0, "finished, winner is player 0")
	check(not s.can_draw() and not s.can_skip(), "no actions after finish")
	res = s.draw_from_deck()
	check(not res.ok, "draw rejected after finish")

	print("== GameState: checkpoints ==")
	s = GameState.create(2, ["A", "B"], false)
	fresh(s, [t(5), t(6), t(7), t(9), t(11)])
	check(not s.save_checkpoint(), "save rejected when nothing changed")
	row1 = s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 5")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 6")
	check(s.save_checkpoint(), "checkpoint 1 saved")
	check(s.checkpoint_count() == 1, "1 checkpoint")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7")
	row2 = s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row2.id, 99), "place 9 into new row")
	check(s.save_checkpoint(), "checkpoint 2 saved")
	check(s.place_from_hand(s.hand()[0].id, row2.id, 99), "place 11")
	check(s.restore_checkpoint(), "restore checkpoint 2")
	check(s.table.size() == 2 and (s.row_by_id(2) as GameState.Row).tiles.size() == 1, "cp2: row2 has only 9")
	check(s.hand_size(0) == 1, "cp2: hand back to [11]")
	check(s.restore_checkpoint(), "restore checkpoint 1")
	check(s.table.size() == 1 and (s.row_by_id(1) as GameState.Row).tiles.size() == 2, "cp1: row1 = [5,6]")
	check(s.hand_size(0) == 3, "cp1: hand = [7,9,11]")
	check(not s.restore_checkpoint(), "restore with empty stack fails")
	for i in 4:
		check(s.save_checkpoint(), "save #%d ok" % (i + 1))
	check(s.checkpoint_count() == 3, "stack capped at %d" % GameState.MAX_CHECKPOINTS)
	row1 = s.row_by_id(1)
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7 back")
	res = s.end_turn()
	check(res.ok, "end turn ok (%s)" % res.get("reason", ""))
	check(s.current == 1, "turn advanced")
	check(s.checkpoint_count() == 0, "checkpoints cleared on advance")

	print("== GameState: last_turn_tile_ids ==")
	s = GameState.create(2, ["A", "B"], false)
	fresh(s, [t(5), t(6), t(7), t(13)])
	row1 = s.add_row()
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 5")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 6")
	check(s.place_from_hand(s.hand()[0].id, row1.id, 99), "place 7")
	check(s.last_turn_tile_ids.is_empty(), "no highlight during the turn")
	res = s.end_turn()
	check(res.ok, "end turn ok")
	check(s.last_turn_tile_ids.size() == 3, "3 tile ids remembered, got %d" % s.last_turn_tile_ids.size())
	var placed_ids := {}
	for tt in row1.tiles:
		placed_ids[(tt as Tile).id] = true
	var all_found := true
	for idv in s.last_turn_tile_ids:
		if not placed_ids.has(idv):
			all_found = false
	check(all_found, "remembered ids match the placed tiles")
	res = s.draw_from_deck()
	check(res.ok, "player 1 draws")
	check(s.last_turn_tile_ids.is_empty(), "highlight cleared after the next turn ends")

	print("== TurnPlanner: medium place -> apply -> end ==")
	s = GameState.create(2, ["A", "B"], false)
	fresh(s, [t(5), t(6), t(7), t(13)])
	var plan: Dictionary = TurnPlanner.plan(s, TurnPlanner.LEVEL_MEDIUM)
	check(plan.action == "place", "medium finds a placement (action=%s)" % plan.action)
	check(plan.ops.size() > 0, "ops emitted: %d" % plan.ops.size())
	check(plan.tiles.size() > 0, "tiles list for hint highlighting")
	check(s.apply_ops(plan.ops), "apply_ops succeeds")
	check(s.table_status().ok, "table valid after apply_ops")
	check(s.hand_size(0) == 1, "one tile left (13)")
	res = s.end_turn()
	check(res.ok, "end_turn ok after planner turn (%s)" % res.get("reason", ""))

	print("== TurnPlanner: first-turn 30 rule -> draw ==")
	s = GameState.create(2, ["A", "B"], true)
	fresh(s, [t(1), t(1, T.BLUE), t(1, T.BLACK), t(2), t(2, T.BLUE)])
	plan = TurnPlanner.plan(s, TurnPlanner.LEVEL_MEDIUM)
	check(plan.action == "draw", "no >=30 combo on first turn -> draw (action=%s)" % plan.action)
	check(s.draw_from_deck().ok, "draw allowed at start")

	print("== TurnPlanner: empty deck, nothing to place -> skip ==")
	s = GameState.create(2, ["A", "B"], false)
	s.deck.tiles.clear()
	fresh(s, [t(1), t(2)])
	plan = TurnPlanner.plan(s, TurnPlanner.LEVEL_HARD)
	check(plan.action == "skip", "empty deck + no combo -> skip (action=%s)" % plan.action)
	check(s.skip_turn().ok, "skip accepted")

	print("== TurnPlanner: impossible bridge merge ==")
	s = GameState.create(2, ["A", "B"], false)
	var br1 := s.add_row()
	for v in range(1, 4):
		br1.tiles.append(t(v, T.RED))
	var br2 := s.add_row()
	for v in range(11, 14):
		br2.tiles.append(t(v, T.RED))
	fresh(s, [
		t(4, T.RED), t(5, T.RED), t(6, T.RED), t(7, T.RED),
		t(8, T.RED), t(9, T.RED), t(10, T.RED),
	])
	plan = TurnPlanner.plan(s, TurnPlanner.LEVEL_IMPOSSIBLE)
	check(plan.action == "place", "bridge plan is place (action=%s)" % plan.action)
	check(s.apply_ops(plan.ops), "bridge apply_ops ok")
	check(s.hand_size(0) == 0, "hand emptied by bridge, left %d" % s.hand_size(0))
	check(s.table.size() == 1, "one merged row remains, got %d" % s.table.size())
	check((s.table[0] as GameState.Row).tiles.size() == 13, "merged row has 13 tiles")
	res = s.end_turn()
	check(res.ok and res.get("win", false) == true, "win after bridge")

	print("== TurnPlanner: impossible steal -> win ==")
	s = GameState.create(2, ["A", "B"], false)
	var sr := s.add_row()
	for v in [5, 6, 7, 8]:
		sr.tiles.append(t(v, T.RED))
	fresh(s, [t(8, T.BLUE), t(8, T.BLACK)])
	plan = TurnPlanner.plan(s, TurnPlanner.LEVEL_IMPOSSIBLE)
	check(plan.action == "place", "steal plan is place (action=%s)" % plan.action)
	check(s.apply_ops(plan.ops), "steal apply_ops ok")
	check(s.hand_size(0) == 0, "hand emptied by steal, left %d" % s.hand_size(0))
	check(s.table.size() == 2, "two rows remain, got %d" % s.table.size())
	var rows_ok := true
	for rw in s.table:
		if not Rules.validate_row((rw as GameState.Row).tiles)["ok"]:
			rows_ok = false
	check(rows_ok, "all rows valid after steal")
	res = s.end_turn()
	check(res.ok and res.get("win", false) == true, "win after steal")

	print("== TurnPlanner: rebuild inserts both ends of a row ==")
	s = GameState.create(2, ["A", "B"], false)
	var rb_row := s.add_row()
	for v in [10, 11, 12]:
		rb_row.tiles.append(t(v, T.RED))
	fresh(s, [t(9, T.RED), t(13, T.RED)])
	var t0 := Time.get_ticks_msec()
	plan = TurnPlanner.plan(s, TurnPlanner.LEVEL_IMPOSSIBLE)
	var plan_ms := Time.get_ticks_msec() - t0
	check(plan.action == "place", "rebuild plan is place (action=%s)" % plan.action)
	check(plan.tiles.size() == 2, "both hand tiles used, got %d" % plan.tiles.size())
	check(s.apply_ops(plan.ops), "rebuild apply_ops ok")
	check(s.table.size() == 1 and (s.table[0] as GameState.Row).tiles.size() == 5,
		"row rebuilt to 5 tiles, rows=%d" % s.table.size())
	res = s.end_turn()
	check(res.ok and res.get("win", false) == true, "win after rebuild")
	print("  info  impossible plan took %d ms" % plan_ms)

	print("== TurnPlanner: rebuild of two rows -> set + two runs ==")
	s = GameState.create(2, ["A", "B"], false)
	var ra := s.add_row()
	for v in [3, 4, 5]:
		ra.tiles.append(t(v, T.RED))
	var rb := s.add_row()
	for v in [3, 4, 5]:
		rb.tiles.append(t(v, T.BLUE))
	fresh(s, [t(3, T.BLACK), t(6, T.RED), t(6, T.BLUE)])
	t0 = Time.get_ticks_msec()
	plan = TurnPlanner.plan(s, TurnPlanner.LEVEL_IMPOSSIBLE)
	plan_ms = Time.get_ticks_msec() - t0
	check(plan.action == "place", "pair rebuild plan is place (action=%s)" % plan.action)
	check(s.apply_ops(plan.ops), "pair rebuild apply_ops ok")
	check(s.hand_size(0) == 0, "hand emptied by pair rebuild, left %d" % s.hand_size(0))
	check(s.table.size() == 3, "set + two runs = 3 rows, got %d" % s.table.size())
	var pr_ok := true
	for rw in s.table:
		if not Rules.validate_row((rw as GameState.Row).tiles)["ok"]:
			pr_ok = false
	check(pr_ok, "all rows valid after pair rebuild")
	res = s.end_turn()
	check(res.ok and res.get("win", false) == true, "win after pair rebuild")
	print("  info  impossible plan took %d ms" % plan_ms)

	print("== TurnPlanner: rebuild on hard (single row, simpler) ==")
	s = GameState.create(2, ["A", "B"], false)
	var hr := s.add_row()
	for v in [10, 11, 12]:
		hr.tiles.append(t(v, T.RED))
	fresh(s, [t(9, T.RED), t(13, T.RED)])
	t0 = Time.get_ticks_msec()
	plan = TurnPlanner.plan(s, TurnPlanner.LEVEL_HARD)
	plan_ms = Time.get_ticks_msec() - t0
	check(plan.action == "place", "hard rebuild plan is place (action=%s)" % plan.action)
	check(plan.tiles.size() == 2, "hard rebuild uses both hand tiles, got %d" % plan.tiles.size())
	check(s.apply_ops(plan.ops), "hard rebuild apply_ops ok")
	res = s.end_turn()
	check(res.ok and res.get("win", false) == true, "win after hard rebuild")
	print("  info  hard plan took %d ms" % plan_ms)

	print("== TurnPlanner: rebuild on medium (basic single row) ==")
	s = GameState.create(2, ["A", "B"], false)
	var mr := s.add_row()
	for v in [10, 11, 12]:
		mr.tiles.append(t(v, T.RED))
	fresh(s, [t(9, T.RED), t(13, T.RED)])
	t0 = Time.get_ticks_msec()
	plan = TurnPlanner.plan(s, TurnPlanner.LEVEL_MEDIUM)
	plan_ms = Time.get_ticks_msec() - t0
	check(plan.action == "place", "medium rebuild plan is place (action=%s)" % plan.action)
	check(plan.tiles.size() == 2, "medium rebuild uses both hand tiles, got %d" % plan.tiles.size())
	check(s.apply_ops(plan.ops), "medium rebuild apply_ops ok")
	res = s.end_turn()
	check(res.ok and res.get("win", false) == true, "win after medium rebuild")
	print("  info  medium plan took %d ms" % plan_ms)

	print("== TurnPlanner: rebuild of two rows on hard ==")
	s = GameState.create(2, ["A", "B"], false)
	var hra := s.add_row()
	for v in [3, 4, 5]:
		hra.tiles.append(t(v, T.RED))
	var hrb := s.add_row()
	for v in [3, 4, 5]:
		hrb.tiles.append(t(v, T.BLUE))
	fresh(s, [t(3, T.BLACK), t(6, T.RED), t(6, T.BLUE)])
	t0 = Time.get_ticks_msec()
	plan = TurnPlanner.plan(s, TurnPlanner.LEVEL_HARD)
	plan_ms = Time.get_ticks_msec() - t0
	check(plan.action == "place", "hard pair rebuild is place (action=%s)" % plan.action)
	check(s.apply_ops(plan.ops), "hard pair rebuild apply_ops ok")
	check(s.hand_size(0) == 0, "hard pair rebuild empties hand, left %d" % s.hand_size(0))
	res = s.end_turn()
	check(res.ok and res.get("win", false) == true, "win after hard pair rebuild")
	print("  info  hard pair plan took %d ms" % plan_ms)

	print("== GameState: apply_ops rejects bad input ==")
	s = GameState.create(2, ["A", "B"], false)
	fresh(s, [t(5)])
	var bad_id: int = (s.hand()[0] as Tile).id
	check(not s.apply_ops([{op="place", tile=bad_id, to="r77", index=0}]), "unknown row ref rejected")
	check(not s.apply_ops([{op="hack"}]), "unknown op rejected")
	check(not s.apply_ops([{op="place", tile=999999, to="n0", index=0}]), "missing tile rejected")

	print("")
	if fails == 0:
		print("ALL %d CHECKS PASSED" % total)
		quit(0)
	else:
		printerr("%d/%d CHECKS FAILED" % [fails, total])
		quit(1)
