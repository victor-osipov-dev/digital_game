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
		check(settings.fs(100) == 100, "fs: small scale = 100, got %d" % settings.fs(100))
		settings.text_scale = 1
		check(settings.fs(100) == 130, "fs: default scale = 130, got %d" % settings.fs(100))
		settings.text_scale = 2
		check(settings.fs(100) == 200, "fs: big scale = 200, got %d" % settings.fs(100))
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
	_hint_icon_checks()
	await _deck_cap_checks()
	await _topbar_width_checks()
	await _topbar_capped_checks()
	_button_radius_audit(inst)
	_confirm_checks()
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
	settings.text_scale = 0
	inst.call("_rebuild_ui")
	for i in range(4):
		await process_frame
	check(not bool(inst.get("_top_collapsed")), "normal text keeps buttons inline")
	settings.text_scale = 2
	inst.call("_rebuild_ui")
	for i in range(4):
		await process_frame
	check(bool(inst.get("_top_collapsed")), "big text collapses top buttons into burger")
	var burger = inst.get("_burger_btn")
	check(burger != null and (burger as Control).visible, "burger button visible when collapsed")
	# Значок рисуется кодом (три полосы), а не глифом: триграммы нет во
	# встроенном шрифте Web-сборки. Текста у кнопки нет вообще.
	check(String((burger as Button).text).is_empty(), "burger has no glyph text")
	var bicon := (burger as Button).icon as ImageTexture
	check(bicon != null and bicon.get_width() == bicon.get_height()
		and bicon.get_width() >= 24, "burger icon is a square texture")
	if bicon != null:
		var bimg := bicon.get_image()
		var mid := bimg.get_pixel(bimg.get_width() / 2, bimg.get_height() / 2)
		check(mid.a > 0.5, "burger middle bar is painted")
		check(bimg.get_pixel(0, 0).a < 0.1, "burger corners stay transparent")
	# Значок + поля обязаны влезать в высоту кнопки: иначе бургер выше
	# соседей (ловили вживую). Сверяем с подсказкой из того же ряда.
	var hint2 := inst.get("hint_btn") as Button
	if hint2 != null:
		var bh := (burger as Button).get_combined_minimum_size().y
		var hh := hint2.get_combined_minimum_size().y
		check(absf(bh - hh) <= 1.0,
			"burger same height as hint (%.0f vs %.0f)" % [bh, hh])
	var box = inst.get("_burger_box")
	var bar = inst.get("_top_actions")
	var overflowed := true
	for b in (inst.get("_top_overflow") as Array):
		if (b as Control).get_parent() != box:
			overflowed = false
	check(overflowed, "rare actions moved into burger box")
	var pinned := true
	for b in (inst.get("_top_action_buttons") as Array):
		if not (inst.get("_top_overflow") as Array).has(b) \
				and (b as Control).get_parent() != bar:
			pinned = false
	check(pinned, "frequent actions stay in the bar (save/restore/hint)")
	# Панель поверх раскладки: открытый бургер не раздвигает соседей.
	var bar_kids := (bar as Control).get_child_count()
	var scroll := inst.get("table_scroll") as Control
	var scroll_y: float = (scroll as Control).get_global_rect().position.y
	(burger as Button).pressed.emit()
	await create_timer(0.5).timeout
	var panel = inst.get("_burger_panel")
	check(bool(inst.get("_burger_open")), "burger opens on press")
	check((panel as Control).visible and (panel as Control).modulate.a > 0.9,
		"burger panel faded in, alpha=%.2f" % (panel as Control).modulate.a)
	check((panel as Control).top_level, "burger panel floats above layout")
	check(is_equal_approx((scroll as Control).get_global_rect().position.y, scroll_y),
		"open burger doesn't shift table down")
	(burger as Button).pressed.emit()
	await create_timer(0.5).timeout
	check(not bool(inst.get("_burger_open")), "burger closes on second press")
	check(not (panel as Control).visible, "burger panel hidden after close")
	check((bar as Control).get_child_count() == bar_kids, "bar children unchanged by burger")
	# Гонка повторного тапа: press гасит меню через ловец, а долетевший
	# следом release в кнопку не должен открывать его обратно.
	(burger as Button).pressed.emit()
	await create_timer(0.5).timeout
	check(bool(inst.get("_burger_open")), "burger reopens for race test")
	var press := InputEventMouseButton.new()
	press.button_index = MOUSE_BUTTON_LEFT
	press.pressed = true
	inst.call("_on_burger_catcher", press)
	check(not bool(inst.get("_burger_open")), "catcher tap closes menu")
	(burger as Button).pressed.emit()
	check(not bool(inst.get("_burger_open")), "stale release doesn't reopen")
	await create_timer(0.45).timeout
	(burger as Button).pressed.emit()
	check(bool(inst.get("_burger_open")), "tap after pause opens again")
	(burger as Button).pressed.emit()
	await create_timer(0.5).timeout
	settings.text_scale = saved_scale
	inst.call("_rebuild_ui")
	for i in range(4):
		await process_frame
	root.size = saved_size


func _hint_icon_checks() -> void:
	# Вне Web иконки подсказки нет (ветка под OS.has_feature), поэтому
	# проверяем сам ресайз и учёт иконки в ширине кнопки, а не живую кнопку.
	var game_script := load("res://scripts/ui/game.gd")
	var src := Image.create(64, 32, false, Image.FORMAT_RGBA8)
	var small = game_script.call("_fit_icon",
		ImageTexture.create_from_image(src), 22)
	check(small != null and (small as ImageTexture).get_height() == 22
		and (small as ImageTexture).get_width() == 44,
		"badge 64x32 shrinks to 44x22 keeping aspect")
	var hint := inst.get("hint_btn") as Button
	check(hint != null and not String(hint.text).is_empty(),
		"hint keeps its text next to the icon")
	if hint != null:
		var need0: float = inst.call("_top_button_need", hint)
		hint.icon = small
		var need1: float = inst.call("_top_button_need", hint)
		check(need1 > need0, "need() counts icon width (%.0f -> %.0f)"
			% [need0, need1])
		hint.icon = null


func _deck_cap_checks() -> void:
	# Колода на «Большом» остаётся как на «Среднем»: размер и текст.
	var saved_scale: int = settings.text_scale
	settings.text_scale = 2
	inst.call("_rebuild_ui")
	for i in range(3):
		await process_frame
	var deck := inst.get("deck_button") as Button
	check(deck != null, "deck button exists after rebuild")
	if deck == null:
		return
	check(deck.get_theme_font_size("font_size") == settings.fs_capped(16, 1),
		"deck text capped at Medium on Big (got %d)"
			% deck.get_theme_font_size("font_size"))
	var big_min := deck.get_combined_minimum_size()
	settings.text_scale = 1
	inst.call("_rebuild_ui")
	for i in range(3):
		await process_frame
	var deckm := inst.get("deck_button") as Button
	check(big_min.is_equal_approx(deckm.get_combined_minimum_size()),
		"deck size same on Big as Medium (%.0f vs %.0f)"
			% [big_min.x, deckm.get_combined_minimum_size().x])
	settings.text_scale = saved_scale
	inst.call("_rebuild_ui")
	for i in range(3):
		await process_frame


func _topbar_width_checks() -> void:
	# Широкий экран + большой текст: ряд НЕ схлопывается, и каждая
	# кнопка влезает целиком. Ловили вживую: «Сохр./Вернуть/Подск.»
	# показывали по две буквы — минимум кнопок с clip_text не считал
	# текст, и ряд думал, что все кнопки по 60 px.
	var saved_scale: int = settings.text_scale
	settings.text_scale = 2
	root.size = Vector2i(1152, 1024)
	for i in range(3):
		await process_frame
	inst.call("_sync_top_bar")
	for i in range(2):
		await process_frame
	check(not bool(inst.get("_top_collapsed")), "big text on wide screen keeps buttons inline")
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


func _topbar_capped_checks() -> void:
	# Узкий экран + большой текст: частые кнопки остаются в строке
	# в одну линию, редкие — в бургере. Шрифт частых capped на «Большом»:
	# на большом они такие же, как на среднем, а не мельче.
	var saved_base := root.content_scale_size
	var saved_size := root.size
	var saved_scale: int = settings.text_scale
	settings.text_scale = 1
	var mid_font: int = settings.fs(15)
	settings.text_scale = 2
	root.content_scale_size = Vector2i(320, 640)
	root.size = Vector2i(360, 800)
	for i in range(3):
		await process_frame
	inst.call("_sync_top_bar")
	for i in range(2):
		await process_frame
	var bar = inst.get("_top_actions")
	var box = inst.get("_burger_box")
	check(bool(inst.get("_top_collapsed")), "narrow big screen uses burger for rare actions")
	var ys := []
	for b in (inst.get("_top_action_buttons") as Array):
		var btn := b as Button
		if (inst.get("_top_overflow") as Array).has(btn):
			check(btn.get_parent() == box, "rare action in burger on narrow")
		else:
			check(btn.get_parent() == bar, "frequent action stays in bar on narrow")
			ys.append(btn.get_global_rect().position.y)
			check(btn.get_theme_font_size("font_size") == mid_font,
				"frequent button «%s» capped at Средний size (%d)" % [btn.text, mid_font])
			var font: Font = btn.get_theme_font("font")
			var want := 0.0
			if font != null:
				want = font.get_string_size(btn.text, HORIZONTAL_ALIGNMENT_LEFT, -1,
					btn.get_theme_font_size("font_size")).x
			check(btn.size.x + 1.0 >= want,
				"capped button «%s» fits text (%.0f vs %.0f)" % [btn.text, btn.size.x, want])
	var flat := true
	for y in ys:
		if absf(float(y) - float(ys[0])) > 2.0:
			flat = false
	check(flat, "frequent actions share one line, ys=%s" % [ys])
	root.content_scale_size = saved_base
	root.size = saved_size
	settings.text_scale = saved_scale
	inst.call("_sync_top_bar")
	for i in range(2):
		await process_frame


## Все кнопки — с одним скруглением: эффективный стильбокс normal
## обязан иметь радиус UiTheme.CORNER. Чекбоксы не кнопки вида ради —
## пропускаем, у них своя иконка.
func _button_radius_audit(node: Node) -> void:
	if node is Button and not (node is CheckBox):
		var b := node as Button
		var sb := b.get_theme_stylebox("normal")
		if sb is StyleBoxFlat:
			var r: int = (sb as StyleBoxFlat).corner_radius_top_left
			check(r == 10, "button «%s» corner radius 10, got %d" % [b.text.left(20), r])
		else:
			check(false, "button «%s» normal stylebox is flat" % b.text.left(20))
	for child in node.get_children():
		_button_radius_audit(child)


func _confirm_checks() -> void:
	# Свой диалог вместо системного: тексты подменяются, действие одно,
	# отмена и тап мимо ничего не запускают.
	var fired := [0]
	inst.call("_ask_confirm", "Вопрос", "Текст вопроса", "Да",
		func(): fired[0] += 1)
	var ov = inst.get("_confirm_overlay")
	check(ov != null and (ov as Control).visible, "confirm overlay shown")
	check(String((inst.get("_confirm_title") as Label).text) == "Вопрос", "confirm title set")
	check(String((inst.get("_confirm_ok") as Button).text) == "Да", "confirm ok set")
	(inst.get("_confirm_ok") as Button).pressed.emit()
	check(not (ov as Control).visible, "confirm hides on ok")
	check(fired[0] == 1, "confirm action ran once")
	inst.call("_ask_confirm", "Вопрос", "Текст вопроса", "Да",
		func(): fired[0] += 1)
	check((ov as Control).visible, "confirm shown again")
	(inst.get("_confirm_cancel") as Button).pressed.emit()
	check(not (ov as Control).visible, "confirm hides on cancel")
	check(fired[0] == 1, "cancel doesn't run action")
	inst.call("_ask_confirm", "Вопрос", "Текст вопроса", "Да",
		func(): fired[0] += 1)
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = true
	inst.call("_on_confirm_backdrop", ev)
	check(not (ov as Control).visible, "confirm hides on outside tap")
	check(fired[0] == 1, "outside tap doesn't run action")
