class_name TileView
extends Panel

var tile: Tile = null
var draggable: bool = false
var src_kind: String = ""
var src_row_id: int = 0
var controller: Object = null
var mark_self: bool = false
var mark_last: bool = false
var mark_hint: bool = false
var mark_draft: bool = false
var face_down: bool = false

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
	mark_self = bool(marks.get("self", false))
	mark_last = bool(marks.get("last", false))
	mark_hint = bool(marks.get("hint", false))
	mark_draft = bool(marks.get("draft", false))

	sb.bg_color = Color(Tile.color_hex(tile.color))
	if mark_hint:
		sb.border_color = Color("FFFFFF")
		sb.set_border_width_all(maxi(bw + 2, 5))
	elif mark_last:
		# Фишки, добавленные в прошлый ход, — зелёным и жирно, чтобы
		# было видно, куда ушли карты соперника.
		sb.border_color = Color("43A047")
		sb.set_border_width_all(maxi(bw + 3, 5))
	elif mark_draft:
		# Соперник только раскладывает (черновик game.draft): фишка ещё
		# не на сервере, поэтому серым — «лежит, но ещё не факт».
		sb.bg_color = Color(0.55, 0.55, 0.58)
		sb.border_color = Color(1, 1, 1, 0.18)
		sb.set_border_width_all(bw)
	else:
		sb.border_color = Color(1, 1, 1, 0.35 if tile.is_joker else 0.18)
		sb.set_border_width_all(maxi(bw, 2) if tile.is_joker else bw)
	add_theme_stylebox_override("panel", sb)

	var fsize := maxi(8, Settings.fs(int(round(ts.y * 0.4))))
	var label := Label.new()
	label.text = "★" if tile.is_joker else str(tile.value)
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
		tooltip_text = "Джокер — заменяет любое число любого цвета"
	else:
		tooltip_text = "%s %d" % [Tile.color_name(tile.color), tile.value]

	queue_redraw()

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
	if not mark_self:
		return
	var ts := Settings.tile_size()
	var center := Vector2(ts.x - ts.x * 0.2, ts.y * 0.2)
	var rad := maxf(5.0, ts.x * 0.16)
	draw_circle(center, rad, Color("2E7D32"))
	var w := maxf(1.5, rad * 0.28)
	draw_line(center + Vector2(-rad * 0.5, -rad * 0.05), center + Vector2(-rad * 0.1, rad * 0.4), Color.WHITE, w)
	draw_line(center + Vector2(-rad * 0.1, rad * 0.4), center + Vector2(rad * 0.55, -rad * 0.4), Color.WHITE, w)

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
