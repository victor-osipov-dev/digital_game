extends SceneTree

var fails := 0
var inst: Node = null
var phase := 0
var ready_time := 0
var settings: Node = null

func check(cond: bool, msg: String) -> void:
	if cond:
		print("  ok  " + msg)
	else:
		fails += 1
		printerr("FAIL  " + msg)

func _initialize() -> void:
	process_frame.connect(_on_frame)

func _on_frame() -> void:
	match phase:
		0:
			phase = 1
			_setup()
			_initial_checks()
		1:
			# ждём завершения титра «Ход» (~1.75с) после нажатия «Готов(-а)»
			if Time.get_ticks_msec() - ready_time > 1900:
				phase = 2
				_after_title_checks()

func _setup() -> void:
	settings = root.get_node_or_null("Settings")
	check(settings != null, "autoload Settings exists")
	if settings != null:
		settings.load_settings()
		settings.set_bot(0, false)
		var saved_scale: int = settings.text_scale
		settings.text_scale = 0
		check(settings.fs(100) == 85, "fs: small scale = 85, got %d" % settings.fs(100))
		settings.text_scale = 1
		check(settings.fs(100) == 100, "fs: default scale = 100, got %d" % settings.fs(100))
		settings.text_scale = 2
		check(settings.fs(100) == 120, "fs: large scale = 120, got %d" % settings.fs(100))
		settings.text_scale = saved_scale
		var saved_step: int = settings.tile_step
		settings.tile_step = 0
		check(settings.tile_size() == Vector2(32, 32), "tile_step 0 -> 32x32, got %s" % settings.tile_size())
		settings.tile_step = 3
		check(settings.tile_size() == Vector2(60, 84), "tile_step 3 -> 60x84, got %s" % settings.tile_size())
		settings.tile_step = saved_step

	var packed := load("res://scenes/game.tscn") as PackedScene
	check(packed != null, "game.tscn loads as PackedScene")
	if packed == null:
		quit(1)
		return
	inst = packed.instantiate()
	check(inst != null, "scene instantiates")
	check(inst is Control, "root is Control")
	check(inst.get_script() != null, "script attached to root")
	root.add_child(inst)

func _initial_checks() -> void:
	check(inst.get("deck_button") != null, "_ready built deck button")
	check(inst.get("hand_flow") != null, "_ready built hand (hand_flow)")
	check(inst.get("table_box") != null, "_ready built table (table_box)")
	check(inst.get("main_button") == null, "no main_button property (button kept as end_button)")
	check(inst.get("hint_label") == null, "hint_label removed from UI")
	check(inst.get("turn_label") == null, "turn_label removed from UI")
	var state = inst.get("state")
	check(state != null, "_new_match created GameState")
	var pass_overlay = inst.get("pass_overlay")
	check(pass_overlay != null and pass_overlay.visible, "pass-device overlay is showing")

	var deck_btn = inst.get("deck_button")
	if deck_btn != null:
		check(String(deck_btn.text).begins_with("Колода"), "deck button labeled: %s" % deck_btn.text)
	var end_btn = inst.get("end_button")
	if end_btn != null:
		check(end_btn.text == "Взять", "bottom button = Взять (deck non-empty), got: %s" % end_btn.text)
		check(end_btn.get_parent() != null and end_btn.get_parent().get_child_count() == 2,
			"bottom row has exactly 2 buttons, got %d" % end_btn.get_parent().get_child_count())
	var undo_btn = inst.get("undo_button")
	if undo_btn != null:
		check(undo_btn.disabled, "undo disabled at turn start")
	var ready_btn = inst.get("pass_ready_button")
	check(ready_btn != null, "pass overlay has Готов(-а) button")
	if ready_btn != null:
		check(ready_btn.text == "Готов(-а)", "ready button label: %s" % ready_btn.text)
	var title_ov = inst.get("turn_title_overlay")
	check(title_ov != null, "turn title overlay exists")
	if title_ov != null:
		check(not title_ov.visible, "turn title hidden initially")
	check(inst.get("cp_save_btn") != null and inst.get("cp_restore_btn") != null, "checkpoint buttons exist")
	check(inst.get("hint_btn") != null, "hint button exists")
	if state != null:
		var st = state as GameState
		check(st.hand_size(st.current) == 14, "current player has 14 tiles")

	if ready_btn != null:
		ready_btn.pressed.emit()
		if title_ov != null:
			check(not title_ov.visible, "turn title not shown for human after Готов(-а)")
		ready_time = Time.get_ticks_msec()

func _after_title_checks() -> void:
	var title_ov = inst.get("turn_title_overlay")
	if title_ov != null:
		check(not title_ov.visible, "turn title auto-hidden after ~1.4s")
	var pass_overlay = inst.get("pass_overlay")
	if pass_overlay != null:
		check(not pass_overlay.visible, "pass overlay hidden after ready")
	inst.free()
	inst = null
	if fails == 0:
		print("SCENE CHECK PASSED")
		quit(0)
	else:
		printerr("SCENE CHECK: %d FAILED" % fails)
		quit(1)
