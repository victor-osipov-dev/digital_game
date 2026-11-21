class_name FlowTiles
extends Control

const HGAP := 6.0
const VGAP := 6.0

var controller: Object = null
var tile_views: Array = []
var _last_width: float = -1.0
var _last_tile_size: Vector2 = Vector2(-1, -1)

func _ready() -> void:
	mouse_filter = Control.MOUSE_FILTER_STOP

func set_tiles(tiles: Array, src_kind: String, src_row_id: int, draggable: bool, face_down: bool = false) -> void:
	for child in get_children():
		remove_child(child)
		child.free()
	tile_views.clear()
	for t in tiles:
		var view := TileView.make(t, draggable, controller, face_down)
		view.src_kind = src_kind
		view.src_row_id = src_row_id
		add_child(view)
		tile_views.append(view)
	force_relayout()

func force_relayout() -> void:
	_last_width = -1.0
	_relayout()

## Ряд уже разложен: ширина известна и карточки встали на свои места.
## Свежий ряд (только что созданный блок) этой ширины ещё не получил —
## до первого layout все view лежат в (0,0), и целить туда нельзя.
func is_laid_out() -> bool:
	return _last_width > 0.0

func _notification(what: int) -> void:
	if what == NOTIFICATION_RESIZED:
		_maybe_relayout()

func _maybe_relayout() -> void:
	if absf(size.x - _last_width) < 0.5 and Settings.tile_size() == _last_tile_size:
		return
	_relayout()

func _relayout() -> void:
	if size.x <= 1.0:
		return
	_last_width = size.x
	var ts := Settings.tile_size()
	_last_tile_size = ts
	var hgap := clampf(ts.x * 0.1, 3.0, 8.0)
	var vgap := clampf(ts.x * 0.1, 3.0, 8.0)
	var x := 0.0
	var y := 0.0
	# Карточки центрируем по каждой визуальной строке: иначе ряды липнут
	# к левому краю и на широком поле выглядят неровно.
	var line_start := 0
	var line_width := 0.0
	for i in tile_views.size():
		var v: TileView = tile_views[i]
		if x > 0.0 and x + ts.x > size.x:
			_center_line(line_start, i, line_width)
			line_start = i
			line_width = 0.0
			x = 0.0
			y += ts.y + vgap
		v.position = Vector2(x, y)
		v.size = ts
		x += ts.x + hgap
		line_width += ts.x + hgap
	_center_line(line_start, tile_views.size(), line_width)
	var new_height := y + ts.y
	if not is_equal_approx(custom_minimum_size.y, new_height):
		custom_minimum_size.y = new_height

func _center_line(first: int, end: int, width_with_gap: float) -> void:
	if end <= first or size.x <= 1.0:
		return
	var hgap := clampf(Settings.tile_size().x * 0.1, 3.0, 8.0)
	var width := maxf(width_with_gap - hgap, 0.0)
	var shift := maxf((size.x - width) * 0.5, 0.0)
	for i in range(first, end):
		var v: TileView = tile_views[i]
		v.position.x += shift


func index_at(global_pos: Vector2) -> int:
	if tile_views.is_empty():
		return 0
	var ts := Settings.tile_size()
	var hgap := clampf(ts.x * 0.1, 3.0, 8.0)
	var vgap := clampf(ts.x * 0.1, 3.0, 8.0)
	var local := get_global_transform().affine_inverse() * global_pos
	var n := tile_views.size()
	var first: TileView = tile_views[0]
	var last: TileView = tile_views[n - 1]
	if local.y <= first.position.y:
		return 0
	if local.y >= last.position.y + ts.y:
		return n
	var best_index := n
	var best_dist := INF
	for i in n:
		var v: TileView = tile_views[i]
		var rect := Rect2(
			v.position - Vector2(hgap, vgap) * 0.5,
			ts + Vector2(hgap, vgap)
		)
		var closest := Vector2(
			clampf(local.x, rect.position.x, rect.end.x),
			clampf(local.y, rect.position.y, rect.end.y)
		)
		var dist := closest.distance_to(local)
		if dist < best_dist:
			best_dist = dist
			if local.x < v.position.x + ts.x * 0.5:
				best_index = i
			else:
				best_index = i + 1
	return best_index

func _can_drop_data(_pos: Vector2, data: Variant) -> bool:
	if controller == null or not (data is Dictionary):
		return false
	return controller.gui_can_drop(data, get_global_mouse_position())

func _drop_data(_pos: Vector2, data: Variant) -> void:
	if controller != null and data is Dictionary:
		controller.gui_do_drop(data, get_global_mouse_position())
