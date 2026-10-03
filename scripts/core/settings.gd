extends Node

const CFG_PATH := "user://settings.cfg"
const MIN_PLAYERS := 2
const MAX_PLAYERS := 5

## Лестница масштабов: средний — ровно прежний (×1.0, вёрстка под
## него родная), гигантский — ×2, чтобы весь текст был заметно крупным.
## Потолоков у текста нет, зато есть пол FS_MIN: на «Маленьком»
## мелкие базы не опускаются ниже читаемого минимума.
const TEXT_SCALES := [0.85, 1.0, 1.3, 2.0]
const TEXT_SCALE_NAMES := ["Маленький", "Средний", "Большой", "Гигантский"]
const FS_MIN := 12
const TILE_WIDTHS := [32, 40, 48, 60, 66, 72]
const TILE_SIZE_NAMES := ["Крошечный", "Маленький", "Средний", "Крупный", "Большой", "Максимум"]
const BOT_LEVEL_NAMES := ["Лёгкий", "Средний", "Сложный", "Невозможный"]

var player_count: int = MIN_PLAYERS
var player_names: PackedStringArray = PackedStringArray()
var require_30: bool = true
var text_scale: int = 2
var tile_step: int = 5
var bot_level: int = 1
var bot_anim: bool = true
var player_is_bot: Array = []
var stat_games: int = 0
var stat_wins: int = 0
var stat_losses: int = 0

func _ready() -> void:
	load_settings()
	if OS.get_name() == "Android":
		DisplayServer.screen_set_orientation(DisplayServer.SCREEN_SENSOR)

## Размер шрифта: база × шкала, но не ниже читаемого минимума —
## на «Маленьком» fs(12)/fs(13) не превращаются в крошку.
func fs(base: int) -> int:
	var idx := clampi(text_scale, 0, TEXT_SCALES.size() - 1)
	return maxi(FS_MIN, int(round(base * TEXT_SCALES[idx])))

## Размер интерактивного контроля (кнопки, поля ввода, переключатели).
## Растёт вместе с выбранным размером текста, чтобы пальцем было легко:
## большой шрифт бессмыслен, если кнопки по нему остались крошечными.
## Пола нет — это не текст, а размеры вроде отступов (touch(2)).
func touch(base: int) -> int:
	var idx := clampi(text_scale, 0, TEXT_SCALES.size() - 1)
	return maxi(1, int(round(base * TEXT_SCALES[idx])))

## Ширина контрола с потолком по ширине окна. Текстовая шкала растит
## ширины так же, как шрифт, а пары кнопок («Заново» + «В меню») и
## ряды лобби на гигантском так не влезают в 576 — ширина держим в
## 44% окна: две таких кнопки с зазором всегда уместятся.
func touch_w(base: int) -> int:
	var w := touch(base)
	var vw := 576.0
	var vp := get_viewport()
	if vp != null:
		vw = vp.get_visible_rect().size.x
	return mini(w, int(vw * 0.44))


## Оформляет OptionButton И его выпадающий список. Шрифт в свёрнутой
## кнопке уже рос, а пункты списка оставались дефолтно-крошечными:
## Данные по «размеру карточек» пальцем было не попасть. Делаем и списку
## крупный шрифт, и высокие строки — высота строки от размера текста.
func style_option(option: OptionButton, font_base: int) -> void:
	option.add_theme_font_size_override("font_size", fs(font_base))
	var popup := option.get_popup()
	if popup == null:
		return
	popup.add_theme_font_size_override("font_size", fs(font_base + 1))
	popup.add_theme_constant_override("item_height", touch(46))
	popup.add_theme_constant_override("v_separation", touch(2))
	# Повторный клик по открытой кнопке закрывает список: тот же клик,
	# что и открывал. Перехват — в gui_input: он идёт раньше нативной
	# обработки кнопки, поэтому успеваем съесть нажатие до того, как
	# движок решит показать список заново.
	#
	# Два пути одного и того же клика (проверено чтением исходников
	# движка и пробами с живыми событиями):
	# 1) список ещё открыт, когда нажатие доходит до кнопки: прячем
	#    его сами и глотаем нажатие — нативный pressed() не стреляет;
	# 2) окно списка уже закрыло его этим же нажатием (клик мимо
	#    панели гасится без set_input_as_handled и доходит до кнопки):
	#    тогда нативный pressed() увидел бы «закрыто» и открыл список
	#    заново — «дёргается и возвращается». Такое нажатие тоже
	#    глотаем, узнаём его по свежей метке о закрытии.
	if not option.has_meta("toggle_close"):
		option.set_meta("toggle_close", true)
		option.set_meta("popup_hidden_at", 0)
		option.set_meta("popup_hide_select", false)
		option.gui_input.connect(_snap_option_gui.bind(option))
		popup.popup_hide.connect(_note_option_hide.bind(option))
		popup.index_pressed.connect(_note_option_select.bind(option))


## Нажатие по кнопке раньше движка: открытый список прячем сами,
## «воскрешающее» нажатие (список только что закрылся сам) глотаем.
func _snap_option_gui(event: InputEvent, option: OptionButton) -> void:
	if option == null or not is_instance_valid(option):
		return
	var down := false
	if event is InputEventMouseButton:
		var mb := event as InputEventMouseButton
		down = mb.pressed and mb.button_index == MOUSE_BUTTON_LEFT
	elif event is InputEventScreenTouch:
		down = (event as InputEventScreenTouch).pressed
	if not down:
		return
	var popup := option.get_popup()
	if popup == null:
		return
	if popup.visible:
		option.set_meta("popup_hidden_at", 0)
		option.set_meta("popup_hide_select", false)
		popup.hide()
		option.accept_event()
		return
	var hidden_at := int(option.get_meta("popup_hidden_at", 0))
	var by_select := bool(option.get_meta("popup_hide_select", false))
	option.set_meta("popup_hidden_at", 0)
	option.set_meta("popup_hide_select", false)
	if not by_select and hidden_at > 0 \
			and Time.get_ticks_msec() - hidden_at < 300:
		option.accept_event()


func _note_option_hide(option: OptionButton) -> void:
	if option == null or not is_instance_valid(option):
		return
	option.set_meta("popup_hidden_at", Time.get_ticks_msec())


func _note_option_select(_index: int, option: OptionButton) -> void:
	if option == null or not is_instance_valid(option):
		return
	option.set_meta("popup_hide_select", true)

func tile_size() -> Vector2:
	var idx := clampi(tile_step, 0, TILE_WIDTHS.size() - 1)
	var w := float(TILE_WIDTHS[idx])
	if idx == 0:
		return Vector2(w, w)
	return Vector2(w, w * 1.4)

func is_bot(index: int) -> bool:
	if index < 0 or index >= player_is_bot.size():
		return false
	return bool(player_is_bot[index])

func set_bot(index: int, value: bool) -> void:
	_ensure_bots()
	if index >= 0 and index < player_is_bot.size():
		player_is_bot[index] = value

func set_player_count(n: int) -> void:
	player_count = clampi(n, MIN_PLAYERS, MAX_PLAYERS)
	_ensure_names()
	_ensure_bots()

func set_player_name(index: int, value: String) -> void:
	_ensure_names()
	if index >= 0 and index < player_names.size():
		var cleaned := value.strip_edges()
		if cleaned.is_empty():
			cleaned = "Игрок %d" % (index + 1)
		player_names[index] = cleaned

func _ensure_names() -> void:
	while player_names.size() < player_count:
		player_names.append("Игрок %d" % (player_names.size() + 1))
	while player_names.size() > player_count:
		player_names.remove_at(player_names.size() - 1)

func _ensure_bots() -> void:
	while player_is_bot.size() < player_count:
		player_is_bot.append(false)
	while player_is_bot.size() > player_count:
		player_is_bot.remove_at(player_is_bot.size() - 1)

func load_settings() -> void:
	var cf := ConfigFile.new()
	if cf.load(CFG_PATH) == OK:
		player_count = clampi(int(cf.get_value("game", "player_count", MIN_PLAYERS)), MIN_PLAYERS, MAX_PLAYERS)
		require_30 = bool(cf.get_value("game", "require_30", true))
		text_scale = clampi(int(cf.get_value("game", "text_scale", 2)), 0, TEXT_SCALES.size() - 1)
		tile_step = clampi(int(cf.get_value("game", "tile_step", 5)), 0, TILE_WIDTHS.size() - 1)
		bot_level = clampi(int(cf.get_value("game", "bot_level", 1)), 0, BOT_LEVEL_NAMES.size() - 1)
		bot_anim = bool(cf.get_value("game", "bot_anim", true))
		stat_games = maxi(0, int(cf.get_value("game", "stat_games", 0)))
		stat_wins = maxi(0, int(cf.get_value("game", "stat_wins", 0)))
		stat_losses = maxi(0, int(cf.get_value("game", "stat_losses", 0)))
		var stored = cf.get_value("game", "player_names", PackedStringArray())
		if stored is PackedStringArray:
			player_names = stored
		var bots = cf.get_value("game", "player_is_bot", Array())
		if bots is Array:
			player_is_bot = bots
	_ensure_names()
	_ensure_bots()

func save_settings() -> void:
	_ensure_names()
	_ensure_bots()
	var cf := ConfigFile.new()
	cf.set_value("game", "player_count", player_count)
	cf.set_value("game", "require_30", require_30)
	cf.set_value("game", "player_names", player_names)
	cf.set_value("game", "text_scale", text_scale)
	cf.set_value("game", "tile_step", tile_step)
	cf.set_value("game", "bot_level", bot_level)
	cf.set_value("game", "bot_anim", bot_anim)
	cf.set_value("game", "player_is_bot", player_is_bot)
	cf.set_value("game", "stat_games", stat_games)
	cf.set_value("game", "stat_wins", stat_wins)
	cf.set_value("game", "stat_losses", stat_losses)
	cf.save(CFG_PATH)


## Учёт завершённой партии для экрана «Статистика». Один вызов на
## партию — гарант на стороне сцены игры; сохраняем сразу, в меню
## заходить для этого не нужно.
func record_game(won: bool, lost: bool) -> void:
	stat_games += 1
	if won:
		stat_wins += 1
	if lost:
		stat_losses += 1
	save_settings()
