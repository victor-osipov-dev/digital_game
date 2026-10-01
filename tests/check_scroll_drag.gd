extends SceneTree

# ==============================================================
#  Листание, начатое на кнопке/чекбоксе/поле ввода (ScrollDrag).
#
#  Проверяем три обещания на главном меню:
#   1) короткий тап по контролу доходит до нативного GUI (чекбокс
#      переключается, поле ввода получает фокус) — жест разбирается
#      до контролов и отыгрывается событиями press+release;
#   2) зажатие и волочение пальца по тому же контролу прокручивает
#      страницу — и не щёлкает контроль (палец хотел листать);
#   3) после драга контрол остаётся рабочим: следующий тап кликает.
#
#  godot --headless --path . --script res://tests/check_scroll_drag.gd
# ==============================================================

var fails := 0


func check(cond: bool, msg: String) -> void:
	if cond:
		print("  ok  " + msg)
	else:
		fails += 1
		printerr("FAIL  " + msg)


func _initialize() -> void:
	process_frame.connect(_boot, CONNECT_ONE_SHOT)


func _boot() -> void:
	var settings := root.get_node_or_null("Settings")
	if settings == null:
		printerr("FAIL  Settings autoload missing")
		quit(1)
		return
	settings.load_settings()
	var saved_scale: int = settings.text_scale
	var saved_req: bool = settings.require_30
	settings.text_scale = 1

	root.size = Vector2i(576, 1024)
	var packed := load("res://scenes/main_menu.tscn") as PackedScene
	if packed == null:
		check(false, "main_menu.tscn читается")
		quit(1)
		return
	var menu := packed.instantiate()
	root.add_child(menu)
	for i in range(4):
		await process_frame

	var scroll: ScrollContainer = menu.get("menu_scroll")
	check(scroll != null, "menu_scroll собран")

	# --- 1) тап по чекбоксу: отыгрышь доходит до GUI -------------------
	var cb: CheckBox = menu.get("check_30")
	check(cb != null, "чекбокс «Первый ход» есть")
	if cb != null:
		var hits := [0]
		cb.pressed.connect(func(): hits[0] += 1)
		var was := cb.button_pressed
		await _tap(cb.get_global_rect().get_center())
		check(hits[0] == 1, "тап по чекбоксу кликает (hits=%d)" % hits[0])
		check(cb.button_pressed != was, "чекбокс переключился")

		# --- 2) узкое окно: меню обязано листаться ----------------------
		# CenterContainer всегда даёт ребёнку его минимум, поэтому
		# сжатие узкого окна в _sync_scroll_min сводится именно к
		# ограничению custom_minimum_size — повторяем тот же приём.
		scroll.custom_minimum_size = Vector2(scroll.custom_minimum_size.x, 300.0)
		await process_frame
		scroll.scroll_vertical = 999999
		var max_scroll := scroll.scroll_vertical
		check(max_scroll > 0, "меню листается при сжатой высоте (max=%d)" % max_scroll)
		# Кадр обязателен: без него rect'ы контролов ещё не пересчитаны
		# под новое положение прокрутки, и центрирование считает по старым
		# координатам.
		await process_frame

		# --- 3) драг с чекбокса: страница едет, клик подавлен -----------
		_center_in(scroll, cb)
		await process_frame
		var before := scroll.scroll_vertical
		var hits_before: int = hits[0]
		var state_before := cb.button_pressed
		var c := cb.get_global_rect().get_center()
		_press(c)
		_motion(c + Vector2(0, 45))
		_motion(c + Vector2(0, 60))
		_release(c + Vector2(0, 60))
		for i in range(2):
			await process_frame
		check(scroll.scroll_vertical < before,
			"драг с чекбокса прокрутил меню (%d → %d)" % [before, scroll.scroll_vertical])
		check(hits[0] == hits_before, "после драга клик подавлен (hits=%d)" % hits[0])
		check(cb.button_pressed == state_before, "чекбокс от драга не дёрнулся")

		# --- 4) после драга контрол рабочий -----------------------------
		_center_in(scroll, cb)
		await process_frame
		await _tap(cb.get_global_rect().get_center())
		check(hits[0] == hits_before + 1, "следующий тап после драга кликает (hits=%d)" % hits[0])

	# --- 5) поле ввода: тап ставит фокус -------------------------------
	var edit := _find_edit(menu)
	check(edit != null, "поле ввода (имя игрока) есть")
	if edit != null and scroll != null:
		_center_in(scroll, edit)
		await process_frame
		await _tap(edit.get_global_rect().get_center())
		check(edit.has_focus(), "тап по полю ввода ставит фокус")

		# --- 6) драг с поля ввода листает страницу ----------------------
		var before2 := scroll.scroll_vertical
		var c2 := edit.get_global_rect().get_center()
		_press(c2)
		_motion(c2 + Vector2(0, -45))
		_motion(c2 + Vector2(0, -60))
		_release(c2 + Vector2(0, -60))
		for i in range(2):
			await process_frame
		check(scroll.scroll_vertical > before2,
			"драг с поля ввода прокрутил меню (%d → %d)" % [before2, scroll.scroll_vertical])

	# Настройки возвращаем как были: тап по чекбоксу пишет конфиг.
	settings.require_30 = saved_req
	settings.text_scale = saved_scale
	settings.save_settings()

	if fails == 0:
		print("SCROLLDRAG CHECK PASSED")
		quit(0)
	else:
		printerr("SCROLLDRAG CHECK: %d FAILED" % fails)
		quit(1)


# ---------------------------------------------------------------- жесты

func _tap(pos: Vector2) -> void:
	_press(pos)
	_release(pos)
	# Отложенная отыгрышь тапа (call_deferred) успевает выполниться.
	for i in range(2):
		await process_frame


func _press(pos: Vector2) -> void:
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = true
	ev.position = pos
	ev.global_position = pos
	ev.button_mask = MOUSE_BUTTON_MASK_LEFT
	root.push_input(ev)


func _release(pos: Vector2) -> void:
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = false
	ev.position = pos
	ev.global_position = pos
	root.push_input(ev)


func _motion(pos: Vector2) -> void:
	var ev := InputEventMouseMotion.new()
	ev.position = pos
	ev.global_position = pos
	ev.button_mask = MOUSE_BUTTON_MASK_LEFT
	root.push_input(ev)


# ---------------------------------------------------------------- поиск

func _find_edit(node: Node) -> LineEdit:
	# Только видимые: лобби и наложения в дереве есть, но скрыты.
	if node is LineEdit and (node as Control).is_visible_in_tree():
		return node as LineEdit
	for child in node.get_children():
		var found := _find_edit(child)
		if found != null:
			return found
	return null


# Ставит контроль в середину видимой части скролла (для честного
# тапа: нативная часть отыгрышь ищет контрол по координатам окна).
func _center_in(scroll: ScrollContainer, c: Control) -> void:
	var sc := scroll.get_global_rect()
	var content_y := c.get_global_rect().position.y - sc.position.y \
		+ scroll.scroll_vertical
	var target := content_y + c.get_size().y / 2.0 - sc.size.y / 2.0
	scroll.scroll_vertical = target
