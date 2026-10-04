class_name TileView
extends Panel
const Lang := preload("res://scripts/core/lang.gd")

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
	var tile_base := int(round(ts.y * 0.4))
	var fsize := clampi(Settings.fs(tile_base), 8, int((ts.x - 6.0) * 0.82))
	var label := Label.new()
	label.text = Lang.t("★") if tile.is_joker else str(tile.value)
	label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	label.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	label.add_theme_font_size_override("font_size", fsize)
	label.add_theme_color_override("font_color", Color.WHITE)
	label.add_theme_color_override("font_outline_color", Color(0, 0, 0, 0.5))
	label.add_theme_constant_override("outline_size", maxi(2, int(fsize / 6)))
	add_child(label)

	if tile.is_joker:
		tooltip_text = Lang.t("Джокер — заменяет любое число любого цвета")
	else:
		tooltip_text = "%s %d" % [Tile.color_name(tile.color), tile.value]
	base_alpha = modulate.a

	queue_redraw()

## Галочка свежей своей фишки (взята из колоды / только что выложена) —
## в правом верхнем углу, чуть выходя за карточку. Кольцо + галочка
## штрихами, а не глиф «✓»: от шрифта устройства не зависит. Белый кружок
## с тёмным ободком читается на любом цвете, зелёная галочка — в тон
## остальным меткам. Сочетается с любой рамкой (черновик, прошлый ход,
## подсказка).
func _draw_badge() -> void:
	var ts := Settings.tile_size()
	var r := ts.y * 0.13
	var c := Vector2(ts.x - 1.0, 1.0)
	draw_circle(c, r, Color(0, 0, 0, 0.85))
	draw_circle(c, r * 0.78, Color(1, 1, 1, 0.96))
	var p1 := c + Vector2(-0.42 * r, 0.04 * r)
	var p2 := c + Vector2(-0.08 * r, 0.32 * r)
	var p3 := c + Vector2(0.46 * r, -0.30 * r)
	draw_polyline(PackedVector2Array([p1, p2, p3]), Color("2E9E5B"),
		maxf(2.5, r * 0.26), true)

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
	# Свежие свои: взятая из колоды и только что выложенные (черновик —
	# прозрачность и зелёная рамка при этом остаются как были).
	if mark_drawn or mark_draft:
		_draw_badge()

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
	set_drag_preview(wrapper)
	modulate = Color(0.55, 0.55, 0.55, 0.55)
	if controller.has_method("on_drag_started"):
		controller.on_drag_started(self)
	return data

func _can_drop_data(_pos: Vector2, data: Variant) -> bool:
	if controller == null or not (data is Dictionary):
		return false
	return controller.gui_can_drop(data, get_global_mouse_position())

func _drop_data(_pos: Vector2, data: Variant) -> void:
	if controller != null and data is Dictionary:
		controller.gui_do_drop(data, get_global_mouse_position())
