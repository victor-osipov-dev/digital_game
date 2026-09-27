extends Control

const SLOT_HOVER_DELAY_MS := 400
const SLOT_HOVER_MOVE_PX := 6.0
const SLOT_HOVER_EDGE := 10.0
const SLOT_GRACE_MS := 1500
const HINT_MIN_H := 100.0
const DRAG_SCROLL_ZONE := 64.0
const DRAG_SCROLL_OVERSHOOT := 40.0
const DRAG_SCROLL_SPEED := 480.0

var state: GameState = null
var row_blocks: Array = []
var invalid_row_ids: Array = []

var table_scroll: ScrollContainer = null
var table_box: VBoxContainer = null
var hint_zone: DropLayer = null
var hand_flow: FlowTiles = null
var deck_button: Button = null
var end_button: Button = null
var undo_button: Button = null
var hint_btn: Button = null
var cp_save_btn: Button = null
var cp_restore_btn: Button = null
var chips_box: HBoxContainer = null

var pass_overlay: ColorRect = null
var pass_title: Label = null
var pass_name: Label = null
var pass_ready_button: Button = null
var win_overlay: ColorRect = null
var win_title: Label = null
var help_overlay: ColorRect = null
var settings_overlay: ColorRect = null
var turn_title_overlay: ColorRect = null
var turn_title_label: Label = null
var toast_label: Label = null
var draw_dialog: ConfirmationDialog = null
var menu_dialog: ConfirmationDialog = null
var toast_tween: Tween = null
var title_tween: Tween = null

var _drag_view: TileView = null
var _row_slots: Array = []
var _bot_active: bool = false
var _bot_seq: int = 0
var _hint_ids: Array = []
var _slot_hover_pos: int = -1
var _slot_hover_time: int = 0
var _slot_hover_last: Vector2 = Vector2.ZERO
var _slot_grace_until: int = 0

func _ready() -> void:
	_build_ui()
	resized.connect(_on_resized)
	_new_match()

func _process(_delta: float) -> void:
	if _drag_view != null and not Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT):
		_end_drag()
	if _drag_view != null and is_instance_valid(_drag_view):
		_update_row_slot_hover()
		_auto_scroll_drag(_delta)
	_update_hint_zone_size()

func _build_ui() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

	var bg := ColorRect.new()
	bg.color = Color("12151C")
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(bg)

	var margin := MarginContainer.new()
	margin.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	margin.add_theme_constant_override("margin_left", 10)
	margin.add_theme_constant_override("margin_right", 10)
	margin.add_theme_constant_override("margin_top", 8)
	margin.add_theme_constant_override("margin_bottom", 10)
	add_child(margin)

	var layout := VBoxContainer.new()
	layout.add_theme_constant_override("separation", 8)
	margin.add_child(layout)

	var top := HBoxContainer.new()
	top.add_theme_constant_override("separation", 6)
	layout.add_child(top)

	deck_button = Button.new()
	deck_button.custom_minimum_size = Vector2(92, 52)
	deck_button.add_theme_font_size_override("font_size", Settings.fs(14))
	deck_button.pressed.connect(_on_deck_pressed)
	var deck_sb := StyleBoxFlat.new()
	deck_sb.bg_color = Color("2F3B4C")
	deck_sb.set_corner_radius_all(10)
	deck_sb.content_margin_left = 8.0
	deck_sb.content_margin_right = 8.0
	deck_sb.content_margin_top = 6.0
	deck_sb.content_margin_bottom = 6.0
	deck_button.add_theme_stylebox_override("normal", deck_sb)
	var deck_hover := StyleBoxFlat.new()
	deck_hover.bg_color = Color("3B4A5E")
	deck_hover.set_corner_radius_all(10)
	deck_button.add_theme_stylebox_override("hover", deck_hover)
	var deck_press := StyleBoxFlat.new()
	deck_press.bg_color = Color("263040")
	deck_press.set_corner_radius_all(10)
	deck_button.add_theme_stylebox_override("pressed", deck_press)
	deck_button.add_theme_color_override("font_color", Color.WHITE)
	deck_button.add_theme_color_override("font_hover_color", Color.WHITE)
	deck_button.add_theme_color_override("font_pressed_color", Color.WHITE)
	deck_button.add_theme_color_override("font_disabled_color", Color(1, 1, 1, 0.4))
	top.add_child(deck_button)

	var top_spacer := Control.new()
	top_spacer.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	top.add_child(top_spacer)

	cp_save_btn = _make_top_button("Сохр.", "Сохранить расклад (чекпоинт)", _on_cp_save_pressed)
	top.add_child(cp_save_btn)

	cp_restore_btn = _make_top_button("Вернуть", "Вернуться к чекпоинту", _on_cp_restore_pressed)
	top.add_child(cp_restore_btn)

	hint_btn = _make_top_button("Подск.", "Подсказка - показать возможный ход", _on_hint_pressed)
	top.add_child(hint_btn)

	var help_btn := Button.new()
	help_btn.text = "?"
	help_btn.custom_minimum_size = Vector2(44, 46)
	help_btn.add_theme_font_size_override("font_size", Settings.fs(20))
	help_btn.pressed.connect(_open_help)
	top.add_child(help_btn)

	var settings_btn := _make_top_button("Настр.", "Размер текста и карточек", _open_settings)
	top.add_child(settings_btn)

	var menu_btn := Button.new()
	menu_btn.text = "Меню"
	menu_btn.custom_minimum_size = Vector2(68, 46)
	menu_btn.add_theme_font_size_override("font_size", Settings.fs(14))
	menu_btn.pressed.connect(func(): menu_dialog.popup_centered())
	top.add_child(menu_btn)

	var chips_scroll := ScrollContainer.new()
	chips_scroll.custom_minimum_size = Vector2(0, 32)
	chips_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	layout.add_child(chips_scroll)
	chips_box = HBoxContainer.new()
	chips_box.add_theme_constant_override("separation", 6)
	chips_scroll.add_child(chips_box)

	table_scroll = ScrollContainer.new()
	table_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	table_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	layout.add_child(table_scroll)

	table_box = VBoxContainer.new()
	table_box.add_theme_constant_override("separation", 6)
	table_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	table_box.mouse_filter = Control.MOUSE_FILTER_STOP
	table_scroll.add_child(table_box)

	hint_zone = DropLayer.new()
	hint_zone.controller = self
	hint_zone.custom_minimum_size = Vector2(0, 140)
	hint_zone.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var hsb := StyleBoxFlat.new()
	hsb.bg_color = Color(1, 1, 1, 0.04)
	hsb.border_color = Color(1, 1, 1, 0.28)
	hsb.set_border_width_all(2)
	hsb.set_corner_radius_all(12)
	hsb.content_margin_left = 12.0
	hsb.content_margin_right = 12.0
	hsb.content_margin_top = 12.0
	hsb.content_margin_bottom = 12.0
	hint_zone.add_theme_stylebox_override("panel", hsb)
	var hlab := Label.new()
	hlab.text = "Перетащите сюда число - новый ряд"
	hlab.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	hlab.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	hlab.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	hlab.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hlab.add_theme_font_size_override("font_size", Settings.fs(14))
	hlab.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	hint_zone.add_child(hlab)
	table_box.add_child(hint_zone)

	hand_flow = FlowTiles.new()
	hand_flow.controller = self
	hand_flow.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	layout.add_child(hand_flow)

	var bottom := HBoxContainer.new()
	bottom.add_theme_constant_override("separation", 10)
	layout.add_child(bottom)

	undo_button = Button.new()
	undo_button.text = "Отменить ход"
	undo_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	undo_button.custom_minimum_size = Vector2(0, 52)
	undo_button.add_theme_font_size_override("font_size", Settings.fs(16))
	undo_button.pressed.connect(_on_undo_pressed)
	bottom.add_child(undo_button)

	end_button = Button.new()
	end_button.text = "Взять"
	end_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	end_button.custom_minimum_size = Vector2(0, 52)
	end_button.add_theme_font_size_override("font_size", Settings.fs(16))
	end_button.pressed.connect(_on_main_pressed)
	_apply_accent_style(end_button, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	bottom.add_child(end_button)

	toast_label = Label.new()
	toast_label.anchor_left = 0.0
	toast_label.anchor_right = 1.0
	toast_label.anchor_top = 0.0
	toast_label.anchor_bottom = 0.0
	toast_label.offset_top = 100.0
	toast_label.offset_bottom = 152.0
	toast_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	toast_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	toast_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	toast_label.add_theme_font_size_override("font_size", Settings.fs(15))
	toast_label.visible = false
	add_child(toast_label)

	_build_pass_overlay()
	_build_win_overlay()
	_build_help_overlay()
	_build_settings_overlay()
	_build_turn_title_overlay()

	draw_dialog = ConfirmationDialog.new()
	draw_dialog.title = "Взять карту"
	draw_dialog.dialog_text = "Взять число из колоды?\nХод сразу завершится."
	draw_dialog.ok_button_text = "Взять"
	draw_dialog.get_cancel_button().text = "Отмена"
	draw_dialog.confirmed.connect(_on_draw_confirmed)
	_style_dialog(draw_dialog)
	add_child(draw_dialog)

	menu_dialog = ConfirmationDialog.new()
	menu_dialog.title = "Выход в меню"
	menu_dialog.dialog_text = "Выйти в главное меню?"
	menu_dialog.ok_button_text = "Выйти"
	menu_dialog.get_cancel_button().text = "Отмена"
	menu_dialog.confirmed.connect(func(): get_tree().change_scene_to_file("res://scenes/main_menu.tscn"))
	_style_dialog(menu_dialog)
	add_child(menu_dialog)

func _style_dialog(dialog: ConfirmationDialog) -> void:
	var lab := dialog.get_label()
	if lab != null:
		lab.add_theme_font_size_override("font_size", Settings.fs(16))
	var ok_btn := dialog.get_ok_button()
	if ok_btn != null:
		ok_btn.add_theme_font_size_override("font_size", Settings.fs(15))
	var cancel_btn := dialog.get_cancel_button()
	if cancel_btn != null:
		cancel_btn.add_theme_font_size_override("font_size", Settings.fs(15))

func _make_top_button(text_value: String, tip: String, handler: Callable) -> Button:
	var btn := Button.new()
	btn.text = text_value
	btn.tooltip_text = tip
	btn.custom_minimum_size = Vector2(60, 46)
	btn.add_theme_font_size_override("font_size", Settings.fs(13))
	btn.pressed.connect(handler)
	return btn

func _apply_accent_style(button: Button, normal: Color, hover: Color, pressed: Color) -> void:
	var sb_normal := StyleBoxFlat.new()
	sb_normal.bg_color = normal
	sb_normal.set_corner_radius_all(10)
	sb_normal.content_margin_left = 14.0
	sb_normal.content_margin_right = 14.0
	button.add_theme_stylebox_override("normal", sb_normal)
	var sb_hover := StyleBoxFlat.new()
	sb_hover.bg_color = hover
	sb_hover.set_corner_radius_all(10)
	sb_hover.content_margin_left = 14.0
	sb_hover.content_margin_right = 14.0
	button.add_theme_stylebox_override("hover", sb_hover)
	var sb_pressed := StyleBoxFlat.new()
	sb_pressed.bg_color = pressed
	sb_pressed.set_corner_radius_all(10)
	sb_pressed.content_margin_left = 14.0
	sb_pressed.content_margin_right = 14.0
	button.add_theme_stylebox_override("pressed", sb_pressed)
	var sb_disabled := StyleBoxFlat.new()
	sb_disabled.bg_color = Color(1, 1, 1, 0.12)
	sb_disabled.set_corner_radius_all(10)
	sb_disabled.content_margin_left = 14.0
	sb_disabled.content_margin_right = 14.0
	button.add_theme_stylebox_override("disabled", sb_disabled)
	button.add_theme_color_override("font_color", Color.WHITE)
	button.add_theme_color_override("font_hover_color", Color.WHITE)
	button.add_theme_color_override("font_pressed_color", Color.WHITE)
	button.add_theme_color_override("font_disabled_color", Color(1, 1, 1, 0.45))

func _build_pass_overlay() -> void:
	pass_overlay = ColorRect.new()
	pass_overlay.color = Color("0D1017")
	pass_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	pass_overlay.visible = false
	add_child(pass_overlay)

	var box := VBoxContainer.new()
	box.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	box.alignment = BoxContainer.ALIGNMENT_CENTER
	box.add_theme_constant_override("separation", 18)
	pass_overlay.add_child(box)

	pass_title = Label.new()
	pass_title.text = "Передайте устройство игроку"
	pass_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	pass_title.add_theme_font_size_override("font_size", Settings.fs(18))
	pass_title.add_theme_color_override("font_color", Color(1, 1, 1, 0.7))
	box.add_child(pass_title)

	pass_name = Label.new()
	pass_name.text = ""
	pass_name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	pass_name.add_theme_font_size_override("font_size", Settings.fs(34))
	pass_name.add_theme_color_override("font_color", Color("90CAF9"))
	box.add_child(pass_name)

	pass_ready_button = Button.new()
	pass_ready_button.text = "Готов(-а)"
	pass_ready_button.custom_minimum_size = Vector2(220, 60)
	pass_ready_button.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	pass_ready_button.add_theme_font_size_override("font_size", Settings.fs(20))
	pass_ready_button.pressed.connect(_on_pass_ready)
	_apply_accent_style(pass_ready_button, Color("1565C0"), Color("1976D2"), Color("0D47A1"))
	box.add_child(pass_ready_button)

func _build_win_overlay() -> void:
	win_overlay = ColorRect.new()
	win_overlay.color = Color("0D1017")
	win_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	win_overlay.visible = false
	add_child(win_overlay)

	var box := VBoxContainer.new()
	box.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	box.alignment = BoxContainer.ALIGNMENT_CENTER
	box.add_theme_constant_override("separation", 24)
	win_overlay.add_child(box)

	win_title = Label.new()
	win_title.text = ""
	win_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	win_title.add_theme_font_size_override("font_size", Settings.fs(32))
	win_title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(win_title)

	var btn_box := HBoxContainer.new()
	btn_box.alignment = BoxContainer.ALIGNMENT_CENTER
	btn_box.add_theme_constant_override("separation", 14)
	box.add_child(btn_box)

	var again_btn := Button.new()
	again_btn.text = "Заново"
	again_btn.custom_minimum_size = Vector2(180, 60)
	again_btn.add_theme_font_size_override("font_size", Settings.fs(19))
	again_btn.pressed.connect(_new_match)
	_apply_accent_style(again_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	btn_box.add_child(again_btn)

	var to_menu_btn := Button.new()
	to_menu_btn.text = "В меню"
	to_menu_btn.custom_minimum_size = Vector2(180, 60)
	to_menu_btn.add_theme_font_size_override("font_size", Settings.fs(19))
	to_menu_btn.pressed.connect(func(): get_tree().change_scene_to_file("res://scenes/main_menu.tscn"))
	btn_box.add_child(to_menu_btn)

func _build_help_overlay() -> void:
	help_overlay = ColorRect.new()
	help_overlay.color = Color(0, 0, 0, 0.78)
	help_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	help_overlay.visible = false
	add_child(help_overlay)

	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	help_overlay.add_child(center)

	var panel := PanelContainer.new()
	panel.custom_minimum_size = Vector2(520, 760)
	panel.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	var psb := StyleBoxFlat.new()
	psb.bg_color = Color("1B2029")
	psb.set_corner_radius_all(14)
	psb.border_color = Color(1, 1, 1, 0.25)
	psb.set_border_width_all(2)
	psb.content_margin_left = 16.0
	psb.content_margin_right = 16.0
	psb.content_margin_top = 14.0
	psb.content_margin_bottom = 14.0
	panel.add_theme_stylebox_override("panel", psb)
	center.add_child(panel)

	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 10)
	panel.add_child(box)

	var title := Label.new()
	title.text = "Правила игры"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", Settings.fs(22))
	title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(title)

	var scroll := ScrollContainer.new()
	scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	scroll.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	scroll.custom_minimum_size = Vector2(0, 560)
	box.add_child(scroll)

	var rich := RichTextLabel.new()
	rich.bbcode_enabled = true
	rich.fit_content = true
	rich.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	rich.add_theme_font_size_override("normal_font_size", Settings.fs(15))
	rich.add_theme_font_size_override("bold_font_size", Settings.fs(17))
	rich.add_theme_color_override("default_color", Color(1, 1, 1, 0.88))
	rich.text = Rules.rules_text()
	scroll.add_child(rich)

	var close_btn := Button.new()
	close_btn.text = "Закрыть"
	close_btn.custom_minimum_size = Vector2(200, 52)
	close_btn.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	close_btn.add_theme_font_size_override("font_size", Settings.fs(17))
	close_btn.pressed.connect(func(): help_overlay.visible = false)
	box.add_child(close_btn)

func _build_turn_title_overlay() -> void:
	turn_title_overlay = ColorRect.new()
	turn_title_overlay.color = Color("0D1017")
	turn_title_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	turn_title_overlay.visible = false
	turn_title_overlay.mouse_filter = Control.MOUSE_FILTER_STOP
	add_child(turn_title_overlay)

	turn_title_label = Label.new()
	turn_title_label.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	turn_title_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	turn_title_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	turn_title_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	turn_title_label.add_theme_font_size_override("font_size", Settings.fs(56))
	turn_title_label.add_theme_color_override("font_color", Color("FFD54F"))
	turn_title_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	turn_title_overlay.add_child(turn_title_label)

func _open_help() -> void:
	help_overlay.visible = true

func _open_settings() -> void:
	settings_overlay.visible = true

func _on_settings_text_scale(index: int) -> void:
	Settings.text_scale = index
	Settings.save_settings()
	call_deferred("_rebuild_ui")

func _on_settings_tile_step(index: int) -> void:
	Settings.tile_step = index
	Settings.save_settings()
	refresh()

func _rebuild_ui() -> void:
	# пересборка UI с сохранением партии (смена text_scale)
	if title_tween != null and title_tween.is_running():
		title_tween.kill()
	if toast_tween != null and toast_tween.is_running():
		toast_tween.kill()
	_drag_view = null
	_slot_hover_pos = -1
	_slot_hover_time = 0
	_slot_grace_until = 0
	_row_slots.clear()
	row_blocks.clear()
	var was_pass := pass_overlay != null and pass_overlay.visible
	var was_win := win_overlay != null and win_overlay.visible
	var was_help := help_overlay != null and help_overlay.visible
	var was_settings := settings_overlay != null and settings_overlay.visible
	var pass_t := pass_title.text if pass_title != null else ""
	var pass_n := pass_name.text if pass_name != null else ""
	for child in get_children():
		remove_child(child)
		child.free()
	_build_ui()
	if state == null:
		_new_match()
		return
	pass_overlay.visible = was_pass
	win_overlay.visible = was_win
	help_overlay.visible = was_help
	settings_overlay.visible = was_settings
	turn_title_overlay.visible = false
	pass_title.text = pass_t
	pass_name.text = pass_n
	refresh()

func _build_settings_overlay() -> void:
	settings_overlay = ColorRect.new()
	settings_overlay.color = Color(0, 0, 0, 0.78)
	settings_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	settings_overlay.visible = false
	add_child(settings_overlay)

	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	settings_overlay.add_child(center)

	var panel := PanelContainer.new()
	panel.custom_minimum_size = Vector2(460, 0)
	var psb := StyleBoxFlat.new()
	psb.bg_color = Color("1B2029")
	psb.set_corner_radius_all(14)
	psb.border_color = Color(1, 1, 1, 0.25)
	psb.set_border_width_all(2)
	psb.content_margin_left = 16.0
	psb.content_margin_right = 16.0
	psb.content_margin_top = 14.0
	psb.content_margin_bottom = 14.0
	panel.add_theme_stylebox_override("panel", psb)
	center.add_child(panel)

	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 12)
	panel.add_child(box)

	var title := Label.new()
	title.text = "Настройки"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", Settings.fs(22))
	title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(title)

	box.add_child(_make_settings_row("Текст:", Settings.TEXT_SCALE_NAMES, Settings.text_scale, _on_settings_text_scale))
	box.add_child(_make_settings_row("Карточки:", Settings.TILE_SIZE_NAMES, Settings.tile_step, _on_settings_tile_step))

	var close_btn := Button.new()
	close_btn.text = "Закрыть"
	close_btn.custom_minimum_size = Vector2(200, 52)
	close_btn.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	close_btn.add_theme_font_size_override("font_size", Settings.fs(17))
	close_btn.pressed.connect(func(): settings_overlay.visible = false)
	box.add_child(close_btn)

func _make_settings_row(label_text: String, names: PackedStringArray, current: int, handler: Callable) -> HBoxContainer:
	var row := HBoxContainer.new()
	row.add_theme_constant_override("separation", 10)
	var lab := Label.new()
	lab.text = label_text
	lab.add_theme_font_size_override("font_size", Settings.fs(15))
	lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	row.add_child(lab)
	var option := OptionButton.new()
	option.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	option.custom_minimum_size = Vector2(0, 42)
	option.add_theme_font_size_override("font_size", Settings.fs(15))
	for n in names:
		option.add_item(n)
	option.select(clampi(current, 0, names.size() - 1))
	option.item_selected.connect(handler)
	row.add_child(option)
	return row

# ---------------------------------------------------------------- match flow

func _new_match() -> void:
	_bot_seq += 1
	_bot_active = false
	_hint_ids.clear()
	state = GameState.create(Settings.player_count, Array(Settings.player_names), Settings.require_30)
	invalid_row_ids.clear()
	win_overlay.visible = false
	pass_overlay.visible = false
	_show_pass(true)

func _is_bot_turn() -> bool:
	return state != null and Settings.is_bot(state.current)

func _show_pass(first: bool = false) -> void:
	pass_overlay.visible = false
	refresh()
	if state.finished:
		return
	if _is_bot_turn():
		_run_bot_turn()
	else:
		pass_title.text = "Игра начинается - первый ход:" if first else "Передайте устройство игроку"
		pass_name.text = state.current_player().pname
		pass_overlay.visible = true

func _on_pass_ready() -> void:
	pass_overlay.visible = false

func _show_turn_title() -> void:
	if state == null:
		return
	turn_title_label.text = "Ход: %s" % state.current_player().pname
	turn_title_overlay.visible = true
	turn_title_overlay.modulate.a = 0.0
	if title_tween != null and title_tween.is_running():
		title_tween.kill()
	title_tween = create_tween()
	title_tween.tween_property(turn_title_overlay, "modulate:a", 1.0, 0.3)
	title_tween.tween_interval(0.7)
	title_tween.tween_property(turn_title_overlay, "modulate:a", 0.0, 0.35)
	title_tween.tween_callback(func(): turn_title_overlay.visible = false)

func _run_bot_turn() -> void:
	_bot_seq += 1
	_bot_active = true
	refresh()
	_show_turn_title()
	var seq := _bot_seq
	var tw := create_tween()
	tw.tween_interval(1.7)
	tw.tween_callback(_bot_execute.bind(seq))

func _bot_execute(seq: int) -> void:
	if seq != _bot_seq or state == null or state.finished or not _is_bot_turn():
		_bot_active = false
		return
	var plan := TurnPlanner.plan(state, Settings.bot_level)
	var action := String(plan.get("action", ""))
	var action_ok := false
	if action == "place":
		if state.apply_ops(plan.get("ops", [])):
			var r := state.end_turn()
			if r.get("ok", false):
				action_ok = true
				invalid_row_ids.clear()
				_bot_active = false
				refresh()
				if r.get("win", false):
					_show_win()
				else:
					_show_pass()
				return
		state.restore_turn_snapshot()
	elif action == "draw":
		action_ok = bool(state.draw_from_deck().get("ok", false))
	elif action == "skip":
		action_ok = bool(state.skip_turn().get("ok", false))
	if not action_ok:
		if state.can_draw():
			state.draw_from_deck()
		elif state.can_skip():
			state.skip_turn()
	invalid_row_ids.clear()
	_bot_active = false
	refresh()
	if state.finished:
		_show_win()
	else:
		_show_pass()

func _show_win() -> void:
	win_title.text = "Победитель - %s" % state.player_name(state.winner)
	win_overlay.visible = true

func _on_deck_pressed() -> void:
	if state == null or state.finished or _bot_active or _is_bot_turn():
		return
	draw_dialog.popup_centered()

func _on_draw_confirmed() -> void:
	_hint_ids.clear()
	var r := state.draw_from_deck()
	if r.get("ok", false):
		invalid_row_ids.clear()
		refresh()
		_show_pass()
	else:
		toast(String(r.get("reason", "")), true)

func _on_main_pressed() -> void:
	if state == null or state.finished or _bot_active:
		return
	if not state.turn_placed.is_empty():
		_on_end_pressed()
	elif state.tiles_left_in_deck() > 0:
		_on_deck_pressed()
	else:
		_on_skip_pressed()

func _on_end_pressed() -> void:
	_hint_ids.clear()
	var r := state.end_turn()
	if r.get("ok", false):
		invalid_row_ids.clear()
		refresh()
		if r.get("win", false):
			_show_win()
		else:
			_show_pass()
		return
	invalid_row_ids.clear()
	for e in r.get("errors", []):
		var idx := int(e.get("row", -1))
		if idx >= 0 and idx < state.table.size():
			invalid_row_ids.append((state.table[idx] as GameState.Row).id)
	toast(String(r.get("reason", "Стол в невалидном состоянии")), true)
	refresh()

func _on_skip_pressed() -> void:
	_hint_ids.clear()
	var r := state.skip_turn()
	if r.get("ok", false):
		invalid_row_ids.clear()
		refresh()
		_show_pass()
	else:
		toast(String(r.get("reason", "")), true)

func _on_undo_pressed() -> void:
	if state == null or state.finished or _bot_active:
		return
	if not state.turn_dirty:
		toast("В этот ход ещё ничего не менялось", false)
		return
	_hint_ids.clear()
	state.restore_turn_snapshot()
	invalid_row_ids.clear()
	refresh()
	toast("Стол и рука возвращены к началу хода", false)

func _on_cp_save_pressed() -> void:
	if state == null or state.finished or _bot_active:
		return
	if state.save_checkpoint():
		toast("Расклад сохранён (чекпоинт)", false)
	else:
		toast("Сначала что-нибудь измените на столе", false)

func _on_cp_restore_pressed() -> void:
	if state == null or state.finished or _bot_active:
		return
	if state.restore_checkpoint():
		_hint_ids.clear()
		invalid_row_ids.clear()
		refresh()
		toast("Возврат к чекпоинту", false)
	else:
		toast("Нет сохранённых раскладов", false)

func _on_hint_pressed() -> void:
	if state == null or state.finished or _bot_active or _is_bot_turn():
		return
	_hint_ids.clear()
	var plan := TurnPlanner.plan(state, TurnPlanner.LEVEL_IMPOSSIBLE)
	var action := String(plan.get("action", ""))
	if action == "place":
		_hint_ids = (plan.get("tiles", []) as Array).duplicate()
		toast("Подсказка: выложите %d - +%d очков" % [_hint_ids.size(), int(plan.get("points", 0))], false)
	elif action == "draw":
		toast("Подсказка: возьмите число из колоды", false)
	elif action == "skip":
		toast("Подсказка: пропустите ход", false)
	else:
		if state.table_status().get("ok", false):
			toast("Подсказка: можно завершать ход", false)
		else:
			toast("Подсказка: закончите перестановку на столе", false)
	refresh()

func _on_resized() -> void:
	_update_hint_zone_size()

# ---------------------------------------------------------------- drag & drop

func on_drag_started(view: TileView) -> void:
	_drag_view = view
	_hint_ids.clear()
	_slot_hover_pos = -1
	_slot_hover_time = 0
	_slot_grace_until = 0

func _end_drag() -> void:
	if _drag_view != null and is_instance_valid(_drag_view):
		_drag_view.modulate = Color.WHITE
	_drag_view = null
	_slot_hover_pos = -1
	_slot_hover_time = 0
	_slot_grace_until = 0
	_clear_row_slots()

func _update_row_slot_hover() -> void:
	if state == null or state.finished:
		return
	var mouse := get_global_mouse_position()
	var now := Time.get_ticks_msec()
	if not _row_slots.is_empty():
		# слот показан: держим его, пока курсор в его зоне;
		# при уходе прячем с задержкой, чтобы успеть попасть
		var slot_pos := int(_row_slots[0].get_meta("slot_pos", -1))
		if _hover_slot_pos(mouse) == slot_pos:
			_slot_grace_until = 0
			return
		if _slot_grace_until == 0:
			_slot_grace_until = now + SLOT_GRACE_MS
		elif now >= _slot_grace_until:
			_slot_grace_until = 0
			_slot_hover_pos = -1
			_slot_hover_time = 0
			_clear_row_slots()
		return
	_slot_grace_until = 0
	var pos := _hover_slot_pos(mouse)
	if pos < 0:
		if _slot_hover_pos >= 0:
			_slot_hover_pos = -1
			_slot_hover_time = 0
		return
	if pos != _slot_hover_pos:
		_slot_hover_pos = pos
		_slot_hover_time = now
		_slot_hover_last = mouse
		return
	if mouse.distance_to(_slot_hover_last) > SLOT_HOVER_MOVE_PX:
		_slot_hover_last = mouse
		_slot_hover_time = now
		return
	if now - _slot_hover_time >= SLOT_HOVER_DELAY_MS:
		_show_row_slot(pos)

func _auto_scroll_drag(delta: float) -> void:
	if table_scroll == null:
		return
	var rect := table_scroll.get_global_rect()
	var mouse := get_global_mouse_position()
	var speed := 0.0
	var d_bot := rect.end.y - mouse.y
	var d_top := mouse.y - rect.position.y
	if d_bot >= -DRAG_SCROLL_OVERSHOOT and d_bot < DRAG_SCROLL_ZONE:
		speed = DRAG_SCROLL_SPEED * (1.0 - clampf(d_bot / DRAG_SCROLL_ZONE, 0.0, 1.0))
	elif d_top >= -DRAG_SCROLL_OVERSHOOT and d_top < DRAG_SCROLL_ZONE:
		speed = -DRAG_SCROLL_SPEED * (1.0 - clampf(d_top / DRAG_SCROLL_ZONE, 0.0, 1.0))
	if speed != 0.0:
		table_scroll.scroll_vertical = maxi(0, int(table_scroll.scroll_vertical + speed * delta))

func _hover_slot_pos(global_pos: Vector2) -> int:
	# позиция ближайшего «междурядья» под курсором, -1 если курсор
	# глубоко над рядами или вне стола
	if table_box == null:
		return -1
	var box := table_box.get_global_rect()
	if not box.has_point(global_pos):
		return -1
	var y := global_pos.y
	for block in row_blocks:
		var rb := block as RowBlock
		if rb == null:
			continue
		var r := rb.get_global_rect()
		if y >= r.position.y + SLOT_HOVER_EDGE and y <= r.end.y - SLOT_HOVER_EDGE:
			return -1
	var n := row_blocks.size()
	var best := -1
	var best_d := SLOT_HOVER_EDGE + 1.0
	for j in range(n + 1):
		var gs := box.position.y
		var ge := box.end.y
		if j > 0:
			gs = (row_blocks[j - 1] as RowBlock).get_global_rect().end.y
		if j < n:
			ge = (row_blocks[j] as RowBlock).get_global_rect().position.y
		var d := 0.0
		if y < gs:
			d = gs - y
		elif y > ge:
			d = y - ge
		if d < best_d:
			best_d = d
			best = j
	return best

func _show_row_slot(pos: int) -> void:
	_clear_row_slots()
	if state == null or state.finished:
		return
	var h := maxf(Settings.tile_size().y + 16.0, 36.0)
	var slot := DropLayer.new()
	slot.controller = self
	slot.custom_minimum_size = Vector2(0, h)
	slot.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(1, 1, 1, 0.03)
	sb.border_color = Color(1, 1, 1, 0.25)
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(10)
	slot.add_theme_stylebox_override("panel", sb)
	var lab := Label.new()
	lab.text = "+ новый ряд"
	lab.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	lab.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	lab.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	lab.mouse_filter = Control.MOUSE_FILTER_IGNORE
	lab.add_theme_font_size_override("font_size", Settings.fs(13))
	lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.5))
	slot.add_child(lab)
	slot.set_meta("slot_pos", pos)
	table_box.add_child(slot)
	table_box.move_child(slot, clampi(pos, 0, table_box.get_child_count() - 1))
	_row_slots.append(slot)

func _clear_row_slots() -> void:
	for slot in _row_slots:
		if is_instance_valid(slot):
			table_box.remove_child(slot)
			slot.free()
	_row_slots.clear()

func _slot_position(global_pos: Vector2) -> int:
	for slot in _row_slots:
		if is_instance_valid(slot) and slot.get_global_rect().grow(SLOT_HOVER_EDGE * 2.0).has_point(global_pos):
			return int(slot.get_meta("slot_pos", -1))
	return -1

func gui_can_drop(data: Dictionary, global_pos: Vector2) -> bool:
	if state == null or state.finished or _bot_active or _is_bot_turn():
		return false
	if String(data.get("kind", "")) != "tile":
		return false
	var tile_id := int(data.get("tile_id", -1))
	if tile_id < 0:
		return false
	if hand_flow != null and hand_flow.get_global_rect().has_point(global_pos):
		if String(data.get("from", "")) != "row":
			return false
		var tile := _find_tile(tile_id)
		return tile != null and state.can_take_back(tile)
	if table_scroll == null or not table_scroll.get_global_rect().has_point(global_pos):
		return false
	var hit := _table_hit(global_pos)
	var from := String(data.get("from", ""))
	if from == "hand":
		if hit["row"] == null:
			return _slot_position(global_pos) >= 0 or _in_hint_zone(global_pos)
		return state.can_place_into(hit["row"])
	elif from == "row":
		var src := state.row_by_id(int(data.get("row_id", -1)))
		if src == null or not state.can_touch_row(src):
			return false
		if hit["row"] == null:
			return _slot_position(global_pos) >= 0 or _in_hint_zone(global_pos)
		return hit["row"] == src or state.can_touch_row(hit["row"])
	return false

func _in_hint_zone(global_pos: Vector2) -> bool:
	return hint_zone != null and hint_zone.get_global_rect().has_point(global_pos)

func gui_do_drop(data: Dictionary, global_pos: Vector2) -> void:
	if not gui_can_drop(data, global_pos):
		return
	_hint_ids.clear()
	var tile_id := int(data["tile_id"])
	var from := String(data["from"])
	if hand_flow.get_global_rect().has_point(global_pos):
		state.take_back_to_hand(int(data.get("row_id", -1)), tile_id)
	else:
		var hit := _table_hit(global_pos)
		var target: GameState.Row = hit["row"]
		var index := int(hit["index"])
		if target == null:
			var slot_pos := _slot_position(global_pos)
			if slot_pos < 0 and not _row_slots.is_empty():
				slot_pos = int(_row_slots[0].get_meta("slot_pos", -1))
			target = state.add_row()
			if slot_pos >= 0:
				state.table.erase(target)
				state.table.insert(clampi(slot_pos, 0, state.table.size()), target)
			index = 0
		if from == "hand":
			state.place_from_hand(tile_id, target.id, index)
		else:
			state.move_tile(int(data.get("row_id", -1)), tile_id, target.id, index)
	invalid_row_ids.clear()
	call_deferred("refresh")

func _table_hit(global_pos: Vector2) -> Dictionary:
	for block in row_blocks:
		var rb := block as RowBlock
		if rb == null:
			continue
		if rb.get_global_rect().grow(4.0).has_point(global_pos):
			var row := state.row_by_id(rb.row_id)
			if row == null:
				continue
			return {row=row, index=rb.flow.index_at(global_pos)}
	return {row=null, index=0}

func _find_tile(tile_id: int) -> Tile:
	for row in state.table:
		for t in (row as GameState.Row).tiles:
			if (t as Tile).id == tile_id:
				return t
	for t in state.hand():
		if (t as Tile).id == tile_id:
			return t
	return null

# ---------------------------------------------------------------- refresh

func get_tile_marks(tile_id: int) -> Dictionary:
	var m := {}
	if state == null:
		return m
	for t in state.turn_placed:
		if (t as Tile).id == tile_id:
			m["self"] = true
			break
	if state.last_turn_tile_ids.has(tile_id):
		m["last"] = true
	if _hint_ids.has(tile_id):
		m["hint"] = true
	return m

func refresh() -> void:
	if state == null:
		return
	_drag_view = null
	_slot_hover_pos = -1
	_slot_hover_time = 0
	_slot_grace_until = 0
	_clear_row_slots()
	_update_chips()
	_update_table()
	_update_hand()
	_update_buttons()
	_update_hint_zone_size()

func _update_chips() -> void:
	for child in chips_box.get_children():
		chips_box.remove_child(child)
		child.free()
	for i in state.player_count():
		var chip := PanelContainer.new()
		var sb := StyleBoxFlat.new()
		var is_now := i == state.current
		sb.bg_color = Color(0.24, 0.45, 0.85, 0.4) if is_now else Color(1, 1, 1, 0.07)
		sb.set_corner_radius_all(8)
		sb.border_color = Color(0.56, 0.73, 0.98, 0.9) if is_now else Color(1, 1, 1, 0.12)
		sb.set_border_width_all(2 if is_now else 1)
		sb.content_margin_left = 8.0
		sb.content_margin_right = 8.0
		sb.content_margin_top = 3.0
		sb.content_margin_bottom = 3.0
		chip.add_theme_stylebox_override("panel", sb)
		var lab := Label.new()
		lab.text = "%s · %d" % [state.player_name(i), state.hand_size(i)]
		lab.add_theme_font_size_override("font_size", Settings.fs(12))
		lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.95) if is_now else Color(1, 1, 1, 0.6))
		chip.add_child(lab)
		chips_box.add_child(chip)

func _update_table() -> void:
	for child in table_box.get_children():
		if child is RowBlock:
			table_box.remove_child(child)
			child.free()
	row_blocks.clear()
	var draggable := not state.finished and not _is_bot_turn()
	for row in state.table:
		var r := row as GameState.Row
		if r == null or r.tiles.is_empty():
			continue
		var block := RowBlock.new()
		block.setup(
			r.id,
			r.tiles,
			invalid_row_ids.has(r.id),
			draggable,
			self
		)
		table_box.add_child(block)
		row_blocks.append(block)
	table_box.move_child(hint_zone, table_box.get_child_count() - 1)

func _update_hand() -> void:
	var bot_turn := _is_bot_turn()
	hand_flow.set_tiles(state.hand(), "hand", 0, not state.finished and not bot_turn, bot_turn)

func _update_buttons() -> void:
	if state == null:
		return
	deck_button.text = "Колода\n%d" % state.tiles_left_in_deck()
	var placed := not state.turn_placed.is_empty()
	var bot := _bot_active or _is_bot_turn()
	deck_button.disabled = state.finished or bot or not state.can_draw()
	undo_button.disabled = state.finished or bot or not state.turn_dirty
	cp_save_btn.disabled = state.finished or bot or not state.turn_dirty
	cp_restore_btn.disabled = state.finished or bot or state.checkpoint_count() == 0
	hint_btn.disabled = state.finished or bot
	if state.finished:
		end_button.text = "Игра окончена"
		end_button.disabled = true
	elif placed:
		end_button.text = "Продолжить"
		end_button.disabled = bot
	elif state.tiles_left_in_deck() > 0:
		end_button.text = "Взять"
		end_button.disabled = bot or not state.can_draw()
	else:
		end_button.text = "Пропуск хода"
		end_button.disabled = bot or not state.can_skip()

func _update_hint_zone_size() -> void:
	if hint_zone == null or table_scroll == null or table_box == null:
		return
	var rows_h := 0.0
	var sep := float(table_box.get_theme_constant("separation"))
	for block in row_blocks:
		var b := block as Control
		if b == null:
			continue
		rows_h += maxf(b.size.y, b.get_combined_minimum_size().y) + sep
	var target := maxf(HINT_MIN_H, table_scroll.size.y - rows_h)
	if not is_equal_approx(hint_zone.custom_minimum_size.y, target):
		hint_zone.custom_minimum_size.y = target

func toast(text: String, is_error: bool = false) -> void:
	toast_label.text = text
	toast_label.add_theme_color_override("font_color", Color("FF8A80") if is_error else Color("A5D6A7"))
	toast_label.visible = true
	toast_label.modulate.a = 1.0
	if toast_tween != null and toast_tween.is_running():
		toast_tween.kill()
	toast_tween = create_tween()
	toast_tween.tween_interval(2.6)
	toast_tween.tween_property(toast_label, "modulate:a", 0.0, 0.5)
	toast_tween.tween_callback(func(): toast_label.visible = false)
