extends SceneTree

# ==============================================================
#  Масштаб текста: рамки, согласованность, фишки.
#
#  Три класса проверок для каждой из четырёх настроек текста:
#
#   1) правый край — ни один видимый Control (за исключением
#      содержимого горизонтально-прокручиваемых контейнеров) не
#      вылезает за 576: именно так ломалось «даже при среднем»;
#   2) числа в фишке — ширина «88»/«★» и высота шрифта обязаны
#      влезать в саму фишку на всех шести размерах карточек;
#   3) границы самого fs() — пол для мелкого текста (на «Маленьком»
#      fs(12) не мельчает допустимого) и точная таблица значений.
#
#     godot --headless --path . --script res://tests/check_textscale.gd
# ==============================================================

var fails := 0
var _scale := 0
var _overflow: Array = []


func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	root.size = Vector2i(576, 1024)
	var settings := root.get_node_or_null("Settings")
	if settings == null:
		printerr("FAIL  Settings autoload missing")
		quit(1)
		return
	var saved_scale: int = settings.text_scale
	var saved_step: int = settings.tile_step

	_check_fs_bounds(settings)

	for idx in range(3):
		settings.text_scale = idx
		_scale = idx
		await _menu_round(idx)
		await _game_round(idx)

	for idx in range(3):
		settings.text_scale = idx
		_scale = idx
		for step in range(6):
			settings.tile_step = step
			_tile_round(idx, step)

	settings.text_scale = saved_scale
	settings.tile_step = saved_step

	if _overflow.is_empty() and fails == 0:
		print("TEXTSCALE CHECK PASSED")
		quit(0)
		return
	if not _overflow.is_empty():
		printerr("ВЫХОД ЗА ПРАВЫЙ КРАЙ (%d):" % _overflow.size())
		for line in _overflow:
			printerr("  " + str(line))
	printerr("TEXTSCALE CHECK: %d FAILED" % (fails + _overflow.size()))
	quit(1)


# ---------------------------------------------------------------- fs()

func _check_fs_bounds(settings) -> void:
	# Таблица шкал: маленький/средний/большой.
	var expect := [100, 130, 200]
	for idx in range(3):
		settings.text_scale = idx
		var got: int = settings.fs(100)
		if got != int(expect[idx]):
			_fail("fs(100) на масштабе %d = %d, ожидалось %d" % [idx, got, expect[idx]])
	# Пол для мелкого текста: база 12 не опускается ниже читаемого минимума.
	settings.text_scale = 0
	var floor_got: int = settings.fs(12)
	if floor_got < 12:
		_fail("fs(12) на «Маленьком» = %d, минимум 12" % floor_got)
	# touch() пола не имеет — это размеры контролов, а не текста.
	if settings.touch(2) > 4:
		_fail("touch(2) не должен получать текстовый пол, got %d" % settings.touch(2))


# ---------------------------------------------------------------- меню

func _menu_round(idx: int) -> void:
	var packed := load("res://scenes/main_menu.tscn") as PackedScene
	if packed == null:
		_fail("main_menu.tscn не читается")
		return
	var menu := packed.instantiate()
	root.add_child(menu)
	await process_frame
	await process_frame
	await process_frame
	_walk(menu, "меню (масштаб %d)" % idx)

	var btn := _find_button(menu, "По сети")
	if btn == null:
		_fail("нет кнопки «По сети»")
		return
	btn.pressed.emit()
	await process_frame
	await process_frame
	var lobby: Node = menu.get("online_lobby")
	if lobby == null:
		_fail("сетевое меню не появилось")
		return
	for page_name in ["_page_auth", "_page_rooms", "_page_lobby"]:
		var page: Node = lobby.get(page_name)
		if page == null:
			_fail("%s нет" % page_name)
			continue
		lobby.call("_set_page", page)
		await process_frame
		await process_frame
		_walk(page, "лобби %s (масштаб %d)" % [page_name, idx])
	# Оверлеи меню: правила и статистика.
	for overlay_name in ["help_overlay", "stats_overlay"]:
		var ov: Node = menu.get(overlay_name)
		if ov is Control:
			(ov as Control).visible = true
			await process_frame
			await process_frame
			_walk(ov, "наложение %s (масштаб %d)" % [overlay_name, idx])
			(ov as Control).visible = false


# ---------------------------------------------------------------- партия

func _game_round(idx: int) -> void:
	var packed := load("res://scenes/game.tscn") as PackedScene
	if packed == null:
		_fail("game.tscn не читается")
		return
	var game := packed.instantiate()
	root.add_child(game)
	await process_frame
	await process_frame
	await process_frame
	_walk(game, "партия (масштаб %d)" % idx)

	# Оверлеи с образцами текста: заголовки — самые длинные строки.
	var win_title = game.get("win_title")
	if win_title != null:
		(win_title as Label).text = "Победитель - Игрок 10"
	var win_ov = game.get("win_overlay")
	if win_ov is Control:
		(win_ov as Control).visible = true
		await process_frame
		await process_frame
		_walk(win_ov, "оверлей победы (масштаб %d)" % idx)
		(win_ov as Control).visible = false

	var pass_name = game.get("pass_name")
	if pass_name != null:
		(pass_name as Label).text = "Игрок 10"
	var pass_ov = game.get("pass_overlay")
	if pass_ov is Control:
		(pass_ov as Control).visible = true
		await process_frame
		await process_frame
		_walk(pass_ov, "передача устройства (масштаб %d)" % idx)
		(pass_ov as Control).visible = false

	var turn_ov = game.get("turn_title_overlay")
	var turn_lab = game.get("turn_title_label")
	if turn_lab != null:
		(turn_lab as Label).text = "Ход соперника"
	if turn_ov is Control:
		(turn_ov as Control).visible = true
		await process_frame
		await process_frame
		_walk(turn_ov, "титр хода (масштаб %d)" % idx)
		(turn_ov as Control).visible = false

	# Тост с длинной строкой — типовое сообщение о невозможном ходе.
	var toast_label = game.get("toast_label")
	if toast_label is Label:
		var tl := toast_label as Label
		tl.text = "Нельзя: в новый ряд кладут только серию из трёх и больше"
		tl.visible = true
		var panel: Control = tl.get_parent() as Control
		if panel != null:
			panel.visible = true
			await process_frame
			await process_frame
			_walk(panel, "тост (масштаб %d)" % idx)
			panel.visible = false
			tl.visible = false


# ---------------------------------------------------------------- фишки

func _tile_round(idx: int, step: int) -> void:
	var settings := root.get_node("Settings")
	var ts: Vector2 = settings.tile_size()
	var tile := Tile.new(1, Tile.TColor.RED, 88, false)
	# Глобальное имя TileView в режиме --script не резолвится до
	# регистрации autoload'ов (tile_view.gd ссылается на Settings) —
	# грузим скрипт в рантайме, когда дерево уже собрано.
	var tv_script := load("res://scripts/ui/tile_view.gd") as GDScript
	var view: Control = tv_script.make(tile, false, null) as Control
	var lab := view.get_child(0) if view.get_child_count() > 0 else null
	if not (lab is Label):
		_fail("у фишки нет подписи (шаг %d)" % step)
		view.free()
		return
	var label := lab as Label
	var fsize: int = label.get_theme_font_size("font_size")
	var font: Font = label.get_theme_font("font")
	if font == null:
		_fail("у подписи фишки нет шрифта")
		view.free()
		return
	var w88: float = font.get_string_size("88", HORIZONTAL_ALIGNMENT_LEFT, -1, fsize).x
	var wstar: float = font.get_string_size("★", HORIZONTAL_ALIGNMENT_LEFT, -1, fsize).x
	var widest := maxf(w88, wstar)
	if widest > ts.x - 6.0:
		_fail("масштаб %d, фишка %dx%d: цифра шириной %.0f не влезает"
			% [idx, int(ts.x), int(ts.y), widest])
	if float(fsize) > ts.y - 2.0:
		_fail("масштаб %d, фишка %dx%d: шрифт %d выше фишки"
			% [idx, int(ts.x), int(ts.y), fsize])
	if fsize < 8:
		_fail("масштаб %d, фишка %dx%d: шрифт %d меньше минимума"
			% [idx, int(ts.x), int(ts.y), fsize])
	view.free()


# ---------------------------------------------------------------- обход

func _walk(node: Node, ctx: String) -> void:
	if node is Control:
		_check_edge(node as Control, ctx)
	for child in node.get_children():
		if child is Control:
			_walk(child, ctx)


func _check_edge(c: Control, ctx: String) -> void:
	if not c.is_visible_in_tree():
		return
	if _under_hscroll(c):
		return
	var width := float(root.size.x)
	var rect := c.get_global_rect()
	var min_w: float = c.get_combined_minimum_size().x
	if rect.end.x > width + 1.0:
		_overflow.append("%s | %s «%s» end.x=%.0f (+%.0f) min=%.0f"
			% [ctx, c.get_class(), _caption(c), rect.end.x, rect.end.x - width, min_w])
	elif rect.position.x < -1.0:
		_overflow.append("%s | %s «%s» start.x=%.0f (−%.0f) min=%.0f"
			% [ctx, c.get_class(), _caption(c), rect.position.x, -rect.position.x, min_w])


## Содержимое контейнера с включённой горизонтальной прокруткой
## за край не уезжает — туда можно доскроллить. Режим DISABLED
## (или вертикальный скролл без горизонтального) — уже не спасает.
func _under_hscroll(c: Control) -> bool:
	var p := c.get_parent()
	while p != null:
		if p is ScrollContainer:
			var sc := p as ScrollContainer
			if sc.horizontal_scroll_mode != ScrollContainer.SCROLL_MODE_DISABLED:
				return true
		p = p.get_parent()
	return false


func _caption(c: Control) -> String:
	if c is Label and not (c as Label).text.is_empty():
		return (c as Label).text.substr(0, 30)
	if c is Button and not (c as Button).text.is_empty():
		return (c as Button).text.substr(0, 30)
	if c is LineEdit and not (c as LineEdit).placeholder_text.is_empty():
		return (c as LineEdit).placeholder_text
	return String(c.name)


func _find_button(node: Node, text: String) -> Button:
	for child in node.get_children():
		if child is Button and (child as Button).text == text:
			return child as Button
		var found := _find_button(child, text)
		if found != null:
			return found
	return null


func _fail(msg: String) -> void:
	fails += 1
	printerr("FAIL  " + msg)
