extends SceneTree

var fails := 0
var inst: Node = null
var t0 := 0
var started := false
var checked := false

func check(cond: bool, msg: String) -> void:
	if cond:
		print("  ok  " + msg)
	else:
		fails += 1
		printerr("FAIL  " + msg)

func _initialize() -> void:
	process_frame.connect(_on_frame)

func _on_frame() -> void:
	if not started:
		started = true
		var settings = root.get_node_or_null("Settings")
		check(settings != null, "autoload Settings exists")
		if settings == null:
			quit(1)
			return
		settings.load_settings()
		settings.set_player_count(2)
		settings.set_bot(0, true)
		settings.set_bot(1, true)
		var packed := load("res://scenes/game.tscn") as PackedScene
		check(packed != null, "game.tscn loads")
		if packed == null:
			quit(1)
			return
		inst = packed.instantiate()
		root.add_child(inst)
		t0 = Time.get_ticks_msec()
		return
	if checked:
		return
	if Time.get_ticks_msec() - t0 < 9000:
		return
	checked = true
	var state = inst.get("state")
	check(state != null, "state exists")
	if state != null:
		var st = state as GameState
		print("  current=%d first_turn=%s deck=%d finished=%s table_rows=%d" % [
			st.current, str(st.first_turn), st.tiles_left_in_deck(),
			str(st.finished), st.table.size(),
		])
		check(st.first_turn == false, "bots made at least one completed turn")
		var total_hand := 0
		for i in st.player_count():
			total_hand += st.hand_size(i)
		check(total_hand != 28 or st.table.size() > 0,
			"board state changed (total hand %d, rows %d)" % [total_hand, st.table.size()])
	inst.free()
	inst = null
	if fails == 0:
		print("BOT SMOKE PASSED")
		quit(0)
	else:
		printerr("BOT SMOKE: %d FAILED" % fails)
		quit(1)
