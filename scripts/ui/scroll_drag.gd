class_name ScrollDrag
extends RefCounted

## Листание пальцем, начатое на кнопке, чекбоксе или поле ввода.
##
## ScrollContainer начинает жест только с того, до чего дотронулись мимо
## STOP-контролов (см. ScrollFix.relax): касание на кнопке уходит кнопке,
## движение пальца до скролла не доходит — и страница не листается. А
## кнопки внутри прокручиваемых страниц (главное меню, лобби, наложения)
## — обычное место для пальца.
##
## Жест разбираем до GUI: сцена получает _input раньше контролов, поэтому
## событие можно перехватить целиком. Правила:
##  - касание на KEEP-контроле с скролл-предком глотается;
##  - движение дальше порога превращает жест в прокрутку — клик при этом
##    подавлен: палец же хотел листать, а не нажимать;
##  - короткий тап в конце отыгрывается событиями press+release мимо
##    нашего разбора — кнопка получает привычную пару и срабатывает,
##    поле ввода получает фокус;
##  - всё остальное (карточки, ряды, drop-цели, касания без скролл-предка)
##    не трогаем: эти жесты решают сами game._input и нативный ScrollContainer.
##
## На телефоне касание приходит двумя потоками: как InputEventScreenTouch/
## ScreenDrag и как эмуляция мыши (emulate_mouse_from_touch включён по
## умолчанию). Жест ведём строго по одному потоку — тому, каким начался,
## — иначе прокрутка посчиталась бы вдвое. Координаты события сверяются
## с глобальными: пространства разошлись (событие пришло в координатах
## экрана, а контролы лежат в координатах вьюпорта) — жест ведётся по
## глобальной координате, как панорама стола в Game._input. Иначе hit по
## событию попал бы в соседнее поле ввода (они идут столбиком), и тап по
## третьему полю отыгрывался бы на первом.
##
## Вызывается из _input сцены и возвращает true, если событие поглощено.

## Сколько пикселей должна пройти рука, прежде чем жест станет прокруткой.
const DRAG_THRESHOLD := 10.0

## До какого пиксельного зазора координаты события и глобальные считаются
## одной системой (погрешность float).
const COORD_EPSILON := 0.5

var _pressed := false
var _moved := false
var _ctrl: Control = null
var _scroll: ScrollContainer = null
var _from := Vector2.ZERO
var _prev := Vector2.ZERO
var _touch_stream := false
var _use_global := false
var _replay_pending := false
var _replay_ctrl: Control = null
var _replay_from := Vector2.ZERO
var _replaying := false

## Разбор события. host — сцена, держащая _input (нужна корню дерева).
## При true событие помечается обработанным и до GUI не доходит.
func input(host: Node, event: InputEvent) -> bool:
	# Отложенная отыгрышь тапа сама порождает события: их пропускаем.
	if _replaying:
		return false
	var consumed := false
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index == MOUSE_BUTTON_LEFT:
			if mb.pressed:
				consumed = _press(host, mb.position, false)
			elif _pressed:
				consumed = _finish()
	elif event is InputEventScreenTouch:
		var st := event as InputEventScreenTouch
		if st.pressed:
			consumed = _press(host, st.position, true)
		elif _pressed:
			consumed = _finish()
	elif _pressed and event is InputEventMouseMotion and not _touch_stream:
		consumed = _drag(host, (event as InputEventMouseMotion).position)
	elif _pressed and event is InputEventScreenDrag and _touch_stream:
		consumed = _drag(host, (event as InputEventScreenDrag).position)
	if consumed:
		host.get_viewport().set_input_as_handled()
	return consumed


func _press(host: Node, pos: Vector2, from_touch: bool) -> bool:
	if _pressed:
		# Второй поток того же касания (тач и его эмуляция мыши, либо
		# второй палец): жест уже наш, дубль просто съедаем — иначе
		# перезахват сбил бы поток и прокрутка пошла бы вдвое.
		return true
	# Новое касание отменяет непрошедший отложенный тап: его доставим
	# своим кадром, чтобы не склеивать два жеста.
	_replay_pending = false
	var p := pos
	var use_global := false
	var c := host as CanvasItem
	if c != null:
		var gpos := c.get_global_mouse_position()
		if pos.distance_to(gpos) > COORD_EPSILON:
			# Пространства разошлись: событие в чужой системе координат.
			# Событию не верим — hit по нему попал бы в ДРУГОЕ поле ввода
			# (поля идут столбиком). Жест ведём по глобальной координате;
			# если она не попадает на скролл-контрол — это не наш жест
			# (та же кнопка вне скролла), оставляем нативному GUI.
			if not _valid_at(host, gpos):
				return false
			p = gpos
			use_global = true
	var ctrl := _hit(host.get_viewport(), p)
	if ctrl == null or not ScrollFix.keeps(ctrl):
		return false
	var scroll := _scroll_parent(ctrl)
	if scroll == null:
		return false
	_pressed = true
	_moved = false
	_ctrl = ctrl
	_scroll = scroll
	_touch_stream = from_touch
	_use_global = use_global
	_from = p
	_prev = p
	return true


## Попадает ли точка на KEEP-контрол внутри скролл-предка.
static func _valid_at(host: Node, p: Vector2) -> bool:
	var ctrl := _hit(host.get_viewport(), p)
	if ctrl == null or not ScrollFix.keeps(ctrl):
		return false
	return _scroll_parent(ctrl) != null


func _drag(host: Node, pos: Vector2) -> bool:
	if _use_global:
		var c := host as CanvasItem
		if c != null:
			pos = c.get_global_mouse_position()
	var total := pos - _from
	if not _moved:
		_prev = pos
		if total.length() < DRAG_THRESHOLD:
			return true
		# Порог пройден: дальше это прокрутка, а не нажатие.
		_moved = true
		return true
	var delta := pos - _prev
	_prev = pos
	if _scroll == null or not _scroll.is_visible_in_tree():
		return true
	# Скроллим по доминирующей оси; если у скролла она выключена —
	# пробуем вторую (например, вертикальная страница с горизонтальным
	# списком внутри).
	var vertical_first := absf(delta.y) >= absf(delta.x)
	if _scroll_axis(vertical_first, delta):
		return true
	_scroll_axis(not vertical_first, delta)
	return true


## Сдвигает скролл по одной оси. Возвращает false, если ось выключена.
func _scroll_axis(vertical: bool, delta: Vector2) -> bool:
	if vertical:
		if _scroll.vertical_scroll_mode == ScrollContainer.SCROLL_MODE_DISABLED:
			return false
		if is_zero_approx(delta.y):
			return false
		_scroll.scroll_vertical -= delta.y
	else:
		if _scroll.horizontal_scroll_mode == ScrollContainer.SCROLL_MODE_DISABLED:
			return false
		if is_zero_approx(delta.x):
			return false
		_scroll.scroll_horizontal -= delta.x
	return true


func _finish() -> bool:
	if not _pressed:
		return false
	var was_moved := _moved
	var ctrl := _ctrl
	var from := _from
	_drop()
	if was_moved:
		return true
	# Тап: событие мыши кнопка уже не увидит (мы его съели), поэтому
	# отыгрываем ей пару press+release — как после обычного касания.
	_replay_pending = true
	_replay_ctrl = ctrl
	_replay_from = from
	self.call_deferred("_replay")
	return true


func _replay() -> void:
	if not _replay_pending:
		return
	_replay_pending = false
	var c := _replay_ctrl
	_replay_ctrl = null
	if c == null or not is_instance_valid(c):
		return
	var vp := c.get_viewport()
	if vp == null:
		return
	var press := InputEventMouseButton.new()
	press.button_index = MOUSE_BUTTON_LEFT
	press.pressed = true
	press.position = _replay_from
	press.global_position = _replay_from
	press.button_mask = MOUSE_BUTTON_MASK_LEFT
	var release := InputEventMouseButton.new()
	release.button_index = MOUSE_BUTTON_LEFT
	release.pressed = false
	release.position = _replay_from
	release.global_position = _replay_from
	_replaying = true
	vp.push_input(press)
	vp.push_input(release)
	_replaying = false


func _drop() -> void:
	_pressed = false
	_moved = false
	_ctrl = null
	_scroll = null


## Верхний контрол под точкой — тот же порядок, что у GUI: дети
## рассматриваются в обратном порядке (поверхние первыми), игнорные
## пропускаются насквозь.
static func _hit(node: Node, pos: Vector2) -> Control:
	var kids := node.get_children()
	for i in range(kids.size() - 1, -1, -1):
		var c := kids[i] as Control
		if c == null or not c.is_visible_in_tree():
			continue
		if not c.get_global_rect().has_point(pos):
			continue
		var deeper := _hit(c, pos)
		if deeper != null:
			return deeper
		if c.mouse_filter != Control.MOUSE_FILTER_IGNORE:
			return c
	return null


static func _scroll_parent(c: Control) -> ScrollContainer:
	var p := c.get_parent()
	while p != null:
		var s := p as ScrollContainer
		if s != null:
			return s
		p = p.get_parent()
	return null
