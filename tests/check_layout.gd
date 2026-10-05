extends SceneTree

# ==============================================================
#  Размеры и видимость сетевого меню.
#
#  Симптом, ради которого написан тест: по кнопке «Играть с другими»
#  открывается пустой тёмно-синий экран. Тёмно-синий — это фон
#  наложения (ColorRect 12151C), то есть наложение рисуется, а
#  содержимое поверх него — нет. Либо у содержимого нулевой размер,
#  либо оно спрятано.
#
#  Тест не гадает, а меряет: строит меню, нажимает кнопку, обходит
#  дерево и для каждого Control печатает размер и минимальный размер,
#  отдельно отмечая нули. Ноль — всегда ошибка, если узел виден и
#  пользователь должен его видеть.
#
#     godot --headless --path . --script res://tests/check_layout.gd
# ==============================================================

var _zero: Array = []
var _rows: Array = []


func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	# Меряем в том размере, в каком играет человек, а не в том, какое
	# headless-окно оказалось по умолчанию: при 1024×1024 всё влезает,
	# а настоящее окно 576×1024 — узкое, и именно там вёрстка ломается.
	root.size = Vector2i(576, 1024)
	var packed: PackedScene = load("res://scenes/main_menu.tscn")
	if packed == null:
		print("НЕ ЧИТАЕТСЯ main_menu.tscn")
		quit(1)
		return
	var menu := packed.instantiate()
	root.add_child(menu)
	# Разметке нужно два кадра: первый — на построение, второй — на
	# пересчёт контейнеров, которые считают размеры по часам.
	await process_frame
	await process_frame
	await process_frame

	print("== ГЛАВНОЕ МЕНЮ (окно %dx%d) ==" % [root.size.x, root.size.y])
	_measure(menu, "")

	# Жмём ту же кнопку, что и игрок.
	print("\n== ПОСЛЕ НАЖАТИЯ «ИГРАТЬ ПО СЕТИ» ==")
	_zero.clear()
	var btn := _find_button(menu, "Играть с другими")
	if btn == null:
		print("  кнопки «Играть с другими» нет — тест бессмыслен")
		quit(1)
		return
	btn.pressed.emit()
	await process_frame
	await process_frame

	var lobby: Node = menu.get("online_lobby")
	if lobby == null:
		print("  сетевое меню не появилось в дереве")
		quit(1)
		return
	if not (lobby is Control):
		print("  сетевое меню — не Control: %s" % lobby.get_class())
		quit(1)
		return
	print("  сетевое меню: %s, visible=%s, размер=%s"
		% [lobby.get_class(), str((lobby as Control).visible),
			str((lobby as Control).size)])

	# Три страницы по очереди. Пока страница скрыта, контейнер её не
	# раскладывает, и размеры её детей — вчерашние: мерить скрытое
	# бессмысленно. Плюс это ровно то, что видит игрок: он листает
	# «Вход» -> «Комнаты» -> «Ожидание».
	for step in ["_page_auth", "_page_rooms", "_page_lobby"]:
		var page: Node = lobby.get(step)
		if page == null:
			print("  %s нет — тест бессмыслен" % step)
			quit(1)
			return
		lobby.call("_set_page", page)
		await process_frame
		await process_frame
		print("  --- страница %s, %s ---"
			% [step, "видна" if (page as Control).visible else "СКРЫТА (а должна быть видна)"])
		_measure(page, "lobby")

	_report()


# ------------------------------------------------------------------ обход

func _measure(node: Node, prefix: String) -> void:
	for child in node.get_children():
		if child is Control:
			_report_control(child as Control, prefix)
		if child.get_child_count() > 0:
			_measure(child, prefix + "/" + child.name)


func _report_control(c: Control, prefix: String) -> void:
	var path := prefix + "/" + c.name
	var kind := c.get_class()
	if c is Label and not (c as Label).text.is_empty():
		kind += " «%s»" % (c as Label).text.substr(0, 24)
	elif c is Button:
		kind += " «%s»" % (c as Button).text.substr(0, 24)
	elif c is LineEdit:
		kind += " «%s»" % (c as LineEdit).placeholder_text
	var min_s: Vector2 = c.get_combined_minimum_size()
	print("  %-46s %-34s size=%-16s min=%-16s vis=%s"
		% [path.substr(path.length() - 46), kind,
			str(c.size), str(min_s), str(c.visible)])
	# Пустой контейнер без детей — законно схлопнувшийся, это не поломка.
	# Но если детей нет, а высота нулевая у НЕ пустого узла — дефект.
	if not c.visible or c.get_child_count() > 0:
		return
	if c.size.x > 0.5 and c.size.y > 0.5:
		return
	_zero.append("%s (%s) size=%s min=%s" % [path, kind, str(c.size), str(min_s)])



# ------------------------------------------------------------------ поиск

func _find_button(node: Node, text: String) -> Button:
	for child in node.get_children():
		if child is Button and (child as Button).text == text:
			return child as Button
		var found := _find_button(child, text)
		if found != null:
			return found
	return null


# ------------------------------------------------------------------ итог

func _report() -> void:
	print("")
	if _zero.is_empty():
		print("РАЗМЕРЫ В ПОРЯДКЕ: нулевых видимых узлов нет")
		quit(0)
		return
	print("НУЛЕВЫЕ РАЗМЕРЫ У ВИДИМЫХ УЗЛОВ (%d):" % _zero.size())
	for line in _zero:
		print("  " + line)
	quit(1)
