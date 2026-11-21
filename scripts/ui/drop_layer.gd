class_name DropLayer
extends PanelContainer

var controller: Object = null

func _can_drop_data(_pos: Vector2, data: Variant) -> bool:
	if controller == null or not (data is Dictionary):
		return false
	return controller.gui_can_drop(data, get_global_mouse_position())

func _drop_data(_pos: Vector2, data: Variant) -> void:
	if controller != null and data is Dictionary:
		controller.gui_do_drop(data, get_global_mouse_position())
