extends Control

const SLOT_HOVER_DELAY_MS := 400
const SLOT_HOVER_MOVE_PX := 6.0
const SLOT_HOVER_EDGE := 10.0
const SLOT_GRACE_MS := 1500
const HINT_MIN_H := 100.0
const DRAG_SCROLL_ZONE := 64.0
const DRAG_SCROLL_OVERSHOOT := 40.0
const DRAG_SCROLL_SPEED := 480.0
# Превью хода шлём повторно, пока тянем, — иначе соперник не отличит
# долгое «он думает тут» от брошенного призрака упавшего клиента.
const PEEK_RESEND_MS := 2000
const PEEK_EXPIRE_MS := 5000
# Черновик стола шлём повторно, пока ход не завершён, — иначе соперник
# с потерянным пакетом или вошедший посреди хода увидит пустой стол.
const DRAFT_RESEND_MS := 3000
# Страховка: черновик не должен пережить упавшего/молчащего автора —
# завершение хода приходит game.state и гасит его и так.
const DRAFT_EXPIRE_MS := 15000

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
var _toast_panel: PanelContainer = null
var draw_dialog: ConfirmationDialog = null
var menu_dialog: ConfirmationDialog = null
var toast_tween: Tween = null
var title_tween: Tween = null
var _again_btn: Button = null

var _drag_view: TileView = null
var _row_slots: Array = []
var _bot_active: bool = false
var _bot_seq: int = 0
var _hint_ids: Array = []
var _slot_hover_pos: int = -1
var _slot_hover_time: int = 0
var _slot_hover_last: Vector2 = Vector2.ZERO
var _slot_grace_until: int = 0
var _pan_pressed: bool = false
var _pan_pos: Vector2 = Vector2.ZERO
var _pan_press_on_tile: bool = false
var _scroll_drag := ScrollDrag.new()

# --- сетевой режим -------------------------------------------------------
#
# В сетевой игре экран устроен так же, но решения принимает сервер. Мест,
# где клиент решает за него, тут ровно три: завершение хода, взятие из
# колоды и пропуск. Перетаскивание фишек остаётся локальным — стол
# переделывается у нас и уходит наверх одним куском.
var _online: bool = false
var _sending: bool = false
var _wait_label: Label = null
var _wait_panel: PanelContainer = null
var _grace: float = 0.0
var _paused: bool = false
var _waiting: bool = false

# --- анимация чужих ходов ------------------------------------------------
#
# Сетевое состояние приходит целиком и сразу, а увидеть хочется, КАК
# соперник расставлял фишки. Поэтому перед перерисовкой, заказанной
# состоянием с сервера, запоминаем, где каждая показанная фишка стояла
# (снимок), а после раскладки двигаем новые твины: новые фишки прилетают
# сверху, сдвинутые переезжают, ушедшие улетают вверх призраком.
var _anim_pending: bool = false

# --- отсчёт хода (сетевая партия) ---------------------------------------
#
# Дедлайн в тиках из view.turnLeft, обновляется на каждый game.state;
# между состояниями секунды считает сам клиент (_process). Панелька в
# раскладке показывает, сколько осталось текущему игроку — всем видно.
var _turn_deadline_ms: int = 0
var _turn_timer_panel: PanelContainer = null
var _turn_timer_label: Label = null

# --- превью ходов соперника (game.peek) ----------------------------------
#
# Пока игрок перебирает варианты, сервер пересылает остальным, куда он
# смотрит; здесь это рисуется призраком фишки над столом.
var _peek_layer: Control = null
var _peek_ghost: TileView = null
var _peek_slot: Control = null
var _peek_drag: Dictionary = {}
var _last_peek: Dictionary = {}
var _peek_resent_ms: int = 0
var _peek_at_ms: int = 0

# --- черновик стола (game.draft) ------------------------------------------
#
# Соперник шлёт ВЕСЬ свой стол после каждого локального изменения: пока
# он раскладывает, показываем его вместо базового, выложенные в этот ход
# фишки — серыми. Принятая сторона:
var _draft_rows: Array = []          # ряды соперника [{id, tiles}, ...]
var _draft_from: int = -1            # сид автора, -1 — черновика нет
var _draft_grey_ids: Dictionary = {} # id фишек, которые показываем серыми
var _draft_at_ms: int = 0            # когда пришёл последний пакет
# Отправная сторона (своё окно): таблица последнего отправленного стола —
# чтобы шлём только при изменении, а не на каждом кадре.
var _last_draft_json: String = ""
var _draft_sent_ms: int = 0
var _draft_tick_ms: int = 0

# --- статистика -----------------------------------------------------------
#
# Завершённая партия считается один раз: узел пересобирается при смене
# размера текста, а сервер у уже конченной партии может прислать своё
# состояние повторно (режоин после переподключения).
var _stats_recorded: bool = false

func _ready() -> void:
	_build_ui()
	resized.connect(_on_resized)
	# Кто открыл сцену, тот и заказал режим: «Начать игру» — локально,
	# вход/возврат в партию — по сети. Судить по «есть сессия и связь»
	# нельзя: после мягкого выхода из онлайн-партии это всегда true, и
	# «Начать игру» возвращало бы игрока в брошенную партию.
	if Net.consume_game_intent():
		_online = true
		_net_begin()
		Net.game_state.connect(_on_net_state)
		Net.game_error.connect(_on_net_error)
		Net.game_lost.connect(_on_net_lost)
		Net.connection_changed.connect(_on_net_connection)
		Net.game_peek.connect(_on_net_peek)
		Net.game_draft.connect(_on_net_draft)
		# TOAST от сервера (например, «время хода вышло») — обычным тостом.
		Net.notice.connect(toast)
		# Состояние уже могло прийти, пока сцена грузилась.
		_apply_state(Net.pending_state(), 0.0, false)
		_net_rejoin()
	else:
		_new_match()

func _process(_delta: float) -> void:
	if _drag_view != null and not Input.is_mouse_button_pressed(MOUSE_BUTTON_LEFT):
		_end_drag()
	if _drag_view != null and is_instance_valid(_drag_view):
		_update_row_slot_hover()
		_auto_scroll_drag(_delta)
		_update_peek()
	_update_hint_zone_size()
	_update_turn_timer()
	_expire_peek()
	_sync_peek_slot()
	_expire_draft()
	# Раз в секунду — шанс повторить висящий черновик (только если он уже
	# был отправлен: чистый стол отправлять нечего).
	var now := Time.get_ticks_msec()
	if now - _draft_tick_ms >= 1000:
		_draft_tick_ms = now
		_maybe_send_draft()

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

	# Верхняя строка — в потоке, а не в одном ряду: при гигантском
	# шесть кнопок с крупным текстом не влезают в 576, и строка
	# переезжает на вторую линию, а не уезжает за правый край.
	var top := FlowContainer.new()
	top.add_theme_constant_override("h_separation", 6)
	top.add_theme_constant_override("v_separation", 6)
	layout.add_child(top)

	deck_button = Button.new()
	deck_button.custom_minimum_size = Vector2(92, Settings.touch(52))
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
	help_btn.custom_minimum_size = Vector2(44, Settings.touch(46))
	help_btn.add_theme_font_size_override("font_size", Settings.fs(20))
	help_btn.pressed.connect(_open_help)
	top.add_child(help_btn)

	var settings_btn := _make_top_button("Настр.", "Размер текста и карточек", _open_settings)
	top.add_child(settings_btn)

	var menu_btn := Button.new()
	menu_btn.text = "Меню"
	menu_btn.custom_minimum_size = Vector2(68, Settings.touch(46))
	menu_btn.add_theme_font_size_override("font_size", Settings.fs(14))
	menu_btn.pressed.connect(func(): menu_dialog.popup_centered())
	top.add_child(menu_btn)

	# Строка состояния хода («Ход соперника», «Нет связи…») — отдельная
	# панель в потоке раскладки, а не абсолютная накладка: на телефоне
	# старые координаты наезжали на строку имён игроков с числом карточек.
	var wait_panel := PanelContainer.new()
	var wsb := StyleBoxFlat.new()
	wsb.bg_color = Color(0.10, 0.14, 0.21, 0.95)
	wsb.border_color = Color(0.56, 0.73, 0.98, 0.45)
	wsb.set_border_width_all(1)
	wsb.set_corner_radius_all(8)
	wsb.content_margin_left = 10.0
	wsb.content_margin_right = 10.0
	wsb.content_margin_top = 4.0
	wsb.content_margin_bottom = 4.0
	wait_panel.add_theme_stylebox_override("panel", wsb)
	layout.add_child(wait_panel)
	wait_panel.visible = false
	_wait_panel = wait_panel
	_wait_label = Label.new()
	_wait_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_wait_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_wait_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_wait_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_wait_label.add_theme_font_size_override("font_size", Settings.fs(15))
	_wait_label.add_theme_color_override("font_color", Color("90CAF9"))
	_wait_label.visible = false
	wait_panel.add_child(_wait_label)

	# Отсчёт текущего хода — отдельной строкой, а не внутри панели
	# состояния: та показывается только когда есть что сообщить, а
	# «сколько секунд осталось» нужно видеть и на своём ходу.
	_turn_timer_panel = PanelContainer.new()
	var tpb := StyleBoxFlat.new()
	tpb.bg_color = Color(0.16, 0.12, 0.05, 0.95)
	tpb.border_color = Color("FFD54F")
	tpb.set_border_width_all(1)
	tpb.set_corner_radius_all(8)
	tpb.content_margin_left = 10.0
	tpb.content_margin_right = 10.0
	tpb.content_margin_top = 4.0
	tpb.content_margin_bottom = 4.0
	_turn_timer_panel.add_theme_stylebox_override("panel", tpb)
	layout.add_child(_turn_timer_panel)
	_turn_timer_panel.visible = false
	_turn_timer_label = Label.new()
	_turn_timer_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	_turn_timer_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_turn_timer_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_turn_timer_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_turn_timer_label.add_theme_font_size_override("font_size", Settings.fs(15))
	_turn_timer_label.add_theme_color_override("font_color", Color("FFD54F"))
	_turn_timer_panel.add_child(_turn_timer_label)

	# Превью хода соперника — призрак фишки над столом. Накладка вне
	# раскладки: не двигает стол, не перехватывает касания.
	_peek_layer = Control.new()
	_peek_layer.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_peek_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_peek_layer)

	# Подсказки и короткие сообщения — оверлей ПОВЕРХ поля: ничего не добавляют
	# в раскладку и не сдвигают её, крупный текст с фоном читается поверх стола.
	var toast_host := Control.new()
	toast_host.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	toast_host.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(toast_host)
	var toast_center := CenterContainer.new()
	toast_center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	toast_center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	toast_host.add_child(toast_center)
	var toast_panel := PanelContainer.new()
	var tsb := StyleBoxFlat.new()
	tsb.bg_color = Color(0.06, 0.08, 0.11, 0.94)
	tsb.border_color = Color(0.55, 0.75, 0.62, 0.7)
	tsb.set_border_width_all(2)
	tsb.set_corner_radius_all(14)
	tsb.content_margin_left = 18.0
	tsb.content_margin_right = 18.0
	tsb.content_margin_top = 12.0
	tsb.content_margin_bottom = 12.0
	toast_panel.add_theme_stylebox_override("panel", tsb)
	toast_panel.mouse_filter = Control.MOUSE_FILTER_STOP
	toast_panel.gui_input.connect(_on_toast_input)
	toast_center.add_child(toast_panel)
	toast_panel.visible = false
	_toast_panel = toast_panel
	toast_label = Label.new()
	toast_label.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	toast_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	toast_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	toast_label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	toast_label.add_theme_font_size_override("font_size", Settings.fs(22))
	toast_label.visible = false
	toast_panel.add_child(toast_label)
	_fit_toast_width()

	var chips_scroll := ScrollContainer.new()
	chips_scroll.custom_minimum_size = Vector2(0, Settings.touch(34))
	chips_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	layout.add_child(chips_scroll)
	chips_box = HBoxContainer.new()
	chips_box.add_theme_constant_override("separation", 6)
	# Контейнер чипов не ловит касание: иначе полосу с числами нельзя
	# свайпнуть вбок (собственные карточки-чипы клика не требуют).
	chips_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	chips_scroll.add_child(chips_box)

	table_scroll = ScrollContainer.new()
	table_scroll.size_flags_vertical = Control.SIZE_EXPAND_FILL
	table_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	layout.add_child(table_scroll)

	table_box = VBoxContainer.new()
	table_box.add_theme_constant_override("separation", 6)
	table_box.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	table_box.mouse_filter = Control.MOUSE_FILTER_PASS
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

	# Рука — в собственной панели, а не просто на общем фоне: без
	# подложки и рамки её фишки визуально сливаются с рядами стола,
	# особенно когда стол короткий и обе зоны стоят вплотную. Панель
	# ловит клики только в своих отступах — зона фишек осталась у
	# hand_flow, drop-проверки работают по её global_rect как раньше.
	var hand_panel := PanelContainer.new()
	var hpsb := StyleBoxFlat.new()
	hpsb.bg_color = Color(1, 1, 1, 0.07)
	hpsb.border_color = Color(1, 1, 1, 0.30)
	hpsb.set_border_width_all(2)
	hpsb.set_corner_radius_all(12)
	hpsb.content_margin_left = 8.0
	hpsb.content_margin_right = 8.0
	hpsb.content_margin_top = 6.0
	hpsb.content_margin_bottom = 8.0
	hand_panel.add_theme_stylebox_override("panel", hpsb)
	layout.add_child(hand_panel)

	hand_flow = FlowTiles.new()
	hand_flow.controller = self
	hand_flow.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	hand_panel.add_child(hand_flow)

	var bottom := HBoxContainer.new()
	bottom.add_theme_constant_override("separation", 10)
	layout.add_child(bottom)

	undo_button = Button.new()
	undo_button.text = "Отменить ход"
	undo_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	undo_button.custom_minimum_size = Vector2(0, Settings.touch(52))
	undo_button.add_theme_font_size_override("font_size", Settings.fs(16))
	undo_button.pressed.connect(_on_undo_pressed)
	bottom.add_child(undo_button)

	end_button = Button.new()
	end_button.text = "Взять"
	end_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	end_button.custom_minimum_size = Vector2(0, Settings.touch(52))
	end_button.add_theme_font_size_override("font_size", Settings.fs(16))
	end_button.pressed.connect(_on_main_pressed)
	_apply_accent_style(end_button, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	bottom.add_child(end_button)

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
	menu_dialog.confirmed.connect(_on_leave_to_menu)
	_style_dialog(menu_dialog)
	add_child(menu_dialog)

func _on_leave_to_menu() -> void:
	# Из сетевой партии выход — это мягкий выход из комнаты на сервере:
	# место и партия держатся за игроком, и главное меню предложит
	# вернуться или покинуть комнату с концами. Полный выход — room.drop.
	if _online:
		_net_unwatch()
		if state != null and state.finished:
			# Партия закончилась — возвращаться в неё нечего, «застрявшей»
			# комнаты быть не должно: освобождаем место сразу.
			Net.drop_room()
		else:
			Net.leave_room()
	get_tree().change_scene_to_file("res://scenes/main_menu.tscn")

func _style_dialog(dialog: ConfirmationDialog) -> void:
	# Диалог с двумя выборами («Выйти»/«Отмена») при большом тексте не
	# должен оставаться крошечным: окно раздвигаем, кнопки делаем высокими.
	var maxw := int(minf(Settings.touch(420), get_viewport_rect().size.x * 0.9))
	dialog.min_size = Vector2i(maxw, 0)
	var lab := dialog.get_label()
	if lab != null:
		lab.add_theme_font_size_override("font_size", Settings.fs(17))
		lab.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	for b in [dialog.get_ok_button(), dialog.get_cancel_button()]:
		if b != null:
			b.add_theme_font_size_override("font_size", Settings.fs(16))
			b.custom_minimum_size = Vector2(Settings.touch_w(120), Settings.touch(52))

func _make_top_button(text_value: String, tip: String, handler: Callable) -> Button:
	var btn := Button.new()
	btn.text = text_value
	btn.tooltip_text = tip
	btn.custom_minimum_size = Vector2(60, Settings.touch(46))
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
	pass_title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	pass_title.add_theme_font_size_override("font_size", Settings.fs(18))
	pass_title.add_theme_color_override("font_color", Color(1, 1, 1, 0.7))
	box.add_child(pass_title)

	pass_name = Label.new()
	pass_name.text = ""
	pass_name.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	pass_name.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	pass_name.add_theme_font_size_override("font_size", Settings.fs(34))
	pass_name.add_theme_color_override("font_color", Color("90CAF9"))
	box.add_child(pass_name)

	pass_ready_button = Button.new()
	pass_ready_button.text = "Готов(-а)"
	pass_ready_button.custom_minimum_size = Vector2(Settings.touch_w(220), Settings.touch(60))
	pass_ready_button.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	pass_ready_button.add_theme_font_size_override("font_size", Settings.fs(20))
	pass_ready_button.pressed.connect(_on_pass_ready)
	_apply_accent_style(pass_ready_button, Color("1565C0"), Color("1976D2"), Color("0D47A1"))
	box.add_child(pass_ready_button)

## Полоска статуса сетевой партии: чей ход, есть ли связь.
##
## Отдельная метка, а не тост, потому что показывает СОСТОЯНИЕ, которое
## держится секундами и десятками секунд. Тост для этого не годится: он
## исчезает, и через пару секунд игрок снова не понимает, почему стол не
## реагирует на перетаскивание.
func _show_wait(text: String) -> void:
	if _wait_label == null:
		return
	_wait_label.text = text
	_wait_label.visible = not text.is_empty()
	_wait_panel.visible = _wait_label.visible

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
	win_title.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	win_title.add_theme_font_size_override("font_size", Settings.fs(32))
	win_title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(win_title)

	var btn_box := HBoxContainer.new()
	btn_box.alignment = BoxContainer.ALIGNMENT_CENTER
	btn_box.add_theme_constant_override("separation", 14)
	box.add_child(btn_box)

	var again_btn := Button.new()
	again_btn.text = "Заново"
	again_btn.custom_minimum_size = Vector2(Settings.touch_w(180), Settings.touch(60))
	again_btn.add_theme_font_size_override("font_size", Settings.fs(19))
	again_btn.pressed.connect(_new_match)
	_apply_accent_style(again_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	btn_box.add_child(again_btn)
	_again_btn = again_btn

	var to_menu_btn := Button.new()
	to_menu_btn.text = "В меню"
	to_menu_btn.custom_minimum_size = Vector2(Settings.touch_w(180), Settings.touch(60))
	to_menu_btn.add_theme_font_size_override("font_size", Settings.fs(19))
	to_menu_btn.pressed.connect(_on_leave_to_menu)
	btn_box.add_child(to_menu_btn)

func _build_help_overlay() -> void:
	help_overlay = ColorRect.new()
	help_overlay.color = Color(0, 0, 0, 0.78)
	help_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	help_overlay.visible = false
	add_child(help_overlay)

	# MarginContainer, а не CenterContainer: окно должно занять весь экран,
	# чтобы правила листались на любом телефоне, а кнопка «Закрыть» всегда
	# оставалась под рукой, а не уезжала за нижний край.
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
	# Без этого жест глотает сам RichTextLabel (STOP по умолчанию) и до
	# ScrollContainer не доходит: окно правил на телефоне не листалось.
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
	# Полоса сетевого статуса переживает пересборку интерфейса: иначе
	# смена размера текста на секунду стёрла бы «нет связи».
	var wait_t := _wait_label.text if _wait_label != null else ""
	for child in get_children():
		remove_child(child)
		child.free()
	_build_ui()
	if state == null:
		_new_match()
		return
	_show_wait(wait_t)
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
	close_btn.custom_minimum_size = Vector2(200, Settings.touch(52))
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
	option.custom_minimum_size = Vector2(0, Settings.touch(42))
	Settings.style_option(option, 15)
	for n in names:
		option.add_item(n)
	option.select(clampi(current, 0, names.size() - 1))
	option.item_selected.connect(handler)
	row.add_child(option)
	return row

# ---------------------------------------------------------------- match flow

func _new_match() -> void:
	_online = false
	_bot_seq += 1
	_bot_active = false
	_stats_recorded = false
	_hint_ids.clear()
	state = GameState.create(Settings.player_count, Array(Settings.player_names), Settings.require_30)
	invalid_row_ids.clear()
	win_overlay.visible = false
	pass_overlay.visible = false
	_show_wait("")
	_show_pass(true)

func _is_bot_turn() -> bool:
	if _online:
		return false
	return state != null and Settings.is_bot(state.current)

## Можно ли сейчас трогать стол. В сетевой игре — только на своём ходу и
## не пока ждём ответа сервера: иначе можно было бы отправить второй ход
## поверх первого, и они бы смешались.
func _can_act() -> bool:
	if state == null or state.finished or _bot_active or _is_bot_turn():
		return false
	if _online:
		# Ожидание второго игрока: сервер всё равно не примет ход, но
		# и кнопки не должны выглядеть рабочими.
		return state.my_turn() and not _sending and not _waiting
	return true


# ------------------------------------------------------------ сетевой режим

## args у _send_and_wait — не украшение. Пока ждём ответа сервера, он
## присылает новое состояние и подменяет state целиком. Значит ops для
## set_table надо посчитать ДО отправки, из уже проверенного стола, а не
## брать из state внутри замыкания — к тому моменту там уже другой ход.

## Начало сетевой партии: прячем оверлеи одиночной игры.
##
## «Передайте устройство игроку» и «Готов(-а)» в сетевой игре неуместны:
## у каждого игрока своё устройство, и «готов» означал бы ожидание
## несуществующего действия.
func _net_begin() -> void:
	pass_overlay.visible = false
	win_overlay.visible = false
	_bot_seq += 1
	_bot_active = false
	_hint_ids.clear()
	# «Заново» на экране победы — это про локальную партию: сервер не умеет
	# «сыграть ещё раз в той же комнате». В сетевой игре кнопка скрывается,
	# иначе после конца партии она молча запускала локальную игру поверх
	# живого места в комнате.
	if _again_btn != null:
		_again_btn.visible = false


func _net_unwatch() -> void:
	if Net.game_state.is_connected(_on_net_state):
		Net.game_state.disconnect(_on_net_state)
	if Net.game_error.is_connected(_on_net_error):
		Net.game_error.disconnect(_on_net_error)
	if Net.game_lost.is_connected(_on_net_lost):
		Net.game_lost.disconnect(_on_net_lost)
	if Net.connection_changed.is_connected(_on_net_connection):
		Net.connection_changed.disconnect(_on_net_connection)
	if Net.game_peek.is_connected(_on_net_peek):
		Net.game_peek.disconnect(_on_net_peek)
	if Net.game_draft.is_connected(_on_net_draft):
		Net.game_draft.disconnect(_on_net_draft)
	if Net.notice.is_connected(toast):
		Net.notice.disconnect(toast)
	_clear_peek()
	_clear_draft()


## Переспрашивает состояние после входа в сцену: пока грузились текстуры
## и строились кнопки, сервер мог прислать ход соперника. Без этого
## игрок увидел бы устаревший стол и «сходил» поверх чужого.
##
## Ответ реджойна приходит ЛИЧНО (с rid) и _dispatch его не видит —
## «состояние придёт сигналом» неверно, применять его надо здесь.
func _net_rejoin() -> void:
	_sending = true
	var res := await Net.rejoin_game()
	_sending = false
	if String(res.get("t", "")) == NetProtocol.GAME_STATE:
		# Вернулись в партию: «застрявшей комнаты» больше нет.
		Net.clear_pending_room()
		_on_state_received(res.get("state", {}), float(res.get("grace", 0.0)),
			bool(res.get("paused", false)), bool(res.get("waiting", false)))
		return
	# Партия не найдена (сервер перезапустили) либо место уже потеряно.
	Net.clear_pending_room()
	toast(String(res.get("reason", "партия недоступна")), true)
	_net_unwatch()
	get_tree().change_scene_to_file("res://scenes/main_menu.tscn")


func _on_net_state(view: Dictionary, grace: float, paused: bool, waiting: bool) -> void:
	_on_state_received(view, grace, paused, waiting)


func _on_state_received(view: Dictionary, grace: float, paused: bool, waiting: bool) -> void:
	_sending = false
	_hint_ids.clear()
	invalid_row_ids.clear()
	# Состояние с сервера — единственный источник «прилетающих» фишкок.
	# Локальные перерисовки (перетаскивание, подсказки) анимировать нельзя:
	# там ничего не «прилетает», фишка уже лежит на месте.
	_anim_pending = true
	_apply_state(view, grace, paused, waiting)
	# Чужой ход — показываем, кто ходит. Наш собственный ход требует
	# действия игрока, и подсказка с названием мешала бы.
	if state != null and state.finished:
		_record_stats()
		win_title.text = "Победитель - %s" % state.player_name(state.winner)
		win_overlay.visible = true
		_show_wait("")
		refresh()
		return
	pass_overlay.visible = false
	if state != null and not state.my_turn():
		_show_turn_title()
	_show_wait(_wait_text(grace, paused, waiting))
	refresh()


func _wait_text(grace: float, paused: bool, waiting: bool) -> String:
	if waiting:
		# Второго игрока нет, и это важнее чьего-либо хода: кнопки всё
		# равно заблокированы сервером, а надпись объясняет, почему.
		return "Ждём второго игрока: партия на паузе."
	if paused:
		return "Игра на паузе: кто-то отвалился. Ждём возвращения."
	if state != null and (state.finished or state.my_turn()):
		# Наш ход (или партия кончилась) — «ход соперника» здесь врёт:
		# чужая очередь показывается только когда ходит соперник. Иначе,
		# едва ход вернулся к нам, надпись про «соперника» висела бы над
		# нами же подсвеченной фишкой — наоборот.
		return ""
	if grace > 0.0:
		return "Соперник не отвечает. Осталось ждать %d с." % int(ceil(grace))
	# Отсчёт показывает отдельная строка таймера — дублировать её словами
	# «Ход соперника» не нужно. Без отсчёта (старый сервер) строка остаётся.
	if _online and _turn_deadline_ms > Time.get_ticks_msec():
		return ""
	return "Ход соперника"


func _apply_state(view: Dictionary, grace: float, paused: bool, waiting: bool = false) -> void:
	if view.is_empty():
		return
	_grace = grace
	_paused = paused
	_waiting = waiting
	# Превью чужого хода после нового состояния уже лож: строки могли
	# сдвинуться, а перебирать перестали.
	_clear_peek()
	# Промежуточные game.state (реждойн, пауза, обновление отсчёта) не
	# гасят чужой черновик, пока ход его автора не кончился: иначе серые
	# фишки пропадали бы от любого состояния, прилетевшего посреди хода.
	var draft_kept := _draft_active()
	# Отправная сторона черновика: с новым состоянием начинаем с чистого
	# листа, иначе следующий ход не отправился бы «как в первый раз».
	_last_draft_json = ""
	_draft_sent_ms = 0
	# Отсчёт сервера. Пришло null (пауза/ожидание/конец) — ключа в
	# словаре нет вовсе, и дедлайн гаснет сам.
	var turn_left := int(view.get("turnLeft", 0))
	_turn_deadline_ms = (Time.get_ticks_msec() + turn_left * 1000) if turn_left > 0 else 0
	var prev := state
	state = ViewBuilder.build(view)
	# Рассылка посреди нашего хода (обрыв/возврат соперника, реджойн)
	# пришла с тем же серверным столом — локальную раскладку возвращаем,
	# иначе автор теряет фишки и перестаёт повторять черновик.
	state.keep_local_turn_from(prev)
	if draft_kept:
		if state.finished or state.current != _draft_from:
			_clear_draft()
		else:
			# База сервера могла обновиться — серые пересчитываем
			# относительно неё, срок жизни черновика остаётся прежним.
			_draft_grey_ids = _draft_grey_of(_draft_rows)
	elif _draft_from >= 0:
		_clear_draft()
	_show_wait(_wait_text(grace, paused, waiting))


func _on_net_error(reason: String, hard: bool, errors: Array) -> void:
	_sending = false
	invalid_row_ids.clear()
	# state может быть ещё null: отказ приходит раньше первого game.state,
	# если сервер отверг ход прямо после входа в партию.
	for e in errors:
		if state == null:
			break
		var idx := int(e.get("row", -1))
		if idx >= 0 and idx < state.table.size():
			invalid_row_ids.append((state.table[idx] as GameState.Row).id)
	toast(reason, true)
	# hard = сервер уже откатил наш стол и пришлёт game.state следом.
	# Не откатываем сами: за нас это сделает серверное состояние, и два
	# откатa подряд вернули бы игрока к несуществующему прошлому.
	if not hard:
		refresh()


func _on_net_lost(reason: String) -> void:
	_net_unwatch()
	toast(reason, true)
	await get_tree().create_timer(1.6).timeout
	get_tree().change_scene_to_file("res://scenes/main_menu.tscn")


func _on_net_connection(connected: bool, detail: String) -> void:
	if connected:
		_show_wait("")
		# Связь восстановилась. Переспрашиваем партию целиком: за время
		# обрыва соперник мог сходить. Вход в аккаунт больше НЕ возвращает
		# игрока в партию рассылкой, поэтому здесь это делает сам клиент.
		if _online and not _sending:
			_net_rejoin()
		return
	# Связи нет — показываем это на экране, а не тостом: молчащий
	# интерфейс во время сетевой партии выглядит как зависание.
	_show_wait("Нет связи: %s" % detail)
	refresh()


## Отправляет готовый стол и ждёт вердикта. Сорванная связь тут же
## возвращает управление: ждать бесконечно нельзя, партия может
## продолжаться после переподключения.
func _send_and_wait(send: Callable, args: Array = []) -> void:
	if _sending:
		return
	_sending = true
	_show_wait("Отправляем ход…")
	refresh()
	var res: Dictionary = await send.callv(args)
	_sending = false
	if not Net.is_linked():
		_show_wait("Нет связи с сервером")
	elif String(res.get("t", "")) == NetProtocol.GAME_STATE:
		# Личный ответ сервера на наш ход и есть актуальное состояние
		# партии: сходившему рассылку не дублируют, и, если ответ
		# проигнорировать, собственный экран до чужого хода висел бы в
		# устаревшем состоянии («я всё ещё хожу» — как после взятия
		# карточки или передачи хода).
		_on_state_received(res.get("state", {}), float(res.get("grace", 0.0)),
			bool(res.get("paused", false)), bool(res.get("waiting", false)))
	elif String(res.get("t", "")) == NetProtocol.GAME_ERROR:
		# Отказ пришёл персонально нам: рассылки с ним нет, и молчание
		# выглядело бы как зависание.
		toast(String(res.get("reason", "Ход отклонён")), true)
	elif state != null and state.my_turn() and not state.finished:
		# Сервер ещё не ответил (или ответил отказом без своего состояния):
		# управление возвращаем, иначе кнопки останутся мёртвыми навсегда.
		_show_wait("")
	refresh()

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
	var who := state.current_player().pname
	# Серверный бот ходит сам, и пометить его обязаны: иначе партия,
	# сидящая на паузе или идущая на чужих устройствах, выглядит как
	# молчащий человек с выключенным экраном.
	if state.is_bot_player(state.current):
		who += " (бот)"
	turn_title_label.text = "Ход: %s" % who
	turn_title_overlay.visible = true
	turn_title_overlay.modulate.a = 0.0
	if title_tween != null and title_tween.is_running():
		title_tween.kill()
	title_tween = create_tween()
	title_tween.tween_property(turn_title_overlay, "modulate:a", 1.0, 0.3)
	title_tween.tween_interval(0.7)
	title_tween.tween_property(turn_title_overlay, "modulate:a", 0.0, 0.35)
	title_tween.tween_callback(func(): turn_title_overlay.visible = false)

# ---------------------------------------------------------------- отсчёт хода

## Строка «Ваш ход — 42 с» / «Ход: Игрок — 31 с». Считает локально от
## дедлайна, приехавшего в view.turnLeft; сама строка гаснет, когда
## отсчёта быть не должно (пауза, ожидание, конец партии).
func _update_turn_timer() -> void:
	if _turn_timer_label == null:
		return
	if not _online or state == null or state.finished or _waiting or _paused \
			or _turn_deadline_ms <= 0:
		_turn_timer_panel.visible = false
		return
	var left := int(ceil(float(_turn_deadline_ms - Time.get_ticks_msec()) / 1000.0))
	if left <= 0:
		# Дедлайн прошёл: сервер сейчас пришлёт новое состояние (авто-ход),
		# до него строку не показываем — цифра «0 с» ничего не объясняет.
		_turn_timer_panel.visible = false
		return
	var who := "Ваш ход" if state.my_turn() else "Ход: %s" % state.current_player().pname
	if not state.my_turn() and state.is_bot_player(state.current):
		who += " (бот)"
	_turn_timer_label.text = "%s — %d с" % [who, left]
	_turn_timer_label.add_theme_color_override(
		"font_color", Color("EF5350") if left <= 10 else Color("FFD54F"))
	_turn_timer_panel.visible = true


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
	_record_stats()
	win_title.text = "Победитель - %s" % state.player_name(state.winner)
	win_overlay.visible = true


## Одна запись в статистику на партию. Победа — за нами: в одиночной
## партии боту она в счёт не идёт, в сетевой — сид соперника. Финиш
## без победителя (winner < 0) учитывается только как сыгранная партия.
func _record_stats() -> void:
	if _stats_recorded or state == null or not state.finished:
		return
	_stats_recorded = true
	var won := false
	var lost := false
	if state.winner >= 0:
		if _online:
			won = state.winner == state.local_seat
		else:
			won = not state.is_bot_player(state.winner)
		lost = not won
	Settings.record_game(won, lost)

func _on_deck_pressed() -> void:
	if not _can_act():
		return
	draw_dialog.popup_centered()

func _on_draw_confirmed() -> void:
	_hint_ids.clear()
	if _online:
		await _send_and_wait(func(): return await Net.draw_from_deck())
		return
	var r := state.draw_from_deck()
	if r.get("ok", false):
		invalid_row_ids.clear()
		refresh()
		_show_pass()
	else:
		toast(String(r.get("reason", "")), true)

func _on_main_pressed() -> void:
	if not _can_act():
		return
	if not state.turn_placed.is_empty():
		_on_end_pressed()
	elif state.tiles_left_in_deck() > 0:
		_on_deck_pressed()
	else:
		_on_skip_pressed()

func _on_end_pressed() -> void:
	_hint_ids.clear()
	if _online:
		await _on_end_pressed_online()
		return
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
	if _online:
		await _send_and_wait(func(): return await Net.skip_turn())
		return
	var r := state.skip_turn()
	if r.get("ok", false):
		invalid_row_ids.clear()
		refresh()
		_show_pass()
	else:
		toast(String(r.get("reason", "")), true)

## Ход в сетевой игре.
##
## Сначала проверяем локально — чтобы ошибка («ряд из одной фишки»,
## «не выложено ни одной») появилась мгновенно, не дожидаясь сети.
## Проверка правил всё равно выполняется на сервере: клиентскую мы
## показываем только ради скорости, а решение принимает сервер.
##
## Отправляем ГОТОВЫЙ СТОЛ целиком, а не «что я сделал». Тогда клиент не
## может случайно выиграть, отправив серверу несуществующую операцию, а
## серверу не нужно разбирать, что клиент имел в виду.
func _on_end_pressed_online() -> void:
	var check := state.check_turn()
	if not bool(check.get("ok", false)):
		invalid_row_ids.clear()
		for e in check.get("errors", []):
			var idx := int(e.get("row", -1))
			if idx >= 0 and idx < state.table.size():
				invalid_row_ids.append((state.table[idx] as GameState.Row).id)
		toast(String(check.get("reason", "Ход нельзя завершить")), true)
		refresh()
		return
	# Снимок стола берём ДО отправки: пока идёт запрос, сервер пришлёт
	# своё состояние и подменит state, и взять ops из state уже нельзя.
	var rows := state.set_table_ops()
	await _send_and_wait(_send_table, [rows])


func _send_table(rows: Array) -> Dictionary:
	return await Net.commit_table(rows)

func _on_undo_pressed() -> void:
	if not _can_act():
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
	if not _can_act():
		return
	if state.save_checkpoint():
		toast("Расклад сохранён (чекпоинт)", false)
	else:
		toast("Сначала что-нибудь измените на столе", false)

func _on_cp_restore_pressed() -> void:
	if not _can_act():
		return
	if state.restore_checkpoint():
		_hint_ids.clear()
		invalid_row_ids.clear()
		refresh()
		toast("Возврат к чекпоинту", false)
	else:
		toast("Нет сохранённых раскладов", false)

func _on_hint_pressed() -> void:
	if not _can_act():
		return
	_hint_ids.clear()
	var plan := TurnPlanner.plan(state, TurnPlanner.LEVEL_IMPOSSIBLE)
	var action := String(plan.get("action", ""))
	if action == "place":
		_hint_ids = (plan.get("tiles", []) as Array).duplicate()
		toast("Подсказка: выложите %d %s — это +%d очков" % [
			_hint_ids.size(), _card_word(_hint_ids.size()),
			int(plan.get("points", 0))], false)
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
	# Что тянем — для превью сопернику (game.peek).
	_peek_drag = {
		"kind": "tile",
		"tile_id": view.tile.id,
		"from": view.src_kind,
		"row_id": view.src_row_id,
	}
	_last_peek = {}
	_peek_resent_ms = 0
	# Пока тянем карточку, стол не должен сам ловить touch-скролл:
	# ScrollContainer перехватывает жест в щели между плитками, карточка
	# отстаёт от пальца, а ряды начинают уезжать. Своё листание по краям
	# экрана во время перетаскивания по-прежнему делает _auto_scroll_drag.
	_set_drag_scroll_locked(true)

func _end_drag() -> void:
	if _drag_view != null and is_instance_valid(_drag_view):
		_drag_view.modulate = Color.WHITE
	_drag_view = null
	_slot_hover_pos = -1
	_slot_hover_time = 0
	_slot_grace_until = 0
	_clear_row_slots()
	_set_drag_scroll_locked(false)
	_pan_pressed = false
	_pan_press_on_tile = false
	# Конец перебирания — сопернику больше нечего показывать.
	_send_peek({ "kind": "clear" })
	_peek_drag = {}

func _set_drag_scroll_locked(locked: bool) -> void:
	if table_scroll == null:
		return
	table_scroll.mouse_filter = (
		Control.MOUSE_FILTER_IGNORE if locked else Control.MOUSE_FILTER_STOP)

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

# -------------------------------------------------------------- превью хода

## Цель под пальцем в терминах протокола game.peek. Зеркалит gui_can_drop:
## превью показываем только там, куда фишка реально могла бы лечь, иначе
## соперник увидит «он думает сюда» про заведомо невозможный вариант.
func _peek_target(global_pos: Vector2) -> Dictionary:
	var out := { "kind": "clear" }
	if _peek_drag.is_empty() or state == null or state.finished:
		return out
	var from := String(_peek_drag.get("from", ""))
	var tile_id := int(_peek_drag.get("tile_id", -1))
	if hand_flow != null and hand_flow.get_global_rect().has_point(global_pos):
		# Забирает в руку: чужой руки не видно, но саму фишку показать
		# можно — призраком поверх её текущего места.
		if from == "row":
			var src := _find_tile(tile_id)
			if src != null and state.can_take_back(src):
				out = { "kind": "back" }
	elif table_scroll != null and table_scroll.get_global_rect().has_point(global_pos):
		var hit := _table_hit(global_pos)
		var target: GameState.Row = hit["row"]
		if target != null:
			var ok := false
			if from == "hand":
				ok = state.can_place_into(target)
			else:
				var src_row := state.row_by_id(int(_peek_drag.get("row_id", -1)))
				ok = src_row != null and (target == src_row or state.can_touch_row(target))
			if ok:
				out = { "kind": "into", "row": target.id, "index": int(hit["index"]) }
		else:
			var gap := _hover_slot_pos(global_pos)
			if gap >= 0:
				out = { "kind": "new", "at": gap }
			elif _in_hint_zone(global_pos):
				out = { "kind": "new", "at": row_blocks.size() }
	return out


## Шлём превью, только когда цель изменилась; живую цель повторяем раз в
## PEEK_RESEND_MS — иначе призрак соперника протухнет, пока мы молчим,
## думая над позицией, а упавший клиент оставит призрак навсегда.
func _update_peek() -> void:
	if not _online or _peek_drag.is_empty():
		return
	var target := _peek_target(get_global_mouse_position())
	var now := Time.get_ticks_msec()
	if target != _last_peek:
		_send_peek(target)
	elif String(target.get("kind", "clear")) != "clear" \
			and now - _peek_resent_ms >= PEEK_RESEND_MS:
		_send_peek(target)


func _send_peek(target: Dictionary) -> void:
	if not _online:
		return
	_last_peek = target
	_peek_resent_ms = Time.get_ticks_msec()
	if not Net.is_linked():
		return
	var payload := {
		"tile": int(_peek_drag.get("tile_id", 0)),
		"kind": String(target.get("kind", "clear")),
	}
	if target.has("row"):
		payload["row"] = int(target["row"])
	if target.has("index"):
		payload["index"] = int(target["index"])
	if target.has("at"):
		payload["at"] = int(target["at"])
	Net.peek_place(payload)


## Соперник прислал превью: рисуем призрак фишки в целевой точке.
func _on_net_peek(tile_id: int, kind: String, row: int, index: int, at: int) -> void:
	_clear_peek()
	if kind == "clear" or tile_id <= 0 or state == null or state.finished:
		return
	if _peek_layer == null:
		return
	var pos: Variant = _peek_position(kind, tile_id, row, index, at)
	if pos == null:
		return
	if kind == "new":
		# Врезаем в наш стол прозрачный ряд той же высоты: призрак ляжет
		# в разрыв, а не поверх соседней карточки — соперник видит, что
		# у того открывается новый ряд. Позиция уже посчитана по
		# _peek_new_pos — врезка встанет именно туда после переразметки,
		# а держать призрак на ней будет _sync_peek_slot каждый кадр.
		_show_peek_slot(at)
		if _peek_slot == null:
			return
	var ghost := TileView.make(ViewBuilder.tile(tile_id), false, self)
	ghost.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ghost.modulate = Color(1, 1, 1, 0.7)
	_peek_layer.add_child(ghost)
	ghost.global_position = pos as Vector2
	_peek_ghost = ghost
	_peek_at_ms = Time.get_ticks_msec()


## Куда положить призрак. null — в текущем состоянии этой точки нет
## (например, ряд уже разобрали): превью просто не показываем.
func _peek_position(kind: String, tile_id: int, row: int, index: int, at: int) -> Variant:
	match kind:
		"into":
			return _peek_into_pos(row, index)
		"new":
			return _peek_new_pos(at)
		"back":
			return _peek_back_pos(tile_id)
	return null


func _peek_into_pos(row_id: int, index: int) -> Variant:
	var rb := _row_block_by_id(row_id)
	if rb == null or rb.flow == null:
		return null
	var tile_views := rb.flow.tile_views
	if tile_views.is_empty():
		return rb.global_position
	if index >= tile_views.size():
		var last: TileView = tile_views[tile_views.size() - 1]
		return last.global_position + Vector2(Settings.tile_size().x + 8.0, 0.0)
	return (tile_views[index] as TileView).global_position


func _peek_new_pos(at: int) -> Variant:
	var n := row_blocks.size()
	var slot := clampi(at, 0, n)
	if slot < n:
		return (row_blocks[slot] as RowBlock).global_position
	if n > 0:
		var last_row := row_blocks[n - 1] as RowBlock
		return last_row.global_position + Vector2(0.0, last_row.size.y + 6.0)
	if table_box != null:
		return table_box.global_position
	return null


func _peek_back_pos(tile_id: int) -> Variant:
	for block in row_blocks:
		var rb := block as RowBlock
		if rb == null or rb.flow == null:
			continue
		for v in rb.flow.tile_views:
			var tv := v as TileView
			if tv != null and tv.tile != null and tv.tile.id == tile_id:
				return tv.global_position + Vector2(0.0, -4.0)
	return null


func _row_block_by_id(row_id: int) -> RowBlock:
	for block in row_blocks:
		var rb := block as RowBlock
		if rb != null and rb.row_id == row_id:
			return rb
	return null


## Врезка «нового ряда» под призрак соперника (game.peek kind=new).
## Без неё призрак лёг бы поверх существующей карточки; с врезкой стол
## расступается, и видно, что тот открывает новый ряд. Это картинка —
## мышь её не ловит, в отличие от авторской _show_row_slot.
func _show_peek_slot(at: int) -> void:
	_clear_peek_slot()
	if state == null or state.finished or table_box == null:
		return
	var h := maxf(Settings.tile_size().y + 16.0, 36.0)
	var slot := Panel.new()
	slot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	slot.custom_minimum_size = Vector2(0, h)
	slot.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(1, 1, 1, 0.03)
	sb.border_color = Color(1, 1, 1, 0.18)
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(10)
	slot.add_theme_stylebox_override("panel", sb)
	slot.set_meta("slot_at", at)
	table_box.add_child(slot)
	table_box.move_child(slot, clampi(at, 0, table_box.get_child_count() - 1))
	_peek_slot = slot


func _clear_peek_slot() -> void:
	if _peek_slot != null and is_instance_valid(_peek_slot):
		var p := _peek_slot.get_parent()
		if p != null:
			p.remove_child(_peek_slot)
		_peek_slot.free()
	_peek_slot = null


## Держим призрак нового ряда на врезке: та переезжает при каждой
## переразметке стола (черновик приходит повторами каждые 3 с), и
## координаты призрака обязаны следовать за ней.
func _sync_peek_slot() -> void:
	if _peek_slot == null or not is_instance_valid(_peek_slot):
		return
	if _peek_ghost != null and is_instance_valid(_peek_ghost):
		_peek_ghost.global_position = _peek_slot.global_position


func _clear_peek() -> void:
	_clear_peek_slot()
	if _peek_ghost != null and is_instance_valid(_peek_ghost):
		_peek_ghost.queue_free()
	_peek_ghost = null
	_peek_at_ms = 0


## Превью протухает само: если соперник перестал повторять цель
## (упал, вышел), призрак не должен висеть вечно.
func _expire_peek() -> void:
	if _peek_ghost != null and (
			not is_instance_valid(_peek_ghost)
			or Time.get_ticks_msec() - _peek_at_ms > PEEK_EXPIRE_MS):
		_clear_peek()


## Соперник прислал весь свой стол: показываем его вместо базового, а
## выложенные в этот ход фишки (нет в серверном столе) — серыми.
func _on_net_draft(from: int, rows: Array) -> void:
	if state == null or state.finished or from < 0:
		return
	# Черновик чужого хода имеет смысл только пока этот игрок и ходит:
	# иначе гонка с game.state показала бы чужую раскладку поверх нашей.
	if state.current != from:
		return
	_draft_from = from
	_draft_rows = rows
	_draft_grey_ids = _draft_grey_of(rows)
	_draft_at_ms = Time.get_ticks_msec()
	refresh()


## Серые фишки черновика: все присланные, которых нет в серверной базе.
## Отдельной функцией — та же пересчёт вызывается при каждом промежуточном
## game.state, пока ход автора не кончился.
func _draft_grey_of(rows: Array) -> Dictionary:
	var base := {}
	for row in state.table:
		var r := row as GameState.Row
		if r != null:
			for t in r.tiles:
				base[(t as Tile).id] = true
	var grey := {}
	for d in rows:
		if not (d is Dictionary):
			continue
		for tid in (d.get("tiles", []) as Array):
			var id := int(tid)
			if id > 0 and not base.has(id):
				grey[id] = true
	return grey


## Гасим черновик. Без перерисовки: нас вызывают и в _apply_state, где
## состояние вот-вот подменится и перерисует вызывающая сторона.
func _clear_draft() -> void:
	_draft_from = -1
	_draft_rows = []
	_draft_grey_ids = {}
	_draft_at_ms = 0


func _draft_active() -> bool:
	return _draft_from >= 0 and state != null and not state.finished \
		and state.current == _draft_from


## Черновик протухает сам: автор шлёт повтор каждые DRAFT_RESEND_MS, пока
## думает; замолчал (упал, отвалился) — стол возвращается к серверному.
func _expire_draft() -> void:
	if _draft_from >= 0 and (
			not _draft_active()
			or Time.get_ticks_msec() - _draft_at_ms > DRAFT_EXPIRE_MS):
		_clear_draft()
		if state != null:
			refresh()


## Наш стол для отправки. ВАЖНО: id рядов уходят локальные, без обнуления
## новых (в отличие от set_table_ops для commit) — по ним же соперник
## рисует призрак game.peek в только что созданный ряд.
func _build_draft_rows() -> Array:
	var rows: Array = []
	for row in state.table:
		var r := row as GameState.Row
		if r == null or r.tiles.is_empty():
			continue
		var ids: Array = []
		for t in r.tiles:
			ids.append((t as Tile).id)
		rows.append({"id": r.id, "tiles": ids})
	return rows


## Черновик своего стола: шлём после каждого изменения и повторяем, пока
## ход не завершён — иначе соперник с потерянным пакетом или вошедший
## посреди хода увидит пустой стол.
func _maybe_send_draft() -> void:
	if not _online or state == null or state.finished:
		return
	if not state.my_turn() or not Net.is_linked() or _sending:
		return
	var rows := _build_draft_rows()
	var json := JSON.stringify(rows)
	var now := Time.get_ticks_msec()
	if json == _last_draft_json:
		# Стол не менялся: повтор нужен только висящему черновику.
		if _last_draft_json.is_empty() or now - _draft_sent_ms < DRAFT_RESEND_MS:
			return
	elif _last_draft_json.is_empty() and not state.turn_dirty:
		# Чистый стол с начала хода: отправлять нечего.
		return
	_last_draft_json = json
	_draft_sent_ms = now
	Net.draft_table(rows)


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
	if _draft_grey_ids.has(tile_id):
		m["draft"] = true
	if _hint_ids.has(tile_id):
		m["hint"] = true
	return m

func refresh() -> void:
	if state == null:
		return
	# Локальный стол изменился (перетащили, отменили, чекпоинт) —
	# отдаём соперникам весь стол целиком, чтобы они видели все фишки.
	_maybe_send_draft()
	# Снимаем старые позиции ДО пересборки: _update_table и set_tiles
	# уничтожают текущие view, и после них снимать будет нечего.
	var shots: Array = []
	if _anim_pending:
		shots = _capture_tiles()
	_anim_pending = false
	_drag_view = null
	_slot_hover_pos = -1
	_slot_hover_time = 0
	_slot_grace_until = 0
	_clear_row_slots()
	_set_drag_scroll_locked(false)
	_update_chips()
	_update_table()
	_update_hand()
	_update_buttons()
	_update_hint_zone_size()
	if not shots.is_empty():
		_play_place_anim(shots)

## Все показанные сейчас фишки: id, сама фишка и положение на экране.
func _capture_tiles() -> Array:
	var out: Array = []
	_capture_flow(hand_flow, out)
	for rb in row_blocks:
		var block := rb as RowBlock
		if block != null:
			_capture_flow(block.flow, out)
	return out

func _capture_flow(flow: FlowTiles, out: Array) -> void:
	if flow == null:
		return
	for v in flow.tile_views:
		var tv := v as TileView
		if tv != null and tv.tile != null:
			out.append({ "id": tv.tile.id, "tile": tv.tile, "gpos": tv.global_position })

## Разница старого и нового состояния в живых view: id -> TileView.
func _collect_live(cur: Dictionary) -> void:
	_collect_flow(hand_flow, cur)
	for rb in row_blocks:
		var block := rb as RowBlock
		if block != null:
			_collect_flow(block.flow, cur)

func _collect_flow(flow: FlowTiles, cur: Dictionary) -> void:
	if flow == null:
		return
	for v in flow.tile_views:
		var tv := v as TileView
		if tv != null and tv.tile != null:
			cur[tv.tile.id] = tv

## Слушает раскладку кадр — только тогда у свежесобранных контейнеров
## есть координаты. Пустой снимок (вход в сцену) ничего не анимирует.
func _play_place_anim(shots: Array) -> void:
	# Рассылка могла застать сцену уже за бортом (смена сцены ещё/уже
	# едет): вне дерева ждать кадр не на чем — просто не анимируем.
	if not is_inside_tree():
		return
	await get_tree().process_frame
	if not is_inside_tree() or shots.is_empty():
		return
	var prev := {}
	for s in shots:
		prev[int(s["id"])] = s
	var cur := {}
	_collect_live(cur)
	var step := 0
	for id in cur.keys():
		var tv: TileView = cur[id]
		if prev.has(id):
			var gpos: Vector2 = prev[id]["gpos"]
			prev.erase(id)
			if gpos.distance_to(tv.global_position) > 2.0:
				_slide_tile(tv, gpos)
		else:
			_fly_in_tile(tv, step)
			step += 1
	# Остались только ушедшие фишки.
	for id in prev.keys():
		var s: Dictionary = prev[id]
		_fly_out_tile(s["tile"], s["gpos"])

## Новая фишка: прилетает сверху — от края экрана в свой слот.
func _fly_in_tile(tv: TileView, step: int) -> void:
	var parent := tv.get_parent()
	if parent == null:
		return
	var final_local := tv.position
	var top_y := get_viewport().get_visible_rect().position.y - tv.size.y * 1.5
	var start_global := Vector2(tv.global_position.x, top_y)
	tv.position = parent.get_global_transform().affine_inverse() * start_global
	tv.modulate.a = 0.0
	var delay := minf(step * 0.05, 0.4)
	var tw := create_tween()
	tw.bind_node(tv)
	tw.set_parallel(true)
	tw.tween_property(tv, "position", final_local, 0.35) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT).set_delay(delay)
	tw.tween_property(tv, "modulate:a", 1.0, 0.25) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT).set_delay(delay)

## Фишка сменила место: переезжает из старого положения в новое.
func _slide_tile(tv: TileView, from_global: Vector2) -> void:
	var parent := tv.get_parent()
	if parent == null:
		return
	var final_local := tv.position
	tv.position = parent.get_global_transform().affine_inverse() * from_global
	var tw := create_tween()
	tw.bind_node(tv)
	tw.tween_property(tv, "position", final_local, 0.3) \
		.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)

## Ушедшая фишка: призрак взлетает вверх и гаснет — под ней уже пусто.
func _fly_out_tile(tile: Tile, gpos: Vector2) -> void:
	var ghost := TileView.make(tile, false, null, false)
	add_child(ghost)
	ghost.top_level = true
	ghost.position = gpos
	ghost.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var tw := create_tween()
	tw.bind_node(ghost)
	tw.set_parallel(true)
	tw.tween_property(ghost, "position:y", gpos.y - Settings.tile_size().y * 1.8, 0.4) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_IN)
	tw.tween_property(ghost, "modulate:a", 0.0, 0.35) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_IN)
	tw.tween_callback(_on_ghost_done.bind(ghost))

func _on_ghost_done(ghost: Control) -> void:
	if is_instance_valid(ghost):
		ghost.queue_free()

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
		sb.content_margin_top = 4.0
		sb.content_margin_bottom = 4.0
		chip.add_theme_stylebox_override("panel", sb)
		chip.mouse_filter = Control.MOUSE_FILTER_PASS
		var lab := Label.new()
		lab.text = "%s · %d" % [state.player_name(i), state.hand_size(i)]
		# В сетевой игре показываем и наше место, и «мы тут» — иначе
		# непонятно, чьи фишки лежат внизу. Отвалившегося помечаем
		# отдельно: его место держится, но ходить он не может.
		if _online and i == state.local_seat:
			lab.text += " · вы"
		# Серверные боты добирают места в сетевой партии — их показываем
		# явно, чтобы игрок понимал, почему «не у того» ход и кто вообще
		# за столом. Офлайн-ботов одиночной игры не трогаем.
		if _online and state.is_bot_player(i):
			lab.text += " · бот"
		# Слово «ходит» рядом с подсветкой: по одному цвету рамки в сетевой
		# партии не понять, чья очередь, а текст читается сразу.
		if is_now and not state.finished:
			lab.text += " · ходит"
		if _online and not state.is_connected_player(i):
			lab.text += " · нет связи"
		lab.add_theme_font_size_override("font_size", Settings.fs(14))
		lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.95) if is_now else Color(1, 1, 1, 0.6))
		chip.add_child(lab)
		chips_box.add_child(chip)

func _update_table() -> void:
	for child in table_box.get_children():
		if child is RowBlock:
			table_box.remove_child(child)
			child.free()
	row_blocks.clear()
	var draggable := _can_act()
	for e in _table_rows():
		var block := RowBlock.new()
		block.setup(
			int(e["id"]),
			e["tiles"],
			bool(e["invalid"]),
			draggable,
			self
		)
		table_box.add_child(block)
		row_blocks.append(block)
	table_box.move_child(hint_zone, table_box.get_child_count() - 1)
	# Пересобирали детей — врезка чужого нового ряда могла уехать в конец
	# списка. Возвращаем её на её место среди рядов, иначе призрак
	# соперника сядет не туда.
	if _peek_slot != null and is_instance_valid(_peek_slot):
		var slot_at := int(_peek_slot.get_meta("slot_at", 0))
		table_box.move_child(_peek_slot, clampi(slot_at, 0, table_box.get_child_count() - 1))


## Что рисуем на столе: черновик соперника, пока он висит, иначе — наше
## состояние. Вид: [{id, tiles: Array[Tile], invalid}, ...].
func _table_rows() -> Array:
	var out: Array = []
	if _draft_active():
		for d in _draft_rows:
			if not (d is Dictionary):
				continue
			var tiles: Array = []
			for tid in (d.get("tiles", []) as Array):
				tiles.append(ViewBuilder.tile(int(tid)))
			if tiles.is_empty():
				continue
			out.append({"id": int(d.get("id", 0)), "tiles": tiles, "invalid": false})
		return out
	for row in state.table:
		var r := row as GameState.Row
		if r == null or r.tiles.is_empty():
			continue
		out.append({
			"id": r.id,
			"tiles": r.tiles,
			"invalid": invalid_row_ids.has(r.id),
		})
	return out

func _update_hand() -> void:
	var bot_turn := _is_bot_turn()
	hand_flow.set_tiles(state.hand(), "hand", 0, _can_act(), bot_turn)

func _update_buttons() -> void:
	if state == null:
		return
	deck_button.text = "Колода\n%d" % state.tiles_left_in_deck()
	var placed := not state.turn_placed.is_empty()
	# В сетевой игре вместо бота — «не наш ход» и «ждём сервер». Разница
	# видна только в подписях, а вот в кнопках она не нужна.
	var busy := _bot_active or _is_bot_turn() or (_online and not state.my_turn())
	var locked := state.finished or busy or (_online and _sending)
	deck_button.disabled = locked or not state.can_draw()
	undo_button.disabled = locked or not state.turn_dirty
	cp_save_btn.disabled = locked or not state.turn_dirty
	cp_restore_btn.disabled = locked or state.checkpoint_count() == 0
	hint_btn.disabled = locked
	if state.finished:
		end_button.text = "Игра окончена"
		end_button.disabled = true
	elif _online and _sending:
		end_button.text = "Ждём…"
		end_button.disabled = true
	elif placed:
		end_button.text = "Продолжить"
		end_button.disabled = locked
	elif state.tiles_left_in_deck() > 0:
		end_button.text = "Взять"
		end_button.disabled = locked or not state.can_draw()
	else:
		end_button.text = "Пропуск хода"
		end_button.disabled = locked or not state.can_skip()

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

## Подсказка всегда чуть уже экрана.
##
## Без минимальной ширины Label с автопереносом внутри CenterContainer
## сжимается до одного символа в строке, и текст рассыпался буква-в-букву
## на пол-экрана высотой. Ширину задаём от текущей ширины окна, поэтому
## пересчитывается и после поворота/пересборки интерфейса.
func _fit_toast_width() -> void:
	if toast_label == null:
		return
	toast_label.custom_minimum_size = Vector2(maxf(240.0, size.x - 56.0), 0.0)

## Листание стола пальцем по фону рядов.
##
## ScrollContainer на телефоне начинает жест только когда палец попал мимо
## всех STOP-контролов, а ряд и его FlowTiles — drop-цели: их обязательно
## пришлось бы оставить STOP, иначе ломается перетаскивание карточек.
## Поэтому жест с фона ряда разбираем здесь: событие мыши (эмулированное
## от касания) гасим, прокрутку двигаем сами. Сами карточки не трогаем —
## с них перетаскивание по-прежнему работает как раньше.
func _input(event: InputEvent) -> void:
	# Листание, начатое на кнопке/поле ввода внутри скролл-предка
	# (наложения партии). Поглощённые события до пан-разбора стола
	# не доходят — жесты не мешают друг другу. См. ScrollDrag.
	if _scroll_drag.input(self, event):
		return
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		if mb.button_index != MOUSE_BUTTON_LEFT:
			return
		if mb.pressed:
			# Решение принимаем на первом же движении: там позиция нажатия
			# уже известна (событие мыши обновляет её после обработки).
			_pan_pressed = false
			_pan_pos = get_global_mouse_position()
			# Касание по карточке принадлежит перетаскиванию: пан не должен
			# отнимать жест, даже если при быстром рывке палец сразу ушёл
			# в щель между рядами (drag-данные создаются чуть позже — этим
			# же событием движения, в GUI).
			_pan_press_on_tile = _point_on_tile(_pan_pos)
		else:
			_pan_scroll(get_global_mouse_position() - _pan_pos)
			_pan_pressed = false
			_pan_press_on_tile = false
	elif event is InputEventMouseMotion:
		var mm := event as InputEventMouseMotion
		if (mm.button_mask & MOUSE_BUTTON_MASK_LEFT) == 0:
			# Палец отпущен (или окно потеряло фокус) — жест больше не наш.
			_pan_pressed = false
			return
		if not _pan_pressed:
			_pan_pos = get_global_mouse_position()
			if _pan_press_on_tile:
				return
			_pan_pressed = _can_pan_table(_pan_pos)
			return
		_pan_scroll(get_global_mouse_position() - _pan_pos)

func _pan_scroll(delta: Vector2) -> void:
	if not _pan_pressed:
		return
	_pan_pos += delta
	if table_scroll == null or is_zero_approx(delta.y):
		return
	var bar := table_scroll.get_v_scroll_bar()
	table_scroll.scroll_vertical = clampf(
		table_scroll.scroll_vertical - delta.y, 0.0, bar.max_value)
	get_viewport().set_input_as_handled()

## Листать можно в любом месте стола, кроме самих карточек: с карточки
## жест принадлежит перетаскиванию.
func _can_pan_table(p: Vector2) -> bool:
	if _drag_view != null:
		return false
	if table_scroll == null or not table_scroll.is_visible_in_tree():
		return false
	if _modal_open():
		return false
	if not table_scroll.get_global_rect().has_point(p):
		return false
	for block in row_blocks:
		var row := block as RowBlock
		if row == null or row.flow == null or not row.is_visible_in_tree():
			continue
		for view in row.flow.tile_views:
			var tile_view := view as TileView
			if tile_view != null and tile_view.get_global_rect().has_point(p):
				return false
	return true

## Точка над карточкой (ряд или рука): с такого касания жест принадлежит
## перетаскиванию, а не листанию стола.
func _point_on_tile(p: Vector2) -> bool:
	for block in row_blocks:
		var row := block as RowBlock
		if row == null or row.flow == null or not row.is_visible_in_tree():
			continue
		for view in row.flow.tile_views:
			var t := view as TileView
			if t != null and t.get_global_rect().has_point(p):
				return true
	if hand_flow != null:
		for view in hand_flow.tile_views:
			var t := view as TileView
			if t != null and t.get_global_rect().has_point(p):
				return true
	return false

## Модальные экраны лежат поверх стола: жест по ним партию листать не должен.
func _modal_open() -> bool:
	if draw_dialog != null and draw_dialog.visible:
		return true
	if menu_dialog != null and menu_dialog.visible:
		return true
	for overlay in [pass_overlay, win_overlay, help_overlay, settings_overlay,
			turn_title_overlay]:
		var o := overlay as Control
		if o != null and o.visible:
			return true
	return false

func toast(text: String, is_error: bool = false) -> void:
	if toast_label == null or _toast_panel == null:
		return
	_fit_toast_width()
	toast_label.text = text
	toast_label.add_theme_color_override("font_color", Color("FF8A80") if is_error else Color("A5D6A7"))
	toast_label.visible = true
	_toast_panel.visible = true
	_toast_panel.modulate.a = 1.0
	if toast_tween != null and toast_tween.is_running():
		toast_tween.kill()
	toast_tween = create_tween()
	toast_tween.tween_interval(2.6)
	toast_tween.tween_property(_toast_panel, "modulate:a", 0.0, 0.5)
	toast_tween.tween_callback(_hide_toast)

func _hide_toast() -> void:
	if toast_tween != null and toast_tween.is_running():
		toast_tween.kill()
	toast_label.visible = false
	_toast_panel.visible = false

func _on_toast_input(event: InputEvent) -> void:
	if event is InputEventMouseButton and event.pressed:
		_hide_toast()

func _card_word(count: int) -> String:
	var d := count % 10
	var h := count % 100
	if d == 1 and h != 11:
		return "карточку"
	if d >= 2 and d <= 4 and not (h >= 12 and h <= 14):
		return "карточки"
	return "карточек"
