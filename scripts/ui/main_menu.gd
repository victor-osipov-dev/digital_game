extends Control

var count_option: OptionButton = null
var names_box: VBoxContainer = null
var name_edits: Array = []
var bot_checks: Array = []
var check_30: CheckBox = null
var help_overlay: ColorRect = null
var stats_overlay: ColorRect = null
var menu_scroll: ScrollContainer = null
var menu_box: VBoxContainer = null
var online_lobby: Control = null
var _stats_games: Label = null
var _stats_wins: Label = null
var _stats_losses: Label = null
var _online_note: Label = null
var _room_actions: HBoxContainer = null
var _return_room_btn: Button = null
var _drop_room_btn: Button = null
var _scroll_drag := ScrollDrag.new()

func _sync_scroll_min() -> void:
	if menu_scroll == null or menu_box == null:
		return
	var c := menu_box.get_combined_minimum_size()
	var vp := get_viewport_rect().size
	menu_scroll.custom_minimum_size = Vector2(c.x, minf(c.y, vp.y))


# Сама механика (вернуться / покинуть с концами) — в онлайн-лобби. Здесь
# напоминание про активную комнату и две явные кнопки: без них игроку,
# вышедшему из партии или из лобби комнаты, некуда было бы ткнуться.
func _refresh_online_note(_room := {}) -> void:
	if _online_note == null:
		return
	var pending := Net.pending_room()
	_sync_scroll_min()
	if pending.is_empty():
		_online_note.visible = false
		_room_actions.visible = false
		return
	var playing := String(pending.get("state", "")) == "playing"
	_online_note.text = "Вы всё ещё в комнате %s: %s." % [
		String(pending.get("code", "?")),
		"партия идёт" if playing else "игроки в сборе",
	]
	_online_note.visible = true
	_room_actions.visible = true
	_sync_scroll_min()

func _ready() -> void:
	_build_ui()
	_rebuild_names()
	# Напоминание «вы всё ещё в комнате» на самом главном экране: сигнал
	# молчит при свежем входе, поэтому сразу читаем текущее состояние.
	Net.pending_room_changed.connect(_refresh_online_note)
	_refresh_online_note()


## Листание, начатое пальцем на кнопке, чекбоксе или поле ввода внутри
## прокручиваемой страницы (меню, лобби, наложения). См. ScrollDrag.
func _input(event: InputEvent) -> void:
	if _scroll_drag.input(self, event):
		return

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

	# Строка-напоминание, если игрок всё ещё числится в комнате (мягкий
	# выход из партии или выход из лобби комнаты в меню). Стоит вверху,
	# а не среди настроек: человек, вернувшийся в меню из партии, должен
	# увидеть «Вернуться в игру» сразу, без прокрутки.
	_online_note = Label.new()
	_online_note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_online_note.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_online_note.add_theme_font_size_override("font_size", Settings.fs(13))
	_online_note.add_theme_color_override("font_color", Color("FFE0B2"))
	_online_note.visible = false
	box.add_child(_online_note)

	# Явные кнопки «вернуться в игру» и «покинуть комнату насовсем»: они
	# должны быть видны, пока игрок числится в комнате, и прятаться вместе
	# с напоминанием, когда он вернулся или вышел с концами.
	_room_actions = HBoxContainer.new()
	_room_actions.alignment = BoxContainer.ALIGNMENT_CENTER
	_room_actions.add_theme_constant_override("separation", 12)
	_room_actions.visible = false
	box.add_child(_room_actions)

	_return_room_btn = Button.new()
	_return_room_btn.text = "Вернуться в игру"
	_return_room_btn.custom_minimum_size = Vector2(0, Settings.touch(46))
	_return_room_btn.add_theme_font_size_override("font_size", Settings.fs(15))
	_return_room_btn.pressed.connect(_on_return_room_pressed)
	_apply_accent_style(_return_room_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	_room_actions.add_child(_return_room_btn)

	_drop_room_btn = Button.new()
	_drop_room_btn.text = "Покинуть комнату"
	_drop_room_btn.custom_minimum_size = Vector2(0, Settings.touch(46))
	_drop_room_btn.add_theme_font_size_override("font_size", Settings.fs(15))
	_drop_room_btn.pressed.connect(_on_drop_room_pressed)
	_room_actions.add_child(_drop_room_btn)

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
	count_option.custom_minimum_size = Vector2(Settings.touch_w(110), Settings.touch(50))
	Settings.style_option(count_option, 17)
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
	# Подпись та же, что и в сетевом лобби: чекбокс не переносится, а
	# его ширина — ширина всей колонки меню; длиннее — на гигантском
	# строка уезжала за правый край экрана.
	check_30.text = "Первый ход: минимум 30 очков"
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
	start_btn.custom_minimum_size = Vector2(0, Settings.touch(58))
	start_btn.add_theme_font_size_override("font_size", Settings.fs(20))
	start_btn.pressed.connect(_on_start_pressed)
	_apply_accent_style(start_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	box.add_child(start_btn)

	# Сетевая кнопка стоит рядом с одиночной, но выглядит слабее: это
	# отдельный режим, и человек, который хочет поиграть с соседом за
	# одним столом, не должен промахиваться мимо привычной кнопки.
	var online_btn := Button.new()
	online_btn.text = "Играть по сети"
	online_btn.custom_minimum_size = Vector2(0, Settings.touch(50))
	online_btn.add_theme_font_size_override("font_size", Settings.fs(17))
	online_btn.pressed.connect(_on_online_pressed)
	_apply_accent_style(online_btn, Color("1F4E79"), Color("2A6CA8"), Color("163A5C"))
	box.add_child(online_btn)

	# Статистика — отдельной строкой, а не в нижнем ряду: там уже две
	# кнопки по 200px, третья при большом тексте не помещается по ширине.
	var stats_btn := Button.new()
	stats_btn.text = "Статистика"
	stats_btn.custom_minimum_size = Vector2(0, Settings.touch(50))
	stats_btn.add_theme_font_size_override("font_size", Settings.fs(17))
	stats_btn.pressed.connect(_on_stats_pressed)
	box.add_child(stats_btn)

	var bottom := HBoxContainer.new()
	bottom.alignment = BoxContainer.ALIGNMENT_CENTER
	bottom.add_theme_constant_override("separation", 14)
	box.add_child(bottom)

	var rules_btn := Button.new()
	rules_btn.text = "Как играть"
	rules_btn.custom_minimum_size = Vector2(200, Settings.touch(50))
	rules_btn.add_theme_font_size_override("font_size", Settings.fs(16))
	rules_btn.pressed.connect(func(): help_overlay.visible = true)
	bottom.add_child(rules_btn)

	var quit_btn := Button.new()
	quit_btn.text = "Выход"
	quit_btn.custom_minimum_size = Vector2(200, Settings.touch(50))
	quit_btn.add_theme_font_size_override("font_size", Settings.fs(16))
	quit_btn.pressed.connect(func(): get_tree().quit())
	bottom.add_child(quit_btn)

	_build_help_overlay()
	_build_stats_overlay()
	_build_online()
	# Контейнеры меню не ловят касание — иначе список настроек и кнопок
	# не проскроллить пальцем (кнопки и поля при этом остаются кликабельными).
	# Само окно лобби не трогаем: оно само себя гасит (mouse_filter = STOP).
	menu_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ScrollFix.relax(menu_box)
	ScrollFix.relax(help_overlay)
	ScrollFix.relax(stats_overlay)
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
	option.custom_minimum_size = Vector2(0, Settings.touch(42))
	Settings.style_option(option, 15)
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

	# MarginContainer, а не CenterContainer: окно занимает весь экран,
	# правила листаются на любом телефоне, «Закрыть» всегда под рукой.
	var mg := MarginContainer.new()
	mg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mg.add_theme_constant_override("margin_left", 10)
	mg.add_theme_constant_override("margin_right", 10)
	mg.add_theme_constant_override("margin_top", 10)
	mg.add_theme_constant_override("margin_bottom", 10)
	help_overlay.add_child(mg)

	var panel := PanelContainer.new()
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
	mg.add_child(panel)

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
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.custom_minimum_size = Vector2(0, Settings.touch(200))
	box.add_child(scroll)

	var rich := RichTextLabel.new()
	rich.bbcode_enabled = true
	rich.fit_content = true
	# Иначе жест глотает сам RichTextLabel и до ScrollContainer не доходит.
	rich.mouse_filter = Control.MOUSE_FILTER_IGNORE
	rich.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	rich.add_theme_font_size_override("normal_font_size", Settings.fs(15))
	rich.add_theme_font_size_override("bold_font_size", Settings.fs(17))
	rich.add_theme_color_override("default_color", Color(1, 1, 1, 0.88))
	rich.text = Rules.rules_text()
	scroll.add_child(rich)

	var close_btn := Button.new()
	close_btn.text = "Закрыть"
	close_btn.custom_minimum_size = Vector2(200, Settings.touch(52))
	close_btn.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	close_btn.add_theme_font_size_override("font_size", Settings.fs(17))
	close_btn.pressed.connect(func(): help_overlay.visible = false)
	box.add_child(close_btn)


## Экран статистики — тот же приём, что и «Правила»: полноэкранное
## притемнение с панелью поверх. Цифры подтягиваются при открытии,
## а не при сборке: после партии сцена меню могла не пересоздаваться.
func _build_stats_overlay() -> void:
	stats_overlay = ColorRect.new()
	stats_overlay.color = Color(0, 0, 0, 0.78)
	stats_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	stats_overlay.visible = false
	add_child(stats_overlay)

	var mg := MarginContainer.new()
	mg.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	mg.add_theme_constant_override("margin_left", 10)
	mg.add_theme_constant_override("margin_right", 10)
	mg.add_theme_constant_override("margin_top", 10)
	mg.add_theme_constant_override("margin_bottom", 10)
	stats_overlay.add_child(mg)

	var center := CenterContainer.new()
	mg.add_child(center)

	var panel := PanelContainer.new()
	var psb := StyleBoxFlat.new()
	psb.bg_color = Color("1B2029")
	psb.set_corner_radius_all(14)
	psb.border_color = Color(1, 1, 1, 0.25)
	psb.set_border_width_all(2)
	psb.content_margin_left = 24.0
	psb.content_margin_right = 24.0
	psb.content_margin_top = 18.0
	psb.content_margin_bottom = 18.0
	panel.add_theme_stylebox_override("panel", psb)
	center.add_child(panel)

	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 14)
	panel.add_child(box)

	var title := Label.new()
	title.text = "Статистика"
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", Settings.fs(22))
	title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(title)

	_stats_games = _make_stat_row(box, "Сыграно партий:")
	_stats_wins = _make_stat_row(box, "Побед:")
	_stats_losses = _make_stat_row(box, "Поражений:")

	var close_btn := Button.new()
	close_btn.text = "Закрыть"
	close_btn.custom_minimum_size = Vector2(Settings.touch_w(200), Settings.touch(52))
	close_btn.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	close_btn.add_theme_font_size_override("font_size", Settings.fs(17))
	close_btn.pressed.connect(func(): stats_overlay.visible = false)
	box.add_child(close_btn)


func _make_stat_row(parent: Control, caption: String) -> Label:
	var lab := Label.new()
	lab.text = caption + " 0"
	lab.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	lab.add_theme_font_size_override("font_size", Settings.fs(18))
	lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	parent.add_child(lab)
	return lab


## Открытие статистики: цифры читаем здесь, в момент показа, — иначе
## после партии, сыгранной без перезахода в меню, висели бы старые.
func _on_stats_pressed() -> void:
	_stats_games.text = "Сыграно партий: %d" % Settings.stat_games
	_stats_wins.text = "Побед: %d" % Settings.stat_wins
	_stats_losses.text = "Поражений: %d" % Settings.stat_losses
	stats_overlay.visible = true

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
		edit.custom_minimum_size = Vector2(0, Settings.touch(46))
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
	# Явный выбор одиночной партии: «застрявшая» комната и онлайн-сессия
	# тут ни при чём. Без заказа сцена сама догадываться не должна —
	# иначе «Начать игру» после мягкого выхода из онлайн-партии снова
	# тащило бы нас в неё.
	Net.plan_game(false)
	get_tree().change_scene_to_file("res://scenes/game.tscn")


## Сетевое меню — последний ребёнок этого узла, поэтому рисуется поверх
## главного и перехватывает щелчки: отдельную сцену заводить незачем.
func _on_online_pressed() -> void:
	_sync_names_from_edits()
	Settings.save_settings()
	(online_lobby as OnlineLobby).open()


## «Вернуться в игру» на главном экране: партию дополучит сама сцена,
## комнату покажет сетевой экран. Кнопка есть только пока pending не пуст.
func _on_return_room_pressed() -> void:
	_sync_names_from_edits()
	Settings.save_settings()
	(online_lobby as OnlineLobby).return_to_room()


## «Покинуть комнату» на главном экране: полный выход, место освобождается.
func _on_drop_room_pressed() -> void:
	_sync_names_from_edits()
	Settings.save_settings()
	(online_lobby as OnlineLobby).drop_room_now()
