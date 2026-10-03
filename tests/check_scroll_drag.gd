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
#   4) в растянутом окне (телефон 1080x2400 при базе 576x1024) тап
#      доходит именно до того контрола, по которому пришёл: отыгрыш
#      отдаёт координату вьюпорта, и растяжение не должно уводить
#      точку на 445 пикселей выше, в соседний чекбокс.
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
	# События шлём через Input.parse_input_event — как реальный ввод: так
	# get_global_mouse_position() в ScrollDrag не отстаёт от события
	# (push_input минует Input и координату не обновляет). Без аккумуляции
	# движения не склеиваются в одно событие — пороги и сдвиги точные.
	Input.set_use_accumulated_input(false)

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
	var hits := [0]

	# --- 1) тап по чекбоксу: отыгрышь доходит до GUI -------------------
	var cb: CheckBox = menu.get("check_30")
	check(cb != null, "чекбокс «Первый ход» есть")
	if cb != null:
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

	# --- 7) тап пальцем (ScreenTouch) тоже кликает ---------------------
	if cb != null and scroll != null:
		_center_in(scroll, cb)
		await process_frame
		var h3: int = hits[0]
		var was3 := cb.button_pressed
		var p3 := cb.get_global_rect().get_center()
		_touch_press(p3)
		_touch_release(p3)
		for i in range(2):
			await process_frame
		check(hits[0] == h3 + 1, "тап пальцем по чекбоксу кликает (hits=%d)" % hits[0])
		check(cb.button_pressed != was3, "чекбокс от тач-тапа переключился")

		# --- 8) драг пальцем (ScreenDrag) листает, клик подавлен --------
		_center_in(scroll, cb)
		scroll.scroll_vertical = maxi(0, scroll.scroll_vertical - 40)
		await process_frame
		var b3 := scroll.scroll_vertical
		var h4: int = hits[0]
		var s4 := cb.button_pressed
		var p4 := cb.get_global_rect().get_center()
		_touch_press(p4)
		_touch_drag(p4, p4 + Vector2(0, -45))
		_touch_drag(p4 + Vector2(0, -45), p4 + Vector2(0, -60))
		_touch_release(p4 + Vector2(0, -60))
		for i in range(2):
			await process_frame
		check(scroll.scroll_vertical > b3,
			"драг пальцем прокрутил меню (%d → %d)" % [b3, scroll.scroll_vertical])
		check(hits[0] == h4, "после тач-драга клик подавлен (hits=%d)" % hits[0])
		check(cb.button_pressed == s4, "чекбокс от тач-драга не дёрнулся")

		# --- 9) тач и эмуляция мыши — один жест, один сдвиг -------------
		# На телефоне касание приходит двумя потоками (ScreenTouch/ScreenDrag
		# и эмуляция мыши). Двигаем оба: прокрутка обязана сдвинуться ровно
		# один раз, дубликат от мыши — проигнорирован.
		_center_in(scroll, cb)
		scroll.scroll_vertical = maxi(0, scroll.scroll_vertical - 40)
		await process_frame
		var b4 := scroll.scroll_vertical
		var h5: int = hits[0]
		var p5 := cb.get_global_rect().get_center()
		_touch_press(p5)
		_press(p5)
		_touch_drag(p5, p5 + Vector2(0, -20))
		_touch_drag(p5 + Vector2(0, -20), p5 + Vector2(0, -30))
		_touch_release(p5 + Vector2(0, -30))
		_release(p5 + Vector2(0, -30))
		for i in range(2):
			await process_frame
		check(scroll.scroll_vertical == b4 + 10,
			"тач+мышь: сдвиг один (%d → %d, ждали %d)" % [b4, scroll.scroll_vertical, b4 + 10])
		check(hits[0] == h5, "дубль потоков не нажал чекбокс (hits=%d)" % hits[0])

	# --- 10) растянутое окно: тап не уезжает в соседний контрол -----
	# На телефоне окно 1080x2400 при базе 576x1024, коэффициент 1.875.
	# Отыгрыш тапа отдаёт координату вьюпорта, и push_input обязан
	# принять её как локальную — иначе точка делится на коэффициент,
	# тап по нижней кнопке попадает в чекбокс над ней (на телефоне
	# «Статистика» переключала «Первый ход: минимум 30 очков»).
	# Проверка последняя: смена размера окна пересобирает раскладку.
	if cb != null and scroll != null:
		var stats := _find_button(menu, "Статистика")
		check(stats != null, "кнопка «Статистика» есть")
		if stats != null:
			root.size = Vector2i(1080, 2400)
			scroll.custom_minimum_size = Vector2(scroll.custom_minimum_size.x, 300.0)
			for i in range(4):
				await process_frame
			_center_in(scroll, stats)
			await process_frame
			var stats_hits := [0]
			var other_hits: Array = []
			for b in _find_buttons(menu):
				var who: Button = b
				b.pressed.connect(func():
					if who == stats:
						stats_hits[0] += 1
					else:
						other_hits.append(who.text))
			var was_cb := cb.button_pressed
			await _tap(stats.get_global_rect().get_center())
			check(stats_hits[0] == 1,
				"в растянутом окне тап по «Статистика» кликает её (hits=%d)"
					% stats_hits[0])
			check(other_hits.is_empty(),
				"в растянутом окне тап не задел соседние кнопки (%s)"
					% str(other_hits))
			check(cb.button_pressed == was_cb,
				"в растянутом окне тап не переключил чекбокс «Первый ход»")
		root.size = Vector2i(576, 1024)
		for i in range(3):
			await process_frame

	# --- 11) повторный клик по открытому списку закрывает его -------
	# Проверяем логику кнопки в том же порядке, что у живого клика:
	# button_down (снимок видимости) → показ списка → pressed.
	# Свежее открытие своим же кликом не закрывается, а повторный клик
	# по открытому списку — закрывает.
	var opt: OptionButton = menu.get("count_option")
	check(opt != null, "опция «Игроков» есть")
	if opt != null:
		var popup = opt.get_popup()
		popup.hide()
		await process_frame
		check(not popup.visible, "список изначально закрыт")
		opt.button_down.emit()
		popup.show()
		await process_frame
		opt.pressed.emit()
		await process_frame
		await process_frame
		check(popup.visible, "свежее открытие не закрывается своим же кликом")
		opt.button_down.emit()
		opt.pressed.emit()
		await process_frame
		await process_frame
		check(not popup.visible, "повторный клик закрывает список")
		popup.hide()

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


# Жесты задаём в координатах вьюпорта (как get_global_rect()), а
# parse_input_event ждёт координаты ОКНА — движок сам делит их на
# коэффициент растяжения. На телефоне так же: OS отдаёт 540x1895,
# событие приходит с (288, 953). Переводим, иначе в растянутом окне
# тест бьёт мимо всех контролов.
func _to_window(pos: Vector2) -> Vector2:
	var base := root.content_scale_size
	var win := Vector2(root.size)
	if base.x <= 0 or base.y <= 0:
		return pos
	# При aspect=expand масштаб единый для обеих осей (меньшее из двух
	# отношений), иначе вьюпорт вытягивается по широкой стороне: 1080x2400
	# при базе 576x1024 даёт коэффициент 1.875, а не 2.34 по вертикали.
	var k := minf(win.x / base.x, win.y / base.y)
	return pos * k


func _press(pos: Vector2) -> void:
	var w := _to_window(pos)
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = true
	ev.position = w
	ev.global_position = w
	ev.button_mask = MOUSE_BUTTON_MASK_LEFT
	Input.parse_input_event(ev)


func _release(pos: Vector2) -> void:
	var w := _to_window(pos)
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = false
	ev.position = w
	ev.global_position = w
	Input.parse_input_event(ev)


func _motion(pos: Vector2) -> void:
	var w := _to_window(pos)
	var ev := InputEventMouseMotion.new()
	ev.position = w
	ev.global_position = w
	ev.button_mask = MOUSE_BUTTON_MASK_LEFT
	Input.parse_input_event(ev)


func _touch_press(pos: Vector2) -> void:
	var ev := InputEventScreenTouch.new()
	ev.index = 0
	ev.pressed = true
	ev.position = _to_window(pos)
	Input.parse_input_event(ev)


func _touch_release(pos: Vector2) -> void:
	var ev := InputEventScreenTouch.new()
	ev.index = 0
	ev.pressed = false
	ev.position = _to_window(pos)
	Input.parse_input_event(ev)


func _touch_drag(frm: Vector2, to: Vector2) -> void:
	var wf := _to_window(frm)
	var wt := _to_window(to)
	var ev := InputEventScreenDrag.new()
	ev.index = 0
	ev.position = wt
	ev.relative = wt - wf
	Input.parse_input_event(ev)


# ---------------------------------------------------------------- поиск

# Кнопка с текстом (для проверки попадания отыгрыша в растянутом окне).
func _find_button(node: Node, text: String) -> Button:
	var b := node as Button
	if b != null and b.text == text and b.is_visible_in_tree():
		return b
	for child in node.get_children():
		var found := _find_button(child, text)
		if found != null:
			return found
	return null


# Все видимые кнопки — чтобы увидеть, кому вообще ушёл тап.
func _find_buttons(node: Node) -> Array:
	var out: Array = []
	var b := node as Button
	if b != null and b.is_visible_in_tree():
		out.append(b)
	for child in node.get_children():
		out.append_array(_find_buttons(child))
	return out


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
