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
		# Считаем по минимальным ширинам — тем же, что и движок.
		var need := 0.0
		var first := true
		for item in box.get_children():
			var c := item as Control
			if c == null or not c.visible:
				continue
			need += c.get_combined_minimum_size().x
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
