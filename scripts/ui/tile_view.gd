class_name TileView
extends Panel
const Lang := preload("res://scripts/core/lang.gd")
const BadgeDot := preload("res://scripts/ui/badge_dot.gd")

var tile: Tile = null
var draggable: bool = false
var src_kind: String = ""
var src_row_id: int = 0
var controller: Object = null
var mark_last: bool = false
var mark_draft: bool = false
var mark_hint: bool = false
var mark_drawn: bool = false
var face_down: bool = false
## Подписчик-бейдж свежей фишки (белый кружок + галочка). Живёт отдельным
## top_level-контролом: поверх рядов, без прозрачности фишки.
var _badge: Control = null
## Итоговая прозрачность по меткам: прилёт анимирует modulate, и если
## два прилёта наложатся, второй обязан целиться сюда, а не в текущий
## (уже обнулённый первым) modulate — иначе фишка гаснет навсегда.
var base_alpha := 1.0

static func make(p_tile: Tile, p_draggable: bool, p_controller: Object, p_face_down: bool = false) -> TileView:
	var view := TileView.new()
	view.tile = p_tile
	view.draggable = p_draggable
	view.controller = p_controller
	view.face_down = p_face_down
	view._build()
	return view

func _build() -> void:
	var ts := Settings.tile_size()
	custom_minimum_size = ts
	size = ts
	mouse_filter = Control.MOUSE_FILTER_STOP

	var bw := clampi(int(ts.x * 0.05), 1, 3)
	var sb := StyleBoxFlat.new()
	sb.set_corner_radius_all(clampi(int(ts.x * 0.14), 3, 12))

	if face_down:
		sb.bg_color = Color("2B3140")
		sb.border_color = Color(1, 1, 1, 0.3)
		sb.set_border_width_all(maxi(bw, 2))
		add_theme_stylebox_override("panel", sb)
		tooltip_text = ""
		queue_redraw()
		return

	var marks := {}
	if controller != null and controller.has_method("get_tile_marks"):
		marks = controller.get_tile_marks(tile.id)
	mark_last = bool(marks.get("last", false))
	mark_draft = bool(marks.get("draft", false))
	mark_hint = bool(marks.get("hint", false))
	mark_drawn = bool(marks.get("drawn", false))

	sb.bg_color = Color(Tile.color_hex(tile.color))
	if mark_hint:
		sb.border_color = Color("FFFFFF")
		sb.set_border_width_all(maxi(bw + 2, 5))
	elif mark_draft:
		# Живой черновик — прозрачный с жирной зелёной рамкой: ход
		# ещё не принят, его можно откатить.
		sb.border_color = Color("43A047")
		sb.set_border_width_all(maxi(bw + 3, 5))
		modulate = Color(1, 1, 1, 0.72)
	elif mark_last:
		# Принятый прошлый ход — обычный, только обведён зелёным:
		# прозрачность гаснет в момент коммита.
		sb.border_color = Color("43A047")
		sb.set_border_width_all(maxi(bw + 3, 5))
	else:
		sb.border_color = Color(1, 1, 1, 0.35 if tile.is_joker else 0.18)
		sb.set_border_width_all(maxi(bw, 2) if tile.is_joker else bw)
	add_theme_stylebox_override("panel", sb)

	# Число масштабируется и по фишке, и по шкале текста, но потолок —
	# сама фишка: шире карточки цифра быть не может ни при какой
	# настройке (0.82 оставляет запас под самый широкий глиф «88»).
	# У джокера цифры нет: вместо неё звезда рисуется полигоном в _draw
	# (глифа «звёздочка» нет во встроенном шрифте Web-сборки — был тофу).
	if tile.is_joker:
		tooltip_text = Lang.t("Джокер — заменяет любое число любого цвета")
	else:
		var tile_base := int(round(ts.y * 0.4))
		var fsize := clampi(Settings.fs(tile_base), 8, int((ts.x - 6.0) * 0.82))
		var label := Label.new()
		label.text = str(tile.value)
		label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
		label.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
		label.mouse_filter = Control.MOUSE_FILTER_IGNORE
		label.add_theme_font_size_override("font_size", fsize)
		label.add_theme_color_override("font_color", Color.WHITE)
		label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.5))
		label.add_theme_constant_override("outline_size", maxi(2, int(fsize / 6)))
		add_child(label)
		tooltip_text = "%s %d" % [Tile.color_name(tile.color), tile.value]
	base_alpha = modulate.a

	_build_badge()
	set_process(false)
	queue_redraw()


## Подписчик-бейдж галочки свежей своей фишки (взята из колоды / только
## что выложена) — в правом верхнем углу, чуть выходя за карточку.
## Отдельный top_level-контрол: рисуется поверх соседних рядов (кружок
## не обрезается) и не берёт прозрачность фишки. Белый кружок без тёмной
## обводки + зелёная галочка штрихами (глифа нет в шрифте Web-сборки).
func _build_badge() -> void:
	if _badge != null:
		_badge.free()
	var ts := Settings.tile_size()
	var r := ts.y * 0.13
	_badge = BadgeDot.new()
	_badge.size = Vector2(r * 2.0, r * 2.0)
	_badge.visible = false
	add_child(_badge)
	_badge.queue_redraw()
	_sync_badge()


func _enter_tree() -> void:
	_sync_badge()


func _notification(what: int) -> void:
	if what == NOTIFICATION_VISIBILITY_CHANGED:
		_sync_badge()


func _process(_delta: float) -> void:
	_sync_badge()


## Угол фишки + видимость бейджа. _process включён, только пока бейдж
## нужен (метки immutable после сборки — иначе сотни фишек тикали бы
## зря). Под модалками (победа, подтверждение) бейдж прячем: он рисуется
## поверх всего и торчал бы над диалогом.
func _sync_badge() -> void:
	if _badge == null or not is_inside_tree():
		return
	var show := (mark_drawn or mark_draft) and not face_down \
		and is_visible_in_tree() and not _modal_up()
	(_badge as Control).visible = show
	set_process(show)
	if not show:
		return
	var ts := Settings.tile_size()
	var r := ts.y * 0.13
	(_badge as Control).position = get_global_rect().position \
		+ Vector2(size.x - 1.0 - r, 1.0 - r)


func _modal_up() -> bool:
	if controller != null and controller.has_method("_modal_open"):
		return bool(controller.call("_modal_open"))
	return false

func _draw() -> void:
	if face_down:
		var ts := Settings.tile_size()
		var c := ts * 0.5
		var r := minf(ts.x, ts.y) * 0.2
		draw_colored_polygon(PackedVector2Array([
			c + Vector2(0, -r), c + Vector2(r, 0),
			c + Vector2(0, r), c + Vector2(-r, 0),
		]), Color("FFD54F"))
		return
	# Бейдж свежей фишки живёт отдельным подписчиком (_badge), а не здесь:
	# иначе его обрезали бы соседние ряды и гасила прозрачность фишки.
	if tile != null and tile.is_joker:
		_draw_star()


## Внешний радиус звезды джокера под размер фишки: с обводкой (x1.14)
## диаметр занимает ~0.80 меньшей стороны — тот же запас 6 px, что у цифр
## (на самых мелких фишках 32 px иначе не влезает).
static func star_outer(ts: Vector2) -> float:
	return minf(ts.x, ts.y) * 0.35


## Вершины пятиконечной звезды (луч вверх), 10 точек: внешний/внутренний
## радиусы чередуются. Классическая пропорция 0.382.
static func star_points(c: Vector2, r_out: float) -> PackedVector2Array:
	var pts := PackedVector2Array()
	var r_in := r_out * 0.382
	for k in range(10):
		var r := r_out if k % 2 == 0 else r_in
		var a := -PI * 0.5 + float(k) * PI / 5.0
		pts.append(c + Vector2(cos(a), sin(a)) * r)
	return pts


## Звезда джокера — рисованный полигон, а не глиф: звездочки нет во
## встроенном шрифте Web-сборки (был тофу-квадрат), системного фолбэка
## там же нет. Та же техника, что у ромба рубашки выше и галочки бейджа.
func _draw_star() -> void:
	var ts := Settings.tile_size()
	var c := ts * 0.5
	var r := star_outer(ts)
	draw_colored_polygon(star_points(c, r * 1.14), Color(0, 0, 0, 0.5))
	draw_colored_polygon(star_points(c, r), Color.WHITE)

func _get_drag_data(pos: Vector2) -> Variant:
	if not draggable or tile == null or controller == null:
		return null
	var data := {
		kind="tile",
		tile_id=tile.id,
		from=src_kind,
		row_id=src_row_id,
	}
	var dup := duplicate() as Control
	dup.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var wrapper := Control.new()
	wrapper.size = size
	wrapper.mouse_filter = Control.MOUSE_FILTER_IGNORE
	wrapper.add_child(dup)
	dup.position = -pos
	(dup as TileView)._prepare_drag_dup(self)
	set_drag_preview(wrapper)
	modulate = Color(0.55, 0.55, 0.55, 0.55)
	if controller.has_method("on_drag_started"):
		controller.on_drag_started(self)
	return data

func _can_drop_data(_pos: Vector2, data: Variant) -> bool:
	if controller == null or not (data is Dictionary):
		return false
	return controller.gui_can_drop(data, get_global_mouse_position())


## Чинит дубликат для превью перетаскивания. duplicate() копирует узлы
## (подпись-цифра едет), но НЕ скриптовые поля: tile/marks дубликата —
## null/false, поэтому у звезды в превью ничего не рисовалось. Заодно
## выкидываем мёртвого подписчика-бейджа (его поля тоже не скопированы)
## и строим свежего — иначе висели бы два, один frozen.
func _prepare_drag_dup(src: TileView) -> void:
	for ch in get_children():
		if is_instance_valid(ch) and (ch as Node).get_script() == BadgeDot:
			remove_child(ch)
			ch.free()
	tile = src.tile
	face_down = src.face_down
	mark_drawn = src.mark_drawn
	mark_draft = src.mark_draft
	_build_badge()
	queue_redraw()

func _drop_data(_pos: Vector2, data: Variant) -> void:
	if controller != null and data is Dictionary:
		controller.gui_do_drop(data, get_global_mouse_position())
