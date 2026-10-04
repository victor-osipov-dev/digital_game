extends Control
const Lang := preload("res://scripts/core/lang.gd")

const SLOT_HOVER_EDGE := 10.0
const SLOT_HOVER_DELAY_MS := 400
const SLOT_HOVER_MOVE_PX := 6.0
const SLOT_GRACE_MS := 1500
const HINT_MIN_H := 100.0
const DRAG_SCROLL_ZONE := 64.0
const DRAG_SCROLL_OVERSHOOT := 40.0
const DRAG_SCROLL_SPEED := 480.0
# preload, а не class_name: глобальный список классов читается из кэша
# редактора и на новом файле отстаёт — см. «Identifier "ScrollDrag" not
# declared in the current scope».
const ScrollDragClass := preload("res://scripts/ui/scroll_drag.gd")
const UiThemeClass := preload("res://scripts/ui/ui_theme.gd")
# Пути скриптов партнёрской рекламы (только Android; Web-сборка их не
# содержит — поэтому load(), а не preload/class_name).
const PARTNER_AD_SCRIPT := "res://scripts/platform/partner_ad.gd"
const PARTNER_AD_CARD_SCRIPT := "res://scripts/platform/partner_ad_card.gd"
const MARKET_HELPER_SCRIPT := "res://scripts/platform/market_helper.gd"
# Мост SDK Яндекс Игр (только Web-сборка; в Android-PCK файла нет).
const YANDEX_SDK_SCRIPT := "res://scripts/platform/yandex_sdk.gd"
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
var _confirm_overlay: ColorRect = null
var _confirm_title: Label = null
var _confirm_text: Label = null
var _confirm_ok: Button = null
var _confirm_cancel: Button = null
var _confirm_action: Callable = Callable()
var toast_tween: Tween = null
var title_tween: Tween = null
var _again_btn: Button = null
## Плавающая кнопка возврата на экран победы из просмотра стола.
## Видна только в режиме просмотра (партия кончена, оверлей скрыт).
var _inspect_btn: Button = null
## VBox экрана победы — туда встаёт рекламная карточка (ниже кнопок).
var _win_box: VBoxContainer = null
## Реклама уже показана за эту партию (максимум один раз за финал).
var _partner_ad_shown := false
## Время последнего нажатия на рекламу (защита от двойного Intent).
var _partner_ad_open_ms := 0
var _settings_panel: PanelContainer = null
var _settings_rows: Array = []
var _top_actions: FlowContainer = null
var _top_action_buttons: Array = []
var _top_pinned: Array = []
var _top_overflow: Array = []
var _burger_btn: Button = null
var _burger_panel: PanelContainer = null
var _burger_box: VBoxContainer = null
var _burger_open := false
var _burger_catcher: ColorRect = null
var _burger_closed_ms := 0
var _top_collapsed := false
var _burger_tween: Tween = null

var _drag_view: TileView = null
var _row_slots: Array = []
var _slot_hover_pos: int = -1
var _slot_hover_time: int = 0
var _slot_hover_last: Vector2 = Vector2.ZERO
var _slot_grace_until: int = 0
var _bot_active: bool = false
var _bot_seq: int = 0
var _hint_ids: Array = []
## Кто последним брал из колоды (место): чипы показывают «· взял».
## Держится до следующего взятия или новой партии — это правда и через
## пять ходов: другого взятия с тех пор не было.
var _drew_seat: int = -1
## Чья взятая фишка (место -> id): рука помечает её галочкой с кружочком,
## пока она в руке смотрящего. Выложил — убралась сама; взял новую — заменилась.
var _draw_marks := {}
## Чьи подсказки уже потрачены (место -> true): за одним устройством в
## локальной игре могут сидеть несколько живых игроков, и общий флаг
## «раз за партию» отбирал бы подсказку у остальных. В сети место одно.
var _hints_used := {}
## Ждём rewarded за подсказку (только Web): кнопка погашена, повторные
## нажатия глотаются, метка подсказки не тратится до сигнала награды.
var _hint_ad_pending := false
## Финал уже ушёл в рекламу/победу (только Web): повторный _show_win
## не запускает отсчёт заново, а сразу показывает экран.
var _win_ad_done := false
var _pan_pressed: bool = false
var _pan_pos: Vector2 = Vector2.ZERO
var _pan_press_on_tile: bool = false
var _scroll_drag := ScrollDragClass.new()

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
# из верхнего правого угла, сдвинутые переезжают, ушедшие улетают туда же
# призраком и уменьшаются.
var _anim_pending: bool = false
# Id фишек, чей прилёт анимируем принудительно, даже если снимок их уже
# видел: черновик показывал эти фишки прозрачными до коммита, и обычное
# сравнение «до/после» решило бы, что они никуда не прилетали. Каждый id
# несёт своё место (mover коммита) — сегменты очереди показывают шаги
# строго «своего» игрока, а не слипаются в одну кучу с чужим именем.
var _anim_force: Dictionary = {}
# Ход сетевого бота анимируем поэтапно, как локального: прилёты идут
# друг за другом, а не все разом. Метку ставит _apply_state по прошлому
# состоянию (ходил бот), гасится в refresh вместе с остальным.
var _anim_stagger := false
# Первое состояние партии — загрузка стола (вход/режойн), а не чей-то
# ход. Его force летит немедленным путём и в очередь не встаёт: иначе
# весь стол «показывался бы шагами», пересборки копились бы в отложенных
# (чужой черновик по дороге пропадал бы), а подсветка на входе прыгала
# бы на место предыдущего показа. Метка однократная — на refresh.
var _anim_load := false
# Состояний партии уже получено: первое после _new_match/_net_begin и
# есть загрузка. Считает только _on_state_received.
var _states_seen := 0
# Поколение анимации: несколько перерисовок с меткой в одном кадре
# (черновик и коммит разом) планируют столько же продолжений, а летит
# только последнее — по самым свежим видам. Иначе дубли твинов дёргают
# одни и те же фишки.
var _anim_gen := 0
## Очередь презентаций сетевых ходов: [{kind="title", seat, text},
## {kind="steps", ids}]. Данные применяются сразу (стол всегда актуален),
## а показываются строго по очереди: титр — шаги — титр — шаги. Цепочки
## ботов иначе рвут друг друга: следующий коммит прилетал раньше, чем
## долетал предыдущий, и середина цепочки не показывалась никогда.
var _present_queue: Array = []
var _present_busy := false
var _present_gen := 0
## Место последнего поставленного в очередь титра (дубли подряд лишние).
var _title_shown_for: int = -1
## Шаги встали в очередь ПОСЛЕ последнего титра. Титр своего хода ставим
## только после чужих шагов, иначе он бы мигнул сразу после нашего хода.
## Очередь пустеет по мере показа, поэтому «сейчас в очереди» врало бы:
## шаги уже вышли на показ, а титр всё равно нужен.
var _steps_since_title := false
## Сегмент шагов прямо сейчас в полёте (от выдачи до конца его ожидания).
## Пока он летит, пересборку стола откладываем: пересборка пересоздаёт
## виды, твины полёта умирают вместе с ними, и фишки «садятся» разом —
## ровно то, что видно, когда второй бот приходит во время полёта первого.
var _flight_active := false
## Отложенная до конца полёта пересборка/титр. Данные к этому моменту
## уже применены (state актуален) — ждём только виды.
var _refresh_pending := false
var _title_pending := false
## Чей титр отложен: запоминаем место хода НА МОМЕНТ заказа. Если доставить
## его позже, пересчёт по state.current уже даст следующего игрока и титр
## «Ход: Бот2» превратился бы в «Ход: вы» (а то и вовсе пропал бы).
var _pending_title_seat: int = -1
## Id, чьи виды не нашлись в момент показа (стол показан из черновика
## соперника или ряд ещё не собран). Показ не считается состоявшимся:
## вернёмся к ним, когда фишка появится на экране. Формат: {id, seat} —
## место сегмента, породившего сироту, чтобы её пересборка встала в
## очередь «от того же игрока».
var _present_orphans: Array = []
## Чей ход мы ПОКАЗЫВАЕМ сверху прямо сейчас: автор летящих шагов или
## титра, а не state.current. Сервер уже передал ход дальше, пока
## долетают фишки прошлого игрока, и по состоянию чип следующего
## загорался бы посреди чужой анимации — зрителю непонятно, чьи это
## фишки. Очередь пуста (-1) — показываем текущего по состоянию.
var _shown_seat: int = -1

# --- отсчёт хода (сетевая партия) ---------------------------------------
#
# Дедлайн в тиках из view.turnLeft, обновляется на каждый game.state;
# между состояниями секунды считает сам клиент (_process). Панелька в
# раскладке показывает, сколько осталось текущему игроку — всем видно.
var _turn_deadline_ms: int = 0
var _turn_timer_panel: PanelContainer = null
var _turn_timer_label: Label = null

# --- черновик стола (game.draft) ------------------------------------------
#
# Соперник шлёт ВЕСЬ свой стол после каждого локального изменения: пока
# он раскладывает, показываем его вместо базового, а выставленные в этом
# ходе фишки — прозрачными с жирной зелёной рамкой. Принятая сторона:
var _draft_rows: Array = []          # ряды соперника [{id, tiles}, ...]
var _draft_from: int = -1            # сид автора, -1 — черновика нет
var _draft_new_ids: Dictionary = {} # id фишек, выставленных в этом черновике
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
	Lang.apply_title()
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
	_update_hint_zone_size()
	_update_turn_timer()
	_expire_draft()
	# Раз в секунду — шанс повторить висящий черновик (только если он уже
	# был отправлен: чистый стол отправлять нечего).
	var now := Time.get_ticks_msec()
	if now - _draft_tick_ms >= 1000:
		_draft_tick_ms = now
		_maybe_send_draft()

func _build_ui() -> void:
	set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	# Единый вид кнопок (скругление 10) — дальше по дереву наследуют все.
	theme = UiThemeClass.shared()

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

	# Верхняя строка — в потоке, а не в одном ряду: при большом
	# шесть кнопок с крупным текстом не влезают в 576, и строка
	# переезжает на вторую линию, а не уезжает за правый край.
	var top := FlowContainer.new()
	top.add_theme_constant_override("h_separation", 6)
	top.add_theme_constant_override("v_separation", 6)
	layout.add_child(top)

	deck_button = Button.new()
	deck_button.clip_text = true
	deck_button.custom_minimum_size = Vector2(Settings.touch_w(92), Settings.touch(52))
	deck_button.add_theme_font_size_override("font_size", Settings.fs(16))
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

	_top_actions = FlowContainer.new()
	_top_actions.add_theme_constant_override("h_separation", 6)
	_top_actions.add_theme_constant_override("v_separation", 6)
	top.add_child(_top_actions)
	cp_save_btn = _make_top_button(Lang.t("Сохр."), Lang.t("Сохранить расклад (чекпоинт)"),
		_on_cp_save_pressed, Lang.t("Сохранить"))
	_top_actions.add_child(cp_save_btn)

	cp_restore_btn = _make_top_button(Lang.t("Вернуть"), Lang.t("Вернуться к чекпоинту"),
		_on_cp_restore_pressed, Lang.t("Вернуть"))
	_top_actions.add_child(cp_restore_btn)

	hint_btn = _make_top_button(Lang.t("Подск."), Lang.t("Подсказка - показать возможный ход"),
		_on_hint_pressed, Lang.t("Подсказка"))
	if OS.has_feature("web") and ResourceLoader.exists("res://assets/ui/ad_badge.png"):
		# Web: подсказка за просмотр rewarded — иконка честно говорит,
		# что кнопка ведёт к рекламе.
		hint_btn.icon = load("res://assets/ui/ad_badge.png") as Texture2D
	_top_actions.add_child(hint_btn)

	var help_btn := _make_top_button("?", Lang.t("Помощь"), _open_help, Lang.t("Помощь"))
	_top_actions.add_child(help_btn)

	var settings_btn := _make_top_button(Lang.t("Настр."), Lang.t("Размер текста и карточек"),
		_open_settings, Lang.t("Настройки"))
	_top_actions.add_child(settings_btn)

	var menu_btn := _make_top_button(Lang.t("Меню"), Lang.t("Выход в меню"),
		func(): _ask_confirm(Lang.t("Выход в меню"), Lang.t("Выйти в главное меню?"),
			Lang.t("Выйти"), _on_leave_to_menu), Lang.t("Меню"))
	_top_actions.add_child(menu_btn)
	_top_action_buttons = [
		cp_save_btn, cp_restore_btn, hint_btn, help_btn, settings_btn, menu_btn,
	]
	# Частые кнопки живут в строке всегда и в бургер не уезжают:
	# прятать «Сохранить»/«Вернуть»/«Подсказку» за тремя тапами нельзя.
	_top_pinned = [cp_save_btn, cp_restore_btn, hint_btn]
	_top_overflow = [help_btn, settings_btn, menu_btn]
	_burger_btn = Button.new()
	_burger_btn.text = Lang.t("☰")
	_burger_btn.tooltip_text = Lang.t("Действия")
	_burger_btn.custom_minimum_size = Vector2(60, Settings.touch(46))
	_burger_btn.clip_text = true
	_burger_btn.add_theme_font_size_override("font_size", Settings.fs(18))
	_burger_btn.pressed.connect(_toggle_burger_menu)
	_burger_btn.visible = false
	top.add_child(_burger_btn)

	# Ловец кликов мимо меню: закрывает бургер и съедает нажатие,
	# чтобы оно не проваливалось в стол. Лежит под панелью, над всем
	# остальным; кнопка «☰» под ним, но её тап тоже ловится сюда же —
	# повторный тап закрывает, как и раньше.
	_burger_catcher = ColorRect.new()
	_burger_catcher.color = Color(0, 0, 0, 0)
	_burger_catcher.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_burger_catcher.mouse_filter = Control.MOUSE_FILTER_STOP
	_burger_catcher.visible = false
	_burger_catcher.gui_input.connect(_on_burger_catcher)
	add_child(_burger_catcher)
	# Бургер — та же шестёрка кнопок, только столбиком: узкий экран не
	# должен ни резать их, ни раскидывать в две неровные строки.
	# Панель — поверх раскладки (top_level), а не в потоке: открытое
	# меню ничего не сдвигает.
	_burger_panel = PanelContainer.new()
	_burger_panel.top_level = true
	_burger_panel.visible = false
	var bsb := StyleBoxFlat.new()
	bsb.bg_color = Color(0.09, 0.12, 0.19, 0.97)
	bsb.border_color = Color(1, 1, 1, 0.22)
	bsb.set_border_width_all(2)
	bsb.set_corner_radius_all(12)
	bsb.content_margin_left = 8.0
	bsb.content_margin_right = 8.0
	bsb.content_margin_top = 8.0
	bsb.content_margin_bottom = 8.0
	_burger_panel.add_theme_stylebox_override("panel", bsb)
	_burger_panel.visible = false
	_burger_panel.modulate.a = 0.0
	add_child(_burger_panel)
	_burger_box = VBoxContainer.new()
	_burger_box.add_theme_constant_override("separation", 8)
	_burger_panel.add_child(_burger_box)

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
	hlab.text = Lang.t("Перетащите сюда число - новый ряд")
	hlab.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	hlab.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	hlab.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	hlab.mouse_filter = Control.MOUSE_FILTER_IGNORE
	# Подпись переносится: без неё её ширина на большой шкале (597 px)
	# становилась шириной всего стола и уводила верхний ряд за край.
	hlab.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	hlab.add_theme_font_size_override("font_size", Settings.fs(16))
	hlab.add_theme_color_override("font_color", Color(1, 1, 1, 0.55))
	hint_zone.add_child(hlab)
	table_box.add_child(hint_zone)

	# Рука — в собственной зелёной панели, а не просто на общем фоне: без
	# заливки и рамки её фишки визуально сливаются с рядами стола,
	# особенно когда стол короткий и обе зоны стоят вплотную. Панель
	# ловит клики только в своих отступах — зона фишек осталась у
	# hand_flow, drop-проверки работают по её global_rect как раньше.
	var hand_panel := PanelContainer.new()
	var hpsb := StyleBoxFlat.new()
	# Своя рука — отдельным заливным полем, а не серой подложкой: иначе она
	# визуально сливается со столом.
	hpsb.bg_color = Color(0.10, 0.34, 0.22, 0.72)
	hpsb.border_color = Color(0.48, 0.86, 0.55, 0.85)
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
	undo_button.text = Lang.t("Отменить ход")
	undo_button.size_flags_horizontal = Control.SIZE_EXPAND_FILL
	undo_button.custom_minimum_size = Vector2(0, Settings.touch(52))
	undo_button.add_theme_font_size_override("font_size", Settings.fs(16))
	undo_button.pressed.connect(_on_undo_pressed)
	bottom.add_child(undo_button)

	end_button = Button.new()
	end_button.text = Lang.t("Взять")
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
	_build_confirm_dialog()
	_sync_top_bar()

## Смена сцены с проверкой, что нас ещё есть в дереве.
##
## Оба вызова отсюда — после await или по сетевому сигналу: за это
## время партию могли уже закрыть (игрок вышел в меню, связь отвалилась
## и клиент уже ушёл в main_menu). У отсоединённого узла get_tree()
## возвращает null, и прямой вызов change_scene_to_file падал с
## «Cannot call method 'change_scene_to_file' on a null value».
func _go_menu() -> void:
	if not is_inside_tree():
		return
	get_tree().change_scene_to_file("res://scenes/main_menu.tscn")


func _on_leave_to_menu() -> void:
	_ysdk(&"gameplay_stop")
	_hint_ad_pending = false
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
	_go_menu()

## Свой диалог выбора вместо системного ConfirmationDialog: тёмная
## скруглённая панель с зелёной кнопкой — в стиле игры, а не ОС.
## Один на оба вопроса («Взять карту», «Выйти в меню»): текст и действие
## подменяются при показе, обработчики не копятся.
func _build_confirm_dialog() -> void:
	_confirm_overlay = ColorRect.new()
	_confirm_overlay.color = Color(0, 0, 0, 0.6)
	_confirm_overlay.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	_confirm_overlay.mouse_filter = Control.MOUSE_FILTER_STOP
	_confirm_overlay.visible = false
	_confirm_overlay.gui_input.connect(_on_confirm_backdrop)
	add_child(_confirm_overlay)
	var center := CenterContainer.new()
	center.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	center.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_confirm_overlay.add_child(center)
	var panel := PanelContainer.new()
	var sb := StyleBoxFlat.new()
	sb.bg_color = Color(0.09, 0.12, 0.17, 0.98)
	sb.border_color = Color("43A047")
	sb.set_border_width_all(2)
	sb.set_corner_radius_all(14)
	sb.content_margin_left = 20.0
	sb.content_margin_right = 20.0
	sb.content_margin_top = 16.0
	sb.content_margin_bottom = 16.0
	panel.add_theme_stylebox_override("panel", sb)
	panel.custom_minimum_size = Vector2(
		minf(Settings.touch(420), get_viewport_rect().size.x * 0.9), 0)
	center.add_child(panel)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 14)
	panel.add_child(box)
	_confirm_title = Label.new()
	_confirm_title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_confirm_title.add_theme_font_size_override("font_size", Settings.fs(22))
	_confirm_title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(_confirm_title)
	_confirm_text = Label.new()
	_confirm_text.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	_confirm_text.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_confirm_text.add_theme_font_size_override("font_size", Settings.fs(16))
	_confirm_text.add_theme_color_override("font_color", Color(1, 1, 1, 0.9))
	box.add_child(_confirm_text)
	var row := BoxContainer.new()
	row.alignment = BoxContainer.ALIGNMENT_CENTER
	row.add_theme_constant_override("separation", 12)
	box.add_child(row)
	_confirm_ok = Button.new()
	_confirm_ok.custom_minimum_size = Vector2(Settings.touch_w(120), Settings.touch(52))
	_confirm_ok.add_theme_font_size_override("font_size", Settings.fs(16))
	_confirm_ok.pressed.connect(_on_confirm_ok)
	_apply_accent_style(_confirm_ok, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	row.add_child(_confirm_ok)
	var cancel := Button.new()
	cancel.text = Lang.t("Отмена")
	cancel.custom_minimum_size = Vector2(Settings.touch_w(120), Settings.touch(52))
	cancel.add_theme_font_size_override("font_size", Settings.fs(16))
	cancel.pressed.connect(_close_confirm)
	row.add_child(cancel)
	_confirm_cancel = cancel


func _ask_confirm(title: String, text: String, ok_text: String, action: Callable) -> void:
	if _confirm_overlay == null:
		return
	_confirm_title.text = title
	_confirm_text.text = text
	_confirm_ok.text = ok_text
	_confirm_action = action
	_confirm_overlay.visible = true


func _close_confirm() -> void:
	if _confirm_overlay != null:
		_confirm_overlay.visible = false
	_confirm_action = Callable()


func _on_confirm_ok() -> void:
	var act := _confirm_action
	_close_confirm()
	if act.is_valid():
		act.call()


func _on_confirm_backdrop(event: InputEvent) -> void:
	# Тап мимо окна — тоже отмена.
	var cancel := false
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		cancel = mb.pressed and mb.button_index == MOUSE_BUTTON_LEFT
	elif event is InputEventScreenTouch:
		cancel = (event as InputEventScreenTouch).pressed
	if cancel:
		_close_confirm()
		_confirm_overlay.accept_event()

func _make_top_button(text_value: String, tip: String, handler: Callable, full_value: String = "") -> Button:
	var btn := Button.new()
	btn.text = text_value
	btn.tooltip_text = tip
	btn.custom_minimum_size = Vector2(60, Settings.touch(46))
	btn.clip_text = true
	btn.add_theme_font_size_override("font_size", Settings.fs(15))
	btn.set_meta("short_text", text_value)
	btn.set_meta("full_text", full_value if not full_value.is_empty() else text_value)
	btn.pressed.connect(handler)
	btn.pressed.connect(_close_burger_menu)
	return btn


## Честная ширина верхней кнопки по её подписи: у кнопок с clip_text
## движок минимум по тексту не считает, и ряд думал, что все кнопки
## по 60 px — на большом тексте подписи срезались до двух букв,
## хотя места на широком экране хватало. Пол 60 px оставлен: на мелких
## шкалах кнопки выглядят как раньше.
func _top_button_need(btn: Button) -> float:
	var w := 60.0
	var font: Font = btn.get_theme_font("font")
	if font != null:
		w = maxf(w, font.get_string_size(btn.text, HORIZONTAL_ALIGNMENT_LEFT, -1,
			btn.get_theme_font_size("font_size")).x)
	var sb := btn.get_theme_stylebox("normal")
	if sb != null:
		w += sb.content_margin_left + sb.content_margin_right
	else:
		w += 16.0
	return w


## Верхние кнопки либо стоят в один ряд, либо редкие уезжают в бургер.
## Частые (сохранить/вернуть/подсказка) остаются в строке всегда.
## Считать надо по честной ширине подписей, иначе при большом тексте
## ряд либо разъезжается на две линии, либо уезжает за правый край.
func _sync_top_bar() -> void:
	if deck_button == null or _top_actions == null or _burger_btn == null \
			or _burger_panel == null or _burger_box == null:
		return
	for btn in _top_action_buttons:
		(btn as Button).text = String((btn as Button).get_meta("short_text"))
		(btn as Button).add_theme_font_size_override("font_size", Settings.fs(15))
	# Частые кнопки растут с потолком fs_capped до «Среднего»: на большом
	# они такие же, как на среднем (иначе ряд не влезал бы в телефон),
	# и ряд влезает даже в телефон.
	for b in _top_pinned:
		(b as Button).add_theme_font_size_override("font_size", Settings.fs_capped(15, 1))
	var have := maxf(get_viewport_rect().size.x - 20.0, 200.0)
	var deck_need := deck_button.get_combined_minimum_size().x
	var need := deck_need
	for btn in _top_action_buttons:
		need += 6.0 + _top_button_need(btn as Button)
	var collapse := need > have
	for btn in _top_action_buttons:
		var b := btn as Button
		var in_overflow := _top_overflow.has(b)
		var key := "full_text" if (collapse and in_overflow) else "short_text"
		b.text = String(b.get_meta(key))
		var cur := b.custom_minimum_size
		if collapse and in_overflow:
			b.custom_minimum_size = Vector2(60.0, cur.y)
		else:
			b.custom_minimum_size = Vector2(_top_button_need(b), cur.y)
		var target: Control = _burger_box if (collapse and in_overflow) else _top_actions
		if b.get_parent() != target:
			b.get_parent().remove_child(b)
			target.add_child(b)
	_top_actions.visible = true
	_burger_btn.visible = collapse
	# Ширину ряда задаём явно суммой кнопок: вложенный FlowContainer сам
	# ужался бы до одной кнопки, и частые снова встали бы столбиком.
	var row_w := 0.0
	var first_in_row := true
	for ch in _top_actions.get_children():
		var c := ch as Control
		if c == null:
			continue
		row_w += c.get_combined_minimum_size().x
		if not first_in_row:
			row_w += 6.0
		first_in_row = false
	_top_actions.custom_minimum_size = Vector2(row_w, 0)
	var was_collapsed := _top_collapsed
	_top_collapsed = collapse
	if not collapse:
		_set_burger_open(false, false)
	elif not was_collapsed:
		_set_burger_open(false, false)
	if _burger_open:
		_place_burger_panel()
	elif not was_collapsed:
		_set_burger_open(false, false)


func _toggle_burger_menu() -> void:
	# Тап, закрывший меню через ловец, отдаёт ещё и release в кнопку
	# под ним: без паузы меню тут же открылось бы обратно.
	if Time.get_ticks_msec() - _burger_closed_ms < 350:
		return
	_set_burger_open(not _burger_open)


func _close_burger_menu() -> void:
	_set_burger_open(false)


func _set_burger_open(open: bool, animate := true) -> void:
	if _burger_panel == null:
		return
	if not _top_collapsed:
		open = false
	if open == _burger_open and _burger_panel.visible == open:
		return
	_burger_open = open
	if _burger_tween != null and _burger_tween.is_valid():
		_burger_tween.kill()
	if _burger_catcher != null:
		_burger_catcher.visible = open
	if not open and not animate:
		_burger_panel.visible = false
		return
	_burger_panel.visible = true
	_place_burger_panel()
	_burger_panel.pivot_offset = Vector2(_burger_panel.size.x * 0.5, 0.0)
	_burger_panel.modulate.a = 1.0 if open else _burger_panel.modulate.a
	_burger_panel.scale = Vector2.ONE if open else _burger_panel.scale
	if not animate:
		_burger_panel.modulate.a = 1.0 if open else 0.0
		_burger_panel.visible = open
		if _burger_catcher != null:
			_burger_catcher.visible = open
		return
	_burger_tween = create_tween()
	_burger_tween.set_parallel(true)
	if open:
		_burger_panel.modulate.a = 0.0
		_burger_panel.scale = Vector2(1.0, 0.82)
		_burger_tween.tween_property(_burger_panel, "modulate:a", 1.0, 0.22)
		_burger_tween.tween_property(_burger_panel, "scale", Vector2.ONE, 0.24) \
			.set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	else:
		_burger_tween.tween_property(_burger_panel, "modulate:a", 0.0, 0.18)
		_burger_tween.tween_property(_burger_panel, "scale", Vector2(1.0, 0.82), 0.20)
		_burger_tween.tween_callback(_hide_burger_panel)


func _hide_burger_panel() -> void:
	if not _burger_open and _burger_panel != null:
		_burger_panel.visible = false
	if _burger_catcher != null:
		_burger_catcher.visible = _burger_open


## Панель под кнопку «☰», правым краем по ней: поверх раскладки, ничего
## не сдвигает. Ширина — по содержимому, но не шире окна.
func _place_burger_panel() -> void:
	if _burger_panel == null or _burger_btn == null:
		return
	var r := _burger_btn.get_global_rect()
	var want := _burger_panel.get_combined_minimum_size()
	var vw := get_viewport_rect().size.x
	var w := minf(maxf(want.x, 200.0), maxf(vw - 20.0, 200.0))
	_burger_panel.size = Vector2(w, maxf(want.y, 1.0))
	_burger_panel.position = Vector2(
		clampf(r.end.x - w, 10.0, maxf(10.0, vw - w - 10.0)),
		r.end.y + 4.0)


func _on_burger_catcher(event: InputEvent) -> void:
	var tap := false
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		tap = mb.pressed and mb.button_index == MOUSE_BUTTON_LEFT
	elif event is InputEventScreenTouch:
		tap = (event as InputEventScreenTouch).pressed
	if tap:
		_burger_closed_ms = Time.get_ticks_msec()
		_set_burger_open(false)
		_burger_catcher.accept_event()

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
	pass_title.text = Lang.t("Передайте устройство игроку")
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
	pass_ready_button.text = Lang.t("Готов(-а)")
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
	_win_box = box

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
	again_btn.text = Lang.t("Заново")
	again_btn.custom_minimum_size = Vector2(Settings.touch_w(180), Settings.touch(60))
	again_btn.add_theme_font_size_override("font_size", Settings.fs(19))
	again_btn.pressed.connect(_new_match)
	_apply_accent_style(again_btn, Color("2E7D32"), Color("388E3C"), Color("1B5E20"))
	btn_box.add_child(again_btn)
	_again_btn = again_btn

	var to_menu_btn := Button.new()
	to_menu_btn.text = Lang.t("В меню")
	to_menu_btn.custom_minimum_size = Vector2(Settings.touch_w(180), Settings.touch(60))
	to_menu_btn.add_theme_font_size_override("font_size", Settings.fs(19))
	to_menu_btn.pressed.connect(_on_leave_to_menu)
	btn_box.add_child(to_menu_btn)

	# Третья кнопка — отдельным рядом: в ряд влезают только две
	# (touch_w режет ширину 44% окна), а текст здесь длиннее.
	var view_box := HBoxContainer.new()
	view_box.alignment = BoxContainer.ALIGNMENT_CENTER
	box.add_child(view_box)

	var view_btn := Button.new()
	view_btn.text = Lang.t("Посмотреть стол")
	view_btn.custom_minimum_size = Vector2(Settings.touch_w(240), Settings.touch(60))
	view_btn.add_theme_font_size_override("font_size", Settings.fs(19))
	view_btn.pressed.connect(_show_table_inspect)
	view_box.add_child(view_btn)

	# Возврат из просмотра — плавающей кнопкой: оверлей победы в это
	# время скрыт вместе со своей кнопкой.
	_inspect_btn = Button.new()
	_inspect_btn.text = Lang.t("К результату")
	_inspect_btn.custom_minimum_size = Vector2(Settings.touch_w(180), Settings.touch(60))
	_inspect_btn.add_theme_font_size_override("font_size", Settings.fs(19))
	_inspect_btn.top_level = true
	_inspect_btn.set_anchors_and_offsets_preset(Control.PRESET_BOTTOM_RIGHT,
		Control.PRESET_MODE_MINSIZE, 16)
	_inspect_btn.visible = false
	_inspect_btn.pressed.connect(_hide_table_inspect)
	add_child(_inspect_btn)

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
	title.text = Lang.t("Правила игры")
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
	close_btn.text = Lang.t("Закрыть")
	close_btn.clip_text = true
	close_btn.custom_minimum_size = Vector2(Settings.touch_w(200), Settings.touch(52))
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
	if _settings_panel != null:
		_settings_panel.custom_minimum_size = Vector2(_settings_panel_width(), 0)
	_sync_settings_rows()
	settings_overlay.visible = true

func _on_settings_text_scale(index: int) -> void:
	Settings.text_scale = index
	Settings.save_settings()
	call_deferred("_rebuild_ui")

func _on_settings_tile_step(index: int) -> void:
	Settings.tile_step = index
	Settings.save_settings()
	refresh()

func _on_settings_language(index: int) -> void:
	Settings.set_language("en" if index == 1 else "ru")
	call_deferred("_rebuild_ui")

func _rebuild_ui() -> void:
	# пересборка UI с сохранением партии (смена text_scale)
	if title_tween != null and title_tween.is_running():
		title_tween.kill()
	if toast_tween != null and toast_tween.is_running():
		toast_tween.kill()
	if _burger_tween != null and _burger_tween.is_valid():
		_burger_tween.kill()
	_burger_open = false
	_top_collapsed = false
	_burger_tween = null
	_drag_view = null
	row_blocks.clear()
	# Слот-призрак жил ребёнком стола и только что освобождён вместе
	# со всеми: массив чистим, иначе следующее наведение обратится
	# к висячей ссылке (смена настроек посреди перетаскивания).
	_row_slots.clear()
	_reset_slot_hover()
	var was_pass := pass_overlay != null and pass_overlay.visible
	var was_win := win_overlay != null and win_overlay.visible
	var was_inspect := _inspect_btn != null and _inspect_btn.visible
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
	_inspect_btn.visible = was_inspect
	if was_win:
		# Пересборка съела детей оверлея вместе с карточкой — показываем
		# заново (флаг _partner_ad_shown гасим: это тот же финал).
		_partner_ad_shown = false
		_maybe_show_partner_ad()
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
	_settings_rows.clear()

	var panel := PanelContainer.new()
	_settings_panel = panel
	panel.custom_minimum_size = Vector2(_settings_panel_width(), 0)
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
	title.text = Lang.t("Настройки")
	title.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	title.add_theme_font_size_override("font_size", Settings.fs(22))
	title.add_theme_color_override("font_color", Color("FFD54F"))
	box.add_child(title)

	box.add_child(_make_settings_row(Lang.t("Текст:"),
		Lang.names(Settings.TEXT_SCALE_NAMES), Settings.text_scale, _on_settings_text_scale))
	box.add_child(_make_settings_row(Lang.t("Карточки:"),
		Lang.names(Settings.TILE_SIZE_NAMES), Settings.tile_step, _on_settings_tile_step))
	box.add_child(_make_settings_row(Lang.t("Язык:"), PackedStringArray(["Русский", "English"]),
		1 if Settings.language == "en" else 0, _on_settings_language))

	var close_btn := Button.new()
	close_btn.text = Lang.t("Закрыть")
	close_btn.clip_text = true
	close_btn.custom_minimum_size = Vector2(Settings.touch_w(200), Settings.touch(52))
	close_btn.size_flags_horizontal = Control.SIZE_SHRINK_CENTER
	close_btn.add_theme_font_size_override("font_size", Settings.fs(17))
	close_btn.pressed.connect(func(): settings_overlay.visible = false)
	box.add_child(close_btn)

func _make_settings_row(label_text: String, names: PackedStringArray, current: int, handler: Callable) -> BoxContainer:
	# BoxContainer, а не HBoxContainer: на узком экране подпись и список
	# встают столбиком, иначе ряд растягивает панель шире окна.
	var row := BoxContainer.new()
	_settings_rows.append(row)
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


func _settings_panel_width() -> float:
	# Панель настроек не шире окна: фиксированные 460 px на узком телефоне
	# уезжали за оба края сразу — CenterContainer её не ужмёт.
	return minf(460.0, maxf(get_viewport_rect().size.x - 20.0, 240.0))


func _sync_settings_rows() -> void:
	if _settings_panel == null:
		return
	var avail := _settings_panel_width() - 32.0
	for row in _settings_rows:
		var box := row as BoxContainer
		if box == null:
			continue
		var need := 0.0
		var first := true
		for item in box.get_children():
			var c := item as Control
			if c == null:
				continue
			need += c.get_combined_minimum_size().x
			if not first:
				need += float(box.get_theme_constant("separation"))
			first = false
		box.vertical = need > avail

# ---------------------------------------------------------------- match flow

func _new_match() -> void:
	_online = false
	_bot_seq += 1
	_bot_active = false
	_stats_recorded = false
	_hint_ids.clear()
	_hints_used.clear()
	_present_queue.clear()
	_present_busy = false
	_present_gen += 1
	_title_shown_for = -1
	_steps_since_title = false
	_flight_active = false
	_refresh_pending = false
	_title_pending = false
	_pending_title_seat = -1
	_present_orphans.clear()
	# Метки анимации от прошлой партии: не сброшенные id шагов уехали бы
	# в локальную игру и «прилетали» бы чужие фишки; показываемое место
	# держало бы подсветку несуществующего игрока. Счётчик состояний —
	# следующее состояние снова будет загрузкой стола.
	_shown_seat = -1
	_anim_force.clear()
	_anim_stagger = false
	_anim_load = false
	_states_seen = 0
	_partner_ad_shown = false
	_hint_ad_pending = false
	_win_ad_done = false
	_drew_seat = -1
	_draw_marks.clear()
	state = GameState.create(Settings.player_count, Array(Settings.player_names), Settings.require_30)
	invalid_row_ids.clear()
	win_overlay.visible = false
	if _inspect_btn != null:
		_inspect_btn.visible = false
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
	if _inspect_btn != null:
		_inspect_btn.visible = false
	_ysdk(&"gameplay_start")
	_bot_seq += 1
	_bot_active = false
	_hint_ids.clear()
	_hints_used.clear()
	_present_queue.clear()
	_present_busy = false
	_present_gen += 1
	_title_shown_for = -1
	_steps_since_title = false
	_flight_active = false
	_refresh_pending = false
	_title_pending = false
	_pending_title_seat = -1
	_present_orphans.clear()
	# Как в _new_match: без сброса метки прошлой комнаты привязали бы
	# подсветку и шаги к чужому месту новой партии.
	_shown_seat = -1
	_anim_force.clear()
	_anim_stagger = false
	_anim_load = false
	_states_seen = 0
	_partner_ad_shown = false
	_hint_ad_pending = false
	_win_ad_done = false
	_drew_seat = -1
	_draw_marks.clear()
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
	if Net.game_draft.is_connected(_on_net_draft):
		Net.game_draft.disconnect(_on_net_draft)
	if Net.notice.is_connected(toast):
		Net.notice.disconnect(toast)
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
	toast(String(res.get("reason", Lang.t("партия недоступна"))), true)
	_net_unwatch()
	_go_menu()


func _on_net_state(view: Dictionary, grace: float, paused: bool, waiting: bool) -> void:
	_on_state_received(view, grace, paused, waiting)


func _on_state_received(view: Dictionary, grace: float, paused: bool, waiting: bool) -> void:
	_sending = false
	# Первое состояние партии — загрузка стола, а не ход: force первого
	# полетит немедленным путём (см. _anim_load), в очередь не встанет.
	_anim_load = _states_seen == 0
	_states_seen += 1
	_hint_ids.clear()
	invalid_row_ids.clear()
	# Состояние с сервера — единственный источник «прилетающих» фишкок.
	# Локальные перерисовки (перетаскивание, подсказки) анимировать нельзя:
	# там ничего не «прилетает», фишка уже лежит на месте.
	_anim_pending = true
	# Накопление, а не подмена: пока летит сегмент презентации, пересборку
	# откладываем, и состояний за это время может прийти несколько. Каждое
	# приносит только СВОИ новые фишки (стол предыдущего уже применён), а
	# метка поэтапности живёт до самой пересборки — терять ни то, ни другое
	# нельзя: потерянные фишки показались бы разом минуя очередь.
	# Чьи это фишки: место перед current при непустом lastTurn (выкладка
	# передаёт ход — выкладывал предыдущий), иначе само current. Считаем
	# ДО _apply_state — там ещё прошлое состояние; счётчик мест одинаков.
	var mv_seat := -1
	if state != null and state.player_count() > 0:
		var n_st := state.player_count()
		var cur_v := clampi(int(view.get("current", 0)), 0, n_st - 1)
		if (view.get("lastTurn", []) as Array).is_empty():
			mv_seat = cur_v
		else:
			mv_seat = (cur_v - 1 + n_st) % n_st
	for id in _fresh_committed_ids(view):
		if not _anim_force.has(int(id)):
			_anim_force[int(id)] = mv_seat
	_apply_state(view, grace, paused, waiting)
	# Чужой ход — показываем, кто ходит. Наш собственный ход требует
	# действия игрока, и подсказка с названием мешала бы.
	if state != null and state.finished:
		_show_win()
		_show_wait("")
		_present_queue.clear()
		_present_gen += 1
		_present_orphans.clear()
		# Полёт обрывать нечем: титры/шаги больше не планируются, а стол
		# обязан пересобраться под экран победы прямо сейчас.
		_flight_active = false
		_refresh_pending = false
		_title_pending = false
		_pending_title_seat = -1
		# Показ прерван (gen++ выше) — хвост очистки очереди его не
		# сбросил бы: подсветка уехала бы на последнего показанного игрока
		# вместо победителя по state.current.
		_shown_seat = -1
		refresh()
		return
	pass_overlay.visible = false
	_show_wait(_wait_text(grace, paused, waiting))
	# Титр — ПОСЛЕ шагов: этот коммит и есть ход того, чей титр уже показан
	# в начале его хода, а теперь встаёт титр следующего. Порядок в очереди
	# «шаги — титр» и даёт связку «титр Х сразу перед шагами Х».
	refresh()
	_enqueue_turn_title()


## Титр «Ход: …» — в очередь презентаций, а не сразу на экран: шаги
## предыдущего бота ещё могут долетать, и титр следующего хода встаёт
## за ними своим чередом. Свой ход титруем только после чужих шагов —
## иначе после каждого своего хода мигало бы «Ход: вы».
func _enqueue_turn_title() -> void:
	if state == null or state.finished:
		return
	var seat := state.current
	if _refresh_pending:
		# Пересборка этого состояния отложена — его шаги ещё НЕ в очереди,
		# и титр встал бы перед ними вперёд. Откладываем: достанет его
		# отложенный refresh, но с ЧЕЙ стороны мы его заказали. Полёт без
		# отложенного refresh не мешает: его шаги в очереди уже есть и титр
		# просто встанет за ними своим чередом.
		_title_pending = true
		_pending_title_seat = seat
		return
	_append_turn_title(seat)


## Титр конкретного места в очередь презентаций, не сразу на экран.
func _append_turn_title(seat: int) -> void:
	if state == null or state.finished or seat < 0:
		return
	if seat == _title_shown_for:
		return
	if state.my_turn() and not _steps_since_title:
		return
	# Отметку ставим ТОЛЬКО когда титр реально встал в очередь: иначе
	# пропущенный «мой ход без чужих шагов» навсегда заблокировал бы
	# следующий честный титр этого же места.
	_title_shown_for = seat
	_present_queue.append({"kind": "title", "seat": seat,
		"text": _turn_title_text(seat)})
	_steps_since_title = false
	_pump_present()


## Титр ещё не устарел: тот игрок ходит прямо сейчас (seat == current) или
## только что сходил (current — следующий за ним). Шаги его хода в такой
## очереди стоят СРАЗУ после титра — показать их вслед за титром и есть
## смысл. Ход ушёл на два и дальше — титр опоздал, пропускаем молча.
func _title_fresh(seat: int) -> bool:
	if state == null or state.finished or seat < 0 or state.current < 0:
		return false
	var n := state.player_count()
	if n <= 0:
		return false
	var back := (state.current - seat) % n
	if back < 0:
		back += n
	return back <= 1


func _wait_text(grace: float, paused: bool, waiting: bool) -> String:
	if waiting:
		# Второго игрока нет, и это важнее чьего-либо хода: кнопки всё
		# равно заблокированы сервером, а надпись объясняет, почему.
		return Lang.t("Ждём второго игрока: партия на паузе.")
	if paused:
		return Lang.t("Игра на паузе: кто-то отвалился. Ждём возвращения.")
	if state != null and (state.finished or state.my_turn()):
		# Наш ход (или партия кончилась) — «ход соперника» здесь врёт:
		# чужая очередь показывается только когда ходит соперник. Иначе,
		# едва ход вернулся к нам, надпись про «соперника» висела бы над
		# нами же подсвеченной фишкой — наоборот.
		return ""
	if grace > 0.0:
		return Lang.t("Соперник не отвечает. Осталось ждать %d с.") % int(ceil(grace))
	# Отсчёт показывает отдельная строка таймера — дублировать её словами
	# «Ход соперника» не нужно. Без отсчёта (старый сервер) строка остаётся.
	if _online and _turn_deadline_ms > Time.get_ticks_msec():
		return ""
	return Lang.t("Ход соперника")


func _apply_state(view: Dictionary, grace: float, paused: bool, waiting: bool = false) -> void:
	if view.is_empty():
		return
	_grace = grace
	_paused = paused
	_waiting = waiting
	# Промежуточные game.state (реждойн, пауза, обновление отсчёта) не
	# гасят чужой черновик, пока ход его автора не кончился: иначе серые
	# фишки пропадали бы от любого состояния, прилетевшего посреди хода.
	var draft_kept := _draft_active()
	# Отправная сторона черновика: с новым состоянием начинаем с чистого
	# листа, иначе следующий ход не отправился бы «как в первый раз».
	_last_draft_json = ""
	_draft_sent_ms = 0
	# Отсчёт сервера. Пришло null (пауза/ожидание/конец) — дедлайн гаснет
	# сам. Ключ при этом может быть и в словаре, но с null: views.js отдаёт
	# turnLeft: null, а не пропускает ключ, поэтому int(null) падал бы.
	# ВНИМАНИЕ: через `or` здесь нельзя — в GDScript `or` возвращает bool,
	# а не операнд (как в Python): int(60 or 0) давал int(true) = 1, и
	# таймер всегда показывал одну секунду.
	var turn_raw = view.get("turnLeft", 0)
	var turn_left := int(turn_raw) if turn_raw != null else 0
	_turn_deadline_ms = (Time.get_ticks_msec() + turn_left * 1000) if turn_left > 0 else 0
	var prev := state
	state = ViewBuilder.build(view)
	# Прошлым ходил сетевой бот — его коммит раскладываем поэтапно.
	# Ход опознаём и по новому состоянию (место прямо перед current +
	# непустой lastTurn), а не только по прошлому: промежуточное
	# «ходит бот» могло не дойти — вход посреди чужого хода, сбой,
	# старый сервер без lastTurn. Тихий пропуск stagger тут чинился
	# бы только чудом, поэтому оба признака работают через «или».
	# Накапливаем («или» с прежним): отложенная пересборка держит метку
	# живой, пока летит сегмент, и следующее состояние не сбрасывает её.
	_anim_stagger = _anim_stagger or _is_bot_commit(prev, view) \
		or (prev != null and prev.is_bot_player(prev.current))
	# Кто брал из колоды: рука выросла на одну при том же столе и пустом
	# lastTurn — ни выкладки, ни пропуска. Помечаем место, пока его не
	# перекрыло следующее взятие. Своё взятие точнее знает diff в
	# _mark_drawn_diff (там же номер фишки), здесь — все остальные.
	_drew_seat = -1
	if _online and prev != null:
		var seats := prev.player_count()
		if seats > 0:
			var mover := (clampi(int(view.get("current", 0)), 0, seats - 1) - 1 + seats) % seats
			if _seat_drew(prev, view, mover):
				_drew_seat = mover
				_mark_drawn_state(prev, mover)
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
			_draft_new_ids = _draft_new_of(_draft_rows)
	elif _draft_from >= 0:
		_clear_draft()
	_show_wait(_wait_text(grace, paused, waiting))


## Коммит сетевого бота по новому состоянию: место прямо перед current
## — бот, и в этом состоянии есть выставленные им фишки (lastTurn).
## Прошлое состояние для этого не нужно — оно могло пропасть по дороге.
func _is_bot_commit(prev: GameState, view: Dictionary) -> bool:
	if prev == null:
		return false
	var n := prev.player_count()
	if n <= 0:
		return false
	var cur := clampi(int(view.get("current", 0)), 0, n - 1)
	var mover := (cur - 1 + n) % n
	if not prev.is_bot_player(mover):
		return false
	return not (view.get("lastTurn", []) as Array).is_empty()


## Место брало из колоды: рука выросла ровно на одну при том же столе
## и пустом lastTurn — ни выкладки (там lastTurn не пуст), ни пропуска
## (рука та же). Стол сравниваем наборами id: порядок рядов не важен.
func _seat_drew(prev: GameState, view: Dictionary, seat: int) -> bool:
	if prev == null or seat < 0 or seat >= prev.player_count():
		return false
	if not (view.get("lastTurn", []) as Array).is_empty():
		return false
	if prev.hand_size(seat) + 1 != _view_hand_count(view, seat):
		return false
	return _view_table_ids(view) == _prev_table_ids(prev)


func _view_hand_count(view: Dictionary, seat: int) -> int:
	for raw in view.get("players", []):
		if raw is Dictionary and int((raw as Dictionary).get("seat", -1)) == seat:
			return maxi(0, int((raw as Dictionary).get("handCount", 0)))
	var arr: Array = view.get("players", [])
	if seat >= 0 and seat < arr.size() and arr[seat] is Dictionary:
		return maxi(0, int((arr[seat] as Dictionary).get("handCount", 0)))
	return -1


func _view_table_ids(view: Dictionary) -> Array:
	var out := []
	for raw in view.get("table", []):
		if raw is Dictionary:
			for tid in ((raw as Dictionary).get("tileIds", []) as Array):
				out.append(int(tid))
	out.sort()
	return out


func _prev_table_ids(prev: GameState) -> Array:
	var out := []
	for row in prev.table:
		var r := row as GameState.Row
		if r != null:
			for t in r.tiles:
				out.append((t as Tile).id)
	out.sort()
	return out


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
	_go_menu()


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
	_show_wait(Lang.t("Нет связи: %s") % detail)
	refresh()


## Отправляет готовый стол и ждёт вердикта. Сорванная связь тут же
## возвращает управление: ждать бесконечно нельзя, партия может
## продолжаться после переподключения.
func _send_and_wait(send: Callable, args: Array = []) -> void:
	if _sending:
		return
	_sending = true
	_show_wait(Lang.t("Отправляем ход…"))
	refresh()
	var res: Dictionary = await send.callv(args)
	_sending = false
	if not Net.is_linked():
		_show_wait(Lang.t("Нет связи с сервером"))
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
		toast(String(res.get("reason", Lang.t("Ход отклонён"))), true)
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
		pass_title.text = Lang.t(
		"Игра начинается - первый ход:") if first else Lang.t("Передайте устройство игроку")
		pass_name.text = state.current_player().pname
		pass_overlay.visible = true

func _on_pass_ready() -> void:
	pass_overlay.visible = false
	_ysdk(&"gameplay_start")

func _show_turn_title() -> void:
	if state == null:
		return
	_flash_turn_title(_turn_title_text(state.current))


## Текст титра для места (имя + пометка бота). Текст фиксируем при
## постановке в очередь: к моменту показа ход уже уйдёт дальше.
func _turn_title_text(seat: int) -> String:
	var who := "?"
	if state != null and seat >= 0 and seat < state.player_count():
		# Наш ход в сетевой партии — кричим явно. «Ход: <ник>» на своём
		# же устройстве читается как чужой ход, а таймер сверху так и
		# вовсе не объясняет, что делать именно сейчас.
		if _online and state.local_seat >= 0 and seat == state.local_seat:
			return Lang.t("Ваш ход!")
		who = (state.players[seat] as GameState.Player).pname
		# Серверный бот ходит сам, и пометить его обязаны: иначе партия,
		# сидящая на паузе или идущая на чужих устройствах, выглядит как
		# молчащий человек с выключенным экраном.
		if state.is_bot_player(seat):
			who += Lang.t(" (бот)")
	return Lang.t("Ход: %s") % who


func _flash_turn_title(text: String) -> void:
	if turn_title_overlay == null or turn_title_label == null:
		return
	turn_title_label.text = text
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
	var who := Lang.t("Ваш ход") if state.my_turn() else Lang.t(
		"Ход: %s") % state.current_player().pname
	if not state.my_turn() and state.is_bot_player(state.current):
		who += Lang.t(" (бот)")
	_turn_timer_label.text = Lang.t("%s — %d с") % [who, left]
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
	# Ход бота — тоже событие для анимации: иначе выставленные фишки
	# просто появлялись бы на столе. Перерисовки ниже подхватят метку.
	_anim_pending = true
	var plan := TurnPlanner.plan(state, Settings.bot_level)
	var action := String(plan.get("action", ""))
	var action_ok := false
	if action == "place":
		var placed_ok := false
		if Settings.bot_anim:
			placed_ok = await _bot_place_stepwise(plan.get("ops", []), seq)
		else:
			placed_ok = state.apply_ops(plan.get("ops", []))
		if placed_ok:
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
		var bot_seat := state.current
		var dr := state.draw_from_deck()
		if dr.get("ok", false):
			_note_draw(bot_seat, dr.get("tile", null))
			_anim_draw_only(dr.get("tile", null))
		action_ok = bool(dr.get("ok", false))
	elif action == "skip":
		# Тихо, как взятие: снимок не нужен, иначе смена руки при передаче
		# хода устроила бы перелёт всей руки вместо незаметной смены.
		_anim_pending = false
		action_ok = bool(state.skip_turn().get("ok", false))
	if not action_ok:
		if state.can_draw():
			var fb_seat := state.current
			var fb := state.draw_from_deck()
			if fb.get("ok", false):
				_note_draw(fb_seat, fb.get("tile", null))
				_anim_draw_only(fb.get("tile", null))
		elif state.can_skip():
			_anim_pending = false
			state.skip_turn()
	invalid_row_ids.clear()
	_bot_active = false
	refresh()
	if state.finished:
		_show_win()
	else:
		_show_pass()


## Постановка бота по одной фишке: применили операцию — показали
## прилёт — пауза — следующая. Та же семантика, что у apply_ops,
## только ссылка «nK» на новый ряд живёт между шагами, а не внутри
## одного вызова: иначе вторая фишка в тот же ряд открыла бы новый.
func _bot_place_stepwise(ops: Array, seq: int) -> bool:
	var created := {}
	for op in ops:
		if seq != _bot_seq or state == null or state.finished \
				or not _is_bot_turn() or not is_inside_tree():
			return false
		if not (op is Dictionary) or not _bot_apply_op(op, created):
			return false
		_anim_pending = true
		refresh()
		await get_tree().create_timer(0.55).timeout
	return true


## Один шаг плана бота. Диспетчер — как в GameState.apply_ops.
func _bot_apply_op(op: Dictionary, created: Dictionary) -> bool:
	if state == null or state.finished:
		return false
	var kind := String(op.get("op", ""))
	if kind == "place":
		var row := _bot_resolve_row(String(op.get("to", "")), created)
		if row == null:
			return false
		return state.place_from_hand(int(op.get("tile", -1)), row.id, int(op.get("index", 99)))
	if kind == "move":
		var src := _bot_resolve_row(String(op.get("from", "")), created)
		var dst := _bot_resolve_row(String(op.get("to", "")), created)
		if src == null or dst == null:
			return false
		return state.move_tile(src.id, int(op.get("tile", -1)), dst.id, int(op.get("index", 99)))
	return false


func _bot_resolve_row(ref: String, created: Dictionary) -> GameState.Row:
	if ref.begins_with("n"):
		if not created.has(ref):
			created[ref] = state.add_row().id
		return state.row_by_id(int(created[ref]))
	if ref.begins_with("r"):
		return state.row_by_id(int(ref.substr(1)))
	return null


func _show_win() -> void:
	# Web: сначала обратный отсчёт и реклама, экран победы — после них.
	if OS.has_feature("web") and not _win_ad_done and state != null and state.finished:
		_win_ad_done = true
		_start_win_countdown()
		return
	_show_win_screen()


## Собственно экран победы (после рекламы — на Web; сразу — везде ещё).
func _show_win_screen() -> void:
	_record_stats()
	win_title.text = Lang.t("Победитель - %s") % state.player_name(state.winner)
	win_overlay.visible = true
	if _inspect_btn != null:
		_inspect_btn.visible = false
	_maybe_show_partner_ad()


## Обратный отсчёт 2–1 на весь экран (только Web, не пропускается):
## дальше — fullscreen от SDK. Цифры огромные, фон полупрозрачный.
func _start_win_countdown() -> void:
	var ov := ColorRect.new()
	ov.color = Color(0, 0, 0, 0.72)
	ov.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	ov.mouse_filter = Control.MOUSE_FILTER_STOP
	add_child(ov)
	var lab := Label.new()
	lab.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	lab.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	lab.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	lab.add_theme_font_size_override("font_size", Settings.fs(160))
	lab.add_theme_color_override("font_color", Color(1, 1, 1, 0.95))
	lab.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ov.add_child(lab)
	for n in ["2", "1"]:
		if not is_instance_valid(ov):
			return
		lab.text = n
		await get_tree().create_timer(1.0).timeout
	if is_instance_valid(ov):
		ov.queue_free()
	_show_win_ad()


## Fullscreen от SDK, затем экран победы. SDK молчит — сразу победа:
## игрока нельзя держать на пустом экране.
func _show_win_ad() -> void:
	_ysdk(&"show_endgame_fullscreen")
	for i in range(240):
		await get_tree().create_timer(0.5).timeout
		if state == null:
			return
		if bool(_poll_endgame_ad().get("closed", false)):
			break
	_show_win_screen()


## Состояние post-game рекламы (по умолчанию — закрыта: вне Web её нет).
func _poll_endgame_ad() -> Dictionary:
	if not OS.has_feature("web") or not ResourceLoader.exists(YANDEX_SDK_SCRIPT):
		return {"closed": true, "error": "nosdk"}
	return (load(YANDEX_SDK_SCRIPT) as GDScript).poll_endgame_ad()


## Экран победы скрыт — смотрим финальный стол. Только чтение: finished
## гасит драги (_can_act), дропы (gui_can_drop) и кнопки (_update_buttons),
## а листать стол паном можно — так и задумано.
func _show_table_inspect() -> void:
	if state == null or not state.finished:
		return
	win_overlay.visible = false
	_inspect_btn.visible = true


## Вернуться на экран победы из просмотра стола.
func _hide_table_inspect() -> void:
	_inspect_btn.visible = false
	if state != null and state.finished:
		win_overlay.visible = true


## Вызов lifecycle API Яндекс Игр (только Web; elsewhere no-op внутри).
func _ysdk(method: StringName) -> void:
	if not OS.has_feature("web"):
		return
	if not ResourceLoader.exists(YANDEX_SDK_SCRIPT):
		return
	(load(YANDEX_SDK_SCRIPT) as GDScript).call(method)


## Партнёрская карточка на экране победы (только Android/RuStore,
## TEST MODE). Показ — максимум один за финал партии, строго после её
## окончания: во время игры, между ходами и в поле её нет по построению.
func _maybe_show_partner_ad() -> void:
	if not OS.has_feature("android"):
		return
	if state == null or not state.finished:
		return
	if _partner_ad_shown or _win_box == null:
		return
	if not ResourceLoader.exists(PARTNER_AD_SCRIPT) \
			or not ResourceLoader.exists(PARTNER_AD_CARD_SCRIPT):
		return
	var pad = load(PARTNER_AD_SCRIPT)
	if not bool(pad.ENABLED):
		# Релиз без рекламы: код и тесты на месте, показ выключен флагом.
		_partner_ad_shown = true
		return
	_partner_ad_shown = true
	var battery := -1
	if ResourceLoader.exists(MARKET_HELPER_SCRIPT):
		battery = int((load(MARKET_HELPER_SCRIPT) as GDScript).battery_percent())
	var ad: Dictionary = (pad as GDScript).pick(battery)
	ad["image"] = String((pad as GDScript).image_path(String(ad.get("kind", ""))))
	var card = (load(PARTNER_AD_CARD_SCRIPT) as GDScript).new()
	_win_box.add_child(card)
	card.setup(ad)
	card.open_requested.connect(_on_partner_ad_open)


## Переход по рекламе — только явным нажатием кнопки. Двойной тап за
## секунду второй Intent не создаёт. Неудача — аккуратный тост, игра
## продолжается без ошибок.
func _on_partner_ad_open(url: String) -> void:
	var now := Time.get_ticks_msec()
	if now - _partner_ad_open_ms < 1000:
		return
	_partner_ad_open_ms = now
	var ok := false
	if OS.has_feature("android") and ResourceLoader.exists(MARKET_HELPER_SCRIPT):
		ok = bool((load(MARKET_HELPER_SCRIPT) as GDScript).open_partner_link(String(url)))
	if not ok:
		toast(Lang.t("Не получилось открыть ссылку"), true)


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
	_ask_confirm(Lang.t("Взять карту"), Lang.t("Взять число из колоды?\nХод сразу завершится."),
		Lang.t("Взять"), _on_draw_confirmed)

func _on_draw_confirmed() -> void:
	_hint_ids.clear()
	if _online:
		# Сервер в ответе номер не присылает — только новое состояние:
		# взятая фишка ровно та, которой в руке не было.
		var before := _hand_ids()
		await _send_and_wait(func(): return await Net.draw_from_deck())
		_mark_drawn_diff(before)
		return
	var drawer := state.current
	var r := state.draw_from_deck()
	if r.get("ok", false):
		_note_draw(drawer, r.get("tile", null))
		invalid_row_ids.clear()
		refresh()
		_show_pass()
	else:
		toast(String(r.get("reason", "")), true)


## Запомнить взятие: чип «· взял» и галочка с кружочком на фишке (пока в руке).
func _note_draw(seat: int, tile) -> void:
	if tile != null:
		_draw_marks[seat] = (tile as Tile).id
	_drew_seat = seat


## Тихий ход бота (взятие): никакого снимка до/после — взятие сразу
## передаёт ход, и снимок застал бы старую руку: при пересборке чужая
## рука вылетала бы призраками, а наша прилетала бы целиком — со стороны
## «боту прилетело несколько карточек». Force со взятой на всякий случай:
## если у неё вдруг есть вид, прилетит только она. Место (-1) не важно:
## офлайн force в очередь не встаёт, идёт немедленным путём.
func _anim_draw_only(tile) -> void:
	if tile == null:
		return
	_anim_pending = false
	_anim_force[int((tile as Tile).id)] = -1


## Id фишек руки смотрящего — для опознания взятой по сети.
func _hand_ids() -> Array:
	var out := []
	if state != null:
		for t in state.hand():
			out.append((t as Tile).id)
	return out


## Помечает взятую по сети: успех — ровно один новый id в руке.
## Отказ (рука та же) или странная дельта — молча без метки.
func _mark_drawn_diff(before: Array) -> void:
	if state == null or state.local_seat < 0:
		return
	var fresh := []
	for t in state.hand():
		var tid := (t as Tile).id
		if not before.has(tid) and not fresh.has(tid):
			fresh.append(tid)
	if fresh.size() == 1:
		_draw_marks[state.local_seat] = fresh[0]
		_drew_seat = state.local_seat
		refresh()


## Номер взятой по пришедшему состоянию: рука нашего места выросла ровно
## на одну — так помечаем и автовзятие по дедлайну (без нашего запроса
## diff в _mark_drawn_diff не вызывается и номер терялся: чип «· взял»
## был, а галочки на фишке не было). Чужие руки сервер не присылает
## (только число) — там остаётся пометка места. Успех — ровно один новый
## id, иначе молча без метки, как в _mark_drawn_diff.
func _mark_drawn_state(prev: GameState, mover: int) -> void:
	if state == null or state.local_seat < 0 or mover != state.local_seat:
		return
	var old := {}
	for t in prev.hand():
		old[(t as Tile).id] = true
	var fresh := []
	for t in state.hand():
		var tid := (t as Tile).id
		if not old.has(tid) and not fresh.has(tid):
			fresh.append(tid)
	if fresh.size() == 1:
		_draw_marks[state.local_seat] = fresh[0]

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
	toast(String(r.get("reason", Lang.t("Стол в невалидном состоянии"))), true)
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
		toast(String(check.get("reason", Lang.t("Ход нельзя завершить"))), true)
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
		toast(Lang.t("В этот ход ещё ничего не менялось"), false)
		return
	_hint_ids.clear()
	state.restore_turn_snapshot()
	invalid_row_ids.clear()
	refresh()
	toast(Lang.t("Стол и рука возвращены к началу хода"), false)

func _on_cp_save_pressed() -> void:
	if not _can_act():
		return
	if state.save_checkpoint():
		toast(Lang.t("Расклад сохранён (чекпоинт)"), false)
	else:
		toast(Lang.t("Сначала что-нибудь измените на столе"), false)

func _on_cp_restore_pressed() -> void:
	if not _can_act():
		return
	if state.restore_checkpoint():
		_hint_ids.clear()
		invalid_row_ids.clear()
		refresh()
		toast(Lang.t("Возврат к чекпоинту"), false)
	else:
		toast(Lang.t("Нет сохранённых раскладов"), false)

## Ключ подсказки — место текущего игрока: и в локальной, и в сетевой
## игре действует тот, чей сейчас ход (в сети чужой ход и так закрыт).
func _hint_key() -> int:
	if state == null:
		return -1
	return state.current

func _is_hint_used() -> bool:
	return bool(_hints_used.get(_hint_key(), false))

func _mark_hint_used() -> void:
	_hints_used[_hint_key()] = true

func _on_hint_pressed() -> void:
	if not _can_act() or _is_hint_used() or _hint_ad_pending:
		return
	if OS.has_feature("web"):
		_request_hint_ad()
		return
	_give_hint()


## Собственно подсказка: тратит разовую метку и показывает план.
## На Web вызывается только после сигнала награды от SDK (строго).
func _give_hint() -> void:
	_mark_hint_used()
	_hint_ids.clear()
	var plan := TurnPlanner.plan(state, TurnPlanner.LEVEL_IMPOSSIBLE)
	var action := String(plan.get("action", ""))
	if action == "place":
		_hint_ids = (plan.get("tiles", []) as Array).duplicate()
		toast(Lang.t("Подсказка: выложите %d %s — это +%d очков") % [
			_hint_ids.size(), _card_word(_hint_ids.size()),
			int(plan.get("points", 0))], false)
	elif action == "draw":
		toast(Lang.t("Подсказка: возьмите число из колоды"), false)
	elif action == "skip":
		toast(Lang.t("Подсказка: пропустите ход"), false)
	else:
		if state.table_status().get("ok", false):
			toast(Lang.t("Подсказка: можно завершать ход"), false)
		else:
			toast(Lang.t("Подсказка: закончите перестановку на столе"), false)
	refresh()

## Rewarded за подсказку (только Web, строго): показываем видео, ждём
## сигнал награды от SDK опросами. Награды нет (закрыл раньше, ошибка,
## SDK молчит) — подсказки нет, метка не тратится. Ход тем временем мог
## уйти — тогда просто гасим кнопку, без тостов задним числом.
func _request_hint_ad() -> void:
	if _hint_ad_pending:
		return
	_hint_ad_pending = true
	_update_buttons()
	_ysdk(&"show_hint_rewarded")
	var rewarded := false
	for i in range(360):
		await get_tree().create_timer(0.5).timeout
		if state == null or not _hint_ad_pending:
			return
		var st := _poll_hint_ad()
		if bool(st.get("rewarded", false)):
			rewarded = true
			break
		if bool(st.get("closed", false)):
			break
	_hint_ad_pending = false
	if rewarded and _can_act() and not _is_hint_used():
		_give_hint()
	else:
		if state != null:
			toast(Lang.t("Досмотрите рекламу до конца, чтобы получить подсказку"), false)
		_update_buttons()


## Состояние rewarded (по умолчанию — отказ: вне Web рекламы нет).
func _poll_hint_ad() -> Dictionary:
	if not OS.has_feature("web") or not ResourceLoader.exists(YANDEX_SDK_SCRIPT):
		return {"rewarded": false, "closed": true, "error": "nosdk"}
	return (load(YANDEX_SDK_SCRIPT) as GDScript).poll_hint_ad()

func _on_resized() -> void:
	_update_hint_zone_size()
	_sync_top_bar()
	if _burger_open:
		_place_burger_panel()

# ---------------------------------------------------------------- drag & drop

func on_drag_started(view: TileView) -> void:
	_drag_view = view
	_hint_ids.clear()
	_reset_slot_hover()
	# Пока тянем карточку, стол не должен сам ловить touch-скролл:
	# ScrollContainer перехватывает жест в щели между плитками, карточка
	# отстаёт от пальца, а ряды начинают уезжать. Своё листание по краям
	# экрана во время перетаскивания по-прежнему делает _auto_scroll_drag.
	_set_drag_scroll_locked(true)

func _end_drag() -> void:
	if _drag_view != null and is_instance_valid(_drag_view):
		_drag_view.modulate = Color.WHITE
	_drag_view = null
	_reset_slot_hover()
	_clear_row_slots()
	_set_drag_scroll_locked(false)
	_pan_pressed = false
	_pan_press_on_tile = false

func _set_drag_scroll_locked(locked: bool) -> void:
	if table_scroll == null:
		return
	table_scroll.mouse_filter = (
		Control.MOUSE_FILTER_IGNORE if locked else Control.MOUSE_FILTER_STOP)

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

## Пустой слот между рядами, пока тянем фишку: виден только нам,
## соперникам ничего не уходит (живое превью им отключено). Появляется
## после 400 мс зависания над междурядьем, прячется через 1.5 с после
## ухода курсора — чтобы успели попасть.
## Сброс трекинга зависания: следующее наведение считается заново.
func _reset_slot_hover() -> void:
	_slot_hover_pos = -1
	_slot_hover_time = 0
	_slot_grace_until = 0

func _update_row_slot_hover() -> void:
	if state == null or state.finished:
		return
	var mouse := get_global_mouse_position()
	var now := Time.get_ticks_msec()
	if not _row_slots.is_empty():
		# Слот показан: держим его, пока курсор в его зоне;
		# при уходе прячем с задержкой, чтобы успеть попасть.
		var shown := _row_slots[0] as Control
		if shown == null or not is_instance_valid(shown):
			_row_slots.clear()
			_reset_slot_hover()
			return
		var slot_pos := int(shown.get_meta("slot_pos", -1))
		if _hover_slot_pos(mouse) == slot_pos:
			_slot_grace_until = 0
		elif _slot_grace_until == 0:
			_slot_grace_until = now + SLOT_GRACE_MS
		elif now >= _slot_grace_until:
			_reset_slot_hover()
			_clear_row_slots()
		return
	_slot_grace_until = 0
	_track_gap_hover(mouse, now)


## Трекинг зависания над междурядьем: стоим 400 мс почти не двигаясь —
## показываем слот, ушли или дёрнулись — отсчёт заново.
func _track_gap_hover(mouse: Vector2, now: int) -> void:
	var pos := _hover_slot_pos(mouse)
	if pos < 0:
		if _slot_hover_pos >= 0:
			_reset_slot_hover()
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

func _show_row_slot(pos: int) -> void:
	_clear_row_slots()
	if state == null or state.finished or table_box == null:
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
	lab.text = Lang.t("+ новый ряд")
	lab.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	lab.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	lab.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	lab.mouse_filter = Control.MOUSE_FILTER_IGNORE
	lab.add_theme_font_size_override("font_size", Settings.fs(15))
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
			(slot as Node).queue_free()
	_row_slots.clear()

## Живое превью наведения отключено: пока карточку держат, соперникам
## ничего не показываем. Постановка видна только после отпускания — через
## черновик и подтверждённое состояние сервера.
## Соперник прислал весь свой стол: показываем его вместо базового, а
## выложенные в этот ход фишки (нет в серверном столе) — прозрачными
## с жирной зелёной рамкой.
func _on_net_draft(from: int, rows: Array) -> void:
	if state == null or state.finished or from < 0:
		return
	# Черновик чужого хода имеет смысл только пока этот игрок и ходит:
	# иначе гонка с game.state показала бы чужую раскладку поверх нашей.
	if state.current != from:
		return
	_draft_at_ms = Time.get_ticks_msec()
	if JSON.stringify(rows) == JSON.stringify(_draft_rows):
		# Повтор висящего черновика (автор шлёт его каждые 3 с, пока
		# думает): стол тот же, перерисовка дёргала бы его и скролл.
		return
	_draft_from = from
	_draft_rows = rows
	_draft_new_ids = _draft_new_of(rows)
	# Живая постановка видна сразу прилётом: новые фишки черновика,
	# которых ещё не было на экране, прилетают сверху.
	_anim_pending = true
	refresh()


## Новые фишки черновика: все присланные, которых нет в серверной базе.
## Отдельной функцией — тот же пересчёт вызывается при каждом промежуточном
## game.state, пока ход автора не кончился.
func _draft_new_of(rows: Array) -> Dictionary:
	var base := {}
	for row in state.table:
		var r := row as GameState.Row
		if r != null:
			for t in r.tiles:
				base[(t as Tile).id] = true
	var placed := {}
	for d in rows:
		if not (d is Dictionary):
			continue
		for tid in (d.get("tiles", []) as Array):
			var id := int(tid)
			if id > 0 and not base.has(id):
				placed[id] = true
	return placed


## Гасим черновик. Без перерисовки: нас вызывают и в _apply_state, где
## состояние вот-вот подменится и перерисует вызывающая сторона.
func _clear_draft() -> void:
	_draft_from = -1
	_draft_rows = []
	_draft_new_ids = {}
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
			# Пропавшие фишки улетают туда же, откуда прилетали.
			_anim_pending = true
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
			return _hover_slot_pos(global_pos) >= 0 or _in_hint_zone(global_pos)
		return state.can_place_into(hit["row"])
	elif from == "row":
		var src := state.row_by_id(int(data.get("row_id", -1)))
		if src == null or not state.can_touch_row(src):
			return false
		if hit["row"] == null:
			return _hover_slot_pos(global_pos) >= 0 or _in_hint_zone(global_pos)
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
		_reset_slot_hover()
		_clear_row_slots()
	else:
		var hit := _table_hit(global_pos)
		var target: GameState.Row = hit["row"]
		var index := int(hit["index"])
		if target == null:
			var slot_pos := _hover_slot_pos(global_pos)
			target = state.add_row()
			if slot_pos >= 0:
				state.table.erase(target)
				state.table.insert(clampi(slot_pos, 0, state.table.size()), target)
			index = 0
		if from == "hand":
			state.place_from_hand(tile_id, target.id, index)
		else:
			state.move_tile(int(data.get("row_id", -1)), tile_id, target.id, index)
	# Постановка состоялась — призрак больше не нужен: иначе он пережил
	# бы пересборку на протухшем индексе и показался бы чужим рядом
	# (вживую: «пустой ряд перед самым первым»), а трекинг завис бы.
	_reset_slot_hover()
	_clear_row_slots()
	invalid_row_ids.clear()
	# Локальная постановка/возврат — тоже событие для анимации: refresh
	# снимет позиции до пересборки и проиграет появление/уход карточки.
	_anim_pending = true
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
	# Живой черновик (свои невыложенные ходы и чужие непринятые) —
	# прозрачный: ход ещё можно откатить. Принятый прошлый ход —
	# обычный, только с зелёной рамкой: прозрачность обязана гаснуть
	# в момент коммита, а не висеть весь следующий ход.
	for t in state.turn_placed:
		if (t as Tile).id == tile_id:
			m["draft"] = true
			break
	if _draft_new_ids.has(tile_id):
		m["draft"] = true
	if state.last_turn_tile_ids.has(tile_id):
		m["last"] = true
	if _hint_ids.has(tile_id):
		m["hint"] = true
	# Взятая из колоды — галочка с кружочком, пока фишка в руке взявшего
	# (а не текущего игрока: взятие сразу передаёт ход дальше). Выложил —
	# убралась сама (в руке её уже нет), взял новую — заменилась.
	if not _draw_marks.is_empty() and _drawn_in_hand(tile_id):
		m["drawn"] = true
	return m


## Фишка ещё в руке того, кто её брал.
func _drawn_in_hand(tile_id: int) -> bool:
	if state == null:
		return false
	for seat in _draw_marks:
		if int(_draw_marks[seat]) != tile_id:
			continue
		var i := int(seat)
		if i < 0 or i >= state.players.size():
			return false
		for t in (state.players[i] as GameState.Player).hand:
			if (t as Tile).id == tile_id:
				return true
		return false
	return false

func refresh() -> void:
	if state == null:
		return
	# Локальный стол изменился (перетащили, отменили, чекпоинт) —
	# отдаём соперникам весь стол целиком, чтобы они видели все фишки.
	_maybe_send_draft()
	# Пока летит сегмент презентации, стол не пересобираем: пересборка
	# пересоздаёт виды, твины полёта умирают вместе с ними — и долетающие
	# «садятся» разом (цепочка ботов: коммит второго бота приходит как раз
	# во время полёта первого). Данные уже применены, state актуален:
	# ждём только виды, а флаги анимации остаются на отложенную пересборку.
	if _flight_active:
		_refresh_pending = true
		return
	# Снимаем старые позиции ДО пересборки: _update_table и set_tiles
	# уничтожают текущие view, и после них снимать будет нечего.
	var shots: Array = []
	if _anim_pending:
		shots = _capture_tiles()
	_anim_pending = false
	_drag_view = null
	_set_drag_scroll_locked(false)
	_update_chips()
	_update_table()
	_update_hand()
	_update_buttons()
	_sync_top_bar()
	_update_hint_zone_size()
	# Сироты: в момент их показа видов не было (стол показан из черновика
	# соперника, ряд ещё не собран). Фишка появилась — ставим в очередь
	# своим чередом, а не показываем мгновенно.
	_requeue_orphans()
	# Словарь id→место: по месту группируем сегменты, по ключам — плоский
	# список для немедленного полёта и списка ждущих (там место не нужно).
	var force_map: Dictionary = _anim_force
	_anim_force = {}
	var force: Array = []
	for id in force_map:
		force.append(int(id))
	var stagger := _anim_stagger
	_anim_stagger = false
	var load := _anim_load
	_anim_load = false
	# Ждущие показа снимаем ДО постановки шагов: при свободной очереди
	# сегмент выходит из неё немедленно, и после этого список был бы пуст —
	# немедленный полёт увёл бы карточки минуя очередь. Двойной прилёт
	# (очередь целится в раскладку, повторный — в угол старта, где уже
	# стоят) гасил бы стагger и рвал карточки обратно в угол.
	var waiting: Array = _present_ids()
	# Пошаговый прилёт — в очередь презентаций (там же титры), а не
	# сразу на экран: цепочки ботов иначе рвут друг друга. Сетевой коммит
	# идёт туда же и без stagger (наш ход после чужих шагов и чужого титра
	# летел бы мимо очереди — прилёт накладывался бы на чужой показ);
	# офлайн force не бывает: он заполняется только из состояний сервера.
	# Загрузка стола (первое состояние) — не ход: тем же немедленным путём,
	# что и раньше, иначе вход в текущую партию вешал бы весь стол «шагами»
	# в очередь и держал бы пересборки в отложенных. Выключенная «анимация
	# бота» тоже гасит очередь: всё прилетает сразу, как в одиночной игре.
	if (stagger or (_online and not load)) and not force.is_empty() \
			and state != null and not state.finished \
			and (not _online or Settings.bot_anim):
		_enqueue_steps_grouped(force_map)
		for id in force:
			if not waiting.has(int(id)):
				waiting.append(int(id))
		force = []
	# Гасим всё, что ждёт показа (очередь + сироты + вставшие в эту
	# перерисовку шаги) — безусловно, после пересборки: пересборка
	# воскрешает виды видимыми, а их полёт ещё впереди. Пропущенный здесь
	# случай (перерисовка без метки анимации) и был виден как «встали
	# разом».
	if not waiting.is_empty():
		_hide_force_tiles(waiting)
	if not shots.is_empty() or not force.is_empty():
		# Прилетающие прячем сразу: иначе они стоят видимыми, а к началу
		# полёта прыгают в угол и летят — со стороны «поставились,
		# убрались, полетели». Полёты вернут прозрачность сами; game over
		# при обрыве нет — следующая пересборка строит виды заново.
		if not force.is_empty():
			_hide_force_tiles(force)
		_anim_gen += 1
		# skip — все ждущие показа, а не только вставшие в эту перерисовку:
		# прошлые шаги в очереди ещё не показаны, и немедленный полёт увёл
		# бы их минуя очередь (erase из снимка их не убирает — новых в
		# снимке и так нет).
		_play_place_anim(shots, force, _anim_gen, waiting)


## Все id, которых показ ещё ждёт: очередь шагов и сироты.
func _present_ids() -> Array:
	var out: Array = []
	for o in _present_orphans:
		var oid := int((o as Dictionary).get("id", -1))
		if oid >= 0 and not out.has(oid):
			out.append(oid)
	for seg in _present_queue:
		if String((seg as Dictionary).get("kind", "")) != "steps":
			continue
		for id in ((seg as Dictionary).get("ids", []) as Array):
			if not out.has(int(id)):
				out.append(int(id))
	return out


## Есть ли этот id уже среди сирот (словари {id, seat}).
func _orphan_has(iid: int) -> bool:
	for o in _present_orphans:
		if int((o as Dictionary).get("id", -1)) == iid:
			return true
	return false


## Фишки-сироты появились на экране — показываем их теперь, своими
## чередами и от тех же мест, чьи шаги их породили.
func _requeue_orphans() -> void:
	if _present_orphans.is_empty():
		return
	var live := {}
	_collect_live(live)
	var found: Array = []
	var keep: Array = []
	for o in _present_orphans:
		if live.has(int((o as Dictionary).get("id", -1))):
			found.append(o)
		else:
			keep.append(o)
	if found.is_empty():
		return
	_present_orphans = keep
	var order: Array = []
	var groups := {}
	for o in found:
		var seat := int((o as Dictionary).get("seat", -1))
		if not groups.has(seat):
			groups[seat] = []
			order.append(seat)
		(groups[seat] as Array).append(int((o as Dictionary).get("id", -1)))
	for seat in order:
		_enqueue_steps(groups[seat], seat)


## Отложенная пересборка/титр — после конца полёта. Если следующий сегмент
## уже успел выйти, флаги остаются на его конце: иначе перерисовка, заказанная
## посреди полёта, пропала бы бесследно (стол навсегда остался бы старым).
func _after_present() -> void:
	if _flight_active:
		return
	if not _refresh_pending and not _title_pending:
		return
	var need_refresh := _refresh_pending
	var need_title := _title_pending
	var tseat := _pending_title_seat
	_refresh_pending = false
	_title_pending = false
	_pending_title_seat = -1
	# Шаги — первыми: отложенный титр относится к тому же коммиту, что и
	# отложенная пересборка (последний заказ титра всегда от последнего
	# состояния), а титр в очереди идёт ПОСЛЕ чужих шагов: «Ход: Кэрол»
	# надо показать после фишек предыдущего бота, а не перед ними.
	if need_refresh:
		refresh()
	if need_title:
		_append_turn_title(tseat)
	# Титр текущего хода — после шагов, что только что встали.
	_enqueue_turn_title()


## Шаги в очередь: дубли номеров ни к чему (повторные рассылки несут
## те же фишки), порядок — как пришли. seat — чьи это фишки: подсветка
## сверху следует за показываемым местом, а не за state.current.
func _enqueue_steps(ids: Array, seat: int = -1) -> void:
	var fresh: Array = []
	for id in ids:
		var iid := int(id)
		if not fresh.has(iid):
			fresh.append(iid)
	if fresh.is_empty():
		return
	_present_queue.append({"kind": "steps", "ids": fresh, "seat": seat})
	_steps_since_title = true
	_pump_present()


## Словарь id→место раскладываем по сегментам: свои фишки — своим
## игрокам, в порядке появления id. Два коммита, пришедшие за один
## полёт, летят раздельно — и подсветка честно переходит между ними.
func _enqueue_steps_grouped(id_seats: Dictionary) -> void:
	var order: Array = []
	var groups := {}
	for id in id_seats:
		var seat := int(id_seats[id])
		if not groups.has(seat):
			groups[seat] = []
			order.append(seat)
		(groups[seat] as Array).append(int(id))
	for seat in order:
		_enqueue_steps(groups[seat], seat)


## Крутит очередь презентаций: титр — шаги — титр — шаги. Данные уже
## применены (стол актуален), здесь только показ. Перекрытий нет по
## построению: следующий сегмент начинается после предыдущего.
func _pump_present() -> void:
	if _present_busy:
		return
	_present_busy = true
	var gen := _present_gen
	var tree := get_tree()
	while not _present_queue.is_empty() and gen == _present_gen:
		if tree == null:
			break
		var seg: Dictionary = _present_queue.pop_front()
		if String(seg.get("kind", "")) == "title":
			# Протухший титр (ход уже ушёл далеко дальше) молча пропускаем —
			# врать про «Ход: Бот», когда ходит другой, нельзя.
			var seat := int(seg.get("seat", -1))
			if _title_fresh(seat):
				# Показать его — и обвести подсветкой на нём же: титр и
				# чип обязаны говорить об одном игроке.
				if seat >= 0:
					_show_seat(seat)
				_flash_turn_title(String(seg.get("text", "")))
				await tree.create_timer(1.45).timeout
		else:
			var sseat := int(seg.get("seat", -1))
			# Пока летят эти фишки — обводим их автора: state.current уже
			# следующий, и по состоянию чипы перескочили бы на него
			# посреди чужого показа.
			if sseat >= 0:
				_show_seat(sseat)
			_flight_active = true
			await _play_queued_steps(seg.get("ids", []), tree, gen, sseat)
			_flight_active = false
			# Пересборка/титр, заказанные посреди полёта, применяем сейчас:
			# тут же — до того, как цикл успеет взять следующий сегмент.
			_after_present()
	# gen сменился (новый матч/сброс) — чужую очередь не трогаем: там уже
	# крутится новый показ, а наш clear() и сброс busy стёрли бы его.
	if gen == _present_gen:
		_present_queue.clear()
		_present_busy = false
		# Показ кончился — подсветка возвращается на state.current.
		_show_seat(-1)
	if _refresh_pending or _title_pending:
		call_deferred("_after_present")


## Подсветка сверху: чей ход мы ПОКАЗЫВАЕМ сейчас (автор летящих шагов
## или титра), а не чей он по серверу. Очередь пуста — текущий по
## состоянию. Вызывается при каждом смене показываемого места: чипы
## перерисовываются сразу, иначе рамка ехала бы только со следующим
## refresh.
func _show_seat(seat: int) -> void:
	if _shown_seat == seat:
		return
	_shown_seat = seat
	_update_chips()


## Место для подсветки чипов: показываемое, если очередь показа занята,
## иначе текущее по состоянию.
func _highlight_seat() -> int:
	if _shown_seat >= 0:
		return _shown_seat
	if state == null:
		return -1
	return state.current


## Пошаговый прилёт из очереди: ищем живые виды по id (пересборки могли
## их пересоздать), прячем и летим друг за другом, как локальный бот.
## seat — место автора сегмента: пропавшие виды запоминаем вместе с ним,
## чтобы их пересборка встала в очередь «от того же игрока».
func _play_queued_steps(ids: Array, tree: SceneTree, gen: int,
		seat: int = -1) -> void:
	if tree == null or gen != _present_gen:
		return
	var cur := {}
	_collect_live(cur)
	var views := []
	for id in ids:
		var tv := cur.get(int(id)) as TileView
		if tv != null:
			tv.modulate.a = 0.0
			views.append(tv)
		elif not _orphan_has(int(id)):
			# Вида нет (стол показан из черновика соперника, ряд ещё не
			# собран) — показ не состоялся. Запоминаем: фишка вернётся на
			# экран — покажем её своим чередом, а не считаем посаженной.
			_present_orphans.append({"id": int(id), "seat": seat})
	if views.is_empty():
		return
	# Пересборка только что пересоздала RowBlock'и: их FlowTiles ширины
	# ещё не получил, все view лежат в (0,0) — целевой точкой полёта было
	# бы начало ряда, и карточки слепились бы там (видимо: сначала встали
	# по местам, потом поэтапно улетели влево). Ждём layout, как в
	# _play_place_anim; спрятаны заранее — вспышки в (0,0) не будет.
	for i in range(3):
		if _views_laid_out(views):
			break
		await tree.process_frame
	if gen != _present_gen:
		return
	var step := 0
	for tv in views:
		if gen != _present_gen:
			return
		if is_instance_valid(tv):
			_fly_in_tile(tv, step, 0.45, 2.0)
			step += 1
	await tree.create_timer(minf(float(maxi(views.size() - 1, 0)) * 0.45, 2.0) + 0.8).timeout

## Все карточки уже разложены своими рядами? Свежий ряд ширины ещё не
## получил (см. FlowTiles.is_laid_out) — до этого целиться нельзя.
func _views_laid_out(views: Array) -> bool:
	for v in views:
		if not is_instance_valid(v):
			continue
		var p := (v as Control).get_parent()
		if p is FlowTiles and not (p as FlowTiles).is_laid_out():
			return false
	return true

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
			out.append({
				"id": tv.tile.id,
				"tile": tv.tile,
				"gpos": tv.global_position,
				"alpha": tv.base_alpha,
			})

## Гасит указанные id в живых view: прилетающие, ждущие показа в очереди
## и сироты. После пересборки виды возвращаются видимыми — им пора быть
## невидимыми до своего полёта.
func _hide_force_tiles(force: Array) -> void:
	var cur := {}
	_collect_live(cur)
	for id in force:
		var tv := cur.get(int(id)) as TileView
		if tv != null:
			tv.modulate.a = 0.0

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

## Id фишек, впервые попавших в серверный стол с этим состоянием.
## Свои невыложенные ходы сюда не попадают: они уже лежат в старом
## столе локально. Именно эти id «прилетают» при коммите — даже если
## черновик уже показывал их прозрачными.
func _fresh_committed_ids(view: Dictionary) -> Array:
	var out: Array = []
	if state == null:
		return out
	var old := {}
	for row in state.table:
		var r := row as GameState.Row
		if r != null:
			for t in r.tiles:
				old[(t as Tile).id] = true
	for raw in view.get("table", []):
		if not (raw is Dictionary):
			continue
		for tid in ((raw as Dictionary).get("tileIds", []) as Array):
			var id := int(tid)
			if id > 0 and not old.has(id) and not out.has(id):
				out.append(id)
	return out


## Слушает раскладку кадр — только тогда у свежесобранных контейнеров
## есть координаты. Пустой снимок (вход в сцену) ничего не анимирует.
## Прилёты здесь всегда быстрые (почти разом): пошаговые идут очередью
## презентаций (_pump_present) после своего титра, а не здесь. Id из
## skip не трогаем вообще (ни полёт, ни слайд) — их полёт впереди.
func _play_place_anim(shots: Array, force: Array = [],
		gen: int = -1, skip: Array = []) -> void:
	# Рассылка могла застать сцену уже за бортом (смена сцены ещё/уже
	# едет): вне дерева ждать кадр не на чем — просто не анимируем.
	if not is_inside_tree():
		return
	await get_tree().process_frame
	if gen >= 0 and gen != _anim_gen:
		return
	if not is_inside_tree() or (shots.is_empty() and force.is_empty()):
		return
	var prev := {}
	for s in shots:
		prev[int(s["id"])] = s
	var cur := {}
	_collect_live(cur)
	if shots.is_empty():
		# Снимать было нечего, но коммит требует прилёта: новыми
		# считаем только форсированные id, остальные — «уже лежали».
		for id in cur.keys():
			if not force.has(int(id)):
				var tv := cur[id] as TileView
				prev[int(id)] = {
					"tile": tv.tile,
					"gpos": tv.global_position,
					"alpha": tv.base_alpha,
				}
	for id in force:
		prev.erase(int(id))
	# Здесь только быстрые прилёты (почти разом, лишь бы не в один кадр).
	var step := 0
	for id in cur.keys():
		if skip.has(id):
			continue
		var tv: TileView = cur[id]
		if prev.has(id):
			var gpos: Vector2 = prev[id]["gpos"]
			prev.erase(id)
			if gpos.distance_to(tv.global_position) > 2.0:
				_slide_tile(tv, gpos)
		else:
			_fly_in_tile(tv, step, 0.05, 0.4)
			step += 1
	# Остались только ушедшие фишки.
	for id in prev.keys():
		var s: Dictionary = prev[id]
		_fly_out_tile(s["tile"], s["gpos"], float(s.get("alpha", 1.0)))

## Верхний правый угол экрана — общая точка появления/ухода карточек.
func _corner_spawn_global() -> Vector2:
	var vp := get_viewport().get_visible_rect()
	var ts := Settings.tile_size()
	return Vector2(vp.end.x - ts.x * 1.2, vp.position.y - ts.y * 1.5)


## Новая фишка: прилетает из верхнего правого угла в свой слот.
func _fly_in_tile(tv: TileView, step: int, gap: float = 0.05, cap: float = 0.4) -> void:
	var parent := tv.get_parent()
	if parent == null:
		return
	var final_local := tv.position
	# Целимся в alpha по меткам, а не в текущий modulate: его уже мог
	# обнулить соседний прилёт той же фишки — тогда твин 0→0 гасил бы
	# её навсегда.
	var final_alpha := tv.base_alpha
	var start_global := _corner_spawn_global()
	tv.position = parent.get_global_transform().affine_inverse() * start_global
	tv.pivot_offset = tv.size * 0.5
	tv.scale = Vector2(0.45, 0.45)
	tv.modulate.a = 0.0
	var delay := minf(step * gap, cap)
	var tw := create_tween()
	tw.bind_node(tv)
	tw.set_parallel(true)
	tw.tween_property(tv, "position", final_local, 0.38) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT).set_delay(delay)
	tw.tween_property(tv, "modulate:a", final_alpha, 0.28) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT).set_delay(delay)
	tw.tween_property(tv, "scale", Vector2.ONE, 0.32) \
		.set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT).set_delay(delay)
	# Раскладка — истина в последней инстанции: пока карточка летела, ряд
	# мог пересчитаться (ширина ряда меняется от полосы прокрутки), и цель
	# полёта устарела бы — карточка осталась бы мимо своего места.
	tw.finished.connect(_rest_layout.bind(tv))

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
	tw.finished.connect(_rest_layout.bind(tv))

## Переезд/полёт кончились — возвращаем карточку в раскладку ряда: если за
## время анимации ряд пересчитался (другая ширина — от полосы
## прокрутки), цель устарела, и карточка осталась бы стоять мимо своего
## места. Пока тянем карточку — не трогаем: раскладка увела бы её из руки.
func _rest_layout(tv: TileView) -> void:
	if not is_instance_valid(tv) or _drag_view != null:
		return
	var p := tv.get_parent()
	if p is FlowTiles:
		(p as FlowTiles).force_relayout()

## Ушедшая фишка: призрак улетает в верхний правый угол и уменьшается —
## под ней уже пусто.
func _fly_out_tile(tile: Tile, gpos: Vector2, alpha: float = 1.0) -> void:
	var ghost := TileView.make(tile, false, null, false)
	add_child(ghost)
	ghost.top_level = true
	ghost.position = gpos
	ghost.modulate.a = clampf(alpha, 0.0, 1.0)
	ghost.pivot_offset = ghost.size * 0.5
	ghost.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var tw := create_tween()
	tw.bind_node(ghost)
	tw.set_parallel(true)
	tw.tween_property(ghost, "position", _corner_spawn_global(), 0.42) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_IN)
	tw.tween_property(ghost, "modulate:a", 0.0, 0.38) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_IN)
	tw.tween_property(ghost, "scale", Vector2(0.25, 0.25), 0.42) \
		.set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_IN)
	tw.tween_callback(_on_ghost_done.bind(ghost))

func _on_ghost_done(ghost: Control) -> void:
	if is_instance_valid(ghost):
		ghost.queue_free()

func _update_chips() -> void:
	for child in chips_box.get_children():
		chips_box.remove_child(child)
		child.free()
	# Обводим ПОКАЗЫВАЕМОЕ место (очередь презентаций), а не сырое
	# state.current: сервер уже передал ход дальше, пока долетают фишки
	# прошлого игрока, и по состоянию чип перескочил бы на следующего
	# посреди чужого показа — для зрителя это и есть «обвели не того».
	var shown := _highlight_seat()
	for i in state.player_count():
		var chip := PanelContainer.new()
		var sb := StyleBoxFlat.new()
		var is_now := i == shown
		# Наш ход (только сетевая партия: offline local_seat = -1) —
		# свой цвет, толстая рамка и пульс: «мы ходим» должно читаться
		# сразу, не только по рамке среди чужих подсветок.
		var mine := is_now and not state.finished and i == state.local_seat
		sb.bg_color = Color(0.16, 0.55, 0.32, 0.55) if mine \
			else (Color(0.24, 0.45, 0.85, 0.4) if is_now \
			else Color(1, 1, 1, 0.07))
		sb.set_corner_radius_all(8)
		sb.border_color = Color(0.5, 0.95, 0.6, 0.95) if mine \
			else (Color(0.56, 0.73, 0.98, 0.9) if is_now \
			else Color(1, 1, 1, 0.12))
		sb.set_border_width_all(3 if mine else (2 if is_now else 1))
		sb.content_margin_left = 8.0
		sb.content_margin_right = 8.0
		sb.content_margin_top = 4.0
		sb.content_margin_bottom = 4.0
		chip.add_theme_stylebox_override("panel", sb)
		chip.mouse_filter = Control.MOUSE_FILTER_PASS
		var lab := Label.new()
		lab.text = Lang.t("%s · %d") % [state.player_name(i), state.hand_size(i)]
		# В сетевой игре показываем и наше место, и «мы тут» — иначе
		# непонятно, чьи фишки лежат внизу. Отвалившегося помечаем
		# отдельно: его место держится, но ходить он не может.
		if _online and i == state.local_seat:
			lab.text += Lang.t(" · вы")
		# Серверные боты добирают места в сетевой партии — их показываем
		# явно, чтобы игрок понимал, почему «не у того» ход и кто вообще
		# за столом. Офлайн-ботов одиночной игры не трогаем.
		if _online and state.is_bot_player(i):
			lab.text += Lang.t(" · бот")
		# Слово рядом с подсветкой: по одному цвету рамки в сетевой партии
		# не понять, чья очередь. Своему ходу — «ваш ход» (и оно же
		# объясняет, почему чип зелёный и пульсирует).
		if mine:
			lab.text += Lang.t(" · ваш ход")
		elif is_now and not state.finished:
			lab.text += Lang.t(" · ходит")
		# Кто последним брал из колоды: своё взятие видно галочкой с
		# кружочком на фишке, а чужое (бот или соперник) — только здесь.
		if i == _drew_seat:
			lab.text += Lang.t(" · взял")
		if _online and not state.is_connected_player(i):
			lab.text += Lang.t(" · нет связи")
		lab.add_theme_font_size_override("font_size", Settings.fs(16))
		lab.add_theme_color_override("font_color", Color(0.82, 1, 0.88) \
			if mine else (Color(1, 1, 1, 0.95) if is_now else Color(1, 1, 1, 0.6)))
		chip.add_child(lab)
		chips_box.add_child(chip)
		if mine:
			# Пульс фона: наш ход обязан выделяться в движении, а не только
			# цветом. Твин привязан к чипу — вместе с ним и умрёт при
			# следующей перерисовке, утечек нет.
			var tw := chip.create_tween().set_loops()
			tw.tween_property(sb, "bg_color:a", 0.3, 0.7)
			tw.tween_property(sb, "bg_color:a", 0.62, 0.7)

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
	deck_button.text = Lang.t("Колода\n%d") % state.tiles_left_in_deck()
	var placed := not state.turn_placed.is_empty()
	# В сетевой игре вместо бота — «не наш ход» и «ждём сервер». Разница
	# видна только в подписях, а вот в кнопках она не нужна.
	var busy := _bot_active or _is_bot_turn() or (_online and not state.my_turn())
	var locked := state.finished or busy or (_online and _sending)
	deck_button.disabled = locked or not state.can_draw()
	undo_button.disabled = locked or not state.turn_dirty
	cp_save_btn.disabled = locked or not state.turn_dirty
	cp_restore_btn.disabled = locked or state.checkpoint_count() == 0
	# Подсказка — одна на игрока за партию: потраченную гасим сразу,
	# но только для того места, которое её потратило.
	hint_btn.disabled = locked or _is_hint_used() or _hint_ad_pending
	if state.finished:
		end_button.text = Lang.t("Игра окончена")
		end_button.disabled = true
	elif _online and _sending:
		end_button.text = Lang.t("Ждём…")
		end_button.disabled = true
	elif placed:
		end_button.text = Lang.t("Продолжить")
		end_button.disabled = locked
	elif state.tiles_left_in_deck() > 0:
		end_button.text = Lang.t("Взять")
		end_button.disabled = locked or not state.can_draw()
	else:
		end_button.text = Lang.t("Пропуск хода")
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
	var target := maxf(HINT_MIN_H, floorf(table_scroll.size.y - rows_h))
	# Мёртвая зона в пиксель: кадры пересборки дают промежуточные размеры,
	# и без неё минимум дёргался на доли пикселя каждый кадр — вместе с
	# ним мигал и скролл.
	if absf(hint_zone.custom_minimum_size.y - target) >= 1.0:
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
			# же событием движения, в GUI). Но когда фишки двигать нельзя
			# (чужой ход), касание по карточке стола — тоже листание: жест
			# иначе умирал бы кликом в никуда. Карточки руки жест держат
			# всегда — иначе волочение по руке листало бы стол под ней.
			_pan_press_on_tile = _point_on_hand_tile(_pan_pos) \
				or (_point_on_table_tile(_pan_pos) and _can_act())
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

## Листать можно в любом месте стола, кроме двигаемых карточек: с карточки
## жест принадлежит перетаскиванию. Карточки чужого хода инертны — палец
## на них листает стол, как с фона.
func _can_pan_table(p: Vector2) -> bool:
	if _drag_view != null:
		return false
	if table_scroll == null or not table_scroll.is_visible_in_tree():
		return false
	if _modal_open():
		return false
	if not table_scroll.get_global_rect().has_point(p):
		return false
	if _can_act():
		for block in row_blocks:
			var row := block as RowBlock
			if row == null or row.flow == null or not row.is_visible_in_tree():
				continue
			for view in row.flow.tile_views:
				var tile_view := view as TileView
				if tile_view != null and tile_view.get_global_rect().has_point(p):
					return false
	return true

## Точка над карточкой ряда. Жест с неё принадлежит перетаскиванию,
## только пока фишки можно двигать (см. _can_act в вызывающих).
func _point_on_table_tile(p: Vector2) -> bool:
	for block in row_blocks:
		var row := block as RowBlock
		if row == null or row.flow == null or not row.is_visible_in_tree():
			continue
		for view in row.flow.tile_views:
			var t := view as TileView
			if t != null and t.get_global_rect().has_point(p):
				return true
	return false


## Точка над карточкой руки. Жест принадлежит руке всегда: даже когда
## фишки инертны, иначе волочение по руке листало бы стол под ней.
func _point_on_hand_tile(p: Vector2) -> bool:
	if hand_flow == null:
		return false
	for view in hand_flow.tile_views:
		var t := view as TileView
		if t != null and t.get_global_rect().has_point(p):
			return true
	return false

## Модальные экраны лежат поверх стола: жест по ним партию листать не должен.
func _modal_open() -> bool:
	if _confirm_overlay != null and _confirm_overlay.visible:
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
	# Перевод в точке показа: сюда стекаются и строки клиента, и ответы
	# сервера (через Net.notice) — сервер всегда шлёт русский, словарь
	# его накрывает, чего нет в словаре — показывается как пришло.
	toast_label.text = Lang.t(text)
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
	return Lang.card_word(count)
