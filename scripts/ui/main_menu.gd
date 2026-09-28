extends Control

var count_option: OptionButton = null
var names_box: VBoxContainer = null
var name_edits: Array = []
var bot_checks: Array = []
var check_30: CheckBox = null
var help_overlay: ColorRect = null
var menu_scroll: ScrollContainer = null
var menu_box: VBoxContainer = null
var online_lobby: Control = null

func _sync_scroll_min() -> void:
	if menu_scroll == null or menu_box == null:
		return
	var c := menu_box.get_combined_minimum_size()
	var vp := get_viewport_rect().size
	menu_scroll.custom_minimum_size = Vector2(c.x, minf(c.y, vp.y))

func _ready() -> void:
	_build_ui()
	_rebuild_names()

func _build_ui() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)

	var bg := ColorRect.new()
	bg.color = Color("12151C")
	bg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(bg)

	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(center)

	menu_scroll = ScrollContainer.new()
	menu_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	center.add_child(menu_scroll)

	menu_box = VBoxContainer.new()
	menu_box.custom_minimum_size = Vector2(470, 0)
	menu_box.add_theme_constant_override("separation", 14)
	menu_scroll.add_child(menu_box)
	var box := menu_box

	var title := Label.new()
	title.text = "DIGITAL GAME"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", Settings.fs(38))
	title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(title)

	var subtitle := Label.new()
	subtitle.text = "числа · 4 цвета · джокеры"
	subtitle.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	subtitle.add_theme_font_size_override("font_size", Settings.fs(14))
	subtitle.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	box.add_child(subtitle)

	var spacer := Control.new()
	spacer.custom_minimum_size = Vector2(0, 8)
	box.add_child(spacer)

	var count_row := HBoxContainer.new()
	count_row.add_theme_constant_override("separation", 12)
	count_row.alignment = BoxContainer.ALIGNMENT_CENTER
	box.add_child(count_row)

	var count_label := Label.new()
	count_label.text = "Игроков:"
	count_label.add_theme_font_size_override("font_size", Settings.fs(17))
	count_label.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	count_row.add_child(count_label)

	count_option = OptionButton.new()
	count_option.custom_minimum_size = Vector2(90, 44)
	count_option.add_theme_font_size_override("font_size", Settings.fs(17))
	for n in range(Settings.MIN_PLAYERS, Settings.MAX_PLAYERS + 1):
		count_option.add_item(str(n))
	count_option.select(Settings.player_count - Settings.MIN_PLAYERS)
	count_option.item_selected.connect(_on_count_selected)
	count_row.add_child(count_option)

	var names_label := Label.new()
	names_label.text = "Имена игроков:"
	names_label.add_theme_font_size_override("font_size", Settings.fs(17))
	names_label.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	box.add_child(names_label)

	names_box = VBoxContainer.new()
	names_box.add_theme_constant_override("separation", 8)
	box.add_child(names_box)

	check_30 = CheckBox.new()
	check_30.text = "Первый ход игры: минимум 30 очков"
	check_30.button_pressed = Settings.require_30
	check_30.add_theme_font_size_override("font_size", Settings.fs(15))
	check_30.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	check_30.toggled.connect(_on_require_30_toggled)
	box.add_child(check_30)

	box.add_child(_make_option_row("Текст:", Settings.TEXT_SCALE_NAMES, Settings.text_scale, _on_text_scale))
	box.add_child(_make_option_row("Карточки:", Settings.TILE_SIZE_NAMES, Settings.tile_step, _on_tile_step))
	box.add_child(_make_option_row("Сложность ботов:", Settings.BOT_LEVEL_NAMES, Settings.bot_level, _on_bot_level))

	var start_btn := Button.new()
	start_btn.text = "Начать игру"
	start_btn.custom_minimum_size = Vector2(0, 58)
	start_btn.add_theme_font_size_override("font_size", Settings.fs(20))
	start_btn.pressed.connect(_on_start_pressed)
	_apply_accent_style(start_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	box.add_child(start_btn)

	# Сетевая кнопка стоит рядом с одиночной, но выглядит слабее: это
	# отдельный режим, и человек, который хочет поиграть с соседом за
	# одним столом, не должен промахиваться мимо привычной кнопки.
	var online_btn := Button.new()
	online_btn.text = "Играть по сети"
	online_btn.custom_minimum_size = Vector2(0, 50)
	online_btn.add_theme_font_size_override("font_size", Settings.fs(17))
	online_btn.pressed.connect(_on_online_pressed)
	_apply_accent_style(online_btn, Color("1F4E79"), Color("2A6CA8"), Color("163A5C"))
	box.add_child(online_btn)

	var bottom := HBoxContainer.new()
	bottom.alignment = BoxContainer.ALIGNMENT_CENTER
	bottom.add_theme_constant_override("separation", 14)
	box.add_child(bottom)

	var rules_btn := Button.new()
	rules_btn.text = "Как играть"
	rules_btn.custom_minimum_size = Vector2(200, 50)
	rules_btn.add_theme_font_size_override("font_size", Settings.fs(16))
	rules_btn.pressed.connect(func(): help_overlay.visible = true)
	bottom.add_child(rules_btn)

	var quit_btn := Button.new()
	quit_btn.text = "Выход"
	quit_btn.custom_minimum_size = Vector2(200, 50)
	quit_btn.add_theme_font_size_override("font_size", Settings.fs(16))
	quit_btn.pressed.connect(func(): get_tree().quit())
	bottom.add_child(quit_btn)

	_build_help_overlay()
	_build_online()
	_sync_scroll_min()


## Сетевое меню живёт поверх главного, а не отдельной сценой: возврат из
## сетевого режима в меню не должен пересобирать список игроков и всю
## разметку заново. Сцена — отдельная, экран — нет.
func _build_online() -> void:
	if online_lobby != null:
		return
	online_lobby = OnlineLobby.new()
	online_lobby.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	add_child(online_lobby)

func _make_option_row(label_text: String, names: PackedStringArray, current: int, handler: Callable) -> HBoxContainer:
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
	button.add_theme_color_override("font_color", Color.WHITE)
	button.add_theme_color_override("font_hover_color", Color.WHITE)
	button.add_theme_color_override("font_pressed_color", Color.WHITE)

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

func _rebuild_names() -> void:
	for child in names_box.get_children():
		names_box.remove_child(child)
		child.free()
	name_edits.clear()
	bot_checks.clear()
	for i in Settings.player_count:
		var row := HBoxContainer.new()
		row.add_theme_constant_override("separation", 8)
		names_box.add_child(row)

		var edit := LineEdit.new()
		edit.text = Settings.player_names[i]
		edit.placeholder_text = "Игрок %d" % (i + 1)
		edit.max_length = 16
		edit.size_flags_horizontal = Control.SIZE_EXPAND_FILL
		edit.add_theme_font_size_override("font_size", Settings.fs(16))
		row.add_child(edit)
		name_edits.append(edit)

		var bot := CheckBox.new()
		bot.text = "Бот"
		bot.button_pressed = Settings.is_bot(i)
		bot.add_theme_font_size_override("font_size", Settings.fs(14))
		bot.add_theme_color_override("font_color", Color(1, 1, 1, 0.85))
		bot.toggled.connect(_on_bot_toggled.bind(i))
		row.add_child(bot)
		bot_checks.append(bot)
	_sync_scroll_min()

func _sync_names_from_edits() -> void:
	for i in name_edits.size():
		Settings.set_player_name(i, (name_edits[i] as LineEdit).text)

func _on_count_selected(index: int) -> void:
	_sync_names_from_edits()
	Settings.set_player_count(index + Settings.MIN_PLAYERS)
	Settings.save_settings()
	_rebuild_names()

func _on_bot_toggled(pressed: bool, index: int) -> void:
	Settings.set_bot(index, pressed)
	Settings.save_settings()

func _on_require_30_toggled(pressed: bool) -> void:
	Settings.require_30 = pressed
	Settings.save_settings()

func _on_text_scale(index: int) -> void:
	Settings.text_scale = index
	Settings.save_settings()
	get_tree().reload_current_scene()

func _on_tile_step(index: int) -> void:
	Settings.tile_step = index
	Settings.save_settings()
	get_tree().reload_current_scene()

func _on_bot_level(index: int) -> void:
	Settings.bot_level = index
	Settings.save_settings()

func _on_start_pressed() -> void:
	_sync_names_from_edits()
	Settings.save_settings()
	get_tree().change_scene_to_file("res://scenes/game.tscn")


## Сетевое меню — последний ребёнок этого узла, поэтому рисуется поверх
## главного и перехватывает щелчки: отдельную сцену заводить незачем.
func _on_online_pressed() -> void:
	_sync_names_from_edits()
	Settings.save_settings()
	(online_lobby as OnlineLobby).open()
