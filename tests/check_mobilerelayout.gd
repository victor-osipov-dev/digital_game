extends SceneTree

# ==============================================================
#  Вёрстка сетевого меню под разные экраны и размеры текста.
#
#  Симптомы, ради которых написан тест:
#
#   1) «ИГРА ПО СЕТИ» обрезалась — заголовок стоял в одном ряду с
#      кнопкой «Назад», а Label с clip_text отрезал хвост молча.
#      Теперь размер шрифта подбирается под свободную ширину;
#      проверяем, что строка влезает целиком.
#
#   2) Ряды из двух-трёх контролов сжимались в нечитаемые полоски:
#      «название (необязательно)» и «пароль (необязательно)» делили
#      строку на трое. Теперь ряд, который не влезает, встаёт
#      столбиком. Проверяем и сложение, и обратное раскладывание.
#
#   3) Ничего не уезжает за правый край: горизонтальная прокрутка у
#      меню и лобби выключена, отскроллить уехавшее нельзя. Проверяем
#      и главное меню, и все три страницы лобби.
#
#   Попутно вскрылось, что переполнялись не только ряды лобби: у Label
#   без autowrap минимальная ширина равна всей строке, поэтому строка
#   статуса, подзаголовок меню и длинная подпись чекбокса растягивали
#   колонку шире окна и уводили за край вообще всё. Поэтому проверка
#   идёт по обеим страницам, а не только по странице комнат.
#
#  Важно про размеры: при stretch=canvas_items и aspect=expand
#  вьюпорт НИКОГДА не уже content_scale_size — узкое окно просто
#  масштабируется, а расширяется вьюпорт в ландшафте. Поэтому «узкий
#  телефон» проверяется не шириной окна, а базой растяжения: меняем
#  root.content_scale_size на 360/420/320 — вот тогда в строке
#  реально не хватает места и ряды обязаны сложиться. Текстовая шкала
#  бьёт по той же ширине, но множителем.
#  Ширину для всех проверок берём у вьюпорта, а не у окна: координаты
#  get_global_rect() тоже во вьюпорте, сравнивать их с размером окна
#  бессмысленно.
#
#     godot --headless --path . --script res://tests/check_mobilerelayout.gd
# ==============================================================

# Ориентации окна. Сама узость задаётся базой растяжения (BASES).
const SIZES := [
	Vector2i(576, 1024),
	Vector2i(360, 800),
	Vector2i(412, 915),
	Vector2i(1024, 576),
	Vector2i(320, 640),
]

# Базы растяжения: проектная 576 и по-настоящему узкие телефоны.
# 360 — самый узкий из массовых, 420 — граница, ниже которой ряд из
# трёх полей обязан встать столбиком.
const BASES := [
	Vector2i(576, 1024),
	Vector2i(360, 800),
	Vector2i(420, 900),
	Vector2i(320, 640),
]

const PAGES := ["_page_auth", "_page_rooms", "_page_lobby"]

var fails := 0
var _bad: Array = []
var _ctx := ""
var _audited := false


func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	var settings := root.get_node_or_null("Settings")
	if settings == null:
		printerr("FAIL  Settings autoload missing")
		quit(1)
		return
	var saved: int = settings.text_scale
	var saved_base := root.content_scale_size
	for size in SIZES:
		for base in BASES:
			for scale in range(4):
				settings.text_scale = scale
				await _round(size, base, scale)
	root.content_scale_size = saved_base
	settings.text_scale = saved
	if _bad.is_empty() and fails == 0:
		print("MOBILE LAYOUT CHECK PASSED")
		quit(0)
		return
	for line in _bad:
		printerr("  " + str(line))
	printerr("MOBILE LAYOUT CHECK: %d FAILED" % (fails + _bad.size()))
	quit(1)


# ---------------------------------------------------------------- один прогон

func _round(size: Vector2i, base: Vector2i, scale: int) -> void:
	root.size = size
	# Узкий экран задаём базой растяжения, а не размером окна: при
	# stretch=canvas_items и aspect=expand окно уже базы — оно просто
	# масштабируется, а расширяется вьюпорт в ландшафте.
	root.content_scale_size = base
	await process_frame
	_ctx = "окно %dx%d, база %dx%d, текст %d (вьюпорт %dx%d)" % [
		size.x, size.y, base.x, base.y, scale,
		int(root.get_visible_rect().size.x), int(root.get_visible_rect().size.y),
	]
	var menu: Node = await _menu()
	if menu == null:
		return
	if not _audited:
		_audited = true
		_audit_buttons(menu, "main_menu")
		_audit_checks(menu, "main_menu")
		var lob: Node = menu.get("online_lobby")
		if lob != null:
			_audit_buttons(lob, "online_lobby")
			_audit_checks(lob, "online_lobby")
	var lobby: Node = menu.get("online_lobby")
	if lobby == null:
		_fail("нет сетевого меню")
		return
	for page_name in PAGES:
		var page: Node = lobby.get(page_name)
		if page == null:
			_fail("%s нет" % page_name)
			continue
		lobby.call("_set_page", page)
		await process_frame
		await process_frame
		_edge(page, page_name)
	_title(lobby)
	# Ряды проверяем на показанной странице комнат: у скрытой страницы
	# дети невидимы, и «влезает ли ряд» посчиталось бы по пустому списку.
	var rooms: Node = lobby.get("_page_rooms")
	if rooms != null:
		lobby.call("_set_page", rooms)
		await process_frame
		await process_frame
	# await обязателен: _rows дожидается кадров после смены размера
	# окна, и без него управление вернулось бы сюда, выполнился бы
	# queue_free — а из _rows пришлось бы читать уже освобождённые узлы.
	await _rows(lobby)
	await _stuck(menu, lobby)
	menu.queue_free()
	await process_frame


func _menu() -> Node:
	var packed := load("res://scenes/main_menu.tscn") as PackedScene
	if packed == null:
		_fail("main_menu.tscn не читается")
		return null
	var menu := packed.instantiate()
	root.add_child(menu)
	# Три кадра: первый — построение, второй — пересчёт контейнеров,
	# третий — срабатывание size_changed от смены root.size.
	await process_frame
	await process_frame
	await process_frame
	# Главное меню проверяем до открытия лобби: его ширину задаёт
	# _sync_scroll_min, и уезжать вправо оно может само по себе —
	# например, из-за двух кнопок по 200 px в нижнем ряду.
	var menu_box: Node = menu.get("menu_box")
	if menu_box != null:
		_edge(menu_box, "main_menu")
	var btn := _find_button(menu, "По сети")
	if btn == null:
		_fail("нет кнопки «По сети»")
		return null
	btn.pressed.emit()
	await process_frame
	await process_frame
	await process_frame
	return menu


# ---------------------------------------------------------------- заголовок

## Главная проверка: строка «ИГРА ПО СЕТИ» должна влезать в отведённую
## ей ширину целиком. Считаем тем же get_string_size, что рисует Label,
## и сравниваем с реальной шириной узла — если она меньше, хвост срезан.
func _title(lobby: Node) -> void:
	var node: Node = lobby.get("_title")
	if node == null:
		_fail("нет заголовка")
		return
	var label := node as Label
	var font: Font = label.get_theme_font("font")
	if font == null:
		_fail("у заголовка нет шрифта")
		return
	var size: int = label.get_theme_font_size("font_size")
	var want: float = font.get_string_size(label.text,
		HORIZONTAL_ALIGNMENT_LEFT, -1, size).x
	var have: float = label.size.x
	if want > have + 1.0:
		_fail("заголовок «%s» обрезан: нужно %.0f, есть %.0f (шрифт %d)"
			% [label.text, want, have, size])
	if size <= 0:
		_fail("у заголовка нечитаемый шрифт %d" % size)


# ---------------------------------------------------------------- ряды

## Ряд, который не влезает в строку, обязан стоять столбиком, а
## разложившийся — возвращать детей в строку. Ширину меряем после
## раскладки: у лежащего столбиком поле тянется на всю ширину.
func _rows(lobby: Node) -> void:
	var rows: Array = lobby.get("_stack_rows")
	if rows == null or rows.is_empty():
		_fail("список складываемых рядов пуст")
		return
	# Ширину для решения «влезает ли ряд» берём ту же, что и лобби:
	# это _avail_w, посчитанный из вьюпорта за вычетом полей и полосы
	# прокрутки. Ширина страницы на пару пикселей больше (границы
	# контейнеров), и сравнение с ней давало ложное «не влезает».
	var wide: float = lobby.get("_avail_w")
	if wide <= 0.0:
		_fail("лобби не посчитало доступную ширину")
		return
	for row in rows:
		var box := row as BoxContainer
		if box == null:
			_fail("в складываемых рядах не BoxContainer")
			continue
		# Ряд сложен ровно тогда, когда его дети не влезают в строку.
		# Считаем честную ширину содержимого, как движок (_need):
		# у кнопок с clip_text и пустых полей минимум по содержимому
		# не считается, и подсчёт по нему врал бы «влезает».
		var need := 0.0
		var first := true
		for item in box.get_children():
			var c := item as Control
			if c == null or not c.visible:
				continue
			need += _need_width(c)
			if not first:
				need += float(box.get_theme_constant("separation"))
			first = false
		var stacked := box.vertical
		if stacked != (need > wide):
			_fail("ряд сложен=%s, а нужно было %s (нужно %.0f, есть %.0f)"
				% [stacked, need > wide, need, wide])
		if stacked and need <= wide:
			# Разложился бы, но лежит столбиком: телефон с лишней
			# высотой в портрете не должен терять строку.
			_fail("ряд зря сложен столбиком (нужно %.0f, есть %.0f)"
				% [need, wide])
		if box.get_child_count() > 1 and stacked:
			# В столбике каждый контрол тянется на всю ширину: поле
			# шириной в треть экрана — это и есть жалоба.
			for item in box.get_children():
				var c := item as Control
				if c == null or not c.is_visible_in_tree():
					continue
				if c.size.x < box.size.x - 2.0:
					_fail("в сложенном ряду «%s» ширина %d при %d"
						% [_caption(c), int(c.size.x), int(box.size.x)])


# ---------------------------------------------------------------- баннер

## Баннер «вы всё ещё в комнате»: кнопки обязаны показывать текст.
## Ловили вживую: у кнопок с clip_text минимальная ширина считается
## только по полям стиля (8 px), ряд «влезал», кнопки сжимались в
## полоски и текст срезался полностью. Проверяем, что минимум
## покрывает текст и раскладка его уважает. Заодно: ряд создания
## комнаты («название + пароль») на узком экране обязан стоять
## столбиком — горизонтальные полоски полей нечитаемы.
func _stuck(menu: Node, lobby: Node) -> void:
	var net := root.get_node_or_null("Net")
	if net == null:
		_fail("нет Net для проверки баннера")
		return
	net.park_room({"code": "ABC12", "state": "playing"})
	lobby.call("_refresh_stuck")
	(menu as Control).call("_refresh_online_note")
	for i in range(3):
		await process_frame
	_button_text(menu.get("_return_room_btn") as Button, "_return_room_btn",
		menu.get("_room_actions") as BoxContainer)
	_button_text(menu.get("_drop_room_btn") as Button, "_drop_room_btn",
		menu.get("_room_actions") as BoxContainer)
	_button_text(lobby.get("_return_btn") as Button, "_return_btn",
		lobby.get("_stuck_row") as BoxContainer)
	_button_text(lobby.get("_drop_btn") as Button, "_drop_btn",
		lobby.get("_stuck_row") as BoxContainer)
	var create_row := lobby.get("_create_row") as BoxContainer
	if create_row == null:
		_fail("нет ряда создания комнаты")
	else:
		var wide: float = lobby.get("_avail_w")
		var need := 0.0
		var first := true
		for item in create_row.get_children():
			var c := item as Control
			if c == null or not c.visible:
				continue
			need += _need_width(c)
			if not first:
				need += float(create_row.get_theme_constant("separation"))
			first = false
		if create_row.vertical != (need > wide):
			_fail("ряд создания сложен=%s, а нужно %s (нужно %.0f, есть %.0f)"
				% [create_row.vertical, need > wide, need, wide])
		if wide <= 360.0 and not create_row.vertical:
			_fail("на узком экране (доступно %.0f) поля названия и пароля "
				% wide + "обязаны стоять столбиком")
	await _dynamic_content(lobby)
	_rooms_timer_check(lobby)
	await _stuck_text(menu, lobby)
	net.clear_pending_room()
	lobby.call("_refresh_stuck")
	(menu as Control).call("_refresh_online_note")
	await process_frame
## Вкладки, пагинация и большая кнопка игры по сети.
## Вкладки показывают одну форму (в начале — ни одной), список при
## этом виден всегда; страницы режут длинные списки.
func _tabs_and_pages(lobby: Node, rooms_page: Control) -> void:
	var play := _find_button_in(rooms_page, "Играть по сети")
	if play == null:
		_fail("нет большой кнопки «Играть по сети»")
	elif not play.visible:
		_fail("кнопка «Играть по сети» скрыта")
	if _find_button_in(rooms_page, "Быстрый") != null:
		_fail("старая кнопка «Быстрый» осталась")
	var create_box := lobby.get("_create_box") as Control
	var code_box := lobby.get("_code_box") as Control
	if create_box == null or code_box == null:
		_fail("нет коробок вкладок")
		return
	if create_box.visible or code_box.visible:
		_fail("в начале не показана ни одна форма")
		return
	var tab_create := lobby.get("_tab_create_btn") as Button
	var tab_code := lobby.get("_tab_code_btn") as Button
	if tab_create == null or tab_code == null:
		_fail("нет кнопок вкладок")
		return
	tab_create.button_pressed = true
	await process_frame
	if not create_box.visible or code_box.visible:
		_fail("вкладка создания не показала свою форму")
	tab_code.button_pressed = true
	await process_frame
	if create_box.visible or not code_box.visible:
		_fail("вкладка кода не переключила форму")
	tab_code.button_pressed = false
	await process_frame
	if create_box.visible or code_box.visible:
		_fail("снятие вкладки не спрятало обе формы")
	# Форма кода — сразу за формой создания, под своей вкладкой,
	# а не в самом низу страницы.
	var kids := (lobby.get("_page_rooms") as Control).get_children()
	var ci := kids.find(create_box)
	var di := kids.find(code_box)
	if ci < 0 or di != ci + 1:
		_fail("коробка кода не сразу за коробкой создания (%d vs %d)" % [ci, di])
	_quick_pick(lobby)
	# Пагинация: 7 комнат режутся 5 + 2.
	var rooms := []
	for i in range(7):
		rooms.append({"name": "Комната %d" % (i + 1), "filled": 1,
			"seats": 3, "code": "C%d" % i, "state": "lobby",
			"bots": 0, "hasPassword": false})
	lobby.set("_rooms", rooms)
	lobby.set("_rooms_page", 0)
	lobby.call("_render_rooms")
	for i in range(2):
		await process_frame
	var box := lobby.get("_rooms_box") as Control
	var label := lobby.get("_page_label") as Label
	if box == null or label == null:
		_fail("нет списка или подписи страниц")
		return
	if box.get_child_count() != 5:
		_fail("на первой странице не 5 комнат (%d)" % box.get_child_count())
	if label.text != "Стр. 1 из 2":
		_fail("подпись первой страницы: «%s»" % label.text)
	var next := lobby.get("_page_next") as Button
	if next == null:
		_fail("нет кнопки следующей страницы")
		return
	next.pressed.emit()
	for i in range(2):
		await process_frame
	if box.get_child_count() != 2:
		_fail("на второй странице не 2 комнаты (%d)" % box.get_child_count())
	if label.text != "Стр. 2 из 2":
		_fail("подпись второй страницы: «%s»" % label.text)
	var prev := lobby.get("_page_prev") as Button
	if prev == null:
		_fail("нет кнопки предыдущей страницы")
		return
	prev.pressed.emit()
	for i in range(2):
		await process_frame
	if box.get_child_count() != 5 or label.text != "Стр. 1 из 2":
		_fail("возврат на первую страницу не сработал")
	_quick_pick(lobby)
	lobby.set("_rooms", [])
	lobby.call("_render_rooms")
	for i in range(2):
		await process_frame
## Динамический контент приезжает через секунды после открытия
## (список комнат, ники) и раньше раздвигал страницу шире экрана:
## правый край (Назад, Обновить) уезжал. Проверяем после подгрузки.
func _dynamic_content(lobby: Node) -> void:
	var rooms_page: Control = lobby.get("_page_rooms")
	lobby.set("_rooms", [])
	lobby.call("_render_rooms")
	for i in range(2):
		await process_frame
	_edge(rooms_page, "rooms_empty")
	lobby.set("_rooms", [{
		"name": "Очень длинное название комнаты для проверки переносов",
		"filled": 2, "seats": 5, "code": "X", "state": "playing",
		"bots": 2, "hasPassword": true,
	}])
	lobby.call("_render_rooms")
	for i in range(2):
		await process_frame
	_edge(rooms_page, "rooms_long")
	var logout_btn := _find_button_in(rooms_page, "Выйти")
	if logout_btn != null:
		_button_text(logout_btn, "Выйти (подвал)",
			logout_btn.get_parent() as BoxContainer)
	else:
		_fail("нет кнопки «Выйти» в подвале комнат")
	await _tabs_and_pages(lobby, rooms_page)
	lobby.call("_show_lobby", {
		"code": "ABC12", "you": 0, "seats": 3, "isHost": false, "require30": true,
		"players": [
			{"seat": 0, "nick": "ОченьДлинныйНикПервогоИгрокаКоторыйНеВлезает",
				"empty": false, "connected": true},
			{"seat": 1, "nick": "ВторойИгрокСТожеДлиннымНиком",
				"empty": false, "connected": false},
			{"seat": 2, "empty": true},
		],
	})
	for i in range(2):
		await process_frame
	_edge(lobby.get("_page_lobby"), "lobby_long_nicks")
	# Шапка и корень после подгрузки: заголовок всё ещё влезает,
	# «Назад» на экране (край проверяет _edge рекурсивно).
	var title := lobby.get("_title") as Label
	if title != null:
		var font: Font = title.get_theme_font("font")
		if font != null:
			var size: int = title.get_theme_font_size("font_size")
			var want: float = font.get_string_size(title.text,
				HORIZONTAL_ALIGNMENT_LEFT, -1, size).x
			if want > title.size.x + 1.0:
				_fail("заголовок обрезан после подгрузки: нужно %.0f, есть %.0f"
					% [want, title.size.x])
	_edge(lobby.get("_root"), "lobby_root")


func _find_button_in(node: Node, text: String) -> Button:
	if node is Button and (node as Button).text == text:
		return node as Button
	for child in node.get_children():
		var found := _find_button_in(child, text)
		if found != null:
			return found
	return null


## Единообразие кнопок: эффективный normal-стильбокс с радиусом 10
## у каждой кнопки (чекбоксы — не в счёт, у них своя иконка).
func _audit_buttons(node: Node, where: String) -> void:
	if node is Button and not (node is CheckBox):
		var b := node as Button
		var sb := b.get_theme_stylebox("normal")
		if sb is StyleBoxFlat:
			var r: int = (sb as StyleBoxFlat).corner_radius_top_left
			if r != 10:
				_fail("%s: кнопка «%s» радиус %d, а не 10" % [where, b.text.left(20), r])
		else:
			_fail("%s: кнопка «%s» без плоского стиля" % [where, b.text.left(20)])
	for child in node.get_children():
		_audit_buttons(child, where)


## Свои галки чекбоксов: дефолтные на тёмной теме нечитаемы (пустой
## квадрат буквально чёрный, галка без рамки растворяется). Проверяем
## наши: рамка есть, внутри пусто, у включённой — галка (пикселей больше).
func _audit_checks(node: Node, where: String) -> void:
	if node is CheckBox:
		var cb := node as CheckBox
		var un := cb.get_theme_icon("unchecked")
		var ch := cb.get_theme_icon("checked")
		if un == null or ch == null:
			_fail("%s: у чекбокса нет своих иконок" % where)
		else:
			var ui := un.get_image()
			var ci := ch.get_image()
			if ui.get_size() != Vector2i(18, 18) or ci.get_size() != Vector2i(18, 18):
				_fail("%s: иконки чекбокса не 18x18" % where)
			elif ui.get_pixel(9, 9).a > 0.1:
				_fail("%s: выключенный чекбокс залит" % where)
			elif _opaque_count(ci) <= _opaque_count(ui):
				_fail("%s: у включённого чекбокса нет галки" % where)
	for child in node.get_children():
		_audit_checks(child, where)


func _opaque_count(img: Image) -> int:
	var n := 0
	for y in range(img.get_height()):
		for x in range(img.get_width()):
			if img.get_pixel(x, y).a > 0.5:
				n += 1
	return n


## Баннер «вы всё ещё в комнате» не врёт про толпу: один игрок —
## «кроме вас никого нет», двое — «игроки в сборе», партия — «идёт».
func _stuck_text(menu: Node, lobby: Node) -> void:
	var net := root.get_node_or_null("Net")
	if net == null:
		_fail("нет Net для проверки текста баннера")
		return
	var cases := [
		[{"code": "A1", "state": "lobby",
			"players": [{"empty": false}, {"empty": true}]}, "кроме вас никого нет"],
		[{"code": "A2", "state": "lobby",
			"players": [{"empty": false}, {"empty": false}]}, "игроки в сборе"],
		[{"code": "A3", "state": "playing"}, "партия идёт"],
		[{"code": "A4", "state": "lobby"}, "игроки в сборе"],
	]
	for c in cases:
		net.park_room(c[0])
		lobby.call("_refresh_stuck")
		(menu as Control).call("_refresh_online_note")
		for i in range(2):
			await process_frame
		var banner := ((lobby.get("_stuck_label") as Label).text as String)
		var note := ((menu.get("_online_note") as Label).text as String)
		if banner.find(c[1]) < 0:
			_fail("баннер врёт: «%s» без «%s»" % [banner.left(60), c[1]])
		if note.find(c[1]) < 0:
			_fail("напоминание врёт: «%s» без «%s»" % [note.left(60), c[1]])


## Автообновление списка комнат: тикает раз в 10 с, сам не стартует,
## вне комнатной страницы молча ничего не делает (без сети в тесте —
## просто возвращается).
func _rooms_timer_check(lobby: Node) -> void:
	var timer := lobby.get("_rooms_timer") as Timer
	if timer == null:
		_fail("нет таймера обновления комнат")
		return
	if not is_equal_approx(timer.wait_time, 10.0):
		_fail("таймер комнат не 10 с (%.1f)" % timer.wait_time)
	if timer.autostart:
		_fail("таймер комнат стартует сам")
	lobby.call("_on_rooms_tick")
	for i in range(2):
		await process_frame


## Быстрый матч без очередей: из публичных комнат с людьми берём самую
## полную, иначе — пусто (будем создавать свою). Пароли и пустые мимо.
func _quick_pick(lobby: Node) -> void:
	lobby.set("_rooms", [
		{"code": "P1", "hasPassword": true, "filled": 3, "state": "lobby"},
		{"code": "E1", "hasPassword": false, "filled": 0, "state": "lobby"},
		{"code": "A2", "hasPassword": false, "filled": 2, "state": "lobby"},
		{"code": "B4", "hasPassword": false, "filled": 4, "state": "playing"},
	])
	var best: Dictionary = lobby.call("_pick_quick_room")
	if String(best.get("code", "")) != "B4":
		_fail("быстрый матч взял не самую полную (%s)" % String(best.get("code", "?")))
	lobby.set("_rooms", [
		{"code": "P1", "hasPassword": true, "filled": 3, "state": "lobby"},
		{"code": "E1", "hasPassword": false, "filled": 0, "state": "lobby"},
	])
	best = lobby.call("_pick_quick_room")
	if not best.is_empty():
		_fail("быстрый матч взял комнату без людей/с паролем")


## У кнопки есть подпись, минимум покрывает её целиком, а раскладка
## выдала не полоску: ширина 8 px при clip_text — это и была жалоба.
## Минимум проверяем только в строке: в столбике он специально нулевой
## (кнопка тянется на всю ширину), там смотрит проверка ширины.
func _button_text(b: Button, key: String, row: BoxContainer) -> void:
	if b == null:
		_fail("нет кнопки " + key)
		return
	if b.text.is_empty():
		_fail("у кнопки %s пустая подпись" % key)
		return
	var font: Font = b.get_theme_font("font")
	var want := 0.0
	if font != null:
		want = font.get_string_size(b.text, HORIZONTAL_ALIGNMENT_LEFT, -1,
			b.get_theme_font_size("font_size")).x
	var sb := b.get_theme_stylebox("normal")
	if sb != null:
		want += sb.content_margin_left + sb.content_margin_right
	if (row == null or not row.vertical) \
			and b.get_combined_minimum_size().x + 1.0 < want:
		_fail("кнопка «%s»: минимум %.0f не покрывает текст %.0f"
			% [b.text, b.get_combined_minimum_size().x, want])
	if b.size.x < 40.0:
		_fail("кнопка «%s» сжата до %.0f px — текст не виден" % [b.text, b.size.x])


## Честная ширина содержимого — зеркало лоббийного _need: кнопки
## с clip_text и пустые поля меряем по тексту/подсказке.
func _need_width(c: Control) -> float:
	var base := c.get_combined_minimum_size().x
	var sample := ""
	if c is LineEdit:
		var e := c as LineEdit
		sample = e.text if not e.text.is_empty() else e.placeholder_text
	elif c is Button and not (c is OptionButton):
		sample = (c as Button).text
	if sample.is_empty():
		return base
	var font: Font = c.get_theme_font("font")
	var w := 0.0
	if font != null:
		w = font.get_string_size(sample, HORIZONTAL_ALIGNMENT_LEFT, -1,
			c.get_theme_font_size("font_size")).x
	var sb := c.get_theme_stylebox("normal")
	if sb != null:
		w += sb.content_margin_left + sb.content_margin_right
	else:
		w += 16.0
	return maxf(base, w)


# ---------------------------------------------------------------- край

## Ни один видимый узел страницы не должен вылезать за поле вьюпорта.
func _edge(node: Node, name: String) -> void:
	var c := node as Control
	if c == null or not c.is_visible_in_tree():
		return
	var width := root.get_visible_rect().size.x
	var rect := c.get_global_rect()
	if rect.end.x > width + 1.0:
		_bad.append("%s | %s «%s» ушёл вправо на %.0f (вьюпорт %d)"
			% [_ctx, name, _caption(c), rect.end.x - width, int(width)])
	elif rect.position.x < -1.0:
		_bad.append("%s | %s «%s» ушёл влево на %.0f"
			% [_ctx, name, _caption(c), -rect.position.x])
	for child in c.get_children():
		if child is Control:
			_edge(child, name)


# ---------------------------------------------------------------- мелочи

func _find_button(node: Node, text: String) -> Button:
	if node is Button and (node as Button).text == text:
		return node as Button
	for child in node.get_children():
		var found := _find_button(child, text)
		if found != null:
			return found
	return null


func _caption(c: Control) -> String:
	if c is Label:
		return (c as Label).text.substr(0, 24)
	if c is Button:
		return (c as Button).text.substr(0, 24)
	if c is LineEdit:
		return (c as LineEdit).placeholder_text.substr(0, 24)
	return c.get_class()


func _fail(text: String) -> void:
	fails += 1
	_bad.append("%s | %s" % [_ctx, text])
