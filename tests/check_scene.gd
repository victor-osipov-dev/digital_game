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
		check(settings.fs(100) == 130, "fs: large scale = 130, got %d" % settings.fs(100))
		settings.text_scale = 3
		check(settings.fs(100) == 200, "fs: giant scale = 200, got %d" % settings.fs(100))
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
	_hand_panel_checks()
	_flow_center_checks()
	await _burger_checks()
	await _topbar_width_checks()
	inst.free()
	inst = null
	if fails == 0:
		print("SCENE CHECK PASSED")
		quit(0)
	else:
		printerr("SCENE CHECK: %d FAILED" % fails)
		quit(1)


func _hand_panel_checks() -> void:
	var hf = inst.get("hand_flow")
	check(hf != null, "hand_flow exists for panel check")
	if hf == null:
		return
	var panel := (hf as Control).get_parent()
	check(panel != null, "hand tiles live in their own panel")
	if panel == null:
		return
	var sb := (panel as PanelContainer).get_theme_stylebox("panel")
	check(sb is StyleBoxFlat, "hand panel has flat fill")
	if sb is StyleBoxFlat:
		var want := Color(0.10, 0.34, 0.22, 0.72)
		var got_color: Color = (sb as StyleBoxFlat).bg_color
		check(got_color == want, "hand panel is filled green, got %s" % str(got_color))


func _flow_center_checks() -> void:
	# Через load(), а не FlowTiles.new(): прямая ссылка на класс тянет
	# цепочку компиляции до автозагрузки Settings, которой ещё нет на
	# момент компиляции главного скрипта теста.
	var flow = load("res://scripts/ui/flow_tiles.gd").new()
	root.add_child(flow)
	flow.size = Vector2(600, 60)
	var tiles: Array = []
	for i in range(3):
		tiles.append(Tile.new(900 + i, Tile.TColor.RED, 1 + i, false))
	flow.set_tiles(tiles, "test", 0, false)
	flow.force_relayout()
	var views: Array = flow.get("tile_views")
	check(views.size() == 3, "centering probe has 3 tiles, got %d" % views.size())
	if views.size() == 3:
		var first = views[0] as Control
		var last = views[views.size() - 1] as Control
		var left: float = first.position.x
		var right: float = flow.size.x - (last.position.x + last.size.x)
		check(absf(left - right) < 2.0, "row is centered: left=%.1f right=%.1f" % [left, right])
	flow.queue_free()


func _burger_checks() -> void:
	if settings == null:
		check(false, "Settings missing for burger check")
		return
	# Фиксируем окно под проектную базу 576x1024: иначе headless-viewport
	# шире, и бургер нечем спровоцировать.
	var saved_size := root.size
	root.size = Vector2i(576, 1024)
	for i in range(3):
		await process_frame
	var saved_scale: int = settings.text_scale
	settings.text_scale = 1
	inst.call("_rebuild_ui")
	for i in range(4):
		await process_frame
	check(not bool(inst.get("_top_collapsed")), "normal text keeps buttons inline")
	settings.text_scale = 3
	inst.call("_rebuild_ui")
	for i in range(4):
		await process_frame
	check(bool(inst.get("_top_collapsed")), "giant text collapses top buttons into burger")
	var burger = inst.get("_burger_btn")
	check(burger != null and (burger as Control).visible, "burger button visible when collapsed")
	var box = inst.get("_burger_box")
	var moved := true
	for b in (inst.get("_top_action_buttons") as Array):
		if (b as Control).get_parent() != box:
			moved = false
	check(moved, "all six actions moved into burger box")
	(burger as Button).pressed.emit()
	await create_timer(0.5).timeout
	var panel = inst.get("_burger_panel")
	check(bool(inst.get("_burger_open")), "burger opens on press")
	check((panel as Control).visible and (panel as Control).modulate.a > 0.9,
		"burger panel faded in, alpha=%.2f" % (panel as Control).modulate.a)
	(burger as Button).pressed.emit()
	await create_timer(0.5).timeout
	check(not bool(inst.get("_burger_open")), "burger closes on second press")
	check(not (panel as Control).visible, "burger panel hidden after close")
	settings.text_scale = saved_scale
	inst.call("_rebuild_ui")
	for i in range(4):
		await process_frame
	root.size = saved_size


func _topbar_width_checks() -> void:
	# Широкий экран + гигантский текст: ряд НЕ схлопывается, и каждая
	# кнопка влезает целиком. Ловили вживую: «Сохр./Вернуть/Подск.»
	# показывали по две буквы — минимум кнопок с clip_text не считал
	# текст, и ряд думал, что все кнопки по 60 px.
	var saved_scale: int = settings.text_scale
	settings.text_scale = 3
	root.size = Vector2i(1152, 1024)
	for i in range(3):
		await process_frame
	inst.call("_sync_top_bar")
	for i in range(2):
		await process_frame
	check(not bool(inst.get("_top_collapsed")), "giant text on wide screen keeps buttons inline")
	for b in (inst.get("_top_action_buttons") as Array):
		var btn := b as Button
		var font: Font = btn.get_theme_font("font")
		var want := 0.0
		if font != null:
			want = font.get_string_size(btn.text, HORIZONTAL_ALIGNMENT_LEFT, -1,
				btn.get_theme_font_size("font_size")).x
		check(btn.get_combined_minimum_size().x + 1.0 >= want,
			"button «%s» minimum fits text (min %.0f, need %.0f)"
				% [btn.text, btn.get_combined_minimum_size().x, want])
		check(btn.size.x + 1.0 >= want,
			"button «%s» laid out wide enough (%.0f vs %.0f)"
				% [btn.text, btn.size.x, want])
	settings.text_scale = saved_scale
	root.size = Vector2i(576, 1024)
	inst.call("_sync_top_bar")
	for i in range(2):
		await process_frame
