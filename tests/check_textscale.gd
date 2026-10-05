extends SceneTree

# ==============================================================
#  Масштаб текста: рамки, согласованность, фишки.
#
#  Три класса проверок для каждой из четырёх настроек текста:
#
#   1) правый край — ни один видимый Control (за исключением
#      содержимого горизонтально-прокручиваемых контейнеров) не
#      вылезает за 576: именно так ломалось «даже при среднем»;
#   2) содержимое фишки — ширина «88» и рисованная звезда джокера
#      обязаны влезать в саму фишку на всех шести размерах карточек;
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

	_check_web_glyphs()
	await _dup_round()
	await _scroll_badge_round()
	_badge_fade_round()

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

	var btn := _find_button(menu, "Играть с другими")
	if btn == null:
		_fail("нет кнопки «Играть с другими»")
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
	if w88 > ts.x - 6.0:
		_fail("масштаб %d, фишка %dx%d: цифра шириной %.0f не влезает"
			% [idx, int(ts.x), int(ts.y), w88])
	if float(fsize) > ts.y - 2.0:
		_fail("масштаб %d, фишка %dx%d: шрифт %d выше фишки"
			% [idx, int(ts.x), int(ts.y), fsize])
	if fsize < 8:
		_fail("масштаб %d, фишка %dx%d: шрифт %d меньше минимума"
			% [idx, int(ts.x), int(ts.y), fsize])
	view.free()
	# Джокер: цифры и подписи нет (звезда — рисованный полигон, см.
	# TileView.star_outer), диаметр с обводкой держит тот же запас 6 px.
	var jt := Tile.new(2, Tile.TColor.RED, 0, true)
	var jv: Control = tv_script.make(jt, false, null) as Control
	for ch in jv.get_children():
		if ch is Label:
			_fail("у джокера текстовая подпись вместо рисованной звезды")
	var sdiam: float = tv_script.star_outer(ts) * 1.14 * 2.0
	if sdiam > minf(ts.x, ts.y) - 6.0:
		_fail("масштаб %d, фишка %dx%d: звезда диаметром %.0f не влезает"
			% [idx, int(ts.x), int(ts.y), sdiam])
	jv.free()
	# Геометрия звезды: 10 вершин, верхний луч строго вверх, все точки
	# в пределах внешнего радиуса (иначе обводка вылезет из запаса).
	var pts: PackedVector2Array = tv_script.star_points(Vector2.ZERO, 100.0)
	if pts.size() != 10:
		_fail("звезда: вершин %d, надо 10" % pts.size())
	elif not pts[0].is_equal_approx(Vector2(0, -100)):
		_fail("звезда: верхний луч не вверх, got %s" % str(pts[0]))
	else:
		for p in pts:
			if p.length() > 100.1:
				_fail("звезда: точка %s за радиусом" % str(p))


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


# ---------------------------------------------------------------- глифы Web

## Во встроенном шрифте Web-сборки нет системного фолбэка: стрелки,
## геометрия и дингбаты рисуются тофу-квадратом. Поэтому в строках —
## только символы из покрытых блоков, а звезда джокера и бургер
## рисуются кодом (полигон/иконка). Скан идёт по коду без комментариев:
## в комментариях эти символы безвредны. Проверяются только Web-поверхности (scripts/ui
## и переводы): Android-файлы сюда не входят.
func _check_web_glyphs() -> void:
	var risky := []
	for cp in range(0x2190, 0x2200):
		risky.append(cp)
	for cp in range(0x25A0, 0x27C0):
		risky.append(cp)
	for dir_path in ["res://scripts/ui", "res://scripts/core"]:
		var dir := DirAccess.open(dir_path)
		if dir == null:
			_fail("не открывается " + dir_path)
			continue
		for fn in dir.get_files():
			if fn.ends_with(".gd"):
				_scan_glyph_file(dir_path + "/" + fn, risky)


func _scan_glyph_file(path: String, risky: Array) -> void:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		_fail("не читается " + path)
		return
	var idx := 0
	while not f.eof_reached():
		idx += 1
		var code := _strip_gd_comment(f.get_line())
		for i in code.length():
			var cp := code.unicode_at(i)
			if int(cp) in risky:
				_fail("%s:%d запрещённый для Web глиф U+%04X" % [path, idx, cp])
	f.close()


## Отрезает `#`-комментарий вне строк: внутри строк `#` встречается
## (hex-цвета, URL с якорем) и резать по нему нельзя.
func _strip_gd_comment(line: String) -> String:
	var in_str := false
	var i := 0
	while i < line.length():
		var c := line[i]
		if c == "\\":
			i += 2
			continue
		if c == "\"":
			in_str = not in_str
		elif c == "#" and not in_str:
			return line.left(i)
		i += 1
	return line


# ---------------------------------------------------------------- дубликат превью

## duplicate() копирует узлы, но НЕ скриптовые поля: без чинки у дубликата
## tile/marks пустые (звезда не рисуется) и висит мёртвый бейдж. Чинка —
## TileView._prepare_drag_dup. Плюс белый кружок бейджа и прятки под модалками.
func _dup_round() -> void:
	# Без as TileView: глобальное имя в --script тянет компиляцию класса
	# до регистрации автозагрузок, и Settings внутри не резолвится
	# (тот же грабель, что в комментарии _tile_round выше).
	var tv_script := load("res://scripts/ui/tile_view.gd") as GDScript
	var bs := load("res://scripts/ui/badge_dot.gd") as GDScript
	var jt := Tile.new(3, Tile.TColor.BLUE, 0, true)
	var jv: Control = tv_script.make(jt, false, null)
	root.add_child(jv)
	await process_frame
	var dup: Control = jv.duplicate()
	dup.call("_prepare_drag_dup", jv)
	if dup.get("tile") != jt:
		_fail("чинка не вернула дубликату tile — звезда не нарисуется")
	var labels := 0
	var badges := 0
	for ch in dup.get_children():
		if ch is Label:
			labels += 1
		elif is_instance_valid(ch) and (ch as Node).get_script() == bs:
			badges += 1
	if labels != 0:
		_fail("у джокера текстовая подпись вместо рисованной звезды")
	if badges != 1:
		_fail("у дубликата не один живой бейдж, got %d" % badges)
	# Цифра едет узлом и не должна теряться при чинке.
	var nt := Tile.new(4, Tile.TColor.RED, 88, false)
	var nv: Control = tv_script.make(nt, false, null)
	root.add_child(nv)
	var ndup: Control = nv.duplicate()
	ndup.call("_prepare_drag_dup", nv)
	var kept := ""
	for ch in ndup.get_children():
		if ch is Label:
			kept = String((ch as Label).text)
	if kept != "88":
		_fail("цифра не пережила дубликат, got '%s'" % kept)
	if ndup.get("tile") != nt:
		_fail("номерной дубликат без tile")
	# Маркированный оригинал: бейдж top_level, клики сквозь, виден.
	jv.set("mark_drawn", true)
	jv.call("_sync_badge")
	var bb := jv.get("_badge") as Control
	if bb == null or not bb.visible:
		_fail("бейдж не виден на свежей фишке")
	else:
		if not bb.top_level:
			_fail("бейдж не поверх рядов (нет top_level)")
		if bb.mouse_filter != Control.MOUSE_FILTER_IGNORE:
			_fail("бейдж перехватывает тапы")
	# Белый кружок без тёмной обводки + прятки под модалками (статикой:
	# отрисовку _draw без дисплея не увидеть).
	var bsrc := _read_text("res://scripts/ui/badge_dot.gd")
	if not bsrc.contains("Color(1, 1, 1"):
		_fail("кружок бейджа не белый")
	if bsrc.contains("0, 0, 0, 0.85"):
		_fail("у кружка осталась тёмная обводка")
	var tsrc := _read_text("res://scripts/ui/tile_view.gd")
	if not tsrc.contains("_modal_open"):
		_fail("бейдж не прячется под модалками")
	jv.free()
	nv.free()
	dup.free()
	ndup.free()


# ---------------------------------------------------------------- бейдж и скролл

## Подписчик не улетает за поле: фишка вне видимости скролла — бейдж
## прячется (раньше долетал аж до верхних кнопок).
func _scroll_badge_round() -> void:
	var tv_script := load("res://scripts/ui/tile_view.gd") as GDScript
	var sc := ScrollContainer.new()
	sc.custom_minimum_size = Vector2(200, 200)
	sc.size = Vector2(200, 200)
	sc.position = Vector2(50, 50)
	root.add_child(sc)
	var inner := Control.new()
	inner.custom_minimum_size = Vector2(200, 800)
	sc.add_child(inner)
	var jt := Tile.new(5, Tile.TColor.BLUE, 0, true)
	var jv: Control = tv_script.make(jt, false, null)
	jv.position = Vector2(0, 50)
	inner.add_child(jv)
	jv.set("mark_drawn", true)
	await process_frame
	await process_frame
	sc.scroll_vertical = 0
	jv.call("_sync_badge")
	var bb := jv.get("_badge") as Control
	if bb == null or not bb.visible:
		_fail("бейдж виден, пока фишка в скролле")
		jv.free()
		sc.free()
		return
	sc.scroll_vertical = 600
	await process_frame
	await process_frame
	jv.call("_sync_badge")
	if bb.visible:
		_fail("фишка уехала из скролла — бейдж спрятан")
	sc.scroll_vertical = 0
	await process_frame
	await process_frame
	jv.call("_sync_badge")
	if not bb.visible:
		_fail("вернули скролл — бейдж снова виден")
	jv.free()
	sc.free()


## Бейдж гаснет вовремя: сверху — полка почти до кромки и резкий срез
## в последние пиксели (первый ряд не тускнеет), снизу — по доле
## видимого, как раньше. Тускнеет только кружок, не фишка.
func _badge_fade_round() -> void:
	var tv_script := load("res://scripts/ui/tile_view.gd") as GDScript
	var sc := Rect2(0, 0, 200, 200)
	if float(tv_script.badge_fade_for(Rect2(50, 80, 40, 40), sc)) != 1.0:
		_fail("бейдж в глубине: alpha 1")
	if float(tv_script.badge_fade_for(Rect2(50, 10, 40, 40), sc)) != 1.0:
		_fail("бейдж в 10 px от верха: ещё полный")
	var near_top := float(tv_script.badge_fade_for(Rect2(50, 1.5, 40, 40), sc))
	if absf(near_top - 0.5) > 0.01:
		_fail("бейдж в 1.5 px от верха: наполовину, got %.2f" % near_top)
	if float(tv_script.badge_fade_for(Rect2(50, 0, 40, 40), sc)) != 0.0:
		_fail("бейдж на верхней кромке: alpha 0")
	var half_out := float(tv_script.badge_fade_for(Rect2(50, 180, 40, 40), sc))
	if absf(half_out - 0.5 / 0.75) > 0.01:
		_fail("бейдж наполовину за низом: гаснет, got %.2f" % half_out)
	if float(tv_script.badge_fade_for(Rect2(50, 300, 40, 40), sc)) != 0.0:
		_fail("бейдж снаружи: alpha 0")
	if float(tv_script.badge_fade_for(Rect2(50, 50, 0, 40), sc)) != 0.0:
		_fail("нулевая фишка: alpha 0")


func _read_text(path: String) -> String:
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return ""
	var text := f.get_as_text()
	f.close()
	return text


func _fail(msg: String) -> void:
	fails += 1
	printerr("FAIL  " + msg)
