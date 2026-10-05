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
			inst.call("refresh")
		4:
			phase = 5
		5:
			phase = 6
			await _drop_checks()
			await _pan_checks()
			await _bar_checks()
			await _badge_popup_checks()
			await _win_checks()
			await _slide_checks()
			_split_own_checks()
			_drop_origin_checks()
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


## Перестановка каскадом: слайды стартуют лесенкой, а не разом.
## Свои вьюхи (не игровые), чтобы чужой полёт не сбивал замеры.
func _slide_checks() -> void:
	var tv_script := load("res://scripts/ui/tile_view.gd") as GDScript
	var holder := Control.new()
	holder.position = Vector2.ZERO
	root.add_child(holder)
	var made := []
	for i in range(2):
		var t := Tile.new(910 + i, Tile.TColor.RED, 1 + i, false)
		var v: Control = tv_script.make(t, false, null)
		v.position = Vector2(100 + i * 90, 400)
		holder.add_child(v)
		made.append(v)
	await process_frame
	await process_frame
	var a := made[0] as Control
	var b := made[1] as Control
	var pa: Vector2 = a.position
	var pb: Vector2 = b.position
	inst.call("_slide_tile", a, a.get_global_rect().position + Vector2(60, 0), 0.0)
	inst.call("_slide_tile", b, b.get_global_rect().position + Vector2(60, 0), 0.6)
	# Слайд сначала прыгает в точку старта и едет назад: ждём движения
	# от неё, а не от исходной позиции.
	var fa: Vector2 = a.position
	var fb: Vector2 = b.position
	await create_timer(0.15).timeout
	check(((a.position - fa).length()) > 2.0,
		"первая фишка уже едет, got %.0f" % (a.position - fa).length())
	check(((b.position - fb).length()) < 5.0,
		"вторая ждёт своей очереди, got %.0f" % (b.position - fb).length())
	await create_timer(0.95).timeout
	check(((a.position - pa).length()) < 5.0,
		"первая доехала, got %.0f" % (a.position - pa).length())
	check(((b.position - pb).length()) < 5.0,
		"вторая доехала следом, got %.0f" % (b.position - pb).length())
	for v in made:
		(v as Control).queue_free()
	holder.queue_free()


## Свои выкладки — мимо очереди презентаций (тест split).
func _split_own_checks() -> void:
	inst.set("_anim_force", {11: 0, 22: 1, 33: 0})
	var own = inst.call("_split_own_force")
	check((own as Array).is_empty(), "офлайн: свои не выделяем")
	check((inst.get("_anim_force") as Dictionary).size() == 3,
		"офлайн: очередь цела")
	inst.set("_online", true)
	var st = inst.get("state")
	var saved_ls := -1
	var ls := -1
	if st != null and st.get("local_seat") != null:
		ls = int(st.get("local_seat"))
		saved_ls = ls
	if ls < 0:
		ls = 0
		if st != null:
			st.set("local_seat", 0)
	var other := (ls + 1) % 2
	inst.set("_anim_force", {11: ls, 22: other, 33: ls})
	var own2 := inst.call("_split_own_force") as Array
	check(own2.size() == 2 and own2.has(11) and own2.has(33),
		"свои id изъяты из очереди")
	var rest := inst.get("_anim_force") as Dictionary
	check(rest.size() == 1 and int(rest.get(22, -1)) == other,
		"чужие остались в очереди")
	inst.set("_anim_force", {})
	inst.set("_online", false)
	if st != null:
		st.set("local_seat", saved_ls)


## Своя отпущенная летит от пальца, без кадра «уже стоит»: свежая точка —
## вид прячется до слайда; протухшая (drop во время чужого показа,
## пересборка пришла секундами позже) — фишка просто стоит, вдогонку
## не летит. Иначе «то быстро, то долго» в зависимости от того, летел
## ли в момент дропа чужой показ.
func _drop_origin_checks() -> void:
	var st = inst.get("state")
	if st == null or (st.get("table") as Array).is_empty():
		check(false, "есть стол для проверки точек отпускания")
		return
	var tiles = ((st.get("table") as Array)[0] as Object).get("tiles")
	if not (tiles is Array) or (tiles as Array).is_empty():
		check(false, "в ряду есть фишка")
		return
	var tid := int(((tiles as Array)[0] as Object).get("id"))
	inst.set("_drop_origins", {tid: {"pos": Vector2(100, 500),
		"ms": Time.get_ticks_msec()}})
	inst.set("_anim_pending", true)
	inst.call("refresh")
	check((inst.get("_drop_origins") as Dictionary).is_empty(),
		"точки отпускания потреблены")
	var cur := {}
	inst.call("_collect_live", cur)
	var tv = cur.get(tid)
	check(tv != null, "отпущенная фишка на столе")
	check(tv != null and (tv as Control).modulate.a == 0.0,
		"своя отпущенная спрятана до слайда от пальца")
	(tv as Control).modulate.a = 1.0
	inst.set("_drop_origins", {tid: {"pos": Vector2(100, 500),
		"ms": Time.get_ticks_msec() - 5000}})
	inst.set("_anim_pending", true)
	inst.call("refresh")
	var cur2 := {}
	inst.call("_collect_live", cur2)
	var tv2 = cur2.get(tid)
	check(tv2 != null and (tv2 as Control).modulate.a > 0.0,
		"протухшая точка: фишка стоит, вдогонку не летит")

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
	check(hover.has_method("_show_row_slot"), "visual hover slot exists while dragging")
	check(not hover.has_method("_slot_position"), "no separate slot lookup while dragging")

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
			"drop in bare gap targets nearest slot")
		# Пустой слот-призрак: показывается между рядами, несёт позицию,
		# убирается полностью. Соперникам при этом ничего не уходит.
		hover.call("_show_row_slot", 1)
		var slots: Array = hover.get("_row_slots")
		check(slots.size() == 1, "slot shown on demand")
		var slot = slots[0] as Control
		check(slot != null and int(slot.get_meta("slot_pos", -1)) == 1,
			"slot carries its position")
		check(hover.call("gui_can_drop", data, Vector2(r.get_center().x, r.end.y + 5.0)) == true,
			"drop allowed over shown slot")
		hover.call("_clear_row_slots")
		check((hover.get("_row_slots") as Array).is_empty(), "slot cleared")

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


func _drop_checks() -> void:
	var hover := inst as Control
	var state = inst.get("state")
	var rbs: Array = inst.get("row_blocks")
	if rbs.is_empty():
		check(false, "row blocks for drop check")
		return
	var r: Rect2 = (rbs[0] as Control).get_global_rect()
	# Реальный дроп в щель под рядом: новый ряд встаёт ТУДА, а не в начало.
	# Ловит регрессию «пустой ряд появляется перед самым первым рядом»,
	# после которой междурядья для новых слотов уже не находятся.
	var drop_tile: int = state.hand()[0].id
	var drop_data := {kind="tile", tile_id=drop_tile, from="hand"}
	var drop_pos := Vector2(r.get_center().x, r.end.y + 5.0)
	check(hover.call("gui_can_drop", drop_data, drop_pos) == true,
		"drop allowed in the gap")
	# Как вживую: слот показан, дроп — в ту же щель. Постановка сразу
	# гасит призрак, иначе он переживает пересборку на протухшем индексе.
	hover.call("_show_row_slot", 1)
	var shown: Array = hover.get("_row_slots")
	check(shown.size() == 1, "slot shown before live-like drop")
	hover.call("gui_do_drop", drop_data, drop_pos)
	check((hover.get("_row_slots") as Array).is_empty(),
		"slot cleared right on drop, not on release")
	var tbl: Array = state.table
	check(tbl.size() == 2, "table has two rows after gap drop, got %d" % tbl.size())
	if tbl.size() != 2:
		return
	check((tbl[0] as Object).get("id") == (rbs[0] as Control).get("row_id"),
		"old row stays first after gap drop")
	var new_tiles: Array = (tbl[1] as Object).get("tiles")
	check(new_tiles.size() == 1 and (new_tiles[0] as Object).get("id") == drop_tile,
		"dropped tile lands in the new row at the gap")
	# После дропа междурядья по-прежнему находятся для новых слотов.
	inst.call("refresh")
	await process_frame
	await process_frame
	var rbs3: Array = inst.get("row_blocks")
	check(rbs3.size() == 2, "two row blocks, got %d" % rbs3.size())
	if rbs3.size() == 2:
		var r1: Rect2 = (rbs3[0] as Control).get_global_rect()
		var r2: Rect2 = (rbs3[1] as Control).get_global_rect()
		check(hover.call("_hover_slot_pos",
			Vector2(r1.get_center().x, (r1.end.y + r2.position.y) * 0.5)) == 1,
			"gap between rows still found after drop")
		check(hover.call("_hover_slot_pos",
			Vector2(r2.get_center().x, r2.end.y + 3.0)) == 2,
			"gap below last row found after drop")


## Стол листается пальцем с фишки, когда фишки двигать нельзя (чужой
## ход): касание иначе умирало бы кликом в никуда. Свой ход — касание
## по фишке принадлежит перетаскиванию, стол не едет.
func _pan_checks() -> void:
	var hover := inst as Control
	var scroll := inst.get("table_scroll") as ScrollContainer
	check(scroll != null, "table scroll exists")
	if scroll == null:
		return
	Input.set_use_accumulated_input(false)
	# Как в остальных тестах: телефонный вьюпорт, иначе окно 64x64 и
	# координаты жестов — мусор на округлениях.
	root.size = Vector2i(576, 1024)
	await process_frame
	await process_frame
	# Рядов должно хватить на переполнение при любом окне: докидываем
	# с фишками (одна и та же из руки — для прокрутки сойдёт).
	var state = inst.get("state")
	for i in range(12):
		var row = state.add_row()
		row.tiles.append(state.hand()[0])
	inst.call("refresh")
	await process_frame
	await process_frame
	scroll.scroll_vertical = 999999
	var maxv := int(scroll.scroll_vertical)
	check(maxv > 0, "table overflows, can scroll (max=%d)" % maxv)
	if maxv <= 0:
		return
	# Пас-оверлей стартового экрана гасим штатно: иначе он держит все
	# жесты и пан-видимость (_modal_open).
	inst.call("_on_pass_ready")
	await process_frame
	var settings := root.get_node_or_null("Settings")
	# Свой ход: жест с фишки — перетаскивание, стол стоит. Листаем вверх
	# от верхней фишки: вниз от неё скроллить уже некуда (scroll = 0).
	settings.call("set_bot", 0, false)
	inst.call("refresh")
	await process_frame
	await process_frame
	scroll.scroll_vertical = 0
	await process_frame
	var tile := _visible_table_tile(scroll)
	check(tile != null, "table tile for pan test")
	if tile == null:
		return
	var c := (tile as Control).get_global_rect().get_center()
	_press(c)
	_motion(c + Vector2(0, -40))
	_motion(c + Vector2(0, -80))
	_release(c + Vector2(0, -80))
	await process_frame
	await process_frame
	check(int(scroll.scroll_vertical) == 0,
		"own turn: drag from tile does not pan table (%d)" % scroll.scroll_vertical)
	# Чужой ход: фишки инертны — тот же жест листает стол.
	settings.call("set_bot", 0, true)
	inst.call("refresh")
	await process_frame
	await process_frame
	scroll.scroll_vertical = 0
	await process_frame
	tile = _visible_table_tile(scroll)
	check(tile != null, "table tile still there on foreign turn")
	if tile == null:
		settings.call("set_bot", 0, false)
		inst.call("refresh")
		return
	c = (tile as Control).get_global_rect().get_center()
	_press(c)
	_motion(c + Vector2(0, -40))
	_motion(c + Vector2(0, -80))
	_release(c + Vector2(0, -80))
	await process_frame
	await process_frame
	check(int(scroll.scroll_vertical) > 0,
		"foreign turn: pan from tile scrolls table (0 -> %d)" % scroll.scroll_vertical)
	settings.call("set_bot", 0, false)
	inst.call("refresh")


## Ползунок скролла стола ведёт натив, а не пан игры: жест с него —
## не content-follow (иначе ползунок ехал бы ПРОТИВ пальца), направление
## нативное: ползунок вниз — значение растёт. После отпускания натив
## сам докатывает по импульсу, пан в жест не встаёт вообще.
func _bar_checks() -> void:
	var scroll := inst.get("table_scroll") as ScrollContainer
	if scroll == null:
		check(false, "table scroll for bar test")
		return
	await process_frame
	var bar := scroll.get_v_scroll_bar()
	if bar == null or not bar.is_visible_in_tree():
		check(false, "table v-bar visible")
		return
	check(inst.call("_can_pan_table",
		bar.get_global_rect().get_center()) == false,
		"пан не стартует с ползунка")
	check(inst.call("_point_on_scrollbar",
		bar.get_global_rect().get_center()) == true,
		"точка на ползунке опознана")
	scroll.scroll_vertical = 0
	await process_frame
	var c := bar.get_global_rect().get_center()
	_press(c)
	_motion(c + Vector2(0, 60))
	_motion(c + Vector2(0, 120))
	_release(c + Vector2(0, 120))
	await process_frame
	await process_frame
	check(not bool(inst.get("_pan_pressed")), "пан не вёлся с ползунка")
	check(not bool(inst.get("_pan_press_on_bar")),
		"флаг ползунка сброшен после жеста")
	check(int(scroll.scroll_vertical) > 0,
		"ползунок вниз — натив крутит вниз (%d)" % scroll.scroll_vertical)


## Галочка — top_level: под тостом и бургер-меню она прячется, а не
## торчит поверх уведомлений. Без попапов видна как раньше.
func _badge_popup_checks() -> void:
	var tv_script := load("res://scripts/ui/tile_view.gd") as GDScript
	var t := Tile.new(930, Tile.TColor.BLUE, 4, false)
	var v: Control = tv_script.make(t, false, inst)
	v.position = Vector2(60, 120)
	root.add_child(v)
	v.set("mark_drawn", true)
	await process_frame
	await process_frame
	v.call("_sync_badge")
	var bb := v.get("_badge") as Control
	check(bb != null and bb.visible, "бейдж виден без попапов")
	check(not bool(inst.call("_badges_hidden")), "гейт пуст без попапов")
	inst.call("toast", "тест", false)
	await process_frame
	v.call("_sync_badge")
	check(bb != null and not bb.visible, "бейдж прячется под уведомлением")
	check(bool(inst.call("_badges_hidden")), "гейт видит уведомление")
	inst.call("_hide_toast")
	inst.call("_set_burger_open", true, false)
	await process_frame
	v.call("_sync_badge")
	check(bb != null and not bb.visible, "бейдж прячется под бургером")
	check(bool(inst.call("_badges_hidden")), "гейт видит бургер")
	inst.call("_set_burger_open", false, false)
	await process_frame
	v.call("_sync_badge")
	check(bb != null and bb.visible, "попапы ушли — бейдж вернулся")
	v.free()
func _win_checks() -> void:
	var hover := inst as Control
	var state = inst.get("state")
	# Доигрываем в лоб. Статистику не пишем (флаг уже стоит), иначе
	# тест пачкал бы конфиг игрока.
	inst.set("_stats_recorded", true)
	state.finished = true
	state.winner = 0
	inst.call("refresh")
	await process_frame
	await process_frame
	inst.call("_show_win")
	var ov := inst.get("win_overlay") as Control
	check(ov != null and ov.visible, "win screen shown")
	if ov == null:
		return
	var view_btn := _find_button_text(ov, "Посмотреть")
	check(view_btn != null, "view-table button exists")
	if view_btn == null:
		return
	view_btn.pressed.emit()
	await process_frame
	check(not ov.visible, "win overlay hidden for inspection")
	var back := inst.get("_inspect_btn") as Button
	check(back != null and back.visible, "back button shown")
	check(not bool(hover.call("_can_act")), "finished game is read-only")
	check(not bool(inst.call("_modal_open")), "no modal over inspected table")
	var rbs: Array = inst.get("row_blocks")
	if not rbs.is_empty():
		var flow = (rbs[0] as Control).get("flow")
		var views: Array = flow.get("tile_views") if flow != null else []
		if not views.is_empty():
			check(not bool(views[0].get("draggable")), "finished tiles not draggable")
	if back != null:
		back.pressed.emit()
		await process_frame
		check(ov.visible, "back returns win screen")
		check(not back.visible, "back button hidden again")
	# Вне Web рекламы нет по построению: опросы SDK отвечают отказом.
	var hp: Dictionary = hover.call("_poll_hint_ad")
	check(bool(hp.get("closed", false)), "hint ad defaults to denied off-web")
	var ep: Dictionary = hover.call("_poll_endgame_ad")
	check(bool(ep.get("closed", false)), "endgame ad defaults to closed off-web")


func _find_button_text(node: Node, part: String) -> Button:
	if node is Button and String((node as Button).text).contains(part):
		return node as Button
	for child in node.get_children():
		var found := _find_button_text(child, part)
		if found != null:
			return found
	return null


## Первая видимая фишка стола с запасом сверху под жест: жест целиком
## обязан пройти внутри вьюпорта, иначе точка уйдёт за край скролла.
func _visible_table_tile(scroll: ScrollContainer) -> Control:
	var vr: Rect2 = scroll.get_global_rect()
	var rbs: Array = inst.get("row_blocks")
	for block in rbs:
		var flow = (block as Control).get("flow")
		if flow == null:
			continue
		for view in flow.get("tile_views"):
			var v := view as Control
			if v == null:
				continue
			var vc := v.get_global_rect().get_center()
			if vr.has_point(vc) and vc.y - vr.position.y >= 90.0:
				return v
	return null


## Жесты — в координатах вьюпорта, а parse_input_event ждёт оконные.
func _to_window(pos: Vector2) -> Vector2:
	var base := root.content_scale_size
	var win := Vector2(root.size)
	if base.x <= 0 or base.y <= 0:
		return pos
	var k := minf(win.x / base.x, win.y / base.y)
	return pos * k


func _press(pos: Vector2) -> void:
	# Курсор двигаем явно: game._input читает get_global_mouse_position(),
	# а синтетика parse_input_event его за собой не тянет.
	Input.warp_mouse(pos)
	var w := _to_window(pos)
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = true
	ev.position = w
	ev.global_position = w
	ev.button_mask = MOUSE_BUTTON_MASK_LEFT
	Input.parse_input_event(ev)


func _motion(pos: Vector2) -> void:
	Input.warp_mouse(pos)
	var w := _to_window(pos)
	var ev := InputEventMouseMotion.new()
	ev.position = w
	ev.global_position = w
	ev.button_mask = MOUSE_BUTTON_MASK_LEFT
	Input.parse_input_event(ev)


func _release(pos: Vector2) -> void:
	Input.warp_mouse(pos)
	var w := _to_window(pos)
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = false
	ev.position = w
	ev.global_position = w
	Input.parse_input_event(ev)
