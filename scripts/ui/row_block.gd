class_name RowBlock
extends PanelContainer

var row_id: int = 0
var flow: FlowTiles = null

func setup(p_row_id: int, tiles: Array, p_invalid: bool, p_draggable: bool, controller: Object) -> void:
	row_id = p_row_id
	mouse_filter = Control.MOUSE_FILTER_STOP

	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(1, 1, 1, 0.05)
	sb.set_corner_radius_all(10)
	sb.border_color = Color("E53935") if p_invalid else Color(1, 1, 1, 0.22)
	sb.set_border_width_all(3 if p_invalid else 2)
	sb.content_margin_left = 6.0
	sb.content_margin_right = 6.0
	sb.content_margin_top = 4.0
	sb.content_margin_bottom = 4.0
	add_theme_stylebox_override("panel", sb)

	flow = FlowTiles.new()
	flow.controller = controller
	flow.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	add_child(flow)
	flow.set_tiles(tiles, "row", row_id, p_draggable)

func relayout() -> void:
	if flow != null:
		flow.force_relayout()

func _can_drop_data(_pos: Vector2, data: Variant) -> bool:
	if not (data is Dictionary) or flow == null or flow.controller == null:
		return false
	return flow.controller.gui_can_drop(data, get_global_mouse_position())

func _drop_data(_pos: Vector2, data: Variant) -> void:
	if flow != null and flow.controller != null and data is Dictionary:
		flow.controller.gui_do_drop(data, get_global_mouse_position())
