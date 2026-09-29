extends Node

const CFG_PATH := "user://settings.cfg"
const MIN_PLAYERS := 2
const MAX_PLAYERS := 5

const TEXT_SCALES := [0.85, 1.0, 1.2, 1.45]
const TEXT_SCALE_NAMES := ["Маленький", "Средний", "Большой", "Гигантский"]
const TILE_WIDTHS := [32, 40, 48, 60, 66, 72]
const TILE_SIZE_NAMES := ["Крошечный", "Маленький", "Средний", "Крупный", "Большой", "Максимум"]
const BOT_LEVEL_NAMES := ["Лёгкий", "Средний", "Сложный", "Невозможный"]

var player_count: int = MIN_PLAYERS
var player_names: PackedStringArray = PackedStringArray()
var require_30: bool = true
var text_scale: int = 2
var tile_step: int = 5
var bot_level: int = 1
var player_is_bot: Array = []

func _ready() -> void:
	load_settings()
	if OS.get_name() == "Android":
		DisplayServer.screen_set_orientation(DisplayServer.SCREEN_SENSOR)

func fs(base: int) -> int:
	var idx := clampi(text_scale, 0, TEXT_SCALES.size() - 1)
	return maxi(1, int(round(base * TEXT_SCALES[idx])))

## Размер интерактивного контроля (кнопки, поля ввода, переключатели).
## Растёт вместе с выбранным размером текста, чтобы пальцем было легко:
## большой шрифт бессмыслен, если кнопки по нему остались крошечными.
func touch(base: int) -> int:
	return fs(base)


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
	cf.set_value("game", "player_is_bot", player_is_bot)
	cf.save(CFG_PATH)
