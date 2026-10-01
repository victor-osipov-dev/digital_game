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
## Вызывается из _input сцены и возвращает true, если событие поглощено.

## Сколько пикселей должна пройти рука, прежде чем жест станет прокруткой.
const DRAG_THRESHOLD := 10.0

var _pressed := false
var _moved := false
var _ctrl: Control = null
var _scroll: ScrollContainer = null
var _from := Vector2.ZERO
var _prev := Vector2.ZERO
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
				consumed = _begin(host, mb.position)
			else:
				consumed = _finish()
	elif event is InputEventMouseMotion and _pressed:
		var mm := event as InputEventMouseMotion
		if (mm.button_mask & MOUSE_BUTTON_MASK_LEFT) == 0:
			# Кнопку отпустили вне окна — жест бросаем, тап не засчитываем.
			_drop()
		else:
			consumed = _drag(mm.position)
	if consumed:
		host.get_viewport().set_input_as_handled()
	return consumed


func _begin(host: Node, pos: Vector2) -> bool:
	# Новое касание отменяет непрошедший отложенный тап: его доставим
	# своим кадром, чтобы не склеивать два жеста.
	_replay_pending = false
	if _pressed:
		_drop()
	var ctrl := _hit(host.get_viewport(), pos)
	if ctrl == null or not ScrollFix.keeps(ctrl):
		return false
	var scroll := _scroll_parent(ctrl)
	if scroll == null:
		return false
	_pressed = true
	_moved = false
	_ctrl = ctrl
	_scroll = scroll
	_from = pos
	_prev = pos
	return true


func _drag(pos: Vector2) -> bool:
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
