extends SceneTree

var fails := 0
var inst: Node = null
var phase := 0

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
			var settings := root.get_node_or_null("Settings")
			if settings != null:
				settings.call("load_settings")
				settings.call("set_bot", 0, false)
			var packed := load("res://scenes/game.tscn") as PackedScene
			if packed == null:
				printerr("FAIL  cannot load game.tscn")
				quit(1)
				return
			inst = packed.instantiate()
			root.add_child(inst)
		1:
			phase = 2
			_empty_checks()
			var state = inst.get("state")
			var row = state.add_row()
			row.tiles.append(state.hand()[0])
			inst.call("refresh")
		2:
			phase = 3
		3:
			phase = 4
			_row_checks()
			quit(0 if fails == 0 else 1)

func _empty_checks() -> void:
	var tb = inst.get("table_box")
	check(tb != null, "table_box exists")
	if tb == null:
		return
	var box: Rect2 = tb.get_global_rect()
	check(box.size.x > 0.0 and box.size.y > 0.0, "table_box laid out, size=%s" % box.size)
	var hover := inst as Control
	check(hover.call("_hover_slot_pos", box.get_center()) == 0, "empty table: center -> slot 0")
	check(hover.call("_hover_slot_pos", Vector2(-500, -500)) == -1, "outside table -> -1")

func _row_checks() -> void:
	var tb = inst.get("table_box")
	var hover := inst as Control
	var box: Rect2 = tb.get_global_rect()
	var rbs: Array = inst.get("row_blocks")
	check(rbs.size() == 1, "one row block, got %d" % rbs.size())
	if rbs.is_empty():
		return
	var r: Rect2 = rbs[0].get_global_rect()
	check(r.size.y > 40.0, "row block has real height, h=%s" % r.size.y)
	check(hover.call("_hover_slot_pos", r.get_center()) == -1, "row center -> -1")
	check(hover.call("_hover_slot_pos", Vector2(r.get_center().x, r.end.y + 3.0)) == 1, "gap below row -> 1")
	if r.position.y > box.position.y + 4.0:
		check(hover.call("_hover_slot_pos", Vector2(r.get_center().x, r.position.y - 3.0)) == 0, "gap above row -> 0")
	check(not hover.has_method("_show_row_slot"), "no visual hover slot while dragging")
	check(not hover.has_method("_slot_position"), "no slot lookup while dragging")

	var state = inst.get("state")
	var tile_id: int = state.hand()[0].id
	var data := {kind="tile", tile_id=tile_id, from="hand"}
	var hz = inst.get("hint_zone")
	check(hz != null, "hint_zone exists")
	if hz != null:
		var hzr: Rect2 = hz.get_global_rect()
		check(hzr.size.y > 0.0, "hint_zone has height, h=%s" % hzr.size.y)
		check(hover.call("gui_can_drop", data, hzr.get_center()) == true,
			"drop allowed on hint zone")
		check(hover.call("gui_can_drop", data, Vector2(r.get_center().x, r.end.y + 5.0)) == true,
			"drop in bare gap targets nearest slot without visual placeholder")

	var state_ref = inst.get("state")
	hover.call("_rebuild_ui")
	check(inst.get("state") == state_ref, "rebuild keeps the same state")
	var rbs2: Array = inst.get("row_blocks")
	check(rbs2.size() == 1, "table rebuilt with same rows, got %d" % rbs2.size())
	check(inst.get("table_box").get_child_count() == rbs2.size() + 1,
		"table has only rows and hint after rebuild")

	# Свой диалог вместо системного: тексты задаются при показе.
	hover.call("_ask_confirm", "Взять карту", "Взять число?", "Взять", Callable())
	var ov = inst.get("_confirm_overlay")
	check(ov != null and (ov as Control).visible, "custom confirm shown")
	if ov != null:
		check(String((inst.get("_confirm_title") as Label).text) == "Взять карту",
			"confirm title in Russian")
		check((inst.get("_confirm_text") as Label).has_theme_font_size_override("font_size"),
			"confirm text font scaled")
		check(not (inst.get("_confirm_overlay") as Control).is_queued_for_deletion(),
			"confirm is custom overlay, not a popup window")
		(inst.get("_confirm_cancel") as Button).pressed.emit()
		check(not (ov as Control).visible, "confirm hides on cancel")

	var settings := root.get_node_or_null("Settings")
	var hf = inst.get("hand_flow")
	var views: Array = hf.get("tile_views")
	check(not views.is_empty(), "human turn: hand shows tiles")
	if not views.is_empty():
		check(bool(views[0].get("face_down")) == false, "human hand face up")
		var has_label := false
		for c in (views[0] as Control).get_children():
			if c is Label:
				has_label = true
		check(has_label, "human hand tile has value label")
	settings.call("set_bot", 0, true)
	inst.call("refresh")
	views = hf.get("tile_views")
	check(not views.is_empty(), "bot turn: hand still shows tiles")
	if not views.is_empty():
		check(bool(views[0].get("face_down")) == true, "bot hand face down")
		var has_label2 := false
		for c in (views[0] as Control).get_children():
			if c is Label:
				has_label2 = true
		check(not has_label2, "bot hand tile has no value label")
		check(String(views[0].tooltip_text).is_empty(), "bot hand tile tooltip hidden")
	settings.call("set_bot", 0, false)
	inst.call("refresh")
	views = hf.get("tile_views")
	check(not views.is_empty() and bool(views[0].get("face_down")) == false,
		"hand face up again after bot turn")
